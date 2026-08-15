import { describe, expect, it } from 'vitest';
import { MetricsAttributionRegistry, parseMetricsProxyAuthorization } from '../src/llm-metrics/attribution-registry.js';

describe('MetricsAttributionRegistry', () => {
  it('binds an immutable exact context to an opaque proxy credential', async () => {
    const registry = new MetricsAttributionRegistry();
    const lease = registry.createLease('http://127.0.0.1:18080', {
      sessionId: 'session-a',
      turnId: 'turn-a',
      agentId: 'claude-code',
    });
    const parsed = new URL(lease.proxyUrl);
    const token = parsed.password;

    expect(parsed.username).toBe('ironcurtain');
    expect(token).not.toContain('session-a');
    const handle = registry.acquire(token);
    expect(handle?.attribution).toMatchObject({ sessionId: 'session-a', turnId: 'turn-a', quality: 'exact' });
    handle?.release();
    await lease.end();
    expect(registry.acquire(token)).toBeUndefined();
  });

  it('does not admit a new request after revocation and drains an existing request', async () => {
    const registry = new MetricsAttributionRegistry();
    const lease = registry.createLease('http://proxy.test:8080', { sessionId: 'session-a' }, 1_000);
    const token = new URL(lease.proxyUrl).password;
    const inFlight = registry.acquire(token);
    const ending = lease.end();

    expect(registry.acquire(token)).toBeUndefined();
    inFlight?.release();
    await ending;
    expect(registry.activeLeaseCount()).toBe(0);
    expect(registry.registeredLeaseCount()).toBe(0);
  });

  it('does not retain timed-out or invalid leases', async () => {
    const registry = new MetricsAttributionRegistry();
    expect(() => registry.createLease('https://proxy.test', { sessionId: 'invalid' })).toThrow(/must use http/);
    expect(registry.registeredLeaseCount()).toBe(0);

    const lease = registry.createLease('http://proxy.test', { sessionId: 'timed-out' }, 1);
    const handle = registry.acquire(new URL(lease.proxyUrl).password);
    await lease.end();
    expect(registry.registeredLeaseCount()).toBe(0);
    handle?.release();
    expect(registry.registeredLeaseCount()).toBe(0);
  });

  it('parses only the reserved Basic proxy-auth username and token shape', () => {
    const token = 'a'.repeat(43);
    const valid = `Basic ${Buffer.from(`ironcurtain:${token}`).toString('base64')}`;
    const wrongUser = `Basic ${Buffer.from(`someone:${token}`).toString('base64')}`;

    expect(parseMetricsProxyAuthorization(valid)).toBe(token);
    expect(parseMetricsProxyAuthorization(wrongUser)).toBeUndefined();
    expect(parseMetricsProxyAuthorization('Bearer token')).toBeUndefined();
  });
});
