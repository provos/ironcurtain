# Multi-Agent Workflow System: Final Implementation Design

This document is the definitive implementation reference for IronCurtain's
multi-agent workflow system. It supersedes all prior design iterations (v1, v2,
v3) and incorporates every resolved finding from three rounds of design review.
Code sketches are illustrative pseudocode; implementation must follow project
conventions (ESM imports, safe coding rules, strict TypeScript).

---

## 1. Overview & Design Principles

The workflow system orchestrates sequences of AI agent sessions (planner,
architect, coder, critic) driven by an XState v5 state machine. A deterministic
`WorkflowOrchestrator` creates headless sessions via the existing `Session`
interface, parses structured output from agents, and advances the state machine
based on guards. Human review gates pause the machine and surface prompts in
the TUI.

### Design Principles

1. **Session as black box.** The orchestrator composes around the `Session`
   interface. No modifications to `DockerAgentSession`, `DockerManager`, or
   agent adapters. Both Docker and builtin sessions implement `Session`.

2. **Docker mode primary.** Agents run in Docker containers with
   `claude --continue` for conversation continuity. Conversation state
   persistence across containers already works via `conversationStateDir`
   mounting in `docker-agent-session.ts` (lines 298-305 and 326-333).

3. **Container per invocation.** Each workflow state invocation creates a fresh
   `Session` and destroys it on completion. Accept ~5-10s startup overhead.
   `claude --continue` resumes the prior conversation because conversation
   state lives on the host, not in the container.

4. **All agents get full tool access.** Planner, architect, coder, and critic
   all run full agent loops with MCP tool access. The constitution and policy
   engine restrict capabilities, not the session mode.

5. **Deterministic orchestration.** The orchestrator is not an LLM. LLMs are
   invoked only where judgment is needed (inside agent sessions). State
   transitions, artifact verification, and hash computation are deterministic.

6. **File-based escalation routing only.** Workflow sessions write PTY-
   compatible registration files. `MuxEscalationManager` discovers them via
   existing filesystem polling. No escalation callbacks in session options.

---

## 2. Execution Model

### 2.1 Docker Mode (Primary)

Each workflow agent invocation creates a new `DockerAgentSession` via
`createSession()`. The orchestrator does not keep containers alive between
state transitions.

```
Orchestrator                 Docker Container
    |                              |
    |--- createSession(docker) --->|  (container created, proxies started)
    |--- sendMessage(task) ------->|  claude --continue "task..."
    |<-- response text ------------|
    |--- close() ----------------->|  (container stopped)
    |                              |
    |  (next round, same role)     |
    |--- createSession(docker) --->|  (new container)
    |                              |  (conversation state dir re-mounted)
    |--- sendMessage(review) ----->|  claude --continue "review..."
    |<-- response text ------------|
    |--- close() ----------------->|  (container stopped)
```

**Conversation continuity:** The `conversationStateDir` (containing
`.claude.json` and session metadata) is prepared by
`prepareConversationStateDir()` in `docker-infrastructure.ts` and mounted
read-write into every container at the adapter's `containerMountPath`. When
the orchestrator passes `resumeSessionId` pointing to the previous session
for the same role, the existing infrastructure reuses the same host-side state
directory. `claude --continue` finds the prior conversation in the mounted
state. This has been verified to work, including when no prior conversation
exists (graceful fresh start).

**Cross-session knowledge:** The memory MCP server, bound per-persona at
`~/.ironcurtain/personas/{name}/memory.jsonl`, accumulates knowledge across
invocations.

### 2.2 Builtin Mode (Secondary)

For environments without Docker or for testing, agents run as builtin
`AgentSession` instances. Each invocation creates a fresh session. Conversation
history is not preserved across invocations (each turn is self-contained with
full context in the command text). This follows the one-shot principle.

### 2.3 Session Mode Construction

The orchestrator constructs `SessionOptions` using the actual `SessionMode`
discriminated union from `src/session/types.ts`:

```typescript
// Correct SessionMode construction -- matches src/session/types.ts
const mode: SessionMode = settings.mode === 'builtin'
  ? { kind: 'builtin' }
  : { kind: 'docker', agent: (settings.dockerAgent ?? 'claude-code') as AgentId };
```

The `WorkflowSettings.mode` field in workflow definitions remains a simple
string (`'docker' | 'builtin'`). The orchestrator translates it to the proper
`SessionMode` discriminated union when calling `createSession()`.

---

## 3. Workflow Definition Format

### 3.1 JSON Schema

Workflow definitions are JSON files stored at
`~/.ironcurtain/workflows/` or referenced by path.

```typescript
// src/workflow/definition.ts

export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly states: Record<string, WorkflowStateDefinition>;
  readonly settings?: WorkflowSettings;
}

export interface WorkflowSettings {
  /** Session mode. Default: 'docker'. */
  readonly mode?: 'docker' | 'builtin';
  /** Agent ID for Docker mode. Default: 'claude-code'. */
  readonly dockerAgent?: string;
  /** Default max rounds for iterative loops. Default: 4. */
  readonly maxRounds?: number;
  /** Git repository path for worktree management. */
  readonly gitRepoPath?: string;
  /** Max parallel agent sessions. Default: 3. */
  readonly maxParallelism?: number;
}

/**
 * State definition. Discriminated on `type`.
 */
export type WorkflowStateDefinition =
  | AgentStateDefinition
  | HumanGateStateDefinition
  | DeterministicStateDefinition
  | TerminalStateDefinition;

export interface AgentStateDefinition {
  readonly type: 'agent';
  readonly persona: string;
  /**
   * Input artifact names assembled into the agent's command.
   * Trailing `?` marks optional inputs (no error if absent).
   */
  readonly inputs: readonly string[];
  /** Output artifact names the agent is expected to produce. */
  readonly outputs: readonly string[];
  /** Transitions evaluated in order; first match wins. */
  readonly transitions: readonly TransitionDefinition[];
  /**
   * Key path into an artifact for parallel instantiation.
   * E.g., "spec.modules" reads the modules array from the spec artifact.
   */
  readonly parallelKey?: string;
  /** When true, each parallel instance gets a dedicated git worktree. */
  readonly worktree?: boolean;
}

export interface HumanGateStateDefinition {
  readonly type: 'human_gate';
  /** Event types this gate accepts. Each maps to a HUMAN_* WorkflowEvent. */
  readonly acceptedEvents: readonly HumanGateEventType[];
  /** Artifact names to present to the human for review. */
  readonly present?: readonly string[];
  /**
   * Transitions keyed by accepted event type.
   * Each transition specifies which event triggers it and where to go.
   */
  readonly transitions: readonly HumanGateTransition[];
}

/**
 * Transition for a human gate. Unlike agent transitions that use guards,
 * gate transitions are keyed on the event that triggers them.
 */
export interface HumanGateTransition {
  readonly to: string;
  /** The accepted event type that triggers this transition. */
  readonly event: HumanGateEventType;
}

export interface DeterministicStateDefinition {
  readonly type: 'deterministic';
  /**
   * Commands to execute. Each command is an array of [binary, ...args].
   * Never a shell string -- per CLAUDE.md safe coding rules.
   */
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
  /**
   * Guard name matching a registered XState guard. No translation
   * layer -- use names directly: isApproved, isRejected,
   * isRoundLimitReached, isStalled, hasTestCountRegression,
   * isLowConfidence.
   */
  readonly guard?: string;
  /** If truthy, sets flaggedForReview in context. */
  readonly flag?: string;
}

export type HumanGateEventType = 'APPROVE' | 'FORCE_REVISION' | 'REPLAN' | 'ABORT';
```

