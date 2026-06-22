/**
 * Pure logic for the corpus representativeness diagnostic.
 *
 * The diagnostic answers ONE question: is the corpus non-degenerate enough that
 * evolving the composite retrieval scorer is meaningful — i.e. are the metadata
 * signals (recency, importance) ALIVE and do they actively reshape rankings,
 * unlike the LoCoMo benchmark where flat metadata (importance ≡ 0.5, identical
 * created_at) made those terms dead weight?
 *
 * Everything here is side-effect free and content-free: it operates on the
 * content-free fixture rows produced by the recall probe (vector_distance,
 * bm25_score, created_at, importance, ...) and on raw numeric arrays read from
 * the db. NO fact/query/content text ever flows through this module. It is unit
 * tested in isolation with SYNTHETIC fixtures — no DB, no LLM, no filesystem.
 *
 * The composite/fusion variants REUSE the production scoring functions
 * (`computeCompositeScore`, `hybridScoreFusion`, `estimateTokens`,
 * `packToBudget`) so the diagnostic reflects exactly what `evolve` would tune.
 * The single-signal baselines (recency-only, importance-only, ...) are
 * deliberately NOT production code — they are trivial reference rankers whose
 * only job is to be a confound floor.
 *
 * The I/O driver that wires these helpers to the real db and Haiku lives in
 * `diagnose-corpus.ts`.
 */

import type { MemoryRow } from '../../packages/memory-mcp-server/src/storage/database.js';
import type { ScoredMemory } from '../../packages/memory-mcp-server/src/retrieval/scoring.js';
import {
  hybridScoreFusion,
  computeCompositeScore,
  packToBudget,
} from '../../packages/memory-mcp-server/src/retrieval/scoring.js';

// ---------- Fixture row shapes (content-free) ----------

/**
 * One candidate retrieved for a probe query. Carries ONLY the signals the
 * scorers consume — never any content/fact/query text. `vector_distance` is
 * absent when the candidate came only from FTS; `bm25_score` is absent when it
 * came only from vector search.
 */
export interface FixtureCandidate {
  id: string;
  is_gold: boolean;
  /** Cosine distance from the query embedding (lower = closer). FTS-only ⇒ undefined. */
  vector_distance?: number;
  /** Raw FTS5 bm25() score (negative; more negative = better). Vector-only ⇒ undefined. */
  bm25_score?: number;
  created_at: number;
  last_accessed_at: number;
  access_count: number;
  importance: number;
  /** Character length of the fact's content — drives the token-budget pack. */
  content_length: number;
}

/** One probe query: a sampled fact's id (gold) and the candidate pool it drew. */
export interface FixtureQuery {
  query_id: string;
  gold_id: string;
  candidates: FixtureCandidate[];
}

// ---------- Ranking variants ----------

/** The ranking variants the recall@budget table is computed for. */
export const RANKING_VARIANTS = [
  'composite',
  'fusion-only',
  'recency-only',
  'importance-only',
  'access-only',
  'bm25-only',
  'vector-only',
] as const;

export type RankingVariant = (typeof RANKING_VARIANTS)[number];

/** The single-signal baselines — used for the confound check. */
export const SINGLE_SIGNAL_VARIANTS: readonly RankingVariant[] = [
  'recency-only',
  'importance-only',
  'access-only',
  'bm25-only',
  'vector-only',
];

// ---------- Fixture → ScoredMemory reconstruction ----------

/**
 * Rebuild the minimal `MemoryRow` shape the production scorers read from a
 * content-free fixture candidate. `content` is a synthetic placeholder of the
 * recorded length so `estimateTokens(content)` reproduces the real token cost
 * WITHOUT carrying any real text — token estimation is length-only (~4 chars).
 */
function candidateToRow(c: FixtureCandidate): MemoryRow {
  return {
    id: c.id,
    namespace: 'diagnostic',
    content: 'x'.repeat(Math.max(0, Math.round(c.content_length))),
    tags: null,
    importance: c.importance,
    created_at: c.created_at,
    updated_at: c.created_at,
    last_accessed_at: c.last_accessed_at,
    access_count: c.access_count,
    is_compacted: 0,
    consolidated: 1,
    source: null,
    metadata: null,
  };
}

