# Memory MCP Server

A persistent memory server for LLM agents using the [Model Context Protocol](https://modelcontextprotocol.io/). Provides semantic search, optional LLM summarization, and automatic maintenance — all backed by a single SQLite file.

## Why Another Memory Server?

Most memory MCP servers fall into two camps: minimal and infrastructure-heavy. The official `@modelcontextprotocol/server-memory` stores a knowledge graph in a JSON file with substring search only — useful, but limited as memories grow. Mem0, Hindsight, and doobidoo offer semantic search and smart features, but require Python runtimes, Docker containers, or external databases (PostgreSQL, Qdrant, Neo4j).

This server fills a specific gap: **a TypeScript MCP server with semantic search, LLM summarization, and automatic maintenance that runs from a single SQLite file with zero external dependencies.**

- **Single command, single file** — `npx` to start, one `.db` file to back up. SQLite + sqlite-vec + FTS5 handle storage, vector search, and keyword search in-process.
- **Works without an LLM, improves with one** — Extractive retrieval, cosine-only dedup, and bullet-point formatting work out of the box. Adding a cheap LLM endpoint (Haiku, Ollama, etc.) enables abstractive summarization, contradiction detection, and smarter consolidation.
- **Token-budget-aware responses** — Instead of dumping raw memories into your context window, the server summarizes and packs results to fit a specified token budget. The `memory_context` tool provides a structured session-start briefing — a capability unique to this server.

For a detailed competitive analysis covering 11 memory systems, see [docs/designs/memory-server-comparison.md](../../docs/designs/memory-server-comparison.md).

## Features

- **Score-based hybrid fusion** — vector similarity (BGE-base) + FTS5 BM25 keyword search, merged via Weaviate-style relativeScoreFusion with min-max normalized scores blended by alpha weighting. Unlike pure rank-based fusion (used by Letta, Zep, mind-mem, LangChain), score-based fusion retains the discriminating power of both retrieval signals — an approach validated by production search engines (Weaviate, Elasticsearch, Qdrant) and research (Bruch et al. 2023)
- **Cross-encoder reranking** — ms-marco-MiniLM re-ranks candidates using raw logits with relative gap filtering, improving precision without aggressive cutoffs
- **Composite scoring** — fusion relevance (incorporating vector + BM25 magnitudes) blended with recency, importance, and access pattern signals
- **Token-budget-aware retrieval** — returns pre-summarized context blocks sized to fit your context window
- **SQLite-native, zero external dependencies** — embeddings and reranking run locally in-process; no Postgres, Neo4j, Redis, or Docker required. One `.db` file to back up
- **Works without an LLM, improves with one** — extractive retrieval and bullet-point formatting work out of the box; adding a cheap LLM (Haiku, Ollama) enables abstractive summarization and contradiction detection
- **Automatic maintenance** — unused memories decay over time; related memories compact into summaries via three-phase pipeline (consolidation, decay, compaction)
- **Namespace isolation** — multiple agents or projects share one database without cross-contamination

## Quick Start

```bash
npm install
npm run build
```

### Run as an MCP server

```bash
# Minimal (no LLM, extractive retrieval only)
MEMORY_DB_PATH=./my-memories.db node dist/index.js

# With Anthropic Haiku for summarization + contradiction detection
MEMORY_DB_PATH=./my-memories.db \
MEMORY_LLM_API_KEY=$ANTHROPIC_API_KEY \
MEMORY_LLM_BASE_URL=https://api.anthropic.com/v1/ \
node dist/index.js
```

### Configure in Claude Desktop / MCP client

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp-server/dist/index.js"],
      "env": {
        "MEMORY_DB_PATH": "~/.local/share/memory-mcp/default.db",
        "MEMORY_LLM_API_KEY": "your-api-key",
        "MEMORY_LLM_BASE_URL": "https://api.anthropic.com/v1/"
      }
    }
  }
}
```

### With Ollama (fully local)

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp-server/dist/index.js"],
      "env": {
        "MEMORY_DB_PATH": "~/.local/share/memory-mcp/default.db",
        "MEMORY_LLM_BASE_URL": "http://localhost:11434/v1",
        "MEMORY_LLM_MODEL": "llama3.2:3b"
      }
    }
  }
}
```

