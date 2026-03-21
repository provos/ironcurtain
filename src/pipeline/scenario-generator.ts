/**
 * Scenario Generator -- LLM-driven test scenario generation.
 *
 * Generates concrete test scenarios (tool call + expected decision) from
 * the constitution and tool annotations. Always includes mandatory
 * handwritten scenarios alongside LLM-generated ones.
 *
 * Large servers (100+ tools) are handled via batching: annotations are
 * split into batches of SCENARIO_BATCH_SIZE, each batch gets its own
 * scoped system prompt and Zod schema, and results are deduplicated
 * across batches.
 */

import type { LanguageModel, SystemModelMessage } from 'ai';
import { z } from 'zod';
import { DEFAULT_MAX_TOKENS, generateObjectWithRepair } from './generate-with-repair.js';
import { chunk } from './tool-annotator.js';
import type {
  ArgumentRoleSpec,
  ConditionalRoles,
  DynamicListsFile,
  StoredToolAnnotation,
  ToolAnnotation,
  TestScenario,
} from './types.js';
import { isConditionalRoles } from '../types/argument-roles.js';

export const SCENARIO_BATCH_SIZE = 25;

function buildGeneratorResponseSchema(serverNames: [string, ...string[]], toolNames: [string, ...string[]]) {
  const scenarioSchema = z.object({
    description: z.string(),
    request: z.object({
      serverName: z.enum(serverNames),
      toolName: z.enum(toolNames),
      arguments: z.record(z.string(), z.unknown()),
    }),
    expectedDecision: z.enum(['allow', 'deny', 'escalate']),
    reasoning: z.string(),
  });

  return z.object({
    scenarios: z.array(scenarioSchema),
  });
}

/** Maximum number of example values shown per list to keep prompts concise. */
const MAX_LIST_PREVIEW_VALUES = 5;

/**
 * Formats a ## Dynamic List Values section for inclusion in prompts.
 * Shows up to {@link MAX_LIST_PREVIEW_VALUES} example values per list.
 * Returns an empty string when no lists are available.
 */
export function formatDynamicListsSection(dynamicLists?: DynamicListsFile): string {
  if (!dynamicLists || Object.keys(dynamicLists.lists).length === 0) return '';

  const entries = Object.entries(dynamicLists.lists)
    .map(([name, list]) => {
      const preview = list.values.slice(0, MAX_LIST_PREVIEW_VALUES);
      const suffix = list.values.length > MAX_LIST_PREVIEW_VALUES ? `, ... (${list.values.length} total)` : '';
      return `- **@${name}** (${list.values.length} values): ${preview.join(', ')}${suffix}`;
    })
    .join('\n');

  return `
## Dynamic List Values

Rules reference these symbolic @list-name references, resolved to:
${entries}

For list-based scenarios, use values FROM these lists for positive/allow cases and obviously unrelated values (e.g., a random unrelated domain or identifier) for negative/deny/escalate cases.
`;
}

/**
 * Formats a single conditional role spec as a human-readable string.
 * Shows the discriminator argument, its valid values, and the role
 * assignments per mode so the LLM knows exact argument names/values.
 */
export function formatConditionalRoles(argName: string, spec: ConditionalRoles): string {
  const clauses = spec.when.map((entry) => {
    const cond = entry.condition;
    let condStr: string;
    if (cond.equals !== undefined) {
      condStr = `${cond.arg}=${JSON.stringify(cond.equals)}`;
    } else if (cond.in !== undefined) {
      condStr = `${cond.arg} in ${JSON.stringify(cond.in)}`;
    } else if (cond.is !== undefined) {
      condStr = `${cond.arg} is ${cond.is}`;
    } else {
      condStr = `${cond.arg}=?`;
    }
    return `when ${condStr} → [${entry.roles.join(', ')}]`;
  });
  return `${argName}: default=[${spec.default.join(', ')}], ${clauses.join('; ')}`;
}

