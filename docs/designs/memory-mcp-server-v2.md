# Design: General-Purpose Memory MCP Server

**Status:** Implemented (migration from `memory.md` complete; `memory.md` is fully deprecated and no longer created)
**Date:** 2026-03-11
**Supersedes:** `memory-mcp-server.md` (original design using `@modelcontextprotocol/server-memory`)
**See also:** `per-persona-memory-optin.md` for the per-persona / per-job opt-in gate that controls whether the memory MCP server is mounted for a given session.

## 1. Problem Statement

LLM agents need persistent memory across sessions. Current approaches — flat markdown files injected into system prompts, or knowledge graph servers with substring-only search — fail at scale. As memories accumulate into the tens of thousands, agents need:

- **Semantic retrieval**: find relevant memories even when query and memory share no keywords
- **Token efficiency**: return compressed, relevant context rather than raw memory dumps
- **Graceful scaling**: retrieval quality and latency should not degrade as memory grows
- **Automatic maintenance**: unused memories should fade without manual curation

### Goals

- Build a **standalone, general-purpose Memory MCP Server** publishable as an independent npm package
- Store potentially hundreds of thousands of memories per namespace
- Return **pre-summarized, token-budget-aware** context blocks (not raw data)
- Run **entirely locally** — no cloud dependencies required (cloud LLM optional for quality)
- **Graceful LLM integration** — cheap LLM (Haiku via OpenAI-compatible API) enables summarization, contradiction detection, and compaction; extractive fallback when unavailable
- Clean MCP tool API that any agent can learn from tool descriptions alone

### Non-Goals (v1)

- Memory type classification (episodic/semantic/procedural) — adds classification errors for marginal value
- Hierarchical summary trees (RAPTOR-style) — incremental tree maintenance is an unsolved engineering problem
- Cross-namespace search
- Multi-modal memories (images, audio)

## 2. Research Summary

### Existing Approaches Evaluated

| System | Approach | Verdict |
|--------|----------|---------|
| `@modelcontextprotocol/server-memory` | Knowledge graph, JSONL, substring search | Simple but no semantic search, no summarization, no forgetting. Full `read_graph` returns everything. |
| Mem0 | Cloud-hosted semantic memory | Cloud dependency violates local-first constraint |
| MemGPT / Letta | Tiered memory with page-in/page-out | Complex OS-inspired model, requires constant LLM calls |
| Zep / Graphiti | Temporal knowledge graph | Graph maintenance burden, requires external services |
| LangMem | Semantic + procedural memory | Tied to LangChain ecosystem |
| Google Always On Memory Agent | LLM-reads-and-writes structured files | Elegant but no semantic search, no scaling strategy |
| SimpleMem (2026 paper) | Semantic compression via LLM | Outperforms Mem0/MemGPT through better compression alone — validates that compression > infrastructure |

### Key Research Findings

1. **SimpleMem outperforms complex systems** through better compression, not better infrastructure. Validates retrieval-time summarization over elaborate storage schemes.

2. **Claude Code's flat markdown + keyword search works for millions of users.** This is the baseline to beat. Any proposal must demonstrably improve on it.

3. **Local embedding models are viable but imperfect.** `all-MiniLM-L6-v2` (384-dim, 23MB quantized) offers the best quality/size tradeoff. Worse than cloud models on short fragments, but sufficient for memory retrieval.

4. **Forgetting is dangerous and usually premature.** At 10-50 memories/day, hitting 100K takes years. Over-engineering forgetting for a problem that won't exist for years is a classic trap.

5. **FTS5 + vector search hybrid** catches what either misses alone. Keyword search finds "ECONNREFUSED" that embeddings miss; embeddings find "credential recovery" when you search "password reset."

6. **Background processes are unreliable in MCP servers.** stdio-transport servers start and stop with their client. Schedulers may never fire. All maintenance must run inline or on explicit trigger.

7. **LLM-assisted compression is the biggest quality lever.** SimpleMem's results show that better compression — not better infrastructure — drives the largest improvements. A cheap LLM call at retrieval time to compress 20 memories into a coherent narrative is worth more than any amount of indexing sophistication.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    MCP Client (Agent)                     │
│                                                          │
│  memory_store  memory_recall  memory_context             │
│  memory_forget  memory_inspect                           │
└─────────────────────┬────────────────────────────────────┘
                      │  MCP Protocol (stdio or SSE)
                      ▼
┌──────────────────────────────────────────────────────────┐
│                  Memory MCP Server                        │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌────────────────────┐    │
│  │   Tool   │  │ Embedding │  │ Retrieval Pipeline │    │
│  │  Router  │  │  Engine   │  │  (search + score + │    │
│  │          │  │  (ONNX)   │  │   summarize)       │    │
│  └────┬─────┘  └─────┬─────┘  └──────────┬─────────┘    │
│       │              │                    │              │
│       │              │              ┌─────┴──────┐      │
│       │              │              │ LLM Client │      │
│       │              │              │ (OpenAI-   │      │
│       │              │              │ compatible)│      │
│       │              │              └─────┬──────┘      │
│       ▼              ▼                    ▼              │
│  ┌──────────────────────────────────────────────────┐    │
│  │               SQLite Database                     │    │
│  │  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │    │
│  │  │ memories │  │ vec_memories│  │ memories_fts │ │    │
│  │  │ (rows +  │  │ (384-dim   │  │ (FTS5 full-  │ │    │
│  │  │ metadata)│  │  vectors)  │  │  text index) │ │    │
│  │  └──────────┘  └────────────┘  └──────────────┘ │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
                              │
                              ▼ (when LLM configured)
                    ┌───────────────────┐
                    │ OpenAI-Compatible │
                    │ API Endpoint      │
                    │ (Anthropic/Ollama/│
                    │  OpenRouter/etc.) │
                    └───────────────────┘