### 3.2 Key Design Decisions

**Deterministic commands as `string[][]`.** Each command in a deterministic
state's `run` field is an array of `[binary, ...args]`, not a shell string.
This prevents argument-splitting bugs and follows the project's safe coding
rules. Example:

```json
{
  "type": "deterministic",
  "run": [
    ["npm", "test"],
    ["npm", "run", "lint"]
  ],
  "transitions": [...]
}
```

**Direct XState guard names.** Workflow definitions reference guard names
directly (`isApproved`, `isRejected`, etc.). No translation DSL, no expression
language. If new guards are needed, register them in the guard registry and
reference by name.

**Human gate transitions keyed on `acceptedEvents`.** Gate transitions use an
explicit `event` field (of type `HumanGateEventType`), not guard names. This
prevents the v3 conflation where `t.guard` was incorrectly used as an event
name suffix.

### 3.3 Validation

```typescript
// src/workflow/validate.ts

/** The set of registered guard names. Used for validation. */
export const REGISTERED_GUARDS = new Set([
  'isApproved',
  'isRejected',
  'isRoundLimitReached',
  'isStalled',
  'hasTestCountRegression',
  'isLowConfidence',
]);

/**
 * Validates a workflow definition at load time.
 *
 * Structural checks via Zod + semantic checks:
 * - All transition targets reference existing states
 * - All guard names reference registered guards
 * - All artifact inputs exist in some state's outputs (or marked optional)
 * - Initial state exists
 * - At least one terminal state exists
 * - Parallel states have parallelKey and persona
 * - No unreachable states
 * - HumanGateTransition.event values are in acceptedEvents
 *
 * Loaded via readFileSync + JSON.parse (ESM-compatible, no require()).
 */
export function validateDefinition(raw: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.parse(raw);
  validateSemantics(parsed);
  return parsed;
}
```

---

## 4. XState Integration

### 4.1 Invoke Service Types

```typescript
// src/workflow/machine-builder.ts

import { setup, assign, fromPromise } from 'xstate';

/**
 * Input provided to each invoked agent service.
 * XState passes this via the invoke config's `input` property.
 */
export interface AgentInvokeInput {
  readonly stateId: string;
  readonly stateConfig: AgentStateDefinition;
  readonly context: WorkflowContext;
}

/**
 * Result returned by an agent service promise.
 * Becomes the event payload via onDone.
 */
export interface AgentInvokeResult {
  readonly output: AgentOutput;
  readonly sessionId: string;
  readonly artifacts: Record<string, string>;
  /** SHA-256 of output artifacts, computed by the orchestrator. */
  readonly outputHash: string;
}

export interface DeterministicInvokeResult {
  readonly passed: boolean;
  readonly testCount?: number;
  readonly errors?: string;
}
```

### 4.2 Machine Builder

The machine builder translates a `WorkflowDefinition` into an XState v5
machine. Each non-terminal, non-gate state uses `invoke` with a named actor.
Actors are type-level stubs; concrete implementations are injected at runtime
via `machine.provide()`.

```typescript
export function buildWorkflowMachine(
  definition: WorkflowDefinition,
  taskDescription: string,
) {
  const states: Record<string, unknown> = {};

  for (const [stateId, stateDef] of Object.entries(definition.states)) {
    switch (stateDef.type) {
      case 'agent':
        states[stateId] = buildAgentState(stateId, stateDef, definition);
        break;
      case 'deterministic':
        states[stateId] = buildDeterministicState(stateId, stateDef, definition);
        break;
      case 'human_gate':
        states[stateId] = buildHumanGateState(stateId, stateDef);
        break;
      case 'terminal':
        states[stateId] = { type: 'final' as const };
        break;
    }
  }

  return setup({
    types: {
      context: {} as WorkflowContext,
      events: {} as WorkflowEvent,
    },
    actors: {
      // Placeholder actors -- replaced at runtime via provide().
      // Explicit type parameters ensure provide() type-checks.
      agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(
        async () => { throw new Error('agentService must be provided'); },
      ),
      deterministicService: fromPromise<
        DeterministicInvokeResult,
        { commands: readonly (readonly string[])[]; context: WorkflowContext }
      >(
        async () => { throw new Error('deterministicService must be provided'); },
      ),
    },
    guards: {
      isApproved: ({ event }) => {
        const output = extractAgentOutput(event);
        return output?.verdict === 'approved';
      },
      isRejected: ({ event }) => {
        const output = extractAgentOutput(event);
        return output?.verdict === 'rejected';
      },
      isRoundLimitReached: ({ context }) =>
        context.round >= context.maxRounds,
      isStalled: ({ context, event }) => {
        const result = extractInvokeResult(event);
        if (!result || !context.previousOutputHashes[result.output.notes ?? '']) {
          return false;
        }
        // Per-role stall detection: compare against the hash from the
        // previous invocation of the SAME state, not the previous state.
        const stateId = extractStateId(event);
        const prevHash = stateId ? context.previousOutputHashes[stateId] : undefined;
        return prevHash != null && result.outputHash === prevHash;
      },
      hasTestCountRegression: ({ context, event }) => {
        const output = extractAgentOutput(event);
        if (context.previousTestCount == null || output?.testCount == null) {
          return false;
        }
        return output.testCount < context.previousTestCount;
      },
      isLowConfidence: ({ event }) => {
        const output = extractAgentOutput(event);
        return output?.verdict === 'approved' && output?.confidence === 'low';
      },
    },
    actions: {
      updateContextFromAgentResult: assign(({ context, event }) => {
        const result = extractInvokeResult(event);
        if (!result) return context;
        const stateId = extractStateId(event);
        return {
          ...context,
          artifacts: { ...context.artifacts, ...result.artifacts },
          // Per-role hash tracking for stall detection
          previousOutputHashes: stateId
            ? { ...context.previousOutputHashes, [stateId]: result.outputHash }
            : context.previousOutputHashes,
          previousTestCount: result.output.testCount ?? context.previousTestCount,
          round: context.round + 1,
          flaggedForReview: context.flaggedForReview
            || (result.output.verdict === 'approved'
                && result.output.confidence === 'low'),
          reviewHistory: result.output.verdict === 'rejected'
            ? [...context.reviewHistory, result.output.notes ?? '']
            : context.reviewHistory,
        };
      }),
      storeHumanPrompt: assign(({ context, event }) => ({
        ...context,
        humanPrompt: (event as { prompt?: string }).prompt ?? null,
      })),
      resetRound: assign(({ context }) => ({
        ...context,
        round: 0,
        previousOutputHashes: {},
      })),
      storeError: assign(({ context, event }) => ({
        ...context,
        lastError: (event as { error?: { message?: string } }).error?.message
          ?? 'Unknown error',
      })),
    },
  }).createMachine({
    id: definition.name,
    initial: definition.initial,
    // Initial context via setup() factory function so createActor's
    // `input` option can inject taskDescription (V3-F-4 resolution).
    context: () => ({
      ...createInitialContext(definition),
      taskDescription,
    }),
    states,
  });
}
```

