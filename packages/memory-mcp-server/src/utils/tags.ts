/**
 * Parse a JSON-encoded tags string into a string array.
 * Handles null, undefined, and empty strings gracefully.
 */
export function parseTags(json: string | null | undefined): string[] {
  if (!json) return [];
  return JSON.parse(json) as string[];
}
