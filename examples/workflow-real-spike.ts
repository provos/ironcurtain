/* eslint-disable */
/**
 * Real-agent spike script that exercises the workflow orchestrator
 * with actual Docker agent sessions (Claude Code in containers).
 *
 * Usage:
 *   npx tsx examples/workflow-real-spike.ts "Design and build a palindrome checker"
 *   npx tsx examples/workflow-real-spike.ts --resume /path/to/preserved-artifact-dir
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY in environment or ~/.ironcurtain/config.json
 *   - Docker running with ironcurtain-claude-code:latest image built
 *   - Global compiled policy in src/config/generated/
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config/index.js';
import { createSession } from '../src/session/index.js';
import type { Session, SessionOptions } from '../src/session/types.js';
import type {
  WorkflowId,
  WorkflowCheckpoint,
  WorkflowContext,
  HumanGateRequest,
  HumanGateEventType,
} from '../src/workflow/types.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
  type WorkflowLifecycleEvent,
} from '../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';

// ---------------------------------------------------------------------------
// Safe output primitives
// ---------------------------------------------------------------------------
// logger.setup() (called inside createSession) hijacks console.log and
// console.error, redirecting them to a log file. If session creation fails
// and logger.teardown() is not called, all subsequent console output is
// invisible. Use process.stdout/stderr.write directly for all spike output
// so errors are ALWAYS visible regardless of logger state.

const stdoutWrite = (msg: string) => process.stdout.write(`${msg}\n`);
const stderrWrite = (msg: string) => process.stderr.write(`${msg}\n`);

// ---------------------------------------------------------------------------
// ANSI colors (shared with workflow-spike.ts)
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const WHITE = '\x1b[37m';
const BG_YELLOW = '\x1b[43m';
const BLACK = '\x1b[30m';

// ---------------------------------------------------------------------------
// Session factory for Docker mode with Haiku model
// ---------------------------------------------------------------------------

const HAIKU_MODEL_ID = 'anthropic:claude-haiku-4-5';

function createRealSessionFactory(): (opts: SessionOptions) => Promise<Session> {
  // Load config once and override the model to Haiku
  const baseConfig = loadConfig();
  const haiku = {
    ...baseConfig,
    userConfig: {
      ...baseConfig.userConfig,
      agentModelId: HAIKU_MODEL_ID,
    },
  };

  return async (opts: SessionOptions): Promise<Session> => {
    const persona = opts.persona;

    // Strip persona (workflow role names are NOT IronCurtain personas --
    // they don't have persona directories or compiled policies).
    // systemPromptAugmentation is passed through from the orchestrator,
    // which reads it from the workflow definition's settings.systemPrompt.
    const effectiveOpts: SessionOptions = {
      ...opts,
      config: haiku,
      persona: undefined,
    };

    try {
      return await createSession(effectiveOpts);
    } catch (err) {
      // Surface the error via process.stderr.write (not console.error)
      // because logger.setup() may have hijacked console.error to write
      // to a log file instead of the terminal.
      const msg = err instanceof Error ? err.message : String(err);
      stderrWrite(`${RED}${BOLD}[session-factory] Failed to create session for "${persona ?? 'unknown'}":${RESET}`);
      stderrWrite(`${RED}  ${msg}${RESET}`);
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Gate handling (adapted from workflow-spike.ts)
// ---------------------------------------------------------------------------

function createGateHandler() {
  const gatePromises: Array<{ resolve: (gate: HumanGateRequest) => void }> = [];
  let pendingGate: HumanGateRequest | undefined;

  function raiseGate(gate: HumanGateRequest): void {
    pendingGate = gate;
    const waiter = gatePromises.shift();
    if (waiter) waiter.resolve(gate);
  }

  function dismissGate(_gateId: string): void {
    pendingGate = undefined;
  }

  async function waitForGate(): Promise<HumanGateRequest> {
    if (pendingGate) return pendingGate;
    return new Promise<HumanGateRequest>((resolve) => {
      gatePromises.push({ resolve });
    });
  }

  return { raiseGate, dismissGate, waitForGate };
}

// ---------------------------------------------------------------------------
// Interactive gate prompt
// ---------------------------------------------------------------------------

async function promptGateInteractive(
  gate: HumanGateRequest,
  rl: ReturnType<typeof createInterface>,
): Promise<{ type: HumanGateEventType; prompt?: string }> {
  const bar = '='.repeat(50);
  const presented = [...gate.presentedArtifacts.keys()].join(', ') || 'none';

  stdoutWrite('');
  stdoutWrite(`${BOLD}${YELLOW}${bar}${RESET}`);
  stdoutWrite(`${BOLD}${BG_YELLOW}${BLACK} HUMAN GATE: ${gate.stateName} ${RESET}`);

  // Surface errors prominently so they are not buried in dim text
  if (gate.summary.includes('(error:')) {
    const errorMatch = /\(error: (.+)\)$/.exec(gate.summary);
    if (errorMatch) {
      stderrWrite(`${RED}${BOLD}ERROR: ${errorMatch[1]}${RESET}`);
    }
  }
  stdoutWrite(`${DIM}${gate.summary}${RESET}`);
  stdoutWrite(`${DIM}Presented artifacts: ${presented}${RESET}`);
  stdoutWrite('');
  stdoutWrite(`${WHITE}Options:${RESET}`);

  const eventMap = new Map<string, HumanGateEventType>();
  for (const evt of gate.acceptedEvents) {
    switch (evt) {
      case 'APPROVE':
        stdoutWrite(`  ${GREEN}[a]${RESET} APPROVE`);
        eventMap.set('a', 'APPROVE');
        break;
      case 'FORCE_REVISION':
        stdoutWrite(`  ${YELLOW}[f]${RESET} FORCE_REVISION`);
        eventMap.set('f', 'FORCE_REVISION');
        break;
      case 'REPLAN':
        stdoutWrite(`  ${MAGENTA}[r]${RESET} REPLAN`);
        eventMap.set('r', 'REPLAN');
        break;
      case 'ABORT':
        stdoutWrite(`  ${RED}[x]${RESET} ABORT`);
        eventMap.set('x', 'ABORT');
        break;
    }
  }

  stdoutWrite('');
  const validKeys = [...eventMap.keys()].join('/');

  for (;;) {
    const answer = await rl.question(`${BOLD}Your choice (${validKeys}): ${RESET}`);
    const key = answer.trim().toLowerCase();
    const eventType = eventMap.get(key);
    if (!eventType) {
      stdoutWrite(`${RED}Invalid choice. Please enter one of: ${validKeys}${RESET}`);
      continue;
    }

    if (eventType === 'FORCE_REVISION' || eventType === 'REPLAN') {
      const feedback = await rl.question(`${CYAN}Feedback: ${RESET}`);
      return { type: eventType, prompt: feedback || undefined };
    }

    return { type: eventType };
  }
}

// ---------------------------------------------------------------------------
// Console tab handle
// ---------------------------------------------------------------------------

function createConsoleTab(label: string): WorkflowTabHandle {
  return {
    write(text: string): void {
      stdoutWrite(`${DIM}[${label}]${RESET} ${text}`);
    },
    setLabel(newLabel: string): void {
      stdoutWrite(`${DIM}[tab] label: ${newLabel}${RESET}`);
    },
    close(): void {
      stdoutWrite(`${DIM}[tab] ${label} closed${RESET}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle event printer
// ---------------------------------------------------------------------------

function printLifecycleEvent(event: WorkflowLifecycleEvent): void {
  switch (event.kind) {
    case 'state_entered':
      stdoutWrite(`${BLUE}>>>${RESET} ${BOLD}State:${RESET} ${CYAN}${event.state}${RESET}`);
      break;
    case 'gate_raised':
      stdoutWrite(`${YELLOW}>>>${RESET} ${BOLD}Gate raised:${RESET} ${event.gate.stateName}`);
      break;
    case 'gate_dismissed':
      stdoutWrite(`${GREEN}[gate dismissed]${RESET} ${event.gateId}`);
      break;
    case 'completed':
      stdoutWrite(`${GREEN}${BOLD}Workflow completed!${RESET}`);
      break;
    case 'failed': {
      const errorBar = '-'.repeat(50);
      stderrWrite(`${RED}${errorBar}${RESET}`);
      stderrWrite(`${RED}${BOLD}WORKFLOW ERROR:${RESET} ${event.error}`);
      stderrWrite(`${RED}${errorBar}${RESET}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

function printSummary(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId, artifactDir: string): void {
  const status = orchestrator.getStatus(workflowId);
  const bar = '='.repeat(50);
  stdoutWrite('');
  stdoutWrite(`${BOLD}${bar}${RESET}`);
  stdoutWrite(`${BOLD}WORKFLOW SUMMARY${RESET}`);
  stdoutWrite(bar);

  if (!status) {
    stdoutWrite(`${RED}No status available${RESET}`);
    return;
  }

  stdoutWrite(`Phase: ${BOLD}${status.phase}${RESET}`);
  if (status.phase === 'completed') {
    stdoutWrite(`Final artifacts: ${Object.keys(status.result.finalArtifacts).join(', ') || 'none'}`);
  } else if (status.phase === 'aborted') {
    stdoutWrite(`Reason: ${status.reason}`);
  } else if (status.phase === 'failed') {
    stdoutWrite(`Error: ${status.error}`);
  }

  stdoutWrite(`Artifact directory: ${artifactDir}`);
  if (existsSync(artifactDir)) {
    const entries = readdirSync(artifactDir);
    stdoutWrite(`Contents: ${entries.join(', ') || '(empty)'}`);
  }
  stdoutWrite(bar);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface StartArgs {
  readonly mode: 'start';
  readonly taskDescription: string;
}

interface ResumeArgs {
  readonly mode: 'resume';
  readonly baseDir: string;
  /** If set, synthesize a checkpoint at this state (for runs that predate checkpointing). */
  readonly overrideState?: string;
}

