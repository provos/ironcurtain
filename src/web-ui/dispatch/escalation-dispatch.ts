/**
 * Escalation-related JSON-RPC method dispatch.
 *
 * Handles all `escalations.*` methods: list, resolve.
 */

import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import { type EscalationDto, RpcError, MethodNotFoundError } from '../web-ui-types.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const escalationResolveSchema = z.object({
  escalationId: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  whitelistSelection: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Escalation dispatch
// ---------------------------------------------------------------------------

export async function escalationDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'escalations.list':
      return listEscalations(ctx);
    case 'escalations.resolve': {
      const validated = validateParams(escalationResolveSchema, params);
      const options =
        validated.whitelistSelection != null ? { whitelistSelection: validated.whitelistSelection } : undefined;

      // PTY sessions own their escalations outside SessionManager; route to the
      // PTY manager (writes the response file + emits escalation.resolved).
      if (ctx.ptySessionManager?.hasEscalation(validated.escalationId)) {
        ctx.ptySessionManager.resolveEscalation(validated.escalationId, validated.decision, options);
        return;
      }

      const result = await ctx.sessionManager.resolveSessionEscalation(
        validated.escalationId,
        validated.decision,
        options,
      );
      if (!result.resolved) {
        throw new RpcError(
          result.reason === 'already_resolving' ? 'SESSION_BUSY' : 'ESCALATION_NOT_FOUND',
          result.reason ?? 'Failed to resolve escalation',
        );
      }
      return;
    }
    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listEscalations(ctx: DispatchContext): EscalationDto[] {
  const turnBased = ctx.sessionManager.withPendingEscalation().flatMap((m) => {
    const esc = m.pendingEscalation;
    if (!esc) return [];
    return [
      {
        ...esc,
        sessionSource: m.source,
      },
    ];
  });
  const pty = ctx.ptySessionManager?.listPendingEscalationDtos() ?? [];
  return [...turnBased, ...pty];
}
