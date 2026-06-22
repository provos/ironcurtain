# A Representative Eval Set for Memory Hybrid-Fusion Retrieval — Feasibility & Proposal

Status: **Proposal + feasibility assessment** (2026-06-21). NOT an implementation. Scopes whether we
can synthesize a *production-representative* retrieval eval from Claude Code session logs to fix the
metadata-flatness bug that broke the first ASI-Evolve dogfood. Every load-bearing claim is grounded
in `file:line` or a measured artifact.

Read-with: [`evolve-memory-fusion-dogfood.md`](./evolve-memory-fusion-dogfood.md) (the harness we
already built — reuse it), [`evolve-target-workloads.md`](./evolve-target-workloads.md) §2 (why this
dogfood exists).

---

## 0. The motivating failure (read first)

We ran ASI-Evolve on the memory fusion code (`packages/memory-mcp-server/src/retrieval/scoring.ts`)
against **LoCoMo** (`benchmark/data/locomo10.json`), with the cached-pool harness in
`benchmark/fusion-evolve/`. The winning candidate "improved" recall by **dropping the
recency/importance/access composite terms** from `computeCompositeScore` (`scoring.ts:129-145`).

It won because **those three metadata signals are dead in LoCoMo** — and I verified this empirically
against the *shipped* fixture (`benchmark/fixture/locomo-pool.jsonl`, 39 MB):

- **`importance` is the single constant `0.5`** across the entire fixture. Ground truth:
  `benchmark/locomo/ingest.py:40` and the TS port `build-locomo-fixture.ts:114` both call
  `store(..., importance: 0.5)` for *every* turn. Measured: the set of distinct `importance` values
  over the first 200 fixture records is exactly `{0.5}`. So `0.1 * memory.importance`
  (`scoring.ts:145`) is a **constant added to every candidate** — it cannot change any ranking.
- **`created_at` is one ingest batch.** Every turn is stored in a single tight loop
  (`build-locomo-fixture.ts:216-221`), then `now` is frozen *once* (`:224`). Spread is sub-second
  against a ~30-day half-life (`Math.exp(-0.001 * ageHours)`, `scoring.ts:134`), so the recency term
  is **flat to ~5 decimal places** across candidates.
- **`access_count` is near-zero noise.** Measured distinct values `{0..9}` — these come only from the
  same memory being re-retrieved *during the dump itself* (`updateAccessStats`, `queries.ts:120-134`,
  called at `pipeline.ts:172`); they carry no signal about query relevance.

So the eval was **unrepresentative on exactly the axis the "improvement" exploited.** In production
those signals are **LIVE**:

- `importance` is a settable tool argument — `memory_store`'s `importance: z.number().min(0).max(1)`
  (`server.ts:43-48`), "Higher values resist decay."
- `access_count` / `last_accessed_at` update on **every** retrieval (`updateAccessStats`,
  `queries.ts:120-134`; called for returned memories at `pipeline.ts:172`).
- An **"unused memories decay over time"** maintenance pipeline reads all three:
  `computeVitality` (`maintenance.ts:74-91`) decays a memory using `created_at`, `importance`
  (half-life ∝ importance, `:78`), `access_count` (reinforcement, `:84`), and `last_accessed_at`
  (`:87`). A candidate that ignores these signals at retrieval time fights the decay model that
  *keeps the high-importance, frequently-accessed memories alive in the first place.*

**Porting the LoCoMo winner to production would likely hurt.** The eval must be representative on the
metadata axis. That is the entire reason this document exists.

---

## 1. What a representative eval set MUST satisfy (derived from the failure)

