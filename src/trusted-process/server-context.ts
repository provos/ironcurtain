/**
 * Tracks per-server context (e.g. working directory) accumulated
 * from successful tool calls. Used to enrich escalation requests
 * with information the human reviewer needs.
 */

export interface ServerContext {
  workingDirectory?: string;
}

export type ServerContextMap = Map<string, ServerContext>;

/** Maps tool names to the argument key that holds the working directory. */
const WORKING_DIR_ARGS: Record<string, string> = {
  git_set_working_dir: 'path',
  git_clone: 'localPath',
};

/**
 * Updates the context map after a successful tool call.
 * Currently tracks git server working directory from:
 * - `git_set_working_dir` (args.path)
 * - `git_clone` (args.localPath)
 */
export function updateServerContext(
  map: ServerContextMap,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const argKey = WORKING_DIR_ARGS[toolName];
  if (!argKey) return;

  const value = args[argKey];
  if (typeof value !== 'string') return;

  const ctx = map.get(serverName) ?? {};
  ctx.workingDirectory = value;
  map.set(serverName, ctx);
}

/**
 * Formats accumulated server context as key-value pairs for display.
 * Returns undefined if no context is available for the server.
 */
export function formatServerContext(map: ServerContextMap, serverName: string): Record<string, string> | undefined {
  const ctx = map.get(serverName);
  if (!ctx) return undefined;

  const result: Record<string, string> = {};
  if (ctx.workingDirectory) {
    result['Working directory'] = ctx.workingDirectory;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
