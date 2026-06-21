# Daemon WS JSON-RPC client + agent gate commands

## Wire protocol (daemon web UI)
- Discovery file: `~/.ironcurtain/web-ui.json` = `{host,port,token}`. Path: `getWebUiStatePath()` in `src/config/paths.ts`. Written only when daemon runs with `--web-ui`. Plain `ironcurtain daemon` = control socket only (no WS).
- WS URL: `ws://{host}:{port}/ws?token={token}`. Auth via `?token=`; bad token → upgrade rejected (ws 'error').
- Frames: request `{id,method,params}`; response `{id,ok:true,payload?}` | `{id,ok:false,error:{code,message,data?}}`; event `{event,payload,seq}`. maxPayload 1MB.
- Types (type-only import): `MethodName`, `RequestFrame`, `ResponseFrame`, `EventFrame`, `ErrorCode` in `src/web-ui/web-ui-types.ts`. `wsDataToString` leaf in `src/web-ui/ws-utils.ts`.
- DONE: `observe-command.ts` was refactored ONTO `DaemonClient` (commit refactor(observe): drive observe over DaemonClient + add onClose). The inline WS plumbing (loadWebUiState/sendRpc/demux) is gone. observe now uses discoverDaemon()/connect()/call()/onEvent()/onClose().

## DaemonClient.onClose (connection-lifecycle listener)
- `onClose(listener: (info: DaemonCloseInfo) => void): Unsubscribe` — fires AT MOST ONCE, ONLY on an INVOLUNTARY disconnect (remote/network close or post-handshake transport error). A deliberate `close()` NEVER fires it. That is the seam long-lived listeners (like `observe`) use to distinguish "daemon went away" from "we tore down".
- `DaemonCloseInfo { code?: number; reason: string; error?: Error }`. reason = lastError?.message ?? `daemon connection closed (code N)`.
- Impl mechanics (policy-engine-style, in WebSocketDaemonClient): steady-state `ws.on('error')` now CAPTURES `this.lastError = err` (not no-op) so the message survives into reason; `ws.on('close', code => handleClose(code))` captures the WS code. `handleClose` rejects pending as before, then fires close listeners gated by `!this.closed && !this.closeNotified` (latch). `close()` sets `this.closed = true` BEFORE `ws.close()`, so the steady-state close handler's `!closed` guard suppresses the spurious onClose during deliberate teardown; `close()` also clears closeListeners.
- observe's involuntary-disconnect path (onClose) mirrors the OLD ws 'error'/'close' behavior: `sink.connectionLost(info.reason)`; TUI mode lets the TUI's own 3s exit timer manage shutdown (resolve, do NOT destroy); plain mode resolves. The `closing` flag guards double-resolve across cleanup()/onClose/subscribe-fail.

## RPC ErrorCodes (real, branch on these): WORKFLOW_NOT_AT_GATE, WORKFLOW_NOT_FOUND, INVALID_PARAMS, LINT_FAILED (data.diagnostics), ARTIFACT_NOT_FOUND. CLI-local strings (NOT in web-ui-types): DAEMON_NOT_RUNNING, AWAIT_TIMEOUT, DAEMON_START_TIMEOUT, WORKFLOW_DEFINITION_NOT_FOUND.

## Workflow RPC methods (src/web-ui/dispatch/workflow-dispatch.ts)
- `workflows.start{definitionPath,taskDescription,workspacePath?}` → `{workflowId}`. definitionPath must be ABSOLUTE (daemon does NOT resolve names; schema `z.string().min(1)`). Lint preflight: load failure → INVALID_PARAMS; lint failure → LINT_FAILED w/ `data.diagnostics`.
- `workflows.get{workflowId}` → WorkflowDetailDto. Top-level `phase` (LiveWorkflowPhase|PastRunPhase), `currentState` via getCurrentState, `round`, `gate?: HumanGateRequestDto` only when phase==='waiting_human'.
- `workflows.artifacts{workflowId,artifactName}` → `{files:[{path,content}]}`. Reads `.workflow/<name>/`.
- `workflows.resolveGate{workflowId,event,prompt?}` discriminated union on event. FORCE_REVISION/REPLAN require trimmed non-empty prompt (→ INVALID_PARAMS). WORKFLOW_NOT_AT_GATE if phase!='waiting_human'. Returns no payload.

## HumanGateRequestDto (src/workflow/types.ts:529): gateId, workflowId, stateName, acceptedEvents[], presentedArtifacts (NAMES only), summary. Gate summary = `Waiting for human review at <gateName>`. `buildGateRequest` only includes an artifact name if its dir EXISTS on disk → stub agent must actually write `.workflow/<name>/`.

## CRITICAL terminal/abort event vs phase mismatch (orchestrator.ts)
- gate ABORT → routes to `aborted` terminal → `handleWorkflowComplete` sets finalStatus.phase='aborted' (line ~2623) BUT ALWAYS emits lifecycle 'completed' (line ~2681) → forwarded as `workflow.completed`. So ABORT fires a COMPLETED event but getStatus phase is 'aborted'.
- RPC `workflows.abort` → `controller.abort()` emits lifecycle 'failed' (line ~1646) → `workflow.failed`, but getStatus phase is 'aborted'.
- => `await` must, on ANY terminal event (completed|failed) OR initial-get waiting_human OR gate_raised, do ONE authoritative `workflows.get` and branch on `phase`. Exit codes from phase: 0=waiting_human|completed; 3=failed|aborted; 4=await timeout. NEVER from event name.

