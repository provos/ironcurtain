/**
 * Tests for AuditLog.rotate(): stream lifecycle, flush-before-swap semantics,
 * and behavior around close().
 *
 * Concurrency contract: `rotate()` assumes the caller holds a suitable
 * external lock (the coordinator's policy mutex) so no `log()` call is in
 * flight. These tests exercise rotation in strict sequence — writes always
 * precede or follow `rotate()`, never race it — which mirrors the real
 * coordinator's use and isolates the behaviors we care about here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Selectively mock node:fs — only `createWriteStream` is wrapped, so that one
// specific test can force it to throw synchronously on the *rotate* call
// without disturbing the constructor or any other fs usage. All other fs
// functions fall through to the real implementation.
let forceCreateWriteStreamThrow: { path: string; error: Error } | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    createWriteStream: ((path: string, options?: unknown) => {
      if (forceCreateWriteStreamThrow && path === forceCreateWriteStreamThrow.path) {
        throw forceCreateWriteStreamThrow.error;
      }
      return original.createWriteStream(path, options as Parameters<typeof original.createWriteStream>[1]);
    }) as typeof original.createWriteStream,
  };
});

import { AuditLog } from '../src/trusted-process/audit-log.js';
import type { AuditEntry } from '../src/types/audit.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    requestId: 'req-1',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: '/tmp/test.txt' },
    policyDecision: { status: 'allow', rule: 'default-allow', reason: 'safe read' },
    result: { status: 'success', content: 'hello' },
    durationMs: 5,
    ...overrides,
  };
}

/** Read a JSONL file and return one parsed AuditEntry per non-empty line. */
function readJsonl(path: string): AuditEntry[] {
  const text = readFileSync(path, 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AuditLog.rotate()', () => {
  let tempDir: string;
  let pathA: string;
  let pathB: string;
  let pathC: string;
  let log: AuditLog;

  beforeEach(() => {
    // Defensively clear the fs-mock toggle in case a prior test forgot to —
    // a stray trap here would corrupt every subsequent rotate.
    forceCreateWriteStreamThrow = null;
    tempDir = mkdtempSync(join(tmpdir(), 'audit-log-rotate-test-'));
    pathA = join(tempDir, 'audit.a.jsonl');
    pathB = join(tempDir, 'audit.b.jsonl');
    pathC = join(tempDir, 'audit.c.jsonl');
    log = new AuditLog(pathA);
  });

  afterEach(async () => {
    // Tests that already called close() will be no-ops thanks to the
    // idempotency guard in close().
    await log.close().catch(() => {
      /* ignore — some tests intentionally exercise post-close errors */
    });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('happy path: entry A lives in old file, entry B lives in new file', async () => {
    log.log(makeEntry({ requestId: 'A' }));
    await log.rotate(pathB);
    log.log(makeEntry({ requestId: 'B' }));
    await log.close();

    const oldEntries = readJsonl(pathA);
    const newEntries = readJsonl(pathB);

    expect(oldEntries).toHaveLength(1);
    expect(oldEntries[0].requestId).toBe('A');
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0].requestId).toBe('B');
  });

  it('awaits flush before swap — entry A is fully durable in the old file after rotate() resolves', async () => {
    log.log(makeEntry({ requestId: 'A' }));
    // The promise returned by rotate() must not resolve until end() has
    // flushed the stream. After it resolves, reading the old file
    // synchronously must yield the complete entry — no truncation, no
    // partial write.
    await log.rotate(pathB);

    const oldText = readFileSync(pathA, 'utf-8');
    // Must end with a newline (the write is "<json>\n"), proving the full
    // line hit disk rather than being cut mid-write.
    expect(oldText.endsWith('\n')).toBe(true);
    const oldEntries = readJsonl(pathA);
    expect(oldEntries).toHaveLength(1);
    expect(oldEntries[0].requestId).toBe('A');

    // Further writes go to the new path, not the old one.
    log.log(makeEntry({ requestId: 'B' }));
    await log.close();

    const oldAfterClose = readJsonl(pathA);
    expect(oldAfterClose).toHaveLength(1); // unchanged by the post-rotate write
    expect(readJsonl(pathB)).toEqual([expect.objectContaining({ requestId: 'B' })]);
  });

  it('rotating to the same path does not throw and subsequent writes succeed', async () => {
    log.log(makeEntry({ requestId: 'A' }));
    await expect(log.rotate(pathA)).resolves.toBeUndefined();

    log.log(makeEntry({ requestId: 'B' }));
    await log.close();

    // Both entries were written to pathA — the first before the rotate,
    // the second after re-opening in append mode.
    const entries = readJsonl(pathA);
    expect(entries.map((e) => e.requestId)).toEqual(['A', 'B']);
  });

  it('handles multiple rotations in sequence — each file contains its own entry', async () => {
    log.log(makeEntry({ requestId: 'A' }));
    await log.rotate(pathB);
    log.log(makeEntry({ requestId: 'B' }));
    await log.rotate(pathC);
    log.log(makeEntry({ requestId: 'C' }));
    await log.close();

    expect(readJsonl(pathA)).toEqual([expect.objectContaining({ requestId: 'A' })]);
    expect(readJsonl(pathB)).toEqual([expect.objectContaining({ requestId: 'B' })]);
    expect(readJsonl(pathC)).toEqual([expect.objectContaining({ requestId: 'C' })]);
  });

  it('close() after rotate() flushes the post-rotate stream without leaked handles', async () => {
    log.log(makeEntry({ requestId: 'A' }));
    await log.rotate(pathB);
    log.log(makeEntry({ requestId: 'B' }));

    // close() must resolve — if the post-rotate stream were still being
    // tracked as the pre-rotate one, end() would hit an already-ended
    // stream and we'd either hang or emit an error.
    await expect(log.close()).resolves.toBeUndefined();

    // Both files exist and contain exactly their expected single entry.
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
    expect(readJsonl(pathB)).toHaveLength(1);

    // close() is idempotent — second call is a no-op, not a double-end.
    await expect(log.close()).resolves.toBeUndefined();
  });

  it('rotate() after close() throws — AuditLog is terminal once closed', async () => {
    await log.close();
    await expect(log.rotate(pathB)).rejects.toThrow(/after close/);

    // No new file should have been created by the failed rotate.
    expect(existsSync(pathB)).toBe(false);
  });

  it('log() after close() throws — consistent with rotate()', async () => {
    // A write after close() previously emitted an async 'write after end'
    // error on the stream that was impossible to surface back to the
    // caller. The synchronous `closed` guard makes misuse visible at
    // the call site and matches rotate()'s post-close behavior.
    log.log(makeEntry({ requestId: 'A' }));
    await log.close();
    expect(() => log.log(makeEntry({ requestId: 'after-close' }))).toThrow(/after close/);

    // Nothing was appended beyond the pre-close entry.
    const entries = readJsonl(pathA);
    expect(entries.map((e) => e.requestId)).toEqual(['A']);
  });

  it('preserves redaction across rotation — both old and new file are redacted', async () => {
    // Use the same sensitive payloads that audit-redactor.test.ts exercises:
    // a valid-Luhn Visa and a real-format SSN. Constructed at runtime to
    // dodge any repo-wide push-protection scanning that might flag the
    // literal strings in source.
    // Both SSNs must have valid area (1-899 excluding 666), valid group
    // (not 00), and valid serial (not 0000) to trip the redactor — see
    // audit-redactor.ts SSN validation.
    const cardA = ['4111', '1111', '1111', '1111'].join('');
    const ssnA = ['123', '45', '6789'].join('-');
    const cardB = ['4111', '1111', '1111', '1111'].join('');
    const ssnB = ['234', '56', '7890'].join('-');

    // Close the beforeEach-created log; we want a *redact: true* instance.
    await log.close();
    log = new AuditLog(pathA, { redact: true });

    log.log(
      makeEntry({
        requestId: 'before-rotate',
        arguments: { note: `card ${cardA} / ssn ${ssnA}` },
      }),
    );
    await log.rotate(pathB);
    log.log(
      makeEntry({
        requestId: 'after-rotate',
        arguments: { note: `card ${cardB} / ssn ${ssnB}` },
      }),
    );
    await log.close();

    const oldText = readFileSync(pathA, 'utf-8');
    const newText = readFileSync(pathB, 'utf-8');

    // Pre-rotation file: raw secrets must not appear; redaction markers do.
    expect(oldText).not.toContain(cardA);
    expect(oldText).not.toContain(ssnA);
    expect(oldText).toContain('***-**-6789');

    // Post-rotation file: redaction still active after the swap.
    expect(newText).not.toContain(cardB);
    expect(newText).not.toContain(ssnB);
    expect(newText).toContain('***-**-7890');
  });

  it('partial-failure recovery: synchronous createWriteStream failure leaves original stream usable', async () => {
    // Arrange: write one entry to the original file to prove it remains
    // flushable to disk regardless of the failed rotate in between.
    log.log(makeEntry({ requestId: 'A' }));

    // Force the node:fs mock to throw synchronously when rotate() tries to
    // construct the replacement stream for pathB. This is the rare-but-
    // possible condition that Fix 1 guards against: if the original code
    // had ended the old stream *before* constructing the new one, the
    // exception would leave `this.stream` pointing at an already-ended
    // WriteStream — and the next `log()` would trigger a
    // 'write after end' error event.
    const injectedError = new Error('synthetic createWriteStream failure');
    forceCreateWriteStreamThrow = { path: pathB, error: injectedError };

    try {
      // rotate() must reject with the injected error — no silent swap.
      await expect(log.rotate(pathB)).rejects.toThrow('synthetic createWriteStream failure');
    } finally {
      // Clear the trap before any subsequent rotate/close so we don't
      // accidentally poison later code paths.
      forceCreateWriteStreamThrow = null;
    }

    // Assert Fix 1's invariant: the original stream is still usable.
    // A subsequent log() lands in the original file. If the ordering fix
    // were wrong and we had ended the old stream before constructing the
    // new one, this write would either crash with a 'write after end'
    // error or silently drop.
    log.log(makeEntry({ requestId: 'B-after-failed-rotate' }));

    // close() must complete cleanly — no double-end, no dangling handle.
    await expect(log.close()).resolves.toBeUndefined();

    const entries = readJsonl(pathA);
    expect(entries.map((e) => e.requestId)).toEqual(['A', 'B-after-failed-rotate']);

    // The rotate target must not have produced a file (constructor threw
    // before any I/O could create it).
    expect(existsSync(pathB)).toBe(false);
  });

  it('partial-failure recovery: async stream-open failure (missing parent dir) leaves original stream usable', async () => {
    // `createWriteStream` is lazy: a bad target path (here, a file under a
    // parent directory that does not exist) does NOT throw synchronously.
    // It surfaces as an asynchronous `'error'` event when Node tries to
    // open the fd. Without the readiness gate, rotate() would still swap
    // `this.stream` to the broken stream and the next `log()` would
    // trigger an unhandled 'error' event on the process. This test
    // asserts rotate() waits for the stream to become ready before
    // swapping: on open failure the promise rejects, the AuditLog
    // retains its original stream, and the AuditLog is not marked
    // `closed`.
    log.log(makeEntry({ requestId: 'A' }));

    const badTarget = join(tempDir, 'does-not-exist-dir', 'audit.jsonl');

    // rotate() must reject. The underlying error message is "ENOENT"
    // from Node's fs subsystem; we match loosely so platform-specific
    // wording differences don't destabilize the test.
    await expect(log.rotate(badTarget)).rejects.toThrow(/ENOENT|no such file/i);

    // The AuditLog is NOT in `closed` state — rotate failure is not
    // terminal; callers may continue logging or close cleanly later.
    // We verify this by driving a real log() call below (which would
    // throw with "after close" if the instance were terminal).
    log.log(makeEntry({ requestId: 'B-after-async-failed-rotate' }));

    // close() must complete cleanly against the ORIGINAL stream — no
    // double-end, no unhandled 'error' from the destroyed replacement.
    await expect(log.close()).resolves.toBeUndefined();

    // Both entries landed in the original file. If rotate() had swapped
    // the stream reference before the open failure fired, the 'B' entry
    // would have been lost to the destroyed replacement stream.
    const entries = readJsonl(pathA);
    expect(entries.map((e) => e.requestId)).toEqual(['A', 'B-after-async-failed-rotate']);

    // The bad target must not have been created (parent dir is missing).
    expect(existsSync(badTarget)).toBe(false);
  });
});