/**
 * Recompute the production fusion + composite scores for a query's candidate
 * pool by feeding the recorded vector distances and bm25 scores back through
 * the REAL `hybridScoreFusion` and `computeCompositeScore`. This is the heart
 * of fidelity: the `composite`/`fusion-only` orderings are exactly what the
 * live pipeline would produce for this pool.
 *
 * `now` is the reference time for recency/access decay (caller-supplied so it is
 * deterministic in tests). Returns the scored candidates in production-fusion
 * order alongside the fusionMax used for normalization.
 */
export function scoreFixtureQuery(query: FixtureQuery, now: number): ScoredMemory[] {
  const allMemories = new Map<string, MemoryRow>();
  const vectorResults = [];
  const ftsResults = [];

  for (const c of query.candidates) {
    const row = candidateToRow(c);
    allMemories.set(c.id, row);
    if (c.vector_distance !== undefined) {
      vectorResults.push({ ...row, distance: c.vector_distance });
    }
    if (c.bm25_score !== undefined) {
      ftsResults.push({ ...row, bm25_score: c.bm25_score });
    }
  }

  const { scored, fusionMax } = hybridScoreFusion(vectorResults, ftsResults, allMemories);
  for (const mem of scored) {
    mem.compositeScore = computeCompositeScore(mem, now, fusionMax || 1);
  }
  return scored;
}

// ---------- Single-signal rankers ----------

/**
 * The key each single-signal ranker sorts by — higher = ranked first. These are
 * intentionally trivial: they exist so the confound check can prove the
 * composite isn't reducible to any one signal. Candidates missing a vector/bm25
 * signal sort last for that variant (worst possible key).
 */
function signalKey(c: FixtureCandidate, variant: RankingVariant): number {
  switch (variant) {
    case 'recency-only':
      return c.created_at;
    case 'importance-only':
      return c.importance;
    case 'access-only':
      return c.access_count;
    case 'bm25-only':
      // bm25 is negative (more negative = better) ⇒ negate so higher = better.
      return c.bm25_score === undefined ? -Infinity : -c.bm25_score;
    case 'vector-only':
      // distance: lower = better ⇒ negate so higher = better.
      return c.vector_distance === undefined ? -Infinity : -c.vector_distance;
    default:
      return 0;
  }
}

/**
 * Produce the ordered candidate list for a ranking variant. `composite` and
 * `fusion-only` go through the production scorers; the single-signal variants
 * sort by their trivial key. Ties break by `id` so the order is deterministic.
 */
export function rankCandidates(query: FixtureQuery, variant: RankingVariant, now: number): FixtureCandidate[] {
  const byId = new Map(query.candidates.map((c) => [c.id, c]));

  if (variant === 'composite' || variant === 'fusion-only') {
    const scored = scoreFixtureQuery(query, now);
    const key = variant === 'composite' ? (m: ScoredMemory) => m.compositeScore : (m: ScoredMemory) => m.fusionScore;
    return [...scored]
      .sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id))
      .flatMap((m) => {
        const c = byId.get(m.id);
        return c ? [c] : [];
      });
  }

  return [...query.candidates].sort(
    (a, b) => signalKey(b, variant) - signalKey(a, variant) || a.id.localeCompare(b.id),
  );
}

// ---------- recall@token-budget ----------

/**
 * Greedily pack the ranked candidates to the token budget (reusing the
 * production `estimateTokens` + `packToBudget` skip-not-break semantics) and
 * report whether the gold candidate landed in the packed set.
 */
export function recallAtBudget(query: FixtureQuery, ranked: FixtureCandidate[], budget: number): boolean {
  const scored: ScoredMemory[] = ranked.map((c) => ({
    ...candidateToRow(c),
    fusionScore: 0,
    compositeScore: 0,
  }));
  const packed = packToBudget(scored, budget);
  return packed.some((m) => m.id === query.gold_id);
}

