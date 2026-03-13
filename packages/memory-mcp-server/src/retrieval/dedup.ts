import type { ScoredMemory } from './scoring.js';
import { cosineSimilarity } from '../embedding/embedder.js';
import { clusterByEmbedding } from '../utils/clustering.js';

export { clusterByEmbedding };

export interface DedupResult {
  kept: ScoredMemory[];
  removed: number;
}

/**
 * Remove near-duplicate memories from a scored list.
 * Keeps the first encountered memory in each duplicate group (i.e. the
 * higher-ranked one, since input is expected to be pre-sorted by score).
 *
 * @param threshold - cosine similarity above which two memories are considered duplicates (default 0.95)
 */
export function deduplicateByEmbedding(
  memories: ScoredMemory[],
  embeddings: Map<string, Float32Array>,
  threshold: number = 0.95,
): DedupResult {
  const kept: ScoredMemory[] = [];
  let removed = 0;

  for (const mem of memories) {
    const memEmb = embeddings.get(mem.id);
    if (!memEmb) {
      kept.push(mem);
      continue;
    }

    const isDuplicate = kept.some((k) => {
      const kEmb = embeddings.get(k.id);
      if (!kEmb) return false;
      return cosineSimilarity(kEmb, memEmb) > threshold;
    });

    if (isDuplicate) {
      removed++;
    } else {
      kept.push(mem);
    }
  }

  return { kept, removed };
}

/**
 * Cluster memories by embedding similarity using a greedy single-linkage approach.
 * Returns groups of related memories for extractive summarization.
 */
export function clusterByEmbeddingSimilarity(
  memories: ScoredMemory[],
  embeddings: Map<string, Float32Array>,
  threshold: number = 0.8,
): ScoredMemory[][] {
  return clusterByEmbedding(memories, embeddings, threshold);
}
