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

  constructor(path: string, options?: AuditLogOptions) {
    this.stream = createWriteStream(path, { flags: 'a' });
    this.redact = options?.redact ?? false;
  }

  /**
   * Appends a single audit entry to the current stream.
   *
   * @throws if called after `close()`. Writing to an ended stream would
   *   trigger Node's "write after end" error event asynchronously,
   *   which is hard to surface to the caller. Throwing synchronously
   *   here surfaces the misuse at the call site.
   */
  log(entry: AuditEntry): void {
    if (this.closed) {
      throw new Error('AuditLog.log() called after close()');
    }
    const toWrite = this.redact ? redactAuditEntry(entry) : entry;
    this.stream.write(JSON.stringify(toWrite) + '\n');
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