### 4.3 State Builders

**Agent states** invoke the `agentService` promise on entry. XState manages
the async lifecycle: starts the promise when the state is entered, sends
`xstate.done.actor.<stateId>` when it resolves. Transitions from `onDone`
route based on guards.

```typescript
function buildAgentState(
  stateId: string,
  config: AgentStateDefinition,
  definition: WorkflowDefinition,
): object {
  const onDoneTransitions = config.transitions.map((t) => ({
    target: t.to,
    guard: t.guard,
    actions: ['updateContextFromAgentResult'],
  }));

  return {
    invoke: {
      id: stateId,
      src: 'agentService',
      input: ({ context }: { context: WorkflowContext }) => ({
        stateId,
        stateConfig: config,
        context,
      }),
      onDone: onDoneTransitions,
      onError: {
        target: findErrorTarget(config, definition),
        actions: ['storeError'],
      },
    },
  };
}
```

**Deterministic states** invoke the `deterministicService` promise.

```typescript
function buildDeterministicState(
  stateId: string,
  config: DeterministicStateDefinition,
  definition: WorkflowDefinition,
): object {
  const onDoneTransitions = config.transitions.map((t) => ({
    target: t.to,
    guard: t.guard,
  }));

  return {
    invoke: {
      id: stateId,
      src: 'deterministicService',
      input: ({ context }: { context: WorkflowContext }) => ({
        commands: config.run,
        context,
      }),
      onDone: onDoneTransitions,
      onError: {
        target: findErrorTarget(config, definition),
        actions: ['storeError'],
      },
    },
  };
}
```

**Human gate states** have NO invocation. The machine waits for an external
event. Gate transitions are keyed on `acceptedEvents`, NOT on guard names.

```typescript
function buildHumanGateState(
  stateId: string,
  config: HumanGateStateDefinition,
): object {
  const on: Record<string, unknown> = {};

  // Iterate config.transitions, which have an explicit `event` field.
  // Each transition maps HUMAN_<event> to the target state.
  for (const t of config.transitions) {
    const eventName = `HUMAN_${t.event}` as const;
    on[eventName] = {
      target: t.to,
      actions: ['storeHumanPrompt'],
    };
  }

  return { on };
}
```

### 4.4 Gate Detection via `snapshot.matches()`

Gate state names are extracted into a `Set<string>` at workflow load time.
The actor subscribe callback iterates the set and uses `snapshot.matches()`,
which correctly handles nested and parallel states. Never compare
`snapshot.value` directly.

```typescript
const gateStateNames = new Set<string>();
for (const [id, state] of Object.entries(definition.states)) {
  if (state.type === 'human_gate') gateStateNames.add(id);
}

actor.subscribe((snapshot) => {
  for (const gateName of gateStateNames) {
    if (snapshot.matches(gateName)) {
      // Raise human gate
      break;
    }
  }
});
```

### 4.5 Initial Context

Context uses a factory function so that `taskDescription` can be injected.
XState v5 requires `context` to be a function (not a static object) for the
`input` option on `createActor` to have effect. However, since the machine
builder receives `taskDescription` directly, we use a closure:

```typescript
function createInitialContext(definition: WorkflowDefinition): Omit<WorkflowContext, 'taskDescription'> {
  return {
    artifacts: {},
    round: 0,
    maxRounds: definition.settings?.maxRounds ?? 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    parallelResults: {},
    worktreeBranches: [],
    totalTokens: 0,
    flaggedForReview: false,
    lastError: null,
  };
}
```

---

## 5. Orchestrator

### 5.1 Dependencies

```typescript
// src/workflow/orchestrator.ts

import type { Session, SessionOptions, SessionMode } from '../session/types.js';
import type { AgentId } from '../docker/agent-adapter.js';

export interface WorkflowOrchestratorDeps {
  /**
   * Factory for creating sessions. Returns the standard Session interface.
   * Both DockerAgentSession and AgentSession implement Session.
   *
   * The orchestrator constructs SessionOptions with the proper
   * SessionMode discriminated union internally.
   */
  readonly createSession: (opts: SessionOptions) => Promise<Session>;

  /**
   * Factory for creating read-only workflow tabs in the mux.
   * The mux provides this bound closure when constructing the orchestrator.
   */
  readonly createWorkflowTab: (
    label: string,
    workflowId: WorkflowId,
  ) => WorkflowTabHandle;

  readonly raiseHumanGate: (gate: HumanGateRequest) => void;
  readonly dismissHumanGate: (gateId: string) => void;

  /** Base directory for workflow artifacts. Default: ~/.ironcurtain/workflows/ */
  readonly workflowBaseDir: string;
}
```

### 5.2 Execution Loop

```typescript
export class WorkflowOrchestrator implements WorkflowController {
  private readonly workflows = new Map<WorkflowId, WorkflowInstance>();
  private readonly lifecycleCallbacks: Array<(e: WorkflowLifecycleEvent) => void> = [];

  constructor(private readonly deps: WorkflowOrchestratorDeps) {}

  async start(definitionPath: string, taskDescription: string): Promise<WorkflowId> {
    // Load and validate definition (readFileSync + JSON.parse, no require())
    const raw = JSON.parse(readFileSync(definitionPath, 'utf-8'));
    const definition = validateDefinition(raw);
    const workflowId = createWorkflowId();

    // Create the artifact directory
    const artifactDir = resolve(this.deps.workflowBaseDir, workflowId, 'artifacts');
    mkdirSync(artifactDir, { recursive: true });

    // Write task description as first artifact
    const taskDir = resolve(artifactDir, 'task');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, 'description.md'), taskDescription);

    // Extract gate state names for snapshot.matches() detection
    const gateStateNames = new Set<string>();
    for (const [id, state] of Object.entries(definition.states)) {
      if (state.type === 'human_gate') gateStateNames.add(id);
    }

    // Build machine with taskDescription baked into context factory
    const machine = buildWorkflowMachine(definition, taskDescription);

    // Provide concrete service implementations with explicit type params
    const providedMachine = machine.provide({
      actors: {
        agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(
          async ({ input }) => {
            // Dispatch to parallel path if parallelKey is set
            if (input.stateConfig.parallelKey) {
              return this.executeParallelAgentState(workflowId, input, definition);
            }
            return this.executeAgentState(workflowId, input, definition);
          },
        ),
        deterministicService: fromPromise<
          DeterministicInvokeResult,
          { commands: readonly (readonly string[])[]; context: WorkflowContext }
        >(
          async ({ input }) => {
            return this.executeDeterministicState(input);
          },
        ),
      },
    });

    const actor = createActor(providedMachine);

    // Subscribe to detect gate states and emit lifecycle events
    actor.subscribe((snapshot) => {
      for (const gateName of gateStateNames) {
        if (snapshot.matches(gateName)) {
          const stateDef = definition.states[gateName];
          if (stateDef?.type === 'human_gate') {
            this.raiseHumanGate(workflowId, gateName, stateDef, snapshot.context);
          }
          break;
        }
      }

      this.emitLifecycleEvent({
        kind: 'state_entered',
        workflowId,
        state: String(snapshot.value),
      });

      if (snapshot.status === 'done') {
        this.onWorkflowComplete(workflowId, snapshot.context);
      }
    });

    this.workflows.set(workflowId, {
      id: workflowId,
      definition,
      actor,
      artifactDir,
      gateStateNames,
      activeSessions: new Set(),
    });

    actor.start();
    return workflowId;
  }
}
```

