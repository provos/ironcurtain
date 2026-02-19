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

interface GenerateObjectWithRepairOptions<T extends z.ZodType> {
  model: LanguageModel;
  schema: T;
  prompt: string;
  maxRepairAttempts?: number;
}

export async function generateObjectWithRepair<T extends z.ZodType>({
  model,
  schema,
  prompt,
  maxRepairAttempts = 2,
}: GenerateObjectWithRepairOptions<T>): Promise<{ output: z.infer<T> }> {
  // First attempt: simple prompt-based call
  try {
    const result = await generateText({
      model,
      output: Output.object({ schema }),
      prompt,
    });
    return { output: result.output as z.infer<T> };
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    if (maxRepairAttempts <= 0) throw error;

    // Build multi-turn conversation for repair
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: error.text ?? '' },
      {
        role: 'user',
        content: `Your response failed schema validation:\n${error.cause instanceof Error ? error.cause.message : String(error.cause)}\n\nPlease fix the errors and return valid JSON matching the schema.`,
      },
    ];

    let lastError: unknown = error;

    for (let attempt = 0; attempt < maxRepairAttempts; attempt++) {
      console.error(`  Schema repair attempt ${attempt + 1}/${maxRepairAttempts}...`);
      try {
        const result = await generateText({
          model,
          output: Output.object({ schema }),
          messages,
        });
        return { output: result.output as z.infer<T> };
      } catch (retryError) {
        if (!NoObjectGeneratedError.isInstance(retryError)) throw retryError;
        lastError = retryError;

        // Append the failed response and error for next attempt
        messages.push(
          { role: 'assistant', content: retryError.text ?? '' },
          {
            role: 'user',
            content: `Still failing schema validation:\n${retryError.cause instanceof Error ? retryError.cause.message : String(retryError.cause)}\n\nPlease fix the errors and return valid JSON matching the schema.`,
          },
        );
      }
    }

    throw lastError;
  }
}
