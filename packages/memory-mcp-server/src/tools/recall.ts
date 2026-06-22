/**
 * memory_recall tool handler.
 * Validates input and delegates to the engine.
 */

import type { MemoryEngine } from '../engine.js';
import type { ExpandMode } from '../types.js';
import { FORMAT_MODES, type FormatMode } from '../retrieval/formatting.js';
import { MAX_QUERY_LENGTH, validateTokenBudget, validateTags, validateMaxExpandPassages } from './validation.js';

export interface RecallInput {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: FormatMode;
  expand: ExpandMode;
  max_expand_passages?: number;
}

const VALID_FORMATS: ReadonlySet<string> = new Set(FORMAT_MODES);
const EXPAND_MODES: readonly ExpandMode[] = ['none', 'auto', 'parent'];
const VALID_EXPAND_MODES: ReadonlySet<string> = new Set(EXPAND_MODES);

export function validateRecallInput(args: Record<string, unknown>): RecallInput {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query is required and must be a non-empty string');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }

  const tokenBudget = validateTokenBudget(args.token_budget);
  const tags = validateTags(args.tags);

  const format = args.format;
  if (format !== undefined) {
    if (typeof format !== 'string' || !VALID_FORMATS.has(format)) {
      throw new Error(`format must be one of: ${FORMAT_MODES.map((f) => `'${f}'`).join(', ')}`);
    }
  }

  const expandArg = args.expand;
  if (expandArg !== undefined && (typeof expandArg !== 'string' || !VALID_EXPAND_MODES.has(expandArg))) {
    throw new Error(`expand must be one of: ${EXPAND_MODES.map((m) => `'${m}'`).join(', ')}`);
  }
  const expand = (expandArg as ExpandMode | undefined) ?? 'auto';

  const maxExpandPassages = validateMaxExpandPassages(args.max_expand_passages);

  return {
    query: query.trim(),
    token_budget: tokenBudget,
    tags,
    format: format as RecallInput['format'],
    expand,
    max_expand_passages: maxExpandPassages,
  };
}

/**
 * Structured result of a `memory_recall` call. `text` is the human-readable
 * payload; the remaining fields are the recall metadata an agent needs to drive
 * the `memory_expand` follow-up loop (which segments were auto-expanded).
 */
export interface RecallToolResult {
  text: string;
  memories_used: number;
  total_matches: number;
  expanded: boolean;
  expanded_segment_ids: string[];
}

export async function handleRecall(engine: MemoryEngine, args: Record<string, unknown>): Promise<RecallToolResult> {
  const input = validateRecallInput(args);
  const result = await engine.recall({
    query: input.query,
    token_budget: input.token_budget,
    tags: input.tags,
    format: input.format,
    expand: input.expand,
    max_expand_passages: input.max_expand_passages,
  });

  const text = result.memories_used === 0 ? 'No relevant memories found.' : result.content;

  return {
    text,
    memories_used: result.memories_used,
    total_matches: result.total_matches,
    expanded: result.expanded ?? false,
    expanded_segment_ids: result.expanded_segment_ids ?? [],
  };
}
