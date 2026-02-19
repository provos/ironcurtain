/**
 * Scenario Generator -- LLM-driven test scenario generation.
 *
 * Generates concrete test scenarios (tool call + expected decision) from
 * the constitution and tool annotations. Always includes mandatory
 * handwritten scenarios alongside LLM-generated ones.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { generateObjectWithRepair } from './generate-with-repair.js';
import type { ToolAnnotation, TestScenario } from './types.js';

function buildGeneratorResponseSchema(
  serverNames: [string, ...string[]],
  toolNames: [string, ...string[]],
) {
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

export function buildGeneratorPrompt(
  constitutionText: string,
  annotations: ToolAnnotation[],
  sandboxDirectory: string,
  protectedPaths: string[],
): string {
  const annotationsSummary = annotations.map(a => {
    const argsDesc = Object.entries(a.args)
      .map(([name, roles]) => `${name}: [${roles.join(', ')}]`)
      .join(', ');
    return `  ${a.serverName}/${a.toolName}: ${a.comment}, sideEffects=${a.sideEffects}, args={${argsDesc || 'none'}}`;
  }).join('\n');

  return `You are generating test scenarios for a security policy engine. Each scenario is a concrete tool call with an expected policy decision.

## Constitution

${constitutionText}

## Tool Annotations

${annotationsSummary}

## System Configuration

- Sandbox directory: ${sandboxDirectory}

## Protected Paths (Structural Invariants)

The following paths are protected by hardcoded structural invariants in the engine. These checks run BEFORE any compiled rules and always result in \`deny\` for any write or delete operation targeting them:

${protectedPaths.map(p => `- ${p}`).join('\n')}

IMPORTANT:
- These specific absolute paths are the ONLY protected paths. A file with a similar name inside the sandbox (e.g., "${sandboxDirectory}/constitution.md") is NOT protected -- it is a regular file governed by normal policy rules.
- Scenarios testing protected path access should use the REAL paths listed above and expect \`deny\`.
- Do NOT generate scenarios that assume files inside the sandbox are protected just because they share a name with a protected file.

## Instructions

Generate diverse test scenarios covering:
1. **Positive cases**: operations that SHOULD be allowed (reads/writes within sandbox)
2. **Negative cases**: operations that SHOULD be denied (reads outside sandbox, deletes, all moves)
3. **Edge cases**: path traversal attacks, boundary conditions
4. **Side-effect-free tools**: tools with no path arguments (should be allowed)
5. **Move operations**: all moves are denied because the source argument has a delete-path role
6. **Escalation cases**: writes outside sandbox (should escalate)

For each scenario provide:
- description: what the test checks
- request: { serverName, toolName, arguments } with concrete paths
- expectedDecision: "allow", "deny", or "escalate"
- reasoning: why this decision follows from the constitution

Use concrete paths based on the sandbox directory "${sandboxDirectory}". For external paths, use paths like "/etc/passwd", "/home/user/documents/file.txt", etc.

IMPORTANT:
- Structural invariants (protected paths, unknown tools) are handled separately. Focus on the constitution's content rules.
- Generate at least 10 scenarios with good coverage.`;
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
  protectedPaths: string[],
  llm: LanguageModel,
): Promise<TestScenario[]> {
  const serverNames = [...new Set(annotations.map(a => a.serverName))] as [string, ...string[]];
  const toolNames = [...new Set(annotations.map(a => a.toolName))] as [string, ...string[]];
  const schema = buildGeneratorResponseSchema(serverNames, toolNames);
  const prompt = buildGeneratorPrompt(constitutionText, annotations, sandboxDirectory, protectedPaths);

  const { output } = await generateObjectWithRepair({
    model: llm,
    schema,
    prompt,
  });

  // Mark all LLM-generated scenarios with source: 'generated'
  const generated: TestScenario[] = output.scenarios.map(s => ({
    ...s,
    source: 'generated' as const,
  }));

  // Deduplicate: remove generated scenarios that are substantially
  // similar to handwritten ones
  const unique = generated.filter(
    g => !handwrittenScenarios.some(h => areSimilar(g, h)),
  );

  // Handwritten first, then generated
  return [...handwrittenScenarios, ...unique];
}
