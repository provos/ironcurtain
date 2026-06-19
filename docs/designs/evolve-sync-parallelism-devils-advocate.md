# Devil's Advocate Review — Evolve Sync (Barrier-Batched) Parallelism Slice

Adversarial review of `docs/designs/evolve-sync-parallelism-slice.md`. Scope: find what is
wrong, over-claimed, infeasible, or under-specified. Every finding is grounded in the actual
tree (`file:line`) as of 2026-06-18, master. Citations in the design doc were independently
re-verified; drifted/incorrect ones are themselves findings.

---

## Lead finding (the one that matters most)

**The coordinator FIFO mutex serializes every agent tool call across all N lanes, and the
*only* per-lane work that hits the coordinator is the agent tool calls — so the parallelism
this slice buys is much narrower than §1/§3 imply, and the doc never quantifies it.**

Grounded chain:

1. `handleToolCall` / `handleStructuredToolCall` run their *entire* body inside
   `this.callMutex.withLock(...)` — `tool-call-coordinator.ts:310-313` and `:348-357`. The
   mutex is fair FIFO and non-reentrant (`async-mutex.ts:13`, `:15`). The doc states this
   correctly (§5.1).
2. The mutex serializes the *whole pipeline*, including policy eval, audit append, **and the
   escalation await** (`handleCallTool` awaits `deps.onEscalation(...)` at
   `tool-call-pipeline.ts:866`, or `waitForEscalationDecision(...)` at `:881`, and
   `autoApprove(...)` at `:821` — all inside the held lock).
3. Therefore N "concurrent" agent lanes do **not** run their tool calls concurrently. Every
   `researcher`/`analyzer` tool call queues behind every other lane's tool call. The agents
   *think* (LLM generation) in parallel, but every filesystem/MCP touch is single-file.

The doc frames the mutex as pure de-risking ("the coordinator was built for concurrent
callers; the mutex is not new work", §5.1). That is true for *correctness* (no torn audit,
correct breaker counts — gate item 4 is achievable). But it is **silent on the throughput
consequence**: the mutex converts N-way tool-call parallelism into N-way *serialized* tool
calls. For a workload where the agent makes many small tool calls (read candidate, write
candidate, read cognition), the serialized critical section can dominate, and the realized
speedup is bounded by `1 / (tool_call_fraction + parallel_fraction/N)` (Amdahl), not by N.

The doc must state this honestly and estimate the tool-call fraction for the evolve
researcher/analyzer agents. Without that number, "N candidates explored concurrently" (§1) is
an unquantified claim. See MUST-FIX-1.

**The mitigating fact the doc *should* lean on but doesn't:** the expensive deterministic
steps — `sample`, `evaluate` (the slow evaluator subprocess), `analysis_record` — do **not**
go through the coordinator at all. They are trusted `bundle.docker.exec` calls
(`orchestrator.ts:2667`), explicitly *not* `ToolCallCoordinator` tool calls
(`src/trusted-process/CLAUDE.md`, "Deterministic container exec"). So the slowest per-lane
work (evaluate) genuinely *does* run concurrently across lanes, and the slow-evaluate
held-mutex stall hypothesized in the task framing **does not occur** — because evaluate never
holds the mutex. This is good news the doc under-sells, and it also means the speedup is
real *for slow-eval domains* but marginal *for fast-eval domains* (see MUST-FIX-1 and
CONSIDER-1).

---

## MUST-FIX

### MUST-FIX-1 — No speedup estimate; parallelism may be a net loss for circle-packing
**Claim:** The doc motivates the entire slice on "N workers per round" (§1) but never produces
a single wall-clock or token estimate, and for the reference domain (circle-packing, fast
uniform eval) the realistic speedup is small while the token cost is N×.
**Evidence:**
- The serialized agent-tool-call critical section (`tool-call-coordinator.ts:310`,
  `:348`) bounds speedup below N (lead finding).
- The barrier is a hard join (`Promise.all`, §6.2) → wall-clock per batch is the **straggler
  lane's** time, not the mean. With LLM-latency variance across lanes, the straggler tax is
  real and grows with N.
