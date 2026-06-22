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
  consolidated: number;
  source: string | null;
  metadata: string | null;
  /** FK to the source segment a `memory_ingest` fact was extracted from. NULL for store-path / degrade-path rows. */
  segment_id: string | null;
}

/**
 * A source chunk `memory_ingest` extracted facts from. Off the retrieval index by
 * construction: never embedded, never in `vec_memories`/`memories_fts`. Fetched
 * only by primary key during recall-time re-expansion ("index fine, return coarse").
 */
export interface SegmentRow {
  id: string;
  namespace: string;
  content: string;
  source: string | null;
  mode: string | null;
  created_at: number;
  fact_count: number;
}

export interface VectorSearchResult extends MemoryRow {
  distance: number;
}

export interface FtsSearchResult extends MemoryRow {
  bm25_score: number;
}

const SCHEMA_VERSION = '4';
const EMBEDDING_DIMENSIONS = 768;

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

  // Self-heal a stale on-disk schema BEFORE createSchema runs. A pre-`'4'` DB has an
  // old `memories` table without `segment_id`; `CREATE TABLE IF NOT EXISTS` would no-op
  // on it and the first `segment_id` access would throw `no such column`. Under the
  // back-compat-free directive we drop-and-recreate (deliberately discarding old data).
  dropStaleSchema(db);

  createSchema(db);
  ensureSchemaMeta(db, embeddingModel);

  return db;
}

/**
 * Read the on-disk `schema_version` stamp (defensively — the table may not exist on a
 * fresh DB) and, when it is PRESENT and OLDER than SCHEMA_VERSION, drop the schema so
 * `createSchema` rebuilds it from scratch. A fresh DB (no stamp) and a current DB
 * (stamp === SCHEMA_VERSION) both skip the drop.
 */
function dropStaleSchema(db: Database.Database): void {
  const hasSchemaMeta = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'`).get();
  if (!hasSchemaMeta) return; // fresh DB — nothing to drop

  const stamp = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!stamp || stamp.value === SCHEMA_VERSION) return; // fresh or current — keep

  // Stale stamp present: rebuild. Drop the virtual tables first (their shadow tables
  // depend on nothing else), then the base tables.
  db.exec(`
    DROP TABLE IF EXISTS vec_memories;
    DROP TABLE IF EXISTS memories_fts;
    DROP TABLE IF EXISTS memories;
    DROP TABLE IF EXISTS segments;
    DROP TABLE IF EXISTS schema_meta;
  `);
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      namespace   TEXT NOT NULL DEFAULT 'default',
      content     TEXT NOT NULL,
      source      TEXT,
      mode        TEXT,
      created_at  INTEGER NOT NULL,
      fact_count  INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_segments_namespace ON segments(namespace);

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
      source TEXT,
      metadata TEXT,
      consolidated INTEGER NOT NULL DEFAULT 1,
      segment_id TEXT REFERENCES segments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(namespace, created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(namespace, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(namespace, last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated
      ON memories(namespace, created_at) WHERE consolidated = 0;
    CREATE INDEX IF NOT EXISTS idx_memories_segment
      ON memories(segment_id) WHERE segment_id IS NOT NULL;

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

function ensureSchemaMeta(db: Database.Database, embeddingModel: string): void {
  const upsert = db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

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
