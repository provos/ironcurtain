import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createConnection: vi.fn(() => new actual.Socket()),
  };
});

import { attachPty } from '../src/docker/pty-session.js';

describe('attachPty pre-connect bounds', () => {
  afterEach(() => vi.useRealTimers());

  it('destroys an in-flight pre-connect socket when shutdown is requested', async () => {
    const controller = new AbortController();
    const attached = attachPty({
      target: { host: '192.0.2.1', port: 65535 },
      containerId: 'unused',
      signal: controller.signal,
    });

    controller.abort();

    await expect(attached).resolves.toBe(0);
  });

  it('bounds a socket that never connects by the outer readiness deadline', async () => {
    vi.useFakeTimers();
    const attached = attachPty({
      target: { host: '192.0.2.1', port: 65535 },
      containerId: 'unused',
    });
    const settled = attached.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_001);

    await expect(settled).resolves.toMatchObject({ message: expect.stringMatching(/did not stabilize/u) });
  });
});
