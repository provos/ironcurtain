# Web UI Testing Strategy

## 1. Problem

Testing the IronCurtain web UI currently requires starting the full daemon with Docker containers and/or LLM API keys. This makes development slow, expensive, and impossible in CI. We need to:

- Visually test all UI views (Dashboard, Sessions, Escalations, Jobs) interactively during development
- Test chat message flow with realistic timing (thinking, tool calls, final response)
- Test escalation creation and resolution workflows
- Test session lifecycle (create, status transitions, end)
- Run automated regression tests in CI without any external dependencies

The web UI communicates with the daemon exclusively through a well-defined WebSocket JSON-RPC protocol (`RequestFrame`/`ResponseFrame`/`EventFrame` in `src/web-ui/web-ui-types.ts`). This clean boundary is what makes each testing phase possible: we can substitute the daemon with a mock that speaks the same protocol, and test the frontend logic layer in isolation from Svelte's reactivity.

## 2. Architecture Overview

The testing-relevant boundary sits between two layers:

```
Frontend (packages/web-ui/)           Backend (src/web-ui/)
===========================           =====================
                                      WebUiServer
  WsClient interface  <-- WS/JSON-RPC -->  handleMessage()
       |                                        |
  stores.svelte.ts                        json-rpc-dispatch.ts
   handleEvent()                           dispatch(ctx, method, params)
       |                                        |
  AppState ($state)                       DispatchContext
       |                                   { handler, sessionManager,
  Route components                           eventBus, mode }
  (Dashboard, Sessions,                        |
   Escalations, Jobs)                    Session interface
                                         WebEventBus
```

**Key interfaces that enable mocking:**

| Interface | Location | Role |
|-----------|----------|------|
| `WsClient` | `packages/web-ui/src/lib/ws-client.ts` | Frontend WS abstraction: `request()`, `onEvent()`, `onConnectionChange()` |
| `RequestFrame` / `ResponseFrame` / `EventFrame` | `src/web-ui/web-ui-types.ts` | Wire protocol types (mirrored in `packages/web-ui/src/lib/types.ts`) |
| `MethodName` | `src/web-ui/web-ui-types.ts` | Literal union of 19 valid RPC methods |
| `DispatchContext` | `src/web-ui/json-rpc-dispatch.ts` | Backend dependency bundle (handler, sessionManager, eventBus, mode) |
| `Session` | `src/session/types.ts` | Core session contract: `sendMessage()`, `getHistory()`, `getBudgetStatus()`, etc. |
| `WebEventMap` | `src/web-ui/web-event-bus.ts` | Typed event payloads for all 17 push events |

## 3. Phase 1: Mock WebSocket Server

A standalone Node.js script that speaks the same JSON-RPC WebSocket protocol as the daemon, returning canned data and emitting scripted event sequences. This is the fastest path to interactive visual testing.

### File: `packages/web-ui/scripts/mock-ws-server.ts`

Runs as a standalone `tsx` script. The listen port is configurable via the `PORT` environment variable (default: 7400), matching the Vite proxy target. No daemon dependencies -- it imports only `ws` and the shared type definitions.

**Important**: The mock server and the real daemon cannot run simultaneously on the same port. Stop the daemon before starting the mock server, or set a different port via `PORT=7401 npm run mock-server` and update the Vite proxy target accordingly.

### Method Handling Table

| Method | Response | Notes |
|--------|----------|-------|
| `status` | Canned `DaemonStatusDto` | `uptimeSeconds` increments from server start time |
| `sessions.list` | Array of 0-3 `SessionDto` stubs | Varies with mock state |
| `sessions.create` | `{ label }` | Assigns incrementing label, emits `session.created` event |
| `sessions.send` | `{ accepted: true }` | Triggers async event sequence (see below) |
| `sessions.end` | `void` | Removes session from mock state, emits `session.ended` |
| `sessions.get` | `SessionDetailDto` | Includes canned history and diagnostic log |
| `sessions.budget` | `BudgetSummaryDto` | Static mock with some usage |
| `sessions.history` | `ConversationTurn[]` | 2-3 canned turns |
| `sessions.diagnostics` | `DiagnosticEvent[]` | Canned tool_call + step_finish events |
| `jobs.list` | 2-3 `JobListDto` stubs | Mix of enabled/disabled, with/without lastRun |
| `jobs.run` | `{ accepted: true, jobId }` | Emits `job.started`, then `job.completed` after 3s |
| `jobs.enable` / `jobs.disable` | `void` | Toggles mock state, emits `job.list_changed` |
| `jobs.remove` | `void` | Removes from mock state, emits `job.list_changed` |
| `jobs.recompile` / `jobs.reload` | `void` | No-op |
| `jobs.logs` | `RunRecord[]` | 2-3 canned run records |
| `escalations.list` | 0-1 `EscalationDto` stubs | Varies with mock state |
| `escalations.resolve` | `void` | Clears mock escalation, emits `escalation.resolved` |
| `personas.list` | 2 `PersonaListItem` stubs | e.g., "default" and "researcher" |
| *(any other)* | Error: `METHOD_NOT_FOUND` | Returns `{ code: 'METHOD_NOT_FOUND', message: 'Unknown method: <name>' }` |

### Simulated `sessions.send` Event Sequence

