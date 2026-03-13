import type { MemoryRow, VectorSearchResult } from '../storage/database.js';

export interface ScoredMemory extends MemoryRow {
  rrfScore: number;
  compositeScore: number;
  /** Cosine distance from query embedding (lower = more similar). Only set for vector-retrieved memories. */
  vectorDistance?: number;
  /** Cross-encoder relevance score. Set by the re-ranker step; higher = more relevant. */
  rerankerScore?: number;
}

/** Result of RRF merge — includes the max RRF score for downstream normalization. */
export interface RrfResult {
  scored: ScoredMemory[];
  rrfMax: number;
}

/**
 * Reciprocal Rank Fusion — merge ranked lists from vector and FTS search
 * without needing to normalize their scores.
 *
 * Also preserves vector cosine distances for use in composite scoring,
 * since rank alone discards valuable magnitude information.
 *
 * @param k - smoothing constant (default 60, standard RRF value)
 */
export function reciprocalRankFusion(
  vectorResults: VectorSearchResult[],
  ftsResults: MemoryRow[],
  allMemories: Map<string, MemoryRow>,
  k: number = 60,
): RrfResult {
  const scores = new Map<string, number>();
  const vectorDistanceById = new Map<string, number>();

  for (let rank = 0; rank < vectorResults.length; rank++) {
    const m = vectorResults[rank];
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
    vectorDistanceById.set(m.id, m.distance);
  }

  for (let rank = 0; rank < ftsResults.length; rank++) {
    const m = ftsResults[rank];
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
  }

  let rrfMax = 0;
  const scored = [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .flatMap(([id, score]) => {
      const mem = allMemories.get(id);
      if (!mem) return [];
      if (score > rrfMax) rrfMax = score;
      return [{ ...mem, rrfScore: score, compositeScore: 0, vectorDistance: vectorDistanceById.get(id) }];
    });

  return { scored, rrfMax };
}

/**
 * Compute a composite score combining RRF relevance, vector similarity,
 * and metadata signals.
 *
 * Vector similarity (1 − cosine distance) provides much stronger
 * discriminating power than RRF rank alone, since RRF compresses scores
 * into a narrow range (~0.009–0.033 for k=60, limit=50).
 *
 * @param rrfMax - the maximum RRF score in this result set, used for normalization
 */
export function computeCompositeScore(memory: ScoredMemory, now: number, rrfMax: number = 1): number {
  const ageHours = (now - memory.created_at) / 3600000;
  const accessAgeHours = (now - memory.last_accessed_at) / 3600000;

  // Recency: exponential decay with ~30-day half-life
  const recencyScore = Math.exp(-0.001 * ageHours);

  // Access pattern: recently/frequently accessed memories are boosted
  const accessScore = Math.exp(-0.002 * accessAgeHours) * Math.min(memory.access_count / 10, 1.0);

  // Normalize RRF score to 0–1 range so it's comparable to other signals
  const normalizedRrf = memory.rrfScore / rrfMax;

  // Vector similarity: clamp distance to [0,1] then convert to similarity.
  // Adaptive weighting: when vectorDistance is available, split relevance
  // weight between RRF and similarity. FTS-only results redistribute
  // the similarity weight to RRF so they aren't penalized.
  const vectorSimilarity = memory.vectorDistance != null ? Math.max(0, 1 - Math.min(memory.vectorDistance, 1)) : 0;
  const hasVector = memory.vectorDistance != null;

  const rrfWeight = hasVector ? 0.3 : 0.65;
  const vecWeight = hasVector ? 0.35 : 0;

  return (
    rrfWeight * normalizedRrf +
    vecWeight * vectorSimilarity +
    0.15 * recencyScore +
    0.1 * memory.importance +
    0.1 * accessScore
  );
}

/**
 * Estimate token count for a string (~4 chars per token heuristic).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Drop candidates whose RRF score is negligible compared to the best.
 * This filters noise before budget packing — candidates with very low
 * RRF relevance contribute nothing useful even if there's token budget left.
 *
 * Uses RRF score (not composite) because the composite score includes
 * constant components (recency, importance) that compress the range.
 */
const MIN_RRF_FRACTION = 0.2;

export function filterByRelevance(ranked: ScoredMemory[], rrfMax: number): ScoredMemory[] {
  if (ranked.length === 0 || rrfMax <= 0) return ranked;
  const threshold = rrfMax * MIN_RRF_FRACTION;
  return ranked.filter((m) => m.rrfScore >= threshold);
}

/**
 * Drop candidates the cross-encoder scored as irrelevant.
 * ms-marco logits: positive = relevant, negative = not relevant.
 * Always keeps at least MIN_RERANKER_RESULTS so vague queries still return something.
 */
const MIN_RERANKER_RESULTS = 3;
const RERANKER_SCORE_THRESHOLD = 0;

export function filterByRerankerScore(ranked: ScoredMemory[]): ScoredMemory[] {
  if (ranked.length === 0) return ranked;
  // If no reranker scores, pass through unchanged
  if (ranked[0].rerankerScore == null) return ranked;

  const passing = ranked.filter((m) => (m.rerankerScore ?? 0) >= RERANKER_SCORE_THRESHOLD);
  // Always keep at least MIN_RERANKER_RESULTS from the top of the reranked list
  if (passing.length >= MIN_RERANKER_RESULTS) return passing;
  return ranked.slice(0, MIN_RERANKER_RESULTS);
}

/**
 * Greedily select memories by score until the token budget is filled.
 * Uses skip (not break) so smaller memories further down can still fit.
 */
export function packToBudget(ranked: ScoredMemory[], budget: number): ScoredMemory[] {
  const selected: ScoredMemory[] = [];
  let usedTokens = 0;

  for (const mem of ranked) {
    const tokens = estimateTokens(mem.content);
    if (usedTokens + tokens > budget) continue;
    selected.push(mem);
    usedTokens += tokens;
  }

  return selected;
}
