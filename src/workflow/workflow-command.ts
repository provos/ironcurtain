/**
 * CLI entry point for `ironcurtain workflow`.
 *
 * Subcommands:
 *   start   <definition.json> "task" [--model <model>] [--workspace <path>]
 *   resume  <baseDir> [--state <stateName>] [--model <model>]
 *   inspect <baseDir> [--all]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { getIronCurtainHome } from '../config/paths.js';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import { FileCheckpointStore } from './checkpoint.js';
import { discoverWorkflows, resolveWorkflowPath } from './discovery.js';
import { MessageLog } from './message-log.js';
import { WorkflowOrchestrator, type WorkflowOrchestratorDeps, type WorkflowTabHandle } from './orchestrator.js';
import type { WorkflowId, WorkflowCheckpoint, WorkflowDefinition } from './types.js';
import {
  createWorkflowSessionFactory,
  createConsoleTab,
  createGateHandler,
  printLifecycleEvent,
  printSummary,
  printResumeInfo,
  selectResumableWorkflow,
  synthesizeCheckpoint,
  runEventLoop,
  writeStdout,
  writeStderr,
  RED,
  BLUE,
  BOLD,
  DIM,
  MAGENTA,
  CYAN,
  RESET,
} from './cli-support.js';

// ---------------------------------------------------------------------------
// Help specs
// ---------------------------------------------------------------------------

const workflowSpec: CommandSpec = {
  name: 'ironcurtain workflow',
  description: 'Run multi-agent workflows',
  usage: [
    'ironcurtain workflow list',
    'ironcurtain workflow start <name-or-path> "task" [--model <model>] [--workspace <path>]',
    'ironcurtain workflow resume <baseDir> [--state <stateName>] [--model <model>]',
    'ironcurtain workflow inspect <baseDir> [--all]',
  ],
  subcommands: [
    { name: 'list', description: 'List available workflow definitions' },
    { name: 'start', description: 'Start a workflow by name or definition file path' },
    { name: 'resume', description: 'Resume a checkpointed workflow' },
    { name: 'inspect', description: 'Show workflow status, artifacts, and recent messages' },
  ],
  options: [
    { flag: 'model', description: 'Override the agent model (start, resume)', placeholder: '<model-id>' },
    {
      flag: 'workspace',
      description: 'Use an existing directory as workspace (start only)',
      placeholder: '<path>',
    },
    {
      flag: 'state',
      description: 'Synthesize checkpoint at this state (resume only)',
      placeholder: '<name>',
    },
    { flag: 'all', description: 'Show full message log (inspect only)' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain workflow list',
    'ironcurtain workflow start design-and-code "Build a REST API"',
    'ironcurtain workflow start ./my-workflow.json "Build a REST API"',
    'ironcurtain workflow start design-and-code "task" --model anthropic:claude-haiku-4-5',
    'ironcurtain workflow resume /tmp/workflow-abc123',
    'ironcurtain workflow resume /tmp/workflow-abc123 --state review',
    'ironcurtain workflow resume /tmp/workflow-abc123 --model anthropic:claude-sonnet-4-6',
    'ironcurtain workflow inspect /tmp/workflow-abc123',
    'ironcurtain workflow inspect /tmp/workflow-abc123 --all',
  ],
};

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function runStart(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      model: { type: 'string' },
      workspace: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  const definitionRef = positionals[0];
  const taskDescription = positionals[1];

  if (!definitionRef || !taskDescription) {
    writeStderr(`${RED}Usage: ironcurtain workflow start <name-or-path> "task" [--model <model>]${RESET}`);
    process.exit(1);
  }

  const resolvedDef = resolveWorkflowPath(definitionRef);
  if (!resolvedDef) {
    writeStderr(`${RED}Workflow not found: ${definitionRef}${RESET}`);
    writeStderr(`${DIM}Looked in bundled and user workflow directories.${RESET}`);
    writeStderr(`${DIM}Run 'ironcurtain workflow list' to see available workflows.${RESET}`);
    process.exit(1);
  }

  let workspacePath: string | undefined;
  if (values.workspace) {
    const resolvedWs = resolve(values.workspace as string);
    if (!existsSync(resolvedWs) || !statSync(resolvedWs).isDirectory()) {
      writeStderr(`${RED}Workspace path is not a directory: ${resolvedWs}${RESET}`);
      process.exit(1);
    }
    workspacePath = resolvedWs;
  }

  const modelOverride = values.model as string | undefined;
  const baseDir = resolve(getIronCurtainHome(), 'workflow-runs');
  mkdirSync(baseDir, { recursive: true });

  const checkpointStore = new FileCheckpointStore(baseDir);
  const gateHandler = createGateHandler();
  const sessionFactory = createWorkflowSessionFactory(modelOverride);

  const deps: WorkflowOrchestratorDeps = {
    createSession: sessionFactory,
    createWorkflowTab: (label: string): WorkflowTabHandle => createConsoleTab(label),
    raiseGate: gateHandler.raiseGate,
    dismissGate: gateHandler.dismissGate,
    baseDir,
    checkpointStore,
  };

  const orchestrator = new WorkflowOrchestrator(deps);
  orchestrator.onEvent(printLifecycleEvent);

  const controller = new AbortController();
  process.on('SIGINT', () => {
    writeStderr(`\n[workflow] Caught SIGINT, shutting down...`);
    controller.abort();
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    writeStdout(`${BOLD}${MAGENTA}Starting workflow${RESET}`);
    writeStdout(`${DIM}Task: ${taskDescription}${RESET}`);
    writeStdout(`${DIM}Base dir: ${baseDir}${RESET}`);
    writeStdout('');

    const workflowId = await orchestrator.start(resolvedDef, taskDescription, workspacePath);

    const wsPath = workspacePath ?? resolve(baseDir, workflowId, 'workspace');
    const artifactDir = resolve(wsPath, '.workflow');

    await runEventLoop(orchestrator, workflowId, rl, controller.signal);

    printSummary(orchestrator, workflowId, artifactDir);

    const exitCode = computeExitCode(orchestrator, workflowId, controller.signal);
    process.exit(exitCode);
  } finally {
    rl.close();
    await orchestrator.shutdownAll().catch(() => {});
    writeStdout(`${DIM}Artifacts preserved at: ${baseDir}${RESET}`);
  }
}

async function runResume(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      state: { type: 'string' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  const baseDirArg = positionals[0];
  if (!baseDirArg) {
    writeStderr(`${RED}Usage: ironcurtain workflow resume <baseDir> [--state <stateName>]${RESET}`);
    process.exit(1);
  }

  const baseDir = resolve(baseDirArg);
  if (!existsSync(baseDir)) {
    writeStderr(`${RED}Base directory does not exist: ${baseDir}${RESET}`);
    process.exit(1);
  }

  const modelOverride = values.model as string | undefined;
  const overrideState = values.state as string | undefined;

  const checkpointStore = new FileCheckpointStore(baseDir);
  const gateHandler = createGateHandler();
  const sessionFactory = createWorkflowSessionFactory(modelOverride);

  let selected: { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint };

  const hasCheckpoints = checkpointStore.listAll().length > 0;
  if (overrideState && !hasCheckpoints) {
    // Find a definition path from the workflow directory
    const definitionPath = findDefinitionPath(baseDir);
    selected = synthesizeCheckpoint(baseDir, overrideState, definitionPath, checkpointStore);
  } else {
    selected = selectResumableWorkflow(checkpointStore);
  }

  printResumeInfo(baseDir, selected.workflowId, selected.checkpoint);

  const deps: WorkflowOrchestratorDeps = {
    createSession: sessionFactory,
    createWorkflowTab: (label: string): WorkflowTabHandle => createConsoleTab(label),
    raiseGate: gateHandler.raiseGate,
    dismissGate: gateHandler.dismissGate,
    baseDir,
    checkpointStore,
  };

  const orchestrator = new WorkflowOrchestrator(deps);
  orchestrator.onEvent(printLifecycleEvent);

  const controller = new AbortController();
  process.on('SIGINT', () => {
    writeStderr(`\n[workflow] Caught SIGINT, shutting down...`);
    controller.abort();
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    writeStdout(`${BOLD}${MAGENTA}Resuming...${RESET}`);
    writeStdout('');

    await orchestrator.resume(selected.workflowId);

    const wsPath = resolve(baseDir, selected.workflowId, 'workspace');
    const artifactDir = resolve(wsPath, '.workflow');

    await runEventLoop(orchestrator, selected.workflowId, rl, controller.signal);

    printSummary(orchestrator, selected.workflowId, artifactDir);

    const exitCode = computeExitCode(orchestrator, selected.workflowId, controller.signal);
    process.exit(exitCode);
  } finally {
    rl.close();
    await orchestrator.shutdownAll().catch(() => {});
    writeStdout(`${DIM}Artifacts preserved at: ${baseDir}${RESET}`);
  }
}

function runInspect(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      all: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  const baseDirArg = positionals[0];
  if (!baseDirArg) {
    writeStderr(`${RED}Usage: ironcurtain workflow inspect <baseDir> [--all]${RESET}`);
    process.exit(1);
  }

  const baseDir = resolve(baseDirArg);
  if (!existsSync(baseDir)) {
    writeStderr(`${RED}Base directory does not exist: ${baseDir}${RESET}`);
    process.exit(1);
  }

  const showAll = values.all === true;
  const checkpointStore = new FileCheckpointStore(baseDir);
  const workflowIds = checkpointStore.listAll();

  // Find workflow directories (may exist even without checkpoints)
  const workflowDirs = findWorkflowDirs(baseDir);

  if (workflowDirs.length === 0 && workflowIds.length === 0) {
    writeStdout(`${DIM}No workflows found in ${baseDir}${RESET}`);
    return;
  }

  for (const dirName of workflowDirs) {
    const workflowId = dirName as WorkflowId;
    const workflowDir = resolve(baseDir, dirName);

    writeStdout(`${BOLD}${CYAN}Workflow: ${workflowId}${RESET}`);

    // Checkpoint info (stateDescriptions populated below after definition is loaded,
    // but checkpoint display runs first -- we load definition eagerly here)
    const checkpoint = checkpointStore.load(workflowId);

    // Eagerly load definition for state descriptions used below
    const earlyDefPath = resolve(workflowDir, 'definition.json');
    let stateDescriptions: Map<string, string> | undefined;
    if (existsSync(earlyDefPath)) {
      try {
        const def = JSON.parse(readFileSync(earlyDefPath, 'utf-8')) as WorkflowDefinition;
        stateDescriptions = new Map(
          Object.entries(def.states)
            .filter(([, s]) => s.description)
            .map(([id, s]) => [id, s.description]),
        );
      } catch {
        // Non-fatal
      }
    }

    if (checkpoint) {
      const stateStr = String(checkpoint.machineState);
      const desc = stateDescriptions?.get(stateStr);
      const stateLabel = desc
        ? `${BOLD}${stateStr}${RESET} ${DIM}\u2014 "${desc}"${RESET}`
        : `${BOLD}${stateStr}${RESET}`;
      writeStdout(`  State: ${stateLabel}`);
      writeStdout(`  Timestamp: ${checkpoint.timestamp}`);
      if (checkpoint.context.lastError) {
        writeStdout(`  Error: ${RED}${checkpoint.context.lastError}${RESET}`);
      }
      writeStdout(`  Task: ${checkpoint.context.taskDescription.slice(0, 100)}`);
    } else {
      writeStdout(`  ${DIM}No checkpoint${RESET}`);
    }

    // Artifact directories
    const wsPath = resolve(workflowDir, 'workspace', '.workflow');
    if (existsSync(wsPath)) {
      const artifactNames = readdirSync(wsPath).filter((e) => statSync(resolve(wsPath, e)).isDirectory());
      writeStdout(`  Artifacts: ${artifactNames.join(', ') || '(none)'}`);
    }

    // Definition path
    const defPath = resolve(workflowDir, 'definition.json');
    if (existsSync(defPath)) {
      writeStdout(`  Definition: ${defPath}`);
    }

    // Message log
    const logPath = resolve(workflowDir, 'messages.jsonl');
    const messageLog = new MessageLog(logPath);
    const entries = messageLog.readAll();

    if (entries.length > 0) {
      const displayEntries = showAll ? entries : entries.slice(-20);
      const label = showAll
        ? `All ${entries.length} messages`
        : `Last ${displayEntries.length} of ${entries.length} messages`;
      writeStdout(`  ${BOLD}${label}:${RESET}`);

      for (const entry of displayEntries) {
        const ts = entry.ts.slice(11, 19); // HH:MM:SS
        const prefix = `    ${DIM}${ts}${RESET}`;

        switch (entry.type) {
          case 'agent_sent':
            writeStdout(`${prefix} ${CYAN}[sent/${entry.role}]${RESET} ${truncate(entry.message, 120)}`);
            break;
          case 'agent_received':
            writeStdout(
              `${prefix} ${CYAN}[recv/${entry.role}]${RESET} verdict=${entry.verdict ?? '-'} ${truncate(entry.message, 80)}`,
            );
            break;
          case 'agent_retry':
            writeStdout(`${prefix} ${MAGENTA}[retry/${entry.role}]${RESET} ${entry.reason}`);
            break;
          case 'gate_raised':
            writeStdout(`${prefix} ${BOLD}[gate]${RESET} events: ${entry.acceptedEvents.join(', ')}`);
            break;
          case 'gate_resolved':
            writeStdout(`${prefix} ${BOLD}[gate resolved]${RESET} ${entry.event}`);
            break;
          case 'error':
            writeStdout(`${prefix} ${RED}[error]${RESET} ${entry.error}`);
            break;
          case 'state_transition': {
            const toDesc = stateDescriptions?.get(entry.state);
            const toLabel = toDesc ? `${entry.state} ${DIM}\u2014 "${toDesc}"${RESET}` : entry.state;
            writeStdout(`${prefix} ${BLUE}[transition]${RESET} ${entry.from} -> ${toLabel}`);
            break;
          }
        }
      }
    } else {
      writeStdout(`  ${DIM}No message log${RESET}`);
    }

    writeStdout('');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeExitCode(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId, signal: AbortSignal): number {
  if (signal.aborted) return 130;
  const status = orchestrator.getStatus(workflowId);
  if (status?.phase === 'completed') return 0;
  return 1;
}

function findWorkflowDirs(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Finds the definition.json path for a workflow in a base directory.
 * Looks inside the first workflow subdirectory.
 */
