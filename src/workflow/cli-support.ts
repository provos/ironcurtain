/**
 * Shared CLI helpers for the workflow system.
 *
 * Extracted from examples/workflow-real-spike.ts so both the CLI
 * command and the spike script can reuse the same logic.
 *
 * Output convention: all functions use process.stdout.write() and
 * process.stderr.write() — never console.log/warn/error. After
 * logger.setup() hijacks console.*, those writes are redirected
 * to the session log file and never reach the terminal.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config/index.js';
import { createSession } from '../session/index.js';
import type { Session, SessionOptions } from '../session/types.js';
import {
  GLOBAL_PERSONA,
  type WorkflowId,
  type WorkflowCheckpoint,
  type WorkflowContext,
  type HumanGateRequest,
  type HumanGateEventType,
} from './types.js';
import type { WorkflowOrchestrator, WorkflowLifecycleEvent, WorkflowTabHandle } from './orchestrator.js';
import { FileCheckpointStore, isCheckpointResumable } from './checkpoint.js';
import { findResumableCheckpoints } from './checkpoint-selection.js';

// Re-export for backward compatibility — the canonical location is now
// `./checkpoint.js`, but external callers (e.g. `workflow-manager.ts`,
// the test suite) historically imported it from here.
export { isCheckpointResumable };

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const MAGENTA = '\x1b[35m';
export const CYAN = '\x1b[36m';
export const RED = '\x1b[31m';
export const WHITE = '\x1b[37m';
export const BG_YELLOW = '\x1b[43m';
export const BLACK = '\x1b[30m';

// ---------------------------------------------------------------------------
// Safe output primitives
// ---------------------------------------------------------------------------

export function writeStdout(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

export function writeStderr(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * Creates a session factory that loads config once and routes model
 * selection through:
 *
 *   `--model` CLI flag  >  per-call `agentModelOverride`  >  user config
 *
 * Resolution happens per call so per-state `SessionOptions.agentModelOverride`
 * values are honored on each invocation.
 *
 * Persona `"global"` (GLOBAL_PERSONA) is stripped to undefined (uses global
 * policy); any other value passes through for per-persona policy/memory.
 */