```

### Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Storage | SQLite via `better-sqlite3` | Battle-tested, single-file, full SQL, WAL mode for concurrent reads |
| Vector search | `sqlite-vec` extension | Loads into SQLite, no separate process, brute-force KNN viable to 500K |
| Full-text search | SQLite FTS5 | Built into SQLite, BM25 ranking, zero additional deps |
| Embeddings | `all-MiniLM-L6-v2` via `@huggingface/transformers` | 384-dim, 23MB quantized, ~10ms/embedding, Apache 2.0 |
| LLM | OpenAI-compatible API, default Haiku | Cheap (~$0.25/M input), fast, good at summarization and classification |
| LLM client | `openai` npm package | De facto standard for OpenAI-compatible APIs; works with Anthropic, Ollama, OpenRouter, vLLM, etc. |
| MCP SDK | `@modelcontextprotocol/sdk` | Official MCP server SDK |

**Total production dependencies: 6 packages.** The `openai` package adds the LLM client; all LLM features degrade gracefully if no endpoint is configured.

All three independent design proposals converged on the storage stack. SQLite + sqlite-vec + FTS5 + local MiniLM embeddings is the right foundation. The LLM client adds the compression quality that SimpleMem's research shows is the biggest lever.

## 4. LLM Client

The memory server uses a cheap, fast LLM for four operations: **retrieval-time summarization**, **contradiction detection on store**, **smart duplicate resolution**, and **memory compaction**. All four degrade gracefully to non-LLM fallbacks when no endpoint is configured.

### OpenAI-Compatible API

The LLM client uses the `openai` npm package, which is the de facto standard for OpenAI-compatible APIs. This means any provider works: Anthropic (via their OpenAI-compatible endpoint), Ollama, OpenRouter, vLLM, LiteLLM, etc.

```typescript
import OpenAI from 'openai';

let llmClient: OpenAI | null = null;

function getLLMClient(): OpenAI | null {
  if (!config.llmApiKey && !config.llmBaseUrl) return null;

  if (!llmClient) {
    llmClient = new OpenAI({
      apiKey: config.llmApiKey ?? 'not-needed',  // Ollama doesn't need a key
      baseURL: config.llmBaseUrl ?? 'https://api.anthropic.com/v1/',
    });
  }
  return llmClient;
}

async function llmComplete(
  systemPrompt: string,
  userPrompt: string,
  opts?: { maxTokens?: number }
): Promise<string | null> {
  const client = getLLMClient();
  if (!client) return null;  // graceful fallback

  try {
    const response = await client.chat.completions.create({
      model: config.llmModel ?? 'claude-haiku-4-5-20251001',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: opts?.maxTokens ?? 300,
      temperature: 0,
    });
    return response.choices[0]?.message?.content ?? null;
  } catch (err) {
    // Log error, return null — LLM failure should never break core functionality
    console.error('[memory-server] LLM call failed:', err);
    return null;
  }
}
```

### Where the LLM is Used

| Operation | LLM Role | Fallback Without LLM |
|-----------|----------|---------------------|
| `memory_recall` (summary format) | Abstractive summarization of retrieved memories into coherent narrative | Extractive clustering (lead sentence + related facts) |
| `memory_context` | Abstractive briefing from multiple memory sources | Structured bullet-point list |
| `memory_store` (contradiction check) | Judge whether new memory contradicts existing similar memory | Skip contradiction check; store both |
| `memory_store` (smart dedup) | Judge whether borderline-similar memories (cosine 0.85-0.95) are truly duplicates | Only deduplicate at cosine > 0.95 threshold |
| Compaction (maintenance) | Summarize group of decayed memories into consolidated summary | Extractive compaction (top-N by importance, concatenated) |

### Cost Analysis

Using Haiku ($0.25/M input, $1.25/M output):

| Operation | Input tokens | Output tokens | Cost per call |
|-----------|-------------|---------------|---------------|
| Summarize 20 memories for recall | ~2,000 | ~200 | ~$0.00075 |
| Contradiction check on store | ~200 | ~50 | ~$0.00011 |
| Smart dedup judgment | ~200 | ~30 | ~$0.00009 |
| Compact 20 decayed memories | ~2,000 | ~150 | ~$0.00069 |
| Session briefing (memory_context) | ~3,000 | ~300 | ~$0.00113 |

At 10 recalls/day + 20 stores/day + 1 briefing/day: **~$0.01/day**. Negligible.

## 5. Storage Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  namespace TEXT NOT NULL DEFAULT 'default',
  content TEXT NOT NULL,
  tags TEXT,                    -- JSON array of strings
  importance REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0, higher = resists decay
  created_at INTEGER NOT NULL,           -- Unix timestamp ms
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  is_compacted INTEGER NOT NULL DEFAULT 0,  -- 1 if this is a compacted summary
  compacted_from TEXT,         -- JSON array of memory IDs that were compacted into this
  source TEXT,                 -- optional: what session/context created this
  metadata TEXT                -- JSON blob for extensibility
);

CREATE INDEX idx_memories_namespace ON memories(namespace);
CREATE INDEX idx_memories_created ON memories(namespace, created_at);
CREATE INDEX idx_memories_importance ON memories(namespace, importance DESC);
CREATE INDEX idx_memories_accessed ON memories(namespace, last_accessed_at);

-- Vector index for semantic search
CREATE VIRTUAL TABLE vec_memories USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[384]
);

-- Full-text search for keyword matching
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  content=memories,
  content_rowid=rowid,
  tokenize='porter unicode61'
);
```

### Storage Path

Configurable via environment variable:

```
MEMORY_DB_PATH=/path/to/memory.db
```

Default: `~/.local/share/memory-mcp/default.db`

Namespace isolation is handled by the `namespace` column within a single database. For stronger isolation (separate personas), run separate server instances with different `MEMORY_DB_PATH` values.

## 5. MCP Tool API

Five tools. Each has a clear, distinct purpose.

### 5.1 `memory_store` — Store a new memory

```typescript
{
  name: "memory_store",
  description: "Store a memory for later retrieval. Memories are automatically embedded for semantic search. Store atomic facts — one idea per memory.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The memory content. Should be a single fact, observation, decision, or preference."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for filtering (e.g., 'preference', 'project:foo', 'person:alice')."
      },
      importance: {
        type: "number",
        minimum: 0, maximum: 1,
        description: "Importance 0-1. Higher values resist decay. Default: 0.5."
      }
    },
    required: ["content"]
  }
}
```

**Behavior:**
1. Compute embedding via local ONNX model
2. Find similar memories (top-5 by cosine similarity)
3. **Exact duplicates** (cosine > 0.95): update existing memory's `updated_at` and merge tags instead of creating duplicate
4. **Borderline similar** (cosine 0.85-0.95): if LLM available, ask it to judge duplicate vs. distinct vs. contradiction (see Section 8). Without LLM, treat as distinct and store both.
5. **Contradiction detected**: if LLM judges new memory contradicts existing one, update the existing memory's content to the new value and log the superseded content in metadata. Return the existing ID with a `contradiction_resolved: true` flag.
6. Insert into `memories`, `vec_memories`, and `memories_fts`
7. Return memory ID (and any dedup/contradiction info)

**Inline maintenance:** On every Nth store (configurable, default N=50), run an amortized maintenance pass: check 100 random memories for decay, compact decayed clusters. No background process needed.

### 5.2 `memory_recall` — Retrieve relevant memories

