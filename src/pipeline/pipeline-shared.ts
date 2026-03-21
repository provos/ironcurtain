/**
 * Shared utilities for the policy compilation pipeline.
 *
 * Used by both `annotate.ts` (tool annotation) and `compile.ts`
 * (policy compilation) to avoid duplication of config loading,
 * content-hash caching, and spinner helpers.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { wrapLanguageModel } from 'ai';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { computeProtectedPaths, resolveMcpServerPaths } from '../config/index.js';
import { createLanguageModel } from '../config/model-provider.js';
import { getIronCurtainHome, getUserGeneratedDir, loadConstitutionText } from '../config/paths.js';

// Re-export so existing pipeline callers (loadPipelineConfig) don't need updating.
import type { MCPServerConfig } from '../config/types.js';
import { loadUserConfig } from '../config/user-config.js';
import type { CompiledPolicyFile, CompiledRule, ToolAnnotationsFile, StoredToolAnnotationsFile } from './types.js';
import { resolveRealPath, resolveStoredAnnotationsFile } from '../types/argument-roles.js';
import { extractServerDomainAllowlists, loadGeneratedPolicy, getPackageGeneratedDir } from '../config/index.js';
import { getReadOnlyPolicyDir } from '../config/paths.js';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import { createLlmLoggingMiddleware, type LlmLogContext } from './llm-logger.js';
import { createCacheStrategy, type PromptCacheStrategy } from '../session/prompt-cache.js';

/** Canonical command to compile the read-only policy. Used in error/warning messages. */
export const COMPILE_READONLY_CMD = 'npm run compile-policy:readonly';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  constitutionPath: string;
  constitutionText: string;
  mcpServers: Record<string, MCPServerConfig>;
  generatedDir: string; // write target (user-local)
  packageGeneratedDir: string; // fallback for reads (package-bundled)
  allowedDirectory: string;
  protectedPaths: string[];
}

/** Optional CLI overrides for pipeline configuration. */
export interface PipelineConfigOverrides {
  /** Alternative constitution file path. */
  constitution?: string;
  /** Alternative output directory for compiled artifacts. */
  outputDir?: string;
}

export function loadPipelineConfig(overrides: PipelineConfigOverrides = {}): PipelineConfig {
  const configDir = resolve(__dirname, '..', 'config');

  // Constitution: use CLI override if provided, otherwise the default.
  // When overriding, read the file directly (skip user constitution merging).
  const constitutionPath = overrides.constitution ?? resolve(configDir, 'constitution.md');
  const constitutionText = overrides.constitution
    ? readFileSync(constitutionPath, 'utf-8')
    : loadConstitutionText(constitutionPath);

  const mcpServersPath = resolve(configDir, 'mcp-servers.json');
  const mcpServers = JSON.parse(readFileSync(mcpServersPath, 'utf-8')) as Record<string, MCPServerConfig>;
  resolveMcpServerPaths(mcpServers);

  const defaultAllowedDir = resolve(getIronCurtainHome(), 'sandbox');
  const allowedDirectory = process.env.ALLOWED_DIRECTORY ?? defaultAllowedDir;

  // Sync the filesystem server's allowed directory with the configured value
  const fsServer = mcpServers['filesystem'];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- key may not exist at runtime
  if (fsServer) {
    const defaultDir = '/tmp/ironcurtain-sandbox';
    const dirIndex = fsServer.args.indexOf(defaultDir);
    if (dirIndex !== -1) {
      fsServer.args[dirIndex] = allowedDirectory;
    }
  }

  // Output directory: use CLI override if provided, otherwise user generated dir.
  const generatedDir = overrides.outputDir ?? getUserGeneratedDir();
  const packageGeneratedDir = resolve(configDir, 'generated');
  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';

  const protectedPaths = computeProtectedPaths({
    constitutionPath,
    generatedDir,
    packageGeneratedDir,
    mcpServersPath,
    auditLogPath,
  });

  return {
    constitutionPath,
    constitutionText,
    mcpServers,
    generatedDir,
    packageGeneratedDir,
    allowedDirectory,
    protectedPaths,
  };
}

// ---------------------------------------------------------------------------
// Content-Hash Caching
// ---------------------------------------------------------------------------

export function computeHash(...inputs: string[]): string {
  const hash = createHash('sha256');
  for (const input of inputs) {
    hash.update(input);
  }
  return hash.digest('hex');
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T provides ergonomic caller-side typing for JSON artifacts
export function loadExistingArtifact<T>(generatedDir: string, filename: string, fallbackDir?: string): T | undefined {
  const candidates = [resolve(generatedDir, filename)];
  if (fallbackDir) {
    candidates.push(resolve(fallbackDir, filename));
  }
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
      // File missing or corrupt -- try next candidate
    }
  }
  return undefined;
}

/**
 * Loads tool-annotations.json, resolving any conditional role specs to their
 * default roles so the pipeline always sees the flat ToolAnnotationsFile shape.
 *
 * This is the single entry point for the compilation pipeline. Only the
 * annotator (which writes the file) and the policy engine (which resolves
 * conditionals at evaluation time against actual call args) need to know
 * about StoredToolAnnotationsFile.
 */
export function loadToolAnnotationsFile(dir: string, fallbackDir?: string): ToolAnnotationsFile | undefined {
  const stored = loadExistingArtifact<StoredToolAnnotationsFile>(dir, 'tool-annotations.json', fallbackDir);
  if (!stored) return undefined;
  return resolveStoredAnnotationsFile(stored);
}

