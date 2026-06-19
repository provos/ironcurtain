# Adversarial FSM/Orchestration Review — `evolve-sync-parallelism-slice.md`

Scope: the **state-machine mechanics** of the proposed "N lanes inside one `workers`
state, driven by the manual pump." Every claim below is grounded in the current tree.
Cites are `file:line` against `src/workflow/orchestrator.ts`, `machine-builder.ts`,
`guards.ts`, `validate.ts`, `lint.ts`, `types.ts`, `checkpoint.ts`, and the evolve
package (`workflow.yaml`, `scripts/evolve_result.py`, `scripts/evolve_core/*`).

Verdict up front: **the single-active-state spine is preserved only because the
per-lane state is invisible to the FSM, and that invisibility breaks four mechanisms
the design assumes still work.** The doc is honest that the pump runs "below the XState
layer," but it then leans on FSM-level machinery (visit counts, the manifest transition
table, `replayInvokeForRestoredState`, per-state context write-back) that *only fires
for FSM transitions* — which lane sub-steps are not. The design is not incoherent, but
it is under-specified in load-bearing places and contains one self-contradiction
(§3/§11.1 "`machineState: workers`" vs §4.2 "shape B, no `workers` state").

The author's line cites are **largely accurate** (spine cites at `:1873`/`:1890`/`:2690`
all check out; bridge/engine cites check out). Drift is minor and noted inline.

---

## The single most load-bearing mechanical objection

**Lane sub-transitions never enter the FSM, so the design re-implements the manifest
transition table imperatively in `driveLane` — which means "lanes drive real FSM states"
is false, and three FSM-owned mechanisms (visit counts / `maxVisits` / `isRoundLimitReached`,
context write-back / token + stall accounting, and `replayInvokeForRestoredState`-based
resume) silently do not apply to lanes.**

Concretely:

- Visit counts are incremented by an XState **entry action**, not by the executors:
  `entry: [{ type: 'incrementVisitCount', params: { stateId } }]` (`machine-builder.ts:262`),
  whose assign is `machine-builder.ts:604-608`. `driveLane` (doc §6.2) calls
  `executeAgentState`/`executeDeterministicState` **directly**, bypassing the actor, so
  `context.visitCounts[stateId]` is **never incremented** for lane sub-steps.
- Therefore `maxVisits: 3` on `researcher`/`analyzer` (`workflow.yaml:420`, `:470`) — which
  the doc §4.2 explicitly claims "honored per lane" under shape B — is **dead** for lanes.
  The guard that enforces it (`isStateVisitLimitReached`) and the artifact-versioning that
  reads `context.visitCounts[stateId]` (`orchestrator.ts:2044`) both see zero for every lane
  invocation.
- `isRoundLimitReached` (`guards.ts:21-26`) takes `Math.max(...Object.values(context.visitCounts))`.
  If lane sub-steps never bump `visitCounts`, the `maxRounds: 200` backstop (`workflow.yaml:20`)
  only counts **orchestrator** entries (one per batch) — so the doc's new lint `WF013`
  ("scale `maxRounds` by N because lanes accrue visits N× faster", §4.4) is solving a problem
  that **does not exist**: lanes accrue *zero* visits, not N× visits. The real risk is the
  opposite — the backstop counts batches, not lane-rounds, so it is now N× *looser* than the
  comment at `workflow.yaml:10-19` assumes.
- The executors return rich results the FSM normally writes back via
  `updateContextFromAgentResult`: `AgentInvokeResult` carries `agentConversationId`,
  `artifacts`, `outputHash`, `responseText`, **and `totalTokens`** (`machine-builder.ts:31-57`).
  `driveLane` reads only `res.agentConversationId` and discards the rest. So per-lane
  **token accounting** (`ctx.totalTokens`), **stall detection** (`outputHash` /
  `previousOutputHashes`), and `previousAgentOutput`/`previousAgentNotes` never update from
  lane work. Token-budget enforcement and stall guards silently stop tracking inside a batch.

