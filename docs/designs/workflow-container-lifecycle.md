# Workflow-Scoped Docker Containers

## Implementation status

**Steps 1-5 shipped** on branch `feat/session-borrow-path` (PR: *"workflow shared-container mode"*). Steps 6-7 remain as follow-up work.

| Step | §9 entry | Status |
|------|----------|--------|
| 1 | PolicyEngine + AuditLog centralization | shipped (master, `30e7510`) |
| 2 | `DockerInfrastructure` bundle + `DockerAgentSession` ownership refactor | shipped (master, `be3bdce`) |
| 3 | Audit rotation + policy reload plumbing in the coordinator | shipped (master, `2d961d4`) -- see deviation D1 (rotate API dropped) |
| 4 | Session-side borrow path | shipped (branch, `963f793`) |
| 5 | Engine-owned workflow infrastructure | shipped (branch, `d53b017` + `9918ad7` + follow-ups) |
| 6 | Validation for `freshContainer` + `freshSession` | **pending** |
| 7 | Resume reclamation | **pending** |

Several concrete decisions diverged from this design during implementation. The most
load-bearing ones (single `audit.jsonl` with a `persona` field; consolidated
`workflow-runs/<id>/` layout; narrowed `PolicySwapTarget`; logger/audit retargeting
semantics; `validatePolicyDir` hardening) are summarized in the new
"Deviations from original design" section near the bottom of this document. The
proposal prose below is preserved as written so that the "what was planned vs.
what actually shipped" delta remains legible.

For the current on-disk layout and the canonical implementation description,
see `WORKFLOWS.md`, `src/trusted-process/CLAUDE.md`, and `src/docker/CLAUDE.md`.
Key code files: `src/workflow/orchestrator.ts`, `src/docker/docker-infrastructure.ts`,
`src/docker/docker-agent-session.ts`, `src/docker/code-mode-proxy.ts`,
`src/trusted-process/tool-call-coordinator.ts`,
`src/trusted-process/control-server.ts`, `src/config/paths.ts`,
`src/types/audit.ts`. End-to-end coverage lives in
`test/workflow-policy-cycling.integration.test.ts`.

## Overview

Today the workflow engine creates a fresh Docker container for every agent state it
enters. Each container must reinstall its own apt packages, rebuild caches, and
recompile any binaries the previous state produced. On a vuln-discovery run with
eight rounds, 80% of wall-clock time is spent redoing environment setup. This
design replaces per-state containers with **one container per workflow run**:
created when the workflow starts, reused by every agent state that follows, and
destroyed when the workflow reaches a terminal state. Instead of
`docker run`, each state's session `docker exec`s into the existing container.
Filesystem mutations -- installed packages, compiled artifacts, populated caches
-- persist across states. Security properties remain unchanged: every tool call
still passes through a `PolicyEngine` and every decision is appended to an audit
log, but after this design both responsibilities live in **one** place per
workflow run rather than being duplicated across N backend-server subprocesses.
Policy is reloaded at every state boundary (see section 5 below).

The design deliberately separates three orthogonal concerns that collapsed
together before: agent conversation continuity (`freshSession`), filesystem
continuity (the new workflow-scoped container), and policy continuity (the
new `loadPolicy` control operation). Each has a distinct lifecycle and a
distinct owner.

The revision history at the end of this document records the architectural
correction that landed in v2 -- the recognition that "the MCP proxy" is not a
single process but rather N subprocesses behind the Sandbox, and that the
`PolicyEngine` + `AuditLog` ownership must be lifted up to the Sandbox layer
before any of the workflow-level plumbing can safely attach. v4 settles the
UTCP integration story for the centralization refactor, tightens the placement
of argument validation / server-context updates / MITM control retention, and
specifies a coordinator-level tool-call mutex for parallel-state concurrency.

## 1. Current architecture

### Container lifecycle today

Every agent state creates a new container. The relevant chain:

1. `WorkflowOrchestrator.executeAgentState()` at `src/workflow/orchestrator.ts:751`
   builds `SessionOptions` and calls `deps.createSession(options)` at
   `src/workflow/orchestrator.ts:787`.
2. `createSession()` (`src/session/index.ts:52`) dispatches to
   `createDockerSession()` (`src/session/index.ts:145`) when `mode.kind === 'docker'`.
3. `createDockerSession()` calls `prepareDockerInfrastructure()`
   (`src/docker/docker-infrastructure.ts:74`), which starts the MITM and Code Mode
   proxies and resolves the image.
4. A new `DockerAgentSession` is constructed
   (`src/docker/docker-agent-session.ts:122`) and `initialize()`
   (`src/docker/docker-agent-session.ts:157`) runs `docker create` /
   `docker start` with `sleep infinity`
   (`src/docker/docker-agent-session.ts:357`). The container name is
   `ironcurtain-${shortId}` where `shortId` derives from the session ID.
5. On each `sendMessage()`, `DockerAgentSession.sendMessage()`
   (`src/docker/docker-agent-session.ts:427`) issues `docker exec` against
   its own container (line 451).
6. On `close()` (`src/docker/docker-agent-session.ts:545`) the container is stopped
   and removed, the proxies are stopped, and the per-session infrastructure is
   torn down.

The orchestrator tracks active sessions in `WorkflowInstance.activeSessions`
(`src/workflow/orchestrator.ts:205`). Between states, `executeAgentState()`
awaits `session.close()` implicitly via state transitions -- the session is
released once the state completes. (In practice, session closure is driven by
the outer orchestrator flow; the container dies at that point.)

### `freshSession` today

`AgentStateDefinition.freshSession` (`src/workflow/types.ts:134`) is a boolean
controlling whether the same *agent* session is reused across re-entries into
the same state. When `false`, `executeAgentState()` threads
`resumeSessionId: context.sessionsByState[stateId]` into `SessionOptions`
(`src/workflow/orchestrator.ts:784`). On the Docker side this triggers `claude
--continue` via the conversation state mount in `prepareConversationStateDir()`
(`src/docker/docker-infrastructure.ts:350`). **The Docker container itself is
still re-created** -- `freshSession: false` preserves the agent's conversation
history in a bind-mounted state directory, not the container's filesystem.

### Proxy process topology today (the original design got this wrong)

The earlier draft of this document assumed "the MCP proxy" was a single process
with a single `PolicyEngine`, a single `AuditLog`, and one place to attach a
control socket. That is not what the code does. The actual topology:

* **Sandbox orchestration point.** `Sandbox.initialize()` at
  `src/sandbox/index.ts:294` registers one entry in the UTCP `mcpServers` map
  **per backend MCP server** (`src/sandbox/index.ts:374-406`). Each entry's
  `command` + `args` points at `mcp-proxy-server.ts`; the per-entry `env`
  carries `SERVER_FILTER=<serverName>` so that subprocess connects to exactly
  one backend. An additional entry with `SERVER_FILTER=proxy` is registered
  when `MITM_CONTROL_ADDR` is set (virtual-only mode for domain management).
* **N proxy subprocesses.** Every entry in that map becomes its own child
  process, spawned by UTCP / the MCP SDK's stdio transport. For a workflow
  with `filesystem`, `git`, `memory`, plus the virtual `proxy` entry, there
  are four `mcp-proxy-server.ts` processes running simultaneously under the
  Sandbox.
* **Per-subprocess security primitives.** Each subprocess independently:
  * reads the same `AUDIT_LOG_PATH`, `GENERATED_DIR`, `PROTECTED_PATHS`,
    `ALLOWED_DIRECTORY` env vars (`src/trusted-process/mcp-proxy-server.ts:467`);
  * constructs its own `PolicyEngine` from the loaded artifacts
    (`src/trusted-process/mcp-proxy-server.ts:1120-1128`);
  * opens its own `AuditLog` appending to the shared file
    (`src/trusted-process/mcp-proxy-server.ts:1129`; `src/trusted-process/audit-log.ts:11-17`);
  * creates its own `CallCircuitBreaker` (line 1130) and `ApprovalWhitelist`
    (line 1400).
* **In-process mode** (`src/trusted-process/index.ts`) is the exception: one
  `TrustedProcess` instance owns a single `PolicyEngine`, `AuditLog`,
  `MCPClientManager`, and `ApprovalWhitelist`. This is what the proxy-mode
  topology should look like but today does not.

The implications:

* There is no "the proxy" to attach a control socket to. A naive UDS at
  `mcp-proxy-control.sock` inside `main()` would be bound by whichever
  subprocess won the race, or by all of them if each picked a unique path --
  neither is useful.
* A `loadPolicy` command would have to fan out to every subprocess and be
  ack'd by every subprocess to guarantee no state ran under a stale engine.
  That is a multi-writer coordination problem with no clean solution (e.g.,
  what if the filesystem subprocess acks but the git subprocess crashes
  mid-reload?).
* All N subprocesses today write into the same `AuditLog` file descriptor
  from different processes. Node's `WriteStream` `{ flags: 'a' }` relies on
  POSIX `O_APPEND` atomicity, which holds for short writes (< `PIPE_BUF`,
  typically 4 KiB) but is not guaranteed for longer JSONL lines containing
  large `result.content`. Interleaved writes are already a latent hazard.
  Rotating the file across N processes makes this worse, not better.

This is why section 2 introduces a refactor **before** any workflow-specific
plumbing: lift `PolicyEngine` + `AuditLog` up into the Sandbox / CodeModeProxy
layer so there is one canonical instance per workflow run, and turn the
subprocesses into thin tool routers.

### Audit log today

The audit log path comes from `AUDIT_LOG_PATH` (`src/trusted-process/mcp-proxy-server.ts:468`),
resolved by `getSessionAuditLogPath()` (`src/config/paths.ts:72`) to
`~/.ironcurtain/sessions/{sessionId}/audit.jsonl`. `AuditLog`
(`src/trusted-process/audit-log.ts:11-17`) opens a single `WriteStream` with flag
`'a'` in its constructor and holds it for the life of the process. There is no
mechanism to rotate to a new file. Entries have the schema defined in
`src/types/audit.ts` -- attribution is carried by fields inside each entry,
but session/persona/version attribution is absent because the proxy only
serves a single session today.

### Workflow container naming

`DockerContainerConfig.sessionLabel` (`src/docker/docker-manager.ts:68`)
attaches `ironcurtain.session=<id>` to every container at `docker create` time.
There is no corresponding workflow-level label.

## 2. Proposed architecture

The proposal has two parts that land in order:

**Part A -- Centralization refactor (prerequisite, §2.1).** Move `PolicyEngine`
and `AuditLog` ownership out of `mcp-proxy-server.ts` and up to the Sandbox /
CodeModeProxy layer. After this refactor, a Code Mode session has exactly one
`PolicyEngine` and one `AuditLog` regardless of how many backend MCP servers
it speaks to. The subprocesses become tool routers -- they still own the MCP
client connection to their backend, but they no longer make policy decisions
or write audit entries. This is the mechanical prerequisite to having any
single place on which a control socket can attach.

**Part B -- Workflow container (§2.2).** Introduce a workflow-scoped container
that spans all agent states within a single workflow run. The engine creates it
once and reuses it for every state that follows. `DockerAgentSession.initialize()`
skips the `docker create` path entirely when a workflow container is supplied;
its `sendMessage()` still issues `docker exec`, now against the shared
container.

### 2.1 PolicyEngine + AuditLog centralization

#### Structural change

Before:

```
Sandbox
├── UTCP Code Mode (V8 isolate)
│     tool call via stdio
│            ▼
├── mcp-proxy-server subprocess #1 (SERVER_FILTER=filesystem)
│       ├── PolicyEngine (copy 1)
│       ├── AuditLog (copy 1, appends to shared file)
│       ├── CallCircuitBreaker
│       ├── ApprovalWhitelist
│       └── MCP Client → filesystem backend
├── mcp-proxy-server subprocess #2 (SERVER_FILTER=git)
│       ├── PolicyEngine (copy 2)
│       ├── AuditLog (copy 2, appends to shared file)
│       ├── CallCircuitBreaker
│       ├── ApprovalWhitelist
│       └── MCP Client → git backend
├── mcp-proxy-server subprocess #3 (SERVER_FILTER=memory)
│       └── ...
└── mcp-proxy-server subprocess #4 (virtual, SERVER_FILTER=proxy)
```

After:

```
Sandbox / CodeModeProxy (host process)
├── UTCP Code Mode (V8 isolate)
│     tool call routed via UTCP's 'ironcurtain' call-template
│     (in-process; no stdio, no subprocess hop to reach policy)
│            ▼
├── ToolCallCoordinator (new, host-side)
│       ├── IronCurtainCommunicationProtocol (UTCP hook)
│       ├── PolicyEngine         (single instance)
│       ├── AuditLog              (single instance, single writer)
│       ├── CallCircuitBreaker    (single instance)
│       ├── ApprovalWhitelist     (single instance)
│       ├── ServerContextMap      (single instance)
│       ├── Tool-call mutex       (serializes handleToolCall invocations)
│       ├── Policy mutex          (serializes loadPolicy vs. everything)
│       └── MCPClientManager      (spawns and talks to the subprocesses below)
│                 │  stdio + MCP
│                 ▼
├── mcp-proxy-server subprocess #1 (SERVER_FILTER=filesystem)   ← tool router
│       └── MCP Client → filesystem backend
├── mcp-proxy-server subprocess #2 (SERVER_FILTER=git)          ← tool router
│       └── MCP Client → git backend
├── mcp-proxy-server subprocess #3 (SERVER_FILTER=memory)       ← tool router
│       └── MCP Client → memory backend
└── mcp-proxy-server subprocess #4 (virtual, SERVER_FILTER=proxy)
        └── Still receives MITM_CONTROL_ADDR (its tools IPC to MITM)
```

The Sandbox is the natural home for `ToolCallCoordinator`. The two entry
points into the Sandbox (`Sandbox.initialize()` for builtin Code Mode and
`CodeModeProxy` for Docker Agent Mode) both construct a `Sandbox` instance
up-front; co-locating the coordinator there means both modes share the
same single-engine / single-audit topology without additional plumbing.

The coordinator's surface area is essentially the union of
`handleCallTool` / `handleToolCall` (see below, "What moves").

#### What moves

From `mcp-proxy-server.ts` (currently in `main()` around lines 1086-1134,
and within `handleCallTool` lines 686-1049) to the new coordinator in the
Sandbox layer:

