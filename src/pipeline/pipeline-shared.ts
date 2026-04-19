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
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import chalk from 'chalk';
import type pLimit from 'p-limit';
import ora, { type Ora } from 'ora';
import { applyAllowedDirectoryToMcpArgs, computeProtectedPaths, resolveMcpServerPaths } from '../config/index.js';
import { createLanguageModel } from '../config/model-provider.js';

type LimitFunction = ReturnType<typeof pLimit>;
import { getIronCurtainHome, getUserGeneratedDir, loadConstitutionText } from '../config/paths.js';

// Re-export so existing pipeline callers (loadPipelineConfig) don't need updating.
import type { MCPServerConfig } from '../config/types.js';
import { loadUserConfig } from '../config/user-config.js';
import type { CompiledRule, ToolAnnotationsFile, StoredToolAnnotationsFile } from './types.js';
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
  applyAllowedDirectoryToMcpArgs(mcpServers, allowedDirectory);

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

/**
 * Loads tool-annotations.json WITHOUT resolving conditional role specs.
 * Returns the raw on-disk format so callers can inspect conditional details
 * (e.g., for scenario generator prompts that need discriminator arg info).
 */
export function loadStoredToolAnnotationsFile(
  dir: string,
  fallbackDir?: string,
): StoredToolAnnotationsFile | undefined {
  return loadExistingArtifact<StoredToolAnnotationsFile>(dir, 'tool-annotations.json', fallbackDir);
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
  /** The unwrapped base model (no middleware). Used to create per-server models. */
  baseLlm: LanguageModelV3;
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
  return { model, baseLlm, logContext, logPath, cacheStrategy };
}

/**
 * Creates a per-server wrapped LanguageModel with its own log context.
 * The base LLM (expensive: API key, provider) is shared; only the
 * lightweight logging middleware is per-server.
 */
export function createPerServerModel(
  baseLlm: LanguageModelV3,
  logPath: string,
  serverName: string,
): { model: LanguageModelV3; logContext: LlmLogContext } {
  const logContext: LlmLogContext = { stepName: `init-${serverName}` };
  const model = wrapLanguageModel({
    model: baseLlm,
    middleware: createLlmLoggingMiddleware(logPath, logContext, { deltaLogging: false, appendOnly: true }),
  });
  return { model, logContext };
}

/**
 * Wraps a LanguageModel so that `doGenerate` and `doStream` acquire
 * the semaphore before delegating. This caps total concurrent LLM API
 * calls across all servers.
 */
export function createThrottledModel(model: LanguageModelV3, semaphore: LimitFunction): LanguageModelV3 {
  return {
    ...model,
    doGenerate: (options: LanguageModelV3CallOptions) => semaphore(() => model.doGenerate(options)),
    doStream: (options: LanguageModelV3CallOptions) => semaphore(() => model.doStream(options)),
  };
}

// ---------------------------------------------------------------------------
// Progress Reporting
// ---------------------------------------------------------------------------

export type CompilationPhase =
  | 'cached'
  | 'compiling'
  | 'lists'
  | 'scenarios'
  | 'repair-scenarios'
  | 'verifying'
  | 'repair-compile'
  | 'repair-verify'
  | 'done';

/**
 * Abstracts progress reporting for a single server's compilation.
 * Implementations differ between sequential (ora spinner) and parallel
 * (multi-line status table) modes.
 */
export interface ServerProgressReporter {
  /** Report a phase change for this server. */
  update(phase: CompilationPhase, detail?: string): void;
  /** Mark a phase as complete with timing information. */
  complete(phase: CompilationPhase, summary: string, elapsed: number): void;
  /** Report a warning or diagnostic message. */
  warn(message: string): void;
  /** Mark this server as failed. */
  fail(phase: CompilationPhase, error: Error): void;
  /** Mark this server as fully complete. */
  done(summary: string): void;
}

/**
 * Sequential-mode progress reporter backed by ora spinners.
 * Preserves the exact behavior of the pre-parallel pipeline.
 */
export class SpinnerProgressReporter implements ServerProgressReporter {
  private spinner: Ora | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private phaseStart = 0;
  private readonly serverName: string;

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  update(phase: CompilationPhase, detail?: string): void {
    this.stopSpinner();
    const text = this.formatText(phase, detail);
    this.spinner = ora({ text, stream: process.stderr, discardStdin: false }).start();
    this.phaseStart = Date.now();
    const spinner = this.spinner;
    this.timer = setInterval(() => {
      const secs = ((Date.now() - this.phaseStart) / 1000).toFixed(0);
      spinner.text = `${this.formatText(phase, detail)} (${secs}s)`;
    }, 1000);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface conformance
  complete(phase: CompilationPhase, summary: string, elapsed: number): void {
    this.stopTimer();
    if (this.spinner) {
      this.spinner.succeed(summary);
      this.spinner = undefined;
    } else {
      console.error(summary);
    }
  }

  warn(message: string): void {
    // Pause spinner to avoid interleaving, then resume
    if (this.spinner) {
      this.spinner.stop();
      console.error(message);
      this.spinner.start();
    } else {
      console.error(message);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface conformance
  fail(phase: CompilationPhase, error: Error): void {
    this.stopTimer();
    if (this.spinner) {
      this.spinner.fail();
      this.spinner = undefined;
    }
  }

  done(summary: string): void {
    this.stopSpinner();
    console.error(`  ${chalk.green(this.serverName)}: ${summary}`);
  }

  private formatText(phase: CompilationPhase, detail?: string): string {
    const base = `  ${this.serverName}: ${phaseLabel(phase)}`;
    return detail ? `${base} — ${detail}` : base;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private stopSpinner(): void {
    this.stopTimer();
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = undefined;
    }
  }
}

/** Human-readable label for each compilation phase. */
function phaseLabel(phase: CompilationPhase): string {
  switch (phase) {
    case 'cached':
      return 'Compilation';
    case 'compiling':
      return 'Compiling rules';
    case 'lists':
      return 'Resolving dynamic lists';
    case 'scenarios':
      return 'Generating test scenarios';
    case 'repair-scenarios':
      return 'Repairing discarded scenarios';
    case 'verifying':
      return 'Verifying';
    case 'repair-compile':
      return 'Recompiling (repair)';
    case 'repair-verify':
      return 'Verifying (repair)';
    case 'done':
      return 'Done';
  }
}
