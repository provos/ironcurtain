/**
 * CLI transport -- reads from stdin, writes to stdout/stderr.
 *
 * Supports two modes:
 * - Single-shot: if initialMessage is provided, sends it and returns
 * - Interactive: event-driven REPL with slash commands
 *
 * Provides a rich terminal experience:
 * - Spinner (via ora) during message processing
 * - Colored prompts and status messages (via chalk)
 * - Markdown-rendered agent responses (via marked + marked-terminal)
 *
 * Slash commands:
 *   /quit, /exit  -- end the session
 *   /logs         -- display accumulated diagnostic events
 *   /budget       -- show resource budget usage
 *   /approve      -- approve a pending escalation
 *   /deny         -- deny a pending escalation
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import ora from 'ora';
import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { Ora } from 'ora';
import { BaseTransport } from './base-transport.js';
import type { Session, DiagnosticEvent, EscalationRequest, BudgetStatus } from './types.js';

/** Options for constructing a CliTransport. */
export interface CliTransportOptions {
  /** If provided, run in single-shot mode with this message. */
  initialMessage?: string;
  /** Override stdin for testing. Defaults to process.stdin. */
  input?: Readable;
}

// Configure marked to render markdown for the terminal.
// This is module-level since marked is a singleton.
marked.use(markedTerminal());

export class CliTransport extends BaseTransport {
  private readonly initialMessage?: string;
  private readonly input: Readable;

  /** The spinner instance, managed across the message lifecycle. */
  private spinner: Ora | null = null;

  /** The readline interface, stored so escalation handlers can re-prompt. */
  private rl: ReturnType<typeof createInterface> | null = null;

  constructor(options: CliTransportOptions = {}) {
    super();
    this.initialMessage = options.initialMessage;
    this.input = options.input ?? process.stdin;
  }

  protected async runSession(session: Session): Promise<void> {
    if (this.initialMessage) {
      return this.runSingleShot(session);
    }
    return this.runInteractive(session);
  }

