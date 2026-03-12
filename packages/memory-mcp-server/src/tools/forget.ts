/**
 * memory_forget tool handler.
 * Validates input, enforces confirm requirement for bulk ops,
 * and delegates to the engine.
 */

import type { MemoryEngine } from '../engine.js';

export interface ForgetInput {
  ids?: string[];
  tags?: string[];
  query?: string;
  before?: string;
  confirm?: boolean;
  dry_run?: boolean;
  namespace?: string;
}

export function validateForgetInput(args: Record<string, unknown>): ForgetInput {
  const ids = args.ids;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new Error('ids must be an array of strings');
    }
  }

  const tags = args.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      throw new Error('tags must be an array of strings');
    }
  }

  const query = args.query;
  if (query !== undefined && typeof query !== 'string') {
    throw new Error('query must be a string');
  }

  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') {
      throw new Error('before must be an ISO 8601 timestamp string');
    }
    const parsed = Date.parse(before);
    if (isNaN(parsed)) {
      throw new Error('before must be a valid ISO 8601 timestamp');
    }
  }

  const confirm = args.confirm;
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    throw new Error('confirm must be a boolean');
  }

  const dryRun = args.dry_run;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new Error('dry_run must be a boolean');
  }

  const namespace = args.namespace;
  if (namespace !== undefined && typeof namespace !== 'string') {
    throw new Error('namespace must be a string');
  }

  // At least one targeting criterion is required
  if (!ids && !tags && !query && !before) {
    throw new Error('At least one of ids, tags, query, or before must be specified');
  }

  return {
    ids: ids,
    tags: tags,
    query: typeof query === 'string' ? query.trim() : undefined,
    before: before,
    confirm: confirm,
    dry_run: dryRun,
    namespace: namespace,
  };
}

function requiresConfirmation(input: ForgetInput): boolean {
  // Bulk operations (query-based, tag-based, time-based) require confirm=true
  // ID-based deletion is targeted enough to not require confirmation
  return !input.ids && !input.confirm;
}

export async function handleForget(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateForgetInput(args);

  if (requiresConfirmation(input)) {
    return 'Bulk deletion requires confirm=true. ' + 'Use dry_run=true first to preview what would be forgotten.';
  }

  const result = await engine.forget({
    ids: input.ids,
    tags: input.tags,
    query: input.query,
    before: input.before,
    confirm: input.confirm,
    dry_run: input.dry_run,
    namespace: input.namespace,
  });

  if (input.dry_run) {
    if (!result.memories || result.memories.length === 0) {
      return 'No memories match the criteria.';
    }
    const preview = result.memories.map((m) => `- ${m.id}: ${m.content.slice(0, 100)}`).join('\n');
    return `Would forget ${result.forgotten} memories:\n${preview}`;
  }

  return `Forgot ${result.forgotten} memories.`;
}
