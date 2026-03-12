import type Database from 'better-sqlite3';
import type { MemoryRow } from '../storage/database.js';
import type { MemoryConfig } from '../config.js';
import type { FormatMode } from './formatting.js';
import { vectorSearch, ftsSearch, updateAccessStats, getEmbeddingsForMemories } from '../storage/queries.js';
import { embed } from '../embedding/embedder.js';
import { reciprocalRankFusion, computeCompositeScore, packToBudget } from './scoring.js';
import { deduplicateByEmbedding } from './dedup.js';
import { formatMemories } from './formatting.js';

const DEFAULT_CANDIDATE_LIMIT = 50;

export interface RecallOptions {
  query: string;
  tokenBudget?: number;
  tags?: string[];
  format?: FormatMode;
}

export interface RecallResult {
  text: string;
  memoryIds: string[];
  totalCandidates: number;
  selectedCount: number;
}

/**
 * Full retrieval pipeline: embed query -> vector KNN -> FTS5 -> RRF merge ->
 * composite score -> dedup -> token budget pack -> format.
 */
export async function recall(
  db: Database.Database,
  config: MemoryConfig,
  options: RecallOptions,
): Promise<RecallResult> {
  const { query, tokenBudget = config.defaultTokenBudget, tags, format = 'summary' } = options;

  // 1. Embed query
  const queryEmbedding = await embed(query, config);

  // 2. Hybrid search: vector KNN + FTS5
  const vectorResults = vectorSearch(db, config.namespace, queryEmbedding, DEFAULT_CANDIDATE_LIMIT);
  const ftsResults = ftsSearch(db, config.namespace, query, DEFAULT_CANDIDATE_LIMIT);

  // Build a map of all candidate memories for RRF lookup
  const allMemories = new Map<string, MemoryRow>();
  for (const m of vectorResults) allMemories.set(m.id, m);
  for (const m of ftsResults) allMemories.set(m.id, m);

  if (allMemories.size === 0) {
    return {
      text: 'No relevant memories found.',
      memoryIds: [],
      totalCandidates: 0,
      selectedCount: 0,
    };
  }

  // 3. RRF merge
  let scored = reciprocalRankFusion(vectorResults, ftsResults, allMemories);

  // 4. Filter by tags if requested
  if (tags && tags.length > 0) {
    scored = scored.filter((m) => {
      const memTags = JSON.parse(m.tags ?? '[]') as string[];
      return tags.every((t) => memTags.includes(t));
    });
  }

  // 5. Composite scoring
  const now = Date.now();
  for (const mem of scored) {
    mem.compositeScore = computeCompositeScore(mem, now);
  }
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  // 6. Load embeddings for dedup
  const embeddingIds = scored.map((m) => m.id);
  const embeddings = getEmbeddingsForMemories(db, embeddingIds);

  // 7. Dedup
  const { kept } = deduplicateByEmbedding(scored, embeddings);

  // 8. Token budget packing
  const selected = packToBudget(kept, tokenBudget);

  // 9. Format
  const selectedEmbeddings = getEmbeddingsForMemories(
    db,
    selected.map((m) => m.id),
  );
  const text = await formatMemories(selected, selectedEmbeddings, query, tokenBudget, format, config);

  // 10. Update access stats for returned memories
  const returnedIds = selected.map((m) => m.id);
  updateAccessStats(db, returnedIds);

  return {
    text,
    memoryIds: returnedIds,
    totalCandidates: allMemories.size,
    selectedCount: selected.length,
  };
}
