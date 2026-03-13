import { describe, it, expect } from 'vitest';
import type { MemoryRow, VectorSearchResult } from '../src/storage/database.js';
import {
  reciprocalRankFusion,
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
    compacted_from: overrides.compacted_from ?? null,
    source: overrides.source ?? null,
    metadata: overrides.metadata ?? null,
  };
}

function makeVectorResult(overrides: Partial<MemoryRow> = {}, distance = 0.5): VectorSearchResult {
  return { ...makeMemory(overrides), distance };
}

describe('reciprocalRankFusion', () => {
  it('merges results from both sources', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.3);
    const m2 = makeVectorResult({ id: 'b' }, 0.4);
    const m3 = makeMemory({ id: 'c' });

    const allMemories = new Map<string, MemoryRow>([
      ['a', m1],
      ['b', m2],
      ['c', m3],
    ]);

    const vectorResults = [m1, m2]; // a at rank 0, b at rank 1
    const ftsResults = [m2, m3]; // b at rank 0, c at rank 1

    const { scored, rrfMax } = reciprocalRankFusion(vectorResults, ftsResults, allMemories);

    expect(scored.length).toBe(3);
    // b appears in both lists, so should have highest RRF score
    expect(scored[0].id).toBe('b');
    expect(rrfMax).toBe(scored[0].rrfScore);
  });

  it('handles empty result sets', () => {
    const { scored, rrfMax } = reciprocalRankFusion([], [], new Map());
    expect(scored).toHaveLength(0);
    expect(rrfMax).toBe(0);
  });

  it('handles single-source results', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.3);
    const allMemories = new Map<string, MemoryRow>([['a', m1]]);

    const { scored } = reciprocalRankFusion([m1], [], allMemories);
    expect(scored).toHaveLength(1);
    expect(scored[0].id).toBe('a');
    expect(scored[0].rrfScore).toBeGreaterThan(0);
  });

  it('preserves vector distances on scored results', () => {
    const m1 = makeVectorResult({ id: 'a' }, 0.2);
    const m2 = makeVectorResult({ id: 'b' }, 0.7);
    const m3 = makeMemory({ id: 'c' }); // FTS-only

    const allMemories = new Map<string, MemoryRow>([
      ['a', m1],
      ['b', m2],
      ['c', m3],
    ]);

    const { scored } = reciprocalRankFusion([m1, m2], [m3], allMemories);
    const byId = new Map(scored.map((r) => [r.id, r]));

    expect(byId.get('a')!.vectorDistance).toBe(0.2);
    expect(byId.get('b')!.vectorDistance).toBe(0.7);
    expect(byId.get('c')!.vectorDistance).toBeUndefined();
  });
});

