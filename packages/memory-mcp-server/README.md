# Memory MCP Server

A persistent memory server for LLM agents using the [Model Context Protocol](https://modelcontextprotocol.io/). Provides semantic search, optional LLM summarization, and automatic maintenance — all backed by a single SQLite file.

## Features

- **Hybrid search** — vector similarity (all-MiniLM-L6-v2) + BM25 keyword search, merged via Reciprocal Rank Fusion
- **Token-budget-aware retrieval** — returns pre-summarized context blocks sized to fit your context window
- **Local-first** — embeddings run locally; cloud LLM is optional and enhances quality when available
- **Automatic maintenance** — unused memories decay over time; related memories compact into summaries
- **Namespace isolation** — multiple agents or projects share one database without cross-contamination
- **Deferred batch consolidation** — duplicate/contradiction detection runs periodically in a single batched LLM call, not on every store

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
│  │ MiniLM-L6   │  │  Vector KNN + FTS5 BM25  │   │
│  │  (local)    │  │  → RRF merge             │   │
│  └─────────────┘  │  → Composite scoring     │   │
│                   │  → Dedup by embedding    │   │
│  ┌─────────────┐  │  → Token budget packing  │   │
│  │  LLM Client │  │  → Format (summary/lis)  │   │
│  │  (optional) │  └──────────────────────────┘   │
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
│  │  memories   │ vec_memories │  memories_ft  │  │
│  │  (rows)     │ (384-dim)   │  (BM25 index)  │  │
│  └────────────┴──────────────┴────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Store path

1. Embed content locally (~5ms)
2. Check for near-exact duplicates (cosine distance < 0.1) — auto-merge, no LLM
3. Insert with `consolidated = false`
4. Every N stores (default 50), run maintenance which includes batch consolidation

### Retrieval pipeline

1. **Candidate generation** — parallel vector KNN + FTS5 search
2. **RRF merge** — Reciprocal Rank Fusion combines both result sets
3. **Composite scoring** — RRF (55%) + recency (20%) + importance (10%) + access pattern (15%)
4. **Deduplication** — remove near-duplicates by embedding similarity
5. **Token budget packing** — greedily select memories by score until budget is filled
6. **Formatting** — LLM summarization (if available) or extractive output

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
| `MEMORY_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace embedding model |
| `MEMORY_EMBEDDING_DTYPE` | `q8` | Model quantization (q8, fp16, fp32) |
| `MEMORY_LLM_API_KEY` | *(none)* | API key for LLM (enables enhanced features) |
| `MEMORY_LLM_BASE_URL` | *(none)* | OpenAI-compatible API endpoint |
| `MEMORY_LLM_MODEL` | `claude-haiku-4-5-20251001` | LLM model name |
| `MEMORY_DEFAULT_TOKEN_BUDGET` | `500` | Default token budget for recall |
| `MEMORY_MAINTENANCE_INTERVAL` | `50` | Stores between maintenance passes |
| `MEMORY_DECAY_THRESHOLD` | `0.05` | Vitality below which memories decay |
| `MEMORY_COMPACTION_MIN_GROUP` | `10` | Min decayed memories before compaction |
| `MEMORY_CONSOLIDATION_BATCH_SIZE` | `50` | Max memories per consolidation pass |

## Development

```bash
npm run build          # TypeScript compilation
npm test               # Run unit tests
npm run test:e2e       # Run end-to-end tests (requires build)
npm run benchmark      # Run retrieval quality benchmark
```

## License

Apache-2.0
