import type Database from 'better-sqlite3';
import type { MemoryRow, VectorSearchResult, FtsSearchResult } from './database.js';
import { randomBytes } from 'node:crypto';

export function generateId(): string {
  return randomBytes(16).toString('hex');
}

// ---------- Insert ----------

export interface InsertMemoryParams {
  id: string;
  namespace: string;
  content: string;
  tags: string[] | undefined;
  importance: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

export function insertMemory(db: Database.Database, params: InsertMemoryParams, embedding: Float32Array): void {
  const now = Date.now();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (id, namespace, content, tags, importance,
         created_at, updated_at, last_accessed_at, source, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.id,
      params.namespace,
      params.content,
      params.tags ? JSON.stringify(params.tags) : null,
      params.importance,
      now,
      now,
      now,
      params.source ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    );

    db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`).run(
      params.id,
      Buffer.from(embedding.buffer),
    );
  });
  txn();
}

// ---------- Update ----------

export function updateMemoryTimestamp(db: Database.Database, id: string, tags?: string[], importance?: number): void {
  const now = Date.now();
  if (tags !== undefined && importance !== undefined) {
    db.prepare(
      `UPDATE memories
       SET updated_at = ?, tags = ?, importance = MAX(importance, ?)
       WHERE id = ?`,
    ).run(now, JSON.stringify(tags), importance, id);
  } else {
    db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`).run(now, id);
  }
}

export function updateMemoryContent(
  db: Database.Database,
  id: string,
  content: string,
  embedding: Float32Array,
  importance: number,
  supersededContent: string,
): void {
  const now = Date.now();
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE memories
       SET content = ?, updated_at = ?,
           importance = MAX(importance, ?),
           metadata = json_set(COALESCE(metadata, '{}'), '$.superseded',
             json(?))
       WHERE id = ?`,
    ).run(content, now, importance, JSON.stringify({ content: supersededContent, at: now }), id);

    db.prepare(`UPDATE vec_memories SET embedding = ? WHERE memory_id = ?`).run(Buffer.from(embedding.buffer), id);
  });
  txn();
}

export function updateAccessStats(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE memories
     SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id = ?`,
  );
  const txn = db.transaction(() => {
    for (const id of ids) {
      stmt.run(now, id);
    }
  });
  txn();
}

// ---------- Search ----------

export function vectorSearch(
  db: Database.Database,
  namespace: string,
  embedding: Float32Array,
  limit: number,
): VectorSearchResult[] {
  return db
    .prepare(
      `SELECT m.*, vec_distance_cosine(v.embedding, ?) as distance
       FROM vec_memories v
       JOIN memories m ON m.id = v.memory_id
       WHERE m.namespace = ?
       ORDER BY distance ASC
       LIMIT ?`,
    )
    .all(Buffer.from(embedding.buffer), namespace, limit) as VectorSearchResult[];
}

export function ftsSearch(db: Database.Database, namespace: string, query: string, limit: number): FtsSearchResult[] {
  // Escape special FTS5 characters and build a simple query
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  return db
    .prepare(
      `SELECT m.*, fts.rank as bm25_score
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND m.namespace = ?
       ORDER BY fts.rank
       LIMIT ?`,
    )
    .all(sanitized, namespace, limit) as FtsSearchResult[];
}

function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 special characters, keep words
  const words = query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return '';
  // OR each word for broad matching
  return words.join(' OR ');
}

// ---------- Retrieval helpers ----------

export function getMemoryById(db: Database.Database, id: string): MemoryRow | undefined {
  return db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
}

export function getMemoriesByIds(db: Database.Database, ids: string[]): MemoryRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as MemoryRow[];
}

export function getRecentMemories(db: Database.Database, namespace: string, limit: number): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND is_compacted = 0 AND importance > 0
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(namespace, limit) as MemoryRow[];
}