describe('computeCompositeScore', () => {
  it('gives higher score to more recent memories', () => {
    const now = Date.now();
    const recent = {
      ...makeMemory({ created_at: now - 3600000 }), // 1 hour ago
      rrfScore: 0.01,
      compositeScore: 0,
    } as ScoredMemory;

    const old = {
      ...makeMemory({ created_at: now - 30 * 24 * 3600000 }), // 30 days ago
      rrfScore: 0.01,
      compositeScore: 0,
    } as ScoredMemory;

    expect(computeCompositeScore(recent, now)).toBeGreaterThan(computeCompositeScore(old, now));
  });

  it('gives higher score to more important memories', () => {
    const now = Date.now();
    const base = {
      rrfScore: 0.01,
      compositeScore: 0,
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
    };

    const important = { ...makeMemory({ importance: 0.9 }), ...base } as ScoredMemory;
    const unimportant = { ...makeMemory({ importance: 0.1 }), ...base } as ScoredMemory;

    expect(computeCompositeScore(important, now)).toBeGreaterThan(computeCompositeScore(unimportant, now));
  });

  it('gives higher score to memories with closer vector distance', () => {
    const now = Date.now();
    const base = {
      rrfScore: 0.01,
      compositeScore: 0,
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
      importance: 0.5,
    };

    const close = { ...makeMemory(), ...base, vectorDistance: 0.2 } as ScoredMemory;
    const far = { ...makeMemory(), ...base, vectorDistance: 0.8 } as ScoredMemory;

    const rrfMax = 0.01;
    expect(computeCompositeScore(close, now, rrfMax)).toBeGreaterThan(computeCompositeScore(far, now, rrfMax));
  });

  it('does not penalize FTS-only results vs distant vector results', () => {
    const now = Date.now();
    const base = {
      rrfScore: 0.01,
      compositeScore: 0,
      created_at: now,
      last_accessed_at: now,
      access_count: 0,
      importance: 0.5,
    };

    const far = { ...makeMemory(), ...base, vectorDistance: 0.8 } as ScoredMemory;
    const ftsOnly = { ...makeMemory(), ...base } as ScoredMemory;

    const rrfMax = 0.01;
    // FTS-only gets more RRF weight, so should score >= distant vector result
    expect(computeCompositeScore(ftsOnly, now, rrfMax)).toBeGreaterThanOrEqual(computeCompositeScore(far, now, rrfMax));
  });

  it('boosts frequently accessed memories', () => {
    const now = Date.now();
    const base = {
      rrfScore: 0.01,
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
  it('drops candidates with low RRF scores', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), rrfScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b' }), rrfScore: 0.2, compositeScore: 0.4 },
      { ...makeMemory({ id: 'c' }), rrfScore: 0.05, compositeScore: 0.3 },
    ];

    const filtered = filterByRelevance(memories, 0.5);
    // threshold = 0.5 * 0.2 = 0.1 → c (0.05) is dropped
    expect(filtered).toHaveLength(2);
    expect(filtered.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('uses provided rrfMax for threshold', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), rrfScore: 0.05, compositeScore: 0.8 },
      { ...makeMemory({ id: 'b' }), rrfScore: 0.5, compositeScore: 0.6 },
      { ...makeMemory({ id: 'c' }), rrfScore: 0.02, compositeScore: 0.4 },
    ];

    const filtered = filterByRelevance(memories, 0.5);
    // threshold = 0.5 * 0.2 = 0.1 → both a (0.05) and c (0.02) dropped
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('b');
  });

  it('keeps all when scores are close', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), rrfScore: 0.1, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b' }), rrfScore: 0.08, compositeScore: 0.4 },
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
      { ...makeMemory({ id: 'a' }), rrfScore: 0.5, compositeScore: 0.5, rerankerScore: 5 },
      { ...makeMemory({ id: 'b' }), rrfScore: 0.4, compositeScore: 0.4, rerankerScore: 2 },
      { ...makeMemory({ id: 'c' }), rrfScore: 0.3, compositeScore: 0.3, rerankerScore: -1 },
      { ...makeMemory({ id: 'd' }), rrfScore: 0.2, compositeScore: 0.2, rerankerScore: -3 },
    ];
    // Gap of 5 from best (5): keeps scores >= 0, so a, b pass; c(-1) and d(-3) fail
    // But MIN_RERANKER_RESULTS = 5 > 2 passing, so keeps top 5 (only 4 here → all kept)
    const filtered = filterByRerankerScore(memories);
    expect(filtered).toHaveLength(4);
  });

  it('drops candidates far below the best score', () => {
    const memories: ScoredMemory[] = Array.from({ length: 10 }, (_, i) => ({
      ...makeMemory({ id: `m${i}` }),
      rrfScore: 0.5,
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
      rrfScore: 0.5,
      compositeScore: 0.5,
      rerankerScore: 10 - i, // 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
    }));
    const filtered = filterByRerankerScore(memories);
    // Gap of 5 from best (10): keeps scores >= 5, i.e. indices 0-5 (6 items)
    expect(filtered).toHaveLength(6);
  });

  it('passes through unchanged when no reranker scores', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), rrfScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b' }), rrfScore: 0.4, compositeScore: 0.4 },
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
      { ...makeMemory({ content: 'a'.repeat(100) }), rrfScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b', content: 'b'.repeat(100) }), rrfScore: 0.4, compositeScore: 0.4 },
      { ...makeMemory({ id: 'c', content: 'c'.repeat(100) }), rrfScore: 0.3, compositeScore: 0.3 },
    ];

    // Budget for ~2 memories (100 chars = 25 tokens each)
    const selected = packToBudget(memories, 50);
    expect(selected).toHaveLength(2);
  });

  it('skips large memories and picks smaller ones', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ content: 'x'.repeat(400) }), rrfScore: 0.5, compositeScore: 0.5 },
      { ...makeMemory({ id: 'small', content: 'small' }), rrfScore: 0.3, compositeScore: 0.3 },
    ];

    // Budget too small for the first but enough for the second
    const selected = packToBudget(memories, 10);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('small');
  });

  it('returns empty for zero budget', () => {
    const memories: ScoredMemory[] = [{ ...makeMemory(), rrfScore: 0.5, compositeScore: 0.5 }];
    expect(packToBudget(memories, 0)).toHaveLength(0);
  });
});
