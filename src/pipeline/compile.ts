/**
 * CLI entry point for `ironcurtain compile-policy`.
 *
 * Thin wrapper over PipelineRunner that handles CLI-specific concerns:
 * loading config, printing the progress banner, and exit codes.
 *
 * The core compile-verify-repair loop lives in PipelineRunner.
 *
 * CLI flags:
 *   --constitution <path>  Use an alternative constitution file
 *   --output-dir <path>    Write compiled artifacts to this directory
 *   --server <name>        Compile only this server (for debugging)
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import { loadPipelineConfig, loadToolAnnotationsFile } from './pipeline-shared.js';
import { PipelineRunner, createPipelineModels } from './pipeline-runner.js';

// Re-export utilities that test files import from this file.
export { resolveRulePaths, mergeReplacements } from './pipeline-shared.js';

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

export interface CompilePolicyCliArgs {
  constitution?: string;
  outputDir?: string;
  server?: string;
}

/**
 * Parses --constitution, --output-dir, and --server from process.argv.
 * Returns resolved absolute paths when provided.
 */
export function parseCompilePolicyArgs(argv: string[] = process.argv.slice(2)): CompilePolicyCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      constitution: { type: 'string' },
      'output-dir': { type: 'string' },
      server: { type: 'string' },
    },
    strict: false,
  });
  const constitution = typeof values.constitution === 'string' ? values.constitution : undefined;
  const outputDir = typeof values['output-dir'] === 'string' ? values['output-dir'] : undefined;
  const server = typeof values.server === 'string' ? values.server : undefined;
  return {
    constitution: constitution ? resolve(constitution) : undefined,
    outputDir: outputDir ? resolve(outputDir) : undefined,
    server,
  };
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const cliArgs = parseCompilePolicyArgs();
  const config = loadPipelineConfig(cliArgs);

  // Load tool annotations early to validate they exist before printing the banner
  const toolAnnotationsFile = loadToolAnnotationsFile(config.generatedDir, config.packageGeneratedDir);
  if (!toolAnnotationsFile) {
    console.error(
      chalk.red.bold(
        "Error: tool-annotations.json not found. Run 'npm run annotate-tools' first to generate tool annotations.",
      ),
    );
    process.exit(1);
  }

  const allAnnotations = Object.values(toolAnnotationsFile.servers).flatMap((server) => server.tools);
  const serverNames = Object.keys(toolAnnotationsFile.servers);

  console.error(chalk.bold('Policy Compilation Pipeline (per-server)'));
  console.error(chalk.bold('========================================='));
  console.error(`Constitution: ${chalk.dim(config.constitutionPath)}`);
  console.error(`Sandbox:      ${chalk.dim(config.allowedDirectory)}`);
  console.error(`Output:       ${chalk.dim(config.generatedDir + '/')}`);
  console.error(
    `Annotations:  ${chalk.dim(`${allAnnotations.length} tools from ${serverNames.length} server(s): ${serverNames.join(', ')}`)}`,
  );
  if (cliArgs.server) {
    console.error(`Server filter: ${chalk.cyan(cliArgs.server)}`);
  }
  console.error('');

  const models = await createPipelineModels(config.generatedDir);

  const runner = new PipelineRunner(models);

  try {
    await runner.run({
      constitutionInput: config.constitutionText,
      constitutionKind: 'constitution',
      outputDir: config.generatedDir,
      toolAnnotationsDir: config.generatedDir,
      toolAnnotationsFallbackDir: config.packageGeneratedDir,
      allowedDirectory: config.allowedDirectory,
      protectedPaths: config.protectedPaths,
      mcpServers: config.mcpServers,
      llmLogPath: models.logPath,
      preloadedToolAnnotations: toolAnnotationsFile,
      serverFilter: cliArgs.server ? [cliArgs.server] : undefined,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Verification FAILED')) {
      console.error('');
      console.error(chalk.red.bold('Verification FAILED — artifacts written but policy may need review.'));
      process.exit(1);
    }
    throw err;
  }
}

// Only run when executed directly (not when imported by cli.ts or tests)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  main().catch((err: unknown) => {
    console.error(chalk.red.bold('Policy compilation failed:'), err);
    process.exit(1);
  });
}