/**
 * Formats a tool annotation summary line for the scenario generator prompt.
 * When a stored annotation is available, includes conditional role details
 * so the LLM knows the exact discriminator argument names and valid values.
 */
function formatAnnotationForPrompt(annotation: ToolAnnotation, storedAnnotation?: StoredToolAnnotation): string {
  const args = storedAnnotation?.args ?? annotation.args;
  const argsDesc = Object.entries(args)
    .map(([name, spec]: [string, ArgumentRoleSpec]) => {
      if (isConditionalRoles(spec)) {
        return formatConditionalRoles(name, spec);
      }
      // After isConditionalRoles check, spec is always ArgumentRole[]
      return `${name}: [${(spec as string[]).join(', ')}]`;
    })
    .join(', ');
  return `  ${annotation.serverName}/${annotation.toolName}: ${annotation.comment}, args={${argsDesc || 'none'}}`;
}

/**
 * Builds the stable system prompt portion for the scenario generator.
 * Contains: role preamble, constitution, annotations, system config, and instructions.
 * This is the cacheable part.
 *
 * @param storedAnnotations - Optional raw annotations with conditional role specs.
 *   When provided, the prompt includes discriminator argument names and valid values
 *   so the LLM generates scenarios with correct argument names for multi-mode tools.
 */
export function buildGeneratorSystemPrompt(
  constitutionText: string,
  annotations: ToolAnnotation[],
  sandboxDirectory: string,
  permittedDirectories?: string[],
  dynamicLists?: DynamicListsFile,
  storedAnnotations?: StoredToolAnnotation[],
): string {
  // Build a lookup from stored annotations for conditional role detail
  const storedByKey = new Map<string, StoredToolAnnotation>();
  if (storedAnnotations) {
    for (const sa of storedAnnotations) {
      storedByKey.set(`${sa.serverName}/${sa.toolName}`, sa);
    }
  }

  const annotationsSummary = annotations
    .map((a) => {
      const stored = storedByKey.get(`${a.serverName}/${a.toolName}`);
      return formatAnnotationForPrompt(a, stored);
    })
    .join('\n');

  return `You are generating test scenarios for a security policy engine. Each scenario is a concrete tool call with an expected policy decision.

## Constitution

${constitutionText}

## Tool Annotations

${annotationsSummary}

## System Configuration

- Sandbox directory: ${sandboxDirectory}
${
  permittedDirectories && permittedDirectories.length > 0
    ? `
## Permitted Directories (from compiled policy rules)

The compiled rules reference these specific directories. Use these EXACT paths in your scenarios:

${permittedDirectories.map((p) => `- ${p}`).join('\n')}
`
    : ''
}
${formatDynamicListsSection(dynamicLists)}
## Instructions

Generate diverse test scenarios covering:
1. **Positive cases**: operations that SHOULD be allowed (within sandbox or permitted directories per constitution)
2. **Negative cases**: operations that SHOULD be denied (categorically forbidden by the constitution, e.g., deletes outside sandbox)
3. **Escalation cases**: operations outside the sandbox and permitted directories that are NOT categorically forbidden — these require human approval
4. **Edge cases**: path traversal attacks, boundary conditions
5. **Read-only tools**: tools where all arguments have \`none\`-role (no resource-identifier arguments) — these should typically be allowed
6. **Move operations**: all moves involve a delete-path role on the source argument
7. **Domain-based operations**: if any tools have URL roles (fetch-url, git-remote-url), generate scenarios for allowed domains, disallowed domains, and named remote resolution. For git-remote-url args, always supply an explicit URL (https:// or git@ form) — never omit them (see IMPORTANT below)

The policy uses a default-deny model. Compiled rules only express "allow" or "escalate":
- "allow" -- explicitly permitted by a compiled rule
- "escalate" -- routed to a human for judgment by a compiled rule
- "deny" -- no compiled rule matched; this is the default for anything the constitution
  prohibits or does not address

**Meta-Rule:** If an operation is outside the sandbox and the Constitution does NOT
explicitly permit it and does NOT require human judgment for it, the expected decision
is "deny" (default-deny). Use "escalate" only when the constitution explicitly indicates
the operation requires human approval or judgment. Use "deny" for operations the
constitution categorically forbids (like external deletes) AND for operations the
constitution simply does not address.

For each scenario provide:
- description: what the test checks
- request: { serverName, toolName, arguments } with concrete paths
- expectedDecision: "allow", "deny", or "escalate"
- reasoning: why this decision follows from the constitution

IMPORTANT:
- Use the EXACT permitted directory paths listed above (not generic paths like "/home/user/Downloads").
- Use concrete paths based on the sandbox directory "${sandboxDirectory}".
- For paths outside all permitted areas, use paths like "/etc/passwd", "/var/log/syslog", etc.
- Generate at least 10 scenarios with good coverage across all three decision types (allow, deny, escalate).
- **Always include explicit URL values for git-remote-url arguments** (e.g., "https://github.com/org/repo.git" or "git@github.com:org/repo.git"). Never omit them. The policy engine resolves the default git remote from the filesystem at runtime, but that resolution does not run during policy verification — an absent git-remote-url arg means zero URL args are extracted, so domain-constrained compiled rules cannot match and will appear to fail incorrectly.

Be concise in descriptions and reasoning -- one sentence each.`;
}

