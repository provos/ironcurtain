# Design: `memory_ingest` — LLM-backed fact decomposition tool

**Status:** Design v2 (review-amended) — no implementation
**Scope:** Builds **only** Question 3 / decomposition from
[`docs/brainstorm/memory-inferred-metadata-proposal.md`](../brainstorm/memory-inferred-metadata-proposal.md).
Question 1 (auto-inferred tags) and Question 2 (titles) are **explicitly deferred** — this doc does not design them.
**Package:** `packages/memory-mcp-server/`

> **v2 amendments.** This tool is dual-purpose: a product feature (decompose blobs into
> atomic-fact memories) **and** the substrate for building a representative eval corpus from a
> multi-year claude.ai conversation export (each conversation ingested with its real date via
> `as_of`). An adversarial review found the v1 design pushed **recency and importance fidelity**
> onto an out-of-scope "eval driver" — but those are **insert-time** decisions only this tool
> can make. v2 moves them in: **per-fact importance from extraction** (A2), **order-independent
> merge timestamps** (A1), a **controllable extraction-failure mode** with observable partial
> extraction (A3), **durability-focused prompts** (A4), **window overlap** in chunking (A5),
> **PII-safe logging/errors** (A6), and **honest result stats** (A7). The driver itself (a
> separate script) is still out of scope; see §13.

---

## 1. Overview

`memory_ingest` is the heavy, explicitly-LLM ingestion path. It takes a raw blob
(conversation transcript, document, or session summary), makes **one LLM call per chunk**
(`model = claude-haiku-4-5`, reusing the existing consolidation/compaction LLM config — no
new model config path) to extract **atomic facts**, and writes each fact through the
**existing** `store → exact-dedup → deferred-consolidation` machinery. Each fact becomes its
own clean memory row with its own clean vector, which is the entire point: a compound blob
embeds to a muddy centroid and degrades recall, importance, and dedup granularity.

The normal `memory_store` write path stays **LLM-free**. `memory_ingest` is the only tool
that calls an LLM **directly** on the write side (extraction). Deferred consolidation also uses
the LLM, but **indirectly** via `batchJudgeMemoryRelations`/`parseBatchJudgments` — neither path
adds a new model config. Both `memory_store` and `memory_ingest` share the same `store`
insert/dedup pipeline, so we add exactly one new step (extraction) and reuse everything
downstream.

Because extraction is the **only** point in the pipeline that reads every individual fact before
it is written, it is also the only place where two insert-time fidelity decisions can be made:
**per-fact importance** (A2) and the **durability filter** that keeps stable preferences /
identity / project facts / decisions and drops ephemeral session-local task chatter (A4). These
are baked into extraction here rather than deferred, because nothing downstream ever sees the
facts pre-write.

---

## 2. Key design decisions

1. **`ingest` is a new method on the `MemoryEngine` interface, not a tool-handler-local
   function.** Tool handlers in this codebase receive **only** the `MemoryEngine`
   (`server.ts` → `handleStore(engine, args)`), never `MemoryConfig`. The `config` (which
   holds `llmModel`/`llmBaseUrl`/`llmApiKey` and is needed for the LLM call + embedding) is
   captured in the engine closure in `engine-impl.ts`. Extraction therefore belongs on the
   engine, parallel to `store`/`recall`. This preserves the existing handler signature
   convention and keeps the LLM/config dependency inside the one place that already owns it.
   *Rationale: handlers are config-free by construction; the engine closure is the only seam
   that already holds both `db` and `config`.*

2. **Reuse `llmComplete()` from `llm/client.js`** — the same OpenAI-compatible client used
   **directly** by `compaction.ts` and **indirectly** by `consolidation.ts` (which calls it via
   `batchJudgeMemoryRelations` → `parseBatchJudgments`). No new client, no new model field.
   `config.llmModel` already defaults to `claude-haiku-4-5-20251001`. *Rationale: §5/§8
   open-question 5 in the proposal is resolved in favor of "reuse the consolidation/compaction
   config" per the task brief.*

3. **Each extracted fact flows through the existing `store` path**, not a bespoke insert. The
   only change `store` needs is an **optional `createdAt`** on `StoreOptions` (for `as_of`
   backdating). We do **not** widen `store` to accept `string | string[]` for this feature —
   that batch affordance is a separate, deferrable proposal item and is not required for
   `memory_ingest`. *Rationale: minimal surface; one new optional field, contract preserved.*

4. **`as_of` is threaded as a `createdAt` insert parameter, not a post-insert UPDATE.**
   Stamping at insert time is atomic and avoids a second write + a window where the row carries
   a wrong timestamp. See §5.

5. **Graceful degradation is first-class — but now *controllable*.** No LLM configured →
   default behavior stores the blob as a **single** memory (truncated to `MAX_CONTENT_LENGTH`)
   and reports `degraded: true`, mirroring `consolidation`/`compaction` (which degrade when
   `getLLMClient()` returns null). **(A3)** A new `on_extraction_failure` option lets a caller
   override this: `'degrade'` (default, product behavior), `'skip'` (write nothing, report
   `skipped`), or `'error'` (throw, so a corpus driver can retry). Default preserves v1 product
   behavior exactly.

6. **Malformed model output never throws (by default).** Parsing follows the
   `parseBatchJudgments`-style defensive approach already in `llm/client.ts`: extract a JSON
   array, validate each item, drop junk. If parsing yields **zero** facts, the default
   (`on_extraction_failure='degrade'`) falls back to the single-blob store (same as the no-LLM
   path) so the tool never returns "ingested 0" silently on a parse failure. `'error'` mode
   surfaces the failure instead.

7. **(A2) Per-fact importance is assigned at extraction.** The extraction schema is an array of
   `{ fact, importance? }`, not bare strings. The extraction LLM already reads every fact, so
   emitting a per-fact salience in 0–1 is nearly free, and extraction is the **only** place per-
   fact importance can be set. When the model omits importance for a fact, it falls back to the
   call-level seed `importance` (default 0.5). *Rationale: this is the most important amendment —
   it is the only insert-time decision that recovers importance fidelity for a bulk corpus.*

