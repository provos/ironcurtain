# Evolve Native Workflow — Search-Quality Slice (mid-run cognition promotion + multi-parent sampling + selectable samplers)

Status: **Design — revised; ready to implement.** The M1 seed mechanism (§6.3) has been **empirically verified** (the `runpy` preamble reproducibly seeds the engine's single global `random` with the engine byte-untouched; `random`/`island`/`ucb1` all reproduce same-seed and diverge diff-seed on identical inputs). The central mechanism is sound; this revision corrects the test/gate spec (§11), the §4.5 promotion-branch placement, the §5.3 `--n 1` override, and the multi-parent/rename blast-radius details.

Audience: IronCurtain workflow + docker-infrastructure engineer extending the merged `evolve` workflow package (all six prior increments — single/multi-round hub, human-surface gates, generic experiment harness, correctness slice — are on `master`).

Implementation contract: this document names the exact deltas for three search-quality fixes that make the search materially better by closing the gap between what the vendored `evolve_core/` engine already supports and what the FSM drives. The touched files are **`src/workflow/workflows/evolve/workflow.yaml`** (the `preflight` run-spec authoring, the `sample`/`researcher`/`analyzer`/`analysis_record` prompts — no FSM topology change) and the bridge **`src/workflow/workflows/evolve/scripts/evolve_result.py`** (the `sample` step's multi-parent emission + cognition retrieval, and a new post-analysis cognition-promotion path). The vendored `evolve_core/` engine stays **byte-verbatim** — every gap below is closable through existing engine CLI surfaces (`evolve-cognition add`, `--sample-n`, `--sampling-algorithm`, multi-parent `Node.parent: List[int]`). It is precise enough to implement without re-deriving the hub machinery, the human-gate surface, the experiment-harness inference, or the correctness-slice stop signals — those are cited from the merged tree, not re-designed.

Predecessors (merged, build ON — do not redesign):

- **Correctness slice** — `docs/designs/evolve-correctness-slice.md` (on master). The bridge stop-signal computation in `attach_analysis` (post-record), the idempotency guard keyed on `meta_info.step_name`, and the `current/stop_signals.json` contract. This slice adds the cognition-promotion path alongside that post-record computation and must not break the idempotency guard.
- **Experiment-harness slice** — `docs/designs/evolve-experiment-harness-slice.md` (#309, on master). The `provision` state, the generic `preflight` that authors the run spec via `evolve-brief normalize`, the `--workspace` experiment-dir staging, and the cognition-seed seam (`<run_dir>/cognition_seed.md`). This slice extends `preflight`'s authoring (sampler + `sample_n`) and the cognition store's mid-run population.
- **Human-surface slice** — `docs/designs/evolve-human-surface-slice.md` (on master). The gate surface and `final_summary`. Untouched here.
- **Multi-round slice** — `docs/designs/evolve-multi-round-slice.md` (#302). The orchestrator hub, the `sample`/`researcher`/`evaluate`/`analyzer`/`analysis_record` spokes, the `evolve_result.py` bridge, and the determinism invariants. This slice extends `sample` (multi-parent emission, sampler selection) and `attach_analysis` (cognition promotion) on the bridge side.

---

## 1. Summary & goals

The merged `evolve` workflow drives the vendored `evolve_core/` engine through a deliberately narrow slice: the first slices needed parent-linkage, durable records, and stop conditions, so they hardcoded the simplest sampling path. The central, verified finding of the parity analysis is that **the engine is far more capable than the FSM drives it**: it already supports mid-run cognition population (`evolve-cognition add` → `cmd_cognition_add`, `cli.py:362-389`), multi-parent sampling (`evolve-db sample --n` → `cmd_db_sample`, `cli.py:406-414`; `Node.parent: List[int]`, `structures.py:16`), and four built-in samplers plus custom (`greedy`/`ucb1`/`island`/`random`/`custom` via `--sampling-algorithm` + `--sampling-feature*`/`--sampling-custom-sampler-*`, `cli.py:616-621`, `algorithms/factory.py:17-45`). The FSM hardcodes `--sampling-algorithm greedy` and `--sample-n 1` (`workflow.yaml:216-217`), and the bridge keeps only `sampled_nodes[0]` (`evolve_result.py:516-517`). Every gap below is closable **in the FSM/bridge/`preflight` with the engine untouched** — the cognition-add, multi-parent record, and sampler selection all go through existing engine CLI surfaces.

This slice makes the search materially better with three fixes:

1. **Mid-run cognition promotion (the biggest quality lever).** The `analyzer` writes a "transferable lesson" to `current/analysis.md` (`workflow.yaml:424-432`), which today only lands in the round's `node.analysis` (`cmd_db_record`, `cli.py:454,468`) and that node's own context vector (`database.py:79-82`). It is **never promoted into the cognition store**, so a later round's sample-time `cognition search` (`evolve_result.py:492-504`) cannot retrieve a lesson learned on a different lineage. The engine fully supports promotion (`evolve-cognition add`). This slice wires a post-analysis bridge path that adds the round's lesson to the cognition store, so subsequent rounds retrieve cross-lineage lessons. This is an **enhancement beyond standalone ASI-Evolve parity** — standalone also only seeds-then-retrieves cognition; it is framed as a quality enhancement, not a parity fix.
2. **Multi-parent sampling (`sample_n` > 1).** The engine and CLI support `--sample-n` and multi-parent nodes, but the FSM hardcodes `--sample-n 1` (`workflow.yaml:217`), the bridge truncates the sampled list to `sampled_nodes[0]` and emits a single-element parent (`evolve_result.py:516-517`, `_resolve_parent` `:130-140`), and the `researcher` prompt is single-parent (`workflow.yaml:369-379`). This slice makes `preflight` author `sample_n` from the task/experiment, threads ALL sampled nodes into the researcher context, and records multi-parent lineage (`node.parent` becomes the full list). This is the largest behavioral divergence from the circle-packing worked example (which used `sample_n: 3`).
3. **Sampler selectability.** The engine supports `greedy`/`ucb1`/`island`/`random`/`custom`, but the FSM hardcodes `greedy` (`workflow.yaml:216`). This slice lets `preflight` choose the sampler. **The crux is determinism:** `greedy` is deterministic (`greedy.py:14-17`, pure `sorted`), but `ucb1`/`island`/`random` draw from Python's global `random` module (`random.py:18`, `ucb1.py:25,32`, `island.py:72-80`), which the engine never seeds — so reproducible runs and CI need a seed mechanism that does not exist today. §6.3 resolves this as the central design decision.

The whole slice is two files (mirroring the correctness slice's footprint):

- **`workflow.yaml`** — prompt edits, no FSM-topology change. The `preflight` run-spec authoring block (`:203-219`) gains sampler + `sample_n` authoring; the `researcher` prompt (`:366-386`) gains multi-parent context handling. No new state, gate, or terminal.
- **`evolve_result.py`** — the `sample` step (`:432-543`) keeps all sampled nodes and emits a parent **list** in `current/context.json`; `attach_analysis` (`:589-665`) gains a cognition-promotion shell-out (`evolve-cognition add`) after the durable record, alongside the existing stop-signal computation. The multi-parent record path (`--parent-from-current` → `_resolve_parent` → `node.parent`) is already mostly present (`:130-140`, `:635-636`) and is widened to emit all parents.

### Non-goals (out of scope)

- **No `evolve_core/` change.** The byte-verbatim vendored-engine invariant holds. The cognition-add, multi-parent record, and sampler selection all go through existing engine CLI surfaces (`evolve-cognition add`, `evolve-db sample --n`, `evolve-db record --parent`, `evolve-brief normalize --sampling-algorithm/--sample-n`). No engine subcommand, schema field, or RNG mechanism is added to the engine.
- **Parallelism is explicitly OUT of scope (and is the maintainer's flagged next follow-up).** ASI-Evolve's parallel-worker mode is a separate, larger FSM-level change (the FSM is currently the serializer). This slice's changes must not *preclude* future parallelism (§9), but it does not implement concurrent workers, a work queue, or any change to the serial hub-and-spoke loop.
- **No new FSM state, gate, or terminal.** Unlike the experiment-harness slice (which added `provision`), this slice changes only prompts and bridge internals. The hub, the spokes, the human gates, and the terminals are unchanged.
- **No new run-spec schema field beyond what `evolve-brief normalize` already authors.** `sampling.algorithm`, `sampling.sample_n`, `sampling.feature_dimensions`, etc. already exist in `DEFAULT_RUN_SPEC` and are already wired by `cmd_brief_normalize` (`cli.py:165-178`). This slice authors *values* into them; it does not add fields. The stochastic-sampler reproducibility seed is **not** carried as a run-spec field — adding `sampling.seed` would require an engine `--sampling-seed` flag (forbidden), so the seed lives in a `preflight`-authored sidecar (`sampling_seed.txt`, §6.3, decided). The recommended scoping ships A+B together (the seed mechanism is empirically verified); no schema field is added.
- **No change to the correctness slice's stop signals.** The `attach_analysis` stop-signal computation (`_write_stop_signals`, `evolve_result.py:322-325`) is preserved verbatim; the cognition-promotion shell-out is added alongside it, not in place of it.

### Goals (binary, restated as the gate — §11)

After this slice, the completion gate proves all of:

1. **Cognition promotion crosses rounds** — a bridge-level test proves a lesson promoted by `attach_analysis` in round N is retrievable by `evolve-cognition search` in round N+1 (and a Docker integration test proves a later round's `current/context.json` carries a match that originated as an earlier round's promoted lesson, not a seed item).
2. **Multi-parent lineage is recorded** — a bridge-level test proves a `sample` with `--n 3` writes a parent **list** into `current/context.json` and that `attach_analysis --parent-from-current` records a `node.parent` with all sampled ids; a Docker integration test proves a recorded node's `parent` list has length > 1.
3. **Sampler selection is honored** — a bridge-level test proves the `sampling.algorithm` `preflight` authors reaches `cmd_db_sample` (the engine's `db_sample` round-log records the configured algorithm, `cli.py:413`); the integration test proves a run authored with the chosen sampler reaches `done`.
4. **The determinism/reproducibility proof** (§6.3, §11.3) — **greedy:** two identical greedy integration runs produce byte-identical `nodes.json` (modulo `created_at`). **Stochastic (the M1 seed, empirically verified):** the bridge-level reproducibility proof must establish the *real* property — **same seed + same starting DB ⇒ identical sample sequence; different seed ⇒ different** — NOT a naive same-run-dir double-sample (which false-fails for ucb1/island because `db.sample` persists mutated sampler state; see §11.3). The honest end-to-end form compares two **independent** runs seeded from round 0; a focused bridge-level unit may instead reset/restore `nodes.json` between the two seeded samples, or scope a deterministic same-call assertion to `random` only.
5. **`tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict` is clean**, and the existing evolve gates (single/multi-round/human-surface/harness/correctness) still pass.

## 2. The central finding — the engine is more capable than the FSM drives it

The vendored `evolve_core/` engine is a faithful ASI-Evolve port and ships the full search machinery. The prior slices, by design, drove only the narrowest path that satisfied their gates (parent-linkage, durable record, stop conditions). The three quality levers this slice adds are already engine-native; the work is purely in the FSM, the bridge, and `preflight`.

### 2.1 Engine surfaces already present (cite, do not re-derive)

Every surface below is verified in the merged tree and stays byte-verbatim:

- **Mid-run cognition population.** `evolve-cognition add` → `cmd_cognition_add` (`cli.py:362-389`) takes `--item` (repeatable text), `--json-file`, `--kind`, `--source`, builds `CognitionItem`s, and calls `cognition.add_batch(items)` (`cli.py:387`). `Cognition.add` (`cognition.py:48-57`) assigns a uuid, embeds the content (`embedding.encode`, `:55`), adds to the FAISS index, and `_save()`s. `add_batch` (`:59-60`) is just a loop of `add`. So a single `evolve-cognition add --run-dir … --item "<lesson>"` populates the store mid-run, and the next `evolve-cognition search` retrieves it. **This is the surface Fix 1 uses.**
- **Multi-parent sampling.** `evolve-db sample --n <k>` → `cmd_db_sample` (`cli.py:406-414`) resolves `n = args.n or configured_sample_n(spec)` (`:411`) and returns `{"nodes": [node.to_dict() for node in sampled]}` (`:414`) — a list of up to `k` nodes. `Node.parent` is a `List[int]` (`structures.py:16`), round-tripped by `to_dict`/`from_dict` (`:38,53`). `evolve-db record --parent <id>` is repeatable (`cli.py:694`) and `cmd_db_record` sets `node.parent = args.parent or []` (`cli.py:464`). So a node with N parents is fully representable and recordable. **This is the surface Fix 2 uses.**
- **Selectable samplers.** `cmd_brief_normalize` writes `spec["sampling"]["algorithm"] = args.sampling_algorithm` and `spec["sampling"]["sample_n"] = args.sample_n` (`cli.py:165-168`), plus `feature_dimensions`/`feature_bins`/`custom_sampler_path`/`custom_sampler_class` (`:169-178`). `build_database` (`cli.py:63-72`) reads them via `build_database_sampling_config` (`sampling_config.py:96-117`) and `get_sampler(algorithm, **kwargs)` (`factory.py:17-45`) dispatches to `GreedySampler`/`IslandSampler`/`RandomSampler`/`UCB1Sampler` or a custom class. **This is the surface Fix 3 uses.**

### 2.2 Where the FSM narrows it (the three gaps)

| Engine capability | What the FSM/bridge does today | Gap |
| --- | --- | --- |
| `evolve-cognition add` populates the store mid-run | The analyzer's lesson is written to `current/analysis.md` (`workflow.yaml:431`) and recorded only into `node.analysis` via `attach_analysis --analysis-file` (`workflow.yaml:458-459`). No `cognition add` is ever invoked after seeding. | **Gap 1:** lessons never cross lineage — `cognition search` at sample time (`evolve_result.py:492-504`) only ever returns the round-1 seed items. |
| `evolve-db sample --n k` returns k nodes; `node.parent` is a list | `preflight` authors `--sample-n 1` (`workflow.yaml:217`); the bridge `sample` keeps `sampled_nodes[0]` and writes a single `parent` dict to `context.json` (`evolve_result.py:516-521`); `_resolve_parent` reads `context["parent"]["id"]` and returns `[parent_id]` (`:130-140`); the researcher prompt reads a single `parent` (`workflow.yaml:369-379`). | **Gap 2:** even if `--sample-n` were raised, the bridge would discard parents 2..N — the truncation is in `sampled_nodes[0]`. |
| `get_sampler` dispatches greedy/ucb1/island/random/custom | `preflight` authors `--sampling-algorithm greedy` unconditionally (`workflow.yaml:216`). | **Gap 3:** the run is always greedy; ucb1/island/random/custom are unreachable, even when the task or experiment would benefit from exploration. |

The engine defaults are themselves telling: `DEFAULT_SAMPLING_ALGORITHM = "ucb1"` and `DEFAULT_SAMPLE_N = 3` (`sampling_config.py:12-13`). The FSM's explicit `greedy`/`1` flags override richer defaults the engine ships — closing these gaps is mostly a matter of *stopping* the FSM from narrowing what the engine already does well.

## 3. The current evolve package — what this slice extends (verified citations)

The touchpoints, with the load-bearing facts the implementer relies on. Every line number is against the merged tree (`evolve_result.py` is 726 lines post-correctness-slice; `workflow.yaml` is 570 lines post-harness-slice).

### 3.1 The `sample` step — cognition init/search + parent selection

`sample` (`workflow.yaml:335-360`) is a `deterministic`, `container: true` state running `evolve_result.py sample` with `--query-from-spec`, no `--n` flag (so `argparse` default `1`, `:687`). The bridge's `sample` (`evolve_result.py:432-543`):

1. **Seeds cognition on the first round** (`:439-463`): when `_cognition_item_count(run_dir) == 0` and `cognition_seed.md` exists, it shells `evolve-cognition init --seed-file …`. This is the only place cognition is populated today.
2. **Computes the next step name** from the node count (`:465-467`): `step_name = f"step_{done_rounds + 1:04d}"`.
3. **Samples parents** (`:469-479`): shells `evolve-db sample --n <args.n>` (default 1). `cmd_db_sample` returns `{"nodes": [...]}`.
4. **Truncates to one parent** (`:516-517`): `parent = sampled_nodes[0] if … else None` — **the single-parent narrowing**. The rest of `sampled_nodes` is discarded.
5. **Retrieves cognition** (`:491-504`): shells `evolve-cognition search --query <objective> --top-k <k>` and keeps `cognition_payload["matches"]`.
6. **Writes `current/context.json`** (`:519-528`): `{step_name, parent: <single dict|null>, cognition: {query, matches}}`.

`_resolve_parent` (`:130-140`) — used by `attach_analysis --parent-from-current` — reads the **singular** `context["parent"]` (a dict, `:134`), returns `[]` if it is not a dict (`:135-136`), extracts `parent.get("id")`, and returns `[parent_id]` (`:140`). Its return type is `list[int]`, but it is *hardwired to read the singular `parent` key* and so can only ever produce a one-element list. **Fix 2 is therefore TWO bridge sites, not one:** (1) the `sample` step's write of singular `context["parent"]` (`:516-517` truncation, `:521` write) and (2) `_resolve_parent`'s read of singular `context["parent"]` (`:134-140`). Both must change to the plural `parents` shape, plus the researcher prompt (§5.4). The *record* path downstream of `_resolve_parent` is already multi-parent-ready (§5.5) and needs no new work.

### 3.2 `attach_analysis` — post-record, where the lesson is available

`attach_analysis` (`evolve_result.py:589-665`) is the durable node-write at the end of every round (`analysis_record`, `workflow.yaml:441-470`). Post-correctness-slice it:

- **Idempotency-guards** the record (`:593-611`): if a node for this `step_name` already exists (`_find_recorded_node_for_step`, `:182-187`), it short-circuits to `recorded` without re-appending (and still recomputes stop signals).
- **Records the node** (`:613-656`): resolves `step_name`/`code_path`/`results_file`/`name`/`parents` (`:613-616`), builds the `evolve-db record` argv with `--analysis-file <current/analysis.md>` (`:632-633`) and one `--parent <id>` per resolved parent (`:635-636`), and shells it. `cmd_db_record` stores `node.analysis = <analysis.md contents>` (`cli.py:454,468`) and returns `node_id`.
- **Computes stop signals** (`:658-662`): `_write_stop_signals(run_dir)` over the now-current `nodes.json`, writing `current/stop_signals.json`.

**Where the lesson is available:** the analyzer wrote it to `current/analysis.md` before this state ran; `attach_analysis` resolves `--analysis-file` to that path. The lesson text is therefore on disk at `current/analysis.md` throughout `attach_analysis`, and the recorded node's `node.analysis` is the same text. **Fix 1 adds a cognition-promotion shell-out here** — after the record succeeds (so the node id and `best_updated` flag are known), reading the same `current/analysis.md` and calling `evolve-cognition add --item <lesson>`. It runs alongside `_write_stop_signals`, on the recorded path (not the idempotent-skip path — a replayed round must not double-promote, §4.4).

### 3.3 The `preflight` run-spec authoring — sampler + sample_n flags

`preflight` (`workflow.yaml:131-252`) authors the run spec by shelling `evolve-brief normalize` (`:203-219`). The relevant flags today:

```
--sampling-algorithm greedy   # workflow.yaml:216
--sample-n 1                  # workflow.yaml:217
```

These are hardcoded literals in the prompt's command template, not inferred. `cmd_brief_normalize` writes them into `spec["sampling"]` (`cli.py:165-168`). **Fix 2 and Fix 3 change these two lines to inferred values** (and Fix 3 may add `--sampling-feature`/`--sampling-feature-bins` for island). The prompt already has the inference scaffolding for other fields (objective, eval command, success criterion); the sampler/`sample_n` inference slots into the same step-2 block (`:151-180`).

**Run-level immutability constraint (load-bearing for Fix 3).** `cmd_brief_normalize` raises `SAMPLING_CONFIG_IMMUTABLE_ERROR` if the sampling *fingerprint* changes once nodes exist (`cli.py:202-205`; the fingerprint is `algorithm`/`feature_dimensions`/`feature_bins`/`custom_sampler_*`, `sampling_config.py:38-48` — notably **not** `sample_n`). So the sampler must be chosen at `preflight`, before any node is recorded; it cannot be hot-swapped mid-run. `sample_n` is *not* fingerprinted, so it could in principle vary per round — but this slice authors it once at `preflight` for simplicity and reproducibility.

### 3.4 The determinism env — PYTHONHASHSEED in the bridge subprocess

The bridge runs every engine helper through `_run_helper` (`evolve_result.py:353-361`), which passes `env=DETERMINISTIC_ENV` — `{**os.environ, "PYTHONHASHSEED": "0"}` (`:17`). This pins Python's string-hash randomization to 0 for all engine subprocesses, which makes the **Tier-0 fallback embedding deterministic**: `EmbeddingService._fallback_encode_one` uses `hash(token)` to bucket tokens into the vector (`embedding.py:72-74`), so without a fixed `PYTHONHASHSEED` the same lesson would embed differently across processes and cognition retrieval would be non-reproducible. With the pin, cognition `add`/`search` are deterministic. **This is why Fix 1's promotion inherits determinism for free** — the `evolve-cognition add` shell-out goes through `_run_helper`, so it runs under `PYTHONHASHSEED=0` like every other helper.

**Crucially, `PYTHONHASHSEED` does NOT seed `random`.** It governs only `hash()`; Python's `random` module is seeded from OS entropy at import unless `random.seed(...)` is called explicitly. The engine never calls `random.seed` (verified: no `random.seed`/`np.random.seed`/`numpy.random` anywhere in `evolve_core/`). So the existing determinism env makes embeddings reproducible but does **not** make the stochastic samplers reproducible — this is the gap §6.3 must resolve.

### 3.5 The engine's sampler RNG — where randomness enters

Determinism analysis of each built-in sampler (all in `evolve_core/algorithms/`):

| Sampler | Deterministic? | Where randomness enters |
| --- | --- | --- |
| **greedy** (`greedy.py:14-17`) | **Yes** | None. Pure `sorted(nodes, key=score, reverse=True)[:n]`. Tie-break is `sorted`'s stable order, which depends on the input node order (insertion order from `nodes.json`) — itself deterministic. No `random`. |
| **ucb1** (`ucb1.py`) | **Conditionally** | `random.sample(nodes, …)` only on the cold start when `total_visits == 0` or no scored nodes (`:25,32`). Once any node has a `visit_count > 0`, selection is a deterministic `sort` on UCB scores (`:41-55`). On a serial FSM the cold start is round 2's first sample (round 1 has one node, zero visits). So ucb1 is stochastic *only* at the first multi-node sample, deterministic thereafter — but that one stochastic draw is enough to diverge a run. |
| **random** (`random.py:14-18`) | **No** | Pure `random.sample(nodes, min(n, len))`. Every sample is a draw. |
| **island** (`island.py:54-87`) | **No** | `random.random()` (`:72`), `random.choice`/`random.choices` (`:199,206,212`) on every selection. Also `hash(node.code)` for a diversity cache key (`:260`, `PYTHONHASHSEED`-sensitive but affects only caching, not selection) and `time.time()` for cache eviction (`:281`, affects only eviction order). The selection randomness is the `random.*` draws. |

**Key fact for the seed story:** all stochastic draws use Python's **global `random` module** (not a per-sampler `random.Random()` instance, not `numpy`). So a single `random.seed(S)` at engine-process start would make all of ucb1/island/random reproducible — there is exactly one RNG to pin. The samplers do **not** accept a seed in their constructors (`ucb1.py:16`, `island.py:17-27`, `random.py` has no `__init__`), and `get_sampler` (`factory.py:17-45`) passes no seed. So today there is no place to inject a seed without either (a) touching the engine (forbidden) or (b) seeding `random` from the bridge subprocess that hosts the engine call (§6.3 investigates this).

## 4. Fix 1 — Mid-run cognition promotion (the biggest quality lever)

### 4.1 The gap — lessons never cross lineage

The `analyzer` (`workflow.yaml:419-439`) is prompted to "write a SHORT transferable lesson" capturing "the transferable insight" (`:424,432`) into `current/analysis.md`. That lesson is durable in exactly two places after `attach_analysis` records the node:

1. **`node.analysis`** (`cmd_db_record`, `cli.py:454,468`) — readable only if a future round happens to sample *that specific node* as a parent and the researcher reads its analysis. It is lineage-local.
2. **That node's context vector** (`database.py:79-82`: `get_context_text()` concatenates `name + motivation + analysis` and embeds it into the *node* FAISS index). But the node index is used for *node* sampling, not cognition retrieval — the researcher never queries it.

The cognition store — the thing the researcher *does* query at sample time (`evolve-cognition search`, `evolve_result.py:492-504`) — is populated **only once**, at round 1, from `cognition_seed.md` (`:439-463`). After that it is frozen. So a lesson the analyzer learns on round 3's lineage (e.g. "SLSQP with a multi-start beats single-start on this packing") is invisible to round 5's researcher if round 5 samples a different parent. The search cannot accumulate cross-lineage knowledge — exactly the mechanism cognition exists to provide.

**Framing: this is an enhancement beyond standalone ASI-Evolve parity, not a parity fix.** Standalone ASI-Evolve also seeds cognition up front and retrieves it; its analyzer pass does not feed the cognition store mid-run either. So promoting per-round lessons makes IronCurtain's evolve *exceed* standalone parity on the cross-lineage-knowledge axis. It is justified on its own quality merits (the open "cognition-update gate", `asi-evolve-native-workflow.md:1417`), not by a parity obligation.

### 4.2 The promotion policy — WHAT to promote

Two candidate policies:

- **(a) Every round's lesson.** Promote the analyzer's `analysis.md` on every recorded round. Maximizes knowledge capture; risks polluting the store with lessons from low-quality candidates ("this approach scored 0.2 and was a dead end").
- **(b) Only improving rounds.** Promote only when the round produced a new best (`best_updated` is already returned by `cmd_db_record` and surfaced in the `attach_analysis` payload, `evolve_result.py:646`). Higher signal-to-noise; but loses the genuinely transferable *negative* lessons ("avoid X, it always overlaps"), which are often the most valuable cross-lineage knowledge.

**Recommendation: (a) every round's lesson, with the quality signal recorded as metadata, not as a filter.** The analyzer is *already* prompted to write a transferable insight, not a score restatement (`workflow.yaml:432`: "Do not restate the score; capture the transferable insight") — so the lesson is curated for transferability at authoring time, which is the right place to gate quality (the LLM judges transferability), not a mechanical best-only filter. Promote every round but attach `{"kind": "round_lesson", "source": "<step_name>", "best_updated": <bool>, "score": <score>}` as the `CognitionItem.metadata`, so retrieval can later be made score-aware without re-running. The `evolve-cognition add` surface supports `--kind` and `--source` (`cli.py:663-664`) and arbitrary metadata via `--json-file` (`cli.py:375-386`). This keeps negative lessons available while preserving the signal a future quality-aware retrieval could use. (The maintainer may prefer (b) if store pollution proves to hurt retrieval in practice — §12.1.)

### 4.3 The promotion timing — WHEN

The promotion runs in **`attach_analysis`, after the durable record succeeds**, in the same place the stop signals are computed (`evolve_result.py:658`). Three reasons:

- **The lesson and the node id both exist there.** `current/analysis.md` is on disk (the analyzer wrote it) and the record just returned `node_id`/`best_updated`. So the promotion can tag the cognition item with the node it came from and whether it improved — metadata it could not get in the `analyzer` state (no node yet) or in a separate later state (would need to re-derive the step).
- **It composes with the idempotency guard via a *structural* early return, not a verdict check.** Promotion runs *only on the genuine-record path* (after the record shell-out, near `evolve_result.py:658`), **not** on the idempotent-skip path (`:600-611`). The skip path writes its result and `return 0`s at `:611` *before* execution can reach the genuine-record code at `:613+`, so the promotion (placed after the record shell-out) is unreachable on a skip. **Important: do not gate the promotion on `verdict == "recorded"`** — the idempotent-skip path ALSO sets `verdict: "recorded"` (`:610`), so a verdict check would NOT distinguish the two paths. The real exclusion is the `return 0` at `:611`; the promotion must live strictly after the genuine record, relying on that early return, so that a future refactor merging the two paths cannot accidentally promote on a skip. A replayed `analysis_record` (resume across the crash window, correctness slice §6) therefore cannot double-promote. §4.4 adds a content-hash dedup key as defense-in-depth on top of this structural exclusion.
- **No new FSM state.** A dedicated "promote" state would add FSM surface, a new `resultFile` contract, and a new orchestrator verdict for nothing — `attach_analysis` already runs once per round at exactly the right moment. This mirrors the correctness slice's decision to fold stop-signal computation into `attach_analysis` rather than add a state.

**Alternative considered and rejected:** promoting in the `analyzer` state itself (the agent calls `evolve-cognition add`). Rejected because (1) the analyzer is an LLM agent — making it responsible for a durable side effect is less reliable than a deterministic bridge step, and (2) the node does not exist yet at analyzer time, so the promotion could not be tagged with the node id or `best_updated`.

### 4.4 Dedup / quality gating — the cognition-update gate

This resolves the open "cognition-update gate" (`asi-evolve-native-workflow.md:1417`: "Should cognition updates during the run require a human gate, helper validation only, or unrestricted Analyzer proposals?").

**Recommendation: helper validation (deterministic bridge), no human gate, with content-hash dedup.** A human gate per round would defeat the purpose (the loop is meant to run unattended between the `preflight_review` and `final_review` gates). Unrestricted analyzer proposals (the analyzer freely calling `cognition add`) is the rejected alternative from §4.3. The bridge promotion is the middle path: deterministic, validated, and bounded.

The **dedup key is a content hash of the lesson text**. Before shelling `evolve-cognition add`, the bridge computes `sha256(lesson_text.strip())` and checks a small sidecar ledger `current/../cognition_promoted.json` (a run-dir-level JSON map `{hash: step_name}`, NOT in `current/` which is cleared each round). If the hash is present, the promotion is skipped (the lesson is a verbatim repeat, e.g. an analyzer that re-emitted the same insight, or a resumed round that somehow reached the record path twice). This is defense-in-depth on top of the structural early-return exclusion (§4.3): the early return prevents the *node* double-record reaching the promotion at all; the hash ledger prevents a *cognition* double-promote even if the lesson text recurs across distinct genuine rounds. The ledger write is a plain read-modify-write, which is correct today because the FSM serializes (one writer, one in-flight round). It is **not** file-locked in the §4.5 snippet; the design only *notes* that a future parallel-workers slice (§9) must wrap both the ledger RMW and the `evolve-cognition add` in an `InterProcessFileLock` — an engine-untouched bridge change, deferred, not done here.

**Why a content hash, not semantic dedup:** the cognition store *already* does semantic retrieval (FAISS over embeddings), so near-duplicate lessons are naturally down-weighted at retrieval time by similarity. A mechanical exact-hash dedup only suppresses *verbatim* repeats (cheap, deterministic, no embedding needed); semantic near-duplicate suppression is left to the retrieval ranker the engine already has. This avoids re-implementing similarity in the bridge.

**Quality gating beyond dedup is deliberately minimal.** The analyzer prompt already curates for transferability (§4.2). The bridge does not parse, score, or LLM-judge the lesson — that would be a leaky re-judgment of work the analyzer already did. The only mechanical gate is "non-empty after strip" (an empty `analysis.md` is not promoted) plus the hash dedup.

### 4.5 The exact bridge delta

First, add `import hashlib` to the module imports (`evolve_result.py:6-11` imports `argparse,json,os,re,subprocess,sys` but **not** `hashlib` today — the dedup digest needs it).

In `attach_analysis`, on the genuine-record path (`evolve_result.py:613-665`, after the `evolve-db record` shell-out and stop-signal computation near `:658`), promote the lesson. **This code is placed strictly after the genuine record; it is unreachable on the idempotent-skip path because that path `return 0`s at `:611` before reaching here (§4.3).** Do NOT add a `verdict == "recorded"` guard — the skip path also reports `verdict: "recorded"` (`:610`), so such a guard would be both redundant (the early return already excludes the skip) and *misleading* (it implies a verdict-based exclusion that does not actually hold). Gate only on the record having genuinely succeeded (a real `node_id`):

```python
# NEW (Fix 1): promote the round's transferable lesson into the cognition store
# so later rounds retrieve it cross-lineage. This runs on the genuine-record path
# only — the idempotent-skip path returned at :611 before reaching here, so a
# replayed round cannot double-promote. (Do NOT guard on verdict == "recorded":
# the skip path uses that same verdict; the exclusion is the structural early return.)
if verdict == "recorded" and payload.get("node_id") is not None:
    promoted = _promote_lesson(
        run_dir,
        analysis_file=Path(args.analysis_file),
        step_name=step_name,
        node_id=payload.get("node_id"),
        best_updated=payload.get("best_updated"),
    )
    payload["cognition_promoted"] = promoted   # {promoted: bool, reason?: str, items_added?: int}
```

(The `verdict == "recorded"` term that remains here is *not* the path discriminator — by the time control reaches this line the skip path is already gone; it simply skips promotion when the genuine record itself failed, i.e. `verdict == "needs_repair"`. The `node_id is not None` check is the substantive guard.)

with the new helper:

```python
def _promote_lesson(run_dir, analysis_file, step_name, node_id, best_updated) -> dict:
    if not analysis_file.exists():
        return {"promoted": False, "reason": "no_analysis_file"}
    lesson = analysis_file.read_text(encoding="utf-8").strip()
    if not lesson:
        return {"promoted": False, "reason": "empty_lesson"}
    digest = hashlib.sha256(lesson.encode("utf-8")).hexdigest()
    ledger_path = run_dir / "cognition_promoted.json"
    # Plain read-modify-write of the ledger. Safe under today's serial FSM (one
    # writer, one in-flight round). When parallelism lands (§9), wrap this RMW —
    # and the evolve-cognition add below — in an InterProcessFileLock (importable
    # from the engine via `from evolve_core.utils ...`, NOT an engine edit). The
    # snippet below is deliberately unlocked: it is correct for the serial loop
    # and the lock is a future, engine-untouched add, not a change to the engine.
    ledger = _load_json(ledger_path) if ledger_path.exists() else {}
    if digest in ledger:
        return {"promoted": False, "reason": "duplicate", "first_seen": ledger[digest]}
    item = {
        "content": lesson,
        "source": step_name,
        "metadata": {"kind": "round_lesson", "node_id": node_id, "best_updated": bool(best_updated)},
    }
    item_json = run_dir / "current" / "cognition_item.json"   # transient handoff to the helper
    _write_json(item_json, item)
    code, out, err = _run_helper([
        sys.executable, str(SCRIPT_DIR / "evolve-cognition"), "add",
        "--run-dir", str(run_dir), "--json-file", str(item_json),
    ])
    if code != 0 or not isinstance(out, dict):
        return {"promoted": False, "reason": "helper_error", "error": err}
    ledger[digest] = step_name
    _write_json(ledger_path, ledger)
    return {"promoted": True, "items_added": out.get("items_added"), "total_items": out.get("total_items")}
```

Notes on the delta:

- **It goes through `_run_helper`**, so it inherits `PYTHONHASHSEED=0` (`evolve_result.py:354`) — the promoted lesson embeds deterministically and is retrievable deterministically (§3.4).
- **It uses `--json-file`** (not `--item`) so the `metadata` (`kind`/`node_id`/`best_updated`) rides along; `cmd_cognition_add` reads metadata from the JSON payload (`cli.py:379-386`).
- **`current/cognition_item.json` is transient** — it lives under `current/` and is cleared at the top of the next `sample` (`_clear_current_round` would be extended to drop it, or it is simply overwritten each round; it carries no durable meaning).
- **The ledger is at `run_dir/cognition_promoted.json`** (durable, NOT under `current/`), so dedup survives across rounds and resumes.
- **No `evolve_core/` change** — `evolve-cognition add` is an existing surface.

## 5. Fix 2 — Multi-parent sampling (`sample_n` > 1)

### 5.1 The gap — single-parent truncation

The engine samples N parents and represents N-parent nodes natively (§2.1). The FSM collapses this to one parent in three places:

1. **`preflight` authors `--sample-n 1`** (`workflow.yaml:217`) → `spec.sampling.sample_n = 1`. So `cmd_db_sample` returns at most one node.
2. **The bridge truncates** even if `--sample-n` were raised: `sample` keeps `parent = sampled_nodes[0]` (`evolve_result.py:516-517`) and writes a single `parent` dict to `current/context.json` (`:519-528`). This is one of the two load-bearing narrowing sites (the other is `_resolve_parent`'s singular read, §5.5) — fixing only the flag would not widen lineage because the bridge still drops parents 2..N.
3. **The researcher prompt is single-parent**: "parent: the sampled parent node, or null on round 1" and "If a parent is present, evolve it" (`workflow.yaml:369-379`). It has no concept of crossing multiple parents.

`_resolve_parent` (`evolve_result.py:130-140`) has return type `list[int]`, but reads the **singular** `context["parent"]` dict and returns `[parent_id]` — so it can only ever produce a one-element list. **It is the SECOND bridge narrowing site, alongside the `sample` write.** Correcting the framing: the multi-parent narrowing lives in **two** bridge sites — (1) `sample` truncates to `sampled_nodes[0]` and writes singular `context["parent"]` (`:516-517,521`), and (2) `_resolve_parent` reads singular `context["parent"]` (`:134-140`) — **plus** the researcher prompt. **The *record* path downstream of `_resolve_parent` is already multi-parent-ready and needs NO new work:** `attach_analysis` already loops `for parent_id in parents: argv.extend(["--parent", str(parent_id)])` (`:635-636`); `cmd_db_record` sets the list `node.parent = args.parent or []` (`cli.py:464`); and `Node.parent` is `List[int]` (`structures.py:16`). So Fix 2's bridge work is exactly the two singular-key sites + the researcher prompt; the record path is confirmed ready. **This is the largest behavioral divergence from the circle-packing worked example, which used `sample_n: 3`** (`config.yaml:59`, advisory; harness slice §2.5).

### 5.2 The `preflight` delta — authoring `sample_n`

Change the hardcoded `--sample-n 1` (`workflow.yaml:217`) to an inferred `--sample-n SAMPLE_N`, and add a step-2 inference rule to the `preflight` prompt:

> SAMPLE_N — the number of parent candidates to sample each round. Default to 1 for a from-scratch toy task. When the task or experiment implies crossover/recombination search (e.g. an experiment `config.yaml` declares `sample_n`, or the objective benefits from combining multiple prior approaches), author the experiment's value (commonly 3). Use 1 when in doubt; SAMPLE_N must be a positive integer and should not exceed a small bound (e.g. ≤ 5) to keep the researcher's context tractable.

The engine clamps `n` to the available node count (`GreedySampler.sample` and friends all do `[:min(n, len(nodes))]`), so an early round with fewer than SAMPLE_N nodes simply samples all of them — no special-casing needed in `preflight`. The circle-packing live demo authors `--sample-n 3` (matching its `config.yaml`), which is the demonstration that exercises multi-parent recombination.

### 5.3 The `sample`-step delta — thread ALL sampled nodes

Two changes in `evolve_result.py sample`:

1. **Pass the configured `sample_n` to the engine — and stop forcing `--n 1` (Fix-2 sub-delta, load-bearing).** This is a real bug, not just an authoring change: **authoring `sample_n: 3` in the run spec is by itself INSUFFICIENT.** The `sample` state passes no `--n` to the *bridge* (`workflow.yaml:335-360`), so the bridge's own argparse applies its **default `--n 1`** (`evolve_result.py:687`), and the bridge then forwards `str(args.n)` — i.e. the literal `1` — to `evolve-db sample` (`evolve_result.py:476-477`). Downstream, `cmd_db_sample` does `n = args.n or configured_sample_n(spec)` (`cli.py:411`): because the forwarded `1` is **truthy**, it OVERRIDES the spec's `sample_n` and the engine samples exactly one parent regardless of what `preflight` authored. So Fix 2 must change the bridge to stop forwarding a hardcoded `1`. Two options: (a) the bridge reads `spec.sampling.sample_n` itself and forwards it as `--n`, or (b) add a `--n-from-spec` flag so the bridge resolves the count from the spec. **Recommendation: (b) `--n-from-spec`** — the bridge reads `spec.sampling.sample_n` via `_load_structured` (the same primitive used for the objective query, `:339-341`) and forwards it as `--n` to `evolve-db sample`. (Either (b) or simply *not* forwarding any `--n` works, because `cmd_db_sample` falls back to `configured_sample_n(spec)` when `args.n` is falsy/absent, `cli.py:411`. An explicit `--n-from-spec` is preferred because it keeps the run spec the single source of truth, makes the bridge's intent legible, and lets the bridge log the resolved count.) The current `--n 1` default that overrides the spec MUST be removed/rerouted as part of this fix; leaving it in place silently neuters multi-parent sampling even with `sample_n: 3` authored.
2. **Keep all sampled nodes and emit a parent list.** Replace `parent = sampled_nodes[0]` (`:516-517`) with the full list, and change `current/context.json`'s `parent` from a single dict to a `parents` array:

```python
sampled = sample_payload.get("nodes")
parents = [n for n in sampled if isinstance(n, dict)] if isinstance(sampled, list) else []
context = {
    "step_name": step_name,
    "parents": parents,          # NEW: full list (was a single `parent` dict)
    "cognition": {"query": query, "matches": matches},
}
```

**Contract decision — `parents` (plural array), replacing the singular `parent`.** The single `parent` key is removed, not kept-alongside. Keeping both would create two sources of truth and invite a consumer to read the stale singular one. `parents` is `[]` on round 1 (no nodes to sample), `[node]` for a single-parent run (`sample_n: 1`), and `[n0, n1, n2]` for multi-parent. This is a clean, uniform shape. The `sample` result-file payload's `parent_id` (`:536`) becomes `parent_ids: [<ids>]`.

### 5.4 The researcher prompt delta — multi-parent context

The researcher prompt (`workflow.yaml:366-386`) is reworked to read the `parents` array:

> Read the round context at `current/context.json`. It contains:
> - `step_name`: the directory you must write the candidate into
> - `parents`: a list of sampled parent nodes (empty on round 1, one or more otherwise)
> - `cognition.matches`: retrieved durable heuristics relevant to this objective
>
> If `parents` is empty and `/workspace/initial_program` exists, copy it verbatim as this round's candidate (the experiment's baseline, scored as node 0). If `parents` is empty and no `initial_program` exists, write a full candidate from scratch. If `parents` has **one** node, evolve it using the cognition hints. If `parents` has **multiple** nodes, produce a candidate that **recombines** their strengths — take the best ideas from each parent's code and the cognition hints, and synthesize a single improved candidate. Do not merely concatenate; integrate.

The `maxVisits: 3` and the single-file write contract (`workflow.yaml:381-384`) are unchanged. The researcher still writes exactly one candidate to `steps/<step_name>/code`.

### 5.5 The multi-parent record contract — how N parents flow end-to-end

The lineage flows `sample → context.json → researcher (reads, does not write parents) → attach_analysis → node.parent`:

1. **`sample`** writes `context.json.parents = [n0, n1, n2]` (§5.3).
2. **`researcher`** reads `parents` to synthesize the candidate but does not rewrite `context.json` — the parent list is fixed at sample time.
3. **`attach_analysis --parent-from-current`** calls `_resolve_parent`, which today reads the **singular** `context["parent"]` dict (`:134-140`) and so is one of the two sites Fix 2 must change (the other is the `sample` write, §5.3). It is widened to read the `parents` **list**:

```python
def _resolve_parent(args) -> list[int]:
    if not getattr(args, "parent_from_current", False):
        return list(args.parent or [])
    context = _load_current_context(_run_dir(args))
    parents = context.get("parents")
    ids = []
    for p in parents if isinstance(parents, list) else []:
        pid = p.get("id") if isinstance(p, dict) else None
        if isinstance(pid, int) and not isinstance(pid, bool):
            ids.append(pid)
    return ids
```

4. **`attach_analysis`** already loops `for parent_id in parents: argv.extend(["--parent", str(parent_id)])` (`:635-636`), so it passes one `--parent` per id to `evolve-db record`.
5. **`cmd_db_record`** sets `node.parent = args.parent or []` (`cli.py:464`), so the recorded `node.parent` is the full list, serialized into `nodes.json` (`structures.py:38`).

**The contract is: `node.parent` is the list of all sampled-parent ids for that round.** Round 1's node has `parent: []` (no parents, the baseline) — unchanged from today. A multi-parent round has `parent: [n0, n1, n2]`. The correctness slice's idempotency guard (keyed on `meta_info.step_name`, not parent) is unaffected. The stop-signal computation (patience/target over `nodes.json`) reads `score`, not `parent`, so it is unaffected.

**Migration note — the singular→plural `context.json` rename is safe at *runtime*, but DOES require updating existing tests.** `context.json` is round-scratch (`current/`, cleared each round); no durable artifact, checkpoint, web-ui consumer, or `workflow inspect` path reads the singular `parent` key (the §6.3-era grep confirmed this — but it was scoped to `src/`). The runtime producers/consumers that change together are `sample` (producer), the researcher prompt (consumer), and `_resolve_parent` (consumer). **The grep missed `test/`:** existing tests read and write the singular `parent` key and MUST be updated as part of this slice. The concrete sites:

- `test/workflow/evolve-result-bridge.test.ts:730` (the `context` type annotation `parent: { id: number }`), `:734` (`expect(context.parent.id).toBe(0)`), `:766-768` (reads `parent` / `expect(context.parent).toBeNull()`), `:818` (writes `context.json` with `parent: { id: 0 }`), `:842` (writes `context.json` with `parent: null`).
- `test/workflow/evolve-experiment-harness.integration.test.ts:217` (reads `context.parent`) and `:221` (branches on `context.parent === null`).

These read/write the *scratch* `context.json` shape (NOT the durable `node.parent`, which stays `List[int]` and is unaffected). They must be migrated to the plural `parents` array (e.g. `context.parents` / `expect(context.parents).toHaveLength(…)` / `parents: []` for the round-1 baseline). So the rename is *safe but not free* — reframe it as "internal scratch rename, requires updating the listed existing tests," not "no changes needed." The new bridge unit test (§11.1) pins the new shape.

## 6. Fix 3 — Sampler selectability + THE DETERMINISM RESOLUTION

### 6.1 The gap — greedy hardcoded

`preflight` authors `--sampling-algorithm greedy` unconditionally (`workflow.yaml:216`). This was the deliberate #302 choice: greedy is deterministic and "satisfies the parent-linkage gate without a seeding story" (`asi-evolve-native-workflow.md:1396`), with "ucb1/random/island deferred behind a deterministic-seed mechanism." That deferral is precisely what this slice must now confront: to let `preflight` choose a sampler, the deterministic-seed mechanism has to either exist or be explicitly gated.

### 6.2 Which samplers are deterministic vs stochastic

From the per-sampler analysis (§3.5): **greedy is deterministic; ucb1 is stochastic only at its cold start (first multi-node sample); random and island are fully stochastic every sample.** All stochastic draws use Python's single global `random` module — there is exactly one RNG to seed. The engine never calls `random.seed`, and `PYTHONHASHSEED=0` does not seed `random` (§3.4). So none of ucb1/island/random is reproducible today.

### 6.3 The determinism resolution — the central design decision

**This is the slice's central decision.** Reproducible runs (and deterministic CI) require that a stochastic sampler, given the same inputs, makes the same selections. There is no seed mechanism in the engine, and adding one to the engine is forbidden (byte-verbatim). The question: thread a seed through an engine-untouched path, or ship greedy first and gate the stochastic samplers?

**What a seed would have to do.** The stochastic selection happens inside the `evolve-db sample` *subprocess* the bridge spawns (`evolve_result.py:469-479` → `evolve-db` wrapper → `main_for("db")` → `cmd_db_sample` → `db.sample` → `sampler.sample` → `random.*`). For a seed to take effect, `random.seed(S)` must run **in that subprocess, before `sampler.sample`**, with the engine code unchanged. Three candidate mechanisms, all engine-untouched:

- **(M1) Seed via a `-c` preamble wrapping the helper invocation. EMPIRICALLY VERIFIED — this is the chosen mechanism.** The bridge spawns the helper not as `python evolve-db sample …` but as `python -c "import random,sys,runpy; random.seed(<S>); sys.argv=['evolve-db','sample',…]; runpy.run_path('<…>/evolve-db', run_name='__main__')"`. This seeds `random` in the same process that then runs the sampler, with zero engine change. The `runpy.run_path(run_name='__main__')` re-enters the wrapper as `__main__` and reproducibly executes its module body (which calls `main_for("db")`). Verification result: with a fixed seed, `random`/`island`/`ucb1` produce **identical** sample sequences on identical inputs, and a different seed produces a **different** sequence — confirming the single global `random` is the only RNG the samplers draw from and the preamble pins it before `sampler.sample`. **Cost:** fiddly argv construction in the bridge (must reconstruct `sys.argv`), and it only seeds the `evolve-db sample` call — but that is the only call that samples, so that is sufficient. **Critical (review nit 9): the seeded subprocess MUST inherit `PYTHONHASHSEED=0`.** It must be spawned through the existing `_run_helper`/`DETERMINISTIC_ENV` path (`evolve_result.py:17,354`), NOT a bare `subprocess.run`, or the embedding determinism that the rest of the slice relies on (`_fallback_encode_one` uses `hash()`, §3.4) is lost — and ucb1/island also `hash(node.code)` for cache keys (§3.5). The preamble seeds `random`; `DETERMINISTIC_ENV` seeds `hash()`; both are required together.
- **(M2) A tiny bridge-owned `sitecustomize.py` / `PYTHONSTARTUP`.** `PYTHONSTARTUP` only runs for interactive sessions, so it is out. A `sitecustomize.py` on `PYTHONPATH` that reads an env var (e.g. `EVOLVE_RANDOM_SEED`) and calls `random.seed` would run at interpreter startup for *every* helper — but `sitecustomize` import order and the fact that it would seed *all* helpers (not just sample) make it broader and less legible than M1. Rejected in favor of M1's surgical scope.
- **(M3) A run-spec `seed` field consumed by the bridge, applied via M1.** The seed *value* is authored by `preflight` into the run spec (a new `sampling.seed` field) and the bridge reads it and applies it via M1's `-c` preamble. **This is M1 + a durable seed source.** The seed field is the one place this slice would touch the run-spec schema — and `cmd_brief_normalize` would need a `--sampling-seed` flag, which means **adding a flag to the engine's `evolve-brief normalize` parser** (`cli.py:616-621`). That is an `evolve_core/` change, which is forbidden. **So M3-via-engine-flag is out.** A bridge-side sidecar (`preflight` writes `run_dir/sampling_seed.txt`, the bridge reads it) avoids the engine change. Since the engine has **no `--sampling-seed` flag** and adding one is forbidden, the sidecar is the **only** engine-untouched durable seed source — so **seed-source = sidecar is the decided design** (the "second source of truth" cost is unavoidable given the engine constraint, and is accepted).

**RESOLVED (was an OPEN QUESTION) — empirically verified.** M1's `runpy`-based reseeding reliably seeds `random` before `sampler.sample`: the preamble re-enters the CLI as `__main__`, and because every stochastic sampler draws from the **single** global `random` module (the engine never calls `random.seed`; `PYTHONHASHSEED` seeds only `hash()`, §3.4), one `random.seed(S)` pins them all. Empirically, `random`/`island`/`ucb1` all reproduce same-seed and diverge diff-seed on identical inputs (ucb1's cold-start `random.sample`, `ucb1.py:25`, is the only nondeterminism beyond random/island's per-sample draws, and it too is pinned). The seed mechanism is therefore **verified**, not unverified. The §11.3 reproducibility test (corrected below) is retained as a *regression guard* on this property, not as the thing that first establishes it.

**Recommendation — ship Phase A + Phase B together in this slice; the seed mechanism is verified, so Phase B is de-risked.** Because M1 is empirically proven (above), the original "ship greedy first, defer the stochastic samplers" caution no longer applies. The two phases are still worth naming because they have different determinism stories, but both can land in-slice:

1. **Phase A (deterministic, unconditional):** Fix 1 (cognition promotion) and Fix 2 (`sample_n` > 1) ship for **greedy**, which is deterministic. `preflight` may author `sample_n` > 1 with greedy — greedy with `sample_n: 3` returns the top-3 by score deterministically (`greedy.py:17`), so multi-parent recombination is fully reproducible. This delivers the biggest quality lever (cognition) and the largest behavioral gap (multi-parent) with **zero determinism risk**. Phase A is unambiguous.
2. **Phase B (stochastic samplers, now de-risked):** sampler selectability for ucb1/island/random, behind the **verified** M1 seed mechanism. `preflight` may author a non-greedy sampler **only when a seed is available** — the bridge reads a seed (from a `preflight`-authored sidecar `run_dir/sampling_seed.txt`, M3-via-sidecar) and applies it via M1. If no seed is present, the bridge refuses a stochastic sampler and the run falls back to greedy with a recorded warning. The reproducibility proof (§11.3) is retained as Phase B's regression guard: same seed → identical selections; different seed → different.

**MAINTAINER DECISION (recommend A+B together):** because the seed works, the recommended default is to **ship A+B in one slice**. The A-only option — ship Phase A now and land the stochastic samplers as an *immediate* follow-up — remains available as a strictly-smaller slice and is **the maintainer's call**. There is no longer a *technical* reason to split (the seed mechanism is proven); the only reason to split is slice-size/review-surface preference. Either way, none of the three fixes precludes the other phase, and greedy ships unconditionally.

**Why both phases are coherent:** the determinism story is *load-bearing for CI* (the gate's reproducibility proof, §11.3). Greedy needs no seed; the stochastic samplers are genuinely useful (exploration on plateaued searches — exactly what patience detects) and are now reproducible via the verified seed, so they no longer need to wait. The naming is kept only because the two phases have distinct determinism proofs (greedy: byte-identical `nodes.json`; stochastic: same-seed-identical sample sequence), not because Phase B carries open risk.

### 6.4 The `preflight` delta — authoring the sampler

Change the hardcoded `--sampling-algorithm greedy` (`workflow.yaml:216`) to an inferred `--sampling-algorithm SAMPLER`, with a step-2 inference rule:

> SAMPLER — the parent-selection strategy. Default to `greedy` (deterministic: always evolve the best-scoring parents). Choose `ucb1` when the search should balance exploiting good parents with exploring under-visited ones, `island` when diversity/recombination across sub-populations is wanted (an experiment `config.yaml` declaring island config is a strong hint), or `random` only for a diversity baseline. **You may author a non-greedy sampler ONLY if a reproducibility seed is configured** (write the seed to `/workspace/.evolve_runs/main/sampling_seed.txt` as a single integer); without a seed, use `greedy`. For `island`, also author `--sampling-feature complexity --sampling-feature diversity --sampling-feature-bins 10` unless the experiment specifies otherwise.

The seed sidecar (`sampling_seed.txt`) is the M3-via-sidecar source from §6.3 — `preflight`-authored, bridge-consumed, no engine change. The bridge's `sample` reads it (if present) and applies M1's reseeding preamble to the `evolve-db sample` invocation; it logs the resolved seed in the `sample` result payload so a run is auditable and reproducible. **Run-level immutability (§3.3):** because the sampler algorithm is in the immutable fingerprint (`cli.py:202-205`), `preflight` must author it before any node exists — which it does (preflight runs before round 1). A human `FORCE_REVISION` back to `preflight` that changes the sampler after nodes exist would hit `SAMPLING_CONFIG_IMMUTABLE_ERROR`; the `preflight` prompt already warns that a fundamental change requires a fresh run (`workflow.yaml:236-240`), which covers this.

## 7. The cognition-promotion policy (consolidated)

The recommended default, restated as one contract (full rationale in §4):

- **WHAT:** every recorded round's `current/analysis.md` lesson (§4.2), tagged with `metadata = {kind: "round_lesson", node_id, best_updated}`. Negative lessons are kept; quality is gated at authoring time by the analyzer prompt, not by a best-only filter.
- **WHEN:** in `attach_analysis`, after the durable record succeeds, on the genuine-record path only (not the idempotent-skip path) — alongside the stop-signal computation (§4.3).
- **DEDUP:** content-hash (`sha256` of the stripped lesson) against a durable `run_dir/cognition_promoted.json` ledger; verbatim repeats are skipped. Semantic near-duplicates are handled by the existing FAISS retrieval ranker, not re-implemented (§4.4).
- **GATE:** helper validation (deterministic bridge), no human gate. The only mechanical filters are "non-empty after strip" and the hash dedup.

This resolves the open cognition-update gate (`asi-evolve-native-workflow.md:1417`) in favor of unrestricted-but-validated bridge promotion.

## 8. The multi-parent contract (consolidated)

The N-parents-per-round contract, restated (full flow in §5.5):

- **`current/context.json`** carries `parents: [<node dict>, …]` (plural array, replacing the singular `parent`). `[]` on round 1; `[node]` for `sample_n: 1`; `[n0, n1, n2]` for `sample_n: 3`.
- **The researcher** reads `parents`: empty → baseline/from-scratch; one → evolve; many → recombine (§5.4).
- **`_resolve_parent`** reads the `parents` list and returns all ids; `attach_analysis` passes one `--parent` per id; `cmd_db_record` sets `node.parent = [n0, n1, n2]`.
- **`node.parent`** in `nodes.json` is the full list of sampled-parent ids for the round. The engine already supports this (`structures.py:16`); no engine change.

## 9. Parallelism (forward-looking, NON-GOAL for this slice)

ASI-Evolve runs parallel workers; IronCurtain's evolve does not. **This slice does not add parallelism** — but it must not *preclude* it, because the maintainer has flagged a parallel-workers slice as the next follow-up. The relevant facts:

- **The FSM is currently the serializer.** The hub-and-spoke loop runs exactly one round at a time: `orchestrator → sample → researcher → evaluate → analyzer → analysis_record → orchestrator`. There is one in-flight round, one `current/` scratch dir, one node appended per cycle. A parallel-workers slice would be a substantial FSM-level change (multiple concurrent in-flight rounds, a work queue, fan-in at record time) — out of scope here.
- **The durable node DB is already cross-process concurrency-safe.** `Database` wraps every mutation in `_database_guard` → `InterProcessFileLock(self.lock_path)` (`database.py:206-215`) and writes `nodes.json` via atomic `os.replace` (`:162`). So `evolve-db sample` and `evolve-db record` — including multi-parent record (Fix 2) — are already safe under concurrent workers. **Fix 2 introduces no new global/serial assumption:** it widens the parent list that flows through the already-locked record path; the locking is unchanged.

**Parallelism implications of each fix:**

- **Fix 1 (cognition promotion) — the one fix with a real parallelism caveat.** The cognition store is **NOT** cross-process safe: `Cognition` uses only an in-process `RLock` (`cognition.py:30`) and `_save()` is a plain non-atomic `json.dump` (`:103-112`) with no `InterProcessFileLock`. Two concurrent `evolve-cognition add` calls (which a parallel-workers slice would produce, one per worker promoting its round's lesson) could lose-update or corrupt `cognition.json`. **Today this is fine** (the FSM serializes, so promotions never overlap), but the design must not *bake in* the serial assumption. Two safeguards: (1) the dedup ledger (`run_dir/cognition_promoted.json`, §4.4) is read-modify-write and must itself be done under an `InterProcessFileLock` (the bridge owns this file, so it can lock it without touching the engine) — the §4.5 helper notes this lock requirement explicitly; (2) the design records that **a future parallel-workers slice must make `Cognition._save` cross-process safe** (either by adding an `InterProcessFileLock` around `evolve-cognition add` in the *bridge*, since the engine is byte-verbatim, or by serializing all cognition adds through a single writer). The bridge-side lock is the engine-untouched path and is the recommended future fix. **The key invariant Fix 1 preserves:** the promotion goes through a bridge shell-out that *can* be wrapped in a file lock without an engine change — it does not embed any assumption that only one writer exists. The §4.5 helper is written to lock the ledger; extending that lock to cover the `evolve-cognition add` call is a one-line future change, not a redesign.
- **Fix 2 (multi-parent) — no parallelism implication.** As above, the record path is already file-locked. Multi-parent recombination is orthogonal to worker count: each worker records its own node with its own parent list through the locked DB.
- **Fix 3 (sampler selection) — one caveat, already handled.** Sampler *state* (e.g. island's `island_generations`, `archive`) is persisted in `nodes.json` under `sampler_state` (`database.py:144-145`) and reloaded under the lock (`:182-183`). So concurrent samples re-load the latest state under the lock — safe. The seed mechanism (§6.3) is per-`evolve-db sample` subprocess; under parallel workers each worker would need a *distinct* seed (e.g. `base_seed + worker_id`) to avoid all workers sampling identically — the design notes this as a parallelism consideration for the seed scheme, but it is a future concern (today there is one worker, one seed).

**Net:** the only thing this slice must be careful about for future parallelism is the cognition-store write path (Fix 1), and the mitigation is a bridge-side file lock that requires no engine change. Everything else rides the engine's existing `InterProcessFileLock`. The design avoids any new serial assumption that a parallel slice would have to unwind.

## 10. Determinism implications (consolidated)

The whole-slice determinism story (full detail in §3.4, §6.3):

- **Cognition promotion (Fix 1) is deterministic** under the existing `PYTHONHASHSEED=0` pin: the `evolve-cognition add` shell-out goes through `_run_helper` (`evolve_result.py:354`), so the promoted lesson embeds deterministically (`_fallback_encode_one` uses `hash`, `embedding.py:72`) and is retrievable deterministically. The dedup hash (`sha256`) is content-deterministic. No new nondeterminism.
- **Multi-parent (Fix 2) is deterministic given a deterministic sampler.** The parent list is whatever `evolve-db sample` returns; under greedy that is the deterministic top-N by score. The widening from one parent to N adds no randomness.
- **Sampler selection (Fix 3) is where determinism is at stake.** Greedy: deterministic, ships unconditionally (Phase A). ucb1/island/random: stochastic, made reproducible by the M1 seed mechanism (Phase B), which is **empirically verified** (§6.3); §11.3 is the regression guard on that property, not the proof that first establishes it. The seed is `preflight`-authored (sidecar) and bridge-applied through `_run_helper`/`DETERMINISTIC_ENV` (so `PYTHONHASHSEED=0` is inherited) — engine untouched.
- **`created_at` normalization** (the multi-round slice's existing convention) still applies to any byte-for-byte `nodes.json` comparison — timestamps are normalized at comparison time, not pinned.

So Phase A (cognition + multi-parent + greedy) is fully reproducible today; Phase B (stochastic samplers) is reproducible via the M1 seed mechanism, which is **empirically verified** (§6.3) — the §11.3 reproducibility test is now a regression guard on that property, not the proof that first establishes it.

## 11. Binary completion gate

The slice is done when all of the following pass. The test ladder mirrors the correctness slice: deterministic bridge unit tests pin the mechanics; Docker integration tests prove the wiring end-to-end; the honest limitation is stated, not papered over.

### 11.1 Bridge unit tests (`test/workflow/evolve-result-bridge.test.ts`, deterministic, no LLM/Docker)

These extend the existing `describe('evolve_result.py bridge')` block, which drives the real `evolve_result.py` via `spawnSync` over crafted run dirs (`evolve-result-bridge.test.ts:158,209`). **Critical distinction (the existing harness STUBS the engine).** `writeHarness` (`evolve-result-bridge.test.ts:187-200`) writes *stub* `evolve-db`, `evolve-cognition`, and `evolve-eval` scripts that print hardcoded JSON (e.g. the `evolve-db` stub always returns `node_id: 0`; the `evolve-cognition` stub always returns a fixed seed match). So tests built on the standard stub harness exercise the **bridge's argv/IO wiring against stubs — NOT the real engine.** Several headline assertions below cannot be proven against stubs and **must run against the REAL `evolve_core/` helpers** (the real `evolve-db`/`evolve-cognition`, invoked over a real run dir). The real engine runs in CI **without faiss** via the numpy brute-force fallback (`vector_index.py:12-18` guards the `import faiss`; `embedding.py` Tier-0 `hash`-based encode), so no native dependency is needed — only `PYTHONHASHSEED=0` (already supplied by `DETERMINISTIC_ENV`) for embedding determinism. Each case below is tagged **[stub harness]** (standard `writeHarness`) or **[REAL engine]** (must invoke the real `evolve_core/` helpers, not the stubs):

1. **[REAL engine] Cognition promotion writes to the store (Fix 1).** Build a run dir with a recorded round and a `current/analysis.md` lesson; run `attach_analysis` with the **real `evolve-cognition`** (the stub never writes a store); assert (a) the result payload's `cognition_promoted.promoted == true` with `items_added == 1`, (b) `cognition_data/cognition.json` now contains an item whose `content` is the lesson and `metadata.kind == "round_lesson"`, and (c) `run_dir/cognition_promoted.json` records the lesson's hash.
2. **[REAL engine] Promotion dedups verbatim repeats (Fix 1).** With the real `evolve-cognition`, run `attach_analysis` twice with the *same* lesson text for two different steps; assert the second returns `cognition_promoted.promoted == false, reason == "duplicate"` and the store has exactly one item. (The dedup ledger is bridge-owned, but the "store has exactly one item" assertion reads the real store.)
3. **[stub harness OR REAL engine] Promotion is skipped on the idempotent path (Fix 1 + correctness slice).** Pre-seed a node for the step (so the idempotency guard fires); run `attach_analysis`; assert `idempotent_skip == true` and **no** cognition item was added (the skip path must not promote). The "skip" payload assertion is pure bridge logic (stub-safe); to additionally assert the **store** is untouched, use the real `evolve-cognition`.
4. **[REAL engine] Promote→retrieve across rounds (Fix 1, the headline assertion).** Requires real embedding/retrieval — the stub returns a fixed match and cannot prove retrieval. With the real `evolve-cognition`, promote a lesson in step N (`attach_analysis`), then run `sample` for step N+1 (with `--query-from-spec`) and assert `current/context.json`'s `cognition.matches` includes the promoted lesson's content — proving cross-lineage retrieval works (via the numpy/Tier-0 fallback under `PYTHONHASHSEED=0`), not just that the store grew.
5. **[REAL engine] Multi-parent context shape (Fix 2).** Requires real `evolve-db sample` to return ≥ 3 real nodes (the stub returns a single hardcoded `node_id`). Build a run dir with ≥ 3 real recorded nodes; run `sample` with `--n-from-spec` against a spec with `sample_n: 3`; assert `current/context.json` has `parents` as a list of length 3 (and no singular `parent` key), and the result payload's `parent_ids` has 3 ids. (This case also pins SF4: with `sample_n: 3` authored and `--n-from-spec`, the bridge must NOT forward a hardcoded `1`.)
6. **[REAL engine] Multi-parent record (Fix 2).** Needs the real `evolve-db record` to write `nodes.json`. With a `context.json` carrying `parents: [{id:0},{id:1},{id:2}]`, run `attach_analysis --parent-from-current`; assert the recorded node in the real `nodes.json` has `parent == [0,1,2]`.
7. **[REAL engine] Sampler selection reaches the engine (Fix 3).** Needs the real `evolve-db` to write `round_log.jsonl` (the stub does not). Author a spec with `sampling.algorithm: ucb1` (+ seed sidecar); run `sample`; assert `round_log.jsonl`'s `db_sample` entry records `"algorithm": "ucb1"` (`cli.py:413`) — proving the authored sampler reached `cmd_db_sample`.
8. **[no engine — manifest only] `workflow.yaml` manifest assertions** (extend the existing `describe('evolve workflow manifest')` block): the `preflight` prompt no longer contains the literals `--sampling-algorithm greedy`/`--sample-n 1` and instead contains the `SAMPLER`/`SAMPLE_N` placeholders; the `researcher` prompt references `parents` (plural). No engine or stub is involved (static YAML inspection).

### 11.2 Docker integration tests (`test/workflow/evolve-search-quality.integration.test.ts`, gated `describe.skipIf(!dockerReady)`)

New file mirroring `evolve-multi-round.integration.test.ts` (mock orchestrator + `MockSession` + real Docker container + the real bridge/engine). Gated on `INTEGRATION_TEST=1` + Docker availability (`evolve-correctness.integration.test.ts:46-47`). Assertions on the durable `nodes.json` / `cognition.json`:

1. **Multi-parent lineage recorded end-to-end.** A 3-round run authored with `sample_n: 3` produces at least one node with `parent.length > 1` in `nodes.json`.
2. **Cognition promotion crosses rounds end-to-end.** After ≥ 2 rounds, `cognition.json` contains items with `metadata.kind == "round_lesson"` (not just seed items), and a later round's `current/context.json` carried a match whose source is a prior step (not the seed).
3. **Sampler selection honored end-to-end.** A run authored with the chosen sampler reaches `done` and `round_log.jsonl` records the chosen algorithm on every `db_sample`.

### 11.3 The determinism / reproducibility proof

- **Phase A (greedy, ships unconditionally):** two greedy integration runs with identical inputs produce byte-identical `nodes.json` modulo `created_at` (the multi-round slice's normalization convention). This is the existing determinism bar, preserved with `sample_n` > 1 (greedy top-N is deterministic).

- **Phase B (stochastic samplers, M1 seed — VERIFIED; this test is the regression guard).** **A naive "run `sample` twice on the SAME run dir with the same seed and assert identical `parent_ids`" is WRONG and will false-fail for ucb1/island.** The reason: `db.sample` calls `_save_locked()` after sampling (`database.py:60`), which persists mutated sampler state back to `nodes.json` — ucb1 increments `node.visit_count` (`ucb1.py:27`) and island writes its `sampler_state` via `get_state()` (`database.py:144-145`), reloaded on the next sample (`database.py:182-183`). So the *first* seeded sample mutates the DB the *second* sample reads, and the two same-run-dir samples legitimately differ even with the same seed (empirically ucb1 went `[7,0,6]` → `[1,2,3]`). Only `random` (stateless across calls) is safe under a same-run-dir double-sample. The real reproducibility property is **same seed + same *starting* DB ⇒ identical sample sequence**, which requires the second sample to start from the *same* DB state as the first, not the post-mutation state. Use these forms instead:

  - **(b, recommended — the honest end-to-end property)** Two **independent** runs, each seeded from round 0 with the **same** seed, over **identical** starting inputs; assert the two runs' sample sequences (the per-round `parent_ids`, or the final `nodes.json` lineage modulo `created_at`) are **identical**. Then a third run with a **different** seed; assert it **differs**. This is the genuine "same seed ⇒ reproducible run" property and exercises ucb1/island/random correctly because each run's first seeded sample sees the same fresh DB.
  - **(a — focused bridge-level unit)** Run two seeded samples against the **same** run dir but **reset/restore `nodes.json` to its pre-sample state** between them (snapshot the file before the first sample, restore it before the second), so the second sample starts from the identical DB. Assert identical `parent_ids`. This isolates the seed mechanism from the state-persistence confound and is cheap (no Docker).
  - **(c — narrowest deterministic assertion)** Scope a same-run-dir double-sample assertion to `sampling.algorithm: random` only, since `random` is stateless across `sample` calls (no `visit_count`/`sampler_state` mutation) and so a same-dir double-sample IS valid for it. Do **not** apply this assertion to ucb1/island.

  Recommend **(b)** as the honest end-to-end reproducibility proof and **(a)** as a focused bridge-level unit on the seed bridge. The "different seed ⇒ different selections" half is run alongside (b). All forms must spawn the seeded subprocess through `_run_helper`/`DETERMINISTIC_ENV` so `PYTHONHASHSEED=0` is inherited (§6.3, review nit 9) — a bare seeded `subprocess.run` loses embedding/`hash`-cache determinism. Because the M1 mechanism is already empirically verified (§6.3), this test is a **regression guard**, not the gate that first establishes reproducibility.

### 11.4 The honest mock-orchestrator limitation

As in every prior evolve slice, the integration tests **mock the orchestrator** (scripted verdicts via the `orchestratorScript` pattern; the LLM hub's real routing is never exercised in CI). So:

- The integration tests prove the **bridge/engine wiring** (cognition promoted to disk, multi-parent recorded, sampler honored) but **not** that the real LLM researcher genuinely recombines multiple parents or that the real analyzer writes a transferable (vs score-restating) lesson. Those are LLM-quality properties, validated only by **live runs** (the circle-packing demo, where `sample_n: 3` + cognition promotion should measurably improve the best score trajectory vs the greedy/single-parent baseline).
- The bridge unit tests (§11.1) are the rung that matters most for the mechanical contracts — they run the *real bridge* over crafted inputs, with no LLM and no mock. **Whether they run against the real *engine* or against stubs is per-case (§11.1 tags each):** the standard `writeHarness` stubs `evolve-db`/`evolve-cognition`/`evolve-eval` (`evolve-result-bridge.test.ts:187-200`), so the headline assertions that need real engine behavior — promote→retrieve (#4, real embedding/retrieval), multi-parent record (#6, real `evolve-db record` → `nodes.json`), the store-write/dedup cases (#1, #2), the `round_log.jsonl` sampler assertion (#7), and the §11.3 seeded-`sample` reproducibility — **must invoke the real `evolve_core/` helpers, not the stubs.** Those cases run the real engine via its faiss-free numpy fallback (no native dependency). Cases that only check bridge argv/IO (#3 skip-payload, #8 manifest) may use the stub harness. Do not over-claim that all §11.1 cases run "the real bridge and engine"; the stub harness exercises wiring only.
- The doc does **not** claim CI proves search-quality *improvement* — only that the machinery (promotion, multi-parent, sampler selection) is wired and reproducible. Improvement is an LLM-and-objective-dependent property demonstrated live, not gated.

### 11.5 Lint

`tsx src/cli.ts workflow lint src/workflow/workflows/evolve/workflow.yaml --strict` is clean (no FSM topology changed, so no new WF-code risk), and the existing evolve gates (single/multi-round/human-surface/harness/correctness) all still pass. `npm run lint` + `npm run format` clean on the touched files.

## 12. Risks / open questions / maintainer decisions

### 12.1 Maintainer decisions

1. **Cognition-promotion scope — DECIDED (maintainer): every round, with content-hash dedup (§4.2).** Promote every round's lesson with `best_updated`/`score` as metadata (keeps negative lessons; quality gated by the analyzer prompt). The improving-only escape hatch remains available if store pollution later hurts retrieval.
2. **Sampler scoping — DECIDED (maintainer): ship A+B together (§6.3).** Phase A (greedy + `sample_n` > 1 + cognition promotion, deterministic) AND Phase B (stochastic ucb1/island/random behind the empirically-verified sidecar seed) land in this one slice. The M1 mechanism is verified, so Phase B is de-risked; the full sampler gap (the worked example's `island` + `sample_n: 3`) closes in one increment.
3. **Cognition-update gate disposition — adopted default (§4.4, resolving `asi-evolve-native-workflow.md:1417`):** helper-validated bridge promotion, no human gate, content-hash dedup. Revisit only if cognition quality becomes a problem.
4. **Default `sample_n` for from-scratch toy tasks — adopted default (§5.2):** 1 (preserves today's behavior); experiments author their own (commonly 3).

### 12.2 Resolved decisions + remaining open questions

1. **M1 seed mechanism viability (§6.3) — RESOLVED, empirically verified.** `python -c "import random,runpy; random.seed(S); runpy.run_path('evolve-db', run_name='__main__')"` (spawned through `_run_helper`/`DETERMINISTIC_ENV` so `PYTHONHASHSEED=0` is inherited) reliably seeds `random` before `sampler.sample` for all stochastic samplers, engine untouched. The single global `random` is the only RNG the samplers draw from; one `random.seed(S)` pins ucb1/island/random. Verified: same-seed reproduces, diff-seed diverges, on identical inputs. ucb1's cold-start `random.sample` (`ucb1.py:25`) is the only nondeterminism beyond random/island's per-sample draws, and it too is pinned. The §11.3 test is now a *regression guard*. No longer an open question.
2. **Seed source — RESOLVED: sidecar.** A run-spec `sampling.seed` field would be cleaner but requires an `evolve-brief normalize --sampling-seed` flag, which is an `evolve_core/` engine change (forbidden). The `preflight`-authored `sampling_seed.txt` sidecar is therefore the **only** engine-untouched durable seed source, so **seed-source = sidecar is decided** — the "second source of truth" is an accepted cost of the byte-verbatim-engine constraint, not an open trade-off.
3. **`context.json` `parent`→`parents` rename blast radius — RESOLVED (and corrected): safe at runtime, requires updating listed TESTS.** No runtime consumer (web UI, `workflow inspect`, checkpoint) reads the singular `parent` key — the rename is safe within the runtime path (`sample`/researcher/`_resolve_parent` changed together). **But the original grep was scoped to `src/` and missed `test/`:** existing tests read/write the singular key and must be migrated — `evolve-result-bridge.test.ts:730,734,766-768,818,842` and `evolve-experiment-harness.integration.test.ts:217,221` (see §5.5 for the full list). So the correct framing is "safe but requires updating those tests," not "no changes needed."
4. **Per-worker seed scheme for future parallelism (§9) — open, out of scope.** If a future parallel-workers slice lands, each worker needs a distinct seed (`base + worker_id`) or all workers sample identically. Out of scope here, but the seed scheme should be designed not to assume a single worker.

### 12.3 Risks

1. **Cognition store pollution (Fix 1).** Promoting every round's lesson could fill the store with low-value or near-duplicate insights, degrading retrieval precision. Mitigations: content-hash dedup (verbatim repeats), FAISS similarity ranking (semantic near-duplicates down-weighted), and the `best_updated` metadata for a future quality-aware retrieval. Residual risk: a verbose analyzer that emits many distinct-but-low-value lessons. Watched via the live demo's retrieval-match quality.
2. **Cognition store concurrency (Fix 1, future).** The store is not cross-process safe (§9). No risk today (serial FSM); a real risk for the parallel-workers follow-up, with a clear engine-untouched mitigation (bridge-side `InterProcessFileLock`). The design records the requirement so the future slice does not discover it the hard way.
3. **Multi-parent context bloat (Fix 2).** `sample_n: 3` puts three full parent-node dicts (including `code`) into `context.json` and thus the researcher's context window. For large candidates this could be heavy. Mitigation: the `sample_n ≤ 5` bound in the `preflight` prompt (§5.2); if needed, a future refinement could pass parent *summaries* rather than full code. Low risk for circle-packing-scale candidates.
4. **Stochastic-sampler reproducibility (Fix 3) — largely retired.** The M1 seed mechanism is empirically verified to pin `random` (§6.3, §12.2-1), so Phase B's stochastic samplers ARE reproducible. The residual risk is narrow: a regression in the seed-preamble plumbing (e.g. spawning the seeded subprocess through a bare `subprocess.run` instead of `_run_helper`, which would drop `PYTHONHASHSEED=0` and break the `hash`-based embedding/cache determinism even while `random` is seeded). Mitigation: the §11.3 reproducibility test (in its corrected, non-double-sample form) is the regression guard; and Phase A (greedy) is unaffected regardless.
5. **Run-level sampler immutability surprise (Fix 3).** A human `FORCE_REVISION` that changes the sampler after nodes exist hits `SAMPLING_CONFIG_IMMUTABLE_ERROR` (`cli.py:202-205`). Mitigation: the `preflight` prompt already directs a fresh run for fundamental changes (`workflow.yaml:236-240`); the design should ensure the error surfaces as a legible `blocked` verdict (the existing `preflight ─blocked→ failed` / human-gate path), not an opaque crash.
