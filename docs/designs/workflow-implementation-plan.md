# Workflow System: Module Decomposition & Implementation Plan

This document specifies the module boundaries, public interfaces, dependency
graph, test strategies, and implementation phases for the multi-agent workflow
system described in `workflow-implementation-final.md`.

The organizing principle: **the orchestrator is testable with mock sessions.**
Every dependency the orchestrator touches is injected through a deps object.
No module reaches outside its boundary for I/O unless that I/O is explicitly
part of its contract.

---

## Module Map

```
src/workflow/
  types.ts              # Module 1: shared types (WorkflowContext, events, IDs)
  definition.ts         # Module 1: WorkflowDefinition types + Zod schema
  validate.ts           # Module 1: structural + semantic validation
  status-parser.ts      # Module 2: parseAgentStatus() pure function
  guards.ts             # Module 2: XState guard implementations (pure)
  machine-builder.ts    # Module 3: buildWorkflowMachine()
  artifacts.ts          # Module 4: ArtifactManager (filesystem)
  orchestrator.ts       # Module 5: WorkflowOrchestrator
  prompt-builder.ts     # Module 5 support: buildAgentCommand()
  registration.ts       # Module 5 support: PTY registry file helpers
  gate-types.ts         # Module 1: gate-specific types
  gate-state.ts         # Module 1: gate state management (pure)
  checkpoint.ts         # Module 4: CheckpointStore
  worktree.ts           # Module 4: WorktreeManager

src/mux/
  tab-backend.ts        # Module 6: TabBackend discriminated union
  workflow-tab-backend.ts # Module 6: WorkflowTabBackendImpl
  workflow-tab.ts       # Module 6: tab factory for orchestrator
  workflow-footer.ts    # Module 6: footer progress renderer

test/
  workflow-definition.test.ts
  workflow-status-parser.test.ts
  workflow-guards.test.ts
  workflow-machine.test.ts
  workflow-artifacts.test.ts
  workflow-orchestrator.test.ts
  workflow-gate-state.test.ts
```

---

## Module 1: Workflow Definition & Validation

### Files

- `src/workflow/types.ts` -- shared value types
- `src/workflow/definition.ts` -- schema types + Zod schema
- `src/workflow/validate.ts` -- validation logic
- `src/workflow/gate-types.ts` -- gate-specific types
- `src/workflow/gate-state.ts` -- gate state management

### Dependencies

- `zod` (already a project dependency)
- No internal project imports

### Public Interface

```typescript
// === src/workflow/types.ts ===

/** Branded workflow ID. */
export type WorkflowId = string & { readonly __brand: 'WorkflowId' };

export function createWorkflowId(): WorkflowId;

export interface WorkflowContext {
  readonly taskDescription: string;
  readonly artifacts: Record<string, string>;
  readonly round: number;
  readonly maxRounds: number;
  readonly previousOutputHashes: Record<string, string>;
  readonly previousTestCount: number | null;
  readonly humanPrompt: string | null;
  readonly reviewHistory: readonly string[];
  readonly parallelResults: Record<string, ParallelSlotResult>;
  readonly worktreeBranches: readonly string[];
  readonly totalTokens: number;
  readonly flaggedForReview: boolean;
  readonly lastError: string | null;
  readonly sessionsByRole: Record<string, string>;
}

export interface ParallelSlotResult {
  readonly key: string;
  readonly status: 'success' | 'failed';
  readonly error?: string;
  readonly worktreeBranch?: string;
}

export interface AgentOutput {
  readonly completed: boolean;
  readonly verdict: 'approved' | 'rejected' | 'blocked' | 'spec_flaw';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly escalation: string | null;
  readonly testCount: number | null;
  readonly notes: string | null;
}

export type WorkflowEvent =
  | { type: 'AGENT_COMPLETED'; output: AgentOutput }
  | { type: 'AGENT_FAILED'; error: string }
  | { type: 'VALIDATION_PASSED'; testCount: number }
  | { type: 'VALIDATION_FAILED'; errors: string }
  | { type: 'STALL_DETECTED' }
  | { type: 'SPEC_FLAW_DETECTED' }
  | { type: 'HUMAN_APPROVE'; prompt?: string }
  | { type: 'HUMAN_FORCE_REVISION'; prompt?: string }
  | { type: 'HUMAN_REPLAN'; prompt?: string }
  | { type: 'HUMAN_ABORT' }
  | { type: 'PARALLEL_ALL_COMPLETED'; results: ParallelSlotResult[] }
  | { type: 'PARALLEL_SLOT_FAILED'; key: string; error: string }
  | { type: 'MERGE_SUCCEEDED' }
  | { type: 'MERGE_CONFLICT'; conflictDetails: string };

/** Read-only status exposed to the TUI and tests. */
export type WorkflowStatus =
  | { readonly phase: 'running'; readonly currentState: string; readonly round: number }
  | { readonly phase: 'waiting_human'; readonly gate: HumanGateRequest }
  | { readonly phase: 'completed'; readonly finalArtifacts: Record<string, string> }
  | { readonly phase: 'failed'; readonly error: string; readonly lastState: string }
  | { readonly phase: 'aborted'; readonly reason: string };

export interface AgentSlot {
  readonly stateId: string;
  readonly persona: string;
  readonly parallelKey?: string;
}

/** Lifecycle events emitted by the orchestrator. */
export type WorkflowLifecycleEvent =
  | { readonly kind: 'state_entered'; readonly workflowId: WorkflowId; readonly state: string }
  | { readonly kind: 'completed'; readonly workflowId: WorkflowId }
  | { readonly kind: 'failed'; readonly workflowId: WorkflowId; readonly error: string }
  | { readonly kind: 'gate_raised'; readonly workflowId: WorkflowId; readonly gate: HumanGateRequest }
  | { readonly kind: 'gate_dismissed'; readonly workflowId: WorkflowId; readonly gateId: string };

/** The public controller interface exposed to the mux. */
export interface WorkflowController {
  start(definitionPath: string, taskDescription: string): Promise<WorkflowId>;
  getStatus(id: WorkflowId): WorkflowStatus | undefined;
  listActive(): readonly WorkflowId[];
  resolveGate(id: WorkflowId, event: HumanGateEvent, prompt?: string): void;
  abort(id: WorkflowId): Promise<void>;
  onEvent(callback: (event: WorkflowLifecycleEvent) => void): void;
  shutdownAll(): Promise<void>;
}

/** Handle returned to the orchestrator for writing to a workflow tab. */
export interface WorkflowTabHandle {
  write(text: string): void;
  setLabel(label: string): void;
  close(): void;
  readonly tabNumber: number;
}

// === src/workflow/definition.ts ===

export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly states: Record<string, WorkflowStateDefinition>;
  readonly settings?: WorkflowSettings;
}

export interface WorkflowSettings {
  readonly mode?: 'docker' | 'builtin';
  readonly dockerAgent?: string;
  readonly maxRounds?: number;
  readonly gitRepoPath?: string;
  readonly maxParallelism?: number;
}

export type WorkflowStateDefinition =
  | AgentStateDefinition
  | HumanGateStateDefinition
  | DeterministicStateDefinition
  | TerminalStateDefinition;

export interface AgentStateDefinition {
  readonly type: 'agent';
  readonly persona: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly transitions: readonly TransitionDefinition[];
  readonly parallelKey?: string;
  readonly worktree?: boolean;
}

export interface HumanGateStateDefinition {
  readonly type: 'human_gate';
  readonly acceptedEvents: readonly HumanGateEventType[];
  readonly present?: readonly string[];
  readonly transitions: readonly HumanGateTransition[];
}

export interface HumanGateTransition {
  readonly to: string;
  readonly event: HumanGateEventType;
}

export interface DeterministicStateDefinition {
  readonly type: 'deterministic';
  readonly run: readonly (readonly string[])[];
  readonly transitions: readonly TransitionDefinition[];
}

export interface TerminalStateDefinition {
  readonly type: 'terminal';
  readonly outputs?: readonly string[];
  readonly cleanup?: readonly (readonly string[])[];
}

export interface TransitionDefinition {
  readonly to: string;
  readonly guard?: string;
  readonly flag?: string;
}

export type HumanGateEventType = 'APPROVE' | 'FORCE_REVISION' | 'REPLAN' | 'ABORT';

/** Zod schema for parsing raw JSON into WorkflowDefinition. */
export const workflowDefinitionSchema: z.ZodType<WorkflowDefinition>;

// === src/workflow/validate.ts ===

/** Set of guard names the machine builder registers. */
export const REGISTERED_GUARDS: ReadonlySet<string>;

/**
 * Validates a raw JSON object as a WorkflowDefinition.
 * Performs structural parsing (Zod) then semantic checks:
 * - All transition targets reference existing states
 * - All guard names are in REGISTERED_GUARDS
 * - All required artifact inputs exist in some state's outputs (or optional with `?`)
 * - Initial state exists
 * - At least one terminal state exists
 * - HumanGateTransition.event values are in their parent's acceptedEvents
 * - No unreachable states (BFS from initial)
 *
 * @throws {WorkflowValidationError} with structured list of issues
 */
export function validateDefinition(raw: unknown): WorkflowDefinition;

export class WorkflowValidationError extends Error {
  readonly issues: readonly string[];
}

// === src/workflow/gate-types.ts ===

export type GateEventType = 'APPROVE' | 'FORCE_REVISION' | 'REPLAN' | 'ABORT';

export interface HumanGateRequest {
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly GateEventType[];
  readonly presentedArtifacts: ReadonlyMap<string, string>;
  readonly summary: string;
}

export interface HumanGateEvent {
  readonly type: GateEventType;
  readonly prompt?: string;
}

export interface GateResolution {
  readonly event: GateEventType;
  readonly prompt?: string;
}

// === src/workflow/gate-state.ts ===

export interface PendingGate {
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly GateEventType[];
  readonly presentedArtifacts: ReadonlyMap<string, string>;
  readonly summary: string;
  readonly raisedAt: Date;
  readonly displayNumber: number;
}

export interface GateState {
  readonly pendingGates: ReadonlyMap<number, PendingGate>;
  readonly nextGateNumber: number;
}

export function createInitialGateState(): GateState;
export function addGate(state: GateState, request: HumanGateRequest): GateState;
export function removeGate(state: GateState, displayNumber: number): GateState;
export function findGateByWorkflow(state: GateState, workflowId: string): PendingGate | undefined;
```

