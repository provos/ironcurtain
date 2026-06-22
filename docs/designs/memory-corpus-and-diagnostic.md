# Memory corpus build + representativeness diagnostic

**Status:** Results doc for the `feat/memory-ingest` branch. Pairs with the
[`memory-ingest` tool design](./memory-ingest-tool.md) and the
[representative-eval-set proposal](./memory-eval-representative-set.md).

## Why this exists

The LoCoMo retrieval benchmark is **not representative** of how the memory
server is used in production: it ingests every turn flat — `importance ≡ 0.5`,
near-identical `created_at`, `access_count ≡ 0` — so the composite scorer's
recency / importance / access terms carry no signal. An `evolve` run against it
"won" only by **dropping** those dead terms, a change that would regress
production (where those signals are live). Before evolving the composite scorer
for real, we need a corpus whose metadata signals are genuinely alive.

This branch builds that corpus from a real, private claude.ai conversation export
using the production `memory_ingest` path, then runs a diagnostic that decides —
explicitly, GO/NO-GO — whether the corpus is non-degenerate enough that evolving
the scorer is meaningful.

**Out of scope:** running `evolve` itself (that harness lives on
`dogfood/memory-fusion`). This branch stops at a merged, demonstrated-representative
corpus + the tooling to rebuild it.

## Sensitive data

The export (`donotcommit/claude-export/conversations.json`) and the built corpus
DB (`donotcommit/corpus/`) are **private** and never committed (gitignored under
`donotcommit/` plus explicit `**/conversations.json`, `*.memdb*` rules). Every
persisted artifact the tooling produces — progress log, diagnostic fixture,
diagnostic report — is **content-free**: ids, counts, and numeric signals only,
never fact/conversation/query text. LLM extraction sends conversation text to
Haiku (`claude-haiku-4-5`); this egress is the user's own Claude data and is
consented.

## The driver (`scripts/memory-corpus/build-corpus.ts`)

Single Node process (run via `tsx`) that owns the DB and calls the production
`ingestBlob` path per conversation:

- **Unit = atomic fact.** Each conversation transcript (`[sender]: text` lines)
  is decomposed by one Haiku call per chunk into atomic, self-contained facts —
  the production ingest path, so the corpus matches how production stores memory.
- **Faithful recency.** Each conversation's real `created_at` is passed as
  `as_of`, so every fact carries its source date (not ingest time).
- **Fail-loud, never contaminate.** `on_extraction_failure: 'skip'` — a fully
  failed extraction writes nothing (no muddy single-blob fallback into the
  corpus) and is recorded for retry, rather than silently degrading.
- **Deterministic maintenance.** `MEMORY_MAINTENANCE_INTERVAL` is set very high
  so the per-store `maybeRunMaintenance` (which runs a DECAY phase) never fires
  mid-bulk — critical, because `computeVitality` uses `now - created_at` and would
  mark backdated facts decayed, destroying the recency spread we are building. A
  single `runConsolidation` (never full `runMaintenance`) runs at the very end.
- Resumable (`--resume`), content-free logging, gitignored output.

### Prompt evolution: atomic *and* complete

Initial extraction produced correctly atomic facts, but a minority resolved the
*subject* while dropping the *referent* — "The user has 5 business days to cancel
**the contract**" (which contract?), "…before winning **the game**" (which game?).
The self-containment rule was strengthened to also require naming the specific
project / product / document / entity the fact is about. Effect on a 6-conversation
sample: minimum fact length rose 22→58 chars (the context-stripped fragments
disappeared) while facts stayed atomic (avg ~131 chars) with well-varied
importance. The full corpus was built with the improved prompt.

## Corpus build results

503 conversations → **3,962 fact rows** (3,975 created, 58 merged), built in ~47 min.

| outcome | conversations |
|---|---|
| ingested | 305 |
| partial (some chunks failed) | 19 |
| skipped — failed extraction | 30 |
| skipped — empty (no text) | 149 |

- **Importance:** min 0.20 / mean 0.75 / max 0.95 — genuinely varied per fact
  (not the flat 0.5 that killed LoCoMo).
- **Recency:** 2024-08-29 → 2026-06-19, ~22 months.

### The recency reality (honest scoping)

The export *spans* 2023-07 → 2026-06, but the corpus starts 2024-08. This is a
**data reality, not a pipeline gap**: all 40 of the 2023 conversations are empty
husks (no message text in the export) — there is nothing to recover. Status by
year:

| year | ingested | partial | failed | empty |
|---|---|---|---|---|
| 2023 | 0 | 0 | 0 | 40 |
| 2024 | 18 | 0 | 11 | 20 |
| 2025 | 128 | 11 | 12 | 16 |
| 2026 | 159 | 8 | 7 | 73 |

