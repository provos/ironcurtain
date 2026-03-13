import type Database from 'better-sqlite3';
import type { MemoryRow } from '../storage/database.js';
import type { MemoryConfig } from '../config.js';
import type { RecallOptions } from '../types.js';
import { vectorSearch, ftsSearch, updateAccessStats, getEmbeddingsForMemories } from '../storage/queries.js';
import { embedQuery } from '../embedding/embedder.js';
import {
  reciprocalRankFusion,
  computeCompositeScore,
  filterByRelevance,
  filterByRerankerScore,
  packToBudget,
} from './scoring.js';
import { deduplicateByEmbedding } from './dedup.js';
import { rerank } from './reranker.js';
import { formatMemories } from './formatting.js';
import { parseTags } from '../utils/tags.js';

const DEFAULT_CANDIDATE_LIMIT = 50;
/** Maximum cosine distance for vector search results.
 *  0.9 = cosine similarity > 0.1; generous enough for vague queries while filtering pure noise. */
const MAX_VECTOR_DISTANCE = 0.9;

/** Internal result from the retrieval pipeline, richer than the public RecallResult. */
export interface PipelineRecallResult {
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
  options: Omit<RecallOptions, 'namespace'>,
): Promise<PipelineRecallResult> {
  const { query, token_budget: tokenBudget = config.defaultTokenBudget, tags, format = 'summary' } = options;

  // 1. Embed query (with asymmetric prefix for retrieval-optimized embedding)
  const queryEmbedding = await embedQuery(query, config);

  // 2. Hybrid search: vector KNN + FTS5
  const vectorResultsRaw = vectorSearch(db, config.namespace, queryEmbedding, DEFAULT_CANDIDATE_LIMIT);
  // Filter out low-relevance results (cosine distance > 0.8 means similarity < 0.2)
  const vectorResults = vectorResultsRaw.filter((r) => r.distance < MAX_VECTOR_DISTANCE);
  const ftsResults = ftsSearch(db, config.namespace, query, DEFAULT_CANDIDATE_LIMIT);

  // Build a map of all candidate memories for RRF lookup.
  // Always include both vector and FTS results — RRF handles the fusion.
  // Gating FTS on vector confidence is an anti-pattern: FTS keyword matches
  // are most valuable precisely when vector search is uncertain.
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
  const { scored: rrfScored, rrfMax } = reciprocalRankFusion(vectorResults, ftsResults, allMemories);
  let scored = rrfScored;

  // 4. Filter by tags if requested
  if (tags && tags.length > 0) {
    scored = scored.filter((m) => {
      const memTags = parseTags(m.tags);
      return tags.every((t) => memTags.includes(t));
    });
  }

  // 5. Composite scoring
  const now = Date.now();
  for (const mem of scored) {
    mem.compositeScore = computeCompositeScore(mem, now, rrfMax);
  }
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  // 6. Drop low-relevance candidates before expensive steps
  const relevant = filterByRelevance(scored, rrfMax);

  // 6b. Cross-encoder re-ranking: refine ordering using (query, passage) pairs.
  // Runs only on the filtered set (typically 30-50 items) to keep latency reasonable.
  const reranked = await rerank(query, relevant, config);

  // 6c. Drop candidates the cross-encoder scored as irrelevant.
  // ms-marco logits: positive = relevant, negative = not relevant.
  // Always keep at least MIN_RERANKER_RESULTS to avoid returning nothing.
  const afterRerankerFilter = filterByRerankerScore(reranked);

  // 7. Load embeddings only for relevant candidates
  const embeddingIds = afterRerankerFilter.map((m) => m.id);
  const embeddings = getEmbeddingsForMemories(db, embeddingIds);

  // 8. Dedup
  const { kept } = deduplicateByEmbedding(afterRerankerFilter, embeddings);

  // 9. Token budget packing
  const selected = packToBudget(kept, tokenBudget);

  // 10. Format — reuse embeddings already loaded for dedup
  const selectedIds = new Set(selected.map((m) => m.id));
  const selectedEmbeddings = new Map<string, Float32Array>();
  for (const [id, emb] of embeddings) {
    if (selectedIds.has(id)) selectedEmbeddings.set(id, emb);
  }
  const text = await formatMemories(selected, selectedEmbeddings, query, tokenBudget, format, config);

  // 11. Update access stats for returned memories
  const returnedIds = selected.map((m) => m.id);
  updateAccessStats(db, returnedIds);

  return {
    text,
    memoryIds: returnedIds,
    totalCandidates: allMemories.size,
    selectedCount: selected.length,
  };
}
