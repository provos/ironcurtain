/**
 * Server names reserved for internal use that cannot be used in
 * mcp-servers.json. These are virtual MCP servers registered in-process
 * (e.g., the proxy domain-management tools) rather than spawned from
 * `mcp-servers.json`.
 */
export const RESERVED_SERVER_NAMES = new Set(['proxy']);