* `loadGeneratedPolicy()` call + artifact parsing (lines 1104-1108).
* `new PolicyEngine(...)` construction (line 1120).
* `new AuditLog(auditLogPath, ...)` construction (line 1129).
* `new CallCircuitBreaker()` construction (line 1130).
* `createApprovalWhitelist()` (line 1400).
* `ServerContextMap` (the local Map at the handler site, line 1387).
* Auto-approver model construction (`createAutoApproveModel`, lines 1132
  and 393) including its dependency on `AUTO_APPROVE_MODEL_ID` /
  `AUTO_APPROVE_API_KEY` env vars.
* Whitelist candidate and escalation logic -- the whole flow from
  `policyEngine.evaluate()` through `waitForEscalationDecision()` to the
  audit write (`mcp-proxy-server.ts:795-960`).
* Argument normalization (`prepareToolArgs`) and git enrichment (the
  `toolInfo.serverName === 'git'` branch at `mcp-proxy-server.ts:759-785`).
* **Schema-based argument validation** (`validateToolArguments` against
  `inputSchema`, `mcp-proxy-server.ts:720`). This moves because it is
  coupled to two coordinator-owned concerns: (a) the "trusted servers"
  check (`policyEngine.isTrustedServer(...)`) skips validation for trusted
  servers -- that predicate lives on the coordinator's `PolicyEngine`
  instance; (b) on validation failure the subprocess currently synthesizes
  an audit entry with `policyDecision.status === 'deny'` and rule
  `'invalid-arguments'` (lines 722-731), which is semantically a
  policy-gate failure and therefore belongs where the rest of the policy
  gate lives. Keeping it in the subprocess would require re-plumbing
  `isTrustedServer` back down and duplicating audit logic; moving it up
  keeps "all policy-gate outcomes are emitted from one place" invariant.
  The subprocess receives already-validated argument shapes.
* **`ServerContext` post-success update** (`updateServerContext`,
  `mcp-proxy-server.ts:1034`). This fires after a successful tool response
  (e.g., it mirrors `git_set_working_dir` / `git_clone` into the map so
  later calls can enrich escalation prompts and fill in implicit `path`
  args). In the coordinator, this is the *post-call* step that runs after
  the tool-router subprocess returns a successful result and before the
  coordinator returns to UTCP. See the ordering spec below.

The coordinator's `handleToolCall` runs two bands of logic around the
subprocess dispatch:

```
            ┌──────────────── pre-call (policy gate) ─────────────────┐
handleToolCall(request):
  1. Look up annotation via policyEngine.getAnnotation(server, tool, args).
     If missing AND not trusted → audit deny, return.
  2. If NOT trusted server: validateToolArguments(rawArgs, inputSchema).
     On failure → audit { policyDecision: deny, rule: "invalid-arguments" },
     return.                                                          (B1.1)
  3. Normalize args: prepareToolArgs(...) produces {argsForTransport,
     argsForPolicy}. Git-path enrichment branch runs here, reading
     serverContextMap for git_set_working_dir / git_clone state.
  4. policyEngine.evaluate(request{args: argsForPolicy}).
  5. Apply auto-approve / whitelist / circuit breaker / human escalation
     (serialized with respect to each other -- see B3 below).
  6. auditLog.log(entry) with policyDecision + request.              (audit-first
     The audit entry is written BEFORE the outbound MCP call when the       policy)
     decision is a deny or a pre-flight error, and AFTER the MCP call
     returns when the decision is allow (the audit row carries `result`
     and `durationMs`). This preserves today's semantics exactly
     (cf. `logAudit` at `mcp-proxy-server.ts:819`, called with the
     realized result/duration). Deny / validation-error paths call
     logAudit with durationMs=0 before any subprocess dispatch.
  7. If not allowed, return the deny/escalation-denied result.

            ┌─────────── subprocess dispatch (tool router) ───────────┐
  8. await mcpManager.callTool(serverName, toolName, argsForTransport).

            ┌──────────────── post-call (bookkeeping) ────────────────┐
  9. If result.isError → logAudit({status:'error',...}), return result.
 10. updateServerContext(serverContextMap, server, tool, argsForTransport).
                                                                      (B1.2)
 11. logAudit({status:'success'}, Date.now()-startTime).
 12. Return rewrittenContent.
```

Ordering invariants:

* Step 2 (validation) strictly precedes step 4 (policy evaluation) --
  `prepareToolArgs` assumes a well-formed argument shape.
* Step 6 (audit write for deny / pre-call failure) happens before any
  early return; step 11 (audit write for success) happens after the
  MCP dispatch completes. This mirrors today's dual-write pattern and
  is the reason step 6 is described as "both before and after depending
  on decision" rather than strictly first.
* Step 10 (server-context update) runs **only** on `result.isError ===
  false`. A failed git call must not mutate the working-directory
  cache.

What stays in each `mcp-proxy-server` subprocess:

* MCP client transport setup (stdio, `StdioClientTransport`).
* OAuth credential injection and `TokenFileRefresher`
  (`mcp-proxy-server.ts:1165-1246`). These are keyed by server name and
  best-kept co-located with the outbound connection.
* Sandbox-runtime (srt) wrapping of the backend command
  (`wrapServerCommand`, `writeServerSettings` etc.).
* `ListToolsRequestSchema` / `CallToolRequestSchema` handlers -- but the
  `CallTool` handler becomes a pure forward: receive the call, dispatch to
  the real backend client, return the raw result. No policy evaluation, no
  audit write, no schema validation, no server-context update.
* **Virtual-only mode with `MITM_CONTROL_ADDR`.** The `SERVER_FILTER=proxy`
  subprocess still hosts the `add_proxy_domain` /
  `remove_proxy_domain` / `list_proxy_domains` tools whose
  implementation calls the MITM control API via `ControlApiClient`
  (`mcp-proxy-server.ts:1360-1368`, `src/docker/proxy-tools.ts:231-237`,
  MITM handlers at `src/docker/mitm-proxy.ts:1112-1144`). The MITM
  control socket / TCP address is **not** the same thing as the new
  coordinator control socket (§4), and it is **not** the same thing
  as the subprocess's outbound MCP connection -- it is a per-tool
  IPC channel that the virtual-proxy tools use from inside the
  subprocess. Because of this, `MITM_CONTROL_ADDR` continues to be
  set on the virtual-proxy subprocess env only (as today at
  `src/sandbox/index.ts:402`). The invariant to retain: exactly one
  subprocess receives `MITM_CONTROL_ADDR`, and it is the same one
  with `SERVER_FILTER=proxy`. No `MITM_CONTROL_ADDR` appears anywhere
  else in the spawn environment.

Note on terminology: "no control socket lives in the subprocess" refers
specifically to the new coordinator control socket (the UDS/HTTP
endpoint for `loadPolicy`, §2.2 and §4). It does **not** mean the
subprocess is free of all control-channel env vars. `MITM_CONTROL_ADDR`
and `SESSION_LOG_PATH` are retained; `AUDIT_LOG_PATH` is removed (see
§9 "Proxy env vars").

In short: the subprocess becomes the equivalent of what `MCPClientManager`
already does for in-process mode. Which brings us to:

#### Unifying the two modes via `MCPClientManager`

`src/trusted-process/mcp-client-manager.ts:23` already implements a clean
abstraction over "spawn an MCP server, connect a client, expose
`callTool(name, args)` and `listTools()`". In-process `TrustedProcess`
already uses it directly (`src/trusted-process/index.ts:106`).

The refactor should make the Sandbox use a variant of this manager too --
one entry per backend server, each driving an MCP client connection. The
subprocess-per-server approach is still valuable for isolation (OAuth token
handling, srt sandbox wrapping, stdio lifetime), so the Sandbox's manager
wraps a stdio client that talks to `mcp-proxy-server.ts` in a stripped-down
"pass-through" mode. The subprocess is effectively a sandbox-runtime /
OAuth-credential shim around the real backend. The coordinator sits above
the manager and owns policy + audit.

Concretely:

* `MCPClientManager` grows a `callTool(serverName, toolName, args)` method
  if it does not already have one (it already supports `listTools`).
* The Sandbox's `ToolCallCoordinator.handleToolCall(request)` runs the
  full policy + audit logic, then calls `mcpManager.callTool(...)` when
  the decision is allow.
* UTCP Code Mode's generated `execute_code` layer, which today routes tool
  calls to the subprocess via UTCP's MCP call-template, instead routes to
  the coordinator via an in-process UTCP communication protocol registered
  by IronCurtain. The coordinator routes out to the subprocess through
  `MCPClientManager`. UTCP's existing `mcpServers` registration at
  `src/sandbox/index.ts:408-412` (`registerManual` with
  `call_template_type: 'mcp'`) changes: instead of N stdio servers,
  the sandbox registers **one** virtual UTCP manual whose `callTool`
  hook is the coordinator itself. The subprocesses still exist, but
  they are spawned by the coordinator's `MCPClientManager` rather than
  by UTCP.

#### UTCP integration: direct in-process hook (spike confirmed)

**Spike outcome: direct hook is feasible. No bridge subprocess is needed.**

The UTCP SDK (`@utcp/sdk`, installed at
`node_modules/@utcp/sdk/dist/index.d.ts`) exposes
`CommunicationProtocol` as a public abstract class with exactly four
required methods -- `registerManual`, `deregisterManual`, `callTool`,
`callToolStreaming` -- plus an optional `close`. Registration is a
two-line mutation of two static registries, used by `@utcp/mcp` itself:

```typescript
// From node_modules/@utcp/mcp/dist/index.js, register():
CallTemplateSerializer.registerCallTemplate(
  'mcp', new McpCallTemplateSerializer(), override
);
CommunicationProtocol.communicationProtocols['mcp'] =
  new McpCommunicationProtocol();
```

IronCurtain can mirror this pattern: define a new call template type
`'ironcurtain'` with a trivial serializer, implement
`IronCurtainCommunicationProtocol extends CommunicationProtocol` whose
`callTool(caller, toolName, toolArgs, toolCallTemplate)` synchronously
(relative to UTCP) invokes `coordinator.handleToolCall({ serverName,
toolName, arguments: toolArgs, ... })`, and register both under the
static maps. The coordinator and UTCP then share the host Node process
-- no stdio, no IPC, no subprocess between the agent's tool call and
the policy gate.

**Data path (the spike-confirmed design):**

```
UTCP Code Mode (V8 isolate)
    tool call hits a bridged function stub
          │  (UTCP in-isolate bridge, unchanged)
          ▼
UtcpClient (host side) resolves the tool's call template
          │
          ▼
CommunicationProtocol.communicationProtocols['ironcurtain']
    .callTool(caller, toolName, toolArgs, template)
          │  (in-process, same Node thread)
          ▼
IronCurtainCommunicationProtocol.callTool(...)
          │  adapts UTCP's (toolName, toolArgs) into a ToolCallRequest
          ▼
ToolCallCoordinator.handleToolCall(request)
          │  (pre-call band: validate → normalize → policy → audit,
          │   with the tool-call mutex held -- see B3 below)
          ▼
MCPClientManager.callTool(serverName, toolName, argsForTransport)
          │  (MCP SDK Client → StdioClientTransport)
          ▼
mcp-proxy-server subprocess (tool-router mode)
          │  (transparent relay: call the real backend, return raw result)
          ▼
result travels back up the same path; coordinator runs the post-call
band (server-context update on success, audit log on every outcome)
before UTCP receives the return value.
```

Tool discovery follows the same shape: during
`IronCurtainCommunicationProtocol.registerManual`, the protocol asks the
coordinator for its aggregated tool list (the coordinator already owns
the `MCPClientManager` that enumerates every backend's tools). UTCP
registers those tools under the single manual; the existing name
aliasing / namespace / help logic in `src/sandbox/index.ts:444-500` is
unchanged because it operates on UTCP's post-registration tool list,
which the new protocol still produces.

Concretely for `src/sandbox/index.ts:361-412`:

* The per-backend `mcpServers` record-building loop (lines 361-406) is
  deleted. Both the regular backend entries and the virtual-proxy
  `mcpServers['proxy']` entry (lines 394-406) go away from this
  callsite -- but the virtual-proxy subprocess itself is still spawned,
  just by the coordinator's `MCPClientManager` instead of by UTCP.
* The `registerManual` call (line 408-412) changes to:
  ```typescript
  const registration = await this.client.registerManual({
    name: 'tools',
    call_template_type: 'ironcurtain',
    // coordinator reference is carried via the call-template config;
    // the in-process protocol reads it back in callTool().
    config: { coordinator: this.coordinator },
  });
  ```
* A one-time side-effect import (or explicit `register()` call) in
  `Sandbox.initialize()`, analogous to the `import '@utcp/mcp'` on
  `src/sandbox/index.ts:12`, installs the `'ironcurtain'` protocol into
  UTCP's static maps. It is safe to call `register()` multiple times
  because it is idempotent.

#### Protocol between subprocess and coordinator

**Unchanged: stdio + MCP.** The subprocesses continue to speak standard MCP
(Initialize, ListTools, CallTool, etc.) over stdio. The coordinator's
`MCPClientManager` drives them with the MCP SDK's `Client` class, exactly
as `TrustedProcess` does today. No new wire protocol is needed -- we're
reusing the one that already works.

The protocol is:

* Subprocess -> coordinator: standard MCP responses (tool lists, tool
  results, errors).
* Coordinator -> subprocess: standard MCP requests (`tools/list`,
  `tools/call`).
* Policy decisions, audit entries, approval whitelist matches, circuit
  breaker verdicts: **never cross the boundary**. They live entirely in
  the coordinator process. The subprocess has no `PolicyEngine` instance
  and no `AuditLog` instance.

This keeps the protocol simple and eliminates the "who computes policy"
ambiguity entirely. The subprocess's only responsibility is "dispatch MCP
calls to the real backend and forward the result." That is narrow enough
to make its failure modes easy to reason about (see §2.1.5).

Note on the coordinator ↔ UTCP boundary: this is *not* MCP. UTCP calls
`IronCurtainCommunicationProtocol.callTool` directly as a JavaScript
method in the host process; the coordinator returns a plain result
object. Only the coordinator ↔ subprocess boundary uses MCP over
stdio. This gives us two narrow interfaces (UTCP API upward; MCP SDK
downward) with the policy gate precisely in between.

#### CallCircuitBreaker and ApprovalWhitelist: centralize too

Both move to the coordinator. Rationale:

* **CallCircuitBreaker.** Its job is to detect "same tool+args called
  repeatedly in a short window." Today, each subprocess has its own window
  on its own server's calls, so the threshold effectively applies
  per-server. That's fine in practice (a filesystem runaway doesn't
  interact with a git runaway), but it's an accidental property. After
  centralization the breaker sees all calls and can apply a consistent
  threshold across the whole session. No behavioral regression expected;
  the threshold constants stay the same.
