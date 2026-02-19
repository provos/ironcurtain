/**
 * CLI entry point for `ironcurtain compile-policy`.
 *
 * Orchestrates the full policy compilation pipeline:
 *   1. Load config and connect to MCP servers
 *   2. Annotate tools via LLM
 *   3. Compile constitution into declarative rules via LLM
 *   4. Generate test scenarios via LLM
 *   5. Verify compiled policy against real engine + LLM judge
 *   6. Write artifacts to src/config/generated/
 */

import 'dotenv/config';
import { createAnthropic } from '@ai-sdk/anthropic';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { wrapLanguageModel } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { annotateTools, validateAnnotationsHeuristic, buildAnnotationPrompt } from './tool-annotator.js';
import { compileConstitution, validateCompiledRules, buildCompilerPrompt } from './constitution-compiler.js';
import { generateScenarios, buildGeneratorPrompt } from './scenario-generator.js';
import { verifyPolicy } from './policy-verifier.js';
import { getHandwrittenScenarios } from './handwritten-scenarios.js';
import { createLlmLoggingMiddleware, type LlmLogContext } from './llm-logger.js';
import type { MCPServerConfig } from '../config/types.js';
import type {
  ToolAnnotation,
  CompiledRule,
  ToolAnnotationsFile,
  CompiledPolicyFile,
  TestScenario,
  TestScenariosFile,
  VerificationResult,
  RepairContext,
} from './types.js';
import { resolveRealPath } from '../types/argument-roles.js';
import { getIronCurtainHome } from '../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface PipelineConfig {
  constitutionPath: string;
  constitutionText: string;
  constitutionHash: string;
  mcpServers: Record<string, MCPServerConfig>;
  generatedDir: string;
  allowedDirectory: string;
  protectedPaths: string[];
}

function loadPipelineConfig(): PipelineConfig {
  const configDir = resolve(__dirname, '..', 'config');
  const constitutionPath = resolve(configDir, 'constitution.md');
  const constitutionText = readFileSync(constitutionPath, 'utf-8');
  const constitutionHash = createHash('sha256').update(constitutionText).digest('hex');
  const mcpServersPath = resolve(configDir, 'mcp-servers.json');
  const mcpServers: Record<string, MCPServerConfig> = JSON.parse(
    readFileSync(mcpServersPath, 'utf-8'),
  );
  const generatedDir = resolve(configDir, 'generated');
  const defaultAllowedDir = resolve(getIronCurtainHome(), 'sandbox');
  const allowedDirectory = process.env.ALLOWED_DIRECTORY ?? defaultAllowedDir;
  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';

  const protectedPaths = [
    resolveRealPath(constitutionPath),
    resolveRealPath(generatedDir),
    resolveRealPath(mcpServersPath),
    resolveRealPath(auditLogPath),
  ];

  return {
    constitutionPath,
    constitutionText,
    constitutionHash,
    mcpServers,
    generatedDir,
    allowedDirectory,
    protectedPaths,
  };
}

// ---------------------------------------------------------------------------
// Content-Hash Caching
// ---------------------------------------------------------------------------

function computeHash(...inputs: string[]): string {
  const hash = createHash('sha256');
  for (const input of inputs) {
    hash.update(input);
  }
  return hash.digest('hex');
}

function loadExistingArtifact<T>(generatedDir: string, filename: string): T | undefined {
  const filePath = resolve(generatedDir, filename);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function computeAnnotationHash(
  serverName: string,
  tools: ServerConnection['tools'],
): string {
  return computeHash(serverName, JSON.stringify(tools), buildAnnotationPrompt(serverName, tools));
}

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

// ---------------------------------------------------------------------------
// MCP Server Connection & Tool Discovery
// ---------------------------------------------------------------------------

interface ServerConnection {
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

async function connectAndDiscoverTools(
  mcpServers: Record<string, MCPServerConfig>,
): Promise<Map<string, ServerConnection>> {
  const connections = new Map<string, ServerConnection>();

  for (const [serverName, config] of Object.entries(mcpServers)) {
    console.error(`[1/5] Connecting to MCP server: ${serverName}...`);
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
        ? { ...(process.env as Record<string, string>), ...config.env }
        : undefined,
    });
    const client = new Client({ name: 'ironcurtain-compiler', version: '0.1.0' });
    await client.connect(transport);

    const toolsResult = await client.listTools();
    console.error(`  Found ${toolsResult.tools.length} tools on ${serverName}`);

    connections.set(serverName, { client, tools: toolsResult.tools });
  }

  return connections;
}

