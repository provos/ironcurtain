/**
 * CLI entry point for `ironcurtain workflow`.
 *
 * Subcommands:
 *   start   <definition> "task" [--model <model>] [--workspace <path>]
 *   resume  <baseDir> [--state <stateName>] [--model <model>]
 *   inspect <baseDir> [--all]
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { getIronCurtainHome } from '../config/paths.js';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import { FileCheckpointStore } from './checkpoint.js';
import { discoverWorkflows, resolveWorkflowPath, parseDefinitionFile } from './discovery.js';
import { personaExists } from '../persona/resolve.js';
import { countBySeverity, lintWorkflow, type Diagnostic, type LintContext } from './lint.js';
import { preflightLint, type LintMode } from './lint-integration.js';
import { MessageLog } from './message-log.js';
import { WorkflowOrchestrator, type WorkflowOrchestratorDeps, type WorkflowTabHandle } from './orchestrator.js';
import type { WorkflowId, WorkflowCheckpoint, WorkflowDefinition } from './types.js';
import { validateDefinition, WorkflowValidationError } from './validate.js';
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
  YELLOW,
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
    'ironcurtain workflow start <name-or-path> "task" [--model <model>] [--workspace <path>] [--no-lint] [--strict-lint]',
    'ironcurtain workflow resume <baseDir> [--state <stateName>] [--model <model>] [--no-lint] [--strict-lint]',
    'ironcurtain workflow inspect <baseDir> [--all]',
    'ironcurtain workflow lint <name-or-path> [--strict]',
  ],
  subcommands: [
    { name: 'list', description: 'List available workflow definitions' },
    { name: 'start', description: 'Start a workflow by name or definition file path' },
    { name: 'resume', description: 'Resume a checkpointed workflow' },
    { name: 'inspect', description: 'Show workflow status, artifacts, and recent messages' },
    { name: 'lint', description: 'Run semantic checks on a workflow definition' },
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
    { flag: 'no-lint', description: 'Skip pre-flight linting (start, resume)' },
    { flag: 'strict-lint', description: 'Treat lint warnings as errors (start, resume)' },
    { flag: 'strict', description: 'Treat lint warnings as errors (lint only)' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain workflow list',
    'ironcurtain workflow start design-and-code "Build a REST API"',
    'ironcurtain workflow start ./my-workflow.yaml "Build a REST API"',
    'ironcurtain workflow start design-and-code "task" --model anthropic:claude-haiku-4-5',
    'ironcurtain workflow resume /tmp/workflow-abc123',
    'ironcurtain workflow resume /tmp/workflow-abc123 --state review',
    'ironcurtain workflow resume /tmp/workflow-abc123 --model anthropic:claude-sonnet-4-6',
    'ironcurtain workflow inspect /tmp/workflow-abc123',
    'ironcurtain workflow inspect /tmp/workflow-abc123 --all',
  ],
};

// ---------------------------------------------------------------------------
// Lint helpers
// ---------------------------------------------------------------------------

/**
 * Builds a `LintContext` for CLI use. `personaExists` resolves against
 * the user's persona directory under `~/.ironcurtain/personas/`.
 */
function createCliLintContext(): LintContext {
  return { personaExists };
}

function formatDiagnostic(d: Diagnostic): string[] {
  const sevColor = d.severity === 'error' ? RED : CYAN;
  const location = d.stateId ? ` (state: ${d.stateId})` : '';
  const lines = [`${DIM}[${d.code}]${RESET} ${sevColor}${d.severity}${RESET} ${d.message}${location}`];
  if (d.hint) lines.push(`  ${DIM}hint: ${d.hint}${RESET}`);
  return lines;
}

function printDiagnostics(diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    for (const line of formatDiagnostic(d)) writeStderr(line);
  }
}

/**
 * Loads + validates a workflow definition from a path. Prints and
 * exits on structural validation errors (they take precedence over
 * lint diagnostics).
 */
