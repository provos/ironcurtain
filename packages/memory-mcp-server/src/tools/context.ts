/**
 * memory_context tool handler.
 * Validates input and delegates to the engine for session-start briefing.
 */

import type { MemoryEngine } from '../engine.js';

export interface ContextInput {
  task?: string;
  token_budget?: number;
  namespace?: string;
}

const MAX_TASK_LENGTH = 2000;
const MAX_TOKEN_BUDGET = 50000;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;
const MAX_NAMESPACE_LENGTH = 256;

export function validateContextInput(args: Record<string, unknown>): ContextInput {
  const task = args.task;
  if (task !== undefined && typeof task !== 'string') {
    throw new Error('task must be a string');
  }
  if (typeof task === 'string' && task.length > MAX_TASK_LENGTH) {
    throw new Error(`task exceeds maximum length of ${MAX_TASK_LENGTH} characters`);
  }

  const tokenBudget = args.token_budget;
  if (tokenBudget !== undefined) {
    if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget < 1) {
      throw new Error('token_budget must be a positive integer');
    }
    if (tokenBudget > MAX_TOKEN_BUDGET) {
      throw new Error(`token_budget exceeds maximum of ${MAX_TOKEN_BUDGET}`);
    }
  }

  const namespace = args.namespace;
  if (namespace !== undefined && typeof namespace !== 'string') {
    throw new Error('namespace must be a string');
  }
  if (typeof namespace === 'string') {
    if (namespace.length > MAX_NAMESPACE_LENGTH) {
      throw new Error(`namespace exceeds maximum length of ${MAX_NAMESPACE_LENGTH} characters`);
    }
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new Error('namespace must contain only alphanumeric characters, hyphens, underscores, dots, and colons');
    }
  }

  return {
    task: typeof task === 'string' ? task.trim() : undefined,
    token_budget: tokenBudget,
    namespace: namespace,
  };
}

export async function handleContext(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateContextInput(args);
  const briefing = await engine.context({
    task: input.task,
    token_budget: input.token_budget,
    namespace: input.namespace,
  });

  if (!briefing || briefing.trim().length === 0) {
    return 'No memories found. This appears to be a fresh session.';
  }

  return briefing;
}
