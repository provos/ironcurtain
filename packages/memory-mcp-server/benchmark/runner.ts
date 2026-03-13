/**
 * Benchmark runner — orchestrates scenario execution against a memory MCP server.
 *
 * Connects to the server, runs each scenario in isolation (fresh namespace per scenario),
 * and collects metrics.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { BenchmarkCategory, BenchmarkReport, CategoryResult, ScenarioResult, TestScenario } from './types.js';
import { storeAll, recallMemories, getContext, closeServer, spawnServer } from './harness.js';
import { scoreQuery, aggregateCategory, buildReport } from './scorer.js';
import type { ServerConfig } from './types.js';

export interface RunnerOptions {
  serverConfig: ServerConfig;
  scenarios: TestScenario[];
  /** If true, print progress to stderr. */
  verbose?: boolean;
}

/**
 * Run all scenarios grouped by category.
 * Each scenario gets a fresh server instance (clean database) for isolation.
 */
export async function runBenchmark(opts: RunnerOptions): Promise<BenchmarkReport> {
  const { serverConfig, scenarios, verbose } = opts;

  // Group scenarios by category
  const byCategory = new Map<BenchmarkCategory, TestScenario[]>();
  for (const s of scenarios) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s);
    byCategory.set(s.category, list);
  }

  const categoryResults: CategoryResult[] = [];

  for (const [category, catScenarios] of byCategory) {
    if (verbose) {
      process.stderr.write(`\n--- Category: ${category} ---\n`);
    }

    const scenarioResults: ScenarioResult[] = [];

    for (const scenario of catScenarios) {
      if (verbose) {
        process.stderr.write(
          `  Scenario: ${scenario.name} (${scenario.memories.length} memories, ${scenario.queries.length} queries)\n`,
        );
      }

      const result = await runScenario(scenario, serverConfig, category, verbose);
      scenarioResults.push(result);
    }

    categoryResults.push(aggregateCategory(category, scenarioResults));
  }

  const cmdStr = `${serverConfig.command} ${serverConfig.args.join(' ')}`;
  return buildReport(categoryResults, cmdStr);
}

async function runScenario(
  scenario: TestScenario,
  serverConfig: ServerConfig,
  category: BenchmarkCategory,
  verbose?: boolean,
): Promise<ScenarioResult> {
  // Each scenario gets a fresh database via a unique temp path
  const tmpDb = `/tmp/memory-bench-${process.pid}-${Date.now()}-${scenario.id}.db`;
  const config: ServerConfig = {
    ...serverConfig,
    env: {
      ...serverConfig.env,
      MEMORY_DB_PATH: tmpDb,
      MEMORY_NAMESPACE: scenario.id,
    },
  };

  let client: Client | undefined;
  try {
    client = await spawnServer(config);

    // Store all memories
    await storeAll(client, scenario.memories);

    // Run queries and score
    const queryResults = [];
    for (const { query, expectation } of scenario.queries) {
      const start = performance.now();

      let responseText: string;
      if (category === 'session-briefing') {
        // Use memory_context instead of memory_recall
        responseText = await getContext(client, query.query, query.tokenBudget);
      } else {
        responseText = await recallMemories(client, query.query, {
          tags: query.tags,
          tokenBudget: query.tokenBudget,
          format: query.format,
        });
      }

      const latencyMs = performance.now() - start;

      const result = await scoreQuery(responseText, expectation, latencyMs, query.query);
      queryResults.push(result);

      if (verbose) {
        const icon = result.metrics.f1 >= 0.8 ? 'PASS' : result.metrics.f1 >= 0.5 ? 'WARN' : 'FAIL';
        process.stderr.write(
          `    [${icon}] "${query.query}" — F1=${(result.metrics.f1 * 100).toFixed(0)}% (${result.metrics.latencyMs.toFixed(0)}ms)\n`,
        );
        if (result.missedItems.length > 0) {
          process.stderr.write(`           Missed: ${result.missedItems.join(', ')}\n`);
        }
        if (result.unwantedItems.length > 0) {
          process.stderr.write(`           Unwanted: ${result.unwantedItems.join(', ')}\n`);
        }
      }
    }

    return { scenarioId: scenario.id, scenarioName: scenario.name, queries: queryResults };
  } finally {
    if (client) {
      await closeServer(client).catch(() => {});
    }
    // Clean up temp database
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(tmpDb);
      // SQLite WAL/SHM files
      try {
        unlinkSync(`${tmpDb}-wal`);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(`${tmpDb}-shm`);
      } catch {
        /* ignore */
      }
    } catch {
      // temp file may not exist
    }
  }
}
