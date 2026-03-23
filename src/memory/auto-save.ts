/**
 * Auto-save session summaries to the memory server.
 *
 * When enabled, sends a final message at session close that instructs
 * the agent to store a condensed session summary via the memory MCP tool.
 */

import type { Session, ConversationTurn } from '../session/types.js';
import type { IronCurtainConfig } from '../config/types.js';
import { BudgetExhaustedError } from '../session/errors.js';
import * as logger from '../logger.js';

export interface AutoSaveOptions {
  readonly dockerMode?: boolean;
  /** Optional send function. Defaults to session.sendMessage(). */
  readonly sendFn?: (message: string) => Promise<string>;
}

const MAX_SUMMARY_CHARS = 2000;
const MAX_TURNS_TO_SUMMARIZE = 50;

/**
 * Checks whether auto-save is enabled in user config. Callers must also
 * verify the session has memory context (persona or jobId) since the
 * memory server is injected inside createSession(), not in the base config.
 */
export function shouldAutoSaveMemory(config: IronCurtainConfig): boolean {
  return config.userConfig.memory.enabled && config.userConfig.memory.autoSave;
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
