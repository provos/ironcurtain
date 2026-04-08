let's# Workflow Implementation v2: Findings & Open Issues

Critical review of `workflow-implementation-v2.md` by clean-implementer, grounded
against the actual codebase at commit `c879083`. Each finding is cross-referenced
against v1 findings (F-1 through F-14), XState v5 documentation, and the live
source code.

---

## Blocking Issues

### V2-F-1: `TabBackend` interface is missing 3 methods used by MuxApp
**Severity:** Blocking
**Source:** Section 6.1 (TabBackend interface), Section 6.4 (Migration impact)

The proposed `TabBackend` interface defines: `terminal`, `alive`, `sessionId`,
`escalationDir`, `write`, `resize`, `kill`, `onOutput`. The v2 design claims
"PtyBridge already satisfies TabBackend" and the migration is "a type-level
narrowing, not a behavioral change."

This is false. `PtyBridge` has three additional members actively used by MuxApp
that `TabBackend` does not include:

1. **`onExit(callback)`** -- used at `mux-app.ts:571` to register cleanup on
   tab death (triggers splash screen restore, tab removal). `WorkflowTabBackend`
   has no concept of "exit" -- when does a workflow tab die?

2. **`pid`** -- used at `mux-app.ts:730` to match PTY session registrations to
   tabs by PID. The `isInteractive()` function in v2 uses `'pid' in backend` as
   a discriminator, but this is duck-typing rather than a type-safe
   discriminated union.

3. **`updateRegistration(registration)`** -- used at `mux-app.ts:731` for late
   session discovery back-fill. Workflow tabs don't need this, but the call site
   will fail unless `backend` is narrowed first.

Additionally, `PtyBridge` has `exitCode` and `onSessionDiscovered` which are
accessed in the mux. The migration is not a simple rename -- it requires either:
- Expanding `TabBackend` to include these (which pollutes it with PTY-specific
  concerns), or
- A discriminated union (`TabBackend = PtyBackend | WorkflowBackend`) with
  type guards at every access site, or
- Keeping `PtyBridge` as-is and making `MuxTab.backend` a union type with
  narrow call-site checks.

**Options to explore:**
- (a) Define `TabBackend` as the minimal common interface. Use type guards
  (`isPtyBackend(b)`) at the ~6 sites that need PTY-specific members.
- (b) Make `TabBackend` a discriminated union with `kind: 'pty' | 'workflow'`.
- (c) Keep `PtyBridge` separate; `MuxTab` has `backend: PtyBridge | WorkflowTabBackend`.

---

### V2-F-2: `DockerManager.exec()` does not accept AbortSignal
**Severity:** Blocking
**Source:** Section 5.2 (Abort for Docker sessions)

The v2 design proposes Docker abort via:

```typescript
private activeExecAbort: AbortController | null = null;
async abort(): Promise<void> {
  this.activeExecAbort?.abort();
  // docker.exec respects AbortSignal to kill the exec process
}
```

The actual `DockerManager.exec()` signature is:

```typescript
exec(nameOrId: string, command: readonly string[], timeoutMs?: number): Promise<DockerExecResult>;
```

It does not accept an `AbortSignal`. The implementation uses
`child_process.execFile` with a `timeout` option, not a signal. Aborting a
running `docker exec` requires either:

1. Adding `AbortSignal` support to `DockerManager.exec()` (changes to
   `docker-manager.ts` using `execFile` with `signal` option), or
2. Running `docker exec` via `spawn` instead of `execFile` and killing the
   spawned process, or
3. Running `docker kill` on the container (nuclear option -- kills the
   container, not just the exec).

The v2 design says "docker.exec respects AbortSignal" but this is not true of
the current implementation. This is a prerequisite for `abort()` on Docker
sessions.

**Options to explore:**
- (a) Add an optional `signal?: AbortSignal` parameter to `DockerManager.exec()`.
  Switch the implementation from `execFile` to `spawn` with signal forwarding.
