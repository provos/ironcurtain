/**
 * Re-exports the memory system prompt builder from the memory MCP server package.
 *
 * This thin wrapper centralizes the import so that persona-prompt.ts and
 * session/index.ts don't need to know the package export path.
 */

export { buildMemorySystemPrompt } from '@provos/memory-mcp-server/prompts';
