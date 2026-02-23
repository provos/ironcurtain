/**
 * LLM Interaction Logger -- AI SDK middleware that captures all LLM
 * prompts and responses during the policy compilation pipeline.
 *
 * Uses `wrapLanguageModel()` with a custom middleware that intercepts
 * every `doGenerate` call. The caller sets `context.stepName` before
 * each pipeline phase so logs are labeled without changing module APIs.
 *
 * Writes a single JSONL file with one entry per LLM call.
 */

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LanguageModelMiddleware } from 'ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmLogEntry {
  timestamp: string;
  stepName: string;
  modelId: string;
  /**
   * For the first entry (promptOffset === 0), this is the full prompt array.
   * For subsequent entries, this contains only new messages since the last
   * logged entry. Reconstruct the full prompt by concatenating all entries'
   * prompt arrays in order.
   */
  prompt: unknown;
  /** Index into the full prompt array where this entry's messages start. */
  promptOffset: number;
  responseText: string;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cacheReadTokens: number | undefined;
    cacheWriteTokens: number | undefined;
  };
  durationMs: number;
}

export interface LlmLogContext {
  stepName: string;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an AI SDK middleware that logs every generate call to a JSONL file.
 *
 * @param logPath - Absolute path to the output JSONL file.
 * @param context - Mutable context object. Set `context.stepName` before each
 *   pipeline phase to label the log entries.
 */
export function createLlmLoggingMiddleware(logPath: string, context: LlmLogContext): LanguageModelMiddleware {
  initLogFile(logPath);

  // Track how many prompt items were logged so far to enable delta logging.
  let previousPromptLength = 0;

  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const start = Date.now();
      const result = await doGenerate();
      const durationMs = Date.now() - start;

      const responseText = extractTextFromContent(result.content);

      // Only log new messages since the last entry (delta logging).
      const fullPrompt = params.prompt;
      const promptArray = Array.isArray(fullPrompt) ? fullPrompt : [fullPrompt];
      const promptOffset = previousPromptLength;
      const newMessages = promptArray.slice(promptOffset);
      previousPromptLength = promptArray.length;

      const entry: LlmLogEntry = {
        timestamp: new Date().toISOString(),
        stepName: context.stepName,
        modelId: model.modelId,
        prompt: newMessages,
        promptOffset,
        responseText,
        usage: {
          inputTokens: result.usage.inputTokens.total,
          outputTokens: result.usage.outputTokens.total,
          cacheReadTokens: result.usage.inputTokens.cacheRead,
          cacheWriteTokens: result.usage.inputTokens.cacheWrite,
        },
        durationMs,
      };

      appendLogEntry(logPath, entry);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function initLogFile(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  // Truncate any existing file from a previous run
  writeFileSync(logPath, '');
}

function appendLogEntry(logPath: string, entry: LlmLogEntry): void {
  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

function extractTextFromContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part): part is { type: string; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}