- All N lanes share **one** container (`sharedContainer: true`, `workflow.yaml:8`) and N
  concurrent `bundle.docker.exec` into one `containerId` (`orchestrator.ts:2667`) → CPU
  contention on the evaluator subprocess. For circle-packing the evaluator is a short
  scipy/SLSQP optimize (`donotcommit/.../circle_packing_demo/evaluator.py`, per the package
  memory map) — fast and CPU-bound, so N concurrent evals contend for the same cores rather
  than overlapping I/O.
- Token spend is strictly N× (N researcher + N analyzer agent runs per batch) for, at best, a
  sub-N search-throughput gain.
**Why it matters:** The search-quality slice's own framing is that the win for circle-packing
comes from *cognition + multi-parent recombination* (`evolve-search-quality-slice.md:25`,
`:459`), not from raw round throughput. A fast-eval domain gets little from parallel
evaluation and pays full N× tokens. The honest statement is: **sync parallelism is a win for
slow-eval domains (where evaluate dominates and runs concurrently off-mutex), and roughly a
token-for-throughput wash for fast-eval domains like circle-packing.**
**Correction:** Add a §1.x "Expected speedup (honest)" with: (a) the Amdahl bound from the
serialized tool-call fraction, (b) the straggler-tax note, (c) the N× token cost, and (d) an
explicit statement that circle-packing is *not* the domain that benefits — pick a
slow-evaluator domain as the motivating example, or state that the value is validated only on
slow-eval workloads.

### MUST-FIX-2 — Lane parent-diversity is unspecified; greedy lanes sample identical parents
**Claim:** §7 is titled "Lane discipline — distinct working areas, no collision" and §1/§13
call it "lane-distinct sampling", but the body only makes *working dirs* and *step names*
distinct. It never makes the **sampled parents** distinct. With the default greedy sampler,
all N lanes sample the identical parent set → near-duplicate candidates → the parallelism is
largely wasted.
**Evidence:**
- `GreedySampler.sample` is `sorted(nodes, key=score, reverse=True)[:n]`
  (`evolve_core/algorithms/greedy.py:13-17`) — a pure function of current DB state.
- `cmd_db_sample` calls `db.sample(n=n)` (`cli.py:412`); `db.sample` reads under
  `_database_guard` with `refresh=True` (`database.py:53-54`, `:206-215`) but **does not
  mutate**. Two lanes calling `sample` before either records both reload the *same* on-disk
  `nodes.json` and get the *same* top-N.
- No lane records until the barrier-adjacent `analysis_record` step (the doc relies on this
  for step-name stability, §7.2), so the DB is provably unchanged across all N lanes' sample
  calls within a batch.
- The default demo uses `sample_n: 3` greedy (`evolve-search-quality-slice.md:265`), so all N
  lanes get the *same three* parents.
**Why it matters:** The only divergence between lanes is then the researcher LLM's sampling
temperature, not search-space exploration. N lanes exploring from identical parents is closer
to "N samples of one distribution" than "N-wide search frontier" — a weak use of the N×
token spend (compounds MUST-FIX-1).
**Correction:** Either (a) specify a lane-distinct parent-selection discipline (e.g. lane *k*
takes parent rank *k*, or a per-lane sampler seed offset for the stochastic samplers), and
state plainly that **greedy + N lanes is degenerate** so multi-lane runs should require a
stochastic sampler; or (b) explicitly scope this slice to stochastic samplers and add a
validator/lint rule rejecting `workers > 1` with `algorithm: greedy`. Right now §7's title
over-claims "distinct" sampling the design does not deliver.

### MUST-FIX-3 — Agent prompts hardcode `current/`; the pump cannot lane-template them
**Claim:** §4.2 recommends shape (B) precisely to "keep agent prompts first-class in the
manifest", and §6.2 lane-templates the *argv* of deterministic states via
`laneTemplated(stateDef.run, lane)`. But the `researcher` and `analyzer` **agent prompts**
embed literal `current/` paths in free text, which no argv-templating reaches. A lane running
the unmodified prompt reads/writes the *shared* `current/`, defeating lane isolation (§7).
**Evidence:**
- `analyzer` prompt: "Read /workspace/.evolve_runs/main/current/context.json, the
  just-evaluated result at /workspace/.evolve_runs/main/current/result.json … Write a concise
  markdown lesson to: /workspace/.evolve_runs/main/current/analysis.md"
  (`workflow.yaml:457-462`) — three hardcoded `current/` paths in the prompt body.