/**
 * Checks if two scenarios are substantially similar (same tool + same arguments).
 */
function areSimilar(a: TestScenario, b: TestScenario): boolean {
  if (a.request.toolName !== b.request.toolName) return false;
  if (a.request.serverName !== b.request.serverName) return false;

  const aArgs = JSON.stringify(a.request.arguments);
  const bArgs = JSON.stringify(b.request.arguments);
  return aArgs === bArgs;
}

/**
 * Builds the user-message prompt for a single scenario generation batch.
 * When handwritten scenarios exist for this batch's tools, they are
 * included so the LLM avoids duplicating their coverage.
 */
function buildBatchPrompt(batchHandwritten: TestScenario[]): string {
  if (batchHandwritten.length === 0) {
    return 'Generate test scenarios following the instructions above.';
  }

  const handwrittenSummary = batchHandwritten
    .map((s) => `- ${s.request.serverName}/${s.request.toolName}: "${s.description}" (${s.expectedDecision})`)
    .join('\n');

  return `The following handwritten scenarios already exist for these tools. Generate additional scenarios that complement them without duplicating their coverage.

${handwrittenSummary}

Generate test scenarios following the instructions above.`;
}

/**
 * Generates test scenarios by batching annotations into groups of
 * SCENARIO_BATCH_SIZE, running generateObjectWithRepair per batch with
 * scoped system prompts and Zod schemas, then deduplicating results.
 */