- (b) Keep `execFile` but spawn a concurrent `docker exec kill` to send SIGTERM
  to the process inside the container.
- (c) Use a separate child process handle (`spawn`) for workflow exec calls only.

---

### V2-F-3: First `sendMessage()` always uses `--continue`, which may fail silently
**Severity:** Blocking
**Source:** Section 2.1 (Docker Mode), Section 5.1 (Session Resumption)

The Claude Code adapter's `buildCommand()` always includes `--continue`:

```typescript
buildCommand(message: string, systemPrompt: string): readonly string[] {
  return ['claude', '--continue', '--dangerously-skip-permissions', ...];
}
```

For the first `sendMessage()` in a new workflow session, there is no prior
conversation to continue. The `start-claude.sh` PTY script handles this with a
fallback (`if [ $STATUS -ne 0 ]; then` fresh start), but `buildCommand()` is
used by `DockerAgentSession.sendMessage()` for non-PTY exec, which does NOT have
this fallback. If `claude --continue` exits non-zero when no conversation exists,
the first turn will return an error response rather than starting fresh.

The v2 design assumes `claude --continue` gracefully starts a new conversation
when none exists. This needs verification. If `claude --continue` fails with a
non-zero exit code when no prior conversation exists, every workflow's first
agent invocation will fail.

**Options to explore:**
- (a) Add a `firstTurn: boolean` flag and use a `buildFirstCommand()` that omits
  `--continue`.
- (b) Modify the adapter to handle the "no conversation to continue" case in
  `extractResponse()` by detecting the specific error and retrying without
  `--continue`.
- (c) The adapter could use separate command builders for first-turn vs
  continuation, exposed as `buildInitialCommand()` and `buildContinueCommand()`.

---

### V2-F-4: XState `snapshot.value` is not always a string for nested/parallel states
**Severity:** Blocking
**Source:** Section 3.3 (Orchestrator Execution Loop)

The orchestrator subscribes to snapshots and treats `snapshot.value` as a string:

```typescript
this.actor.subscribe((snapshot) => {
  const currentState = snapshot.value;
  const stateDef = definition.states[currentState as string];
  if (stateDef?.type === 'human_gate') { ... }
});
```

In XState v5, `snapshot.value` is a `string` only for flat states. For nested
states it is `{ parent: 'child' }` and for parallel states it is
`{ region1: 'state1', region2: 'state2' }`. Section 3.5 introduces parallel
states for coders. When the machine is in a parallel state, `snapshot.value`
will be an object, `definition.states[currentState as string]` will be
`undefined`, and human gate detection will silently fail.

This affects:
- Human gate detection in the subscribe callback
- The `getStatus()` method (which needs to extract `currentState` for
  `WorkflowStatus`)
- Checkpoint serialization (`machineState` field)
- Transition logging

**Options to explore:**
- (a) Use `snapshot.matches('stateName')` instead of comparing `snapshot.value`
  directly. This handles nested and parallel states correctly.
- (b) Normalize `snapshot.value` to a flat state name by extracting leaf states
  from the object representation.
- (c) Track human gate states in a Set and use `snapshot.matches()` to test
  each one.

---

### V2-F-5: XState `provide` cannot replace `fromPromise` actors with different `fromPromise` actors
**Severity:** Significant (potentially Blocking)
**Source:** Section 3.2 (Machine Builder) and Section 3.3 (Orchestrator)

The machine builder creates placeholder actors:

```typescript
actors: {
  agentService: fromPromise<AgentInvokeResult, AgentInvokeInput>(
    async ({ input, signal }) => {
      throw new Error('agentService must be provided at runtime');
    },
  ),
}
```

Then the orchestrator replaces them:

```typescript
machine.provide({
  actors: {
    agentService: fromPromise(async ({ input, signal }) => {
      return this.executeAgentState(input, signal);
    }),
  },
})
```

