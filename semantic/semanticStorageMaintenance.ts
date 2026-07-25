import type { DataAdapter } from "obsidian";
import {
  normalizeVectorStoreBasePath,
  VECTOR_BINARY_BACKUP_FILE,
  VECTOR_BINARY_FILE,
  VECTOR_BINARY_TEMP_FILE,
  VECTOR_MANIFEST_BACKUP_FILE,
  VECTOR_MANIFEST_FILE,
  VECTOR_MANIFEST_TEMP_FILE,
} from "../vectorStore";
import { SemanticStorageError } from "./errors";

export const SEMANTIC_INDEX_DIRECTORY = "semantic-index";
export const SEMANTIC_INDEX_ARTIFACTS = [
  VECTOR_BINARY_FILE,
  VECTOR_MANIFEST_FILE,
  VECTOR_BINARY_TEMP_FILE,
  VECTOR_MANIFEST_TEMP_FILE,
  VECTOR_BINARY_BACKUP_FILE,
  VECTOR_MANIFEST_BACKUP_FILE,
] as const;

export function semanticIndexBasePath(
  configDir: string,
  pluginId: string,
): string {
  if (pluginId !== "ai-knowledge-hub") {
    throw new SemanticStorageError("Unexpected semantic storage plugin id.");
  }
  try {
    return normalizeVectorStoreBasePath(
      `${configDir}/plugins/${pluginId}/${SEMANTIC_INDEX_DIRECTORY}`,
    );
  } catch (error) {
    throw new SemanticStorageError(
      "Semantic storage path is unsafe.",
      error,
    );
  }
}

export async function resetSemanticStorage(
  adapter: DataAdapter,
  basePath: string,
): Promise<void> {
  let safeBasePath: string;
  try {
    safeBasePath = normalizeVectorStoreBasePath(basePath);
  } catch (error) {
    throw new SemanticStorageError(
      "Semantic storage path is unsafe.",
      error,
    );
  }

  const failures: unknown[] = [];
  for (const artifact of SEMANTIC_INDEX_ARTIFACTS) {
    const path = `${safeBasePath}/${artifact}`;
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new SemanticStorageError(
      "Some semantic index files could not be removed.",
      failures,
    );
  }
}
