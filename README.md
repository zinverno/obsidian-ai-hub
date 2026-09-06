# Vault Audit AI

<p align="center">
  <img src="assets/vault-audit-ai-cover.png" alt="Vault Audit AI — semantic search and AI tools for Obsidian" width="100%">
</p>

<p align="center">
  <strong>Turn your Obsidian vault into an AI-searchable knowledge base.</strong>
</p>

<p align="center">
  Semantic search, related-note discovery, vault auditing, and AI writing tools for Obsidian.
</p>

<p align="center">
  <a href="https://github.com/zinverno/obsidian-ai-hub/stargazers">⭐ Star</a>
  ·
  <a href="https://github.com/zinverno/obsidian-ai-hub/releases">Releases</a>
  ·
  <a href="https://github.com/zinverno/obsidian-ai-hub/blob/main/LICENSE">MIT License</a>
</p>

Vault Audit AI is an open-source Obsidian Community Plugin for searching notes by meaning, discovering related ideas, auditing vault structure, and working with notes through configurable AI providers.

Instead of relying only on filenames and exact keywords, it adds a semantic layer to your vault. You can recover forgotten ideas, surface hidden connections, review possible duplicates, and keep a persistent vector index synchronized as your notes evolve.

**Version:** 1.7.0 · **Requires Obsidian:** 1.8.7 or later · **License:** [MIT](LICENSE)

## See it in action

<p align="center">
  <img src="assets/vault-audit-semantic-search-demo.gif" alt="Vault Audit AI semantic search demo" width="900">
</p>

<p align="center">
  <em>Search your vault by meaning, review the strongest matches, and jump to the relevant note.</em>
</p>

## Why Vault Audit AI?

- 🔎 **Search by meaning** instead of remembering the exact wording.
- 🧠 **Rediscover related notes** from the document you are already working on.
- 🧹 **Review potential semantic duplicates** and overlapping ideas.
- 💬 **Ask your Vault** and receive a streamed, source-backed answer from indexed notes.
- 🛰️ **Mirror semantic state to an optional Companion** running locally or behind HTTPS on your own VPS.
- 🗺️ **Audit your vault** for clusters, orphan notes, tags, folders, and structural issues.
- ✍️ **Use AI inside Obsidian** for writing, transformations, flashcards, Dataview, and batch processing.
- 🔒 **Choose local-first options** with Ollama, or connect remote AI providers when you want them.

Semantic features are opt-in and disabled by default. The first semantic index is built only after an explicit user action. Once an index exists, ordinary Markdown changes can be synchronized automatically.

## Features

### Semantic search

Vault Audit AI builds a persistent semantic index from your Markdown notes and lets you retrieve content by meaning rather than exact keyword overlap.

- Markdown-aware chunking that preserves heading context and source locations.
- Persistent vector index stored locally in the plugin directory.
- Chunk-level incremental indexing based on stable content and metadata hashes.
- Manual full-vault reconciliation through the command palette.
- Manual indexing of the current Markdown note.
- Debounced automatic synchronization for Markdown create, modify, delete, and rename events after the initial index exists.
- Quiet incremental reconciliation after startup for compatible existing indexes.
- Search results grouped by note, with the strongest matching sections shown first.
- Exact vault-relative paths for opening the selected note.
- Best-effort navigation to the most relevant source section.
- Explicit clear and rebuild operations with confirmation.
- Compatibility detection when the embedding provider, model, endpoint, or vector dimensions change.

### Semantic discovery

Search starts with a query. Discovery starts with a note and asks what else in the vault is conceptually close to it.

- **Find similar notes** builds a document representation for the active indexed Markdown note and ranks other indexed notes by document-level cosine similarity.
- **Find potential semantic duplicates** conservatively reports highly similar note pairs for human review.
- Both commands reuse vectors already stored in the existing local semantic index.
- Similar-note and duplicate comparisons do not call the embedding provider while comparing existing indexed notes.
- Results include exact vault paths and the strongest matching indexed sections for navigation.
- Empty and near-empty notes are excluded with a deterministic minimum-content rule to reduce false positives.

> High semantic similarity is a review signal, not proof that two notes are identical or safe to merge.

### Ask your Vault

**Ask your Vault** is a one-shot retrieval-augmented question flow over the existing semantic index.

- Reuses the configured embedding provider and the same persistent vector store; it does not create a second index.
- Embeds the question once, retrieves diverse candidate chunks, and reconstructs their current full text from Markdown notes.
- Rejects missing, stale, or hash-mismatched chunks instead of sending outdated indexed previews to the language model.
- Applies deterministic per-document limits and a 12,000 Unicode code-point context budget.
- Streams the answer and presents trusted source cards with exact paths and best-effort source-line navigation.
- Treats retrieved note text as untrusted data and assigns citation IDs such as `[S1]` in plugin code.
- Never builds or rebuilds an index implicitly and never edits source notes.

