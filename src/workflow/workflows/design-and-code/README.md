# Design & Code

A four-phase software workflow that takes a task from **plan → design → implement → review**, with human approval gates between the planning stages and an automated coder–critic loop at the end.

Run it from the web UI (**Start Workflow → `design-and-code`**) or the CLI:

```bash
ironcurtain workflow start design-and-code "Add a rate limiter to the API gateway"
```

## What it does

The workflow drives a Docker-isolated `claude-code` agent through distinct roles, persisting its artifacts under `.workflow/` in the workspace and writing code directly at the workspace root.

| Phase | State | Role | Output |
|-------|-------|------|--------|
| 1 | `plan` | Project planner — breaks the task into ordered, numbered steps | `.workflow/plan/plan.md` |
| — | `plan_review` | **Human gate** — approve, request a revision, or abort | — |
| 2 | `design` | Architect — module structure, interfaces, typed signatures | `.workflow/spec/spec.md` |
| — | `design_review` | **Human gate** — approve, request a revision, or abort | — |
| 3 | `implement` | Engineer — writes the code and unit tests, runs them | `src/`, tests |
| 4 | `review` | Reviewer — checks correctness, edge cases, quality, coverage | `.workflow/reviews/review.md` |

## Human gates

Two gates pause the run for your decision:

- **Plan review** — sign off on the approach before any design work.
- **Design review** — sign off on the interfaces and types before implementation.

At each gate the presented artifact (`plan` or `spec`) is shown for inspection. Choose **Approve** to advance, **Request Revision** to send the agent back with feedback, or **Abort** to stop.

## The coder–critic loop

After implementation, the **reviewer** judges the code against the spec:

- **`approved`** → the workflow completes (`done`).
- **`rejected`** → control returns to `implement` with the review feedback, and the cycle repeats.

The loop is bounded by `maxRounds` (**3**). If the reviewer is still rejecting when the limit is reached, the workflow raises an **escalation gate** so a human can approve as-is, force another revision, or abort — it never loops forever.

## At a glance

- **Mode:** Docker (`claude-code` agent, `--network=none`)
- **Persona:** `global` for every agent state
- **Max rounds:** 3 (implement ⇄ review)
- **Artifacts:** `plan`, `spec`, `reviews` — all under `.workflow/`
- **Terminal states:** `done` (success) · `aborted` (stopped at a gate)

> Tip: write a detailed task description. The planner only sees the task text and whatever already exists in the workspace, so specifics about scope, constraints, and acceptance criteria pay off downstream.