8. **(A1) Merge timestamps are order-independent for backdated ingests.** Dedup is content-
   similarity, **not** time-aware, and a multi-year export may be ingested in any order. When a
   backdated (`as_of`) fact merges into an existing row, the surviving row's timestamps are
   reconciled with `min`/`max` (true first-seen / true last-touched), not left to whichever
   insert happened to land first. v1's "skip the existing row's `created_at` on merge" rule let
   ingest **order** decide the surviving timestamp, flattening recency precisely for the most-
   repeated (hence most-important) facts. Normal non-`as_of` stores are unchanged. See §5.4.

9. **(A3) Partial extraction is observable, never silent.** If any chunk of a multi-chunk call
   returns null/`[]`, the result reports `degraded: true` and a `failed_chunks` count. v1's
   silent "that chunk contributes nothing, the call still looks fully successful" path is a
   corpus-contamination hazard; v2 eliminates the silence.

10. **(A4) Extraction targets durable facts.** Both mode prompts instruct the model to keep
    facts worth remembering beyond the conversation (stable preferences, identity, project
    facts, decisions) and to skip ephemeral session-local state (transient errors, one-off
    debugging steps, "let's try X"). The two modes still differ only on the explicit-vs-inference
    axis; durability applies to both. See §4.2.

11. **(A6) PII-safe logging is a hard rule.** This tool handles sensitive content. We **never**
    log raw content/chunk/blob or the model's raw response to stderr or into error messages —
    only lengths, token estimates, chunk indices, and content-free failure shapes. See §4.4 and
    the testing section.

12. **(A7) Result stats are honest.** `IngestResult` reports `created` and `merged` separately
    (we already compute `action` per fact), so a bulk run's numbers are interpretable and the
    merge count — a corroboration signal — is visible. See §3.2.

---

## 3. Tool surface

### 3.1 Input schema (Zod, registered in `server.ts`)

```ts
server.tool(
  'memory_ingest',
  TOOL_DESCRIPTIONS.memory_ingest,
  {
    content: z
      .string()
      .describe('Raw blob to decompose: a conversation transcript, document, or session summary.'),
    source: z
      .string()
      .optional()
      .describe("Provenance, e.g. 'session:abc', 'document', 'conversation'. Stored on each fact."),
    mode: z
      .enum(['conversation', 'document'])
      .optional()
      .describe(
        "'conversation' (default): STRICT — only DURABLE facts explicitly stated, no inference. " +
          "'document': broader — DURABLE facts with reasonable inference allowed. " +
          'Both modes keep stable preferences/identity/project facts/decisions and skip ' +
          'ephemeral task chatter. Use document for conversation transcripts.',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe('Optional seed tags applied to EVERY extracted fact.'),
    importance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'SEED importance 0-1, used as the fallback when the extraction model does not emit a ' +
          'per-fact importance. Default: 0.5. Per-fact importance (when the model provides it) wins.',
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe('If true, run extraction and RETURN the facts WITHOUT writing anything. Default: false.'),
    on_extraction_failure: z
      .enum(['degrade', 'skip', 'error'])
      .optional()
      .describe(
        "How to handle a chunk/call that yields no facts (no LLM, LLM error, or unparseable). " +
          "'degrade' (default): store the blob as a single memory (product behavior). " +
          "'skip': write nothing, return { ingested: 0, skipped: true }. " +
          "'error': throw, so a bulk driver can retry. Default: 'degrade'.",
      ),
    as_of: z
      .union([z.number(), z.string()])
      .optional()
      .describe(
        'Backdate: stamp created_at/last_accessed_at of every extracted fact to this time ' +
          '(epoch ms or ISO 8601) instead of now. For ingesting historical exports.',
      ),
  },
  async (args) => {
    try {
      const text = await handleIngest(engine, args);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: formatError(err) }], isError: true };
    }
  },
);
```

This sits alongside the existing five tools under the same
`/* eslint-disable @typescript-eslint/no-deprecated */` block (the package still uses the
deprecated `server.tool()` API; match it — do not introduce `registerTool` for one tool).

`TOOL_DESCRIPTIONS.memory_ingest` is added to `prompts.ts` (one new entry; keep style
consistent), e.g.:

> "Ingest a raw blob (conversation, document, or session summary) and decompose it into atomic,
> DURABLE memories via an LLM (extracts stable preferences/identity/project facts/decisions; skips
> ephemeral task chatter). Unlike `memory_store` (one pre-formed fact), this extracts many facts
> from one input, each with its own importance. Use `mode='conversation'` for strict
> explicit-only extraction or `mode='document'` to allow reasonable inference (better for
> conversation transcripts); `dry_run=true` to preview the decomposition (note: dry_run still
> sends the blob to the configured LLM — it only skips local persistence). By default falls back
> to a single store if no LLM is configured; set `on_extraction_failure` to `skip` or `error` to
> change that."

### 3.2 Output shape

The MCP tool surface returns text (matching every other handler), but the handler builds it
from a structured result. The engine method returns the structured object; the handler
formats it.

```ts
// types.ts
export interface IngestResult {
  // ---- honest write stats (A7) ----
  created: number;         // rows newly created (action === 'created')
  merged: number;          // facts that hit an existing row (merged_duplicate / contradiction)
  ingested: number;        // ALIAS for `created`, kept for back-compat of the v1 field name
  memory_ids: string[];    // ids of all touched rows (created + merged); empty when dry_run

  // ---- substance ----
  facts: ExtractedFact[];  // the extracted atomic facts + their importance (always populated)

  // ---- diagnostics (A3) ----
  chunks?: number;         // number of LLM windows used (omitted when 1)
  failed_chunks?: number;  // chunks that returned null/[] (omitted when 0)
  degraded?: boolean;      // true when we fell back to single-blob store, OR a partial failure
  partial?: boolean;       // true when SOME (not all) chunks failed but others produced facts
  skipped?: boolean;       // true when on_extraction_failure='skip' wrote nothing
}
```

`ExtractedFact` is `{ fact: string; importance?: number }` (see §4) — `facts` carries the
per-fact importance so a `dry_run` preview shows the salience the model assigned, not just text.