- `researcher` prompt similarly directs the agent at `current/` context (the search-quality
  slice notes the single-parent researcher prompt at `workflow.yaml:369-379`).
- §6.2's `laneTemplated` is applied only to `stateDef.run` (deterministic argv) and
  `stateDef.resultFile`. There is no mechanism shown for rewriting an agent's prompt text per
  lane.
**Why it matters:** Two lanes' `analyzer` agents both reading and overwriting
`current/analysis.md` is a real cross-lane clobber on the *agent* path — exactly the collision
§7 claims to eliminate, but §7 only addresses the *deterministic* scratch files. The doc's
"reuses the existing executors verbatim … each lane gets its own session" (§6.2) is
insufficient: the session is per-lane but the *paths in the prompt* are not.
**Correction:** Either (a) parameterize agent prompts per lane (e.g. a `{laneDir}` template
the orchestrator substitutes before `executeAgentState`), which *does* edit the manifest
prompts and contradicts §4.2's stated rationale for choosing (B) — so say so; or (b) inject
the lane dir via an environment variable / context file the agent is told to read, and rewrite
the prompts to use a relative `current/` that the per-lane `executeAgentState` resolves
against a lane-scoped working directory. Either way, the claim "agent prompts unchanged" is
false and must be retracted.

---

## SHOULD-FIX

### SHOULD-FIX-1 — `stop_signals.json` is both lane-scoped (§7.1) and shared (§9) — contradiction
**Claim:** §7.1 says "*All* per-round scratch files (`step_name`, `context.json`, …,
`cognition_item.json` — `_clear_current_round`) move under `current/lane_<k>/`." But
`_clear_current_round` also clears `stop_signals.json` (`evolve_result.py:69`), and §9 says
stop signals are recomputed **once** at the join into a single shared file, which the bridge
writes to the bare `current/` (`evolve_result.py:328`, `:747`, `:800`). So `stop_signals.json`
is described as both per-lane (§7.1's "all scratch files") and shared (§9). The orchestrator
reads one `current/stop_signals.json` (`workflow.yaml` orchestrator prompt), so it must be
shared — making §7.1's "all" wrong.
**Evidence:** `_clear_current_round` file list at `evolve_result.py:62-72` includes both the
per-lane files and `stop_signals.json`; bridge writes `stop_signals.json` to
`_current_dir(run_dir)` (bare) at `:328`/`:747`/`:800`.
**Correction:** §7.1 must enumerate which files are lane-scoped (`step_name`, `context.json`,
`sample.json`, `result.json`, `analysis.md`, `analysis_record.json`, `cognition_item.json`)
vs shared/barrier-owned (`stop_signals.json`). The `_clear_current_round` split needs the same
treatment — clearing a shared `stop_signals.json` from a per-lane clear would race or wrongly
wipe the batch signal.

### SHOULD-FIX-2 — Held-mutex escalation stall: drain-on-escalation does not fully cure it
**Claim:** §5.2/§10 assert drain-on-escalation makes "at most one escalation ever live", so
the held-mutex stall is sidestepped. But the *first* escalation still blocks all other lanes'
in-flight tool calls for the full human-response latency, because the escalating lane holds
the `callMutex` across the human wait (`tool-call-pipeline.ts:866`/`:881`, inside
`callMutex.withLock`). Drain prevents a *second* concurrent escalation; it does not release
the *first* lane's mutex while the human deliberates.
**Evidence:**
- The escalation await (`await deps.onEscalation(...)` `:866`; `await
  waitForEscalationDecision(...)` `:881`) is inside `handleCallTool`, which runs inside
  `callMutex.withLock` (`tool-call-coordinator.ts:310`/`:348`).
- Drain (§10.1) trips on `evaluator_blocked` — but `evaluator_blocked` is a **deterministic**
  verdict from `evaluate` (`workflow.yaml:445`), which runs off-mutex via `docker.exec`. So
  the *common* evolve escalation (evaluator blocked) does **not** stall the mutex at all — it
  is detected outside the coordinator. Good.
- However, an escalation arising from an **agent** tool call (researcher/analyzer touching a
  protected path → policy `escalate`) *does* go through the held mutex, and drain-on-escalation
  is keyed on `evaluator_blocked` only (§6.2 `driveLane`: the drain trip is inside the
  deterministic `evaluate` branch). An agent-path escalation has no drain trip shown, so it
  blocks every other lane's tool call while the human decides.
**Why it matters:** The doc's "drain-on-escalation sidesteps the held-mutex stall entirely"
(§5.2) is true only for the deterministic-evaluator escalation, which never touched the mutex
anyway. The residual case — agent-path policy escalation under the held mutex — is the one
that *can* stall N lanes, and §10's drain does not cover it.
**Correction:** State that agent-path escalations under the held mutex are the real stall risk
and specify the mitigation explicitly: either (a) release the mutex across the escalation wait
(acquire → evaluate → if escalate, release, await, re-acquire — the §5.2 alternative,
currently mentioned then dropped in favor of drain), or (b) extend the drain trigger to agent
escalations too. Do not claim drain alone cures it.

### SHOULD-FIX-3 — Resume re-generation breaks the search-quality slice's seeded reproducibility
**Claim:** §12 claims sync runs are "reproducible as a population (same nodes, same best
score, given seeds)" under default option (a). §11.2 admits crashed lanes re-generate *fresh*
(possibly different) candidates on resume and calls it "acceptable". These two claims are in
tension: a resumed run is **not** population-reproducible, because re-generated lanes produce
different candidates than a non-crashed run would.
**Evidence:**
- §11.2: "the agent re-generation (researcher/analyzer re-run produce a *fresh* candidate,
  possibly different from the pre-crash one)".
