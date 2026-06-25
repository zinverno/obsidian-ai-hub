# Vault Audit AI

**AI-powered audit and maintenance for your Obsidian vault.** Find orphan notes, cluster topics, get tag and link recommendations, and batch-process hundreds of notes — using any LLM provider: OpenRouter, OpenAI, Groq, or fully local via Ollama.

Most AI plugins help you *write*. This one helps you keep a large vault *healthy*.

## Why this plugin

Vaults rot. After a year of daily notes you end up with orphan notes nobody links to, duplicated topics under different tags, and clusters of related ideas that never got connected. Graph view shows you the mess; this plugin actually analyzes it and tells you what to do.

## Features

### 🔬 Deep vault audit
A two-phase MapReduce analysis of your entire vault:

- **Orphan detection** — notes with no incoming or outgoing links
- **Topic clustering** — related notes grouped by theme, exported as a Canvas map
- **Tag & link recommendations** — what to connect and how to label it
- **Markdown reports** with Dataview embeds and direct links to every mentioned note
- **Incremental indexing** — analysis results are cached; re-runs only process changed notes, saving tokens and time

### ⚡ Batch processing
Filter notes by folder, tags, or date range — then apply an action to all of them at once: improve style, summarize, auto-tag, add examples, fix grammar, or run your own custom prompt.

### ✍️ Inline AI assistance
Generate and insert text via the context menu or hotkeys; analyze, expand, shorten, or rephrase selections; generate Dataview queries. Responses stream in real time with loop detection and abort handling.

### 🔌 Providers
- **OpenRouter** — 100+ models; built-in button fetches the live list of currently available free models
- **Ollama** — fully local, nothing leaves your machine
- **OpenAI** — GPT-4o, o1 and others
- **Groq** — fast free inference
- **Custom** — any OpenAI-compatible API

## Privacy & behavior disclosure

- To build the audit index, the plugin enumerates the files in your vault and sends **note content to the LLM provider you configured** (or to a local Ollama instance — in that case nothing leaves your machine).
- Nothing is sent anywhere until you explicitly run an action.
- The "copy to clipboard" insertion mode writes AI output to your system clipboard.
- API keys are stored in Obsidian's standard plugin settings on your device.

## Installation

### From the community catalog
Settings → Community plugins → Browse → search for **Vault Audit AI** → Install.

### From source
```bash
git clone https://github.com/zinverno/obsidian-ai-hub
cd obsidian-ai-hub
npm install
npm run build
```
Copy `main.js`, `manifest.json` and `styles.css` into `<your-vault>/.obsidian/plugins/ai-knowledge-hub/`, then enable the plugin.

## Quick start

1. Open plugin settings, pick a provider (Groq and OpenRouter have free tiers; Ollama is free and local).
2. Paste an API key (not needed for Ollama) and press **Test connection**.
3. Run the deep audit from the command palette, or open the control panel for batch processing.

> **Note:** the plugin UI is currently in Russian; an English localization is planned.

---

# Vault Audit AI (на русском)

**ИИ-аудит и обслуживание вашего хранилища Obsidian.** Поиск заметок-сирот, кластеризация тем, рекомендации тегов и связей, пакетная обработка сотен заметок — через любого провайдера: OpenRouter, OpenAI, Groq или локально через Ollama.

## Возможности

- **Глубокий аудит**: двухфазный MapReduce-анализ всего хранилища — сироты, кластеры тем, рекомендации связей, отчёты с Dataview и Canvas-картой
- **Инкрементальный индекс**: повторный аудит обрабатывает только изменённые заметки
- **Пакетная обработка**: фильтры по папке/тегам/датам + действие над всеми заметками сразу (стиль, суммаризация, авто-теги, свой промпт)
- **Работа с текстом**: генерация и обработка выделения из контекстного меню, потоковый вывод, генерация Dataview-запросов
- **Провайдеры**: OpenRouter (с живым списком бесплатных моделей), Ollama (полностью локально), OpenAI, Groq, любой совместимый API

## Приватность

Для аудита плагин перечисляет файлы хранилища и отправляет содержимое заметок выбранному вами провайдеру (при использовании Ollama данные не покидают ваш компьютер). Ничего не отправляется без явного запуска действия. Режим вставки «в буфер обмена» пишет результат в системный буфер.

## Лицензия / License

MIT © 2026 Zinvernix