# Evolve Sync Parallelism Phase 0 Audit

Status: Phase 0 evidence for `evolve-sync-parallelism-slice.md` sections 5, 5.4, and 14.

## Binary Verdict

**Contained feature.** The shared `ToolCallCoordinator` is safe after the Phase 0 kernel fixes in this branch: normal tool-call critical sections remain FIFO-serialized, policy escalation releases the call mutex while waiting for auto-approval/human input, and the circuit breaker can be scaled by worker count so N identical lane reads do not false-trip the single-lane threshold.

The shared orchestrator `WorkflowInstance` is safe for N lanes only under the fan-out shape already required by the design: mint the shared scope bundle once before creating child actors; keep lanes homogeneous in persona per batch; let deterministic states write lane-scoped result files; and accept that token-budget enforcement is once-per-batch for the first synchronous slice. None of the audit findings require child actors, workers state, manifest schema, or lane machinery in Phase 0.

## Coordinator Audit

Evidence:

- `src/trusted-process/tool-call-coordinator.ts:320-355` now runs each tool call through `runSerializedToolCall()`, which holds `callMutex` for the normal policy/audit/breaker/dispatch path and passes a `runEscalationWait` hook into the pipeline.
- `src/trusted-process/tool-call-pipeline.ts:807-930` now captures escalation context under the mutex, then runs auto-approval or human escalation through that hook. Audit writes, whitelist mutation, roots expansion, circuit-breaker checks, and backend dispatch still happen after the coordinator reacquires `callMutex`.
- `src/trusted-process/tool-call-coordinator.ts:357-392` tracks active tool calls and suspends admission so `loadPolicy()` / `close()` still drain a whole in-flight call, including the period where the escalation wait is outside `callMutex`.
- `src/trusted-process/call-circuit-breaker.ts:17-67` scales the effective threshold by `workerCount`, defaulting to `1`. **Prerequisite caveat:** the scaling is applied to a GLOBAL per-`(tool, argsHash)` window, so it grants `threshold × workerCount` headroom to the whole bucket — a single runaway lane then gets `threshold × N` slots, weakening the DoS guard by a factor of N. This is harmless only while `workerCount === 1` (always true in production today). **Per-lane bucketing (key the breaker window by lane id) is a REQUIRED prerequisite before any caller sets `workerCount > 1`.** It is not implementable in Phase 0 (lane ids do not exist yet); see `evolve-sync-parallelism-slice.md` §5.2 item 3.

Test evidence:

- `test/tool-call-coordinator.test.ts` drives 41 concurrent `handleStructuredToolCall()` calls through one coordinator with `workerCount: 2`. It asserts JSONL parseability, FIFO audit request order, one-at-a-time backend dispatch, 40 allowed calls, and the 41st denied by the workers-aware circuit breaker. **These calls never escalate**, so this test proves the FIFO/audit/breaker properties only — it does **not** exercise or prove the mutex-release-across-escalation property.
- The mutex-release property is proven by a **dedicated liveness test** (`test/tool-call-coordinator.test.ts`, "does not hold the call mutex while waiting for human escalation"): it parks an agent-path escalation with its human decision deliberately held open, then proves a later allowed call completes *before* the escalation resolves (impossible if the call mutex were held across the wait).
- `test/tool-call-coordinator.test.ts` further proves `close()`/`loadPolicy()` drain a held-open escalation (the call paused outside the call mutex still blocks the quiesce), that a throwing escalation hook leaks no mutex/admission slot, and that two concurrent auto-approvals run outside the mutex.
- `test/call-circuit-breaker.test.ts` asserts the effective threshold is `threshold * workerCount`.

Conclusion: no torn audit entries, cache RMW remains serialized, circuit-breaker counts are workers-aware, and one lane's human escalation no longer freezes unrelated lanes.

## Orchestrator `instance.*` Audit

### `bundlesByScope`

Anchors: `src/workflow/orchestrator.ts:654`, `:838-839`, `:926`, `:2527-2528`.

Classification: **needs serialization before fan-out**.

Reasoning: `ensureBundleForScope()` is an unguarded check-then-act across `await factory(...)` and `await startServer(...)`. Concurrent first users of the same `containerScope` can mint multiple bundles. The sync-parallelism design already requires `runFanOutSegment` to call `ensureBundleForScope()` once before starting child actors. That pre-mint is the contained fix for the first slice; an in-flight-promise guard inside `ensureBundleForScope()` is cheap hardening but not required before Phase 0 is green.

### `mintedServersByBundle`

Anchors: `src/workflow/orchestrator.ts:677`, `:927`, `:1002-1015`.

Classification: **inherits bundle-mint serialization**.

Reasoning: the only writer is the bundle mint path. Once the fan-out boundary serializes the mint, reads in `cyclePolicy()` observe a stable required-server set.

### `policyDirByPersona`

Anchors: `src/workflow/orchestrator.ts:660`, `:938-943`.

Classification: **idempotent**.

Reasoning: concurrent lookups for the same persona compute and set the same canonical policy directory. The map is a cache, not a source of truth.

