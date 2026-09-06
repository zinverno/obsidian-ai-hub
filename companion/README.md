# Vault Audit AI Companion

Companion v0 is a standalone Node.js service that stores a persistent, read-only mirror of Vault Audit AI semantic state. The same source and build run locally and on a Linux VPS; only environment variables differ.

Companion never opens an Obsidian Vault directory or writes Markdown. Its optional MCP endpoint retrieves the persisted mirror and queues change proposals even while Obsidian is closed. Only the Obsidian plugin can apply a proposal after an explicit human approval click.

## Requirements

- Node.js 24 LTS or newer
- npm
- A long random bearer token

Node 24's built-in `node:sqlite` module is used so installation does not compile or download a native database addon. Node 24 currently labels this API experimental, so operators should stay on a supported Node 24 LTS patch release and review Node release notes before a major upgrade.

## Local installation

```sh
git clone https://github.com/zinverno/obsidian-ai-hub.git
cd obsidian-ai-hub/companion
npm ci
npm run build
cp .env.example .env
```

Edit `.env`, replace the example token, then start:

```sh
npm test
npm start
```

`npm start` uses Node's `--env-file-if-exists=.env`; ordinary process environment variables work without an `.env` file and take precedence according to Node's env-file behavior.

Configure the plugin with `http://127.0.0.1:27124`, the same token, explicitly enable Companion, and select **Sync now**. Merely entering an endpoint does not upload data.

## Companion-only sparse checkout

Only `companion/` is needed on a server:

```sh
git clone --filter=blob:none --no-checkout \
  https://github.com/zinverno/obsidian-ai-hub.git
cd obsidian-ai-hub
git sparse-checkout init --cone
git sparse-checkout set companion
git checkout main
cd companion
npm ci
npm run typecheck
npm test
npm run build
cp .env.example .env
npm start
```

No root `npm install`, plugin build, Obsidian dependency, Vault directory, or source file outside `companion/` is required.

## Linux VPS

Use the same sparse-checkout, `npm ci`, tests, and build shown above. The recommended production topology keeps Companion on loopback and terminates TLS at a reverse proxy:

```text
Internet -> HTTPS -> Caddy/Nginx -> 127.0.0.1:27124 -> Companion -> SQLite
```

Example production environment:

```sh
HOST=127.0.0.1
PORT=27124
COMPANION_TOKEN=a-long-random-secret
DATA_DIR=/var/lib/vault-audit-companion
ALLOW_REMOTE_BIND=false
LOG_LEVEL=info
```

Minimal Caddy configuration:

```caddyfile
vault.example.com {
    reverse_proxy 127.0.0.1:27124
}
```

DNS must point to the VPS, ports 80/443 must be allowed as required by the reverse proxy, and the operator is responsible for TLS and firewall configuration. Localhost HTTP is acceptable. Never send the bearer token or Vault mirror over plaintext Internet HTTP. Companion does not terminate TLS.

Direct non-loopback binding is available only when both `HOST` is non-loopback and `ALLOW_REMOTE_BIND=true`; it is not the recommended reverse-proxy configuration.

An optional systemd unit can run `npm start` with `WorkingDirectory` set to the checked-out `companion` directory and `EnvironmentFile` set to a protected environment file. systemd and Docker are not required.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. Non-loopback requires explicit opt-in. |
| `PORT` | `27124` | TCP port, 1–65535. |
| `COMPANION_TOKEN` | none | Required bearer secret; startup fails when empty. |
| `DATA_DIR` | `./data` | Writable persistent SQLite directory. |
| `ALLOW_REMOTE_BIND` | `false` | Must be `true` for a non-loopback `HOST`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `MCP_ENABLED` | `false` | Enable `/mcp`; otherwise the route returns 404. |
| `MCP_TOKEN` | none | Separate read/proposal credential, required when MCP is enabled. Must differ from `COMPANION_TOKEN`. |
| `MCP_VAULT_ID` | none | Exactly one UUID from the plugin's Companion identity. Required when MCP is enabled. |
| `MCP_EMBEDDING_API_KEY` | empty | Companion-owned query embedding credential; never saved to SQLite. |
| `MCP_EMBEDDING_TIMEOUT_MS` | `30000` | Query HTTP timeout, 500–120000 ms. No retries. |
| `MCP_ALLOWED_HOSTS` | loopback names and `HOST` | Comma-separated hostnames/IPs accepted in MCP Host and Origin headers; no schemes, ports, or wildcards. Add the public reverse-proxy hostname for remote access. |