### 5.3 Agent State Execution

The core promise that XState invokes. Manages session lifecycle with
`activeSessions` tracking for abort cleanup.

```typescript
private async executeAgentState(
  workflowId: WorkflowId,
  input: AgentInvokeInput,
  definition: WorkflowDefinition,
): Promise<AgentInvokeResult> {
  const { stateId, stateConfig, context } = input;
  const workflow = this.workflows.get(workflowId)!;
  const settings = definition.settings ?? {};

  // 1. Build the command from artifacts + context
  const command = buildAgentCommand(stateConfig, context, workflow.artifactDir);

  // 2. Construct proper SessionMode discriminated union
  const mode: SessionMode = settings.mode === 'builtin'
    ? { kind: 'builtin' }
    : { kind: 'docker', agent: (settings.dockerAgent ?? 'claude-code') as AgentId };

  // 3. Create a fresh session, passing resumeSessionId for same-role continuity
  const previousSessionId = context.sessionsByRole?.[stateConfig.persona];
  const session = await this.deps.createSession({
    persona: stateConfig.persona,
    workspacePath: this.resolveWorkspacePath(stateConfig, context, workflow),
    mode,
    resumeSessionId: previousSessionId,
  });

  // Track for abort cleanup
  workflow.activeSessions.add(session);

  // 4. Write escalation registration file for MuxEscalationManager
  writeWorkflowRegistration(session.getInfo().id, stateConfig.persona);

  // 5. Create a workflow tab for display
  const tab = this.deps.createWorkflowTab(
    `${stateConfig.persona}${stateConfig.parallelKey ? ` [${stateConfig.parallelKey}]` : ''}`,
    workflowId,
  );

  try {
    // 6. Send the command and wait for completion
    const responseText = await session.sendMessage(command);

    // 7. Parse agent_status block with retry on failure
    const agentOutput = await this.parseWithRetry(session, responseText);

    // 8. Verify expected artifacts exist with retry on failure
    await this.verifyArtifacts(session, stateConfig, workflow.artifactDir);

    // 9. Compute output hash for stall detection (orchestrator-side)
    const outputHash = this.computeOutputHash(stateConfig, workflow.artifactDir);

    // 10. Collect artifact paths
    const artifacts = this.collectArtifactPaths(stateConfig, workflow.artifactDir);

    return {
      output: agentOutput,
      sessionId: session.getInfo().id,
      artifacts,
      outputHash,
    };
  } finally {
    // Always clean up
    tab.close();
    workflow.activeSessions.delete(session);
    removeWorkflowRegistration(session.getInfo().id);
    await session.close();
  }
}
```

### 5.4 Abort Flow

The orchestrator tracks `activeSessions: Set<Session>` per workflow instance.
`abort()` closes all active sessions (which kills Docker containers), then
stops the XState actor.

```typescript
async abort(id: WorkflowId): Promise<void> {
  const workflow = this.workflows.get(id);
  if (!workflow) return;

  // Close all active sessions first (kills Docker containers)
  const closePromises: Promise<void>[] = [];
  for (const session of workflow.activeSessions) {
    closePromises.push(session.close().catch(() => {}));
  }
  await Promise.allSettled(closePromises);
  workflow.activeSessions.clear();

  // Then stop the XState actor
  workflow.actor.stop();
  this.workflows.delete(id);

  this.emitLifecycleEvent({
    kind: 'failed',
    workflowId: id,
    error: 'Workflow aborted by user',
  });
}
```

---

## 6. Artifact Management

### 6.1 Directory Structure

```
~/.ironcurtain/workflows/{workflowId}/
  artifacts/
    task/
      description.md          # User's original task (written by orchestrator)
    plan/
      plan.md                 # Planner output
      plan-critique.md        # Critic's review of the plan
    spec/
      spec.md                 # Architect output
      api-contracts.md        # Optional additional specs
    reviews/
      round-1-review.md       # Critic round 1
      round-2-review.md       # Critic round 2
  worktrees/
    module-auth/              # Git worktree for parallel coder
    module-api/
  checkpoint.json             # XState checkpoint
  audit.jsonl                 # Workflow-level audit log
```

### 6.2 Naming Convention

Each state's `outputs` field names the expected artifact subdirectory. The
orchestrator expects files at deterministic paths:

- Planner writes to `artifacts/plan/`
- Architect writes to `artifacts/spec/`
- Critic writes to `artifacts/reviews/`
- Coder writes to the git worktree (code is the artifact)

### 6.3 Verification + Retry

After `sendMessage()` completes, the orchestrator checks that every expected
output artifact directory exists and is non-empty. If missing:

1. Build a specific re-prompt using **relative paths** ("create the `spec/`
   directory in your workspace"). Never use host-absolute paths in re-prompts
   because Docker agents see the workspace at `/workspace`, not at the host
   path.
2. Call `sendMessage()` once more (via `--continue`, agent has full context).
3. Check again. If still missing, throw -> `AGENT_FAILED`.

```typescript
function buildArtifactReprompt(missing: string[]): string {
  const paths = missing.map((name) => `  - \`${name}/\``);
  return (
    'The following required output artifacts were not created in your workspace:\n' +
    paths.join('\n') +
    '\n\nPlease create them now. Each artifact should be a directory ' +
    'containing at least one file.\n\n' +
    STATUS_BLOCK_INSTRUCTIONS
  );
}
```

### 6.4 Orchestrator-Computed Hashes

Output hashes are computed deterministically by the orchestrator after
collecting artifacts. The agent does not compute or report hashes.

```typescript
private computeOutputHash(
  stateConfig: AgentStateDefinition,
  artifactDir: string,
): string {
  const hash = createHash('sha256');
  for (const output of stateConfig.outputs) {
    const outputDir = resolve(artifactDir, output);
    if (!existsSync(outputDir)) continue;
    const files = readdirSync(outputDir).sort();
    for (const file of files) {
      const content = readFileSync(resolve(outputDir, file));
      hash.update(file);
      hash.update(content);
    }
  }
  return hash.digest('hex');
}
```

### 6.5 Per-Role Stall Detection

Stall detection uses per-role hash tracking, not a single global hash. This
prevents false negatives in iterative loops (e.g., coder-critic) where
different roles overwrite the hash:

```typescript
// WorkflowContext
readonly previousOutputHashes: Record<string, string>;  // stateId -> hash
```

The `isStalled` guard compares the current state's output hash against the
previous invocation of the **same state**, not the most recent state.

### 6.6 Docker Volume Mounting

In Docker mode, the entire artifact directory is bind-mounted read-write into
every container via the workspace path. Per the V2-F-11 resolution: the
constitution cannot mediate access to directly-mounted files. This is accepted
for MVP. The artifact directory contains only workflow-produced documents, not
secrets.

---

## 7. Agent Status Block

### 7.1 Format

The agent status block is a YAML code block appended to every agent response.
`output_hash` is NOT included -- the orchestrator computes hashes independently.

```yaml
agent_status:
  completed: true | false
  verdict: approved | rejected | blocked | spec_flaw
  confidence: high | medium | low
  escalation: null | spec_flaw | blocked_on_dependency | ambiguous_requirement
  test_count: <number of tests executed, if applicable, else null>
  notes: "<optional human-readable context>"
