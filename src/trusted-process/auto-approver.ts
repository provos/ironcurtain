/**
 * Escalation Auto-Approver -- Conservative intent matcher.
 *
 * Sits between the policy engine's escalation decision and the human
 * approval flow. Uses a cheap LLM to determine whether the human's
 * most recent message clearly and specifically authorized the escalated
 * tool action.
 *
 * Security invariants:
 * - Can only return 'approve' or 'escalate', never 'deny'
 * - All error paths fail-open to human escalation
 * - Stateless: no internal state, no lifecycle management
 *
 * Tool arguments handling:
 * Only sanitized resource-identifier arguments (paths, URLs) are included
 * in the LLM prompt. Free-text fields (commit messages, branch names) are
 * excluded. Values are control-character-stripped and length-truncated.
 * Prompt injection risk is low: one-shot structured-output call with a
 * fixed Zod schema (approve | escalate), and only resource-identifier
 * values are included (already normalized by the policy engine).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getRoleDefinition } from '../types/argument-roles.js';
import type { ToolAnnotation } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The auto-approver's decision. Only two outcomes are possible:
 * - 'approve': the human's prompt clearly authorized this action
 * - 'escalate': uncertain or no clear authorization; pass to human
 *
 * The auto-approver can never deny. This is enforced by the type.
 */
export type AutoApproveDecision = 'approve' | 'escalate';

/**
 * Context provided to the auto-approver for intent matching.
 *
 * Includes sanitized resource-identifier arguments (paths, URLs) so the
 * auto-approver can verify that specific targets match the user's intent.
 * Free-text fields (commit messages, branch names) are excluded to limit
 * prompt injection surface.
 */
export interface AutoApproveContext {
  /** The human's most recent message to the agent. */
  readonly userMessage: string;

  /** The fully qualified tool name (serverName/toolName). */
  readonly toolName: string;

  /** The policy engine's reason for escalation. */
  readonly escalationReason: string;

  /** Sanitized resource-identifier arguments (paths, URLs). Omitted when none exist. */
  readonly arguments?: Readonly<Record<string, string>>;
}

/**
 * Configuration for the auto-approver, resolved from user config.
 *
 * Invariant: when `enabled` is false, the auto-approver is never called.
 * Callers must check `enabled` before calling `autoApprove()`.
 */
export interface AutoApproverConfig {
  readonly enabled: boolean;
  readonly modelId: string;
}

/**
 * Result of an auto-approve evaluation, including the decision
 * and metadata for audit logging and diagnostics.
 */
export interface AutoApproveResult {
  readonly decision: AutoApproveDecision;

  /**
   * Brief explanation of why the decision was made.
   * For auditing and diagnostic display only -- not used in control flow.
   */
  readonly reasoning: string;
}

// ---------------------------------------------------------------------------
// LLM prompt and response schema
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a security-critical intent matcher for a software tool authorization system.

Your job: determine whether the human's most recent message CLEARLY and SPECIFICALLY authorizes the tool action that was escalated for approval.

Rules:
1. APPROVE only when the human's message contains an explicit, specific request that directly maps to the escalated tool action.
2. ESCALATE (pass to human) when there is ANY ambiguity, vagueness, or indirect authorization.
3. The human must have requested the SPECIFIC action, not just a general category of actions.
4. Generic phrases like "go ahead", "continue", "do what you need to", "fix it" are NEVER sufficient for approval.
5. The human's message must mention the specific operation or its clear equivalent.
6. When tool arguments are provided, verify they match what the human specifically requested. If the human said "push to origin" but the remote argument is something else, ESCALATE.

Examples of APPROVE:
- Human: "push my changes to origin" -> Tool: git/git_push, Args: remote=github.com -> APPROVE (explicit push request, remote matches)
- Human: "read the file at ~/Documents/notes.txt" -> Tool: filesystem/read_file, Args: path=/home/user/Documents/notes.txt -> APPROVE (explicit file read, path matches)
- Human: "delete the temp files in /var/log" -> Tool: filesystem/delete_file, Args: path=/var/log/temp.log -> APPROVE (explicit delete request, path within requested directory)

