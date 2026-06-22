/**
 * MemoryEngine implementation that wires together the engine modules.
 */

import type { MemoryEngine, StoreOptions, IngestOptions } from './engine.js';
import type {
  StoreResult,
  IngestResult,
  RecallOptions,
  RecallResult,
  ContextOptions,
  ForgetOptions,
  ForgetResult,
  InspectOptions,
  Memory,
  MemoryStats,
} from './types.js';
import type { MemoryConfig } from './config.js';
import type { MemoryRow } from './storage/database.js';
import { initDatabase } from './storage/database.js';
import {
  generateId,
  insertMemory,
  updateMemoryContent,
  updateMemoryTimestampsOnMerge,
  vectorSearch,
  deleteMemories,
  findMemoriesByTags,
  findMemoriesBefore,
  getMemoriesByIds,
  getRecentMemories,
  getImportantMemories,
  getNamespaceStats,
  updateAccessStats,
} from './storage/queries.js';
import { maybeRunMaintenance, runMaintenance } from './storage/maintenance.js';
import { embed, embedQuery } from './embedding/embedder.js';
import { recall as retrievalRecall } from './retrieval/pipeline.js';
import { estimateTokens } from './retrieval/scoring.js';
import { EXACT_DEDUP_DISTANCE } from './storage/constants.js';
import { MAX_CONTENT_LENGTH } from './tools/validation.js';
import { chunkBlob, extractFacts } from './storage/extraction.js';
import type { ExtractedFact, IngestMode } from './storage/extraction.js';
import { parseTags } from './utils/tags.js';
import type Database from 'better-sqlite3';

// ---------- Row <-> Memory conversion ----------

function safeParseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    namespace: row.namespace,
    content: row.content,
    tags: parseTags(row.tags),
    importance: row.importance,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    is_compacted: row.is_compacted === 1,
    compacted_from:
      ((safeParseJson(row.metadata) as Record<string, unknown> | null)?.compacted_from as string[] | undefined) ?? null,
    source: row.source,
    metadata: safeParseJson(row.metadata) as Record<string, unknown> | null,
  };
}

const FORGET_RESULT_LIMIT = 1000;

// ---------- Store (immediate, no LLM) ----------

async function storeImmediate(
  db: Database.Database,
  config: MemoryConfig,
  content: string,
  opts: StoreOptions,
): Promise<StoreResult> {
  const namespace = config.namespace;
  const importance = opts.importance ?? 0.5;
  const embedding = await embed(content, config);

  // Cheap heuristic: exact-dedup at small cosine distance (high similarity)
  const candidates = vectorSearch(db, namespace, embedding, 3);
  const exactMatch = candidates.find((c) => c.distance < EXACT_DEDUP_DISTANCE);

  if (exactMatch) {
    // Merge tags from both memories so no metadata is lost
    const existingTags = parseTags(exactMatch.tags);
    const newTags = opts.tags ?? [];
    const mergedTags = [...new Set([...existingTags, ...newTags])];

    updateMemoryContent(db, namespace, exactMatch.id, content, embedding, importance, exactMatch.content, mergedTags);
    // Order-independent timestamp reconciliation for backdated (`as_of`) merges (A1).
    // Only runs when createdAt is set; non-`as_of` merges are byte-for-byte unchanged.
    if (opts.createdAt !== undefined) {
      updateMemoryTimestampsOnMerge(db, namespace, exactMatch.id, opts.createdAt);
    }
    return { id: exactMatch.id, action: 'merged_duplicate' };
  }

  // Insert as unconsolidated -- LLM dedup happens during maintenance
  const id = generateId();
  insertMemory(
    db,
    {
      id,
      namespace,
      content,
      tags: opts.tags,
      importance,
      source: opts.source,
      consolidated: false,
      createdAt: opts.createdAt,
    },
    embedding,
  );

  await maybeRunMaintenance(db, config);
  return { id, action: 'created' };
}

// ---------- Ingest (LLM-backed fact decomposition) ----------

const DEFAULT_SEED_IMPORTANCE = 0.5;

/**
 * Extract facts from each chunk and union them, dropping exact-`fact`-string
 * duplicates across windows (first occurrence keeps its importance). Tracks how
 * many chunks returned null/[] for diagnostics (A3).
 */
