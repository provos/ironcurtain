/**
 * Haiku-based server pre-filter for policy compilation.
 *
 * Uses a cheap classification model (Haiku) to determine whether each
 * MCP server can be skipped before invoking the expensive compilation
 * model. If the input text (constitution, task description, or persona
 * definition) has no specific guidance for a server, that server is
 * skipped and default-deny handles all its tools.
 */

import pLimit from 'p-limit';
import { z } from 'zod';
import { generateObjectWithRepair } from './generate-with-repair.js';
import type { ConstitutionKind } from './pipeline-runner.js';
import type { ToolAnnotation } from './types.js';
import type { TextGenerationModel } from '../llm/text-generation.js';

/** Cap concurrent pre-filter LLM calls to avoid rate-limit bursts. */
const PREFILTER_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const serverRelevanceSchema = z.object({
  skip: z
    .boolean()
    .describe(
      "true if the input text contains no specific guidance that would require or allow any of this server's tools. When in doubt, set to false.",
    ),
  reason: z.string().describe('Brief explanation of why the server is or is not relevant to the input text'),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of the pre-filter for a single server. */
export interface PrefilterDecision {
  readonly serverName: string;
  readonly skip: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrefilterPrompt(
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  kind: ConstitutionKind,
): string {
  const toolList = tools.map((t) => `- ${t.toolName}: ${t.comment}`).join('\n');

  const taskFraming =
    kind === 'constitution'
      ? `Based ONLY on the user guidance below, determine whether ANY of this server's tools would be specifically allowed or granted special permissions.

The user guidance is relevant to this server if it:
- Mentions the server by name
- Mentions capabilities that map to this server's tools (e.g., "read files" maps to a filesystem server, "search GitHub issues" maps to a GitHub server)
- Grants permissions for operations this server provides

The user guidance is NOT relevant if it:
- Contains no mention of this server's domain of functionality
- Only contains general principles that don't translate to specific allow rules for this server's tools

If the user guidance contains no specific permissions for this server, the server can be safely skipped — a default-deny policy will handle all its tools.`
      : `Based ONLY on the task description below, determine whether accomplishing this task would require ANY of this server's tools.

The task is relevant to this server if it:
- Describes work that directly requires this server's capabilities (e.g., "analyze CSV files" requires filesystem tools, "check open PRs" requires GitHub tools)
- References data, resources, or operations that this server provides access to

The task is NOT relevant to this server if it:
- Describes work entirely outside this server's domain of functionality
- Makes no reference to resources or operations this server provides

If the task does not require any of this server's tools, the server can be safely skipped — a default-deny policy will handle all its tools.`;

  return `You are evaluating whether an input text is relevant to a specific MCP server's tools.

## Server: "${serverName}"

### Available tools:
${toolList}

## Task

${taskFraming}

**Important: When in doubt, set skip to false.** It is better to compile rules unnecessarily than to skip a server that needs them.

Respond with a JSON object: { "skip": boolean, "reason": string }`;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Determines whether a server can be skipped during policy compilation.
 *
 * Errors are caught internally and result in skip: false (fail-open).
 */
export async function checkServerRelevance(
  text: string,
  serverName: string,
  tools: ReadonlyArray<ToolAnnotation>,
  model: TextGenerationModel,
  kind: ConstitutionKind,
): Promise<PrefilterDecision> {
  try {
    const { output } = await generateObjectWithRepair({
      model,
      schema: serverRelevanceSchema,
      system: buildPrefilterPrompt(serverName, tools, kind),
      prompt: text || '(no guidance provided)',
      maxRepairAttempts: 1,
      maxOutputTokens: 256,
    });
    return { serverName, skip: output.skip, reason: output.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      serverName,
      skip: false,
      reason: `Pre-filter error (proceeding with compilation): ${message}`,
    };
  }
}

/**
 * Runs the pre-filter for all servers concurrently.
 *
 * Short-circuits when text is empty/whitespace (returns skip: true
 * for all servers without making any LLM calls).
 */
export async function prefilterServers(
  text: string,
  servers: Array<[string, ReadonlyArray<ToolAnnotation>]>,
  model: TextGenerationModel,
  kind: ConstitutionKind,
): Promise<PrefilterDecision[]> {
  const trimmed = text.trim();
  if (trimmed === '') {
    return servers.map(([serverName]) => ({
      serverName,
      skip: true,
      reason: 'No input text provided — all servers skipped by default',
    }));
  }
  const limit = pLimit(PREFILTER_CONCURRENCY);
  return Promise.all(
    servers.map(([serverName, tools]) => limit(() => checkServerRelevance(trimmed, serverName, tools, model, kind))),
  );
}
