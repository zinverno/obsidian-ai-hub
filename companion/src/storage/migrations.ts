import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS vaults (
        vault_id TEXT PRIMARY KEY NOT NULL,
        protocol_version INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        descriptor_json TEXT NOT NULL,
        embedding_space_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS notes (
        vault_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (vault_id, path),
        FOREIGN KEY (vault_id) REFERENCES vaults(vault_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS chunks (
        vault_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        note_path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading_path_json TEXT NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_start_offset INTEGER NOT NULL,
        source_end_offset INTEGER NOT NULL,
        source_start_line INTEGER NOT NULL,
        source_end_line INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY (vault_id, chunk_id),
        UNIQUE (vault_id, note_path, ordinal),
        FOREIGN KEY (vault_id, note_path) REFERENCES notes(vault_id, path) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS chunks_by_note
        ON chunks(vault_id, note_path, ordinal, chunk_id);
    `,
  },
  { version: 2, sql: "ALTER TABLE vaults ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;" },
  {
    version: 3,
    sql: `CREATE TABLE proposals (
      proposal_id TEXT PRIMARY KEY NOT NULL, vault_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('CREATE_NOTE','UPDATE_NOTE','DELETE_NOTE')),
      path TEXT NOT NULL, base_content_hash TEXT, base_content TEXT,
      proposed_content TEXT, proposed_content_hash TEXT, summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING','CLAIMED','APPLIED','REJECTED','CONFLICT','FAILED','EXPIRED')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      claimed_at INTEGER, claim_expires_at INTEGER, claim_id TEXT, applied_at INTEGER, status_code TEXT
    ) STRICT;
    CREATE INDEX proposals_by_vault ON proposals(vault_id, created_at, proposal_id);
    CREATE INDEX proposals_by_status ON proposals(status, updated_at);`,
  },
];

export function runMigrations(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