Examples of ESCALATE:
- Human: "fix the failing tests" -> Tool: filesystem/read_file, Args: path=/etc/passwd -> ESCALATE (no specific file read requested)
- Human: "go ahead and continue" -> Tool: git/git_push -> ESCALATE (no specific push requested)
- Human: "push to origin" -> Tool: git/git_push, Args: remote=evil-server.com -> ESCALATE (remote doesn't match what human requested)
- Human: "clean up the project" -> Tool: filesystem/delete_file -> ESCALATE (ambiguous scope)
- Human: "commit my changes" -> Tool: git/git_push -> ESCALATE (commit != push, different operation)

Respond with your decision and a brief reason.`;

const responseSchema = z.object({
  decision: z.enum(['approve', 'escalate']),
  reasoning: z.string().describe('Brief explanation (1 sentence) of why you made this decision'),
});

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Evaluates whether an escalated tool call was clearly authorized
 * by the human's most recent message.
 *
 * Conservative by design: approves only when intent is unambiguous.
 * Any error (LLM failure, timeout, parse error) results in 'escalate'.
 *
 * @param context - The escalation context for intent matching
 * @param model - Pre-created LanguageModel instance
 * @returns The auto-approve decision with reasoning
 */
export async function autoApprove(context: AutoApproveContext, model: LanguageModelV3): Promise<AutoApproveResult> {
  if (!context.userMessage.trim()) {
    return {
      decision: 'escalate',
      reasoning: 'Empty user message; escalating to human',
    };
  }

  try {
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(context),
      experimental_output: Output.object({ schema: responseSchema }),
    });

    const parsed = result.experimental_output;
    if (!parsed || (parsed.decision !== 'approve' && parsed.decision !== 'escalate')) {
      return {
        decision: 'escalate',
        reasoning: 'Auto-approver returned invalid response; escalating to human',
      };
    }

    return {
      decision: parsed.decision,
      reasoning: parsed.reasoning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: 'escalate',
      reasoning: `Auto-approver error: ${message}; escalating to human`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips control characters and truncates to a safe length for LLM prompts.
 *
 * Prompt injection risk is low here because:
 * - This is a one-shot structured-output call with a fixed Zod schema (approve | escalate)
 * - Only resource-identifier values are included (no free-text)
 * - Values are already normalized (paths resolved, URLs canonicalized)
 * - Successful injection would need to produce valid JSON matching the enum
 */
export function sanitizeForPrompt(value: string): string {
  // Strip C0 control chars (\x00-\x1f), DEL (\x7f), and C1 control chars (\x80-\x9f)
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const MAX_LENGTH = 200;
  if (cleaned.length > MAX_LENGTH) {
    return cleaned.slice(0, MAX_LENGTH) + '...';
  }
  return cleaned;
}

/**
 * Extracts sanitized resource-identifier arguments for the auto-approver prompt.
 *
 * Only arguments whose first role has `isResourceIdentifier: true` are included.
 * URL roles have `prepareForPolicy` applied (extracts domain). All values are
 * sanitized for safe inclusion in an LLM prompt.
 *
 * Returns undefined when no resource-identifier arguments are found.
 */
export function extractArgsForAutoApprove(
  argsForPolicy: Record<string, unknown>,
  annotation: ToolAnnotation | undefined,
): Record<string, string> | undefined {
  if (!annotation) return undefined;

  const result: Record<string, string> = {};

  for (const [argName, value] of Object.entries(argsForPolicy)) {
    const roles = annotation.args[argName];
    if (!roles || roles.length === 0) continue;

    // Use the first role assigned to this argument
    const roleDef = getRoleDefinition(roles[0]);
    if (!roleDef.isResourceIdentifier) continue;

    // Convert value to string(s)
    let stringValue: string;
    if (Array.isArray(value)) {
      const strings = value.filter((v): v is string => typeof v === 'string');
      if (strings.length === 0) continue;
      stringValue = strings.join(', ');
    } else if (typeof value === 'string') {
      stringValue = value;
    } else {
      continue;
    }

    // Apply prepareForPolicy if available (e.g., extract domain from URL)
    if (roleDef.prepareForPolicy) {
      stringValue = roleDef.prepareForPolicy(stringValue);
    }

    result[argName] = sanitizeForPrompt(stringValue);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Builds the user prompt for the LLM call. */
function buildUserPrompt(context: AutoApproveContext): string {
  let prompt = `Human's most recent message: "${context.userMessage}"

Escalated tool: ${context.toolName}
Reason for escalation: ${context.escalationReason}`;

  if (context.arguments && Object.keys(context.arguments).length > 0) {
    const argLines = Object.entries(context.arguments)
      .map(([key, val]) => `  ${key}: ${val}`)
      .join('\n');
    prompt += `\n\nTool arguments (resource identifiers only):\n${argLines}`;
  }

  prompt += '\n\nDecision:';
  return prompt;
}

/**
 * Reads the user context file from the escalation directory.
 *
 * Returns the user's most recent message, or null if the file is
 * missing, malformed, or empty. Fail-open: any error results in null,
 * causing the caller to skip auto-approval and fall through to human.
 */
export function readUserContext(escalationDir: string): string | null {
  try {
    const contextPath = resolve(escalationDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8')) as Record<string, unknown>;
    const { userMessage } = data;
    return typeof userMessage === 'string' && userMessage.trim() ? userMessage : null;
  } catch {
    return null;
  }
}
