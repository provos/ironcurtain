import type { AgentStateDefinition, WorkflowContext } from './types.js';
import { STATUS_BLOCK_INSTRUCTIONS } from './status-parser.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assembles the command string sent to an agent session.
 *
 * Two modes:
 * - **First visit**: Full prompt with role instructions, task, previous
 *   agent output, artifact path references, expected outputs, and status
 *   format. Used when entering a state for the first time.
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
): string {
  const isReVisit = (context.visitCounts[stateId] ?? 0) > 1;
  if (isReVisit) {
    return buildReVisitPrompt(stateId, context);
  }
  return buildFirstVisitPrompt(stateConfig, context);
}

// ---------------------------------------------------------------------------
// First-visit prompt (cross-state transition)
// ---------------------------------------------------------------------------

/**
 * Full prompt for the first time an agent state is entered.
 * Includes role instructions, task, previous agent output, artifact
 * references, expected outputs, human feedback, and status format.
 */
function buildFirstVisitPrompt(stateConfig: AgentStateDefinition, context: WorkflowContext): string {
  const sections: string[] = [];

  // 1. Role instructions from workflow definition
  sections.push(stateConfig.prompt);

  // 2. Task description
  sections.push(`## Task\n\n${context.taskDescription}`);

  // 3. Previous agent's output
  if (context.previousAgentOutput && context.previousStateName) {
    sections.push(
      `## Output from ${context.previousStateName}\n\n` +
        `The ${context.previousStateName} agent produced the following output:\n\n` +
        context.previousAgentOutput,
    );
  }

  // 4. Input artifacts as path references (not content)
  for (const inputRef of stateConfig.inputs) {
    const isOptional = inputRef.endsWith('?');
    const name = isOptional ? inputRef.slice(0, -1) : inputRef;
    sections.push(
      `## Input: ${name}\n\n` +
        `Read the contents of the \`${name}/\` directory ` +
        `in your workspace using your file reading tools.`,
    );
  }

  // 5. Expected outputs
  if (stateConfig.outputs.length > 0) {
    const outputList = stateConfig.outputs.map((o) => `- \`${o}/\``).join('\n');
    sections.push(`## Expected Outputs\n\nCreate the following artifact directories in your workspace:\n${outputList}`);
  }

  // 6. Human feedback from gate
  if (context.humanPrompt) {
    sections.push(`## Human Feedback\n\n${context.humanPrompt}`);
  }

  // 7. Status block instructions (always last)
  sections.push(STATUS_BLOCK_INSTRUCTIONS);

  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Re-visit prompt (same-state re-invocation)
// ---------------------------------------------------------------------------

/**
 * Abbreviated prompt for re-entering a previously visited state.
 * The agent already has role instructions and task context in its
 * conversation history via --continue. Only new information is sent.
 */
function buildReVisitPrompt(stateId: string, context: WorkflowContext): string {
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

  // 4. Status block instructions (always last)
  sections.push(STATUS_BLOCK_INSTRUCTIONS);

  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Artifact re-prompt (unchanged)
// ---------------------------------------------------------------------------

/**
 * Builds a re-prompt for missing artifacts. Uses relative paths only
 * (no host-absolute paths, since Docker agents see /workspace).
 */
export function buildArtifactReprompt(missing: readonly string[]): string {
  const paths = missing.map((name) => `  - \`${name}/\``);
  return (
    'The following required output artifacts were not created in your workspace:\n' +
    paths.join('\n') +
    '\n\nPlease create them now. Each artifact should be a ' +
    'directory containing at least one file.\n\n' +
    STATUS_BLOCK_INSTRUCTIONS
  );
}
