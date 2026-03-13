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
  consolidated?: boolean;
}

export function insertMemory(db: Database.Database, params: InsertMemoryParams, embedding: Float32Array): void {
  const now = Date.now();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (id, namespace, content, tags, importance,
         created_at, updated_at, last_accessed_at, source, metadata, consolidated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      params.consolidated === false ? 0 : 1,
    );

    db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`).run(
      params.id,
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    );
  });
  txn();
}

// ---------- Update ----------

export function updateMemoryTimestamp(
  db: Database.Database,
  namespace: string,
  id: string,
  tags?: string[],
  importance?: number,
): void {
  const now = Date.now();
  if (tags !== undefined && importance !== undefined) {
    db.prepare(
      `UPDATE memories
       SET updated_at = ?, tags = ?, importance = MAX(importance, ?)
       WHERE id = ? AND namespace = ?`,
    ).run(now, JSON.stringify(tags), importance, id, namespace);
  } else {
    db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ? AND namespace = ?`).run(now, id, namespace);
  }
}

export function updateMemoryContent(
  db: Database.Database,
  namespace: string,
  id: string,
  content: string,
  embedding: Float32Array,
  importance: number,
  supersededContent: string,
  mergedTags?: string[],
): void {
  const now = Date.now();
  const txn = db.transaction(() => {
    if (mergedTags !== undefined) {
      db.prepare(
        `UPDATE memories
         SET content = ?, updated_at = ?, tags = ?,
             importance = MAX(importance, ?),
             metadata = json_set(COALESCE(metadata, '{}'), '$.superseded',
               json(?))
         WHERE id = ? AND namespace = ?`,
      ).run(
        content,
        now,
        JSON.stringify(mergedTags),
        importance,
        JSON.stringify({ content: supersededContent, at: now }),
        id,
        namespace,
      );
    } else {
      db.prepare(
        `UPDATE memories
         SET content = ?, updated_at = ?,
             importance = MAX(importance, ?),
             metadata = json_set(COALESCE(metadata, '{}'), '$.superseded',
               json(?))
         WHERE id = ? AND namespace = ?`,
      ).run(content, now, importance, JSON.stringify({ content: supersededContent, at: now }), id, namespace);
    }

    db.prepare(
      `UPDATE vec_memories SET embedding = ?
       WHERE memory_id = ? AND memory_id IN (SELECT id FROM memories WHERE namespace = ?)`,
    ).run(Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), id, namespace);
  });
  txn();
}

export function updateAccessStats(db: Database.Database, namespace: string, ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE memories
     SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id = ? AND namespace = ?`,
  );
  const txn = db.transaction(() => {
    for (const id of ids) {
      stmt.run(now, id, namespace);
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
    .all(
      Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
      namespace,
      limit,
    ) as VectorSearchResult[];
}

export function ftsSearch(db: Database.Database, namespace: string, query: string, limit: number): FtsSearchResult[] {
  // Escape special FTS5 characters and build a simple query
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  return db
    .prepare(
      `SELECT m.*, bm25(memories_fts, 3.0, 1.5) as bm25_score
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND m.namespace = ?
       ORDER BY bm25(memories_fts, 3.0, 1.5)
       LIMIT ?`,
    )
    .all(sanitized, namespace, limit) as FtsSearchResult[];
}

// Common English stop words — these have near-zero IDF in any corpus and
// pollute BM25 rankings when OR-joined with discriminative terms.
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  's',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'too',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

function sanitizeFtsQuery(query: string): string {
  // Strip FTS5 special characters, keep words, remove stop words
  const words = query
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 20);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0];

  // Build bigram phrases from consecutive word pairs
  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(`"${words[i]} ${words[i + 1]}"`);
  }

  return [...phrases, ...words].join(' OR ');
}

// ---------- Retrieval helpers ----------

export function getMemoriesByIds(db: Database.Database, namespace: string, ids: string[]): MemoryRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM memories WHERE namespace = ? AND id IN (${placeholders})`)
    .all(namespace, ...ids) as MemoryRow[];
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

export function deleteMemory(db: Database.Database, namespace: string, id: string): boolean {
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_memories WHERE memory_id = ?
       AND memory_id IN (SELECT id FROM memories WHERE namespace = ?)`,
    ).run(id, namespace);
    const result = db.prepare(`DELETE FROM memories WHERE id = ? AND namespace = ?`).run(id, namespace);
    return result.changes > 0;
  });
  return txn();
}

export function deleteMemories(db: Database.Database, namespace: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_memories WHERE memory_id IN (${placeholders})
       AND memory_id IN (SELECT id FROM memories WHERE namespace = ?)`,
    ).run(...ids, namespace);
    const result = db
      .prepare(`DELETE FROM memories WHERE namespace = ? AND id IN (${placeholders})`)
      .run(namespace, ...ids);
    return result.changes;
  });
  return txn();
}

