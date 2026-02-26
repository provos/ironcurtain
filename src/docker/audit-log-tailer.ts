/**
 * Tails a JSONL audit log file and emits DiagnosticEvent callbacks
 * for each new entry. Uses fs.watchFile() for change notification and
 * tracks the file read offset to parse only new lines.
 */

import { openSync, readSync, fstatSync, closeSync, watchFile, unwatchFile } from 'node:fs';
import type { DiagnosticEvent } from '../session/types.js';
import type { AuditEntry } from '../types/audit.js';

export class AuditLogTailer {
  private offset = 0;
  private watching = false;
  private readonly auditLogPath: string;
  private readonly onDiagnostic: (event: DiagnosticEvent) => void;

  constructor(auditLogPath: string, onDiagnostic: (event: DiagnosticEvent) => void) {
    this.auditLogPath = auditLogPath;
    this.onDiagnostic = onDiagnostic;
  }

  start(): void {
    this.watching = true;
    watchFile(this.auditLogPath, { interval: 100 }, () => this.readNewEntries());
  }

  stop(): void {
    if (this.watching) {
      unwatchFile(this.auditLogPath);
      this.watching = false;
    }
  }

  /** Read and process any new entries appended since the last read. */
  readNewEntries(): void {
    let fd: number;
    try {
      fd = openSync(this.auditLogPath, 'r');
    } catch {
      return; // File may not exist yet
    }

    try {
      const stat = fstatSync(fd);
      if (stat.size <= this.offset) return;

      const buf = Buffer.alloc(stat.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = stat.size;

      const lines = buf.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;
          this.onDiagnostic({
            kind: 'tool_call',
            toolName: `${entry.serverName}.${entry.toolName}`,
            preview: this.buildPreview(entry),
          });
        } catch {
          // Ignore malformed lines (partial writes)
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  private buildPreview(entry: AuditEntry): string {
    const status = entry.result.status;
    const args = JSON.stringify(entry.arguments);
    const preview = args.length > 80 ? `${args.substring(0, 80)}...` : args;
    return `[${status}] ${preview}`;
  }
}
