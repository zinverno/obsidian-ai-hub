import { App, PluginSettingTab } from 'obsidian';
import AIHubPlugin from './main';
export interface AIHubSettings {
    apiKey: string;
    model: string;
    baseUrl: string;
    temperature: number;
    topK: number;
}
export declare const DEFAULT_SETTINGS: AIHubSettings;
export declare class AIHubSettingTab extends PluginSettingTab {
    plugin: AIHubPlugin;
    constructor(app: App, plugin: AIHubPlugin);
    display(): void;
}
//# sourceMappingURL=settings.d.ts.map