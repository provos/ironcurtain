/**
 * Policy Verifier -- Multi-round verification with real engine execution
 * and LLM judge.
 *
 * The verifier instantiates a real PolicyEngine, runs test scenarios through
 * it, and uses an LLM judge to analyze results, identify gaps, and generate
 * additional probe scenarios. Up to maxRounds iterations.
 */

import type { LanguageModel } from 'ai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../types/mcp.js';
import type {
  CompiledPolicyFile,
  ToolAnnotationsFile,
  TestScenario,
  ExecutionResult,
  VerifierRound,
  VerificationResult,
} from './types.js';

const DEFAULT_MAX_ROUNDS = 3;

function buildJudgeResponseSchema(
  serverNames: [string, ...string[]],
  toolNames: [string, ...string[]],
) {
  const additionalScenarioSchema = z.object({
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
    analysis: z.string(),
    pass: z.boolean(),
    additionalScenarios: z.array(additionalScenarioSchema),
  });
}

function executeScenarios(
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

function formatExecutionResults(results: ExecutionResult[]): string {
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

## Instructions

1. Analyze any FAIL results. Is the compiled rule wrong, or is the test expectation wrong?
2. Identify suspicious patterns (e.g., a broad allow rule shadowing a narrow deny).
3. Identify missing coverage -- scenarios the constitution implies that were not tested.
4. If you suspect gaps, generate additional test scenarios to probe them.
5. Set "pass" to true ONLY if all results are correct and coverage is adequate.

For additional scenarios, use concrete paths. The sandbox directory is specified in the compiled rules' "within" fields.`;
}

export async function verifyPolicy(
  constitutionText: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
  protectedPaths: string[],
  scenarios: TestScenario[],
  llm: LanguageModel,
  maxRounds: number = DEFAULT_MAX_ROUNDS,
): Promise<VerificationResult> {
  const engine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths);

  const allAnnotations = Object.values(toolAnnotations.servers).flatMap(s => s.tools);
  const serverNames = [...new Set(allAnnotations.map(a => a.serverName))] as [string, ...string[]];
  const toolNames = [...new Set(allAnnotations.map(a => a.toolName))] as [string, ...string[]];
  const judgeResponseSchema = buildJudgeResponseSchema(serverNames, toolNames);

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
    );

    const { output: judgment } = await generateText({
      model: llm,
      output: Output.object({ schema: judgeResponseSchema }),
      prompt,
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
