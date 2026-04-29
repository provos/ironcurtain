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
} from '../web-ui-types.js';
import type { PastRunLoadSuccess, WorkflowManager } from '../../workflow/workflow-manager.js';
import {
  toHumanGateRequestDto,
  type WorkflowId,
  type WorkflowStatus,
  type WorkflowCheckpoint,
  type WorkflowDefinition,
} from '../../workflow/types.js';
import type { WorkflowDetail } from '../../workflow/orchestrator.js';
import { MessageLog, type MessageLogEntry, type StateTransitionEntry } from '../../workflow/message-log.js';
import {
  discoverWorkflowRuns,
  discoverWorkspacePathFromContainers,
  summaryForId,
  type WorkflowRunSummary,
} from '../../workflow/workflow-discovery.js';
import { extractStateGraph } from '../state-graph.js';
import type { StateGraphDto } from '../web-ui-types.js';
import { isWithinDirectory } from '../../types/argument-roles.js';
import { runPreflight } from '../../workflow/lint-integration.js';
import * as logger from '../../logger.js';

// ---------------------------------------------------------------------------
// State graph cache (definition never changes during execution)
// ---------------------------------------------------------------------------

const stateGraphCache = new Map<WorkflowId, StateGraphDto>();

const PAST_RUN_PHASES = new Set<PastRunPhase>(['completed', 'aborted', 'failed', 'waiting_human', 'interrupted']);

function isPastRunPhase(value: string | undefined): value is PastRunPhase {
  return value !== undefined && PAST_RUN_PHASES.has(value as PastRunPhase);
}

/** Map a terminal state's name to a phase using the orchestrator's name convention. */
function phaseFromTerminalStateName(name: string): 'completed' | 'aborted' {
  return name === 'aborted' || name.toLowerCase().includes('abort') ? 'aborted' : 'completed';
}

/** Returns the entry with the largest `ts` among `state_transition` entries, or undefined. */
function findLastStateTransition(entries: readonly MessageLogEntry[]): StateTransitionEntry | undefined {
  let last: StateTransitionEntry | undefined;
  for (const entry of entries) {
    if (entry.type !== 'state_transition') continue;
    if (last === undefined || entry.ts > last.ts) last = entry;
  }
  return last;
}

/** Defensive state lookup (runtime-safe; the index signature lies about presence). */
function getStateDef(definition: WorkflowDefinition, name: string): WorkflowDefinition['states'][string] | undefined {
  return Object.prototype.hasOwnProperty.call(definition.states, name) ? definition.states[name] : undefined;
}

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

/**
 * Parses + validates the definition file, then runs the shared
 * `runPreflight()` helper in `warn` mode. Errors abort via `LINT_FAILED`;
 * warnings are logged and ignored.
 *
 * The `warn` mode is the right default for the daemon: warnings are
 * advisory and should not block a workflow start from the web UI,
 * whereas true errors indicate a workflow that will not run correctly.
 */
function preflightLintForDaemon(definitionPath: string): void {
  const result = runPreflight(definitionPath, 'warn');

  if (result.ok) {
    if (result.warnings > 0) {
      logger.warn(
        `[workflow-dispatch] Lint warnings for ${definitionPath}: ${result.diagnostics
          .map((d) => `[${d.code}] ${d.message}`)
          .join(' | ')}`,
      );
    }
    return;
  }

  if (result.kind === 'load') {
    // `loadDefinition` builds the message in the same format the previous
    // inline implementation used: validate failures begin with "Workflow
    // validation failed: ..."; parse failures are wrapped here with the
    // legacy "Failed to load workflow definition:" prefix to preserve the
    // existing wording for daemon consumers.
    if (result.loadKind === 'validate') {
      throw new RpcError('INVALID_PARAMS', result.message);
    }
    throw new RpcError('INVALID_PARAMS', `Failed to load workflow definition: ${result.message}`);
  }

  // Lint failure (load succeeded).
  throw new RpcError('LINT_FAILED', `Workflow lint failed: ${result.errors} error(s), ${result.warnings} warning(s).`, {
    diagnostics: result.diagnostics,
  });
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
      // `buildDetailFromPastRun` only consults `summary.mtime` in the
      // checkpoint-less branch, so a synthetic now-dated summary is safe in
      // the rare race where the directory vanished between load and lookup.
      const summary = summaryForId(manager.getBaseDir(), id) ?? {
        workflowId: id,
        directoryPath: resolve(manager.getBaseDir(), id),
        hasCheckpoint: false,
        hasDefinition: false,
        hasMessageLog: false,
        mtime: new Date(),
      };
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
      const workspacePath = getWorkspacePath(controller, manager, workflowId as WorkflowId);
      const targetDir = resolveAndContain(workspacePath, relPath ?? '');
      return listDirectory(targetDir);
    }

    case 'workflows.fileContent': {
      const { workflowId, path: relPath } = validateParams(workflowFileContentSchema, params);
      const workspacePath = getWorkspacePath(controller, manager, workflowId as WorkflowId);
      const targetFile = resolveAndContain(workspacePath, relPath);
      return readWorkspaceFile(targetFile);
    }

    case 'workflows.artifacts': {
      const { workflowId, artifactName } = validateParams(workflowArtifactSchema, params);
      const workspacePath = getWorkspacePath(controller, manager, workflowId as WorkflowId);
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
    latestVerdict: extractLatestVerdictFromTransitions(),
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
  const finalPhase = checkpoint.finalStatus?.phase;
  if (isPastRunPhase(finalPhase)) return finalPhase;
  // Legacy pre-B3b path: derive from the state name.
  const stateName = extractLastState(checkpoint.machineState);
  const stateDef = getStateDef(definition, stateName);
  if (stateDef?.type === 'terminal') return phaseFromTerminalStateName(stateName);
  if (stateDef?.type === 'human_gate') return 'waiting_human';
  return 'interrupted';
}