### Injection Points

None. This module is pure data -- no I/O, no services, no state.

### Test Strategy

**File:** `test/workflow-definition.test.ts`

Pure data-in, data-out tests. No mocks needed.

```typescript
// Validate a well-formed definition
it('accepts a valid 4-state workflow', () => {
  const def = validateDefinition(validFixture);
  expect(def.name).toBe('code-review');
  expect(Object.keys(def.states)).toHaveLength(4);
});

// Structural validation failures
it('rejects definition with missing initial state', () => {
  expect(() => validateDefinition({ ...validFixture, initial: 'nonexistent' }))
    .toThrow(WorkflowValidationError);
});

it('rejects unregistered guard name', () => {
  const bad = deepClone(validFixture);
  bad.states.plan.transitions[0].guard = 'doesNotExist';
  expect(() => validateDefinition(bad)).toThrow(/guard/);
});

it('rejects unreachable states', () => { /* ... */ });
it('rejects missing artifact dependency', () => { /* ... */ });
it('rejects gate transition with event not in acceptedEvents', () => { /* ... */ });

// Gate state management (pure functions)
it('addGate assigns incrementing display numbers', () => { /* ... */ });
it('removeGate preserves other gates', () => { /* ... */ });
```

### Implementation Order

**Phase 1** -- implement first. No dependencies on anything else.

---

## Module 2: Transition Middleware

### Files

- `src/workflow/status-parser.ts` -- YAML status block extraction
- `src/workflow/guards.ts` -- XState guard function implementations

### Dependencies

- `src/workflow/types.ts` (Module 1)
- `zod` (for AgentOutput validation)
- No external project imports

### Public Interface

```typescript
// === src/workflow/status-parser.ts ===

/**
 * Extracts and parses an agent_status YAML block from response text.
 *
 * Looks for a fenced code block containing `agent_status:` at the start.
 * Parses key-value pairs with a simple line-based parser (no yaml dependency).
 * Validates parsed object against Zod schema.
 *
 * @returns parsed AgentOutput, or undefined if no status block found
 * @throws {AgentStatusParseError} if block found but malformed
 */
export function parseAgentStatus(responseText: string): AgentOutput | undefined;

export class AgentStatusParseError extends Error {
  readonly rawBlock: string;
}

/**
 * Converts an AgentOutput into the XState event the machine expects.
 * Pure mapping -- no I/O.
 */
export function agentOutputToEvent(output: AgentOutput): WorkflowEvent;

/**
 * Instruction text appended to agent commands, telling the agent
 * to include an agent_status block in its response.
 */
export const STATUS_BLOCK_INSTRUCTIONS: string;

// === src/workflow/guards.ts ===

/**
 * Guard function registry. Each function matches the XState guard signature:
 *   ({ context, event }) => boolean
 *
 * These are the concrete implementations registered in buildWorkflowMachine().
 * Exported separately so they can be unit-tested without XState.
 */
export const guardImplementations: Readonly<Record<string, GuardFunction>>;

type GuardFunction = (params: {
  context: WorkflowContext;
  event: WorkflowEvent;
}) => boolean;

/**
 * Extracts AgentOutput from an XState done event payload.
 * Returns undefined if the event is not a done event or has no output.
 */
export function extractAgentOutput(event: unknown): AgentOutput | undefined;

/**
 * Extracts the full AgentInvokeResult from an XState done event.
 */
export function extractInvokeResult(event: unknown): AgentInvokeResult | undefined;

/**
 * Extracts the stateId from an XState done event's output.
 */
export function extractStateId(event: unknown): string | undefined;
```

