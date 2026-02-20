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
import type { LanguageModel } from 'ai';
import chalk from 'chalk';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import { resolveRealPath } from '../types/argument-roles.js';
import { buildCompilerPrompt, compileConstitution, validateCompiledRules } from './constitution-compiler.js';
import { getHandwrittenScenarios } from './handwritten-scenarios.js';
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
  extractScenarioCorrections,
  filterStructuralConflicts,
  verifyPolicy,
  type DiscardedScenario,
} from './policy-verifier.js';
import { buildGeneratorPrompt, generateScenarios } from './scenario-generator.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  RepairContext,
  TestScenario,
  TestScenariosFile,
  ToolAnnotation,
  ToolAnnotationsFile,
  VerificationResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Content-Hash Caching (compile-specific)
// ---------------------------------------------------------------------------

function computePolicyHash(
  constitutionText: string,
  allAnnotations: ToolAnnotation[],
  protectedPaths: string[],
): string {
  const prompt = buildCompilerPrompt(constitutionText, allAnnotations, {
    protectedPaths,
  });
  return computeHash(
    constitutionText,
    JSON.stringify(allAnnotations),
    prompt,
  );
}

function computeScenariosHash(
  constitutionText: string,
  annotations: ToolAnnotation[],
  handwrittenScenarios: TestScenario[],
  sandboxDirectory: string,
  protectedPaths: string[],
  permittedDirectories: string[],
): string {
  const prompt = buildGeneratorPrompt(
    constitutionText,
    annotations,
    sandboxDirectory,
    protectedPaths,
    permittedDirectories,
  );
  return computeHash(
    prompt,
    constitutionText,
    JSON.stringify(annotations),
    JSON.stringify(handwrittenScenarios),
    JSON.stringify({ sandboxDirectory }),
    JSON.stringify(protectedPaths),
    JSON.stringify(permittedDirectories),
  );
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
  return result.rounds.flatMap(round => round.newScenarios);
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
    const prefix = d.scenario.source === 'handwritten'
      ? chalk.yellow('Warning: handwritten scenario conflicts with structural invariant:')
      : chalk.dim(`${label}:`);
    console.error(`  ${prefix} "${d.scenario.description}" — ${d.rule} always returns ${d.actual}`);
  }
  return { valid, discarded };
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
  return rules.map(rule => {
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
  inputHash: string;
}

async function compilePolicyRules(
  constitutionText: string,
  annotations: ToolAnnotation[],
  protectedPaths: string[],
  existingPolicy: CompiledPolicyFile | undefined,
  llm: LanguageModel,
): Promise<CompilationResult> {
  const inputHash = computePolicyHash(constitutionText, annotations, protectedPaths);
  const stepText = '[1/3] Compiling constitution';

  // Check cache: skip LLM call if inputs haven't changed.
  // Still resolve paths in case symlink targets changed since last run.
  if (existingPolicy && existingPolicy.inputHash === inputHash) {
    showCached(stepText);
    return { rules: resolveRulePaths(existingPolicy.rules), inputHash };
  }

  const { result: compiledRules } = await withSpinner(
    stepText,
    async (spinner) => {
      const rules = resolveRulePaths(await compileConstitution(
        constitutionText,
        annotations,
        { protectedPaths },
        llm,
        undefined,
        (msg) => { spinner.text = `${stepText} — ${msg}`; },
      ));
      validateRulesOrThrow(rules);
      return rules;
    },
    (rules, elapsed) =>
      `${stepText}: ${rules.length} rules compiled (${elapsed.toFixed(1)}s)`,
  );

  return { rules: compiledRules, inputHash };
}

class RuleValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super('Compiled rule validation failed');
    this.name = 'RuleValidationError';
  }
}

function validateRulesOrThrow(rules: CompiledRule[]): void {
  const ruleValidation = validateCompiledRules(rules);
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
): Promise<CompilationResult> {
  const compiledRules = resolveRulePaths(await compileConstitution(
    constitutionText,
    annotations,
    { protectedPaths },
    llm,
    repairContext,
    onProgress,
  ));
  validateRulesOrThrow(compiledRules);

  return { rules: compiledRules, inputHash: `${baseInputHash}-repair` };
}

// ---------------------------------------------------------------------------
// Artifact Construction (pure data transformation)
// ---------------------------------------------------------------------------

