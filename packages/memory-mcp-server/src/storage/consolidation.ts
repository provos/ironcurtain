/**
 * Deferred batch consolidation -- resolves duplicates and contradictions
 * among recently stored memories using a single batched LLM call.
 */

import type Database from 'better-sqlite3';
import type { MemoryConfig } from '../config.js';
import {
  getUnconsolidatedMemories,
  markConsolidated,
  vectorSearch,
  getEmbeddingsForMemories,
  updateMemoryTimestamp,
  updateMemoryContent,
  deleteMemory,
} from './queries.js';
import { cosineSimilarity } from '../embedding/embedder.js';
import { getLLMClient, batchJudgeMemoryRelations } from '../llm/client.js';
import type { CandidatePair, BatchJudgment } from '../llm/client.js';
import { EXACT_DEDUP_DISTANCE } from './constants.js';

const DEDUP_DISTANCE_THRESHOLD = 0.3;
const INTRA_BATCH_SIMILARITY = 0.7;

/**
 * Run the consolidation phase: find unconsolidated memories, group with
 * close existing memories, batch-judge via LLM, and apply merges/supersedes.
 */
export async function runConsolidation(
  db: Database.Database,
  config: MemoryConfig,
): Promise<{ consolidated: number; merged: number; superseded: number }> {
  const unconsolidated = getUnconsolidatedMemories(db, config.namespace, config.consolidationBatchSize);

  if (unconsolidated.length === 0) {
    return { consolidated: 0, merged: 0, superseded: 0 };
  }

  // If no LLM configured, just mark everything consolidated
  if (!getLLMClient(config)) {
    markConsolidated(
      db,
      config.namespace,
      unconsolidated.map((m) => m.id),
    );
    return { consolidated: unconsolidated.length, merged: 0, superseded: 0 };
  }

  // Load all unconsolidated embeddings from DB once (they were stored at insert time)
  const unconsolidatedIds = new Set(unconsolidated.map((m) => m.id));
  const embeddings = getEmbeddingsForMemories(db, config.namespace, [...unconsolidatedIds]);

  // Build candidate pairs: for each unconsolidated memory, find close existing memories
  const pairs: CandidatePair[] = [];

  for (const mem of unconsolidated) {
    const memEmbedding = embeddings.get(mem.id);
    if (!memEmbedding) continue;
    const candidates = vectorSearch(db, config.namespace, memEmbedding, 5);

    for (const candidate of candidates) {
      if (candidate.id === mem.id) continue;
      // Only compare against consolidated existing memories
      if (unconsolidatedIds.has(candidate.id)) continue;
      if (candidate.distance >= DEDUP_DISTANCE_THRESHOLD) continue;
      // Skip exact-dedup band (already handled at store time)
      if (candidate.distance < EXACT_DEDUP_DISTANCE) continue;

      pairs.push({
        newId: mem.id,
        newContent: mem.content,
        existingId: candidate.id,
        existingContent: candidate.content,
      });
    }
  }

  // Also check intra-batch similarities (unconsolidated vs unconsolidated)
  if (unconsolidated.length > 1) {
    for (let i = 0; i < unconsolidated.length; i++) {
      const embA = embeddings.get(unconsolidated[i].id);
      if (!embA) continue;
      for (let j = i + 1; j < unconsolidated.length; j++) {
        const embB = embeddings.get(unconsolidated[j].id);
        if (!embB) continue;
        if (cosineSimilarity(embA, embB) > INTRA_BATCH_SIMILARITY) {
          pairs.push({
            newId: unconsolidated[j].id,
            newContent: unconsolidated[j].content,
            existingId: unconsolidated[i].id,
            existingContent: unconsolidated[i].content,
          });
        }
      }
    }
  }

  // Batch-judge all pairs in one (or few) LLM calls
  let judgments: BatchJudgment[] = [];
  if (pairs.length > 0) {
    judgments = await batchJudgeMemoryRelations(config, pairs);
  }

  // Apply judgments
  let merged = 0;
  let superseded = 0;
  const consumed = new Set<string>();

  for (const judgment of judgments) {
    if (judgment.pairIndex >= pairs.length) continue;
    const pair = pairs[judgment.pairIndex];
    if (consumed.has(pair.newId)) continue;

    if (judgment.relation === 'duplicate') {
      updateMemoryTimestamp(db, config.namespace, pair.existingId);
      deleteMemory(db, config.namespace, pair.newId);
      consumed.add(pair.newId);
      merged++;
    } else if (judgment.relation === 'contradiction') {
      // Reuse embedding from DB instead of re-computing
      const newEmbedding = embeddings.get(pair.newId);
      if (newEmbedding) {
        updateMemoryContent(
          db,
          config.namespace,
          pair.existingId,
          pair.newContent,
          newEmbedding,
          0.5,
          pair.existingContent,
        );
      }
      deleteMemory(db, config.namespace, pair.newId);
      consumed.add(pair.newId);
      superseded++;
    }
  }

  // Mark all surviving unconsolidated memories as consolidated
  const survivingIds = unconsolidated.map((m) => m.id).filter((id) => !consumed.has(id));
  markConsolidated(db, config.namespace, survivingIds);

  return { consolidated: unconsolidated.length, merged, superseded };
}