This is the crux: the doc says (§6.2) the executors are "reused verbatim except for the
`laneId` + lane-working-dir parameters," but the executors are *half* of a two-part
mechanism — execute, then **assign back to FSM context**. Bypassing the actor keeps the
execute half and drops the assign half. The doc must either (a) re-implement the relevant
context write-backs (tokens at minimum) inside the pump, or (b) explicitly declare these
FSM mechanisms out-of-scope for lanes and prove nothing in evolve depends on them per-lane
(token budget plausibly does).

---

## MUST-FIX (FSM mechanism broken/incoherent as written)

### MF1 — `machineState: "workers"` contradicts shape B; resume cannot reconstruct the fan-out.

The doc recommends **shape B** (§4.2): keep `sample → … → analysis_record` as real states;
there is **no `workers` state**. But §3 and §11.1 assert the checkpoint's
`machineState` is `"workers"` and `String(snapshot.value) === "workers"`. These cannot both
be true. Resume does:

```
restoredState = String(checkpoint.machineState)         // orchestrator.ts:1558
stateDef      = definition.states[restoredState]        // :1559
if (stateDef.type === 'agent' || 'deterministic') replayInvokeForRestoredState(...)  // :1560-1561
```

In shape B there is no `definition.states["workers"]`, so `stateDef` is `undefined` and
`:1560` throws on `.type`. In shape B the FSM is actually "in" `sample` (the `design`-edge
target, `workflow.yaml:353`), so `replayInvokeForRestoredState` re-runs **`sample`'s**
invoke using the *bare, non-lane-templated* `stateDef.run` / `stateDef.resultFile`
(`orchestrator.ts:1587-1595`) — i.e. one single-`current/` exec, **not** `runFanOutSegment`.
The fan-out is not reconstructed on resume at all.

Fix: pick one and make the whole doc consistent. Either (a) shape A — introduce a real
`workers` state whose invoke *is* `runFanOutSegment`, register it in `provideActors`
(`orchestrator.ts:1838-1858`), and accept that `replayInvokeForRestoredState` re-runs that
one invoke (this is the only shape where `machineState:"workers"` is real and resume works);
or (b) shape B — then `machineState` is `sample`, and you must special-case the fan-out
segment head in `replayInvokeForRestoredState` so it dispatches to `runFanOutSegment` with
lane-templated inputs rather than the bare `sample` deterministic input. The doc currently
asserts (a)'s checkpoint shape while recommending (b)'s topology. As written, resume is
broken.

### MF2 — `ensureBundleForScope` has no concurrent-mint guard; "first lane mints, rest reuse" is false.

§8.1 claims the first lane mints the bundle and "subsequent lanes reuse it
(`bundlesByScope.has(scope)`)." But `ensureBundleForScope` is check-then-act with `await`
points and **no in-flight-promise dedupe**:

```
const existing = instance.bundlesByScope.get(scope); if (existing) return existing;  // :838-839
... await factory(...) ...                                                            // :864
... bundlesByScope.set(scope, ...) (later)                                            // after the awaits
```

The function's own doc-comment says so explicitly: *"relies on serial XState invocations —
there is no parallel agent-state fan-out today. If that ever lands, add an in-flight-promise
guard to prevent concurrent lazy-mint races for the same scope"* (`orchestrator.ts:820-824`).
The fan-out the design proposes is exactly that scenario. With N lanes' first
`container: true` step racing, each sees `bundlesByScope.get(scope) === undefined` and mints
a **separate** bundle (separate container, coordinator, control socket, audit log) — N
containers instead of one, defeating `sharedContainer` and the §8 DB-sharing argument.

Fix: this is a required code change the doc does not name. Add an in-flight `Promise<bundle>`
memo keyed by scope in `ensureBundleForScope` (store the promise before the first `await`,
return it to concurrent callers). The doc's §5 ("coordinator audit FIRST") covers the
*coordinator* but not this *bundle-mint* race, which is a distinct kernel-level concurrency
gap on the orchestrator side.

