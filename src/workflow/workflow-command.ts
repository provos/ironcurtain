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
import { createInterface } from 'node:readline/promises';
import { getIronCurtainHome } from '../config/paths.js';
import { loadConfig } from '../config/index.js';
import { formatHelp, type CommandSpec } from '../cli-help.js';
import { FileCheckpointStore } from './checkpoint.js';
import { discoverWorkflows, resolveWorkflowPath, parseDefinitionFile } from './discovery.js';
import { discoverWorkflowRuns } from './workflow-discovery.js';
import { WorkflowManager } from './workflow-manager.js';
import { TypedEventBus } from '../event-bus/typed-event-bus.js';
import type { WebEventMap } from '../web-ui/web-event-bus.js';
import { countBySeverity, lintWorkflow } from './lint.js';
import { defaultLintContext, type LintMode } from './lint-integration.js';
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
  YELLOW,
  RESET,
} from './cli-support.js';
import { runRunState } from './run-state-command.js';
import { runDaemonGateCommand } from './daemon-gate-commands.js';
import {
  formatDiagnostic,
  printDiagnostics,
  loadAndValidateDefinition,
  parseArgsStrict,
  runCliPreflightLint,
} from './cli-shared.js';

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
    'ironcurtain workflow run-state <name-or-path> <state> --artifacts <dir> [options]',
    'ironcurtain workflow run <name-or-path> "task" [--workspace <path>] [--json] [--ensure-daemon]',
    'ironcurtain workflow status <workflowId> [--json]',
    'ironcurtain workflow await <workflowId> [--timeout <sec>] [--json]',
    'ironcurtain workflow gate <workflowId> --event <EVENT> [--prompt <text>] [--json]',
    'ironcurtain workflow show <workflowId> --artifact <name> [--json]',
  ],
  subcommands: [
    { name: 'list', description: 'List available workflow definitions' },
    { name: 'start', description: 'Start a workflow by name or definition file path (interactive)' },
    { name: 'resume', description: 'Resume a checkpointed workflow' },
    { name: 'inspect', description: 'Show workflow status, artifacts, and recent messages' },
    { name: 'lint', description: 'Run semantic checks on a workflow definition' },
    { name: 'run-state', description: 'Run a single agent state once against pre-staged artifacts' },
    { name: 'run', description: 'Start a gated workflow on the daemon (non-interactive, machine-readable)' },
    { name: 'status', description: 'Print a workflow status snapshot (poll)' },
    { name: 'await', description: 'Block until a workflow reaches a gate or terminal' },
    { name: 'gate', description: 'Resolve a human gate with an event (APPROVE/FORCE_REVISION/REPLAN/ABORT)' },
    { name: 'show', description: 'Print a presented artifact for a gated workflow' },
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
    { flag: 'capture-traces', description: 'Capture LLM API traces for this run (start only)' },
    { flag: 'json', description: 'Emit machine-readable JSON to stdout (run, status, await, gate, show)' },
    {
      flag: 'ensure-daemon',
      description: 'Auto-start a detached daemon if none is running (run, status, await, gate, show)',
    },
    {
      flag: 'event',
      description: 'Gate event: APPROVE | FORCE_REVISION | REPLAN | ABORT (gate only)',
      placeholder: '<EVENT>',
    },
    {
      flag: 'prompt',
      description: 'Feedback for FORCE_REVISION/REPLAN gate events (gate only)',
      placeholder: '<text>',
    },
    { flag: 'artifact', description: 'Artifact name to read (show only)', placeholder: '<name>' },
    { flag: 'timeout', description: 'Max seconds to block (await only)', placeholder: '<sec>' },
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
    'ironcurtain workflow run design-and-code "Build a REST API" --json --ensure-daemon',
    'ironcurtain workflow await wf-7a3 --json',
    'ironcurtain workflow show wf-7a3 --artifact spec --json',
    'ironcurtain workflow gate wf-7a3 --event FORCE_REVISION --prompt "tighten the intro" --json',
    'ironcurtain workflow gate wf-7a3 --event APPROVE --json',
  ],
};

// ---------------------------------------------------------------------------
// Lint helpers
// ---------------------------------------------------------------------------

