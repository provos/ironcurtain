# memory-corpus — claude.ai export → memory corpus builder

`build-corpus.ts` ingests a claude.ai conversation export into a memory DB via
the `memory_ingest` path (`ingestBlob`), one conversation at a time, backdated to
each conversation's real date. It produces a representative, recency- and
importance-spread eval corpus for the memory-mcp-server.

It drives a single Node process (run via `tsx`) that owns the DB and imports the
engine internals directly — the same pattern as the LoCoMo fixture builder.

## ⚠️ SENSITIVE DATA — read first

- The export (`conversations.json`) and the resulting DB contain **private
  conversation content and PII**. Both live under the **gitignored
  `donotcommit/`** directory and **must never be committed**.
- Conversation `name`/`summary`/message `text`/`content` are **sensitive**. This
  driver **never** writes any of them to logs or to the progress file. The
  progress file (`progress.jsonl`) and the stderr progress lines carry **counts
  and opaque uuids only** — no fact text, no transcript.
- The SUMMARY printed at the end is content-free: it reports counts, importance
  min/max/mean, and created_at min/max (epoch-derived ISO timestamps) — never
  any conversation content.
- Ingestion **egresses each conversation transcript to the configured LLM**
  (Haiku) for fact extraction. `--dry-run` skips local persistence but **still
  egresses** to Haiku — it is not a no-network mode. Run the real ingestion
  yourself, with consent to that egress.

## Environment

- **`ANTHROPIC_API_KEY`** — **required**. The corpus needs the LLM; the driver
  exits with an error if the key is missing (no silent degrade). Load it via
  `--import dotenv/config` from your `.env`, or export it.

The driver sets these `MEMORY_*` vars in-process before `loadConfig()`:

| var                           | value                                     | why                                              |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `MEMORY_LLM_BASE_URL`         | `https://api.anthropic.com/v1/`           | OpenAI-compatible Haiku endpoint                 |
| `MEMORY_LLM_API_KEY`          | `$ANTHROPIC_API_KEY`                      | extraction auth                                  |
| `MEMORY_LLM_MODEL`            | `claude-haiku-4-5-20251001` (overridable) | extraction model                                 |
| `MEMORY_DB_PATH`              | resolved `--db`                           | output DB                                        |
| `MEMORY_NAMESPACE`            | `--namespace`                             | corpus isolation                                 |
| `MEMORY_MAINTENANCE_INTERVAL` | `100000000`                               | suppress per-store maintenance (see determinism) |
| `MEMORY_DECAY_THRESHOLD`      | `0`                                       | belt-and-suspenders: never decay                 |
| `MEMORY_RERANKER_ENABLED`     | `false`                                   | no cross-encoder download during ingest          |

## Run commands

All paths default under `donotcommit/`; the driver `mkdirSync`s the DB directory.

```bash
# Validation: first 3 non-empty conversations (writes a small corpus)
npx tsx --import dotenv/config scripts/memory-corpus/build-corpus.ts --limit 3

# Dry-run: extract + preview only, write nothing (STILL egresses to Haiku)
npx tsx --import dotenv/config scripts/memory-corpus/build-corpus.ts --limit 3 --dry-run

# Single conversation by uuid
npx tsx --import dotenv/config scripts/memory-corpus/build-corpus.ts --conversation <uuid>

# Full run (all 503 conversations; 6 empty ones are skipped)
npx tsx --import dotenv/config scripts/memory-corpus/build-corpus.ts

# Resume: skip conversations already recorded done; retry recorded failures
npx tsx --import dotenv/config scripts/memory-corpus/build-corpus.ts --resume

# Help
npx tsx scripts/memory-corpus/build-corpus.ts --help
```

### Flags

| flag                    | default                                        | meaning                                                  |
| ----------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `--export <path>`       | `donotcommit/claude-export/conversations.json` | export JSON (top-level array)                            |
| `--db <path>`           | `donotcommit/corpus/memories.memdb`            | output memdb                                             |
| `--namespace <name>`    | `claude-export`                                | memory namespace                                         |
| `--limit <N>`           | (all)                                          | process only first N **non-empty** conversations         |
| `--conversation <uuid>` | (all)                                          | process only that conversation                           |
| `--dry-run`             | off                                            | extract but write nothing (still egresses to Haiku)      |
| `--resume`              | off                                            | skip conversations recorded done; retry `skipped-failed` |
| `-h, --help`            | —                                              | show help                                                |

## Per-conversation behavior

- The 6 empty conversations (and any with no non-empty messages) are skipped and
  recorded as `skipped-empty`.
