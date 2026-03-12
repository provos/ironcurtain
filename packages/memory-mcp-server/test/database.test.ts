import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase } from '../src/storage/database.js';
import {
  insertMemory,
  generateId,
  getMemoryById,
  getMemoriesByIds,
  getRecentMemories,
  getImportantMemories,
  deleteMemory,
  vectorSearch,
  ftsSearch,
  updateAccessStats,
  getNamespaceStats,
  getEmbeddingForMemory,
} from '../src/storage/queries.js';
import type Database from 'better-sqlite3';

const TEST_MODEL = 'test-model';
const NAMESPACE = 'test';

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

describe('database', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    db = initDatabase(join(tmpDir, 'test.db'), TEST_MODEL);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates schema tables', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
      name: string;
    }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('memories');
    expect(names).toContain('schema_meta');
    expect(names).toContain('vec_memories');
    expect(names).toContain('memories_fts');
  });

  it('stores schema metadata', () => {
    const model = db.prepare(`SELECT value FROM schema_meta WHERE key = 'embedding_model'`).get() as { value: string };
    expect(model.value).toBe(TEST_MODEL);
  });

  it('inserts and retrieves a memory', () => {
    const id = generateId();
    const emb = randomEmbedding();

    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content: 'User prefers dark mode',
        tags: ['preference', 'ui'],
        importance: 0.8,
      },
      emb,
    );

    const mem = getMemoryById(db, id);
    expect(mem).toBeDefined();
    expect(mem!.content).toBe('User prefers dark mode');
    expect(JSON.parse(mem!.tags!)).toEqual(['preference', 'ui']);
    expect(mem!.importance).toBe(0.8);
    expect(mem!.access_count).toBe(0);
  });

  it('retrieves multiple memories by IDs', () => {
    const ids = [generateId(), generateId()];
    for (const id of ids) {
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Memory ${id}`, tags: undefined, importance: 0.5 },
        randomEmbedding(),
      );
    }

    const results = getMemoriesByIds(db, ids);
    expect(results).toHaveLength(2);
  });

  it('deletes a memory from both tables', () => {
    const id = generateId();
    insertMemory(
      db,
      { id, namespace: NAMESPACE, content: 'To delete', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    expect(deleteMemory(db, id)).toBe(true);
    expect(getMemoryById(db, id)).toBeUndefined();
    expect(getEmbeddingForMemory(db, id)).toBeNull();
  });

  it('performs vector search', () => {
    // Insert a few memories with known embeddings
    const target = randomEmbedding();
    const id1 = generateId();
    insertMemory(
      db,
      { id: id1, namespace: NAMESPACE, content: 'Similar memory', tags: undefined, importance: 0.5 },
      target,
    );

    // Insert a different memory
    const id2 = generateId();
    insertMemory(
      db,
      { id: id2, namespace: NAMESPACE, content: 'Different memory', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    const results = vectorSearch(db, NAMESPACE, target, 10);
    expect(results.length).toBeGreaterThan(0);
    // The exact match should be first (distance ~0)
    expect(results[0].id).toBe(id1);
    expect(results[0].distance).toBeLessThan(0.01);
  });

  it('performs FTS5 search', () => {
    const id = generateId();
    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content: 'TypeScript strict mode is essential',
        tags: ['coding'],
        importance: 0.5,
      },
      randomEmbedding(),
    );

    const results = ftsSearch(db, NAMESPACE, 'TypeScript strict', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(id);
  });

  it('updates access stats', () => {
    const id = generateId();
    insertMemory(
      db,
      { id, namespace: NAMESPACE, content: 'Test', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    updateAccessStats(db, [id]);

    const mem = getMemoryById(db, id);
    expect(mem!.access_count).toBe(1);
    expect(mem!.last_accessed_at).toBeGreaterThan(mem!.created_at - 1);
  });

  it('returns recent memories sorted by created_at', () => {
    for (let i = 0; i < 5; i++) {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Memory ${i}`, tags: undefined, importance: 0.5 },
        randomEmbedding(),
      );
    }

    const recent = getRecentMemories(db, NAMESPACE, 3);
    expect(recent).toHaveLength(3);
    // Should be in descending order of created_at
    expect(recent[0].created_at).toBeGreaterThanOrEqual(recent[1].created_at);
  });

  it('returns important memories sorted by importance', () => {
    const importances = [0.3, 0.9, 0.1, 0.7, 0.5];
    for (const imp of importances) {
      insertMemory(
        db,
        {
          id: generateId(),
          namespace: NAMESPACE,
          content: `Importance ${imp}`,
          tags: undefined,
          importance: imp,
        },
        randomEmbedding(),
      );
    }

    const important = getImportantMemories(db, NAMESPACE, 3);
    expect(important).toHaveLength(3);
    expect(important[0].importance).toBe(0.9);
    expect(important[1].importance).toBe(0.7);
  });

  it('computes namespace stats', () => {
    for (let i = 0; i < 3; i++) {
      insertMemory(
        db,
        {
          id: generateId(),
          namespace: NAMESPACE,
          content: `Memory ${i}`,
          tags: ['test'],
          importance: 0.5,
        },
        randomEmbedding(),
      );
    }

    const stats = getNamespaceStats(db, NAMESPACE);
    expect(stats.total_memories).toBe(3);
    expect(stats.active_memories).toBe(3);
    expect(stats.top_tags).toHaveLength(1);
    expect(stats.top_tags[0].tag).toBe('test');
    expect(stats.top_tags[0].count).toBe(3);
  });

  it('isolates namespaces', () => {
    insertMemory(
      db,
      { id: generateId(), namespace: 'ns1', content: 'NS1 memory', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );
    insertMemory(
      db,
      { id: generateId(), namespace: 'ns2', content: 'NS2 memory', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    const stats1 = getNamespaceStats(db, 'ns1');
    const stats2 = getNamespaceStats(db, 'ns2');
    expect(stats1.total_memories).toBe(1);
    expect(stats2.total_memories).toBe(1);
  });
});
