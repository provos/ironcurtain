/**
 * Workflow-related JSON-RPC method dispatch.
 *
 * Handles all `workflows.*` methods: list, get, start, resume,
 * abort, resolveGate, inspect, fileTree, fileContent, artifacts.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import {
  type WorkflowSummaryDto,
  type WorkflowDetailDto,
  type PastRunDto,
  type MessageLogResponseDto,
  type FileTreeEntryDto,
  type FileTreeResponseDto,
  type FileContentResponseDto,
  type ArtifactContentDto,
  type ArtifactFileDto,
  type LatestVerdictDto,
  type LiveWorkflowPhase,
  type PastRunPhase,
  RpcError,
  MethodNotFoundError,
  toHumanGateRequestDto,
} from '../web-ui-types.js';
import type { PastRunLoadSuccess, WorkflowManager } from '../workflow-manager.js';
import type { WorkflowId, WorkflowStatus, WorkflowCheckpoint, WorkflowDefinition } from '../../workflow/types.js';
import type { WorkflowDetail } from '../../workflow/orchestrator.js';
import { MessageLog, type MessageLogEntry, type StateTransitionEntry } from '../../workflow/message-log.js';
import { discoverWorkflowRuns, summaryForId, type WorkflowRunSummary } from '../../workflow/workflow-discovery.js';
import { extractStateGraph } from '../state-graph.js';
import type { StateGraphDto } from '../web-ui-types.js';
import { isWithinDirectory } from '../../types/argument-roles.js';
import { parseDefinitionFile } from '../../workflow/discovery.js';
import { validateDefinition, WorkflowValidationError } from '../../workflow/validate.js';
import { preflightLint } from '../../workflow/lint-integration.js';
import { countBySeverity, type LintContext } from '../../workflow/lint.js';
import { personaExists } from '../../persona/resolve.js';
import * as logger from '../../logger.js';

// ---------------------------------------------------------------------------
// State graph cache (definition never changes during execution)
// ---------------------------------------------------------------------------

const stateGraphCache = new Map<WorkflowId, StateGraphDto>();

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const workflowIdSchema = z.object({ workflowId: z.string().min(1) });
const workflowStartSchema = z.object({
  definitionPath: z.string().min(1),
  taskDescription: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
});
// FORCE_REVISION and REPLAN require non-empty feedback: the orchestrator
// injects this into the next agent's prompt, and an empty string produces
// an incoherent re-entry prompt. Orchestrator validates too; this is the
// first line of defense for external (JSON-RPC) callers.
const workflowIdField = { workflowId: z.string().min(1) };
const workflowResolveGateSchema = z.discriminatedUnion('event', [
  z.object({ ...workflowIdField, event: z.literal('APPROVE'), prompt: z.string().optional() }),
  z.object({ ...workflowIdField, event: z.literal('ABORT'), prompt: z.string().optional() }),
  z.object({
    ...workflowIdField,
    event: z.literal('FORCE_REVISION'),
    prompt: z.string().trim().min(1, 'Feedback is required for FORCE_REVISION events'),
  }),
  z.object({
    ...workflowIdField,
    event: z.literal('REPLAN'),
    prompt: z.string().trim().min(1, 'Feedback is required for REPLAN events'),
  }),
]);
const workflowFileTreeSchema = z.object({
  workflowId: z.string().min(1),
  path: z.string().optional(),
});
const workflowFileContentSchema = z.object({
  workflowId: z.string().min(1),
  path: z.string().min(1),
});
const workflowArtifactSchema = z.object({
  workflowId: z.string().min(1),
  artifactName: z.string().min(1),
});
// Cursor-pagination params for `workflows.messageLog`. The 2000-entry hard
// cap is a DoS guardrail: each entry is read+parsed in process, and a single
// pathologically-large request shouldn't be able to stall the dispatch loop.
// The default of 200 (applied in the handler when `limit` is omitted) matches
// the page size the frontend's "Load older" UX is designed around.
const workflowMessageLogSchema = z.object({
  workflowId: z.string().min(1),
  before: z.string().optional(),
  limit: z.number().int().positive().max(2000).optional(),
});

const DEFAULT_MESSAGE_LOG_LIMIT = 200;

// ---------------------------------------------------------------------------
// Extended dispatch context
// ---------------------------------------------------------------------------

export interface WorkflowDispatchContext extends DispatchContext {
  workflowManager?: WorkflowManager;
}

// ---------------------------------------------------------------------------
// Lint pre-flight (daemon)
// ---------------------------------------------------------------------------

/** Real `LintContext` backed by the filesystem. Shared with the CLI path. */
const daemonLintContext: LintContext = { personaExists };

/**
 * Parses + validates the definition file, then runs the shared
 * `preflightLint()` helper in `warn` mode. Errors abort via
 * `LINT_FAILED`; warnings are logged and ignored.
 *
 * The `warn` mode is the right default for the daemon: warnings are
 * advisory and should not block a workflow start from the web UI,
 * whereas true errors indicate a workflow that will not run correctly.
 */
