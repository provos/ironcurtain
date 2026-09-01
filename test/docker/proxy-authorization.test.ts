import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { consumeProxyAuthorization, createProxyAuthorization } from '../../src/docker/proxy-authorization.js';

describe('Docker-workload proxy authorization', () => {
  it('creates a high-entropy Basic credential', () => {
    const authorization = createProxyAuthorization();
    const decoded = Buffer.from(authorization.header.slice('Basic '.length), 'base64').toString('utf8');

    expect(decoded).toMatch(/^ironcurtain:[A-Za-z0-9_-]{43}$/u);
  });

  it('consumes only the exact expected header', () => {
    const authorization = createProxyAuthorization();
    const exact = {
      headers: { 'proxy-authorization': authorization.header },
      rawHeaders: ['Proxy-Authorization', authorization.header],
    } as unknown as IncomingMessage;
    const wrong = {
      headers: { 'proxy-authorization': `${authorization.header}x` },
      rawHeaders: ['Proxy-Authorization', `${authorization.header}x`],
    } as unknown as IncomingMessage;

    expect(consumeProxyAuthorization(exact, authorization.header)).toBe(true);
    expect(exact.headers['proxy-authorization']).toBeUndefined();
    expect(exact.rawHeaders).toEqual([]);
    expect(consumeProxyAuthorization(wrong, authorization.header)).toBe(false);
    expect(
      consumeProxyAuthorization({ headers: {}, rawHeaders: [] } as unknown as IncomingMessage, authorization.header),
    ).toBe(false);
  });
});
