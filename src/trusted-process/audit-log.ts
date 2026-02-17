import { createWriteStream, type WriteStream } from 'node:fs';
import type { AuditEntry } from '../types/audit.js';

export class AuditLog {
  private stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'a' });
  }

  log(entry: AuditEntry): void {
    this.stream.write(JSON.stringify(entry) + '\n');
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