/** Mean recall@budget over all queries for one ranking variant. */
export function meanRecallForVariant(
  queries: readonly FixtureQuery[],
  variant: RankingVariant,
  budget: number,
  now: number,
): number {
  if (queries.length === 0) return 0;
  let hits = 0;
  for (const query of queries) {
    const ranked = rankCandidates(query, variant, now);
    if (recallAtBudget(query, ranked, budget)) hits += 1;
  }
  return hits / queries.length;
}

/** recall@budget for every ranking variant. */
export function recallTable(
  queries: readonly FixtureQuery[],
  budget: number,
  now: number,
): Record<RankingVariant, number> {
  const table = {} as Record<RankingVariant, number>;
  for (const variant of RANKING_VARIANTS) {
    table[variant] = meanRecallForVariant(queries, variant, budget, now);
  }
  return table;
}

// ---------- Kendall-tau (ranking influence) ----------

/**
 * Kendall-tau rank correlation between two orderings of the same id set.
 * +1 = identical order, -1 = reversed, 0 = uncorrelated. Tau well below 1.0
 * between `composite` and `fusion-only` means the recency/importance terms are
 * actively reshaping the ranking (the LIVE-lever test).
 *
 * Ids present in one ordering but not the other are dropped (we only compare the
 * shared set). Returns 1.0 for sets of size < 2 (no pairs ⇒ trivially agreeing).
 */
export function kendallTau(orderA: readonly string[], orderB: readonly string[]): number {
  const setB = new Set(orderB);
  const common = orderA.filter((id) => setB.has(id));
  const rankB = new Map<string, number>();
  orderB.forEach((id, i) => rankB.set(id, i));

  const n = common.length;
  if (n < 2) return 1.0;

  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // In orderA, common[i] precedes common[j] by construction.
      const bi = rankB.get(common[i]);
      const bj = rankB.get(common[j]);
      if (bi === undefined || bj === undefined) continue;
      if (bi < bj) concordant += 1;
      else discordant += 1;
    }
  }
  const totalPairs = (n * (n - 1)) / 2;
  if (totalPairs === 0) return 1.0;
  return (concordant - discordant) / totalPairs;
}

/**
 * Mean Kendall-tau between the `composite` and `fusion-only` per-query
 * orderings across all queries. The anti-LoCoMo "reshapes rankings" signal.
 */
export function meanCompositeVsFusionTau(queries: readonly FixtureQuery[], now: number): number {
  if (queries.length === 0) return 1.0;
  let sum = 0;
  for (const query of queries) {
    const composite = rankCandidates(query, 'composite', now).map((c) => c.id);
    const fusion = rankCandidates(query, 'fusion-only', now).map((c) => c.id);
    sum += kendallTau(composite, fusion);
  }
  return sum / queries.length;
}

// ---------- Distributional summarizers ----------

export interface NumericSummary {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  stddev: number | null;
}

/** min/max/mean/stddev (population) of a numeric array. Empty ⇒ all null. */
export function summarizeNumeric(values: readonly number[]): NumericSummary {
  if (values.length === 0) {
    return { count: 0, min: null, max: null, mean: null, stddev: null };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / values.length;
  let sqDiff = 0;
  for (const v of values) sqDiff += (v - mean) ** 2;
  const stddev = Math.sqrt(sqDiff / values.length);
  return { count: values.length, min, max, mean, stddev };
}

/** Percentiles (linear interpolation) of a numeric array at the given fractions [0,1]. */
export function percentiles(values: readonly number[], fractions: readonly number[]): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  if (values.length === 0) {
    for (const f of fractions) result[`p${Math.round(f * 100)}`] = null;
    return result;
  }
  const sorted = [...values].sort((a, b) => a - b);
  for (const f of fractions) {
    const key = `p${Math.round(f * 100)}`;
    const rank = f * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    result[key] = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  }
  return result;
}

/**
 * Histogram of a numeric array into fixed-width buckets. Returns a label→count
 * map; labels are the bucket's lower bound formatted to `decimals`. Values are
 * assigned to `floor((v - origin) / width)`.
 */
export function histogram(values: readonly number[], width: number, origin = 0, decimals = 1): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const v of values) {
    const idx = Math.floor((v - origin) / width);
    const lower = origin + idx * width;
    const label = lower.toFixed(decimals);
    buckets[label] = (buckets[label] ?? 0) + 1;
  }
  return buckets;
}