**Stat semantics (A7).** We already compute `action` per fact in the write loop (§5.1), so
`created` and `merged` are free. `created` counts `action === 'created'`; `merged` counts
`merged_duplicate` **and** `contradiction_resolved`. `ingested` is retained as an alias of
`created` so v1 callers reading `ingested` still see the new-row count; new callers should read
`created`/`merged` to interpret a bulk run (a high `merged` is corroboration, not failure).

**Diagnostics (A3).** `failed_chunks` and `partial` make per-chunk failures visible instead of
silent. `degraded` is set when we fell back to a single-blob store **or** when any chunk failed
(`partial` distinguishes "some chunks failed but we still got facts" from "full degrade").
`skipped` is only set under `on_extraction_failure='skip'`.

`facts` is **always present** (it is the substance of a `dry_run` and cheap otherwise); all
diagnostics are optional. The handler renders, e.g.:

- normal: `Ingested 7 atomic facts: 6 new memories, 1 merged into existing (ids: a1b2…, …).`
- dry_run: a numbered list of the proposed facts with their importance, plus `Dry run — nothing written.`
- partial: `Ingested 4 facts (3 new, 1 merged); 1 of 3 chunks failed extraction — partial result.`
- degraded: `No LLM configured — stored the blob as a single memory <id>.`
- skipped: `Extraction failed and on_extraction_failure=skip — nothing written.`

### 3.3 Engine interface change

```ts
// engine.ts
export interface IngestOptions {
  source?: string;
  mode?: 'conversation' | 'document';
  tags?: string[];
  importance?: number; // SEED importance; per-fact importance from extraction overrides it
  dry_run?: boolean;
  as_of?: number; // normalized to epoch ms by the handler before reaching the engine
  on_extraction_failure?: 'degrade' | 'skip' | 'error'; // default 'degrade' (A3)
}

export interface MemoryEngine {
  store(content: string, opts: StoreOptions): Promise<StoreResult>;
  ingest(content: string, opts: IngestOptions): Promise<IngestResult>; // NEW
  recall(opts: RecallOptions): Promise<RecallResult>;
  // …unchanged…
}
```

`createMemoryEngine(modules)` (the test factory in `engine-impl.ts`) and `EngineModules`
gain the `ingest` passthrough, exactly like the other methods.

---

## 4. Extraction

### 4.1 LLM call

New module: `src/storage/extraction.ts` (sits next to `consolidation.ts`/`compaction.ts`,
which are the other LLM-on-write modules). It exports:

```ts
export interface ExtractedFact {
  fact: string;
  importance?: number; // 0–1, OPTIONAL; absent ⇒ caller falls back to the seed importance
}

export async function extractFacts(
  config: MemoryConfig,
  blob: string,
  mode: 'conversation' | 'document',
): Promise<ExtractedFact[] | null>; // null ⇒ no LLM or hard failure ⇒ caller handles per on_extraction_failure
```

`ExtractedFact` is the unit threaded everywhere downstream (it also appears in `IngestResult.facts`,
§3.2). The return type is `ExtractedFact[] | null`, **not** `string[] | null` (A2): each fact
carries its own optional importance.

Internals reuse `llmComplete(config, systemPrompt, userPrompt, { maxTokens })` — the same plain
chat-completions wrapper used (directly) by `compaction.ts` and (indirectly, via
`batchJudgeMemoryRelations`) by `consolidation.ts`. We do **not** add structured-output /
function-calling — the rest of the package parses JSON out of text content. Match that.
`maxTokens` scales with chunk size (e.g. `Math.min(1500, ~blob_tokens)`), bounded. The per-fact
`importance` field adds only a few tokens per element, so it does not meaningfully raise the
output budget.

### 4.2 Prompts (two mode variants)

Both share an envelope: input wrapped in `<input>` tags (so the model can't confuse
instructions with content), output **only** a JSON array of **objects** `{ "fact": "...",
"importance": 0.0-1.0 }`. The two modes differ **only** on the explicit-vs-inference axis; the
**durability filter (A4)** and the **per-fact importance instruction (A2)** apply to **both**.
There is no third mode.

**Shared rules (in both prompts):**

> - Output ONLY a JSON array of objects, each `{ "fact": "<self-contained fact>", "importance":
>   <0.0–1.0> }`. One atomic fact per element — never combine two facts with "and".
> - Each fact must be self-contained: resolve pronouns to names, include the subject
>   ("The user prefers dark mode", not "prefers dark mode").
> - **Extract only DURABLE facts** worth remembering beyond this conversation: stable
>   preferences, identity, project facts, decisions, learned constraints.
> - **SKIP ephemeral / session-local state**: transient errors, one-off debugging steps,
>   "let's try X", task chatter, pleasantries, meta-talk.
> - **`importance`** reflects how durable/identity-defining the fact is: durable identity,
>   standing preferences, and decisions → high (≈0.7–1.0); useful-but-replaceable project facts
>   → mid (≈0.4–0.7); marginal/ephemeral facts you still chose to keep → low (≈0.1–0.4). When
>   unsure, omit `importance` and the caller will use the seed default.
> - If nothing durable is stated, output `[]`. Reply with ONLY the JSON array, no prose.

**`conversation` (STRICT) — additional rule:**

> - Extract ONLY facts that are **explicitly stated**. Do NOT infer, summarize, or editorialize.

**`document` (BROADER) — additional rule:**

> - **Reasonable inference is allowed** where the text clearly implies a durable fact, but do
>   not fabricate. Prefer atomic facts; split compound statements.

The user prompt is `<input>\n{chunk}\n</input>`. Keep the two system prompts as named
constants in `extraction.ts` so the difference is one prompt, not branching code.

> **Driver note (A4).** For multi-turn conversation transcripts, the eval driver should pass
> `mode='document'`, not `'conversation'`. Durable facts in a transcript are frequently
> synthesized **across** turns (a preference stated once, then relied on later) rather than
> uttered as a single explicit sentence; STRICT explicit-only extraction loses them. `document`
> permits the cross-turn synthesis while the durability filter keeps the flood of task chatter
> out. (The driver chooses this per conversation; the tool does not hard-code it.)

### 4.3 Structured-output / parsing

