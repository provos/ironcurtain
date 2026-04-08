# Design: Daemon Web UI

**Status:** Implemented (PRs #154, #157, #159)
**Date:** 2026-04-04 (drafted), 2026-04-08 (consolidated)
**Author:** IronCurtain Engineering

---

## 1. Problem Statement

IronCurtain's daemon mode supports CLI (Unix domain socket) and Signal (WebSocket to signal-cli-rest-api) interaction surfaces. Both are limited:

- **CLI** is request-response only. No live streaming, no concurrent visibility into multiple sessions.
- **Signal** is linear and text-only. Escalation context is compressed to plain text. Multi-session management with `#N` prefixes is awkward.

The web UI provides:

1. **Live streaming** of session output with markdown rendering and syntax highlighting.
2. **Escalation dashboard** with full tool call context and one-click approval, plus a modal overlay for non-disruptive resolution.
3. **Job management** with proper forms instead of CLI prompts.
4. **Budget monitoring** with real-time gauges.
5. **Workflow visualization** with state machine graphs, file browsers, and artifact inspection.

### Non-goals

- Remote access over the internet. This is a local development tool.
- Replacing the CLI or Signal transports. All three coexist.
- Mobile-optimized design. Desktop browser is the primary target.

## 2. Design Overview

The web UI is a **bundled static asset** served directly by the daemon process. The Svelte 5 SPA is built at dev/release time in `packages/web-ui/`, compiled output is copied to `dist/web-ui-static/` during `npm run build`, and the daemon serves static files and handles WebSocket upgrades using Node's `http.createServer()`.

```
                        IronCurtainDaemon
                              |
               +--------------+--------------+
               |              |              |
        ControlSocket    SignalBotDaemon    WebUiServer
        (UDS, JSON)      (WS client)       (HTTP + WS server)
               |              |              |
               v              v              v
            CLI tools    signal-cli       Browser SPA
                         container        (static files + WS)
```

The browser communicates with the daemon over a single WebSocket using a JSON-RPC frame protocol. All requests (status queries, job CRUD, session messaging, escalation resolution, workflow operations) and all pushed events flow over this one connection.

This architecture provides:

- **Zero frontend runtime dependencies** in the published npm package. Only compiled static output ships.
- **No Docker requirement** for the web UI.
- **Single process** -- the daemon owns the HTTP server directly.
- **Trivial deployment** -- `npm install -g ironcurtain` includes everything.

## 3. Key Design Decisions

1. **Daemon serves static assets directly (no Docker container).** The SPA compiles to plain HTML/JS/CSS. The daemon serves it directly from `dist/web-ui-static/` via native `http.createServer()` with manual MIME type mapping. Hono was considered but not used -- raw `http.createServer()` avoids the dependency and gives full control over the upgrade handler.

2. **Single WebSocket with JSON-RPC frame protocol.** All communication flows over one WebSocket using request/response/event frames. No REST routes. Simplifies authentication (one handshake) and naturally supports long-running operations.

3. **Direct session targeting (no focus management).** Unlike Signal's `currentLabel` routing, the web UI always specifies the target session label explicitly. Web sessions do not update `currentLabel` or participate in `findMostRecentSignalLabel()`.

4. **Escalation resolution consolidated into SessionManager.** `SessionManager.resolveSessionEscalation()` is the single codepath for all three transports (Signal, web, cron auto-deny), with `whitelistSelection` passthrough.

5. **Session messaging is WebSocket-only.** Messages flow as JSON-RPC requests; responses stream back as `session.output` events. The request gets an immediate ack.

6. **Bearer token auth, delivered via URL.** The daemon generates a random token per launch, prints a full URL with the token as a query parameter to stderr, and the SPA extracts and stores it in `sessionStorage`.

7. **Opt-in via `--web-ui` flag or config setting.** The web UI server is not started by default. Default port is 7400.

8. **`escalation.expired` is its own event type.** Not overloaded onto `session.ended` or `escalation.resolved`.

9. **Full escalation data stored in ManagedSession.** `pendingEscalation: EscalationDto | null` replaces the string-only `pendingEscalationId`, enabling `escalations.list` to return data to late-connecting clients and the expiry handler to emit the correct escalation ID.

10. **Per-session message queuing.** Instead of a boolean `messageInFlight` flag, each session gets a serial promise chain. Messages are processed sequentially per session but different sessions process concurrently. This eliminates TOCTOU races from multiple browser tabs.

11. **Dispatch decomposed into sub-modules.** JSON-RPC dispatch is split by domain prefix (`session-dispatch.ts`, `job-dispatch.ts`, `escalation-dispatch.ts`, `workflow-dispatch.ts`, `persona-dispatch.ts`) in `src/web-ui/dispatch/`, with a thin router in `json-rpc-dispatch.ts`.

## 4. JSON-RPC Frame Protocol

All browser-daemon communication flows over a single WebSocket at `/ws`.

### 4.1 Frame Types

```typescript
// src/web-ui/web-ui-types.ts

/** Literal union of all valid JSON-RPC method names. */
export type MethodName =
  | 'status'
  | 'jobs.list' | 'jobs.remove' | 'jobs.enable'
  | 'jobs.disable' | 'jobs.recompile' | 'jobs.reload' | 'jobs.run' | 'jobs.logs'
  | 'sessions.list' | 'sessions.get' | 'sessions.create' | 'sessions.end'
  | 'sessions.send' | 'sessions.budget' | 'sessions.history' | 'sessions.diagnostics'
  | 'escalations.list' | 'escalations.resolve'
  | 'personas.list' | 'personas.get' | 'personas.compile'
  | 'workflows.list' | 'workflows.get' | 'workflows.start' | 'workflows.import'
  | 'workflows.resume' | 'workflows.abort' | 'workflows.resolveGate'
  | 'workflows.inspect' | 'workflows.fileTree' | 'workflows.fileContent'
  | 'workflows.artifacts' | 'workflows.listDefinitions' | 'workflows.listResumable';

/** Browser -> Daemon request frame. */
export interface RequestFrame {
  readonly id: string;       // UUID, set by browser
  readonly method: MethodName;
  readonly params?: Record<string, unknown>;
}

/** Daemon -> Browser response to a specific request. */
export type ResponseFrame =
  | { readonly id: string; readonly ok: true; readonly payload?: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } };

/** Daemon -> Browser unsolicited push event. */
export interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;      // monotonically increasing counter for ordering
}

/** Error codes for ResponseFrame errors. */
export type ErrorCode =
  | 'AUTH_REQUIRED' | 'SESSION_NOT_FOUND' | 'JOB_NOT_FOUND'
  | 'ESCALATION_NOT_FOUND' | 'ESCALATION_EXPIRED' | 'SESSION_BUSY'
  | 'WORKFLOW_NOT_FOUND' | 'WORKFLOW_NOT_AT_GATE' | 'ARTIFACT_NOT_FOUND'
  | 'PERSONA_NOT_FOUND' | 'FILE_TOO_LARGE'
  | 'INVALID_PARAMS' | 'RATE_LIMITED' | 'METHOD_NOT_FOUND' | 'INTERNAL_ERROR';
```

### 4.2 Methods

All request params are validated with Zod schemas before dispatch. Validation failures return `INVALID_PARAMS` error responses.

| Method | Params | Response payload | Notes |
|--------|--------|-----------------|-------|
| `status` | -- | `DaemonStatusDto` | |
| `jobs.list` | -- | `JobListDto[]` | |
| `jobs.remove` | `{ jobId }` | -- | |
| `jobs.enable` | `{ jobId }` | -- | |
| `jobs.disable` | `{ jobId }` | -- | |
| `jobs.recompile` | `{ jobId }` | -- | |
| `jobs.reload` | `{ jobId }` | -- | Reload job definition from disk and reschedule |
| `jobs.run` | `{ jobId }` | `{ accepted, jobId }` | Fire-and-forget; progress via events |
| `jobs.logs` | `{ jobId, limit? }` | `RunRecord[]` | |
| `sessions.list` | -- | `SessionDto[]` | |
| `sessions.get` | `{ label }` | `SessionDetailDto` | |
| `sessions.create` | `{ persona? }` | `{ label }` | |
| `sessions.end` | `{ label }` | -- | |
| `sessions.send` | `{ label, text }` | `{ accepted }` | Ack only; output arrives as events |
| `sessions.budget` | `{ label }` | `BudgetSummaryDto` | |
| `sessions.history` | `{ label }` | `ConversationTurn[]` | |
| `sessions.diagnostics` | `{ label }` | `DiagnosticEvent[]` | |
| `escalations.list` | -- | `EscalationDto[]` | |
| `escalations.resolve` | `{ escalationId, decision, whitelistSelection? }` | -- | |
| `personas.list` | -- | persona list | |
| `personas.get` | `{ name }` | `PersonaDetailDto` | |
| `personas.compile` | `{ name }` | `PersonaCompileResultDto` | |
| `workflows.list` | -- | `WorkflowSummaryDto[]` | |
| `workflows.get` | `{ workflowId }` | `WorkflowDetailDto` | |
| `workflows.start` | `{ name, task, model?, workspace? }` | `{ workflowId }` | |
| `workflows.import` | `{ yaml }` | `{ name }` | Parse and import YAML definition |
| `workflows.resume` | `{ baseDir, state? }` | `{ workflowId }` | Resume a checkpointed workflow |
| `workflows.abort` | `{ workflowId }` | -- | |
| `workflows.resolveGate` | `{ workflowId, gateId, event }` | -- | |
| `workflows.inspect` | `{ workflowId }` | messages log | |
| `workflows.fileTree` | `{ workflowId, path? }` | `FileTreeResponseDto` | Browse workspace files |
| `workflows.fileContent` | `{ workflowId, path }` | `FileContentResponseDto` | Read file content |
| `workflows.artifacts` | `{ workflowId, name }` | `ArtifactContentDto` | |
| `workflows.listDefinitions` | -- | `WorkflowDefinitionDto[]` | Bundled + user definitions |
| `workflows.listResumable` | -- | `ResumableWorkflowDto[]` | Checkpointed workflows |

### 4.3 Events

| Event | Payload | Notes |
|-------|---------|-------|
| `session.created` | `SessionDto` | |
| `session.ended` | `{ label, reason }` | |
| `session.updated` | `SessionDto` | Session state change (persona, status) |
| `session.thinking` | `{ label, turnNumber }` | Emitted when `forwardMessage()` starts |
| `session.tool_call` | `{ label, toolName, preview }` | Per tool call during a turn |
| `session.tool_result` | `{ label, toolName, stepIndex }` | Emitted when a step completes |
| `session.text_delta` | `{ label, preview }` | Up to 200 chars of text per step (post-step snapshot, not streaming) |
| `session.output` | `{ label, text, turnNumber }` | Final response when `forwardMessage()` resolves |
| `session.diagnostic` | `{ label, event }` | Raw diagnostic events |
| `session.budget_update` | `{ label, budget }` | |
| `escalation.created` | `EscalationDto` | |
| `escalation.resolved` | `{ escalationId, decision }` | Single source: transport callback |
| `escalation.expired` | `{ escalationId, sessionLabel }` | |
| `job.started` | `{ jobId, sessionLabel }` | |
| `job.completed` | `{ jobId, record }` | |
| `job.failed` | `{ jobId, error }` | |
| `job.list_changed` | `{}` | Emitted from daemon job mutation methods |
| `daemon.status` | `DaemonStatusDto` | Periodic (every 10s) |
| `workflow.started` | `{ workflowId, name, taskDescription }` | |
| `workflow.state_entered` | `{ workflowId, state, previousState? }` | |
| `workflow.completed` | `{ workflowId }` | |
| `workflow.failed` | `{ workflowId, error }` | |
| `workflow.gate_raised` | `{ workflowId, gate }` | Human gate awaiting input |
| `workflow.gate_dismissed` | `{ workflowId, gateId }` | Gate resolved |
| `workflow.agent_started` | `{ workflowId, stateId, persona }` | |
| `workflow.agent_completed` | `{ workflowId, stateId, verdict?, confidence? }` | |

**Processing lifecycle notes.** The `text_delta` events are per-step post-completion snapshots (up to 200 chars), not token-level streaming. Each event is emitted from `onStepFinish`, meaning there is no feedback during a long inference step. True token-level streaming is deferred. The `step_finish` diagnostic kind is defined in `DiagnosticEvent` and emitted by `AgentSession`, enabling `session.tool_result` events.

**Event source of truth.** The `escalation.resolved` event is emitted only from `WebSessionTransport.onEscalationResolved` callback, not from the dispatch handler. This prevents duplicate emission for web-initiated resolutions and ensures correct behavior for cross-transport resolution (e.g., a web session's escalation approved via Signal).

## 5. Daemon-Side Architecture

### 5.1 Module Structure

```
src/web-ui/
  web-ui-server.ts         -- WebUiServer class (HTTP + WS, static file serving)
  web-session-transport.ts -- WebSessionTransport (extends BaseTransport)
  web-ui-types.ts          -- Frame types, DTOs, error classes, workflow DTOs
  web-event-bus.ts         -- WebEventBus (typed pub/sub)
  json-rpc-dispatch.ts     -- Thin router dispatching by method prefix
  workflow-manager.ts      -- WorkflowManager (bridges workflow engine to web UI)
  state-graph.ts           -- State machine graph utilities for workflow DTOs
  dispatch/
    types.ts               -- DispatchContext, DTO builders (toSessionDto, toBudgetDto)
    session-dispatch.ts    -- sessions.* methods
    job-dispatch.ts        -- jobs.* methods
    escalation-dispatch.ts -- escalations.* methods
    workflow-dispatch.ts   -- workflows.* methods
    persona-dispatch.ts    -- personas.* methods

src/session/
  session-manager.ts       -- SessionSource with 'web' kind, resolveSessionEscalation(),
                              pendingEscalation: EscalationDto | null

packages/web-ui/           -- Svelte 5 SPA (workspace package, private)
  src/
    App.svelte
    views/
      Dashboard.svelte
      Sessions.svelte
      Escalations.svelte
      Jobs.svelte
      Workflows.svelte
      WorkflowDetail.svelte
      Personas.svelte
    lib/
      components/
        features/           -- Escalation card/modal, session console, file viewer, etc.
        ui/                 -- shadcn-svelte components (button, card, table, modal, etc.)
      ws-client.ts          -- Typed WebSocket client (JSON-RPC framing + reconnection)
      stores.svelte.ts      -- Svelte 5 rune-based reactive stores
      event-handler.ts      -- Event dispatch with EventSideEffects for testability
      flash-title.ts        -- Background-tab title flashing for escalations
      markdown.ts           -- Markdown rendering (marked + DOMPurify + Shiki)
      output-grouping.ts    -- Session output grouping logic
      types.ts              -- Frontend type definitions
      utils.ts              -- Utility functions (cn() class merging)
```

### 5.2 WebUiServer

The core daemon-side component. Creates a raw `http.createServer()`, serves static files with manual MIME type mapping, handles WebSocket upgrades via `ws.WebSocketServer`, authenticates connections, dispatches JSON-RPC methods, and broadcasts events.

Key implementation details:

- **Static file serving** uses a cache (`staticCache: Map`) with `readFileSync` + MIME type lookup. Files outside `staticRoot` are rejected via real-path containment check.
- **WebSocket upgrade** validates the token via `timingSafeEqual`, validates Origin header (strict in production, skipped with `--web-ui-dev`), then upgrades.
- **Ping/pong heartbeat** at 30s intervals. Clients missing 2 consecutive pings are terminated.
- **Orphaned session cleanup** via a grace period timer (60s default). When all connections close, the timer starts. If no client reconnects before it fires, all web sessions are ended.
- **Event broadcasting** via `WebEventBus` subscription -- the server subscribes in its constructor and broadcasts all events to connected clients.

### 5.3 WebEventBus

Typed pub/sub bus decoupling event producers from WebSocket consumers. The `WebEventMap` interface ensures event name -> payload type is enforced at compile time. All connected clients receive all events (no per-client filtering needed for a local tool).

### 5.4 WebSessionTransport

Follows the `SignalSessionTransport` pattern:
- `runSession()` blocks until `close()` resolves a promise.
- `forwardMessage()` delegates to `sendAndLog()`.
- Callback factories emit events to the `WebEventBus`:
  - `createDiagnosticHandler()` emits both raw `session.diagnostic` and fine-grained `session.tool_call` / `session.text_delta` / `session.tool_result`.
  - `createEscalationHandler()` stores the full `EscalationDto` in `ManagedSession` via `setPendingEscalation()` before emitting `escalation.created`.
  - `createEscalationExpiredHandler()` reads `managed.pendingEscalation.escalationId` before clearing.
  - `createEscalationResolvedHandler()` is the single source of truth for `escalation.resolved` events.

### 5.5 Integration with IronCurtainDaemon

The daemon gains an optional `WebUiServer` field, started after the control socket. The `--web-ui` flag or `daemon.webUi.enabled` config setting controls activation. The server is dynamically imported so the `ws` dependency does not load when the web UI is disabled.

```bash
# Via flag
ironcurtain daemon --web-ui
ironcurtain daemon --web-ui --web-port 8080

# With development mode (skips Origin validation for Vite dev server)
ironcurtain daemon --web-ui --web-ui-dev

# Via config.json
{
  "daemon": { "webUi": { "enabled": true, "port": 7400 } }
}
```

## 6. SessionManager Changes

### 6.1 SessionSource Extension and Escalation Storage

```typescript
export type SessionSource =
  | { readonly kind: 'signal' }
  | { readonly kind: 'cron'; readonly jobId: JobId; readonly jobName: string }
  | { readonly kind: 'web' };

export interface ManagedSession {
  readonly label: number;
  readonly session: Session;
  readonly transport: Transport;
  readonly source: SessionSource;
  messageInFlight: boolean;
  /** Full escalation data for late-connecting clients and expiry handling. */
  pendingEscalation: EscalationDto | null;
  escalationResolving: boolean;
  runPromise: Promise<void> | null;
}
```

### 6.2 Escalation Resolution Extraction

`SessionManager.resolveSessionEscalation()` is the single codepath for all transports:

```typescript
async resolveSessionEscalation(
  escalationId: string,
  decision: 'approved' | 'denied',
  options?: { whitelistSelection?: number },
): Promise<EscalationResolutionResult> {
  // Find session by pendingEscalation.escalationId
  // Guard against double-resolution (escalationResolving flag)
  // Call session.resolveEscalation() with whitelistSelection passthrough
  // Clear pendingEscalation in finally block
}
```

### 6.3 Web Sessions and currentLabel

Web sessions do not update `currentLabel`. The browser UI always specifies the target label explicitly. `findMostRecentSignalLabel()` only considers Signal sessions.

## 7. DTO Types

The full DTO type definitions are in `src/web-ui/web-ui-types.ts`. Key types:

- **SessionDto** / **SessionDetailDto** -- session snapshot with budget, escalation state, persona.
- **BudgetSummaryDto** -- token/step/time/cost consumption with limits.
- **EscalationDto** -- full escalation context (tool call, arguments, reason, whitelist candidates).
- **DaemonStatusDto** -- uptime, job counts, transport states.
- **JobListDto** -- job definition with scheduling and last-run info.
- **WorkflowSummaryDto** / **WorkflowDetailDto** -- workflow state with graph, transitions, context.
- **StateGraphDto** / **StateNodeDto** / **TransitionEdgeDto** -- state machine graph for visualization.
- **HumanGateRequestDto** -- human gate with accepted events and artifact names.
- **FileTreeResponseDto** / **FileContentResponseDto** -- workspace file browsing.
- **PersonaDetailDto** / **PersonaCompileResultDto** -- persona management.

## 8. Authentication and Security

### 8.1 Local-Only Binding

The HTTP server binds to `127.0.0.1` by default. Binding to `0.0.0.0` requires explicit `--web-host 0.0.0.0` and prints a warning. No TLS.

### 8.2 Bearer Token Flow

1. Daemon generates `randomBytes(32).toString('base64url')` per launch.
2. Prints full URL with token to stderr: `Web UI: http://127.0.0.1:7400?token=<token>`.
3. SPA extracts token from `window.location.search`, stores in `sessionStorage`, strips from URL via `history.replaceState()`.
4. If no token in URL or `sessionStorage`, shows a prompt to paste from stderr.
5. WebSocket handshake: `ws://127.0.0.1:7400/ws?token=<token>`.
6. Token comparison uses `crypto.timingSafeEqual()`.

There is no unauthenticated endpoint serving the token.

### 8.3 Origin Validation

Strict in production: only connections from `127.0.0.1` or `localhost` at the daemon's port are accepted. In dev mode (`--web-ui-dev`), Origin validation is skipped so the Vite dev server on port 5173 can connect directly. The token remains the primary auth gate.

### 8.4 Additional Protections

- **WebSocket message size**: `maxPayload: 1MB` on `ws.WebSocketServer`.
- **XSS**: Agent output rendered via `marked` + `DOMPurify`. Tool arguments are JSON-rendered.
- **CSP**: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`.
- **Rate limiting**: Session creation max 5/min per connection. Max 10 concurrent WebSocket connections. Per-session message queuing.
- **Policy bypass prevention**: The web UI communicates exclusively through the daemon API. Tool calls flow through the agent and policy engine.

## 9. Frontend Architecture

### 9.1 Technology Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`). SvelteKit is NOT used -- pure SPA.
- **Vite** for development (HMR) and production bundling.
- **shadcn-svelte** component library (copy-into-project, based on Bits UI headless primitives).
- **Tailwind CSS v3** with CSS variable theming and `class`-strategy dark mode.
- **marked** + **DOMPurify** for sanitized markdown rendering.
- **Shiki** for syntax highlighting.
- **Hash-based routing** for navigation.

Forms use plain Svelte 5 runes (`$state` for field values, `$derived` for validation errors) with Zod validation. Data tables use plain `{#each}` loops with sorted arrays. Neither `sveltekit-superforms`/`formsnap` (require SvelteKit) nor `@tanstack/svelte-table` (unnecessary for small data sets) nor `xterm-svelte` (uncertain Svelte 5 compatibility) were used.

### 9.2 State Management

```typescript
// packages/web-ui/src/lib/stores.svelte.ts

class AppState {
  connected: boolean = $state(false);
  daemonStatus: DaemonStatusDto | null = $state(null);
  sessions: Map<number, SessionDto> = $state(new Map());
  selectedSessionLabel: number | null = $state(null);
  pendingEscalations: Map<string, PendingEscalation> = $state(new Map());
  jobs: JobListDto[] = $state([]);
  sessionOutputs: Map<number, OutputLine[]> = $state(new Map());
  // ... derived getters
}
```

`selectedSessionLabel` is UI-local state (which tab the user clicked), not `currentLabel` from SessionManager.

### 9.3 WebSocket Client

The client implements exponential-backoff reconnection. On reconnect, it re-fetches all state in parallel (`Promise.all([status, sessions.list, jobs.list, escalations.list])`) and rehydrates stores.

### 9.4 Views

| View | Route | Data sources | Real-time events |
|------|-------|-------------|-----------------|
| **Dashboard** | `#/` | `status`, `sessions.list`, `jobs.list`, `escalations.list` | `daemon.status`, `session.*`, `job.*` |
| **Sessions** | `#/sessions/:label?` | `sessions.list`, `sessions.get`, `sessions.history`, `sessions.budget` | `session.*` events for selected session |
| **Escalations** | `#/escalations` | `escalations.list` | `escalation.*` |
| **Jobs** | `#/jobs/:jobId?` | `jobs.list`, `jobs.logs` | `job.*` |
| **Workflows** | `#/workflows` | `workflows.list`, `workflows.listDefinitions` | `workflow.*` |
| **Workflow Detail** | `#/workflows/:id` | `workflows.get`, `workflows.fileTree`, `workflows.fileContent` | `workflow.*` |
| **Personas** | `#/personas/:name?` | `personas.list`, `personas.get` | -- |

The sidebar shows navigation and an escalation count badge.

### 9.5 Component Library

shadcn-svelte components are scaffolded into `packages/web-ui/src/lib/components/ui/` via CLI and become project-owned source. Currently scaffolded: button, card, badge, table, tabs, dropdown-menu, input, modal, spinner, alert. The runtime dependency is Bits UI (~30KB gzipped).

## 10. Escalation Modal UX

The escalation experience uses a **modal dialog** for fast resolution, with the sidebar badge as a passive indicator when dismissed. This mirrors the terminal mux's floating overlay.

### 10.1 Component Structure

```
packages/web-ui/src/lib/components/
  features/
    escalation-card.svelte      -- Shared escalation card (used by both modal and page)
    escalation-modal.svelte     -- Modal with tab bar + cards + keyboard shortcuts
  ui/
    modal/                      -- Generic modal (backdrop, focus trap, Escape handling)
      modal.svelte
      index.ts
```

### 10.2 Generic Modal

Reusable component providing backdrop, centering, close-on-Escape, close-on-backdrop-click, and a focus trap:

- **On open:** saves `document.activeElement`, moves focus to first interactive element inside.
- **While open:** Tab/Shift+Tab cycles among modal's focusable elements (never escapes).
- **On close:** restores focus to previously focused element.
- ARIA: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to title.
- Escape `keydown` handler calls `event.stopPropagation()` before closing to prevent propagation.

### 10.3 Escalation Card

Shared component used by both the Escalations page and the modal:

```typescript
{
  escalation: EscalationDto;
  loading: boolean;
  onapprove: (whitelistSelection?: number) => void;
  ondeny: () => void;
}
```

The card owns its whitelist selection state via a local `$state` variable. Includes a "View Session #N" link that navigates to the session view and closes the modal.

### 10.4 Escalation Modal

Composes the generic Modal with a tab bar and escalation cards:

- **Tab bar:** Each escalation gets a numbered tab with summary (e.g., "filesystem / write_file"). Left/Right arrows navigate. If the focused tab's escalation expires, focus snaps to nearest remaining tab.
- **Tab overflow (10+):** `overflow-x: auto` with `scroll-snap-type: x mandatory`. CSS gradient fade indicators at edges.

**Keyboard shortcuts** (matching the terminal mux):

| Key | Action |
|-----|--------|
| `a` | Approve focused escalation |
| `d` | Deny focused escalation |
| `w` | Approve + whitelist (selects first candidate if none) |
| Left/Right | Navigate between tabs |
| Escape | Dismiss modal (updates watermark) |

Shortcuts only fire when the modal has focus AND no text input is focused within the modal. A small legend is shown at the bottom: "a approve | d deny | w whitelist | Esc dismiss".

### 10.5 Display Number Watermark

Client-side counters control auto-open/dismiss behavior:

```typescript
// In stores.svelte.ts
let escalationDisplayNumber: number = $state(0);
let escalationDismissedAt: number = $state(0);

function assignDisplayNumber(): number {
  return ++escalationDisplayNumber;
}

function recordDismissal(): void {
  escalationDismissedAt = escalationDisplayNumber;
}
```

Each escalation in `pendingEscalations` gets a `displayNumber` assigned client-side when `escalation.created` is processed. The `EventSideEffects` interface in `event-handler.ts` injects `assignDisplayNumber()` for testability.

**Auto-open/close logic (in `App.svelte`):**

```svelte
<script>
  let escalationModalOpen = $state(false);

  // Auto-open when new (unseen) escalations arrive,
  // unless user is on the Escalations page
  $effect(() => {
    const shouldOpen =
      escalationDisplayNumber > escalationDismissedAt &&
      pendingEscalations.size > 0 &&
      appState.currentView !== 'escalations';
    if (shouldOpen) escalationModalOpen = true;
  });

  // Auto-close when all escalations resolved
  $effect(() => {
    if (pendingEscalations.size === 0) escalationModalOpen = false;
  });

  function dismissEscalationModal() {
    escalationModalOpen = false;
    recordDismissal();
  }
</script>
```

**Reconnect behavior:** After `refreshAll`, `escalationDismissedAt` is set to `escalationDisplayNumber` so stale escalations do not auto-open.

### 10.6 Background Tab Notification

When an escalation fires and the tab is not visible, the document title flashes (e.g., alternating with "Warning Escalation Pending"). The `flash-title.ts` utility uses `setInterval` at 1s and stops via `visibilitychange` when the tab becomes visible. No Notification API (too intrusive for a dev tool).

### 10.7 Escalations Page

The full Escalations page remains as a persistent view. It serves as a fallback for deliberate browsing and a future home for escalation history. When the user is on the Escalations page, the modal suppresses auto-open.

## 11. Escalation Flow

```
Agent -> Proxy -> PolicyEngine -> escalate
                                      |
                                      v
                            Session.onEscalation callback
                                      |
                  +-------------------+-------------------+
                  |                   |                   |
          SignalTransport      WebTransport       HeadlessTransport
                               (stores DTO in     (auto-deny or
                                ManagedSession,    Signal notify)
                                emits to bus)
                                     |
                                     v
                            WebUiServer.broadcast()
                                     |
                              +------+------+
                              |             |
                         Modal overlay  Escalations page
                              |
                        User clicks Approve
                              |
                              v
                        WS RequestFrame { method: 'escalations.resolve' }
                              |
                              v
                        sessionManager.resolveSessionEscalation()
                              |
                              v
                        session.resolveEscalation()
                              |
                              v
                        Proxy picks up response file
```

All three transports resolve through `sessionManager.resolveSessionEscalation()`. Cross-transport resolution works: a web session's escalation can be approved from Signal, and both the transport callback event and the Signal confirmation fire independently.

## 12. Build and Deployment

### 12.1 Workspace Package

The web UI is `packages/web-ui/` -- an npm workspace package, `"private": true`. Compiled output goes to `dist/web-ui-static/` during the root build.

### 12.2 Vite Configuration

```typescript
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: { '/ws': { target: 'ws://127.0.0.1:7400', ws: true } },
  },
});
```

### 12.3 Root Build Pipeline

```json
{
  "build": "npm run build:web-ui --if-present && tsc && node scripts/copy-assets.mjs",
  "build:web-ui": "npm run build -w packages/web-ui"
}
```

The `--if-present` flag makes the web UI build optional. If it runs and fails, the entire build aborts. `copy-assets.mjs` copies `packages/web-ui/dist/` to `dist/web-ui-static/` if it exists, skipping silently otherwise. The daemon handles missing assets gracefully -- logs a warning and starts without the web UI.

All frontend dependencies are `devDependencies` of the workspace package. Only compiled static output ships with `npm install -g ironcurtain`.

### 12.4 Development Workflow

1. Start daemon: `ironcurtain daemon --web-ui --web-ui-dev`
2. Start Vite dev server: `cd packages/web-ui && npm run dev` (port 5173, proxies `/ws` to daemon)
3. Open `http://localhost:5173?token=<token>` for HMR development.
4. Mock server: `npm run mock-server -w packages/web-ui` for UI development without Docker/LLM.

## 13. Configuration

```json
// In ~/.ironcurtain/config.json
{
  "daemon": {
    "webUi": {
      "enabled": true,
      "port": 7400
    }
  }
}
```

| Setting | Default | Flag override |
|---------|---------|--------------|
| `daemon.webUi.enabled` | `false` | `--web-ui` |
| `daemon.webUi.port` | `7400` | `--web-port` |
| `daemon.webUi.host` | `'127.0.0.1'` | `--web-host` |

## 14. Dependencies

### Daemon-side (root package.json)

| Package | Purpose | Notes |
|---------|---------|-------|
| `ws` | WebSocket server | Moved from devDependencies to dependencies. No `WebSocketServer` in Node.js core. |

Hono was considered but not used. Static file serving uses native `http.createServer()` with manual MIME mapping.

### Frontend (packages/web-ui/ devDependencies)

| Package | Purpose |
|---------|---------|
| `svelte` | Frontend framework (build-time) |
| `@sveltejs/vite-plugin-svelte` | Vite integration (build-time) |
| `vite` | Build tool + dev server (build-time) |
| `tailwindcss` v3 | CSS framework + theming (build-time) |
| `bits-ui` | Headless accessible primitives (~30KB runtime) |
| `sonner` | Toast notifications |
| `shiki` | Syntax highlighting |
| `dompurify` | HTML sanitization |
| `marked` | Markdown rendering |

**Key win:** One new runtime dependency (`ws` moved from dev) in the main package. All frontend dependencies bundled by Vite.

## 15. Testing Strategy

### Daemon-side

- **Unit tests** for `SessionManager.resolveSessionEscalation()`, `WebUiServer` dispatch, `WebSessionTransport`, auth/origin validation, frame parsing.
- **Integration tests** for full flow: start daemon with `--web-ui`, connect WS, create session, send message, receive events.
- Located in `src/web-ui/__tests__/`.

### Frontend

- **Component tests** via Svelte Testing Library + Vitest (36 tests in `packages/web-ui`).
- **WebSocket client tests**: mock WebSocket, verify frame construction, request/response correlation, reconnection.
- **Event handler tests**: verify `EventSideEffects` injection enables deterministic testing.
- Run via `npm test -w packages/web-ui`.
- No E2E browser tests in initial implementation.

## 16. Design Review Notes

This design went through a formal 21-item architectural critique. Key items that influenced the implementation:

1. **Full escalation storage in ManagedSession** (critique #6). The original `pendingEscalationId: string` was insufficient for `escalations.list`. Changed to `pendingEscalation: EscalationDto | null` so late-connecting clients can fetch pending escalations. This also fixed the `escalationId: 'unknown'` problem in the expired handler (critique #5).

2. **Dropped `sveltekit-superforms` and `formsnap`** (critique #8, #9). Both require SvelteKit's server-side form actions. Replaced with plain Svelte 5 runes + Zod validation.

3. **Dropped `xterm-svelte`** (critique #10). Uncertain Svelte 5 compatibility. Using `<pre>` + markdown rendering instead.

4. **Tailwind v3 instead of v4** (critique #11). shadcn-svelte CLI generates v3-style config. v4 migration deferred.

5. **Dropped `@tanstack/svelte-table`** (critique #16). Unnecessary for expected data volumes (<50 jobs, <10 sessions). Using plain `{#each}` + sorted arrays.

6. **Dropped command palette** (critique #15). Over-engineered for a local tool with few sessions.

7. **Removed duplicate `escalation.resolved` emission** (critique #12). The `onEscalationResolved` callback is the single source of truth.

8. **`step_finish` diagnostic emission wired** (critique #1). Added to `AgentSession.onStepFinish` so `session.tool_result` events fire.

9. **`job.list_changed` trigger points wired** (critique #20). Event bus emissions added to daemon's `addJob()`, `removeJob()`, `enableJob()`, `disableJob()`, and `recompileJob()`.

10. **Origin validation accepts any loopback origin** (critique #13) in dev mode. The bearer token is the real auth gate.

Other critique items (turn number in `session.thinking`, auto-save memory for web sessions, `sessions.send` to non-web sessions, reconnection hydration order) were addressed during implementation as documented in the relevant sections above.

---

**Note:** The files `docs/designs/daemon-web-ui-critique.md` and `docs/designs/web-ui-escalation-ux.md` are superseded by this consolidated document and should be deleted.
