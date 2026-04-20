# Token Stream Bus Ownership

**Status:** Shipped (Option F — module-level singleton, all 5 migration steps landed on branch `feat/workflow-container-lifecycle-step-6`).
**Author:** feature-architect
**Scope:** Who creates, threads, and disposes the `TokenStreamBus`, and how new entry points avoid forgetting to wire it up.

This document is retained as a design record. The Migration Plan below is now a
changelog — see §5 for the completed steps. Mechanics described in §§1–4 reflect
the pre-migration state; today `createMitmProxy` and `TokenStreamBridge` both
read the singleton via `getTokenStreamBus()` and no bus is threaded through
`MitmProxyOptions`, `DockerInfrastructure`, `SessionOptions`, or any dispatch
context.

---

## 1. Current State

### 1.1 The contract

- `TokenStreamBus` (`src/docker/token-stream-bus.ts:45-74`) is a stateless pub/sub dispatcher keyed by `SessionId`. `push()` delivers events synchronously to per-session and global listeners; it silently drops if nobody is listening.
- Producer: `createMitmProxy()` accepts an **optional** `{ tokenStreamBus, sessionId }` pair (`src/docker/mitm-proxy.ts:136-148`). Both-or-neither is enforced at construction (`mitm-proxy.ts:481-485`). When absent, the MITM proxy still runs — it just skips installing the SSE extractor tap.
- Consumers:
  - `TokenStreamBridge` (`src/web-ui/token-stream-bridge.ts`) — subscribes per-label and globally, fans events out to WebSocket clients.
  - The `ironcurtain observe` CLI is indirectly a consumer: it connects to the daemon's web UI WS server (`src/observe/observe-command.ts:14-16, 58-72`) and never touches the bus directly.

### 1.2 Who creates the bus today

Exactly one creator, at one site:

| Site | Line | What it does |
| --- | --- | --- |
| `IronCurtainDaemon` | `src/daemon/ironcurtain-daemon.ts:83` | `private readonly tokenStreamBus: TokenStreamBus = createTokenStreamBus();` |

Everyone else borrows this instance.

### 1.3 Who threads the bus

Per entry point, what happens to `tokenStreamBus`:

| Caller | File:line | Threads bus? |
| --- | --- | --- |
| Daemon → cron `executeJob()` | `daemon/ironcurtain-daemon.ts:500-508` | Yes — passes `tokenStreamBus: this.tokenStreamBus` into `createSession`. |
| Daemon → web UI dispatch context | `daemon/ironcurtain-daemon.ts:726` → `web-ui/dispatch/session-dispatch.ts:141` | Yes — web sessions pass `tokenStreamBus: ctx.tokenStreamBus`. |
| Daemon → `SignalBotDaemon.createSession` | `signal/signal-bot-daemon.ts:499-506` | **No.** Bot constructs `createSession()` without `tokenStreamBus`. MITM comes up bus-less; dead subscription. |
| `ironcurtain start` (CLI) | `index.ts:176-186` | **No.** No daemon, so no bus. |
| Workflow CLI `workflow-command.ts::runStart()` | `workflow/workflow-command.ts:234-243` | **No.** `WorkflowOrchestratorDeps` has no bus field. |
| Workflow via web UI (`WorkflowManager.createOrchestrator`) | `web-ui/workflow-manager.ts:146-163` | **No.** Does not own or forward the daemon's bus. |
| Shared-container workflow → `loadDefaultInfrastructureFactory` | `workflow/orchestrator.ts:556-598` | **No.** Calls `createDockerInfrastructure(..., sessionId)` omitting the seventh argument. |
| Workflow → per-state `createSession` | `workflow/orchestrator.ts:1196-1214` | **No.** Session factory options omit `tokenStreamBus`. |

So the bus hookup exists on **two** of six session-creation paths. On every other path the SSE extractor is never attached, and any subscriber on the daemon's bus hears silence for those sessions.

### 1.4 Observed symptom

`tsx src/cli.ts observe --all --raw`, connected to a daemon running a workflow started via the web UI, produces no output. The daemon has a bus, the bridge subscribes, the observer subscribes via WS — but the MITM created by `WorkflowManager → WorkflowOrchestrator → loadDefaultInfrastructureFactory → createDockerInfrastructure` has no `tokenStreamBus` reference and silently declines to tap.

---

## 2. Problem Statement

The bus is optional on every hop. Every new session-creation callsite is an opportunity for a silent regression.

