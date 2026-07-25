import { describe, expect, it, vi } from "vitest";
import {
  probeLocalVectorStoreDescriptor,
  VECTOR_BINARY_BACKUP_FILE,
  VECTOR_BINARY_FILE,
  VECTOR_BINARY_TEMP_FILE,
  VECTOR_MANIFEST_BACKUP_FILE,
  VECTOR_MANIFEST_FILE,
  VECTOR_MANIFEST_SCHEMA_VERSION,
  VECTOR_MANIFEST_TEMP_FILE,
} from "./localVectorStore";
import type { VectorStorePersistence } from "./types";

const BASE = ".obsidian/plugins/ai-knowledge-hub/semantic-index";
const path = (file: string) => `${BASE}/${file}`;

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: VECTOR_MANIFEST_SCHEMA_VERSION,
    generation: 4,
    dimensions: 3,
    embeddingSpaceId: "space-a",
    normalized: true,
    count: 0,
    binaryFile: VECTOR_BINARY_FILE,
    records: [],
    ...overrides,
  });
}

class ProbePersistence implements VectorStorePersistence {
  readonly text = new Map<string, string>();
  readonly binary = new Set<string>();
  readonly readBinary = vi.fn(async () => {
    throw new Error("descriptor probe must not read binary");
  });

  async exists(target: string): Promise<boolean> {
    return this.text.has(target) || this.binary.has(target);
  }
  async readText(target: string): Promise<string> {
    const value = this.text.get(target);
    if (value === undefined) throw new Error("missing text");
    return value;
  }
  async writeText(): Promise<void> {}
  async writeBinary(): Promise<void> {}
  async createDirectory(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}

  setPair(kind: "main" | "backup", raw = manifest()): void {
    const manifestFile =
      kind === "main" ? VECTOR_MANIFEST_FILE : VECTOR_MANIFEST_BACKUP_FILE;
    const binaryFile =
      kind === "main" ? VECTOR_BINARY_FILE : VECTOR_BINARY_BACKUP_FILE;
    this.text.set(path(manifestFile), raw);
    this.binary.add(path(binaryFile));
  }
}

describe("probeLocalVectorStoreDescriptor", () => {
  it("treats an absent store and temp-only artifacts as absent", async () => {
    const persistence = new ProbePersistence();
    persistence.text.set(path(VECTOR_MANIFEST_TEMP_FILE), manifest());
    persistence.binary.add(path(VECTOR_BINARY_TEMP_FILE));
    await expect(
      probeLocalVectorStoreDescriptor(persistence, BASE),
    ).resolves.toEqual({ state: "absent" });
    expect(persistence.readBinary).not.toHaveBeenCalled();
  });

  it("returns a strict main descriptor without reading binary", async () => {
    const persistence = new ProbePersistence();
    persistence.setPair("main");
    await expect(
      probeLocalVectorStoreDescriptor(persistence, BASE),
    ).resolves.toEqual({
      state: "present",
      source: "main",
      descriptor: {
        dimensions: 3,
        embeddingSpaceId: "space-a",
        generation: 4,
        count: 0,
      },
    });
    expect(persistence.readBinary).not.toHaveBeenCalled();
  });

  it("uses a complete backup when main is absent or incomplete", async () => {
    const absentMain = new ProbePersistence();
    absentMain.setPair("backup", manifest({ generation: 2 }));
    await expect(
      probeLocalVectorStoreDescriptor(absentMain, BASE),
    ).resolves.toMatchObject({ state: "present", source: "backup" });

    const incompleteMain = new ProbePersistence();
    incompleteMain.text.set(path(VECTOR_MANIFEST_FILE), manifest());
    incompleteMain.setPair("backup", manifest({ generation: 2 }));
    await expect(
      probeLocalVectorStoreDescriptor(incompleteMain, BASE),
    ).resolves.toMatchObject({ state: "present", source: "backup" });
  });

  it("keeps valid main authoritative over stale or partial backup", async () => {
    const persistence = new ProbePersistence();
    persistence.setPair("main", manifest({ generation: 5 }));
    persistence.text.set(
      path(VECTOR_MANIFEST_BACKUP_FILE),
      manifest({ generation: 4 }),
    );
    await expect(
      probeLocalVectorStoreDescriptor(persistence, BASE),
    ).resolves.toMatchObject({
      state: "present",
      source: "main",
      descriptor: { generation: 5 },
    });
  });

  it("reports partial backup and malformed manifests without trusting them", async () => {
    const partial = new ProbePersistence();
    partial.binary.add(path(VECTOR_BINARY_BACKUP_FILE));
    await expect(
      probeLocalVectorStoreDescriptor(partial, BASE),
    ).resolves.toEqual({ state: "incomplete" });

    for (const raw of [
      "{private malformed json",
      manifest({ dimensions: 0 }),
      manifest({ generation: -1 }),
      manifest({ count: 1 }),
      manifest({ embeddingSpaceId: "" }),
      manifest({ schemaVersion: 999 }),
    ]) {
      const malformed = new ProbePersistence();
      malformed.setPair("main", raw);
      await expect(
        probeLocalVectorStoreDescriptor(malformed, BASE),
      ).resolves.toEqual({ state: "corrupt" });
    }
  });

  it("uses backup for a corrupt current-format main but not an unknown schema", async () => {
    const recoverable = new ProbePersistence();
    recoverable.setPair("main", "{bad main");
    recoverable.setPair("backup", manifest({ generation: 2 }));
    await expect(
      probeLocalVectorStoreDescriptor(recoverable, BASE),
    ).resolves.toMatchObject({ state: "present", source: "backup" });

    const unsupported = new ProbePersistence();
    unsupported.setPair("main", manifest({ schemaVersion: 999 }));
    unsupported.setPair("backup", manifest({ generation: 2 }));
    await expect(
      probeLocalVectorStoreDescriptor(unsupported, BASE),
    ).resolves.toEqual({ state: "corrupt" });
  });
});
