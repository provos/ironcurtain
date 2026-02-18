import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { createSession } from './session/index.js';
import { CliTransport } from './session/cli-transport.js';

async function main() {
  const task = process.argv.slice(2).join(' ');
  const config = loadConfig();

  console.error('Initializing session...');
  const session = await createSession({
    config,
    onEscalation: (req) => {
      console.error('\n========================================');
      console.error('  ESCALATION: Human approval required');
      console.error('========================================');
      console.error(`  Tool:      ${req.serverName}/${req.toolName}`);
      console.error(`  Arguments: ${JSON.stringify(req.arguments, null, 2)}`);
      console.error(`  Reason:    ${req.reason}`);
      console.error('========================================');
      console.error('  Type /approve or /deny');
      console.error('========================================\n');
    },
    onDiagnostic: (event) => {
      switch (event.kind) {
        case 'tool_call':
          console.error(`  [sandbox] ${event.toolName}: ${event.preview}`);
          break;
        case 'agent_text':
          console.error(`  [agent] ${event.preview}`);
          break;
      }
    },
  });
  console.error('Session ready.\n');

  // If a task was provided on the command line, run single-shot.
  // Otherwise, enter interactive mode.
  const transport = new CliTransport(task || undefined);

  try {
    await transport.run(session);
  } finally {
    await session.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
