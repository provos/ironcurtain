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
import type {
  CompiledRule,
  DiscardedScenario,
  TestScenario,
  ToolAnnotationsFile,
  StoredToolAnnotationsFile,
} from './types.js';
import { resolveRealPath, resolveStoredAnnotationsFile } from '../types/argument-roles.js';
import { createLlmLoggingMiddleware, type LlmLogContext } from './llm-logger.js';
import { createCacheStrategy, type PromptCacheStrategy } from '../session/prompt-cache.js';

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

export function loadPipelineConfig(): PipelineConfig {
  const configDir = resolve(__dirname, '..', 'config');
  const constitutionPath = resolve(configDir, 'constitution.md');
  const constitutionText = loadConstitutionText(constitutionPath);
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

  const generatedDir = getUserGeneratedDir();
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
// Scenario Merge
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
