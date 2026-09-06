import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { isAuthorized } from "./auth.js";
import { loadConfig, loadQdrantConfig } from "./config.js";
import type { CompanionConfig } from "./config.js";
import { createLogger } from "./logging/logger.js";
import type { Logger } from "./logging/logger.js";
import { createVaultMcpHandler } from "./mcp/mcpServer.js";
import type { QueryEmbeddingProvider } from "./mcp/queryEmbedding.js";
import { ProtocolError, publicError } from "./protocol/errors.js";
import {
  parseReconciliationPlanRequest,
  parseSyncBatchRequest,
  validateVaultId,
} from "./protocol/schemas.js";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "./protocol/types.js";
import type { ErrorResponse } from "./protocol/types.js";
import type { CompanionStorage } from "./storage/companionStorage.js";
import type { McpReadStorage } from "./storage/mcpReadStorage.js";
import { createMcpReadView } from "./storage/mcpReadStorage.js";
import { SqliteCompanionStorage } from "./storage/sqliteCompanionStorage.js";
import { ReconciliationService } from "./sync/reconciliation.js";

import { QdrantVectorBackend } from "./search/qdrantBackend.js";
import { QdrantClientIndex } from "./search/qdrantIndex.js";
import type { QdrantVectorIndex } from "./search/qdrantIndex.js";

import { createMcpProposalCapability } from "./proposals/storage.js";
import type { ProposalCompletion } from "./proposals/types.js";

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown, logger: Logger): void {
  const normalized = publicError(error);
  if (normalized.status >= 500) {
    logger.error("Request failed.", { code: normalized.code });
  }
  const body: ErrorResponse = {
    error: { code: normalized.code, message: normalized.message },
  };
  sendJson(response, normalized.status, body);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProtocolError(400, "INVALID_REQUEST", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > limit) {
      oversized = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) throw new ProtocolError(413, "REQUEST_TOO_LARGE", "Request body exceeds the configured limit.");
  if (bytes === 0) throw new ProtocolError(400, "MALFORMED_JSON", "A JSON request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ProtocolError(400, "MALFORMED_JSON", "Request body is not valid JSON.");
  }
}

function checkVersion(request: IncomingMessage): void {
  const supplied = request.headers[PROTOCOL_HEADER];
  if (supplied !== String(PROTOCOL_VERSION)) {
    throw new ProtocolError(
      409,
      "PROTOCOL_VERSION_MISMATCH",
      `Companion protocol version ${PROTOCOL_VERSION} is required.`,
    );
  }
}

function methodNotAllowed(): never {
  throw new ProtocolError(405, "METHOD_NOT_ALLOWED", "The HTTP method is not supported for this route.");
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: CompanionConfig,
  storage: CompanionStorage,
  reconciliation: ReconciliationService,
  qdrant: QdrantVectorBackend | undefined,
  handleMcp: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://companion.invalid");
  if (url.pathname === "/health") {
    if (request.method !== "GET") methodNotAllowed();
    sendJson(response, 200, { status: "ok", protocolVersion: PROTOCOL_VERSION });
    return;
  }
  if (url.pathname === "/mcp") {
    if (!config.mcp.enabled) throw new ProtocolError(404, "NOT_FOUND", "Route not found.");
    if (!isAuthorized(request.headers.authorization, config.mcp.token)) {
      throw new ProtocolError(401, "AUTH_REQUIRED", "Valid MCP Bearer authentication is required.");
    }
    await handleMcp(request, response);
    return;
  }
  if (!url.pathname.startsWith("/v1/")) {
    throw new ProtocolError(404, "NOT_FOUND", "Route not found.");
  }
  if (!isAuthorized(request.headers.authorization, config.token)) {
    throw new ProtocolError(401, "AUTH_REQUIRED", "Valid Bearer authentication is required.");
  }
  checkVersion(request);

  if (url.pathname === "/v1/status") {
    if (request.method !== "GET") methodNotAllowed();
    const status = await storage.getServerStatus();
    sendJson(response, 200, { status: "ok", protocolVersion: PROTOCOL_VERSION, vaultCount: status.vaultCount,
      qdrant: qdrant ? await qdrant.status() : { enabled: false, state: "DISABLED" } });
    return;
  }

  const proposalRoute = /^\/v1\/vaults\/([^/]+)\/proposals(?:\/([^/]+)(?:\/(claim|complete|reject))?)?$/u.exec(url.pathname);
  if (proposalRoute?.[1]) {
    const vaultId = validateVaultId(decodeURIComponent(proposalRoute[1]));
    const id = proposalRoute[2] ? decodeURIComponent(proposalRoute[2]) : undefined;
    const action = proposalRoute[3]; const proposals = storage.getProposalStore();
    if (!action) {
      if (request.method !== "GET") methodNotAllowed();
      if ([...url.searchParams.keys()].some((key) => !["cursor", "limit"].includes(key))) throw new ProtocolError(400, "INVALID_REQUEST", "Invalid proposal query.");
      sendJson(response, 200, { protocolVersion: PROTOCOL_VERSION, ...(id ? { proposal: proposals.get(vaultId, id) } :
        proposals.list(vaultId, url.searchParams.get("cursor") ?? "", Number(url.searchParams.get("limit") ?? 20))) });
      return;
    }
    if (request.method !== "POST") methodNotAllowed();
    const body = await readJson(request, 4096);
    if (!body || typeof body !== "object" || Array.isArray(body) || (action !== "complete" && Object.keys(body).length > 0)) {
      throw new ProtocolError(400, "INVALID_REQUEST", "Invalid proposal management request.");
    }
    const result = action === "claim" ? proposals.claim(vaultId, id!) : { proposal: action === "reject"
      ? proposals.reject(vaultId, id!) : proposals.complete(vaultId, id!, body as ProposalCompletion) };
    sendJson(response, 200, { protocolVersion: PROTOCOL_VERSION, ...result });
    return;
  }

  const match = /^\/v1\/vaults\/([^/]+)\/(status|reconcile\/plan|sync\/batch)$/u.exec(url.pathname);
  if (!match?.[1] || !match[2]) throw new ProtocolError(404, "NOT_FOUND", "Route not found.");
  const vaultId = validateVaultId(decodeURIComponent(match[1]));
  const action = match[2];
  if (action === "status") {
    if (request.method !== "GET") methodNotAllowed();
    sendJson(response, 200, await storage.getVaultStatus(vaultId));
    return;
  }
  if (request.method !== "POST") methodNotAllowed();
  const body = await readJson(request, config.bodyLimitBytes);
  if (action === "reconcile/plan") {
    sendJson(response, 200, await reconciliation.plan(vaultId, parseReconciliationPlanRequest(body)));
    return;
  }
  sendJson(response, 200, await reconciliation.apply(vaultId, parseSyncBatchRequest(body)));
}

