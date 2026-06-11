# Obsidian AI Hub

**AI Hub for Obsidian** is a plugin for Obsidian that integrates the capabilities of Large Language Models (LLM) directly into your knowledge base. It supports many providers (OpenRouter, Ollama, OpenAI, Groq, etc.) and provides powerful tools for working with notes: from text generation to deep auditing of the entire knowledge base.

## Features

### Main functions
- **Text generation**: Inserting AI content into notes via the context menu or keyboard shortcuts
- **Selection work**: analysis, expansion, reduction and reformulation of the selected text
- **Batch processing**: automatic processing of multiple notes at the same time
- **Deep knowledge base audit**:
- Two-phase MapReduce -analysis of all notes
- Identification of orphan notes
- Recommendations on tags and links
- Clustering by topic
  - Reports in Markdown format with Dataview inserts and links to notes
- **Indexing notes**: caching analysis results for fast incremental auditing — only modified notes are re-processed
- **Streaming**: Displaying AI responses in real time

### Supported Providers
- **OpenRouter** — 100+ models, including free ones
- **Ollama** — local models
- **OpenAI** — GPT-4o, o1, o3-mini and others
- **Groq** — fast inference models
- **Custom** — any compatible API

## Installation

### Option 1: Build from source

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd obsidian-ai-hub
   ```

2. Install the dependencies:
``bash
   npm install
   ```

3. Build the plugin:
``bash
   npm run build
   ```

4. Copy the files `main.js ` and `manifest.json` to the Obsidian plugin folder
   (the styles are embedded in the `main.js`, no separate css file required):
``
   <your-storage-Obsidian>/.obsidian/plugins/obsidian-ai-hub/
   ```

### Option 2: Development Mode

For automatic reassembly when changing the code:
``bash
npm run dev
```

## Privacy

The AI Hub sends the contents of the note (or a selected fragment) to the server
of the provider you selected in the settings — OpenRouter, OpenAI or
Groq. This data is processed according to the privacy policy of this service.

If you use **Ollama**, everything works locally on your computer —
nothing goes outside.

The API key and index of notes are stored locally in your storage and
are not transferred anywhere.

## Setting up

1. Open **Settings → Community plugins → AI Hub**
2. Select a provider (OpenRouter, Ollama, OpenAI, Groq or Custom)
3. Enter the API key (if required)
4. Specify the model (for example, `google/gemma-2-9b-it:free` for OpenRouter)
5. Configure the settings:
   - **Temperature** (0.0–1.0) — creativity of responses
   - **Base URL** — API address (by default, it is substituted for the selected provider)

## Usage

### Text generation
1. Open any note
2. Place the cursor in the desired location or select the text.
3. Open AI via the context menu (right click → **AI Hub**) or the command palette (`Ctrl/Cmd + P`)

### Deep audit
1. Run the command **"AI Hub: Deep Audit Vault"**
2. Wait for the analysis to complete (progress is displayed in the modal window)
3. Receive a report with recommendations for improving the knowledge base

### Batch processing
1. Select several notes
2. Run the batch command
3. AI will process all selected notes based on the preset settings.

## Technical Details

### Project structure
```
obsidian-ai-hub/
├── main.ts # The main plugin file
─── api.ts # Working with LLM providers' API
├── constants.ts # Constants and Provider Configurations
├── settings.ts # Plugin Settings
├── deepAudit.ts # Deep Audit Engine
├── noteIndex.ts # Indexing notes
├── style.css # Styles (reserved; styles are currently embedded in main.ts)
├── manifest.json # Manifest of the Obsidian plugin
└── package.json # Node dependencies.js
```

### Requirements
- **Obsidian** v1.4.0+
- **Node.js** v18+
- **TypeScript** v5.3.3

### Dependencies
- 'esbuild' — quick TypeScript build
- `obsidian' — Obsidian types and APIs
- `typescript' — compilation of TS

## License

MIT — for more information, see the [LICENSE](LICENSE) file.

## Contribution to the project

Pull requests, bug reports, and suggestions for improvement are accepted!

---

**Made with ❤️ for the Obsidian community**