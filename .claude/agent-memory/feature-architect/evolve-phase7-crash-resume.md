# Evolve Phase 7 — crash-resume of in-flight fan-out batch (UNCOMMITTED, reviewed 2026-06-20)

Reviewed for code DUPLICATION / missed reuse (not correctness). Verdict: **SOME DUPLICATION**, one
notable cross-language reinvention. Builds on [[evolve-phase6-aggregated-escalation]],
[[evolve-phase5-cognition-promotion]], [[evolve-fanout-concurrency]].

## The load-bearing seam: nodes.json parsing is owned by Python, re-spelled in TS
- `src/workflow/workflows/evolve/scripts/evolve_result.py` owns ALL nodes.json walking:
  `_nodes_payload` (run_dir/database_data/nodes.json read+shape-guard), `_node_id(node, fallback)`
  (id|int(key)), `_sorted_nodes` (sort by id), `_find_recorded_node_for_step(run_dir, step_name)`,
  `_next_batch_index(run_dir, workers)` (now does in-flight-batch detection: highest lane-tagged batch
  whose lanes ⊉ range(workers) → reuse highest, else highest+1).
- Phase-7 TS `reconstructFanOutBatchFromDb` (orchestrator.ts ~3118) re-implements ALL of that in TS:
  `readEvolveNodes`≈`_nodes_payload`, `asRecord`, `nodeIdFromRecord`≈`_node_id`,
  `nodeParentFromRecord`, and the `highestBatch`/`lanesByBatch`/`expectedLanes.some(!has)` block ≈
  `_next_batch_index` byte-for-byte in logic. `EVOLVE_LANE_STEP_RE` duplicates Python `STEP_NAME_RE`
  (the diff even widened both regexes the same way in lockstep — a tell that they're one concept in
  two languages). No bridge subcommand emits a recorded-lane map, so TS chose to re-walk rather than
  delegate. Architecturally the bridge should report recorded lanes (it already gained --lane/--batch-index).
- `step_<NNNN>_lane_<k>` format is now spelled in 4+ places across both languages (TS recordedByStep key
  build + synthesize payload, Python f-string, both regexes). DEFAULT_EVOLVE_LANE_DIR in lane-template.ts
  is the cross-ref anchor the code comments point at.

## Test-fixture duplication (the +287/+92)
- `writeLaneNodes` (evolve-result-bridge.test.ts:344) and `writeEvolveNodes` (orchestrator-fanout.test.ts:271)
  are byte-identical node-record builders (same Object.fromEntries body); only the dir base differs
  (runDir vs workspace/.evolve_runs/main). Should be ONE shared helper in test/workflow/ taking a base dir.
- New tests' inline `deterministicStub` (diff lines ~797 and ~900) re-spell the EXISTING barrier stub
  (orchestrator-fanout.test.ts:493-520): same sample_batch/promote_cognition/stop_signals branches +
  `return recordedDeterministicStub(input)` fallthrough. Only delta: append node on analysis_record +
  lane-restricted lanes:[1,2]. Extract a parameterized barrier-stub factory.
- `evolveBarrierDefinition` (new helper, diff:673) IS a good extraction of the inline sampleCommand/
  attachCommand/`{...fanOutDefinition,states}` from the OLD barrier test (lines 443-478) — but the diff
  did NOT refactor that old inline copy to use it, leaving the dup behind.

## What the diff reuses CORRECTLY (don't flag)
- `evolveRunDirForFanOutSegment` reuses `isEvolveSampleCommand` + `commandFlagValue`. Good.
- `reconstructFanOutBatchFromDb` reuses `containerPathToWorkspaceRelative`. Good.
- `synthesizeRecordedFanOutOutcome` reuses `buildFanOutLaneContext` for the base context. The
  RoundChildOutcome it hand-builds is NOT a 1:1 dup of waitForRoundChild's `finish()` (no actor to
  observe) — acceptable, but the `{round+1, previousStateName, lastDeterministicResult}` shape echoes
  the drained/recorded synthesis; a tiny `makeRecordedOutcome` helper could unify.
- prepareFanOutLaneResults/buildEvolveSampleBatchInput correctly THREAD the new options through the
  existing buildEvolveBarrierInput shim — no new exec wiring, no buildEvolveBarrierInput re-spell. Good.

## CORRECTNESS verdict (separate review 2026-06-20): CORRECT-WITH-FIXES (minor)
- **#1 partial reconciliation CORRECT.** Recorded lane detected by `step_<batch>_lane_<k>` lookup →
  synthesized (no re-spawn); only missing lanes re-spawned (createActor in `childActors`, synth lanes
  `continue` before push so drain never touches them). lanePromises dense, allSettled over all N.
- **#2 no-dup + batch_index CORRECT (load-bearing).** Ran both derivations side-by-side across 9
  scenarios: TS `reconstructFanOutBatchFromDb` batch_index === Python `_next_batch_index(.., workers)`
  for ALL (fresh=1, complete-b1=2, partial-b1=1 REUSE, partial-b2=2 REUSE, legacy-non-lane=3,
  drained=reuse-never-used). When recordedByLane.size>0 TS PINS `--batch-index` so Python can't diverge;
  size==0 → undefined → Python recomputes same. Belt (reconcile skips) + suspenders (engine
  meta_info.step_name short-circuit for record, bridge:1106 for attach_analysis) both real.
- **#3 mixed join CORRECT.** Synth lane has lane.id (buildFanOutLaneContext) so promoteBarrierCognition
  includes it; promote dedups by lesson digest in cognition_promoted.json (no double-promote). Recorded
  lane's `current/lane_<k>/analysis.md`+analysis_record.json SURVIVE resume: sample_batch's per-lane
  `_clear_current_round(run_dir, lane)` only iterates lane_ids (missing lanes); recorded lane absent.
- **#4 bundle mint CORRECT.** preMintFanOutScopeBundle→ensureBundleForScope runs BEFORE reconstruction
  (orchestrator.ts:2719 before :2721); empty bundlesByScope on resume → mint once.
- **#5 nothing-worse CONFIRMED.** Synth lane round-equivalent to fresh recorded (both round+1 →
  mergeRecordedFanOutContext roundDelta sums +1/lane same as normal path). No recorded node lost, no
  recorded eval re-run.
- **#6 no scope creep.** No getPersistedSnapshot/spawn/EvalSlot/reproducible (only deferral comments).
  evolve_core/ byte-verbatim (git diff empty). tsc+eslint+prettier clean.
- **Gate item 6 HAS runnable non-Docker coverage** (2 orchestrator tests pass: line 558 in-process
  reconstruct, 637 full resume() replay from `machineState:'workers'` checkpoint; bridge:1443 Python
  missing-lanes-only). appendEvolveNode THROWS on dup step_name → proves belt (recorded lane never
  re-recorded). Tests do NOT model engine idempotency suspenders (stub throws not short-circuits);
  suspenders covered separately by bridge:827.
- **SHOULD-FIX (cosmetic):** evolve_result.py:1023 per-lane context `"sample_n": workers` is stale on
  resume (says 3 while only len(lane_ids)=2 parents drawn); `active_lane_count` (:1024) is the accurate
  field. No consumer reads sample_n back (observational only) → not a correctness bug.
- **CONSIDER:** TS recordedByStep lookup assumes 4-digit zero-pad (`padStart(4)`); a malformed
  externally-written non-4-digit lane step would miss→re-spawn→rely on engine idempotency. Python always
  writes `:04d` so unreachable in practice.
