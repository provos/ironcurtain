/**
 * MemoryEngine implementation that wires together the engine modules.
 */

import type { MemoryEngine, StoreOptions } from './engine.js';
import type {
  StoreResult,
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
  vectorSearch,
  deleteMemories,
  findMemoriesByTags,
  findMemoriesBefore,
  getMemoriesByIds,
  getRecentMemories,
  getImportantMemories,
  getNamespaceStats,
} from './storage/queries.js';
import { maybeRunMaintenance, runMaintenance } from './storage/maintenance.js';
import { embed, embedQuery } from './embedding/embedder.js';
import { recall as retrievalRecall } from './retrieval/pipeline.js';
import { EXACT_DEDUP_DISTANCE } from './storage/constants.js';
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
    compacted_from: safeParseJson(row.compacted_from) as string[] | null,
    source: row.source,
    metadata: safeParseJson(row.metadata) as Record<string, unknown> | null,
  };
}

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

    updateMemoryContent(db, exactMatch.id, content, embedding, importance, exactMatch.content, mergedTags);
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
      consolidated: false,
    },
    embedding,
  );

  await maybeRunMaintenance(db, config);
  return { id, action: 'created' };
}

// ---------- Context ----------

const CONTEXT_DEFAULT_BUDGET = 800;
const CONTEXT_TASK_BUDGET_FRACTION = 0.7;
const CONTEXT_RECENT_BUDGET_FRACTION = 0.3;

async function buildContext(db: Database.Database, config: MemoryConfig, opts: ContextOptions): Promise<string> {
  const totalBudget = opts.token_budget ?? CONTEXT_DEFAULT_BUDGET;
  const sections: string[] = [];

  if (opts.task) {
    // Task-relevant retrieval gets the majority of the budget
    const taskResult = await retrievalRecall(db, config, {
      query: opts.task,
      token_budget: Math.floor(totalBudget * CONTEXT_TASK_BUDGET_FRACTION),
      format: 'summary',
    });
    if (taskResult.memoryIds.length > 0) {
      sections.push(`## Task-Relevant Context\n\n${taskResult.text}`);
    }
  }

  // Recent important memories for general awareness
  const recentResult = await retrievalRecall(db, config, {
    query: 'recent important information decisions preferences',
    token_budget: Math.floor(totalBudget * (opts.task ? CONTEXT_RECENT_BUDGET_FRACTION : 1)),
    format: 'list',
  });
  if (recentResult.memoryIds.length > 0) {
    sections.push(`## Recent & Important\n\n${recentResult.text}`);
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

  if (opts.tags) {
    const rows = findMemoriesByTags(db, namespace, opts.tags);
    targetIds.push(...rows.map((r) => r.id));
  }

  if (opts.before) {
    const beforeMs = Date.parse(opts.before);
    const rows = findMemoriesBefore(db, namespace, beforeMs);
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
    const rows = getMemoriesByIds(db, targetIds);
    return {
      forgotten: rows.length,
      memories: rows.map((r) => ({ id: r.id, content: r.content })),
    };
  }

  const forgotten = deleteMemories(db, targetIds);
  return { forgotten };
}

// ---------- Inspect ----------

function inspectMemories(
  db: Database.Database,
  config: MemoryConfig,
  opts: InspectOptions,
): MemoryStats | Memory[] | string {
  const namespace = config.namespace;
  const limit = opts.limit ?? 20;

  if (opts.ids) {
    const rows = getMemoriesByIds(db, opts.ids);
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
  recall(opts: RecallOptions): Promise<RecallResult>;
  context(opts: ContextOptions): Promise<string>;
  forget(opts: ForgetOptions): Promise<ForgetResult>;
  inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string>;
  close(): void;
}

export function createMemoryEngine(modules: EngineModules): MemoryEngine {
  return {
    store: (...args) => modules.store(...args),
    recall: (...args) => modules.recall(...args),
    context: (...args) => modules.context(...args),
    forget: (...args) => modules.forget(...args),
    inspect: (...args) => modules.inspect(...args),
    close: () => modules.close(),
  };
}
