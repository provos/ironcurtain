# Design: Workflow System Web UI Integration

**Status:** Draft v3
**Date:** 2026-04-04
**Author:** IronCurtain Engineering

---

## 1. Overview and Goals

This design integrates IronCurtain's multi-agent workflow system into the web UI. The workflow system orchestrates multiple AI agents (planner, architect, coder, critic) through an XState v5 state machine, with human gates pausing execution for review. Today, workflow interaction is CLI-only (`ironcurtain workflow start|resume|inspect`). The web UI provides a richer experience: real-time state machine visualization, artifact review with rendered markdown, side-by-side diffs for code changes, and a workflow management dashboard.

**Goals:**

1. **Visualize workflow progress** -- show the state machine with live highlighting as states transition, giving the user an at-a-glance understanding of where the workflow is and how it got there.
2. **Rich human gate review** -- when a workflow pauses at a gate, surface artifacts with proper rendering (markdown, file trees, diffs) and provide clear action buttons matching the gate's `acceptedEvents`.
3. **Workflow lifecycle management** -- start, resume, abort, and inspect workflows from the browser without switching to the CLI.
4. **Real-time updates** -- push state transitions, agent activity, gate events, and artifact creation to the frontend via the existing WebSocket event bus.
5. **Authoring exploration** -- investigate feasibility of visual workflow definition editing and persona management from the web UI.

**Non-goals:**

- Replacing the CLI for workflow operations. Both interfaces coexist.
- Live terminal streaming of agent stdout. The web UI shows structured events, not raw PTY output.
- Multi-user concurrent editing of workflow definitions.

---

## 2. Backend Integration

### 2.1 WorkflowManager

The daemon needs a `WorkflowManager` analogous to `SessionManager` -- a component that owns `WorkflowOrchestrator` instances and exposes them to the JSON-RPC dispatch layer. The existing `WorkflowOrchestrator` already implements `WorkflowController`, which is the correct boundary.

```typescript
// src/daemon/workflow-manager.ts

import type { WorkflowController, WorkflowLifecycleEvent, WorkflowId } from '../workflow/types.js';

export interface WorkflowManagerOptions {
  readonly baseDir: string;
  readonly createSession: WorkflowOrchestratorDeps['createSession'];
  /** Maximum concurrent Docker agent sessions across ALL workflows. Default: 4. */
  readonly maxConcurrentAgentSessions?: number;
}

export class WorkflowManager {
  private orchestrator: WorkflowOrchestrator | null = null;

  /** Lazily creates the orchestrator on first use. */
  getOrchestrator(): WorkflowController { ... }

  /** Subscribe to lifecycle events for forwarding to WebEventBus. */
  onLifecycleEvent(callback: (event: WorkflowLifecycleEvent) => void): void { ... }

  /** Clean shutdown of all workflows. */
  async shutdown(): Promise<void> { ... }
}
```

**Workspace collision detection.** The orchestrator's `start()` method must reject a start request if any active workflow already uses the same resolved workspace path. This prevents two workflows from corrupting each other's artifacts and git state. The check is a scan of `this.workflows` values after resolving the workspace path:

```typescript
// In start(), after resolving workspacePath:
for (const instance of this.workflows.values()) {
  if (instance.workspacePath === resolvedWorkspacePath) {
    throw new Error(`Workspace ${resolvedWorkspacePath} is already in use by workflow ${instance.id}`);
  }
}
```

This is an orchestrator fix, not a web UI concern, but it is a prerequisite for safe multi-workflow operation. The JSON-RPC layer surfaces the error as a standard RPC error.

The `WorkflowManager` is instantiated in `IronCurtainDaemon` alongside `SessionManager`. It wires lifecycle events to the `WebEventBus` for frontend consumption.

**Global agent session limit.** The `maxConcurrentAgentSessions` setting (default: 4) limits the total number of Docker containers running across all workflows simultaneously. This is separate from the per-workflow `maxParallelism` setting in `WorkflowDefinition.settings`, which controls fan-out within a single workflow. The global limit protects the host machine from resource exhaustion when multiple workflows are active.

The limit is enforced in `WorkflowOrchestratorDeps` (or a shared counter injected into the orchestrator). Before creating a new agent session in `executeAgentState()`, the orchestrator checks:

```typescript
// In executeAgentState(), before creating the session:
const activeCount = this.countActiveAgentSessions(); // sum across all WorkflowInstance.activeSessions
if (activeCount >= this.maxConcurrentAgentSessions) {
  // Wait or throw -- TBD. Waiting with a bounded timeout is friendlier than failing.
  throw new Error(`Global agent session limit reached (${this.maxConcurrentAgentSessions})`);
}
```

The default of 4 is conservative for a developer laptop. Users can increase it via `WorkflowManagerOptions` or a future user config field. The per-workflow `maxParallelism` (currently 1 -- sequential states) remains the inner constraint; the global limit is the outer constraint. A workflow with `maxParallelism: 2` that tries to start two agents while three other agents are running across other workflows would be throttled to one new agent.

**No new abstraction for gate callbacks.** The `WorkflowOrchestrator` already receives `raiseGate` and `dismissGate` as callbacks via `WorkflowOrchestratorDeps`. The TUI provides readline-based callbacks; the web UI provides `WebEventBus`-based callbacks. Same interface, different implementations -- the orchestrator is already agnostic to the UI layer. The `WorkflowManager` simply wires these callbacks when constructing the orchestrator:

```typescript
raiseGate: (gate) => this.eventBus.emit('workflow.gate_raised', gate),
dismissGate: (gateId) => this.eventBus.emit('workflow.gate_dismissed', { gateId }),
```

**Daemon integration point** (in `ironcurtain-daemon.ts`):

```typescript
// In IronCurtainDaemon constructor or start():
this.workflowManager = new WorkflowManager({
  baseDir: getWorkflowBaseDir(),
  createSession: (opts) => createSession({ ...opts, ... }),
});

// Wire lifecycle events to the web event bus
this.workflowManager.onLifecycleEvent((event) => {
  this.eventBus.emit(`workflow.${event.kind}`, event);
});
```

### 2.2 Dispatch Sub-Module Extraction (Phase 0 prerequisite)

Before adding workflow methods, the existing `json-rpc-dispatch.ts` must be refactored into domain-specific dispatch sub-modules. The current file is ~410 lines with a single `switch` statement covering sessions, jobs, escalations, and personas. Adding workflow methods (10+ new cases) would push it past 600 lines and mix unrelated concerns in one file. The refactoring preserves all existing behavior.

**New module structure:**

- `src/web-ui/dispatch/session-dispatch.ts` -- Session RPC methods (`sessions.*`), the `createWebSession` helper, session queue management, and the `sendToSession` serialization logic.
- `src/web-ui/dispatch/job-dispatch.ts` -- Job RPC methods (`jobs.*`) and the `listJobs` helper.
- `src/web-ui/dispatch/escalation-dispatch.ts` -- Escalation RPC methods (`escalations.*`) and the `listEscalations` helper.
- `src/web-ui/dispatch/workflow-dispatch.ts` -- New workflow RPC methods (`workflows.*`). Added in Phase 1.

