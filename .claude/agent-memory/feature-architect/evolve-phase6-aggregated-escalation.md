# Evolve Phase 6 — aggregated escalation via drain (commit ae74ea1)

Reviewed for code correctness. **Verdict: CORRECT-WITH-FIXES.** The childActor.stop() drain +
single-gate aggregation + drained-recovery routing are sound; the open items are a prompt-clarity
gap at workers:1 and the documented out-of-band-exec limitation. Builds on [[evolve-phase5-cognition-promotion]],
[[evolve-fanout-concurrency]], [[workflow-fsm-single-active-state]].

## childActor.stop() mechanics (XState 5.30, VERIFIED by probe)
- `actor.stop()` mid-invoke → snapshot becomes `status:'stopped'`, value STAYS at current state (does
  NOT advance). Subscriber gets `complete` (NOT a `next` with done/error). The in-flight `fromPromise`
  promise resolving LATER does NOT re-trigger any transition (stopped actor ignores it). So no torn
  XState transition, no second gate, no double-promote from a stopped peer.
- `waitForRoundChild` (orchestrator.ts:3182) `observe` only watches `status==='done'|'error'`; `stopped`
  is neither → drain() is the sole resolver via `finishOutcome`. `subscribe(observe)` is a bare next-fn,
  so `complete` is ignored. Clean.
- CRITICAL GAP (documented, not a new bug): `provideActors` (orchestrator.ts:1925/1933) `fromPromise`
  bodies destructure only `{ input }` — they IGNORE XState's `signal` (AbortSignal). `bundle.docker.exec`
  takes no AbortSignal (FSM-M3). So stop() CANNOT cancel an in-flight `docker.exec`. A peer mid-
  `analysis_record` (the durable node-write) when drained: its exec RUNS TO COMPLETION out-of-band and
  records a durable node, while the parent resolves it as `drained` (not recorded). NOT a torn write
  (database.py uses InterProcessFileLock + atomic os.replace). Reconciled by engine step-name
  idempotency on re-run. Comment at orchestrator.ts:3241-3243 owns this explicitly.

## Drain synchronicity (VERIFIED by probe) — no partial-drain window
- Whole chain is synchronous: child A's blocked snapshot → A's `finish()` → `resolvePromise` → `onDrainTrigger`
  = `requestDrain` → loop `child.drain()` over peers → peer `actor.stop()` + `finishOutcome(drained)`.
  All one JS call stack. No peer can advance an XState state in that window (single-threaded). A peer
  that ALREADY settled (recorded/blocked in an earlier tick) is skipped via `child.isSettled()` (orch:2694)
  → keeps its real outcome. So "slip past the stop" only happens via the out-of-band exec above, which
  does NOT enter a new state → benign (extra node, no 2nd gate/double-promote).

## Gate item 5 (one blocked lane → ONE gate, peers stopped not completed): RUNNABLE coverage YES
- orchestrator-fanout.test.ts "drains peer lanes on the first blocked child and opens one aggregated gate"
  (workers:3, NON-Docker): lane0 blocks at evaluate, peers 1&2 held at researcher (deferred). Asserts
  `raiseGate` called EXACTLY ONCE, evaluate deterministic stub THROWS if any lane≠0 reaches it (proves
  peers stopped pre-evaluate), analysis_record never called, fanout_join children=[blocked,drained,drained].
- Single-gate invariant is STRUCTURAL: parent FSM is one XState actor; the fan-out `escalate` verdict
  resolves the single `workers` invoke → one transition to `human_escalation` → subscribeToActor
  (orch:2027-2035) fires handleGateEntry ONCE → single deterministic activeGateId=`${wfId}-human_escalation`
  (orch:3878). Children are refs, never drive parent gates. No path opens a 2nd gate.
