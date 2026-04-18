import { Plugin, Editor } from 'obsidian';
import { AIHubSettings } from './settings';
export default class AIHubPlugin extends Plugin {
    settings: AIHubSettings;
    onload(): Promise<void>;
    loadSettings(): Promise<void>;
    saveSettings(): Promise<void>;
    runAI(editor: Editor, mode: 'simple' | 'vault'): Promise<void>;
    smartVaultSearch(query: string): Promise<{
        name: string;
        content: string;
    }[]>;
    callOpenRouter(system: string, user: string): Promise<string>;
    promptUser(): Promise<string | null>;
}
//# sourceMappingURL=main.d.ts.map