* **ApprovalWhitelist.** Already session-scoped by design. The current
  per-subprocess split means a user approving a filesystem escalation
  cannot have that approval match a git escalation -- but today this does
  not come up because each whitelist pattern is keyed by `(server, tool,
  args)` anyway. Centralizing is pure cleanup: one less duplicated
  in-memory store, one less place for subtle divergence.
* **ServerContextMap.** Already needs to be consistent across
  backend-server subprocesses when, e.g., `git_set_working_dir`'s
  effect is read by a later `git_status` call. Today those land in
  different in-process maps because the git subprocess is the only one
  that sees git calls, but the broader pattern (reading across servers)
  is already on the horizon and centralization is the right shape.

#### Concurrency / thread-safety of the centralized engine

Node.js single-threaded model applies: `PolicyEngine.evaluate()` is
synchronous, so concurrent tool calls queue on the event loop. The
coordinator's `handleToolCall` is `async`, with the following awaited
interleaving points:

* `await escalation` (human approval) -- the engine has already produced
  a decision; the `await` is waiting for the human, not for the engine.
* `await auditLog.log()` (if rotation is in progress -- see §4).
* `await mcpManager.callTool(...)` (backend request out).

`PolicyEngine.evaluate()` itself is stateless w.r.t. call inputs -- it
reads `compiledPolicy`, `annotationMap`, `protectedPaths`, etc., all
immutable after construction, and returns a verdict synchronously. Two
parallel calls to `evaluate()` cannot corrupt each other.

However, three coordinator-owned caches **are** read-modify-write and
will race under genuinely concurrent `handleToolCall` invocations:

1. **`ApprovalWhitelist`** (`src/trusted-process/approval-whitelist.ts`) --
   session-scoped in-memory set of approved patterns. Each
   `handleToolCall` reads it (`match`) and may append to it (`add`)
   when a user approves an escalation. Interleaved add/match between
   two concurrent calls could drop an approval or double-apply it.
2. **`CallCircuitBreaker`** (`src/trusted-process/call-circuit-breaker.ts`) --
   sliding-window counter keyed by `(tool, argsHash)`. Each call
   mutates the window. Two concurrent calls to the same tool could
   both see "under threshold" and both proceed past the limit.
3. **`ServerContextMap`** (`src/trusted-process/server-context.ts`) --
   mutated on success (step 10 of `handleToolCall`, see
   `mcp-proxy-server.ts:1034`) and read during git-path enrichment
   (step 3, see `mcp-proxy-server.ts:759-785`). A concurrent git call
   could enrich off a stale working-directory cache while another
   call is mid-update.

Parallel workflow states are **not a future feature**. `parallelKey` is
already in the codebase at `src/workflow/types.ts:121` and
`src/workflow/validate.ts:33`, and workflows such as vuln-discovery are
free to use it today. Two parallel agent states that share a persona
will share the `DockerInfrastructure` bundle and therefore share the
single `ToolCallCoordinator`; they can issue `handleToolCall`
concurrently from independent `docker exec` sessions into the same
container.

**Decision: add a coordinator-level tool-call mutex.**

The coordinator carries two distinct mutexes:

* **Policy mutex.** Serializes `loadPolicy` against all other
  coordinator operations. Held only during the policy swap window
  (close audit stream, recompute paths, open new audit stream, replace
  `PolicyEngine` reference). Short-lived; does not cover tool calls.
* **Tool-call mutex.** Serializes concurrent `handleToolCall`
  invocations against each other. Held for the full pre-call band
  through post-call band of one `handleToolCall` (steps 1-11 above).
  This is what protects `ApprovalWhitelist`, `CallCircuitBreaker`, and
  `ServerContextMap` from the read-modify-write race; it also ensures
  audit entries for two concurrent calls land as two contiguous JSONL
  records rather than one per process.

`loadPolicy` effectively acquires both mutexes in sequence: it waits
for the tool-call mutex to be free (no tool call in flight), then
takes the policy mutex, then does the swap. The tool-call mutex is
therefore sufficient to rule out "a `handleToolCall` started under
policy A and finished under policy B."

**Performance implication.** Parallel tool calls from
parallel-homogeneous states serialize through the coordinator. This
is acceptable: each tool call is already IO-bound (MCP round trip,
subprocess dispatch, and possibly human escalation) and often
inherently serial on the workflow container's shared filesystem, so
mutex overhead is dominated by the wait on the in-flight call. The
practical delta vs. today (where two parallel states run as two
independent Code Mode sandboxes, each with its own subprocess set)
is that tool calls now interleave at call granularity rather than at
byte-stream granularity -- but because the previous architecture
already shared backend state (git working directory, filesystem
contents), the observable behavior for mutating tools was already
effectively sequential. The mutex makes that implicit ordering
explicit and race-free.

Two scoping options for the tool-call mutex; v1 chooses A:

* **Option A (simpler, chosen for v1).** Hold the tool-call mutex
  for the *entire* `handleToolCall` body including the awaited
  backend dispatch. Conservatively safe; all three caches are read
  or written both before and after the MCP dispatch
  (`ServerContextMap` in particular is mutated post-success in step
  10). For parallel states running the same persona, this matches
  the existing de facto contract -- they share a container and
  therefore a filesystem; true in-flight parallelism is already
  unsafe for most mutating tools and would produce nondeterministic
  results regardless of the mutex.
* **Option B (optimized, deferred).** Release the tool-call mutex
  just before `await mcpManager.callTool(...)` and re-acquire it
  for the post-call band (`updateServerContext` + audit-success).
  This allows backend calls to overlap across parallel states.
  Cost: the coordinator must track which in-flight call is which,
  and the post-call re-acquisition must be fair (naive re-acquire
  could starve). Not worth the complexity in v1; revisit if
  parallel-homogeneous workflows become common and profiling shows
  mutex contention is a bottleneck.

**Parallel heterogeneous personas remain rejected.** A `loadPolicy`
cannot atomically swap policy "between" two concurrent tool calls --
call A might finish under persona X's policy while call B finishes
under persona Y's policy, producing an incoherent audit record.
Reject at one of two layers:

* **Schema-level check (preferred).** `validateDefinition()` in
  `src/workflow/validate.ts` already iterates state definitions; add
  a cross-field check that any group of agent states sharing a
  `parallelKey` must also share a `persona` (falling back to the
  inherited persona if any state omits it). Reject at workflow-load
  time with a clear error pointing at the offending states.
* **Coordinator error (fallback).** If the schema check is
  bypassed or a future runtime path constructs parallel states
  programmatically, `loadPolicy` detects a mismatched persona/version
  against the currently-running cycle and fails fast with a
  structured error. The engine treats that as a workflow-level fatal.

Both layers land together; the schema check catches static
misconfiguration at load time; the coordinator error closes the
loophole at runtime.

### 2.2 Workflow container

The four layers that change below reference the *post-centralization*
architecture. Each assumes §2.1 has already landed.

#### Engine (`src/workflow/orchestrator.ts`)

The orchestrator holds a single `DockerInfrastructure` bundle per workflow
run, alongside workspace and checkpoint store. Its lifecycle:

- **Create** on `start()` / `resume()` (if the workflow uses a Docker
  agent), via `createDockerInfrastructure({ workflowId, ... })`.
- **Reuse** on every agent state that doesn't set `freshContainer: true`.
  Each state's `DockerAgentSession` receives the same bundle with
  `ownsInfra=false`.
- **Destroy** on any terminal state transition, on `abort()`, and on
  `shutdownAll()`, via `destroyDockerInfrastructure(infra)`.

The engine also triggers a **policy cycle** at every agent state transition,
unconditionally, before `executeAgentState()` creates the session. This
cycles the audit log filename (incrementing the per-persona version counter)
and instructs the coordinator (reachable via `infra.proxy.getCoordinator()`
or through the workflow-scoped control socket) to reload
`compiled-policy.json` from the persona's policy directory.

#### Session (`src/session/types.ts` and `src/session/index.ts`)

`SessionOptions` gains a new optional field `workflowInfrastructure` of
type `DockerInfrastructure`. When set, `createDockerSession()` skips the
internal `createDockerInfrastructure()` call and constructs a
`DockerAgentSession` with `ownsInfra=false`, borrowing the caller's
bundle. When unset (the standalone / interactive case),
`createDockerSession()` creates its own bundle and constructs the session
with `ownsInfra=true`. There is no "exec-only vs. full" construction
mode inside the session -- the class body is identical in both cases, and
the only divergence is who destroys the infrastructure on `close()`.

#### Docker adapter (`src/docker/`)

`DockerAgentSession` moves from "holds every Docker handle as its own field
and destroys all of them on `close()`" to "holds a single infrastructure
bundle plus a flag that says whether to destroy it." The bundle is the same
object regardless of who created it; the flag is what differs between
standalone and workflow modes.

##### The `DockerInfrastructure` bundle

All workflow-level Docker resources -- container, sidecar, internal network,
MITM proxy, Code Mode proxy (and its contained `ToolCallCoordinator`,
`MCPClientManager`, subprocesses), CA, and fake keys -- are grouped into one
typed object. There is a paired factory and destroyer:

```typescript
interface DockerInfrastructure {
  readonly containerId: string;
  readonly containerName: string;
  readonly sidecarContainerId?: string;    // TCP mode only (macOS)
  readonly internalNetwork?: string;       // TCP mode only (macOS)
  readonly proxy: DockerProxy;             // CodeModeProxy; owns the coordinator
  readonly mitmProxy: MitmProxy;
  readonly docker: DockerManager;
  readonly ca: CertificateAuthority;
  readonly fakeKeys: ReadonlyMap<string, string>;
  readonly useTcp: boolean;
  readonly adapter: AgentAdapter;
  readonly image: string;
  readonly systemPrompt: string;
  readonly mitmAddr: { socketPath?: string; port?: number };
  readonly authKind: 'oauth' | 'apikey';
  readonly conversationStateDir?: string;
  readonly conversationStateConfig?: ConversationStateConfig;
  // ... plus the sessionDir / sandboxDir / escalationDir / auditLogPath
  //     paths already carried by today's DockerInfrastructure type
}

async function createDockerInfrastructure(opts: InfraOpts): Promise<DockerInfrastructure>;
async function destroyDockerInfrastructure(infra: DockerInfrastructure): Promise<void>;
```

The field names above are approximations -- the exact shape reconciles with
the existing `DockerInfrastructure` type already exported from
`src/docker/docker-infrastructure.ts:36-61` (see the rename/refactor note
immediately below). The interface is readonly: once assembled, the bundle
is never mutated.

##### `prepareDockerInfrastructure()` → `createDockerInfrastructure()`

A function by essentially this name already exists at
`src/docker/docker-infrastructure.ts:74` and already returns a
`DockerInfrastructure` interface declared at the top of that same file
(lines 36-61). Today's version:

- Starts the MITM proxy and the Code Mode proxy (lines 216-242).
- Loads or creates the CA, generates fake keys, resolves the MCP image
  (lines 132-213 and 267-268).
- Builds orientation and the system prompt (lines 247-264).
- **Does not** start the container; `DockerAgentSession.initialize()` does
  that today.

The refactor is *almost* a rename plus one new responsibility:

1. **Rename** `prepareDockerInfrastructure` → `createDockerInfrastructure`
   and move the container creation (`docker create` + `docker start` with
   `sleep infinity`, plus the sidecar and internal network for TCP mode) out
   of `DockerAgentSession.initialize()` (currently at
   `src/docker/docker-agent-session.ts:219-399`) and into this function.
   After this step, callers receive a bundle where the container is already
   running.
2. **Extend** the returned `DockerInfrastructure` with `containerId`,
   `containerName`, `sidecarContainerId?`, and `internalNetwork?`. The
   existing fields (`proxy`, `mitmProxy`, `ca`, `fakeKeys`, `systemPrompt`,
   etc.) stay.
3. **Introduce** the companion `destroyDockerInfrastructure(infra)` function
   containing the seven teardown steps currently performed unconditionally
   by `DockerAgentSession.close()` at
   `src/docker/docker-agent-session.ts:545-561`: `cleanupContainers()`
   (which handles the main container, the optional sidecar, and the
   internal network), `mitmProxy.stop()`, and `proxy.stop()`. Same code,
   different home.

The return-shape restructuring is small: the existing bundle picks up four
new fields. No existing field is removed. Callers that don't care about
the new fields are unaffected.

##### Session refactor

After the rename/refactor above, `DockerAgentSession` owns no Docker
resources of its own. It is a thin harness that holds a reference to the
infrastructure bundle, plus session-scoped watchers:

```typescript
class DockerAgentSession {
  constructor(
    private readonly infra: DockerInfrastructure,
    private readonly ownsInfra: boolean,
    // ... rest of session config: sessionId, sessionDir, sandboxDir,
    //     escalationDir, auditLogPath, agentModelOverride, callbacks, etc.
  ) {}

  async initialize() {
    // docker exec into infra.containerId; start claude process; wire up
    // the escalation watcher and audit tailer. No docker create, no proxy
    // startup -- those are the bundle's responsibility.
  }

  async close() {
    this.escalationWatcher?.stop();
    this.auditTailer?.stop();
    // No docker stop/remove, no proxy shutdown. Session is done; the
    // infrastructure is someone else's problem -- unless we own it.
    if (this.ownsInfra) {
      await destroyDockerInfrastructure(this.infra);
    }
  }
}
```

The session's existing private fields for `docker`, `proxy`, `mitmProxy`,
`ca`, `fakeKeys`, `containerId`, `sidecarContainerId`, `networkName`,
`useTcp`, `systemPrompt`, `conversationStateDir`, and
`conversationStateConfig` all collapse into accessing `this.infra.*`.
`DockerAgentSessionDeps` loses those fields in favor of a single
`infra: DockerInfrastructure` plus `ownsInfra: boolean`.

##### Two call sites, one class

