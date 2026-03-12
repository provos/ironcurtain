import type { ScoredMemory } from './scoring.js';
import { cosineSimilarity } from '../embedding/embedder.js';

export interface DedupResult {
  kept: ScoredMemory[];
  removed: number;
}

/**
 * Remove near-duplicate memories from a scored list.
 * Keeps the higher-scoring memory when a duplicate pair is found.
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
  const clusters: ScoredMemory[][] = [];
  const assigned = new Set<string>();

  for (const mem of memories) {
    if (assigned.has(mem.id)) continue;

    const memEmb = embeddings.get(mem.id);
    if (!memEmb) {
      clusters.push([mem]);
      assigned.add(mem.id);
      continue;
    }

    const cluster: ScoredMemory[] = [mem];
    assigned.add(mem.id);

    for (const other of memories) {
      if (assigned.has(other.id)) continue;
      const otherEmb = embeddings.get(other.id);
      if (!otherEmb) continue;

      if (cosineSimilarity(memEmb, otherEmb) > threshold) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}
