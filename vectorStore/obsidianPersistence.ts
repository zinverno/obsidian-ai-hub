import { normalizePath } from "obsidian";
import type { DataAdapter } from "obsidian";
import type { VectorStorePersistence } from "./types";

/**
 * DataAdapter-backed persistence for desktop and mobile Obsidian.
 *
 * LocalVectorStore supplies vault-relative paths; this adapter normalizes every
 * path immediately before delegating to the installed Obsidian API.
 */
export class ObsidianVectorStorePersistence
  implements VectorStorePersistence
{
  constructor(private readonly adapter: DataAdapter) {}

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }

  readText(path: string): Promise<string> {
    return this.adapter.read(normalizePath(path));
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(normalizePath(path));
  }

  writeText(path: string, data: string): Promise<void> {
    return this.adapter.write(normalizePath(path), data);
  }

  writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    return this.adapter.writeBinary(normalizePath(path), data);
  }

  async createDirectory(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    let currentPath = "";
    for (const segment of normalizedPath.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (await this.adapter.exists(currentPath)) continue;
      try {
        await this.adapter.mkdir(currentPath);
      } catch (error) {
        // Another writer may have created the same directory concurrently.
        if (!(await this.adapter.exists(currentPath))) throw error;
      }
    }
  }

  remove(path: string): Promise<void> {
    return this.adapter.remove(normalizePath(path));
  }

  rename(fromPath: string, toPath: string): Promise<void> {
    return this.adapter.rename(
      normalizePath(fromPath),
      normalizePath(toPath),
    );
  }
}
