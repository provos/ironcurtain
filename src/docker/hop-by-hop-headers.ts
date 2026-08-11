/**
 * Single source of truth for the connection-specific ("hop-by-hop") header
 * names a forwarding proxy must strip so they never cross a proxy boundary.
 *
 * The set is the RFC 7230 §6.1 canonical list (`connection`, `keep-alive`,
 * `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`,
 * `transfer-encoding`, `upgrade`) plus the non-standard `proxy-connection`.
 * Two directional views share that core:
 *
 * - {@link HOP_BY_HOP_HEADERS} — request-direction strip. Sites that must
 *   forward a WebSocket handshake carve out `connection`/`upgrade` explicitly.
 * - {@link HOP_BY_HOP_RESPONSE_HEADERS} — response-direction strip: the core
 *   plus `set-cookie` (a stored-credential vector a proxy must not relay back).
 *
 * All names are lowercase; callers must `.toLowerCase()` header keys before
 * membership tests.
 */

/**
 * RFC 7230 §6.1 connection-specific headers (lowercased) plus `proxy-connection`.
 * A proxy must not forward any of these across a hop in the request direction.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Response headers a forwarding proxy must not relay downstream: every
 * hop-by-hop header plus `set-cookie`.
 */
export const HOP_BY_HOP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([...HOP_BY_HOP_HEADERS, 'set-cookie']);

/**
 * Parse the additional hop-by-hop names nominated by an HTTP `Connection`
 * header. Node represents duplicate headers as either a comma-joined string or
 * an array, so both shapes are accepted.
 */
export function connectionNominatedHeaderNames(value: string | readonly string[] | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  const values = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  for (const item of values) {
    for (const token of item.split(',')) {
      const name = token.trim().toLowerCase();
      if (name !== '') result.add(name);
    }
  }
  return result;
}