> Ask your Vault requires a compatible, non-empty semantic index and valid language-model settings.

### AI writing tools

Use AI on the note or selection you are already working with.

- Simple text continuation.
- Vault-aware text continuation.
- Selected-text processing.
- Dataview query generation.
- Flashcard generation for the current note.
- Note atomization into separate atomic notes.
- Batch processing with folder, tag, and date filters.

Batch actions include style improvement, examples, summarization, automatic tags, conclusions, grammar correction, flashcards, and a custom prompt.

### Review AI change proposals

An MCP client can call `get_note`, construct exact whole-note content, and call `propose_change` with `CREATE_NOTE`, `UPDATE_NOTE`, or `DELETE_NOTE`. **A proposal does not change the Vault.** Companion stores it until you review it in Obsidian.

Enable Companion integration, then run **Vault Audit AI: Review AI change proposals** in the command palette. Use **Refresh**, open **Review**, inspect the operation, path, summary, state and text diff, then explicitly click **Approve** or **Reject**. Added, removed and context lines are distinct; Markdown/HTML is displayed as inert text. Large previews have page controls. Opening the modal never approves anything, and there is no background approval mode.

Approval obtains a two-minute claim, checks the real note against the immutable proposal base, performs one Obsidian API write, and verifies the result. An edited or missing UPDATE/DELETE target, or an existing CREATE target, produces `CONFLICT` without overwriting the current note. Create a fresh proposal after synchronizing the new base. Rejection records `REJECTED` without changing notes. CREATE requires existing parent folders; DELETE uses Obsidian's configured trash handling.

`APPLIED` confirms the Vault write, while normal semantic AutoSync and Companion synchronization may still be running. Those integrations must be enabled for the mirror to catch up. Proposal creation and rejection use **zero embedding calls and zero Qdrant operations**. Approved content may later reach your existing embedding provider through ordinary AutoSync.

When Obsidian is closed, proposals remain on Companion and no notes change. If Companion cannot grant a claim, approval fails safely. A crashed client's claim expires; a write whose acknowledgement was lost may appear pending again, but the immutable base/absence checks prevent blindly repeating the completed operation. Inspect the real note before proposing another change. See [proposal storage, retention and privacy](companion/README.md#safe-change-proposals).

### Vault audit

Analyze your vault as a knowledge system rather than as a collection of isolated files.

- Vault structure analysis with orphan detection.
- Folder and tag statistics.
- Markdown dashboard generation.
- Canvas map generation.
- Deep MapReduce-style audit with note summaries.
- Thematic clustering.
- Quality analysis and global findings.
- Action-plan generation.
- Incremental Single audit mode that can skip notes whose cached source has not changed.
- Full Single audit mode for explicitly reprocessing every eligible note.
- MOC generation from saved audit clusters.

## Supported providers

### Language models

- OpenRouter
- Ollama
- OpenAI
- Groq
- Custom OpenAI-compatible endpoints

Language-model actions send their configured context to the selected provider. Ollama can run these requests locally when connected to a local Ollama instance.

### Embeddings

- OpenRouter
- Ollama
- OpenAI-compatible APIs, including the official OpenAI endpoint

The default OpenRouter example is `openai/text-embedding-3-small`.

Model availability, pricing, rate limits, and retention policies are controlled by each provider and may change.

## Installation

### Obsidian Community Plugins

1. Open **Settings → Community plugins**.
2. Select **Browse**.
3. Search for **Vault Audit AI**.
4. Select **Install**.
5. Enable the plugin.

### Manual installation from a GitHub Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub Release](https://github.com/zinverno/obsidian-ai-hub/releases).
2. Create:

   ```text
   <your-vault>/.obsidian/plugins/ai-knowledge-hub/
   ```

3. Copy the three release assets into that directory.
4. Reload Obsidian.
5. Enable **Vault Audit AI** under **Community plugins**.

Do not copy the source TypeScript files into the plugin directory.

## Semantic search setup

1. Open the plugin settings.
2. Enable **Enable semantic features**.
3. Select an embedding provider.
4. Configure the model, Base URL, and API key when required.
5. Select **Test embeddings** to verify the connection.
6. Run **Update the Vault semantic index** from the command palette.
7. Open **Semantic search** from the command palette.
8. Configure a language-model provider, then open **Ask your Vault** for a source-backed answer.

After the active note is indexed, **Find similar notes** can compare it with the rest of the index. **Find potential semantic duplicates** scans the existing document representations without re-embedding the vault.

