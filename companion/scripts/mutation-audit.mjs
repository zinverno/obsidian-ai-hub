// Mechanical mutations run only in a disposable copy; production sources are never edited.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "vault-stage9-mutations-"));
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
      '(input) => executeTool(logger, "vault_status", () => new VaultMcpService(storage, input.vaultId ?? config.vaultId, new SqliteSemanticSearch(storage, provider)).vaultStatus()),',
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
    from: "path: record.path,", to: "embedding: Array.from(record.vector),\n      path: record.path,",
    test: "mcpSemanticSearch", pattern: "keeps only top K and returns no raw vectors",
  },
  {
    id: "H", name: "result cap removed", file: "src/mcp/semanticSearch.ts",
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