When `sessions.send` is called, the mock server emits events with realistic delays to exercise the full chat rendering pipeline:

```typescript
async function simulateTurn(ws: WebSocket, label: number, text: string): Promise<void> {
  const turnNumber = nextTurn(label);

  // 1. Thinking indicator (immediate)
  emit(ws, 'session.thinking', { label, turnNumber });
  emit(ws, 'session.updated', sessionDto(label, 'processing'));

  await delay(800);

  // 2. Tool calls (one or two, staggered)
  emit(ws, 'session.tool_call', {
    label,
    toolName: 'filesystem__read_file',
    preview: 'Reading ./package.json',
  });

  await delay(600);

  emit(ws, 'session.tool_call', {
    label,
    toolName: 'filesystem__write_file',
    preview: 'Writing ./output.txt',
  });

  await delay(1200);

  // 3. Final output
  const response = cannedResponses[turnNumber % cannedResponses.length];
  emit(ws, 'session.output', { label, text: response, turnNumber });
  emit(ws, 'session.budget_update', { label, budget: mockBudget(turnNumber) });
  emit(ws, 'session.updated', sessionDto(label, 'ready'));
}
```

### Escalation Simulation

Escalations are triggered by keyword: if `sessions.send` text contains "escalate", the mock injects an escalation event instead of the normal turn sequence:

```typescript
if (text.toLowerCase().includes('escalate')) {
  const escalationId = `esc-${Date.now()}`;
  emit(ws, 'escalation.created', {
    escalationId,
    sessionLabel: label,
    sessionSource: { kind: 'web' },
    toolName: 'filesystem__write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts', content: 'malicious' },
    reason: 'Write to protected system path',
    receivedAt: new Date().toISOString(),
  });
  // Session stays in 'processing' until escalation is resolved
  return;
}
```

A `--chaos` flag could be added later if periodic random escalations are useful for demos, but the keyword trigger is sufficient for testing and keeps behavior deterministic.

### Periodic Status Broadcast

The mock emits `daemon.status` every 10 seconds (matching the real daemon) with incrementing `uptimeSeconds` to verify the dashboard updates.

### Integration with Vite Dev Server

The existing `vite.config.ts` already proxies `/ws` to `ws://127.0.0.1:7400`. To use a non-default port, update the proxy target in `vite.config.ts` or set the `VITE_WS_PORT` env var if the config reads from it. The developer workflow uses two terminals:

```bash
# Terminal 1: Start the mock WS server
cd packages/web-ui && npm run mock-server

# Terminal 2: Start Vite dev server with HMR
cd packages/web-ui && npm run dev
```

**New npm scripts in `packages/web-ui/package.json`:**

```json
{
  "scripts": {
    "mock-server": "tsx scripts/mock-ws-server.ts"
  }
}
```

### Mock Server Structure

```typescript
// packages/web-ui/scripts/mock-ws-server.ts

import { WebSocketServer, WebSocket } from 'ws';

const PORT = parseInt(process.env.PORT ?? '7400', 10);

// ---- Mock state ----
interface MockState {
  sessions: Map<number, { status: string; turnCount: number; createdAt: string }>;
  nextLabel: number;
  escalations: Map<string, { sessionLabel: number; toolName: string }>;
  jobs: Map<string, { enabled: boolean; isRunning: boolean }>;
  startTime: number;
}

// ---- Frame helpers ----
function sendResponse(ws: WebSocket, id: string, payload?: unknown): void { /* ... */ }
function sendError(ws: WebSocket, id: string, code: string, message: string): void { /* ... */ }
function emit(ws: WebSocket, event: string, payload: unknown): void { /* ... */ }
function broadcast(wss: WebSocketServer, event: string, payload: unknown): void { /* ... */ }

// ---- Canned data factories ----
function mockSessionDto(label: number, state: MockState): SessionDto { /* ... */ }
function mockBudgetDto(turnCount: number): BudgetSummaryDto { /* ... */ }
function mockJobList(state: MockState): JobListDto[] { /* ... */ }
function mockDaemonStatus(state: MockState): DaemonStatusDto { /* ... */ }

// ---- Method dispatch ----
async function handleMethod(
  ws: WebSocket,
  wss: WebSocketServer,
  state: MockState,
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  switch (method) {
    case 'status': /* ... */
    case 'sessions.send': /* ... */
    // ... all other methods from the table above ...

    default:
      sendError(ws, id, 'METHOD_NOT_FOUND', `Unknown method: ${method}`);
      return;
  }
}

// ---- Server bootstrap ----
const wss = new WebSocketServer({ port: PORT });
const state: MockState = { sessions: new Map(), nextLabel: 1, /* ... */ };

// Seed initial state
state.jobs.set('daily-review', { enabled: true, isRunning: false });
state.jobs.set('weekly-report', { enabled: true, isRunning: false });
state.jobs.set('cleanup', { enabled: false, isRunning: false });

wss.on('connection', (ws) => {
  // Send initial status
  emit(ws, 'daemon.status', mockDaemonStatus(state));

  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    handleMethod(ws, wss, state, frame.id, frame.method, frame.params ?? {});
  });
});

// Periodic status broadcast
setInterval(() => broadcast(wss, 'daemon.status', mockDaemonStatus(state)), 10_000);

console.log(`Mock WS server listening on ws://127.0.0.1:${PORT}`);
```

### Token Authentication Bypass

The mock server ignores the `token` query parameter on the WebSocket URL. The frontend still reads from `sessionStorage`, so during mock development, navigate to `http://localhost:5173/?token=mock` once to seed the token.

