import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import AIHubPlugin from "./main";
import { LLMProvider, PROVIDER_PROFILES, ProviderProfile } from "./constants";
import { testConnection, fetchOllamaModels } from "./api";

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
    const wrapper = this.containerEl.createDiv();
    wrapper.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:8px 0 6px;margin-top:8px;";
    const iconWrap = wrapper.createSpan();
    iconWrap.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:5px;background:rgba(127,127,255,0.15);color:var(--interactive-accent);flex-shrink:0;";
    setIcon(iconWrap, icon);
    const label = wrapper.createEl("h3", { text });
    label.style.cssText =
      "margin:0;font-size:0.95em;font-weight:600;letter-spacing:-0.01em;";
  }

  // ── Главный render ───────────────────────────────────────────────────
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const save = async () => this.plugin.saveSettings();

    // Hero
    const hero = containerEl.createDiv();
    hero.style.cssText =
      "padding:20px 0 16px;border-bottom:1px solid var(--background-modifier-border);margin-bottom:24px;display:flex;align-items:center;gap:14px;";
    const heroIcon = hero.createDiv();
    heroIcon.style.cssText =
      "width:42px;height:42px;border-radius:10px;background:var(--interactive-accent);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:white;";
    setIcon(heroIcon, "brain");
    const heroText = hero.createDiv();
    heroText
      .createDiv({ text: "AI Hub" })
      .setAttribute(
        "style",
        "font-size:1.2em;font-weight:700;letter-spacing:-0.02em;",
      );
    heroText
      .createDiv({ text: "Настройки плагина" })
      .setAttribute(
        "style",
        "font-size:0.85em;color:var(--text-muted);margin-top:2px;",
      );

    // ── Секция: провайдер ──────────────────────────────────────────────
    this.addHeading("Языковая модель", "cpu");
    this.renderProviderCards(containerEl, save);

    // ── Динамическая секция (поля для выбранного провайдера) ───────────
    this.dynamicSection = containerEl.createDiv();
    this.renderDynamicSection(save);

    containerEl.createEl("hr", { cls: "ai-hub-settings-separator" });

    // ── Секция: глубокий аудит ─────────────────────────────────────────
    this.addHeading("Глубокий аудит", "microscope");
    this.renderDeepAuditSection(save);

    containerEl.createEl("hr", { cls: "ai-hub-settings-separator" });

    // ── Секция: вставка ────────────────────────────────────────────────
    this.addHeading("Вставка ответа", "arrow-down-to-line");
    this.renderInsertionSection(save);

    containerEl.createEl("hr", { cls: "ai-hub-settings-separator" });

    // ── Секция: интерфейс ──────────────────────────────────────────────
    this.addHeading("Интерфейс", "layout-dashboard");
    this.renderInterfaceSection(save);
  }

  // ── Карточки провайдеров ─────────────────────────────────────────────
  private renderProviderCards(
    container: HTMLElement,
    save: () => Promise<void>,
  ) {
    const grid = container.createDiv();
    grid.style.cssText =
      "display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px;";

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
        const isActive = id === p;
        card.style.borderColor = isActive
          ? "var(--interactive-accent)"
          : "var(--background-modifier-border)";
        card.style.background = isActive
          ? "rgba(127,127,255,0.08)"
          : "var(--background-primary)";
        card.style.boxShadow = isActive
          ? "0 0 0 2px rgba(127,127,255,0.2)"
          : "var(--ai-shadow-sm, 0 1px 3px rgba(0,0,0,0.1))";
      });
    };

    for (const p of providers) {
      const profile = PROVIDER_PROFILES[p];
      const card = grid.createDiv();
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Провайдер: ${profile.label}`);
      card.style.cssText =
        "padding:10px 8px;border:1.5px solid var(--background-modifier-border);border-radius:10px;cursor:pointer;text-align:center;transition:all 0.15s ease;user-select:none;display:flex;flex-direction:column;align-items:center;gap:5px;";
      cards.set(p, card);

      const iconWrap = card.createDiv();
      iconWrap.style.cssText =
        "width:28px;height:28px;border-radius:6px;background:rgba(127,127,255,0.1);display:flex;align-items:center;justify-content:center;color:var(--interactive-accent);";
      setIcon(iconWrap, profile.icon);

      card.createDiv({ text: profile.label }).style.cssText =
        "font-size:0.78em;font-weight:600;color:var(--text-normal);line-height:1.2;";
      card.createDiv({ text: profile.description }).style.cssText =
        "font-size:0.68em;color:var(--text-faint);line-height:1.3;";

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

      card.addEventListener("click", onClick);
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
    const infoCard = el.createDiv();
    infoCard.style.cssText =
      "padding:10px 14px;background:var(--background-secondary);border-radius:8px;border:1px solid var(--background-modifier-border);margin-bottom:14px;font-size:0.83em;color:var(--text-muted);";
    if (provider === "ollama") {
      infoCard.innerHTML =
        '<strong style="color:var(--text-normal)">Ollama — локальный inference</strong><br>' +
        "Установи Ollama: <code>curl -fsSL https://ollama.com/install.sh | sh</code><br>" +
        "Загрузи модель: <code>ollama pull llama3.2</code>";
    } else if (provider === "openrouter") {
      infoCard.innerHTML =
        '<strong style="color:var(--text-normal)">OpenRouter — единый шлюз к 100+ моделям</strong><br>' +
        'API ключ: <a href="https://openrouter.ai/keys">openrouter.ai/keys</a> · Бесплатные модели доступны без баланса';
    } else if (provider === "openai") {
      infoCard.innerHTML =
        '<strong style="color:var(--text-normal)">OpenAI API</strong><br>' +
        'API ключ: <a href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</a>';
    } else if (provider === "groq") {
      infoCard.innerHTML =
        '<strong style="color:var(--text-normal)">Groq — бесплатный быстрый inference</strong><br>' +
        'API ключ: <a href="https://console.groq.com/keys">console.groq.com/keys</a>';
    } else {
      infoCard.innerHTML =
        '<strong style="color:var(--text-normal)">Custom OpenAI-совместимый API</strong><br>' +
        "Укажи Base URL и при необходимости API ключ. Модель — как требует провайдер.";
    }

    // ── API Key (только если нужен) ───────────────────────────────────
    if (profile.requiresApiKey || provider === "custom") {
      const keySetting = new Setting(el)
        .setName("API Key")
        .setDesc(
          profile.requiresApiKey
            ? "Хранится локально"
            : "Если требуется провайдером",
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
            hint.style.cssText = "font-size:0.78em;margin-top:4px;";
            if (val.startsWith(profile.apiKeyPrefix) && val.length > 20) {
              hint.style.color = "var(--color-green,#4caf50)";
              hint.setText("✓ Формат ключа корректен");
            } else {
              hint.style.color = "var(--text-warning,orange)";
              hint.setText("⚠ Формат ключа нестандартный");
            }
          };
          updateKeyHint(this.plugin.settings.apiKey);
          return t;
        })
        .addButton((btn) => {
          let visible = false;
          btn
            .setIcon("eye")
            .setTooltip("Показать/скрыть")
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
      .setName("Модель")
      .setDesc(
        provider === "ollama"
          ? "Имя модели как в `ollama list`"
          : "ID модели провайдера",
      )
      .addText((t) => {
        t.inputEl.setAttribute("aria-label", "Название модели");
        t.setPlaceholder(profile.modelPlaceholder)
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await save();
          });
        return t;
      });
    this.addIcon(modelSetting, "bot");

    // Популярные модели (если есть)
    if (profile.popularModels.length > 0) {
      const pickerRow = el.createDiv();
      pickerRow.style.cssText =
        "display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;";
      for (const m of profile.popularModels) {
        const chip = pickerRow.createEl("button");
        chip.style.cssText =
          "padding:3px 10px;border-radius:12px;border:1px solid var(--background-modifier-border);font-size:0.76em;cursor:pointer;background:var(--background-secondary);color:var(--text-muted);transition:all 0.15s;display:flex;align-items:center;gap:4px;";
        chip.createSpan({ text: m.label });
        if (m.tag) {
          const tag = chip.createSpan({ text: m.tag });
          tag.style.cssText =
            "font-size:0.85em;padding:1px 5px;border-radius:8px;background:rgba(127,127,255,0.15);color:var(--interactive-accent);";
        }
        chip.addEventListener("mouseenter", () => {
          chip.style.borderColor = "var(--interactive-accent)";
          chip.style.color = "var(--text-normal)";
        });
        chip.addEventListener("mouseleave", () => {
          chip.style.borderColor = "var(--background-modifier-border)";
          chip.style.color = "var(--text-muted)";
        });
        chip.addEventListener("click", async () => {
          this.plugin.settings.model = m.id;
          await save();
          const input = el.querySelector<HTMLInputElement>(
            "input[aria-label='Название модели']",
          );
          if (input) {
            input.value = m.id;
          }
        });
      }
    }

    // Загрузить модели Ollama
    if (provider === "ollama") {
      const ollamaRow = el.createDiv();
      ollamaRow.style.cssText = "margin-bottom:10px;";
      const ollamaBtn = ollamaRow.createEl("button");
      ollamaBtn.style.cssText =
        "padding:4px 12px;border-radius:6px;border:1px solid var(--background-modifier-border);font-size:0.82em;cursor:pointer;background:var(--background-secondary);color:var(--text-muted);display:flex;align-items:center;gap:6px;";
      const ollamaIcon = ollamaBtn.createSpan();
      setIcon(ollamaIcon, "refresh-cw");
      ollamaBtn.createSpan({ text: "Загрузить доступные модели" });

      const ollamaStatus = ollamaRow.createDiv();
      ollamaStatus.style.cssText =
        "font-size:0.78em;color:var(--text-muted);margin-top:4px;";

      ollamaBtn.addEventListener("click", async () => {
        ollamaBtn.setAttribute("disabled", "true");
        ollamaStatus.setText("Загрузка...");
        try {
          const models = await fetchOllamaModels(this.plugin.settings.baseUrl);
          if (models.length === 0) {
            ollamaStatus.style.color = "var(--text-warning,orange)";
            ollamaStatus.setText(
              "⚠ Ollama не найден или моделей нет. Запусти: ollama pull llama3.2",
            );
          } else {
            ollamaStatus.style.color = "var(--color-green,#4caf50)";
            ollamaStatus.setText(`✓ Найдено: ${models.join(", ")}`);
          }
        } catch (e) {
          ollamaStatus.style.color = "var(--color-red,#f44336)";
          ollamaStatus.setText(
            "✗ Ошибка: " + (e instanceof Error ? e.message : String(e)),
          );
        }
        ollamaBtn.removeAttribute("disabled");
      });
    }

    // ── Base URL ──────────────────────────────────────────────────────
    const urlSetting = new Setting(el)
      .setName("Base URL")
      .setDesc(
        provider === "custom"
          ? "URL вашего OpenAI-совместимого API"
          : "Автозаполнен, можно изменить",
      )
      .addText((t) => {
        t.inputEl.setAttribute("aria-label", "Базовый URL API");
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
        .setDesc("Креативность ответа: 0.0 = точно, 1.0 = творчески")
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
    const testRow = el.createDiv();
    testRow.style.cssText =
      "margin-top:12px;display:flex;align-items:center;gap:12px;";

    const testBtn = testRow.createEl("button");
    testBtn.style.cssText =
      "padding:6px 14px;border-radius:8px;border:1px solid var(--background-modifier-border);font-size:0.85em;cursor:pointer;background:var(--background-secondary);color:var(--text-normal);display:flex;align-items:center;gap:6px;transition:all 0.15s;font-weight:500;";
    const testIcon = testBtn.createSpan();
    setIcon(testIcon, "plug");
    testBtn.createSpan({ text: "Проверить соединение" });

    const testStatus = testRow.createDiv();
    testStatus.style.cssText = "font-size:0.82em;color:var(--text-muted);";

    testBtn.addEventListener("click", async () => {
      testBtn.setAttribute("disabled", "true");
      testStatus.style.color = "var(--text-muted)";
      testStatus.setText("Проверяю...");
      try {
        const result = await testConnection(this.plugin.settings);
        testStatus.style.color = "var(--color-green,#4caf50)";
        testStatus.setText(result);
      } catch (e) {
        testStatus.style.color = "var(--color-red,#f44336)";
        testStatus.setText("✗ " + (e instanceof Error ? e.message : String(e)));
      }
      testBtn.removeAttribute("disabled");
    });
  }

  // ── Секция: глубокий аудит ───────────────────────────────────────────
  private renderDeepAuditSection(save: () => Promise<void>) {
    const el = this.containerEl;

    this.addIcon(
      new Setting(el)
        .setName("Файлов в одном запросе")
        .setDesc(
          "Рекомендуется 3-7. Больше = быстрее, но риск превышения контекста",
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
        .setName("Параллельных запросов")
        .setDesc("Для бесплатного тира: 1-2. Платный: до 5-6")
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
        .setName("Задержка между запросами (мс)")
        .setDesc("Увеличьте при ошибках 429 Rate Limit")
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
      new Setting(el).setName("Место вставки по умолчанию").addDropdown((d) =>
        d
          .addOption("end", "В конец заметки")
          .addOption("beginning", "В начало заметки")
          .addOption("replace", "Вместо выделения")
          .addOption("after", "После выделения")
          .addOption("new", "В новую заметку")
          .addOption("clipboard", "В буфер обмена")
          .addOption("cursor", "В позицию курсора")
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
        .setName("Папка для новых заметок")
        .setDesc("Пусто = корень хранилища")
        .addText((t) => {
          t.inputEl.setAttribute("aria-label", "Папка для новых заметок");
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
        .setName("Шаблон имени файла")
        .setDesc("Переменные: {{date}}, {{time}}, {{topic}}")
        .addText((t) => {
          t.inputEl.setAttribute("aria-label", "Шаблон имени файла");
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
        .setName("Контекстное меню")
        .setDesc("Пункт AI Hub при правом клике (требует перезагрузки)")
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
      new Setting(el).setName("Уведомление о копировании").addToggle((t) =>
        t.setValue(this.plugin.settings.notifyOnCopy).onChange(async (v) => {
          this.plugin.settings.notifyOnCopy = v;
          await save();
        }),
      ),
      "bell",
    );
  }
}
