# Stage 9 verification: read-only MCP over Companion

The implementation and automated checks pass. The official SDK and Codex CLI successfully retrieved a synthetic mirrored Vault while Obsidian was closed, including after a Companion restart. No plugin source, version, release, or Vault write-back changes are included. Interactive Obsidian UI shutdown, a live commercial embedding provider, and deployment to a real VPS were not exercised; see the limitations below.

## Baseline and scope

- Repository: `zinverno/obsidian-ai-hub`.
- Branch: `feature/stage-9-readonly-mcp`, started from fresh `main` after Stage 8 PR #16 was merged.
- Baseline SHA: `66e6f9a0641176b4f35c4601cafd049778cc22a4`.
- Baseline plugin: 23 test files / 730 tests; lint, TypeScript, build, and whitespace checks passed. Lint had two existing warnings.
- Baseline Companion: 5 test files / 38 tests; clean install, lint, typecheck, and build passed.
- Plugin version remains `1.7.0`; Companion package version remains `0.1.0`.
- Implementation commit: `512c8af`; reproducible smoke/mutation scripts: `b4baf56`. The documentation commit is the final branch head; its complete SHA is reported in the PR handoff.

Changed files, grouped by responsibility:

- Configuration/dependencies: `companion/.env.example`, `companion/package.json`, `companion/package-lock.json`, `companion/src/config.ts`.
- HTTP boundary: `companion/src/server.ts`.
- Read storage: `companion/src/storage/mcpReadStorage.ts`, `companion/src/storage/sqliteCompanionStorage.ts`.
- MCP implementation: `companion/src/mcp/{bounds,descriptor,errors,mcpServer,pagination,queryEmbedding,semanticSearch,service}.ts`.
- Permanent tests: `companion/tests/{config,server,mcpProtocol,mcpSemanticSearch,mcpTools,queryEmbedding}.test.ts`.
- Reproducible audits: `companion/scripts/mcp-smoke.mjs`, `companion/scripts/mutation-audit.mjs`.
- Documentation: root `README.md`, `companion/README.md`, this report.

All executable changes remain inside `companion/`. No plugin imports, additional daemon, vector database, agent, mutation tool, or write-back workflow was added.

## Protocol, authorization, and tools

