import { cosineSimilarity } from '../embedding/embedder.js';

/**
 * Cluster items by embedding similarity using a greedy single-linkage approach.
 * Each item is assigned to the first cluster whose seed embedding exceeds the threshold.
 * Items without embeddings are placed in their own singleton cluster.
 */
export function clusterByEmbedding<T extends { id: string }>(
  items: T[],
  embeddings: Map<string, Float32Array>,
  threshold: number,
): T[][] {
  const clusters: T[][] = [];
  const assigned = new Set<string>();

  for (const item of items) {
    if (assigned.has(item.id)) continue;

    const itemEmb = embeddings.get(item.id);
    if (!itemEmb) {
      clusters.push([item]);
      assigned.add(item.id);
      continue;
    }

    const cluster: T[] = [item];
    assigned.add(item.id);

    for (const other of items) {
      if (assigned.has(other.id)) continue;
      const otherEmb = embeddings.get(other.id);
      if (!otherEmb) continue;

      if (cosineSimilarity(itemEmb, otherEmb) > threshold) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}
