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

  constructor(path: string, options?: AuditLogOptions) {
    this.stream = createWriteStream(path, { flags: 'a' });
    this.redact = options?.redact ?? false;
  }

  log(entry: AuditEntry): void {
    const toWrite = this.redact ? redactAuditEntry(entry) : entry;
    this.stream.write(JSON.stringify(toWrite) + '\n');
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
