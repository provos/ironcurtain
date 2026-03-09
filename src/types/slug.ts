/**
 * Shared slug validation for named entities (personas, job IDs, etc.).
 * Slug: 1-63 chars, lowercase alphanumeric, hyphens, or underscores,
 * starting with a letter or digit.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateSlug(raw: string, label: string): void {
  if (!SLUG_PATTERN.test(raw)) {
    throw new Error(
      `Invalid ${label} "${raw}": must be 1-63 chars, ` +
        `lowercase alphanumeric, hyphens, or underscores, ` +
        `starting with a letter or digit`,
    );
  }
}
