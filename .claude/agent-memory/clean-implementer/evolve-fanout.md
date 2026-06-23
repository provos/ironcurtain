# Evolve N-way fan-out (sync-parallelism slice)

Design: `docs/designs/evolve-sync-parallelism-slice.md`. Vendored `evolve_core/` is byte-verbatim — all bridge changes go in `src/workflow/workflows/evolve/scripts/evolve_result.py`, never `evolve_core/`.

## Layering: where each piece lives
- **lane-template.ts** (`src/workflow/`): per-lane path/prompt/argv templating. Pure literal substitution over TRUSTED orchestrator-controlled lane dirs/ids — no escaping needed *because of that invariant* (documented in the module header). `evolveResultScriptIndex` + `EVOLVE_RESULT_SCRIPT` const are exported here and imported by orchestrator.ts; do NOT re-spell the find/`endsWith` matcher in the orchestrator. The `/^lane_\d+\//` guard in `replaceCurrentPrefix` makes lane-scoping idempotent (no `lane_2/lane_5/` nesting).
- **orchestrator.ts** fan-out methods: `runFanOutSegment` (the `workers`-state `fromPromise` body) creates N free-standing `createActor(roundMachine)` + `.start()`, joins via `Promise.allSettled` over `waitForRoundChild`. `prepareFanOutLaneResults`→`buildEvolveSampleBatchInput` runs ONE barrier `sample_batch(n=N)` (not N `sample()`) and replays per-lane results. `mergeRecordedFanOutContext` folds N lane contexts → one spine context (parent `visitCounts` authoritative; `round` sums positive deltas; `reviewHistory` suffix-append; `humanPrompt` nulled; tokens from instance accumulator).
- **Python bridge** `evolve_result.py`: `sample` + `sample_batch` share `_run_cognition_seed_init` / `_run_db_sample` / `_run_cognition_search` (each owns its own `sample_error` write) + `_parent_ids`. Lane scoping via `_current_dir(run_dir, lane)` and a `--lane`/`EVOLVE_LANE` flag.

## stop_signals is BARRIER-OWNED (SHOULD-FIX-1)
- The canonical `current/stop_signals.json` is the single routing input the orchestrator reads once/batch. Per-lane `attach_analysis` must write ONLY `current/lane_<k>/stop_signals.json` (pass `lane` to `_write_stop_signals`/`_stop_signals_path`); at `workers:1` (lane=None) it still writes the bare canonical inline (byte-identical backward compat).
- The canonical file is computed ONCE at the join: bridge subcommand `compute_stop_signals` (atomic temp+rename via `_write_json_atomic`), invoked from `orchestrator.runFanOutSegment` via `computeBarrierStopSignals`→`buildEvolveStopSignalsInput` ONLY when `workers > 1 && verdict==='recorded'`.

## Per-lane artifact-dir collision (MUST-FIX-2)
- `nextStateSlug(statesDir, stateId, laneId?)` in `config/paths.ts`: pass `context.lane?.id` so N same-state lanes get distinct `{stateId}_lane_{id}.{N}` diagnostics dirs (`session.log`/`session-metadata.json`). `_lane_<id>` is path-safe; the bare `{stateId}.{N}` namespace is unaffected.

## Python gate is `ruff check` ONLY (not `ruff format`)
- No ruff config in repo; `evolve_result.py` is written ~120-col wide, so `ruff format` (default 88) would churn pre-existing code. The gate is `python3 -m py_compile` + `ruff check`. Match new code to the existing wide style; do NOT run `ruff format`.

## Token attribution under fan-out is best-effort
- N lanes share one long-lived MITM; `setTokenSessionId` is racy. The AGGREGATE `instance.tokens.outputTokens` (summed over all registered sessionIds) is authoritative for budget + merge; the per-lane split is not. Comment lives at the `setTokenSessionId(agentSessionId)` call in `executeAgentState`.