1. **Silent failure mode.** Missing the bus never throws or logs — the SSE extractor simply isn't installed. You have to know what you're looking for.
2. **Cross-process symmetry is broken.** A workflow launched via the daemon-hosted web UI and one launched via `tsx src/cli.ts workflow start` share `WorkflowOrchestrator` and `createDockerInfrastructure`, but only one path is inside a process that owns a bus.
3. **Testability pressure is backwards.** No ergonomic stub for "I don't care about token events." The absent-bus production case gets covered by happy accident.
4. **Ownership is ambient.** The daemon owns the bus; everyone borrows a reference. Ownership is never encoded in any interface.
5. **The CLI-only path can never stream.** Even fixing workflow-via-web-UI wiring leaves `ironcurtain workflow start` (no daemon) with no bus.

The through-line: **the bus is treated as optional infrastructure, but it's actually a protocol contract between the MITM proxy and its subscribers.** Making that contract optional at every hop is how we got here.

---

## 3. Design Options

### Option A — Status quo, harder to forget

Make `tokenStreamBus` a **required, non-optional** field on every hop. Ship a shared `NoOpTokenStreamBus` for callers that don't stream. Compiler forces every caller to supply a bus, but non-daemon callers all supply the noop, so the hookup is still "informed forgetting." Low migration cost, but CLI streaming still requires code changes in every CLI caller.

### Option B — Session/orchestrator owns the bus, entry points subscribe

Lift the bus one level into the runtime that owns the sessions. **B.1:** each `Session` owns a bus, exposed via `Session.getTokenStreamBus()`. **B.2:** each `WorkflowOrchestrator` owns a bus; individual sessions route through it. B.2 is strictly better than B.1 for workflows; weakness is the "per-session observability outside a workflow" case. Medium migration cost; daemon bridge must resubscribe per session or per orchestrator.

### Option C — Process-level singleton (early sketch)

One `TokenStreamBus` per process, accessed via a module-level accessor. MITM proxy reads it at construction; no wiring through intermediates. Initial appraisal dismissed this as architecturally regressive because of the "global mutable state" smell and because multi-bus futures (per-tenant, per-workflow isolated buses) would be blocked. See Option F for the revised appraisal — this section is retained only to show the reasoning chain.

### Option D — Infrastructure bundle always carries a bus

Make `DockerInfrastructure` always carry a `tokenStreamBus`. `prepareDockerInfrastructure()` and `createDockerInfrastructure()` construct one when the caller doesn't supply one, expose it on the bundle, and pass it to `createMitmProxy` unconditionally. Clean for Docker-session paths; doesn't cover builtin (no infra bundle). Low-medium migration cost.

### Option E — Orchestrator bus, bundle transports it (hybrid) — *rejected*

Narrow hybrid of B.2 and D: `WorkflowOrchestrator` creates a bus at `start()` time, passes it into `createDockerInfrastructure`, which stamps it into `DockerInfrastructure.tokenStreamBus`. For non-workflow sessions, the runtime that creates the session constructs its own single-session bus. Daemon becomes an **aggregator** — it subscribes to each child bus and republishes into its own daemon-wide bus. `tokenStreamBus` parameter disappears from `SessionOptions`; new required field on `DockerInfrastructure` and `CreateWorkflowInfrastructureInput`.

Strengths: ownership is encoded in types; the bug-we're-fixing becomes a type error; "per-tenant bus" futures are open. Weaknesses (which killed it): substantial signature churn on `DockerInfrastructure`, `createMitmProxy`, `SessionOptions`, `CreateWorkflowInfrastructureInput`, `WorkflowOrchestratorDeps`, and ~37 MITM-related test call sites; requires a daemon aggregator layer and a `onTokenStreamBusCreated` lifecycle hook; the isolation benefit is **illusory** because subscribers filter by `sessionId` anyway — distinct `sessionId`s already guarantee isolation regardless of how many bus instances exist.

### Option F — Module-level singleton (process-wide bus)

Exactly one `TokenStreamBus` per process, created lazily the first time anything asks for it, exposed through a module-level accessor:

```ts
// src/docker/token-stream-bus.ts
let instance: TokenStreamBus | undefined;

export function getTokenStreamBus(): TokenStreamBus {
  instance ??= createTokenStreamBus();
  return instance;
}

export function resetTokenStreamBus(): void {
  instance = undefined;
}
```

