/**
 * LLM-assisted conversational constitution customizer.
 *
 * Helps users describe tasks and purposes in natural language, then
 * translates them into concrete policy statements via an LLM. Uses
 * a conversational loop with accept/refine/reject feedback.
 *
 * CLI entry point: `ironcurtain customize-policy`
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import type { LanguageModel, ModelMessage, SystemModelMessage } from 'ai';
import { generateText, Output } from 'ai';
import chalk from 'chalk';
import { z } from 'zod';
import { getBaseUserConstitutionPath, getUserConstitutionPath, getUserGeneratedDir } from '../config/paths.js';
import { loadUserConfig } from '../config/user-config.js';
import { createCacheStrategy } from '../session/prompt-cache.js';
import { createPipelineLlm, loadExistingArtifact } from './pipeline-shared.js';
import type { ToolAnnotation, ToolAnnotationsFile } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Structured Output Schema
// ---------------------------------------------------------------------------

export const CustomizerResponseSchema = z.object({
  type: z.enum(['changes', 'question']).describe('Whether this proposes changes or asks a clarifying question'),
  addRules: z.array(z.string()).optional().describe('New policy statements to append (when type is "changes")'),
  removeRules: z
    .array(z.string())
    .optional()
    .describe('Existing policy statements to remove — must match existing lines exactly (when type is "changes")'),
  summary: z
    .string()
    .optional()
    .describe(
      'Brief summary of what changed and why, including any permissions already covered (when type is "changes")',
    ),
  question: z.string().optional().describe('A clarifying question to ask the user (when type is "question")'),
});

export type CustomizerResponse = z.infer<typeof CustomizerResponseSchema>;

/**
 * Merges LLM-proposed changes into the current constitution text.
 * Removes lines matching `removeRules`, then appends `addRules`.
 */