## workers:1 vs workers>1 scratch-shape disambiguator (Phase 6)
- `buildFanOutLaneContext` returns the BARE parent context (NO `lane` marker) when `workers===1`; sets `lane.{id,dir,relativeDir}` when `workers>1`. So `source.context.lane === undefined` is the authoritative discriminator for "bare `current/`" (legacy `evaluate`-resume) vs "lane-scoped `current/lane_<k>/`" (discard + fresh `design` batch).
- At workers:1 a blocked lane still routes through `runFanOutSegment` → verdict `escalate` → human_escalation. On APPROVE the orchestrator LLM must route to `evaluate` (re-run the one written-but-unscored candidate), NOT `design`. There is NO structural backstop — a wrong `design` discards the candidate — so the fix is MESSAGE-only: `promoteFanOutIssueContext` appends a scratch-shape sentence ("Scratch is the bare current/" vs "Scratch is lane-scoped") to `previousAgentOutput`, and `workflow.yaml` orchestrator prompt branches its two recoveries on that wording.
- `roundChildReason` asymmetric fallback is load-bearing: errored prefers `lastError` (it tripped `storeError`) then `previousAgentOutput`; blocked prefers `previousAgentOutput` (evaluator_blocked never trips storeError so lastError is null) then `lastError`. Do NOT unify the branches.
- `RoundChildDrainTrigger.reason` is computed ONCE at the trigger source (`waitForRoundChild`'s `finish`) and threaded, so the drain log + every drained peer's `drainedBy` reuse it. `drainedBy` is surfaced in the `fanout_join` log via the optional field on `RoundChildSummary` (was dead state pre-Phase-6).
- `waitForRoundChild` keeps a hand-rolled subscribe loop (NOT `xstate.waitFor`): the drain route resolves the SAME promise from OUTSIDE the actor's snapshot stream, which `waitFor` cannot express.

## Crash-resume batch-index: fully-recorded highest batch ADVANCES (does NOT reuse/synthesize)
- The reuse-vs-advance heuristic (`reconstructFanOutBatchFromDb` in orchestrator.ts, twin of Python `_next_batch_index(run_dir, workers)`) only REUSES the highest batch index when its current-worker lanes are PARTIALLY present (some expected lane missing → in-flight). A FULLY-recorded highest batch (every lane present) advances to `highestBatch + 1` and re-runs ALL lanes fresh (verified: Python `_next_batch_index` returns 2 for all-3-of-3 recorded, workers=3). nodes.json alone cannot distinguish "join done" from "crashed just before join" for a complete batch; the safe choice is advance + idempotent re-run via lane-tagged step names.
- CONSEQUENCE for tests: an "all-recorded batch ⇒ zero respawn, all synthesized, sample_batch early-out" premise is IMPOSSIBLE under the validated heuristic — it advances and re-runs everything. The genuinely-untested edge to cover is the ADVANCE branch (fresh batch 2, all lanes re-run, NO `--batch-index` pin because recordedByLane is empty, both batches' nodes coexist). Do not write a test asserting synthesis for an all-recorded batch; it contradicts the engine.
- Synthesis + index-reuse only happens for the PARTIAL case (recordedByLane.size>0 AND missingLanes nonempty), which pins `--batch-index` so the bridge can't diverge.

## TS↔Python batch-index seam: TS is authoritative, NOT the bridge echo
- TS must derive the batch index BEFORE `sample_batch` runs (it pins `--batch-index` into that very call and decides synthesize-vs-respawn per lane), so it CANNOT consume the bridge's `sample_batch_prepared` echo — that would invert the ordering. Keep the TS derivation; the two derivations must move together (cross-ref comments on both sides cite the shared `step_<batch>_lane_<k>` format). `evolveStepName(batchIndex, lane)` + `EVOLVE_STEP_INDEX_WIDTH` in lane-template.ts is the single TS spelling of the format (was reconstructed inline at the `recordedByStep` lookup).

## Optional regex group + `no-unnecessary-condition` eslint friction
- `noUncheckedIndexedAccess` is OFF, so `RegExpExecArray[2]` types as `string`, but an unmatched OPTIONAL group is `undefined` at runtime. `if (match[2] === undefined)` then trips `@typescript-eslint/no-unnecessary-condition` ("types have no overlap"). Widening via a `: string | undefined` local does NOT help (RHS narrows it back). Project convention: `// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- <runtime-is-more-nullable-than-type reason>` (same pattern as proxy-mcp-connections.ts:60, config-command.ts:135). Use that, keep `match[2]`.

## sample_n field semantics (resume)
- In `sample_batch` lane payloads, `sample_n` = `len(lane_ids)` (parents ACTUALLY drawn this call), NOT `workers` (configured). On a fresh batch they coincide; on a resume re-running only missing lanes they differ. `workers` stays available in the batch-level `sample_batch_prepared` payload. No consumer reads `sample_n` back today (observational).

## Proving a fix has a failing-without-it test
- Save the fixed file to `/tmp`, patch the revert in-place with a python heredoc, run the targeted `vitest run -t`, then `cp` the saved copy back. After editing externally, RE-VERIFY with `diff` — a "linter modified the file" reminder may be misleading and the revert can persist.