/**
 * Synthesize a `PastRunPhase` for a checkpoint-less directory from its message log.
 * `entries` must be chronological (oldest-first), matching `MessageLog.readAll()`.
 *
 * Per D6: the destination state of the last `state_transition` lives in the
 * `event` field (orchestrator.handleTransition writes it there). For non-terminal,
 * non-gate destinations, post-transition `quota_exhausted` → 'aborted',
 * `transient_failure` → 'aborted', `error` → 'failed', none → 'interrupted'.
 */
export function synthesizePhaseFromMessageLog(
  entries: readonly MessageLogEntry[],
  definition: WorkflowDefinition,
): PastRunPhase {
  // Single pass: track lastTransition AND post-transition signals together.
  // When a newer transition arrives, the post-transition accumulators reset.
  let lastTransition: StateTransitionEntry | undefined;
  let sawQuotaExhausted = false;
  let sawTransientFailure = false;
  let sawError = false;
  for (const entry of entries) {
    if (entry.type === 'state_transition') {
      if (lastTransition === undefined || entry.ts > lastTransition.ts) {
        lastTransition = entry;
        sawQuotaExhausted = false;
        sawTransientFailure = false;
        sawError = false;
      }
      continue;
    }
    if (lastTransition === undefined || entry.ts <= lastTransition.ts) continue;
    if (entry.type === 'quota_exhausted') sawQuotaExhausted = true;
    else if (entry.type === 'transient_failure') sawTransientFailure = true;
    else if (entry.type === 'error') sawError = true;
  }
  if (lastTransition === undefined) return 'interrupted';
  const stateDef = getStateDef(definition, lastTransition.event);
  if (stateDef?.type === 'terminal') return phaseFromTerminalStateName(lastTransition.event);
  if (stateDef?.type === 'human_gate') return 'waiting_human';
  if (sawQuotaExhausted) return 'aborted';
  if (sawTransientFailure) return 'aborted';
  if (sawError) return 'failed';
  return 'interrupted';
}

/**
 * `TransitionRecord` doesn't carry a structured verdict; the frontend populates
 * `latestVerdict` from live `workflow.agent_completed` events. Past-run callers
 * receive `undefined` until checkpoints capture verdict/confidence first-class.
 */
