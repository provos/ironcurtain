/// <reference types="node" />
/**
 * JSONL replay engine for the workflow mock WebSocket server.
 *
 * Parses real workflow message logs, translates each entry into the
 * WebSocket events the frontend expects, and replays them with
 * compressed timing. Human gates genuinely pause until resolved.
 *
 * No imports from src/ -- fully standalone.
 */

import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw entry from workflow-example-messages.jsonl. */
interface JournalEntry {
  readonly ts: string;
  readonly workflowId: string;
  readonly state: string;
  readonly type: 'agent_sent' | 'agent_received' | 'state_transition' | 'gate_raised' | 'gate_resolved';
  readonly role?: string;
  readonly message?: string;
  readonly verdict?: string;
  readonly confidence?: string;
  readonly from?: string;
  readonly event?: string;
  readonly acceptedEvents?: readonly string[];
  readonly prompt?: string | null;
}

/** Minimal workflow definition shape (matches design-and-code.json). */
interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly states: Record<string, StateDefinition>;
  readonly settings?: { readonly maxRounds?: number };
}

interface StateDefinition {
  readonly type: 'agent' | 'human_gate' | 'deterministic' | 'terminal';
  readonly persona?: string;
  readonly transitions?: readonly TransitionDef[];
  readonly acceptedEvents?: readonly string[];
  readonly present?: readonly string[];
  readonly outputs?: readonly string[];
}

interface TransitionDef {
  readonly to: string;
  readonly event?: string;
  readonly guard?: string;
}

