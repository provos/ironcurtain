# CLAUDE.md — memory-mcp-server

Persistent memory MCP server with semantic search, LLM summarization, and automatic compaction.

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
├── server.ts             MCP tool registration
├── config.ts             Env-based configuration (all MEMORY_* vars)
├── types.ts              Shared types (Memory, StoreResult, RecallResult, etc.)
├── prompts.ts            Exportable system prompts and tool descriptions
├── storage/
│   ├── database.ts       SQLite schema: memories, vec_memories (768-dim), memories_fts (FTS5)
│   ├── queries.ts        Data access: insert, search (vector + FTS), delete, stats
│   ├── constants.ts      Embedding dimensions, dedup thresholds
│   ├── maintenance.ts    Three-phase: consolidation → decay → compaction
│   ├── compaction.ts     LLM-driven clustering + summarization of old memories
│   └── consolidation.ts  Deferred batch dedup/contradiction detection at store time
├── retrieval/
│   ├── pipeline.ts       Full recall flow (10 steps, see below)
│   ├── scoring.ts        Score-based hybrid fusion, composite scoring, relevance filter, reranker filter, budget packing
│   ├── reranker.ts       Cross-encoder re-ranking (ms-marco-MiniLM, raw logits)
│   ├── dedup.ts          Embedding-based deduplication
│   └── formatting.ts     Output: summary (LLM), list (bullets), raw (JSON)
├── embedding/
│   └── embedder.ts       BGE model with asymmetric query prefixes, lazy singleton
├── llm/
│   └── client.ts         OpenAI-compatible client, judgment helpers (single + batch)
├── tools/
│   ├── store.ts          memory_store — persist content with tags, importance
│   ├── recall.ts         memory_recall — semantic query with token budget
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
6. **Relevance gating** — Drop fusion score < 20% of max
7. **Cross-encoder re-ranking** — ms-marco-MiniLM-L-6-v2 via `AutoModelForSequenceClassification` (raw logits, NOT pipeline API which squashes to 1.0). Try/catch falls back gracefully
8. **Re-ranker filter** — Relative gap (12 logit points from best), min 5 results
9. **Dedup** — Embedding cosine similarity
10. **Token budget packing** — Greedy skip (not break), then format

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
- `MEMORY_DEFAULT_TOKEN_BUDGET` — default recall budget (default: 2000)

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
