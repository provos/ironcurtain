import { describe, it, expect } from 'vitest';
import type { MemoryRow, VectorSearchResult, FtsSearchResult } from '../src/storage/database.js';
import {
  hybridScoreFusion,
  computeCompositeScore,
  estimateTokens,
  filterByRelevance,
  filterByRerankerScore,
  packToBudget,
  type ScoredMemory,
} from '../src/retrieval/scoring.js';

function makeMemory(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const now = Date.now();
  return {
    id: overrides.id ?? 'mem-1',
    namespace: 'test',
    content: overrides.content ?? 'Test memory content',
    tags: overrides.tags ?? null,
    importance: overrides.importance ?? 0.5,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    last_accessed_at: overrides.last_accessed_at ?? now,
    access_count: overrides.access_count ?? 0,
    is_compacted: overrides.is_compacted ?? 0,
    consolidated: overrides.consolidated ?? 1,
    source: overrides.source ?? null,
    metadata: overrides.metadata ?? null,
  };
}

function makeVectorResult(overrides: Partial<MemoryRow> = {}, distance = 0.5): VectorSearchResult {
  return { ...makeMemory(overrides), distance };
}

function makeFtsResult(overrides: Partial<MemoryRow> = {}, bm25_score = -5): FtsSearchResult {
  return { ...makeMemory(overrides), bm25_score };
}

describe('hybridScoreFusion', () => {
  it('merges results from both sources', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.5);
    const m2 = makeVectorResult({ id: 'b' }, 0.3);
    const f2 = makeFtsResult({ id: 'b' }, -10);
    const f3 = makeFtsResult({ id: 'c' }, -5);

    const allMemories = new Map<string, MemoryRow>([
      ['a', m1],
      ['b', m2],
      ['c', f3],
    ]);

    const vectorResults = [m2, m1]; // b at distance 0.3 (best), a at distance 0.5
    const ftsResults = [f2, f3]; // b at -10 (best), c at -5 (worst)

    const { scored, fusionMax } = hybridScoreFusion(vectorResults, ftsResults, allMemories);

    expect(scored.length).toBe(3);
    // b appears in both lists with best scores in each, so should have highest fusion score
    expect(scored[0].id).toBe('b');
    expect(fusionMax).toBe(scored[0].fusionScore);
  });

  it('handles empty result sets', () => {
    const { scored, fusionMax } = hybridScoreFusion([], [], new Map());
    expect(scored).toHaveLength(0);
    expect(fusionMax).toBe(0);
  });

  it('handles vector-only results', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.3);
    const allMemories = new Map<string, MemoryRow>([['a', m1]]);

    const { scored } = hybridScoreFusion([m1], [], allMemories);
    expect(scored).toHaveLength(1);
    expect(scored[0].id).toBe('a');
    // Single vector result: normalized to 1.0, weighted by alpha (0.5)
    expect(scored[0].fusionScore).toBeCloseTo(0.5);
  });

  it('handles FTS-only results', () => {
    const f1 = makeFtsResult({ id: 'a' }, -7);
    const allMemories = new Map<string, MemoryRow>([['a', f1]]);

    const { scored } = hybridScoreFusion([], [f1], allMemories);
    expect(scored).toHaveLength(1);
    // Single FTS result: normalized to 1.0, weighted by (1-alpha) = 0.5
    expect(scored[0].fusionScore).toBeCloseTo(0.5);
  });

  it('preserves vector distances on scored results', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.2);
    const m2 = makeVectorResult({ id: 'b' }, 0.7);
    const f3 = makeFtsResult({ id: 'c' }, -5); // FTS-only

    const allMemories = new Map<string, MemoryRow>([
      ['a', m1],
      ['b', m2],
      ['c', f3],
    ]);

    const { scored } = hybridScoreFusion([m1, m2], [f3], allMemories);
    const byId = new Map(scored.map((r) => [r.id, r]));

    expect(byId.get('a')!.vectorDistance).toBe(0.2);
    expect(byId.get('b')!.vectorDistance).toBe(0.7);
    expect(byId.get('c')!.vectorDistance).toBeUndefined();
  });

  it('preserves normalized BM25 scores on scored results', () => {
    const f1 = makeFtsResult({ id: 'a' }, -10); // best match
    const f2 = makeFtsResult({ id: 'b' }, -5); // worst match

    const allMemories = new Map<string, MemoryRow>([
      ['a', f1],
      ['b', f2],
    ]);

    const { scored } = hybridScoreFusion([], [f1, f2], allMemories);
    const byId = new Map(scored.map((r) => [r.id, r]));

    // Most negative (-10) → 1.0, least negative (-5) → 0.0
    expect(byId.get('a')!.bm25Score).toBe(1.0);
    expect(byId.get('b')!.bm25Score).toBe(0.0);
    // No vector distance for FTS-only
    expect(byId.get('a')!.vectorDistance).toBeUndefined();
  });

  it('normalizes single FTS result to 1.0', () => {
    const f1 = makeFtsResult({ id: 'a' }, -7);

    const allMemories = new Map<string, MemoryRow>([['a', f1]]);

    const { scored } = hybridScoreFusion([], [f1], allMemories);
    expect(scored[0].bm25Score).toBe(1.0);
  });

  it('produces scores in [0, 1] range', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.1);
    const m2 = makeVectorResult({ id: 'b' }, 0.9);
    const f1 = makeFtsResult({ id: 'a' }, -20);
    const f3 = makeFtsResult({ id: 'c' }, -1);

    const allMemories = new Map<string, MemoryRow>([
      ['a', m1],
      ['b', m2],
      ['c', f3],
    ]);

    const { scored } = hybridScoreFusion([m1, m2], [f1, f3], allMemories);
    for (const s of scored) {
      expect(s.fusionScore).toBeGreaterThanOrEqual(0);
      expect(s.fusionScore).toBeLessThanOrEqual(1);
    }
  });

  it('gives highest score to candidate with best combined normalized scores', () => {
    // a: best vector (distance 0.1 = sim 0.9), best FTS (-20)
    // b: worst vector (distance 0.9 = sim 0.1), worst FTS (-1)
    const m1 = makeVectorResult({ id: 'a' }, 0.1);
    const m2 = makeVectorResult({ id: 'b' }, 0.9);
    const f1 = makeFtsResult({ id: 'a' }, -20);
    const f2 = makeFtsResult({ id: 'b' }, -1);

    const allMemories = new Map<string, MemoryRow>([
      ['a', m1],
      ['b', m2],
    ]);

    const { scored } = hybridScoreFusion([m1, m2], [f1, f2], allMemories);
    // a should be first since it's best in both sources
    expect(scored[0].id).toBe('a');
    expect(scored[0].fusionScore).toBeCloseTo(1.0);
    expect(scored[1].fusionScore).toBeCloseTo(0.0);
  });

  it('alpha weighting: vector-only gets alpha * 1.0', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.3);
    const allMemories = new Map<string, MemoryRow>([['a', m1]]);

    const alpha = 0.7;
    const { scored } = hybridScoreFusion([m1], [], allMemories, alpha);
    // Single result normalized to 1.0, weighted by alpha
    expect(scored[0].fusionScore).toBeCloseTo(0.7);
  });

  it('alpha weighting: FTS-only gets (1-alpha) * 1.0', () => {
    const f1 = makeFtsResult({ id: 'a' }, -5);
    const allMemories = new Map<string, MemoryRow>([['a', f1]]);

    const alpha = 0.7;
    const { scored } = hybridScoreFusion([], [f1], allMemories, alpha);
    // Single result normalized to 1.0, weighted by (1-alpha)
    expect(scored[0].fusionScore).toBeCloseTo(0.3);
  });

  it('normalizes single vector result to 1.0', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.4);
    const allMemories = new Map<string, MemoryRow>([['a', m1]]);

    const { scored } = hybridScoreFusion([m1], [], allMemories);
    // Single vector result: range=0, normalized to 1.0
    // fusionScore = 0.5 * 1.0 = 0.5
    expect(scored[0].fusionScore).toBeCloseTo(0.5);
  });
});

