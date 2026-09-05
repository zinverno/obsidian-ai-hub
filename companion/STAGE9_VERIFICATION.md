# Stage 9 verification: read-only MCP over Companion

The implementation and automated checks pass. The initial official SDK/Codex smoke retrieved a synthetic mirrored Vault while Obsidian was closed, including after a Companion restart. The pre-merge compatibility fix also passed a real OpenRouter search through Codex against the existing SQLite mirror: five results, one query embedding HTTP request, zero note re-embedding, and no mirror changes. No plugin source, version, release, or Vault write-back changes are included. Interactive Obsidian UI shutdown and deployment to a real VPS were not exercised; see the limitations below.

## Baseline and scope

- Repository: `zinverno/obsidian-ai-hub`.
- Branch: `feature/stage-9-readonly-mcp`, started from fresh `main` after Stage 8 PR #16 was merged.
- Baseline SHA: `66e6f9a0641176b4f35c4601cafd049778cc22a4`.
- Baseline plugin: 23 test files / 730 tests; lint, TypeScript, build, and whitespace checks passed. Lint had two existing warnings.
- Baseline Companion: 5 test files / 38 tests; clean install, lint, typecheck, and build passed.
- Plugin version remains `1.7.0`; Companion package version remains `0.1.0`.
- Initial implementation commit: `512c8af`; reproducible smoke/mutation scripts: `b4baf56`; initial Stage 9 handoff: `c7a6549894575fa5e237c85fe89a0a1e1d7bfc42`.
- Verified pre-merge compatibility fix HEAD: `8a059390e492ed15518e4276b7f125b59962ce74`. A subsequent documentation-only commit records these results. The final branch HEAD is recorded in the [PR #17 handoff](https://github.com/zinverno/obsidian-ai-hub/pull/17), including that documentation commit.

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

Search validates descriptor identity and provider compatibility before calling the provider. It validates reported model (when present), allowing only the narrow OpenRouter response equivalence documented below; other providers still require exact equality. Dimensions, finite Float32 values, nonzero query norm, and stored unit normalization within `1e-4` remain mandatory. Query normalization followed by a clamped dot product matches the plugin's cosine ranking. Ordering is descending score, then ascending chunk ID. A linear SQLite vector scan retains top K and loads text afterwards. A descriptor/generation change during the provider request rejects the search. No model switching, note re-embedding, or index rebuild occurs.

Exact call counts:

- Each valid nonempty search: one `embedQuery` invocation, at most one embedding HTTP request, only `[query]` as input, no retries.
- Empty/absent mirrors: zero embedding calls.
- Descriptor incompatibility: zero provider calls. Missing required credentials: zero HTTP calls.
- The four read/list/status tools: zero embedding calls.
- SDK smoke: four searches / four query HTTP requests / zero stored-note requests across modern and legacy clients before and after restart.
- SDK plus Codex smoke: five searches / five query HTTP requests / zero stored-note requests.
- Separate live OpenRouter/Codex pre-merge smoke: one search / one real query HTTP request / zero stored-note requests; subsequent get_chunks and get_note added zero embedding requests.

Missing credentials, timeouts, malformed responses, and incompatible spaces return `SEMANTIC_SEARCH_UNAVAILABLE`; other tools remain usable. Embedding HTTP responses are capped at 2 MiB and redirects are rejected.

Vault text is returned unchanged as explicitly labeled untrusted data, never evaluated as instructions or configuration. MCP exposes paths, Markdown, chunks, source metadata, and similarity scores, not raw vectors. Logs contain tool names, latency, outcomes, and safe codes, not queries, Markdown, chunk text, tokens, authorization headers, or provider errors. Keys remain in process configuration, not SQLite. No telemetry was added. The sync credential controls the descriptor's provider destination and must be protected accordingly.

## Verification results

| Check | Result |
| --- | --- |
| Plugin tests | 23 files, 730 passed |
| Plugin lint | Passed; exactly the two baseline warnings at `api.ts:413` and `settings.ts:108` |
| Plugin TypeScript / production build | Passed |
| Companion tests | 9 files, 92 passed (Stage 8 baseline 38 + initial Stage 9 32 + compatibility fix 22) |
| Companion lint | Passed, zero warnings |
| Companion production and test TypeScript | Both passed |
| Companion build / clean install | Passed; npm reported zero vulnerabilities |
| `git diff --check` | Passed |
| Companion-only sparse checkout | Repeated on the fix commit: clean install, lint, both typechecks, 92 tests, build, SDK smoke, and mutation audit passed |
| Mutation audit | All 10 killed by test assertions; restored tests passed |
| SDK conformance | Modern and legacy negotiation, discovery, tools/list, all tools/call, malformed requests, auth, unknown tools, schema validation, deterministic definitions passed |
| Codex CLI 0.153.0 | Exit 0; all five tool calls completed; retrieved synthetic launch code `BLUE-ORCHID` |
| Live OpenRouter + Codex CLI 0.153.0 | Exit 0; search_vault, get_chunks, get_note succeeded; five results; one query HTTP request; unchanged existing mirror |

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
| J: Accept any OpenRouter reported model | Different-model rejection despite equal dimensions | Killed |

### Local and real-client smoke

`npm run smoke:mcp` starts the built server through the same Node entry point as `npm start`, checks `/health`, provisions `Demo.md` using HTTP reconciliation and UPSERT, confirms reconciliation converges, and calls every tool. It restarts Companion using the same SQLite directory and repeats every tool using both protocol eras. A deterministic local HTTP fixture supplies the query vector; stored vectors arrive through sync.

`npm run smoke:mcp -- --codex` additionally launches the available authenticated Codex CLI with ephemeral per-invocation configuration and a read-only sandbox. It retrieves only synthetic data and does not alter existing client configuration. All five tools completed in the actual CLI run. The OpenAI documentation skill guided checking the installed CLI and official MCP configuration instructions before this smoke; server behavior remains client-neutral.

During the initial synthetic smoke, Obsidian was confirmed absent from host processes and stayed closed. Companion continued serving the persisted mirror after its own restart. That initial smoke did not open a real Vault directory or existing mirror. It verifies offline operation, but not an interactive plugin-sync → close-Obsidian UI sequence. The separate live pre-merge smoke below reads the existing mirror, as explicitly requested.

## Pre-merge live-provider compatibility fix

### Observed false negative and exact rule

The existing descriptor requests OpenRouter model `nvidia/nemotron-3-embed-1b:free` at `https://openrouter.ai/api/v1`, dimensions 2048. A successful real `/embeddings` response reports `private/openrouter/nvidia/nemotron-3-embed-1b`, index 0, vector length 2048. The old `payload.model === descriptor.model` requirement rejected that valid response with `SEMANTIC_SEARCH_UNAVAILABLE`. Regression tests reproduced this before the fix (four permitted alias cases failed).

The response-only equivalence rule is:

1. Exact equality is accepted for every provider.
2. For OpenRouter only, remove at most one exact leading `private/openrouter/` from the **reported** name.
3. Compare that name exactly with the requested descriptor model, or, when the requested model ends in `:free`, with the requested model minus that single terminal suffix.
4. Reject all other reported names. Do not trim whitespace, fold case, remove arbitrary path components, or strip any other suffix. Non-string reported values are rejected; an absent model field retains the previous behavior.

Both `private/openrouter/other/model` and `openai/text-embedding-3-small` are rejected for the Nemotron descriptor even when vector dimensions match. `openai-compatible` and `ollama` continue requiring exact reported-model equality. Requests still send the original `nvidia/nemotron-3-embed-1b:free`. The persisted descriptor, its canonical embeddingSpaceId, and all stored vectors are unchanged; no migration or reindex is needed.

### Permanent regression evidence

The fix adds 22 tests: 21 provider-adapter cases and one integrated SQLite search case. They cover canonical and exact OpenRouter responses, nine mismatched model/namespace/suffix/case/whitespace cases, unchanged exact validation for both other providers, non-string response fields, original request model and query-only input, 2048-dimensional retrieval, zero write calls, and unchanged mirrored descriptor/vectors after search and follow-up reads.

Mutation J temporarily makes every OpenRouter reported model acceptable in a disposable copy. The different-model tests fail by assertion; after restoration they pass. The full audit now kills 10/10 mutants. No weakened comparison remains in production code.

### Real OpenRouter / Codex evidence

The live smoke completed on 2026-09-05 at approximately 03:48 UTC, using the existing ignored `companion/.env` credentials and the existing SQLite mirror (generation 7, 61 notes, 86 chunks). No new provider key was created, printed, committed, or sent to Codex. A temporary harness started the built Companion HTTP server on `127.0.0.1:27124` and injected a counting fetch observer into the existing query provider. It forwarded the actual OpenRouter response unchanged; no fake vectors, resync, or index rebuild were used.

Codex CLI 0.153.0 used ephemeral per-invocation MCP configuration, consistent with the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), and completed these calls in order:

