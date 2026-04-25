# Follow-up: Workflow-manager layer cleanup

## Problem

The CLI `workflow inspect` subcommand depends on `src/web-ui/` modules:

- `src/workflow/workflow-command.ts:19` imports `WorkflowManager` from `src/web-ui/workflow-manager.ts`.
- `src/workflow/workflow-command.ts:20` imports `WebEventBus` from `src/web-ui/web-event-bus.ts`.

The CLI constructs a no-op `WebEventBus` purely to satisfy `WorkflowManager`'s constructor; it never starts workflows through this manager and never observes lifecycle events. The dependency exists only because `WorkflowManager.loadPastRun` is the canonical "load a past-run from disk" entry point and the CLI needs it.

This is a layer-direction violation: the central runtime ("workflow") depends on a UI surface ("web-ui"). It surfaces today as:

1. CLI imports a no-op event bus it doesn't use.
2. The CLI carries a `web-ui` runtime dependency it doesn't otherwise need.
3. Tests that exercise CLI past-run discovery have to stub `WebEventBus`.

A third, lower-severity violation lives at `src/observe/observe-command.ts:21` — `wsDataToString` is a generic 5-line WebSocket-payload helper that landed in `src/web-ui/ws-utils.ts` but has no UI specifics.

## Audit baseline (clean)

- No central → CLI imports anywhere in `src/`.
- `src/workflow/cli-support.ts` → `src/workflow/orchestrator.ts` is `import type` only — type-only seam, no runtime cycle.
- No central code imports DTOs from `src/web-ui/web-ui-types.ts`. Wire-type boundary is intact.
- No `src/` file imports from `packages/web-ui/`. Frontend is a true leaf.
- `src/web-ui/` does not import the CLI. Coupling is one-way: CLI → web-ui via the two `WorkflowManager` edges only.

## Proposed fix

### Extract a `PastRunLoader` to `src/workflow/`

`WorkflowManager` mixes two concerns:

1. **Past-run loading** — `loadPastRun(workflowId, activeIds?)`, `getBaseDir`, `loadDefinitionForCheckpoint`, `importExternalCheckpoint`. Pure workflow-domain.
2. **Orchestrator lifetime + event forwarding** — instantiates the orchestrator, subscribes to lifecycle events, forwards to `WebEventBus`. Web-UI specific.

Extract (1) into `src/workflow/past-run-loader.ts` (or pick a clearer name — `WorkflowRunStore`, `WorkflowDirectory`, etc.):

```ts
export interface PastRunLoadSuccess { ... }      // already exists
export interface PastRunLoadError { ... }        // already exists
export type PastRunLoadResult = ...

export class PastRunLoader {
  constructor(options: { baseDirOverride?: string });
  loadPastRun(workflowId: WorkflowId, activeIds?: ReadonlySet<WorkflowId>): PastRunLoadResult;
  importExternalCheckpoint(externalBaseDir: string, workflowId?: string): WorkflowId;
  getBaseDir(): string;
  getCheckpointStore(): FileCheckpointStore;
}
```

`WorkflowManager` (in `src/web-ui/`) shrinks to the orchestrator-lifecycle wrapper it was originally designed to be:

```ts
export class WorkflowManager {
  constructor(options: { eventBus: WebEventBus; loader: PastRunLoader });
  getOrchestrator(): WorkflowController;
  shutdown(): Promise<void>;
  // Past-run delegate methods if needed:
  loadPastRun(...): PastRunLoadResult;  // forwards to loader
}
```

### Knock-on changes

- `src/workflow/workflow-command.ts` (CLI) imports `PastRunLoader` directly. Drops `WebEventBus` import. The `runInspect` instantiation becomes one line: `new PastRunLoader({ baseDirOverride: baseDir })`.
- `src/web-ui/dispatch/workflow-dispatch.ts` is unchanged structurally; it routes through `manager.loadPastRun(...)` which now delegates internally to the loader.
- `src/web-ui/workflow-manager.ts` constructor takes (or constructs) a loader; the refactor is transparent at the call sites.
- Tests that previously needed a `WebEventBus` stub for CLI tests can drop the stub.

### `ws-utils.ts` (smaller fix)

Move `src/web-ui/ws-utils.ts` to `src/types/ws-utils.ts` (or `src/utils/`), or inline the 5-line helper into its two callers (`web-ui-server.ts` and `observe-command.ts`). Either is fine; inlining is simplest given the size.

## Out of scope for this follow-up

- Renaming `WorkflowManager` (the post-extraction name should reflect its narrower scope, but renames are noisy in diffs; keep the name).
- Changing the WS dispatch contract.
- Touching the past-run UI or message-log timeline.

## Verification plan

- All existing tests should pass without modification — this is a behavior-preserving refactor.
- The CLI's `workflow inspect` should produce byte-identical output (no new `WebEventBus` log noise; no semantic change).
- `tsc --noEmit` zero new errors.
- Confirm via grep that `workflow-command.ts` no longer imports anything from `src/web-ui/`.

## Why defer

The current state is functionally correct and test-covered. The cleanup is purely architectural: it removes one source of confusion (CLI carrying a web-ui dependency) and restores a clean rule that central code never imports surface code. Worth doing, not urgent.

## Related context

- Original cross-edge introduced in commit `264f135` (unified directory discovery — the CLI inspect refactor pulled in `WorkflowManager` as the canonical loader).
- Audit findings recorded after PR #200 review.
