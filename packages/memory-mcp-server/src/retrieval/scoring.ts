import type { MemoryRow, VectorSearchResult, FtsSearchResult } from '../storage/database.js';

export interface ScoredMemory extends MemoryRow {
  fusionScore: number;
  compositeScore: number;
  /** Cosine distance from query embedding (lower = more similar). Only set for vector-retrieved memories. */
  vectorDistance?: number;
  /** Normalized BM25 score [0,1] within this result set. Only set for FTS-retrieved memories. */
  bm25Score?: number;
  /** Cross-encoder relevance score. Set by the re-ranker step; higher = more relevant. */
  rerankerScore?: number;
}

/** Result of hybrid score fusion — includes the max fusion score for downstream normalization. */
export interface FusionResult {
  scored: ScoredMemory[];
  fusionMax: number;
}

/**
 * Min-max normalize a value given the min and max of the set.
 * When range is 0 (all values equal), returns 1.0 (Weaviate convention).
 */
function minMaxNormalized(value: number, min: number, max: number, count: number): number {
  const range = max - min;
  if (range === 0) return 1.0;
  const normalized = (value - min) / range;
  // For small result sets, remap from [0,1] to [0.3,1] so the worst score isn't zero
  if (count <= 5) {
    const damping = 0.3;
    return damping + (1 - damping) * normalized;
  }
  return normalized;
}

/**
 * Weaviate-style relativeScoreFusion — merge vector and FTS search results
 * using normalized score magnitudes rather than rank positions.
 *
 * - Vector similarity scores (1 - distance) are min-max normalized to [0, 1]
 * - BM25 scores (negative, more negative = better) are min-max normalized to [0, 1]
 * - Fusion: alpha * norm_vec_sim + (1 - alpha) * norm_bm25
 * - Candidates from only one source get only that source's weighted contribution
 *
 * @param alpha - weight for vector similarity (default 0.5)
 */
export function hybridScoreFusion(
  vectorResults: VectorSearchResult[],
  ftsResults: FtsSearchResult[],
  allMemories: Map<string, MemoryRow>,
  alpha: number = 0.5,
): FusionResult {
  const vectorScoreById = new Map<string, number>();
  const ftsScoreById = new Map<string, number>();
  const vectorDistanceById = new Map<string, number>();
  const bm25NormalizedById = new Map<string, number>();

  // Normalize vector similarities (1 - distance) to [0, 1]
  if (vectorResults.length > 0) {
    const similarities = vectorResults.map((r) => 1 - r.distance);
    const simMin = Math.min(...similarities);
    const simMax = Math.max(...similarities);
    for (const r of vectorResults) {
      const sim = 1 - r.distance;
      vectorScoreById.set(r.id, minMaxNormalized(sim, simMin, simMax, vectorResults.length));
      vectorDistanceById.set(r.id, r.distance);
    }
  }

  // Normalize BM25 scores to [0, 1]
  // FTS5 bm25() returns negative values (more negative = better).
  // Negate so that better = higher, then min-max normalize.
  if (ftsResults.length > 0) {
    const negated = ftsResults.map((r) => -r.bm25_score);
    const negMin = Math.min(...negated);
    const negMax = Math.max(...negated);
    for (const r of ftsResults) {
      const norm = minMaxNormalized(-r.bm25_score, negMin, negMax, ftsResults.length);
      ftsScoreById.set(r.id, norm);
      bm25NormalizedById.set(r.id, norm);
    }
  }

  // Fuse scores: alpha * norm_vec + (1 - alpha) * norm_bm25
  // Candidates from only one source get only that source's weighted contribution
  const fusionScores = new Map<string, number>();
  const allIds = new Set([...vectorScoreById.keys(), ...ftsScoreById.keys()]);

  for (const id of allIds) {
    const vecScore = vectorScoreById.get(id);
    const ftsScore = ftsScoreById.get(id);

    let score = 0;
    if (vecScore != null) score += alpha * vecScore;
    if (ftsScore != null) score += (1 - alpha) * ftsScore;
    fusionScores.set(id, score);
  }

  let fusionMax = 0;
  const scored = [...fusionScores.entries()]
    .sort(([, a], [, b]) => b - a)
    .flatMap(([id, score]) => {
      const mem = allMemories.get(id);
      if (!mem) return [];
      if (score > fusionMax) fusionMax = score;
      return [
        {
          ...mem,
          fusionScore: score,
          compositeScore: 0,
          vectorDistance: vectorDistanceById.get(id),
          bm25Score: bm25NormalizedById.get(id),
        },
      ];
    });

  return { scored, fusionMax };
}

/**
 * Compute a composite score blending fusion relevance with metadata signals.
 *
 * The fusion score already incorporates vector + BM25 magnitudes via
 * relativeScoreFusion, so the composite just needs to blend it with
 * recency, importance, and access pattern signals.
 *
 * @param fusionMax - the maximum fusion score in this result set, used for normalization
 */
export function computeCompositeScore(memory: ScoredMemory, now: number, fusionMax: number = 1): number {
  const ageHours = (now - memory.created_at) / 3600000;
  const accessAgeHours = (now - memory.last_accessed_at) / 3600000;

  // Recency: exponential decay with ~30-day half-life
  const recencyScore = Math.exp(-0.001 * ageHours);

  // Access pattern: recently/frequently accessed memories are boosted
  const accessScore = Math.exp(-0.002 * accessAgeHours) * Math.min(memory.access_count / 10, 1.0);

  // Normalize fusion score to 0-1 range
  const normalizedFusion = memory.fusionScore / fusionMax;

  // Fixed weights: fusion relevance gets the remaining budget after metadata signals
  const relevanceWeight = 0.65;

  return relevanceWeight * normalizedFusion + 0.15 * recencyScore + 0.1 * memory.importance + 0.1 * accessScore;
}

/**
 * Estimate token count for a string (~4 chars per token heuristic).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Drop candidates whose fusion score is negligible compared to the best.
 * This filters noise before budget packing — candidates with very low
 * fusion relevance contribute nothing useful even if there's token budget left.
 *
 * Uses fusion score (not composite) because the composite score includes
 * constant components (recency, importance) that compress the range.
 */
const MIN_FUSION_FRACTION = 0.05;

export function filterByRelevance(ranked: ScoredMemory[], fusionMax: number): ScoredMemory[] {
  if (ranked.length === 0 || fusionMax <= 0) return ranked;
  const threshold = fusionMax * MIN_FUSION_FRACTION;
  return ranked.filter((m) => m.fusionScore >= threshold);
}

/**
 * Drop candidates the cross-encoder scored as clearly irrelevant relative
 * to the best candidate.  Uses a relative gap from the top score rather than
 * an absolute threshold — this adapts automatically to content types where
 * even the best candidate gets a negative logit (e.g. conversational text
 * scored by a web-search cross-encoder).
 *
 * Always keeps at least MIN_RERANKER_RESULTS so vague queries still return something.
 */
const MIN_RERANKER_RESULTS = 5;
/** Maximum allowed gap between a candidate's score and the best score. */
const RERANKER_SCORE_GAP = 5;

export function filterByRerankerScore(ranked: ScoredMemory[]): ScoredMemory[] {
  if (ranked.length === 0) return ranked;
  // If no reranker scores, pass through unchanged
  if (ranked[0].rerankerScore == null) return ranked;

  const bestScore = ranked[0].rerankerScore;
  const passing = ranked.filter((m) => bestScore - (m.rerankerScore ?? 0) <= RERANKER_SCORE_GAP);
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