```

### 7.2 Parsed Type

```typescript
export interface AgentOutput {
  readonly completed: boolean;
  readonly verdict: 'approved' | 'rejected' | 'blocked' | 'spec_flaw';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly escalation: string | null;
  readonly testCount: number | null;
  readonly notes: string | null;
}
```

### 7.3 Parsing and Retry

The parser extracts the YAML block via regex, parses key-value pairs with a
simple parser (no YAML dependency), and validates via Zod.

On parse failure, the orchestrator re-prompts once via `sendMessage()`. Since
`claude --continue` is used, the agent retains full prior context. If the
retry also fails, the error propagates to XState's `onError` handler.

### 7.4 Spec Flaw Detection

Spec flaw detection checks `output.verdict === 'spec_flaw'`, not the
`escalation` field. The `verdict` is the authoritative signal for the agent's
overall conclusion.

---

## 8. Session Lifecycle

### 8.1 Container Per Invocation

Each workflow state invocation creates a fresh `Session` via
`deps.createSession()`. The session is closed in the `finally` block of
`executeAgentState()`. No caching, no pooling, no `getOrCreateSession`.

For a 4-round coder-critic loop, this means ~8 container creations (~40s total
overhead). Acceptable for workflows taking 20+ minutes.

### 8.2 Session Resumption via `resumeSessionId`

The orchestrator passes `resumeSessionId` (from the previous session for the
same role) in `SessionOptions`. This enables `DockerAgentSession` to reuse the
same conversation state directory on the host, allowing `claude --continue` to
find the prior conversation.

The `sessionsByRole` field in `WorkflowContext` tracks the most recent session
ID per role/persona:

```typescript
readonly sessionsByRole: Record<string, string>;
```

Updated in the `updateContextFromAgentResult` action.

### 8.3 SessionMode Discriminated Union

The orchestrator constructs the actual `SessionMode` from `src/session/types.ts`:

```typescript
export type SessionMode =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'docker'; readonly agent: AgentId; readonly authKind?: 'oauth' | 'apikey' };
```

Workflow definitions use simple strings (`'docker' | 'builtin'`); the
orchestrator translates. This keeps the definition format simple while
matching the actual codebase type.

---

## 9. Tab Backend

### 9.1 Discriminated Union

`MuxTab.backend` becomes `PtyBackend | WorkflowBackend`, a discriminated
union with `kind: 'pty' | 'workflow'`. No shared `TabBackend` base interface.

```typescript
// src/mux/tab-backend.ts

import type { Terminal as TerminalType } from '@xterm/headless';
import type { PtySessionRegistration } from '../docker/pty-types.js';

/**
 * PtyBackend -- the existing PtyBridge with a `kind` discriminator.
 * All existing PtyBridge members preserved. PtyBridge gains `kind: 'pty'`.
 */
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

/**
 * WorkflowBackend -- read-only tab driven by the orchestrator.
 * No child process, no PID, no exit callbacks.
 */
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

export function isPtyBackend(backend: TabBackend): backend is PtyBackend {
  return backend.kind === 'pty';
}

export function isWorkflowBackend(backend: TabBackend): backend is WorkflowBackend {
  return backend.kind === 'workflow';
}
```

### 9.2 Updated MuxTab

```typescript
// Updated src/mux/types.ts

export interface MuxTab {
  readonly number: number;
  readonly backend: TabBackend;  // was: bridge: PtyBridge
  label: string;
  persona?: string;
  escalationAvailable: boolean;
  scrollOffset: number | null;
  /** Workflow ID that owns this tab. Undefined for manual sessions. */
  readonly workflowId?: string;
}
```

### 9.3 Call Site Inventory (6 sites requiring `isPtyBackend()`)

Based on actual `mux-app.ts` grep results:

1. **`mux-app.ts:143`** -- `bridge.onExit()` callback registration on tab
   creation. Guard: `if (isPtyBackend(tab.backend))`.

2. **`mux-app.ts:153`** -- `bridge.onSessionDiscovered()` callback.
   Guard: `if (isPtyBackend(tab.backend))`.

3. **`mux-app.ts:574`** -- `tab.bridge.onExit()` for auto-removal of exited
   tabs. Guard: `if (isPtyBackend(tab.backend))`.

4. **`mux-app.ts:733-734`** -- `tab.bridge.pid` and
   `tab.bridge.updateRegistration(reg)` for late session discovery.
   Guard: `if (isPtyBackend(tab.backend))`.

5. **`mux-renderer.ts:280,337`** -- `activeTab.bridge.terminal` (shared
   between both backends, no guard needed) and `bridge.terminal.buffer` for
   scroll indicator (shared, no guard needed).

6. **`mux-input-handler.ts`** -- keystroke forwarding via `bridge.write()`.
   Both backends have `write()`, but workflow tabs should ignore user
   keystrokes. Guard: `if (isPtyBackend(activeTab.backend))`.

### 9.4 WorkflowTabHandle

The interface returned to the orchestrator by the mux's tab factory:

```typescript
export interface WorkflowTabHandle {
  write(text: string): void;
  setLabel(label: string): void;
  close(): void;
  readonly tabNumber: number;
}
```

The mux implements this by creating a `WorkflowTabBackendImpl`, wrapping it
in a `MuxTab`, adding it to the tab array, and returning a handle that
delegates to the backend.

---

## 10. Gate System

### 10.1 Design

Gates are a **fundamentally separate system** from policy escalations. They
have their own types, state, and UI mode. They do NOT extend
`PendingEscalation`.

| Aspect | Policy Escalation | Workflow Gate |
|--------|------------------|---------------|
| Source | PolicyEngine deny/escalate | Workflow state machine |
| Resolution | approved / denied | APPROVE / FORCE_REVISION / REPLAN / ABORT + text |
| Lifecycle | Tied to a tool call (times out) | Tied to a workflow state (no timeout) |
| UI | Quick approve/deny buttons | Multiple action buttons + text input |

### 10.2 Gate Types

```typescript
// src/workflow/gate-types.ts

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
```

### 10.3 Gate State Management

```typescript
// src/workflow/gate-state.ts

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

