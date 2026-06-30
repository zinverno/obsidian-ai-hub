import { t as tr, setLanguage, AIHubLang } from "./i18n";
import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import AIHubPlugin from "./main";
import { LLMProvider, PROVIDER_PROFILES } from "./constants";
import {
  testConnection,
  fetchOllamaModels,
  fetchOpenRouterFreeModels,
} from "./api";

export type InsertionType =
  | "end"
  | "beginning"
  | "replace"
  | "after"
  | "new"
  | "clipboard"
  | "cursor";

export interface AIHubSettings {
  // ── Провайдер ─────────────────────────────────────────────────────
  provider: LLMProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  topK: number;
  // ── Вставка ───────────────────────────────────────────────────────
  defaultInsertion: InsertionType;
  newNoteFolder: string;
  filenameTemplate: string;
  // ── Интерфейс ─────────────────────────────────────────────────────
  showContextMenu: boolean;
  notifyOnCopy: boolean;
  language: AIHubLang;
  // ── Глубокий аудит ────────────────────────────────────────────────
  deepAudit: {
    batchSize: number;
    maxConcurrent: number;
    delayMs: number;
  };
}

export const DEFAULT_SETTINGS: AIHubSettings = {
  provider: "openrouter",
  apiKey: "",
  model: "google/gemma-2-9b-it:free",
  baseUrl: "https://openrouter.ai/api/v1",
  temperature: 0.65,
  topK: 12,
  defaultInsertion: "end",
  newNoteFolder: "",
  filenameTemplate: "AI-{{date}}-{{topic}}",
  showContextMenu: true,
  notifyOnCopy: true,
  language: "auto",
  deepAudit: {
    batchSize: 5,
    maxConcurrent: 3,
    delayMs: 1000,
  },
};

// ─────────────────────────────────────────────────────────────────────
export class AIHubSettingTab extends PluginSettingTab {
  plugin: AIHubPlugin;
  private dynamicSection: HTMLElement | null = null;

  constructor(app: App, plugin: AIHubPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ── Утилиты ─────────────────────────────────────────────────────────
  private addIcon(setting: Setting, icon: string) {
    const el = setting.nameEl.createSpan({ cls: "ai-setting-icon" });
    setIcon(el, icon);
    setting.nameEl.prepend(el);
  }

  private addHeading(text: string, icon: string) {
    const wrapper = this.containerEl.createDiv({ cls: "ai-hub-section-head" });
    const iconWrap = wrapper.createSpan({ cls: "ai-hub-section-icon" });
    setIcon(iconWrap, icon);
    wrapper.createDiv({ text, cls: "ai-hub-section-label" });
  }

  // ── Главный render ───────────────────────────────────────────────────
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const save = async () => this.plugin.saveSettings();

    // Hero
    const hero = containerEl.createDiv({ cls: "ai-hub-hero" });
    const heroIcon = hero.createDiv({ cls: "ai-hub-hero-icon" });
    setIcon(heroIcon, "brain");
    const heroText = hero.createDiv();
    heroText.createDiv({ text: "Vault Audit Ai", cls: "ai-hub-hero-title" });
    heroText.createDiv({
      text: tr("Настройки плагина"),
      cls: "ai-hub-hero-sub",
    });

    // ── Секция: провайдер ──────────────────────────────────────────────
    this.addHeading(tr("Языковая модель"), "cpu");
    this.renderProviderCards(containerEl, save);

    // ── Динамическая секция (поля для выбранного провайдера) ───────────
    this.dynamicSection = containerEl.createDiv();
    this.renderDynamicSection(save);

    containerEl.createEl("hr", { cls: "ai-hub-settings-separator" });

    // ── Секция: глубокий аудит ─────────────────────────────────────────
    this.addHeading(tr("Глубокий аудит"), "microscope");
    this.renderDeepAuditSection(save);

    containerEl.createEl("hr", { cls: "ai-hub-settings-separator" });

    // ── Секция: вставка ────────────────────────────────────────────────
    this.addHeading(tr("Вставка ответа"), "arrow-down-to-line");
    this.renderInsertionSection(save);

    containerEl.createEl("hr", { cls: "ai-hub-settings-separator" });

    // ── Секция: интерфейс ──────────────────────────────────────────────
    this.addHeading(tr("Интерфейс"), "layout-dashboard");

    new Setting(this.containerEl)
      .setName(tr(tr("Язык интерфейса / Language")))
      .setDesc(
        tr(
          tr("Auto — как в Obsidian. Имена команд обновятся после перезагрузки плагина."),
        ),
      )
      .addDropdown((d) => {
        d.addOption("auto", "Auto")
          .addOption("en", "English")
          .addOption("ru", "Русский")
          .setValue(this.plugin.settings.language ?? "auto")
          .onChange((v) => {
            this.plugin.settings.language = v as AIHubLang;
            setLanguage(v as AIHubLang);
            void save();
            this.display();
          });
      });

    this.renderInterfaceSection(save);
  }