function preflightLintForDaemon(definitionPath: string): void {
  let definition;
  try {
    const raw = parseDefinitionFile(definitionPath);
    definition = validateDefinition(raw);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      throw new RpcError('INVALID_PARAMS', `Workflow validation failed: ${err.issues.join('; ')}`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new RpcError('INVALID_PARAMS', `Failed to load workflow definition: ${msg}`);
  }

  const result = preflightLint(definition, daemonLintContext, 'warn');
  const { errors, warnings } = countBySeverity(result.diagnostics);

  if (!result.ok) {
    throw new RpcError('LINT_FAILED', `Workflow lint failed: ${errors} error(s), ${warnings} warning(s).`, {
      diagnostics: result.diagnostics,
    });
  }

  if (warnings > 0) {
    logger.warn(
      `[workflow-dispatch] Lint warnings for ${definitionPath}: ${result.diagnostics
        .map((d) => `[${d.code}] ${d.message}`)
        .join(' | ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Workflow dispatch
// ---------------------------------------------------------------------------

export async function workflowDispatch(
  ctx: WorkflowDispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  // workflows.listDefinitions does not need a running workflow manager
  if (method === 'workflows.listDefinitions') {
    const { discoverWorkflows } = await import('../../workflow/discovery.js');
    return discoverWorkflows();
  }

  if (!ctx.workflowManager) {
    throw new RpcError('INTERNAL_ERROR', 'Workflow system not available');
  }
  const manager = ctx.workflowManager;
  const controller = manager.getOrchestrator();

  switch (method) {
    case 'workflows.list': {
      const activeIds = controller.listActive();
      const summaries: WorkflowSummaryDto[] = [];
      for (const id of activeIds) {
        const status = controller.getStatus(id);
        if (status) {
          const detail = controller.getDetail(id);
          summaries.push(buildSummaryDto(id, status, detail));
        }
      }
      return summaries;
    }

    case 'workflows.get': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (status) {
        const detail = controller.getDetail(id);
        return buildDetailDto(id, status, detail);
      }
      // Live miss -- fall back to the on-disk past-run loader (D6).
      const result = manager.loadPastRun(id);
      if ('error' in result) {
        if (result.error === 'not_found') {
          throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
        }
        // 'corrupted' -- preserve the loader's diagnostic message for the UI.
        throw new RpcError('WORKFLOW_CORRUPTED', result.message ?? `Workflow ${workflowId} checkpoint is corrupted`);
      }
      // Summary is required for checkpoint-less rows (mtime becomes the
      // timestamp). Fall back to a synthesized summary when the directory was
      // removed between the load and this lookup — `buildDetailFromPastRun`
      // only consults `summary.mtime` in the checkpoint-less branch, so a
      // present checkpoint makes the fallback irrelevant.
      const summary = summaryForId(manager.getBaseDir(), id) ?? synthesizeSummaryFallback(id, manager.getBaseDir());
      return buildDetailFromPastRun(id, result, summary);
    }

    case 'workflows.start': {
      const { definitionPath, taskDescription, workspacePath } = validateParams(workflowStartSchema, params);
      // Pre-flight lint: runs in `warn` mode (errors abort, warnings log and pass).
      // Controller.start() re-parses and re-validates internally; this extra
      // parse is the cheapest way to reach a validated WorkflowDefinition.
      preflightLintForDaemon(definitionPath);
      const workflowId = await controller.start(definitionPath, taskDescription, workspacePath);
      return { workflowId };
    }

    case 'workflows.listResumable': {
      // Despite the legacy name (kept per design decision D4), this method
      // returns *all* past runs on disk -- terminal (completed/failed/aborted),
      // gate-paused (`waiting_human`), and `interrupted` (no live orchestrator
      // and no `finalStatus`). Not just runs the user could literally resume.
      return buildResumableList(manager);
    }

    case 'workflows.import': {
      const schema = z.object({
        baseDir: z.string().min(1),
        workflowId: z.string().min(1).optional(),
      });
      const { baseDir, workflowId } = validateParams(schema, params);

      if (!existsSync(baseDir)) {
        throw new RpcError('INVALID_PARAMS', `Directory does not exist: ${baseDir}`);
      }
      if (!statSync(baseDir).isDirectory()) {
        throw new RpcError('INVALID_PARAMS', `Path is not a directory: ${baseDir}`);
      }
      const importedId = manager.importExternalCheckpoint(baseDir, workflowId);
      return { workflowId: importedId };
    }

    case 'workflows.resume': {
      const schema = z.object({
        workflowId: z.string().min(1).optional(),
        baseDir: z.string().min(1).optional(),
      });
      const { workflowId, baseDir } = validateParams(schema, params);

      let resolvedId: WorkflowId;
      if (baseDir) {
        if (!existsSync(baseDir)) {
          throw new RpcError('INVALID_PARAMS', `Directory does not exist: ${baseDir}`);
        }
        if (!statSync(baseDir).isDirectory()) {
          throw new RpcError('INVALID_PARAMS', `Path is not a directory: ${baseDir}`);
        }
        resolvedId = manager.importExternalCheckpoint(baseDir, workflowId);
      } else if (workflowId) {
        resolvedId = workflowId as WorkflowId;
      } else {
        throw new RpcError('INVALID_PARAMS', 'Either workflowId or baseDir must be provided');
      }

      await controller.resume(resolvedId);
      return { accepted: true, workflowId: resolvedId };
    }

    case 'workflows.abort': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (!status) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      await controller.abort(id);
      return;
    }

    case 'workflows.resolveGate': {
      const { workflowId, event, prompt } = validateParams(workflowResolveGateSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (!status) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      if (status.phase !== 'waiting_human') {
        throw new RpcError('WORKFLOW_NOT_AT_GATE', `Workflow ${workflowId} is not waiting at a gate`);
      }
      controller.resolveGate(id, { type: event, prompt });
      return;
    }

    case 'workflows.inspect': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (!status) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      return { status };
    }

    case 'workflows.fileTree': {
      const { workflowId, path: relPath } = validateParams(workflowFileTreeSchema, params);
      const workspacePath = getWorkspacePath(controller, workflowId as WorkflowId);
      const targetDir = resolveAndContain(workspacePath, relPath ?? '');
      return listDirectory(targetDir);
    }

    case 'workflows.fileContent': {
      const { workflowId, path: relPath } = validateParams(workflowFileContentSchema, params);
      const workspacePath = getWorkspacePath(controller, workflowId as WorkflowId);
      const targetFile = resolveAndContain(workspacePath, relPath);
      return readWorkspaceFile(targetFile);
    }

    case 'workflows.artifacts': {
      const { workflowId, artifactName } = validateParams(workflowArtifactSchema, params);
      const workspacePath = getWorkspacePath(controller, workflowId as WorkflowId);
      return readArtifact(workspacePath, artifactName);
    }

    case 'workflows.messageLog': {
      const { workflowId, before, limit } = validateParams(workflowMessageLogSchema, params);
      return readMessageLogPage(manager, workflowId as WorkflowId, {
        before,
        limit: limit ?? DEFAULT_MESSAGE_LOG_LIMIT,
      });
    }

    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// DTO builders
// ---------------------------------------------------------------------------

function getCurrentState(status: WorkflowStatus): string {
  switch (status.phase) {
    case 'running':
      return status.currentState;
    case 'waiting_human':
      return status.gate.stateName;
    case 'completed':
      return 'completed';
    case 'failed':
      return status.lastState;
    case 'aborted':
      return 'aborted';
  }
}

function buildSummaryDto(id: WorkflowId, status: WorkflowStatus, detail?: WorkflowDetail): WorkflowSummaryDto {
  // `name` and `startedAt` are not available from the orchestrator's runtime
  // state alone. We use the workflow id as a name fallback and the current
  // wall-clock time as a stand-in start time -- the frontend's event handler
  // overwrites both with authoritative values from `workflow.started` events.
  return {
    workflowId: id,
    name: detail?.definition.name ?? id,
    phase: status.phase,
    currentState: getCurrentState(status),
    startedAt: new Date().toISOString(),
    taskDescription: detail?.context.taskDescription ?? '',
    round: detail?.context.round ?? 0,
    maxRounds: detail?.context.maxRounds ?? 0,
    totalTokens: detail?.context.totalTokens ?? 0,
    latestVerdict: extractLatestVerdictFromTransitions(detail?.transitionHistory),
    error: status.phase === 'failed' ? status.error : undefined,
  };
}

function buildDetailDto(id: WorkflowId, status: WorkflowStatus, detail?: WorkflowDetail): WorkflowDetailDto {
  const base = buildSummaryDto(id, status, detail);
  const stateGraph = detail ? getCachedStateGraph(id, detail.definition) : { states: [], transitions: [] };
  const transitionHistory = mapTransitionRecords(detail?.transitionHistory);

  return {
    ...base,
    description: detail?.context.taskDescription ?? '',
    stateGraph,
    transitionHistory,
    context: detail
      ? {
          taskDescription: detail.context.taskDescription,
          round: detail.context.round,
          maxRounds: detail.context.maxRounds,
          totalTokens: detail.context.totalTokens,
          visitCounts: detail.context.visitCounts,
        }
      : { taskDescription: '', round: 0, maxRounds: 0, totalTokens: 0, visitCounts: {} },
    gate: status.phase === 'waiting_human' ? toHumanGateRequestDto(status.gate) : undefined,
    workspacePath: detail?.workspacePath ?? '',
  };
}

// ---------------------------------------------------------------------------
// Past-run helpers (shared by B3 `workflows.get` and B4 `workflows.listResumable`)
// ---------------------------------------------------------------------------

/**
 * Synthesizes a phase value for a checkpoint loaded from disk.
 *
 * Requires a defined `WorkflowCheckpoint`. For checkpoint-less past-run rows
 * (i.e. directories where `checkpoint.json` is absent — e.g. runs completed
 * before B3b persisted `finalStatus`), callers must use
 * `synthesizePhaseFromMessageLog` instead.
 *
 * Resolution order:
 * - If `isLive` is true, returns `'running'`.
 * - Post-B3b checkpoints carry a canonical `finalStatus.phase`. When present
 *   and valid (matches a `PastRunPhase` value), return it directly —
 *   this short-circuits the legacy state-name heuristic.
 * - Legacy pre-B3b checkpoints fall through to the state-name heuristic:
 *   - Terminal state in the definition: infer `'aborted'` from the
 *     conventional name pattern (`'aborted'` or contains `'abort'`);
 *     otherwise `'completed'`. Matches `handleWorkflowComplete` in the
 *     orchestrator.
 *   - Human-gate state: `'waiting_human'`.
 *   - Otherwise: `'interrupted'` (mid-run state with no live instance —
 *     typical of a daemon crash).
 */
export function computePastRunPhase(
  checkpoint: WorkflowCheckpoint,
  definition: WorkflowDefinition,
  isLive: boolean,
): LiveWorkflowPhase | PastRunPhase {
  if (isLive) return 'running';
  // B3b short-circuit: post-B3b checkpoints carry `finalStatus.phase` as the
  // canonical phase. Only fall through to the state-name heuristic for legacy
  // pre-B3b checkpoints that never persisted `finalStatus`.
  const finalPhase = checkpoint.finalStatus?.phase;
  if (
    finalPhase === 'completed' ||
    finalPhase === 'aborted' ||
    finalPhase === 'failed' ||
    finalPhase === 'waiting_human'
  ) {
    return finalPhase;
  }
  const stateName = extractLastState(checkpoint.machineState);
  // Defensive lookup: the checkpoint's machineState may name a state no longer
  // present in the definition (renamed, removed). Treat that as "interrupted"
  // rather than throwing — the user can still see the past-run record.
  const stateDef: WorkflowDefinition['states'][string] | undefined = Object.prototype.hasOwnProperty.call(
    definition.states,
    stateName,
  )
    ? definition.states[stateName]
    : undefined;
  if (stateDef && stateDef.type === 'terminal') {
    return stateName === 'aborted' || stateName.toLowerCase().includes('abort') ? 'aborted' : 'completed';
  }
  if (stateDef && stateDef.type === 'human_gate') {
    return 'waiting_human';
  }
  return 'interrupted';
}

/**
 * Synthesize a `PastRunPhase` from a message-log history when no checkpoint is
 * available (e.g., a completed run from before B3b persisted `finalStatus`).
 *
 * Entries are expected in chronological (oldest-first) order — this matches
 * `MessageLog.readAll()`, the log file's native on-disk order. Internally the
 * helper uses `ts` comparison (not array index) to locate "events after the
 * last transition," so minor out-of-order writes do not mislead it.
 *
 * Logic (per plan D6):
 * - Find the last `state_transition` entry. Its destination state is the
 *   most-recently entered state. On-disk, the orchestrator stores this in
 *   `event` (the "to" value); `from` carries the previous state
 *   (see `orchestrator.ts` line 1257-1262).
 * - If `definition.states[to].type === 'terminal'`: return `'aborted'` when
 *   the name matches `/abort/i`, else `'completed'` (mirrors
 *   `computePastRunPhase`'s name heuristic).
 * - If `definition.states[to].type === 'human_gate'`: return `'waiting_human'`.
 * - If there are no `state_transition` entries at all: return `'interrupted'`.
 * - Otherwise (last state is non-terminal, non-gate), look at entries AFTER
 *   the last state_transition:
 *   - `quota_exhausted` → `'aborted'` (quota is a deterministic abort).
 *   - `error` → `'failed'` (agent erred without a terminal transition).
 *   - none of the above → `'interrupted'` (daemon crashed mid-run).
 */
export function synthesizePhaseFromMessageLog(
  entries: readonly MessageLogEntry[],
  definition: WorkflowDefinition,
): PastRunPhase {
  // Single pass: find the last state_transition by timestamp.
  let lastTransition: StateTransitionEntry | undefined;
  for (const entry of entries) {
    if (entry.type !== 'state_transition') continue;
    if (lastTransition === undefined || entry.ts > lastTransition.ts) {
      lastTransition = entry;
    }
  }
  if (lastTransition === undefined) {
    // Either entries is empty or no state_transition records at all.
    return 'interrupted';
  }
  // Destination state of the last transition. The orchestrator stores this
  // in `event` (see message-log.ts / orchestrator.ts handleTransition).
  const toState = lastTransition.event;
  const stateDef: WorkflowDefinition['states'][string] | undefined = Object.prototype.hasOwnProperty.call(
    definition.states,
    toState,
  )
    ? definition.states[toState]
    : undefined;
  if (stateDef && stateDef.type === 'terminal') {
    return toState === 'aborted' || toState.toLowerCase().includes('abort') ? 'aborted' : 'completed';
  }
  if (stateDef && stateDef.type === 'human_gate') {
    return 'waiting_human';
  }
  // Mid-run state: inspect events after the last transition (by ts comparison).
  const transitionTs = lastTransition.ts;
  let sawQuotaExhausted = false;
  let sawError = false;
  for (const entry of entries) {
    if (entry.ts <= transitionTs) continue;
    if (entry.type === 'quota_exhausted') sawQuotaExhausted = true;
    else if (entry.type === 'error') sawError = true;
  }
  if (sawQuotaExhausted) return 'aborted';
  if (sawError) return 'failed';
  return 'interrupted';
}

/**
 * Pulls the most recent agent verdict out of a transition history.
 *
 * The transition records carry `agentMessage` (a truncated copy of the agent's
 * output) but not a structured verdict field, so today we cannot reconstruct
 * `verdict`/`confidence` from a checkpoint alone. The frontend populates
 * `latestVerdict` from live `workflow.agent_completed` events instead — for
 * past runs the field stays `undefined` until that data is captured at
 * checkpoint time.
 *
 * Returning `undefined` is the explicit "not available" signal; callers must
 * not fabricate a verdict. The parameter is consumed so the signature is
 * stable for the future enrichment without an unused-var lint suppression.
 */
export function extractLatestVerdictFromTransitions(
  transitions: readonly { agentMessage?: string }[] | undefined,
): LatestVerdictDto | undefined {
  if (!transitions || transitions.length === 0) return undefined;
  // No structured verdict data on TransitionRecord; deferred until checkpoints
  // capture verdict/confidence as first-class fields.
  return undefined;
}

/**
 * Extracts the failure error message for a past-run checkpoint, when present.
 *
 * Past-run checkpoints don't persist `finalStatus`, but they do persist the
 * workflow context, which carries `lastError` for failed/aborted runs. This
 * is the closest thing to an authoritative error message from disk.
 */
function extractPastRunError(
  checkpoint: WorkflowCheckpoint,
  phase: LiveWorkflowPhase | PastRunPhase,
): string | undefined {
  if (phase === 'completed') return undefined;
  return checkpoint.context.lastError ?? undefined;
}

/** Returns the cached state graph for a workflow, computing it on first access. */
function getCachedStateGraph(id: WorkflowId, definition: WorkflowDefinition): StateGraphDto {
  let cached = stateGraphCache.get(id);
  if (!cached) {
    cached = extractStateGraph(definition);
    stateGraphCache.set(id, cached);
  }
  return cached;
}

/** Maps domain `TransitionRecord[]` to DTO shape (renames `duration_ms` → `durationMs`). */
function mapTransitionRecords(
  history:
    | readonly {
        from: string;
        to: string;
        event: string;
        timestamp: string;
        duration_ms: number;
        agentMessage?: string;
      }[]
    | undefined,
) {
  return (history ?? []).map((t) => ({
    from: t.from,
    to: t.to,
    event: t.event,
    timestamp: t.timestamp,
    durationMs: t.duration_ms,
    agentMessage: t.agentMessage,
  }));
}

/**
 * Derives the "last-entered state" from a message-log entry sequence when no
 * checkpoint is available. Scans for the latest `state_transition` by `ts`
 * and returns its `event` field (the destination state); falls back to
 * `definition.initial` when no transitions exist.
 *
 * Shared between the checkpoint-less branches of {@link buildPastRunDto} and
 * {@link buildDetailFromPastRun}.
 */
function deriveLastStateFromEntries(entries: readonly MessageLogEntry[], definition: WorkflowDefinition): string {
  let lastTransition: StateTransitionEntry | undefined;
  for (const entry of entries) {
    if (entry.type !== 'state_transition') continue;
    if (lastTransition === undefined || entry.ts > lastTransition.ts) {
      lastTransition = entry;
    }
  }
  return lastTransition ? lastTransition.event : definition.initial;
}

/**
 * Synthesizes a `WorkflowRunSummary` when the canonical `summaryForId` probe
 * fails (the run directory was removed between `loadPastRun` returning success
 * and the summary lookup — a narrow deletion race). Only the `mtime` field is
 * consulted downstream; the probe booleans are set to `false` so a caller
 * that strays beyond `mtime` sees conservative defaults.
 */
function synthesizeSummaryFallback(workflowId: WorkflowId, baseDir: string): WorkflowRunSummary {
  return {
    workflowId,
    directoryPath: resolve(baseDir, workflowId),
    hasCheckpoint: false,
    hasDefinition: false,
    hasMessageLog: false,
    mtime: new Date(),
  };
}

/**
 * Assembles a `WorkflowDetailDto` from on-disk past-run domain objects.
 *
 * Mirrors the live-path `buildDetailDto` so the frontend sees a single shape
 * regardless of which path served the request. Handles two branches:
 *
 * - **Checkpoint present:** phase is synthesized via
 *   {@link computePastRunPhase}; error and `latestVerdict` are extracted from
 *   the checkpoint's context where available. `startedAt` is set to the
 *   checkpoint's last-saved timestamp because the checkpoint does not persist
 *   the original workflow-start time.
 * - **Checkpoint absent:** per D7, the row is reconstructed from the message
 *   log plus the on-disk directory summary. `startedAt`/`timestamp` come from
 *   the directory `mtime` (D8); `transitionHistory` is empty (the live
 *   `state_transition` log entries are surfaced separately via
 *   `workflows.messageLog` and must not be double-rendered); numeric context
 *   fields fall back to zero; optional fields (`latestVerdict`, `error`,
 *   `workspacePath`, `gate`) default to `undefined`.
 */
export function buildDetailFromPastRun(
  id: WorkflowId,
  load: PastRunLoadSuccess,
  summary: WorkflowRunSummary,
): WorkflowDetailDto {
  const { checkpoint, definition, isLive } = load;
  const stateGraph = getCachedStateGraph(id, definition);

  if (checkpoint) {
    const phase = computePastRunPhase(checkpoint, definition, isLive);
    const transitionHistory = mapTransitionRecords(checkpoint.transitionHistory);
    const error = extractPastRunError(checkpoint, phase);
    const latestVerdict = extractLatestVerdictFromTransitions(checkpoint.transitionHistory);
    const currentState = extractLastState(checkpoint.machineState);

    return {
      workflowId: id,
      name: definition.name,
      phase,
      currentState,
      // Checkpoint pre-dates startedAt persistence; use the last-checkpoint time as a best-effort stand-in.
      startedAt: checkpoint.timestamp,
      taskDescription: checkpoint.context.taskDescription,
      round: checkpoint.context.round,
      maxRounds: checkpoint.context.maxRounds,
      totalTokens: checkpoint.context.totalTokens,
      latestVerdict,
      error,
      description: checkpoint.context.taskDescription,
      stateGraph,
      transitionHistory,
      context: {
        taskDescription: checkpoint.context.taskDescription,
        round: checkpoint.context.round,
        maxRounds: checkpoint.context.maxRounds,
        totalTokens: checkpoint.context.totalTokens,
        visitCounts: { ...checkpoint.context.visitCounts },
      },
      // No live gate object available from disk; the frontend can re-fetch the
      // gate via `workflows.get` once the orchestrator re-loads the workflow.
      gate: undefined,
      workspacePath: checkpoint.workspacePath ?? '',
    };
  }

  // Checkpoint-less branch (D7): synthesize from the message log.
  const entries = new MessageLog(load.messageLogPath).readAll();
  const widePhase: LiveWorkflowPhase | PastRunPhase = isLive
    ? 'running'
    : synthesizePhaseFromMessageLog(entries, definition);
  const currentState = deriveLastStateFromEntries(entries, definition);
  // `WorkflowDefinition.description` is a required string field; the schema
  // ensures it's defined. We surface it directly as the task description.
  const taskDescription = definition.description;
  const startedAt = summary.mtime.toISOString();

  return {
    workflowId: id,
    name: definition.name,
    phase: widePhase,
    currentState,
    startedAt,
    taskDescription,
    round: 0,
    maxRounds: 0,
    totalTokens: 0,
    latestVerdict: undefined,
    error: undefined,
    description: taskDescription,
    stateGraph,
    // No persisted transition history without a checkpoint. The live
    // `state_transition` entries from the message log are surfaced separately
    // via `workflows.messageLog`, so we avoid double-rendering them here.
    transitionHistory: [],
    context: {
      taskDescription,
      round: 0,
      maxRounds: 0,
      totalTokens: 0,
      visitCounts: {},
    },
    gate: undefined,
    workspacePath: '',
  };
}

// ---------------------------------------------------------------------------
// File browser helpers
// ---------------------------------------------------------------------------

/** Directories excluded from listings by default. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

/** Maximum file size (bytes) for content display. */
const MAX_FILE_SIZE = 1_048_576; // 1MB

/** Number of bytes to check for binary content. */
const BINARY_CHECK_BYTES = 8192;

/** Extension-to-language mapping for syntax highlighting in the file viewer. */
const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.css': 'css',
  '.html': 'html',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.sh': 'shell',
  '.bash': 'shell',
  '.toml': 'toml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.sql': 'sql',
  '.dockerfile': 'dockerfile',
  '.txt': 'text',
};

/** Map file extensions to language identifiers for syntax highlighting. */
export function inferLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return LANG_MAP[ext] ?? 'text';
}

function getWorkspacePath(controller: ReturnType<WorkflowManager['getOrchestrator']>, id: WorkflowId): string {
  const detail = controller.getDetail(id);
  if (!detail) {
    throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${id} not found`);
  }
  return detail.workspacePath;
}

/**
 * Resolves a relative path within a workspace and validates containment.
 * Prevents path traversal attacks.
 */
export function resolveAndContain(workspacePath: string, relPath: string): string {
  const normalized = normalize(relPath);
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    throw new RpcError('INVALID_PARAMS', 'Path must be relative and within the workspace');
  }
  const target = resolve(workspacePath, normalized);

  if (!isWithinDirectory(target, workspacePath)) {
    throw new RpcError('INVALID_PARAMS', 'Path escapes workspace boundary');
  }
  return target;
}

