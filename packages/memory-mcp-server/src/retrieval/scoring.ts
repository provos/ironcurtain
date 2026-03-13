import type { MemoryRow } from '../storage/database.js';

export interface ScoredMemory extends MemoryRow {
  rrfScore: number;
  compositeScore: number;
}

/**
 * Reciprocal Rank Fusion — merge ranked lists from vector and FTS search
 * without needing to normalize their scores.
 *
 * @param k - smoothing constant (default 60, standard RRF value)
 */
export function reciprocalRankFusion(
  vectorResults: MemoryRow[],
  ftsResults: MemoryRow[],
  allMemories: Map<string, MemoryRow>,
  k: number = 60,
): ScoredMemory[] {
  const scores = new Map<string, number>();

  vectorResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
  });

  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
  });

  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .flatMap(([id, score]) => {
      const mem = allMemories.get(id);
      if (!mem) return [];
      return [{ ...mem, rrfScore: score, compositeScore: 0 }];
    });
}

/**
 * Compute a composite score combining RRF relevance with metadata signals.
 * Weights are initial defaults — should be tuned with real usage data.
 */
export function computeCompositeScore(memory: ScoredMemory, now: number): number {
  const ageHours = (now - memory.created_at) / 3600000;
  const accessAgeHours = (now - memory.last_accessed_at) / 3600000;

  // Recency: exponential decay with ~30-day half-life
  const recencyScore = Math.exp(-0.001 * ageHours);

  // Access pattern: recently/frequently accessed memories are boosted
  const accessScore = Math.exp(-0.002 * accessAgeHours) * Math.min(memory.access_count / 10, 1.0);

  return 0.55 * memory.rrfScore + 0.2 * recencyScore + 0.1 * memory.importance + 0.15 * accessScore;
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

export function filterByRelevance(ranked: ScoredMemory[]): ScoredMemory[] {
  if (ranked.length === 0) return ranked;
  let bestRrf = 0;
  for (const m of ranked) {
    if (m.rrfScore > bestRrf) bestRrf = m.rrfScore;
  }
  if (bestRrf <= 0) return ranked;
  const threshold = bestRrf * MIN_RRF_FRACTION;
  return ranked.filter((m) => m.rrfScore >= threshold);
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
