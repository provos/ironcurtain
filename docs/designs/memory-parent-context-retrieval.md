# Design: Parent-context retention for `memory_ingest` — "index fine, return coarse"

**Status:** Design v3 (back-compat-free simplification) — no implementation
**Package:** `packages/memory-mcp-server/`
**Extends:** [`memory-ingest-tool.md`](./memory-ingest-tool.md) (the ingest tool this changes)
**Motivated by:** the contract-decomposition loss surfaced in
[`memory-corpus-and-diagnostic.md`](./memory-corpus-and-diagnostic.md)

> **v3 changelog (back-compat-free simplification).** Product directive: **we do NOT care about
> backwards compatibility; the system must work correctly out of the box.** v2's retrieval substrate
> is unchanged — this is purely a *storage/migration* simplification plus a defaults sanity-check:
> 1. **The migration runner is DELETED.** v2 carried a version-guarded `runMigrations(db)` with a
>    `PRAGMA table_info` idempotency guard whose *only* job was to upgrade pre-existing v3 DBs
>    in place. With no back-compat that machinery is gone. The `segments` table and
>    `memories.segment_id` column are now part of the **canonical schema** that `createSchema`
>    builds with `CREATE TABLE IF NOT EXISTS` for a fresh DB. There is no in-place migration. (§4)
> 2. **Stale DBs are rebuilt, not migrated.** A pre-existing DB from before this change (including
>    the built corpus) is **not** upgraded — it is recreated. `SCHEMA_VERSION` bumps `'3' → '4'` as
>    a plain version stamp; `initDatabase` reads the on-disk stamp and, when it is older than
>    `SCHEMA_VERSION`, **drops and recreates** the schema before building it (self-healing, no manual
>    step). The corpus is regenerated via `build-corpus.ts`; user/session DBs are recreated. (§4.1–§4.2)
> 3. **"Back-compat" framing is dropped.** Store-path and degrade-path rows still carry
>    `segment_id = NULL` and re-expansion still treats a NULL-segment fact as its own parent — but
>    that is a **current** design property ("these rows have no parent"), not a legacy/migration
>    artifact. The §4.4 "back-compat invariant" is gone; the NULL-segment case is restated as a
>    normal current case in §5. (§5.3)
> 4. **Defaults reaffirmed for out-of-the-box quality.** `expand:'auto'` stays the default (that IS
>    the zero-config behavior). The default `memory_recall` budget is **bumped 500 → 800** so a
>    ~300–400-token passage plus a couple of facts fits with no tuning; `memory_context` stays
>    **800**. State explicitly: no caller flag and no config tuning are needed to get parent context
>    on shared-parent queries. (§5.4)
>
> Everything else carries forward from v2 unchanged: `expand:'none'|'auto'|'parent'` (auto default),
> query-ranked ~300–400-token passage return, merge-repoints-to-richer-parent,
> `expanded`/`expanded_segment_ids` in all formats + `memory_expand`, segments-off-the-index, ranker
> untouched, store path LLM-free, Phase 2 contextualized embedding deferred.

---

## 1. Overview

`memory_ingest` decomposes a blob into atomic facts and stores **only** those facts
(`engine-impl.ts:255-263` writes each `ExtractedFact` through `storeImmediate`; the source
chunk is discarded after `extractAllFacts` returns at `engine-impl.ts:201`). Decomposition is
**lossy by construction**: the detailed clauses of a multi-clause contract (a $250k distribution
cap, buyout mechanics, IP terms, an NDA) were never turned into facts — only ~7 headline facts
were — so `memory_recall` can only ever return the headlines. No amount of retrieval-stack
quality recovers a detail that was never stored.

This design keeps atomic facts as the **indexed/embedded retrieval key** (the ranking pipeline
in `retrieval/pipeline.ts` is unchanged) but **retains the source segment** each fact was
extracted from and links every fact to it, so recall can **re-expand** a top-ranked fact back to
its parent — where the un-decomposed clauses still live verbatim. This is the SOTA
"small-to-big" / parent-child pattern: index fine, return coarse. It changes the **stored and
returned unit**, not the ranker.

Two things make this actually return the clauses on a **default** recall (the whole point — the
Bandalert loss had no flag):

- **Auto-expansion (§5.2).** When **≥2 kept facts share a parent segment**, recall expands that
  shared parent without any flag. That shared-parent grouping is exactly the contract signature
  (7 headline facts, one segment) and is already computed for parent-dedup, so `'auto'` needs no
  query classifier and does not regress a pinpoint query (1 fact → no expansion).
- **Passage return (§5.3).** A 6000-token segment cannot fit the **800-token** default budget,
  so v1 would have degraded right back to the headline. Instead of returning the whole chunk, recall
  **splits the segment into coherent ~300–400-token passages and returns the passage(s) most
  relevant to the query** (ranked by similarity to the query embedding already computed at pipeline
  step 1). The "$250k cap" clause comes back as a ~300-token passage that **fits** 800 tokens and is
  the one the query wanted — not 6000 tokens of conversation window.

### Why this is the right shape (research grounding)

- **Atomic/proposition decomposition as the *sole* stored unit is disfavored.** The flagship
  pro-proposition paper, **Dense X Retrieval (Chen et al., EMNLP 2024, arXiv:2312.06648)**, shows
  propositions help only weak/zero-shot retrievers, rare-entity factoids, and *under a fixed
  token budget*; the gains are flat for strong retrievers. It is a token-density argument, not
  "context-free storage is free." **Decomposition Dilemmas (NAACL 2025, arXiv:2411.02400)** names
  the exact failure modes we hit: *omission-of-context* and *over-decomposition*.
- **The dominant trend is the opposite — re-attach context.** **Anthropic Contextual Retrieval
  (Sept 2024)** prepends LLM-generated context to chunks (−35% to −67% retrieval-failure rate);
  **Jina Late Chunking (arXiv:2409.04701)** embeds-then-splits to preserve cross-references;
  coherence-preserving chunking beats proposition chunking head-to-head in **Document Segmentation
  Matters (ACL 2025 Findings)**.
- **SOTA practice is "index fine, return coarse"** (small-to-big / parent-child): atomic facts are
  the retrieval key, but a back-pointer to the source passage lets the system return the parent
  context. 2026 memory systems converge here — **HippoRAG 2** keeps full passages, **A-MEM**
  enriches notes with context + links, **TriMem** keeps multi-granularity records.