In XState v5, `provide` IS designed for this exact pattern -- replacing actors
defined in `setup()`. However, there is a subtle issue: the replacement
`fromPromise` call in the orchestrator does not specify the generic type
parameters `<AgentInvokeResult, AgentInvokeInput>`. TypeScript will infer them,
but if the inference doesn't match the original declaration, the `provide` call
will produce a type error.

More critically: when `provide` replaces an actor, the new actor must be
compatible with the original's type signature. The v2 code creates a new
`fromPromise` in the orchestrator's `provide` call. This should work as long as
the input/output types match. The design is fundamentally sound here, but the
implementation sketch omits the type annotations that make it actually compile.

**Verdict:** Likely implementable but needs explicit type annotations on the
`provide` call to satisfy TypeScript's strict mode. Not blocking, but the
sketch as-written will not compile.

---

## Significant Issues

### V2-F-6: `WorkflowSession` interface is never defined
**Severity:** Significant
**Source:** Section 2.2 (Builtin Mode), Section 3.3 (Orchestrator)

The orchestrator's `activeSessions` is typed as `Map<string, WorkflowSession>`.
`WorkflowSessionFactory.create()` returns `Promise<WorkflowSession>`. But
`WorkflowSession` is never defined in the document. It is referenced 8 times
but never given a type definition.

Is it just `Session` from `src/session/types.ts`? If so, it lacks `abort()`.
Is it `Session` extended with `abort()`? If so, where is it defined?

The v1 design had the same ambiguity but was less concrete. v2 needs to decide:
is `WorkflowSession` a new interface extending `Session`, a type alias for
`Session`, or something else entirely?

**Options to explore:**
- (a) `WorkflowSession = Session` -- simplest, but blocks on adding `abort()`
  to `Session` first (which is proposed in Section 5.2).
- (b) `WorkflowSession = Session & { abort(): Promise<void>; sessionId: string }`
  -- extends Session with workflow-specific needs.
- (c) Define it as a minimal interface: `{ sendMessage, abort, close, sessionId }`.

---

### V2-F-7: Container-per-role model conflicts with DockerAgentSession lifecycle
**Severity:** Significant
**Source:** Section 2.1, Section 5.1

The v2 design says "the container persists across rounds within a workflow state"
and "the container is stopped when the state transitions to a different role."
This implies creating one `DockerAgentSession` per role, keeping it alive across
coder-critic rounds, and closing it when the workflow moves to a different state.

But the workflow runs coder -> critic -> coder -> critic loops. The v2 design
says each round creates a new sendMessage to the existing session. This means:

- The **coder** session stays alive during the **critic** phase (the container
  is idle but running). This wastes Docker resources.
- Alternatively, the coder session is closed when transitioning to the critic
  state. But then "resume" requires re-creating the container, and
  `DockerAgentSession` does not support reattaching to an existing container --
  `initialize()` always creates a new one.

The design says "the container is created once per role" but the orchestrator
creates a new session per state invocation (via the session factory). If the
coder state is invoked 4 times (4 review rounds), does it create 4 containers
or reuse one?

The `getOrCreateSession` method (referenced at line 578) is never defined.
This is where the container reuse logic would live, but it's a sketch
placeholder.

**Options to explore:**
- (a) Keep containers alive for the duration of the workflow. Each role gets one
  persistent container. Accept the resource cost (N containers running
  simultaneously).
- (b) Create/destroy containers per invocation. Accept the startup overhead
  (~5-10s per container creation). Use `--continue` with conversation state
  persistence (already supported via `.claude.json` save/restore in the adapter).
- (c) Implement container pooling in the session factory.

---

### V2-F-8: Artifact collection relies on convention, not contract
**Severity:** Significant
**Source:** Section 4.3 (Assembling Context), Section 4.4 (Concrete Flow)

The `collectArtifacts()` method (referenced at line 607) is never defined. The
design shows the orchestrator reading artifact files from known paths, but the
mechanism by which the orchestrator knows *which* files the agent produced is
unclear.

The flow assumes:
1. The agent writes files to `/artifacts/{output}/` inside the container
2. The orchestrator reads those files from the host bind-mount path