### `currentPersonaByBundle`

Anchors: `src/workflow/orchestrator.ts:668`, `:994`, `:1028`, `:1037`.

Classification: **idempotent for homogeneous lanes; needs serialization for heterogeneous lanes**.

Reasoning: the in-scope evolve lanes are homogeneous (`global` persona), so duplicate concurrent `loadPolicy(global)` calls are redundant but converge on the same coordinator state. Concurrent different personas on one bundle are not safe: the last RPC wins and audit persona stamping becomes nondeterministic. The slice keeps per-batch lanes homogeneous; if heterogeneous lanes are introduced later, policy cycling must move to a batch-level serialized preflight or a per-persona bundle.

### `messageLog`

Anchors: `src/workflow/orchestrator.ts:634`, `:2081`, `:2096`, `:2173`, `:2191`, `:2203`, `:2234`, `:2259`, `:2272`, `:2463`, `:2692`; writer at `src/workflow/message-log.ts:120`.

Classification: **integrity-safe, observability-incomplete**.

Reasoning: `MessageLog.append()` uses synchronous `appendFileSync(JSON.stringify(entry) + "\n")`, so entries are not torn within the Node process. Under N lanes, ordering is completion/event order rather than lane order, and entries currently have no `laneId`. That is acceptable for Phase 0 kernel safety; later fan-out observability should add lane-tagged entries or a child-actor fan-in stream.

### Coordinator Audit Append

Anchors: `src/trusted-process/tool-call-pipeline.ts:748-761`; coordinator serialization at `src/trusted-process/tool-call-coordinator.ts:320-355`.

Classification: **serialized by coordinator**.

Reasoning: every tool-call audit append still occurs after the coordinator has acquired `callMutex`. The escalation wait is outside the mutex, but the final audit line for that escalation is written only after reacquire. Phase 0 tests parse every JSONL line and assert FIFO order for non-escalating concurrent streams.

### `tokens.sessionIds` / `tokens.outputTokens`

Anchors: `src/workflow/orchestrator.ts:715-719`, `:1315-1318`, `:1336`, `:2298`, `:2452`, `:2494`.

Classification: **accumulation-safe; enforcement granularity accepted for first sync slice**.

Reasoning: each agent lane adds its session id before `agent_started` and deletes it after `session.close()` drains in-flight streams. The token bus listener is synchronous and accumulates `message_end.outputTokens` for any registered session id, so concurrent lanes do not drop tokens. The known gap is budget enforcement granularity: `totalTokens` is snapped into a lane result at lane completion, while the parent FSM will only run stop-condition enforcement at the barrier. For the first synchronous slice, this audit accepts the documented one-batch overshoot window; a later hardening can forward token deltas to an in-batch budget guard.

### `activeSessions`

Anchors: `src/workflow/orchestrator.ts:612`, `:1755-1759`, `:2182`, `:2472`.

Classification: **set-integrity safe; abort semantics need fan-out policy**.

Reasoning: `Set.add` / `Set.delete` are synchronous and safe from torn mutation in one Node process. `abort()` closes the sessions present when it runs, then clears the set. A future fan-out implementation must stop child actors on abort so no lane creates a new session after `abort()` begins; that is part of the child-actor drain/stop policy, not a coordinator kernel blocker.

### `quotaExhausted` / `transientFailure`

Anchors: `src/workflow/orchestrator.ts:707`, `:731`, `:2246`, `:2266`, terminal handling at `:2765-2785`.

Classification: **idempotent abort marker; diagnostics last-writer-wins**.

Reasoning: any lane setting either field forces an abort-preserving terminal outcome. Concurrent lanes can overwrite the reason, but the binary safety property is preserved: the run remains resumable instead of completing. Later aggregated lane diagnostics should report all blocked/failed lanes; Phase 0 does not need a kernel fix.

### `transitionHistory`, `currentState`, `stateEnteredAt`, `activeGateId`

Anchors: `src/workflow/orchestrator.ts:622-628`, `:1890-1916`, `:2689-2698`.

Classification: **parent-FSM serialized; child observability not represented**.

Reasoning: these fields are updated by the parent actor subscription and gate entry path, not by concurrent child lane executors in Phase 0. Under the planned `workers` state, the parent still sees one active state and one gate. Child lane transitions are intentionally not represented here; later fan-out work needs explicit observability fan-in if operators need lane-level live detail.

## AutoApprover And ServerContextMap

AutoApprover is called through the escalation wait hook and can now run concurrently across multiple escalations. The coordinator passes immutable request data and a model handle; no coordinator-owned mutable cache is touched during the wait. Any provider-side rate limiting is an external throughput concern, not a shared-state race.

`ServerContextMap` remains protected for mutation by `callMutex`: git path enrichment reads happen before escalation wait, and `updateServerContext()` still runs in the post-call tail after reacquire. The map is keyed by MCP server, not lane. For evolve's same-container lanes this matches reality: lanes share one workspace and one git working directory. Heterogeneous per-lane workspaces would require a lane-keyed server context, which is outside this slice.