// ---------------------------------------------------------------------------
// Spinner Helpers
// ---------------------------------------------------------------------------

export function showCached(text: string): void {
  const spinner = ora({ text, stream: process.stderr, discardStdin: false }).start();
  spinner.succeed(`${text} ${chalk.dim('(cached)')}`);
}

export async function withSpinner<T>(
  text: string,
  fn: (spinner: Ora) => Promise<T>,
  successFn?: (result: T, elapsed: number) => string,
): Promise<{ result: T; elapsed: number }> {
  const spinner = ora({ text, stream: process.stderr, discardStdin: false }).start();
  const start = Date.now();
  const timer = setInterval(() => {
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    spinner.text = `${text} (${secs}s)`;
  }, 1000);
  try {
    const result = await fn(spinner);
    clearInterval(timer);
    const elapsed = (Date.now() - start) / 1000;
    const successText = successFn ? successFn(result, elapsed) : `${text} (${elapsed.toFixed(1)}s)`;
    spinner.succeed(successText);
    return { result, elapsed };
  } catch (err) {
    clearInterval(timer);
    spinner.fail(chalk.red(text));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Artifact I/O
// ---------------------------------------------------------------------------

/** Writes a JSON artifact to the generated directory with consistent formatting. */
export function writeArtifact(generatedDir: string, filename: string, data: unknown): void {
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(resolve(generatedDir, filename), JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Rule Path Resolution
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
// LLM Setup
// ---------------------------------------------------------------------------

export interface PipelineLlm {
  model: LanguageModel;
  logContext: LlmLogContext;
  logPath: string;
  cacheStrategy: PromptCacheStrategy;
}

/**
 * Creates a language model wrapped with pipeline logging middleware.
 * Both annotate.ts and compile.ts use this to set up their LLM instance.
 */
export async function createPipelineLlm(generatedDir: string, initialStepName: string): Promise<PipelineLlm> {
  const userConfig = loadUserConfig();
  const baseLlm = await createLanguageModel(userConfig.policyModelId, userConfig);
  const logContext: LlmLogContext = { stepName: initialStepName };
  const logPath = resolve(generatedDir, 'llm-interactions.jsonl');
  const model = wrapLanguageModel({
    model: baseLlm,
    middleware: createLlmLoggingMiddleware(logPath, logContext),
  });
  const cacheStrategy = createCacheStrategy(userConfig.policyModelId);
  return { model, logContext, logPath, cacheStrategy };
}

// ---------------------------------------------------------------------------
// Read-Only Policy Engine
// ---------------------------------------------------------------------------

/**
 * Warns if the read-only compiled policy is missing rules for servers
 * that appear in tool-annotations.json. This indicates the read-only
 * policy needs recompilation after a new server was onboarded.
 */
export function checkReadonlyPolicyStaleness(
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
): void {
  const annotatedServers = new Set(Object.keys(toolAnnotations.servers));

  const coveredServers = new Set<string>();
  for (const rule of compiledPolicy.rules) {
    if (rule.if.server) {
      for (const s of rule.if.server) coveredServers.add(s);
    }
  }

  for (const server of annotatedServers) {
    if (!coveredServers.has(server)) {
      console.error(
        `  ${chalk.yellow('Warning:')} Read-only policy has no rules for server "${server}". ` +
          `Run "${COMPILE_READONLY_CMD}" to update.`,
      );
    }
  }
}

/**
 * Loads the read-only compiled policy and constructs a PolicyEngine for
 * mediating MCP calls during list resolution. Returns undefined if the
 * read-only policy is not available (e.g., not yet compiled).
 */
export function loadReadOnlyPolicyEngine(
  toolAnnotationsDir: string,
  toolAnnotationsFallbackDir: string | undefined,
  mcpServers: Record<string, MCPServerConfig> | undefined,
): PolicyEngine | undefined {
  const readonlyPolicyDir = getReadOnlyPolicyDir();
  const mainAnnotationsDir = toolAnnotationsDir;
  const fallbackDir = toolAnnotationsFallbackDir ?? getPackageGeneratedDir();

  let readonlyArtifacts;
  try {
    readonlyArtifacts = loadGeneratedPolicy({
      policyDir: readonlyPolicyDir,
      toolAnnotationsDir: mainAnnotationsDir,
      fallbackDir,
    });
  } catch {
    console.error(
      `  ${chalk.yellow('Warning:')} Read-only policy not found at ${readonlyPolicyDir}. ` +
        `Run "${COMPILE_READONLY_CMD}" to generate it.`,
    );
    return undefined;
  }

  checkReadonlyPolicyStaleness(readonlyArtifacts.compiledPolicy, readonlyArtifacts.toolAnnotations);

  const serverDomainAllowlists = mcpServers ? extractServerDomainAllowlists(mcpServers) : undefined;

  return new PolicyEngine(
    readonlyArtifacts.compiledPolicy,
    readonlyArtifacts.toolAnnotations as StoredToolAnnotationsFile,
    [], // protectedPaths: not relevant for cloud service calls
    undefined, // allowedDirectory: not relevant for cloud service calls
    serverDomainAllowlists,
    readonlyArtifacts.dynamicLists, // H3: pass dynamicLists for list expansion
  );
}
