/**
 * memory_context tool handler.
 * Validates input and delegates to the engine for session-start briefing.
 */

import type { MemoryEngine } from '../engine.js';
import { MAX_QUERY_LENGTH, validateTokenBudget } from './validation.js';

export interface ContextInput {
  task?: string;
  token_budget?: number;
}

export function validateContextInput(args: Record<string, unknown>): ContextInput {
  const task = args.task;
  if (task !== undefined && typeof task !== 'string') {
    throw new Error('task must be a string');
  }
  if (typeof task === 'string' && task.length > MAX_QUERY_LENGTH) {
    throw new Error(`task exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }

  const tokenBudget = validateTokenBudget(args.token_budget);

  return {
    task: typeof task === 'string' ? task.trim() : undefined,
    token_budget: tokenBudget,
  };
}

export async function handleContext(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateContextInput(args);
  const briefing = await engine.context({
    task: input.task,
    token_budget: input.token_budget,
  });

  if (!briefing || briefing.trim().length === 0) {
    return 'No memories found. This appears to be a fresh session.';
  }

  return briefing;
}