- The transcript is assembled as one `${sender}: ${text}` line per message with
  non-empty `text` (we use `text`, not `content`), joined by newlines.
- Ingest is called with `mode: 'document'` (durable facts across turns;
  transcripts rarely state facts in one explicit sentence), `as_of` = the
  conversation `created_at`, `source` = `claude-export:<uuid>`, `tags:
['claude-export']`, and `on_extraction_failure: 'skip'`. Per-fact importance
  comes from extraction (no call-level importance is passed).
- `on_extraction_failure: 'skip'` means a fully-failed extraction writes nothing
  and is recorded as `skipped-failed` — no single-blob contamination, and the
  conversation is retried on `--resume`.

### `progress.jsonl` (content-free)

One line per conversation in the DB directory:

```json
{
  "uuid": "...",
  "status": "ingested|partial|skipped-empty|skipped-failed",
  "created": 7,
  "merged": 1,
  "facts": 8,
  "failed_chunks": 0,
  "chunks": 2
}
```

- `skipped-failed` when the ingest result is `skipped`.
- `partial` when some (not all) chunks failed but others produced facts.
- otherwise `ingested`.

## Resumability

On start the driver loads `progress.jsonl`. With `--resume`, it skips every uuid
that has any record with status `ingested`, `partial`, or `skipped-empty`, and
**retries** uuids whose only record is `skipped-failed`. Without `--resume`, an
existing DB/progress emits a warning and the run **appends** (it does not reset).

## Determinism rationale (why decay is off + consolidation-only)

`maybeRunMaintenance` (called per-store inside `ingestBlob → store →
storeImmediate`) runs the **full** `runMaintenance`, which includes a **DECAY**
phase. `computeVitality` uses `now - created_at`; our backdated 2023–2024 facts
have an age of ~1000 days against a ~90-day half-life, so a mid-bulk decay pass
would mark them DECAYED (importance → 0) and **destroy the recency/importance
spread that is the entire point of the corpus**.

So the driver:

1. Sets `MEMORY_MAINTENANCE_INTERVAL` very high (100,000,000) so per-store
   maintenance **never fires mid-bulk**.
2. Sets `MEMORY_DECAY_THRESHOLD=0` as belt-and-suspenders.
3. At the very end runs **`runConsolidation(db, config)` ONLY** (deferred dedup /
   contradiction resolution) — **never** `runMaintenance` (which would decay).

The end-of-run SUMMARY queries the DB directly for importance min/max/mean and
created_at min/max — these prove the corpus is **non-flat** (a spread of
salience and a multi-year recency range).

## Content-free guarantee

Every artifact and log line this driver emits is content-free: opaque uuids
(prefix only on stderr), integer counts, importance statistics, and
epoch-derived timestamps. No conversation `name`/`summary`/`text`/`content`, no
extracted fact text, and no model output is ever logged or written to
`progress.jsonl` or the SUMMARY.

---

# diagnose-corpus — representativeness diagnostic (GO/NO-GO)

`diagnose-corpus.ts` answers ONE question with a GO/NO-GO verdict: **is this
corpus non-degenerate enough that evolving the composite retrieval scorer is
meaningful** — i.e. are the metadata signals (recency, importance) ALIVE and do
they actively reshape rankings, unlike the LoCoMo benchmark where flat metadata
(importance ≡ 0.5, identical `created_at`) made those terms dead weight?

The pure analysis logic lives in `diagnose-lib.ts` and is unit tested in
isolation with SYNTHETIC fixtures (`test/diagnose-corpus.test.ts`) — including a
degenerate LoCoMo-shaped fixture that must yield NO-GO and a healthy one that
must yield GO (the anti-vacuity proof).

## Three analyses, then a verdict

**A. Distributional liveness** (real db, READ-ONLY SQL — no LLM, no retrieval):

- **Recency**: min/max `created_at`, span days, distinct year-months, stddev,
  fraction of rows per calendar year, histogram by quarter.
- **Importance**: min/max/mean/stddev, distinct values, histogram (0.1 buckets),
  fraction sitting **exactly** at the 0.5 seed.
- **Access**: `access_count` distribution. On a fresh corpus this is ~0 — access
  is a **LATENT, usage-driven** signal that stays zero until the corpus is
  queried. This is reported honestly and does **not** fail the verdict.
- **content_length**: min/max/mean/percentiles — a sanity check that facts are
  ATOMIC-sized (tens–low-hundreds of chars), proving decomposition worked.

**B. Self-supervised recall probe** (needs Haiku + retrieval; runs on a db
**COPY** so the real corpus stays pristine — retrieval mutates access stats):

