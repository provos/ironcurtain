# Review: `asi-evolve-native-workflow.md`

**Date:** 2026-06-15
**Scope:** Ground-truth review of `docs/designs/asi-evolve-native-workflow.md` against (a) the
IronCurtain FSM workflow runtime (`src/workflow/`, `WORKFLOWS.md`, the real
`vuln-discovery` workflow) and (b) the standalone ASI-Evolve repo under
`donotcommit/ASI-Evolve/`. Every load-bearing claim was checked against source with
file:line citations.

> The mechanical "must-fix" corrections in §6 have been folded into the design doc.
> The "resolve before coding" items in §6 remain open and are not yet reflected in the doc.

> **Update (2026-06-15):** The design has since been revised to run `evaluate` and
> `record_node` as **deterministic states that `exec` into the shared container**,
> with a structured deterministic result contract and a workflow script/dependency
> packaging convention. That supersedes the "keep the evaluator in an agent state"
> framing in §1 and §6 below and resolves design-soundness concerns #1
> (agent-vs-wrapper tension), #2 (`record_node` atomicity), and #6 (wrapper
> timeout) — at the cost of three new general workflow-runtime capabilities.
> Containment is now explicitly container-level (`--network=none`, workspace
> mount), not ToolCallCoordinator-mediated. The findings below are preserved as the
> point-in-time review that motivated the change.

---

## 1. Bottom line

The design's **central thesis is correct and well-grounded**: keep untrusted candidate
evaluation in an **agent** state (which inherits the container + `ToolCallCoordinator` +
policy-hot-swap boundary) rather than a **deterministic** state (which runs host-side via
`execFileAsync` with no isolation — `orchestrator.ts:2262`), and route via an
orchestrator-emitted verdict hub-and-spoke modeled on the real `vuln-discovery` workflow.
The doc is also **remarkably accurate about ASI-Evolve** — the 11-field Node schema, the
evaluator contract, loop ordering, sampler families, and the cognition/database split all
check out byte-for-byte.

**Verdict: proceed with fixes.** There is one material factual error, a cluster of
authoring-surface mislabels that would mis-author a real `workflow.yaml`, and a set of
v1-scope-honesty problems that should be resolved before anyone codes from this. None
invalidate the approach.

## 2. The one material factual error — the "two-store / bridge" model is wrong (HIGH)

