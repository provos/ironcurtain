/**
 * PipelineRunner -- Encapsulates the full policy compilation pipeline.
 *
 * Provides a reusable abstraction over the compile-verify-repair loop.
 * Used by:
 * - compile.ts CLI (constitutionKind: 'constitution') -- per-server compilation
 * - compileTaskPolicy() (constitutionKind: 'task-policy') -- per-server whitelist
 *
 * Each MCP server is compiled independently with its own compile-verify-repair
 * cycle, then results are merged. This enables incremental recompilation and
 * better per-server rule quality.
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
  formatAnnotationsSummary,
  validateCompiledRules,
} from './constitution-compiler.js';
import { getHandwrittenScenarios } from './handwritten-scenarios.js';
import { resolveAllLists, type McpServerConnection } from './list-resolver.js';
import {
  computeHash,
  loadExistingArtifact,
  loadReadOnlyPolicyEngine,
  loadStoredToolAnnotationsFile,
  resolveRulePaths,
  writeArtifact,
  withSpinner,
  showCached,
  createPipelineLlm,
} from './pipeline-shared.js';
import { resolveStoredAnnotationsFile } from '../types/argument-roles.js';
import {
  applyScenarioCorrections,
  buildJudgeSystemPrompt,
  detectAllDefaultRoleFallbacks,
  extractScenarioCorrections,
  filterStructuralConflicts,
  PolicyVerifierSession,
  verifyPolicy,
} from './policy-verifier.js';
import { filterInvalidSchemaScenarios } from './scenario-schema-validator.js';
import { buildGeneratorSystemPrompt, generateScenarios, repairScenarios } from './scenario-generator.js';
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
  ResolvedList,
  ServerCompiledPolicyFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
  TestScenario,
  TestScenariosFile,
  ToolAnnotation,
  ToolAnnotationsFile,
  VerificationResult,
} from './types.js';

/**
 * Selects the LLM prompt variant for per-server policy compilation.
 *
 * - 'constitution': broad-principle compilation from a constitution document.
 * - 'task-policy': strict whitelist-generation from an English task description.
 *
 * Both modes compile each server independently via the per-server path.
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
   * Defaults to true for 'constitution', false for 'task-policy'.
   */
  readonly includeHandwrittenScenarios?: boolean;

  /** Progress callback for CLI output. */
  readonly onProgress?: (message: string) => void;

  /** Pre-loaded stored tool annotations (avoids re-reading from disk). */
  readonly preloadedStoredAnnotations?: StoredToolAnnotationsFile;

  /** Compile only these servers (default: all servers in annotations). */
  readonly serverFilter?: string[];
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
// Per-server compilation types (internal to pipeline-runner)
// ---------------------------------------------------------------------------

/** Inputs for compiling a single server's policy rules. */
interface ServerCompilationUnit {
  readonly serverName: string;
  readonly annotations: ToolAnnotation[];
  readonly storedAnnotations: StoredToolAnnotation[];
  readonly constitutionText: string;
  readonly constitutionKind: ConstitutionKind;
  readonly allowedDirectory: string;
  readonly protectedPaths: string[];
  readonly mcpServerConfig?: MCPServerConfig;
  readonly handwrittenScenarios: TestScenario[];
}