But how does the orchestrator know the filenames? Options:
- (a) Convention: the orchestrator expects `plan.md`, `spec.md`, etc.
- (b) The agent_status block includes a list of output files
- (c) The orchestrator scans the output directory for new files

The `AgentOutput` interface includes `outputHash` (SHA-256 of primary output)
but no file list. Stall detection compares output hashes, but the orchestrator
needs the actual file paths to populate `context.artifacts`. This gap means
either:
- The artifact names are hardcoded per state (fragile), or
- A new field is needed in `AgentOutput` (contract change), or
- Directory scanning is used (race condition with async writes)

**Options to explore:**
- (a) Add `artifactPaths: Record<string, string>` to `AgentOutput` and
  require agents to enumerate their output files.
- (b) Define a strict naming convention per state type (e.g., architect always
  writes `spec/spec.md`). Document it in the workflow definition.
- (c) Scan the output directory after sendMessage completes and diff against
  pre-existing files.

---

### V2-F-9: Guard translation is a stub that returns the input unchanged
**Severity:** Significant
**Source:** Section 3.2 (Machine Builder), lines 459-465

```typescript
function translateGuard(guard: string): string {
  // Map definition guard strings to registered XState guard names.
  // The translation is a simple lookup table; no eval().
  return guard;
}
```

This function is documented as performing a lookup but literally returns its
input unchanged. Guard strings from the workflow definition (e.g.,
`"round < maxRounds"`, `"testCountOk"`) are passed directly as XState guard
names. Since `setup()` only registers specific guard names (`isApproved`,
`isRejected`, `isRoundLimitReached`, etc.), any definition guard string that
doesn't exactly match a registered name will cause XState to throw at runtime.

The comment says "The translation is a simple lookup table" but no table exists.
This is a missing implementation, not a stub.

**Options to explore:**
- (a) Implement the lookup table mapping definition DSL guard expressions to
  XState guard names.
- (b) Require workflow definitions to use XState guard names directly
  (eliminates the translation layer but couples the definition format to XState).
- (c) Support a small expression language that compiles to guard functions at
  build time.

---

### V2-F-10: The agent_status output hash is supposed to be computed by the agent
**Severity:** Significant
**Source:** Section 4.3 (STATUS_BLOCK_INSTRUCTIONS)

The status block instructions tell the agent:

```
output_hash: "<SHA-256 of your primary output artifact>"
```

This asks the LLM to compute a SHA-256 hash. LLMs cannot reliably compute
cryptographic hashes. The hash will be wrong, rendering stall detection
(which compares `output.outputHash === context.previousOutputHash`) unreliable.

Two identical outputs might get different (wrong) hashes, causing stall
detection to miss. Two different outputs might get the same hallucinated hash
(less likely but possible).

**Options to explore:**
- (a) Compute the hash on the orchestrator side after collecting artifacts.
  Remove `output_hash` from the agent_status block.
- (b) Use a simpler stall signal: ask the agent to report a boolean
  `made_changes: true | false` and verify by diffing files.
- (c) Compute the hash of the diff/patch file that the orchestrator captures.

---

### V2-F-11: Volume mount scoping for Docker containers is under-specified
**Severity:** Significant
**Source:** Section 4.2 (Docker containers access artifacts)

The `resolveVolumeMounts()` function shows per-input/output mounts, but
`DockerAgentSession` does not support dynamic volume mounts. Looking at the
codebase:

- Container creation happens in `initialize()` via `docker.create(config)`.
- `DockerContainerConfig.mounts` is set at creation time and cannot be changed.
- The orchestrator creates one container per role (Section 2.1).

This means all volume mounts must be known at container creation time. But the
v2 design implies mounts vary per state invocation (different inputs/outputs
per state). If a role is used in multiple states with different artifact
requirements, the container either needs all possible mounts at creation, or
must be recreated.

For example, the coder gets `spec` as input in the first round and also gets
`reviews` in subsequent rounds. The container must have both mounts from the
start, even though `reviews/` doesn't exist yet.

