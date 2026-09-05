// Mechanical mutations run only in a disposable copy; production sources are never edited.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "vault-search-mutations-"));
const cases = [
  {
    id: "A", name: "MCP token authenticates sync", file: "src/server.ts",
    from: "if (!isAuthorized(request.headers.authorization, config.token))",
    to: "if (!(isAuthorized(request.headers.authorization, config.token) || isAuthorized(request.headers.authorization, config.mcp.token)))",
    test: "mcpProtocol", pattern: "enforces MCP and sync token privilege separation",
  },
  {
    id: "B", name: "caller-selected vault", file: "src/mcp/mcpServer.ts",
    from: "inputSchema: z.strictObject({}),",
    to: "inputSchema: z.strictObject({ vaultId: z.string().optional() }),",
    extra: [
      '() => executeTool(logger, "vault_status", () => service.vaultStatus()),',
      '(input) => executeTool(logger, "vault_status", () => new VaultMcpService(storage, input.vaultId ?? config.vaultId, new SemanticSearchService(storage, provider)).vaultStatus()),',
    ],
    test: "mcpProtocol", pattern: "rejects caller-selected vault scope",
  },
  {
    id: "C", name: "get_note writes storage", file: "src/mcp/service.ts",
    from: "const note = await this.storage.getMcpNote(this.vaultId, path);",
    to: "await this.storage.applyBatch(this.vaultId, { protocolVersion: 1, generation: 99, descriptor: (await this.storage.getMcpVaultStatus(this.vaultId)).descriptor, operations: [] });\n    const note = await this.storage.getMcpNote(this.vaultId, path);",
    test: "mcpTools", pattern: "no read tool invokes the sync mutation API",
  },
  {
    id: "D", name: "stored note re-embedding", file: "src/mcp/semanticSearch.ts",
    from: "queryVector = normalizeQuery(await this.provider.embedQuery(descriptor, query), descriptor.dimensions);",
    to: "await this.provider.embedQuery(descriptor, (await this.storage.getMcpNote(vaultId, 'A.md')).content);\n      queryVector = normalizeQuery(await this.provider.embedQuery(descriptor, query), descriptor.dimensions);",
    test: "mcpSemanticSearch", pattern: "calls only the query provider once",
  },
  {
    id: "E", name: "double query embedding", file: "src/mcp/semanticSearch.ts",
    from: "queryVector = normalizeQuery(await this.provider.embedQuery(descriptor, query), descriptor.dimensions);",
    to: "await this.provider.embedQuery(descriptor, query);\n      queryVector = normalizeQuery(await this.provider.embedQuery(descriptor, query), descriptor.dimensions);",
    test: "mcpSemanticSearch", pattern: "calls only the query provider once",
  },
  {
    id: "F", name: "descriptor check removed", file: "src/mcp/semanticSearch.ts",
    from: "assertCompatibleDescriptor(descriptor);", to: "// mutation: compatibility bypass",
    test: "mcpSemanticSearch", pattern: "canonical embedding-space identity",
  },
  {
    id: "G", name: "raw vectors returned", file: "src/mcp/semanticSearch.ts",
    from: "path: record.path,", to: "embedding: [1, 0, 0],\n      path: record.path,",
    test: "mcpSemanticSearch", pattern: "keeps only top K and returns no raw vectors",
  },
  {
    id: "H", name: "result cap removed", file: "src/search/sqliteVectorBackend.ts",
    from: "if (ranked.length > limit) ranked.length = limit;", to: "// mutation: unbounded results",
    test: "mcpSemanticSearch", pattern: "keeps only top K and returns no raw vectors",
  },
  {
    id: "I", name: "query, note, and token logged", file: "src/mcp/mcpServer.ts",
    from: '(input) => executeTool(logger, "search_vault", () => service.searchVault(input)),',
    to: '(input) => executeTool(logger, "search_vault", async () => { logger.info(input.query, { token: config.token }); const result = await service.searchVault(input); logger.info(JSON.stringify(result)); return result; }),',
    test: "mcpProtocol", pattern: "lets every tool work through the SDK",
  },
  {
    id: "J", name: "any OpenRouter response model accepted", file: "src/mcp/queryEmbedding.ts",
    from: 'if (reportedModel === descriptor.model) return true;',
    to: 'if (descriptor.providerId === "openrouter" || reportedModel === descriptor.model) return true;',
    test: "queryEmbedding", pattern: "rejects a different OpenRouter response model despite identical dimensions",
  },
  {
    id: "10-A", name: "Qdrant error propagates instead of SQLite fallback", file: "src/mcp/semanticSearch.ts",
    from: "this.accelerator.invalidate();", to: 'throw new Error("QDRANT_UNAVAILABLE");',
    test: "qdrantBackend", pattern: "Qdrant search failure falls back using exactly one query embedding",
  },
  {
    id: "10-B", name: "fallback embeds query twice", file: "src/mcp/semanticSearch.ts",
    from: "this.accelerator.invalidate();", to: "this.accelerator.invalidate(); await this.provider.embedQuery(descriptor, query);",
    test: "qdrantBackend", pattern: "Qdrant search failure falls back using exactly one query embedding",
  },
  {
    id: "10-C", name: "stale generation trusted as READY", file: "src/search/vectorBackend.ts",
    from: "left.generation === right.generation &&", to: "",
    test: "qdrantBackend", pattern: "requires exact generation, revision, vault and semantic space",
  },
  {
    id: "10-D", name: "descriptor mismatch accepted", file: "src/search/vectorBackend.ts",
    from: "&& sameSpace(left.descriptor, right.descriptor)", to: "",
    test: "qdrantBackend", pattern: "requires exact generation, revision, vault and semantic space",
  },
  {
    id: "10-E", name: "derived update notified before authoritative COMMIT", file: "src/storage/sqliteCompanionStorage.ts",
    from: 'database.exec("COMMIT");',
    to: 'this.publishCommit({ vaultId, generation: batch.generation, previousRevision: current?.revision ?? 0, revision, replaceVault: batch.replaceVault ?? false, paths }); database.exec("COMMIT");',
    test: "qdrantBackend", pattern: "independent SQLite reader sees COMMIT before observers",
  },
  {
    id: "10-F", name: "secondary failure breaks successful SQLite sync", file: "src/storage/sqliteCompanionStorage.ts",
    from: "catch { /* Secondary work is isolated. */ }", to: "catch (error) { throw error; }",
    test: "qdrantBackend", pattern: "observer failure cannot make a successful SQLite sync fail",
  },
  {
    id: "10-G", name: "old collection queried after descriptor replacement", file: "src/search/qdrantBackend.ts",
    from: 'this.pending = this.state === "READY"', to: 'if (notice.replaceVault) return; this.pending = this.state === "READY"',
    extra: ["sameSnapshot(this.ready.snapshot, snapshot)", "snapshot.vaultId === this.vaultId"],
    test: "qdrantBackend", pattern: "descriptor replacement never queries old space",
  },
  {
    id: "10-H", name: "Qdrant key leaked through diagnostic status", file: "src/search/qdrantBackend.ts",
    from: "lastErrorCode: this.lastErrorCode,", to: "lastErrorCode: this.config.apiKey,",
    test: "qdrantBackend", pattern: "safe diagnostic status never includes Qdrant key",
  },
  {
    id: "10-I", name: "full Markdown in point payload", file: "src/search/qdrantIndex.ts",
    from: "chunkId: record.chunkId, vaultId: spec.vaultId,", to: 'markdown: "# PRIVATE MARKDOWN", chunkId: record.chunkId, vaultId: spec.vaultId,',
    test: "qdrantIndex", pattern: "point payload has only retrieval identity and never full Markdown",
  },
  {
    id: "10-J", name: "partial build published READY", file: "src/search/qdrantBackend.ts",
    from: 'this.state = "BUILDING";',
    to: 'this.state = "READY"; this.ready = { snapshot, spec: indexSpec(this.config.collectionPrefix, snapshot, "partial") };',
    test: "qdrantBackend", pattern: "BUILDING never publishes a partial index",
  },
  {
    id: "10-K", name: "missing authoritative chunk returned as derived content", file: "src/mcp/semanticSearch.ts",
    from: "const record = chunks.get(chunkId);",
    to: 'const record = chunks.get(chunkId) ?? { chunkId, path: "stale.md", ordinal: 0, headingPath: [], source: { startOffset: 0, endOffset: 0, startLine: 0, endLine: 0 }, text: "stale derived text" };',
    test: "qdrantBackend", pattern: "missing SQLite hydration discards all Qdrant candidates",
  },
];

