import { describe, it, expect } from 'vitest';
import type { MemoryRow } from '../src/storage/database.js';
import {
  reciprocalRankFusion,
  computeCompositeScore,
  estimateTokens,
  filterByRelevance,
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

describe('reciprocalRankFusion', () => {
  it('merges results from both sources', () => {
    const m1 = makeMemory({ id: 'a' });
    const m2 = makeMemory({ id: 'b' });
    const m3 = makeMemory({ id: 'c' });

    const allMemories = new Map<string, MemoryRow>([
      ['a', m1],
      ['b', m2],
      ['c', m3],
    ]);

    const vectorResults = [m1, m2]; // a at rank 0, b at rank 1
    const ftsResults = [m2, m3]; // b at rank 0, c at rank 1

    const result = reciprocalRankFusion(vectorResults, ftsResults, allMemories);

    expect(result.length).toBe(3);
    // b appears in both lists, so should have highest RRF score
    expect(result[0].id).toBe('b');
  });

  it('handles empty result sets', () => {
    const result = reciprocalRankFusion([], [], new Map());
    expect(result).toHaveLength(0);
  });

  it('handles single-source results', () => {
    const m1 = makeMemory({ id: 'a' });
    const allMemories = new Map([['a', m1]]);

    const result = reciprocalRankFusion([m1], [], allMemories);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
    expect(result[0].rrfScore).toBeGreaterThan(0);
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

    const filtered = filterByRelevance(memories);
    // threshold = 0.5 * 0.2 = 0.1 → c (0.05) is dropped
    expect(filtered).toHaveLength(2);
    expect(filtered.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('finds best RRF even when not first by compositeScore', () => {
    // Sorted by compositeScore (descending), but best rrfScore is not first
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), rrfScore: 0.05, compositeScore: 0.8 },
      { ...makeMemory({ id: 'b' }), rrfScore: 0.5, compositeScore: 0.6 },
      { ...makeMemory({ id: 'c' }), rrfScore: 0.02, compositeScore: 0.4 },
    ];

    const filtered = filterByRelevance(memories);
    // bestRrf = 0.5, threshold = 0.1 → both a (0.05) and c (0.02) dropped
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('b');
  });

  it('keeps all when scores are close', () => {
    const memories: ScoredMemory[] = [
      { ...makeMemory({ id: 'a' }), rrfScore: 0.1, compositeScore: 0.5 },
      { ...makeMemory({ id: 'b' }), rrfScore: 0.08, compositeScore: 0.4 },
    ];

    const filtered = filterByRelevance(memories);
    expect(filtered).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(filterByRelevance([])).toHaveLength(0);
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