export function getImportantMemories(db: Database.Database, namespace: string, limit: number): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND is_compacted = 0 AND importance > 0
       ORDER BY importance DESC
       LIMIT ?`,
    )
    .all(namespace, limit) as MemoryRow[];
}

// ---------- Delete ----------

export function deleteMemory(db: Database.Database, id: string): boolean {
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(id);
    const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return result.changes > 0;
  });
  return txn();
}

export function deleteMemories(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  let count = 0;
  const txn = db.transaction(() => {
    for (const id of ids) {
      if (deleteMemory(db, id)) count++;
    }
  });
  txn();
  return count;
}

export function findMemoriesByTags(db: Database.Database, namespace: string, tags: string[]): MemoryRow[] {
  // Find memories that have ALL the specified tags
  const rows = db
    .prepare(`SELECT * FROM memories WHERE namespace = ? AND tags IS NOT NULL`)
    .all(namespace) as MemoryRow[];

  return rows.filter((row) => {
    const memTags = JSON.parse(row.tags ?? '[]') as string[];
    return tags.every((t) => memTags.includes(t));
  });
}

export function findMemoriesBefore(db: Database.Database, namespace: string, beforeMs: number): MemoryRow[] {
  return db
    .prepare(`SELECT * FROM memories WHERE namespace = ? AND created_at < ?`)
    .all(namespace, beforeMs) as MemoryRow[];
}

// ---------- Stats ----------

export interface NamespaceStats {
  total_memories: number;
  active_memories: number;
  decayed_memories: number;
  compacted_memories: number;
  oldest_memory: number | null;
  newest_memory: number | null;
  storage_bytes: number;
  top_tags: Array<{ tag: string; count: number }>;
}

export function getNamespaceStats(db: Database.Database, namespace: string): NamespaceStats {
  const total = (db.prepare(`SELECT COUNT(*) as c FROM memories WHERE namespace = ?`).get(namespace) as { c: number })
    .c;

  const active = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM memories
         WHERE namespace = ? AND is_compacted = 0 AND importance > 0`,
      )
      .get(namespace) as { c: number }
  ).c;

  const decayed = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM memories
         WHERE namespace = ? AND importance = 0 AND is_compacted = 0`,
      )
      .get(namespace) as { c: number }
  ).c;

  const compacted = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM memories
         WHERE namespace = ? AND is_compacted = 1`,
      )
      .get(namespace) as { c: number }
  ).c;

  const oldest = db.prepare(`SELECT MIN(created_at) as v FROM memories WHERE namespace = ?`).get(namespace) as {
    v: number | null;
  };

  const newest = db.prepare(`SELECT MAX(created_at) as v FROM memories WHERE namespace = ?`).get(namespace) as {
    v: number | null;
  };

  // Approximate storage size from page_count * page_size
  const pageCount = (db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count;
  const pageSize = (db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size;

  const topTags = computeTopTags(db, namespace, 20);

  return {
    total_memories: total,
    active_memories: active,
    decayed_memories: decayed,
    compacted_memories: compacted,
    oldest_memory: oldest.v,
    newest_memory: newest.v,
    storage_bytes: pageCount * pageSize,
    top_tags: topTags,
  };
}

function computeTopTags(
  db: Database.Database,
  namespace: string,
  limit: number,
): Array<{ tag: string; count: number }> {
  const rows = db
    .prepare(
      `SELECT tags FROM memories
       WHERE namespace = ? AND tags IS NOT NULL AND is_compacted = 0`,
    )
    .all(namespace) as Array<{ tags: string }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    const tags = JSON.parse(row.tags) as string[];
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

// ---------- Maintenance queries ----------

export function getRandomActiveMemories(db: Database.Database, namespace: string, limit: number): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND importance > 0 AND is_compacted = 0
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(namespace, limit) as MemoryRow[];
}

export function markDecayed(db: Database.Database, id: string): void {
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(id);
    db.prepare(`UPDATE memories SET importance = 0 WHERE id = ?`).run(id);
  });
  txn();
}

export function getDecayedUncompacted(db: Database.Database, namespace: string, limit: number): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND importance = 0 AND is_compacted = 0
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(namespace, limit) as MemoryRow[];
}

export function markCompacted(db: Database.Database, ids: string[]): void {
  const stmt = db.prepare(`UPDATE memories SET is_compacted = 1 WHERE id = ?`);
  const txn = db.transaction(() => {
    for (const id of ids) {
      stmt.run(id);
    }
  });
  txn();
}

export function getEmbeddingForMemory(db: Database.Database, memoryId: string): Float32Array | null {
  const row = db.prepare(`SELECT embedding FROM vec_memories WHERE memory_id = ?`).get(memoryId) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}

export function getEmbeddingsForMemories(db: Database.Database, memoryIds: string[]): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  if (memoryIds.length === 0) return result;

  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT memory_id, embedding FROM vec_memories WHERE memory_id IN (${placeholders})`)
    .all(...memoryIds) as Array<{ memory_id: string; embedding: Buffer }>;

  for (const row of rows) {
    result.set(
      row.memory_id,
      new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
    );
  }
  return result;
}