- **Do not touch the ranker.** Our retrieval stack is already SOTA-aligned (hybrid dense+BM25 in
  `hybridScoreFusion` → composite scoring → cross-encoder rerank in `reranker.ts`; "ranking beats
  structure," SmartSearch 2026). The lesson is *expand after ranking*, not *re-rank on a coarser
  unit*. Re-expansion in this design happens strictly **after** step 9 of the pipeline.

The contract failure is therefore a **storage** bug, not a retrieval bug, and the fix is a
storage + post-ranking-expansion change that leaves the ranker byte-for-byte unchanged.

---

## 2. Key design decisions (the short version)

1. **A new `segments` table holds the source chunk; each fact carries a nullable
   `segment_id` FK.** Chosen over self-referential `parent_id` on `memories` and over a
   metadata-JSON pointer. (§3, §3.4)
2. **Atomic facts stay the only indexed/embedded unit.** Segments are **not** embedded, **not**
   in `vec_memories`, **not** in `memories_fts`. The ranker never sees a segment. (§3.1)
3. **Re-expansion is a post-ranking step (9b), after dedup, controlled by a `recall` option
   `expand: 'none' | 'auto' | 'parent'` defaulting to `'auto'`.** `'auto'` expands a parent only
   when **≥2 kept facts share it** — the Bandalert signature — so pinpoint queries (1 fact → no
   expand) are never regressed, and the evidenced loss is fixed with **no flag and no query
   classifier**. `'none'` force-off and `'parent'` force-expand-every-parent are explicit
   overrides. `buildContext`/`memory_context` is also wired to `'auto'`. (§5.2)
4. **The RETURNED unit is a query-ranked ~300–400-token PASSAGE, not the 6000-token chunk.** On
   expansion, the shared segment is split into coherent passages and the passage(s) most similar to
   the query embedding are returned, up to budget. Storage may keep `segment = chunk`; only the
   *returned* unit is passage-sized. Chosen **recall-time split-and-rank** over ingest-time
   pre-split — simpler storage, only fires on auto-expand, reuses the step-1 query embedding. (§5.3)
5. **Passages AUGMENT the facts; they do not replace them (breadth-first).** All kept facts are
   returned exactly as `expand:'none'` would return them; the expanded passage(s) are **appended
   after** all the facts, in segment-best-rank order. Parent-dedup applies to **passages** (one
   passage per shared parent), **never to facts** — auto-expand never evicts a fact `expand:'none'`
   would have kept. Because the greedy skip-not-break packer packs in order, a passage only ever
   consumes leftover budget. (§5.3)
6. **Budget machinery is simplified.** Passage-sized returns make the v1 two-tier
   `expand_budget_fraction` unnecessary (its only job was to *reject* the oversized segment).
   Expanded passages and facts share the budget under the existing greedy skip-not-break
   `packToBudget`, with a small cap (`max_expand_passages`, default 2) so expansion can't evict every
   fact. The `expand:'none'` path uses `packToBudget` byte-for-byte. The default recall budget is
   **bumped 500 → 800** (`MEMORY_DEFAULT_TOKEN_BUDGET`) so a ~300–400-token passage plus a couple of
   facts fits out of the box; `memory_context` is already 800. No flag, no tuning. (§5.4)
7. **The schema is canonical — there is no in-place migration.** The `segments` table and the
   `memories.segment_id` column are part of the schema `createSchema` builds with
   `CREATE TABLE IF NOT EXISTS` for a fresh DB. `SCHEMA_VERSION` bumps `'3' → '4'` as a plain
   version stamp; `initDatabase` reads the on-disk stamp and **drops-and-recreates** the schema
   when it is older than `SCHEMA_VERSION` (a stale pre-change DB is rebuilt, not upgraded —
   acceptable under the back-compat-free directive, and self-healing with no manual step). A row
   with no parent simply has `segment_id = NULL` and recall returns the fact. (§4)
8. **On exact-dedup merge, the survivor repoints to the *richer* parent** (the segment with the
   higher `fact_count`), so a later, richer ingest of the same fact is not discarded by ingest
   order. The merge path must read both segments' `fact_count`. (§6.2)
9. **Expansion metadata is surfaced in every format.** `RecallResult` carries `expanded` and the
   relevant `segment_id`(s) regardless of `format` (not just `raw`), and a `memory_expand(segment_id)`
   affordance lets an agent that got headlines fetch the parent passages on demand. (§5.5, §9)
10. **The LLM-free `store` path is untouched.** Only `ingest` writes segments. `store` rows have
    `segment_id = NULL` forever and behave exactly as today. (§3.3)
11. **Phase 2 (optional, deferred): contextualized embedding** — prepend a one-line segment
    context to each fact *before embedding* (Anthropic-style). Designed in §7, gated behind ingest
    so `store` stays LLM-free. Unlike v1, Phase 1 now actually fixes the evidenced failure on a
    default recall, so Phase 2 is a pure recall-rate optimization. (§7, §11)

---

## 3. Storage / schema

### 3.1 The decision: a `segments` table + `memories.segment_id` FK

Three options were considered:

| Option | What it is | Verdict |
|---|---|---|
| **A. `segments` table + `segment_id` FK on `memories`** | New table `segments(id, namespace, content, source, created_at, …)`; each fact row gets a nullable `segment_id` pointing at it. | **CHOSEN** |
| B. Self-referential `parent_id` on `memories` | The segment is itself a `memories` row; facts point at it via `parent_id`. | Rejected |
| C. Metadata JSON pointer | Store the parent text (or an id) inside the existing `metadata` JSON column. | Rejected |

**Why A over B.** If the segment were a `memories` row it would land in **both** index structures,
each by a *different* mechanism: `memories_fts` is populated by the `memories_ai` AFTER-INSERT
trigger (`database.ts:111-114`, which writes **only** to `memories_fts`), while the `vec_memories`
row is written **explicitly** inside `insertMemory` (`queries.ts:48-51`) — there is no trigger for
the vector table. (v1 mis-stated that the trigger populates both; corrected here. The conclusion is
unchanged.) A 6000-token segment as a `memories` row would therefore (a) pollute the ranker with a
muddy-centroid blob — the exact problem decomposition exists to avoid (`memory-ingest-tool.md` §1) —
and (b) double-count: both the segment and its facts would surface for the same query. A separate
table keeps segments **off the index** by construction: neither the FTS trigger nor `insertMemory`
fires for a `segments` row (only `memories` rows trigger the FTS insert and only `insertMemory`
writes `vec_memories`), so the "facts are the only retrieval key" invariant is structural, not a
discipline we must remember.
It also avoids overloading `memories`' lifecycle columns (`importance`, `is_compacted`,
`consolidated`, decay) — a segment is provenance, not a recallable memory, and shouldn't decay,
consolidate, or compact.

**Why A over C.** Metadata-JSON would duplicate a ~6000-token segment into *every* fact's
`metadata` blob (7 facts → 7 copies of the same chunk), bloating each `memories` row, every
`SELECT m.*` in `queries.ts`, and every `rowToMemory` parse (`engine-impl.ts:73`). Normalizing
the segment into one row referenced by N facts is the obvious relational fit and makes
parent-dedup (§5.3) a trivial `GROUP BY segment_id`.

### 3.2 Schema (canonical — built directly in `createSchema`)

Both of these are part of the canonical schema a fresh DB is born with — `createSchema`
(`database.ts`) builds them in its existing `CREATE TABLE IF NOT EXISTS` style alongside
`memories`. There is **no** `ALTER TABLE`/migration step; `memories` is *defined* with
`segment_id` (§4).

```sql
CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  namespace   TEXT NOT NULL DEFAULT 'default',
  content     TEXT NOT NULL,          -- the source chunk memory_ingest extracted facts from
  source      TEXT,                   -- provenance, mirrors memories.source (e.g. 'session:abc')
  mode        TEXT,                   -- 'conversation' | 'document' (the ingest mode used)
  created_at  INTEGER NOT NULL,       -- mirrors the facts' created_at (honors as_of)
  fact_count  INTEGER NOT NULL DEFAULT 0  -- how many facts were extracted from this segment
);

CREATE INDEX IF NOT EXISTS idx_segments_namespace ON segments(namespace);

-- segment_id is declared inline in the canonical `CREATE TABLE memories (...)` (§4):
--   segment_id TEXT REFERENCES segments(id)
-- It is NULL for every store-path / degrade-path row (rows that genuinely have no parent).

CREATE INDEX IF NOT EXISTS idx_memories_segment ON memories(segment_id) WHERE segment_id IS NOT NULL;
```

Notes:

- **No vector / FTS tables for segments.** Intentional (§3.1). Segments are fetched only by
  primary key during re-expansion, so a `namespace` index plus the PK is sufficient.
- **`segments.content` reuses the chunk verbatim** — the same string `chunkBlob` produced
  (`engine-impl.ts:200`) and handed to `extractFacts`. No re-chunking, no second representation.
  It is capped by the existing chunking bound `MAX_INGEST_CHUNK_TOKENS = 6000`
  (`extraction.ts:28`; `MAX_INGEST_CHUNK_CHARS = MAX_INGEST_CHUNK_TOKENS * 4`, `extraction.ts:41`),
  so a segment is at most ~6000 tokens — already the unit the LLM saw. This 6000-token storage unit
  is exactly why the **returned** unit must be a smaller passage (§5.3): 6000 tokens never fits the
  800-token default budget.
- **`fact_count`** is a cheap denormalization that lets recall decide whether expanding is
  worthwhile (a segment whose only fact is the one that matched adds little; a segment with 7
  facts where only the headline was indexed is exactly the contract case). Optional to *use* in
  phase 1; cheap to *populate*.
- **`REFERENCES segments(id)`** declares the FK. `foreign_keys = ON` is already set
  (`database.ts:42`). The reference is **not** `ON DELETE CASCADE` deliberately — see §6.3
  (forget/decay must null the pointer or orphan-collect, not cascade-delete facts).

### 3.3 The store path stays segment-less

`storeImmediate` (`engine-impl.ts:81-129`) never sets `segment_id`. `InsertMemoryParams`
(`queries.ts:11-25`) gains an **optional** `segmentId?: string`; when absent, `insertMemory`
binds `NULL` (exactly as it already does for `source`/`metadata`). The `memory_store` tool, the
LLM-free write path, and every existing caller are byte-for-byte unchanged. Only `ingestBlob`
passes a `segmentId`.