Each sub-module exports a single dispatch function with a consistent signature:

```typescript
// src/web-ui/dispatch/session-dispatch.ts
export async function sessionDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown>;
```

The main `json-rpc-dispatch.ts` becomes a thin router that delegates by method prefix:

```typescript
export async function dispatch(
  ctx: DispatchContext,
  method: MethodName,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method.startsWith('workflows.')) return workflowDispatch(ctx, method, params);
  if (method.startsWith('sessions.')) return sessionDispatch(ctx, method, params);
  if (method.startsWith('jobs.')) return jobDispatch(ctx, method, params);
  if (method.startsWith('escalations.')) return escalationDispatch(ctx, method, params);
  if (method === 'status') return buildStatusDto(ctx);
  if (method === 'personas.list') return personasDispatch(ctx, method, params);
  throw new MethodNotFoundError(method);
}
```

Zod schemas, handler logic, and domain-specific helpers move into their respective sub-modules. The `DispatchContext` interface and shared utilities (`validateParams`, DTO builders like `toSessionDto` and `toBudgetDto`) stay in `json-rpc-dispatch.ts` or move to a shared `dispatch/common.ts` module.

This is a pure refactoring step -- no new features, no behavior changes. It should be completed before Phase 1 begins to keep the workflow dispatch module cleanly separated from day one.

### 2.3 JSON-RPC Methods

New methods added to the `MethodName` union in `web-ui-types.ts` and dispatched in `dispatch/workflow-dispatch.ts`:

| Method | Params | Response | Notes |
|--------|--------|----------|-------|
| `workflows.list` | -- | `WorkflowSummaryDto[]` | Active workflows only (from memory). Historic listing via checkpoint scanning deferred to future work. |
| `workflows.get` | `{ workflowId: string }` | `WorkflowDetailDto` | Full detail: graph, history, context, gate info |
| `workflows.start` | `{ definitionPath: string, taskDescription: string, workspacePath?: string }` | `{ workflowId: string }` | Fire-and-forget; progress via events |
| `workflows.resume` | `{ workflowId: string }` | `{ accepted: true }` | Resume from checkpoint |
| `workflows.abort` | `{ workflowId: string }` | -- | |
| `workflows.resolveGate` | `{ workflowId: string, event: HumanGateEventType, prompt?: string }` | -- | |
| `workflows.definitions` | -- | `WorkflowDefinitionSummary[]` | List available definitions |
| `workflows.artifacts` | `{ workflowId: string, artifactName: string }` | `ArtifactContentDto` | Read artifact content for review |
| `workflows.messageLog` | `{ workflowId: string, limit?: number }` | `MessageLogEntry[]` | Read message log entries |
| `workflows.diff` | `{ workflowId: string }` | `DiffEntry[]` | Git diff of workspace changes |
| `workflows.fileTree` | `{ workflowId: string, path?: string }` | `FileTreeNode[]` | Browse workspace files |
| `workflows.fileContent` | `{ workflowId: string, path: string }` | `{ content: string, language: string }` | Read a single file |
| `personas.list` | -- | `PersonaListItem[]` | Already exists |
| `personas.get` | `{ name: string }` | `PersonaDetailDto` | Full persona definition |
| `personas.create` | `{ name: string, description: string, servers?: string[] }` | -- | |
| `personas.compilePolicy` | `{ name: string }` | `{ accepted: true }` | Async; status via events |

**Param validation schemas** (following existing pattern with Zod):

```typescript
const workflowIdSchema = z.object({ workflowId: z.string().uuid() });
const workflowStartSchema = z.object({
  definitionPath: z.string().min(1),
  taskDescription: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
});
const workflowResolveGateSchema = z.object({
  workflowId: z.string().uuid(),
  event: z.enum(['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT']),
  prompt: z.string().optional(),
});
const workflowArtifactSchema = z.object({
  workflowId: z.string().uuid(),
  artifactName: z.string().min(1),
});
const workflowDiffSchema = z.object({ workflowId: z.string().uuid() });
const workflowFileTreeSchema = z.object({
  workflowId: z.string().uuid(),
  path: z.string().optional(),
});
const workflowFileContentSchema = z.object({
  workflowId: z.string().uuid(),
  path: z.string().min(1),
});
```

**New error codes** added to `ErrorCode`:

```typescript
| 'WORKFLOW_NOT_FOUND'
| 'WORKFLOW_NOT_AT_GATE'
| 'ARTIFACT_NOT_FOUND'
| 'DEFINITION_NOT_FOUND'
```

### 2.4 DTO Types

```typescript
// src/web-ui/web-ui-types.ts (additions)

/**
 * Slim summary returned by `workflows.list`. Contains only the fields
 * needed for the dashboard listing. Full detail is fetched via `workflows.get`.
 */
export interface WorkflowSummaryDto {
  readonly workflowId: string;
  readonly name: string;
  readonly phase: 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';
  readonly currentState: string;
  readonly startedAt: string;
}

/**
 * Full detail returned by `workflows.get`. Includes graph topology,
 * transition history, context, and gate info.
 */
export interface WorkflowDetailDto extends WorkflowSummaryDto {
  readonly description: string;
  readonly completedAt?: string;
  readonly stateGraph: StateGraphDto;
  readonly transitionHistory: readonly TransitionRecordDto[];
  readonly definition: WorkflowDefinitionDto;
  readonly context: WorkflowContextDto;
  readonly gate?: HumanGateRequestDto;
  readonly workspacePath: string;
}

/** Minimal representation of the state machine graph for frontend rendering. */
export interface StateGraphDto {
  readonly states: readonly StateNodeDto[];
  readonly transitions: readonly TransitionEdgeDto[];
}

export interface StateNodeDto {
  readonly id: string;
  readonly type: 'agent' | 'human_gate' | 'deterministic' | 'terminal';
  readonly persona?: string;
  readonly label: string;
}

export interface TransitionEdgeDto {
  readonly from: string;
  readonly to: string;
  readonly guard?: string;
  readonly event?: string;
  readonly label: string;
}

export interface TransitionRecordDto {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly durationMs: number;
}

export interface HumanGateRequestDto {
  readonly gateId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly string[];
  /** Artifact names only (not content). Derived from HumanGateRequest.presentedArtifacts keys. */
  readonly presentedArtifacts: readonly string[];
  readonly summary: string;
}

/**
 * Converts a domain HumanGateRequest to the JSON-serializable DTO.
 *
 * HumanGateRequest.presentedArtifacts is a ReadonlyMap<string, string>
 * which does not serialize to JSON. This converter extracts the keys
 * as a plain array.
 */
export function toHumanGateRequestDto(gate: HumanGateRequest): HumanGateRequestDto {
  return {
    gateId: gate.gateId,
    stateName: gate.stateName,
    acceptedEvents: [...gate.acceptedEvents],
    presentedArtifacts: Array.from(gate.presentedArtifacts.keys()),
    summary: gate.summary,
  };
}

export interface ArtifactContentDto {
  readonly name: string;
  readonly files: readonly ArtifactFileDto[];
}

export interface ArtifactFileDto {
  readonly path: string;
  readonly content: string;
  readonly language: string;
}

export interface DiffEntry {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly oldContent?: string;
  readonly newContent?: string;
  readonly diff: string;
}

export interface FileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly children?: readonly FileTreeNode[];
  readonly size?: number;
}

export interface WorkflowDefinitionDto {
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly states: Record<string, { type: string; persona?: string }>;
  readonly settings?: Record<string, unknown>;
}

export interface WorkflowContextDto {
  readonly taskDescription: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly totalTokens: number;
  readonly visitCounts: Record<string, number>;
}
```