/** Output from a single server's compilation cycle. */
interface ServerCompilationResult {
  readonly serverName: string;
  readonly rules: CompiledRule[];
  readonly listDefinitions: ListDefinition[];
  readonly scenarios: TestScenario[];
  readonly inputHash: string;
  readonly constitutionHash: string;
  readonly resolvedLists?: DynamicListsFile;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
  storedAnnotations: StoredToolAnnotation[],
): { valid: TestScenario[]; discarded: DiscardedScenario[] } {
  const filterResult = filterStructuralConflicts(engine, scenarios);
  let valid = filterResult.valid;
  const discarded = filterResult.discarded;
  for (const d of discarded) {
    const prefix =
      d.scenario.source === 'handwritten'
        ? chalk.yellow('Warning: handwritten scenario conflicts with structural invariant:')
        : chalk.dim(`${label}:`);
    console.error(`  ${prefix} "${d.scenario.description}" — ${d.rule} always returns ${d.actual}`);
  }

  // Discard scenarios whose arguments don't match any conditional role spec —
  // they fall back to all default roles and test the wrong thing.
  if (storedAnnotations.length > 0) {
    const fallbackWarnings = detectAllDefaultRoleFallbacks(valid, storedAnnotations);
    const fallbackDescriptions = new Set(fallbackWarnings.map((w) => w.scenario.description));
    if (fallbackDescriptions.size > 0) {
      const kept: TestScenario[] = [];
      for (const s of valid) {
        if (fallbackDescriptions.has(s.description)) {
          const w = fallbackWarnings.find((fw) => fw.scenario.description === s.description);
          const details = w?.details.join('; ') ?? 'unknown conditional mismatch';
          const discardLabel = 'Discarded (default role fallback)';
          console.error(`  ${chalk.dim(`${discardLabel}:`)} "${s.description}" — ${details}`);
          discarded.push({ scenario: s, rule: 'default-role-fallback', actual: 'deny' });
        } else {
          kept.push(s);
        }
      }
      valid = kept;
    }

    // Discard scenarios whose arguments violate the tool's input schema
    // (unknown arg names, missing required fields, invalid enum values).
    const schemaResult = filterInvalidSchemaScenarios(valid, storedAnnotations);
    if (schemaResult.discarded.length > 0) {
      for (const d of schemaResult.discarded) {
        console.error(`  ${chalk.dim('Discarded (schema mismatch):')} "${d.scenario.description}" — ${d.rule}`);
      }
      discarded.push(...schemaResult.discarded);
      valid = schemaResult.valid;
    }
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
  serverScope: string,
): string {
  const annotationsSummary = formatAnnotationsSummary(annotations);

  return `You are compiling a task-scoped security policy for an automated scheduled job. The job runs unattended on a schedule. Your goal is to generate the MINIMUM set of policy rules required for this specific task -- nothing more.

## Server Scope

You are generating rules ONLY for the "${serverScope}" server. Every rule you emit MUST include "server": ["${serverScope}"] in its "if" condition.

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
  - "server": MUST be ["${serverScope}"]
  - "tool": array of specific tool names (omit = any matching tool)
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
5. Be concise in descriptions and reasons -- one sentence each.
6. EVERY rule MUST have "server": ["${serverScope}"] in its condition.`;
}

// ---------------------------------------------------------------------------
// Per-server merge helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Computes a content hash for a single server's policy compilation inputs.
 * The hash includes the server name, constitution, annotations, and prompt
 * template so that any change invalidates the cache for this server.
 */
export function computeServerPolicyHash(
  serverName: string,
  constitutionText: string,
  annotations: ToolAnnotation[],
  compilerPromptTemplate: string,
): string {
  return computeHash(serverName, constitutionText, JSON.stringify(annotations), compilerPromptTemplate);
}

/**
 * Filters handwritten scenarios to only those belonging to a specific server.
 * Safe because handwritten scenarios are tagged with serverName in their request.
 */
export function getHandwrittenScenariosForServer(serverName: string, sandboxDir: string): TestScenario[] {
  return getHandwrittenScenarios(sandboxDir).filter((s) => s.request.serverName === serverName);
}

/**
 * Debug assertion: validates that all rules from a server's compilation
 * are properly scoped to exactly that server. This should never fail if
 * the Zod schema with requireServer is correct.
 */
export function validateServerScoping(serverName: string, rules: CompiledRule[]): void {
  for (const rule of rules) {
    if (!rule.if.server || !rule.if.server.includes(serverName)) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" is missing ` +
          `server: ["${serverName}"] in its condition. This is a compiler bug.`,
      );
    }
    if (rule.if.server.length !== 1 || rule.if.server[0] !== serverName) {
      throw new Error(
        `Rule "${rule.name}" from server "${serverName}" has unexpected ` +
          `server scope: ${JSON.stringify(rule.if.server)}. Expected exactly ["${serverName}"].`,
      );
    }
  }
}

/**
 * Deduplicates list definitions by name. When two servers produce different
 * generationPrompt values for the same named list, uses first-wins
 * (alphabetical server order) and logs a warning.
 */
export function deduplicateListDefinitions(defs: ListDefinition[]): ListDefinition[] {
  const seen = new Map<string, ListDefinition>();
  for (const def of defs) {
    const existing = seen.get(def.name);
    if (!existing) {
      seen.set(def.name, def);
    } else if (existing.generationPrompt !== def.generationPrompt) {
      console.error(
        `  Warning: list "${def.name}" has divergent generation prompts ` +
          `across servers. Using first definition (alphabetical server order).`,
      );
    }
  }
  return [...seen.values()];
}

/**
 * Merges per-server compilation results into a single CompiledPolicyFile.
 * Rules are concatenated in alphabetical server order for determinism.
 * List definitions are deduplicated by name.
 */
export function mergeServerResults(results: ServerCompilationResult[], constitutionHash: string): CompiledPolicyFile {
  const sortedResults = [...results].sort((a, b) => a.serverName.localeCompare(b.serverName));

  const allRules: CompiledRule[] = sortedResults.flatMap((r) => r.rules);
  const allListDefs: ListDefinition[] = sortedResults.flatMap((r) => r.listDefinitions);
  const uniqueListDefs = deduplicateListDefinitions(allListDefs);

  const mergedInputHash = computeHash(...sortedResults.map((r) => r.inputHash));

  const artifact: CompiledPolicyFile = {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: mergedInputHash,
    rules: allRules,
  };
  if (uniqueListDefs.length > 0) {
    artifact.listDefinitions = uniqueListDefs;
  }
  return artifact;
}