### Injection Points

None. All pure functions.

### Test Strategy

**Files:** `test/workflow-status-parser.test.ts`, `test/workflow-guards.test.ts`

No mocks needed -- these are pure functions with zero I/O.

```typescript
// === status-parser tests ===
describe('parseAgentStatus', () => {
  it('extracts status from response with surrounding text', () => {
    const text = 'I completed the task.\n```\nagent_status:\n  completed: true\n  verdict: approved\n  confidence: high\n  escalation: null\n  test_count: 42\n  notes: "all good"\n```';
    const result = parseAgentStatus(text);
    expect(result).toEqual({
      completed: true,
      verdict: 'approved',
      confidence: 'high',
      escalation: null,
      testCount: 42,
      notes: 'all good',
    });
  });

  it('returns undefined when no status block present', () => {
    expect(parseAgentStatus('just some text')).toBeUndefined();
  });

  it('throws AgentStatusParseError on malformed block', () => {
    const text = '```\nagent_status:\n  completed: maybe\n```';
    expect(() => parseAgentStatus(text)).toThrow(AgentStatusParseError);
  });

  it('handles null test_count', () => { /* ... */ });
  it('handles spec_flaw verdict', () => { /* ... */ });
});

// === guard tests ===
describe('guards', () => {
  const { isApproved, isRejected, isRoundLimitReached, isStalled,
          hasTestCountRegression, isLowConfidence } = guardImplementations;

  it('isApproved returns true for approved verdict', () => {
    const event = makeDoneEvent({ verdict: 'approved', confidence: 'high' });
    expect(isApproved({ context: baseContext, event })).toBe(true);
  });

  it('isStalled detects same hash for same state', () => {
    const ctx = { ...baseContext, previousOutputHashes: { 'coder': 'abc123' } };
    const event = makeDoneEvent({ notes: '' }, { stateId: 'coder', outputHash: 'abc123' });
    expect(isStalled({ context: ctx, event })).toBe(true);
  });

  it('isStalled returns false for different state with same hash', () => {
    const ctx = { ...baseContext, previousOutputHashes: { 'reviewer': 'abc123' } };
    const event = makeDoneEvent({}, { stateId: 'coder', outputHash: 'abc123' });
    expect(isStalled({ context: ctx, event })).toBe(false);
  });

  it('hasTestCountRegression detects count decrease', () => { /* ... */ });
  it('isLowConfidence detects approved+low', () => { /* ... */ });
});
```

### Implementation Order

**Phase 1** -- implement alongside Module 1 (no dependency between them).

---

## Module 3: XState Machine Builder

### Files

- `src/workflow/machine-builder.ts`

### Dependencies

- `xstate` (external -- `setup`, `assign`, `fromPromise`, `createActor`)
- `src/workflow/types.ts` (Module 1)
- `src/workflow/definition.ts` (Module 1)
- `src/workflow/guards.ts` (Module 2)

### Public Interface

```typescript
// === src/workflow/machine-builder.ts ===

/** Input provided to each invoked agent service. */
export interface AgentInvokeInput {
  readonly stateId: string;
  readonly stateConfig: AgentStateDefinition;
  readonly context: WorkflowContext;
}

/** Result returned by an agent service promise. */
export interface AgentInvokeResult {
  readonly output: AgentOutput;
  readonly sessionId: string;
  readonly artifacts: Record<string, string>;
  readonly outputHash: string;
}

/** Result from a deterministic (test/lint) state. */
export interface DeterministicInvokeResult {
  readonly passed: boolean;
  readonly testCount?: number;
  readonly errors?: string;
}

/**
 * Builds an XState v5 machine from a WorkflowDefinition.
 *
 * The returned machine has placeholder actors (`agentService`,
 * `deterministicService`) that throw if invoked directly. Callers
 * must call `.provide({ actors: { ... } })` to inject real
 * implementations before passing to `createActor()`.
 *
 * Guards are registered with their concrete implementations from
 * Module 2. Actions (context updates) are defined inline.
 *
 * @param definition - validated workflow definition
 * @param taskDescription - user's task, baked into initial context
 * @returns XState machine config ready for `.provide()`
 */
export function buildWorkflowMachine(
  definition: WorkflowDefinition,
  taskDescription: string,
): ReturnType<typeof setup>;

/**
 * Creates the initial WorkflowContext for a given definition.
 * Exported for testing -- the orchestrator does not call this directly.
 */
export function createInitialContext(
  definition: WorkflowDefinition,
): Omit<WorkflowContext, 'taskDescription'>;
```

### Injection Points

The machine's `actors` field contains placeholder implementations. Real
services are injected via XState's `.provide()` mechanism at the call site
(the orchestrator). This is XState's standard pattern for dependency injection
and what makes the machine testable in isolation.

### Test Strategy

**File:** `test/workflow-machine.test.ts`

Tests create real XState actors with mock services injected via `.provide()`.
No filesystem, no network, no LLM calls. Events are sent programmatically.

