/**
 * Shared helper for turning an unknown caught value into a display string.
 *
 * Replaces the inline `err instanceof Error ? err.message : String(err)`
 * pattern. Only import this where new code is being written; a codebase-wide
 * migration of the 97+ existing inline occurrences is out of scope.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
