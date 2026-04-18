/**
 * Tests for AuditLog stream-error handling.
 *
 * `createWriteStream` defers the actual `open(2)` until the event loop
 * spins, so open failures (ENOENT from a missing parent dir, ENOSPC,
 * EACCES, etc.) surface asynchronously as an `'error'` event. Without a
 * listener the process crashes. These tests pin down the contract:
 *
 *   - `log()` after an async open failure throws synchronously with a
 *     message that mentions the underlying stream error.
 *   - `close()` after an error is idempotent and never throws.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/trusted-process/audit-log.js';
import type { AuditEntry } from '../src/types/audit.js';

function makeEntry(): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    requestId: 'req-1',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: '/tmp/x' },
    policyDecision: { decision: 'allow', reason: 'test' },
    result: { status: 'success' },
    durationMs: 1,
  };
}

/**
 * Waits until an async open(2) against `path` would have resolved. We
 * open a probe stream to the same path and await its `'error'` event
 * (or, in the open-success case, its `'open'` event). This is
 * deterministic regardless of event-loop pressure from other
 * concurrently-running test suites, unlike `setImmediate` polling.
 */
async function waitForOpenResolution(path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const probe = createWriteStream(path, { flags: 'a' });
    probe.once('error', () => resolve());
    probe.once('open', () => {
      probe.close();
      resolve();
    });
  });
}

describe('AuditLog stream-error handling', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('log() throws synchronously after the stream fails to open', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    // Parent directory does not exist -> open(2) will fail with ENOENT,
    // emitted as an async `'error'` event on the stream.
    const badPath = join(tmpDir, 'missing-parent', 'audit.jsonl');

    const log = new AuditLog(badPath);
    await waitForOpenResolution(badPath);
    // One more microtask to let the AuditLog's internal 'error' handler run.
    await new Promise((r) => setImmediate(r));

    expect(() => log.log(makeEntry())).toThrow(/AuditLog stream error/);
    // The thrown message MUST include the underlying error text so
    // operators can diagnose the failure (e.g., "ENOENT").
    expect(() => log.log(makeEntry())).toThrow(/ENOENT/);

    // close() must remain idempotent even when the stream errored.
    await expect(log.close()).resolves.toBeUndefined();
    // Second close() is a no-op and also does not throw.
    await expect(log.close()).resolves.toBeUndefined();
  });

  it('close() does not throw when the stream errored before any log()', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-err-'));
    const badPath = join(tmpDir, 'missing-parent', 'audit.jsonl');

    const log = new AuditLog(badPath);
    await waitForOpenResolution(badPath);
    // One more microtask to let the AuditLog's internal 'error' handler run.
    await new Promise((r) => setImmediate(r));

    // close() before any log() -- the stream opened and failed; close()
    // should short-circuit instead of trying to end a destroyed stream.
    await expect(log.close()).resolves.toBeUndefined();
  });
});
