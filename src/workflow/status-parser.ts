import YAML from 'yaml';
import { z } from 'zod';
import type { AgentOutput, AgentTransitionDefinition } from './types.js';
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
  // Deprecated fields — defaults maintained for backward compatibility.
  // Workflows should use free-form `verdict` for routing and `notes` for context.
  completed: z.boolean().default(true),
  verdict: z.string().min(1),
  confidence: z.enum(CONFIDENCE_VALUES).default('high'),
  escalation: z.string().nullable().default(null),
  test_count: z.number().int().nullable().default(null),
  notes: z.string().nullable().default(null),
});

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
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawBlock, { maxAliasCount: 0 });
  } catch (err) {
    throw new AgentStatusParseError(
      `YAML parse error in agent_status block: ${err instanceof Error ? err.message : String(err)}`,
      rawBlock,
    );
  }

  // YAML.parse returns { agent_status: { ... } } — unwrap the outer key
  const inner =
    parsed != null && typeof parsed === 'object' && 'agent_status' in parsed
      ? (parsed as Record<string, unknown>).agent_status
      : parsed;

  const result = agentOutputSchema.safeParse(inner);
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
// Status block stripping
// ---------------------------------------------------------------------------

/**
 * Regex matching the entire fenced status block (including fences) at the
 * end of the response. Handles both ``` and ~~~ fences with optional
 * language tag. Anchored to end-of-string with optional trailing whitespace.
 */
const STATUS_BLOCK_FENCE_REGEX = /(?:```[^\n]*\nagent_status:\n[\s\S]*?```|~~~[^\n]*\nagent_status:\n[\s\S]*?~~~)\s*$/;

/**
 * Removes the fenced agent_status block from the end of the response text.
 * The status block is already parsed into AgentOutput by `parseAgentStatus`,
 * so passing it as raw text to the next agent is redundant noise.
 *
 * @returns text with the trailing status block removed and whitespace trimmed
 */
export function stripStatusBlock(responseText: string): string {
  return responseText.replace(STATUS_BLOCK_FENCE_REGEX, '').trimEnd();
}

// ---------------------------------------------------------------------------
// Status block instructions
// ---------------------------------------------------------------------------

/** Minimal status instructions for unconditional transitions. */
export const MINIMAL_STATUS_INSTRUCTIONS = `
When you have completed your work, include the following YAML block at the end of your response inside a fenced code block:

\`\`\`
agent_status:
  verdict: done
  notes: "brief summary of what was done and key findings for the next agent"
\`\`\`

- verdict: a short label for your outcome (e.g. "done", "approved", "rejected")
- notes: a brief summary — this is passed to the next agent as context
`.trim();

/**
 * Extracts verdict values from `when` clauses that match on the `verdict` key.
 * Returns deduplicated values in definition order.
 */
function extractVerdictValues(transitions: readonly AgentTransitionDefinition[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const t of transitions) {
    const v = t.when?.verdict;
    if (typeof v === 'string' && !seen.has(v)) {
      seen.add(v);
      values.push(v);
    }
  }
  return values;
}

/**
 * Builds context-sensitive status block instructions for states with
 * conditional transitions (`when` clauses or `guard` functions).
 *
 * @param transitions - the state's transition definitions
 * @param guardLabels - human-readable labels for named guard conditions
 */
export function buildConditionalStatusInstructions(
  transitions: readonly AgentTransitionDefinition[],
  guardLabels: Readonly<Record<string, string>>,
): string {
  const verdictValues = extractVerdictValues(transitions);
  const verdictExample = verdictValues[0] ?? 'approved';
  const verdictList = verdictValues.length > 0 ? verdictValues.map((v) => `\`${v}\``).join(', ') : '(see prompt)';

  const lines = [
    'When you have completed your work, include the following YAML block at the end of your response inside a fenced code block:',
    '',
    '```',
    'agent_status:',
    `  verdict: ${verdictExample}`,
    '  notes: "brief summary of what was done"',
    '```',
    '',
    'Fields:',
    `- verdict: determines what happens next. Use one of: ${verdictList}`,
    '- notes: brief summary passed to the next agent as context',
  ];

  // Add guard descriptions if any transitions use guards
  const guardNames = transitions
    .map((t) => t.guard)
    .filter((g): g is string => g != null)
    .map((g) => guardLabels[g] ?? g);
  if (guardNames.length > 0) {
    lines.push(`\nAdditional routing conditions are checked automatically: ${guardNames.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Returns the re-prompt message when the agent's response is missing the
 * status block.
 *
 * @param statusInstructions - optional pre-built instructions string (e.g.
 *   from `buildStatusInstructions`). When provided, replaces the default
 *   minimal instructions so that conditional states list the correct verdict
 *   values for routing. When omitted, falls back to `MINIMAL_STATUS_INSTRUCTIONS`.
 */
export function buildStatusBlockReprompt(statusInstructions?: string): string {
  return [
    'Your response is missing the required agent_status block.',
    'Please include it at the end of your response.',
    '',
    statusInstructions ?? MINIMAL_STATUS_INSTRUCTIONS,
  ].join('\n');
}
