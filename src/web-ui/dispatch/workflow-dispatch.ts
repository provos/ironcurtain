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
  type ResumableWorkflowDto,
  type FileTreeEntryDto,
  type FileTreeResponseDto,
  type FileContentResponseDto,
  type ArtifactContentDto,
  type ArtifactFileDto,
  RpcError,
  MethodNotFoundError,
  toHumanGateRequestDto,
} from '../web-ui-types.js';
import type { WorkflowManager } from '../workflow-manager.js';
import type { WorkflowId, WorkflowStatus } from '../../workflow/types.js';
import type { WorkflowDetail } from '../../workflow/orchestrator.js';
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
          summaries.push(buildSummaryDto(id, status));
        }
      }
      return summaries;
    }

    case 'workflows.get': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      const id = workflowId as WorkflowId;
      const status = controller.getStatus(id);
      if (!status) {
        throw new RpcError('WORKFLOW_NOT_FOUND', `Workflow ${workflowId} not found`);
      }
      const detail = controller.getDetail(id);
      return buildDetailDto(id, status, detail);
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

function buildSummaryDto(id: WorkflowId, status: WorkflowStatus): WorkflowSummaryDto {
  return {
    workflowId: id,
    name: id, // Name not available from status alone; use id as fallback
    phase: status.phase,
    currentState: getCurrentState(status),
    startedAt: new Date().toISOString(), // Approximate; real start time needs instance access
  };
}

function buildDetailDto(id: WorkflowId, status: WorkflowStatus, detail?: WorkflowDetail): WorkflowDetailDto {
  const base = buildSummaryDto(id, status);
  let stateGraph: StateGraphDto = { states: [], transitions: [] };
  if (detail) {
    let cached = stateGraphCache.get(id);
    if (!cached) {
      cached = extractStateGraph(detail.definition);
      stateGraphCache.set(id, cached);
    }
    stateGraph = cached;
  }
  const transitionHistory = (detail?.transitionHistory ?? []).map((t) => ({
    from: t.from,
    to: t.to,
    event: t.event,
    timestamp: t.timestamp,
    durationMs: t.duration_ms,
    agentMessage: t.agentMessage,
  }));

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

function buildResumableList(manager: WorkflowManager): ResumableWorkflowDto[] {
  const controller = manager.getOrchestrator();
  const resumableIds = controller.listResumable();
  const store = manager.getCheckpointStore();
  const dtos: ResumableWorkflowDto[] = [];

  for (const id of resumableIds) {
    const checkpoint = store.load(id);
    if (!checkpoint) continue;

    // Determine last state from checkpoint's machine state
    const lastState = extractLastState(checkpoint.machineState);
    dtos.push({
      workflowId: id,
      lastState,
      timestamp: checkpoint.timestamp,
      taskDescription: checkpoint.context.taskDescription,
      workspacePath: checkpoint.workspacePath,
    });
  }

  // Sort by timestamp descending (most recent first)
  dtos.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return dtos;
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