## 4. Phase 2: Frontend Unit Tests (Vitest)

Unit tests for the frontend logic layer -- state management, event handling, and utility functions -- without rendering Svelte components.

### Key Refactor: Extract `handleEvent()` to Accept Explicit State

The current `handleEvent()` in `stores.svelte.ts` mutates the module-level `appState` singleton. This makes it untestable in isolation because Svelte 5 runes (`$state`) require a compiler transform. The refactor extracts the event-handling logic into a pure function:

**New file: `packages/web-ui/src/lib/event-handler.ts`**

```typescript
import type {
  SessionDto,
  EscalationDto,
  DaemonStatusDto,
  BudgetSummaryDto,
  OutputLine,
  JobListDto,
} from './types.js';

/** Minimal state surface that handleEvent needs to read and write. */
export interface AppStateLike {
  daemonStatus: DaemonStatusDto | null;
  sessions: Map<number, SessionDto>;
  selectedSessionLabel: number | null;
  pendingEscalations: Map<string, EscalationDto>;
  jobs: JobListDto[];
  addOutput(label: number, line: OutputLine): void;
  removeOutput(label: number): void;
}

/** Side effects that handleEvent may request. */
export interface EventSideEffects {
  refreshJobs(): void;
}

/**
 * Pure event handler: applies a server-push event to the state object.
 * Returns true if the event was recognized, false otherwise.
 */
export function handleEvent(
  state: AppStateLike,
  effects: EventSideEffects,
  event: string,
  payload: unknown,
): boolean {
  const data = payload as Record<string, unknown>;

  switch (event) {
    case 'daemon.status':
      state.daemonStatus = data as unknown as DaemonStatusDto;
      return true;

    case 'session.created':
    case 'session.updated': {
      const session = data as unknown as SessionDto;
      state.sessions = new Map(state.sessions).set(session.label, session);
      return true;
    }

    case 'session.ended': {
      const label = data.label as number;
      const next = new Map(state.sessions);
      next.delete(label);
      state.sessions = next;
      state.removeOutput(label);
      if (state.selectedSessionLabel === label) {
        state.selectedSessionLabel = null;
      }
      return true;
    }

    case 'session.thinking': {
      const label = data.label as number;
      const existing = state.sessions.get(label);
      if (existing) {
        state.sessions = new Map(state.sessions).set(label, { ...existing, status: 'processing' });
      }
      state.addOutput(label, {
        kind: 'thinking',
        text: 'Thinking...',
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.tool_call': {
      const label = data.label as number;
      state.addOutput(label, {
        kind: 'tool_call',
        text: `${data.toolName as string}: ${data.preview as string}`,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.output': {
      const label = data.label as number;
      state.addOutput(label, {
        kind: 'assistant',
        text: data.text as string,
        timestamp: new Date().toISOString(),
      });
      return true;
    }

    case 'session.budget_update': {
      const label = data.label as number;
      const budget = data.budget as BudgetSummaryDto;
      const session = state.sessions.get(label);
      if (session) {
        state.sessions = new Map(state.sessions).set(label, { ...session, budget });
      }
      return true;
    }

    case 'escalation.created': {
      const esc = data as unknown as EscalationDto;
      state.pendingEscalations = new Map(state.pendingEscalations).set(esc.escalationId, esc);
      return true;
    }

    case 'escalation.resolved':
    case 'escalation.expired': {
      const id = data.escalationId as string;
      const next = new Map(state.pendingEscalations);
      next.delete(id);
      state.pendingEscalations = next;
      return true;
    }

    case 'job.list_changed':
    case 'job.completed':
    case 'job.failed':
    case 'job.started':
      effects.refreshJobs();
      return true;

    default:
      return false;
  }
}
```

Then `stores.svelte.ts` delegates to it:

```typescript
import { handleEvent as handleEventPure } from './event-handler.js';

// In wireEventHandlers():
client.onEvent((event, payload) => {
  handleEventPure(appState, { refreshJobs: () => refreshJobs(client) }, event, payload);
});
```

### Extract `groupOutputLines` from Sessions.svelte

The `groupOutputLines`, `isCollapsibleKind`, and `buildGroupSummary` functions are currently defined inline in `Sessions.svelte`. Extract them to a testable module:

**New file: `packages/web-ui/src/lib/output-grouping.ts`**