export function findMemoriesByTags(
  db: Database.Database,
  namespace: string,
  tags: string[],
  limit: number = 1000,
): MemoryRow[] {
  if (tags.length === 0) return [];
  const placeholders = tags.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT m.* FROM memories m
       WHERE m.namespace = ? AND m.tags IS NOT NULL
         AND (SELECT COUNT(*) FROM json_each(m.tags) je
              WHERE je.value IN (${placeholders})) = ?
       LIMIT ?`,
    )
    .all(namespace, ...tags, tags.length, limit) as MemoryRow[];
}

export function findMemoriesBefore(
  db: Database.Database,
  namespace: string,
  beforeMs: number,
  limit: number = 1000,
): MemoryRow[] {
  return db
    .prepare(`SELECT * FROM memories WHERE namespace = ? AND created_at < ? LIMIT ?`)
    .all(namespace, beforeMs, limit) as MemoryRow[];
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
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN is_compacted = 0 AND importance > 0 THEN 1 ELSE 0 END) as active,
         SUM(CASE WHEN importance = 0 AND is_compacted = 0 THEN 1 ELSE 0 END) as decayed,
         SUM(CASE WHEN is_compacted = 1 THEN 1 ELSE 0 END) as compacted,
         MIN(created_at) as oldest,
         MAX(created_at) as newest
       FROM memories WHERE namespace = ?`,
    )
    .get(namespace) as {
    total: number;
    active: number;
    decayed: number;
    compacted: number;
    oldest: number | null;
    newest: number | null;
  };

  // Approximate storage size from page_count * page_size
  const pageCount = (db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count;
  const pageSize = (db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size;

  const topTags = computeTopTags(db, namespace, 20);

  return {
    total_memories: agg.total,
    active_memories: agg.active,
    decayed_memories: agg.decayed,
    compacted_memories: agg.compacted,
    oldest_memory: agg.oldest,
    newest_memory: agg.newest,
    storage_bytes: pageCount * pageSize,
    top_tags: topTags,
  };
}

function computeTopTags(
  db: Database.Database,
  namespace: string,
  limit: number,
): Array<{ tag: string; count: number }> {
  return db
    .prepare(
      `SELECT value AS tag, COUNT(*) AS count
       FROM memories, json_each(memories.tags)
       WHERE namespace = ? AND tags IS NOT NULL AND is_compacted = 0
       GROUP BY value
       ORDER BY count DESC
       LIMIT ?`,
    )
    .all(namespace, limit) as Array<{ tag: string; count: number }>;
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

export function markDecayed(db: Database.Database, namespace: string, id: string): void {
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_memories WHERE memory_id = ?
       AND memory_id IN (SELECT id FROM memories WHERE namespace = ?)`,
    ).run(id, namespace);
    db.prepare(`UPDATE memories SET importance = 0 WHERE id = ? AND namespace = ?`).run(id, namespace);
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

export function markCompacted(db: Database.Database, namespace: string, ids: string[]): void {
  const stmt = db.prepare(`UPDATE memories SET is_compacted = 1 WHERE id = ? AND namespace = ?`);
  const txn = db.transaction(() => {
    for (const id of ids) {
      stmt.run(id, namespace);
    }
  });
  txn();
}

export function getUnconsolidatedMemories(db: Database.Database, namespace: string, limit: number): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND consolidated = 0 AND importance > 0
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(namespace, limit) as MemoryRow[];
}

export function markConsolidated(db: Database.Database, namespace: string, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE memories SET consolidated = 1 WHERE namespace = ? AND id IN (${placeholders})`).run(
    namespace,
    ...ids,
  );
}

export function getEmbeddingsForMemories(
  db: Database.Database,
  namespace: string,
  memoryIds: string[],
): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  if (memoryIds.length === 0) return result;

  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT v.memory_id, v.embedding FROM vec_memories v
       JOIN memories m ON m.id = v.memory_id
       WHERE m.namespace = ? AND v.memory_id IN (${placeholders})`,
    )
    .all(namespace, ...memoryIds) as Array<{ memory_id: string; embedding: Buffer }>;

  for (const row of rows) {
    result.set(
      row.memory_id,
      new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
    );
  }
  return result;
}