### MF3 — Drain-on-`evaluator_blocked` does not cover policy escalations inside agent lanes.

§5.2#1 correctly identifies that escalation awaits inside the held call mutex
(`handleStructuredToolCall` runs `handleCallTool` — which contains the escalation flow —
entirely inside `callMutex.withLock`, `tool-call-coordinator.ts:348-357`). The doc's answer
is drain-on-escalation (§10.1), which trips on the **deterministic** `evaluate` verdict
`evaluator_blocked` (`workflow.yaml:444`, surfaced as `DeterministicInvokeResult.verdict`).

But a **policy escalation** raised by a tool call *inside a `researcher`/`analyzer` agent
lane* is a different path: it blocks in `handleCallTool` under the held `callMutex`
(`:348`), and it has **nothing to do** with the `evaluate` step's `evaluator_blocked`
verdict. Drain-on-`evaluator_blocked` never fires for it. So lane 0's researcher hitting an
escalate rule still stalls lanes 1..N-1's tool calls on the FIFO mutex (`async-mutex.ts:18`,
non-reentrant FIFO) until a human resolves — the exact held-mutex stall the doc claims to
have "sidestepped." Evolve agents are `global` persona with a real policy, so this path is
live, not hypothetical.

Fix: either (a) release the call mutex across the escalation wait in the coordinator
(acquire → evaluate → if escalate, release, await human, re-acquire) — a kernel change the
doc gestures at but defers; or (b) make the drain trip on *any* escalation, not just the
deterministic `evaluator_blocked` verdict, which requires the pump to observe coordinator
escalations (a new signal from the coordinator/session up to the lane). Today neither exists.
Mark this in Phase 0 (§14) as in-scope, not "moot under drain" (§5.2#2's reasoning only holds
for the `evaluator_blocked` case).

---

## SHOULD-FIX (real mechanic gap)

### SF1 — Proposed manifest keys (`workers`, `fanOut`, `fanOutMember`) are silently stripped, not validated.

The Zod schemas are plain `z.object(...)` with default `.strip()` — not `.strict()`:
`workflowSettingsSchema` (`validate.ts:103-117`), `agentStateSchema` (`:54-68`),
`deterministicStateSchema` (`:78-87`). So `settings.workers`, `transitions[].fanOut`, and
`fanOutMember: true` will **parse without error but be dropped** before the definition
reaches the runtime — the pump would read `undefined` for all of them. The doc §4.3/§4.4
adds *new validator/linter rules* but never states the prerequisite: the fields must be
**added to the Zod object schemas and to the `types.ts` interfaces** (`WorkflowSettings`
`:105-157`, `DeterministicStateDefinition` `:267-296`, `AgentTransitionDefinition` `:338-361`)
or they are inert. Note `fanOut` lives on a *transition*, and `agentTransitionSchema`
(`:33-38`) is shared by agent + deterministic + (via `humanGateTransitionSchema`) gates, so a
`fanOut` transition key needs a deliberate home there.

Fix: name the schema/interface additions explicitly in the implementation contract (§4),
alongside the validator rules. Until then, "the proposed shape parses, validates, and lints"
is only half true: it parses (by being discarded) but does not reach runtime.

### SF2 — Lane-scoped `resultFile` collides with the static, single-path manifest field and its host-side read.

`resultFile` is a single workspace-relative string on the state
(`DeterministicStateDefinition.resultFile`, `types.ts:294`; schema `validate.ts:85`), read
**host-side** after exec by `applyResultFile` (`orchestrator.ts:2537-2606`) via
`resolve(instance.workspacePath, input.resultFile)`. The doc's lane discipline (§7) rewrites
the in-container working area to `current/lane_<k>/…` and templates the `run:` argv per lane,
but `applyResultFile` reads the **`input.resultFile`** the pump passes, not the argv. The doc
§6.2 does pass `resultFile: laneTemplated(stateDef.resultFile, lane)`, which is the right
instinct — but `DeterministicInvokeInput.resultFile` is the *only* channel, and the host read
path (`:2556`) plus the `isSafeWorkspaceRelativePath` / `isWithinDirectory` containment checks
(`:2552-2564`) must all see the lane-templated path. Confirm the lane-templated path still
passes those containment checks (it should — `current/lane_0/…` is workspace-relative) and
that `EVOLVE_LANE`-vs-`--lane` (§7.1) does not desync the in-container write path from the
host-side `input.resultFile` read path. A mismatch silently yields `result file … not found`
(`:2566-2568`) → `result_file_error` → `failed` for every lane.

