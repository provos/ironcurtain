import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ROOTS_REFRESH_TIMEOUT_MS } from '../src/trusted-process/mcp-client-manager.js';
import {
  parseProxyEnvConfig,
  validateSandboxAvailability,
  buildToolMap,
  buildAuditEntry,
  handleCallTool,
  selectTransportConfig,
  type ProxiedTool,
  type CallToolDeps,
  type ClientState,
} from '../src/trusted-process/mcp-proxy-server.js';
import { checkSandboxAvailability, type ResolvedSandboxConfig } from '../src/trusted-process/sandbox-integration.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ── Mock modules ───────────────────────────────────────────────────────

vi.mock('../src/trusted-process/sandbox-integration.js', () => ({
  checkSandboxAvailability: vi.fn(() => ({
    platformSupported: true,
    errors: [],
    warnings: [],
  })),
  resolveSandboxConfig: vi.fn(),
  writeServerSettings: vi.fn(),
  wrapServerCommand: vi.fn(),
  cleanupSettingsFiles: vi.fn(),
  annotateSandboxViolation: vi.fn((text: string) => text),
}));

vi.mock('../src/trusted-process/auto-approver.js', () => ({
  autoApprove: vi.fn(),
  extractArgsForAutoApprove: vi.fn(() => ({})),
  readUserContext: vi.fn(),
}));

vi.mock('../src/trusted-process/path-utils.js', () => ({
  prepareToolArgs: vi.fn((args: Record<string, unknown>) => ({
    argsForTransport: { ...args },
    argsForPolicy: { ...args },
  })),
  rewriteResultContent: vi.fn((content: unknown) => content),
}));

vi.mock('../src/trusted-process/policy-engine.js', () => ({
  PolicyEngine: vi.fn(),
  extractAnnotatedPaths: vi.fn(() => []),
}));

// ── Existing addRootToClient tests ─────────────────────────────────────

/**
 * Tests for the addRootToClient timeout safety net used by both
 * mcp-proxy-server.ts and mcp-client-manager.ts.
 *
 * addRootToClient is module-private, so we replicate its core logic
 * here to verify the Promise.race timeout works correctly.
 */

interface MockClientState {
  roots: { uri: string; name: string }[];
  rootsRefreshed?: () => void;
  sendRootsListChangedCalled: boolean;
}

/** Replicates addRootToClient logic from mcp-proxy-server.ts */
async function addRootToClient(state: MockClientState, root: { uri: string; name: string }): Promise<void> {
  if (state.roots.some((r) => r.uri === root.uri)) return;
  state.roots.push(root);

  let timer: ReturnType<typeof setTimeout>;
  const refreshed = new Promise<void>((resolve) => {
    state.rootsRefreshed = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      state.rootsRefreshed = undefined;
      resolve();
    }, ROOTS_REFRESH_TIMEOUT_MS);
  });
  state.sendRootsListChangedCalled = true;
  await Promise.race([refreshed, timeout]);
}

