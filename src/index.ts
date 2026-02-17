import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config/index.js';
import { Sandbox } from './sandbox/index.js';
import { runAgent } from './agent/index.js';

async function main() {
  const task = process.argv.slice(2).join(' ');
  if (!task) {
    console.error('Usage: npm start "Your task description"');
    process.exit(1);
  }

  const config = loadConfig();

  mkdirSync(config.allowedDirectory, { recursive: true });

  // The sandbox connects to the MCP proxy server, which mediates
  // all tool calls through the trusted process policy engine.
  console.error('Initializing sandbox...');
  const sandbox = new Sandbox();
  await sandbox.initialize(config);
  console.error('Sandbox ready.\n');

  try {
    const result = await runAgent(task, sandbox);
    console.log('\n=== Agent Response ===');
    console.log(result);
  } finally {
    await sandbox.shutdown();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