function buildPolicyArtifact(
  constitutionHash: string,
  compilationResult: CompilationResult,
): CompiledPolicyFile {
  return {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: compilationResult.inputHash,
    rules: compilationResult.rules,
  };
}

// ---------------------------------------------------------------------------
// Scenario Generation (LLM step -- cacheable by constitution + annotations)
// ---------------------------------------------------------------------------

interface ScenarioResult {
  scenarios: TestScenario[];
  inputHash: string;
}

async function generateTestScenarios(
  constitutionText: string,
  annotations: ToolAnnotation[],
  allowedDirectory: string,
  protectedPaths: string[],
  permittedDirectories: string[],
  existingScenarios: TestScenariosFile | undefined,
  llm: LanguageModel,
): Promise<ScenarioResult> {
  const handwrittenScenarios = getHandwrittenScenarios(allowedDirectory);
  const inputHash = computeScenariosHash(
    constitutionText,
    annotations,
    handwrittenScenarios,
    allowedDirectory,
    protectedPaths,
    permittedDirectories,
  );

  const stepText = '[2/3] Generating test scenarios';

  // Check cache: skip LLM call if inputs haven't changed
  if (existingScenarios && existingScenarios.inputHash === inputHash) {
    showCached(stepText);
    return { scenarios: existingScenarios.scenarios, inputHash };
  }

  const { result: scenarios } = await withSpinner(
    stepText,
    async (spinner) => {
      return await generateScenarios(
        constitutionText,
        annotations,
        handwrittenScenarios,
        allowedDirectory,
        protectedPaths,
        llm,
        permittedDirectories,
        (msg) => { spinner.text = `${stepText} — ${msg}`; },
      );
    },
    (scenarios, elapsed) => {
      const generatedCount = scenarios.length - handwrittenScenarios.length;
      return `${stepText}: ${scenarios.length} scenarios (${handwrittenScenarios.length} handwritten + ${generatedCount} generated) (${elapsed.toFixed(1)}s)`;
    },
  );

  return { scenarios, inputHash };
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

function writeScenariosArtifact(
  generatedDir: string,
  constitutionHash: string,
  scenarioResult: ScenarioResult,
): void {
  const scenariosFile: TestScenariosFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: scenarioResult.inputHash,
    scenarios: scenarioResult.scenarios,
  };
  writeArtifact(generatedDir, 'test-scenarios.json', scenariosFile);
}