export function createInitialGateState(): GateState {
  return { pendingGates: new Map(), nextGateNumber: 1 };
}
```

### 10.4 Gate Event Routing

The orchestrator's `resolveGate()` constructs XState events using the
`HUMAN_` prefix. This matches the `on` handlers built by
`buildHumanGateState()` which iterate `config.transitions` and use
`t.event` (a `HumanGateEventType`) as the suffix:

```typescript
resolveGate(id: WorkflowId, event: HumanGateEvent, prompt?: string): void {
  const workflow = this.workflows.get(id);
  if (!workflow) return;

  // Constructs e.g. 'HUMAN_FORCE_REVISION'
  const xstateEvent = {
    type: `HUMAN_${event.type}` as const,
    prompt: prompt ?? event.prompt,
  };
  workflow.actor.send(xstateEvent);
}
```

### 10.5 Gate UI

A `gate-picker` input mode in the TUI, separate from `escalation-picker`:

```typescript
// Addition to src/mux/types.ts InputMode
export type InputMode =
  | 'pty' | 'command' | 'picker' | 'resume-picker'
  | 'persona-picker' | 'escalation-picker'
  | 'gate-picker';
```

---

## 11. Parallel Execution

### 11.1 Design

Parallel coders run inside a single invoke promise using
`Promise.allSettled` with `p-limit` concurrency control. This is the MVP
approach; XState sees a single invoke for the entire parallel execution.

### 11.2 Dispatch

The `agentService` provider checks `input.stateConfig.parallelKey` and
branches to the parallel execution path:

```typescript
agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(
  async ({ input }) => {
    if (input.stateConfig.parallelKey) {
      return this.executeParallelAgentState(workflowId, input, definition);
    }
    return this.executeAgentState(workflowId, input, definition);
  },
),
```

### 11.3 Parallel Execution

```typescript
private async executeParallelAgentState(
  workflowId: WorkflowId,
  input: AgentInvokeInput,
  definition: WorkflowDefinition,
): Promise<AgentInvokeResult> {
  const { stateConfig, context } = input;
  const keys = this.resolveParallelKeys(stateConfig.parallelKey!, context);
  const settings = definition.settings ?? {};
  const maxParallelism = settings.maxParallelism ?? 3;
  const limit = pLimit(maxParallelism);

  const tasks = keys.map((key) =>
    limit(async () => {
      const childInput: AgentInvokeInput = {
        ...input,
        stateConfig: { ...stateConfig, parallelKey: undefined },
        context: { ...context, parallelResults: {} },
      };
      return this.executeAgentState(workflowId, childInput, definition);
    }),
  );

  const results = await Promise.allSettled(tasks);

  // Check verdict for spec flaw (not escalation field)
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.output.verdict === 'spec_flaw') {
      throw new Error('SPEC_FLAW_DETECTED by parallel coder');
    }
  }

  // Return first successful result (simplified for MVP)
  for (const r of results) {
    if (r.status === 'fulfilled') return r.value;
  }

  throw new Error('All parallel coders failed');
}
```

### 11.4 All-or-Nothing Cancellation

MVP limitation: `SPEC_FLAW_DETECTED` from any coder aborts ALL coders (throws
from the single invoke promise). Per-coder cancellation would require XState
`spawn` with individual child actors -- deferred to post-MVP.

---

## 12. Git Worktree Management

```typescript
// src/workflow/worktree.ts

export interface WorktreeManager {
  create(repoPath: string, branchName: string, baseBranch: string): Promise<string>;
  merge(repoPath: string, branchName: string, baseBranch: string): Promise<MergeResult>;
  remove(worktreePath: string, deleteBranch?: boolean): Promise<void>;
  listActive(): readonly WorktreeInfo[];
}

export type MergeResult =
  | { readonly status: 'clean'; readonly commitHash: string }
  | { readonly status: 'conflict'; readonly conflictFiles: readonly string[] };

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly parallelKey: string;
}
```

Worktree paths: `~/.ironcurtain/workflows/{workflowId}/worktrees/{module}/`.
Merge strategy: fast-forward when possible, merge commit otherwise. Conflicts
escalate to human review.

Implementation uses `execFile` with argument arrays (not `exec` with strings)
per safe coding rules.

---

## 13. Escalation Integration

File-based only. No callbacks. The orchestrator writes PTY-compatible
registration files; `MuxEscalationManager` discovers them via existing
filesystem polling.

```typescript
// src/workflow/registration.ts

import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPtyRegistryDir } from '../config/paths.js';
import type { PtySessionRegistration } from '../docker/pty-types.js';

