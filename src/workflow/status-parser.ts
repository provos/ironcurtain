import { z } from 'zod';
import type { AgentOutput } from './types.js';
import { CONFIDENCE_VALUES } from './types.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class AgentStatusParseError extends Error {
  readonly rawBlock: string;

  constructor(message: string, rawBlock: string) {
    super(message);
    this.name = 'AgentStatusParseError';
    this.rawBlock = rawBlock;
  }
}

// ---------------------------------------------------------------------------
// Zod schema for parsed YAML values
// ---------------------------------------------------------------------------

const agentOutputSchema = z.object({
  completed: z.boolean(),
  verdict: z.string().min(1),
  confidence: z.enum(CONFIDENCE_VALUES),
  escalation: z.string().nullable(),
  test_count: z.number().int().nullable(),
  notes: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Simple YAML key-value parser (flat structure only)
// ---------------------------------------------------------------------------

/**
 * Parses a flat YAML-like block into key-value pairs.
 * Handles: strings (quoted and unquoted), numbers, booleans, null.
 * Does NOT handle nested structures, arrays, or multi-line values.
 */
function parseSimpleYaml(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = block.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, comments, and the header line
    if (!trimmed || trimmed.startsWith('#') || trimmed === 'agent_status:') {
      continue;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const rawValue = trimmed.slice(colonIndex + 1).trim();

    result[key] = parseYamlValue(rawValue);
  }

  return result;
}

function parseYamlValue(raw: string): unknown {
  // null
  if (raw === 'null' || raw === '~' || raw === '') {
    return null;
  }
  // boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // number
  const num = Number(raw);
  if (!Number.isNaN(num) && raw !== '') {
    return num;
  }
  // unquoted string
  return raw;
}

// ---------------------------------------------------------------------------
// Status block extraction
// ---------------------------------------------------------------------------

/**
 * Regex to find the agent_status YAML block within fenced code blocks.
 * Matches ``` or ~~~ fences with optional language tag.
 */
const STATUS_BLOCK_REGEX = /```[^\n]*\n(agent_status:\n[\s\S]*?)```|~~~[^\n]*\n(agent_status:\n[\s\S]*?)~~~/;

/**
 * Extracts and parses an agent_status YAML block from response text.
 *
 * @returns parsed AgentOutput, or undefined if no status block found
 * @throws {AgentStatusParseError} if block found but malformed
 */
export function parseAgentStatus(responseText: string): AgentOutput | undefined {
  const match = STATUS_BLOCK_REGEX.exec(responseText);
  if (!match) return undefined;

  // One of the two capture groups will match (regex alternation).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const rawBlock = match[1] ?? match[2];
  const parsed = parseSimpleYaml(rawBlock);

  const result = agentOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AgentStatusParseError(`Malformed agent_status block: ${issues}`, rawBlock);
  }

  const data = result.data;
  return {
    completed: data.completed,
    verdict: data.verdict,
    confidence: data.confidence,
    escalation: data.escalation,
    testCount: data.test_count,
    notes: data.notes,
  };
}

// ---------------------------------------------------------------------------
// Re-prompt instructions
// ---------------------------------------------------------------------------

/** Instruction text telling the agent to include a status block. */
export const STATUS_BLOCK_INSTRUCTIONS = `
When you have completed your work, include the following YAML block at the end of your response inside a fenced code block:

\`\`\`
agent_status:
  completed: true
  verdict: approved
  confidence: high
  escalation: null
  test_count: null
  notes: "brief summary of what was done"
\`\`\`

Field descriptions:
- completed: true when work is done, false if blocked
- verdict: a free-form string describing the outcome. Well-known values are approved, rejected, blocked, and spec_flaw. Workflow definitions may specify custom verdict strings for direct routing — use whatever verdict values the workflow prompt instructs.
- confidence: one of high, medium, low
- escalation: null or a string describing what needs human attention
- test_count: null or the number of passing tests
- notes: null or a brief summary
`.trim();

/**
 * Returns the re-prompt message with format instructions.
 * Used when the agent's response is missing the status block.
 */
export function buildStatusBlockReprompt(): string {
  return [
    'Your response is missing the required agent_status block.',
    'Please include it at the end of your response.',
    '',
    STATUS_BLOCK_INSTRUCTIONS,
  ].join('\n');
}