The model returns text. Parse defensively, mirroring `parseBatchJudgments`, into
`ExtractedFact[]`:

```
export function parseExtractedFacts(raw: string): ExtractedFact[] {
  // 1. Find the first JSON array via /\[[\s\S]*\]/.
  // 2. JSON.parse; if not an array → return [].
  // 3. For each item, accept EITHER:
  //      - an object { fact: string, importance?: number }  → preferred (A2), OR
  //      - a bare string                                     → treat as { fact, importance: undefined }
  //    (tolerating the plain-string form keeps us robust to a model that ignored the schema).
  // 4. Drop junk: require a non-empty trimmed `fact`; cap `fact` length at MAX_CONTENT_LENGTH.
  //    If `importance` is present but not a finite number, drop it (→ undefined); otherwise
  //    CLAMP it to [0, 1].
  // 5. Cap count at MAX_FACTS_PER_INGEST (e.g. 200) to bound a runaway response.
  // 6. De-dupe exact-`fact`-string repeats within the batch (keep the first occurrence's importance).
  // catch → return [].
}
```

`parseExtractedFacts` is pure and exported → directly unit-testable with canned strings. **(A6)**
On a parse miss it must not echo `raw` — return `[]` and let the caller log a content-free shape
(e.g. `"no JSON array found in N-char response"`); see §4.4.

### 4.4 Retry / error handling (A3 + A6)

- `llmComplete` already swallows API errors and returns `null`. `extractFacts` treats `null` →
  returns `null`. **No new retry loop** — the package has no retry anywhere and a single Haiku
  call is cheap; adding retries would be inconsistent over-engineering. Retry, when wanted, is
  the **driver's** job via `on_extraction_failure='error'`.
- A malformed-but-non-null response → `parseExtractedFacts` returns `[]`. Both `null` and `[]`
  count as a **chunk failure** for diagnostics.
- **Per-chunk failures are tracked, not swallowed (A3).** The engine counts failed chunks. After
  all chunks run:
  - If **every** chunk failed (or no LLM) → the union is empty → apply `on_extraction_failure`:
    `'degrade'` → single-blob store (`degraded: true`); `'skip'` → write nothing
    (`skipped: true`, `ingested/created: 0`); `'error'` → throw.
  - If **some** chunks failed but others produced facts → ingest the facts we have, and set
    `partial: true`, `degraded: true`, `failed_chunks: <n>`. v1's silent partial path (the call
    "looked fully successful" while a chunk's facts were dropped) is gone — this is a
    corpus-contamination hazard the eval driver must be able to see and act on.
- **PII-safe logging/errors (A6, hard rule).** `extractFacts`, `parseExtractedFacts`, the engine
  loop, and `formatError`/the handler **must never** write raw content, a chunk, the blob, or the
  model's raw response to stderr or into a thrown/returned error message. Log only **content-free
  shapes**: blob/chunk **lengths**, token estimates, chunk **indices**, fact **counts**, and
  failure descriptors like `"no JSON array found in {raw.length}-char response"` or
  `"chunk 3/7 returned 0 facts"`. The `'error'`-mode exception message likewise carries counts
  and indices only, never substrings of the input or output.

---

## 5. Write path

### 5.1 Flow per ingest call (engine `ingest`)

1. Normalize seed `importance` (default 0.5), `mode` (default `'conversation'`),
   `on_extraction_failure` (default `'degrade'`), `as_of` → epoch ms.
2. Chunk the blob (§6, with overlap per §7). For each chunk, `extractFacts(config, chunk, mode)`.
   - Count `failedChunks` = chunks returning `null` **or** `[]` (A3). Track `totalChunks`.
3. Union the `ExtractedFact[]` across chunks (preserve order; drop exact-`fact`-string dups
   across chunks — the first occurrence keeps its `importance`).
4. **If the union is empty** (no LLM, all chunks failed) → apply `on_extraction_failure` (A3):
   - `'error'` → throw a content-free error (A6) so the driver can retry.
   - `'skip'` → return `{ created: 0, merged: 0, ingested: 0, memory_ids: [], facts: [],
     skipped: true }` (when `dry_run`, same but the lone preview "fact" may be omitted).
   - `'degrade'` (default) → **single-blob store**: `store(blobTruncatedToMax, { tags,
     importance: seedImportance, source, createdAt })` and return `{ created: 1, merged: 0,
     ingested: 1, memory_ids: [id], facts: [{ fact: blob…, importance: seedImportance }],
     degraded: true }`. (When `dry_run`, `created: 0`, no write, `degraded: true` — the preview
     shows there was no decomposition.)
5. **If `dry_run`** → return `{ created: 0, merged: 0, ingested: 0, memory_ids: [], facts }`
   **without writing** (carry `chunks`/`failed_chunks`/`partial` diagnostics through).
6. Otherwise, for **each** `ExtractedFact f`, call the **existing** `store(f.fact, { tags,
   importance: f.importance ?? seedImportance, source, createdAt })` (A2 — per-fact importance
   wins, seed is the fallback). Collect `result.id` into `memory_ids`. Tally by `result.action`:
   `created` += `action === 'created'`; `merged` += `merged_duplicate` **or**
   `contradiction_resolved` (A7). Set `ingested = created` (alias). Return `{ created, merged,
   ingested, memory_ids, facts, chunks, ...(failedChunks ? { failed_chunks: failedChunks,
   degraded: true, partial: true } : {}) }`.

`store` is called in a loop in-process; `better-sqlite3` is synchronous and each `store` is its
own transaction (as today). No batching transaction is added — keeps the change minimal and
each fact independently dedups. `maybeRunMaintenance` already fires inside `storeImmediate`
every `maintenanceInterval` stores, so a large ingest naturally triggers a consolidation pass;
no extra orchestration needed.

> **Bulk-driver note (out of scope for tool code).** For a reproducible eval corpus the driver
> may want a single, deterministic consolidation pass at the **end** of the bulk load instead of
> the `maintenanceInterval`-triggered passes interleaving mid-ingest. That is a driver concern:
> the driver can raise `maintenanceInterval` (via `MEMORY_*` config) during the bulk run and run
> one consolidation at the end. We deliberately add **no** tool code for this — `ingest` keeps
> the existing `maybeRunMaintenance` behavior.

