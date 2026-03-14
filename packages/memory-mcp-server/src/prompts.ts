/**
 * Exportable system prompts and tool descriptions for integrating the memory
 * MCP server with LLM agents and application loops.
 *
 * Usage:
 *   import { MEMORY_SYSTEM_PROMPT } from '@provos/memory-mcp-server/prompts';
 *   // or
 *   import { buildMemorySystemPrompt } from '@provos/memory-mcp-server/prompts';
 */

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Default system prompt block that instructs an LLM agent how and when to use
 * the memory tools. Append this to your agent's system prompt.
 *
 * Derived from `buildMemorySystemPrompt()` with no options to ensure the
 * static constant and the builder always produce identical output.
 */
export const MEMORY_SYSTEM_PROMPT = buildMemorySystemPrompt();

// ---------------------------------------------------------------------------
// Configurable prompt builder
// ---------------------------------------------------------------------------

export interface MemoryPromptOptions {
  /** Name for the persona or agent. Included in the heading if provided. */
  persona?: string;
  /** Additional instructions appended after the default prompt. */
  additionalInstructions?: string;
  /** Override the default session-start instruction. */
  sessionStartInstruction?: string;
}

/**
 * Build a customized memory system prompt. Useful when you need to tailor
 * the instructions for a specific persona or use case.
 *
 * @example
 * ```ts
 * const prompt = buildMemorySystemPrompt({
 *   persona: 'Research Assistant',
 *   additionalInstructions: 'Always tag paper references with "paper:<title>".',
 * });
 * ```
 */
export function buildMemorySystemPrompt(options: MemoryPromptOptions = {}): string {
  const sections: string[] = [];

  // Heading
  if (options.persona) {
    sections.push(`## Persistent Memory — ${options.persona}`);
  } else {
    sections.push('## Persistent Memory');
  }

  sections.push('');
  sections.push(
    'You have access to a persistent memory system that survives across sessions.',
    'Use it proactively — do not wait to be asked.',
    '',
    'IMPORTANT: Do NOT use any built-in memory system (auto memory, MEMORY.md,',
    'or similar). Your local state does not persist across sessions. Only the',
    'MCP memory tools described here provide durable cross-session memory.',
  );

  // Session start
  sections.push('');
  sections.push('### Session Start — MANDATORY');
  if (options.sessionStartInstruction) {
    sections.push(options.sessionStartInstruction);
  } else {
    sections.push(
      'Your FIRST action in every session MUST be to call `memory_context` before',
      'responding to the user. This retrieves a briefing of relevant prior context.',
      'Provide a brief description of the current task for more targeted results.',
      'If no task is known yet, call it with no arguments.',
      '',
      'Do this even for simple requests — prior context may change how you respond.',
    );
  }

  // Store
  sections.push('');
  sections.push('### When to Store (`memory_store`)');
  sections.push(
    'Store information proactively whenever the user shares or you learn:',
    '- Personal facts, preferences, or stated goals',
    '- Project decisions, conventions, or architecture choices',
    '- Important events, deadlines, or milestones',
    '- People, roles, and relationships',
    '- Errors encountered and how they were resolved',
    '- Anything the user explicitly asks you to remember',
    '',
    'Guidelines:',
    '- Keep memories **atomic** — one fact per call.',
    '- Use descriptive tags (e.g., "preference", "project:foo", "person:alice").',
    '- Set importance > 0.7 for critical facts (deadlines, credentials, hard rules).',
    '- If unsure whether to store something, store it — the system handles dedup.',
    '- Do not mention the memory system to the user unless they ask about it.',
  );

  // Recall
  sections.push('');
  sections.push('### When to Recall (`memory_recall`)');
  sections.push(
    '- When the user asks about something discussed in a prior session.',
    '- When you need context that might already be stored (e.g., preferences,',
    '  project details, prior decisions).',
    '- Before making a recommendation that could conflict with stored preferences.',
  );

  // Forget
  sections.push('');
  sections.push('### When to Forget (`memory_forget`)');
  sections.push(
    '- When the user explicitly asks you to forget something.',
    '- When information is confirmed to be outdated or incorrect.',
    '- Always use `dry_run: true` first to preview what would be deleted.',
  );

  // Additional instructions
  if (options.additionalInstructions) {
    sections.push('');
    sections.push('### Additional Guidelines');
    sections.push(options.additionalInstructions);
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Tool descriptions (matching server.ts registration)
// ---------------------------------------------------------------------------

/**
 * Enhanced tool descriptions that include behavioral cues. These can be used
 * when registering tools in custom MCP server setups or for documentation.
 */
export const TOOL_DESCRIPTIONS = {
  memory_store:
    'Store a memory for later retrieval. Memories are automatically embedded for semantic search ' +
    'and deduplicated. Use this PROACTIVELY whenever the user shares facts, preferences, ' +
    'decisions, or anything worth remembering across sessions. Store atomic facts — one idea per memory.',

  memory_recall:
    'Recall memories relevant to a query. Returns a pre-summarized context block optimized ' +
    'for your context window. Uses hybrid semantic + keyword search. Use format="answer" to get ' +
    'a direct answer to a question from stored memories. Use this when you need ' +
    'context from prior sessions or before making recommendations that might conflict with stored preferences.',

  memory_context:
    'Get a session briefing of relevant memories. Call this FIRST at the beginning of every ' +
    'new session or conversation to load prior context. Provide a brief task description ' +
    'for more targeted results.',

  memory_forget:
    'Forget specific memories by ID, tag, or query match. Use dry_run first to preview. ' +
    'Only forget when the user explicitly asks or when information is confirmed incorrect.',

  memory_inspect:
    'View memory statistics, recent memories, important memories, tag frequency, or export all data. ' +
    'Useful for debugging or understanding what the memory system knows.',
} as const;