- The search-quality slice's reproducibility rests on a *seeded sampler*
  (`sampling_seed.txt`), but the agents themselves are not seeded — `evolve_result.py:17`
  `PYTHONHASHSEED=0` seeds `hash()` only, not the LLM and not Python `random` for samplers
  (package memory map; `evolve-search-quality-slice.md` M1 seed mechanism). So even the
  *sampler* reproducibility is conditional, and the *agent* output never was reproducible.
**Why it matters:** §12's headline "reproducible as a population given seeds" silently assumes
no crash and assumes agent determinism that does not exist. The parallel slice does not *break*
reproducibility that the linear chain had — but it inherits a reproducibility claim that was
already only about the *sampler*, not the candidates. The doc over-states it as a population
guarantee.
**Correction:** Narrow §12's claim to "the **sampler's parent selection** is reproducible
given seeds; candidate *content* is not reproducible in either the linear or parallel chain
(LLM nondeterminism), and resume re-generation makes a resumed run diverge from a clean run
regardless of N." Option (b) `reproducible: true` buys byte-identical *id-ordering*, not
byte-identical *candidates* — say so.

### SHOULD-FIX-4 — "Linear-round-chain refactor (shipped)" predecessor doc does not exist
**Claim:** The doc names a predecessor "**Linear-round-chain refactor** (shipped)" throughout
(§ Predecessors, §2, §16) and attributes the cost-distribution finding to "the linearization
slice". No such design doc exists in `docs/designs/`.
**Evidence:**
- `ls docs/designs/ | grep evolve` returns single-round / multi-round / human-surface /
  correctness / search-quality / experiment-harness / sync-parallelism — **no**
  `evolve-linear*` or `linearization` doc.