### 2.5 WebEventBus Extensions

New event types added to `WebEventMap`:

```typescript
// src/web-ui/web-event-bus.ts (additions to WebEventMap)

export interface WebEventMap {
  // ... existing events ...

  'workflow.state_entered': {
    workflowId: string;
    state: string;
    previousState?: string;
  };
  'workflow.completed': {
    workflowId: string;
  };
  'workflow.failed': {
    workflowId: string;
    error: string;
  };
  'workflow.gate_raised': {
    workflowId: string;
    gate: HumanGateRequestDto;
  };
  'workflow.gate_dismissed': {
    workflowId: string;
    gateId: string;
  };
  'workflow.agent_started': {
    workflowId: string;
    stateId: string;
    persona: string;
  };
  'workflow.agent_completed': {
    workflowId: string;
    stateId: string;
    verdict?: string;
    confidence?: string;
  };
  'workflow.artifact_created': {
    workflowId: string;
    artifactName: string;
  };
}
```

The lifecycle event wiring in `WorkflowManager` maps existing `WorkflowLifecycleEvent` kinds directly to these bus events.

**Required additions to `WorkflowLifecycleEvent`** in `orchestrator.ts`:

```typescript
export type WorkflowLifecycleEvent =
  // ... existing kinds ...
  | { readonly kind: 'agent_started'; readonly workflowId: WorkflowId; readonly state: string; readonly persona: string }
  | { readonly kind: 'agent_completed'; readonly workflowId: WorkflowId; readonly state: string; readonly persona: string; readonly verdict: string };
```

**Emission points in `executeAgentState()`:**

- `agent_started`: emitted immediately before the `session.sendMessage(command)` call (after session creation succeeds, line ~679 in current source). This ensures the event fires only when the session is ready and the command is about to be sent.
- `agent_completed`: emitted after `parseAgentStatus()` succeeds and before the `return` statement (after line ~731 in current source). The `verdict` field comes from `agentOutput.verdict`.

```typescript
// In executeAgentState(), before sendMessage:
this.emitLifecycleEvent({ kind: 'agent_started', workflowId, state: stateId, persona: stateConfig.persona });

// In executeAgentState(), after successful parsing, before return:
this.emitLifecycleEvent({ kind: 'agent_completed', workflowId, state: stateId, persona: stateConfig.persona, verdict: agentOutput.verdict });
```

### 2.6 State Graph Extraction

The backend needs a function to convert a `WorkflowDefinition` into a `StateGraphDto` for the frontend. This is a pure transformation -- no runtime state needed.

```typescript
// src/web-ui/workflow-graph.ts

export function extractStateGraph(definition: WorkflowDefinition): StateGraphDto {
  const states: StateNodeDto[] = [];
  const transitions: TransitionEdgeDto[] = [];

  for (const [id, state] of Object.entries(definition.states)) {
    states.push({
      id,
      type: state.type,
      persona: state.type === 'agent' ? state.persona : undefined,
      label: formatStateLabel(id),
    });

    // Each state type has a different transition structure.
    // Handle them explicitly rather than relying on duck typing.
    switch (state.type) {
      case 'agent':
        // AgentStateDefinition: transitions with guard conditions
        for (const t of state.transitions) {
          transitions.push({
            from: id,
            to: t.to,
            guard: t.guard,
            label: t.guard ? formatGuardLabel(t.guard) : '',
          });
        }
        break;

      case 'human_gate':
        // HumanGateStateDefinition: transitions keyed by event type
        for (const t of state.transitions) {
          transitions.push({
            from: id,
            to: t.to,
            event: t.event,
            label: formatEventLabel(t.event),
          });
        }
        break;

      case 'deterministic':
        // DeterministicStateDefinition: same structure as agent transitions
        for (const t of state.transitions) {
          transitions.push({
            from: id,
            to: t.to,
            guard: t.guard,
            label: t.guard ? formatGuardLabel(t.guard) : '',
          });
        }
        break;

      case 'terminal':
        // TerminalStateDefinition: no transitions (sink node)
        break;
    }
  }

  return { states, transitions };
}
```

The `switch` on `state.type` is exhaustive -- TypeScript's `never` check catches any new state type added to `WorkflowStateDefinition` in the future.

---

## 3. State Machine Visualization

### 3.1 Layout Strategy

The workflow state machine is a directed graph, not a simple linear pipeline. The `design-and-code` workflow has backward edges (FORCE_REVISION loops from `plan_review` back to `plan`, the coder-critic `implement`/`review` loop) and branching (multiple transitions from `review` with different guards). This requires a proper graph layout algorithm.

**Recommendation: dagre layout + custom SVG rendering, entirely in the frontend.**

The backend provides `StateGraphDto` (topology only -- nodes and edges, no positions). The frontend is responsible for layout computation and visual rendering. This is a clean separation: backend = graph topology, frontend = visual presentation.

- **dagre** (or its successor **@dagrejs/dagre**) is a lightweight directed graph layout library (~30KB), bundled with the frontend. It computes node positions for layered graphs (Sugiyama algorithm), handling backward edges, branching, and merging. It outputs x/y coordinates; it does not render anything.
- **Custom SVG** for rendering. Using a heavy graph visualization library (e.g., Cytoscape, D3-force, vis.js) is overkill for a graph with 5-10 nodes. A Svelte component that generates SVG elements from dagre's layout output provides full control over styling, animation, and accessibility.

**Why not CSS grid or flexbox?** The backward edges and multi-path branching make a pure CSS layout fragile. Any change to the workflow definition would require manual layout adjustments. dagre handles this automatically.

**Why not elkjs?** elkjs (~750KB) is more powerful than dagre but the additional sophistication (port ordering, compound nodes, edge routing) is not needed for workflow graphs of this size. dagre's output is sufficient.

**Why not Canvas?** SVG is better for this use case: small number of elements, interactivity via DOM events, CSS animations for state highlighting, accessibility via ARIA attributes on SVG elements.

### 3.2 Rendering Approach

The `StateMachineGraph` component:

