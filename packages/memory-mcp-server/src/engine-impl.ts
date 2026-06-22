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
  ExpandResult,
} from './types.js';
import type { MemoryConfig } from './config.js';
import type { MemoryRow } from './storage/database.js';
import { initDatabase } from './storage/database.js';
import {
  generateId,
  insertMemory,
  insertSegment,
  getSegmentsByIds,
  updateMemoryContent,
  updateMemoryTimestampsOnMerge,
  updateMemorySegmentIfRicher,
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
import { rankSegmentPassages } from './retrieval/expansion.js';
import { estimateTokens } from './retrieval/scoring.js';
import { EXACT_DEDUP_DISTANCE } from './storage/constants.js';
import { MAX_CONTENT_LENGTH } from './tools/validation.js';
import { chunkBlob, extractFacts, splitToPassages } from './storage/extraction.js';
import type { ExtractedFact, IngestMode } from './storage/extraction.js';
import { parseTags } from './utils/tags.js';
import type Database from 'better-sqlite3';

/** Cap on whole-segment passages returned by `memory_expand` when no query is given. */
const MAX_EXPAND_PASSAGES_NO_QUERY = 3;

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
    segment_id: row.segment_id,
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
    // Repoint the survivor to the RICHER parent (A4). Only runs when an ingest
    // segmentId is present; store-path merges (no segmentId) are unchanged.
    if (opts.segmentId !== undefined) {
      updateMemorySegmentIfRicher(db, namespace, exactMatch.id, opts.segmentId);
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
      segmentId: opts.segmentId,
    },
    embedding,
  );

  await maybeRunMaintenance(db, config);
  return { id, action: 'created' };
}

// ---------- Ingest (LLM-backed fact decomposition) ----------

const DEFAULT_SEED_IMPORTANCE = 0.5;

/** One source chunk and the facts extracted from it (the chunk→fact mapping). */
interface ChunkGroup {
  chunkText: string;
  facts: ExtractedFact[];
}

/**
 * Extract facts per chunk, KEEPING the chunk→fact mapping so each fact can be
 * linked to its source segment (§6.1). Exact-`fact`-string duplicates across
 * windows are still dropped, but the dedup keeps the FIRST occurrence — so a fact
 * deduped away in a later chunk stays attached to its first chunk's group (no
 * second parent link). Tracks how many chunks returned null for diagnostics (A3).
 */
async function extractAllFacts(
  config: MemoryConfig,
  chunks: string[],
  mode: IngestMode,
): Promise<{ groups: ChunkGroup[]; totalChunks: number; failedChunks: number }> {
  const seen = new Set<string>();
  const groups: ChunkGroup[] = [];
  let failedChunks = 0;

  for (const chunk of chunks) {
    const chunkFacts = await extractFacts(config, chunk, mode);
    // Only `null` is a real failure (no LLM / hard-fail / unparseable). An empty
    // array means the model validly found nothing durable — not a failed chunk.
    if (chunkFacts === null) {
      failedChunks += 1;
      continue;
    }
    const ownedFacts: ExtractedFact[] = [];
    for (const fact of chunkFacts) {
      if (seen.has(fact.fact)) continue; // already owned by an earlier chunk's group
      seen.add(fact.fact);
      ownedFacts.push(fact);
    }
    groups.push({ chunkText: chunk, facts: ownedFacts });
  }

  return { groups, totalChunks: chunks.length, failedChunks };
}

/** Flatten the per-chunk groups back to a single fact list (for diagnostics/preview). */
function flattenGroups(groups: ChunkGroup[]): ExtractedFact[] {
  return groups.flatMap((g) => g.facts);
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

  const store = (factContent: string, importance: number, segmentId?: string): Promise<StoreResult> =>
    storeImmediate(db, config, factContent, {
      tags: opts.tags,
      importance,
      source: opts.source,
      createdAt,
      segmentId,
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
  const { groups, totalChunks, failedChunks } = await extractAllFacts(config, chunks, mode);
  const facts = flattenGroups(groups);
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
    // The degraded blob can exact-dedup into an existing memory; report the real action.
    const created = result.action === 'created' ? 1 : 0;
    return {
      created,
      merged: 1 - created,
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

  // ---- Write one segment per non-empty chunk-group, then link its facts ----
  let created = 0;
  let merged = 0;
  let segmentsCreated = 0;
  const memoryIds: string[] = [];
  for (const group of groups) {
    if (group.facts.length === 0) continue;

    // One source segment per chunk that produced ≥1 fact. createdAt flows to both
    // the segment and its facts so a segment's created_at matches its facts'.
    const segmentId = insertSegment(db, {
      namespace: config.namespace,
      content: group.chunkText,
      source: opts.source,
      mode,
      createdAt,
      factCount: group.facts.length,
    });
    segmentsCreated += 1;

    for (const fact of group.facts) {
      const result = await store(fact.fact, fact.importance ?? seedImportance, segmentId);
      memoryIds.push(result.id);
      if (result.action === 'created') {
        created += 1;
      } else {
        merged += 1;
      }
    }
  }

  return {
    created,
    merged,
    memory_ids: memoryIds,
    facts,
    ...diagnostics,
    ...(segmentsCreated > 0 ? { segments_created: segmentsCreated } : {}),
  };
}

// ---------- Expand (on-demand parent fetch) ----------

/**
 * Fetch a source segment by id and return its query-ranked passages (§9.4). With a
 * `query`, passages are ranked by cosine similarity to the query embedding; without
 * one, the first few passages of the segment are returned (whole-segment fetch). A
 * missing/forgotten segment returns `{ found: false, passages: [] }`.
 */
async function expandSegment(
  db: Database.Database,
  config: MemoryConfig,
  segmentId: string,
  query?: string,
): Promise<ExpandResult> {
  const segments = getSegmentsByIds(db, config.namespace, [segmentId]);
  if (segments.length === 0) {
    return { segment_id: segmentId, passages: [], found: false };
  }
  const segment = segments[0];

  // No query: return the first few passages of the segment (whole-segment fetch).
  if (query === undefined) {
    const passages = splitToPassages(segment.content);
    return { segment_id: segmentId, passages: passages.slice(0, MAX_EXPAND_PASSAGES_NO_QUERY), found: true };
  }

  // With a query: split-and-rank by similarity to the query embedding (the shared helper,
  // also used by recall expansion). All passages, best-first.
  const queryEmbedding = await embedQuery(query, config);
  const passages = await rankSegmentPassages(config, segment.content, queryEmbedding);
  return { segment_id: segmentId, passages, found: true };
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
      // The no-human-in-loop briefing path is where missing a clause is most costly,
      // so it gets the same auto-expansion as a default recall (§5.2).
      expand: 'auto',
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
        expand: opts.expand ?? 'auto',
        max_expand_passages: opts.max_expand_passages,
      });

      return {
        content: result.text,
        memories_used: result.selectedCount,
        total_matches: result.totalCandidates,
        expanded: result.expanded,
        expanded_segment_ids: result.expandedSegmentIds,
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

    async expand(segmentId: string, query?: string): Promise<ExpandResult> {
      return expandSegment(db, config, segmentId, query);
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
  expand(segmentId: string, query?: string): Promise<ExpandResult>;
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
    expand: (...args) => modules.expand(...args),
    close: () => modules.close(),
  };
}