describe('computeCompositeScore', () => {
  it('gives higher score to more recent memories', () => {
    const now = Date.now();
    const recent = {
      ...makeMemory({ created_at: now - 3600000 }), // 1 hour ago
      fusionScore: 0.5,
      compositeScore: 0,
    } as ScoredMemory;

    const old = {
      ...makeMemory({ created_at: now - 30 * 24 * 3600000 }), // 30 days ago
      fusionScore: 0.5,
      compositeScore: 0,
    } as ScoredMemory;

    expect(computeCompositeScore(recent, now)).toBeGreaterThan(computeCompositeScore(old, now));
  });

  it('gives higher score to more important memories', () => {
    const now = Date.now();
    const base = {
      fusionScore: 0.5,
      compositeScore: 0,
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
    };

    const important = { ...makeMemory({ importance: 0.9 }), ...base } as ScoredMemory;
    const unimportant = { ...makeMemory({ importance: 0.1 }), ...base } as ScoredMemory;

    expect(computeCompositeScore(important, now)).toBeGreaterThan(computeCompositeScore(unimportant, now));
  });

  it('gives higher score to memories with higher fusion scores', () => {
    const now = Date.now();
    const base = {
      compositeScore: 0,
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
      importance: 0.5,
    };

    const highFusion = { ...makeMemory(), ...base, fusionScore: 0.9 } as ScoredMemory;
    const lowFusion = { ...makeMemory(), ...base, fusionScore: 0.1 } as ScoredMemory;

    const fusionMax = 0.9;
    expect(computeCompositeScore(highFusion, now, fusionMax)).toBeGreaterThan(
      computeCompositeScore(lowFusion, now, fusionMax),
    );
  });

  it('boosts frequently accessed memories', () => {
    const now = Date.now();
    const base = {
      fusionScore: 0.5,
      compositeScore: 0,
      created_at: now,
      importance: 0.5,
      last_accessed_at: now,
    };

    const accessed = {
      ...makeMemory({ access_count: 10 }),
      ...base,
    } as ScoredMemory;
    const notAccessed = {
      ...makeMemory({ access_count: 0 }),
      ...base,
    } as ScoredMemory;

    expect(computeCompositeScore(accessed, now)).toBeGreaterThan(computeCompositeScore(notAccessed, now));
  });
});

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('filterByRelevance', () => {
  it('drops candidates with low fusion scores', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), fusionScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b' }), fusionScore: 0.2, compositeScore: 0.4 },
      { ...makeMemory({ id: 'c' }), fusionScore: 0.01, compositeScore: 0.3 },
    ];

    const filtered = filterByRelevance(memories, 0.5);
    // threshold = 0.5 * 0.05 = 0.025 → c (0.01) is dropped
    expect(filtered).toHaveLength(2);
    expect(filtered.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('uses provided fusionMax for threshold', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), fusionScore: 0.05, compositeScore: 0.8 },
      { ...makeMemory({ id: 'b' }), fusionScore: 0.5, compositeScore: 0.6 },
      { ...makeMemory({ id: 'c' }), fusionScore: 0.005, compositeScore: 0.4 },
    ];

    const filtered = filterByRelevance(memories, 0.5);
    // threshold = 0.5 * 0.05 = 0.025 → c (0.005) is dropped, a (0.05) kept
    expect(filtered).toHaveLength(2);
    expect(filtered.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('keeps all when scores are close', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), fusionScore: 0.1, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b' }), fusionScore: 0.08, compositeScore: 0.4 },
    ];

    const filtered = filterByRelevance(memories, 0.1);
    expect(filtered).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(filterByRelevance([], 0)).toHaveLength(0);
  });
});