async function extractAllFacts(
  config: MemoryConfig,
  chunks: string[],
  mode: IngestMode,
): Promise<{ facts: ExtractedFact[]; totalChunks: number; failedChunks: number }> {
  const seen = new Set<string>();
  const facts: ExtractedFact[] = [];
  let failedChunks = 0;

  for (const chunk of chunks) {
    const chunkFacts = await extractFacts(config, chunk, mode);
    // Only `null` is a real failure (no LLM / hard-fail / unparseable). An empty
    // array means the model validly found nothing durable — not a failed chunk.
    if (chunkFacts === null) {
      failedChunks += 1;
      continue;
    }
    for (const fact of chunkFacts) {
      if (seen.has(fact.fact)) continue;
      seen.add(fact.fact);
      facts.push(fact);
    }
  }

  return { facts, totalChunks: chunks.length, failedChunks };
}

/**
 * Decompose a blob into atomic-fact memories via the LLM, writing each fact
 * through the existing `store` pipeline. PII-safe: never logs raw content.
 */
export async function ingestBlob(
  db: Database.Database,
  config: MemoryConfig,
  content: string,
  opts: IngestOptions,
): Promise<IngestResult> {
  const seedImportance = opts.importance ?? DEFAULT_SEED_IMPORTANCE;
  const mode: IngestMode = opts.mode ?? 'conversation';
  const onFailure = opts.on_extraction_failure ?? 'degrade';
  const createdAt = opts.as_of;
  const dryRun = opts.dry_run ?? false;

  const store = (factContent: string, importance: number): Promise<StoreResult> =>
    storeImmediate(db, config, factContent, {
      tags: opts.tags,
      importance,
      source: opts.source,
      createdAt,
    });

  // Shared shape for the "nothing written" returns (clean-empty and skip).
  const emptyResult = (extra?: Partial<IngestResult>): IngestResult => ({
    created: 0,
    merged: 0,
    memory_ids: [],
    facts: [],
    ...extra,
  });

  const chunks = chunkBlob(content);
  const { facts, totalChunks, failedChunks } = await extractAllFacts(config, chunks, mode);
  const multiChunk = totalChunks > 1;

  // ---- Empty fact union ----
  if (facts.length === 0) {
    // No failures, just nothing durable: extraction SUCCEEDED and the model
    // reported no durable facts. Write nothing and report a clean empty ingest —
    // this is not a failure, so it never triggers the degrade/skip/error path.
    if (failedChunks === 0) {
      return emptyResult();
    }
    // Real failures produced no usable facts → on_extraction_failure path.
    if (onFailure === 'error') {
      throw new Error(`memory_ingest: extraction produced no facts (${failedChunks}/${totalChunks} chunks failed)`);
    }
    if (onFailure === 'skip') {
      return emptyResult({ skipped: true });
    }
    // 'degrade': store the blob as a single memory (product behavior).
    const truncated = content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;
    if (dryRun) {
      return {
        created: 0,
        merged: 0,
        memory_ids: [],
        facts: [{ fact: truncated, importance: seedImportance }],
        degraded: true,
      };
    }
    const result = await store(truncated, seedImportance);
    return {
      created: 1,
      merged: 0,
      memory_ids: [result.id],
      facts: [{ fact: truncated, importance: seedImportance }],
      degraded: true,
    };
  }

  const partial = failedChunks > 0;
  const diagnostics: Pick<IngestResult, 'chunks' | 'failed_chunks' | 'degraded' | 'partial'> = {
    ...(multiChunk ? { chunks: totalChunks } : {}),
    ...(partial ? { failed_chunks: failedChunks, degraded: true, partial: true } : {}),
  };

  // ---- Dry run: preview without writing ----
  if (dryRun) {
    return { created: 0, merged: 0, memory_ids: [], facts, ...diagnostics };
  }

  // ---- Write each fact through the existing store pipeline ----
  let created = 0;
  let merged = 0;
  const memoryIds: string[] = [];
  for (const fact of facts) {
    const result = await store(fact.fact, fact.importance ?? seedImportance);
    memoryIds.push(result.id);
    if (result.action === 'created') {
      created += 1;
    } else {
      merged += 1;
    }
  }

  return { created, merged, memory_ids: memoryIds, facts, ...diagnostics };
}

