# Agent-Driven Workflow Gates

Status: design (revised post-review; implemented)
Branch: `feat/agent-driven-workflow-gates`
Author: feature-architect

> Review outcome: APPROVE-WITH-REVISIONS. The corrections below are folded into
> the relevant sections (search for "REVISED"). Summary of load-bearing changes:
>
> 1. **No `sessionFactoryOverride` existed** — `WorkflowManagerOptions` was only
>    `{ eventBus, baseDirOverride?, captureTraces? }` and `createOrchestrator`
>    hardcoded `createWorkflowSessionFactory()`. We add a real DI seam:
>    `WorkflowManagerOptions.sessionFactoryOverride?: (opts: SessionOptions) =>
Promise<Session>` threaded into `deps.createSession`. (§9 MODIFY table, §10.)
> 2. **`await` terminal detection + abort semantics.** A gate-ABORT routes to an
>    `aborted` terminal that emits a `workflow.completed` _event_ yet `getStatus`
>    reports `phase:'aborted'`; an RPC `abort()` emits `workflow.failed` but is
>    still `phase:'aborted'`. So `await` resolves on `waiting_human` OR any
>    terminal _event_ (`completed`|`failed`), then does ONE authoritative
>    `workflows.get` and branches on `phase`. No "wait-for-silence then poll"
>    fallback. (§3.4, §5 `await`.)
> 3. **Exit codes derive from the authoritative `phase`, never the event name:**
>    `0` = `waiting_human`|`completed`; `3` = `failed`|`aborted`; `4` = await
>    timeout. (§5 `await`.)
> 4. **`run` error mapping:** a definition that fails to LOAD throws
>    `INVALID_PARAMS`; a lint failure throws `LINT_FAILED` with
>    `error.data.diagnostics`. Map both. (§5 `run`.)
> 5. **Resolve the definition path client-side** via `resolveWorkflowPath(ref)`
>    (`string|undefined`); on `undefined` emit a CLI-level
>    `WORKFLOW_DEFINITION_NOT_FOUND` and exit before connecting. (§5 `run`, §7.)
> 6. **Projection reads documented top-level DTO fields:** `currentState`,
>    `round` (`WorkflowCardDto.round`), `phase`, `gate` (`HumanGateRequestDto`).
>    (§5 `status`.)
> 7. **Error-code provenance:** `WORKFLOW_NOT_AT_GATE`, `WORKFLOW_NOT_FOUND`,
>    `INVALID_PARAMS`, `LINT_FAILED`, `ARTIFACT_NOT_FOUND` are REAL RPC
>    `ErrorCode`s. `DAEMON_NOT_RUNNING`, `AWAIT_TIMEOUT`, `DAEMON_START_TIMEOUT`,
>    `WORKFLOW_DEFINITION_NOT_FOUND` are CLI-level strings defined locally — not
>    imported from `web-ui-types`.
> 8. **Fixture lives under `test/workflow/fixtures/test-gate-smoke/workflow.yaml`**
>    (passed by absolute path), not under `src/workflow/workflows/`, so it does
>    not pollute the shipped `workflow list` discovery surface. (§9, §10.)

## 1. Overview

IronCurtain workflows can pause at `human_gate` states that demand a human
decision (`APPROVE` / `FORCE_REVISION` / `REPLAN` / `ABORT`, where the revision
events require non-empty feedback). Today the only CLI path to resolve a gate is
the in-process `workflow start` event loop, which calls `promptGateInteractive`
(`src/workflow/cli-support.ts`) — an interactive `readline` prompt that blocks on
a TTY and throws when stdin is closed. That is unusable by an autonomous coding
agent whose tool model is "run a CLI command to completion, read its output, run
the next command."

This feature adds a **non-interactive, machine-readable CLI surface** that lets
such an agent (1) start a gated workflow on the **already-running daemon**, (2)
observe in JSON when human input is required (which gate, what is being decided,
which artifacts to inspect), and (3) resolve the gate itself by choosing an
event. The agent _is_ the decider; there is no auto-approve.

The whole feature is a **thin client over the daemon's existing WebSocket
JSON-RPC interface** — the same surface the web UI drives. The only genuinely
new abstraction is a reusable Node JSON-RPC-over-WebSocket client; everything
else is CLI plumbing and a synthetic test fixture. No new daemon RPC methods are
required.

## 2. Grounding facts — verified, with corrections

I read the actual code on this branch. The grounding facts in the task were
mostly right; the corrections below are load-bearing.

