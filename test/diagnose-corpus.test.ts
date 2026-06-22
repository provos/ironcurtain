import { describe, it, expect } from 'vitest';

import {
  summarizeNumeric,
  percentiles,
  histogram,
  summarizeRecency,
  summarizeImportance,
  yearMonth,
  yearQuarter,
  rankCandidates,
  recallAtBudget,
  recallTable,
  meanRecallForVariant,
  kendallTau,
  meanCompositeVsFusionTau,
  stratifiedSample,
  mulberry32,
  evaluateVerdict,
  DEFAULT_THRESHOLDS,
  type FixtureCandidate,
  type FixtureQuery,
  type SampleRow,
} from '../scripts/memory-corpus/diagnose-lib.js';

// ---------- Synthetic fixture helpers (NOT real corpus data) ----------

const NOW = Date.UTC(2026, 0, 1); // fixed reference time for deterministic decay
const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

function candidate(overrides: Partial<FixtureCandidate> = {}): FixtureCandidate {
  return {
    id: 'c0',
    is_gold: false,
    vector_distance: 0.4,
    bm25_score: -3,
    created_at: NOW - YEAR,
    last_accessed_at: NOW - YEAR,
    access_count: 0,
    importance: 0.5,
    content_length: 80,
    ...overrides,
  };
}

/**
 * A LoCoMo-shaped degenerate query: all importance ≡ 0.5, all created_at
 * identical, access ≡ 0. The only thing that differs between candidates is the
 * retrieval signal (vector/bm25) — so composite and fusion-only MUST produce the
 * same order (tau = 1, reshapes_rankings = false).
 */
function degenerateQuery(idx: number): FixtureQuery {
  const created = Date.UTC(2024, 5, 15); // identical for every candidate
  const candidates: FixtureCandidate[] = [0, 1, 2, 3, 4].map((i) => ({
    id: `q${idx}-c${i}`,
    is_gold: i === 0,
    vector_distance: 0.2 + i * 0.1,
    bm25_score: -10 + i * 2,
    created_at: created,
    last_accessed_at: created,
    access_count: 0,
    importance: 0.5,
    content_length: 60,
  }));
  return { query_id: `q${idx}`, gold_id: `q${idx}-c0`, candidates };
}

/**
 * A healthy query: importance and recency VARY in a way that should reorder the
 * pool versus fusion-only. The gold candidate has a mediocre retrieval signal
 * but high importance + strong recency, so composite should lift it above
 * fusion-only neighbours — reshaping the ranking (tau < 1).
 */
function healthyQuery(idx: number): FixtureQuery {
  const candidates: FixtureCandidate[] = [
    // gold: near-top retrieval AND very recent + very important
    {
      id: `q${idx}-gold`,
      is_gold: true,
      vector_distance: 0.22,
      bm25_score: -11,
      created_at: NOW - 10 * DAY,
      last_accessed_at: NOW - 10 * DAY,
      access_count: 0,
      importance: 0.95,
      content_length: 70,
    },
    // BEST fusion but OLD + LOW importance — composite's metadata terms should
    // drop it below gold, reshaping the order (the LIVE-lever signal).
    {
      id: `q${idx}-a`,
      is_gold: false,
      vector_distance: 0.2,
      bm25_score: -12,
      created_at: NOW - 4 * YEAR,
      last_accessed_at: NOW - 4 * YEAR,
      access_count: 0,
      importance: 0.3,
      content_length: 70,
    },
    {
      id: `q${idx}-b`,
      is_gold: false,
      vector_distance: 0.5,
      bm25_score: -6,
      created_at: NOW - 2 * YEAR,
      last_accessed_at: NOW - 2 * YEAR,
      access_count: 0,
      importance: 0.4,
      content_length: 70,
    },
    {
      id: `q${idx}-c`,
      is_gold: false,
      vector_distance: 0.6,
      bm25_score: -3,
      created_at: NOW - 3 * YEAR,
      last_accessed_at: NOW - 3 * YEAR,
      access_count: 0,
      importance: 0.6,
      content_length: 70,
    },
  ];
  return { query_id: `q${idx}`, gold_id: `q${idx}-gold`, candidates };
}