```typescript
{
  name: "memory_recall",
  description: "Recall memories relevant to a query. Returns a pre-summarized context block optimized for your context window. Uses hybrid semantic + keyword search.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language query describing what you want to remember."
      },
      token_budget: {
        type: "integer",
        description: "Maximum approximate tokens in the response. Default: 500."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Only search memories with ALL of these tags."
      },
      format: {
        type: "string",
        enum: ["summary", "list", "raw"],
        description: "'summary': compressed narrative (default). 'list': bullet points. 'raw': full JSON objects."
      }
    },
    required: ["query"]
  }
}
```

**Retrieval pipeline** (see Section 6 for details):
1. Embed query → vector KNN search (top-K candidates)
2. FTS5 keyword search (additional candidates)
3. Merge and deduplicate candidates (cosine > 0.95 = duplicate)
4. Composite scoring: similarity + recency + importance + access patterns
5. Token-budget selection: greedily pack by score until budget filled
6. Format per requested format
7. Update `last_accessed_at` and `access_count` for returned memories (reinforcement)

### 5.3 `memory_context` — Session-start briefing

```typescript
{
  name: "memory_context",
  description: "Get a pre-summarized briefing of relevant memories for starting a new session. Call this at the beginning of each session to recall prior context.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Brief description of the current task or session purpose. Helps retrieve the most relevant memories."
      },
      token_budget: {
        type: "integer",
        description: "Maximum tokens for the briefing. Default: 800."
      }
    }
  }
}
```

**Behavior:**
1. If `task` is provided: run `memory_recall` with task as query (budget: 60% of total)
2. Always include: most recently stored memories (budget: 20% of total)
3. Always include: highest-importance memories (budget: 20% of total)
4. Deduplicate across the three result sets
5. Format as a structured briefing:

```
## Memory Briefing

### Relevant to Current Task
- [2026-03-10] User prefers integration tests over mocks (importance: 0.8)
- [2026-03-09] IronCurtain session resume feature was completed

### Recent
- [2026-03-11] Started investigating Docker agent memory leak

### Key Facts
- User is a security expert building an agent runtime
- Project uses ESM modules with strict TypeScript
```

This is the most impactful single tool — it gives the agent continuity across sessions with one call.

### 5.4 `memory_forget` — Remove memories

```typescript
{
  name: "memory_forget",
  description: "Forget specific memories by ID, tag, or query match.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Specific memory IDs to forget."
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Forget all memories with ALL of these tags."
      },
      query: {
        type: "string",
        description: "Forget memories matching this query (top-10 matches, requires confirm=true)."
      },
      before: {
        type: "string",
        description: "Forget memories created before this ISO 8601 timestamp."
      },
      confirm: {
        type: "boolean",
        description: "Must be true for query-based or bulk deletion. Default: false."
      },
      dry_run: {
        type: "boolean",
        description: "If true, return what would be forgotten without actually deleting. Default: false."
      }
    }
  }
}
```

`dry_run` mode lets the agent preview deletions before committing — a safety mechanism against irreversible data loss.

### 5.5 `memory_inspect` — View stats and memories

```typescript
{
  name: "memory_inspect",
  description: "View memory statistics or inspect specific memories.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        enum: ["stats", "recent", "important", "tags"],
        description: "'stats': namespace statistics. 'recent': last N stored. 'important': highest importance. 'tags': tag frequency."
      },
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Inspect specific memories by ID."
      },
      limit: {
        type: "integer",
        description: "Max items for recent/important/tags views. Default: 20."
      }
    }
  }
}
```

## 6. Retrieval Pipeline

The retrieval pipeline is the core differentiator. Instead of returning raw memories, the server pre-processes results into compact, token-budget-aware context blocks.

### Stage 1: Candidate Generation (Hybrid Search)

Run two searches in parallel and merge results:

