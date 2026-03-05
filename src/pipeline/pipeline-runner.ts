/**
 * PipelineRunner -- Encapsulates the full policy compilation pipeline.
 *
 * Provides a reusable abstraction over the compile-verify-repair loop.
 * Used by both:
 * - compile.ts CLI (constitutionKind: 'constitution')
 * - compileTaskPolicy() (constitutionKind: 'task-policy')
 *
 * The two constitutionKind variants differ only in the LLM prompt:
 * - 'constitution': broad-principle compilation from a constitution doc
 * - 'task-policy': whitelist-generation from an English task description
 */

import { resolve } from 'node:path';
import type { LanguageModel, SystemModelMessage } from 'ai';
import chalk from 'chalk';
import { extractServerDomainAllowlists } from '../config/index.js';
import type { MCPServerConfig } from '../config/types.js';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import {
  buildCompilerSystemPrompt,
  ConstitutionCompilerSession,
  validateCompiledRules,
} from './constitution-compiler.js';
import { getHandwrittenScenarios } from './handwritten-scenarios.js';
import { resolveAllLists, type McpServerConnection } from './list-resolver.js';
import {
  computeHash,
  loadExistingArtifact,
  loadToolAnnotationsFile,
  mergeReplacements,
  resolveRulePaths,
  writeArtifact,
  withSpinner,
  showCached,
  createPipelineLlm,
} from './pipeline-shared.js';
import {
  applyScenarioCorrections,
  buildJudgeSystemPrompt,
  extractScenarioCorrections,
  filterStructuralConflicts,
  PolicyVerifierSession,
  verifyPolicy,
} from './policy-verifier.js';
import { buildGeneratorSystemPrompt, ScenarioGeneratorSession } from './scenario-generator.js';
import type { LlmLogContext } from './llm-logger.js';
import type { PromptCacheStrategy } from '../session/prompt-cache.js';
import { connectMcpServersForLists, disconnectMcpServers } from './mcp-connections.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DiscardedScenario,
  DynamicListsFile,
  ListDefinition,
  RepairContext,
  ScenarioFeedback,
  TestScenario,
  TestScenariosFile,
  ToolAnnotation,
  ToolAnnotationsFile,
  VerificationResult,
} from './types.js';

/**
 * Selects the LLM prompt variant for policy compilation.
 *
 * - 'constitution': broad-principle compilation from a constitution document.
 * - 'task-policy': whitelist-generation from an English task description.
 */
export type ConstitutionKind = 'constitution' | 'task-policy';

/**
 * Configuration for a single pipeline run.
 */
export interface PipelineRunConfig {
  /** The input text for compilation. */
  readonly constitutionInput: string;

  /** Controls which LLM prompt variant is used. */
  readonly constitutionKind: ConstitutionKind;

  /** Directory where compiled-policy.json and test-scenarios.json are written. */
  readonly outputDir: string;

  /** Directory where tool-annotations.json is read from. */
  readonly toolAnnotationsDir: string;

  /** Fallback directory for tool-annotations.json (package-bundled defaults). */
  readonly toolAnnotationsFallbackDir?: string;

  /** Sandbox boundary for structural invariant checks. */
  readonly allowedDirectory: string;

  /** Protected paths for structural invariant injection. */
  readonly protectedPaths: string[];

  /** MCP server configs (for domain allowlist extraction). */
  readonly mcpServers?: Record<string, MCPServerConfig>;

  /** Path to write LLM interaction logs. */
  readonly llmLogPath?: string;

  /**
   * Whether to include handwritten scenarios in verification.
   * Default true for 'constitution', false for 'task-policy'.
   */
  readonly includeHandwrittenScenarios?: boolean;

  /** Progress callback for CLI output. */
  readonly onProgress?: (message: string) => void;

  /** Pre-loaded tool annotations (avoids re-reading from disk). */
  readonly preloadedToolAnnotations?: ToolAnnotationsFile;
}

/**
 * LLM model references shared across pipeline runs.
 * Thin wrapper around PipelineLlm with a renamed field for clarity.
 */
export interface PipelineModels {
  readonly compilationModel: LanguageModel;
  readonly cacheStrategy: PromptCacheStrategy;
  readonly logContext: LlmLogContext;
  readonly logPath: string;
}

