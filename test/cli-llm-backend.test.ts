import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCliLlmCall, CliLlmError, probeCliLlmBackend } from '../src/llm/cli-backend.js';
import type { ParsedCliLlmModelId } from '../src/llm/model-spec.js';
import type { ResolvedCliLlmBackendConfig, ResolvedCliLlmBackendsConfig } from '../src/config/user-config.js';

describe('CLI LLM backend runner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'cli-llm-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeNodeScript(source: string): string {
    const path = resolve(tmpDir, 'fake-cli.cjs');
    writeFileSync(path, source, 'utf-8');
    chmodSync(path, 0o755);
    return path;
  }

  function config(
    scriptPath: string,
    overrides: Partial<ResolvedCliLlmBackendConfig> = {},
  ): ResolvedCliLlmBackendConfig {
    return {
      command: process.execPath,
      args: [scriptPath],
      modelArg: '--model',
      promptMode: 'stdin',
      promptFileArg: null,
      outputMode: 'json',
      timeoutSeconds: 5,
      ...overrides,
    };
  }

  const spec: ParsedCliLlmModelId = { backend: 'codex-cli', modelId: 'test-model' };

  it('parses successful JSON output and token usage', async () => {
    const script = makeNodeScript(`
process.stdin.resume();
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ result: 'OK:' + input.trim(), usage: { input_tokens: 2, output_tokens: 1 } }));
});
`);

    const result = await runCliLlmCall(spec, config(script), { prompt: 'hello' });
    expect(result.text).toBe('OK:hello');
    expect(result.usage?.inputTokens).toBe(2);
  });

  it('reports malformed JSON output', async () => {
    const script = makeNodeScript(`process.stdout.write('not json');`);

    await expect(runCliLlmCall(spec, config(script), { prompt: 'hello' })).rejects.toMatchObject({
      code: 'malformed_output',
    } satisfies Partial<CliLlmError>);
  });

  it('passes prompts through a temporary file when configured', async () => {
    const script = makeNodeScript(`
const fs = require('node:fs');
const flagIndex = process.argv.indexOf('--prompt-file');
const path = process.argv[flagIndex + 1];
process.stdout.write(JSON.stringify({ result: 'FILE:' + fs.readFileSync(path, 'utf-8').trim() }));
`);

    const result = await runCliLlmCall(
      spec,
      config(script, { promptMode: 'tempfile', promptFileArg: '--prompt-file' }),
      { prompt: 'hello from file' },
    );
    expect(result.text).toBe('FILE:hello from file');
  });

  it('reports nonzero exits', async () => {
    const script = makeNodeScript(`process.stderr.write('boom'); process.exit(7);`);

    await expect(runCliLlmCall(spec, config(script), { prompt: 'hello' })).rejects.toMatchObject({
      code: 'nonzero_exit',
    } satisfies Partial<CliLlmError>);
  });

  it('reports timeouts', async () => {
    const script = makeNodeScript(`setTimeout(() => {}, 10_000);`);

    await expect(
      runCliLlmCall(spec, config(script, { timeoutSeconds: 0.05 }), { prompt: 'hello' }),
    ).rejects.toMatchObject({
      code: 'timeout',
    } satisfies Partial<CliLlmError>);
  });

  it('reports missing commands', async () => {
    await expect(
      runCliLlmCall(spec, { ...config('unused'), command: resolve(tmpDir, 'missing-command') }, { prompt: 'hello' }),
    ).rejects.toMatchObject({
      code: 'missing_command',
    } satisfies Partial<CliLlmError>);
  });

  it('probes Claude-style CLI backends with configured capabilities', async () => {
    const script = makeNodeScript(`
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ text: 'OK', usage: { total_tokens: 3 } }));
});
`);
    const backends: ResolvedCliLlmBackendsConfig = {
      codex: config(script),
      claude: config(script, { outputMode: 'json' }),
    };

    const result = await probeCliLlmBackend('claude-code-cli', backends, 'sonnet');
    expect(result.runnable).toBe(true);
    expect(result.modelSelection).toBe(true);
    expect(result.tokenUsageAvailable).toBe(true);
  });
});