```typescript
function getCandidates(query: string, queryEmbedding: Float32Array, tags?: string[]): Memory[] {
  // Vector search: top-K by cosine similarity
  const vectorResults = db.prepare(`
    SELECT m.*, vec_distance_cosine(v.embedding, ?) as distance
    FROM vec_memories v
    JOIN memories m ON m.id = v.memory_id
    WHERE m.namespace = ?
    ORDER BY distance ASC
    LIMIT ?
  `).all(queryEmbedding, namespace, K);

  // FTS5 search: BM25-ranked keyword matches
  const ftsResults = db.prepare(`
    SELECT m.*, rank as bm25_score
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ? AND m.namespace = ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery(query), namespace, K);

  // Merge with Reciprocal Rank Fusion (RRF)
  return reciprocalRankFusion(vectorResults, ftsResults);
}
```

**Reciprocal Rank Fusion (RRF)** is a simple, effective method to merge ranked lists from different retrieval systems without needing to normalize scores:

```typescript
function reciprocalRankFusion(
  vectorResults: Memory[],
  ftsResults: Memory[],
  k: number = 60
): ScoredMemory[] {
  const scores = new Map<string, number>();

  vectorResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
  });
  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1));
  });

  // Sort by combined RRF score
  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([id, score]) => ({ ...memoriesById.get(id)!, rrfScore: score }));
}
```

### Stage 2: Composite Scoring

After RRF merge, apply domain-specific scoring:

```typescript
function scoreMemory(memory: ScoredMemory, now: number): number {
  const ageHours = (now - memory.created_at) / 3600000;
  const accessAgeHours = (now - memory.last_accessed_at) / 3600000;

  // Recency: exponential decay with 30-day half-life
  const recencyScore = Math.exp(-0.001 * ageHours);

  // Access pattern: recently/frequently accessed memories are boosted
  const accessScore = Math.exp(-0.002 * accessAgeHours)
    * Math.min(memory.access_count / 10, 1.0);

  // Combine RRF relevance with metadata signals
  return (
    0.55 * memory.rrfScore +
    0.20 * recencyScore +
    0.10 * memory.importance +
    0.15 * accessScore
  );
}
```

Note: these weights are initial defaults, not empirically derived. They should be configurable and tuned with real usage data.

### Stage 3: Deduplication

Remove near-duplicate memories before formatting:

```typescript
function deduplicate(memories: ScoredMemory[]): ScoredMemory[] {
  const kept: ScoredMemory[] = [];
  for (const mem of memories) {
    const isDuplicate = kept.some(
      k => cosineSimilarity(k.embedding, mem.embedding) > 0.95
    );
    if (!isDuplicate) {
      kept.push(mem);
    }
  }
  return kept;
}
```

### Stage 4: Token Budget Packing

Greedily select memories by score until the budget is filled:

```typescript
function packToBudget(ranked: ScoredMemory[], budget: number): ScoredMemory[] {
  const selected: ScoredMemory[] = [];
  let usedTokens = 0;

  for (const mem of ranked) {
    const tokens = estimateTokens(mem.content); // ~4 chars per token heuristic
    if (usedTokens + tokens > budget) continue; // skip, try smaller memories
    selected.push(mem);
    usedTokens += tokens;
  }

  return selected;
}
```

Note: we use `continue` (skip) rather than `break` so that smaller memories further down the ranked list can still fill remaining budget.

### Stage 5: Formatting

**`summary` format (default):** Two strategies, chosen based on LLM availability:

**With LLM (abstractive summarization):** Pass all selected memories to the LLM with a compression prompt. This produces a coherent narrative that captures the key facts, resolves redundancies, and fits within the token budget. This is the single biggest quality improvement over extractive approaches — validated by SimpleMem's research showing compression quality is the dominant factor.

```typescript
async function formatAsSummaryWithLLM(
  memories: ScoredMemory[],
  query: string,
  tokenBudget: number,
): Promise<string> {
  const memoriesText = memories
    .map((m, i) => `[${i + 1}] (${new Date(m.created_at).toISOString().slice(0, 10)}) ${m.content}`)
    .join('\n');

  const result = await llmComplete(
    `You are a memory compression assistant. Summarize the following memories into a concise, ` +
    `information-dense response relevant to the query. Preserve specific details (names, dates, ` +
    `numbers, exact preferences). Do not add information not present in the memories. ` +
    `Target approximately ${tokenBudget} tokens.`,
    `Query: ${query}\n\nMemories:\n${memoriesText}`,
    { maxTokens: tokenBudget },
  );

  // Fall back to extractive if LLM fails
  return result ?? formatAsSummaryExtractive(memories);
}
```

**Without LLM (extractive fallback):** Cluster selected memories by embedding proximity, then format each cluster as a paragraph with the most relevant memory as the lead sentence:

```typescript
function formatAsSummaryExtractive(memories: ScoredMemory[]): string {
  const clusters = clusterByEmbeddingSimilarity(memories, threshold: 0.80);

  return clusters.map(cluster => {
    if (cluster.length === 1) return cluster[0].content;
    const lead = cluster[0].content;
    const extras = cluster.slice(1)
      .map(m => m.content)
      .filter(c => !lead.includes(c));
    return extras.length > 0
      ? `${lead} (Related: ${extras.join('; ')})`
      : lead;
  }).join('\n\n');
}
```

**`list` format:** One bullet per memory, most relevant first, with date and importance (no LLM needed):
```
- [2026-03-10] User prefers dark mode in all applications (importance: 0.8)
- [2026-03-08] Project deadline moved to March 20th (importance: 0.9)
(+12 more memories available)
```

**`raw` format:** JSON array of full memory objects for programmatic use.

## 7. Duplicate Detection and Contradiction Resolution on Store

When storing a new memory, the server performs a three-tier similarity check to prevent duplicates and resolve contradictions:

```typescript
async function storeMemory(content: string, opts: StoreOptions): Promise<StoreResult> {
  const embedding = await embed(content);

  // Find similar memories
  const similar = db.prepare(`
    SELECT m.id, m.content, m.tags, m.importance,
           vec_distance_cosine(v.embedding, ?) as distance
    FROM vec_memories v
    JOIN memories m ON m.id = v.memory_id
    WHERE m.namespace = ?
    ORDER BY distance ASC
    LIMIT 5
  `).all(embedding, namespace);

  // Tier 1: Exact duplicates (cosine > 0.95) — merge without LLM
  const exactDup = similar.find(s => (1 - s.distance) > 0.95);
  if (exactDup) {
    const mergedTags = mergeTags(JSON.parse(exactDup.tags ?? '[]'), opts.tags ?? []);
    db.prepare(`
      UPDATE memories
      SET updated_at = ?, tags = ?, importance = MAX(importance, ?)
      WHERE id = ?
    `).run(Date.now(), JSON.stringify(mergedTags), opts.importance ?? 0.5, exactDup.id);
    return { id: exactDup.id, action: 'merged_duplicate' };
  }

  // Tier 2: Borderline similar (cosine 0.85-0.95) — use LLM to judge
  const borderline = similar.filter(s => {
    const sim = 1 - s.distance;
    return sim > 0.85 && sim <= 0.95;
  });

  if (borderline.length > 0) {
    const judgment = await judgeWithLLM(content, borderline[0]);

    if (judgment === 'duplicate') {
      const mergedTags = mergeTags(JSON.parse(borderline[0].tags ?? '[]'), opts.tags ?? []);
      db.prepare(`
        UPDATE memories
        SET updated_at = ?, tags = ?, importance = MAX(importance, ?)
        WHERE id = ?
      `).run(Date.now(), JSON.stringify(mergedTags), opts.importance ?? 0.5, borderline[0].id);
      return { id: borderline[0].id, action: 'merged_duplicate' };
    }

    if (judgment === 'contradiction') {
      // New memory supersedes old — update content, archive old in metadata
      const oldContent = borderline[0].content;
      db.prepare(`
        UPDATE memories
        SET content = ?, updated_at = ?,
            importance = MAX(importance, ?),
            metadata = json_set(COALESCE(metadata, '{}'), '$.superseded', ?)
        WHERE id = ?
      `).run(content, Date.now(), opts.importance ?? 0.5,
             JSON.stringify({ content: oldContent, at: Date.now() }),
             borderline[0].id);

      // Update the embedding to match the new content
      db.prepare(`UPDATE vec_memories SET embedding = ? WHERE memory_id = ?`)
        .run(embedding, borderline[0].id);

      return { id: borderline[0].id, action: 'contradiction_resolved' };
    }
    // judgment === 'distinct' — fall through to insert
  }

  // Tier 3: No match — insert new memory
  const id = generateId();
  // ... insert into memories, vec_memories, memories_fts ...
  return { id, action: 'created' };
}
```

### LLM Judgment for Borderline Cases

```typescript
async function judgeWithLLM(
  newContent: string,
  existing: { content: string },
): Promise<'duplicate' | 'contradiction' | 'distinct'> {
  const result = await llmComplete(
    `You judge whether two memories are duplicates, contradictions, or distinct facts.\n` +
    `Reply with exactly one word: "duplicate", "contradiction", or "distinct".\n` +
    `- "duplicate": they express the same fact, possibly worded differently\n` +
    `- "contradiction": they express conflicting facts about the same topic (the new one supersedes the old)\n` +
    `- "distinct": they are about different topics or complementary facts`,
    `Existing memory: ${existing.content}\nNew memory: ${newContent}`,
    { maxTokens: 10 },
  );

  const normalized = result?.trim().toLowerCase();
  if (normalized === 'duplicate' || normalized === 'contradiction') return normalized;
  return 'distinct'; // default to storing both if LLM unavailable or response unclear
}
```

When no LLM is configured, `judgeWithLLM` returns `'distinct'` (via the `llmComplete` → `null` path), and the server falls back to the cosine > 0.95 threshold only. This is safe: the worst case is some redundancy, which deduplication at retrieval time handles.

## 8. Decay and Maintenance

### Design Principle: No Background Processes

MCP servers (especially stdio-transport) start and stop with their client. Background schedulers are unreliable. All maintenance runs **inline**, amortized across regular operations.

### Amortized Maintenance

On every Nth `memory_store` call (default N=50), the server runs a maintenance pass with two phases: **decay** and **compaction**.

```typescript
let storeCounter = 0;

