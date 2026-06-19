# Evolve Native Workflow — Synchronous (Barrier-Batched) Parallelism Slice

Status: **Design — revised after two adversarial reviews; now incorporates a real-world target-domain analysis; ready to implement, gated.** This is the next gated increment after the shipped linear per-round chain (which landed as part of `evolve-single-round-slice.md` and the subsequent slices — there is no discrete "linear-round-chain refactor" doc; SHOULD-FIX-4). It introduces **N concurrent round-chains per round, joined at a barrier** ("synchronous" / "bulk-synchronous-parallel" parallelism), keeping the orchestrator a single-active-state fan-out/barrier-join controller. The async, controller-tick-on-record variant is an explicit **non-goal** (§3) — this slice is shaped so async is a later *additive* step, not a rewrite (§13).

This revision incorporates a **devil's-advocate review** (`evolve-sync-parallelism-devils-advocate.md`), an **FSM/orchestration review** (`evolve-sync-parallelism-fsm-review.md`), and a **real-world target-domain analysis** grounded in the AlphaEvolve paper (`/tmp/alphaevolve.txt`) and ASI-Evolve's flagship LLM-serving-scheduler example (`donotcommit/ASI-Evolve/README.md:85-203`). Load-bearing corrections and additions applied (full changelog at the foot of this doc):