### 5.2 `store` signature change — `createdAt`, not `string[]`

```ts
// engine.ts
export interface StoreOptions {
  tags?: string[];
  importance?: number;
  source?: string;     // NEW — ingest stamps provenance; insert path already supports `source`
  createdAt?: number;  // NEW — epoch ms; when set, stamp created_at/updated_at/last_accessed_at
}
```

- `source` is added because `insertMemory` **already** accepts `source` (`queries.ts`
  `InsertMemoryParams.source`) but `storeImmediate` never forwards it. Threading it is a
  one-line change and gives ingested facts real provenance.
- `createdAt` is the `as_of` mechanism (§5.4).
- **We do NOT add `content: string | string[]`.** The proposal lists it as a separate
  affordance; `memory_ingest` does not need it (it loops over facts itself), and widening the
  hot-path tool's input type is out of scope here.

**Contract preservation:** both new fields are optional. Existing callers of `store` and the
`memory_store` tool are unaffected. `StoreResult` is unchanged.

### 5.3 Dedup interaction — rely on what exists, add nothing

Extracted facts may duplicate existing memories or each other. We rely entirely on the existing
two-tier dedup:

- **Within the same ingest:** two near-identical facts → the second hits exact-dedup
  (`EXACT_DEDUP_DISTANCE`) in `storeImmediate` and is `merged_duplicate`, or lands in the
  consolidation band and is resolved on the next maintenance pass.
- **Against prior memories:** identical — `storeImmediate`'s `vectorSearch` + consolidation
  catch it.

No new dedup logic. We count `created` vs `merged` (`merged_duplicate` + `contradiction_resolved`)
so the result honestly reports both how many *new* rows landed and how many facts corroborated an
existing memory (A7).

**Per-fact importance on merge.** When a fact merges, the surviving row's importance is already
reconciled by the existing `updateMemoryContent` SQL (`importance = MAX(importance, ?)`), so a
high-importance corroborating fact correctly raises the survivor's importance and a low-importance
one never lowers it. No change needed — per-fact importance (A2) composes with the existing merge
rule for free.

### 5.4 `createdAt` / `as_of` mechanism in `store`

`storeImmediate`, `insertMemory`, and `updateMemoryContent` currently hard-code
`now = Date.now()`. The change has two parts — the **created** path (singleton backdate) and the
**merge** path (order-independent reconciliation, A1).

**Created path (singleton, unchanged intent from v1):**

- `insertMemory` gains an optional `createdAt` in `InsertMemoryParams`. When present, it is used
  for `created_at`, `updated_at`, **and** `last_accessed_at` (all three). When absent, behavior
  is byte-for-byte unchanged (`Date.now()`).
- `storeImmediate` forwards `opts.createdAt` into `insertMemory`.
- **Singleton `last_accessed_at = as_of` is intentional (documented decision).** A backdated fact
  that creates a *new* row is faithful to its source date in every column: a 2023 fact **is**
  cold, and stamping `last_accessed_at = as_of` lets recency/decay scoring treat it as old. We do
  **not** stamp `last_accessed_at = now` for created backdated rows.

