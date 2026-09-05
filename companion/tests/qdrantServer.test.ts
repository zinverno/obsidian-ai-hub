import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createCompanionServer } from "../src/server.js";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { FakeQdrantIndex } from "./qdrantFixture.js";
import { note, upsertBatch, VAULT_A } from "./fixtures.js";

describe("Qdrant HTTP/MCP integration", () => {
  it("starts offline, keeps tokens and health private, automatically repairs, then isolates a failed sync update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qdrant-http-"));
    const storage = new SqliteCompanionStorage(directory); await storage.initialize();
    await storage.applyBatch(VAULT_A, upsertBatch(1, [note("A.md", "private content", [1, 0, 0])]));
    const config = loadConfig({ COMPANION_TOKEN: "sync-secret", MCP_TOKEN: "read-secret", MCP_ENABLED: "true",
      MCP_VAULT_ID: VAULT_A, QDRANT_ENABLED: "true", QDRANT_API_KEY: "qdrant-private-key", DATA_DIR: directory });
    const index = new FakeQdrantIndex(); index.fail = "all";
    const logs: unknown[] = [];
    const log = (message: string, context?: Record<string, unknown>): void => { logs.push({ message, context }); };
    const provider = { embedQuery: vi.fn(async () => new Float32Array([1, 0, 0])) };
    const server = createCompanionServer(config, storage, { debug: log, info: log, warn: log, error: log }, provider, index);
    const client = new Client({ name: "qdrant-test", version: "1" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${config.token}`, "x-companion-protocol-version": "1" };
    async function status(): Promise<{ state: string; lastSearchBackend: string }> {
      const body = await (await fetch(`${base}/v1/status`, { headers })).json() as { qdrant: { state: string; lastSearchBackend: string } };
      expect(JSON.stringify(body)).not.toContain(config.qdrant!.apiKey);
      return body.qdrant;
    }
    try {
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok", protocolVersion: 1 });
      expect((await fetch(`${base}/v1/status`)).status).toBe(401);
      expect((await fetch(`${base}/v1/status`, { headers: { ...headers, authorization: `Bearer ${config.mcp.token}` } })).status).toBe(401);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async (): Promise<string> => config.mcp.token } }));
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["vault_status", "list_notes", "get_note", "get_chunks", "search_vault"]);
      expect(JSON.stringify(tools)).not.toMatch(/qdrant|backend/iu);
      const request = { name: "search_vault", arguments: { query: "private query", limit: 1 } };
      expect((await client.callTool(request)).isError).not.toBe(true);
      expect(provider.embedQuery).toHaveBeenCalledTimes(1); expect((await status()).lastSearchBackend).toBe("sqlite");
      index.fail = null;
      await vi.waitFor(async () => { expect((await status()).state).toBe("READY"); }, { timeout: 5000 });
      expect((await client.callTool(request)).isError).not.toBe(true); expect((await status()).lastSearchBackend).toBe("qdrant");
      expect(provider.embedQuery).toHaveBeenCalledTimes(2);
      index.fail = "upsert";
      const sync = await fetch(`${base}/v1/vaults/${VAULT_A}/sync/batch`, { method: "POST",
        headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(upsertBatch(2, [note("B.md", "b", [1, 0, 0])])) });
      expect(sync.status).toBe(200); expect(await sync.json()).toMatchObject({ applied: true, generation: 2 });
      await vi.waitFor(async () => { expect((await status()).state).toBe("ERROR"); });
      expect((await client.callTool(request)).isError).not.toBe(true); expect((await status()).lastSearchBackend).toBe("sqlite");
      expect(provider.embedQuery).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(logs)).not.toMatch(/qdrant-private-key|sync-secret|read-secret|private content|private query|upstream/u);
    } finally {
      await client.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await storage.close(); await rm(directory, { recursive: true, force: true });
    }
  });
});