```typescript
describe('buildWorkflowMachine', () => {
  const definition = loadFixture('simple-workflow.json');

  it('transitions plan -> design on approved verdict', async () => {
    const machine = buildWorkflowMachine(definition, 'build a thing');
    const provided = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }) => ({
          output: { completed: true, verdict: 'approved', confidence: 'high',
                    escalation: null, testCount: null, notes: null },
          sessionId: 'test-session',
          artifacts: { plan: '/tmp/plan' },
          outputHash: 'hash1',
        })),
        deterministicService: fromPromise(async () => ({
          passed: true, testCount: 10,
        })),
      },
    });

    const actor = createActor(provided);
    const states: string[] = [];

    actor.subscribe((snap) => {
      states.push(String(snap.value));
    });
    actor.start();

    // Wait for machine to settle (agent service resolves immediately)
    await new Promise((r) => setTimeout(r, 50));

    // Verify plan state was entered and transitioned to design
    expect(states).toContain('plan');
    expect(states).toContain('design');
  });

  it('pauses at human_gate until event is sent', async () => {
    // Use a definition where plan -> gate -> design
    const machine = buildWorkflowMachine(gatedDefinition, 'task');
    const provided = machine.provide({ /* mock agents */ });
    const actor = createActor(provided);
    actor.start();

    // Wait for plan to complete -> enters gate
    await new Promise((r) => setTimeout(r, 50));
    expect(actor.getSnapshot().matches('review_gate')).toBe(true);

    // Send human event
    actor.send({ type: 'HUMAN_APPROVE' });
    await new Promise((r) => setTimeout(r, 50));
    expect(actor.getSnapshot().matches('design')).toBe(true);
  });

  it('increments round on each agent completion', async () => { /* ... */ });
  it('detects stall via per-role hash comparison', async () => { /* ... */ });
  it('routes to error state on invoke rejection', async () => { /* ... */ });
  it('context factory includes taskDescription', () => { /* ... */ });
});
```

### Implementation Order

**Phase 2** -- requires Module 1 (types) and Module 2 (guards).

---

## Module 4: Artifact Manager & Checkpoint Store

### Files

- `src/workflow/artifacts.ts`
- `src/workflow/checkpoint.ts`
- `src/workflow/worktree.ts`

### Dependencies

- `node:fs`, `node:path`, `node:crypto` (Node builtins)
- `node:child_process` (`execFile` for worktree)
- `src/workflow/types.ts` (Module 1)
- `src/workflow/definition.ts` (Module 1)

### Public Interface

```typescript
// === src/workflow/artifacts.ts ===

export interface ArtifactManager {
  /**
   * Returns the base directory for all artifacts in a workflow.
   */
  readonly artifactDir: string;

  /**
   * Writes the initial task description artifact.
   */
  writeTaskDescription(taskDescription: string): void;

  /**
   * Checks that all expected output artifacts exist as non-empty directories.
   * @returns names of missing artifacts
   */
  verifyOutputs(expectedOutputs: readonly string[]): readonly string[];

  /**
   * Builds a re-prompt message for missing artifacts.
   * Uses relative paths (agents see `/workspace`, not the host path).
   */
  buildArtifactReprompt(missing: readonly string[]): string;

  /**
   * Computes a SHA-256 hash of all files in the given output directories.
   * Deterministic: files are sorted by name before hashing.
   */
  computeOutputHash(outputNames: readonly string[]): string;

  /**
   * Collects artifact paths: maps output names to their host-side
   * directory paths.
   */
  collectArtifactPaths(outputNames: readonly string[]): Record<string, string>;

  /**
   * Reads the content of an artifact file. Used by prompt builder
   * to assemble input artifacts into agent commands.
   * @returns file contents, or undefined if file does not exist
   */
  readArtifact(artifactName: string, fileName: string): string | undefined;
}

/**
 * Creates an ArtifactManager rooted at the given workflow directory.
 * Creates the artifacts/ subdirectory if it does not exist.
 */
export function createArtifactManager(workflowDir: string): ArtifactManager;

// === src/workflow/checkpoint.ts ===

export interface WorkflowCheckpoint {
  readonly machineState: unknown;
  readonly context: WorkflowContext;
  readonly timestamp: string;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly definitionPath: string;
}

export interface TransitionRecord {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly duration_ms: number;
}

export interface CheckpointStore {
  save(workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void;
  load(workflowId: WorkflowId): WorkflowCheckpoint | undefined;
  listAll(): readonly WorkflowId[];
  remove(workflowId: WorkflowId): void;
}

/**
 * Creates a filesystem-backed checkpoint store.
 * Checkpoints are stored at `{baseDir}/{workflowId}/checkpoint.json`.
 */
export function createCheckpointStore(baseDir: string): CheckpointStore;

// === src/workflow/worktree.ts ===

export type MergeResult =
  | { readonly status: 'clean'; readonly commitHash: string }
  | { readonly status: 'conflict'; readonly conflictFiles: readonly string[] };

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly parallelKey: string;
}

export interface WorktreeManager {
  create(repoPath: string, branchName: string, baseBranch: string): Promise<string>;
  merge(repoPath: string, branchName: string, baseBranch: string): Promise<MergeResult>;
  remove(worktreePath: string, deleteBranch?: boolean): Promise<void>;
  listActive(): readonly WorktreeInfo[];
}

/**
 * Creates a WorktreeManager that stores worktrees under the given directory.
 * All git operations use `execFile` with argument arrays (never shell strings).
 */
export function createWorktreeManager(worktreeBaseDir: string): WorktreeManager;
```

### Injection Points

`ArtifactManager` and `CheckpointStore` are created by factory functions.
The orchestrator receives them via its deps or creates them internally
from a base directory path. `WorktreeManager` is similarly factored.

For orchestrator testing, these can be replaced with in-memory implementations
or pointed at `/tmp` directories.

### Test Strategy

**File:** `test/workflow-artifacts.test.ts`

Uses real temp directories in `/tmp/`. No mocks.

```typescript
describe('ArtifactManager', () => {
  let manager: ArtifactManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'wf-artifacts-'));
    manager = createArtifactManager(tmpDir);
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('writeTaskDescription creates task/description.md', () => {
    manager.writeTaskDescription('Build a REST API');
    const content = readFileSync(resolve(tmpDir, 'artifacts/task/description.md'), 'utf-8');
    expect(content).toBe('Build a REST API');
  });

  it('verifyOutputs returns missing artifact names', () => {
    mkdirSync(resolve(tmpDir, 'artifacts/plan'), { recursive: true });
    writeFileSync(resolve(tmpDir, 'artifacts/plan/plan.md'), 'the plan');
    expect(manager.verifyOutputs(['plan', 'spec'])).toEqual(['spec']);
  });

  it('computeOutputHash is deterministic', () => {
    // Create artifacts, compute hash twice, verify identical
  });

  it('computeOutputHash changes when content changes', () => {
    // Write, hash, modify, hash again, verify different
  });

  it('buildArtifactReprompt uses relative paths', () => {
    const prompt = manager.buildArtifactReprompt(['spec', 'api']);
    expect(prompt).toContain('`spec/`');
    expect(prompt).not.toContain(tmpDir); // no host paths
  });
});
```

### Implementation Order

**Phase 4** -- independent of the orchestrator. Can be built and tested
in parallel with Module 3.

---

## Module 5: Orchestrator

### Files

- `src/workflow/orchestrator.ts` -- the composition root
- `src/workflow/prompt-builder.ts` -- `buildAgentCommand()`
- `src/workflow/registration.ts` -- PTY registry helpers

