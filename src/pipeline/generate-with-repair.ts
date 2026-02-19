/**
 * Multi-turn LLM repair for schema validation failures.
 *
 * Wraps `generateText` with `Output.object`. On schema validation failure
 * (NoObjectGeneratedError), feeds the Zod error back to the LLM in a
 * multi-turn conversation so it can fix its output.
 */

import type { LanguageModel } from 'ai';
import { generateText, NoObjectGeneratedError, Output } from 'ai';
import type { z } from 'zod';

const DEFAULT_MAX_TOKENS = 8192;

function formatValidationError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface GenerateObjectWithRepairOptions<T extends z.ZodType> {
  model: LanguageModel;
  schema: T;
  prompt: string;
  maxRepairAttempts?: number;
  maxTokens?: number;
  onProgress?: (message: string) => void;
}

export async function generateObjectWithRepair<T extends z.ZodType>({
  model,
  schema,
  prompt,
  maxRepairAttempts = 2,
  maxTokens = DEFAULT_MAX_TOKENS,
  onProgress,
}: GenerateObjectWithRepairOptions<T>): Promise<{ output: z.infer<T>; repairAttempts: number }> {
  // First attempt: simple prompt-based call
  try {
    const result = await generateText({
      model,
      output: Output.object({ schema }),
      prompt,
      maxTokens,
    });
    return { output: result.output as z.infer<T>, repairAttempts: 0 };
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    if (maxRepairAttempts <= 0) throw error;

    // Build multi-turn conversation for repair
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: error.text ?? '' },
      {
        role: 'user',
        content: `Your response failed schema validation:\n${formatValidationError(error.cause)}\n\nPlease fix the errors and return valid JSON matching the schema.`,
      },
    ];

    let lastError: unknown = error;

    for (let attempt = 0; attempt < maxRepairAttempts; attempt++) {
      onProgress?.(`Schema repair ${attempt + 1}/${maxRepairAttempts}...`);
      try {
        const result = await generateText({
          model,
          output: Output.object({ schema }),
          messages,
          maxTokens,
        });
        return { output: result.output as z.infer<T>, repairAttempts: attempt + 1 };
      } catch (retryError) {
        if (!NoObjectGeneratedError.isInstance(retryError)) throw retryError;
        lastError = retryError;

        // Append the failed response and error for next attempt
        messages.push(
          { role: 'assistant', content: retryError.text ?? '' },
          {
            role: 'user',
            content: `Still failing schema validation:\n${formatValidationError(retryError.cause)}\n\nPlease fix the errors and return valid JSON matching the schema.`,
          },
        );
      }
    }

    throw lastError;
  }
}
