/**
 * Interactive LLM-assisted constitution customizer for personas.
 *
 * Adapts the existing constitution-customizer.ts for persona-scoped
 * constitutions. Operates on an in-memory string (not global files)
 * and includes persona context in the LLM prompt.
 *
 * Follows the same pattern as job-customizer.ts in src/cron/.
 */

import * as p from '@clack/prompts';
import type { ModelMessage } from 'ai';
import chalk from 'chalk';
import { getPackageGeneratedDir } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import { loadUserConfig } from '../config/user-config.js';
import { createCacheStrategy } from '../session/prompt-cache.js';
import {
  applyChanges,
  buildSystemPrompt,
  buildUserMessage,
  callLlm,
  computeLineDiff,
  formatDiff,
  loadAnnotations,
  type CustomizerResponse,
} from '../pipeline/constitution-customizer.js';
import { createPipelineLlm } from '../pipeline/pipeline-shared.js';
import { resolveGitHubToken, discoverGitHubIdentity } from '../pipeline/github-identity.js';
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
// Main Customizer Loop
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
  if (!process.stdin.isTTY) {
    p.log.error('Interactive customizer requires a terminal (TTY).');
    return undefined;
  }

  // Load tool annotations
  const generatedDir = getUserGeneratedDir();
  const packageGeneratedDir = getPackageGeneratedDir();
  let annotations: ToolAnnotation[];
  try {
    annotations = loadAnnotations(generatedDir, packageGeneratedDir);
  } catch {
    p.log.error("tool-annotations.json not found. Run 'ironcurtain annotate-tools' first.");
    return undefined;
  }

  // Discover GitHub identity (best-effort)
  const userConfig = loadUserConfig();
  const ghToken = resolveGitHubToken(userConfig.serverCredentials);
  let ghIdentity: GitHubIdentity | null = null;
  if (ghToken) {
    const spinner = p.spinner();
    spinner.start('Discovering GitHub identity...');
    ghIdentity = await discoverGitHubIdentity(ghToken);
    if (ghIdentity) {
      const owners = [ghIdentity.login, ...ghIdentity.orgs].join(', ');
      spinner.stop(`GitHub identity: ${owners}`);
    } else {
      spinner.stop('GitHub identity discovery failed (continuing without it)');
    }
  }

  // Build system prompt with persona context
  const cacheStrategy = createCacheStrategy(userConfig.policyModelId);
  const rawSystemPrompt = buildPersonaCustomizerSystemPrompt(
    '',
    annotations,
    personaDescription,
    serverAllowlist,
    ghIdentity,
  );
  const systemPrompt = cacheStrategy.wrapSystemPrompt(rawSystemPrompt);

  // Set up LLM
  const { model, logContext } = await createPipelineLlm(generatedDir, 'persona-customize-policy');
  logContext.stepName = 'persona-customize-policy';

  let currentConstitution = initialConstitution;
  const conversationHistory: ModelMessage[] = [];

  p.note(currentConstitution.trim(), 'Current Persona Constitution');

  // Main loop
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
  while (true) {
    const userInput = await p.text({
      message: 'How would you like to refine this constitution?',
      placeholder: 'describe what to change, or "done" to finish',
    });

    if (p.isCancel(userInput)) {
      p.cancel('Customization cancelled.');
      return undefined;
    }

    const request = userInput.trim();
    if (request.toLowerCase() === 'done') break;
    if (!request) continue;

    // Build user message and add to conversation
    const userMsg = buildUserMessage(currentConstitution, request);
    conversationHistory.push({ role: 'user', content: userMsg });

    const cachedMessages = cacheStrategy.applyHistoryBreakpoint(conversationHistory);

    // Call LLM
    let response: CustomizerResponse;
    const llmSpinner = p.spinner();
    llmSpinner.start('Thinking...');
    try {
      response = await callLlm(model, systemPrompt, cachedMessages);
      llmSpinner.stop('Done.');
    } catch (err) {
      llmSpinner.stop('Failed.');
      p.log.error(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
      conversationHistory.pop();
      continue;
    }

    conversationHistory.push({ role: 'assistant', content: JSON.stringify(response) });

    if (response.type === 'question') {
      p.log.info(response.question ?? 'Could you clarify your request?');
      continue;
    }

    // Handle changes -- show diff, ask for feedback
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
    while (true) {
      const proposed = applyChanges(currentConstitution, response.addRules ?? [], response.removeRules ?? []);
      const diff = computeLineDiff(currentConstitution, proposed);
      const diffText = formatDiff(diff);
      p.note(`${diffText}\n\n${chalk.dim(response.summary ?? '')}`, 'Proposed changes');

      const action = await p.select({
        message: 'What would you like to do?',
        options: [
          { value: 'accept', label: 'Accept changes' },
          { value: 'refine', label: 'Refine (provide feedback)' },
          { value: 'reject', label: 'Reject changes' },
        ],
      });
      if (p.isCancel(action)) {
        p.cancel('Customization cancelled.');
        return undefined;
      }

      if (action === 'accept') {
        currentConstitution = proposed;
        p.log.success('Changes accepted.');
        break;
      }

      if (action === 'reject') {
        p.log.info('Changes rejected.');
        break;
      }

      // Refine: get follow-up
      const refinement = await p.text({
        message: 'How would you like to refine this?',
        placeholder: 'e.g., "also allow fetching from news sites"',
      });
      if (p.isCancel(refinement)) return undefined;

      const refineMsg = buildUserMessage(currentConstitution, refinement.trim());
      conversationHistory.push({ role: 'user', content: refineMsg });

      const refinedMessages = cacheStrategy.applyHistoryBreakpoint(conversationHistory);

      const refineSpinner = p.spinner();
      refineSpinner.start('Thinking...');
      try {
        response = await callLlm(model, systemPrompt, refinedMessages);
        refineSpinner.stop('Done.');
      } catch (err) {
        refineSpinner.stop('Failed.');
        p.log.error(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
        conversationHistory.pop();
        break;
      }

      conversationHistory.push({ role: 'assistant', content: JSON.stringify(response) });

      if (response.type === 'question') {
        p.log.info(response.question ?? 'Could you clarify your request?');
        break;
      }
    }
  }

  return currentConstitution;
}
