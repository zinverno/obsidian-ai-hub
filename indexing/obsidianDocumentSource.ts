import { TFile } from "obsidian";
import type { CachedMetadata, TAbstractFile } from "obsidian";
import { IndexingSourceError } from "./errors";
import type { IndexDocumentInput, MarkdownDocumentSource } from "./types";

export interface ObsidianMarkdownSourceApp {
  vault: {
    getMarkdownFiles(): TFile[];
    getAbstractFileByPath?(path: string): TAbstractFile | null;
    cachedRead(file: TFile): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: TFile): CachedMetadata | null;
  };
}

export function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

export function isMarkdownTFile(file: TAbstractFile): file is TFile {
  return (
    file instanceof TFile &&
    file.extension.toLowerCase() === "md" &&
    isMarkdownPath(file.path)
  );
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
      .filter((file) => isMarkdownPath(file.path))
      .sort((left, right) => compareStrings(left.path, right.path));
    return this.readFiles(files);
  }

  async readPaths(paths: readonly string[]): Promise<{
    documents: IndexDocumentInput[];
    missingPaths: string[];
  }> {
    const filesByPath = new Map(
      this.app.vault.getMarkdownFiles().map((file) => [file.path, file]),
    );
    const documents: IndexDocumentInput[] = [];
    const missingPaths: string[] = [];
    const uniquePaths = [...new Set(paths)].sort(compareStrings);
    for (const path of uniquePaths) {
      const abstractFile = this.app.vault.getAbstractFileByPath?.(path);
      const file = abstractFile ?? filesByPath.get(path) ?? null;
      if (!file || !isMarkdownTFile(file)) {
        missingPaths.push(path);
        continue;
      }
      documents.push(await this.readFile(file));
    }
    return { documents, missingPaths };
  }

  private async readFiles(
    files: readonly TFile[],
  ): Promise<IndexDocumentInput[]> {
    const documents: IndexDocumentInput[] = [];
    for (const file of files) {
      documents.push(await this.readFile(file));
    }
    return documents;
  }

  private async readFile(file: TFile): Promise<IndexDocumentInput> {
    try {
      const content = await this.app.vault.cachedRead(file);
      const cache = this.app.metadataCache.getFileCache(file);
      return { path: file.path, content, cache };
    } catch {
      throw new IndexingSourceError(
        `Failed to read Markdown document "${file.path}".`,
      );
    }
  }
}