Publishers (MITM SSE extractor; eventually builtin-session deltas) call `getTokenStreamBus().push(sessionId, event)`. Subscribers (web UI bridge, `observe` CLI, future file-tail loggers) call `getTokenStreamBus().subscribe(sessionId, handler)` or `subscribeAll(...)`. Entry points thread nothing.

| Property | Assessment |
| --- | --- |
| Removes the bug class? | **Yes, by construction.** There's nothing to forget to pass because there's no parameter to pass. The web-UI-workflow symptom (§1.4) becomes impossible because `createMitmProxy` fetches the bus from the module itself. |
| Signature churn | **Minimal.** `tokenStreamBus` deletions from `MitmProxyOptions`, `DockerInfrastructure`, `createDockerInfrastructure`, `prepareDockerInfrastructure`, `SessionOptions`, dispatch contexts. No new required fields anywhere. |
| Infrastructure code | ~10 lines (the snippet above). No aggregator, no lifecycle hook, no republishing. |
| CLI/daemon symmetry | **Automatic.** Both call `getTokenStreamBus()`. The only difference between them is who subscribes. |
| Session isolation | **Already correct.** `TokenStreamBus` dispatch is keyed by `sessionId`, which is a UUID (standalone sessions) or workflow ID (orchestrated). Concurrent workflows cannot observe each other's events because they can't guess each other's IDs. Multi-bus was protecting against a threat that doesn't exist. |
| Explicit dependency | **Weakened.** A constructor that calls `getTokenStreamBus()` internally doesn't advertise that it publishes/subscribes. Mitigation: grep for `getTokenStreamBus()` — the set of call sites is small and stable. |
| Test isolation | Vitest runs each test **file** in its own worker process by default (`pool: 'forks'`). The project's `vitest.config.ts` relies on that default, so cross-file contamination is impossible today. Within a single file, tests that need strict isolation call `resetTokenStreamBus()` in `beforeEach`. Distinct `sessionId`s per test provide logical isolation even without reset. If the project ever switches to an in-process pool, the same reset contract still applies. |
| Vite HMR / long-lived worker reuse | Same `resetTokenStreamBus()` contract; document it. If a test file accumulates subscribers across tests and leaks, the fix is one line in `beforeEach`. |
| Future multi-bus | Not blocked. If we ever need per-tenant buses (e.g., multi-user daemon), the natural extension is a keyed registry (`getTokenStreamBus(tenantId)`), which is still a module-level accessor — today's call sites just pass no key. |

---

## 4. Recommendation

**Option F (module-level singleton).** Rationale:

1. **Eliminates the bug class structurally.** The original defect was "workflow entry points forget to pass the bus." Remove the parameter, remove the defect. Option E achieved the same end through type-system forcing; Option F achieves it by removing the decision altogether. Fewer moving parts.
2. **The complexity of Option E didn't earn its keep.** The putative benefit of multiple bus instances was isolation, but isolation is already provided by `sessionId` keying inside a single bus. The aggregator + `onTokenStreamBusCreated` hook + required field on `DockerInfrastructure` + the 37-call-site MITM test migration were architecting around ownership aesthetics, not a real functional requirement.
3. **Matches Node ecosystem conventions for cross-cutting observability.** `process.stdout`, logger singletons, Winston's default logger, `console.*` — the pattern is ubiquitous precisely because the data being observed is a property of the process, not of any one caller.
4. **CLI/daemon symmetry becomes trivial.** The motivating concern — workflows launched via web UI and via `workflow start` should behave the same — collapses to "both call `getTokenStreamBus()`." No daemon-dependent wiring.
5. **Test cost is contained.** Vitest's default per-file worker isolation plus an explicit `resetTokenStreamBus()` are sufficient; streaming tests already construct a bus per test, so they just migrate from constructor-injection to `reset + get`.

Option E was the more layered, textbook answer. F is the right answer for this codebase because the complexity E added was defending against a problem (cross-workflow crosstalk) that the existing `sessionId` discriminator already prevents.

### Residual concerns

- **`src/docker/pty-session.ts`** calls `prepareDockerInfrastructure` without a bus today. Under Option F this path needs no special handling — the MITM itself calls the singleton when it installs the SSE tap, so PTY sessions automatically publish to the global bus.
- **Vitest parallelism.** The project's `vitest.config.ts` does not set `pool` explicitly and inherits the `forks` default, so each test file runs in a fresh worker process. Confirmed safe. If the config ever moves to `threads` or `vmThreads`, or if a suite explicitly shares a worker, add `resetTokenStreamBus()` to `beforeEach` in that file.
- **Discoverability.** Because the dependency is implicit, reviewers can't tell from a constructor signature that it publishes or subscribes. Mitigation is a single grep pattern (`getTokenStreamBus()`) plus a short comment in `token-stream-bus.ts` that enumerates known publishers and subscribers.

