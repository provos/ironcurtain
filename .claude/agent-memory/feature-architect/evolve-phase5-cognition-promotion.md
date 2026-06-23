# Evolve Phase 5 — serialized cognition promotion at the barrier (commit 6f92a20)

Reviewed for code correctness. **Verdict: CORRECT.** The `.promote.lock` retirement IS safe — no
concurrent-promotion path survives. Resolves the Phase 4 cognition race ([[evolve-fanout-concurrency]]).

## The single-writer invariant (why the lock retirement is safe)
The discriminator for "does this promote inline?" is `lane is None`, NOT a workers count. The two align
by construction:
- `buildFanOutLaneContext` (orchestrator.ts:2935) returns the parent context UNCHANGED at `workers === 1`
  → no `lane` field → `templateLaneCommand`/`injectEvolveLaneArg` (lane-template.ts:99,128-135) does NOT
  inject `--lane` → `attach_analysis` runs `lane is None` → inline `_promote_lesson` fires
  (evolve_result.py:1123 gate `... and lane is None`). Byte-identical to pre-Phase-5.
- `workers > 1` → every child gets `lane.id` → `--lane <k>` injected → `attach_analysis` gate FALSE →
  records only. The ONLY promoter is the barrier `promote_cognition`, called once per batch from
  `promoteBarrierCognition` (orchestrator.ts:2681-2682), gated on `workers > 1 && verdict === 'recorded'`,
  AFTER `Promise.allSettled` (all children done) and BEFORE orchestrator re-entry. One serial Python loop
  (evolve_result.py:1151). No lane still running → zero concurrency. Plain RMW ledger correct.

## Mixed-verdict batch (recorded + blocked/errored): NOT a lost-lesson defect
`joinFanOutBatch` (orchestrator.ts:3195-3222) returns `evaluator_blocked`/`result_file_error` (not
`recorded`) if ANY lane blocks/errors → `promoteBarrierCognition` skipped → recorded lanes' lessons NOT
promoted that turn. On APPROVE→resume, recorded lanes idempotent-skip in attach_analysis
(evolve_result.py:1046-1068, still `verdict:recorded` → status `recorded`) → barrier promotes them; ledger
dedups. So lessons promoted on resume, NOT permanently lost. CAVEAT: ABORT/FORCE_REVISION (not resume-same-
batch) → recorded lanes' lessons never promoted. Within §9 spec (promotion deferred to all-recorded join);
a behavior delta from a per-lane model but intended. CONSIDER, not defect.

## Edge cases in promote_cognition (evolve_result.py:1137-1205) — read, not all runnable-probed
- Empty/missing analysis for a recorded lane → `_promote_lesson` returns `empty_lesson`/`no_analysis_file`
  (lines 642-646), NOT appended to `errors` → `skipped_count++`, verdict stays `cognition_promoted`,
  `passed:True`. Correct (recorded lane with no lesson legitimately skipped).
- `missing_step_name`/`recorded_node_missing` → appended to `errors` → `fatal=True` → `needs_repair`,
  `passed:False` → batch fails via fanOutErrorResult. Defensible: orchestrator only passes `status:recorded`
  lanes, so a missing node is a real inconsistency.
- `_dedupe_lanes` (line 719) dedups duplicate `--lane` args. Orchestrator pre-dedups via distinct child ids
  + `.sort()` (orchestrator.ts:2723-2729), so belt-and-suspenders.

## Runnable coverage (REAL_ENGINE_READY = numpy+yaml present locally; NOT Docker-gated)
- **workers:1 inline-identical**: bridge tests via `recordRealStep` (no `--lane`) prove inline promote still
  fires (`cognition_promoted:{promoted:true}`), dedup (line 1026), idempotent-skip no-promote (line 1044).
  Orchestrator workers:1 fan-out path runs to `done` (orchestrator-fanout.test.ts:219) but does NOT
  explicitly assert "no barrier promote" nor exercise real inline promotion (non-evolve stubs).
- **workers:3 gate**: bridge `real-barrier-promote` test (3 distinct lessons promoted once, replay→3 dups,
  no `.promote.lock`) RUNNABLE + passing. orchestrator-fanout workers:3 test asserts exactly ONE
  promote_cognition call with `--lane 0/1/2` + barrierOrder `[sample_batch, ..._promote_cognition,
  ..._stop_signals]` — non-Docker, passing. Docker integration test (evolve-single-round) is the N=3
  end-to-end, skipIf(!dockerReady) but not sole proof.
- All 42 tests in the two suites PASS locally. `tsc --noEmit` clean.

## Scope / byte-verbatim
`evolve_core/` UNTOUCHED. No Phase 6 (aggregated escalation / childActor.stop), Phase 7 (resume re-spawn /
getPersistedSnapshot), Phase 8 (EvalSlot pool) leakage. Grep clean.

## Minor (SHOULD/CONSIDER)
- `buildEvolvePromoteCognitionInput` returns `undefined` (→ silent skip, no error) when attach command lacks
  `--run-dir` or unresolvable result path (orchestrator.ts:2766-2772), same posture as stop_signals. Fine
  for the linted evolve manifest; a malformed manifest silently skips promotion rather than failing.
- promote derives container/scope/timeout from the `attach_analysis` (analysis_record) state; stop_signals
  derives from `segment[0]` (sample). Both valid under §8.2 single-scope homogeneity; if a future segment
  splits container scopes across members, these two barrier ops could target different scopes.
