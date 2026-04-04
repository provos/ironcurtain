/* eslint-disable */
/**
 * Real-agent spike script that exercises the workflow orchestrator
 * with actual Docker agent sessions (Claude Code in containers).
 *
 * Usage:
 *   npx tsx examples/workflow-real-spike.ts "Design and build a palindrome checker"
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY in environment or ~/.ironcurtain/config.json
 *   - Docker running with ironcurtain-claude-code:latest image built
 *   - Global compiled policy in src/config/generated/
 */
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config/index.js';
import { createSession } from '../src/session/index.js';
import type { Session, SessionOptions } from '../src/session/types.js';
import type { WorkflowId, HumanGateRequest, HumanGateEventType } from '../src/workflow/types.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
  type WorkflowLifecycleEvent,
} from '../src/workflow/orchestrator.js';

// ---------------------------------------------------------------------------
// Safe output primitives
// ---------------------------------------------------------------------------
// logger.setup() (called inside createSession) hijacks console.log and
// console.error, redirecting them to a log file. If session creation fails
// and logger.teardown() is not called, all subsequent console output is
// invisible. Use process.stdout/stderr.write directly for all spike output
// so errors are ALWAYS visible regardless of logger state.

const stdoutWrite = (msg: string) => process.stdout.write(`${msg}\n`);
const stderrWrite = (msg: string) => process.stderr.write(`${msg}\n`);

// ---------------------------------------------------------------------------
// ANSI colors (shared with workflow-spike.ts)
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
// Role prompts
// ---------------------------------------------------------------------------

const ROLE_PROMPTS: Record<string, string> = {
  planner: `You are a project planner. Break down the task into a clear, actionable plan.

Your responsibilities:
- Analyze the task requirements
- Identify components, dependencies, and implementation order
- Note key design decisions and trade-offs

Output: Create a \`plan/\` directory in your workspace with a \`plan.md\` file.
Write a structured markdown document with numbered steps.
Do NOT write any code -- only the plan.`,

  architect: `You are a software architect. Produce a technical design specification.

Your responsibilities:
- Define module structure, interfaces, and data flow
- Specify function signatures with TypeScript types
- Document key design decisions and rationale

Output: Create a \`spec/\` directory in your workspace with a \`spec.md\` file.
Write a structured markdown document with interface definitions and architecture notes.
Do NOT write implementation code.`,

  coder: `You are an implementation engineer. Write working code based on the plan and spec.

Your responsibilities:
- Implement all modules described in the spec
- Write clean, well-typed TypeScript
- Create unit tests using Node.js built-in assert module
- Ensure all tests pass by running them

Output: Create a \`code/\` directory in your workspace containing all source files and tests.
Run the tests to verify they pass before finishing.`,

  critic: `You are a code reviewer. Review the implementation against the specification.

Your responsibilities:
- Verify correctness: does the code match the spec?
- Check edge cases and error handling
- Evaluate code quality, naming, and structure
- Assess test coverage and test quality

Output: Create a \`reviews/\` directory with a \`review.md\` file.
If issues are found, set verdict to "rejected" with specific feedback.
If the code is solid, set verdict to "approved".`,
};

// ---------------------------------------------------------------------------
// Session factory for Docker mode with Haiku model
// ---------------------------------------------------------------------------

const HAIKU_MODEL_ID = 'anthropic:claude-haiku-4-5';

