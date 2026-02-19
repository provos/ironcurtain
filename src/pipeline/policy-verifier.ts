/**
 * Policy Verifier -- Multi-round verification with real engine execution
 * and LLM judge.
 *
 * The verifier instantiates a real PolicyEngine, runs test scenarios through
 * it, and uses an LLM judge to analyze results, identify gaps, and generate
 * additional probe scenarios. Up to maxRounds iterations.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { generateObjectWithRepair } from './generate-with-repair.js';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../types/mcp.js';
import type {
  CompiledPolicyFile,
  ToolAnnotationsFile,
  TestScenario,
  ExecutionResult,
  VerifierRound,
  VerificationResult,
  AttributedFailure,
  ScenarioCorrection,
} from './types.js';

const DEFAULT_MAX_ROUNDS = 3;

export function executeScenarios(
  engine: PolicyEngine,
  scenarios: TestScenario[],
): ExecutionResult[] {
  return scenarios.map(scenario => {
    const request: ToolCallRequest = {
      requestId: `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      serverName: scenario.request.serverName,
      toolName: scenario.request.toolName,
      arguments: scenario.request.arguments,
      timestamp: new Date().toISOString(),
    };
    const result = engine.evaluate(request);
    return {
      scenario,
      actualDecision: result.decision,
      matchingRule: result.rule,
      pass: result.decision === scenario.expectedDecision,
    };
  });
}

export function formatExecutionResults(results: ExecutionResult[]): string {
  return results.map((r, i) => {
    const status = r.pass ? 'PASS' : 'FAIL';
    return [
      `[${i + 1}] ${status}: ${r.scenario.description}`,
      `  Tool: ${r.scenario.request.serverName}/${r.scenario.request.toolName}`,
      `  Args: ${JSON.stringify(r.scenario.request.arguments)}`,
      `  Expected: ${r.scenario.expectedDecision}`,
      `  Actual: ${r.actualDecision} (rule: ${r.matchingRule})`,
      `  Source: ${r.scenario.source}`,
    ].join('\n');
  }).join('\n\n');
}

function buildJudgePrompt(
  constitutionText: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
  protectedPaths: string[],
  executionResults: ExecutionResult[],
  roundNumber: number,
  previousAnalysis?: string,
  availableTools?: { serverName: string; toolName: string }[],
): string {
  const rulesText = compiledPolicy.rules
    .map((r, i) => `  ${i + 1}. [${r.name}] if: ${JSON.stringify(r.if)} then: ${r.then} -- ${r.reason}`)
    .join('\n');

  const resultsText = formatExecutionResults(executionResults);
  const previousContext = previousAnalysis
    ? `\n## Previous Round Analysis\n\n${previousAnalysis}\n`
    : '';

  return `You are a security policy verifier. Analyze whether the compiled policy correctly implements the constitution.

## Constitution

${constitutionText}

## Compiled Policy Rules (evaluated in order, first match wins)

${rulesText}

## Structural Invariants (hardcoded, evaluated before compiled rules)

- Unknown tools (no annotation): denied
- Protected paths (any write/delete targeting these is automatically denied):
${protectedPaths.map(p => `  - ${p}`).join('\n')}

A \`deny\` result for write/delete operations on these paths is correct structural behavior, not a policy gap. Files with similar names inside the sandbox are NOT protected.

## Execution Results (Round ${roundNumber})
${previousContext}
${resultsText}

## Decision Types

The three possible policy decisions are:
- **allow** — the operation is explicitly permitted by the constitution
- **deny** — the operation is categorically forbidden by the constitution (absolute prohibition)
- **escalate** — the operation is not explicitly permitted but also not forbidden; it requires human approval

When analyzing FAIL results, pay attention to whether the constitution implies "deny" vs "escalate". If the constitution does not explicitly forbid an operation, the correct decision is typically "escalate" (not "deny") so a human can make the judgment call.

## Instructions

1. Analyze any FAIL results. For each failure, determine the blame:
   - **"rule"**: The compiled rule is wrong and needs to be fixed. The scenario expectation correctly reflects the constitution.
   - **"scenario"**: The scenario expectation is wrong. The compiled rule is correct per the constitution. Provide the corrected expectedDecision and reasoning.
   - **"both"**: The rule needs adjustment AND the scenario expectation is wrong. Provide the corrected expectedDecision and reasoning.
2. Identify suspicious patterns (e.g., a broad allow rule shadowing a narrow deny, or "deny" used where "escalate" would be more appropriate).
3. Identify missing coverage -- scenarios the constitution implies that were not tested.
4. If you suspect gaps, generate additional test scenarios to probe them.
5. Set "pass" to true ONLY if all results are correct and coverage is adequate.
6. Return a "failureAttributions" entry for EVERY FAIL result. The scenarioDescription must exactly match the FAIL scenario's description.

For additional scenarios, use concrete paths matching the directories in the compiled rules. Note: sandbox containment is handled by a structural invariant before compiled rules run — any tool call where all paths are within the sandbox directory is automatically allowed.

## Available Tools

IMPORTANT: Only use these exact server/tool combinations in additional scenarios. Do NOT invent tool names.

${(availableTools ?? []).map(t => `- ${t.serverName}/${t.toolName}`).join('\n')}

## Response Format

Be concise. Keep the analysis to 2-3 sentences per issue found. Only generate additional scenarios that test genuinely untested gaps -- do not duplicate existing coverage. Limit additional scenarios to at most 5.`;
}

export async function verifyPolicy(
  constitutionText: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
  protectedPaths: string[],
  scenarios: TestScenario[],
  llm: LanguageModel,
  maxRounds: number = DEFAULT_MAX_ROUNDS,
  allowedDirectory?: string,
  onProgress?: (message: string) => void,
): Promise<VerificationResult> {
  const engine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths, allowedDirectory);

  const allAnnotations = Object.values(toolAnnotations.servers).flatMap(s => s.tools);
  const serverNamesList = [...new Set(allAnnotations.map(a => a.serverName))] as [string, ...string[]];
  const toolNamesList = [...new Set(allAnnotations.map(a => a.toolName))] as [string, ...string[]];
  const availableTools = allAnnotations.map(a => ({ serverName: a.serverName, toolName: a.toolName }));

  const blameSchema = z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('rule'),
      reasoning: z.string(),
    }),
    z.object({
      kind: z.literal('scenario'),
      reasoning: z.string(),
      correctedDecision: z.enum(['allow', 'deny', 'escalate']),
      correctedReasoning: z.string(),
    }),
    z.object({
      kind: z.literal('both'),
      reasoning: z.string(),
      correctedDecision: z.enum(['allow', 'deny', 'escalate']),
      correctedReasoning: z.string(),
    }),
  ]);

  const responseSchema = z.object({
    analysis: z.string(),
    pass: z.boolean(),
    failureAttributions: z.array(z.object({
      scenarioDescription: z.string(),
      blame: blameSchema,
    })),
    additionalScenarios: z.array(z.object({
      description: z.string(),
      request: z.object({
        serverName: z.enum(serverNamesList),
        toolName: z.enum(toolNamesList),
        arguments: z.record(z.string(), z.unknown()),
      }),
      expectedDecision: z.enum(['allow', 'deny', 'escalate']),
      reasoning: z.string(),
    })),
  });

  const rounds: VerifierRound[] = [];
  const allFailedScenarios: ExecutionResult[] = [];
  let currentScenarios = scenarios;
  let previousAnalysis: string | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    // Execute scenarios against the real engine
    const executionResults = executeScenarios(engine, currentScenarios);
    const failures = executionResults.filter(r => !r.pass);
    allFailedScenarios.push(...failures);

    // Send results to LLM judge
    const prompt = buildJudgePrompt(
      constitutionText,
      compiledPolicy,
      toolAnnotations,
      protectedPaths,
      executionResults,
      round,
      previousAnalysis,
      availableTools,
    );

    const { output: judgment } = await generateObjectWithRepair({
      model: llm,
      schema: responseSchema,
      prompt,
      onProgress,
    });

    const newScenarios: TestScenario[] = judgment.additionalScenarios.map(s => ({
      ...s,
      source: 'generated' as const,
    }));

    rounds.push({
      round,
      executionResults,
      llmAnalysis: judgment.analysis,
      newScenarios,
      attributedFailures: judgment.failureAttributions,
    });

    previousAnalysis = judgment.analysis;

    // If judge says pass and no new scenarios, we are done
    if (judgment.pass && newScenarios.length === 0) {
      return {
        pass: true,
        rounds,
        summary: judgment.analysis,
        failedScenarios: allFailedScenarios,
      };
    }

    // If no new scenarios to probe, exit the loop
    if (newScenarios.length === 0) break;

    // Run additional scenarios in next round
    currentScenarios = newScenarios;
  }

  // Determine final result based on failed scenarios
  const lastRound = rounds[rounds.length - 1];
  const hasFailures = allFailedScenarios.length > 0;

  return {
    pass: !hasFailures && (lastRound?.llmAnalysis.toLowerCase().includes('pass') ?? false),
    rounds,
    summary: lastRound?.llmAnalysis ?? 'Verification did not complete',
    failedScenarios: allFailedScenarios,
  };
}

// ---------------------------------------------------------------------------
// Structural Conflict Filtering
// ---------------------------------------------------------------------------

export interface DiscardedScenario {
  scenario: TestScenario;
  actual: ExecutionResult['actualDecision'];
  rule: string;
}

/**
 * Filters out scenarios whose expected decision conflicts with a structural
 * invariant result. Structural invariants are ground truth (hardcoded in the
 * engine), so a disagreeing scenario expectation is wrong by definition.
 *
 * Returns the valid scenarios and the discarded ones (with metadata for
 * logging / feedback).
 */