## Tools

### memory_store

Store a memory for later retrieval. Memories are automatically embedded for semantic search.

```
content  (string, required)   — The memory content. Store one fact per call.
tags     (string[], optional) — For filtering, e.g. ["preference", "project:foo"]
importance (number, optional) — 0-1 scale, controls decay resistance. Default 0.5.
```

### memory_recall

Retrieve memories relevant to a query. Returns a pre-summarized context block.

```
query        (string, required)   — Natural language query
token_budget (integer, optional)  — Max tokens in response. Default 500.
tags         (string[], optional) — Filter to memories with ALL these tags
format       (string, optional)   — "summary" (default), "list", or "raw"
```

### memory_context

Get a session briefing of relevant memories. Call at the start of each conversation.

```
task         (string, optional)   — Brief description of the current task
token_budget (integer, optional)  — Max tokens for briefing. Default 800.
```

### memory_forget

Remove memories by ID, tag, query match, or timestamp.

```
ids     (string[], optional)  — Specific memory IDs to forget
tags    (string[], optional)  — Forget all memories with ALL these tags
query   (string, optional)    — Forget top-10 matches
before  (string, optional)    — ISO 8601 timestamp cutoff
confirm (boolean, optional)   — Required for query-based or bulk deletion
dry_run (boolean, optional)   — Preview what would be deleted. Default false.
```

### memory_inspect

View memory statistics or inspect specific memories.

