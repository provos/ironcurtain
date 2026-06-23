# Evolve N-way fan-out — concurrency hazards (shared per-batch scratch files)

Reviewed Phase 4 of `docs/designs/evolve-sync-parallelism-slice.md` (commit 9d07b98). The fan-out
core is sound; the durable hazards are concurrent writes to SHARED (non-lane-scoped) scratch files
that the linear chain never exercised concurrently. Phase 4 is the first concurrent writer for these.

## Lane scoping rule (the partition that decides safety)
- Lane-scoped (`current/lane_<k>/`, safe): step_name, context.json, sample.json, result.json,
  analysis.md, analysis_record.json, cognition_item.json. Driven by `lane-template.ts`
  (`templateLaneCommand`/`laneScopeEvolveCurrentPath` in machine-builder; `applyLaneTemplate` for
  agent prompts in prompt-builder). `_clear_current_round(run_dir, lane)` clears only lane files.
- SHARED bare `current/` (RACY under N>1):
  - `current/stop_signals.json` — `_stop_signals_path` (evolve_result.py:75-76) is NOT lane-scoped;
    `attach_analysis` writes it via non-atomic `_write_json` per lane (evolve_result.py:1029). N lanes
    race → last-writer-wins + torn write on a ROUTING input the orchestrator reads (workflow.yaml
    orchestrator prompt). Phase 5 (§9) is supposed to recompute it once at the join; Phase 4 ships the race.
  - cognition store `cognition.json` + dedup ledger `cognition_promoted.json` — see below.

## Cognition store is NOT cross-process safe (and reader is brittle)
- `evolve_core/cognition.py`: `self.lock = RLock()` (line 30) is IN-PROCESS only. Each lane's
  cognition `add` is a separate `docker exec` → separate Python process, so the RLock is useless
  across lanes. `_save()` (cognition.py:103-111) is a full-file `open("w")`+json.dump — NO atomic
  `os.replace`. `_load()` (cognition.py:114-119) is bare `json.load`, NO try/except → a torn store
  HARD-FAILS the next batch's `evolve-cognition search` → sample_error → result_file_error.
- So the deferred (Phase 5) cognition race is NOT strictly "lost lesson": it can corrupt the store
  file. Node DB is unaffected (real cross-process `InterProcessFileLock` in database.py:67-74).
- Phase 5 serialization must also add atomic write + cross-process lock, not just barrier ordering.

## Orchestrator per-state shared mutations under N concurrent lanes (the §5.4 audit surface)
- `nextStateSlug` (config/paths.ts:604-620) is check-then-act: readdirSync→max+1, caller mkdirSync
  (orchestrator.ts:2192-2194). N same-state lanes compute the SAME slug → session.log /
  session-metadata.json collide into one dir (mkdirSync recursive no-ops). NOT lane-keyed. Fix: put
  `lane.id` in the slug. (§5.4 claims this audit passes for Phase 4 — it does not, for this row.)
- MITM `tokenSessionId` is a single shared mutable field (mitm-proxy.ts:1864); each lane flips it
  (orchestrator.ts:2345). Per-RESPONSE pin `sidAtAttach` (mitm-proxy.ts:945) only stops splitting ONE
  stream, not cross-lane misattribution. BUT aggregate `instance.tokens.outputTokens` is SAFE: the
  token bus sums across ALL registered sessionIds (orchestrator.ts:1341); every lane registers
  (:2359). Merge promotes the aggregate (mergeRecordedFanOutContext). Only per-lane breakdown is racy.
- `cyclePolicy` (orchestrator.ts:1011-1061): read-then-set window (:1017 read, :1060 set) is NOT
  serialized; N first-entry lanes all run loadPolicy. Safe ONLY because evolve personas are
  homogeneous (`global`) → idempotent. Would break with heterogeneous lanes.
- `messageLog.append` (message-log.ts:133) uses synchronous `appendFileSync` of one
  `JSON.stringify+'\n'` → atomic in single-threaded Node for small entries. No torn lines. Safe.
- `Set.add`/`delete` on sessionIds: synchronous, atomic in single-threaded JS. Safe.

## What IS correct (don't re-flag)
- Distinct parents per lane: ONE barrier `evolve-db sample --n workers` + `_partition_sampled_parents`
  using `remaining.pop(idx)` → disjoint by construction; per-lane seed base_seed+laneId; greedy
  rejected for workers>1; duplicate-id guard. (evolve_result.py sample_batch + _partition_sampled_parents)
- Barrier: `waitForRoundChild` subscribes BEFORE child.start() AND re-observes getSnapshot() to close
  the sync-settle race (orchestrator.ts:2876-2901). Join is `Promise.allSettled` (one rejection
  doesn't abandon peers). Parent enters `workers` once/batch; orchestrator once/batch.
- `provideActors` called once on roundMachine, shared across N child actors — safe because the
  agent/deterministic `src` are stateless closures over workflowId keyed on per-actor `input`.
- Lane-tagged step names `step_<batch>_lane_<k>`; `_resolve_round_name` catches the int() ValueError
  (evolve_result.py:148-150). Node ids atomic under DB lock.

## Gate item 2&3 runnable coverage: YES (Phase-3 gap not repeated)
- test/workflow/orchestrator-fanout.test.ts "runs three recorded lanes…" (non-Docker): 3 distinct
  lane ids across sample/evaluate/analysis_record, workers entered once, orchestrator twice, token
  fan-in=33, fanout_join logged. test/workflow/evolve-result-bridge.test.ts proves sample_batch
  partitions distinct parents + rejects dups. Docker integration test is skipIf(!dockerReady) but
  not the sole proof.

## Phase boundaries (for scope-creep checks on later commits)
- P4: N children + allSettled barrier + joinBatch + lane-template prompts + sample(n=N) + dup-rate.
- P5: serialized cognition promotion + once-per-batch stop_signals recompute. P6: childActor.stop()
  drain + single aggregated gate. P7: DB-as-truth resume re-spawn. P8: thin EvalSlot pool.
