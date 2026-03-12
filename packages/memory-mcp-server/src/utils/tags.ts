/**
 * Parse a JSON-encoded tags string into a string array.
 * Handles null, undefined, empty strings, and corrupted JSON gracefully.
 */
export function parseTags(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
}