- The linear per-round chain did ship, but as part of `evolve-single-round-slice.md` (#300)
  and subsequent slices (`evolve-single-round-slice.md:605`), not a discrete "linear-round-chain
  refactor" doc. The `workflow.yaml` linear chain (`:362-503`) is real and on master.
**Why it matters:** A reader cannot find the cited predecessor or its "~88-90% cache_read /
orchestrator-cost-dominated-by-researcher/evaluate" finding (which appears nowhere in the
design docs). The slice leans on a phantom doc for both its premise and its omitted speedup
baseline.
**Correction:** Rename the predecessor to the actual shipping vehicle
(`evolve-single-round-slice.md` / the relevant PR) and, if the cost-distribution finding is
load-bearing for the speedup argument (it is — see MUST-FIX-1), cite where it was actually
measured or mark it as an unmeasured assumption to be established in Phase 0.

### SHOULD-FIX-5 — `workers: 1` byte-identical no-op is not free under shape (B)
**Claim:** Gate item 1 / §1 assert `workers: 1` produces a byte-identical `nodes.json`. §7.1
hand-waves this with "`workers: 1` keeps the bare `current/` (no `lane_` sub-path) for
byte-identical backward compat." But the no-op-ness depends on the pump taking a *different
code path* at N=1 (skip lane templating, skip `batch.json`, skip `joinBatch` cognition
re-routing) — and §9 *unconditionally* moves cognition promotion off the per-lane record path
onto the barrier `joinBatch`. If promotion moves to the join even at N=1, the *ordering* of
record-vs-promote changes relative to today's `attach_analysis` (which promotes inline,
`evolve_result.py:804` via `_promote_lesson` `:407`), which can change `cognition_promoted.json`
and any cognition-influenced subsequent sample — i.e. not byte-identical.
**Evidence:**
- Today promotion is inline in `attach_analysis` (`evolve_result.py:804`,
  `_promote_lesson:407`) on the genuine-record path.
- §9 splits this: durable record per-lane, promotion to a *new* `promote_cognition`
  subcommand called at the join. At N=1 that still reorders record→(return to FSM)→join-promote
  vs today's record+promote-in-one-call.
- Cognition feeds the next round's researcher context (`evolve_result.py` sample seeds
  cognition), so a promotion-timing change is observable downstream.
**Why it matters:** The backward-compat gate is the safety net for the whole slice (§14
Phase 3). If `workers: 1` silently changes cognition-promotion timing, the "byte-identical"
gate is either failing or being satisfied only because the test fixture has an empty cognition
store.
**Correction:** Specify that at `workers: 1` the pump takes the *legacy inline-promotion path*
(promotion stays in `attach_analysis`), and only `workers > 1` routes promotion to the
barrier. Or prove the join-promotion is order-equivalent at N=1. State which, and gate item 1
must run with a *non-empty* cognition store to actually exercise this.

---

## CONSIDER

### CONSIDER-1 — The slow-evaluate held-mutex hypothesis is wrong; say so explicitly
The task framing worries that a slow `evaluate` subprocess awaited inside the held mutex
blocks all lanes. It does not: `evaluate` is a deterministic `bundle.docker.exec`
(`orchestrator.ts:2667`), explicitly *not* a coordinator tool call
(`src/trusted-process/CLAUDE.md`). The slow per-lane work genuinely runs concurrently. The doc
should state this as a positive — it's the strongest argument that parallelism helps slow-eval
domains — rather than leaving it implicit.

### CONSIDER-2 — Dead `maxParallelism` field already exists; reconcile with new `workers`
`WorkflowSettings.maxParallelism` already exists and is read nowhere (`types.ts:115`; memory
map confirms DEAD), alongside the retired `PARALLEL_*` events (`types.ts:435-436`),
`parallelResults` (`:458`), `worktreeBranches` (`:459`). The doc adds a *new* `workers` field
without mentioning this graveyard. Either reuse/rename `maxParallelism` or explicitly delete
the dead field in the same slice so the type surface has one parallelism concept, not two.

