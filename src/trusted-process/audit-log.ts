import { createWriteStream, type WriteStream } from 'node:fs';
import type { AuditEntry } from '../types/audit.js';
import { redactObject } from './audit-redactor.js';

export interface AuditLogOptions {
  /** When true, PII/credential patterns are redacted before writing. */
  redact?: boolean;
}

/**
 * Append-only JSONL writer for audit entries.
 *
 * Each coordinator owns exactly one `AuditLog` targeting a single file
 * for its entire lifetime. Workflow runs write one file per run
 * (entries tagged with `persona` so consumers can slice by re-entry);
 * single-session modes write one file per session. There is no rotate
 * path — policy hot-swap only updates `currentPersona` on the
 * coordinator and all entries continue to land in the same file.
 */
export class AuditLog {
  private readonly stream: WriteStream;
  private readonly redact: boolean;
  private closed = false;
  // Latched stream error. `createWriteStream` defers the actual `open(2)`
  // until the event loop spins, so ENOSPC / EACCES / missing-parent-dir
  // failures surface asynchronously as an `'error'` event. Without a
  // listener, Node would crash the process; we latch the error instead
  // and re-throw on the next `log()` so the caller sees a synchronous
  // failure at the write site.
  private streamError: Error | null = null;

  constructor(path: string, options?: AuditLogOptions) {
    this.stream = createWriteStream(path, { flags: 'a' });
    this.stream.on('error', (err: Error) => {
      this.streamError = err;
    });
    this.redact = options?.redact ?? false;
  }

  /**
   * Appends a single audit entry to the current stream.
   *
   * A trusted process that cannot audit is a security violation: we fail
   * loudly rather than silently drop entries. If the underlying stream
   * has surfaced an `'error'` event (open failed, disk full, etc.) we
   * throw here so the caller stops processing tool calls.
   *
   * @throws if called after `close()` (writes to an ended stream would
   *   surface asynchronously as `'write after end'`).
   * @throws if the stream has emitted an `'error'` event at any point.
   */
  log(entry: AuditEntry): void {
    if (this.closed) {
      throw new Error('AuditLog.log() called after close()');
    }
    if (this.streamError) {
      throw new Error(`AuditLog stream error: ${this.streamError.message}`);
    }
    const toWrite = this.redact ? redactAuditEntry(entry) : entry;
    this.stream.write(JSON.stringify(toWrite) + '\n');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // If the stream errored, `end()` may not settle cleanly (the stream
    // may already be destroyed). Short-circuit the await so `close()`
    // stays idempotent and never throws in teardown paths.
    if (this.streamError) return;
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
