/**
 * Auto-save session summaries to the memory server.
 *
 * When enabled, sends a final message at session close that instructs
 * the agent to store a condensed session summary via the memory MCP tool.
 */

import type { Session, ConversationTurn } from '../session/types.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { PersonaDefinition } from '../persona/types.js';
import type { JobDefinition } from '../cron/types.js';
import { BudgetExhaustedError } from '../session/errors.js';
import { isMemoryEnabledFor } from './memory-policy.js';
import { loadPersona } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import { loadJob } from '../cron/job-store.js';
import { createJobId } from '../cron/types.js';
import * as logger from '../logger.js';

export interface AutoSaveOptions {
  readonly dockerMode?: boolean;
  /** Optional send function. Defaults to session.sendMessage(). */
  readonly sendFn?: (message: string) => Promise<string>;
}

const MAX_SUMMARY_CHARS = 2000;
const MAX_TURNS_TO_SUMMARIZE = 50;

/**
 * Checks whether auto-save is enabled for this session's scope. Combines
 * the per-persona / per-job memory gate (`isMemoryEnabledFor`) with the
 * user-config `autoSave` flag. Returns false unless both signals agree.
 *
 * Callers must thread the loaded persona / job definition (whichever
 * applies) so the gate can short-circuit on per-scope opt-outs. Default
 * sessions (no persona, no job) always return false because memory
 * itself is off in that scope.
 */
export function shouldAutoSaveMemory(
  config: IronCurtainConfig,
  scope: { persona?: PersonaDefinition; job?: JobDefinition } = {},
): boolean {
  if (!isMemoryEnabledFor({ ...scope, userConfig: config.userConfig })) return false;
  return config.userConfig.memory.autoSave;
}

/**
 * Same as `shouldAutoSaveMemory`, but accepts raw persona/job names and
 * loads the definitions internally. Fail-closed: if either load throws,
 * returns false rather than propagating. Useful for callers that hold
 * the names from session options but never need the loaded defs for
 * anything else.
 */
export function shouldAutoSaveMemoryByName(
  config: IronCurtainConfig,
  scope: { personaName?: string; jobId?: string } = {},
): boolean {
  if (!config.userConfig.memory.enabled) return false;
  let persona: PersonaDefinition | undefined;
  if (scope.personaName) {
    try {
      persona = loadPersona(createPersonaName(scope.personaName));
    } catch {
      return false;
    }
  }
  let job: JobDefinition | undefined;
  if (scope.jobId) {
    try {
      job = loadJob(createJobId(scope.jobId));
    } catch {
      return false;
    }
  }
  return shouldAutoSaveMemory(config, { persona, job });
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function buildCondensedHistory(turns: readonly ConversationTurn[]): string {
  if (turns.length === 0) return '';
  const perTurnBudget = Math.floor(MAX_SUMMARY_CHARS / turns.length);
  const halfBudget = Math.floor(perTurnBudget / 2);

  const lines: string[] = [];
  for (const turn of turns) {
    const user = truncate(turn.userMessage, halfBudget);
    const assistant = truncate(turn.assistantResponse, halfBudget);
    lines.push(`User: ${user}`);
    lines.push(`Assistant: ${assistant}`);
  }

  const joined = lines.join('\n');
  return truncate(joined, MAX_SUMMARY_CHARS);
}

function buildAutoSavePrompt(history: readonly ConversationTurn[], dockerMode: boolean): string {
  const toolName = dockerMode ? 'memory_store' : 'memory.store';
  const condensed = buildCondensedHistory(history);

  return (
    `Your session is ending. Before closing, save a brief summary of what was accomplished in this session to memory.\n` +
    `\n` +
    `Here is the conversation from this session:\n` +
    `---\n` +
    `${condensed}\n` +
    `---\n` +
    `\n` +
    `Call ${toolName} with:\n` +
    `- A concise summary capturing: what task was given, what was accomplished, key decisions made, and any unfinished work or issues encountered\n` +
    `- Tags: ["session-summary"] plus any relevant topic tags\n` +
    `- importance: 0.5\n` +
    `\n` +
    `Make exactly one ${toolName} call, then stop. Do not respond with any other text.`
  );
}

/**
 * Saves session memory after a task completes.
 * Handles all errors internally — callers should not need try/catch.
 * Returns true if the auto-save prompt was sent, false if skipped or failed.
 */
export async function saveSessionMemory(session: Session, options?: AutoSaveOptions): Promise<boolean> {
  let history = session.getHistory();
  if (history.length === 0) {
    logger.info('[AutoSave] Skipping: no conversation history');
    return false;
  }

  // Cap to recent turns to keep the prompt small and avoid pathological cases.
  if (history.length > MAX_TURNS_TO_SUMMARIZE) {
    history = history.slice(-MAX_TURNS_TO_SUMMARIZE);
  }

  const prompt = buildAutoSavePrompt(history, options?.dockerMode ?? false);

  const send = options?.sendFn ?? session.sendMessage.bind(session);

  try {
    await send(prompt);
    logger.info('[AutoSave] Auto-save prompt sent');
    return true;
  } catch (err: unknown) {
    if (err instanceof BudgetExhaustedError) {
      logger.info('[AutoSave] Skipping: budget exhausted');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[AutoSave] Failed to save session memory: ${message}`);
    }
    return false;
  }
}
