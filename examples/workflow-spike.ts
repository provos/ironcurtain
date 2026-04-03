/* eslint-disable */
/**
 * Interactive spike script that exercises the workflow orchestrator
 * with mock sessions and interactive human gate prompts.
 *
 * Run with: npx tsx examples/workflow-spike.ts
 */
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import type {
  SessionId,
  SessionOptions,
  SessionInfo,
  BudgetStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
} from '../src/session/types.js';
import type { Session } from '../src/session/types.js';
import type { WorkflowId, HumanGateRequest, HumanGateEventType } from '../src/workflow/types.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
  type WorkflowLifecycleEvent,
} from '../src/workflow/orchestrator.js';

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const WHITE = '\x1b[37m';
const BG_YELLOW = '\x1b[43m';
const BLACK = '\x1b[30m';

// ---------------------------------------------------------------------------
// MockSession
// ---------------------------------------------------------------------------

type ResponseFactory = (msg: string) => string;

/**
 * Lightweight session mock. On each `sendMessage`, calls the response
 * factory and then runs an optional side-effect callback (used to
 * write artifact files the orchestrator expects).
 */
export class MockSession implements Session {
  readonly sentMessages: string[] = [];
  closed = false;
  private readonly sessionId: string;
  private readonly responseFn: ResponseFactory;
  private readonly afterSend?: () => void;

  constructor(opts: { sessionId?: string; responseFn: ResponseFactory; afterSend?: () => void }) {
    this.sessionId = opts.sessionId ?? `mock-${Math.random().toString(36).slice(2, 8)}`;
    this.responseFn = opts.responseFn;
    this.afterSend = opts.afterSend;
  }

  getInfo(): SessionInfo {
    return {
      id: this.sessionId as SessionId,
      status: this.closed ? 'closed' : 'ready',
      turnCount: this.sentMessages.length,
      createdAt: new Date().toISOString(),
    };
  }

  async sendMessage(msg: string): Promise<string> {
    this.sentMessages.push(msg);
    const response = this.responseFn(msg);
    this.afterSend?.();
    return response;
  }

