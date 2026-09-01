import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const USERNAME = 'ironcurtain';
const TOKEN_BYTES = 32;

/** Per-bundle credential used only on Docker Desktop's host-gateway TCP hop. */
export interface ProxyAuthorization {
  readonly header: string;
}

export function createProxyAuthorization(): ProxyAuthorization {
  const password = randomBytes(TOKEN_BYTES).toString('base64url');
  return { header: `Basic ${Buffer.from(`${USERNAME}:${password}`, 'utf8').toString('base64')}` };
}

/** Validate and consume the hop credential before downstream policy sees headers. */
export function consumeProxyAuthorization(request: IncomingMessage, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const actual = request.headers['proxy-authorization'];
  if (typeof actual !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  const accepted = expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  if (accepted) {
    delete request.headers['proxy-authorization'];
    for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
      if (request.rawHeaders[index]?.toLowerCase() === 'proxy-authorization') {
        request.rawHeaders.splice(index, 2);
      }
    }
  }
  return accepted;
}
