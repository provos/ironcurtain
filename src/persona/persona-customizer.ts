/**
 * Interactive LLM-assisted constitution customizer for personas.
 *
 * Thin wrapper around the shared customizer loop, adding
 * persona-specific context to the LLM system prompt.
 */

import { buildSystemPrompt } from '../pipeline/constitution-customizer.js';
import { runConstitutionCustomizerLoop, type CustomizerLoopContext } from '../pipeline/customizer-loop.js';
import type { GitHubIdentity } from '../pipeline/github-identity.js';
import type { ToolAnnotation } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Persona-Scoped System Prompt
// ---------------------------------------------------------------------------

/**
 * Builds a system prompt for the persona constitution customizer.
 * Extends the base customizer prompt with persona-specific context.
 */
export function buildPersonaCustomizerSystemPrompt(
  baseConstitution: string,
  toolAnnotations: ToolAnnotation[],
  personaDescription: string,
  serverAllowlist?: readonly string[],
  githubIdentity?: GitHubIdentity | null,
): string {
  const basePrompt = buildSystemPrompt(baseConstitution, toolAnnotations, githubIdentity);

  const serverContext = serverAllowlist
    ? `\nThis persona only has access to these MCP servers: ${serverAllowlist.join(', ')}.`
    : '';

  return `${basePrompt}

## Persona Context

This constitution is for a persona with the following purpose:

${personaDescription}
${serverContext}

Focus your suggestions on what this persona needs. Grant the minimum
permissions required for the persona's purpose.`;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Runs an interactive constitution customizer session for a persona.
 * Operates on an in-memory constitution string (not the global file).
 *
 * @param initialConstitution - Starting constitution text (from generator or existing)
 * @param personaDescription - The persona description (context for the LLM)
 * @param serverAllowlist - Optional server allowlist (context for the LLM)
 * @returns The final constitution text, or undefined if the user cancelled
 */
export async function runPersonaConstitutionCustomizer(
  initialConstitution: string,
  personaDescription: string,
  serverAllowlist?: readonly string[],
): Promise<string | undefined> {
  return runConstitutionCustomizerLoop(
    initialConstitution,
    (ctx: CustomizerLoopContext) =>
      buildPersonaCustomizerSystemPrompt('', ctx.annotations, personaDescription, serverAllowlist, ctx.githubIdentity),
    {
      stepName: 'persona-customize-policy',
      noteTitle: 'Current Persona Constitution',
      refinePlaceholder: 'e.g., "also allow fetching from news sites"',
    },
  );
}
