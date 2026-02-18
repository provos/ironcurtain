import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { createSession } from './session/index.js';
import { CliTransport } from './session/cli-transport.js';
import * as logger from './logger.js';

async function main() {
  const task = process.argv.slice(2).join(' ');
  const config = loadConfig();

  process.stderr.write('Initializing session...\n');
  const session = await createSession({
    config,
    onEscalation: (req) => {
      process.stderr.write('\n========================================\n');
      process.stderr.write('  ESCALATION: Human approval required\n');
      process.stderr.write('========================================\n');
      process.stderr.write(`  Tool:      ${req.serverName}/${req.toolName}\n`);
      process.stderr.write(`  Arguments: ${JSON.stringify(req.arguments, null, 2)}\n`);
      process.stderr.write(`  Reason:    ${req.reason}\n`);
      process.stderr.write('========================================\n');
      process.stderr.write('  Type /approve or /deny\n');
      process.stderr.write('========================================\n\n');
    },
    onDiagnostic: (event) => {
      switch (event.kind) {
        case 'tool_call':
          logger.info(`[sandbox] ${event.toolName}: ${event.preview}`);
          break;
        case 'agent_text':
          logger.info(`[agent] ${event.preview}`);
          break;
      }
    },
  });
  process.stderr.write('Session ready.\n\n');

  // If a task was provided on the command line, run single-shot.
  // Otherwise, enter interactive mode.
  const transport = new CliTransport(task || undefined);

  try {
    await transport.run(session);
  } finally {
    await session.close();
    logger.teardown();
    process.exit(0);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