### Dependencies

- `src/workflow/types.ts` (Module 1)
- `src/workflow/definition.ts` (Module 1)
- `src/workflow/validate.ts` (Module 1)
- `src/workflow/status-parser.ts` (Module 2)
- `src/workflow/guards.ts` (Module 2)
- `src/workflow/machine-builder.ts` (Module 3)
- `src/workflow/artifacts.ts` (Module 4)
- `src/workflow/checkpoint.ts` (Module 4)
- `src/session/types.ts` (Session, SessionOptions, SessionMode)
- `xstate` (`createActor`, `fromPromise`)
- `node:fs`, `node:path`

### Public Interface

```typescript
// === src/workflow/orchestrator.ts ===

/**
 * All external dependencies the orchestrator needs, provided at construction.
 * Every field is injectable for testing.
 */
export interface WorkflowOrchestratorDeps {
  /** Factory for creating sessions. Wraps the real createSession(). */
  readonly createSession: (opts: SessionOptions) => Promise<Session>;

  /** Factory for creating read-only workflow tabs in the mux. */
  readonly createWorkflowTab: (label: string, workflowId: WorkflowId) => WorkflowTabHandle;

  /** Callback when a human gate is raised. */
  readonly raiseHumanGate: (gate: HumanGateRequest) => void;

  /** Callback when a human gate is dismissed. */
  readonly dismissHumanGate: (gateId: string) => void;

  /** Base directory for workflow data. Default: ~/.ironcurtain/workflows/ */
  readonly workflowBaseDir: string;

  /**
   * Optional: override artifact manager creation for testing.
   * When omitted, createArtifactManager() is used.
   */
  readonly createArtifactManager?: (workflowDir: string) => ArtifactManager;

  /**
   * Optional: override checkpoint store creation for testing.
   * When omitted, createCheckpointStore() is used.
   */
  readonly createCheckpointStore?: (baseDir: string) => CheckpointStore;
}

/**
 * The orchestrator. Creates sessions, drives the XState machine,
 * manages artifacts, handles gates.
 *
 * Implements WorkflowController for the mux to consume.
 */
export class WorkflowOrchestrator implements WorkflowController {
  constructor(deps: WorkflowOrchestratorDeps);

  start(definitionPath: string, taskDescription: string): Promise<WorkflowId>;
  getStatus(id: WorkflowId): WorkflowStatus | undefined;
  listActive(): readonly WorkflowId[];
  resolveGate(id: WorkflowId, event: HumanGateEvent, prompt?: string): void;
  abort(id: WorkflowId): Promise<void>;
  onEvent(callback: (event: WorkflowLifecycleEvent) => void): void;
  shutdownAll(): Promise<void>;
}

// === src/workflow/prompt-builder.ts ===

/**
 * Builds the command text sent to an agent session.
 *
 * Assembles: task description, input artifact contents (read from disk),
 * review history, human prompt (if any), and status block instructions.
 *
 * Input artifacts marked with trailing `?` are optional -- missing ones
 * are silently skipped.
 */
export function buildAgentCommand(
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  artifactManager: ArtifactManager,
): string;

// === src/workflow/registration.ts ===

/**
 * Writes a PTY-compatible session registration file so
 * MuxEscalationManager can discover workflow agent sessions.
 */
export function writeWorkflowRegistration(
  sessionId: string,
  persona?: string,
): void;

/**
 * Removes the registration file. Safe to call if already removed.
 */
export function removeWorkflowRegistration(sessionId: string): void;
```

### Injection Points

Everything the orchestrator touches externally comes through
`WorkflowOrchestratorDeps`. This is the key design decision that makes
the orchestrator testable without Docker, MCP servers, or LLM calls.

| What | Injected via | Test replacement |
|------|-------------|-----------------|
| Session creation | `deps.createSession` | Returns `MockSession` |
| Tab creation | `deps.createWorkflowTab` | Returns `MockTabHandle` |
| Gate notification | `deps.raiseHumanGate` | `vi.fn()` spy |
| Gate dismissal | `deps.dismissHumanGate` | `vi.fn()` spy |
| Artifact storage | `deps.createArtifactManager` | Real, pointed at `/tmp` |
| Checkpoint store | `deps.createCheckpointStore` | In-memory stub |
| Filesystem (definitions) | Read via `readFileSync` | Fixtures in `/tmp` |

### Test Strategy: MockSession

The `MockSession` is the critical testing tool. It implements the `Session`
interface and lets tests script agent responses.

```typescript
// === test/helpers/mock-session.ts ===

import type { Session, SessionInfo, ConversationTurn,
  DiagnosticEvent, EscalationRequest, BudgetStatus } from '../../src/session/types.js';

/**
 * A response function receives the message text and returns
 * the agent's response. Allows tests to vary responses based
 * on the input.
 */
export type ResponseFunction = (message: string) => Promise<string> | string;

export interface MockSessionOptions {
  /** Canned responses returned in order, or a function. */
  readonly responses: readonly string[] | ResponseFunction;
  /** Session ID. Defaults to a test UUID. */
  readonly sessionId?: string;
}

export class MockSession implements Session {
  /** All messages sent to this session, in order. */
  readonly sentMessages: string[] = [];
  /** Whether close() was called. */
  closed = false;

  private readonly responses: readonly string[] | ResponseFunction;
  private responseIndex = 0;
  private readonly sessionId: string;

  constructor(options: MockSessionOptions) {
    this.responses = options.responses;
    this.sessionId = options.sessionId ?? `mock-session-${crypto.randomUUID()}`;
  }

  getInfo(): SessionInfo {
    return {
      id: this.sessionId as any,
      status: this.closed ? 'closed' : 'ready',
      turnCount: this.sentMessages.length,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async sendMessage(userMessage: string): Promise<string> {
    this.sentMessages.push(userMessage);

    if (typeof this.responses === 'function') {
      return this.responses(userMessage);
    }

    if (this.responseIndex >= this.responses.length) {
      throw new Error(
        `MockSession exhausted: received message ${this.responseIndex + 1} ` +
        `but only ${this.responses.length} responses were provided`
      );
    }
    return this.responses[this.responseIndex++];
  }

  getHistory(): readonly ConversationTurn[] { return []; }
  getDiagnosticLog(): readonly DiagnosticEvent[] { return []; }
  async resolveEscalation(): Promise<void> {}
  getPendingEscalation(): EscalationRequest | undefined { return undefined; }
  getBudgetStatus(): BudgetStatus {
    return {
      totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
      stepCount: 0, elapsedSeconds: 0, estimatedCostUsd: 0,
      limits: {} as any, cumulative: {} as any, tokenTrackingAvailable: false,
    };
  }
  async close(): Promise<void> { this.closed = true; }
}
```