/** Creates PipelineModels from user config. Delegates to shared createPipelineLlm. */
export async function createPipelineModels(logDir?: string): Promise<PipelineModels> {
  const effectiveLogDir = logDir ?? resolve(process.cwd(), 'generated');
  const llm = await createPipelineLlm(effectiveLogDir, 'unknown');
  return {
    compilationModel: llm.model,
    cacheStrategy: llm.cacheStrategy,
    logContext: llm.logContext,
    logPath: llm.logPath,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computePolicyHash(systemPrompt: string, annotations: ToolAnnotation[]): string {
  return computeHash(systemPrompt, JSON.stringify(annotations));
}

function computeScenariosHash(systemPrompt: string, handwrittenScenarios: TestScenario[]): string {
  return computeHash(systemPrompt, JSON.stringify(handwrittenScenarios));
}

function extractPermittedDirectories(rules: CompiledRule[]): string[] {
  const dirs = new Set<string>();
  for (const rule of rules) {
    if (rule.if.paths?.within) {
      dirs.add(rule.if.paths.within);
    }
  }
  return [...dirs].sort();
}

function collectProbeScenarios(result: VerificationResult): TestScenario[] {
  return result.rounds.flatMap((round) => round.newScenarios);
}

function filterAndLogStructuralConflicts(
  engine: PolicyEngine,
  scenarios: TestScenario[],
  label: string = 'Discarded scenario (structural conflict)',
): { valid: TestScenario[]; discarded: DiscardedScenario[] } {
  const { valid, discarded } = filterStructuralConflicts(engine, scenarios);
  for (const d of discarded) {
    const prefix =
      d.scenario.source === 'handwritten'
        ? chalk.yellow('Warning: handwritten scenario conflicts with structural invariant:')
        : chalk.dim(`${label}:`);
    console.error(`  ${prefix} "${d.scenario.description}" — ${d.rule} always returns ${d.actual}`);
  }
  return { valid, discarded };
}

class RuleValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super('Compiled rule validation failed');
    this.name = 'RuleValidationError';
  }
}

function validateRulesOrThrow(rules: CompiledRule[], listDefinitions: ListDefinition[] = []): void {
  const ruleValidation = validateCompiledRules(rules, listDefinitions);
  if (ruleValidation.warnings.length > 0) {
    for (const w of ruleValidation.warnings) {
      console.error(`  ${chalk.yellow('Warning:')} ${w}`);
    }
  }
  if (!ruleValidation.valid) {
    throw new RuleValidationError(ruleValidation.errors);
  }
}

function buildPolicyArtifact(
  constitutionHash: string,
  rules: CompiledRule[],
  listDefinitions: ListDefinition[],
  inputHash: string,
): CompiledPolicyFile {
  const artifact: CompiledPolicyFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash,
    rules,
  };
  if (listDefinitions.length > 0) {
    artifact.listDefinitions = listDefinitions;
  }
  return artifact;
}

/**
 * Builds the task-policy system prompt for per-job compilation.
 * Instructs the LLM to generate a strict whitelist from the task.
 */
