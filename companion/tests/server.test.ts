import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionConfig } from "../src/config.js";
import type { Logger } from "../src/logging/logger.js";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "../src/protocol/types.js";
import { createCompanionServer } from "../src/server.js";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { descriptor, note, VAULT_A } from "./fixtures.js";

describe("Companion HTTP API", () => {
  const token = "server-test-super-secret";
  let directory: string;
  let storage: SqliteCompanionStorage;
  let server: Server;
  let baseUrl: string;
  let logger: Logger;
  let logMessages: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vault-companion-http-"));
    storage = new SqliteCompanionStorage(directory);
    await storage.initialize();
    logMessages = [];
    logger = {
      debug: vi.fn((message) => logMessages.push(message)),
      info: vi.fn((message) => logMessages.push(message)),
      warn: vi.fn((message) => logMessages.push(message)),
      error: vi.fn((message, context) => logMessages.push(`${message}${JSON.stringify(context ?? {})}`)),
    };
    const config: CompanionConfig = {
      host: "127.0.0.1",
      port: 27124,
      token,
      dataDir: directory,
      allowRemoteBind: false,
      logLevel: "debug",
      bodyLimitBytes: 4096,
    };
    server = createCompanionServer(config, storage, logger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  function headers(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      "content-type": "application/json",
      ...overrides,
    };
  }

  it("exposes only minimal unauthenticated health data", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({ status: "ok", protocolVersion: 1 });
  });

  it.each([
    ["missing", {}],
    ["invalid", { authorization: "Bearer wrong" }],
  ])("returns 401 for %s authentication", async (_label, supplied) => {
    const response = await fetch(`${baseUrl}/v1/status`, { headers: { [PROTOCOL_HEADER]: "1", ...supplied } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("accepts valid authentication", async () => {
    const response = await fetch(`${baseUrl}/v1/status`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", protocolVersion: 1, vaultCount: 0 });
  });

  it("rejects an incompatible protocol explicitly", async () => {
    const response = await fetch(`${baseUrl}/v1/status`, { headers: headers({ [PROTOCOL_HEADER]: "2" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "PROTOCOL_VERSION_MISMATCH" } });
  });

  it("rejects malformed JSON with a stable code and no stack trace", async () => {
    const response = await fetch(`${baseUrl}/v1/vaults/${VAULT_A}/sync/batch`, {
      method: "POST",
      headers: headers(),
      body: "{bad",
    });
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(400);
    expect(body).toContain("MALFORMED_JSON");
    expect(body).not.toContain(" at ");
  });

  it("rejects malformed payloads", async () => {
    const response = await fetch(`${baseUrl}/v1/vaults/${VAULT_A}/sync/batch`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ protocolVersion: 1 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects oversized bodies", async () => {
    const response = await fetch(`${baseUrl}/v1/vaults/${VAULT_A}/sync/batch`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ padding: "x".repeat(5000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
  });

  it("supports reconciliation, transactional batch sync, and vault status", async () => {
    const value = note();
    const manifest = [{ path: value.path, contentHash: value.contentHash, chunks: value.chunks.map((chunk) => ({ chunkId: chunk.chunkId, contentHash: chunk.contentHash })) }];
    const planResponse = await fetch(`${baseUrl}/v1/vaults/${VAULT_A}/reconcile/plan`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ protocolVersion: 1, generation: 1, descriptor: descriptor(), notes: manifest }),
    });
    expect(await planResponse.json()).toMatchObject({ uploadPaths: ["A.md"], deletePaths: [] });

    const batchResponse = await fetch(`${baseUrl}/v1/vaults/${VAULT_A}/sync/batch`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ protocolVersion: 1, generation: 1, descriptor: descriptor(), operations: [{ type: "UPSERT", note: value }] }),
    });
    expect(await batchResponse.json()).toMatchObject({ applied: true, operationsApplied: 1 });

    const statusResponse = await fetch(`${baseUrl}/v1/vaults/${VAULT_A}/status`, { headers: headers() });
    expect(await statusResponse.json()).toMatchObject({ exists: true, noteCount: 1, chunkCount: 1, generation: 1 });
  });

  it("never includes the token or Authorization header in errors or logs", async () => {
    const response = await fetch(`${baseUrl}/v1/not-found`, { headers: headers() });
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain("Authorization");
    expect(logMessages.join("\n")).not.toContain(token);
    expect(logMessages.join("\n")).not.toContain("Authorization");
  });
});