### 3.4 Why facts remain the indexed unit (invariant restated)

- Each fact is still embedded (`storeImmediate` calls `embed(content)`, `engine-impl.ts:89`) and
  inserted into `vec_memories` (explicit insert in `insertMemory`, `queries.ts:48-51`) +
  `memories_fts` (via the `memories_ai` trigger, `database.ts:111-114`) exactly as today.
- Segments are inserted **only** into the `segments` table. No trigger fires for it (the FTS trigger
  is scoped to `memories`), and nothing writes a `vec_memories` row for it (only `insertMemory`
  does, and `insertSegment` is a separate query).
- Therefore `vectorSearch`/`ftsSearch`/`hybridScoreFusion`/`computeCompositeScore`/`rerank`/
  `deduplicateByEmbedding`/`packToBudget` all operate on the identical candidate set they do
  today. **The ranker cannot regress because its inputs are unchanged.**

---

## 4. Schema is canonical — no in-place migration

**Product directive:** we do **not** care about backwards compatibility; the system must work
correctly out of the box. That removes the entire reason v2 carried a migration runner. The
`segments` table and the `memories.segment_id` column are simply part of the canonical schema a
fresh DB is born with — there is no in-place upgrade path.

### 4.1 The canonical schema (built in `createSchema`)

`createSchema` (`database.ts`) defines the final shape directly, in its existing
`CREATE TABLE IF NOT EXISTS` style. Two changes vs. today:

- The `CREATE TABLE IF NOT EXISTS memories (...)` block gains an inline column:
  ```sql
  segment_id TEXT REFERENCES segments(id)   -- NULL for store-path / degrade-path rows
  ```
  Declared inline, so a fresh `memories` table is born with the column — **no `ALTER TABLE`,
  which means no idempotency problem** (`ALTER … ADD COLUMN` was the only thing that wasn't
  re-runnable; it is gone).
- The `segments` table + its index (§3.2) are added to `createSchema` alongside the existing
  `CREATE TABLE IF NOT EXISTS` statements. `foreign_keys = ON` is already set (`database.ts:42`).

This mirrors exactly how the schema is already declared: one body of
`CREATE … IF NOT EXISTS` plus the existence-checked vec/fts virtual tables. There is no
`runMigrations`, no `PRAGMA table_info` guard, and no "brand-new-vs-existing" branch.

### 4.2 `SCHEMA_VERSION` is a stamp; stale DBs are dropped-and-recreated

`SCHEMA_VERSION` bumps **`'3' → '4'`** (`database.ts:30`). It remains a plain version stamp,
written by the existing `ensureSchemaMeta` upsert (`upsert.run('schema_version', SCHEMA_VERSION)`)
— **no migration logic reads it to transform data.** But it *is* read for one purpose: to detect
and discard a stale on-disk schema so the system self-heals.

The hazard: a pre-change DB has an **old `memories` table without `segment_id`**. `createSchema`'s
`CREATE TABLE IF NOT EXISTS memories` no-ops on it (the table already exists), so the new column is
never added, and the first `SELECT … segment_id` / `INSERT … segment_id` throws
`no such column: segment_id`. We must not crash confusingly.

**Chosen handling — option (a): stamp-gated drop-and-recreate (works out of the box).** In
`initDatabase`, before `createSchema`, read the on-disk `schema_meta['schema_version']` (the
`schema_meta` table itself is read defensively — absent ⇒ treat as a fresh DB, no drop). If the
stamp is **present and older than `SCHEMA_VERSION`**, drop the schema (the `memories`, `segments`,
`schema_meta` tables and the `vec_memories` / `memories_fts` virtual tables) and let `createSchema`
rebuild it from scratch. A fresh DB (no stamp) and a current DB (stamp `=== '4'`) both skip the
drop. This reuses the `SELECT … FROM sqlite_master` / `SELECT value FROM schema_meta` read idioms
already in the file (`ensureSchemaMeta` already reads `schema_meta` for the embedding model).

> **This deliberately discards old data.** Under the back-compat-free directive that is acceptable
> and explicitly intended: a stale DB is *rebuilt*, not migrated. The corpus DB is regenerated via
> `scripts/memory-corpus/build-corpus.ts` (which re-ingests, so segments get populated); user/session
> DBs are recreated empty on first open. Option (b) — "document that old DB files must be deleted by
> hand" — is rejected as the default because it is *not* out-of-the-box-correct: it requires a manual
> step and the un-deleted DB crashes with `no such column`. The stamp-gated drop self-heals with zero
> operator action, which is exactly the directive's bar.

### 4.3 The NULL-`segment_id` case is a normal current case (not a back-compat artifact)

A `NULL` `segment_id` is a **first-class current state**, not a legacy remnant: store-path rows
(`memory_store`, §3.3) and degrade-mode single-blob ingests (§6.2) genuinely have **no parent** —
there was no decomposition, so there is nothing coarser to retain. Re-expansion (§5) treats a fact
with `segment_id = NULL` as **its own parent** and returns the fact text unchanged. This is current
design behavior described fully in §5.3; it is not "migration" or "pre-migration" behavior.

---

## 5. Retrieval — "index fine, return coarse"

### 5.1 What is unchanged (the whole ranker)

The ~11-step `recall` pipeline (`pipeline.ts:36-125`) is **untouched** through dedup: embed query
→ vector KNN + FTS → `hybridScoreFusion` → tag filter → `computeCompositeScore` →
`filterByRelevance` → `rerank` → `filterByRerankerScore` → load embeddings →
`deduplicateByEmbedding` (`pipeline.ts:114`). The candidate set, scores, and ordering are identical
to today. Re-expansion is inserted as a new **step 9b**, strictly *after* `deduplicateByEmbedding`
and *before* `packToBudget` (`:117`) / `formatMemories` (`:125`).

**Passage ranking is NOT a change to the candidate ranker.** Step 9b ranks *passages of an
already-selected segment* by similarity to the query embedding, to decide which slice of a parent
to **return**. This is a post-retrieval, return-shaping operation on a single segment's text — it
never touches the candidate set, the fusion scores, the reranker, or the order of the kept facts.
"Do not touch the ranker" (steps 1–9, byte-for-byte) and "rank passages on return" are orthogonal:
the first is about *which memories win*; the second is about *which slice of a winner's parent to
show*. The reused query embedding (from step 1, `embedQuery`, `pipeline.ts:43`) is a read of an
existing value, not a re-run of any ranking stage.

### 5.2 The expansion option — `expand: 'none' | 'auto' | 'parent'`, default `'auto'`

`RecallOptions` (`types.ts:53-58`) gains:

```ts
expand?: 'none' | 'auto' | 'parent';   // default 'auto'
max_expand_passages?: number;          // cap on returned passages, default 2 (§5.4)
```

`recall` tool schema (`tools/recall.ts`, the Zod block in `server.ts`) gains an optional
`expand` enum and `max_expand_passages` number, both passed through `handleRecall` →
`engine.recall` → `retrievalRecall`.

| Mode | Behavior |
|---|---|
| **`'auto'` (default)** | After dedup (step 9b), if **≥2 kept facts share a non-null `segment_id`**, expand that shared parent (return its query-ranked passages). A single fact with a lone parent stays a fact (no expansion). |
| **`'none'`** | Force off. Facts are returned, no segment lookup, no extra query, no budget change — **byte-for-byte today's** behavior. |
| **`'parent'`** | Force expand: emit the parent passage for **every** kept fact that has a non-null `segment_id`, even a lone one. |

**Why `'auto'` is the default (the off-by-default fix).** The Bandalert loss occurred on an
**ordinary recall with no flag** — so an opt-in `'none'` default (v1) could never have fixed it; the
load-bearing behavior was deferred out of the default path. `'auto'` fixes the evidenced failure on
a default call, and it needs **no query classifier**: the discriminator is purely structural — *do
≥2 of the kept facts point at the same parent?* That shared-parent grouping is the exact contract
signature (7 headline facts, one shared segment) and is **already computed** for parent-dedup
(§5.3), so `'auto'` adds no new machinery. It does **not** regress pinpoint queries: a pinpoint
recall returns one matched fact, which has at most one parent and therefore one fact per
`segment_id` → no expansion → the crisp fact, exactly as today.

