import { describe, it, expect } from 'vitest';
import {
  createGooseAdapter,
  escapeHeredoc,
  extractFinalResponse,
  stripAnsi,
  getProviderConfig,
} from '../src/docker/adapters/goose.js';
import { CONTAINER_WORKSPACE_DIR, type OrientationContext } from '../src/docker/agent-adapter.js';
import type { ServerListing } from '../src/session/prompts.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedUserConfig } from '../src/config/user-config.js';

// ─── Test Fixtures ───────────────────────────────────────────

const sampleServerListings: ServerListing[] = [{ name: 'filesystem', description: 'Read, write, and manage files' }];

const sampleContext: OrientationContext = {
  workspaceDir: CONTAINER_WORKSPACE_DIR,
  hostSandboxDir: '/home/user/.ironcurtain/sessions/test/sandbox',
  serverListings: sampleServerListings,
  allowedDomains: ['example.com'],
  networkMode: 'none',
};

function makeUserConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    anthropicApiKey: 'sk-test-anthropic',
    googleApiKey: 'AIzaSy-test-google',
    openaiApiKey: 'sk-test-openai',
    escalationTimeoutSeconds: 300,
    resourceBudget: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
      warnThresholdPercent: 80,
    },
    autoCompact: {
      enabled: true,
      thresholdTokens: 160_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
    auditRedaction: { enabled: true },
    webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
    serverCredentials: {},
    signal: null,
    gooseProvider: 'anthropic',
    gooseModel: 'claude-sonnet-4-20250514',
    preferredDockerAgent: 'claude-code',
    ...overrides,
  };
}

// ─── Adapter Creation ────────────────────────────────────────

describe('createGooseAdapter', () => {
  it('creates adapter with default config when no userConfig provided', () => {
    const adapter = createGooseAdapter();
    expect(adapter.id).toBe('goose');
    expect(adapter.displayName).toBe('Goose');
  });

  it('creates adapter with custom config', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));
    expect(adapter.id).toBe('goose');
  });
});

// ─── getImage ────────────────────────────────────────────────

describe('GooseAdapter.getImage', () => {
  it('returns the expected image name', async () => {
    const adapter = createGooseAdapter();
    const image = await adapter.getImage();
    expect(image).toBe('ironcurtain-goose:latest');
  });
});

// ─── generateMcpConfig ──────────────────────────────────────

describe('GooseAdapter.generateMcpConfig', () => {
  const adapter = createGooseAdapter();

  it('generates YAML config with UNIX-CONNECT for UDS path', () => {
    const files = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock');

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('goose-config.yaml');
    expect(files[0].content).toContain('UNIX-CONNECT:/run/ironcurtain/proxy.sock');
    expect(files[0].content).toContain('extensions:');
    expect(files[0].content).toContain('ironcurtain:');
    expect(files[0].content).toContain('type: stdio');
    expect(files[0].content).toContain('cmd: socat');
    expect(files[0].content).toContain('timeout: 600');
  });

  it('generates YAML config with TCP for host:port address', () => {
    const files = adapter.generateMcpConfig('host.docker.internal:12345');

    expect(files).toHaveLength(1);
    expect(files[0].content).toContain('TCP:host.docker.internal:12345');
    expect(files[0].content).not.toContain('UNIX-CONNECT');
  });

  it('produces valid YAML structure with telemetry disabled', () => {
    const files = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock');
    const content = files[0].content;

    // Verify the YAML contains the required keys
    expect(content).toContain('name: IronCurtain Sandbox');
    expect(content).toContain('enabled: true');
    expect(content).toContain('- STDIO');
    expect(content).toContain('GOOSE_TELEMETRY_ENABLED: false');
  });
});

// ─── generateOrientationFiles ────────────────────────────────

describe('GooseAdapter.generateOrientationFiles', () => {
  const adapter = createGooseAdapter();

  it('returns 3 executable scripts', () => {
    const files = adapter.generateOrientationFiles(sampleContext);

    expect(files).toHaveLength(3);
    expect(files.map((f) => f.path)).toEqual(['start-goose.sh', 'resize-pty.sh', 'check-pty-size.sh']);
  });

  it('all scripts have executable mode', () => {
    const files = adapter.generateOrientationFiles(sampleContext);

    for (const file of files) {
      expect(file.mode).toBe(0o755);
    }
  });

  it('scripts reference goose process, not claude', () => {
    const files = adapter.generateOrientationFiles(sampleContext);

    for (const file of files) {
      expect(file.content).toContain('goose');
      expect(file.content).not.toContain('claude');
    }
  });

  it('start script uses goose run -s with instructions file', () => {
    const files = adapter.generateOrientationFiles(sampleContext);
    const startScript = files.find((f) => f.path === 'start-goose.sh')!;
    expect(startScript.content).toContain('goose run -s');
    expect(startScript.content).toContain('-i "$PROMPT_FILE"');
    expect(startScript.content).toContain('IRONCURTAIN_SYSTEM_PROMPT');
  });

  it('resize script targets goose process', () => {
    const files = adapter.generateOrientationFiles(sampleContext);
    const resizeScript = files.find((f) => f.path === 'resize-pty.sh')!;
    expect(resizeScript.content).toContain('pgrep -x goose');
    expect(resizeScript.content).toContain('WINCH');
  });
});