async function maybeRunMaintenance(): Promise<void> {
  storeCounter++;
  if (storeCounter < MAINTENANCE_INTERVAL) return;
  storeCounter = 0;

  const now = Date.now();

  // Phase 1: Decay — sample random memories and check vitality
  const sample = db.prepare(`
    SELECT id, content, importance, created_at, last_accessed_at, access_count
    FROM memories
    WHERE namespace = ? AND importance > 0
    ORDER BY RANDOM()
    LIMIT 100
  `).all(namespace);

  const decayed: MemoryRow[] = [];
  for (const mem of sample) {
    const vitality = computeVitality(mem, now);
    if (vitality < DECAY_THRESHOLD) {
      decayed.push(mem);
      // Remove from vector index (no longer retrieved) but keep the row
      db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(mem.id);
      db.prepare(`UPDATE memories SET importance = 0 WHERE id = ?`).run(mem.id);
    }
  }

  // Phase 2: Compaction — consolidate decayed memories into summaries
  await maybeCompact();
}
```

### Compaction: "Forget Leaves, Keep Summaries"

Inspired by the hierarchical proposal's best idea: when individual memories decay, their information is preserved in a consolidated summary. This mirrors human memory — specific details fade, but the understanding persists.

Compaction runs during maintenance when enough decayed memories have accumulated:

```typescript
async function maybeCompact(): Promise<void> {
  // Find decayed memories that haven't been compacted yet
  const decayedMemories = db.prepare(`
    SELECT id, content, tags, created_at
    FROM memories
    WHERE namespace = ? AND importance = 0 AND is_compacted = 0
    ORDER BY created_at ASC
    LIMIT 200
  `).all(namespace);

  if (decayedMemories.length < COMPACTION_MIN_GROUP) return; // default: 10

  // Cluster decayed memories by embedding similarity
  const clusters = clusterByEmbeddingSimilarity(decayedMemories, threshold: 0.70);

  for (const cluster of clusters) {
    if (cluster.length < 3) continue; // too small to compact

    const summary = await compactCluster(cluster);
    if (!summary) continue; // LLM failed, skip this cluster

    // Create compacted summary memory
    const summaryEmbedding = await embed(summary);
    const summaryId = generateId();
    const clusterIds = cluster.map(m => m.id);
    const mergedTags = [...new Set(cluster.flatMap(m => JSON.parse(m.tags ?? '[]')))];

    db.prepare(`
      INSERT INTO memories (id, namespace, content, tags, importance, created_at,
        updated_at, last_accessed_at, is_compacted, compacted_from, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'compaction')
    `).run(summaryId, namespace, summary, JSON.stringify(mergedTags),
           0.6, // compacted summaries start at moderate importance
           Date.now(), Date.now(), Date.now(),
           JSON.stringify(clusterIds));

    db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`)
      .run(summaryId, summaryEmbedding);

    // Mark source memories as compacted (soft-delete)
    for (const mem of cluster) {
      db.prepare(`UPDATE memories SET is_compacted = 1 WHERE id = ?`).run(mem.id);
    }
  }
}

async function compactCluster(memories: MemoryRow[]): Promise<string | null> {
  const memoriesText = memories
    .map(m => `- (${new Date(m.created_at).toISOString().slice(0, 10)}) ${m.content}`)
    .join('\n');

  // Try LLM-based abstractive compaction first
  const llmSummary = await llmComplete(
    `You are a memory compaction assistant. Consolidate the following related memories ` +
    `into a single concise summary that preserves all key facts, specific details ` +
    `(names, dates, numbers), and actionable information. The summary should be ` +
    `self-contained and useful without access to the original memories.`,
    `Memories to consolidate:\n${memoriesText}`,
    { maxTokens: 200 },
  );

  if (llmSummary) return llmSummary;

  // Extractive fallback: take the top-3 most representative memories
  return extractiveCompact(memories);
}

function extractiveCompact(memories: MemoryRow[]): string {
  const sorted = memories.sort((a, b) =>
    (b.access_count ?? 0) - (a.access_count ?? 0)
  );
  const dateRange = `${new Date(Math.min(...memories.map(m => m.created_at))).toISOString().slice(0, 10)}` +
    ` to ${new Date(Math.max(...memories.map(m => m.created_at))).toISOString().slice(0, 10)}`;

  return `[Consolidated ${memories.length} memories, ${dateRange}] ` +
    sorted.slice(0, 3).map(m => m.content).join('. ');
}
```

The key property: **information is never truly lost at compaction time.** The decayed source memories remain in the database (with `is_compacted = 1`) but are excluded from vector search. The compacted summary takes their place in retrieval. If the original details are ever needed, they can be recovered via `memory_inspect` with specific IDs (stored in `compacted_from`).

### Vitality Computation

```typescript
function computeVitality(memory: MemoryRow, now: number): number {
  const ageHours = (now - memory.created_at) / 3600000;

  // Half-life proportional to importance: high importance = slower decay
  // importance=1.0 → 180-day half-life, importance=0.1 → 18-day half-life
  const halfLifeHours = memory.importance * 180 * 24;
  const baseDecay = Math.pow(0.5, ageHours / halfLifeHours);

  // Access reinforcement: each access extends effective lifetime
  const reinforcement = Math.min(memory.access_count * 0.03, 0.4);

  // Recency of last access
  const accessAgeHours = (now - memory.last_accessed_at) / 3600000;
  const accessRecency = Math.exp(-accessAgeHours / (60 * 24)); // 60-day characteristic time

  return Math.min(1.0, baseDecay + reinforcement * accessRecency);
}
```

### Explicit Maintenance via `memory_inspect`

The `memory_inspect` tool with `view: "stats"` also triggers a full maintenance pass, giving users a manual trigger:

```json
{
  "total_memories": 12847,
  "active_memories": 10432,
  "decayed_memories": 2415,
  "oldest_memory": "2025-06-15T10:30:00Z",
  "newest_memory": "2026-03-11T14:22:00Z",
  "storage_bytes": 48230400,
  "top_tags": [
    { "tag": "preference", "count": 342 },
    { "tag": "project:ironcurtain", "count": 1205 }
  ]
}
```

## 9. Embedding Strategy

### Model: `all-MiniLM-L6-v2`

| Property | Value |
|----------|-------|
| Dimensions | 384 |
| Size (ONNX, q8) | ~23 MB |
| Inference | ~5-15ms per embedding |
| Max input tokens | 256 |
| License | Apache 2.0 |

```typescript
import { pipeline } from '@huggingface/transformers';

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
    });
  }
  return embedder;
}

async function embed(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const result = await model(text, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}
```

### Embedding Model Upgrade Path

Embeddings are tied to the model that produced them. If the model changes, existing vectors become incompatible. The schema stores the model identifier:

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Stores: embedding_model, embedding_dimensions, schema_version
```

On startup, if the configured model differs from the stored model, the server logs a warning. A `memory_inspect` operation with `view: "stats"` reports the mismatch. Re-embedding can be triggered via an explicit management operation (deferred to v2).

### Scalability

| Memory count | Vector search (384-dim, brute-force) | Total DB size estimate |
|-------------|--------------------------------------|----------------------|
| 1,000 | <5ms | ~3 MB |
| 10,000 | <15ms | ~25 MB |
| 50,000 | ~30ms | ~120 MB |
| 100,000 | ~50ms | ~250 MB |

At realistic accumulation rates (10-50 memories/day), reaching 100K takes 5-25 years. Brute-force vector search is viable for the foreseeable future. If needed, sqlite-vec supports binary quantization for 32x storage reduction and ~10x search speedup.

## 10. Configuration

All configuration via environment variables (MCP convention):

| Variable | Default | Description |
|----------|---------|-------------|
| **Storage** | | |
| `MEMORY_DB_PATH` | `~/.local/share/memory-mcp/default.db` | SQLite database path |
| `MEMORY_NAMESPACE` | `default` | Default namespace |
| **Embeddings** | | |
| `MEMORY_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model ID |
| `MEMORY_EMBEDDING_DTYPE` | `q8` | Quantization level |
| **LLM** | | |
| `MEMORY_LLM_BASE_URL` | `https://api.anthropic.com/v1/` | OpenAI-compatible API endpoint |
| `MEMORY_LLM_API_KEY` | (none) | API key for the LLM endpoint |
| `MEMORY_LLM_MODEL` | `claude-haiku-4-5-20251001` | Model name for LLM calls |
| **Maintenance** | | |
| `MEMORY_DECAY_THRESHOLD` | `0.05` | Vitality below which memories are decayed |
| `MEMORY_MAINTENANCE_INTERVAL` | `50` | Store operations between maintenance passes |
| `MEMORY_COMPACTION_MIN_GROUP` | `10` | Minimum decayed memories before compaction triggers |
| **Retrieval** | | |
| `MEMORY_DEFAULT_TOKEN_BUDGET` | `500` | Default token budget for recall |

When `MEMORY_LLM_API_KEY` is not set, all LLM features are disabled and the server uses extractive fallbacks. This is the only configuration needed to go from "basic" to "enhanced" mode.

### MCP Client Configuration Examples

**With Anthropic (recommended default):**
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@example/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.memory/my-project.db",
        "MEMORY_LLM_API_KEY": "${ANTHROPIC_API_KEY}",
        "MEMORY_LLM_BASE_URL": "https://api.anthropic.com/v1/"
      }
    }
  }
}
```

**With Ollama (fully local):**
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@example/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.memory/my-project.db",
        "MEMORY_LLM_BASE_URL": "http://localhost:11434/v1",
        "MEMORY_LLM_MODEL": "llama3.2:3b"
      }
    }
  }
}
```

