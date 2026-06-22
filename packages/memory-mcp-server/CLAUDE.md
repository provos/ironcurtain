# CLAUDE.md — memory-mcp-server

Persistent memory MCP server (7 tools) with semantic search, LLM summarization, automatic compaction, atomic-fact ingestion (`memory_ingest`), and parent-context retrieval (`memory_expand` / recall expansion).

## Commands

- `npm run build` — TypeScript compilation to `dist/`
- `npm test` — unit tests (Vitest)
- `npm run test:e2e` — end-to-end integration tests (spawns real server, needs `.env`)
- `npm run benchmark` — run LoCoMo retrieval benchmarks (verbose)
- `npm run benchmark:json` — benchmark with JSON output
- `npm start` — start the MCP server (stdio transport)

Single test file: `npx vitest run test/scoring.test.ts`
Single test by name: `npx vitest run -t "merges results"`

## Architecture

```
src/
├── index.ts              Entry point (stdio transport, config, shutdown)
├── engine.ts             MemoryEngine interface (public API surface)
├── engine-impl.ts        Wires storage, retrieval, embedding, LLM subsystems
├── server.ts             MCP tool registration (7 tools)
├── config.ts             Env-based configuration (all MEMORY_* vars)
├── types.ts              Shared types (Memory, StoreResult, IngestResult, RecallResult, ExpandResult, ExpandMode, etc.)
├── prompts.ts            Exportable system prompts and tool descriptions
├── storage/
│   ├── database.ts       SQLite schema (SCHEMA_VERSION 4): memories (+ segment_id FK), segments (off-index source chunks), vec_memories (768-dim), memories_fts (FTS5). Stale-DB drop-and-recreate.
│   ├── queries.ts        Data access: insert, search (vector + FTS), delete, stats; segment helpers (insertSegment, getSegmentsByIds, updateMemorySegmentIfRicher)
│   ├── extraction.ts     LLM atomic-fact extraction (chunkBlob, extractFacts) + splitToPassages for expansion
│   ├── constants.ts      Embedding dimensions, dedup thresholds
│   ├── maintenance.ts    Three-phase: consolidation → decay → compaction
│   ├── compaction.ts     LLM-driven clustering + summarization of old memories
│   └── consolidation.ts  Deferred batch dedup/contradiction detection at store time
├── retrieval/
│   ├── pipeline.ts       Full recall flow (steps below)
│   ├── scoring.ts        Score-based hybrid fusion, composite scoring, relevance filter, reranker filter, budget packing
│   ├── expansion.ts      Post-dedup parent re-expansion (NOT the ranker): group kept facts by segment, split-and-rank source passages, hybrid budget pack. Shared by recall (limit 1/segment) and memory_expand.
│   ├── reranker.ts       Cross-encoder re-ranking (ms-marco-MiniLM, raw logits)
│   ├── dedup.ts          Embedding-based deduplication
│   └── formatting.ts     Output: summary (LLM), list (bullets), raw (JSON)
├── embedding/
│   └── embedder.ts       BGE model with asymmetric query prefixes, lazy singleton
├── llm/
│   └── client.ts         OpenAI-compatible client, judgment helpers (single + batch)
├── tools/
│   ├── store.ts          memory_store — persist one pre-formed fact with tags, importance
│   ├── ingest.ts         memory_ingest — LLM-decompose a raw blob into many atomic facts (mode, dry_run, as_of, on_extraction_failure)
│   ├── recall.ts         memory_recall — semantic query with token budget, expand mode, structured output
│   ├── expand.ts         memory_expand — fetch a source segment's query-ranked passages by segment_id
│   ├── context.ts        memory_context — session briefing
│   ├── forget.ts         memory_forget — bulk delete with dry_run/confirm
│   ├── inspect.ts        memory_inspect — stats, recent, tags, export
│   └── validation.ts     Input validation (content 10K, query 2K, budget 50K)
└── utils/
    ├── tags.ts           JSON tag parsing
    └── clustering.ts     Single-linkage clustering by embedding similarity
```

## Retrieval Pipeline (`retrieval/pipeline.ts`)

1. **Embed query** — BGE asymmetric prefix for retrieval-optimized embedding
2. **Hybrid search** — Vector KNN (50 candidates, distance < 0.9) + FTS5 (50 keywords)
3. **Score-based fusion** — Weaviate-style relativeScoreFusion: min-max normalize vector similarity and BM25 scores, blend with alpha weighting (default 0.5)
4. **Tag filter** — Optional intersection filter
5. **Composite scoring** — Weighted: fusion relevance (0.65) + recency (0.15) + importance (0.1) + access (0.1). Fusion score already incorporates vector + BM25 magnitudes
6. **Relevance gating** — Drop fusion score < 5% of max
7. **Cross-encoder re-ranking** — ms-marco-MiniLM-L-6-v2 via `AutoModelForSequenceClassification` (raw logits, NOT pipeline API which squashes to 1.0). Try/catch falls back gracefully
8. **Re-ranker filter** — Relative gap (12 logit points from best), min 5 results
9. **Dedup** — Embedding cosine similarity
   9b. **Parent re-expansion** (`retrieval/expansion.ts`, `expand:'auto'|'parent'` only) — POST-dedup, NOT part of the candidate ranker. Group kept facts by `segment_id`, fetch each shared segment by primary key (off-index), split-and-rank its passages against the step-1 query embedding, then hybrid-pack: reserve budget so the single top source passage is guaranteed (top facts never evicted), supplementary passages ride leftover budget up to `max_expand_passages`. `expand:'none'` is a byte-for-byte facts-only pack. Never touches the candidate set, fusion/composite/rerank scores, or selection order.