The doc's most consequential mistake: it treats workspace `.workflow/evolve/` and "the
orchestrator's logical artifact directory under the workflow-run metadata" as **two distinct
stores** needing bridge helpers (lines ~410–421, prerequisite #3, migration step 1).

**Reality: there is one store.** `artifactDir = resolve(workspace, WORKFLOW_ARTIFACT_DIR)`
where `WORKFLOW_ARTIFACT_DIR = '.workflow'` (`types.ts:12`; `orchestrator.ts:1168, 1263`).
Logical artifact names in `inputs`/`outputs`/`present` resolve **directly** to
`.workflow/<name>/` subdirs (`orchestrator.ts:2313-2319`). The `FileArtifactManager` with a
separate `{baseDir}/{id}/artifacts/` dir (`artifacts.ts:230-232`) is **not used** by the
live orchestrator. The whole "bridge" section solves a separation that doesn't exist.

Correct reframing: a top-level `.workflow/evolve/` subtree **becomes** a logical artifact
(with `.vN` versioning + UI) only when declared as a top-level state output. Deeply nested
paths like `.workflow/evolve/database/index/` are unmanaged agent-written workspace files.
This also corrects the `unversionedArtifacts` granularity claim — it suppresses snapshotting
of declared **top-level** output names only (`artifacts.ts:103-114`; `orchestrator.ts:1789`),
not per-nested-path.

## 3. Authoring-surface mislabels (would break a YAML implementer)

- **Human-gate event names are internal-only (MEDIUM).** The mermaid and prose use
  `HUMAN_APPROVE` / `HUMAN_FORCE_REVISION` / `HUMAN_ABORT`. Those are _synthesized_ XState
  event names (`machine-builder.ts:301`: `` `HUMAN_${t.event}` ``). A workflow author writes
  `event: APPROVE | FORCE_REVISION | REPLAN | ABORT` in YAML (`types.ts:339`; vuln-discovery
  `workflow.yaml:299-313`). Copying the doc's labels produces a validation error
  (`validate.ts:477-481`).
- **`persona`/`containerScope` are per-state fields, not settings (MEDIUM).** `persona` is
  per-state; `containerScope` is a per-agent-state field meaningful only under
  `sharedContainer` (declaring it with `sharedContainer:false` is a validation error —
  `types.ts:211-214`). The evaluator-persona proposal is sound but should reference per-state
  fields.
- **`maxVisits` wiring is unstated (LOW trap).** `researcher.maxVisits`/`analyzer.maxVisits`
  only fire via an `isStateVisitLimitReached` guard transition **ordered before** the verdict
  transition (how vuln-discovery wires it — `guards.ts:21-26`). Also: deterministic states
  can only use `guard`, not `when`, and the only stdout mining is a single test-count regex.
- **Verdict-injection is over-generalized (LOW).** L75-77 implies all agent states get
  injected/validated verdicts. Only states whose transitions are _all_ conditional get this;
  a single bare `to: orchestrator` edge makes `getValidVerdicts` return `undefined`
  (`status-parser.ts:289-297`), so bare-return specialists get no verdict validation.

## 4. Design-soundness / v1-honesty concerns (resolve before coding)

1. **v1 depends on the very "future" gaps it defers (MEDIUM).** The doc files the artifact
   bridge and transaction helpers as gaps needed "only if we later move execution out of
   agent states" (lines 99-103), yet v1 _requires_ the bridge for any UI claim and _requires_
   the transaction protocol for `record_node` (lines 308-310, 453-456). The agent loop is
   buildable today; the durability/UI guarantees attached to v1 are not, without the helper
   code the doc itself calls "a new engine project, not just workflow YAML" (lines 608-610).
   Either descope these from v1 or admit v1 needs the engine work.
2. **`record_node` atomicity is unachievable as an agent state (MEDIUM).** It's declared an
   agent state (host sees only artifacts + a verdict), yet the doc demands multi-phase atomic
   commit with resume rollback. An LLM driving CLI wrappers can't guarantee atomicity across a
   crash _between_ wrapper calls — the exact failure cited. The only fix is the deferred
   contained-deterministic-helper path. Unacknowledged.
3. **No machine-enforced terminal-safety on the orchestrator (MEDIUM).** The proposed
   orchestrator has only `when`-verdict edges and relies on the agent emitting `complete`. A
   wedged orchestrator that never emits a routing verdict has no machine path to a terminal
   except human escalation. Lint **WF006** (`checkMaxRoundsHasGuard`, `lint.ts:95-108`) warns
   if `settings.maxRounds` is set without an `isRoundLimitReached` transition. Pair the round
   budget with a guard edge to a terminal.
4. **The bespoke 2PC transaction protocol is over-built and partly unenforceable (MEDIUM).**
   For a single-file, single-worker v1 (parallelism is an explicit non-goal), it duplicates
   IC's checkpoint-after-every-transition + `snapshotArtifacts` machinery — and the "helpers
   reject unexpected agent edits to `nodes.json`/candidate/evaluation" guarantee is
   **unenforceable** in shared-container mode where every agent has full workspace write
   access (`WORKFLOWS.md:60-65`). The doc's own risk note (791-792) admits this. Lean on IC
   checkpoints + a minimal idempotency key; drop the 2PC.
5. **`human_escalation → preflight` edge committed before its semantics are decided (MEDIUM).**
   Re-entering preflight rewrites `run_spec.yaml` and resets `approval.confirmed=false`, so
   evaluator command/scoring can change under an already-populated database — and the
   transaction protocol's input-hash checks would then invalidate previously-committed nodes.
   This is exactly Open Question #10 (marked "Canonical? no"). The FSM commits to the edge
   before deciding its meaning.
6. **Reused `evolve-eval` wrapper contradicts the doc's own timeout requirement (MEDIUM).**
   The doc says "reuse the Python `skills/evolve` wrappers" _and_ "enforce a process-tree/cgroup
   timeout." But `evolve_core/cli.py:291` does `subprocess.run(formatted, shell=True, timeout=...)`
   with no `setsid`/`preexec_fn`/`killpg` — `TimeoutExpired` kills only the direct child; a
   forking evaluator leaks grandchildren. Either patch the wrapper (not pure reuse) or move the
   requirement to the native path.
7. **Reusing the ordered evolve `SKILL.md` violates the project skill-authoring rule (MEDIUM).**
   `skills/evolve/SKILL.md` is an ordered, agent-operated round protocol. CLAUDE.md's
   "Authoring workflow skills" rule says strip ordering scaffolding and make a skill loadable by
   multiple states without contradiction. Reusing it as-is while splitting the loop across
   orchestrator + specialists smuggles sequencing into skill territory.
8. **Two "Open Questions" marked non-canonical are real blockers.** "TS-native vs
   Python-helper vs hybrid" (796-797) determines whether the reuse strategy is viable and
   whether Python + FAISS + sentence-transformers ship in the agent Docker image — the entire
   v1 hinges on it and the doc never confirms the image has that environment. "sharedContainer
   vs fresh disposable container per eval step" (798-800) is security-critical for repeatedly
   running untrusted code. Both gate v1.

## 5. The `eval()` security claim — real, but the rationale is overstated

The doc's description of the **standalone** sampler is precisely accurate:
`database/algorithms/island.py:569` restores MAP-Elites feature-map keys with
`{eval(k): v for ...}` from on-disk `sampler_state` — a genuine untrusted-deserialization
code-execution sink, and the only `eval(` in the `database/` tree.

**But the doc uses it as load-bearing _open_ v1 work, and that's wrong: the v1 reuse target
already fixed it.** `skills/evolve/scripts/evolve_core/algorithms/island.py:142` uses
`ast.literal_eval`. Better still, the standalone DB already calls `rebuild_from_nodes` after
`load_state`, so a native re-impl could **avoid persisting/parsing feature maps entirely**
rather than relying on any `eval` variant. Reframe: verify the vendored fix; prefer
rebuild-from-nodes.

## 6. What the doc gets right (preserve these)

- **The load-bearing runtime call is correct.** Deterministic states run host-side via
  `execFileAsync` with no container/timeout/coordinator (`orchestrator.ts:2253-2278`); keeping
  the evaluator in an agent state genuinely achieves policy containment.
- **Faithful FSM mechanics** — the `agent_status` block → host parse+validate+retry → XState
  first-match-`when` routing is described with no invented mechanism; the deterministic
  contract (`passed`/`testCount`/`errors`, guard-routed) is exact; real field names reused.
- **Correct IC checkpoint model** — checkpoints snapshot FSM/control state (`machineState` +
  `context` + `transitionHistory`), _not_ workspace file contents (`types.ts:532-558`);
  completed runs retain `checkpoint.json`; `workflow resume --state <name>` works.
- **Byte-accurate ASI-Evolve model** — Node schema (`utils/structures.py`, not `database.py`),
  Engineer contract (`code` file, `bash <eval_script>` + timeout, results.json→txt fallback,
  hard `eval_score` assert, optional weighted judge blend), loop ordering,
  `BestSnapshotManager` is real, cognition/database split, four samplers, and the local
  embedding stack (sentence-transformers all-MiniLM-L6-v2 + FAISS IndexFlatIP — correctly
  **not** claimed to be OpenAI).
- **Honest in the right places** — flags that "monitored through the workflow UI" shouldn't
  be claimed without the bridge, that island should be optional, and that the lexical fallback
  is a _different_ retrieval policy (FAISS/embeddings hard-fail on missing imports today —
  verified, no fallback exists).

## 7. Prioritized fix list

**Must-fix doc inaccuracies (mechanical) — APPLIED to the design doc:**

1. Replace the two-store/bridge framing with single-store reality
   (`artifactDir = resolve(workspace, '.workflow')`); nested subtrees are unmanaged until
   declared top-level artifact outputs.
2. Change all human-gate labels to YAML `event:` form (`APPROVE`/`FORCE_REVISION`/`REPLAN`/`ABORT`);
   note `HUMAN_*` is internal.
3. Move `persona`/`containerScope` from "settings" to "per-state fields"; correct the
   `unversionedArtifacts` granularity claim.
4. Note the `eval()` fix already exists in the reused `evolve_core`; reframe toward
   rebuild-from-nodes.
5. Qualify the vuln-discovery comparison (preflight is net-new; vuln-discovery has
   non-returning spoke chains); fix the verdict-injection over-generalization.

**Must-resolve before coding (still open):** 6. Engine language/dependency decision + confirm the workflow Docker image ships Python +
`evolve_core` + FAISS + sentence-transformers. 7. Descope or own the durability claims: drop the 2PC + `record_node` atomicity (lean on
checkpoints + idempotency key), or move `record_node` onto a contained deterministic helper
and admit v1 needs that engine work. 8. Add an `isRoundLimitReached` / `maxVisits` guard edge to a terminal on the orchestrator
(satisfies WF006); spec the `maxVisits` guard-ordering requirement. 9. Resolve evaluator-change routing (preflight re-entry vs patch-in-place) before committing
the `human_escalation → preflight` edge. 10. Decide `sharedContainer` vs disposable-per-eval-step for repeatedly running untrusted
candidate code. 11. Reconcile wrapper reuse with the process-tree/cgroup timeout requirement
(`evolve_core/cli.py:291` only kills the direct child).

**Nice to have:** de-sequence the reused `SKILL.md`; note the visit_count nuance (UCB1 reads
it; island only increments) and the judge/eval_score scale mismatch; spell out the
deterministic-state guard-only/exit-code limitation.
