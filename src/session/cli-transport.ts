/**
 * CLI transport -- reads from stdin, writes to stdout/stderr.
 *
 * Supports two modes:
 * - Single-shot: if initialMessage is provided, sends it and returns
 * - Interactive: event-driven REPL with slash commands
 *
 * Slash commands:
 *   /quit, /exit  -- end the session
 *   /logs         -- display accumulated diagnostic events
 *   /approve      -- approve a pending escalation
 *   /deny         -- deny a pending escalation
 */

import { createInterface } from 'node:readline';
import type { Transport } from './transport.js';
import type { Session, DiagnosticEvent } from './types.js';

export class CliTransport implements Transport {
  constructor(private readonly initialMessage?: string) {}

  async run(session: Session): Promise<void> {
    if (this.initialMessage) {
      return this.runSingleShot(session);
    }
    return this.runInteractive(session);
  }

  private async runSingleShot(session: Session): Promise<void> {
    const response = await session.sendMessage(this.initialMessage!);
    process.stdout.write('\n=== Agent Response ===\n');
    process.stdout.write(response + '\n');
  }

  private async runInteractive(session: Session): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr, // Prompts to stderr, responses to stdout
    });

    process.stderr.write('IronCurtain interactive mode. Type /quit to exit.\n\n');
    process.stderr.write('Commands: /quit /logs /approve /deny\n\n');

    let running = true;
    let messageInFlight = false;
    const handleSlashCommand = this.handleSlashCommand.bind(this);

    async function processLine(input: string): Promise<void> {
      const trimmed = input.trim();
      if (!trimmed) return;

      if (handleSlashCommand(trimmed, session, () => {
        running = false;
        rl.close();
      })) {
        return;
      }

      if (messageInFlight) {
        process.stderr.write('  (still processing previous message, please wait)\n');
        return;
      }

      messageInFlight = true;
      try {
        const response = await session.sendMessage(trimmed);
        process.stdout.write(response + '\n');
        process.stdout.write('\n');
      } catch (error) {
        process.stderr.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        messageInFlight = false;
      }
    }

    rl.on('line', (line) => {
      if (running) {
        processLine(line).catch((err) => {
          process.stderr.write(`Unexpected error: ${err}\n`);
        });
      }
    });

    await new Promise<void>((resolvePromise) => {
      rl.on('close', resolvePromise);
    });
  }

  /**
   * Handles slash commands. Returns true if the input was a command,
   * false if it should be treated as a regular message.
   */
  private handleSlashCommand(
    input: string,
    session: Session,
    onQuit: () => void,
  ): boolean {
    switch (input) {
      case '/quit':
      case '/exit':
        onQuit();
        return true;

      case '/logs':
        this.displayDiagnosticLog(session.getDiagnosticLog());
        return true;

      case '/approve':
      case '/deny':
        this.handleEscalationCommand(input, session);
        return true;

      default:
        return false;
    }
  }

  private displayDiagnosticLog(logs: readonly DiagnosticEvent[]): void {
    if (logs.length === 0) {
      process.stderr.write('  (no diagnostic events yet)\n');
      return;
    }

    for (const event of logs) {
      switch (event.kind) {
        case 'tool_call':
          process.stderr.write(`  [tool] ${event.toolName}: ${event.preview}\n`);
          break;
        case 'agent_text':
          process.stderr.write(`  [agent] ${event.preview}\n`);
          break;
      }
    }
  }

  private handleEscalationCommand(command: string, session: Session): void {
    const pending = session.getPendingEscalation();
    if (!pending) {
      process.stderr.write('  No escalation pending.\n');
      return;
    }

    const decision = command === '/approve' ? 'approved' as const : 'denied' as const;
    session.resolveEscalation(pending.escalationId, decision)
      .then(() => {
        process.stderr.write(`  Escalation ${decision}.\n`);
      })
      .catch((err) => {
        process.stderr.write(`  Error: ${err instanceof Error ? err.message : String(err)}\n`);
      });
  }
}