// ─── buildCommand ────────────────────────────────────────────

describe('GooseAdapter.buildCommand', () => {
  const adapter = createGooseAdapter();

  it('returns a shell command with goose run --no-session', () => {
    const cmd = adapter.buildCommand('Fix the bug', 'You are sandboxed');

    expect(cmd).toHaveLength(3);
    expect(cmd[0]).toBe('/bin/sh');
    expect(cmd[1]).toBe('-c');
    expect(cmd[2]).toContain('goose run --no-session');
  });

  it('includes -i flag for instructions file', () => {
    const cmd = adapter.buildCommand('Fix the bug', 'You are sandboxed');
    expect(cmd[2]).toContain('-i "$PROMPT_FILE"');
  });

  it('includes system prompt in instructions', () => {
    const cmd = adapter.buildCommand('Fix the bug', 'You are sandboxed');
    expect(cmd[2]).toContain('You are sandboxed');
    expect(cmd[2]).toContain('Fix the bug');
  });

  it('uses IRONCURTAIN_EOF delimiter for heredoc', () => {
    const cmd = adapter.buildCommand('hello', 'prompt');
    expect(cmd[2]).toContain('IRONCURTAIN_EOF');
  });

  it('escapes heredoc delimiter when input contains IRONCURTAIN_EOF', () => {
    const cmd = adapter.buildCommand('IRONCURTAIN_EOF', 'system prompt');
    // The delimiter should have a suffix to avoid collision
    const shellCmd = cmd[2];
    // The default delimiter should not appear without a suffix
    // because the input contains it
    const matches = shellCmd.match(/IRONCURTAIN_EOF_[a-f0-9]{8}/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(0);
  });
});

// ─── buildSystemPrompt ───────────────────────────────────────

describe('GooseAdapter.buildSystemPrompt', () => {
  const adapter = createGooseAdapter();

  it('contains workspace path', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('/workspace');
  });

  it('contains MCP tool guidance', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('IronCurtain MCP');
  });

  it('does NOT mention execute_code', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    // The Docker environment section should not reference execute_code
    // (Code Mode prompt may contain it, but the Docker section should not)
    const dockerSection = prompt.split('## Docker Environment')[1] ?? '';
    expect(dockerSection).not.toContain('execute_code');
  });

  it('contains policy enforcement explanation', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('Policy Enforcement');
    expect(prompt).toContain('Denied');
    expect(prompt).toContain('Escalated');
  });

  it('contains NO direct internet access warning', () => {
    const prompt = adapter.buildSystemPrompt(sampleContext);
    expect(prompt).toContain('NO direct internet access');
  });
});

// ─── getProviders ────────────────────────────────────────────

describe('GooseAdapter.getProviders', () => {
  it('returns anthropicProvider when gooseProvider is anthropic', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'anthropic' }));
    const providers = adapter.getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].host).toBe('api.anthropic.com');
  });

  it('returns openaiProvider when gooseProvider is openai', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));
    const providers = adapter.getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].host).toBe('api.openai.com');
  });

  it('returns googleProvider when gooseProvider is google', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'google' }));
    const providers = adapter.getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].host).toBe('generativelanguage.googleapis.com');
  });

  it('returns exactly one provider', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: provider }));
      const providers = adapter.getProviders();
      expect(providers).toHaveLength(1);
    }
  });

  it('ignores authKind parameter', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));
    const providersApiKey = adapter.getProviders('apikey');
    const providersOAuth = adapter.getProviders('oauth');
    expect(providersApiKey).toEqual(providersOAuth);
  });
});

// ─── buildEnv ────────────────────────────────────────────────