**Why not always-on (`'parent'` as default).** Force-expanding a lone-parent fact turns a pinpoint
answer ("what's my Anthropic API key var name?") into a passage lookup for no benefit and risks
evicting other facts under the default budget. `'auto'`'s ≥2-shared-parent gate is the minimal
trigger that catches the contract case while leaving pinpoint recall untouched.

**`buildContext`/`memory_context` is wired to `'auto'` too** (`engine-impl.ts:279`). The briefing
path is the **no-human-in-loop** place where missing a clause is most costly — there is no agent to
notice the headline is thin and ask a follow-up — so it gets the same auto-expansion. Its budget is
**800** (`CONTEXT_DEFAULT_BUDGET`, `engine-impl.ts:270`), which a ~300-token passage comfortably
fits alongside facts.

### 5.3 Step 9b — parent re-expansion (passage AUGMENTs the facts; passage-only parent-dedup)

Input: `kept` (the post-dedup `ScoredMemory[]`, `pipeline.ts:114`), already sorted by score, plus
`queryEmbedding` (already computed at step 1, `pipeline.ts:43`).

> **AUGMENT, not replace.** An earlier draft had an expanded segment's chosen passage *replace* its
> sibling facts (the facts "collapsed into" the one passage). That is wrong for a multi-term source:
> a contract segment's facts are about **different** terms (ownership, valuation, profit-sharing,
> governance, execution), so collapsing them into one passage about **one** term destroys breadth —
> on the live corpus, a "key terms" survey query returned a *worse* answer with `expand:'auto'` than
> with `expand:'none'` (five distinct key-term facts evicted for one execution-terms passage). The
> corrected design **keeps every fact** and treats the passage as **supplementary**: passages are
> appended *after* all the facts. **Parent-dedup applies to passages (one per shared parent), never
> to facts.**

```
if expand === 'none': proceed to packToBudget as today.   // unchanged path

// expand === 'auto' | 'parent':
1. Group kept facts by non-null segment_id, recording each group's best-ranked-fact position.
2. Decide which segments to EXPAND:
     - expand === 'parent'  → every group with a non-null segment_id (size ≥1)
     - expand === 'auto'    → only groups whose size is ≥2 (a SHARED parent)
3. Fetch the selected segments by id in one query (getSegmentsByIds(db, ns, ids)).
4. For each expanded segment, SPLIT-AND-RANK to a passage (§5.3.1):
     - split segment.content into coherent passages (paragraph/turn/sentence boundaries,
       each capped ~300–400 tokens);
     - embed each passage and rank by cosine similarity to queryEmbedding;
     - choose the top passage per segment.
5. Build the display list as AUGMENT:
     a. Emit EVERY kept fact as a fact unit, in score order — byte-for-byte what `expand:'none'`
        returns. No fact is ever dropped, skipped, or reordered by expansion. (store-path / degrade
        NULL-segment facts and forgotten-parent facts are just normal facts here.)
     b. APPEND the chosen passages AFTER all the facts, in segment-best-rank order (each passage
        rides on its segment's best-ranked fact for date/importance rendering, with a distinct id
        so it is not an id-collision duplicate of that fact). Apply passage parent-dedup (one
        passage per segment), passage overlap-dedup (§5.3.2), and the max_expand_passages cap
        (§5.4) to the appended passages only.
6. The result is a score-ordered list of fact units followed by ≤max_expand_passages passage units.
```

Because the unchanged greedy skip-not-break `packToBudget` packs the display list **in order**,
putting passages **last** means the breadth facts are packed first and a passage only ever consumes
**leftover** budget. **This is the load-bearing property: auto-expand can never evict a fact that
`expand:'none'` would have kept.** In the contract case the ~7 headline facts (about different
terms) are all preserved AND the query-relevant clause passage (carrying e.g. the `$250k` cap, never
a fact) is appended when budget allows — **the fix for the Bandalert failure, on a default `'auto'`
recall with no flag, without sacrificing breadth.**

#### 5.3.1 Split-and-rank: the returned unit is a query-relevant passage, not the chunk

Returning the **whole 6000-token chunk** is wrong twice over: (1) it can never fit the 800-token
default budget, so under v1 it would have degraded straight back to the headline — the original bug;
and (2) a 6000-token conversation window is the **least coherent** possible parent — an arbitrary
token span, not a unit of meaning. Both are fixed by returning a **passage**:

- **Split** `segment.content` on coherent boundaries — paragraph breaks, conversation turns, or
  sentence boundaries as a fallback — into pieces each capped at ~300–400 tokens. A passage is a
  coherent unit; an arbitrary token window is not.
- **Rank** the passages by cosine similarity to the **query embedding already computed at step 1**
  (`embedQuery`, `pipeline.ts:43`) — no second query embed. The passage embeddings are computed with
  the same `embed`/`embedQuery` path the rest of the system uses.
- **Return** the top passage(s), up to `max_expand_passages` and the budget (§5.4). The contract's
  "$250k cap" clause comes back as the ~300-token passage the query actually wanted — which **fits**
  the 800-token budget — not 6000 tokens of conversation.

This also resolves the open question about feeding 6000 tokens to the `summary`/`answer` Haiku
formatter (which runs with `maxTokens: tokenBudget`, §5.5): the text handed to the formatter is now
passage-sized, so the formatter never sees the oversized chunk.

**Decision: recall-time split-and-rank, not ingest-time pre-split.** Recall-time keeps storage
simple (segment stays one `content` blob; no passages table, no per-passage embeddings persisted)
and only does the split/embed work when auto-expansion actually fires — which is rare relative to
total recalls (only shared-parent groups). Ingest-time pre-split would precompute passages + their
embeddings and avoid the recall-time embed, but adds a passages table and write-path cost on every
ingest for a path that fires occasionally. Recall-time is the simpler default; ingest-time pre-split
is a noted optimization (§8) if profiling shows the recall-time passage embed is hot. Either way the
**storage unit may remain `segment = chunk`**; only the *returned* unit is passage-sized.

#### 5.3.2 Overlap dedup (A6, minor)

`chunkBlob` windows overlap ~10–15% (`extraction.ts` `chunkBlob` comment; the overlap preserves
cross-references at chunk boundaries). If two *adjacent* segments are both expanded in one result —
e.g. a fact from each side of a boundary shares text — their chosen passages may contain the same
sentences. Because the returned unit is now a **passage**, a cheap **passage-text overlap dedup**
handles this: when emitting passages, drop a passage whose normalized text is a (near-)substring of
an already-emitted passage. This is a small string check on the (few, ≤`max_expand_passages`)
emitted passages, not an embedding pass. It is a no-op for the common single-expanded-parent case.

### 5.4 Budget accounting (simplified — passages are fact-sized, not chunk-sized) + out-of-the-box defaults

**Default budget is bumped 500 → 800 so the system returns useful context with zero configuration.**
The out-of-the-box directive requires that a *default* recall return the relevant passage **plus**
a couple of facts. A passage is ~300–400 tokens and a fact ~150; at the old default of **500**,
once the facts have packed first (AUGMENT) a single ~400-token passage rarely has room to ride
along — so the shared-parent depth would simply not surface (auto ≈ none). Bumping
`MEMORY_DEFAULT_TOKEN_BUDGET` (`config.ts:70`) to **800** comfortably fits 2–3 facts **and** one
~300–400-token passage (~3×150 + 400 ≈ 850, packed greedily to ≤ 800), which is exactly the desired
shape. `memory_context`
stays **800** (`engine-impl.ts:270`); the two default budgets are now equal, which is intentional —
both paths want the same "one passage + a few facts" envelope. **No flag and no config tuning are
needed** to get parent context on shared-parent queries.

v1's elaborate two-tier `expand_budget_fraction` existed for **one** reason — to *reject* a
6000-token segment that could never fit — and passage return removes that reason entirely. So the
budget machinery is simplified:

- Re-expansion produces display units that each carry their own `displayContent` (a chosen passage
  for an expanded unit, fact text otherwise) and `displayTokens = estimateTokens(displayContent)`.
