/**
 * CLI entry point for `ironcurtain compile-policy`.
 *
 * Orchestrates the policy compilation pipeline (stages 1-3):
 *   1. Compile constitution into declarative rules via LLM
 *   2. Generate test scenarios via LLM
 *   3. Verify compiled policy against real engine + LLM judge
 *
 * Requires tool-annotations.json to exist on disk. Run
 * `npm run annotate-tools` first to generate it.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel, SystemModelMessage } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import chalk from 'chalk';
import { extractServerDomainAllowlists } from '../config/index.js';
import type { MCPServerConfig } from '../config/types.js';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import { resolveRealPath } from '../types/argument-roles.js';
import {
  buildCompilerSystemPrompt,
  compileConstitution,
  ConstitutionCompilerSession,
  validateCompiledRules,
} from './constitution-compiler.js';
import { getHandwrittenScenarios } from './handwritten-scenarios.js';
import { resolveAllLists, type McpServerConnection } from './list-resolver.js';
import {
  computeHash,
  createPipelineLlm,
  loadExistingArtifact,
  loadPipelineConfig,
  showCached,
  writeArtifact,
  withSpinner,
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
import { VERSION } from '../version.js';
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

// ---------------------------------------------------------------------------
// Content-Hash Caching (compile-specific)
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

/**
 * Filters scenarios against structural invariants and logs any discarded ones.
 * Returns the valid scenarios and the full list of discarded scenarios.
 */
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

// ---------------------------------------------------------------------------
// Scenario Merge (multi-turn regeneration)
// ---------------------------------------------------------------------------

/**
 * Merges replacement scenarios from the regeneration session into the
 * scenario list. Removes corrected and discarded scenarios, then adds
 * unique replacements that don't duplicate any remaining scenario.
 */
export function mergeReplacements(
  scenarios: TestScenario[],
  replacements: TestScenario[],
  corrections: ReadonlyArray<{ scenarioDescription: string }>,
  discardedScenarios: ReadonlyArray<DiscardedScenario>,
): TestScenario[] {
  const removedDescriptions = new Set([
    ...corrections.map((c) => c.scenarioDescription),
    ...discardedScenarios.filter((d) => d.scenario.source !== 'handwritten').map((d) => d.scenario.description),
  ]);

  const kept = scenarios.filter((s) => !removedDescriptions.has(s.description));
  const keptDescriptions = new Set(kept.map((s) => s.description));
  const uniqueReplacements = replacements.filter((r) => !keptDescriptions.has(r.description));

  return [...kept, ...uniqueReplacements];
}

// ---------------------------------------------------------------------------
// Path Resolution (post-LLM normalization)
// ---------------------------------------------------------------------------

/**
 * Resolves all `paths.within` values in compiled rules to their real
 * filesystem paths, following symlinks. This ensures that symlinked
 * directories (e.g., ~/Downloads -> /mnt/c/.../Downloads on WSL) are
 * resolved to their canonical form so that runtime path comparisons
 * match correctly.
 *
 * Falls back to path.resolve() if the path does not exist on disk.
 */
