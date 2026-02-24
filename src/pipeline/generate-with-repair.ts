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

export const DEFAULT_MAX_TOKENS = 8192;

/** Converts a Zod schema to a JSON Schema string for inclusion in prompts. */
export function schemaToPromptHint(schema: z.ZodType): string {
  try {
    const jsonSchema = schema.toJSONSchema({ unrepresentable: 'any' });
    return `\n\nYour response must be a JSON object matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
  } catch {
    // Some schemas (e.g. with transforms) can't be converted to JSON Schema
    return '\n\nReturn your response as valid JSON.';
  }
}

/**
 * Extracts a JSON object or array from LLM text that may include
 * markdown fences or surrounding prose.
 */
export function extractJson(text: string): string {
  // Try markdown code block first
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlock) return codeBlock[1].trim();

  // Find the outermost { ... } or [ ... ]
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  if (objStart === -1 && arrStart === -1) return text;

  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  const openChar = text[start];
  const closeChar = openChar === '{' ? '}' : ']';
  const end = text.lastIndexOf(closeChar);
  if (end === -1) return text;

  return text.slice(start, end + 1);
}

/**
 * Extracts and validates JSON from LLM text output against a Zod schema.
 * Handles markdown fences, surrounding prose, and schema validation.
 *
 * Exported for use by ScenarioGeneratorSession which manages its own
 * message history but needs the same extraction+validation logic.
 */
export function parseJsonWithSchema<T extends z.ZodType>(text: string, schema: T): z.infer<T> {
  const json: unknown = JSON.parse(extractJson(text));
  return schema.parse(json) as z.infer<T>;
}

interface GenerateObjectWithRepairOptions<T extends z.ZodType> {
  model: LanguageModel;
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

    const result = system
      ? await generateText({ model, system, messages, maxOutputTokens })
      : await generateText({ model, messages, maxOutputTokens });

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
