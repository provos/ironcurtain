/**
 * Scenario Generator -- LLM-driven test scenario generation.
 *
 * Generates concrete test scenarios (tool call + expected decision) from
 * the constitution and tool annotations. Always includes mandatory
 * handwritten scenarios alongside LLM-generated ones.
 */

import type { LanguageModel, SystemModelMessage } from 'ai';
import { generateText } from 'ai';
import { z } from 'zod';
import {
  DEFAULT_MAX_TOKENS,
  generateObjectWithRepair,
  parseJsonWithSchema,
  schemaToPromptHint,
} from './generate-with-repair.js';
import type { DynamicListsFile, ScenarioFeedback, ToolAnnotation, TestScenario } from './types.js';

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
 * Builds the stable system prompt portion for the scenario generator.
 * Contains: role preamble, constitution, annotations, system config, and instructions.
 * This is the cacheable part.
 */
export function buildGeneratorSystemPrompt(
  constitutionText: string,
  annotations: ToolAnnotation[],
  sandboxDirectory: string,
  permittedDirectories?: string[],
  dynamicLists?: DynamicListsFile,
): string {
  const annotationsSummary = annotations
    .map((a) => {
      const argsDesc = Object.entries(a.args)
        .map(([name, roles]) => `${name}: [${roles.join(', ')}]`)
        .join(', ');
      return `  ${a.serverName}/${a.toolName}: ${a.comment}, sideEffects=${a.sideEffects}, args={${argsDesc || 'none'}}`;
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
5. **Side-effect-free tools**: tools with no path arguments (should be allowed)
6. **Move operations**: all moves involve a delete-path role on the source argument
7. **Domain-based operations**: if any tools have URL roles (fetch-url, git-remote-url), generate scenarios for allowed domains, disallowed domains, and named remote resolution

The three possible decisions are:
- "allow" — explicitly permitted by the constitution
- "deny" — categorically forbidden by the constitution
- "escalate" — not explicitly permitted and not forbidden; requires human approval

**Meta-Rule:** If an operation is outside the sandbox and the Constitution does NOT explicitly forbid it (destruction) and does NOT explicitly allow it, the expected decision MUST be \`escalate\`. Never default to \`deny\` for unknown paths.

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

export async function generateScenarios(
  constitutionText: string,
  annotations: ToolAnnotation[],
  handwrittenScenarios: TestScenario[],
  sandboxDirectory: string,
  llm: LanguageModel,
  permittedDirectories?: string[],
  onProgress?: (message: string) => void,
  system?: string | SystemModelMessage,
  dynamicLists?: DynamicListsFile,
): Promise<TestScenario[]> {
  const serverNames = [...new Set(annotations.map((a) => a.serverName))] as [string, ...string[]];
  const toolNames = [...new Set(annotations.map((a) => a.toolName))] as [string, ...string[]];
  const schema = buildGeneratorResponseSchema(serverNames, toolNames);

  const effectiveSystem =
    system ??
    buildGeneratorSystemPrompt(constitutionText, annotations, sandboxDirectory, permittedDirectories, dynamicLists);

  const { output } = await generateObjectWithRepair({
    model: llm,
    schema,
    system: effectiveSystem,
    prompt: 'Generate test scenarios following the instructions above.',
    onProgress,
  });

  // Mark all LLM-generated scenarios with source: 'generated'
  const generated: TestScenario[] = output.scenarios.map((s) => ({
    ...s,
    source: 'generated' as const,
  }));

  // Deduplicate: remove generated scenarios that are substantially
  // similar to handwritten ones
  const unique = generated.filter((g) => !handwrittenScenarios.some((h) => areSimilar(g, h)));

  // Handwritten first, then generated
  return [...handwrittenScenarios, ...unique];
}

// ---------------------------------------------------------------------------
// Multi-Turn Scenario Generator Session
// ---------------------------------------------------------------------------

const INITIAL_USER_MESSAGE = 'Generate test scenarios following the instructions above.';

/**
 * Formats feedback from the verify-repair loop into a user message
 * for the next turn of the scenario generator conversation.
 */
export function formatFeedbackMessage(feedback: ScenarioFeedback): string {
  const sections: string[] = [];

  if (feedback.corrections.length > 0) {
    const lines = feedback.corrections.map(
      (c) => `- "${c.scenarioDescription}": correct decision is ${c.correctedDecision} (${c.correctedReasoning})`,
    );
    sections.push(
      '## Corrected Scenarios\n\n' +
        'These scenarios had wrong expectedDecision values. The verifier determined the correct decisions:\n\n' +
        lines.join('\n'),
    );
  }

  if (feedback.discardedScenarios.length > 0) {
    const lines = feedback.discardedScenarios.map(
      (d) => `- "${d.scenario.description}": ${d.rule} always returns ${d.actual}`,
    );
    sections.push(
      '## Discarded Scenarios (Structural Conflicts)\n\n' +
        'These scenarios conflict with hardcoded structural invariants and were removed. Do NOT regenerate them:\n\n' +
        lines.join('\n'),
    );
  }

  if (feedback.probeScenarios.length > 0) {
    const lines = feedback.probeScenarios.map(
      (p) =>
        `- ${p.request.serverName}/${p.request.toolName} ${JSON.stringify(p.request.arguments)} -> ${p.expectedDecision}`,
    );
    sections.push(
      '## Coverage Gaps Found by Verifier\n\n' +
        'The verifier generated probe scenarios that found gaps. Consider these areas:\n\n' +
        lines.join('\n'),
    );
  }

  return (
    sections.join('\n\n') +
    '\n\nGenerate replacement scenarios for the corrected and discarded ones above. ' +
    'Keep your new scenarios consistent with the corrections. ' +
    'Do not repeat discarded scenarios or reproduce the original wrong expectations.\n'
  );
}

/**
 * A stateful multi-turn wrapper around the scenario generator.
 *
 * Maintains a conversation history so that feedback from the verify-repair
 * loop (corrections, discarded scenarios, probes) can be communicated to
 * the LLM in follow-up turns. The system prompt is fixed at construction
 * and never changes, enabling prompt caching.
 *
 * Lifecycle:
 *   1. Construct with system prompt and config (once per pipeline run)
 *   2. Call generate() for the initial scenario set
 *   3. After verification, call regenerate(feedback) with repair feedback
 *   4. Session is GC'd when the pipeline finishes (no explicit close needed)
 */
export class ScenarioGeneratorSession {
  private readonly systemPrompt: string | SystemModelMessage;
  private readonly model: LanguageModel;
  private readonly schema: ReturnType<typeof buildGeneratorResponseSchema>;
  private readonly handwrittenScenarios: TestScenario[];
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private readonly schemaHint: string;
  private turns = 0;

  constructor(options: {
    system: string | SystemModelMessage;
    model: LanguageModel;
    annotations: ToolAnnotation[];
    handwrittenScenarios: TestScenario[];
  }) {
    this.systemPrompt = options.system;
    this.model = options.model;
    this.handwrittenScenarios = options.handwrittenScenarios;

    const serverNames = [...new Set(options.annotations.map((a) => a.serverName))] as [string, ...string[]];
    const toolNames = [...new Set(options.annotations.map((a) => a.toolName))] as [string, ...string[]];
    this.schema = buildGeneratorResponseSchema(serverNames, toolNames);
    this.schemaHint = schemaToPromptHint(this.schema);
  }

  /**
   * Initial generation: sends the first user message and returns scenarios.
   * Semantically equivalent to the existing single-shot generateScenarios().
   */
  async generate(onProgress?: (message: string) => void): Promise<TestScenario[]> {
    const userMessage = INITIAL_USER_MESSAGE + this.schemaHint;
    this.history.push({ role: 'user', content: userMessage });

    onProgress?.('Generating scenarios...');

    const result = await generateText({
      model: this.model,
      system: this.systemPrompt,
      messages: this.history,
      maxOutputTokens: DEFAULT_MAX_TOKENS,
    });

    this.history.push({ role: 'assistant', content: result.text });
    this.turns++;

    const output = parseJsonWithSchema(result.text, this.schema);
    const generated: TestScenario[] = output.scenarios.map((s) => ({
      ...s,
      source: 'generated' as const,
    }));

    // Deduplicate against handwritten scenarios
    const unique = generated.filter((g) => !this.handwrittenScenarios.some((h) => areSimilar(g, h)));
    return [...this.handwrittenScenarios, ...unique];
  }

  /**
   * Follow-up generation: feeds back corrections and requests replacement
   * scenarios for the ones that were wrong.
   *
   * Returns ONLY the new/replacement scenarios (not handwritten, not
   * previously-generated-and-still-valid ones). The caller is responsible
   * for merging these into the full scenario set.
   */
  async regenerate(feedback: ScenarioFeedback, onProgress?: (message: string) => void): Promise<TestScenario[]> {
    const feedbackMessage = formatFeedbackMessage(feedback) + this.schemaHint;
    this.history.push({ role: 'user', content: feedbackMessage });

    onProgress?.(`Regenerating scenarios (turn ${this.turns + 1})...`);

    const result = await generateText({
      model: this.model,
      system: this.systemPrompt,
      messages: this.history,
      maxOutputTokens: DEFAULT_MAX_TOKENS,
    });

    this.history.push({ role: 'assistant', content: result.text });
    this.turns++;

    const output = parseJsonWithSchema(result.text, this.schema);
    return output.scenarios.map((s) => ({
      ...s,
      source: 'generated' as const,
    }));
  }

  /** Returns the number of turns completed so far. */
  get turnCount(): number {
    return this.turns;
  }
}