| Claim                                                                                                                                                        | Verdict                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Daemon exposes `workflows.start/list/get/inspect/resume/abort/resolveGate/...` over WS JSON-RPC                                                              | **Correct**                                                                    | `src/web-ui/web-ui-types.ts:21-61` (`MethodName` union); `src/web-ui/dispatch/workflow-dispatch.ts:194-383`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `workflows.resolveGate(workflowId, event, prompt?)` validated by a discriminated union on `event`; calls `controller.resolveGate(id, {type, prompt})`        | **Correct**                                                                    | `workflow-dispatch.ts:98-111` (schema), `:328-340` (handler). Note the dispatch file moved into `src/web-ui/dispatch/` — the task said `src/web-ui/workflow-dispatch.ts`.                                                                                                                                                                                                                                                                                                                                                                        |
| `getStatus(id)` returns `phase:'waiting_human'` + gate when a gate is active                                                                                 | **Correct**                                                                    | `WorkflowStatus` union `src/workflow/types.ts:488-493`; `workflows.get` builds `gate` via `toHumanGateRequestDto` at `workflow-dispatch.ts:443`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Orchestrator raises gates via `raiseGate` → `WorkflowManager` emits `workflow.gate_raised` / `workflow.gate_dismissed` on the bus, broadcast as event frames | **Correct**                                                                    | `src/workflow/workflow-manager.ts:332-340`; broadcast `web-ui-server.ts:108-110,221-229`; event map `web-ui/web-event-bus.ts:48-49`                                                                                                                                                                                                                                                                                                                                                                                                              |
| Default host `127.0.0.1`, port `7400`, WS path `/ws`, bearer token `randomBytes(32).base64url`                                                               | **Correct**                                                                    | `ironcurtain-daemon.ts:745` (port default), `web-ui-server.ts:87` (token), `:423` (path)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Auth: HTTP `GET /ws/auth?token=` → `{"ok":true                                                                                                               | false}`; WS upgrade carries token; frames `{id,method,params}`/`{id,ok,payload | error}`/`{event,payload,seq}`; max payload 1MB; ping 30s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Correct** | `web-ui-server.ts:332-343` (auth), `:429-434` (upgrade token), `:142` (maxPayload), `:162-164` (ping), `:500-538` (frame handling) |
| Daemon writes a discovery file with `{port,host,token}`                                                                                                      | **Correct, filename wrong**                                                    | The file is **`~/.ironcurtain/web-ui.json`**, not `web-ui-state.json`. `getWebUiStatePath()` → `{home}/web-ui.json` (`src/config/paths.ts:435-437`); written by `writeWebUiState` (`ironcurtain-daemon.ts:843-854`), removed on shutdown (`:857-863`).                                                                                                                                                                                                                                                                                           |
| `--web-ui` is required for the WS/JSON-RPC surface                                                                                                           | **Correct**                                                                    | Plain `ironcurtain daemon` starts only the **control socket** (UDS, `src/daemon/control-socket.ts`) which speaks a different, non-JSON-RPC protocol and has no workflow methods. The WS server is constructed only when `webUi` options are set (`ironcurtain-daemon.ts:182-189, 733-823`) and only then is `web-ui.json` written.                                                                                                                                                                                                               |
| "There is NO client-side WS/JSON-RPC transport in the repo today"                                                                                            | **Half-right — important**                                                     | There is no _reusable_ client module, **but** `src/observe/observe-command.ts` already implements the entire flow inline: `loadWebUiState()` (`:64-71`), WS connect with `?token=` (`:228-229`), `sendRpc()` id-correlation (`:79-83`), response/event frame demux (`:280-318`). The new client should be a **clean extraction of this proven logic**, and `observe` should be refactored onto it (or left as-is; see §9). The maintainer's instruction "similar to how the web UI resolves gates" is satisfied by reusing the same RPC methods. |

Two further facts that shape the design:

- **`presentedArtifacts` in the gate DTO is artifact _names only_, not content.**
  `HumanGateRequest.presentedArtifacts` is a `ReadonlyMap<string,string>` but
  `toHumanGateRequestDto` emits `Array.from(map.keys())` (`types.ts:529-547`).
  So to _inspect_ what a gate presents, the agent must call
  `workflows.artifacts(workflowId, artifactName)` per name. The gate's `summary`
  string is included in the DTO and is the primary human-readable rationale.
- **`resolveGate` enforces the feedback rule twice.** The RPC schema requires a
  non-empty trimmed `prompt` for `FORCE_REVISION`/`REPLAN`
  (`workflow-dispatch.ts:104,109`), and the orchestrator re-checks
  (`orchestrator.ts:1573-1577`). The CLI should validate a third time for a fast,
  local error message, but the daemon is authoritative.

## 3. Key design decisions

1. **One new reusable abstraction: a generic JSON-RPC-over-WS daemon client.**
   It is workflow-agnostic — it sends arbitrary `MethodName` requests and
   optionally subscribes to event frames. Workflow-specific knowledge lives in
   the CLI command, not the client. _Why:_ keeps the client a leaf module with a
   single responsibility (transport + correlation), reusable by `observe`, the
   new gate commands, and future CLI tooling.

2. **Reuse the existing `MethodName` / frame types from `web-ui-types.ts`; do
   not redefine them.** The client imports `RequestFrame`, `ResponseFrame`,
   `EventFrame`, `MethodName`, `ErrorCode` as **type-only** imports. _Why:_ one
   source of truth for the wire contract; the union of method names stays
   centralized; `import type` creates no runtime edge (see §8 layering).

