import type Database from 'better-sqlite3';
import type { MemoryRow } from '../storage/database.js';
import type { MemoryConfig } from '../config.js';
import type { RecallOptions } from '../types.js';
import { vectorSearch, ftsSearch, updateAccessStats, getEmbeddingsForMemories } from '../storage/queries.js';
import { embedQuery } from '../embedding/embedder.js';
import { hybridScoreFusion, computeCompositeScore, filterByRelevance, filterByRerankerScore } from './scoring.js';
import { deduplicateByEmbedding } from './dedup.js';
import { rerank } from './reranker.js';
import { formatMemories } from './formatting.js';
import { expandKeptFacts, realMemoryId } from './expansion.js';
import { parseTags } from '../utils/tags.js';

const DEFAULT_CANDIDATE_LIMIT = 50;
/** Maximum cosine distance for vector search results.
 *  0.9 = cosine similarity > 0.1; generous enough for vague queries while filtering pure noise. */
const MAX_VECTOR_DISTANCE = 0.9;

/** Default cap on expanded passages across one result (§5.4). */
const DEFAULT_MAX_EXPAND_PASSAGES = 2;

/** Internal result from the retrieval pipeline, richer than the public RecallResult. */
export interface PipelineRecallResult {
  text: string;
  memoryIds: string[];
  totalCandidates: number;
  selectedCount: number;
  /** True when any returned display unit was an expanded parent passage. */
  expanded: boolean;
  /** The segment_ids that were expanded (empty when none). */
  expandedSegmentIds: string[];
}

/**
 * Full retrieval pipeline: embed query -> vector KNN -> FTS5 -> score-based fusion ->
 * composite score -> dedup -> token budget pack -> format.
 */
export async function recall(
  db: Database.Database,
  config: MemoryConfig,
  options: Omit<RecallOptions, 'namespace'>,
): Promise<PipelineRecallResult> {
  const {
    query,
    token_budget: tokenBudget = config.defaultTokenBudget,
    tags,
    format = 'summary',
    expand = 'auto',
    max_expand_passages: maxExpandPassages = DEFAULT_MAX_EXPAND_PASSAGES,
  } = options;

  // 1. Embed query (with asymmetric prefix for retrieval-optimized embedding)
  const queryEmbedding = await embedQuery(query, config);

  // 2. Hybrid search: vector KNN + FTS5
  const vectorResultsRaw = vectorSearch(db, config.namespace, queryEmbedding, DEFAULT_CANDIDATE_LIMIT);
  // Filter out low-relevance results (cosine distance > 0.8 means similarity < 0.2)
  const vectorResults = vectorResultsRaw.filter((r) => r.distance < MAX_VECTOR_DISTANCE);
  const ftsResults = ftsSearch(db, config.namespace, query, DEFAULT_CANDIDATE_LIMIT);

  // Build a map of all candidate memories for fusion lookup.
  // Always include both vector and FTS results — hybrid fusion handles the merge.
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
      expanded: false,
      expandedSegmentIds: [],
    };
  }

  // 3. Score-based hybrid fusion
  const { scored: fusionScored, fusionMax: fusionMaxRaw } = hybridScoreFusion(vectorResults, ftsResults, allMemories);
  let scored = fusionScored;

  // 4. Filter by tags if requested
  if (tags && tags.length > 0) {
    scored = scored.filter((m) => {
      const memTags = parseTags(m.tags);
      return tags.every((t) => memTags.includes(t));
    });
  }

  // Recompute fusionMax after tag filtering so downstream normalization
  // and relevance gating use the actual max of the surviving set.
  const fusionMax = scored.length > 0 ? Math.max(...scored.map((m) => m.fusionScore)) : fusionMaxRaw;

  // 5. Composite scoring
  const now = Date.now();
  for (const mem of scored) {
    mem.compositeScore = computeCompositeScore(mem, now, fusionMax);
  }
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  // 6. Drop low-relevance candidates before expensive steps
  const relevant = filterByRelevance(scored, fusionMax);

  // 6b. Cross-encoder re-ranking: refine ordering using (query, passage) pairs.
  // Runs only on the filtered set (typically 30-50 items) to keep latency reasonable.
  // Falls back to pre-rerank ordering if model loading fails (e.g., network issue).
  let afterRerankerFilter: typeof relevant;
  try {
    const reranked = await rerank(query, relevant, config);
    // 6c. Drop candidates the cross-encoder scored as irrelevant.
    // ms-marco logits: positive = relevant, negative = not relevant.
    // Always keep at least MIN_RERANKER_RESULTS to avoid returning nothing.
    afterRerankerFilter = filterByRerankerScore(reranked);
  } catch {
    afterRerankerFilter = relevant;
  }

  // 7. Load embeddings only for relevant candidates
  const embeddingIds = afterRerankerFilter.map((m) => m.id);
  const embeddings = getEmbeddingsForMemories(db, config.namespace, embeddingIds);

  // 8. Dedup
  const { kept } = deduplicateByEmbedding(afterRerankerFilter, embeddings);

  // 9b + 9. Parent re-expansion AND budget packing (return-shaping only; the ranker
  //     above is untouched). For expand:'none' this is a byte-for-byte `packToBudget`
  //     over `kept` as facts. For expand:'auto'|'parent' it reserves budget for the top
  //     passage so depth is guaranteed, packs the breadth facts into the remainder so the
  //     top facts are never evicted, then fills leftover — returning the final packed list.
  const { units: selected, expandedSegmentIds } = await expandKeptFacts(
    db,
    config,
    kept,
    queryEmbedding,
    expand,
    maxExpandPassages,
    tokenBudget,
  );

  // 10. Format — reuse embeddings already loaded for dedup. A passage unit carries the
  //     synthetic id `<factId>#seg:<segId>`, so resolve each selected unit to its REAL
  //     memory id to fetch the embedding, keyed by the unit's own id — so the no-LLM
  //     extractive-clustering path still clusters the passage by its host fact's vector.
  const selectedEmbeddings = new Map<string, Float32Array>();
  for (const unit of selected) {
    const emb = embeddings.get(realMemoryId(unit.id));
    if (emb !== undefined) selectedEmbeddings.set(unit.id, emb);
  }
  const text = await formatMemories(selected, selectedEmbeddings, query, tokenBudget, format, config);

  // 11. Update access stats. Resolve passage units' synthetic ids back to their host fact's
  //     real memory id and de-duplicate — so a fact present as both a fact unit and a passage
  //     unit is counted once, and the host fact is still counted when only the passage fit.
  const realIds = [...new Set(selected.map((m) => realMemoryId(m.id)))];
  updateAccessStats(db, config.namespace, realIds);

  // `expandKeptFacts` packs facts + passages itself, so `expandedSegmentIds` already
  // reflects only the passages that survived into the returned set.
  return {
    text,
    memoryIds: realIds,
    totalCandidates: allMemories.size,
    selectedCount: selected.length,
    expanded: expandedSegmentIds.length > 0,
    expandedSegmentIds,
  };
}