function findDefinitionPath(baseDir: string): string {
  const dirs = findWorkflowDirs(baseDir);
  for (const dir of dirs) {
    const defPath = resolve(baseDir, dir, 'definition.json');
    if (existsSync(defPath)) return defPath;
  }
  writeStderr(`${RED}No definition.json found in ${baseDir}${RESET}`);
  process.exit(1);
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + '...';
}

// ---------------------------------------------------------------------------
// List subcommand
// ---------------------------------------------------------------------------

function runList(): void {
  const workflows = discoverWorkflows();
  if (workflows.length === 0) {
    writeStdout(`${DIM}No workflow definitions found.${RESET}`);
    return;
  }

  const nameWidth = Math.max(4, ...workflows.map((w) => w.name.length));
  const sourceWidth = Math.max(6, ...workflows.map((w) => w.source.length));

  const header = `${'NAME'.padEnd(nameWidth)}  ${'SOURCE'.padEnd(sourceWidth)}  DESCRIPTION`;
  writeStdout(`${BOLD}${header}${RESET}`);

  for (const wf of workflows) {
    const line = `${wf.name.padEnd(nameWidth)}  ${wf.source.padEnd(sourceWidth)}  ${wf.description}`;
    writeStdout(line);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function main(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  // Top-level help
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stderr.write(formatHelp(workflowSpec) + '\n');
    return;
  }

  switch (subcommand) {
    case 'list':
      runList();
      break;
    case 'start':
      await runStart(subArgs);
      break;
    case 'resume':
      await runResume(subArgs);
      break;
    case 'inspect':
      runInspect(subArgs);
      break;
    default:
      writeStderr(`${RED}Unknown workflow subcommand: ${subcommand}${RESET}`);
      process.stderr.write(formatHelp(workflowSpec) + '\n');
      process.exit(1);
  }
}