- Sample `--sample N` facts (default 120) **stratified across recency buckets**
  (seeded PRNG via `--seed`, so re-runs match) so older years are represented.
- One Haiku call per sampled fact generates a natural question it answers; the
  fact's id is the gold.
- For each question, the REAL hybrid candidate pool (vector KNN + FTS5 +
  production fusion) is retrieved and a **content-free** fixture row is written
  to `donotcommit/corpus/diagnostic-fixture.jsonl`:
  `{ query_id, gold_id, candidates: [{ id, is_gold, vector_distance, bm25_score,
created_at, last_accessed_at, access_count, importance, content_length }] }`.
  **No content/fact/query text** is ever in the fixture.
- Purely on the fixture, `recall@token-budget` (default `--budget 300`, matching
  the evolve dogfood) is computed for `composite` (full production),
  `fusion-only`, `recency-only`, `importance-only`, `access-only`, `bm25-only`,
  `vector-only`. The `composite`/`fusion-only` variants **reuse the production
  scoring functions** (`computeCompositeScore`, `hybridScoreFusion`,
  `packToBudget`, `estimateTokens`) so the diagnostic reflects what `evolve`
  would actually tune; the single-signal variants are trivial reference rankers.
- **Ranking influence**: mean Kendall-tau between the `composite` and
  `fusion-only` per-query orderings. Tau well below 1.0 ⇒ the recency/importance
  terms actively reshape rankings (the LIVE-lever test).

**C. Verdict (GO/NO-GO)** with the numbers, the thresholds, and the reasoning:

| condition                    | rule (default threshold)                                           |
| ---------------------------- | ------------------------------------------------------------------ |
| `recency_live`               | span > 365 days AND ≥ 12 distinct year-months AND stddev ≥ 30 days |
| `importance_live`            | importance stddev ≥ 0.05 AND fraction-at-0.5 < 0.5                 |
| `reshapes_rankings`          | mean Kendall-tau(composite, fusion-only) < 0.9                     |
| `not_single_signal_confound` | composite recall ≥ every single-signal baseline (supporting only)  |

**GO** iff `recency_live AND importance_live AND reshapes_rankings` (the core
anti-LoCoMo conditions). `not_single_signal_confound` is reported as supporting
evidence but does **not** gate the verdict. **NO-GO** names which condition(s)
failed. The process exits `0` on GO, `1` on NO-GO, `2` on error.

## Run commands

```bash
# Full diagnostic (Part A read-only + Part B probe on a db copy)
npx tsx --import dotenv/config scripts/memory-corpus/diagnose-corpus.ts

# Smaller, faster probe with a fixed seed and tighter budget
npx tsx --import dotenv/config scripts/memory-corpus/diagnose-corpus.ts --sample 40 --budget 200 --seed 7

# Help (no API key needed)
npx tsx scripts/memory-corpus/diagnose-corpus.ts --help

# Pure-logic unit tests (no db, no LLM) — includes the LoCoMo-degenerate→NO-GO
# and healthy→GO anti-vacuity cases
npm test -- test/diagnose-corpus.test.ts
```

### Flags

| flag                 | default                             | meaning                                           |
| -------------------- | ----------------------------------- | ------------------------------------------------- |
| `--db <path>`        | `donotcommit/corpus/memories.memdb` | corpus memdb (read-only for Part A, copied for B) |
| `--namespace <name>` | `claude-export`                     | memory namespace                                  |
| `--sample <N>`       | `120`                               | probe sample size, stratified by recency          |
| `--budget <tokens>`  | `300`                               | recall@token-budget (matches evolve dogfood)      |
| `--seed <int>`       | `1`                                 | deterministic sampling seed                       |

## Pristineness + content-free guarantee

- Part A opens the db **read-only** (`{ readonly: true }`) and only runs
  `SELECT` — it never mutates the real corpus.
- Part B copies the `.memdb` (+ WAL/SHM sidecars) to a temp dir and runs the
  probe on the **copy**, then deletes the temp dir. The candidate pool is built
  by calling `vectorSearch`/`ftsSearch`/`hybridScoreFusion` directly (NOT
  `recall()`), so even the copy's access stats are never bumped and **no content
  leaves the retrieval layer** — only numeric signals.
- Every artifact (`diagnostic-fixture.jsonl`, `diagnostic-report.json`) and every
  stdout/stderr line is content-free: opaque ids, numeric signals, and verdict
  aggregates only. Both artifacts live under the gitignored `donotcommit/`.
