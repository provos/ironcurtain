/**
 * Builds CLAUDE.md content to seed into the Docker container's ~/.claude/
 * directory for Claude Code sessions.
 *
 * Claude Code reads ~/.claude/CLAUDE.md as user-level instructions with
 * high priority. The --append-system-prompt content gets drowned out by
 * Claude Code's own system prompt, so memory behavioral rules need to
 * live here to be effective.
 *
 * This prompt is intentionally concise and action-oriented — it competes
 * with Claude Code's own lengthy system prompt for attention. The full
 * detailed memory prompt (buildMemorySystemPrompt) is used on the
 * --append-system-prompt surface for the builtin agent and Goose.
 *
 * Only Claude Code Docker sessions need this -- the builtin agent has
 * the system prompt as its sole authoritative source, and Goose uses
 * --instructions.
 */

/**
 * Builds condensed CLAUDE.md content with memory behavioral rules.
 *
 * Returns undefined when memory is disabled (no file should be written).
 */
export function buildDockerClaudeMd(opts: { personaName?: string; memoryEnabled: boolean }): string | undefined {
  if (!opts.memoryEnabled) return undefined;

  const sections: string[] = [];

  if (opts.personaName) {
    sections.push(`You are operating as the "${opts.personaName}" persona.`, '');
  }

  sections.push(`# Pre-response protocol

Before responding to any user message, call the \`memory_context\` MCP tool.
Do not skip this step. Do not respond first and call it later.

After receiving the memory_context result, respond to the user normally.

Store new facts via \`memory_store\` as you learn them. Do not use built-in
memory (auto memory, MEMORY.md) — only MCP memory tools persist.`);

  return sections.join('\n');
}