Invalid configuration and inaccessible storage fail at startup with an actionable, redacted message. Tokens, authorization headers, provider keys, note bodies, and chunk text are not logged.

## MCP

Enable MCP explicitly after synchronizing a Vault through the plugin. Copy the stable Companion Vault UUID from the plugin's saved Companion settings; a filesystem path is not an identity. Restart Companion after configuration changes.

```sh
MCP_ENABLED=true
MCP_TOKEN=replace-with-a-different-long-random-read-secret
MCP_VAULT_ID=11111111-1111-4111-8111-111111111111
# Optional, depending on the stored embedding provider:
MCP_EMBEDDING_API_KEY=
MCP_EMBEDDING_TIMEOUT_MS=30000
MCP_ALLOWED_HOSTS=127.0.0.1,localhost,[::1],vault.example.com
```

Local clients connect to `http://127.0.0.1:27124/mcp`; remote clients use `https://vault.example.com/mcp` through the existing HTTPS reverse proxy. Both use `Authorization: Bearer <MCP_TOKEN>`. MCP requests do not need the Stage 8 `X-Companion-Protocol-Version` header.

`COMPANION_TOKEN` can update the mirror through `/v1/`; `MCP_TOKEN` only authenticates `/mcp`. Neither credential authenticates the other's routes. Equal configured tokens fail startup to prevent an MCP credential accidentally granting sync or approval privileges. Anyone holding the MCP token can read the configured Vault's mirrored content and queue proposals; keep the token private and use HTTPS outside loopback. Public unauthenticated access and an OAuth server are not provided.

