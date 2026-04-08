# Workflow CLI Subcommand Design

## Overview

The `ironcurtain workflow` subcommand graduates the spike script (`examples/workflow-real-spike.ts`) into a proper CLI command. It provides `start`, `resume`, and `inspect` operations for running multi-agent workflows from the terminal with interactive gate handling.

## Subcommand Structure

```
ironcurtain workflow start <definition.json> "task description" [--model <model>]
ironcurtain workflow resume <baseDir> [--state <stateName>] [--model <model>]
ironcurtain workflow inspect <baseDir> [--all]
ironcurtain workflow --help
```

### Arguments

| Subcommand | Positional Args              | Flags                                                                                                                    |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `start`    | `<definition.json>` `"task"` | `--model <id>` (optional, overrides config default)                                                                      |
| `resume`   | `<baseDir>`                  | `--state <name>` (optional, synthesize checkpoint at this state), `--model <id>` (optional, override model for this run) |
| `inspect`  | `<baseDir>`                  | `--all` (optional, show full message log instead of last 20)                                                             |

Argument parsing uses `node:util parseArgs` consistent with the rest of the CLI. The `workflow` case in `src/cli.ts` passes `process.argv.slice(3)` to the workflow command module, which re-parses to determine the sub-subcommand (`start`/`resume`/`inspect`).

## Module Decomposition

### Shared module: `src/workflow/cli-support.ts`

Extracted from the spike, this module contains all reusable logic that both the CLI command and the spike script can import:

| Export                      | Description                                                        | Origin in spike |
| --------------------------- | ------------------------------------------------------------------ | --------------- |
| `createGateHandler()`       | Gate promise queue (raiseGate/dismissGate/waitForGate)             | Lines 115-137   |
| `promptGateInteractive()`   | Readline-based interactive gate prompt                             | Lines 143-207   |
| `createConsoleTab()`        | `WorkflowTabHandle` that writes to stdout                          | Lines 213-225   |
| `printLifecycleEvent()`     | Formats `WorkflowLifecycleEvent` with ANSI colors                  | Lines 231-253   |
| `printSummary()`            | End-of-workflow summary with artifact listing                      | Lines 259-287   |
| `printResumeInfo()`         | Prints checkpoint details before resume                            | Lines 344-356   |
| `selectResumableWorkflow()` | Picks most-recent checkpoint from a store                          | Lines 358-390   |
| `synthesizeCheckpoint()`    | Builds checkpoint for pre-checkpointing runs                       | Lines 398-472   |
| `runEventLoop()`            | Poll loop: status check, gate prompt, wait (accepts `AbortSignal`) | Lines 478-499   |
| ANSI color constants        | Shared palette                                                     | Lines 54-65     |

**Output convention**: All functions in `cli-support.ts` use `process.stdout.write()` and `process.stderr.write()` for terminal output. Never use `console.log/warn/error` -- after `logger.setup()` hijacks `console.*`, those writes are redirected to the session log file and never reach the terminal. This is the established codebase pattern used in `cli-transport.ts`, `orchestrator.ts`, `index.ts`, and the spike. The `writeStderr()` helper in `orchestrator.ts` is the canonical example.

The spike script (`examples/workflow-real-spike.ts`) is then reduced to a thin wrapper that imports from `cli-support.ts` and hardcodes its definition path and model.

### CLI command: `src/workflow/workflow-command.ts`

The CLI-specific entry point. Responsibilities:

1. Parse `process.argv` for the sub-subcommand and flags
2. Build a session factory with model override (from `--model` flag or config default)
3. Wire `WorkflowOrchestratorDeps` using shared helpers
4. Dispatch to `start`, `resume`, or `inspect`
5. Handle SIGINT cleanup

Exported function: `main(args: string[]): Promise<void>`

### Inspect command: inline in `workflow-command.ts`

The `inspect` subcommand is read-only and does not need the orchestrator. It:

1. Reads checkpoint(s) from `<baseDir>` via `FileCheckpointStore`
2. Reads `definition.json` from the workflow directory for metadata
3. Reads message log via `MessageLog.readAll()`
4. Lists artifact directories
5. Prints a summary to stdout: workflow ID, current state, artifact listing, and the **last 20 messages** from the JSONL log

The `--all` flag replaces the 20-message default with the full log. All output uses `process.stdout.write()`.

This is small enough to live directly in `workflow-command.ts` as a function, not a separate module.

## File Layout