The initial indexing step is intentionally explicit and is never started automatically. After it succeeds, normal Markdown edits are synchronized in the background.

## Privacy and data flow

Vault Audit AI separates local storage from provider-side processing so you can choose the setup that fits your privacy requirements.

- Plugin settings and API keys are saved locally through Obsidian plugin data storage.
- Semantic features are opt-in and disabled by default.
- The semantic vector index is stored in:

  ```text
  .obsidian/plugins/ai-knowledge-hub/semantic-index/
  ```

- Stored vectors and index metadata remain local unless the optional Companion integration is explicitly enabled and synchronized.
- When OpenRouter or another remote embedding API is selected, note chunks are sent to that endpoint during indexing and synchronization.
- Semantic search queries are sent to the selected embedding provider for query embedding.
- **Ask your Vault** performs one query embedding for retrieval. When the embedding provider is remote, the question is sent to that provider; retrieved source chunks are not re-embedded during Ask.
- When the configured language-model provider is remote, **Ask your Vault** sends it the question plus only the selected, reconstructed source chunks and required metadata. The whole vault, unused candidate notes, and vector index files are not sent to the language-model provider.
- **Find similar notes** and potential duplicate detection operate on vectors already present in the local index and do not make an embedding-provider request for the comparison itself.
- Ollama allows embedding generation to remain local when connected to a local Ollama instance.
- Automatic semantic synchronization never edits Markdown files. It reads the latest Markdown content and changes only the local vector index.
- Companion is disabled by default. Entering an endpoint alone does not upload Vault data.
- When Companion sync is enabled, the configured endpoint receives a stable random Vault ID, vault-relative paths, current Markdown, full chunk text, chunk/source metadata, embeddings, and semantic descriptor metadata. Localhost keeps that mirror on the same machine; a remote endpoint transmits and persists it on that server.
- Remote Companion endpoints must use HTTPS. The Companion bearer token is independent of embedding and language-model credentials; provider API keys are never sent to Companion.
- Changing Companion enablement, endpoint, token, timeout, or identity invalidates obsolete queued synchronization. An old plan cannot start later batches or retries, and disabling synchronization does not delete either the local semantic index or already mirrored Companion data.
- Companion optionally exposes MCP reads and change proposals for one configured Vault using a separate MCP token. Clients can retrieve mirrored content and queue proposals while Obsidian is closed. Proposals contain Markdown stored on Companion, including on a remote server; they trigger no embeddings or Qdrant operations. Only explicit approval in Obsidian allows the plugin to write a note. Semantic search sends the query to the configured Companion embedding provider.
- Writing, batch, and audit operations send the content required for the requested action to the configured language-model provider.
- Clipboard insertion writes generated output to the system clipboard.

> A locally stored vector index does not automatically make remote-provider requests local. Review the selected provider's privacy policy, retention rules, limits, and pricing before sending sensitive notes.

## Semantic index behavior

The semantic index is designed to avoid unnecessary reprocessing.

- The first indexing run chunks selected Markdown notes and generates embeddings.
- Create and modify events are debounced and coalesced.
- File content is read at flush time so the latest saved version is indexed.
- Modify synchronization compares chunk metadata and content hashes.
- Unchanged chunks reuse existing vectors and are not embedded again.
- Delete removes every indexed chunk for that path without an embedding request.
- Rename deletes the old path and indexes the new path in one logical mutation.
- On startup, a compatible existing index is incrementally reconciled with changes made while Obsidian or the plugin was closed.
- A missing index is not created automatically.
- The index persists across plugin and Obsidian restarts.
- Changing only an API key does not change the embedding space and does not require a rebuild.
- Changing the provider, model, normalized endpoint, or vector dimensions can make the existing index incompatible and require **Rebuild the semantic index**.
- **Clear the semantic index** replaces the current compatible index with an empty compatible index.
- After Clear, automatic synchronization remains suspended across restarts until an explicit index or rebuild operation succeeds.
- **Rebuild the semantic index** explicitly removes semantic index artifacts and regenerates the full index after confirmation.
- Clear and rebuild affect only semantic index files. They never delete or modify Markdown notes.

## Commands