export function createWorkflowSessionFactory(modelOverride?: string): (opts: SessionOptions) => Promise<Session> {
  const baseConfig = loadConfig();

  return async (opts: SessionOptions): Promise<Session> => {
    const persona = opts.persona;
    const personaStripped = persona === GLOBAL_PERSONA ? undefined : persona;

    // Only rebuild the config when a model override is actually in play.
    // The common case (no per-state and no --model) passes the base config
    // through unchanged.
    const override = modelOverride ?? opts.agentModelOverride;
    const effectiveOpts: SessionOptions = override
      ? {
          ...opts,
          config: {
            ...baseConfig,
            agentModelId: override,
            userConfig: { ...baseConfig.userConfig, agentModelId: override },
          },
          agentModelOverride: override,
          persona: personaStripped,
        }
      : { ...opts, config: baseConfig, persona: personaStripped };

    try {
      // Narrow the options union for the typed overloads: the orchestrator
      // supplies `agentConversationId` for every Docker invocation (see
      // `executeAgentState` in orchestrator.ts), so the Docker branch is
      // safe. Builtin mode ignores the field whether set or not.
      if (effectiveOpts.mode?.kind === 'docker') {
        if (!effectiveOpts.agentConversationId) {
          throw new Error('workflow orchestrator must supply agentConversationId for docker sessions');
        }
        return await createSession({
          ...effectiveOpts,
          mode: effectiveOpts.mode,
          agentConversationId: effectiveOpts.agentConversationId,
        });
      }
      return await createSession({ ...effectiveOpts, mode: effectiveOpts.mode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`${RED}${BOLD}[session-factory] Failed to create session for "${persona ?? 'unknown'}":${RESET}`);
      writeStderr(`${RED}  ${msg}${RESET}`);
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Console tab handle
// ---------------------------------------------------------------------------

/** Creates a WorkflowTabHandle that writes to stdout. */
export function createConsoleTab(label: string): WorkflowTabHandle {
  return {
    write(text: string): void {
      writeStdout(`${DIM}[${label}]${RESET} ${text}`);
    },
    setLabel(newLabel: string): void {
      writeStdout(`${DIM}[tab] label: ${newLabel}${RESET}`);
    },
    close(): void {
      writeStdout(`${DIM}[tab] ${label} closed${RESET}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Gate handling
// ---------------------------------------------------------------------------

export interface GateHandler {
  raiseGate: (gate: HumanGateRequest) => void;
  dismissGate: (workflowId: string, gateId: string) => void;
  waitForGate: () => Promise<HumanGateRequest>;
}

/** Creates a gate promise queue for interactive gate handling. */
export function createGateHandler(): GateHandler {
  const gatePromises: Array<{ resolve: (gate: HumanGateRequest) => void }> = [];
  let pendingGate: HumanGateRequest | undefined;

  function raiseGate(gate: HumanGateRequest): void {
    pendingGate = gate;
    const waiter = gatePromises.shift();
    if (waiter) waiter.resolve(gate);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function dismissGate(_workflowId: string, _gateId: string): void {
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

/** Prompts the user to resolve a human gate via readline. */
export async function promptGateInteractive(
  gate: HumanGateRequest,
  rl: ReturnType<typeof createInterface>,
): Promise<{ type: HumanGateEventType; prompt?: string }> {
  const bar = '='.repeat(50);
  const presented = [...gate.presentedArtifacts.keys()].join(', ') || 'none';

  writeStdout('');
  writeStdout(`${BOLD}${YELLOW}${bar}${RESET}`);
  writeStdout(`${BOLD}${BG_YELLOW}${BLACK} HUMAN GATE: ${gate.stateName} ${RESET}`);

  if (gate.summary.includes('(error:')) {
    const errorMatch = /\(error: (.+)\)$/.exec(gate.summary);
    if (errorMatch) {
      writeStderr(`${RED}${BOLD}ERROR: ${errorMatch[1]}${RESET}`);
    }
  }
  writeStdout(`${DIM}${gate.summary}${RESET}`);
  writeStdout(`${DIM}Presented artifacts: ${presented}${RESET}`);
  writeStdout('');
  writeStdout(`${WHITE}Options:${RESET}`);

  const eventMap = new Map<string, HumanGateEventType>();
  for (const evt of gate.acceptedEvents) {
    switch (evt) {
      case 'APPROVE':
        writeStdout(`  ${GREEN}[a]${RESET} APPROVE`);
        eventMap.set('a', 'APPROVE');
        break;
      case 'FORCE_REVISION':
        writeStdout(`  ${YELLOW}[f]${RESET} FORCE_REVISION`);
        eventMap.set('f', 'FORCE_REVISION');
        break;
      case 'REPLAN':
        writeStdout(`  ${MAGENTA}[r]${RESET} REPLAN`);
        eventMap.set('r', 'REPLAN');
        break;
      case 'ABORT':
        writeStdout(`  ${RED}[x]${RESET} ABORT`);
        eventMap.set('x', 'ABORT');
        break;
    }
  }

  writeStdout('');
  const validKeys = [...eventMap.keys()].join('/');

  for (;;) {
    const answer = await rl.question(`${BOLD}Your choice (${validKeys}): ${RESET}`);
    const key = answer.trim().toLowerCase();
    const eventType = eventMap.get(key);
    if (!eventType) {
      writeStdout(`${RED}Invalid choice. Please enter one of: ${validKeys}${RESET}`);
      continue;
    }

    if (eventType === 'FORCE_REVISION' || eventType === 'REPLAN') {
      const feedback = await promptRequiredFeedback(rl, eventType);
      return { type: eventType, prompt: feedback };
    }

    return { type: eventType };
  }
}

/**
 * FORCE_REVISION and REPLAN route the workflow back to an earlier state
 * and the next agent's prompt references the feedback directly, so empty
 * feedback would produce an incoherent re-entry prompt. When stdin is
 * closed (piped invocation, EOF) we abort instead of spinning.
 */
async function promptRequiredFeedback(
  rl: ReturnType<typeof createInterface>,
  eventType: 'FORCE_REVISION' | 'REPLAN',
): Promise<string> {
  for (;;) {
    if (process.stdin.readableEnded) {
      throw new Error(`Feedback is required for ${eventType} but stdin was closed before a response was provided.`);
    }
    const answer = await rl.question(`${CYAN}Feedback: ${RESET}`);
    const trimmed = answer.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    writeStdout(`${RED}Feedback is required for ${eventType}. Please enter a non-empty response.${RESET}`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle event printer
// ---------------------------------------------------------------------------

/** Prints a workflow lifecycle event to stdout/stderr. */
export function printLifecycleEvent(event: WorkflowLifecycleEvent): void {
  switch (event.kind) {
    case 'state_entered':
      writeStdout(`${BLUE}>>>${RESET} ${BOLD}State:${RESET} ${CYAN}${event.state}${RESET}`);
      break;
    case 'gate_raised':
      writeStdout(`${YELLOW}>>>${RESET} ${BOLD}Gate raised:${RESET} ${event.gate.stateName}`);
      break;
    case 'gate_dismissed':
      writeStdout(`${GREEN}[gate dismissed]${RESET} ${event.gateId}`);
      break;
    case 'completed':
      writeStdout(`${GREEN}${BOLD}Workflow completed!${RESET}`);
      break;
    case 'failed': {
      const errorBar = '-'.repeat(50);
      writeStderr(`${RED}${errorBar}${RESET}`);
      writeStderr(`${RED}${BOLD}WORKFLOW ERROR:${RESET} ${event.error}`);
      writeStderr(`${RED}${errorBar}${RESET}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

/** Prints end-of-workflow summary with phase, artifacts, and artifact dir. */
export function printSummary(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId, artifactDir: string): void {
  const status = orchestrator.getStatus(workflowId);
  const bar = '='.repeat(50);
  writeStdout('');
  writeStdout(`${BOLD}${bar}${RESET}`);
  writeStdout(`${BOLD}WORKFLOW SUMMARY${RESET}`);
  writeStdout(bar);

  if (!status) {
    writeStdout(`${RED}No status available${RESET}`);
    return;
  }

  writeStdout(`Phase: ${BOLD}${status.phase}${RESET}`);
  if (status.phase === 'completed') {
    writeStdout(`Final artifacts: ${Object.keys(status.result.finalArtifacts).join(', ') || 'none'}`);
  } else if (status.phase === 'aborted') {
    writeStdout(`Reason: ${status.reason}`);
  } else if (status.phase === 'failed') {
    writeStdout(`Error: ${status.error}`);
  }

  writeStdout(`Artifact directory: ${artifactDir}`);
  if (existsSync(artifactDir)) {
    const entries = readdirSync(artifactDir);
    writeStdout(`Contents: ${entries.join(', ') || '(empty)'}`);
  }
  writeStdout(bar);
}

// ---------------------------------------------------------------------------
// Resume helpers
// ---------------------------------------------------------------------------

/** Prints checkpoint details before resume. */
export function printResumeInfo(baseDir: string, workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
  const workspacePath = checkpoint.workspacePath ?? resolve(baseDir, workflowId, 'workspace');
  const artifactDir = resolve(workspacePath, '.workflow');
  const artifacts = existsSync(artifactDir) ? readdirSync(artifactDir).join(', ') : 'none';
  const errorInfo = checkpoint.context.lastError ?? 'none';

  writeStdout(`${BOLD}${CYAN}Resuming workflow from:${RESET} ${baseDir}`);
  writeStdout(`${DIM}Workflow ID: ${workflowId}${RESET}`);
  writeStdout(`${DIM}Last state: ${String(checkpoint.machineState)}${RESET}`);
  writeStdout(`${DIM}Error: ${errorInfo}${RESET}`);
  writeStdout(`${DIM}Checkpointed at: ${checkpoint.timestamp}${RESET}`);
  writeStdout(`${DIM}Artifacts present: ${artifacts}${RESET}`);
  writeStdout('');
}

/**
 * Picks the most-recent resumable workflow from a checkpoint store.
 *
 * Delegates enumeration + filtering + sorting to
 * {@link findResumableCheckpoints} (single source of truth shared with the
 * daemon). Adds the CLI-specific banner that lists every candidate when
 * more than one is present.
 *
 * Exits with code 1 if no resumable workflows are found.
 */
export function selectResumableWorkflow(
  checkpointStore: FileCheckpointStore,
  baseDir: string,
): { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint } {
  const candidates = findResumableCheckpoints(baseDir, checkpointStore);

  if (candidates.length === 0) {
    writeStderr(`${RED}No resumable workflows found in this directory.${RESET}`);
    writeStderr(`${DIM}Expected checkpoint files at: <baseDir>/<workflowId>/checkpoint.json${RESET}`);
    process.exit(1);
  }

  if (candidates.length === 1) {
    return { workflowId: candidates[0].workflowId, checkpoint: candidates[0].checkpoint };
  }

  writeStdout(`${YELLOW}Found ${candidates.length} resumable workflows. Using most recent:${RESET}`);
  for (const { workflowId, checkpoint } of candidates) {
    const marker = workflowId === candidates[0].workflowId ? `${GREEN}>>` : `${DIM}  `;
    writeStdout(
      `${marker} ${workflowId} — state: ${String(checkpoint.machineState)}, saved: ${checkpoint.timestamp}${RESET}`,
    );
  }
  writeStdout('');

  return { workflowId: candidates[0].workflowId, checkpoint: candidates[0].checkpoint };
}

/**
 * Synthesizes a checkpoint for a workflow that ran before checkpointing.
 * Discovers the workflow ID from the directory structure, reads the task
 * from the task artifact, builds minimal context, and writes a checkpoint.
 */
export function synthesizeCheckpoint(
  baseDir: string,
  stateName: string,
  definitionPath: string,
  checkpointStore: FileCheckpointStore,
): { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint } {
  const entries = readdirSync(baseDir).filter((e) => {
    const full = resolve(baseDir, e);
    return existsSync(resolve(full, 'workspace', '.workflow')) || existsSync(resolve(full, 'artifacts'));
  });
  if (entries.length === 0) {
    writeStderr(`${RED}No workflow directory found in ${baseDir}${RESET}`);
    process.exit(1);
  }
  const workflowId = entries[0] as WorkflowId;

  const workspacePath = resolve(baseDir, workflowId, 'workspace');
  const artifactDir = existsSync(resolve(workspacePath, '.workflow'))
    ? resolve(workspacePath, '.workflow')
    : resolve(baseDir, workflowId, 'artifacts');

  let taskDescription = 'Unknown task (synthesized checkpoint)';
  const taskDir = resolve(artifactDir, 'task');
  if (existsSync(taskDir)) {
    const taskFiles = readdirSync(taskDir).filter((f) => f.endsWith('.md'));
    if (taskFiles.length > 0) {
      taskDescription = readFileSync(resolve(taskDir, taskFiles[0]), 'utf-8').trim();
    }
  }

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
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
  };

  const checkpoint: WorkflowCheckpoint = {
    machineState: stateName,
    context,
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath,
    workspacePath,
  };

  checkpointStore.save(workflowId, checkpoint);

  writeStdout(`${YELLOW}Synthesized checkpoint at state "${stateName}" for workflow ${workflowId}${RESET}`);
  writeStdout(`${DIM}Artifacts found: ${Object.keys(artifacts).join(', ')}${RESET}`);
  writeStdout(`${DIM}Task: ${taskDescription.slice(0, 80)}...${RESET}`);
  writeStdout('');

  return { workflowId, checkpoint };
}

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

/**
 * Polls orchestrator status and dispatches gate prompts.
 * Exits when the workflow reaches a terminal phase or the signal is aborted.
 */
export async function runEventLoop(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  rl: ReturnType<typeof createInterface>,
  signal?: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) break;

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

    await new Promise((r) => setTimeout(r, 200));
  }
}
