/**
 * Scoring logic — evaluates server responses against ground-truth expectations.
 */

import type {
  QueryExpectation,
  QueryMetrics,
  QueryResult,
  CategoryResult,
  ScenarioResult,
  BenchmarkCategory,
  BenchmarkReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Query-level scoring
// ---------------------------------------------------------------------------

/**
 * Score a single query response against its expectation.
 * Uses substring matching (case-insensitive) to check for presence/absence.
 */
export function scoreQuery(
  responseText: string,
  expectation: QueryExpectation,
  latencyMs: number,
  queryText: string,
): QueryResult {
  const lower = responseText.toLowerCase();

  const foundItems: string[] = [];
  const missedItems: string[] = [];
  const unwantedItems: string[] = [];

  // Check mustInclude
  const mustInclude = expectation.mustInclude ?? [];
  for (const item of mustInclude) {
    if (lower.includes(item.toLowerCase())) {
      foundItems.push(item);
    } else {
      missedItems.push(item);
    }
  }

  // Check mustExclude
  const mustExclude = expectation.mustExclude ?? [];
  for (const item of mustExclude) {
    if (lower.includes(item.toLowerCase())) {
      unwantedItems.push(item);
    }
  }

  // Handle expectEmpty
  if (expectation.expectEmpty) {
    const emptyIndicators = [
      'no relevant memories',
      'no memories found',
      'no results',
      'nothing found',
      'no matching memories',
    ];
    const isEmpty = emptyIndicators.some((ind) => lower.includes(ind)) || responseText.trim().length === 0;
    if (!isEmpty) {
      // Server returned content when it shouldn't have
      unwantedItems.push('[non-empty response when empty expected]');
    }
  }

  const metrics = computeMetrics(
    foundItems.length,
    missedItems.length,
    unwantedItems.length,
    mustExclude.length,
    latencyMs,
  );

  return { query: queryText, metrics, responseText, foundItems, missedItems, unwantedItems };
}

function computeMetrics(
  found: number,
  missed: number,
  unwanted: number,
  totalExcluded: number,
  latencyMs: number,
): QueryMetrics {
  const totalExpected = found + missed;

  // Recall: fraction of expected items found
  const recall = totalExpected > 0 ? found / totalExpected : 1.0;

  // Precision: found / (found + unwanted)
  // If nothing was expected and nothing unwanted appeared, perfect score.
  const precision = found + unwanted > 0 ? found / (found + unwanted) : totalExpected === 0 ? 1.0 : 0.0;

  // F1
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0.0;

  // Exclusion score: fraction of excluded items that were correctly absent
  const exclusionScore = totalExcluded > 0 ? 1.0 - unwanted / totalExcluded : 1.0;

  return { precision, recall, f1, exclusionScore, latencyMs };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateCategory(category: BenchmarkCategory, scenarios: ScenarioResult[]): CategoryResult {
  const allQueries = scenarios.flatMap((s) => s.queries);
  const queryCount = allQueries.length;

  if (queryCount === 0) {
    return {
      category,
      scenarioCount: scenarios.length,
      queryCount: 0,
      avgPrecision: 0,
      avgRecall: 0,
      avgF1: 0,
      avgExclusionScore: 0,
      latencyP50: 0,
      latencyP95: 0,
      latencyP99: 0,
      scenarios,
    };
  }

  const avgPrecision = mean(allQueries.map((q) => q.metrics.precision));
  const avgRecall = mean(allQueries.map((q) => q.metrics.recall));
  const avgF1 = mean(allQueries.map((q) => q.metrics.f1));
  const avgExclusionScore = mean(allQueries.map((q) => q.metrics.exclusionScore));

  const latencies = allQueries.map((q) => q.metrics.latencyMs).sort((a, b) => a - b);

  return {
    category,
    scenarioCount: scenarios.length,
    queryCount,
    avgPrecision,
    avgRecall,
    avgF1,
    avgExclusionScore,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    latencyP99: percentile(latencies, 0.99),
    scenarios,
  };
}

export function computeOverallScore(categories: CategoryResult[]): number {
  const allF1s = categories.flatMap((c) => c.scenarios.flatMap((s) => s.queries.map((q) => q.metrics.f1)));
  return allF1s.length > 0 ? mean(allF1s) * 100 : 0;
}

export function buildReport(categories: CategoryResult[], serverCommand: string): BenchmarkReport {
  const totalQueries = categories.reduce((sum, c) => sum + c.queryCount, 0);
  const totalLatencyMs = categories.reduce(
    (sum, c) => sum + c.scenarios.flatMap((s) => s.queries).reduce((s, q) => s + q.metrics.latencyMs, 0),
    0,
  );

  return {
    timestamp: new Date().toISOString(),
    serverCommand,
    categories,
    overallScore: computeOverallScore(categories),
    totalQueries,
    totalLatencyMs,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Memory MCP Server Benchmark Results');
  lines.push('====================================');
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Server:    ${report.serverCommand}`);
  lines.push('');

  for (const cat of report.categories) {
    lines.push(`Category: ${cat.category}`);
    lines.push(`  Scenarios:      ${cat.scenarioCount}`);
    lines.push(`  Queries:        ${cat.queryCount}`);
    lines.push(`  Precision:      ${(cat.avgPrecision * 100).toFixed(1)}%`);
    lines.push(`  Recall:         ${(cat.avgRecall * 100).toFixed(1)}%`);
    lines.push(`  F1:             ${(cat.avgF1 * 100).toFixed(1)}%`);
    lines.push(`  Exclusion:      ${(cat.avgExclusionScore * 100).toFixed(1)}%`);
    lines.push(`  Latency p50:    ${cat.latencyP50.toFixed(0)}ms`);
    lines.push(`  Latency p95:    ${cat.latencyP95.toFixed(0)}ms`);
    lines.push(`  Latency p99:    ${cat.latencyP99.toFixed(0)}ms`);
    lines.push('');
  }

  lines.push(`Overall Score: ${report.overallScore.toFixed(1)}%`);
  lines.push(`Total Queries: ${report.totalQueries}`);
  lines.push(`Total Latency: ${(report.totalLatencyMs / 1000).toFixed(1)}s`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return sorted[idx];
}