  // ── Карточки провайдеров ─────────────────────────────────────────────
  private renderProviderCards(
    container: HTMLElement,
    save: () => Promise<void>,
  ) {
    const grid = container.createDiv({ cls: "ai-hub-provider-grid" });

    const providers: LLMProvider[] = [
      "openrouter",
      "ollama",
      "openai",
      "groq",
      "custom",
    ];
    const cards: Map<LLMProvider, HTMLElement> = new Map();

    const setActive = (p: LLMProvider) => {
      cards.forEach((card, id) => {
        card.toggleClass("ai-hub-active", id === p);
      });
    };

    for (const p of providers) {
      const profile = PROVIDER_PROFILES[p];
      const card = grid.createDiv({ cls: "ai-hub-provider-card" });
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", tr("Провайдер: {p}", { p: profile.label }));
      cards.set(p, card);

      const iconWrap = card.createDiv({ cls: "ai-hub-provider-icon" });
      setIcon(iconWrap, profile.icon);

      card.createDiv({ text: tr(profile.label), cls: "ai-hub-provider-name" });
      card.createDiv({
        text: tr(profile.description),
        cls: "ai-hub-provider-desc",
      });

      const onClick = async () => {
        this.plugin.settings.provider = p;
        this.plugin.settings.baseUrl = profile.defaultBaseUrl;
        if (profile.defaultModel) {
          this.plugin.settings.model = profile.defaultModel;
        }
        await save();
        setActive(p);
        this.renderDynamicSection(save);
      };

      card.addEventListener("click", () => void onClick());
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void onClick();
        }
      });
    }

    setActive(this.plugin.settings.provider);
  }

  // ── Динамическая секция ──────────────────────────────────────────────
  private renderDynamicSection(save: () => Promise<void>) {
    if (!this.dynamicSection) return;
    this.dynamicSection.empty();

    const provider = this.plugin.settings.provider;
    const profile = PROVIDER_PROFILES[provider];
    const el = this.dynamicSection;

    // ── Инфо-плашка ──────────────────────────────────────────────────
    const infoCard = el.createDiv({ cls: "ai-hub-info-card" });
    const infoTitle = (t: string) =>
      infoCard.createEl("strong", { text: t, cls: "ai-hub-info-title" });
    if (provider === "ollama") {
      infoTitle(tr("Ollama — локальный inference"));
      infoCard.createEl("br");
      infoCard.appendText(tr("Установи Ollama: "));
      infoCard.createEl("code", {
        text: "curl -fsSL https://ollama.com/install.sh | sh",
      });
      infoCard.createEl("br");
      infoCard.appendText(tr("Загрузи модель: "));
      infoCard.createEl("code", { text: "ollama pull llama3.2" });
    } else if (provider === "openrouter") {
      infoTitle(tr("OpenRouter — единый шлюз к 100+ моделям"));
      infoCard.createEl("br");
      infoCard.appendText(tr("API ключ: "));
      infoCard.createEl("a", {
        text: "openrouter.ai/keys",
        href: "https://openrouter.ai/keys",
      });
      infoCard.appendText(tr(" · Бесплатные модели доступны без баланса"));
    } else if (provider === "openai") {
      infoTitle("OpenAI API");
      infoCard.createEl("br");
      infoCard.appendText(tr("API ключ: "));
      infoCard.createEl("a", {
        text: "platform.openai.com/api-keys",
        href: "https://platform.openai.com/api-keys",
      });
    } else if (provider === "groq") {
      infoTitle(tr("Groq — бесплатный быстрый inference"));
      infoCard.createEl("br");
      infoCard.appendText(tr("API ключ: "));
      infoCard.createEl("a", {
        text: "console.groq.com/keys",
        href: "https://console.groq.com/keys",
      });
    } else {
      infoTitle(tr("Custom OpenAI-совместимый API"));
      infoCard.createEl("br");
      infoCard.appendText(
        tr("Укажи Base URL и при необходимости API ключ. Модель — как требует провайдер."),
      );
    }

    // ── API Key (только если нужен) ───────────────────────────────────
    if (profile.requiresApiKey || provider === "custom") {
      const keySetting = new Setting(el)
        .setName("API Key")
        .setDesc(
          profile.requiresApiKey
            ? tr("Хранится локально")
            : tr("Если требуется провайдером"),
        )
        .addText((t) => {
          t.inputEl.type = "password";
          t.inputEl.setAttribute("autocomplete", "off");
          t.setPlaceholder(profile.apiKeyPlaceholder)
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (v) => {
              this.plugin.settings.apiKey = v.trim();
              await save();
              updateKeyHint(v.trim());
            });

          const updateKeyHint = (val: string) => {
            el.querySelector(".ai-key-status")?.remove();
            if (!val || !profile.apiKeyPrefix) return;
            const hint = t.inputEl.parentElement?.createDiv({
              cls: "ai-key-status",
            });
            if (!hint) return;
            hint.addClass("ai-hub-key-hint");
            if (val.startsWith(profile.apiKeyPrefix) && val.length > 20) {
              hint.setCssProps({
                "--ai-status-color": "var(--color-green,#4caf50)",
              });
              hint.setText(tr("✓ Формат ключа корректен"));
            } else {
              hint.setCssProps({
                "--ai-status-color": "var(--text-warning,orange)",
              });
              hint.setText(tr("⚠ Формат ключа нестандартный"));
            }
          };
          updateKeyHint(this.plugin.settings.apiKey);
          return t;
        })
        .addButton((btn) => {
          let visible = false;
          btn
            .setIcon("eye")
            .setTooltip(tr("Показать/скрыть"))
            .onClick(() => {
              const input = el.querySelector<HTMLInputElement>(
                'input[type="password"],input[type="text"]',
              );
              if (!input) return;
              visible = !visible;
              input.type = visible ? "text" : "password";
              btn.setIcon(visible ? "eye-off" : "eye");
            });
        });
      this.addIcon(keySetting, "key");
    }

    // ── Модель + быстрый выбор ────────────────────────────────────────
    const modelSetting = new Setting(el)
      .setName(tr("Модель"))
      .setDesc(
        provider === "ollama"
          ? tr("Имя модели как в `ollama list`")
          : tr("ID модели провайдера"),
      )
      .addText((t) => {
        t.inputEl.setAttribute("aria-label", tr("Название модели"));
        t.setPlaceholder(profile.modelPlaceholder)
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await save();
          });
        return t;
      });
    this.addIcon(modelSetting, "bot");

    // Популярные модели
    const pickerRow = el.createDiv({ cls: "ai-hub-chip-row" });
    const addChip = (id: string, label: string, tag?: string) => {
      const chip = pickerRow.createEl("button", { cls: "ai-hub-model-chip" });
      chip.createSpan({ text: label });
      if (tag) {
        chip.createSpan({ text: tr(tag), cls: "ai-hub-model-chip-tag" });
      }
      chip.addEventListener("click", () => {
        this.plugin.settings.model = id;
        void save();
        const input = el.querySelector<HTMLInputElement>(
          `input[aria-label='${tr(tr("Название модели"))}']`,
        );
        if (input) {
          input.value = id;
        }
      });
    };
    for (const m of profile.popularModels) {
      addChip(m.id, m.label, m.tag);
    }

    // Живой список бесплатных моделей OpenRouter
    if (provider === "openrouter") {
      const freeRow = el.createDiv({ cls: "ai-hub-ollama-row" });
      const freeBtn = freeRow.createEl("button", { cls: "ai-hub-ollama-btn" });
      setIcon(freeBtn.createSpan(), "refresh-cw");
      freeBtn.createSpan({ text: " Показать актуальные бесплатные модели" });
      const freeStatus = freeRow.createDiv({ cls: "ai-hub-ollama-status" });

      freeBtn.addEventListener("click", () => {
        void (async () => {
          freeBtn.setAttribute("disabled", "true");
          freeStatus.setText(tr("Загружаю список с OpenRouter..."));
          try {
            const models = await fetchOpenRouterFreeModels();
            if (models.length === 0) {
              freeStatus.setCssProps({
                "--ai-status-color": "var(--text-warning,orange)",
              });
              freeStatus.setText(tr("⚠ Бесплатные модели не найдены"));
            } else {
              pickerRow.empty();
              for (const m of models) {
                const ctx =
                  m.context >= 1000
                    ? `${Math.round(m.context / 1000)}k`
                    : undefined;
                addChip(m.id, m.name, ctx);
              }
              freeStatus.setCssProps({
                "--ai-status-color": "var(--color-green,#4caf50)",
              });
              freeStatus.setText(
                tr("✓ Бесплатных моделей: {n} — кликни чип, чтобы выбрать", { n: models.length }),
              );
            }
          } catch (e) {
            freeStatus.setCssProps({
              "--ai-status-color": "var(--color-red,#f44336)",
            });
            freeStatus.setText(
              tr("✗ Ошибка: ") + (e instanceof Error ? e.message : String(e)),
            );
          }
          freeBtn.removeAttribute("disabled");
        })();
      });
    }

    // Загрузить модели Ollama
    if (provider === "ollama") {
      const ollamaRow = el.createDiv({ cls: "ai-hub-ollama-row" });
      const ollamaBtn = ollamaRow.createEl("button", {
        cls: "ai-hub-ollama-btn",
      });
      const ollamaIcon = ollamaBtn.createSpan();
      setIcon(ollamaIcon, "refresh-cw");
      ollamaBtn.createSpan({ text: tr("Загрузить доступные модели") });

      const ollamaStatus = ollamaRow.createDiv({ cls: "ai-hub-ollama-status" });

      ollamaBtn.addEventListener("click", () => {
        void (async () => {
        ollamaBtn.setAttribute("disabled", "true");
        ollamaStatus.setText(tr("Загрузка..."));
        try {
          const models = await fetchOllamaModels(this.plugin.settings.baseUrl);
          if (models.length === 0) {
            ollamaStatus.setCssProps({ "--ai-status-color": "var(--text-warning,orange)" });
            ollamaStatus.setText(
              tr("⚠ Ollama не найден или моделей нет. Запусти: ollama pull llama3.2"),
            );
          } else {
            ollamaStatus.setCssProps({ "--ai-status-color": "var(--color-green,#4caf50)" });
            ollamaStatus.setText(tr("✓ Найдено: {list}", { list: models.join(", ") }));
          }
        } catch (e) {
          ollamaStatus.setCssProps({ "--ai-status-color": "var(--color-red,#f44336)" });
          ollamaStatus.setText(
            tr("✗ Ошибка: ") + (e instanceof Error ? e.message : String(e)),
          );
        }
        ollamaBtn.removeAttribute("disabled");
        })();
      });
    }

    // ── Base URL ──────────────────────────────────────────────────────
    const urlSetting = new Setting(el)
      .setName("Base URL")
      .setDesc(
        provider === "custom"
          ? tr("URL вашего OpenAI-совместимого API")
          : tr("Автозаполнен, можно изменить"),
      )
      .addText((t) => {
        t.inputEl.setAttribute("aria-label", tr("Базовый URL API"));
        t.setPlaceholder(profile.defaultBaseUrl || "https://your-api/v1")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            this.plugin.settings.baseUrl = v.trim();
            await save();
          });
        return t;
      });
    this.addIcon(urlSetting, "link");

    // ── Temperature ───────────────────────────────────────────────────
    this.addIcon(
      new Setting(el)
        .setName("Temperature")
        .setDesc(tr("Креативность ответа: 0.0 = точно, 1.0 = творчески"))
        .addSlider((s) =>
          s
            .setLimits(0, 1, 0.05)
            .setValue(this.plugin.settings.temperature)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.temperature = v;
              await save();
            }),
        ),
      "thermometer",
    );

    // ── Тест соединения ───────────────────────────────────────────────
    const testRow = el.createDiv({ cls: "ai-hub-test-row" });

    const testBtn = testRow.createEl("button", { cls: "ai-hub-test-btn" });
    const testIcon = testBtn.createSpan();
    setIcon(testIcon, "plug");
    testBtn.createSpan({ text: tr("Проверить соединение") });

    const testStatus = testRow.createDiv({ cls: "ai-hub-conn-status" });

    testBtn.addEventListener("click", () => {
      void (async () => {
      testBtn.setAttribute("disabled", "true");
      testStatus.setCssProps({ "--ai-status-color": "var(--text-muted)" });
      testStatus.setText(tr("Проверяю..."));
      try {
        const result = await testConnection(this.plugin.settings);
        testStatus.setCssProps({ "--ai-status-color": "var(--color-green,#4caf50)" });
        testStatus.setText(result);
      } catch (e) {
        testStatus.setCssProps({ "--ai-status-color": "var(--color-red,#f44336)" });
        testStatus.setText("✗ " + (e instanceof Error ? e.message : String(e)));
      }
      testBtn.removeAttribute("disabled");
      })();
    });
  }

  // ── Секция: глубокий аудит ───────────────────────────────────────────
  private renderDeepAuditSection(save: () => Promise<void>) {
    const el = this.containerEl;

    this.addIcon(
      new Setting(el)
        .setName(tr("Файлов в одном запросе"))
        .setDesc(
          tr("Рекомендуется 3-7. Больше = быстрее, но риск превышения контекста"),
        )
        .addSlider((s) =>
          s
            .setLimits(2, 15, 1)
            .setValue(this.plugin.settings.deepAudit.batchSize)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.deepAudit.batchSize = v;
              await save();
            }),
        ),
      "layers",
    );

    this.addIcon(
      new Setting(el)
        .setName(tr("Параллельных запросов"))
        .setDesc(tr("Для бесплатного тира: 1-2. Платный: до 5-6"))
        .addSlider((s) =>
          s
            .setLimits(1, 6, 1)
            .setValue(this.plugin.settings.deepAudit.maxConcurrent)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.deepAudit.maxConcurrent = v;
              await save();
            }),
        ),
      "zap",
    );

    this.addIcon(
      new Setting(el)
        .setName(tr("Задержка между запросами (мс)"))
        .setDesc(tr("Увеличьте при ошибках 429 Rate Limit"))
        .addSlider((s) =>
          s
            .setLimits(0, 5000, 250)
            .setValue(this.plugin.settings.deepAudit.delayMs)
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings.deepAudit.delayMs = v;
              await save();
            }),
        ),
      "timer",
    );
  }

  // ── Секция: вставка ──────────────────────────────────────────────────
  private renderInsertionSection(save: () => Promise<void>) {
    const el = this.containerEl;

    this.addIcon(
      new Setting(el).setName(tr("Место вставки по умолчанию")).addDropdown((d) =>
        d
          .addOption("end", tr("В конец заметки"))
          .addOption("beginning", tr("В начало заметки"))
          .addOption("replace", tr("Вместо выделения"))
          .addOption("after", tr("После выделения"))
          .addOption("new", tr("В новую заметку"))
          .addOption("clipboard", tr("В буфер обмена"))
          .addOption("cursor", tr("В позицию курсора"))
          .setValue(this.plugin.settings.defaultInsertion)
          .onChange(async (v) => {
            this.plugin.settings.defaultInsertion = v as InsertionType;
            await save();
          }),
      ),
      "arrow-down-to-line",
    );

    this.addIcon(
      new Setting(el)
        .setName(tr("Папка для новых заметок"))
        .setDesc(tr("Пусто = корень хранилища"))
        .addText((t) => {
          t.inputEl.setAttribute("aria-label", tr("Папка для новых заметок"));
          return t
            .setPlaceholder("AI-Responses")
            .setValue(this.plugin.settings.newNoteFolder)
            .onChange(async (v) => {
              this.plugin.settings.newNoteFolder = v.trim();
              await save();
            });
        }),
      "folder",
    );

    this.addIcon(
      new Setting(el)
        .setName(tr("Шаблон имени файла"))
        .setDesc("Переменные: {{date}}, {{time}}, {{topic}}")
        .addText((t) => {
          t.inputEl.setAttribute("aria-label", tr("Шаблон имени файла"));
          return t
            .setPlaceholder("AI-{{date}}-{{topic}}")
            .setValue(this.plugin.settings.filenameTemplate)
            .onChange(async (v) => {
              this.plugin.settings.filenameTemplate = v;
              await save();
            });
        }),
      "file-text",
    );
  }

  // ── Секция: интерфейс ────────────────────────────────────────────────
  private renderInterfaceSection(save: () => Promise<void>) {
    const el = this.containerEl;

    this.addIcon(
      new Setting(el)
        .setName(tr("Контекстное меню"))
        .setDesc(tr("Пункт AI Hub при правом клике (требует перезагрузки)"))
        .addToggle((t) =>
          t
            .setValue(this.plugin.settings.showContextMenu)
            .onChange(async (v) => {
              this.plugin.settings.showContextMenu = v;
              await save();
            }),
        ),
      "menu",
    );

    this.addIcon(
      new Setting(el).setName(tr("Уведомление о копировании")).addToggle((t) =>
        t.setValue(this.plugin.settings.notifyOnCopy).onChange(async (v) => {
          this.plugin.settings.notifyOnCopy = v;
          await save();
        }),
      ),
      "bell",
    );
  }
}