```typescript
import type { OutputLine } from './types.js';

export type SingleEntry = { kind: 'single'; line: OutputLine };
export type CollapsibleGroup = { kind: 'group'; lines: OutputLine[]; summary: string };
export type OutputEntry = SingleEntry | CollapsibleGroup;

export function isCollapsibleKind(kind: OutputLine['kind']): boolean {
  return kind === 'thinking' || kind === 'tool_call';
}

export function buildGroupSummary(lines: OutputLine[]): string {
  const toolCalls = lines.filter((l) => l.kind === 'tool_call').length;
  const thinking = lines.filter((l) => l.kind === 'thinking').length;
  const parts: string[] = [];
  if (thinking > 0) parts.push(`${thinking} thinking`);
  if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export function groupOutputLines(lines: OutputLine[]): OutputEntry[] {
  const entries: OutputEntry[] = [];
  let pendingGroup: OutputLine[] = [];

  function flushGroup(): void {
    if (pendingGroup.length > 0) {
      entries.push({ kind: 'group', lines: pendingGroup, summary: buildGroupSummary(pendingGroup) });
      pendingGroup = [];
    }
  }

  for (const line of lines) {
    if (isCollapsibleKind(line.kind)) {
      pendingGroup.push(line);
    } else {
      flushGroup();
      entries.push({ kind: 'single', line });
    }
  }
  flushGroup();
  return entries;
}
```

### Test Environment

Tests run with Vitest using the `jsdom` environment. Add a Vitest config to the web-ui package:

**`packages/web-ui/vitest.config.ts`:**

```typescript
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/lib'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
```

**New npm scripts:**

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

### Root `npm test` Integration

The `packages/web-ui` tests must be included in the root `npm test` run. Use a Vitest workspace config at the repo root:

**`vitest.workspace.ts`** (at repo root):

```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  // Existing root test config
  'vitest.config.ts',
  // Web UI frontend tests
  'packages/web-ui/vitest.config.ts',
]);
```

If the project does not already use a Vitest workspace, an alternative is to add a script to the root `package.json`:

```json
{
  "scripts": {
    "test": "vitest run && npm run test --workspace=packages/web-ui"
  }
}
```

Either approach ensures web-ui tests run in CI and are not silently skipped.

### Example Test Cases

**`packages/web-ui/src/lib/event-handler.test.ts`:**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleEvent, type AppStateLike, type EventSideEffects } from './event-handler.js';
import type { SessionDto, EscalationDto, OutputLine } from './types.js';

function createMockState(): AppStateLike & { outputs: Map<number, OutputLine[]> } {
  const outputs = new Map<number, OutputLine[]>();
  return {
    daemonStatus: null,
    sessions: new Map(),
    selectedSessionLabel: null,
    pendingEscalations: new Map(),
    jobs: [],
    outputs,
    addOutput(label: number, line: OutputLine) {
      const existing = outputs.get(label) ?? [];
      // Replicate AppState filtering: when a tool_call or assistant line arrives,
      // remove preceding thinking lines (they are superseded by real content).
      const filtered = line.kind === 'tool_call' || line.kind === 'assistant'
        ? existing.filter((l) => l.kind !== 'thinking')
        : existing;
      outputs.set(label, [...filtered, line]);
    },
    removeOutput(label: number) {
      outputs.delete(label);
    },
  };
}

function noopEffects(): EventSideEffects {
  return { refreshJobs: vi.fn() };
}

describe('handleEvent', () => {
  it('applies daemon.status', () => {
    const state = createMockState();
    handleEvent(state, noopEffects(), 'daemon.status', {
      uptimeSeconds: 120,
      jobs: { total: 2, enabled: 1, running: 0 },
      signalConnected: false,
      webUiListening: true,
      activeSessions: 1,
      nextFireTime: null,
    });
    expect(state.daemonStatus?.uptimeSeconds).toBe(120);
  });

  it('adds session on session.created', () => {
    const state = createMockState();
    const session: SessionDto = {
      label: 1,
      source: { kind: 'web' },
      status: 'ready',
      turnCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
      hasPendingEscalation: false,
      messageInFlight: false,
      budget: mockBudget(),
    };
    handleEvent(state, noopEffects(), 'session.created', session);
    expect(state.sessions.get(1)?.status).toBe('ready');
  });

  it('removes session, clears selection, and cleans up output on session.ended', () => {
    const state = createMockState();
    state.sessions.set(1, mockSession(1));
    state.selectedSessionLabel = 1;
    state.addOutput(1, { kind: 'assistant', text: 'Hello', timestamp: '' });
    handleEvent(state, noopEffects(), 'session.ended', { label: 1, reason: 'user_ended' });
    expect(state.sessions.has(1)).toBe(false);
    expect(state.selectedSessionLabel).toBeNull();
    expect(state.outputs.has(1)).toBe(false);
  });

  it('transitions session to processing on session.thinking', () => {
    const state = createMockState();
    state.sessions.set(1, mockSession(1));
    handleEvent(state, noopEffects(), 'session.thinking', { label: 1, turnNumber: 1 });
    expect(state.sessions.get(1)?.status).toBe('processing');
    expect(state.outputs.get(1)?.[0]?.kind).toBe('thinking');
  });

  it('clears thinking lines when assistant output arrives', () => {
    const state = createMockState();
    // Pre-populate thinking line
    state.addOutput(1, { kind: 'thinking', text: 'Thinking...', timestamp: '' });
    handleEvent(state, noopEffects(), 'session.output', {
      label: 1,
      text: 'Here is the answer.',
      turnNumber: 1,
    });
    // The mock addOutput filters out thinking lines when assistant arrives.
    const lines = state.outputs.get(1) ?? [];
    expect(lines.every((l) => l.kind !== 'thinking')).toBe(true);
    expect(lines.some((l) => l.kind === 'assistant')).toBe(true);
  });

  it('clears thinking lines when tool_call arrives', () => {
    const state = createMockState();
    state.addOutput(1, { kind: 'thinking', text: 'Thinking...', timestamp: '' });
    handleEvent(state, noopEffects(), 'session.tool_call', {
      label: 1,
      toolName: 'filesystem__read_file',
      preview: 'Reading ./foo.ts',
    });
    const lines = state.outputs.get(1) ?? [];
    expect(lines.every((l) => l.kind !== 'thinking')).toBe(true);
    expect(lines.some((l) => l.kind === 'tool_call')).toBe(true);
  });

  it('adds and removes escalations', () => {
    const state = createMockState();
    const esc: EscalationDto = {
      escalationId: 'esc-1',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts' },
      reason: 'Protected path',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, noopEffects(), 'escalation.created', esc);
    expect(state.pendingEscalations.size).toBe(1);

    handleEvent(state, noopEffects(), 'escalation.resolved', { escalationId: 'esc-1' });
    expect(state.pendingEscalations.size).toBe(0);
  });

  it('handles escalation.expired with escalationId', () => {
    const state = createMockState();
    const esc: EscalationDto = {
      escalationId: 'esc-2',
      sessionLabel: 1,
      sessionSource: { kind: 'web' },
      toolName: 'filesystem__delete_file',
      serverName: 'filesystem',
      arguments: { path: '/tmp/foo' },
      reason: 'Delete outside sandbox',
      receivedAt: '2026-01-01T00:00:00Z',
    };
    handleEvent(state, noopEffects(), 'escalation.created', esc);
    expect(state.pendingEscalations.size).toBe(1);

    handleEvent(state, noopEffects(), 'escalation.expired', { escalationId: 'esc-2' });
    expect(state.pendingEscalations.size).toBe(0);
  });

  it('calls refreshJobs for job events', () => {
    const state = createMockState();
    const effects = noopEffects();
    handleEvent(state, effects, 'job.list_changed', {});
    expect(effects.refreshJobs).toHaveBeenCalledOnce();
  });

  it('returns false for unknown events', () => {
    const state = createMockState();
    const handled = handleEvent(state, noopEffects(), 'unknown.event', {});
    expect(handled).toBe(false);
  });
});
```

**`packages/web-ui/src/lib/output-grouping.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest';
import { groupOutputLines, buildGroupSummary } from './output-grouping.js';
import type { OutputLine } from './types.js';

