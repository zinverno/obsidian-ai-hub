// Uses a disposable synthetic mirror and a deterministic local embedding HTTP fixture.
// No Obsidian directory, plugin credentials, or production mirror is accessed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import process from "node:process";
import { URL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { fetch } = globalThis;
const scratch = await mkdtemp(join(tmpdir(), "vault-stage9-smoke-"));
const vaultId = "11111111-1111-4111-8111-111111111111";
const syncToken = randomBytes(32).toString("hex");
const readToken = randomBytes(32).toString("hex");
const queries = [];
let child;
let serverLogs = "";
let codexLogs = "";
const embedding = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk.toString();
  const body = JSON.parse(text);
  assert.equal(req.url, "/v1/embeddings");
  assert.equal(body.model, "stage9-smoke");
  assert.equal(body.input.length, 1);
  queries.push(body.input[0]);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "stage9-smoke", data: [{ index: 0, embedding: [1, 0, 0] }] }));
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
const embeddingPort = await listen(embedding);
const reservation = createServer();
const companionPort = await listen(reservation);
await new Promise((resolve) => reservation.close(resolve));
const baseUrl = `http://127.0.0.1:${companionPort}`;
const endpoint = `http://127.0.0.1:${embeddingPort}/v1`;
const descriptor = {
  providerId: "openai-compatible", model: "stage9-smoke", baseUrl: endpoint, dimensions: 3,
  embeddingSpaceId: `embedding-space:v1|provider=openai-compatible|model=stage9-smoke|endpoint=${encodeURIComponent(endpoint)}|dimensions=3`, normalized: true,
};
const markdown = "# Companion smoke\n\nThe synthetic launch code is BLUE-ORCHID.\n";
const note = {
  path: "Demo.md", content: markdown, contentHash: "smoke-note", metadata: {},
  chunks: [{
    chunkId: "demo-chunk", notePath: "Demo.md", ordinal: 0, headingPath: ["Companion smoke"],
    text: markdown, contentHash: "smoke-chunk", embedding: [1, 0, 0],
    source: { startOffset: 0, endOffset: markdown.length, startLine: 0, endLine: 3 },
  }],
};