function writePolicyArtifact(
  generatedDir: string,
  compiledPolicyFile: CompiledPolicyFile,
): void {
  writeArtifact(generatedDir, 'compiled-policy.json', compiledPolicyFile);
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const config = loadPipelineConfig();

  // Load tool annotations from disk (produced by `npm run annotate-tools`)
  const toolAnnotationsFile = loadExistingArtifact<ToolAnnotationsFile>(
    config.generatedDir, 'tool-annotations.json', config.packageGeneratedDir,
  );
  if (!toolAnnotationsFile) {
    console.error(chalk.red.bold(
      "Error: tool-annotations.json not found. Run 'npm run annotate-tools' first to generate tool annotations.",
    ));
    process.exit(1);
  }

  // Flatten annotations from all servers
  const allAnnotations = Object.values(toolAnnotationsFile.servers)
    .flatMap(server => server.tools);

  console.error(chalk.bold('Policy Compilation Pipeline'));
  console.error(chalk.bold('==========================='));
  console.error(`Constitution: ${chalk.dim(config.constitutionPath)}`);
  console.error(`Sandbox:      ${chalk.dim(config.allowedDirectory)}`);
  console.error(`Output:       ${chalk.dim(config.generatedDir + '/')}`);
  console.error(`Annotations:  ${chalk.dim(`${allAnnotations.length} tools from ${Object.keys(toolAnnotationsFile.servers).length} server(s)`)}`);
  console.error('');

  const { model: llm, logContext, logPath } = await createPipelineLlm(
    config.generatedDir, 'unknown',
  );

  // Load existing artifacts for cache comparison
  const existingPolicy = loadExistingArtifact<CompiledPolicyFile>(config.generatedDir, 'compiled-policy.json', config.packageGeneratedDir);
  const existingScenarios = loadExistingArtifact<TestScenariosFile>(config.generatedDir, 'test-scenarios.json', config.packageGeneratedDir);

  // Compile constitution into policy rules (LLM-cacheable)
  logContext.stepName = 'compile-constitution';
  let compilationResult = await compilePolicyRules(
    config.constitutionText,
    allAnnotations,
    config.protectedPaths,
    existingPolicy,
    llm,
  );

  // Build and write policy artifact immediately so it's available for
  // inspection even if verification fails, and cached for next run.
  let compiledPolicyFile = buildPolicyArtifact(config.constitutionHash, compilationResult);
  writePolicyArtifact(config.generatedDir, compiledPolicyFile);

  // Extract permitted directories from compiled rules for scenario generation
  const permittedDirectories = extractPermittedDirectories(compilationResult.rules);

  // Generate test scenarios (LLM-cacheable)
  logContext.stepName = 'generate-scenarios';
  const scenarioResult = await generateTestScenarios(
    config.constitutionText,
    allAnnotations,
    config.allowedDirectory,
    config.protectedPaths,
    permittedDirectories,
    existingScenarios,
    llm,
  );

  // Write scenarios to disk immediately so they're available for
  // inspection even if verification fails, and cached for next run.
  writeScenariosArtifact(config.generatedDir, config.constitutionHash, scenarioResult);

  // Filter out scenarios that conflict with structural invariants
  const filterEngine = new PolicyEngine(compiledPolicyFile, toolAnnotationsFile, config.protectedPaths, config.allowedDirectory);
  const { valid: initialValid, discarded: discardedScenarios } = filterAndLogStructuralConflicts(
    filterEngine, scenarioResult.scenarios, 'Discarded scenario (structural conflict)',
  );
  let filteredScenarios = initialValid;

  // Verify compiled policy against scenarios (full depth)
  logContext.stepName = 'verify-policy';
  const { result: verificationResultInitial } = await withSpinner(
    '[3/3] Verifying policy',
    async (spinner) => {
      return await verifyCompiledPolicy(
        config.constitutionText,
        compiledPolicyFile,
        toolAnnotationsFile,
        config.protectedPaths,
        filteredScenarios,
        llm,
        config.allowedDirectory,
        3,
        true,
        (msg) => { spinner.text = `[3/3] Verifying policy — ${msg}`; },
      );
    },
    (r, elapsed) => r.pass
      ? `[3/3] Verified policy: ${r.rounds.length} round(s) (${elapsed.toFixed(1)}s)`
      : `[3/3] Verification completed with failures (${elapsed.toFixed(1)}s)`,
  );
  let verificationResult = verificationResultInitial;

  // Collect probe scenarios from verifier across all attempts, filtering
  // out any that conflict with structural invariants
  const { valid: filteredInitialProbes } = filterAndLogStructuralConflicts(
    filterEngine, collectProbeScenarios(verificationResult), 'Discarded probe (structural conflict)',
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
      const lastRound = verificationResult.rounds[verificationResult.rounds.length - 1];
      const judgeAnalysis = lastRound?.llmAnalysis ?? verificationResult.summary;
      const attributedFailures = lastRound?.attributedFailures ?? [];

      // Split failures into scenario corrections and rule-blamed failures
      const allScenarios = [...scenarioResult.scenarios, ...accumulatedProbes];
      const { corrections, handwrittenWarnings } = extractScenarioCorrections(
        attributedFailures,
        allScenarios,
      );

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

        // Re-filter after corrections (a corrected expected decision might
        // now match a structural invariant result, making it valid)
        ({ valid: filteredScenarios } = filterAndLogStructuralConflicts(filterEngine, scenarioResult.scenarios));
      }

      // Determine which failures need rule recompilation:
      // - no attribution or blamed on 'rule'/'both' (conservative default)
      // - handwritten scenarios blamed on 'scenario' (reclassified as rule issues)
      const allRuleBlamedFailures = verificationResult.failedScenarios.filter(f => {
        const attr = attributedFailures.find(a => a.scenarioDescription === f.scenario.description);
        if (!attr || attr.blame.kind === 'rule' || attr.blame.kind === 'both') return true;
        return handwrittenWarnings.some(w => w.includes(f.scenario.description));
      });

      if (allRuleBlamedFailures.length > 0) {
        // Recompile with failure feedback (always calls LLM, no cache)
        const repairContext: RepairContext = {
          previousRules: compilationResult.rules,
          failedScenarios: allRuleBlamedFailures,
          judgeAnalysis,
          attemptNumber: attempt,
        };

        logContext.stepName = `repair-compile-${attempt}`;
        const repairCompileText = `Repair ${attempt}/${MAX_REPAIRS}: Recompiling`;
        const { result: repairCompileResult } = await withSpinner(
          repairCompileText,
          async (spinner) => {
            return await compilePolicyRulesWithRepair(
              config.constitutionText,
              allAnnotations,
              config.protectedPaths,
              baseInputHash,
              repairContext,
              llm,
              (msg) => { spinner.text = `${repairCompileText} — ${msg}`; },
            );
          },
          (r, elapsed) =>
            `Repair ${attempt}/${MAX_REPAIRS}: Recompiled ${r.rules.length} rules (${elapsed.toFixed(1)}s)`,
        );
        compilationResult = repairCompileResult;

        // Write updated policy artifact
        compiledPolicyFile = buildPolicyArtifact(config.constitutionHash, compilationResult);
        writePolicyArtifact(config.generatedDir, compiledPolicyFile);
      } else {
        console.error(`  ${chalk.dim('No rule-blamed failures — skipping recompilation')}`);
      }

      // Verify with reduced depth, using base scenarios + accumulated probes
      logContext.stepName = `repair-verify-${attempt}`;
      const repairScenarios = [...filteredScenarios, ...accumulatedProbes];
      const repairVerifyText = `Repair ${attempt}/${MAX_REPAIRS}: Verifying`;
      const { result: repairVerifyResult } = await withSpinner(
        repairVerifyText,
        async (spinner) => {
          return await verifyCompiledPolicy(
            config.constitutionText,
            compiledPolicyFile,
            toolAnnotationsFile,
            config.protectedPaths,
            repairScenarios,
            llm,
            config.allowedDirectory,
            1,
            false,
            (msg) => { spinner.text = `${repairVerifyText} — ${msg}`; },
          );
        },
        (r, elapsed) => r.pass
          ? `Repair ${attempt}/${MAX_REPAIRS}: Verified (${elapsed.toFixed(1)}s)`
          : `Repair ${attempt}/${MAX_REPAIRS}: ${r.failedScenarios.length} failure(s) (${elapsed.toFixed(1)}s)`,
      );
      verificationResult = repairVerifyResult;

      // Accumulate any new probe scenarios, filtering structural conflicts
      const { valid: validRepairProbes } = filterAndLogStructuralConflicts(
        filterEngine, collectProbeScenarios(verificationResult), 'Discarded probe (structural conflict)',
      );
      accumulatedProbes.push(...validRepairProbes);

      repairAttempts = attempt;

      if (verificationResult.pass) {
        // Run final full verification with all accumulated scenarios
        logContext.stepName = 'final-verify';
        const finalScenarios = [...filteredScenarios, ...accumulatedProbes];
        const { result: finalVerifyResult } = await withSpinner(
          'Final full verification',
          async (spinner) => {
            return await verifyCompiledPolicy(
              config.constitutionText,
              compiledPolicyFile,
              toolAnnotationsFile,
              config.protectedPaths,
              finalScenarios,
              llm,
              config.allowedDirectory,
              3,
              true,
              (msg) => { spinner.text = `Final full verification — ${msg}`; },
            );
          },
          (r, elapsed) => r.pass
            ? `Final full verification: passed (${elapsed.toFixed(1)}s)`
            : `Final full verification: ${r.failedScenarios.length} failure(s) (${elapsed.toFixed(1)}s)`,
        );
        verificationResult = finalVerifyResult;

        // Accumulate any new probes from final verification, filtering structural conflicts
        const { valid: validFinalProbes } = filterAndLogStructuralConflicts(
          filterEngine, collectProbeScenarios(verificationResult), 'Discarded probe (structural conflict)',
        );
        accumulatedProbes.push(...validFinalProbes);
        break;
      }
    }
  }

  // Deduplicate accumulated probes by description
  const seenDescriptions = new Set(scenarioResult.scenarios.map(s => s.description));
  const uniqueProbes = accumulatedProbes.filter(s => {
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
  main().catch((err) => {
    console.error(chalk.red.bold('Policy compilation failed:'), err);
    process.exit(1);
  });
}