### Resolved open questions

- **Q1 (aggregator topology).** Dissolved. No aggregator. The web UI bridge and `observe` CLI both subscribe to the same global bus.
- **Q2 (per-workflow vs per-state buses).** Dissolved into "should events carry a `stateId` payload?" — strictly additive, orthogonal, future work. Not a bus-ownership concern.
- **Q3 (builtin sessions).** Unchanged. Builtin has no publisher today; subscribers for builtin session IDs see no events. If/when builtin gets streaming support, it publishes to the singleton — no wiring required.
- **Q4 (required MITM arg).** Dissolved. MITM calls `getTokenStreamBus()` internally. No required arg; no 37-call-site test migration.

---

## 5. Migration (completed)

All 5 steps landed on branch `feat/workflow-container-lifecycle-step-6`. The
plan below is retained verbatim as a changelog — none of it is pending work.

### Step 1 — Add the singleton accessor

- In `src/docker/token-stream-bus.ts`, add top-level `getTokenStreamBus()` and `resetTokenStreamBus()` alongside the existing `createTokenStreamBus()` factory.
- Keep `createTokenStreamBus()` exported for the handful of tests that want a stack-local bus for assertion purposes (they can choose to use it directly rather than the singleton).

### Step 2 — MITM fetches the bus internally

- `createMitmProxy` reads `getTokenStreamBus()` when it installs the SSE extractor tap.
- Remove `tokenStreamBus` from `MitmProxyOptions`.
- Remove the both-or-neither guard (`mitm-proxy.ts:481-485`): `sessionId` is now the only argument needed to gate extractor installation.

### Step 3 — Delete threading through infrastructure and sessions

- Remove `tokenStreamBus` from `DockerInfrastructure`, `createDockerInfrastructure`, `prepareDockerInfrastructure`, `SessionOptions`, and any dispatch context that carried it (`web-ui/dispatch/session-dispatch.ts`, `daemon/ironcurtain-daemon.ts` invocation sites).
- Daemon stops constructing its own bus. `IronCurtainDaemon` reads from `getTokenStreamBus()` if it needs a direct reference (e.g., for endSession calls), or delegates to the bridge.

### Step 4 — Bridge and observe CLI use the singleton

- `TokenStreamBridge` constructor either accepts no bus (reads from `getTokenStreamBus()`) or retains its parameter with a default — preference: no parameter, for consistency with the rest of the migration.
- `observe` CLI / daemon dispatch reads the singleton similarly.

### Step 5 — Test updates

- `test/mitm-proxy-token-stream.test.ts` and `test/token-stream-bridge.test.ts` — add `resetTokenStreamBus()` in `beforeEach`. Swap their local `createTokenStreamBus()` for either the singleton (via `getTokenStreamBus()`) or a manually-constructed one, depending on whether the test asserts on cross-subscriber behavior.
- No changes expected at the 37 MITM test call sites that today omit `tokenStreamBus` — they already pass no bus and will continue to work.

### Backwards compatibility

- `TokenStreamBus` public API (push/subscribe/subscribeAll/endSession) is unchanged.
- `createTokenStreamBus()` remains exported for tests and for any future multi-bus extension.
- External callers who constructed `MitmProxyOptions` with a `tokenStreamBus` field will see a type error and drop the field — no behavioral migration required.

---

## 6. Out of Scope

This design deliberately does **not** touch:

- **Event payload schema changes** (adding `stateId`, workflow provenance, etc.). Additive, orthogonal, separate design.
- **SSE extractor internals.** How events are parsed out of SSE/JSON responses is unrelated to bus ownership.
- **`TokenStreamBridge` fanout protocol.** The WS fan-out, 50 ms batcher, and client-subscription model stay as-is.
- **Builtin (non-Docker) session streaming.** `AgentSession` has no MITM; if it later publishes deltas, it publishes to the singleton. Wiring AI-SDK `generateText` into the bus is a follow-up.
- **Retention / replay.** The bus remains strictly live; no history, no replay.
- **Authz at the bus.** The daemon still decides which WS clients can subscribe to which sessions; the bus is not a trust boundary.
