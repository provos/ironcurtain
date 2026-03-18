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

// Canonical definition lives in src/types/argument-roles.ts.
// Re-exported here for backward compatibility with pipeline consumers.
import type { ArgumentRole } from '../types/argument-roles.js';
export type { ArgumentRole };
export { isArgumentRole, getArgumentRoleValues } from '../types/argument-roles.js';

// Re-use the runtime decision type under a pipeline-friendly alias.
import type { PolicyDecisionStatus } from '../types/mcp.js';
export type Decision = PolicyDecisionStatus;

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
// Conditional Argument Roles (stored/on-disk format)
// ---------------------------------------------------------------------------

/**
 * A condition on a sibling argument that determines which roles apply.
 * Exactly one of equals/in/is must be set.
 */
export interface RoleCondition {
  readonly arg: string;
  readonly equals?: string | number | boolean;
  readonly in?: ReadonlyArray<string | number | boolean>;
  readonly is?: 'present' | 'absent' | 'truthy' | 'falsy';
}

/**
 * A conditional role assignment: when the condition matches,
 * these roles apply instead of the default.
 */
export interface ConditionalRoleEntry {
  readonly condition: RoleCondition;
  readonly roles: ArgumentRole[];
}

/**
 * Roles for an argument that depend on the values of sibling arguments.
 * The `default` roles apply when no `when` clause matches.
 *
 * Invariant: each `when` entry's `roles` must be a subset of `default`.
 * This ensures conditional resolution can only narrow, never expand.
 */
export interface ConditionalRoles {
  readonly default: ArgumentRole[];
  readonly when: ConditionalRoleEntry[];
}

/**
 * An argument's roles in the stored (on-disk) format: either a static
 * array (backward compatible) or a conditional block with default + when.
 */
export type ArgumentRoleSpec = ArgumentRole[] | ConditionalRoles;

/**
 * A tool annotation as stored in tool-annotations.json.
 * Args may contain conditional role specs that need resolution
 * against actual tool call arguments before use.
 */
export interface StoredToolAnnotation extends Omit<ToolAnnotation, 'args'> {
  args: Record<string, ArgumentRoleSpec>;
}

/**
 * The tool-annotations.json file format.
 * Uses StoredToolAnnotation because the file may contain conditional specs.
 */
export interface StoredToolAnnotationsFile extends Omit<ToolAnnotationsFile, 'servers'> {
  servers: Record<string, { inputHash: string; tools: StoredToolAnnotation[] }>;
}

// ---------------------------------------------------------------------------
// Compiled Policy
// ---------------------------------------------------------------------------

export interface PathCondition {
  roles: ArgumentRole[];
  within: string;
}

export interface DomainCondition {
  roles: ArgumentRole[];
  allowed: string[];
}

export interface ListCondition {
  roles: ArgumentRole[];
  allowed: string[];
  matchType: ListType;
}

export interface CompiledRuleCondition {
  roles?: ArgumentRole[];
  server?: string[];
  tool?: string[];
  sideEffects?: boolean;
  paths?: PathCondition;
  domains?: DomainCondition;
  /** Non-domain list conditions (emails, identifiers). */
  lists?: ListCondition[];
}

export interface CompiledRule {
  name: string;
  description: string;
  principle: string;
  if: CompiledRuleCondition;
  then: Decision;
  reason: string;
}

// ---------------------------------------------------------------------------
// Dynamic Lists
// ---------------------------------------------------------------------------

/**
 * Taxonomy of list value types. Each type determines how values are
 * matched against tool call arguments at evaluation time.
 */
export type ListType = 'domains' | 'emails' | 'identifiers';

/**
 * A symbolic list definition emitted by the constitution compiler.
 * The compiler creates these when it encounters categorical references
 * in the constitution text (e.g., "major news sites", "my contacts").
 *
 * Invariant: the `name` matches the @list-name reference in compiled rules.
 * Invariant: the `type` determines matching semantics at evaluation time.
 */
export interface ListDefinition {
  /** Symbolic name, e.g., "major-news-sites". Used as @major-news-sites in rules. */
  readonly name: string;

  /** Determines matching semantics and value validation. */
  readonly type: ListType;

  /**
   * The constitution text that motivated this list.
   * Used for provenance tracking and display to users.
   */
  readonly principle: string;

  /**
   * Prompt for the resolver LLM to generate concrete values.
   * Written by the compiler LLM based on the constitution context.
   */
  readonly generationPrompt: string;

  /**
   * When true, the resolver should connect to MCP servers to resolve
   * this list. When false, the resolver uses only LLM knowledge.
   */
  readonly requiresMcp: boolean;

  /**
   * Optional: which MCP server to query for data-backed resolution.
   * Only meaningful when requiresMcp is true.
   */
  readonly mcpServerHint?: string;
}