1. Receives a `StateGraphDto` (nodes + edges), current state name, transition history, and workflow phase.
2. Runs dagre layout once on mount (and re-runs only if the definition changes -- it will not change during a workflow run).
3. Renders SVG elements positioned by dagre coordinates:
   - **Nodes** as rounded rectangles (agent, deterministic) or diamonds/hexagons (human_gate) or double-bordered rectangles (terminal).
   - **Edges** as SVG paths with arrowheads. Guard/event labels rendered as text along the path.
   - **Current state** highlighted with a CSS animation (pulsing glow via `@keyframes` and `filter: drop-shadow`).
   - **Completed states** (in transition history) shown with a checkmark overlay and reduced opacity.
   - **Failed states** shown with red border and error icon.
   - **Waiting states** (human gate, actively waiting) shown with amber pulsing border.

4. The graph is contained in a `viewBox`-based SVG that scales to fit its container. For larger graphs, the user can pan/zoom via mouse wheel and drag (implemented with SVG transform manipulation, not a library).

### 3.3 Node Shapes and Colors

| State Type | Shape | Default Color | Active Color |
|-----------|-------|--------------|--------------|
| `agent` | Rounded rectangle | `--muted` fill | `--primary` border, pulsing glow |
| `human_gate` | Octagon | `--warning` fill (amber) | `--warning` border, pulsing |
| `deterministic` | Rectangle with gear icon | `--muted` fill | `--primary` border |
| `terminal` | Double-bordered rectangle | `--muted` fill | `--success` fill (completed) or `--destructive` fill (aborted) |

Persona labels appear inside agent nodes in smaller text. Guard labels appear as annotations on transition edges.

### 3.4 Real-Time Updates

When a `workflow.state_entered` event arrives:
1. Update the `currentState` in the workflow store.
2. CSS classes on the previous state node transition from "active" to "completed" (with a brief animation).
3. CSS classes on the new state node transition to "active" (pulsing glow begins).
4. The transition edge that was just traversed briefly flashes (stroke animation).

The transition history is used to determine which states are completed vs. not-yet-reached. A state is "completed" if it appears as a `from` in any transition record. A state is "active" if it matches `currentState`. All other states are "pending" (default styling).

### 3.5 Coder-Critic Loop Visualization

The `implement` <-> `review` loop is the most complex visual element. The round counter (`context.visitCounts`) is displayed as a badge on the `implement` node (e.g., "Round 2/3"). The backward edge from `review` to `implement` (guard: `isRejected`) is rendered as a curved path below the forward path, with a distinct dashed style to indicate it is a retry loop.

---

## 4. Human Gate Review UX

### 4.1 Architecture: Gate Panel vs. Modal

Gates are different from escalations in important ways:

| Dimension | Escalation | Workflow Gate |
|-----------|-----------|---------------|
| Scope | Single tool call | Body of work (plan, spec, code) |
| Context | Tool name + arguments | Full artifacts + workspace |
| Actions | Approve / Deny | Approve / Force Revision / Replan / Abort |
| Feedback | None | Free-text prompt for revision |
| Duration | Seconds | Minutes (reviewing a plan or code) |

Because gate review takes longer and requires exploring artifacts, a modal is insufficient. Instead, the gate review is a **full-page panel** within the Workflow Detail view. When a workflow reaches a gate, the Workflow Detail view automatically switches to the Gate Review layout.

### 4.2 Gate Review Layout

```
+------------------------------------------+
|  Workflow: design-and-code                |
|  [State Machine Graph - compact]          |
+------------------------------------------+
|  Gate: plan_review                        |
|  "Waiting for human review"               |
+------------------------------------------+
|                                           |
|  Tabs: [Plan] [Workspace] [Message Log]   |
|                                           |
|  +--------------------------------------+ |
|  |  Artifact viewer                      | |
|  |  (rendered markdown / file tree /     | |
|  |   diff view depending on tab)         | |
|  |                                       | |
|  |                                       | |
|  +--------------------------------------+ |
|                                           |
|  +--------------------------------------+ |
|  | Feedback (optional):                  | |
|  | [textarea for revision feedback]      | |
|  +--------------------------------------+ |
|                                           |
|  [Approve]  [Force Revision]  [Abort]     |
|                                           |
+------------------------------------------+
```

The state machine graph is rendered in compact mode at the top (smaller, non-interactive, just showing current position). The main area is dedicated to artifact review.

### 4.3 Artifact Viewer

The artifact viewer renders content based on the artifact type:

**Markdown artifacts** (plan.md, spec.md, review.md):
- Rendered as styled HTML using the existing `marked` + `DOMPurify` pipeline from `markdown.ts`.
- Syntax highlighting for code blocks within the markdown (already supported by marked).

**File tree** (workspace browsing):
- Hierarchical tree view with expand/collapse.
- Clicking a file opens it in a code viewer with syntax highlighting.
- The `.workflow/` directory is visually separated from the workspace root to distinguish artifacts from code.

**Diff view** (for code review at `design_review` or `escalate_gate`):
- Uses `workflows.diff` RPC to get git diff of the workspace.
- Rendered as a unified or side-by-side diff view.
- The diff viewer is a custom component using `<pre>` elements with line-by-line coloring (additions green, deletions red).
- If no git history exists (fresh workspace), the diff view shows all files as "added".

**Implementation note:** For the diff view, we do NOT pull in a heavy diff library like Monaco or CodeMirror. A simple line-by-line renderer with syntax classes is sufficient for review purposes. The diff itself is computed server-side via `git diff` and sent as unified diff text.

### 4.4 Gate Notification

When a `workflow.gate_raised` event arrives:

1. The sidebar Workflows badge increments.
2. If the user is viewing a different page, a toast notification appears: "Workflow 'design-and-code' is waiting for review at plan_review".
3. Clicking the notification navigates to the Workflow Detail view with the gate review panel.
4. If the user is already on the Workflow Detail view for this workflow, the gate review panel activates automatically.

The notification pattern follows the escalation modal precedent -- auto-surface when the event occurs, dismissible, with a passive indicator (sidebar badge) for later attention. However, gates do NOT use the escalation modal since the review experience requires a full-page layout.

### 4.5 Action Buttons

The action buttons are dynamically rendered based on the gate's `acceptedEvents` array:

| Event | Button | Style | Behavior |
|-------|--------|-------|----------|
| `APPROVE` | "Approve" | `success` variant | Sends `workflows.resolveGate` with `event: 'APPROVE'` |
| `FORCE_REVISION` | "Request Revision" | `default` variant | Requires non-empty feedback textarea. Sends with `prompt` field. |
| `REPLAN` | "Replan" | `outline` variant | Optional feedback. Sends with `event: 'REPLAN'`. |
| `ABORT` | "Abort Workflow" | `destructive` variant | Confirmation dialog before sending. |

The "Request Revision" button is disabled until the feedback textarea has content. This prevents accidental empty revision requests.

### 4.6 Concurrent Gate UX (Multiple Workflows)

When multiple workflows have pending gates simultaneously, the UI must make it clear which gates belong to which workflows and allow the user to address them in any order.

