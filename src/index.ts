import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, loadGeneratedPolicy, checkConstitutionFreshness } from './config/index.js';
import * as logger from './logger.js';
import { CliTransport } from './session/cli-transport.js';
import { createSession } from './session/index.js';

export async function main(args?: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: args ?? process.argv.slice(2),
    options: {
      resume: { type: 'string', short: 'r' },
    },
    allowPositionals: true,
    strict: false,
  });

  const task = positionals.join(' ');
  const resumeSessionId = values.resume as string | undefined;
  const config = loadConfig();

  // Check constitution freshness once here, before any proxy processes are spawned.
  const { compiledPolicy } = loadGeneratedPolicy(config.generatedDir);
  checkConstitutionFreshness(compiledPolicy, config.constitutionPath);

  // Create the transport first so we can wire its callbacks into the session.
  const transport = new CliTransport({ initialMessage: task || undefined });

  const initSpinner = ora({
    text: 'Initializing session...',
    stream: process.stderr,
    discardStdin: false,
  }).start();

  let session;
  try {
    session = await createSession({
      config,
      resumeSessionId,
      onEscalation: transport.createEscalationHandler(),
      onEscalationExpired: transport.createEscalationExpiredHandler(),
      onDiagnostic: transport.createDiagnosticHandler(),
    });
  } catch (error) {
    initSpinner.fail(chalk.red('Session initialization failed'));
    throw error;
  }

  initSpinner.succeed(chalk.dim('Session ready'));
  process.stderr.write('\n');

  try {
    await transport.run(session);
  } finally {
    await session.close();
    logger.teardown();
    process.exit(0);
  }
}

// Only run when executed directly (not when imported by cli.ts)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  main().catch((err: unknown) => {
    process.stderr.write(chalk.red(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exit(1);
  });
}
