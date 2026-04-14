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

/** Minimal status instructions for unconditional transitions (no guards, no when clauses). */
export const MINIMAL_STATUS_INSTRUCTIONS = `
When you have completed your work, include the following YAML block at the end of your response inside a fenced code block:

\`\`\`
agent_status:
  verdict: completed
  notes: "brief summary of what was done and key findings for the next agent"
\`\`\`

Fields:
- verdict: a free-form label summarizing your outcome (e.g. completed, needs_revision, inconclusive). It does not affect routing for this state but is logged for diagnostics.
- notes: brief summary passed to the next agent as context
`.trim();

/**
 * Extracts verdict values from `when` clauses that match on the `verdict` key.
 * Returns deduplicated values in definition order.
 */
export function extractVerdictValues(transitions: readonly AgentTransitionDefinition[]): string[] {
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
 * Two modes:
 * - **Verdict-routed**: transitions have `when` clauses keyed on verdict.
 *   Instructions list the valid verdict values and explain they control routing.
 * - **Guard-only**: transitions use only `guard` functions (no `when` clauses).
 *   Verdict is informational — instructions make this clear to avoid confusion.
 *
 * @param transitions - the state's transition definitions
 * @param guardLabels - human-readable labels for named guard conditions
 */
export function buildConditionalStatusInstructions(
  transitions: readonly AgentTransitionDefinition[],
  guardLabels: Readonly<Record<string, string>>,
): string {
  const verdictValues = extractVerdictValues(transitions);

  if (verdictValues.length > 0) {
    return buildVerdictRoutedInstructions(verdictValues, transitions, guardLabels);
  }
  return buildGuardOnlyInstructions(transitions, guardLabels);
}

/** Instructions when verdict values determine routing (has `when` clauses). */
function buildVerdictRoutedInstructions(
  verdictValues: string[],
  transitions: readonly AgentTransitionDefinition[],
  guardLabels: Readonly<Record<string, string>>,
): string {
  const verdictExample = verdictValues[0];
  const verdictList = verdictValues.map((v) => `\`${v}\``).join(', ');

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
    `- verdict: determines what happens next. Set this to exactly one of: ${verdictList}`,
    '- notes: brief summary passed to the next agent as context',
  ];

  appendGuardDescriptions(lines, transitions, guardLabels);
  return lines.join('\n');
}

/** Instructions when routing is guard-only (verdict is informational). */
function buildGuardOnlyInstructions(
  transitions: readonly AgentTransitionDefinition[],
  guardLabels: Readonly<Record<string, string>>,
): string {
  const lines = [
    'When you have completed your work, include the following YAML block at the end of your response inside a fenced code block:',
    '',
    '```',
    'agent_status:',
    '  verdict: completed',
    '  notes: "brief summary of what was done"',
    '```',
    '',
    'Fields:',
    '- verdict: a free-form label summarizing your outcome (e.g. completed, needs_revision, inconclusive). It does not affect routing for this state but is logged for diagnostics.',
    '- notes: brief summary passed to the next agent as context',
  ];

  appendGuardDescriptions(lines, transitions, guardLabels);
  return lines.join('\n');
}

/** Appends guard description lines if any transitions use guards. */
function appendGuardDescriptions(
  lines: string[],
  transitions: readonly AgentTransitionDefinition[],
  guardLabels: Readonly<Record<string, string>>,
): void {
  const guardNames = transitions
    .map((t) => t.guard)
    .filter((g): g is string => g != null)
    .map((g) => guardLabels[g] ?? g);
  if (guardNames.length > 0) {
    lines.push(`\nAutomatic routing conditions (independent of your verdict): ${guardNames.join(', ')}`);
  }
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

// ---------------------------------------------------------------------------
// Verdict validation
// ---------------------------------------------------------------------------

/**
 * Determines whether a state's transitions require verdict validation
 * and, if so, returns the set of valid verdict strings.
 *
 * Validation is skipped (returns `undefined`) when:
 * - No transitions have `when` clauses (pure guard-based or unconditional)
 * - Any transition is unconditional (no `guard` and no `when`), meaning
 *   it acts as a fallthrough that accepts any verdict
 *
 * @returns set of valid verdict strings, or undefined if validation should be skipped
 */
export function getValidVerdicts(transitions: readonly AgentTransitionDefinition[]): ReadonlySet<string> | undefined {
  const hasUnconditional = transitions.some((t) => !t.guard && !t.when);
  if (hasUnconditional) return undefined;

  const verdicts = extractVerdictValues(transitions);
  if (verdicts.length === 0) return undefined;

  return new Set(verdicts);
}

/**
 * Builds the re-prompt message when the agent's verdict doesn't match
 * any valid transition for the current state.
 *
 * @param invalidVerdict - the verdict the agent returned
 * @param transitions - the state's transition definitions (valid verdicts and targets derived from `when` clauses)
 */
export function buildInvalidVerdictReprompt(
  invalidVerdict: string,
  transitions: readonly AgentTransitionDefinition[],
): string {
  const verdictLines = transitions
    .filter((t): t is AgentTransitionDefinition & { when: { verdict: string } } => t.when?.verdict != null)
    .map((t) => `- ${t.when.verdict}: dispatches to ${t.to}`);

  return [
    `Your verdict "${invalidVerdict}" is not a valid routing option for this state.`,
    '',
    'Valid verdicts for this state:',
    ...verdictLines,
    '',
    'Please revise your response and use one of the valid verdicts above.',
  ].join('\n');
}