| # | Requirement | Why (grounded) |
|---|---|---|
| **R1** | **Live metadata signals.** Memories accrue over real wall-clock time (`created_at` spans days), with varying `importance`, and `access_count`/`last_accessed_at` reflecting real re-use. | The LoCoMo bug: all three flat. Production reads all three at retrieval (`scoring.ts:129-145`) *and* in decay (`maintenance.ts:74-91`). |
| **R2** | **Production content distribution.** An *agent's* accumulated memories — facts, decisions, preferences, project/code knowledge — NOT two-persona social dialogue. | A "memory" is whatever the caller stores via `store(content, opts)` (`engine.ts:25`); the server does **no** extraction (§2). LoCoMo/LongMemEval ingest raw chat turns 1:1 (`ingest.py:36-48`). That is not the production distribution. |
| **R3** | **Relevance queries.** Given a new task/context, *which past memories are relevant* — not factual-evidence QA ("When did Caroline go to the LGBTQ support group?", a real LoCoMo query, `evolve-memory-fusion-dogfood.md:61`). | The production call is `memory_recall(query)` → "what should I remember that bears on this task," `recall.ts`. |
| **R4** | **Ground-truth relevance labels** — the crux. See §4. | The metric is pure set-membership (`scoring-lib.mjs:26-36`); it needs a gold set per query. |
| **R5** | **Realistic budget(s).** Score at the production default `2000` AND a ranking-stress budget. | `MEMORY_DEFAULT_TOKEN_BUDGET=2000` (memory CLAUDE.md). The harness already tightened to `300` *deliberately* — `scoring-lib.mjs:11`: "at 2000 recall is near-saturated (0.81 of a 0.91 ceiling) and ranking barely matters; 300 makes ranking the lever." |
| **R6** | **Comprehensiveness.** Spans the agent's real memory types; large enough to be statistically meaningful. | LoCoMo gives ~1,500-2,000 scorable queries; a representative set should be comparable. |

---

## 2. What a "memory" actually is (confirms R2)

Verified against the engine surface, because the task asked whether we can reuse a built-in
extraction path:

- **`MemoryEngine` is `store(content, opts) / recall(opts) / context / forget / inspect / close`**
  (`engine.ts:24-31`). `store` takes **pre-formed `content`** plus `{ tags?, importance? }`
  (`StoreOptions`, `engine.ts:19-22`). The schema row is `{ id, content, tags, importance,
  created_at, updated_at, last_accessed_at, access_count, ... }` (`database.ts:6-20`,
  `types.ts:6-20`).
- **There is NO transcript→memory extraction path in the server.** The closest things are
  `compaction.ts` (LLM clusters + summarizes *already-stored* memories) and `consolidation.ts`
  (dedup at store time) — both operate on existing rows, neither turns a conversation into discrete
  memories. The store tool description (`server.ts:36-38`) says content "should be a single fact,
  observation, decision, or preference" — i.e. **the caller is expected to have already extracted.**

**Conclusion for the pipeline: extraction is ours to define.** We cannot "reuse the server's ingest."
The session-logs pipeline must (a) extract discrete memories from transcripts, (b) call
`engine.store(content, { tags, importance })` with derived metadata, then (c) reuse the **existing**
dump tap + evaluator (§5) verbatim. This is a feature, not a gap: it means the eval's content
distribution is whatever *we* choose, so we can make it agent-coding-work (R2) instead of chat turns.

---

## 3. The Claude Code session-logs synthesis pipeline (core of the proposal)

### 3.1 The raw material — VERIFIED structure

Logs live at `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`. Measured on this machine:

- **26 project dirs, 308 MB total** (`du -sh ~/.claude/projects` = `308M`). The IronCurtain project
  alone has **20 session files**, largest 20 MB.
- **Entry types** (one 20 MB session): `user`, `assistant`, `system`, `attachment`,
  `file-history-snapshot`, `tool` results inside `user` entries, plus harness bookkeeping (`mode`,
  `permission-mode`, `pr-link`, `ai-title`, …). The load-bearing ones are `user` and `assistant`.
- **Per-entry ISO-8601 timestamps EXIST.** 5,494 timestamped entries in one file; across all 40
  files, **36,755 timestamped entries spanning 2026-04-14 → 2026-06-22 (~2.3 months).**
  *This is the single fact that makes recency real* — unlike LoCoMo's one-batch ingest, these
  memories would carry a genuine multi-week `created_at` gradient (R1).
- Each `user`/`assistant` entry also carries `cwd`, `gitBranch`, `sessionId`, `uuid`, `parentUuid`
  (verified key list). `cwd` → per-project scoping; `parentUuid` → causal thread.
- **`user` entries** carry either a string (a real prompt, e.g. `"please carefully review
  @docs/designs/asi-evolve-native-workflow.md …"`) or a list with `tool_result` blocks.
