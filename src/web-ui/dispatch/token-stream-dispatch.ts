/**
 * Token stream subscription JSON-RPC dispatch.
 *
 * Handles the four token stream methods:
 *   - sessions.subscribeTokenStream     (per-session)
 *   - sessions.unsubscribeTokenStream   (per-session)
 *   - sessions.subscribeAllTokenStreams  (global)
 *   - sessions.unsubscribeAllTokenStreams (global)
 *
 * Per-session methods resolve label to SessionId via sessionManager.
 * Global methods use bus.subscribeAll via the bridge.
 */

import type { WebSocket as WsWebSocket } from 'ws';

import { type DispatchContext, validateParams, labelSchema } from './types.js';
import { SessionNotFoundError, MethodNotFoundError, RpcError } from '../web-ui-types.js';

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function tokenStreamDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
  client: WsWebSocket,
): unknown {
  const bridge = ctx.tokenStreamBridge;
  if (!bridge) {
    throw new RpcError('INTERNAL_ERROR', 'Token stream bridge not available');
  }

  switch (method) {
    case 'sessions.subscribeTokenStream': {
      const { label } = validateParams(labelSchema, params);
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      const sessionId = managed.session.getInfo().id;
      bridge.addClient(client, label, sessionId);
      return { subscribed: true };
    }

    case 'sessions.unsubscribeTokenStream': {
      const { label } = validateParams(labelSchema, params);
      bridge.removeClient(client, label);
      return { unsubscribed: true };
    }

    case 'sessions.subscribeAllTokenStreams': {
      bridge.addGlobalClient(client);
      // Register all existing sessions so global events can resolve labels
      for (const managed of ctx.sessionManager.all()) {
        const sessionId = managed.session.getInfo().id;
        bridge.registerSession(managed.label, sessionId);
      }
      return { subscribed: true };
    }

    case 'sessions.unsubscribeAllTokenStreams': {
      bridge.removeGlobalClient(client);
      return { unsubscribed: true };
    }

    default:
      throw new MethodNotFoundError(method);
  }
}
