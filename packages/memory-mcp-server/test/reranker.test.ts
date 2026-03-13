import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryRow } from '../src/storage/database.js';
import type { ScoredMemory } from '../src/retrieval/scoring.js';
import { rerank, resetReranker } from '../src/retrieval/reranker.js';
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

// Mock transformers with AutoTokenizer and AutoModelForSequenceClassification
const mockTokenizer = vi.fn();
const mockModel = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: vi.fn().mockResolvedValue(mockTokenizer),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: vi.fn().mockResolvedValue(mockModel),
  },
}));

describe('rerank', () => {
  beforeEach(() => {
    resetReranker();
    mockTokenizer.mockReset();
    mockModel.mockReset();
    // Default: tokenizer returns a dummy inputs object
    mockTokenizer.mockReturnValue({ input_ids: 'mock' });
  });

  it('returns empty array for empty candidates', async () => {
    const result = await rerank('query', [], makeConfig());
    expect(result).toEqual([]);
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('returns candidates unchanged when reranker is disabled', async () => {
    const candidates = [makeScored({ id: 'a', content: 'first' }), makeScored({ id: 'b', content: 'second' })];
    const config = makeConfig({ rerankerEnabled: false });

    const result = await rerank('query', candidates, config);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('sorts candidates by cross-encoder logit score', async () => {
    const candidates = [
      makeScored({ id: 'a', content: 'less relevant' }),
      makeScored({ id: 'b', content: 'more relevant' }),
      makeScored({ id: 'c', content: 'most relevant' }),
    ];

    // Model returns logits: a=-5, b=2, c=8
    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([-5, 2, 8]), dims: [3, 1] },
    });

    const result = await rerank('query', candidates, makeConfig());

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('c');
    expect(result[0].rerankerScore).toBe(8);
    expect(result[1].id).toBe('b');
    expect(result[1].rerankerScore).toBe(2);
    expect(result[2].id).toBe('a');
    expect(result[2].rerankerScore).toBe(-5);
  });

  it('passes correct query and passage arrays to tokenizer', async () => {
    const candidates = [
      makeScored({ id: 'a', content: 'passage one' }),
      makeScored({ id: 'b', content: 'passage two' }),
    ];

    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([1, 2]), dims: [2, 1] },
    });

    await rerank('my query', candidates, makeConfig());

    expect(mockTokenizer).toHaveBeenCalledWith(['my query', 'my query'], {
      text_pair: ['passage one', 'passage two'],
      padding: true,
      truncation: true,
    });
  });

  it('does not mutate original candidates', async () => {
    const candidates = [makeScored({ id: 'a', content: 'first' }), makeScored({ id: 'b', content: 'second' })];

    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([0.3, 0.8]), dims: [2, 1] },
    });

    const result = await rerank('query', candidates, makeConfig());

    // Original array order unchanged
    expect(candidates[0].id).toBe('a');
    expect(candidates[1].id).toBe('b');
    expect(candidates[0].rerankerScore).toBeUndefined();

    // Result is re-sorted
    expect(result[0].id).toBe('b');
    expect(result[0].rerankerScore).toBeCloseTo(0.8);
  });

  it('caches the model across calls', async () => {
    const transformers = await import('@huggingface/transformers');
    const candidates = [makeScored({ id: 'a', content: 'test' })];

    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([1]), dims: [1, 1] },
    });

    // Clear counts from prior tests, reset singleton
    (transformers.AutoModelForSequenceClassification.from_pretrained as ReturnType<typeof vi.fn>).mockClear();
    resetReranker();

    const config = makeConfig();
    await rerank('query1', candidates, config);
    await rerank('query2', candidates, config);

    // Model loaded only once
    expect(transformers.AutoModelForSequenceClassification.from_pretrained).toHaveBeenCalledTimes(1);
  });
});
