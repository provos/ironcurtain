/* eslint-disable */
/**
 * Real-agent spike script that exercises the workflow orchestrator
 * with actual Docker agent sessions (Claude Code in containers).
 *
 * Usage:
 *   npx tsx examples/workflow-real-spike.ts "Design and build a palindrome checker"
 *   npx tsx examples/workflow-real-spike.ts --resume /path/to/preserved-artifact-dir
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY in environment or ~/.ironcurtain/config.json
 *   - Docker running with ironcurtain-claude-code:latest image built
 *   - Global compiled policy in src/config/generated/
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { WorkflowId, WorkflowCheckpoint } from '../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowOrchestratorDeps } from '../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import { loadConfig } from '../src/config/index.js';
import { discoverWorkflowRuns } from '../src/workflow/workflow-discovery.js';
import {
  createWorkflowSessionFactory,
  createConsoleTab,
  createGateHandler,
  printLifecycleEvent,
  printSummary,
  printResumeInfo,
  selectResumableWorkflow,
  synthesizeCheckpoint,
  runEventLoop,
  writeStdout,
  writeStderr,
  RED,
  BOLD,
  DIM,
  MAGENTA,
  RESET,
} from '../src/workflow/cli-support.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HAIKU_MODEL_ID = 'anthropic:claude-haiku-4-5';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface StartArgs {
  readonly mode: 'start';
  readonly taskDescription: string;
  readonly workspacePath?: string;
}

interface ResumeArgs {
  readonly mode: 'resume';
  readonly baseDir: string;
  readonly overrideState?: string;
}

type CliArgs = StartArgs | ResumeArgs;

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);

  const resumeIndex = args.indexOf('--resume');
  if (resumeIndex !== -1) {
    const resumePath = args[resumeIndex + 1];
    if (!resumePath) {
      writeStderr(`${RED}--resume requires a path argument${RESET}`);
      process.exit(1);
    }
    const resolved = resolve(resumePath);
    if (!existsSync(resolved)) {
      writeStderr(`${RED}Resume path does not exist: ${resolved}${RESET}`);
      process.exit(1);
    }
    const stateIndex = args.indexOf('--state');
    const overrideState = stateIndex !== -1 ? args[stateIndex + 1] : undefined;

    return { mode: 'resume', baseDir: resolved, overrideState };
  }

  // Parse --workspace flag
  const workspaceIndex = args.indexOf('--workspace');
  let workspacePath: string | undefined;
  if (workspaceIndex !== -1) {
    const workspaceArg = args[workspaceIndex + 1];
    if (!workspaceArg) {
      writeStderr(`${RED}--workspace requires a path argument${RESET}`);
      process.exit(1);
    }
    const resolvedWs = resolve(workspaceArg);
    if (!existsSync(resolvedWs) || !statSync(resolvedWs).isDirectory()) {
      writeStderr(`${RED}Workspace path is not a directory: ${resolvedWs}${RESET}`);
      process.exit(1);
    }
    workspacePath = resolvedWs;
    args.splice(workspaceIndex, 2);
  }

  const taskDescription = args[0];
  if (!taskDescription) {
    writeStderr(`${RED}Usage:${RESET}`);
    writeStderr(`${RED}  npx tsx examples/workflow-real-spike.ts "Your task description"${RESET}`);
    writeStderr(`${RED}  npx tsx examples/workflow-real-spike.ts "Your task" --workspace ~/src/myproject${RESET}`);
    writeStderr(`${RED}  npx tsx examples/workflow-real-spike.ts --resume /path/to/dir [--state stateName]${RESET}`);
    process.exit(1);
  }

  return { mode: 'start', taskDescription, workspacePath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseCliArgs();

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const definitionPath = resolve(__dirname, '..', 'src', 'workflow', 'workflows', 'design-and-code.yaml');

  const baseDir = cliArgs.mode === 'resume' ? cliArgs.baseDir : mkdtempSync(resolve(tmpdir(), 'workflow-real-spike-'));

  const checkpointStore = new FileCheckpointStore(baseDir);

  let rl: ReturnType<typeof createInterface> | undefined;
  let orchestrator: WorkflowOrchestrator | undefined;

  async function cleanup(): Promise<void> {
    if (orchestrator) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    rl?.close();
    writeStdout(`${DIM}Artifacts preserved at: ${baseDir}${RESET}`);
  }

  const abortHandler = async () => {
    writeStdout(`\n${RED}${BOLD}Interrupted. Cleaning up...${RESET}`);
    await cleanup();
    process.exit(1);
  };
  process.on('SIGINT', abortHandler);

  try {
    rl = createInterface({ input: process.stdin, output: process.stdout });

    const gateHandler = createGateHandler();

    const config = loadConfig();
    const deps: WorkflowOrchestratorDeps = {
      createSession: createWorkflowSessionFactory(HAIKU_MODEL_ID),
      createWorkflowTab: (label: string, _workflowId: WorkflowId) => createConsoleTab(label),
      raiseGate: gateHandler.raiseGate,
      dismissGate: gateHandler.dismissGate,
      baseDir,
      checkpointStore,
      userConfig: config.userConfig,
    };

    orchestrator = new WorkflowOrchestrator(deps);

    orchestrator.onEvent((event) => {
      printLifecycleEvent(event);
    });

    let workflowId: WorkflowId;

    if (cliArgs.mode === 'resume') {
      let selected: { workflowId: WorkflowId; checkpoint: WorkflowCheckpoint };

      const hasCheckpoints = discoverWorkflowRuns(baseDir).some((r) => r.hasCheckpoint);
      if (cliArgs.overrideState && !hasCheckpoints) {
        selected = synthesizeCheckpoint(baseDir, cliArgs.overrideState, definitionPath, checkpointStore);
      } else {
        selected = selectResumableWorkflow(checkpointStore, baseDir);
      }
      workflowId = selected.workflowId;

      printResumeInfo(baseDir, workflowId, selected.checkpoint);

      writeStdout(`${BOLD}${MAGENTA}Resuming...${RESET}`);
      writeStdout('');
      await orchestrator.resume(workflowId);
    } else {
      writeStdout(`${BOLD}${MAGENTA}Workflow Real-Agent Spike (Docker Mode)${RESET}`);
      writeStdout(`${DIM}Task: ${cliArgs.taskDescription}${RESET}`);
      writeStdout(`${DIM}Model: ${HAIKU_MODEL_ID}${RESET}`);
      writeStdout(`${DIM}Base dir: ${baseDir}${RESET}`);
      writeStdout('');

      workflowId = await orchestrator.start(definitionPath, cliArgs.taskDescription, cliArgs.workspacePath);
    }

    const wsPath =
      cliArgs.mode === 'start'
        ? (cliArgs.workspacePath ?? resolve(baseDir, workflowId, 'workspace'))
        : resolve(baseDir, workflowId, 'workspace');
    const artifactDir = resolve(wsPath, '.workflow');

    await runEventLoop(orchestrator, workflowId, rl);

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
  writeStderr(`${RED}Fatal error: ${err instanceof Error ? err.message : String(err)}${RESET}`);
  process.exit(1);
});