  /**
   * Signals the transport to stop: closes readline (unblocking runInteractive)
   * and stops any active spinner.
   */
  close(): void {
    if (this.spinner?.isSpinning) {
      this.spinner.stop();
    }
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Returns an onDiagnostic callback that updates the spinner.
   * Wire this into SessionOptions so the transport controls display.
   */
  createDiagnosticHandler(): (event: DiagnosticEvent) => void {
    return (event) => {
      if (!this.spinner?.isSpinning) return;

      switch (event.kind) {
        case 'tool_call':
          this.spinner.text = 'Executing code...';
          break;
        case 'agent_text':
          this.spinner.text = 'Generating response...';
          break;
        case 'budget_warning':
          this.spinner.text = chalk.yellow(`Budget warning: ${event.message}`);
          break;
        case 'budget_exhausted':
          this.spinner.fail(chalk.red(`Budget exhausted: ${event.message}`));
          break;
        case 'message_compaction':
          this.spinner.text = 'Compacting conversation history...';
          break;
      }
    };
  }

  /**
   * Returns an onEscalationExpired callback that clears the escalation
   * banner and notifies the user that the proxy timed out.
   */
  createEscalationExpiredHandler(): () => void {
    return () => {
      process.stderr.write(chalk.yellow('  Escalation expired (timed out).\n'));
      this.startSpinner('Processing...');
    };
  }

  /**
   * Returns an onEscalation callback that stops the spinner and
   * shows an escalation banner with the readline prompt so the user
   * can type /approve or /deny. The spinner is restarted only after
   * the user resolves the escalation (see handleEscalationCommand).
   */
  createEscalationHandler(): (request: EscalationRequest) => void {
    return (request) => {
      if (this.spinner?.isSpinning) {
        this.spinner.stop();
      }

      this.writeEscalationBanner(request);

      // Re-show the readline prompt so the user can type /approve or /deny
      if (this.rl) {
        this.rl.prompt();
      }
    };
  }

  // --- Single-shot mode ---

  private async runSingleShot(session: Session): Promise<void> {
    this.startSpinner('Thinking...');

    try {
      if (!this.initialMessage) throw new Error('runSingleShot called without initialMessage');
      const response = await this.sendAndLog(session, this.initialMessage);
      this.spinner?.stop();
      process.stdout.write('\n');
      process.stdout.write(renderMarkdown(response));
      this.displaySessionSummary(session.getBudgetStatus());
    } catch (error) {
      this.stopSpinnerWithError(error);
      throw error;
    }
  }

  // --- Interactive mode ---

  private async runInteractive(session: Session): Promise<void> {
    this.rl = createInterface({
      input: this.input,
      output: process.stderr, // Prompts to stderr, responses to stdout
      prompt: chalk.cyan('> '),
    });
    const rl = this.rl;

    process.stderr.write(chalk.dim('IronCurtain interactive mode. Type /quit to exit.\n\n'));
    process.stderr.write(chalk.dim('Commands: /quit /logs /budget /approve /deny\n\n'));
    rl.prompt();

    let running = true;
    let messageInFlight = false;

    const processLine = async (input: string): Promise<void> => {
      const trimmed = input.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      if (
        this.handleSlashCommand(trimmed, session, () => {
          running = false;
          rl.close();
        })
      ) {
        if (running) rl.prompt();
        return;
      }

      if (messageInFlight) {
        process.stderr.write(chalk.dim('  (still processing previous message, please wait)\n'));
        rl.prompt();
        return;
      }

      messageInFlight = true;
      this.startSpinner('Thinking...');

      try {
        const response = await this.sendAndLog(session, trimmed);
        this.spinner?.stop();
        process.stdout.write('\n');
        process.stdout.write(renderMarkdown(response));
        process.stdout.write('\n');
      } catch (error) {
        this.stopSpinnerWithError(error);
      } finally {
        messageInFlight = false;
        if (running) rl.prompt();
      }
    };

    rl.on('line', (line) => {
      if (running) {
        processLine(line).catch((err: unknown) => {
          process.stderr.write(chalk.red(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`));
        });
      }
    });

    // When readline is active on a TTY, Ctrl-C is intercepted at the raw
    // stream level and never reaches process-level SIGINT handlers.
    // We must re-emit SIGINT so the shutdown handler in index.ts fires.
    rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });

    await new Promise<void>((resolvePromise) => {
      rl.on('close', () => {
        this.rl = null;
        resolvePromise();
      });
    });

    this.displaySessionSummary(session.getBudgetStatus());
  }

  // --- Slash commands ---

  /**
   * Handles slash commands. Returns true if the input was a command,
   * false if it should be treated as a regular message.
   */
  private handleSlashCommand(input: string, session: Session, onQuit: () => void): boolean {
    switch (input) {
      case '/quit':
      case '/exit':
        onQuit();
        return true;

      case '/logs':
        this.displayDiagnosticLog(session.getDiagnosticLog());
        return true;

      case '/budget':
        this.displayBudgetStatus(session.getBudgetStatus());
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
      process.stderr.write(chalk.dim('  (no diagnostic events yet)\n'));
      return;
    }

    for (const event of logs) {
      switch (event.kind) {
        case 'tool_call':
          process.stderr.write(chalk.dim(`  [tool] ${event.toolName}: ${event.preview}\n`));
          break;
        case 'agent_text':
          process.stderr.write(chalk.dim(`  [agent] ${event.preview}\n`));
          break;
        case 'budget_warning':
          process.stderr.write(chalk.yellow(`  [budget] ${event.message}\n`));
          break;
        case 'budget_exhausted':
          process.stderr.write(chalk.red(`  [budget] ${event.message}\n`));
          break;
        case 'message_compaction':
          process.stderr.write(
            chalk.dim(`  [compact] ${event.originalMessageCount} → ${event.newMessageCount} messages\n`),
          );
          break;
      }
    }
  }

  private handleEscalationCommand(command: string, session: Session): void {
    const pending = session.getPendingEscalation();
    if (!pending) {
      process.stderr.write(chalk.dim('  No escalation pending.\n'));
      return;
    }

    const decision = command === '/approve' ? ('approved' as const) : ('denied' as const);
    session
      .resolveEscalation(pending.escalationId, decision)
      .then(() => {
        const color = decision === 'approved' ? chalk.green : chalk.red;
        process.stderr.write(color(`  Escalation ${decision}.\n`));
        // Restart the spinner — sendMessage() is still in-flight, waiting
        // for the proxy to process the escalation result and continue.
        this.startSpinner('Processing...');
      })
      .catch((err: unknown) => {
        process.stderr.write(chalk.red(`  Error: ${err instanceof Error ? err.message : String(err)}\n`));
      });
  }

  // --- Budget display ---

  private displayBudgetStatus(status: BudgetStatus): void {
    const { limits, cumulative } = status;
    process.stderr.write(chalk.cyan('  Current turn budget:\n'));
    if (status.tokenTrackingAvailable) {
      process.stderr.write(
        formatBudgetLine('Tokens', status.totalTokens, limits.maxTotalTokens, (v) => v.toLocaleString()),
      );
    } else {
      process.stderr.write(`    Tokens: N/A\n`);
    }
    process.stderr.write(formatBudgetLine('Steps', status.stepCount, limits.maxSteps, String));
    process.stderr.write(
      formatBudgetLine('Time', status.elapsedSeconds, limits.maxSessionSeconds, (v) => `${Math.round(v)}s`),
    );
    process.stderr.write(
      formatBudgetLine('Est. cost', status.estimatedCostUsd, limits.maxEstimatedCostUsd, (v) => `$${v.toFixed(2)}`),
    );
    process.stderr.write(chalk.cyan('  Session totals:\n'));
    if (status.tokenTrackingAvailable) {
      process.stderr.write(`    Tokens: ${cumulative.totalTokens.toLocaleString()}\n`);
    } else {
      process.stderr.write(`    Tokens: N/A\n`);
    }
    process.stderr.write(`    Steps: ${cumulative.stepCount}\n`);
    process.stderr.write(`    Active time: ${Math.round(cumulative.activeSeconds)}s\n`);
    process.stderr.write(`    Est. cost: $${cumulative.estimatedCostUsd.toFixed(2)}\n`);
  }

  private displaySessionSummary(status: BudgetStatus): void {
    const { cumulative } = status;
    const tokensPart = status.tokenTrackingAvailable ? `${cumulative.totalTokens.toLocaleString()} tokens · ` : '';
    process.stderr.write(
      chalk.dim(
        `\nSession: ${tokensPart}` +
          `${cumulative.stepCount} steps` +
          ` · ${Math.round(cumulative.activeSeconds)}s` +
          ` · ~$${cumulative.estimatedCostUsd.toFixed(2)}\n`,
      ),
    );
  }

  // --- Spinner helpers ---

  private startSpinner(text: string): void {
    this.spinner = ora({
      text,
      stream: process.stderr,
      discardStdin: false,
    }).start();
  }

  private stopSpinnerWithError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.spinner?.isSpinning) {
      this.spinner.fail(chalk.red(message));
    } else {
      process.stderr.write(chalk.red(`Error: ${message}\n`));
    }
  }

  // --- Escalation banner ---

  private writeEscalationBanner(request: EscalationRequest): void {
    const border = chalk.yellow.bold('========================================');
    const lines = [
      '',
      border,
      chalk.yellow.bold('  ESCALATION: Human approval required'),
      border,
      chalk.yellow(`  Tool:      ${request.serverName}/${request.toolName}`),
      chalk.yellow(`  Arguments: ${JSON.stringify(request.arguments, null, 2)}`),
      chalk.yellow(`  Reason:    ${request.reason}`),
      border,
      chalk.yellow.bold('  Type /approve or /deny'),
      border,
      '',
    ];
    process.stderr.write(lines.join('\n') + '\n');
  }
}

// --- Budget formatting ---

function formatBudgetLine(label: string, current: number, limit: number | null, format: (v: number) => string): string {
  const currentStr = format(current);
  if (limit === null) return `    ${label}: ${currentStr} (no limit)\n`;
  const pct = limit > 0 ? Math.round((current / limit) * 100) : 0;
  return `    ${label}: ${currentStr} / ${format(limit)} (${pct}%)\n`;
}

// --- Markdown rendering ---

/**
 * Renders a markdown string for terminal display.
 * Returns the formatted string with ANSI codes for colors,
 * bold/italic, syntax-highlighted code blocks, etc.
 */
function renderMarkdown(text: string): string {
  if (!text.trim()) return '';

  // marked.parse() can return string or Promise<string> depending on
  // extensions. With marked-terminal (synchronous), it returns a string.
  const rendered = marked.parse(text);
  if (typeof rendered !== 'string') {
    // Defensive: if somehow async, fall back to raw text
    return text;
  }
  return rendered;
}