function buildTaskCompilerSystemPrompt(
  taskDescription: string,
  annotations: ToolAnnotation[],
  protectedPaths: string[],
  allowedDirectory: string,
): string {
  const annotationsSummary = annotations
    .map((a) => {
      const argsDesc = Object.entries(a.args)
        .map(([name, roles]) => `    ${name}: [${roles.join(', ')}]`)
        .join('\n');
      return `  ${a.serverName}/${a.toolName}: ${a.comment}, sideEffects=${a.sideEffects}\n    args:\n${argsDesc || '    (none)'}`;
    })
    .join('\n');

  return `You are compiling a task-scoped security policy for an automated scheduled job. The job runs unattended on a schedule. Your goal is to generate the MINIMUM set of policy rules required for this specific task -- nothing more.

## Task Description

${taskDescription}

## Tool Annotations

These are the available tools and their classified capabilities:

${annotationsSummary}

## Structural Invariants (handled automatically -- do NOT generate rules for these)

1. **Protected paths** -- reads/writes/deletes to these paths are automatically denied:
${protectedPaths.map((p) => `- ${p}`).join('\n')}

2. **Workspace containment** -- operations within the job's workspace (${allowedDirectory}) are automatically allowed.

3. **Default deny** -- if no compiled rule matches, the operation is DENIED. You do NOT need catch-all rules.

## Instructions

Generate an ORDERED list of policy rules (first match wins) that allow EXACTLY the operations this task needs. Be a strict whitelist:

1. **Allow** operations the task explicitly describes or clearly requires.
   - "label each issue by type" -> allow github.add_label
   - "add a comment" -> allow github.create_comment
   - "close issues with no response for 30+ days" -> allow github.close_issue (the task explicitly authorizes this)

2. **Escalate** operations that are consequential AND only implicitly needed.
   - If the task says "fix bugs" but doesn't mention specific files, escalate write operations.
   - If an operation could cause data loss and the task doesn't explicitly authorize it, escalate.

3. **Omit** operations the task does not need. Default deny handles them.
   - Do NOT generate rules for tools unrelated to the task.
   - Do NOT generate broad "allow all reads" rules unless the task requires broad read access.

4. **Filesystem access**: The agent's workspace is automatically allowed. Only generate rules for filesystem access OUTSIDE the workspace if the task requires it.

5. **Side-effect-free operations**: Reading and listing operations for tools the task uses should generally be allowed. The task cannot operate without discovering available data.

## Rule Format

Produce an ORDERED list of policy rules (first match wins). Each rule has:
- "name": a kebab-case identifier
- "description": what the rule does
- "principle": which task requirement this implements
- "if": conditions that must ALL be true for the rule to fire:
  - "roles": array of argument roles to match. Omit = any tool.
  - "server": array of server names (omit = any server)
  - "tool": array of specific tool names (omit = any matching tool)
  - "sideEffects": match on the tool's sideEffects annotation (omit = don't filter)
  - "paths": path condition with "roles" and "within" (concrete absolute directory)
  - "domains": domain condition with "roles" and "allowed" (list of allowed domain patterns). For git-remote-url roles, use hostname/owner/repo patterns for specific repos (e.g., "github.com/provos/ironcurtain") or hostname-only for any repo on that host (e.g., "github.com"). Git tools with both path and URL roles need "domains" conditions for git-remote-url (path roles get sandbox-resolved separately).
  - "lists": array of list conditions with "roles", "allowed", and "matchType"
- "then": "allow" or "escalate" (deny is implicit via default-deny)
- "reason": human-readable explanation

CRITICAL RULES:
1. Do NOT generate rules for protected path checking, unknown tool denial, or sandbox containment.
2. Use CONCRETE ABSOLUTE paths when needed.
3. Order matters: more specific rules before more general ones.
4. Only output "allow" and "escalate" rules.
5. Be concise in descriptions and reasons -- one sentence each.`;
}

// ---------------------------------------------------------------------------
// PipelineRunner
// ---------------------------------------------------------------------------

/**
 * Encapsulates the full policy compilation pipeline:
 * compile rules -> generate scenarios -> verify -> repair loop.
 */
export class PipelineRunner {
  private readonly model: LanguageModel;
  private readonly cacheStrategy: PromptCacheStrategy;
  private readonly logContext: LlmLogContext;

  constructor(models: PipelineModels) {
    this.model = models.compilationModel;
    this.cacheStrategy = models.cacheStrategy;
    this.logContext = models.logContext;
  }