**Options to explore:**
- (a) Mount the entire artifact directory read-write and rely on constitutions
  to scope access. Simpler but weaker isolation.
- (b) Mount all possible paths at creation time (union of all states for this
  role). Accept that some mounts point to empty directories initially.
- (c) Recreate containers when mount requirements change (breaks session
  continuity).

---

## Architectural Concerns

### V2-F-12: Parallel execution via `Promise.allSettled` inside a single invoke is fragile
**Severity:** Architectural concern
**Source:** Section 3.5 (Parallel Agent States)

The design starts by describing XState parallel state nodes (correct approach)
but then pivots to "in practice" using `Promise.allSettled` inside a single
invoked promise:

```typescript
const results = await Promise.allSettled(tasks);
return this.aggregateParallelResults(results, context);
```

This means XState sees a single invoke for the entire parallel execution. If
one coder detects a `SPEC_FLAW`, the design spec says "the orchestrator
broadcasts CANCEL to all sibling coders" -- but XState cannot cancel individual
children because they're all inside one promise. The `signal.addEventListener`
abort fires only when the parent state exits, killing ALL coders simultaneously.

There is no mechanism for:
- Early termination of one parallel slot (the `pLimit` tasks run to completion
  or all abort together)
- Per-slot status reporting to the UI (the invoke resolves atomically)
- Partial checkpoint (you lose all parallel progress on crash)
- `SPEC_FLAW_DETECTED` from one coder while others continue

The `Promise.allSettled` approach is effectively sequential-in-parallel
execution wrapped in a single XState transition. It works for the happy path
but cannot model the spec-flaw cancellation pattern described in the
architecture spec (Section 3.2 of the high-level design).

**Options to explore:**
- (a) Use XState's `spawn` API to create individual child actors. Each coder
  is a spawned actor that can be individually stopped. The parent state
  monitors all children and transitions when all complete or one reports a flaw.
- (b) Accept the limitation: spec-flaw cancellation aborts all coders, not
  just siblings. This is simpler and may be acceptable for MVP.
- (c) Use a separate XState machine for the parallel execution state, with
  each coder as a child state in a parallel compound node.

---

### V2-F-13: Checkpoint cannot capture mid-invoke state
**Severity:** Architectural concern
**Source:** Section 3.4 (XState Async Model), v1 Section A.6 (Checkpointing)

The v2 design checkpoints on state transitions. But when a promise-based invoke
is running (an agent is executing), the XState snapshot represents the state
as "in state X, invoke running." The promise's internal state (which turn of
the conversation, how many tokens consumed, which artifacts written so far) is
not captured.

If the orchestrator crashes during a 10-minute agent execution:
- The checkpoint says "state = implement, invoke active"
- On restore, XState re-enters the implement state and re-invokes the agent
  service from scratch