// ---------- Recency-specific summaries ----------

/** Convert an epoch-ms timestamp to a `YYYY-MM` (UTC) bucket label. */
export function yearMonth(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

/** Convert an epoch-ms timestamp to a `YYYY-Qn` (UTC) quarter label. */
export function yearQuarter(epochMs: number): string {
  const d = new Date(epochMs);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

export interface RecencySummary {
  numeric: NumericSummary;
  distinctYearMonths: number;
  spanDays: number | null;
  fractionByYear: Record<string, number>;
  histogramByQuarter: Record<string, number>;
}

/** Recency distribution over an array of created_at epoch-ms timestamps. */
export function summarizeRecency(createdAt: readonly number[]): RecencySummary {
  const numeric = summarizeNumeric(createdAt);
  const months = new Set(createdAt.map(yearMonth));
  const byYear: Record<string, number> = {};
  for (const ts of createdAt) {
    const y = String(new Date(ts).getUTCFullYear());
    byYear[y] = (byYear[y] ?? 0) + 1;
  }
  const fractionByYear: Record<string, number> = {};
  for (const [y, n] of Object.entries(byYear)) {
    fractionByYear[y] = createdAt.length === 0 ? 0 : n / createdAt.length;
  }
  const histogramByQuarter: Record<string, number> = {};
  for (const ts of createdAt) {
    const q = yearQuarter(ts);
    histogramByQuarter[q] = (histogramByQuarter[q] ?? 0) + 1;
  }
  const spanDays =
    numeric.min !== null && numeric.max !== null ? (numeric.max - numeric.min) / (1000 * 60 * 60 * 24) : null;
  return { numeric, distinctYearMonths: months.size, spanDays, fractionByYear, histogramByQuarter };
}

export interface ImportanceSummary {
  numeric: NumericSummary;
  distinctValues: number;
  fractionAtSeed: number;
  histogram: Record<string, number>;
}

/** The seed importance value the engine stamps before extraction overrides it. */
export const IMPORTANCE_SEED = 0.5;

/** Importance distribution, including the fraction sitting EXACTLY at the seed. */
export function summarizeImportance(importance: readonly number[]): ImportanceSummary {
  const numeric = summarizeNumeric(importance);
  const distinct = new Set(importance).size;
  const atSeed = importance.filter((v) => v === IMPORTANCE_SEED).length;
  return {
    numeric,
    distinctValues: distinct,
    fractionAtSeed: importance.length === 0 ? 0 : atSeed / importance.length,
    histogram: histogram(importance, 0.1, 0, 1),
  };
}

// ---------- Stratified sampler ----------

/**
 * Small deterministic PRNG (mulberry32) so sampling is reproducible across runs
 * given a `--seed`. Math.random is fine in a script, but the diagnostic must be
 * re-runnable to the same sample for comparison.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A row eligible for sampling — only the bucketing key matters here. */
export interface SampleRow {
  id: string;
  created_at: number;
}

/**
 * Stratified sample of `total` ids across recency buckets so older years are
 * represented, not just recent ones. Rows are bucketed by `bucketOf` (default:
 * calendar year). The target per bucket is `total / numBuckets`; under-filled
 * buckets donate their slack to the others via a second pass. Sampling within a
 * bucket and bucket-fill order are driven by the seeded PRNG, so re-runs with
 * the same seed produce the same sample.
 */
export function stratifiedSample(
  rows: readonly SampleRow[],
  total: number,
  rng: () => number,
  bucketOf: (row: SampleRow) => string = (r) => String(new Date(r.created_at).getUTCFullYear()),
): string[] {
  if (total <= 0 || rows.length === 0) return [];

  const byBucket = new Map<string, SampleRow[]>();
  for (const row of rows) {
    const key = bucketOf(row);
    const list = byBucket.get(key) ?? [];
    list.push(row);
    byBucket.set(key, list);
  }

  // Shuffle within each bucket deterministically.
  const buckets = [...byBucket.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, list] of buckets) shuffleInPlace(list, rng);

  const cap = Math.min(total, rows.length);
  const perBucket = Math.max(1, Math.floor(cap / buckets.length));

  // First pass: take up to perBucket from each bucket.
  const selected: string[] = [];
  const remaining = new Map<string, SampleRow[]>();
  for (const [key, list] of buckets) {
    const take = Math.min(perBucket, list.length);
    for (let i = 0; i < take; i += 1) selected.push(list[i].id);
    remaining.set(key, list.slice(take));
  }

  // Second pass: round-robin the leftover slots from buckets that still have rows.
  const leftover = buckets.flatMap(([key]) => remaining.get(key) ?? []);
  shuffleInPlace(leftover, rng);
  for (const row of leftover) {
    if (selected.length >= cap) break;
    selected.push(row.id);
  }

  return selected.slice(0, cap);
}

function shuffleInPlace(arr: SampleRow[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ---------- Verdict ----------

/** Thresholds for the GO/NO-GO verdict — printed alongside the result. */
export interface VerdictThresholds {
  minDistinctYearMonths: number;
  minRecencyStddevDays: number;
  minImportanceStddev: number;
  maxFractionAtSeed: number;
  maxReshapeTau: number;
}

export const DEFAULT_THRESHOLDS: VerdictThresholds = {
  minDistinctYearMonths: 12,
  minRecencyStddevDays: 30,
  minImportanceStddev: 0.05,
  maxFractionAtSeed: 0.5,
  maxReshapeTau: 0.9,
};

export interface VerdictInputs {
  recency: RecencySummary;
  importance: ImportanceSummary;
  reshapeTau: number;
  recallTable: Record<RankingVariant, number>;
}

export interface VerdictResult {
  go: boolean;
  recencyLive: boolean;
  importanceLive: boolean;
  reshapesRankings: boolean;
  notSingleSignalConfound: boolean;
  /** Names of the conditions that FAILED — empty on GO. */
  failedConditions: string[];
  thresholds: VerdictThresholds;
}

/**
 * The GO/NO-GO verdict. GO iff the three core anti-LoCoMo conditions hold:
 *   recency_live AND importance_live AND reshapes_rankings.
 *
 * `not_single_signal_confound` (composite ≥ every single-signal baseline) is
 * SUPPORTING evidence reported in the result but does NOT gate the verdict —
 * the core question is whether the metadata signals are alive and move order,
 * not whether composite beats every trivial ranker on a tiny probe. Access being
 * dead (zero on a fresh corpus) is EXPECTED and does not fail the verdict.
 */
export function evaluateVerdict(
  inputs: VerdictInputs,
  thresholds: VerdictThresholds = DEFAULT_THRESHOLDS,
): VerdictResult {
  const { recency, importance, reshapeTau } = inputs;

  const recencyStddevDays = recency.numeric.stddev === null ? 0 : recency.numeric.stddev / (1000 * 60 * 60 * 24);
  const recencyLive =
    (recency.spanDays ?? 0) > 365 &&
    recency.distinctYearMonths >= thresholds.minDistinctYearMonths &&
    recencyStddevDays >= thresholds.minRecencyStddevDays;

  const importanceStddev = importance.numeric.stddev ?? 0;
  const importanceLive =
    importanceStddev >= thresholds.minImportanceStddev && importance.fractionAtSeed < thresholds.maxFractionAtSeed;

  const reshapesRankings = reshapeTau < thresholds.maxReshapeTau;

  const composite = inputs.recallTable.composite;
  const notSingleSignalConfound = SINGLE_SIGNAL_VARIANTS.every((v) => composite >= inputs.recallTable[v]);

  const failedConditions: string[] = [];
  if (!recencyLive) failedConditions.push('recency_live');
  if (!importanceLive) failedConditions.push('importance_live');
  if (!reshapesRankings) failedConditions.push('reshapes_rankings');

  const go = recencyLive && importanceLive && reshapesRankings;

  return {
    go,
    recencyLive,
    importanceLive,
    reshapesRankings,
    notSingleSignalConfound,
    failedConditions,
    thresholds,
  };
}