**Merge path (A1 — REPLACES v1's "do not rewrite `created_at`" rule):**

v1 said: on merge, leave the existing row's `created_at` alone, backdate applies to new rows only.
That let ingest **order** decide the surviving timestamp — the merge target keeps whatever
timestamp the first-landed insert happened to give it, regardless of which fact is actually older.
For a multi-year export ingested in arbitrary order, this flattens recency precisely for the
most-repeated (most-important) facts. **New rule:** when a backdated fact merges into an existing
row, reconcile timestamps **order-independently**:

```
created_at        = min(existing.created_at,        incoming as_of)   // true first-seen
last_accessed_at  = max(existing.last_accessed_at,  incoming as_of)   // true last-touched
updated_at        = max(existing.updated_at,        incoming as_of)   // true last-touched
```

Implementation:

- The exact-dedup merge branch in `storeImmediate` calls `updateMemoryContent` (content/embedding/
  tags/importance) **and then**, only when `opts.createdAt` is set, a small new query
  `updateMemoryTimestampsOnMerge(db, namespace, id, asOf)` that runs:
  ```sql
  UPDATE memories
     SET created_at       = MIN(created_at, ?),
         last_accessed_at = MAX(last_accessed_at, ?),
         updated_at       = MAX(updated_at, ?)
   WHERE id = ? AND namespace = ?
  ```
  (Three `?`-bindings of `asOf`.) This is additive — `updateMemoryContent` is unchanged, so the
  consolidation-path caller of `updateMemoryContent` is unaffected. The min/max are computed in
  SQL so the merge is atomic and order-independent regardless of which insert wins the race.
- **Non-`as_of` merges are unchanged.** When `opts.createdAt` is absent, the new query is **not**
  called; `updateMemoryContent`'s existing `updated_at = now` behavior stands, byte-for-byte.

This is the only place v1 made an **order-dependent** timestamp decision; A1 removes it.

---

## 6. `as_of` backdating — schema impact

**None.** `created_at`, `updated_at`, `last_accessed_at` are existing `INTEGER` columns. We are
only choosing the value written — at insert (created path) and, for the A1 order-independent
merge, in the new `updateMemoryTimestampsOnMerge` UPDATE (§5.4). Both reuse the same three
existing columns. **No migration, no `SCHEMA_VERSION` bump.** (Contrast with the deferred title
feature, which *would* need a migration; we are not doing it.)

Handler-side normalization: `as_of` may be epoch ms (number) or ISO 8601 (string).
`validateIngestInput` resolves it to epoch ms via `Date.parse` for strings, rejects
non-finite/negative results with a clear error, and passes a `number` to the engine. The engine
never sees the string form (keeps the engine contract numeric and simple).

---

## 7. Chunking

Conversations can exceed the model context. Strategy:

- **Token estimate:** reuse `estimateTokens` from `retrieval/scoring.ts` (already exported, used
  by the budget packer) — no new estimator.
- **Threshold:** a `MAX_INGEST_CHUNK_TOKENS` constant (≈ 6000 tokens, comfortably inside
  Haiku's window with room for the prompt + output). If `estimateTokens(blob) <= threshold`,
  one chunk, one LLM call.
- **Splitting:** greedy line-oriented windows. Split on newlines (transcripts and documents are
  line-structured), accumulate lines until the next line would exceed the threshold, emit the
  window, continue. A single pathological line longer than the threshold is hard-split on
  whitespace as a fallback. This keeps speaker turns / paragraphs intact at window boundaries far
  more often than a blind character cut.
- **Window overlap (A5):** prepend the last **~10–15% of window N's lines** to the front of
  window N+1, so a fact whose supporting evidence straddles a window boundary is recoverable from
  at least one window (it appears whole in the overlap region of the next window). The overlap is
  bounded by line count, not characters, so it never pushes a window over the token threshold by
  more than a small constant. The duplicate facts this naturally produces in the overlap region
  are already collapsed by the union step's exact-`fact`-string drop (below), so overlap costs a
  little extra extraction work, not duplicate rows.
- **Residual lossiness (A5):** overlap recovers boundary-straddling evidence **between adjacent**
  windows only. Evidence spread across *non-adjacent* windows, or a single fact synthesized from
  more context than one window holds, is still not reconstructable from a single extraction call —
  that is inherent to per-window extraction and is left to the normal dedup/consolidation pipeline,
  not solved here. We document it rather than over-engineer a global pass.
- **Union semantics:** extract per window, concatenate the `ExtractedFact` lists in order, drop
  exact-`fact`-string duplicates across windows (first occurrence keeps its `importance`).
  Cross-window *semantic* duplicates are left to the normal dedup pipeline (§5.3) — we do not embed
  during extraction.
- **Bound:** cap total chunks (e.g. `MAX_INGEST_CHUNKS = 50`) and total facts
  (`MAX_FACTS_PER_INGEST`) to keep a hostile or enormous blob from fanning out unboundedly.

Chunking lives in `extraction.ts` (`chunkBlob(blob): string[]`, with the ~10–15% overlap of
A5 baked in) — pure, unit-testable.

---

## 8. `dry_run` control flow

`dry_run` short-circuits **after** extraction, **before** any write (§5.1 step 5). It runs the
full LLM extraction + chunking so the preview is faithful, then returns
`{ created: 0, merged: 0, ingested: 0, memory_ids: [], facts }` (where `facts` is
`ExtractedFact[]`, carrying the model's per-fact importance for inspection). No `store`, no
embedding, no dedup, no maintenance.

This is the safe-preview path for sensitive content: extraction reads the blob but nothing is
persisted to SQLite. (Note: the blob is still sent to the configured LLM endpoint — that is
inherent to extraction; `dry_run` controls *local persistence*, not whether the model sees the
text. Call this out in the tool description so a user previewing sensitive content understands
the model still receives it.) We deliberately **do not** add a separate no-egress / local-only
preview mode: the eval-corpus user has **consented** to Haiku egress, and a non-egressing preview
would not exercise the real extraction. The honest framing — `dry_run` egresses content to the
configured LLM but persists nothing locally — is the contract. (PII-safe *logging* per A6 is
orthogonal and always applies, including under `dry_run`.)

---

## 9. Degradation — no-LLM fallback

`getLLMClient(config)` returns `null` when neither `llmApiKey` nor `llmBaseUrl` is set. In that
case `extractFacts` returns `null` for every chunk and the union is empty. The behavior then
follows `on_extraction_failure` (§5.1 step 4):

- **`'degrade'` (default), `dry_run=false`:** stores the blob as a single memory
  (`store(blobTruncated, { tags, importance: seedImportance, source, createdAt })`) and returns
  `{ created: 1, merged: 0, ingested: 1, memory_ids: [id], facts: [{ fact: blob, importance:
  seedImportance }], degraded: true }`. The blob is truncated to `MAX_CONTENT_LENGTH` so the
  existing `store` content cap is respected.
- **`'degrade'`, `dry_run=true`:** returns `{ created: 0, merged: 0, ingested: 0, memory_ids: [],
  facts: [{ fact: blob }], degraded: true }` with no write.
- **`'skip'`:** writes nothing, returns `{ created: 0, merged: 0, ingested: 0, memory_ids: [],
  facts: [], skipped: true }`.
- **`'error'`:** throws a content-free error (A6).

With the default `'degrade'`, `memory_ingest` **never hard-fails** on a missing model — identical
philosophy to consolidation/compaction "skip when no LLM" degradation. `'skip'`/`'error'` are
opt-in for the corpus driver, which prefers a clean failure over a contaminating single-blob row.
The handler's rendered text states the outcome explicitly so the caller knows decomposition did
not happen.

---

## 10. Auto-save seam (note only — no change now)

Proposal §5 wants `src/memory/auto-save.ts` (in the **IronCurtain runtime**, not this package)
to eventually route session summaries through `ingest` instead of asking the agent to call
`memory_store` once. That module builds a prompt instructing the agent to call `memory_store`;
switching it to instruct `memory_ingest` (docker name) / `memory.ingest` (in-process) is a
**one-line `toolName` change in `buildAutoSavePrompt`** plus the prompt body asking for a raw
summary rather than a pre-condensed one. **We do not change it in this work** — we only note the
seam. The MCP tool must exist and be registered first; the runtime switch is a follow-up so it
can be tested end-to-end against the daemon.

---

## 11. Testing strategy

Follow the existing harness exactly. Two layers:

### 11.1 Pure-function unit tests (no DB, no LLM)
File: `test/extraction.test.ts`. Mirrors `parseBatchJudgments` coverage in
`test/llm-client.test.ts` style.
- `parseExtractedFacts`: valid array of objects → `ExtractedFact[]` with trimmed `fact` and
  preserved `importance`; **bare-string items tolerated** → `{ fact, importance: undefined }`
  (A2); non-array JSON → `[]`; prose-wrapped array → extracted; empty/junk → `[]`; over-long
  `fact` truncated; count capped; intra-batch exact-`fact` dups dropped (first keeps importance).
- **Per-fact importance parsing (A2):** `importance` out of `[0,1]` → **clamped**; non-finite /
  non-number `importance` → **dropped to undefined**; missing `importance` → undefined (caller
  falls back to seed).
- **PII-safe parse (A6):** `parseExtractedFacts` on a non-JSON response containing a known
  sensitive substring returns `[]` and the function/caller log does not contain that substring —
  only a content-free shape (`"no JSON array found in N-char response"`).
- `chunkBlob`: short blob → 1 chunk; long blob → N chunks split on newlines; **adjacent chunks
  overlap by ~10–15% of lines (A5)** — assert the tail lines of chunk N reappear at the head of
  chunk N+1; pathological long line → hard-split; chunk count bounded.

### 11.2 Engine `ingest` tests (real in-memory SQLite, mocked LLM)
File: `test/ingest.test.ts`. Use the `mkdtempSync` + `initDatabase(TEST_MODEL)` pattern from
`test/database.test.ts`. Two mocking choices, pick per the package's existing seams:
- **Mock the LLM** by `vi.mock('../src/llm/client.js', …)` so `llmComplete` returns a canned
  JSON array of `{ fact, importance }` objects (and `getLLMClient` returns a truthy stub) — lets
  the *real* `store`/dedup/insert run. This is the highest-value path: it proves decomposition →
  N rows end to end.
- The **embedder** loads a real (small) model in these tests as it does in `database.test.ts`;
  if model-load time is a concern, follow `maintenance.test.ts`'s approach. (The package already
  tolerates real embedding in unit tests with the 30s timeout.)

Assertions:
- **Decomposition → N rows:** mock returns 3 facts → `getNamespaceStats().total_memories === 3`,
  result `created === 3`, `ingested === 3` (alias), `merged === 0`, `memory_ids.length === 3`,
  three distinct contents.
- **Per-fact importance (A2):** mock returns facts with explicit `importance` (e.g. 0.9 / 0.2)
  and one with importance **omitted** → assert each written row's `importance` equals the model's
  value, and the omitted one equals the **seed** `importance` passed to the call (default 0.5).
- **`dry_run` writes nothing:** same mock, `dry_run: true` → `total_memories === 0`,
  `created === 0`, `facts.length === 3`, and `facts[i].importance` carries the model's value.
- **`as_of` stamps dates (created path):** `as_of` = a fixed past epoch (and an ISO string
  variant) → every newly-created row's `created_at`/`updated_at`/`last_accessed_at` equals it
  (including `last_accessed_at = as_of`, the documented singleton decision); assert via
  `getMemoriesByIds`. Also assert that omitting `as_of` yields `created_at ≈ Date.now()`.
- **Order-independent merge timestamps (A1):** store a fact at `as_of = T_old`, then ingest a
  duplicate fact (same content → exact-dedup merge) at `as_of = T_new > T_old`; assert the
  surviving row has `created_at === T_old` (`min`), `last_accessed_at === T_new` and
  `updated_at === T_new` (`max`). Then run the **reverse order** (ingest `T_new` first, merge
  `T_old` second) and assert the **same** surviving timestamps — proving order-independence.
  Also assert a non-`as_of` merge leaves `created_at` untouched and only bumps `updated_at`
  (the new query is not called).
- **Merge importance composes (A1/A2):** merging a higher-importance duplicate raises the
  survivor's importance (existing `MAX(importance, ?)`), a lower one does not lower it.
- **Honest stats (A7):** a call where 1 of 3 facts duplicates an existing row → `created === 2`,
  `merged === 1`, `ingested === 2`, `memory_ids.length === 3`.
- **Degradation, default (`'degrade'`, no LLM):** config with `llmApiKey: null, llmBaseUrl: null`
  (the `configWithoutLLM()` helper from `llm-client.test.ts`) → one row, content === blob
  (truncated), `created === 1`, `degraded === true`.
- **`on_extraction_failure='skip'` (A3):** no/failed LLM + `skip` → `total_memories === 0`,
  `created === 0`, `skipped === true`, no throw.
- **`on_extraction_failure='error'` (A3):** no/failed LLM + `error` → `ingest` **rejects**; assert
  it throws and that the **error message contains no input substring** (A6).
- **Malformed response (default degrade):** mock `llmComplete` → `'not json at all'` → union
  empty → degraded single-blob store (not a throw); `degraded === true`, one row.
- **Partial extraction is observable (A3):** multi-chunk blob where the mock returns facts for
  chunk 1 and `null` (or non-JSON) for chunk 2 → facts from chunk 1 are ingested AND
  `partial === true`, `degraded === true`, `failed_chunks === 1`, `chunks === 2`.
- **PII-safe on failure (A6):** spy on `console.error`/stderr; trigger a parse failure and an
  LLM-error with a blob containing a known sensitive marker → assert **neither** stderr **nor**
  the returned/thrown text contains that marker (only content-free shapes).
- **Seed tags / source propagate** to every written fact; durability/importance come from the
  model (per above), seed `importance` is the fallback only.
- **Chunking integration (with overlap, A5):** a blob over the token threshold with a mock that
  returns distinct facts per call → assert `llmComplete` called >1 time and facts unioned,
  `chunks > 1`; a fact placed on the boundary line is recovered (appears once after the
  exact-`fact` union dedups the overlap duplicate).

### 11.3 Tool/registration tests
File: extend `test/server.test.ts` and add `test/ingest-tool.test.ts` (mirrors `tools.test.ts`):
- `listTools` now returns **6** tools including `memory_ingest` (update the existing
  `lists all 5 memory tools` assertion in `test/server.test.ts` to 6 — note this is an
  intentional, expected test change).
- Schema has `content` required; `mode`/`dry_run`/`as_of`/`on_extraction_failure`/`tags`/
  `importance`/`source` optional.
- `validateIngestInput`: rejects empty content; rejects bad `as_of` (non-numeric string,
  negative); normalizes ISO `as_of` → epoch ms; defaults `mode` to `'conversation'`; defaults
  `on_extraction_failure` to `'degrade'`; rejects an `on_extraction_failure` outside the enum.
- Handler routes to `engine.ingest` with a mock engine (à la `server.test.ts`
  `createMockEngine`, extended with an `ingest` mock) and renders the expected text for the
  normal / dry_run / **partial** / degraded / **skipped** results — including that the normal
  render reports `created` and `merged` separately (A7).

---

## 12. Migration / back-compat

- **DB schema:** **no change, no `SCHEMA_VERSION` bump.** `as_of` reuses existing timestamp
  columns; facts are ordinary rows.
- **`store` public contract:** **preserved.** `StoreOptions` gains two *optional* fields
  (`source`, `createdAt`); `store(content, opts)` and `memory_store` behavior is identical when
  they are absent. `StoreResult` unchanged.
- **`MemoryEngine` interface:** gains one method (`ingest`). All implementers in this package
  (`createMemoryEngineFromConfig`, `createMemoryEngine`/`EngineModules`) and every test mock
  engine must add it — this is a compile-time-enforced, mechanical addition. (The `server.test.ts`
  / `tools.test.ts` `createMockEngine` helpers get an `ingest: vi.fn()…`.)
- **Published API:** additive. External MCP clients gain a new tool; nothing they used changes.

---

## 13. Explicit non-goals

- **Auto-inferred tags (Question 1):** not designed here. Seed `tags` are applied verbatim to
  every fact; no inference, no vocabulary convergence.
- **Inferred titles (Question 2):** not designed here. No `title` column, no migration.
- **`store` accepting `content: string | string[]`:** out of scope; a separate proposal item.
- **Routing `auto-save.ts` through ingest:** noted as a seam (§10); not changed in this work.
- **The historical-export / eval-corpus driver is a SEPARATE script**, not part of this tool.
  `memory_ingest` provides the **insert-time** primitives the driver needs — per-fact importance
  (A2), order-independent merge timestamps (A1), `on_extraction_failure` (A3), durability prompts
  (A4), overlap (A5), PII-safe logging (A6), honest stats (A7), plus `as_of`/`dry_run`. The driver
  keeps the **per-run policy** decisions that are genuinely its own and that this tool deliberately
  does **not** absorb:
  - Choosing `mode` / `as_of` / `on_extraction_failure` **per conversation** (e.g. `document` for
    transcripts, real conversation date as `as_of`, `error` to force a retry).
  - Controlling **maintenance cadence** for a reproducible corpus — e.g. raising
    `maintenanceInterval` during the bulk load and running one consolidation at the end. The tool
    keeps the existing `maybeRunMaintenance` behavior and adds **no** code for this (noted in §5.1).
  - Choosing **Haiku-vs-local** extraction model via the existing `MEMORY_LLM_*` config; the tool
    reuses whatever is configured and adds no model path.
  The driver (reading a multi-year export, chunking by source conversation) lives outside the
  server package and is not designed here.
- **No third extraction mode (A4):** modes stay `conversation` / `document` on the explicit-vs-
  inference axis; the durability filter is added to **both**, not as a separate mode.
- **No no-egress / local-only preview mode:** the eval-corpus user has consented to Haiku egress;
  `dry_run` previews without local persistence but still egresses content to the configured LLM
  (§8). PII-safe *logging* (A6) is the orthogonal protection that always applies.
- **No retry loop / no structured-output API:** intentionally consistent with the package's
  existing single-call, parse-defensively LLM idiom. Retry is the driver's job via
  `on_extraction_failure='error'`.
- **No `SCHEMA_VERSION` bump:** timestamps (created path **and** the A1 merge reconciliation)
  reuse existing `INTEGER` columns; no migration.

---

## 14. File-change summary

| File | Change |
|---|---|
| `src/engine.ts` | Add `IngestOptions` (incl. `on_extraction_failure?`, A3), `ingest()` to `MemoryEngine`; add `source?`/`createdAt?` to `StoreOptions`. |
| `src/types.ts` | Add `IngestResult` with `created`/`merged`/`ingested` (alias) + `failed_chunks`/`degraded`/`partial`/`skipped` diagnostics (A7/A3). |
| `src/storage/extraction.ts` | **New.** `ExtractedFact` type (A2); `extractFacts` (returns `ExtractedFact[]\|null`), `parseExtractedFacts` (object-form + clamp + bare-string tolerance, A2; PII-safe failure shapes, A6), `chunkBlob` (with ~10–15% overlap, A5), two durability-filtered + importance-instructed mode prompts (A4/A2), constants. |
| `src/storage/queries.ts` | `InsertMemoryParams.createdAt?`; `insertMemory` uses it (else `Date.now()`). **New** `updateMemoryTimestampsOnMerge(db, ns, id, asOf)` doing `created_at=MIN(.,?)`, `last_accessed_at=MAX(.,?)`, `updated_at=MAX(.,?)` (A1). `updateMemoryContent` unchanged. |
| `src/engine-impl.ts` | `storeImmediate` forwards `source`/`createdAt` and, on an `as_of` exact-dedup merge, calls `updateMemoryTimestampsOnMerge` (A1); add `ingest` impl (per-fact importance threading A2, `on_extraction_failure` branching + partial-failure tracking A3, honest `created`/`merged` tally A7, PII-safe logging A6); add `ingest` to `EngineModules` + `createMemoryEngine`. |
| `src/tools/ingest.ts` | **New.** `validateIngestInput` (validate/normalize `on_extraction_failure`, default `'degrade'`), `handleIngest`, `formatIngestResult` (render normal/dry_run/partial/degraded/skipped, A7/A3; content-free, A6), `as_of` normalization. |
| `src/tools/validation.ts` | (Optional) `MAX_FACTS_PER_INGEST`, chunk/token/overlap constants if shared. |
| `src/server.ts` | Register `memory_ingest` (in the existing eslint-disable block); schema gains `on_extraction_failure`. |
| `src/prompts.ts` | Add `TOOL_DESCRIPTIONS.memory_ingest`. |
| `test/extraction.test.ts`, `test/ingest.test.ts`, `test/ingest-tool.test.ts` | **New.** Cover per-fact importance (A2), order-independent merge (A1), failure modes (A3), overlap (A5), PII leak (A6), honest stats (A7). |
| `test/server.test.ts` | Update tool-count assertion 5 → 6; add `ingest` to mock engine. |
| `test/tools.test.ts` | Add `ingest` to `createMockEngine`. |
