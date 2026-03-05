/**
 * CLI entry point for `ironcurtain compile-policy`.
 *
 * Thin wrapper over PipelineRunner that handles CLI-specific concerns:
 * loading config, printing the progress banner, and exit codes.
 *
 * The core compile-verify-repair loop lives in PipelineRunner.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { loadPipelineConfig, loadToolAnnotationsFile } from './pipeline-shared.js';
import { PipelineRunner, createPipelineModels } from './pipeline-runner.js';

// Re-export utilities that test files import from this file.
export { resolveRulePaths, mergeReplacements } from './pipeline-shared.js';

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const config = loadPipelineConfig();

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

  console.error(chalk.bold('Policy Compilation Pipeline'));
  console.error(chalk.bold('==========================='));
  console.error(`Constitution: ${chalk.dim(config.constitutionPath)}`);
  console.error(`Sandbox:      ${chalk.dim(config.allowedDirectory)}`);
  console.error(`Output:       ${chalk.dim(config.generatedDir + '/')}`);
  console.error(
    `Annotations:  ${chalk.dim(`${allAnnotations.length} tools from ${Object.keys(toolAnnotationsFile.servers).length} server(s)`)}`,
  );
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