type CliArgs = StartArgs | ResumeArgs;

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);

  const resumeIndex = args.indexOf('--resume');
  if (resumeIndex !== -1) {
    const resumePath = args[resumeIndex + 1];
    if (!resumePath) {
      stderrWrite(`${RED}--resume requires a path argument${RESET}`);
      process.exit(1);
    }
    const resolved = resolve(resumePath);
    if (!existsSync(resolved)) {
      stderrWrite(`${RED}Resume path does not exist: ${resolved}${RESET}`);
      process.exit(1);
    }
    // Optional --state flag
    const stateIndex = args.indexOf('--state');
    const overrideState = stateIndex !== -1 ? args[stateIndex + 1] : undefined;

    return { mode: 'resume', baseDir: resolved, overrideState };
  }

  const taskDescription = args[0];
  if (!taskDescription) {
    stderrWrite(`${RED}Usage:${RESET}`);
    stderrWrite(`${RED}  npx tsx examples/workflow-real-spike.ts "Your task description"${RESET}`);
    stderrWrite(`${RED}  npx tsx examples/workflow-real-spike.ts --resume /path/to/dir [--state stateName]${RESET}`);
    process.exit(1);
  }

  return { mode: 'start', taskDescription };
}

// ---------------------------------------------------------------------------
// Resume helpers
// ---------------------------------------------------------------------------

