# Vault Audit AI

Vault Audit AI is an Obsidian Community Plugin for auditing, maintaining, and transforming an Obsidian vault with configurable AI providers. It can analyze vault structure, assist with note writing, build a persistent local vector index, and search Markdown notes by meaning.

**Version:** 1.5.0 · **Requires Obsidian:** 1.8.7 or later · **License:** [MIT](LICENSE)

## Overview

Vault Audit AI helps you:

- analyze the structure and quality of an Obsidian vault;
- improve or transform individual notes and selected text with AI;
- run deep audits that identify clusters, orphan notes, and structural issues;
- build a local semantic vector index from Markdown notes;
- find related notes by meaning rather than exact keywords;
- discover notes similar to the active note and review highly similar pairs.

Semantic features are opt-in and disabled by default. The first semantic index is built only after an explicit user action; once it exists, ordinary Markdown changes are synchronized automatically.

## Features

### Semantic search

- Markdown-aware chunking that preserves heading context and source locations.
- A persistent vector index stored locally in the plugin directory.
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

- **Find similar notes** builds a document representation for the active indexed Markdown note and ranks other indexed notes by document-level cosine similarity.
- **Find potential semantic duplicates** conservatively reports highly similar note pairs. A reported pair is a review candidate, not proof that the notes are identical or safe to merge.
- Both commands reuse vectors already stored in the existing local semantic index. They do not embed the active note again and do not call the embedding provider while comparing notes.
- Results include exact vault paths and the strongest matching indexed sections for navigation.
- Empty and near-empty notes are excluded with a deterministic minimum-content rule to reduce false positives.

### AI writing tools

- Simple text continuation.
- Vault-aware text continuation.
- Selected-text processing.
- Dataview query generation.
- Flashcard generation for the current note.
- Note atomization into separate atomic notes.
- Batch processing with folder, tag, and date filters.

Batch actions include style improvement, examples, summarization, automatic tags, conclusions, grammar correction, flashcards, and a custom prompt.

### Vault audit

- Vault structure analysis with orphan detection, folder and tag statistics, a Markdown dashboard, and a Canvas map.
- Deep MapReduce-style audit with note summaries, thematic clustering, quality analysis, global findings, and an action plan.
- Incremental Single audit mode that processes one note per request and can skip notes whose cached source has not changed.
- Full Single audit mode for explicitly reprocessing every eligible note.
- MOC generation from saved audit clusters.

## Supported providers

### Language models

- OpenRouter
- Ollama
- OpenAI
- Groq
- Custom OpenAI-compatible endpoints

Language-model actions send their configured context to the selected provider. Ollama can run these requests locally when it is connected to a local Ollama instance.

### Embeddings

- OpenRouter
- Ollama
- OpenAI-compatible APIs, including the official OpenAI endpoint

The default OpenRouter example is `openai/text-embedding-3-small`. Model availability and pricing are controlled by the provider and can change; the plugin does not guarantee that any remote embedding model remains free or available.

## Privacy and data flow

- Plugin settings and API keys are saved locally through Obsidian plugin data storage.
- Semantic features are opt-in and disabled by default.
- The semantic vector index is stored in `.obsidian/plugins/ai-knowledge-hub/semantic-index/` inside the vault configuration directory.
- The plugin does not upload stored vectors or their index metadata.
- When OpenRouter or another remote embedding API is selected, note chunks are sent to that endpoint during the initial index and later automatic synchronization of changed chunks; semantic search queries are also sent to it for embedding.
- Similar Notes and potential duplicate detection operate only on vectors already present in the local index and make no embedding-provider request for comparison.
- Ollama allows embedding generation to remain local when it is connected to a local Ollama instance.
- Automatic semantic synchronization never edits Markdown files. It reads the latest Markdown content and changes only the local vector index.
- Writing, batch, and audit operations send the content required for the requested action to the configured language-model provider.
- Clipboard insertion writes generated output to the system clipboard.

