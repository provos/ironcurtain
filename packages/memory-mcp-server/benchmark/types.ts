/**
 * Shared types for the memory MCP server benchmark suite.
 *
 * Inspired by LongMemEval (ICLR 2025) categories:
 *   1. Information Extraction (basic recall)
 *   2. Multi-Session Reasoning (cross-memory synthesis)
 *   3. Knowledge Updates (contradiction / temporal)
 *   4. Temporal Reasoning (time-aware retrieval)
 *   5. Abstention (knowing what you don't know)
 *
 * Extended with MCP-specific categories:
 *   6. Token Budget Efficiency
 *   7. Deduplication Quality
 *   8. Scale Stress
 *   9. Session Briefing (memory_context)
 */

// ---------------------------------------------------------------------------
// Benchmark categories
// ---------------------------------------------------------------------------

export type BenchmarkCategory =
  | 'basic-recall'
  | 'semantic-search'
  | 'knowledge-updates'
  | 'temporal-reasoning'
  | 'abstention'
  | 'token-budget'
  | 'deduplication'
  | 'scale-stress'
  | 'session-briefing';

export const ALL_CATEGORIES: readonly BenchmarkCategory[] = [
  'basic-recall',
  'semantic-search',
  'knowledge-updates',
  'temporal-reasoning',
  'abstention',
  'token-budget',
  'deduplication',
  'scale-stress',
  'session-briefing',
] as const;

// ---------------------------------------------------------------------------
// Test scenario primitives
// ---------------------------------------------------------------------------

/** A single memory to store during test setup. */
export interface TestMemory {
  content: string;
  tags?: string[];
  importance?: number;
  /** Delay (ms) after the previous store — used to create temporal ordering. */
  delayAfterMs?: number;
}

/** A query issued after memories are stored. */
export interface TestQuery {
  query: string;
  tags?: string[];
  tokenBudget?: number;
  format?: 'summary' | 'list' | 'raw';
}

/** Ground-truth expectation for a query. */
export interface QueryExpectation {
  /** Memory contents (or substrings) that MUST appear in the response. */
  mustInclude?: string[];
  /** Memory contents (or substrings) that MUST NOT appear in the response. */
  mustExclude?: string[];
  /** Minimum number of relevant memories expected. */
  minRelevant?: number;
  /** Maximum number of irrelevant memories tolerated. */
  maxIrrelevant?: number;
  /** If true, the server should indicate "no relevant memories found" or similar. */
  expectEmpty?: boolean;
}

/** A complete test scenario with setup, queries, and expectations. */
export interface TestScenario {
  id: string;
  name: string;
  category: BenchmarkCategory;
  description: string;
  memories: TestMemory[];
  queries: Array<{
    query: TestQuery;
    expectation: QueryExpectation;
  }>;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface QueryMetrics {
  /** Did the response include all mustInclude items? */
  precision: number;
  /** What fraction of mustInclude items were found? */
  recall: number;
  /** Harmonic mean of precision and recall. */
  f1: number;
  /** Were all mustExclude items absent? */
  exclusionScore: number;
  /** Latency in milliseconds. */
  latencyMs: number;
}

export interface CategoryResult {
  category: BenchmarkCategory;
  scenarioCount: number;
  queryCount: number;
  avgPrecision: number;
  avgRecall: number;
  avgF1: number;
  avgExclusionScore: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  /** Individual scenario results for detailed inspection. */
  scenarios: ScenarioResult[];
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  queries: QueryResult[];
}

export interface QueryResult {
  query: string;
  metrics: QueryMetrics;
  /** The raw response text from the server. */
  responseText: string;
  /** Which expected items were found / missed. */
  foundItems: string[];
  missedItems: string[];
  unwantedItems: string[];
}

export interface BenchmarkReport {
  timestamp: string;
  serverCommand: string;
  categories: CategoryResult[];
  overallScore: number;
  totalQueries: number;
  totalLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Server configuration (generic — works for any MCP memory server)
// ---------------------------------------------------------------------------

export interface ServerConfig {
  /** Command to spawn the server (e.g. 'node'). */
  command: string;
  /** Arguments (e.g. ['dist/index.js']). */
  args: string[];
  /** Working directory for the server process. */
  cwd: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
}