**Sidebar badge:** The Workflows sidebar badge shows the total count of pending gates across all workflows (from `appState.pendingGates.size`). This is the single number the user glances at to know if anything needs attention.

**Gate notification banner:** The `GateNotificationBanner` component shows the most recently raised gate. If there are additional pending gates from other workflows, the banner includes a secondary indicator: "2 more pending" (linking to the Workflows dashboard where all gates are visible). The banner always identifies the workflow: "Workflow 'design-and-code' is waiting for review at plan_review".

**Gate list in dashboard:** Each gate card in the Workflows dashboard Active Workflows section shows:
- The workflow name (e.g., "design-and-code")
- The current state name where the gate is waiting (e.g., "plan_review")
- A "Review" button that navigates to the specific workflow's detail page with the gate review panel active

**Independence:** Resolving a gate from one workflow does not affect gates from other workflows. Each gate resolution targets a specific `workflowId` and the orchestrator processes them independently. The `pendingGates` map is keyed by `gateId` (which is unique per gate instance), so there is no cross-workflow interference.

**Review order:** The user can review gates from different workflows in any order. There is no queue or priority -- the user navigates to whichever workflow they choose and resolves its gate. The sidebar badge and banner update immediately as gates are raised or resolved.

### 4.7 Gate Auto-Open Behavior

When the web UI receives a `workflow.gate_raised` event, it should guide the user to the review without being disruptive:

- **If viewing the workflow's detail page:** Automatically switch to the gate review tab. No modal, no navigation.
- **If viewing any other page:** Show a persistent banner at the top of the page: "Workflow 'design-and-code' needs review at plan_review. [Review now]". Clicking navigates to the workflow detail page. The banner uses the `Alert` component with `warning` variant and is dismissible.
- **Browser tab:** If the browser tab is not focused, flash the title (using the existing `flash-title.ts` utility) with "Review needed".

---

## 5. Workflow Management Dashboard

### 5.1 Dashboard Integration

The workflow dashboard is a new view accessible from the sidebar. It shows:

**Active Workflows** (top section):
- Card per active workflow showing: name, current state, phase badge (running/waiting), progress indicator, elapsed time, total tokens consumed.
- Clicking a card navigates to the Workflow Detail view.
- "Abort" button on each card (with confirmation).

**Resumable Workflows** (middle section):
- List of workflows with checkpoints that are not currently running.
- Each entry shows: name, last state, failure reason (if failed), timestamp.
- "Resume" button on each entry.

**Completed/Failed History** (bottom section -- deferred):
- Deferred to future work. Requires checkpoint scanning to surface completed/failed history.
- Phase 1 shows only active (in-memory) workflows.
- When implemented: table of recently completed/failed/aborted workflows with columns: name, status, started, completed, total tokens, final state. Clicking navigates to a read-only Workflow Detail view.

**Start New Workflow** (sidebar action or button):
- Opens a form with:
  - Workflow definition selector (dropdown listing available definitions from `workflows.definitions`).
  - Task description (textarea).
  - Optional workspace path (input, with a note that empty = fresh workspace).
  - Model override (optional input).
- "Start" button sends `workflows.start`.

### 5.2 Workflow Detail View

The detail view is the primary workflow interaction surface:

**Header:** Workflow name, phase badge, elapsed time, token count.

**State Machine Graph:** Full interactive visualization (section 3).

**Tabbed Content Area:**
- **Activity** -- Live feed of state transitions and agent activity (from lifecycle events). Shows what each agent is doing in real-time.
- **Artifacts** -- Browse and view generated artifacts (plan, spec, reviews).
- **Workspace** -- File tree browser for the full workspace.
- **Message Log** -- Searchable view of the JSONL message log.
- **Gate Review** -- Shown only when the workflow is at a gate (section 4).

**Action Bar:** Context-dependent buttons:
- Running: "Abort"
- At gate: Action buttons per section 4.5
- Failed: "Resume", "Inspect"
- Completed: "View Artifacts"

---

## 6. Persona and Workflow Authoring (Exploration)

### 6.1 Persona Management (Feasible -- Phase 3)

Persona CRUD from the web UI is straightforward because personas are simple on-disk structures:

**View personas:**
- Table listing all personas with name, description, server allowlist, compiled status.
- Already partially implemented (`personas.list` RPC exists).

**Create persona:**
- Form: name (validated slug), description, optional server allowlist (multi-select from available servers).
- Backend: creates `~/.ironcurtain/personas/{name}/persona.json` and `constitution.md` (from a template).
- The user would then edit the constitution and compile the policy.

**Edit persona constitution:**
- In-browser markdown editor (textarea with preview) for `constitution.md`.
- Save writes to disk via a new `personas.updateConstitution` RPC.
- "Compile Policy" button triggers `personas.compilePolicy` (async, reports success/failure via event).

**Feasibility assessment:** High. The persona system is file-based with well-defined structure. The main risk is the policy compilation step, which requires LLM calls and can take 30+ seconds. The web UI handles this as an async operation with progress events, similar to `jobs.run`.

### 6.2 Workflow Definition Authoring (Aspirational -- Phase 4+)

A visual workflow editor is significantly more complex:

**Minimal viable approach: JSON editor with live preview.**
- Left panel: JSON editor (Monaco editor or CodeMirror) with the workflow definition.
- Right panel: live-rendered state machine graph (reusing `StateMachineGraph` component).
- JSON schema validation with inline error markers.
- The state machine graph updates on every valid JSON change, giving immediate visual feedback.

**Advanced approach: visual drag-and-drop editor (aspirational).**
- Drag state nodes from a palette onto a canvas.
- Connect states with edges by dragging between connection points.
- Configure state properties (type, persona, prompt, transitions) via a side panel.
- Export as JSON.

**Feasibility assessment:** The JSON editor with live preview is feasible in Phase 4. It requires integrating a code editor component (~200KB for a lightweight option like `@codemirror/basic-setup`) and connecting it to the existing `StateMachineGraph` component. The drag-and-drop visual editor is a significant project in itself (custom graph editor, serialization, undo/redo) and should be deferred to a future iteration.

**Recommendation:** Start with the JSON editor + live preview. The state machine visualization is already being built for the monitoring use case -- reusing it for the authoring preview is cheap. The JSON editor provides power users with full control, and the live preview catches layout errors immediately.

---

## 7. Component Inventory

### 7.1 New UI Components (`src/lib/components/ui/`)

| Component | Directory | Purpose |
|-----------|-----------|---------|
| `Tabs` | `tabs/` | Tab bar with content panels. Used for artifact/workspace/log tabs in detail view. |
| `Textarea` | `textarea/` | Multi-line text input for gate feedback. |
| `Toast` | `toast/` | Non-modal notification for gate raised events. Auto-dismiss after configurable timeout. |
| `Tree` | `tree/` | Hierarchical tree view with expand/collapse. For file tree browsing. |
| `CodeBlock` | `code-block/` | Syntax-highlighted code display. For file viewer and diff hunks. |
| `DiffView` | `diff-view/` | Unified or side-by-side diff renderer. For code review at gates. |
| `Progress` | `progress/` | Stepped progress indicator. For workflow phase display. |