## DI seam for integration test (workflow-manager.ts)
- `WorkflowManagerOptions` had no session-factory override; `createOrchestrator` hardcoded `createWorkflowSessionFactory()` (line ~326). Added optional `sessionFactoryOverride?: (opts: SessionOptions) => Promise<Session>` to options → used as `deps.createSession`. Type matches orchestrator `WorkflowOrchestratorDeps.createSession` (orchestrator.ts:422) and `createWorkflowSessionFactory` return.
- Wire integration test: real `WebUiServer` (port:0, mock ControlRequestHandler from test/web-ui-server.test.ts pattern) → `new WorkflowManager({eventBus: server.getEventBus(), baseDirOverride, sessionFactoryOverride})` → `server.setWorkflowManager(mgr)`. Stub returns `createArtifactAwareSession` (test/workflow/test-helpers.ts ~210) writing `draft` + `approvedResponse()` status block.
- Fixture: `settings.mode: builtin` (default is docker!) + `persona: global` → no Docker infra, no persona stubbing. Put under `test/workflow/fixtures/test-gate-smoke/workflow.yaml`, pass ABSOLUTE path as definitionPath.

## Integration-test race-closer (CONFIRMED via diagnostic)
- The builtin-mode stub workflow reaches the gate DURING the `workflows.start` RPC (events fire before `start` even resolves to the caller). A purely event-driven `waitForEvent('workflow.gate_raised')` AFTER `await start` DEADLOCKS (gate already raised). Fix in the test: `waitForGate` = subscribe-then-POLL `workflows.get` for `phase==='waiting_human'`, resolve on whichever lands first. Same for `waitForTerminal` (terminal reached during `resolveGate` RPC). This is exactly the "initial get closes the race" the `await` command implements.
- Confirmed the orchestrator+manager+WS path all work: `produce` (stub session writes `draft`, returns approvedResponse) → `gate_raised` event → WS broadcast → client receives all events incl gate_raised. Wiring was correct; only the test's await ordering was wrong.

## Command-layer integration test (drives runDaemonGateCommand, not DaemonClient)
- To exercise the REAL CLI entry `runDaemonGateCommand(subcommand,args)` against a live server, make `discoverDaemon()` find the test server: set `process.env.IRONCURTAIN_HOME` to a fresh `mkdtempSync` dir (beforeEach/boot) and WRITE `getWebUiStatePath()` with `{port: server.getPort(), host:'127.0.0.1', token: server.getAuthToken()}` (the exact `writeWebUiState` shape). `discoverDaemon()` re-reads the file every call (no caching) so writing once after boot suffices. Restore/delete IRONCURTAIN_HOME in afterEach.
- WebUiServer token is auto-generated (`randomBytes` in ctor); NOT a WebUiServerOptions field. Get it via `server.getAuthToken()`, port via `server.getPort()` (port:0 → OS-assigned, read post-`start()`).
- Booting WebUiServer/WorkflowManager writes a `config.json` into IRONCURTAIN_HOME ("Created default config at ..." log) — harmless, cleaned by rming the temp home.
- stdout capture LINT PITFALL: `vi.spyOn(process.stdout,'write').mockImplementation((chunk)=>...)` trips `@typescript-eslint/no-redundant-type-constituents` (write overload resolves the param to `any`) AND `no-unsafe-call` on the spy var. Existing repo spies use `mockImplementation(()=>true)` (no capture). To CAPTURE: swap `process.stdout.write` manually (`const original = process.stdout.write.bind(process.stdout); process.stdout.write = ((chunk:unknown)=>{...; return true}) as typeof process.stdout.write;`) and restore by reassigning `original` — sidesteps the any-typed overload entirely.
- Human text (stderr) leaks into the test runner console while JSON-only is captured on the stdout spy — that visible split IS the proof of the stdout/stderr separation contract.
- absolute `.yaml` path DOES resolve via `resolveWorkflowPath` (`YAML_EXTENSIONS` branch → `resolve(ref)` + existsSync), so `run [<absFixturePath>, task, --json]` works.

## CLI wiring
- `src/cli.ts` routes `workflow` → `src/workflow/workflow-command.ts` `main(args)`. Add run/status/await/gate/show cases to switch + help spec.
- `resolveWorkflowPath(ref)` in `src/workflow/discovery.ts` → `string|undefined` (client-side name→path resolution).
- `parseArgsStrict` in `src/workflow/cli-shared.ts` (exits on bad args). `CommandSpec`/`formatHelp` in `src/cli-help.ts`.
- `--ensure-daemon`: spawn `process.execPath` + cli entry (process.argv[1]) `['daemon','--web-ui']` detached, stdio ignore, unref. ARG ARRAY (no shell string). Poll discoverDaemon() ~15s → DAEMON_START_TIMEOUT.