/**
 * A single resolved dynamic list with its values and metadata.
 *
 * The authoritative ListDefinition lives in CompiledPolicyFile.listDefinitions.
 * This type holds only the resolved values and user overrides, avoiding
 * duplication and drift between artifacts.
 */
export interface ResolvedList {
  /** The concrete resolved values. */
  readonly values: string[];

  /**
   * User-supplied additions that are always included regardless
   * of what the resolver produces. Survives refresh cycles.
   */
  readonly manualAdditions: string[];

  /**
   * User-supplied removals that are always excluded regardless
   * of what the resolver produces. Survives refresh cycles.
   */
  readonly manualRemovals: string[];

  /** ISO timestamp of last resolution. */
  readonly resolvedAt: string;

  /** Content hash of inputs that produced this resolution. */
  readonly inputHash: string;
}

/**
 * The dynamic-lists.json artifact.
 */
export interface DynamicListsFile {
  readonly generatedAt: string;
  readonly lists: Record<string, ResolvedList>;
}

export interface CompiledPolicyFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;
  rules: CompiledRule[];

  /** List definitions emitted by the compiler. Empty if no dynamic lists needed. */
  listDefinitions?: ListDefinition[];
}

/**
 * Per-server compiled policy artifact.
 * Written to generated/servers/{serverName}/compiled-policy.json.
 */
export interface ServerCompiledPolicyFile {
  readonly generatedAt: string;
  readonly serverName: string;
  readonly constitutionHash: string;
  readonly inputHash: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions?: ListDefinition[];
}

// ---------------------------------------------------------------------------
// Test Scenarios
// ---------------------------------------------------------------------------

/**
 * Expected decision for a test scenario.
 * 'not-allow' means any non-allow decision (deny or escalate) is acceptable.
 * Used by handwritten scenarios where the exact enforcement mechanism may vary.
 */
export type ScenarioDecision = Decision | 'not-allow';

export interface TestScenario {
  description: string;
  request: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  expectedDecision: ScenarioDecision;
  reasoning: string;
  source: 'generated' | 'handwritten';
}

export interface TestScenariosFile {
  generatedAt: string;
  constitutionHash: string;
  inputHash: string;
  scenarios: TestScenario[];
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  scenario: TestScenario;
  actualDecision: Decision;
  matchingRule: string;
  pass: boolean;
}

export interface DiscardedScenario {
  scenario: TestScenario;
  actual: ExecutionResult['actualDecision'];
  rule: string;
}

export interface VerifierRound {
  round: number;
  executionResults: ExecutionResult[];
  llmAnalysis: string;
  newScenarios: TestScenario[];
  attributedFailures?: AttributedFailure[];
}

export interface VerificationResult {
  pass: boolean;
  rounds: VerifierRound[];
  summary: string;
  failedScenarios: ExecutionResult[];
}

// ---------------------------------------------------------------------------
// Blame Attribution (dual-channel repair)
// ---------------------------------------------------------------------------

export type FailureBlame =
  | { kind: 'rule'; reasoning: string }
  | { kind: 'scenario'; reasoning: string; correctedDecision: Decision; correctedReasoning: string }
  | { kind: 'both'; reasoning: string; correctedDecision: Decision; correctedReasoning: string };

export interface AttributedFailure {
  scenarioDescription: string;
  blame: FailureBlame;
}

export interface ScenarioCorrection {
  scenarioDescription: string;
  correctedDecision: Decision;
  correctedReasoning: string;
}

// ---------------------------------------------------------------------------
// Scenario Feedback (multi-turn scenario generation)
// ---------------------------------------------------------------------------

/**
 * Feedback from the verify-repair loop that should be communicated
 * to the scenario generator on its next turn. Each field is optional;
 * only the feedback that applies to the current repair iteration is set.
 */
export interface ScenarioFeedback {
  /**
   * Scenarios whose expectations were corrected by the verifier judge.
   * The generator should avoid reproducing the original (wrong) expectations.
   */
  readonly corrections: ReadonlyArray<ScenarioCorrection>;

  /**
   * Scenarios discarded because they conflict with structural invariants.
   * The generator should not regenerate scenarios with the same tool+args+expectation.
   */
  readonly discardedScenarios: ReadonlyArray<DiscardedScenario>;

  /**
   * Probe scenarios generated by the verifier that revealed coverage gaps.
   * The generator can use these as hints for what areas need better coverage.
   */
  readonly probeScenarios: ReadonlyArray<TestScenario>;
}

// ---------------------------------------------------------------------------
// Repair Context (compile-verify-repair loop)
// ---------------------------------------------------------------------------

export interface RepairContext {
  failedScenarios: ExecutionResult[];
  judgeAnalysis: string;
  attemptNumber: number;
  existingListDefinitions?: ListDefinition[];
  handwrittenScenarios?: TestScenario[];
}