Fix: state that the pump is the single source of truth for the lane-templated `resultFile`
and that it must thread the *same* lane path into both the argv and `DeterministicInvokeInput.resultFile`.
Add a lane-aware assertion to the Phase 1 unit test (§14).

### SF3 — `batch.json` sub-checkpoint races the per-transition FSM checkpoint and the lazy-mint fresh-container resume.

`batch.json` (§6.3) lives on `/workspace`, written by lanes "as each lane advances." But the
authoritative FSM checkpoint is written by the actor subscription on **every** state change
(`saveCheckpoint`, `orchestrator.ts:1905`), atomically via temp-file rename
(`checkpoint.ts:53-62`). The two are not coordinated: a crash between a lane's `batch.json`
write and the next FSM checkpoint leaves them inconsistent. The doc's mitigation is
"DB-as-truth" (§11.1) — `batch.json` is "a hint never trusted over the DB" — which is sound,
**but then most of `batch.json` is decorative**: the only durable, trustworthy fact is "is
this lane's `step_name` already a recorded node?" (`_find_recorded_node_for_step`,
`evolve_result.py:186-191`), and that is read straight from `nodes.json`. If `batch.json` is
untrusted, `restoreOrCreateLanes` can be derived entirely from the DB (`done_rounds` and the
set of recorded `step_name`s for `batch_index`), and `batch.json` adds a second source of
truth that can only *disagree*. On the lazy-mint fresh-container resume path
(`bundlesByScope` empty, `orchestrator.ts:1513`, `:1527-1531`), the `/workspace` mount is
reattached so `batch.json` survives, but a half-written `batch.json` from a crash mid-write is
exactly the case "DB-as-truth" exists to ignore.

Fix: either drop `batch.json` and derive lane-resume state purely from the DB
(`step_<batch>_lane_<k>` recorded-node lookup), or make `batch.json` write atomic
(temp+rename, mirroring `checkpoint.ts`) and define precisely which fields are
load-bearing vs. advisory. As written, it is a non-atomic second checkpoint the resume
logic is told to distrust — so it should not exist in its current form.

### SF4 — Idempotency claim is sound for the deterministic record but not for in-flight agent regeneration's effect on the barrier.

The record idempotency is real: `attach_analysis` short-circuits on an existing node for the
`step_name` (`evolve_result.py:732-733`, `:186-191`), and the engine assigns ids atomically
under `_database_guard` (`database.py:67-74`, `:207-215`). The doc §11.2 correctly notes the
agent re-generation is non-idempotent but "acceptable" because a crashed lane had no durable
node. Agreed. The unstated gap: on resume, a lane that recorded *before* the crash is skipped,
but lanes that did **not** record re-run `sample → researcher → evaluate → analyzer → record`,
and the `Promise.all` barrier (§6.2) only resolves when *all* lanes reach `recorded`/`drained`.
If a re-run lane's fresh candidate now hits `evaluator_blocked` (a different candidate than the
pre-crash one), the resumed batch drains and escalates even though the pre-crash batch would
not have. This is a *correctness-of-batch-outcome* drift across resume, not a duplicate-node
bug. Gate item 6 ("no duplicate nodes") would still pass while the batch verdict silently
differs run-to-run.

