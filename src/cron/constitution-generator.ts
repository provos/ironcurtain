/**
 * Constitution Generator -- uses an LLM with Code Mode access to
 * MCP servers (under read-only policy) to generate a draft task
 * constitution from a task description.
 *
 * The LLM explores MCP servers (read files, list dirs, check git,
 * query GitHub) to understand the task context, then produces a
 * structured constitution.
 */

import { createSession } from '../session/index.js';
import { getReadOnlyPolicyDir } from '../config/paths.js';
import { HeadlessTransport } from './headless-transport.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of constitution generation. */
export interface ConstitutionGenerationResult {
  /** The generated constitution text. */
  readonly constitution: string;
  /** Summary of what the LLM discovered and why it chose these rules. */
  readonly reasoning: string;
  /** Tools/servers the LLM explored during generation. */
  readonly exploredServers: readonly string[];
}

/** Options for constitution generation. */
export interface ConstitutionGeneratorOptions {
  /** The task description to generate a constitution for. */
  readonly taskDescription: string;
  /** Path to the job workspace (for filesystem exploration). */
  readonly workspacePath: string;
  /** Optional git repo URI (included in context for the LLM). */
  readonly gitRepo?: string;
  /** Progress callback for spinner updates. */
  readonly onProgress?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Prompt Construction
// ---------------------------------------------------------------------------

/**
 * Builds the system prompt augmentation for the constitution generator.
 * This is appended to the standard Code Mode system prompt via
 * SessionOptions.systemPromptAugmentation.
 */
export function buildConstitutionGeneratorSystemPrompt(
  taskDescription: string,
  workspacePath: string,
  gitRepo?: string,
): string {
  return `
## Constitution Generation Mode

You are generating a constitution for an automated, unattended scheduled job (cron).
A constitution is a high-level document describing the guiding principles and
permissions for the agent — what it is and is not permitted to do. A separate
policy compiler will derive concrete enforcement rules from your constitution,
so write at the level of principles and intent, not individual tool-level rules.
You have read-only access to MCP servers (filesystem, git, GitHub) to explore the task's context.

## Task Description

${taskDescription}

## Workspace

The job workspace is: ${workspacePath}
${gitRepo ? `Git repository: ${gitRepo}` : 'No git repository configured.'}

## Critical Context: Structural Rules and Cron Jobs

The policy engine has **structural rules** that are always active — you must NOT
duplicate them in the constitution:

- **Workspace auto-allow**: All read AND write operations within the job workspace
  (${workspacePath}) are automatically allowed. Do NOT write rules about reading
  or writing files in the workspace — they are redundant.
- **Default-deny**: Any operation not covered by a rule is automatically denied.
  You do NOT need to write "deny" or "NOT allowed" statements — omitting a
  permission is sufficient to block it.

This is a **cron job that runs unattended** — there is no human to approve
escalations. "Require approval" effectively means "block this operation."
Only escalate operations that are truly dangerous and should never run
automatically (e.g., deleting production data, force-pushing to main).

If the task description says the agent should do something (push to a remote,
create PRs, write files), then **allow it** — do not escalate operations the
task explicitly requires.

## Your Process

1. **Explore** (briefly): Use execute_code to call MCP tools for essential context:
   - Check the project structure and key files (README, package.json)
   - Check git remotes and branching patterns if the task involves git
   - Check GitHub repo structure if the task involves GitHub
   Keep exploration focused — spend most effort on generation, not discovery.

2. **Generate**: Write a concise constitution (aim for 5-10 high-level statements):
   - **Only describe permissions for actions mediated by MCP tools** — the policy
     engine can only enforce MCP tool calls. Do NOT mention shell commands
     (npm install, pip, etc.), package management, or other non-MCP actions —
     they cannot be enforced and add noise.
   - **Be specific about external resources** — the policy compiler can enforce
     constraints on:
     • **Paths**: directory containment (e.g., "within /home/user/project")
     • **Git remote URLs**: domain matching (e.g., "github.com/org/repo")
     • **GitHub owner/repo**: exact values (e.g., "on org/repo")
     However, branch names and commit messages CANNOT be constrained — do not
     write statements about specific branch name patterns.
   - Write statements about operations OUTSIDE the workspace or for external services
   - Allow everything the task explicitly needs to do autonomously
   - Only escalate truly dangerous operations (destructive, irreversible)
   - Use natural language — the policy compiler will derive concrete rules
   - Reference categories for groups (e.g., "popular news sites") not individual items
   - Do NOT reference ${workspacePath} or /workspace — those are handled structurally

## Output Format

Output a JSON block with:
- "constitution": The constitution text (multi-line string, each statement on its own
   line, each prefixed with " - ")
- "reasoning": 1-2 sentences summarizing what you found and the key policy decisions
- "exploredServers": Array of server names you queried

Wrap the JSON in a \`\`\`json code fence.

## Example Constitution (for a job that pushes code and creates PRs)

 - The agent has full local git access and may push to the origin remote
 - The agent has read access to all GitHub repositories
 - The agent may create branches, pull requests, and push code on org/repo
 - Merging pull requests and deleting branches requires approval
`.trim();
}

// ---------------------------------------------------------------------------
// User Message
// ---------------------------------------------------------------------------

function buildConstitutionGenerationUserMessage(taskDescription: string): string {
  return `Please explore the workspace and MCP servers to understand the context for this task, then generate a security constitution for it:\n\n${taskDescription}\n\nRemember to output your final answer as a JSON block with "constitution", "reasoning", and "exploredServers" fields.`;
}

// ---------------------------------------------------------------------------
// Response Parsing
// ---------------------------------------------------------------------------

/**
 * Extracts the constitution generation result from the LLM's response.
 * Looks for a JSON block in the response text (in code fences or raw).
 */
export function parseConstitutionResponse(response: string): ConstitutionGenerationResult {
  // Try ```json ... ``` first, then raw JSON (only if the entire response is JSON)
  const fencedMatch = response.match(/```json\s*([\s\S]*?)```/);
  const rawMatch = response.match(/^\s*(\{[\s\S]*\})\s*$/);
  const jsonMatch = fencedMatch ?? rawMatch;
  if (!jsonMatch) {
    throw new Error('LLM did not produce a valid constitution response (no JSON block found)');
  }

  // capture group 1 always exists since both patterns have a group
  const jsonText = jsonMatch[1];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    throw new Error('LLM produced invalid JSON in constitution response');
  }

