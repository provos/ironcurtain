/**
 * Interactive LLM-assisted constitution customizer for cron jobs.
 *
 * Thin wrapper around the shared customizer loop, adding
 * task-specific context to the LLM system prompt.
 */

import { buildSystemPrompt } from '../pipeline/constitution-customizer.js';
import { runConstitutionCustomizerLoop, type CustomizerLoopContext } from '../pipeline/customizer-loop.js';
import type { GitHubIdentity } from '../pipeline/github-identity.js';
import type { ToolAnnotation } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Job-Scoped System Prompt
// ---------------------------------------------------------------------------

/**
 * Builds a system prompt for the job constitution customizer.
 * Extends the base customizer prompt with task-specific context.
 */
export function buildJobCustomizerSystemPrompt(
  baseConstitution: string,
  toolAnnotations: ToolAnnotation[],
  taskDescription: string,
  githubIdentity?: GitHubIdentity | null,
): string {
  const basePrompt = buildSystemPrompt(baseConstitution, toolAnnotations, githubIdentity);

  return `${basePrompt}

## Task Context

This constitution is for a scheduled job with the following task:

${taskDescription}

Focus your suggestions on what THIS SPECIFIC TASK needs. Do not suggest
broad permissions unless the task requires them.`;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Runs an interactive constitution customizer session for a job.
 * Operates on an in-memory constitution string (not the global file).
 *
 * @param initialConstitution - Starting constitution text (from generator or existing job)
 * @param taskDescription - The task description (context for the LLM)
 * @returns The final constitution text, or undefined if the user cancelled
 */
export async function runJobConstitutionCustomizer(
  initialConstitution: string,
  taskDescription: string,
): Promise<string | undefined> {
  return runConstitutionCustomizerLoop(
    initialConstitution,
    (ctx: CustomizerLoopContext) =>
      buildJobCustomizerSystemPrompt('', ctx.annotations, taskDescription, ctx.githubIdentity),
    {
      stepName: 'job-customize-policy',
      noteTitle: 'Current Job Constitution',
      refinePlaceholder: 'e.g., "also allow git push to origin"',
    },
  );
}