describe('addRootToClient timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when server acknowledges roots/list', async () => {
    const state: MockClientState = { roots: [], sendRootsListChangedCalled: false };
    const root = { uri: 'file:///tmp/test', name: 'escalation-approved' };

    const promise = addRootToClient(state, root);

    // Simulate server calling back immediately
    state.rootsRefreshed!();

    await promise;
    expect(state.roots).toContainEqual(root);
    expect(state.sendRootsListChangedCalled).toBe(true);
  });

  it('resolves after timeout when server never acknowledges roots/list', async () => {
    const state: MockClientState = { roots: [], sendRootsListChangedCalled: false };
    const root = { uri: 'file:///tmp/test', name: 'escalation-approved' };

    const promise = addRootToClient(state, root);

    // Server never calls back — advance past the timeout
    vi.advanceTimersByTime(ROOTS_REFRESH_TIMEOUT_MS);

    await promise;
    expect(state.roots).toContainEqual(root);
    expect(state.sendRootsListChangedCalled).toBe(true);
    // Stale callback is cleared on timeout
    expect(state.rootsRefreshed).toBeUndefined();
  });

  it('clears the timeout timer when server responds quickly', async () => {
    const state: MockClientState = { roots: [], sendRootsListChangedCalled: false };
    const root = { uri: 'file:///tmp/test', name: 'escalation-approved' };

    const promise = addRootToClient(state, root);
    state.rootsRefreshed!();
    await promise;

    // No pending timers should remain
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays pending until exactly the timeout elapses', async () => {
    const state: MockClientState = { roots: [], sendRootsListChangedCalled: false };
    const root = { uri: 'file:///tmp/test', name: 'escalation-approved' };

    let resolved = false;
    const promise = addRootToClient(state, root).then(() => {
      resolved = true;
    });

    // Before timeout: still pending
    vi.advanceTimersByTime(ROOTS_REFRESH_TIMEOUT_MS - 1);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    // At timeout: resolves
    vi.advanceTimersByTime(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('is a no-op when root URI already exists', async () => {
    const existingRoot = { uri: 'file:///tmp/test', name: 'existing' };
    const state: MockClientState = {
      roots: [existingRoot],
      sendRootsListChangedCalled: false,
    };

    await addRootToClient(state, { uri: 'file:///tmp/test', name: 'escalation-approved' });

    // Should not have sent notification or added duplicate
    expect(state.roots).toHaveLength(1);
    expect(state.sendRootsListChangedCalled).toBe(false);
  });
});

// ── parseProxyEnvConfig tests ──────────────────────────────────────────

describe('parseProxyEnvConfig', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to a clean state before each test
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('MCP_') ||
        key.startsWith('GENERATED_') ||
        key.startsWith('AUDIT_') ||
        key.startsWith('PROTECTED_') ||
        key.startsWith('SESSION_LOG') ||
        key.startsWith('ALLOWED_') ||
        key.startsWith('CONTAINER_') ||
        key.startsWith('ESCALATION_') ||
        key.startsWith('SERVER_') ||
        key.startsWith('SANDBOX_')
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('parses all environment variables into a typed config object', () => {
    const servers = { filesystem: { command: 'node', args: ['server.js'] } };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/generated';
    process.env.AUDIT_LOG_PATH = '/tmp/audit.jsonl';
    process.env.PROTECTED_PATHS = JSON.stringify(['/etc/passwd']);
    process.env.SESSION_LOG_PATH = '/tmp/session.log';
    process.env.ALLOWED_DIRECTORY = '/tmp/sandbox';
    process.env.ESCALATION_DIR = '/tmp/escalation';
    process.env.SANDBOX_POLICY = 'enforce';

    const config = parseProxyEnvConfig();

    expect(config.auditLogPath).toBe('/tmp/audit.jsonl');
    expect(config.generatedDir).toBe('/tmp/generated');
    expect(config.protectedPaths).toEqual(['/etc/passwd']);
    expect(config.sessionLogPath).toBe('/tmp/session.log');
    expect(config.allowedDirectory).toBe('/tmp/sandbox');
    expect(config.escalationDir).toBe('/tmp/escalation');
    expect(config.sandboxPolicy).toBe('enforce');
    expect(config.serversConfig).toEqual(servers);
  });

  it('uses default values when optional env vars are not set', () => {
    const servers = { fs: { command: 'node', args: [] } };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/gen';

    const config = parseProxyEnvConfig();

    expect(config.auditLogPath).toBe('./audit.jsonl');
    expect(config.protectedPaths).toEqual([]);
    expect(config.sessionLogPath).toBeUndefined();
    expect(config.allowedDirectory).toBeUndefined();
    expect(config.escalationDir).toBeUndefined();
    expect(config.sandboxPolicy).toBe('warn');
    expect(config.serverCredentials).toEqual({});
  });

  it('parses SERVER_CREDENTIALS and scrubs from process.env', () => {
    const servers = { fs: { command: 'node', args: [] } };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SERVER_CREDENTIALS = JSON.stringify({ GITHUB_TOKEN: 'secret123' });

    const config = parseProxyEnvConfig();

    expect(config.serverCredentials).toEqual({ GITHUB_TOKEN: 'secret123' });
    expect(process.env.SERVER_CREDENTIALS).toBeUndefined();
  });

  it('filters servers when SERVER_FILTER is set', () => {
    const servers = {
      fs: { command: 'node', args: ['fs.js'] },
      git: { command: 'node', args: ['git.js'] },
    };
    process.env.MCP_SERVERS_CONFIG = JSON.stringify(servers);
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SERVER_FILTER = 'git';

    const config = parseProxyEnvConfig();

    expect(Object.keys(config.serversConfig)).toEqual(['git']);
    expect(config.serversConfig.git).toEqual(servers.git);
  });

  it('calls process.exit(1) when MCP_SERVERS_CONFIG is missing', () => {
    process.env.GENERATED_DIR = '/tmp/gen';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(() => parseProxyEnvConfig()).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith('MCP_SERVERS_CONFIG environment variable is required\n');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('calls process.exit(1) when GENERATED_DIR is missing', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(() => parseProxyEnvConfig()).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith('GENERATED_DIR environment variable is required\n');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('calls process.exit(1) when SERVER_FILTER references unknown server', () => {
    process.env.MCP_SERVERS_CONFIG = JSON.stringify({ fs: { command: 'node', args: [] } });
    process.env.GENERATED_DIR = '/tmp/gen';
    process.env.SERVER_FILTER = 'nonexistent';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(() => parseProxyEnvConfig()).toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith('SERVER_FILTER: unknown server "nonexistent"\n');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

// ── validateSandboxAvailability tests ──────────────────────────────────

describe('validateSandboxAvailability', () => {
  it('returns sandboxAvailable=true when platform is supported and no errors', () => {
    vi.mocked(checkSandboxAvailability).mockReturnValue({
      platformSupported: true,
      errors: [],
      warnings: [],
    });

    const result = validateSandboxAvailability('warn', undefined, 'linux');
    expect(result.sandboxAvailable).toBe(true);
  });

  it('returns sandboxAvailable=false when platform is not supported in warn mode', () => {
    vi.mocked(checkSandboxAvailability).mockReturnValue({
      platformSupported: false,
      errors: [],
      warnings: [],
    });

    const result = validateSandboxAvailability('warn', undefined, 'win32');
    expect(result.sandboxAvailable).toBe(false);
  });

  it('returns sandboxAvailable=false when dependency errors exist in warn mode', () => {
    vi.mocked(checkSandboxAvailability).mockReturnValue({
      platformSupported: true,
      errors: ['bubblewrap not found'],
      warnings: [],
    });

    const result = validateSandboxAvailability('warn', undefined, 'linux');
    expect(result.sandboxAvailable).toBe(false);
  });

  it('throws when enforce mode is active and platform is not supported', () => {
    vi.mocked(checkSandboxAvailability).mockReturnValue({
      platformSupported: false,
      errors: [],
      warnings: [],
    });

    expect(() => validateSandboxAvailability('enforce', undefined, 'darwin')).toThrow(
      /sandboxPolicy is "enforce" but sandboxing is unavailable/,
    );
  });

  it('throws when enforce mode is active and dependency errors exist', () => {
    vi.mocked(checkSandboxAvailability).mockReturnValue({
      platformSupported: true,
      errors: ['socat not found'],
      warnings: [],
    });

    expect(() => validateSandboxAvailability('enforce', undefined, 'linux')).toThrow(
      /sandboxPolicy is "enforce" but sandboxing is unavailable/,
    );
  });
});

// ── buildToolMap tests ─────────────────────────────────────────────────

describe('buildToolMap', () => {
  it('creates a map keyed by tool name', () => {
    const tools: ProxiedTool[] = [
      { serverName: 'fs', name: 'read_file', inputSchema: { type: 'object' } },
      { serverName: 'fs', name: 'write_file', inputSchema: { type: 'object' } },
      { serverName: 'git', name: 'git_status', inputSchema: { type: 'object' } },
    ];

    const map = buildToolMap(tools);

    expect(map.size).toBe(3);
    expect(map.get('read_file')?.serverName).toBe('fs');
    expect(map.get('write_file')?.serverName).toBe('fs');
    expect(map.get('git_status')?.serverName).toBe('git');
  });

  it('returns an empty map for empty input', () => {
    const map = buildToolMap([]);
    expect(map.size).toBe(0);
  });

  it('last tool wins when names collide', () => {
    const tools: ProxiedTool[] = [
      { serverName: 'a', name: 'dup', inputSchema: {} },
      { serverName: 'b', name: 'dup', inputSchema: {} },
    ];

    const map = buildToolMap(tools);
    expect(map.size).toBe(1);
    expect(map.get('dup')?.serverName).toBe('b');
  });
});

// ── buildAuditEntry tests ──────────────────────────────────────────────

describe('buildAuditEntry', () => {
  it('creates a complete audit entry with all fields', () => {
    const request = {
      requestId: 'req-1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { path: '/tmp/foo' },
      timestamp: '2025-01-01T00:00:00.000Z',
    };
    const policyDecision = { status: 'allow' as const, rule: 'allow-reads', reason: 'allowed' };

    const entry = buildAuditEntry(request, { path: '/tmp/foo' }, policyDecision, { status: 'success' }, 42, {
      escalationResult: 'approved',
      sandboxed: true,
      autoApproved: true,
    });

    expect(entry.requestId).toBe('req-1');
    expect(entry.serverName).toBe('fs');
    expect(entry.toolName).toBe('read_file');
    expect(entry.arguments).toEqual({ path: '/tmp/foo' });
    expect(entry.policyDecision).toEqual(policyDecision);
    expect(entry.result).toEqual({ status: 'success' });
    expect(entry.durationMs).toBe(42);
    expect(entry.escalationResult).toBe('approved');
    expect(entry.sandboxed).toBe(true);
    expect(entry.autoApproved).toBe(true);
  });

  it('omits optional fields when not provided', () => {
    const request = {
      requestId: 'req-2',
      serverName: 'git',
      toolName: 'git_add',
      arguments: {},
      timestamp: '2025-01-01T00:00:00.000Z',
    };
    const policyDecision = { status: 'deny' as const, rule: 'deny-all', reason: 'denied' };

    const entry = buildAuditEntry(request, {}, policyDecision, { status: 'denied', error: 'denied' }, 0, {});

    expect(entry.escalationResult).toBeUndefined();
    expect(entry.sandboxed).toBeUndefined();
    expect(entry.autoApproved).toBeUndefined();
  });

  it('uses argsForTransport (not request.arguments) in the entry', () => {
    const request = {
      requestId: 'req-3',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { path: '/policy/resolved/path' },
      timestamp: '2025-01-01T00:00:00.000Z',
    };

    const entry = buildAuditEntry(
      request,
      { path: '/transport/original/path' },
      { status: 'allow' as const, rule: 'r', reason: 'r' },
      { status: 'success' },
      10,
      {},
    );

    expect(entry.arguments).toEqual({ path: '/transport/original/path' });
  });
});

// ── handleCallTool tests ───────────────────────────────────────────────

describe('handleCallTool', () => {
  function createMockDeps(overrides: Partial<CallToolDeps> = {}): CallToolDeps {
    const tool: ProxiedTool = {
      serverName: 'fs',
      name: 'read_file',
      inputSchema: { type: 'object' },
    };
    const toolMap = new Map<string, ProxiedTool>();
    toolMap.set('read_file', tool);

    const annotation = {
      toolName: 'read_file',
      serverName: 'fs',
      comment: 'Reads a file',
      sideEffects: false,
      args: { path: ['read-path'] },
    };

    const policyEngine = {
      getAnnotation: vi.fn().mockReturnValue(annotation),
      evaluate: vi.fn().mockReturnValue({
        decision: 'allow',
        rule: 'allow-reads',
        reason: 'allowed',
      }),
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'file content' }],
        isError: false,
      }),
    };

    const clientStates = new Map<string, ClientState>();
    clientStates.set('fs', {
      client: mockClient as unknown as ClientState['client'],
      roots: [],
    });

    const resolvedSandboxConfigs = new Map();
    resolvedSandboxConfigs.set('fs', { sandboxed: false, reason: 'opt-out' });

    return {
      toolMap,
      policyEngine: policyEngine as unknown as CallToolDeps['policyEngine'],
      auditLog: { log: vi.fn() } as unknown as CallToolDeps['auditLog'],
      circuitBreaker: {
        check: vi.fn().mockReturnValue({ allowed: true }),
      } as unknown as CallToolDeps['circuitBreaker'],
      clientStates,
      resolvedSandboxConfigs,
      allowedDirectory: '/tmp/sandbox',
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      ...overrides,
    };
  }

  it('returns error for unknown tool', async () => {
    const deps = createMockDeps();

    const result = await handleCallTool('nonexistent_tool', {}, deps);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Unknown tool: nonexistent_tool' }]);
  });

  it('returns error when annotation is missing', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.policyEngine.getAnnotation).mockReturnValue(undefined);

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Missing annotation for tool');
    expect(content[0].text).toContain("Re-run 'ironcurtain annotate-tools'");
  });

  it('forwards allowed calls to the real MCP server', async () => {
    const deps = createMockDeps();

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: 'file content' }]);
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.result.status).toBe('success');
  });

  it('denies calls when policy evaluates to deny', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.policyEngine.evaluate).mockReturnValue({
      decision: 'deny',
      rule: 'protected-path',
      reason: 'Path is protected',
    });

    const result = await handleCallTool('read_file', { path: '/etc/shadow' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('DENIED: Path is protected');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.result.status).toBe('denied');
  });

  it('auto-denies escalation when no escalation directory is configured', async () => {
    const deps = createMockDeps({ escalationDir: undefined });
    vi.mocked(deps.policyEngine.evaluate).mockReturnValue({
      decision: 'escalate',
      rule: 'escalate-writes',
      reason: 'Write requires approval',
    });

    const result = await handleCallTool('read_file', { path: '/opt/data' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('ESCALATION REQUIRED');
    expect(content[0].text).toContain('no escalation handler');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.escalationResult).toBe('denied');
  });

  it('denies calls when circuit breaker trips', async () => {
    const deps = createMockDeps();
    vi.mocked(deps.circuitBreaker.check).mockReturnValue({
      allowed: false,
      reason: 'Circuit breaker: too many identical calls',
    });

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Circuit breaker: too many identical calls');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
  });

  it('returns error when no client connection exists for the server', async () => {
    const deps = createMockDeps();
    deps.clientStates.clear();

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain('Internal error: no client connection');
  });

  it('handles MCP server returning isError=true', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockResolvedValue({
      content: [{ type: 'text', text: 'Permission denied' }],
      isError: true,
    });

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.result.status).toBe('error');
  });

  it('handles MCP server throwing an exception', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockRejectedValue(
      new Error('Connection lost'),
    );

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Error: Connection lost');
    expect(deps.auditLog.log).toHaveBeenCalledTimes(1);
    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.result.status).toBe('error');
  });

  it('handles non-Error exceptions from MCP server', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockRejectedValue(
      'string error',
    );

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Error: string error');
  });

  it('records sandboxed=true in audit when server is sandboxed', async () => {
    const deps = createMockDeps();
    deps.resolvedSandboxConfigs.set('fs', { sandboxed: true, config: {} } as unknown as ResolvedSandboxConfig);

    await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    const loggedEntry = vi.mocked(deps.auditLog.log).mock.calls[0][0];
    expect(loggedEntry.sandboxed).toBe(true);
  });

  it('extracts meaningful message from McpError with data', async () => {
    const deps = createMockDeps();
    const clientState = deps.clientStates.get('fs')!;
    vi.mocked((clientState.client as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool).mockRejectedValue(
      new McpError(ErrorCode.InvalidParams, 'Structured content does not match', 'No session working directory set'),
    );

    const result = await handleCallTool('read_file', { path: '/tmp/foo' }, deps);

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toBe('Error: No session working directory set');
  });

  it('tracks server context after successful tool call', async () => {
    const deps = createMockDeps();
    // Add git server with git_set_working_dir tool
    const gitTool: ProxiedTool = { serverName: 'git', name: 'git_set_working_dir', inputSchema: { type: 'object' } };
    deps.toolMap.set('git_set_working_dir', gitTool);
    const gitAnnotation = {
      toolName: 'git_set_working_dir',
      serverName: 'git',
      comment: 'Sets working dir',
      sideEffects: false,
      args: { path: ['none'] },
    };
    vi.mocked(deps.policyEngine.getAnnotation).mockReturnValue(gitAnnotation);

    const mockGitClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Working directory set' }],
        isError: false,
      }),
    };
    deps.clientStates.set('git', {
      client: mockGitClient as unknown as ClientState['client'],
      roots: [],
    });
    deps.resolvedSandboxConfigs.set('git', { sandboxed: false, reason: 'opt-out' });

    await handleCallTool('git_set_working_dir', { path: '/home/user/repo' }, deps);

    expect(deps.serverContextMap.get('git')?.workingDirectory).toBe('/home/user/repo');
  });
});