describe('filterByRerankerScore', () => {
  it('keeps candidates within score gap of the best', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), fusionScore: 0.5, compositeScore: 0.5, rerankerScore: 5 },
      { ...makeMemory({ id: 'b' }), fusionScore: 0.4, compositeScore: 0.4, rerankerScore: 2 },
      { ...makeMemory({ id: 'c' }), fusionScore: 0.3, compositeScore: 0.3, rerankerScore: -1 },
      { ...makeMemory({ id: 'd' }), fusionScore: 0.2, compositeScore: 0.2, rerankerScore: -3 },
    ];
    // Gap of 5 from best (5): keeps scores >= 0, so a, b pass; c(-1) and d(-3) fail
    // But MIN_RERANKER_RESULTS = 5 > 2 passing, so keeps top 5 (only 4 here → all kept)
    const filtered = filterByRerankerScore(memories);
    expect(filtered).toHaveLength(4);
  });

  it('drops candidates far below the best score', () => {
    const memories: ScoredMemory[] = Array.from({ length: 10 }, (_, i) => ({
      ...makeMemory({ id: `m${i}` }),
      fusionScore: 0.5,
      compositeScore: 0.5,
      rerankerScore: 10 - i * 2, // 10, 8, 6, 4, 2, 0, -2, -4, -6, -8
    }));
    const filtered = filterByRerankerScore(memories);
    // Gap of 5 from best (10): keeps scores >= 5, i.e. indices 0-2 (3 items)
    // MIN_RERANKER_RESULTS = 5 > 3 passing, so keeps top 5
    expect(filtered).toHaveLength(5);
    expect(filtered.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('returns all passing when more than MIN_RERANKER_RESULTS pass', () => {
    const memories: ScoredMemory[] = Array.from({ length: 10 }, (_, i) => ({
      ...makeMemory({ id: `m${i}` }),
      fusionScore: 0.5,
      compositeScore: 0.5,
      rerankerScore: 10 - i, // 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
    }));
    const filtered = filterByRerankerScore(memories);
    // Gap of 5 from best (10): keeps scores >= 5, i.e. indices 0-5 (6 items)
    expect(filtered).toHaveLength(6);
  });

  it('passes through unchanged when no reranker scores', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), fusionScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b' }), fusionScore: 0.4, compositeScore: 0.4 },
    ];
    const filtered = filterByRerankerScore(memories);
    expect(filtered).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(filterByRerankerScore([])).toHaveLength(0);
  });
});

describe('packToBudget', () => {
  it('selects memories within budget', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ content: 'a'.repeat(100) }), fusionScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b', content: 'b'.repeat(100) }), fusionScore: 0.4, compositeScore: 0.4 },
      { ...makeMemory({ id: 'c', content: 'c'.repeat(100) }), fusionScore: 0.3, compositeScore: 0.3 },
    ];

    // Budget for ~2 memories (100 chars = 25 tokens each)
    const selected = packToBudget(memories, 50);
    expect(selected).toHaveLength(2);
  });

  it('skips large memories and picks smaller ones', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ content: 'x'.repeat(400) }), fusionScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'small', content: 'small' }), fusionScore: 0.3, compositeScore: 0.3 },
    ];

    // Budget too small for the first but enough for the second
    const selected = packToBudget(memories, 10);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('small');
  });

  it('returns empty for zero budget', () => {
    const memories: ScoredMemory[] = [{ ...makeMemory(), fusionScore: 0.5, compositeScore: 0.5 }];
    expect(packToBudget(memories, 0)).toHaveLength(0);
  });
});
