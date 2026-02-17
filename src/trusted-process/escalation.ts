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

  async prompt(request: ToolCallRequest, reason: string): Promise<'approved' | 'denied'> {
    const rl = this.getReadline();

    console.error('\n========================================');
    console.error('  ESCALATION: Human approval required');
    console.error('========================================');
    console.error(`  Tool:      ${request.serverName}/${request.toolName}`);
    console.error(`  Arguments: ${JSON.stringify(request.arguments, null, 2)}`);
    console.error(`  Reason:    ${reason}`);
    console.error('========================================');

    return new Promise((resolve) => {
      rl.question('  Approve? (y/N): ', (answer) => {
        const approved = answer.trim().toLowerCase() === 'y';
        console.error(approved ? '  -> APPROVED' : '  -> DENIED');
        console.error('========================================\n');
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