The official `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and development-only `@modelcontextprotocol/client` packages are pinned to `2.0.0`; schemas use Zod `4.2.0`. The SDK handles MCP and JSON-RPC, including modern protocol `2026-07-28` and its supported initialize-based legacy path, tested with `2025-11-25`.

`/mcp` is Streamable HTTP on the existing Companion HTTP server. The SDK creates a server per request, with no session ID, resumability, or subscriptions. Modern responses are JSON; legacy Streamable HTTP responses can use SSE framing. Legacy GET/DELETE session operations return 405. There is no standalone SSE transport. Host/Origin validation uses official SDK helpers; remote proxy hostnames must be explicitly allowed. TLS remains the reverse proxy's responsibility.

MCP defaults to disabled (404). Enabling it requires a separate nonempty `MCP_TOKEN` and one valid `MCP_VAULT_ID`. Equal MCP/sync tokens fail configuration. Each credential is rejected on the other's routes, including reconciliation and batch sync. Every tool rejects unknown input properties, including `vaultId`; the configured Vault is the only scope. A frozen read-method capability object prevents MCP from receiving sync methods or the database handle.

| Tool | Input schema summary | Output boundary |
| --- | --- | --- |
| `vault_status` | Empty strict object | Existence, generation, counts, non-secret descriptor; no content |
| `list_notes` | Optional prefix, limit, cursor | Default 50 / maximum 200 notes; deterministic path order |
| `get_note` | Path, optional startOffset and maxChars | Default 12000 / maximum 50000 code points; exact slice and offsets |
| `get_chunks` | Path, optional limit and cursor | Default 20 / maximum 50 chunks; text capped at 8000 code points |
| `search_vault` | Query, optional limit | Query capped at 2000 code points; default 5 / maximum 20 results; text capped at 4000 |

Chunk and search results include source ranges, ordinals, headings, and explicit text/heading truncation metadata. Headings are capped at 16 entries of 256 code points. Missing notes and invalid cursors have stable tool errors. Full Markdown remains accessible using note slices. Request bodies are capped at 1 MiB.

The read interface exposes only status, note listing/existence/content, chunk pagination, vector iteration, and winner-text lookup. SQL predicates scope every read to the configured Vault. Vector iteration does not fetch chunk text; the search service requests it only for winning IDs.

## Retrieval and privacy

The query adapter supports the plugin's `openrouter`, `openai-compatible`, and `ollama` providers. The persisted descriptor supplies the provider, model, normalized URL, dimensions, and canonical embedding-space identity. Companion-owned credentials use `MCP_EMBEDDING_API_KEY`; the plugin never sends provider keys. Ollama sends no key. OpenRouter and the official OpenAI endpoint require one; compatible unauthenticated services can omit it.

Search validates descriptor identity and provider compatibility before calling the provider. It validates reported model (when present), dimensions, finite Float32 values, nonzero query norm, and stored unit normalization within `1e-4`. Query normalization followed by a clamped dot product matches the plugin's cosine ranking. Ordering is descending score, then ascending chunk ID. A linear SQLite vector scan retains top K and loads text afterwards. A descriptor/generation change during the provider request rejects the search. No model switching, note re-embedding, or index rebuild occurs.

Exact call counts:

- Each valid nonempty search: one `embedQuery` invocation, at most one embedding HTTP request, only `[query]` as input, no retries.
- Empty/absent mirrors: zero embedding calls.
- Descriptor incompatibility: zero provider calls. Missing required credentials: zero HTTP calls.
- The four read/list/status tools: zero embedding calls.
- SDK smoke: four searches / four query HTTP requests / zero stored-note requests across modern and legacy clients before and after restart.
- SDK plus Codex smoke: five searches / five query HTTP requests / zero stored-note requests.

Missing credentials, timeouts, malformed responses, and incompatible spaces return `SEMANTIC_SEARCH_UNAVAILABLE`; other tools remain usable. Embedding HTTP responses are capped at 2 MiB and redirects are rejected.

Vault text is returned unchanged as explicitly labeled untrusted data, never evaluated as instructions or configuration. MCP exposes paths, Markdown, chunks, source metadata, and similarity scores, not raw vectors. Logs contain tool names, latency, outcomes, and safe codes, not queries, Markdown, chunk text, tokens, authorization headers, or provider errors. Keys remain in process configuration, not SQLite. No telemetry was added. The sync credential controls the descriptor's provider destination and must be protected accordingly.

## Verification results

| Check | Result |
| --- | --- |
| Plugin tests | 23 files, 730 passed |
| Plugin lint | Passed; exactly the two baseline warnings at `api.ts:413` and `settings.ts:108` |
| Plugin TypeScript / production build | Passed |
| Companion tests | 9 files, 70 passed (baseline 38 + 32) |
| Companion lint | Passed, zero warnings |
| Companion production and test TypeScript | Both passed |
| Companion build / clean install | Passed; npm reported zero vulnerabilities |
| `git diff --check` | Passed |
| Companion-only sparse checkout | Clean install, lint, both typechecks, 70 tests, build, and SDK smoke passed |
| Mutation audit | All 9 killed by test assertions; restored tests passed |
| SDK conformance | Modern and legacy negotiation, discovery, tools/list, all tools/call, malformed requests, auth, unknown tools, schema validation, deterministic definitions passed |
| Codex CLI 0.153.0 | Exit 0; all five tool calls completed; retrieved synthetic launch code `BLUE-ORCHID` |

The sparse checkout used an independent local Git clone with only the `companion` directory selected, no root dependencies installed, and the committed implementation/scripts. This proves source/build isolation, not a remote VPS deployment. The smoke succeeded within that checkout too.

Existing Stage 8 regressions remain covered: reconciliation, incremental UPSERT, cascading DELETE, atomic RENAME, descriptor invalidation/replacement, stale generation handling, SQLite close/reopen persistence, vault isolation, and plugin offline recovery. No sync payload format or plugin source was changed.

### Mutation evidence

`npm run audit:mutations` performs each edit in a disposable copy, verifies the baseline test passes, requires an assertion failure for the mutant, restores the source, and requires the test to pass again. Production files are never mutated by the audit.

| Mutation | Detecting invariant | Result |
| --- | --- | --- |
| A: Accept MCP token on sync | Privilege separation | Killed |
| B: Caller-selected Vault | Strict single-Vault scope | Killed |
| C: Make get_note write storage | Read-only calls and unchanged mirror | Killed |
| D: Embed stored note content | Exact query-only provider input/cost | Killed |
| E: Embed query twice | Single-call cost | Killed |
| F: Remove descriptor check | Canonical vector-space compatibility | Killed |
| G: Return raw vectors | Output privacy | Killed |
| H: Remove top K cap | Output bounds | Killed |
| I: Log query/note/token | Log privacy | Killed |

### Local and real-client smoke

`npm run smoke:mcp` starts the built server through the same Node entry point as `npm start`, checks `/health`, provisions `Demo.md` using HTTP reconciliation and UPSERT, confirms reconciliation converges, and calls every tool. It restarts Companion using the same SQLite directory and repeats every tool using both protocol eras. A deterministic local HTTP fixture supplies the query vector; stored vectors arrive through sync.

`npm run smoke:mcp -- --codex` additionally launches the available authenticated Codex CLI with ephemeral per-invocation configuration and a read-only sandbox. It retrieves only synthetic data and does not alter existing client configuration. All five tools completed in the actual CLI run. The OpenAI documentation skill guided checking the installed CLI and official MCP configuration instructions before this smoke; server behavior remains client-neutral.

Obsidian was confirmed absent from host processes and stayed closed throughout the smoke. Companion continued serving the persisted mirror after its own restart. No real Vault directory or existing mirror was opened. This verifies offline operation, but not an interactive plugin-sync → close-Obsidian UI sequence.

## Known limitations and deferred work

- MCP Inspector GUI, Claude Code, and Cursor were not launched. The official SDK harness is the protocol conformance evidence; Claude/Cursor examples are documentation-confirmed only, not runtime compatibility claims.
- No real VPS/reverse proxy or commercial embedding provider was tested. Local HTTP and explicitly configured remote Host/Origin behavior are tested; deployment instructions use the same build behind HTTPS.
- Vector-space identity cannot prove that a remote provider has not silently changed model weights while retaining its model name/dimensions. Companion does not silently select alternatives.
- Search is a synchronous linear SQLite scan, suitable for v0 personal mirrors, not an ANN index. Large scans can block the process; rate limiting/concurrency budgets can be enforced at a private deployment's proxy.
- Cursors are live continuation markers, not snapshot pagination. Synchronization can change subsequent pages. Note offsets count Unicode code points; chunk source offsets retain Stage 8 UTF-16 units.
- Bearer-token access is intentionally single-Vault and read-only, not an OAuth, public multi-user, or account system. No release or merge is part of this stage.

Qdrant, Vault writes/proposals/approval queues, MCP Apps, agents, GraphRAG, additional databases, and multi-Vault MCP profiles remain deferred.