The implementation uses the official TypeScript SDK packages `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, pinned to **2.0.0**, with Zod 4 schemas. The SDK's `createMcpHandler` serves protocol **2026-07-28** and its built-in stateless legacy initialize path. Tests exercise **2025-11-25** legacy negotiation as well. A fresh MCP server is built per request; there is no session ID, resumability, or standalone `/sse` endpoint. Legacy GET/DELETE session operations return 405. Modern calls produce JSON; legacy calls may use an SSE response on the same Streamable HTTP endpoint. No change notifications or subscriptions are offered. [Official SDK HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)

Every tool operates on the one server-configured `MCP_VAULT_ID`. There is no vault enumeration tool, and all input objects reject unknown properties, including `vaultId`. The five retrieval tools receive a frozen read capability with no sync, migration, initialization or database-write methods. The proposal tools receive a separate frozen capability exposing only proposal `create` and `get`, scoped to the same Vault. Neither capability can claim, complete or approve a proposal.

| Tool | Inputs | Bounded result |
| --- | --- | --- |
| `vault_status` | `{}` | Exists flag, generation, note/chunk counts, and non-secret semantic descriptor; no note bodies. |
| `list_notes` | `prefix?`, `limit?`, `cursor?` | Paths, hashes, chunk counts; default 50, maximum 200. Deterministic SQLite path order. |
| `get_note` | `path`, `startOffset?`, `maxChars?` | Exact Markdown slice; default 12000, maximum 50000 Unicode code points, plus offsets, total size, and truncation flag. |
| `get_chunks` | `path`, `limit?`, `cursor?` | Chunk IDs, paths, ordinals, headings, source ranges, and text; default 20, maximum 50, up to 8000 code points per chunk. |
| `search_vault` | `query`, `limit?` | Top matching chunks with score and source metadata; default 5, maximum 20, up to 4000 code points per chunk. |
| `propose_change` | `operation`, `path`, operation-specific content/hash, `summary?` | Proposal UUID, operation, path, summary, status and timestamps; no body echo. |
| `get_proposal` | `proposalId` | Same safe proposal state, including terminal outcomes. No claim credential or note content. |

Queries are trimmed, limited to 2000 Unicode code points, and reject NUL. Paths use the Stage 8 canonical vault-relative validation. Cursors are opaque continuation markers bound to the prefix or note path; clients must reuse them unchanged. They are not snapshot tokens: synchronization between pages can change later results. Empty lists return no cursor. Missing notes return `NOTE_NOT_FOUND`; malformed cursors return `INVALID_CURSOR`.

`get_note` offsets count Unicode code points, so an emoji is not split. `endOffset` is exclusive; use it as the next `startOffset` to read large notes. An offset beyond EOF returns an empty slice at EOF. Chunk `source` ranges retain the original Stage 8 offsets (UTF-16 code units) and line numbers; they are not directly interchangeable with `get_note` code-point offsets. Chunk text includes chunker-owned heading context and may differ from a literal source slice.

Chunk results include `totalTextChars` and `textTruncated`. Heading metadata is limited to 16 entries of 256 code points each, with `totalHeadings` and `headingPathTruncated`. Full Markdown remains available with `get_note`. Request bodies are limited to 1 MiB. All note text is explicitly marked **untrusted Vault data**: instructions inside Markdown do not change tool behavior or server configuration. Markdown is not rewritten or executed. Raw embedding arrays are never returned.

### Query embeddings and vector-space safety

The stored Stage 8 descriptor selects the provider, model, normalized base URL, dimension, and canonical embedding-space identity. MCP callers cannot override these. The Companion must be able to reach that same embedding endpoint; a descriptor using `localhost` refers to the **Companion machine**, including on a VPS.

The small query adapter supports the existing plugin providers:

- `openrouter`: OpenAI-compatible `/embeddings`; requires a Companion-owned `MCP_EMBEDDING_API_KEY`.
- `openai-compatible`: `/embeddings`; the key is optional for unauthenticated services and required for `api.openai.com`.
- `ollama`: `/api/embed`; no API key is sent.

The plugin never transmits its embedding or language-model API keys. Provision any query key separately in Companion's protected environment. The trusted sync credential controls the descriptor and therefore the provider destination; protect it accordingly. HTTP redirects are rejected, response bodies are capped at 2 MiB, and timeouts abort the provider request. Provider response bodies, URLs from errors, and credentials are not included in tool errors or logs.

Each non-empty search calls `QueryEmbeddingProvider.embedQuery` **once**, sending only `[query]`. It never sends stored note/chunk text for embedding and never probes dimensions with a second request. Empty mirrors/chunk sets make zero calls. The other four tools make zero embedding calls. A missing/incompatible provider or invalid response produces a clean `SEMANTIC_SEARCH_UNAVAILABLE` tool error while reading/listing remains available.

Search validates the canonical descriptor identity, supported provider, dimensions, finite Float32 values, and nonzero query norm. If the provider reports a model, it must match exactly, with one narrow OpenRouter exception: remove at most one leading `private/openrouter/` from the reported name and allow a terminal `:free` on the requested name to be absent in the response; the underlying identifier must still match exactly. No other namespaces, suffixes, case changes, or different models are accepted. Requests and the persisted descriptor/embedding-space ID retain the original configured model; no reindex is needed. Stored vectors must be unit-normalized within `1e-4`. The query is normalized into Float32 and dot products are clamped to `[-1, 1]`, matching the plugin's cosine semantics. Scores sort descending, with chunk ID ascending as the stable tie-break. The SQLite scan retains only top K vectors and reads winner text afterwards. A descriptor/generation change during the query request rejects the search rather than comparing incompatible spaces. With Qdrant disabled, retrieval uses the permanent SQLite linear scan. Optional Qdrant acceleration uses the same query vector and hydrates every winner from SQLite; see below.

### Client configuration

**Codex CLI:** tested with **0.153.0** against this endpoint, including all five tools. In a personal `config.toml`, use the read token from the client process environment:

```toml
[mcp_servers.vault_audit]
url = "http://127.0.0.1:27124/mcp"
bearer_token_env_var = "VAULT_AUDIT_MCP_TOKEN"
```

Set `VAULT_AUDIT_MCP_TOKEN` to the Companion's `MCP_TOKEN` before launching Codex. The configuration syntax is documented in the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

**Claude Code:** documentation-confirmed configuration; not runtime-tested in this environment. A personal `.mcp.json` can use environment expansion:

```json
{
  "mcpServers": {
    "vault_audit": {
      "type": "http",
      "url": "http://127.0.0.1:27124/mcp",
      "headers": { "Authorization": "Bearer ${VAULT_AUDIT_MCP_TOKEN}" }
    }
  }
}
```

See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp). Approve the configured server in the client as required.

**Cursor:** documentation-confirmed configuration; not runtime-tested here. In personal `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vault_audit": {
      "url": "http://127.0.0.1:27124/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Replace the placeholder only in your protected local configuration; do not commit a real token. See [Cursor MCP integrations](https://prod.cursor.com/help/customization/mcp). For all clients, substitute the HTTPS endpoint for remote deployment. There are no client-specific server implementations.