### Test Strategy: Orchestrator Integration

**File:** `test/workflow-orchestrator.test.ts`

This is the "big" test. It drives a complete workflow through all states
using mock sessions. No Docker, no LLM, no real MCP servers.

```typescript
// === test/workflow-orchestrator.test.ts ===

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowOrchestrator } from '../src/workflow/orchestrator.js';
import type { WorkflowOrchestratorDeps } from '../src/workflow/orchestrator.js';
import type { WorkflowId, WorkflowTabHandle } from '../src/workflow/types.js';
import type { HumanGateRequest } from '../src/workflow/gate-types.js';
import { MockSession } from './helpers/mock-session.js';

/** Status block helpers for building canned responses. */
function approvedResponse(notes = 'done'): string {
  return `I completed the task.\n\`\`\`\nagent_status:\n  completed: true\n  verdict: approved\n  confidence: high\n  escalation: null\n  test_count: null\n  notes: "${notes}"\n\`\`\``;
}

function rejectedResponse(notes: string): string {
  return `Found issues.\n\`\`\`\nagent_status:\n  completed: true\n  verdict: rejected\n  confidence: high\n  escalation: null\n  test_count: null\n  notes: "${notes}"\n\`\`\``;
}

describe('WorkflowOrchestrator', () => {
  let tmpDir: string;
  let definitionPath: string;
  let sessions: MockSession[];
  let tabHandles: MockTabHandle[];
  let gateRequests: HumanGateRequest[];

  // The workflow definition for tests:
  // plan (agent) -> review_gate (human) -> implement (agent) -> test (deterministic) -> done
  const testDefinition = {
    name: 'test-workflow',
    description: 'A test workflow',
    initial: 'plan',
    settings: { mode: 'builtin' },
    states: {
      plan: {
        type: 'agent',
        persona: 'planner',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'review_gate' }],
      },
      review_gate: {
        type: 'human_gate',
        acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
        present: ['plan'],
        transitions: [
          { to: 'implement', event: 'APPROVE' },
          { to: 'plan', event: 'FORCE_REVISION' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      implement: {
        type: 'agent',
        persona: 'coder',
        inputs: ['plan'],
        outputs: ['code'],
        transitions: [{ to: 'test' }],
      },
      test: {
        type: 'deterministic',
        run: [['npm', 'test']],
        transitions: [
          { to: 'done', guard: 'isApproved' },
          { to: 'implement' },
        ],
      },
      done: { type: 'terminal' },
      aborted: { type: 'terminal' },
    },
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'wf-orch-test-'));
    definitionPath = resolve(tmpDir, 'test-workflow.json');
    writeFileSync(definitionPath, JSON.stringify(testDefinition));
    sessions = [];
    tabHandles = [];
    gateRequests = [];
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  function createDeps(overrides?: Partial<WorkflowOrchestratorDeps>): WorkflowOrchestratorDeps {
    return {
      createSession: vi.fn(async (opts) => {
        // Create mock session that returns the next canned response.
        // The response includes a valid status block and creates
        // the expected artifact directory.
        const persona = opts.persona ?? 'unknown';
        const session = new MockSession({
          responses: (msg) => {
            // Simulate artifact creation for the agent's outputs
            const stateOutputs = findOutputsForPersona(persona, testDefinition);
            for (const output of stateOutputs) {
              const dir = resolve(tmpDir, 'artifacts', output);
              mkdirSync(dir, { recursive: true });
              writeFileSync(resolve(dir, `${output}.md`), `content for ${output}`);
            }
            return approvedResponse();
          },
        });
        sessions.push(session);
        return session;
      }),
      createWorkflowTab: vi.fn((label, id) => {
        const handle = new MockTabHandle(label);
        tabHandles.push(handle);
        return handle;
      }),
      raiseHumanGate: vi.fn((gate) => gateRequests.push(gate)),
      dismissHumanGate: vi.fn(),
      workflowBaseDir: tmpDir,
      ...overrides,
    };
  }

  it('drives a workflow from start to completion through a human gate', async () => {
    const deps = createDeps();
    const orchestrator = new WorkflowOrchestrator(deps);

    const workflowId = await orchestrator.start(definitionPath, 'build a REST API');

    // Machine enters 'plan', invokes agent, agent returns approved.
    // Then enters 'review_gate' and pauses.
    // Wait for the gate to be raised.
    await waitForGate(gateRequests, 1);

    expect(gateRequests).toHaveLength(1);
    expect(gateRequests[0].stateName).toBe('review_gate');
    expect(gateRequests[0].acceptedEvents).toContain('APPROVE');

    // Resolve the gate
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    // Machine enters 'implement', invokes coder, then 'test', then 'done'.
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

    // Verify all sessions were closed
    for (const session of sessions) {
      expect(session.closed).toBe(true);
    }
  });

  it('abort closes all active sessions', async () => {
    // Use a slow-responding mock to keep a session active
    const deps = createDeps({
      createSession: vi.fn(async () => {
        const session = new MockSession({
          responses: async () => {
            await new Promise((r) => setTimeout(r, 10_000));
            return approvedResponse();
          },
        });
        sessions.push(session);
        return session;
      }),
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    const id = await orchestrator.start(definitionPath, 'task');

    // Give machine time to enter 'plan' and invoke agent
    await new Promise((r) => setTimeout(r, 100));

    await orchestrator.abort(id);

    // All sessions should be closed
    for (const s of sessions) {
      expect(s.closed).toBe(true);
    }
    expect(orchestrator.getStatus(id)?.phase).toBe('aborted');
  });

  it('retries once when status block is missing', async () => {
    let callCount = 0;
    const deps = createDeps({
      createSession: vi.fn(async (opts) => {
        return new MockSession({
          responses: [
            // First response: no status block
            'I did the thing but forgot the status block',
            // Second response (retry): has status block
            approvedResponse(),
          ],
        });
      }),
    });

    const orchestrator = new WorkflowOrchestrator(deps);
    // Should succeed after retry
    const id = await orchestrator.start(definitionPath, 'task');
    await waitForGate(gateRequests, 1); // reaches the gate after plan
  });

  it('tracks session IDs per role for resumption', async () => {
    // Verify that opts.resumeSessionId is passed on subsequent invocations
    // for the same persona
  });
});

// === test helpers ===

class MockTabHandle implements WorkflowTabHandle {
  closed = false;
  currentLabel: string;
  readonly tabNumber = 1;
  constructor(label: string) { this.currentLabel = label; }
  write(_text: string): void {}
  setLabel(label: string): void { this.currentLabel = label; }
  close(): void { this.closed = true; }
}

function findOutputsForPersona(
  persona: string,
  def: typeof testDefinition
): string[] {
  for (const state of Object.values(def.states)) {
    if ('persona' in state && state.persona === persona && 'outputs' in state) {
      return [...state.outputs];
    }
  }
  return [];
}

async function waitForGate(gates: HumanGateRequest[], count: number, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (gates.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (gates.length < count) {
    throw new Error(`Timed out waiting for ${count} gate(s), got ${gates.length}`);
  }
}

async function waitForCompletion(
  orchestrator: WorkflowOrchestrator,
  id: WorkflowId,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = orchestrator.getStatus(id);
    if (status?.phase === 'completed' || status?.phase === 'failed' || status?.phase === 'aborted') {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Workflow did not complete within ${timeout}ms`);
}
```

### Implementation Order

**Phase 3** -- the core phase. Requires Modules 1-3. Module 4 (artifacts) can
be built in parallel, but the orchestrator needs at least a minimal artifact
manager to function.

---

## Module 6: Mux Integration

### Files

- `src/mux/tab-backend.ts` -- `TabBackend` discriminated union + type guards
- `src/mux/workflow-tab-backend.ts` -- `WorkflowTabBackendImpl`
- `src/mux/workflow-tab.ts` -- tab factory producing `WorkflowTabHandle`
- `src/mux/workflow-footer.ts` -- footer progress renderer

### Dependencies

- `@xterm/headless` (for `WorkflowTabBackendImpl`)
- `src/workflow/types.ts` (Module 1 -- `WorkflowController`, `WorkflowId`, `WorkflowTabHandle`)
- `src/workflow/definition.ts` (Module 1 -- for footer rendering)
- `src/mux/types.ts` (existing)

### Public Interface

```typescript
// === src/mux/tab-backend.ts ===

import type { Terminal as TerminalType } from '@xterm/headless';
import type { PtySessionRegistration } from '../docker/pty-types.js';

export interface PtyBackend {
  readonly kind: 'pty';
  readonly terminal: TerminalType;
  readonly sessionId: string | undefined;
  readonly escalationDir: string | undefined;
  readonly alive: boolean;
  readonly exitCode: number | undefined;
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onOutput(callback: () => void): void;
  onExit(callback: (exitCode: number) => void): void;
  onSessionDiscovered(callback: (reg: PtySessionRegistration | null) => void): void;
  updateRegistration(registration: PtySessionRegistration): void;
}

export interface WorkflowBackend {
  readonly kind: 'workflow';
  readonly terminal: TerminalType;
  readonly sessionId: string | undefined;
  readonly escalationDir: string | undefined;
  readonly alive: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onOutput(callback: () => void): void;
}

export type TabBackend = PtyBackend | WorkflowBackend;

export function isPtyBackend(backend: TabBackend): backend is PtyBackend;
export function isWorkflowBackend(backend: TabBackend): backend is WorkflowBackend;

// === src/mux/workflow-tab-backend.ts ===

/**
 * Creates a WorkflowBackend backed by a headless xterm terminal.
 * The orchestrator writes progress text to it; the mux renderer
 * reads the terminal buffer for display.
 */
export function createWorkflowTabBackend(cols: number, rows: number): WorkflowBackend;

// === src/mux/workflow-tab.ts ===

/**
 * Creates a workflow tab factory bound to a MuxApp's tab array.
 * Returns a function matching the `WorkflowOrchestratorDeps.createWorkflowTab`
 * signature.
 *
 * Each call creates a new WorkflowTabBackendImpl, wraps it in a MuxTab,
 * appends to the tab array, and returns a WorkflowTabHandle.
 */
export function createWorkflowTabFactory(
  tabs: MuxTab[],
  cols: number,
  rows: number,
  onTabCreated: () => void,
): (label: string, workflowId: WorkflowId) => WorkflowTabHandle;

// === src/mux/workflow-footer.ts ===

/**
 * Renders a compact workflow progress line for the footer.
 *
 * Format: [plan] -> [>design] -> [implement] -> [review] -> [done]
 * The `>` prefix marks the current state. Completed states are dimmed.
 * Truncated to fit `cols` width.
 */
export function renderWorkflowProgress(
  status: WorkflowStatus,
  definition: WorkflowDefinition,
  cols: number,
): string;
```

### Injection Points

The workflow tab factory receives the MuxApp's tab array and a callback
as closure parameters. The orchestrator never imports mux internals
directly -- it calls the factory function provided in its deps.

### Changes to Existing Code

These are the only existing files that need modification:

| File | Change | Reason |
|------|--------|--------|
| `src/mux/types.ts` | `bridge: PtyBridge` -> `backend: TabBackend`; add `workflowId?`; add `gate-picker` to InputMode | Tab backend unification |
| `src/mux/pty-bridge.ts` | Add `kind: 'pty'` to returned object | Discriminated union |
| `src/mux/mux-app.ts` | 6 call sites: `bridge` -> `backend` with `isPtyBackend()` guards; create orchestrator; handle `/workflow` commands | Integration |
| `src/mux/mux-renderer.ts` | `bridge` -> `backend`; footer progress line | Rendering |
| `src/mux/mux-input-handler.ts` | `isPtyBackend()` before keystroke forwarding; `gate-picker` mode | Input handling |
| `src/mux/mux-escalation-manager.ts` | `isPtyBackend()` for PID matching | Type safety |

### Test Strategy

**File:** `test/workflow-footer.test.ts` (pure rendering, no mocks)

The mux integration layer is thin -- most of the logic being tested is in
the orchestrator (Module 5). The mux tests verify:

1. `renderWorkflowProgress` produces correct ANSI output for various states
2. `createWorkflowTabFactory` creates tabs with correct structure
3. Existing mux tests still pass after `bridge` -> `backend` refactor

### Implementation Order

**Phase 5** -- the final phase. Requires all other modules. This is
intentionally last because it touches existing code and requires the
orchestrator to be complete.

---

## Dependency Graph

```
Module 1: types, definition, validate, gate-types, gate-state
  |    (no dependencies -- pure data)
  |
  v
Module 2: status-parser, guards
  |    (depends on Module 1 types only)
  |
  v
Module 3: machine-builder
  |    (depends on Modules 1+2, xstate)
  |
  +-----+
  |     |
  v     v
Module 4: artifacts, checkpoint, worktree    Module 5: orchestrator
  |    (depends on Module 1, node:fs)          |    (depends on 1+2+3+4, Session interface)
  |                                            |
  +------- both feed into --------+            |
                                               v
                                  Module 6: mux integration
                                    (depends on Module 1 types,
                                     Module 5 WorkflowController)
```

All arrows point downward. No circular dependencies. The mux depends on
the workflow system only through the `WorkflowController` interface and
value types. The workflow system depends on sessions only through the
`Session` interface.

---

## Implementation Phases

### Phase 1: Foundation (Types + Validation + Transition Middleware)

**Modules:** 1 + 2

**What ships:** All types, Zod schemas, validation, status parser, guards,
gate state management.

**New files:**
- `src/workflow/types.ts`
- `src/workflow/definition.ts`
- `src/workflow/validate.ts`
- `src/workflow/gate-types.ts`
- `src/workflow/gate-state.ts`
- `src/workflow/status-parser.ts`
- `src/workflow/guards.ts`
- `test/workflow-definition.test.ts`
- `test/workflow-status-parser.test.ts`
- `test/workflow-guards.test.ts`
- `test/workflow-gate-state.test.ts`

**Test command:** `npm test -- test/workflow-definition.test.ts test/workflow-status-parser.test.ts test/workflow-guards.test.ts test/workflow-gate-state.test.ts`

**Existing files modified:** None.

**Exit criteria:** All pure function tests pass. `validateDefinition()` accepts
the reference workflow fixture and rejects all known-bad variants.
`parseAgentStatus()` handles all edge cases from the design doc.

### Phase 2: Machine (XState Machine Builder)

**Modules:** 3

**What ships:** `buildWorkflowMachine()` -- translates definitions into XState
machines with placeholder actors.

**New files:**
- `src/workflow/machine-builder.ts`
- `test/workflow-machine.test.ts`
- `test/fixtures/simple-workflow.json` (test fixture)
- `test/fixtures/gated-workflow.json` (test fixture)

**New dependency:** `xstate@^5` in `package.json`.

**Existing files modified:** None.

**Exit criteria:** XState actors created from test fixtures transition
correctly when mock services resolve. Human gates pause and resume on
event. Round counter increments. Stall detection triggers on matching
per-role hashes.

### Phase 3: Core (Orchestrator with Mock Sessions)

**Modules:** 5 (+ minimal Module 4 for artifacts)

**What ships:** `WorkflowOrchestrator` class. The composition root that
ties everything together.

**New files:**
- `src/workflow/orchestrator.ts`
- `src/workflow/prompt-builder.ts`
- `src/workflow/registration.ts`
- `src/workflow/artifacts.ts` (at least `createArtifactManager()`)
- `test/workflow-orchestrator.test.ts`
- `test/helpers/mock-session.ts`

**Existing files modified:** None.

**Exit criteria:**
- Full workflow test with `MockSession` passes: plan -> gate -> implement -> test -> done
- Abort test: `abort()` closes all active sessions
- Status block retry: missing status block triggers one re-prompt
- Gate flow: gate raises callback, `resolveGate` advances machine
- Lifecycle events emitted for each state transition
- All sessions closed in `finally` blocks (no leaks)

### Phase 4: Storage (Artifacts + Checkpoint + Worktree)

**Modules:** 4 (complete)

**What ships:** Full artifact manager, checkpoint store, worktree manager.

**New files:**
- `src/workflow/checkpoint.ts`
- `src/workflow/worktree.ts`
- `test/workflow-artifacts.test.ts`
- `test/workflow-checkpoint.test.ts`
- `test/workflow-worktree.test.ts` (integration test with real git)

**Existing files modified:** None.

**Exit criteria:** Checkpoint round-trip (save + load). Artifact hash
determinism. Worktree create/merge/remove with a real git repo in `/tmp`.

### Phase 5: Integration (Mux Wiring, Tabs, Gates, Commands)

**Modules:** 6

**What ships:** Tab backend refactor, workflow tabs in the mux, `/workflow`
commands, footer progress, gate picker.

**New files:**
- `src/mux/tab-backend.ts`
- `src/mux/workflow-tab-backend.ts`
- `src/mux/workflow-tab.ts`
- `src/mux/workflow-footer.ts`
- `test/workflow-footer.test.ts`

**Existing files modified:**
- `src/mux/types.ts` -- `backend: TabBackend`, `workflowId?`, `gate-picker` InputMode
- `src/mux/pty-bridge.ts` -- `kind: 'pty'` discriminator
- `src/mux/mux-app.ts` -- 6 call sites + orchestrator creation + `/workflow` commands
- `src/mux/mux-renderer.ts` -- `bridge` -> `backend` + footer progress
- `src/mux/mux-input-handler.ts` -- `isPtyBackend()` guards + gate picker
- `src/mux/mux-escalation-manager.ts` -- `isPtyBackend()` guard

**Exit criteria:** All existing mux tests pass unchanged (after mechanical
`bridge` -> `backend` rename). `/workflow start` creates an orchestrator and
runs a workflow. Workflow tabs appear in the tab bar. Footer shows progress.
Gate picker surfaces and resolves gates.

---

## Reference Workflow Fixture

Used by multiple test files. Represents a minimal but realistic workflow:

```json
{
  "name": "code-review",
  "description": "Plan, implement, review loop",
  "initial": "plan",
  "settings": { "mode": "builtin", "maxRounds": 4 },
  "states": {
    "plan": {
      "type": "agent",
      "persona": "planner",
      "inputs": [],
      "outputs": ["plan"],
      "transitions": [{ "to": "review_gate" }]
    },
    "review_gate": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["plan"],
      "transitions": [
        { "to": "implement", "event": "APPROVE" },
        { "to": "plan", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": ["plan"],
      "outputs": ["code"],
      "transitions": [
        { "to": "done", "guard": "isApproved" },
        { "to": "implement" }
      ]
    },
    "done": { "type": "terminal" },
    "aborted": { "type": "terminal" }
  }
}
```

---

## Summary

| Phase | Modules | Files | Tests | Existing Code Modified |
|-------|---------|-------|-------|----------------------|
| 1. Foundation | 1 + 2 | 7 src, 4 test | Pure function tests | None |
| 2. Machine | 3 | 1 src, 1 test, 2 fixtures | XState actor tests | None |
| 3. Core | 5 (+ partial 4) | 4 src, 2 test | Mock session integration | None |
| 4. Storage | 4 (complete) | 2 src, 3 test | Filesystem + git tests | None |
| 5. Integration | 6 | 4 src, 1 test | Tab/footer rendering | 6 existing files |

Phases 1-4 create zero modifications to existing code. Only Phase 5 touches
existing files, and those changes are mechanical (rename `bridge` to `backend`
plus type guard insertion at 6 known call sites).

The orchestrator is testable from Phase 3 onward with nothing but mock
sessions and a temp directory. This is the core design goal.