function resolveLintMode(noLint: unknown, strictLint: unknown): LintMode {
  if (noLint === true) return 'off';
  if (strictLint === true) return 'strict';
  return 'warn';
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

async function runStart(args: string[]): Promise<void> {
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      model: { type: 'string' },
      workspace: { type: 'string' },
      'no-lint': { type: 'boolean' },
      'strict-lint': { type: 'boolean' },
      'capture-traces': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
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
  const lintMode = resolveLintMode(values['no-lint'], values['strict-lint']);
  runCliPreflightLint(resolvedDef, lintMode);

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
  const captureTracesFlag = values['capture-traces'] as boolean | undefined;
  const baseDir = resolve(getIronCurtainHome(), 'workflow-runs');
  mkdirSync(baseDir, { recursive: true });

  const checkpointStore = new FileCheckpointStore(baseDir);
  const gateHandler = createGateHandler();
  const sessionFactory = createWorkflowSessionFactory(modelOverride);
  const config = loadConfig();

  const deps: WorkflowOrchestratorDeps = {
    createSession: sessionFactory,
    createWorkflowTab: (label: string): WorkflowTabHandle => createConsoleTab(label),
    raiseGate: gateHandler.raiseGate,
    dismissGate: gateHandler.dismissGate,
    baseDir,
    checkpointStore,
    userConfig: config.userConfig,
    // Pass the RAW --capture-traces flag; the infrastructure factory
    // resolves it against userConfig (single resolution point).
    captureTracesOverride: captureTracesFlag,
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
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      state: { type: 'string' },
      model: { type: 'string' },
      'no-lint': { type: 'boolean' },
      'strict-lint': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
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

  const hasCheckpoints = discoverWorkflowRuns(baseDir).some((r) => r.hasCheckpoint);
  if (overrideState && !hasCheckpoints) {
    // Find a definition path from the workflow directory
    const definitionPath = findDefinitionPath(baseDir);
    selected = synthesizeCheckpoint(baseDir, overrideState, definitionPath, checkpointStore);
  } else {
    selected = selectResumableWorkflow(checkpointStore, baseDir);
  }

  // Pre-flight lint before orchestrator.resume(). The checkpoint carries
  // a definitionPath we can re-validate + lint.
  const defPath = selected.checkpoint.definitionPath;
  if (defPath && existsSync(defPath)) {
    const lintMode = resolveLintMode(values['no-lint'], values['strict-lint']);
    runCliPreflightLint(defPath, lintMode);
  }

  printResumeInfo(baseDir, selected.workflowId, selected.checkpoint);

  const config = loadConfig();
  const deps: WorkflowOrchestratorDeps = {
    createSession: sessionFactory,
    createWorkflowTab: (label: string): WorkflowTabHandle => createConsoleTab(label),
    raiseGate: gateHandler.raiseGate,
    dismissGate: gateHandler.dismissGate,
    baseDir,
    checkpointStore,
    userConfig: config.userConfig,
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
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      all: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
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
  const runs = discoverWorkflowRuns(baseDir);

  if (runs.length === 0) {
    writeStdout(`${DIM}No workflows found in ${baseDir}${RESET}`);
    return;
  }

  // WorkflowManager owns the canonical "load a past run" logic. We point it at
  // the user-supplied baseDir via `baseDirOverride` so the same loader works
  // for both the daemon's home directory and arbitrary `inspect` targets.
  // The CLI never starts workflows through this manager, so the event bus is
  // a no-op sink and the orchestrator created lazily inside the manager is
  // never used to spawn sessions.
  const manager = new WorkflowManager({
    eventBus: new TypedEventBus<WebEventMap>(),
    baseDirOverride: baseDir,
  });

  for (const run of runs) {
    const workflowId = run.workflowId;
    const workflowDir = run.directoryPath;

    const result = manager.loadPastRun(workflowId);

    let checkpoint: WorkflowCheckpoint | undefined;
    let loadedDef: WorkflowDefinition | undefined;

    if ('error' in result) {
      if (result.error === 'corrupted') {
        // Behavior change: a malformed checkpoint or definition used to either
        // throw (checkpoint) or be silently ignored (definition). We now print
        // a clear error line and continue with the next workflow.
        writeStdout(`${BOLD}${CYAN}Workflow: ${workflowId}${RESET}`);
        writeStdout(`  ${RED}Failed to load: ${result.message ?? 'unknown error'}${RESET}`);
        writeStdout('');
        continue;
      }
      // not_found: no checkpoint on disk. Preserve current behavior -- render
      // the directory with `checkpoint = undefined` and silently parse the
      // definition (without strict schema validation) for state descriptions.
      checkpoint = undefined;
      loadedDef = tryParseDefinitionForStateDescriptions(workflowDir);
    } else {
      checkpoint = result.checkpoint;
      loadedDef = result.definition;
    }

    writeStdout(`${BOLD}${CYAN}Workflow: ${workflowId}${RESET}`);

    const stateDescriptions = loadedDef
      ? new Map(
          Object.entries(loadedDef.states)
            .filter(([, s]) => s.description)
            .map(([id, s]) => [id, s.description]),
        )
      : undefined;

    const defPath = resolve(workflowDir, 'definition.json');

    if (checkpoint) {
      const stateStr = String(checkpoint.machineState);
      const desc = stateDescriptions?.get(stateStr);
      const stateLabel = desc
        ? `${BOLD}${stateStr}${RESET} ${DIM}\u2014 "${desc}"${RESET}`
        : `${BOLD}${stateStr}${RESET}`;
      writeStdout(`  State: ${stateLabel}`);
      if (checkpoint.finalStatus) {
        writeStdout(`  Final: ${BOLD}${checkpoint.finalStatus.phase}${RESET}`);
        const terminalState = checkpoint.transitionHistory.at(-1)?.to;
        if (terminalState && terminalState !== stateStr) {
          const terminalDesc = stateDescriptions?.get(terminalState);
          const terminalLabel = terminalDesc
            ? `${BOLD}${terminalState}${RESET} ${DIM}\u2014 "${terminalDesc}"${RESET}`
            : `${BOLD}${terminalState}${RESET}`;
          writeStdout(`  Terminal state: ${terminalLabel}`);
        }
      }
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
    // affects exit code. Intentionally does NOT pass `workflowFilePath`:
    // inspect operates on a past-run's `definition.json` whose sibling
    // tree is the run directory, not the source workflow package, so
    // WF010 (skill-reference) would emit false positives by looking for
    // SKILL.md in a directory that never carried skills sidecars.
    if (loadedDef) {
      const diagnostics = lintWorkflow(loadedDef, defaultLintContext);
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
          case 'transient_failure':
            writeStdout(
              `${prefix} ${YELLOW}[transient/${entry.role}]${RESET} kind=${entry.kind} — ${truncate(entry.rawMessage, 80)}`,
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

/**
 * Best-effort definition load used in the `not_found` branch of `loadPastRun`.
 * Mirrors the pre-refactor behavior: parse-only (no schema validation), errors
 * swallowed. The returned definition is used solely to populate state
 * descriptions in the rendered message log.
 */
function tryParseDefinitionForStateDescriptions(workflowDir: string): WorkflowDefinition | undefined {
  const defPath = resolve(workflowDir, 'definition.json');
  if (!existsSync(defPath)) return undefined;
  try {
    return parseDefinitionFile(defPath) as WorkflowDefinition;
  } catch {
    // Non-fatal -- definition may be from an older schema.
    return undefined;
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

/** Finds the first definition.json path under a base directory's workflow runs. */
function findDefinitionPath(baseDir: string): string {
  const run = discoverWorkflowRuns(baseDir).find((r) => r.hasDefinition);
  if (run) return resolve(run.directoryPath, 'definition.json');
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
  const { values, positionals } = parseArgsStrict({
    args,
    options: {
      strict: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
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

  const ctx = { ...defaultLintContext, workflowFilePath: resolved };
  const diagnostics = lintWorkflow(definition, ctx);

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
    case 'run-state':
      await runRunState(subArgs);
      break;
    case 'run':
    case 'status':
    case 'await':
    case 'gate':
    case 'show': {
      // Daemon-backed, non-interactive commands. They own all stdout/stderr and
      // return an exit code derived from the workflow phase (or a CLI error).
      if (subArgs.includes('--help') || subArgs.includes('-h')) {
        process.stderr.write(formatHelp(workflowSpec) + '\n');
        return;
      }
      const code = await runDaemonGateCommand(subcommand, subArgs);
      process.exit(code);
      break;
    }
    default:
      writeStderr(`${RED}Unknown workflow subcommand: ${subcommand}${RESET}`);
      process.stderr.write(formatHelp(workflowSpec) + '\n');
      process.exit(1);
  }
}