export function extractLatestVerdictFromTransitions(): LatestVerdictDto | undefined {
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

/** Destination state of the latest `state_transition`, or `definition.initial`. */
function deriveLastStateFromEntries(entries: readonly MessageLogEntry[], definition: WorkflowDefinition): string {
  return findLastStateTransition(entries)?.event ?? definition.initial;
}

/** Assembles a `WorkflowDetailDto` from on-disk past-run objects (checkpoint or message-log fallback). */
export function buildDetailFromPastRun(
  id: WorkflowId,
  load: PastRunLoadSuccess,
  summary: WorkflowRunSummary,
): WorkflowDetailDto {
  const { checkpoint, definition, isLive } = load;
  const stateGraph = getCachedStateGraph(id, definition);

  if (checkpoint) {
    const phase = computePastRunPhase(checkpoint, definition, isLive);
    const currentState = extractLastState(checkpoint.machineState);
    return {
      workflowId: id,
      name: definition.name,
      phase,
      currentState,
      // Checkpoint timestamp is a best-effort stand-in for startedAt.
      startedAt: checkpoint.timestamp,
      taskDescription: checkpoint.context.taskDescription,
      round: checkpoint.context.round,
      maxRounds: checkpoint.context.maxRounds,
      totalTokens: checkpoint.context.totalTokens,
      latestVerdict: extractLatestVerdictFromTransitions(),
      error: extractPastRunError(checkpoint, phase),
      description: checkpoint.context.taskDescription,
      stateGraph,
      transitionHistory: mapTransitionRecords(checkpoint.transitionHistory),
      context: {
        taskDescription: checkpoint.context.taskDescription,
        round: checkpoint.context.round,
        maxRounds: checkpoint.context.maxRounds,
        totalTokens: checkpoint.context.totalTokens,
        visitCounts: { ...checkpoint.context.visitCounts },
      },
      gate: undefined,
      workspacePath: checkpoint.workspacePath ?? '',
    };
  }

  const entries = new MessageLog(load.messageLogPath).readAll();
  const widePhase: LiveWorkflowPhase | PastRunPhase = isLive
    ? 'running'
    : synthesizePhaseFromMessageLog(entries, definition);
  const currentState = deriveLastStateFromEntries(entries, definition);
  const taskDescription = definition.description;
  const startedAt = summary.mtime.toISOString();
  const recoveredWorkspace = discoverWorkspacePathFromContainers(summary.directoryPath) ?? '';

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
    // state_transition entries from the message log are surfaced via
    // workflows.messageLog instead, to avoid double-rendering.
    transitionHistory: [],
    context: { taskDescription, round: 0, maxRounds: 0, totalTokens: 0, visitCounts: {} },
    gate: undefined,
    workspacePath: recoveredWorkspace,
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

/**
 * Resolves a workflow's workspace path: live detail → past-run checkpoint →
 * recovered from container session-metadata. Throws `WORKFLOW_NOT_FOUND`
 * when all three sources are empty. The returned path is not guaranteed to
 * exist on disk (ephemeral workspaces may be torn down post-completion);
 * `listDirectory` handles ENOENT gracefully.
 */
function getWorkspacePath(
  controller: ReturnType<WorkflowManager['getOrchestrator']>,
  manager: WorkflowManager,
  id: WorkflowId,
): string {
  const liveDetail = controller.getDetail(id);
  if (liveDetail) return liveDetail.workspacePath;

  const result = manager.loadPastRun(id);
  if ('error' in result) {
    throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${id} not found`);
  }
  const pastWorkspace = result.checkpoint?.workspacePath;
  if (pastWorkspace) return pastWorkspace;

  const recovered = discoverWorkspacePathFromContainers(resolve(manager.getBaseDir(), id));
  if (recovered) return recovered;

  throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${id} has no recorded workspace`);
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
 * Returns every past-run directory as `PastRunDto[]` for `workflows.listResumable`
 * (RPC name kept per D4; payload covers terminal, gate-paused, and interrupted
 * rows). Live workflows are skipped (they belong to `workflows.list`); corrupted
 * rows are warned-and-skipped; not_found rows are silently skipped.
 */
function buildResumableList(manager: WorkflowManager): PastRunDto[] {
  const controller = manager.getOrchestrator();
  const baseDir = manager.getBaseDir();
  const runs = discoverWorkflowRuns(baseDir);
  const activeIds = new Set<WorkflowId>(controller.listActive());
  const dtos: PastRunDto[] = [];

  for (const run of runs) {
    if (activeIds.has(run.workflowId)) continue;
    const result = manager.loadPastRun(run.workflowId, activeIds);
    if ('error' in result) {
      if (result.error === 'corrupted') {
        logger.warn(
          `[workflow-dispatch] skipping corrupted checkpoint ${run.workflowId}: ${result.message ?? 'unknown'}`,
        );
      }
      continue;
    }
    dtos.push(buildPastRunDto(run.workflowId, result, run));
  }

  dtos.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return dtos;
}

/** Assembles a `PastRunDto` from on-disk past-run objects (checkpoint or message-log fallback). */
export function buildPastRunDto(id: WorkflowId, load: PastRunLoadSuccess, summary: WorkflowRunSummary): PastRunDto {
  const { checkpoint, definition, isLive } = load;

  if (checkpoint) {
    const widePhase = computePastRunPhase(checkpoint, definition, isLive);
    // PastRunDto.phase excludes 'running'; coerce the rare live-race row.
    const phase: PastRunPhase = widePhase === 'running' ? 'interrupted' : widePhase;
    const lastState = extractLastState(checkpoint.machineState);
    return {
      workflowId: id,
      name: definition.name,
      phase,
      currentState: lastState,
      lastState,
      taskDescription: checkpoint.context.taskDescription,
      round: checkpoint.context.round,
      maxRounds: checkpoint.context.maxRounds,
      totalTokens: checkpoint.context.totalTokens,
      latestVerdict: extractLatestVerdictFromTransitions(),
      error: extractPastRunError(checkpoint, phase),
      timestamp: checkpoint.timestamp,
      durationMs: undefined,
      workspacePath: checkpoint.workspacePath,
    };
  }

  const entries = new MessageLog(load.messageLogPath).readAll();
  const phase = synthesizePhaseFromMessageLog(entries, definition);
  const lastState = deriveLastStateFromEntries(entries, definition);

  return {
    workflowId: id,
    name: definition.name,
    phase,
    currentState: lastState,
    lastState,
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
