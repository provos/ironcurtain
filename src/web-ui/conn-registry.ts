/**
 * Per-connection id registry for the Web UI WS server.
 *
 * Assigns a short, stable id to each upgraded WebSocket connection so the
 * dispatch layer can build an `actor` string (`${remoteAddr}#${connId}`) for
 * audit attribution without reaching into transport internals. The map is a
 * `WeakMap` keyed by the socket, so entries are garbage-collected when the
 * connection closes.
 */

import type { WebSocket as WsWebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const connIds = new WeakMap<WsWebSocket, string>();

/** Assigns (or returns an existing) connId for a connection. */
export function assignConnId(ws: WsWebSocket): string {
  const existing = connIds.get(ws);
  if (existing) return existing;
  const id = randomUUID().slice(0, 8);
  connIds.set(ws, id);
  return id;
}

/** Returns the connId for a connection, or undefined if none was assigned. */
export function getConnId(ws: WsWebSocket): string | undefined {
  return connIds.get(ws);
}
