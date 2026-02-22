import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ROOTS_REFRESH_TIMEOUT_MS } from '../src/trusted-process/mcp-client-manager.js';

/**
 * Tests for the addRootToClient timeout safety net used by both
 * mcp-proxy-server.ts and mcp-client-manager.ts.
 *
 * addRootToClient is module-private, so we replicate its core logic
 * here to verify the Promise.race timeout works correctly.
 */

interface MockClientState {
  roots: { uri: string; name: string }[];
  rootsRefreshed?: () => void;
  sendRootsListChangedCalled: boolean;
}

/** Replicates addRootToClient logic from mcp-proxy-server.ts */
async function addRootToClient(state: MockClientState, root: { uri: string; name: string }): Promise<void> {
  if (state.roots.some((r) => r.uri === root.uri)) return;
  state.roots.push(root);

  const refreshed = new Promise<void>((resolve) => {
    state.rootsRefreshed = resolve;
  });
  state.sendRootsListChangedCalled = true;
  await Promise.race([refreshed, new Promise<void>((resolve) => setTimeout(resolve, ROOTS_REFRESH_TIMEOUT_MS))]);
}

describe('addRootToClient timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when server acknowledges roots/list', async () => {
    const state: MockClientState = { roots: [], sendRootsListChangedCalled: false };
    const root = { uri: 'file:///tmp/test', name: 'escalation-approved' };

    const promise = addRootToClient(state, root);

    // Simulate server calling back immediately
    state.rootsRefreshed!();

    await promise;
    expect(state.roots).toContainEqual(root);
    expect(state.sendRootsListChangedCalled).toBe(true);
  });

  it('resolves after timeout when server never acknowledges roots/list', async () => {
    const state: MockClientState = { roots: [], sendRootsListChangedCalled: false };
    const root = { uri: 'file:///tmp/test', name: 'escalation-approved' };

    const promise = addRootToClient(state, root);

    // Server never calls back — advance past the timeout
    vi.advanceTimersByTime(ROOTS_REFRESH_TIMEOUT_MS);

    await promise;
    expect(state.roots).toContainEqual(root);
    expect(state.sendRootsListChangedCalled).toBe(true);
  });

  it('stays pending until exactly the timeout elapses', async () => {
    const state: MockClientState = { roots: [], sendRootsListChangedCalled: false };
    const root = { uri: 'file:///tmp/test', name: 'escalation-approved' };

    let resolved = false;
    const promise = addRootToClient(state, root).then(() => {
      resolved = true;
    });

    // Before timeout: still pending
    vi.advanceTimersByTime(ROOTS_REFRESH_TIMEOUT_MS - 1);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    // At timeout: resolves
    vi.advanceTimersByTime(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('is a no-op when root URI already exists', async () => {
    const existingRoot = { uri: 'file:///tmp/test', name: 'existing' };
    const state: MockClientState = {
      roots: [existingRoot],
      sendRootsListChangedCalled: false,
    };

    await addRootToClient(state, { uri: 'file:///tmp/test', name: 'escalation-approved' });

    // Should not have sent notification or added duplicate
    expect(state.roots).toHaveLength(1);
    expect(state.sendRootsListChangedCalled).toBe(false);
  });
});
