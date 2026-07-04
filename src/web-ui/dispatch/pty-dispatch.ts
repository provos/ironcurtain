/**
 * PTY terminal subscription JSON-RPC dispatch.
 *
 * Handles the four per-client PTY methods:
 *   - sessions.ptyAttach   (subscribe + one-shot replay snapshot)
 *   - sessions.ptyDetach   (unsubscribe)
 *   - sessions.ptyInput    (forward base64 keystroke bytes to the child stdin)
 *   - sessions.ptyResize   (resize the child PTY)
 *
 * All delegate to `ctx.ptySessionManager`. Mirrors token-stream-dispatch.ts:
 * attach/detach are keyed to the calling WebSocket, so the client is required.
 */

import { z } from 'zod';
import type { WebSocket as WsWebSocket } from 'ws';

import { type DispatchContext, validateParams, labelSchema } from './types.js';
import { MethodNotFoundError, RpcError } from '../web-ui-types.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const ptyInputSchema = z.object({ label: z.number().int().positive(), data: z.string() });
const ptyResizeSchema = z.object({
  label: z.number().int().positive(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function ptyDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
  client: WsWebSocket,
): unknown {
  const manager = ctx.ptySessionManager;
  if (!manager) {
    throw new RpcError('INTERNAL_ERROR', 'PTY session manager not available');
  }

  switch (method) {
    case 'sessions.ptyAttach': {
      const { label } = validateParams(labelSchema, params);
      manager.attach(label, client);
      return { attached: true };
    }

    case 'sessions.ptyDetach': {
      const { label } = validateParams(labelSchema, params);
      manager.detach(label, client);
      return { detached: true };
    }

    case 'sessions.ptyInput': {
      const { label, data } = validateParams(ptyInputSchema, params);
      manager.input(label, data);
      return { accepted: true };
    }

    case 'sessions.ptyResize': {
      const { label, cols, rows } = validateParams(ptyResizeSchema, params);
      manager.resize(label, cols, rows);
      return { resized: true };
    }

    default:
      throw new MethodNotFoundError(method);
  }
}