  /**
   * Runs the full pipeline. Returns the compiled policy on success.
   */
  async run(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
    const toolAnnotationsFile =
      config.preloadedToolAnnotations ??
      loadToolAnnotationsFile(config.toolAnnotationsDir, config.toolAnnotationsFallbackDir);

    if (!toolAnnotationsFile) {
      throw new Error("tool-annotations.json not found. Run 'ironcurtain annotate-tools' first.");
    }

    const allAnnotations = Object.values(toolAnnotationsFile.servers).flatMap((server) => server.tools);
    const serverDomainAllowlists = config.mcpServers ? extractServerDomainAllowlists(config.mcpServers) : undefined;

    const includeHandwritten = config.includeHandwrittenScenarios ?? config.constitutionKind === 'constitution';

    const constitutionHash = computeHash(config.constitutionInput);

    // Build the system prompt based on constitutionKind
    const handwrittenScenarios = includeHandwritten ? getHandwrittenScenarios(config.allowedDirectory) : [];

    const compilerPrompt =
      config.constitutionKind === 'task-policy'
        ? buildTaskCompilerSystemPrompt(
            config.constitutionInput,
            allAnnotations,
            config.protectedPaths,
            config.allowedDirectory,
          )
        : buildCompilerSystemPrompt(
            config.constitutionInput,
            allAnnotations,
            { protectedPaths: config.protectedPaths },
            handwrittenScenarios.length > 0 ? handwrittenScenarios : undefined,
          );

    const compilerHash = computePolicyHash(compilerPrompt, allAnnotations);
    const compilerSystem = this.cacheStrategy.wrapSystemPrompt(compilerPrompt);

    // Load existing artifacts for cache comparison
    const existingPolicy = loadExistingArtifact<CompiledPolicyFile>(config.outputDir, 'compiled-policy.json');
    const existingScenarios = loadExistingArtifact<TestScenariosFile>(config.outputDir, 'test-scenarios.json');

    // Step 1: Compile constitution/task into policy rules
    this.logContext.stepName = 'compile-constitution';
    let {
      rules,
      listDefinitions,
      inputHash,
      session: compilerSession,
    } = await this.compilePolicyRules(allAnnotations, compilerHash, existingPolicy, compilerSystem);

    let compiledPolicyFile = buildPolicyArtifact(constitutionHash, rules, listDefinitions, inputHash);
    writeArtifact(config.outputDir, 'compiled-policy.json', compiledPolicyFile);

    // Resolve dynamic lists if the compiler emitted list definitions
    const hasLists = listDefinitions.length > 0;
    const totalSteps = hasLists ? 4 : 3;
    let dynamicLists: DynamicListsFile | undefined;

    if (hasLists) {
      this.logContext.stepName = 'resolve-lists';
      const existingLists = loadExistingArtifact<DynamicListsFile>(config.outputDir, 'dynamic-lists.json');

      const needsMcp = listDefinitions.some((d) => d.requiresMcp);
      let mcpConnections: Map<string, McpServerConnection> | undefined;
      if (needsMcp && config.mcpServers) {
        mcpConnections = await connectMcpServersForLists(listDefinitions, config.mcpServers);
      }

      const listStepText = `[2/${totalSteps}] Resolving dynamic lists`;
      try {
        const { result: resolvedLists } = await withSpinner(
          listStepText,
          async (spinner) =>
            resolveAllLists(listDefinitions, { model: this.model, mcpConnections }, existingLists, (msg) => {
              spinner.text = `${listStepText} — ${msg}`;
            }),
          (result, elapsed) => {
            const count = Object.keys(result.lists).length;
            return `${listStepText}: ${count} list(s) resolved (${elapsed.toFixed(1)}s)`;
          },
        );
        dynamicLists = resolvedLists;
        writeArtifact(config.outputDir, 'dynamic-lists.json', dynamicLists);
      } finally {
        if (mcpConnections) {
          await disconnectMcpServers(mcpConnections);
        }
      }
    }

    // Extract permitted directories from compiled rules
    const permittedDirectories = extractPermittedDirectories(rules);

    // Step 2: Generate test scenarios
    const scenarioStepLabel = `[${hasLists ? 3 : 2}/${totalSteps}]`;
    this.logContext.stepName = 'generate-scenarios';

    const scenarioPrompt = buildGeneratorSystemPrompt(
      config.constitutionInput,
      allAnnotations,
      config.allowedDirectory,
      permittedDirectories,
      dynamicLists,
    );
    const scenarioHash = computeScenariosHash(scenarioPrompt, handwrittenScenarios);
    const scenarioSystem = this.cacheStrategy.wrapSystemPrompt(scenarioPrompt);

    const scenarioResult = await this.generateTestScenarios(
      allAnnotations,
      config.allowedDirectory,
      handwrittenScenarios,
      scenarioHash,
      existingScenarios,
      scenarioStepLabel,
      scenarioSystem,
    );

    writeArtifact(config.outputDir, 'test-scenarios.json', {
      generatedAt: new Date().toISOString(),
      constitutionHash,
      inputHash: scenarioResult.inputHash,
      scenarios: scenarioResult.scenarios,
    } satisfies TestScenariosFile);

    // Filter scenarios against structural invariants
    const filterEngine = new PolicyEngine(
      compiledPolicyFile,
      toolAnnotationsFile,
      config.protectedPaths,
      config.allowedDirectory,
      undefined,
      dynamicLists,
    );
    const { valid: initialValid, discarded: discardedScenarios } = filterAndLogStructuralConflicts(
      filterEngine,
      scenarioResult.scenarios,
    );
    let filteredScenarios = initialValid;

    // Step 3: Verify compiled policy against scenarios
    const verifyStepLabel = `[${totalSteps}/${totalSteps}]`;
    this.logContext.stepName = 'verify-policy';

    const allAvailableTools = allAnnotations.map((a) => ({ serverName: a.serverName, toolName: a.toolName }));
    const serverNamesList = [...new Set(allAnnotations.map((a) => a.serverName))] as [string, ...string[]];
    const toolNamesList = [...new Set(allAnnotations.map((a) => a.toolName))] as [string, ...string[]];

    let verifierSystem = this.cacheStrategy.wrapSystemPrompt(
      buildJudgeSystemPrompt(
        config.constitutionInput,
        compiledPolicyFile,
        config.protectedPaths,
        allAvailableTools,
        dynamicLists,
        config.allowedDirectory,
      ),
    );
    let verifierSession = new PolicyVerifierSession({
      system: verifierSystem,
      model: this.model,
      serverNames: serverNamesList,
      toolNames: toolNamesList,
    });

    const { result: verificationResultInitial } = await withSpinner(
      `${verifyStepLabel} Verifying policy`,
      async (spinner) =>
        verifyPolicy(
          config.constitutionInput,
          compiledPolicyFile,
          toolAnnotationsFile,
          config.protectedPaths,
          filteredScenarios,
          this.model,
          3,
          config.allowedDirectory,
          (msg) => {
            spinner.text = `${verifyStepLabel} Verifying policy — ${msg}`;
          },
          serverDomainAllowlists,
          dynamicLists,
          verifierSystem,
          verifierSession,
        ),
      (r, elapsed) =>
        r.pass
          ? `${verifyStepLabel} Verified policy: ${r.rounds.length} round(s) (${elapsed.toFixed(1)}s)`
          : `${verifyStepLabel} Verification completed with failures (${elapsed.toFixed(1)}s)`,
    );
    let verificationResult = verificationResultInitial;

    if (!verificationResult.pass) {
      this.logVerboseFailures(verificationResult);
    }

    // Collect probe scenarios from verifier
    const { valid: filteredInitialProbes } = filterAndLogStructuralConflicts(
      filterEngine,
      collectProbeScenarios(verificationResult),
      'Discarded probe (structural conflict)',
    );
    const accumulatedProbes: TestScenario[] = filteredInitialProbes;

    // Compile-verify-repair loop (up to 2 repair attempts)
    const MAX_REPAIRS = 2;
    let repairAttempts = 0;
    let scenarioCorrectionsApplied = 0;

    if (!verificationResult.pass) {
      const baseInputHash = inputHash;

      for (let attempt = 1; attempt <= MAX_REPAIRS; attempt++) {
        console.error('');

        const lastRound = verificationResult.rounds[verificationResult.rounds.length - 1] as
          | (typeof verificationResult.rounds)[number]
          | undefined;
        const judgeAnalysis = lastRound?.llmAnalysis ?? verificationResult.summary;
        const attributedFailures = lastRound?.attributedFailures ?? [];

        const allScenarios = [...scenarioResult.scenarios, ...accumulatedProbes];
        const { corrections, handwrittenWarnings } = extractScenarioCorrections(attributedFailures, allScenarios);

        for (const warning of handwrittenWarnings) {
          console.error(`  ${chalk.yellow('Warning:')} ${warning}`);
        }

        if (corrections.length > 0) {
          scenarioResult.scenarios = applyScenarioCorrections(scenarioResult.scenarios, corrections);
          const correctedProbes = applyScenarioCorrections(accumulatedProbes, corrections);
          accumulatedProbes.splice(0, accumulatedProbes.length, ...correctedProbes);
          scenarioCorrectionsApplied += corrections.length;
          console.error(`  ${chalk.dim(`Corrected ${corrections.length} scenario expectation(s)`)}`);
        }

        // Feed corrections back to the scenario generator session
        const { session: scenarioSession } = scenarioResult;
        if (
          scenarioSession &&
          (corrections.length > 0 || discardedScenarios.length > 0 || accumulatedProbes.length > 0)
        ) {
          const feedback: ScenarioFeedback = {
            corrections,
            discardedScenarios,
            probeScenarios: accumulatedProbes,
          };

          this.logContext.stepName = `repair-regenerate-${attempt}`;
          const regenText = `Repair ${attempt}/${MAX_REPAIRS}: Regenerating scenarios`;
          const { result: replacements } = await withSpinner(
            regenText,
            async (spinner) =>
              scenarioSession.regenerate(feedback, (msg) => {
                spinner.text = `${regenText} — ${msg}`;
              }),
            (r, elapsed) => `${regenText}: ${r.length} replacement(s) (${elapsed.toFixed(1)}s)`,
          );

          scenarioResult.scenarios = mergeReplacements(
            scenarioResult.scenarios,
            replacements,
            corrections,
            discardedScenarios,
          );
        }

        ({ valid: filteredScenarios } = filterAndLogStructuralConflicts(filterEngine, scenarioResult.scenarios));

        const allRuleBlamedFailures = verificationResult.failedScenarios.filter((f) => {
          const attr = attributedFailures.find((a) => a.scenarioDescription === f.scenario.description);
          if (!attr || attr.blame.kind === 'rule' || attr.blame.kind === 'both') return true;
          return handwrittenWarnings.some((w) => w.includes(f.scenario.description));
        });

        if (allRuleBlamedFailures.length > 0) {
          const repairContext: RepairContext = {
            failedScenarios: allRuleBlamedFailures,
            judgeAnalysis,
            attemptNumber: attempt,
            existingListDefinitions: listDefinitions.length > 0 ? listDefinitions : undefined,
            handwrittenScenarios: includeHandwritten ? handwrittenScenarios : undefined,
          };

          this.logContext.stepName = `repair-compile-${attempt}`;
          const repairCompileText = `Repair ${attempt}/${MAX_REPAIRS}: Recompiling`;
          const { result: repairResult } = await withSpinner(
            repairCompileText,
            async (spinner) =>
              this.compilePolicyRulesWithRepair(
                allAnnotations,
                config.protectedPaths,
                baseInputHash,
                repairContext,
                compilerSystem,
                compilerSession,
                (msg) => {
                  spinner.text = `${repairCompileText} — ${msg}`;
                },
              ),
            (r, elapsed) =>
              `Repair ${attempt}/${MAX_REPAIRS}: Recompiled ${r.rules.length} rules (${elapsed.toFixed(1)}s)`,
          );
          rules = repairResult.rules;
          listDefinitions = repairResult.listDefinitions;
          inputHash = repairResult.inputHash;
          compilerSession = repairResult.session;

          // Re-resolve dynamic lists if repair introduced new ones
          if (dynamicLists && listDefinitions.length > 0) {
            const currentLists = dynamicLists;
            const newListDefs = listDefinitions.filter((def) => !(def.name in currentLists.lists));
            if (newListDefs.length > 0) {
              const mcpRequired = newListDefs.filter((d) => d.requiresMcp);
              if (mcpRequired.length > 0) {
                console.error(
                  `  ${chalk.yellow('Warning:')} Repair introduced ${mcpRequired.length} new MCP-requiring list(s) — skipping resolution`,
                );
              }
              const knowledgeDefs = newListDefs.filter((d) => !d.requiresMcp);
              if (knowledgeDefs.length > 0) {
                console.error(`  ${chalk.dim(`Resolving ${knowledgeDefs.length} new list(s) from repair...`)}`);
                const resolved = await resolveAllLists(knowledgeDefs, { model: this.model }, currentLists);
                dynamicLists = {
                  ...resolved,
                  lists: { ...currentLists.lists, ...resolved.lists },
                };
                writeArtifact(config.outputDir, 'dynamic-lists.json', dynamicLists);
              }
            }
          }

          compiledPolicyFile = buildPolicyArtifact(constitutionHash, rules, listDefinitions, inputHash);
          writeArtifact(config.outputDir, 'compiled-policy.json', compiledPolicyFile);

          verifierSystem = this.cacheStrategy.wrapSystemPrompt(
            buildJudgeSystemPrompt(
              config.constitutionInput,
              compiledPolicyFile,
              config.protectedPaths,
              allAvailableTools,
              dynamicLists,
              config.allowedDirectory,
            ),
          );
          verifierSession = new PolicyVerifierSession({
            system: verifierSystem,
            model: this.model,
            serverNames: serverNamesList,
            toolNames: toolNamesList,
          });
        } else {
          console.error(`  ${chalk.dim('No rule-blamed failures — skipping recompilation')}`);
        }

        this.logContext.stepName = `repair-verify-${attempt}`;
        const repairScenarios = [...filteredScenarios, ...accumulatedProbes];
        const repairVerifyText = `Repair ${attempt}/${MAX_REPAIRS}: Verifying`;
        const { result: repairVerifyResult } = await withSpinner(
          repairVerifyText,
          async (spinner) =>
            verifyPolicy(
              config.constitutionInput,
              compiledPolicyFile,
              toolAnnotationsFile,
              config.protectedPaths,
              repairScenarios,
              this.model,
              1,
              config.allowedDirectory,
              (msg) => {
                spinner.text = `${repairVerifyText} — ${msg}`;
              },
              serverDomainAllowlists,
              dynamicLists,
              verifierSystem,
              verifierSession,
            ),
          (r, elapsed) =>
            r.pass
              ? `Repair ${attempt}/${MAX_REPAIRS}: Verified (${elapsed.toFixed(1)}s)`
              : `Repair ${attempt}/${MAX_REPAIRS}: ${r.failedScenarios.length} failure(s) (${elapsed.toFixed(1)}s)`,
        );
        verificationResult = repairVerifyResult;

        if (!verificationResult.pass) {
          this.logVerboseFailures(verificationResult);
        }

        const { valid: validRepairProbes } = filterAndLogStructuralConflicts(
          filterEngine,
          collectProbeScenarios(verificationResult),
          'Discarded probe (structural conflict)',
        );
        accumulatedProbes.push(...validRepairProbes);

        repairAttempts = attempt;

        if (verificationResult.pass) {
          // Final full verification
          this.logContext.stepName = 'final-verify';
          const finalScenarios = [...filteredScenarios, ...accumulatedProbes];
          const finalSession = new PolicyVerifierSession({
            system: verifierSystem,
            model: this.model,
            serverNames: serverNamesList,
            toolNames: toolNamesList,
          });
          const { result: finalVerifyResult } = await withSpinner(
            'Final full verification',
            async (spinner) =>
              verifyPolicy(
                config.constitutionInput,
                compiledPolicyFile,
                toolAnnotationsFile,
                config.protectedPaths,
                finalScenarios,
                this.model,
                3,
                config.allowedDirectory,
                (msg) => {
                  spinner.text = `Final full verification — ${msg}`;
                },
                serverDomainAllowlists,
                dynamicLists,
                verifierSystem,
                finalSession,
              ),
            (r, elapsed) =>
              r.pass
                ? `Final full verification: passed (${elapsed.toFixed(1)}s)`
                : `Final full verification: ${r.failedScenarios.length} failure(s) (${elapsed.toFixed(1)}s)`,
          );
          verificationResult = finalVerifyResult;

          const { valid: validFinalProbes } = filterAndLogStructuralConflicts(
            filterEngine,
            collectProbeScenarios(verificationResult),
            'Discarded probe (structural conflict)',
          );
          accumulatedProbes.push(...validFinalProbes);
          break;
        }
      }
    }

    // Re-write scenarios if the repair loop modified them
    if (repairAttempts > 0) {
      writeArtifact(config.outputDir, 'test-scenarios.json', {
        generatedAt: new Date().toISOString(),
        constitutionHash,
        inputHash: scenarioResult.inputHash,
        scenarios: scenarioResult.scenarios,
      } satisfies TestScenariosFile);
    }

    // Summary
    const seenDescriptions = new Set(scenarioResult.scenarios.map((s) => s.description));
    const uniqueProbes = accumulatedProbes.filter((s) => {
      if (seenDescriptions.has(s.description)) return false;
      seenDescriptions.add(s.description);
      return true;
    });

    const totalScenariosTested = filteredScenarios.length + uniqueProbes.length;

    console.error('');
    console.error(`  Rules: ${rules.length}`);
    console.error(`  Scenarios tested: ${totalScenariosTested}`);
    if (discardedScenarios.length > 0) {
      console.error(`  Scenarios discarded (structural conflicts): ${discardedScenarios.length}`);
    }
    if (uniqueProbes.length > 0) {
      console.error(`  Probe scenarios accumulated: ${uniqueProbes.length}`);
    }
    if (repairAttempts > 0) {
      console.error(`  Repair attempts: ${repairAttempts}`);
    }
    if (scenarioCorrectionsApplied > 0) {
      console.error(`  Scenario corrections: ${scenarioCorrectionsApplied}`);
    }
    console.error(`  Artifacts written to: ${chalk.dim(config.outputDir + '/')}`);
    if (config.llmLogPath) {
      console.error(`  LLM interaction log: ${chalk.dim(config.llmLogPath)}`);
    }

    if (!verificationResult.pass) {
      throw new Error('Verification FAILED — artifacts written but policy may need review.');
    }

    console.error('');
    console.error(chalk.green.bold('Policy compilation successful!'));

    return compiledPolicyFile;
  }

