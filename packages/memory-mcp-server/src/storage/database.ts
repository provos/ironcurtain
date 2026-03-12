import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MemoryRow {
  id: string;
  namespace: string;
  content: string;
  tags: string | null;
  importance: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  is_compacted: number;
  compacted_from: string | null;
  source: string | null;
  metadata: string | null;
}

export interface VectorSearchResult extends MemoryRow {
  distance: number;
}

export interface FtsSearchResult extends MemoryRow {
  bm25_score: number;
}

const SCHEMA_VERSION = '2';
const EMBEDDING_DIMENSIONS = 384;

/**
 * Initialize a SQLite database with the memory schema, sqlite-vec, and FTS5.
 * Creates the directory and database file if they don't exist.
 */
export function initDatabase(dbPath: string, embeddingModel: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  sqliteVec.load(db);

  createSchema(db);
  ensureSchemaMeta(db, embeddingModel);

  return db;
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      namespace TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      tags TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      is_compacted INTEGER NOT NULL DEFAULT 0,
      compacted_from TEXT,
      source TEXT,
      metadata TEXT,
      consolidated INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(namespace, created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(namespace, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(namespace, last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated
      ON memories(namespace, created_at) WHERE consolidated = 0;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Virtual tables cannot use IF NOT EXISTS in all SQLite builds,
  // so check before creating.
  const hasVecTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vec_memories'`).get();

  if (!hasVecTable) {
    db.exec(`
      CREATE VIRTUAL TABLE vec_memories USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSIONS}]
      );
    `);
  }

  const hasFtsTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'`).get();

  if (!hasFtsTable) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        content=memories,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );
    `);

    // Create triggers to keep FTS in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
      END;
    `);
  }
}

function migrateSchema(db: Database.Database): void {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const currentVersion = row?.value ?? '0';

  if (currentVersion === '1') {
    db.exec(`ALTER TABLE memories ADD COLUMN consolidated INTEGER NOT NULL DEFAULT 1`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated
         ON memories(namespace, created_at) WHERE consolidated = 0`,
    );
  }
}

function ensureSchemaMeta(db: Database.Database, embeddingModel: string): void {
  const upsert = db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  migrateSchema(db);

  const existing = db.prepare(`SELECT value FROM schema_meta WHERE key = 'embedding_model'`).get() as
    | { value: string }
    | undefined;

  if (existing && existing.value !== embeddingModel) {
    console.warn(
      `[memory-server] Warning: embedding model changed from '${existing.value}' to '${embeddingModel}'. ` +
        `Existing vectors may be incompatible. Re-embedding is not yet supported.`,
    );
  }

  const txn = db.transaction(() => {
    upsert.run('schema_version', SCHEMA_VERSION);
    upsert.run('embedding_model', embeddingModel);
    upsert.run('embedding_dimensions', String(EMBEDDING_DIMENSIONS));
  });
  txn();
}

export { EMBEDDING_DIMENSIONS };