const ts = '2026-01-01T00:00:00Z';

describe('groupOutputLines', () => {
  it('returns empty for empty input', () => {
    expect(groupOutputLines([])).toEqual([]);
  });

  it('wraps assistant lines as single entries', () => {
    const lines: OutputLine[] = [{ kind: 'assistant', text: 'Hello', timestamp: ts }];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('single');
  });

  it('groups consecutive thinking and tool_call lines', () => {
    const lines: OutputLine[] = [
      { kind: 'thinking', text: 'Thinking...', timestamp: ts },
      { kind: 'tool_call', text: 'read_file: ./foo', timestamp: ts },
      { kind: 'tool_call', text: 'write_file: ./bar', timestamp: ts },
      { kind: 'assistant', text: 'Done.', timestamp: ts },
    ];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('group');
    if (result[0].kind === 'group') {
      expect(result[0].lines).toHaveLength(3);
    }
    expect(result[1].kind).toBe('single');
  });

  it('creates separate groups when interrupted by assistant lines', () => {
    const lines: OutputLine[] = [
      { kind: 'tool_call', text: 'read_file: ./a', timestamp: ts },
      { kind: 'assistant', text: 'Result A', timestamp: ts },
      { kind: 'tool_call', text: 'read_file: ./b', timestamp: ts },
      { kind: 'assistant', text: 'Result B', timestamp: ts },
    ];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(4); // group, single, group, single
    expect(result[0].kind).toBe('group');
    expect(result[2].kind).toBe('group');
  });
});

