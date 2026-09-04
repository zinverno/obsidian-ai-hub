import { mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProtocolError } from "../protocol/errors.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import type {
  MirroredChunk,
  MirroredNote,
  NoteManifestEntry,
  ReconciliationPlanResponse,
  SemanticDescriptor,
  SyncBatchRequest,
  SyncBatchResponse,
  SyncOperation,
  VaultStatus,
} from "../protocol/types.js";
import type { CompanionStorage, StoredVaultSnapshot } from "./companionStorage.js";
import { runMigrations } from "./migrations.js";

interface VaultRow {
  vault_id: string;
  generation: number;
  descriptor_json: string;
  embedding_space_id: string;
  dimensions: number;
}

interface NoteRow {
  path: string;
  content: string;
  content_hash: string;
  metadata_json: string;
}

interface ChunkRow {
  chunk_id: string;
  note_path: string;
  ordinal: number;
  heading_path_json: string;
  text: string;
  content_hash: string;
  source_start_offset: number;
  source_end_offset: number;
  source_start_line: number;
  source_end_line: number;
  embedding: Uint8Array;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function descriptorEqual(left: SemanticDescriptor, right: SemanticDescriptor): boolean {
  return (
    left.providerId === right.providerId &&
    left.model === right.model &&
    left.baseUrl === right.baseUrl &&
    left.dimensions === right.dimensions &&
    left.embeddingSpaceId === right.embeddingSpaceId &&
    left.normalized === right.normalized
  );
}

function encodeVector(values: readonly number[]): Buffer {
  const output = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index++) output.writeFloatLE(values[index] ?? 0, index * 4);
  return output;
}

function decodeVector(value: Uint8Array, dimensions: number): number[] {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength !== dimensions * 4) {
    throw new ProtocolError(500, "STORAGE_ERROR", "Stored embedding dimensions are invalid.");
  }
  const result: number[] = [];
  for (let index = 0; index < dimensions; index++) result.push(bytes.readFloatLE(index * 4));
  return result;
}

function parseDescriptor(row: VaultRow): SemanticDescriptor {
  try {
    return JSON.parse(row.descriptor_json) as SemanticDescriptor;
  } catch {
    throw new ProtocolError(500, "STORAGE_ERROR", "Stored descriptor is invalid.");
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new ProtocolError(500, "STORAGE_ERROR", "Stored note metadata is invalid.");
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Normalized to a public storage error below.
  }
  throw new ProtocolError(500, "STORAGE_ERROR", "Stored chunk metadata is invalid.");
}

export class SqliteCompanionStorage implements CompanionStorage {
  private database: DatabaseSync | null = null;

  constructor(private readonly dataDir: string, private readonly filename = "companion.sqlite") {}

