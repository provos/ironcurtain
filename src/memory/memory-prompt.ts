/**
 * Re-exports the memory system prompt builder from the memory MCP server package.
 *
 * This thin wrapper centralizes the import so that persona-prompt.ts and
 * session/index.ts don't need to know the package export path.
 */

export { buildMemorySystemPrompt } from '@provos/memory-mcp-server/prompts';

/**
 * Rewrites raw MCP tool names (memory_context, memory_store, …) to the
 * Code Mode namespace-aliased format (memory.context, memory.store, …).
 */
export function adaptMemoryToolNames(prompt: string): string {
  return prompt
    .replaceAll('memory_context', 'memory.context')
    .replaceAll('memory_store', 'memory.store')
    .replaceAll('memory_recall', 'memory.recall')
    .replaceAll('memory_forget', 'memory.forget')
    .replaceAll('memory_inspect', 'memory.inspect');
}
