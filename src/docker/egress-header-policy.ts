/** Shared immutable request-header policy for mediated egress paths. */

import { HOP_BY_HOP_HEADERS } from './hop-by-hop-headers.js';

/** Credentials an untrusted workload must never relay through an egress proxy. */
export const EGRESS_FORBIDDEN_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-api-key',
]);

/**
 * Headers that are transport-local or nonessential client telemetry and must not
 * cross the mediated hop. In particular, BuildKit can propagate W3C trace
 * context (`traceparent` plus `tracestate`) and baggage on image metadata
 * requests. Forwarding those client-controlled values would add no pull
 * semantics while exposing an unnecessary correlation/exfiltration channel.
 */
export const EGRESS_DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'baggage',
  'traceparent',
  'tracestate',
  ...HOP_BY_HOP_HEADERS,
]);