### 7.2 New Feature Components (`src/lib/components/features/`)

| Component | File | Purpose |
|-----------|------|---------|
| `StateMachineGraph` | `state-machine-graph.svelte` | SVG state machine visualization with dagre layout. |
| `WorkflowCard` | `workflow-card.svelte` | Summary card for dashboard listing. |
| `GateReviewPanel` | `gate-review-panel.svelte` | Full gate review experience: artifacts, feedback, actions. |
| `ArtifactViewer` | `artifact-viewer.svelte` | Renders artifact content (markdown, code, file tree). |
| `WorkflowActivity` | `workflow-activity.svelte` | Live feed of state transitions and agent events. |
| `WorkspaceBrowser` | `workspace-browser.svelte` | File tree + file viewer for workspace exploration. |
| `MessageLogViewer` | `message-log-viewer.svelte` | Searchable message log table. |
| `WorkflowStartForm` | `workflow-start-form.svelte` | Form for starting a new workflow. |
| `GateNotificationBanner` | `gate-notification-banner.svelte` | Persistent banner when a gate needs attention. |

### 7.3 New Route Views (`src/routes/`)

| View | File | Purpose |
|------|------|---------|
| `Workflows` | `Workflows.svelte` | Dashboard: active, resumable, history. |
| `WorkflowDetail` | `WorkflowDetail.svelte` | Single workflow: graph, tabs, actions. |

### 7.4 Store Extensions

The `ViewId` type is extended:

```typescript
export type ViewId = 'dashboard' | 'sessions' | 'escalations' | 'jobs' | 'workflows' | 'workflow-detail';
```

New state fields in `AppState`:

```typescript
class AppState {
  // ... existing fields ...

  workflows: Map<string, WorkflowSummaryDto> = $state(new Map());
  selectedWorkflowId: string | null = $state(null);
  pendingGates: Map<string, HumanGateRequestDto & { workflowId: string }> = $state(new Map());
  gateDisplayNumber: number = $state(0);
  gateDismissedAt: number = $state(0);

  get selectedWorkflow(): WorkflowSummaryDto | null { ... }
  get pendingGateCount(): number { ... }
}
```

---

## 8. Data Flow

### 8.1 Workflow Lifecycle Data Flow

```
User clicks "Start"
  -> WorkflowStartForm calls startWorkflow() store action
    -> WS request: workflows.start { definitionPath, taskDescription }
      -> json-rpc-dispatch: workflowManager.getOrchestrator().start(...)
        -> Returns { workflowId }
      -> WorkflowOrchestrator starts XState actor
        -> Emits 'state_entered' lifecycle event
          -> WorkflowManager forwards to WebEventBus
            -> WebUiServer broadcasts 'workflow.state_entered' event
              -> Frontend event handler updates appState.workflows
                -> StateMachineGraph re-renders with new active state
```

### 8.2 Gate Resolution Data Flow

```
User clicks "Approve" in GateReviewPanel
  -> resolveWorkflowGate() store action
    -> WS request: workflows.resolveGate { workflowId, event: 'APPROVE' }
      -> json-rpc-dispatch: orchestrator.resolveGate(id, { type: 'APPROVE' })
        -> XState actor receives HUMAN_APPROVE event
          -> State transitions to next state
            -> 'gate_dismissed' + 'state_entered' lifecycle events
              -> Frontend: gate panel closes, graph updates
```

### 8.3 Event Handler Extensions

New cases in `event-handler.ts`:

```typescript
// New WebEvent union members:
| { event: 'workflow.state_entered'; payload: { workflowId: string; state: string } }
| { event: 'workflow.completed'; payload: { workflowId: string } }
| { event: 'workflow.failed'; payload: { workflowId: string; error: string } }
| { event: 'workflow.gate_raised'; payload: { workflowId: string; gate: HumanGateRequestDto } }
| { event: 'workflow.gate_dismissed'; payload: { workflowId: string; gateId: string } }
| { event: 'workflow.agent_started'; payload: { workflowId: string; stateId: string; persona: string } }
| { event: 'workflow.agent_completed'; payload: { workflowId: string; stateId: string; verdict?: string } }
| { event: 'workflow.artifact_created'; payload: { workflowId: string; artifactName: string } }
```

The handler updates `appState.workflows` by mutating the corresponding `WorkflowListDto` entry (creating a new Map for reactivity). Gate events update `appState.pendingGates` following the same display-number watermark pattern used for escalations.

### 8.4 RPC Actions in stores.svelte.ts

```typescript
// New store action functions:
export async function startWorkflow(definitionPath: string, taskDescription: string, workspacePath?: string): Promise<{ workflowId: string }> { ... }
export async function resumeWorkflow(workflowId: string): Promise<void> { ... }
export async function abortWorkflow(workflowId: string): Promise<void> { ... }
export async function resolveWorkflowGate(workflowId: string, event: string, prompt?: string): Promise<void> { ... }
export async function loadWorkflowArtifact(workflowId: string, artifactName: string): Promise<ArtifactContentDto> { ... }
export async function loadWorkflowDiff(workflowId: string): Promise<DiffEntry[]> { ... }
export async function loadWorkflowFileTree(workflowId: string, path?: string): Promise<FileTreeNode[]> { ... }
export async function loadWorkflowFileContent(workflowId: string, path: string): Promise<{ content: string; language: string }> { ... }
export async function loadWorkflowMessageLog(workflowId: string, limit?: number): Promise<MessageLogEntry[]> { ... }
export async function listWorkflowDefinitions(): Promise<WorkflowDefinitionSummary[]> { ... }
```

### 8.5 Initial Load

On WebSocket connect (in `refreshAll`), the workflow store is populated:

```typescript
const workflows = await client.request<WorkflowSummaryDto[]>('workflows.list');
const newWorkflows = new Map<string, WorkflowSummaryDto>();
for (const wf of workflows) {
  newWorkflows.set(wf.workflowId, wf);
}
appState.workflows = newWorkflows;
```

Gate watermarks follow the same reconnect pattern as escalations -- suppress auto-open for pre-existing gates on initial connect.

---

## 9. Implementation Phases

### Phase 0: Dispatch Refactoring (prerequisite, 1-2 days)

- Extract `json-rpc-dispatch.ts` into domain-specific sub-modules under `src/web-ui/dispatch/` (see section 2.2).
- Move session, job, escalation, and persona handlers into their respective files.
- Main dispatch becomes a thin prefix-based router.
- All existing tests must pass with no behavior changes.

### Phase 1: Backend Foundation + Basic Dashboard (1-2 weeks)