// ---------------------------------------------------------------------------
// Tool Annotation (LLM step -- cacheable per server + tool schemas)
// ---------------------------------------------------------------------------

interface AnnotationResult {
  annotations: ToolAnnotation[];
  inputHash: string;
}

async function annotateServerTools(
  serverName: string,
  tools: ServerConnection['tools'],
  existingAnnotations: ToolAnnotationsFile | undefined,
  llm: LanguageModel,
): Promise<AnnotationResult> {
  const inputHash = computeAnnotationHash(serverName, tools);

  // Check cache: skip LLM call if inputs haven't changed
  const cached = existingAnnotations?.servers[serverName];
  if (cached && cached.inputHash === inputHash) {
    console.error(`[2/5] Annotating tools for ${serverName}... (cached)`);
    return { annotations: cached.tools, inputHash };
  }

  console.error(`[2/5] Annotating tools for ${serverName}...`);
  const annotations = await annotateTools(serverName, tools, llm);

  const validation = validateAnnotationsHeuristic(tools, annotations);
  if (!validation.valid) {
    console.error('');
    console.error('Annotation validation FAILED:');
    for (const w of validation.warnings) {
      console.error(`  - ${w}`);
    }
    throw new AnnotationValidationError(serverName, validation.warnings);
  }
  console.error(`  Annotations validated.`);

  return { annotations, inputHash };
}

class AnnotationValidationError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly warnings: string[],
  ) {
    super(`Annotation validation failed for server ${serverName}`);
    this.name = 'AnnotationValidationError';
  }
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
  allowedDirectory: string,
  protectedPaths: string[],
  existingPolicy: CompiledPolicyFile | undefined,
  llm: LanguageModel,
): Promise<CompilationResult> {
  const inputHash = computePolicyHash(constitutionText, annotations, protectedPaths);

  // Check cache: skip LLM call if inputs haven't changed.
  // Still resolve paths in case symlink targets changed since last run.
  if (existingPolicy && existingPolicy.inputHash === inputHash) {
    console.error('[3/5] Compiling constitution... (cached)');
    return { rules: resolveRulePaths(existingPolicy.rules), inputHash };
  }

  console.error('[3/5] Compiling constitution...');
  const compiledRules = resolveRulePaths(await compileConstitution(
    constitutionText,
    annotations,
    { protectedPaths },
    llm,
  ));

  const ruleValidation = validateCompiledRules(compiledRules);
  if (ruleValidation.warnings.length > 0) {
    for (const w of ruleValidation.warnings) {
      console.error(`  Warning: ${w}`);
    }
  }
  if (!ruleValidation.valid) {
    console.error('');
    console.error('Compiled rule validation FAILED:');
    for (const e of ruleValidation.errors) {
      console.error(`  - ${e}`);
    }
    throw new RuleValidationError(ruleValidation.errors);
  }
  console.error(`  ${compiledRules.length} rules compiled and validated.`);

  return { rules: compiledRules, inputHash };
}

class RuleValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super('Compiled rule validation failed');
    this.name = 'RuleValidationError';
  }
}

async function compilePolicyRulesWithRepair(
  constitutionText: string,
  annotations: ToolAnnotation[],
  protectedPaths: string[],
  baseInputHash: string,
  repairContext: RepairContext,
  llm: LanguageModel,
): Promise<CompilationResult> {
  const compiledRules = resolveRulePaths(await compileConstitution(
    constitutionText,
    annotations,
    { protectedPaths },
    llm,
    repairContext,
  ));

  const ruleValidation = validateCompiledRules(compiledRules);
  if (ruleValidation.warnings.length > 0) {
    for (const w of ruleValidation.warnings) {
      console.error(`  Warning: ${w}`);
    }
  }
  if (!ruleValidation.valid) {
    console.error('');
    console.error('Repair compilation validation FAILED:');
    for (const e of ruleValidation.errors) {
      console.error(`  - ${e}`);
    }
    throw new RuleValidationError(ruleValidation.errors);
  }

  console.error(`  ${compiledRules.length} rules compiled.`);

  return { rules: compiledRules, inputHash: `${baseInputHash}-repair` };
}

// ---------------------------------------------------------------------------
// Artifact Construction (pure data transformation)
// ---------------------------------------------------------------------------

