# Evolve Native Workflow — Second Vertical Slice (multi-round loop: orchestrator hub + sampling + analyzer + cognition + determinism)

Status: Design — ready to implement (no further design input required). Both prior maintainer calls are now **signed off** (§16): the loop is driven by the parent-design `orchestrator` agent hub, and `preflight_review` stays deferred for this slice.
Audience: IronCurtain workflow engineer extending the merged `evolve` workflow package.
Implementation contract: this document is implemented with **no further design input**. It names exact files, the full extended `workflow.yaml`, the `evolve_core` CLI argv each state runs, the bridge changes, the package changes, and the binary end-to-end gate.

Predecessor (merged, build ON — do not redesign):

- **Single-round slice** — `docs/designs/evolve-single-round-slice.md`, shipped as commit `8fd85cd` (PR #300). Gives us the live package at `src/workflow/workflows/evolve/`: `workflow.yaml` (linear `preflight → researcher → evaluate → record_node → done/failed`), the packaged `evolve_core` engine + wrappers under `scripts/`, the `evolve_result.py` bridge (`evaluate`/`record` subcommands), `requirements.txt` (`numpy`+`pyyaml`), and the two gate tests (`test/workflow/evolve-single-round.integration.test.ts`, `test/workflow/evolve-result-bridge.test.ts`).
- **Containerized deterministic execution + script packaging** — `docs/designs/deterministic-in-container-execution.md` (PR #292): `container: true`/`containerScope`, `scripts/` staged read-only at `/workflow-scripts`, per-workflow image from `requirements.txt`, `--network=none`, `/workspace` RW bind, `/opt/workflow-venv/bin/python`.
- **Structured deterministic result contract** — `docs/designs/deterministic-result-contract.md`: `resultFile`, `when: { verdict: ... }` on deterministic states, the `{ verdict, payload?, passed? }` `result.json` schema, the reserved `result_file_error` verdict, container-only enforcement (`validate.ts:517-535`), and `applyResultFile`.

Parent design: `docs/designs/asi-evolve-native-workflow.md` — the full FSM (`orchestrator` hub, the loop, `researcher`/`evaluate`/`analyzer`/`record_node`, sampling families, cognition-vs-database split, round budget/patience, the human gates), and the engine-native `.evolve_runs/` layout (decided for slice 1). **This slice implements the next non-trivial subset, and — per the 2026-06-16 maintainer sign-off — it builds the loop on the parent's `orchestrator` agent hub rather than a deterministic round controller.**

Engine (byte-verbatim, do NOT fork): `donotcommit/ASI-Evolve/skills/evolve/scripts/evolve_core/`. The new subcommands this slice drives are already present in `cli.py`: `db sample` (`cli.py:406`), `db record --analysis/--analysis-file/--parent` (`cli.py:417`, flags at `cli.py:689-694`), `cognition init/add/search` (`cli.py:342-404`), `db best/stats` (`cli.py:492-515`).

---

## 1. Summary & goals

### What ships this slice

The `evolve` package gains a **bounded multi-round evolution loop driven by an `orchestrator` agent hub** (the parent design's central router) that exercises the full engine data-flow: each round the orchestrator routes through a durable **sample** of a parent/context node from the DB, the **researcher** evolves a new candidate from that parent (plus retrieved cognition), the candidate is **evaluated**, a per-round **analyzer** agent writes a transferable lesson, and the round is **recorded** as exactly one engine node carrying that lesson. **Cognition** is seeded at preflight and retrieved (vector similarity) into the researcher each round. The orchestrator terminates the loop when the durable node count reaches the run-spec round budget (emitting `complete`); a deterministic `isRoundLimitReached` guard backstops a wedged hub. The slice also folds in **two determinism fixes** against the vendored engine (§9) — first-class requirements, not optional.

```
preflight (agent) ─ready→ orchestrator (agent HUB) ─────────────────────────┐
preflight ─blocked→ failed                                                   │
                                                                             │
orchestrator routes each turn off the durable run state (committed node      │
count vs run-spec round budget, plus best score):                            │
   ─design→   sample (deterministic, container) ─sampled→ researcher (agent) ┤
   ─evaluate→ evaluate (deterministic, container) ─evaluated→ ───────────────┤
   ─analyze→  analyzer (agent) ──────────────────────────────────────────── ┤
   ─record→   analysis_record (deterministic, container) ─recorded→ ──────── ┤  (every spoke
   ─complete→ done (terminal)                                                 │   returns to
   ─escalate→ failed (terminal)                                              ─┘   orchestrator)
   guard isRoundLimitReached → failed (terminal-safety backstop, §3.6)

deterministic spoke hard-failures route straight to failed:
   sample ─sample_error→ failed     evaluate ─evaluator_blocked→ failed
   analysis_record ─needs_repair→ failed     any ─result_file_error→ failed
```

- `preflight` (agent): writes `run_spec.yaml` (objective, evaluator command, score field, **`max_rounds = N`**, sampling **`greedy`**, **`cognition.source_mode != none`**) with `approval.confirmed=true`, **and** authors the cognition seed text. §5, §6, §11.
- `orchestrator` (agent, the **hub**): the central router. On each (re-)entry it reads the durable run state — the committed `nodes.json` count vs the run-spec round budget, plus the best score — and emits a routing verdict (`design`/`evaluate`/`analyze`/`record`/`complete`/`escalate`). Specialists return to it. §3.
- `sample` (deterministic, container): runs `evolve-db sample` (greedy parent selection) **and** `evolve-cognition search` (vector retrieval), writing `current/context.json` for the researcher; on its first entry it also seeds cognition in-container. §4, §5.
- `researcher` (agent): evolves a candidate from the sampled parent (diff or full-rewrite) using the retrieved cognition, then returns to the orchestrator. §7.
- `evaluate` (deterministic, container): **byte-identical to slice 1's evaluate logic** except step-name/code come from the per-round `current/`. §8.1.
- `analyzer` (agent): writes a transferable lesson (`analysis.md`) for the round, then returns to the orchestrator. §6.
- `analysis_record` (deterministic, container): the **single** durable `evolve-db record --analysis-file --parent` per round (the one engine node-write), attaching the lesson and the sampled parent. §3.5, §6.3, §8.2.
- The gated real-Docker integration test (`evolve-multi-round.integration.test.ts`) extending slice 1's is the front-and-center completion gate. §12.

### What's deferred (see §15)

FAISS / sentence-transformers (Tier 1); the `island` sampler; `ucb1`/`random` (non-deterministic, deferred behind a seeding story); multi-file candidates; parallel workers; the richer web-UI round table; the `preflight_review`/`human_escalation`/`final_summary`/`final_review` human gates (§11 keeps `failed` terminals — maintainer-signed for this slice); record-by-step-id idempotency. The orchestrator's richer parent-design verdicts (`seed_initial`) and the `final_summary`/`final_review` happy-path terminals collapse here to a single `complete → done`.

### Goals (binary, restated as the gate)

After an N-round run reaches terminal `done`:

1. The engine DB (`.evolve_runs/main/database_data/nodes.json`) holds **exactly N nodes**.
2. **Sampling read the vector store / DB:** a later round's recorded node lists a **prior node id** in its `parent` field (the greedy parent), proving `evolve-db sample` read `nodes.json` and the round wired the parent through `analysis_record`'s `--parent`.
3. **Cognition was retrieved:** each round's `current/context.json` carries a non-empty `cognition.matches` list (vector search hit the seeded items).
4. **Each recorded node carries an analysis/lesson:** `nodes[*].analysis` is non-empty for every node (the analyzer's lesson, persisted via `analysis_record`).
5. **Best score is non-decreasing across rounds:** `best/<step>/results.json` `eval_score` is monotonic in round order; the final best equals `max(nodes[*].score)`.
6. **Determinism:** two identical N-round runs produce **byte-identical `database_data/faiss/vector_store.pkl`** (embeddings reproducible), and identical `nodes.json` **after stripping `created_at`** (§9).

A negative case (evaluator crash mid-loop) routes to `failed` with fewer than N nodes, as in slice 1. This proves loop + sampling + cognition + analyzer + determinism all work **together**.

---

## 2. Where it fits / the delta from slice 1

Slice 1 proved engine + container exec + verdict routing on a **single linear round**. This slice keeps that spine and adds, in order of new surface:

| Capability       | Slice 1                           | This slice                                                                                 |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Rounds           | exactly 1, fixed `step_0001`      | N, `step_0001…step_000N`, hub-driven                                                       |
| Loop control     | none (linear)                     | `orchestrator` agent hub + `isRoundLimitReached` backstop (§3)                             |
| Parent selection | none (first candidate)            | `evolve-db sample` greedy parent (§4)                                                      |
| Cognition        | seeded empty (`source_mode none`) | seeded + retrieved each round (§5)                                                         |
| Analyzer         | absent                            | `analyzer` agent + single durable record in `analysis_record` (§6)                         |
| Researcher input | objective only                    | objective + sampled parent + retrieved cognition (§7)                                      |
| `evaluate`       | as built                          | reused verbatim, per-round step from `current/` (§8.1)                                     |
| Durable record   | `record_node` (slice-1 path)      | single `evolve-db record --analysis-file --parent` in `analysis_record` (§3.5, §6.3, §8.2) |
| Determinism      | not addressed                     | `PYTHONHASHSEED=0` + `created_at` disposition (§9)                                         |

No workflow-**runtime** changes (orchestrator/validate/machine-builder) are required — both runtime capabilities are merged, slice 1 consumes the deterministic ones, and the `orchestrator` hub uses only the long-standing agent-state + `when:{verdict}` routing plus the existing `isRoundLimitReached` guard / `settings.maxRounds` backstop (`lint.ts:289-307`, `guards.ts:21-26`). This slice is, again, **pure workflow-package + bridge + test**, plus the one-line env fix in the bridge.

The two slice-1 maintainer sign-offs carry forward: **engine-native `.evolve_runs/main/` layout** (not `.workflow/`) and **`failed` terminals instead of human gates** for CI-runnability. §11 records the maintainer's 2026-06-16 sign-off to keep `preflight_review` deferred for this slice specifically.

---

## 3. The FSM (extended `workflow.yaml`) — the loop mechanism

### 3.1 Decision (signed off 2026-06-16): the parent-design `orchestrator` agent hub

The parent design centers the loop on an `orchestrator` agent hub that reads the durable run state and emits `design`/`evaluate`/`analyze`/`record`/`complete`/`escalate` verdicts, with every specialist returning to the hub (`asi-evolve-native-workflow.md:292-356`, "Proposed FSM" + "State Responsibilities"). **This slice builds that hub.** The maintainer signed off on the hub over a deterministic round controller (§16 #1), so the loop is parent-design-faithful from the first multi-round slice rather than refactored into the hub later.

How the hub decides, and what it routes to:

- The orchestrator is an **agent state** and the FSM's central router. It is the entry's only successor (`preflight ─ready→ orchestrator`) and the sole state from which every specialist is dispatched.
- On each (re-)entry it reads the durable run state given to it (§3.2): the committed `nodes.json` node count `done_rounds`, the run-spec round budget `max_rounds` (= N), and the best score so far. It emits exactly one routing verdict:
  - `design` → `sample` (deterministic, container) → `researcher` (agent) — start a new round: take the durable parent/cognition read, then have the researcher evolve a candidate.
  - `evaluate` → `evaluate` (deterministic, container) — score the round's candidate.
  - `analyze` → `analyzer` (agent) — write the round's transferable lesson.
  - `record` → `analysis_record` (deterministic, container) — the **single** durable engine node-write (`evolve-db record --analysis-file --parent`, §3.5).
  - `complete` → `done` (terminal) — the budget is reached (`done_rounds >= max_rounds`); the run is finished.
  - `escalate` → `failed` (terminal) — the orchestrator judges the run unrecoverable (a stand-in for the parent's `human_escalation`, which is deferred, §11).
- **Return contract.** Deterministic specialists return to the orchestrator via their _result-contract_ verdict (`sample ─sampled→ researcher`, `evaluate ─evaluated→ orchestrator`, `analysis_record ─recorded→ orchestrator`); their hard-failure verdicts route straight to `failed` without an orchestrator turn (`evaluator_blocked`, `sample_error`, `needs_repair`, `result_file_error`), matching the parent's "deterministic states route only on their own mechanical outcome." Agent specialists (`researcher`, `analyzer`) return via an **unconditional** `to: orchestrator` edge — so their `agent_status` block is informational, exactly the parent's `vuln-discovery`-style specialist return (`asi-evolve-native-workflow.md:463-466`). `sample` is the one deterministic node that does _not_ return to the orchestrator: it feeds `researcher` directly (a `design` dispatch is "sample-then-design"), and `researcher` returns to the hub.

The per-round phase order (`design → evaluate → analyze → record`) is the orchestrator's responsibility to emit, not the FSM's: the graph is hub-and-spoke, so the _agent_ drives the sequence and the FSM only validates the verdict and follows the declared edge. This is what makes the hub faithful — the search-strategy decision lives in the agent's status block, per the parent design's steering model (`asi-evolve-native-workflow.md:448-482`).

### 3.2 What the orchestrator reads to decide `complete` (the run-state seam)

The orchestrator must know `done_rounds` (committed node count) and `max_rounds` (the budget) to emit `complete` at the right time, and it must read them from **durable** state so the decision survives resume. Two facts make this clean without a deterministic controller:

1. **The orchestrator runs in-container** (it is an agent state in the shared container, `settings.mode: docker` + `sharedContainer: true`), so it can read the engine files directly: `/workspace/.evolve_runs/main/database_data/nodes.json` (count its `nodes` map for `done_rounds`) and `/workspace/.evolve_runs/main/run_spec.yaml` (`budget.max_rounds`, `budget.patience`). Its prompt (§3.3) instructs it to read both and to emit `complete` once `done_rounds >= max_rounds`, `design` to start a round when `done_rounds < max_rounds` and no round is in-flight, and the intermediate phase verdicts (`evaluate`/`analyze`/`record`) to advance the in-flight round. Best score (`evolve-db best`/`stats`) is available for the patience judgment (§10) but the budget cap is the primary terminator the gate exercises.
2. **The hub never needs a state that was not spawned.** All servers/scripts the deterministic spokes call live in the same `primary` scope (§3.4); `sample`'s first entry seeds cognition (§5.3) so the hub never depends on a separate seeding state having run.

Because the orchestrator derives `done_rounds` from the committed `nodes.json` rather than from FSM memory, the loop is **resume-safe**: re-entering the hub after a crash recomputes the phase from durable state. The FSM visit counters (which back the §3.6 backstop) are a _safety_ bound, not the loop's logic — the logic is the orchestrator's read of `nodes.json` vs `max_rounds`.

Because the orchestrator derives `done_rounds` from the committed `nodes.json`, the loop is **resume-safe**: re-entering the hub after a crash recomputes the phase from durable state, never from FSM memory.

### 3.3 Full extended `workflow.yaml` (hub-and-spoke)

This is the exact, verified definition (it lints clean — see §3.4). `settings.maxRounds: 24` plus the `isRoundLimitReached` guard on the orchestrator is the terminal-safety backstop (§3.6).

````yaml
name: evolve
description: 'Evolve — multi-round evaluator-driven candidate search via an orchestrator hub: sampling, cognition, and per-round analysis.'
initial: preflight

settings:
  mode: docker
  dockerAgent: claude-code
  sharedContainer: true # REQUIRED for container: true deterministic states
  model: anthropic:claude-sonnet-4-6
  maxRounds: 24 # terminal-safety backstop (§3.6); the orchestrator's own complete verdict is the normal exit

states:
  preflight:
    type: agent
    description: Define the run spec, initialize the run, and author the cognition seed.
    persona: global
    prompt: |
      You are configuring a multi-round Evolve experiment. The task describes a
      program-search objective with an evaluator that prints a score.

      Do ALL of these, in order, then finish with the required agent_status block:

      1. Initialize the run by executing the evolve-brief helper. The run lives under
         /workspace/.evolve_runs/main/. Use these flags, filling OBJECTIVE and EVAL_CMD
         from the task (set --max-rounds to the requested number of rounds, default 3):

         /opt/workflow-venv/bin/python /workflow-scripts/evolve-brief normalize \
           --workspace-root /workspace \
           --run-name main \
           --objective "OBJECTIVE" \
           --core-score eval_score \
           --evaluation-command "EVAL_CMD" \
           --evaluation-timeout-secs 30 \
           --success-criterion "eval_score >= 1.0" \
           --max-rounds 3 \
           --patience 2 \
           --stop-condition "max_rounds" \
           --writable-path .evolve_runs \
           --primary-target candidate.py \
           --sampling-algorithm greedy \
           --sample-n 1 \
           --cognition-source-mode seed \
           --confirmed true

         EVAL_CMD must read the candidate at {quoted_code_path}, run it, and write a JSON
         file at {quoted_results_path} containing an "eval_score" number.

      2. Write a cognition seed file at /workspace/.evolve_runs/main/cognition_seed.md
         containing one or more ```json fenced blocks of reusable domain heuristics for
         this objective (do NOT put round-by-round results here — only durable knowledge).
         The embedding of these heuristics happens in-container at the first sample (§5.3);
         you only author the seed text here.

      3. Confirm evolve-brief exited 0 and run_spec.yaml exists.

      If the task lacks an objective or an evaluator you cannot construct, set verdict: blocked.
      Otherwise set verdict: ready.
    inputs: []
    outputs: []
    transitions:
      - to: orchestrator
        when: { verdict: ready }
      - to: failed
        when: { verdict: blocked }

  orchestrator:
    type: agent
    description: Central router. Reads the durable run state and routes the next phase.
    persona: global
    prompt: |
      You are the Evolve orchestrator — the central router for a bounded multi-round
      search. On every turn you read the durable run state and emit exactly ONE routing
      verdict in your agent_status block. You do NOT write candidates, run evaluators, or
      record nodes; you only decide what happens next.

      Read these two files first (both already exist — preflight wrote them):
        - /workspace/.evolve_runs/main/run_spec.yaml — budget.max_rounds is N (the round budget).
        - /workspace/.evolve_runs/main/database_data/nodes.json — count its "nodes" map; that
          count is done_rounds (committed rounds). The file is absent before round 1 (done_rounds = 0).

      Also note the per-round scratch under /workspace/.evolve_runs/main/current/ (overwritten
      each round): context.json (sample done), result.json (evaluate done), analysis.md (analyze done),
      analysis_record.json (record done). Use these to tell which phase the in-flight round is at.

      Decide and emit one verdict:
        - complete  — if done_rounds >= max_rounds. The budget is reached; the run is finished.
        - design    — if done_rounds < max_rounds AND no round is in-flight (no fresh current/context.json
                       for the next step, or the previous round was already recorded). Start a new round:
                       this dispatches sampling, then the researcher.
        - evaluate  — if the in-flight round has a candidate written but no result.json yet.
        - analyze   — if the in-flight round has a result.json but no analysis.md yet.
        - record    — if the in-flight round has an analysis.md but is not yet committed to nodes.json.
        - escalate  — only if the run is unrecoverable (e.g. the run spec is internally inconsistent and
                       no round can proceed). This ends the run as failed.

      Finish with the required agent_status block carrying exactly one of those verdicts.
    inputs: []
    outputs: []
    transitions:
      - to: failed
        guard: isRoundLimitReached
      - to: sample
        when: { verdict: design }
      - to: evaluate
        when: { verdict: evaluate }
      - to: analyzer
        when: { verdict: analyze }
      - to: analysis_record
        when: { verdict: record }
      - to: done
        when: { verdict: complete }
      - to: failed
        when: { verdict: escalate }

  sample:
    type: deterministic
    description: Sample a parent node (greedy) and retrieve cognition; seed cognition on first entry.
    container: true
    resultFile: .evolve_runs/main/current/sample.json
    run:
      - [
          '/opt/workflow-venv/bin/python',
          '/workflow-scripts/evolve_result.py',
          'sample',
          '--run-dir',
          '/workspace/.evolve_runs/main',
          '--query-from-spec',
          '--context-file',
          '/workspace/.evolve_runs/main/current/context.json',
          '--result-file',
          '/workspace/.evolve_runs/main/current/sample.json',
        ]
    transitions:
      - to: researcher
        when: { verdict: sampled }
      - to: failed
        when: { verdict: sample_error }
      - to: failed
        when: { verdict: result_file_error }
      - to: failed

  researcher:
    type: agent
    description: Evolve one candidate from the sampled parent and retrieved cognition.
    persona: global
    prompt: |
      Write exactly one candidate program for this round.

      Read the round context at /workspace/.evolve_runs/main/current/context.json. It
      contains:
        - step_name: the directory you must write the candidate into
        - parent: the sampled parent node (id, code, score, analysis) — may be null on round 1
        - cognition.matches: retrieved durable heuristics relevant to this objective

      If a parent is present, EVOLVE it: improve on the parent's code using the cognition
      hints (you may reason in terms of a SEARCH/REPLACE diff against the parent, but always
      emit the COMPLETE resulting file). If parent is null, write a full candidate from scratch.

      Write the COMPLETE candidate file to:
        /workspace/.evolve_runs/main/steps/<step_name>/code
      (substitute <step_name> from context.json). Create the directory if needed. Write
      only that one file, no commentary in the file.

      Finish with the required agent_status block; your verdict is informational (you return
      to the orchestrator unconditionally).
    inputs: []
    outputs: []
    maxVisits: 3
    transitions:
      - to: orchestrator

  evaluate:
    type: deterministic
    description: Run the configured evaluator on this round's candidate.
    container: true
    resultFile: .evolve_runs/main/current/result.json
    run:
      - [
          '/opt/workflow-venv/bin/python',
          '/workflow-scripts/evolve_result.py',
          'evaluate',
          '--run-dir',
          '/workspace/.evolve_runs/main',
          '--step-from-current',
          '--code-from-current',
          '--result-file',
          '/workspace/.evolve_runs/main/current/result.json',
        ]
    transitions:
      - to: orchestrator
        when: { verdict: evaluated }
      - to: failed
        when: { verdict: evaluator_blocked }
      - to: failed
        when: { verdict: result_file_error }
      - to: failed

  analyzer:
    type: agent
    description: Write a transferable lesson for the round.
    persona: global
    prompt: |
      Analyze the round that just completed and write a SHORT transferable lesson.

      Read /workspace/.evolve_runs/main/current/context.json (parent, cognition) and the
      just-evaluated results at /workspace/.evolve_runs/main/current/result.json (the score).
      Read this round's candidate at the step path named in context.json (steps/<step_name>/code).

      Write a concise markdown lesson — what worked, what failed, and a heuristic a future
      round should reuse — to:
        /workspace/.evolve_runs/main/current/analysis.md
      Keep it to a few sentences. Do NOT restate the score; capture the transferable insight.

      Finish with the required agent_status block; your verdict is informational (you return
      to the orchestrator unconditionally).
    inputs: []
    outputs: []
    maxVisits: 3
    transitions:
      - to: orchestrator

  analysis_record:
    type: deterministic
    description: The single durable engine node-write — commit the round with its lesson and parent.
    container: true
    resultFile: .evolve_runs/main/current/analysis_record.json
    run:
      - [
          '/opt/workflow-venv/bin/python',
          '/workflow-scripts/evolve_result.py',
          'attach_analysis',
          '--run-dir',
          '/workspace/.evolve_runs/main',
          '--step-from-current',
          '--name-from-current',
          '--parent-from-current',
          '--code-from-current',
          '--results-from-current',
          '--analysis-file',
          '/workspace/.evolve_runs/main/current/analysis.md',
          '--result-file',
          '/workspace/.evolve_runs/main/current/analysis_record.json',
        ]
    transitions:
      - to: orchestrator
        when: { verdict: recorded }
      - to: failed
        when: { verdict: needs_repair }
      - to: failed
        when: { verdict: result_file_error }
      - to: failed

  done:
    type: terminal
    description: Round budget reached; N candidates scored and recorded.

  failed:
    type: terminal
    description: Preflight blocked, sampling failed, evaluator failed, record failed, or round-limit wedge.
````

### 3.4 Why the FSM passes `validate.ts` + `lint.ts` (verified — it lints clean)

Run through both layers (verified with `tsx src/cli.ts workflow lint <path>`, which runs `validateDefinition()` then `lintWorkflow()`; the definition produces **no diagnostics, even under `--strict`**):

- **Structural validation (`validate.ts`).** Every `when:{verdict}` edge sits on a `container: true` deterministic state with `sharedContainer: true` + `mode: docker`, satisfying the container-only structured-routing rule (`validate.ts:520-535`: `resultFile` / verdict-edge states must be `container: true`; `container: true` requires `sharedContainer` + docker). Every `resultFile` is a safe workspace-relative path (`isSafeWorkspaceRelativePath`, `validate.ts:526`). The orchestrator's `guard: isRoundLimitReached` is a registered guard (`REGISTERED_GUARDS`, `guards.ts:42-50`; checked at `validate.ts:436-440`) and never co-occurs with a `when` on the same transition (mutual exclusivity, `validate.ts:356-359`). Agent specialists' lone `to: orchestrator` is a valid unconditional edge; the orchestrator's mix of one `guard:` edge and several `when:{verdict}` edges is allowed because guard and when are separate transitions. All states are reachable from `preflight` and every non-terminal reaches a terminal.
- **WF012 (verdict edges need a `resultFile`).** `sample`, `evaluate`, `analysis_record` each declare `resultFile` (`lint.ts:501-522`). Confirmed by control: deleting `sample`'s `resultFile` makes WF012 fire; restoring it clears it.
- **WF011 (container state may run before its scope is minted).** The lint does a **forward BFS from `initial` that treats an agent state in the target scope as _absorbing_** — on reaching one it stops expanding, because that agent mints the scope's container (`lint.ts:446-495`, `isReachableWithoutScopeAgent`). The rule is _not_ "each container state has an agent predecessor"; it is "**no fresh-run path reaches a container state without first passing through a scope agent**." The entry `preflight` is a `primary`-scope agent (`persona: global` → `DEFAULT_CONTAINER_SCOPE`), so the BFS absorbs at it immediately and never expands past `preflight`/`orchestrator` (both `primary`-scope agents). Every `container: true` deterministic state (`sample`/`evaluate`/`analysis_record`) is reachable only behind that absorbing entry agent, so `isReachableWithoutScopeAgent` returns false for all three — WF011 does not fire. Verified clean.
- **WF006 + no-wedge (terminal-safety backstop).** `settings.maxRounds` is set, and the orchestrator carries a `guard: isRoundLimitReached` transition, satisfying `checkMaxRoundsHasGuard` (`lint.ts:289-307`). Confirmed by control: removing that guard makes WF006 fire (`maxRounds=24 is set but no transition uses "isRoundLimitReached"`); restoring it clears it. See §3.6 for why this also closes the no-wedge hole.
- **No WF001/WF008.** Every state reaches a terminal (WF001 clean). The agent `maxVisits` on `researcher`/`analyzer` carry no `isStateVisitLimitReached` transition, so WF008's ordering rule does not apply (it only fires when a `maxVisits` state also has an `isStateVisitLimitReached` guard ordered after a loop-continuing edge — `lint.ts:379-418`).

### 3.5 The single durable engine node-write is in `analysis_record` (avoids a duplicate node)

The engine's `evolve-db record` is **not idempotent by step name** — every call allocates a fresh `next_id` (`database.py:73-74`; flagged in slice-1 §13.4). So the round must call it **exactly once**, or each round commits two nodes and breaks the "exactly N nodes" gate. Under the hub, the orchestrator routes `record → analysis_record`, and **`analysis_record` is the one and only `evolve-db record`** per round: it runs after the analyzer's lesson exists, with `--analysis-file` and `--parent`. Result: exactly one node per round, carrying its lesson and its sampled parent (gate items §1.1, §1.2, §1.4).

This slice has **no `record_node` state** — the slice-1 `record_node` evaluation→commit gate is folded into the orchestrator's phase logic (the orchestrator reads `current/result.json` to decide whether to route `analyze` vs `escalate`), so the duplicate-record hazard the slice-1 design worried about never arises in the graph. The slice-1 bridge `record` subcommand is **retained unchanged** for backward compatibility (its DB-writing path and its test are untouched — see §8.2 and the should-fix in §13); the new single-write path is `attach_analysis`, gated on the `--*-from-current` flags. The full rationale and rejected alternatives are in §6.3; the FSM in §3.3 is canonical.

### 3.6 Terminal-safety backstop (REQUIRED): the round budget pairs with a deterministic guard

The parent design and the earlier asi-evolve review both flag that an `orchestrator` hub whose only outgoing edges are `when:{verdict}` can **wedge** if the agent never emits a terminating verdict (`complete`/`escalate`): the FSM would re-enter the hub forever with no deterministic stop. The slice closes this exactly as WF006 prescribes (`lint.ts:289-307`):

- `settings.maxRounds: 24` is set, and the orchestrator's **first** transition is `guard: isRoundLimitReached → failed`. Listed first so it is evaluated before any verdict edge on each hub entry — if the cap is hit, the run terminates deterministically regardless of what verdict the agent emitted.
- **What the guard actually counts.** `isRoundLimitReached` compares `max(context.visitCounts) >= context.maxRounds` (`guards.ts:21-26`). `visitCounts` is incremented **only on agent-state entry** (`incrementVisitCount` is an entry action on agent states only — `machine-builder.ts:262`; deterministic states do not increment it). So the cap counts agent-state visits, and the most-visited agent state is the orchestrator (it re-enters once per routing decision). For a clean N-round run the orchestrator is entered `4N+1` times (the `design`/`evaluate`/`analyze`/`record` cycle per round — the round-1 `design` is the first entry — plus the final `complete`); at N=3 that is 13, matching §12. `maxRounds: 24` sits comfortably above a clean N=3 run but bounds a wedged hub (an orchestrator that never emits `complete` trips the guard at 24 agent-visits and routes to `failed`). A run that needs a larger N must raise `maxRounds` accordingly; the value is a _safety ceiling on hub entries_, not the round budget itself (the round budget is `run_spec.yaml budget.max_rounds`, read by the orchestrator).
- This is the WF006 contract: the guard makes the durable round budget enforceable by the FSM even if the agent misbehaves. Lint confirms it (no WF006); removing the guard reintroduces WF006 (verified, §3.4).

---

## 4. Sampling

### 4.1 Sampler choice for v1: **greedy** (deterministic, decided)

`greedy` (`algorithms/greedy.py:17` — `sorted(nodes, key=score, reverse=True)[:n]`) is the v1 sampler because:

- It is **deterministic** — pure score sort, no `random`. `ucb1` and `random` both call Python's unseeded `random.sample` (`ucb1.py:25,32`, `random.py:18`), so they would defeat the run-to-run reproducibility the determinism gate (§9, §12) requires. Deferring them behind a seeding story (§15) keeps this slice deterministic without forking the engine.
- It satisfies the "later round's parent is a prior node" gate requirement directly: with N≥2 nodes, `greedy` returns the highest-scoring prior node as the parent, which the round wires into `analysis_record`'s `evolve-db record --parent`.
- It needs no island feature-dimension / bin setup (`sampling_config.py:38-45` `sampling_config_fingerprint` only carries `feature_dimensions`/`feature_bins` for `island`), so `greedy` keeps `run_spec.yaml` minimal — exactly as slice 1 already chose.

`run_spec.yaml` therefore sets `sampling.algorithm: greedy`, `sample_n: 1`. The sampling config is run-level immutable once nodes exist (`cmd_brief_normalize`, `cli.py:202-205` → `SAMPLING_CONFIG_IMMUTABLE_ERROR`), so it is fixed at preflight and never re-negotiated mid-loop.

### 4.2 What `evolve-db sample` reads, and the vector-store nuance (load-bearing)

```
/opt/workflow-venv/bin/python /workflow-scripts/evolve-db sample \
  --run-dir /workspace/.evolve_runs/main \
  --n 1
```

`cmd_db_sample` (`cli.py:406`): `require_evolve_ready` (approval gate); `build_database` (which constructs the `Database` with `storage_dir = database_data/`, loads `nodes.json` and the numpy vector store via `_load_locked`, `database.py:169-185`); `db.sample(n=1)` → the greedy sampler ranks the loaded `self.nodes` by score and **persists sampler state** (`_save_locked`, `database.py:60`); returns `{ "nodes": [node.to_dict(), ...] }`.

**Precise read story (corrects the task's loose framing).** The _parent sampler_ (greedy) ranks over `self.nodes` (loaded from `nodes.json`), not over vector similarity — the vector store (`database_data/faiss/vector_store.pkl`) is built at **record** time (`database.py:79-82` — `embedding.encode` + `faiss.add` on every `add_with_previous_nodes`) and is read by **cognition retrieval** (`cognition.py:73` `faiss.search`), not by the greedy parent pick. So:

- **`evolve-db sample` exercises the sampler + the durable `nodes.json` DB** (and re-serializes the vector store on `_save_locked`, `database.py:167`). The gate's "sampling read the DB" assertion (§1.2: a later node's `parent` is a prior id) proves this path ran over committed nodes.
- **The vector store is exercised by `evolve-cognition search`** in the _same_ `sample` state (§5), so the one `sample` deterministic state genuinely touches both the sampler/DB and the vector store. The gate asserts both (§12.3 #2 parent-id, #3 cognition match).

This is why `sample` runs **both** `evolve-db sample` and `evolve-cognition search` and merges them into one `current/context.json` — it is the round's single "read durable state" boundary.

### 4.3 How the sampled parent flows to the researcher

`evolve_result.py sample` writes `current/context.json`:

```json
{
  "step_name": "step_0002",
  "parent": { "id": 0, "code": "...", "score": 6.0, "analysis": "...", "name": "round-1" },
  "cognition": { "query": "<objective>", "matches": [{ "content": "...", "score": 0.71, "source": "user" }] }
}
```

- `step_name` is allocated by the `sample` bridge itself: it reads `database_data/nodes.json` to get `done_rounds` (0 if absent) and writes `step_name = step_{done_rounds+1:04d}` into `current/context.json` (and a sibling `current/step_name` file the per-round flags read). With no `round_gate` in the hub graph, `sample` is the deterministic state that allocates the step id — it is the first thing the orchestrator's `design` dispatch runs each round, so the step id is derived from durable state at the same boundary that reads it.
- `parent` is the first node from `evolve-db sample` (or `null` on round 1 when the DB is empty — greedy returns `[]`).
- `cognition.matches` is the `evolve-cognition search` result (§5).

The researcher reads this file (its prompt instructs it to), and `analysis_record` reads `parent.id` from it via `--parent-from-current` (§8.2). `current/` is an undeclared workspace subtree (never `.vN`-snapshotted), overwritten each round — exactly the parent design's `current/` bundle, minus declared-artifact surfacing (deferred, §15).

---

## 5. Cognition

### 5.1 Seed at preflight

`preflight` (agent) writes `cognition_seed.md` with one or more ```json fenced blocks of reusable heuristics (the engine's `extract_seed_items`parses exactly these blocks,`cli.py:79-95`), then runs:

```
/opt/workflow-venv/bin/python /workflow-scripts/evolve-cognition init \
  --run-dir /workspace/.evolve_runs/main \
  --seed-file /workspace/.evolve_runs/main/cognition_seed.md
```

`cmd_cognition_init` (`cli.py:342`): builds the `Cognition` store (`cognition_data/`), extracts the seed items, `add_batch` — which embeds each item (`cognition.py:55` `embedding.encode`) and adds it to the vector store (`cognition_data/faiss/vector_store.pkl`). Run-spec sets `cognition.source_mode: seed` (any non-empty value satisfies the `cognition.source_mode` required-field check, `run_state.py:95-97`; slice 1 used `none` only because it skipped cognition). The seed file the engine `cmd_brief_normalize` initializes (`initialize_cognition_seed_file`, `run_state.py:249`) is a _template_; the preflight agent overwrites it with real heuristics.

This is the **author** step: `preflight` writes `cognition_seed.md` with the real heuristics. The **embedding** (`cognition init`) is deliberately _not_ run by `preflight` — it is moved into the **first entry of `sample`** (in-container), so the same seeding code path runs in a real run and in the mocked gate. See §5.3 for this seam — it is the canonical seeding mechanism for this slice (the `preflight` prompt authors the seed text; the in-container `sample` does the `cognition init`, the load-bearing guarantee that cognition is seeded before any retrieval).

### 5.2 Retrieve into the researcher

In the `sample` state (§4), `evolve_result.py sample` also runs:

```
/opt/workflow-venv/bin/python /workflow-scripts/evolve-cognition search \
  --run-dir /workspace/.evolve_runs/main \
  --query "<objective from run_spec.yaml>" \
  --top-k 5
```

`cmd_cognition_search` (`cli.py:392`): builds `Cognition`, `cognition.retrieve(query, top_k)` → embeds the query (`cognition.py:73`) and `faiss.search`es the vector store, returning `{ "matches": [ { content, metadata, score, source } ] }`. With `--query-from-spec`, the bridge reads `objective` from `run_spec.yaml` as the query (a stable, deterministic query). The matches are merged into `current/context.json` (§4.3) for the researcher.

> **Determinism implication (this is why §9 matters here).** `cognition.retrieve` embeds the query with `EmbeddingService` and scores it against the seeded item vectors — **both** sides go through `embedding.py:72 hash(token)`. Without `PYTHONHASHSEED` pinned, the query vector and the stored item vectors are computed with _different_ per-process hash seeds across runs, so the same query returns different (or differently-ordered) matches run-to-run, and `vector_store.pkl` differs byte-for-byte. The §9 fix (pin the seed in the subprocess env) makes cognition retrieval reproducible, which is what the §12 determinism assertion checks.

### 5.3 Gate-compatible seeding seam (decided)

Seeding cognition must run **in-container** (the host has no venv; `embedding.encode` needs numpy). In a real run, `preflight` (agent, in-container) _could_ run `cognition init` directly. In the **gate**, `preflight` is mocked on the host and cannot exec in-container. To make seeding identical in both, the embedding is moved into the deterministic `sample` state:

- The **`sample` bridge seeds cognition on its first entry** (when the cognition store is empty), by calling `evolve-cognition init --seed-file <cognition_seed.md>` before running `evolve-db sample`/`evolve-cognition search`. This runs in-container (venv + numpy), so it works identically in a real run and in the mocked gate. The mock `preflight` only has to write `cognition_seed.md` (a plain text file, trivially host-writable); the in-container `sample` does the embedding.
- This keeps the seed _source_ author-controlled (preflight writes the heuristics) while moving the _embedding_ into the container where it must run. It also means cognition is guaranteed seeded **before** the same state's first `evolve-cognition search`, since seeding is the first step of `sample`'s first entry and `sample` precedes the first researcher.

`evolve_result.py sample` therefore: (1) if cognition empty, run `evolve-cognition init`; (2) run `evolve-db sample` + `evolve-cognition search`; (3) write `current/context.json` and the result file. The bridge keys "cognition empty" on the absence/emptiness of `cognition_data/cognition.json`.

**The seed must overlap the objective query, so the match set is never empty (should-fix from review).** `build_cognition` uses `score_threshold=0.0` (`cli.py:76`), and the Tier-0 hash-token fallback can produce **negative** dot products — so a query that shares no salient tokens with any seeded item can return an _empty_ `matches` list even though the store is non-empty. To keep retrieval from flaking, the seed-text contract (enforced by the `preflight` prompt, and by the gate's hand-authored seed in §12) is that **the cognition seed shares salient tokens with the objective query** (`--query-from-spec` uses the run-spec `objective` verbatim). The **primary** retrieval witness is therefore "`cognition_data/cognition.json` has ≥1 seeded item" (a deterministic property of the in-container `cognition init`), and a non-empty `cognition.matches` is asserted as a _best-effort_ secondary witness on the final round — see §12.3 #4.

---

## 6. Analyzer (agent)

### 6.1 Inputs

`analyzer` reads `current/context.json` (sampled parent + retrieved cognition for the round), `current/result.json` (the evaluator score for this round), and the round's candidate at `steps/<step_name>/code`. It is a fresh `persona: global` agent session (no continuation) — durable learning comes from the artifacts, per the parent design.

### 6.2 What lesson it writes

A short transferable markdown lesson (`current/analysis.md`): what worked, what failed, and a reusable heuristic for a future round. The prompt forbids restating the score (that's already in the node) — it captures the _insight_, which is exactly the field the engine's `Node.analysis` is for (`structures.py:20`) and which `node.get_context_text()` feeds into the node's embedding (`structures.py:61-66` — `name + motivation + analysis`). So a non-empty analysis also enriches the node's vector, improving later cognition/context quality.

### 6.3 How it's persisted onto the node — the single-record-per-round contract (decided)

The engine attaches analysis to a node via `evolve-db record --analysis-file <path>` (`cli.py:448-456` reads the file into `node.analysis` and writes `steps/<step>/analysis.md`). `evolve-db record` is **not idempotent by step name** — every call allocates a fresh `next_id` (`database.py:73-74`) — so the round must call it **exactly once**, or the node count doubles and the "exactly N nodes" gate breaks.

**Decision: record each round exactly once, after analysis, in `analysis_record`.** The orchestrator routes `design → sample → researcher`, then `evaluate`, then `analyze`, then `record → analysis_record`; the **engine `add_with_previous_nodes` is called once per round, only in `analysis_record`**. There is no separate `record_node` durable write in this graph:

- The slice-1 evaluation→commit _validation_ (confirm a numeric score, ensure the staged candidate exists) is absorbed into the **orchestrator's** phase logic: it reads `current/result.json` to decide whether to route `analyze` (a numeric score is present) or `escalate`/let the deterministic `evaluator_blocked → failed` edge fire. No state re-runs `evolve-db record` before analysis.
- `analysis_record` performs the **single** durable `evolve-db record --analysis-file current/analysis.md --parent <parent.id> --results-file <step>/results.json --step-name <step>` via the bridge's `attach_analysis` subcommand — the one call that allocates the node id, embeds `name+motivation+analysis`, updates the vector store, and updates `best/`. Its verdict (`recorded`/`needs_repair`) returns the loop to `orchestrator` (or to `failed`).

This yields **exactly one node per round, carrying its analysis, with the sampled parent attached** — satisfying gate items §1.2 (parent), §1.4 (analysis), §1.1 (N nodes). The alternative (record twice, then a dedupe/idempotency guard) requires either an engine fork or a `nodes.json` post-edit, both rejected per "package, don't fork." Recording once after analysis is the minimal faithful path. (Record-by-step-id idempotency remains the proper long-term fix; deferred §15.)

> **Why not record at evaluate-time and re-record after analysis?** Because the analyzer runs _after_ evaluation and its lesson must be on the node. Recording before analysis then re-recording duplicates; recording only after analysis is the single clean write. The slice-1 `record` subcommand (which _does_ write the DB) is preserved unchanged for backward compatibility — the new `attach_analysis` path is the multi-round single-write — so the existing `record`-writes-DB test stays green (§13, should-fix #1).

---

## 7. Researcher changes from slice 1

Slice 1's researcher wrote a candidate from the objective alone to a fixed `step_0001/code`. This slice's researcher (§3.3 prompt):

- Reads `current/context.json` for the **sampled parent** (id, code, score, prior analysis) and the **retrieved cognition** matches.
- **Evolves** from the parent when present: improve the parent's code guided by the cognition hints. The prompt permits diff-style reasoning (SEARCH/REPLACE against the parent) but **always emits the complete resulting file** — diff _application_ is not delegated to a helper in this slice (the engine's `files diff` exists but candidate materialization stays full-file, matching slice 1 and the parent design's "final materialized code should always be a complete candidate file"). Full diff-apply via `evolve-files` is deferred (§15).
- Writes to the **per-round** step path `steps/<step_name>/code` (step name read from context), not a fixed `step_0001`.

In the gate, `researcher` is mocked to write a per-round candidate that improves on the parent (§12.2) so the best score is non-decreasing and the parent-id linkage is observable.

---

## 8. evaluate / record deltas

`evaluate` reuses the slice-1 bridge logic almost verbatim; the durable record moves to a new `attach_analysis` subcommand. The deltas are:

### 8.1 evaluate

Identical to slice 1 (`cli.py:243 cmd_eval_run`, runs the configured evaluator, backfills on non-zero, keys verdict on engine `return_code` + numeric `eval_score`). The only change: the step name and code path come from `current/` (the per-round step) via the new `--step-from-current`/`--code-from-current` flags (§13) instead of hard-coded `step_0001`. Verdicts unchanged: `evaluated`/`evaluator_blocked`/`result_file_error`. The result file moves to the per-round-overwritten `current/result.json` (so the orchestrator, analyzer, and `analysis_record` read this round's score).

### 8.2 record: legacy `record` retained, single durable write via `attach_analysis`

There are **two** record code paths in the bridge, gated by which flags are present (should-fix #1 from review):

- **Legacy `record` (slice-1 path, DB-writing, untouched).** The slice-1 `record` subcommand invoked with `--step-name`/`--name`/`--code-path`/`--results-file` still calls `evolve-db record` and writes the DB exactly as before. This keeps the existing unit test green — `test/workflow/evolve-result-bridge.test.ts:216-259` invokes `record` with those flags and asserts `verdict: recorded, node_id: 0, best_updated: true` (i.e. the DB was written). That invocation is **not** changed by this slice.
- **New `attach_analysis` (the multi-round single durable write).** The hub's `analysis_record` state runs `evolve_result.py attach_analysis`, which is the **one** `evolve-db record --analysis-file --parent` per round. It uses the `--*-from-current` flags (the new `--step-from-current`-style sugar): the bridge reads `current/step_name`/`current/context.json` to derive `<step_name>`, `--name round-K`, and `parent.id`, and constructs the `steps/<step_name>/code` and `steps/<step_name>/results.json` paths (the `results.json` lives in the step dir, written by `evaluate`, not in `current/`). The stage-only (no-DB) validation behavior that the review discussed is **not** how this graph works — there is no second record call to suppress (§6.3); the only `evolve-db record` per round is `attach_analysis`. The legacy slice-1 `record` DB-writing path is preserved solely for the untouched test; the multi-round graph never invokes it.

The durable `evolve-db record` `attach_analysis` runs is:

```
/opt/workflow-venv/bin/python /workflow-scripts/evolve-db record \
  --run-dir /workspace/.evolve_runs/main \
  --step-name <step_name from current> \
  --name <round-K from current/step_name> \
  --parent <parent.id from current/context.json>  # omitted when parent is null (round 1) \
  --code-path .evolve_runs/main/steps/<step_name>/code \
  --results-file .evolve_runs/main/steps/<step_name>/results.json \
  --analysis-file .evolve_runs/main/current/analysis.md
```

`cmd_db_record` (`cli.py:417`): the `--parent` flag (already in the parser, `cli.py:694`) sets `Node.parent = [parent.id]` (`cli.py:462-464`), so the gate can read `nodes[K].parent == [K-1's id]` to prove sampling-driven lineage. `--analysis-file` sets `node.analysis` and writes `steps/<step>/analysis.md` (`cli.py:448-456`). `snapshot.init_from_nodes(previous_nodes)` (`cli.py:473`, seeded from all prior committed nodes) then `update_if_better` (`best_snapshot.py:28-39`) makes `best/` non-decreasing across rounds — the engine already gives us the §1.5 monotonicity for free. `best/<step_name>/` and `nodes.json` are the durable outputs the gate inspects.

---

## 9. Determinism items (REQUIRED)

Both items are raised against the **vendored** engine, which we keep **byte-verbatim** (no fork). The fixes live in the **IronCurtain-authored bridge** (`evolve_result.py`) and in the test/comparison layer.

### 9.1 Item 1 — `embedding.py` process-randomized `hash()` → fix via `PYTHONHASHSEED=0` in the bridge subprocess env (decided, concrete)

**Root cause.** `embedding.py:72` (`hashed = hash(token)`) uses Python's built-in `hash()`, which for `str` is randomized per process via `PYTHONHASHSEED` (default `random`). The fallback hash-token embedding (active in Tier 0 — no sentence-transformers) therefore produces **different vectors every run**, so `database_data/faiss/vector_store.pkl` and `cognition_data/faiss/vector_store.pkl` are non-reproducible, and cognition retrieval (`§5.2`) returns run-dependent matches. This directly undermines the vector store the new sampling/cognition retrieval depends on.

**Where the embedding actually runs.** Every embedding computation happens **inside a subprocess the bridge spawns** — never in the bridge process itself:

- record path: `evolve_result.py attach_analysis` → `subprocess.run([..., evolve-db, "record", ...])` → `cmd_db_record` → `db.add_with_previous_nodes` → `embedding.encode` (`database.py:81`).
- sample/cognition path: `evolve_result.py sample` → `subprocess.run([..., evolve-cognition, "search", ...])` → `cmd_cognition_search` → `cognition.retrieve` → `embedding.encode` (`cognition.py:73`); and `evolve-cognition init` → `add_batch` → `embedding.encode` (`cognition.py:55`).

**The fix (no engine edit).** The bridge's single subprocess entry point `_run_helper` (`evolve_result.py:35`) passes an explicit `env=` with the hash seed pinned:

```python
import os

_DETERMINISTIC_ENV = {**os.environ, "PYTHONHASHSEED": "0"}

def _run_helper(argv: list[str]) -> tuple[int, dict | None, str]:
    completed = subprocess.run(
        argv, capture_output=True, text=True, env=_DETERMINISTIC_ENV
    )
    ...
```

Because `PYTHONHASHSEED` is read by the interpreter **at startup**, it must be in the _child_ process's environment — setting it inside the already-running child is too late, which is exactly why it goes in the `subprocess.run(env=...)` of the **parent bridge**, not in the engine. Every engine wrapper the bridge invokes (`evolve-eval`, `evolve-db`, `evolve-cognition`) is launched through `_run_helper`, so all of them inherit the pinned seed; `str.__hash__` (and thus `embedding.py`'s token hashing) is then deterministic. `os.environ` is copied (not mutated) so the bridge's own env is untouched. This is the entirety of item 1 — one env dict, applied at the one subprocess seam.

> **Confirm the embedding is in those subprocesses, not the bridge.** Verified above: the bridge never imports `embedding`/`Database`/`Cognition`; it only spawns the wrappers. So pinning the seed on the spawn is both necessary and sufficient. (If a future refactor moved engine calls in-process into the bridge, the bridge module itself would need `PYTHONHASHSEED` set before interpreter start, e.g. via the state's invocation env — out of scope; the current architecture keeps everything in subprocesses.)

### 9.2 Item 2 — `structures.py created_at = datetime.now()` → cosmetic; normalize in comparisons; upstream a caller-injectable field for true reproducibility (decided)

**Root cause.** `structures.py:26-28` sets `created_at = datetime.now().isoformat()` in `Node.__post_init__` when not provided. It is **not** settable via any CLI flag (`cmd_db_record` never passes `created_at`, `cli.py:462-471`), so it cannot be fixed via env. (`run_state.py:321-323 append_round_log` and `final_summary` also stamp `datetime.now()`, but those land in `round_log.jsonl` / summaries, not in `nodes.json` scoring/sampling.)

**Disposition (decided).**

1. **It is cosmetic for sampling/scoring.** Nothing in the sampler (`greedy`/`ucb1`/`island`), the score, the vector store, the parent linkage, or `best/` reads `created_at` — confirmed: `database.py`/the samplers key on `score`/`visit_count`/`id` only; `created_at` is carried in `to_dict`/`from_dict` purely for the record. So it does **not** affect any gate assertion except a _byte-identical `nodes.json`_ check.
2. **Normalize where outputs are compared.** The §12 determinism assertion compares two runs' `nodes.json` **after stripping `created_at`** from every node (a one-line `delete node.created_at` over `Object.values(parsed.nodes)` in the test). The **vector store** (`vector_store.pkl`) is compared byte-for-byte _as-is_, because it contains no timestamp — it is pure float vectors keyed by node id (`vector_index.py:106-132` `save` → `pickle.dump`), so it is the stronger, timestamp-free reproducibility witness. The test therefore gets a clean byte-equality check on the embeddings without needing `created_at` at all.
3. **If true `nodes.json` reproducibility is later wanted, upstream — do not fork.** The right path is to add a `--created-at` flag to `evolve-db record` and a `created_at` parameter to `Node`/`add_with_previous_nodes` **in ASI-Evolve upstream**, then re-vendor the engine byte-verbatim. A local edit to `structures.py`/`cli.py` would be a fork (it diverges the vendored copy and breaks "re-vendor cleanly"), which the parent design explicitly rejects. This slice does **not** need it — the vector-store byte check plus the `created_at`-stripped `nodes.json` check fully cover the determinism gate — so the upstream change is recorded as the recommended path (§15) rather than done here.

**Net:** item 1 is fixed concretely in the bridge; item 2 is accepted as cosmetic with comparison-time normalization, and the only "true reproducibility of `nodes.json`" path is an upstream-and-re-vendor, explicitly not a local fork.

### 9.3 How both are tested (must verify the fix, not just its wiring)

- **Focused unit test (PYTHONHASHSEED), no Docker** (`evolve-result-bridge.test.ts` extension): run `evolve_result.py` with a stub engine wrapper that **prints `hash("evolve")`** to stdout (or computes the Tier-0 fallback embedding of a fixed string and prints the vector). Invoke the bridge **twice**; assert the printed hash/vector is **identical** across the two invocations — proving the bridge's `env=PYTHONHASHSEED=0` reached the child. A control invocation that bypasses `_run_helper` (or sets `PYTHONHASHSEED=random`) demonstrates the value _would_ differ without the fix, so the test fails if the env line is removed. This is a direct check on the seeded-hash path, not an assertion that the line exists.
- **End-to-end determinism (Docker gate, §12.3 #6):** run the same N-round task **twice** in two fresh workspaces; assert `database_data/faiss/vector_store.pkl` is **byte-identical** between the two runs (the embeddings/vector store are reproducible), and `nodes.json` is identical after stripping `created_at`. This proves the seed fix holds through the real in-container record/sample/cognition paths, end to end.

---

## 10. Round budget / termination

### 10.1 run_spec fields (already in the schema)

`budget.max_rounds` (= N) and `budget.patience` are existing required fields (`run_state.py:74-76`), set by `preflight` (`--max-rounds N --patience P`). `stop_conditions: ["max_rounds"]` is the declared stop condition. No schema change.

### 10.2 The termination decision (orchestrator) + the deterministic backstop

The loop has two terminators, by design (§3.6):

1. **Primary — the orchestrator's `complete` verdict.** On each hub entry the orchestrator reads:
   - `done_rounds` = number of committed nodes (`len(nodes.json["nodes"])`, 0 if absent).
   - `max_rounds`, `patience` from `run_spec.yaml` (`budget.max_rounds`, `budget.patience`).
     It emits `complete → done` once `done_rounds >= max_rounds`. (Patience is available to the orchestrator via `evolve-db best`/`stats`: if `patience > 0` and the best score has not improved across the last `patience` recorded nodes, it may also emit `complete` early. v1 keeps this advisory — the round-budget cap is the terminator the gate exercises.) `escalate → failed` is the orchestrator's unrecoverable exit.
2. **Backstop — the `isRoundLimitReached` guard.** `settings.maxRounds` + the orchestrator's first transition `guard: isRoundLimitReached → failed` deterministically terminates a wedged hub that never emits `complete` (§3.6). This is the WF006 no-wedge requirement.

There is no separate "success" terminal — reaching the budget _is_ completion for v1 (the parent's `complete → final_summary` collapses to `complete → done`, since `final_summary`/`final_review` are deferred). Deterministic spoke hard-failures (`evaluator_blocked`, `sample_error`, `needs_repair`, `result_file_error`) and the unguarded fallthrough route to `failed`.

### 10.3 Loop bound is durable for logic, FSM-visit-based only for the safety backstop

The **loop logic** is durable: the orchestrator derives `done_rounds` from committed `nodes.json`, so the loop is bounded across resume and even if a round re-enters (the re-entered round overwrites `current/` and re-commits at the next id). The **safety backstop** is FSM-visit-based (`isRoundLimitReached` reads `context.visitCounts`, which reset on a fresh actor — but the durable node count is what governs the normal exit, so a resumed run that has already done its rounds emits `complete` on its first hub entry regardless of the reset visit counters). Agent `maxVisits` on `researcher`/`analyzer` (`machine-builder.ts:361-362`) caps within-round agent retries; it does not bound the round loop — that is the orchestrator's `complete` (logic) plus `isRoundLimitReached` (safety).

---

## 11. `preflight_review` human gate — DEFERRED (maintainer-signed 2026-06-16)

**Decision (signed off, not open): defer `preflight_review` (and `human_escalation`) for this slice; keep `failed` terminals.** The maintainer signed off on 2026-06-16 to keep the human gate out of the multi-round slice and ship it with the dedicated human-surface slice (§15 #3, §16 #2). This is settled, not a re-opened question.

What enforces approval in the absence of the gate:

- `preflight` sets `approval.confirmed=true` in `run_spec.yaml`, and the **engine enforces approval at the helper layer** regardless of FSM topology: `require_evolve_ready` (`run_state.py:288`) is called by `cmd_eval_run`/`cmd_db_record`/`cmd_db_sample`/`cmd_cognition_*`, so every mutating/evaluator/record helper rejects an unapproved run. The machine-readable approval check is the real guard; the human gate is a UI/process surface on top of it.
- The parent design requires "explicit human approval before running the first evaluator" (`asi-evolve-native-workflow.md:945`). The signed-off position is that the helper-layer `require_evolve_ready` satisfies the _enforcement_ half now, and the _human-in-the-loop UI_ half (the `preflight_review` gate + its auto-approve test plumbing) lands with `human_escalation`/`final_summary`/`final_review` in the human-surface slice — where the gate-approval test pattern (`test-helpers.ts waitForGate`/`waitForGateOrCompletion`, poll `phase: waiting_human` → inject `APPROVE` → resume) is the point and is worth its flake budget.

Rationale for bundling rather than adding one gate here: re-including a single human gate now would add gate-timing flakiness to the §12 gate without exercising any of this slice's new content (orchestrator hub, sampling, cognition, analyzer, determinism). The FSM is a strict subgraph of the parent's either way — adding `preflight_review` later between `preflight` and `orchestrator` (`event: APPROVE → orchestrator`, `event: ABORT → failed`) is a clean superset edit.

This is recorded as a signed-off decision in §16 #2.

---

## 12. End-to-end validation gate (REQUIRED — front and center)

`test/workflow/evolve-multi-round.integration.test.ts`, gated `describe.skipIf(!dockerReady)` with the **same** `dockerReady` guard as slice 1 (`INTEGRATION_TEST === '1' && isDockerAvailable() && isDockerImageAvailable('ironcurtain-claude-code:latest') && hostCaDir !== null`). Modeled line-for-line on `evolve-single-round.integration.test.ts`: same `TEST_HOME`/CA staging, `buildDockerSessionConfig`, `createInfra`/`destroyInfra` real bundles, `createDeps`, `onEvent` state collection, `waitForCompletion`. The shared container, per-workflow image (`numpy`+`pyyaml`), and verdict routing are unchanged.

### 12.1 Task

A program-search task where the candidate can **improve across rounds**: **"write `solve(xs)` scoring higher the closer `solve([1,2,3])` is to 6; evaluator writes `eval_score`."** The evaluator (set by the mock `preflight` run-spec, reused from slice 1's `writePreflightRunSpec`) computes a score that increases as the candidate improves. Concretely the evaluator scores `eval_score = 6 - abs(solve([1,2,3]) - 6)` clamped at 0, so a worse parent → better child raises the score round over round.

### 12.2 Agent sessions are mocked (`createSession`) — the hub needs a scripted verdict sequence

This is **materially more complex than slice 1**, and the design is honest about that: the orchestrator hub is an _agent_ state invoked many times per run, so the mock can no longer key purely off a session counter (slice-1 `evolve-single-round.integration.test.ts:226`). It must (a) tell the four agent roles apart, and (b) feed the orchestrator a **scripted verdict sequence** that advances the loop. Two facts make this clean:

- **The mock can identify the role from the turn prompt.** The orchestrator sends each state's prompt to the session via `session.sendMessage(command)` where `command = buildAgentCommand(stateId, stateConfig, …)` (`orchestrator.ts:1894`, `prompt-builder.ts`). The mock's `MockSession.sendMessage(msg)` therefore _sees the state prompt text_ and routes on a stable substring: `"You are the Evolve orchestrator"` (orchestrator), `"configuring a multi-round Evolve experiment"` (preflight), `"Write exactly one candidate program"` (researcher), `"write a SHORT transferable lesson"` (analyzer). No `SessionOptions` state id is needed.
- **The orchestrator's verdict is the only scripted output.** preflight/researcher/analyzer write files and return an informational/`ready` block; only the orchestrator's verdict drives routing, so only it needs a script.

The mock keeps **one orchestrator-invocation counter** `oc` (incremented each time the orchestrator role is detected) and emits this exact verdict script for N = 3 (the per-round cycle is `design → evaluate → analyze → record`, repeated N times, then `complete`):

| `oc` | verdict    | routes to                     |
| ---- | ---------- | ----------------------------- |
| 1    | `design`   | sample → researcher (round 1) |
| 2    | `evaluate` | evaluate (round 1)            |
| 3    | `analyze`  | analyzer (round 1)            |
| 4    | `record`   | analysis_record (round 1)     |
| 5    | `design`   | sample → researcher (round 2) |
| 6    | `evaluate` | evaluate (round 2)            |
| 7    | `analyze`  | analyzer (round 2)            |
| 8    | `record`   | analysis_record (round 2)     |
| 9    | `design`   | sample → researcher (round 3) |
| 10   | `evaluate` | evaluate (round 3)            |
| 11   | `analyze`  | analyzer (round 3)            |
| 12   | `record`   | analysis_record (round 3)     |
| 13   | `complete` | done                          |

i.e. the script is `[design, evaluate, analyze, record] × N` followed by `complete` — `4N+1` orchestrator turns (13 at N=3). The mock returns `statusBlock(verdict, …)` for the orchestrator (its edges are all `when:{verdict}` over `{design,evaluate,analyze,record,complete,escalate}`, so the verdict must be one of those — an invalid verdict re-prompts, `validate.ts:402-403`).

The other roles (called between the orchestrator turns) do their slice-1-style side effects and return informational blocks:

- **preflight** (1×, the very first agent turn) — write the hand-authored `run_spec.yaml` (`max_rounds: 3`, `sampling.algorithm: greedy`, `sample_n: 1`, `cognition.source_mode: seed`, `approval.confirmed: true`, plus the **multi-round improving evaluator command** — _not_ slice-1's one-shot `==6` evaluator) and `cognition_seed.md` (one ```json heuristic block whose `content`shares salient tokens with the objective query, §5.3 should-fix). Return`statusBlock('ready', 'preflight confirmed')`(NOT`approvedResponse()`—`preflight`'s edges are `when:{verdict}`over`{ready,blocked}`, slice-1 §11.2). Cognition embedding is **not** run here — `sample`'s first entry does it in-container (§5.3); the mock only writes the seed text.
- **researcher** (N×) — read `current/context.json`, write an improving candidate to `steps/<step_name>/code` (a per-round candidate that moves `solve([1,2,3])` closer to 6 than the sampled parent). Its edge is unconditional → `approvedResponse()`.
- **analyzer** (N×) — write `current/analysis.md` (a known non-empty lesson). Its edge is unconditional → `approvedResponse()`.

The mock asserts the orchestrator was invoked **exactly `4N+1` times** and preflight/researcher/analyzer **exactly `1`/`N`/`N`** — a different count signals a desynced hub. Because the researcher derives `<step_name>` and the parent from `current/context.json` (written by `sample`), the candidate it writes genuinely _responds_ to the sampled parent, making the parent-id linkage and the monotonic-score assertions real, not staged. (Per-orchestrator-turn scripting is the deliberate cost of choosing the hub over a deterministic controller; the role-from-prompt routing keeps it robust to interleaving.)

### 12.3 Completion gate (binary), N = 3

Positive case runs `orchestrator.start(<evolve manifest>, <task>, workspaceDir)`, `waitForCompletion`, then asserts ALL of:

1. **Terminal `done`** — `states.at(-1) === 'done'`, `states` excludes `'failed'`. `orchestrator` appears **`4N+1` (= 13)** times in `states`; `sample`/`evaluate`/`analyzer`/`analysis_record` each appear **3 times**; `researcher` appears **3 times**.
2. **Exactly N nodes** — `database_data/nodes.json` `next_id === 3`, `Object.keys(nodes).length === 3`.
3. **Sampling read the DB (parent linkage)** — `nodes["1"].parent` and `nodes["2"].parent` are **non-empty and reference a prior id** (e.g. `nodes["1"].parent === [0]` under greedy single-parent). `nodes["0"].parent === []` (round 1, empty DB). This proves `evolve-db sample` ranked committed nodes and the round wired the greedy parent through `attach_analysis`'s `--parent`.
4. **Cognition was retrieved** — the **primary** witness is deterministic: assert `cognition_data/cognition.json` has **≥1 seeded item** (the in-container `cognition init` on `sample`'s first entry ran). As a **best-effort secondary** witness, assert the **final** `current/context.json` (round 3) carries a non-empty `cognition.matches` (vector search hit the seed) — this holds when the seed shares salient tokens with the objective query (§5.3), but the empty-match edge case (`score_threshold=0.0`, negative dot products) is tolerated by treating only the ≥1-seeded-item check as load-bearing. `current/` is overwritten each round, so the gate captures the round-3 `context.json` via a `state_entered`-hooked copy or reads it after completion before any further write.
5. **Every node carries an analysis/lesson** — `nodes["0"].analysis`, `nodes["1"].analysis`, `nodes["2"].analysis` are all non-empty (the analyzer's lesson, persisted by `analysis_record`).
6. **Best score non-decreasing** — `nodes` scores in id order (`nodes["0"].score ≤ nodes["1"].score ≤ nodes["2"].score`) are non-decreasing under the improving-candidate mock (the engine seeds `best_score` from all prior nodes via `init_from_nodes(previous_nodes)` before `update_if_better`, `cli.py:473`/`best_snapshot.py:24-39`, so `best/` only ever advances). The engine writes a `best/<step_name>/` dir **only for strictly-improving rounds** (`update_if_better` returns false on `node.score <= best_score`, `best_snapshot.py:35-36`; `cli.py:476-484` only copies on `best_updated`). The robust assertion is therefore node-score monotonicity plus `max(node scores) ===` the best `eval_score` across all present `best/*/results.json` (do not assume a `best/` dir exists for every step).
7. **Determinism** — run the **same** task a second time in a fresh workspace; assert `database_data/faiss/vector_store.pkl` is **byte-identical** to run 1's, and `nodes.json` (with `created_at` stripped) is identical (§9.2, §9.3).

### 12.4 Negative case (evaluator crash mid-loop)

A second test where the round-2 `researcher` mock writes a candidate with **no `solve` symbol** (slice-1 `crash` kind). The orchestrator script is shortened: it routes `design`(1), `evaluate`(2), then — because round 2's `evaluate` emits `evaluator_blocked → failed` deterministically — the run terminates before the orchestrator's round-2 `analyze`/`record` turns. Round 1 records normally (1 node). Assertions: `states.at(-1) === 'failed'`; `states` contains `'evaluate'` **twice** but only **one** `analysis_record` (round 1); `database_data/nodes.json` holds **exactly 1** node (round 1 only); the round-2 `current/result.json` verdict is `evaluator_blocked`. This mirrors slice-1 §11.4 and proves a mid-loop failure terminates cleanly without a partial extra node — the deterministic `evaluator_blocked → failed` edge fires without an orchestrator turn (§3.1 return contract).

### 12.5 Why this gate proves hub + sampling + cognition + analyzer + determinism together

- **N nodes + `4N+1` orchestrator turns + 3× each spoke** ⇒ the hub ran N rounds and terminated on its `complete` verdict at the budget (the orchestrator routing works, and the `isRoundLimitReached` backstop was never needed — proving the normal exit, not the safety net).
- **Parent ids referencing prior nodes** ⇒ `evolve-db sample` read the committed DB and the round consumed the result (sampling works, and the vector store was re-serialized each record).
- **≥1 seeded cognition item (+ best-effort matches)** ⇒ the vector store was embedded at seed time and searched at sample time (cognition retrieval works) — and is only stable run-to-run _because_ the seed fix holds.
- **Every node's `analysis` non-empty** ⇒ the analyzer agent ran each round and `analysis_record` persisted the lesson onto the engine node (analyzer works).
- **Byte-identical `vector_store.pkl` across two runs** ⇒ embeddings are reproducible (determinism item 1 works through the real in-container path).
- No single assertion passes in isolation: N nodes without parents wouldn't prove sampling; parents without a seeded cognition store wouldn't prove retrieval; a seeded store without byte-stability wouldn't prove the seed fix. They are inseparable.

### 12.6 Manual run

```
INTEGRATION_TEST=1 npm test -- test/workflow/evolve-multi-round.integration.test.ts
# lint the hub FSM (validates + lints; expect "No lint diagnostics"):
tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml
# or by hand (real agents — the orchestrator drives the rounds itself):
tsx src/cli.ts workflow start evolve "evolve solve(xs) toward solve([1,2,3])==6 over 3 rounds"
tsx src/cli.ts workflow inspect <baseDir>   # confirm final state = done, 3 nodes
```

---

## 13. File-by-file changes

| File                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/workflows/evolve/workflow.yaml`            | **Replace** the linear FSM with the hub-and-spoke FSM (§3.3): `preflight → orchestrator` (agent hub) with `sample`, `researcher`, `evaluate`, `analyzer`, `analysis_record` as spokes; add `settings.maxRounds: 24` + the orchestrator's `isRoundLimitReached` backstop; agent spokes return via `to: orchestrator`, deterministic spokes via their verdict; extend `preflight` (author cognition seed + `max_rounds`/`cognition.source_mode seed`); rewire `researcher`/`evaluate` to per-round `current/` paths.                                                                                                                                                                                                                                                                                    |
| `src/workflow/workflows/evolve/scripts/evolve_result.py` | **Extend** the bridge: (a) add `_DETERMINISTIC_ENV` + `env=` on `_run_helper` (§9.1, the determinism fix); (b) new subcommands `sample` (first-entry cognition seed + db sample + cognition search → `current/context.json`, allocate `current/step_name`, §4/§5) and `attach_analysis` (the single durable `evolve-db record --analysis-file --parent`, §6.3/§8.2); (c) add `--*-from-current` flags so `evaluate`/`attach_analysis` read the per-round step/code/parent from `current/` (§8). The existing slice-1 `evaluate` and `record` subcommands are **preserved unchanged** — `record` keeps its DB-writing path so the existing `record`-writes-DB test (`evolve-result-bridge.test.ts:216-259`) stays green (§8.2 / should-fix #1); the multi-round graph simply does not invoke `record`. |
| `src/workflow/workflows/evolve/scripts/evolve_core/**`   | **No change** (byte-verbatim). The `evolve-cognition` wrapper (already shipped) is now used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `test/workflow/evolve-multi-round.integration.test.ts`   | **NEW** gated real-Docker gate (§12): positive (terminal `done`, N nodes, parent linkage, ≥1 cognition item, per-node analyses, monotone best, byte-identical `vector_store.pkl`), negative (mid-loop crash → `failed`, 1 node). The mock routes the four agent roles by prompt substring and feeds the orchestrator a scripted verdict sequence (§12.2).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/workflow/evolve-result-bridge.test.ts`             | **Extend**: new unit cases for `sample` (first-entry seed; context.json shape with parent + cognition matches via stubbed `evolve-db`/`evolve-cognition`; step-name allocation from node count), `attach_analysis` (single record with `--analysis-file`/`--parent`, omits `--parent` when null), the per-current flag plumbing, and the **PYTHONHASHSEED determinism unit test** (§9.3). The existing `record`-writes-DB case is untouched (should-fix #1).                                                                                                                                                                                                                                                                                                                                          |

**Glue / existing-code touches (verify, expected zero):**

- `eslint.config.js` already ignores `src/workflow/workflows/*/scripts/` (PR #292 §10) — the extended Python won't break lint.
- No orchestrator/validate/machine-builder change — the hub uses only existing agent-state + `when:{verdict}` routing, the deterministic `container`/`resultFile`/`when:{verdict}` plumbing slice 1 consumes, and the long-standing `isRoundLimitReached` guard / `settings.maxRounds` (`guards.ts:21-26`, `lint.ts:289-307`).
- Discovery picks up the updated `evolve` automatically (`resolveWorkflowPath('evolve')`); no registry edit.
- `requirements.txt` (at `scripts/requirements.txt`) is unchanged (`numpy`+`pyyaml`); Tier 0 still suffices (cognition uses the same numpy hash-token embedding).

---

## 14. Unit test plan (no Docker)

1. **Manifest validates + lints clean** — extend the existing `evolve-result-bridge.test.ts` manifest block: the hub FSM validates (`validateDefinition`) and lints with **zero diagnostics** (no WF001/WF006/WF008/WF011/WF012), including under strict mode; every `container: true` state declares `resultFile`; the orchestrator carries the `isRoundLimitReached` guard and `settings.maxRounds` is set (WF006 satisfied). Assert the `preflight` prompt contains `--max-rounds`, `--cognition-source-mode seed`; assert the orchestrator state's transitions cover `{design,evaluate,analyze,record,complete,escalate}` plus the guard edge, and every agent spoke returns `to: orchestrator`.
2. **`sample` first-entry seed + context** — stub `evolve-db sample` returning `{nodes:[{id:0,score:6,...}]}` and `evolve-cognition search` returning `{matches:[{content:'h',score:0.7}]}`; assert `current/context.json` has `parent.id == 0`, non-empty `cognition.matches`, and a `step_name` allocated as `step_{node_count+1:04d}`. Empty-DB case: `evolve-db sample` returns `{nodes:[]}` → `parent` is `null`, `step_name == step_0001`, verdict still `sampled`. First-entry seeding: with an empty cognition store + a seed file, assert it invokes `evolve-cognition init` (stubbed) before `evolve-db sample`; with a non-empty store, it does **not** re-seed.
3. **`attach_analysis` single record** — stub `evolve-db record` returning `{node_id, best_updated}`; assert the bridge calls `evolve-db record` **exactly once** with `--analysis-file` and `--parent <id>` (and omits `--parent` when parent is null), and emits `recorded`; non-zero stub → `needs_repair`. (No stage-validation `record` call exists in the hub graph — the single-write contract is structural, §6.3.)
4. **Legacy `record` still writes the DB (should-fix #1)** — keep the existing `evolve-result-bridge.test.ts:216-259` case unchanged: `record --step-name … --code-path … --results-file …` returns `recorded`/`node_id`/`best_updated` from `evolve-db record`. This pins that the slice-1 DB-writing path is preserved.
5. **PYTHONHASHSEED determinism** — §9.3 focused unit: a stub wrapper prints `hash("evolve")` (or the Tier-0 fallback vector of a fixed string); two bridge invocations through `_run_helper` print identical values; a control without the env pin would differ. The test fails if the `env=` line is removed.
6. **Per-current flag plumbing** — assert `--step-from-current`/`--code-from-current`/`--parent-from-current`/`--name-from-current`/`--results-from-current` resolve the right paths/values from `current/step_name` + `current/context.json` (table-driven over a temp `current/`).
7. **Backstop wiring** — a pure-TS check that the orchestrator's first transition is `guard: isRoundLimitReached → failed` and `settings.maxRounds` is set, so a hub that never emits `complete` is deterministically bounded (WF006 + no-wedge, §3.6); and that `complete → done` is the only happy-path terminal edge.

These run under `npm test` (no `INTEGRATION_TEST`), like slice 1's bridge tests.

---

## 15. Deferred to later slices

1. **`ucb1` / `random` / `island` samplers** — need a deterministic seeding story (pin `random.seed` via run state, or pass a seed through the engine) before they can pass the determinism gate; `island` additionally needs feature-dimension/bin config and the `ast.literal_eval` state path verified.
2. **Orchestrator's richer parent-design verdicts** — `seed_initial` (materialize + baseline-evaluate an initial candidate) and the `complete → final_summary → final_review → done` happy-path tail; this slice collapses them to `complete → done`. The hub itself is built here (§3.1), so this is an incremental verdict/spoke addition, not a re-architecture.
3. **`preflight_review` + `human_escalation` + `final_summary` + `final_review` human surfaces** — the human-in-the-loop slice; auto-approve gates via `raiseGate`/`APPROVE` (§11, §16 #2). `human_escalation` replaces the orchestrator's current `escalate → failed`.
4. **Record-by-step-id idempotency** — make `evolve-db record` resume-safe so the record/analysis ordering can be relaxed and a crashed-then-resumed round can't double-commit (currently mitigated by the single-write-after-analysis contract, §6.3).
5. **Caller-injectable `created_at`** — upstream a `--created-at` flag to ASI-Evolve and re-vendor, for byte-identical `nodes.json` reproducibility (§9.2). Not a local fork.
6. **FAISS / sentence-transformers (Tier 1)** — real embedding stack; raises retrieval quality; the build-hash already rebuilds on `requirements.txt` change.
7. **Diff-apply researcher mode** — delegate exact SEARCH/REPLACE application + candidate hashing to `evolve-files` rather than full-file emit (§7).
8. **Declared `.workflow/` UI artifacts** — surface `current/context.json`, `round_log.jsonl`, and a round table in the web UI; the engine-native `.evolve_runs/` layout (slice-1 decision) means these need a copy-step or path shim.
9. **Multi-file candidates, parallel workers** — parent-design non-goals for v1.

---

## 16. Maintainer decisions (signed off) + remaining open item

**Signed off (2026-06-16):**

1. **Loop mechanism — the `orchestrator` agent hub (§3.1, §3.6).** _Decided: build the parent-design hub_, not a deterministic round controller. The loop is driven by the `orchestrator` agent emitting `design`/`evaluate`/`analyze`/`record`/`complete`/`escalate`, with every specialist returning to the hub and a deterministic `isRoundLimitReached` backstop (WF006) bounding a wedged agent. This makes the slice parent-design-faithful from the first multi-round implementation. (Cost accepted: the §12 gate's mock must feed the orchestrator a scripted verdict sequence — spelled out in §12.2.)
2. **`preflight_review` — deferred (§11).** _Decided: keep the human gate out of this slice_ and ship it with the dedicated human-surface slice (`human_escalation`/`final_summary`/`final_review`). Enforcement is preserved at the helper layer (`require_evolve_ready`, `run_state.py:288`); `preflight` sets `approval.confirmed=true`. This is settled — not a re-opened question.

**Still open (genuinely):**

3. **Sampler choice — `greedy` for v1 (§4.1).** _Recommendation: greedy_ (deterministic, satisfies the parent-linkage gate, no island setup). `ucb1`/`random` are non-deterministic and deferred behind a seeding story (§15 #1). **Decision needed: is greedy-only acceptable for the first multi-round slice, or must `ucb1` ship now (requiring a seed-injection mechanism)?**

Lower-confidence sub-decisions flagged inline (chosen, not blocking): the **single-record-after-analysis** contract (§6.3) — chosen over record-twice-plus-dedupe because the engine isn't step-idempotent and we won't fork it; revisit when idempotency lands (§15 #4). And the **`sample` first-entry cognition seeding** seam (§5.3) — chosen so seeding runs in-container and works identically in the mocked gate; a dedicated `cognition_seed` deterministic state would be cleaner but adds a state for one first-round action.