export async function generateScenarios(
  constitutionText: string,
  annotations: ToolAnnotation[],
  handwrittenScenarios: TestScenario[],
  sandboxDirectory: string,
  llm: LanguageModel,
  permittedDirectories?: string[],
  onProgress?: (message: string) => void,
  dynamicLists?: DynamicListsFile,
  wrapSystemPrompt?: (prompt: string) => string | SystemModelMessage,
  storedAnnotations?: StoredToolAnnotation[],
): Promise<TestScenario[]> {
  if (annotations.length === 0) return [...handwrittenScenarios];

  const batches = chunk(annotations, SCENARIO_BATCH_SIZE);
  const allGenerated: TestScenario[] = [];

  // Build stored annotation lookup for batching
  const storedByKey = new Map<string, StoredToolAnnotation>();
  if (storedAnnotations) {
    for (const sa of storedAnnotations) {
      storedByKey.set(`${sa.serverName}/${sa.toolName}`, sa);
    }
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batches.length > 1) {
      onProgress?.(`Batch ${i + 1}/${batches.length} (${batch.length} tools)`);
    }

    // Scoped schema: only this batch's server/tool names
    const serverNames = [...new Set(batch.map((a) => a.serverName))] as [string, ...string[]];
    const toolNames = [...new Set(batch.map((a) => a.toolName))] as [string, ...string[]];
    const schema = buildGeneratorResponseSchema(serverNames, toolNames);

    // Filter stored annotations to this batch
    const batchStored = storedAnnotations
      ? batch
          .map((a) => storedByKey.get(`${a.serverName}/${a.toolName}`))
          .filter((sa): sa is StoredToolAnnotation => sa !== undefined)
      : undefined;

    // Per-batch system prompt with only this batch's annotations
    const batchPromptText = buildGeneratorSystemPrompt(
      constitutionText,
      batch,
      sandboxDirectory,
      permittedDirectories,
      dynamicLists,
      batchStored,
    );

    // Apply cache strategy wrapping if provided
    const batchSystem = wrapSystemPrompt ? wrapSystemPrompt(batchPromptText) : batchPromptText;

    // Filter handwritten scenarios to those relevant to this batch (composite key avoids cross-server collisions)
    const batchToolKeySet = new Set(batch.map((a) => `${a.serverName}:::${a.toolName}`));
    const batchHandwritten = handwrittenScenarios.filter((s) =>
      batchToolKeySet.has(`${s.request.serverName}:::${s.request.toolName}`),
    );

    const { output } = await generateObjectWithRepair({
      model: llm,
      schema,
      system: batchSystem,
      prompt: buildBatchPrompt(batchHandwritten),
      maxOutputTokens: 16384,
      onProgress: batches.length > 1 ? (msg) => onProgress?.(`Batch ${i + 1}/${batches.length}: ${msg}`) : onProgress,
    });

    allGenerated.push(
      ...output.scenarios.map((s) => ({
        ...s,
        source: 'generated' as const,
      })),
    );
  }

  // Deduplicate generated against handwritten AND across batches
  const seen = new Set<string>();
  const unique = allGenerated.filter((g) => {
    if (handwrittenScenarios.some((h) => areSimilar(g, h))) return false;
    const key = `${g.request.serverName}/${g.request.toolName}/${JSON.stringify(g.request.arguments)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return [...handwrittenScenarios, ...unique];
}

/**
 * Generates replacement scenarios for structurally discarded ones.
 * Uses a single-shot generateObjectWithRepair call (no batching needed
 * since the discarded set is typically small).
 */
export async function repairScenarios(
  discardedScenarios: { scenario: TestScenario; feedback: string }[],
  constitutionText: string,
  annotations: ToolAnnotation[],
  sandboxDirectory: string,
  llm: LanguageModel,
  permittedDirectories?: string[],
  dynamicLists?: DynamicListsFile,
  onProgress?: (message: string) => void,
  storedAnnotations?: StoredToolAnnotation[],
): Promise<TestScenario[]> {
  const serverNames = [...new Set(annotations.map((a) => a.serverName))] as [string, ...string[]];
  const toolNames = [...new Set(annotations.map((a) => a.toolName))] as [string, ...string[]];
  const schema = buildGeneratorResponseSchema(serverNames, toolNames);

  const discardedList = discardedScenarios
    .map(
      (b, i) =>
        `${i + 1}. "${b.scenario.description}" (${b.scenario.request.serverName}/${b.scenario.request.toolName}): ${b.feedback}`,
    )
    .join('\n');

  const prompt = `The following scenarios were discarded because they conflict with structural invariants (hardcoded engine behavior that cannot be overridden by compiled rules).
Generate replacement scenarios that cover similar tools and decision types but with correct expectations.

${discardedList}

Generate one replacement scenario per discarded scenario.`;

  const system = buildGeneratorSystemPrompt(
    constitutionText,
    annotations,
    sandboxDirectory,
    permittedDirectories,
    dynamicLists,
    storedAnnotations,
  );

  const { output } = await generateObjectWithRepair({
    model: llm,
    schema,
    system,
    prompt,
    maxOutputTokens: DEFAULT_MAX_TOKENS,
    onProgress,
  });

  return output.scenarios.map((s) => ({
    ...s,
    source: 'generated' as const,
  }));
}