export function writeWorkflowRegistration(
  sessionId: string,
  persona?: string,
): void {
  const registryDir = getPtyRegistryDir();
  const registration: PtySessionRegistration = {
    sessionId,
    escalationDir: resolve(registryDir, '..', 'sessions', sessionId, 'escalation'),
    agent: 'claude-code',
    persona,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  const filePath = resolve(registryDir, `${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify(registration, null, 2));
}

export function removeWorkflowRegistration(sessionId: string): void {
  try {
    unlinkSync(resolve(getPtyRegistryDir(), `${sessionId}.json`));
  } catch {
    // File may already be gone
  }
}
```

---

## 14. Checkpointing

### 14.1 Types

```typescript
// src/workflow/checkpoint.ts

export interface WorkflowCheckpoint {
  /** Serialized XState snapshot.value (string or nested object). */
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
  listAll(): WorkflowId[];
  remove(workflowId: WorkflowId): void;
}
```

### 14.2 Strategy

Write on every state transition (via the XState subscribe callback).
`snapshot.value` is serialized as-is -- it is JSON-safe whether a string or
nested object. On restore, pass the full value to `machine.resolveState()`.

### 14.3 Known Limitation

A crash during agent execution loses that turn's work. The checkpoint says
"state = X, invoke active". On restart, XState re-enters the state and
re-invokes the agent. Worktree contents survive on the host. This is
acceptable for a local tool.

---

## 15. TUI Integration

### 15.1 Footer Progress

```typescript
// src/mux/workflow-footer.ts

/**
 * Renders a compact workflow progress indicator in the footer.
 *
 * Format:
 *   [plan] -> [design] -> [>implement] -> [review] -> [done]
 *                          ^^^^^^^^^^^
 *                          current state (highlighted)
 *
 * For parallel states:
 *   [>implement: 2/3 coders active]
 */
export function renderWorkflowProgress(
  status: WorkflowStatus,
  definition: WorkflowDefinition,
  cols: number,
): string { /* ... */ }
```

### 15.2 Tab Organization

```
[1:claude-code] [2:claude-code] | [W:planner] [W:coder]
                                  ^
                                  workflow tabs (dimmed when inactive)
```

### 15.3 `/workflow` Commands

```
/workflow start <path> <task>  - Start a workflow from a definition file
/workflow status               - Show detailed status of active workflows
/workflow abort [id]           - Abort a running workflow
/workflow list                 - List available workflow definitions
/workflow history              - Show completed/aborted workflow history
```

---

## 16. Implementation Phases

### Phase 1: Types + TabBackend Refactor

**Goal:** Establish type foundation and refactor MuxTab.

**Changes to existing code:**
- `src/mux/types.ts`: `bridge: PtyBridge` -> `backend: TabBackend`
- `src/mux/pty-bridge.ts`: add `kind: 'pty'` to `PtyBridge` interface
- `src/mux/mux-app.ts`: `bridge` -> `backend` + 6 type guard sites
- `src/mux/mux-renderer.ts`: `bridge` -> `backend`
- `src/mux/mux-input-handler.ts`: `isPtyBackend()` before keystroke forwarding
- `src/mux/mux-escalation-manager.ts`: `isPtyBackend()` for PID matching

**New files:**
- `src/mux/tab-backend.ts` -- type definitions and guards
- `src/mux/workflow-tab-backend.ts` -- `WorkflowTabBackendImpl`
- `src/workflow/types.ts` -- all workflow types
- `src/workflow/gate-types.ts` -- gate types
- `src/workflow/gate-state.ts` -- gate state management

**Tests:** All existing mux tests pass. Gate state unit tests.

### Phase 2: Workflow Definition + Validation

**New files:**
- `src/workflow/definition.ts` -- schema types
- `src/workflow/validate.ts` -- Zod + semantic validation

**Tests:** Valid and invalid definition inputs.

### Phase 3: Transition Middleware + Guards

**New files:**
- `src/workflow/transition.ts` -- `parseAgentStatus()`

**Tests:** Pure function tests, YAML parsing edge cases.

### Phase 4: XState Machine Builder

**New files:**
- `src/workflow/machine-builder.ts` -- `buildWorkflowMachine()`

**Dependencies:** `xstate@^5` added to package.json.

**Tests:** Actor inspection, transition verification, guard evaluation.

### Phase 5: Checkpoint Store + Worktree Manager

**New files:**
- `src/workflow/checkpoint.ts`
- `src/workflow/worktree.ts`

**Tests:** Checkpoint round-trip. Worktree integration with real git repos.

### Phase 6: Orchestrator

**New files:**
- `src/workflow/orchestrator.ts`
- `src/workflow/prompt-builder.ts`
- `src/workflow/registration.ts`
- `src/mux/workflow-tab.ts`

**Tests:** Full workflow execution with mock sessions. Artifact verification.
Status block re-prompt. Output hash computation. Parallel execution.

### Phase 7: Mux Integration

**Changes to existing code:**
- `src/mux/mux-app.ts`: WorkflowOrchestrator creation, `/workflow` commands
- `src/mux/mux-renderer.ts`: footer progress, workflow tab indicators
- `src/mux/mux-input-handler.ts`: `gate-picker` mode

**New files:**
- `src/mux/workflow-footer.ts`

### Phase 8: Gate System UI

**Changes to existing code:**
- `src/mux/types.ts`: `gate-picker` in `InputMode`
- `src/mux/mux-input-handler.ts`: gate picker key handling
- `src/mux/mux-renderer.ts`: gate picker rendering

### Phase 9: Workflow Scaffold Command

**New files:**
- `src/workflow/scaffold.ts` -- `ironcurtain workflow scaffold <definition>`

---

## 17. Known Limitations (Explicitly Accepted)

1. **Mid-invoke crash loses current turn's work.** Worktree contents survive
   on the host. Agent re-enters state on restart. Acceptable for a local tool.

2. **Parallel spec-flaw cancellation is all-or-nothing.** `SPEC_FLAW_DETECTED`
   from any coder aborts all coders. Per-coder cancellation deferred to
   post-MVP via XState `spawn`.

3. **`readFileSync` in command builder.** Accepted for MVP. Switch to
   `readFile` (async) if profiling shows a bottleneck.

4. **Constitution cannot mediate artifact directory access.** The artifact
   directory is bind-mounted directly into Docker containers, bypassing MCP
   tool mediation. Contains only workflow documents, not secrets.

5. **~5-10s container startup per invocation.** Acceptable for workflows that
   take 20+ minutes of agent execution time.

6. **Code sketches are pseudocode.** Implementation must follow project
   conventions: ESM imports (`import` not `require`), safe coding rules
   (`execFile` with arg arrays, not string splitting), strict TypeScript.

---

## Appendix A: Core Types Reference

### WorkflowContext

```typescript
export interface WorkflowContext {
  readonly taskDescription: string;
  readonly artifacts: Record<string, string>;
  readonly round: number;
  readonly maxRounds: number;
  /**
   * Per-role hash tracking for stall detection.
   * Key: stateId. Value: SHA-256 hex of that state's output.
   */
  readonly previousOutputHashes: Record<string, string>;
  readonly previousTestCount: number | null;
  readonly humanPrompt: string | null;
  readonly reviewHistory: readonly string[];
  readonly parallelResults: Record<string, ParallelSlotResult>;
  readonly worktreeBranches: readonly string[];
  readonly totalTokens: number;
  readonly flaggedForReview: boolean;
  readonly lastError: string | null;
  /** Session IDs for resumable sessions, keyed by persona name. */
  readonly sessionsByRole: Record<string, string>;
}
```

### WorkflowEvent

```typescript
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
```

### WorkflowStatus

```typescript
export type WorkflowStatus =
  | { readonly phase: 'running'; readonly currentState: string; readonly activeAgents: readonly AgentSlot[] }
  | { readonly phase: 'waiting_human'; readonly gate: HumanGateRequest }
  | { readonly phase: 'completed'; readonly result: WorkflowResult }
  | { readonly phase: 'failed'; readonly error: string; readonly lastState: string }
  | { readonly phase: 'aborted'; readonly reason: string };
```

### WorkflowController

```typescript
export interface WorkflowController {
  start(definitionPath: string, taskDescription: string): Promise<WorkflowId>;
  getStatus(id: WorkflowId): WorkflowStatus | undefined;
  listActive(): readonly WorkflowId[];
  resolveGate(id: WorkflowId, event: HumanGateEvent, prompt?: string): void;
  abort(id: WorkflowId): Promise<void>;
  onEvent(callback: (event: WorkflowLifecycleEvent) => void): void;
  shutdownAll(): Promise<void>;
}
```

### WorkflowInstance (Internal)

```typescript
interface WorkflowInstance {
  readonly id: WorkflowId;
  readonly definition: WorkflowDefinition;
  readonly actor: ReturnType<typeof createActor>;
  readonly artifactDir: string;
  readonly gateStateNames: Set<string>;
  /** Active sessions for abort cleanup. */
  readonly activeSessions: Set<Session>;
}
```

---

## Appendix B: Component Diagram

```
+----------------------------------------------------------------------+
|                              MuxApp                                    |
|  owns: tabs[], renderer, inputHandler, escalationManager, gateState   |
|                                                                        |
|  +---------------------------+   +----------------------------------+ |
|  | Manual Tabs               |   | WorkflowController (interface)   | |
|  | backend: PtyBackend       |   | start / getStatus / resolveGate  | |
|  | (kind: 'pty')             |   | abort / onEvent / shutdownAll    | |
|  +---------------------------+   +--------------+-------------------+ |
|                                                  |                     |
|  +-----------------------+  +--------------------+-------------------+ |
|  | MuxEscalationManager  |  | GateState (workflow gates)            | |
|  | (policy escalations)  |  | Separate types, separate UI mode      | |
|  | filesystem discovery  |  +--------------------+-------------------+ |
|  +-----------------------+                       |                     |
+--------------------------------------------------+---------------------+
                                                   |
                  +--------------------------------+
                  v
+----------------------------------------------------------------------+
|                     WorkflowOrchestrator                               |
|  (implements WorkflowController)                                       |
|                                                                        |
|  +---------------+  +----------------+  +--------------------------+  |
|  | XState Actor  |  | Checkpoint     |  | WorktreeManager          |  |
|  | (v5 machine)  |  | Store          |  | (execFile with arg arrays)|  |
|  +-------+-------+  +----------------+  +--------------------------+  |
|          |                                                             |
|  invoke  | (promise-returning services via provide())                  |
|          v                                                             |
|  +----------------------------------------------------------------+   |
|  | agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>  |   |
|  |   1. buildAgentCommand() from artifacts + context               |   |
|  |   2. createSession() -> Session (Docker or builtin)             |   |
|  |      (proper SessionMode discriminated union)                   |   |
|  |   3. sendMessage() -> parse agent_status (retry once)           |   |
|  |   4. Verify artifacts exist (retry once, relative paths)        |   |
|  |   5. Compute SHA-256 output hash (per-role tracking)            |   |
|  |   6. session.close() -> container stopped                       |   |
|  +----------------------------------------------------------------+   |
|                                                                        |
|  activeSessions: Set<Session> -- tracked for abort cleanup             |
+----------------------------------------------------------------------+
                              |
                    +---------+
                    v
+------------------------------------------+
|  createSession() (src/session/index.ts)  |
|  Returns Session interface               |
|  +-- DockerAgentSession (docker mode)    |
|  |   +-- Container per invocation        |
|  |   +-- conversationStateDir mounted    |
|  |   +-- claude --continue for resume    |
|  +-- AgentSession (builtin mode)         |
|      +-- Sandbox, PolicyEngine, Proxy    |
+------------------------------------------+
```

### Dependency Direction

```
MuxApp
  +-- depends on -> WorkflowController (interface)
  +-- depends on -> TabBackend (discriminated union)
  +-- depends on -> GateState (value types)
  +-- depends on -> MuxEscalationManager

WorkflowOrchestrator (implements WorkflowController)
  +-- depends on -> Session (interface from src/session/types.ts)
  +-- depends on -> SessionOptions, SessionMode, AgentId
  +-- depends on -> CheckpointStore (interface)
  +-- depends on -> WorktreeManager (interface)
  +-- depends on -> XState (xstate package)
  +-- depends on -> WorkflowDefinition types
  +-- depends on -> GateState types

MuxEscalationManager (unchanged)
  +-- depends on -> ListenerState, EscalationWatcher
```

No circular dependencies. The mux depends on the workflow system through
`WorkflowController`. The workflow system depends on the session system through
`Session`. Neither depends back on the mux -- callbacks are injected via deps.

---

## Appendix C: Resolution Index

All findings from three rounds of design review, with their final resolution.

| Finding | Resolution | Where in this document |
|---------|-----------|----------------------|
| F-1 (session resumption) | Docker `--continue` + memory MCP | Section 2.1 |
| F-2 (system prompt immutable) | Review injected as new command | Section 7.3 (prompt-builder) |
| F-3 (no abort) | `activeSessions` tracking + `session.close()` | Section 5.4 |
| F-4 (MuxTab requires PtyBridge) | Discriminated union `PtyBackend \| WorkflowBackend` | Section 9 |
| F-5 (escalation registration) | File-based registration files | Section 13 |
| F-6 (human gates) | Parallel gate system, own types | Section 10 |
| F-7 (XState async model) | `invoke` with `fromPromise` | Section 4.2 |
| F-8 (status block retry) | Re-prompt via `--continue` | Section 7.3 |
| F-9 (parallel resources) | `maxParallelism` + `p-limit` | Section 11 |
| F-10 (text-only agents) | All agents get full loops | Section 1 |
| F-12 (over-engineering) | Keep general format | Section 3 |
| F-13 (XState choice) | Keep XState v5 | Section 4 |
| F-14 (gate conflation) | Separate gate system | Section 10 |
| V2-F-1 (TabBackend methods) | Discriminated union with type guards | Section 9.3 |
| V2-F-2 (DockerManager abort) | No Docker changes; orchestrator-level | Section 5.4 |
| V2-F-3 (`--continue` first turn) | Non-issue (verified) | Section 2.1 |
| V2-F-4 (snapshot.value) | `snapshot.matches()` everywhere | Section 4.4 |
| V2-F-6 (WorkflowSession) | Use `Session` directly | Section 8.3 |
| V2-F-7 (container lifecycle) | Container per invocation | Section 8.1 |
| V2-F-8 (artifact convention) | Naming convention + verification + retry | Section 6 |
| V2-F-9 (guard translation) | Direct XState guard names | Section 3.2 |
| V2-F-10 (output hash) | Orchestrator-computed SHA-256 | Section 6.4 |
| V2-F-11 (volume mounts) | Whole artifact directory | Section 6.6 |
| V2-F-12 (parallel cancellation) | All-or-nothing | Section 11.4 |
| V2-F-15 (escalation routing) | File-based only | Section 13 |
| V3-F-1 (conversation state) | Non-issue; already mounted | Section 2.1 |
| V3-F-2 (createSession signature) | Proper `SessionMode` union | Section 2.3 |
| V3-F-3 (gate event mapping) | Keyed on `acceptedEvents` | Section 4.3 |
| V3-F-4 (createActor input) | Context factory function | Section 4.5 |
| V3-F-5 (require in ESM) | `readFileSync` + `JSON.parse` | Section 3.3 |
| V3-F-6 (parallel dispatch) | Check `parallelKey` in agentService | Section 11.2 |
| V3-F-7 (tab creation flow) | Factory in `WorkflowOrchestratorDeps` | Section 5.1 |
| V3-F-8 (command splitting) | `readonly (readonly string[])[]` | Section 3.1 |
| V3-F-9 (resolveGate events) | Fixed with V3-F-3 | Section 10.4 |
| V3-F-10 (spec flaw check) | `output.verdict === 'spec_flaw'` | Section 11.3 |
| V3-F-11 (stall detection) | Per-role `previousOutputHashes` | Section 6.5 |
| V3-F-12 (abort resource leak) | `activeSessions: Set<Session>` | Section 5.4 |
| V3-F-13 (host paths in prompts) | Relative paths | Section 6.3 |
| V3-F-14 (pseudocode quality) | Acknowledged | Section 17, item 6 |