**Standalone (today's behavior, factory-paired):** `createDockerSession()`
in `src/session/index.ts:145` creates the infrastructure and the session
back-to-back, and the session owns everything:

```typescript
const infra = await createDockerInfrastructure(opts);
const session = new DockerAgentSession(infra, /*ownsInfra=*/ true, ...);
await session.initialize();
return session;
// session.close() → destroyDockerInfrastructure(infra)
```

**Workflow mode (new, engine-owned):** `WorkflowOrchestrator` creates the
infrastructure once per workflow run and hands the *same* bundle to every
agent state's session. Each session borrows:

```typescript
// WorkflowOrchestrator.start() / resume():
const infra = await createDockerInfrastructure(workflowOpts);
instance.infra = infra;

// WorkflowOrchestrator.executeAgentState():
await infra.proxy.getCoordinator().loadPolicy({ persona, version, ... });
const session = new DockerAgentSession(infra, /*ownsInfra=*/ false, ...);
await session.initialize();
// ... run session ...
await session.close();  // stops claude + watchers only

// WorkflowOrchestrator on terminal / abort / shutdownAll:
await destroyDockerInfrastructure(instance.infra);
```

Both call sites use the same `DockerAgentSession` class. The only
difference is who owns the infrastructure and therefore who is responsible
for destroying it. There is no second session subclass, no
"externalContainer mode" flag inside `initialize()`, and no conditional
inside `close()` beyond the single `if (ownsInfra)` branch.

##### Interaction with the existing `preBuiltInfrastructure` field

The current `DockerAgentSessionDeps.preBuiltInfrastructure` field
(`src/docker/docker-agent-session.ts:75-79`) is subsumed by this model:

- `preBuiltInfrastructure` exists today because `createDockerSession()`
  already runs the proxy + orientation setup via
  `prepareDockerInfrastructure()` before constructing the session, so the
  session's `initialize()` must skip those steps. After the refactor, the
  infrastructure is *always* pre-built (because
  `createDockerInfrastructure()` does everything), so the skip is
  unconditional. The field goes away.
- A future third caller -- e.g., the daemon pre-building certain proxies
  for a pool of sessions -- would use the same model: pass the bundle in
  with `ownsInfra=false` and reuse it across sessions. There is no need
  for a separate "partial pre-build" concept.

##### What each party owns

| Party | Lifecycle | Resources |
|-------|-----------|-----------|
| `DockerAgentSession` | One state's execution | Escalation watcher, audit tailer, agent process started via `docker exec` |
| `DockerInfrastructure` | Variable -- standalone: one session; workflow: whole workflow | Container, sidecar, internal network, MITM proxy, Code Mode proxy (+contained coordinator, `MCPClientManager`, subprocesses), CA, fake keys |

The bundle is owned by exactly one party at a time: the session when
`ownsInfra=true`, the orchestrator when the orchestrator creates it
directly. There is no shared ownership and no refcounting.

##### Concurrency

Multiple sessions **may** share the same `DockerInfrastructure`
simultaneously when -- and only when -- they run the same persona
(parallel-homogeneous-persona states). The coordinator's tool-call
mutex (§2.1 "Concurrency / thread-safety") serializes concurrent
`handleToolCall` invocations across all borrowers, protecting the
three shared caches (`ApprovalWhitelist`, `CallCircuitBreaker`,
`ServerContextMap`) and guaranteeing that the single `AuditLog`
stream receives coherent entries. The policy mutex (held only inside
`loadPolicy`) additionally rules out engine swaps while any tool call
is in flight. Together these two mutexes make
parallel-homogeneous-persona borrowing safe in v1.

Parallel-heterogeneous-persona borrowing (two sessions simultaneously
borrowing the same bundle under *different* personas) is rejected --
schema check at workflow load time plus coordinator runtime guard,
see §2.1 "Parallel heterogeneous personas remain rejected" and §7.

Sequential sessions (the normal case for non-parallel workflows)
continue to work as before: one borrower at a time, each running to
completion before the next `executeAgentState()` borrows the bundle.

#### Proxy (the Sandbox's `ToolCallCoordinator`)

The coordinator exposes a new control operation `loadPolicy(persona, version)`
over a UDS control socket (parallel to the MITM control server). Because
the coordinator is a **single** in-process component, `loadPolicy` is a
single atomic method call -- no fan-out to subprocesses, no multi-writer
coordination, no barrier problem. Effect:

1. Acquire the policy mutex (serializes against any concurrent
   `handleToolCall` and against any overlapping `loadPolicy`).
2. Flush and close the current `AuditLog` stream.
3. Compute the new audit path
   `~/.ironcurtain/workflow-runs/{workflowId}/audit.{persona}.{version}.jsonl`
   and open a fresh `AuditLog` appending to it.
4. Reload `compiled-policy.json` and `dynamic-lists.json` from the new
   policy directory (tool annotations are global and do not need reload).
5. Replace the live `PolicyEngine` with a newly constructed one backed by
   the reloaded artifacts plus the unchanged `toolAnnotations`,
   `protectedPaths`, `allowedDirectory`, `serverDomainAllowlists`, and
   `trustedServers`.
6. Merge `proxyAnnotations` / `proxyPolicyRules` into the new artifacts
   (preserves current behavior at `mcp-proxy-server.ts:1112/1116`).
7. Release the mutex.
8. Acknowledge on the control socket; the engine continues only after the
   ack so there is no window where a state runs against the previous
   persona's policy.

The subprocesses are not involved in the swap at all. They continue
serving MCP calls against the same backend clients; tool calls arriving
during the mutex-held window simply queue up in the coordinator.

This control channel belongs to the workflow-scoped coordinator. For
non-workflow sessions (interactive CLI, daemon, cron), the control socket
is simply never started and the loaded policy remains that of the one
persona the session was created with. There is no change to the
single-session behavior.

## 3. Detailed changes by file

Descriptions only -- no code. See section 4 for the policy/audit control
protocol and section 6 for orthogonality rules.

### `src/sandbox/index.ts`

- Introduce `ToolCallCoordinator` (in a new file -- suggested
  `src/trusted-process/tool-call-coordinator.ts`, next to `policy-engine.ts`
  and `audit-log.ts`). Construct it in `Sandbox.initialize()` before
  registering MCP servers.
- Replace the per-backend `mcpServers` registration
  (`src/sandbox/index.ts:374-406`) with a single virtual MCP registration
  whose `callTool` hook is `ToolCallCoordinator.handleToolCall()`. The
  coordinator internally maintains an `MCPClientManager` that spawns the
  existing `mcp-proxy-server.ts` subprocesses (now stripped-down tool
  routers -- see below) one per backend.
- Provide a post-init accessor on `Sandbox` for the coordinator so the
  control socket can be attached (by the workflow orchestrator in Docker
  mode; by no one in interactive mode).

### `src/trusted-process/tool-call-coordinator.ts` (new)

- Houses the lifted logic described in §2.1 "What moves". Public surface:
  - `new ToolCallCoordinator(options)` -- options include policy artifacts,
    audit path, allowed directory, protected paths, server domain allowlists,
    trusted servers, auto-approve model, escalation dir, whitelist callbacks.
  - `handleToolCall(request: ToolCallRequest): Promise<ToolCallResult>` -- the
    centralized analogue of today's `handleCallTool`.
  - `loadPolicy(req: { persona, version, policyDir, auditPath }): Promise<void>`
    -- swap engine + rotate audit file under the policy mutex.
  - `close(): Promise<void>` -- stop the control socket (if started),
    close the audit stream, shut down the contained `MCPClientManager`.
- Internally owns `PolicyEngine`, `AuditLog`, `CallCircuitBreaker`,
  `ApprovalWhitelist`, `ServerContextMap`, auto-approve model, and the
  `MCPClientManager` that talks to the subprocess tool-routers.

### `src/trusted-process/mcp-proxy-server.ts`

- Strip out `PolicyEngine` construction, `AuditLog` construction,
  `CallCircuitBreaker`, `ApprovalWhitelist`, auto-approver setup,
  `ServerContextMap`, `prepareToolArgs`, escalation IPC, and the entire
  `handleCallTool` policy flow. Those now live in the coordinator.
- Retain: env parsing for `SERVER_FILTER` / `SERVER_CREDENTIALS` /
  `MITM_CONTROL_ADDR` / `SESSION_LOG_PATH`, OAuth credential injection,
  sandbox-runtime wrapping, MCP backend `Client` construction and
  connection, `ListToolsRequestSchema` handler (raw pass-through),
  `CallToolRequestSchema` handler (raw forward to backend client, return
  raw result). The file shrinks dramatically; aim for something close to
  an MCP "transparent relay" server.
- Keep the virtual-only mode (`SERVER_FILTER=proxy`) here. The virtual
  proxy tools (`add_proxy_domain`, `remove_proxy_domain`, `list_proxy_domains`)
  are pure MCP tool definitions with the real work happening via the
  `ControlApiClient` into the MITM control socket -- that flow is already
  policy-evaluated by the coordinator in the same way as any other tool.
- No control socket lives here. `PROXY_CONTROL_SOCKET_PATH` is an env var
  of the coordinator, not of the subprocess.
- `AUDIT_LOG_PATH` is no longer read by the subprocess. Delete the env
  var from the spawn environment (`src/sandbox/index.ts:304`). The
  coordinator reads its audit path directly from
  `config.auditLogPath` on `IronCurtainConfig` (already plumbed through
  to `Sandbox.initialize()`), so there is no plumbing gap created by
  this removal -- the value that was previously passed to the
  subprocess via env is the same value the coordinator reads from the
  config object it receives in-process.

### `src/trusted-process/audit-log.ts`

- Add `rotate(newPath: string): Promise<void>` -- closes the current
  write stream and opens a new one at `newPath`. Concurrency semantics:
  - Callers acquire the coordinator's policy mutex before calling; this
    serializes `rotate()` against `log()` through a higher-level lock
    rather than inside the class. Keeping the mutex at the coordinator
    layer means `log()` itself stays synchronous, matching today's
    `AuditLog.log()` signature and the simple "append and move on"
    semantics.
  - Alternatively, the class itself can accept an internal lock and make
    `log()` return `void` but buffer writes during rotation. Either works;
    the coordinator-level mutex is simpler and matches the single-writer
    model (§4).
  - The underlying `WriteStream.end()` is asynchronous and drains
    pending writes before the `end()` callback fires, so rotation is
    clean even if log entries are in flight when the swap begins.
- No cross-process locking needed: §2.1 gives us a single writer.

### `src/trusted-process/policy-engine.ts`

- No API changes required -- `PolicyEngine` is already immutable from the
  caller's perspective (no `setRules`, etc.). The coordinator replaces
  the instance wholesale on `loadPolicy`.

### `src/config/paths.ts`

- Add `getWorkflowAuditLogPath(workflowId, persona, version)` returning
  `~/.ironcurtain/workflow-runs/{workflowId}/audit.{persona}.{version}.jsonl`.
  The parent directory follows the existing workflow-runs convention
  (already used by the orchestrator's `baseDir` -- see
  `src/workflow/workflow-command.ts:227`).
- Add `getWorkflowProxyControlSocketPath(workflowId)` returning
  `~/.ironcurtain/workflow-runs/{workflowId}/proxy-control.sock`.
  Runtime-owned; cleaned up on terminal state transitions. Uses the
  existing `~/.ironcurtain/workflow-runs/{workflowId}/` parent dir, so no
  new top-level directory is needed.
- **UDS path length caveat.** macOS/BSD cap UDS paths at ~104
  characters (`sizeof(sun_path) - 1`); Linux at 108. With a typical
  home-directory prefix of ~24 chars and the
  `.ironcurtain/workflow-runs/` + `/proxy-control.sock` overhead
  (~42 chars), a `workflowId` of roughly 70+ characters will exceed
  the macOS limit and `bind()` will fail with `ENAMETOOLONG`. This
  is fine for typical workflow IDs (the orchestrator's
  `generateWorkflowId()` produces shorter slugs), but
  `getWorkflowProxyControlSocketPath` must truncate or hash long IDs
  before assembling the path. Suggested implementation: if the full
  path exceeds 100 bytes, replace the workflowId with its first 8
  chars + `-` + first 8 chars of `sha256(workflowId)`. This keeps
  the on-disk name discoverable while staying under the limit. The
  MITM control socket path function already hits this caveat and
  uses the same strategy (see `src/docker/mitm-proxy.ts` UDS-path
  construction); keep the two consistent.

### `src/workflow/types.ts`

- Add `freshContainer?: boolean` to `AgentStateDefinition`. Default `false`.
  When `true`, the engine stops the workflow container (if running) and
  creates a fresh one before executing the state. Orthogonal to
  `freshSession` except for the combined-reject rule (see section 8).

### `src/workflow/validate.ts`

- Add `freshContainer: z.boolean().optional()` to the agent state schema.
- Add a cross-field check: reject any agent state where
  `freshContainer === true` *and* `freshSession === false`. The combination
  is nonsensical -- you cannot resume a conversation in a fresh environment
  that does not yet have the prior process state. Emit a validation error
  naming both fields so workflow authors see exactly what to change.

### `src/workflow/orchestrator.ts`

- Use the `DockerInfrastructure` interface from
  `src/docker/docker-infrastructure.ts` as the workflow's container
  handle. No separate `WorkflowContainer` interface is needed -- the
  bundle is rich enough to carry everything sessions need, and
  introducing a parallel type would duplicate fields and invite drift.
  The orchestrator imports the type and stores it directly.
- Add `WorkflowInstance.infra?: DockerInfrastructure` (replaces the
  earlier `WorkflowInstance.container` proposal) and
  `WorkflowInstance.policyVersionsByPersona: Map<string, number>`. The
  counter is what drives audit filenames. The infra field is
  `undefined` for builtin workflows; set at workflow start for Docker
  workflows.
- Add private method `createWorkflowInfrastructure(instance)`: calls
  `createDockerInfrastructure({ workflowId: instance.id,
  controlSocketPath: getWorkflowProxyControlSocketPath(instance.id),
  ... })` and stashes the result on `instance.infra`. Called once from
  `start()` and from `resume()` if resume is configured with a Docker
  agent. The engine is now the owner of the bundle; sessions borrow via
  `ownsInfra=false`.
- Add private method `destroyWorkflowInfrastructure(instance)`: calls
  `destroyDockerInfrastructure(instance.infra)`, clears the field, and
  unlinks the coordinator control socket path. Called from terminal-state
  handling in `subscribeToActor`, from `abort()`, and from
  `shutdownAll()`. Idempotent (via `destroyDockerInfrastructure`'s
  error-tolerant steps and an early return when `instance.infra` is
  already cleared).
- Update `subscribeToActor` (`src/workflow/orchestrator.ts:640`): when a
  transition crosses into an **agent** state and `instance.infra` is
  set, call `cyclePolicy(instance, stateDef.persona)` before allowing
  the `agentService` invoke to fire. The natural hook point is the same
  transition-detection branch at line 655 (`stateValue !== previousState`).
  Implementation subtlety: the invoke fires as part of XState's reducer; the
  engine must issue the `loadPolicy` RPC synchronously from the subscription
  and *block* the new state's first `sendMessage()` until the ack arrives.
  The cleanest place to make that await is inside `executeAgentState()`
  itself (at the top, before `deps.createSession`), since that is where the
  agent work actually begins. `subscribeToActor` only needs to bump the
  version counter and record the pending reload in `instance`; the await
  lives in the invoke.
- Update `executeAgentState()` (`src/workflow/orchestrator.ts:751`):
  - Before `deps.createSession`: if `instance.infra` is set, await
    `cyclePolicy(instance, stateConfig.persona)`. This writes the new
    audit path to the coordinator's control socket and reloads the policy.
    The per-persona version counter is bumped here (not in
    `subscribeToActor`), so re-entries correctly increment.
  - Pass `workflowInfrastructure: instance.infra` in `SessionOptions`
    when present. The session will construct itself with
    `ownsInfra=false`, so its `close()` will *not* destroy the bundle.
  - Pre-step: if `stateConfig.freshContainer === true`, call
    `rebuildWorkflowInfrastructure(instance)` before cycling policy.
    This calls `destroyDockerInfrastructure(instance.infra)` followed
    by `createDockerInfrastructure(...)` and reassigns
    `instance.infra`. The coordinator and its subprocesses are rebuilt
    as part of the bundle (they are workflow-scoped, not
    container-scoped, but rebuilding together is simpler and keeps the
    audit rotation story consistent).
- Update terminal handling: ensure `destroyWorkflowInfrastructure()` runs
  once and exactly once on workflow completion, regardless of the
  completion path (success, failure, abort, crash during subscribe).
- Update `abort()` (`src/workflow/orchestrator.ts:555`): after closing
  `activeSessions`, call `destroyWorkflowInfrastructure(instance)`.
- Update `resume()` (`src/workflow/orchestrator.ts:348`): on resume, attempt
  to **reclaim** an existing container tagged with this workflow's ID (see
  section 6 for the reclamation protocol). If reclamation fails, create a
  fresh container and log a warning that installed dependencies are lost.
  Persona version counters do **not** persist across resume -- they restart
  at 1 for each persona in the resumed workflow. The audit log names in the
  resumed run will therefore be `audit.{persona}.1.jsonl` again; the
  workflow directory will have both pre-crash and post-resume files side by
  side, distinguishable by mtime.

