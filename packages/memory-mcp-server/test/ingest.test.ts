import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

// ---- Mock the LLM client so extraction returns canned JSON, but the REAL ----
// ---- embedder + store/dedup/insert pipeline run end-to-end. ----
const llmMock = vi.hoisted(() => ({
  // A queue of responses; each llmComplete call shifts one. A non-array value
  // (null) simulates a hard LLM failure for that call.
  responses: [] as Array<string | null>,
  hasLLM: true,
  calls: 0,
}));

vi.mock('../src/llm/client.js', () => ({
  getLLMClient: vi.fn(() => (llmMock.hasLLM ? {} : null)),
  llmComplete: vi.fn(async () => {
    llmMock.calls += 1;
    if (!llmMock.hasLLM) return null;
    const next = llmMock.responses.shift();
    return next === undefined ? null : next;
  }),
}));

import { initDatabase } from '../src/storage/database.js';
import { getNamespaceStats, getMemoriesByIds } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';

const NAMESPACE = 'test';

function setResponses(...responses: Array<string | null>): void {
  llmMock.responses = responses;
  llmMock.hasLLM = true;
  llmMock.calls = 0;
}

function disableLLM(): void {
  llmMock.responses = [];
  llmMock.hasLLM = false;
  llmMock.calls = 0;
}

function factsJson(facts: Array<{ fact: string; importance?: number }>): string {
  return JSON.stringify(facts);
}

function testConfig(dbPath: string): MemoryConfig {
  return {
    ...loadConfig({}),
    dbPath,
    namespace: NAMESPACE,
    // The mock controls LLM availability; set non-null so the engine path is "LLM on".
    llmApiKey: 'test-key',
    llmBaseUrl: 'http://localhost:1234/v1',
    // Avoid maintenance noise interleaving in small tests.
    maintenanceInterval: 10000,
  };
}

