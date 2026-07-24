import type { CachedMetadata, TFile } from "obsidian";
import { IndexingSourceError } from "./errors";
import type { IndexDocumentInput, MarkdownDocumentSource } from "./types";

export interface ObsidianMarkdownSourceApp {
  vault: {
    getMarkdownFiles(): TFile[];
    cachedRead(file: TFile): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: TFile): CachedMetadata | null;
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class ObsidianMarkdownDocumentSource
  implements MarkdownDocumentSource
{
  constructor(private readonly app: ObsidianMarkdownSourceApp) {}

  async readAll(): Promise<IndexDocumentInput[]> {
    const files = [...this.app.vault.getMarkdownFiles()]
      .filter((file) => file.path.toLowerCase().endsWith(".md"))
      .sort((left, right) => compareStrings(left.path, right.path));
    const documents: IndexDocumentInput[] = [];
    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const cache = this.app.metadataCache.getFileCache(file);
        documents.push({ path: file.path, content, cache });
      } catch {
        throw new IndexingSourceError(
          `Failed to read Markdown document "${file.path}".`,
        );
      }
    }
    return documents;
  }
}
