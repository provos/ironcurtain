/**
 * Server names reserved for internal use that cannot be used in
 * mcp-servers.json. These are virtual MCP servers registered in-process
 * (e.g., the proxy domain-management tools) rather than spawned from
 * `mcp-servers.json`.
 *
 * Typed as `ReadonlySet` so importers cannot weaken the reserved-name
 * enforcement in `src/config/index.ts` or the server-filter pass in
 * `src/trusted-process/policy-roots.ts` by mutating the shared global.
 */
export const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(['proxy']);
