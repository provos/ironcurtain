# Evolve Native Workflow — Correctness Slice (run-spec stop conditions take effect + resume-safe durable record)

Status: **Design — revised; ready to implement.** (This revision settles the doc against an independent critical review: the resume/idempotency half — Fix C — was verified sound and the failure mode real, and is preserved as-endorsed; the stop-signal half — Fixes A/B — had a real correctness bug, over-claimed tests, and a self-contradiction, all corrected here. Patience is ENFORCED, not advisory — the maintainer decision. The corrected scope adds two `preflight`-prompt edits, and the stop signals are now computed **post-record in `attach_analysis`**, not in `sample`.)

Audience: IronCurtain workflow + docker-infrastructure engineer extending the merged `evolve` workflow package (all five prior increments — single/multi-round hub, human-surface gates, generic experiment harness — are on `master`).

Implementation contract: this document names the exact deltas for three correctness fixes. The touched files are **`src/workflow/workflows/evolve/workflow.yaml`** (the `orchestrator` prompt, the `preflight` prompt, the `final_summary` prompt — no FSM topology) and the bridge **`src/workflow/workflows/evolve/scripts/evolve_result.py`** (`attach_analysis` gains both the idempotency guard AND the post-record stop-signal computation). The vendored `evolve_core/` engine stays **byte-verbatim** — no change. Two of the fixes make the run-spec's already-authored-but-ignored stop conditions actually take effect (target-met early stop; patience); the third makes the one non-idempotent state (`analysis_record`) resume-safe so a crash in the checkpoint window cannot append a round's node twice. It is precise enough to implement without re-deriving the hub machinery, the human-gate surface, or the evaluator-wiring seam — those are cited from the merged tree, not re-designed.

Predecessors (merged, build ON — do not redesign):