3. **No new daemon RPC methods.** `workflows.start`, `workflows.get` (carries
   the gate DTO in `waiting_human` phase), `workflows.artifacts`, and
   `workflows.resolveGate` cover the entire loop. _Why:_ the locked decision, and
   the methods genuinely suffice. The one place this is tight — observing the
   _transition_ into a gate — is handled by event-frame subscription (already
   broadcast) plus polling fallback, neither of which needs a new method.

4. **Recommend BOTH observe ergonomics, with block-until-decision-point as the
   primary.** `workflow await <id>` holds the WS until the run next reaches a
   gate or a terminal, prints the machine-readable state, and exits.
   `workflow status <id>` is the cheap poll fallback. _Why:_ the agent's tool
   model is "run a command to completion" — a blocking command that returns
   exactly at the next decision point is the most natural fit and avoids
   busy-poll latency, but a stateless poll is the robust fallback when a watch
   drops or the agent prefers idempotent checks. Details and rationale in §6.

5. **Auto-start an opt-in, ensured daemon.** A `--ensure-daemon` flag (and an
   env opt-in) lets the agent spawn a detached `ironcurtain daemon --web-ui`
   if none is running, so the agent can be fully autonomous. Default is _off_:
   if no daemon is found we print a precise, machine-readable error telling the
   agent exactly what to run. _Why:_ autonomy vs. surprise side effects — see §7.

6. **Every new command supports `--json`** emitting a single, stable,
   newline-terminated JSON object to stdout (NDJSON-friendly); human-readable
   text goes to stderr. _Why:_ the agent parses stdout; humans read stderr; the
   two never interleave.

## 4. The daemon JSON-RPC client (the core new abstraction)

### Location

`src/daemon-client/daemon-client.ts` (new directory `src/daemon-client/`).

Rationale for placement (see §8 for the layering argument):

- It must be importable by **both** `src/observe/` and `src/workflow/` CLI code
  and by `src/cli.ts` routing, with no risk of an import cycle.
- It is a **leaf**: it depends only on `ws`, `node:fs`, `src/config/paths.ts`
  (for `getWebUiStatePath`), and **type-only** imports from
  `src/web-ui/web-ui-types.ts`. It imports no session/composition/runtime layer.
- Putting it under `src/web-ui/` would wrongly imply it is server-side; putting
  it under `src/daemon/` risks coupling to the control-socket server module.
  A dedicated `src/daemon-client/` directory names its role precisely (a _client
  of_ the daemon) and keeps the dependency arrows clean.

### Public API

```ts
// src/daemon-client/daemon-client.ts

import type { MethodName, ErrorCode } from '../web-ui/web-ui-types.js';

/** Connection coordinates discovered from ~/.ironcurtain/web-ui.json. */
export interface DaemonEndpoint {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

/**
 * Reads daemon connection info from the well-known state file
 * (`getWebUiStatePath()` → ~/.ironcurtain/web-ui.json).
 *
 * Returns `undefined` when the file is absent or unparseable — i.e. when no
 * daemon is running with `--web-ui`. Callers distinguish "no daemon" from
 * other failures by this `undefined` return, never by catching.
 */
export function discoverDaemon(): DaemonEndpoint | undefined;

/** Discriminated result of a single JSON-RPC call. */
export type RpcResult<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly data?: unknown };

/** A push event frame delivered to subscribers. */
export interface DaemonEvent {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

/** Unsubscribe handle returned by `onEvent`. */
export type Unsubscribe = () => void;

export interface DaemonClientOptions {
  /** Override discovery (tests, alternate endpoints). */
  readonly endpoint?: DaemonEndpoint;
  /** Per-request timeout in ms. Default 30_000. */
  readonly requestTimeoutMs?: number;
  /** Connect timeout in ms. Default 10_000. */
  readonly connectTimeoutMs?: number;
}

/**
 * A thin, generic JSON-RPC-over-WebSocket client for the IronCurtain daemon.
 *
 * Contract / invariants:
 *  - `connect()` must resolve before `call`/`onEvent` are used; calling them
 *    earlier rejects/throws synchronously with a clear error.
 *  - `call()` is id-correlated: concurrent calls are safe; each resolves with
 *    the response frame whose `id` matches. RPC-level errors do NOT reject the
 *    promise — they resolve as `{ ok:false, ... }` (so callers branch on a
 *    discriminant rather than try/catch). Transport failures (socket closed,
 *    timeout) DO reject.
 *  - `onEvent()` delivers every push frame (`{event,payload,seq}`) to the
 *    listener until unsubscribed. Listeners never see response frames.
 *  - `close()` is idempotent and unblocks any in-flight `call()` with a
 *    rejection. Safe to call from a `finally`.
 *  - The client never writes to stdout/stderr; all presentation is the caller's.
 */
export interface DaemonClient {
  connect(): Promise<void>;
  call<T = unknown>(method: MethodName, params?: Record<string, unknown>): Promise<RpcResult<T>>;
  onEvent(listener: (e: DaemonEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

/**
 * Constructs (but does not connect) a DaemonClient.
 *
 * Throws `DaemonNotRunningError` when no `endpoint` is supplied and discovery
 * fails — this is the single, typed signal an agent uses to decide whether to
 * start a daemon. The error carries a `code: 'DAEMON_NOT_RUNNING'` discriminant
 * so cross-module catchers don't need `instanceof`.
 */
export function createDaemonClient(options?: DaemonClientOptions): DaemonClient;

export class DaemonNotRunningError extends Error {
  readonly code = 'DAEMON_NOT_RUNNING' as const;
}
```

