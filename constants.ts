import { InsertionType } from "./settings";

// ─────────────────────────────────────────────────────────────────────
//  ПРОВАЙДЕРЫ LLM
// ─────────────────────────────────────────────────────────────────────

export type LLMProvider =
  | "openrouter"
  | "ollama"
  | "openai"
  | "groq"
  | "custom";

export interface ProviderProfile {
  id: LLMProvider;
  label: string;
  /** Lucide icon name */
  icon: string;
  description: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  defaultModel: string;
  modelPlaceholder: string;
  apiKeyPlaceholder: string;
  /** Prefix for validation (e.g. 'sk-or-v1-') */
  apiKeyPrefix?: string;
  popularModels: Array<{ id: string; label: string; tag?: string }>;
  /** OpenRouter-specific parameter */
  supportsRepetitionPenalty: boolean;
}

export const PROVIDER_PROFILES: Record<LLMProvider, ProviderProfile> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    icon: "globe",
    description: "100+ моделей, есть бесплатные",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    defaultModel: "google/gemma-2-9b-it:free",
    modelPlaceholder: "google/gemma-2-9b-it:free",
    apiKeyPlaceholder: "sk-or-v1-...",
    apiKeyPrefix: "sk-or-v1-",
    popularModels: [
      { id: "google/gemma-2-9b-it:free", label: "Gemma 2 9B", tag: "Free" },
      {
        id: "meta-llama/llama-3.2-3b-instruct:free",
        label: "Llama 3.2 3B",
        tag: "Free",
      },
      {
        id: "mistralai/mistral-7b-instruct:free",
        label: "Mistral 7B",
        tag: "Free",
      },
      {
        id: "google/gemini-flash-1.5",
        label: "Gemini Flash 1.5",
        tag: "Платная",
      },
      {
        id: "anthropic/claude-3.5-sonnet",
        label: "Claude 3.5 Sonnet",
        tag: "Платная",
      },
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini", tag: "Платная" },
    ],
    supportsRepetitionPenalty: true,
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    icon: "cpu",
    description: "Локально, приватно, бесплатно",
    defaultBaseUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    defaultModel: "llama3.2",
    modelPlaceholder: "llama3.2",
    apiKeyPlaceholder: "ollama",
    popularModels: [
      { id: "llama3.2", label: "Llama 3.2 3B", tag: "2 GB" },
      { id: "llama3.1", label: "Llama 3.1 8B", tag: "5 GB" },
      { id: "gemma2", label: "Gemma 2 9B", tag: "5 GB" },
      { id: "mistral", label: "Mistral 7B", tag: "4 GB" },
      { id: "qwen2.5", label: "Qwen 2.5 7B", tag: "4 GB" },
      { id: "phi4", label: "Phi-4 14B", tag: "9 GB" },
    ],
    supportsRepetitionPenalty: false,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    icon: "sparkles",
    description: "GPT-4o, o1 и другие",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    defaultModel: "gpt-4o-mini",
    modelPlaceholder: "gpt-4o-mini",
    apiKeyPlaceholder: "sk-...",
    apiKeyPrefix: "sk-",
    popularModels: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", tag: "Быстрый" },
      { id: "gpt-4o", label: "GPT-4o", tag: "Мощный" },
      { id: "o1-mini", label: "o1-mini", tag: "Мыслит" },
      { id: "o3-mini", label: "o3-mini", tag: "Новый" },
    ],
    supportsRepetitionPenalty: false,
  },
  groq: {
    id: "groq",
    label: "Groq",
    icon: "zap",
    description: "Сверхбыстрый inference",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    requiresApiKey: true,
    defaultModel: "llama-3.1-8b-instant",
    modelPlaceholder: "llama-3.1-8b-instant",
    apiKeyPlaceholder: "gsk_...",
    apiKeyPrefix: "gsk_",
    popularModels: [
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", tag: "Быстрый" },
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", tag: "Мощный" },
      { id: "gemma2-9b-it", label: "Gemma 2 9B", tag: "Быстрый" },
      { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B", tag: "32k ctx" },
    ],
    supportsRepetitionPenalty: false,
  },
  custom: {
    id: "custom",
    label: "Свой API",
    icon: "settings-2",
    description: "Любой OpenAI-совместимый",
    defaultBaseUrl: "",
    requiresApiKey: false,
    defaultModel: "",
    modelPlaceholder: "model-name",
    apiKeyPlaceholder: "API ключ (если нужен)",
    popularModels: [],
    supportsRepetitionPenalty: false,
  },
};

export const API_TIMEOUT_MS = 30_000; // таймаут для non-stream запросов
export const STREAM_TIMEOUT_MS = 120_000; // таймаут для стриминга (2 мин)
export const VAULT_SNAPSHOT_MAX_CHARS = 300_000;
export const STREAM_CONTEXT_MAX_CHARS = 50_000;
export const BATCH_DELAY_MS = 1_500;

// Лимиты токенов для разных сценариев
export const MAX_TOKENS_STREAM = 2000; // вставка в редактор
export const MAX_TOKENS_BATCH = 1500; // пакетная обработка
export const MAX_TOKENS_AUDIT = 3000; // аудит хранилища
export const MAX_TOKENS_DATAVIEW = 400; // генерация dataview

// Защита от repetition loop
export const REPETITION_WINDOW = 200; // символов для проверки
export const REPETITION_THRESHOLD = 3; // сколько раз подряд = петля

export const INSERTION_OPTIONS: InsertionType[] = [
  "end",
  "beginning",
  "replace",
  "after",
  "new",
  "clipboard",
  "cursor",
];

export const SELECTION_INSERTION_OPTIONS: InsertionType[] = [
  "replace",
  "after",
  "new",
  "clipboard",
];

export const INSERTION_ICONS: Record<InsertionType, string> = {
  end: "arrow-down-to-line",
  beginning: "arrow-up-to-line",
  replace: "pen",
  after: "plus",
  new: "file-plus",
  clipboard: "clipboard",
  cursor: "mouse-pointer-click",
};

export const INSERTION_LABELS: Record<InsertionType, string> = {
  end: "В конец",
  beginning: "В начало",
  replace: "Вместо выделения",
  after: "После выделения",
  new: "В новую заметку",
  clipboard: "В буфер",
  cursor: "В позицию курсора",
};

export interface BatchPreset {
  icon: string;
  title: string;
  desc: string;
  prompt: string;
}

export const BATCH_PRESETS: BatchPreset[] = [
  {
    icon: "sparkles",
    title: "Улучшить стиль",
    desc: "Читабельность",
    prompt: "Улучши читабельность и стиль текста, сохранив смысл.",
  },
  {
    icon: "lightbulb",
    title: "Добавить примеры",
    desc: "Практика",
    prompt: "Добавь 1-2 практических примера к основным идеям.",
  },
  {
    icon: "scissors",
    title: "Суммаризация",
    desc: "Сократить",
    prompt: "Сократи текст примерно на 30%, сохранив ключевые мысли.",
  },
  {
    icon: "tag",
    title: "Авто-теги",
    desc: "3-5 тегов",
    prompt:
      "Проанализируй текст и добавь 3-5 релевантных тегов в формате #tag в начало.",
  },
  {
    icon: "align-left",
    title: "Добавить итог",
    desc: "Вывод",
    prompt: 'Добавь в конце раздел "## Итог" с кратким выводом.',
  },
  {
    icon: "check-circle",
    title: "Исправить ошибки",
    desc: "Грамматика",
    prompt: "Исправь грамматику и пунктуацию, не меняя смысл.",
  },
];
