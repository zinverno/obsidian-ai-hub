# Vault Audit AI

Vault Audit AI is an Obsidian Community Plugin for auditing, maintaining, and transforming an Obsidian vault with configurable AI providers. It can analyze vault structure, assist with note writing, build a persistent local vector index, and search Markdown notes by meaning.

**Version:** 1.5.0 · **Requires Obsidian:** 1.8.7 or later · **License:** [MIT](LICENSE)

## Overview

Vault Audit AI helps you:

- analyze the structure and quality of an Obsidian vault;
- improve or transform individual notes and selected text with AI;
- run deep audits that identify clusters, orphan notes, and structural issues;
- build a local semantic vector index from Markdown notes;
- find related notes by meaning rather than exact keywords.

Semantic features are opt-in and disabled by default. Indexing is manual in version 1.5.0.

## Features

### Semantic search

- Markdown-aware chunking that preserves heading context and source locations.
- A persistent vector index stored locally in the plugin directory.
- Chunk-level incremental indexing based on stable content and metadata hashes.
- Manual full-vault reconciliation through the command palette.
- Manual indexing of the current Markdown note.
- Search results grouped by note, with the strongest matching sections shown first.
- Exact vault-relative paths for opening the selected note.
- Best-effort navigation to the most relevant source section.
- Explicit clear and rebuild operations with confirmation.
- Compatibility detection when the embedding provider, model, endpoint, or vector dimensions change.

Automatic indexing on vault file events is not implemented.

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
- When OpenRouter or another remote embedding API is selected, note chunks are sent to that endpoint while indexing, and semantic search queries are sent to it for embedding.
- Ollama allows embedding generation to remain local when it is connected to a local Ollama instance.
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

## Semantic index behavior

- The first indexing run chunks the selected Markdown notes and generates embeddings.
- Later runs compare chunk metadata and content hashes; unchanged chunks are not embedded again.
- The index persists across plugin and Obsidian restarts.
- Changing only an API key does not change the embedding space and does not require a rebuild.
- Changing the provider, model, normalized endpoint, or vector dimensions can make the existing index incompatible and require **Rebuild the semantic index**.
- **Clear the semantic index** replaces the current compatible index with an empty compatible index.
- **Rebuild the semantic index** explicitly removes semantic index artifacts and regenerates the full index after confirmation.
- Clear and rebuild affect only semantic index files. They never delete or modify Markdown notes.

## Commands

| Command | Purpose |
| --- | --- |
| **Semantic search** | Search the local vector index and open a grouped note result. |
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

- Semantic indexing is manual in version 1.5.0.
- Automatic synchronization for vault create, modify, delete, and rename events is not included yet.
- The vector store does not use an ANN or HNSW index.
- Similarity search performs a local linear scan and is intended for small and medium personal vaults.
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
Semantic search
    ↓
Grouped note results
```

Stable chunk hashes drive incremental deltas so unchanged chunks are reused. The vector store uses guarded temporary-file replacement, backup-aware recovery, and one shared store per semantic index path in the plugin runtime. Clear and rebuild are explicit operations that do not modify source notes.

## License

[MIT](LICENSE) © 2026 Zinvernix
