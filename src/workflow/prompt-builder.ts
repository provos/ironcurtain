import type {
  AgentStateDefinition,
  AgentTransitionDefinition,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowStateDefinition,
} from './types.js';
import { WORKFLOW_ARTIFACT_DIR } from './types.js';
import { MINIMAL_STATUS_INSTRUCTIONS, buildConditionalStatusInstructions } from './status-parser.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assembles the command string sent to an agent session.
 *
 * Two modes:
 * - **First visit**: Full prompt with workflow context, previous agent
 *   output, artifact path references, role instructions, expected outputs,
 *   and status format. Used when entering a state for the first time.
 * - **Re-visit**: Abbreviated prompt with only what's new: previous agent
 *   output, round number, human feedback, and status format. The agent
 *   already has role instructions and task context via --continue.
 *
 * No file I/O is performed. The agent reads artifact content itself
 * using its filesystem tools.
 */
export function buildAgentCommand(
  stateId: string,
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  definition: WorkflowDefinition,
): string {
  const isReVisit = !stateConfig.freshSession && (context.visitCounts[stateId] ?? 0) > 1;
  if (isReVisit) {
    return buildReVisitPrompt(stateId, stateConfig, context);
  }
  return buildFirstVisitPrompt(stateConfig, context, definition);
}

// ---------------------------------------------------------------------------
// First-visit prompt
// ---------------------------------------------------------------------------

/**
 * Full prompt for the first time an agent state is entered.
 *
 * Uses one universal layout for ALL agents (workers and orchestrators alike):
 * 1. Workflow Context — task as quoted context
 * 2. Previous agent output (if any)
 * 3. Input artifacts
 * 4. Your Role — the role prompt (last substantive instruction for recency bias)
 * 5. Expected outputs
 * 6. Human feedback (if any)
 * 7. Handoff clause
 * 8. Status block instructions
 */
function buildFirstVisitPrompt(
  stateConfig: AgentStateDefinition,
  context: WorkflowContext,
  definition: WorkflowDefinition,
): string {
  const sections: string[] = [];

  // 1. Workflow context with task description as quoted text
  sections.push(
    '## Workflow Context\n\n' +
      'You are one agent in a multi-agent workflow. The overall workflow goal is:\n\n' +
      `> ${context.taskDescription}\n\n` +
      'Your specific role and instructions follow below. Focus on YOUR assigned responsibilities, not the overall goal.',
  );

  // 2. Previous agent's output
  if (context.previousAgentOutput && context.previousStateName) {
    sections.push(
      `## Output from ${context.previousStateName}\n\n` +
        `The ${context.previousStateName} agent produced the following output:\n\n` +
        context.previousAgentOutput,
    );
  }

  // 3. Input artifacts as path references (not content)
  appendInputArtifacts(sections, stateConfig.inputs);

  // 4. Role prompt (last substantive instruction for recency bias)
  sections.push(`## Your Role\n\n${stateConfig.prompt}`);

  // 5. Expected outputs
  appendExpectedOutputs(sections, stateConfig.outputs);

  // 6. Human feedback from gate
  if (context.humanPrompt) {
    sections.push(`## Human Feedback\n\n${context.humanPrompt}`);
  }

  // 7. Handoff clause (before status block, which must be last)
  const handoff = buildHandoffClause(stateConfig.transitions, definition);
  if (handoff) {
    sections.push(handoff);
  }

  // 8. Status block instructions (always last)
  sections.push(buildStatusInstructions(stateConfig.transitions));

  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Shared section helpers
// ---------------------------------------------------------------------------

/** Appends input artifact path reference sections. */
function appendInputArtifacts(sections: string[], inputs: readonly string[]): void {
  for (const inputRef of inputs) {
    const isOptional = inputRef.endsWith('?');
    const name = isOptional ? inputRef.slice(0, -1) : inputRef;
    const instruction = isOptional
      ? `Read the contents of the \`${WORKFLOW_ARTIFACT_DIR}/${name}/\` directory in your workspace if it exists. This input is optional — skip it if the directory is not present.`
      : `Read the contents of the \`${WORKFLOW_ARTIFACT_DIR}/${name}/\` directory in your workspace using your file reading tools.`;
    sections.push(`## Input: ${name}\n\n${instruction}`);
  }
}

/** Appends expected outputs section if there are any outputs. */
function appendExpectedOutputs(sections: string[], outputs: readonly string[]): void {
  if (outputs.length > 0) {
    const outputList = outputs.map((o) => `- \`${WORKFLOW_ARTIFACT_DIR}/${o}/\``).join('\n');
    sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);
  }
}

