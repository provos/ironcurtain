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

interface FencedBlock {
  readonly rawBlock: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Scans discrete Markdown fences. Closing fences may be longer than their
 * opener, per CommonMark, and CRLF offsets are preserved for exact stripping.
 */
function findFencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { readonly marker: string; readonly start: number; readonly contentStart: number } | undefined;

  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline + 1;
    let contentEnd = newline === -1 ? end : newline;
    if (contentEnd > start && text[contentEnd - 1] === '\r') contentEnd--;
    const content = text.slice(start, contentEnd);

    if (open) {
      const closing = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/.exec(content);
      if (closing && closing[1][0] === open.marker[0] && closing[1].length >= open.marker.length) {
        blocks.push({
          rawBlock: text.slice(open.contentStart, start),
          start: open.start,
          end,
        });
        open = undefined;
      }
    } else {
      const opening = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(content);
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        open = { marker: opening[1], start, contentStart: end };
      }
    }
    start = end;
  }
  return blocks;
}

function isStatusFence(fence: FencedBlock): boolean {
  return /^agent_status:(?:\r?\n|$)/.test(fence.rawBlock);
}

function extractFinalStatusFence(responseText: string): FencedBlock | undefined {
  const finalFence = findFencedBlocks(responseText).at(-1);
  if (!finalFence || !isStatusFence(finalFence)) return undefined;
  return /^\s*$/.test(responseText.slice(finalFence.end)) ? finalFence : undefined;
}

/**
 * Extracts and parses an agent_status YAML block from response text.
 *
 * @returns parsed AgentOutput, or undefined if no status block found
 * @throws {AgentStatusParseError} if block found but malformed
 */
export function parseAgentStatus(responseText: string): AgentOutput | undefined {
  const fence = extractFinalStatusFence(responseText);
  if (!fence) return undefined;

  const { rawBlock } = fence;
  let parsed: unknown;
  try {
    parsed = YAML.parse(rawBlock, { maxAliasCount: 0 });
  } catch (err) {
    throw new AgentStatusParseError(
      `YAML parse error in agent_status block: ${err instanceof Error ? err.message : String(err)}`,
      rawBlock,
    );
  }

  // YAML.parse returns { agent_status: { ... } } — unwrap the outer key.
  //
  // Tolerate the common flush-left misformat where the agent leaves
  // `agent_status:` empty and emits `verdict`/`notes` as siblings at the same
  // indentation, so YAML parses the block as { agent_status: null, verdict,
  // notes }. When the nested value is empty (null/undefined) but a sibling
  // `verdict` is present, fall back to the parent object — the schema is
  // non-strict, so the leftover `agent_status: null` key is ignored. Blocks
  // with no `verdict` anywhere remain malformed (irrecoverable).
  let inner: unknown = parsed;
  if (parsed != null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    // Object.hasOwn (not `in`): agent-supplied YAML is untrusted, so check own
    // properties only and avoid the prototype chain / prototype-pollution edge cases.
    if (Object.hasOwn(obj, 'agent_status')) {
      const nested = obj.agent_status;
      inner = nested != null && typeof nested === 'object' ? nested : Object.hasOwn(obj, 'verdict') ? obj : nested;
    }
  }

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
 * Removes the fenced agent_status block from the end of the response text.
 * The status block is already parsed into AgentOutput by `parseAgentStatus`,
 * so passing it as raw text to the next agent is redundant noise.
 *
 * @returns text with the trailing status block removed and whitespace trimmed
 */
export function stripStatusBlock(responseText: string): string {
  const fence = extractFinalStatusFence(responseText);
  return fence ? responseText.slice(0, fence.start).trimEnd() : responseText;
}

/** Removes every discrete agent_status fence while retaining surrounding prose. */
export function stripAgentStatusFences(responseText: string): string {
  const statusFences = findFencedBlocks(responseText).filter(isStatusFence);
  if (statusFences.length === 0) return responseText;

  const parts: string[] = [];
  let cursor = 0;
  for (const fence of statusFences) {
    parts.push(responseText.slice(cursor, fence.start));
    cursor = fence.end;
  }
  parts.push(responseText.slice(cursor));
  return parts.join('').trimEnd();
}

// ---------------------------------------------------------------------------
// Status block instructions
// ---------------------------------------------------------------------------

/** Base informational status block lines (verdict does not affect routing). */
const INFORMATIONAL_STATUS_LINES: readonly string[] = [
  'When all your work is finished and you are ready to exit, include the following YAML block as the LAST content of your FINAL response, inside a fenced code block. Do not run any further tool calls after emitting it:',
  '',
  '```',
  'agent_status:',
  '  verdict: completed',
  '  notes: "brief summary of what was done"',
  '```',
  '',
  'Only the agent_status block in your final response is parsed. Blocks emitted earlier (e.g. as progress checkpoints) are ignored — do not use this block to "check in" mid-task.',
  '',
  'Use EXACTLY these field names (`verdict`, `notes`). Do NOT add additional fields, rename fields, or use synonyms (e.g. `status`, `result`, `scope`, `artifacts`) — any deviation is a hard error and will force the workflow to reject your response. If you want to include more context, put it in the `notes` string.',
  '',
  'Fields:',
  '- verdict: a free-form label summarizing your outcome (e.g. completed, needs_revision, inconclusive). It does not affect routing for this state but is logged for diagnostics.',
  '- notes: brief summary passed to the next agent as context',
];

/** Minimal status instructions for unconditional transitions (no guards, no when clauses). */
export const MINIMAL_STATUS_INSTRUCTIONS = INFORMATIONAL_STATUS_LINES.join('\n');

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
    'When all your work is finished and you are ready to exit, include the following YAML block as the LAST content of your FINAL response, inside a fenced code block. Do not run any further tool calls after emitting it:',
    '',
    '```',
    'agent_status:',
    `  verdict: ${verdictExample}`,
    '  notes: "brief summary of what was done"',
    '```',
    '',
    'Only the agent_status block in your final response is parsed. Blocks emitted earlier (e.g. as progress checkpoints) are ignored — do not use this block to "check in" mid-task.',
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
  const lines = [...INFORMATIONAL_STATUS_LINES];
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
    lines.push(`\nAutomatic routing conditions (evaluated separately from your verdict): ${guardNames.join(', ')}`);
  }
}

/**
 * Returns the re-prompt message when the agent's response is missing or
 * malformed. Passing `parseError` switches the wording to the malformed-block
 * form and includes the validation detail. Passing `statusInstructions`
 * overrides the default template (e.g. to list state-specific verdicts).
 */
export function buildStatusBlockReprompt(statusInstructions?: string, parseError?: AgentStatusParseError): string {
  const header = parseError
    ? [
        'Your previous response had a malformed `agent_status` block and could not be parsed.',
        `Parse error: ${parseError.message}`,
        '',
        'Emit a new block as the LAST content of your FINAL response, after all work is complete and before you exit. Use exactly the fields shown below.',
      ]
    : [
        'Your final response did not include the required agent_status block.',
        '',
        'The block must be the LAST content of your FINAL response — emitted after all work is complete and immediately before you exit. Only the closing block of your final message is parsed; any agent_status blocks you may have emitted earlier in this conversation are ignored.',
        '',
        'If your work is finished: stop calling tools and emit a single final message ending with the YAML block below. If you still have work to do, complete it first, then emit the block as your closing content.',
      ];

  return [...header, '', statusInstructions ?? MINIMAL_STATUS_INSTRUCTIONS].join('\n');
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
    '',
    'Include the required `agent_status` YAML block with your chosen verdict in your revised response.',
  ].join('\n');
}
