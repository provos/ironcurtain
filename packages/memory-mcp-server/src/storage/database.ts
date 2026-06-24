import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync } from 'node:fs';
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
  // back-compat-free directive we back up, then drop-and-recreate.
  dropStaleSchema(db, dbPath);

  createSchema(db);
  ensureSchemaMeta(db, embeddingModel);

  return db;
}

/**
 * Read the on-disk `schema_version` stamp (defensively — the table may not exist on a
 * fresh DB) and reconcile it against the current SCHEMA_VERSION using a NUMERIC compare:
 *
 *   - absent stamp (fresh DB)      → no-op (createSchema builds from scratch)
 *   - absent stamp + legacy shape  → back up, then drop-and-recreate
 *   - on-disk  <  current          → back up, then drop-and-recreate
 *   - on-disk  === current         → no-op (keep)
 *   - on-disk  >  current          → THROW (fail closed): an older binary must NOT
 *                                    destroy a newer DB it can't understand
 *   - present-but-unparseable      → back up, then drop (treat as stale; it is not
 *                                    a recognizable newer version)
 *
 * A pre-numeric string compare silently dropped a FUTURE schema opened by an older
 * binary (downgrade data loss); numeric compare + fail-closed prevents that.
 */
function dropStaleSchema(db: Database.Database, dbPath: string): void {
  const hasSchemaMeta = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'`).get();
  if (!hasSchemaMeta) {
    if (hasLegacyMemoriesShape(db)) {
      rebuildSchema(db, dbPath, 'legacy-unversioned');
    }
    return;
  }

  const stamp = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!stamp) {
    if (hasLegacyMemoriesShape(db)) {
      rebuildSchema(db, dbPath, 'legacy-unversioned');
    }
    return;
  }

  const current = Number(SCHEMA_VERSION);
  const onDisk = Number(stamp.value);

  // A present-but-unparseable stamp is not a recognizable newer version: treat it as
  // stale and rebuild (matches the absent-`segment_id` self-heal intent).
  if (Number.isNaN(onDisk)) {
    rebuildSchema(db, dbPath, `schema-${stamp.value}`);
    return;
  }

  if (onDisk === current) return; // current — keep

  if (onDisk > current) {
    // Fail closed: refuse to open (and never drop) a DB written by a newer binary.
    throw new Error(
      `Refusing to open memory database: on-disk schema version ${stamp.value} is newer than ` +
        `this binary's schema version ${SCHEMA_VERSION}. Upgrade the memory server or point at a ` +
        `compatible database; the newer database was left untouched.`,
    );
  }

  // on-disk < current: stale older DB — back up, then drop-and-recreate.
  rebuildSchema(db, dbPath, `schema-v${stamp.value}`);
}

/**
 * Drop the schema so `createSchema` rebuilds it from scratch. Drops the virtual tables
 * first (their shadow tables depend on nothing else), then the base tables.
 */
function rebuildSchema(db: Database.Database, dbPath: string, reason: string): void {
  const backupPath = backupDatabaseBeforeRebuild(db, dbPath, reason);
  console.warn(`[memory-server] Backed up incompatible memory database schema to '${backupPath}' before rebuilding.`);

  db.exec(`
    DROP TABLE IF EXISTS vec_memories;
    DROP TABLE IF EXISTS memories_fts;
    DROP TABLE IF EXISTS memories;
    DROP TABLE IF EXISTS segments;
    DROP TABLE IF EXISTS schema_meta;
  `);
}

function hasLegacyMemoriesShape(db: Database.Database): boolean {
  const hasMemories = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`).get();
  if (!hasMemories) return false;

  const columns = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  return columns.length > 0 && !columns.some((column) => column.name === 'segment_id');
}

function backupDatabaseBeforeRebuild(db: Database.Database, dbPath: string, reason: string): string {
  if (dbPath === ':memory:') {
    throw new Error(
      `Refusing to rebuild incompatible in-memory memory database schema because it cannot be backed up first.`,
    );
  }

  const backupPath = nextSchemaBackupPath(dbPath, reason);
  try {
    db.prepare(`VACUUM main INTO ?`).run(backupPath);
  } catch (cause) {
    throw new Error(
      `Refusing to rebuild incompatible memory database schema because backup creation failed at '${backupPath}'. ` +
        `The original database was left untouched.`,
      { cause },
    );
  }
  return backupPath;
}

function nextSchemaBackupPath(dbPath: string, reason: string): string {
  const sanitizedReason = reason.replace(/[^A-Za-z0-9._-]/g, '_');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${dbPath}.backup-${sanitizedReason}-before-v${SCHEMA_VERSION}-${timestamp}.db`;

  if (!existsSync(base)) return base;

  for (let suffix = 1; ; suffix++) {
    const candidate = `${base}.${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
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
