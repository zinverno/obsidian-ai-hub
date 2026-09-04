# Vault Audit AI Companion

Companion v0 is a standalone Node.js service that stores a persistent, read-only mirror of Vault Audit AI semantic state. The same source and build run locally and on a Linux VPS; only environment variables differ.

Companion never opens an Obsidian Vault directory, never writes Markdown, has no shared-filesystem or shared-process assumption, and does not implement MCP or write-back.

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

Invalid configuration and inaccessible storage fail at startup with an actionable, redacted message. Tokens, authorization headers, provider keys, note bodies, and chunk text are not logged.

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

## Reconciliation and vector-space rules

The plugin sends a deterministic manifest first. Companion returns only missing/changed paths to upload and stale paths to delete; identical manifests do no work and resend no Markdown or embeddings. Incremental events use bounded transactional batches. Repeating a batch replaces the same `(vaultId, path)` and `(vaultId, chunkId)` records, so operations are idempotent.

`generation` orders frozen local semantic snapshots. Older batches cannot overwrite newer stored generations. Every record is isolated by stable random `vaultId`, never by filesystem path.

The descriptor preserves the plugin's provider, model, normalized endpoint, dimensions, canonical embedding-space fingerprint, and normalized-vector flag. Ordinary batches with a different descriptor receive `DESCRIPTOR_MISMATCH`. Explicit reconciliation plans `replaceVault=true`; the first replacement batch atomically clears the old vector space before inserting new records. Compatible and incompatible vectors are never mixed.

The Vault remains authoritative. Companion's schema contains `vaults`, `notes`, and `chunks` tables with foreign keys and cascade deletion. SQLite WAL plus explicit `BEGIN IMMEDIATE` transactions make each batch atomic. Schema changes use ordered, idempotent `PRAGMA user_version` migrations.

## Privacy and security

When synchronization is enabled, the configured endpoint receives the stable random vault ID, vault-relative note paths, current Markdown, chunk text, chunk/source metadata, embeddings, and semantic descriptor metadata. A localhost mirror remains on the same machine. A remote mirror transmits and persists that Vault data on the remote server.

Embedding/LLM provider API keys are never sent. The Companion bearer token is independent of those credentials and is stored in Obsidian plugin data within the security constraints of an Obsidian Community Plugin. There is no telemetry, account system, permissive browser CORS, MCP, agent, or Vault write-back in v0.
