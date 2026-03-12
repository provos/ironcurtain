import type Database from 'better-sqlite3';
import type { MemoryRow } from './database.js';
import type { MemoryConfig } from '../config.js';
import { getDecayedUncompacted, markCompacted, getEmbeddingsForMemories, generateId, insertMemory } from './queries.js';
import { embed, cosineSimilarity } from '../embedding/embedder.js';
import { llmComplete } from '../llm/client.js';

const MAX_DECAYED_SCAN = 200;
const MIN_CLUSTER_SIZE = 3;
const CLUSTER_THRESHOLD = 0.7;
const COMPACTED_IMPORTANCE = 0.6;

/**
 * Run the compaction phase: cluster decayed memories by similarity,
 * summarize each cluster via LLM (or extractive fallback), and
 * create consolidated summary memories.
 *
 * Returns the number of source memories that were compacted.
 */
export async function runCompaction(db: Database.Database, config: MemoryConfig): Promise<number> {
  const decayed = getDecayedUncompacted(db, config.namespace, MAX_DECAYED_SCAN);

  if (decayed.length < config.compactionMinGroup) return 0;

  // Load embeddings for clustering
  const ids = decayed.map((m) => m.id);
  const embeddings = getEmbeddingsForMemories(db, ids);

  // Cluster by embedding similarity
  const clusters = clusterMemories(decayed, embeddings, CLUSTER_THRESHOLD);

  let totalCompacted = 0;

  for (const cluster of clusters) {
    if (cluster.length < MIN_CLUSTER_SIZE) continue;

    const summary = await compactCluster(cluster, config);
    if (!summary) continue;

    // Embed the summary
    const summaryEmbedding = await embed(summary, config);
    const summaryId = generateId();
    const clusterIds = cluster.map((m) => m.id);

    // Merge tags from all source memories
    const mergedTags = [...new Set(cluster.flatMap((m) => JSON.parse(m.tags ?? '[]') as string[]))];

    // Insert compacted summary
    insertMemory(
      db,
      {
        id: summaryId,
        namespace: config.namespace,
        content: summary,
        tags: mergedTags.length > 0 ? mergedTags : undefined,
        importance: COMPACTED_IMPORTANCE,
        source: 'compaction',
        metadata: { compacted_from: clusterIds },
      },
      summaryEmbedding,
    );

    // Update the is_compacted flag separately since insertMemory doesn't handle it
    db.prepare(`UPDATE memories SET is_compacted = 1 WHERE id = ?`).run(summaryId);
    // Actually we want the summary to NOT be marked as compacted.
    // The is_compacted=1 flag is for the sources, not the summary.
    db.prepare(`UPDATE memories SET is_compacted = 0 WHERE id = ?`).run(summaryId);

    // Mark source memories as compacted
    markCompacted(db, clusterIds);
    totalCompacted += clusterIds.length;
  }

  return totalCompacted;
}

function clusterMemories(
  memories: MemoryRow[],
  embeddings: Map<string, Float32Array>,
  threshold: number,
): MemoryRow[][] {
  const clusters: MemoryRow[][] = [];
  const assigned = new Set<string>();

  for (const mem of memories) {
    if (assigned.has(mem.id)) continue;

    const memEmb = embeddings.get(mem.id);
    if (!memEmb) {
      clusters.push([mem]);
      assigned.add(mem.id);
      continue;
    }

    const cluster: MemoryRow[] = [mem];
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

async function compactCluster(memories: MemoryRow[], config: MemoryConfig): Promise<string | null> {
  const memoriesText = memories
    .map((m) => `- (${new Date(m.created_at).toISOString().slice(0, 10)}) ${m.content}`)
    .join('\n');

  // Try LLM abstractive compaction
  const llmSummary = await llmComplete(
    config,
    `You are a memory compaction assistant. Consolidate the following related memories ` +
      `into a single concise summary that preserves all key facts, specific details ` +
      `(names, dates, numbers), and actionable information. The summary should be ` +
      `self-contained and useful without access to the original memories.`,
    `Memories to consolidate:\n${memoriesText}`,
    { maxTokens: 200 },
  );

  if (llmSummary) return llmSummary;

  // Extractive fallback: take the most-accessed memories
  return extractiveCompact(memories);
}

function extractiveCompact(memories: MemoryRow[]): string {
  const sorted = [...memories].sort((a, b) => b.access_count - a.access_count);

  const dates = memories.map((m) => m.created_at);
  const dateRange =
    new Date(Math.min(...dates)).toISOString().slice(0, 10) +
    ` to ${new Date(Math.max(...dates)).toISOString().slice(0, 10)}`;

  return (
    `[Consolidated ${memories.length} memories, ${dateRange}] ` +
    sorted
      .slice(0, 3)
      .map((m) => m.content)
      .join('. ')
  );
}
