import { describe, it, expect } from 'vitest';
import type { ScoredMemory } from '../src/retrieval/scoring.js';
import { deduplicateByEmbedding, clusterByEmbeddingSimilarity } from '../src/retrieval/dedup.js';
import { EMBEDDING_DIMENSIONS } from '../src/storage/database.js';

function makeScoredMemory(id: string, content: string = 'test'): ScoredMemory {
  const now = Date.now();
  return {
    id,
    namespace: 'test',
    content,
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
    fusionScore: 0.5,
    compositeScore: 0.5,
  };
}

function normalizedVector(seed: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    arr[i] = Math.sin(seed * (i + 1));
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) arr[i] /= norm;
  return arr;
}

describe('deduplicateByEmbedding', () => {
  it('removes exact duplicates (identical embeddings)', () => {
    const emb = normalizedVector(1);
    const memories = [makeScoredMemory('a'), makeScoredMemory('b')];
    const embeddings = new Map([
      ['a', emb],
      ['b', new Float32Array(emb)], // identical copy
    ]);

    const { kept, removed } = deduplicateByEmbedding(memories, embeddings);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('a');
    expect(removed).toBe(1);
  });

  it('keeps distinct memories', () => {
    const memories = [makeScoredMemory('a'), makeScoredMemory('b')];
    const embeddings = new Map([
      ['a', normalizedVector(1)],
      ['b', normalizedVector(100)], // very different
    ]);

    const { kept, removed } = deduplicateByEmbedding(memories, embeddings);
    expect(kept).toHaveLength(2);
    expect(removed).toBe(0);
  });

  it('keeps memories without embeddings', () => {
    const memories = [makeScoredMemory('a')];
    const embeddings = new Map<string, Float32Array>(); // no embeddings

    const { kept } = deduplicateByEmbedding(memories, embeddings);
    expect(kept).toHaveLength(1);
  });

  it('respects custom threshold', () => {
    // Use two moderately different vectors (different seeds)
    const emb1 = normalizedVector(1);
    const emb2 = normalizedVector(2);

    const memories = [makeScoredMemory('a'), makeScoredMemory('b')];
    const embeddings = new Map([
      ['a', emb1],
      ['b', emb2],
    ]);

    // High threshold (0.99): moderately different vectors should be kept
    const high = deduplicateByEmbedding(memories, embeddings, 0.99);
    expect(high.kept).toHaveLength(2);

    // Very low threshold (0.0): everything looks like a duplicate
    const low = deduplicateByEmbedding(memories, embeddings, 0.0);
    expect(low.kept).toHaveLength(1);
  });
});

describe('clusterByEmbeddingSimilarity', () => {
  it('clusters similar memories together', () => {
    const emb = normalizedVector(1);
    const memories = [makeScoredMemory('a'), makeScoredMemory('b'), makeScoredMemory('c')];
    const embeddings = new Map([
      ['a', emb],
      ['b', new Float32Array(emb)], // identical to a
      ['c', normalizedVector(100)], // different
    ]);

    const clusters = clusterByEmbeddingSimilarity(memories, embeddings, 0.9);
    // a and b should cluster together; c is separate
    expect(clusters).toHaveLength(2);
    const bigCluster = clusters.find((c) => c.length === 2);
    const smallCluster = clusters.find((c) => c.length === 1);
    expect(bigCluster).toBeDefined();
    expect(smallCluster).toBeDefined();
    expect(smallCluster![0].id).toBe('c');
  });

  it('puts each memory in its own cluster when all are different', () => {
    const memories = [makeScoredMemory('a'), makeScoredMemory('b'), makeScoredMemory('c')];
    const embeddings = new Map([
      ['a', normalizedVector(1)],
      ['b', normalizedVector(100)],
      ['c', normalizedVector(200)],
    ]);

    const clusters = clusterByEmbeddingSimilarity(memories, embeddings, 0.9);
    expect(clusters).toHaveLength(3);
  });
});