  // -----------------------------------------------------------------------
  // Private compilation methods
  // -----------------------------------------------------------------------

  private async compilePolicyRules(
    annotations: ToolAnnotation[],
    inputHash: string,
    existingPolicy: CompiledPolicyFile | undefined,
    system: string | SystemModelMessage,
  ): Promise<{
    rules: CompiledRule[];
    listDefinitions: ListDefinition[];
    inputHash: string;
    session?: ConstitutionCompilerSession;
  }> {
    const stepText = '[1/3] Compiling constitution';

    if (existingPolicy && existingPolicy.inputHash === inputHash) {
      showCached(stepText);
      return {
        rules: resolveRulePaths(existingPolicy.rules),
        listDefinitions: existingPolicy.listDefinitions ?? [],
        inputHash,
      };
    }

    const session = new ConstitutionCompilerSession({
      system,
      model: this.model,
      annotations,
    });

    const { result: compilationOutput } = await withSpinner(
      stepText,
      async (spinner) => {
        const output = await session.compile((msg) => {
          spinner.text = `${stepText} — ${msg}`;
        });
        const compiledRules = resolveRulePaths(output.rules);
        validateRulesOrThrow(compiledRules, output.listDefinitions);
        return { rules: compiledRules, listDefinitions: output.listDefinitions };
      },
      (output, elapsed) => `${stepText}: ${output.rules.length} rules compiled (${elapsed.toFixed(1)}s)`,
    );

    return {
      rules: compilationOutput.rules,
      listDefinitions: compilationOutput.listDefinitions,
      inputHash,
      session,
    };
  }

