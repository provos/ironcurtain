/**
 * Shared request/response shaping for the destination-bound egress proxies
 * (`build-egress-proxy.ts` and `registry-egress-proxy.ts`).
 *
 * Both proxies terminate TLS on a per-listener MITM, authorize the decrypted
 * request against a frozen manifest, then forward the sanitized result through a
 * destination-bound {@link import('./outbound-transport.js').OutboundTransport}.
 * The pure header/URL shaping around that forward is identical between them, so
 * it lives here — a change to one (e.g. closing a header leak) cannot drift
 * between the two seams.
 *
 * This is a leaf: it depends only on `node:http` types and the hop-by-hop header
 * set.
 */

import type * as http from 'node:http';
import { HOP_BY_HOP_RESPONSE_HEADERS } from './hop-by-hop-headers.js';

/**
 * The forward-target fields both proxies' per-request contexts expose. Structural
 * so each proxy passes its own richer `*ForwardContext` without an adapter.
 */
export interface EgressForwardTarget {
  /** Origin-form request target (path + query) as seen after TLS termination. */
  readonly requestTarget: string;
  readonly scheme: 'http:' | 'https:';
  readonly targetHost: string;
  readonly targetPort: number;
}

/** Reconstruct the absolute upstream URL the guard authorizes from the terminated request. */
export function buildRequestUrl(target: EgressForwardTarget): string {
  const path = target.requestTarget.startsWith('/') ? target.requestTarget : `/${target.requestTarget}`;
  return `${target.scheme}//${formatAuthority(target.targetHost, target.targetPort, target.scheme)}${path}`;
}

/** Normalize authorized header values into a Node outgoing-header shape (copying array values). */
export function toOutgoingHeaders(
  headers: Readonly<Record<string, string | readonly string[]>>,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = typeof value === 'string' ? value : [...value];
  }
  return result;
}

/**
 * Strip hop-by-hop and credential (`set-cookie`) response headers before relaying
 * an upstream response downstream, so none crosses the proxy boundary. Names are
 * compared case-insensitively against {@link HOP_BY_HOP_RESPONSE_HEADERS}.
 */
export function sanitizeResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function formatAuthority(hostname: string, port: number, scheme: 'http:' | 'https:'): string {
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  const standard = (scheme === 'https:' && port === 443) || (scheme === 'http:' && port === 80);
  return standard ? host : `${host}:${port}`;
}