- **§0 (REVISED) — the thesis is VINDICATED by AlphaEvolve's own paper.** §0 previously hedged that parallelism *might* win for slow-eval domains. The AlphaEvolve paper states the central claim almost verbatim: it is feasible to spend ~**100 compute-hours to evaluate one solution**, and *"unless individual evaluations are parallelized … evaluation is embarrassingly parallel … asynchronous calls to an evaluation cluster"* (`/tmp/alphaevolve.txt:420-426`); Table 1 contrasts FunSearch (*"needs fast evaluation (≤20min on 1 CPU)"*) with AlphaEvolve (*"can evaluate for hours, in parallel, on accelerators"*) (`:84`). §0 now states the slow-eval regime is the **operating regime the technique was built for**, and circle-packing is explicitly the `workers:1` regression fixture — not a hedge.
- **§0.3 (NEW) — the resource model and its limits (the biggest gap the analysis found).** The design runs N evals as concurrent `docker exec` into ONE shared container (§8, `sharedContainer:true`). That only overlaps for **CPU-light, memory-bounded** evals. The paper's heavy hitters — matmul/tensor-decomposition (`:123`, `:2170-2181`), FlashAttention/training-kernel tiling on real TPUs (`:1235-1239`), TPU arithmetic-circuit Verilog (`:124`) — are GPU/TPU/memory-bound; the paper's smoking gun is *"1000 random seeds on evaluators with a single GPU accelerator, we often run out of memory"* (`:2180`). For those, N concurrent execs in one container **do not overlap** — they serialize on the accelerator or OOM each other, and the off-mutex-overlap win evaporates exactly where eval is most expensive. DeepMind's resolution was a **fleet of evaluator nodes**, not N execs into one box. §0.3 states the design implication (per-lane resource isolation / N containers / host-side bounded eval queue) and flags this as the bridge to distributed evaluator scheduling.
- **§0/§13 (REVISED) — FIFO-mutex reframed as a circle-packing artifact; async-as-stepping-stone strengthened.** Real evolve agents are think-then-write-one-diff (diff-based evolution, `config.yaml:44-49`), so tool-call serialization through the coordinator mutex is negligible against a 100-compute-hour eval; for the target domains the bottlenecks are **resource contention** and **straggler tax**, not the mutex. The mutex analysis stays (it is why N=1 circle-packing is a wash), but no longer leads as the dominant concern. The hard-barrier straggler tax is large for high-variance real evals (cascade eval; v2 timeouts of 300s/1800s, `config.yaml:20`,`:61`); AlphaEvolve is async by construction, *"optimized for throughput rather than the speed of any one particular computation"* (`:455-462`), so sync is genuinely a stepping stone (§13).
- **§14 OQ6 (RESOLVED) — validation target set.** Validate the speedup on ASI-Evolve's own **LLM-serving / inference-throughput scheduler** (`README.md:85-203`) or a Borg-style scheduler simulation (`:1167-1181`) — the one heavy-hitter class that is slow-eval AND CPU+memory-bound, so it genuinely overlaps in one shared container without GPU isolation. Caveated: it overlaps only up to the container's core/RAM budget and does **not** generalize to the GPU/TPU flagship domains (those need §0.3's resource model).
- **§6.2 — bundle minted once, before fan-out.** `ensureBundleForScope` is an unguarded check-then-act race (`orchestrator.ts:838-839`, `:864`; its own comment at `:820-824` admits this). The orchestrator now mints the scope bundle **once at the fan-out boundary** before any lane runs; lanes only ever borrow it.
- **§3/§4.2/§6/§11 — topology resolved to shape A.** The doc no longer contradicts itself between `machineState:"workers"` and "shape B, no `workers` state." We adopt **a real `workers` state** so resume (`orchestrator.ts:1558-1561`) re-enters the fan-out driver.
- **§5/§10 — agent-path policy escalation stalls the mutex.** Drain-on-`evaluator_blocked` does *not* cover a policy escalation raised inside an agent lane, which awaits *inside the held `callMutex`* (`tool-call-pipeline.ts:866`/`:881`) and stalls every other lane. Phase 0 now audits exactly this; the honest minimal answer is documented.
- **§4.2/§6/§7 — lane-state invisibility costs are named, not hidden.** Lanes bypass the actor, so visit counts (`machine-builder.ts:262`, `:604-608`), `maxVisits`, per-lane token/stall write-back (`AgentInvokeResult.totalTokens`/`outputHash`), and `isRoundLimitReached` (`guards.ts:21-26`) do not apply per lane. Each is threaded manually or documented as a loss with its replacement bound.

Audience: IronCurtain workflow + docker-infrastructure engineer extending the merged `evolve` workflow package (all prior increments — single/multi-round hub, human-surface gates, experiment harness, correctness slice, search-quality slice, and the **linear per-round chain** that landed across those slices — are on `master`).

Implementation contract: this document names the exact deltas to add fan-out/barrier-join concurrency. The touched files are the **manifest** (`src/workflow/workflows/evolve/workflow.yaml`), the **bridge** (`src/workflow/workflows/evolve/scripts/evolve_result.py`), the **orchestrator** (`src/workflow/orchestrator.ts` — the manual service pump), the **validator/linter** (`src/workflow/validate.ts`, `src/workflow/lint.ts`), and the **state schema** (`src/workflow/types.ts`). The vendored `evolve_core/` engine stays **byte-verbatim** (§12) — every mechanism below is reachable through existing engine surfaces (the engine's durable DB is already cross-process safe; §8) and the bridge/manifest/orchestrator. The settled sync-vs-async decision is **not relitigated here**; this doc is SYNC only.

Predecessors (merged, build ON — do not redesign):

- **Linear per-round chain** (shipped — landed across `evolve-single-round-slice.md` and the multi-round/correctness/search-quality slices; **not** a discrete "linear-round-chain refactor" doc, SHOULD-FIX-4). The `evolve` round is a self-contained linear chain `sample → researcher → evaluate → analyzer → analysis_record → orchestrator` (the chain head `sample` is the `design`-edge target at `workflow.yaml:353-354`; the chain returns via `analysis_record`'s `recorded → orchestrator` at `:497-498`). The orchestrator (`workflow.yaml:303-360`) is a round-boundary controller entered once per recorded round. This slice makes that orchestrator a **fan-out/barrier-join** point. **The per-round cost-distribution claim used in §0's speedup model (researcher/analyzer LLM cost vs. evaluator cost) is an unmeasured assumption** to be established in Phase 0 (§14), not a finding inherited from a prior doc.
- **Correctness slice** — `docs/designs/evolve-correctness-slice.md`. The idempotency guard keyed on `meta_info.step_name` (`evolve_result.py:186-191`, `:733`) and the post-record stop-signal computation in `attach_analysis`. This slice **relies on** idempotent re-records: barrier resume re-runs the in-flight batch (§11).
- **Search-quality slice** — `docs/designs/evolve-search-quality-slice.md`. Multi-parent sampling (`--n-from-spec`, `parents` array), the cognition-promotion path in `attach_analysis`, and the seeded-sampler reproducibility mechanism. This slice **interacts with** all three: lane-distinct sampling (§7), serialized cognition promotion at the barrier (§9), and DB-order determinism (§12).
- **Container snapshot & resume** — `docs/designs/workflow-container-snapshot-resume.md`. Durable state lives **outside the FSM** (the engine DB on the host `/workspace` mount; container image digests in the checkpoint). Resume = restore + re-run. This slice leans on it entirely for batch resume (§11).

---

## 0. When parallelism wins, and when it does not (read this first)

**This is the most important section in the doc, and it is deliberately blunt. The technique is built for ONE regime — slow evaluation — and the AlphaEvolve paper says so almost verbatim.** That paper states it is feasible to spend on the order of **100 compute-hours to evaluate a single solution**, and that *"unless individual evaluations are parallelized to reduce their wall-clock duration, this can slow down the rate at which new generations appear … evaluation is embarrassingly parallel … allowing AlphaEvolve to distribute this work through asynchronous calls to an evaluation cluster"* (`/tmp/alphaevolve.txt:420-426`). Table 1 in the same paper draws the line directly: FunSearch *"needs fast evaluation (≤20min on 1 CPU)"*, whereas AlphaEvolve *"can evaluate for hours, in parallel, on accelerators"* (`:84`). **Parallel evaluation is not a hedge for this design — it is the operating regime the whole technique was built for.** Circle-packing's short scipy optimize is the opposite regime (fast, uniform eval); it is the `workers:1` regression fixture (gate item 1), **not** the speedup demo.

The realistic value is therefore *real but bounded*, and the bound has two distinct origins for two distinct domain classes: (i) for **CPU-light slow-eval** domains, the bound is the serialized-tool-call floor plus the straggler tax (§0.1); (ii) for **GPU/TPU/memory-bound** domains, the bound is *resource contention inside the single shared container* — the off-mutex-overlap win evaporates because N evals serialize on one accelerator or OOM each other (§0.3, the biggest gap this analysis found). Here is the honest accounting for both.

### 0.1 What actually runs concurrently — and what does not (the CPU-light case)

Three facts bound the realized speedup. They apply with full force only to **CPU-light, memory-bounded** evals (the regime where N execs into one container genuinely overlap); the GPU/TPU-bound case is governed by the resource model in §0.3, where the win evaporates for a different reason.

1. **Every agent tool call is serialized across all lanes by the coordinator's FIFO mutex — but for the target domains this is negligible, not dominant.** `handleToolCall` and `handleStructuredToolCall` run their *entire* body — policy eval, audit append, circuit-breaker check, **and the escalation await** — inside `this.callMutex.withLock(...)` (`tool-call-coordinator.ts:310-313`, `:348-357`); the mutex is fair FIFO and non-reentrant (`async-mutex.ts:13`, `:15`, in `src/trusted-process/`). So N `researcher`/`analyzer` lanes do **not** make their filesystem/MCP tool calls concurrently — every tool touch queues single-file. **But weigh this honestly against the real domains.** Production evolve agents are *think-then-write-one-diff*: ASI-Evolve's researcher uses diff-based evolution, editing a sampled parent via a handful of SEARCH/REPLACE edits (`config.yaml:44-49`), so a lane's tool-call footprint is a small, bounded number of file touches. Against a per-candidate eval measured in *compute-hours* (`/tmp/alphaevolve.txt:420-421`), the milliseconds those serialized touches cost are noise. **The mutex floor is why N=1 circle-packing is a wash (fast eval, so the floor is a visible fraction); it is NOT the dominant concern for the slow-eval domains the slice targets.** The agents *think* (LLM generation) in parallel; their *tool calls* serialize, and for the target domains that serialization is irrelevant against the eval cost. (The agent-path *escalation* stall, §5.2, is a separate latency-cliff that stays in-scope regardless of domain.)
2. **The expensive deterministic steps DO run concurrently — and this is the real win for CPU-light evals.** `sample`, `evaluate` (the evaluator subprocess), and `analysis_record` are trusted `bundle.docker.exec` calls (`orchestrator.ts:2667`), explicitly **not** coordinator tool calls (`src/trusted-process/CLAUDE.md`, "Deterministic container exec"). They never touch the `callMutex`. So the slow per-lane work — the evaluator — overlaps across lanes **when it is CPU-light/memory-bounded**. **The slow-evaluate-stalls-all-lanes fear is therefore wrong** (CONSIDER-1): `evaluate` never holds the mutex. *Caveat made load-bearing in §0.3:* "overlaps" assumes the evals do not contend on a shared scarce resource (cores, RAM, a single GPU). For the GPU/TPU heavy hitters that assumption fails and N concurrent execs serialize on the accelerator — see §0.3.
3. **The barrier is a hard `Promise.all` join (§6.2), so wall-clock per batch is the straggler lane's time, not the mean — and for real domains this is the dominant tax.** LLM-latency variance across lanes makes the straggler tax real, and it grows with N. For the target domains it is *large*: real evaluation is high-variance (cascade evaluation prunes weak candidates early while survivors run orders of magnitude longer; ASI-Evolve's v2 carries 300s eval / 1800s engineer timeouts, `config.yaml:20`,`:61`), so the straggler-to-mean ratio is wide. The hard barrier pays that ratio every batch. This is the price the sync model accepts as a stepping stone (§13); AlphaEvolve avoids it by being async by construction (`:455-462`).

Putting (1)–(3) together, the realized speedup obeys an Amdahl bound, not a linear-in-N one:

```
speedup(N)  ≈  1 / ( f_serial  +  f_parallel / N )   ×   (1 / straggler_inflation(N))

  f_serial   = fraction of per-round wall-clock spent in serialized agent tool calls
               (every researcher/analyzer FS/MCP touch) + the post-barrier serialized
               join (cognition promotion + stop-signal recompute, §9)
  f_parallel = fraction in genuinely-concurrent work: in-agent LLM generation +
               off-mutex evaluator docker.exec
  straggler_inflation(N) ≥ 1, grows with per-lane latency variance
```

The honest reading: **the win scales with `f_parallel`, which is dominated by `evaluate` + LLM-thinking time.** When evaluation is slow (the paper's ~100 compute-hours per candidate, `/tmp/alphaevolve.txt:420-421`), `f_parallel → 1` and the speedup approaches `N / straggler_inflation` — a real, large win, **provided the N concurrent evals actually overlap.** That proviso is the whole content of §0.3: the Amdahl model above silently assumes `evaluate`'s N concurrent execs run in parallel, which holds for CPU-light/memory-bounded evals but *fails* for GPU/TPU/memory-bound evals that serialize on one accelerator or OOM each other (`:2180`). When evaluation is fast and uniform (circle-packing), `f_parallel` shrinks, the serialized-tool-call floor and the straggler tax dominate, and the speedup collapses toward 1.

### 0.2 Why circle-packing is the wrong motivating domain

- The circle-packing evaluator is a short scipy/SLSQP optimize — fast and CPU-bound. N concurrent evals on **one shared container** (`sharedContainer: true`, `workflow.yaml:8`; N concurrent `docker.exec` into one `containerId`, `orchestrator.ts:2667`) **contend for the same cores** rather than overlapping I/O. So even the off-mutex win (fact 2) erodes: fast CPU-bound evals do not parallelize on a contended container.
- Token spend is **strictly N×** (N researcher + N analyzer agent runs per batch).
- The search-quality slice's own framing is that circle-packing's win comes from *cognition + multi-parent recombination* (`evolve-search-quality-slice.md`), **not** from raw round throughput.

**Conclusion the doc commits to:** sync parallelism is a win for **slow-eval / high-per-round-latency domains** — the regime the AlphaEvolve paper says the technique was built for (`/tmp/alphaevolve.txt:420-426`, `:84`) — *provided the evals overlap in the shared container* (§0.3). It is roughly a **token-for-throughput wash, plausibly a net loss, for fast-uniform-eval domains like circle-packing** (where evals contend on cores, tool calls serialize, and you pay full N× tokens for a sub-N throughput gain). **The slice's value must be validated on a slow-eval workload that is also CPU/memory-bound (so it overlaps in one container); the natural target is ASI-Evolve's own LLM-serving scheduler (§14 OQ6). Circle-packing is the backward-compat fixture (`workers: 1`, gate item 1), not the speedup demo.** Phase 0 (§14) measures the per-round tool-call fraction and evaluator-cost fraction so this is grounded, not asserted.

### 0.3 Resource model and its limits — where the off-mutex win evaporates (the biggest gap)

§0.1 fact 2 says the off-mutex `evaluate` execs "overlap across lanes." **That is only true when the evals are CPU-light and memory-bounded.** The design runs all N evals as N concurrent `docker exec` into ONE shared container (`sharedContainer: true`, `workflow.yaml:8`; N concurrent `bundle.docker.exec(bundle.containerId, …)`, `orchestrator.ts:2667`). Overlap of N processes in one box requires that the resource each eval is bound on is *not* a single shared scarce resource. For the AlphaEvolve flagship domains, it is exactly that:

- **Matrix-multiplication / tensor-decomposition** (`/tmp/alphaevolve.txt:123`, full results `:2170-2181`) — GPU-bound. The paper's smoking gun is explicit: running discovered programs *"on sizes beyond ⟨5,5,5⟩ on 1000 random seeds on evaluators with a single GPU accelerator, we often run out of memory"* (`:2180`). N concurrent evals on one GPU do not overlap — they serialize on the accelerator or OOM each other.
- **Training-kernel / FlashAttention tiling** (`:124`, *"optimizing matrix-multiplication kernels used to train LLMs … optimizing the runtime of attention in Transformers"*; the Pallas-kernel tiling study minimizes *actual runtime on real TPU accelerators*, `:1235-1239`) — TPU-bound, and the *score itself is a wall-clock measurement*, so co-located evals would corrupt each other's timing even if memory allowed.
- **TPU arithmetic-circuit Verilog** (`:124`, *"optimizing arithmetic circuits used within TPUs"*) — bound on heavyweight synthesis/simulation tooling (memory + licensed simulators), again not freely co-locatable.

For all three, **N concurrent execs in one container do not overlap; the design's central off-mutex-overlap win (§0.1 fact 2) evaporates exactly where evaluation is most expensive** — the worst possible place to lose it. DeepMind's own resolution was **not** N execs into one box: it was a **fleet of evaluator nodes** behind the async controller (the pipeline is *"a controller, LLM samplers, and evaluation nodes … optimized for throughput,"* `:455-462`; the Borg-scheduler study evaluated candidates against *"snapshots of workloads and capacity across Google's fleet,"* `:1176`).

**Design implication (the bridge to distributed evaluator scheduling).** For the GPU/TPU/memory-bound domains, the shared-single-container model is insufficient and needs one of:

1. **Per-lane resource isolation** — cgroup CPU/memory limits per exec, and GPU partitioning (e.g. MIG slices / per-lane device assignment) so a fat-memory lane cannot OOM its peers and timing-sensitive evals do not interfere. This keeps one container but caps N at the real device count.
2. **N containers (one per lane)** — abandons `sharedContainer` for these domains; each lane gets its own container with its own device, at the cost of the shared `/workspace`/DB convenience (the DB is already cross-process safe, §8, so this is mechanically feasible — but it is a topology change, not a tweak).
3. **A host-side bounded eval queue** — keep the shared container for the agent/sample/record work, but route `evaluate` through a bounded pool sized to the device budget, so at most `devices` evals run concurrently and the rest queue. This is the smallest step toward the paper's evaluator cluster.

**This is the bridge to distributed evaluator scheduling** and is explicitly out of scope for *this* sync slice — but it is the load-bearing reason the slice's validated win (§14 OQ6) must be a CPU+memory-bound domain (where option-0, the current shared container, suffices), and the reason the GPU/TPU flagship domains are flagged as needing this resource model before the technique delivers there. The sync barrier and the lane machinery (§6) are unaffected by which of 1–3 is chosen; the resource model is orthogonal to the FSM topology and slots in at the `evaluate` exec point (`orchestrator.ts:2667`).

### 0.4 Knock-on consequences of the serialized tool calls

- **Circuit-breaker false-trips become a correctness risk, not just tuning** (CONSIDER-5). With identical-parent lanes (§7.4) reading the same cognition/candidate files, the `(tool, argsHash)` calls are *identical*, not merely similar. N lanes × repeated identical reads can trip the default 20/60s window and **deny** legitimate lane work mid-batch. So the breaker window must be made `workers`-aware **by default when `workers > 1`** (not optional config) — see §5.2 item 3.
- **The slowest realistic risk is the agent-path escalation stall** (§5.2, §10), where one lane's policy escalation holds the FIFO mutex across the full human-response latency, freezing every other lane's tool calls. That is a *latency cliff*, not a throughput gradient, and it is addressed as a Phase 0 gate item.

## 1. Summary & goals

The shipped linear round-chain runs exactly one candidate per round: the orchestrator emits `design`, the chain `sample → … → analysis_record` produces and records one node, and control returns to the orchestrator, which re-decides continue/complete/escalate. ASI-Evolve's reference pipeline runs **N workers per round** (`pipeline.parallel.num_workers`, "2–4 for production"; `scripts/README.md:286`) — N candidates explored concurrently against one shared population DB, joined per round before the controller advances.

This slice adds that fan-out, **synchronously**: at `design`, the orchestrator spawns **N concurrent round-chains** (lanes), waits at a barrier until **all N** have recorded their node, then re-decides continue/complete/escalate **once per batch**. N is a configurable worker count; **`workers: 1` must reproduce today's single-worker behavior byte-for-byte** (the default).

**Read §0 before anything else.** The technique is built for **slow evaluation** — the AlphaEvolve paper's ~100-compute-hour-per-candidate regime, where *"unless individual evaluations are parallelized … evaluation is embarrassingly parallel"* (`/tmp/alphaevolve.txt:420-426`) and AlphaEvolve *"can evaluate for hours, in parallel, on accelerators"* (`:84`). The realized speedup is still bounded below N, and for two distinct reasons by domain class: (i) for CPU-light slow-eval domains, the bound is the (negligible, against a 100-hour eval) serialized-tool-call floor plus the straggler tax; (ii) for the GPU/TPU/memory-bound flagship domains (matmul kernels, FlashAttention tiling, TPU circuits), the bound is **resource contention inside the one shared container — the off-mutex evaluator overlap evaporates** because N evals serialize on one accelerator or OOM each other (§0.3, the paper's own *"we often run out of memory"*, `:2180`). "N candidates explored concurrently" is true only for the off-mutex deterministic work (`evaluate`) and the in-agent LLM generation — and only when that `evaluate` does not contend on a shared device. This slice's value is the off-mutex evaluator overlap on **CPU/memory-bound** slow-eval workloads; the GPU/TPU domains need the resource model in §0.3 first. Circle-packing is the `workers:1` regression fixture, not the speedup demo.

The defining constraint is **single-active-state**: the FSM is single-active-state by construction — `String(snapshot.value)` (`orchestrator.ts:1873`), single `instance.currentState` (`:1916`, `:1510`), single `activeGateId` (`:2690`), single `currentPersonaByBundle` entry per bundle (`:1037`), flat `transitionHistory` (`:1890-1897`). We do **not** use XState parallel regions (a `type:'parallel'` value is an object → `String(value)` becomes `"[object Object]"`, breaking the spine). Instead the parent FSM stays in **one real `workers` state** (shape A, §4.2) whose single `invoke` runs N child round-chain traversals concurrently and joins them. "Spawned sub-machines" is concretely **the orchestrator's manual service pump instantiating N child round-chain pumps** (§6 — the hard part). **Honest framing (FSM review):** single-active-state is preserved by making the per-lane state *invisible* to the FSM. That invisibility is not free — it costs per-lane visit counts / `maxVisits` / `maxRounds` semantics, per-lane token/stall context write-back, per-lane resume granularity, and per-lane observability. §7.5 names each cost and either threads the replacement manually or documents the loss with its bound. We do not present invisibility as free.

The whole slice is five files:

- **`workflow.yaml`** — add **one real fan-out `workers` state** (shape A, §4.2) whose invoke is the pump's fan-out driver; keep the five spoke states *declared* (prompts/run authored there) and marked `fanOutMember` so the pump reads them per lane; add a `workers` count to `settings`; re-point the orchestrator's `design` edge at `workers`. The gates and terminals are otherwise unchanged.
- **`evolve_result.py`** — the bridge gains a per-lane working-area discipline (§7: each lane gets its own `current/lane_<k>/` sub-path instead of the single `current/`), a barrier-side serialized cognition promotion (§9), and an aggregated-escalation drain (§10).
- **`orchestrator.ts`** — the manual-pump delta: `runFanOutSegment` (the `workers`-state invoke) fans out N lane traversals over the one shared container, **mints the scope bundle once before fan-out** (§6.2, fixes the unguarded mint race), threads per-lane visit-count/token write-backs manually (§7.5), tracks per-lane progress, and barrier-joins before returning one verdict to the FSM (§6). Plus the §5 coordinator-concurrency audit + escalation-mutex fix.
- **`validate.ts` / `lint.ts`** — schema additions for `settings.workers`, `fanOut`, `fanOutMember`, `segment` (these are silently stripped by default `.strip()` Zod objects unless added — SF1), plus the lint/validator rules (§4).
- **`types.ts`** — the `workers` settings field and the new state-definition / transition fields, with the dead `maxParallelism`/`PARALLEL_*` graveyard reconciled (§4.5, CONSIDER-2).

### Non-goals (out of scope)

- **Async / streaming parallelism is OUT.** No controller-tick-on-record, no bounded worker pool that launches lane K+1 the moment lane K records, no mid-batch drain pipelining. The barrier is a hard join: all N lanes complete before the orchestrator re-decides. §13 maps which pieces are async-extensible so the follow-up is additive.
- **No `evolve_core/` change.** The byte-verbatim invariant holds (§12). The engine's durable DB is already cross-process safe (§8); the cognition store's non-safety is handled by serializing promotion at the barrier (§9), a bridge-side change.
- **No true XState parallel regions, no `spawn`, no `type:'parallel'`.** The parent stays single-active-state (§1, §6). The concurrency lives *inside* one state's invoke.
- **No new human-gate, terminal, or persona.** The gates (`preflight_review`, `human_escalation`, `final_review`) and terminals (`done`/`failed`/`aborted`) are unchanged. Lanes are homogeneous (`global` persona) so no per-lane policy swap (§8).
- **No change to N being chosen per-round.** `workers` is authored once in `settings` (or `preflight`), fixed for the run, like `maxRounds`. Per-round adaptive N is a later concern.

### Goals (binary, the gate — §15)

After this slice:

1. **`workers: 1` is a no-op.** A `workers: 1` run produces a byte-identical `nodes.json` (modulo `created_at`) to the pre-slice linear chain on the same seeded inputs. This is the backward-compat gate.
2. **N lanes record N nodes per batch.** A `workers: 3` Docker integration run records 3 nodes per batch (node count advances by 3 between orchestrator entries), each with a distinct `step_name`, no collision, no lost lane.
3. **The barrier joins.** The orchestrator is entered exactly once per batch (not once per lane); a unit/integration test proves the `workers` state's invoke resolves only after all N lane traversals have recorded.
4. **Coordinator survives N concurrent streams.** A test drives N concurrent agent tool-call streams through one `ToolCallCoordinator` and asserts the audit log has no interleaved/torn entries and the circuit breaker counts are correct (§5).
5. **Aggregated escalation.** A `workers: 3` run where one lane hits `evaluator_blocked` drains the batch and opens exactly **one** `human_escalation` gate (single `activeGateId` preserved; §10).
6. **Resume re-runs the in-flight batch idempotently.** A simulated crash mid-batch, then `workflow resume`, re-runs the batch and leaves no duplicate nodes (§11).
7. **`tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict` is clean**, and the existing evolve gates still pass.

## 2. Background — the linear chain and why sync

### 2.1 The shipped linear round-chain

Today (`workflow.yaml`): `orchestrator` (`:303`) emits `design` → `sample` (`:362`, deterministic, `--n-from-spec`) → `researcher` (`:390`, agent) → `evaluate` (`:424`, deterministic) → `analyzer` (`:450`, agent) → `analysis_record` (`:474`, deterministic, the single durable engine node-write) → back to `orchestrator` (`:497`). Each round appends exactly one node. The orchestrator reads `database_data/nodes.json` + `current/stop_signals.json` and routes `design`/`complete`/`evaluate`/`escalate` (`:338-360`).

The per-round scratch lives in a single `current/` directory (`evolve_result.py:54-55`), cleared at the top of `sample` (`_clear_current_round`, `:58-72`). `step_name` is derived from the global node count: `step_name = f"step_{done_rounds + 1:04d}"` where `done_rounds = _node_count(run_dir)` (`:575-576`). **This single-`current/`, count-derived-`step_name` design is the thing N concurrent lanes break** — §7 resolves it.

### 2.2 Why synchronous (settled — not relitigated here)

The sync (barrier-batched) model was chosen over async in the prior human discussion. The load-bearing reasons it is *implementable now*, restated as grounding (not as an argument to reopen):

- **The barrier is a clean single-active-state checkpoint boundary.** Between batches the FSM is in exactly one state (`orchestrator` or the `workers` state) with a flat checkpoint — no per-lane logical FSM state to serialize. Async would need the FSM to represent "lane 2 recorded, lanes 1 and 3 still evaluating," which the single-active-state spine cannot express without the vestigial parallel scaffolding the codebase already retired (`types.ts` `PARALLEL_*` events, `parallelResults`; lint WF005 retired, `lint.ts:43-45`).
- **Homogeneity buys safety.** The N lanes are identical (`global` persona), so the per-state policy swap (`cyclePolicy`, `orchestrator.ts:988`) happens **once before the batch** — no swap race (§8). Async with heterogeneous lanes would reintroduce it.
- **The engine DB is already barrier-friendly.** Concurrent `record`s are safe (§8); serializing the `sample`+`record` critical section through the join keeps DB-mutation order deterministic while `design`/`eval` run in parallel (§12).

## 3. The fan-out / barrier-join model

```
                      orchestrator (single FSM state, single-active)
                            │  verdict: design  (workers = N)
                            ▼
                ┌───────────────────────────────┐
                │   workers  (ONE FSM state)     │   ← invoke fans out internally
                │                                │
   FAN-OUT  ──▶ │  lane 0   lane 1   …  lane N-1 │   N child round-chain traversals,
                │   │         │            │     │   concurrent, over ONE container
                │  sample    sample      sample │   (each: sample→researcher→
                │  research  research    research│    evaluate→analyzer→record)
                │  eval      eval        eval    │
                │  record    record      record │   ← per-lane node append (DB-safe)
                │   └────┬────┴─────┬──────┘     │
                │        ▼ BARRIER  ▼            │   ← join: wait for all N records
                └───────────────────────────────┘
                            │  one verdict (recorded | escalate)
                            ▼
                      orchestrator (re-decides ONCE per batch:
                                    continue / complete / escalate)
```

- **One FSM state (`workers`).** From the FSM's vantage, exactly one state is active for the whole batch. `String(snapshot.value)` is `"workers"`; `instance.currentState` is `"workers"`; the checkpoint's `machineState` is `"workers"`. The single-active-state spine is untouched.
- **N lanes inside the invoke.** The `workers` state's invoke (a `fromPromise` actor, like every other state — `orchestrator.ts:1848`) runs N child round-chain traversals concurrently and resolves only when all N have recorded (or the batch drains on escalation, §10).
- **Barrier-join → one verdict.** When all lanes resolve, the invoke produces a single verdict (`recorded` on the happy path, `escalate` if any lane drained). The orchestrator is entered **once per batch** and re-decides continue/complete/escalate over a `nodes.json` that grew by N (and a `stop_signals.json` recomputed once at the join, §9).

The orchestrator's existing routing (`workflow.yaml:338-360`) is unchanged in *shape* — it still reads `nodes.json` + `stop_signals.json` and emits one verdict. The only change is that `done_rounds` now advances by N per entry instead of 1.

## 4. Manifest schema changes — how N workers / fan-out is expressed

### 4.1 The `workers` count

Add a `workers` field to `settings` (mirroring `pipeline.parallel.num_workers`):

```yaml
settings:
  mode: docker
  dockerAgent: claude-code
  sharedContainer: true
  workers: 1            # NEW. 1 = today's linear chain (default). 2–4 for production.
  maxRounds: 200        # backstop unchanged (but see §4.4 — must scale with N)
```

`types.ts` `WorkflowSettings` gains `readonly workers?: number` (default 1). `preflight` MAY author it from the experiment (`config.yaml`'s `num_workers`) the same way it authors `sample_n` (search-quality §5.2), writing it into the run spec for the bridge to read — **but** because `workers` governs FSM-level fan-out (not engine sampling), the simplest first cut keeps it a `settings` literal authored at workflow-definition time, not a per-run inferred value. **Recommendation: `settings.workers` literal first; `preflight`-authored later** (§14 OQ1).

### 4.2 Expressing the fan-out state — topology RESOLVED to shape A

The first draft of this doc was self-contradictory (FSM review MF1): §3/§11 asserted the checkpoint's `machineState` is `"workers"` while §4.2 recommended a shape with **no `workers` state**. Both cannot be true, and the shape-without-a-state breaks resume. Resume does:

```
restoredState = String(checkpoint.machineState)          // orchestrator.ts:1558
stateDef      = definition.states[restoredState]         // orchestrator.ts:1559
if (stateDef.type === 'agent' || 'deterministic')        // orchestrator.ts:1560
  replayInvokeForRestoredState(...)                       // orchestrator.ts:1561
```

If `machineState` is `"workers"` but no such state is declared, `definition.states["workers"]` is `undefined` and `:1560` throws on `.type`. If instead `machineState` were `"sample"` (the bare chain head), `replayInvokeForRestoredState` would re-run **`sample`'s** invoke with the *bare, non-lane-templated* `stateDef.run`/`stateDef.resultFile` (`orchestrator.ts:1587-1595`) — one single-`current/` exec, **not** the fan-out. Either way, resume is broken.

**Resolution: shape A — a single real `workers` deterministic-style state whose invoke IS `runFanOutSegment`.** This is the only shape where `machineState:"workers"` is real and resume re-enters the fan-out driver (the task's explicit requirement). The two shapes:

- **(A — CHOSEN) One real `workers` state; its invoke is the fan-out driver.** The manifest declares one `workers` state. Its invoke is `runFanOutSegment` (§6.2), registered in `provideActors` (`orchestrator.ts:1838-1858`) alongside `agentService`/`deterministicService`. The five spoke step-bodies (`sample`/`researcher`/`evaluate`/`analyzer`/`analysis_record` work) become **per-lane sub-steps the pump runs**, but their **prompts and run-commands stay authored in the manifest** as a declared sub-chain the pump reads (see below — shape A does *not* require deleting the spoke declarations; it requires that the FSM's *active state* is `workers`, while the pump consults the spoke declarations for prompts/argv). On resume, `replayInvokeForRestoredState` re-runs the `workers` invoke = re-runs `runFanOutSegment` with full lane reconstruction (§11). `String(snapshot.value)` is `"workers"`, never an object. The diagram in §3 is literal.
- **(B — REJECTED) Keep the spokes as the active states; mark the head with `fanOut`.** Cleaner-looking manifest, but `machineState` would be `"sample"`, and `replayInvokeForRestoredState` would re-run bare `sample`, not the fan-out (MF1). Salvageable only by special-casing the fan-out-segment head inside `replayInvokeForRestoredState` to dispatch to `runFanOutSegment` with lane-templated inputs — a deeper change to the resume codepath than shape A. Rejected for that reason.

**How shape A keeps prompts first-class (the house style).** The concern that motivated shape B — "FSM carries control flow, skills/prompts carry domain content" (CLAUDE.md "Authoring workflow skills") — is preserved by **declaring the spoke states in the manifest as members of the `workers` segment**, with their prompts/run-commands intact, and having the pump *read* those declarations to drive each lane. The spokes are no longer *FSM-active* states (the FSM is in `workers`), but they remain *declared* states the pump traverses. This costs the FSM-owned per-spoke mechanisms (`maxVisits`, visit counts, gate routing) — **which shape B claimed to keep but does not** (FSM review crux: lanes bypass the actor, so those mechanisms never fired per lane under shape B either; §6.4, §7.5). Shape A makes the loss explicit and threads the replacements manually (§7.5) rather than implying machinery that silently no-ops.

Manifest delta (shape A):

```yaml
states:
  orchestrator:
    transitions:
      - to: workers                                  # CHANGED: design edge now targets the fan-out state
        when: { verdict: design }
      # … evaluate (recovery), final_summary, human_escalation edges unchanged
  workers:                                           # NEW: the single fan-out FSM state
    type: deterministic                              # deterministic-style invoke; body = runFanOutSegment
    fanOut: { count: workers, join: barrier }        # NEW: N lanes, hard barrier join
    segment: [sample, researcher, evaluate, analyzer, analysis_record]  # NEW: declared sub-chain the pump drives per lane
    transitions:
      - to: orchestrator
        when: { verdict: recorded }                  # happy path: all lanes recorded
      - to: human_escalation
        when: { verdict: escalate }                  # drain (§10): any lane blocked
      - to: failed
        when: { verdict: result_file_error }
  sample:                                            # still DECLARED (prompts/run authored here), but not FSM-active
    type: deterministic
    fanOutMember: true                               # NEW: pump drives this per lane; FSM never enters it directly
    # … run/transitions: the pump reads run/resultFile and lane-templates them (§7)
  # researcher / evaluate / analyzer / analysis_record likewise fanOutMember: true
```

The segment is delimited explicitly by the `workers.segment` list (no structural inference needed). `evaluate`'s `evaluator_blocked` verdict (`workflow.yaml:444-445`, the `when:` is at `:445`) is observed by the pump and trips the drain (§10); it is no longer an FSM edge the actor fires (the actor is in `workers`), so the pump maps it to the `workers → human_escalation` transition.

### 4.3 Schema + validator rules (`validate.ts`, `types.ts`)

**Prerequisite (SF1) — the new keys must be ADDED to the Zod schemas and `types.ts` interfaces, or they are silently stripped.** The Zod schemas are plain `z.object(...)` with default `.strip()`, not `.strict()`: `workflowSettingsSchema` (`validate.ts:103-117`), `agentStateSchema` (`:54-68`), `deterministicStateSchema` (`:78-87`), `agentTransitionSchema` (`:33-38`, shared by agent + deterministic + gate transitions). So `settings.workers`, `states.workers.fanOut`/`.segment`, and `fanOutMember: true` **parse without error but are dropped** before the definition reaches the pump — which would then read `undefined` for all of them. The implementation contract must name these additions explicitly:
- `WorkflowSettings.workers?: number` (`types.ts:105-157`) + `workflowSettingsSchema` field.
- A `fanOut?: { count: 'workers' | number; join: 'barrier' }` + `segment?: readonly string[]` on the `workers` state's definition (`DeterministicStateDefinition`, `types.ts:267-296`) + `deterministicStateSchema`.
- `fanOutMember?: boolean` on `DeterministicStateDefinition`/`AgentStateDefinition` + their schemas. (`fanOut` lives on the *state*, not a transition, under shape A — so it does not need a home on the shared `agentTransitionSchema`, sidestepping the FSM review's note that `fanOut`-on-a-transition would leak into gate transitions.)

Validator rules (run after the schema additions land):
- **`workers` is a positive integer** (`>= 1`). `0` or negative is a validation error.
- **`fanOut.count` resolves to `settings.workers`** (the literal `workers` keyword, or an inline integer). A `fanOut` state whose `segment` members are not all `fanOutMember: true` is an error.
- **No human-gate state may appear inside the fan-out `segment` — this is an ERROR, not a lint warning (CONSIDER C2).** A lane has no FSM state, so it can never cause `snapshot.matches(gateName)` to fire (`orchestrator.ts:1934-1942`); a gate inside the segment is **unreachable**, not merely discouraged. The validator message states this as an unreachability invariant. The only escalation exit is the segment-boundary drain to `human_escalation` (§10).
- **`workers > 1` with `algorithm: greedy` is rejected (MUST-FIX-2 / §7.4).** Greedy is deterministic in DB state, so concurrent greedy lanes draw identical parents (degenerate). Multi-lane runs must declare a stochastic sampler. (If the run-spec sampler is not visible to `validate.ts` at lint time, this is enforced at run-start in the pump instead, with the same error.)
- **Every `fanOutMember` deterministic state with a `resultFile` writes a lane-scoped path** when `workers > 1` (SF2). The pump is the single source of truth for the lane-templated `resultFile`: it threads the **same** lane path into both the argv and `DeterministicInvokeInput.resultFile`, which `applyResultFile` reads host-side (`orchestrator.ts:2537-2606`, containment checks at `:2552-2564`). A desync between the in-container write path and the host-side `input.resultFile` read silently yields `result file … not found` (`:2566-2568`) → `result_file_error` → `failed` for every lane. The validator checks the argv uses the lane-templated working dir, not the bare `current/`; the Phase 1 unit test asserts the lane-templated path passes the `isSafeWorkspaceRelativePath`/`isWithinDirectory` containment checks (it should — `current/lane_0/…` is workspace-relative).

### 4.4 Linter rules (`lint.ts`)

- **`WF013` (new) — REVERSED from the first draft (§7.5).** The original WF013 warned "`workers > 1` requires `maxRounds` scaled UP because lanes accrue visits N× faster." That is **backwards**: lane sub-steps bypass the actor, so they accrue **zero** FSM visits (`incrementVisitCount` is an entry action that never fires for lanes, `machine-builder.ts:262`). `isRoundLimitReached` (`guards.ts:21-26`) therefore counts **batches** (orchestrator entries), not lane-rounds — so `maxRounds` is now N× *looser* than the `workflow.yaml:10-19` comment assumes. The corrected WF013 warns that `maxRounds` caps **batches**, so the realized candidate budget is `maxRounds × workers`; if the author intended `maxRounds` as a candidate budget, it must be divided by `workers`. The real per-lane bound is the manually-threaded per-lane `maxVisits` (§7.5), not `maxRounds`.
- **`WF014` (new): fan-out must be barrier-joined.** A `fanOut` with `join` other than `barrier` is rejected (async joins are a non-goal; this lint makes a future async value a deliberate, reviewed addition).
- **Reuse `WF011`** (`lint.ts:430`): a `container: true` fan-out member running before its scope is minted is still caught — but note the scope bundle is now minted **once before fan-out** (§6.2/§8.1), so this lint's invariant is satisfied by construction, not by "first lane mints."

### 4.5 Reconcile the dead parallelism graveyard (CONSIDER-2)

`WorkflowSettings.maxParallelism` already exists and is read nowhere (`types.ts:115`; `validate.ts:109`), alongside the retired `PARALLEL_*` events (`types.ts:435-436`), `parallelResults` (`:458`), and `worktreeBranches` (`:459`). Adding a *new* `workers` field beside a dead `maxParallelism` leaves two parallelism concepts on the type surface. **Decision: delete `maxParallelism` (and the retired `PARALLEL_*`/`parallelResults`/`worktreeBranches` graveyard) in this slice's `types.ts`/`validate.ts` edits**, so there is exactly one parallelism concept (`workers`). The retired-WF005/`parallelKey` lint (`lint.ts:43-45`) is the graveyard marker confirming these are dead, not load-bearing.

## 5. Coordinator concurrency — the one real unknown (audit FIRST)

N sustained concurrent agent tool-call streams (the N `researcher`/`analyzer` lanes) flow through **one** `ToolCallCoordinator` (PolicyEngine, AuditLog, CallCircuitBreaker, ApprovalWhitelist, AutoApprover, ServerContextMap). **This is the single biggest risk** and the **first implementation step** (§14 phase 0). Be honest: until audited, this is "contained feature vs kernel-hardening project."

### 5.1 What is ALREADY safe (verified — de-risks substantially)

The coordinator already holds a **FIFO call mutex** (`AsyncMutex`, fair FIFO, `src/trusted-process/async-mutex.ts:13`; non-reentrant, `:15`; `withLock` at `:42-49`):

- `handleToolCall` runs its whole body — `buildCallToolDeps()` + `handleCallTool()` — inside `this.callMutex.withLock(...)` (`tool-call-coordinator.ts:310-313`).
- `handleStructuredToolCall` likewise (`:348-357`).
- `loadPolicy` acquires call-mutex-then-policy-mutex in a fixed order (`:484-490`), and `close()` does the same (`:588-589`) — no deadlock (documented invariant, `:481-483`).

So the three RMW in-memory caches the mutex exists to protect — **ApprovalWhitelist, CallCircuitBreaker, ServerContextMap** — and the **audit append** (`auditLog.log()` inside `handleCallTool`) are **already serialized** against concurrent lanes. N concurrent `handleToolCall` invocations queue on the FIFO mutex and execute one-at-a-time. **This is the load-bearing safety fact: the coordinator was built for concurrent callers; the mutex is not new work.** Audit entries cannot interleave/tear because the whole pipeline (including the JSONL append) is inside one critical section.

### 5.2 What MUST be audited (the residual unknowns)

1. **Agent-path policy escalation under the held mutex — THE real stall, and drain alone does NOT cure it.** This is the corrected answer to MUST-FIX-4 / FSM review MF3 / devil's-advocate SHOULD-FIX-2. **Verified against the code:** the escalation await *is* inside the held call mutex — `handleCallTool` runs entirely inside `callMutex.withLock` (`tool-call-coordinator.ts:310-313`, `:348-357`), and inside it `handleCallTool` awaits `autoApprove(...)` (`tool-call-pipeline.ts:821`), then `deps.onEscalation(...)` (`:866`) or `waitForEscalationDecision(...)` (`:881`) — all under the lock. So when a `researcher`/`analyzer` lane's tool call hits an `escalate` policy rule (evolve agents are `global` persona with a *real* policy, so this is live, not hypothetical), that lane **holds the FIFO `callMutex` across the entire human-response latency**, and every other lane's tool call queues behind it (`async-mutex.ts:18`, FIFO; non-reentrant). N lanes freeze on one human deliberation.
   - **Why drain-on-escalation does NOT fix this:** §10's drain trips on the **deterministic** `evaluate` verdict `evaluator_blocked` (`workflow.yaml:444-445`), which runs **off-mutex** via `docker.exec` (`orchestrator.ts:2667`) and never touched the call mutex. So drain cures the `evaluator_blocked` case — but that case never stalled the mutex in the first place. The agent-path policy escalation has *no* `evaluator_blocked` verdict to trip the drain; the pump cannot even observe it today (it surfaces inside the coordinator, below the lane's `executeAgentState`).
   - **The honest, minimal answer (Phase 0 decides, but the design commits to this):** the **call mutex must be released across the escalation wait**. The coordinator acquires → evaluates → and *if* the verdict is `escalate`, **releases the mutex, awaits the human (auto-approve + onEscalation/waitForEscalationDecision), then re-acquires to finish the call** (write audit, breaker, transport). This is a small, well-scoped coordinator change confined to `handleCallTool`'s escalation branch (the RMW caches the mutex protects are touched *after* the human decision, so the critical section that needs the lock is the tail, not the wait). It is **in-scope for this slice**, not deferred: without it, `workers > 1` with escalation-prone personas is unsafe (a single escalation latency-cliffs the whole batch). Drain-on-escalation (§10) is retained as the *gate-aggregation* mechanism (one `activeGateId`), **not** as the mutex-stall fix — the two are now cleanly separated.
   - **Fallback if the mutex-release change proves unsafe in Phase 0:** document that `workers > 1` is supported only for personas whose policy *cannot* escalate on the agent path (i.e. the only escalation source is the off-mutex `evaluator_blocked`), and gate N>1 behind that. State this explicitly rather than shipping a silent latency cliff.
2. **AutoApprover concurrency.** The optional LLM auto-approver runs inside the escalation path (`tool-call-pipeline.ts:821`, under the lock today). With the mutex-release fix (item 1), N agent-path escalations *can* be live concurrently → N concurrent auto-approve LLM calls. This is acceptable (each is an independent cheap-model call) but Phase 0 confirms AutoApprover holds no shared mutable state across calls. (Under the rejected drain-only model this was "moot"; with the mutex-release fix it is a real concurrency point to confirm.)
3. **Circuit-breaker false-trip is a correctness risk, made `workers`-aware BY DEFAULT (not optional).** Corrected per CONSIDER-5. The breaker counts identical `(tool, argsHash)` calls in a sliding window (`CallCircuitBreaker`, default 20/60s). With identical-parent lanes (§7.4) all reading the same cognition/candidate files, the calls are **identical, not merely similar** — N lanes × repeated identical reads can trip the window and **deny** legitimate lane work mid-batch, surfacing as a spurious lane failure. This is not "tuning"; it is a default-on correctness bug at `workers > 1`. **Fix: when `workers > 1`, scale the breaker window/threshold by `workers` by default** (e.g. threshold × `workers`), not behind an opt-in config flag. Otherwise gate item 4's "correct breaker counts" passes on a synthetic test while real runs get throttled.
4. **ServerContextMap cross-lane bleed.** The git-working-directory enrichment (`server-context.ts`) is keyed per server, not per lane. N lanes in one container share one git CWD anyway (one `/workspace`), so this is consistent — but confirm no lane-specific context is needed for escalation messages.

### 5.3 Mitigation summary

- **Primary:** rely on the existing FIFO `callMutex` for audit/breaker/whitelist/context-map RMW safety (already shipped, `tool-call-coordinator.ts:310-313`/`:348-357`).
- **Escalation (the real fix):** **release the call mutex across the escalation wait** (item 1) so an agent-path escalation does not freeze every other lane. Drain-on-escalation (§10) is the *gate-aggregation* layer on top (one `activeGateId`), not the stall fix.
- **Breaker:** make the circuit-breaker window/threshold `workers`-aware **by default** when `workers > 1` (item 3) — a correctness fix, not optional tuning.
- **Honesty:** Phase 0 (§14) is "audit the coordinator under N concurrent streams, write the concurrency test (gate item 4), AND land the mutex-release escalation fix." Only after it passes do later phases land. If the mutex-release change surfaces a non-reentrancy bug the FIFO mutex does not cover, the slice either lands the kernel fix or **gates N>1 to non-agent-escalating personas** — that branch is explicit, not hidden.

## 6. The spawned-sub-machine pump mechanism (THE hard part)

This is the concrete mechanism for "N spawned sub-machines" inside our **manual-pump** orchestrator. The orchestrator uses XState only as a *transition calculator* and manually executes services: on resume it notes "we must manually execute the service" (`orchestrator.ts:1554-1562`, `replayInvokeForRestoredState`), the actor subscription assumes one active state (`String(snapshot.value)`, `:1873`; single `currentState`, `:1916`; flat `transitionHistory`, `:1890`), and the deterministic executor runs `run:` commands in a serial `for` loop, one `docker.exec` each (`reduceDeterministicCommands`, `:2615-2641`; the exec at `runDeterministicInContainer`, `:2667`). We exploit exactly this: **a lane is a manually-pumped traversal of the fan-out sub-chain, and N of them run concurrently over the one shared container, joined before the FSM transition fires.**

### 6.1 What a child traversal IS

A **lane** is a plain object the orchestrator owns (NOT an XState actor — we never `spawn`, never create N actors):

```ts
interface LaneTraversal {
  readonly laneId: number;                 // 0..N-1
  readonly workingDir: string;             // current/lane_<laneId>/  (§7)
  cursor: string;                          // current sub-chain state: 'sample' | 'researcher' | ...
  status: 'running' | 'recorded' | 'blocked' | 'drained';
  recordedNodeId?: number;                 // set when analysis_record commits
  blockReason?: string;                    // set on evaluator_blocked / lane_max_visits
  conversationId?: string;                 // per-lane agent session (researcher/analyzer)
  // === Per-lane re-implementations of FSM-context write-backs the pump bypasses (§7.5). ===
  visitCounts: Record<string, number>;     // the actor's incrementVisitCount does NOT fire for lanes
  totalTokens: number;                     // updateContextFromAgentResult.totalTokens is discarded otherwise
  outputHashes: string[];                  // per-lane stall detection (previousOutputHashes equiv)
}
```

The orchestrator drives each lane through the fan-out sub-chain (`sample → researcher → evaluate → analyzer → analysis_record`) by **reusing the existing per-state executors** — `executeAgentState` for `researcher`/`analyzer` and `executeDeterministicState` for `sample`/`evaluate`/`analysis_record` — but parameterized by the lane's `workingDir`, `conversationId`, and per-lane prompt/resultFile paths instead of the single global `current/`. Crucially, **these executors are the same functions the FSM invoke already calls** (`orchestrator.ts:1586-1595`); the pump calls them directly, in a per-lane loop, rather than through the XState `fromPromise` actor. **The cost of bypassing the actor — dropped context write-backs — is paid back manually per lane (§7.5); see the `LaneTraversal` fields above.**

### 6.2 The `workers`-state invoke = the fan-out driver

The fan-out segment is driven by a new orchestrator method `runFanOutSegment(workflowId, context)` that is the invoke body of the real `workers` state (shape A, §4.2). It is registered as the actor for the fan-out (analogous to `agentService`/`deterministicService` at `orchestrator.ts:1840-1858`):

```ts
private async runFanOutSegment(
  workflowId: WorkflowId,
  context: WorkflowContext,
): Promise<FanOutResult> {
  const instance = this.workflows.get(workflowId)!;
  const N = resolveWorkers(instance.definition);            // settings.workers, default 1
  const segment = resolveFanOutSegment(instance.definition); // workers.segment: ['sample','researcher','evaluate','analyzer','analysis_record']

  // === PRECONDITION: mint the scope bundle ONCE, BEFORE fan-out (MUST-FIX-2 / FSM MF2). ===
  // ensureBundleForScope is unguarded check-then-act across awaits (orchestrator.ts:838-839,
  // :864) — its own comment (:820-824) says concurrent lazy-mint races are unhandled. N lanes
  // each hitting their first `container:true` step would each see bundlesByScope.get(scope)
  // === undefined and mint a SEPARATE container, defeating sharedContainer. So we mint here,
  // serially, before any lane runs. Every lane then BORROWS the already-minted bundle.
  const scope = resolveFanOutScope(instance.definition);    // the single containerScope of the segment
  await this.ensureBundleForScope(instance, scope);         // single await; no concurrent mint possible

  // Restore any in-flight lane progress on resume (§11); else fresh lanes.
  const lanes = this.restoreOrCreateLanes(instance, N);

  const drain = { tripped: false, reason: undefined as string | undefined };

  // FAN-OUT: drive all lanes concurrently. Each lane runs the sub-chain to
  // completion (record) or to a drain/block. Promise.all is the BARRIER.
  await Promise.all(lanes.map((lane) => this.driveLane(workflowId, lane, segment, drain, context)));

  // BARRIER reached: all lanes are 'recorded' | 'blocked' | 'drained'.
  // Serialized post-barrier work (single writer): cognition promotion (§9),
  // stop-signal recompute (§9), escalation aggregation (§10).
  await this.joinBatch(workflowId, lanes, drain);

  return this.batchVerdict(lanes, drain);   // { verdict: 'recorded' } | { verdict: 'escalate', items }
}
```

> **MUST-FIX-2 / FSM MF2 — the mint-before-fan-out precondition is load-bearing.** As an additional belt-and-braces, `ensureBundleForScope` itself SHOULD gain the in-flight-promise guard its `:820-824` comment already prescribes (store the `Promise<bundle>` keyed by scope before the first `await`, return it to concurrent callers). The pre-fan-out single mint is the design-level fix; the in-flight-promise guard hardens the function against any *other* future concurrent caller. Name both in the implementation contract — the §5 coordinator audit covers the *coordinator*, not this orchestrator-side bundle-mint race, which is a distinct concurrency gap.

`driveLane` is the per-lane manual pump — a loop over the sub-chain cursor. **It threads the per-lane FSM write-backs the actor would normally do (§7.5), because it bypasses the actor:**

```ts
private async driveLane(workflowId, lane, segment, drain, context): Promise<void> {
  const instance = this.workflows.get(workflowId)!;
  for (const stateId of segment) {
    if (drain.tripped) { lane.status = 'drained'; return; }   // cooperative drain check (§10)
    const stateDef = instance.definition.states[stateId];
    const laneCtx = withLaneWorkingDir(context, lane);        // points current/ → current/lane_<id>/ (§7)

    // (§7.5) The actor's `incrementVisitCount` entry action (machine-builder.ts:262, :604-608)
    // does NOT fire for lanes — the pump bypasses the actor. Thread a PER-LANE visit count and
    // enforce per-lane maxVisits manually, or this bound is dead (FSM review crux).
    lane.visitCounts[stateId] = (lane.visitCounts[stateId] ?? 0) + 1;
    if (stateDef.maxVisits && lane.visitCounts[stateId] > stateDef.maxVisits) {
      lane.status = 'blocked'; lane.blockReason = `maxVisits(${stateDef.maxVisits}) exceeded in lane ${lane.laneId}`;
      drain.tripped = true; drain.reason = 'lane_max_visits';          // surfaces as escalate (§10)
      return;
    }

    if (stateDef.type === 'agent') {
      const res = await this.executeAgentState(workflowId,
        { stateId, stateConfig: stateDef, context: laneCtx, laneId: lane.laneId,
          promptOverride: laneTemplatePrompt(stateDef.prompt, lane) },   // (§7.3) per-lane prompt path
        instance.definition);
      lane.conversationId = res.agentConversationId;
      // (§7.5) The actor's `updateContextFromAgentResult` write-back is bypassed: accumulate
      // per-lane tokens + stall hash HERE or per-lane budget/stall stop tracking.
      lane.totalTokens += res.totalTokens;
      lane.outputHashes.push(res.outputHash);
    } else { // deterministic
      const res = await this.executeDeterministicState(workflowId,
        { stateId, commands: laneTemplated(stateDef.run, lane), context: laneCtx, container: true,
          containerScope: stateDef.containerScope,
          resultFile: laneTemplated(stateDef.resultFile, lane),         // (§7 / SF2) SAME lane path the argv writes
          timeoutMs: stateDef.timeoutMs });
      if (stateId === 'evaluate' && res.verdict === 'evaluator_blocked') {
        lane.status = 'blocked'; lane.blockReason = res.errors;
        drain.tripped = true; drain.reason = 'evaluator_blocked';       // trip the drain (§10)
        return;
      }
      if (stateId === 'analysis_record' && res.verdict === 'recorded') {
        lane.recordedNodeId = readRecordedNodeId(lane.workingDir);
        lane.status = 'recorded';
      }
      // result_file_error / needs_repair → propagate as a batch failure (mapped to FSM `failed`).
    }
  }
}
```

Key properties:

- **Bundle minted once, before any lane.** `runFanOutSegment` calls `ensureBundleForScope` *before* the `Promise.all`, so the scope bundle exists when the first lane runs and every lane reuses the same `containerId` (`bundlesByScope.get(scope)` hits, `orchestrator.ts:838-839`). No N-container race.
- **N concurrent `docker.exec`s into one container.** `executeDeterministicState` ultimately calls `bundle.docker.exec(bundle.containerId, …)` (`orchestrator.ts:2667`). N lanes call it concurrently against the **same `containerId`** — exactly the model (§8). The existing serial `for` in `reduceDeterministicCommands` (`:2615-2641`) is *per-lane* (one command array per spoke); the fan-out concurrency is *across* lanes (the `Promise.all`), so that serial loop is untouched (FSM review C4 confirms this read).
- **The FSM sees one invoke.** From XState's vantage, the `design` edge invokes the `workers` state once; `runFanOutSegment`'s promise resolves once (the barrier); the actor receives one `xstate.done.actor` event and transitions back to `orchestrator`. `String(snapshot.value)` is `"workers"`, never an object. `instance.currentState` is `"workers"` for the whole batch.
- **Reuses the executors' EXECUTE half — and re-implements the ASSIGN half (§7.5).** `executeAgentState`/`executeDeterministicState` run unchanged except for `laneId` + lane-working-dir + per-lane prompt/resultFile. But the executors are *half* of a two-part mechanism: execute, then the actor's entry/`updateContextFromAgentResult` actions *assign back to FSM context*. Bypassing the actor keeps execute and drops assign. The pump must re-do the load-bearing assigns per lane (visit counts, tokens, stall hashes) — this is the FSM review's central correction, made concrete in `driveLane` above and itemized in §7.5.

### 6.3 How a lane's progress is tracked — DB-as-truth, `batch.json` demoted (SF3)

The FSM checkpoint stays flat (`machineState: "workers"`). The question is how resume reconstructs which lanes already recorded. The first draft proposed a `current/batch.json` ledger written "as each lane advances" — but the FSM review (SF3) correctly notes this is a **second, non-atomic checkpoint** that races the authoritative FSM checkpoint (written atomically per transition via temp-file rename, `checkpoint.ts:53-62`, `orchestrator.ts:1905`) and that the doc itself tells resume to *distrust* (§11's "DB-as-truth"). A second source of truth the resume logic is told to ignore should not exist in that form.

**Resolution: derive lane-resume state purely from the engine DB; `batch.json` becomes advisory-only or is dropped.** The only durable, trustworthy fact is "is this lane's `step_name` already a recorded node?" — answered directly from `nodes.json` via `_find_recorded_node_for_step` (`evolve_result.py:186-191`). With lane-tagged step names `step_<batch_index>_lane_<k>` (§7.2), `restoreOrCreateLanes` reconstructs the batch entirely from the DB:

```
for k in 0..N-1:
    if nodes.json contains a node with meta_info.step_name == f"step_{batch_index:04d}_lane_{k}":
        lane[k].status = recorded   # skip
    else:
        lane[k].status = running    # re-run from `sample`
```

No `batch.json` read is required for correctness. If a lightweight ledger is still wanted (e.g. for `workflow inspect` readout), it is **advisory only**, written **atomically** (temp+rename, mirroring `checkpoint.ts`), and its sole *load-bearing* field is `batch_index`; every per-lane status field is **decorative** (the DB overrides it). The doc no longer claims `batch.json` is the resume source of truth.

**`batch_index` is a monotonic counter, NOT `floor(done_rounds / N)`** (CONSIDER-4). After a *drained* batch (§10) only some lanes record, so `done_rounds` advances by less than N, and `floor(done_rounds / N)` would collide or skip — breaking the `step_<batch_index>_lane_<k>` uniqueness that the whole idempotency story rests on. `batch_index` is therefore an independent monotonic counter, persisted in the (advisory, atomic) `batch.json` *and* recoverable from the DB as `1 + max(batch_index seen in any recorded step_name)`. Derivation from a node count that advances non-uniformly is explicitly rejected.

**Per-lane observability is a named loss (CONSIDER C1).** A `workers` batch produces **one** `TransitionRecord` (`orchestrator → workers → orchestrator`; `TransitionRecord` has no `laneId`, `types.ts:617-625`) and **zero** per-lane state-transition log entries (the message-log append at `orchestrator.ts:1908-1913` is keyed off FSM transitions, which lanes are not). So `workflow inspect` and the web-UI transition view go dark *inside* a batch. This is a deliberate observability regression, the price of single-active-state, **not** a free win. Mitigation (cheap, recommended): emit a `laneId`-tagged **message-log** entry per lane sub-step (the message log is freer-form than `TransitionRecord` and does not need to stay single-valued). A `laneId` on `TransitionRecord` itself is *not* added — that record is the FSM's single-active-state ledger by contract.

### 6.4 Why not XState parallel regions (restated as a guardrail)

A `type:'parallel'` machine's snapshot value is an **object** → `String(value)` → `"[object Object]"` (`orchestrator.ts:1873`), which would break checkpoint serialization (`machineState`), terminal detection (`isTerminalStateValue`, `:1970`), and gate matching (`snapshot.matches`, `:1934`). `spawn`/`sendTo` are likewise unused by the machine builder (it emits only 4 flat state kinds). The pump approach keeps **all** of that single-valued: the concurrency is in plain `Promise.all` over plain `LaneTraversal` objects, entirely below the XState layer. This is the *whole point* — the parent stays single-active-state; only the invoke body is concurrent.

## 7. Lane discipline — distinct working areas, no collision

The single-`current/` design (`evolve_result.py:54-55`) and count-derived `step_name` (`:575-576`) collide under N lanes: all N would write `current/step_name`, `current/context.json`, `current/result.json`, and all N would compute the **same** `step_name` from the same `done_rounds` at fan-out time. Resolution:

### 7.1 Per-lane working sub-paths

Each lane gets its own working area: **`current/lane_<laneId>/`** instead of `current/`. The bridge's `_current_dir(run_dir)` (`:54-55`) gains a lane parameter (a `--lane <k>` flag on every bridge subcommand, or a `EVOLVE_LANE` env var the pump sets per `docker.exec`):

```python
def _current_dir(run_dir: Path, lane: int | None = None) -> Path:
    base = run_dir / "current"
    return base / f"lane_{lane}" if lane is not None else base
```

The **lane-scoped** scratch files (`step_name`, `context.json`, `sample.json`, `result.json`, `analysis.md`, `analysis_record.json`, `cognition_item.json`) move under `current/lane_<k>/`. The manifest's `run:` argv for each `fanOutMember` state is lane-templated by the pump (`laneTemplated`, §6.2): the `--context-file`/`--result-file` paths become `…/current/lane_<k>/…`. `workers: 1` keeps the bare `current/` (no `lane_` sub-path) for byte-identical backward compat (gate item 1).

**`stop_signals.json` is the one exception — it is shared/barrier-owned, NOT lane-scoped** (SHOULD-FIX-1). The first draft said "*all* per-round scratch files … move under `current/lane_<k>/`," but `_clear_current_round` (`evolve_result.py:62-72`) also lists `stop_signals.json`, which §9 recomputes **once** at the join into the bare `current/stop_signals.json` (`evolve_result.py:328`, `:747`, `:800`) — the single file the orchestrator prompt reads per batch. So the file split is:

| File | Scope | Owner |
| --- | --- | --- |
| `step_name`, `context.json`, `sample.json`, `result.json`, `analysis.md`, `analysis_record.json`, `cognition_item.json` | **lane-scoped** (`current/lane_<k>/`) | the lane |
| `stop_signals.json` | **shared** (bare `current/`) | the barrier join (§9), written once |

`_clear_current_round` is correspondingly split: the per-lane clear (at each lane's `sample`) wipes only that lane's sub-dir; `stop_signals.json` is **not** touched by a per-lane clear (a per-lane clear of a shared file would race or wrongly wipe the batch signal). The shared `stop_signals.json` is owned by the join's `recomputeStopSignals` (§9), which overwrites it once per batch.

### 7.2 Distinct step names without collision

`step_name = f"step_{done_rounds + 1:04d}"` (`:575-576`) computed from a shared `done_rounds` would give all N lanes the same name. Two options:

- **(a) Offset by laneId at sample time:** `step_name = f"step_{done_rounds + 1 + laneId:04d}"`. Cheap, deterministic, but assumes `done_rounds` is stable across the batch (it is — no lane records until the barrier-adjacent record step, and the record step is where ids are assigned). **Risk:** if lanes record at slightly different engine `next_id`s, the *step_name* (cosmetic, used for idempotency keying and step dir) is offset-derived while the *node id* is engine-assigned-atomically — these can diverge, which is fine (step_name is a label, node id is the key) but must be consistent within a lane.
- **(b) Lane-tagged step names:** `step_name = f"step_{batch_index:04d}_lane_{laneId}"`. Unambiguous, never collides, and makes the idempotency key (`meta_info.step_name`, correctness §6.2) trivially lane-unique. The step dir is `steps/step_<batch>_lane_<k>/`.

**Recommendation: (b) lane-tagged step names.** The correctness slice's idempotency guard keys on `meta_info.step_name` (`_find_recorded_node_for_step`, `:186-191`); a lane-tagged name makes each lane's record independently idempotent (gate item 6) with zero ambiguity, and the engine assigns node ids atomically on `record` regardless of step_name (§8). Option (a)'s offset arithmetic is fragile under resume (a half-recorded batch changes `done_rounds`); (b) is resume-stable because `batch_index` (the monotonic counter, §6.3) and `laneId` are both durable.

### 7.3 Agent prompts hardcode `current/` — they MUST be lane-templated too (MUST-FIX-3)

This is a real gap the first draft missed. §6.2 lane-templates the *argv* of deterministic states (`laneTemplated(stateDef.run, lane)`), but the `researcher` and `analyzer` **agent prompts** embed literal `current/` paths in free text, which no argv-templating reaches. The `analyzer` prompt (`workflow.yaml:457-462`) directs the agent at three hardcoded paths: read `/workspace/.evolve_runs/main/current/context.json`, read `…/current/result.json`, write `…/current/analysis.md`. The `researcher` prompt similarly points at `current/` context. A lane running the unmodified prompt reads/writes the **shared** `current/`, so two lanes' `analyzer` agents both overwrite `current/analysis.md` — exactly the cross-lane clobber §7.1 claims to eliminate, but on the *agent* path, which §7.1 alone does not address. **The claim "agent prompts unchanged / reuses executors verbatim" was false and is retracted.**

**Resolution: the pump substitutes a per-lane path into the prompt before `executeAgentState`.** Two mechanisms; pick (a):

- **(a — CHOSEN) Prompt path templating.** Rewrite the manifest prompts to use a `{laneDir}` placeholder (e.g. `Read {laneDir}/context.json …`). The pump substitutes `{laneDir}` → `/workspace/.evolve_runs/main/current/lane_<k>` (or the bare `current` at `workers: 1`) via a new `promptOverride` parameter on `executeAgentState` (`driveLane` passes `laneTemplatePrompt(stateDef.prompt, lane)`, §6.2). This **does edit the manifest prompts** — which contradicts the original (shape-B) rationale for keeping prompts "unchanged"; under shape A the prompts are still authored in the manifest (house style preserved) but now carry a `{laneDir}` template the pump fills. The substitution is a pure string replace the pump owns; the domain content of the prompt is untouched.
- **(b — alternative) Lane-dir via env/context file.** Inject the lane dir as an env var or a small context file the agent is told to read, and rewrite the prompts to use a relative `current/` resolved against a lane-scoped working directory the session sets. More moving parts (the agent must be told to consult the env/file), and the session's working-directory plumbing is less direct than a prompt substitution. Noted, not chosen.

Either way the gate is the same: **a `workers: 3` run must show each lane's `analyzer` reading and writing its own `current/lane_<k>/analysis.md`, with no shared-`current/` agent writes.** Add this assertion to the Phase 4 integration test (§14).

### 7.4 Distinct parents per lane — greedy + N lanes is degenerate (MUST-FIX-2 / SHOULD-FIX-6)

§7's title says "distinct" but §7.1–7.3 only make *working dirs*, *step names*, and *prompt paths* distinct — **not the sampled parents.** With the default greedy sampler this wastes the parallelism: `GreedySampler.sample` is `sorted(nodes, key=score, reverse=True)[:n]` (`evolve_core/algorithms/greedy.py:13-17`), a pure function of DB state; `db.sample` reads under `_database_guard` but **does not mutate** (`database.py:53-54`, `:206-215`); and no lane records until the barrier-adjacent `analysis_record` (the doc *relies* on this for step-name stability, §7.2). So all N lanes calling `sample` within a batch reload the **same** `nodes.json` and draw the **same** top-N parents → near-duplicate candidates. The only divergence is then the researcher LLM's temperature — "N samples of one distribution," not an N-wide search frontier. This compounds §0's token-for-throughput problem.

**Resolution — two parts:**

1. **Reject `workers > 1` with `algorithm: greedy`** at validation time (a new validator rule, §4.3). Greedy is deterministic in DB state; concurrent greedy lanes are provably degenerate. Multi-lane runs must use a **stochastic** sampler (e.g. weighted/softmax), where a **per-lane sampler seed offset** (lane `k` seeds with `base_seed + k`) gives each lane a genuinely different parent draw while staying reproducible (extends the search-quality slice's `sampling_seed.txt` mechanism). This is the recommended discipline.
2. **OR** (a stronger guarantee, optional) **one barrier-side `sample(n = workers)` that partitions parents across lanes** — a single `db.sample` at fan-out hands lane `k` a *distinct* parent set, so even a greedy base is non-degenerate. Trade-off: this serializes the parent-selection step (a small cost at the fan-out boundary) and changes the sampler's contract (it now produces N disjoint sets, not N independent draws), which is a larger change to the search-quality sampler than the seed-offset approach. Noted; the seed-offset stochastic-sampler discipline (part 1) is the first cut.

**The honest statement:** the per-lane seed offset trades a little reproducibility nuance (each lane's draw depends on `base_seed + laneId`, so the *set* of parents explored per batch is seed+N-determined, not seed-alone) for genuine lane diversity — exactly the right trade for a search-frontier. Greedy + N is rejected, not silently degenerate.

### 7.5 Lane-state invisibility — the named costs of bypassing the actor (FSM review crux)

Lanes call `executeAgentState`/`executeDeterministicState` **directly**, bypassing the XState actor. The actor is half of a two-part mechanism (execute, then *assign back to FSM context* via entry/`updateContextFromAgentResult` actions); bypassing it keeps execute and drops assign. The FSM review's central correction: four FSM-owned mechanisms silently no-op per lane. For **each**, this slice either threads it manually in `driveLane` or documents the loss with its replacement bound:

| Mechanism | What breaks per lane | Resolution in this slice |
| --- | --- | --- |
| **Visit counts** (`incrementVisitCount` entry action, `machine-builder.ts:262`, assign `:604-608`) | Never increments for lane sub-steps — the pump bypasses the actor entry. | **Threaded manually:** `driveLane` increments `lane.visitCounts[stateId]` (§6.2, `LaneTraversal.visitCounts`). |
| **`maxVisits`** on `researcher`/`analyzer` (`workflow.yaml:420`, `:470`) | Dead per-lane (the guard reads `context.visitCounts`, which lanes never bump). | **Enforced manually** against `lane.visitCounts` in `driveLane`; exceeding it blocks the lane and trips the drain (§6.2, `lane_max_visits`). |
| **`isRoundLimitReached` / `maxRounds`** (`guards.ts:21-26`, `Math.max(visitCounts)`) | Counts **orchestrator (batch) entries only**, not lane-rounds — so `maxRounds` is now **N× looser** than the `workflow.yaml:10-19` comment assumes (lanes contribute *zero* FSM visits). | **WF013 is REVERSED** (§4.4): the original lint warned "scale `maxRounds` by N because lanes accrue visits N× faster" — the opposite of reality (lanes accrue *zero* visits). The corrected bound: `maxRounds` now caps **batches**, so the per-batch budget is `maxRounds` batches = `maxRounds × N` candidates; WF013 instead warns that `maxRounds` must account for the **candidate** budget being N× the batch budget, and per-lane `maxVisits` (threaded above) is the real per-lane bound. |
| **Per-lane context write-back** (`updateContextFromAgentResult`: `totalTokens`, `outputHash`/stall, `previousAgentOutput`) — `AgentInvokeResult` carries all of these (`machine-builder.ts:31-57`) | `driveLane` would read only `agentConversationId` and discard the rest → per-lane token budget + stall detection stop tracking inside a batch. | **Threaded manually:** `driveLane` accumulates `lane.totalTokens += res.totalTokens` and `lane.outputHashes.push(res.outputHash)` (§6.2). The batch's total tokens are summed at the join and written back to `ctx.totalTokens` once; per-lane stall detection uses `lane.outputHashes`. |

**The honest reframing the FSM review demanded, stated plainly:** *single-active-state is preserved by making lane state invisible to the FSM, at these named costs — visit counts, `maxVisits`, `maxRounds` semantics, and per-lane token/stall write-back all stop working automatically and are re-implemented per lane in the pump.* The doc does not present invisibility as free.

### 7.6 The record step assigns node ids atomically

Each lane writes its own step dir and calls `attach_analysis` (the durable record) independently. The engine's `add_with_previous_nodes` sets `node.id = self.next_id; self.next_id += 1` **inside `_database_guard`** (`database.py:67-74`, `:73-74`), which holds the cross-process `InterProcessFileLock` and reloads-inside-lock (`:207-215`). So N concurrent lane records each get a distinct, atomically-assigned node id — **no collision, no engine change** (§8). The lane's `step_name` is just the `meta_info` label; the id is engine-owned.

## 8. Container, policy, and DB concurrency

### 8.1 Shared container, N concurrent execs — bundle minted ONCE before fan-out

`evolve` is `sharedContainer: true` (`workflow.yaml:8`). All N lanes exec into the **one** bundle for the (single) `containerScope`. **Critically, that bundle is minted once by `runFanOutSegment` BEFORE the `Promise.all` (§6.2), not lazily by "the first lane."** The original "first lane mints, rest reuse" framing was unsafe: `ensureBundleForScope` is unguarded check-then-act across `await` points (`orchestrator.ts:838-839`, `:864`), and its own comment (`:820-824`) states concurrent lazy-mint races are unhandled — N lanes racing their first `container: true` step would each see `bundlesByScope.get(scope) === undefined` and mint a **separate** container, defeating `sharedContainer`. With the pre-fan-out single mint, the bundle exists before any lane runs; every lane's first `container: true` step hits `bundlesByScope.get(scope)` (`:838-839`) and reuses it. The N lanes are then N concurrent `bundle.docker.exec(bundle.containerId, …)` (`:2667`) into the same `containerId`, sharing `/workspace` (the host mount), so the engine DB at `.evolve_runs/main/database_data/` is shared. (Belt-and-braces: also add the in-flight-promise guard to `ensureBundleForScope` itself, §6.2.)

**Resource-model caveat — `:2667` is exactly where the off-mutex win can evaporate (§0.3).** "N concurrent execs into one container" overlaps only when the evals do not contend on a single shared scarce resource. For CPU-light/memory-bounded evals (the validation target, §14 OQ6) they overlap up to the container's core/RAM budget. For the GPU/TPU/memory-bound flagship domains (matmul kernels, FlashAttention tiling, TPU circuits) they **do not** — N evals serialize on one accelerator or OOM each other (`/tmp/alphaevolve.txt:2180`). The resource model that fixes this (per-lane cgroup/GPU isolation, N containers, or a host-side bounded eval queue) slots in **at this exec point** (`:2667`) without touching the FSM topology or the lane machinery (§6); it is the bridge to distributed evaluator scheduling and is out of scope for this sync slice. Cap N to the container's core/RAM budget (or the device count) until that resource model lands.

### 8.2 Single policy swap (homogeneity)

All lanes are `global` persona. `cyclePolicy` (`:988`) short-circuits when the bundle already has the persona loaded (`currentPersonaByBundle.get(bundle.bundleId) === persona`, `:994`). So the policy is loaded **once** (by the first lane's first agent state) and the other N-1 lanes hit the short-circuit — **no swap race**. The audit `persona` field (`audit.ts:46`) is single-valued and correct because there is only one persona. **This is why homogeneity is load-bearing:** a heterogeneous batch would need N policies on one coordinator concurrently, which the single `policyEngine` field (`tool-call-coordinator.ts:531`) cannot represent. Lane attribution comes from a **new lane-id**, not a persona change (§8.4).

### 8.3 The engine DB is already cross-process safe

Verified: every DB mutation goes through `_database_guard` (`database.py:207-215`), which takes the in-process `RLock` (`:208`) **and** the cross-process `InterProcessFileLock(self.lock_path)` (`:209`), reloads-from-disk inside the lock (`refresh=True` → `_load_locked`, `:210-211`), and saves atomically via `os.replace` of a temp file (`_save_locked`, `:162`). So concurrent lane `sample`s and `record`s from N separate `docker exec` Python processes are **already safe**: each sees a consistent reloaded view and writes atomically. `add_with_previous_nodes` assigns ids under this guard (`:67-74`). **No engine change.** (The test hook `EVOLVE_DB_TEST_HOLD_LOCK_MS`, `:212`, lets the concurrency test force lock contention deterministically — useful for gate item 2.)

### 8.4 Lane-id on audit entries

Add an optional `laneId?: number` to `AuditEntry` (`src/types/audit.ts:3-47`) for attribution. Because the persona is homogeneous, the lane-id is the only thing distinguishing N concurrent streams in the audit log. The coordinator stamps it the same way it stamps `persona` (from a per-call context the pump threads through `executeAgentState`'s `laneId`, §6.2). This is a **non-policy** attribution field — it changes nothing about evaluation, only audit readability. (Alternatively, encode the lane-id into the `requestId` prefix to avoid a schema field; the explicit field is cleaner for querying.)

## 9. Cognition store — serialize promotion at the barrier

The cognition store is **NOT** cross-process safe: in-process `RLock` only (`cognition.py:30`), non-atomic `json.dump` save (`:103-112`, `:111`), no file lock, no reload-before-save → last-writer-wins clobber. The search-quality slice's `attach_analysis` promotes the round's lesson via `_promote_lesson` (`evolve_result.py:407`; the `:436` line cited in the first draft is the idempotency-skip check *inside* it — CONSIDER-3 cite drift, corrected). Under N concurrent lanes, N concurrent promotions would clobber the store.

**Resolution for `workers > 1`: move cognition promotion OFF the per-lane record path and onto the serialized barrier join (single writer).** The pump's `joinBatch` (§6.2), which runs **after** the `Promise.all` barrier (so it is single-threaded by construction), promotes each recorded lane's lesson sequentially:

```ts
private async joinBatch(workflowId, lanes, drain): Promise<void> {
  // Single-writer, post-barrier: no concurrent cognition writes possible here.
  for (const lane of lanes) {
    if (lane.status !== 'recorded') continue;
    await this.promoteLaneCognition(workflowId, lane);   // evolve-cognition add, one at a time
  }
  await this.recomputeStopSignals(workflowId);           // ONE recompute over the N-grown nodes.json
}
```

Concretely, the bridge's per-lane `attach_analysis` is split: the **durable node record** (DB-safe, §8) stays in the per-lane record step; the **cognition promotion** (`_promote_lesson`, search-quality §4.5) moves to a new bridge subcommand `promote_cognition --lane <k>` that the pump calls *only at the join*, serially. The cognition-promoted ledger (`cognition_promoted.json`, search-quality §4.4) is read-modify-written by the single barrier writer, so the plain RMW is correct (no lock needed) — exactly the condition the search-quality slice noted (§4.5: "correct today because the FSM serializes (one writer)"). The barrier preserves that one-writer invariant.

**Stop signals are recomputed ONCE at the join** (`recomputeStopSignals`), over the `nodes.json` that grew by N, not per-lane. The orchestrator reads one fresh `stop_signals.json` per batch (correctness §5.1's post-record vantage, now post-*batch*).

**`workers: 1` MUST keep the legacy inline-promotion path (SHOULD-FIX-5).** The byte-identical no-op gate (item 1) is endangered if §9 *unconditionally* moves promotion to the join even at N=1. Today promotion is **inline** in `attach_analysis` (`evolve_result.py:804` via `_promote_lesson` `:407`): record + promote happen in one call. Moving promotion to a post-barrier `promote_cognition` reorders it to record → (return to FSM) → join-promote. Because cognition feeds the next round's researcher context (the sample step seeds cognition), a promotion-timing change is **observable downstream** and would break byte-identity. **Therefore: at `workers: 1` the pump takes the legacy inline-promotion path (promotion stays in `attach_analysis`); only `workers > 1` routes promotion to the barrier `joinBatch`.** Gate item 1 must run with a **non-empty cognition store** to actually exercise this — an empty store would mask a promotion-timing regression.

**Follow-up noted (not done here):** if a future async slice moves promotion off the barrier (per-record promotion), wrap the promotion + ledger RMW in an `InterProcessFileLock` (importable from the engine's `file_lock` module, `database.py:17`, **not** an engine edit). The bridge already has the import path. This is the async-extensibility hook (§13), deliberately deferred.

## 10. Escalation aggregation — preserve the single-gate model

A lane hitting `evaluator_blocked` (`evaluate`'s verdict, `workflow.yaml:444-445`) — or exceeding per-lane `maxVisits` (§7.5, `lane_max_visits`) — must **not** open a gate mid-batch. There is one `activeGateId` (`orchestrator.ts:2690`), and lanes have no FSM state to match a gate against (`handleGateEntry` is driven by `snapshot.matches(gateName)`, `:1934-1942`), so a per-lane gate is not merely discouraged, it is **unreachable** (CONSIDER C2 — this is why §4.3's "no human-gate inside the fan-out segment" rule is an **error**, not a warning). Resolution: **aggregate at the barrier**.

**Scope correction (do not over-claim):** drain-on-escalation is the **gate-aggregation** mechanism (collapse N potential blocks into one `activeGateId`). It is **NOT** the fix for the held-mutex escalation stall. That stall — an *agent-path policy escalation* awaiting inside the held `callMutex` — is cured separately by **releasing the call mutex across the escalation wait** (§5.2 item 1). The first draft conflated these and wrongly claimed drain "sidesteps the held-mutex stall entirely"; it does not, because the `evaluator_blocked` verdict that trips the drain runs **off-mutex** (`docker.exec`) and never held the mutex. The two mechanisms are now separate: §5.2 fixes the stall; §10 aggregates the gate.

### 10.1 Drain-on-escalation (the gate-aggregation mechanism — first cut)

- Any lane that hits `evaluator_blocked` **or** `lane_max_visits` **trips a batch-level drain flag** (`drain.tripped = true`, §6.2) and stops (`status: 'blocked'`).
- Other lanes **cooperatively check the drain flag** at each sub-chain step boundary (`if (drain.tripped) { lane.status = 'drained'; return; }`, §6.2). They finish their in-flight `docker.exec` (no mid-exec kill) and stop at the next boundary. In-flight records still commit idempotently (so the batch's partial progress is durable in the DB).
- The `Promise.all` barrier resolves (all lanes are `recorded`/`blocked`/`drained`).
- `batchVerdict` returns `{ verdict: 'escalate', items: [<blocked lanes>] }`. The FSM transitions `workers → human_escalation` (the orchestrator's existing `escalate` edge, `workflow.yaml:359-360`). **Exactly one** `human_escalation` gate opens (`handleGateEntry`, `:2685`; `activeGateId = gateRequest.gateId`, `:2690`), carrying the aggregated block reason(s) from all drained/blocked lanes.

This preserves the single-gate model: at most one gate, opened only at the barrier, never mid-lane.

### 10.2 The richer option (noted, not first cut)

A **queued/aggregated multi-item gate**: instead of draining the whole batch on the first block, let lanes that *can* finish do so, collect all blocked lanes, and present a multi-item gate ("3 of N lanes blocked: lane 0 …, lane 2 …"). This needs the gate DTO to carry a list of block items and the resume path to re-run only the blocked lanes. It is more efficient (non-blocked lanes' work is not discarded) but touches the gate surface (`activeGateId` is still single, but the gate *payload* grows). **Recommendation: drain-on-escalation first; the multi-item gate is a later enhancement** (§14 OQ3). Both preserve `activeGateId` as a single string — the difference is whether non-blocked lanes' in-flight work is kept.

### 10.3 Resume after escalation

After the human resolves the gate (`APPROVE` → `orchestrator`, or `FORCE_REVISION` → `preflight`), resume re-runs the drained batch (§11). Because records are idempotent (correctness §6.2) and DB-keyed (§8), the lanes that *did* record before the drain are skipped; the drained/blocked lanes re-run from `sample`. This is the same machinery as crash-resume.

## 11. Checkpoint / resume

The barrier is a clean single-active-state checkpoint boundary (§2.2). Between batches the FSM checkpoint is flat (`machineState: "orchestrator"` or `"workers"`). The hard case is a crash *mid-batch*. Resolution leans entirely on the shipped container-snapshot machinery + **DB-as-truth** (`workflow-container-snapshot-resume.md`): durable state lives outside the FSM (the engine DB on the host `/workspace` mount; container env in the snapshot), so resume = restore + re-run batch, with **no per-lane logical FSM-checkpoint surgery**.

### 11.1 The checkpoint shape for an in-flight batch (shape A makes resume work)

- **FSM checkpoint:** `machineState: "workers"` — a **real** state (shape A, §4.2). This is the load-bearing reason for shape A: resume does `definition.states[String(checkpoint.machineState)]` and reads `.type` (`orchestrator.ts:1558-1561`), which **only works if `workers` is a declared state.** XState's `resolveState` restores *to* `workers` but does not *enter* it (`:1554-1556`), so `replayInvokeForRestoredState` (`:1571`) re-runs the `workers` invoke — i.e. **re-runs `runFanOutSegment`**, reconstructing the full fan-out. Under the rejected shape B, `machineState` would be `sample` and resume would re-run one bare single-`current/` `sample` exec, not the fan-out (FSM review MF1).
- **Lane reconstruction is DB-derived, not `batch.json`-derived (SF3, §6.3):** on resume, `runFanOutSegment` reconstructs lanes purely from the engine DB — a lane whose `step_<batch_index>_lane_<k>` is already a recorded node (`_find_recorded_node_for_step`, `evolve_result.py:186-191`) is marked `recorded` and skipped; every other lane re-runs from `sample`. The engine DB is the sole authority. If an advisory `batch.json` exists it is never trusted over the DB (and may be absent or half-written from a crash mid-write — exactly the case DB-as-truth exists to ignore).

### 11.2 Why re-running the batch is safe (idempotency) — and what it can still change

The correctness slice made `analysis_record` idempotent (keyed on `meta_info.step_name`, `:732-733`, `:186-191`): re-recording a lane's step is a no-op that returns the existing node id. With lane-tagged step names (§7.2), each lane's record is independently idempotent. So re-running a partially-completed batch:

- re-runs `sample`/`researcher`/`evaluate` for every non-recorded lane (evals are idempotent — they recompute the same score for the same candidate),
- re-records nodes only for lanes that did not record before the crash (recorded lanes short-circuit),
- leaves **no duplicate nodes** (gate item 6).

The agent re-generation (researcher/analyzer re-run produce a *fresh* candidate, possibly different from the pre-crash one) is **acceptable for node-set integrity**: a crashed lane had no recorded node, so its pre-crash candidate was never durable. (Fully reproducible re-generation would require persisting the agent's output per lane before record — out of scope.)

**But resume can change a batch's VERDICT, not just its node set (SHOULD-FIX-11 / FSM review SF4).** A re-run lane generates a *fresh* candidate; if that fresh candidate hits `evaluator_blocked` where the pre-crash one would not have (or vice-versa), the resumed batch **drains and escalates even though the pre-crash batch would not have** (or escalates differently). The `Promise.all` barrier only resolves when all lanes reach `recorded`/`drained`, so one re-run lane's different verdict flips the whole batch outcome. **Consequence stated plainly:** gate item 6 ("no duplicate nodes") still passes while the batch *verdict* silently differs run-to-run across a resume. This is a correctness-of-batch-outcome drift, not a node-integrity bug. If batch-verdict stability matters for a given run, the pre-crash candidate must be persisted per lane before record — explicitly out of scope here, but the drift consequence is now on the record.

### 11.3 Container restore

Resume mints a fresh container (lazy, `orchestrator.ts:1527-1531`) and, when the checkpoint carries snapshot digests, restores them by immutable digest (`workflow-container-snapshot-resume.md`). The `/workspace` mount (DB) is reattached, so durable state survives. **The bundle is re-minted once by `runFanOutSegment`'s pre-fan-out `ensureBundleForScope` (§6.2/§8.1), before any lane re-execs** — the same mint-before-fan-out discipline as a fresh start, so the resume path also avoids the N-container mint race. No per-lane container state exists (lanes share one container), so there is nothing lane-specific to restore beyond the shared workspace.

## 12. Reproducibility

The search-quality slice added seeded samplers (`sampling_seed.txt`) for reproducibility. Concurrent lanes make **DB-write order timing-dependent**: if two lanes record at nondeterministic relative times, their node ids (engine-assigned in lock-acquire order, `database.py:73-74`) and thus the `nodes.json` ordering can differ run-to-run.

**For sync, the mitigation is: serialize the DB-mutating critical section (`sample` parent-selection + `record`) through a deterministic order at the join, while `design`/`eval` run in parallel.** Two grades:

- **(a) Parallel everything, accept id-order nondeterminism.** Let all N lanes record concurrently (DB-safe, §8); accept that node ids 21/22/23 may be assigned to lanes 0/1/2 in any order across runs. The *set* of nodes is deterministic (same candidates, same scores, given seeds); only the id↔lane assignment varies. Cheapest; reproducible at the *population* level, not the *id-ordering* level.
- **(b) Serialize sample+record in lane order at the barrier-adjacent steps.** Run `researcher`/`evaluate`/`analyzer` (the expensive, parallelizable work) concurrently, but funnel the `sample` parent-selection and the `record` node-append through a **lane-ordered critical section** (lane 0 records before lane 1, etc.) so node ids are assigned in lane order deterministically. This keeps `design`/`eval` parallel (the speedup) while making DB-mutation order deterministic (the reproducibility).

**Recommendation: state the trade-off, default to (a), offer (b) under a `reproducible: true` flag.** (a) gives the full parallel speedup; (b) costs a serialization point at the join but gives byte-identical id-ordering across runs — valuable for CI/regression gates. The `workers: 1` backward-compat gate (item 1) is unaffected either way (one lane = no ordering question).

**Honest reproducibility statement — narrowed (SHOULD-FIX-3).** The first draft over-claimed "reproducible as a population (same nodes, same best score, given seeds)." That is wrong in two ways: (1) **candidate *content* is not reproducible in either the linear OR the parallel chain** — the agents (researcher/analyzer) are LLM calls and are not seeded; `PYTHONHASHSEED=0` (`evolve_result.py:17`) seeds `hash()` only, not the LLM and not Python `random`. The search-quality slice's `sampling_seed.txt` makes only the **sampler's parent selection** reproducible, never the candidates. (2) **Resume re-generation makes a resumed run diverge from a clean run regardless of N** (§11.2). So the correct, narrow claim is:

- The **sampler's parent selection** is reproducible given seeds (and, with the per-lane seed offset of §7.4, lane-diverse-but-seed-determined).
- **Candidate content is not reproducible** in either the linear or parallel chain (LLM nondeterminism). The parallel slice does not *break* a reproducibility the linear chain had — it inherits a claim that was only ever about the *sampler*.
- `reproducible: true` (option b) buys byte-identical **id-ordering** (which lane's candidate gets which node id), **not** byte-identical *candidates*. Say so on the gate.

## 13. Async-extensibility — what stays, what changes

**Sync is genuinely a stepping stone for these domains, not the end state.** AlphaEvolve is async *by construction*: its pipeline is *"an asynchronous computational pipeline … many computations are run concurrently, with each computation blocking whenever its next step relies on the result of another, yet unfinished computation … optimized for throughput (rather than the speed of any one particular computation)"* (`/tmp/alphaevolve.txt:455-462`), and evaluation is distributed via *"asynchronous calls to an evaluation cluster"* (`:425-426`). The hard `Promise.all` barrier this slice adopts pays a straggler tax every batch (§0.1 fact 3), and that tax is **large** for the target domains precisely because real evaluation is high-variance — cascade evaluation prunes weak candidates fast while survivors run orders of magnitude longer (ASI-Evolve v2's 300s eval / 1800s engineer timeouts, `config.yaml:20`,`:61`, are the order-of-magnitude spread). **The straggler tax is acceptable for this slice only because the chosen validation domain (§14 OQ6, the LLM-serving scheduler) has *bounded* eval variance** — a fixed-trace simulation whose per-candidate runtime spread is narrow. For the truly high-variance flagship domains, the async follow-up (which overlaps the straggler with other lanes' next candidates) is where the throughput win is fully realized; sync establishes the lane machinery, the resource-model hook (§0.3), and the DB/cognition safety that async reuses. The N-lane machinery is shaped so async is a **later additive step, not a rewrite**. The async follow-up (controller-tick-on-record + bounded pool + drain flag) reuses:

| Piece | Sync (this slice) | Async (later, additive) |
| --- | --- | --- |
| `LaneTraversal` objects (§6.1) | N lanes, all run to barrier | Same objects; pool launches lane K+1 when a slot frees |
| `driveLane` per-lane pump (§6.2) | Called N× under one `Promise.all` | Called under a bounded-pool scheduler; same body |
| `current/lane_<k>/` working areas (§7) | N fixed lanes | Same; pool reuses a freed lane's dir |
| Lane-tagged step names (§7.2) | `step_<batch>_lane_<k>` | Same; `batch` becomes a logical tick id |
| DB cross-process safety (§8) | Already safe | Already safe — no change |
| Cognition promotion (§9) | Serialized at barrier (single writer); inline at `workers:1` | Per-record promotion + `InterProcessFileLock` (the deferred hook, §9) |
| Drain flag (§10) | Trips on `evaluator_blocked` / `lane_max_visits`, drains batch | Trips on any escalation; pool stops launching, aggregates |
| DB-derived lane reconstruction (§6.3/§11.1) | From recorded `step_<batch>_lane_<k>` nodes | Same; `batch` becomes a logical tick id |
| Mutex-release escalation fix (§5.2) | Releases `callMutex` across human wait | Reused unchanged — now N escalations can be live |
| Resource model at the `evaluate` exec point (§0.3) | Shared container suffices for CPU+memory-bound eval (option 0) | The bounded eval queue / per-lane device isolation IS the on-ramp to the paper's distributed evaluator cluster (`:455-462`) |
| Barrier (`Promise.all`) | Hard join per batch | Replaced by controller-tick-on-record (the one structural change) |

The **only** structural change async requires is replacing the `Promise.all` barrier with a controller that ticks on each record and a bounded pool that backfills lanes — everything else (lane objects, per-lane working areas, step naming, DB safety, drain, DB-derived lane reconstruction, and the §0.3 resource-model hook) is reused. The cognition `InterProcessFileLock` and the per-record stop-signal recompute are the two bridge-side additions, both engine-untouched. **This is the explicit promise: sync is not a dead end** — and §0.3's resource model (per-lane device isolation / bounded eval queue) is the same hook that async needs to reach the paper's distributed evaluator cluster for the GPU/TPU domains.

## 14. Phased implementation checklist (small, gated steps — coordinator audit FIRST)

Each phase is independently testable and gated; later phases do not land until earlier gates pass.

- **Phase 0 — Coordinator concurrency audit + the in-scope kernel fixes (THE gate-keeper, §5).**
  - [ ] **Establish the speedup baseline (§0).** Measure the per-round tool-call fraction and evaluator-cost fraction for the evolve researcher/analyzer agents on a representative domain. This grounds §0's Amdahl model — it is an *unmeasured assumption* until this lands. The speedup-demo target is **ASI-Evolve's LLM-serving scheduler** (§14 OQ6, resolved): slow-eval AND CPU+memory-bound, so it overlaps in the single shared container without GPU isolation. Cap N (or set per-lane cgroup limits, §0.3 option 1) so a fat-memory lane cannot OOM peers. Circle-packing is the `workers:1` fixture, not the demo. **Do NOT pick a GPU/TPU-bound domain (matmul kernels, FlashAttention tiling, TPU circuits) for this baseline — those need §0.3's resource model first and would measure contention, not overlap.**
  - [ ] Write the concurrency test (gate item 4): N concurrent `handleStructuredToolCall` streams through one coordinator; assert no torn audit entries, correct breaker counts, FIFO ordering. Use `EVOLVE_DB_TEST_HOLD_LOCK_MS` (`database.py:212`) where DB contention is needed.
  - [ ] **Land the mutex-release escalation fix (§5.2 item 1) — IN SCOPE, not deferred.** Confirmed: the escalation await is inside `callMutex.withLock` (`tool-call-coordinator.ts:310-313`/`:348-357`; awaits at `tool-call-pipeline.ts:821`/`:866`/`:881`). Release the mutex across the human wait (acquire → evaluate → if escalate, release, await, re-acquire to finish). Without it, N>1 with an escalation-prone persona latency-cliffs the whole batch on one agent-path escalation.
  - [ ] **Make the circuit-breaker window `workers`-aware by default** when `workers > 1` (§5.2 item 3) — a correctness fix, not optional config.
  - [ ] Audit AutoApprover (now potentially N-concurrent with the mutex fix) + ServerContextMap (§5.2).
  - [ ] **Decision gate:** if the mutex-release change surfaces a non-reentrancy bug the FIFO mutex does not cover, either land the kernel fix here or **gate N>1 to non-agent-escalating personas** and document it. Do not ship a silent latency cliff.
- **Phase 1 — Lane discipline in the bridge (engine-untouched, no FSM change yet).**
  - [ ] Add `--lane <k>` / `EVOLVE_LANE` to bridge subcommands; route `_current_dir(run_dir, lane)` to `current/lane_<k>/` (§7.1). Keep `stop_signals.json` shared/barrier-owned (SHOULD-FIX-1).
  - [ ] Lane-tagged step names `step_<batch_index>_lane_<k>` (§7.2); confirm idempotency guard keys on them (`evolve_result.py:186-191`).
  - [ ] Unit-test: two concurrent bridge `record`s with distinct lanes append two distinct nodes (`EVOLVE_DB_TEST_HOLD_LOCK_MS`, `database.py:212`). Assert the lane-templated `resultFile` passes the host-side containment checks (SF2).
- **Phase 2 — Manifest schema + validator + linter (§4).**
  - [ ] **Add the new keys to the Zod schemas AND `types.ts` interfaces** (`settings.workers`, `workers`-state `fanOut`/`segment`, `fanOutMember`) — they are silently stripped otherwise (SF1). Delete the dead `maxParallelism`/`PARALLEL_*` graveyard (§4.5).
  - [ ] Validator rules (§4.3): positive `workers`; no gate inside segment (**error**, C2); reject `workers>1` + greedy (MUST-FIX-2); lane-scoped `resultFile`. Linter `WF013` (REVERSED, §7.5) / `WF014`.
  - [ ] `tsx src/cli.ts workflow lint … --strict` clean on the `workers: 1` manifest (gate item 7).
- **Phase 3 — The fan-out pump (§6), shape A, `workers: 1` first (no-op gate).**
  - [ ] Add the real `workers` state (shape A, §4.2); register `runFanOutSegment` in `provideActors` (`orchestrator.ts:1840-1858`); re-point `design → workers`.
  - [ ] `runFanOutSegment` + `driveLane` + `LaneTraversal` (§6.1-6.2), including the **mint-before-fan-out** `ensureBundleForScope` (MUST-FIX-2) and the per-lane visit-count/token/stall write-backs (§7.5).
  - [ ] **`workers: 1` keeps the legacy inline cognition-promotion path** (SHOULD-FIX-5); run gate item 1 against a **non-empty** cognition store.
  - [ ] **Gate item 1:** `workers: 1` produces byte-identical `nodes.json` (modulo `created_at`) to the pre-slice chain. The pump with N=1 must be a perfect no-op.
- **Phase 4 — N>1 fan-out + barrier join + per-lane prompt/parent diversity.**
  - [ ] `Promise.all` barrier; `joinBatch` (§6.2). DB-derived lane reconstruction (§6.3, no load-bearing `batch.json`).
  - [ ] **Lane-template the agent prompts** (`{laneDir}` substitution, §7.3) — assert each lane's `analyzer` reads/writes its own `current/lane_<k>/analysis.md`, no shared-`current/` agent writes.
  - [ ] **Per-lane parent diversity** (per-lane sampler seed offset, §7.4) — assert lanes draw distinct parents under a stochastic sampler.
  - [ ] **Gate items 2 & 3:** `workers: 3` records 3 distinct nodes per batch; orchestrator entered once per batch.
- **Phase 5 — Serialized cognition promotion at the barrier (§9, `workers > 1` only).**
  - [ ] Split `attach_analysis`: durable record per-lane; cognition promotion → `promote_cognition` called serially at the join (inline path retained at `workers:1`).
  - [ ] One stop-signal recompute per batch over the N-grown `nodes.json`, into the shared `current/stop_signals.json`.
- **Phase 6 — Aggregated escalation drain (§10).**
  - [ ] Drain flag on `evaluator_blocked` **and** `lane_max_visits`; cooperative drain checks; one aggregated `human_escalation` gate (single `activeGateId`).
  - [ ] **Gate item 5:** `workers: 3` with one blocked lane opens exactly one gate.
- **Phase 7 — Resume (§11).**
  - [ ] `restoreOrCreateLanes` reconstructs lanes purely from the DB (recorded `step_<batch>_lane_<k>` lookup); re-mint bundle once before re-fan-out.
  - [ ] **Gate item 6:** simulated mid-batch crash + resume leaves no duplicate nodes. Document that resume can change a batch *verdict* (§11.2, SF4).
- **Phase 8 — Reproducibility knob (§12, optional `reproducible: true`).**
  - [ ] Default (a) sampler-reproducible (NOT candidate-reproducible, §12); `reproducible: true` → lane-ordered record critical section for byte-identical id-ordering.

## 15. The gate (binary) — restated

The completion gate proves: (1) `workers: 1` byte-identical no-op (against a **non-empty cognition store**, SHOULD-FIX-5); (2) N lanes → N nodes/batch, distinct step names, **distinct parents** (§7.4) and **distinct per-lane agent paths** (§7.3); (3) barrier joins (orchestrator entered once per batch); (4) coordinator survives N concurrent streams (no torn audit, correct breaker) **and an agent-path escalation does not freeze other lanes** (the mutex-release fix, §5.2); (5) one aggregated escalation gate; (6) resume re-runs batch idempotently, no dup nodes (verdict may differ, §11.2); (7) `--strict` lint clean + existing evolve gates pass.

## 16. Open questions for the human

1. **`settings.workers` literal vs `preflight`-authored (§4.1).** First cut: `settings` literal. Should `preflight` infer `workers` from the experiment's `config.yaml` `num_workers` (like `sample_n`), making it per-run? Leaning literal-first.
2. **Step-name scheme (§7.2): lane-tagged (`step_<batch>_lane_<k>`) vs offset.** Recommending lane-tagged for resume-stable idempotency. Confirm — it changes the `step_name` format users see in step dirs.
3. **Escalation gate: drain-on-escalation (§10.1) vs multi-item gate (§10.2).** Recommending drain-first (discards non-blocked lanes' in-flight work). Note this is *separate* from the mutex-release stall fix (§5.2), which is in-scope regardless. Is the wasted work acceptable, or is the multi-item gate worth the gate-surface change now?
4. **Reproducibility default (§12): sampler-reproducible (a) vs byte-identical id-ordering (b).** Recommending (a) default + `reproducible: true` for (b). Note neither makes *candidates* reproducible (LLM nondeterminism). Does any CI/regression gate need byte-identical id-ordering by default?
5. **Parent-diversity discipline (§7.4): per-lane seed offset (recommended) vs barrier-side partitioning `sample(n=workers)`.** The seed offset is the smaller change but ties each lane's draw to `base_seed + laneId`; partitioning guarantees disjoint sets even for a greedy base but changes the sampler contract. Confirm seed-offset-first.
6. **(RESOLVED) The slow-eval-domain demo (§0).** Circle-packing is the `workers:1` fixture, not the speedup demo. **Validation target: ASI-Evolve's own LLM-serving / inference-throughput scheduler** (`README.md:85-203`) — or a Borg-style scheduler simulation (`/tmp/alphaevolve.txt:1167-1181`). This is the one heavy-hitter class that is **slow-eval AND CPU+memory-bound**: its evaluator runs a serving-throughput simulation over a fixed request trace (`README.md:181`, `run_serving_simulation(scheduler_fn, trace=…)`), so N concurrent evals genuinely overlap in the single shared container (§8) **without GPU/TPU isolation**. Caveats stated on the validation plan: (a) it overlaps only up to the container's core/RAM budget — cap N or set per-lane cgroup limits so a fat-memory lane cannot OOM peers (§0.3 option 1); (b) it does **NOT** generalize to the GPU/TPU flagship domains (matmul kernels, FlashAttention tiling, TPU circuits), which require the resource model in §0.3 before the technique delivers there. The remaining open part is only `settings.workers` literal-vs-preflight authoring (leaning literal-first, OQ1).
7. **Coordinator outcome (§5, Phase 0).** If the mutex-release fix surfaces a non-reentrancy bug beyond the FIFO mutex's coverage, do we harden the kernel here, or gate N>1 to non-agent-escalating personas and split the kernel work out?

**Resolved (no longer open):** manifest topology is **shape A** (a real `workers` state) — required for resume, not optional (MF1). The agent-path escalation stall is fixed by **releasing the call mutex across the human wait** (§5.2), in-scope — not "sidestepped by drain." The **speedup-validation domain** is ASI-Evolve's LLM-serving scheduler (OQ6, §0.3 / §14) — slow-eval AND CPU+memory-bound, so it overlaps in one shared container; the GPU/TPU flagship domains are explicitly deferred behind §0.3's resource model.

## 17. Code references (verified against the current tree)

**Single-active-state spine (the constraint):**
- `orchestrator.ts:1873` — `String(snapshot.value)` (the one line that forbids `type:'parallel'`).
- `orchestrator.ts:1916`, `:1510` — single `instance.currentState`.
- `orchestrator.ts:1890-1897` — flat `transitionHistory` push (single-active-state).
- `orchestrator.ts:2690` — single `instance.activeGateId`.
- `orchestrator.ts:994`, `:1037` — single `currentPersonaByBundle` per bundle.
- `orchestrator.ts:1970` — `isTerminalStateValue` assumes stateValue names one state.

**The manual pump (the mechanism we extend):**
- `orchestrator.ts:1554-1562`, `:1571-1608` — `replayInvokeForRestoredState`; `:1558-1561` reads `definition.states[machineState].type` (shape-A requirement, MF1).
- `orchestrator.ts:1840-1858` — `agentService`/`deterministicService` `fromPromise` actors (where the `workers`-state invoke `runFanOutSegment` registers).
- `orchestrator.ts:1586-1595` — the per-state executors the pump reuses (the EXECUTE half; the actor's ASSIGN half is re-done per lane, §7.5).
- `orchestrator.ts:2537-2606` — `applyResultFile` (host-side read of `input.resultFile`; containment at `:2552-2564`; `result_file_error` at `:2566-2568`) — SF2.
- `orchestrator.ts:2615-2641` — `reduceDeterministicCommands` serial `for` (per-lane, not cross-lane — FSM review C4 confirms).
- `orchestrator.ts:2667` — `bundle.docker.exec(bundle.containerId, …)` (the N-concurrent-exec point).
- `orchestrator.ts:838-839`, `:864`, `:820-824` — `ensureBundleForScope` UNGUARDED check-then-act + its own "add an in-flight-promise guard" comment (MF2 / MUST-FIX-2 — mint once before fan-out).
- `machine-builder.ts:262`, `:604-608` — `incrementVisitCount` entry action (does NOT fire for lanes, §7.5).
- `machine-builder.ts:31-57` — `AgentInvokeResult` (`totalTokens`/`outputHash`/… discarded if the pump bypasses `updateContextFromAgentResult`, §7.5).
- `guards.ts:21-26` — `isRoundLimitReached` (`Math.max(visitCounts)`; counts batches not lane-rounds → WF013 reversed, §7.5).
- `types.ts:617-625` — `TransitionRecord` (no `laneId`; per-lane observability loss, C1).

**Coordinator concurrency (the risk + the in-scope fix):**
- `tool-call-coordinator.ts:132-133` — `policyMutex` + `callMutex`.
- `tool-call-coordinator.ts:310-313`, `:348-357` — `handleToolCall`/`handleStructuredToolCall` whole body under `callMutex`.
- `tool-call-pipeline.ts:821` (`autoApprove`), `:866` (`onEscalation`), `:881` (`waitForEscalationDecision`) — the escalation awaits, INSIDE the held mutex (MUST-FIX-4 / MF3 — release the mutex across these, §5.2).
- `src/trusted-process/async-mutex.ts:13`, `:15`, `:18`, `:42-49` — FIFO fairness, non-reentrant, `waitTail` chain, `withLock` (note the `src/trusted-process/` prefix — first draft cited a bare path).
- `audit.ts:3-47` — `AuditEntry` (add `laneId`); `:46` `persona` (single-valued, homogeneous).

**Engine concurrency (already safe / the cognition gap):**
- `database.py:207-215` — `_database_guard` (RLock + `InterProcessFileLock` + reload-inside-lock).
- `database.py:53-54`, `:206-215` — `db.sample` reads under guard but does NOT mutate (greedy lanes draw identical parents, §7.4 / MUST-FIX-2).
- `evolve_core/algorithms/greedy.py:13-17` — `GreedySampler.sample` is a pure function of DB state (the degeneracy source).
- `database.py:67-74` — `add_with_previous_nodes` atomic id assignment.
- `database.py:162` — atomic `os.replace` save; `:212` `EVOLVE_DB_TEST_HOLD_LOCK_MS` test hook.
- `cognition.py:30`, `:103-112` — in-proc RLock only, non-atomic `json.dump`, no file lock (the serialize-at-barrier reason).

**The bridge / manifest (lane discipline):**
- `evolve_result.py:54-55` — `_current_dir` (gains lane param).
- `evolve_result.py:58-72` — `_clear_current_round` (per-lane scratch list; `stop_signals.json` at `:69` stays SHARED, SHOULD-FIX-1).
- `evolve_result.py:328`, `:747`, `:800` — `stop_signals.json` written to the bare `current/` (shared, barrier-owned).
- `evolve_result.py:575-576` — `step_name = f"step_{done_rounds + 1:04d}"` (the collision; → lane-tagged).
- `evolve_result.py:186-191`, `:732-733` — `_find_recorded_node_for_step` idempotency guard (keyed on lane-tagged step_name).
- `evolve_result.py:407` — `_promote_lesson` cognition promotion (`:436` is the idempotency-skip INSIDE it — CONSIDER-3); `:804` inline call from `attach_analysis` (legacy path kept at `workers:1`, SHOULD-FIX-5).
- `workflow.yaml:303-360` — orchestrator hub; `design → sample` edge at `:353-354` (re-pointed to `workers`).
- `workflow.yaml:362-503` — the spoke states (now declared `fanOutMember`, driven by the pump).
- `workflow.yaml:444-445` — `evaluator_blocked → human_escalation` (the `when:` is `:445`; CONSIDER-3); `:359-360` orchestrator's own `escalate → human_escalation`.
- `workflow.yaml:457-462` — `analyzer` prompt's hardcoded `current/` paths (MUST-FIX-3, lane-template via `{laneDir}`).
- `workflow.yaml:420`, `:470` — `researcher`/`analyzer` `maxVisits: 3` (dead per-lane unless threaded, §7.5).
- `workflow.yaml:8` — `sharedContainer: true`; `:20` — `maxRounds: 200` (now caps batches, §7.5).

**Validator / linter / schema:**
- `validate.ts:103-117` (`workflowSettingsSchema`), `:54-68` (`agentStateSchema`), `:78-87` (`deterministicStateSchema`), `:33-38` (`agentTransitionSchema`) — all default `.strip()`; new keys must be added or stripped (SF1).
- `validate.ts:109` / `types.ts:115` — dead `maxParallelism` (delete, §4.5); `types.ts:435-436`/`:458`/`:459` — `PARALLEL_*`/`parallelResults`/`worktreeBranches` graveyard.
- `types.ts:105-157` — `WorkflowSettings` (gains `workers`); `:267-296` — `DeterministicStateDefinition` (gains `fanOut`/`segment`/`fanOutMember`).
- `lint.ts:43-45` — retired WF005 / `parallelKey` (graveyard); `:284` WF006 (backstop); `:430` WF011 (container scope).

**External sources (the real-world target-domain analysis, §0 / §0.3 / §13 / §14 OQ6):**
- `/tmp/alphaevolve.txt:420-426` — ~100 compute-hours per evaluation; *"unless individual evaluations are parallelized … embarrassingly parallel … asynchronous calls to an evaluation cluster"* (the thesis, verbatim).
- `/tmp/alphaevolve.txt:84` — Table 1: FunSearch *"needs fast evaluation (≤20min on 1 CPU)"* vs AlphaEvolve *"can evaluate for hours, in parallel, on accelerators"* (circle-packing = fast-eval regression fixture; slow-eval = operating regime).
- `/tmp/alphaevolve.txt:2180` — the resource smoking gun: *"1000 random seeds on evaluators with a single GPU accelerator, we often run out of memory"* (§0.3 — N execs in one container do not overlap on a GPU).
- `/tmp/alphaevolve.txt:123-124` — flagship GPU/TPU-bound domains: matmul kernels for training LLMs, TPU arithmetic circuits, attention runtime.
- `/tmp/alphaevolve.txt:1235-1239` — FlashAttention/Pallas tiling minimized on *real TPU accelerators* (score = wall-clock runtime → co-located evals corrupt timing, §0.3).
- `/tmp/alphaevolve.txt:455-462` — async-by-construction pipeline: controller + LLM samplers + evaluation **nodes**, *"optimized for throughput rather than the speed of any one particular computation"* (§13 stepping-stone; §0.3 evaluator fleet).
- `/tmp/alphaevolve.txt:1167-1181` — Borg-style scheduler study: candidates scored against *"snapshots of workloads and capacity across Google's fleet"* (alt CPU-bound validation target, §14 OQ6).
- `donotcommit/ASI-Evolve/README.md:85-203` — LLM-serving / inference-throughput scheduler walkthrough (the validation target, §14 OQ6); `:181` `run_serving_simulation(scheduler_fn, trace=…)` — fixed-trace simulation → CPU+memory-bound, bounded eval variance.
- `donotcommit/ASI-Evolve/config.yaml:44-49` — diff-based evolution (think-then-write-one-diff → small tool-call footprint, §0.1 fact 1); `:20`,`:61` — 300s eval / 1800s engineer timeouts (high eval variance → straggler tax, §0.1 fact 3 / §13); `:64-68` — `num_workers` (2–4 production).