function printResumeInfo(baseDir: string, workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
  const artifactDir = resolve(baseDir, workflowId, 'artifacts');
  const artifacts = existsSync(artifactDir) ? readdirSync(artifactDir).join(', ') : 'none';
  const errorInfo = checkpoint.context.lastError ?? 'none';

  stdoutWrite(`${BOLD}${CYAN}Resuming workflow from:${RESET} ${baseDir}`);
  stdoutWrite(`${DIM}Workflow ID: ${workflowId}${RESET}`);
  stdoutWrite(`${DIM}Last state: ${String(checkpoint.machineState)}${RESET}`);
  stdoutWrite(`${DIM}Error: ${errorInfo}${RESET}`);
  stdoutWrite(`${DIM}Checkpointed at: ${checkpoint.timestamp}${RESET}`);
  stdoutWrite(`${DIM}Artifacts present: ${artifacts}${RESET}`);
  stdoutWrite('');
}

function selectResumableWorkflow(checkpointStore: FileCheckpointStore): {
  workflowId: WorkflowId;
  checkpoint: WorkflowCheckpoint;
} {
  const resumable = checkpointStore.listAll();

  if (resumable.length === 0) {
    stderrWrite(`${RED}No resumable workflows found in this directory.${RESET}`);
    stderrWrite(`${DIM}Expected checkpoint files at: <baseDir>/<workflowId>/checkpoint.json${RESET}`);
    process.exit(1);
  }

  // If exactly one, use it. If multiple, pick the most recent.
  if (resumable.length === 1) {
    const workflowId = resumable[0];
    const checkpoint = checkpointStore.load(workflowId)!;
    return { workflowId, checkpoint };
  }

  // Multiple: load all checkpoints and pick the most recently saved
  const candidates = resumable
    .map((id) => ({ id, checkpoint: checkpointStore.load(id)! }))
    .sort((a, b) => new Date(b.checkpoint.timestamp).getTime() - new Date(a.checkpoint.timestamp).getTime());

  stdoutWrite(`${YELLOW}Found ${candidates.length} resumable workflows. Using most recent:${RESET}`);
  for (const { id, checkpoint } of candidates) {
    const marker = id === candidates[0].id ? `${GREEN}>>` : `${DIM}  `;
    stdoutWrite(`${marker} ${id} — state: ${String(checkpoint.machineState)}, saved: ${checkpoint.timestamp}${RESET}`);
  }
  stdoutWrite('');

  return { workflowId: candidates[0].id, checkpoint: candidates[0].checkpoint };
}