function listDirectory(dirPath: string): FileTreeResponseDto {
  let rawEntries;
  try {
    rawEntries = readdirSync(dirPath, { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { entries: [] };
    }
    throw err;
  }
  const entries: FileTreeEntryDto[] = [];

  for (const entry of rawEntries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;

    const fullPath = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, type: 'directory' });
    } else if (entry.isFile()) {
      try {
        const s = statSync(fullPath);
        entries.push({ name: entry.name, type: 'file', size: s.size });
      } catch {
        entries.push({ name: entry.name, type: 'file' });
      }
    }
  }

  // Sort: directories first, then files, both alphabetical
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { entries };
}

function readWorkspaceFile(filePath: string): FileContentResponseDto {
  let s;
  try {
    s = statSync(filePath);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new RpcError('INVALID_PARAMS', 'File not found');
    }
    throw err;
  }
  if (s.isDirectory()) {
    throw new RpcError('INVALID_PARAMS', 'Path is a directory, not a file');
  }

  if (s.size > MAX_FILE_SIZE) {
    return { error: 'File too large to display (>1MB)' };
  }

  const buffer = readFileSync(filePath);

  // Null bytes reliably indicate binary content; checking only the header avoids scanning large files
  const checkLen = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      return { binary: true };
    }
  }

  return {
    content: buffer.toString('utf-8'),
    language: inferLanguage(filePath),
  };
}