  const constitution = parsed['constitution'];
  if (typeof constitution !== 'string' || !constitution.trim()) {
    throw new Error('LLM response missing "constitution" field');
  }

  const reasoning = parsed['reasoning'];
  const servers = parsed['exploredServers'];

  return {
    constitution,
    reasoning: typeof reasoning === 'string' ? reasoning : '',
    exploredServers: Array.isArray(servers) ? (servers as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Main Generation Function
// ---------------------------------------------------------------------------

/**
 * Generates a draft constitution by running an LLM through Code Mode
 * with a read-only policy. The LLM can explore MCP servers to
 * understand the task context before writing policy.
 *
 * @returns The generated constitution and reasoning.
 */
export async function generateConstitution(
  options: ConstitutionGeneratorOptions,
): Promise<ConstitutionGenerationResult> {
  const readOnlyPolicyDir = getReadOnlyPolicyDir();
  const augmentation = buildConstitutionGeneratorSystemPrompt(
    options.taskDescription,
    options.workspacePath,
    options.gitRepo,
  );

  const userMessage = buildConstitutionGenerationUserMessage(options.taskDescription);

  options.onProgress?.('Starting Code Mode session with read-only policy...');

  const transport = new HeadlessTransport({ taskMessage: userMessage });

  const session = await createSession({
    workspacePath: options.workspacePath,
    policyDir: readOnlyPolicyDir,
    systemPromptAugmentation: augmentation,
    disableAutoApprove: true,
  });

  try {
    options.onProgress?.('LLM exploring workspace and MCP servers...');
    await transport.run(session);

    const response = transport.getResponse();
    if (!response) {
      throw new Error('Constitution generation session produced no response');
    }

    options.onProgress?.('Parsing generated constitution...');
    return parseConstitutionResponse(response);
  } finally {
    await session.close();
  }
}
