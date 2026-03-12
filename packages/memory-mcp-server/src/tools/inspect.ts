/**
 * memory_inspect tool handler.
 * Validates input and formats stats/memories/export from the engine.
 */

import type { MemoryEngine } from '../engine.js';
import type { Memory, MemoryStats } from '../types.js';

export interface InspectInput {
  view?: 'stats' | 'recent' | 'important' | 'tags' | 'export';
  ids?: string[];
  limit?: number;
  namespace?: string;
}

const VALID_VIEWS = new Set(['stats', 'recent', 'important', 'tags', 'export']);

export function validateInspectInput(args: Record<string, unknown>): InspectInput {
  const view = args.view;
  if (view !== undefined) {
    if (typeof view !== 'string' || !VALID_VIEWS.has(view)) {
      throw new Error("view must be one of: 'stats', 'recent', 'important', 'tags', 'export'");
    }
  }

  const ids = args.ids;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new Error('ids must be an array of strings');
    }
  }

  const limit = args.limit;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      throw new Error('limit must be a positive integer');
    }
  }

  const namespace = args.namespace;
  if (namespace !== undefined && typeof namespace !== 'string') {
    throw new Error('namespace must be a string');
  }

  return {
    view: view,
    ids: ids,
    limit: limit,
    namespace: namespace,
  };
}

function formatStats(stats: MemoryStats): string {
  const lines = [
    '## Memory Statistics',
    '',
    `Total memories: ${stats.total_memories}`,
    `Active: ${stats.active_memories}`,
    `Decayed: ${stats.decayed_memories}`,
    `Compacted: ${stats.compacted_memories}`,
    `Storage: ${formatBytes(stats.storage_bytes)}`,
  ];

  if (stats.oldest_memory) {
    lines.push(`Oldest: ${stats.oldest_memory}`);
  }
  if (stats.newest_memory) {
    lines.push(`Newest: ${stats.newest_memory}`);
  }

  if (stats.top_tags.length > 0) {
    lines.push('', '### Top Tags');
    for (const { tag, count } of stats.top_tags) {
      lines.push(`- ${tag}: ${count}`);
    }
  }

  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMemoryList(memories: Memory[]): string {
  if (memories.length === 0) {
    return 'No memories found.';
  }

  return memories
    .map((m) => {
      const date = new Date(m.created_at).toISOString().slice(0, 10);
      const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
      return `- [${date}] (id: ${m.id}, importance: ${m.importance})${tags} ${m.content}`;
    })
    .join('\n');
}

export async function handleInspect(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateInspectInput(args);
  const result = await engine.inspect({
    view: input.view,
    ids: input.ids,
    limit: input.limit,
    namespace: input.namespace,
  });

  // Engine returns different types based on the view
  if (typeof result === 'string') {
    // Export view returns JSONL string
    return result;
  }

  if (isMemoryStats(result)) {
    return formatStats(result);
  }

  // Memory array (recent, important, ids, tags)
  return formatMemoryList(result);
}

function isMemoryStats(value: unknown): value is MemoryStats {
  return typeof value === 'object' && value !== null && 'total_memories' in value && 'active_memories' in value;
}