function readArtifact(workspacePath: string, artifactName: string): ArtifactContentDto {
  // Validate artifact name: no path separators or traversal
  if (artifactName.includes('/') || artifactName.includes('\\') || artifactName === '..' || artifactName === '.') {
    throw new RpcError('INVALID_PARAMS', 'Invalid artifact name');
  }

  // Artifacts live in .workflow/{artifactName}/ inside the workspace
  const artifactDir = resolve(workspacePath, '.workflow', artifactName);

  const workflowDir = resolve(workspacePath, '.workflow');
  if (!isWithinDirectory(artifactDir, workflowDir)) {
    throw new RpcError('INVALID_PARAMS', 'Artifact path escapes workflow directory');
  }

  let entries;
  try {
    entries = readdirSync(artifactDir, { withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new RpcError('ARTIFACT_NOT_FOUND', `Artifact "${artifactName}" not found`);
    }
    throw err;
  }

  const files: ArtifactFileDto[] = [];
  collectArtifactFilesFromEntries(artifactDir, '', entries, files);
  return { files };
}

// ---------------------------------------------------------------------------
// Resumable workflow helpers
// ---------------------------------------------------------------------------

/**
 * Returns the widened `PastRunDto[]` for `workflows.listResumable`.
 *
 * Per design decision D4 the RPC name stays the same; the payload now covers
 * every past run on disk (terminal, gate-paused, and `interrupted`), not just
 * runs that a user could literally resume. The frontend filters/labels them.
 *
 * Directory enumeration routes through the shared
 * {@link discoverWorkflowRuns} utility (per plan B6), so the CLI and the
 * daemon converge on a single definition of "what past-run directories
 * exist?". Rows for workflows currently live in the orchestrator are skipped
 * here because they belong to `workflows.list` instead.
 *
 * Per-row enrichment is delegated to `manager.loadPastRun(id)` so that the
 * detail and list paths assemble DTOs from the same domain objects.
 *
 * Best-effort: rows whose checkpoint or definition fail to parse are skipped
 * with a stderr warning rather than failing the whole list. Skipping garbage
 * keeps the UI usable; the operator still has the warning to investigate.
 * Rows that vanish between enumeration and load (`not_found`) are skipped
 * silently — that case is a benign race with deletion.
 */
function buildResumableList(manager: WorkflowManager): PastRunDto[] {
  const controller = manager.getOrchestrator();
  const baseDir = manager.getBaseDir();
  const runs = discoverWorkflowRuns(baseDir);
  const activeIds = new Set<WorkflowId>(controller.listActive());
  const dtos: PastRunDto[] = [];

  for (const run of runs) {
    // Live rows belong to `workflows.list`, not the past-runs feed.
    if (activeIds.has(run.workflowId)) continue;
    const result = manager.loadPastRun(run.workflowId);
    if ('error' in result) {
      if (result.error === 'corrupted') {
        // Garbage on disk shouldn't poison the whole list; surface to operator.
        logger.warn(
          `[workflow-dispatch] skipping corrupted checkpoint ${run.workflowId}: ${result.message ?? 'unknown'}`,
        );
      }
      // 'not_found' = race with deletion; skip silently.
      continue;
    }
    dtos.push(buildPastRunDto(run.workflowId, result, run));
  }

  // Sort by timestamp descending (most recent first)
  dtos.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return dtos;
}

/**
 * Assembles a `PastRunDto` from on-disk past-run domain objects.
 *
 * Mirrors {@link buildDetailFromPastRun}'s field derivation so that the list
 * card and the detail view show consistent values for the same workflow. Two
 * branches:
 *
 * - **Checkpoint present:** all fields come from the checkpoint (timestamp,
 *   context, workspace path). Phase comes from {@link computePastRunPhase}.
 *   In the rare race where the row is now live, `'running'` is coerced to
 *   `'interrupted'` so the narrower `PastRunDto.phase` slot stays
 *   well-typed — past-run rows shouldn't carry the live phase.
 * - **Checkpoint absent (per D7):** the row is reconstructed from the message
 *   log plus the on-disk directory summary. Phase comes from
 *   {@link synthesizePhaseFromMessageLog}; `currentState`/`lastState` come
 *   from the latest `state_transition.event` (or `definition.initial`);
 *   `timestamp` comes from `summary.mtime`; numerics fall to zero;
 *   optionals (`latestVerdict`, `error`, `workspacePath`, `durationMs`)
 *   default to `undefined`.
 */
export function buildPastRunDto(id: WorkflowId, load: PastRunLoadSuccess, summary: WorkflowRunSummary): PastRunDto {
  const { checkpoint, definition, isLive } = load;

  if (checkpoint) {
    const widePhase = computePastRunPhase(checkpoint, definition, isLive);
    // `PastRunDto.phase` excludes 'running' by type. Map the race case to
    // 'interrupted' so the DTO is narrowly typed and the consumer sees a
    // non-active row (which is what the resumable list represents).
    const phase: PastRunPhase = widePhase === 'running' ? 'interrupted' : widePhase;
    const lastState = extractLastState(checkpoint.machineState);
    const error = extractPastRunError(checkpoint, phase);
    const latestVerdict = extractLatestVerdictFromTransitions(checkpoint.transitionHistory);

    return {
      workflowId: id,
      name: definition.name,
      phase,
      // `currentState` and `lastState` are the same value here: the checkpoint
      // captures only the most recently entered state, not a separate "previous".
      currentState: lastState,
      lastState,
      taskDescription: checkpoint.context.taskDescription,
      round: checkpoint.context.round,
      maxRounds: checkpoint.context.maxRounds,
      totalTokens: checkpoint.context.totalTokens,
      latestVerdict,
      error,
      timestamp: checkpoint.timestamp,
      // Checkpoints don't persist `startedAt`/`completedAt`, so the duration
      // between workflow start and end is unrecoverable from disk. Leave
      // `durationMs` undefined; surface this gap as a checkpoint-schema
      // limitation rather than fabricating a number.
      durationMs: undefined,
      workspacePath: checkpoint.workspacePath,
    };
  }

  // Checkpoint-less branch (D7): synthesize from the message log + summary.
  const entries = new MessageLog(load.messageLogPath).readAll();
  const phase = synthesizePhaseFromMessageLog(entries, definition);
  const lastState = deriveLastStateFromEntries(entries, definition);

  return {
    workflowId: id,
    name: definition.name,
    phase,
    currentState: lastState,
    lastState,
    // `WorkflowDefinition.description` is a required string per the schema.
    taskDescription: definition.description,
    round: 0,
    maxRounds: 0,
    totalTokens: 0,
    latestVerdict: undefined,
    error: undefined,
    timestamp: summary.mtime.toISOString(),
    durationMs: undefined,
    workspacePath: undefined,
  };
}

/**
 * Reads a page of {@link MessageLogEntry} records for a workflow with cursor
 * pagination (per design decision D5).
 *
 * Existence semantics: the workflow must be either currently active in the
 * orchestrator or recoverable from disk via {@link WorkflowManager.loadPastRun}.
 * Workflows write their checkpoint+definition immediately on `start()`, so
 * `loadPastRun` succeeds for live workflows too — this single check covers
 * both the live and past-run cases. Throws `WORKFLOW_NOT_FOUND` when neither
 * source has the id and `WORKFLOW_CORRUPTED` when the checkpoint or definition
 * file is present but unparseable.
 *
 * Note: `MessageLog.readAll()` silently skips malformed JSONL lines (it's
 * append-only and tolerant of truncated writes from crashes), so we cannot
 * surface log-file corruption distinctly here. The corruption error class
 * therefore reflects only checkpoint/definition issues, not log issues.
 *
 * Pagination shape: `entries` is filtered to `ts < before` when `before` is
 * set, sorted descending by `ts` (newest first), then sliced to `limit`.
 * `hasMore` is true iff `entries.length === limit` AND at least one entry
 * with `ts < entries[entries.length - 1].ts` exists in the original log.
 *
 * Cost: v1 re-reads and re-parses the whole log on every page request. This
 * is acceptable given typical message-log sizes (hundreds of entries); a
 * future `MessageLog.readRange(opts)` API can stream from disk in reverse
 * order if logs grow pathologically large. The `MessageLogResponseDto` shape
 * is stable across that change.
 */
export function readMessageLogPage(
  manager: WorkflowManager,
  workflowId: WorkflowId,
  opts: { before?: string; limit: number },
): MessageLogResponseDto {
  // Validate workflow existence via the past-run loader. Live workflows write
  // their checkpoint immediately on start, so this single lookup serves both
  // live and past-run cases without duplicating the live/disk fan-out from
  // `workflows.get`.
  const result = manager.loadPastRun(workflowId);
  if ('error' in result) {
    if (result.error === 'not_found') {
      throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
    }
    throw new RpcError('WORKFLOW_CORRUPTED', result.message ?? `Workflow ${workflowId} checkpoint is corrupted`);
  }

  const logPath = resolve(manager.getBaseDir(), workflowId, 'messages.jsonl');
  const log = new MessageLog(logPath);
  // Tolerant of malformed JSONL by design (skips bad lines silently).
  const all = log.readAll();

  const filtered = opts.before === undefined ? all : all.filter((e) => e.ts < (opts.before as string));
  // Newest-first ordering. Stable for entries with equal `ts`.
  filtered.sort(compareEntriesDesc);

  const page = filtered.slice(0, opts.limit);
  const hasMore = computeHasMore(filtered, page, opts.limit);

  return { entries: page, hasMore };
}

/** Descending comparator on `ts` (lexicographic on ISO-8601 strings == chronological). */
function compareEntriesDesc(a: MessageLogEntry, b: MessageLogEntry): number {
  if (a.ts === b.ts) return 0;
  return a.ts < b.ts ? 1 : -1;
}

/**
 * `hasMore` is true iff the page is full (`page.length === limit`) AND at
 * least one entry strictly older than the last entry on the page exists in
 * the filtered set. The strict-less-than check matches the cursor semantics:
 * the next request would set `before = page.last.ts` and exclude entries
 * with that exact timestamp, so equal-`ts` entries don't count as "more".
 */
function computeHasMore(
  filtered: readonly MessageLogEntry[],
  page: readonly MessageLogEntry[],
  limit: number,
): boolean {
  if (page.length < limit) return false;
  const cursor = page[page.length - 1].ts;
  for (const e of filtered) {
    if (e.ts < cursor) return true;
  }
  return false;
}

/**
 * Extracts a human-readable state name from an XState machine state snapshot.
 * The machineState can be a string (simple state) or a nested object (compound state).
 */
export function extractLastState(machineState: unknown): string {
  if (typeof machineState === 'string') return machineState;
  if (machineState && typeof machineState === 'object') {
    // Nested XState value: { parentState: "childState" }
    const keys = Object.keys(machineState as Record<string, unknown>);
    if (keys.length > 0) return keys[0];
  }
  return 'unknown';
}

function collectArtifactFilesFromEntries(
  dir: string,
  prefix: string,
  dirEntries: Dirent[],
  files: ArtifactFileDto[],
): void {
  for (const entry of dirEntries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      try {
        const childEntries = readdirSync(fullPath, { withFileTypes: true });
        collectArtifactFilesFromEntries(fullPath, relPath, childEntries, files);
      } catch {
        // Skip unreadable directories
      }
    } else if (entry.isFile()) {
      try {
        const s = statSync(fullPath);
        if (s.size > MAX_FILE_SIZE) {
          files.push({ path: relPath, content: `[File too large to display (${s.size} bytes)]` });
          continue;
        }
        const content = readFileSync(fullPath, 'utf-8');
        files.push({ path: relPath, content });
      } catch {
        // Skip unreadable files
      }
    }
  }
}
