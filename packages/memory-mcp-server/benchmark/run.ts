#!/usr/bin/env node
/**
 * CLI entry point for the benchmark suite.
 *
 * Usage:
 *   npx tsx benchmark/run.ts [options]
 *
 * Options:
 *   --category <name>   Run only one category (can be repeated)
 *   --scale <n>         Number of memories for scale-stress test (default: 1000)
 *   --with-llm          Set MEMORY_LLM_API_KEY from .env for LLM-enhanced mode
 *   --server-cmd <cmd>  Server command (default: node)
 *   --server-args <a>   Server args, comma-separated (default: dist/index.js)
 *   --server-cwd <dir>  Server working directory (default: .)
 *   --json              Output JSON report instead of human-readable
 *   --verbose           Print progress to stderr
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { generateAllScenarios } from './data-generator.js';
import { runBenchmark } from './runner.js';
import { formatReport } from './scorer.js';
import type { ServerConfig } from './types.js';

function parseArgs(argv: string[]): {
  categories: string[];
  scale: number;
  withLlm: boolean;
  serverCmd: string;
  serverArgs: string[];
  serverCwd: string;
  json: boolean;
  verbose: boolean;
} {
  const result = {
    categories: [] as string[],
    scale: 1000,
    withLlm: false,
    serverCmd: 'node',
    serverArgs: ['dist/index.js'],
    serverCwd: '.',
    json: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--category':
        result.categories.push(argv[++i]);
        break;
      case '--scale':
        result.scale = parseInt(argv[++i], 10);
        break;
      case '--with-llm':
        result.withLlm = true;
        break;
      case '--server-cmd':
        result.serverCmd = argv[++i];
        break;
      case '--server-args':
        result.serverArgs = argv[++i].split(',');
        break;
      case '--server-cwd':
        result.serverCwd = argv[++i];
        break;
      case '--json':
        result.json = true;
        break;
      case '--verbose':
        result.verbose = true;
        break;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Load .env for LLM key if requested
  const envOverrides: Record<string, string> = {};
  if (args.withLlm) {
    const envPath = resolve(args.serverCwd, '.env');
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
        if (match) {
          envOverrides[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
      }
    }
  }

  const serverConfig: ServerConfig = {
    command: args.serverCmd,
    args: args.serverArgs,
    cwd: resolve(args.serverCwd),
    env: envOverrides,
  };

  const scenarios = generateAllScenarios({
    categories: args.categories.length > 0 ? args.categories : undefined,
    scaleSize: args.scale,
  });

  if (args.verbose) {
    process.stderr.write(
      `Running ${scenarios.length} scenarios (${scenarios.reduce((s, sc) => s + sc.queries.length, 0)} queries)\n`,
    );
  }

  const report = await runBenchmark({
    serverConfig,
    scenarios,
    verbose: args.verbose,
  });

  if (args.json) {
    // Strip verbose response text from JSON output
    const stripped = {
      ...report,
      categories: report.categories.map((c) => ({
        ...c,
        scenarios: c.scenarios.map((s) => ({
          ...s,
          queries: s.queries.map((q) => ({
            query: q.query,
            metrics: q.metrics,
            foundItems: q.foundItems,
            missedItems: q.missedItems,
            unwantedItems: q.unwantedItems,
          })),
        })),
      })),
    };
    process.stdout.write(JSON.stringify(stripped, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(report));
  }

  process.exit(report.overallScore >= 80 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`Benchmark failed: ${String(err)}\n`);
  process.exit(2);
});