/**
 * Synthesize a checkpoint for a workflow that ran before checkpointing was wired in.
 * Discovers the workflow ID from the directory structure, reads the task description
 * from the task artifact, builds a minimal WorkflowContext from artifacts on disk,
 * and writes a checkpoint at the specified state.
 */
function synthesizeCheckpoint(
  baseDir: string,
  stateName: string,
  definitionPath: string,
  checkpointStore: FileCheckpointStore,
): { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint } {
  // Discover workflow ID — the single UUID subdirectory of baseDir
  const entries = readdirSync(baseDir).filter((e) => {
    const full = resolve(baseDir, e);
    return existsSync(resolve(full, 'artifacts'));
  });
  if (entries.length === 0) {
    stderrWrite(`${RED}No workflow directory found in ${baseDir}${RESET}`);
    process.exit(1);
  }
  const workflowId = entries[0] as WorkflowId;
  const artifactDir = resolve(baseDir, workflowId, 'artifacts');

  // Read task description from task artifact if it exists
  let taskDescription = 'Unknown task (synthesized checkpoint)';
  const taskDir = resolve(artifactDir, 'task');
  if (existsSync(taskDir)) {
    const taskFiles = readdirSync(taskDir).filter((f) => f.endsWith('.md'));
    if (taskFiles.length > 0) {
      taskDescription = readFileSync(resolve(taskDir, taskFiles[0]), 'utf-8').trim();
    }
  }

  // Build artifacts map from what's on disk
  const artifacts: Record<string, string> = {};
  for (const name of readdirSync(artifactDir)) {
    const full = resolve(artifactDir, name);
    if (existsSync(full)) {
      artifacts[name] = full;
    }
  }

  const context: WorkflowContext = {
    taskDescription,
    artifacts,
    round: 0,
    maxRounds: 3,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    parallelResults: {},
    worktreeBranches: [],
    totalTokens: 0,
    flaggedForReview: false,
    lastError: null,
    sessionsByRole: {},
    previousAgentOutput: null,
    previousStateName: null,
    visitCounts: {},
  };

  const checkpoint: WorkflowCheckpoint = {
    machineState: stateName,
    context,
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath,
  };

  // Write it so the orchestrator's resume() can find it
  checkpointStore.save(workflowId, checkpoint);

  stdoutWrite(`${YELLOW}Synthesized checkpoint at state "${stateName}" for workflow ${workflowId}${RESET}`);
  stdoutWrite(`${DIM}Artifacts found: ${Object.keys(artifacts).join(', ')}${RESET}`);
  stdoutWrite(`${DIM}Task: ${taskDescription.slice(0, 80)}...${RESET}`);
  stdoutWrite('');

  return { workflowId, checkpoint };
}