  async initialize(): Promise<void> {
    if (this.database) return;
    try {
      await mkdir(this.dataDir, { recursive: true });
      await access(this.dataDir, constants.R_OK | constants.W_OK);
      const database = new DatabaseSync(join(this.dataDir, this.filename), { timeout: 5_000 });
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      runMigrations(database);
      this.database = database;
    } catch {
      throw new ProtocolError(500, "STORAGE_ERROR", "Companion DATA_DIR is not accessible or SQLite initialization failed.");
    }
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  async getServerStatus(): Promise<{ vaultCount: number }> {
    const row = this.db().prepare("SELECT COUNT(*) AS count FROM vaults").get() as { count: number };
    return { vaultCount: row.count };
  }

  async getVaultStatus(vaultId: string): Promise<VaultStatus> {
    const row = this.vaultRow(vaultId);
    if (!row) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        vaultId,
        exists: false,
        generation: 0,
        noteCount: 0,
        chunkCount: 0,
        descriptor: null,
      };
    }
    const counts = this.db().prepare(`
      SELECT
        (SELECT COUNT(*) FROM notes WHERE vault_id = ?) AS note_count,
        (SELECT COUNT(*) FROM chunks WHERE vault_id = ?) AS chunk_count
    `).get(vaultId, vaultId) as { note_count: number; chunk_count: number };
    return {
      protocolVersion: PROTOCOL_VERSION,
      vaultId,
      exists: true,
      generation: row.generation,
      noteCount: counts.note_count,
      chunkCount: counts.chunk_count,
      descriptor: parseDescriptor(row),
    };
  }

  async planReconciliation(
    vaultId: string,
    generation: number,
    descriptor: SemanticDescriptor,
    notes: readonly NoteManifestEntry[],
  ): Promise<ReconciliationPlanResponse> {
    const existingVault = this.vaultRow(vaultId);
    if (existingVault && generation < existingVault.generation) {
      throw new ProtocolError(409, "STALE_GENERATION", "Incoming semantic generation is older than the stored mirror.");
    }
    const storedNotes = this.noteManifest(vaultId);
    const incoming = [...notes].sort((left, right) => compareStrings(left.path, right.path));
    const incompatible = Boolean(existingVault && !descriptorEqual(parseDescriptor(existingVault), descriptor));
    const uploadPaths: string[] = [];
    const unchangedPaths: string[] = [];
    const incomingPaths = new Set(incoming.map((note) => note.path));

    for (const note of incoming) {
      const stored = storedNotes.get(note.path);
      const equal = !incompatible && stored !== undefined && stored.contentHash === note.contentHash &&
        stored.chunks.length === note.chunks.length &&
        stored.chunks.every((chunk, index) => {
          const candidate = note.chunks[index];
          return candidate?.chunkId === chunk.chunkId && candidate.contentHash === chunk.contentHash;
        });
      (equal ? unchangedPaths : uploadPaths).push(note.path);
    }
    const deletePaths = [...storedNotes.keys()]
      .filter((path) => incompatible || !incomingPaths.has(path))
      .sort(compareStrings);
    return {
      protocolVersion: PROTOCOL_VERSION,
      generation,
      serverGeneration: existingVault?.generation ?? 0,
      replaceVault: incompatible,
      uploadPaths,
      deletePaths,
      unchangedPaths,
    };
  }

  async applyBatch(vaultId: string, batch: SyncBatchRequest): Promise<SyncBatchResponse> {
    const database = this.db();
    const current = this.vaultRow(vaultId);
    if (current && batch.generation < current.generation) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        generation: current.generation,
        applied: false,
        stale: true,
        operationsApplied: 0,
      };
    }
    if (current && !batch.replaceVault && !descriptorEqual(parseDescriptor(current), batch.descriptor)) {
      throw new ProtocolError(409, "DESCRIPTOR_MISMATCH", "Incoming vectors use a different semantic descriptor.");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      if (batch.replaceVault) database.prepare("DELETE FROM vaults WHERE vault_id = ?").run(vaultId);
      this.upsertVault(vaultId, batch);
      for (const operation of batch.operations) this.applyOperation(vaultId, operation);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(500, "STORAGE_ERROR", "The synchronization batch could not be committed.");
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      generation: batch.generation,
      applied: true,
      stale: false,
      operationsApplied: batch.operations.length,
    };
  }

  async readVault(vaultId: string): Promise<StoredVaultSnapshot | null> {
    const vault = this.vaultRow(vaultId);
    if (!vault) return null;
    const notes = this.db().prepare(`
      SELECT path, content, content_hash, metadata_json
      FROM notes WHERE vault_id = ? ORDER BY path
    `).all(vaultId) as unknown as NoteRow[];
    const chunks = this.db().prepare(`
      SELECT chunk_id, note_path, ordinal, heading_path_json, text, content_hash,
             source_start_offset, source_end_offset, source_start_line, source_end_line, embedding
      FROM chunks WHERE vault_id = ? ORDER BY note_path, ordinal, chunk_id
    `).all(vaultId) as unknown as ChunkRow[];
    const descriptor = parseDescriptor(vault);
    const chunksByPath = new Map<string, MirroredChunk[]>();
    for (const row of chunks) {
      const values = chunksByPath.get(row.note_path) ?? [];
      values.push({
        chunkId: row.chunk_id,
        notePath: row.note_path,
        ordinal: row.ordinal,
        headingPath: parseStringArray(row.heading_path_json),
        text: row.text,
        contentHash: row.content_hash,
        source: {
          startOffset: row.source_start_offset,
          endOffset: row.source_end_offset,
          startLine: row.source_start_line,
          endLine: row.source_end_line,
        },
        embedding: decodeVector(row.embedding, descriptor.dimensions),
      });
      chunksByPath.set(row.note_path, values);
    }
    return {
      vaultId,
      generation: vault.generation,
      descriptor,
      notes: notes.map((row) => ({
        path: row.path,
        content: row.content,
        contentHash: row.content_hash,
        metadata: parseJsonRecord(row.metadata_json),
        chunks: chunksByPath.get(row.path) ?? [],
      })),
    };
  }

  private db(): DatabaseSync {
    if (!this.database) throw new ProtocolError(500, "STORAGE_ERROR", "Storage has not been initialized.");
    return this.database;
  }

  private vaultRow(vaultId: string): VaultRow | null {
    return (this.db().prepare(`
      SELECT vault_id, generation, descriptor_json, embedding_space_id, dimensions
      FROM vaults WHERE vault_id = ?
    `).get(vaultId) as VaultRow | undefined) ?? null;
  }

  private noteManifest(vaultId: string): Map<string, NoteManifestEntry> {
    const notes = this.db().prepare(`
      SELECT path, content_hash FROM notes WHERE vault_id = ? ORDER BY path
    `).all(vaultId) as unknown as Array<{ path: string; content_hash: string }>;
    const chunks = this.db().prepare(`
      SELECT note_path, chunk_id, content_hash
      FROM chunks WHERE vault_id = ? ORDER BY note_path, ordinal, chunk_id
    `).all(vaultId) as unknown as Array<{ note_path: string; chunk_id: string; content_hash: string }>;
    const result = new Map<string, NoteManifestEntry>();
    for (const note of notes) result.set(note.path, { path: note.path, contentHash: note.content_hash, chunks: [] });
    for (const chunk of chunks) result.get(chunk.note_path)?.chunks.push({ chunkId: chunk.chunk_id, contentHash: chunk.content_hash });
    return result;
  }

  private upsertVault(vaultId: string, batch: SyncBatchRequest): void {
    const now = new Date().toISOString();
    this.db().prepare(`
      INSERT INTO vaults (
        vault_id, protocol_version, generation, descriptor_json,
        embedding_space_id, dimensions, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vault_id) DO UPDATE SET
        protocol_version = excluded.protocol_version,
        generation = MAX(vaults.generation, excluded.generation),
        descriptor_json = excluded.descriptor_json,
        embedding_space_id = excluded.embedding_space_id,
        dimensions = excluded.dimensions,
        updated_at = excluded.updated_at
    `).run(
      vaultId,
      PROTOCOL_VERSION,
      batch.generation,
      JSON.stringify(batch.descriptor),
      batch.descriptor.embeddingSpaceId,
      batch.descriptor.dimensions,
      now,
      now,
    );
  }

  private applyOperation(vaultId: string, operation: SyncOperation): void {
    if (operation.type === "DELETE") {
      this.db().prepare("DELETE FROM notes WHERE vault_id = ? AND path = ?").run(vaultId, operation.path);
      return;
    }
    if (operation.type === "RENAME") {
      this.db().prepare("DELETE FROM notes WHERE vault_id = ? AND path IN (?, ?)").run(
        vaultId,
        operation.oldPath,
        operation.note.path,
      );
      this.insertNote(vaultId, operation.note);
      return;
    }
    this.db().prepare("DELETE FROM notes WHERE vault_id = ? AND path = ?").run(vaultId, operation.note.path);
    this.insertNote(vaultId, operation.note);
  }

  private insertNote(vaultId: string, note: MirroredNote): void {
    this.db().prepare(`
      INSERT INTO notes (vault_id, path, content, content_hash, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(vaultId, note.path, note.content, note.contentHash, JSON.stringify(note.metadata), new Date().toISOString());
    const insert = this.db().prepare(`
      INSERT INTO chunks (
        vault_id, chunk_id, note_path, ordinal, heading_path_json, text,
        content_hash, source_start_offset, source_end_offset,
        source_start_line, source_end_line, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const chunk of note.chunks) {
      insert.run(
        vaultId,
        chunk.chunkId,
        note.path,
        chunk.ordinal,
        JSON.stringify(chunk.headingPath),
        chunk.text,
        chunk.contentHash,
        chunk.source.startOffset,
        chunk.source.endOffset,
        chunk.source.startLine,
        chunk.source.endLine,
        encodeVector(chunk.embedding),
      );
    }
  }
}
