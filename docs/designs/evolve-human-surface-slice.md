# Evolve Native Workflow — Human-Surface Slice (preflight_review + human_escalation + final_summary/final_review + aborted)

Status: **Design — ready to implement (3 maintainer decisions signed off 2026-06-16, §13).** Independent critical review incorporated (2026-06-16): the human-gate machinery claims were verified correct; this revision owns the one intentional behavior change (`evaluator_blocked → human_escalation`, which retargets a previously-terminal edge and breaks two shipped integration tests — §12), strikes the WF004-violating gate `present:` rows from §4.5, specifies the §12 mock-harness `final_summary` branch, and resolves the budget-extension question (§8.3 / §13). All three residual maintainer decisions are now signed off (§13): `final_summary` = agent state; objective-change = conservative ABORT-to-restart; `evaluator_blocked` = reroute to `human_escalation`.
Audience: IronCurtain workflow engineer extending the merged multi-round `evolve` workflow package.
Implementation contract: this document names the exact `workflow.yaml` delta (current edges → new edges, every new state fully specified), the per-gate surfacing semantics, the `final_summary` agent state and its produced report artifact, the `aborted` terminal, checkpoint/resume behavior across each gate, the lint/validation story, and the binary completion gate. It is precise enough to implement without re-deriving the human-gate machinery.

Predecessors (merged / designed, build ON — do not redesign):