- **Experiment-harness slice** — `docs/designs/evolve-experiment-harness-slice.md` (#309, on master). The `provision` state, the generic `preflight` that authors the run spec via `evolve-brief normalize`, and the `--workspace` experiment-dir staging. This slice consumes the run-spec fields `preflight` already authors (`evaluation.success_criteria`, `budget.patience`) but **never wires** today.
- **Human-surface slice** — `docs/designs/evolve-human-surface-slice.md` (on master). The `preflight_review` / `human_escalation` / `final_review` gates, the `final_summary` agent state, and the `aborted` terminal. This slice does not touch any gate; it only makes the orchestrator emit `complete` sooner and gives `final_summary` a reason for the stop.
- **Multi-round slice** — `docs/designs/evolve-multi-round-slice.md` (#302). The orchestrator hub, the `sample`/`researcher`/`evaluate`/`analyzer`/`analysis_record` spokes, the `evolve_result.py` bridge, and the determinism invariants. This slice extends `analysis_record`/`attach_analysis` only on the bridge side: `attach_analysis` gains both the idempotency guard AND — after the durable record — the deterministic stop-signal computation (so the signal reflects the just-recorded node). `sample` is unchanged.

---

## 1. Summary & goals

The merged `evolve` workflow has three correctness gaps, all of which this slice closes:

1. **The run-spec's `evaluation.success_criteria` is authored, validated, displayed — and never consumed.** `preflight` resolves a concrete target (e.g. `eval_score >= 2.635`, harness slice §7.1) and `evolve-brief normalize` writes it into the spec, but the orchestrator's only completion condition is `done_rounds >= max_rounds` (`workflow.yaml:300`). A run that crosses the target on round 2 of a 5-round budget keeps burning rounds and tokens for no benefit. **Fix A: also complete when the best recorded `eval_score` satisfies the target.**
2. **`budget.patience` is authored (`--patience 2`, `workflow.yaml:210`), validated (`run_state.py:76`), displayed — and never consumed.** A search that has plateaued for `patience` consecutive evolution rounds keeps running to the budget cap. **Fix B: also complete when the best score has not improved for `patience` consecutive evolution rounds.** (Maintainer-decided: ENFORCED, not advisory — §12.)
3. **`analysis_record` is the one non-idempotent state.** It calls `attach_analysis` → `evolve-db record` → `cmd_db_record`, an **unconditional append** (`evolve_core/cli.py:472`, `db.add_with_previous_nodes`) that always allocates a fresh node id with no existing-node check. The workflow checkpoint and the engine's `nodes.json` are written by **different layers** and are **not atomic**: a crash after the node append but before the checkpoint advance leaves the run pointed at `analysis_record`, so resume re-enters it and **appends the round's node a second time** — a duplicate node, which inflates `done_rounds` (= node count) and corrupts the search. **Fix C: make the record idempotent** — keyed on the node's `meta_info.step_name` (`cli.py:470`), which every node already carries.

The whole slice is two files:

- **`workflow.yaml`** — three prompt edits, no FSM-topology change. (1) Extend the `orchestrator` prompt to route `complete` on the bridge's single pre-computed `stop_reason` (not just `done_rounds >= max_rounds`); the orchestrator stays the LLM hub, but it routes on a verdict the bridge computed, not arithmetic it does itself. (2) Extend the `preflight` prompt so the FIRST `success_criteria` entry is the canonical `<core_score> <comparator> <number>` form the strict bridge parser reads, and delete the now-false "not a hard gate (the run stops on max_rounds)" sentence (`:164`). (3) `final_summary` states WHY the run stopped, reading the bridge's recorded `stop_reason`.
- **`evolve_result.py`** — both deltas land in `attach_analysis` (the durable-record state), so the signal reflects the just-recorded node: (1) a **dedup guard** that, before shelling to `evolve-db record`, scans `nodes.json` for a node whose `meta_info.step_name` equals this round's step and — if found — short-circuits to `recorded` with that node's id, appending nothing (Fix C); (2) **after** the record (or the idempotent find-or-create), it computes `best_score`, `rounds_since_improvement`, `target_met`, `patience_exceeded`, and a single `stop_reason` over the now-current `nodes.json` + `run_spec`, and writes `current/stop_signals.json` (Fix A/B). `sample` is NOT touched.

### Non-goals (out of scope)

- **No `evolve_core/` change.** The byte-verbatim vendored-engine invariant holds. The idempotency guard goes in the BRIDGE (`attach_analysis`), NOT in `cmd_db_record`. The stop signals are computed in the BRIDGE (`attach_analysis`, after the record) and routed in the PROMPT, never in the engine.
- **No new state, no new gate, no new terminal.** The FSM topology is unchanged. Fix A/B change the `orchestrator` prompt's `complete` condition (the existing `complete → final_summary` edge is reused); Fix C changes `attach_analysis` internals (the existing `recorded`/`needs_repair` verdicts are reused). The `--strict` lint surface does not change.
- **No new run-spec schema field.** `success_criteria` and `patience` already exist and are already authored by `preflight`. This slice reads them; it does not add fields. (Adding a structured numeric-target field alongside the free-form string was considered and rejected — it would touch the `evolve_core` schema, violating the byte-verbatim invariant; the slice tightens the `preflight` prompt instead, §5.2.)
- **No change to the `evaluate`/`analyze`/`record` ordering or to determinism.** The hub still routes the same five verdicts; only the `complete` decision gains two more reasons.
- **No general atomic-checkpoint fix.** Fix C makes the ONE non-idempotent state idempotent (the durable record). It does not attempt to make every deterministic state's `resultFile` write atomic with the checkpoint advance — that is a broader orchestrator change out of scope; here the node-append is made replay-safe at the bridge, which is the surgical fix for the only state where a replay corrupts durable state.

### Goals (binary, restated as the gate — §11)

After this slice, the completion gate proves all of:

1. **Resume idempotency** — a bridge-level test proves `attach_analysis` called twice for the same `step_name` leaves exactly one node and returns the same `node_id`; a workflow-level resume test proves re-entering `analysis_record` across a simulated crash window adds no duplicate node.
2. **Target-met early stop** — a Docker integration test where the synthetic evaluator's score crosses the target before `max_rounds` completes early (fewer nodes than `max_rounds`) with stop-reason `target_met`.
3. **Patience** — a Docker integration test where scores plateau for `patience` rounds before `max_rounds` completes early with stop-reason `patience`.
4. **`tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict` is clean**, and the existing evolve gates (single/multi-round/human-surface/harness) still pass.

## 2. The three correctness gaps — what is broken today (cite, do not re-derive)

Every fact below is verified in the current merged tree.

### 2.1 Gap A — target-met early stop (success_criteria authored, never consumed)

- **It is authored.** `preflight` resolves a concrete target and passes `--success-criterion "SUCCESS_CRITERION"` to `evolve-brief normalize` (`workflow.yaml:208`, harness slice §7.1 resolves it to e.g. `eval_score >= 2.635`).
- **It is written.** `evolve-brief normalize` stores it: `spec["evaluation"]["success_criteria"] = flatten_list(args.success_criterion)` (`evolve_core/cli.py:148`). The schema default is the empty list (`run_state.py:29`).
- **It is validated — for non-emptiness only.** `REQUIRED_FIELD_CHECKS` requires `success_criteria` to be a non-empty list (`run_state.py:71-73`); it never parses the string.
- **It is displayed.** The brief summary renders `Success criteria: {', '.join(...)}` (`run_state.py:222`).
- **It is NEVER consumed as a stop condition.** The orchestrator's only `complete` rule is `done_rounds >= max_rounds` (`workflow.yaml:300`). No state reads `success_criteria` and compares it against any recorded score. So a run that crosses the target early still runs to the budget cap.

The free-form shape matters: `success_criteria` is a **list of strings** (`run_state.py:29`), e.g. `["eval_score >= 2.635"]`. There is no structured `{metric, comparator, threshold}` today. §5.2 decides how to extract the numeric target.

### 2.2 Gap B — patience authored, never consumed

- **It is authored.** `preflight` passes `--patience 2` to `evolve-brief normalize` (`workflow.yaml:210`).
- **It is written.** `spec["budget"]["patience"] = args.patience` (`evolve_core/cli.py:151-152`). Default `0` (`run_state.py:33`).
- **It is validated — for `>= 0` only.** `"budget.patience": lambda spec: int(...) >= 0` (`run_state.py:76`). No semantics.
- **It is displayed.** `Budget: max_rounds=..., patience=...` (`run_state.py:223`).
- **It is NEVER consumed.** Nothing computes "rounds since the best score last improved" or compares it to `patience`. A plateaued search runs to the cap.

The maintainer chose **enforcement** over the harness/multi-round design's earlier "advisory" stance (§12 records the superseded rationale). This slice implements it.

### 2.3 Gap C — analysis_record is the one non-idempotent state (duplicate-node-on-resume)

`analysis_record` is the **single durable engine node-write** of the round (`workflow.yaml:432-461`; `description: The single durable engine node-write`). It is a `deterministic`, `container: true` state that runs the bridge `attach_analysis` (`workflow.yaml:438-453`):

```
attach_analysis --run-dir … --step-from-current --name-from-current --parent-from-current
                --code-from-current --results-from-current --analysis-file … --result-file …
```

`attach_analysis` (`evolve_result.py:399-448`) resolves `step_name` (`--step-from-current`, via `_step_name_from_current`, `:64-65`), the round name, parent, code/results paths, then shells to `evolve-db record` (`:407-427`). That helper enters the engine's `cmd_db_record` (`cli.py:417-489`), which builds:

```python
node = Node(name=…, parent=…, code=…, results=…, analysis=…, score=…,
            meta_info={"step_name": step_name})        # cli.py:462-471
node_id, previous_nodes = db.add_with_previous_nodes(node)   # cli.py:472
```

`add_with_previous_nodes` (`database.py:67-75`) **always** sets `node.id = self.next_id`, increments `next_id`, and stores it. There is **no existing-node check** — it is an unconditional append.

**Why this is a bug across a crash.** The workflow checkpoint (which state the run is in) and the engine's `nodes.json` (the appended node) are written by **different layers** and are **not atomic**:

1. `analysis_record` runs; `attach_analysis` → `evolve-db record` → `cmd_db_record` appends the node and `db.save()` writes `database_data/nodes.json` (`_save_locked`, `database.py:138-167`, `os.replace` of a temp file at `database.py:162` — the node-write itself is atomic; note `:117-119` is the `data_file.unlink()` in `reset()`, NOT the save path).
2. The deterministic state's `resultFile` (`current/analysis_record.json`) is written with `verdict: recorded`.
3. **Separately**, the orchestrator records the transition *out of* `analysis_record` into the checkpoint.

A crash in the window between (1)/(2) and (3) leaves the durable `nodes.json` with the new node **but** the checkpoint still pointing at `analysis_record`. On `workflow resume`, the run re-enters `analysis_record`, `attach_analysis` runs again with the **same** `--step-from-current` step, and `cmd_db_record` appends the round's node **a second time**.

**The blast radius.** A duplicate node:

- **Inflates `done_rounds`.** `done_rounds = _node_count = len(nodes)` (`evolve_result.py:127-135`). An extra node makes the orchestrator (and `sample`, which derives `step_name` from `done_rounds + 1`, `:275-276`) believe a round it never ran has completed — the budget is silently shortened and the next `step_name` skips a number.
- **Corrupts the search.** Two nodes for the same candidate with two ids pollute sampling, lineage (`parent` ids), and the best-snapshot bookkeeping (`cli.py:476-483`).

**The natural idempotency key already exists.** Every node carries `meta_info.step_name` (`cli.py:470`), serialized into `nodes.json` via `Node.to_dict` (`structures.py:30-43`, `meta_info` at `:40`). The bridge's `attach_analysis` already resolves `step_name` *before* recording (`:401`). So the guard is: before appending, scan `nodes.json` for a node whose `meta_info.step_name` equals this step; if present, that round is already recorded — return `recorded` with the existing id and append nothing. §6.2 specifies it.

## 3. The current evolve package — what this slice extends (verified citations)

The two touchpoints, with the load-bearing facts the implementer relies on.

### 3.1 The `orchestrator` hub and its `complete` condition

`orchestrator` (`workflow.yaml:271-324`) is an **LLM agent** that reads `run_spec.yaml` and `database_data/nodes.json`, counts the nodes map for `done_rounds`, inspects `current/` for the in-flight round's progress, and emits exactly one routing verdict (`design`/`evaluate`/`analyze`/`record`/`complete`/`escalate`). The prompt's `complete` rule is a single line: *"complete — if done_rounds >= max_rounds"* (`:300`). The verdict routes through the declarative transitions (`:310-324`): `complete → final_summary` (`:321-322`). The prompt already supports a human "run N more rounds" directive by treating the effective budget as `done_rounds + N` for that turn (`:292-297`) — Fix A/B must not break that path (§7).

The existing max_rounds stop is therefore **LLM-judged today**: the orchestrator does the `done_rounds >= max_rounds` comparison itself from the files it reads. This slice changes that — it folds `max_rounds` (alongside the new `target_met`/`patience`) into the bridge's single `stop_reason`, so the post-slice orchestrator routes on a pre-computed reason rather than doing the arithmetic (§5.4/§5.5). The current LLM-judged behavior is described here as the *baseline* this slice replaces, not the end state.

### 3.2 The `sample` step — already reads `nodes.json` + `run_spec` each round (unchanged by this slice)

`sample` (`workflow.yaml:326-351`) is a `deterministic`, `container: true` state running `evolve_result.py sample`. The bridge's `sample` (`evolve_result.py:242-353`) already: reads the node count (`_node_count`, `:127-135`, reads `database_data/nodes.json`), reads the objective from `run_spec.yaml` (`_objective_query`, `:149-151`, via `_load_structured`), computes the next `step_name` from `done_rounds` (`:275-276`), seeds cognition on the first round, samples a parent, retrieves cognition, and writes `current/context.json` plus the `current/sample.json` result file. **This slice does not change `sample`.** It is described here only because the stop-signal computation reuses the same bridge primitives — `_load_structured` and `_node_count` — that `sample` already exercises. The signals are NOT computed here: `sample` runs at the *start* of a round, before this round's node exists, so a signal it computed would be one round stale at the orchestrator's completion vantage (§5.1 explains the timing precisely). The computation lives in `attach_analysis`, after the record (§3.3, §5.1).

`_load_structured` (`:28-40`) parses `run_spec.yaml` as JSON-or-YAML into a dict — so any bridge subcommand (including `attach_analysis`) can read `evaluation.success_criteria` and `budget.{patience,max_rounds}` from the same spec `sample` loads for the objective.

### 3.3 `analysis_record` / `attach_analysis` — the durable write (and the home for BOTH new bridge behaviors)

Cited in detail in §2.3. The key seams for Fix C: `attach_analysis` resolves `step_name` at `:401` *before* the `evolve-db record` shell-out (`:407-427`); `_node_count`/`nodes.json` reading is already a bridge primitive (`:127-135`); each serialized node exposes `meta_info.step_name` and `id` (`structures.py:30-43`). The guard reuses all three.

`attach_analysis` is **also the home for the stop-signal computation** (Fix A/B), for one load-bearing reason: it is the bridge step that runs *after* the round's node is durably appended, and it already has that node's id back from the record (`engine.get("node_id")`, `:430`). So once the record (or the idempotent find-or-create) completes, `attach_analysis` holds the *current* `nodes.json` — including the round just recorded — and can compute a stop signal that the orchestrator, re-entering after `analysis_record`, reads at exactly the moment it decides `complete` vs `design` (§5.1). This is the corrected location; `sample` (§3.2) would compute a one-round-stale signal.

### 3.4 The run-spec schema fields this slice reads

`run_state.py`: `DEFAULT_RUN_SPEC` (`:21-56`) defines `evaluation.success_criteria` (`:29`, default `[]`), `budget.patience` (`:33`, default `0`), `budget.max_rounds`. `REQUIRED_FIELD_CHECKS` (`:58-98`) requires `success_criteria` non-empty (`:71-73`) and `patience >= 0` (`:76`). **No schema change** — both fields exist and are authored by `preflight` today; this slice only consumes them.

### 3.5 Resume mechanics (for the Fix C workflow-level test)

`WorkflowOrchestrator.resume(workflowId, …)` (`orchestrator.ts:1325-1371`) loads the checkpoint via `FileCheckpointStore.load`, restores `machineState`/`context`, re-resolves the workspace path (`:1349`), and re-mints infrastructure (a fresh container — harness slice §6.2). A deterministic state re-entered on resume re-runs its `run:` command. The Fix C guard makes that re-run a no-op for the durable record. The existing `test/workflow/orchestrator-resume.test.ts` harness (FileCheckpointStore + WorkflowOrchestrator + MockSession + `waitForGate`/`waitForCompletion`) is the basis for the §11.1 workflow-level test.

---

## 4. The central decision — LLM-judged vs deterministic stop signals

**This is the slice's central design decision.** The existing `max_rounds` stop is LLM-judged (§3.1): the orchestrator prompt says "complete if done_rounds >= max_rounds" and the agent does the arithmetic. The integration tests cannot deterministically assert that arithmetic — they mock the orchestrator with scripted verdicts (the evolve gates route the orchestrator by prompt-substring and feed canned `agent_status` verdicts), so the LLM's real counting is never exercised in CI. Adding `target_met` and `patience` raises the question: where does the comparison happen?

### Options

- **(a) Extend the orchestrator PROMPT only.** Add to the prompt: "also complete if the best eval_score satisfies success_criteria, or if the best has not improved for patience rounds." Consistent with the existing `max_rounds` line and adds zero new bridge code.
  - **Cost:** the real logic (parse the target, find the best score, count rounds-since-improvement) is the LLM doing arithmetic over `nodes.json` and a free-form string. It is validated only by live runs or by mock-scripted verdicts — a deterministic test cannot assert "the run stopped because the score crossed 2.635", only "the mock said complete." The most error-prone part (string parsing + plateau counting) lives where it cannot be unit-tested, and LLM arithmetic over many nodes is exactly the kind of thing that drifts.

- **(b) Compute the stop signals DETERMINISTICALLY in the bridge.** A bridge step (which already reads `nodes.json` + `run_spec`, §3.2) computes `best_score`, `rounds_since_improvement`, `target_met`, `patience_exceeded`, and a single `stop_reason`, and either (b1) surfaces them into `current/` context for the orchestrator to route on, or (b2) routes a hard verdict directly. **Which bridge step is itself a correctness question** (§5.1): it must be `attach_analysis` (post-record), not `sample` (pre-record), or the signal is one round stale at the completion vantage.
  - **(b2) — a hard deterministic verdict** would mean the bridge itself emits a "stop" verdict and a new transition bypassing the orchestrator. This **breaks the hub model** (the orchestrator is the single router) and the human "run N more rounds" override (which lives in the orchestrator prompt, §3.1) — a plateau or target-met would stop even when the human asked for more. Rejected.
  - **(b1) — surface signals, orchestrator routes** keeps the hub intact: the bridge computes the numbers (deterministic, unit-testable), and the orchestrator routes `complete` on a pre-computed verdict rather than re-deriving it.

### Recommendation — the hybrid (b1), computed post-record in `attach_analysis`

**Compute the stop signals deterministically in `attach_analysis` (after the durable record) and surface them into `current/stop_signals.json`; the orchestrator prompt routes `complete` on the pre-computed `stop_reason`.** This is the lean stated in the brief, with the corrected computation site (§5.1):

- **It grounds the LLM.** The orchestrator no longer parses `eval_score >= 2.635` or counts plateau rounds; it reads `current/stop_signals.json` (a small object with `target_met`, `patience_exceeded`, `stop_reason`) and routes `complete` when `stop_reason` is non-null. The fragile arithmetic is in Python, run identically every round.
- **It keeps the hub model.** The orchestrator stays the single router; no new transition, no bypass. The human "run N more rounds" override still works because the orchestrator is still the one deciding `complete` vs `design` — it can be told to *ignore* a `patience`/`target_met` signal for the turns the human extended (§7).
- **It is deterministically testable.** A unit test feeds `attach_analysis` a `nodes.json` (with the round's node already present) + `run_spec` and asserts the emitted `stop_signals.json` — the actual stop logic is proven without the LLM. The integration test then asserts the run completes early with the recorded `stop_reason`. The mock orchestrator must genuinely READ `current/stop_signals.json` and route `complete` on its `stop_reason` (§11.2) — a turn-indexed scripted `complete` proves nothing about the wiring.

**The honest limitation (stated up front, mirrored in §11) — and the test ladder it implies:** even with (b1), the *production* routing (signal → `complete` verdict by the real LLM) is exercised only by live runs, never in CI. The test ladder has three distinct rungs, each proving a different thing:

1. **The bridge computation** (parse the target, find the best score, count plateau rounds, set `stop_reason`) is pinned by **unit tests** over crafted `nodes.json` + `run_spec` — the part that actually parses strings and counts plateaus, run identically every round. This is the rung that matters most and is fully deterministic.
2. **The wiring** (bridge → `current/stop_signals.json` → orchestrator routing) is proven by an integration test **whose mock orchestrator genuinely READS `stop_signals.json` and routes `complete` on its `stop_reason`** — not a turn-indexed scripted `complete`. A scripted verdict tests nothing about the file the bridge wrote (§11.2 is explicit: the existing multi-round mock routes on a fixed `orchestratorScript` array and reads no file).
3. **The real LLM prompt routing** is validated only by live runs (§11.4 live note). This is acceptable because the routing reduces to "is `stop_reason` non-null?", a single check the prompt makes explicit — but the doc does NOT claim CI proves it.

What (b1) buys over (a) is that rungs 1 and 2 — the computation and the wiring — become deterministically testable; only rung 3 stays LLM-dependent.

## 5. Stop signals computed in the bridge (Gap A + Gap B)

### 5.1 Where the computation lives — `attach_analysis`, AFTER the record (the corrected site)

The computation lives in `evolve_result.py attach_analysis` (§3.3), **after** the durable `evolve-db record` (or after the idempotent find-or-create, §6.2) has appended this round's node. At that point `attach_analysis` has the just-recorded node's id back from the helper (`engine.get("node_id")`, `:430`) and the *current* `database_data/nodes.json` on disk — including the round just recorded. It reads `run_spec.yaml` (via `_load_structured`, the same primitive `sample` uses) and the current `nodes.json`, computes `best_score`, `rounds_since_improvement`, `target_met`, `patience_exceeded`, and a single `stop_reason`, and writes `current/stop_signals.json`.

**Why post-record, NOT in `sample` (the central correctness point).** The orchestrator's completion decision happens when it **re-enters after `analysis_record`** — that is the moment it chooses `complete` vs `design` for the next round. The signal it reads at that moment MUST reflect the node just recorded. If the signals were computed in `sample` (which runs at the *start* of a round, before that round's node is appended), the signal the orchestrator reads after `analysis_record` would reflect `nodes.json` *before* the round's node existed: a target or patience condition first satisfied by round N's node would not be visible until `sample` runs again at the start of round N+1 — burning an entire extra round, which re-introduces the exact waste this slice exists to remove. Computing the signal in `attach_analysis` after the record closes that gap: the orchestrator re-enters, reads a `stop_signals.json` that INCLUDES the just-recorded node, and can route `complete` on round N's node in round N.

**Why `attach_analysis`, not a new state:** `attach_analysis` is the bridge step that runs at the end of every round, immediately after the durable write, and it already has `run_spec` and `nodes.json` reachable via existing bridge primitives (`_load_structured`, `_node_count`). It is `container: true` (runs in the bridge) and `deterministic` (unit-testable). A new "compute stops" state would add FSM surface for nothing. The orchestrator reads the surfaced file the same way it already reads `current/context.json`, `current/result.json`, etc. (`workflow.yaml:286-291`).

`stop_signals.json` shape (written by `attach_analysis` after the record, read by the orchestrator on re-entry and by `final_summary`):

```json
{
  "best_score": 2.6173,
  "best_node_id": 4,
  "evolution_rounds": 4,
  "rounds_since_improvement": 0,
  "target": { "metric": "eval_score", "comparator": ">=", "threshold": 2.635, "raw": "eval_score >= 2.635" },
  "target_met": false,
  "patience": 2,
  "patience_exceeded": false,
  "done_rounds": 4,
  "max_rounds": 6,
  "stop_reason": null
}
```

`stop_reason` is `null` when no stop fires, else one of `"target_met"` / `"patience"` / `"max_rounds"` (precedence in §5.4 — the bridge folds max_rounds in too). `target` is `null` when no parseable criterion was found (§5.2 fallback).

### 5.2 Parsing the target from `success_criteria`

`success_criteria` is a free-form list of strings (`run_state.py:29`). Three ways to extract the numeric target:

- **(i) A small robust parser in the bridge** for the canonical shape `<metric> <comparator> <number>` — e.g. a regex `^\s*(\w+)\s*(>=|>|==|<=|<)\s*([-+]?\d+(?:\.\d+)?)\s*$` applied to each criterion string, taking the first that parses and whose `metric` matches `evaluation.core_score` (which is `eval_score`, `workflow.yaml:206`). **The engine is maximize-only** (`best_snapshot.py:26,35`, `cli.py:499` all take `max(...)` over node scores), so the parser ACCEPTS `>=`/`>`/`==` and **REJECTS `<=`/`<`** — a minimize target cannot be honored by a maximize engine, and the patience logic (§5.3) hard-codes higher-is-better, so silently accepting a `<=` target would mis-handle it. On a `<=`/`<` criterion: `target = null`, target stop disabled, and a `target_parse_warning` is recorded. On no match (or no `eval_score` criterion at all): `target = null`, `target_met` stays `false` forever (the run falls back to `max_rounds`/`patience`), and `attach_analysis` records a `target_parse_warning` in the result payload so a human can see the criterion was unparseable.
- **(ii) A structured field authored by preflight alongside the free-form string** — e.g. have `preflight` also pass `--success-metric eval_score --success-comparator ">=" --success-threshold 2.635`, stored as `evaluation.success_target`. This is unambiguous but requires `evolve-brief normalize` / the schema to grow a field — **touches `evolve_core/`, which is forbidden**. (A bridge-side sidecar file authored by `preflight` could avoid the engine change, but adds a second source of truth and more prompt surface.)
- **(iii) LLM judgment** — let the orchestrator decide whether the target is met. This is option (a) from §4 and is rejected for the same reason: the parse is exactly the fragile, untestable part.

**Recommendation: (i), the bridge parser, PAIRED with a `preflight` prompt tightening (this slice edits `preflight` — see below).** The parser is the most testable (pure function over a string list → `{metric, comparator, threshold} | null`, directly unit-tested), requires no engine change, and degrades safely (unparseable → no target stop, run still bounded by `max_rounds`). The parser is deliberately strict: it parses the canonical maximize shape and ignores anything else rather than guessing. Because a strict parser silently disables the target stop on any non-canonical criterion, the slice does NOT rely on `preflight`'s current output happening to be parseable — it **edits the `preflight` prompt** to guarantee it (resolving OQ3 in the affirmative: the slice IS a `preflight` change).

**The `preflight` prompt edits (in scope — `workflow.yaml:158-165`):** the current prompt only illustrates `eval_score >= 2.635` with "e.g.", admits prose targets, and at `:164` tells the LLM the criterion is *"a recorded quality descriptor, not a hard gate (the run stops on max_rounds)"* — which is now FALSE (the target gates an early stop) and actively discourages careful authoring. So:

- **(a)** Require the FIRST `success_criteria` entry to be the canonical `<core_score> <comparator> <number>` form (e.g. `eval_score >= 2.635`), so the strict bridge regex always parses it. (`preflight` already resolves a concrete number, harness §7.1; this pins the comparator form.)
- **(b)** Delete/replace the `:164` "not a hard gate / stops on max_rounds" sentence to reflect that the target now gates an early stop — so the LLM authors an *accurate* target rather than a conservative placeholder, because the number is now load-bearing.

A criterion the parser still cannot read (e.g. a human edited the spec, or `preflight` deviated) disables the target stop silently, so the `target_parse_warning` must be surfaced (it rides `attach_analysis`'s result payload and can be shown at `final_review`). With the `preflight` tightening, this is a defensive fallback, not the primary path.

### 5.3 Patience definition + the exact computation over `nodes.json`

**Definition.** `patience = K` means: complete when the **best** recorded `eval_score` has not **improved** for `K` consecutive **evolution rounds**. Two things to pin down — improvement and the exact computation. Round-counting is settled below by the baseline-from-node-0 rule.

**Round counting — node 0 is the baseline, improvement is measured from it (the seed question resolved).** Patience counts improvements across the ordered node sequence by id, ascending, **treating node 0 as the baseline regardless of seed provenance**: node 0 sets `best`, and `rounds_since_improvement` increments from node 1 onward. This is the ONLY rule the slice uses — the earlier "count nodes with a non-empty parent" alternative is **rejected and removed**, because it is wrong for from-scratch runs: on a from-scratch run node 0 is a genuine first evolution round (harness §7.4.1) yet still has `parent: []` (it is node 0 either way), so "non-empty parent" would undercount by one. The baseline-from-node-0 rule needs no seed detection: the first recorded score is the baseline and improvement is measured from it, which is well-defined whether or not node 0 was a verbatim seed. This composes correctly with the seed-aware `+1 max-rounds` seam (harness §7.4.1) — `max_rounds` accounts for the seed slot separately; patience only cares about "rounds since the best last improved," for which node 0 as baseline is exactly right in both cases.

**Improvement — strictly greater, with an epsilon for evaluator noise. Pinned default: `EPS = 1e-9` (absolute).** Define improvement as `new_best > prev_best + EPS`. A bare `>` is brittle against floating-point evaluator jitter (a packing re-scored at `2.61730000001` vs `2.6173` is not a real improvement). The slice pins a small absolute epsilon, `EPS = 1e-9`, as a bridge constant so the implementer is not blocked on a maintainer pick (OQ2 is a low-stakes confirm, not a blocker). It is documented in the result payload so a run can be audited. Context: circle-packing's evaluator uses a `1e-6` validity tolerance (harness §2.3); `1e-9` sits well below that scale, so it filters bit-level jitter without masking any real improvement an evaluator with `1e-6` tolerance could report. (A relative epsilon `1e-6 * max(1, |prev_best|)` remains a reasonable alternative if a future objective has very large scores — but absolute `1e-9` is the pinned default for this slice.)

**Exact computation** (over the ordered node sequence, ascending by id):

```
nodes      = sorted(nodes_by_id, key=id)            # node 0 first
best       = -inf
since      = 0                                       # rounds since last improvement
for n in nodes:
    if n.score > best + EPS:
        best = n.score
        since = 0                                     # improved: reset
    else:
        since += 1                                    # no improvement this round
best_score              = best
rounds_since_improvement = since
patience_exceeded        = (patience > 0) and (since >= patience)
```

Notes:
- `patience = 0` (the schema default) disables the patience stop — a 0-patience run is bounded only by `max_rounds`/`target`. `preflight` authors `--patience 2` (`workflow.yaml:210`), so the default in practice is 2.
- The baseline node (node 0) sets `best` and resets `since` to 0 (its score is an "improvement" over `-inf`), so the first evolution round that fails to beat the baseline counts as `since = 1`. This matches the intuition "K rounds in a row with no new best."
- `score` per node is read from `nodes.json` (`structures.py` `to_dict` exposes `score`, `:42`); a missing/non-numeric score (should not happen — `evaluate` gates on a numeric score, `evolve_result.py:225-238`) is treated as `-inf` (cannot improve), recorded as a warning in `attach_analysis`'s result payload.

### 5.4 Precedence + the single recorded stop-reason — folded entirely into the bridge

Multiple stops can be true at once (e.g. the score crosses the target on the same round the budget is reached). The orchestrator routes `complete` if a stop fires, but exactly ONE reason must be reported. **The bridge computes the full stop decision — including `max_rounds` — and writes a single `stop_reason`.** This makes the bridge the single source of truth for the stop reason and removes any orchestrator→`final_summary` reason-passing (resolves OQ5 cleanly).

**Precedence: `target_met` > `patience` > `max_rounds`.**

Rationale: `target_met` is the most informative outcome ("we found what we were looking for") and should be reported even if the budget was also hit; `patience` ("the search plateaued") is more informative than `max_rounds` ("we ran out of budget"). After the record, `attach_analysis` computes (over the now-current `nodes.json` + `run_spec`):

```
done_rounds = node count                    # includes the just-recorded node
if target_met:           stop_reason = "target_met"
elif patience_exceeded:  stop_reason = "patience"
elif done_rounds >= max_rounds: stop_reason = "max_rounds"
else:                    stop_reason = null
```

and writes `target_met`, `patience_exceeded`, `done_rounds`, `max_rounds`, and the resolved `stop_reason` into `current/stop_signals.json`.

So:

- the **bridge** sets `stop_reason ∈ {target_met, patience, max_rounds, null}` by the fixed precedence — including `max_rounds`, which the bridge can compute because after the record it has the current node count;
- the **orchestrator** routes `complete` when `stop_reason != null` (it no longer does its own `done_rounds >= max_rounds` arithmetic — see §5.5), and may still override with `design` when a human "run N more rounds" directive is present (§5.5, §7);
- **`final_summary` simply READS `current/stop_signals.json`'s `stop_reason`** for the report. No reason is passed *through* the orchestrator. The file survives to `final_summary` because `current/` is only cleared at the top of `sample` (start of a round) — never between the record and `final_summary` — and post-MF1 the file is freshly written by the round's `attach_analysis` (§5.5 determinism note, OQ5).

### 5.5 The orchestrator prompt delta — routing on the bridge's single `stop_reason`

The orchestrator prompt (`workflow.yaml:275-307`) gains one short instruction and one new file to read. The change is minimal and preserves every existing behavior.

**Add to the "read these files first" block:**

> Also read `/workspace/.evolve_runs/main/current/stop_signals.json` if it exists (the bridge writes it after each round's record). It contains the pre-computed `stop_reason` (one of `target_met` / `patience` / `max_rounds` / `null`) plus the booleans behind it — you do NOT compute these yourself; trust the bridge's `stop_reason`.

**Change the `complete` rule** (`:300`) from:

> `complete — if done_rounds >= max_rounds.`

to:

> `complete — if stop_signals.json's stop_reason is non-null (it is one of target_met / patience / max_rounds, already including the round budget — the bridge resolved the precedence for you).` Do not do your own `done_rounds >= max_rounds` arithmetic; route on `stop_reason`.

**Preserve the human "run N more rounds" override** (`:292-297`). Add a guard so an extension overrides the stop_reason for the extended turns:

> If a human directive requested additional rounds, that directive takes precedence: emit `design` to run the requested rounds even if `stop_reason` is non-null (including `max_rounds`). Only re-apply the stop once the extended target is reached.

This keeps `final_review`'s `FORCE_REVISION` "run more rounds" path working (§7): a human who wants more rounds after an early `target_met`/`patience`/`max_rounds` stop gets them, because the override is the orchestrator's own routing decision and beats the bridge's standing `stop_reason`. The override logic lives **purely in the orchestrator prompt reading the human directive** — it is independent of where the signals are computed (the bridge produces the data; the orchestrator decides whether to honor it this turn).

**Why the bridge now owns `max_rounds` too (changed from an earlier draft):** an earlier version of this design kept `max_rounds` as the orchestrator's own arithmetic so the human-override could reason about an effective budget. That is unnecessary: the human override is a *routing* decision (the orchestrator emits `design` despite a standing `stop_reason`), and it works identically whether the standing reason is `max_rounds`, `patience`, or `target_met` — the orchestrator just ignores the reason for the extended turns. Folding `max_rounds` into the bridge's single `stop_reason` (§5.4) keeps ONE source of truth, removes duplicated arithmetic, and gives `final_summary` a reason to read directly. The bridge owns the full stop decision; the orchestrator owns routing (including the human override).

**Determinism note:** `stop_signals.json` is recomputed by `attach_analysis` after every round's record, from the durable `nodes.json`, so it is a pure function of recorded state — no hidden round-to-round memory. On resume it is recomputed identically (the resumed `attach_analysis` re-writes it; the idempotency guard, §6.2, ensures no extra node skews it). It is part of the `current/` round scratch (overwritten at the top of the next `sample`, like `context.json`), not durable state — but it is never cleared between the record and `final_summary`, so the stop reason is always readable at report time (§5.4, OQ5).

## 6. Resume idempotency for the durable record (Gap C)

### 6.1 The crash window, precisely

The non-atomicity is between two writes owned by two layers (§2.3):

1. **The node write (engine layer, atomic in itself).** Inside `analysis_record`, `attach_analysis` → `evolve-db record` → `cmd_db_record` appends the node and `db.save()` writes `database_data/nodes.json` via `os.replace` of a temp file (`_save_locked`, `database.py:162`; `:117-119` is the unrelated `reset()` unlink). This single file write is atomic — `nodes.json` is never half-written. The deterministic state's `resultFile` `current/analysis_record.json` is then written with `verdict: recorded`.
2. **The checkpoint advance (orchestrator layer).** *Separately*, after the deterministic state returns, the orchestrator records the transition `analysis_record → orchestrator` into the checkpoint store.

The window is between (1) completing and (2) being persisted. A crash there (process kill, host failure, OOM) leaves: `nodes.json` has the new node; the checkpoint still says `analysis_record`. On `workflow resume` (`orchestrator.ts:1325-1371`), the run re-enters `analysis_record`, and `attach_analysis` runs again with the **same** `--step-from-current` step (the `current/step_name` file is also durable in the workspace, so the same step is re-resolved) → a **second append** of the same round's node.

This is precisely the lifecycle-bug pattern the brief flags: the fix needs an integration-level proof (a real re-entry), not just a unit assertion that a guard function returns early.

### 6.2 The idempotency guard in the bridge (`attach_analysis`)

The guard makes `attach_analysis` a **find-or-create** on `step_name` instead of an unconditional append. It lives entirely in `evolve_result.py attach_analysis` (`:399-448`), before the `evolve-db record` shell-out (`:427`). The stop-signal computation (Fix A/B, §5.1/§5.4) runs **after** the find-or-create resolves, on BOTH paths — so a replayed record re-writes a fresh `stop_signals.json` just as a genuine first record does:

```
attach_analysis(args):
    step_name = _resolve_step_name(args)                  # already at :401
    existing  = _find_recorded_node_for_step(run_dir, step_name)   # NEW (Fix C)
    if existing is not None:
        # This round's node is already in the durable DB — a prior attach_analysis
        # for this step committed before the crash. Do NOT append again.
        verdict, passed = "recorded", true
        payload = { step_name, node_id: existing["id"],
                    parent: existing.get("parent", []), idempotent_skip: true }
    else:
        # … unchanged: resolve code/results/name/parent, shell to `evolve-db record`,
        #    map node_id → recorded / needs_repair (the current :402-447 body) …
        verdict, passed, payload = <existing record path>

    # NEW (Fix A/B): now that this round's node is durably present (recorded OR
    # idempotently found), compute the stop signals over the CURRENT nodes.json
    # + run_spec and write current/stop_signals.json. This runs on both paths so
    # the signal always reflects the just-recorded node (§5.1 — the post-record
    # vantage is the whole point). On the needs_repair path no node was appended,
    # so stop_signals is computed over nodes.json as-is (no stop can newly fire).
    compute_and_write_stop_signals(run_dir)               # writes current/stop_signals.json
    write result_file { verdict, payload, passed }
    return 0
```

with the new helper, built from the existing `_node_count` primitive (`:127-135`):

```
_find_recorded_node_for_step(run_dir, step_name) -> dict | None:
    nodes_path = run_dir / "database_data" / "nodes.json"
    if not nodes_path.exists(): return None
    loaded = _load_json(nodes_path)
    nodes  = loaded.get("nodes") if isinstance(loaded, dict) else None
    if not isinstance(nodes, dict): return None
    for node in nodes.values():
        meta = node.get("meta_info") if isinstance(node, dict) else None
        if isinstance(meta, dict) and meta.get("step_name") == step_name:
            return node                                   # {id, parent, score, meta_info, …}
    return None
```

**Why `step_name` is the right key.** Every node carries `meta_info.step_name` (`cli.py:470`), serialized into `nodes.json` (`structures.py:40`). Within a run, `step_name` is unique per round (`sample` derives `step_{done_rounds+1:04d}`, `:275-276`) and stable across a resume (the `current/step_name` file is durable). So "a node with this `step_name` exists" is exactly "this round was already recorded." No new field, no engine change, no new file — the key already exists on every node.

**The returned `node_id` is the original.** The guard returns the existing node's `id` (and `parent`), so the result-file contract (`{verdict: recorded, payload: {node_id, …}}`) is satisfied identically to a fresh record — the orchestrator's `record → orchestrator` transition (`workflow.yaml:454-456`) fires the same way, and `done_rounds` is unchanged (no second node). The `idempotent_skip: true` marker in the payload is for audit/debugging only; the verdict is the same `recorded`.

**Determinism preserved.** The guard reads `nodes.json` and returns; it appends nothing, copies nothing, and touches no engine state. A first (real) `attach_analysis` appends exactly as today; a replayed `attach_analysis` short-circuits. The engine's `cmd_db_record` is reached **only** on the genuine first record, so its behavior is byte-identical to today on the path it runs.

**Edge cases handled:**
- **`nodes.json` absent / malformed** → `_find_recorded_node_for_step` returns `None` → falls through to the real record (the current behavior). Safe.
- **A node for the step exists but `needs_repair` was the prior verdict** → cannot happen: `needs_repair` is returned only when `evolve-db record` did NOT produce a `node_id` (`:439-445`), i.e. nothing was appended. If a node with the step exists, the append succeeded, so `recorded` is the correct verdict to replay.
- **Two different rounds sharing a `step_name`** → impossible within a run (unique per `done_rounds`); a resume re-uses the same step intentionally. The guard's whole point.

### 6.3 Why the guard is in the bridge, not the engine

The brief mandates it, and it is correct: the byte-verbatim `evolve_core/` invariant forbids editing `cmd_db_record` (`cli.py:417-489`). The bridge `attach_analysis` is IronCurtain's own translation layer (`evolve_result.py`), so the find-or-create logic belongs there. This also keeps the engine's `add_with_previous_nodes` semantics (always-append) untouched — other engine callers (`cmd_db_record` invoked outside the bridge) are unaffected; only IronCurtain's `analysis_record` path gains the guard. The guard is a *precondition check the bridge performs before delegating to the engine*, not a change to the engine's contract — exactly the right layering (the bridge is where IronCurtain-specific idempotency policy lives).

**Why not make the engine write atomic with the checkpoint instead?** That is the "real" fix for the general non-atomicity, but it is a cross-layer orchestrator change (two-phase commit between `nodes.json` and the checkpoint) that touches far more than this slice's scope and would not be confined to the two allowed files. The step-name guard is the surgical fix for the *only* state where a replay corrupts durable state (`analysis_record` is the single durable write, `workflow.yaml:434`). All other deterministic states (`sample`, `evaluate`) write only `current/` scratch, which is overwritten next round — replaying them is already harmless. So making `analysis_record` replay-safe makes the whole loop replay-safe. (The general atomic-checkpoint hardening is recorded as a deferred refinement, §12.)

## 7. Interactions to preserve (human gates + final_summary)

An early stop must slot cleanly into the merged human-surface flow `complete → final_summary → final_review → done` (`workflow.yaml:321-322, 483-542`). The key invariants:

- **The `complete → final_summary → final_review` path is unchanged.** An early stop just makes the orchestrator emit `complete` sooner (on `target_met`/`patience` instead of only `max_rounds`). The transition out of `complete` is the same edge (`:321-322`); `final_summary` runs; `final_review` gates. No new edge, no new state.
- **`final_summary` states WHY it stopped — by READING the bridge's `stop_reason`, not recomputing it.** `final_summary` (`:483-522`) already reads `nodes.json` and `best/` and reports `done_rounds vs budget.max_rounds` plus the best node and trajectory. Add one prompt instruction: read `current/stop_signals.json`'s `stop_reason` and **state it** in the report — "stopped because the success target (`eval_score >= 2.635`) was met at node 4" / "stopped because the best score did not improve for 2 rounds (patience)" / "stopped because the round budget (5) was reached." This is the §5.4 single `stop_reason`, surfaced by the round's `attach_analysis` and read straight from the file (no recomputation, no reason passed through the orchestrator — OQ5 resolved). The file survives: `current/` is only cleared at the top of the next `sample`, which does not run between the final record and `final_summary`. The report's existing "would more rounds help?" recommendation (`:513`) becomes more meaningful: after a `patience` stop, "more rounds are unlikely to help (plateaued)"; after a `target_met` stop, "the target is met; more rounds optional"; after `max_rounds`, "the search was still improving — more rounds may help."
- **The `final_review` FORCE_REVISION "run more rounds" path still works.** `final_review --FORCE_REVISION→ orchestrator` with `resetVisitCounts: [orchestrator]` (`:537-540`). A human who, after an early `target_met`/`patience`/`max_rounds` stop, wants more rounds, forces a revision; the orchestrator's human-override instruction (§5.5) makes it emit `design` and run more rounds *despite* the standing `stop_reason`, until the extended target is reached. This is the load-bearing interaction: **the stop must be overridable by the human extension**, which §5.5's prompt guard ensures. The override logic lives **purely in the orchestrator prompt reading the human directive** — it is unaffected by the MF1 move of the signal computation from `sample` to `attach_analysis` (the orchestrator reads the same `stop_signals.json` either way; only *when* the file is written changed, and the override is a routing choice over whatever `stop_reason` is standing). Without the guard, an early stop would immediately re-fire on the next orchestrator turn and the human's "more rounds" would be ignored.
- **`human_escalation` is untouched.** An `evaluator_blocked` round still routes to `human_escalation` (`:404-405`); the stop signals are about *completion*, not failure, and do not interact with the escalation path.
- **The `done_rounds`/`step_name` accounting is unchanged by Fix C.** Because the idempotency guard returns the *original* node id and appends nothing (§6.2), `done_rounds` (node count) is identical whether or not a replay occurred — so the orchestrator's budget arithmetic and `sample`'s `step_name` derivation see the same node count they would have without the crash. The crash becomes invisible to the search.

## 8. Security / determinism / vendored-engine invariants

- **Vendored engine stays byte-verbatim.** No `evolve_core/` change. Fix A/B compute signals in the bridge `attach_analysis` (after the record) and route in the `orchestrator` prompt; Fix C guards in the same `attach_analysis` (before the record). The engine's `cmd_db_record`/`add_with_previous_nodes` are reached unchanged on the genuine-first-record path.
- **No new run-spec schema field.** `success_criteria` and `patience` already exist and are authored by `preflight`. The bridge reads them; `evolve-brief normalize`/`run_state.py` are untouched. The `preflight` *prompt* edits (canonical-criterion + corrected gate sentence, §5.2) change only the LLM-authored *value* of `success_criteria`, not the schema. (The §5.2 "structured target" alternative was rejected partly *because* it would touch the engine schema.)
- **Determinism of scoring is unaffected.** The stop signals are a pure function of the durable `nodes.json` + `run_spec`; they do not change what gets scored or how. The Fix C guard appends nothing, so no node's score depends on whether a replay happened. Every candidate is still scored in the same provisioned environment (harness §8) — this slice adds no install, no network, no scoring path.
- **No new policy-engine / MCP surface.** No new server, tool, or rule. `analysis_record` is an existing deterministic state running the existing bridge inside the contained container; this slice changes its Python internals only (`sample` is untouched).
- **`current/stop_signals.json` is round scratch, not durable state.** It is recomputed after every round's record from `nodes.json` and overwritten (cleared at the top of the next `sample`, like `context.json`), so it carries no hidden state across resume — a resumed run's `attach_analysis` recomputes it identically. It is never an idempotency key (that is `nodes.json`'s `meta_info.step_name`); it is a derived display/routing artifact.

## 9. Lint / validation

This slice changes **no FSM topology** — no new state, no new transition, no new gate, no `initial:` change. The only `workflow.yaml` edits are inside existing state `prompt` strings (the `orchestrator`, `preflight`, and `final_summary` prompts). So the structural lint surface is unchanged from the merged tree.

- **`tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict`** must stay clean. Since no transitions/states/gates change, WF001 (every reachable non-terminal reaches a terminal), WF004 (gate `present:` artifacts have a producer), `validateHumanGate`, and `resetVisitCounts` validation all see the same graph they pass today. ✓
- **The existing manifest-shape unit test** (`evolve-result-bridge.test.ts:14-145`, "validates and lints cleanly" + "manifest wires the multi-round hub") must continue to pass. Its assertions on transitions, gate events, and the `evolve-brief normalize` flag set (`:118-144`) are unaffected — the flags `--success-criterion`, `--patience`, etc. are still authored verbatim (the `preflight` prompt edits change the LLM-authored criterion *value*, not the flag wiring). Add new assertions for the slice (the `orchestrator` prompt now mentions `stop_signals.json`/`stop_reason`; the `preflight` prompt now mentions the canonical criterion form and no longer says "not a hard gate"; `final_summary` mentions the stop reason) — these are prompt-substring checks in the same test, not structural lint.
- **Control check (lint-by-control discipline):** since no structure changed, the relevant control is at the *prompt* level — a unit test asserts the `orchestrator` prompt's `complete` rule now references `stop_reason` (temporarily strip the clause → the new assertion fails; restore → passes), and that the `preflight` prompt no longer contains the old "stops on max_rounds" gate sentence. This proves the prompt deltas are real, not silently dropped.

## 10. Prompts / skills deltas

Per CLAUDE.md "Authoring workflow skills" — control flow in the FSM, domain content in skills. This slice is split between **deterministic logic in the bridge** (Fix A/B signal computation, Fix C guard — Python, not prompt, both in `attach_analysis`) and **three small prompt deltas** (orchestrator routing, preflight authoring, final_summary reporting). No new skill is required; nothing here is reusable domain content.

### 10.1 `orchestrator` prompt (the substantive prompt delta — §5.5)

One new file to read (`current/stop_signals.json`), the `complete` rule changed to route on the bridge's single `stop_reason` (instead of doing its own `done_rounds >= max_rounds` arithmetic), and the human-override guard. This is routing/control flow — it belongs in the state prompt. The orchestrator does **not** compute the signals; it trusts the bridge's pre-computed `stop_reason` (§4 hybrid).

### 10.2 `preflight` prompt (the target-authoring delta — §5.2, resolves OQ3)

Two edits at `workflow.yaml:158-165`: (a) require the FIRST `success_criteria` entry to be the canonical `<core_score> <comparator> <number>` form (e.g. `eval_score >= 2.635`) so the strict bridge parser always reads it; (b) delete/replace the `:164` "a recorded quality descriptor, not a hard gate (the run stops on max_rounds)" sentence — now false and discouraging of careful target authoring — to reflect that the target gates an early stop. This is authoring guidance for a value the bridge consumes; it belongs in the `preflight` prompt.

### 10.3 `final_summary` prompt (one instruction — §7)

Read `current/stop_signals.json`'s `stop_reason` and state it (target_met / patience / max_rounds) in the report, and tailor the "more rounds?" recommendation to the reason. One paragraph added to an existing prompt. `final_summary` only READS the bridge's `stop_reason`; it does not recompute it.

### 10.4 No other prompt or skill changes

`provision`, `researcher`, `analyzer`, `sample` (deterministic, no prompt), `evaluate`, `analysis_record` (deterministic, no prompt), and all four human gates are untouched at the *prompt* level. `attach_analysis` changes in **Python** (the bridge) — both the idempotency guard and the stop-signal computation. No SKILL.md changes — the stop-signal computation and the idempotency guard are bridge mechanics, not domain heuristics.

## 11. Binary completion gate (REQUIRED — front and center)

The slice is done when all of the below hold. This mirrors the sibling slices' §11/§12: a deterministic bridge-level test for the lifecycle-critical fix, gated Docker integration tests for the behavioral stops, a clean `--strict` lint, and the existing evolve gates still green. The honest mock-orchestrator limitation is called out where it applies.

### 11.1 Resume idempotency (the critical one — lifecycle bug ⇒ integration proof, not just a unit test)

Per the brief and project memory (lifecycle bugs need integration-level proof, not an isolated unit assertion), Fix C gets **two** layers: a deterministic bridge-level guard test AND a workflow-level resume test.

#### (a) Bridge-level test — `attach_analysis` is find-or-create on `step_name`

A new test in `test/workflow/evolve-result-bridge.test.ts` (the existing bridge unit-test home, which already drives `evolve_result.py` with stub `evolve-db`/`evolve-eval` scripts via the `writeHarness`/`runBridge` helpers, `:158-212`). The test must prove the guard reads the REAL `nodes.json`, so the stub `evolve-db record` must actually write a node carrying `meta_info.step_name` into `database_data/nodes.json` (the existing stubs just print a `node_id`; this test's stub additionally appends to `nodes.json` so the second call has something to find).

Scenario:
1. Set up a run dir with `current/step_name = step_0001`, `current/context.json` (parent `{id: 0}`), `current/analysis.md`, and an empty/absent `nodes.json`.
2. **First call** `attach_analysis --step-from-current …` → the stub `evolve-db record` appends node `{id: 1, parent: [0], meta_info: {step_name: "step_0001"}, …}` to `nodes.json` and returns `node_id: 1`. Assert verdict `recorded`, `payload.node_id == 1`, and `nodes.json` holds exactly ONE node for `step_0001`.
3. **Second call** `attach_analysis --step-from-current …` (same step — simulating the crash-window re-entry). Assert: (i) verdict `recorded`; (ii) `payload.node_id == 1` (the SAME id, not a new one); (iii) `payload.idempotent_skip == true`; (iv) `nodes.json` STILL holds exactly ONE node for `step_0001` (the stub `evolve-db record` was NOT invoked the second time — assert via the stub recording its invocation count, e.g. appending to a `calls.txt` like the existing sample test does, `:466`).

This is the deterministic proof of the guard: same step in twice → one node, same id, no second append. It does not need Docker.

#### (b) Workflow-level resume test — re-entering `analysis_record` adds no duplicate node

A test built on the `orchestrator-resume.test.ts` harness (FileCheckpointStore + WorkflowOrchestrator + MockSession + `waitForGate`/`waitForCompletion`, `:1-21`). The goal: drive a real run to just-after a record, simulate the crash window (re-enter `analysis_record`), resume, and assert no duplicate node.

How to interrupt at the right point with the existing harness:
- Drive the run (mock orchestrator routing `design → evaluate → analyze → record`) through one full round so `analysis_record` runs once and `nodes.json` has one node for `step_0001`.
- **Simulate the crash window** by forcing the checkpoint to still point at `analysis_record` after the node was written. **This is buildable with existing tooling (OQ4 resolved):** construct a checkpoint at `machineState: analysis_record` — either via `FileCheckpointStore.save` in the programmatic harness, or via `synthesizeCheckpoint` / the `--state` synthesize flag (`workflow-command.ts:100`, "Synthesize checkpoint at this state (resume only)") — against a pre-populated workspace whose `current/` and `nodes.json` already hold the round's one node. On resume, `replayInvokeForRestoredState` re-runs the deterministic `analysis_record` command, faithfully reproducing the double-append window (node already present, checkpoint still at the record state) without a real kill.
  - **Honest caveat (kept):** this reproduces the *re-entry mechanics* of the crash window, not a real process kill at a real millisecond boundary (inherently not CI-reproducible). If `--state` synthesis cannot place the run *into* `analysis_record` with the node already present, the fallback is to drive the round, snapshot the checkpoint + `nodes.json` at that point, and re-run `analysis_record` against the snapshot. Either path proves the same property: re-entry → guard skips → one node.
- On resume, `analysis_record` re-runs `attach_analysis` for `step_0001`; the guard finds the existing node and skips the append.
- **Assert:** after resume reaches the next gate/terminal, `nodes.json` holds exactly ONE node for `step_0001` (NOT two); `done_rounds` is unchanged; the run proceeds normally (the orchestrator sees the same node count it would have without the crash).

> **Honest note on (b):** the workflow-level test uses the MockSession orchestrator (it cannot run a real LLM in CI), so it proves the *re-entry mechanics* (resume → `analysis_record` re-runs → guard skips) and the *durable-state outcome* (one node), which is exactly the lifecycle property at risk. It does not exercise a real process kill at a real millisecond boundary — that is inherently not CI-reproducible. The bridge-level test (a) deterministically proves the guard itself; the workflow-level test (b) proves the guard fires on the real resume path. Together they cover the bug.

### 11.2 Target-met early stop

A `describe.skipIf(!dockerReady)` integration test (same `dockerReady` guard and harness as the existing evolve gates, e.g. `evolve-multi-round.integration.test.ts` / `evolve-experiment-harness.integration.test.ts`). Use a synthetic experiment dir whose evaluator's score **crosses the target before `max_rounds`**.

- Construct the synthetic evaluator + mock researcher so candidate scores climb and cross the authored target (e.g. target `eval_score >= 3`, scores `1 → 2 → 3.5` by round 3) while `max_rounds` is, say, 6. The mock `preflight` authors `--success-criterion "eval_score >= 3" --max-rounds 6`.
- The `attach_analysis` step (real bridge, not mocked) computes `target_met = true` and `stop_reason = "target_met"` once a node's score ≥ 3 is recorded.
- **The mock orchestrator MUST genuinely READ `current/stop_signals.json` and route `complete` on its `stop_reason`/`target_met`** — NOT a turn-indexed scripted `complete`. This is the load-bearing test-design correction (MF2): the existing multi-round mock routes on a fixed `orchestratorScript` array (`evolve-multi-round.integration.test.ts:330-374` — a hard-coded `['design','evaluate','analyze','record', … ,'complete']` indexed by `orchestratorTurns`), reading NO file, so a scripted `complete` would prove **nothing** about the bridge→orchestrator wiring. The NEW test's mock orchestrator must, on each orchestrator turn, read `current/stop_signals.json` from the workspace and emit `complete` iff `stop_reason` is non-null (else `design`/`evaluate`/`analyze`/`record` per the round phase). Only then does a green test actually prove "the bridge wrote the signal AND the router consumed it."
- **Assertions:** the run reaches `done` with **fewer nodes than `max_rounds`** (it stopped early — e.g. 3 or 4 nodes, not 6); `current/stop_signals.json` (or the `final_report`) records `stop_reason == "target_met"`; the best score ≥ the target.

> **Test ladder (be honest about what each rung proves — §4):** this integration test proves rung 2 (the WIRING — bridge → `stop_signals.json` → a signal-reading mock that routes `complete`) and the early-stop outcome (fewer nodes, `done`, recorded reason). It does NOT prove rung 3 (the REAL LLM orchestrator routes `complete` on the boolean) — that is validated only by live runs (§11.4). Rung 1 (the bridge COMPUTATION) is pinned by a separate **bridge unit test** in `evolve-result-bridge.test.ts`: feed `attach_analysis` a `nodes.json` whose best score crosses a `run_spec` target and assert the emitted `stop_signals.json` has `target_met == true` and `stop_reason == "target_met"`. That unit test is the real regression guard for the parsing + comparison logic (§5.2/§5.3); the integration test guards the wiring + end-to-end early-stop.

### 11.3 Patience

A `describe.skipIf(!dockerReady)` integration test where scores **plateau for `patience` rounds before `max_rounds`**.

- Construct the synthetic evaluator + mock researcher so the best score improves then plateaus: e.g. `patience = 2`, `max_rounds = 6`, scores `1 → 2 → 2 → 2` (best stuck at 2 for 2 rounds after the round-2 improvement). The mock `preflight` authors `--patience 2 --max-rounds 6` (and a target high enough not to fire, so this isolates patience).
- The real `attach_analysis` bridge computes `rounds_since_improvement` and sets `patience_exceeded = true` / `stop_reason = "patience"` once it reaches 2 (after the round that records the second plateau node).
- **The mock orchestrator MUST READ `current/stop_signals.json` and route `complete` on its `stop_reason`** (same MF2 correction as §11.2) — a turn-indexed scripted `complete` proves nothing about the wiring.
- **Assertions:** the run reaches `done` with **fewer nodes than `max_rounds`** (e.g. 4 nodes, not 6); the recorded `stop_reason == "patience"`; `rounds_since_improvement >= patience` at the stop.

> **Test ladder (same three rungs as §11.2):** the integration test proves the wiring (signal-reading mock routes `complete`) and the early-stop outcome, not the real LLM's routing (rung 3, live-only). The plateau arithmetic (§5.3, including the baseline-from-node-0 rule and the `1e-9` epsilon edge cases) is the fragile part and gets its own **bridge unit tests** in `evolve-result-bridge.test.ts`: feed `attach_analysis` crafted `nodes.json` sequences (improving, plateaued, baseline-from-node-0, epsilon-noise jitter) and assert `rounds_since_improvement` / `patience_exceeded` / `stop_reason`. Those unit tests are where the §5.3 definition is actually pinned down and regression-guarded; the integration test guards the wiring + end-to-end behavior.

### 11.4 Lint clean + existing gates still pass

```
tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict
# expect: "No lint diagnostics" (no FSM topology changed — §9)
```

- The existing manifest-shape + bridge unit tests (`evolve-result-bridge.test.ts`) pass, with new assertions added for: the `orchestrator` prompt referencing `stop_signals.json`/`stop_reason`; the `preflight` prompt referencing the canonical criterion form and no longer saying "not a hard gate"; the `final_summary` prompt referencing the stop reason; the `attach_analysis` idempotent-skip behavior; the `attach_analysis` stop-signal output.
- **Scope the signal-reading mock orchestrator to the NEW §11.2/§11.3 tests only — do NOT retrofit it onto the existing multi-round positive fixture.** The existing multi-round mock orchestrator routes on a fixed turn-indexed `orchestratorScript` (`evolve-multi-round.integration.test.ts:330-374`), which deliberately drives exactly three rounds then `complete`. That fixture **must keep its scripted routing**: it authors `success_criteria: ['eval_score >= 1.0']` (`:129`) with a `writeCandidate` score trajectory of `[2, 5, 6]` (asserted at `:482`) — so a signal-reading orchestrator would see `target_met == true` at the **first** node (2 ≥ 1.0) and stop after one round, breaking the three-round assertion. Keeping the scripted mock on the existing fixture is correct (it is testing the *positive multi-round* path, not the stop signals); the signal-reading mock belongs only to the new target/patience tests, which author a target the trajectory crosses *late* and a `max_rounds` it never reaches.
- **The implementer MUST confirm the existing multi-round fixture's `writeCandidate` trajectory does not incidentally trip the new stops on the path that fixture exercises.** The bridge now WRITES `stop_signals.json` every round even in the existing fixture (the bridge change is unconditional) — but because that fixture's orchestrator is scripted (ignores the file), the written signal is inert there. Verify: (i) the scripted fixture still completes in exactly three rounds (the bridge writing `stop_signals.json` is a no-op for a scripted router); (ii) no assertion in the existing test inspects `stop_signals.json` in a way the new `target_met == true` (at node 0) value would break. If any existing gate has a *signal-reading* path, adjust the *test fixture's* target/patience so the stops do not fire before the cap — do NOT weaken the production default.
- **Optional live circle-packing note:** on the live daemon-backed run (harness §11.3), with a real target (`eval_score >= 2.635`) and `--patience 2`, observe whether the run stops on `target_met` (if it reaches 2.635 — aspirational), on `patience` (if it plateaus, e.g. the harness slice's observed `0.96 → 2.6173` then flat), or on `max_rounds`. Any of the three is a valid early/normal completion; the informational result is *which* reason fired and that `final_summary` reported it correctly. This is a demonstration, not a gate (LLM + round-count dependent).

### 11.5 Why this gate proves the slice works

- **§11.1 (resume idempotency)** is the lifecycle-critical fix and gets the strongest proof: a deterministic bridge test (guard returns one node, same id, no second append) AND a workflow-level resume test (re-entering `analysis_record` adds no duplicate node). This is integration-level proof for a lifecycle bug, per project guidance.
- **§11.2 / §11.3 (target / patience)** prove the previously-ignored run-spec fields now take effect via the three-rung ladder (§4): rung 1 (the bridge COMPUTATION) is pinned by deterministic unit tests over crafted `nodes.json`; rung 2 (the WIRING) is proven by an integration test whose mock orchestrator genuinely READS `stop_signals.json` and routes `complete` on `stop_reason` — NOT a scripted `complete`, which would prove nothing (MF2); rung 3 (the real LLM routing) is live-only and not claimed by CI.
- **§11.4 (lint + regressions)** proves the slice is structurally inert (no FSM change) and does not break the four existing evolve gates — including keeping the existing multi-round fixture's *scripted* mock so the unconditional `stop_signals.json` write stays inert there.
- Together: the bridge unit tests lock the deterministic logic (the part that matters and is testable); the signal-reading integration tests prove the wiring and the end-to-end early-stop / resume-safe outcomes; the limitation is acknowledged, not papered over — the real LLM routing on `stop_reason` is validated only by live runs, which is acceptable because the routing reduces to "is `stop_reason` non-null?", a single check the prompt makes explicit (§4).

## 12. Risks / open questions / maintainer decisions

### Maintainer decisions

1. **Patience — ENFORCED, not advisory (maintainer-decided).** The maintainer chose to enforce `budget.patience` as a real stop condition. **Superseded prior stance:** an earlier design position (carried from the multi-round / harness framing, where `success_criteria` and `patience` were "recorded quality descriptors, not hard gates" — harness §2.1: *"the run stops on max_rounds, not on this criterion"*) treated these run-spec fields as advisory display-only metadata. That advisory rationale was: keep completion purely round-budget-driven so behavior is simple and the LLM does not have to judge soft stop conditions. **This slice supersedes that** for `patience` (and `success_criteria`): the maintainer wants the authored stop conditions to actually take effect, with the fragility mitigated by computing the signals deterministically in the bridge (§4) rather than asking the LLM to judge them. The advisory framing remains true only for *which string* `success_criteria` carries (it is still a free-form descriptor `preflight` authors); what changes is that a parseable target now also stops the run.

2. **Stop-signal mechanism — hybrid (bridge computes, prompt routes), with the computation POST-RECORD in `attach_analysis` (decided).** §4 + §5.1: compute signals deterministically in `attach_analysis` *after* the durable record (so the signal reflects the just-recorded node, which the orchestrator reads on re-entry) and route on the single `stop_reason` in the `orchestrator` prompt. This is decided over (a) pure-prompt (untestable arithmetic, LLM-judged) and (b2) a hard deterministic verdict that bypasses the hub (breaks the human override). The earlier draft computed in `sample`; that was a correctness bug (one-round-stale signal at the completion vantage) — corrected here.

3. **Target parsing — strict bridge parser over the canonical `eval_score >= N` form, PAIRED with a `preflight` prompt tightening (decided).** §5.2: a strict regex parser in the bridge (no engine schema change), degrading safely to "no target stop" on an unparseable criterion with a surfaced warning, AND a `preflight` prompt edit that guarantees the first criterion is the canonical maximize shape (resolving OQ3 — the slice IS a `preflight` change). The structured-schema alternative is rejected (would require an `evolve_core` schema field, violating the byte-verbatim invariant); a bridge-side sidecar is rejected (second source of truth).

4. **Stop-reason precedence — `target_met` > `patience` > `max_rounds`, computed entirely in the bridge (decided).** §5.4: the bridge folds all three into a single `stop_reason` by this precedence (most-informative-wins), so the bridge is the single source of truth and `final_summary` reads the reason directly. This removed the earlier orchestrator-owns-`max_rounds` split (which the earlier draft kept for the human-override; §5.5 explains why that was unnecessary).

### Resolved (formerly open) questions

- **OQ1 — patience round counting vs. the seed (§5.3): RESOLVED — baseline-from-node-0.** Patience measures improvement over the ordered node sequence by id, treating **node 0 as the baseline regardless of seed provenance** (`rounds_since_improvement` increments from node 1). The earlier "count nodes with a non-empty parent" alternative is **deleted** — it undercounts from-scratch runs (where node 0 is a genuine first round yet has `parent: []`). The baseline rule needs no seed detection and composes correctly with the seed-aware `+1 max-rounds` seam (harness §7.4.1): `max_rounds` accounts for the seed slot separately; patience only cares about "rounds since the best last improved," for which node 0 as baseline is right in both seeded and from-scratch cases.
- **OQ2 — improvement epsilon (§5.3): PINNED (low-stakes maintainer pick).** Pinned default `EPS = 1e-9` (absolute), a bridge constant, documented in the result payload — so the implementer is not blocked. Context: circle-packing's evaluator uses a `1e-6` validity tolerance (harness §2.3), and `1e-9` sits below that. A relative epsilon remains a reasonable alternative for very-large-score objectives, but `1e-9` is the pinned default; the only genuinely-open part is whether a maintainer prefers a different constant (no behavioral risk either way).
- **OQ3 — `preflight` canonical criterion (§5.2, §10.2): RESOLVED — the slice EDITS `preflight`.** The slice does not assume `preflight`'s current output is parseable; it edits the `preflight` prompt to (a) author the canonical `<core_score> <comparator> <number>` first criterion and (b) delete the now-false "not a hard gate (stops on max_rounds)" sentence at `:164`. So this is no longer "no preflight change" — it is an in-scope prompt edit.
- **OQ4 — the workflow-level resume test's crash-window lever (§11.1b): RESOLVED — buildable.** Construct a checkpoint at `machineState: analysis_record` (via `FileCheckpointStore.save` in the programmatic harness, or `synthesizeCheckpoint` / `--state`) against a pre-populated workspace; `replayInvokeForRestoredState` re-runs the deterministic command, faithfully reproducing the double-append window. Honest caveat kept: this reproduces the re-entry mechanics, not a real process kill at a millisecond boundary (inherently not CI-reproducible).
- **OQ5 — surfacing `stop_signals.json` to `final_summary` (§5.4, §7): RESOLVED — it survives; `final_summary` reads it.** `current/` is only cleared at the top of `sample` (start of a round), never between the record and `final_summary`, and post-MF1 the file is freshly written by the round's `attach_analysis`. So `final_summary` reads the fresh `stop_reason` directly — no recomputation, no reason passed through the orchestrator.
- **OQ6 — `<=` "minimize" objective (§5.2): RESOLVED — maximize-only; reject `<=`/`<`.** The engine is maximize-only (`best_snapshot.py:26,35` take `max`/`<= best`; `cli.py:499` `best = max(nodes, key=score)`), and the patience logic (§5.3) hard-codes higher-is-better. The earlier §5.2 claim that `<=` "minimize" targets work was a **self-contradiction and is deleted**. The parser ACCEPTS `>=`/`>`/`==` and **REJECTS `<=`/`<`** with a `target_parse_warning` (target stop disabled), rather than silently mis-handling them. Minimize support would need a direction flag end-to-end and is out of scope (recorded as a known limitation).

### Deferred future refinements (recorded, not discarded)

- **General atomic checkpoint ↔ node-write (the real fix for the class of non-atomicity).** Fix C makes the ONE durable-write state replay-safe via a step-name guard. The broader hardening — a two-phase commit so the engine `nodes.json` write and the workflow checkpoint advance are atomic — would make *every* deterministic state's durable effect transactional, not just `analysis_record`. It is a cross-layer orchestrator change outside this slice's two-file scope; deferred. The step-name guard is sufficient because `analysis_record` is the only state whose replay corrupts durable state (all others write `current/` scratch).
- **Additional stop conditions from `stop_conditions` (the authored-but-generic list).** The run-spec has a `stop_conditions` list (`run_state.py:35`, authored as `["max_rounds"]`, `workflow.yaml:211`). This slice wires `target_met` and `patience` directly; a future increment could make `stop_conditions` a first-class, extensible registry (e.g. `wall_clock`, `cost_budget`, `no_valid_candidates`) that the bridge interprets generically. Deferred — over-engineering for the current two stops.
- **Configurable improvement epsilon / patience semantics per run-spec.** If experiments need different plateau definitions, the epsilon and "improvement" rule could move into the run-spec. Deferred until a second experiment needs it (YAGNI).

### Risks

- **Existing gates incidentally tripping the new stops (§11.4).** The bridge now writes `stop_signals.json` unconditionally every round, including in the existing fixtures. The existing multi-round positive fixture authors `eval_score >= 1.0` with a `[2, 5, 6]` trajectory — so `target_met` is true at node 0; a signal-reading orchestrator would stop after one round and break the three-round assertion. Mitigation: keep that fixture's *scripted* mock orchestrator (it ignores `stop_signals.json`), and scope the signal-reading mock to the new §11.2/§11.3 tests only (the production default is never weakened — only the test fixtures' routing differs).
- **Unparseable `success_criteria` silently disabling the target stop (§5.2).** If a criterion is non-canonical (e.g. a human-edited spec, or a `<=`/`<` minimize form the parser rejects), the parser yields `target = null` and the target stop never fires — the run falls back to `max_rounds`/`patience` (safe, but the operator may expect an earlier stop). Mitigation: the `target_parse_warning` surfaced in `attach_analysis`'s payload and visible at `final_review`; the §5.2 `preflight` prompt edit makes the canonical shape the default, so this is a defensive fallback, not the primary path.
- **Patience off-by-one in round counting (§5.3, OQ1).** Miscounting evolution rounds would make patience fire one round early or late. Mitigation: the baseline-from-node-0 rule (OQ1, no seed detection needed) plus the dedicated bridge unit tests over crafted node sequences (§11.3).
- **Stale stop signal at the completion vantage (the MF1 bug, now fixed).** Computing the signal in `sample` (start of round) would make it one round stale when the orchestrator decides `complete` on re-entry after `analysis_record` — a target/patience first met in round N would not be seen until round N+1, burning an extra round. Mitigation: the signal is computed in `attach_analysis` *after* the record (§5.1), so the orchestrator reads a signal that includes the just-recorded node. (`stop_signals.json` surviving to `final_summary` is no longer a risk — §5.4/OQ5: `current/` is only cleared at the top of `sample`, never between record and `final_summary`.)
- **Human "run N more rounds" defeated by a standing stop signal (§5.5, §7).** Without the orchestrator override guard, an early `target_met`/`patience`/`max_rounds` stop would immediately re-fire after a `final_review` FORCE_REVISION, ignoring the human's request. Mitigation: the §5.5 prompt guard makes a human extension beat the standing `stop_reason` until the extended target is reached. This is the load-bearing human-gate interaction (independent of where the signal is computed — it is a routing choice over whatever `stop_reason` is standing); the §11.4 existing-human-surface-gate test must confirm "run more rounds" still works after an early stop.

### Invariants preserved (not at risk)

- **Vendored engine byte-verbatim (§8):** no `evolve_core/` change. Fix A/B live in the bridge `attach_analysis` (post-record signal computation) + the `orchestrator`/`preflight`/`final_summary` prompts; Fix C lives in the same `attach_analysis` (pre-record guard). The engine's append semantics are untouched (the guard is a bridge-side precondition, not an engine contract change).
- **No FSM topology change (§9):** no new state, transition, gate, or terminal; no `initial:` change. `--strict` lint surface is unchanged. The only `workflow.yaml` edits are inside existing state prompts (`orchestrator`, `preflight`, `final_summary`).
- **No run-spec schema change (§8):** `success_criteria` and `patience` already exist and are authored by `preflight`; this slice reads them. The `preflight` prompt edits change only the LLM-authored *value* of `success_criteria`, not the schema. `evolve-brief normalize` / `run_state.py` are untouched.
- **Determinism + same-environment scoring (§8):** the stop signals are a pure function of durable state; the Fix C guard appends nothing. No scoring path, install, or network is added. Every candidate is still scored in the same provisioned venv (harness §8).
- **The human-surface flow is a clean superset (§7):** `complete → final_summary → final_review → done` is unchanged; an early stop just makes `complete` fire sooner, with `final_summary` reporting the reason and `final_review`'s "run more rounds" path preserved by the orchestrator override.