/** A WebSocket event to emit. */
interface WsEvent {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/** State graph node for frontend rendering. */
interface StateNodeDto {
  readonly id: string;
  readonly type: string;
  readonly persona?: string;
  readonly label: string;
}

/** State graph edge for frontend rendering. */
interface TransitionEdgeDto {
  readonly from: string;
  readonly to: string;
  readonly guard?: string;
  readonly event?: string;
  readonly label: string;
}

interface StateGraphDto {
  readonly states: readonly StateNodeDto[];
  readonly transitions: readonly TransitionEdgeDto[];
}

/** Slim DTO for workflow list. */
export interface WorkflowSummaryDto {
  readonly workflowId: string;
  readonly name: string;
  readonly phase: string;
  readonly currentState: string;
  readonly startedAt: string;
}

/** Full DTO for workflow detail. */
export interface WorkflowDetailDto extends WorkflowSummaryDto {
  readonly description: string;
  readonly stateGraph: StateGraphDto;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly context: {
    readonly taskDescription: string;
    readonly round: number;
    readonly maxRounds: number;
    readonly totalTokens: number;
    readonly visitCounts: Record<string, number>;
  };
  readonly gate?: {
    readonly gateId: string;
    readonly workflowId: string;
    readonly stateName: string;
    readonly acceptedEvents: readonly string[];
    readonly presentedArtifacts: readonly string[];
    readonly summary: string;
  };
  readonly workspacePath: string;
}

interface TransitionRecord {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly durationMs: number;
}

/** Accumulated state built up during replay. */
export interface ReplayState {
  workflowId: string;
  name: string;
  currentState: string;
  phase: 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';
  startedAt: string;
  taskDescription: string;
  visitCounts: Record<string, number>;
  transitionHistory: TransitionRecord[];
  activeGateId: string | null;
  lastAgentMessage: string | null;
  lastStateEntryTime: string;
}

/** Everything needed to replay a workflow. */
export interface ReplayPlan {
  readonly entries: readonly JournalEntry[];
  readonly definition: WorkflowDefinition;
  readonly workflowId: string;
  readonly taskDescription: string;
}

/** Broadcast function signature matching mock server. */
export type BroadcastFn = (event: string, payload: unknown) => void;

/** Controller returned by createReplayController. */
export interface ReplayController {
  start(): void;
  resolveGate(event: string, prompt?: string): void;
  getStatus(): WorkflowSummaryDto;
  getDetail(): WorkflowDetailDto;
  isActive(): boolean;
  abort(): void;
}

// ---------------------------------------------------------------------------
// JSONL Parsing
// ---------------------------------------------------------------------------

/**
 * Load and parse a replay plan from JSONL + definition files.
 * Skips malformed lines. Sorts entries by timestamp.
 */
export function loadReplayPlan(jsonlPath: string, definitionPath: string): ReplayPlan {
  const raw = readFileSync(jsonlPath, 'utf-8');
  const definition = JSON.parse(readFileSync(definitionPath, 'utf-8')) as WorkflowDefinition;
  const entries = parseJournalLines(raw);

  if (entries.length === 0) {
    throw new Error('No valid entries found in JSONL file');
  }

  const workflowId = entries[0].workflowId;
  const firstSent = entries.find((e) => e.type === 'agent_sent');
  const taskDescription = extractTaskDescription(firstSent?.message ?? '');

  return { entries, definition, workflowId, taskDescription };
}

/** Parse raw JSONL text into validated, sorted entries. */
export function parseJournalLines(raw: string): JournalEntry[] {
  const entries: JournalEntry[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (isValidEntry(parsed)) {
        entries.push(parsed as unknown as JournalEntry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // ISO-8601 timestamps sort correctly as strings — no Date parsing needed
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return entries;
}

const VALID_ENTRY_TYPES = new Set(['agent_sent', 'agent_received', 'state_transition', 'gate_raised', 'gate_resolved']);

function isValidEntry(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.ts === 'string' &&
    typeof obj.workflowId === 'string' &&
    typeof obj.state === 'string' &&
    typeof obj.type === 'string' &&
    VALID_ENTRY_TYPES.has(obj.type as string)
  );
}

/** Extract task description from the first agent_sent message. */
function extractTaskDescription(message: string): string {
  // Look for a "## Task" section in the prompt
  const taskMatch = message.match(/## Task\n\n([\s\S]*?)(?:\n---|\n##|$)/);
  if (taskMatch) {
    return taskMatch[1].trim();
  }
  // Fallback: first 200 chars
  return message.slice(0, 200).trim() || 'Workflow replay';
}

// ---------------------------------------------------------------------------
// Event Translation
// ---------------------------------------------------------------------------

/**
 * Translate a journal entry into WebSocket events and update accumulated state.
 * Returns the events to emit (may be empty if entry is a duplicate).
 */
export function translateEntry(entry: JournalEntry, definition: WorkflowDefinition, state: ReplayState): WsEvent[] {
  const events: WsEvent[] = [];

  switch (entry.type) {
    case 'agent_sent': {
      state.currentState = entry.state;
      state.phase = 'running';
      incrementVisit(state, entry.state);
      events.push({
        event: 'workflow.agent_started',
        payload: {
          workflowId: state.workflowId,
          stateId: entry.state,
          persona: entry.role ?? 'global',
        },
      });
      break;
    }

    case 'agent_received': {
      state.lastAgentMessage = entry.message ?? null;
      events.push({
        event: 'workflow.agent_completed',
        payload: {
          workflowId: state.workflowId,
          stateId: entry.state,
          verdict: entry.verdict,
          confidence: entry.confidence,
        },
      });
      break;
    }

    case 'state_transition': {
      const targetState = entry.event ?? entry.state;
      const prevState = entry.from ?? state.currentState;
      const now = new Date(entry.ts).getTime();
      const prevTime = new Date(state.lastStateEntryTime).getTime();

      state.transitionHistory.push({
        from: prevState,
        to: targetState,
        event: entry.event ?? 'auto',
        timestamp: entry.ts,
        durationMs: now - prevTime,
      });

      state.currentState = targetState;
      state.lastStateEntryTime = entry.ts;

      events.push({
        event: 'workflow.state_entered',
        payload: {
          workflowId: state.workflowId,
          state: targetState,
          previousState: prevState,
        },
      });
      break;
    }

    case 'gate_raised': {
      const gateId = `${state.workflowId}-${entry.state}`;

      // Skip duplicate gate_raised for the same state (happens after resume)
      if (state.activeGateId === gateId) {
        return [];
      }

      state.phase = 'waiting_human';
      state.activeGateId = gateId;
      incrementVisit(state, entry.state);

      const stateDef = definition.states[entry.state];
      const presentedArtifacts = stateDef?.present ?? [];
      const summary = buildGateSummary(state.lastAgentMessage);

      events.push({
        event: 'workflow.gate_raised',
        payload: {
          workflowId: state.workflowId,
          gate: {
            gateId,
            workflowId: state.workflowId,
            stateName: entry.state,
            acceptedEvents: entry.acceptedEvents ?? [],
            presentedArtifacts,
            summary,
          },
        },
      });
      break;
    }

    case 'gate_resolved': {
      const gateId = `${state.workflowId}-${entry.state}`;
      state.activeGateId = null;
      state.phase = 'running';

      events.push({
        event: 'workflow.gate_dismissed',
        payload: {
          workflowId: state.workflowId,
          gateId,
        },
      });
      break;
    }
  }

  return events;
}

function incrementVisit(state: ReplayState, stateName: string): void {
  state.visitCounts[stateName] = (state.visitCounts[stateName] ?? 0) + 1;
}

function buildGateSummary(lastAgentMessage: string | null): string {
  if (!lastAgentMessage) return 'Waiting for review';
  // Take the first meaningful paragraph (skip code blocks)
  const lines = lastAgentMessage.split('\n');
  const textLines: string[] = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock && line.trim()) {
      textLines.push(line.trim());
      if (textLines.length >= 3) break;
    }
  }
  const summary = textLines.join(' ');
  return summary.length > 300 ? summary.slice(0, 297) + '...' : summary;
}

// ---------------------------------------------------------------------------
// State Graph Extraction
// ---------------------------------------------------------------------------

/** Extract a state graph from a workflow definition (mirrors src/web-ui/state-graph.ts). */
export function extractStateGraphFromDefinition(definition: WorkflowDefinition): StateGraphDto {
  const states: StateNodeDto[] = [];
  const transitions: TransitionEdgeDto[] = [];

  for (const [id, stateDef] of Object.entries(definition.states)) {
    states.push({
      id,
      type: stateDef.type,
      persona: stateDef.type === 'agent' ? stateDef.persona : undefined,
      label: formatLabel(id),
    });

    if (!stateDef.transitions) continue;

    for (const t of stateDef.transitions) {
      transitions.push({
        from: id,
        to: t.to,
        guard: t.guard,
        event: t.event,
        label: t.event ? formatEventLabel(t.event) : t.guard ? formatGuardLabel(t.guard) : '',
      });
    }
  }

  return { states, transitions };
}

function formatLabel(id: string): string {
  return id
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatEventLabel(event: string): string {
  return event
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function formatGuardLabel(guard: string): string {
  const stripped = guard.replace(/^is/, '').replace(/^has/, 'Has ');
  return stripped
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Replay Controller
// ---------------------------------------------------------------------------

function createReplayState(plan: ReplayPlan): ReplayState {
  return {
    workflowId: plan.workflowId,
    name: plan.definition.name,
    currentState: plan.definition.initial,
    phase: 'running',
    startedAt: plan.entries[0].ts,
    taskDescription: plan.taskDescription,
    visitCounts: {},
    transitionHistory: [],
    activeGateId: null,
    lastAgentMessage: null,
    lastStateEntryTime: plan.entries[0].ts,
  };
}

/**
 * Create a replay controller that drives entries through the broadcast function
 * with compressed timing and genuine gate pauses.
 */
export function createReplayController(
  plan: ReplayPlan,
  broadcast: BroadcastFn,
  speedup: number = 50,
): ReplayController {
  const state = createReplayState(plan);
  const stateGraph = extractStateGraphFromDefinition(plan.definition);

  let entryIndex = 0;
  let started = false;
  let aborted = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let gateResolve: (() => void) | null = null;

  function buildSummaryDto(): WorkflowSummaryDto {
    return {
      workflowId: state.workflowId,
      name: state.name,
      phase: state.phase,
      currentState: state.currentState,
      startedAt: state.startedAt,
    };
  }

  function buildDetailDto(): WorkflowDetailDto {
    const gateId = state.activeGateId;
    let gate: WorkflowDetailDto['gate'];
    if (gateId && state.phase === 'waiting_human') {
      const stateDef = plan.definition.states[state.currentState];
      gate = {
        gateId,
        workflowId: state.workflowId,
        stateName: state.currentState,
        acceptedEvents: stateDef?.acceptedEvents ?? [],
        presentedArtifacts: stateDef?.present ?? [],
        summary: buildGateSummary(state.lastAgentMessage),
      };
    }

    return {
      ...buildSummaryDto(),
      description: plan.definition.description,
      stateGraph,
      transitionHistory: state.transitionHistory,
      context: {
        taskDescription: state.taskDescription,
        round: computeRound(state),
        maxRounds: plan.definition.settings?.maxRounds ?? 3,
        totalTokens: estimateTokens(entryIndex, plan.entries.length),
        visitCounts: { ...state.visitCounts },
      },
      gate,
      workspacePath: '/tmp/ironcurtain-workflow/replay',
    };
  }

  async function replayLoop(): Promise<void> {
    while (entryIndex < plan.entries.length && !aborted) {
      const entry = plan.entries[entryIndex];

      // Compute delay from previous entry
      if (entryIndex > 0) {
        const prevTs = new Date(plan.entries[entryIndex - 1].ts).getTime();
        const curTs = new Date(entry.ts).getTime();
        const delayMs = Math.max(0, (curTs - prevTs) / speedup);
        // Cap individual delays at 5 seconds to keep things responsive
        const cappedDelay = Math.min(delayMs, 5000);
        if (cappedDelay > 0) {
          await waitFor(cappedDelay);
          if (aborted) return;
        }
      }

      // If this is a gate_resolved entry and we're waiting for user resolution, skip it.
      // The user's resolveGate() call already handled the dismissal.
      if (entry.type === 'gate_resolved' && state.activeGateId === null) {
        entryIndex++;
        continue;
      }

      const events = translateEntry(entry, plan.definition, state);
      for (const ev of events) {
        broadcast(ev.event, ev.payload);
      }

      entryIndex++;

      // Pause at gates
      if (entry.type === 'gate_raised' && state.phase === 'waiting_human') {
        await waitForGateResolution();
        if (aborted) return;
      }
    }

    // Replay complete
    if (!aborted) {
      let lastReceived: JournalEntry | undefined;
      for (let i = plan.entries.length - 1; i >= 0; i--) {
        if (plan.entries[i].type === 'agent_received') {
          lastReceived = plan.entries[i];
          break;
        }
      }
      if (lastReceived?.verdict === 'approved') {
        state.phase = 'completed';
        broadcast('workflow.completed', { workflowId: state.workflowId });
      } else {
        state.phase = 'failed';
        broadcast('workflow.failed', {
          workflowId: state.workflowId,
          error: 'Workflow ended without approval',
        });
      }
    }
  }

  function waitFor(ms: number): Promise<void> {
    return new Promise((resolve) => {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        resolve();
      }, ms);
    });
  }

  function waitForGateResolution(): Promise<void> {
    return new Promise((resolve) => {
      gateResolve = resolve;
    });
  }

  return {
    start(): void {
      if (started) return;
      started = true;

      broadcast('workflow.started', {
        workflowId: state.workflowId,
        name: state.name,
        taskDescription: state.taskDescription,
      });

      broadcast('workflow.state_entered', {
        workflowId: state.workflowId,
        state: plan.definition.initial,
      });

      // Run the replay loop asynchronously
      replayLoop().catch((err) => {
        console.error('Replay error:', err);
        state.phase = 'failed';
        broadcast('workflow.failed', {
          workflowId: state.workflowId,
          error: String(err),
        });
      });
    },

    resolveGate(event: string, prompt?: string): void {
      if (state.phase !== 'waiting_human' || !state.activeGateId) return;

      const gateId = state.activeGateId;
      state.activeGateId = null;
      state.phase = 'running';

      broadcast('workflow.gate_dismissed', {
        workflowId: state.workflowId,
        gateId,
      });

      if (event === 'ABORT') {
        aborted = true;
        state.phase = 'aborted';
        broadcast('workflow.failed', {
          workflowId: state.workflowId,
          error: 'Workflow aborted by user',
        });
      }

      // Resume the replay loop
      if (gateResolve) {
        const resolve = gateResolve;
        gateResolve = null;
        resolve();
      }
    },

    getStatus(): WorkflowSummaryDto {
      return buildSummaryDto();
    },

    getDetail(): WorkflowDetailDto {
      return buildDetailDto();
    },

    isActive(): boolean {
      return started && !aborted && state.phase !== 'completed' && state.phase !== 'failed';
    },

    abort(): void {
      aborted = true;
      state.phase = 'aborted';
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (gateResolve) {
        const resolve = gateResolve;
        gateResolve = null;
        resolve();
      }
      broadcast('workflow.failed', {
        workflowId: state.workflowId,
        error: 'Workflow aborted by user',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate round number from visit counts on implement/review states. */
function computeRound(state: ReplayState): number {
  const implVisits = state.visitCounts['implement'] ?? 0;
  return Math.max(1, implVisits);
}

/** Rough token estimate based on replay progress. */
function estimateTokens(currentIndex: number, totalEntries: number): number {
  const progress = totalEntries > 0 ? currentIndex / totalEntries : 0;
  return Math.floor(progress * 50000);
}
