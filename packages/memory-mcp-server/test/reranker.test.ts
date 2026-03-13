import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryRow } from '../src/storage/database.js';
import type { ScoredMemory } from '../src/retrieval/scoring.js';
import { rerank, extractScores, resetReranker } from '../src/retrieval/reranker.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';

function makeScored(overrides: Partial<MemoryRow & ScoredMemory> = {}): ScoredMemory {
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
    rrfScore: overrides.rrfScore ?? 0.5,
    compositeScore: overrides.compositeScore ?? 0.5,
    vectorDistance: overrides.vectorDistance,
  };
}

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...loadConfig({}), ...overrides };
}

// Mock the transformers import at module level
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
}));

describe('extractScores', () => {
  it('handles flat results from a single pair', () => {
    const results = [{ label: 'LABEL_0', score: 0.85 }];
    expect(extractScores(results, 1)).toEqual([0.85]);
  });

  it('handles nested results from a batch', () => {
    const results = [
      [{ label: 'LABEL_0', score: 0.9 }],
      [{ label: 'LABEL_0', score: 0.3 }],
      [{ label: 'LABEL_0', score: 0.7 }],
    ];
    expect(extractScores(results, 3)).toEqual([0.9, 0.3, 0.7]);
  });

  it('handles flat results from a batch (multiple pairs)', () => {
    const results = [
      { label: 'LABEL_0', score: 0.9 },
      { label: 'LABEL_0', score: 0.3 },
    ];
    expect(extractScores(results, 2)).toEqual([0.9, 0.3]);
  });

  it('returns empty array for zero expected length', () => {
    expect(extractScores([], 0)).toEqual([]);
  });

  it('defaults missing scores to 0', () => {
    const results = [[{ label: 'LABEL_0', score: 0.5 }], []];
    expect(extractScores(results, 2)).toEqual([0.5, 0]);
  });
});

describe('rerank', () => {
  let mockClassifier: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetReranker();
    const transformers = await import('@huggingface/transformers');
    mockClassifier = vi.fn();
    (transformers.pipeline as ReturnType<typeof vi.fn>).mockResolvedValue(mockClassifier);
  });

  it('returns empty array for empty candidates', async () => {
    const result = await rerank('query', [], makeConfig());
    expect(result).toEqual([]);
    expect(mockClassifier).not.toHaveBeenCalled();
  });

  it('returns candidates unchanged when reranker is disabled', async () => {
    const candidates = [makeScored({ id: 'a', content: 'first' }), makeScored({ id: 'b', content: 'second' })];
    const config = makeConfig({ rerankerEnabled: false });

    const result = await rerank('query', candidates, config);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
    expect(mockClassifier).not.toHaveBeenCalled();
  });

  it('sorts candidates by cross-encoder score', async () => {
    const candidates = [
      makeScored({ id: 'a', content: 'less relevant' }),
      makeScored({ id: 'b', content: 'more relevant' }),
      makeScored({ id: 'c', content: 'most relevant' }),
    ];

    // Cross-encoder says c > b > a
    mockClassifier.mockResolvedValue([
      [{ label: 'LABEL_0', score: 0.1 }],
      [{ label: 'LABEL_0', score: 0.5 }],
      [{ label: 'LABEL_0', score: 0.9 }],
    ]);

    const result = await rerank('query', candidates, makeConfig());

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('c');
    expect(result[1].id).toBe('b');
    expect(result[2].id).toBe('a');
  });

  it('sets rerankerScore on each candidate', async () => {
    const candidates = [makeScored({ id: 'a', content: 'test' })];

    mockClassifier.mockResolvedValue([{ label: 'LABEL_0', score: 0.75 }]);

    const result = await rerank('query', candidates, makeConfig());

    expect(result[0].rerankerScore).toBe(0.75);
  });

  it('passes correct (query, passage) pairs to the model', async () => {
    const candidates = [
      makeScored({ id: 'a', content: 'passage one' }),
      makeScored({ id: 'b', content: 'passage two' }),
    ];

    mockClassifier.mockResolvedValue([[{ label: 'LABEL_0', score: 0.6 }], [{ label: 'LABEL_0', score: 0.4 }]]);

    await rerank('my query', candidates, makeConfig());

    expect(mockClassifier).toHaveBeenCalledWith(
      [
        ['my query', 'passage one'],
        ['my query', 'passage two'],
      ],
      { top_k: 1 },
    );
  });

  it('does not mutate original candidates', async () => {
    const candidates = [makeScored({ id: 'a', content: 'first' }), makeScored({ id: 'b', content: 'second' })];

    mockClassifier.mockResolvedValue([[{ label: 'LABEL_0', score: 0.3 }], [{ label: 'LABEL_0', score: 0.8 }]]);

    const result = await rerank('query', candidates, makeConfig());

    // Original array order unchanged
    expect(candidates[0].id).toBe('a');
    expect(candidates[1].id).toBe('b');
    // Original objects don't have rerankerScore
    expect(candidates[0].rerankerScore).toBeUndefined();

    // Result has rerankerScore
    expect(result[0].rerankerScore).toBe(0.8);
  });

  it('caches the model pipeline across calls', async () => {
    const transformers = await import('@huggingface/transformers');
    const candidates = [makeScored({ id: 'a', content: 'test' })];
    mockClassifier.mockResolvedValue([[{ label: 'LABEL_0', score: 0.5 }]]);

    // Reset call count from prior tests, then make two rerank calls
    (transformers.pipeline as ReturnType<typeof vi.fn>).mockClear();
    resetReranker();

    const config = makeConfig();
    await rerank('query1', candidates, config);
    await rerank('query2', candidates, config);

    // pipeline() should be called only once (singleton)
    expect(transformers.pipeline).toHaveBeenCalledTimes(1);
  });
});
