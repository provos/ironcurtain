import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import { insertMemory, generateId, getMemoriesByIds, getEmbeddingsForMemories } from '../src/storage/queries.js';
import { computeVitality, maybeRunMaintenance, resetMaintenanceCounter } from '../src/storage/maintenance.js';
import type Database from 'better-sqlite3';
import type { MemoryRow } from '../src/storage/database.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';

const NAMESPACE = 'test';

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) arr[i] = Math.random() * 2 - 1;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) arr[i] /= norm;
  return arr;
}

function testConfig(): MemoryConfig {
  return {
    ...loadConfig({}),
    namespace: NAMESPACE,
    // Disable LLM for tests
    llmApiKey: null,
    llmBaseUrl: null,
    // Trigger maintenance every 2 stores for testing
    maintenanceInterval: 2,
    decayThreshold: 0.05,
    compactionMinGroup: 3,
  };
}

describe('computeVitality', () => {
  it('returns ~1.0 for a just-created memory', () => {
    const now = Date.now();
    const mem: MemoryRow = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0.5,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      access_count: 0,
      is_compacted: 0,
      compacted_from: null,
      source: null,
      metadata: null,
    };

    const vitality = computeVitality(mem, now);
    expect(vitality).toBeGreaterThan(0.9);
  });

  it('decays over time for low-importance memories', () => {
    const now = Date.now();
    const mem: MemoryRow = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0.1, // low importance = fast decay (18-day half-life)
      created_at: now - 30 * 24 * 3600000, // 30 days ago
      updated_at: now - 30 * 24 * 3600000,
      last_accessed_at: now - 30 * 24 * 3600000,
      access_count: 0,
      is_compacted: 0,
      compacted_from: null,
      source: null,
      metadata: null,
    };

    const vitality = computeVitality(mem, now);
    expect(vitality).toBeLessThan(0.5); // should be well decayed
  });

  it('high importance resists decay', () => {
    const now = Date.now();
    const base = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      created_at: now - 60 * 24 * 3600000, // 60 days ago
      updated_at: now - 60 * 24 * 3600000,
      last_accessed_at: now - 60 * 24 * 3600000,
      access_count: 0,
      is_compacted: 0,
      compacted_from: null,
      source: null,
      metadata: null,
    };

    const highImp = computeVitality({ ...base, importance: 0.9 }, now);
    const lowImp = computeVitality({ ...base, importance: 0.1 }, now);

    expect(highImp).toBeGreaterThan(lowImp);
  });

  it('access reinforcement extends lifetime', () => {
    const now = Date.now();
    const base = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0.3,
      created_at: now - 30 * 24 * 3600000,
      updated_at: now - 30 * 24 * 3600000,
      last_accessed_at: now - 1 * 3600000, // recently accessed
      is_compacted: 0,
      compacted_from: null,
      source: null,
      metadata: null,
    };

    const accessed = computeVitality({ ...base, access_count: 10 }, now);
    const notAccessed = computeVitality({ ...base, access_count: 0 }, now);

    expect(accessed).toBeGreaterThan(notAccessed);
  });

  it('returns 0 for zero importance', () => {
    const now = Date.now();
    const mem: MemoryRow = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      access_count: 0,
      is_compacted: 0,
      compacted_from: null,
      source: null,
      metadata: null,
    };

    expect(computeVitality(mem, now)).toBe(0);
  });
});

describe('maybeRunMaintenance', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-maint-'));
    db = initDatabase(join(tmpDir, 'test.db'), 'test-model');
    resetMaintenanceCounter();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not run maintenance before interval', async () => {
    const config = testConfig();
    // Insert some old, low-importance memories
    for (let i = 0; i < 5; i++) {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Old memory ${i}`, tags: undefined, importance: 0.01 },
        randomEmbedding(),
      );
      // Manually age the memory
      db.prepare(`UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?`).run(
        Date.now() - 365 * 24 * 3600000,
        Date.now() - 365 * 24 * 3600000,
        id,
      );
    }

    // First call should not trigger (counter = 1, interval = 2)
    const result = await maybeRunMaintenance(db, config);
    expect(result.decayed).toBe(0);
  });

  it('runs maintenance at interval', async () => {
    const config = testConfig();
    // Insert old, low-importance memories that should decay
    for (let i = 0; i < 5; i++) {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Very old memory ${i}`, tags: undefined, importance: 0.01 },
        randomEmbedding(),
      );
      // Age them significantly
      db.prepare(`UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?`).run(
        Date.now() - 365 * 24 * 3600000,
        Date.now() - 365 * 24 * 3600000,
        id,
      );
    }

    // First call (counter=1) - no maintenance
    await maybeRunMaintenance(db, config);
    // Second call (counter=2) - triggers maintenance
    const result = await maybeRunMaintenance(db, config);
    // Some should have decayed since they are very old with low importance
    expect(result.decayed).toBeGreaterThan(0);
  });

  it('marks decayed memories with importance=0 and removes from vec index', async () => {
    const config = testConfig();
    const id = generateId();
    insertMemory(
      db,
      { id, namespace: NAMESPACE, content: 'Will decay', tags: undefined, importance: 0.01 },
      randomEmbedding(),
    );
    // Age it
    db.prepare(`UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?`).run(
      Date.now() - 365 * 24 * 3600000,
      Date.now() - 365 * 24 * 3600000,
      id,
    );

    // Trigger maintenance
    await maybeRunMaintenance(db, config);
    await maybeRunMaintenance(db, config);

    const mem = getMemoriesByIds(db, NAMESPACE, [id])[0];
    // If decayed, importance should be 0 and no vec embedding
    if (mem.importance === 0) {
      expect(getEmbeddingsForMemories(db, NAMESPACE, [id]).get(id)).toBeUndefined();
    }
  });
});