describe('engine.ingest', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-ingest-test-'));
    dbPath = join(tmpDir, 'test.db');
    const config = testConfig(dbPath);
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(dbPath, config.embeddingModel);
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('decomposes a blob into N rows', async () => {
    setResponses(
      factsJson([
        { fact: 'The user is named Alice', importance: 0.9 },
        { fact: 'Alice prefers dark mode', importance: 0.6 },
        { fact: 'Alice works on the Iron project', importance: 0.5 },
      ]),
    );

    const result = await engine.ingest('conversation blob', { mode: 'document' });

    expect(result.created).toBe(3);
    expect(result.merged).toBe(0);
    expect(result.memory_ids).toHaveLength(3);

    const stats = getNamespaceStats(db, NAMESPACE);
    expect(stats.total_memories).toBe(3);

    const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
    const contents = rows.map((r) => r.content).sort();
    expect(contents).toEqual(['Alice prefers dark mode', 'Alice works on the Iron project', 'The user is named Alice']);
  });

  it('lands per-fact importance on rows, falling back to the seed when omitted', async () => {
    setResponses(
      factsJson([
        { fact: 'High salience fact', importance: 0.9 },
        { fact: 'Low salience fact', importance: 0.2 },
        { fact: 'No importance fact' }, // falls back to seed
      ]),
    );

    const result = await engine.ingest('blob', { importance: 0.5 });
    const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
    const byContent = new Map(rows.map((r) => [r.content, r.importance]));

    expect(byContent.get('High salience fact')).toBeCloseTo(0.9, 5);
    expect(byContent.get('Low salience fact')).toBeCloseTo(0.2, 5);
    expect(byContent.get('No importance fact')).toBeCloseTo(0.5, 5);
  });

  it('dry_run writes nothing but returns the facts', async () => {
    setResponses(
      factsJson([{ fact: 'Fact one', importance: 0.7 }, { fact: 'Fact two', importance: 0.3 }, { fact: 'Fact three' }]),
    );

    const result = await engine.ingest('blob', { dry_run: true });

    expect(result.created).toBe(0);
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0].importance).toBe(0.7);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
  });

  describe('as_of stamping (created path)', () => {
    const T_OLD = Date.parse('2023-03-01T00:00:00.000Z');

    it('stamps created/updated/last_accessed to a numeric as_of', async () => {
      setResponses(factsJson([{ fact: 'Backdated fact', importance: 0.5 }]));
      const result = await engine.ingest('blob', { as_of: T_OLD });

      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.created_at).toBe(T_OLD);
      expect(row.updated_at).toBe(T_OLD);
      expect(row.last_accessed_at).toBe(T_OLD);
    });

    it('omitting as_of yields created_at ≈ Date.now()', async () => {
      setResponses(factsJson([{ fact: 'Current fact', importance: 0.5 }]));
      const before = Date.now();
      const result = await engine.ingest('blob', {});
      const after = Date.now();
      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(row.created_at).toBeLessThanOrEqual(after);
    });
  });

  describe('order-independent merge timestamps (A1)', () => {
    const T_OLD = Date.parse('2022-01-01T00:00:00.000Z');
    const T_NEW = Date.parse('2024-06-01T00:00:00.000Z');
    const FACT = 'Alice prefers dark mode';

    // NOTE on updated_at: the merge calls updateMemoryContent (which stamps
    // updated_at = now) BEFORE updateMemoryTimestampsOnMerge runs MAX(updated_at, asOf).
    // With asOf in the past, MAX(now, asOf) === now, so updated_at lands at ~now
    // (the true "last touched" time — the merge just happened). created_at (MIN) and
    // last_accessed_at (MAX, untouched by updateMemoryContent) are the clean reconciled
    // values. This is the design's §5.4 SQL composed faithfully; see the report.
    it('reconciles min(created)/max(last_accessed) when newer merges into older', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob A', { as_of: T_OLD });

      const before = Date.now();
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob B', { as_of: T_NEW });
      const after = Date.now();

      expect(second.created).toBe(0);
      expect(second.merged).toBe(1);
      expect(second.memory_ids[0]).toBe(first.memory_ids[0]);

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.created_at).toBe(T_OLD); // MIN(T_OLD, T_NEW)
      expect(row.last_accessed_at).toBe(T_NEW); // MAX(T_OLD, T_NEW)
      expect(row.updated_at).toBeGreaterThanOrEqual(before); // MAX(now, T_NEW) === now
      expect(row.updated_at).toBeLessThanOrEqual(after);
    });

    it('is order-independent: same survivor created/last_accessed in reverse ingest order', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob B', { as_of: T_NEW });

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob A', { as_of: T_OLD });

      expect(second.merged).toBe(1);
      expect(second.memory_ids[0]).toBe(first.memory_ids[0]);

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      // Same reconciled values regardless of which order the two as_ofs arrived.
      expect(row.created_at).toBe(T_OLD); // MIN
      expect(row.last_accessed_at).toBe(T_NEW); // MAX
    });

    it('a non-as_of merge leaves created_at untouched and bumps updated_at', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob A', { as_of: T_OLD });

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob B', {}); // no as_of

      expect(second.merged).toBe(1);
      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.created_at).toBe(T_OLD); // untouched (min not invoked)
      expect(row.updated_at).toBeGreaterThan(T_OLD); // bumped to ~now by updateMemoryContent
    });

    // Proves the MAX(updated_at, ?) clause is LIVE rather than dead. Every other A1
    // test uses a PAST as_of, where updateMemoryContent already stamped updated_at=now
    // and MAX(now, past)=now — so the clause never moves the value. Only a FUTURE
    // as_of (> the existing updated_at, i.e. > now) makes MAX pick the as_of, which is
    // the assertion below. For the realistic backfill case (a PAST as_of, e.g. a
    // multi-year export) updated_at correctly stays ≈ now — the merge just happened —
    // which is exactly what the two reconcile tests above already verify.
    it('moves updated_at to a FUTURE as_of greater than the existing updated_at (A1 — MAX clause is live)', async () => {
      const T_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000; // ~1 year ahead, > now

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob A', {}); // created at ~now

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob B', { as_of: T_FUTURE });

      expect(second.merged).toBe(1);
      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      // MAX(updated_at≈now, T_FUTURE) === T_FUTURE — the clause actually moved it.
      expect(row.updated_at).toBe(T_FUTURE);
      // last_accessed_at = MAX(≈now, T_FUTURE) likewise advances.
      expect(row.last_accessed_at).toBe(T_FUTURE);
      // created_at = MIN(≈now, T_FUTURE) stays at the original (~now), not the future.
      expect(row.created_at).toBeLessThan(T_FUTURE);
    });
  });

  describe('merge importance composes (A1/A2)', () => {
    const FACT = 'Bob lives in Berlin';

    it('a higher-importance duplicate raises the survivor importance', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.3 }]));
      const first = await engine.ingest('blob', {});

      setResponses(factsJson([{ fact: FACT, importance: 0.9 }]));
      await engine.ingest('blob', {});

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.importance).toBeCloseTo(0.9, 5);
    });

    it('a lower-importance duplicate does not lower the survivor importance', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.8 }]));
      const first = await engine.ingest('blob', {});

      setResponses(factsJson([{ fact: FACT, importance: 0.1 }]));
      await engine.ingest('blob', {});

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.importance).toBeCloseTo(0.8, 5);
    });
  });

  it('reports honest stats when a fact duplicates an existing row (A7)', async () => {
    setResponses(factsJson([{ fact: 'Existing fact', importance: 0.5 }]));
    await engine.ingest('blob', {});

    setResponses(
      factsJson([
        { fact: 'Existing fact', importance: 0.5 }, // duplicate → merged
        { fact: 'Brand new fact one', importance: 0.5 },
        { fact: 'Brand new fact two', importance: 0.5 },
      ]),
    );
    const result = await engine.ingest('blob', {});

    expect(result.created).toBe(2);
    expect(result.merged).toBe(1);
    expect(result.memory_ids).toHaveLength(3);
  });

  describe('extraction failure handling (A3)', () => {
    it("default 'degrade' with no LLM stores the blob as a single memory", async () => {
      disableLLM();
      const blob = 'unstructured content with no LLM available';
      const result = await engine.ingest(blob, {});

      expect(result.created).toBe(1);
      expect(result.degraded).toBe(true);
      const stats = getNamespaceStats(db, NAMESPACE);
      expect(stats.total_memories).toBe(1);
      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.content).toBe(blob);
    });

    it("'skip' writes nothing and reports skipped without throwing", async () => {
      disableLLM();
      const result = await engine.ingest('blob', { on_extraction_failure: 'skip' });

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(true);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
    });

    it("'error' rejects, with no input substring in the message (A6)", async () => {
      disableLLM();
      const sensitive = 'CREDIT-CARD-4111-1111-1111-1111';
      await expect(engine.ingest(`secret blob ${sensitive}`, { on_extraction_failure: 'error' })).rejects.toThrow();

      try {
        await engine.ingest(`secret blob ${sensitive}`, { on_extraction_failure: 'error' });
        throw new Error('expected ingest to reject');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(sensitive);
      }
    });

    it('malformed (non-JSON) response degrades to a single-blob store (does not throw)', async () => {
      setResponses('not json at all');
      const result = await engine.ingest('blob to degrade', {});

      expect(result.degraded).toBe(true);
      expect(result.created).toBe(1);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
    });

    it('a valid empty extraction ([]) is a clean 0-fact ingest, NOT a failure (no degrade/skip)', async () => {
      // The prompt instructs the model to emit [] when nothing durable is present.
      // That is a successful parse, so it must not inflate failed_chunks, must not
      // degrade to a single-blob store, and must write nothing.
      setResponses('[]');
      const result = await engine.ingest('chit-chat with no durable facts', {});

      expect(result.created).toBe(0);
      expect(result.facts).toEqual([]);
      expect(result.degraded).toBeFalsy();
      expect(result.skipped).toBeFalsy();
      expect(result.partial).toBeFalsy();
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
    });
  });

  it('propagates seed tags and source to every written fact', async () => {
    setResponses(
      factsJson([
        { fact: 'Tagged fact one', importance: 0.5 },
        { fact: 'Tagged fact two', importance: 0.5 },
      ]),
    );
    const result = await engine.ingest('blob', { tags: ['seed-tag'], source: 'session:abc' });

    const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe('session:abc');
      expect(row.tags).toContain('seed-tag');
    }
  });

  describe('chunking integration (A5)', () => {
    function bigBlob(): string {
      // ~150 chars/line × 250 lines ≈ 9400 tokens → ~2-3 chunks (keeps embeds cheap).
      const line = 'sentence words here '.repeat(8).trim();
      return Array.from({ length: 250 }, (_, i) => `${i}: ${line}`).join('\n');
    }

    it('makes >1 LLM call, unions facts, and reports chunks>1', async () => {
      // Two distinct facts per chunk; enough responses for however many chunks form.
      const perChunk = (n: number): string => factsJson([{ fact: `chunk ${n} fact A` }, { fact: `chunk ${n} fact B` }]);
      setResponses(...Array.from({ length: 50 }, (_, i) => perChunk(i)));

      const result = await engine.ingest(bigBlob(), { mode: 'document' });

      expect(llmMock.calls).toBeGreaterThan(1);
      expect(result.chunks).toBeGreaterThan(1);
      expect(result.created).toBeGreaterThan(2); // facts from multiple chunks unioned
    });
  });

  describe('partial extraction is observable (A3)', () => {
    function bigBlob(): string {
      // ~150 chars/line × 250 lines ≈ 9400 tokens → ~2-3 chunks (keeps embeds cheap).
      const line = 'sentence words here '.repeat(8).trim();
      return Array.from({ length: 250 }, (_, i) => `${i}: ${line}`).join('\n');
    }

    it('ingests good chunks and flags partial/degraded/failed_chunks when one chunk fails', async () => {
      // First chunk → facts; all subsequent chunks → null (hard LLM failure).
      const responses: Array<string | null> = [
        factsJson([{ fact: 'good chunk fact A' }, { fact: 'good chunk fact B' }]),
      ];
      for (let i = 0; i < 49; i++) responses.push(null);
      setResponses(...responses);

      const result = await engine.ingest(bigBlob(), { mode: 'document' });

      expect(result.created).toBeGreaterThanOrEqual(2);
      expect(result.partial).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.failed_chunks).toBeGreaterThanOrEqual(1);
      expect(result.chunks).toBeGreaterThan(1);
    });
  });

  describe('PII-safe logging on failure (A6)', () => {
    it('does not leak a sensitive marker to ANY stderr channel on parse failure or LLM error', async () => {
      // Widened beyond console.error to also cover process.stderr.write and
      // console.warn — future-proofs the guarantee against a regression that emits
      // via a different channel (T3).
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const sensitive = 'PASSPORT-X9988776655';

      // Parse failure: non-JSON response containing the marker would only be in `raw`.
      setResponses(`I refuse. The input mentioned ${sensitive}.`);
      const r1 = await engine.ingest(`blob with ${sensitive}`, {});
      expect(r1.degraded).toBe(true);

      // LLM error path.
      disableLLM();
      const r2 = await engine.ingest(`another blob ${sensitive}`, { on_extraction_failure: 'skip' });
      expect(r2.skipped).toBe(true);

      const allLogs = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...stderrSpy.mock.calls]
        .map((c) => JSON.stringify(c))
        .join('\n');
      expect(allLogs).not.toContain(sensitive);

      errorSpy.mockRestore();
      warnSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });
});