| Command | Purpose |
| --- | --- |
| **Semantic search** | Search the local vector index and open a grouped note result. |
| **Ask your Vault** | Retrieve current indexed source chunks and stream a cited answer from the configured language model. |
| **Find similar notes** | Compare the active indexed Markdown note with other indexed notes using existing local vectors. |
| **Find potential semantic duplicates** | Review conservative, highly similar note pairs; similarity is not proof of identity. |
| **Update the Vault semantic index** | Reconcile all eligible Markdown notes with the persistent semantic index. |
| **Update the current note in the semantic index** | Incrementally index the active Markdown note. |
| **Clear the semantic index** | Replace the current compatible semantic index with an empty one. |
| **Rebuild the semantic index** | Delete semantic index artifacts and regenerate the full index after confirmation. |
| **AI: Simple completion** | Continue text using the current editor context. |
| **AI: Smart completion (Vault)** | Continue text with additional vault context. |
| **AI: Process selection** | Transform the selected editor text with an AI prompt. |
| **AI: Generate Dataview** | Generate and insert a Dataview query. |
| **Generate flashcards for the current note** | Append flashcards for the active note. |
| **AI: Process multiple notes** | Open filtered batch processing. |
| **Split note into atomic notes** | Create atomic notes from the current note. |
| **Deep audit — choose mode** | Choose incremental Single, full Single, or Batch plus report. |
| **Analyze vault structure** | Create a vault structure dashboard and Canvas map. |
| **Generate MOCs from clusters** | Create MOC notes from the latest saved audit clusters. |

## Architecture

```text
Markdown notes
    ↓
Markdown-aware chunker
    ↓
Embedding provider
    ↓
Local persistent vector store
    ↓
Chunk search + document representations
    ├─ Semantic Search / Similar Notes / Duplicate Candidates
    └─ Ask your Vault context reconstruction + budget
           ↓
       Configured language model
           ↓
       Streamed answer + trusted source cards
```

Stable chunk hashes drive incremental deltas so unchanged chunks are reused.

An optional standalone [Companion service](companion/README.md) receives versioned JSON over HTTP(S) after local semantic commits. Snapshot capture reuses the committed vectors and releases the semantic barrier before network I/O. Deterministic manifest reconciliation avoids retransmitting unchanged Markdown or embeddings and repairs events missed while either process was offline.

Companion exposes an opt-in [MCP endpoint](companion/README.md#mcp) for bounded retrieval, semantic search and [change proposals](companion/README.md#safe-change-proposals). Its separate MCP credential cannot claim or apply proposals, acknowledge application, or synchronize the mirror. The plugin remains the only authoritative Vault writer.

A debounced event coordinator coalesces Markdown path changes, while startup reconciliation catches offline changes. Manual and automatic indexing share one mutation queue. Rename batches reach the vector store as one durable mutation.

The vector store uses guarded temporary-file replacement, backup-aware recovery, and one shared store per semantic index path in the plugin runtime. Document discovery reads a defensive committed snapshot from that same store.

Clear and rebuild are explicit operations and do not modify source notes.

## Current limitations

- The initial semantic index, Clear, and Rebuild remain explicit user operations.
- Ask your Vault is a one-shot question flow; it does not keep a multi-turn conversation history.
- Automatic synchronization covers Markdown notes only; attachments, Canvas files, images, and other file types are ignored.
- The vector store does not use an ANN or HNSW index.
- Companion is a self-hosted mirror with optional MCP reads and proposals scoped to one configured Vault. It provides no dashboard, accounts, OAuth server, TLS termination, or direct Vault writes. Semantic retrieval uses SQLite or the optional Qdrant accelerator.
- Companion requires Node.js 24 or newer and uses Node's built-in SQLite API, which Node 24 currently labels experimental.
- Obsidian `requestUrl` cannot physically cancel a transport already handed off. Timeout, abort, disable, or configuration invalidation prevents subsequent queued requests, plan-to-batch transitions, batches, and retries, but the already-started HTTP transport may still finish.
- Similarity search performs a local linear scan and is intended for small and medium personal vaults.
- Similar Notes represents a document as the normalized mean of its chunk vectors; broad or multi-topic notes may therefore receive less intuitive rankings.
- Potential duplicate detection compares exact document-vector pairs in quadratic time and is intended for small and medium personal vaults.
- Duplicate detection does not run LLM verification and never merges, links, edits, or deletes notes.
- Very short notes are excluded from document discovery to reduce high-similarity false positives.
- Semantic similarity indicates related meaning or overlap, not factual equivalence or duplicate identity.
- Search quality depends on the selected embedding model and the language and structure of the notes.
- Remote embedding providers may impose request limits, data-retention policies, or costs.
- Changing the embedding space requires an explicit index rebuild.

## Development

```bash
npm install
npm test
npm run build
npx tsc --noEmit --module ES2020 --ignoreDeprecations 5.0
```

The TypeScript command includes the module and deprecation overrides required by the current project configuration.

## Contributing

Issues, bug reports, feature ideas, and pull requests are welcome.

If you find Vault Audit AI useful, consider [starring the repository](https://github.com/zinverno/obsidian-ai-hub). It helps more Obsidian users discover the project.

## License

[MIT](LICENSE) © 2026 Zinvernix
