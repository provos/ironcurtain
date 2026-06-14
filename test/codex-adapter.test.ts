import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexAdapter } from '../src/docker/adapters/codex.js';
import { CONTAINER_WORKSPACE_DIR, type OrientationContext } from '../src/docker/agent-adapter.js';
import { generateFakeKey } from '../src/docker/fake-keys.js';
import type { IronCurtainConfig } from '../src/config/types.js';

const sampleContext: OrientationContext = {
  workspaceDir: CONTAINER_WORKSPACE_DIR,
  hostSandboxDir: '/home/user/.ironcurtain/sessions/test/sandbox',
  serverListings: [{ name: 'filesystem', description: 'Read, write, and manage files' }],
  allowedDomains: ['example.com'],
  networkMode: 'none',
};

describe('CodexAdapter', () => {
  const adapter = createCodexAdapter();

  it('returns the expected image name', async () => {
    await expect(adapter.getImage()).resolves.toBe('ironcurtain-codex:latest');
  });

  it('generates Codex TOML config with MCP stdio bridge and CLAUDE.md fallback', () => {
    const files = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock');

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('codex-config.toml');
    expect(files[0].content).toContain('project_doc_fallback_filenames = ["CLAUDE.md"]');
    expect(files[0].content).toContain('[mcp_servers.ironcurtain]');
    expect(files[0].content).toContain('command = "socat"');
    expect(files[0].content).toContain('"UNIX-CONNECT:/run/ironcurtain/proxy.sock"');
    expect(files[0].content).toContain('default_tools_approval_mode = "auto"');
  });

  it('generates TCP MCP config for macOS bridge mode', () => {
    const files = adapter.generateMcpConfig('host.docker.internal:12345');
    expect(files[0].content).toContain('"TCP:host.docker.internal:12345"');
  });

  it('builds a non-interactive codex exec command with approvals disabled', () => {
    const cmd = adapter.buildCommand('say hi', 'system prompt', {
      sessionId: 'test-session',
      firstTurn: true,
    });

    expect(cmd.slice(0, 6)).toEqual([
      'codex',
      '--ask-for-approval',
      'never',
      '--sandbox',
      'danger-full-access',
      'exec',
    ]);
    expect(cmd).toContain('--json');
    expect(cmd).toContain('--skip-git-repo-check');
    expect(cmd).toContain('--cd');
    expect(cmd).toContain('/workspace');
    expect(cmd.at(-1)).toContain('system prompt');
    expect(cmd.at(-1)).toContain('say hi');
  });

  it('passes modelOverride to Codex without leaking the provider prefix', () => {
    const cmd = adapter.buildCommand('say hi', 'system prompt', {
      sessionId: 'test-session',
      firstTurn: true,
      modelOverride: 'openai:gpt-5.5',
    });

    const idx = cmd.indexOf('--model');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(cmd[idx + 1]).toBe('gpt-5.5');
  });

  it('builds system prompt with Docker and policy guidance', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('help.help');
    expect(prompt).toContain('/workspace');
    expect(prompt).toContain('NO direct internet access');
    expect(prompt).toContain('Policy Enforcement');
  });

  it('returns Codex ChatGPT OAuth providers', () => {
    const providers = adapter.getProviders('oauth');
    expect(providers.map((p) => p.host)).toEqual(['chatgpt.com', 'auth.openai.com']);
    expect(providers.every((p) => p.keyInjection.type === 'bearer')).toBe(true);
    expect(providers[1].fakeKeyPrefix).toBe(providers[0].fakeKeyPrefix);
    expect(generateFakeKey(providers[0].fakeKeyPrefix)).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(providers[0].allowedEndpoints).toContainEqual({ method: 'POST', path: '/codex-backend/agent-identity' });
    expect(providers[0].allowedEndpoints).toContainEqual({ method: 'GET', path: '/agent-identities/jwks' });
  });

  it('builds env with fake Codex auth seeds and no raw provider credential env vars', () => {
    const env = adapter.buildEnv({} as IronCurtainConfig, new Map([['chatgpt.com', 'codex-fake-token']]));

    expect(env.CODEX_HOME).toBe('/home/codespace/.codex');
    expect(env.IRONCURTAIN_CODEX_ACCESS_TOKEN).toBe('codex-fake-token');
    expect(env.IRONCURTAIN_CODEX_ID_TOKEN).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(env.CODEX_CA_CERTIFICATE).toBe('/usr/local/share/ca-certificates/ironcurtain-ca.crt');
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('extracts the final agent_message from Codex JSONL output', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'turn.completed' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    ].join('\n');

    expect(adapter.extractResponse(0, stdout).text).toBe('final answer');
  });

  it('falls back to raw stdout when JSONL has no agent message', () => {
    const stdout = JSON.stringify({ type: 'turn.completed' });
    expect(adapter.extractResponse(0, stdout).text).toBe(stdout);
  });

  it('reports non-zero exits with Codex label', () => {
    const response = adapter.extractResponse(2, 'auth failed', 'stderr details');
    expect(response.text).toContain('Codex exited with code 2');
    expect(response.text).toContain('auth failed');
    expect(response.text).toContain('stderr details');
  });

  it('flags quotaExhausted when a rate-limit error event appears on exit 0', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Rate limit exceeded (429): usage limit reached, retry later' },
      }),
    ].join('\n');

    const response = adapter.extractResponse(0, stdout);
    expect(response.quotaExhausted).toBeDefined();
    expect(response.quotaExhausted?.rawMessage).toContain('429');
    expect(response.transientFailure).toBeUndefined();
    // No agent_message present, so the text describes the failure rather
    // than dumping a raw JSONL line.
    expect(response.text).toContain('Codex reported an error');
    expect(response.text).toContain('Rate limit exceeded');
  });

  it('flags quotaExhausted when stderr reports a 429 on a non-zero exit', () => {
    const response = adapter.extractResponse(1, '', 'HTTP 429 Too Many Requests');
    expect(response.quotaExhausted).toBeDefined();
    expect(response.quotaExhausted?.rawMessage).toContain('429');
    expect(response.text).toContain('Codex exited with code 1');
  });

  it('flags a generic error item as a transient failure (not quota) on exit 0', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'upstream connection reset' } }),
    ].join('\n');

    const response = adapter.extractResponse(0, stdout);
    expect(response.quotaExhausted).toBeUndefined();
    expect(response.transientFailure?.kind).toBe('degenerate_response');
    expect(response.transientFailure?.rawMessage).toContain('upstream connection reset');
    expect(response.text).toContain('upstream connection reset');
  });

  it('extracts a valid agent_message even when a malformed JSON line precedes it', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
      '{ this is not valid json',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'recovered answer' } }),
    ].join('\n');

    let response: ReturnType<typeof adapter.extractResponse> | undefined;
    expect(() => {
      response = adapter.extractResponse(0, stdout);
    }).not.toThrow();
    expect(response?.text).toBe('recovered answer');
    expect(response?.quotaExhausted).toBeUndefined();
    expect(response?.transientFailure).toBeUndefined();
  });

  it('detects Codex OAuth credentials from CODEX_HOME auth.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-adapter-auth-'));
    const oldCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmp;
      writeFileSync(
        join(tmp, 'auth.json'),
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'real-codex-token' } }),
      );

      const result = adapter.detectCredential!({} as IronCurtainConfig);
      expect(result.kind).toBe('oauth');
      if (result.kind !== 'oauth') throw new Error('expected oauth');
      expect(result.credentials.accessToken).toBe('real-codex-token');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns none when Codex auth.json is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'codex-adapter-no-auth-'));
    const oldCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = tmp;
      expect(adapter.detectCredential!({} as IronCurtainConfig).kind).toBe('none');
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns conversation state config for CODEX_HOME', () => {
    const config = adapter.getConversationStateConfig!();
    expect(config.hostDirName).toBe('codex-state');
    expect(config.containerMountPath).toBe('/home/codespace/.codex/');
    expect(config.seed.map((s) => s.path)).toContain('sessions/');
  });
});
