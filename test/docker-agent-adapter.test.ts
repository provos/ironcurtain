import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeCodeAdapter } from '../src/docker/adapters/claude-code.js';

const claudeCodeAdapter = createClaudeCodeAdapter();
import { registerAgent, getAgent, listAgents } from '../src/docker/agent-registry.js';
import { prepareSession, extractAllowedDomains } from '../src/docker/orientation.js';
import { CONTAINER_WORKSPACE_DIR, type AgentId, type OrientationContext } from '../src/docker/agent-adapter.js';
import type { ServerListing } from '../src/types/server-listing.js';
import type { IronCurtainConfig } from '../src/config/types.js';

const sampleServerListings: ServerListing[] = [{ name: 'filesystem', description: 'Read, write, and manage files' }];

const sampleContext: OrientationContext = {
  workspaceDir: CONTAINER_WORKSPACE_DIR,
  hostSandboxDir: '/home/user/.ironcurtain/sessions/test/sandbox',
  serverListings: sampleServerListings,
  allowedDomains: ['example.com'],
  networkMode: 'none',
};

describe('Claude Code Adapter', () => {
  it('returns the expected image name', async () => {
    const image = await claudeCodeAdapter.getImage();
    expect(image).toBe('ironcurtain-claude-code:latest');
  });

  it('generates MCP config with socat bridge', () => {
    const files = claudeCodeAdapter.generateMcpConfig('/run/ironcurtain/proxy.sock');

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('claude-mcp-config.json');

    const config = JSON.parse(files[0].content) as Record<string, unknown>;
    expect(config).toHaveProperty('mcpServers');

    const servers = config.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers.ironcurtain.command).toBe('socat');
    expect(servers.ironcurtain.args).toContain('UNIX-CONNECT:/run/ironcurtain/proxy.sock');
  });

  it('pins a fresh session id on the first turn via --session-id', () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const cmd = claudeCodeAdapter.buildCommand('Fix the bug', 'You are sandboxed', {
      sessionId,
      firstTurn: true,
    });

    expect(cmd).toContain('claude');
    expect(cmd).toContain('--session-id');
    expect(cmd).toContain(sessionId);
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--continue');

    // --session-id and the uuid must be adjacent, in that order
    const flagIdx = cmd.indexOf('--session-id');
    expect(cmd[flagIdx + 1]).toBe(sessionId);

    // Other standard flags must still be present
    expect(cmd).toContain('--dangerously-skip-permissions');
    expect(cmd).toContain('--output-format');
    expect(cmd).toContain('json');
    expect(cmd).toContain('--mcp-config');
    expect(cmd).toContain('/etc/ironcurtain/claude-mcp-config.json');
    expect(cmd).toContain('--append-system-prompt');
    expect(cmd).toContain('You are sandboxed');
    expect(cmd).toContain('-p');
    expect(cmd).toContain('Fix the bug');
  });

  it('resumes an existing session on subsequent turns via --resume', () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const cmd = claudeCodeAdapter.buildCommand('Next step', 'You are sandboxed', {
      sessionId,
      firstTurn: false,
    });

    expect(cmd).toContain('--resume');
    expect(cmd).toContain(sessionId);
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('--continue');

    // --resume and the uuid must be adjacent, in that order
    const flagIdx = cmd.indexOf('--resume');
    expect(cmd[flagIdx + 1]).toBe(sessionId);
  });

  it('uses per-turn modelOverride for --model when provided', () => {
    const cmd = claudeCodeAdapter.buildCommand('Fix the bug', 'You are sandboxed', {
      sessionId: '11111111-2222-3333-4444-555555555555',
      firstTurn: true,
      modelOverride: 'anthropic:claude-opus-4-6',
    });
    const modelIdx = cmd.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    // Provider prefix is stripped; Claude CLI receives the bare model name.
    expect(cmd[modelIdx + 1]).toBe('claude-opus-4-6');
  });

  it('omits --model when neither adapter default nor override is set', () => {
    const cmd = claudeCodeAdapter.buildCommand('Fix the bug', 'You are sandboxed', {
      sessionId: '11111111-2222-3333-4444-555555555555',
      firstTurn: true,
    });
    expect(cmd).not.toContain('--model');
  });

  it('per-turn modelOverride wins over the adapter default model', () => {
    const adapter = createClaudeCodeAdapter({
      agentModelId: 'anthropic:claude-sonnet-4-6',
    } as unknown as Parameters<typeof createClaudeCodeAdapter>[0]);

    const sessionId = '11111111-2222-3333-4444-555555555555';
    const defaultCmd = adapter.buildCommand('msg', 'prompt', { sessionId, firstTurn: true });
    const defaultIdx = defaultCmd.indexOf('--model');
    expect(defaultCmd[defaultIdx + 1]).toBe('claude-sonnet-4-6');

    const overrideCmd = adapter.buildCommand('msg', 'prompt', {
      sessionId,
      firstTurn: true,
      modelOverride: 'anthropic:claude-haiku-4-5',
    });
    const overrideIdx = overrideCmd.indexOf('--model');
    expect(overrideCmd[overrideIdx + 1]).toBe('claude-haiku-4-5');
  });

  it('builds system prompt with Code Mode + Docker layers', () => {
    const prompt = claudeCodeAdapter.buildSystemPrompt(sampleContext);

    // Code Mode layer
    expect(prompt).toContain('help.help');
    expect(prompt).toContain('filesystem');
    expect(prompt).toContain('synchronous');

    // Docker environment layer
    expect(prompt).toContain('/workspace');
    expect(prompt).toContain('NO direct internet access');
    expect(prompt).toContain('When to use `execute_code`');
    expect(prompt).toContain('Policy Enforcement');
  });

  it('returns providers including anthropic', () => {
    const providers = claudeCodeAdapter.getProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].host).toBe('api.anthropic.com');
    expect(providers[0].displayName).toBe('Anthropic');
    expect(providers[1].host).toBe('platform.claude.com');
    expect(providers[1].displayName).toBe('Claude Platform');
  });

  it('builds env with fake API key and NODE_EXTRA_CA_CERTS', () => {
    const config = {
      userConfig: { anthropicApiKey: 'sk-test' },
    } as IronCurtainConfig;

    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = claudeCodeAdapter.buildEnv(config, fakeKeys);
    expect(env.IRONCURTAIN_API_KEY).toBe('sk-ant-api03-ironcurtain-FAKE');
    expect(env.CLAUDE_CODE_DISABLE_UPDATE_CHECK).toBe('1');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/usr/local/share/ca-certificates/ironcurtain-ca.crt');
  });

  it('extracts response and cost from valid JSON output', () => {
    const jsonOutput = JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0034,
      is_error: false,
      duration_ms: 2847,
      num_turns: 4,
      result: 'Task completed',
      session_id: 'abc-123',
    });
    const response = claudeCodeAdapter.extractResponse(0, jsonOutput);
    expect(response.text).toBe('Task completed');
    expect(response.costUsd).toBe(0.0034);
  });

  it('falls back to raw stdout when JSON is malformed', () => {
    const response = claudeCodeAdapter.extractResponse(0, '  Not JSON at all\n');
    expect(response.text).toBe('Not JSON at all');
    expect(response.costUsd).toBeUndefined();
  });

  it('falls back to raw stdout when JSON lacks result field', () => {
    const response = claudeCodeAdapter.extractResponse(0, JSON.stringify({ type: 'other' }));
    expect(response.text).toBe(JSON.stringify({ type: 'other' }));
    expect(response.costUsd).toBeUndefined();
  });

  it('returns text without costUsd on non-zero exit', () => {
    const response = claudeCodeAdapter.extractResponse(1, 'error message');
    expect(response.text).toContain('exited with code 1');
    expect(response.text).toContain('error message');
    expect(response.costUsd).toBeUndefined();
  });

  it('surfaces quotaExhausted with resetAt from Claude Code 429 envelope', () => {
    // Mirrors the envelope observed in the failed workflow run
    // e82b98ea-3195-412c-a6f7-669004f059ff that motivated this code path.
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      result:
        'API Error: Server is temporarily limiting requests (not your usage limit) · ' +
        '{"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-04-22 18:27:36"}}',
    });
    const response = claudeCodeAdapter.extractResponse(1, envelope);
    expect(response.quotaExhausted).toBeDefined();
    expect(response.quotaExhausted!.rawMessage).toContain('Usage limit reached');
    expect(response.quotaExhausted!.resetAt).toEqual(new Date('2026-04-22T18:27:36Z'));
    // The turn's `text` surfaces the raw message so CLI output stays readable.
    expect(response.text).toContain('Usage limit reached');
    // Quota exhaustion must NOT route through the hardFailure retry path.
    expect(response.hardFailure).toBeUndefined();
  });

  it('surfaces quotaExhausted without resetAt when timestamp is unparseable', () => {
    const envelope = JSON.stringify({
      is_error: true,
      api_error_status: 429,
      result: 'Rate limit exceeded. Try again later.',
    });
    const response = claudeCodeAdapter.extractResponse(1, envelope);
    expect(response.quotaExhausted).toBeDefined();
    expect(response.quotaExhausted!.rawMessage).toBe('Rate limit exceeded. Try again later.');
    expect(response.quotaExhausted!.resetAt).toBeUndefined();
  });

  it('does not flag quotaExhausted when is_error is set without api_error_status 429', () => {
    // Guards against false positives: other error classes (500s, auth
    // failures) must NOT route to the quota-pause path.
    const envelope = JSON.stringify({
      is_error: true,
      api_error_status: 500,
      result: 'Internal error',
    });
    const response = claudeCodeAdapter.extractResponse(1, envelope);
    expect(response.quotaExhausted).toBeUndefined();
  });

  it('does not flag quotaExhausted when non-zero exit stdout is not JSON', () => {
    const response = claudeCodeAdapter.extractResponse(1, 'plain text crash output');
    expect(response.quotaExhausted).toBeUndefined();
  });

  it('surfaces transientFailure when usage.output_tokens=0 AND stop_reason=null (degenerate stall envelope)', () => {
    // Mirrors the captured envelope from a sustained LiteLLM/Z.AI outage:
    // CLI exits 0, JSON parses, `result` non-empty (preamble), but the
    // stream hung server-side and produced no assistant content.
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'I will analyze the workspace next.',
      usage: { input_tokens: 1234, output_tokens: 0 },
      stop_reason: null,
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeDefined();
    expect(response.transientFailure!.kind).toBe('degenerate_response');
    expect(response.transientFailure!.rawMessage).toContain('output_tokens');
    // text retains the preamble so the message log has something to show.
    expect(response.text).toBe('I will analyze the workspace next.');
    // Transient failure must NOT route through the hardFailure or
    // quotaExhausted paths.
    expect(response.hardFailure).toBeUndefined();
    expect(response.quotaExhausted).toBeUndefined();
  });

  it('does not flag transientFailure on a healthy completion (stop_reason=end_turn, output_tokens>0)', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Task completed',
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: 'end_turn',
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeUndefined();
    expect(response.text).toBe('Task completed');
  });

  it('does not flag transientFailure on a legitimate empty completion (output_tokens=0 AND stop_reason=end_turn)', () => {
    // Boundary case documenting predicate strictness: a legitimate empty
    // completion sets stop_reason='end_turn', so it must NOT match.
    const envelope = JSON.stringify({
      type: 'result',
      result: '',
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: 'end_turn',
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeUndefined();
  });

  it('does not flag transientFailure on a partial-stream shape (output_tokens>0 AND stop_reason=null)', () => {
    // Boundary case: partial-stream detection is Phase 2 (out of scope
    // here). Confirms the predicate is strict (AND of both signals).
    const envelope = JSON.stringify({
      type: 'result',
      result: 'partial output',
      usage: { input_tokens: 100, output_tokens: 5 },
      stop_reason: null,
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeUndefined();
  });

  it('does not flag transientFailure when usage is absent (defensive: CLI version drift)', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: 'something',
      stop_reason: null,
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeUndefined();
  });

  it('does not flag transientFailure when usage is wrongly typed (defensive)', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: 'something',
      usage: 'not an object',
      stop_reason: null,
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeUndefined();
  });

  it('hard-failure (exit=143, empty stdout) sets hardFailure=true and not transientFailure', () => {
    // Mutual-exclusion regression guard: a kill-on-exit failure must NOT
    // be misclassified as a degenerate-response transient failure.
    const response = claudeCodeAdapter.extractResponse(143, '');
    expect(response.hardFailure).toBe(true);
    expect(response.transientFailure).toBeUndefined();
  });

  it('surfaces transientFailure even when CLI exits non-zero on the degenerate envelope', () => {
    // The degenerate envelope can arrive with a non-zero exit code (e.g.
    // the CLI surfacing a 5xx after the stream begins). The detector
    // must run in BOTH the exit=0 and exit!=0 paths so the structured
    // signal isn't lost to the generic hard-failure path.
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'preamble',
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: null,
    });
    const response = claudeCodeAdapter.extractResponse(1, envelope);
    expect(response.transientFailure).toBeDefined();
    expect(response.transientFailure!.kind).toBe('degenerate_response');
    expect(response.text).toBe('preamble');
    // Must NOT route through hardFailure: the orchestrator's hard-retry
    // rotation cannot recover a stalled upstream.
    expect(response.hardFailure).toBeUndefined();
    expect(response.quotaExhausted).toBeUndefined();
  });

  it('does not flag transientFailure when JSON envelope lacks type=result (predicate strictness)', () => {
    // An arbitrary object that happens to carry `result` plus the two
    // signal fields must NOT be flagged. Locks the `type === 'result'`
    // gate against future changes.
    const envelope = JSON.stringify({
      type: 'something_else',
      result: 'preamble',
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: null,
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeUndefined();
  });

  it('does not flag transientFailure when result field is absent', () => {
    // The detector gates on `typeof parsed.result === 'string'` so a
    // malformed envelope missing `result` does NOT match — applies to
    // both exit=0 and exit!=0 paths.
    const envelope = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: null,
    });
    const response = claudeCodeAdapter.extractResponse(0, envelope);
    expect(response.transientFailure).toBeUndefined();
    // Falls through to raw-stdout text.
    expect(response.text).toBe(envelope);
  });

  it('does not flag transientFailure on non-zero exit when result field is absent or non-string', () => {
    // Locks in cross-path consistency: the exit!=0 branch must apply
    // the same `typeof parsed.result === 'string'` gate as the exit=0
    // branch, otherwise a drifted envelope without `result` could
    // false-positive to the resumable-abort path.
    const noResult = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: null,
    });
    const noResultResponse = claudeCodeAdapter.extractResponse(1, noResult);
    expect(noResultResponse.transientFailure).toBeUndefined();

    const nonStringResult = JSON.stringify({
      type: 'result',
      result: { nested: 'object' },
      usage: { input_tokens: 100, output_tokens: 0 },
      stop_reason: null,
    });
    const nonStringResponse = claudeCodeAdapter.extractResponse(1, nonStringResult);
    expect(nonStringResponse.transientFailure).toBeUndefined();
  });

  it('returns conversation state config for session resume', () => {
    const config = claudeCodeAdapter.getConversationStateConfig!();
    expect(config.hostDirName).toBe('claude-state');
    expect(config.containerMountPath).toBe('/home/codespace/.claude/');
    expect(config.resumeFlags).toEqual(['--continue']);
    expect(config.seed.length).toBeGreaterThanOrEqual(1);

    // Verify projects/ seed is a directory entry
    const projects = config.seed.find((s) => s.path === 'projects/');
    expect(projects).toBeDefined();
    expect(projects!.content).toBe('');
  });
});

