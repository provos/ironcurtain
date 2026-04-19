import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEntry } from '../types/audit.js';
import { redactObject } from './audit-redactor.js';

export interface AuditLogOptions {
  /** When true, PII/credential patterns are redacted before writing. */
  redact?: boolean;
}

/**
 * Append-only JSONL writer for audit entries.
 *
 * Writes are synchronous (`appendFileSync`) for two reasons: durability
 * and read-after-write determinism. An async `WriteStream` buffers
 * chunks and flushes them on the event loop; on fast machines (the CI
 * ubuntu-latest runner being the motivating case) the test/inspection
 * code can call `readFileSync(auditPath)` before the last write has
 * reached disk. More importantly, a process crash between a policy
 * decision and the next flush would silently drop the audit entry for
 * that decision — the exact window where durability matters most. The
 * sibling logger (`src/logger.ts`) uses the same pattern for the same
 * reason. Since `rotate()` was removed in the coordinator redesign,
 * this class's only remaining job is one append per tool call, which
 * does not justify the async buffering machinery.
 *
 * Each coordinator owns exactly one `AuditLog` targeting a single file
 * for its entire lifetime. Workflow runs write one file per run
 * (entries tagged with `persona` so consumers can slice by re-entry);
 * single-session modes write one file per session. Policy hot-swap
 * only updates `currentPersona` on the coordinator and all entries
 * continue to land in the same file.
 */
export class AuditLog {
  private readonly path: string;
  private readonly redact: boolean;
  private closed = false;
  // Latched write error. Once any `appendFileSync` has failed (ENOSPC,
  // EACCES, missing parent dir that was deleted mid-session, etc.) we
  // stop attempting further writes and rethrow the cached error on
  // every subsequent `log()` call. This preserves the "fail-closed"
  // invariant: a trusted process that cannot audit must stop
  // processing tool calls, and must report the same root-cause error
  // each time it's asked to audit afterwards.
  private streamError: Error | null = null;

  constructor(path: string, options?: AuditLogOptions) {
    this.path = path;
    // Match the old `createWriteStream` behavior of auto-creating the
    // parent directory for common session/workflow layouts. If this
    // itself fails (e.g., a path component is a file), we latch the
    // error so the first `log()` rethrows it synchronously — the
    // caller experiences the same fail-closed contract either way.
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      this.streamError = err instanceof Error ? err : new Error(String(err));
    }
    this.redact = options?.redact ?? false;
  }

  /**
   * Appends a single audit entry to the log file.
   *
   * A trusted process that cannot audit is a security violation: we
   * fail loudly rather than silently drop entries. If a previous write
   * failed, we rethrow the cached error without attempting a new write
   * so the caller sees a deterministic, idempotent failure surface.
   *
   * @throws if called after `close()`.
   * @throws if any previous write (or the ctor's `mkdirSync`) failed.
   * @throws if this write fails (ENOSPC, EACCES, etc.).
   */
  log(entry: AuditEntry): void {
    if (this.closed) {
      throw new Error('AuditLog.log() called after close()');
    }
    if (this.streamError) {
      throw new Error(`AuditLog stream error: ${this.streamError.message}`);
    }
    const toWrite = this.redact ? redactAuditEntry(entry) : entry;
    try {
      appendFileSync(this.path, JSON.stringify(toWrite) + '\n');
    } catch (err) {
      this.streamError = err instanceof Error ? err : new Error(String(err));
      throw new Error(`AuditLog stream error: ${this.streamError.message}`, {
        cause: err,
      });
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    // Synchronous writes have nothing to flush and no fd to release.
    // Returns a promise purely for API compatibility with the existing
    // coordinator teardown path, which `await`s this call.
    return Promise.resolve();
  }
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