function loadAndValidateDefinition(path: string): WorkflowDefinition {
  try {
    const raw = parseDefinitionFile(path);
    return validateDefinition(raw);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      writeStderr(`${RED}Workflow validation failed:${RESET}`);
      for (const issue of err.issues) writeStderr(`  ${RED}- ${issue}${RESET}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`${RED}Failed to load workflow: ${msg}${RESET}`);
    }
    process.exit(1);
  }
}

/**
 * Runs the shared `preflightLint()` helper and handles the CLI-specific
 * reporting: prints diagnostics to stderr, exits on failure. On success
 * with warnings-only output, prints a short continue notice.
 */
function runCliPreflightLint(def: WorkflowDefinition, mode: LintMode): void {
  const result = preflightLint(def, createCliLintContext(), mode);
  if (result.diagnostics.length === 0) return;

  printDiagnostics(result.diagnostics);
  const { errors, warnings } = countBySeverity(result.diagnostics);

  if (!result.ok) {
    writeStderr(`${RED}Lint failed: ${errors} error(s), ${warnings} warning(s).${RESET}`);
    writeStderr(`${DIM}Rerun with --no-lint to bypass (not recommended).${RESET}`);
    process.exit(1);
  }

  writeStderr(`${DIM}Lint: 0 errors, ${warnings} warning(s) — continuing.${RESET}`);
}

function resolveLintMode(noLint: unknown, strictLint: unknown): LintMode {
  if (noLint === true) return 'off';
  if (strictLint === true) return 'strict';
  return 'warn';
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function runStart(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      model: { type: 'string' },
      workspace: { type: 'string' },
      'no-lint': { type: 'boolean' },
      'strict-lint': { type: 'boolean' },
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

  // Pre-flight: validate + lint before any orchestrator side effects.
  const definition = loadAndValidateDefinition(resolvedDef);
  const lintMode = resolveLintMode(values['no-lint'], values['strict-lint']);
  runCliPreflightLint(definition, lintMode);

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
      'no-lint': { type: 'boolean' },
      'strict-lint': { type: 'boolean' },
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

  // Pre-flight lint before orchestrator.resume(). The checkpoint carries
  // a definitionPath we can re-validate + lint.
  const defPath = selected.checkpoint.definitionPath;
  if (defPath && existsSync(defPath)) {
    const definition = loadAndValidateDefinition(defPath);
    const lintMode = resolveLintMode(values['no-lint'], values['strict-lint']);
    runCliPreflightLint(definition, lintMode);
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

    // Load definition for state descriptions and definition path display
    const defPath = resolve(workflowDir, 'definition.json');
    let stateDescriptions: Map<string, string> | undefined;
    let loadedDef: WorkflowDefinition | undefined;
    if (existsSync(defPath)) {
      try {
        loadedDef = parseDefinitionFile(defPath) as WorkflowDefinition;
        stateDescriptions = new Map(
          Object.entries(loadedDef.states)
            .filter(([, s]) => s.description)
            .map(([id, s]) => [id, s.description]),
        );
      } catch {
        // Non-fatal — definition may be from older schema
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

    if (existsSync(defPath)) {
      writeStdout(`  Definition: ${defPath}`);
    }

    // Informational lint of the checkpointed definition. Read-only — never
    // affects exit code.
    if (loadedDef) {
      const diagnostics = lintWorkflow(loadedDef, createCliLintContext());
      if (diagnostics.length > 0) {
        const { errors, warnings } = countBySeverity(diagnostics);
        writeStdout(`  ${BOLD}Lint:${RESET} ${errors} error(s), ${warnings} warning(s)`);
        for (const d of diagnostics) {
          for (const line of formatDiagnostic(d)) writeStdout(`    ${line}`);
        }
      }
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
          case 'quota_exhausted':
            writeStdout(
              `${prefix} ${YELLOW}[quota/${entry.role}]${RESET} resets=${entry.resetAt ?? 'unknown'} — ${truncate(entry.rawMessage, 80)}`,
            );
            break;
          case 'state_transition': {
            const toDesc = stateDescriptions?.get(entry.event);
            const toLabel = toDesc ? `${entry.event} ${DIM}\u2014 "${toDesc}"${RESET}` : entry.event;
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
// Lint subcommand
// ---------------------------------------------------------------------------

function runLintCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      strict: { type: 'boolean' },
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
  if (!definitionRef) {
    writeStderr(`${RED}Usage: ironcurtain workflow lint <name-or-path> [--strict]${RESET}`);
    process.exit(1);
  }

  const resolved = resolveWorkflowPath(definitionRef);
  if (!resolved) {
    writeStderr(`${RED}Workflow not found: ${definitionRef}${RESET}`);
    writeStderr(`${DIM}Looked in bundled and user workflow directories.${RESET}`);
    process.exit(1);
  }

  // Structural validation first — a malformed definition cannot be linted.
  const definition = loadAndValidateDefinition(resolved);

  const diagnostics = lintWorkflow(definition, createCliLintContext());

  if (diagnostics.length === 0) {
    writeStderr(`${DIM}No lint diagnostics for ${resolved}.${RESET}`);
    process.exit(0);
  }

  printDiagnostics(diagnostics);
  const { errors, warnings } = countBySeverity(diagnostics);
  writeStderr(`${DIM}Summary: ${errors} error(s), ${warnings} warning(s).${RESET}`);

  if (errors > 0) process.exit(1);
  if (values.strict === true && warnings > 0) process.exit(2);
  process.exit(0);
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
    case 'lint':
      runLintCommand(subArgs);
      break;
    default:
      writeStderr(`${RED}Unknown workflow subcommand: ${subcommand}${RESET}`);
      process.stderr.write(formatHelp(workflowSpec) + '\n');
      process.exit(1);
  }
}
