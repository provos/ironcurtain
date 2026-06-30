# Evolve

A multi-round, evaluator-driven candidate search that runs a tireless AI researcher on a hard problem: each round it **samples a parent, proposes a new candidate, scores it against your evaluator, and distills a transferable lesson** — then repeats, accumulating knowledge until the round budget is spent. It's IronCurtain's packaging of the [ASI-Evolve](scripts/README.md) loop, run by a Docker-isolated `claude-code` agent.

Run it from the web UI (**Start Workflow → `evolve`**) or the CLI:

```bash
ironcurtain workflow start evolve \
  "Improve the linear-attention kernel scored by evaluator.py" \
  --workspace ~/experiments/linear-attention
```

## The experiment you point it at

Evolve searches over **your** problem. Point `--workspace` at an experiment directory and the `preflight` agent infers the run spec from the files it finds at the workspace root:

| File                                  | Role                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `input.md` / `README.md`              | **Objective** — what "better" means, one line, taken faithfully from the brief                                               |
| `evaluator.py`                        | **Scoring contract** — `python evaluator.py <code_path> <results_path>`, writing JSON metrics. This is the fitness function. |
| `initial_program`                     | _(optional)_ Seed candidate / interface contract the search must respect                                                     |
| `requirements.txt` / `pyproject.toml` | _(optional)_ Python deps installed into the persistent run venv                                                              |
| `init_cognition.py`                   | _(optional)_ Domain knowledge / heuristics seeded into the cognition store so the search doesn't start from zero             |

If the workspace is empty, `preflight` falls back to inferring everything from the task description — useful for a quick trial, but a real experiment wants an evaluator. Experiment source files are treated as **read-only**; the run writes only to `.evolve_runs/` and `.workflow/`.

## What it does

After a one-time setup, the orchestrator drives rounds. Each round is a linear pipeline that turns sampled history into one scored, recorded candidate.

| Phase        | State(s)          | Role                                                                                                     | Output                   |
| ------------ | ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------ |
| Setup        | `provision`       | Install the experiment's deps into the persistent venv (idempotent)                                      | provisioned venv         |
| Setup        | `preflight`       | Infer the run spec, initialize the run, author the cognition seed                                        | run spec, cognition seed |
| Loop control | `orchestrator`    | Round-boundary controller — enforce the budget and stop conditions; route continue / complete / escalate | —                        |
| Round        | `sample`          | Sample parent nodes (UCB1 / greedy / random / MAP-Elites) and retrieve relevant cognition                | sampled parents          |
| Round        | `researcher`      | Evolve one candidate from the sampled parents and retrieved lessons                                      | candidate program        |
| Round        | `evaluate`        | Run your evaluator on the candidate                                                                      | JSON metrics             |
| Round        | `analyzer`        | Distill the outcome into a transferable lesson for future rounds                                         | round lesson             |
| Round        | `analysis_record` | Commit the round (candidate + score + lesson + parents) to the experiment database                       | recorded node            |
| Wrap-up      | `final_summary`   | Summarize the best candidates and what was learned                                                       | run summary              |

## Human gates

Four gates pause for your decision; each accepts **APPROVE** (continue), **FORCE_REVISION** (loop back with feedback routed into the next agent's prompt), or **ABORT**.

- **`provision_review`** — sign off on the environment setup before any candidate runs.
- **`preflight_review`** — sign off on the inferred run spec (objective, eval command, budget, cognition seed) before the search starts. This is the most important gate: a wrong objective or eval command wastes the whole budget.
- **`human_escalation`** — a round got blocked (e.g. the evaluator can't run). Redirect, retry, or stop.
- **`final_review`** — sign off on the run summary at the end.

## The round loop

The real budget is `run_spec.budget.max_rounds`, inferred at preflight from your experiment brief and enforced by the **orchestrator** — not the `maxRounds: 200` setting, which is only a safety backstop against a wedged pipeline. After each recorded round the orchestrator re-checks the budget and stop conditions and routes to continue, `complete`, or escalate, so the search ends cleanly instead of running forever.

## At a glance

- **Mode:** Docker (`claude-code` agent, `--network=none`, shared container)
- **Model:** `anthropic:claude-sonnet-4-6`
- **Persona:** `global` for every agent state
- **Input:** an experiment directory via `--workspace` (evaluator + objective; optional seed/deps/cognition)
- **Budget:** `max_rounds` inferred at preflight; `maxRounds: 200` is a backstop only
- **Run state:** `.evolve_runs/` (experiment DB, cognition store) and `.workflow/` in the workspace
- **Terminal states:** `done` (budget reached, approved) · `failed` (unrecoverable) · `aborted` (stopped at a gate)

> Tip: the search is only as good as `evaluator.py`. A noisy or too-lenient fitness function makes every candidate look equally good and the loop learns nothing — invest in a scorer that cleanly separates better from worse before kicking off a long run. For the framework behind the loop (cognition store, experiment database, sampling strategies) see [`scripts/README.md`](scripts/README.md).
