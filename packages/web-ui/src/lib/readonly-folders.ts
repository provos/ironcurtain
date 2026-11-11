/**
 * Read-only folder list helpers shared by the New session and Resume dialogs.
 * The daemon validates and canonicalizes the paths; these only manage the
 * user's draft list.
 */

/** Mirrors MAX_READONLY_MOUNTS on the daemon (which re-validates). */
export const MAX_READONLY_FOLDERS = 8;

/** Last path segment, for compact chip labels (handles `/` and `\`). */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed || path;
}

/** Returns `list` with `path` added, unless it is empty, a duplicate, or over the limit. */
export function withFolder(list: readonly string[], path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed || list.includes(trimmed) || list.length >= MAX_READONLY_FOLDERS) return [...list];
  return [...list, trimmed];
}
