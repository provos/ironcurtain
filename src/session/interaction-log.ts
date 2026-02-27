import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export interface InteractionEntry {
  timestamp: string;
  sessionId: string;
  turnNumber: number;
  role: 'user' | 'assistant';
  content: string;
}

export class InteractionLog {
  private stream: WriteStream;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'a' });
  }

  log(entry: InteractionEntry): void {
    if (!this.stream.destroyed) {
      this.stream.write(JSON.stringify(entry) + '\n');
    }
  }

  async close(): Promise<void> {
    if (this.stream.destroyed || this.stream.closed) {
      return;
    }
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
