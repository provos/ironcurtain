/**
 * Benchmark suite public API.
 *
 * Useful for programmatic access from other tools or test harnesses.
 */

export {
  spawnServer,
  closeServer,
  storeMemory,
  recallMemories,
  getContext,
  forgetMemories,
  inspectMemories,
  storeAll,
  callTool,
} from './harness.js';
export { scoreQuery, aggregateCategory, computeOverallScore, buildReport, formatReport } from './scorer.js';
export {
  generateAllScenarios,
  basicRecallScenarios,
  semanticSearchScenarios,
  knowledgeUpdateScenarios,
  temporalReasoningScenarios,
  abstentionScenarios,
  tokenBudgetScenarios,
  deduplicationScenarios,
  scaleStressScenarios,
  sessionBriefingScenarios,
} from './data-generator.js';
export { runBenchmark } from './runner.js';
export type {
  BenchmarkCategory,
  BenchmarkReport,
  CategoryResult,
  ScenarioResult,
  QueryResult,
  QueryMetrics,
  TestScenario,
  TestMemory,
  TestQuery,
  QueryExpectation,
  ServerConfig,
} from './types.js';
