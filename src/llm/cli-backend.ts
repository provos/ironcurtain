/**
 * Host-side CLI LLM backend runner.
 *
 * These calls are trusted IronCurtain control-plane operations. They never
 * interpolate user content into a shell string: prompts are passed through
 * stdin or a single argv element, and commands are launched with spawn().
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ResolvedCliLlmBackendsConfig, ResolvedCliLlmBackendConfig } from '../config/user-config.js';
import type { CliLlmBackendId, ParsedCliLlmModelId } from './model-spec.js';

export interface CliLlmCallOptions {
  readonly prompt: string;
  readonly abortSignal?: AbortSignal;
}

export interface CliLlmCallResult {
  readonly text: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface CliLlmProbeResult {
  readonly backend: CliLlmBackendId;
  readonly command: string;
  readonly runnable: boolean;
  readonly outputMode: 'json' | 'text';
  readonly promptMode: 'stdin' | 'tempfile';
  readonly promptFileArg: string | null;
  readonly modelSelection: boolean;
  readonly tokenUsageAvailable: boolean;
  readonly timeoutSeconds: number;
  readonly message: string;
}

export class CliLlmError extends Error {
  readonly code: 'missing_command' | 'nonzero_exit' | 'timeout' | 'malformed_output' | 'spawn_error';

  constructor(code: CliLlmError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CliLlmError';
    this.code = code;
  }
}

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export function resolveCliBackendConfig(
  backend: CliLlmBackendId,
  config: ResolvedCliLlmBackendsConfig,
): ResolvedCliLlmBackendConfig {
  switch (backend) {
    case 'codex-cli':
      return config.codex;
    case 'claude-cli':
    case 'claude-code-cli':
      return config.claude;
  }
}

export async function runCliLlmCall(
  spec: ParsedCliLlmModelId,
  backendConfig: ResolvedCliLlmBackendConfig,
  options: CliLlmCallOptions,
): Promise<CliLlmCallResult> {
  const promptFile = backendConfig.promptMode === 'tempfile' ? writePromptTempFile(options.prompt) : undefined;
  const args = buildCliArgs(spec, backendConfig, promptFile?.path);
  const timeoutMs = backendConfig.timeoutSeconds * 1000;

  const result = await runProcess({
    command: backendConfig.command,
    args,
    stdin: backendConfig.promptMode === 'stdin' ? options.prompt : undefined,
    timeoutMs,
    abortSignal: options.abortSignal,
  }).finally(() => {
    if (promptFile) rmSync(promptFile.dir, { recursive: true, force: true });
  });

  if (result.timedOut) {
    throw new CliLlmError('timeout', `${backendConfig.command} timed out after ${backendConfig.timeoutSeconds}s`);
  }

  if (result.spawnError) {
    const code = isMissingCommandError(result.spawnError) ? 'missing_command' : 'spawn_error';
    throw new CliLlmError(code, `${backendConfig.command} is not runnable: ${result.spawnError.message}`, {
      cause: result.spawnError,
    });
  }

  if (result.exitCode !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new CliLlmError('nonzero_exit', `${backendConfig.command} exited with code ${result.exitCode}: ${details}`);
  }

  return parseCliOutput(backendConfig, result.stdout, result.stderr);
}

export async function probeCliLlmBackend(
  backend: CliLlmBackendId,
  config: ResolvedCliLlmBackendsConfig,
  modelId?: string,
): Promise<CliLlmProbeResult> {
  const backendConfig = resolveCliBackendConfig(backend, config);
  const spec: ParsedCliLlmModelId = { backend, modelId };
  try {
    const result = await runCliLlmCall(
      spec,
      { ...backendConfig, timeoutSeconds: Math.min(15, backendConfig.timeoutSeconds) },
      {
        prompt: 'Reply with the single word OK.',
      },
    );
    return {
      backend,
      command: backendConfig.command,
      runnable: true,
      outputMode: backendConfig.outputMode,
      promptMode: backendConfig.promptMode,
      promptFileArg: backendConfig.promptFileArg,
      modelSelection: Boolean(modelId && backendConfig.modelArg),
      tokenUsageAvailable: result.usage !== undefined,
      timeoutSeconds: backendConfig.timeoutSeconds,
      message: result.usage ? 'round-trip succeeded with token usage' : 'round-trip succeeded; token usage unavailable',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      backend,
      command: backendConfig.command,
      runnable: false,
      outputMode: backendConfig.outputMode,
      promptMode: backendConfig.promptMode,
      promptFileArg: backendConfig.promptFileArg,
      modelSelection: Boolean(modelId && backendConfig.modelArg),
      tokenUsageAvailable: false,
      timeoutSeconds: backendConfig.timeoutSeconds,
      message,
    };
  }
}

function buildCliArgs(
  spec: ParsedCliLlmModelId,
  config: ResolvedCliLlmBackendConfig,
  promptFilePath: string | undefined,
): readonly string[] {
  const args = [...config.args];
  if (spec.modelId && config.modelArg) {
    args.push(config.modelArg, spec.modelId);
  }
  if (config.promptMode === 'tempfile') {
    if (!promptFilePath) throw new Error('prompt file path missing for tempfile prompt mode');
    if (config.promptFileArg) args.push(config.promptFileArg);
    args.push(promptFilePath);
  }
  return args;
}

function writePromptTempFile(prompt: string): { readonly dir: string; readonly path: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-cli-prompt-'));
  const path = resolve(dir, 'prompt.txt');
  writeFileSync(path, prompt, { encoding: 'utf-8', mode: 0o600 });
  return { dir, path };
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: Error;
}

function runProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly abortSignal?: AbortSignal;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener('abort', abort);
      resolve({ exitCode, stdout, stderr, timedOut, spawnError });
    };

    const kill = () => {
      if (!child.killed) child.kill('SIGTERM');
    };

    const abort = () => {
      timedOut = true;
      kill();
    };

    const timeout = setTimeout(abort, options.timeoutMs);
    options.abortSignal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, 'utf-8') < MAX_CAPTURE_BYTES) {
        stdout += chunk.toString('utf-8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, 'utf-8') < MAX_CAPTURE_BYTES) {
        stderr += chunk.toString('utf-8');
      }
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => finish(code));

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function isMissingCommandError(error: Error): boolean {
  return 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseCliOutput(config: ResolvedCliLlmBackendConfig, stdout: string, stderr: string): CliLlmCallResult {
  if (config.outputMode === 'text') {
    return { text: stdout.trim(), stdout, stderr };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CliLlmError('malformed_output', `Expected JSON output from ${config.command}: ${String(error)}`, {
      cause: error,
    });
  }

  const text = extractTextFromJson(parsed);
  if (text === undefined) {
    throw new CliLlmError('malformed_output', `JSON output from ${config.command} did not contain text content`);
  }

  return {
    text,
    stdout,
    stderr,
    usage: extractUsage(parsed),
  };
}

function extractTextFromJson(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;

  for (const key of ['result', 'text', 'message', 'output']) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
  }

  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined))
      .filter((part): part is string => typeof part === 'string');
    if (parts.length > 0) return parts.join('\n');
  }

  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === 'string') return message.content;
    if (typeof first?.text === 'string') return first.text;
  }

  return undefined;
}

function extractUsage(value: unknown): CliLlmCallResult['usage'] {
  if (!value || typeof value !== 'object') return undefined;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const record = usage as Record<string, unknown>;

  const inputTokens = readToken(record, ['input_tokens', 'prompt_tokens', 'inputTokens']);
  const outputTokens = readToken(record, ['output_tokens', 'completion_tokens', 'outputTokens']);
  const totalTokens = readToken(record, ['total_tokens', 'totalTokens']);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function readToken(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}