**Without LLM (extractive only):**
```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@example/memory-mcp-server"],
      "env": {
        "MEMORY_DB_PATH": "~/.memory/my-project.db"
      }
    }
  }
}
```

## 11. Integration with IronCurtain

### Dynamic Injection in `buildSessionConfig()`

```typescript
if (config.userConfig.memory?.enabled !== false) {
  const dbPath = resolveMemoryDbPath({
    persona: opts.persona,
    jobId: opts.jobId,
  });

  mkdirSync(dirname(dbPath), { recursive: true });

  const memoryEnv: Record<string, string> = {
    MEMORY_DB_PATH: dbPath,
    MEMORY_NAMESPACE: opts.persona ?? opts.jobId ?? 'default',
  };

  // Pass through LLM config if available (from user config or env)
  const llmKey = config.userConfig.memory?.llmApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (llmKey) {
    memoryEnv.MEMORY_LLM_API_KEY = llmKey;
    memoryEnv.MEMORY_LLM_BASE_URL = config.userConfig.memory?.llmBaseUrl
      ?? 'https://api.anthropic.com/v1/';
    memoryEnv.MEMORY_LLM_MODEL = config.userConfig.memory?.llmModel
      ?? 'claude-haiku-4-5-20251001';
  }

  sessionConfig.mcpServers['memory'] = {
    command: 'npx',
    args: ['-y', '@ironcurtain/memory-mcp-server'],
    env: memoryEnv,
    description: 'Persistent memory with semantic search',
    sandbox: false,
  };
}
```

### Namespace Resolution

```typescript
function resolveMemoryDbPath(opts: { persona?: string; jobId?: string }): string {
  if (opts.persona) {
    return resolve(getPersonaDir(createPersonaName(opts.persona)), 'memory.db');
  }
  if (opts.jobId) {
    return resolve(getJobDir(opts.jobId), 'memory.db');
  }
  return resolve(getIronCurtainHome(), 'memory', 'default.db');
}
```

### Persona System Prompt Update

Replace memory.md injection with a lightweight pointer:

```typescript
export function buildPersonaSystemPromptAugmentation(
  persona: PersonaDefinition,
): string {
  return `
## Persona: ${persona.name}

${persona.description}

## Persistent Memory

You have access to a persistent memory server ("memory") with semantic search.

