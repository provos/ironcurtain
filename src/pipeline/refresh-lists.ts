/**
 * CLI entry point for `ironcurtain refresh-lists`.
 *
 * Re-resolves dynamic list definitions without re-running the full
 * compilation pipeline. Loads list definitions from compiled-policy.json
 * (the authoritative source), resolves them via LLM (and optionally MCP),
 * and writes the updated dynamic-lists.json. Manual overrides are preserved.
 *
 * Always bypasses the inputHash cache -- refresh means "get fresh data".
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { resolveAllLists, type McpServerConnection } from './list-resolver.js';
import { connectMcpServersForLists, disconnectMcpServers } from './compile.js';
import {
  createPipelineLlm,
  loadExistingArtifact,
  loadPipelineConfig,
  writeArtifact,
  withSpinner,
} from './pipeline-shared.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  ListDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// Argument Parsing
// ---------------------------------------------------------------------------

interface RefreshListsOptions {
  /** When set, refresh only this named list. */
  readonly listName?: string;
  /** When true, connect to MCP servers for data-backed lists. */
  readonly withMcp: boolean;
}

function parseRefreshArgs(args: string[]): RefreshListsOptions {
  let listName: string | undefined;
  let withMcp = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list' && i + 1 < args.length) {
      listName = args[++i];
    } else if (args[i] === '--with-mcp') {
      withMcp = true;
    }
  }

  return { listName, withMcp };
}

// ---------------------------------------------------------------------------
// List Filtering
// ---------------------------------------------------------------------------

/**
 * Selects which list definitions to refresh based on CLI options.
 * Without --with-mcp, data-backed lists are skipped with a warning.
 * Without --list, all eligible lists are included.
 */
function selectListsToRefresh(
  definitions: ListDefinition[],
  options: RefreshListsOptions,
): ListDefinition[] {
  let selected = definitions;

  // Filter to a single named list if --list was specified
  if (options.listName) {
    selected = selected.filter(d => d.name === options.listName);
    if (selected.length === 0) {
      console.error(chalk.red(`Error: List "${options.listName}" not found in compiled policy.`));
      console.error(`Available lists: ${definitions.map(d => d.name).join(', ') || '(none)'}`);
      process.exit(1);
    }
  }

  // Without --with-mcp, skip data-backed lists
  if (!options.withMcp) {
    for (const def of selected.filter(d => d.requiresMcp)) {
      console.error(`  ${chalk.yellow('Skipping:')} @${def.name} (requires MCP — use --with-mcp to include)`);
    }
    selected = selected.filter(d => !d.requiresMcp);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(args: string[] = []): Promise<void> {
  const options = parseRefreshArgs(args);
  const config = loadPipelineConfig();

  // Load compiled policy to get list definitions
  const compiledPolicy = loadExistingArtifact<CompiledPolicyFile>(
    config.generatedDir, 'compiled-policy.json', config.packageGeneratedDir,
  );
  if (!compiledPolicy) {
    console.error(chalk.red.bold(
      "Error: compiled-policy.json not found. Run 'ironcurtain compile-policy' first.",
    ));
    process.exit(1);
  }

  const allDefinitions = compiledPolicy.listDefinitions ?? [];
  if (allDefinitions.length === 0) {
    console.error(chalk.yellow('No dynamic lists defined in compiled policy. Nothing to refresh.'));
    return;
  }

  console.error(chalk.bold('Dynamic List Refresh'));
  console.error(chalk.bold('===================='));
  console.error(`Lists defined: ${chalk.dim(String(allDefinitions.length))}`);
  console.error(`Output:        ${chalk.dim(config.generatedDir + '/')}`);
  console.error('');

  const definitionsToRefresh = selectListsToRefresh(allDefinitions, options);
  if (definitionsToRefresh.length === 0) {
    console.error(chalk.yellow('No eligible lists to refresh.'));
    return;
  }

  const { model: llm, logPath } = await createPipelineLlm(
    config.generatedDir, 'refresh-lists',
  );

  // Load existing dynamic-lists.json for manual overrides and non-refreshed lists
  const existingLists = loadExistingArtifact<DynamicListsFile>(
    config.generatedDir, 'dynamic-lists.json', config.packageGeneratedDir,
  );

  // Connect to MCP servers if needed
  const needsMcp = options.withMcp && definitionsToRefresh.some(d => d.requiresMcp);
  let mcpConnections: Map<string, McpServerConnection> | undefined;
  if (needsMcp) {
    mcpConnections = await connectMcpServersForLists(
      definitionsToRefresh, config.mcpServers,
    );
  }

  try {
    const stepText = 'Refreshing dynamic lists';
    const { result: refreshedLists } = await withSpinner(
      stepText,
      async (spinner) => resolveAllLists(
        definitionsToRefresh,
        { model: llm, mcpConnections },
        existingLists,
        (msg) => { spinner.text = `${stepText} — ${msg}`; },
        true, // bypassCache: always re-resolve on refresh
      ),
      (result, elapsed) => {
        const count = Object.keys(result.lists).length;
        return `${stepText}: ${count} list(s) refreshed (${elapsed.toFixed(1)}s)`;
      },
    );

    // Merge refreshed lists with any non-refreshed lists from the existing file
    const mergedLists: DynamicListsFile = {
      generatedAt: refreshedLists.generatedAt,
      lists: {
        ...(existingLists?.lists ?? {}),
        ...refreshedLists.lists,
      },
    };
    writeArtifact(config.generatedDir, 'dynamic-lists.json', mergedLists);

    console.error('');
    console.error(`  Lists refreshed: ${Object.keys(refreshedLists.lists).length}`);
    console.error(`  Artifact written to: ${chalk.dim(config.generatedDir + '/dynamic-lists.json')}`);
    console.error(`  LLM interaction log: ${chalk.dim(logPath)}`);
    console.error('');
    console.error(chalk.green.bold('List refresh successful!'));
  } finally {
    if (mcpConnections) {
      await disconnectMcpServers(mcpConnections);
    }
  }
}

// Only run when executed directly (not when imported by cli.ts or tests)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  main(process.argv.slice(2)).catch((err) => {
    console.error(chalk.red.bold('List refresh failed:'), err);
    process.exit(1);
  });
}
