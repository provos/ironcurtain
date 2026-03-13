/**
 * Scoring logic — evaluates server responses against ground-truth expectations.
 *
 * Uses substring matching first, then falls back to embedding-based semantic
 * similarity for mustInclude items that aren't found verbatim. This prevents
 * penalizing LLM summarization that rephrases content (e.g. "fixed" → "resolved").
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
import { embed, cosineSimilarity } from '../src/embedding/embedder.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';

/** Cosine similarity threshold for semantic matching of mustInclude items. */
const SEMANTIC_THRESHOLD = 0.5;
/** Minimum sentence length (chars) to consider for semantic matching. */
const MIN_SENTENCE_LENGTH = 8;

let cachedConfig: MemoryConfig | null = null;
function getEmbeddingConfig(): MemoryConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Split text into sentences for semantic matching.
 * Splits on periods, newlines, and bullet markers (space-dash-space).
 */
function splitIntoChunks(text: string): string[] {
  return text
    .split(/[.\n•]|\s-\s/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LENGTH);
}

/**
 * Check which items from `candidates` are semantically present in the response.
 * Embeds response chunks once, then checks each candidate against all chunks.
 */
async function semanticMatch(
  responseText: string,
  candidates: string[],
): Promise<{ found: string[]; missed: string[] }> {
  if (candidates.length === 0) return { found: [], missed: [] };

  const config = getEmbeddingConfig();
  const chunks = splitIntoChunks(responseText);

  if (chunks.length === 0) return { found: [], missed: [...candidates] };

  // Embed all response chunks once (reused across all candidates)
  const chunkEmbeddings = await Promise.all(chunks.map((c) => embed(c, config)));

  const found: string[] = [];
  const missed: string[] = [];

  for (const item of candidates) {
    const itemEmbedding = await embed(item, config);
    let maxSim = 0;
    for (const chunkEmb of chunkEmbeddings) {
      const sim = cosineSimilarity(itemEmbedding, chunkEmb);
      if (sim > maxSim) maxSim = sim;
    }

    if (maxSim >= SEMANTIC_THRESHOLD) {
      found.push(item);
    } else {
      missed.push(item);
    }
  }

  return { found, missed };
}

// ---------------------------------------------------------------------------
// Query-level scoring
// ---------------------------------------------------------------------------

/**
 * Score a single query response against its expectation.
 * Uses substring matching first, then semantic similarity fallback for missed items.
 */
export async function scoreQuery(
  responseText: string,
  expectation: QueryExpectation,
  latencyMs: number,
  queryText: string,
): Promise<QueryResult> {
  const lower = responseText.toLowerCase();

  const foundItems: string[] = [];
  const substringMissed: string[] = [];
  const unwantedItems: string[] = [];

  // Check mustInclude — substring first
  const mustInclude = expectation.mustInclude ?? [];
  for (const item of mustInclude) {
    if (lower.includes(item.toLowerCase())) {
      foundItems.push(item);
    } else {
      substringMissed.push(item);
    }
  }

  // Semantic fallback for items not found by substring
  let missedItems: string[];
  if (substringMissed.length > 0) {
    const semantic = await semanticMatch(responseText, substringMissed);
    foundItems.push(...semantic.found);
    missedItems = semantic.missed;
  } else {
    missedItems = [];
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
