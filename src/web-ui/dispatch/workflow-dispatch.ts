/**
 * Workflow-related JSON-RPC method dispatch.
 *
 * Handles all `workflows.*` methods: list, get, start, resume,
 * abort, resolveGate, inspect.
 */

import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import {
  type WorkflowSummaryDto,
  type WorkflowDetailDto,
  RpcError,
  MethodNotFoundError,
  toHumanGateRequestDto,
} from '../web-ui-types.js';
import type { WorkflowManager } from '../workflow-manager.js';
import type { WorkflowId, WorkflowStatus } from '../../workflow/types.js';
import type { WorkflowDetail } from '../../workflow/orchestrator.js';
import { extractStateGraph } from '../state-graph.js';
import type { StateGraphDto } from '../web-ui-types.js';

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
