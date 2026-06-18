# Daemon WebSocket JSON-RPC surface (web UI + CLI clients)

Verified 2026-06-16 on branch feat/agent-driven-workflow-gates.

## Discovery file
- `~/.ironcurtain/web-ui.json` (NOT `web-ui-state.json`). Path = `getWebUiStatePath()` in `src/config/paths.ts` (`{home}/web-ui.json`).
- Contains `{ host, port, token }`. Written by daemon `writeWebUiState()` (`src/daemon/ironcurtain-daemon.ts`), removed on shutdown.
- Written ONLY when daemon started with `--web-ui`. Plain `ironcurtain daemon` = control socket (UDS) only, a different non-JSON-RPC protocol with NO workflow methods.

## WS surface
- `WebUiServer` (`src/web-ui/web-ui-server.ts`): host 127.0.0.1, port 7400 default (`--web-port`), WS path `/ws`, token `randomBytes(32).base64url`, maxPayload 1MB, ping 30s.
- Auth: HTTP `GET /ws/auth?token=` → `{"ok":true|false}`; WS upgrade carries `?token=`.
- Frames: req `{id,method,params}`; resp `{id,ok:true,payload}` | `{id,ok:false,error:{code,message,data}}`; event `{event,payload,seq}`.
- Wire types (reuse, don't redefine): `MethodName`, `RequestFrame`, `ResponseFrame`, `EventFrame`, `ErrorCode` in `src/web-ui/web-ui-types.ts`. `MethodName` is the central literal union of ALL valid methods.

## Dispatch (moved into subdir)
- `src/web-ui/json-rpc-dispatch.ts` is now a thin router → `src/web-ui/dispatch/{workflow,session,job,escalation,persona}-dispatch.ts` + `dispatch/types.ts`.
- `workflows.resolveGate` schema = discriminatedUnion on `event`; FORCE_REVISION/REPLAN require non-empty trimmed `prompt`. Handler checks `phase==='waiting_human'` else `WORKFLOW_NOT_AT_GATE`. Calls `controller.resolveGate(id,{type,prompt})`.

## Existing CLI WS client (NO reusable module yet)
- `src/observe/observe-command.ts` implements the WHOLE flow inline: `loadWebUiState()`, WS connect with `?token=`, `sendRpc()` id-correlation, response/event demux. This is the proven pattern to EXTRACT into a reusable client, not reinvent.
- `wsDataToString` shared leaf in `src/web-ui/ws-utils.ts`.

## Gate DTO gotcha
- `HumanGateRequestDto.presentedArtifacts` is artifact NAMES ONLY (`Array.from(map.keys())` in `toHumanGateRequestDto`, `src/workflow/types.ts`). To read content, call `workflows.artifacts(workflowId, artifactName)` per name. `summary` IS in the DTO.
- `WorkflowStatus` union (`types.ts`): `running|waiting_human|completed|failed|aborted`; only `waiting_human` carries `gate`.

## Gate events on the bus
- `WorkflowManager` (`src/workflow/workflow-manager.ts`) emits `workflow.gate_raised {workflowId,gate}` and `workflow.gate_dismissed {workflowId,gateId}` plus `workflow.started/state_entered/completed/failed/agent_*`. Event map in `src/web-ui/web-event-bus.ts`. Broadcast to all WS clients verbatim.
- Orchestrator gate API: `getStatus`, `getDetail`, `listActive`, `resolveGate(id, HumanGateEvent)`.

## Test boot pattern
- `test/web-ui-server.test.ts`: real `WebUiServer` on `port:0`, mock `ControlRequestHandler`, real `ws` client, sockets tracked + closed in afterEach. Use this to boot the WS surface in integration tests instead of a full daemon.