- **`assistant` entries** carry a list of `text` blocks and `tool_use` blocks — verified a `Bash`
  call with `input.command`/`input.description`, and `Read`/`Edit` calls expose `file_path`. So
  **file references and tool actions are recoverable per entry** (load-bearing for both extraction
  and the behavioral labeling in §4).

> **Feasibility verdict on the raw material: GREEN.** Per-entry timestamps, cwd, file paths, and
> tool calls all exist. Recency (R1) is derivable from real entry timestamps, not file mtimes.

### 3.2 Memory extraction (transcript → discrete memories)

A new **offline** tool (NOT on the server hot path — same layering discipline the existing tap
respects, `pipeline.ts:44-54`). Proposed name: `benchmark/session-logs/extract.ts`.

Input: a set of `<session>.jsonl` files. Output: a list of `{ content, tags, created_at, importance,
access_signals }` records ready for `engine.store`.

Two extraction strategies, in increasing fidelity (recommend starting with the cheap one):

- **(E1) Heuristic / structural extraction (no LLM).** Mine high-signal spans directly:
  - **User prompts** → "task/intent" memories (the `user` string content).
  - **Assistant decision statements** → `text` blocks containing decision language (the assistant
    summarizing what it did / chose).
  - **File-knowledge memories** → from `Read`/`Edit`/`Bash` `tool_use` inputs: "file `X` does `Y`"
    keyed on `file_path` (recoverable, §3.1).
  - **Preferences** → user corrections ("no, don't…", "always use…") — pattern-matchable.

  Cheap, deterministic, no circularity risk, no API cost. Lower recall on subtle facts.
- **(E2) LLM-assisted extraction.** Feed transcript windows to a model with the *store* tool
  description (`server.ts:36-38`: "a single fact, observation, decision, or preference") and ask it
  to emit discrete memories — exactly how a real agent using this server would behave. Higher
  fidelity, mirrors production usage, but adds API cost and a **provenance** burden (each extracted
  memory must keep a back-pointer to its source entry `uuid`(s) so §4 labeling can work).

**Metadata derivation (the R1 fix — this is the whole point):**

- **`created_at`** = the **source entry's real timestamp** (§3.1). A memory extracted from an
  April session is genuinely older than one from June. Recency (`scoring.ts:134`) becomes a *live*
  signal with a real multi-week spread, not LoCoMo's flat batch.
- **`importance`** = derived, NOT constant. Candidate signals (pick a documented formula, freeze it):
  decision/preference memories > incidental file reads; memories the user explicitly emphasized;
  memories on a `gitBranch` that later merged. Crucially **`importance` must take ≥3 distinct values**
  or we have re-created the LoCoMo bug. (Sanity-gate the fixture: assert `distinct(importance) ≥ 3`.)
- **`access_count` / `last_accessed_at`** = derived from **cross-session re-reference**: how often a
  fact/file/decision reappears in *later* sessions (a file re-Read, a decision restated, a term
  recurring). This is real re-use, and it is the *same* signal §4(a) uses for labeling — so we get
  both metadata and labels from one provenance pass. To stay representative, simulate the production
  feedback loop: replay queries in timestamp order and let `updateAccessStats` (`queries.ts:120-134`)
  fire naturally, so `access_count` at query *t* reflects only accesses *before* t (no leakage).

> **Design note (avoid a subtle leak):** if `access_count` is derived from the *same* future
> re-references that define the gold label (§4a), then a candidate could "cheat" by ranking on
> `access_count` to predict the label. Mitigation: derive `access_count` only from re-references in
> the window `[memory.created_at, query.created_at)` (strictly past), never from the post-query
> window the label is drawn from. This keeps the metadata causal and the label honest. **Flag this as
> an open risk for the adversarial reviewer** — it is the most likely place a representative-looking
> eval silently re-introduces circularity.

### 3.3 Query construction (transcript → "which past memories are relevant")

A **query** is a later-session task/context; the **gold set** is the earlier memories relevant to it.

