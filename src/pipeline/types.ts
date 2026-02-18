/**
 * Shared types for the policy compilation pipeline.
 *
 * These types define the structure of the three persistent artifacts
 * produced by `compile-policy`: tool annotations, compiled policy rules,
 * and test scenarios. They are also used by the refactored PolicyEngine
 * at runtime.
 */

// ---------------------------------------------------------------------------
// Tool Annotations
// ---------------------------------------------------------------------------

export type ArgumentRole = 'read-path' | 'write-path' | 'delete-path' | 'none';

export interface ToolAnnotation {
  toolName: string;
  serverName: string;
  comment: string;
  sideEffects: boolean;
  args: Record<string, ArgumentRole[]>;
}

export interface ToolAnnotationsFile {
  generatedAt: string;
  servers: Record<string, { inputHash: string; tools: ToolAnnotation[] }>;
}

// ---------------------------------------------------------------------------
// Compiled Policy
// ---------------------------------------------------------------------------

export interface PathCondition {
  roles: ArgumentRole[];
  within: string;
}

export interface CompiledRuleCondition {
  roles?: ArgumentRole[];
  server?: string[];
  tool?: string[];
  sideEffects?: boolean;
  paths?: PathCondition;
}

export interface CompiledRule {
  name: string;
  description: string;
  principle: string;
  if: CompiledRuleCondition;
  then: 'allow' | 'deny' | 'escalate';
  reason: string;
}

export interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;
  rules: CompiledRule[];
}

// ---------------------------------------------------------------------------
// Test Scenarios
// ---------------------------------------------------------------------------

export interface TestScenario {
  description: string;
  request: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  expectedDecision: 'allow' | 'deny' | 'escalate';
  reasoning: string;
  source: 'generated' | 'handwritten';
}

export interface TestScenariosFile {
  generatedAt: string;
  constitutionHash: string;
  scenarios: TestScenario[];
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  scenario: TestScenario;
  actualDecision: 'allow' | 'deny' | 'escalate';
  matchingRule: string;
  pass: boolean;
}

export interface VerifierRound {
  round: number;
  executionResults: ExecutionResult[];
  llmAnalysis: string;
  newScenarios: TestScenario[];
}

export interface VerificationResult {
  pass: boolean;
  rounds: VerifierRound[];
  summary: string;
  failedScenarios: ExecutionResult[];
}

// ---------------------------------------------------------------------------
// Structural Config (passed to PolicyEngine, not compiled)
// ---------------------------------------------------------------------------

export interface StructuralConfig {
  protectedPaths: string[];
}
