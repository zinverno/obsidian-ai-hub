import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createCompanionServer } from "../src/server.js";
import { SqliteCompanionStorage } from "../src/storage/sqliteCompanionStorage.js";
import { stableHash } from "../src/proposals/contentHash.js";
import type { ProposalClaim, ProposalDetail, ProposalInput, ProposalSummary } from "../src/proposals/types.js";
import { FakeQdrantIndex } from "./qdrantFixture.js";
import { note, upsertBatch, VAULT_A, VAULT_B } from "./fixtures.js";

describe("proposal HTTP/MCP boundary", () => {
  let directory: string, storage: SqliteCompanionStorage, server: ReturnType<typeof createCompanionServer>, client: Client, base: string;
  let index: FakeQdrantIndex, provider: { embedQuery: ReturnType<typeof vi.fn<() => Promise<Float32Array>>> }, db: DatabaseSync;
  const markdown = "# Private\r\nПривет 😀\n";
  const input: ProposalInput = { operation: "UPDATE_NOTE", path: "A.md", expectedContentHash: stableHash(markdown), proposedContent: markdown + "Approved later\n" };
  const logs: unknown[] = [];
  const headers = { authorization: "Bearer plugin-secret", "x-companion-protocol-version": "1", "content-type": "application/json" };
  const url = (id = "", action = ""): string => `${base}/v1/vaults/${VAULT_A}/proposals${id ? `/${id}` : ""}${action ? `/${action}` : ""}`;
  async function call(name: string, args: Record<string, unknown>): Promise<Awaited<ReturnType<Client["callTool"]>>> { return client.callTool({ name, arguments: args }); }
  async function propose(value: ProposalInput = input): Promise<ProposalSummary> {
    const result = await call("propose_change", { ...value }); expect(result.isError).not.toBe(true);
    return (result.structuredContent as { proposal: ProposalSummary }).proposal;
  }
  function snapshot(): string {
    return JSON.stringify(["vaults", "notes", "chunks"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "proposal-http-")); storage = new SqliteCompanionStorage(directory); await storage.initialize();
    await storage.applyBatch(VAULT_A, upsertBatch(1, [{ ...note("A.md", markdown, [1, 0, 0]), contentHash: stableHash(markdown) }]));
    db = new DatabaseSync(join(directory, "companion.sqlite"));
    const config = loadConfig({ COMPANION_TOKEN: "plugin-secret", MCP_TOKEN: "mcp-secret", MCP_ENABLED: "true", MCP_VAULT_ID: VAULT_A, QDRANT_ENABLED: "true", DATA_DIR: directory });
    index = new FakeQdrantIndex(); provider = { embedQuery: vi.fn(async () => new Float32Array([1, 0, 0])) }; logs.length = 0;
    const log = (message: string, context?: Record<string, unknown>): void => { logs.push({ message, context }); };
    server = createCompanionServer(config, storage, { debug: log, info: log, warn: log, error: log }, provider, index);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await vi.waitFor(async () => {
      const state = await (await fetch(`${base}/v1/status`, { headers })).json() as { qdrant: { state: string } };
      expect(state.qdrant.state).toBe("READY");
    });
    client = new Client({ name: "proposal-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async (): Promise<string> => "mcp-secret" } }));
  });
  afterEach(async () => { await client?.close(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); db?.close(); await storage?.close(); await rm(directory, { recursive: true, force: true }); });

  it("defines strict bounded proposal tools and preserves all five read tools", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["vault_status", "list_notes", "get_note", "get_chunks", "search_vault", "propose_change", "get_proposal"]);
    expect(tools.find((t) => t.name === "propose_change")?.description).toContain("THIS TOOL DOES NOT MODIFY THE VAULT.");
    for (const args of [ { ...input, vaultId: VAULT_B }, { ...input, approval: true }, { ...input, proposedContent: "x".repeat(250001) },
      { ...input, summary: "x".repeat(2001) }, { ...input, expectedContentHash: undefined }, { ...input, operation: "RENAME_NOTE" },
      ...["../A.md", "/A.md", "a\\A.md", "https://x/A.md", ".obsidian/A.md", "a//A.md", "a.txt", "a\0.md"].map((path) => ({ ...input, path })) ]) {
      expect((await call("propose_change", args)).isError).toBe(true);
    }
    expect((await call("get_proposal", { proposalId: "bad", vaultId: VAULT_B })).isError).toBe(true);
    expect(storage.getProposalStore().list(VAULT_A).proposals).toHaveLength(0);
  });
  it("CREATE UPDATE DELETE and reject produce zero embeddings, zero Qdrant operations and zero mirror writes", async () => {
    const before = snapshot(); const qdrant = [...index.calls]; const mutation = vi.spyOn(storage, "applyBatch");
    const update = await propose(); const create = await propose({ operation: "CREATE_NOTE", path: "New.md", proposedContent: "untrusted new Markdown" });
    const deletion = await propose({ operation: "DELETE_NOTE", path: "A.md", expectedContentHash: stableHash(markdown) });
    for (const proposal of [update, create, deletion]) {
      expect(proposal.status).toBe("PENDING");
      const status = await call("get_proposal", { proposalId: proposal.proposalId });
      expect(status.structuredContent).toMatchObject({ dataTrust: "untrusted-vault-data", proposal });
      expect(JSON.stringify(status)).not.toMatch(/baseContent|proposedContent|claimId|plugin-secret|mcp-secret/u);
      expect((await fetch(url(proposal.proposalId, "reject"), { method: "POST", headers, body: "{}" })).status).toBe(200);
      expect((await call("get_proposal", { proposalId: proposal.proposalId })).structuredContent).toMatchObject({ proposal: { status: "REJECTED" } });
    }
    expect(snapshot()).toBe(before); expect(mutation).not.toHaveBeenCalled(); expect(provider.embedQuery).not.toHaveBeenCalled(); expect(index.calls).toEqual(qdrant);
    expect(JSON.stringify(logs)).not.toMatch(/Private|Approved later|untrusted new Markdown|plugin-secret|mcp-secret/u);
  });
  it("rejects stale mirror hashes, existing CREATE, invalid conditional fields and another Vault's proposal", async () => {
    for (const args of [{ ...input, expectedContentHash: "0000000000000000" }, { operation: "DELETE_NOTE", path: "A.md", expectedContentHash: "0000000000000000" },
      { operation: "CREATE_NOTE", path: "A.md", proposedContent: "x" }, { operation: "CREATE_NOTE", path: "New.md", proposedContent: "x", expectedContentHash: stableHash(markdown) },
      { operation: "DELETE_NOTE", path: "A.md", expectedContentHash: stableHash(markdown), proposedContent: "x" }]) {
      expect((await call("propose_change", args)).isError).toBe(true);
    }
    const other = storage.getProposalStore().create(VAULT_B, { operation: "CREATE_NOTE", path: "B.md", proposedContent: "other vault private" });
    expect((await call("get_proposal", { proposalId: other.proposalId })).isError).toBe(true);
    expect((await fetch(url(other.proposalId), { headers })).status).toBe(404);
  });
  it("MCP token cannot claim, complete APPLIED, reject, list, or sync; plugin token manages claims only", async () => {
    const proposal = await propose(); const before = snapshot();
    const mcpHeaders = { ...headers, authorization: "Bearer mcp-secret" };
    for (const action of ["claim", "complete", "reject"]) {
      expect((await fetch(url(proposal.proposalId, action), { method: "POST", headers: mcpHeaders, body: JSON.stringify({ claimId: VAULT_B, status: "APPLIED" }) })).status).toBe(401);
    }
    for (const endpoint of [url(), url(proposal.proposalId)]) expect((await fetch(endpoint, { headers: mcpHeaders })).status).toBe(401);
    expect((await fetch(`${base}/v1/vaults/${VAULT_A}/sync/batch`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(upsertBatch(2, [])) })).status).toBe(401);
    expect((await fetch(url(), { headers })).status).toBe(200);
    const detail = await (await fetch(url(proposal.proposalId), { headers })).json() as { proposal: ProposalDetail };
    expect(detail.proposal.baseContent).toBe(markdown);
    const claim = await (await fetch(url(proposal.proposalId, "claim"), { method: "POST", headers, body: "{}" })).json() as ProposalClaim;
    expect(claim.proposal.status).toBe("CLAIMED");
    expect((await fetch(url(proposal.proposalId, "claim"), { method: "POST", headers, body: "{}" })).status).toBe(409);
    expect((await fetch(url(proposal.proposalId, "complete"), { method: "POST", headers, body: JSON.stringify({ claimId: claim.claimId, status: "APPLIED" }) })).status).toBe(200);
    expect(snapshot()).toBe(before); // Acknowledgement is never a mirror or Vault write.
    expect((await call("get_proposal", { proposalId: proposal.proposalId })).structuredContent).toMatchObject({ proposal: { status: "APPLIED" } });
  });
});

it("proposal modules have no filesystem, shell, embedding or Qdrant capability", async () => {
  const directory = new URL("../src/proposals/", import.meta.url);
  for (const name of await readdir(directory)) {
    const source = await readFile(new URL(name, directory), "utf8");
    expect(source).not.toMatch(/(?:node:fs|node:child_process|writeFile|unlink|embedQuery|Qdrant|applyBatch|publishCommit)/u);
    const imports = [...source.matchAll(/(?:from\s+|import\s*\()?["']((?:node:|\.\.?\/|@)[^"']+)["']/gu)].map((match) => match[1]);
    expect(imports.every((path) => /^(?:node:(?:crypto|sqlite)|\.\/|\.\.\/protocol\/|@modelcontextprotocol\/server)/u.test(path!))).toBe(true);
  }
});
