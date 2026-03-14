/**
 * Constitution Generator -- uses an LLM with Code Mode access to
 * MCP servers (under read-only policy) to generate a draft task
 * constitution from a task description.
 *
 * The LLM explores MCP servers (read files, list dirs, check git,
 * query GitHub) to understand the task context, then produces a
 * structured constitution.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { parseJsonWithSchema } from '../pipeline/generate-with-repair.js';
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

/**
 * Controls the framing of the constitution generation prompt.
 *
 * - 'cron': unattended job, escalation effectively means block
 * - 'persona': interactive session, escalation is valid for risky operations
 */
export type GenerationContext = 'cron' | 'persona';

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
  /** Generation context: 'cron' (default) or 'persona'. */
  readonly context?: GenerationContext;
}

// ---------------------------------------------------------------------------
// Prompt Construction
// ---------------------------------------------------------------------------

/**
 * Builds the system prompt augmentation for the constitution generator.
 * This is appended to the standard Code Mode system prompt via
 * SessionOptions.systemPromptAugmentation.
 *
 * @param context - Generation context: 'cron' for unattended jobs,
 *   'persona' for interactive sessions. Defaults to 'cron'.
 */
export function buildConstitutionGeneratorSystemPrompt(
  taskDescription: string,
  workspacePath: string,
  gitRepo?: string,
  context: GenerationContext = 'cron',
): string {
  const contextLabel = context === 'persona' ? 'persona' : 'job';
  const taskLabel = context === 'persona' ? 'persona' : 'task';

  const introLine =
    context === 'persona'
      ? 'You are generating a constitution for an interactive persona — a named profile used for human-interactive sessions.'
      : 'You are generating a constitution for an automated, unattended scheduled job (cron).';

  const criticalContext =
    context === 'persona'
      ? `This is an **interactive persona** — a human is present during sessions and can
approve or deny escalated operations. Use escalation for operations that are
risky but sometimes necessary (e.g., deleting files outside the workspace,
pushing to protected branches). The human will decide in real time.

If the description says the persona should do something, **allow it** — do not
escalate operations the persona explicitly requires.`
      : `This is a **cron job that runs unattended** — there is no human to approve
escalations. "Require approval" effectively means "block this operation."
Only escalate operations that are truly dangerous and should never run
automatically (e.g., deleting production data, force-pushing to main).

If the task description says the agent should do something (push to a remote,
create PRs, write files), then **allow it** — do not escalate operations the
task explicitly requires.`;

  const exploreStep =
    context === 'persona'
      ? `1. **Explore** (optional): If the description references a specific project or
   workspace, use execute_code to call MCP tools for essential context. If the
   persona is general-purpose (email, research, etc.), skip exploration and
   generate directly.`
      : `1. **Explore** (briefly): Use execute_code to call MCP tools for essential context:
   - Check the project structure and key files (README, package.json)
   - Check git remotes and branching patterns if the task involves git
   - Check GitHub repo structure if the task involves GitHub
   Keep exploration focused — spend most effort on generation, not discovery.`;

  return `
## Constitution Generation Mode

${introLine}
A constitution is a high-level document describing the guiding principles and
permissions for the agent — what it is and is not permitted to do. A separate
policy compiler will derive concrete enforcement rules from your constitution,
so write at the level of principles and intent, not individual tool-level rules.
You have read-only access to MCP servers (filesystem, git, GitHub) to explore the task's context.

## Task Description

${taskDescription}

## Workspace (for exploration only)

The ${contextLabel} workspace is at: ${workspacePath}
${gitRepo ? `Git repository: ${gitRepo}` : 'No git repository configured.'}
Use this path to explore project context. Do NOT reference this path in the constitution —
workspace access is handled automatically by structural rules (see below).

## Critical Context: Structural Rules

The policy engine has **structural rules** that are always active — you must NOT
duplicate them in the constitution:

- **Workspace auto-allow**: At runtime, all read AND write operations within the
  workspace are automatically allowed. The workspace path is configured at
  runtime and may change between sessions. Do NOT write ANY statements about
  the workspace — not "within the workspace", not "outside the workspace",
  not "reading/writing files in the workspace". All workspace containment is
  handled structurally and is completely invisible to the constitution.
- **Default-deny**: Any operation not covered by a rule is automatically denied.
  You do NOT need to write "deny" or "NOT allowed" statements — omitting a
  permission is sufficient to block it.

Instead of workspace-relative framing, write statements about **specific named
directories or resources** the agent should access beyond its workspace. For
example, instead of "may read files outside the workspace", write "may read
files in ~/Documents and ~/projects". Instead of "writing outside the workspace
requires approval", simply specify which external directories the agent may
write to (or omit them to let default-deny handle it).

${criticalContext}

## Your Process

${exploreStep}

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
   - Write statements about specific directories, services, or resources — never
     mention "the workspace" or frame rules relative to it
   - Allow everything the ${taskLabel} explicitly needs to do autonomously
   - Only escalate truly dangerous operations (destructive, irreversible)
   - Use natural language — the policy compiler will derive concrete rules
   - Reference categories for groups (e.g., "popular news sites") not individual items

## Output Format

Output a JSON block with:
- "constitution": The constitution text (multi-line string, each statement on its own
   line, each prefixed with " - ")
- "reasoning": 1-2 sentences summarizing what you found and the key policy decisions
- "exploredServers": Array of server names you queried

Wrap the JSON in a \`\`\`json code fence.

## Example Constitution (for a ${contextLabel} that pushes code and creates PRs)

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

const constitutionResponseSchema = z.object({
  constitution: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'missing "constitution" field')),
  reasoning: z.string().default(''),
  exploredServers: z.array(z.string()).catch([]),
});

/**
 * Extracts the constitution generation result from the LLM's response.
 * Looks for a JSON block in the response text (in code fences or raw),
 * then validates against the schema.
 */
export function parseConstitutionResponse(response: string): ConstitutionGenerationResult {
  return parseJsonWithSchema(response, constitutionResponseSchema);
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
    options.context ?? 'cron',
  );

  const userMessage = buildConstitutionGenerationUserMessage(options.taskDescription);

  options.onProgress?.('Starting Code Mode session with read-only policy...');

  const transport = new HeadlessTransport({ taskMessage: userMessage });

  // Use a throwaway temp dir as the session sandbox so the sandbox fast-path
  // auto-allows writes only in the temp dir, not the real job workspace.
  // The job workspace path is still communicated to the LLM via the system
  // prompt so it knows where to explore.
  const sandboxDir = mkdtempSync(join(tmpdir(), 'ironcurtain-constgen-'));

  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    session = await createSession({
      workspacePath: sandboxDir,
      policyDir: readOnlyPolicyDir,
      systemPromptAugmentation: augmentation,
      disableAutoApprove: true,
    });

    options.onProgress?.('LLM exploring workspace and MCP servers...');
    await transport.run(session);

    const response = transport.getResponse();
    if (!response) {
      throw new Error('Constitution generation session produced no response');
    }

    options.onProgress?.('Parsing generated constitution...');
    return parseConstitutionResponse(response);
  } finally {
    if (session) await session.close();
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}