  getHistory(): readonly ConversationTurn[] {
    return [];
  }
  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return [];
  }
  async resolveEscalation(): Promise<void> {
    /* no-op */
  }
  getPendingEscalation(): EscalationRequest | undefined {
    return undefined;
  }
  getBudgetStatus(): BudgetStatus {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      elapsedSeconds: 0,
      estimatedCostUsd: 0,
      limits: {} as BudgetStatus['limits'],
      cumulative: {} as BudgetStatus['cumulative'],
      tokenTrackingAvailable: false,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Canned response builders
// ---------------------------------------------------------------------------

function statusBlock(verdict: string, notes: string, confidence = 'high'): string {
  return [
    '```',
    'agent_status:',
    '  completed: true',
    `  verdict: ${verdict}`,
    `  confidence: ${confidence}`,
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

function plannerResponse(): string {
  return [
    '## Implementation Plan',
    '',
    '1. Set up the project structure with TypeScript and ESM',
    '2. Implement the core data model with proper types',
    '3. Build the REST API layer with input validation',
    '4. Add comprehensive test coverage',
    '5. Document the public API',
    '',
    statusBlock('approved', 'Plan complete with 5 phases'),
  ].join('\n');
}

function architectResponse(): string {
  return [
    '## Technical Design Specification',
    '',
    '### Architecture',
    '- Clean layered architecture: routes -> services -> repositories',
    '- Dependency injection via factory functions',
    '- Zod schemas for request validation',
    '',
    '### Data Model',
    '- Users: id, email, name, createdAt',
    '- Posts: id, authorId, title, body, publishedAt',
    '',
    '### API Endpoints',
    '- GET /users, POST /users, GET /users/:id',
    '- GET /posts, POST /posts, GET /posts/:id',
    '',
    statusBlock('approved', 'Design spec complete with architecture and data model'),
  ].join('\n');
}

function coderResponse(): string {
  return [
    'I have implemented the changes based on the plan and specification.',
    '',
    '- Created src/routes/ with user and post handlers',
    '- Created src/services/ with business logic',
    '- Created src/repositories/ with data access layer',
    '- Added Zod validation schemas',
    '- Added unit tests for all modules',
    '',
    statusBlock('approved', 'Implementation complete'),
  ].join('\n');
}

/**
 * Critic response factory. Returns rejected on the first call,
 * approved on the second.
 */
function createCriticResponseFn(): ResponseFactory {
  let callCount = 0;
  return () => {
    callCount++;
    if (callCount === 1) {
      return [
        '## Code Review',
        '',
        'Found several issues:',
        '- Missing input validation on POST /users email field',
        '- No error handling for database connection failures',
        '- Test coverage below 80% in the services layer',
        '',
        statusBlock('rejected', 'Missing validation and error handling'),
      ].join('\n');
    }
    return [
      '## Code Review',
      '',
      'All previously identified issues have been addressed:',
      '- Email validation added with proper error messages',
      '- Database error handling with retry logic',
      '- Test coverage now at 92%',
      '',
      statusBlock('approved', 'All issues resolved, code is production-ready'),
    ].join('\n');
  };
}

// ---------------------------------------------------------------------------
// Artifact writer helper
// ---------------------------------------------------------------------------

function writeArtifacts(artifactDir: string, names: string[], content: string): void {
  for (const name of names) {
    const dir = resolve(artifactDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${name}.md`), content);
  }
}

// ---------------------------------------------------------------------------
// Session factory
// ---------------------------------------------------------------------------

/**
 * Finds the artifact directory for the most recent workflow.
 * The orchestrator creates {baseDir}/{workflowId}/artifacts/.
 */
function findArtifactDir(baseDir: string): string {
  const entries = readdirSync(baseDir);
  const dirs = entries.filter((e: string) => !e.endsWith('.json'));
  if (dirs.length === 0) throw new Error(`No workflow dir found in ${baseDir}`);
  return resolve(baseDir, dirs[dirs.length - 1], 'artifacts');
}

interface SessionFactoryOptions {
  baseDir: string;
  interactive: boolean;
}

export function createSessionFactory(opts: SessionFactoryOptions): (sopts: SessionOptions) => Promise<Session> {
  const criticResponseFn = createCriticResponseFn();

  return async (sopts: SessionOptions): Promise<Session> => {
    const persona = sopts.persona ?? 'unknown';
    const artifactDir = findArtifactDir(opts.baseDir);

    const artifactWriter = (names: string[], content: string) => writeArtifacts(artifactDir, names, content);

    switch (persona) {
      case 'planner':
        return new MockSession({
          sessionId: `planner-${Date.now()}`,
          responseFn: plannerResponse,
          afterSend: () => artifactWriter(['plan'], plannerResponse()),
        });

      case 'architect':
        return new MockSession({
          sessionId: `architect-${Date.now()}`,
          responseFn: architectResponse,
          afterSend: () => artifactWriter(['spec'], architectResponse()),
        });

      case 'coder':
        return new MockSession({
          sessionId: `coder-${Date.now()}`,
          responseFn: coderResponse,
          afterSend: () => artifactWriter(['code'], coderResponse()),
        });

      case 'critic':
        return new MockSession({
          sessionId: `critic-${Date.now()}`,
          responseFn: criticResponseFn,
          afterSend: () => artifactWriter(['reviews'], 'review feedback'),
        });

      default:
        throw new Error(`Unknown persona: ${persona}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Gate handling
// ---------------------------------------------------------------------------

interface PendingGate {
  gate: HumanGateRequest;
  resolve: (event: { type: HumanGateEventType; prompt?: string }) => void;
}

/**
 * Creates the raiseGate/dismissGate callbacks and a method to
 * wait for and resolve the next gate.
 */
export function createGateHandler() {
  let pendingGate: PendingGate | undefined;
  const gatePromises: Array<{
    resolve: (gate: HumanGateRequest) => void;
  }> = [];

  function raiseGate(gate: HumanGateRequest): void {
    const waitingResolver = gatePromises.shift();
    if (waitingResolver) {
      waitingResolver.resolve(gate);
    }
    // Store for external resolution
    pendingGate = {
      gate,
      resolve: () => {}, // Will be replaced below
    };
  }

  function dismissGate(_gateId: string): void {
    pendingGate = undefined;
  }

  async function waitForGate(): Promise<HumanGateRequest> {
    if (pendingGate) {
      const g = pendingGate.gate;
      return g;
    }
    return new Promise<HumanGateRequest>((resolve) => {
      gatePromises.push({ resolve });
    });
  }

  function getPending(): PendingGate | undefined {
    return pendingGate;
  }

  return { raiseGate, dismissGate, waitForGate, getPending };
}

// ---------------------------------------------------------------------------
// Interactive gate prompt
// ---------------------------------------------------------------------------

async function promptGateInteractive(
  gate: HumanGateRequest,
  rl: ReturnType<typeof createInterface>,
): Promise<{ type: HumanGateEventType; prompt?: string }> {
  const bar = '='.repeat(50);
  const presented = gate.present ? [...gate.presentedArtifacts.keys()].join(', ') : 'none';

  console.log('');
  console.log(`${BOLD}${YELLOW}${bar}${RESET}`);
  console.log(`${BOLD}${BG_YELLOW}${BLACK} HUMAN GATE: ${gate.stateName} ${RESET}`);
  console.log('');
  console.log(`${DIM}Presented artifacts: ${presented}${RESET}`);
  console.log('');
  console.log(`${WHITE}Options:${RESET}`);

  const eventMap = new Map<string, HumanGateEventType>();
  for (const evt of gate.acceptedEvents) {
    switch (evt) {
      case 'APPROVE':
        console.log(`  ${GREEN}[a]${RESET} APPROVE`);
        eventMap.set('a', 'APPROVE');
        break;
      case 'FORCE_REVISION':
        console.log(`  ${YELLOW}[f]${RESET} FORCE_REVISION`);
        eventMap.set('f', 'FORCE_REVISION');
        break;
      case 'REPLAN':
        console.log(`  ${MAGENTA}[r]${RESET} REPLAN`);
        eventMap.set('r', 'REPLAN');
        break;
      case 'ABORT':
        console.log(`  ${RED}[x]${RESET} ABORT`);
        eventMap.set('x', 'ABORT');
        break;
    }
  }

  console.log('');
  const validKeys = [...eventMap.keys()].join('/');

  for (;;) {
    const answer = await rl.question(`${BOLD}Your choice (${validKeys}): ${RESET}`);
    const key = answer.trim().toLowerCase();
    const eventType = eventMap.get(key);
    if (!eventType) {
      console.log(`${RED}Invalid choice. Please enter one of: ${validKeys}${RESET}`);
      continue;
    }

    if (eventType === 'FORCE_REVISION' || eventType === 'REPLAN') {
      const feedback = await rl.question(`${CYAN}Feedback: ${RESET}`);
      return { type: eventType, prompt: feedback || undefined };
    }

    return { type: eventType };
  }
}

// ---------------------------------------------------------------------------
// Tab handle (logs to console)
// ---------------------------------------------------------------------------

function createConsoleTab(label: string): WorkflowTabHandle {
  return {
    write(text: string): void {
      console.log(`${DIM}[${label}]${RESET} ${text}`);
    },
    setLabel(newLabel: string): void {
      console.log(`${DIM}[tab] label: ${newLabel}${RESET}`);
    },
    close(): void {
      console.log(`${DIM}[tab] ${label} closed${RESET}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Print lifecycle event
// ---------------------------------------------------------------------------

function printLifecycleEvent(event: WorkflowLifecycleEvent): void {
  switch (event.kind) {
    case 'state_entered':
      console.log(`${BLUE}>>>${RESET} ${BOLD}State:${RESET} ${CYAN}${event.state}${RESET}`);
      break;
    case 'gate_raised':
      // Handled separately by the interactive loop
      break;
    case 'gate_dismissed':
      console.log(`${GREEN}[gate dismissed]${RESET} ${event.gateId}`);
      break;
    case 'completed':
      console.log(`${GREEN}${BOLD}Workflow completed!${RESET}`);
      break;
    case 'failed':
      console.log(`${RED}${BOLD}Workflow failed:${RESET} ${event.error}`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------

function printSummary(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId): void {
  const status = orchestrator.getStatus(workflowId);
  console.log('');
  console.log(`${BOLD}${'='.repeat(50)}${RESET}`);
  console.log(`${BOLD}WORKFLOW SUMMARY${RESET}`);
  console.log(`${'='.repeat(50)}`);
  if (!status) {
    console.log(`${RED}No status available${RESET}`);
    return;
  }
  console.log(`Phase: ${BOLD}${status.phase}${RESET}`);
  if (status.phase === 'completed') {
    console.log(`Final artifacts: ${Object.keys(status.result.finalArtifacts).join(', ') || 'none'}`);
  } else if (status.phase === 'aborted') {
    console.log(`Reason: ${status.reason}`);
  } else if (status.phase === 'failed') {
    console.log(`Error: ${status.error}`);
  }
  console.log(`${'='.repeat(50)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runSpike(options?: { interactive?: boolean }): Promise<void> {
  const interactive = options?.interactive ?? true;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const definitionPath = resolve(__dirname, 'workflow-demo.json');
  const baseDir = mkdtempSync(join(tmpdir(), 'workflow-spike-'));

  let rl: ReturnType<typeof createInterface> | undefined;
  let orchestrator: WorkflowOrchestrator | undefined;

  // Cleanup handler
  async function cleanup(): Promise<void> {
    if (orchestrator) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    rl?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }

  // Ctrl+C handler
  const abortHandler = async () => {
    console.log(`\n${RED}${BOLD}Interrupted. Cleaning up...${RESET}`);
    await cleanup();
    process.exit(1);
  };
  process.on('SIGINT', abortHandler);

  try {
    if (interactive) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
    }

    console.log(`${BOLD}${MAGENTA}Workflow Orchestrator Spike${RESET}`);
    console.log(`${DIM}Base dir: ${baseDir}${RESET}`);
    console.log('');

    // Set up gate handling
    const gateHandler = createGateHandler();

    // Build deps
    const deps: WorkflowOrchestratorDeps = {
      createSession: createSessionFactory({ baseDir, interactive }),
      createWorkflowTab: (label: string, _workflowId: WorkflowId) => createConsoleTab(label),
      raiseGate: gateHandler.raiseGate,
      dismissGate: gateHandler.dismissGate,
      baseDir,
    };

    orchestrator = new WorkflowOrchestrator(deps);

    // Track lifecycle events
    const lifecycleEvents: WorkflowLifecycleEvent[] = [];
    orchestrator.onEvent((event) => {
      lifecycleEvents.push(event);
      printLifecycleEvent(event);
    });

    // Start the workflow
    const workflowId = await orchestrator.start(definitionPath, 'Build a REST API for a blog platform');

    // Main event loop: poll for gates and completion
    for (;;) {
      const status = orchestrator.getStatus(workflowId);
      if (!status) break;
      if (status.phase === 'completed' || status.phase === 'failed' || status.phase === 'aborted') {
        break;
      }

      if (status.phase === 'waiting_human') {
        const gate = status.gate;
        if (interactive && rl) {
          const event = await promptGateInteractive(gate, rl);
          orchestrator.resolveGate(workflowId, event);
        } else {
          // Auto-approve for non-interactive mode
          orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
        }
        // Give the machine time to process the gate resolution
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      // Poll interval
      await new Promise((r) => setTimeout(r, 50));
    }

    printSummary(orchestrator, workflowId);
  } finally {
    process.removeListener('SIGINT', abortHandler);
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// Entry point (only when run directly)
// ---------------------------------------------------------------------------

const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runSpike({ interactive: true }).catch((err) => {
    console.error(`${RED}Fatal error:${RESET}`, err);
    process.exit(1);
  });
}