export function createCompanionServer(
  config: CompanionConfig,
  storage: CompanionStorage & McpReadStorage,
  logger: Logger = createLogger(config.logLevel, [
    config.token,
    config.mcp.token,
    config.mcp.embeddingApiKey,
    config.qdrant?.apiKey ?? "",
  ]),
  queryEmbeddingProvider?: QueryEmbeddingProvider,
  qdrantIndex?: QdrantVectorIndex,
): Server {
  const qdrantConfig = config.qdrant ?? loadQdrantConfig({});
  const qdrant = qdrantConfig.enabled ? new QdrantVectorBackend(storage, config.mcp.vaultId,
    qdrantConfig, qdrantIndex ?? new QdrantClientIndex(qdrantConfig)) : undefined;
  const unsubscribe = qdrant ? storage.subscribeCommits((notice) => qdrant.onCommit(notice)) : undefined;
  const reconciliation = new ReconciliationService(storage);
  const mcpHandler = createVaultMcpHandler(createMcpReadView(storage), config.mcp, logger, queryEmbeddingProvider, qdrant,
    createMcpProposalCapability(storage.getProposalStore(), config.mcp.vaultId));
  const allowedHosts = config.mcp.allowedHosts ?? ["localhost", "127.0.0.1", "[::1]"];
  const checkMcpHost = hostHeaderValidation(allowedHosts);
  const checkMcpOrigin = originValidation(allowedHosts);
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: () => logger.error("MCP HTTP adapter failed."),
  });
  const handleMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!checkMcpHost(request, response) || !checkMcpOrigin(request, response)) return;
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const contentLength = request.headers["content-length"];
    if (
      typeof contentLength === "string" &&
      /^\d+$/u.test(contentLength) &&
      Number(contentLength) > config.mcp.bodyLimitBytes
    ) {
      throw new ProtocolError(413, "REQUEST_TOO_LARGE", "MCP request body exceeds the configured limit.");
    }
    let bytes = 0;
    const body: Buffer[] = [];
    if (request.method !== "GET" && request.method !== "HEAD") {
      for await (const raw of request.iterator({ destroyOnReturn: false })) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        bytes += chunk.byteLength;
        if (bytes > config.mcp.bodyLimitBytes) {
          request.resume();
          throw new ProtocolError(413, "REQUEST_TOO_LARGE", "MCP request body exceeds the configured limit.");
        }
        body.push(chunk);
      }
    }
    const limitedRequest = {
      method: request.method ?? "GET",
      url: request.url ?? "/mcp",
      headers: request.headers,
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield* body;
      },
    };
    await nodeMcpHandler(limitedRequest, response);
  };
  const server = createServer((request, response) => {
    void routeRequest(request, response, config, storage, reconciliation, qdrant, handleMcp).catch((error: unknown) => {
      if (!response.headersSent) sendError(response, error, logger);
      else response.destroy();
    });
  });
  server.once("listening", () => qdrant?.start());
  server.once("close", () => { unsubscribe?.(); qdrant?.close(); void mcpHandler.close(); });
  return server;
}

export async function startCompanion(
  config: CompanionConfig = loadConfig(),
  logger: Logger = createLogger(config.logLevel, [
    config.token,
    config.mcp.token,
    config.mcp.embeddingApiKey,
    config.qdrant?.apiKey ?? "",
  ]),
): Promise<{ server: Server; storage: CompanionStorage }> {
  const storage = new SqliteCompanionStorage(config.dataDir);
  await storage.initialize();
  const server = createCompanionServer(config, storage, logger);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  logger.info("Vault Audit AI Companion started.", {
    host: config.host,
    port: config.port,
    protocolVersion: PROTOCOL_VERSION,
  });
  return { server, storage };
}

async function main(): Promise<void> {
  let started: Awaited<ReturnType<typeof startCompanion>>;
  try {
    started = await startCompanion();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Companion startup failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }
  const shutdown = (): void => {
    started.server.close(() => {
      void started.storage.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) void main();
