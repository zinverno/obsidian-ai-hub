import type { DataAdapter } from "obsidian";
import {
  ObsidianVectorStorePersistence,
  probeLocalVectorStoreDescriptor,
} from "../vectorStore";
import type {
  LocalVectorStoreDescriptor,
  LocalVectorStoreDescriptorProbeResult,
} from "../vectorStore";
import { SemanticStorageError } from "./errors";

export type SemanticIndexDescriptor = LocalVectorStoreDescriptor;
export type SemanticIndexProbeResult = LocalVectorStoreDescriptorProbeResult;

export async function probeSemanticIndex(
  adapter: DataAdapter,
  basePath: string,
): Promise<SemanticIndexProbeResult> {
  try {
    return await probeLocalVectorStoreDescriptor(
      new ObsidianVectorStorePersistence(adapter),
      basePath,
    );
  } catch (error) {
    throw new SemanticStorageError(
      "Could not inspect semantic index metadata.",
      error,
    );
  }
}