function createRealSessionFactory(): (opts: SessionOptions) => Promise<Session> {
  // Load config once and override the model to Haiku
  const baseConfig = loadConfig();
  const haiku = {
    ...baseConfig,
    userConfig: {
      ...baseConfig.userConfig,
      agentModelId: HAIKU_MODEL_ID,
    },
  };

  return async (opts: SessionOptions): Promise<Session> => {
    const persona = opts.persona;

    // Convert persona to systemPromptAugmentation instead of forwarding
    // persona field (which would trigger persona directory resolution).
    // Workflow role names (planner, architect, etc.) are NOT IronCurtain
    // personas -- they don't have persona directories or compiled policies.
    // The global compiled policy applies to all roles.
    const rolePrompt = persona ? ROLE_PROMPTS[persona] : undefined;
    const systemPromptAugmentation = [rolePrompt, opts.systemPromptAugmentation].filter(Boolean).join('\n\n');

    // Build effective options: inject config + role prompt, strip persona
    const effectiveOpts: SessionOptions = {
      ...opts,
      config: haiku,
      persona: undefined,
      systemPromptAugmentation: systemPromptAugmentation || undefined,
    };

    try {
      return await createSession(effectiveOpts);
    } catch (err) {
      // Surface the error via process.stderr.write (not console.error)
      // because logger.setup() may have hijacked console.error to write
      // to a log file instead of the terminal.
      const msg = err instanceof Error ? err.message : String(err);
      stderrWrite(`${RED}${BOLD}[session-factory] Failed to create session for "${persona ?? 'unknown'}":${RESET}`);
      stderrWrite(`${RED}  ${msg}${RESET}`);
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Gate handling (adapted from workflow-spike.ts)
// ---------------------------------------------------------------------------

function createGateHandler() {
  const gatePromises: Array<{ resolve: (gate: HumanGateRequest) => void }> = [];
  let pendingGate: HumanGateRequest | undefined;

  function raiseGate(gate: HumanGateRequest): void {
    pendingGate = gate;
    const waiter = gatePromises.shift();
    if (waiter) waiter.resolve(gate);
  }

  function dismissGate(_gateId: string): void {
    pendingGate = undefined;
  }

  async function waitForGate(): Promise<HumanGateRequest> {
    if (pendingGate) return pendingGate;
    return new Promise<HumanGateRequest>((resolve) => {
      gatePromises.push({ resolve });
    });
  }

  return { raiseGate, dismissGate, waitForGate };
}

// ---------------------------------------------------------------------------
// Interactive gate prompt
// ---------------------------------------------------------------------------

async function promptGateInteractive(
  gate: HumanGateRequest,
  rl: ReturnType<typeof createInterface>,
): Promise<{ type: HumanGateEventType; prompt?: string }> {
  const bar = '='.repeat(50);
  const presented = [...gate.presentedArtifacts.keys()].join(', ') || 'none';

  stdoutWrite('');
  stdoutWrite(`${BOLD}${YELLOW}${bar}${RESET}`);
  stdoutWrite(`${BOLD}${BG_YELLOW}${BLACK} HUMAN GATE: ${gate.stateName} ${RESET}`);

  // Surface errors prominently so they are not buried in dim text
  if (gate.summary.includes('(error:')) {
    const errorMatch = /\(error: (.+)\)$/.exec(gate.summary);
    if (errorMatch) {
      stderrWrite(`${RED}${BOLD}ERROR: ${errorMatch[1]}${RESET}`);
    }
  }
  stdoutWrite(`${DIM}${gate.summary}${RESET}`);
  stdoutWrite(`${DIM}Presented artifacts: ${presented}${RESET}`);
  stdoutWrite('');
  stdoutWrite(`${WHITE}Options:${RESET}`);

  const eventMap = new Map<string, HumanGateEventType>();
  for (const evt of gate.acceptedEvents) {
    switch (evt) {
      case 'APPROVE':
        stdoutWrite(`  ${GREEN}[a]${RESET} APPROVE`);
        eventMap.set('a', 'APPROVE');
        break;
      case 'FORCE_REVISION':
        stdoutWrite(`  ${YELLOW}[f]${RESET} FORCE_REVISION`);
        eventMap.set('f', 'FORCE_REVISION');
        break;
      case 'REPLAN':
        stdoutWrite(`  ${MAGENTA}[r]${RESET} REPLAN`);
        eventMap.set('r', 'REPLAN');
        break;
      case 'ABORT':
        stdoutWrite(`  ${RED}[x]${RESET} ABORT`);
        eventMap.set('x', 'ABORT');
        break;
    }
  }

  stdoutWrite('');
  const validKeys = [...eventMap.keys()].join('/');

  for (;;) {
    const answer = await rl.question(`${BOLD}Your choice (${validKeys}): ${RESET}`);
    const key = answer.trim().toLowerCase();
    const eventType = eventMap.get(key);
    if (!eventType) {
      stdoutWrite(`${RED}Invalid choice. Please enter one of: ${validKeys}${RESET}`);
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
// Console tab handle
// ---------------------------------------------------------------------------

function createConsoleTab(label: string): WorkflowTabHandle {
  return {
    write(text: string): void {
      stdoutWrite(`${DIM}[${label}]${RESET} ${text}`);
    },
    setLabel(newLabel: string): void {
      stdoutWrite(`${DIM}[tab] label: ${newLabel}${RESET}`);
    },
    close(): void {
      stdoutWrite(`${DIM}[tab] ${label} closed${RESET}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle event printer
// ---------------------------------------------------------------------------

function printLifecycleEvent(event: WorkflowLifecycleEvent): void {
  switch (event.kind) {
    case 'state_entered':
      stdoutWrite(`${BLUE}>>>${RESET} ${BOLD}State:${RESET} ${CYAN}${event.state}${RESET}`);
      break;
    case 'gate_raised':
      stdoutWrite(`${YELLOW}>>>${RESET} ${BOLD}Gate raised:${RESET} ${event.gate.stateName}`);
      break;
    case 'gate_dismissed':
      stdoutWrite(`${GREEN}[gate dismissed]${RESET} ${event.gateId}`);
      break;
    case 'completed':
      stdoutWrite(`${GREEN}${BOLD}Workflow completed!${RESET}`);
      break;
    case 'failed': {
      const errorBar = '-'.repeat(50);
      stderrWrite(`${RED}${errorBar}${RESET}`);
      stderrWrite(`${RED}${BOLD}WORKFLOW ERROR:${RESET} ${event.error}`);
      stderrWrite(`${RED}${errorBar}${RESET}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Summary printer
// ---------------------------------------------------------------------------

function printSummary(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId, artifactDir: string): void {
  const status = orchestrator.getStatus(workflowId);
  const bar = '='.repeat(50);
  stdoutWrite('');
  stdoutWrite(`${BOLD}${bar}${RESET}`);
  stdoutWrite(`${BOLD}WORKFLOW SUMMARY${RESET}`);
  stdoutWrite(bar);

  if (!status) {
    stdoutWrite(`${RED}No status available${RESET}`);
    return;
  }

  stdoutWrite(`Phase: ${BOLD}${status.phase}${RESET}`);
  if (status.phase === 'completed') {
    stdoutWrite(`Final artifacts: ${Object.keys(status.result.finalArtifacts).join(', ') || 'none'}`);
  } else if (status.phase === 'aborted') {
    stdoutWrite(`Reason: ${status.reason}`);
  } else if (status.phase === 'failed') {
    stdoutWrite(`Error: ${status.error}`);
  }

  stdoutWrite(`Artifact directory: ${artifactDir}`);
  if (existsSync(artifactDir)) {
    const entries = readdirSync(artifactDir);
    stdoutWrite(`Contents: ${entries.join(', ') || '(empty)'}`);
  }
  stdoutWrite(bar);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const taskDescription = process.argv[2];
  if (!taskDescription) {
    stderrWrite(`${RED}Usage: npx tsx examples/workflow-real-spike.ts "Your task description"${RESET}`);
    process.exit(1);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const definitionPath = resolve(__dirname, 'workflow-real-demo.json');
  const baseDir = mkdtempSync(resolve(tmpdir(), 'workflow-real-spike-'));

  let rl: ReturnType<typeof createInterface> | undefined;
  let orchestrator: WorkflowOrchestrator | undefined;

  async function cleanup(): Promise<void> {
    if (orchestrator) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    rl?.close();
    // Do NOT delete baseDir -- keep artifacts for inspection
    stdoutWrite(`${DIM}Artifacts preserved at: ${baseDir}${RESET}`);
  }

  const abortHandler = async () => {
    stdoutWrite(`\n${RED}${BOLD}Interrupted. Cleaning up...${RESET}`);
    await cleanup();
    process.exit(1);
  };
  process.on('SIGINT', abortHandler);

  try {
    rl = createInterface({ input: process.stdin, output: process.stdout });

    stdoutWrite(`${BOLD}${MAGENTA}Workflow Real-Agent Spike (Docker Mode)${RESET}`);
    stdoutWrite(`${DIM}Task: ${taskDescription}${RESET}`);
    stdoutWrite(`${DIM}Model: ${HAIKU_MODEL_ID}${RESET}`);
    stdoutWrite(`${DIM}Base dir: ${baseDir}${RESET}`);
    stdoutWrite('');

    const gateHandler = createGateHandler();

    const deps: WorkflowOrchestratorDeps = {
      createSession: createRealSessionFactory(),
      createWorkflowTab: (label: string, _workflowId: WorkflowId) => createConsoleTab(label),
      raiseGate: gateHandler.raiseGate,
      dismissGate: gateHandler.dismissGate,
      baseDir,
    };

    orchestrator = new WorkflowOrchestrator(deps);

    orchestrator.onEvent((event) => {
      printLifecycleEvent(event);
    });

    const workflowId = await orchestrator.start(definitionPath, taskDescription);

    // Derive artifact dir from workflow structure
    const artifactDir = resolve(baseDir, workflowId, 'artifacts');

    // Main event loop
    for (;;) {
      const status = orchestrator.getStatus(workflowId);
      if (!status) break;
      if (status.phase === 'completed' || status.phase === 'failed' || status.phase === 'aborted') break;

      if (status.phase === 'waiting_human') {
        const gate = status.gate;
        const event = await promptGateInteractive(gate, rl);
        orchestrator.resolveGate(workflowId, event);
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // Poll interval
      await new Promise((r) => setTimeout(r, 200));
    }

    printSummary(orchestrator, workflowId, artifactDir);
  } finally {
    process.removeListener('SIGINT', abortHandler);
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  stderrWrite(`${RED}Fatal error: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