- The agent starts a fresh conversation (no `--continue` to the previous
  session, because the session ID isn't checkpointed mid-invoke)
- Any partial work (files written by the agent before the crash) persists in
  the worktree, but the agent doesn't know about it

This was acknowledged in v1 (Section A.6: "mid-turn resumption would require
replaying partial AI SDK state, which is not supported"). The concern is that
the v2 design makes it worse: with Docker containers and `--continue`, the
container state is also lost on crash (the container is killed when the
orchestrator exits).

**Mitigation:** This is inherent to the invoke model. Document that crash
during an agent turn loses that turn's work. Worktree contents survive. The
agent re-enters the state and may redo work. This is acceptable for a local
tool but should be explicitly acknowledged.

---

### V2-F-14: `readFileSync` in `buildAgentCommand` blocks the event loop
**Severity:** Architectural concern
**Source:** Section 4.3

```typescript
const content = readFileSync(path, 'utf-8');
```

The `buildAgentCommand` function uses synchronous file I/O to read artifact
files. For small artifacts this is fine, but design specs and review histories
can grow large (100KB+). During parallel execution, multiple
`buildAgentCommand` calls block the event loop sequentially.

**Options to explore:**
- (a) Use `readFile` (async) instead. The function is already inside an async
  promise invocation.
- (b) Accept it for MVP; optimize if profiling shows a bottleneck.

---

### V2-F-15: `WorkflowSessionCreateOptions.onEscalation` conflicts with registration-file approach
**Severity:** Architectural concern
**Source:** Section 2.2 (WorkflowSessionCreateOptions) vs Section 7.5 (Escalation Discovery)

The `WorkflowSessionCreateOptions` interface includes escalation callbacks:
```typescript
readonly onEscalation?: (request: EscalationRequest) => void;
readonly onEscalationExpired?: () => void;
readonly onEscalationResolved?: (id: string, decision: 'approved' | 'denied') => void;
```

But Section 7.5 says workflow sessions write PTY registration files so the
existing `MuxEscalationManager` discovers them via filesystem polling. These
are two different escalation routing mechanisms for the same session:

1. Callback-based (orchestrator receives escalations directly)
2. File-based (escalation manager polls the filesystem)

Which one is used? If both, escalations could be double-counted. If only
file-based, the callbacks in `WorkflowSessionCreateOptions` are dead code.
If only callback-based, the registration file write (Section 7.5) is
unnecessary.

**Options to explore:**
- (a) Use file-based only (consistent with existing Docker sessions). Remove
  escalation callbacks from `WorkflowSessionCreateOptions`.
- (b) Use callback-based only. Don't write registration files. Add a
  programmatic `addSession()` to `MuxEscalationManager` instead.
- (c) Use file-based for Docker sessions and callback-based for builtin
  sessions. Make the choice inside the session factory.

---

## V1 Issue Resolution Status

### F-1: Session resumption doesn't preserve conversation history
**Status:** Addressed
**v2 resolution:** Docker mode uses `claude --continue` for conversation
continuity. Builtin mode reconstructs messages from JSONL logs.
**Gap:** The v2 design assumes `claude --continue` always works for the first
turn (see V2-F-3). Also, `getOrCreateSession` (the session reuse mechanism)
is never defined (see V2-F-7).

### F-2: System prompt augmentation is immutable after session creation
**Status:** Addressed
**v2 resolution:** Review/critique input is passed as a new `sendMessage()`
command, not via system prompt mutation. The system prompt is set once at
session creation; new context goes into the message.
**Gap:** None -- this is clean. The `buildAgentCommand()` function assembles
context per invocation.

### F-3: No abort/cancellation for in-flight sendMessage()
**Status:** Partially addressed
**v2 resolution:** `abort()` added to `Session` interface. Builtin uses
`AbortController`. Docker kills the exec process.
**Gap:** Docker abort does not work because `DockerManager.exec()` doesn't
accept `AbortSignal` (see V2-F-2). Builtin abort uses `AbortSignal.any()`
which requires Node 20+ (project targets 22+, so this is fine).

### F-4: MuxTab requires PtyBridge
**Status:** Partially addressed
**v2 resolution:** `TabBackend` interface abstracts `PtyBridge`.
**Gap:** `TabBackend` is missing 3 methods that MuxApp actively uses (see
V2-F-1). The migration is more invasive than described.

### F-5: Escalation manager requires PtySessionRegistration
**Status:** Addressed
**v2 resolution:** Workflow sessions write PTY-compatible registration files.
`MuxEscalationManager` discovers them unchanged.
**Gap:** Potential double-routing with callback-based escalations (see
V2-F-15).

### F-6: Human gates don't fit the approve/deny escalation model
**Status:** Addressed
**v2 resolution:** Parallel gate system with `GateState`, `PendingGate`,
`GateResolution`, and a dedicated `gate-picker` input mode. Separate from
policy escalations.
**Gap:** None -- the gate types are well-defined and clearly distinct from
escalations.

### F-7: XState async execution model is unspecified
**Status:** Addressed
**v2 resolution:** XState `invoke` with `fromPromise` services. Agent states
invoke the promise on entry; XState manages the lifecycle.
**Gap:** Guard translation is a stub (V2-F-9). Snapshot value handling is
incorrect for parallel states (V2-F-4). The `provide` API usage is correct in
concept but needs type annotations (V2-F-5).

### F-8: Missing agent_status block handling
**Status:** Addressed
**v2 resolution:** Re-prompt once via `sendMessage(buildStatusBlockReprompt())`.
If retry fails, treat as `AGENT_FAILED`.
**Gap:** None -- this is a clean resolution.

### F-9: Resource footprint of parallel coders
**Status:** Addressed
**v2 resolution:** `maxParallelism` setting (default 3) with `p-limit`.
`WorkflowSessionFactory` interface enables future remote dispatch.
**Gap:** None -- pragmatic resolution.

### F-10: Text-only agents get unnecessary sandboxes
**Status:** Resolved (dismissed)
**v2 resolution:** Per owner's direction, all agents run full agent loops.
**Gap:** None -- this is a design decision, not a bug.

### F-11: Orchestrator state-entry detection is missing
**Status:** Addressed
**v2 resolution:** Not needed -- XState's `invoke` starts the service on state
entry automatically. The orchestrator only sends events for human gates.
**Gap:** Human gate detection relies on `snapshot.value` being a string (see
V2-F-4).

### F-12: Possible over-engineering of workflow definition format
**Status:** Unchanged (accepted)
**v2 resolution:** v2 keeps the general-purpose workflow definition format.
**Gap:** Owner accepts this; not a design defect.

### F-13: XState may be the wrong abstraction
**Status:** Resolved (accepted)
**v2 resolution:** Owner chose to keep XState for formal guarantees. v2
provides concrete `invoke`/`fromPromise` mapping.
**Gap:** None -- justified decision.

### F-14: Escalation/gate conflation is a leaky abstraction
**Status:** Addressed
**v2 resolution:** Gates are a fully separate system with their own types,
state, and picker mode. No shared data structures with escalations.
**Gap:** None -- clean separation.

---

## Summary

| Severity | Count |
|----------|-------|
| Blocking | 4 (V2-F-1 through V2-F-4) |
| Significant | 6 (V2-F-5 through V2-F-11) |
| Architectural | 4 (V2-F-12 through V2-F-15) |

| v1 Finding | v2 Status |
|------------|-----------|
| F-1 (session resumption) | Addressed with gap (V2-F-3, V2-F-7) |
| F-2 (system prompt) | Fully addressed |
| F-3 (abort) | Partially addressed (V2-F-2) |
| F-4 (MuxTab/PtyBridge) | Partially addressed (V2-F-1) |
| F-5 (escalation registration) | Addressed with gap (V2-F-15) |
| F-6 (human gates) | Fully addressed |
| F-7 (XState async) | Addressed with gaps (V2-F-4, V2-F-5, V2-F-9) |
| F-8 (status block retry) | Fully addressed |
| F-9 (parallel resources) | Fully addressed |
| F-10 (text-only agents) | Resolved (dismissed by owner) |
| F-11 (state-entry detection) | Addressed with gap (V2-F-4) |
| F-12 (over-engineering) | Accepted |
| F-13 (XState choice) | Accepted |
| F-14 (gate conflation) | Fully addressed |

The v2 design makes substantial progress on the v1 findings. The XState
`invoke`/`fromPromise` model is the right approach and resolves the core
architectural question. The Docker-primary pivot is sound given the
`claude --continue` conversation persistence.

The blocking issues are all implementable -- they are gaps in the design
sketch, not fundamental architecture problems. V2-F-1 (TabBackend missing
methods) and V2-F-2 (DockerManager missing AbortSignal) require API changes
to existing interfaces. V2-F-3 (first-turn --continue) needs investigation
of Claude Code CLI behavior. V2-F-4 (snapshot.value) is a straightforward
fix to use `snapshot.matches()`.