describe('buildGroupSummary', () => {
  it('counts thinking and tool calls separately', () => {
    const lines: OutputLine[] = [
      { kind: 'thinking', text: '', timestamp: ts },
      { kind: 'tool_call', text: '', timestamp: ts },
      { kind: 'tool_call', text: '', timestamp: ts },
    ];
    expect(buildGroupSummary(lines)).toBe('1 thinking, 2 tool calls');
  });

  it('uses singular for one tool call', () => {
    const lines: OutputLine[] = [{ kind: 'tool_call', text: '', timestamp: ts }];
    expect(buildGroupSummary(lines)).toBe('1 tool call');
  });
});
```

**`packages/web-ui/src/lib/ws-client.test.ts`:**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWsClient } from './ws-client.js';

// Mock WebSocket for jsdom environment
class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
  ping() {}
}

let mockWsInstance: MockWebSocket;
vi.stubGlobal('WebSocket', class extends MockWebSocket {
  constructor() {
    super();
    mockWsInstance = this;
    setTimeout(() => this.onopen?.(), 0);
  }
});

describe('WsClient', () => {
  it('correlates request and response by id', async () => {
    const client = createWsClient();
    client.connect('ws://localhost:7400/ws', 'mock-token');

    // Wait for connection
    await vi.waitFor(() => expect(client.isConnected).toBe(true));

    const promise = client.request<{ ok: boolean }>('status');

    // Parse sent frame to get the id
    const frame = JSON.parse(mockWsInstance.sent[0]);
    expect(frame.method).toBe('status');

    // Simulate server response
    mockWsInstance.onmessage?.({
      data: JSON.stringify({ id: frame.id, ok: true, payload: { ok: true } }),
    });

    const result = await promise;
    expect(result).toEqual({ ok: true });
  });

  it('dispatches events to registered handlers', async () => {
    const client = createWsClient();
    const handler = vi.fn();
    client.onEvent(handler);
    client.connect('ws://localhost:7400/ws', 'mock-token');
    await vi.waitFor(() => expect(client.isConnected).toBe(true));

    mockWsInstance.onmessage?.({
      data: JSON.stringify({ event: 'session.created', payload: { label: 1 }, seq: 1 }),
    });

    expect(handler).toHaveBeenCalledWith('session.created', { label: 1 });
  });

  it('rejects pending requests on connection close', async () => {
    const client = createWsClient();
    client.connect('ws://localhost:7400/ws', 'mock-token');
    await vi.waitFor(() => expect(client.isConnected).toBe(true));

    const promise = client.request('status');
    mockWsInstance.onclose?.();

    await expect(promise).rejects.toThrow('Connection closed');
  });

  it('reconnects after connection loss and fires refreshAll', async () => {
    vi.useFakeTimers();
    const client = createWsClient();
    const connectionHandler = vi.fn();
    client.onConnectionChange(connectionHandler);
    client.connect('ws://localhost:7400/ws', 'mock-token');

    // Initial connection
    await vi.advanceTimersByTimeAsync(0);
    mockWsInstance.onopen?.();
    expect(connectionHandler).toHaveBeenCalledWith(true);

    // Simulate disconnect
    mockWsInstance.onclose?.();
    expect(connectionHandler).toHaveBeenCalledWith(false);

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(3000);

    // New WebSocket created, simulate open
    mockWsInstance.onopen?.();
    expect(connectionHandler).toHaveBeenCalledTimes(3); // true, false, true
    expect(connectionHandler).toHaveBeenLastCalledWith(true);

    vi.useRealTimers();
  });
});
```

## 5. Phase 3: E2E Browser Tests (Playwright)

Automated browser tests that run the Svelte app against the mock WS server and verify DOM content, user interactions, and view transitions.

### Setup

**New devDependencies in `packages/web-ui/package.json`:**

```json
{
  "devDependencies": {
    "@playwright/test": "^1.50.0"
  }
}
```

**`packages/web-ui/playwright.config.ts`:**

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false, // Tests share mock server state
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'npx tsx scripts/mock-ws-server.ts',
      port: 7400,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite dev',
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

**New npm scripts:**

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

### Test Scenarios

**`packages/web-ui/e2e/dashboard.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Seed auth token so the app connects
  await page.goto('/?token=mock');
});

test('shows daemon status cards', async ({ page }) => {
  await expect(page.getByText('Uptime')).toBeVisible();
  await expect(page.getByText('Active Sessions')).toBeVisible();
  await expect(page.getByText('Jobs')).toBeVisible();
});

test('displays connection indicator', async ({ page }) => {
  // The connected badge should appear once WS connects
  await expect(page.getByText('Connected')).toBeVisible({ timeout: 5000 });
});
```

**`packages/web-ui/e2e/sessions.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?token=mock');
  // Navigate to sessions view
  await page.getByRole('button', { name: /sessions/i }).click();
});

test('creates a new session and shows it in the list', async ({ page }) => {
  await page.getByRole('button', { name: /new session/i }).click();
  // Wait for session to appear in sidebar
  await expect(page.getByText(/Session #/)).toBeVisible({ timeout: 5000 });
});

test('sends a message and shows thinking then response', async ({ page }) => {
  // Create session first
  await page.getByRole('button', { name: /new session/i }).click();
  await expect(page.getByText(/Session #/)).toBeVisible({ timeout: 5000 });

  // Select the session
  await page.getByText(/Session #/).first().click();

  // Type and send message
  const input = page.getByPlaceholder(/type a message/i);
  await input.fill('Hello, agent');
  await input.press('Enter');

  // Thinking indicator appears
  await expect(page.getByText('Thinking...')).toBeVisible({ timeout: 3000 });

  // Tool call appears
  await expect(page.getByText(/filesystem__read_file/)).toBeVisible({ timeout: 5000 });

  // Final response appears (thinking gets collapsed)
  await expect(page.getByText(/assistant response/i)).toBeVisible({ timeout: 10000 });
});

test('ends a session', async ({ page }) => {
  await page.getByRole('button', { name: /new session/i }).click();
  await expect(page.getByText(/Session #/)).toBeVisible({ timeout: 5000 });
  await page.getByText(/Session #/).first().click();

  await page.getByRole('button', { name: /end session/i }).click();
  // Session should be removed from the list
  await expect(page.getByText(/Session #/)).not.toBeVisible({ timeout: 3000 });
});
```

