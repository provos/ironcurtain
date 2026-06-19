# Evolve Target Workloads — Validation Fixture & First Dogfood (vetted)

Status: **Vetted research record** (2026-06-19). Produced by a supervised research → adversarial-vetting loop (two research agents, two adversarial vetters). Every load-bearing claim below survived an independent verification pass; the claims that did **not** survive are listed in §4 so the corrections are traceable.

## Purpose

Two questions, both gating the [sync-parallelism slice](./evolve-sync-parallelism-slice.md):

1. **A validation fixture** to *prove the design* — a slow, CPU/memory-bound, **no-GPU**, canonical evolve experiment where N-way parallelism gives a real wall-clock win (circle-packing is too fast; it's the `workers:1` regression fixture, not a speedup demo — §0 of the slice).
2. **A first dogfood target inside IronCurtain** — a self-contained component that would genuinely benefit from ASI-Evolve, with an evaluator that runs as **pure code, no Docker** (this stage cannot take a Docker dependency yet).

---

## 1. Validation fixture — FunSearch `admissible_set` (symmetric variant)

**Recommendation: vendor FunSearch's `admissible_set` evaluator (symmetric variant), run at `I(21,15)` as the slow speedup demo and `I(15,10)` as a fast smoke test.** Source: DeepMind `google-deepmind/funsearch`, `admissible_set/admissible_set.ipynb` (Nature 2023, "Mathematical discoveries from program search with large language models").

It is the only candidate that is simultaneously **canonical + reproducible + pure-CPU/no-GPU + genuinely slow with a tunable cost dial**, and — verified by running the actual `solve` loops — **barrier-friendly** (see the variance note, which is the decisive property).

### What it is
The evolved program is a heuristic `priority(el, n, w) -> float`. `solve(n, w)` enumerates the candidate space in-process from `(n, w)` via `itertools.product`, greedily adds the highest-`priority` vector while blocking every vector it rules out, then expands by rotations to the full admissible set. `evaluate` returns a scalar — the **size of the admissible set** (larger = better; lower-bounds the cap-set capacity). Maps cleanly onto our `evaluate(program) -> {scalar}` contract, identical in shape to circle-packing's evaluator, so the bridge (`evolve_result.py`) needs no change.

### Why it fits, point by point (verified)

| Axis | Vetted finding |
|---|---|
| **GPU-free / deps** | **Pure `import itertools, math, numpy`** — *lighter* than circle-packing (no scipy), no torch/JAX/CUDA anywhere in the repo. Hard no-GPU requirement satisfied. |
| **Slow, with a dial** | Per-candidate cost is set by `(n, w)`. Verified measurements (symmetric variant): **`I(15,10)` ≈ sub-second–~1 s** (smoke test); **`I(21,15)` ≈ minutes–~15 min** (the speedup demo). The published "≈1 min" figure belongs to `I(12,7)`, **not** `I(15,10)` — do not cite it for I(15,10). **Drop `I(24,17)`**: DeepMind's ~7 h figure required a **C++** reimplementation of the inner loop; the pure-numpy version you'd vendor is slower and exceeds practical timeouts. |
| **Variance / barrier-suitability** | Eval time is **NOT bounded-variance** — it varies ~2× and **correlates with candidate quality**. The direction is variant-dependent, and this is the load-bearing reason to pick the **symmetric** variant: in it, a *better* `priority` makes the inner `get_surviving_children` prune aggressively and finish **faster**, so under the hard sync barrier the straggler lane is the **low-quality, doomed** candidate — the tax falls on lanes you'd discard anyway. (The *unrestricted* variant inverts this — better = more work = slower = **barrier-hostile**; do **not** vendor that one.) The symmetric variant being barrier-friendly is a *point in favor* of this fixture, not a caveat. |
| **Reproducible / target** | Canonical DeepMind reference code + Nature 2023 + published set sizes per `(n, w)`. **No external dataset** — the candidate space is generated in-process from `(n, w)`. |

### Setup sketch (maps onto `run_spec` + `evaluator.py` + `eval.sh`)
- `input.md`: "Evolve a `priority(el, n, w)` to maximize the admissible-set size for `I(n, w)`."
- `initial_program`: a trivial `priority` (e.g. `return 0.0`) → a deliberately low starting score so evolution has headroom.
- `evaluator.py`: vendor the **symmetric** `solve(n, w)` (greedy + `get_surviving_children` + rotation expansion); `evaluate` returns `{"eval_score": float(set_size), "target_ratio": set_size / TARGET, "validity": 1.0, "eval_time": t}` — same shape circle-packing already emits.
- `eval.sh`: identical wrapper to circle-packing's (`python3 evaluator.py "$1" "$2"`).
- `success_criteria` target: the published size for the chosen `(n, w)`.
- `num_workers`: 3–4; at `I(21,15)` (minutes-scale eval) the off-mutex evaluator overlap dominates and the wall-clock speedup approaches `N / straggler_inflation`.
- **Resource model:** pure CPU → overlaps as N `docker exec` in the one shared container (`sharedContainer: true`), the exact regime §0.3 says the shared-container model suffices for. Set per-lane `--cpus`/`--memory` caps; **no GPU isolation needed**.

### Honest risks
- **Port is ~90 lines** (symmetric variant), not the ~40 of the unrestricted one — it drags in `get_surviving_children` (the 36-entry `bad_triples` table), `expand_admissible_set` (rotation expansion), and the `num_groups = n//3` constraint. Vendorable numpy, no FunSearch framework (the `@funsearch` decorators are inert comments), but a real port.
- Per-candidate cost is candidate- *and* machine-dependent; treat the timings as order-of-magnitude per *good* candidate and size `(n, w)` empirically on the target host.
- Raise the engine/eval timeouts to match the chosen `(n, w)` (`config.yaml` `timeout: 300`, `engineer_timeout: 1800`) and set per-lane `--memory` caps (a large set at high `(n, w)` grows memory).
- It is a *combinatorial-search* eval, not a *simulation-over-a-trace*. If we specifically want to exercise the "simulation over a request trace" shape, the runner-up (below) is the structural analogue — at the cost of sourcing a trace and writing a simulator.

### Runner-up (only if a trace-simulation shape is specifically wanted)
**AlphaEvolve data-center scheduling = online 2-D vector bin-packing simulator** (AlphaEvolve §3.3.1): evolve `score(required, free)`, `evaluate` replays a job/capacity trace and scores stranded-resource recovery. Pure-CPU, no GPU, genuinely slow (simulation over a long trace). **Weaker on reproducibility:** no public Google trace + simulator ships; you reconstruct it from the public Google Cluster Data 2019 trace + a hand-written replay. More setup than admissible_set, which needs no dataset.

### ⚠️ Correction to the slice's current OQ6 (verified)
The slice currently resolves its validation target (OQ6 / §14) to **ASI-Evolve's "LLM-serving / inference-throughput scheduler"** (`run_serving_simulation`, citing `donotcommit/ASI-Evolve/README.md:181`). **That fixture does not exist.** Verified: `run_serving_simulation` appears only in README prose (`:172`, `:181`), where `:172` literally annotates the import `# your internal benchmark harness`; a full-repo `grep`/`find` finds **no** simulator, **no** trace (`sharegpt_1k.jsonl` absent), **no** `infer_scheduler` experiment. The only shipped experiments are `circle_packing_demo` and `circle_packing_linear`. **Action:** update the slice's §14 OQ6 to `admissible_set` (real, runnable, GPU-free, dataset-free) and strike the scheduler placeholder.

---

## 2. First IronCurtain dogfood — memory hybrid-fusion ranking

**Recommendation: the memory MCP server's hybrid-fusion / composite ranking heuristic** (`packages/memory-mcp-server/src/retrieval/scoring.ts`), optimized for retrieval recall/precision over the **LoCoMo** labeled set, held out on **LongMemEval**. Evaluator is **must-build** (≈ a half-to-one-day harness, scoped below); it is the right first dogfood despite that, because it is the one candidate that demonstrates *what evolve is uniquely for*.

### Why this one (verified)
- **A genuinely evolutionary search space.** ~10 interacting, hand-tuned, continuous constants with coupled effects: fusion `alpha = 0.5` (`scoring.ts:51`), composite weights `relevance 0.65 / recency 0.15 / importance 0.1 / access 0.1` (`:143-145`), decays `-0.001` (`:134`) / `-0.002` (`:137`), small-set `damping = 0.3` (`:30`), `MIN_FUSION_FRACTION = 0.05` (`:163`), reranker gap/min (`:180-182`), plus the BM25 column weights in `queries.ts:167`. `alpha` shifts what survives the relevance gate, which shifts what the reranker sees — a non-separable space that humans tune poorly and evolutionary search tunes well. This is the textbook fit; a one-shot LLM edit does not solve it.
- **A real labeled dataset + a real held-out set, both in-repo.** `benchmark/data/locomo10.json` (≈2.8 MB, ground-truth `evidence` dia_id labels) and `benchmark/locomo/retrieval_metrics.py` (`evidence_recall`/`evidence_precision`/`perfect_retrieval`, no LLM reader). LongMemEval (`benchmark/longmemeval/`) provides an independent held-out set — directly answering the overfit objection.
- **A safe domain.** A bad candidate returns *worse memories*; it does not breach a security boundary.

### The must-build evaluator (honest scope ≈ ½–1 day)
The existing `--retrieval-only` flag is **not** the head start it looks like — verified that it re-grades a *frozen, post-fusion* checkpoint (`retrieved_context`/`retrieved_tags` only), so it cannot sweep `alpha`/weights/gates offline. The harness to build:
1. **Dump the raw candidate pool once.** Instrument `pipeline.ts` (after the vector+FTS fetch, ~`:50`) to persist, per query: the raw `vectorResults` (id, `distance`), `ftsResults` (id, `bm25_score`), each candidate's `created_at`/`last_accessed_at`/`access_count`/`importance`/content-length, and the ground-truth `evidence` dia_ids. One ingest+recall pass over `locomo10.json` produces a frozen fixture; embeddings/reranker then run **zero** times during evolution.
2. **Pure-function rescore loop (the evaluator).** Evolve mutates the constants; `evaluate` replays `hybridScoreFusion → computeCompositeScore → filterByRelevance → packToBudget` over the cached pool and scores against `score_retrieval`'s recall/precision. Deterministic, in-process, **sub-second per candidate, zero model calls** — i.e. a fast pure-code evaluator with no Docker.
3. **Held-out guard.** Optimize on a LoCoMo split; report final fitness on LongMemEval; reject candidates that win LoCoMo but regress LongMemEval.

**Cleaner first cut:** scope the evolved surface to the **pre-reranker** constants only (`alpha`, the four composite weights, two decays, `MIN_FUSION_FRACTION`, `damping`) and freeze the reranker — still **8 coupled continuous knobs**, fully cacheable, zero model calls. (Including the cross-encoder reranker requires caching query×candidate logits too; defer it.)

### Why `resolveRealPath` was rejected (not merely runner-up)
The original research recommended `resolveRealPath`/`isWithinDirectory` (speed, oracle = the 81-test `test/argument-roles.test.ts`). Vetting **rejected** it:
- **Not an evolutionary problem.** The headroom is real but the fix is a *one-shot refactor*: `isWithinDirectory` re-resolves the constant `allowedDirectory` every call (verified — `PolicyEngine` stores it unresolved, `policy-engine.ts:327`), so "resolve it once at construction + memo `resolveRealPath`" is a single obvious diff. No search space; demonstrates nothing evolve is *for*. Measured cost is microseconds, off any user-perceived latency path (the ancestor walk is only hot for *nonexistent* paths; the common case short-circuits at `realpathSync`).
- **Security trap.** It is the sandbox-containment boundary, and the speed metric *rewards* caching `realpathSync` — the exact mutation that creates a stale-symlink TOCTOU → sandbox escape (the function's own `:119-120` TODO flags this). An 81-case **static** fixture suite cannot catch a *temporal* cache-invalidation bug (it never mutates the FS between two resolutions), so a faster-but-subtly-wrong candidate passes. "Ready oracle" here is *ready and insufficient* — the worst kind of first dogfood.

### Runner-up
**`PolicyEngine.evaluate`** (speed; oracle = the 151-test `test/policy-engine.test.ts`, the repo's strongest). Non-Docker harness exists (the CLAUDE.md validation snippet). Ranked below because its dominant cost largely *is* `resolveRealPath`, the workload corpus is must-build, and the headroom at current policy sizes is speculative.

---

## 3. How these two tracks relate

They are **independent** and can proceed separately:
- **Track 1 (admissible_set)** validates the *parallelism design* — it is the slow, GPU-free fixture that makes N-way fan-out show a real speedup. It needs the sync-parallelism slice implemented (or at least `num_workers`) to demonstrate the win; with `workers:1` it's just a correctness fixture.
- **Track 2 (memory-fusion)** is a *self-contained dogfood of the evolve workflow on IronCurtain's own code* — it needs **no** parallelism and **no** Docker (pure-code evaluator), so it can run on the current single-worker workflow today, and is the lower-risk way to prove evolve delivers value before the parallelism machinery lands.

Suggested order: **Track 2 first** (proves evolve produces value on our code, no new machinery), **Track 1 when the fan-out is implemented** (proves the parallelism design on a real slow workload).

---

## 4. Claims corrected during vetting (traceability)

| Original research claim | Vetted correction |
|---|---|
| admissible_set `I(15,10) ≈ 1 min` | **False** — that figure is `I(12,7)`; measured `I(15,10)` is sub-second–~1 s (smoke test). The slow demo is `I(21,15)` (minutes). |
| `I(24,17) ≈ 7 h` (pure numpy) | **Misleading** — the 7 h figure needed a C++ inner loop; pure-numpy is slower. Drop `I(24,17)`. |
| Eval time is "bounded variance" | **False** — ~2× spread, quality-correlated. In the **symmetric** variant better = *faster* → barrier-friendly (a point in favor); in the unrestricted variant better = slower → barrier-hostile. Use symmetric. |
| Port is "~40 lines of numpy" | **Understated** — ~90 lines for the symmetric variant (adds `get_surviving_children`, rotation expansion, `bad_triples` tables). |
| `resolveRealPath` is the safe first dogfood | **Rejected** — one-shot refactor (no search), and a security boundary whose metric rewards the containment-breaking mutation behind a static oracle that can't catch the temporal regression. |
| `--retrieval-only` makes the fusion harness nearly free | **False** — it re-grades a frozen post-fusion checkpoint; it does not expose the raw candidate pool. The cache-then-rescore harness is genuinely must-build (~½–1 day). |
| Reranker gap = "12 logit points" (memory CLAUDE.md) | **Stale** — code says `RERANKER_SCORE_GAP = 5` (`scoring.ts:182`). Cite the code, not the doc. |

## Sources
- FunSearch: [`google-deepmind/funsearch`](https://github.com/google-deepmind/funsearch) (`admissible_set/`, `cap_set/`); [Nature 2023](https://www.nature.com/articles/s41586-023-06924-6). Timings/variance measured by executing the real notebook `solve` loops.
- AlphaEvolve: paper extract `/tmp/alphaevolve.txt` (Table 1 fast-vs-slow `:84`; data-center scheduling `:1121-1185`; GPU OOM `:2180`); [DeepMind blog](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/).
- OQ6 placeholder: `donotcommit/ASI-Evolve/README.md:172,181` + full-repo grep.
- IronCurtain: `packages/memory-mcp-server/src/retrieval/scoring.ts`, `benchmark/data/locomo10.json`, `benchmark/locomo/retrieval_metrics.py`, `benchmark/longmemeval/`; `src/types/argument-roles.ts:94-134`, `src/trusted-process/policy-engine.ts:327`.