### Verification

```sh
npm ci
npm run lint
npm run typecheck
npx tsc -p tsconfig.test.json --noEmit
npm test
npm run build
npm run audit:mutations
npm run smoke:mcp
# Optional, when an authenticated Codex CLI is available on PATH:
npm run smoke:mcp -- --codex
```

The smoke command starts the same built entry point as `npm start`, provisions a disposable synthetic Vault via Stage 8 HTTP sync, discovers all seven tools and exercises the five retrieval tools using official SDK clients, restarts Companion, and repeats all calls against persisted SQLite. Its local deterministic embedding fixture proves request counts; it does not test a live commercial provider or require an Obsidian Vault directory. The optional Codex mode launches an ephemeral client with per-invocation MCP configuration. Real Vault data and existing client configuration are not used.

The SDK harness is the protocol conformance check; MCP Inspector GUI, Claude, and Cursor were not launched. The Stage 9 smoke ran with Obsidian already closed, so it verifies offline operation and process restart, not an interactive Obsidian open→close sequence.

## Protocol v1

All authenticated requests send:

```http
Authorization: Bearer <COMPANION_TOKEN>
X-Companion-Protocol-Version: 1
Content-Type: application/json
```

An incompatible or missing protocol version receives HTTP 409 and `PROTOCOL_VERSION_MISMATCH`. Errors have one stable envelope and never include a stack trace or raw SQLite error:

```json
{"error":{"code":"INVALID_REQUEST","message":"..."}}
```

Routes:

- `GET /health` — unauthenticated; returns only `{"status":"ok","protocolVersion":1}`.
- `GET /v1/status` — authenticated aggregate server status.
- `GET /v1/vaults/:vaultId/status` — authenticated aggregate state for one UUID.
- `POST /v1/vaults/:vaultId/reconcile/plan` — compact manifest comparison.
- `POST /v1/vaults/:vaultId/sync/batch` — transactional `UPSERT`, `DELETE`, and `RENAME` operations.

Reconciliation request:

```json
{
  "protocolVersion": 1,
  "generation": 12,
  "descriptor": {
    "providerId": "openai-compatible",
    "model": "text-embedding-3-small",
    "baseUrl": "https://api.openai.com/v1",
    "dimensions": 1536,
    "embeddingSpaceId": "embedding-space:v1|...",
    "normalized": true
  },
  "notes": [
    {
      "path": "Notes/A.md",
      "contentHash": "...",
      "chunks": [{"chunkId":"chunk-...","contentHash":"..."}]
    }
  ]
}
```

Reconciliation response:

```json
{
  "protocolVersion": 1,
  "generation": 12,
  "serverGeneration": 11,
  "replaceVault": false,
  "uploadPaths": ["Notes/A.md"],
  "deletePaths": ["Removed.md"],
  "unchangedPaths": []
}
```

Batch request:

```json
{
  "protocolVersion": 1,
  "generation": 12,
  "descriptor": {"providerId":"...","model":"...","baseUrl":"https://...","dimensions":3,"embeddingSpaceId":"...","normalized":true},
  "replaceVault": false,
  "operations": [
    {"type":"DELETE","path":"Removed.md"},
    {"type":"UPSERT","note":{"path":"A.md","content":"# A","contentHash":"...","metadata":{},"chunks":[]}},
    {"type":"RENAME","oldPath":"Old.md","note":{"path":"New.md","content":"# New","contentHash":"...","metadata":{},"chunks":[]}}
  ]
}
```

Each real chunk also carries `chunkId`, `notePath`, `ordinal`, `headingPath`, full `text`, `contentHash`, the four-value source range, and the full numeric `embedding`. A successful response is:

```json
{"protocolVersion":1,"generation":12,"applied":true,"stale":false,"operationsApplied":3}
```

Requests are bounded to 16 MiB, 100 operations per batch, 4 MiB per note, and 10,000 chunks per note.

## Optional Qdrant acceleration

Qdrant is **optional, disabled by default, and a derived, rebuildable vector-search index**. SQLite remains the authoritative persistent mirror for Markdown, note/chunk identity, text, metadata, stored vectors, semantic descriptor, generation and synchronization. The plugin only talks to Companion and has no Qdrant settings. The MCP tools and `search_vault({ query, limit? })` inputs are unchanged; backend selection is server policy.