**Backend:**
- Add `WorkflowManager` to the daemon.
- Add workspace collision detection to `WorkflowOrchestrator.start()` (see section 2.1).
- Add global agent session limit enforcement to `executeAgentState()` (see section 2.1).
- Implement `workflows.list`, `workflows.get`, `workflows.start`, `workflows.abort`, `workflows.resolveGate` RPC methods in `dispatch/workflow-dispatch.ts`.
- Wire `WorkflowLifecycleEvent` to `WebEventBus` with the new event types.
- Implement `extractStateGraph()` for graph DTO generation.

**Frontend:**
- Add workflow state to `AppState` and event handling for workflow events.
- Build `Workflows.svelte` dashboard view with active/resumable/history sections.
- Build `WorkflowStartForm` with definition selector and task input.
- Add "Workflows" to sidebar navigation.

**Testing:**
- Unit tests for `extractStateGraph()`.
- Unit tests for workflow event handling in `event-handler.ts`.
- Mock server entries for workflow RPCs.
- E2E test: start workflow, see it appear on dashboard.

### Phase 2: State Machine Visualization + Gate Review (2-3 weeks)

**Frontend:**
- Build `StateMachineGraph` component with dagre layout and SVG rendering.
- Build `WorkflowDetail.svelte` with graph and tabbed content area.
- Build `GateReviewPanel` with artifact rendering and action buttons.
- Build `ArtifactViewer` with markdown rendering (reuse `markdown.ts`).
- Implement gate notification (banner + title flash).
- CSS animations for state transitions.

**Backend:**
- Implement `workflows.artifacts` RPC for reading artifact content.
- Implement `workflows.messageLog` RPC.
- Add `agent_started` / `agent_completed` lifecycle events to orchestrator.

**Testing:**
- Visual regression tests for state machine graph (snapshot testing).
- E2E test: workflow reaches gate, user reviews and approves.
- E2E test: gate notification appears when on a different page.

### Phase 3: Workspace Browser + Diff View + Persona Management (2-3 weeks)

**Frontend:**
- Build `WorkspaceBrowser` with file tree and code viewer.
- Build `DiffView` component.
- Build persona management views (list, create, edit constitution).

**Backend:**
- Implement `workflows.diff`, `workflows.fileTree`, `workflows.fileContent` RPCs.
- Implement `personas.create`, `personas.get`, `personas.updateConstitution`, `personas.compilePolicy` RPCs.
- Add `persona.compile_started` / `persona.compile_completed` events.

**Testing:**
- E2E test: browse workspace files during gate review.
- E2E test: view diff of workspace changes.
- E2E test: create persona, compile policy.

### Phase 4: Workflow Authoring + Polish (2-3 weeks)

**Frontend:**
- JSON editor with live state machine preview.
- Workflow resume UI with state selection.
- Polish: animation timing, responsive layout, keyboard shortcuts.
- Accessibility audit for state machine graph (ARIA labels, screen reader support).

**Backend:**
- Implement `workflows.resume` with optional state override.
- Workflow definition save/load RPCs.

**Dependencies:**
- `@dagrejs/dagre` (layout) -- ~30KB, MIT license, bundled in frontend.
- No other new frontend dependencies for Phase 1-3.
- Phase 4 (JSON editor) adds a code editor dependency (CodeMirror ~200KB or a lighter alternative).

---

## 10. Testing Infrastructure

### 10.1 Mock WS Server Workflow Support

The mock server (`packages/web-ui/scripts/mock-ws-server.ts`) is extended with workflow-specific canned data and simulation logic.

**Canned workflow data** (four workflows covering each phase):

```typescript
const CANNED_WORKFLOWS: MockWorkflow[] = [
  {
    workflowId: 'wf-running-1',
    name: 'design-and-code',
    phase: 'running',
    currentState: 'implement',
    startedAt: new Date(Date.now() - 300_000).toISOString(),
  },
  {
    workflowId: 'wf-gate-1',
    name: 'design-and-code',
    phase: 'waiting_human',
    currentState: 'plan_review',
    startedAt: new Date(Date.now() - 600_000).toISOString(),
  },
  {
    workflowId: 'wf-completed-1',
    name: 'design-and-code',
    phase: 'completed',
    currentState: 'done',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
  },
  {
    workflowId: 'wf-failed-1',
    name: 'design-and-code',
    phase: 'failed',
    currentState: 'implement',
    startedAt: new Date(Date.now() - 1800_000).toISOString(),
  },
];
```

**Lifecycle simulation:** When a workflow is started via `workflows.start`, the mock server plays a scripted sequence of events with realistic timing:

1. Emit `workflow.state_entered` for the initial state (immediate)
2. Emit `workflow.agent_started` (200ms delay)
3. Emit `workflow.agent_completed` (2s delay)
4. Emit `workflow.state_entered` for the next state (200ms delay)
5. If the next state is a human gate, emit `workflow.gate_raised` (100ms delay) and stop
6. Otherwise continue the sequence through 2-3 more states

**Test injection endpoint:** `POST /__workflow-event` on the HTTP test server (port 7401) allows Playwright tests to trigger specific events without waiting for the scripted sequence:

```typescript
// POST /__workflow-event
// Body: { event: 'workflow.gate_raised', payload: { workflowId: '...', gate: { ... } } }
```

**RPC method handlers:** The mock server implements `workflows.list`, `workflows.get`, `workflows.start`, `workflows.abort`, `workflows.resolveGate`, `workflows.definitions`, and `workflows.artifacts`. Each returns canned data that matches the DTO types defined in section 2.3.

### 10.2 Test Fixtures

Canned test data for both unit and E2E tests:

**`StateGraphDto` for `design-and-code` workflow:**

```typescript
const CANNED_STATE_GRAPH: StateGraphDto = {
  states: [
    { id: 'plan', type: 'agent', persona: 'planner', label: 'Plan' },
    { id: 'plan_review', type: 'human_gate', label: 'Plan Review' },
    { id: 'spec', type: 'agent', persona: 'architect', label: 'Spec' },
    { id: 'implement', type: 'agent', persona: 'coder', label: 'Implement' },
    { id: 'review', type: 'agent', persona: 'critic', label: 'Review' },
    { id: 'design_review', type: 'human_gate', label: 'Design Review' },
    { id: 'done', type: 'terminal', label: 'Done' },
    { id: 'aborted', type: 'terminal', label: 'Aborted' },
  ],
  transitions: [
    { from: 'plan', to: 'plan_review', label: '' },
    { from: 'plan_review', to: 'spec', event: 'APPROVE', label: 'Approve' },
    { from: 'plan_review', to: 'plan', event: 'FORCE_REVISION', label: 'Revise' },
    { from: 'plan_review', to: 'aborted', event: 'ABORT', label: 'Abort' },
    { from: 'spec', to: 'implement', label: '' },
    { from: 'implement', to: 'review', label: '' },
    { from: 'review', to: 'implement', guard: 'isRejected', label: 'Rejected' },
    { from: 'review', to: 'design_review', guard: 'isApproved', label: 'Approved' },
    { from: 'design_review', to: 'done', event: 'APPROVE', label: 'Approve' },
    { from: 'design_review', to: 'implement', event: 'FORCE_REVISION', label: 'Revise' },
    { from: 'design_review', to: 'aborted', event: 'ABORT', label: 'Abort' },
  ],
};
```

