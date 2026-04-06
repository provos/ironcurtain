/**
 * JSON-RPC method dispatch -- thin router.
 *
 * Delegates to domain-specific dispatch sub-modules by method prefix.
 * Shared types (DispatchContext, DTO builders) live in dispatch/types.ts.
 */

import type { MethodName } from './web-ui-types.js';
import { MethodNotFoundError } from './web-ui-types.js';
import { sessionDispatch } from './dispatch/session-dispatch.js';
import { jobDispatch } from './dispatch/job-dispatch.js';
import { escalationDispatch } from './dispatch/escalation-dispatch.js';
import { workflowDispatch, type WorkflowDispatchContext } from './dispatch/workflow-dispatch.js';
import { buildStatusDto } from './dispatch/types.js';
import { scanPersonas } from '../mux/persona-scanner.js';

// Re-export shared types for consumers (WebUiServer, tests)
export { type DispatchContext, toSessionDto, toBudgetDto, buildStatusDto } from './dispatch/types.js';
export type { WorkflowDispatchContext } from './dispatch/workflow-dispatch.js';

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function dispatch(
  ctx: WorkflowDispatchContext,
  method: MethodName,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method.startsWith('workflows.')) return workflowDispatch(ctx, method, params);
  if (method.startsWith('sessions.')) return sessionDispatch(ctx, method, params);
  if (method.startsWith('jobs.')) return jobDispatch(ctx, method, params);
  if (method.startsWith('escalations.')) return escalationDispatch(ctx, method, params);

  if (method === 'status') return buildStatusDto(ctx);

  if (method === 'personas.list') {
    return scanPersonas().map((p) => ({
      name: p.name,
      description: p.description,
      compiled: p.compiled,
    }));
  }

  throw new MethodNotFoundError(method);
}
