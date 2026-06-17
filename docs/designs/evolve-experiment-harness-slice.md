# Evolve Native Workflow — Generic Experiment Harness Slice (provision + --workspace experiment dir + generic preflight)

Status: **Design — revised; ready to implement.** Builds ON the merged human-surface FSM (`docs/designs/evolve-human-surface-slice.md`, now on master: `preflight_review` / `human_escalation` / `final_summary` / `final_review` gates + the `aborted` terminal). This slice makes `evolve` problem-agnostic: any ASI-Evolve-style experiment runs by pointing the EXISTING `--workspace <dir>` flag at it, with ZERO per-experiment edits to `workflow.yaml`, `scripts/`, or `scripts/requirements.txt` — **and ZERO new flag, new mount, or new threading** (the experiment dir simply IS the run's workspace, mounted at `/workspace`). An independent critical review verified every load-bearing infra claim (the persistent venv, the evaluator-command seam, the resume/idempotency mechanics, the FSM-delta lint) and the doc has been revised against it. The two maintainer decisions (§13) — (1) initial-program seeding from the experiment dir, (2) the acceptance bar — are **DECIDED** at their recommended defaults (accepted by the maintainer); their recommended values are baked into the doc body. Only genuinely implementer-choice items remain open (§13).

Audience: IronCurtain workflow + docker-infrastructure engineer extending the merged human-surface `evolve` workflow package.

Implementation contract: this document names the exact `workflow.yaml` delta (the new `provision` agent state + the `initial:` change + its transition into `preflight`), the **reuse of the existing `--workspace <dir>` flag** as the experiment-dir staging mechanism (no new flag, no new mount, no new threading — `--workspace` is already plumbed through both `workflow start` and the daemon-backed `workflow run`), the generic `preflight` inference design (objective / evaluator / cognition-seed / initial-program inferred from the workspace root, with a clean fallback to the task string), the persistent-venv + provision-once invariant, the security posture, the lint story, and the binary completion gate (a CI-able synthetic-experiment integration fixture + the live circle-packing demonstration). It is precise enough to implement without re-deriving the human-gate machinery.

Predecessors (merged / designed, build ON — do not redesign):

- **Human-surface slice** — `docs/designs/evolve-human-surface-slice.md` (on master). Ships the gate surface (`preflight_review` / `human_escalation` / `final_review`), the `final_summary` agent state, and the `aborted` terminal at `src/workflow/workflows/evolve/workflow.yaml`. This slice inserts `provision` BEFORE that surface and does not touch any gate.
- **Multi-round slice** — `docs/designs/evolve-multi-round-slice.md` (PR #302). The hub-and-spoke loop, the `evolve_result.py` bridge, the vendored `evolve_core` engine, and the determinism invariants.
- **Reference experiment** — `donotcommit/ASI-Evolve/experiments/circle_packing_demo/` (the demonstration target; not committed).

---

## 1. Summary & goals

The merged `evolve` workflow is problem-bound in one specific way: `preflight` is prompted to author the objective, the evaluator command, the cognition seed, and (implicitly) the first candidate **from the task string**. To run a real ASI-Evolve experiment — the circle-packing benchmark, a custom search task — an operator today has to hand-craft those values, and a candidate that needs `scipy` cannot run because the base venv ships only `numpy`+`pyyaml`. This slice makes `evolve` **problem-agnostic**: an operator points the EXISTING `--workspace <dir>` flag at an ASI-Evolve-layout directory (mounted at `/workspace`, the run's `allowedDirectory`), and the workflow infers everything problem-specific from that directory's natural files — with **zero edits to `workflow.yaml`, `scripts/`, or `scripts/requirements.txt`** per experiment, and **zero new flag, mount, or threading**. The experiment dir simply IS the run's workspace: `provision` and `preflight` read its canonical files directly from `/workspace`, and the engine writes its run state into `/workspace/.evolve_runs/` and `/workspace/.workflow/` in place. The one-time generic plumbing IS the slice: a new `provision` agent state that installs the experiment's runtime dependencies into a persistent venv (once, idempotently, through the MITM registry proxy), reuse of the already-threaded `--workspace` flag as the experiment-dir source, and a generic `preflight` that reads the experiment's brief/evaluator/seed/initial-program instead of inventing them. After the slice, `--workspace .../circle_packing_demo` runs end-to-end with no per-experiment workflow edits.

`provision` is a **new agent state and the new `initial:` state**, inserted before the merged human-surface FSM:

```
provision (AGENT, new initial) ─ready→ preflight (AGENT, now experiment-aware)
                               ─blocked→ provision_review (GATE)        ← human path for an un-provisionable experiment

preflight ─ready→ preflight_review (GATE) ─APPROVE→ orchestrator (HUB) … (unchanged human-surface loop) …
          ─blocked→ failed                                              (unchanged)

… orchestrator ─complete→ final_summary (AGENT) → final_review (GATE) ─APPROVE→ done   (unchanged)
```

It is an **agent**, not a deterministic state, precisely because dependency inference is fuzzy: it reads whichever canonical files the experiment happens to ship (`requirements.txt` / `pyproject.toml` / `package.json` / `README`), installs what it finds into the persistent venv, and can recover from a missing system library or an oddly-named manifest. A deterministic state could not do that. Crucially, `provision` runs install **once** into a venv that lives in the workspace, so on resume the venv already exists and `provision` skips; and the `evaluate` state — which scores every candidate — **never installs and never touches the network**, so every candidate across every round is scored in byte-identically the same environment (§8).

### What ships this slice

- **`provision`** (`agent`, the new `initial:` state). Reads the experiment's canonical dependency files from the workspace root, installs the experiment's runtime deps into the persistent venv at run time through the MITM proxy, idempotently (skip if already provisioned), and emits `ready` to continue or `blocked` to route to a human gate. §4, §6.
- **Reuse of the existing `--workspace <dir>` flag** — the experiment dir IS the run's workspace, mounted at `/workspace` (the `allowedDirectory`). No new flag, no new mount, no new threading: `--workspace` is already plumbed through both `workflow start` (interactive, in-process) and `workflow run` (daemon-backed) → the `workflows.start` RPC → `controller.start`. §5.
- **Generic `preflight`** — `preflight` now infers the objective, evaluator command, cognition seed, and (decision 1) the initial program from the workspace root (`/workspace/*`), with a clean fallback to "author from the task string" when the workspace is a fresh/empty sandbox rather than an experiment dir (so the existing toy task still works). §7.
- **The persistent-venv + provision-once invariant** — the venv is created/extended once by `provision`; `evaluate` only consumes it. §8.

### Non-goals (out of scope)

- **No per-experiment workflow edits.** The bar is that `workflow.yaml`, `scripts/`, and `scripts/requirements.txt` are byte-unchanged across experiments. Anything experiment-specific is agent-inferred from `/workspace/*`. There is **no IronCurtain-specific experiment manifest** — the agent reads the experiment's own natural files.
- **No phase-scoped allowlist.** The MITM registry passthrough stays open for the whole run for now. Scoping the allowlist so registries are reachable only during `provision` (and closed during `evaluate`) is a deliberate future hardening, deferred (§9, §13).
- **No human-gate redesign.** The three gates, `final_summary`, and the `aborted` terminal from the human-surface slice are unchanged. This slice inserts `provision` _before_ them and adds at most one new gate (`provision_review`, §4.2) — it does not touch the orchestrator hub, the spokes, the determinism mechanics, or the vendored engine.
- **No baking deps into the image.** The base image and `scripts/requirements.txt` stay generic (`numpy`+`pyyaml`); scipy and any other experiment dep are installed at **run time** via the proxy, not added to the image.
- **Single-experiment-dir scope.** One `--workspace <dir>` (the experiment dir) per run, ASI-Evolve layout. Multi-experiment composition, experiment registries, and remote experiment fetch are out of scope.
- **No engine/bridge changes for the happy path.** The slice is `provision` (new state) + `preflight` prompt rework + reuse of the existing `--workspace` staging + tests. It adds **no new flag, no new mount, no new threading**, **no** `evolve_result.py` subcommand, and **no** `evolve_core` change — the evaluator is wired purely through the existing `run_spec.evaluation.command` shell-format seam (§3.2, §7.3).

### Goals (binary, restated as the gate — §11)

After this slice, the completion gate proves all of:

1. **The synthetic-experiment integration test** (CI-able, no LLM flakiness): with a tiny synthetic workspace dir (a one-line requirement + a trivial real evaluator), passed as `--workspace`, the run **provisions** the dep into the persistent venv, **evaluates real candidates via the experiment's own evaluator**, records **valid** scores into the engine DB, **best improves across rounds**, and reaches **`done`** — with concrete assertions on the venv sentinel, node scores, and lineage.
2. **`tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict` is clean** with the new `provision` state and the `initial:` change.
3. **The live circle-packing demonstration** (driven via the daemon-backed `workflow run / await / show / gate` loop, with `--workspace` pointed at the experiment dir) **provisions `scipy`**, **evaluates via the real `evaluator.py`**, **records valid sum-of-radii scores**, **best improves**, and reaches **`done`**. Reaching the 2.635 AlphaEvolve target is **aspirational, not gating** (it depends on the LLM and round count and is too flaky to gate).

---

## 2. The reference experiment — what `provision` and `preflight` must infer

The demonstration target is `donotcommit/ASI-Evolve/experiments/circle_packing_demo/` (not committed to this repo; it is the live-run fixture). Its layout is the canonical ASI-Evolve experiment shape. Each file below is the natural source `provision` or `preflight` reads — there is no IronCurtain manifest.

### 2.1 `input.md` (the brief → objective + success criteria)

`circle_packing_demo/input.md:1-40`. A human-readable problem statement: "Pack 26 circles in a unit square (1×1) to maximize the sum of their radii" (`:3-5`), the objective "Maximize: Σ(r_i)" (`:7-9`), constraints (inside the unit square, non-overlapping, `:11-14`), the target "sum of radii = **2.635**" (`:16-18`), and the required entry point — a `construct_packing()` returning `(centers, radii, sum_radii)` (`:22-33`). **`preflight` infers from this**: the `run_spec.objective` (one line), the `evaluation.success_criteria` (a human-readable bar like `eval_score >= 2.0`; the 2.635 target is the _aspiration_, not a hard success criterion — §11.3), and the candidate's interface contract (the `construct_packing()` signature) for the cognition seed / initial program.

### 2.2 `initial_program` (→ node 0 seed, decision 1)

`circle_packing_demo/initial_program:1-85`. A single, extensionless Python file: `construct_packing()` (`:5-47`) places 26 circles in a structured ring pattern and `compute_max_radii()` (`:50-84`) shrinks radii to remove overlaps. It imports **only `numpy`** (`:2`) — it does _not_ need scipy (scipy is what _evolved_ candidates use). This is the faithful ASI-Evolve baseline (the `--workspace` Quick Start runs from it, `README.md:32-39`). **Decision 1 (§7.4)**: seed engine node 0 from this file when present (faithful; matters for reaching ~2.635), vs keep "researcher invents candidate #1". Recommended: **seed-from-experiment when present**.

### 2.3 `evaluator.py` + `eval.sh` (→ the score oracle, wired via `run_spec.evaluation.command`)

`circle_packing_demo/evaluator.py` is the **precise score oracle the experiment ships** — `preflight` plumbs it, it does NOT invent scoring. Its CLI contract (`:361-385`): `python evaluator.py <code_file> <output_json>` — it loads the candidate by `exec`-ing the file's source (`:105-118`; handles extensionless candidate files, which the engine writes as `steps/<step>/code`), calls `construct_packing()`, validates the packing (`:26-73`: NaN/negative-radius/out-of-bounds/overlap checks with a `1e-6` tolerance), computes `sum_radii`, and writes a JSON with `eval_score` = `combined_score` = `sum_radii` plus `success`/`score`/`complexity` (`:375-385`). It **needs `numpy`** at evaluate time (`:6`); candidates it scores commonly **need `scipy.optimize`** (the cognition heuristics push SLSQP). `eval.sh` (`:1-95`) is a bash wrapper that locates the step dir, runs `python3 evaluator.py code results.json`, and post-processes — **the harness does NOT need `eval.sh`**: it wires `evaluator.py` directly through `run_spec.evaluation.command` (§3.2, §7.3), because the bridge already shell-formats `{quoted_code_path}` / `{quoted_results_path}` and runs from the workspace root (so the step-dir-locating logic in `eval.sh` is redundant). **`preflight` infers from this**: `evaluation.command = "/opt/workflow-venv/bin/python /workspace/evaluator.py {quoted_code_path} {quoted_results_path}"` and `evaluation.core_score = "eval_score"`. Because the evaluator now lives at the workspace root and `cmd_eval_run` runs from the workspace root, the `/workspace/evaluator.py` path is reachable; `ensure_path_allowed` gates only the candidate `source_code` path, not the evaluator path, so this command is allowed (§3.2).

### 2.4 `init_cognition.py` (→ cognition seed CONTENT, not an executable)

`circle_packing_demo/init_cognition.py:1-107`. A script that registers **12 domain heuristics** (`:21-86`) — hexagonal packing density, edge effects, variable-radii strategy, `scipy.optimize.minimize` SLSQP usage, multi-start, `differential_evolution`, plateau-breaking at ~2.3, numerical stability, the n=26 target — into an ASI-Evolve cognition store. **It cannot run in our container**: it imports `from Evolve.cognition.cognition import Cognition` (`:12-13`), the _non-vendored_ ASI-Evolve package, not our vendored `evolve_core`. So `preflight` must **infer the seed content** (the 12 heuristics) and write them into `<run_dir>/cognition_seed.md` as ```json fenced blocks (the format `evolve_result.py sample`seeds from, §3.2), NOT run`init_cognition.py`. The `CognitionItem(content=..., source=..., metadata=...)` triples (`:23-85`) map directly onto the seed JSON objects.

### 2.5 `config.yaml` (informational — NOT consumed by our harness)

`circle_packing_demo/config.yaml:1-101`. ASI-Evolve-native run configuration: an sglang API endpoint (`:9-25`), W&B logging (`:28-36`), pipeline agent toggles (`:38-63`), island-sampler + MAP-Elites database config (`:79-101`). **Our harness does not consume this file** — our sampler/budget/model come from the IronCurtain `run_spec` and `workflow.yaml settings`, not the experiment's `config.yaml`. `preflight` may _read_ it as a hint (e.g. `sample_n: 3` at `:59`, `diff_based_evolution: false` at `:46`) but must not depend on it; treat it as advisory only. (`prompts/researcher.jinja2`, `prompts/analyzer.jinja2` are likewise ASI-Evolve-native and ignored — our researcher/analyzer prompts live in `workflow.yaml`.)

### 2.6 Inference summary table

| Experiment file (at workspace root)                        | Read by                  | Infers / produces                                                                                                   |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `requirements.txt` / `pyproject.toml` / `README.md` (deps) | **`provision`**          | runtime deps to `uv pip install` into the persistent venv (circle-packing: `numpy` always; candidates need `scipy`) |
| `input.md`                                                 | `preflight`              | `run_spec.objective`, `evaluation.success_criteria`, candidate interface contract                                   |
| `evaluator.py`                                             | `preflight`              | `run_spec.evaluation.command` (points at `/workspace/evaluator.py`), `evaluation.core_score = eval_score`           |
| `initial_program`                                          | `preflight` (decision 1) | engine **node 0** seed (the baseline candidate)                                                                     |
| `init_cognition.py`                                        | `preflight`              | `<run_dir>/cognition_seed.md` content (the 12 heuristics → ```json seeds); the script is NOT executed               |
| `config.yaml`, `prompts/*`                                 | (advisory)               | hints only; not consumed                                                                                            |

**Important inference note for `provision` (explicit — not a silent assumption):** circle-packing ships **no `requirements.txt`** of its own (the deps live in the ASI-Evolve repo-root `requirements.txt`, referenced by `README.md:32-33`, which is _outside_ the demo dir). So a `--workspace` pointed at the bare `circle_packing_demo/` dir gives `provision` no manifest, and it must infer `numpy`+`scipy` from the **README + evaluator/cognition source** (the README's Quick Start and the `import scipy` references in `init_cognition.py:40,49`). This is exactly why `provision` is a **fuzzy agent**, not a deterministic `pip install -r` step.

For the live demonstration the operator picks ONE of two dispositions — state it plainly, do not leave it implicit:

- **(i) Point `--workspace` at a dir that includes a `requirements.txt` listing `scipy`** — a thin copy of the demo dir (copy `circle_packing_demo/` and drop a one-line `requirements.txt: scipy` beside it). This makes the live run take the deterministic explicit-manifest branch, matching the synthetic fixture's path.
- **(ii) Point `--workspace` at the bare demo dir and rely on `provision` inferring `scipy`** from the README + `init_cognition.py` imports. This is the fuzzier path and is what actually exercises the prompt's inference (the part CI cannot reach).

The division of coverage is deliberate and explicit: **the synthetic CI fixture (§11.1) deterministically covers the explicit-manifest path** (it ships a one-line `requirements.txt`, and the install is driven by the mock branch's `infra.docker.exec`, §11.1), while **the live run (§11.3) — under disposition (ii) — is the only thing that exercises real dependency inference**. Either live disposition reaches the gate; disposition (ii) additionally demonstrates the inference story. (This was OQ#4; resolved here rather than deferred to §13.)

---

## 3. The current evolve package — what this slice extends (cite, do not re-derive)

Every fact below is verified in the current tree. The implementer should rely on these citations.

### 3.1 The current FSM (`initial: preflight`)

`src/workflow/workflows/evolve/workflow.yaml`. `initial: preflight` (`:3`). `settings.mode: docker`, `dockerAgent: claude-code`, `sharedContainer: true`, `maxRounds: 200` (`:5-16`). States: `preflight` (agent, `:19-86`, authors the run spec via `evolve-brief normalize` and the cognition seed, emits `ready`/`blocked`), `preflight_review` (gate, `:88-105`), `orchestrator` (agent hub, `:107-160`), spokes `sample`/`researcher`/`evaluate`/`analyzer`/`analysis_record` (`:162-294`), `human_escalation` (gate, `:296-314`), `final_summary` (agent, `outputs: [final_report]`, `:316-357`), `final_review` (gate, `:359-375`), terminals `done`/`failed`/`aborted` (`:377-389`). **This slice changes `initial:` to `provision` and inserts the `provision` state before `preflight`; it touches nothing else in the FSM** except the `preflight` prompt/IO (§4, §7).

`preflight` already declares `outputs: [run_spec, cognition_seed]` (`:79-81`) and copies them into `.workflow/run_spec/` and `.workflow/cognition_seed/` (`:61-66`) so `preflight_review` can present them — this slice keeps that and adds experiment-inference to the prompt.

### 3.2 The `scripts/` bridge + vendored engine — the evaluator-command seam

`src/workflow/workflows/evolve/scripts/`:

- **`requirements.txt`** = `numpy` + `pyyaml` only. **Stays unchanged** — it is the generic base venv (§8). The base image's `provisionWorkflowPythonDependencies` installs exactly these into `/opt/workflow-venv` before any state runs (§5.2).
- **`evolve_result.py`** = the IronCurtain bridge. The `evaluate` subcommand (`evolve_result.py:174-240`) calls the `evolve-eval run` helper with the candidate `--code-path` (workspace-relative) and `--step-name`, then maps the engine result to `{verdict, payload, passed}`: `evaluated` when engine return code 0 and a numeric `eval_score`/`score` is present, else `evaluator_blocked` (`:226-239`, `_numeric_score` at `:154-160`).
- **`evolve_core/`** = the vendored ASI-Evolve engine. **Byte-verbatim invariant — do not modify.** The evaluator execution lives in `evolve_core/cli.py:243` `cmd_eval_run`: it reads `spec.evaluation.command` (or `script_path`, `:262-263`), formats the template with `command_context` (`:98-120`, which supplies `{code_path}`/`{results_path}`/`{script_path}` and their `{quoted_*}` variants), and runs `subprocess.run(formatted, shell=True, cwd=workspace_root, timeout=...)` (`:274-298`). The candidate is copied into `steps/<step>/code` and `{quoted_code_path}` points at it; `{quoted_results_path}` points at `steps/<step>/results.json` (`:255-283`).

**The wiring seam (load-bearing, confirmed):** the experiment's evaluator is wired purely by setting `run_spec.evaluation.command`. For circle-packing (the evaluator now lives at the workspace root, `/workspace/evaluator.py`):

```
evaluation.command = /opt/workflow-venv/bin/python /workspace/evaluator.py {quoted_code_path} {quoted_results_path}
```

When `evaluate` runs, `cmd_eval_run` shell-formats this to an absolute `python /workspace/evaluator.py "<step>/code" "<step>/results.json"` and runs it from the workspace root. `evaluator.py` writes `eval_score` into `results.json`; the bridge reads it and emits `evaluated`. **No engine change, no new bridge subcommand** — the slice only needs `preflight` to author this `command` string (§7.3). `ensure_path_allowed` (`run_state.py:300-318`) gates only the _candidate_ code path against `mutation_scope.writable_paths`, not the evaluator path, so pointing the command at the experiment's own `/workspace/evaluator.py` is allowed.

**Cognition seeding seam:** `evolve_result.py sample` (`:243-354`) seeds cognition from `<run_dir>/cognition_seed.md` on the first round when the cognition store is empty (`:251-274`), parsing ```json fenced blocks. So `preflight`writes the experiment's heuristics into`cognition_seed.md` (§7.1); the seed is consumed deterministically at round 1 — no separate "run init_cognition" step.

### 3.3 The run-spec schema (`evolve_core/run_state.py`)

`DEFAULT_RUN_SPEC` (`run_state.py:21-56`) and `REQUIRED_FIELD_CHECKS` (`:58-98`). The fields this slice wires:

- `evaluation.{core_score, command, script_path, timeout_secs, success_criteria}` — `command` or `script_path` is required (`:63-66`); the harness sets `command`. `core_score` required (`:60-62`). `timeout_secs > 0` (`:67-70`), `success_criteria` non-empty (`:71-73`).
- `cognition.{source_mode, seed_files, seed_notes}` — `source_mode` required (`:95-97`); the harness uses `seed` and writes `cognition_seed.md`.
- `mutation_scope.{writable_paths, primary_targets}` — both required non-empty (`:78-83`); the candidate target is `candidate.py` under `.evolve_runs`.
- `budget.{max_rounds, patience}`, `stop_conditions`, `sampling.{algorithm, sample_n}` — required (`:74-77`, `:84-87`).
- `approval.confirmed` — `require_evolve_ready` (`:288-297`) rejects any mutating helper until this is `true` **and** no fields are missing. It does **not** read `budget.max_rounds`; the orchestrator owns the round budget (carried over from the human-surface slice §8.3).

`evolve-brief normalize` (`cli.py:123-220` `cmd_brief_normalize`) is the CLI that writes the spec; `preflight` already invokes it (`workflow.yaml:33-49`). This slice changes only the _values_ `preflight` passes (`--objective`, `--evaluation-command`, `--success-criterion`, etc.), inferred from the workspace root `/workspace/*` instead of the task string.

### 3.4 How an agent state is declared

WORKFLOWS.md §"Agent states" (`:476-507`): `type: agent`, `persona` (`"global"` or a persona name), `prompt`, `inputs`/`outputs` (artifact dirs under `.workflow/`, trailing `?` = optional), `transitions` (`when` declarative / `guard` context-based), optional `freshSession` (default `true`), optional `maxVisits`. `outputs: []` for code-only states. The existing evolve agent states (`orchestrator`, `researcher`, `analyzer`) are the in-package precedent; `provision` follows the same shape (§4.1).

---

## 4. FSM delta — concrete `workflow.yaml` edits

All edits are against the current merged `src/workflow/workflows/evolve/workflow.yaml`. The delta is small: change `initial:`, add the `provision` agent state, add one gate (`provision_review`) for the blocked path, and (separately, §7) rework the `preflight` prompt. The orchestrator hub, the spokes, the three human-surface gates, `final_summary`, and the terminals are **unchanged**.

### 4.1 The `initial:` change and the `provision` state

**Current** (`workflow.yaml:3`):

```yaml
initial: preflight
```

**Edit:**

```yaml
initial: provision # CHANGED: was `preflight`
```

**New agent state** (insert before `preflight`):

```yaml
provision:
  type: agent
  description: >
    Install the staged experiment's runtime dependencies into the persistent
    workflow venv, once. Idempotent: skips when the venv is already provisioned.
  persona: global
  prompt: |
    You are provisioning the Python environment for an Evolve experiment BEFORE
    any candidate is evaluated. The experiment's files (if this run was given one)
    live at the WORKSPACE ROOT, /workspace — the experiment dir IS the run's
    workspace. Treat the experiment's own source files (the evaluator, input.md,
    initial_program, requirements) as READ-ONLY by convention: do NOT modify them.
    Your run state goes under /workspace/.evolve_runs/ and /workspace/.workflow/.
    The persistent virtual environment lives at /opt/workflow-venv (a SEPARATE
    mount, not under /workspace) and ALREADY contains the workflow's base
    dependencies (numpy, pyyaml).

    Your job: make sure every dependency the experiment's evaluator and its
    candidates need is installed into /opt/workflow-venv, exactly once.

    DURABILITY MODEL (read first — it governs every step below). Two kinds of
    install live in this container, and they survive a resume DIFFERENTLY:
      - pip/uv installs into /opt/workflow-venv are RESUME-DURABLE: the venv is
        a host-mounted directory, so on `workflow resume` the same venv is
        re-mounted with its packages intact.
      - apt / system-library installs are NOT resume-durable: resume mints a
        FRESH container, so anything installed into the container filesystem
        (apt packages, the .so files they drop) is GONE on resume.
    Therefore the .provisioned marker gates ONLY the durable venv install. apt
    steps are re-applied on EVERY entry to this state (they are no-ops within a
    run when the lib is already present, and they reinstall into the fresh
    container on resume). NEVER let the marker short-circuit an apt step.

    1. DURABLE-VENV SKIP CHECK. First check for the marker file
       /workspace/.evolve_runs/main/.provisioned. If it exists, the venv was
       already provisioned on a prior run or a prior visit — do NOT re-run the
       pip install. Verify the venv still imports the recorded packages (run
       `/opt/workflow-venv/bin/python -c "import numpy"` plus any package names
       listed in the marker). If they import, the durable venv is intact: SKIP
       the pip install but STILL run the system-library step (step 3b) before
       emitting verdict: ready (apt libs may have vanished on a resume).

    2. INFER DEPENDENCIES. Look at the workspace root /workspace. If it holds no
       experiment files (it is a fresh/empty sandbox — no evaluator, no
       input.md, no manifest), there is nothing experiment-specific to install:
       the base venv is sufficient — write the marker (step 4) and emit
       verdict: ready. Otherwise read, in this order, whichever exist at the
       workspace root /workspace (ignore the run-state subtrees .evolve_runs/ and
       .workflow/):
         - requirements.txt / pyproject.toml / setup.cfg / setup.py  (explicit deps)
         - README / README.md                                         (a "pip install" / "requirements" line)
         - the evaluator and any *cognition* / *init* script source   (import statements:
           a candidate that imports scipy means scipy must be installed)
       Build the minimal set of third-party packages the EVALUATOR needs to run
       and that CANDIDATES are expected to import (for circle packing this is
       numpy — already present — plus scipy). Note: scipy ships as a self-
       contained PyPI wheel with bundled BLAS, so the circle-packing demo needs
       NO apt step — the pip install is sufficient. apt is only for the rare
       wheel that links an unbundled system library.

    3a. INSTALL THE DURABLE VENV DEPS (through the proxy). Skip this sub-step
       entirely if step 1 already verified the marker. Otherwise, for each
       needed package, install it into /opt/workflow-venv using uv:
         UV_NATIVE_TLS=1 VIRTUAL_ENV=/opt/workflow-venv uv pip install <pkg> [<pkg> ...]
       Network egress is mediated by the IronCurtain MITM proxy
       (HTTPS_PROXY/HTTP_PROXY are already set); registries are reachable.
       Prefer a requirements.txt install when the workspace ships one:
         UV_NATIVE_TLS=1 VIRTUAL_ENV=/opt/workflow-venv uv pip install -r /workspace/requirements.txt

    3b. RE-APPLY SYSTEM LIBRARIES (every entry, NOT gated by the marker). If —
       and only if — a wheel genuinely needs an unbundled system library, run
       `sudo apt-get install -y <lib>` (apt is also proxied) on EVERY entry to
       this state, before the import verification. `apt-get install` is a no-op
       when the lib is already present (so it is cheap within a run) and it
       reinstalls into the fresh container on resume (so the .so is restored).
       Record the apt package names in a SEPARATE marker
       /workspace/.evolve_runs/main/.apt-provisioned (one per line) for your own
       reference, but do NOT use that marker to skip the apt step — system libs
       must be re-applied unconditionally because the container filesystem does
       not survive resume. For circle packing there is no apt step (scipy's
       wheel bundles BLAS), so this sub-step is a no-op for the demo path.

    4. VERIFY + MARK. Confirm each needed package imports:
         /opt/workflow-venv/bin/python -c "import scipy, numpy"
       Then write /workspace/.evolve_runs/main/.provisioned containing one line
       per VENV (pip) package name (so a later visit can re-verify the durable
       venv cheaply). The marker records only the durable venv deps — apt
       packages are tracked separately (step 3b) and are never marker-gated.
       Create /workspace/.evolve_runs/main/ first if needed.

    Finish with the required agent_status block:
      - verdict: ready  — the venv now has everything the experiment needs (or the
        workspace holds no experiment files and the base venv suffices).
      - verdict: blocked — a dependency cannot be installed (registry refuses it,
        a system lib is unavailable, the experiment's deps are uninferable). Put
        the specific failure in your status so a human can act on it.
  inputs: []
  outputs: []
  transitions:
    - to: preflight
      when: { verdict: ready }
    - to: provision_review
      when: { verdict: blocked }
```

Notes on the design:

- **`outputs: []`** — `provision` writes to the venv (`/opt/workflow-venv`) and a marker under `.evolve_runs/main/`, not to a `.workflow/<name>/` artifact dir. It is a "code-only" state (WORKFLOWS.md `:503`), like the spokes that write to the workspace root. (If the maintainer wants the install log surfaced at a gate, `provision` could declare `outputs: [provision_log]` and write `.workflow/provision_log/provision_log.md`; deferred as a lower-stakes option, §13.)
- **`inputs: []`** — it reads the workspace root `/workspace` and the venv directly (absolute container paths), not `.workflow/` artifacts, so nothing is declared as an input (the same pattern `final_summary` uses for reading `.evolve_runs/main/`, human-surface §6.1).
- **No `maxVisits`** — `provision` is entered once on the initial path and (on resume) re-entered idempotently; it does not loop in the steady state. The `isRoundLimitReached` wedge backstop (counted over agent visits) still applies as a global safety bound.
- **The marker gates the durable venv only, NOT system libs (load-bearing).** `orchestrator.ts:1412-1422` is explicit that resume does NOT reclaim the original container — "any dependencies installed in the previous run are lost" — and the first state to run after resume mints a fresh container. The host-mounted `/opt/workflow-venv` survives that (it is a bind mount), so pip/uv installs are resume-durable and the `.provisioned` marker may safely skip them. apt/system-library installs land in the (ephemeral) container filesystem and do NOT survive, so they MUST be re-applied on every `provision` entry and MUST NOT be short-circuited by the marker (prompt step 3b). The failure this prevents: a candidate's wheel needs an apt-provided `.so`; the first run installs it via apt and writes the marker; on resume the marker causes a skip, the container is fresh, the `.so` is gone — `import scipy` still succeeds (scipy is in the durable venv) but the candidate fails at `evaluate` with a missing `.so`. Recording apt names in a separate `.apt-provisioned` marker keeps the two install classes distinct (§6.2). The circle-packing demo sidesteps this entirely — scipy's PyPI wheel bundles BLAS, so the demo path is pip-only with no apt step.

### 4.2 `provision` failure routing (`blocked → provision_review`)

A `blocked` provision is **human-actionable** (the registry refused a package, a system lib is missing, the deps are uninferable) — exactly the kind of stop the human-surface slice routes to a gate rather than the opaque `failed` terminal. So `provision ─blocked→ provision_review`, a new `human_gate` mirroring the human-surface gates:

```yaml
provision_review:
  type: human_gate
  description: >
    Human review when the experiment's dependencies could not be provisioned.
    Approve to retry provisioning, force a revision to re-infer the deps, or abort.
  acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]
  transitions:
    - to: provision
      event: APPROVE
      actions:
        - { type: resetVisitCounts, stateIds: [provision] }
    - to: provision
      event: FORCE_REVISION
      actions:
        - { type: resetVisitCounts, stateIds: [provision] }
    - to: aborted
      event: ABORT
```

- **No `present:` artifacts.** The gate has nothing agent-produced to show (provision writes the venv, not a `.workflow/` artifact), so `present:` is omitted — which is WF004-clean (an empty/absent `present:` references no producer). The failure reason rides the gate `summary` via `context.lastError` (the human-surface slice's automatic suffix, §5/§9 of that doc). The human inspects the container/venv out-of-band if they want detail. (If the maintainer prefers a visible log, add `provision.outputs: [provision_log]` per §4.1 and `present: [provision_log]` here — lower-stakes, §13.)
- **Both `APPROVE` and `FORCE_REVISION` route back to `provision`** (with `resetVisitCounts: [provision]` so the retry does not accumulate toward the wedge backstop). `APPROVE` = "I fixed the environment out-of-band, retry as-is"; `FORCE_REVISION` (with the required feedback `prompt`, e.g. "the package is named `scipy` not `scipy.optimize`") = "re-infer the deps with this hint" — the feedback reaches `provision` as `context.humanPrompt` (human-surface §3.3). `ABORT → aborted` reuses the existing terminal.
- **`provision_review` reaches a terminal** (`aborted` via `ABORT`), so WF001 is satisfied; it is reachable from `provision`, so it is not orphaned (§10).

**OPEN QUESTION (§13):** an alternative is `provision ─blocked→ failed` (no new gate), matching the existing `preflight ─blocked→ failed` hard-fail. That is simpler (no new state) but loses the human recovery path. Recommended: the gate, for symmetry with the human-surface slice's "human-actionable stops get a gate" principle — but the maintainer may prefer the simpler hard-fail. Both are specified so the implementer can pick after sign-off.

### 4.3 Full extended states map (delta summary)

| State                                                  | Status     | Type       | Note                                                                                                                                                    |
| ------------------------------------------------------ | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision`                                            | **new**    | agent      | §4.1; new `initial:` state                                                                                                                              |
| `provision_review`                                     | **new**    | human_gate | §4.2 (recommended; the `→ failed` alternative drops it)                                                                                                 |
| `preflight`                                            | **edited** | agent      | prompt/IO reworked to infer from the workspace root `/workspace` with a task-string fallback (§7); transitions unchanged (`ready → preflight_review`, `blocked → failed`) |
| `preflight_review` … `final_review`, spokes, terminals | unchanged  | —          | the entire human-surface FSM is preserved verbatim                                                                                                      |

Net: `initial: provision`, one new agent state, one new gate (recommended), and a `preflight` prompt rework. No edge in the merged FSM is retargeted (unlike the human-surface slice); `provision` is a clean prepend.

---

## 5. The staging mechanism — reuse the existing `--workspace` flag

There is **no new infrastructure** here. The experiment dir is supplied via the **existing `--workspace <dir>` flag**, and the experiment dir simply IS the run's workspace: it is the run's `allowedDirectory`, mounted read-write at `/workspace`. `provision` and `preflight` read the experiment's canonical files (`requirements.txt`/`pyproject.toml`/`README`, and the evaluator/`input.md`/`initial_program`) directly from the workspace root; the engine writes its run state into `/workspace/.evolve_runs/` and `/workspace/.workflow/` in place. Because `--workspace` already exists and is already threaded all the way through both entry points (CLI → RPC → `controller.start`), **the entire `--experiment`-threading work that an earlier draft of this slice contemplated is DROPPED**: no new flag, no new mount, no new factory-wrapper threading, no new checkpoint field. This shrinks the slice substantially — what is left is the `provision` agent state, the `preflight` prompt rework, and tests.

### 5.1 `--workspace` is already plumbed through BOTH entry points

The flag already exists and is already wired through both the interactive in-process path and the daemon-backed path — this is the existing plumbing the slice reuses, not new work:

- **`workflow start`** (interactive, in-process) — `src/workflow/workflow-command.ts` already parses `--workspace`, resolves+validates the path, and passes it into `orchestrator.start(...)` as `workspacePath`.
- **`workflow run`** (daemon-backed) — `src/workflow/daemon-gate-commands.ts` already accepts `--workspace` and forwards it as `workspacePath` in the `workflows.start` RPC `params`, which the dispatch handler (`src/web-ui/dispatch/workflow-dispatch.ts`) passes into `controller.start(definitionPath, task, workspacePath?)`.

So both the interactive `workflow start` and the daemon-backed `workflow run` (the path the live circle-packing demonstration uses, §11.3) already accept the experiment dir with zero new flag work. The live run uses `workflow run evolve "<task>" --workspace <experiment-dir>` (§11.3).

### 5.2 The workspace mount and the persistent venv (existing seams, unchanged)

The experiment dir is mounted at `/workspace` by the **existing** workspace-mount machinery in `src/docker/docker-infrastructure.ts` — the same read-write workspace mount every workflow already uses (the `allowedDirectory`). There is **no new mount and no `/experiment` constant**. The validated `--workspace` path replaces the per-session sandbox as `allowedDirectory` (see `src/session/workspace-validation.ts`), exactly as it does today for any workflow run, and the container sees it at `/workspace`.

The persistent venv is a **separate** mount and is unchanged by this slice. `prepareWorkflowDependencyMounts` (`docker-infrastructure.ts`) creates a host-cached venv dir keyed on `computeWorkflowDependencyHash(agentBuildHash, scriptsDir)` (hashes `requirements.txt`/`package.json` **only**, NOT the experiment), mounts it read-write at `/opt/workflow-venv`, and `provisionWorkflowPythonDependencies` installs the base `requirements.txt` into it via an in-container `infra.docker.exec` of `uv venv` + `uv pip install -r /workflow-scripts/requirements.txt`, guarded by a `.ironcurtain-provisioned-<cacheKey>` sentinel and a host-side `withProvisionLock`. **So when `provision` runs, the base venv already has numpy+pyyaml; `provision` only `uv pip install`s the experiment's _additional_ deps (scipy) on top.** The venv lives at `/opt/workflow-venv`, OUTSIDE the workspace, so it is not part of the experiment dir and is not affected by anything written under `/workspace`. The base image ships `uv` (`/usr/local/bin/uv`), Python 3.12, `python3-pip`, and `UV_NATIVE_TLS=1` (`docker/Dockerfile.base:14-30`, `Dockerfile.base.arm64:43-59`) — confirmed; no image change is needed.

**Why the experiment is NOT folded into the venv cache key:** `computeWorkflowDependencyHash` is intentionally keyed on the _workflow's_ manifests so the host venv cache is shared across runs of the same workflow. The experiment's deps are installed at _run time_ by the agent `provision` state into that same mounted venv, recorded by the in-workspace `.provisioned` marker (not the host cache sentinel). This keeps the base-venv cache reusable while letting each experiment add its own deps per-run. (The base sentinel `.ironcurtain-provisioned-<cacheKey>` and the experiment marker `.evolve_runs/main/.provisioned` are deliberately separate — one is host-cache-scoped, the other run-scoped.)

### 5.3 Run state is written into the workspace in place

`.evolve_runs/` and `.workflow/` are written into the workspace in place — this is the existing engine-native layout `<workspace>/.evolve_runs/main/` and `<workspace>/.workflow/`, the same layout every evolve run already uses. There is no separate run dir to thread or copy; the experiment dir and the run dir are the same directory. The experiment dir therefore **accumulates those two subtrees** (`.evolve_runs/` and `.workflow/`) over the run. This is acceptable for a scratch/demo experiment dir (both subtrees are gitignore-able, and they are exactly what `workflow inspect` / a gate later reads). If the operator wants the original experiment dir to stay pristine, they point `--workspace` at a copy of it — an operator choice (§13), not a harness requirement. The in-place default is what makes this slice require zero new threading.

Because `evolve` runs `sharedContainer: true`, there is one bundle (one `/workspace` mount) shared by every state's session — `provision`, `preflight`, and `evaluate` all see the same `/workspace`.

### 5.4 How `provision` / `preflight` learn the path

The path is a **fixed container constant**: the workspace root, `/workspace`. Neither state needs the host path — the prompts reference `/workspace` literally (the `provision` prompt in §4.1, the `preflight` prompt in §7). This mirrors how the existing prompts hardcode `/workspace/.evolve_runs/main/` and `/workflow-scripts/`. When the operator does not point `--workspace` at an experiment dir (a fresh/empty sandbox), the workspace root simply holds no experiment files, and both prompts branch on their absence (`provision`: base venv suffices, §4.1 step 2; `preflight`: author from the task string, §7.2). No env var or dynamic path injection is required — the constant workspace mount path is the contract.

---

## 6. The `provision` agent state in detail

The full prompt is in §4.1; this section justifies the design choices.

### 6.1 What provision infers and installs

`provision` reads the experiment files at the workspace root `/workspace` and installs the experiment's runtime deps into `/opt/workflow-venv` via `uv pip install` (the same tool the base provisioning uses, §5.2). The inference order — explicit manifests (`requirements.txt`/`pyproject.toml`) first, then README, then import-statement scanning of the evaluator/cognition source — is exactly the fuzzy reasoning that makes this an **agent, not a deterministic `pip install -r`**:

- For the **synthetic CI fixture** (§11.1), `/workspace/requirements.txt` exists, so the deterministic branch fires (`uv pip install -r /workspace/requirements.txt`).
- For **circle-packing**, there is no `requirements.txt` at the workspace root (it lives in the ASI-Evolve repo root, outside the demo dir — §2.6). `provision` infers `scipy` from `README.md`'s install line and the `import scipy` references in `init_cognition.py:40,49`, then `uv pip install scipy`. `numpy` is already in the base venv, so it is a no-op.

The install goes **through the MITM proxy**: the container has `HTTPS_PROXY`/`HTTP_PROXY` set to the MITM (`docker-infrastructure.ts:1042-1043` macOS TCP; the Linux UDS branch is parallel), the MITM allowlist includes registries (PyPI) when `packageInstall` is enabled (`mitm-proxy.ts:1392`), and `uv` uses the system TLS stack via `UV_NATIVE_TLS=1` (baked into the base image) so it trusts the IronCurtain CA. If a wheel needs a system library, the prompt permits `sudo apt-get install` (apt is also proxied via the apt-proxy config, `docker-infrastructure.ts:1044-1046`) — the recovery path that justifies a fuzzy agent.

### 6.2 Idempotency / skip-on-resume

Three install classes, with DIFFERENT durability and therefore different idempotency handling (§5.2). The split is load-bearing: it follows directly from `orchestrator.ts:1412-1422` ("resume does NOT reclaim the original containers — any dependencies installed in the previous run are lost; the first state to run mints a fresh container").

- **Base venv** (numpy/pyyaml): provisioned once by `provisionWorkflowPythonDependencies` before any state runs, guarded by the host-cache sentinel `.ironcurtain-provisioned-<cacheKey>`. `provision` never re-does this. Resume-durable (host-mounted venv).
- **Experiment venv deps** (scipy — pip/uv into `/opt/workflow-venv`): **resume-durable.** `provision` writes `/workspace/.evolve_runs/main/.provisioned` (one package name per line) after a successful install. On any re-entry — a resume (`workflow resume`), a `provision_review APPROVE` retry, or a second visit — the prompt's **step 1** checks for that marker, re-verifies the packages import, and skips the pip install. The marker AND the venv it gates both persist across container recreations: the marker lives in the bind-mounted workspace (`.evolve_runs/main/`), and the venv is the host-cached mount, so the import re-verification normally succeeds instantly. The marker may safely short-circuit this class because the thing it gates is genuinely durable.
- **Experiment system libs** (apt — into the container filesystem): **NOT resume-durable.** Resume mints a fresh container, so apt packages and their `.so` files are gone — even though the marker is still present in the workspace and `import <pkg>` from the durable venv still succeeds. The marker therefore must NOT gate apt; `provision` re-applies any required `sudo apt-get install` on **every entry** (prompt step 3b). `apt-get install` is a no-op within a run when the lib is already present, and reinstalls into the fresh container on resume. apt names are tracked in a separate `.apt-provisioned` marker that is documentary only (it never causes a skip). The circle-packing demo has no apt step (scipy's wheel bundles BLAS), so for the demo this class is empty.

**The provision-once invariant — corrected for the apt case.** For the resume-durable venv deps, the network is touched only on the first successful provision; every subsequent entry is a marker check + import probe, no pip install, no registry traffic. For system libs this is FALSE: the import probe can pass (scipy imports from the durable venv) while a required apt `.so` is missing after a resume, so the apt step is re-run unconditionally on every entry — it is not gated by the marker and not skipped on the strength of a passing import probe. (Within a single run all three classes are installed once; the apt re-application only does real work after a resume into a fresh container. The marker remains a fast-path for the venv class; the venv mount is the actual durable state — if the marker is lost but the venv is intact, `provision` re-runs the pip install, which `uv` makes near-instant since already-satisfied packages are no-ops, and re-writes the marker.)

### 6.3 The verdict contract (ready / blocked)

`provision` emits exactly one of:

- **`ready`** — the venv has every dep the experiment needs (or no experiment was staged and the base venv suffices). Routes to `preflight`.
- **`blocked`** — a dep cannot be installed (registry refuses the package, a system lib is unavailable, deps are uninferable). The specific failure goes in the agent status, surfaces in the `provision_review` gate `summary` via `context.lastError`, and a human decides retry (`APPROVE`) / re-infer with a hint (`FORCE_REVISION`) / abort (§4.2).

This mirrors `preflight`'s existing `ready`/`blocked` contract (`workflow.yaml:76-77`), so the orchestrator's verdict-handling and the human-surface gate machinery apply unchanged.

---

## 7. Generic `preflight`

`preflight` is reworked from "author the run spec from the task string" to "infer the run spec from the workspace root `/workspace` when it holds experiment files, else author from the task string." The state, its transitions (`ready → preflight_review`, `blocked → failed`), and its `outputs: [run_spec, cognition_seed]` are **unchanged** — only the prompt and the _values_ it passes to `evolve-brief normalize` change.

### 7.1 Inference from the experiment dir (the workspace root)

When the workspace root `/workspace` holds experiment files, the reworked `preflight` prompt instructs the agent to read the experiment's natural files (§2) and derive each `run_spec` field, then call `evolve-brief normalize` with the inferred values (instead of the task-string-derived values it uses today). Concretely:

- **Objective** ← `/workspace/input.md` (or the brief file it finds) → `--objective "<one-line objective>"`. For circle-packing: "Pack 26 circles in a unit square to maximize the sum of their radii (target 2.635)."
- **Evaluator** ← `/workspace/evaluator.py` → `--evaluation-command "/opt/workflow-venv/bin/python /workspace/evaluator.py {quoted_code_path} {quoted_results_path}"` and `--core-score eval_score`. The agent **plumbs the experiment's shipped evaluator; it does NOT invent scoring** (§2.3). It confirms the evaluator's CLI shape (read `evaluator.py`'s `__main__` / argv handling) so the `{quoted_*}` placeholders map to the evaluator's positional args.
- **Success criterion** ← the brief's target → `--success-criterion "eval_score >= 2.0"` (a satisfiable bar; the 2.635 target is aspirational, §11.3). `success_criteria` must be non-empty (`run_state.py:71-73`).
- **Cognition seed** ← `/workspace/init_cognition.py` (and any prompts) → write the experiment's heuristics into `/workspace/.evolve_runs/main/cognition_seed.md` as ```json fenced blocks (the format `evolve_result.py sample`consumes, §3.2). The agent **transcribes** the`CognitionItem(content=..., source=..., metadata=...)` triples (`init_cognition.py:23-85`) into seed JSON objects — it does **not** run `init_cognition.py`(it imports the non-vendored`Evolve`package, §2.4).`--cognition-source-mode seed`.
- **Budget / sampler** ← the task string's requested round count (default 3) and the package defaults → `--max-rounds N --sampling-algorithm greedy --sample-n 1` (unchanged from today's prompt).
- **Mutation scope** ← `--writable-path .evolve_runs --primary-target candidate.py` (unchanged).

The agent then runs `evolve-brief normalize ... --confirmed true`, copies `run_spec.yaml`/`cognition_seed.md` into `.workflow/run_spec/` and `.workflow/cognition_seed/` (the existing step, `workflow.yaml:61-66`), and emits `ready` — so `preflight_review` presents the _inferred_ spec for human approval, exactly as today.

### 7.2 The clean fallback (no experiment dir in the workspace)

When the workspace root holds no experiment files (a fresh/empty sandbox — the operator did not point `--workspace` at an experiment dir), `preflight` behaves **exactly as it does today**: it authors the objective and a `python -c`-style evaluator command from the **task string** (the current prompt at `workflow.yaml:23-77`). This is why the existing toy task (`"evolve solve(xs) toward solve([1,2,3])==6 over 3 rounds"`, human-surface §12.3) keeps working with zero behavior change. The reworked prompt is structured as: "If the workspace root holds experiment files, infer from them (§7.1). Otherwise, author from the task description as below: …" — the existing instructions become the else-branch. The fallback evaluator command still targets the base venv (`/opt/workflow-venv/bin/python`), so it runs in the same persistent environment; `provision` in the no-experiment case is a near-no-op that just confirms the base venv and writes the marker (§4.1 step 2).

### 7.3 run_spec wiring (evaluation command → `/workspace/evaluator.py`; cognition seed → experiment heuristics)

The wiring is the existing `run_spec.evaluation.command` shell-format seam (§3.2) — **no engine or bridge change**. `preflight` sets:

```yaml
# run_spec.yaml (authored by evolve-brief normalize, values inferred by preflight)
evaluation:
  core_score: eval_score
  command: /opt/workflow-venv/bin/python /workspace/evaluator.py {quoted_code_path} {quoted_results_path}
  timeout_secs: 30 # or the experiment's evaluator timeout if inferable
  success_criteria: ['eval_score >= 2.0']
cognition:
  source_mode: seed
  # cognition_seed.md holds the transcribed heuristics; seed_files left as the
  # brief default (the bridge reads cognition_seed.md directly, §3.2).
```

At `evaluate` time, `cmd_eval_run` (`cli.py:243-298`) substitutes `{quoted_code_path}` → the step's `code` file and `{quoted_results_path}` → the step's `results.json`, and runs `python /workspace/evaluator.py "<code>" "<results.json>"` from the workspace root. `evaluator.py` writes `eval_score`; the bridge reads it and the orchestrator records the node. The evaluator path `/workspace/evaluator.py` is one of the experiment's own source files (read-only by convention, §9) and is outside `mutation_scope.writable_paths`, but `ensure_path_allowed` only checks the _candidate_ path (`run_state.py:300-318`), so this is allowed.

The `script_path` alternative (`--evaluation-script-path`) is not used — pointing `command` at the absolute `/workspace/evaluator.py` is more direct than `script_path` (which `normalize_spec_path` would rewrite relative to the workspace root, `cli.py:141-144`). **Use `command`, not `script_path`, for experiment-dir evaluators.**

### 7.4 Initial-program seeding (maintainer DECISION 1)

ASI-Evolve seeds node 0 from `/workspace/initial_program` — the baseline candidate the search improves on (§2.2). Reaching ~2.635 in a small number of rounds depends on starting from this baseline rather than a from-scratch candidate. **Recommended default: seed node 0 from `/workspace/initial_program` when present**; fall back to "researcher invents candidate #1" when absent (the current behavior).

**How it seeds (the mechanism), specified:** the cleanest place is the **`researcher`** spoke on round 1. Today `researcher` "writes a full candidate from scratch" when the sampled `parent` is null (`workflow.yaml:200-201`). The slice extends the `researcher` prompt: _"On round 1, if `/workspace/initial_program` exists, copy it verbatim as this round's candidate (do not modify it) — it is the experiment's baseline; the engine will score it as node 0. Otherwise write a candidate from scratch."_ Node 0 then enters the engine DB through the **normal** `evaluate → analyzer → analysis_record` cycle (it is scored by the real evaluator and recorded with a real score), so no special engine path is needed and the determinism/lineage invariants are untouched. This is preferred over seeding directly into `nodes.json` (which would bypass the evaluator and record an unscored node — fragile, and it would violate "every candidate is scored in the same environment", §8).

**Why round-1-researcher, not a new state:** it reuses the existing round machinery (the candidate is written to `steps/<step>/code` exactly as a normal candidate, then evaluated), keeps the FSM delta to the `provision` prepend (§4), and means node 0's score is the _real_ baseline score — which is what makes "best improves across rounds" (§11) a meaningful assertion. The alternative (a dedicated `seed_initial` state, which the parent design once contemplated and the human-surface slice collapsed) is more states for no benefit here.

**OPEN QUESTION (§13, tied to decision 1 sign-off):** confirm copying `initial_program` into `steps/<step>/code` is within `mutation_scope` (it writes under `.evolve_runs`, which is the writable path — yes) and that the `researcher` can _read_ `/workspace/initial_program` (yes — it is at the workspace root, which the agent already reads). Both look fine; flagged for the implementer to verify at build time.

---

## 8. The persistent-venv + provision-once invariant

This invariant is the whole point of making `provision` a separate up-front state rather than installing on demand during evaluation.

- **Where the venv lives.** `/opt/workflow-venv` in the container, backed by a host-cached read-write bind mount under `~/.ironcurtain/workflow-deps/<hash>/python-venv` (`docker-infrastructure.ts:1481-1493`). It persists across container recreations (it is a host mount) and across resumes (same host path). The base deps (numpy/pyyaml) are installed into it before any state runs; `provision` adds the experiment deps (scipy) once (§5.2, §6.2).
- **How `evaluate` uses it (and how the candidate inherits the venv).** The `run_spec.evaluation.command` invokes `/opt/workflow-venv/bin/python /workspace/evaluator.py ...` (§7.3), so the evaluator itself runs under the venv interpreter with the same installed packages every round. The candidate that the evaluator scores ALSO resolves `import scipy` against the same venv — but the mechanism is specifically that `evaluator.py` re-spawns the candidate as a subprocess via `subprocess.Popen([sys.executable, <candidate>], ...)` (`evaluator.py:147-148`). Because the evaluator was launched as `/opt/workflow-venv/bin/python`, `sys.executable` IS the venv python, so the nested candidate process inherits the venv (scipy included). This is NOT `buildWorkflowExecCommand` prepending the venv bin to `$PATH` (`docker-infrastructure.ts:1447-1459`) — that governs the deterministic state's own `run:` command, not the candidate the evaluator re-spawns. The conclusion (every candidate is scored against the same venv packages) stands; the load-bearing mechanism is the evaluator's `sys.executable` re-spawn.
- **Why `evaluate` must NEVER install or touch the network.** Two reasons. **(1) Determinism of scoring.** If `evaluate` could install, two candidates could be scored against different package versions (a registry update between rounds), making scores incomparable and "best improves across rounds" meaningless. Pinning installation to a single up-front `provision` guarantees every candidate is scored in a byte-identical environment. **(2) Security containment.** `evaluate` runs operator-supplied evaluator code and LLM-generated candidate code; keeping it off the network (no install, no fetch) means that code cannot exfiltrate or pull arbitrary payloads at score time — the only networked state is `provision`, which installs named packages through the mediated registry proxy (§9). The `evaluate` deterministic state (`workflow.yaml:217-241`) runs the evaluator via the bridge with no network step; this slice adds nothing networked to it.
- **Skip-on-resume idempotency (durable-venv only — apt is re-applied).** §6.2: the `.evolve_runs/main/.provisioned` marker + the persistent venv mount mean `provision` re-entry skips the **pip/uv install** of the resume-durable venv deps — a marker check + import probe, no registry traffic for that class. So a resumed run does not re-pull venv wheels, and a long run that bounces through `provision_review` does not reinstall the venv on each `APPROVE`. **The apt/system-library class is the exception:** because resume mints a fresh container (`orchestrator.ts:1412-1422`), any apt lib is gone and `provision` re-applies it on every entry (prompt step 3b). The import probe passing does not prove the apt `.so` is present — a candidate's wheel could `import` fine from the durable venv yet fail at link/load time for a missing system lib. For circle-packing this is moot (no apt step; scipy's wheel is self-contained), but the harness must not assume "marker present ⇒ environment fully intact" for experiments that do need apt.

**The invariant, stated once:** _all installation happens in `provision`; `evaluate` never installs and never touches the network; therefore every candidate in every round is scored in the same environment._ The persistent venv makes the pip/uv deps provision-once and resume-durable; any system libs are re-applied by `provision` on each entry (so a resumed fresh container is restored to the same environment) — the point is that `evaluate` is never the state that installs. This is the property the §11 gate asserts (the venv sentinel exists before the first evaluate; no registry traffic during the loop; scores are comparable).

---

## 9. Security / policy

- **Registry passthrough is open for the whole run (deferred scoping).** The MITM allowlist includes the package registries (PyPI) for the entire run when `packageInstall` is enabled (`mitm-proxy.ts:1392`), not just during `provision`. This is a deliberate deferral: a future hardening would open registries only while `provision` runs and close them during the loop (so `evaluate`/`researcher` cannot reach a registry even if their code tried). That **phase-scoped allowlist is out of scope** here (§1 non-goals); the registry stays open. The risk is bounded because (a) `evaluate` runs no install step, and (b) all egress is still mediated and audited by the MITM (no raw internet) — but the doc flags this as the next security increment.
- **The evaluator and candidates run network-none-mediated.** The container has no direct egress (`--network=none` on Linux; an `--internal` Docker network with a socat sidecar forwarding only the MCP+MITM ports on macOS — see `src/docker/CLAUDE.md`). All HTTP(S) goes through the MITM proxy. So even with registries allowlisted, the evaluator/candidate code can only reach what the proxy permits; it cannot open arbitrary sockets.
- **The experiment files are read-only BY CONVENTION, not OS-enforced (precise statement of the one gap).** Because the experiment dir IS the workspace and the workspace is mounted **read-write** at `/workspace` (it must be, for the engine to write `.evolve_runs/` and `.workflow/` in place), the experiment's own source files (`evaluator.py`, `input.md`, `initial_program`) are NOT protected by an OS read-only mount. They are kept untouched by **convention**: the evolve engine confines its own mutations to `.evolve_runs/` (the run spec sets `--writable-path .evolve_runs`, `workflow.yaml:44`, enforced by `ensure_path_allowed`, `run_state.py:300-313`) plus the `.workflow/` artifact subtree, and the agent prompts instruct the agents not to modify the experiment's source files (§4.1). So under well-behaved operation the experiment's source files are never written. **The one gap:** the evaluator runs the generated candidate with `cwd=workspace_root` (`cmd_eval_run` runs from the workspace root, §3.2) on a read-write workspace mount, so a misbehaving or adversarially-generated candidate could write OUTSIDE `.evolve_runs/` — e.g. clobber `/workspace/evaluator.py` or the oracle. **The blast radius is bounded:** inside the `--network=none` container with only the workspace + venv mounts and no host escape, the worst case is a corrupted run (a tampered oracle scores the rest of that run wrong), NOT a host escape or a leak. For trusted experiments and well-behaved numerical search (circle-packing is deterministic geometry, no filesystem writes) this is a non-issue. The **only** thing that makes the oracle truly tamper-proof against arbitrary generated code is an OS read-only mount of the experiment's source files — recorded as a **deferred future refinement** (a `--experiment` flag that mounts the experiment dir read-only, separate from the read-write run-state dir), alongside the deferred phase-scoped allowlist; see §13. It is deliberately out of scope for this slice, which optimizes for zero new threading on trusted experiments.
- **No new policy-engine surface.** This slice adds no MCP server, no tool, no policy rule. `provision` is a docker-agent state running shell commands inside the contained container, mediated by the same MITM as every other state. The `require_evolve_ready` helper-layer gate and the human-surface approval gates are untouched.
- **Determinism / vendored-engine invariant preserved.** No `evolve_core` change, no `evolve_result.py` subcommand, no determinism-affecting path. The evaluator is wired through the existing `run_spec.evaluation.command` seam; the cognition seed through the existing `cognition_seed.md` path. The byte-verbatim vendored-engine invariant is untouched.

---

## 10. Lint / validation

The extended manifest must lint clean under `tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict`. The new surface is one agent state, one gate, and an `initial:` change.

### 10.1 `initial:` change

`initial: provision` must name a declared state (`provision` exists, §4.1). No lint rule forbids changing the initial state; validation only requires the initial state to exist and be reachable-from (it is the root). ✓

### 10.2 `provision` agent state

A `type: agent` state needs a `persona`, `prompt`, and `transitions` (WORKFLOWS.md §"Agent states"). `provision` has `persona: global`, a prompt, `inputs: []`/`outputs: []`, and two transitions (`ready → preflight`, `blocked → provision_review`). No `maxVisits` (so no `isStateVisitLimitReached` pairing to validate). ✓

### 10.3 `provision_review` human gate (WF004, `validateHumanGate`, WF001)

- **`validateHumanGate`** (human-surface §10.1): ≥1 transition, every transition's `event` in `acceptedEvents`. `provision_review` declares `[APPROVE, FORCE_REVISION, ABORT]` and uses exactly those. ✓
- **WF004** (gate `present:` artifacts must be produced by a reachable agent): `provision_review` has **no `present:`**, so WF004 has nothing to check. ✓ (This is the §4.2 design choice — provision produces no `.workflow/` artifact, so we omit `present:` rather than invent a producer.)
- **WF001** (every reachable non-terminal reaches a terminal): `provision → provision_review → aborted` (via ABORT) reaches a terminal; `provision → preflight → … → done` reaches `done`. ✓

### 10.4 `resetVisitCounts` validation

`provision_review`'s `APPROVE`/`FORCE_REVISION` edges use `{ type: resetVisitCounts, stateIds: [provision] }` — the explicit form with a non-empty `stateIds` referencing a known state (`provision`), which passes schema validation (human-surface §10.4). The bare `actions: [resetVisitCounts]` form would fail. ✓

### 10.5 Reachability of the new states

`provision` is the `initial:` state (reachable by definition). `provision_review` is reachable from `provision` (`blocked` edge). Neither is an orphan. The merged FSM's reachability is unchanged (everything still reaches a terminal). ✓

### 10.6 Control check

Per the lint-by-control discipline: temporarily point `provision`'s `blocked` edge at a non-existent state → validation fails; restore → clean. Temporarily change `initial:` to a non-existent state → validation fails. This proves the clean `--strict` result is real, not a lint that skips the new states.

### 10.7 If the `→ failed` alternative is chosen (§4.2)

If the maintainer picks `provision ─blocked→ failed` instead of the gate, `provision_review` is dropped entirely; §10.3/§10.4 do not apply, and the only new surface is the `provision` agent state + the `initial:` change. Still `--strict`-clean (the `failed` terminal already exists).

---

## 11. Binary completion gate (REQUIRED — front and center)

The slice is done when all three conditions below hold. This mirrors the human-surface slice's §12 structure: a gated real-Docker test (with a **synthetic experiment fixture** so CI has no LLM flakiness), a clean `--strict` lint, and a live demonstration (the **circle-packing run**, driven daemon-backed).

### 11.1 (a) Real-Docker integration test — the synthetic experiment fixture

A new test, gated `describe.skipIf(!dockerReady)` with the **same** `dockerReady` guard as the existing evolve integration gates (`test/workflow/evolve-multi-round.integration.test.ts`). It reuses that suite's `TEST_HOME`/CA staging, `buildDockerSessionConfig`, `createInfra`/`destroyInfra`, `createDeps`, `onEvent` state collection, and (from the human-surface slice) the gate-driving helpers `waitForGate`/`resolveGate`. The **new** machinery is (1) building a tiny synthetic experiment dir and passing it as the `--workspace` (`workspacePath`), and (2) asserting on the provision/venv/score outcomes.

**The synthetic experiment dir** (created in the test's tmp tree, passed as the run's `workspacePath` so it mounts at `/workspace`) — deliberately trivial so there is **no LLM flakiness** in the _infrastructure_ path (the agent states are still mock-routed by prompt substring as in the existing evolve gate). Its files sit at the workspace root:

- `requirements.txt` — a single, cheap, real PyPI requirement that is **not** in the base venv, e.g. `tabulate` (tiny, pure-Python, fast to install) — proving `provision` actually installs through the registry proxy. (Avoid scipy in CI: it is heavy; scipy is exercised by the live run §11.3.)
- `evaluator.py` — a **real** evaluator (runs for real, not mocked) with the experiment CLI contract `python evaluator.py <code_file> <output_json>`: it `exec`s the candidate, calls its entry point, computes a deterministic numeric score, `import tabulate` (so the run fails if `provision` did not install it — the dep is load-bearing in the score path), and writes `{"eval_score": <n>}`. Keep it ~20 lines.
- `input.md` — a one-line objective the mock `preflight` transcribes.
- (Optional) `initial_program` — a trivial baseline candidate to exercise decision-1 seeding.

Because the synthetic dir is the workspace, the run's `.evolve_runs/` and `.workflow/` subtrees are created inside it in place — the test asserts on those at `<workspace>/.evolve_runs/main/`.

**Mock routing.** The mock agent router (mirroring the existing evolve test's prompt-substring routing) adds branches for the **two new/changed prompts**: `provision` (matches a unique substring like "provisioning the Python environment") and the reworked `preflight` (matches the experiment-inference branch; the mock authors a `run_spec` whose `evaluation.command` points at `/opt/workflow-venv/bin/python /workspace/evaluator.py {quoted_code_path} {quoted_results_path}`). `researcher` writes valid improving candidates as in the existing gate. **The `evaluate` state is NOT mocked** — the real bridge runs the real `/workspace/evaluator.py`.

**The `provision` mock branch drives a REAL install via `infra.docker.exec` (specified approach).** Because the mock router intercepts the `provision` agent state, the mock branch must itself put the venv into the provisioned state — it does not get to rely on the real `provision` prompt's inference. The specified approach (runnable with existing harness infra, no new machinery): the mock branch calls `infra.docker.exec(..., ['/opt/workflow-venv/bin/python', '-m', 'uv', 'pip', 'install', '-r', '/workspace/requirements.txt'])` (or the equivalent `uv pip install` invocation the harness already uses for base provisioning) and writes the `/workspace/.evolve_runs/main/.provisioned` marker, then returns `verdict: ready`. This drives a genuine `uv pip install` of the synthetic dep through the registry proxy and leaves the venv genuinely provisioned, so the §11.1 assertions (marker exists, `import tabulate` succeeds, the dep is load-bearing in the score path) are real.

> **What the synthetic gate does NOT prove (limitation — call it out explicitly).** Because the mock router intercepts the `provision` AGENT state, the synthetic CI test exercises the **TEST's** install (the mock branch's `infra.docker.exec` `uv pip install`), NOT the real `provision` prompt's dependency-inference-and-install behavior. So the synthetic gate proves: `--workspace` experiment dir at `/workspace` + persistent venv + real-evaluator scoring + provision-once + reaching `done`. It does **not** regression-guard the `provision` prompt's dependency inference (the README/import-scan reasoning, the explicit-manifest-vs-inference branching). That inference is the **live run's** job (§11.3): only the live circle-packing run exercises the real `provision` prompt inferring scipy from the README + `import scipy` references. This is an inherent property of mocking an agent state, not a gap to be closed in CI — do not over-claim the synthetic test as covering the inference path.

**Scenario — synthetic experiment provisions, evaluates real candidates, improves, reaches done:**

1. `orchestrator.start(<evolve manifest>, <task>, { workspacePath: <synthetic dir> })` (the synthetic experiment dir is passed as the run's workspace, exactly as `--workspace` does).
2. The run enters `provision`. After it completes (`ready`), assert the venv marker exists: `existsSync(<workspace>/.evolve_runs/main/.provisioned)`, and that the installed dep is importable in the venv — e.g. `infra.docker.exec(..., ['/opt/workflow-venv/bin/python', '-c', 'import tabulate'])` exits 0. This proves provision installed through the proxy.
3. The run reaches `preflight_review` (the human-surface gate). `resolveGate(workflowId, { type: 'APPROVE' })`. (The run is now in the unchanged human-surface loop.)
4. The N-round loop runs; **`evaluate` invokes the real `/workspace/evaluator.py`** each round. The loop reaches `final_review`; `resolveGate(workflowId, { type: 'APPROVE' })`; `await waitForCompletion(...)`.
5. **Assertions (concrete):**
   - `getStatus(workflowId).phase === 'completed'` and `states.at(-1) === 'done'`; `states` contains `'provision'` (first) then `'preflight'`.
   - `nodes.json` has exactly N nodes (or N+1 if decision-1 seeding adds node 0), each with a **valid numeric `eval_score` produced by the real evaluator** (not 0/blocked) — i.e. `evaluate` actually ran the experiment's evaluator and it depended on the provisioned `tabulate`.
   - **Best improves across rounds:** the max score is non-decreasing and the final best > the first node's score (the synthetic evaluator + mock researcher are constructed so candidates improve).
   - **Provision-once:** the `.provisioned` marker was written exactly once (assert its mtime/content is stable; the loop did not rewrite it), and no node's `evaluate` step performed an install (no registry traffic during the loop — assertable via the MITM audit/log if the test harness exposes it, else by the absence of a re-provision marker change).
   - Parent lineage intact (`next_id === |nodes|`, every `nodes[k].parent` references a prior id), carried over from the multi-round gate's invariants.
6. **No-experiment regression:** a second test case with **no** `workspacePath` (a fresh sandbox workspace, no experiment files) runs the existing toy task and reaches `done` unchanged (proving the fallback §7.2 and the near-no-op `provision` path §4.1 step 2). This guards the "existing toy task still works" requirement.

### 11.2 (b) Lint clean

```
tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict
# expect: "No lint diagnostics"
```

No WF001/WF004/WF006 and no `validateHumanGate`/`resetVisitCounts`/`initial:` validation errors (§10). Include the §10.6 control checks in the unit test layer.

### 11.3 (c) Live circle-packing demonstration (daemon-backed)

The live run goes through the **daemon-backed** `workflow run / await / show / gate` loop (WORKFLOWS.md §"Driving workflows from an agent", `:317-404`; `docs/designs/agent-driven-workflow-gates.md`), **not** the interactive stdin path — so it is scriptable and gate-driven. Exact command sequence:

`--workspace` is already accepted by `workflow run` (`workspacePath` is already in the run params and the `workflows.start` RPC, §5.1) — so the live run uses it directly, no new flag. For circle-packing's missing `requirements.txt` (§2.6), the operator points `--workspace` at either (i) a thin copy of the demo dir that includes a `requirements.txt: scipy` (deterministic explicit-manifest path) or (ii) the bare demo dir, relying on `provision` to infer scipy from the README + `import scipy` references. Either reaches the gate; (ii) is what additionally exercises real inference. The example below shows (ii):

```bash
# 0. Daemon running (or pass --ensure-daemon on the first call).
ironcurtain daemon &        # if not already up

# 1. Start the circle-packing experiment on the daemon. The experiment dir IS
#    the workspace (--workspace, already plumbed — no new flag).
WF=$(ironcurtain workflow run evolve \
      "Improve the circle packing toward the AlphaEvolve target over 5 rounds" \
      --workspace "$PWD/donotcommit/ASI-Evolve/experiments/circle_packing_demo" \
      --json --ensure-daemon | jq -r .workflowId)

# 2. Block until the first gate or terminal.
ironcurtain workflow await "$WF" --json
#   provision runs first (installs scipy via the proxy). When it reaches
#   preflight_review, await returns phase: waiting_human with
#   gate.stateName == "preflight_review".

# 3. Inspect the inferred run spec the gate presents, then approve.
ironcurtain workflow show "$WF" --artifact run_spec --json   # objective + evaluator.command → /workspace/evaluator.py
ironcurtain workflow gate "$WF" --event APPROVE --json

# 4. Loop await → (gate?) → gate → await until terminal. The loop runs N rounds,
#    each scoring a candidate via the REAL /workspace/evaluator.py.
ironcurtain workflow await "$WF" --json        # → final_review gate (or human_escalation if a candidate is rejected)
ironcurtain workflow show "$WF" --artifact final_report --json
ironcurtain workflow gate "$WF" --event APPROVE --json
ironcurtain workflow await "$WF" --json        # → phase: completed, terminal: done

# 5. Verify outcomes from the run dir (which lives inside the experiment dir:
#    <experiment-dir>/.evolve_runs/main/).
ironcurtain workflow inspect "$WF"             # Final: completed, terminal done
```

**Assertions for the live run (the gate, not aspiration):**

- `provision` **installed scipy** into `/opt/workflow-venv` (the `.provisioned` marker lists `scipy`; `/opt/workflow-venv/bin/python -c "import scipy"` succeeds in the container).
- `evaluate` ran the **real `evaluator.py`** each round (`steps/<step>/eval.command.txt` shows `python /workspace/evaluator.py ...`; `results.json` has `eval_score`).
- The recorded scores are **valid sum-of-radii packings** (`validity == 1.0`, `sum_radii > 0` in the results) — the evaluator's own validation passed, so these are real packings, not zero-scored rejects.
- **Best improves across rounds** (the engine `best/` snapshots show a non-decreasing best `eval_score`).
- The run reaches **`done`**.
- **Aspiration, NOT gating:** reaching ~2.635 is the AlphaEvolve target and is _desirable_ but depends on the LLM, the model, and the round count — it is too flaky to gate on. The hard gate is "provisions scipy, runs the real evaluator, records valid improving scores, reaches done." Document the achieved best score as an informational result.

`--workspace` is confirmed accepted on `workflow run` (`workspacePath` is already in the run params and the `workflows.start` RPC, §5.1), so the daemon-backed live run needs no new flag work. This is the existing plumbing the slice reuses — there is no open question here.

### 11.4 Why this gate proves the harness works end-to-end

- **§11.1 (synthetic, CI-able)** proves the _infrastructure_ — the experiment dir staged via `--workspace` at `/workspace`, a real dep installed through the proxy into the persistent venv, the experiment's real evaluator scoring real candidates, provision-once, and `done` — with **no LLM flakiness** (agent states mocked, evaluator real). It is the deterministic regression guard. **It does NOT cover the `provision` prompt's dependency inference** (the install in CI is driven by the mock branch's `infra.docker.exec`, not the real prompt — §11.1 limitation); that is exclusively the live run's job.
- **§11.2 (lint)** proves the FSM delta is structurally valid.
- **§11.3 (live circle-packing)** proves the _real_ end-to-end story on the canonical ASI-Evolve experiment — including the part CI cannot reach: the real `provision` prompt **inferring** scipy from the README + `import scipy` references (no `requirements.txt` at the workspace root), then the shipped `evaluator.py` scoring sum-of-radii packings, best improving, `done` reached — with zero edits to `workflow.yaml`/`scripts/`/`requirements.txt`. The 2.635 target is the aspirational ceiling, not the pass/fail line.
- Together: the synthetic test locks the harness in CI; the live run demonstrates the bar ("`--workspace .../circle_packing_demo` runs with zero per-experiment edits").

---

## 12. Prompts / skills deltas

Per CLAUDE.md "Authoring workflow skills" — control flow lives in the FSM, domain content in skills. This slice is mostly control-flow (a new state, a new `initial:`, a staging mount), so prompt deltas are contained and no new skill is required.

### 12.1 `provision` prompt (new)

Given verbatim in §4.1. It is environment/infra reasoning (read canonical files, `uv pip install`, idempotent skip), not domain content — it lives in the state prompt. No skill.

### 12.2 `preflight` prompt (reworked)

The single substantive prompt change (§7): a leading "if the workspace root `/workspace` holds experiment files, infer objective/evaluator/cognition-seed/initial-program from them (§7.1); otherwise author from the task string (the existing instructions, §7.2)" branch. The `evolve-brief normalize` invocation shape is unchanged; only the _values_ differ. The experiment-inference instructions are arguably reusable domain content, but they are tightly coupled to this workflow's `run_spec` wiring, so they stay in the state prompt for now (a future "ASI-Evolve experiment onboarding" skill could lift them if a second experiment-driven workflow appears — not now).

### 12.3 `researcher` prompt (small delta, decision 1)

Per §7.4: a round-1 clause — "if `/workspace/initial_program` exists, copy it verbatim as this round's candidate; otherwise write from scratch." One sentence; the rest of the researcher prompt is unchanged.

### 12.4 No other prompt or skill changes

`orchestrator`, `analyzer`, `sample`, `evaluate`, `analysis_record`, and all three human-surface gates are untouched. No SKILL.md changes — the new ordering (`provision` before `preflight`) is FSM territory (the `initial:` change + the `provision → preflight` edge), not skill content.

---

## 13. Risks / open questions / maintainer decisions

### Maintainer decisions — DECIDED (signed off)

Both decisions below are **DECIDED** at their recommended defaults; the maintainer has accepted them. The doc body implements these values throughout. The text is retained as the decision record (rationale + tradeoff), not as an open question.

1. **Initial-program seeding (§2.2, §7.4) — DECIDED: seed node 0 from `/workspace/initial_program` when present.** Seed engine node 0 from `/workspace/initial_program` (the experiment's baseline at the workspace root) when present (faithful to ASI-Evolve; matters for circle-packing reaching ~2.635); fall back to "researcher invents candidate #1" when absent. The mechanism is a round-1 `researcher` clause that copies `initial_program` verbatim into `steps/<step>/code` so it enters the engine DB as node 0 through the normal `evaluate → analysis_record` cycle (no special engine path; the review confirmed this preserves determinism/lineage and stays within `mutation_scope`). **Decision record (rationale):** seeding makes the baseline score real and "best improves" meaningful, at the cost of a one-sentence `researcher` prompt clause and a (verified-safe) read of the experiment's baseline file at the workspace root; the from-scratch alternative is simpler but unlikely to reach the target in a few rounds. **DECIDED — seed when present.** (Staging-mechanism note: this decision is unchanged by the `--workspace` revision — only the file's path moved from `/experiment/initial_program` to `/workspace/initial_program`.)

2. **Acceptance bar (§11) — DECIDED: the deterministic gate below; 2.635 aspirational.** The hard gate is: _provisions the experiment's deps (e.g. scipy), runs the experiment's REAL evaluator end-to-end, records valid scores (valid sum-of-radii packings), best improves across rounds, reaches `done`_ — proven in CI by a **tiny synthetic experiment fixture** (no LLM flakiness, §11.1) and demonstrated live by the **circle-packing run** (§11.3). Reaching ~2.635 is **aspirational, not gating** (it depends on the LLM + round count and is too flaky to gate). **Decision record (rationale):** the synthetic-fixture gate is deterministic and CI-stable but does not prove the real benchmark is reachable; the live run proves the real path but is not run in CI (Docker + LLM cost) — running both covers both. **DECIDED — the deterministic gate above; 2.635 aspirational.**

### Open questions (implementer to resolve; not maintainer decisions)

> Note: the earlier `--experiment`-threading open items (the `--experiment`-on-`workflow run` question, the `start()` options-object-vs-4th-positional signature question, and the mount-from-source-vs-copy-at-start threading question) are **GONE** — the slice now reuses the existing `--workspace`/`workspacePath` plumbing, which is already threaded end-to-end (CLI → RPC → `controller.start`), so none of that new threading is added. The remaining open items are below.

- **Experiment dir: in-place vs point-at-a-copy (§5.3).** The run writes its `.evolve_runs/` and `.workflow/` subtrees into the experiment dir **in place** (it is the workspace) — this is the chosen default and requires zero new threading. The experiment dir therefore accumulates those two (gitignore-able) subtrees. If the operator wants the original experiment dir to stay pristine, they point `--workspace` at a copy of it — an operator's option, not a harness requirement. No implementer code rides on the choice; this is purely an operator-ergonomics note.
- **Circle-packing's live-run manifest disposition (§2.6) — RESOLVED, operator's call at run time.** Circle-packing ships no `requirements.txt` at the workspace root (its deps live in the ASI-Evolve repo root). This is not an implementer decision — it is an operator choice made when launching the live run: either (i) point `--workspace` at a thin copy of the demo dir that includes a `requirements.txt: scipy` (deterministic explicit-manifest path) or (ii) point it at the bare demo dir and let `provision` infer scipy from the README + `import scipy` references (the fuzzy inference path). The synthetic CI fixture covers the explicit-manifest path deterministically; only the live run under (ii) exercises real inference. Spelled out in §2.6; no code change rides on the choice.
- **Mock harness running a real `uv pip install` (§11.1) — approach specified (option a).** `provision` is an agent state, so the synthetic test's mock router intercepts it; the specified approach is that the mock branch drives the install itself via `infra.docker.exec` (runnable with existing harness infra, no new machinery — §11.1). The remaining implementer latitude is only the exact exec invocation; the FSM is unaffected. (A "thin deterministic helper the mock triggers" remains a valid alternative but is not the specified path.)
- **`provision blocked → provision_review` (gate) vs `→ failed` (hard-fail) (§4.2).** Recommended the gate (human recovery, symmetry with the human-surface slice). The `→ failed` alternative is simpler (no new state). Pick after sign-off; both are spec'd.
- **Resume + provision skip (§6.2, §8).** On `workflow resume`, the same `--workspace` experiment dir is re-mounted at `/workspace` by the existing workspace-mount machinery (no new threading — the workspace path already persists and is re-resolved on resume), and `provision` skips the durable-venv install via the `.provisioned` marker (apt is re-applied, §6.2). Verify resume re-establishes the workspace mount and reads the `.provisioned` marker (the venv mount and workspace already persist on the existing resume path).

### Deferred future refinements (recorded, not discarded)

- **A `--experiment` read-only mount (the OS-enforced oracle).** This slice deliberately reuses `--workspace` (read-write), so the experiment's source files are read-only **by convention** only (§9). A future `--experiment <dir>` refinement would mount the experiment's source files at a **read-only** OS mount, separate from the read-write run-state dir — the **only** thing that makes the oracle (`evaluator.py`) truly tamper-proof against arbitrary generated candidate code (§9's one gap). Deferred, not discarded: it is a real hardening for untrusted experiments, but unnecessary for trusted experiments / well-behaved numerical search (circle-packing), and it would re-introduce the new-flag/new-mount/new-threading work this revision dropped.
- **Phase-scoped registry allowlist (§9).** Open registries only while `provision` runs and close them during the loop, so `evaluate`/`researcher` cannot reach a registry even if their code tried. Deferred alongside the read-only mount as the next security increment.

### Risks

- **Provision-time flakiness in the live run.** A registry hiccup or a missing system lib during scipy install routes to `provision_review` (or `failed`). The agent's `sudo apt-get` recovery path mitigates the common "missing libopenblas"-style case; the gate gives the operator a retry. Generous timeouts on the §11 helpers (the install can take tens of seconds; scipy is heavy).
- **Inference brittleness.** Circle-packing ships no `requirements.txt` at the workspace root, so `provision` relies on README/import inference (§2.6). If the agent under-infers (misses scipy), the first scipy-using candidate fails at `evaluate` (`evaluator_blocked` → `human_escalation`, the human-surface path) — recoverable but a worse experience than provisioning correctly up front. The synthetic fixture's explicit manifest does not exercise this; the live run does.
- **`evaluate` accidentally networked.** The whole invariant (§8) rests on `evaluate` never installing. The risk is a candidate that tries to `pip install` at score time. The mediated proxy still gates this, but the determinism argument wants it never to succeed; the deferred phase-scoped allowlist (§9, §13 deferred refinements) is the real fix. Flag: do not let any future `evaluate`/`researcher` prompt suggest installing at score time.
- **Candidate writes outside `.evolve_runs/` (the read-only-by-convention gap).** Because the experiment dir is the read-write workspace, a misbehaving/arbitrary generated candidate run by the evaluator (`cwd=workspace_root`) could write outside `.evolve_runs/` — e.g. clobber `/workspace/evaluator.py`. The blast radius is bounded to a corrupted run inside the `--network=none` container (no host escape, §9); for trusted experiments and well-behaved numerical search (circle-packing) it is a non-issue. The OS read-only mount (the deferred `--experiment` refinement, §13) is the real fix; flagged here so it is not forgotten.
- **Workspace experiment-file detection.** `provision`/`preflight` branch on whether the workspace root holds experiment files (vs a fresh sandbox). They must ignore the run-state subtrees (`.evolve_runs/`, `.workflow/`) when deciding "is this an experiment dir?" — on a resume those subtrees exist but the experiment files are still the source of truth (prompt step 2, §4.1). Confirm the detection logic does not mistake a run-state-only dir for an experiment.

### Invariants preserved (not at risk)

- **Determinism + vendored-engine byte-verbatim** (§9): no `evolve_core` change, no `evolve_result.py` subcommand, no determinism-affecting path. The evaluator is wired through the existing `run_spec.evaluation.command` seam; the cognition seed through the existing `cognition_seed.md` path.
- **Base image / `scripts/requirements.txt` stay generic** (§5.2, §8): `numpy`+`pyyaml` only; scipy and every experiment dep are installed at run time via the proxy, never baked into the image.
- **The human-surface FSM is a clean superset** (§4): `initial: provision` is a prepend; no merged edge is retargeted. The gates, `final_summary`, and `aborted` are untouched.
- **Provision-once / same-environment scoring** (§8): the venv is provisioned once; `evaluate` never installs or networks; every candidate is scored in the same environment.