1. `search_vault({ query: "общая память для AI", limit: 5 })`: success, five results, top score `0.40017061695011324`.
2. `get_chunks` for the top result's path, limit 1: success.
3. `get_note` for the same path, maxChars 1000: success.

Non-secret assertions recorded by the harness:

- Codex exit code: 0; all three MCP calls completed.
- OpenRouter: HTTP 200; reported model `private/openrouter/nvidia/nemotron-3-embed-1b`; dimensions 2048; index 0.
- Exactly one HTTP query embedding request, with the original descriptor model and only the exact query as input; zero stored-note/chunk embedding requests.
- Top result identity exists in the original SQLite chunks table; follow-up reads use the same note path, and the returned note slice matches SQLite.
- Zero mutation calls. Before/after logical digests of the configured Vault's persisted descriptor, notes, metadata, and vector blobs match. SQLite schema version also matches.
- No note paths, Markdown, provider keys, bearer tokens, or raw vectors are included in this report. Tool results were inspected in memory for assertions, not persisted as a raw transcript. The temporary Companion server was stopped after the smoke.

### Exact files changed by this fix

- `companion/src/mcp/queryEmbedding.ts`
- `companion/tests/queryEmbedding.test.ts`
- `companion/tests/mcpSemanticSearch.test.ts`
- `companion/scripts/mutation-audit.mjs`
- `companion/README.md`
- `companion/STAGE9_VERIFICATION.md`