Companion uses the official [`@qdrant/js-client-rest`](https://github.com/qdrant/qdrant-js) client, pinned to **1.19.0**, through a narrow adapter. Use Qdrant **1.19.x** with collection metadata support. An incompatible server or collection leaves retrieval on SQLite. All dependencies live in `companion/`; the same build runs locally or on a Linux VPS. Docker is not a Companion runtime requirement.

| Variable | Default | Meaning |
| --- | --- | --- |
| `QDRANT_ENABLED` | `false` | Enable the derived index for the one configured `MCP_VAULT_ID`. |
| `QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant HTTP(S) endpoint, optionally with a reverse-proxy path. URL credentials, query strings and fragments are rejected. |
| `QDRANT_API_KEY` | empty | Server-side Qdrant credential. Keep in a protected environment file; never in plugin settings. |
| `QDRANT_TIMEOUT_MS` | `5000` | Per-request timeout, 100–120000 ms. Requests are not retried. |
| `QDRANT_COLLECTION_PREFIX` | `vault_audit` | 1–32 ASCII letters, digits or underscores. Use separate prefixes for separate Companion deployments. |
| `QDRANT_ALLOW_INSECURE_REMOTE_HTTP` | `false` | Explicit opt-in for plaintext HTTP beyond loopback, including private IPs. |

`MCP_VAULT_ID` must be set when Qdrant is enabled, even if `/mcp` is disabled. It is the same stable UUID used by the plugin's existing Companion mirror. Other mirrored Vaults remain in SQLite. Restart Companion after configuration changes.

A local configuration, in addition to the normal Companion/MCP settings:

```dotenv
MCP_VAULT_ID=11111111-1111-4111-8111-111111111111
QDRANT_ENABLED=true
QDRANT_URL=http://127.0.0.1:6333
QDRANT_API_KEY=
QDRANT_TIMEOUT_MS=5000
QDRANT_COLLECTION_PREFIX=vault_audit
QDRANT_ALLOW_INSECURE_REMOTE_HTTP=false
```

Run Qdrant separately using its native binary or your existing service manager. An optional local development container can be started with:

```sh
docker run --rm --name vault-qdrant -p 127.0.0.1:6333:6333 qdrant/qdrant:v1.19.1
```

The container's vector data is disposable; Companion rebuilds it from SQLite. Keep the authoritative Companion `DATA_DIR` persistent and backed up.

For a VPS with a protected HTTPS endpoint reachable on private networking:

```dotenv
MCP_VAULT_ID=11111111-1111-4111-8111-111111111111
QDRANT_ENABLED=true
QDRANT_URL=https://qdrant.internal.example
QDRANT_API_KEY=replace-with-a-private-server-side-key
QDRANT_TIMEOUT_MS=5000
QDRANT_COLLECTION_PREFIX=vault_audit_vps
QDRANT_ALLOW_INSECURE_REMOTE_HTTP=false
```

Prefer HTTPS and firewall/private-network restrictions in production. Loopback plaintext is accepted. If an isolated private network deliberately uses `http://10.0.0.12:6333`, set `QDRANT_ALLOW_INSECURE_REMOTE_HTTP=true`; that explicitly permits transmitting the key in plaintext on that network. HTTP redirects are refused for every SDK operation, including HTTPS redirects, so the key cannot follow a redirect to another endpoint. Configure the final URL directly. Keys never enter SQLite, MCP output, public health, authenticated diagnostic status or upstream error text. Adapter errors retain only fixed error codes.

### Readiness, rebuild and recovery

HTTP and MCP start after normal SQLite initialization. Qdrant reconciliation starts independently in the background. Startup does not wait for Qdrant, and no Obsidian resync/reindex is needed when Qdrant is enabled later or recovers from an outage.

The states are `DISABLED`, `BUILDING`, `READY`, `STALE` and `ERROR`. Search may use Qdrant only for an exact match of Vault, generation, internal SQLite commit revision and complete semantic descriptor (provider, model, endpoint identity, dimensions, normalized flag and `embeddingSpaceId`). The internal revision advances on every committed sync batch, including multiple batches of the same generation, without changing the public sync protocol. Failed transactions do not advance it.

On each Companion process start, existing Qdrant data is distrusted and rebuilt. Rebuild reads stored SQLite vectors by chunk-ID keyset pages of at most 128 records, validates their dimensions and normalization, and uploads at most 128 points per request. It never reads Markdown for embedding, rechunks notes, changes stored vectors or calls an embedding provider. SQLite cursors are not held across network waits. The build is published `READY` only after completed writes, compatible collection metadata, exact total/current point counts, and another check of the unchanged SQLite snapshot. A unique build stamp detects older restored Qdrant snapshots and late writes from failed requests. Partial or raced builds cannot become current.

Collections use `<prefix>_<128-bit SHA-256 vault hash>_<128-bit SHA-256 space hash>`, with a full SHA-256 ownership marker in collection metadata. Names contain no note paths, absolute Vault paths or Markdown. Point IDs are deterministic UUIDv8 values derived from SHA-256 of the JSON pair `[vaultId, chunkId]`. A rebuild preserves those IDs. Each point has its vector plus `chunkId`, `vaultId`, `embeddingSpaceId`, generation, revision, build stamp and a hashed note path used for deletes. Full Markdown, chunk text and source metadata remain in SQLite.

Every SQLite sync transaction commits first. Its post-commit notification invalidates readiness immediately and queues secondary work. A single pending compatible change deletes the affected note identities in Qdrant, uploads their current SQLite vectors and updates the generation/revision/build stamps of the retained points. This covers UPSERT, DELETE and RENAME: Stage 8 rename deletes both old/destination records and inserts the new note. Several pending commits coalesce into one complete rebuild. Descriptor replacement selects a new collection immediately; old-space collections are never searched for the replacement descriptor.

A Qdrant failure cannot roll back SQLite or turn a successfully committed sync response into a failure. Later reconciliation repairs the derived index from the mirror. One worker handles updates with no unbounded failure queue. Failed passes use capped exponential backoff (2–30 seconds); healthy indexes are checked every 30 seconds. Each pass is a finite sequence of bounded requests; periodic maintenance continues while Companion runs. Search also checks collection compatibility and exact total/current counts before querying, detecting missing, empty, stale or partially deleted indexes without waiting for maintenance. Multiple external round trips can add up to several per-request timeouts before fallback.

One Companion process must own each prefix/Vault/space collection. Do not share those collections with another writer or modify their payloads/vectors manually. The ownership marker prevents clearing an unrelated collection, but is not a distributed writer lock. Old owned collections are retained after descriptor replacement. Companion does not delete collections automatically; operators may conservatively remove unused collections after checking their ownership marker and ensuring no Companion uses them. Back up SQLite; derived collections can be recreated.

### Retrieval and operator status

Each search creates at most **one query embedding**. Qdrant returns only candidate chunk IDs and cosine scores. Companion sorts by score descending then chunk ID ascending and reads all winning text, paths, headings and source ranges from current SQLite. Qdrant cosine scores remain in `[-1, 1]`; only Float32 roundoff up to `1e-6` outside that interval is clamped. ANN retrieval may differ from a full scan on larger datasets. Candidate retrieval is bounded (at most 257 points); if the window cuts a score tie, SQLite resolves the tie for deterministic results.

Disabled, unavailable, rebuilding, stale, incompatible, malformed, timed-out or incompletely hydrated Qdrant results fall back to the permanent SQLite backend using the **same normalized query vector**. Suspicious partial results are discarded in full. A same-space commit during Qdrant retrieval can use the current SQLite snapshot; a descriptor change rejects the old query vector. No fallback re-embeds the query or stored notes. The other four read-only MCP tools always read SQLite.

`GET /v1/status`, authenticated with `COMPANION_TOKEN` and `X-Companion-Protocol-Version: 1`, adds a `qdrant` object. When enabled it reports state, connectivity from the last check, collection, Vault/space identity, indexed/current generation and revision, `lastErrorCode`, `lastSuccessfulSyncAt`, and `lastSearchBackend` (`sqlite` or `qdrant`). The latter describes the most recently completed semantic search, not a caller-selectable option. A retained indexed generation/collection after failure is diagnostic history, not permission to search it. Disabled status reports `enabled: false` and `state: DISABLED`. Public `/health` stays limited to service health and protocol version, and the MCP `vault_status` output is unchanged.

## Reconciliation and vector-space rules

The plugin sends a deterministic manifest first. Companion returns only missing/changed paths to upload and stale paths to delete; identical manifests do no work and resend no Markdown or embeddings. Incremental events use bounded transactional batches. Repeating a batch replaces the same `(vaultId, path)` and `(vaultId, chunkId)` records, so operations are idempotent.

`generation` orders frozen local semantic snapshots. Older batches cannot overwrite newer stored generations. Every record is isolated by stable random `vaultId`, never by filesystem path.

The descriptor preserves the plugin's provider, model, normalized endpoint, dimensions, canonical embedding-space fingerprint, and normalized-vector flag. Ordinary batches with a different descriptor receive `DESCRIPTOR_MISMATCH`. Explicit reconciliation plans `replaceVault=true`; the first replacement batch atomically clears the old vector space before inserting new records. Compatible and incompatible vectors are never mixed.

The Vault remains authoritative. Companion's schema contains `vaults`, `notes`, and `chunks` tables with foreign keys and cascade deletion. SQLite WAL plus explicit `BEGIN IMMEDIATE` transactions make each batch atomic. Schema changes use ordered, idempotent `PRAGMA user_version` migrations.

## Privacy and security

When synchronization is enabled, the configured endpoint receives the stable random vault ID, vault-relative note paths, current Markdown, chunk text, chunk/source metadata, embeddings, and semantic descriptor metadata. A localhost mirror remains on the same machine. A remote mirror transmits and persists that Vault data on the remote server.

Embedding/LLM provider API keys are never sent by the plugin. The Companion sync bearer token is independent of those credentials and is stored in Obsidian plugin data within the security constraints of an Obsidian Community Plugin. Optional MCP access exposes mirrored paths, Markdown, chunks, and search results to the configured client; similarity scores reveal information about embeddings indirectly, but raw vectors are not exposed. Search sends the query to the descriptor's embedding provider. Logs contain only tool names, latency, outcome, and safe error codes. There is no telemetry, account system, permissive browser CORS, agent, or direct Companion Vault write. Proposal content and its immutable base snapshot are stored in SQLite; approval occurs only in Obsidian.

## Safe change proposals

`propose_change` **DOES NOT MODIFY THE VAULT**. It stores an immutable proposal in SQLite for explicit human review through the plugin's **Review AI change proposals** command. There is one `/mcp` endpoint; no apply, write-file, rename, shell or approval MCP tool exists.

| Operation | Required fields | Mirror precondition |
| --- | --- | --- |
| `CREATE_NOTE` | `path`, `proposedContent` | Target does not exist. `expectedContentHash` is forbidden. |
| `UPDATE_NOTE` | `path`, `expectedContentHash`, `proposedContent` | Current mirrored hash matches; content must differ from the base. |
| `DELETE_NOTE` | `path`, `expectedContentHash` | Current mirrored hash matches. `proposedContent` is forbidden. |

All operations accept an optional `summary`. Unknown fields are rejected. Paths are at most 4096 UTF-16 code units, relative Markdown paths with canonical `/` separators; absolute paths, traversal, URLs, control characters, malformed separators and `.obsidian` are rejected. The plugin also rejects its actual custom configuration directory. Proposed content and the immutable base snapshot are each limited to 250,000 Unicode code points and cannot contain NUL. Summaries are limited to 2,000 code points. The existing 1 MiB MCP request limit still applies, so heavily escaped JSON may reach the byte limit first.

UPDATE uses exact whole-note replacement without fuzzy patches or rebasing. Obtain the full note through bounded/paginated `get_note` before constructing replacement content. The canonical hash is the existing `stableHash` over UTF-16 code units, now shared with the plugin; CRLF and LF remain different, preserving historical sync semantics. Because this hash is not cryptographic, approval additionally compares the exact immutable base text and verifies exact resulting text. No-op UPDATE proposals are rejected to avoid ambiguous replay after a lost acknowledgement.

Schema migration 3 adds a separate `proposals` table: random UUIDv4 identity, Vault UUID, operation/path, base content/hash, proposed content/hash, summary, state, epoch-millisecond creation/update/claim/expiry/application timestamps, random claim ID and fixed status code. Proposal writes never update notes, chunks, vectors, generation, revision, commit subscribers or Qdrant. The table survives mirror descriptor replacement and normal Companion restarts.

```text
PENDING -> CLAIMED -> APPLIED | CONFLICT | FAILED
   |          |
   |          +-- lease expires --> PENDING
   +-- explicit Reject ----------> REJECTED
   +-- older than 30 days -------> EXPIRED
```

APPLIED, CONFLICT, FAILED, REJECTED and EXPIRED are terminal. Claim and completion run in SQLite transactions. A 120-second lease has a random claim ID; only that claim may complete, and two clients cannot hold it simultaneously. Expiry is processed on subsequent proposal access, and a new claim invalidates the old one. Repeated identical completion for the same terminal claim is idempotent. Rejection is idempotent while already REJECTED and is forbidden once claimed. Client-name metadata is not used for authorization. MCP cancellation and listing are deferred.

The following HTTP endpoints require **COMPANION_TOKEN** and `X-Companion-Protocol-Version: 1`. MCP_TOKEN receives 401, including for reads on these privileged routes.

| Method and route | Behavior |
| --- | --- |
| `GET /v1/vaults/:vaultId/proposals` | Pending/claimed summaries; `limit` defaults to 20, maximum 50; use the returned `nextCursor`. UUID-order pages are not snapshots. |
| `GET /v1/vaults/:vaultId/proposals/:id` | Full bounded immutable proposal for review. |
| `POST /v1/vaults/:vaultId/proposals/:id/claim` | Empty `{}` body; returns proposal, claimId and leaseDurationMs. |
| `POST /v1/vaults/:vaultId/proposals/:id/complete` | `claimId`, `status` and required fixed error `statusCode` for failures/conflicts. Records an outcome only. |
| `POST /v1/vaults/:vaultId/proposals/:id/reject` | Empty `{}` body; persists rejection only. |

Completion statuses are APPLIED (no code), CONFLICT (`PRECONDITION_FAILED`), or FAILED (`VAULT_WRITE_FAILED`, `VERIFY_FAILED`, `LEASE_EXPIRED`). No arbitrary error messages, stacks or note text are stored as status codes. These endpoints do not access the Vault filesystem or perform synchronization.

After an explicit Approve click, the plugin claims immediately before applying, checks path and current content, then writes through `vault.create`, `vault.process` (hash/text validation inside its atomic callback), or `fileManager.trashFile` after a fresh read. CREATE rechecks absence; missing UPDATE/DELETE targets conflict. The plugin checks a conservative monotonic lease deadline immediately before writing and verifies the resulting content or absence before acknowledging APPLIED. Duplicate clicks share one in-flight operation. Write failures are never silently retried. Parent folders must already exist; deletion follows Obsidian's trash preference. External filesystem editors cannot participate in an atomic delete comparison; Obsidian's API provides no cross-process compare-and-delete transaction.

**APPLIED means the real Vault write succeeded, not that the mirror is synchronized.** Existing Obsidian file events drive normal semantic AutoSync, then Companion sync and optional Qdrant updates. Enable those existing integrations for eventual mirror updates. Proposal code never pushes a synthetic mirror batch. A Companion outage before claim prevents any write; an outage after a successful claim/write may leave acknowledgement pending. The plugin keeps session-local receipts so another attempt only retries acknowledgement. After a plugin crash or expired lease, inspect the actual note: re-approval checks the original immutable base/absence, producing a conflict when that write already took effect. There is no distributed exactly-once transaction across SQLite and Obsidian, and no automatic rebase or recovery write.

The plugin fetches proposals manually when the modal opens or Refresh is clicked; there is no polling or auto-approval. Diff pages contain up to 200 inert text lines and distinguish additions, removals and context. Proposed Markdown and summaries are untrusted and never executed as HTML. Obsidian can remain closed while clients queue proposals; files remain unchanged until explicit approval after reopening.

**Privacy:** creating proposals transmits proposed Markdown to Companion. Remote deployment stores both proposed content and the mirrored base snapshot on the remote server. Proposal creation/rejection cause zero embedding-provider calls and zero Qdrant operations; proposal content is not sent to telemetry. An approved edit can subsequently be embedded by the plugin's ordinary configured AutoSync flow. Protect and back up Companion's SQLite data directory accordingly.

Retention runs conservatively on proposal access: pending proposals older than 30 days expire; terminal history is retained for at least 30 days after its last update, then up to 200 old rows are removed per maintenance pass. At most 100 pending/claimed proposals per Vault and 2,000 total rows are accepted. Full queues return PROPOSAL_LIMIT. There is no destructive cleanup MCP tool.

Permanent proposal tests run with the ordinary plugin and Companion test commands. The cross-project Stage 11 mutation probes require a full checkout with both dependency sets installed: `node companion/scripts/proposal-mutation-audit.mjs` from the repository root. They mutate only disposable copies in the OS temporary directory. Companion's regular build, tests, and existing `npm run audit:mutations` remain independent in a Companion-only sparse checkout.
