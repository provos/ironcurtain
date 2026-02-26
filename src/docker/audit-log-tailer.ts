/**
 * Tails a JSONL audit log file and emits DiagnosticEvent callbacks
 * for each new entry. Uses fs.watch() for change notification and
 * tracks the file read offset to parse only new lines.
 */

import { openSync, readSync, fstatSync, closeSync, watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import type { DiagnosticEvent } from '../session/types.js';
import type { AuditEntry } from '../types/audit.js';

export class AuditLogTailer {
  private offset = 0;
  private watcher: FSWatcher | null = null;
  private readonly auditLogPath: string;
  private readonly onDiagnostic: (event: DiagnosticEvent) => void;

  constructor(auditLogPath: string, onDiagnostic: (event: DiagnosticEvent) => void) {
    this.auditLogPath = auditLogPath;
    this.onDiagnostic = onDiagnostic;
  }

  start(): void {
    // Watch the parent directory rather than the file directly.
    // On macOS, fs.watch() on a file uses kqueue which can miss events;
    // watching the directory via FSEvents is more reliable cross-platform.
    const dir = dirname(this.auditLogPath);
    const filename = basename(this.auditLogPath);
    this.watcher = watch(dir, (_eventType, watchedFilename) => {
      // Some platforms omit the filename or return a Buffer; conservatively
      // assume the audit log may have changed in those cases.
      const changed = typeof watchedFilename === 'string' ? watchedFilename : (watchedFilename?.toString() ?? null);
      if (!changed || changed === filename) {
        this.readNewEntries();
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private readNewEntries(): void {
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