// ---------------------------------------------------------------------------
// Re-visit prompt (same-state re-invocation)
// ---------------------------------------------------------------------------

/**
 * Abbreviated prompt for re-entering a previously visited state.
 * The agent already has role instructions and task context in its
 * conversation history via --continue. Only new information is sent.
 */
function buildReVisitPrompt(stateId: string, stateConfig: AgentStateDefinition, context: WorkflowContext): string {
  const sections: string[] = [];

  // 1. What's new: previous agent's output
  if (context.previousAgentOutput && context.previousStateName) {
    sections.push(
      `## New Input from ${context.previousStateName}\n\n` +
        `The ${context.previousStateName} agent reviewed your work and ` +
        `produced the following output:\n\n` +
        context.previousAgentOutput,
    );
  }

  // 2. Round number (per-state count, not global)
  const stateRound = context.visitCounts[stateId] ?? 1;
  sections.push(
    `## Round\n\nThis is round ${stateRound} ` +
      `of ${context.maxRounds}. ` +
      `Please address the feedback above and update your outputs.`,
  );

  // 3. Human feedback from gate
  if (context.humanPrompt) {
    sections.push(`## Human Feedback\n\n${context.humanPrompt}`);
  }

  // 4. Status block instructions (state-specific for conditional transitions)
  sections.push(buildStatusInstructions(stateConfig.transitions));

  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Status instruction selection
// ---------------------------------------------------------------------------

/** Human-readable labels for named guard conditions. */
export const GUARD_LABELS: Record<string, string> = {
  isRoundLimitReached: 'round limit reached',
  isStalled: 'stall detected',
  isApproved: 'approved',
  isRejected: 'rejected',
  isPassed: 'all checks passed',
};

/**
 * Selects the appropriate status block instructions for a state's transitions.
 *
 * - Unconditional transitions (no `when`, no `guard`) get minimal instructions.
 * - Conditional transitions get instructions with extracted verdict values.
 */
export function buildStatusInstructions(transitions: readonly AgentTransitionDefinition[]): string {
  const hasConditional = transitions.some((t) => t.when != null || t.guard != null);
  if (!hasConditional) {
    return MINIMAL_STATUS_INSTRUCTIONS;
  }
  return buildConditionalStatusInstructions(transitions, GUARD_LABELS);
}

// ---------------------------------------------------------------------------
// Handoff clause
// ---------------------------------------------------------------------------

/**
 * Builds the "What happens with your output" section for first-visit prompts.
 * Returns `undefined` when there are no transitions to describe.
 */
export function buildHandoffClause(
  transitions: readonly AgentTransitionDefinition[],
  definition: WorkflowDefinition,
): string | undefined {
  if (transitions.length === 0) return undefined;

  const lines = transitions.map((t) => {
    const condition = formatTransitionCondition(t);
    const desc = (definition.states[t.to] as WorkflowStateDefinition | undefined)?.description ?? t.to;
    return `- ${condition} \u2192 ${t.to} (${desc})`;
  });

  return (
    '## What happens with your output\n\n' +
    'The next step depends on the transition conditions below:\n' +
    lines.join('\n')
  );
}

/** Formats the condition portion of a transition line. */
function formatTransitionCondition(transition: AgentTransitionDefinition): string {
  if (transition.when) {
    const pairs = Object.entries(transition.when).map(([k, v]) => `${k}=${String(v)}`);
    return pairs.join(', ');
  }
  if (transition.guard) {
    const label = GUARD_LABELS[transition.guard] ?? transition.guard;
    return label;
  }
  return '(default)';
}

// ---------------------------------------------------------------------------
// Artifact re-prompt
// ---------------------------------------------------------------------------

/**
 * Builds a re-prompt for missing artifacts. Uses relative paths only
 * (no host-absolute paths, since Docker agents see /workspace).
 *
 * @param missing - artifact names that were not created
 * @param transitions - optional state transitions; when provided, status
 *   instructions include the correct verdict values for conditional routing
 */
export function buildArtifactReprompt(
  missing: readonly string[],
  transitions?: readonly AgentTransitionDefinition[],
): string {
  const paths = missing.map((name) => `  - \`${WORKFLOW_ARTIFACT_DIR}/${name}/\``);
  const statusInstructions = transitions ? buildStatusInstructions(transitions) : MINIMAL_STATUS_INSTRUCTIONS;
  return (
    'The following required output artifacts were not created in your workspace:\n' +
    paths.join('\n') +
    '\n\nPlease create them now. Each artifact should be a ' +
    'directory containing at least one file.\n\n' +
    statusInstructions
  );
}