- **Multi-round slice** — `docs/designs/evolve-multi-round-slice.md` (PR #302). Ships the live hub-and-spoke FSM at `src/workflow/workflows/evolve/workflow.yaml`: `preflight → orchestrator` (agent hub) with `sample`/`researcher`/`evaluate`/`analyzer`/`analysis_record` spokes, `isRoundLimitReached` backstop (`settings.maxRounds: 200`), and the determinism fixes in the `evolve_result.py` bridge. The multi-round FSM is **deliberately a strict subgraph** of the parent design — the human surfaces were explicitly deferred (multi-round §11, §15 #3, §16 #2). This slice adds **only** that deferred surface.
- **Parent design** — `docs/designs/asi-evolve-native-workflow.md`: the full FSM including `preflight_review`, `human_escalation`, `final_summary`, `final_review` human gates.
- **Human-gate machinery** (verified, cited inline below): `src/workflow/types.ts`, `validate.ts`, `lint.ts`, `machine-builder.ts`, `orchestrator.ts`, `cli-support.ts`, `workflow-command.ts`, and the direct precedent in `src/workflow/workflows/vuln-discovery/workflow.yaml`.

---

## 1. Summary & goals

The multi-round `evolve` workflow runs an entire bounded program-search loop with **no human in the loop** beyond the helper-layer approval check: it starts the first evaluator the moment `preflight` emits `ready`, it ends every unrecoverable condition (`escalate`, `sample_error`, `evaluator_blocked`, `needs_repair`, `result_file_error`, round-limit wedge) at a single opaque `failed` terminal, and it ends a successful budget-reached run at `done` with no human-readable report. This slice adds the deferred **human surface** from the parent design — and **only** that surface. It introduces three `human_gate` states (`preflight_review`, `human_escalation`, `final_review`), one `final_summary` agent state that produces a human-readable report, and a distinct `aborted` terminal for operator stops. It does **not** touch the orchestrator hub, the sampling/cognition/analyzer/determinism mechanics, or the engine. The result is **a graph superset of the shipped multi-round FSM plus three intentional edge retargets** — `escalate` and `evaluator_blocked` → `human_escalation`, and `complete` → `final_summary`. Every shipped state and edge is otherwise preserved, and the new states slot in at the four seams the parent design always intended for them. Two of the three retargets (`escalate`, `complete`) redirect edges that were never terminal in a way that preserves outcomes; the third (`evaluator_blocked`) is an **intentional behavior change** — it converts a previously-terminal `→ failed` outcome into a human-mediated `→ human_escalation` gate, on the deliberate rationale that a single bad or crashed candidate should not hard-fail a multi-round search (a human decides retry / revise / abort). Genuine infrastructure errors (`result_file_error`, sampler/engine crash) still route to the `failed` terminal; an evaluator that _ran_ but rejected the candidate (`evaluator_blocked`) escalates to a human. This distinction is load-bearing and is re-stated in §4.2, §12, and §13.

```
preflight (agent) ─ready→ preflight_review (GATE) ─APPROVE→ orchestrator (HUB) … (unchanged loop) …
                                                  ─FORCE_REVISION→ preflight
                                                  ─ABORT→ aborted
preflight ─blocked→ failed                                         (unchanged hard-fail)

orchestrator ─escalate→ human_escalation (GATE) ─APPROVE→ orchestrator
evaluate ─evaluator_blocked→ human_escalation     ─FORCE_REVISION→ preflight
                                                  ─ABORT→ aborted

orchestrator ─complete→ final_summary (AGENT, writes report) ─→ final_review (GATE)
final_review ─APPROVE→ done
             ─FORCE_REVISION→ orchestrator   (run more rounds)
             ─ABORT→ aborted

genuine mechanical failures still hard-fail:
   sample ─sample_error / ─result_file_error → failed
   analysis_record ─needs_repair / ─result_file_error → failed
   evaluate ─result_file_error → failed
   guard isRoundLimitReached → failed   (wedge backstop, unchanged)
```

### What ships this slice

- **`preflight_review`** (`human_gate`) between `preflight` and the orchestrator hub. Closes the parent design's "explicit human approval before the first evaluator runs" requirement (§9), which the multi-round slice satisfied only at the helper layer. `APPROVE → orchestrator`, `FORCE_REVISION → preflight`, `ABORT → aborted`.
- **`human_escalation`** (`human_gate`), reachable from the orchestrator's `escalate` verdict **and** from the one deterministic hard-failure edge that genuinely warrants human judgment (`evaluate ─evaluator_blocked`). Mechanical infrastructure failures (`result_file_error`, `sample_error`, `needs_repair`) still hard-fail to `failed` — §4.2 justifies the split. `APPROVE → orchestrator`, `FORCE_REVISION → preflight`, `ABORT → aborted`.
- **`final_summary`** (`agent`): replaces the bare `complete → done` edge. It reads durable run state (`nodes.json`, the best node, the per-round analyses) and **produces a human-readable report artifact** (`final_report`) so the final gate has something to show. Single unconditional transition to `final_review`.
- **`final_review`** (`human_gate`): `present: [final_report]`. `APPROVE → done`, `FORCE_REVISION → orchestrator` (run more rounds), `ABORT → aborted`.
- **`aborted`** (`terminal`): a distinct operator-stop terminal, separate from the error-stop `failed`, so an operator who halted a healthy run is not conflated with an engine crash in `workflow inspect` / the daemon UI (§7).

### Non-goals (out of scope — additive gate surface plus the three edge retargets above)

This slice is a **pure FSM/gate surface addition** (plus the three §1 edge retargets, one of which — `evaluator_blocked → human_escalation` — is a deliberate behavior change, not a topology-only superset). Explicitly out of scope (no work here, no re-architecture):

- `seed_initial` (the parent's baseline-candidate verdict) — still collapsed; the hub keeps its multi-round verdict set unchanged.
- Any **hub re-architecture** — the orchestrator's prompt and routing logic are unchanged except that one of its declared edge targets moves (`escalate → human_escalation` instead of `→ failed`, `complete → final_summary` instead of `→ done`). It still reads `nodes.json` vs `max_rounds` and emits the same verdict vocabulary.
- The `.evolve_runs/` → `.workflow/` layout change — out of scope; the report artifact lives under the existing `.evolve_runs/main/` tree (§6).
- The transaction-log / record-by-step-id idempotency protocol (multi-round §15 #4) — out of scope; the FORCE_REVISION-back-to-orchestrator loop relies on the **already-shipped** "recompute `done_rounds` from durable `nodes.json`" property, not on a new idempotency mechanism (§8).
- The determinism fixes, sampler choice, cognition seeding seam — all unchanged from the multi-round slice.
- **Single-file workflow scope** — the entire delta is in `evolve/workflow.yaml` plus the test; no new state, no new `evolve_result.py` subcommand is strictly required (see §6 for the one open question about whether `final_summary` needs a deterministic helper or can be a pure agent state).

### Goals (binary, restated as the gate)

After this slice, the §12 real-Docker gate proves all of:

1. **`preflight_review` APPROVE happy path** reaches terminal `done` **through** `final_summary` and `final_review` — `states` contains `preflight_review`, `final_summary`, `final_review` in order, and `final_summary`'s `final_report` artifact exists on disk and is non-empty.
2. **`preflight_review` ABORT** reaches terminal `aborted` (not `failed`, not `done`), with **zero** engine nodes recorded (no evaluator ran).
3. **An evaluator-blocked round routes to `human_escalation`**; a `FORCE_REVISION` re-enters `preflight`, the run then proceeds, and the **node-count/parent lineage stays consistent** across the forced re-entry (no double-count, no orphaned parent id).
4. **`final_review` FORCE_REVISION** drives **one extra round** then `APPROVE → done`; the engine DB holds exactly the expected (base N + 1) nodes, with monotone scores and intact parent linkage — proving the forced extra round did not double-count against the `done_rounds` recompute (§8).
5. **`tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict` is clean** — no WF001/WF004 and no `validateHumanGate` failure (every gate's `present:` artifact is produced by a reachable state; every gate reaches a terminal; every transition event is in `acceptedEvents`).
6. **A live `workflow start evolve` … then `workflow inspect <baseDir>`** shows each gate surfacing as `phase: waiting_human` with its summary + presented artifacts, and a final state of `done`.

---

## 2. Where it fits / the delta from the multi-round slice

The multi-round slice proved hub + sampling + cognition + analyzer + determinism with `failed`/`done` terminals and no human gates. This slice keeps **every** state and edge that slice ships and adds the four human seams the parent design always reserved. In order of new surface:

| Capability                      | Multi-round slice (shipped)                                 | This slice                                                                                                |
| ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Approval before first evaluator | helper-layer only (`require_evolve_ready`), no UI gate (§9) | `preflight_review` human gate between `preflight` and `orchestrator` (§4.1)                               |
| Orchestrator `escalate`         | `escalate → failed` (opaque hard fail)                      | `escalate → human_escalation` (APPROVE/FORCE_REVISION/ABORT) (§4.2)                                       |
| Evaluator-blocked round         | `evaluator_blocked → failed`                                | `evaluator_blocked → human_escalation` (human-mediated; §4.2 justifies why **only** this hard-fail moves) |
| Mechanical failures             | `result_file_error`/`sample_error`/`needs_repair → failed`  | **unchanged** — still hard-fail to `failed` (§4.2)                                                        |
| Completion                      | `complete → done` (no report)                               | `complete → final_summary → final_review → done` (§4.3)                                                   |
| Final report                    | none                                                        | `final_summary` agent produces `final_report` (§6); `final_review` presents it                            |
| Operator stop                   | none (every stop is `failed` or `done`)                     | distinct `aborted` terminal (§4.4, §7)                                                                    |
| Round-limit wedge backstop      | `guard: isRoundLimitReached → failed`                       | **unchanged** (still `→ failed`; a wedge is a genuine error, not an operator action)                      |

No workflow-**runtime** change is required. The human-gate machinery (`human_gate` state type, `acceptedEvents`, `present:`, `resolveGate`, `handleGateEntry`, the `waiting_human` phase, the `aborted` phase, WF004/WF001/`validateHumanGate` lint) is **already merged and exercised by `vuln-discovery`** (§3). This slice is, again, pure workflow-package + test — it adds gate/agent/terminal blocks to one YAML and one new integration test, and (maintainer decision §13, decision 1) at most one `evolve_result.py` helper or `final_summary` prompt to materialize the report.

The multi-round maintainer sign-offs carry forward (engine-native `.evolve_runs/main/` layout; `orchestrator` agent hub). The two deferrals this slice **un-defers** are multi-round §16 #2 (`preflight_review`) and §15 #3 (`human_escalation`/`final_summary`/`final_review`).

---

## 3. The human-gate machinery (verified — cite, do not re-derive)

Every fact below is verified in the current tree. The implementer should rely on these citations rather than re-deriving from the runtime.

### 3.1 The `human_gate` state type

`src/workflow/types.ts:240-252`: a `human_gate` state carries `description`, `acceptedEvents: HumanGateEventType[]`, an optional `present: string[]` (artifact names to show the human), and `transitions: { to, event, actions? }[]`. `present:` entries may carry a trailing `?` to mark them optional (`parseArtifactRef`, `validate.ts:234-237`) — a missing optional artifact is not surfaced but does not error.

### 3.2 Event vocabulary (exactly four, all-caps)

`HumanGateEventType` is exactly `APPROVE | FORCE_REVISION | REPLAN | ABORT` (`types.ts:362`; the Zod enum is `validate.ts:70-76`). `resolveGate` maps the chosen event to an XState event `HUMAN_<EVENT>` (`machine-builder.ts:309-329`). **`FORCE_REVISION` and `REPLAN` require a non-empty feedback `prompt`** (`orchestrator.ts:1566-1604`); that feedback is injected into the next agent's prompt as `context.humanPrompt`. This slice uses only `APPROVE`, `FORCE_REVISION`, and `ABORT` (no `REPLAN`) — matching the `vuln-discovery` precedent.

### 3.3 Default and per-transition gate actions

When a gate resolves, the default gate actions run first: `storeHumanPrompt` (writes the feedback into `context.humanPrompt`) and `clearError`. Then any optional per-transition `actions` run — e.g. `resetVisitCounts`. This default-then-optional ordering is wired where gate transitions are **assembled**, in `machine-builder.ts:313-318` (the action list is built as `['storeHumanPrompt', 'clearError', ...t.actions]`, with the `assign` implementations at `machine-builder.ts:557-560`) — **not** in `orchestrator.ts:1566` (that is `resolveGate`, which validates the FORCE*REVISION/REPLAN prompt and sends the `HUMAN*<EVENT>`that triggers this transition). This ordering matters for the FORCE_REVISION loops (§8): the feedback is always available to the destination agent, and an optional`resetVisitCounts`can clear the`isRoundLimitReached` visit accounting after the human authorizes more work.

### 3.4 `validateHumanGate`

`validate.ts:540-551`: a gate must have **≥1 transition**, and **every transition's `event` must appear in `acceptedEvents`**. (It does not require that every `acceptedEvent` has a transition, but this slice declares one transition per accepted event for clarity.)

### 3.5 Lint rules a gate touches

- **WF004** (`lint.ts:255-281`): every artifact named in a reachable gate's `present:` **must be produced by a reachable state**, else an error ("the human will approve without seeing it"). The `produced` set is computed by `collectReachableAgentOutputs` (`lint.ts:149-157`), which collects the `outputs:` lists of **reachable `agent` states only** — terminal `outputs:` do not count (they are arrival declarations, not production). **Consequence for this slice:** `final_review`'s `present: [final_report]` is only clean if a reachable **agent** state lists `final_report` in its `outputs:`. That state is `final_summary` (§6). The current evolve agent states use `outputs: []`; `final_summary` is the first to declare a non-empty `outputs:`, exactly as `vuln-discovery`'s `harness_design` declares `outputs: [harness_design]` (`vuln-discovery/workflow.yaml:352-353`).
- **WF001** (`lint.ts:168-196`): every reachable non-terminal state must have a path to **some** terminal. Each new gate has an `ABORT → aborted` edge, so each reaches the new `aborted` terminal; `final_summary → final_review → done` reaches `done`. All clean.

### 3.6 Phase / status surfacing

`types.ts:488-493`: reaching a gate sets the run's `phase: 'waiting_human'` and attaches a `HumanGateRequest { gateId, stateName, acceptedEvents, presentedArtifacts, summary }` (`types.ts:515-522`). The `aborted` terminal is a **real, distinct phase**: `{ phase: 'aborted'; reason }`. The orchestrator raises a gate on entry via `handleGateEntry` (`orchestrator.ts:2524-2543`) and resolves it via `resolveGate(id, { type, prompt })` (`orchestrator.ts:1566-1604`).

### 3.7 Surfacing + resume

- **CLI surface**: `promptGateInteractive` (`cli-support.ts:189-253`) renders the gate `summary` plus the presented artifacts and offers an `a/f/r/x` menu (approve / force-revision / replan / abort).
- **Resume entry**: `ironcurtain workflow resume <baseDir> [--state <name>]` (`workflow-command.ts:67`) re-enters a checkpointed run, including one paused at a gate.
- **GUI surface**: the daemon / web-ui escalations view is the graphical gate surface (`--web-ui`).

### 3.8 Direct precedent — mirror `vuln-discovery`

`vuln-discovery` already ships exactly the shape this slice needs (`src/workflow/workflows/vuln-discovery/workflow.yaml:296-313`):

```yaml
human_escalation:
  type: human_gate
  description: Human review when investigation is stuck
  acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]
  present: [journal, analysis, discoveries?]
  transitions:
    - { to: orchestrator, event: APPROVE }
    - { to: orchestrator, event: FORCE_REVISION }
    - { to: aborted, event: ABORT }
```

and a distinct `aborted` terminal (`vuln-discovery/workflow.yaml:923-925`):

```yaml
aborted:
  type: terminal
  description: Investigation aborted
```

This slice replicates both shapes (gate blocks and the `aborted` terminal) for `evolve`. The only differences are the `present:` artifact names (evolve's durable run-state files), the `human_escalation` `FORCE_REVISION → preflight` target, and the addition of `preflight_review`/`final_review`/`final_summary`.

---

## 4. FSM delta — concrete `workflow.yaml` edits

All edits are against the current shipped `src/workflow/workflows/evolve/workflow.yaml` (multi-round slice). Each subsection shows the **current** block verbatim, then the **superset edit**. `settings:` and the `sample`/`researcher`/`evaluate`/`analyzer`/`analysis_record` spoke states are **unchanged** and are not reproduced here.

### 4.1 preflight_review gate (between preflight and orchestrator)

**Current** `preflight` transitions (`workflow.yaml:67-71`):

```yaml
transitions:
  - to: orchestrator
    when: { verdict: ready }
  - to: failed
    when: { verdict: blocked }
```

**Edit** — redirect the `ready` edge into the new gate; the `blocked` hard-fail is unchanged (a structurally un-runnable spec is an error, not an operator decision):

```yaml
transitions:
  - to: preflight_review # CHANGED: was `orchestrator`
    when: { verdict: ready }
  - to: failed # unchanged
    when: { verdict: blocked }
```

**New gate state** (insert after `preflight`):

```yaml
preflight_review:
  type: human_gate
  description: >
    Human approval of the run spec, objective, evaluator command, and cognition
    seed before the first evaluator runs.
  acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]
  present:
    - run_spec
    - cognition_seed
  transitions:
    - to: orchestrator
      event: APPROVE
    - to: preflight
      event: FORCE_REVISION
      actions:
        - { type: resetVisitCounts, stateIds: [preflight, orchestrator] }
    - to: aborted
      event: ABORT
```

`run_spec` and `cognition_seed` are the two durable artifacts `preflight` writes (`run_spec.yaml`, `cognition_seed.md`); to satisfy WF004 they must be declared as `preflight` outputs (§4.5, §6.2). The `resetVisitCounts` action (`machine-builder.ts:610-620`) clears the named states' visit counts so a re-authored preflight does not carry stale visit counts into the `isRoundLimitReached` backstop (§8.4). It **requires an explicit non-empty `stateIds` list** (`validate.ts:28-30`, min 1) that references known states (`validate.ts:333-345`) — the bare `actions: [resetVisitCounts]` form is invalid. Here we reset `[preflight, orchestrator]` so the loop restarts cleanly. (Lower-stakes decision, §13 "Lower-stakes decisions": whether `resetVisitCounts` is actually needed pre-loop; it is harmless here and included for symmetry with §4.2/§4.3.)

### 4.2 human_escalation gate (reroute orchestrator escalate + the one human-warranting hard-fail)

**Current** orchestrator and evaluate edges:

```yaml
# orchestrator (workflow.yaml:105-119)
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

# evaluate (workflow.yaml:193-200)
    transitions:
      - to: orchestrator
        when: { verdict: evaluated }
      - to: failed
        when: { verdict: evaluator_blocked }
      - to: failed
        when: { verdict: result_file_error }
      - to: failed
```

**Edit** — only two targets change; everything else is byte-for-byte identical:

```yaml
# orchestrator
      - to: failed                  # unchanged: a wedged hub is a genuine error, not an operator action
        guard: isRoundLimitReached
      …                             # design/evaluate/analyze/record edges unchanged
      - to: final_summary           # CHANGED: was `done` (see §4.3)
        when: { verdict: complete }
      - to: human_escalation        # CHANGED: was `failed`
        when: { verdict: escalate }

# evaluate
      - to: orchestrator            # unchanged
        when: { verdict: evaluated }
      - to: human_escalation        # CHANGED: was `failed`
        when: { verdict: evaluator_blocked }
      - to: failed                  # unchanged: result_file_error is a mechanical I/O failure
        when: { verdict: result_file_error }
      - to: failed                  # unchanged: unguarded fallthrough
```

**Which `failed` edges become human-mediated, and why (explicit):**

| Source edge                                          | Disposition          | Rationale                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| orchestrator `escalate`                              | → `human_escalation` | The orchestrator emits `escalate` precisely when it judges the run unrecoverable _by an agent_ — this is the parent design's literal `human_escalation` trigger.                                                                                           |
| evaluate `evaluator_blocked`                         | → `human_escalation` | An evaluator that rejects the candidate (e.g. missing `solve` symbol, evaluator timeout) is often **repairable by a human-directed revision** (fix the eval cmd, force a new candidate). A human can FORCE_REVISION back to preflight or APPROVE to retry. |
| evaluate `result_file_error`                         | → `failed` (stays)   | The deterministic bridge could not write/parse its `result.json` — a mechanical I/O / contract failure with no human-actionable revision. Hard-fail.                                                                                                       |
| sample `sample_error` / `result_file_error`          | → `failed` (stays)   | Sampler/engine crash or bridge I/O failure — mechanical, not human-actionable. Hard-fail.                                                                                                                                                                  |
| analysis_record `needs_repair` / `result_file_error` | → `failed` (stays)   | Engine record failure / bridge I/O failure — mechanical. Hard-fail.                                                                                                                                                                                        |
| orchestrator `isRoundLimitReached` guard             | → `failed` (stays)   | The wedge backstop. A hub that never terminates is a bug, not an operator decision; routing a wedge to a human gate would defeat the deterministic safety bound (multi-round §3.6). Hard-fail.                                                             |

The principle: **agent-judgment and evaluator-blocked stops are human-mediated; mechanical infrastructure failures and the wedge backstop stay hard failures.** This keeps `human_escalation` meaningful (a human can actually act on it) and keeps `failed` as the unambiguous "something broke mechanically" terminal.

**New gate state** (insert after `analysis_record`, mirroring `vuln-discovery/workflow.yaml:296-313`):

```yaml
human_escalation:
  type: human_gate
  description: >
    Human review when the orchestrator judges the run unrecoverable or the
    evaluator blocked a round. Approve to resume, force a revision back to
    preflight, or abort.
  acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]
  present:
    - run_spec # ONLY agent-produced artifacts survive WF004 (§4.5, §10.2).
      # nodes.json / current/result.json are deterministic-state
      # outputs → not in the lint `produced` set → cannot be in present:.
      # The human inspects them via `workflow inspect <baseDir>`.
  transitions:
    - to: orchestrator
      event: APPROVE
    - to: preflight
      event: FORCE_REVISION
      actions:
        - { type: resetVisitCounts, stateIds: [preflight, orchestrator] }
    - to: aborted
      event: ABORT
```

`run_spec` lets the human see the objective/evaluator that produced the block; the gate `summary` additionally carries the engine's `context.lastError` (the escalation/eval-block reason). The committed nodes (`database_data/nodes.json`) and the in-flight round result (`current/result.json`) are **not** surfaceable via `present:` because they are written by _deterministic_ states, which WF004's `produced` set excludes (§4.5 note, §10.2) — the human inspects them on disk via `workflow inspect <baseDir>`. If a genuine agent producer for `nodes` is later added, `present:` can be widened (§13 "Lower-stakes decisions" — `human_escalation.present`).

### 4.3 complete → final_summary → final_review → done

**Current** completion edge (already shown in §4.2 above): `orchestrator … - to: done; when: { verdict: complete }`. §4.2's edit retargets it to `final_summary`. The two new states:

```yaml
final_summary:
  type: agent
  description: >
    Read the durable run state and the best node, and write a human-readable
    report summarizing the run for the final human review.
  persona: global
  prompt: |
    The Evolve run has reached its round budget. Produce a concise, human-readable
    report of what the run found, for a human reviewer who will decide whether to
    accept the result or request more rounds.

    Read the durable run state:
      - /workspace/.evolve_runs/main/run_spec.yaml — the objective, evaluator, and
        budget.max_rounds (= N).
      - /workspace/.evolve_runs/main/database_data/nodes.json — every recorded node
        (id, parent, score, analysis). Count its "nodes" map for done_rounds.
      - /workspace/.evolve_runs/main/best/ — the best snapshot per improving round;
        the highest-scoring node is the run's result.

    Write a Markdown report to BOTH of these paths (the second is what the human
    reviewer sees through the workflow's artifact surface):
      /workspace/.evolve_runs/main/final_report.md
      /workspace/.workflow/final_report/final_report.md
    Create the /workspace/.workflow/final_report/ directory if it does not exist.
    The report MUST contain, in this order:
      1. The objective (one line, from run_spec.yaml).
      2. done_rounds vs budget.max_rounds.
      3. The best node: its id, its score, and its analysis/lesson.
      4. The score trajectory across rounds (id → score), so the reviewer can see
         whether the search was still improving at the budget cap.
      5. A one-paragraph recommendation: is the result acceptable, or would more
         rounds plausibly help (e.g. the score was still rising at the cap)?

    Do NOT re-run the evaluator, write candidates, or modify any node. You only read
    durable state and write final_report.md.

    Finish with the required agent_status block; your verdict is informational
    (you return to final_review unconditionally).
  inputs:
    - run_spec # only run_spec is an agent-produced artifact; nodes.json/best/ are
      # read directly from /workspace/.evolve_runs/main/ (the prompt above),
      # NOT declared inputs — see §6.1.
  outputs:
    - final_report
  transitions:
    - to: final_review

final_review:
  type: human_gate
  description: >
    Human review of the completed run. Approve to finish, force a revision to run
    more rounds, or abort.
  acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]
  present:
    - final_report
  transitions:
    - to: done
      event: APPROVE
    - to: orchestrator
      event: FORCE_REVISION
      actions:
        - { type: resetVisitCounts, stateIds: [orchestrator] }
    - to: aborted
      event: ABORT
```

`final_summary` is an **agent** state with a single unconditional `to: final_review` edge — exactly the multi-round slice's specialist-return pattern (`researcher`/`analyzer` return unconditionally to the hub). Its `outputs: [final_report]` is what makes `final_review`'s `present: [final_report]` pass WF004 (§3.5). `final_report` is mapped to the on-disk `final_report.md` via the package's artifact-name → path convention (§6.2 / §13 "Lower-stakes decisions" — artifact-dir copy).

`final_review`'s `FORCE_REVISION → orchestrator` (with `resetVisitCounts`) is the "run more rounds" path: re-entering the hub recomputes `done_rounds` from `nodes.json`, finds `done_rounds == max_rounds`, and would immediately re-emit `complete` — **unless** the human's FORCE_REVISION feedback (delivered via `context.humanPrompt`, §3.3) instructs the orchestrator to raise the effective budget. §8.3 specifies exactly how the extra round happens without double-counting.

### 4.4 aborted terminal

**Current** terminals (`workflow.yaml:255-262`):

```yaml
done:
  type: terminal
  description: Round budget reached; candidates scored and recorded.

failed:
  type: terminal
  description: Preflight blocked, sampling failed, evaluator failed, record failed, or round-limit wedge.
```

**Edit** — keep both, add `aborted` (mirroring `vuln-discovery/workflow.yaml:923-925`):

```yaml
done:
  type: terminal
  description: Round budget reached and human-approved; candidates scored and recorded.

failed:
  type: terminal
  description: >
    Mechanical failure — preflight blocked, sampler/engine crash, result-file
    contract error, record failure, or round-limit wedge backstop.

aborted:
  type: terminal
  description: Operator aborted the run at a human gate (preflight_review, human_escalation, or final_review).
```

### 4.5 Full extended states map (delta summary)

Net state-list change against the shipped FSM:

| State              | Status     | Type          | Note                                                                                              |
| ------------------ | ---------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `preflight`        | **edited** | agent         | `ready` edge retargeted to `preflight_review`; gains `outputs: [run_spec, cognition_seed]` (§6.2) |
| `preflight_review` | **new**    | human_gate    | §4.1                                                                                              |
| `orchestrator`     | **edited** | agent         | `escalate → human_escalation`, `complete → final_summary`; all other edges unchanged              |
| `sample`           | unchanged  | deterministic |                                                                                                   |
| `researcher`       | unchanged  | agent         |                                                                                                   |
| `evaluate`         | **edited** | deterministic | `evaluator_blocked → human_escalation`; other edges unchanged                                     |
| `analyzer`         | unchanged  | agent         |                                                                                                   |
| `analysis_record`  | unchanged  | deterministic |                                                                                                   |
| `human_escalation` | **new**    | human_gate    | §4.2                                                                                              |
| `final_summary`    | **new**    | agent         | §4.3, §6                                                                                          |
| `final_review`     | **new**    | human_gate    | §4.3                                                                                              |
| `done`             | edited     | terminal      | description only                                                                                  |
| `failed`           | edited     | terminal      | description only (now "mechanical failure")                                                       |
| `aborted`          | **new**    | terminal      | §4.4, §7                                                                                          |

**WF004 production requirements** (the artifact names every gate `present:` references must be produced by a reachable agent state's `outputs:`):

This table lists **only artifact names that legally appear in a gate `present:`** — i.e. names produced by a reachable **agent** state's `outputs:`. `nodes` and `current_result` are deliberately **absent**: they are written by _deterministic_ states (`analysis_record`, `evaluate`), which WF004's `produced` set excludes, so they **cannot** appear in any gate's `present:` (see the note below). The SHIPPING `human_escalation.present:` is therefore `[run_spec]` only.

| Artifact name    | `present:` in …                    | Produced by (`outputs:` of) …                |
| ---------------- | ---------------------------------- | -------------------------------------------- |
| `run_spec`       | preflight_review, human_escalation | **`preflight`** (new `outputs:` entry)       |
| `cognition_seed` | preflight_review                   | **`preflight`** (new `outputs:` entry)       |
| `final_report`   | final_review                       | **`final_summary`** (agent `outputs:` entry) |

**Do NOT add `nodes` or `current_result?` to any gate's `present:`.** WF004 will fire on both. They are inspect-only (`workflow inspect <baseDir>`), never gate-presented, unless a genuine **agent** producer is added (§13 "Lower-stakes decisions" — `human_escalation.present`). The two rows for `nodes`/`current_result?` that previously appeared here were a latent WF004 error and have been removed so an implementer copying this table cannot reintroduce it.

**Note (load-bearing, §13 "Lower-stakes decisions" — `human_escalation.present`):** WF004's `produced` set is collected **only from reachable `agent` states' `outputs:`** (`collectReachableAgentOutputs`, `lint.ts:149-157`); deterministic-state `outputs:` are arrival declarations, not production, and are excluded (`lint.ts:145-148`). WF004 then parses each `present:` entry and checks the **bare name** against `produced` **regardless of any `?` suffix** (`lint.ts:267-268`: `const { name } = parseArtifactRef(entry); if (!produced.has(name)) …`). `nodes` and `current_result` are written by **deterministic** states (`analysis_record`, `evaluate`), which lint does **not** count as producers. Three resolutions, in preference order:

1. **Mark them optional** (`nodes?`, `current_result?`) — WF004 still checks the parsed `name` against `produced` regardless of the `?` (`lint.ts:267-268` parses then checks the bare name), so optionality does **not** exempt them. This does **not** work; rejected.
2. **Declare them as outputs of a reachable agent state.** The cleanest faithful option is to give the `orchestrator` (which reads `nodes.json` every turn) an `outputs: [nodes]` and the `analyzer`/`evaluate`-adjacent agent an output — but no agent _writes_ `nodes.json` (the deterministic `analysis_record` does), so this would be a lint-satisfying fiction.
3. **Drop the unproducible names from `present:`.** Keep `human_escalation`'s `present:` to artifacts that _are_ agent-produced: `present: [run_spec]` (from `preflight`) is sufficient and honest. The human can still inspect `nodes.json`/`current/result.json` on disk via `workflow inspect`; `present:` is a convenience surface, not the only access path. **This is the recommended resolution** — it keeps WF004 clean without inventing fake producers. The §4.2 block above should therefore ship as `present: [run_spec]` unless the implementer adds a genuine agent producer for `nodes` (see §13 "Lower-stakes decisions" — `human_escalation.present`).

This wrinkle does **not** affect `preflight_review` (both its `present:` artifacts are written by the `preflight` _agent_) or `final_review` (its `final_report` is written by the `final_summary` _agent_). It only constrains `human_escalation`'s `present:` list. The verbatim §4.2 block is annotated accordingly; the safe default is `present: [run_spec]`.

---

## 5. Per-gate semantics

Each gate, on entry, sets `phase: 'waiting_human'` and builds a `HumanGateRequest` whose `presentedArtifacts` is the set of `present:` names that resolve to an **existing directory under the run's artifact dir** (`<workspace>/.workflow/<name>/`, `orchestrator.ts:2545-2575` `buildGateRequest`). The `summary` is `"Waiting for human review at <gateName>"`, suffixed with `context.lastError` when the gate was reached via an error path (`orchestrator.ts:2562-2565`) — so a `human_escalation` reached via `evaluator_blocked` carries the engine's error string into the summary automatically, with no extra wiring.

**Artifact-path convention (load-bearing — see §6.2 and §13 "Lower-stakes decisions" — artifact-dir copy).** A `present:` name `X` is surfaced from `<workspace>/.workflow/X/` (the `FileArtifactManager`/orchestrator convention, `orchestrator.ts:2555`), **not** from `<workspace>/.evolve_runs/main/`. Evolve's durable engine files live under `.evolve_runs/main/`, so a gate can only surface an artifact through `present:` if a producing agent has copied/written it into `.workflow/<name>/`. This is why the `present:` lists below are deliberately conservative, and why `final_summary` writes its report into the artifact dir (§6).

### 5.1 preflight_review

- **When**: immediately after `preflight` emits `ready`, before the orchestrator hub ever runs — so before the first `sample`/`evaluate`.
- **Surfaces**: `summary = "Waiting for human review at preflight_review"`; `present: [run_spec, cognition_seed]` — the human sees the objective, evaluator command, budget, sampler, and the authored cognition heuristics, i.e. everything they are approving. These are surfaced only if `preflight` wrote them into `.workflow/run_spec/` and `.workflow/cognition_seed/` (§6.2 specifies the copy; the safe fallback if the copy is descoped is `present: [run_spec]` or an empty `present:` with the human reading `.evolve_runs/main/` via `workflow inspect`).
- **Events / targets**: `APPROVE → orchestrator` (begin the loop); `FORCE_REVISION → preflight` (re-author the spec, with the human's `prompt` feedback in `context.humanPrompt`); `ABORT → aborted`.
- **FORCE_REVISION feedback flow**: the human's required `prompt` (§3.2) is stored by the default `storeHumanPrompt` action into `context.humanPrompt`; on re-entry, `preflight`'s `buildAgentCommand` injects it as a "Scoping from the previous agent / human directive" preamble (the same `context.humanPrompt` consumption the orchestrator already does for FORCE_REVISION loops). The preflight agent reads it and adjusts the objective/evaluator/seed accordingly.

### 5.2 human_escalation

- **When**: the orchestrator emits `escalate` (it judged the run unrecoverable), OR `evaluate` emitted `evaluator_blocked` (a round's candidate was rejected by the evaluator).
- **Surfaces**: `summary` carries the `context.lastError` suffix (the engine's escalation/eval-block reason). `present: [run_spec]` (the recommended honest set — see §4.5 note). The human can additionally inspect `.evolve_runs/main/database_data/nodes.json` and the in-flight `.evolve_runs/main/current/result.json` via `workflow inspect <baseDir>`; surfacing those through `present:` is blocked by WF004 (they are written by deterministic states, not agents — §4.5), so they are inspect-only, not gate-presented, unless a genuine agent producer is added (§13 "Lower-stakes decisions" — `human_escalation.present`).
- **Events / targets**: `APPROVE → orchestrator` (resume the loop — e.g. the human fixed the evaluator out-of-band, or judged the escalation a false alarm); `FORCE_REVISION → preflight` (re-author the run spec — the natural fix for an evaluator that is fundamentally mis-specified, with `resetVisitCounts` so the re-authored run does not inherit stale visit counts toward the wedge backstop); `ABORT → aborted`.
- **FORCE_REVISION feedback flow**: identical mechanism to §5.1 — the human's `prompt` becomes `context.humanPrompt` and is read by `preflight` on re-entry. Note the destination is `preflight` (not `orchestrator`): an evaluator-blocked run is usually fixed by re-specifying, not by re-routing, so the loop returns to the spec author.

### 5.3 final_review

- **When**: after `orchestrator` emits `complete` and `final_summary` has produced the report.
- **Surfaces**: `present: [final_report]` — the human reads `final_summary`'s Markdown report (objective, done_rounds vs budget, best node + its lesson, score trajectory, recommendation). This is the **only** `present:` artifact in the slice that is guaranteed surfaceable, because `final_summary` (an agent) writes it into the artifact dir under its declared `outputs: [final_report]` (§6).
- **Events / targets**: `APPROVE → done` (accept the result, terminate successfully); `FORCE_REVISION → orchestrator` (run more rounds — see §8.3 for how the extra round avoids double-counting; the human's `prompt` instructs the orchestrator to extend the effective budget, delivered via `context.humanPrompt`, and `resetVisitCounts` clears the wedge-backstop accounting so the extra rounds are not immediately capped); `ABORT → aborted`.
- **FORCE_REVISION feedback flow**: the destination is the `orchestrator` (not `preflight`) — "run more rounds" is a routing decision, not a re-spec. The orchestrator reads `context.humanPrompt` ("run K more rounds") and must reconcile it against its durable `done_rounds == max_rounds` read; §8.3 specifies the exact reconciliation.

---

## 6. final_summary agent state

`final_summary` is the one genuinely new agent state. It exists because `final_review` needs a human-readable artifact to present, and the durable engine files (`nodes.json`, `best/`) are machine state, not a report.

### 6.1 Inputs and behavior

- **Inputs**: the only declared workflow `inputs:` artifact is `run_spec` — the one input that is agent-produced (by `preflight`). The other durable state it reads — `database_data/nodes.json` (every recorded node — id, parent, score, analysis) and `best/` (the best snapshot per improving round) — is read **directly from `/workspace/.evolve_runs/main/` on disk via the §4.3 prompt**, NOT declared as `inputs:`. Declaring `nodes`/`best` as `inputs:` would fail `validateArtifactInputs` (`validate.ts:559-563`): they are written by deterministic states, so they are not in the agent-`outputs:` set — the same WF004 constraint that keeps them out of any gate's `present:` (§4.5). It does **not** re-run the evaluator, write candidates, or mutate any node — it is a pure read-then-summarize agent (the §4.3 prompt forbids mutation explicitly).
- **Output (the report)**: a Markdown report covering (1) the objective, (2) `done_rounds` vs `budget.max_rounds`, (3) the best node (id, score, lesson), (4) the per-round score trajectory, (5) a recommendation on whether more rounds would plausibly help. The trajectory + recommendation are what let the human make the `APPROVE` vs `FORCE_REVISION` (run-more-rounds) decision at `final_review`.
- **Transition**: a single unconditional `to: final_review` (no verdict gating) — the multi-round specialist-return pattern. Its `agent_status` verdict is informational.

### 6.2 How the report is declared _produced_ (WF004) and _surfaced_ — the load-bearing detail

WF004 (`lint.ts:255-281`) requires that `final_review`'s `present: [final_report]` name be in the `produced` set, which `collectReachableAgentOutputs` builds from reachable **agent** states' `outputs:` (`lint.ts:149-157`). So `final_summary` declares:

```yaml
outputs:
  - final_report
```

This is the **first non-empty `outputs:` in the evolve package** (all other evolve agent states use `outputs: []`). It does two things:

1. **Satisfies WF004** — `final_report` is now produced by a reachable agent, so the gate's `present:` is clean.
2. **Triggers the orchestrator's post-agent artifact check** — after `final_summary` runs, `findMissingArtifacts(stateConfig, instance.artifactDir)` (`orchestrator.ts:2249`) verifies that `<workspace>/.workflow/final_report/` contains at least one file; if absent, the agent is re-prompted, then the run errors (`orchestrator.ts:2250-2265`). **This is why the §4.3 prompt instructs `final_summary` to write `final_report.md` into `/workspace/.workflow/final_report/`** — not only into `.evolve_runs/main/`. The artifact-dir copy is what both `findMissingArtifacts` (production check) and `buildGateRequest` (`existsSync(resolve(artifactDir, name))`, `orchestrator.ts:2555-2556`, surfacing) look for.

Concretely: `instance.artifactDir = resolve(workspacePath, '.workflow')` (`orchestrator.ts:1249, 1346`), and a presented artifact `X` is read from `<workspace>/.workflow/X/` with a `<X>.md` convention filename (`artifacts.ts:174-188`). Writing `/workspace/.workflow/final_report/final_report.md` matches that convention exactly. The duplicate write to `.evolve_runs/main/final_report.md` is optional documentation co-location; the artifact-dir copy is the contract.

**Keep the `.md` suffix exact (convention-fragility caution).** `read()` tries the convention path `<X>/<X>.md` first (`artifacts.ts:179`) and only falls back to "first file in the directory" (`artifacts.ts:184`) if that exact name is missing. So a file named `final_report/final_report.md` is read deterministically; a file named anything else (e.g. `report.md` or `final_report.markdown`) is read only via the fragile "first file" fallback — which surfaces the wrong file if the directory ever holds more than one. **Write exactly `<artifactName>.md`** (`final_report.md`, `run_spec.md`, `cognition_seed.md`) so production and surfacing both hit the deterministic convention path, never the fallback.

### 6.3 Why `run_spec` / `cognition_seed` for preflight_review work the same way

`preflight_review` presents `run_spec` and `cognition_seed`. For these to surface, `preflight` (an agent) must declare `outputs: [run_spec, cognition_seed]` **and** write them into `.workflow/run_spec/run_spec.md` (or any file under that dir) and `.workflow/cognition_seed/cognition_seed.md`. `preflight` already authors `run_spec.yaml` and `cognition_seed.md` under `.evolve_runs/main/`; this slice adds a copy-into-`.workflow/<name>/` step to its prompt (or, if the implementer prefers to keep `preflight` minimal, descope `preflight_review`'s `present:` to empty and rely on `workflow inspect` — see §13 "Lower-stakes decisions" — artifact-dir copy). **Recommended:** add the copy; it is two `mkdir -p` + two `cp` lines in the preflight prompt and makes the approval gate actually informative.

### 6.4 OPEN QUESTION — pure-agent vs deterministic helper for the report

`final_summary` is specified as a **pure agent** state (LLM reads `nodes.json`, writes Markdown). An alternative is a `deterministic`/`container: true` state running a new `evolve_result.py final_summary` subcommand that emits a templated report from `nodes.json` — fully reproducible, no LLM. Trade-off: the deterministic helper is cheaper and testable without a model, but it adds an `evolve_result.py` subcommand (mild scope creep against "single-file workflow scope") and produces a less narratively useful report. The agent version keeps the slice to one YAML + one test and matches the parent design's `final_summary` as an agent. **Recommendation: agent state** (as specified); flag the deterministic alternative for the maintainer (§13 decision 1).

---

## 7. aborted terminal vs failed — how they differ in checkpoint / inspect / UI

The two terminals differ both in **semantics** (operator stop vs mechanical error) and in **runtime phase mapping** — and the phase mapping has a verified subtlety the implementer must understand.

### 7.1 The phase mapping (verified)

When a run reaches a terminal, `handleWorkflowComplete` (`orchestrator.ts:2581-2634`) sets `finalStatus.phase`:

- If the terminal **state name is `aborted`** (or contains `abort`), `phase: 'aborted'` with `reason: 'Workflow reached aborted state'` (`orchestrator.ts:2623-2627`). **This is exactly why the operator-stop terminal must be named `aborted`** — the name is the trigger.
- **Otherwise** (including the `failed` and `done` terminals), `phase: 'completed'` (`orchestrator.ts:2628-2634`). So reaching the `failed` _terminal state_ by itself does **not** produce `phase: 'failed'` — it produces `phase: 'completed'`, distinguished from `done` only by the terminal state _name_ recorded in the checkpoint.
- A true `phase: 'failed'` (`types.ts:492`, `{ phase: 'failed'; error; lastState }`) arises from a different path — an **invoke/agent error** surfaced via the lifecycle `kind: 'failed'` event (`orchestrator.ts:1771-1775`, `1647`), not from transiting to a terminal named `failed`. (Quota/transient upstream failures also force `phase: 'aborted'` to preserve the checkpoint — `orchestrator.ts:2601-2622` — independent of which terminal was reached.)

**Implication for this slice:** the _only_ reliable way to give an operator-stop a distinct, resumable, non-error phase is the dedicated `aborted` terminal. A gate `ABORT → failed` would land on `phase: 'completed'` and be indistinguishable from a normal `done` in `finalStatus.phase` (differing only by the recorded terminal name). The `aborted` terminal is therefore **load-bearing**, not cosmetic.

### 7.2 Checkpoint / resume difference

`isCheckpointResumable` excludes `phase: 'completed'` runs but **retains** `phase: 'aborted'` and `phase: 'failed'` (`orchestrator.ts:1611-1613` references all three). **Note the two distinct things both spelled "failed":** the `failed` _terminal state_ maps to `phase: 'completed'` (§7.1, `checkpoint.ts:17-18`) and is therefore **not** resumable, whereas an invoke/agent-error `phase: 'failed'` (a different path — §7.1 third bullet) **is** retained and resumable. Reaching the `failed` terminal does not produce `phase: 'failed'`. So:

- `done` (→ `phase: 'completed'`): not resumable; checkpoint retained for inspection only.
- `aborted` (→ `phase: 'aborted'`): **resumable** — the checkpoint preserves the last non-terminal state so `workflow resume <baseDir>` can re-enter where the operator stopped (§8). This is the right behavior: an operator who aborted to inspect can resume.
- `failed` _terminal_ (→ `phase: 'completed'`, recorded terminal `failed`): **not resumable** — treated as a finished mechanical failure; inspect shows `Final: completed` with the terminal state `failed`. This is **distinct** from a genuine invoke-error `phase: 'failed'`, which never transits a terminal and _is_ separately resumable per `orchestrator.ts:1611-1613`. Do not conflate the `failed` terminal (non-resumable, `phase: 'completed'`) with the invoke-error `phase: 'failed'` (resumable).

### 7.3 `workflow inspect` / UI

`workflow inspect <baseDir>` prints `Final: <phase>` from the checkpoint (`workflow-command.ts:430`). After this slice:

- An operator-aborted run shows `Final: aborted` — clearly distinct from `Final: completed` for a `done` run and from a mechanical `failed`.
- The daemon / web-ui escalations + past-runs views key on the same `finalStatus.phase`, so `aborted` renders as a distinct status (operator stop) rather than being conflated with error or success.

**Net:** `aborted` is the operator-stop terminal (distinct phase, resumable), `failed` stays the mechanical-error terminal, and `done` stays the success terminal. The three are now genuinely distinguishable in checkpoint, inspect, and UI — which they were not before this slice (every stop was `done` or `failed`).

---

## 8. Checkpoint & resume across each gate

A human gate is a **durable `waiting_human` pause**: on entry the orchestrator sets `phase: 'waiting_human'`, raises the gate, and the run blocks. This section spells out re-entry and the one genuinely subtle interaction — the FORCE_REVISION loop vs the multi-round slice's "recompute `done_rounds` from durable `nodes.json`" property.

### 8.1 A gate is a durable pause; `workflow resume` re-enters it

When a gate raises, the checkpoint records the run at the gate state with `phase: 'waiting_human'`. `ironcurtain workflow resume <baseDir> [--state <name>]` (`workflow-command.ts:67`) re-enters a paused run. For a gate, resume re-surfaces the same `HumanGateRequest` (the gate state is re-entered and `handleGateEntry` re-fires), so the operator sees the summary + presented artifacts again and can resolve it. Resolving sends `HUMAN_<EVENT>` (`machine-builder.ts:309-329`) and the run continues down the chosen edge. Because all the run's _logic_ state is durable on disk (`run_spec.yaml`, `nodes.json`, `current/`), nothing about the in-flight round is lost across the pause — the gate adds no in-memory state that resume must reconstruct beyond the gate request itself.

### 8.2 FORCE_REVISION back to `preflight` (preflight_review, human_escalation)

These loops re-enter `preflight`, an agent state that **overwrites** `run_spec.yaml`/`cognition_seed.md` from scratch with the human's `context.humanPrompt` feedback in hand. Two cases:

- **`preflight_review → preflight` (no nodes yet).** `done_rounds == 0` (no `nodes.json`), so there is nothing to double-count. Re-authoring is a clean restart of the spec; the subsequent `preflight_review` re-approves the revised spec. `resetVisitCounts [preflight, orchestrator]` clears any visit accounting from the first preflight attempt.
- **`human_escalation → preflight` (mid-run, nodes may exist).** Here `nodes.json` may already hold committed rounds. Re-authoring `run_spec.yaml` does **not** delete `nodes.json` — so when the loop returns through `preflight_review → orchestrator`, the orchestrator recomputes `done_rounds` from the **existing** `nodes.json` and resumes the loop from the committed count. This is correct _only if_ the human's revision is compatible with the existing nodes (e.g. fixing the evaluator command). **OPEN MAINTAINER DECISION (§13 decision 2):** if the human's revision changes the _objective_ (making prior nodes meaningless), the existing `nodes.json` is stale but not cleared, so the orchestrator would count stale rounds toward `max_rounds` **and sample them as parents**. No safe engine "reset DB" operation was found, so re-authoring the spec cannot clear the database. The recommended conservative contract is: `human_escalation → preflight` is for _evaluator/spec repair that preserves node validity_; a fundamental objective change should `ABORT` and start a fresh run. The preflight prompt and the gate description should state this. (Adding an engine "reset DB" step on objective change is real scope creep, out of scope here — see §13 decision 2 for the tradeoff and the requested sign-off.)

### 8.3 FORCE_REVISION back to `orchestrator` (final_review) — the double-count question, answered

This is the subtle one. At `final_review`, `done_rounds == max_rounds` (the loop completed). `FORCE_REVISION → orchestrator` re-enters the hub. The multi-round slice's load-bearing property is: **the orchestrator recomputes `done_rounds` from `nodes.json` on every entry, never from FSM memory** (multi-round §3.2, §10.3). So on this re-entry the orchestrator reads `done_rounds == max_rounds` again and — with no other change — would immediately re-emit `complete`, bouncing straight back to `final_summary → final_review` in an unproductive loop. **Running "more rounds" therefore requires raising the effective round budget**, and there are exactly two clean ways to do it:

1. **(Recommended) The human's FORCE_REVISION feedback instructs a budget raise, and the orchestrator honors `context.humanPrompt` over the spec for this decision.** The human's required `prompt` (e.g. "run 2 more rounds") arrives as `context.humanPrompt`. The orchestrator's prompt is extended (§11) with: _"If `context.humanPrompt` requests additional rounds, treat the effective budget as `done_rounds + K` for this turn and emit `design` instead of `complete`; you do not need to rewrite run_spec.yaml."_ The orchestrator then emits `design`, runs K more rounds (each appending one node to `nodes.json`, so `done_rounds` climbs past the original `max_rounds`), and re-emits `complete` once `done_rounds >= done_rounds_at_force + K`. **No double-count:** each extra round is a genuine new `analysis_record` node at the next `next_id`, with a real sampled parent — the node count, parents, and scores stay consistent exactly as in a normal round (the §12 gate asserts this). The extra rounds are _additional_ real rounds, not re-records of existing ones.
2. **(Unnecessary alternative) The orchestrator rewrites `run_spec.yaml budget.max_rounds`.** This was once recorded as a possible fallback in case some _engine_ helper enforced `budget.max_rounds` as a hard stop and rejected `done_rounds` exceeding it. **It does not, so this rewrite is unnecessary** — see "Budget enforcement (RESOLVED)" below. Retained here only to note it is mechanically possible (the engine's `cmd_brief_normalize` treats _sampling_ config as immutable once nodes exist, multi-round §4.1, but `budget.max_rounds` is not in that immutable set), not because the slice needs it.

**Budget enforcement — RESOLVED (option 1 is confirmed viable; option 2 is unnecessary).** Verified in the vendored engine: **no engine helper enforces `budget.max_rounds` as a stopping condition.** The orchestrator is the _only_ component that compares `done_rounds` against `max_rounds`. Specifically:

- `require_evolve_ready` (`evolve-engine/.../run_state.py:288-297`) — the gate every mutating/evaluator/record helper calls — checks only (a) missing required fields and (b) `approval.confirmed`. It does **not** read or enforce `budget.max_rounds`.
- The result bridge computes `done_rounds = _node_count(run_dir)` and allocates `step_{done_rounds + 1:04d}` with **no cap** (`evolve-engine/.../evolve_result.py:276-277`) — it will happily run a `done_rounds + 1`-th round when `done_rounds == max_rounds`.
- The engine DB allocates ids monotonically from its own counter (`node.id = self.next_id; self.next_id += 1`, `evolve-engine/.../database.py:73-74`) — independent of any budget.

So an extra round past the original `max_rounds` (option 1: orchestrator emits `design`, consuming `context.humanPrompt`, without rewriting the spec) is accepted by every helper and records a real node at the next `next_id`. **The slice ships option 1.** Scenario D's "exactly N+1 nodes, monotone scores, intact lineage" assertion is the end-to-end proof. (This resolves what was formerly open question #6 — see the "Resolved" entry in §13.)

**Why no double-count under either path:** the engine's `evolve-db record` allocates a fresh `next_id` per call (multi-round §3.5), and `analysis_record` is the _single_ record per round. An extra round runs the full `design → evaluate → analyze → record` cycle once and commits exactly one new node whose `parent` is the greedy pick from the now-larger DB. The "recompute `done_rounds` from `nodes.json`" property _guarantees_ the loop terminates again at the new effective budget — it never re-counts a committed node. The only thing FORCE_REVISION changes is the _target_ the orchestrator compares `done_rounds` against.

### 8.4 The `isRoundLimitReached` backstop and `resetVisitCounts`

**Caution — use the shipped budget, not the stale parent-doc number.** The shipped `workflow.yaml:16` sets `settings.maxRounds: 200`; this slice inherits **200**. The parent multi-round design doc (`evolve-multi-round-slice.md:412`) discusses `maxRounds: 24`, which is **stale** — do not cross-reference that 24 when reasoning about the wedge backstop here.

The wedge backstop (`settings.maxRounds: 200`, `guard: isRoundLimitReached → failed`, multi-round §3.6) counts **agent-state visits** via `context.visitCounts` (incremented only on agent entry, `machine-builder.ts:262`; the guard compares `max(visitCounts) >= maxRounds`, `guards.ts:21-26`). The orchestrator is the most-visited agent (~`4N+1` entries for N rounds). Two interactions:

- **FORCE_REVISION → orchestrator (run more rounds) accumulates orchestrator visits.** K extra rounds add ~`4K` orchestrator entries on top of the original `4N+1`. With `maxRounds: 200` and realistic N+K, this is far below the cap, so the backstop is not tripped by a single human-authorized extension. But to be safe and to keep the backstop's semantics ("safety ceiling on hub entries, not the round budget"), the FORCE_REVISION edges carry `resetVisitCounts: [orchestrator]` (and `[preflight, orchestrator]` for the preflight-bound edges) — clearing the accumulated visit count at the human-authorized boundary so a long sequence of human-driven extensions cannot spuriously trip the wedge guard. This is correct because the human pressing FORCE_REVISION _is_ the deliberate authorization the backstop exists to distinguish from a wedged agent.
- **`resetVisitCounts` only touches the named states** (`machine-builder.ts:610-619`) — it does not reset unrelated states' counts, and it does not affect `done_rounds` (which is recomputed from `nodes.json`, not from `visitCounts`). So resetting orchestrator visits at a gate is purely a backstop concern; it cannot corrupt the loop's round logic.

**Important non-interaction:** `done_rounds` (the loop terminator) is read from durable `nodes.json` and is **entirely independent** of `visitCounts` (the wedge backstop). `resetVisitCounts` can never cause a round to re-run or double-count — it only changes how many _more_ agent entries the safety guard will tolerate before force-failing. The forced extra round in §8.3 increments `done_rounds` by exactly one per `analysis_record`, regardless of any visit-count reset.

### 8.5 Checkpoint retention across abort

A gate `ABORT → aborted` lands on `phase: 'aborted'`, which `isCheckpointResumable` retains (§7.2). So an operator who aborts at a gate can later `workflow resume <baseDir>` and re-enter the _pre-gate_ state (the checkpoint preserves the last non-terminal state, `orchestrator.ts:2636-2643`). This means `ABORT` is not destructive — it is a resumable stop, consistent with the parent design's operator-stop semantics.

---

## 9. Security / policy

The parent design requires "explicit human approval before running the first evaluator" (`asi-evolve-native-workflow.md:945`). The multi-round slice satisfied this requirement **only halfway** (multi-round §11): it relied on the engine's **helper-layer** enforcement — `require_evolve_ready` (`run_state.py:288`) is called by `cmd_eval_run`/`cmd_db_record`/`cmd_db_sample`/`cmd_cognition_*`, so every mutating/evaluator/record helper hard-rejects a run whose `approval.confirmed` is not `true`. That enforcement is machine-readable and real, but it has **no human-in-the-loop UI surface** — `preflight` sets `approval.confirmed=true` itself, so the "human approval" was effectively self-asserted by the agent, with no operator pause.

`preflight_review` closes the other half:

- **Enforcement half (unchanged, still present):** `require_evolve_ready` still gates every helper. Nothing about the helper-layer check changes — it remains the authoritative machine guard that an unapproved run cannot evaluate or record.
- **Human-in-the-loop half (new):** `preflight_review` inserts a real operator pause _between_ `preflight` (which authors `run_spec.yaml` with `approval.confirmed=true`) and the orchestrator hub (the first state that would dispatch `sample`/`evaluate`). The first evaluator (`evaluate`) is reachable **only** via `orchestrator`, which is reachable **only** via `preflight_review` `APPROVE`. So no evaluator can run until a human has seen the objective + evaluator command + cognition seed (`present: [run_spec, cognition_seed]`) and explicitly approved — exactly the parent design's requirement, now enforced by FSM topology, not just helper-layer self-assertion.

**Defense in depth:** the two halves are complementary. Even if a future FSM edit accidentally routed around `preflight_review`, `require_evolve_ready` would still reject an unapproved run at the helper layer; and even if `approval.confirmed` were set by a misbehaving agent, the human gate still pauses the run before the first evaluator. Neither half is weakened by adding the other. This slice does **not** modify the helper-layer check, the approval field, or any policy-engine behavior — it is purely an FSM/gate-topology addition that makes the human approval observable and blocking.

No change to the determinism guarantees or the vendored-engine byte-verbatim invariant: this slice adds no engine code and no determinism-affecting path. The gates are control-flow only.

---

## 10. Lint / validation

The extended manifest must lint clean under `tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict` (runs `validateDefinition()` then `lintWorkflow()`). The gate-specific checks:

### 10.1 `validateHumanGate` (`validate.ts:540-551`)

Each new gate has ≥1 transition, and every transition's `event` is in its `acceptedEvents`:

- `preflight_review`: `acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]`; transitions use exactly those three events. ✓
- `human_escalation`: same. ✓
- `final_review`: same. ✓

No gate uses `REPLAN`, so none needs a `REPLAN` transition. (A gate may declare an accepted event without a transition, but we declare one per event for clarity.)

### 10.2 WF004 — gate `present:` artifacts must be produced by a reachable agent (`lint.ts:255-281`)

The `produced` set = reachable **agent** states' `outputs:` (`lint.ts:149-157`). Required producers:

- `preflight_review.present: [run_spec, cognition_seed]` ⇐ `preflight.outputs: [run_spec, cognition_seed]` (new). ✓ _provided_ `preflight` copies them into `.workflow/run_spec/` and `.workflow/cognition_seed/` (§6.2/§6.3) so the post-agent `findMissingArtifacts` check passes — declaring an output the agent never writes into the artifact dir makes the _agent state_ fail at runtime even though lint is satisfied.
- `final_review.present: [final_report]` ⇐ `final_summary.outputs: [final_report]` (new). ✓ (and `final_summary` writes `.workflow/final_report/final_report.md`, §6.2).
- `human_escalation.present`: the **recommended** form is `present: [run_spec]` (⇐ `preflight.outputs`), avoiding the `nodes`/`current_result` problem (those are written by _deterministic_ states, which lint does not count as producers — §4.5 note). If the implementer keeps `nodes`/`current_result?` in `present:`, WF004 **will fire** (they are not agent-produced) regardless of the `?` suffix (`lint.ts:267-268` parses then checks the bare name). **So the §4.2 block must ship as `present: [run_spec]`** unless a genuine agent producer for `nodes` is added (§13 "Lower-stakes decisions" — `human_escalation.present`).

### 10.3 WF001 — terminal reachability (`lint.ts:168-196`)

Every reachable non-terminal must reach some terminal:

- `preflight_review` → `aborted` (via ABORT). ✓
- `human_escalation` → `aborted` (via ABORT). ✓
- `final_summary` → `final_review` → `done`/`aborted`. ✓
- `final_review` → `done`/`aborted`. ✓
- All pre-existing states still reach `done`/`failed`/`aborted`. ✓

The new `aborted` terminal is reachable (from all three gates), so it is not an orphan, and terminals need no outgoing edge.

### 10.4 `resetVisitCounts` validation (`validate.ts:28-30, 333-345`)

Each FORCE_REVISION action uses the explicit `{ type: resetVisitCounts, stateIds: [...] }` form with a non-empty `stateIds` list referencing **known** states (`preflight`, `orchestrator` — both exist). ✓ The bare `actions: [resetVisitCounts]` form would fail schema validation.

### 10.5 Unaffected lint rules

WF006/WF008/WF011/WF012 are unchanged from the multi-round slice — this slice adds no `container: true`/`resultFile`/`maxVisits`/`isStateVisitLimitReached` surface. `settings.maxRounds: 200` + the orchestrator's `isRoundLimitReached` guard still satisfy WF006. The structural container-routing rules (`validate.ts:517-535`) are untouched. Manifest stays clean under `--strict`.

### 10.6 Control check (verify the lint actually exercises the gates)

As a control (per the multi-round slice's lint-by-control discipline), the implementer should confirm: temporarily renaming `final_review.present: [final_report]` to a non-produced name makes WF004 fire; restoring it clears it. Temporarily pointing a gate's `ABORT` edge at a non-existent terminal makes validation fail. This proves the clean result is real, not a lint that skips gates.

---

## 11. Prompts / skills deltas

Per CLAUDE.md "Authoring workflow skills" — **control flow lives in the FSM, domain content in skills**. This slice is almost entirely control-flow (gates/edges/terminal), so the prompt deltas are minimal and additive; no new skill is required.

### 11.1 `preflight` prompt delta

Add an artifact-surfacing step (so `preflight_review` can present the spec) and a FORCE_REVISION-feedback step:

- **Copy the authored spec into the artifact dir** so `preflight_review.present` resolves and the post-agent artifact check passes (§6.2/§6.3):
  > After writing `run_spec.yaml` and `cognition_seed.md` under `.evolve_runs/main/`, also copy them so the human reviewer can see them: `mkdir -p /workspace/.workflow/run_spec /workspace/.workflow/cognition_seed` and copy `run_spec.yaml` → `/workspace/.workflow/run_spec/run_spec.md` and `cognition_seed.md` → `/workspace/.workflow/cognition_seed/cognition_seed.md`.
- **Honor human FORCE_REVISION feedback** (the `context.humanPrompt` is injected as a scoping preamble — §5.1):
  > If a human directive is present at the top of this message, treat it as authoritative: adjust the objective, evaluator command, budget, or cognition seed exactly as directed before re-emitting `ready`.
- Add `outputs: [run_spec, cognition_seed]` to the state (§6.2). No change to the existing `verdict: ready|blocked` contract.

### 11.2 `orchestrator` prompt delta (only for the `final_review` run-more-rounds path)

The orchestrator's verdict vocabulary is **unchanged** (`design`/`evaluate`/`analyze`/`record`/`complete`/`escalate`). The only addition handles the §8.3 budget-extension case:

> If a human directive in this message requests additional rounds (e.g. "run 2 more rounds"), treat the effective budget as `done_rounds + K` for this turn: emit `design` to start another round instead of `complete`. You do not rewrite `run_spec.yaml`; the extra rounds append new nodes to `nodes.json` exactly like normal rounds. Once `done_rounds` reaches the extended target, emit `complete` again.

This is the §8.3 path (option 1), and it is the one the slice ships: §13 "Resolved" confirms no engine helper enforces `budget.max_rounds`, so the spec-rewrite path (option 2) is unnecessary — the orchestrator does not need to rewrite `budget.max_rounds`.

No change to the `escalate` definition: the orchestrator already emits `escalate` "only if the run is unrecoverable"; that verdict now routes to `human_escalation` instead of `failed`, but the _agent's_ decision criterion is identical.

### 11.3 `final_summary` prompt (new) and `analyzer`/`researcher` (unchanged)

`final_summary`'s prompt is given verbatim in §4.3. It is pure domain-free reporting (read durable state, write Markdown) — no skill needed. `analyzer`, `researcher`, `sample`, `evaluate`, `analysis_record` are untouched.

### 11.4 No skill changes

No SKILL.md changes. The gates encode _ordering_ (approve-before-loop, escalate-to-human, summarize-before-final-review), which is FSM territory by the CLAUDE.md rule — none of it belongs in a skill. The `final_summary` report structure is content but is small and run-specific enough to live in the state prompt rather than a reusable skill.

---

## 12. Binary completion gate (REQUIRED — front and center)

The slice is done when all three checkable conditions below hold. This mirrors the multi-round slice's §12 structure: a gated real-Docker test, a clean `--strict` lint, and a live run + inspect.

### 12.1 (a) Real-Docker integration test — extend the multi-round gate

A new test (or new `describe` blocks added to `test/workflow/evolve-multi-round.integration.test.ts`), gated `describe.skipIf(!dockerReady)` with the **same** `dockerReady` guard as the multi-round gate. It reuses that test's `TEST_HOME`/CA staging, `buildDockerSessionConfig`, `createInfra`/`destroyInfra`, `createDeps`, `onEvent` state collection, and the prompt-substring mock-routing of the four agent roles (multi-round §12.2). The new machinery is the **gate-driving helpers** (`test-helpers.ts:392-441`): `waitForGate(raiseGateMock, count, timeout)` (collects the raised `HumanGateRequest[]`), `waitForGateOrCompletion(orchestrator, workflowId, timeout)` (`'gate' | 'done'`), and `orchestrator.resolveGate(workflowId, { type, prompt? })` to inject the human event. `createDeps` must wire `raiseGate` to a `vi.fn()` so `waitForGate` can observe it.

The mock orchestrator verdict script is the multi-round `[design, evaluate, analyze, record] × N` then `complete`, with the _gates_ interleaved by the orchestrator pausing at `waiting_human` — the test drives those pauses with `resolveGate`. Four scenarios:

**Required mock-router change — the `final_summary` branch (load-bearing).** The multi-round test's mock prompt router (`evolve-multi-round.integration.test.ts:313-336`) routes by prompt-substring and `throw`s on any unrecognized prompt (the `throw new Error(\`unexpected agent prompt: …\`)` at ~`:335`). The new `final_summary` agent state introduces a prompt that none of the existing four branches (`preflight`/`orchestrator`/`researcher`/`analyzer`) match, so **without a new branch it would hit that throw and fail Scenarios A and D before they can reach `final_review`.** The harness MUST add a fifth routing branch that matches `final_summary`'s prompt (e.g. `if (msg.includes('produce a concise, human-readable report'))` or another unique substring of the §4.3 prompt) and, critically, **materializes the report artifact** the same way the other branches materialize their files:

- The branch MUST write a **non-empty** report file into `<workspace>/.workflow/final_report/final_report.md` (creating `<workspace>/.workflow/final_report/` first). This is mandatory, not cosmetic: `final_summary` declares `outputs: [final_report]`, so after it runs the orchestrator calls `findMissingArtifacts(stateConfig, instance.artifactDir)` (`orchestrator.ts:2249-2265`); if `<workspace>/.workflow/final_report/` is empty, the agent is re-prompted and then the **run errors** — Scenarios A and D would fail in the engine, not at an assertion. Writing the file is what makes both the production check pass and the §12.1 Scenario A assertion on `presentedArtifacts.final_report` (and the on-disk `existsSync(... /final_report.md)` non-empty check) hold.
- The mock content should be non-empty and mention the best score (a real `final_summary` summarizes the best node), so Scenario A's "content … mentions the best score" assertion is satisfiable. A helper like `writeFinalReport(workspacePath, bestScore)` mirrors the existing `writeCandidate` / `writeAnalysis` helpers.
- Because Scenario D runs the loop twice (one forced extra round), the `final_summary` branch fires **twice**; the helper should overwrite the report each time, so the final on-disk report reflects N+1 rounds.

#### Scenario A — preflight_review APPROVE → done via final_summary/final_review (happy path)

1. `orchestrator.start(<evolve manifest>, <improving task>, workspaceDir)`.
2. `await waitForGateOrCompletion(...)` returns `'gate'`; `const [g1] = await waitForGate(raiseGate, 1)`; assert `g1.stateName === 'preflight_review'`, `g1.acceptedEvents` deep-equals `['APPROVE','FORCE_REVISION','ABORT']`, and `g1.presentedArtifacts` has keys `run_spec`, `cognition_seed`.
3. `orchestrator.resolveGate(workflowId, { type: 'APPROVE' })`. The hub runs the N-round loop (multi-round mock), then the orchestrator emits `complete` → `final_summary` (writes the report) → `final_review` gate.
4. `await waitForGate(raiseGate, 2)`; assert the 2nd gate's `stateName === 'final_review'` and `presentedArtifacts` has key `final_report`.
5. `orchestrator.resolveGate(workflowId, { type: 'APPROVE' })`; `await waitForCompletion(...)`.
6. **Assertions:** `getStatus(workflowId).phase === 'completed'`; the collected `states` ends at `'done'` and contains `'preflight_review'`, `'final_summary'`, `'final_review'` in that order; `excludes('failed')` and `excludes('aborted')`. The report exists and is non-empty: `existsSync(<workspace>/.workflow/final_report/final_report.md)` and its content is non-empty and mentions the best score. Engine invariants from the multi-round gate still hold (`nodes.json` has exactly N nodes; parent linkage intact).

#### Scenario B — preflight_review ABORT → aborted (no evaluator ran)

1. `start`, `waitForGate(raiseGate, 1)` → `preflight_review`.
2. `orchestrator.resolveGate(workflowId, { type: 'ABORT' })`; `await waitForCompletion(...)`.
3. **Assertions:** `getStatus(workflowId).phase === 'aborted'`; `states.at(-1) === 'aborted'`; `states` does **not** contain `'orchestrator'`, `'sample'`, `'evaluate'`, or `'done'` (the loop never ran). `existsSync(<workspace>/.evolve_runs/main/database_data/nodes.json) === false` (zero nodes — no evaluator executed). This proves the gate blocks the first evaluator (§9).

#### Scenario C — evaluator-blocked round → human_escalation, FORCE_REVISION → preflight → proceeds

1. `start`, APPROVE the `preflight_review` gate (as Scenario A step 3).
2. The mock makes **round 1's** `researcher` write a candidate with **no `solve` symbol** (the multi-round "crash" kind), so `evaluate` emits `evaluator_blocked`. The new edge routes to `human_escalation` (not `failed`).
3. `await waitForGate(...)` for the `human_escalation` gate; assert `stateName === 'human_escalation'`, `acceptedEvents` includes `FORCE_REVISION`, and the gate `summary` contains the eval-block error (the `context.lastError` suffix, §5.2).
4. `orchestrator.resolveGate(workflowId, { type: 'FORCE_REVISION', prompt: 'fix the candidate to define solve(xs)' })`. This routes to `preflight` (which re-confirms `ready`), then `preflight_review` again. The test must APPROVE this second `preflight_review`, and from there the mock's `researcher` now writes a **valid** improving candidate, so the run proceeds through the full N rounds.
5. `await waitForCompletion(...)`.
6. **Assertions:** terminal reached without a spurious extra node — `nodes.json` holds exactly N nodes (the blocked round did **not** commit a node; `analysis_record` never ran for it). Parent linkage is consistent: `nodes["1"].parent` references `nodes["0"]`'s id, etc. (no orphaned or skipped parent from the forced re-entry). `states` contains `'human_escalation'` and **two** `'preflight_review'` entries (initial + post-FORCE_REVISION). Crucially: **node count and parents are identical to a clean N-round run** — the forced re-entry produced no double-count.

#### Scenario D — final_review FORCE_REVISION → one extra round → APPROVE → done

1. `start`, APPROVE `preflight_review`, let the N-round loop complete, reach the `final_review` gate (Scenario A steps 1–4).
2. `orchestrator.resolveGate(workflowId, { type: 'FORCE_REVISION', prompt: 'run 1 more round' })`. The mock orchestrator (reading `context.humanPrompt`, §8.3 option 1) emits `design` for **one** extra round (`[design, evaluate, analyze, record]`), then `complete` → `final_summary` → `final_review` again.
3. `await waitForGate(...)` for the **second** `final_review`; `orchestrator.resolveGate(workflowId, { type: 'APPROVE' })`; `await waitForCompletion(...)`.
4. **Assertions:** `phase === 'completed'`, `states.at(-1) === 'done'`. `nodes.json` holds **exactly N+1** nodes (the one extra round committed exactly one new node — no double-count, §8.3). Scores are monotone non-decreasing across all N+1 nodes; `nodes["N"].parent` references a prior node id (the extra round sampled a real parent from the now-larger DB). `final_summary` ran **twice** (once per `complete`); the final `final_report.md` reflects N+1 rounds. This proves the forced extra round increments `done_rounds` by exactly one and the "recompute from `nodes.json`" property terminates the loop cleanly at the extended budget.

**Cross-scenario assertions (consistency):** in C and D, assert `next_id` in `nodes.json` equals `Object.keys(nodes).length` (no allocated-but-unrecorded ids), and every `nodes[k].parent` (k>0) is a non-empty array referencing an existing prior id — proving neither forced loop corrupted lineage. The `next_id === Object.keys(nodes).length` identity is exact because the engine allocates ids monotonically and never skips: `node.id = self.next_id; self.next_id += 1` on each record (`evolve-engine/.../database.py:73-74`), and `analysis_record` is the single record per round — so after K committed rounds `next_id == K == |nodes|`.

#### Two SHIPPED integration tests break and MUST be updated (the `evaluator_blocked` reroute)

The `evaluate ─evaluator_blocked → human_escalation` retarget (§1, §4.2) changes a previously-terminal outcome, so it **breaks two shipped, Docker-gated integration tests that both load `src/workflow/workflows/evolve/workflow.yaml`**. Both currently assert the run lands on the `failed` terminal with `result.json.verdict === 'evaluator_blocked'`. After the slice, that crash routes to the `human_escalation` gate (the run pauses at `phase: 'waiting_human'`), so the old terminal assertion can never fire. Both tests must be updated to drive the gate to a terminal:

- **`test/workflow/evolve-multi-round.integration.test.ts`** — the `it('routes a mid-loop evaluator crash to failed without a partial second node', …)` case (~`:423-435`). Currently asserts `states.at(-1) === 'failed'`, `countStates(states,'evaluate') === 2`, `Object.keys(nodes.nodes) === ['0']`, and `result.json.verdict === 'evaluator_blocked'`.
- **`test/workflow/evolve-single-round.integration.test.ts`** — the `it('routes evaluator crashes to failed without recording a node', …)` case (~`:332-347`). Currently asserts `states.at(-1) === 'failed'`, `states` contains `'evaluate'`, excludes `'analysis_record'`, and `result.json.verdict === 'evaluator_blocked'`.

**New expectation for both** (concrete, checkable). Because the run now pauses at the gate, each test must instantiate the orchestrator with a `raiseGate` `vi.fn()` (so `waitForGate` can observe it — §12.1) and drive the raised gate to a terminal rather than asserting `failed`:

1. Rename the test (e.g. `'routes a mid-loop evaluator crash to human_escalation'`). Both `evaluator_blocked` cases require the `preflight_review` gate to be APPROVEd first (the loop is now gated), so APPROVE the initial `preflight_review` (as Scenario A step 3) before the crash round.
2. Run until the crash round, then `const [g] = await waitForGate(raiseGate, 1)` (for the single-round test; in the multi-round test it is the gate after the initial `preflight_review` APPROVE). Assert the raised gate is `human_escalation`: `g.stateName === 'human_escalation'`, `g.acceptedEvents` contains `'FORCE_REVISION'` and `'ABORT'`, and `g.summary` contains the eval-block error (the `context.lastError` suffix, §5.2). Assert the run did **not** reach `failed`: `states` does not (yet) contain `'failed'`.
3. Drive the gate to a terminal. The minimal update is **ABORT**: `orchestrator.resolveGate(workflowId, { type: 'ABORT' })`, then `await waitForCompletion(...)` and assert `getStatus(workflowId).phase === 'aborted'`, `states.at(-1) === 'aborted'`, and the no-record invariant still holds (the blocked round committed no node: for single-round, `nodes.json` is absent or `Object.keys(nodes.nodes) === []`; for multi-round, `Object.keys(nodes.nodes) === ['0']` — the one good prior round, no partial second node). This preserves each test's original "no spurious node from a blocked round" assertion while replacing the terminal expectation.
4. (Optional richer coverage — equivalent to Scenario C.) Instead of ABORT, `resolveGate(workflowId, { type: 'FORCE_REVISION', prompt: 'fix the candidate to define solve(xs)' })` to route back through `preflight → preflight_review` (APPROVE the second `preflight_review`) and let the now-valid mock candidate carry the run to `done`; assert no double-count. If Scenario C already covers this in the multi-round file, these two converted tests need only the ABORT path (step 3) to stay green.

Net: both renamed tests assert **`human_escalation` is raised** (not `failed`), then **ABORT → terminal `aborted`** (and/or FORCE_REVISION → the recovery path), and retain their node-count no-double-record assertions. The wedge backstop and `result_file_error` paths are untouched, so no other shipped test changes.

### 12.2 (b) Lint clean

```
tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict
# expect: "No lint diagnostics"
```

No WF001/WF004/WF006 and no `validateHumanGate`/`resetVisitCounts` validation errors (§10). Include the §10.6 control checks in the unit test layer to prove the lint actually exercises the gates.

### 12.3 (c) Live run + inspect

```
tsx src/cli.ts workflow start evolve "evolve solve(xs) toward solve([1,2,3])==6 over 3 rounds"
# at each gate the CLI promptGateInteractive shows the summary + presented artifacts (a/f/r/x):
#   - preflight_review: shows run_spec + cognition_seed → approve (a)
#   - final_review: shows final_report → approve (a)
tsx src/cli.ts workflow inspect <baseDir>
# expect: Final: completed, terminal state `done`, final_report present, 3 nodes.
# Also run once choosing abort (x) at preflight_review → inspect shows Final: aborted.
```

The live run confirms the gates **surface** (the CLI renders the summary + presented artifacts), that approval flows reach `done` through `final_summary`/`final_review`, and that an abort yields `Final: aborted` (distinct from `completed`).

### 12.4 Why this gate proves the human surface works end-to-end

- **Scenario A** ⇒ the approve-path topology (`preflight_review → orchestrator → … → final_summary → final_review → done`) is wired and `final_summary` produces a real report the gate surfaces.
- **Scenario B** ⇒ `preflight_review` genuinely blocks the first evaluator (the §9 requirement) and routes to the distinct `aborted` terminal.
- **Scenario C** ⇒ an evaluator-blocked round becomes human-mediated (not an opaque `failed`), FORCE_REVISION re-enters cleanly, and the forced re-entry does not corrupt node count/lineage.
- **Scenario D** ⇒ `final_review` can drive _additional real rounds_ without double-counting against the durable `done_rounds` recompute — the subtle §8.3 property holds end-to-end.
- No single scenario proves the surface alone: A proves the happy path, B the approval-block + aborted terminal, C the escalation + repair loop, D the run-more-rounds loop. Together they exercise all three gates, both FORCE_REVISION destinations, the `aborted` terminal, and the no-double-count invariant.

---

## 13. Risks / open questions / maintainer decisions

### Maintainer decisions — RESOLVED (signed off 2026-06-16)

All three decisions below are signed off by the maintainer; each took the recommended default. The rationale/tradeoffs are retained as the decision record. The doc body and embedded YAML already reflect these choices, so the slice is ready to implement.

1. **`final_summary` as a pure agent state vs a deterministic helper (§6.4).** Both are buildable; this is a genuine cost/scope preference. _Recommended default: **agent state**_ (one YAML + one test, parent-design-faithful, no new `evolve_result.py` subcommand). **Tradeoff:** the agent version costs an LLM call per completion and produces a narrative report; a `deterministic`/`container` state running a templated `evolve_result.py final_summary` subcommand is cheaper and fully reproducible (testable without a model) but adds a bridge subcommand (mild scope creep against "single-file workflow scope") and yields a less useful report. **DECIDED (2026-06-16): agent state** — as assumed by the §4.3 / §6 embedded YAML.
2. **`human_escalation → preflight` on objective change (§8.2).** Re-authoring `run_spec.yaml` does **not** clear `nodes.json`, so a FORCE*REVISION that *changes the objective* leaves stale nodes counting toward `max_rounds` and being sampled as parents. **No safe engine "reset DB" operation was found** — re-authoring the spec does not clear the database, so stale nodes would corrupt both the round count and parent sampling. \_Recommended conservative contract: **"FORCE_REVISION preserves node validity; an objective change ⇒ ABORT and start a fresh run."*** State this in the gate description and the preflight prompt. **Tradeoff:** the conservative contract is safe but means an operator who wants to keep the run alive across an objective pivot must abort and restart (losing the pause-resume convenience); the alternative — adding an engine DB-reset path on objective change — is real scope creep and needs its own design. **DECIDED (2026-06-16): adopt the conservative contract** — FORCE_REVISION preserves node validity; an objective change ⇒ ABORT and start a fresh run. No engine DB-reset path is added in this slice; state the contract in the `human_escalation` gate description and the `preflight` prompt.
3. **`evaluator_blocked` routing — reroute to `human_escalation` vs keep hard-`failed` (§1, §4.2, §12).** This is the one **intentional behavior change** in the slice: it converts a previously-terminal `→ failed` outcome into a human-mediated gate, on the rationale that a single bad/crashed candidate should not hard-fail a multi-round search (a human decides retry / revise / abort). _Recommended default: **reroute** to `human_escalation`._ **Tradeoff:** rerouting makes a blocked candidate recoverable (and is the parent design's intent for evaluator-judgment stops) but is a UX change that **breaks two shipped integration tests** (§12) and changes operator-visible behavior; keeping hard-`failed` is the status-quo-preserving choice that needs no test churn but loses the recovery path the parent design wanted. (Note: this only moves the `evaluator_blocked` edge; `result_file_error`, sampler/engine crash, `needs_repair`, and the wedge backstop still hard-fail to `failed` — §4.2.) **DECIDED (2026-06-16): reroute to `human_escalation`** — the two shipped integration tests are updated per §12.

### Lower-stakes decisions (recommended defaults — implementer may proceed unless a maintainer objects)

These are settled enough to implement on the recommended default; listed for visibility, not blocking sign-off.

- **Artifact-dir copy for gate `present:` (§6.2, §6.3, §11.1).** Gate-presented artifacts are read from `<workspace>/.workflow/<name>/`, not `.evolve_runs/main/`, so `preflight`/`final_summary` must copy their files there (a few `mkdir -p`+`cp` lines). _Recommended: do the copy_ so the gates are actually informative. Alternative: descope `preflight_review.present` to empty and rely on `workflow inspect`.
- **`resetVisitCounts` on the `preflight_review` FORCE_REVISION edge (§4.1, §8.4).** Pre-loop there are no accumulated orchestrator visits, so the reset is harmless but possibly unnecessary; included for symmetry. _Recommended: keep for symmetry._
- **`human_escalation.present` is limited to `run_spec` (§4.5, §10.2).** `nodes.json`/`current/result.json` are written by _deterministic_ states and cannot appear in `present:` without tripping WF004. _Recommended: ship `present: [run_spec]`; the human inspects nodes/result via `workflow inspect`._ Alternative: add a thin agent producer that re-emits `nodes` into the artifact dir solely to satisfy WF004 (a lint-satisfying copy).

### Resolved (previously open; ground-truth verified in this revision)

- **RESOLVED — §8.3 budget extension for `final_review` FORCE_REVISION (was open question #6).** **No engine helper enforces `budget.max_rounds` as a stopping condition** — the orchestrator is the only component that compares `done_rounds` to `max_rounds`. Verified: `require_evolve_ready` checks only missing-fields + `approval.confirmed` (`run_state.py:288-297`); `done_rounds = _node_count(run_dir)` with no cap, allocating `step_{done_rounds+1:04d}` (`evolve_result.py:276-277`); `next_id` is a monotonic DB counter (`database.py:73-74`). So **option 1 (orchestrator emits `design` past `max_rounds`, consuming `context.humanPrompt`, no spec rewrite) is confirmed viable; option 2 (run_spec rewrite) is unnecessary.** The slice ships option 1; Scenario D is the proof.

### Still-open verification (low risk — confirm during implementation)

- **Resume → gate re-surfacing (§8.1).** The doc asserts `workflow resume` re-surfaces the same `HumanGateRequest` for a still-pending gate. Verified: the gate is a durable `waiting_human` pause and `resume` re-enters the run; **not** traced whether resume re-raises the gate request or expects the caller to re-query `getPendingGate`. Likely fine (`vuln-discovery` resumes across gates), but confirm rather than assume. This is an implementation-time check, not a maintainer decision.

### Risks

- **Gate-timing flakiness in the §12 test.** The multi-round slice deferred gates partly to avoid adding gate-timing flake to its gate. This slice's test inherently drives gates via `waitForGate`/`resolveGate` polling; allocate generous timeouts (the helpers default to 5s; real-Docker runs need the multi-round gate's ~30s+ timeouts) and assert on the collected `HumanGateRequest[]` rather than racing the state stream.
- **WF004 surprise.** The "deterministic-state outputs are not lint producers" rule (§4.5) is easy to miss and will block a naive `human_escalation.present: [nodes]`. The doc fixes the shipped `present:` lists to agent-produced names only; the implementer must not widen them without adding a real agent producer.
- **Artifact-dir path mismatch.** The single most likely implementation bug is `final_summary`/`preflight` writing the report/spec only under `.evolve_runs/main/` and not into `.workflow/<name>/`, causing the post-agent `findMissingArtifacts` check to fail (run errors) or the gate `presentedArtifacts` to be empty (gate shows "none"). §6.2 and §11.1 call this out explicitly; the §12 assertions on `presentedArtifacts` keys catch it.

### Invariants preserved (not at risk)

- **Determinism** (multi-round §9) and the **vendored-engine byte-verbatim** invariant are untouched — this slice adds no engine code and no determinism-affecting path; it is FSM/gate surface only.
- **The orchestrator hub** is not re-architected — only two of its declared edge _targets_ move (`escalate → human_escalation`, `complete → final_summary`); its verdict vocabulary and `done_rounds`-from-`nodes.json` logic are unchanged.
- **The multi-round FSM is preserved as a graph superset, with three intentional edge retargets** (`escalate`/`evaluator_blocked` → `human_escalation`, `complete` → `final_summary`). Every shipped state and edge is otherwise preserved. This is **not** a strict superset: the `evaluator_blocked → human_escalation` retarget deliberately changes a previously-terminal `→ failed` outcome into a human-mediated gate (rationale: §1, §4.2). That change is the one breaking-by-design item in this slice — it requires updating two shipped integration tests (§12) and a maintainer sign-off (§13 decision 3). Genuine mechanical/infrastructure errors and the wedge backstop still route to `failed` unchanged.