// ---------- Context ----------

const CONTEXT_DEFAULT_BUDGET = 800;
const CONTEXT_TASK_BUDGET_FRACTION = 0.7;
const CONTEXT_RECENT_BUDGET_FRACTION = 0.3;

async function buildContext(db: Database.Database, config: MemoryConfig, opts: ContextOptions): Promise<string> {
  const totalBudget = opts.token_budget ?? CONTEXT_DEFAULT_BUDGET;
  const sections: string[] = [];

  if (opts.task) {
    const taskResult = await retrievalRecall(db, config, {
      query: opts.task,
      token_budget: Math.floor(totalBudget * CONTEXT_TASK_BUDGET_FRACTION),
      format: 'summary',
    });
    if (taskResult.memoryIds.length > 0) {
      sections.push(`## Task-Relevant Context\n\n${taskResult.text}`);
    }
  }

  // Direct SQL queries for recent & important — no synthetic retrieval query
  const recentBudget = Math.floor(totalBudget * (opts.task ? CONTEXT_RECENT_BUDGET_FRACTION : 1));
  const limit = 20;
  const recent = getRecentMemories(db, config.namespace, limit);
  const important = getImportantMemories(db, config.namespace, limit);

  // Deduplicate by ID (recent and important may overlap)
  const seen = new Set<string>();
  const combined: MemoryRow[] = [];
  for (const mem of [...recent, ...important]) {
    if (!seen.has(mem.id)) {
      seen.add(mem.id);
      combined.push(mem);
    }
  }

  // Format as list and pack to budget
  const lines: string[] = [];
  const displayedIds: string[] = [];
  let usedTokens = 0;
  for (const mem of combined) {
    const date = new Date(mem.created_at).toISOString().slice(0, 10);
    const line = `- [${date}] ${mem.content} (importance: ${mem.importance})`;
    const tokens = estimateTokens(line);
    if (usedTokens + tokens > recentBudget) continue;
    lines.push(line);
    displayedIds.push(mem.id);
    usedTokens += tokens;
  }

  if (lines.length > 0) {
    sections.push(`## Recent & Important\n\n${lines.join('\n')}`);
    updateAccessStats(db, config.namespace, displayedIds);
  }

  return sections.join('\n\n');
}

// ---------- Forget ----------

async function forgetMemories(db: Database.Database, config: MemoryConfig, opts: ForgetOptions): Promise<ForgetResult> {
  const namespace = config.namespace;
  let targetIds: string[] = [];

  if (opts.ids) {
    targetIds = opts.ids;
  }

  let truncated = false;

  if (opts.tags) {
    const rows = findMemoriesByTags(db, namespace, opts.tags, FORGET_RESULT_LIMIT);
    if (rows.length >= FORGET_RESULT_LIMIT) truncated = true;
    targetIds.push(...rows.map((r) => r.id));
  }

  if (opts.before) {
    const beforeMs = Date.parse(opts.before);
    const rows = findMemoriesBefore(db, namespace, beforeMs, FORGET_RESULT_LIMIT);
    if (rows.length >= FORGET_RESULT_LIMIT) truncated = true;
    targetIds.push(...rows.map((r) => r.id));
  }

  if (opts.query) {
    const embedding = await embedQuery(opts.query, config);
    const results = vectorSearch(db, namespace, embedding, 10);
    targetIds.push(...results.map((r) => r.id));
  }

  // Deduplicate
  targetIds = [...new Set(targetIds)];

  if (opts.dry_run) {
    const rows = getMemoriesByIds(db, namespace, targetIds);
    return {
      forgotten: rows.length,
      memories: rows.map((r) => ({ id: r.id, content: r.content })),
      ...(truncated ? { truncated } : {}),
    };
  }

  const forgotten = deleteMemories(db, namespace, targetIds);
  return { forgotten, ...(truncated ? { truncated } : {}) };
}

// ---------- Inspect ----------