Notes on the contract:

- **RPC errors resolve, transport errors reject.** This mirrors the daemon's own
  `ResponseFrame` shape (`{ok:false, error:{code,message,data}}`) and lets the
  CLI map `WORKFLOW_NOT_AT_GATE`, `WORKFLOW_NOT_FOUND`, `INVALID_PARAMS`, etc.,
  to specific machine-readable exit states without try/catch noise.
- **`call<T>` is generic but unverified at runtime.** The daemon already
  validates params with Zod; the payload type parameter is a convenience for
  callers and is asserted, not parsed. The CLI commands narrow with small local
  guards where they consume payloads (e.g., checking `phase` before reading
  `gate`). This keeps the client free of workflow-DTO imports.
- **Auth handshake.** `connect()` connects directly to
  `ws://{host}:{port}/ws?token={token}`. The `GET /ws/auth` preflight is
  optional and only useful to distinguish "bad token" from "daemon down" _before_
  upgrading; for the CLI, a failed upgrade (401) is reported as an auth error and
  a refused connection (ECONNREFUSED) as daemon-down — both already distinguishable
  from the socket events. We will use the preflight only inside `--ensure-daemon`
  readiness polling (§7) where a fast yes/no is convenient.

### Internal structure (not exported)

- A single `ws` `WebSocket`, a `Map<string, {resolve, reject, timer}>` keyed by
  request id (`rpc-${counter}`), and a `Set<listener>` for events.
- `message` handler: parse JSON; if `id` present → settle the matching pending
  entry; else if `event` present → fan out to listeners. (Exactly the demux in
  `observe-command.ts:280-318`, extracted.)
- `wsDataToString` reused from `src/web-ui/ws-utils.ts` (already a shared leaf).

## 5. The agent-facing CLI surface

New non-interactive subcommands under `ironcurtain workflow`, all daemon-backed
and all with `--json`. They live alongside the existing in-process
`start/resume/inspect/list/lint/run-state` — **the interactive path is
untouched**.

```
ironcurtain workflow run    <name-or-path> "task" [--workspace <path>] [--json] [--ensure-daemon]
ironcurtain workflow status <workflowId> [--json]
ironcurtain workflow await  <workflowId> [--timeout <sec>] [--json]
ironcurtain workflow gate   <workflowId> --event <EVENT> [--prompt <text>] [--json]
ironcurtain workflow show   <workflowId> --artifact <name> [--json]      (thin wrapper over workflows.artifacts)
```

Naming choice: a **`run`** verb (not `start`) for the daemon-backed,
non-interactive launch, to avoid colliding semantics with the existing
interactive `start`. `start` keeps its current TTY behavior; `run` is the
"fire-and-forget on the daemon, get the id back" verb. (Alternative considered:
`start --daemon`; rejected because `start`'s whole body assumes an in-process
orchestrator + readline loop, and overloading it would entangle two very
different control flows in one function.)

### `workflow run` — REVISED

- **Resolve the definition path client-side first.** `resolveWorkflowPath(ref)`
  returns `string | undefined`; the daemon does NOT resolve names
  (`workflowStartSchema.definitionPath: z.string().min(1)`). On `undefined`, emit
  the CLI-level error `WORKFLOW_DEFINITION_NOT_FOUND` and exit non-zero **before
  connecting** to the daemon.
- Calls `workflows.start(definitionPath, taskDescription, workspacePath?)` with
  the resolved absolute path.
- On success prints the workflow id. `--json` stdout:
  `{"ok":true,"workflowId":"wf-...","phase":"running"}`. Text (stderr):
  `Started workflow wf-... (use: ironcurtain workflow await wf-...)`.
- **Error mapping (both load and lint).** The daemon's lint preflight throws
  `INVALID_PARAMS` when the definition fails to _load/validate_, and
  `LINT_FAILED` (with `error.data.diagnostics`) when it loads but lints with
  errors. Map BOTH: `LINT_FAILED` →
  `{"ok":false,"error":"LINT_FAILED","diagnostics":[...]}` (diagnostics read from
  `error.data.diagnostics`); `INVALID_PARAMS` →
  `{"ok":false,"error":"INVALID_PARAMS","message":...}`. Both exit non-zero.

### `workflow status` — the poll

- Calls `workflows.get(workflowId)` and projects the relevant slice.
- `--json` stdout shape (stable contract):

```json
{
  "ok": true,
  "workflowId": "wf-...",
  "phase": "waiting_human",
  "currentState": "design_review",
  "round": 1,
  "gate": {
    "gateId": "...",
    "stateName": "design_review",
    "summary": "Review of the technical design...",
    "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
    "presentedArtifacts": ["spec"]
  }
}
```

