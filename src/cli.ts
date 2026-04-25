#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkHelp, printHelp as printSpecHelp, type CommandSpec } from './cli-help.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  // Works from both dist/ and src/ since package.json is one level up in either case.
  const packageJsonPath = resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };
  return pkg.version;
}

const topLevelSpec: CommandSpec = {
  name: 'ironcurtain',
  description: 'Secure agent runtime with policy-driven tool mediation',
  usage: ['ironcurtain <command> [options]'],
  subcommands: [
    { name: 'start [task]', description: 'Run the agent (interactive or single-shot)' },
    { name: 'daemon', description: 'Unified Signal + cron daemon' },
    { name: 'mux', description: 'Terminal multiplexer for PTY sessions (requires node-pty)' },
    { name: 'escalation-listener', description: 'Aggregate escalation notifications from PTY sessions' },
    { name: 'bot', description: "Alias for 'daemon' (backward compatible)" },
    { name: 'persona', description: 'Manage personas (named policy profiles)' },
    { name: 'auth', description: 'Manage OAuth providers (import credentials, authorize, revoke)' },
    { name: 'setup', description: 'Run the first-start wizard (always runs)' },
    { name: 'setup-signal', description: 'Interactive Signal transport onboarding' },
    { name: 'annotate-tools', description: 'Classify MCP tool arguments via LLM (--server <name> or --all)' },
    { name: 'compile-policy', description: 'Compile constitution into enforceable policy rules' },
    { name: 'refresh-lists', description: 'Re-resolve dynamic lists without full recompilation' },
    { name: 'customize-policy', description: 'Customize your policy via LLM-assisted conversation' },
    { name: 'config', description: 'Edit configuration interactively' },
    { name: 'workflow', description: 'Run multi-agent workflows (start, resume, inspect)' },
    { name: 'observe', description: 'Watch live LLM token output for running sessions' },
    { name: 'help', description: 'Show this help message' },
  ],
  options: [
    { flag: 'help', short: 'h', description: 'Show this help message' },
    { flag: 'version', short: 'v', description: 'Show version number' },
  ],
  examples: [
    'ironcurtain start "Summarize files in ."       # Single-shot task',
    'ironcurtain start                              # Interactive session',
    'ironcurtain start --resume <session-id>        # Resume a session',
    'ironcurtain start -w ./my-project "Fix bugs"   # Work in existing directory',
    'ironcurtain start --agent claude-code "task"   # Docker: Claude Code',
    'ironcurtain start --pty                        # PTY mode',
    'ironcurtain daemon                             # Start the daemon',
    'ironcurtain daemon list-jobs                   # List scheduled jobs',
    'ironcurtain compile-policy                     # Compile policy',
    'ironcurtain refresh-lists --with-mcp           # Refresh dynamic lists',
  ],
};

const setupSignalSpec: CommandSpec = {
  name: 'ironcurtain setup-signal',
  description: 'Interactive Signal transport onboarding',
  usage: ['ironcurtain setup-signal [options]'],
  options: [{ flag: 're-trust', description: 'Re-verify a changed identity key' }],
};

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

// Show top-level help when no subcommand is given or 'help' is the subcommand.
// When a recognized subcommand is present, --help passes through to the
// subcommand handler via process.argv.slice(3).
if (!subcommand || subcommand === 'help') {
  printSpecHelp(topLevelSpec);
  process.exit(0);
}

// Commands that require the V8 sandbox. We check early to catch Node version
// mismatches (like Node 25) or stale native module builds before importing heavy dependencies.
// `compile-policy` is the offline policy pipeline and never instantiates the V8 sandbox.
const requiresSandbox = ['start', 'daemon', 'bot', 'workflow'];
if (requiresSandbox.includes(subcommand)) {
  const { checkSandboxViability } = await import('./utils/preflight-checks.js');
  const result = await checkSandboxViability();
  if (!result.ok) {
    const chalk = (await import('chalk')).default;
    // Use process.stderr.write rather than console.error because the logger
    // (src/logger.ts) monkey-patches console.* to redirect into the session log
    // file. Writing directly to stderr keeps fatal errors visible on the terminal.
    process.stderr.write(`\n${chalk.bold(chalk.red('Fatal Error:'))} ${result.message}\n`);
    if (result.details) {
      process.stderr.write(chalk.dim(result.details) + '\n\n');
    }
    process.exit(1);
  }
}

switch (subcommand) {
  case 'start': {
    const { main } = await import('./index.js');
    await main(process.argv.slice(3));
    break;
  }
  case 'annotate-tools': {
    const { main } = await import('./pipeline/annotate.js');
    await main(process.argv.slice(3));
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
  case 'customize-policy': {
    const { main } = await import('./pipeline/constitution-customizer.js');
    await main();
    break;
  }
  case 'config': {
    const { runConfigCommand } = await import('./config/config-command.js');
    await runConfigCommand();
    break;
  }
  case 'persona': {
    const { main: personaMain } = await import('./persona/persona-command.js');
    await personaMain(process.argv.slice(3));
    break;
  }
  case 'auth': {
    const { runAuthCommand } = await import('./auth/auth-command.js');
    await runAuthCommand(process.argv.slice(3));
    break;
  }
  case 'setup': {
    const { runFirstStart } = await import('./config/first-start.js');
    await runFirstStart();
    break;
  }
  case 'daemon': {
    const { runDaemonCommand } = await import('./daemon/daemon-command.js');
    await runDaemonCommand(process.argv.slice(3));
    break;
  }
  case 'bot': {
    // 'bot' is an alias for 'daemon' (backward compatibility)
    const botArgs = process.argv.slice(3);
    if (botArgs.includes('--help') || botArgs.includes('-h')) {
      const { botSpec } = await import('./signal/bot-command.js');
      printSpecHelp(botSpec);
      break;
    }
    const agentName = values.agent as string | undefined;
    if (botArgs.some((a) => !a.startsWith('-'))) {
      // Has subcommands -- route through daemon command
      const { runDaemonCommand } = await import('./daemon/daemon-command.js');
      await runDaemonCommand(botArgs);
    } else {
      // No subcommands -- existing bot behavior
      const { runBot } = await import('./signal/bot-command.js');
      await runBot({ agent: agentName });
    }
    break;
  }
  case 'mux': {
    const { main: muxMain } = await import('./mux/mux-command.js');
    await muxMain(process.argv.slice(3));
    break;
  }
  case 'escalation-listener': {
    const { main: listenerMain } = await import('./escalation/listener-command.js');
    await listenerMain();
    break;
  }
  case 'workflow': {
    const { main: workflowMain } = await import('./workflow/workflow-command.js');
    await workflowMain(process.argv.slice(3));
    break;
  }
  case 'observe': {
    const { runObserveCommand } = await import('./observe/observe-command.js');
    await runObserveCommand(process.argv.slice(3));
    break;
  }
  case 'setup-signal': {
    if (checkHelp({ help: process.argv.includes('--help') || process.argv.includes('-h') }, setupSignalSpec)) break;
    const reTrust = process.argv.includes('--re-trust');
    const { runSignalSetup } = await import('./signal/setup-signal.js');
    await runSignalSetup({ reTrust });
    break;
  }
  default:
    console.error(`Unknown command: ${subcommand}\n`);
    printSpecHelp(topLevelSpec);
    process.exit(1);
}