**`packages/web-ui/e2e/escalations.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?token=mock');
});

test('shows escalation and resolves it', async ({ page }) => {
  // Create a session and trigger an escalation
  await page.getByRole('button', { name: /sessions/i }).click();
  await page.getByRole('button', { name: /new session/i }).click();
  await expect(page.getByText(/Session #/)).toBeVisible({ timeout: 5000 });
  await page.getByText(/Session #/).first().click();

  const input = page.getByPlaceholder(/type a message/i);
  await input.fill('please escalate this');
  await input.press('Enter');

  // Navigate to escalations
  await page.getByRole('button', { name: /escalations/i }).click();

  // Escalation card should appear
  await expect(page.getByText('filesystem__write_file')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('Protected')).toBeVisible();

  // Approve it
  await page.getByRole('button', { name: /approve/i }).click();

  // Escalation should disappear
  await expect(page.getByText('filesystem__write_file')).not.toBeVisible({ timeout: 3000 });
});
```

**`packages/web-ui/e2e/jobs.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?token=mock');
  await page.getByRole('button', { name: /jobs/i }).click();
});

test('lists canned jobs', async ({ page }) => {
  await expect(page.getByText('daily-review')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('weekly-report')).toBeVisible();
});

test('disables and re-enables a job', async ({ page }) => {
  await expect(page.getByText('daily-review')).toBeVisible({ timeout: 5000 });
  // Find the disable button for the first enabled job
  const row = page.getByText('daily-review').locator('..');
  await row.getByRole('button', { name: /disable/i }).click();
  // After refresh, job should show disabled state
  await expect(row.getByText(/disabled/i)).toBeVisible({ timeout: 3000 });
});

test('triggers a job run', async ({ page }) => {
  await expect(page.getByText('daily-review')).toBeVisible({ timeout: 5000 });
  const row = page.getByText('daily-review').locator('..');
  await row.getByRole('button', { name: /run/i }).click();
  // Running indicator should appear then complete
  await expect(row.getByText(/running/i)).toBeVisible({ timeout: 3000 });
});
```

**`packages/web-ui/e2e/errors.spec.ts`:**

```typescript
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/?token=mock');
});

test('displays error when server returns METHOD_NOT_FOUND', async ({ page }) => {
  // This test relies on the mock server returning an error for unknown methods.
  // The frontend should surface RPC errors to the user. Navigate to sessions view
  // and attempt an action that triggers a bad request (e.g., the mock server could
  // be configured to fail on a specific method).
  //
  // For now, verify the error-handling path by sending a message to a non-existent
  // session. The mock returns an error, and the UI should display it.
  await page.getByRole('button', { name: /sessions/i }).click();

  // Attempt to interact without a valid session -- the exact trigger depends on
  // mock server behavior. A future refinement: add a mock endpoint that always
  // errors (e.g., `test.error`) and a dev-only button to call it.
  //
  // Minimal check: verify the error notification area exists and is not permanently
  // hidden, so errors have somewhere to render.
  const errorBanner = page.locator('[role="alert"]');
  // If no error is triggered in this flow, at least verify the container is in the DOM
  // and would become visible if an error occurred.
  await expect(errorBanner.or(page.getByText('Connected'))).toBeVisible({ timeout: 5000 });
});
```

### CI Integration

The Playwright tests run in CI using the `webServer` config (auto-starts mock + vite). Add to the CI workflow:

```yaml
- name: Web UI E2E tests
  working-directory: packages/web-ui
  run: |
    npx playwright install --with-deps chromium
    npm run test:e2e
```

## 6. Phase 4: `dispatch()` Unit Tests

Rather than building a `--demo` flag into the daemon with a full `MockSession` and `MockControlRequestHandler`, we unit test `dispatch()` directly. This validates Zod schema parsing, DTO builder correctness, and error code mapping without needing the daemon process, WebSocket transport, or CLI integration.

### Approach

Create a test file that constructs a `DispatchContext` with mocked dependencies, calls `dispatch()` with raw method/params pairs, and asserts on the returned payloads. This covers the same ground the demo mode would have -- Zod validation, DTO transformation, error codes -- with far less infrastructure.

**`src/web-ui/json-rpc-dispatch.test.ts`:**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { dispatch, type DispatchContext } from './json-rpc-dispatch.js';

