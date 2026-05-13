import { App, TFile } from 'obsidian';

// ─── Версия схемы — увеличивай при breaking changes ───────────────────
const SCHEMA_VERSION = 2;
const INDEX_PATH = '.obsidian/plugins/ai-hub/note-index.json';

// ─── Запись об одной заметке ──────────────────────────────────────────
export interface NoteRecord {
    /** mtime файла в момент анализа — ключ для инкрементальности */
    mtime: number;
    /** Unix timestamp когда был выполнен анализ */
    analyzedAt: number;
    /** Главная мысль заметки, 1-2 предложения */
    mainIdea: string;
    /** 3-5 ключевых тезисов */
    keyPoints: string[];
    /** Имена, концепты, технологии, упомянутые в тексте */
    entities: string[];
    /** Оценка качества заметки */
    quality: 'draft' | 'developed' | 'polished';
    /** Рекомендуемые теги */
    suggestedTags: string[];
    /** Количество слов */
    wordCount: number;
    // Поля, заполняемые BATCH-режимом (могут отсутствовать у SINGLE)
    topics?: string[];
    suggestedLinks?: string[];
    orphan?: boolean;
    /** Режим которым была проанализирована заметка */
    mode?: 'batch' | 'single';
}

// ─── Структура файла индекса ──────────────────────────────────────────
export interface NoteIndexData {
    version: number;
    updatedAt: string;
    notes: Record<string, NoteRecord>;
}

// ─── Статистика по набору файлов ─────────────────────────────────────
export interface IndexStats {
    total: number;
    fresh: number;      // в индексе и mtime совпадает
    stale: number;      // в индексе, но изменились
    unseen: number;     // вообще не в индексе
    byQuality: { draft: number; developed: number; polished: number };
    byMode: { batch: number; single: number; unknown: number };
}

// ─────────────────────────────────────────────────────────────────────
//  Менеджер индекса
// ─────────────────────────────────────────────────────────────────────
export class NoteIndexManager {
    private data: NoteIndexData = {
        version: SCHEMA_VERSION,
        updatedAt: '',
        notes: {},
    };
    private dirty = false;

    constructor(private app: App) {}

    // ── Загрузка из диска ────────────────────────────────────────────
    async load(): Promise<void> {
        try {
            const raw = await this.app.vault.adapter.read(INDEX_PATH);
            const parsed: NoteIndexData = JSON.parse(raw);
            if (parsed.version === SCHEMA_VERSION && parsed.notes) {
                this.data = parsed;
            }
            // Старая версия — начинаем заново, без краша
        } catch {
            // Файла нет или сломан JSON — чистый старт
            this.data = { version: SCHEMA_VERSION, updatedAt: '', notes: {} };
        }
    }

    // ── Сохранение на диск ───────────────────────────────────────────
    async save(): Promise<void> {
        if (!this.dirty) return;
        this.data.updatedAt = new Date().toISOString();
        try {
            await this.app.vault.adapter.mkdir('.obsidian/plugins/ai-hub');
        } catch { /* папка уже есть */ }
        await this.app.vault.adapter.write(
            INDEX_PATH,
            JSON.stringify(this.data, null, 2),
        );
        this.dirty = false;
    }

    // ── Запись ──────────────────────────────────────────────────────
    get(path: string): NoteRecord | undefined {
        return this.data.notes[path];
    }

    set(path: string, record: NoteRecord): void {
        this.data.notes[path] = record;
        this.dirty = true;
    }

    /** Удалить устаревшие пути (файлы которых больше нет) */
    prune(existingPaths: Set<string>): number {
        let removed = 0;
        for (const path of Object.keys(this.data.notes)) {
            if (!existingPaths.has(path)) {
                delete this.data.notes[path];
                removed++;
                this.dirty = true;
            }
        }
        return removed;
    }

    // ── Инкрементальность ───────────────────────────────────────────

    /** true если записи нет или mtime изменился */
    isStale(file: TFile): boolean {
        const rec = this.data.notes[file.path];
        return !rec || rec.mtime !== file.stat.mtime;
    }

    getStaleFiles(files: TFile[]): TFile[] {
        return files.filter(f => this.isStale(f));
    }

    getFreshCount(files: TFile[]): number {
        return files.filter(f => !this.isStale(f)).length;
    }

    // ── Статистика ──────────────────────────────────────────────────
    stats(files: TFile[]): IndexStats {
        let fresh = 0, stale = 0, unseen = 0;
        const byQuality = { draft: 0, developed: 0, polished: 0 };
        const byMode = { batch: 0, single: 0, unknown: 0 };

        for (const f of files) {
            const rec = this.data.notes[f.path];
            if (!rec) { unseen++; continue; }
            if (rec.mtime === f.stat.mtime) {
                fresh++;
                byQuality[rec.quality ?? 'draft']++;
                const m = rec.mode ?? 'unknown';
                byMode[m as keyof typeof byMode]++;
            } else {
                stale++;
            }
        }

        return { total: files.length, fresh, stale, unseen, byQuality, byMode };
    }

    size(): number {
        return Object.keys(this.data.notes).length;
    }

    getUpdatedAt(): string {
        if (!this.data.updatedAt) return 'никогда';
        try {
            return new Date(this.data.updatedAt).toLocaleString('ru-RU');
        } catch {
            return this.data.updatedAt;
        }
    }

    getAllRecords(): Record<string, NoteRecord> {
        return this.data.notes;
    }

    isDirty(): boolean {
        return this.dirty;
    }
}