// ---------------------------------------------------------------------------
// PipelineRunner
// ---------------------------------------------------------------------------

/**
 * Encapsulates the full policy compilation pipeline:
 * compile rules -> generate scenarios -> verify -> repair loop.
 *
 * Uses per-server compilation with independent compile-verify-repair
 * cycles per server, then merges results. Works for both 'constitution'
 * (broad principles) and 'task-policy' (strict whitelist) modes.
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
   * All compilation modes use per-server compilation with independent
   * compile-verify-repair cycles per server, then merge results.
   */
  async run(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
    return this.runPerServer(config);
  }

  // -----------------------------------------------------------------------
  // Per-server compilation path
  // -----------------------------------------------------------------------

  /**
   * Orchestrates per-server compilation + merge.
   *
   * Phase 1: Compile each server independently (compile-verify-repair per server)
   * Phase 2: Merge all per-server results into final compiled-policy.json
   * Phase 3: Resolve dynamic lists (global, post-merge)
   *
   * Works for both 'constitution' and 'task-policy' modes -- the
   * constitutionKind is forwarded to each server's compilation unit
   * to select the appropriate compiler prompt.
   */
  private async runPerServer(config: PipelineRunConfig): Promise<CompiledPolicyFile> {
    const storedAnnotationsFile =
      config.preloadedStoredAnnotations ??
      loadStoredToolAnnotationsFile(config.toolAnnotationsDir, config.toolAnnotationsFallbackDir);

    if (!storedAnnotationsFile) {
      throw new Error("tool-annotations.json not found. Run 'ironcurtain annotate-tools' first.");
    }

    // Resolve conditional role specs to flat annotations for compiler prompts
    const toolAnnotationsFile = resolveStoredAnnotationsFile(storedAnnotationsFile);

    const constitutionHash = computeHash(config.constitutionInput);

    // Phase 1: Per-server compilation
    const serverResults = await this.compileAllServers(
      config,
      toolAnnotationsFile,
      constitutionHash,
      storedAnnotationsFile,
    );

    // Phase 2: Merge
    const mergedPolicy = mergeServerResults(serverResults, constitutionHash);
    writeArtifact(config.outputDir, 'compiled-policy.json', mergedPolicy);

    // Merge scenarios for the global artifact
    const allScenarios = serverResults.flatMap((r) => r.scenarios);
    const mergedScenariosFile: TestScenariosFile = {
      generatedAt: new Date().toISOString(),
      constitutionHash,
      inputHash: mergedPolicy.inputHash,
      scenarios: allScenarios,
    };
    writeArtifact(config.outputDir, 'test-scenarios.json', mergedScenariosFile);

    // Phase 3: Merge per-server resolved lists into global dynamic-lists.json
    // Each server resolved its own lists during compileServer(); merge them here.
    const listDefinitions = mergedPolicy.listDefinitions ?? [];

    if (listDefinitions.length > 0) {
      const keptListNames = new Set(listDefinitions.map((d) => d.name));
      const mergedListEntries: Record<string, ResolvedList> = {};
      // serverResults are already in alphabetical order -- use first-wins
      // to match deduplicateListDefinitions() merge semantics.
      for (const result of serverResults) {
        if (result.resolvedLists) {
          for (const [name, list] of Object.entries(result.resolvedLists.lists)) {
            if (keptListNames.has(name) && !(name in mergedListEntries)) {
              mergedListEntries[name] = list;
            }
          }
        }
      }
      const mergedDynamicLists: DynamicListsFile = {
        generatedAt: new Date().toISOString(),
        lists: mergedListEntries,
      };
      writeArtifact(config.outputDir, 'dynamic-lists.json', mergedDynamicLists);
    }

    // Cross-server verification is intentionally omitted. Per-server rules compose
    // correctly by construction: every rule has server: [serverName] (enforced by
    // Zod schema), the engine checks cond.server.includes(request.serverName) so
    // rules from server A never match server B's calls, rules are only allow/escalate
    // with default-deny fallback, and structural invariants are evaluated before
    // compiled rules. If each server's rules verify in isolation, the merged set
    // behaves identically.

    // Summary
    const totalRules = mergedPolicy.rules.length;
    const totalScenarios = allScenarios.length;
    const serverCount = serverResults.length;

    console.error('');
    console.error(`  Servers compiled: ${serverCount}`);
    console.error(`  Rules: ${totalRules}`);
    console.error(`  Scenarios tested: ${totalScenarios}`);
    console.error(`  Artifacts written to: ${chalk.dim(config.outputDir + '/')}`);
    if (config.llmLogPath) {
      console.error(`  LLM interaction log: ${chalk.dim(config.llmLogPath)}`);
    }

    console.error('');
    console.error(chalk.green.bold('Policy compilation successful!'));

    return mergedPolicy;
  }

  /**
   * Compiles rules for all servers sequentially.
   * Respects serverFilter if provided (for debugging single servers).
   */
  private async compileAllServers(
    config: PipelineRunConfig,
    toolAnnotationsFile: ToolAnnotationsFile,
    constitutionHash: string,
    storedAnnotationsFile: StoredToolAnnotationsFile,
  ): Promise<ServerCompilationResult[]> {
    const results: ServerCompilationResult[] = [];
    const serverEntries = Object.entries(toolAnnotationsFile.servers);

    // Apply server filter if provided
    const { serverFilter } = config;
    const filteredEntries = serverFilter
      ? serverEntries.filter(([name]) => serverFilter.includes(name))
      : serverEntries;

    if (config.serverFilter && filteredEntries.length === 0) {
      throw new Error(
        `No matching servers found for filter: ${config.serverFilter.join(', ')}. ` +
          `Available: ${serverEntries.map(([n]) => n).join(', ')}`,
      );
    }

    // Load handwritten scenarios once, then filter per server (avoids N redundant loads)
    const includeHandwritten = config.includeHandwrittenScenarios ?? config.constitutionKind === 'constitution';
    const allHandwrittenScenarios = includeHandwritten ? getHandwrittenScenarios(config.allowedDirectory) : [];

    const totalServers = filteredEntries.length;
    for (let i = 0; i < filteredEntries.length; i++) {
      const [serverName, serverData] = filteredEntries[i];
      console.error('');
      console.error(chalk.bold(`[${i + 1}/${totalServers}] Compiling server: ${serverName}`));

      const result = await this.compileServer(
        {
          serverName,
          annotations: serverData.tools,
          storedAnnotations: storedAnnotationsFile.servers[serverName].tools,
          constitutionText: config.constitutionInput,
          constitutionKind: config.constitutionKind,
          allowedDirectory: config.allowedDirectory,
          protectedPaths: config.protectedPaths,
          mcpServerConfig: config.mcpServers?.[serverName],
          handwrittenScenarios: allHandwrittenScenarios.filter((s) => s.request.serverName === serverName),
        },
        config,
        constitutionHash,
      );
      results.push(result);
    }

    return results;
  }

  /**
   * Compiles a single server: compile -> generate scenarios -> verify -> repair.
   * Self-contained compile-verify-repair loop per server.
   */
  private async compileServer(
    unit: ServerCompilationUnit,
    config: PipelineRunConfig,
    constitutionHash: string,
  ): Promise<ServerCompilationResult> {
    const serverOutputDir = resolve(config.outputDir, 'servers', unit.serverName);

    // Build per-server system prompt (only this server's annotations)
    const compilerPrompt =
      unit.constitutionKind === 'task-policy'
        ? buildTaskCompilerSystemPrompt(
            unit.constitutionText,
            unit.annotations,
            unit.protectedPaths,
            unit.allowedDirectory,
            unit.serverName,
          )
        : buildCompilerSystemPrompt(
            unit.constitutionText,
            unit.annotations,
            { protectedPaths: unit.protectedPaths, allowedDirectory: unit.allowedDirectory },
            unit.handwrittenScenarios.length > 0 ? unit.handwrittenScenarios : undefined,
            { serverScope: unit.serverName },
          );

    // Check per-server cache
    const inputHash = computeServerPolicyHash(unit.serverName, unit.constitutionText, unit.annotations, compilerPrompt);
    const existingServerPolicy = loadExistingArtifact<ServerCompiledPolicyFile>(
      serverOutputDir,
      'compiled-policy.json',
    );
    const existingServerScenarios = loadExistingArtifact<TestScenariosFile>(serverOutputDir, 'test-scenarios.json');

    if (existingServerPolicy && existingServerPolicy.inputHash === inputHash && existingServerScenarios) {
      // Verify scenario hash to detect stale scenarios (e.g., changed templates or handwritten scenarios)
      const cachedPermittedDirs = extractPermittedDirectories(resolveRulePaths(existingServerPolicy.rules));
      const cachedDynamicLists = loadExistingArtifact<DynamicListsFile>(serverOutputDir, 'dynamic-lists.json');
      const cachedScenarioPrompt = buildGeneratorSystemPrompt(
        unit.constitutionText,
        unit.annotations,
        unit.allowedDirectory,
        cachedPermittedDirs,
        cachedDynamicLists,
        unit.storedAnnotations,
      );
      const cachedScenarioHash = computeScenariosHash(cachedScenarioPrompt, unit.handwrittenScenarios);

      if (existingServerScenarios.inputHash === cachedScenarioHash) {
        showCached(`  ${unit.serverName}: compilation`);
        return {
          serverName: unit.serverName,
          rules: resolveRulePaths(existingServerPolicy.rules),
          listDefinitions: existingServerPolicy.listDefinitions ?? [],
          scenarios: existingServerScenarios.scenarios,
          inputHash,
          constitutionHash,
          resolvedLists: cachedDynamicLists,
        };
      }
    }

    const compilerSystem = this.cacheStrategy.wrapSystemPrompt(compilerPrompt);

    // Step 1: Compile rules for this server
    this.logContext.stepName = `compile-${unit.serverName}`;
    const compileResult = await this.compileServerPolicyRules(unit, compilerSystem, inputHash);

    let { rules } = compileResult;
    let { listDefinitions } = compileResult;
    let compilerSession: ConstitutionCompilerSession | undefined = compileResult.session;

    // Validate server scoping (debug assertion)
    validateServerScoping(unit.serverName, rules);

    // Resolve dynamic lists for this server (before scenario generation so lists are available)
    let dynamicLists: DynamicListsFile | undefined;
    if (listDefinitions.length > 0) {
      dynamicLists = await this.resolveServerLists(listDefinitions, serverOutputDir, config, `  ${unit.serverName}`);
    }

    // Build per-server policy artifact for engine construction
    let serverPolicyFile = buildPolicyArtifact(constitutionHash, rules, listDefinitions, inputHash);

    // Persist early so intermediate results survive scenario/verification failures
    const writeServerPolicy = () =>
      writeArtifact(serverOutputDir, 'compiled-policy.json', {
        generatedAt: new Date().toISOString(),
        serverName: unit.serverName,
        constitutionHash,
        inputHash,
        rules,
        listDefinitions: listDefinitions.length > 0 ? listDefinitions : undefined,
      } satisfies ServerCompiledPolicyFile);
    writeServerPolicy();

    // Build per-server tool annotations file with conditional role specs preserved
    const serverAnnotationsFile: StoredToolAnnotationsFile = {
      generatedAt: new Date().toISOString(),
      servers: { [unit.serverName]: { inputHash, tools: unit.storedAnnotations } },
    };

    // Extract domain allowlists for this server
    const serverDomainAllowlists = unit.mcpServerConfig
      ? extractServerDomainAllowlists({ [unit.serverName]: unit.mcpServerConfig })
      : undefined;

    // Step 2: Generate test scenarios for this server
    this.logContext.stepName = `scenarios-${unit.serverName}`;
    const permittedDirectories = extractPermittedDirectories(rules);

    const scenarioPrompt = buildGeneratorSystemPrompt(
      unit.constitutionText,
      unit.annotations,
      unit.allowedDirectory,
      permittedDirectories,
      dynamicLists,
      unit.storedAnnotations,
    );
    const scenarioHash = computeScenariosHash(scenarioPrompt, unit.handwrittenScenarios);

    const scenarioResult = await this.generateTestScenarios(
      unit.constitutionText,
      unit.annotations,
      unit.allowedDirectory,
      unit.handwrittenScenarios,
      scenarioHash,
      existingServerScenarios,
      `  ${unit.serverName}`,
      permittedDirectories,
      dynamicLists,
      unit.storedAnnotations,
    );

    // Step 3: Verify compiled rules against scenarios
    this.logContext.stepName = `verify-${unit.serverName}`;

    const filterEngine = new PolicyEngine(
      serverPolicyFile,
      serverAnnotationsFile,
      unit.protectedPaths,
      unit.allowedDirectory,
      undefined,
      dynamicLists,
    );
    const { valid: filteredScenarios, discarded: discardedScenarios } = filterAndLogStructuralConflicts(
      filterEngine,
      scenarioResult.scenarios,
      undefined,
      unit.storedAnnotations,
    );

    // Generate replacement scenarios for structurally discarded ones (pre-loop, one-time)
    if (discardedScenarios.length > 0) {
      const discardedForRepair = discardedScenarios.map((d) => ({
        scenario: d.scenario,
        feedback: `${d.rule} always returns ${d.actual}`,
      }));
      this.logContext.stepName = `repair-scenarios-${unit.serverName}`;
      const replacementScenarios = await repairScenarios(
        discardedForRepair,
        unit.constitutionText,
        unit.annotations,
        unit.allowedDirectory,
        this.model,
        permittedDirectories,
        dynamicLists,
        (msg) => console.error(`  ${chalk.dim(msg)}`),
        unit.storedAnnotations,
      );
      if (replacementScenarios.length > 0) {
        // Filter replacements through structural invariants too
        const { valid: validReplacements } = filterAndLogStructuralConflicts(
          filterEngine,
          replacementScenarios,
          'Discarded replacement (structural conflict)',
          unit.storedAnnotations,
        );
        scenarioResult.scenarios.push(...validReplacements);
        filteredScenarios.push(...validReplacements);
        console.error(
          `  ${chalk.dim(`Repaired ${discardedScenarios.length} discarded scenario(s) → ${validReplacements.length} replacement(s)`)}`,
        );
      }
    }

    const serverToolNames = [...new Set(unit.annotations.map((a) => a.toolName))] as [string, ...string[]];
    const serverNames = [unit.serverName] as [string, ...string[]];
    const serverTools = unit.annotations.map((a) => ({ serverName: a.serverName, toolName: a.toolName }));

    let verifierSystem = this.cacheStrategy.wrapSystemPrompt(
      buildJudgeSystemPrompt(
        unit.constitutionText,
        serverPolicyFile,
        unit.protectedPaths,
        serverTools,
        dynamicLists,
        unit.allowedDirectory,
        unit.storedAnnotations,
      ),
    );
    let verifierSession = new PolicyVerifierSession({
      system: verifierSystem,
      model: this.model,
      serverNames,
      toolNames: serverToolNames,
      storedAnnotations: unit.storedAnnotations,
    });

    const verifyLabel = `  ${unit.serverName}: Verifying`;
    const { result: verificationResultInitial } = await withSpinner(
      verifyLabel,
      async (spinner) =>
        verifyPolicy(
          unit.constitutionText,
          serverPolicyFile,
          serverAnnotationsFile,
          unit.protectedPaths,
          filteredScenarios,
          this.model,
          3,
          unit.allowedDirectory,
          (msg) => {
            spinner.text = `${verifyLabel} — ${msg}`;
          },
          serverDomainAllowlists,
          dynamicLists,
          verifierSystem,
          verifierSession,
          unit.storedAnnotations,
        ),
      (r, elapsed) =>
        r.pass
          ? `${verifyLabel}: ${r.rounds.length} round(s) (${elapsed.toFixed(1)}s)`
          : `${verifyLabel}: completed with failures (${elapsed.toFixed(1)}s)`,
    );
    let verificationResult = verificationResultInitial;

    if (!verificationResult.pass) {
      this.logVerboseFailures(verificationResult);
    }

    // Collect probe scenarios
    const { valid: filteredInitialProbes } = filterAndLogStructuralConflicts(
      filterEngine,
      collectProbeScenarios(verificationResult),
      'Discarded probe (structural conflict)',
      unit.storedAnnotations,
    );
    const accumulatedProbes: TestScenario[] = filteredInitialProbes;

    // Compile-verify-repair loop (up to 2 repair attempts)
    const MAX_REPAIRS = 2;
    let repairAttempts = 0;
    let currentFilteredScenarios: TestScenario[];

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
          console.error(`  ${chalk.dim(`Corrected ${corrections.length} scenario expectation(s)`)}`);
        }

        ({ valid: currentFilteredScenarios } = filterAndLogStructuralConflicts(
          filterEngine,
          scenarioResult.scenarios,
          undefined,
          unit.storedAnnotations,
        ));

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
            handwrittenScenarios: unit.handwrittenScenarios.length > 0 ? unit.handwrittenScenarios : undefined,
          };

          this.logContext.stepName = `repair-compile-${unit.serverName}-${attempt}`;
          const repairText = `  ${unit.serverName} repair ${attempt}/${MAX_REPAIRS}: Recompiling`;
          const { result: repairResult } = await withSpinner(
            repairText,
            async (spinner) =>
              this.compilePolicyRulesWithPointFix(
                rules,
                unit.annotations,
                unit.protectedPaths,
                baseInputHash,
                repairContext,
                compilerSystem,
                compilerSession,
                listDefinitions,
                (msg) => {
                  spinner.text = `${repairText} — ${msg}`;
                },
              ),
            (r, elapsed) => `${repairText}: ${r.rules.length} rules (${elapsed.toFixed(1)}s)`,
          );
          rules = repairResult.rules;
          listDefinitions = repairResult.listDefinitions;
          compilerSession = repairResult.session;

          // Re-validate server scoping after repair
          validateServerScoping(unit.serverName, rules);

          // Re-resolve dynamic lists if repair changed list definitions
          if (listDefinitions.length > 0) {
            dynamicLists = await this.resolveServerLists(
              listDefinitions,
              serverOutputDir,
              config,
              `  ${unit.serverName}`,
            );
          }

          serverPolicyFile = buildPolicyArtifact(constitutionHash, rules, listDefinitions, inputHash);

          // Persist repaired rules immediately
          writeServerPolicy();

          verifierSystem = this.cacheStrategy.wrapSystemPrompt(
            buildJudgeSystemPrompt(
              unit.constitutionText,
              serverPolicyFile,
              unit.protectedPaths,
              serverTools,
              dynamicLists,
              unit.allowedDirectory,
              unit.storedAnnotations,
            ),
          );
          verifierSession = new PolicyVerifierSession({
            system: verifierSystem,
            model: this.model,
            serverNames,
            toolNames: serverToolNames,
            storedAnnotations: unit.storedAnnotations,
          });
        } else {
          console.error(`  ${chalk.dim('No rule-blamed failures — skipping recompilation')}`);
        }

        this.logContext.stepName = `repair-verify-${unit.serverName}-${attempt}`;
        const scenariosForRepairVerify = [...currentFilteredScenarios, ...accumulatedProbes];
        const repairVerifyText = `  ${unit.serverName} repair ${attempt}/${MAX_REPAIRS}: Verifying`;
        const { result: repairVerifyResult } = await withSpinner(
          repairVerifyText,
          async (spinner) =>
            verifyPolicy(
              unit.constitutionText,
              serverPolicyFile,
              serverAnnotationsFile,
              unit.protectedPaths,
              scenariosForRepairVerify,
              this.model,
              1,
              unit.allowedDirectory,
              (msg) => {
                spinner.text = `${repairVerifyText} — ${msg}`;
              },
              serverDomainAllowlists,
              dynamicLists,
              verifierSystem,
              verifierSession,
              unit.storedAnnotations,
            ),
          (r, elapsed) =>
            r.pass
              ? `${repairVerifyText}: passed (${elapsed.toFixed(1)}s)`
              : `${repairVerifyText}: ${r.failedScenarios.length} failure(s) (${elapsed.toFixed(1)}s)`,
        );
        verificationResult = repairVerifyResult;

        if (!verificationResult.pass) {
          this.logVerboseFailures(verificationResult);
        }

        const { valid: validRepairProbes } = filterAndLogStructuralConflicts(
          filterEngine,
          collectProbeScenarios(verificationResult),
          'Discarded probe (structural conflict)',
          unit.storedAnnotations,
        );
        accumulatedProbes.push(...validRepairProbes);

        repairAttempts = attempt;

        if (verificationResult.pass) {
          break;
        }
      }
    }

    // Write per-server artifacts (before verification check so they can be inspected on failure)
    const finalScenarios = [...scenarioResult.scenarios, ...accumulatedProbes];
    writeServerPolicy();
    writeArtifact(serverOutputDir, 'test-scenarios.json', {
      generatedAt: new Date().toISOString(),
      constitutionHash,
      inputHash: scenarioResult.inputHash,
      scenarios: finalScenarios,
    } satisfies TestScenariosFile);

    if (!verificationResult.pass) {
      throw new Error(
        `Verification FAILED for server "${unit.serverName}" — artifacts written for inspection but policy may need review.`,
      );
    }

    console.error(
      `  ${chalk.green(unit.serverName)}: ${rules.length} rules, ${finalScenarios.length} scenarios` +
        (repairAttempts > 0 ? `, ${repairAttempts} repair(s)` : ''),
    );

    return {
      serverName: unit.serverName,
      rules,
      listDefinitions,
      scenarios: finalScenarios,
      inputHash,
      constitutionHash,
      resolvedLists: dynamicLists,
    };
  }

  /**
   * Compiles policy rules for a single server (initial compilation).
   * Uses per-server schema with requireServer: true.
   */
  private async compileServerPolicyRules(
    unit: ServerCompilationUnit,
    system: string | SystemModelMessage,
    inputHash: string,
  ): Promise<{
    rules: CompiledRule[];
    listDefinitions: ListDefinition[];
    inputHash: string;
    session: ConstitutionCompilerSession;
  }> {
    const stepText = `  ${unit.serverName}: Compiling rules`;

    const session = new ConstitutionCompilerSession({
      system,
      model: this.model,
      annotations: unit.annotations,
      schemaOptions: { requireServer: true },
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
      (output, elapsed) => `${stepText}: ${output.rules.length} rules (${elapsed.toFixed(1)}s)`,
    );

    return {
      rules: compilationOutput.rules,
      listDefinitions: compilationOutput.listDefinitions,
      inputHash,
      session,
    };
  }

  // -----------------------------------------------------------------------
  // Private compilation methods
  // -----------------------------------------------------------------------

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

  /**
   * Attempts point-fix repair via the session, falling back to full recompile.
   * When a compiler session exists, uses repairPointFix() to emit a minimal
   * patch instead of regenerating the entire rule set. This avoids oscillation
   * where fixing one failure breaks previously-passing rules.
   */
  private async compilePolicyRulesWithPointFix(
    existingRules: CompiledRule[],
    annotations: ToolAnnotation[],
    protectedPaths: string[],
    baseInputHash: string,
    repairContext: RepairContext,
    system: string | SystemModelMessage,
    session: ConstitutionCompilerSession | undefined,
    existingListDefinitions: ListDefinition[],
    onProgress?: (message: string) => void,
  ): Promise<{
    rules: CompiledRule[];
    listDefinitions: ListDefinition[];
    inputHash: string;
    session?: ConstitutionCompilerSession;
  }> {
    let output;
    if (session) {
      output = await session.repairPointFix(existingRules, repairContext, existingListDefinitions, onProgress);
    } else {
      // No session available -- fall back to full recompile
      return this.compilePolicyRulesWithRepair(
        annotations,
        protectedPaths,
        baseInputHash,
        repairContext,
        system,
        session,
        onProgress,
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

  /**
   * Resolves dynamic lists for a single server's list definitions.
   * Loads existing per-server dynamic-lists.json for cache comparison,
   * connects MCP servers if needed, and writes results to serverOutputDir.
   */
  private async resolveServerLists(
    listDefinitions: ListDefinition[],
    serverOutputDir: string,
    config: PipelineRunConfig,
    labelPrefix: string,
  ): Promise<DynamicListsFile> {
    this.logContext.stepName = `resolve-lists-${labelPrefix.trim()}`;
    const existingLists = loadExistingArtifact<DynamicListsFile>(serverOutputDir, 'dynamic-lists.json');

    const needsMcp = listDefinitions.some((d) => d.requiresMcp);
    let mcpConnections: Map<string, McpServerConnection> | undefined;
    let policyEngine: PolicyEngine | undefined;
    if (needsMcp && config.mcpServers) {
      mcpConnections = await connectMcpServersForLists(listDefinitions, config.mcpServers);
      policyEngine = loadReadOnlyPolicyEngine(
        config.toolAnnotationsDir,
        config.toolAnnotationsFallbackDir,
        config.mcpServers,
      );
    }

    const listStepText = `${labelPrefix}: Resolving dynamic lists`;
    try {
      const { result: resolvedLists } = await withSpinner(
        listStepText,
        async (spinner) =>
          resolveAllLists(
            listDefinitions,
            { model: this.model, mcpConnections, policyEngine },
            existingLists,
            (msg) => {
              spinner.text = `${listStepText} — ${msg}`;
            },
          ),
        (result, elapsed) => {
          const count = Object.keys(result.lists).length;
          return `${listStepText}: ${count} list(s) resolved (${elapsed.toFixed(1)}s)`;
        },
      );
      writeArtifact(serverOutputDir, 'dynamic-lists.json', resolvedLists);
      return resolvedLists;
    } finally {
      if (mcpConnections) {
        await disconnectMcpServers(mcpConnections);
      }
    }
  }

  private async generateTestScenarios(
    constitutionText: string,
    annotations: ToolAnnotation[],
    allowedDirectory: string,
    handwrittenScenarios: TestScenario[],
    inputHash: string,
    existingScenarios: TestScenariosFile | undefined,
    stepLabel: string,
    permittedDirectories: string[] | undefined,
    dynamicLists: DynamicListsFile | undefined,
    storedAnnotations: StoredToolAnnotation[],
  ): Promise<{
    scenarios: TestScenario[];
    inputHash: string;
  }> {
    const stepText = `${stepLabel} Generating test scenarios`;

    if (existingScenarios && existingScenarios.inputHash === inputHash) {
      showCached(stepText);
      return { scenarios: existingScenarios.scenarios, inputHash };
    }

    const { result: scenarios } = await withSpinner(
      stepText,
      async (spinner) =>
        generateScenarios(
          constitutionText,
          annotations,
          handwrittenScenarios,
          allowedDirectory,
          this.model,
          permittedDirectories,
          (msg: string) => {
            spinner.text = `${stepText} — ${msg}`;
          },
          dynamicLists,
          (prompt: string) => this.cacheStrategy.wrapSystemPrompt(prompt),
          storedAnnotations,
        ),
      (scenarios, elapsed) => {
        const generatedCount = scenarios.length - handwrittenScenarios.length;
        return `${stepText}: ${scenarios.length} scenarios (${handwrittenScenarios.length} handwritten + ${generatedCount} generated) (${elapsed.toFixed(1)}s)`;
      },
    );

    return { scenarios, inputHash };
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