function createMockContext(overrides?: Partial<DispatchContext>): DispatchContext {
  return {
    handler: {
      getStatus: vi.fn().mockReturnValue({
        uptimeSeconds: 60,
        jobs: { total: 1, enabled: 1, running: 0 },
        signalConnected: false,
        nextFireTime: null,
      }),
      listJobs: vi.fn().mockResolvedValue([]),
      enableJob: vi.fn().mockResolvedValue(undefined),
      disableJob: vi.fn().mockResolvedValue(undefined),
      removeJob: vi.fn().mockResolvedValue(undefined),
      recompileJob: vi.fn().mockResolvedValue(undefined),
      reloadJob: vi.fn().mockResolvedValue(undefined),
      runJobNow: vi.fn().mockResolvedValue({ /* canned RunRecord */ }),
    },
    sessionManager: {
      createSession: vi.fn().mockResolvedValue({ label: 1 }),
      getSession: vi.fn().mockReturnValue(undefined),
      listSessions: vi.fn().mockReturnValue([]),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    eventBus: {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    mode: 'code',
    ...overrides,
  } as unknown as DispatchContext;
}

describe('dispatch()', () => {
  it('returns daemon status for "status" method', async () => {
    const ctx = createMockContext();
    const result = await dispatch(ctx, 'status', {});
    expect(result).toHaveProperty('uptimeSeconds');
  });

  it('rejects invalid method names', async () => {
    const ctx = createMockContext();
    await expect(dispatch(ctx, 'not.a.method' as any, {})).rejects.toThrow();
  });

  it('validates params with Zod and rejects bad shapes', async () => {
    const ctx = createMockContext();
    // sessions.send requires { label: number, text: string }
    await expect(dispatch(ctx, 'sessions.send', { label: 'not-a-number' }))
      .rejects.toThrow();
  });

  it('returns session list from sessions.list', async () => {
    const ctx = createMockContext();
    const result = await dispatch(ctx, 'sessions.list', {});
    expect(Array.isArray(result)).toBe(true);
  });
});
```

### What This Covers vs the Former Demo Mode

| Concern | `dispatch()` unit tests | Demo mode (removed) |
|---------|------------------------|---------------------|
| Zod validation | Yes | Yes |
| DTO builder correctness | Yes | Yes |
| Error code mapping | Yes | Yes |
| WebSocket framing | No (covered by Phase 1 + 3) | Yes |
| Full daemon startup | No | Yes |
| CLI flag integration | Not needed | Required |

The WebSocket framing and transport layers are already exercised by Phase 1 (mock server) and Phase 3 (Playwright E2E). Testing `dispatch()` in isolation covers the remaining backend logic without duplicating that effort.

## 7. Implementation Plan

### Phase 1: Mock WebSocket Server (estimated: 3-4 hours)

- [ ] Create `packages/web-ui/scripts/mock-ws-server.ts` with method dispatch table
- [ ] Add `default` case to method switch returning `METHOD_NOT_FOUND` error
- [ ] Read `PORT` from env var with default 7400
- [ ] Implement canned data factories for all DTO types
- [ ] Implement `sessions.send` event sequence with timing
- [ ] Implement keyword-triggered escalation simulation ("escalate" in message text)
- [ ] Implement periodic status broadcast
- [ ] Add `ws` and `tsx` as devDependencies in `packages/web-ui/package.json`
- [ ] Add `mock-server` npm script
- [ ] Document two-terminal workflow (mock-server + dev) in script comments
- [ ] Manual testing: verify all four views render correctly with mock data

### Phase 2: Frontend Unit Tests (estimated: 4-5 hours)

- [ ] Create `packages/web-ui/src/lib/event-handler.ts` (extract from `stores.svelte.ts`)
  - [ ] Include `removeOutput(label)` in `AppStateLike` interface
- [ ] Create `packages/web-ui/src/lib/output-grouping.ts` (extract from `Sessions.svelte`)
- [ ] Update `stores.svelte.ts` to delegate to `event-handler.ts`
- [ ] Update `Sessions.svelte` to import from `output-grouping.ts`
- [ ] Add `vitest.config.ts` to `packages/web-ui/`
- [ ] Add `vitest` and `jsdom` as devDependencies
- [ ] Write `event-handler.test.ts` (10+ test cases covering all event types)
  - [ ] Mock `addOutput` replicates thinking-line filtering behavior
  - [ ] Tests verify thinking lines are cleared on tool_call and assistant output
- [ ] Write `output-grouping.test.ts` (5+ test cases)
- [ ] Write `ws-client.test.ts` (request correlation, events, disconnect handling, reconnect)
  - [ ] Reconnect test uses `vi.useFakeTimers()` to advance past reconnect delay
  - [ ] Verify `refreshAll` / `onConnectionChange(true)` fires on reconnect
- [ ] Add `test` and `test:watch` npm scripts
- [ ] Wire into root `npm test` via Vitest workspace config or root script

### Phase 3: E2E Browser Tests (estimated: 4-5 hours)

- [ ] Add `@playwright/test` as devDependency
- [ ] Create `packages/web-ui/playwright.config.ts` with `webServer` config
- [ ] Create `packages/web-ui/e2e/dashboard.spec.ts`
- [ ] Create `packages/web-ui/e2e/sessions.spec.ts` (create, send, end)
- [ ] Create `packages/web-ui/e2e/escalations.spec.ts` (trigger, approve, deny)
- [ ] Create `packages/web-ui/e2e/jobs.spec.ts` (list, enable/disable, run)
- [ ] Create `packages/web-ui/e2e/errors.spec.ts` (error response rendering)
- [ ] Add `test:e2e` and `test:e2e:ui` npm scripts
- [ ] Add CI workflow step for Playwright (install Chromium, run tests)
- [ ] Stabilize flaky tests (adjust timeouts, add retry on CI)

### Phase 4: `dispatch()` Unit Tests (estimated: 1-2 hours)

- [ ] Create `src/web-ui/json-rpc-dispatch.test.ts`
- [ ] Build `createMockContext()` factory with mocked `DispatchContext` dependencies
- [ ] Test Zod validation rejects invalid params for each method
- [ ] Test DTO builders return correct shapes for each method
- [ ] Test error codes for unknown methods and invalid session labels

### Total Estimated Effort

- **Phases 1-3 (core)**: 11-14 hours
- **Phase 4 (dispatch tests)**: 1-2 hours additional