```
view  (string, optional)    — "stats" (default), "recent", "important", "tags", "export"
ids   (string[], optional)  — Inspect specific memories by ID
limit (integer, optional)   — Max items returned. Default 20.
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  MCP Client                      │
│            (Claude, Cursor, etc.)                │
└──────────────┬───────────────────────────────────┘
               │ stdio (JSON-RPC)
┌──────────────▼───────────────────────────────────┐
│  MCP Server (server.ts)                          │
│  Tool handlers: store, recall, context,          │
│                 forget, inspect                  │
└──────────────┬───────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────┐
│  Engine (engine-impl.ts)                         │
│  Wires together all subsystems                   │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌─────────────┐  ┌──────────────────────────┐   │
│  │  Embedder   │  │   Retrieval Pipeline     │   │
│  │ BGE-base    │  │  Vector KNN + FTS5 BM25  │   │
│  │  (local)    │  │  → Score-based fusion     │   │
│  └─────────────┘  │  → Composite scoring     │   │
│  ┌─────────────┐  │  → Cross-encoder rerank  │   │
│  │  Reranker   │  │  → Dedup by embedding    │   │
│  │ ms-marco    │  │  → Token budget packing  │   │
│  │  (local)    │  │  → Format (summary/list) │   │
│  └─────────────┘  └──────────────────────────┘   │
│  ┌─────────────┐                                 │
│  │  LLM Client │                                 │
│  │  (optional) │                                 │
│  │  Haiku etc. │                                 │
│  └─────────────┘  ┌──────────────────────────┐   │
│                   │   Maintenance            │   │
│                   │  Phase 0: Consolidation  │   │
│                   │    (batch LLM dedup)     │   │
│                   │  Phase 1: Vitality deca  │   │
│                   │  Phase 2: Compaction     │   │
│                   └──────────────────────────┘   │
├──────────────────────────────────────────────────┤
│  SQLite (WAL mode)                               │
│  ┌────────────┬──────────────┬────────────────┐  │
│  │  memories   │ vec_memories │  memories_fts  │  │
│  │  (rows)     │ (768-dim)   │  (BM25 index)  │  │
│  └────────────┴──────────────┴────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Store path

1. Embed content locally (~5ms)
2. Check for near-exact duplicates (cosine distance < 0.1) — auto-merge, no LLM
3. Insert with `consolidated = false`
4. Every N stores (default 50), run maintenance which includes batch consolidation

### Retrieval pipeline

1. **Candidate generation** — parallel vector KNN (50 candidates) + FTS5 BM25 search (50 candidates, Porter stemming, bigram phrases)
2. **Score-based fusion** — Weaviate-style relativeScoreFusion: min-max normalize vector similarity and BM25 scores independently to [0,1], then blend with alpha weighting (default 0.5). Candidates from only one source get only that source's weighted contribution
3. **Tag filter** — optional intersection filter
4. **Composite scoring** — fusion relevance (0.65) + recency (0.15) + importance (0.1) + access patterns (0.1). The fusion score already encodes vector + BM25 magnitudes
5. **Relevance gating** — drop candidates with fusion score < 20% of max
6. **Cross-encoder reranking** — ms-marco-MiniLM-L-6-v2 re-scores candidates; relative gap filter (5 logit points from best)
7. **Deduplication** — remove near-duplicates by embedding cosine similarity
8. **Token budget packing** — greedily select memories by score until budget is filled (skip, not break)
9. **Formatting** — LLM summarization (if available) or extractive bullet list

### Maintenance (amortized, no background processes)

- **Consolidation** — finds unconsolidated memories, groups close candidates, makes one batched LLM call to classify duplicates/contradictions/distinct. Also runs on server startup to handle leftovers from previous sessions.
- **Decay** — samples memories and checks vitality (half-life proportional to importance, boosted by access frequency). Below-threshold memories decay.
- **Compaction** — clusters decayed memories and summarizes them via LLM, preserving originals as soft-deleted references.

### Graceful LLM degradation

Every LLM-enhanced feature has an extractive fallback:

| Feature | With LLM | Without LLM |
|---------|----------|-------------|
| Recall formatting | Abstractive summary | Extractive bullet list |
| Dedup on store | Exact-match heuristic only | Same (LLM dedup deferred to consolidation) |
| Consolidation | Batch LLM judgment | Mark all as consolidated |
| Compaction | LLM-generated summaries | Skip compaction |
| Contradiction detection | LLM classification | Only exact-match merging |

## Configuration

All settings are controlled via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_PATH` | `~/.local/share/memory-mcp/default.db` | SQLite database path |
| `MEMORY_NAMESPACE` | `default` | Namespace for memory isolation |
| `MEMORY_EMBEDDING_MODEL` | `Xenova/bge-base-en-v1.5` | HuggingFace embedding model |
| `MEMORY_EMBEDDING_DTYPE` | `q8` | Model quantization (q8, fp16, fp32) |
| `MEMORY_LLM_API_KEY` | *(none)* | API key for LLM (enables enhanced features) |
| `MEMORY_LLM_BASE_URL` | *(none)* | OpenAI-compatible API endpoint |
| `MEMORY_LLM_MODEL` | `claude-haiku-4-5-20251001` | LLM model name |
| `MEMORY_DEFAULT_TOKEN_BUDGET` | `500` | Default token budget for recall |
| `MEMORY_MAINTENANCE_INTERVAL` | `50` | Stores between maintenance passes |
| `MEMORY_DECAY_THRESHOLD` | `0.05` | Vitality below which memories decay |
| `MEMORY_COMPACTION_MIN_GROUP` | `10` | Min decayed memories before compaction |
| `MEMORY_CONSOLIDATION_BATCH_SIZE` | `50` | Max memories per consolidation pass |

## Agent Integration

The package exports system prompts and tool descriptions for integrating the memory server with LLM agents:

```typescript
import { MEMORY_SYSTEM_PROMPT } from '@provos/memory-mcp-server/prompts';

// Append to your agent's system prompt
const systemPrompt = basePrompt + '\n\n' + MEMORY_SYSTEM_PROMPT;
```

For custom setups, use the configurable builder:

```typescript
import { buildMemorySystemPrompt } from '@provos/memory-mcp-server/prompts';

const prompt = buildMemorySystemPrompt({
  persona: 'Research Assistant',
  additionalInstructions: 'Always tag paper references with "paper:<title>".',
});
```

The `TOOL_DESCRIPTIONS` export provides enhanced descriptions used in tool registration:

```typescript
import { TOOL_DESCRIPTIONS } from '@provos/memory-mcp-server/prompts';
// TOOL_DESCRIPTIONS.memory_store, .memory_recall, .memory_context, etc.
```

## Development

```bash
npm run build          # TypeScript compilation
npm test               # Run unit tests
npm run test:e2e       # Run end-to-end tests (requires build)
npm run benchmark      # Run retrieval quality benchmark
```

## License

Apache-2.0