// ── selectTransportConfig tests ────────────────────────────────────────

describe('selectTransportConfig', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    delete process.env.PROXY_TCP_PORT;
    delete process.env.PROXY_SOCKET_PATH;
    delete process.env.PROXY_PORT_FILE;
    Object.assign(process.env, savedEnv);
  });

  it('returns stdio when no transport env vars are set', () => {
    delete process.env.PROXY_TCP_PORT;
    delete process.env.PROXY_SOCKET_PATH;

    const config = selectTransportConfig();
    expect(config.kind).toBe('stdio');
  });

  it('returns tcp with parsed port', () => {
    process.env.PROXY_TCP_PORT = '8080';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.port).toBe(8080);
    }
  });

  it('returns tcp with port 0 for ephemeral allocation', () => {
    process.env.PROXY_TCP_PORT = '0';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.port).toBe(0);
    }
  });

  it('includes portFilePath when PROXY_PORT_FILE is set', () => {
    process.env.PROXY_TCP_PORT = '8080';
    process.env.PROXY_PORT_FILE = '/tmp/port';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.portFilePath).toBe('/tmp/port');
    }
  });

  it('returns uds with socket path', () => {
    delete process.env.PROXY_TCP_PORT;
    process.env.PROXY_SOCKET_PATH = '/tmp/proxy.sock';

    const config = selectTransportConfig();
    expect(config.kind).toBe('uds');
    if (config.kind === 'uds') {
      expect(config.socketPath).toBe('/tmp/proxy.sock');
    }
  });

  it('prefers tcp over uds when both are set', () => {
    process.env.PROXY_TCP_PORT = '9090';
    process.env.PROXY_SOCKET_PATH = '/tmp/proxy.sock';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
  });

  it('throws for invalid TCP port (negative)', () => {
    process.env.PROXY_TCP_PORT = '-1';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('throws for invalid TCP port (too large)', () => {
    process.env.PROXY_TCP_PORT = '99999';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('throws for non-numeric TCP port', () => {
    process.env.PROXY_TCP_PORT = 'abc';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('throws for TCP port 65536 (just above max)', () => {
    process.env.PROXY_TCP_PORT = '65536';

    expect(() => selectTransportConfig()).toThrow(/Invalid PROXY_TCP_PORT/);
  });

  it('accepts TCP port 65535 (max valid)', () => {
    process.env.PROXY_TCP_PORT = '65535';

    const config = selectTransportConfig();
    expect(config.kind).toBe('tcp');
    if (config.kind === 'tcp') {
      expect(config.port).toBe(65535);
    }
  });
});
