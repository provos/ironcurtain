/**
 * memory_expand tool handler.
 *
 * The agentic follow-up affordance (§9.4): given a `segment_id` surfaced by a prior
 * recall (via `expanded_segment_ids` or a `raw` unit's `segment_id`), fetch that
 * source segment's query-ranked passages — the "I got a headline, give me THIS
 * fact's parent" call. Validates input and delegates to `engine.expand`.
 */

import type { MemoryEngine } from '../engine.js';
import { MAX_QUERY_LENGTH } from './validation.js';

export interface ExpandInput {
  segment_id: string;
  query?: string;
}

export function validateExpandInput(args: Record<string, unknown>): ExpandInput {
  const segmentId = args.segment_id;
  if (typeof segmentId !== 'string' || segmentId.trim().length === 0) {
    throw new Error('segment_id is required and must be a non-empty string');
  }

  const query = args.query;
  if (query !== undefined) {
    if (typeof query !== 'string') {
      throw new Error('query must be a string');
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
    }
  }

  return {
    segment_id: segmentId.trim(),
    query: query !== undefined ? query.trim() : undefined,
  };
}

export async function handleExpand(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateExpandInput(args);
  const result = await engine.expand(input.segment_id, input.query);

  if (!result.found) {
    return `No source segment found for id ${input.segment_id}.`;
  }
  if (result.passages.length === 0) {
    return `Source segment ${input.segment_id} has no expandable content.`;
  }

  return result.passages.join('\n\n---\n\n');
}