10. **Token budget packing** — Greedy skip (not break), then format (folded into step 9b for the expansion modes; plain `packToBudget` for `expand:'none'`)

## Key Design Decisions

- **Hybrid search over vector-only**: FTS keyword matches are most valuable precisely when vector search is uncertain. Always include both — score-based fusion handles the merge.
- **Score-based fusion over rank-based (RRF)**: Pure RRF discards score magnitudes and compresses into a tiny range (~0.009-0.033), making relevance filtering ineffective. Weaviate-style relativeScoreFusion preserves normalized score magnitudes in [0,1], giving the relevance gate real discriminating power.
- **Relative reranker threshold**: ms-marco is trained on web search, so conversational content often gets negative logits even when relevant. Absolute threshold=0 cuts too aggressively. Use gap-from-best instead.
- **Raw logits, not pipeline API**: The HuggingFace `pipeline('text-classification', ...)` applies softmax on single-output cross-encoders, squashing scores to always 1.0. Must use `AutoModelForSequenceClassification` directly.
- **Promise-cached model loading**: Both embedder and reranker cache the loading promise (not the resolved value) to prevent concurrent `recall()` calls from racing and loading the model twice.
- **Graceful LLM degradation**: System works without LLM — formatting falls back to list mode, consolidation/compaction are skipped.

## Storage

- **SQLite** with `better-sqlite3` (synchronous API, transactions)
- **sqlite-vec** extension for vector nearest-neighbor search (768-dim, cosine distance)
- **FTS5** for keyword search with BM25 ranking
- **`segments` table** — source chunks `memory_ingest` decomposes facts from. OFF the retrieval index by construction: never embedded, never in `vec_memories`/`memories_fts`; fetched only by primary key during recall-time parent expansion ("index fine, return coarse"). Each ingested fact's `segment_id` is a FK to `segments`; `memory_store` rows keep `segment_id = NULL`. Segment helpers in `queries.ts`: `insertSegment` (one row per ingest chunk that produced ≥1 fact), `getSegmentsByIds` (batch primary-key fetch for expansion), `updateMemorySegmentIfRicher` (on an ingest merge, repoint the survivor to the parent with the higher `fact_count`).
- **`SCHEMA_VERSION = '4'`** (`storage/database.ts`). The DB self-heals a stale on-disk schema on open via a NUMERIC version compare: an OLDER stamp is **dropped and recreated** (rebuild, not migrate — old data is deliberately discarded under the back-compat-free directive); a NEWER stamp **throws / fails closed** so an older binary never destroys a DB it can't understand; an unparseable stamp is treated as stale and rebuilt. This is a breaking 0.2.0 change (0.1.x DBs are wiped on first open).
- **Maintenance pipeline**: consolidation (batch LLM dedup), decay (vitality sampling), compaction (cluster + summarize)
- Dedup at store: cosine distance < 0.05 merged immediately; distance < 0.3 deferred to consolidation with LLM judgment

## Configuration

All config via environment variables (prefix `MEMORY_`):

- `MEMORY_NAMESPACE` — isolation namespace (default: `default`)
- `MEMORY_DB_PATH` — SQLite database path
- `MEMORY_EMBEDDING_MODEL` — HuggingFace model (default: `Xenova/bge-base-en-v1.5`)
- `MEMORY_RERANKER_ENABLED` — cross-encoder toggle (default: `true`)
- `MEMORY_RERANKER_MODEL` — reranker model (default: `Xenova/ms-marco-MiniLM-L-6-v2`)
- `MEMORY_LLM_MODEL`, `MEMORY_LLM_BASE_URL`, `MEMORY_LLM_API_KEY` — LLM for summarization
- `MEMORY_DEFAULT_TOKEN_BUDGET` — default recall budget (default: 800)

## Testing

- **Unit tests**: Vitest, in-memory SQLite, mocked LLM/embedder where needed
- **E2E tests**: Spawn real server via `StdioClientTransport`, exercise full MCP protocol
- **Timeout**: 30s (E2E tests need model loading time)
- **Temp dirs**: `/tmp/memory-test-*` created/cleaned per test
- **Test helpers**: `makeMemory()`, `makeScored()`, `randomEmbedding()` — defined in each test file

## Benchmark

LoCoMo benchmark (`benchmark/`) evaluates retrieval quality:

- Ingests multi-session conversations, asks factual questions, measures evidence recall/precision
- Run: `cd benchmark && uv run locomo run --conversation-limit 1 --question-limit 20 --reader-provider anthropic`
- Results in `benchmark/results/<timestamp>/`
- Key metrics: evidence recall (are relevant memories retrieved?), evidence precision (what fraction of retrieved memories are relevant?)