### `src/workflow/checkpoint.ts`

- No change to `WorkflowCheckpoint` schema. Container ID is deliberately not
  checkpointed -- it is a runtime artifact that may or may not exist on
  resume, and the reclamation path (section 6) queries Docker directly for
  containers labeled with the workflow ID. This keeps checkpoints portable
  across machines.

### `src/session/types.ts`

- Add `workflowInfrastructure?: DockerInfrastructure` to `SessionOptions`
  (re-exported from `src/docker/docker-infrastructure.ts`). When set, the
  caller (the workflow orchestrator) has already created the
  infrastructure and retains ownership; the session borrows it.
- Document the ownership contract in a doc comment on the field: the
  bundle's lifetime exceeds the session's; the session must not destroy
  it. Standalone callers leave the field unset, and
  `createDockerSession()` creates the bundle internally with
  `ownsInfra=true`.

### `src/session/index.ts`

- Update `createDockerSession()` to branch on
  `options.workflowInfrastructure`:
  - When set: skip `createDockerInfrastructure()` entirely. Construct
    `DockerAgentSession` with the caller-supplied bundle and
    `ownsInfra=false`. The session's `initialize()` and `close()` behave
    exactly the same as in the standalone path except they do not create
    or destroy the bundle.
  - When unset (standalone): call `createDockerInfrastructure()` (new
    name for `prepareDockerInfrastructure()`, now including
    container creation), then construct `DockerAgentSession(infra,
    /*ownsInfra=*/ true, ...)`. The factory's own error-recovery path
    falls through to `session.close()`, which -- because `ownsInfra=true`
    -- calls `destroyDockerInfrastructure()` and undoes the infrastructure
    setup for free. The `session = undefined` guard currently at
    `src/session/index.ts:162` can be simplified accordingly.
- Stop passing `preBuiltInfrastructure` to the session constructor; that
  deps field is removed (see next entry). The system prompt composition
  at `src/session/index.ts:220-226` moves into the
  `DockerInfrastructure` construction path.
  **Chosen approach: `createDockerInfrastructure()` accepts an optional
  `systemPromptAugmentation: string` parameter** which the factory
  appends to the base system prompt before assigning it to
  `infra.systemPrompt`. Because `DockerInfrastructure.systemPrompt` is
  `readonly`, the caller-mutation alternative is not viable -- the
  field would have to become mutable, which widens the bundle's
  contract unnecessarily. For workflow mode, which needs different
  augmentations per agent state, the orchestrator calls
  `createDockerInfrastructure()` once at workflow start with no
  per-state augmentation and then passes per-state augmentations
  through `SessionOptions` (which the session composes into the
  `systemPrompt.md` it writes to the per-state session dir before
  launching the agent process -- the container-level prompt becomes
  the base layer, not the full prompt).

### `src/docker/docker-agent-session.ts`

- Replace `DockerAgentSessionDeps` with a substantially smaller interface
  organized around the infrastructure bundle:
  ```typescript
  interface DockerAgentSessionDeps {
    readonly infra: DockerInfrastructure;
    readonly ownsInfra: boolean;
    readonly config: IronCurtainConfig;
    readonly sessionId: SessionId;
    readonly sessionDir: string;
    readonly sandboxDir: string;
    readonly escalationDir: string;
    readonly auditLogPath: string;
    readonly agentModelOverride?: string;
    readonly onEscalation?: ...;
    readonly onEscalationExpired?: ...;
    readonly onEscalationResolved?: ...;
    readonly onDiagnostic?: ...;
  }
  ```
  The removed fields (`adapter`, `docker`, `proxy`, `mitmProxy`, `ca`,
  `fakeKeys`, `useTcp`, `conversationStateDir`,
  `conversationStateConfig`, `preBuiltInfrastructure`) all live on the
  bundle.
- Rewrite `initialize()` (`src/docker/docker-agent-session.ts:157`) as a
  pure exec-harness initializer: no proxy startup, no image build, no
  `docker create`, no `docker start`, no sidecar setup, no connectivity
  check. Those all moved to `createDockerInfrastructure()`. The remaining
  work is: write the effective system prompt to `sessionDir`, attach the
  escalation watcher, attach the audit tailer. The function shrinks from
  ~240 lines to ~30.
- Rewrite `close()` (`src/docker/docker-agent-session.ts:545-561`):
  ```typescript
  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.escalationWatcher?.stop();
    this.auditTailer?.stop();
    if (this.ownsInfra) {
      await destroyDockerInfrastructure(this.infra);
    }
  }
  ```
  The seven unconditional teardowns currently here -- `cleanupContainers`
  for the main container, the sidecar, and the internal network, plus
  `mitmProxy.stop()` and `proxy.stop()` -- move to
  `destroyDockerInfrastructure()` in `docker-infrastructure.ts`. No
  behavioral change for standalone callers (`ownsInfra=true` in that
  path); workflow callers pass `ownsInfra=false` and the teardowns do
  not run.
- Remove the private fields that now live on `this.infra`: `docker`,
  `proxy`, `mitmProxy`, `ca`, `fakeKeys`, `containerId`,
  `sidecarContainerId`, `networkName`, `systemPrompt` (copied into
  `this.systemPrompt` at construction if it needs to be mutable per-state),
  `useTcp`, `conversationStateDir`, `conversationStateConfig`. All call
  sites within the class that used these fields now reach through
  `this.infra.*`.

### `src/docker/code-mode-proxy.ts`

- `CodeModeProxy` gains a `getCoordinator()` accessor (or similar) so the
  orchestrator can attach the coordinator control socket to a
  workflow-scoped proxy. In single-session mode this accessor is never
  called.
- `start()` grows an optional `controlSocketPath` parameter; when set, the
  coordinator starts its control server on that UDS. Unset = no control
  server. In workflow mode, `createDockerInfrastructure()` passes the
  workflow-scoped control socket path (see
  `getWorkflowProxyControlSocketPath` in `src/config/paths.ts`);
  standalone callers leave it unset.

### `src/docker/docker-infrastructure.ts`

- **Rename** `prepareDockerInfrastructure()` to
  `createDockerInfrastructure()` and fold container creation into it.
  Today's `DockerInfrastructure` interface (lines 36-61) gains
  `containerId: string`, `containerName: string`,
  `sidecarContainerId?: string`, and `internalNetwork?: string`. All
  existing fields are preserved. The function takes one additional
  parameter, an opts object with `{ workflowId?, controlSocketPath? }`;
  when `workflowId` is set, containers are labeled with
  `ironcurtain.workflow=<id>` in addition to `ironcurtain.session=<id>`
  and the Code Mode proxy is started with the supplied
  `controlSocketPath`. When `workflowId` is unset, behavior matches
  today's `prepareDockerInfrastructure` semantics (modulo the new
  container-creation step).
- **Add** `destroyDockerInfrastructure(infra: DockerInfrastructure):
  Promise<void>`. Body is the seven steps currently in
  `DockerAgentSession.close()`:
  ```typescript
  async function destroyDockerInfrastructure(infra: DockerInfrastructure) {
    await cleanupContainers(infra.docker, {
      containerId: infra.containerId,
      sidecarContainerId: infra.sidecarContainerId,
      networkName: infra.internalNetwork,
    });
    await infra.mitmProxy.stop();
    await infra.proxy.stop();
  }
  ```
  The function is idempotent (each step tolerates already-gone
  resources) and safe to call in error-recovery paths.
- Label containers with both `ironcurtain.workflow={workflowId}` (when
  set) and `ironcurtain.session={id}` so existing cleanup tooling that
  filters on `ironcurtain.session=` still finds them. (Sessions within
  the workflow inherit the workflow label implicitly because they use
  the same container.)
- Update `DockerContainerConfig` / `docker-manager.ts:create()` if needed
  to accept arbitrary labels (it already supports `sessionLabel`; extend
  it with a generic labels map -- see the `docker-manager.ts` entry
  below).
- The existing helpers `ensureImage` and `prepareConversationStateDir`
  stay where they are; both are consumed by the new
  `createDockerInfrastructure` body. `ensureImage` is currently
  exported from `docker-infrastructure.ts:395` because
  `DockerAgentSession.initialize()` calls it from outside the module;
  after the refactor the only remaining caller is the same module's
  `createDockerInfrastructure()`, so drop the `export` keyword and
  make it module-internal. One less public symbol is one less API to
  keep stable.

### `src/docker/docker-manager.ts`

- Extend `DockerContainerConfig` with an optional
  `labels?: Record<string, string>` field, merged with the `sessionLabel`
  path already at line 68. This is the cleanest way to add
  `ironcurtain.workflow=<id>` without proliferating special-case fields.
- Add a `listContainers({ label })` helper that returns container IDs
  matching a label key/value pair. Used for reclamation on resume and for
  orphan cleanup.

## 4. Policy + audit lifecycle

### Version counter semantics

Each `WorkflowInstance` holds `policyVersionsByPersona: Map<string, number>`,
initialized empty. When the engine is about to run an agent state in a
workflow container:

1. Let `persona = stateDef.persona` (falling back to `'global'` for the
   GLOBAL_PERSONA sentinel).
2. `version = (policyVersionsByPersona.get(persona) ?? 0) + 1`.
3. `policyVersionsByPersona.set(persona, version)`.
4. `auditPath = getWorkflowAuditLogPath(workflowId, persona, version)`.
5. `policyDir = resolvePersona(persona).policyDir` (or the global generated
   dir for GLOBAL_PERSONA).
6. Issue `loadPolicy` to the coordinator's control socket with
   `{ persona, version, policyDir, auditPath }`. Await the ack.
7. Proceed to `deps.createSession(...)` with
   `workflowInfrastructure: instance.infra` set. The resulting session
   borrows the bundle (`ownsInfra=false`) and does not tear it down on
   `close()`.

This cycle runs **unconditionally at every state transition into an agent
state**, even when the persona is the same as the previous state. The user
expressed a strong preference for this: "one state = one audit file" is a
simpler mental model than "one audit file per contiguous run of a single
persona", and it makes run-by-run analysis trivial without tracking
transitions.

### Audit file naming

`audit.{persona}.{version}.jsonl` where:

- `persona` is the literal persona name from the state definition, or
  `global` for GLOBAL_PERSONA.
- `version` is a 1-based monotonic counter **scoped to the persona within
  this workflow run**. If the workflow visits `global -> reviewer -> global`,
  the files are:
  - `audit.global.1.jsonl` (first global state)
  - `audit.reviewer.1.jsonl`
  - `audit.global.2.jsonl` (second global state)

### Audit entry schema: unchanged

Per the user's explicit decision, `AuditEntry` in `src/types/audit.ts` does
**not** gain persona/version fields. Attribution is carried by the filename,
not by the entry. An example entry after this change is byte-identical to one
from today:

```json
{"timestamp":"2026-04-12T18:20:15.874Z","requestId":"1f8d...","serverName":"filesystem","toolName":"read_text_file","arguments":{"path":"/..."},"policyDecision":{"status":"allow","rule":"...","reason":"..."},"result":{"status":"success"},"durationMs":1}
```

This keeps `AuditLog` and every downstream consumer (`AuditLogTailer`,
redactor, daemon event bus) schema-compatible. The only new concept is that
the set of audit files per workflow is a directory listing rather than a
single file.

### Audit writer concurrency (single-process semantics)

After §2.1 there is one writer -- the coordinator's `AuditLog` -- so the
concurrent-writer concern from the multi-subprocess world disappears.
What remains is intra-process concurrency: `log()` called while `rotate()`
is in progress.

Chosen semantics: **queue on the policy mutex.** The coordinator already
takes a mutex to serialize `loadPolicy` against `handleToolCall` (see
§2.1). Audit rotation happens inside `loadPolicy` under that mutex. While
the mutex is held, no `handleToolCall` is running, so no `auditLog.log()`
call is in flight. The `WriteStream.end()` callback fires after the kernel
has flushed buffered writes; we await that callback before opening the
new stream. When the mutex releases, the next `handleToolCall` writes to
the new stream. No tool call ever misses its audit entry; no entry is ever
split across files.

`auditLog.log()` stays synchronous (it drops bytes into a Node
`WriteStream`'s buffer, which is synchronous from the caller's perspective).
No buffering logic is needed in `AuditLog` itself.

