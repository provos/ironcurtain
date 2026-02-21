/**
 * Shared utilities for the policy compilation pipeline.
 *
 * Used by both `annotate.ts` (tool annotation) and `compile.ts`
 * (policy compilation) to avoid duplication of config loading,
 * content-hash caching, and spinner helpers.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { wrapLanguageModel } from 'ai';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { computeProtectedPaths, resolveMcpServerPaths } from '../config/index.js';
import { createLanguageModel } from '../config/model-provider.js';
import { getIronCurtainHome, getUserConstitutionPath, getUserGeneratedDir } from '../config/paths.js';
import type { MCPServerConfig } from '../config/types.js';
import { loadUserConfig } from '../config/user-config.js';
import { createLlmLoggingMiddleware, type LlmLogContext } from './llm-logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  constitutionPath: string;
  constitutionText: string;
  constitutionHash: string;
  mcpServers: Record<string, MCPServerConfig>;
  generatedDir: string;           // write target (user-local)
  packageGeneratedDir: string;    // fallback for reads (package-bundled)
  allowedDirectory: string;
  protectedPaths: string[];
}

/**
 * Loads the combined constitution text (base + optional user constitution).
 * The user constitution file is at ~/.ironcurtain/constitution-user.md.
 * When present, it is appended to the base constitution text.
 */
export function loadConstitutionText(basePath: string): string {
  const base = readFileSync(basePath, 'utf-8');
  const userPath = getUserConstitutionPath();
  if (existsSync(userPath)) {
    const user = readFileSync(userPath, 'utf-8');
    return `${base}\n\n${user}`;
  }
  return base;
}

export function loadPipelineConfig(): PipelineConfig {
  const configDir = resolve(__dirname, '..', 'config');
  const constitutionPath = resolve(configDir, 'constitution.md');
  const constitutionText = loadConstitutionText(constitutionPath);
  const constitutionHash = createHash('sha256').update(constitutionText).digest('hex');
  const mcpServersPath = resolve(configDir, 'mcp-servers.json');
  const mcpServers: Record<string, MCPServerConfig> = JSON.parse(
    readFileSync(mcpServersPath, 'utf-8'),
  );
  resolveMcpServerPaths(mcpServers);

  const defaultAllowedDir = resolve(getIronCurtainHome(), 'sandbox');
  const allowedDirectory = process.env.ALLOWED_DIRECTORY ?? defaultAllowedDir;

  // Sync the filesystem server's allowed directory with the configured value
  const fsServer = mcpServers['filesystem'];
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
    constitutionHash,
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

export function loadExistingArtifact<T>(
  generatedDir: string,
  filename: string,
  fallbackDir?: string,
): T | undefined {
  const candidates = [resolve(generatedDir, filename)];
  if (fallbackDir) {
    candidates.push(resolve(fallbackDir, filename));
  }
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        // Corrupt file -- try next candidate
      }
    }
  }
  return undefined;
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
    const successText = successFn
      ? successFn(result, elapsed)
      : `${text} (${elapsed.toFixed(1)}s)`;
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
  writeFileSync(
    resolve(generatedDir, filename),
    JSON.stringify(data, null, 2) + '\n',
  );
}

// ---------------------------------------------------------------------------
// LLM Setup
// ---------------------------------------------------------------------------

export interface PipelineLlm {
  model: LanguageModel;
  logContext: LlmLogContext;
  logPath: string;
}

/**
 * Creates a language model wrapped with pipeline logging middleware.
 * Both annotate.ts and compile.ts use this to set up their LLM instance.
 */
export async function createPipelineLlm(
  generatedDir: string,
  initialStepName: string,
): Promise<PipelineLlm> {
  const userConfig = loadUserConfig();
  const baseLlm = await createLanguageModel(userConfig.policyModelId, userConfig);
  const logContext: LlmLogContext = { stepName: initialStepName };
  const logPath = resolve(generatedDir, 'llm-interactions.jsonl');
  const model = wrapLanguageModel({
    model: baseLlm,
    middleware: createLlmLoggingMiddleware(logPath, logContext),
  });
  return { model, logContext, logPath };
}