### CONSIDER-3 — Minor citation drift (`evaluator_blocked` edge, cognition fn)
`evaluate`'s `evaluator_blocked → human_escalation` edge is at `workflow.yaml:445`, not `:444`
as cited in §4.2/§10/§17. Cognition promotion (`_promote_lesson`) is at
`evolve_result.py:407`, not `:436-466`/`:439-463` as cited in §9/§17 (the `:436` line is the
idempotency-skip check inside it). These do not change the design but should be corrected so a
reviewer trusts the rest of the (mostly accurate) §17 reference block. Note: the headline
`String(snapshot.value)` citation `orchestrator.ts:1873` is **correct** (an older memory note
had it at `:1743`; the doc re-verified — good).

### CONSIDER-4 — `batch_index` derivation is ambiguous under drain/resume
§6.3 derives `batch_index = floor(done_rounds_at_batch_start / N)`. After a drained batch
(§10) where only *some* lanes recorded, `done_rounds` advances by less than N, so the next
batch's `floor(done_rounds / N)` can collide with or skip a `batch_index`, breaking the
lane-tagged step name `step_<batch>_lane_<k>` uniqueness guarantee (§7.2) that the whole
idempotency story rests on. Specify `batch_index` as a monotonic counter independent of
`done_rounds`, persisted in `batch.json`, not derived from a node count that advances
non-uniformly under partial batches.

### CONSIDER-5 — Circuit-breaker false-trip under N similar lanes is more than "tuning"
§5.2 item 3 calls the breaker tripping faster under N lanes "a tuning item, not a safety bug."
But with all N lanes sampling identical parents (MUST-FIX-2) and reading the same cognition
file, the `(tool, argsHash)` calls are *identical*, not merely similar — N lanes × repeated
identical reads can trip the default 20/60s window
(`CallCircuitBreaker`, per `src/trusted-process/CLAUDE.md`) and **deny** legitimate lane work
mid-batch, surfacing as a spurious failure. Make the breaker window `workers`-aware *by
default* when `workers > 1`, not as an optional config — otherwise gate item 4's "correct
breaker counts" passes while real runs get throttled.

---

## Summary table

| ID | Severity | One-line |
| --- | --- | --- |
| MUST-FIX-1 | MUST | No speedup estimate; serialized tool-call mutex + barrier straggler + N× tokens make parallelism a likely wash for fast-eval circle-packing. |
| MUST-FIX-2 | MUST | Greedy lanes sample identical parents (`greedy.py:13-17`, `database.py:53`); §7's "distinct sampling" is unspecified → wasted parallelism. |
| MUST-FIX-3 | MUST | Agent prompts hardcode `current/` (`workflow.yaml:457-462`); argv-templating can't reach them → cross-lane clobber; "prompts unchanged" is false. |
| SHOULD-FIX-1 | SHOULD | `stop_signals.json` described as both lane-scoped (§7.1) and shared (§9) — contradiction. |
| SHOULD-FIX-2 | SHOULD | Drain-on-escalation doesn't cure the held-mutex stall for **agent-path** escalations (`tool-call-pipeline.ts:866`/`:881` inside `callMutex`). |
| SHOULD-FIX-3 | SHOULD | §12 over-states population reproducibility; resume re-generation + LLM nondeterminism break it regardless of N. |
| SHOULD-FIX-4 | SHOULD | Cited "linear-round-chain refactor" predecessor doc doesn't exist; cost-distribution finding is unsourced. |
| SHOULD-FIX-5 | SHOULD | `workers: 1` byte-identical no-op endangered by §9 unconditionally moving cognition promotion to the barrier. |
| CONSIDER-1 | CONSIDER | Slow-evaluate held-mutex fear is wrong (evaluate is off-mutex `docker.exec`); state it as a positive. |
| CONSIDER-2 | CONSIDER | Dead `maxParallelism`/`PARALLEL_*` graveyard (`types.ts:115`,`:435`) not reconciled with new `workers`. |
| CONSIDER-3 | CONSIDER | Citation drift: `evaluator_blocked` at `:445` not `:444`; `_promote_lesson` at `:407` not `:436`. |
| CONSIDER-4 | CONSIDER | `batch_index = floor(done_rounds/N)` collides under partial/drained batches; make it a monotonic counter. |
| CONSIDER-5 | CONSIDER | Identical-parent lanes make breaker false-trips a safety bug, not tuning; make window `workers`-aware by default. |
