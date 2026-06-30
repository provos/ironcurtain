# Vulnerability Discovery

An orchestrator-driven workflow that points a Docker-isolated `claude-code` agent at a body of code, **builds tiered instrumented harnesses, and tries to execute its way to a confirmed vulnerability** — analysis → harnessing → discovery → triage → report, with human gates whenever the machine gets stuck or finishes.

Run it from the web UI (**Start Workflow → `vuln-discovery`**) or the CLI:

```bash
ironcurtain workflow start vuln-discovery \
  "find a memory-corruption bug reachable from a crafted H.264 stream" \
  --workspace ~/src/ffmpeg
```

Point `--workspace` at a checkout of the code under investigation. The task description carries the **scope, vulnerability class, and threat model**; a one-liner like `"find a vulnerability in libavcodec/h264_slice.c"` is enough to start, since the agent prompts supply the methodology. Add detail to steer the hunt.

> **Requires Docker.** This workflow only runs in Docker Agent Mode (`--network=none`); there is no builtin-mode fallback. Run `ironcurtain doctor` first if you're unsure your environment is ready. For a fresh-checkout walkthrough (build, daemon, web UI, non-Anthropic models, troubleshooting) see [`docs/vuln-discovery-onboarding/README.md`](https://github.com/provos/ironcurtain/blob/master/docs/vuln-discovery-onboarding/README.md).

## What it does

The orchestrator sits at the center and decides what to do next each round, reading and updating the investigation journal. Around it, the agents move a hypothesis from structural understanding to an executed, triaged finding. All artifacts land under `.workflow/` in the workspace.

| Phase | State(s)                                   | Role                                                                                                             | Output                                          |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1     | `analyze`                                  | Code analyst — maps call chains, entry points, build system, trust boundaries                                    | `.workflow/analysis/analysis.md`                |
| —     | `orchestrator`                             | Strategist — picks the next state, enforces budget, owns the journal                                             | `.workflow/journal/journal.md`                  |
| 2     | `harness_design` → `harness_design_review` | Architect + LLM reviewer — spec an instrumented, tiered harness                                                  | `.workflow/harness_design/`                     |
| 3     | `harness_build` → `harness_validate`       | Engineer + verifier — implement the harness, confirm it runs and produces coverage                               | `.workflow/harness_build/`, `harness_validate/` |
| 4     | `discover` (+ `differential_validate`)     | Researcher — hypothesis-driven search using the harness; diagnose isolated-vs-live divergence                    | `.workflow/discoveries/findings.h*.md`          |
| 5     | `triage`                                   | Independent reproducer — re-prove each finding and assess severity                                               | `.workflow/triage/triage.h*.md`                 |
| 6     | `conclude` → `review`                      | Report writer + LLM reviewer — assemble the final report, catch scope drift and evidence/headline contradictions | `.workflow/report/report.md`                    |

## Human gates

Four gates pause the run for your decision. Each presents the relevant artifacts (journal, analysis, designs, reports) and accepts **APPROVE** (continue), **FORCE_REVISION** (loop back — your feedback is routed verbatim into the next agent's prompt, so brief it like an orchestrator), or **ABORT**.

- **`human_escalation`** — the orchestrator detected a stall (same state 3+ times, contradictory results, or no clear next direction). Give it another round, redirect it, or stop.
- **`harness_design_escalation`** — the design-review loop rejected the design 3× in a row. Accept the design as-is, redirect, or stop.
- **`harness_validate_escalation`** — the validate loop rejected the build 4× in a row. Accept the harness despite validation failures, redirect, or stop.
- **`report_review`** — the investigation reached `complete` and the final report is ready. Approve it, send it back (your assessment overrides the agent's — e.g. dispute a "mitigated" verdict and it re-investigates at a higher tier), or discard.

## The orchestration loop

Unlike a fixed pipeline, the **orchestrator** re-routes after every round based on the journal: forward when a harness validates and findings hold, back to re-design or re-discover when they don't. The loop is bounded by `maxRounds` (**12**) and `maxSessionSeconds` (**10800** = 3 hours). When either limit or a stall is hit, control surfaces to a human gate rather than spinning — it never loops forever.

## At a glance

- **Mode:** Docker (`claude-code` agent, `--network=none`, shared container)
- **Model:** `anthropic:claude-opus-4-8`
- **Persona:** `global` for every agent state
- **Caps:** 12 rounds · 3-hour session budget
- **Skills:** `memory-safety-c-cpp`, `harness-design-fuzzing`, `vulnerability-triage` (co-packaged under `skills/`)
- **Artifacts:** `analysis`, `journal`, `harness_*`, `discoveries`, `triage`, `report` — all under `.workflow/`
- **Terminal states:** `done` (report approved) · `aborted` (stopped at a gate)

> Tip: the more precisely the task states the **threat model** (who the attacker is, how input reaches the code), the less the analyst has to guess. "Memory corruption reachable from an untrusted network packet" steers the whole run; "find bugs" does not. To run bigger targets past the default caps, copy the whole `vuln-discovery/` directory (it carries the skills it needs) into `~/.ironcurtain/workflows/` and raise the limits there.
