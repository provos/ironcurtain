/**
 * Multi-turn LLM repair for schema validation failures.
 *
 * Calls `generateText` and validates the response against a Zod schema.
 * On validation failure, feeds the error back to the LLM in a multi-turn
 * conversation so it can fix its output. Up to maxRepairAttempts retries.
 *
 * Does NOT use Output.object / structured output because Anthropic's API
 * rejects several JSON Schema constructs that Zod legitimately produces
 * (propertyNames from z.record, oneOf from z.discriminatedUnion).  Instead
 * we rely on prompt instructions for JSON formatting and Zod for validation.
 */

import type { LanguageModel, SystemModelMessage } from 'ai';
import { generateText } from 'ai';
import type { z } from 'zod';
import type { TextGenerationModel } from '../llm/text-generation.js';
import { generateTextWithModel, isTextGenerationModel } from '../llm/text-generation.js';
import { parseJsonWithSchema, schemaToPromptHint } from '../llm/json.js';
export { extractJson, parseJsonWithSchema, schemaToPromptHint } from '../llm/json.js';

export const DEFAULT_MAX_TOKENS = 8192;

interface GenerateObjectWithRepairOptions<T extends z.ZodType> {
  model: LanguageModel | TextGenerationModel;
  schema: T;
  system?: string | SystemModelMessage;
  prompt: string;
  maxRepairAttempts?: number;
  maxOutputTokens?: number;
  onProgress?: (message: string) => void;
}

export async function generateObjectWithRepair<T extends z.ZodType>({
  model,
  schema,
  system,
  prompt,
  maxRepairAttempts = 2,
  maxOutputTokens = DEFAULT_MAX_TOKENS,
  onProgress,
}: GenerateObjectWithRepairOptions<T>): Promise<{ output: z.infer<T>; repairAttempts: number }> {
  const promptWithSchema = prompt + schemaToPromptHint(schema);
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: promptWithSchema },
  ];

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    if (attempt > 0) {
      onProgress?.(`Schema repair ${attempt}/${maxRepairAttempts}...`);
    }

    const result = await callTextModel(model, {
      ...(system ? { system } : {}),
      messages,
      maxOutputTokens,
    });

    const text = result.text;

    try {
      const parsed = parseJsonWithSchema(text, schema);
      return { output: parsed, repairAttempts: attempt };
    } catch (error) {
      if (attempt === maxRepairAttempts) throw error;

      const errorMessage = error instanceof Error ? error.message : String(error);
      messages.push(
        { role: 'assistant', content: text },
        {
          role: 'user',
          content: `Your response failed schema validation:\n${errorMessage}\n\nPlease fix the errors and return valid JSON matching the schema.`,
        },
      );
    }
  }

  // Should never reach here due to the throw in the loop
  throw new Error('generateObjectWithRepair: exhausted all repair attempts');
}

async function callTextModel(
  model: LanguageModel | TextGenerationModel,
  options: {
    readonly system?: string | SystemModelMessage;
    readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
    readonly maxOutputTokens: number;
  },
): Promise<{ readonly text: string }> {
  if (isTextGenerationModel(model)) {
    return generateTextWithModel(model, options);
  }
  return generateText({
    model,
    ...(options.system ? { system: options.system } : {}),
    messages: [...options.messages],
    maxOutputTokens: options.maxOutputTokens,
  });
}