At the **start** of each session:
- Call \`memory_context\` with a brief description of the current task to get a briefing of relevant memories.

During the session, when you learn something worth remembering:
- Use \`memory_store\` to save facts, preferences, decisions, or observations.
- Use descriptive tags (e.g., "preference", "project:name", "person:name").
- Keep memories **atomic** — one fact per memory.

To find specific memories during the session:
- Use \`memory_recall\` with a natural language query.
`.trim();
}
```

### Cron Job Memory

When a cron job runs under a persona, it uses the **persona's** memory namespace (not a separate job namespace). The persona is the persistent identity; the cron job is just a trigger. Job-specific ephemeral state uses `workspace/last-run.md` as before.

### Server Allowlist

The `"memory"` server is always included when memory is enabled, regardless of persona server allowlist — same treatment as `"filesystem"`.

### Policy Treatment

Hardcoded annotations (all args `none` role, all operations `allow`):

```typescript
const MEMORY_TOOL_ANNOTATIONS = {
  memory_store: { sideEffects: true, args: { content: 'none', tags: 'none', importance: 'none' } },
  memory_recall: { sideEffects: false, args: { query: 'none', token_budget: 'none', tags: 'none', format: 'none' } },
  memory_context: { sideEffects: false, args: { task: 'none', token_budget: 'none' } },
  memory_forget: { sideEffects: true, args: { ids: 'none', tags: 'none', query: 'none', before: 'none', confirm: 'none', dry_run: 'none' } },
  memory_inspect: { sideEffects: false, args: { view: 'none', ids: 'none', limit: 'none' } },
};
```

Blanket allow rule in compiled policy:
```json
{ "name": "allow-memory-operations", "conditions": { "server": "memory" }, "then": "allow" }
```

## 12. Package Structure and Monorepo Strategy

### Why npm Workspaces

The memory server is an **independent, separately-publishable package** that lives inside the IronCurtain monorepo using npm workspaces. This gives us:

- **Single repo, single CI** — no git submodule ceremony, no `--recurse-submodules`, no version-pinning-by-SHA
- **Independent publishing** — `cd packages/memory-mcp-server && npm publish` publishes it standalone; external users install it with `npx @ironcurtain/memory-mcp-server` without pulling IronCurtain
- **Zero coupling** — the memory server has no imports from IronCurtain; IronCurtain references it only by package name in its MCP server config
- **Develop in tandem** — changes to both packages in a single PR, single `npm install`, workspace linking handles the rest
- **Easy extraction** — if the memory server gets its own contributor community, the `packages/memory-mcp-server/` directory can be moved to a separate repo with full git history via `git filter-branch` or `git subtree split`

### Root `package.json` Changes

```jsonc
// Add to the root package.json:
{
  "workspaces": ["packages/*"],
  // ... existing fields unchanged ...
}
```

npm workspaces hoists shared dependencies to the root `node_modules/` and symlinks workspace packages. The memory server's `devDependencies` (vitest, typescript) are shared with IronCurtain's existing tooling.

### Repository Layout

```
ironcurtain/
├── package.json                 # Root — adds "workspaces": ["packages/*"]
├── package-lock.json            # Single lockfile for the entire monorepo
├── src/                         # IronCurtain source (unchanged)
├── test/                        # IronCurtain tests (unchanged)
├── packages/
│   └── memory-mcp-server/
│       ├── package.json         # Independent package: @ironcurtain/memory-mcp-server
│       ├── tsconfig.json        # Extends root tsconfig or standalone
│       ├── README.md            # Standalone docs for npm
│       ├── src/
│       │   ├── index.ts                 # Entry point (stdio transport)
│       │   ├── server.ts                # MCP server definition, tool registration
│       │   ├── tools/
│       │   │   ├── store.ts             # memory_store (dedup + contradiction)
│       │   │   ├── recall.ts            # memory_recall (LLM summarization)
│       │   │   ├── context.ts           # memory_context (session briefing)
│       │   │   ├── forget.ts            # memory_forget (dry_run)
│       │   │   └── inspect.ts           # memory_inspect
│       │   ├── retrieval/
│       │   │   ├── pipeline.ts          # Retrieval pipeline orchestration
│       │   │   ├── scoring.ts           # RRF + composite scoring
│       │   │   ├── dedup.ts             # Deduplication + contradiction detection
│       │   │   └── formatting.ts        # Extractive + LLM abstractive formatters
│       │   ├── storage/
│       │   │   ├── database.ts          # SQLite + extensions setup, migrations
│       │   │   ├── queries.ts           # SQL query builders
│       │   │   ├── maintenance.ts       # Amortized decay + compaction
│       │   │   └── compaction.ts        # LLM-assisted memory consolidation
│       │   ├── llm/
│       │   │   └── client.ts            # OpenAI-compatible LLM client
│       │   ├── embedding/
│       │   │   └── embedder.ts          # Transformers.js ONNX embedding engine
│       │   └── config.ts               # Environment variable parsing
│       └── test/
│           ├── store.test.ts            # Dedup + contradiction tests
│           ├── recall.test.ts           # LLM summarization tests
│           ├── context.test.ts
│           ├── retrieval-pipeline.test.ts
│           ├── maintenance.test.ts
│           ├── compaction.test.ts
│           └── llm-client.test.ts       # Mock LLM endpoint tests
```

### Memory Server `package.json`

```jsonc
{
  "name": "@ironcurtain/memory-mcp-server",
  "version": "0.1.0",
  "type": "module",
  "description": "Persistent memory MCP server with semantic search, LLM summarization, and automatic compaction",
  "license": "Apache-2.0",
  "bin": {
    "memory-mcp-server": "./dist/index.js"
  },
  "files": ["dist/"],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "better-sqlite3": "^11.x",
    "sqlite-vec": "^0.1.x",
    "@huggingface/transformers": "^3.x",
    "openai": "^4.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vitest": "^2.x",
    "@types/better-sqlite3": "^7.x"
  }
}
```

### Build and Test Integration

Root-level npm scripts run across workspaces:

```jsonc
// Root package.json scripts additions:
{
  "scripts": {
    // Existing scripts unchanged...
    "build:all": "npm run build --workspaces",
    "test:all": "npm test --workspaces"
  }
}
```

CI runs `npm test --workspaces` to test both IronCurtain and the memory server. The memory server's tests are fully independent — they don't import anything from IronCurtain.

### How IronCurtain References the Memory Server

IronCurtain does **not** add the memory server as a dependency. Instead, it spawns it as a child process via `npx` (same as any MCP server), using the published package name:

```typescript
// In buildSessionConfig() — uses the published npm package, not a workspace import
sessionConfig.mcpServers['memory'] = {
  command: 'npx',
  args: ['-y', '@ironcurtain/memory-mcp-server'],
  env: memoryEnv,
  // ...
};
```

During local development, `npx` resolves to the workspace-linked package automatically. In production, it pulls from npm. This means the memory server is consumed identically whether developing locally or installed by end users — no special workspace-aware code paths.

## 13. Migration from Existing Memory Systems

### From `@modelcontextprotocol/server-memory` (JSONL knowledge graph)

The server supports importing from the JSONL format:

```typescript
// memory_inspect with special import parameter (or standalone CLI)
// Reads entities + observations from JSONL, creates flat memories with tags derived from entity types
```

### Export

`memory_inspect` with `view: "export"` returns all memories as JSONL for backup or migration:

```jsonl
{"id":"abc123","content":"User prefers dark mode","tags":["preference"],"importance":0.8,"created_at":1710100000000}
```

This provides a migration path both into and out of the system. No lock-in.

## 14. What Beats the Baseline

The baseline is Claude Code's flat markdown files with keyword search. This design beats it by:

1. **Semantic search**: "What does the user think about testing?" finds "integration tests must hit a real database, not mocks" — no shared keywords.
2. **LLM-compressed retrieval**: Retrieved memories are summarized into coherent narratives by Haiku, producing information-dense context blocks that preserve key details while minimizing token usage. SimpleMem's research shows this compression quality is the single biggest lever.
3. **Hybrid search**: FTS5 keyword matching catches what embeddings miss (error codes, exact phrases), and vice versa.
4. **Intelligent deduplication + contradiction resolution**: Near-duplicates are merged; contradicting facts are automatically resolved (new supersedes old, with audit trail).
5. **Session-start briefing**: `memory_context` gives agents continuity with a single tool call, organized by relevance to the current task.
6. **Automatic compaction**: Old, unused memories are consolidated into LLM-generated summaries — details fade but understanding persists, keeping the active memory set lean.
7. **Graceful degradation**: Without an LLM key, everything still works via extractive fallbacks. The LLM is a quality multiplier, not a hard dependency.

## 15. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Local embedding quality insufficient for short fragments | FTS5 hybrid search compensates; configurable model allows upgrades |
| `sqlite-vec` or `better-sqlite3` native compilation fails | Provide prebuilt binaries; fallback to `node:sqlite` (Node 22+) when available |
| ONNX model download on first run (~23MB) | Cache in `~/.cache/huggingface/`; document in README |
| Embedding model lock-in (re-embedding on upgrade) | Store model ID in metadata; re-embedding as v2 management operation |
| LLM summarization hallucination (fabricated facts in summaries) | Original memories preserved in DB; compacted sources tracked in `compacted_from`; extractive fallback always available |
| LLM API unavailability or latency spikes | All LLM calls are non-blocking with fallbacks; server never fails due to LLM issues |
| LLM cost accumulation | Haiku is cheap (~$0.01/day at normal usage); calls are few and small; no LLM on hot paths without user intent |
| Contradiction detection false positives | Default to `'distinct'` when uncertain; superseded content archived in metadata (reversible) |
| Premature decay of important memories | High importance = long half-life; access reinforcement; dry_run on forget; compaction preserves summaries |
| Concurrent writes from multiple sessions | SQLite WAL mode handles this; single-writer per MCP instance is the norm |

## 16. Future Extensions (v2+)

Listed in rough priority order:

1. **Memory types** — optional episodic/semantic/procedural classification, only if data shows type-based filtering improves retrieval
2. **Drill-down navigation** — two-level retrieval: compacted summaries first, then original memories on demand
3. **Re-embedding on model upgrade** — management operation to re-embed all memories with a new model
4. **Cross-namespace search** — controlled search across namespaces with permission model
5. **Streaming retrieval** — for large recalls, stream results as they are scored
6. **Retrieval quality metrics** — instrumentation to measure and improve retrieval relevance over time
7. **Hierarchical summarization** — RAPTOR-style multi-level tree, only if two-level (raw + compacted) proves insufficient

## 17. Implementation Plan

### PR 1: Core MCP Server (standalone package)

1. Set up npm workspaces: add `"workspaces": ["packages/*"]` to root `package.json`, create `packages/memory-mcp-server/` with its own `package.json` and `tsconfig.json`
2. SQLite schema + migrations (`better-sqlite3` + `sqlite-vec` + FTS5)
3. Embedding engine (`@huggingface/transformers`, lazy-loaded)
4. OpenAI-compatible LLM client with graceful fallback (`openai` package)
5. `memory_store` with three-tier duplicate detection + LLM contradiction resolution
6. `memory_recall` with full hybrid retrieval pipeline + LLM abstractive summarization
7. `memory_inspect` with stats view
8. Tests (mock LLM endpoint for deterministic testing)

### PR 2: Session Briefing + Maintenance

1. `memory_context` tool (LLM-enhanced session briefing)
2. `memory_forget` with dry_run
3. Amortized maintenance (inline decay + LLM-assisted compaction)
4. Export/import (JSONL)
5. Tests

### PR 3: IronCurtain Integration

1. Config schema (`memory.enabled`, `memory.llmApiKey`, `memory.llmBaseUrl`, `memory.llmModel` in user config)
2. `resolveMemoryDbPath()` namespace resolution
3. Dynamic server injection in `buildSessionConfig()` with LLM config passthrough
4. Server allowlist update (always include `"memory"`)
5. Policy annotations + compiled rules
6. System prompt updates (persona + cron)
7. Tests

### PR 4: Polish + Publish

1. README with usage examples for multiple MCP clients and LLM providers
2. npm publish as `@ironcurtain/memory-mcp-server` (or similar)
3. Config editor integration (memory toggle + LLM endpoint config)
4. Migration guide from `@modelcontextprotocol/server-memory`

## Appendix A: Design Process

This design was produced through a structured multi-agent process:

1. **Three independent proposals** explored different angles:
   - **Semantic memory** (embedding-based vector search + retrieval-time summarization)
   - **Cognitive-inspired memory** (episodic/semantic/procedural types, ACT-R forgetting curves, consolidation)
   - **Hierarchical memory** (RAPTOR-inspired tree with progressive summarization)

2. **A devil's advocate** researched failure modes, critiqued all three proposals, and identified:
   - What actually works in production (SimpleMem, Claude Code's flat files, Google's Always On Memory Agent)
   - Common pitfalls (over-engineering forgetting, requiring LLM for core functionality, unreliable background processes)
   - The minimum viable baseline that any proposal must beat

3. **Convergence points** across all proposals (SQLite + sqlite-vec + FTS5 + local embeddings, token-budget-aware retrieval, composite scoring, extractive summarization default) formed the foundation.

4. **Best-of-breed selection** combined Proposal 1's clean API and retrieval-time focus with Proposal 2's `memory_context` tool and hybrid retrieval, stripped to minimum complexity as recommended by the critique.

Full proposals and critique are archived at:
- `/tmp/proposal-semantic.md`
- `/tmp/proposal-cognitive.md`
- `/tmp/proposal-hierarchical.md`
- `/tmp/critique-framework.md`
- `/tmp/critique-review.md`
