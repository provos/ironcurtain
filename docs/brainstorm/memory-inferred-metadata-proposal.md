# Proposal: Auto-inferred metadata for `memory-mcp-server`

**Status:** Brainstorm / proposal for discussion
**Scope:** Should memories get (1) automatically inferred **tags**, (2) an inferred **title**, and (3) be decomposed from raw input into atomic memories via an **`ingest`/`remember` tool**?
**Origin:** Cross-study of [`OpenAnonymity/nanomem`](https://github.com/OpenAnonymity/nanomem) vs. our `@provos/memory-mcp-server`.
**Note:** Nothing outside this project depends on the memory interface, so schema changes are on the table.

---

## TL;DR — recommendation

1. **Decomposition — yes, and the highest-value of the three (Question 3).** Add a separate, explicitly-LLM **`ingest`/`remember` tool** that takes a raw blob (conversation, document, session summary) and fans it out into atomic memories. Keep the existing `store` fast and LLM-free; unlike tags/titles, decomposition must happen **at ingestion, before embedding**, so it cannot be deferred to consolidation.
2. **Tags — yes, infer them, but the inference must converge on an existing vocabulary, not invent free-form labels.** Run it in the **deferred consolidation pass** (which already makes a batched LLM call and already has the namespace loaded), never on the synchronous write path. Caller-supplied tags stay authoritative; inference only fills the gap and canonicalizes.
3. **Titles — yes, but lazily and conditionally, not for every memory.** A title earns its keep for **compacted/long** memories (where it's nearly free and genuinely aids scanning); for short atomic facts it's mostly a restatement of `content`, so derive it mechanically or skip it.
4. The single most important *tag-consistency* decision is **vocabulary convergence**. Naive LLM tagging produces "preference" / "preferences" / "user-pref" sprawl that makes our AND-filter and stats *worse*, not better.

The reasoning below explains why these are the right calls given that **our retrieval is already semantic** (so metadata doesn't have to carry recall the way it does in nanomem) and our **write path is deliberately LLM-free**.

---

## 1. What the two systems actually do

### nanomem (the source of the ideas)

| Dimension | nanomem |
|---|---|
| Storage | Plain **markdown files**. No embeddings, no vector store, no ANN anywhere. |
| Record | A markdown **bullet** with pipe-delimited metadata: `text \| topic= \| tier= \| status= \| source= \| confidence= \| updated_at= …` |
| "Tags" | **No free-form tag array.** A single normalized `topic=` slug (LLM-suggested, *often overridden by the folder name*), plus **which file/folder the LLM writes to** as the real organizing axis. Strong "prefer fewer, broader files" bias. |
| "Title" | Per-**file** `oneLiner` = **mechanical** concat of the first ≤4 active fact texts, truncated to 120 chars. *No LLM.* No per-memory title or abstractive summary anywhere. |
| Retrieval | **LLM agent navigates the markdown tree** + literal substring search; mechanical fallback score fuses keyword overlap + tier + status + source-trust + confidence. |
| Write | **Every write is an LLM call** — extract facts, then decide create / append / corroborate (boost confidence) / supersede (decay confidence). |
| Decomposition | **One input → many memories.** A conversation/document is split by the LLM into atomic bullets across files; long inputs are chunked. |

The thing to internalize: in nanomem the topic slug + folder placement + oneLiner **are the retrieval index** — there's nothing else. They are forced to be good because there are no embeddings.

### Our `@provos/memory-mcp-server`

| Dimension | Ours |
|---|---|
| Storage | **SQLite** + `sqlite-vec` (768-dim BGE embeddings, cosine) + **FTS5** (`content`, `tags`) + cross-encoder reranker (ms-marco-MiniLM). |
| Record | `id` (opaque hex), `namespace`, `content`, `tags[]`, `importance`, timestamps, `access_count`, `is_compacted`, `compacted_from`, `source`, `metadata`. **No `title`/`name`/`slug`/`description`.** (`types.ts:6-20`) |
| Tags | **User/agent-supplied only**, optional, free-form, no controlled vocabulary, capped at 50/100-char (`validation.ts:8-9`). Used as: FTS signal (weighted 1.5 vs content 3.0), **AND/intersection post-filter** on recall (`pipeline.ts:74-79`), and stats (`computeTopTags`). **No inference anywhere.** |
| Title | **None.** `content` is the only human-readable label; `id` is opaque hex. |
| Retrieval | 11-step pipeline: embed query → hybrid vector+FTS candidate gen → relative-score fusion → tag filter → composite score (recency/importance/access) → relevance gate → cross-encoder rerank → embedding dedup → token-budget pack → format. |
| Write | **Synchronous path makes zero LLM calls** — embed + exact-dedup (cosine > 0.95 merge). Heavier dedup/contradiction is **deferred to consolidation** (batched LLM call every ~50 stores; degrades to "mark all distinct" with no LLM). Compaction does LLM cluster-summarization. |
| Decomposition | **None server-side.** `store` takes a single pre-formed fact; splitting raw input into atomic facts is left entirely to the calling agent. |

The thing to internalize: **our recall is already semantic.** Vector + FTS + reranker find relevant memories without help from tags or titles. So inferred metadata in our system is *not* needed for recall — its value is filtering, browsing/inspection, and dedup. That changes the cost/benefit versus nanomem entirely.

---

## 2. Question 1 — should tags be automatically inferred?

### The reframe

Borrowing "infer tags" from nanomem without borrowing its constraints is a trap. nanomem doesn't even *have* a free-form tag array — it has one normalized `topic` slug that is frequently overwritten by the folder name. Its consistency comes from **(a) normalization** (`normalizeTopic`: lowercase/slugify/collapse) and **(b) a tiny vocabulary** (folder names, with a "few broad files" rule). That discipline is the whole point.

Our tags are free-form strings supplied ad hoc by whatever agent is writing. If we bolt naive LLM inference on top — "read content, emit tags" — we get **vocabulary drift / tag explosion**: `preference`, `preferences`, `user-preference`, `pref`, `prefs` all coexisting. That actively degrades the two things tags are actually for in our system:

- the **AND-filter** on recall (callers can't predict which spelling to filter on), and
- **stats / browsing** (`memory_inspect view=tags` becomes noise).

So the question is not "infer or not" — it's **"how do we keep inferred tags self-consistent."**

### Recommendation

**Infer tags during consolidation, against a converging vocabulary, never overwriting caller tags.**

Three design choices, in priority order:

1. **Closed-loop vocabulary (the load-bearing decision).** When inferring, hand the LLM the namespace's existing top-N tags as a *preferred* vocabulary: "reuse one of these unless none fit; only mint a new tag when genuinely novel." The tag space then **converges** instead of exploding. This is the soft analogue of nanomem's "check whether an existing file can absorb this before making a new one."
2. **Canonicalization.** Slugify (lowercase, dash, dedupe) on the way in; optionally an **embedding-based near-duplicate merge** at consolidation time (we already have the embedder) so `user-prefs` ≈ `preferences` collapses.
3. **Run it in deferred consolidation, not synchronous write.** Consolidation (`storage/consolidation.ts`) already (a) fires a *batched* LLM call, (b) has the namespace's neighbors loaded for dedup, and (c) operates on exactly the `consolidated:false` rows new writes produce. Tag inference + canonicalization ride that same pass for ~no extra architecture and ~no extra latency on the hot path.

**Caller tags remain ground truth.** If the storing agent supplied tags, keep them; inference *augments/fills*, it does not overwrite. (The system prompt already nudges agents to tag — that signal is higher-quality than inference and should win.)

### Why this is worth doing even though recall is already semantic

Because the payoff is **faceting, browsing, and forget-by-tag** — not recall. Today an agent that didn't bother to tag leaves a memory un-filterable and invisible to `view=tags`. Inference guarantees a baseline of consistent facets across the whole store, which makes `memory_recall tags=[…]`, `memory_forget tags=[…]`, and inspection reliable.

---

## 3. Question 2 — should memories get an inferred title?

### The reframe

nanomem's "title" is **mechanical** and **per-file** (`oneLiner` = concat of first 4 bullets). It has **no per-memory title at all**. Our memories are **atomic facts**, frequently a single sentence. A per-memory abstractive title over a one-sentence fact is often just a lossy restatement of `content` — pure cost, little gain.

But two cases break that symmetry:

- **Compacted memories** are LLM-summarized clusters; `content` can be long, and the compaction LLM call *already runs* — emitting a one-line headline alongside the summary is essentially free and genuinely useful.
- **Long `content`** (the schema permits up to 10k chars) is hard to scan in `memory_inspect`, the daemon UI, and `view=export`. A headline is the difference between a browsable store and a wall of text.

### Recommendation

**Add an optional, lazily-inferred `title` (short headline, ≤ ~80 chars). Never required, never blocks a write.** Inference strategy by case:

- **Compacted / consolidated memories:** emit `title` from the same LLM call that already produces the summary (free).
- **Long `content`:** infer a headline during the consolidation pass (alongside tag inference — one call).
- **Short atomic facts:** derive mechanically (first clause / truncate, nanomem-style) **or leave null.** Don't spend an LLM call to paraphrase one sentence.

Surface `title` in `memory_inspect` (all views), the web UI lists, and `export`; add it as an FTS column weighted between content (3.0) and tags (1.5) — say ~2.0 — so a good headline gives a modest keyword-recall boost as a side effect.

### Bonus consideration — a human-readable handle

Our `id` is opaque hex. The user's *own* auto-memory system (the `MEMORY.md` + per-file `name:` slug convention) shows the value of a stable, human-readable name. A normalized `title` could double as a **slug/handle** for reference and `forget`. Worth deciding explicitly; for v1, a display-only `title` is the minimum, and slug-as-handle is an easy follow-on.

---

## 4. Question 3 — expanding one request into many (fact extraction)

> Highest-value of the three. Unlike tags and titles, this one materially improves *recall*, and it's the one feature that cannot be deferred to consolidation.

### What nanomem does

nanomem's ingestion is not "store this string." You hand it a **conversation or document**, and an agentic loop **extracts the durable facts** and fans them out into many bullets across (potentially) many files — `create_new_file` / `append_memory` / `update_bullets` / `corroborate_bullet`, once per fact, with long inputs chunked. One ingestion request → N writes, and each extracted fact is independently routed to create / append / corroborate / supersede.

### Where we stand

Our `memory_store` takes a single `content` documented as "a single fact," and does **zero** extraction — decomposition is pushed entirely onto the calling agent. So:

- We already have nanomem's **per-fact routing**: exact-dedup at write (`engine-impl.ts:87-98`) + merge/contradiction in consolidation (`storage/consolidation.ts`).
- We lack nanomem's **per-input fact extraction**: splitting one raw input into atomic facts.

### Why this matters *more* for us than for nanomem

Our recall is **embedding-based**. A compound `content` — *"prefers dark mode, lives in Portland, manager is Alice"* — embeds to one muddy centroid vector; recall for any single fact inside it is degraded, and exact-dedup, `importance`, and decay all operate at the wrong granularity. nanomem's substring + tree-navigation retrieval tolerates fat bullets; **our vector index does not.** Clean atomic facts are a *retrieval-quality requirement* for us, not merely tidiness — which is why this ranks above tags and titles.

### The architectural twist — this one can't be deferred

Tags and titles ride the deferred consolidation pass because they *annotate* an already-stored row. Decomposition is different: **splitting has to happen before embedding**, so each fact gets its own clean vector. Deferring it would let a compound row pollute recall until it's split, then re-embed the pieces — backwards. So decomposition belongs at **ingestion** — not in consolidation, and not bolted onto the synchronous `store` (which stays LLM-free).

### Recommendation — a two-tier ingestion surface

Mirror nanomem's own conversation-vs-document split with two distinct tools:

1. **Fast path — `store` stays LLM-free; the caller pre-decomposes.** The in-loop agent is already an LLM with full conversational context, so it's the best-placed splitter and it's free to us. Strengthen the system prompt ("one atomic fact per `store`") and let `store` accept `content: string | string[]` so the agent can submit a pre-split batch in a single call.
2. **Heavy path — a new, explicitly-LLM `memory_ingest` / `remember` tool.** Input: a raw blob (conversation transcript, document, or the session-close summary produced by `src/memory/auto-save.ts`). Behavior: one LLM call extracts atomic facts, then each is written through the *normal* `store` → dedup → consolidation machinery — extraction is the only new step; embedding, routing, dedup, tagging, and titling all reuse what already exists (and what §2/§3 add). Long inputs chunk like nanomem. Kept clearly separate from `store` so the hot-path LLM-free guarantee survives, and so external/non-agent MCP clients (this is a standalone published server) still get good atomicity when they hand over a blob.

`src/memory/auto-save.ts` is the natural first consumer: today it asks the agent to store a session summary; it should instead route that summary through `ingest`, so a session becomes a set of atomic facts rather than one blob.

#### `memory_ingest` tool sketch

```ts
// Heavy, LLM-backed; distinct from the fast memory_store.
{
  content: string;                     // raw blob: conversation, document, or summary
  source?: string;                     // e.g. 'session:abc', 'document', 'conversation'
  mode?: 'conversation' | 'document';  // strict (explicit facts only) vs. broader extraction
  tags?: string[];                     // optional seed tags applied to every extracted fact
  importance?: number;                 // optional default importance for extracted facts
  dry_run?: boolean;                   // return proposed atomic facts without writing
}
// → { ingested: number; memory_ids: string[]; facts?: string[] }   // facts[] when dry_run
```

`mode` carries nanomem's strict-vs-broad distinction (conversation: only what was explicitly stated, no inference; document: reasonable inference allowed). `dry_run` previews the decomposition before committing — useful for the agent loop and for tests. With no LLM configured, `ingest` degrades to storing the blob as a single memory (and says so), preserving graceful degradation.

---

## 5. Concrete schema/flow changes (if approved)

1. **New `memory_ingest` tool (`tools/ingest.ts` + registration in `server.ts`):** LLM-backed fact extraction → writes each atomic fact through the existing `store` → dedup → consolidation path. Params: `mode` (conversation|document), `dry_run`, optional seed `tags`/`importance`. Chunks long inputs. Degrades to a single-blob store when no LLM is configured.
2. **`memory_store` accepts `content: string | string[]`:** lets a capable caller submit a pre-split batch in one call without invoking the LLM path.
3. **Route `src/memory/auto-save.ts` through `ingest`:** session-close summaries get decomposed into atomic facts instead of stored as one blob.
4. **Schema:** add nullable `title` column + matching FTS column; bump `schema_meta` version (3 → 4) with a migration. Tags stay `string[]`.
5. **Consolidation pass (`storage/consolidation.ts`):** extend the existing batched LLM call to *also* (a) propose canonical tags against the namespace's existing top-N vocabulary, and (b) emit a `title` for long memories. Mechanical fallback (truncate/first-clause) for short content and for the no-LLM degraded mode.
6. **Compaction (`storage/compaction.ts`):** have `compactCluster` return `title` alongside the summarized `content` (free — same call).
7. **Retrieval/format/inspect + web UI:** surface `title`; add the FTS weight; show it in inspect/export/UI lists.
8. **Invariants:** caller-supplied tags are never overwritten; the `store` write path stays LLM-free; everything degrades gracefully when no LLM is configured.

---

## 6. Alternatives considered and discarded

| # | Alternative | Why discarded |
|---|---|---|
| 1 | **Infer synchronously at write time** (nanomem: "every write is an LLM call"). | Destroys our deliberate LLM-free, low-latency, graceful-degradation write path; adds per-store cost/latency. nanomem can afford it because the LLM *is* its engine — we have local embeddings doing recall, and consolidation already gives inference a batched home. |
| 2 | **Free-form inferred tags with no vocabulary control.** | Tag explosion / vocabulary drift makes the AND-filter and stats *less* reliable than no inference. The converging-vocabulary loop is the fix; without it, don't infer at all. |
| 3 | **Adopt nanomem's folder + single-`topic` model wholesale (drop tag arrays).** | It's a workaround for *not having embeddings*. We already have hybrid semantic retrieval, so tree navigation buys nothing and we'd lose multi-label faceting. (We *do* borrow the single-normalized-topic discipline as the canonicalization rule for tags.) |
| 4 | **Mechanical-only title (nanomem `oneLiner` style), no LLM ever.** | Kept as the *fallback* for short content / no-LLM mode, but rejected as the sole mechanism: for compacted/long memories an abstractive headline is meaningfully better and nearly free (compaction already calls the LLM). |
| 5 | **Separate per-memory abstractive `summary` field (distinct from title) for all memories.** | Overkill for v1: atomic facts don't need it, it's redundant with `content`, and it doubles inference cost. Fold headline into `title`; revisit only if long-content memories become common. |
| 6 | **Fixed enum tag taxonomy (predefined global categories).** | Too rigid for an open personal-memory domain; brittle as the domain grows. The soft converging-vocabulary approach gets most of the consistency benefit without a hard schema. |
| 7 | **Title as a required field.** | Would force an LLM call (or a bad mechanical guess) on every write, re-introducing the write-path coupling from #1. Optional + lazy avoids it. |
| 8 | **Synchronous LLM extraction inside `store`** (nanomem-style, but on our hot path). | Re-couples the fast write path to an LLM and kills its zero-LLM / low-latency guarantee. The separate `ingest` tool delivers extraction without touching `store`. |
| 9 | **Defer decomposition to the consolidation pass** (the way we defer tags/titles). | Splitting must precede embedding — a compound row pollutes recall until it's split, and split-then-re-embed is wasteful and backwards. Decomposition belongs at ingestion. |
| 10 | **Status quo: single-fact `store` only, all decomposition left implicit on the caller.** | Fine when the caller is a capable, well-prompted agent; fragile for blob inputs, session summaries, and external/non-agent clients. We keep caller-side splitting for the fast path but add the `string[]` affordance and `ingest` for everything else. |

---

## 7. Out of scope, but worth borrowing later

These came out of the nanomem study and are *not* part of the tags/title decision, but are strong ideas to track:

- **Confidence as a first-class, mutating field** (corroboration → gentle boost; contradiction → sharp decay). We already detect contradictions in consolidation but resolve only by supersession; a confidence signal is a softer, auditable alternative.
- **Retrieval self-assessment metadata** (`coverage`, `missing_variables`, low-confidence flags) returned from `memory_recall`, so agent loops know when to ask the user instead of guessing.
- **Tiered memory + automatic expiry** (working / long-term / history, with LLM-set `expires_at` and a zero-LLM prune). Our `importance` decay is the rough analogue; explicit tiers + expiry are more legible.

---

## 8. Open questions for the reviewer

1. Should `title` double as a stable human-readable **handle/slug** (for `forget`/reference), or stay display-only for v1?
2. What's N for the "existing top-N tags" vocabulary handed to the inference call — global top-N, or query-relevant neighbors' tags?
3. Do we want an embedding-based tag-merge step now, or start with slug-normalization only and add merge if drift still appears?
4. **`ingest` rollout:** ship both the `content: string[]` batch affordance on `store` *and* the heavy `ingest` tool, or start with `ingest` alone?
5. **`ingest` model:** reuse the consolidation/compaction LLM config (`config.ts` default `claude-haiku-4-5`), or use a stronger model for extraction quality?
