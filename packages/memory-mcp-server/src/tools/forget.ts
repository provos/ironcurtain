/**
 * memory_forget tool handler.
 * Validates input, enforces confirm requirement for bulk ops,
 * and delegates to the engine.
 */

import type { MemoryEngine } from '../engine.js';
import { MAX_QUERY_LENGTH, validateIds, validateTags } from './validation.js';

export interface ForgetInput {
  ids?: string[];
  tags?: string[];
  query?: string;
  before?: string;
  confirm?: boolean;
  dry_run?: boolean;
}

export function validateForgetInput(args: Record<string, unknown>): ForgetInput {
  const ids = validateIds(args.ids);
  const tags = validateTags(args.tags);

  const query = args.query;
  if (query !== undefined && typeof query !== 'string') {
    throw new Error('query must be a string');
  }
  if (typeof query === 'string' && query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
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

  // At least one effective targeting criterion is required
  // Treat empty arrays as "not provided" to prevent no-op forgets
  const hasIds = ids && ids.length > 0;
  const hasTags = tags && tags.length > 0;
  if (!hasIds && !hasTags && !query && !before) {
    throw new Error('At least one of ids, tags, query, or before must be specified');
  }

  return {
    ids,
    tags,
    query: typeof query === 'string' ? query.trim() : undefined,
    before: before,
    confirm: confirm,
    dry_run: dryRun,
  };
}

function requiresConfirmation(input: ForgetInput): boolean {
  // Bulk operations (query-based, tag-based, time-based) require confirm=true
  // ID-based deletion is targeted enough to not require confirmation
  return !(input.ids && input.ids.length > 0) && !input.confirm;
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
  });

  const truncatedNote = result.truncated
    ? ' (results were truncated — more memories match; run again to continue)'
    : '';

  if (input.dry_run) {
    if (!result.memories || result.memories.length === 0) {
      return 'No memories match the criteria.';
    }
    const preview = result.memories.map((m) => `- ${m.id}: ${m.content.slice(0, 100)}`).join('\n');
    return `Would forget ${result.forgotten} memories${truncatedNote}:\n${preview}`;
  }

  return `Forgot ${result.forgotten} memories.${truncatedNote}`;
}