Parallel-states concurrency is already handled: the tool-call mutex
(§2.1 "Concurrency / thread-safety") serializes concurrent
`handleToolCall` invocations, and the policy mutex (acquired inside
`loadPolicy` after the tool-call mutex is free) guarantees no
`handleToolCall` ever straddles a policy swap. The version counter is
updated inside `loadPolicy`, so it is only mutated while both mutexes
exclude concurrent tool calls. Parallel homogeneous-persona states
share the same engine/audit/version and do not cycle policy
mid-parallel-group (see §8).

### Control protocol details

- Transport: HTTP/1.1 over a UDS at the workflow-scoped path (see §3,
  `getWorkflowProxyControlSocketPath`). On platforms where UDS in bind
  mounts is not viable, fall back to loopback TCP using the same
  transport-selection logic the MITM control server uses today
  (`src/docker/mitm-proxy.ts:1168`). Auth: none -- the socket sits inside
  the workflow run's private directory with `0o700` mode (same pattern as
  MITM).
- Request: `POST /__ironcurtain/policy/load`,
  `Content-Type: application/json`, body
  `{ "persona": "reviewer", "version": 3, "policyDir": "/abs/path",
  "auditPath": "/abs/path/audit.reviewer.3.jsonl" }`.
- Response: 200 with `{ "ok": true, "loadedAt": "<ISO>" }` on success, 4xx
  on malformed input, 5xx with `{ "error": "..." }` on load failure.
- Failure semantics: if the coordinator cannot load the new policy
  (missing `compiled-policy.json`, parse error, etc.) the engine must fail
  the workflow. Continuing with the previous persona's policy would violate
  the least-privilege contract.
- Path-prefix convention: the `/__ironcurtain/` prefix is shared with
  the MITM control server's existing paths `/__ironcurtain/domains`,
  `/__ironcurtain/domains/add`, `/__ironcurtain/domains/remove`
  (`src/docker/proxy-tools.ts:231-237`,
  `src/docker/mitm-proxy.ts:1112-1144`). The MITM server is a
  separate concern (it manages domain allowlists for the HTTP
  forward proxy and runs in its own process), so the two servers
  **do not** share a path router or routing conventions beyond this
  prefix. Adding a `/policy/` segment to the coordinator's endpoint
  is the explicit namespace split: the MITM server routes `domains/*`
  and the coordinator routes `policy/*`. Future coordinator endpoints
  should land under `/__ironcurtain/<noun>/<verb>` (e.g.,
  `/__ironcurtain/whitelist/clear` if ever needed). This namespace
  overlap is intentional and documented here so future reviewers
  don't "fix" it by merging the two services.

## 5. Orthogonality invariants

Three orthogonal dimensions. The table names what persists into the next
agent invocation:

| Dimension | What persists when "reuse" | What is fresh when "reset" |
|-----------|---------------------------|----------------------------|
| `freshSession: false` (existing) | Agent conversation history (`--continue`) | New session, agent bootstraps from artifacts |
| Workflow container (NEW, default ON when workflow uses Docker) | Container FS: apt installs, compiled binaries, caches, working dir state | `freshContainer: true` rebuilds; workflow terminal rebuilds on next run |
| Policy activation (NEW, always cycles per state) | N/A -- policy always reloads | New audit file, `PolicyEngine` reconstructed from persona's policy dir |

### Valid combinations

