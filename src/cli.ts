#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  // Works from both dist/ and src/ since package.json is one level up in either case.
  const packageJsonPath = resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  return pkg.version;
}

function printHelp(): void {
  console.error(
    `
ironcurtain - Secure agent runtime with policy-driven tool mediation

Usage:
  ironcurtain <command> [options]

Commands:
  start [task]         Run the agent (interactive or single-shot)
  annotate-tools       Classify MCP tool arguments via LLM
  compile-policy       Compile constitution into enforceable policy rules
  refresh-lists        Re-resolve dynamic lists without full recompilation
  config               Edit configuration interactively
  help                 Show this help message

Options:
  -h, --help           Show this help message
  -v, --version        Show version number

Examples:
  ironcurtain start                              # Interactive session
  ironcurtain start "Summarize files in ."       # Single-shot task
  ironcurtain start --resume <session-id>        # Resume a session
  ironcurtain annotate-tools                     # Classify tool arguments
  ironcurtain compile-policy                     # Compile policy from constitution
  ironcurtain refresh-lists                      # Refresh all dynamic lists
  ironcurtain refresh-lists --list major-news    # Refresh a single list
  ironcurtain refresh-lists --with-mcp           # Include MCP-backed lists
`.trim(),
  );
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: true,
  strict: false,
});

if (values.version) {
  console.log(getVersion());
  process.exit(0);
}

const subcommand = positionals[0];

if (values.help || subcommand === 'help' || !subcommand) {
  printHelp();
  process.exit(0);
}

switch (subcommand) {
  case 'start': {
    const { main } = await import('./index.js');
    await main(process.argv.slice(3));
    break;
  }
  case 'annotate-tools': {
    const { main } = await import('./pipeline/annotate.js');
    await main();
    break;
  }
  case 'compile-policy': {
    const { main } = await import('./pipeline/compile.js');
    await main();
    break;
  }
  case 'refresh-lists': {
    const { main } = await import('./pipeline/refresh-lists.js');
    await main(process.argv.slice(3));
    break;
  }
  case 'config': {
    const { runConfigCommand } = await import('./config/config-command.js');
    await runConfigCommand();
    break;
  }
  default:
    console.error(`Unknown command: ${subcommand}\n`);
    printHelp();
    process.exit(1);
}
