/**
 * Shared JSON extraction/validation helpers for LLM text output.
 *
 * This module intentionally lives outside `pipeline/` so runtime modules
 * (auto-approval, summarization, doctor checks) can reuse it without creating
 * a live-runtime -> pipeline dependency.
 */

import type { z } from 'zod';

export function schemaToPromptHint(schema: z.ZodType): string {
  try {
    const jsonSchema = schema.toJSONSchema({ unrepresentable: 'any' });
    return `\n\nYour response must be a JSON object matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
  } catch {
    return '\n\nReturn your response as valid JSON.';
  }
}

export function extractJson(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlock) return codeBlock[1].trim();

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

export function parseJsonWithSchema<T extends z.ZodType>(text: string, schema: T): z.infer<T> {
  const json: unknown = JSON.parse(extractJson(text));
  return schema.parse(json) as z.infer<T>;
}