describe('GooseAdapter.buildEnv', () => {
  const config = { userConfig: { anthropicApiKey: 'sk-test' } } as IronCurtainConfig;

  it('sets GOOSE_PROVIDER matching config', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));
    const fakeKeys = new Map([['api.openai.com', 'sk-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.GOOSE_PROVIDER).toBe('openai');
  });

  it('sets GOOSE_MODEL matching config', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseModel: 'gpt-4o' }));
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.GOOSE_MODEL).toBe('gpt-4o');
  });

  it('sets GOOSE_MODE=auto', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.GOOSE_MODE).toBe('auto');
  });

  it('sets GOOSE_MAX_TURNS', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.GOOSE_MAX_TURNS).toBe('200');
  });

  it('sets SSL_CERT_FILE and SSL_CERT_DIR', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(env.SSL_CERT_DIR).toBe('/etc/ssl/certs');
  });

  it('does NOT set NODE_EXTRA_CA_CERTS', () => {
    const adapter = createGooseAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
  });

  it('sets ANTHROPIC_API_KEY for anthropic provider', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'anthropic' }));
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-ironcurtain-FAKE');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('GOOGLE_API_KEY');
  });

  it('sets OPENAI_API_KEY for openai provider', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));
    const fakeKeys = new Map([['api.openai.com', 'sk-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.OPENAI_API_KEY).toBe('sk-ironcurtain-FAKE');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('sets GOOGLE_API_KEY for google provider', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'google' }));
    const fakeKeys = new Map([['generativelanguage.googleapis.com', 'AIzaSy-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(config, fakeKeys);
    expect(env.GOOGLE_API_KEY).toBe('AIzaSy-ironcurtain-FAKE');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('throws when fake key is missing for the provider', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));
    const fakeKeys = new Map([['api.anthropic.com', 'wrong-host-key']]);
    expect(() => adapter.buildEnv(config, fakeKeys)).toThrow('No fake key generated for api.openai.com');
  });
});

// ─── detectCredential ────────────────────────────────────────

describe('GooseAdapter.detectCredential', () => {
  it('returns apikey when anthropicApiKey is present for anthropic provider', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'anthropic' }));
    const config = { userConfig: makeUserConfig({ anthropicApiKey: 'sk-test' }) } as unknown as IronCurtainConfig;
    const result = adapter.detectCredential!(config);
    expect(result.kind).toBe('apikey');
  });

  it('returns none when anthropicApiKey is absent for anthropic provider', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'anthropic' }));
    const config = { userConfig: makeUserConfig({ anthropicApiKey: '' }) } as unknown as IronCurtainConfig;
    const result = adapter.detectCredential!(config);
    expect(result.kind).toBe('none');
  });

  it('checks openaiApiKey when gooseProvider is openai', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));

    const configWithKey = { userConfig: makeUserConfig({ openaiApiKey: 'sk-test' }) } as unknown as IronCurtainConfig;
    expect(adapter.detectCredential!(configWithKey).kind).toBe('apikey');

    const configWithout = { userConfig: makeUserConfig({ openaiApiKey: '' }) } as unknown as IronCurtainConfig;
    expect(adapter.detectCredential!(configWithout).kind).toBe('none');
  });

  it('checks googleApiKey when gooseProvider is google', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'google' }));

    const configWithKey = {
      userConfig: makeUserConfig({ googleApiKey: 'AIzaSy-test' }),
    } as unknown as IronCurtainConfig;
    expect(adapter.detectCredential!(configWithKey).kind).toBe('apikey');

    const configWithout = { userConfig: makeUserConfig({ googleApiKey: '' }) } as unknown as IronCurtainConfig;
    expect(adapter.detectCredential!(configWithout).kind).toBe('none');
  });
});

// ─── extractResponse ─────────────────────────────────────────

describe('GooseAdapter.extractResponse', () => {
  const adapter = createGooseAdapter();

  it('returns error message with output on non-zero exit code', () => {
    const response = adapter.extractResponse(1, 'error output');
    expect(response.text).toContain('Goose exited with code 1');
    expect(response.text).toContain('error output');
    expect(response.costUsd).toBeUndefined();
  });

  it('returns clean text for simple output', () => {
    const response = adapter.extractResponse(0, 'The answer is 4.\n');
    expect(response.text).toBe('The answer is 4.');
  });

  it('strips ANSI codes', () => {
    const response = adapter.extractResponse(0, '\x1b[32mGreen text\x1b[0m\n');
    expect(response.text).toBe('Green text');
    expect(response.text).not.toContain('\x1b');
  });

  it('returns empty string for empty stdout', () => {
    const response = adapter.extractResponse(0, '');
    expect(response.text).toBe('');
  });

  it('costUsd is always undefined (Goose does not report cost)', () => {
    const response = adapter.extractResponse(0, 'output');
    expect(response.costUsd).toBeUndefined();
  });
});

// ─── buildPtyCommand ─────────────────────────────────────────