**Sample artifact content:**

```typescript
const CANNED_ARTIFACTS: Record<string, ArtifactContentDto> = {
  plan: {
    name: 'plan',
    files: [{ path: 'plan.md', content: '# Implementation Plan\n\n## Goals\n- Build X\n- Integrate Y\n\n## Steps\n1. ...', language: 'markdown' }],
  },
  spec: {
    name: 'spec',
    files: [{ path: 'spec.md', content: '# Technical Spec\n\n## Architecture\n...', language: 'markdown' }],
  },
  review: {
    name: 'review',
    files: [{ path: 'review.md', content: '# Code Review\n\n## Verdict: approved\n...', language: 'markdown' }],
  },
};
```

**Sample message log entries:**

```typescript
const CANNED_MESSAGE_LOG: MessageLogEntry[] = [
  { ts: '...', workflowId: 'wf-running-1', state: 'plan', type: 'agent_sent', role: 'planner', message: 'Create a plan for...' },
  { ts: '...', workflowId: 'wf-running-1', state: 'plan', type: 'agent_received', role: 'planner', message: '...', verdict: 'approved', confidence: 'high' },
  { ts: '...', workflowId: 'wf-running-1', state: 'plan_review', type: 'gate_resolved', event: 'APPROVE', prompt: null },
];
```

### 10.3 Component Tests

**`StateMachineGraph` tested via `@testing-library/svelte` + snapshot:**

- Render with `CANNED_STATE_GRAPH`, `currentState: 'implement'`, and sample transition history.
- Snapshot the SVG output to catch unintended layout changes.
- Verify active state has the correct CSS class (`state--active`).
- Verify completed states (those in transition history as `from`) have `state--completed` class.
- Verify terminal state nodes render with double-border styling.

**`GateReviewPanel` tested with mock gate data:**

- Render with a gate having `acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT']`.
- Verify action buttons match the `acceptedEvents` array.
- Verify "Request Revision" button is disabled when the feedback textarea is empty.
- Verify "Request Revision" button enables when feedback text is entered.
- Verify "Abort" shows a confirmation dialog before emitting the resolve callback.
- Verify artifact tabs render for each `presentedArtifacts` entry.

### 10.4 E2E Playwright Tests

**Start workflow and verify dashboard updates:**

1. Navigate to Workflows dashboard.
2. Click "Start New Workflow", fill in definition + task description, submit.
3. Verify a new workflow card appears in the Active Workflows section with `phase: 'running'`.
4. Verify `workflow.state_entered` events cause the current state to update in the card.

**Gate appears, review artifacts, approve:**

1. Inject a `workflow.gate_raised` event via `POST /__workflow-event`.
2. Verify the gate notification banner appears (or the gate review panel activates if already on the workflow detail page).
3. Navigate to the workflow detail page.
4. Verify the gate review panel shows with the correct artifact tabs.
5. Click an artifact tab and verify rendered content appears.
6. Click "Approve".
7. Verify `workflow.gate_dismissed` and `workflow.state_entered` events update the UI (gate panel closes, graph advances).

**Abort workflow and verify status update:**

1. Navigate to a running workflow's detail page.
2. Click "Abort".
3. Confirm the confirmation dialog.
4. Verify the workflow phase updates to `'aborted'` in the dashboard.

---

## 11. Open Questions

1. **Workflow persistence across daemon restarts.** The orchestrator uses in-memory `WorkflowInstance` maps. When the daemon restarts, active workflows are lost but checkpoints survive on disk. Should the web UI show checkpointed-but-not-running workflows as "interrupted" with a resume button? (Recommendation: yes, this is what `listResumable()` already provides.)

2. **Concurrent gate resolution.** ~~Resolved.~~ If both CLI and web UI are running, both could attempt to resolve the same gate. The orchestrator's `resolveGate()` must guard against double resolution by checking `activeGateId` before sending the XState event. This is an orchestrator fix (not a web UI concern) but is a prerequisite for safe concurrent access. The fix:

   ```typescript
   resolveGate(id: WorkflowId, event: HumanGateEvent): void {
     const instance = this.workflows.get(id);
     if (!instance?.activeGateId) return; // already resolved or no gate
     // ... proceed with resolution
     instance.activeGateId = null; // clear before sending event
   }
   ```

   The JSON-RPC dispatch layer returns `WORKFLOW_NOT_AT_GATE` error when `resolveGate()` is called on a workflow with no active gate.

3. **Diff computation strategy.** The `workflows.diff` RPC needs to compute a git diff of the workspace. For fresh workspaces (no git history), should we initialize a git repo at workflow start and commit after each agent state? This would give clean diffs between states. (Recommendation: yes, the orchestrator should `git init` + `git add -A` + `git commit` the workspace at the start and after each agent state completes. The commit message includes the state name.)

4. **Artifact size limits.** Large artifacts (e.g., a full codebase review) could be expensive to transmit over WebSocket. Should the `workflows.artifacts` RPC support pagination or streaming? (Recommendation: for v1, limit artifact content to 1MB per file and paginate the file list. Larger files show a "too large to display" message with a download link.)

5. **State machine graph for custom workflows.** The `StateMachineGraph` component is designed for the `design-and-code` workflow's topology. Custom workflows could have arbitrarily complex graphs. How should the component handle graphs with 20+ states? (Recommendation: dagre handles this well up to ~50 nodes. For very large graphs, add a minimap overlay and viewport controls. This is unlikely to be needed in practice -- most workflows will have fewer than 15 states.)

6. **Workspace path security.** The `workflows.fileTree` and `workflows.fileContent` RPCs serve arbitrary file content from the workspace directory. The backend must enforce that the requested path is within the workspace boundary (same `resolveRealPath` + containment check used by the policy engine). Symlink escapes must be prevented.

7. **Dagre bundle size.** `@dagrejs/dagre` is ~30KB minified. This is acceptable for the web UI bundle. However, if we want to avoid the dependency entirely, we could implement a simplified layered layout for the specific topology patterns we support (linear pipeline with optional backward edges). This would be ~200 lines of custom code. (Recommendation: use dagre. The library is well-tested and handles edge cases we would miss in a custom implementation.)

8. **Gate review for non-markdown artifacts.** The current design focuses on markdown artifacts (plan.md, spec.md, review.md). If future workflows produce non-markdown artifacts (images, JSON data, binary files), the artifact viewer needs to handle them gracefully. (Recommendation: for v1, render markdown as HTML, JSON as syntax-highlighted code, and everything else as plain text. Binary files show metadata only.)

9. **Historic workflow listing.** Phase 1 `workflows.list` returns only active (in-memory) workflows. To show completed/failed history, the backend would need to scan checkpoint files on disk. This adds I/O latency and requires defining a retention policy. Deferred -- revisit after Phase 1 validates the active workflow UX.
