import { createInterface, type Interface } from 'node:readline';
import type { ToolCallRequest } from '../types/mcp.js';

export class EscalationHandler {
  private rl: Interface | null = null;

  private getReadline(): Interface {
    if (!this.rl) {
      this.rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
    }
    return this.rl;
  }

  async prompt(
    request: ToolCallRequest,
    reason: string,
    context?: Readonly<Record<string, string>>,
  ): Promise<'approved' | 'denied'> {
    const rl = this.getReadline();

    process.stderr.write('\n========================================\n');
    process.stderr.write('  ESCALATION: Human approval required\n');
    process.stderr.write('========================================\n');
    process.stderr.write(`  Tool:      ${request.serverName}/${request.toolName}\n`);
    process.stderr.write(`  Arguments: ${JSON.stringify(request.arguments, null, 2)}\n`);
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        process.stderr.write(`  ${k}: ${v}\n`);
      }
    }
    process.stderr.write(`  Reason:    ${reason}\n`);
    process.stderr.write('========================================\n');

    return new Promise((resolve) => {
      rl.question('  Approve? (y/N): ', (answer) => {
        const approved = answer.trim().toLowerCase() === 'y';
        process.stderr.write(approved ? '  -> APPROVED\n' : '  -> DENIED\n');
        process.stderr.write('========================================\n\n');
        resolve(approved ? 'approved' : 'denied');
      });
    });
  }

  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