When `phase !== 'waiting_human'`, `gate` is omitted and `phase` is one of
`running | completed | failed | aborted` (plus the disk-fallback
`interrupted`). The `gate` block is exactly the `HumanGateRequestDto`, so
`presentedArtifacts` is **names**; the agent then calls `workflow show` per
name to read content.

**REVISED — read documented top-level DTO fields, do not invent a parallel
shape.** The projection consumes the `WorkflowDetailDto` returned by
`workflows.get`: top-level `phase`, `currentState` (built by the dispatch
`getCurrentState`), `round` (`WorkflowCardDto.round`), and `gate`
(`HumanGateRequestDto`, present only when `phase === 'waiting_human'`). This
same single projection function backs both `status` and `await`.

### `workflow await` — block-until-decision-point (primary) — REVISED

- Connects, subscribes to event frames, then **immediately** calls
  `workflows.get` once to handle the race where the gate/terminal was reached
  before the subscription attached (or before this process started).
- Resolves when **any** of these is observed for `workflowId`:
  - `phase === 'waiting_human'` — from the initial `get`, or a
    `workflow.gate_raised` event; **or**
  - a **terminal event** `workflow.completed` | `workflow.failed`; **or**
  - the initial `get` already reports a terminal `phase`
    (`completed`|`failed`|`aborted`).
- **Critical (event ≠ phase).** A gate-ABORT routes to an `aborted` terminal that
  emits a `workflow.completed` event (orchestrator `handleWorkflowComplete`),
  and an RPC `abort()` emits `workflow.failed` — yet both report
  `getStatus().phase === 'aborted'`. So the resolved _event name is not
  authoritative_. On resolution `await` does **one authoritative
  `workflows.get`** and reports/branches on its `phase`, printing the same JSON
  shape as `status`. There is deliberately **no** "wait-for-silence then poll"
  fallback for abort — the terminal event always arrives and the follow-up `get`
  disambiguates.
- `--timeout <sec>` bounds the wait; on timeout prints
  `{"ok":false,"error":"AWAIT_TIMEOUT","phase":"running"}` (a CLI-level error
  string) and exits `4`, leaving the workflow running (idempotent: the agent can
  `await` again).
- **Exit codes derive from the authoritative `phase`, never the event name:**
  `0` = `waiting_human` | `completed`; `3` = `failed` | `aborted`; `4` = await
  timeout. (Distinct codes let a shell-only agent branch without parsing JSON.)

Why `await` is event-driven _plus_ an initial get: the broadcast
`workflow.gate_raised` / terminal events are the low-latency signal, but a
purely event-driven wait would deadlock if the gate/terminal was reached in the
window between `workflows.start` returning and the client subscribing. The
initial `get` closes that race deterministically; the subscription covers the
steady state.

### `workflow gate` — resolve

- Validates locally: `--event` ∈ {APPROVE, FORCE_REVISION, REPLAN, ABORT};
  for FORCE_REVISION/REPLAN require a non-empty `--prompt` (fast local error,
  daemon re-validates).
- Calls `workflows.resolveGate(workflowId, event, prompt?)`.
- The daemon returns no payload on success; maps to
  `{"ok":true,"workflowId":"...","event":"APPROVE"}`.
- `WORKFLOW_NOT_AT_GATE` → `{"ok":false,"error":"WORKFLOW_NOT_AT_GATE"}` exit
  non-zero (the agent should `await`/`status` first). `INVALID_PARAMS` (e.g.
  empty feedback that slipped past the local check) maps through verbatim.
- Returns immediately after the gate is accepted; the agent then re-issues
  `workflow await <id>` to run to the next decision point.

### `workflow show` — read a presented artifact

- Thin wrapper over `workflows.artifacts(workflowId, artifactName)`; prints the
  `{files:[{path,content}]}` payload. `--json` emits it verbatim. This is the
  command that turns a gate's `presentedArtifacts` _names_ into _content_ the
  agent reasons over. (Reuses the existing artifact reader; no new method.)

## 6. Poll vs. block — recommendation

**Provide both; document `await` as primary, `status` as fallback.**

- **`await` (block-until-decision-point)** is the natural fit for an agent whose
  tool calls run to completion. The agent's loop becomes a clean alternation:
  `run → await → (inspect → gate → await)* → terminal`. Each `await` returns
  exactly when there is something to decide or the run is done, with no
  busy-poll latency and no arbitrary sleep tuning. It exits, so it composes with
  the "run a command, read output, run next" tool model.
- **`status` (poll)** is the robust, stateless fallback: idempotent, no
  long-lived socket, trivially retryable. It is the right tool when a watch was
  dropped, when the agent wants a one-shot check, or when running in an
  environment where long-held connections are undesirable.

`await` and `status` deliberately emit the **same JSON shape**, so the agent can
treat them interchangeably and switch strategies without reparsing logic.
`await` is implemented on top of the same `workflows.get` projection plus event
subscription — there is no second code path for the state shape.

## 7. Daemon discovery, lifecycle, and auto-start