describe('Agent Registry', () => {
  it('registers and retrieves adapters', () => {
    // The registry is module-level state, so we test carefully
    registerAgent(claudeCodeAdapter);
    const adapter = getAgent('claude-code' as AgentId);
    expect(adapter.displayName).toBe('Claude Code');
  });

  it('throws on duplicate registration', () => {
    // Already registered above
    expect(() => registerAgent(claudeCodeAdapter)).toThrow('already registered');
  });

  it('throws on unknown agent', () => {
    expect(() => getAgent('nonexistent' as AgentId)).toThrow('Unknown agent');
  });

  it('lists registered agents', () => {
    const agents = listAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a) => a.id === 'claude-code')).toBe(true);
  });
});

describe('prepareSession', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'orientation-test-'));
  });

  afterEach(() => {
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('writes MCP config files to orientation directory', () => {
    const config = {
      mcpServers: {},
      userConfig: { anthropicApiKey: 'sk-test' },
    } as IronCurtainConfig;

    const { systemPrompt } = prepareSession(
      claudeCodeAdapter,
      sampleServerListings,
      sessionDir,
      config,
      '/host/sandbox',
    );

    // Check that orientation dir was created with config file
    const orientationDir = join(sessionDir, 'orientation');
    const mcpConfigPath = join(orientationDir, 'claude-mcp-config.json');
    expect(existsSync(mcpConfigPath)).toBe(true);

    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8')) as Record<string, unknown>;
    expect(mcpConfig).toHaveProperty('mcpServers');

    // System prompt should be non-empty
    expect(systemPrompt.length).toBeGreaterThan(100);
  });
});

describe('extractAllowedDomains', () => {
  it('extracts domains from sandbox network configs', () => {
    const config = {
      mcpServers: {
        fetch: {
          command: 'node',
          args: [],
          sandbox: {
            network: { allowedDomains: ['example.com', '*.github.com'] },
          },
        },
        filesystem: {
          command: 'node',
          args: [],
        },
      },
    } as unknown as IronCurtainConfig;

    const domains = extractAllowedDomains(config);
    expect(domains).toContain('example.com');
    expect(domains).toContain('*.github.com');
    expect(domains).toHaveLength(2);
  });

  it('returns empty array when no network configs', () => {
    const config = {
      mcpServers: {
        filesystem: { command: 'node', args: [] },
      },
    } as unknown as IronCurtainConfig;

    const domains = extractAllowedDomains(config);
    expect(domains).toEqual([]);
  });
});