Review the selected provider privacy policy, retention rules, limits, and pricing before sending sensitive notes. Local index storage does not make remote-provider requests local.

## Installation

### Obsidian Community Plugins

1. Open **Settings → Community plugins**.
2. Select **Browse** and search for **Vault Audit AI**.
3. Select **Install**, then **Enable**.

### Manual installation from a GitHub Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub Release](https://github.com/zinverno/obsidian-ai-hub/releases).
2. Create `<your-vault>/.obsidian/plugins/ai-knowledge-hub/`.
3. Copy the three release assets into that directory.
4. Reload Obsidian and enable **Vault Audit AI** under **Community plugins**.

Do not copy the source TypeScript files into the plugin directory.

## Semantic search setup

1. Open the plugin settings and enable **Enable semantic features**.
2. Select an embedding provider.
3. Configure the model, Base URL, and API key when required.
4. Select **Test embeddings** to test the connection.
5. Run **Update the Vault semantic index** from the command palette.
6. Open **Semantic search** from the command palette.

After the active note is indexed, **Find similar notes** can compare it with the rest of the index. **Find potential semantic duplicates** scans the existing document representations without re-embedding the vault.

Step 5 is intentionally explicit and is never started automatically. After it succeeds, normal Markdown edits are synchronized in the background without a Notice for each successful update.

## Semantic index behavior

- The first indexing run chunks the selected Markdown notes and generates embeddings.
- Create and modify events are debounced and coalesced; file content is read at flush time so the latest saved version is indexed.
- Modify synchronization compares chunk metadata and content hashes; unchanged chunks are not embedded again.
- Delete removes every indexed chunk for that path without an embedding request. Rename deletes the old path and indexes the new path in one logical mutation.
- On startup, a compatible existing index is incrementally reconciled with changes made while Obsidian or the plugin was closed. A missing index is not created automatically.
- The index persists across plugin and Obsidian restarts.
- Changing only an API key does not change the embedding space and does not require a rebuild.
- Changing the provider, model, normalized endpoint, or vector dimensions can make the existing index incompatible and require **Rebuild the semantic index**.
- **Clear the semantic index** replaces the current compatible index with an empty compatible index.
- After Clear, automatic synchronization remains suspended across restarts until an explicit index or rebuild operation succeeds, so queued file events cannot repopulate the cleared index.
- **Rebuild the semantic index** explicitly removes semantic index artifacts and regenerates the full index after confirmation.
- Clear and rebuild affect only semantic index files. They never delete or modify Markdown notes.

## Commands

| Command | Purpose |
| --- | --- |
| **Semantic search** | Search the local vector index and open a grouped note result. |
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

## Current limitations

- The initial semantic index, Clear, and Rebuild remain explicit user operations.
- Automatic synchronization covers Markdown notes only; attachments, Canvas files, images, and other file types are ignored.
- The vector store does not use an ANN or HNSW index.
- Similarity search performs a local linear scan and is intended for small and medium personal vaults.
- Similar Notes represents a document as the normalized mean of its chunk vectors; broad or multi-topic notes may therefore receive less intuitive rankings.
- Potential duplicate detection compares exact document-vector pairs in quadratic time and is intended for small and medium personal vaults. It does not run LLM verification and never merges, links, edits, or deletes notes.
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
    ↓
Grouped search, Similar Notes, and potential duplicate pairs
```

Stable chunk hashes drive incremental deltas so unchanged chunks are reused. A debounced event coordinator coalesces Markdown path changes, while startup reconciliation catches offline changes. Manual and automatic indexing share one mutation queue; rename batches reach the vector store as one durable mutation. The vector store uses guarded temporary-file replacement, backup-aware recovery, and one shared store per semantic index path in the plugin runtime. Document discovery reads one defensive committed snapshot from that same store. Clear and rebuild are explicit operations that do not modify source notes.

## License

[MIT](LICENSE) © 2026 Zinvernix