- **Query text** = a real later user prompt (`user` string content) or a synthesized "task context"
  (the first N tokens of a session's opening prompt + cwd + branch). Using the *actual* prompt keeps
  the query distribution real (R3).
- **Temporal split is mandatory:** a query at time *t* may only be answered by memories with
  `created_at < t`. Enforced by processing sessions in timestamp order. This is what makes recency
  meaningful and prevents "retrieving the future."

### 3.4 Fixture shape — REUSE the existing schema

The extracted memories are stored via `engine.store`, then the **existing dump tap fires unchanged**:
`pipeline.ts:98-101` already dumps `{ id, dia_id, vector_distance, bm25_score, created_at,
last_accessed_at, access_count, importance, content_length }` per candidate (`FixtureCandidate`,
`dump.ts:18-33`). The only change is the **gold key**: replace `gold_dia_ids` with
`gold_memory_ids` and tag each stored memory with a stable `mem_id:<uuid>` (mirroring LoCoMo's
`dia_id:<id>` tag, `ingest.py:79`). The evaluator (`scoring-lib.mjs`) is then a one-field rename.

**This is the big payoff of the session-logs path: we built the dump + rescore loop for LoCoMo
already (`evolve-memory-fusion-dogfood.md`), and it is content-agnostic. We are swapping the
*ingest+label* front-end, not the harness.**

---

## 4. LABELING — the make-or-break (be rigorous about circularity)

The trap: if the gold set is produced by the **same fusion/embedding the eval is meant to test**,
the eval just rewards the current ranker — circular. Honest evaluation of the three options:

### (a) Behavioral / implicit — "the agent actually re-referenced it" — RECOMMEND as primary

A past memory is **relevant to a later query** iff, in the transcript, the agent *actually used that
fact* while serving that task: it re-opened the same `file_path`, restated the same decision, or the
distinctive fact/term reappears in the later session's `tool_use`/`text`.

- **Why it is NOT circular:** the label comes from **observed human+agent behavior recorded in the
  logs**, computed from `tool_use` inputs and entry text — it never calls `embedQuery`,
  `hybridScoreFusion`, or the reranker. It is ground truth from *actual usage*, the gold standard
  LoCoMo's hand-annotated `evidence` only approximates. This is the same provenance signal that feeds
  `access_count` (§3.2) — one pass, two products.
- **Honest weaknesses:** (i) **sparse** — most past memories are never re-referenced, so positives
  are few; (ii) **noisy** — a file re-Read for an unrelated reason is a false positive; a relevant
  memory the agent *re-derived from scratch* instead of recalling is a false negative; (iii) it
  measures "what the agent did re-use," which is a *lower bound* on "what was relevant." Mitigate with
  a per-query positive floor (drop queries with <1 behavioral positive) and string/AST-level matching
  for file and decision re-use rather than fuzzy similarity.

### (b) LLM-judged relevance — scalable but circular-risk

Ask a model "is memory M relevant to query Q?" for each candidate pair.

- **Scalable** and gives dense labels. **But two failure modes:** (i) **circularity** — an LLM judge
  ranks on semantic similarity, the *same* signal the vector arm of the fusion uses, so it rewards
  the embedding the eval should test independently; (ii) **cost** — O(queries × candidates) judge
  calls. Acceptable only as a *secondary* signal or spot-check, never the sole gold.

### (c) Hybrid + human spot-check — RECOMMEND as the actual strategy

- **Gold = (a) behavioral.** It is non-circular by construction.
- **Use (b) LLM-judge ONLY to triage**, never as gold: surface candidates the behavioral pass missed
  for *human* review (catches false negatives in (a) cheaply), and flag behavioral positives that look
  like coincidental file touches for removal. The human (not the LLM, not the ranker) is the final
  arbiter on the spot-checked subset.
- **Human spot-check a sample** (e.g. 50 queries) to estimate the precision/recall of the behavioral
  labels themselves, and report it as the eval's *own* error bar.

> **Why this is defensible to an adversarial reviewer:** the primary label is *behavioral re-use
> recorded in logs* — it cannot reward the ranker because it never invokes the ranker. The LLM only
> *surfaces candidates for human review*; it does not assign gold. The single residual circularity
> risk is the `access_count`/label coupling (§3.2 design note), which the strict-past window closes.

---

## 5. Reuse the cached-fixture pattern (don't rebuild the harness)

The whole point of the existing dogfood is that **the per-round eval is pure / fast / zero-model-call /
no-network** via a cached candidate-pool fixture + a Node rescore loop. That pattern transfers
unchanged:

1. **Dump once, offline.** Ingest the extracted session-log memories (with LIVE metadata) into a temp
   DB, run `engine.recall(query)` per constructed query with `MEMORY_FIXTURE_DUMP_DIR` set; the tap
   at `pipeline.ts:98-101` writes the raw vector+FTS pool (which already carries all five composite
   fields, `dump.ts:18-33`). The real BGE embedder + sqlite-vec + FTS5 run **only here**
   (`build-locomo-fixture.ts:27,204` use the production `MemoryEngine` directly — reuse this driver,
   swap the ingest + gold-join).
2. **Rescore loop = the evaluator we already have.** `benchmark/fusion-evolve/evaluator.mjs` +
   `scoring-lib.mjs` rescore a candidate's `rankPool(pool, budget)` against the gold set by
   set-membership — **deterministic, sub-second, zero model calls** (`evaluator.mjs:10`). Rename
   `gold_dia_ids → gold_memory_ids` and it works as-is.
3. **Constant-tuning baseline stays the honest bar.** `tune-constants.mjs` already sweeps the 8
   constants; on a *live-metadata* fixture this sweep will now find non-trivial recency/importance/
   access weights (they're no longer dead), which is itself the proof the new set is representative.

---

## 6. PII / privacy handling (mandatory)

Session logs contain the user's **real code, prompts, file contents, and possibly secrets**. This is
the hardest *non-technical* constraint and a likely blocker for anything that leaves the machine.

Precedent already in the repo: the fixture `.gitignore` (`benchmark/fixture/.gitignore`) ignores
`*.jsonl` — "Generated fixtures are large derived artifacts … Commit only the GENERATORS." Verified
`git check-ignore` reports `locomo-pool.jsonl` is ignored. Extend that discipline:

- **Local-only, gitignored, never committed.** The extracted memories, the DB, and the fixture stay
  under `benchmark/session-logs/` (or `donotcommit/`), all `*.jsonl`/`*.db` gitignored. Only the
  *extractor/builder/evaluator code* is committed.
- **Content never enters the fixture.** The existing fixture already stores `content_length`, **not
  `content`** (`dump.ts:31`: "no conversation text leaks into the fixture") — the evolved surface
  reads only the length via `estimateTokens` (`scoring.ts:151,205`). Keep this: the candidate pool
  carries embeddings-derived scores + metadata + length + an opaque `mem_id`, **zero raw text.** This
  means the *fixture itself* is largely PII-free even though the intermediate DB is not.
- **Redaction pass on extracted content** *before* it touches the DB: strip obvious secrets
  (API-key/token regexes — the repo already has credential-handling discipline, CLAUDE.md "Safe
  Coding"), file paths under `$HOME`, and email/PII. The redaction runs on the embedded text, which
  never leaves the fixture anyway, but it protects the intermediate DB and any debug dumps.
- **No LLM extraction (E2) without an explicit local-model / consent gate.** Sending raw transcript
  windows to a hosted model is a data-egress event. Default to heuristic extraction (E1); gate E2
  behind a local model (Ollama, as the benchmarks already assume — `locomo/config.py:67`) or explicit
  opt-in.
- **Single-user distribution caveat (not privacy, but representativeness):** one developer's logs are
  one distribution. Document it; do not over-claim generality from a single user's corpus.

---

## 7. Alternatives — honest comparison

| Path | Representativeness | Labeling | PII | Effort | When it's right |
|---|---|---|---|---|---|
| **(1) Claude Code session logs** | **Highest** — real agent-coding memories, **live multi-week metadata** (R1✓, R2✓, R3✓). Verified: 36,755 timestamped entries over 2.3 months. | **Hardest** — must build behavioral labeling (§4); circularity + sparsity risk. | **High** — real code/secrets; mitigated by content-free fixture + redaction (§6). | **Largest** — extractor + labeler + redaction are all new; harness reused. | When we need the gold-standard representative set and can absorb the labeling build. |
| **(2) LongMemEval (`benchmark/longmemeval/`)** | **Partial.** Labeled (500 Q, 6 types), independent held-out. **BUT:** (i) chat-history QA, not agent-coding-work (R2✗, R3✗); (ii) **same flatness bug** — `ingest.py:48` stores every turn with `importance_default=0.5` (`config.py:94`) in one batch (R1✗). | **Ready** — `answer_session_ids` gold (`evolve-memory-fusion-dogfood.md:261`). | Low — public dataset. | **Medium** — **not in-repo, downloads from HF** `xiaowu0162/longmemeval-cleaned` (`dataset.py:20,47`); needs Ollama + a reader/judge LLM to run the full benchmark (`config.py:59,67`). | As a **held-out overfit guard** and a quick "representative-enough" baseline — but it does **NOT** fix the metadata-flatness bug, so it cannot be the *primary* fix. |
| **(3) Curated synthetic agent-memory set** | **Medium-high, controllable** — hand-design memories with *deliberately varied* importance/recency/access and known-relevant queries. R1 satisfied by construction. | **Easiest** — gold is authored, fully non-circular. | None. | **Medium** — authoring effort; risk of baking in our own assumptions (a designed set may not match real usage). | As the **walking skeleton** and a fast unit-level guard: smallest thing that proves the harness rewards live-metadata candidates. Weakest on *real* distribution. |

### The honest call

**LongMemEval does NOT solve the stated problem.** It is labeled and in-pipeline, but it ingests one
batch with constant importance (`ingest.py:48`, `config.py:94`) — the *exact* flatness that caused
the LoCoMo failure. Using it as the primary representative set would re-run the same bug on different
data. It remains valuable as the **held-out guard** (already its role in
`evolve-memory-fusion-dogfood.md:255-266`).

So the real choice is **session-logs (gold standard, big build)** vs **curated synthetic (fast, less
real)**. They are complementary: synthetic is the walking skeleton that *proves the harness
discriminates on live metadata*; session-logs is the representative set that *proves it on real data.*

---

## 8. Recommendation

**Phased, synthetic-first, session-logs as the gold-standard payoff.**

1. **Fix the harness's metadata-flatness blindness with a curated synthetic slice FIRST** (the
   walking skeleton, §9). It is fast, PII-free, fully non-circular, and directly proves the central
   claim: *a candidate that drops the metadata terms must score WORSE on a live-metadata set.* If the
   synthetic set does not punish the LoCoMo winner, the whole premise is wrong — find that out in a
   day, not a month.
2. **Then build the session-logs set as the representative gold standard**, with **behavioral
   labeling** (§4c) as the primary, LLM-judge as triage-only, human spot-check for the error bar.
   This is the larger, higher-value build; do it once the skeleton has de-risked the metric.
3. **Keep LongMemEval as the held-out overfit guard**, exactly as the existing design already
   positions it — not as the representativeness fix.

**Do NOT** make session-logs a prerequisite for re-running evolve. The synthetic skeleton is enough to
stop the metadata-flatness regression *today*; session-logs raises the realism ceiling afterward.

---

## 9. THE WALKING SKELETON (smallest slice that fixes the LoCoMo bug end-to-end)

**Goal:** a fixture with **live metadata** on which the LoCoMo-winning candidate (drop metadata terms)
scores **measurably worse** than a metadata-respecting candidate — using the **existing** evaluator
unchanged. This is the minimal proof the new axis is representative.

Steps (all host-side, no container, no LLM, hours not days):

1. **Author a tiny curated fixture** `session-pool.mini.jsonl` (~20 query records) in the **existing
   schema** (`dump.ts:18-39`) but with **deliberately varied metadata**: importance ∈ {0.1, 0.5, 0.9},
   `created_at` spread over weeks, `access_count` ∈ {0..20}. Construct it so that for some queries the
   **fusion score ties but the metadata breaks the tie toward the gold memory** — i.e. metadata is
   load-bearing for the correct answer. (This is exactly the structure LoCoMo cannot have.)
2. **Reuse `evaluator.mjs` + `scoring-lib.mjs` unchanged** (rename `gold_dia_ids → gold_memory_ids`).
   Score the **baseline** (`initial_program.mjs`, keeps metadata terms) and the **LoCoMo winner**
   (a candidate that zeroes the 0.15/0.1/0.1 weights) against the mini fixture.
3. **Milestone (the de-risk gate):** the baseline scores **higher** than the metadata-dropping
   candidate. *If it does not, the fixture isn't exercising metadata — fix the fixture before
   anything else.* This single inversion is the entire thesis: it demonstrates the representative set
   discriminates exactly where LoCoMo was blind.
4. **(Then) tiny real slice:** run the §3 extractor (E1 heuristic) over **one** IronCurtain session
   file, store via `engine.store` with derived `created_at`/`importance`, dump via the existing tap,
   behavioral-label ~10 queries (§4a) by hand-verified file re-reference. Confirm the harness runs on
   *real* extracted memories end-to-end. Small, PII-stays-local, proves the extraction+label join.

Deliverable: `node evaluator.mjs <candidate> session-pool.mini.jsonl out.json` prints a **lower** score
for the metadata-dropping candidate than the baseline — the LoCoMo bug, fixed, in the smallest
possible artifact, reusing the harness we already validated.

---

## 10. Effort & risk

| Phase | Effort | Risk |
|---|---|---|
| 9. Curated synthetic skeleton | **Low** (~1 day) — hand-authored fixture + rename one field in the existing evaluator | **Low** — pure host code, the harness exists |
| 3. Session-logs extractor (E1 heuristic) + metadata derivation | **Medium** (~2-4 days) | **Med** — extraction quality; `access_count`/label leak (§3.2 design note) |
| 4. Behavioral labeling + human spot-check | **High** (the crux) | **High** — sparsity, noise, the circularity argument must hold |
| 6. Redaction + PII discipline | **Low-med** (reuses gitignore precedent + regex redaction) | **Med** — must be airtight before any non-local step |
| 2 (LLM-assisted extraction E2) | optional | data-egress; gate on local model |

---

## 11. The single biggest risk

**Labeling circularity, with PII a close second.**

- **Circularity (primary).** The eval is worthless if the gold labels are produced by the ranker
  under test. The defense is §4c: **behavioral re-use as gold** (never invokes embed/fusion/reranker)
  + LLM-judge as *triage only* + human as final arbiter. The one residual leak is the
  `access_count`↔label coupling, closed by the strict-past derivation window (§3.2 design note). An
  adversarial reviewer should attack exactly this seam.
- **PII (close second).** Real code and secrets in the source logs. Defense: content-free fixture
  (`dump.ts:31` already stores only `content_length`), redaction before the DB, local-only +
  gitignored (the `benchmark/fixture/.gitignore` precedent), and no hosted-LLM extraction without a
  consent/local-model gate.

---

## 12. Grounding index (for the adversarial reviewer)

- LoCoMo flatness, measured: `importance` ≡ `0.5` over the shipped fixture; ingest at
  `benchmark/locomo/ingest.py:40`, `build-locomo-fixture.ts:114`; frozen `now` at `:224`.
- Live metadata in production: `server.ts:43-48` (importance settable), `queries.ts:120-134` +
  `pipeline.ts:172` (access stats update on recall), `maintenance.ts:74-91` (decay reads all three).
- Evolved surface reads exactly 5 metadata fields: `scoring.ts:129-145`.
- Memory = caller-formed content, no server extraction: `engine.ts:19-31`, `server.ts:36-38`.
- Session logs structure (measured): 26 projects / 308 MB; per-entry timestamps (36,755 entries,
  2026-04-14→2026-06-22); `cwd`/`gitBranch`/`tool_use`/`file_path` per entry.
- Reusable harness: `benchmark/fixture/dump.ts:18-39` (tap + schema), `build-locomo-fixture.ts`
  (offline driver, production `MemoryEngine`), `benchmark/fusion-evolve/evaluator.mjs` +
  `scoring-lib.mjs` (pure rescore, `:11` the 300-vs-2000 budget rationale).
- LongMemEval same-flatness + HF-download + Ollama: `benchmark/longmemeval/ingest.py:48`,
  `config.py:94`, `dataset.py:20,47`, `locomo/config.py:67`.
- PII precedent: `benchmark/fixture/.gitignore` (commit generators, ignore `*.jsonl`).