```
src/workflow/
  cli-support.ts          # NEW - shared helpers extracted from spike
  workflow-command.ts      # NEW - CLI entry point (main())
  orchestrator.ts          # UNCHANGED
  checkpoint.ts            # UNCHANGED
  message-log.ts           # UNCHANGED
  types.ts                 # UNCHANGED

src/cli.ts                 # MODIFIED - add 'workflow' case to switch

examples/
  workflow-real-spike.ts   # MODIFIED - import from cli-support.ts instead of inline
```

## Integration with `src/cli.ts`

Add to the `topLevelSpec.subcommands` array:

```typescript
{ name: 'workflow', description: 'Run multi-agent workflows (start, resume, inspect)' },
```

Add to the switch statement:

```typescript
case 'workflow': {
  const { main: workflowMain } = await import('./workflow/workflow-command.js');
  await workflowMain(process.argv.slice(3));
  break;
}
```

This follows the exact pattern of `persona`, `auth`, `daemon`, and other subcommands that forward their sub-args.

## Session Factory Design

The session factory is the key integration point between the workflow orchestrator and the session layer.

```typescript
function buildSessionFactory(modelOverride: string | undefined): (opts: SessionOptions) => Promise<Session> {
  const baseConfig = loadConfig();

  // Resolve model: --model flag > config default
  const agentModelId = modelOverride ?? baseConfig.userConfig.agentModelId;
  const effectiveConfig: IronCurtainConfig = {
    ...baseConfig,
    userConfig: {
      ...baseConfig.userConfig,
      agentModelId,
    },
  };

  return async (opts: SessionOptions): Promise<Session> => {
    // Strip persona -- workflow role names are NOT IronCurtain personas.
    // systemPromptAugmentation passes through from the orchestrator.
    const effectiveOpts: SessionOptions = {
      ...opts,
      config: effectiveConfig,
      persona: undefined,
    };
    return createSession(effectiveOpts);
  };
}
```

Key decisions:

- **Model override**: The `--model` flag overrides `agentModelId` in the config on both `start` and `resume`. This allows switching models when resuming (e.g., a Haiku run failed, retry with Sonnet). The spike hardcodes Haiku; the CLI makes it configurable.
- **Session mode**: Comes from `definition.settings.mode`, propagated by the orchestrator into `SessionOptions.mode`. The CLI does not need to know about it -- the orchestrator handles mode selection.
- **Persona stripping**: Workflow state `persona` fields are role labels (e.g., "architect", "reviewer"), not IronCurtain persona directories. The factory strips them to avoid persona resolution errors.
- **Config loaded once**: `loadConfig()` is called once at factory creation time, not per session.

## Gate Handling

Interactive gate handling uses the same readline-based approach as the spike. The shared `promptGateInteractive()` function:

1. Displays gate metadata (state name, summary, presented artifacts, error context)
2. Lists accepted events with single-key shortcuts (a/f/r/x)
3. Loops until valid input
4. For FORCE_REVISION and REPLAN, prompts for feedback text

The `runEventLoop()` polls orchestrator status and dispatches to `promptGateInteractive()` when `phase === 'waiting_human'`. It accepts an `AbortSignal` parameter to allow clean shutdown (see Signal Handling below). This is a simple poll loop (200ms interval) rather than an event-driven approach because:

- The orchestrator emits lifecycle events via callbacks, but the event loop needs to block on readline input
- The poll is cheap (no I/O, just reading in-memory status)
- Matching the spike's proven approach avoids subtle timing bugs

```typescript
async function runEventLoop(
  orchestrator: WorkflowOrchestrator,
  workflowId: string,
  gateHandler: GateHandler,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const status = orchestrator.getStatus(workflowId);
    if (!status || status.phase === 'completed' || status.phase === 'failed') break;

    if (status.phase === 'waiting_human') {
      await promptGateInteractive(gateHandler, status);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
```

## Definition Persistence

During `start`, the workflow definition JSON is copied into the workflow directory:

```
{baseDir}/{workflowId}/definition.json
```

This ensures `resume` and `inspect` can read the definition without requiring the user to re-specify a `--definition` flag. The `synthesizeCheckpoint()` function also reads the stored copy when building a checkpoint from a pre-checkpointing run.

The copy is made immediately after the orchestrator creates the workflow directory and before the first state executes.

## Signal Handling (SIGINT)

On SIGINT, the CLI performs a graceful shutdown:

1. The `workflow-command.ts` entry point creates an `AbortController` and registers a SIGINT handler
2. The handler calls `controller.abort()`, which signals the event loop to break
3. After the event loop exits, the CLI calls `orchestrator.shutdownAll()` to close any running Docker containers and sessions
4. The process exits with code 130

