import { Plugin, Notice, Editor, Modal } from 'obsidian';
import { AIHubSettingTab, AIHubSettings, DEFAULT_SETTINGS } from './settings';

export default class AIHubPlugin extends Plugin {
	settings: AIHubSettings;

	async onload() {
		await this.loadSettings();

		// 1. Простое дополнение
		this.addCommand({
			id: 'ai-simple-append',
			name: 'AI: Простое дополнение',
			editorCallback: async (editor) => this.runAI(editor, 'simple')
		});

		// 2. Умное дополнение (Vault)
		this.addCommand({
			id: 'ai-vault-append',
			name: 'AI: Умное дополнение (Vault)',
			editorCallback: async (editor) => this.runAI(editor, 'vault')
		});

		// 3. Dataview генератор
		this.addCommand({
			id: 'ai-dataview-generate',
			name: 'AI: Создать Dataview',
			editorCallback: async (editor) => this.generateDataview(editor)
		});

		// ✅ Регистрация настроек (должна быть в конце onload)
		this.addSettingTab(new AIHubSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// === ЛОГИКА ЗАПУСКА ===
	async runAI(editor: Editor, mode: 'simple' | 'vault') {
		if (!this.settings.apiKey) {
			new Notice('⚠️ Введите API Key в настройках!');
			return;
		}

		const prompt = await this.promptUser(mode === 'vault' ? 'Запрос для поиска по хранилищу:' : 'Что добавить/изменить?');
		if (!prompt) return;

		new Notice('🤖 AI думает...', 0);

		try {
			const selection = editor.getSelection();
			const hasSelection = selection && selection.trim().length > 0;
			const currentContent = hasSelection ? selection : editor.getValue();

			let contextContent = '';
			if (mode === 'vault') {
				const relevantFiles = await this.smartVaultSearch(prompt);
				contextContent = "=== КОНТЕКСТ ХРАНИЛИЩА ===\n\n";
				relevantFiles.forEach(f => contextContent += `### ${f.name}\n${f.content}\n\n---\n\n`);
			}

			const systemMsg = mode === 'vault'
				? "Ты — эксперт по заметкам. Используй контекст. ДОПОЛНЯЙ или УЛУЧШАЙ текст. Не повторяйся."
				: "Ты — редактор. УЛУЧШИ или ДОПОЛНИ текст. Возвращай ТОЛЬКО Markdown.";

			const userMsg = mode === 'vault'
				? `Текст:\n${currentContent}\n\nЗапрос: ${prompt}\n\nКонтекст:\n${contextContent}`
				: `Текст:\n${currentContent}\n\nЗапрос: ${prompt}`;

			const aiResponse = await this.callOpenRouter(systemMsg, userMsg);
			const cleanResponse = aiResponse.replace(/^```[\s\S]*?```$/g, '').trim();

			if (hasSelection) {
				editor.replaceSelection(`\n\n${cleanResponse}\n\n`);
				new Notice('✅ Выделение обработано!');
			} else {
				editor.replaceRange(`\n\n---\n## 🤖 AI Дополнение\n**Запрос:** ${prompt}\n\n${cleanResponse}`, editor.getCursor());
				new Notice('✅ Дополнение добавлено!');
			}
		} catch (error: any) {
			new Notice(`❌ Ошибка: ${error.message}`);
		}
	}

	// === DATAVIEW ГЕНЕРАТОР ===
	async generateDataview(editor: Editor) {
		if (!this.settings.apiKey) {
			new Notice('⚠️ Введите API Key в настройках!');
			return;
		}

		const prompt = await this.promptUser('Что должен показывать Dataview?');
		if (!prompt) return;

		new Notice('📊 Генерирую Dataview...', 0);

		try {
			const systemMsg = `Ты — эксперт по Dataview в Obsidian. Твоя задача — создавать РАБОЧИЕ Dataview-запросы.

	ПРАВИЛА:
	1. Всегда начинай с TABLE, LIST, TASK или CALENDAR
	2. Используй правильный синтаксис
	3. Возвращай ТОЛЬКО код без пояснений
	4. Не используй markdown блоки (без \`\`\`)

	ПРИМЕРЫ:
	Запрос: "Покажи книги с рейтингом"
	Ответ: TABLE rating as "Рейтинг", author as "Автор" FROM #книги SORT rating DESC

	Запрос: "Задачи на сегодня"  
	Ответ: TASK FROM #задачи WHERE due = date(today)

	Запрос: "Список проектов"
	Ответ: LIST FROM #проект WHERE status = "active"

	Запрос: "Фильмы которые я смотрю"
	Ответ: TABLE rating as "Оценка", year as "Год" FROM #фильмы WHERE status = "watching"`;

			const userMsg = `Создай Dataview-запрос для: ${prompt}

	Верни только код Dataview (TABLE/LIST/TASK/CALENDAR) без markdown блоков.`;

			const aiResponse = await this.callOpenRouter(systemMsg, userMsg);
			
			// Очистка
			let clean = aiResponse.trim();
			clean = clean.replace(/^```[\s\S]*?```$/g, '').trim();
			clean = clean.replace(/^dataview\s*/i, '').trim();
			clean = clean.replace(/^```\s*$/gm, '').trim();
			
			// Убираем лишние переносы
			clean = clean.replace(/\n{3,}/g, '\n\n');

			// Проверка на пустоту
			if (!clean || clean.length < 5) {
				throw new Error('AI вернул пустой ответ. Попробуй другой запрос.');
			}

			// Проверка что начинается с правильного ключевого слова
			const validStarts = ['TABLE', 'LIST', 'TASK', 'CALENDAR', 'FROM'];
			const firstWord = clean.split(/\s+/)[0].toUpperCase();
			
			if (!validStarts.includes(firstWord)) {
				// Если AI вернул что-то другое, попробуем исправить
				console.warn('⚠️ AI вернул некорректный Dataview:', clean);
				new Notice('⚠️ AI вернул странный код. Проверь результат.', 5000);
			}

			// Вставляем
			editor.replaceSelection(`\n\`\`\`dataview\n${clean}\n\`\`\`\n`);
			new Notice('✅ Dataview создан!');

		} catch (error: any) {
			console.error('Dataview error:', error);
			new Notice(`❌ Ошибка: ${error.message}`);
		}
	}

	// === ПОИСК ПО ХРАНИЛИЩУ ===
	async smartVaultSearch(query: string): Promise<{ name: string, content: string }[]> {
		const files = this.app.vault.getMarkdownFiles();
		const lowerQuery = query.toLowerCase();
		
		const results = await Promise.all(files.map(async (file) => {
			if (file.path.startsWith('.')) return null;
			const content = await this.app.vault.read(file);
			const preview = content.slice(0, 800);
			const count = (preview.toLowerCase().match(new RegExp(lowerQuery, "g")) || []).length;
			return { score: (count * 3) + preview.length, name: file.name, content: preview };
		}));

		return results.filter(r => r !== null)
			.sort((a, b) => b.score - a.score)
			.slice(0, this.settings.topK || 10) as any;
	}

	// === ВЫЗОВ API ===
	async callOpenRouter(system: string, user: string): Promise<string> {
		const res = await fetch(`${this.settings.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.settings.apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://obsidian.md',
				'X-Title': 'Obsidian AI Hub'
			},
			body: JSON.stringify({
				model: this.settings.model,
				messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
				temperature: this.settings.temperature,
				max_tokens: 2000
			})
		});

		if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
		const json = await res.json();
		return json.choices[0].message.content;
	}

	// === МОДАЛЬНОЕ ОКНО ВВОДА (ИСПРАВЛЕНО) ===
	async promptUser(placeholder: string): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app); // ✅ Теперь работает без require
			modal.contentEl.createEl('h3', { text: 'AI Hub' });
			
			const input = modal.contentEl.createEl('input', { attr: { type: 'text', placeholder } });
			input.style.cssText = 'width:100%; padding:8px; margin:10px 0;';
			
			const btn = modal.contentEl.createEl('button', { text: 'Отправить' });
			btn.style.cssText = 'width:100%; padding:8px;';
			
			const submit = () => { resolve(input.value || null); modal.close(); };
			btn.onclick = submit;
			input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
			
			modal.open();
			setTimeout(() => input.focus(), 100);
		});
	}
}