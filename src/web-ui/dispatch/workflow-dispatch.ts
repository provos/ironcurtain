/**
 * Workflow-related JSON-RPC method dispatch.
 *
 * Handles all `workflows.*` methods: list, get, start, resume,
 * abort, resolveGate, inspect, fileTree, fileContent, artifacts.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import {
  type WorkflowSummaryDto,
  type WorkflowDetailDto,
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
const workflowResolveGateSchema = z.object({
  workflowId: z.string().min(1),
  event: z.enum(['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT']),
  prompt: z.string().optional(),
});
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
      const workflowId = await controller.start(definitionPath, taskDescription, workspacePath);
      return { workflowId };
    }

    case 'workflows.resume': {
      const { workflowId } = validateParams(workflowIdSchema, params);
      await controller.resume(workflowId as WorkflowId);
      return { accepted: true };
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