- CAVEAT for "two lanes block": only ONE drainTrigger honored (`if(drainTrigger!==undefined)return` orch:2687).
  The 2nd would-be-blocker gets DRAINED before reaching its `blocked` terminal → surfaces as `drained`,
  NOT `blocked` → excluded from `fanOutIssues` (orch:3353 filters blocked|errored). So the aggregated
  summary lists only lanes that genuinely reached blocked/errored BEFORE the drain tick (≥1, could be
  more if same-tick). Still ONE gate, `escalate` verdict. The "carries BOTH reasons" claim is only true
  for same-tick co-blockers; a slightly-later 2nd blocker is reported as drained. Acceptable (drain-first
  is the chosen §10.1 design; multi-item gate is deferred §10.2), but the gate summary under-reports
  co-blockers. CONSIDER.

## Drained-recovery routing (#3) — prompt-enforced + STRUCTURAL backstop, no hard FSM guard
- The `orchestrator` agent state has edge `evaluate when{verdict:evaluate}` (workflow.yaml:361) for the
  LEGACY single-candidate recovery (bare current/context.json present, current/result.json absent).
  A drained fan-out batch must NOT route there. There is NO hard FSM guard — disambiguation is the
  orchestrator LLM reading file-path shape (prompt workflow.yaml:331-334).
- STRUCTURAL backstop that makes it safe: at workers>1 every lane is lane-scoped (lane-template.ts:80),
  so scratch is `current/lane_<k>/...`, and bare `current/context.json`/`current/result.json` (the legacy
  trigger) are NEVER written → legacy condition is structurally FALSE. So even if the LLM ignored the
  prose, the bare-file signature it keys on doesn't exist for a fan-out batch.
- "Fresh design batch" via orchestrator IS §10.3's "re-run the drained batch": batch_index reused on
  resume (FSM-C1, engine-side), recorded step names short-circuit in attach_analysis → recorded-before-
  drain lanes not re-run, drained lanes re-spawn from sample. The batch_index/idempotency is Phase 3/4
  engine machinery, NOT touched by Phase 6.
- "APPROVE after drained escalation" test (orchestrator-fanout, workers:3, non-Docker) proves: run
  reaches `done`, workers visited twice, human_escalation once, `evaluate` NEVER directly visited, turn-2
  sample+analysis_record hit lanes 0/1/2. But it stubs orchestrator→`design`, so it does NOT exercise the
  dangerous `evaluate`-edge temptation directly.

## SHOULD-FIX: workers:1 (the DEFAULT, workflow.yaml:9) escalation message is misleading
- workers:1 ALSO routes through runFanOutSegment (orch:1655) → 1-lane fan-out → block produces `escalate`
  verdict (not the old `evaluator_blocked`). `previousAgentOutput` becomes "Fan-out batch escalated after
  blocked lane(s): - lane 0 blocked: ..." (promoteFanOutIssueContext orch:3399). BUT at workers:1 the
  scratch is BARE current/ and result.json is absent → the LEGACY `evaluate`-resume IS the correct action.
  The new prompt clause (workflow.yaml:331-334 "if previous output says fan-out batch escalated... discard
  ... emit design for a fresh batch") and the "Fan-out batch escalated" wording push the LLM toward
  discard+resample, contradicting the legacy resume the workers:1 default still wants. The qualifier
  "under current/lane_<k>/" is the only disambiguator and it's subtle. Concrete fix: have
  promoteFanOutIssueContext/the prompt distinguish workers:1 (bare current/, legacy resume) from workers>1
  (lane_<k>/, discard). Either tag the summary with the lane-dir shape, or gate the "discard" prompt clause
  on lane-scoped paths explicitly. No runnable workers:1-escalation-then-resume test exists (the Docker
  integration tests use FORCE_REVISION/ABORT, not APPROVE→evaluate-resume).

## Scope (#6): CLEAN
- evolve_core/ + scripts/evolve* UNTOUCHED (grep confirmed). No getPersistedSnapshot (P7 resume re-spawn),
  no EvalSlot (P8), no multi-item gate (§10.2 deferred). The `drained`-without-trigger branch in
  joinFanOutBatch (orch:3333) is defensive DEAD code (any drained lane implies a blocked/errored issue
  resolved earlier in the array → caught by branch 1/2 first). Correctly described as invariant violation.

## Build health: tsc --noEmit clean, eslint clean, all 631 workflow tests pass (20 Docker-skipped).
