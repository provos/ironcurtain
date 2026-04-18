import { createWriteStream, type WriteStream } from 'node:fs';
import type { AuditEntry } from '../types/audit.js';
import { redactObject } from './audit-redactor.js';

export interface AuditLogOptions {
  /** When true, PII/credential patterns are redacted before writing. */
  redact?: boolean;
}

export class AuditLog {
  private stream: WriteStream;
  private readonly redact: boolean;
  private closed = false;

  constructor(path: string, options?: AuditLogOptions) {
    this.stream = createWriteStream(path, { flags: 'a' });
    this.redact = options?.redact ?? false;
  }

  log(entry: AuditEntry): void {
    const toWrite = this.redact ? redactAuditEntry(entry) : entry;
    this.stream.write(JSON.stringify(toWrite) + '\n');
  }

  /**
   * Redirect subsequent writes to `newPath`. Opens the new stream with
   * `flags: 'a'` — the same options the constructor uses — *before* ending
   * the current one, so that a synchronous failure constructing the new
   * stream (e.g. bad path arg) leaves the original stream intact and the
   * `AuditLog` still usable. Only once the new stream is successfully
   * constructed do we flush and close the old one, awaiting its `end()`
   * callback so kernel-buffered writes hit disk.
   *
   * Rotating to the same path the log is already open on is safe: for a
   * brief window both streams are open in append mode on the same inode.
   * POSIX guarantees that `write()` calls against an O_APPEND fd are
   * atomic at the syscall level, so their output does not interleave —
   * the tail of the old stream and the head of the new append cleanly.
   *
   * Concurrency contract: the caller must serialize `log()`, `rotate()`,
   * and `close()` externally — no two of these methods may be in flight
   * concurrently. The coordinator's policy mutex provides this guarantee
   * in production.
   *
   * Flush guarantee: on resolve, the old stream's buffered writes have been
   * flushed to the OS page cache (not `fsync`'d to disk); this is
   * sufficient for in-process and intra-host reads but not for
   * crash-resilience against power loss.
   *
   * Parent directory of `newPath` must already exist — mirrors constructor
   * behavior (the constructor does not create parents, and neither does this).
   *
   * @throws if called after `close()`. An `AuditLog` that has been closed
   *   cannot be rotated back open; construct a new instance instead.
   */
  async rotate(newPath: string): Promise<void> {
    if (this.closed) {
      throw new Error('AuditLog.rotate() called after close()');
    }
    // Construct the replacement stream first. If createWriteStream throws
    // synchronously (e.g. invalid path), `this.stream` still points at the
    // original, usable stream — callers can keep logging or close cleanly.
    const next = createWriteStream(newPath, { flags: 'a' });
    await endStream(this.stream);
    this.stream = next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await endStream(this.stream);
  }
}

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Redacts PII/credential patterns from an audit entry's arguments
 * and result content. Metadata fields (timestamps, tool names,
 * policy decisions) are never modified.
 */
function redactAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    arguments: redactObject(entry.arguments),
    result: {
      ...entry.result,
      content: entry.result.content !== undefined ? redactObject(entry.result.content) : undefined,
      error: entry.result.error !== undefined ? redactObject(entry.result.error) : undefined,
    },
  };
}