function buildAnnotationsArtifact(
  annotationResults: Map<string, AnnotationResult>,
): ToolAnnotationsFile {
  const file: ToolAnnotationsFile = {
    generatedAt: new Date().toISOString(),
    servers: {},
  };
  for (const [serverName, result] of annotationResults) {
    file.servers[serverName] = {
      inputHash: result.inputHash,
      tools: result.annotations,
    };
  }
  return file;
}

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

  // Check cache: skip LLM call if inputs haven't changed
  if (existingScenarios && existingScenarios.inputHash === inputHash) {
    console.error('[4/5] Generating test scenarios... (cached)');
    return { scenarios: existingScenarios.scenarios, inputHash };
  }

  console.error('[4/5] Generating test scenarios...');
  const scenarios = await generateScenarios(
    constitutionText,
    annotations,
    handwrittenScenarios,
    allowedDirectory,
    protectedPaths,
    llm,
    permittedDirectories,
  );
  const generatedCount = scenarios.length - handwrittenScenarios.length;
  console.error(
    `  ${scenarios.length} scenarios (${handwrittenScenarios.length} handwritten + ${generatedCount} generated).`,
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
  );

  if (!result.pass) {
    if (verbose) {
      console.error('');
      console.error('Verification FAILED:');
      console.error(result.summary);
      console.error('');
      for (const f of result.failedScenarios) {
        console.error(`  FAIL: ${f.scenario.description}`);
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

function writeAnnotationsArtifact(
  generatedDir: string,
  toolAnnotationsFile: ToolAnnotationsFile,
): void {
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    resolve(generatedDir, 'tool-annotations.json'),
    JSON.stringify(toolAnnotationsFile, null, 2) + '\n',
  );
}

function writeScenariosArtifact(
  generatedDir: string,
  constitutionHash: string,
  scenarioResult: ScenarioResult,
): void {
  mkdirSync(generatedDir, { recursive: true });

  const scenariosFile: TestScenariosFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: scenarioResult.inputHash,
    scenarios: scenarioResult.scenarios,
  };
  writeFileSync(
    resolve(generatedDir, 'test-scenarios.json'),
    JSON.stringify(scenariosFile, null, 2) + '\n',
  );
}

function writePolicyArtifact(
  generatedDir: string,
  compiledPolicyFile: CompiledPolicyFile,
): void {
  mkdirSync(generatedDir, { recursive: true });

  writeFileSync(
    resolve(generatedDir, 'compiled-policy.json'),
    JSON.stringify(compiledPolicyFile, null, 2) + '\n',
  );
}

// ---------------------------------------------------------------------------
// MCP Client Cleanup
// ---------------------------------------------------------------------------

async function disconnectAll(connections: Map<string, ServerConnection>): Promise<void> {
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

async function main(): Promise<void> {
  const config = loadPipelineConfig();

  console.error('Policy Compilation Pipeline');
  console.error('===========================');
  console.error(`Constitution: ${config.constitutionPath}`);
  console.error(`Sandbox: ${config.allowedDirectory}`);
  console.error(`Output: ${config.generatedDir}/`);
  console.error('');

  const anthropic = createAnthropic();
  const baseLlm = anthropic('claude-sonnet-4-6');

  const logContext: LlmLogContext = { stepName: 'unknown' };
  const logPath = resolve(config.generatedDir, 'llm-interactions.jsonl');
  const llm = wrapLanguageModel({
    model: baseLlm,
    middleware: createLlmLoggingMiddleware(logPath, logContext),
  });

  const connections = await connectAndDiscoverTools(config.mcpServers);

  try {
    // Load existing artifacts for cache comparison
    const existingAnnotations = loadExistingArtifact<ToolAnnotationsFile>(config.generatedDir, 'tool-annotations.json');
    const existingPolicy = loadExistingArtifact<CompiledPolicyFile>(config.generatedDir, 'compiled-policy.json');
    const existingScenarios = loadExistingArtifact<TestScenariosFile>(config.generatedDir, 'test-scenarios.json');

    // Annotate tools for each server (LLM-cacheable per server)
    const annotationResults = new Map<string, AnnotationResult>();
    const allAnnotations: ToolAnnotation[] = [];
    for (const [serverName, conn] of connections) {
      logContext.stepName = `annotate-${serverName}`;
      const result = await annotateServerTools(serverName, conn.tools, existingAnnotations, llm);
      annotationResults.set(serverName, result);
      allAnnotations.push(...result.annotations);
    }

    // Write annotations to disk immediately so they're available for
    // inspection even if a later step fails, and cached for next run.
    const toolAnnotationsFile = buildAnnotationsArtifact(annotationResults);
    writeAnnotationsArtifact(config.generatedDir, toolAnnotationsFile);

    // Compile constitution into policy rules (LLM-cacheable)
    logContext.stepName = 'compile-constitution';
    let compilationResult = await compilePolicyRules(
      config.constitutionText,
      allAnnotations,
      config.allowedDirectory,
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

    // Verify compiled policy against scenarios (full depth)
    logContext.stepName = 'verify-policy';
    console.error('[5/5] Verifying policy...');
    let verificationResult = await verifyCompiledPolicy(
      config.constitutionText,
      compiledPolicyFile,
      toolAnnotationsFile,
      config.protectedPaths,
      scenarioResult.scenarios,
      llm,
      config.allowedDirectory,
      3,
      true,
    );

    // Collect probe scenarios from verifier across all attempts
    const accumulatedProbes: TestScenario[] = [];
    for (const round of verificationResult.rounds) {
      accumulatedProbes.push(...round.newScenarios);
    }

    // Compile-verify-repair loop (up to 2 repair attempts)
    const MAX_REPAIRS = 2;
    let repairAttempts = 0;

    if (!verificationResult.pass) {
      const baseInputHash = compilationResult.inputHash;

      for (let attempt = 1; attempt <= MAX_REPAIRS; attempt++) {
        console.error('');
        console.error(`--- Repair attempt ${attempt}/${MAX_REPAIRS} ---`);

        // Gather judge analysis from the most recent verification
        const lastRound = verificationResult.rounds[verificationResult.rounds.length - 1];
        const judgeAnalysis = lastRound?.llmAnalysis ?? verificationResult.summary;

        // Build repair context from failures
        const repairContext: RepairContext = {
          previousRules: compilationResult.rules,
          failedScenarios: verificationResult.failedScenarios,
          judgeAnalysis,
          attemptNumber: attempt,
        };

        // Recompile with failure feedback (always calls LLM, no cache)
        logContext.stepName = `repair-compile-${attempt}`;
        console.error('  Recompiling with failure feedback...');
        compilationResult = await compilePolicyRulesWithRepair(
          config.constitutionText,
          allAnnotations,
          config.protectedPaths,
          baseInputHash,
          repairContext,
          llm,
        );

        // Write updated policy artifact
        compiledPolicyFile = buildPolicyArtifact(config.constitutionHash, compilationResult);
        writePolicyArtifact(config.generatedDir, compiledPolicyFile);

        // Verify with reduced depth, using base scenarios + accumulated probes
        logContext.stepName = `repair-verify-${attempt}`;
        const repairScenarios = [...scenarioResult.scenarios, ...accumulatedProbes];
        console.error('  Verifying...');
        verificationResult = await verifyCompiledPolicy(
          config.constitutionText,
          compiledPolicyFile,
          toolAnnotationsFile,
          config.protectedPaths,
          repairScenarios,
          llm,
          config.allowedDirectory,
          1,
          false,
        );

        // Accumulate any new probe scenarios
        for (const round of verificationResult.rounds) {
          accumulatedProbes.push(...round.newScenarios);
        }

        repairAttempts = attempt;

        if (verificationResult.pass) {
          // Run final full verification with all accumulated scenarios
          console.error('');
          console.error('  Running final full verification...');
          logContext.stepName = 'final-verify';
          const finalScenarios = [...scenarioResult.scenarios, ...accumulatedProbes];
          verificationResult = await verifyCompiledPolicy(
            config.constitutionText,
            compiledPolicyFile,
            toolAnnotationsFile,
            config.protectedPaths,
            finalScenarios,
            llm,
            config.allowedDirectory,
            3,
            true,
          );

          // Accumulate any new probes from final verification
          for (const round of verificationResult.rounds) {
            accumulatedProbes.push(...round.newScenarios);
          }
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

    const totalScenariosTested = scenarioResult.scenarios.length + uniqueProbes.length;

    console.error('');
    console.error(`  Rules: ${compilationResult.rules.length}`);
    console.error(`  Scenarios tested: ${totalScenariosTested}`);
    if (uniqueProbes.length > 0) {
      console.error(`  Probe scenarios accumulated: ${uniqueProbes.length}`);
    }
    if (repairAttempts > 0) {
      console.error(`  Repair attempts: ${repairAttempts}`);
    }
    console.error(`  Artifacts written to: ${config.generatedDir}/`);
    console.error(`  LLM interaction log: ${logPath}`);

    if (!verificationResult.pass) {
      console.error('');
      console.error('Verification FAILED — artifacts written but policy may need review.');
      process.exit(1);
    }

    console.error('');
    console.error('Policy compilation successful!');
  } finally {
    await disconnectAll(connections);
  }
}

main().catch((err) => {
  console.error('Policy compilation failed:', err);
  process.exit(1);
});
