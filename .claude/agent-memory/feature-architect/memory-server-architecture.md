---
name: memory-server-architecture
description: memory-mcp-server (packages/memory-mcp-server) layering — where LLM/config lives, the write path, and how to add an LLM-on-write tool
metadata:
  type: project
---

# memory-mcp-server architecture (packages/memory-mcp-server)

Key structural facts for designing features in this standalone published MCP server.

**Config injection constraint (load-bearing).** Tool handlers receive ONLY the
`MemoryEngine` (e.g. `handleStore(engine, args)` in `server.ts`), NEVER `MemoryConfig`.
`MemoryConfig` (holds `llmModel`/`llmBaseUrl`/`llmApiKey`, embedding model) is captured in
the engine closure built by `createMemoryEngineFromConfig` in `engine-impl.ts`. So any new
**LLM-on-write** feature must be a new **method on the `MemoryEngine` interface** (parallel to
`store`/`recall`), not a handler-local function — the engine closure is the only seam holding
both `db` and `config`. Adding a method forces updates to `createMemoryEngine`/`EngineModules`
and every test mock engine (`server.test.ts`/`tools.test.ts` `createMockEngine`).

**Write path.** `storeImmediate` (engine-impl.ts): embed → exact-dedup (cosine <
`EXACT_DEDUP_DISTANCE`, merge) → `insertMemory` as `consolidated:false` → `maybeRunMaintenance`
(fires every `maintenanceInterval` stores). The synchronous write path is deliberately
LLM-FREE. Heavy dedup/contradiction is deferred to `runConsolidation` (batched LLM, degrades to
"mark all distinct" when no LLM). `insertMemory` (queries.ts) already accepts `source` +
`metadata` but `storeImmediate` does NOT forward `source` today. `created_at`/`updated_at`/
`last_accessed_at` are hard-coded `Date.now()` at insert — backdating = add optional `createdAt`
to `InsertMemoryParams` (no schema change; they're existing INTEGER cols).

**LLM idiom.** ONE reused client: `llmComplete(config, systemPrompt, userPrompt, {maxTokens})`
in `llm/client.js` (OpenAI-compatible chat-completions, `temperature:0`). Used by
`consolidation.ts` + `compaction.ts`. `config.llmModel` defaults to `claude-haiku-4-5-20251001`.
`getLLMClient` returns null when no key/url → graceful degradation everywhere. NO structured-
output/function-calling — everything parses JSON out of text content defensively
(`parseBatchJudgments` is the canonical pattern: regex-extract `/\[[\s\S]*\]/`, validate items,
drop junk, never throw). NO retry loops anywhere. Match these idioms; don't introduce a new
model config path.

**Schema (storage/database.ts).** `SCHEMA_VERSION='3'`, 768-dim. SQLite + sqlite-vec
(`vec_memories`) + FTS5 (`memories_fts`, kept in sync by triggers). Bump version only for real
column changes (e.g. a `title` column would need a migration; timestamp backdating does not).

**Test harness.** Unit: vitest, `mkdtempSync(tmpdir(),'memory-test-')` + `initDatabase(path,
TEST_MODEL)`, real (small) embedder tolerated under 30s timeout, `vi.mock('../src/llm/...')` to
stub the LLM while real store/dedup runs. `configWithoutLLM()` helper (llm-client.test.ts) for
degradation tests. Pure parsers (parseBatchJudgments-style) tested with canned strings, no DB.
Tool/registration tests use `InMemoryTransport` + a `createMockEngine` (server.test.ts).

**`server.tool()` is deprecated** but the whole file uses it under an eslint-disable block —
match it for new tools; do NOT migrate to `registerTool` piecemeal.

Design produced: `docs/designs/memory-ingest-tool.md` (the `memory_ingest` decomposition tool,
Question 3 of `docs/brainstorm/memory-inferred-metadata-proposal.md`). auto-save seam that the
proposal §5 wants routed through ingest lives in the IronCurtain runtime at
`src/memory/auto-save.ts` (NOT this package) — `buildAutoSavePrompt` hard-codes the
`memory_store`/`memory.store` tool name.

**memory-parent-context-retrieval doc is now v3 (back-compat-free simplification).** Directive: NO
backwards-compat; must work out of the box. Two storage simplifications vs v2: (1) migration runner
DELETED — `segments` table + inline `memories.segment_id` are now part of canonical `createSchema`
(`CREATE TABLE IF NOT EXISTS`, NO `ALTER TABLE`/`runMigrations`/`table_info`); `SCHEMA_VERSION '3'→'4'`
is a plain stamp, but `initDatabase` READS the on-disk stamp and DROPS-AND-RECREATES the schema when
older (stale-DB self-heal; deliberately discards old data; corpus regen via build-corpus.ts). Chose
drop-and-recreate over "delete DB by hand" because only the former is out-of-the-box-correct (avoids
`no such column: segment_id` crash). (2) default recall budget BUMPED 500→800 (`config.ts:70` literal
`envInt(...,'MEMORY_DEFAULT_TOKEN_BUDGET',500)`; `recall` falls back to `config.defaultTokenBudget`
engine-impl.ts:457) so passage+couple-facts fit zero-config; `memory_context` already 800
(`CONTEXT_DEFAULT_BUDGET` engine-impl.ts:270) — now equal. "Back-compat"/"pre-migration" framing
dropped; NULL-`segment_id` (store/degrade rows) reframed as a normal CURRENT case (§4.3), still
self-parent on expand. RESOLVED CONFLICT: diagnostic must now pin `expand:'none'` AND explicit
`token_budget` (both defaults changed) to keep its ranker verdict comparable. v2 facts below still hold:
`memory_context`/`buildContext` (`:279`) wired to `'auto'`. Merge repoints survivor to RICHER parent
(higher `fact_count`, order-independent — new `updateMemorySegmentIfRicher` query). Metadata
(`expanded`+`expanded_segment_ids`) in ALL formats + new `memory_expand(segment_id)` tool + engine
method. Budget simplified: dropped `expand_budget_fraction` → `max_expand_passages` cap, reuse
`packToBudget`. CODE FACTS verified: `memories_ai` trigger populates ONLY `memories_fts`;
`vec_memories` insert is EXPLICIT in `insertMemory` (`queries.ts:48-51`); `MAX_INGEST_CHUNK_TOKENS=
6000` (`extraction.ts:28`); dedup `pipeline.ts:114`→pack `:117`→format `:125`. KEY RESOLVED CONFLICT:
passage ranking is POST-retrieval return-shaping (which slice of a winner's PARENT to show), NOT a
candidate-ranker change (steps 1–9 byte-for-byte); the corpus diagnostic must pass `expand:'none'`
to keep grading the ranker, not the return shape.

**memory-ingest doc is now v2 (review-amended).** The tool is dual-purpose: product feature +
substrate for a multi-year claude.ai-export eval corpus. v2 moved INSERT-TIME fidelity decisions
INTO the tool (the driver can't make them — it never sees facts pre-write): per-fact importance
from extraction (schema is `{fact, importance?}[]`, not `string[]`; seed importance is fallback);
order-independent merge timestamps for `as_of` (created_at=min, last_accessed_at/updated_at=max —
v1 let ingest ORDER decide); `on_extraction_failure: 'degrade'|'skip'|'error'`; durability-filter
prompts on BOTH modes (no 3rd mode); ~10–15% chunk overlap; PII-safe logging (never echo
content/raw response); honest `created`/`merged` stats. KEY CODE TOUCH-POINT for the A1 merge:
the exact-dedup branch in `storeImmediate` calls `updateMemoryContent` (only bumps `updated_at`),
so order-independent merge needs a NEW `updateMemoryTimestampsOnMerge` query (min/max in SQL);
`updateMemoryContent` already does `importance=MAX(importance,?)` so per-fact importance composes
on merge for free. The eval DRIVER stays out of scope (chooses mode/as_of/failure-mode per
conversation, maintenance cadence, Haiku-vs-local). User CONSENTED to Haiku egress → no no-egress
preview mode; `dry_run` still egresses. No SCHEMA_VERSION bump (timestamps reuse INTEGER cols).
