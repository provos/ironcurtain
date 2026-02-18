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
    console.log('\n=== Agent Response ===');
    console.log(response);
  }

  private async runInteractive(session: Session): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr, // Prompts to stderr, responses to stdout
    });

    console.error('IronCurtain interactive mode. Type /quit to exit.\n');
    console.error('Commands: /quit /logs /approve /deny\n');

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
        console.error('  (still processing previous message, please wait)');
        return;
      }

      messageInFlight = true;
      try {
        const response = await session.sendMessage(trimmed);
        console.log(response);
        console.log();
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        messageInFlight = false;
      }
    }

    rl.on('line', (line) => {
      if (running) {
        processLine(line).catch((err) => {
          console.error(`Unexpected error: ${err}`);
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
      console.error('  (no diagnostic events yet)');
      return;
    }

    for (const event of logs) {
      switch (event.kind) {
        case 'tool_call':
          console.error(`  [tool] ${event.toolName}: ${event.preview}`);
          break;
        case 'agent_text':
          console.error(`  [agent] ${event.preview}`);
          break;
        case 'step_finish':
          console.error(`  [step] ${event.stepIndex} completed`);
          break;
      }
    }
  }

  private handleEscalationCommand(command: string, session: Session): void {
    const pending = session.getPendingEscalation();
    if (!pending) {
      console.error('  No escalation pending.');
      return;
    }

    const decision = command === '/approve' ? 'approved' as const : 'denied' as const;
    session.resolveEscalation(pending.escalationId, decision)
      .then(() => {
        console.error(`  Escalation ${decision}.`);
      })
      .catch((err) => {
        console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}