### Discovery

`discoverDaemon()` reads `~/.ironcurtain/web-ui.json`
(`getWebUiStatePath()`). Present ⇒ a daemon is running **with `--web-ui`** and
the file holds `{host,port,token}`. Absent ⇒ either no daemon, or a daemon
running **without** `--web-ui` (control-socket-only), which has no JSON-RPC/WS
surface and therefore cannot serve these commands.

### Error when no daemon (default behavior)

Without `--ensure-daemon`, a missing endpoint produces a precise, actionable,
machine-readable error and a non-zero exit — never a hang:

```json
{ "ok": false, "error": "DAEMON_NOT_RUNNING", "hint": "Start the daemon with: ironcurtain daemon --web-ui" }
```

stderr (human): `No IronCurtain daemon with web UI is running. Start one with: ironcurtain daemon --web-ui`.

This is exactly the precedent set by `observe` (`observe-command.ts:218-225`),
kept consistent. The `--web-ui` requirement is surfaced explicitly because a
plain `ironcurtain daemon` will _not_ satisfy these commands.

### Auto-start (`--ensure-daemon`, opt-in)

To let an agent be fully autonomous, `workflow run --ensure-daemon` (and an env
opt-in `IRONCURTAIN_ENSURE_DAEMON=1`) will, when discovery fails:

1. Spawn `ironcurtain daemon --web-ui` **detached** using
   `child_process.spawn(process.execPath, [cliEntry, 'daemon', '--web-ui'],
{ detached: true, stdio: 'ignore' })` with `.unref()` — **arg array, no
   shell string** (per CLAUDE.md "Safe Coding"). The exact spawn target mirrors
   how `cli.ts` invokes subcommands.
2. Poll `discoverDaemon()` (and optionally the `GET /ws/auth` preflight) until
   `web-ui.json` appears and the WS accepts the token, or a bounded timeout
   (~15s) elapses.
3. Proceed with the original command, or fail with
   `{"ok":false,"error":"DAEMON_START_TIMEOUT"}`.

**Recommendation: implement `--ensure-daemon`, default off.** Tradeoffs:

- _For:_ true autonomy — the agent never needs a human to pre-start a daemon;
  one flag and the loop self-bootstraps.
- _Against:_ a detached daemon is a real, persistent side effect (it keeps
  running, schedules cron jobs, may start Signal/Docker). Auto-spawning silently
  would surprise users and could collide with an intentionally-not-running
  daemon. Making it opt-in keeps the default behavior conservative and explicit,
  while still enabling full autonomy for agents that ask for it.