describe('GooseAdapter.buildPtyCommand', () => {
  const adapter = createGooseAdapter();

  it('builds UDS PTY command', () => {
    const cmd = adapter.buildPtyCommand!('system prompt', '/tmp/pty.sock', undefined);
    expect(cmd).toContain('socat');
    expect(cmd.join(' ')).toContain('UNIX-LISTEN:/tmp/pty.sock,fork');
    expect(cmd.join(' ')).toContain('start-goose.sh');
  });

  it('builds TCP PTY command', () => {
    const cmd = adapter.buildPtyCommand!('system prompt', undefined, 54321);
    expect(cmd.join(' ')).toContain('TCP-LISTEN:54321,reuseaddr');
    expect(cmd.join(' ')).toContain('start-goose.sh');
  });

  it('does NOT reference start-claude.sh', () => {
    const cmd = adapter.buildPtyCommand!('prompt', '/tmp/pty.sock', undefined);
    expect(cmd.join(' ')).not.toContain('start-claude.sh');
  });
});

// ─── credentialHelpText ──────────────────────────────────────

describe('GooseAdapter.credentialHelpText', () => {
  it('mentions the configured provider', () => {
    const adapter = createGooseAdapter(makeUserConfig({ gooseProvider: 'openai' }));
    expect(adapter.credentialHelpText).toContain('openai');
  });

  it('mentions all three API key env vars', () => {
    const adapter = createGooseAdapter();
    const text = adapter.credentialHelpText!;
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('GOOGLE_API_KEY');
  });
});

// ─── Helper: getProviderConfig ───────────────────────────────

describe('getProviderConfig', () => {
  it('maps anthropic to api.anthropic.com', () => {
    expect(getProviderConfig('anthropic').host).toBe('api.anthropic.com');
  });

  it('maps openai to api.openai.com', () => {
    expect(getProviderConfig('openai').host).toBe('api.openai.com');
  });

  it('maps google to generativelanguage.googleapis.com', () => {
    expect(getProviderConfig('google').host).toBe('generativelanguage.googleapis.com');
  });
});

// ─── Helper: stripAnsi ──────────────────────────────────────

describe('stripAnsi', () => {
  it('strips CSI escape sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });

  it('handles text without ANSI codes', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips multiple escape sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[32mbold green\x1b[0m normal')).toBe('bold green normal');
  });
});

// ─── Helper: extractFinalResponse ───────────────────────────

describe('extractFinalResponse', () => {
  it('extracts last block of text', () => {
    const output = ['Tool: read_file', 'Result: file contents', '', 'The file contains 42 lines.'].join('\n');

    expect(extractFinalResponse(output)).toBe('The file contains 42 lines.');
  });

  it('handles multi-line final block', () => {
    const output = ['Tool output here', '', 'First line of response.', 'Second line of response.'].join('\n');

    expect(extractFinalResponse(output)).toBe('First line of response.\nSecond line of response.');
  });

  it('returns full output when no blank line separator', () => {
    const output = 'Single line output';
    expect(extractFinalResponse(output)).toBe('Single line output');
  });

  it('returns empty string for empty input', () => {
    expect(extractFinalResponse('')).toBe('');
  });

  it('returns full output when only whitespace lines exist', () => {
    const output = '  \n  \nSome text\n  ';
    expect(extractFinalResponse(output)).toBe('Some text');
  });

  it('works on pre-stripped input (caller is responsible for ANSI stripping)', () => {
    const output = stripAnsi('\x1b[32mTool output\x1b[0m\n\nFinal answer');
    expect(extractFinalResponse(output)).toBe('Final answer');
  });

  it('handles trailing blank lines', () => {
    const output = 'Tool trace\n\nThe result is 7.\n\n\n';
    expect(extractFinalResponse(output)).toBe('The result is 7.');
  });
});

// ─── Helper: escapeHeredoc ──────────────────────────────────

describe('escapeHeredoc', () => {
  it('returns default delimiter when no collision', () => {
    const { delimiter } = escapeHeredoc('hello world');
    expect(delimiter).toBe('IRONCURTAIN_EOF');
  });

  it('returns unique delimiter when input contains IRONCURTAIN_EOF', () => {
    const { delimiter } = escapeHeredoc('some text IRONCURTAIN_EOF more text');
    expect(delimiter).not.toBe('IRONCURTAIN_EOF');
    expect(delimiter).toMatch(/^IRONCURTAIN_EOF_[a-f0-9]{8}$/);
  });

  it('returns delimiter not found in input', () => {
    const input = 'IRONCURTAIN_EOF is in here';
    const { delimiter } = escapeHeredoc(input);
    expect(input).not.toContain(delimiter);
  });

  it('handles input that is exactly the delimiter', () => {
    const { delimiter } = escapeHeredoc('IRONCURTAIN_EOF');
    expect(delimiter).not.toBe('IRONCURTAIN_EOF');
  });

  it('handles empty input', () => {
    const { delimiter } = escapeHeredoc('');
    expect(delimiter).toBe('IRONCURTAIN_EOF');
  });
});