  private async compilePolicyRulesWithRepair(
    annotations: ToolAnnotation[],
    protectedPaths: string[],
    baseInputHash: string,
    repairContext: RepairContext,
    system: string | SystemModelMessage,
    session: ConstitutionCompilerSession | undefined,
    onProgress?: (message: string) => void,
  ): Promise<{
    rules: CompiledRule[];
    listDefinitions: ListDefinition[];
    inputHash: string;
    session?: ConstitutionCompilerSession;
  }> {
    let output;
    if (session) {
      output = await session.recompile(repairContext, onProgress);
    } else {
      const { compileConstitution } = await import('./constitution-compiler.js');
      output = await compileConstitution(
        '', // Not needed when system prompt is provided
        annotations,
        { protectedPaths },
        this.model,
        repairContext,
        onProgress,
        system,
      );
    }
    const compiledRules = resolveRulePaths(output.rules);
    validateRulesOrThrow(compiledRules, output.listDefinitions);

    return {
      rules: compiledRules,
      listDefinitions: output.listDefinitions,
      inputHash: `${baseInputHash}-repair`,
      session,
    };
  }

  private async generateTestScenarios(
    annotations: ToolAnnotation[],
    allowedDirectory: string,
    handwrittenScenarios: TestScenario[],
    inputHash: string,
    existingScenarios: TestScenariosFile | undefined,
    stepLabel: string,
    system: string | SystemModelMessage,
  ): Promise<{
    scenarios: TestScenario[];
    inputHash: string;
    session?: ScenarioGeneratorSession;
  }> {
    const stepText = `${stepLabel} Generating test scenarios`;

    if (existingScenarios && existingScenarios.inputHash === inputHash) {
      showCached(stepText);
      return { scenarios: existingScenarios.scenarios, inputHash };
    }

    const session = new ScenarioGeneratorSession({
      system,
      model: this.model,
      annotations,
      handwrittenScenarios,
    });

    const { result: scenarios } = await withSpinner(
      stepText,
      async (spinner) =>
        session.generate((msg) => {
          spinner.text = `${stepText} — ${msg}`;
        }),
      (scenarios, elapsed) => {
        const generatedCount = scenarios.length - handwrittenScenarios.length;
        return `${stepText}: ${scenarios.length} scenarios (${handwrittenScenarios.length} handwritten + ${generatedCount} generated) (${elapsed.toFixed(1)}s)`;
      },
    );

    return { scenarios, inputHash, session };
  }

  private logVerboseFailures(result: VerificationResult): void {
    console.error('');
    console.error(chalk.red('Verification FAILED:'));
    console.error(result.summary);
    console.error('');
    for (const f of result.failedScenarios) {
      console.error(`  ${chalk.red('FAIL:')} ${f.scenario.description}`);
      console.error(`    Expected: ${f.scenario.expectedDecision}, Got: ${f.actualDecision} (rule: ${f.matchingRule})`);
    }
  }
}