export function resolveRulePaths(rules: CompiledRule[]): CompiledRule[] {
  return rules.map((rule) => {
    if (!rule.if.paths?.within) return rule;

    const resolved = resolveRealPath(rule.if.paths.within);
    if (resolved === rule.if.paths.within) return rule;

    return {
      ...rule,
      if: {
        ...rule.if,
        paths: { ...rule.if.paths, within: resolved },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Constitution Compilation (LLM step -- cacheable by constitution + annotations)
// ---------------------------------------------------------------------------

interface CompilationResult {
  rules: CompiledRule[];
  listDefinitions: ListDefinition[];
  inputHash: string;
  /** The session used for compilation; undefined when cache hit. */
  session?: ConstitutionCompilerSession;
}

async function compilePolicyRules(
  constitutionText: string,
  annotations: ToolAnnotation[],
  protectedPaths: string[],
  inputHash: string,
  existingPolicy: CompiledPolicyFile | undefined,
  llm: LanguageModel,
  stepLabel: string = '[1/3]',
  system?: string | SystemModelMessage,
): Promise<CompilationResult> {
  const stepText = `${stepLabel} Compiling constitution`;

  // Check cache: skip LLM call if inputs haven't changed.
  // Still resolve paths in case symlink targets changed since last run.
  if (existingPolicy && existingPolicy.inputHash === inputHash) {
    showCached(stepText);
    return {
      rules: resolveRulePaths(existingPolicy.rules),
      listDefinitions: existingPolicy.listDefinitions ?? [],
      inputHash,
    };
  }

  const session = new ConstitutionCompilerSession({
    system: system ?? buildCompilerSystemPrompt(constitutionText, annotations, { protectedPaths }),
    model: llm,
    annotations,
  });

  const { result: compilationOutput } = await withSpinner(
    stepText,
    async (spinner) => {
      const output = await session.compile((msg) => {
        spinner.text = `${stepText} — ${msg}`;
      });
      const rules = resolveRulePaths(output.rules);
      validateRulesOrThrow(rules, output.listDefinitions);
      return { rules, listDefinitions: output.listDefinitions };
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

async function compilePolicyRulesWithRepair(
  constitutionText: string,
  annotations: ToolAnnotation[],
  protectedPaths: string[],
  baseInputHash: string,
  repairContext: RepairContext,
  llm: LanguageModel,
  onProgress?: (message: string) => void,
  system?: string | SystemModelMessage,
  session?: ConstitutionCompilerSession,
): Promise<CompilationResult> {
  let output;
  if (session) {
    output = await session.recompile(repairContext, onProgress);
  } else {
    output = await compileConstitution(
      constitutionText,
      annotations,
      { protectedPaths },
      llm,
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

// ---------------------------------------------------------------------------
// Artifact Construction (pure data transformation)
// ---------------------------------------------------------------------------

function buildPolicyArtifact(constitutionHash: string, compilationResult: CompilationResult): CompiledPolicyFile {
  const artifact: CompiledPolicyFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: compilationResult.inputHash,
    rules: compilationResult.rules,
  };
  if (compilationResult.listDefinitions.length > 0) {
    artifact.listDefinitions = compilationResult.listDefinitions;
  }
  return artifact;
}

// ---------------------------------------------------------------------------
// Scenario Generation (LLM step -- cacheable by constitution + annotations)
// ---------------------------------------------------------------------------

interface ScenarioResult {
  scenarios: TestScenario[];
  inputHash: string;
  /** The session used for generation; undefined when cache hit. */
  session?: ScenarioGeneratorSession;
}

async function generateTestScenarios(
  constitutionText: string,
  annotations: ToolAnnotation[],
  allowedDirectory: string,
  permittedDirectories: string[],
  inputHash: string,
  existingScenarios: TestScenariosFile | undefined,
  llm: LanguageModel,
  stepLabel: string = '[2/3]',
  system?: string | SystemModelMessage,
): Promise<ScenarioResult> {
  const handwrittenScenarios = getHandwrittenScenarios(allowedDirectory);
  const stepText = `${stepLabel} Generating test scenarios`;

  // Check cache: skip LLM call if inputs haven't changed
  if (existingScenarios && existingScenarios.inputHash === inputHash) {
    showCached(stepText);
    return { scenarios: existingScenarios.scenarios, inputHash };
  }

  // Create a multi-turn session so the repair loop can feed corrections back
  const session = new ScenarioGeneratorSession({
    system: system ?? buildGeneratorSystemPrompt(constitutionText, annotations, allowedDirectory, permittedDirectories),
    model: llm,
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

// ---------------------------------------------------------------------------
// Policy Verification (LLM step)
// ---------------------------------------------------------------------------

async function verifyCompiledPolicy(
  constitutionText: string,
  compiledPolicyFile: CompiledPolicyFile,
  toolAnnotationsFile: ToolAnnotationsFile,
  protectedPaths: string[],
  scenarios: TestScenario[],
  llm: LanguageModel,
  allowedDirectory?: string,
  maxRounds: number = 3,
  verbose: boolean = true,
  onProgress?: (message: string) => void,
  serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>,
  dynamicLists?: DynamicListsFile,
  system?: string | SystemModelMessage,
  session?: PolicyVerifierSession,
): Promise<VerificationResult> {
  const result = await verifyPolicy(
    constitutionText,
    compiledPolicyFile,
    toolAnnotationsFile,
    protectedPaths,
    scenarios,
    llm,
    maxRounds,
    allowedDirectory,
    onProgress,
    serverDomainAllowlists,
    dynamicLists,
    system,
    session,
  );

  if (!result.pass) {
    if (verbose) {
      console.error('');
      console.error(chalk.red('Verification FAILED:'));
      console.error(result.summary);
      console.error('');
      for (const f of result.failedScenarios) {
        console.error(`  ${chalk.red('FAIL:')} ${f.scenario.description}`);
        console.error(
          `    Expected: ${f.scenario.expectedDecision}, Got: ${f.actualDecision} (rule: ${f.matchingRule})`,
        );
      }
    } else {
      console.error(`  ${result.failedScenarios.length} scenario(s) failed.`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Artifact Output
// ---------------------------------------------------------------------------

function writeScenariosArtifact(generatedDir: string, constitutionHash: string, scenarioResult: ScenarioResult): void {
  const scenariosFile: TestScenariosFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: scenarioResult.inputHash,
    scenarios: scenarioResult.scenarios,
  };
  writeArtifact(generatedDir, 'test-scenarios.json', scenariosFile);
}

function writePolicyArtifact(generatedDir: string, compiledPolicyFile: CompiledPolicyFile): void {
  writeArtifact(generatedDir, 'compiled-policy.json', compiledPolicyFile);
}

// ---------------------------------------------------------------------------
// MCP Server Connection for Data-Backed Lists
// ---------------------------------------------------------------------------

/**
 * Connects to MCP servers needed for data-backed list resolution.
 * Only connects to servers hinted by list definitions with requiresMcp: true.
 * Returns a map keyed by server name for the resolver.
 */
export async function connectMcpServersForLists(
  definitions: ListDefinition[],
  mcpServers: Record<string, MCPServerConfig>,
): Promise<Map<string, McpServerConnection>> {
  const mcpDefs = definitions.filter((d) => d.requiresMcp);
  const hasUnhintedLists = mcpDefs.some((d) => !d.mcpServerHint);

  // Connect all configured servers if any list lacks a hint,
  // otherwise connect only the hinted servers.
  const neededServers = hasUnhintedLists
    ? new Set(Object.keys(mcpServers))
    : new Set(
        mcpDefs
          .filter((d): d is typeof d & { mcpServerHint: string } => d.mcpServerHint != null)
          .map((d) => d.mcpServerHint),
      );

  const connections = new Map<string, McpServerConnection>();
  for (const serverName of neededServers) {
    const serverConfig = mcpServers[serverName];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- serverName may not exist in mcpServers at runtime (from mcpServerHint)
    if (!serverConfig) {
      console.error(`  ${chalk.yellow('Warning:')} MCP server "${serverName}" not configured — skipping`);
      continue;
    }

    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: serverConfig.env ? { ...(process.env as Record<string, string>), ...serverConfig.env } : undefined,
      stderr: 'pipe',
    });
    // Drain piped stderr to prevent backpressure
    if (transport.stderr) {
      transport.stderr.on('data', () => {});
    }

    const client = new Client({ name: 'ironcurtain-list-resolver', version: VERSION });
    await client.connect(transport);
    const toolsResult = await client.listTools();

    connections.set(serverName, { client, tools: toolsResult.tools });
  }

  return connections;
}

export async function disconnectMcpServers(connections: Map<string, McpServerConnection>): Promise<void> {
  for (const conn of connections.values()) {
    try {
      await conn.client.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const config = loadPipelineConfig();

  // Load tool annotations from disk (produced by `npm run annotate-tools`)
  const toolAnnotationsFile = loadExistingArtifact<ToolAnnotationsFile>(
    config.generatedDir,
    'tool-annotations.json',
    config.packageGeneratedDir,
  );
  if (!toolAnnotationsFile) {
    console.error(
      chalk.red.bold(
        "Error: tool-annotations.json not found. Run 'npm run annotate-tools' first to generate tool annotations.",
      ),
    );
    process.exit(1);
  }

  // Flatten annotations from all servers
  const allAnnotations = Object.values(toolAnnotationsFile.servers).flatMap((server) => server.tools);

  // Compute domain allowlists for policy verification
  const serverDomainAllowlists = extractServerDomainAllowlists(config.mcpServers);

  console.error(chalk.bold('Policy Compilation Pipeline'));
  console.error(chalk.bold('==========================='));
  console.error(`Constitution: ${chalk.dim(config.constitutionPath)}`);
  console.error(`Sandbox:      ${chalk.dim(config.allowedDirectory)}`);
  console.error(`Output:       ${chalk.dim(config.generatedDir + '/')}`);
  console.error(
    `Annotations:  ${chalk.dim(`${allAnnotations.length} tools from ${Object.keys(toolAnnotationsFile.servers).length} server(s)`)}`,
  );
  console.error('');

  const { model: llm, logContext, logPath, cacheStrategy } = await createPipelineLlm(config.generatedDir, 'unknown');

  // Build raw system prompt and derive hash + cache-wrapped version
  const handwrittenScenarios = getHandwrittenScenarios(config.allowedDirectory);
  const compilerPrompt = buildCompilerSystemPrompt(
    config.constitutionText,
    allAnnotations,
    { protectedPaths: config.protectedPaths },
    handwrittenScenarios,
  );
  const compilerHash = computePolicyHash(compilerPrompt, allAnnotations);
  const compilerSystem = cacheStrategy.wrapSystemPrompt(compilerPrompt);

  // Load existing artifacts for cache comparison
  const existingPolicy = loadExistingArtifact<CompiledPolicyFile>(
    config.generatedDir,
    'compiled-policy.json',
    config.packageGeneratedDir,
  );
  const existingScenarios = loadExistingArtifact<TestScenariosFile>(
    config.generatedDir,
    'test-scenarios.json',
    config.packageGeneratedDir,
  );

  // Compile constitution into policy rules (LLM-cacheable)
  // Step numbering depends on whether list definitions are emitted,
  // so compilation always uses [1/N] and the total is determined after.
  logContext.stepName = 'compile-constitution';
  let compilationResult = await compilePolicyRules(
    config.constitutionText,
    allAnnotations,
    config.protectedPaths,
    compilerHash,
    existingPolicy,
    llm,
    '[1/3]',
    compilerSystem,
  );

  // Build and write policy artifact immediately so it's available for
  // inspection even if verification fails, and cached for next run.
  let compiledPolicyFile = buildPolicyArtifact(config.constitutionHash, compilationResult);
  writePolicyArtifact(config.generatedDir, compiledPolicyFile);

  // Resolve dynamic lists if the compiler emitted list definitions
  const hasLists = compilationResult.listDefinitions.length > 0;
  const totalSteps = hasLists ? 4 : 3;
  let dynamicLists: DynamicListsFile | undefined;

  if (hasLists) {
    logContext.stepName = 'resolve-lists';
    const existingLists = loadExistingArtifact<DynamicListsFile>(
      config.generatedDir,
      'dynamic-lists.json',
      config.packageGeneratedDir,
    );

    // Connect to MCP servers if any list definitions require it
    const needsMcp = compilationResult.listDefinitions.some((d) => d.requiresMcp);
    let mcpConnections: Map<string, McpServerConnection> | undefined;
    if (needsMcp) {
      mcpConnections = await connectMcpServersForLists(compilationResult.listDefinitions, config.mcpServers);
    }

    const listStepText = `[2/${totalSteps}] Resolving dynamic lists`;
    try {
      const { result: resolvedLists } = await withSpinner(
        listStepText,
        async (spinner) =>
          resolveAllLists(compilationResult.listDefinitions, { model: llm, mcpConnections }, existingLists, (msg) => {
            spinner.text = `${listStepText} — ${msg}`;
          }),
        (result, elapsed) => {
          const count = Object.keys(result.lists).length;
          return `${listStepText}: ${count} list(s) resolved (${elapsed.toFixed(1)}s)`;
        },
      );
      dynamicLists = resolvedLists;
      writeArtifact(config.generatedDir, 'dynamic-lists.json', dynamicLists);
    } finally {
      if (mcpConnections) {
        await disconnectMcpServers(mcpConnections);
      }
    }
  }

  // Extract permitted directories from compiled rules for scenario generation
  const permittedDirectories = extractPermittedDirectories(compilationResult.rules);

  // Generate test scenarios (LLM-cacheable)
  const scenarioStepLabel = `[${hasLists ? 3 : 2}/${totalSteps}]`;
  logContext.stepName = 'generate-scenarios';
  const scenarioPrompt = buildGeneratorSystemPrompt(
    config.constitutionText,
    allAnnotations,
    config.allowedDirectory,
    permittedDirectories,
    dynamicLists,
  );
  const scenarioHash = computeScenariosHash(scenarioPrompt, getHandwrittenScenarios(config.allowedDirectory));
  const scenarioSystem = cacheStrategy.wrapSystemPrompt(scenarioPrompt);
  const scenarioResult = await generateTestScenarios(
    config.constitutionText,
    allAnnotations,
    config.allowedDirectory,
    permittedDirectories,
    scenarioHash,
    existingScenarios,
    llm,
    scenarioStepLabel,
    scenarioSystem,
  );

  // Write scenarios to disk immediately so they're available for
  // inspection even if verification fails, and cached for next run.
  writeScenariosArtifact(config.generatedDir, config.constitutionHash, scenarioResult);

  // Filter out scenarios that conflict with structural invariants
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
    'Discarded scenario (structural conflict)',
  );
  let filteredScenarios = initialValid;

  // Verify compiled policy against scenarios (full depth)
  const verifyStepLabel = `[${totalSteps}/${totalSteps}]`;
  logContext.stepName = 'verify-policy';
  const allAvailableTools = allAnnotations.map((a) => ({ serverName: a.serverName, toolName: a.toolName }));
  const serverNamesList = [...new Set(allAnnotations.map((a) => a.serverName))] as [string, ...string[]];
  const toolNamesList = [...new Set(allAnnotations.map((a) => a.toolName))] as [string, ...string[]];
  let verifierSystem = cacheStrategy.wrapSystemPrompt(
    buildJudgeSystemPrompt(
      config.constitutionText,
      compiledPolicyFile,
      config.protectedPaths,
      allAvailableTools,
      dynamicLists,
      config.allowedDirectory,
    ),
  );
  let verifierSession = new PolicyVerifierSession({
    system: verifierSystem,
    model: llm,
    serverNames: serverNamesList,
    toolNames: toolNamesList,
  });
  const { result: verificationResultInitial } = await withSpinner(
    `${verifyStepLabel} Verifying policy`,
    async (spinner) =>
      verifyCompiledPolicy(
        config.constitutionText,
        compiledPolicyFile,
        toolAnnotationsFile,
        config.protectedPaths,
        filteredScenarios,
        llm,
        config.allowedDirectory,
        3,
        true,
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

  // Collect probe scenarios from verifier across all attempts, filtering
  // out any that conflict with structural invariants
  const { valid: filteredInitialProbes } = filterAndLogStructuralConflicts(
    filterEngine,
    collectProbeScenarios(verificationResult),
    'Discarded probe (structural conflict)',
  );
  const accumulatedProbes: TestScenario[] = filteredInitialProbes;

  // Dual-channel compile-verify-repair loop (up to 2 repair attempts)
  // The judge attributes each failure to 'rule', 'scenario', or 'both':
  //   - scenario-blamed: patch the test expectation
  //   - rule-blamed: recompile rules with failure feedback
  //   - both: patch scenario AND recompile
  const MAX_REPAIRS = 2;
  let repairAttempts = 0;
  let scenarioCorrectionsApplied = 0;

  if (!verificationResult.pass) {
    const baseInputHash = compilationResult.inputHash;

    for (let attempt = 1; attempt <= MAX_REPAIRS; attempt++) {
      console.error('');

      // Gather judge analysis and attributions from the most recent verification
      const lastRound = verificationResult.rounds[verificationResult.rounds.length - 1] as
        | (typeof verificationResult.rounds)[number]
        | undefined;
      const judgeAnalysis = lastRound?.llmAnalysis ?? verificationResult.summary;
      const attributedFailures = lastRound?.attributedFailures ?? [];

      // Split failures into scenario corrections and rule-blamed failures
      const allScenarios = [...scenarioResult.scenarios, ...accumulatedProbes];
      const { corrections, handwrittenWarnings } = extractScenarioCorrections(attributedFailures, allScenarios);

      for (const warning of handwrittenWarnings) {
        console.error(`  ${chalk.yellow('Warning:')} ${warning}`);
      }

      // Apply scenario corrections (patch expectations on generated scenarios)
      if (corrections.length > 0) {
        scenarioResult.scenarios = applyScenarioCorrections(scenarioResult.scenarios, corrections);
        const correctedProbes = applyScenarioCorrections(accumulatedProbes, corrections);
        accumulatedProbes.splice(0, accumulatedProbes.length, ...correctedProbes);
        scenarioCorrectionsApplied += corrections.length;
        console.error(`  ${chalk.dim(`Corrected ${corrections.length} scenario expectation(s)`)}`);
      }

      // Feed corrections back to the scenario generator session so it can
      // produce better replacement scenarios that avoid the same mistakes.
      const { session } = scenarioResult;
      if (session && (corrections.length > 0 || discardedScenarios.length > 0 || accumulatedProbes.length > 0)) {
        const feedback: ScenarioFeedback = {
          corrections,
          discardedScenarios,
          probeScenarios: accumulatedProbes,
        };

        logContext.stepName = `repair-regenerate-${attempt}`;
        const regenText = `Repair ${attempt}/${MAX_REPAIRS}: Regenerating scenarios`;
        const { result: replacements } = await withSpinner(
          regenText,
          async (spinner) =>
            session.regenerate(feedback, (msg) => {
              spinner.text = `${regenText} — ${msg}`;
            }),
          (r, elapsed) => `${regenText}: ${r.length} replacement(s) (${elapsed.toFixed(1)}s)`,
        );

        // Merge: remove corrected/discarded scenarios and add unique replacements
        scenarioResult.scenarios = mergeReplacements(
          scenarioResult.scenarios,
          replacements,
          corrections,
          discardedScenarios,
        );
      }

      // Re-filter after corrections/regeneration (a corrected expected decision
      // might now match a structural invariant result, making it valid)
      ({ valid: filteredScenarios } = filterAndLogStructuralConflicts(filterEngine, scenarioResult.scenarios));

      // Determine which failures need rule recompilation:
      // - no attribution or blamed on 'rule'/'both' (conservative default)
      // - handwritten scenarios blamed on 'scenario' (reclassified as rule issues)
      const allRuleBlamedFailures = verificationResult.failedScenarios.filter((f) => {
        const attr = attributedFailures.find((a) => a.scenarioDescription === f.scenario.description);
        if (!attr || attr.blame.kind === 'rule' || attr.blame.kind === 'both') return true;
        return handwrittenWarnings.some((w) => w.includes(f.scenario.description));
      });

      if (allRuleBlamedFailures.length > 0) {
        // Recompile with failure feedback (always calls LLM, no cache)
        const repairContext: RepairContext = {
          failedScenarios: allRuleBlamedFailures,
          judgeAnalysis,
          attemptNumber: attempt,
          existingListDefinitions:
            compilationResult.listDefinitions.length > 0 ? compilationResult.listDefinitions : undefined,
          handwrittenScenarios,
        };

        logContext.stepName = `repair-compile-${attempt}`;
        const repairCompileText = `Repair ${attempt}/${MAX_REPAIRS}: Recompiling`;
        const { result: repairCompileResult } = await withSpinner(
          repairCompileText,
          async (spinner) =>
            compilePolicyRulesWithRepair(
              config.constitutionText,
              allAnnotations,
              config.protectedPaths,
              baseInputHash,
              repairContext,
              llm,
              (msg) => {
                spinner.text = `${repairCompileText} — ${msg}`;
              },
              compilerSystem,
              compilationResult.session,
            ),
          (r, elapsed) =>
            `Repair ${attempt}/${MAX_REPAIRS}: Recompiled ${r.rules.length} rules (${elapsed.toFixed(1)}s)`,
        );
        compilationResult = repairCompileResult;

        // Re-resolve dynamic lists if repair introduced new list definitions
        if (dynamicLists && compilationResult.listDefinitions.length > 0) {
          const currentLists = dynamicLists;
          const newListDefs = compilationResult.listDefinitions.filter((def) => !(def.name in currentLists.lists));
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
              const resolved = await resolveAllLists(knowledgeDefs, { model: llm }, currentLists);
              dynamicLists = {
                ...resolved,
                lists: { ...currentLists.lists, ...resolved.lists },
              };
              writeArtifact(config.generatedDir, 'dynamic-lists.json', dynamicLists);
            }
          }
        }

        // Write updated policy artifact
        compiledPolicyFile = buildPolicyArtifact(config.constitutionHash, compilationResult);
        writePolicyArtifact(config.generatedDir, compiledPolicyFile);

        // Rebuild verifier system prompt and session with updated rules
        verifierSystem = cacheStrategy.wrapSystemPrompt(
          buildJudgeSystemPrompt(
            config.constitutionText,
            compiledPolicyFile,
            config.protectedPaths,
            allAvailableTools,
            dynamicLists,
            config.allowedDirectory,
          ),
        );
        verifierSession = new PolicyVerifierSession({
          system: verifierSystem,
          model: llm,
          serverNames: serverNamesList,
          toolNames: toolNamesList,
        });
      } else {
        console.error(`  ${chalk.dim('No rule-blamed failures — skipping recompilation')}`);
      }

      // Verify with reduced depth, using base scenarios + accumulated probes
      logContext.stepName = `repair-verify-${attempt}`;
      const repairScenarios = [...filteredScenarios, ...accumulatedProbes];
      const repairVerifyText = `Repair ${attempt}/${MAX_REPAIRS}: Verifying`;
      const { result: repairVerifyResult } = await withSpinner(
        repairVerifyText,
        async (spinner) =>
          verifyCompiledPolicy(
            config.constitutionText,
            compiledPolicyFile,
            toolAnnotationsFile,
            config.protectedPaths,
            repairScenarios,
            llm,
            config.allowedDirectory,
            1,
            true,
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

      // Accumulate any new probe scenarios, filtering structural conflicts
      const { valid: validRepairProbes } = filterAndLogStructuralConflicts(
        filterEngine,
        collectProbeScenarios(verificationResult),
        'Discarded probe (structural conflict)',
      );
      accumulatedProbes.push(...validRepairProbes);

      repairAttempts = attempt;

      if (verificationResult.pass) {
        // Run final full verification with all accumulated scenarios
        logContext.stepName = 'final-verify';
        const finalScenarios = [...filteredScenarios, ...accumulatedProbes];
        // New session for final verification (fresh history for clean evaluation)
        const finalSession = new PolicyVerifierSession({
          system: verifierSystem,
          model: llm,
          serverNames: serverNamesList,
          toolNames: toolNamesList,
        });
        const { result: finalVerifyResult } = await withSpinner(
          'Final full verification',
          async (spinner) =>
            verifyCompiledPolicy(
              config.constitutionText,
              compiledPolicyFile,
              toolAnnotationsFile,
              config.protectedPaths,
              finalScenarios,
              llm,
              config.allowedDirectory,
              3,
              true,
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

        // Accumulate any new probes from final verification, filtering structural conflicts
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

  // Re-write scenarios artifact if the repair loop modified them
  if (repairAttempts > 0) {
    writeScenariosArtifact(config.generatedDir, config.constitutionHash, scenarioResult);
  }

  // Deduplicate accumulated probes by description
  const seenDescriptions = new Set(scenarioResult.scenarios.map((s) => s.description));
  const uniqueProbes = accumulatedProbes.filter((s) => {
    if (seenDescriptions.has(s.description)) return false;
    seenDescriptions.add(s.description);
    return true;
  });

  const totalScenariosTested = filteredScenarios.length + uniqueProbes.length;

  console.error('');
  console.error(`  Rules: ${compilationResult.rules.length}`);
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
  console.error(`  Artifacts written to: ${chalk.dim(config.generatedDir + '/')}`);
  console.error(`  LLM interaction log: ${chalk.dim(logPath)}`);

  if (!verificationResult.pass) {
    console.error('');
    console.error(chalk.red.bold('Verification FAILED — artifacts written but policy may need review.'));
    process.exit(1);
  }

  console.error('');
  console.error(chalk.green.bold('Policy compilation successful!'));
}

// Only run when executed directly (not when imported by cli.ts or tests)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  main().catch((err: unknown) => {
    console.error(chalk.red.bold('Policy compilation failed:'), err);
    process.exit(1);
  });
}