export function filterStructuralConflicts(
  engine: PolicyEngine,
  scenarios: TestScenario[],
): { valid: TestScenario[]; discarded: DiscardedScenario[] } {
  const results = executeScenarios(engine, scenarios);
  const valid: TestScenario[] = [];
  const discarded: DiscardedScenario[] = [];

  for (const result of results) {
    const isStructural = result.matchingRule.startsWith('structural-');
    if (isStructural && !result.pass) {
      discarded.push({
        scenario: result.scenario,
        actual: result.actualDecision,
        rule: result.matchingRule,
      });
    } else {
      valid.push(result.scenario);
    }
  }

  return { valid, discarded };
}

// ---------------------------------------------------------------------------
// Scenario Corrections
// ---------------------------------------------------------------------------

/**
 * Extracts scenario corrections from attributed failures.
 * Only failures blamed on 'scenario' or 'both' produce corrections.
 * Handwritten scenarios are never auto-corrected — they are returned
 * separately as warnings so the caller can reclassify them as rule issues.
 */
export function extractScenarioCorrections(
  attributedFailures: AttributedFailure[],
  scenarios: TestScenario[],
): { corrections: ScenarioCorrection[]; handwrittenWarnings: string[] } {
  const corrections: ScenarioCorrection[] = [];
  const handwrittenWarnings: string[] = [];

  for (const af of attributedFailures) {
    if (af.blame.kind === 'rule') continue;

    const scenario = scenarios.find(s => s.description === af.scenarioDescription);
    if (!scenario) continue;

    if (scenario.source === 'handwritten') {
      handwrittenWarnings.push(
        `Judge blamed scenario "${af.scenarioDescription}" but it is handwritten — treating as rule issue`,
      );
      continue;
    }

    corrections.push({
      scenarioDescription: af.scenarioDescription,
      correctedDecision: af.blame.correctedDecision,
      correctedReasoning: af.blame.correctedReasoning,
    });
  }

  return { corrections, handwrittenWarnings };
}

/**
 * Applies corrections to a scenario list, returning a new array with
 * updated expectedDecision and reasoning for corrected scenarios.
 */
export function applyScenarioCorrections(
  scenarios: TestScenario[],
  corrections: ScenarioCorrection[],
): TestScenario[] {
  const correctionMap = new Map(corrections.map(c => [c.scenarioDescription, c]));

  return scenarios.map(s => {
    const correction = correctionMap.get(s.description);
    if (!correction) return s;
    return {
      ...s,
      expectedDecision: correction.correctedDecision,
      reasoning: correction.correctedReasoning,
    };
  });
}
