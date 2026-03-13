import type Database from 'better-sqlite3';
import type { MemoryRow } from './database.js';
import type { MemoryConfig } from '../config.js';
import { getDecayedUncompacted, markCompacted, getEmbeddingsForMemories, generateId, insertMemory } from './queries.js';
import { embed } from '../embedding/embedder.js';
import { llmComplete } from '../llm/client.js';
import { clusterByEmbedding } from '../utils/clustering.js';
import { parseTags } from '../utils/tags.js';

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
  const embeddings = getEmbeddingsForMemories(db, config.namespace, ids);

  // Cluster by embedding similarity
  const clusters = clusterByEmbedding(decayed, embeddings, CLUSTER_THRESHOLD);

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
    const mergedTags = [...new Set(cluster.flatMap((m) => parseTags(m.tags)))];

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

    // Mark source memories as compacted
    markCompacted(db, config.namespace, clusterIds);
    totalCompacted += clusterIds.length;
  }

  return totalCompacted;
}

async function compactCluster(memories: MemoryRow[], config: MemoryConfig): Promise<string | null> {
  const memoriesText = memories
    .map((m) => `- (${new Date(m.created_at).toISOString().slice(0, 10)}) ${m.content}`)
    .join('\n');

  // Try LLM abstractive compaction
  const llmSummary = await llmComplete(
    config,
    `You are a memory compaction assistant. Consolidate the related memories provided within <memories> tags ` +
      `into a single concise summary that preserves all key facts, specific details ` +
      `(names, dates, numbers), and actionable information. The summary should be ` +
      `self-contained and useful without access to the original memories.`,
    `<memories>\n${memoriesText}\n</memories>`,
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