export function applyChanges(current: string, addRules: string[], removeRules: string[]): string {
  let lines = current.split('\n');

  // Remove lines that match removeRules (normalized comparison: strip
  // leading whitespace, bullet prefixes like "- " or "* ", and trailing space)
  if (removeRules.length > 0) {
    const normalize = (s: string) => s.trim().replace(/^[-*]\s*/, '');
    const removals = new Set(removeRules.map(normalize));
    lines = lines.filter((line) => !removals.has(normalize(line)));
  }

  // Remove trailing blank lines before appending
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // Append new rules
  for (const rule of addRules) {
    lines.push(` - ${rule}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tool Annotation Formatting
// ---------------------------------------------------------------------------

/** Max bytes for the formatted annotation section before we truncate. */
const ANNOTATION_SIZE_LIMIT = 8192;

/**
 * Formats tool annotations into a compact prompt-friendly summary.
 * Each tool gets its name, a one-line description, and the argument
 * roles that matter for policy (non-none roles).
 */
export function formatAnnotationsForPrompt(annotations: ToolAnnotation[]): string {
  const lines: string[] = [];

  for (const ann of annotations) {
    const argEntries = Object.entries(ann.args).filter(
      ([, roles]) => roles.length > 0 && !roles.every((r) => r === 'none'),
    );

    let line = `- **${ann.serverName}/${ann.toolName}**: ${ann.comment}`;
    if (argEntries.length > 0) {
      const argParts = argEntries.map(([name, roles]) => `${name} (${roles.join(', ')})`);
      line += `\n  Args: ${argParts.join('; ')}`;
    }
    lines.push(line);
  }

  const result = lines.join('\n');

  // If the output is too large, summarize by omitting argument details
  if (Buffer.byteLength(result, 'utf-8') > ANNOTATION_SIZE_LIMIT) {
    return annotations.map((ann) => `- **${ann.serverName}/${ann.toolName}**: ${ann.comment}`).join('\n');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt Construction
// ---------------------------------------------------------------------------

export function buildSystemPrompt(baseConstitution: string, toolAnnotations: ToolAnnotation[]): string {
  return `You are helping a user customize their IronCurtain security policy.

The user will describe tasks and purposes they want their agent to perform.
Your job is to infer the specific permissions needed and generate precise,
enforceable policy statements.

## Base Constitution (read-only, cannot be modified)
${baseConstitution}

## Available Tools and Their Capabilities
${formatAnnotationsForPrompt(toolAnnotations)}

## How to Translate User Intent to Policy

When the user describes a purpose (e.g., "fix bugs in my code", "write a news
dossier"), reason about:
- Which tools does this task require? (file read/write, git, web fetch, etc.)
- Which paths or directories are involved?
- Which domains need to be accessible?
- What is read-only vs. read-write?
- What should require human approval vs. be automatic?
- What is explicitly NOT needed and should remain restricted?

Apply the principle of least privilege: only grant what the stated purpose
requires. If a task needs web fetching, allow only relevant domains, not all
web access. If it needs file writes, scope to the relevant directory.

## Using Category References (Dynamic Lists)

When the user's purpose involves a CATEGORY of things (e.g., "finance sites",
"news sites", "my contacts", "tech companies"), use a descriptive category
name instead of enumerating specific values. The downstream policy compiler
resolves these categories into concrete lists automatically.

Examples of good category usage:
- "The agent may fetch web content from finance news sites" (NOT a list of bloomberg.com, reuters.com, etc.)
- "The agent may fetch web content from major news sites" (NOT a list of cnn.com, bbc.com, etc.)
- "The agent may send emails to my contacts" (NOT specific email addresses)
- "The agent may read stock data for major tech companies" (NOT AAPL, GOOG, etc.)

Only enumerate specific values when the user explicitly names them (e.g.,
"allow access to github.com and gitlab.com").

## Response Format

Respond with either "changes" or a "question":

- Use "changes" when you have enough information to generate policy.
  Return ONLY the delta:
  - "addRules": new policy statements to append (just the text, no bullet prefix)
  - "removeRules": existing statements to remove (must match existing lines exactly)
  - "summary": what changed and why. If some aspect of the user's request is
    ALREADY covered by existing rules, note it here (e.g., "Writing to Downloads
    is already permitted — no new rule needed for that").
  Do NOT repeat existing rules in addRules. Only include genuinely new permissions.

- Use "question" when the user's request is ambiguous and you need
  clarification before generating. For example: "Where is your source
  code located?" or "Should the agent be able to push to git, or just
  commit locally?"

## Rules for Policy Statements
1. Each statement should be a clear, specific policy statement.
2. Use concrete terms the policy compiler can translate to rules:
   - "allow" / "deny" / "require approval" (maps to escalate)
   - Reference specific tools (git push, git commit) or categories
   - Reference domains when relevant (github.com, *.gov)
   - Reference paths when relevant (~/Documents, ~/src/myapp)
   - Reference categories for groups of domains/contacts/identifiers
     (e.g., "finance news sites", "my contacts") — DO NOT enumerate
3. Avoid vague statements. "Be careful with git" is not enforceable.
4. If the user's request conflicts with the base constitution, explain the
   conflict in the summary and suggest an alternative within base constraints.
`;
}

export function buildUserMessage(currentUserConstitution: string | undefined, userRequest: string): string {
  const current = currentUserConstitution
    ? `## Current User Customizations\n${currentUserConstitution}`
    : '## No existing user customizations.';
  return `${current}\n\n## User Request\n"${userRequest}"`;
}

// ---------------------------------------------------------------------------
// Line-Level Diff
// ---------------------------------------------------------------------------

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

/**
 * Computes a simple line-level diff between two texts.
 * Uses a longest common subsequence approach for accuracy.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];

  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length === 0) return newLines.map((text) => ({ type: 'added', text }));
  if (newLines.length === 0) return oldLines.map((text) => ({ type: 'removed', text }));

  // LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'unchanged', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added', text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: 'removed', text: oldLines[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Formats a line diff with chalk colors for terminal display.
 * Red for removed, green for added, plain for unchanged context.
 */
export function formatDiff(diff: DiffLine[]): string {
  return diff
    .map((line) => {
      switch (line.type) {
        case 'added':
          return chalk.green(`+ ${line.text}`);
        case 'removed':
          return chalk.red(`- ${line.text}`);
        case 'unchanged':
          return `  ${line.text}`;
      }
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Backup / Revert
// ---------------------------------------------------------------------------

/**
 * Writes the user constitution to disk, backing up the previous version.
 * Returns the path written to.
 */
export function writeConstitution(content: string): string {
  const userPath = getUserConstitutionPath();
  if (existsSync(userPath)) {
    copyFileSync(userPath, `${userPath}.bak`);
  }
  writeFileSync(userPath, content, 'utf-8');
  return userPath;
}

/**
 * Reverts the user constitution from the `.bak` file.
 * Throws if no backup exists.
 */
export function revertConstitution(): void {
  const userPath = getUserConstitutionPath();
  const bakPath = `${userPath}.bak`;
  if (!existsSync(bakPath)) {
    throw new Error('No backup file found to revert from.');
  }
  renameSync(bakPath, userPath);
}

// ---------------------------------------------------------------------------
// Base Constitution Seeding
// ---------------------------------------------------------------------------

/**
 * Ensures a user constitution file exists. If not, copies the
 * package-bundled base as a starting point.
 * Returns the current content of the user constitution (or undefined).
 */
export function seedBaseConstitution(): string | undefined {
  const userPath = getUserConstitutionPath();
  if (existsSync(userPath)) {
    return readFileSync(userPath, 'utf-8');
  }

  const basePath = getBaseUserConstitutionPath();
  if (existsSync(basePath)) {
    copyFileSync(basePath, userPath);
    return readFileSync(userPath, 'utf-8');
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Cancel Handling (follows config-command.ts pattern)
// ---------------------------------------------------------------------------

function handleCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel('Customization cancelled.');
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// LLM Call
// ---------------------------------------------------------------------------

async function callLlm(
  model: LanguageModel,
  systemPrompt: string | SystemModelMessage,
  messages: ModelMessage[],
): Promise<CustomizerResponse> {
  const result = await generateText({
    model,
    output: Output.object({ schema: CustomizerResponseSchema }),
    system: systemPrompt,
    messages,
    maxOutputTokens: 4096,
  });

  return result.output;
}

// ---------------------------------------------------------------------------
// Load Tool Annotations
// ---------------------------------------------------------------------------

function loadAnnotations(generatedDir: string, packageGeneratedDir: string): ToolAnnotation[] {
  const file = loadExistingArtifact<ToolAnnotationsFile>(generatedDir, 'tool-annotations.json', packageGeneratedDir);
  if (!file) {
    console.error(
      chalk.red.bold(
        "Error: tool-annotations.json not found. Run 'ironcurtain annotate-tools' first to generate tool annotations.",
      ),
    );
    process.exit(1);
  }
  return Object.values(file.servers).flatMap((server) => server.tools);
}

// ---------------------------------------------------------------------------
// Main Conversational Loop
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('Error: ironcurtain customize-policy requires an interactive terminal (TTY).');
    process.exit(1);
  }

  p.intro('IronCurtain Policy Customizer');

  // Load user config for model selection
  const userConfig = loadUserConfig();
  const cacheStrategy = createCacheStrategy(userConfig.policyModelId);

  // Resolve directories for artifact loading
  const configDir = resolve(__dirname, '..', 'config');
  const packageGeneratedDir = resolve(configDir, 'generated');
  const generatedDir = getUserGeneratedDir();

  // Load tool annotations
  const annotations = loadAnnotations(generatedDir, packageGeneratedDir);
  const serverCount = new Set(annotations.map((a) => a.serverName)).size;
  p.log.info(
    `Loaded tool annotations (${serverCount} server${serverCount !== 1 ? 's' : ''}, ${annotations.length} tools)`,
  );

  // Load base constitution (guiding principles -- read-only context for LLM)
  const constitutionPath = resolve(configDir, 'constitution.md');
  const baseConstitution = existsSync(constitutionPath) ? readFileSync(constitutionPath, 'utf-8') : '';

  // Seed user constitution if it doesn't exist
  let currentConstitution = seedBaseConstitution();

  // Display current state
  if (currentConstitution) {
    p.note(currentConstitution.trim(), 'Current User Constitution');
  } else {
    p.log.info('No user constitution yet. Starting from scratch.');
  }

  // Set up LLM
  const { model, logContext } = await createPipelineLlm(generatedDir, 'customize-policy');
  logContext.stepName = 'customize-policy';

  // Build system prompt (stable across turns -- ideal for caching)
  const rawSystemPrompt = buildSystemPrompt(baseConstitution, annotations);
  const systemPrompt = cacheStrategy.wrapSystemPrompt(rawSystemPrompt);

  // Conversation history for multi-turn context
  const conversationHistory: ModelMessage[] = [];

  // Track whether we have unsaved changes
  let hasUnsavedChanges = false;

  // Main loop
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
  while (true) {
    const prompt = hasUnsavedChanges ? 'Anything else? (type "done" to finish)' : 'What do you want the agent to do?';

    const userInput = await p.text({
      message: prompt,
      placeholder: hasUnsavedChanges
        ? 'describe another task, or "done"'
        : 'e.g., "fix bugs in my code at ~/src/myapp"',
    });
    handleCancel(userInput);

    const request = (userInput as string).trim();
    if (request.toLowerCase() === 'done') break;
    if (!request) continue;

    // Build user message and add to conversation
    const userMsg = buildUserMessage(currentConstitution, request);
    conversationHistory.push({ role: 'user', content: userMsg });

    // Apply cache breakpoint to history
    const cachedMessages = cacheStrategy.applyHistoryBreakpoint(conversationHistory);

    // Call LLM
    let response: CustomizerResponse;
    try {
      response = await callLlm(model, systemPrompt, cachedMessages);
    } catch (err) {
      p.log.error(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
      // Remove the user message we just added since the call failed
      conversationHistory.pop();
      continue;
    }

    // Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: JSON.stringify(response) });

    // Handle question response
    if (response.type === 'question') {
      p.log.info(response.question ?? 'Could you clarify your request?');
      continue;
    }

    // Handle changes response -- merge, show diff, ask for feedback
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via break
    while (true) {
      const proposed = applyChanges(currentConstitution ?? '', response.addRules ?? [], response.removeRules ?? []);
      const diff = computeLineDiff(currentConstitution ?? '', proposed);
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
      handleCancel(action);

      if (action === 'accept') {
        currentConstitution = proposed;
        hasUnsavedChanges = true;
        p.log.success('Changes accepted.');
        break;
      }

      if (action === 'reject') {
        p.log.info('Changes rejected.');
        break;
      }

      // Refine: get follow-up and re-call LLM
      const refinement = await p.text({
        message: 'How would you like to refine this?',
        placeholder: 'e.g., "put the output in ~/Desktop instead"',
      });
      handleCancel(refinement);

      const refineMsg = buildUserMessage(currentConstitution, (refinement as string).trim());
      conversationHistory.push({ role: 'user', content: refineMsg });

      const refinedMessages = cacheStrategy.applyHistoryBreakpoint(conversationHistory);

      try {
        response = await callLlm(model, systemPrompt, refinedMessages);
      } catch (err) {
        p.log.error(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
        conversationHistory.pop();
        break;
      }

      conversationHistory.push({ role: 'assistant', content: JSON.stringify(response) });

      if (response.type === 'question') {
        p.log.info(response.question ?? 'Could you clarify your request?');
        break;
      }

      // Loop back to show new diff
    }
  }

  // Write changes if any
  if (!hasUnsavedChanges || !currentConstitution) {
    p.outro('No changes to save.');
    return;
  }

  const writtenPath = writeConstitution(currentConstitution);
  p.log.success(`Saved to ${writtenPath}`);

  // Ask about compilation
  const shouldCompile = await p.confirm({
    message: 'Compile policy now?',
    initialValue: true,
  });
  handleCancel(shouldCompile);

  if (!shouldCompile) {
    p.log.info('Remember to run `ironcurtain compile-policy` before your next session.');
    p.outro('Done.');
    return;
  }

  // Invoke compile-policy programmatically
  try {
    const { main: compileMain } = await import('./compile.js');
    await compileMain();
    p.outro('Policy compiled successfully.');
  } catch (err) {
    p.log.error(`Compilation failed: ${err instanceof Error ? err.message : String(err)}`);

    const shouldRevert = await p.confirm({
      message: 'Revert to previous constitution?',
      initialValue: true,
    });
    handleCancel(shouldRevert);

    if (shouldRevert) {
      try {
        revertConstitution();
        p.log.success('Reverted to previous constitution.');
      } catch (revertErr) {
        p.log.error(`Revert failed: ${revertErr instanceof Error ? revertErr.message : String(revertErr)}`);
      }
    }
    p.outro('Done.');
  }
}
