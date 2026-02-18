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
  prompt: unknown;
  responseText: string;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
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
export function createLlmLoggingMiddleware(
  logPath: string,
  context: LlmLogContext,
): LanguageModelMiddleware {
  initLogFile(logPath);

  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const start = Date.now();
      const result = await doGenerate();
      const durationMs = Date.now() - start;

      const responseText = extractTextFromContent(result.content);

      const entry: LlmLogEntry = {
        timestamp: new Date().toISOString(),
        stepName: context.stepName,
        modelId: model.modelId,
        prompt: params.prompt,
        responseText,
        usage: {
          inputTokens: result.usage?.inputTokens?.total,
          outputTokens: result.usage?.outputTokens?.total,
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
    .filter((part): part is { type: string; text: string } =>
      part.type === 'text' && typeof part.text === 'string',
    )
    .map(part => part.text)
    .join('');
}
