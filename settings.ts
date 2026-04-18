import { App, PluginSettingTab, Setting } from 'obsidian';
import type AIHubPlugin from './main'; // тип импорта для класса

export interface AIHubSettings {
	apiKey: string;
	model: string;
	baseUrl: string;
	temperature: number;
	topK: number; // Сколько файлов искать
}

export const DEFAULT_SETTINGS: AIHubSettings = {
	apiKey: '', // Вставь свой ключ в настройках плагина
	model: 'qwen/qwen3.6-plus:free',
	baseUrl: 'https://openrouter.ai/api/v1',
	temperature: 0.65,
	topK: 12
};

export class AIHubSettingTab extends PluginSettingTab {
	plugin: AIHubPlugin;

	constructor(app: App, plugin: AIHubPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('OpenRouter API Key')
			.setDesc('Ключ для доступа к LLM. Хранится локально.')
			.addText(text => text
				.setPlaceholder('sk-or-v1-...')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model Name')
			.setDesc('Например: qwen/qwen3.6-plus:free')
			.addText(text => text
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Креативность (0.0 - 1.0)')
			.addSlider(slider => slider
				.setLimits(0, 1, 0.05)
				.setValue(this.plugin.settings.temperature)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.temperature = value;
					await this.plugin.saveSettings();
				}));
	}
}