async function start() {
  child = spawn(process.execPath, ["--env-file-if-exists=.env", "dist/server.js"], {
    cwd: root, env: { ...process.env, HOST: "127.0.0.1", PORT: String(companionPort),
      COMPANION_TOKEN: syncToken, DATA_DIR: join(scratch, "data"), ALLOW_REMOTE_BIND: "false", LOG_LEVEL: "info",
      MCP_ENABLED: "true", MCP_TOKEN: readToken, MCP_VAULT_ID: vaultId, MCP_EMBEDDING_API_KEY: "",
      MCP_EMBEDDING_TIMEOUT_MS: "1000", MCP_ALLOWED_HOSTS: "127.0.0.1,localhost,[::1]",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => { serverLogs += data; });
  child.stderr.on("data", (data) => { serverLogs += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Companion smoke process exited during startup.");
    try {
      const health = await fetch(`${baseUrl}/health`);
      assert.deepEqual(await health.json(), { status: "ok", protocolVersion: 1 });
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error("Companion smoke startup timed out.");
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await done;
}

async function sync(action, payload) {
  const response = await fetch(`${baseUrl}/v1/vaults/${vaultId}/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${syncToken}`, "x-companion-protocol-version": "1", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function exercise(era, phase) {
  const client = new Client({ name: "stage9-smoke", version: "1.0.0" }, era === "modern" ? { versionNegotiation: { mode: "auto" } } : {});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: { token: async () => readToken } }));
  try {
    assert.equal(client.getProtocolEra(), era);
    assert.equal((await client.listTools()).tools.length, 5);
    for (const [name, args] of [
      ["vault_status", {}], ["list_notes", {}], ["get_note", { path: "Demo.md" }],
      ["get_chunks", { path: "Demo.md" }], ["search_vault", { query: "launch code", limit: 1 }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name} failed`);
      if (name === "get_note") assert.equal(result.structuredContent.content, markdown);
      if (name === "search_vault") assert.equal(result.structuredContent.results[0].chunkId, "demo-chunk");
    }
    process.stdout.write(`${phase}: ${era} ${client.getNegotiatedProtocolVersion()} — all 5 tools passed\n`);
  } finally {
    await client.close();
  }
}

async function codexSmoke() {
  const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "-C", scratch, "--json",
    "-c", `mcp_servers.stage9.url=${JSON.stringify(`${baseUrl}/mcp`)}`,
    "-c", 'mcp_servers.stage9.bearer_token_env_var="STAGE9_READ_TOKEN"',
    "-c", "mcp_servers.stage9.required=true",
    "Use only the stage9 MCP tools. This is a synthetic smoke test. Call vault_status, list_notes, get_note(path=Demo.md), get_chunks(path=Demo.md), and search_vault(query=launch code,limit=1), each once. Do not use shell or edit files. Report the launch code and whether all five calls succeeded.",
  ];
  const cli = spawn("codex", args, { cwd: scratch, env: { ...process.env, STAGE9_READ_TOKEN: readToken }, stdio: ["ignore", "pipe", "pipe"] });
  cli.stdout.on("data", (data) => { codexLogs += data; });
  cli.stderr.on("data", (data) => { codexLogs += data; });
  const timer = setTimeout(() => cli.kill("SIGTERM"), 120000);
  let code;
  try {
    code = await new Promise((resolve, reject) => { cli.once("error", reject); cli.once("exit", resolve); });
  } finally {
    clearTimeout(timer);
  }
  const calls = [];
  for (const line of codexLogs.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
        calls.push({ tool: event.item.tool, status: event.item.status });
      }
    } catch { /* CLI diagnostics are not JSON events. */ }
  }
  process.stdout.write(`Codex CLI: exit=${code}; completed MCP calls=${JSON.stringify(calls)}\n`);
  if (code !== 0 || calls.length < 5) {
    // Only diagnostic lines are printed; tokens are never echoed.
    const safe = codexLogs.replaceAll(readToken, "[REDACTED]").replaceAll(syncToken, "[REDACTED]");
    process.stdout.write(safe.slice(-6000));
    throw new Error("Codex real-client smoke did not complete all five MCP calls.");
  }
  assert.deepEqual(calls.map((call) => call.tool).sort(), ["get_chunks", "get_note", "list_notes", "search_vault", "vault_status"]);
  assert.ok(calls.every((call) => call.status === "completed"));
  assert.ok(codexLogs.includes("BLUE-ORCHID"));
}

try {
  await start();
  const plan = { protocolVersion: 1, generation: 1, descriptor, notes: [{ path: note.path, contentHash: note.contentHash, chunks: [{ chunkId: "demo-chunk", contentHash: "smoke-chunk" }] }] };
  assert.deepEqual((await sync("reconcile/plan", plan)).uploadPaths, ["Demo.md"]);
  assert.equal((await sync("sync/batch", { protocolVersion: 1, generation: 1, descriptor, operations: [{ type: "UPSERT", note }] })).applied, true);
  assert.deepEqual((await sync("reconcile/plan", plan)).uploadPaths, []);
  await exercise("modern", "after sync");
  await exercise("legacy", "after sync");
  await stop();
  await start();
  await exercise("modern", "after process restart (SQLite only)");
  await exercise("legacy", "after process restart (SQLite only)");
  assert.equal(queries.length, 4);
  assert.ok(queries.every((query) => query === "launch code"));
  if (process.argv.includes("--codex")) await codexSmoke();
  assert.equal(queries.length, process.argv.includes("--codex") ? 5 : 4);
  assert.ok(queries.every((query) => query === "launch code"));
  assert.ok(!serverLogs.includes(markdown));
  assert.ok(!serverLogs.includes("launch code"));
  assert.ok(!serverLogs.includes(syncToken));
  assert.ok(!serverLogs.includes(readToken));
  process.stdout.write(`Smoke passed: ${queries.length} query HTTP calls, zero stored-note embedding calls.\n`);
} finally {
  await stop();
  await new Promise((resolve) => embedding.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