| freshSession | freshContainer | Meaning | Valid? |
|--------------|----------------|---------|--------|
| `true` (default) | `false` (default) | New agent conversation, same container. Typical case. | Yes |
| `false` | `false` | Resume conversation, same container. Ideal for iterative refinement (today's `harness_design` retries). | Yes |
| `true` | `true` | New agent conversation, fresh container. "Hard reset" for the state. | Yes |
| `false` | `true` | Resume conversation in a container whose process state is gone. The resumed session may reference files or state that no longer exist. | **Rejected at validation time.** |

The validator emits a clear error pointing at both fields. This is a static
check, not a runtime check -- `validateDefinition()` should fail the workflow
before it ever starts.

### Ownership matrix

| Resource | Owner |
|----------|-------|
| Workspace directory | WorkflowOrchestrator |
| Checkpoint | WorkflowOrchestrator |
| `DockerInfrastructure` bundle (container, sidecar, internal network, MITM proxy, Code Mode proxy + contained `ToolCallCoordinator` + `MCPClientManager` + subprocesses, CA, fake keys) | WorkflowOrchestrator (workflow mode); DockerAgentSession (standalone mode, via `ownsInfra=true`) |
| Coordinator control socket | Same party that owns the `DockerInfrastructure` bundle (attached to the bundle's `CodeModeProxy`; exists only in workflow mode) |
| `PolicyEngine` instance reference (mutable via `loadPolicy`) | `ToolCallCoordinator` |
| `AuditLog` instance reference (rotated via `rotate()`) | `ToolCallCoordinator` |
| Policy version counters | WorkflowOrchestrator |
| Agent conversation state dir | DockerAgentSession (per-session subdirectory of the shared bind mount) |
| Escalation watcher, audit tailer, agent process (`docker exec`) | DockerAgentSession (always; never part of the infrastructure bundle) |
| XState actor, transition history, message log | WorkflowOrchestrator (unchanged) |

The key shift from prior revisions: there is no per-resource ownership for
workflow-level Docker handles. The bundle is atomic -- whoever creates it
destroys it, and they do so with a single `destroyDockerInfrastructure()`
call. `DockerAgentSession`'s `ownsInfra` flag decides which side of that
line the session falls on.

The `orchestrator` state in a YAML file (e.g., vuln-discovery's router) is
**not** an owner of anything. It is just an agent state running the
orchestrator persona. The engine is the owner; the state is data.

## 6. Resume and crash semantics

### Container reclamation on resume

On `WorkflowOrchestrator.resume(id)`, the engine queries Docker for containers
labeled `ironcurtain.workflow=<id>`:

- **Zero matches**: typical case after a host restart or clean shutdown.
  Create a fresh bundle via `createDockerInfrastructure({ workflowId,
  ... })`. Log a warning: `"Workflow container for <id> not found;
  installed dependencies from the previous run are lost and will be
  reinstalled on demand."` Resume the workflow.
- **One match**: the previous process died but the container survived
  (Docker daemon still running). Verify it is still in the running state
  via `docker.isRunning()`. If so, reclaim it by constructing a
  `DockerInfrastructure` handle around the existing container (the proxy
  and MITM must be re-created fresh -- they died with the prior engine
  process) and storing it on `instance.infra`. If the container is not
  running, remove it and
  create a fresh one. Log the path taken. Note that
  `docker.isRunning()` returns `false` for `paused` containers (paused
  is not running), so a paused container falls into the "not running →
  remove and re-create" branch. This is the right outcome: unpausing
  and resuming against potentially stale proxy connections is more
  failure-prone than a clean recreate, and the `ironcurtain.workflow=`
  label ensures the paused container is identified and removed
  deterministically.
- **More than one match**: shouldn't happen, but defensive: remove all but
  the most recent (by `.State.StartedAt`) and reclaim the survivor. Log a
  warning listing the removed container IDs.

Proxies, coordinator, and CA material must be re-created on resume regardless
of container state -- they live in process memory and were lost when the
previous orchestrator process died. The new proxies bind to new sockets in
the workflow's run directory, and the reclaimed container must be informed
of the new proxy endpoints. For UDS mode this happens naturally because the
bind-mounted sockets directory is a filesystem path owned by the engine; the
coordinator writes fresh sockets there on startup and the `docker exec`
issued by the next session picks them up through the long-established mount.
For TCP mode (macOS), the socat sidecar address is baked into the container's
`/etc/hosts` at `docker create` time -- if the proxy listens on a different
port after resume, the sidecar is stale. The pragmatic answer is to **not
reclaim TCP-mode containers**: on macOS, always create a fresh container on
resume. Explicitly: before the fresh container is created, the resume path
must remove any stale container tagged with this workflow's labels (the same
`listContainers({ label })` query used by the reclamation path, followed by
`docker rm -f`). Leaving a stale labeled container in place would cause the
next resume to mis-reclaim it. Log the platform-specific decision. If
`docker rm -f` itself fails (daemon transient error, container stuck in an
unusual state), log a warning and proceed with fresh container creation --
the new container gets a fresh, deterministic name derived from the new
sessionId, so stale-name collision is not a concern for the happy path.
A residual stale container is a resource-waste issue, not a correctness
issue, and the orphan-cleanup follow-up in §6 covers eventual reaping.

### Crash mid-state

If the engine process dies while a state is executing (mid-`sendMessage`),
the container, subprocesses, and proxies may survive or not:

- The checkpoint reflects the state the workflow was in *before* the
  currently-executing agent state began (XState persists on entry, not on
  exit). On resume, the engine replays the invoke via
  `replayInvokeForRestoredState()` (`src/workflow/orchestrator.ts:426`).
  This already works today.
- The policy cycle runs again on resume (the engine does not know whether
  the pre-crash run cycled policy successfully, so it does so
  unconditionally). The version counter restarts at 1, so the audit file
  for the resumed state is `audit.{persona}.1.jsonl`. This may collide
  with an earlier file from the pre-crash run. Mitigation: if the target
  path exists, insert a `.resumed.{unix-ts}` segment before the `.jsonl`
  suffix -- e.g. `audit.reviewer.1.resumed.1734567890.jsonl`. This is
  preferable to the earlier proposal of `-resumed-{ts}` because each
  segment is dot-delimited, giving clean glob parsing (`audit.*.jsonl`
  still matches, and `audit.*.resumed.*.jsonl` selects only resumed
  files).

### Subprocess (tool-router) crash mid-workflow

The coordinator's `MCPClientManager` treats a subprocess crash the same as
today's `TrustedProcess` does: the backend becomes unreachable, subsequent
tool calls for that server return errors. The coordinator itself remains
alive with its policy + audit state intact, so `loadPolicy` still works --
the replacement engine is swapped in, audit rotates, everything else
continues normally. There is no "recover the dead subprocess" primitive in
v1; the workflow either fails (if the backend is critical, e.g., filesystem)
or continues (if the backend is incidental). The manager exposes
connection state already; the coordinator can surface a structured error
back up through `handleToolCall` so the agent can reason about it. A
future enhancement -- auto-restart the subprocess, re-register its tools,
and retry the call -- is out of scope here.

### Orphan cleanup

A separate cleanup pass (suggested: invoked at daemon startup, or a `ironcurtain
workflow prune` command) queries for containers with
`ironcurtain.workflow=*` labels not matched by any active workflow. Removing
these is optional -- they are harmless, just resource waste. Out of scope
for the v1 implementation; noted here because the labeling convention makes
it trivial to add later.

## 7. Validation changes

In `src/workflow/validate.ts`:

- Add `freshContainer: z.boolean().optional()` to the agent state schema
  (near line 35 where `freshSession` lives today).
- Add a cross-field check in the definition-level validator:
  - For every agent state, if `state.freshContainer === true && state.freshSession === false`:
    emit an issue like
    `"State \"${stateId}\" has freshContainer: true with freshSession: false;
    resuming a conversation in a fresh environment is nonsensical (the
    resumed agent may reference files or installed binaries that the new
    container does not have)."`
  - Place the check alongside the existing `parallelKey`/non-agent check
    at `src/workflow/validate.ts:295` for consistency with the style of
    errors already emitted there.
- Add a parallel-homogeneous-persona check: group agent states by
  `parallelKey`; within each group, every state's resolved persona
  (explicit `persona` field, falling back to settings-inherited
  persona) must be identical. On mismatch, emit an issue naming the
  `parallelKey` value and the offending states, e.g.
  `"Parallel group \"fanout-1\" has mixed personas (reviewer, builder);
  parallel states must share a persona because the policy engine is
  single-tenant per coordinator."`. Rationale in §2.1 "Parallel
  heterogeneous personas remain rejected." The coordinator also
  enforces this at runtime (mismatched-persona `loadPolicy`), but the
  static check catches it at workflow-load time with a clear
  author-facing message.

Add a lint rule in `src/workflow/lint.ts` only if the check fits the "static
lint" pattern over the "schema validation" pattern -- in this case the checks
are hard errors (not warnings) so schema validation is the right layer.

## 8. Out-of-scope / follow-ups

### Parallel states (heterogeneous personas)

`parallelKey` states are a live feature of the codebase
(`src/workflow/types.ts:121`), not a future one. Homogeneous-persona
parallelism is fully supported by this design: parallel agents all
`docker exec` into the shared workflow container and issue tool calls
through the single `ToolCallCoordinator`, which serializes them with
the tool-call mutex described in §2.1's "Concurrency / thread-safety"
subsection. `ApprovalWhitelist`, `CallCircuitBreaker`, and
`ServerContextMap` are safe under that mutex; audit entries from
interleaved callers land as contiguous JSONL records.

What remains out of scope for v1 is parallel **heterogeneous**
personas -- two parallel states holding different personas and
therefore needing different compiled policies active simultaneously.
The single-engine constraint means a `loadPolicy` for persona B would
evict persona A mid-execution. v1 rejects this at workflow-load time
(schema check in `src/workflow/validate.ts`) and also at the
coordinator layer (mismatched-persona `loadPolicy` error) -- see §2.1
"Parallel heterogeneous personas remain rejected."

The future-fix (when parallel heterogeneous personas become needed)
is a per-invocation `PolicyEngine` reference: the coordinator's
`handleToolCall` accepts a `connectionId` (or `stateId`) and
dispatches to the right engine instance. The coordinator layer is
the right place to add that; the subprocesses need no change because
they never touch policy. Out of scope here.

### Container snapshotting between states

Explicitly rejected by the user. Keep the model simple: one long-lived
container per workflow, thrown away at the end. If a future state benefits
from rolling back filesystem state (e.g., restart test scaffolding), the
state itself should do that explicitly inside the container -- snapshotting
at the Docker layer is a large complexity increase for a thin benefit.

### Workflow container for built-in sessions

`mode: builtin` workflows don't use Docker and don't need a workflow
container. The engine must skip all container lifecycle code when the
workflow's `settings.mode === 'builtin'`. Policy cycling via `loadPolicy`
could still apply in principle -- after §2.1, the Sandbox's coordinator is
the single control point whether or not there's a Docker container -- but
built-in workflows don't currently need cross-state policy reload, so the
control socket is only wired up in Docker mode for now. If a future
built-in workflow needs per-state policies, the coordinator can grow a
control server in builtin mode too with no architectural changes.

### Orphan cleanup CLI

As noted in section 6, a `ironcurtain workflow prune` command that removes
containers with `ironcurtain.workflow=<id>` labels where the workflow is in
a terminal state (or absent from the checkpoint store). Purely hygienic.

### Third caller: daemon pre-built infrastructure pool

The current `preBuiltInfrastructure` field on `DockerAgentSessionDeps`
exists because the daemon (or session factory in some modes) already
runs proxy setup before constructing the session. Under the
`DockerInfrastructure` + `ownsInfra` model (§2.2), this use case
collapses naturally: the daemon calls `createDockerInfrastructure()`,
retains ownership of the bundle, and passes it to each session with
`ownsInfra=false`. This is exactly what the workflow orchestrator does.
If the daemon wants to pool / reuse bundles across sessions, the
mechanism is already there -- a third caller does not require a third
mode. Noted here as a potential follow-up; no code change is needed for
it to work.

## 9. Migration and backward compatibility

### YAML API

- The workflow YAML schema gains one optional field: `freshContainer` on
  agent states. Every existing workflow definition parses unchanged.
- `design-and-code.yaml`, `vuln-discovery.yaml`, and any user-authored
  workflows continue to work. They will automatically benefit from the new
  container-reuse semantics (dependencies installed in one state persist
  into the next).

### Session API

- `SessionOptions.workflowInfrastructure` is an optional addition;
  callers that don't set it get the existing per-session container
  behavior (standalone path in `createDockerSession()` creates its own
  bundle with `ownsInfra=true`). Ad-hoc interactive Docker sessions
  (`ironcurtain start`), cron sessions, and daemon-spawned sessions are
  unaffected by default. The daemon or any other caller that wants to
  share a bundle across multiple sessions does so by calling
  `createDockerInfrastructure()` itself and passing the result in via
  `workflowInfrastructure` (see §8 "Third caller"); a new session API
  is not needed.
- `DockerAgentSessionDeps.preBuiltInfrastructure` is **removed**.
  Subsumed entirely by the bundle + `ownsInfra` model. Callers that
  previously constructed a session with pre-built infrastructure should
  now construct a `DockerInfrastructure` via the new factory and pass
  it in explicitly.

### Proxy env vars

- `AUDIT_LOG_PATH` is **removed** from the subprocess environment (it's no
  longer read there after §2.1). Callers that set it for other reasons
  continue to do so at the Sandbox / CodeModeProxy level.
- The coordinator's control socket path is not an env var; it's plumbed in
  through `CodeModeProxy.start({ controlSocketPath })`. This keeps the
  attack surface minimal for single-session use (no socket is started at
  all) and the memory footprint essentially identical.

### Audit log on-disk format

- The audit entry schema is unchanged.
- Non-workflow sessions continue to write to
  `~/.ironcurtain/sessions/{sessionId}/audit.jsonl` (one file per session).
- Workflow runs write to
  `~/.ironcurtain/workflow-runs/{workflowId}/audit.{persona}.{version}.jsonl`
  (N files per run). Existing tooling that reads the single-file form
  continues to work; any workflow-aware tooling must discover the list of
  files by directory scan.
- A subtle behavior change even outside workflows: because §2.1 collapses
  N per-subprocess writers into one, non-workflow sessions also gain
  single-writer audit semantics. Interleaved-write hazards are fixed
  incidentally. No file format change.

### Checkpoint format

- `WorkflowCheckpoint` is unchanged. Container identity is recovered via
  Docker labels on resume, not via the checkpoint. A checkpoint written by
  the current version of the engine resumes correctly on the new engine;
  a checkpoint written by the new engine resumes correctly on the old
  engine only if Docker has already torn the container down (the old
  engine simply creates a fresh container per state).

### Rollout order

Suggested implementation sequence (each step is independently shippable and
does not break prior behavior):

1. **PolicyEngine + AuditLog centralization.** *Status: shipped (`30e7510` feat: centralize PolicyEngine + AuditLog into ToolCallCoordinator).* Lift the policy, audit,
   circuit breaker, approval whitelist, auto-approver, and server-context
   primitives out of `mcp-proxy-server.ts` and into the new
   `ToolCallCoordinator` in the Sandbox / CodeModeProxy layer. The
   subprocess becomes a tool-router (MCP pass-through). Interactive and
   workflow behavior is unchanged in this step; the only user-visible
   effect is that all tool calls serialize through a single engine and
   write through a single audit stream -- goodbye to multi-writer
   interleaving. This is the **prerequisite** for everything below; ship
   it first, soak it in regular single-session use for a release cycle
   before layering the workflow path on top.
2. **`DockerInfrastructure` bundle + `DockerAgentSession` ownership
   refactor.** *Status: shipped (`be3bdce` refactor: introduce DockerInfrastructure bundle with explicit lifecycle).* Concrete, landing in one incremental series that does
   not break standalone mode at any point:
   1. Define the extended `DockerInfrastructure` interface in
      `src/docker/docker-infrastructure.ts` (add `containerId`,
      `containerName`, `sidecarContainerId?`, `internalNetwork?`).
   2. Rename `prepareDockerInfrastructure` →
      `createDockerInfrastructure` and fold container creation into it
      (move the `docker create` / `docker start` / sidecar / internal
      network / connectivity-check logic out of
      `DockerAgentSession.initialize()`).
   3. Extract `destroyDockerInfrastructure()` from the seven teardown
      steps currently in `DockerAgentSession.close()`
      (`src/docker/docker-agent-session.ts:545-561`).
   4. Update `DockerAgentSession`'s constructor to accept
      `(infra: DockerInfrastructure, ownsInfra: boolean, ...)`;
      collapse the per-resource private fields into `this.infra.*`;
      `close()` conditionally calls `destroyDockerInfrastructure()`
      based on `ownsInfra`.
   5. Update the standalone factory in `src/session/index.ts` to call
      `createDockerInfrastructure()` itself and construct the session
      with `ownsInfra=true`. Drop the `preBuiltInfrastructure` deps
      field (no longer used).

   After this step, standalone Docker sessions behave exactly as before
   (create-then-own, destroy-on-close); no workflow caller exists yet.
   Validate by running the full interactive Docker test suite end to end
   before moving on.
3. **Audit rotation + policy reload plumbing in the coordinator.** *Status: shipped (`2d961d4` feat: policy hot-swap via coordinator control socket). The `AuditLog.rotate()` API in the original proposal was dropped in favor of persona-tagged entries; see deviation D1.* Add
   `AuditLog.rotate()`, the coordinator control socket, and the
   `loadPolicy` endpoint. Ship with no caller exercising it; verify by
   unit test.
4. **Session-side borrow path.** *Status: shipped (`963f793` feat: session-side borrow path for workflow infrastructure).* Extend `SessionOptions` with
   `workflowInfrastructure?: DockerInfrastructure`. Route
   `createDockerSession()` through the "use caller-supplied bundle with
   `ownsInfra=false`" branch when set. Still no workflow caller; verify
   by unit test that a session wired to a manually-constructed bundle
   works end-to-end and leaves the bundle alive on `close()`.
5. **Engine-owned workflow infrastructure.** *Status: shipped (`d53b017` feat(workflow): engine-owned DockerInfrastructure (Step 5 Round 1), `9918ad7` feat(workflow): policy hot-swap via persona-tagged audit (Step 5 Round 2), plus follow-ups `ff3ed77`, `73acb70`, `8551045`, `479f998`, `2a0a3b6`, `11c1c4d`, `5cc617f`, `46d7f0b`).* Wire up
   `createWorkflowInfrastructure()` / `destroyWorkflowInfrastructure()`
   in the orchestrator, plumb `workflowInfrastructure` through
   `executeAgentState()`, and invoke `loadPolicy` at every state
   transition. This is the first user-visible behavior change; land it
   behind an opt-in flag (e.g., `settings.sharedContainer: true`) during
   the soak period if desired.
6. **Validation for `freshContainer` + `freshSession`.** *Status: pending.* Land the
   validator check once at least one workflow wants to use
   `freshContainer`.
7. **Resume reclamation.** *Status: pending.* Add container reclamation in `resume()`.
   Include the macOS TCP-mode stale-container cleanup described in §6.
   Ship last because it is the most failure-prone and benefits from
   exercising the happy path first.

## 10. Deviations from original design

The prose above (§§1-9) is preserved as written; this section records the
concrete decisions that diverged during implementation so that future
readers can reconcile the design-as-proposed with the design-as-shipped
without reverse-engineering the code. Each deviation is load-bearing --
the surrounding prose still reads as if it were true, but in practice
the listed item is what actually lives in the tree today.

### D1 -- Audit schema: single file with `persona` field; `rotate()` API dropped

The design specified per-persona / per-version rotated audit files named
`audit.{persona}.{version}.jsonl` (see §4 "Audit file naming" and the
`AuditLog.rotate(newPath)` API proposed in §3 `src/trusted-process/audit-log.ts`).
That rotate path was dropped. `AuditEntry` in `src/types/audit.ts` gained a
`persona?: string` field, and each workflow run writes a single
`audit.jsonl` file to which every entry is appended, tagged with the
persona that installed the active policy at the time of the call.
`ToolCallCoordinator` tracks a `currentPersona` field and stamps it onto
every entry via the security pipeline. `getWorkflowAuditLogPath(workflowId)`
(in `src/config/paths.ts`) now returns
`{home}/workflow-runs/{workflowId}/audit.jsonl` -- no persona or version
component in the filename. The `AuditLog` class has no `rotate()` method;
the class-level JSDoc explicitly documents that policy hot-swap only
updates `currentPersona` on the coordinator and all entries continue to
land in the same file. Consumers reconstruct per-persona / per-re-entry
slices by scanning and grouping on the `persona` field plus entry order.

Consequence for §§4, 5, 9: the audit-writer concurrency discussion
(§4 "Audit writer concurrency (single-process semantics)") no longer
has a rotation window to worry about -- the policy mutex still
serializes `loadPolicy` against `handleToolCall`, but the only state
that changes across the swap is `currentPersona` (and the
`PolicyEngine` reference). The ownership matrix row "AuditLog
instance reference (rotated via `rotate()`)" in §5 is now a plain
"AuditLog instance reference" (no rotate surface). The §9 backward-compat
table is effectively simpler: non-workflow and workflow sessions both
write one `audit.jsonl` per session/run, distinguished only by
directory (`sessions/{id}/` vs. `workflow-runs/{id}/`).

### D2 -- Layout: consolidated `workflow-runs/<id>/` tree, not a session-dir split

The design implicitly assumed workflow artifacts would live under per-state
session dirs (`~/.ironcurtain/sessions/{sessionId}/...`) plus a workflow
parent (`~/.ironcurtain/workflow-runs/{workflowId}/`), with per-state UUID
subdirectories for session-local output. The shipped layout consolidates
*everything* for a workflow run under a single root:

```
~/.ironcurtain/workflow-runs/{workflowId}/
├── audit.jsonl                         # single file (D1)
├── messages.jsonl                      # workflow message log
├── proxy-control.sock                  # coordinator control UDS
├── bundle/                             # shared across all states
│   ├── claude-state/
│   ├── orientation/
│   ├── sockets/
│   ├── escalations/
│   └── system-prompt.txt
├── states/{stateId}.{visitCount}/      # per-invocation (incl. re-entries)
│   ├── session.log
│   └── session-metadata.json
└── workspace/                          # workflow-scoped workspace
```

Path helpers in `src/config/paths.ts` encode this layout:
`getWorkflowRunDir`, `getWorkflowAuditLogPath`, `getWorkflowBundleDir`,
`getWorkflowStatesDir`, `getWorkflowStateDir`,
`getWorkflowStateLogPath`, `getWorkflowStateMetadataPath`, and
`getWorkflowProxyControlSocketPath`. There is no per-state UUID
directory under `~/.ironcurtain/sessions/` for workflow runs; the
`{stateId}.{visitCount}` slug keyed under `states/` plays that role and
lives inside the workflow's own tree. This keeps every artifact
discoverable from one root and makes `rm -rf workflow-runs/<id>/` a
complete cleanup. Consequence: references in §3 and §9 to
`~/.ironcurtain/sessions/{sessionId}/audit.jsonl` still apply to
standalone / interactive sessions but not to workflow state sessions.

### D3 -- `PolicySwapTarget`: narrowed seam, not full coordinator access

§2.2 "Proxy" and the §3 `src/docker/code-mode-proxy.ts` entry implied that
the orchestrator would reach a rich accessor (`getCoordinator()`, or a
`start({ controlSocketPath })` growing on `CodeModeProxy`). The shipped
seam is narrower. `DockerProxy.getPolicySwapTarget()` returns a
`PolicySwapTarget` interface whose *only* method is
`startControlServer(opts: ControlServerListenOptions): Promise<ControlServerAddress>`
(see `src/docker/code-mode-proxy.ts`). The orchestrator cannot reach
`PolicyEngine`, `AuditLog`, or the rest of the security kernel through
this handle -- it only binds the control server. The interface returns
`null` before `start()` completes, so single-session callers (CLI,
daemon, cron) that never need to attach a control server simply ignore
the accessor. This is "least authority" applied to the workflow plumbing:
the policy hot-swap path does not widen the blast radius of the seam
between the orchestrator and the in-process coordinator.

### D4 -- Logger / control-socket lifecycle: session owns claim; setup retargets

The design treated the coordinator control socket and per-state logger
wiring as either "always on in workflow mode" (§2.2) or a simple
accessor to be called once at workflow start (§3
`createWorkflowInfrastructure` entry). In practice, per-state session
artifacts (`session.log`, `session-metadata.json`) live under
`states/{stateSlug}/` (D2), and the logger stream must be explicitly
retargeted on each re-entry so a single workflow run produces
per-invocation log files rather than one appended file. This
responsibility is split: the session owns the *claim* on its state
slug (and guarantees unique `{stateId}.{visitCount}` values), and the
infrastructure setup in `docker-infrastructure.ts` retargets the
appropriate log sinks when constructing the per-state session on top
of the shared bundle. Teardown is the mirror of setup -- per-state
logger teardown is explicit on session close, separate from the
bundle-level `destroyDockerInfrastructure` that only runs when the
workflow itself terminates. Commits `479f998`
(consolidate session artifacts under `workflow-runs/`) and `8551045`
(improve session handling for resumed conversations) carry the bulk
of this work.

### D5 -- Hardening: `validatePolicyDir` and related checks

The design treated `policyDir` (and related paths reaching into the
coordinator over the control socket) as trusted input from the
orchestrator. Implementation review added a defense-in-depth layer:
`validatePolicyDir()` (re-exported from `src/config/validate-policy-dir.js`
and called on the session side) enforces that any policy directory
handed to a session / coordinator lives under the IronCurtain home or
the package config dir. This closes a path-confusion hole that would
otherwise let a malformed workflow checkpoint or a compromised
orchestrator state point the coordinator at arbitrary filesystem
locations during `loadPolicy`. Commit `11c1c4d`
(fix(trusted-process): hardening from PR review) is the canonical
record. Related hardening in the same series tightened
`destroyWorkflowInfrastructure` retry semantics (see §3's updated
JSDoc at `src/workflow/orchestrator.ts` line ~522, and commit
`5cc617f`) so that cleanup cannot double-destroy the same Docker
resources under a race between the fire-and-forget destroy and
`shutdownAll()`.

### End-to-end test

An integration test at `test/workflow-policy-cycling.integration.test.ts`
exercises the Step 5 happy path end-to-end (workflow start →
per-state policy swap → audit tagging → terminal teardown). It is the
canonical executable spec for the shipped design; discrepancies
between this document and that test should be resolved in favor of
the test until this document is rewritten.

## 11. Revision history

### v4 -- UTCP spike outcome, placement clarifications, tool-call mutex

v3 left three areas under-specified that the final review flagged as
blockers. v4 resolves each:

**B1 -- Placement of three ambiguous pieces in §2.1 / §3.**

- `validateToolArguments` against `inputSchema`
  (`mcp-proxy-server.ts:720`) moves to the coordinator, not the
  subprocess. Rationale: it is gated on
  `policyEngine.isTrustedServer()` (which would otherwise have to be
  re-plumbed back down) and it synthesizes a policy-gate audit entry
  with `policyDecision.status === 'deny'` + rule
  `'invalid-arguments'`. Keeping all policy-gate outcomes emitted
  from one place is the invariant. Added to "What moves" list and to
  the new ordering spec.
- `ServerContext` post-success update (`updateServerContext`,
  `mcp-proxy-server.ts:1034`) runs in the coordinator's post-call
  band, after the subprocess returns a non-error result and before
  the coordinator returns to UTCP. New ordering diagram in §2.1
  makes pre-call (validate → normalize → policy → audit-on-deny) vs.
  post-call (server-context update on success, audit-on-success)
  explicit, including where audit writes happen relative to the
  outbound MCP dispatch.
- `MITM_CONTROL_ADDR` retention clarified in §2.1 "What stays in
  each subprocess" -- the virtual-proxy subprocess
  (`SERVER_FILTER=proxy`) continues to receive this env var for its
  `add_proxy_domain` / `remove_proxy_domain` / `list_proxy_domains`
  tools, which IPC into the MITM control server via
  `ControlApiClient`. Added a "Note on terminology" paragraph
  distinguishing the new coordinator control socket (§4) from the
  MITM control address and from `SESSION_LOG_PATH`; the subprocess
  is free of the *coordinator* control channel but not of all
  control-channel env vars.

**B2 -- UTCP integration spike.**

Spike outcome: **direct in-process hook is feasible.** The UTCP SDK
(`node_modules/@utcp/sdk/dist/index.d.ts`) exposes
`CommunicationProtocol` as a public abstract class and maintains a
static registry `CommunicationProtocol.communicationProtocols` that
`@utcp/mcp` mutates from its own `register()` function -- so any
external protocol can register itself the same way. IronCurtain
defines a new `'ironcurtain'` call-template type with a trivial
serializer and an `IronCurtainCommunicationProtocol` whose
`callTool()` invokes `coordinator.handleToolCall()` directly in the
host process. No stdio bridge, no subprocess between UTCP and the
coordinator; one UTCP manual registration replaces the per-backend
`mcpServers` record. Added a "UTCP integration: direct in-process
hook (spike confirmed)" subsection in §2.1 with the data-path
diagram and concrete changes to `src/sandbox/index.ts:361-412`.

**B3 -- Parallel-states concurrency (tool-call mutex).**

`parallelKey` is confirmed to be a live codebase feature
(`src/workflow/types.ts:121`, `src/workflow/validate.ts:33`), not
future work. The "Concurrency / thread-safety of the centralized
engine" subsection in §2.1 is rewritten to:

- Identify the three coordinator-owned caches that race under
  genuinely concurrent `handleToolCall`: `ApprovalWhitelist`
  (read-modify-write on approve/match), `CallCircuitBreaker`
  (sliding-window counter), `ServerContextMap` (read in git-path
  enrichment, mutated on post-success).
- Introduce two distinct mutexes: **policy mutex** (held only
  during `loadPolicy`'s swap window) and **tool-call mutex** (held
  during the full `handleToolCall` body). Chose option A (hold the
  tool-call mutex for the full body) for v1; option B (release
  around the awaited MCP dispatch) is noted as a deferred
  optimization.
- Document the performance implication: concurrent tool calls from
  parallel homogeneous-persona states serialize through the
  coordinator; acceptable because tool calls are IO-bound.
- Reject parallel heterogeneous personas at both the schema layer
  (new validator check, §7) and the coordinator layer (mismatched
  persona in `loadPolicy`).

§8 "Parallel states" rewritten to reflect that homogeneous-persona
parallelism works today under the tool-call mutex; heterogeneous
personas remain out of scope for v1 and rejected at validation
time. §4 "Audit writer concurrency" simplified -- the earlier
"serialize policy cycles at the engine layer" language is replaced
by a reference back to the §2.1 mutex spec.

**Nits (applied as-is).**

- N1: the MITM paths (`/__ironcurtain/domains/...`) stay where they
  are; the new coordinator endpoint uses
  `/__ironcurtain/policy/load`. §4 "Control protocol details" adds
  a "Path-prefix convention" paragraph noting the intentional
  namespace split (MITM is a separate server for a separate
  concern).
- N2: §3 `getWorkflowProxyControlSocketPath` gains a note about
  macOS UDS path length (103-104 chars) with a suggested hash-based
  truncation strategy for long workflowIds.
- N3: §3 `mcp-proxy-server.ts` entry for `AUDIT_LOG_PATH` removal
  pins the plumbing: the coordinator reads `config.auditLogPath`
  directly from `IronCurtainConfig`; no gap.
- N5: §6 TCP-mode stale cleanup adds a sentence on
  `docker rm -f` failure (log warning, proceed; stale-name
  collision not a concern because new sessionId produces a new
  deterministic name).
- N6: §6 "One match" case clarifies that `docker.isRunning()`
  returns false for `paused` containers, so they fall into the
  "remove and re-create" branch.
- N7: §6 resume audit filename uses the cleaner glob-friendly
  `.resumed.{ts}.jsonl` segment pattern (was `-resumed-{ts}`).
- N8: §3 `docker-infrastructure.ts` entry notes that `ensureImage`
  becomes module-internal (no longer exported) after the refactor.
- N9: §3 `src/session/index.ts` entry pins the explicit choice --
  `createDockerInfrastructure()` accepts a
  `systemPromptAugmentation` parameter (the caller-mutation
  alternative is ruled out because
  `DockerInfrastructure.systemPrompt` is `readonly`); workflow-mode
  per-state augmentations are layered through `SessionOptions`
  downstream.

No design decision from v3 is reversed; v4 only resolves
ambiguities flagged in final review, confirms the UTCP integration
path by spike, and tightens the concurrency model for parallel
states.

### v3 -- Concrete ownership model via `DockerInfrastructure` + `ownsInfra`

v2 left the ownership refactor as a TODO: "the concrete interface
(`owns: {container, proxy, mitm}`, or separate `externalContainer` /
`preBuiltInfrastructure` fields that imply 'borrowed') is a separate
discussion." v3 fills that in.

Chosen model: a typed `DockerInfrastructure` bundle groups all
workflow-level Docker resources (container, optional sidecar + internal
network, MITM proxy, Code Mode proxy + contained coordinator, CA, fake
keys). `DockerAgentSession` holds a reference to the bundle plus a
single `ownsInfra: boolean` flag. `close()` conditionally calls
`destroyDockerInfrastructure(infra)` based on that flag. Both standalone
and workflow modes use the same `DockerAgentSession` class; only the
owner of the infrastructure differs.

Key changes from v2:

- §2.2 "Docker adapter" -- the ownership TODO is replaced by a
  full-depth specification: the `DockerInfrastructure` shape (extending
  the existing interface at
  `src/docker/docker-infrastructure.ts:36-61`), paired
  `createDockerInfrastructure()` / `destroyDockerInfrastructure()`
  factory and destroyer, `DockerAgentSession` constructor taking
  `(infra, ownsInfra, ...)`, and the two call sites (standalone =
  `ownsInfra=true`, workflow = `ownsInfra=false`). The existing
  `preBuiltInfrastructure` field is identified as subsumed by this
  model and slated for removal.
- §2.2 "Engine" and "Session" subsections -- retargeted to
  `DockerInfrastructure` / `workflowInfrastructure` / `ownsInfra`
  terminology. No separate `WorkflowContainer` abstraction; the bundle
  is reused.
- §3 file-by-file changes -- rewritten sections for
  `src/session/types.ts`, `src/session/index.ts`,
  `src/docker/docker-agent-session.ts`,
  `src/docker/docker-infrastructure.ts`, and
  `src/workflow/orchestrator.ts`. Specifies that
  `prepareDockerInfrastructure` is renamed to
  `createDockerInfrastructure` (existing function already returns a
  `DockerInfrastructure` type; the refactor extends its return shape
  and folds container creation into it). Specifies the collapsed
  `DockerAgentSessionDeps` interface.
- §5 ownership matrix -- collapses the per-resource rows for
  `CodeModeProxy`, MITM proxy, CA, fake keys, container, etc. into a
  single `DockerInfrastructure` bundle row with conditional ownership.
  Clarifies that `ownsInfra` is the single switch.
- §8 -- the "`DockerAgentSession` ownership-model refactor" follow-up
  is replaced with a "Third caller" entry noting that the daemon's
  pre-built-proxies use case is the same mechanism with no additional
  API surface. The TODO is resolved, not deferred.
- §9 rollout order step 2 -- expanded into a concrete five-sub-step
  plan: define the extended bundle interface, rename + fold container
  creation into `createDockerInfrastructure`, extract
  `destroyDockerInfrastructure`, update the session constructor, then
  the standalone factory. Standalone mode remains fully functional at
  every intermediate point. Former step 4 ("externalContainer branch")
  is rewritten as the "borrow path" (bundle in, `ownsInfra=false`);
  there is no longer a separate `externalContainer` concept.
- §9 backward-compat "Session API" -- `SessionOptions.workflowContainer`
  renamed to `workflowInfrastructure` (type:
  `DockerInfrastructure`). `DockerAgentSessionDeps.preBuiltInfrastructure`
  is explicitly removed.

No design decision from v2 is reversed; v3 only makes the ownership
model concrete and retargets the names/types that depended on it.

### v2 -- Centralized PolicyEngine + AuditLog

Architectural correction made after review flagged that the v1 design
assumed a single MCP proxy process when the code actually spawns N
`mcp-proxy-server` subprocesses behind the Sandbox (one per backend MCP
server). Each subprocess held its own `PolicyEngine` / `AuditLog` /
`ApprovalWhitelist` / `CallCircuitBreaker`, and all of them wrote
concurrently to the same audit file -- a latent interleaving hazard and
a blocker for any runtime control protocol.

Key changes from v1:

- New §1 subsection "Proxy process topology today (the original design got
  this wrong)" documents the N-subprocess reality with code refs to
  `src/sandbox/index.ts:374-406`,
  `src/trusted-process/mcp-proxy-server.ts:1120-1128`, and
  `src/trusted-process/audit-log.ts:11-17`.
- New §2.1 "PolicyEngine + AuditLog centralization" specifies lifting
  those primitives up to a new `ToolCallCoordinator` in the Sandbox /
  CodeModeProxy layer. Subprocesses become thin tool routers speaking
  standard MCP stdio -- no new wire protocol. `CallCircuitBreaker`,
  `ApprovalWhitelist`, and `ServerContextMap` centralize alongside
  policy + audit; justification included.
- §2.2 renames the former "Proxy" subsection to clarify that the control
  socket attaches to the coordinator, not to a subprocess. `loadPolicy`
  becomes a single atomic in-process operation guarded by a mutex; the
  multi-subprocess broadcast/barrier problem disappears.
- §3 updates the file-by-file change list: adds
  `src/trusted-process/tool-call-coordinator.ts` (new) and
  `src/sandbox/index.ts`; strips policy/audit/escalation from
  `src/trusted-process/mcp-proxy-server.ts`; adjusts the session
  helpers to route through `CodeModeProxy.getCoordinator()`.
- §4 "Audit writer concurrency" replaces the cross-process coordination
  discussion with single-process semantics: rotation queues on the policy
  mutex; `log()` stays synchronous; no buffering in `AuditLog` itself.
- §5 ownership matrix now lists the coordinator as owner of the live
  `PolicyEngine` / `AuditLog` references.
- §6 adds a new subsection on tool-router subprocess crash recovery
  (coordinator keeps working; failed backend returns errors to agent; no
  auto-restart in v1). macOS TCP-mode resume is updated to explicitly
  require stale-labeled-container cleanup before creating a fresh one.
- §8 parallel-states discussion updated: parallel states now implicitly
  serialize on the coordinator's policy mutex; parallel heterogeneous
  personas are still out of scope, but the future-fix is simpler because
  there's exactly one place (the coordinator) that needs a per-invocation
  engine lookup.
- §8 adds a new entry acknowledging that the existing
  `preBuiltInfrastructure` does NOT establish a borrow-vs-own precedent
  (reviewer flag: `DockerAgentSession.close()` unconditionally cleans up
  everything at `src/docker/docker-agent-session.ts:545-561`). Marks the
  ownership-model refactor as a prerequisite to workflow-container work,
  with the concrete interface left as a TODO.
- §9 rollout order gains a new step 1 (centralization refactor) and a new
  step 2 (`DockerAgentSession` ownership refactor). Former step 1 (audit
  rotation + policy reload plumbing) becomes step 3, now attaching to the
  coordinator. Former step 3 ("multi-subprocess coordination") is deleted
  entirely -- no longer needed.
- §9 backward-compat: `AUDIT_LOG_PATH` is now removed from the subprocess
  env; coordinator control socket is plumbed in via
  `CodeModeProxy.start({ controlSocketPath })` rather than an env var,
  matching the ownership model.

### v1 -- Initial workflow-scoped container design

Original proposal. Introduced `WorkflowContainer`, `freshContainer`,
per-state policy cycling, and audit file naming
`audit.{persona}.{version}.jsonl`. Structurally assumed a single MCP
proxy process with one `PolicyEngine` + one `AuditLog` -- an assumption
corrected in v2.