- _Scope guard:_ `--ensure-daemon` only _ensures_ — it never _stops_ the daemon
  it started (lifecycle stays the user's). A future `--ephemeral-daemon` that
  tears down on exit is possible but out of scope; it would complicate the
  "run a command to completion" model (the daemon must outlive `run` so later
  `await`/`gate` calls can reach it).

## 8. Module layering (CLAUDE.md compliance)

- `src/daemon-client/` is a **leaf**. Runtime imports: `ws`, `node:fs`,
  `src/config/paths.ts` (leaf), `src/web-ui/ws-utils.ts` (leaf). **Type-only**
  import from `src/web-ui/web-ui-types.ts` — allowed everywhere, creates no
  runtime edge. It imports **nothing** from `session/`, `sandbox/`,
  `trusted-process/`, `docker/`, `workflow/`, `memory/`, or `pipeline/`.
- The new `workflow` subcommands live in CLI code
  (`src/workflow/workflow-command.ts` routing → a new
  `src/workflow/daemon-gate-commands.ts`). This module imports the daemon client
  (leaf) and reuses `resolveWorkflowPath` from `src/workflow/discovery.js`. It
  does **not** import the orchestrator/manager runtime — it only talks to the
  daemon over WS. So no new heavy edges are introduced into the CLI layer.
- Cross-module error handling uses the **discriminant string**
  `code === 'DAEMON_NOT_RUNNING'` (and the daemon's `ErrorCode` strings), never
  `instanceof` across module boundaries — per CLAUDE.md.
- No value-level import from `pipeline/` anywhere on this path. No `require()`,
  no non-null assertions, ESM `.js` import specifiers throughout.

## 9. Backward compatibility & minimal-change accounting

### ADD

| Path                                                   | Purpose                                                                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon-client/daemon-client.ts`                   | The reusable JSON-RPC-over-WS client (§4).                                                                                                                                                                           |
| `src/workflow/daemon-gate-commands.ts`                 | Implements `run`/`status`/`await`/`gate`/`show` against the client; `--json` projections; exit-code mapping; `--ensure-daemon` spawn.                                                                                |
| `test/workflow/fixtures/test-gate-smoke/workflow.yaml` | Synthetic minimal gated workflow fixture (§10). **REVISED** — under `test/` fixtures (passed by absolute path), NOT `src/workflow/workflows/`, so it never appears in the shipped `workflow list` discovery surface. |
| `test/daemon-client.test.ts`                           | Unit tests for the client against a real `WebUiServer` with a mock handler.                                                                                                                                          |
| `test/workflow/agent-gate-loop.integration.test.ts`    | End-to-end: boot WS server + WorkflowManager, drive the fixture through APPROVE and FORCE_REVISION-with-prompt to terminal via the client.                                                                           |
| `docs/designs/agent-driven-workflow-gates.md`          | This document.                                                                                                                                                                                                       |

### MODIFY

| Path                               | Change                                                                                                                                                                                                                                                         | Why minimal                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/workflow-command.ts` | Add `run`/`status`/`await`/`gate`/`show` cases to the `main()` switch + help spec; delegate bodies to `daemon-gate-commands.ts`.                                                                                                                               | Routing only; existing `start/resume/inspect/lint/run-state` bodies untouched.                                                                                   |
| `src/workflow/workflow-manager.ts` | **REVISED (added) — the DI seam.** Add optional `sessionFactoryOverride?: (opts: SessionOptions) => Promise<Session>` to `WorkflowManagerOptions`; in `createOrchestrator`, use it as `deps.createSession` (falling back to `createWorkflowSessionFactory()`). | One nullable field + one `??`; production default path is byte-identical when the override is absent. Makes the WS integration test hermetic without a real LLM. |
| `src/observe/observe-command.ts`   | _Deferred._ Optional refactor to consume `DaemonClient` instead of inline WS logic.                                                                                                                                                                            | Pure internal refactor, no behavior change — left untouched in this PR so it adds the client without touching a working command.                                 |

### Explicitly NOT changed

- **No new daemon RPC methods.** `MethodName`, `workflow-dispatch.ts`,
  `web-ui-server.ts`, `web-event-bus.ts`, `ironcurtain-daemon.ts` are unchanged.
  The existing `workflows.start/get/artifacts/resolveGate` + the
  `workflow.gate_raised`/`completed`/`failed` event frames are sufficient.
- **The interactive `workflow start` path** (`runStart`, `runEventLoop`,
  `promptGateInteractive`, `createGateHandler`) is untouched.
- **The web UI** (frontend and its dispatch) is untouched.

If a future need arises to disambiguate "aborted" without a follow-up `get`
(currently inferred), the smallest possible addition would be a
`workflow.aborted` event — but it is **not required** for this feature and is
left out to honor the minimal-change constraint.

## 10. Test plan

### Synthetic fixture: `test-gate-smoke`

A tiny workflow whose only job is to reach a `human_gate`, route on the event,
and terminate — with **no real LLM calls**. The gate path through the
orchestrator (raiseGate → bus event → `getStatus` gate DTO → resolveGate) does
not itself require an agent; the agent state before the gate is what normally
costs an LLM call.

Design choice to keep it LLM-free in the integration test: drive the
`WorkflowManager` with a **stub session factory** via the new
`WorkflowManagerOptions.sessionFactoryOverride` seam (REVISED — this seam did not
exist; see §9 MODIFY). The stub reuses `createArtifactAwareSession`
(`test/workflow/test-helpers.ts`) so the pre-gate `agent` state resolves
instantly with `approvedResponse()` and writes the `draft` artifact directory the
gate `present`s. The fixture uses `settings.mode: builtin` (the default is
`docker`) and `persona: global`, so no Docker infrastructure and no persona
stubbing are needed. It lives at
`test/workflow/fixtures/test-gate-smoke/workflow.yaml` and is supplied to
`workflows.start` by absolute path. The fixture shape:

```yaml
name: test-gate-smoke
description: 'TESTING ONLY - reaches a human_gate, routes on the event, terminates.'
initial: produce

states:
  produce:
    type: agent # resolved by the stub factory in the test
    description: Produce a trivial artifact for review.
    persona: global
    outputs: [draft]
    transitions:
      - to: review

  review:
    type: human_gate
    description: Review the draft.
    acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]
    present: [draft]
    transitions:
      - to: done
        event: APPROVE
      - to: produce # FORCE_REVISION loops back (requires feedback)
        event: FORCE_REVISION
      - to: aborted
        event: ABORT

  done:
    type: terminal
    description: Approved.
  aborted:
    type: terminal
    description: Aborted.
```

This exercises all three relevant outcomes (APPROVE → terminal, FORCE_REVISION →
loop with required feedback, ABORT → terminal) and a `present`ed artifact so the
`workflows.artifacts` / `workflow show` path is covered.

### Integration test: `agent-gate-loop.integration.test.ts`

Boots the WS surface the same way `test/web-ui-server.test.ts` does (real
`WebUiServer` on `port: 0`, mock `ControlRequestHandler`, real `WorkflowManager`
wired to `server.getEventBus()`), then drives everything through the **real
`DaemonClient`** — proving the agent loop end-to-end.

Sequence:

1. Start server (`port:0`), construct `WorkflowManager({ eventBus:
server.getEventBus(), sessionFactoryOverride: stub })`, `setWorkflowManager`.
2. `createDaemonClient({ endpoint: { host:'127.0.0.1', port, token } })` (bypass
   discovery — the test supplies the endpoint), `connect()`.
3. `call('workflows.start', { definitionPath: <fixture>, taskDescription })`;
   assert `{ workflowId }`.
4. **Await-to-gate:** subscribe via `onEvent`; assert a `workflow.gate_raised`
   for the id (and that an immediate `workflows.get` reports
   `phase:'waiting_human'` with `gate.stateName === 'review'`,
   `gate.presentedArtifacts` containing `'draft'`). This asserts **requirement #2
   — machine-readable gate visibility.**
5. **Inspect:** `call('workflows.artifacts', { workflowId, artifactName:'draft' })`;
   assert content is the stub-produced text.
6. **FORCE_REVISION path:** `call('workflows.resolveGate', { workflowId,
event:'FORCE_REVISION', prompt:'tighten it' })`; assert ok. Then assert it
   loops back to `produce` and raises the gate **again** (second
   `workflow.gate_raised`). Also assert that resolving with `FORCE_REVISION` and
   an **empty** prompt returns an `INVALID_PARAMS` RPC error (the feedback rule).
7. **APPROVE path:** `resolveGate(... event:'APPROVE')`; await
   `workflow.completed`; assert `workflows.get` → `phase:'completed'`. This
   asserts **requirement #3 — autonomous resolution drives to terminal.**
8. A second test case runs `produce → review → ABORT` and asserts
   `phase:'aborted'`.
9. `client.close()`; `server.stop()`.

Conventions honored:

- Real processes / sockets → `~30s` test timeout (matching existing integration
  tests), `port:0` for OS-assigned ports, all sockets tracked and closed in
  `afterEach` (pattern from `test/web-ui-server.test.ts:79-92`).
- Any on-disk workflow base dir is created under `/tmp/` and removed in
  cleanup (matching existing workflow integration tests).
- No real LLM key required: the stub session factory resolves agent states
  deterministically, so the test is hermetic and fast.

### Unit test: `daemon-client.test.ts`

Against a minimal stub `ws` server (or the real `WebUiServer` with a mock
handler): id-correlation under concurrent `call()`s; `{ok:false}` RPC errors
resolve (not reject); transport close rejects in-flight calls; `onEvent`
delivers push frames and `Unsubscribe` stops delivery; `connect()` timeout;
`discoverDaemon()` returns `undefined` on a missing/garbage `web-ui.json` and a
parsed endpoint on a good one; `createDaemonClient()` throws
`DaemonNotRunningError` (with `code:'DAEMON_NOT_RUNNING'`) when discovery fails
and no `endpoint` is supplied.

## 11. End-to-end agent loop (worked example)

The autonomous agent's tool calls, each run to completion, stdout parsed as JSON:

```bash
# 0. (optional) ensure a daemon exists; otherwise the agent runs this once itself:
#    ironcurtain daemon --web-ui    (detached)

# 1. Start the gated workflow on the daemon.
$ ironcurtain workflow run test-gate-smoke "Draft and review a thing" --json --ensure-daemon
{"ok":true,"workflowId":"wf-7a3","phase":"running"}

# 2. Block until the run needs a decision (or finishes).
$ ironcurtain workflow await wf-7a3 --json
{"ok":true,"workflowId":"wf-7a3","phase":"waiting_human","currentState":"review",
 "gate":{"gateId":"g1","stateName":"review","summary":"Review the draft.",
         "acceptedEvents":["APPROVE","FORCE_REVISION","ABORT"],
         "presentedArtifacts":["draft"]}}
#  -> requirement #2 satisfied: the agent now KNOWS input is required, which gate,
#     what's decided (summary + acceptedEvents), and what to inspect (["draft"]).

# 3. Inspect the presented artifact (names -> content).
$ ironcurtain workflow show wf-7a3 --artifact draft --json
{"ok":true,"files":[{"path":"draft.md","content":"...the draft..."}]}

# 4. The AGENT decides. Say it wants changes:
$ ironcurtain workflow gate wf-7a3 --event FORCE_REVISION --prompt "tighten the intro" --json
{"ok":true,"workflowId":"wf-7a3","event":"FORCE_REVISION"}
#  -> requirement #3 satisfied: the agent resolved the gate itself.

# 5. Run to the next decision point again.
$ ironcurtain workflow await wf-7a3 --json
{"ok":true,"workflowId":"wf-7a3","phase":"waiting_human","currentState":"review",
 "gate":{"gateId":"g2","stateName":"review", ... "presentedArtifacts":["draft"]}}

# 6. This time the agent approves.
$ ironcurtain workflow gate wf-7a3 --event APPROVE --json
{"ok":true,"workflowId":"wf-7a3","event":"APPROVE"}

# 7. Drive to terminal.
$ ironcurtain workflow await wf-7a3 --json
{"ok":true,"workflowId":"wf-7a3","phase":"completed","currentState":"done"}
# exit 0 -> the loop ends.
```

The alternation `run → await → (show → gate → await)* → terminal` is exactly the
request/response shape an autonomous agent runs. The poll variant
(`workflow status wf-7a3 --json`) is a drop-in replacement for any `await` step
when a stateless check is preferable.
