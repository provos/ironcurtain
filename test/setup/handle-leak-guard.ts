/**
 * Handle-leak guard — a test-only teardown safety net.
 *
 * Root-causes the recurring macOS-only CI flake where every test passes but the
 * run fails with `Worker exited unexpectedly` / `close timed out after
 * 30000ms` / `something prevents Vite server from exiting`. The cause is a
 * teardown leak: several test files leave a listening TCP server (an
 * `http`/`net.Server`) open after their own cleanup has run. Because vitest's
 * `forks` pool reuses worker processes across files, those native handles
 * accumulate; at end-of-run vitest force-terminates workers whose event loops
 * won't drain. On the slow, contended macOS runners that force-termination
 * exceeds the teardown budget → the flake. A listening server never
 * self-closes, so it is held for the entire window — which is why simply
 * widening `teardownTimeout` never fixed it (you cannot out-wait a permanent
 * handle).
 *
 * This guard runs LAST in every file's teardown (setup-file hooks register
 * before the test file body, so their `afterAll` runs AFTER the file's own
 * `afterEach`/`afterAll`). If a file left any listening server open, it:
 *   - destroys the server's live connections and closes it, so the worker's
 *     event loop can drain and the run exits cleanly, and
 *   - `unref()`s any lingering timer on that same (already-misbehaving) file so
 *     a stray interval cannot independently hold the loop open.
 * It then writes a `[leak-guard]` line to stderr naming the file so the real
 * per-test cleanup can be added. See the `project-vitest-worker-exit-flake`
 * note. (stderr, not `console.warn`, because vitest's console capture swallows
 * hook-level `console` output on a passing run.)
 *
 * Safety: it only ever acts AFTER a file's own tests and teardown have run, and
 * only on files that actually leaked a server. vitest's worker RPC uses stdio
 * pipes (not a `net.Server` and not a keep-alive timer), so nothing
 * framework-owned is touched. Well-behaved files are a pure no-op.
 */
import { afterAll, expect } from 'vitest';

interface ClosableServer {
  close(): void;
  closeAllConnections?(): void;
}

function activeHandles(): unknown[] {
  return (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
}

/** Realm-agnostic constructor name for an arbitrary active handle (or undefined). */
function ctorName(handle: unknown): string | undefined {
  if (typeof handle !== 'object' || handle === null) return undefined;
  return (handle as { constructor?: { name?: string } }).constructor?.name;
}

/**
 * A leaked listening `net`/`http`/`tls.Server`. Identified by constructor name
 * rather than `instanceof` because vitest's forks isolation can hand the setup
 * file a different `node:net` module identity than the test used, which breaks
 * `instanceof` across the boundary. All three server classes expose `.close()`;
 * the name check plus a `.close` typeof guard is realm-agnostic and precise
 * (`ws`'s `WebSocketServer` has a different constructor name and is skipped —
 * its underlying `http.Server` is the handle we actually close).
 */
function isListeningServer(handle: unknown): handle is ClosableServer {
  return ctorName(handle) === 'Server' && typeof (handle as { close?: unknown }).close === 'function';
}

function currentTestFile(): string {
  try {
    return (expect.getState().testPath ?? 'unknown').replace(/.*\/(test|src)\//, '$1/');
  } catch {
    return 'unknown';
  }
}

afterAll(() => {
  const handles = activeHandles();
  const leakedServers = handles.filter(isListeningServer);
  // Only intervene when a listening server actually leaked — the persistent,
  // never-self-closing handle behind the flake. Leave well-behaved files (whose
  // only active handle is vitest's own worker RPC pipe + baseline timer) alone.
  if (leakedServers.length === 0) return;

  for (const server of leakedServers) {
    try {
      server.closeAllConnections?.();
      server.close();
    } catch {
      // already closing / closed — nothing to do
    }
  }

  let unrefdTimers = 0;
  for (const handle of handles) {
    if (ctorName(handle) === 'Timeout') {
      try {
        (handle as { unref?: () => void }).unref?.();
        unrefdTimers += 1;
      } catch {
        // ignore
      }
    }
  }

  process.stderr.write(
    `[leak-guard] ${currentTestFile()}: closed ${leakedServers.length} leaked server(s)` +
      `${unrefdTimers ? `, unref'd ${unrefdTimers} timer(s)` : ''} at teardown ` +
      `(run stays green; add explicit cleanup — see test/setup/handle-leak-guard.ts).\n`,
  );
});