Plugin validation passed again: 730 tests, lint with the two pre-existing warnings only, TypeScript, build, and whitespace check. Companion validation passed: 92 tests, zero-warning lint, production/test TypeScript, and build. The independent Companion-only sparse checkout repeated clean install, all those checks, modern/legacy SDK smoke before/after restart, and all ten mutations. No provider, MCP feature, or version was added; this remains the same unmerged PR #17.

## Known limitations and deferred work

- MCP Inspector GUI, Claude Code, and Cursor were not launched. The official SDK harness is the protocol conformance evidence; Claude/Cursor examples are documentation-confirmed only, not runtime compatibility claims.
- No real VPS/reverse proxy was tested. Local HTTP and explicitly configured remote Host/Origin behavior are tested; deployment instructions use the same build behind HTTPS. Live OpenRouter with the specified Nemotron model is now tested; live OpenAI-compatible and Ollama providers were not exercised.
- Vector-space identity cannot prove that a remote provider has not silently changed model weights while retaining its model name/dimensions. Companion does not silently select alternatives.
- Search is a synchronous linear SQLite scan, suitable for v0 personal mirrors, not an ANN index. Large scans can block the process; rate limiting/concurrency budgets can be enforced at a private deployment's proxy.
- Cursors are live continuation markers, not snapshot pagination. Synchronization can change subsequent pages. Note offsets count Unicode code points; chunk source offsets retain Stage 8 UTF-16 units.
- Bearer-token access is intentionally single-Vault and read-only, not an OAuth, public multi-user, or account system. No release or merge is part of this stage.

Qdrant, Vault writes/proposals/approval queues, MCP Apps, agents, GraphRAG, additional databases, and multi-Vault MCP profiles remain deferred.