function run(test, pattern) {
  return spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", `tests/${test}.test.ts`, "-t", pattern], {
    cwd: scratch, encoding: "utf8", timeout: 30000,
  });
}

try {
  for (const item of ["src", "tests", "package.json", "tsconfig.json", "tsconfig.test.json"]) {
    await cp(join(root, item), join(scratch, item), { recursive: true });
  }
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
  for (const mutation of cases) {
    const target = join(scratch, mutation.file);
    const original = await readFile(target, "utf8");
    assert.equal(original.split(mutation.from).length, 2, `Ambiguous mutation ${mutation.id}`);
    const before = run(mutation.test, mutation.pattern);
    assert.equal(before.status, 0, before.stdout + before.stderr);
    let changed = original.replace(mutation.from, mutation.to);
    if (mutation.extra) {
      assert.equal(changed.split(mutation.extra[0]).length, 2);
      changed = changed.replace(...mutation.extra);
    }
    try {
      await writeFile(target, changed);
      const result = run(mutation.test, mutation.pattern);
      assert.notEqual(result.status, 0, `SURVIVED ${mutation.id}`);
      assert.match(result.stdout + result.stderr, /AssertionError/, `Mutation ${mutation.id} failed without a test assertion: ${result.stdout}${result.stderr}`);
      process.stdout.write(`${mutation.id}: KILLED — ${mutation.name}\n`);
    } finally {
      await writeFile(target, original);
    }
    const restored = run(mutation.test, mutation.pattern);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  }
  process.stdout.write(`${cases.length}/${cases.length} mutations killed; every restored test passed.\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