- Packing reuses the **existing** `packToBudget` greedy *skip-not-break* discipline
  (`scoring.ts:200-212`): walk the score-ordered display list; include a unit if it fits the
  remaining budget, else `continue` (skip, don't break). No segment sub-budget, no second pass.
- The only added guard is a small **count cap**: at most `max_expand_passages` (default **2**)
  passages may be appended across the whole result. With AUGMENT the cap is belt-and-suspenders
  (passages are appended *after* the facts and only consume leftover budget, so they cannot evict a
  fact regardless of the cap); it mainly bounds explicit `'parent'` calls with a raised budget.

**Why a count cap of 2 against budget=800 with ~300–400-token passages and ~150-token facts.** One
~300–400-token passage leaves ~400–500 tokens — room for 2–3 facts; two passages (~600–800 tokens)
already consume most or all of the 800 budget and would leave no room for facts, so beyond the cap
the greedy packer skips additional passages anyway. The cap of 2 is therefore a cheap
belt-and-suspenders bound — it matters mainly for explicit `'parent'` calls with a raised
`token_budget`; at the default 800 the greedy packer mostly self-limits while still leaving room for
the supporting facts. A single dominant passage (the contract clause) plus the facts that still fit
is exactly the desired out-of-the-box shape.

The `expand:'none'` path calls `packToBudget` with the unchanged fact list — **byte-for-byte today's
behavior** (at whatever `token_budget` the caller passes; only the *default* changed). Under AUGMENT,
expansion only ever **appends** passages after the full fact list and never relaxes the skip-not-break
rule, so a budget that fits N facts always still fits those N facts — the passage is the unit that
gets skipped, never a fact.

**Trade-off (intended).** Because passages are appended last, the budget governs *depth*, not
breadth: at a **tight** budget the passage may not fit at all, so `expand:'auto'` degrades to
`expand:'none'` (all the facts, no passage) rather than dropping a fact — a strict no-regression
floor. A **larger** budget simply surfaces more depth (the clause passage, then a second if
`max_expand_passages` and budget allow). Breadth is constant across budgets; only how much parent
context rides along varies.

### 5.5 Formatting + expansion metadata in every format

`formatMemories` (`formatting.ts:13-31`) is fed the packed display units. The minimal change:
the packer emits `ScoredMemory`-shaped units whose `content` is the chosen display text (a passage
for an expanded unit, fact text otherwise). For an expanded unit we set `content = passage.text` and
keep the best-ranked fact's `created_at`/`importance` so the existing `[date] … (importance: …)`
rendering (`formatting.ts:53`, `:122-124`) still works without a new code path. `summary`/`answer`
LLM formatting then summarizes over the **passage** text (passage-sized, so it fits the formatter's
`maxTokens: tokenBudget`) — strictly more relevant information for the same prompt shape.

**Metadata in ALL formats (not just `raw`).** v1 exposed `segment_id`/`expanded` only in `raw`,
which hides exactly the ids an agent needs to follow up. v2 surfaces, on the structured
`RecallResult` regardless of `format` mode:

- `expanded: boolean` — true when any returned unit was an expanded passage;
- `expanded_segment_ids: string[]` — the `segment_id`s that were expanded (empty when none);
- per-unit, in `raw` mode, the `segment_id` and an `expanded` flag (as v1).

The `summary`/`answer` *text* is unchanged in shape; the structured fields ride alongside it.

**Agentic follow-up — the "get headlines → expand the one that matters" loop.** The realistic
agentic usage is: a default `'auto'` recall returns mostly facts (no shared parent) plus maybe one
expanded passage; the agent reads a headline fact, decides *that* one needs detail, and fetches its
parent. Two affordances support this, both driven by the now-visible ids:

- **`memory_expand(segment_id)`** — a small new tool that returns the parent segment's
  query-ranked passages (or, with no query, the whole segment up to a cap) for a given
  `segment_id`. This is the direct "fetch the parent of this fact" call. (§9.4)
- **`expand: 'parent'` re-query** — re-issue the same `recall` with `expand:'parent'` to force the
  matched fact's parent passage. Coarser than `memory_expand` but needs no new tool.

Either way, because `RecallResult` now carries `segment_id`s in every format, the agent has the
handle it needs without parsing `raw` text.

### 5.6 No regression on pinpoint queries (restated for the `'auto'` default)

With the default `'auto'`, a **pinpoint** recall returns one matched fact whose `segment_id` is
unique among the kept set → the ≥2-shared-parent gate does **not** fire → the crisp fact is
returned, identical to today. Auto-expansion only triggers when several kept facts genuinely share a
parent — the briefing/contract shape, where the coarse passage is what the user wanted. Existing
callers that need byte-for-byte-today behavior can pass `expand:'none'`; `buildContext`/
`memory_context` deliberately uses `'auto'` (§5.2) because its no-human-in-loop briefings are
exactly the shared-parent case. The pinpoint case is never *worse* than today.

---

## 6. Ingest changes

### 6.1 Where segments are written

`ingestBlob` (`engine-impl.ts:171-266`) already has the chunks (`chunkBlob`, `:200`) and, per
chunk, the facts (currently unioned across chunks in `extractAllFacts`, `:140-165`). The change:
**one `segments` row per chunk that produced ≥1 fact**, and each fact written from that chunk
carries that chunk's `segment_id`.

The current `extractAllFacts` **flattens** facts across chunks and loses the chunk→fact mapping
(it returns a single `ExtractedFact[]`, `:144`). To link facts to segments we keep the mapping:
`extractAllFacts` returns, instead of a flat list, a list of **per-chunk groups**
`{ chunkText: string; facts: ExtractedFact[] }[]` plus the existing `totalChunks`/`failedChunks`
diagnostics. The cross-chunk exact-`fact`-string dedup (`:158-161`) is preserved but now records,
for a duplicate, which chunk **first** owned it (the dedup keeps first occurrence — that chunk's
segment is the fact's parent). A fact deduped away in a later chunk does **not** create a second
parent link; it stays attached to its first chunk's segment.

### 6.2 The write loop (revised)

```
for each chunk-group g with g.facts.length > 0:
    if not dry_run:
        segId = insertSegment(db, { namespace, content: g.chunkText, source: opts.source,
                                    mode, createdAt, factCount: g.facts.length })
    for each fact f in g.facts:
        store(f.fact, { tags, importance: f.importance ?? seedImportance,
                        source: opts.source, createdAt, segmentId: segId })  // segmentId NEW
```

- `store` (`storeImmediate`) gains an optional `segmentId` in `StoreOptions`, forwarded into
  `insertMemory`'s new `segmentId` param (§3.3).
- **On exact-dedup merge, repoint the survivor to the *richer* parent (order-independence, A4).**
  When a fact **merges** into an existing row (exact-dedup branch, `engine-impl.ts:95-108`), v1 kept
  the survivor's **first** `segment_id`. That makes the parent depend on ingest order: a later,
  richer ingest of the same fact — whose segment carries more clauses — would be discarded purely
  because it arrived second, the exact order-dependence the ingest doc's A1 timestamp fix went to
  lengths to avoid. v2 instead **repoints the survivor's `segment_id` to the segment with the higher
  `fact_count`** (the richer parent — more facts extracted from it ⇒ more clauses likely to ride
  along). Rule:
  - if the survivor's existing `segment_id` is `NULL` (store-path survivor), adopt the incoming
    `segmentId`;
  - else compare `fact_count` of the two segments and keep the higher; ties keep the existing
    (stable, order-independent given equal richness).
  - **The merge path must read both segments' `fact_count`.** `updateMemoryContent`
    (`engine-impl.ts`) is content-only and does not touch `segment_id`, so this needs a small new
    query `updateMemorySegmentIfRicher(db, ns, survivorId, incomingSegmentId)` that looks up both
    `fact_count`s and conditionally rewrites `memories.segment_id` (mirrors the A1
    `updateMemoryTimestampsOnMerge` shape — runs only when `incomingSegmentId` is set, so non-ingest
    merges are byte-for-byte unchanged).
- **`as_of` / `source` / importance / dedup behavior are all preserved.** `createdAt` flows to
  both the segment and its facts (so a segment's `created_at` matches its facts'), `source` is
  mirrored onto the segment, and the existing per-fact importance + exact-dedup/merge machinery
  (`memory-ingest-tool.md` §5.3) is unchanged.
- **Degrade / skip / dry_run:**
  - `dry_run`: no segment and no fact rows written (today's behavior, `engine-impl.ts:247-249`).
  - `degrade` single-blob (`engine-impl.ts:219-238`): the blob is stored as one fact with
    `segment_id = NULL` — there was no decomposition, so there is no parent to retain. (The blob
    *is* the content; re-expansion treats it as its own parent, §4.3.) **No segment row** for the
    degrade path.
  - `skip`: nothing written (unchanged).
- **`maybeRunMaintenance`** still fires inside `storeImmediate` as today; segments are inert to
  maintenance (not in `memories`, so decay/consolidation/compaction never touch them).

### 6.3 Segment lifecycle vs. forget / decay / compaction

`memories` rows can be deleted (`forget`, `deleteMemories` `queries.ts:346`), decayed
(`markDecayed` zeroes importance + removes the vector, `queries.ts:476`), or compacted
(`is_compacted = 1`, `queries.ts:498`). Segments must not be cascade-deleted when a single child
fact is forgotten (siblings may still reference it). Rules:

- **Forget a fact:** the fact row is deleted; its `segment_id` link simply dangles for that
  (now-gone) row. The segment stays as long as **any** fact references it. A fact whose segment
  has been independently removed falls back to emitting the fact (§5.3 step 3, missing-segment
  case) — robust to dangling pointers.
- **Orphan collection (deferred, §8):** a maintenance sweep can `DELETE FROM segments WHERE id
  NOT IN (SELECT segment_id FROM memories WHERE segment_id IS NOT NULL)`. Not required for phase 1
  (orphans are inert and cheap); listed as a follow-up. Because the FK is **not** `ON DELETE
  CASCADE`, deleting facts never deletes segments and deleting a segment is only ever the explicit
  orphan sweep.
- **Decay/compaction** don't delete rows, so segment links survive; an expanded recall of a
  decayed fact still has its parent (though a decayed fact rarely surfaces, since its vector is
  removed).

---

## 7. Phase 2 (optional, deferred) — contextualized embedding

**Idea (Anthropic Contextual Retrieval).** Before embedding a fact, prepend a short context
string derived from its segment (a one-line topic, e.g. "Context: the Bandalert distribution
contract. Fact: …"), so the fact's *vector* carries cross-reference signal it otherwise lacks.
This improves the **retrieval key** (the embedded fact), distinct from §5 which improves the
**returned unit**.

**Why deferred, not in phase 1:**

- It changes the embedded text, so it **must** run only on the ingest path — the LLM-free `store`
  path must never embed contextualized text (it has no segment and no LLM to derive context). The
  clean threading is: `ingest` computes a per-segment `contextPrefix` once (one extra short Haiku
  call per segment, or reuse the segment's first sentence with no LLM), and passes it to `store`
  as a new optional `embedContext?: string`; `storeImmediate` embeds `embedContext + content` but
  **stores** `content` unchanged (so display/FTS/dedup-on-content are unaffected; only the vector
  shifts). When `embedContext` is absent (every `store` call), behavior is identical to today.
- It risks **re-embedding drift**: facts embedded with context aren't directly comparable to
  legacy facts embedded without it, and the corpus diagnostic (`memory-corpus-and-diagnostic.md`)
  was tuned on un-contextualized vectors. Turning this on is a corpus rebuild, not a hot-swap.
- The §5 parent-return fix already recovers the **clause content** for the contract case without
  touching a single embedding — and in v2 it does so on a **default `'auto'` recall** (passage
  return + auto-expansion are both in Phase 1, §11), so phase 1 actually solves the evidenced
  problem on its own. (This corrects v1, which claimed "phase 1 solves it" while the load-bearing
  behavior — expansion on a default recall — had been deferred behind an opt-in `'none'` default.)
  Phase 2 is therefore a pure *recall-rate* optimization to layer on later behind a config flag
  (`MEMORY_INGEST_CONTEXTUALIZE_EMBEDDING`, default off).

**Tradeoff stated:** phase 2 buys better *retrieval* of detail-bearing facts (the fact is more
findable); phase 1 buys *returnability* of detail that was never a fact at all (the clause is in
the segment). They are complementary; the evidenced loss is a returnability problem, so phase 1
is mandatory and phase 2 is optional.

---

## 8. Reference-document handling & `mode='document'`

- **Parent retention fixes the contract case even if decomposition stays lossy.** The headline
  facts ("there is a distribution contract", "it has a buyout clause") are enough to *retrieve*
  the right segment; the **un-decomposed clauses** ($250k cap, IP terms, NDA) ride along in
  `segments.content` and are returned — as the query-relevant **passage** (§5.3) — on a default
  `'auto'` recall (the shared-parent gate fires because all the headline facts point at the one
  contract segment). We do **not** need decomposition to become exhaustive to fix the failure —
  that's the whole point of index-fine / return-coarse.
- **Should `mode='document'` decompose more exhaustively?** **No (decision).** Pushing extraction
  to emit a fact per clause re-introduces over-decomposition (NAACL 2025) and a flood of
  low-importance near-duplicate facts that muddy the index — the opposite of the ingest tool's
  design intent. With parent retention, the clauses are **recoverable** without being indexed.
  `mode='document'` keeps its current explicit-vs-inference contract (`extraction.ts:71-75`); the
  segment carries the detail. (A future, *separate* "exhaustive reference mode" could be added if
  evidence shows clause-level *retrieval* — not just return — is needed; explicitly out of scope.)

---

## 9. Types, tool surface, what callers see

### 9.1 Types (`types.ts`)

```ts
// RecallOptions gains:
expand?: 'none' | 'auto' | 'parent'; // default 'auto'
max_expand_passages?: number;        // default 2 (cap on returned passages, §5.4)

// IngestResult gains (additive, optional):
segments_created?: number;           // count of segment rows written (omitted when 0 / dry_run)

// New row shape (storage/database.ts):
export interface SegmentRow {
  id: string; namespace: string; content: string;
  source: string | null; mode: string | null;
  created_at: number; fact_count: number;
}
```

`MemoryRow` gains `segment_id: string | null`. `Memory` (the public DTO, `types.ts:6-20`) gains
`segment_id: string | null` and `rowToMemory` (`engine-impl.ts:58-75`) maps it.

`RecallResult` (`types.ts:60-64`) gains, **in every format mode** (not just `raw`):

```ts
expanded?: boolean;              // true when any returned unit was an expanded passage
expanded_segment_ids?: string[]; // the segment_ids that were expanded (omitted/[] when none)
```

These additive fields are what enable the agentic follow-up loop (§5.5): an agent that received
headlines reads `expanded_segment_ids` (or, for a non-expanded headline, the per-unit `segment_id`
in `raw`) and calls `memory_expand` (§9.4) on the one it cares about.

The v1 `expand_budget_fraction` option is **removed** (§5.4): passage return makes the two-tier
segment sub-budget unnecessary; `max_expand_passages` replaces it as the single, simpler knob.

### 9.2 `StoreOptions` / `InsertMemoryParams`

`StoreOptions` (`engine.ts:20-30`) gains `segmentId?: string` (optional; only `ingest` sets it).
`InsertMemoryParams` (`queries.ts:11-25`) gains `segmentId?: string`, bound as `NULL` when absent.
Both are additive and optional — the `store`/`memory_store` contract is unchanged.

### 9.3 New queries (`queries.ts`)

- `insertSegment(db, { id?, namespace, content, source?, mode?, createdAt?, factCount })` — one
  INSERT into `segments`; mirrors `insertMemory`'s shape (transaction + `createdAt ?? Date.now()`).
- `getSegmentsByIds(db, namespace, ids): SegmentRow[]` — by-PK batch fetch for re-expansion
  (mirrors `getMemoriesByIds`, `queries.ts:302-308`).
- `updateMemorySegmentIfRicher(db, namespace, survivorId, incomingSegmentId)` — the A4 merge
  repoint (§6.2): adopts `incomingSegmentId` when the survivor has no parent, else keeps whichever
  of the two segments has the higher `fact_count`. Runs only when `incomingSegmentId` is set.
- (deferred §6.3) `deleteOrphanSegments(db, namespace): number`.

### 9.4 `recall` tool schema + new `memory_expand` tool

`server.ts` `memory_recall` Zod block + `tools/recall.ts` `validateRecallInput` gain `expand`
(enum `'none' | 'auto' | 'parent'`, optional, **default `'auto'`**) and `max_expand_passages`
(positive int, optional, default `2`, validated like `validateTokenBudget` bounds). The tool
description gains one sentence: *"`expand` defaults to `'auto'`, which returns the relevant source
passage when several matched facts come from the same source (e.g. a contract's clauses); use
`'none'` for strictly pinpoint facts, or `'parent'` to force the source passage for every match."*

**New `memory_expand(segment_id, query?)` tool** (the agentic follow-up affordance, §5.5).
Following the package's `server.tool()` idiom (deprecated but used uniformly under the file's
eslint-disable block — match it; do not migrate to `registerTool` piecemeal), and routed through a
new `MemoryEngine.expand(segmentId, query?)` method (the only seam holding both `db` and `config`,
per the package's config-injection constraint — a handler-local function cannot reach the embedder):
fetch the segment by id, split-and-rank its passages against `query` (or return the whole segment up
to a cap when `query` is absent), and return them. This is the "I got a headline, give me *this*
fact's parent" call; `expanded_segment_ids`/per-unit `segment_id` from the prior `recall` supply the
id.

### 9.5 What existing callers see

- **The corpus driver** (`scripts/memory-corpus/build-corpus.ts`) calls `ingestBlob` directly; it
  gets segment rows for free (one per non-empty chunk) and a new `segments_created` stat. Its
  content-free logging (`memory-corpus-and-diagnostic.md` "Sensitive data") is unaffected — it
  never logs segment text, only counts. **Sensitive-data / content-free constraints continue to
  hold for all fixtures** (segments are content; fixtures stay ids/counts/numeric only).
- **The diagnostic** (`diagnose-corpus.ts`) uses the production scorers and `packToBudget`
  unchanged. **Conflict + resolution:** two defaults changed that the diagnostic must pin to keep
  its GO/NO-GO verdict comparable to its historical baseline — (1) the default `expand` is now
  `'auto'` (not `'none'`), and (2) the default `token_budget` is now **800** (not 500, §5.4). Both
  affect the *packed output* without touching the candidate **ranker** (the candidate set, fusion,
  composite, rerank and dedup are byte-for-byte unchanged; only the post-dedup display units and how
  many of them fit differ). To keep the verdict in `memory-corpus-and-diagnostic.md` measuring the
  same thing, the diagnostic must **pass `expand:'none'` AND its own explicit `token_budget`** (the
  value it baselined on) rather than inheriting the new defaults — which restores byte-for-byte its
  prior packed output. (This is the one place the `'auto'`/800 defaults are *not* what we want: the
  diagnostic grades the ranker, not the return shape or the budget envelope.) Pinned that way the
  verdict is undisturbed; separate `expand:'auto'` / budget-800 diagnostic passes can later measure
  passage-return quality at the out-of-the-box settings.
- **External MCP clients**: additive only — a tri-state `expand` recall option (defaulting to
  `'auto'`, which can change the *returned* unit for shared-parent queries vs. v0 facts-only),
  `expanded`/`expanded_segment_ids` on `RecallResult` in every format, and the new
  `memory_expand` tool. The candidate ranking they observe is unchanged; the *coarser return on
  shared-parent queries* is the intended behavior change.

---

## 10. Testing strategy

Follow the existing harness exactly: `mkdtempSync(tmpdir(), 'memory-test-')` + `initDatabase(path,
TEST_MODEL)` (`test/database.test.ts:41-44`), real small embedder under the 30s timeout, and the
`vi.mock('../src/llm/client.js', …)` queue from `test/ingest.test.ts:11-26` so the *real*
store/segment pipeline runs while extraction returns canned facts.

### 10.1 Canonical schema / stale-DB rebuild (`test/database.test.ts` extension)

There is no migration runner anymore, so the v2 "upgrade-path" and "idempotent ADD COLUMN" tests
are **deleted**. What remains is the canonical-schema assertion plus the stale-DB self-heal:

- **Fresh DB is born with the canonical schema:** open a brand-new path via `initDatabase` →
  `segments` table exists, `memories` has a `segment_id` column, `schema_meta['schema_version']
  === '4'`. (No migration step ran; `createSchema` built it directly.)
- **Stale DB (older `SCHEMA_VERSION`) is recreated cleanly:** build a DB with the **v3** shape
  (create `memories` *without* `segment_id`, set `schema_meta['schema_version']='3'`, insert a row),
  reopen via `initDatabase`, and assert: the schema is rebuilt (the `segment_id` column now exists,
  `segments` table exists), the version stamp is now `'4'`, the open does **not** throw
  `no such column: segment_id`, and the pre-change row is **gone** (drop-and-recreate deliberately
  discards old data, §4.2). A subsequent `store`/`recall` round-trips on the rebuilt DB.
- **Re-open is a no-op:** `initDatabase` twice in a row on a current (`'4'`) DB does not drop or
  throw (the stamp matches, so the drop branch is skipped).

### 10.2 Ingest links segments (`test/ingest.test.ts` extension)

- **Segment stored + linked:** mock returns 3 facts for one chunk → `segments` has 1 row whose
  `content` equals the chunk, `fact_count === 3`; all 3 fact rows have the same non-null
  `segment_id` pointing at it; `IngestResult.segments_created === 1`.
- **Multi-chunk:** two chunks, distinct facts each → 2 segment rows, each fact linked to its own
  chunk's segment; a boundary fact deduped across the overlap (§6.1) stays linked to its **first**
  chunk's segment (no second link, no second parent).
- **`as_of` on segment:** segment's `created_at` equals the facts' backdated `created_at`.
- **Degrade single-blob:** no-LLM degrade path writes one fact with `segment_id = NULL` and **no**
  segment row; `segments_created` omitted/0.
- **dry_run:** no segment rows, no fact rows (unchanged), `facts` still previewed.
- **Merge repoints to richer parent (A4):** ingest a fact whose segment has `fact_count = 1`, then
  ingest a duplicate (exact-dedup merge) from a *different* segment with `fact_count = 5` →
  survivor's `segment_id` is repointed to the **richer** (5-fact) segment, **regardless of ingest
  order** (run the test both orders; same result). A `NULL`-parent survivor adopts the incoming
  segment; a tie keeps the existing.

### 10.3 Re-expansion (`test/pipeline.test.ts` / new `test/expand.test.ts`)

- **`'auto'` fires on a shared parent — by DEFAULT, no flag (the contract case):** ingest one
  segment carrying the full contract clauses and ~7 headline facts; a default `recall(query)` (no
  `expand` arg) matching several headlines → `expanded === true`, exactly **one** passage is
  returned (parent appears once), and it contains a clause string (e.g. the `$250k` cap) that was
  **never** an extracted fact. This is the direct regression test for the Bandalert failure and it
  must pass **without** passing `expand`.
- **Passage return fits the default budget=800 and contains the clause:** with the default
  `token_budget=800` (the bumped `MEMORY_DEFAULT_TOKEN_BUDGET`, §5.4), the expanded unit is a
  ~300–400-token **passage** (not the 6000-token chunk), it **fits** the budget (assert total
  returned tokens ≤ 800) **with room left for ≥1 supporting fact** (assert at least one fact is also
  returned alongside the passage — the out-of-the-box "passage + a couple of facts" shape), and it
  contains the `$250k` clause. (The v1 failure mode — 6000 tokens skipped by `packToBudget`, degrade
  to headline — must NOT occur.)
- **Passage is query-relevant:** a segment with several distinct clauses (cap / IP / NDA); a query
  about the IP terms → the returned passage is the **IP** passage, not the cap passage (asserts the
  split-and-rank picks the query-relevant slice, not just the first passage).
- **Pinpoint single-fact does NOT expand (no regression):** a default recall whose match is a
  single fact with a lone (or null) `segment_id` → `expanded === false`, the crisp **fact** is
  returned, byte-for-byte today's output. Repeat with `expand:'none'` → identical.
- **`'parent'` force-expands a lone parent:** the same single-fact query with `expand:'parent'`
  → returns the parent passage (proves `'parent'` ignores the ≥2 gate while `'auto'` honors it).
- **Budget / passage cap:** with `max_expand_passages` and a multi-clause segment under a raised
  `token_budget`, no more than the cap of passages are returned and total tokens never exceed the
  budget (skip-not-break preserved).
- **Overlap dedup (A6):** two adjacent overlapping segments both expanded → a shared sentence is
  not emitted twice (passage-text overlap dedup).
- **Parent-less / forgotten-parent (current NULL-segment case):** `store` a plain memory (no
  segment), default `recall` → returns the fact (its own parent, no expansion); a fact whose segment
  was force-deleted falls back to the fact (missing-segment path). This is current design behavior
  (§4.3), not a legacy path.

### 10.4 Tool / registration (`test/recall-tool.test.ts` or existing tool tests)

- `validateRecallInput` accepts/normalizes `expand` (defaults **`'auto'`**, accepts
  `'none'`/`'auto'`/`'parent'`, rejects out-of-enum), validates `max_expand_passages` bounds.
- `RecallResult` surfaces `expanded` + `expanded_segment_ids` in **every** format (summary/answer/
  raw), not just `raw`; per-unit `segment_id` still appears in `raw`.
- **`memory_expand(segment_id)`:** returns the parent's query-ranked passages for the id from a
  prior recall; with no `query`, returns the segment (up to a cap).
- **`memory_context` auto-expands:** a `buildContext`/`memory_context` call over a shared-parent
  corpus returns the passage (asserts the briefing path is wired to `'auto'`, budget 800).

### 10.5 Content-free fixtures

Any expansion/segment fixtures that touch real corpus shape stay **content-free** (ids, counts,
token estimates) per the sensitive-data rule; segment *text* in tests is synthetic
("Contract clause: distribution cap is $250k. …"), never private export content.

---

## 11. Phasing & explicit non-goals

### Phasing

The load-bearing behavior — expansion on a **default** recall, returning a **passage** that fits the
real budget — is in **Phase 1** (v1 had deferred it behind an opt-in default, so v1 did not actually
fix the evidenced loss; corrected here).

1. **Phase 1 (this design, mandatory):** `segments` table + `segment_id` column as part of the
   canonical `createSchema` (no migration runner; stale DBs drop-and-recreate, §4) + ingest
   writes/links segments + **default `expand:'auto'`** re-expansion with **passage split-and-rank**
   + parent-dedup + simplified passage-budget cap (default budget bumped to **800**, §5.4) + A4
   richer-parent merge repoint + metadata in every format + `memory_expand` + `memory_context`
   wired to `'auto'`. **Fixes the evidenced contract loss on a default recall, out of the box.**
2. **Phase 2 (optional, deferred, §7):** contextualized embedding behind
   `MEMORY_INGEST_CONTEXTUALIZE_EMBEDDING` (default off). Improves *retrieval* of detail-bearing
   facts; requires a corpus rebuild. Phase 1 already fixes *return* of un-decomposed clauses.
3. **Phase 3 (optional, deferred, §6.3/§8):** orphan-segment collection in maintenance;
   **ingest-time passage pre-split** (precompute + persist passages/embeddings if the recall-time
   passage embed proves hot); a possible exhaustive reference mode.

### Explicit non-goals

- **NOT building a knowledge graph.** Segments are a flat parent layer, not nodes-and-edges. No
  A-MEM-style inter-note links in phase 1.
- **NOT changing the candidate ranker.** Steps 1–9 of `pipeline.ts` (embed → hybrid search → fusion
  → composite → rerank → dedup) and the existing `scoring.ts` functions are byte-for-byte unchanged;
  the candidate set, fusion, composite, rerank, and dedup are identical. **Passage split-and-rank
  (§5.3.1) is a post-retrieval, return-shaping step on an already-selected segment — it ranks
  *passages of a winner's parent* by the reused query embedding to decide what to *show*, never
  *which memories win*.** The two are orthogonal; "ranker untouched" holds.
- **NOT making decomposition exhaustive.** `mode='document'` keeps its current contract; clauses
  are recovered via the passage, not via more facts (§8).
- **The returned unit is a passage, not the raw 6000-token segment.** A whole-chunk return is
  rejected (§5.3.1): it cannot fit the default budget (800, §5.4) and is the least-coherent parent. (A generated
  abstract/summary tier between fact and passage is deferred/optional — passages already keep the
  returned text small.)
- **NOT re-embedding facts.** Phase 1 adds no new fact-vector dimension and changes no existing
  embedding path; parent-less facts (the NULL-segment case, §4.3) work without an embedding change.
  (Passage embeddings are computed transiently at recall time and not persisted in Phase 1.) Note
  this is orthogonal to the stale-DB rebuild (§4.2): the rebuild *re-ingests* the corpus from
  scratch via `build-corpus.ts`, which embeds each fact through the normal path — it does not
  "re-embed in place."
- **`'auto'` is on by default by design.** Auto-expansion fires only on the ≥2-shared-parent
  signature, so pinpoint recall is never regressed; `expand:'none'` remains available for callers
  (and the diagnostic, §9.5) that need byte-for-byte-today output.

---

## 12. File-change summary

| File | Change |
|---|---|
| `src/storage/database.ts` | `SCHEMA_VERSION '3'→'4'` (plain stamp); add `segments` table + inline `segment_id` column to the canonical `createSchema` (**no `runMigrations`, no `ALTER TABLE`**); in `initDatabase`, read on-disk `schema_meta['schema_version']` and **drop-and-recreate** the schema when older than `SCHEMA_VERSION` (stale-DB self-heal, §4.2); `MemoryRow.segment_id`; `SegmentRow` type. |
| `src/config.ts` | Bump `MEMORY_DEFAULT_TOKEN_BUDGET` **500 → 800** (`config.ts:70`) so a passage + a couple of facts fit out of the box (§5.4); `memory_context` budget already 800 (`engine-impl.ts:270`), now equal. |
| `src/storage/queries.ts` | `InsertMemoryParams.segmentId?`; `insertMemory` binds it (else NULL); new `insertSegment`, `getSegmentsByIds`, **`updateMemorySegmentIfRicher`** (A4 merge repoint, §6.2); (deferred) `deleteOrphanSegments`. |
| `src/storage/extraction.ts` | Reuse `chunkBlob` output as segment content (no change to chunking); new **`splitToPassages(text)`** helper (coherent ~300–400-token passages) for recall-time split (§5.3.1). |
| `src/engine.ts` | `StoreOptions.segmentId?`; new **`MemoryEngine.expand(segmentId, query?)`** method (powers `memory_expand`, §9.4); `RecallOptions`/`IngestResult` additions live in `types.ts`. |
| `src/types.ts` | `RecallOptions.expand: 'none'\|'auto'\|'parent'` (default `'auto'`) + `max_expand_passages` (**replaces** `expand_budget_fraction`); `IngestResult.segments_created?`; `RecallResult.expanded?` + `expanded_segment_ids?` (**all formats**); `Memory.segment_id`. |
| `src/engine-impl.ts` | `storeImmediate` forwards `segmentId` + calls `updateMemorySegmentIfRicher` on merge; `extractAllFacts` returns per-chunk groups; `ingestBlob` writes one segment per non-empty chunk and links facts; `rowToMemory` maps `segment_id`; `recall` threads `expand`/`max_expand_passages`; **`buildContext`/`memory_context` (`:279`) passes `expand:'auto'`**; new `expand()` impl. |
| `src/retrieval/pipeline.ts` | Insert **step 9b** (auto/parent re-expansion: shared-parent grouping + passage split-and-rank against the reused step-1 query embedding + parent-dedup + overlap dedup) after dedup, before `packToBudget`; gate on `expand`. |
| `src/retrieval/scoring.ts` | **Unchanged** `packToBudget` reused for both paths (passage units pack like facts); the v1 two-tier variant is dropped. Only addition: `max_expand_passages` count cap applied before packing. |
| `src/retrieval/formatting.ts` | Display-unit content selection (passage vs fact); surface `expanded` + `expanded_segment_ids` in **every** format; per-unit `segment_id` in `raw`. |
| `src/tools/recall.ts`, `src/server.ts` | `expand` (tri-state) + `max_expand_passages` schema + validation + description sentence; **new `memory_expand` tool** (`server.tool()` idiom) routed to `engine.expand`. |
| `test/database.test.ts`, `test/ingest.test.ts`, `test/expand.test.ts`, recall-tool tests | New/extended per §10 (fresh DB born with canonical schema; **stale-DB drop-and-recreate**, no `test/migration.test.ts`; auto-fires-by-default; passage fits default budget 800 + leaves room for a fact + contains clause; passage query-relevant; merge repoints to richer; pinpoint does NOT expand; `memory_expand`; `memory_context` auto-expands). |
</content>
</invoke>
