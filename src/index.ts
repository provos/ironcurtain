import 'dotenv/config';
import { parseArgs } from 'node:util';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from './config/index.js';
import { createSession } from './session/index.js';
import { CliTransport } from './session/cli-transport.js';
import * as logger from './logger.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      resume: { type: 'string', short: 'r' },
    },
    allowPositionals: true,
    strict: false,
  });

  const task = positionals.join(' ');
  const resumeSessionId = values.resume as string | undefined;
  const config = loadConfig();

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

main().catch((err) => {
  process.stderr.write(chalk.red(`Fatal error: ${err}\n`));
  process.exit(1);
});
