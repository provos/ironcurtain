import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { registerAgent, getAgent, listAgents } from '../src/docker/agent-registry.js';
import { prepareSession, extractAllowedDomains } from '../src/docker/orientation.js';
import type { AgentId, ToolInfo, OrientationContext } from '../src/docker/agent-adapter.js';
import type { IronCurtainConfig } from '../src/config/types.js';

const sampleTools: ToolInfo[] = [
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
  { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } },
];

const sampleContext: OrientationContext = {
  workspaceDir: '/workspace',
  hostSandboxDir: '/home/user/.ironcurtain/sessions/test/sandbox',
  tools: sampleTools,
  allowedDomains: ['example.com'],
  networkMode: 'none',
};

describe('Claude Code Adapter', () => {
  it('returns the expected image name', async () => {
    const image = await claudeCodeAdapter.getImage();
    expect(image).toBe('ironcurtain-claude-code:latest');
  });

  it('generates MCP config with socat bridge', () => {
    const files = claudeCodeAdapter.generateMcpConfig('/run/ironcurtain/proxy.sock', sampleTools);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('claude-mcp-config.json');

    const config = JSON.parse(files[0].content) as Record<string, unknown>;
    expect(config).toHaveProperty('mcpServers');

    const servers = config.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers.ironcurtain.command).toBe('socat');
    expect(servers.ironcurtain.args).toContain('UNIX-CONNECT:/run/ironcurtain/proxy.sock');
  });

  it('builds command with --continue and --append-system-prompt', () => {
    const cmd = claudeCodeAdapter.buildCommand('Fix the bug', 'You are sandboxed');

    expect(cmd).toContain('claude');
    expect(cmd).toContain('--continue');
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

  it('builds system prompt with tool listing', () => {
    const prompt = claudeCodeAdapter.buildSystemPrompt(sampleContext);

    expect(prompt).toContain('/workspace');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('NO network access');
    expect(prompt).toContain('Host Filesystem');
    expect(prompt).toContain('Policy Enforcement');
  });

  it('returns providers including anthropic', () => {
    const providers = claudeCodeAdapter.getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].host).toBe('api.anthropic.com');
    expect(providers[0].displayName).toBe('Anthropic');
  });

  it('builds env with fake API key and NODE_EXTRA_CA_CERTS', () => {
    const config = {
      userConfig: { anthropicApiKey: 'sk-test' },
    } as IronCurtainConfig;

    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = claudeCodeAdapter.buildEnv(config, fakeKeys);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-ironcurtain-FAKE');
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

    const { systemPrompt } = prepareSession(claudeCodeAdapter, sampleTools, sessionDir, config, '/host/sandbox');

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