So the corpus carries ~22 months of real recency spread — a solid multi-year
signal, just not the full three years. The 30 failed extractions are spread
across 2024–26 (not the old data); because extraction runs at temperature 0 they
are deterministic ("no facts parsed"), so they are genuine no-durable-content /
format cases (~8.5% of text-bearing conversations), documented here as a known
completeness gap rather than recoverable loss.

Text-only assembly (ignoring `content` blocks) is deliberate: of the 143
all-empty-`text` conversations only 2 had any `content`, and those blocks are
overwhelmingly `thinking` / `tool_use` / `tool_result` — internal reasoning and
tool noise we explicitly do not want in a memory corpus.

## The diagnostic (`scripts/memory-corpus/diagnose-corpus.ts`)

Answers one question with a GO/NO-GO verdict: are the metadata signals alive and
do they actively reshape rankings, so that evolving the composite scorer is
meaningful? Three parts:

- **A. Distributional liveness** (read-only): recency span / distinct months /
  stddev; importance stddev + fraction stuck at the 0.5 seed; access (latent,
  ~0 on a fresh corpus — expected, not a failure); content_length (atomic-sized).
- **B. Self-supervised recall probe** (on a DB *copy* so `access_count` is never
  mutated): sample N facts stratified by recency, generate one natural query each
  via Haiku (gold = that fact), build a content-free candidate-pool fixture via
  real hybrid retrieval, then compute **recall@budget** for the production
  `composite` and `fusion-only` scorers plus single-signal control baselines
  (recency / importance / access / bm25 / vector only). Composite and fusion are
  the **real production functions** (`computeCompositeScore`, `hybridScoreFusion`,
  `packToBudget`), so the numbers reflect exactly what `evolve` would tune.
- **C. Ranking influence:** mean Kendall-τ between the composite and fusion-only
  orderings — τ well below 1 means recency/importance actively reorder results
  (the live-lever test, the direct antidote to the LoCoMo failure).

**Verdict:** GO iff `recency_live AND importance_live AND reshapes_rankings`. The
"composite ≥ every single-signal baseline" confound check is supporting evidence,
not a gate. Anti-vacuity is unit-proven: a LoCoMo-shaped degenerate fixture
yields NO-GO, a healthy one GO.

## Diagnostic result

Run: `diagnose-corpus.ts --seed 42 --sample 120 --budget 300` over 3,962 rows.

**Verdict: GO** — `recency_live ✓  importance_live ✓  reshapes_rankings ✓`
(plus the supporting `not_single_signal_confound ✓`).

**A. Distributional liveness**

- Recency: span 659.8 days (2024-08-29 → 2026-06-19), 20 distinct year-months,
  stddev 114.2 days. Right-skewed toward recent (2024=1%, 2025=32%, 2026=67%) —
  realistic (recent conversations carry more text), and a genuine multi-month
  spread, not LoCoMo's single point.
- Importance: 0.20 / 0.752 / 0.95 (min/mean/max), stddev 0.120, 13 distinct
  values, only **3.8%** at the 0.5 seed. Alive, model-assigned, varied.
- Access: 0 everywhere — latent on a fresh corpus, expected, not a failure.
- Content length: p50 149 chars, p90 232 — atomic facts, not muddy blobs.

**B. Recall@budget (budget = 300 tokens), by ranking variant**

| variant | recall |
|---|---|
| composite | 0.983 |
| fusion-only | 0.983 |
| vector-only | 0.983 |
| bm25-only | 0.942 |
| access-only | 0.075 |
| importance-only | 0.042 |
| recency-only | 0.025 |

**C. Ranking influence:** Kendall-τ(composite, fusion-only) = **0.563** (gate < 0.9).

### How to read this (honest scoping)

The probe is self-supervised — each query is generated *from* a fact, so it tests
"find the source fact from a question about it." Content-based retrieval aces that
(composite = fusion = vector = 0.983), and the single-metadata baselines are
near-useless for it (recency/importance/access alone can't locate a content-specific
fact) — exactly as expected. So composite does **not** beat fusion on this probe,
and that is fine: the GO is not "metadata improves recall," it is the goal's actual
bar — **the corpus is non-degenerate and the metadata terms are live levers.** The
proof is τ = 0.563: at the current weights, recency/importance already reorder
retrieval substantially (on LoCoMo τ ≈ 1.0 because the terms were constant). The
levers `evolve` would tune are alive and have headroom, and there is no single-signal
confound. What this probe does **not** establish — whether metadata *improves*
relevance-ranked retrieval — is precisely the open question `evolve` exists to
answer, now on a corpus where the question is meaningful.

**Conclusion: this branch is evolve-ready.** Once merged, the
`dogfood/memory-fusion` harness can be rebased onto master and pointed at this
corpus (rebuild with `scripts/memory-corpus/build-corpus.ts`, dump a content-free
fixture) instead of LoCoMo.