// ---------- summarizeNumeric ----------

describe('summarizeNumeric', () => {
  it('returns all-null for an empty array', () => {
    expect(summarizeNumeric([])).toEqual({ count: 0, min: null, max: null, mean: null, stddev: null });
  });

  it('computes min/max/mean/population-stddev', () => {
    const s = summarizeNumeric([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
    expect(s.mean).toBe(5);
    expect(s.stddev).toBeCloseTo(2, 6); // textbook population stddev = 2
  });

  it('reports zero stddev for constant input', () => {
    expect(summarizeNumeric([0.5, 0.5, 0.5]).stddev).toBe(0);
  });
});

describe('percentiles', () => {
  it('interpolates linearly between ranks', () => {
    const p = percentiles([0, 10, 20, 30, 40], [0, 0.5, 1]);
    expect(p.p0).toBe(0);
    expect(p.p50).toBe(20);
    expect(p.p100).toBe(40);
  });

  it('returns null per fraction for empty input', () => {
    expect(percentiles([], [0.5, 0.9])).toEqual({ p50: null, p90: null });
  });
});

describe('histogram', () => {
  it('buckets values into fixed-width bins', () => {
    const h = histogram([0.0, 0.05, 0.12, 0.55, 0.95], 0.1, 0, 1);
    expect(h['0.0']).toBe(2); // 0.0 and 0.05
    expect(h['0.1']).toBe(1); // 0.12
    expect(h['0.5']).toBe(1); // 0.55
    expect(h['0.9']).toBe(1); // 0.95
  });
});

// ---------- recency / importance summarizers ----------

describe('yearMonth / yearQuarter', () => {
  it('formats UTC year-month and quarter labels', () => {
    const ts = Date.UTC(2024, 7, 9); // August 2024 ⇒ Q3
    expect(yearMonth(ts)).toBe('2024-08');
    expect(yearQuarter(ts)).toBe('2024-Q3');
  });
});

describe('summarizeRecency', () => {
  it('counts distinct year-months and computes a multi-year span', () => {
    const ts = [Date.UTC(2023, 0, 1), Date.UTC(2023, 5, 1), Date.UTC(2024, 0, 1), Date.UTC(2025, 11, 1)];
    const s = summarizeRecency(ts);
    expect(s.distinctYearMonths).toBe(4);
    expect(s.spanDays).not.toBeNull();
    expect(s.spanDays as number).toBeGreaterThan(365 * 2);
    expect(Object.keys(s.fractionByYear).sort()).toEqual(['2023', '2024', '2025']);
    expect(s.fractionByYear['2023']).toBeCloseTo(0.5, 6);
  });

  it('collapses to a single year-month for identical timestamps (LoCoMo-shaped)', () => {
    const same = Date.UTC(2024, 5, 15);
    const s = summarizeRecency([same, same, same, same]);
    expect(s.distinctYearMonths).toBe(1);
    expect(s.spanDays).toBe(0);
    expect(s.numeric.stddev).toBe(0);
  });
});

describe('summarizeImportance', () => {
  it('reports distinct values and the fraction exactly at the 0.5 seed', () => {
    const s = summarizeImportance([0.5, 0.5, 0.7, 0.9]);
    expect(s.distinctValues).toBe(3);
    expect(s.fractionAtSeed).toBeCloseTo(0.5, 6);
    expect(s.numeric.stddev as number).toBeGreaterThan(0);
  });

  it('flags a fully-flat (all-0.5) distribution', () => {
    const s = summarizeImportance([0.5, 0.5, 0.5, 0.5]);
    expect(s.distinctValues).toBe(1);
    expect(s.fractionAtSeed).toBe(1);
    expect(s.numeric.stddev).toBe(0);
  });
});

// ---------- single-signal rankers ----------

describe('rankCandidates single-signal variants', () => {
  const q: FixtureQuery = {
    query_id: 'q',
    gold_id: 'hi-imp',
    candidates: [
      candidate({
        id: 'old-recent',
        created_at: NOW - 2 * YEAR,
        importance: 0.3,
        access_count: 1,
        vector_distance: 0.5,
        bm25_score: -2,
      }),
      candidate({
        id: 'new-recent',
        created_at: NOW - 1 * DAY,
        importance: 0.4,
        access_count: 0,
        vector_distance: 0.6,
        bm25_score: -1,
      }),
      candidate({
        id: 'hi-imp',
        created_at: NOW - 1 * YEAR,
        importance: 0.9,
        access_count: 0,
        vector_distance: 0.55,
        bm25_score: -3,
      }),
      candidate({
        id: 'hi-access',
        created_at: NOW - 1 * YEAR,
        importance: 0.5,
        access_count: 9,
        vector_distance: 0.7,
        bm25_score: -1,
      }),
      candidate({
        id: 'close-vec',
        created_at: NOW - 1 * YEAR,
        importance: 0.5,
        access_count: 0,
        vector_distance: 0.1,
        bm25_score: -0.5,
      }),
      candidate({
        id: 'top-bm25',
        created_at: NOW - 1 * YEAR,
        importance: 0.5,
        access_count: 0,
        vector_distance: 0.8,
        bm25_score: -20,
      }),
    ],
  };

  it('recency-only ranks the newest first', () => {
    expect(rankCandidates(q, 'recency-only', NOW)[0].id).toBe('new-recent');
  });

  it('importance-only ranks the most important first', () => {
    expect(rankCandidates(q, 'importance-only', NOW)[0].id).toBe('hi-imp');
  });

  it('access-only ranks the most accessed first', () => {
    expect(rankCandidates(q, 'access-only', NOW)[0].id).toBe('hi-access');
  });

  it('vector-only ranks the closest (smallest distance) first', () => {
    expect(rankCandidates(q, 'vector-only', NOW)[0].id).toBe('close-vec');
  });

  it('bm25-only ranks the most-negative bm25 first', () => {
    expect(rankCandidates(q, 'bm25-only', NOW)[0].id).toBe('top-bm25');
  });

  it('is deterministic (ties break by id)', () => {
    const a = rankCandidates(q, 'importance-only', NOW).map((c) => c.id);
    const b = rankCandidates(q, 'importance-only', NOW).map((c) => c.id);
    expect(a).toEqual(b);
  });
});

// ---------- recall@budget ----------

describe('recallAtBudget', () => {
  const q = healthyQuery(0);

  it('reports gold present when the budget fits the gold-containing top set', () => {
    const ranked = rankCandidates(q, 'composite', NOW);
    // Budget large enough to pack everything ⇒ gold is present.
    expect(recallAtBudget(q, ranked, 1000)).toBe(true);
  });

  it('reports gold absent when the budget is too small to reach gold', () => {
    // Rank gold last, then a budget that fits only the first candidate ⇒ gold absent.
    const ranked = [...q.candidates].sort((a, b) => (a.is_gold ? 1 : 0) - (b.is_gold ? 1 : 0));
    // First candidate is 70 chars ≈ 18 tokens; budget 20 fits only one ⇒ gold (last) excluded.
    expect(recallAtBudget(q, ranked, 20)).toBe(false);
  });

  it('packs with skip-not-break: a small later item still fits', () => {
    const q2: FixtureQuery = {
      query_id: 'q2',
      gold_id: 'small-gold',
      candidates: [
        candidate({ id: 'big', is_gold: false, content_length: 400 }),
        candidate({ id: 'small-gold', is_gold: true, content_length: 8 }),
      ],
    };
    // budget 20 tokens: 'big' is ~100 tokens (skip), 'small-gold' is ~2 tokens (fits).
    expect(recallAtBudget(q2, q2.candidates, 20)).toBe(true);
  });
});

// ---------- Kendall-tau ----------

describe('kendallTau', () => {
  it('is +1 for identical orderings', () => {
    expect(kendallTau(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toBe(1);
  });

  it('is -1 for fully reversed orderings', () => {
    expect(kendallTau(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'])).toBe(-1);
  });

  it('is between -1 and 1 for a partial swap', () => {
    const tau = kendallTau(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd']);
    expect(tau).toBeGreaterThan(-1);
    expect(tau).toBeLessThan(1);
  });

  it('returns 1 for sets with fewer than two shared elements', () => {
    expect(kendallTau(['a'], ['a'])).toBe(1);
    expect(kendallTau([], [])).toBe(1);
  });
});

describe('meanCompositeVsFusionTau', () => {
  it('is exactly 1 for degenerate queries (metadata is flat, no reshaping)', () => {
    const queries = [degenerateQuery(0), degenerateQuery(1), degenerateQuery(2)];
    expect(meanCompositeVsFusionTau(queries, NOW)).toBeCloseTo(1, 6);
  });

  it('is below 1 for healthy queries (recency/importance reshape order)', () => {
    const queries = [healthyQuery(0), healthyQuery(1), healthyQuery(2)];
    expect(meanCompositeVsFusionTau(queries, NOW)).toBeLessThan(1);
  });
});

// ---------- recall table ----------

describe('recallTable', () => {
  it('produces a recall value for every ranking variant', () => {
    const queries = [healthyQuery(0), healthyQuery(1)];
    const table = recallTable(queries, 300, NOW);
    for (const v of [
      'composite',
      'fusion-only',
      'recency-only',
      'importance-only',
      'access-only',
      'bm25-only',
      'vector-only',
    ] as const) {
      expect(table[v]).toBeGreaterThanOrEqual(0);
      expect(table[v]).toBeLessThanOrEqual(1);
    }
  });

  it('composite recalls the recency/importance-favored gold the single retrieval signals miss at tight budget', () => {
    // At a tight budget the gold (weak vector/bm25) is only recalled when the
    // metadata terms lift it — composite should beat fusion/vector/bm25-only.
    const queries = [healthyQuery(0), healthyQuery(1), healthyQuery(2)];
    const budget = 20; // ~18 tokens per 70-char fact ⇒ only one candidate fits
    expect(meanRecallForVariant(queries, 'composite', budget, NOW)).toBe(1);
    expect(meanRecallForVariant(queries, 'fusion-only', budget, NOW)).toBeLessThan(1);
  });
});

// ---------- stratified sampler ----------

describe('stratifiedSample', () => {
  function rowsAcrossYears(): SampleRow[] {
    const rows: SampleRow[] = [];
    for (const year of [2023, 2024, 2025, 2026]) {
      for (let i = 0; i < 20; i += 1) {
        rows.push({ id: `${year}-${i}`, created_at: Date.UTC(year, i % 12, 1) });
      }
    }
    return rows;
  }

  it('covers every recency bucket (no year left unrepresented)', () => {
    const rows = rowsAcrossYears();
    const sample = stratifiedSample(rows, 12, mulberry32(42));
    const years = new Set(sample.map((id) => id.split('-')[0]));
    expect(years).toEqual(new Set(['2023', '2024', '2025', '2026']));
  });

  it('is deterministic for a fixed seed', () => {
    const rows = rowsAcrossYears();
    const a = stratifiedSample(rows, 12, mulberry32(7));
    const b = stratifiedSample(rows, 12, mulberry32(7));
    expect(a).toEqual(b);
  });

  it('produces a different sample for a different seed', () => {
    const rows = rowsAcrossYears();
    const a = stratifiedSample(rows, 12, mulberry32(7));
    const b = stratifiedSample(rows, 12, mulberry32(99));
    expect(a).not.toEqual(b);
  });

  it('never exceeds the requested total or the available rows', () => {
    const rows = rowsAcrossYears();
    expect(stratifiedSample(rows, 12, mulberry32(1)).length).toBe(12);
    expect(stratifiedSample(rows, 10000, mulberry32(1)).length).toBe(rows.length);
  });

  it('returns empty for total <= 0 or no rows', () => {
    expect(stratifiedSample(rowsAcrossYears(), 0, mulberry32(1))).toEqual([]);
    expect(stratifiedSample([], 5, mulberry32(1))).toEqual([]);
  });
});

// ---------- VERDICT: the anti-vacuity proof ----------

describe('evaluateVerdict — degenerate (LoCoMo-like) corpus → NO-GO', () => {
  // All importance 0.5, all created_at identical, access 0. The diagnostic must
  // FAIL this — it is exactly the corpus shape that made the metadata terms dead
  // weight in the LoCoMo benchmark.
  const sameTs = Date.UTC(2024, 5, 15);
  const flatCreatedAt = Array.from({ length: 200 }, () => sameTs);
  const flatImportance = Array.from({ length: 200 }, () => 0.5);
  const queries = [degenerateQuery(0), degenerateQuery(1), degenerateQuery(2)];

  const verdict = evaluateVerdict({
    recency: summarizeRecency(flatCreatedAt),
    importance: summarizeImportance(flatImportance),
    reshapeTau: meanCompositeVsFusionTau(queries, NOW),
    recallTable: recallTable(queries, 300, NOW),
  });

  it('returns NO-GO', () => {
    expect(verdict.go).toBe(false);
  });

  it('fails importance_live (flat importance ≡ 0.5)', () => {
    expect(verdict.importanceLive).toBe(false);
    expect(verdict.failedConditions).toContain('importance_live');
  });

  it('fails reshapes_rankings (tau ≈ 1: metadata moves nothing)', () => {
    expect(verdict.reshapesRankings).toBe(false);
    expect(verdict.failedConditions).toContain('reshapes_rankings');
  });

  it('fails recency_live (identical created_at ⇒ no span, one year-month)', () => {
    expect(verdict.recencyLive).toBe(false);
    expect(verdict.failedConditions).toContain('recency_live');
  });
});

describe('evaluateVerdict — healthy corpus → GO', () => {
  // Multi-year recency + varied importance that reshapes rankings.
  function healthyCreatedAt(): number[] {
    const ts: number[] = [];
    for (let year = 2023; year <= 2026; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        ts.push(Date.UTC(year, month, 10));
        ts.push(Date.UTC(year, month, 20));
      }
    }
    return ts;
  }
  function variedImportance(): number[] {
    const vals: number[] = [];
    const levels = [0.6, 0.7, 0.8, 0.9, 0.55, 0.65];
    for (let i = 0; i < 200; i += 1) vals.push(levels[i % levels.length]);
    return vals;
  }
  const queries = [healthyQuery(0), healthyQuery(1), healthyQuery(2)];

  const verdict = evaluateVerdict({
    recency: summarizeRecency(healthyCreatedAt()),
    importance: summarizeImportance(variedImportance()),
    reshapeTau: meanCompositeVsFusionTau(queries, NOW),
    recallTable: recallTable(queries, 300, NOW),
  });

  it('returns GO', () => {
    expect(verdict.go).toBe(true);
    expect(verdict.failedConditions).toEqual([]);
  });

  it('marks all three core conditions live', () => {
    expect(verdict.recencyLive).toBe(true);
    expect(verdict.importanceLive).toBe(true);
    expect(verdict.reshapesRankings).toBe(true);
  });

  it('prints the thresholds it used', () => {
    expect(verdict.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

describe('evaluateVerdict — dead access alone does NOT fail the verdict', () => {
  // A healthy corpus where access is zero everywhere (fresh, never queried).
  // access is a LATENT signal; the verdict must still be GO.
  function healthyCreatedAt(): number[] {
    const ts: number[] = [];
    for (let year = 2023; year <= 2026; year += 1) {
      for (let month = 0; month < 12; month += 1) ts.push(Date.UTC(year, month, 15));
    }
    return ts;
  }
  const importance = Array.from({ length: 48 }, (_, i) => 0.5 + (i % 5) * 0.1);
  const queries = [healthyQuery(0), healthyQuery(1)]; // access_count is 0 in all healthy candidates

  const verdict = evaluateVerdict({
    recency: summarizeRecency(healthyCreatedAt()),
    importance: summarizeImportance(importance),
    reshapeTau: meanCompositeVsFusionTau(queries, NOW),
    recallTable: recallTable(queries, 300, NOW),
  });

  it('is still GO even though access-only recall is the floor', () => {
    expect(verdict.go).toBe(true);
  });
});