// ---------------------------------------------------------------------------
// Shared run loop (used by both start and resume)
// ---------------------------------------------------------------------------

async function runEventLoop(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  rl: ReturnType<typeof createInterface>,
): Promise<void> {
  for (;;) {
    const status = orchestrator.getStatus(workflowId);
    if (!status) break;
    if (status.phase === 'completed' || status.phase === 'failed' || status.phase === 'aborted') break;

    if (status.phase === 'waiting_human') {
      const gate = status.gate;
      const event = await promptGateInteractive(gate, rl);
      orchestrator.resolveGate(workflowId, event);
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }

    // Poll interval
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseCliArgs();

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const definitionPath = resolve(__dirname, 'workflow-real-demo.json');

  const baseDir = cliArgs.mode === 'resume' ? cliArgs.baseDir : mkdtempSync(resolve(tmpdir(), 'workflow-real-spike-'));

  const checkpointStore = new FileCheckpointStore(baseDir);

  let rl: ReturnType<typeof createInterface> | undefined;
  let orchestrator: WorkflowOrchestrator | undefined;

  async function cleanup(): Promise<void> {
    if (orchestrator) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    rl?.close();
    // Do NOT delete baseDir -- keep artifacts for inspection
    stdoutWrite(`${DIM}Artifacts preserved at: ${baseDir}${RESET}`);
  }

  const abortHandler = async () => {
    stdoutWrite(`\n${RED}${BOLD}Interrupted. Cleaning up...${RESET}`);
    await cleanup();
    process.exit(1);
  };
  process.on('SIGINT', abortHandler);

  try {
    rl = createInterface({ input: process.stdin, output: process.stdout });

    const gateHandler = createGateHandler();

    const deps: WorkflowOrchestratorDeps = {
      createSession: createRealSessionFactory(),
      createWorkflowTab: (label: string, _workflowId: WorkflowId) => createConsoleTab(label),
      raiseGate: gateHandler.raiseGate,
      dismissGate: gateHandler.dismissGate,
      baseDir,
      checkpointStore,
    };

    orchestrator = new WorkflowOrchestrator(deps);

    orchestrator.onEvent((event) => {
      printLifecycleEvent(event);
    });

    let workflowId: WorkflowId;

    if (cliArgs.mode === 'resume') {
      let selected: { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint };

      // If --state is provided and no checkpoint exists, synthesize one
      const hasCheckpoints = checkpointStore.listAll().length > 0;
      if (cliArgs.overrideState && !hasCheckpoints) {
        selected = synthesizeCheckpoint(baseDir, cliArgs.overrideState, definitionPath, checkpointStore);
      } else {
        selected = selectResumableWorkflow(checkpointStore);
      }
      workflowId = selected.workflowId;

      printResumeInfo(baseDir, workflowId, selected.checkpoint);

      stdoutWrite(`${BOLD}${MAGENTA}Resuming...${RESET}`);
      stdoutWrite('');
      await orchestrator.resume(workflowId);
    } else {
      stdoutWrite(`${BOLD}${MAGENTA}Workflow Real-Agent Spike (Docker Mode)${RESET}`);
      stdoutWrite(`${DIM}Task: ${cliArgs.taskDescription}${RESET}`);
      stdoutWrite(`${DIM}Model: ${HAIKU_MODEL_ID}${RESET}`);
      stdoutWrite(`${DIM}Base dir: ${baseDir}${RESET}`);
      stdoutWrite('');

      workflowId = await orchestrator.start(definitionPath, cliArgs.taskDescription);
    }

    const artifactDir = resolve(baseDir, workflowId, 'artifacts');

    await runEventLoop(orchestrator, workflowId, rl);

    printSummary(orchestrator, workflowId, artifactDir);
  } finally {
    process.removeListener('SIGINT', abortHandler);
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  stderrWrite(`${RED}Fatal error: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
