# Evolve Native Workflow — First Vertical Slice (single round, end to end)

Status: **Implemented & merged in #300 (2026-06-16).** The single-round end-to-end slice shipped as designed — linear `preflight → researcher → evaluate → record_node → done/failed`, the packaged `evolve_core` engine, the `evolve_result.py` bridge (`evaluate`/`record`), `numpy`+`pyyaml` per-workflow image, and the gated real-Docker integration test. The sections below are the as-shipped record; both §15 maintainer decisions are resolved as implemented (engine-native `.evolve_runs/` layout shipped; `preflight_review` deferred here landed later in #303).
Audience: IronCurtain workflow engineer implementing the first `evolve` workflow package
Implementation contract: this document is meant to be implemented with **no further design input**. It names exact files, the full `workflow.yaml`, the `evolve_core` CLI argv each state runs, the engine-output→result-contract bridge, the package layout, and the binary end-to-end gate.

Predecessors (merged, build ON — do not redesign):

- **Containerized deterministic execution + script packaging** — `docs/designs/deterministic-in-container-execution.md` (PR #292). Gives us: `container: true` / `containerScope` on deterministic states (`src/workflow/validate.ts:79`, `src/workflow/types.ts:256`), `scripts/` staged read-only at `/workflow-scripts` (`src/docker/agent-adapter.ts:22`, `CONTAINER_SCRIPTS_DIR`), per-workflow image baked from `requirements.txt` at build time (`ensureWorkflowImage`, `src/docker/docker-infrastructure.ts:1352`), `--network=none` runtime, `/workspace` RW bind mount (`CONTAINER_WORKSPACE_DIR`, `src/docker/agent-adapter.ts:19`), and `--workdir /workspace` exec (`DockerManager.exec`, `src/docker/docker-manager.ts:264`).
- **Structured deterministic result contract** — `docs/designs/deterministic-result-contract.md`. Gives us: `resultFile: <ws-relative path>` on deterministic states, `when: { verdict: ... }` routing on deterministic states, the `{ verdict, payload?, passed? }` `result.json` schema, the reserved `result_file_error` verdict (`DETERMINISTIC_RESULT_ERROR_VERDICT`, `src/workflow/types.ts`), container-only enforcement, and `applyResultFile` reading the file back from `instance.workspacePath`.

Parent design: `docs/designs/asi-evolve-native-workflow.md` — the full FSM, state responsibilities, `.workflow/` domain layout, and `evolve_core` reuse. **This slice implements the smallest non-trivial subset of that design.**

Engine packaged: `donotcommit/ASI-Evolve/skills/evolve/scripts/` — the `evolve_core/` engine (`cli.py:740` `main_for(entrypoint, argv)`) plus the `evolve-eval` / `evolve-db` / `evolve-brief` / `evolve-summary` / `evolve-files` / `evolve-cognition` wrapper scripts. Verified numpy-fallback (no FAISS) and `yaml` dependency below.

---

## 1. Summary & goals

### What ships this slice

A native IronCurtain workflow package at `src/workflow/workflows/evolve/` that runs **exactly one evolution round, end to end**, recording **one scored candidate** using the packaged `evolve_core` engine, through real container deterministic states with verdict routing:

```
preflight (agent) ─ready→ researcher (agent) ─→ evaluate (deterministic, container)
   ├─ evaluated ─→ record_node (deterministic, container) ─ recorded ─→ done (terminal)
   │                                                       └ needs_repair ─→ failed (terminal)
   └─ evaluator_blocked ─→ failed (terminal)
preflight ─blocked→ failed
```

- `preflight` (agent): writes `run_spec.yaml` (objective, evaluator command, score field) and initializes the run via `evolve_core` (`evolve-brief normalize`), with `approval.confirmed=true`.
- `researcher` (agent): writes the candidate file under the step dir. In the gate it is **mocked** to write a known candidate.
- `evaluate` (deterministic, `container: true`): runs `evolve-eval run` in the shared container, then a thin bridge writes `result.json` with `{ verdict: evaluated | evaluator_blocked, payload: { score, ... }, passed }`.
- `record_node` (deterministic, `container: true`): runs `evolve-db record`, then the same bridge writes `result.json` with `{ verdict: recorded | needs_repair }`. Commits the node to the engine database and updates `best/`.
- An automated, gated, real-Docker integration test (`evolve-single-round.integration.test.ts`) is the front-and-center completion gate.

The engine ships **Tier 0** (numpy + PyYAML, brute-force numpy index, no FAISS), packaged in `scripts/` with a `requirements.txt` that triggers the per-workflow image build.

### What's deferred (see §14)

The multi-round loop, the `orchestrator` hub, sampling beyond the trivial first pick, the analyzer + cognition retrieval, FAISS/embeddings (Tier 1), and richer UI summary artifacts.

### Goals (binary, restated as the gate)

After the run reaches `done`: the engine database holds **exactly one node** carrying the evaluator score, the `best/` snapshot reflects that node, and the FSM terminated in `done` (not `failed`). A second case where the candidate fails the evaluator routes to the failure path. This proves the engine + container exec + verdict routing work **together**.

---

## 2. Where it fits

The two runtime capabilities this slice consumes are **already merged** (PR #292 for container exec/packaging; the result contract is the immediately-preceding design). This slice is the **first real workflow consumer** of both — it is not a smoke fixture. It is the asi-evolve `evaluate`/`record_node` pattern made concrete with the real engine instead of a toy classifier.

The two shipped smoke fixtures are the templates:

- `src/workflow/workflows/deterministic-eval-smoke/` — agent mints container, deterministic `container: true` states `exec` packaged helpers, `requirements.txt` triggers the per-workflow image (numpy), `guard: isPassed` routing.
- `src/workflow/workflows/deterministic-verdict-smoke/` — deterministic state's helper writes `result.json`, machine routes on `when: { verdict: ... }` to distinct terminals.

This slice = `eval-smoke`'s packaging + `verdict-smoke`'s verdict routing, with `evolve_core` as the packaged engine and a real evaluator. The integration test (`test/workflow/deterministic-verdict-smoke.integration.test.ts`) is the literal model for §11.

---

## 3. Workflow package layout

```text
src/workflow/workflows/evolve/
  workflow.yaml                       # the FSM (§4)
  scripts/                            # staged read-only at /workflow-scripts (whole run)
    evolve_core/                      # the packaged engine, copied verbatim from the skill
      __init__.py
      cli.py
      run_state.py  file_lock.py
      database.py  cognition.py  best_snapshot.py  diff.py
      embedding.py  vector_index.py  structures.py
      sampling_config.py
      algorithms/                     # __init__.py base.py factory.py greedy.py island.py random.py ucb1.py
    evolve-brief                      # wrapper: main_for("brief")  — preflight init
    evolve-eval                       # wrapper: main_for("eval")   — evaluator run
    evolve-db                         # wrapper: main_for("db")     — record/best/stats/sample
    evolve-summary                    # wrapper: main_for("summary")
    evolve-files                      # wrapper: main_for("files")  (unused this slice; ship for parity)
    evolve-cognition                  # wrapper: main_for("cognition") (unused this slice; ship for parity)
    evolve_result.py                  # NEW thin bridge: engine JSON -> result.json (§8.3)
    requirements.txt                  # numpy + pyyaml (§10) — triggers the per-workflow image
    LICENSE                           # upstream ASI-Evolve license (Apache 2.0)
    README.md                         # upstream ASI-Evolve README (attribution)
  skills/                             # OPTIONAL this slice — see §4.7. Prompts may live inline in workflow.yaml.
```

The wrappers already exist verbatim under `donotcommit/ASI-Evolve/skills/evolve/scripts/`; each does `sys.path.insert(0, SCRIPT_DIR)` then `from evolve_core.cli import main_for`. Copy them and `evolve_core/` unchanged. `evolve_result.py` is the **only net-new Python** (the bridge, §8.3).

> **Why `requirements.txt` (a per-workflow image) and not the base image.** `evolve_core` imports **numpy** (`embedding.py`, `vector_index.py`) and **PyYAML** (`run_state.py:11 import yaml`). The base image (`docker/Dockerfile.base`) ships Python 3.12, `uv`, pip, and `ruff` but does **not** guarantee numpy or PyYAML. Rather than depend on a transitive base-image package, declare them explicitly. This triggers `ensureWorkflowImage` to bake `ironcurtain-wf-<hash>` `FROM ironcurtain-claude-code:latest` (`docker-infrastructure.ts:1352`) — content-addressed, offline-safe at `--network=none`. The parent design's "numpy-only (Tier 0)" is corrected here to **numpy + pyyaml**; it is still Tier 0 (no FAISS, no sentence-transformers).

The deterministic states invoke helpers with the venv interpreter so the baked deps resolve:
`['/opt/workflow-venv/bin/python', '/workflow-scripts/evolve-eval', 'run', ...]` (matches `eval-smoke`'s `/opt/workflow-venv/bin/python`).

> **Agent states reach the venv + scripts too (real-run preflight).** `ensureWorkflowImage` returns the per-workflow image, which becomes `core.image` (`docker-infrastructure.ts:634`) — the _single_ image the whole bundle uses, **agent sessions included** (`:1105`). `/workflow-scripts` is staged once for the whole run (PR #292 §5.2), not filtered per agent-state `skills:`. So in a _real_ (non-mocked) run, the `preflight` agent session can execute `/opt/workflow-venv/bin/python /workflow-scripts/evolve-brief normalize ...` with numpy + pyyaml resolved. In the gate (§11) `preflight` is mocked and does not need this.

---

## 4. The FSM (full `workflow.yaml`)

```yaml
name: evolve
description: 'Evolve — single-round evaluator-driven candidate search (first vertical slice).'
initial: preflight

settings:
  mode: docker
  dockerAgent: claude-code
  sharedContainer: true # REQUIRED for container: true deterministic states
  model: anthropic:claude-sonnet-4-6

states:
  preflight:
    type: agent
    description: Define the run spec (objective, evaluator command, score field) and initialize the evolve run.
    persona: global
    prompt: |
      You are configuring a single-round Evolve experiment. The task you were given describes a
      program-search objective with an evaluator that prints a score.

      Do BOTH of these, in order, then finish with the required agent_status block:

      1. Initialize the run by executing the evolve-brief helper. The run lives under
         /workspace/.evolve_runs/main/. Use these flags (fill OBJECTIVE / EVAL_CMD from the task):

         /opt/workflow-venv/bin/python /workflow-scripts/evolve-brief normalize \
           --workspace-root /workspace \
           --run-name main \
           --objective "OBJECTIVE" \
           --core-score eval_score \
           --evaluation-command "EVAL_CMD" \
           --evaluation-timeout-secs 30 \
           --success-criterion "eval_score >= 1.0" \
           --max-rounds 1 \
           --patience 1 \
           --stop-condition "max_rounds" \
           --writable-path .evolve_runs \
           --primary-target candidate.py \
           --sampling-algorithm greedy \
           --sample-n 1 \
           --cognition-source-mode none \
           --confirmed true

         EVAL_CMD must be a shell command that reads the candidate at {quoted_code_path}, runs it,
         and writes a JSON file at {quoted_results_path} containing an "eval_score" number.
         (The helper substitutes {quoted_code_path} / {quoted_results_path} at eval time.)

      2. Confirm the command exited 0 and that /workspace/.evolve_runs/main/run_spec.yaml exists.

      If the task is missing an objective or an evaluator you cannot construct, set verdict: blocked.
      Otherwise set verdict: ready.
    inputs: []
    outputs: []
    transitions:
      - to: researcher
        when: { verdict: ready }
      - to: failed
        when: { verdict: blocked }

  researcher:
    type: agent
    description: Materialize one candidate program at the step code path.
    persona: global
    prompt: |
      Write exactly one candidate program for this round.

      Write the COMPLETE candidate file to:
        /workspace/.evolve_runs/main/steps/step_0001/code

      Create the directory if needed. Write only that one file — no extra files, no commentary in
      the file. The candidate must satisfy the objective in /workspace/.evolve_runs/main/run_spec.yaml.

      Finish with the required agent_status block (informational; verdict is not routed here).
    inputs: []
    outputs: []
    maxVisits: 3
    transitions:
      - to: evaluate

  evaluate:
    type: deterministic
    description: Run the configured evaluator on the candidate inside the shared container.
    container: true # default scope "primary" — reuses the bundle preflight/researcher minted
    resultFile: .evolve_runs/main/steps/step_0001/result.json
    run:
      - [
          '/opt/workflow-venv/bin/python',
          '/workflow-scripts/evolve_result.py',
          'evaluate',
          '--run-dir',
          '/workspace/.evolve_runs/main',
          '--step-name',
          'step_0001',
          '--code-path',
          '.evolve_runs/main/steps/step_0001/code',
          '--result-file',
          '/workspace/.evolve_runs/main/steps/step_0001/result.json',
        ]
    transitions:
      - to: record_node
        when: { verdict: evaluated }
      - to: failed
        when: { verdict: evaluator_blocked }
      - to: failed
        when: { verdict: result_file_error }
      - to: failed # belt-and-braces unguarded default

  record_node:
    type: deterministic
    description: Commit the scored candidate as a node and update the best snapshot.
    container: true
    resultFile: .evolve_runs/main/steps/step_0001/record_result.json
    run:
      - [
          '/opt/workflow-venv/bin/python',
          '/workflow-scripts/evolve_result.py',
          'record',
          '--run-dir',
          '/workspace/.evolve_runs/main',
          '--step-name',
          'step_0001',
          '--name',
          'round-1',
          '--code-path',
          '.evolve_runs/main/steps/step_0001/code',
          '--results-file',
          '.evolve_runs/main/steps/step_0001/results.json',
          '--result-file',
          '/workspace/.evolve_runs/main/steps/step_0001/record_result.json',
        ]
    transitions:
      - to: done
        when: { verdict: recorded }
      - to: failed
        when: { verdict: needs_repair }
      - to: failed
        when: { verdict: result_file_error }
      - to: failed

  done:
    type: terminal
    description: One candidate scored and recorded; best snapshot updated.

  failed:
    type: terminal
    description: Preflight blocked, evaluator failed, or record failed.
```

### 4.1 Why linear single-round (no `orchestrator` hub yet)

The parent design centers on an `orchestrator` agent hub whose entire job is to **choose which specialist to dispatch next across rounds** (`design` / `evaluate` / `analyze` / `record` / `complete`). With exactly one round and a fixed `preflight → researcher → evaluate → record_node → done` sequence, there is **nothing for the hub to decide** — every transition is unconditional or a mechanical verdict. Adding the hub now would mean an agent turn that always emits the same verdict, plus the prompt/verdict machinery to validate it, for zero routing value. The hub earns its keep only once there is a loop and a sampling decision (deferred, §14). The linear graph here is a strict subgraph of the parent FSM: the same `preflight`/`researcher`/`evaluate`/`record_node` states and the same deterministic verdicts (`evaluated`/`evaluator_blocked`, `recorded`/`needs_repair`), just with the hub edges collapsed into direct transitions and `human_escalation` replaced by the `failed` terminal (§4.2).

### 4.2 Failure routing: `failed` terminal, not `human_escalation`

The parent design routes hard mechanical failures (`evaluator_blocked`, `needs_repair`) to a `human_escalation` human gate. This slice routes them to a `failed` **terminal** instead, because:

- The slice's purpose is to prove the engine + container + verdict routing pipeline. A human gate on the failure path would make the negative test case (candidate fails the evaluator) **block on a human** instead of terminating cleanly — defeating CI-runnability.
- `human_escalation` belongs to the multi-round design where a human can patch the run spec and resume. With one round and no loop, there is nothing to resume into; terminating is the correct single-round behavior.

`human_escalation` returns in the multi-round slice (§14). The verdict **names** are kept identical to the parent (`evaluator_blocked`, `needs_repair`) so the routing targets are the only thing that changes when the hub is added.

### 4.3 `preflight_review` human gate — DEFERRED this slice (justified)

**Decision: the `preflight_review` human gate is NOT in this slice.** Instead, `preflight` itself sets `approval.confirmed=true` via `evolve-brief normalize --confirmed true`.

Rationale — this keeps the end-to-end gate cleanly CI-runnable:

- The completion gate (§11) must run unattended under `INTEGRATION_TEST=1`. A `human_gate` state pauses the FSM at `phase: waiting_human` and waits for `raiseGate`/an external `APPROVE` event (`test-helpers.ts:392 waitForGate`, `:425 waitForGateOrCompletion`). Auto-approving it requires the test to poll for the gate, then inject an `APPROVE` event and resume — extra orchestration that adds a failure surface (gate-timing flakiness) without testing anything this slice is about (engine + container exec + verdict routing).
- The engine **already enforces approval at the right layer**, independent of graph topology: every mutating/evaluator helper calls `require_evolve_ready(run_dir)` (`run_state.py:288`), which raises `PermissionError` if `approval.confirmed` is false. So approval is enforced by the helper at the point of use, exactly as the parent design's security model demands ("Enforce approval with a machine-readable `approval.confirmed` field checked by every mutating/evaluator helper, not only by graph topology"). Setting `confirmed=true` in `preflight` is the machine-readable approval; the human gate is the _human_ surface, which this slice omits.
- A real run would interpose the gate between `preflight` and `researcher`; the slice's FSM is a strict subgraph that drops it. Re-adding `preflight_review` (and `human_escalation`) is the first thing the next slice does (§14), and the integration-test pattern for auto-approving a gate already exists in the codebase (drive `raiseGate` mock, inject `APPROVE`) — it is deferred to keep _this_ gate binary and fast, not because it is hard.

This is the genuine maintainer call flagged in §15.

### 4.4 `evaluate` transitions

`when: { verdict: evaluated }` → `record_node` (happy path). `when: { verdict: evaluator_blocked }` → `failed` (missing score / evaluator non-zero / malformed results). `when: { verdict: result_file_error }` → `failed` (the reserved verdict from §8.4 if the bridge itself fails to write the file). A final unguarded `to: failed` is the catch-all per the result-contract ordering rule (verdict edges first, then default).

### 4.5 `researcher` is informational (unconditional return)

`researcher` has a single unconditional `to: evaluate` transition, so per the runtime's steering model it gets **no injected verdict list and no verdict validation** — its `agent_status` block is informational. This matches the parent design (`researcher`: "informational verdict; unconditional return"). In the gate it is mocked.

### 4.6 `maxVisits` on `researcher`

`maxVisits: 3` guards repeated invalid candidate revisions (parent design `researcher.maxVisits`). It is inert in the single happy round but documents the cap. `evaluate`/`record_node` are deterministic and take no `maxVisits` (agent-only field, `validate.ts:133`).

### 4.7 Skills

A `skills/` directory is **optional** this slice. The two-state prompt content (preflight scoring contract, researcher candidate-generation modes) is small enough to live inline in `workflow.yaml` for the first slice. If lifted to a skill later, it must be de-sequenced per the CLAUDE.md skill-authoring rules (no stage labels / phase numbers). Not shipping `skills/` keeps the slice minimal; the parent design's full `evolve` skill is deferred.

---

## 5. `.workflow/` domain layout this slice writes

> **Reconciliation (load-bearing).** The parent design specifies a _flattened_ `.workflow/database/nodes.json` layout. The packaged `evolve_core` engine, however, has a **fixed, non-negotiable** run layout baked into `run_state.py`: `build_run_dir(workspace_root, run_name)` returns `<workspace_root>/.evolve_runs/<run_name>/` (`run_state.py:115`), and `workspace_root_for_run(run_dir)` derives the workspace by going **two levels up** from the run dir (`run_dir.parent.parent`, `run_state.py:137`). The path-allowlisting (`ensure_path_allowed`) and the `database_data/nodes.json` storage path (`database.py:162`) all depend on this exact `<ws>/.evolve_runs/<run>/...` shape. Changing it means forking the engine — which contradicts "package, don't re-implement."
>
> **Decision: this slice uses the engine's native `.evolve_runs/main/` layout under `/workspace`, NOT `.workflow/`.** The parent design's `.workflow/` flattening is a _later_ migration (it requires either an engine fork or a path-mapping shim). The completion gate (§11) therefore asserts against `.evolve_runs/main/database_data/nodes.json` and `.evolve_runs/main/best/`, not `.workflow/database/nodes.json`. (The result-contract `resultFile` paths still live under the run dir, e.g. `.evolve_runs/main/steps/step_0001/result.json`.) This deviation from the task's `.workflow/...` wording is deliberate and is the only way to reuse the engine verbatim; it is flagged as a maintainer call in §15.

What the slice writes under `/workspace` (host: `instance.workspacePath`):

```text
/workspace/
  .evolve_runs/
    main/                                  # run_dir  (build_run_dir(workspace, "main"))
      run_spec.yaml                        # preflight: objective, evaluation.command, core_score, approval.confirmed=true
      preflight_summary.md                 # preflight: write_preflight_summary()
      cognition_seed.md                    # preflight: initialize_cognition_seed_file() (unused this slice)
      round_log.jsonl                      # append-only event log (eval_run, db_record, ...)
      steps/
        step_0001/
          code                             # researcher: the candidate program (engine copies here on eval/record)
          results.json                     # evaluate: evaluator output, must carry eval_score
          eval.command.txt eval.stdout eval.stderr   # evaluate: captured by evolve-eval run
          result.json                      # evaluate bridge: { verdict, payload:{score}, passed }  (resultFile)
          node.json                        # record_node: the committed Node record
          record_result.json               # record_node bridge: { verdict, payload:{node_id,best_updated} }
      database_data/
        nodes.json                         # THE commit index: { next_id, nodes: {"0": {...}}, sampler_state }
        faiss/
          vector_store.pkl                 # brute-force numpy index (Tier 0 fallback)  (database.py:191 -> storage_dir/"faiss", vector_index.py:131)
        .database.lock
      cognition_data/                      # initialized empty (cognition_source_mode=none)
      best/
        step_0001/                         # run-level best (cmd_db_record: run_dir/best/<step_name>, cli.py:478) — NOT best/round-1/ (round-1 is only the Node name, cli.py:463)
          code                             # record_node: best snapshot when this node improves best
          results.json
      steps/
        best/
          step_0001/                       # SECOND, separate snapshot from BestSnapshotManager (best_snapshot.py:19 best_dir=steps_dir/"best", :47 /step_name) — gate need not assert this
            code
            results.json
```

The single node lives in `database_data/nodes.json` as `{ "next_id": 1, "nodes": { "0": { ...Node... } }, "sampler_state": {...} }` — **a keyed object, not a bare array** (`database.py:139-143`). The Node's `score` field carries the evaluator score. This is the structure the completion gate inspects.

`steps/` is append-only; `best/step_0001/` is written only when the node improves the best (always true for the first node). The best-dir name is the **step name** (`step_0001`), not the `--name` value (`round-1`) — `cmd_db_record` writes `run_dir/best/<step_name>` (`cli.py:478`) and `--name round-1` only becomes `Node.name` (`cli.py:463`). `.evolve_runs/` is an undeclared workspace subtree (not a declared output, so never `.vN`-snapshotted) — exactly the parent design's "leave large mutable stores undeclared" guidance.

---

## 6. `preflight` (agent)

**Type:** agent (`persona: global`). **Routes on** `verdict: ready | blocked`.

**Responsibility.** Produce `run_spec.yaml` with objective, evaluator command, score field, timeout, and approval, then initialize the engine run layout.

**The exact engine call** (run by the agent inside the container; the agent is instructed to execute this argv):

```
/opt/workflow-venv/bin/python /workflow-scripts/evolve-brief normalize \
  --workspace-root /workspace \
  --run-name main \
  --objective "<from task>" \
  --core-score eval_score \
  --evaluation-command "<shell cmd reading {quoted_code_path}, writing {quoted_results_path} with eval_score>" \
  --evaluation-timeout-secs 30 \
  --success-criterion "eval_score >= 1.0" \
  --max-rounds 1 --patience 1 --stop-condition "max_rounds" \
  --writable-path .evolve_runs --primary-target candidate.py \
  --sampling-algorithm greedy --sample-n 1 \
  --cognition-source-mode none \
  --confirmed true
```

This calls `cmd_brief_normalize` (`cli.py:123`), which: builds `run_dir = /workspace/.evolve_runs/main`, `ensure_run_layout` (creates `steps/`, `database_data/`, `cognition_data/`, `best/`, `round_log.jsonl`), merges the flags into the run spec, validates required fields, and — because `--confirmed true` with no missing fields — writes `run_spec.yaml` (`save_run_spec`), `preflight_summary.md` (`write_preflight_summary`), and `cognition_seed.md` (`initialize_cognition_seed_file`). It prints JSON `{ confirmed, missing_fields, preflight_summary, run_dir, run_spec, seed_file }`.

> **Required-field note (must match `REQUIRED_FIELD_CHECKS`, `run_state.py:58`).** `--confirmed true` is **rejected with a non-zero exit** if any required field is missing (`cli.py:192`: "Cannot confirm preflight while required fields are missing"). The argv above supplies every required field: `objective`, `evaluation.core_score`, `evaluation.command`, `evaluation.timeout_secs > 0`, `evaluation.success_criteria`, `budget.max_rounds > 0`, `budget.patience >= 0`, `stop_conditions`, `mutation_scope.writable_paths`, `mutation_scope.primary_targets`, `sampling.algorithm`, `sampling.sample_n > 0`, `cognition.source_mode`. The integration test's `preflight` mock (§11) must produce these or the run cannot confirm. `sampling.algorithm: greedy` is chosen (not the default `ucb1`) because with one node the sampler is irrelevant and `greedy` avoids any island/feature-dimension setup.

**Verdict.** The agent emits `ready` after confirming the command exited 0 and `run_spec.yaml` exists; `blocked` if it cannot construct an evaluator. `preflight` is an agent state with only verdict-conditional edges, so the runtime injects the valid verdicts (`ready`, `blocked`) into its prompt and validates the emitted `agent_status` verdict.

**No declared `preflight_summary` artifact.** `preflight` must declare `outputs: []` (and `researcher` `inputs: []`). This is **not cosmetic — it is a functional requirement.** After an agent state completes, the orchestrator runs `findMissingArtifacts(stateConfig, instance.artifactDir)` (`orchestrator.ts:2249,2691`), which resolves each declared output to `<ws>/.workflow/<output>/` (artifactDir = `<ws>/.workflow`, `orchestrator.ts:1249`; `WORKFLOW_ARTIFACT_DIR = '.workflow'`, `types.ts:12`) and checks `hasAnyFiles`. The engine, however, writes the summary to `.evolve_runs/main/preflight_summary.md`, **not** under `.workflow/preflight_summary/`. So a declared `outputs: ['preflight_summary']` would find that directory empty, fire the missing-artifact reprompt, and then **throw `Missing artifacts after retry: preflight_summary`** (`orchestrator.ts:2263-2264`) — the run never reaches `researcher`/`evaluate` and the §11 gate fails here. The summary file still exists under `.evolve_runs/main/preflight_summary.md` and is agent-visible; it is simply not surfaced as a declared `.workflow/` artifact this slice. (Surfacing it as a UI artifact requires either writing it under `.workflow/` or a copy step — deferred, §14 #9.)

---

## 7. `researcher` (agent)

**Type:** agent (`persona: global`). **Unconditional** return to `evaluate` (informational verdict).

**Responsibility.** Write the complete candidate program to `/workspace/.evolve_runs/main/steps/step_0001/code` (creating the dir). One file only, no commentary. Diff vs full-rewrite modes are deferred (parent design keeps both; this slice does full-rewrite only).

**In the gate (§11), `researcher` is mocked** via the `createSession` stub to write a known candidate (`def solve(xs): return sum(xs)`) to that path. The mock writes the file directly to `options.workspacePath` (exactly as `deterministic-verdict-smoke.integration.test.ts:159-164` writes `task.txt`), so no real LLM runs.

The candidate path (`steps/step_0001/code`) is the path the `evaluate` state passes to `evolve-eval run --code-path` (relative to workspace root). `evolve-eval` copies it into the step dir if not already there (`cli.py:258`), so writing it directly at the step path is the simplest contract.

---

## 8. `evaluate` (deterministic, container)

**Type:** deterministic, `container: true`, default scope `primary` (reuses the bundle `preflight`/`researcher` minted). `resultFile: .evolve_runs/main/steps/step_0001/result.json`.

### 8.1 What it runs

A single command: the **bridge** `evolve_result.py evaluate`, which (a) invokes `evolve-eval run` and (b) translates the engine's JSON + `results.json` into the result-contract `result.json`. The bridge is necessary because **`evolve_core` does not emit `{ verdict, payload, passed }`** — `cmd_eval_run` (`cli.py:243`) emits `{ results_path, return_code, step_dir, success }` and the score lives in `results.json` (`eval_score`). The result contract needs a `verdict`; the bridge supplies it.

### 8.2 The underlying engine call (issued by the bridge)

```
/opt/workflow-venv/bin/python /workflow-scripts/evolve-eval run \
  --run-dir /workspace/.evolve_runs/main \
  --code-path .evolve_runs/main/steps/step_0001/code \
  --step-name step_0001 \
  --timeout 30
```

`cmd_eval_run` (`cli.py:243`): calls `require_evolve_ready` (enforces `approval.confirmed`), copies the candidate to `steps/step_0001/code`, formats `evaluation.command` from `run_spec.yaml` with `{quoted_code_path}`/`{quoted_results_path}` placeholders, runs it via `subprocess.run(shell=True, cwd=/workspace, timeout=30)`, captures `eval.stdout`/`eval.stderr`/`eval.command.txt`, reads `steps/step_0001/results.json`, and on non-zero exit backfills `{success:false, eval_score:0.0, error}`. Returns `{ results_path, return_code, step_dir, success }`. Because the whole thing runs inside the `--network=none` shared container via `docker exec`, the evaluator is network-isolated and the container `--init` reaps its process tree (parent design's containment model).

### 8.3 The bridge: `scripts/evolve_result.py` (NEW — the only net-new Python)

A thin argparse CLI with two subcommands (`evaluate`, `record`). For `evaluate`:

1. `subprocess.run([sys.executable, "<dir>/evolve-eval", "run", "--run-dir", run_dir, "--code-path", code_path, "--step-name", step, "--timeout", "30"], capture_output=True)`, then `json.loads(stdout)` to get the engine result `{ results_path, return_code, step_dir, success }`.
2. Read `<run_dir>/steps/<step>/results.json` if present; pull `eval_score` (fall back to `score`).
3. Decide the verdict — **key on the engine JSON's `return_code`/`success`, NOT the wrapper's own exit code.** `evolve-eval run` (`cmd_eval_run`, `cli.py:243`) catches the _evaluator subprocess_ failure, backfills `results.json` with `{success:false, eval_score:0.0, error}` (`cli.py:315`), and itself exits **0** via `emit_json` with `return_code != 0` in its JSON. So:
   - `evaluated` — engine JSON `return_code == 0` (or `success: true`) AND `results.json` exists AND carries a numeric `eval_score`.
   - `evaluator_blocked` — engine JSON `return_code != 0` (evaluator subprocess failed/timed out — `124`), OR `results.json` is missing, OR it has no numeric scalar score (the parent design's "treat missing scalar score as evaluator failure"). Also `evaluator_blocked` if the wrapper itself crashed (non-zero wrapper exit, e.g. `require_evolve_ready` raised → unconfirmed preflight).
4. Compute `passed = (verdict == "evaluated")`. Note: a _low_ score (e.g. 0.0) with `return_code == 0` is `evaluated`, not `evaluator_blocked` — a bad candidate is a low score, not an evaluator failure (§11.4).
5. Write the result file (`--result-file`, an absolute `/workspace/...` path matching the state's `resultFile`):
   ```json
   { "verdict": "evaluated", "payload": { "score": 6.0, "return_code": 0, "success": true }, "passed": true }
   ```
   On `evaluator_blocked`: `{ "verdict": "evaluator_blocked", "payload": { "return_code": 1, "error": "..." }, "passed": false }`.
6. The bridge process itself **always exits 0** when it successfully writes the result file. This is deliberate: per the result contract (§4.3 of the contract doc), the file's `passed` field — not the bridge's exit code — drives `passed`, and routing is driven by `verdict`. A bridge that exited non-zero on `evaluator_blocked` would make `reduceDeterministicCommands` set `passed:false` and `applyResultFile` would then **skip the file read** (it only reads when `base.passed`), losing the verdict. So the bridge exits 0 and lets the file carry `passed:false`. If the bridge cannot _write_ the file at all (e.g. an internal crash), it exits non-zero and the runtime synthesizes the reserved `result_file_error` verdict (§8.4).

### 8.4 How `result.json` drives routing

After the command runs, `applyResultFile(instance, input, base)` (result-contract §5.2) reads `instance.workspacePath + "/.evolve_runs/main/steps/step_0001/result.json"` (the host source of the `/workspace` bind mount), validates it is a JSON object with a non-empty string `verdict`, applies the `passed` override, and attaches `verdict`/`payload` to the `DeterministicInvokeResult`. The machine routes the `when: { verdict: ... }` edges via `__matchesWhen`. If the file is missing/malformed, the runtime returns `verdict: result_file_error`, `passed: false` — routed to `failed` by the explicit `when: { verdict: result_file_error }` edge.

**Engine output → result contract mapping (the bridge contract):**

| Engine signal                                                                            | Bridge verdict      | `passed` | Routed to     |
| ---------------------------------------------------------------------------------------- | ------------------- | -------- | ------------- |
| engine JSON `return_code == 0`, `results.json.eval_score` numeric (any value, incl. 0.0) | `evaluated`         | `true`   | `record_node` |
| engine JSON `return_code != 0` (evaluator subprocess failed/timed out)                   | `evaluator_blocked` | `false`  | `failed`      |
| `results.json` missing or no numeric score                                               | `evaluator_blocked` | `false`  | `failed`      |
| wrapper exits non-zero (e.g. `require_evolve_ready` raised — unconfirmed preflight)      | `evaluator_blocked` | `false`  | `failed`      |
| bridge crashes before writing the file                                                   | `result_file_error` | `false`  | `failed`      |

---

## 9. `record_node` (deterministic, container)

**Type:** deterministic, `container: true`, scope `primary`. `resultFile: .evolve_runs/main/steps/step_0001/record_result.json`.

### 9.1 The underlying engine call (issued by the bridge)

```
/opt/workflow-venv/bin/python /workflow-scripts/evolve-db record \
  --run-dir /workspace/.evolve_runs/main \
  --step-name step_0001 \
  --name round-1 \
  --code-path .evolve_runs/main/steps/step_0001/code \
  --results-file .evolve_runs/main/steps/step_0001/results.json
```

`cmd_db_record` (`cli.py:417`): `require_evolve_ready`; builds the `Database` (storage `database_data/`); copies code into the step dir; reads `results.json`; derives `score` from `results["score"] || results["eval_score"]` (or `--score`); constructs a `Node(name, code, results, score, meta_info={step_name})`; `db.add_with_previous_nodes(node)` — which assigns `node.id`, persists `database_data/nodes.json` atomically (temp + `os.fsync` + `os.replace`, `database.py:139-167`), and updates the numpy vector store; writes `steps/step_0001/node.json`; calls `snapshot.update_if_better(...)` (which writes the `BestSnapshotManager` snapshot at `steps/best/step_0001/`, `best_snapshot.py:47`); and, when `best_updated` is true, copies the run-level best to `best/step_0001/code` + `results.json` (the best-dir is keyed by **step name** `step_0001`, `cli.py:478` — NOT `best/round-1/`; `--name round-1` only becomes `Node.name`, `cli.py:463`). Returns `{ best_updated, node_id, step_dir }`.

This is the parent design's transactional, idempotent durable write — the atomic `nodes.json` rename is the commit point, and `best/` is derived from committed nodes. For a single node, `best_updated` is always true.

### 9.2 The bridge: `evolve_result.py record`

1. `subprocess.run([sys.executable, "<dir>/evolve-db", "record", ...])`, capture stdout (the engine JSON).
2. Parse `{ best_updated, node_id, step_dir }`.
3. Verdict:
   - `recorded` — `evolve-db record` exited 0 and returned a `node_id`.
   - `needs_repair` — `evolve-db record` exited non-zero (the engine raised, e.g. a transaction/consistency error, or `require_evolve_ready` failed), or returned no `node_id`.
4. `passed = (verdict == "recorded")`.
5. Write `record_result.json`: `{ "verdict": "recorded", "payload": { "node_id": 0, "best_updated": true }, "passed": true }` (or the `needs_repair` form). Bridge exits 0 when the file is written (same rationale as §8.3).

### 9.3 Routing

`when: { verdict: recorded }` → `done`. `when: { verdict: needs_repair }` → `failed`. `when: { verdict: result_file_error }` → `failed`. Final unguarded `to: failed`.

---

## 10. Dependencies / image (Tier 0)

`src/workflow/workflows/evolve/scripts/requirements.txt`:

```
numpy
pyyaml
```

- **numpy** — `embedding.py` (hash-token embedding fallback) and `vector_index.py` (brute-force pickle index fallback), both numpy-only when FAISS/sentence-transformers are absent (`vector_index.py:12-18` `try: import faiss except: FAISS_AVAILABLE=False`).
- **pyyaml** — `run_state.py:11 import yaml` (run spec load/save). Required; without it `evolve-brief`/`evolve-eval`/`evolve-db` crash on import.

No `faiss-cpu`, no `sentence-transformers` (Tier 1, deferred §14). No `package.json` (no Node helpers).

**Per-workflow image build is triggered.** Because `requirements.txt` is present, `ensureWorkflowImage(agentImage, scriptsDir, docker, ca)` (`docker-infrastructure.ts:1352`) builds `ironcurtain-wf-<hash>:latest` `FROM ironcurtain-claude-code:latest`, running `uv venv /opt/workflow-venv && uv pip install -r requirements.txt` at build time (network available at build, `--network=none` only at runtime). The build hash (`computeWorkflowImageHash`, `:1405`) keys on `requirements.txt` bytes, so the image rebuilds only when deps change. Helpers run via `/opt/workflow-venv/bin/python` so the baked venv resolves numpy + pyyaml. This is the same path `deterministic-eval-smoke` exercises with `requirements.txt: numpy` — verified to build end to end in PR #292 §11.

---

## 11. End-to-end validation gate (REQUIRED — front and center)

`test/workflow/evolve-single-round.integration.test.ts`, gated `describe.skipIf(!dockerReady)` with `dockerReady = INTEGRATION_TEST === '1' && isDockerAvailable() && isDockerImageAvailable('ironcurtain-claude-code:latest') && hostCaDir !== null`. **Modeled line-for-line on `test/workflow/deterministic-verdict-smoke.integration.test.ts`** (same `TEST_HOME`/CA staging, same `buildDockerSessionConfig`, same `createInfra`/`destroyInfra` real bundles, same `createDeps`, same `onEvent` state collection, same `waitForCompletion`).

### 11.1 Task

A trivial program-search task: **"write `solve(xs)` returning the sum of `xs`; the evaluator scores it by checking `solve([1,2,3]) == 6`."** The evaluator command (set by the `preflight` mock) is a one-line Python that imports the candidate, computes the score, and writes `eval_score` to `results.json`.

### 11.2 Agent sessions are mocked (`createSession`)

The `createSession` stub returns a `MockSession` whose behavior depends on which state is running. **The stub MUST key off invocation order, not `options`.** Both `preflight` and `researcher` are `persona: global` agent states sharing one workspace, and `SessionOptions` carries **no state id** (`src/session/types.ts:361` — `persona`, `workspacePath`, etc., but nothing identifying the FSM state). So the stub cannot tell `preflight` from `researcher` by inspecting `options`; it must use a shared, factory-level call counter (the orchestrator calls `createSession` once per agent state, in FSM order). Concretely:

- **1st invocation = `preflight`** — the mock **does not run the engine** (running `evolve-brief normalize` on the host is wrong — the host has no venv). It writes a hand-authored `run_spec.yaml` directly into the workspace at `.evolve_runs/main/run_spec.yaml` (with `approval.confirmed: true` and every required field) plus the directory skeleton (`steps/`, `database_data/`, `cognition_data/`, `best/`, empty `round_log.jsonl`). **It MUST return a status block with `verdict: ready`** — e.g. `statusBlock('ready', 'preflight confirmed')` (`test-helpers.ts:161`), **NOT `approvedResponse()`.** `preflight`'s transitions are all `when:{verdict}` (ready/blocked), so `getValidVerdicts` returns `{ready, blocked}` (`status-parser.ts:289-296`) and the orchestrator validates the emitted verdict against it (`orchestrator.ts:2215-2242`). The shared `approvedResponse()` helper emits `verdict: approved` (`test-helpers.ts:123-135`), which is **not** in `{ready, blocked}` → rejected → reprompt. **Why not run the real `evolve-brief` here:** the agent session is mocked precisely so no container/LLM round-trip happens for the agent states; the engine still runs for real in the **deterministic** states (`evaluate`/`record_node`) inside the container, which is what the gate proves. Writing `run_spec.yaml` by hand is the mock's job (it stands in for what the real preflight agent would have produced). The hand-authored spec's `evaluation.command` is the real evaluator the container will execute.
- **2nd invocation = `researcher`** — write `/workspace/.evolve_runs/main/steps/step_0001/code` containing `def solve(xs):\n    return sum(xs)\n`. `researcher` has a single **unconditional** `to: evaluate` edge, so `getValidVerdicts` returns `undefined` (no verdict validation) — `approvedResponse()` is fine here.

The order is deterministic (`preflight` then `researcher`), so the stub uses an incrementing call counter, exactly like `MockSession`'s array-response mode (`test-helpers.ts:49`). The stub **must assert it is called at most twice** (a 3rd `createSession` call signals the counter desynced — e.g. an unexpected reprompt minting a new session). With the `verdict: ready` fix above, `preflight` passes verdict validation on the first turn and **does not reprompt**, so exactly two `createSession` calls occur (preflight, researcher) and the counter stays aligned with the FSM state. (Were `preflight` to emit an invalid verdict, the reprompt happens on the _same_ session via `sendAgentTurn` — it would not mint a 3rd session — but it would corrupt the run; the `verdict: ready` requirement avoids it entirely.)

> **Self-check the implementer must do:** the hand-authored `run_spec.yaml` must satisfy `REQUIRED_FIELD_CHECKS` (§6) AND `evaluation.command` must be a shell command valid inside the container that reads `{quoted_code_path}` and writes `eval_score` to `{quoted_results_path}`. Recommended command (single file, no extra deps):
> `python3 -c "import json,sys; ns={}; exec(open({quoted_code_path}).read(),ns); s=ns['solve']([1,2,3]); json.dump({'eval_score': float(s), 'success': s==6}, open({quoted_results_path},'w'))"`
> The negative case (§11.4) swaps the candidate so `solve([1,2,3]) != 6`.

### 11.3 Completion gate (binary)

The positive case runs `orchestrator.start(<evolve manifest>, <task>, workspaceDir)`, `waitForCompletion`, then asserts ALL of:

1. **Terminal state is `done`** — `states.at(-1) === 'done'` and `states` does **not** contain `'failed'`. (`states` collected from `state_entered` lifecycle events, verdict-smoke test pattern.)
2. **Exactly one node, carrying the evaluator score** — read `<workspaceDir>/.evolve_runs/main/database_data/nodes.json`; parse; assert `Object.keys(parsed.nodes).length === 1` and `parsed.nodes["0"].score === 6` (the evaluator's `eval_score` for `solve([1,2,3])`). (`next_id === 1`.)
3. **`best/` reflects that node** — `<workspaceDir>/.evolve_runs/main/best/step_0001/code` exists and equals the known candidate; `<workspaceDir>/.evolve_runs/main/best/step_0001/results.json` carries `eval_score: 6`. (The best-dir is keyed by **step name** `step_0001`, written by `cmd_db_record` at `run_dir/best/<step_name>` — `cli.py:478`. Asserting `best/round-1/` would always fail: `round-1` is only the Node name, `cli.py:463`. The gate need not also assert the separate `steps/best/step_0001/` snapshot written by `BestSnapshotManager`.)
4. **Result-contract files prove verdict routing** — `steps/step_0001/result.json` has `verdict: "evaluated"`; `steps/step_0001/record_result.json` has `verdict: "recorded"`.

### 11.4 Negative case (candidate fails the evaluator)

A second test where the `researcher` mock writes a **wrong** candidate (e.g. `def solve(xs): return 0`). The evaluator computes `solve([1,2,3]) == 0 != 6`, so `results.json` has `eval_score: 0.0`, `success: false`. **Decision on routing and recording for the negative case:**

- The evaluator still **runs successfully and produces a numeric score** (0.0). A non-matching candidate is a _low score_, not an _evaluator failure_. So `evaluate` emits `verdict: evaluated` (score 0.0), NOT `evaluator_blocked`. The candidate IS recorded (`record_node` → `recorded`), and the run reaches **`done`** with one node of score 0.0. This is the correct evolutionary semantics: failed candidates are still recorded (parent design: "Store every candidate, including failed or low-scoring candidates").
- To exercise the **`evaluator_blocked` → `failed`** path explicitly, a **third** case makes the evaluator itself fail: the `researcher` mock writes a candidate with no `solve` symbol (e.g. `x = 1`), so the evaluator command raises (`KeyError: 'solve'`) and the _evaluator subprocess_ exits non-zero. `evolve-eval run` catches it, **backfills `results.json` with `{success:false, eval_score:0.0, error}`** (`cli.py:315-320`), and returns engine JSON `return_code != 0` (the wrapper itself still exits 0), so the bridge keys on that `return_code` and emits `evaluator_blocked`. The run terminates in **`failed`** with **zero** nodes recorded (`record_node` never runs). **Precise absence-key:** because `cmd_eval_run` backfills it, `results.json` **exists** even on a crash — so the gate must NOT key on `results.json`. The reliable absence is **`nodes.json`**: it is written only by `cmd_db_record` → `db.add_with_previous_nodes` → `_persist_locked` (`cli.py:472`, `database.py:162`), and `record_node` never runs on the blocked route, so `nodes.json` is **absent** (the file is never created — it is not the empty-object `{ next_id: 0, nodes: {} }` form, since no `Database` write occurs). Gate for this case: `states.at(-1) === 'failed'`, `states` contains `'evaluate'` but not `'record_node'`, `result.json` has `verdict: "evaluator_blocked"`, and `nodes.json` does not exist.

So: **low-score candidate → recorded, reaches `done`** (semantically correct); **evaluator crash → not recorded, reaches `failed`** (the `evaluator_blocked` path). Both are asserted.

### 11.5 Why this gate proves the three things work together

The candidate score reaching `nodes.json` proves the **engine** ran (eval + record) inside the container. The score being present at all proves **container exec** delivered the evaluator output back to the workspace bind mount. The run reaching `done` rather than `failed` — and the `evaluator_blocked` case reaching `failed` — proves **verdict routing** read the bridge-written `result.json` and took the right `when: { verdict }` edge (a guard-only `isPassed` implementation could not distinguish `evaluated` from `evaluator_blocked`, nor route a low-score `done` from a crash `failed`). The three are inseparable in the assertion: no single one passing alone produces the observed terminal + `nodes.json` + `best/`.

### 11.6 Manual run

```
INTEGRATION_TEST=1 npm test -- test/workflow/evolve-single-round.integration.test.ts
# or by hand (real preflight/researcher agents):
tsx src/cli.ts workflow start evolve "write solve(xs) returning sum(xs); evaluator scores solve([1,2,3])==6"
tsx src/cli.ts workflow inspect <baseDir>   # confirm final state = done
```

---

## 12. File-by-file new files

| File                                                     | Purpose                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/workflows/evolve/workflow.yaml`            | The FSM (§4). New workflow definition.                                                                                                                                                                                                |
| `src/workflow/workflows/evolve/scripts/requirements.txt` | `numpy` + `pyyaml` (§10). Triggers the per-workflow image. Resolved from `scriptsDir` by `ensureWorkflowImage`.                                                                                                                       |
| `src/workflow/workflows/evolve/scripts/evolve_core/**`   | The packaged engine, copied verbatim from `donotcommit/ASI-Evolve/skills/evolve/scripts/evolve_core/` (all modules + `algorithms/`).                                                                                                  |
| `src/workflow/workflows/evolve/scripts/LICENSE`          | Upstream ASI-Evolve license (Apache 2.0), copied verbatim for attribution.                                                                                                                                                            |
| `src/workflow/workflows/evolve/scripts/README.md`        | Upstream ASI-Evolve `README.md`, copied verbatim next to the LICENSE for attribution.                                                                                                                                                 |
| `src/workflow/workflows/evolve/scripts/evolve-brief`     | Wrapper `main_for("brief")`, copied verbatim.                                                                                                                                                                                         |
| `src/workflow/workflows/evolve/scripts/evolve-eval`      | Wrapper `main_for("eval")`, copied verbatim.                                                                                                                                                                                          |
| `src/workflow/workflows/evolve/scripts/evolve-db`        | Wrapper `main_for("db")`, copied verbatim.                                                                                                                                                                                            |
| `src/workflow/workflows/evolve/scripts/evolve-summary`   | Wrapper `main_for("summary")`, copied verbatim (unused this slice; ship for parity).                                                                                                                                                  |
| `src/workflow/workflows/evolve/scripts/evolve-files`     | Wrapper `main_for("files")`, copied verbatim (unused this slice).                                                                                                                                                                     |
| `src/workflow/workflows/evolve/scripts/evolve-cognition` | Wrapper `main_for("cognition")`, copied verbatim (unused this slice).                                                                                                                                                                 |
| `src/workflow/workflows/evolve/scripts/evolve_result.py` | **NEW** bridge: `evaluate`/`record` subcommands that run the engine and write `result.json` / `record_result.json` per §8.3 / §9.2. The only net-new Python.                                                                          |
| `test/workflow/evolve-single-round.integration.test.ts`  | **NEW** gated real-Docker integration test (§11): positive (`done`, 1 node, best), low-score (`done`, recorded), evaluator-crash (`failed`, 0 nodes).                                                                                 |
| `test/workflow/evolve-result-bridge.test.ts`             | **NEW** unit tests for `evolve_result.py` logic (§13) — run as a Python test or via a thin TS harness invoking the script with stubbed `evolve-eval`/`evolve-db`. (Decide language; Python `pytest`-style or a Node `spawn` harness.) |

**Glue / existing-code touches (verify, likely zero):**

- `eslint.config.js` already ignores `src/workflow/workflows/*/scripts/` (PR #292 §10), so the packaged Python/JS won't break lint. Confirm `evolve/scripts/` is covered by that glob.
- No orchestrator/validate/machine-builder changes — both runtime capabilities are merged. The slice is **pure workflow-package + test**.
- Discovery picks up `evolve` automatically by directory name (`resolveWorkflowPath('evolve')`, `discovery.ts:205`); no registry edit.

---

## 13. Unit test plan

Unit-level (no Docker), targeting the three things this slice adds on top of the merged runtime:

1. **Run-spec / preflight argv** — assert the `evolve-brief normalize` argv in `workflow.yaml`'s `preflight` prompt supplies every `REQUIRED_FIELD_CHECKS` field (§6), so `--confirmed true` cannot be rejected. (Static check on the YAML prompt, or a small Python test that runs `cmd_brief_normalize` with these args against a temp workspace and asserts `confirmed: true, missing_fields: []`.)
2. **Eval-result bridge → `result.json` shape** (`evolve_result.py evaluate`): with a stub `evolve-eval` that (a) exits 0 + writes `results.json{eval_score: 6}` → bridge writes `{verdict: evaluated, passed: true, payload.score: 6}`; (b) exits 0 + `results.json{eval_score: 0}` → `{verdict: evaluated, passed: true, payload.score: 0}` (low score still `evaluated`); (c) exits non-zero → `{verdict: evaluator_blocked, passed: false}`; (d) `results.json` missing → `evaluator_blocked`; (e) `results.json` present but no numeric score → `evaluator_blocked`. Assert the bridge process exits 0 in (a)–(e) (file carries `passed`).
3. **Record bridge → `record_result.json`** (`evolve_result.py record`): stub `evolve-db record` exits 0 returning `{node_id: 0, best_updated: true}` → `{verdict: recorded, passed: true, payload:{node_id:0,best_updated:true}}`; stub exits non-zero → `{verdict: needs_repair, passed: false}`.
4. **Record idempotency at unit level** (engine-level, exercises `cmd_db_record`): record the same `step_name` twice against a temp run dir → the second call appends a _second_ node (the engine keys on `next_id`, not step name) — **document that `evolve-db record` is NOT idempotent by step name** (it always allocates a new id). This matters because the parent design wants step-id idempotency; this slice runs `record_node` exactly once, so it is unaffected, but the unit test pins the current behavior so the multi-round slice knows it must add an idempotency guard. (Genuine finding, flagged in §15.)
5. **YAML structural validation + lint** — `evolve/workflow.yaml` passes `validate` (`container: true` + `sharedContainer: true` + `mode: docker`; `resultFile` requires `container: true`; verdict edges legal on deterministic) and lints clean (WF011: each `container: true` state is preceded by a `primary`-scope agent state — `preflight`/`researcher` are `persona: global` → default `primary` scope; WF012: both `container` states declare `resultFile`). Add `evolve` to the no-regression validation snapshot.

---

## 14. Deferred to later slices

1. **Multi-round loop** — repeat `researcher → evaluate → record_node` for N rounds; allocate `step_NNNN` per round; enforce `budget.max_rounds`/`patience`.
2. **`orchestrator` hub** — the agent router that chooses the next specialist (`design`/`evaluate`/`analyze`/`record`/`complete`) and writes the directive; restores the hub-and-spoke graph.
3. **`preflight_review` + `human_escalation` human gates** — re-add the human surfaces; integration test auto-approves the gate via the `raiseGate`/`APPROVE` pattern.
4. **Sampling beyond trivial first pick** — `db sample` with real UCB1/island selection of parent context; visit-count transactions.
5. **Analyzer + cognition retrieval** — `analyzer` agent state writing `analysis.md`; `cognition init/add/search`; seed files.
6. **FAISS / sentence-transformers (Tier 1)** — add `faiss-cpu` + `sentence-transformers` to `requirements.txt` for the real embedding stack; the build-hash already rebuilds on manifest change.
7. **`.workflow/` flattened layout** — migrate the engine's `.evolve_runs/<run>/` layout to the parent design's `.workflow/database/nodes.json` shape (needs an engine fork or a path-mapping shim — §5/§15).
8. **Record idempotency by step id** — make `evolve-db record` resume-safe (currently allocates a new node id every call — §13.4).
9. **UI summary artifacts** — declared `.workflow/` outputs for preflight summary, current best, round log, evaluator-failure bundle; round table in the web UI.
10. **`final_summary` / `final_review`** — `evolve-summary final` + a final human gate.
11. **Evaluator write-scoping** to `steps/<step_id>/` (parent design open gap; `--network=none` denies egress but `/workspace` is RW).

---

## 15. Open questions / human decisions (RESOLVED — implemented in #300)

1. **`.evolve_runs/` vs `.workflow/` layout (§5) — DECIDED: engine-native `.evolve_runs/main/` (maintainer sign-off 2026-06-16). IMPLEMENTED in #300.** The engine's native layout shipped (with `database_data/nodes.json`), deviating from the parent design's `.workflow/database/nodes.json`, because `run_state.py` hard-codes `<ws>/.evolve_runs/<run>/...` and `workspace_root_for_run = run_dir.parent.parent` with no override flag — matching `.workflow/` would require forking the engine, contradicting "package, don't re-implement." The completion gate asserts against the engine-native paths.
2. **`preflight_review` deferral (§4.3) — DECIDED: defer for this slice (maintainer sign-off 2026-06-16). IMPLEMENTED as deferral in #300; the gate itself LANDED LATER in #303.** As shipped in #300, `preflight` sets `approval.confirmed=true` (via `evolve-brief normalize --confirmed true`) and the human gate is omitted. Approval is **still enforced at the helper layer** — every mutating/evaluator helper calls `require_evolve_ready(run_dir)` (`run_state.py:288`), invoked from `cmd_eval_run` (`cli.py:245`) and `cmd_db_record` (`cli.py:419`), which raises if `approval.confirmed` is false. The parent design requires "explicit human approval before running the first evaluator" (`asi-evolve-native-workflow.md:945`); auto-confirming removes that _human_ surface (the machine-readable check remains), accepted here for a trusted-demo evaluator under `--network=none`. **The `preflight_review` human gate was subsequently added in the human-surface slice (#303)** — along with `provision_review`/`human_escalation`/`final_summary`/`final_review`/`aborted` — and is required before any non-demo use.
3. **The engine-output→result bridge (`evolve_result.py`, §8.3/§9.2) — RESOLVED: separate packaged bridge shipped.** `evolve_core` emits its own JSON (`{success, return_code}` / `{node_id, best_updated}`), not `{verdict, payload, passed}`, so a thin bridge produces the result-contract file. As shipped (#300), the bridge is a separate packaged script (`src/workflow/workflows/evolve/scripts/evolve_result.py`) leaving the engine byte-untouched — the recommended option; the rejected `cli.py` emit-mode coupling was not taken. (The multi-round slice #302 extended this same bridge with `sample`/`attach_analysis` and the `PYTHONHASHSEED` determinism pin, leaving the slice-1 `evaluate`/`record` paths intact.)

Lower-confidence sub-decisions also flagged inline: the negative-case routing (low score → `done`/recorded vs evaluator crash → `failed`, §11.4), and that `evolve-db record` is not idempotent by step name (§13.4, harmless this slice, must be fixed for multi-round).