Fix: acknowledge in §11.2 that resume can change a batch's *verdict* (not just its node set),
and decide whether that is acceptable. If batch-verdict stability matters, the pre-crash
candidate must be persisted per lane before record (the doc calls this out-of-scope, which is
fine — but the verdict-drift consequence should be stated).

---

## CONSIDER

### C1 — `transitionHistory` and message log lose all per-lane observability; name it as a deliberate loss.

§6.3 says per-lane transitions are "not pushed into `instance.transitionHistory`" (which
assumes single-active-state, `orchestrator.ts:1890`) and instead "live in `batch.json` and
the message log (which can carry a `laneId` field)." `TransitionRecord` (`types.ts:617-625`)
has no `laneId` and the message log append in the subscription
(`orchestrator.ts:1908-1913`) is keyed off FSM transitions only. So today, a `workers` batch
produces **one** transition record (`orchestrator → workers → orchestrator`) and **zero**
per-lane state-transition log entries. `workflow inspect` and the web-UI transition view go
dark inside a batch. That may be acceptable, but the doc frames "single-active-state preserved"
as a pure win; it is a win *and* a deliberate observability regression. State it, and decide
whether lane sub-steps deserve a `laneId`-tagged message-log entry (cheap) even if not a
`TransitionRecord`.

### C2 — The single `activeGateId` is preserved, but only one gate *kind* exists; per-lane gate routing is genuinely impossible.

§10's drain-to-one-gate is the right call given `instance.activeGateId` is a single string
(`orchestrator.ts:2690`) and `handleGateEntry` is driven by `snapshot.matches(gateName)` over
FSM state (`:1934-1942`) — lanes have no FSM state, so they cannot match a gate. The doc is
correct here. Worth making explicit in §4.3's validator rule: a human-gate state *inside* the
fan-out segment is not merely discouraged, it is *unreachable* (a lane can never cause
`snapshot.matches` to fire), so the validator rule should be an **error**, not a lint warning,
and should explain it is an unreachability invariant, not a style preference.

### C3 — `EVOLVE_DB_TEST_HOLD_LOCK_MS` cite is accurate and useful — lean on it for gate item 2/4.

Verified: the engine DB guard takes `InterProcessFileLock` (`database.py:17` import; guard at
`:207-215`) and the test hold-lock hook exists. The concurrency test (Phase 0, gate item 4)
can force deterministic lock contention with it. Good. One addition: the test should also
cover the **bundle-mint race** (MF2), which the DB lock does *not* protect — that race is
host-side in `ensureBundleForScope`, entirely above the engine DB.

### C4 — Minor cite drift to correct in the doc.

- §1/§17 cite `instance.currentState` at `:1916` — correct for the *write* (`:1916`), but the
  read used for change-detection is `:1874` (`const previousState = instance.currentState`).
  Both exist; fine.
- §17 cites `currentPersonaByBundle` at `:994`/`:1037` — `:994` is the cyclePolicy
  short-circuit read, `:1037` the write; both correct.
- §6 cites `reduceDeterministicCommands` serial `for` at `:2615-2641` and the exec at `:2667`
  — both correct. The doc's claim that this serial loop is "per-lane, untouched" is right: it
  iterates a single state's `commands` array; cross-lane concurrency is the `Promise.all` one
  layer up. No issue.

---

## Bottom line

The mechanism is **coherent in spirit** (concurrency below the XState layer, single FSM
value) but **broken in three concrete places** (MF1 resume self-contradiction, MF2 unguarded
bundle-mint race, MF3 escalation drain doesn't cover policy escalations) and
**under-specified in four** (SF1 stripped manifest keys, SF2 lane `resultFile` plumbing, SF3
redundant non-atomic sub-checkpoint, SF4 batch-verdict drift on resume). The honest framing
the doc should adopt: *single-active-state is preserved by making lane state invisible to the
FSM, and that invisibility costs visit-count/`maxVisits`/`maxRounds` semantics, per-lane
context write-back (tokens, stall), per-lane resume granularity, and per-lane observability.*
Decide per item whether the loss is acceptable; do not present invisibility as free.