```typescript
const controller = new AbortController();
process.on('SIGINT', () => {
  process.stderr.write('\n[workflow] Caught SIGINT, shutting down...\n');
  controller.abort();
});

try {
  await runEventLoop(orchestrator, workflowId, gateHandler, controller.signal);
} finally {
  await orchestrator.shutdownAll();
}

process.exit(controller.signal.aborted ? 130 : exitCodeFromStatus(orchestrator, workflowId));
```

No hard `process.exit(1)` during the poll loop. The abort signal allows the event loop to finish its current iteration and exit cleanly.

## Exit Codes

| Code  | Meaning                                              |
| ----- | ---------------------------------------------------- |
| `0`   | Workflow completed successfully                      |
| `1`   | Workflow failed or runtime error                     |
| `130` | SIGINT (standard Unix convention for 128 + signal 2) |

## Help Spec

```typescript
const workflowSpec: CommandSpec = {
  name: 'ironcurtain workflow',
  description: 'Run multi-agent workflows',
  usage: [
    'ironcurtain workflow start <definition.json> "task" [--model <model>]',
    'ironcurtain workflow resume <baseDir> [--state <stateName>] [--model <model>]',
    'ironcurtain workflow inspect <baseDir> [--all]',
  ],
  subcommands: [
    { name: 'start', description: 'Start a new workflow from a definition file' },
    { name: 'resume', description: 'Resume a checkpointed workflow' },
    { name: 'inspect', description: 'Show workflow status, artifacts, and recent messages' },
  ],
  options: [
    { flag: 'model', description: 'Override the agent model (start, resume)', placeholder: '<model-id>' },
    { flag: 'state', description: 'Synthesize checkpoint at this state (resume only)', placeholder: '<name>' },
    { flag: 'all', description: 'Show full message log (inspect only)' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain workflow start ./my-workflow.json "Build a REST API"',
    'ironcurtain workflow start ./my-workflow.json "task" --model anthropic:claude-haiku-4-5',
    'ironcurtain workflow resume /tmp/workflow-abc123',
    'ironcurtain workflow resume /tmp/workflow-abc123 --state review',
    'ironcurtain workflow resume /tmp/workflow-abc123 --model anthropic:claude-sonnet-4-6',
    'ironcurtain workflow inspect /tmp/workflow-abc123',
    'ironcurtain workflow inspect /tmp/workflow-abc123 --all',
  ],
};
```

## Future Work

### `--auto-approve` flag for non-interactive use

For CI pipelines and scripted use, a `--auto-approve` flag would bypass interactive gate prompts and automatically approve all gates. This plugs into the gate handler: when `--auto-approve` is set, `createGateHandler()` returns a handler that immediately resolves with `APPROVE` instead of calling `promptGateInteractive()`. Not implemented now -- interactive gate review is the safety-critical path and should be the well-tested default first.

## Implementation Plan

### PR 1: Extract shared helpers into `cli-support.ts`

1. Create `src/workflow/cli-support.ts` with all shared exports listed above
2. Modify `examples/workflow-real-spike.ts` to import from `cli-support.ts`
3. Verify the spike still works end-to-end

This is a pure refactor with no behavioral changes.

### PR 2: Add `workflow-command.ts` and wire into CLI

1. Create `src/workflow/workflow-command.ts` with `main(args: string[])`
2. Implement `start` (with definition copy into workflow dir), `resume` (reads stored definition), and `inspect` sub-subcommands
3. Wire SIGINT handling with `AbortController` and `orchestrator.shutdownAll()`
4. Add the `workflow` case to `src/cli.ts`
5. Add help spec
6. Set exit codes: 0 (success), 1 (failure), 130 (SIGINT)
7. Test: `ironcurtain workflow --help`, `ironcurtain workflow start --help`

### PR 3: Polish and test

1. Add integration test for argument parsing (including `--model` on both `start` and `resume`)
2. Verify `inspect` output with a pre-built checkpoint fixture (default 20 messages + `--all`)
3. Verify definition persistence: `start` copies definition, `resume` reads it
4. Update top-level help examples in `cli.ts` to include a workflow example

---

## Implementation Status

**Implemented** (2026-04-04). Actual file paths:

- `src/workflow/cli-support.ts` -- shared helpers (session factory, gate handling, event loop, ANSI colors, resume helpers)
- `src/workflow/workflow-command.ts` -- CLI entry point with `start`, `resume`, `inspect` subcommands
- `src/cli.ts` -- wired `workflow` case into the subcommand switch
- `examples/workflow-real-spike.ts` -- updated to import from `cli-support.ts`