function inspectMemories(
  db: Database.Database,
  config: MemoryConfig,
  opts: InspectOptions,
): MemoryStats | Memory[] | string {
  const namespace = config.namespace;
  const limit = opts.limit ?? 20;

  if (opts.ids && opts.ids.length > 0) {
    const rows = getMemoriesByIds(db, namespace, opts.ids);
    return rows.map(rowToMemory);
  }

  const view = opts.view ?? 'stats';

  switch (view) {
    case 'stats': {
      const raw = getNamespaceStats(db, namespace);
      return {
        total_memories: raw.total_memories,
        active_memories: raw.active_memories,
        decayed_memories: raw.decayed_memories,
        compacted_memories: raw.compacted_memories,
        oldest_memory: raw.oldest_memory ? new Date(raw.oldest_memory).toISOString() : null,
        newest_memory: raw.newest_memory ? new Date(raw.newest_memory).toISOString() : null,
        storage_bytes: raw.storage_bytes,
        top_tags: raw.top_tags,
      };
    }

    case 'recent': {
      const rows = getRecentMemories(db, namespace, limit);
      return rows.map(rowToMemory);
    }

    case 'important': {
      const rows = getImportantMemories(db, namespace, limit);
      return rows.map(rowToMemory);
    }

    case 'tags': {
      const raw = getNamespaceStats(db, namespace);
      // Return tags as a formatted string since the return type union includes string
      const lines = raw.top_tags.map((t) => `- ${t.tag}: ${t.count}`);
      return lines.length > 0 ? lines.join('\n') : 'No tags found.';
    }

    case 'export': {
      const rows = getRecentMemories(db, namespace, 10000);
      return rows.map((r) => JSON.stringify(rowToMemory(r))).join('\n') + '\n';
    }
  }
}

// ---------- Public factory ----------

/**
 * Create a MemoryEngine from a config by initializing all subsystems.
 * This is the production entry point.
 */
export function createMemoryEngineFromConfig(config: MemoryConfig): MemoryEngine {
  const db = initDatabase(config.dbPath, config.embeddingModel);

  // Run consolidation on startup to process any memories left unconsolidated
  // from a previous session. Fire-and-forget so it doesn't block initialization.
  runMaintenance(db, config).catch((err: unknown) => {
    console.error('[memory-server] Startup maintenance failed:', err);
  });

  return {
    async store(content: string, opts: StoreOptions): Promise<StoreResult> {
      return storeImmediate(db, config, content, opts);
    },

    async ingest(content: string, opts: IngestOptions): Promise<IngestResult> {
      return ingestBlob(db, config, content, opts);
    },

    async recall(opts: RecallOptions): Promise<RecallResult> {
      const result = await retrievalRecall(db, config, {
        query: opts.query,
        token_budget: opts.token_budget ?? config.defaultTokenBudget,
        tags: opts.tags,
        format: opts.format ?? 'summary',
      });

      return {
        content: result.text,
        memories_used: result.selectedCount,
        total_matches: result.totalCandidates,
      };
    },

    async context(opts: ContextOptions): Promise<string> {
      return buildContext(db, config, opts);
    },

    async forget(opts: ForgetOptions): Promise<ForgetResult> {
      return forgetMemories(db, config, opts);
    },

    inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string> {
      return Promise.resolve(inspectMemories(db, config, opts));
    },

    close(): void {
      db.close();
    },
  };
}

/**
 * Create a MemoryEngine from pre-built modules (for testing).
 */
export interface EngineModules {
  store(content: string, opts: StoreOptions): Promise<StoreResult>;
  ingest(content: string, opts: IngestOptions): Promise<IngestResult>;
  recall(opts: RecallOptions): Promise<RecallResult>;
  context(opts: ContextOptions): Promise<string>;
  forget(opts: ForgetOptions): Promise<ForgetResult>;
  inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string>;
  close(): void;
}

export function createMemoryEngine(modules: EngineModules): MemoryEngine {
  return {
    store: (...args) => modules.store(...args),
    ingest: (...args) => modules.ingest(...args),
    recall: (...args) => modules.recall(...args),
    context: (...args) => modules.context(...args),
    forget: (...args) => modules.forget(...args),
    inspect: (...args) => modules.inspect(...args),
    close: () => modules.close(),
  };
}
