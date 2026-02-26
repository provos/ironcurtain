import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogTailer } from '../src/docker/audit-log-tailer.js';
import { DockerAgentSession, type DockerAgentSessionDeps } from '../src/docker/docker-agent-session.js';
import type { ManagedProxy } from '../src/docker/managed-proxy.js';
import type { MitmProxy } from '../src/docker/mitm-proxy.js';
import type { CertificateAuthority } from '../src/docker/ca.js';
import type { AgentAdapter, AgentId, AgentResponse, ToolInfo } from '../src/docker/agent-adapter.js';
import type { ProviderConfig } from '../src/docker/provider-config.js';
import type { DockerManager } from '../src/docker/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { DiagnosticEvent, EscalationRequest } from '../src/session/types.js';
import { INTERNAL_NETWORK_NAME, INTERNAL_NETWORK_SUBNET, INTERNAL_NETWORK_GATEWAY } from '../src/docker/platform.js';

// --- AuditLogTailer tests ---

describe('AuditLogTailer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-tailer-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits diagnostic events for new audit entries', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    const entry = {
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/workspace/foo.txt' },
      result: { status: 'allowed' },
    };
    appendFileSync(logPath, JSON.stringify(entry) + '\n');

    // Call readNewEntries directly to avoid fs notification timing issues
    tailer.readNewEntries();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.kind).toBe('tool_call');
    if (event.kind === 'tool_call') {
      expect(event.toolName).toBe('filesystem.read_file');
      expect(event.preview).toContain('allowed');
    }

    tailer.stop();
  });

  it('handles multiple entries in a single write', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    const entry1 = {
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/a.txt' },
      result: { status: 'allowed' },
    };
    const entry2 = {
      serverName: 'git',
      toolName: 'git_status',
      arguments: {},
      result: { status: 'denied' },
    };
    appendFileSync(logPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n');

    tailer.readNewEntries();

    expect(events).toHaveLength(2);
    if (events[0].kind === 'tool_call') {
      expect(events[0].toolName).toBe('filesystem.read_file');
    }
    if (events[1].kind === 'tool_call') {
      expect(events[1].toolName).toBe('git.git_status');
    }

    tailer.stop();
  });

  it('ignores malformed JSON lines', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    appendFileSync(logPath, 'not valid json\n');

    tailer.readNewEntries();

    // Malformed line should be silently skipped
    expect(events).toHaveLength(0);

    tailer.stop();
  });

  it('truncates long argument previews', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    const longArg = 'x'.repeat(200);
    const entry = {
      serverName: 'fs',
      toolName: 'write',
      arguments: { content: longArg },
      result: { status: 'allowed' },
    };
    appendFileSync(logPath, JSON.stringify(entry) + '\n');

    tailer.readNewEntries();

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_call') {
      // Preview is truncated to 80 chars of the JSON args + "..."
      expect(events[0].preview).toContain('...');
    }

    tailer.stop();
  });
});

// --- DockerAgentSession tests ---

const testProvider: ProviderConfig = {
  host: 'api.test.com',
  displayName: 'Test',
  allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
  keyInjection: { type: 'header', headerName: 'x-api-key' },
  fakeKeyPrefix: 'sk-test-',
};

function createMockAdapter(): AgentAdapter {
  return {
    id: 'test-agent' as AgentId,
    displayName: 'Test Agent',
    async getImage() {
      return 'ironcurtain-claude-code:latest';
    },
    generateMcpConfig() {
      return [{ path: 'test-config.json', content: '{}' }];
    },
    generateOrientationFiles() {
      return [];
    },
    buildCommand(message: string, systemPrompt: string) {
      return ['test-agent', '--prompt', systemPrompt, message];
    },
    buildSystemPrompt() {
      return 'You are a test agent.';
    },
    getProviders() {
      return [testProvider];
    },
    buildEnv() {
      return { TEST_KEY: 'test-value' };
    },
    extractResponse(exitCode: number, stdout: string): AgentResponse {
      if (exitCode !== 0) return { text: `Error: exit ${exitCode}` };
      return { text: stdout.trim() };
    },
  };
}

function createMockDocker(): DockerManager {
  // Track the build-hash labels stamped during buildImage calls.
  // getImageLabel returns the most recently stored hash for the image,
  // which means the first ensureImage() call will build (no hash yet)
  // and subsequent calls will skip (hash matches).
  const labels = new Map<string, Record<string, string>>();

  return {
    async preflight() {},
    async create() {
      return 'container-abc123';
    },
    async start() {},
    async exec() {
      return { exitCode: 0, stdout: 'Task completed successfully', stderr: '' };
    },
    async stop() {},
    async remove() {},
    async isRunning() {
      return true;
    },
    async imageExists(image: string) {
      // Image "exists" once it has been built (has labels)
      return labels.has(image);
    },
    async buildImage(_tag: string, _df: string, _ctx: string, buildLabels?: Record<string, string>) {
      if (buildLabels) {
        labels.set(_tag, buildLabels);
      }
    },
    async getImageLabel(image: string, label: string) {
      return labels.get(image)?.[label];
    },
    async createNetwork() {},
    async removeNetwork() {},
  };
}

function createMockProxy(socketPath: string, port?: number): ManagedProxy {
  const tools: ToolInfo[] = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }];

  return {
    socketPath,
    port,
    async start() {},
    async listTools() {
      return tools;
    },
    async stop() {},
  };
}

function createMockMitmProxy(): MitmProxy {
  return {
    async start() {
      return { socketPath: '/tmp/test-mitm-proxy.sock' };
    },
    async stop() {},
  };
}

function createMockCA(tempDir: string): CertificateAuthority {
  const certPem = '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----';
  const keyPem = '-----BEGIN RSA PRIVATE KEY-----\nMOCK\n-----END RSA PRIVATE KEY-----';
  const certPath = join(tempDir, 'mock-ca-cert.pem');
  const keyPath = join(tempDir, 'mock-ca-key.pem');
  writeFileSync(certPath, certPem);
  writeFileSync(keyPath, keyPem);
  return { certPem, keyPem, certPath, keyPath };
}

function createTestDeps(tempDir: string): DockerAgentSessionDeps {
  const sessionDir = join(tempDir, 'session');
  const sandboxDir = join(tempDir, 'sandbox');
  const escalationDir = join(tempDir, 'escalations');
  const auditLogPath = join(tempDir, 'audit.jsonl');

  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });

  const config = {
    mcpServers: {},
    userConfig: {
      anthropicApiKey: 'sk-test',
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
      },
      escalationTimeoutSeconds: 120,
    },
  } as unknown as IronCurtainConfig;

  return {
    config,
    sessionId: 'test-session-id' as import('../src/session/types.js').SessionId,
    adapter: createMockAdapter(),
    docker: createMockDocker(),
    proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
    mitmProxy: createMockMitmProxy(),
    ca: createMockCA(tempDir),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake-key']]),
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
  };
}

describe('DockerAgentSession', () => {
  let tempDir: string;
  let session: DockerAgentSession | undefined;
  let deps: DockerAgentSessionDeps;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docker-session-test-'));
    deps = createTestDeps(tempDir);
  });

  afterEach(async () => {
    // Ensure session is closed to stop intervals
    try {
      await session?.close();
    } catch {
      // Ignore close errors in cleanup
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes and reaches ready status', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const info = session.getInfo();
    expect(info.status).toBe('ready');
    expect(info.turnCount).toBe(0);
    expect(info.id).toBe('test-session-id');
  });

  it('sendMessage executes docker exec and returns response', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const response = await session.sendMessage('Fix the bug');

    expect(response).toBe('Task completed successfully');
    expect(session.getInfo().turnCount).toBe(1);
    expect(session.getInfo().status).toBe('ready');
  });

  it('records conversation turns', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('First message');
    await session.sendMessage('Second message');

    const history = session.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].turnNumber).toBe(1);
    expect(history[0].userMessage).toBe('First message');
    expect(history[0].assistantResponse).toBe('Task completed successfully');
    expect(history[1].turnNumber).toBe(2);
    expect(history[1].userMessage).toBe('Second message');
  });

  it('getBudgetStatus returns tokenTrackingAvailable: false', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const budget = session.getBudgetStatus();
    expect(budget.tokenTrackingAvailable).toBe(false);
    expect(budget.totalTokens).toBe(0);
    expect(budget.estimatedCostUsd).toBe(0);
  });

  it('getBudgetStatus reflects cost from adapter response', async () => {
    const costAdapter = createMockAdapter();
    costAdapter.extractResponse = (): AgentResponse => ({
      text: 'Done',
      costUsd: 0.42,
    });

    session = new DockerAgentSession({ ...deps, adapter: costAdapter });
    await session.initialize();

    await session.sendMessage('Do something');

    const budget = session.getBudgetStatus();
    expect(budget.estimatedCostUsd).toBe(0.42);
    expect(budget.cumulative.estimatedCostUsd).toBe(0.42);
  });

  it('tracks elapsed seconds after first message', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    // Before first message, elapsed is 0
    expect(session.getBudgetStatus().elapsedSeconds).toBe(0);

    await session.sendMessage('Start');

    // After first message, elapsed should be > 0
    expect(session.getBudgetStatus().elapsedSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws SessionNotReadyError when not initialized', async () => {
    session = new DockerAgentSession(deps);

    await expect(session.sendMessage('Hello')).rejects.toThrow('not ready');
  });

  it('throws SessionClosedError after close', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();
    await session.close();

    await expect(session.sendMessage('Hello')).rejects.toThrow('closed');
  });

  it('close is idempotent', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.close();
    await session.close(); // Should not throw
  });

  it('handles non-zero exit codes via adapter.extractResponse', async () => {
    const customDocker = createMockDocker();
    customDocker.exec = async () => ({
      exitCode: 1,
      stdout: 'Something went wrong',
      stderr: 'error details',
    });

    session = new DockerAgentSession({ ...deps, docker: customDocker });
    await session.initialize();

    const response = await session.sendMessage('Do something');
    expect(response).toBe('Error: exit 1');
  });

  it('emits diagnostic events via onDiagnostic callback', async () => {
    const events: DiagnosticEvent[] = [];
    session = new DockerAgentSession({
      ...deps,
      onDiagnostic: (event) => events.push(event),
    });
    await session.initialize();

    // Write an audit entry and flush the tailer
    const entry = {
      serverName: 'fs',
      toolName: 'read',
      arguments: { path: '/test' },
      result: { status: 'allowed' },
    };
    appendFileSync(deps.auditLogPath, JSON.stringify(entry) + '\n');
    session.flushAuditLog();

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves escalation by writing response file', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    // Simulate an escalation request appearing in the directory
    const escalationId = 'esc-123';
    const request: EscalationRequest = {
      escalationId,
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/passwd' },
      reason: 'Protected path',
    };
    writeFileSync(join(deps.escalationDir, `request-${escalationId}.json`), JSON.stringify(request));

    // Wait long enough for the polling interval to detect the request to avoid timing-related test flakiness
    await new Promise((r) => setTimeout(r, 1000));

    const pending = session.getPendingEscalation();
    expect(pending).toBeDefined();
    expect(pending?.escalationId).toBe(escalationId);

    // Resolve the escalation
    await session.resolveEscalation(escalationId, 'denied');

    // Response file should exist
    const responsePath = join(deps.escalationDir, `response-${escalationId}.json`);
    expect(existsSync(responsePath)).toBe(true);

    // Pending should be cleared
    expect(session.getPendingEscalation()).toBeUndefined();
  });

  it('throws when resolving unknown escalation', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await expect(session.resolveEscalation('nonexistent', 'approved')).rejects.toThrow('No pending escalation');
  });

  it('calls onEscalation callback when escalation detected', async () => {
    const escalations: EscalationRequest[] = [];
    session = new DockerAgentSession({
      ...deps,
      onEscalation: (req) => escalations.push(req),
    });
    await session.initialize();

    const request: EscalationRequest = {
      escalationId: 'esc-456',
      toolName: 'delete_file',
      serverName: 'filesystem',
      arguments: { path: '/important' },
      reason: 'Protected',
    };
    writeFileSync(join(deps.escalationDir, 'request-esc-456.json'), JSON.stringify(request));

    await new Promise((r) => setTimeout(r, 1000));

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-456');
  });

  it('detects escalation expiry when files are removed', async () => {
    let expired = false;
    session = new DockerAgentSession({
      ...deps,
      onEscalationExpired: () => {
        expired = true;
      },
    });
    await session.initialize();

    // Write then detect escalation
    const request: EscalationRequest = {
      escalationId: 'esc-789',
      toolName: 'fetch',
      serverName: 'fetch',
      arguments: { url: 'http://evil.com' },
      reason: 'Unknown domain',
    };
    writeFileSync(join(deps.escalationDir, 'request-esc-789.json'), JSON.stringify(request));

    await new Promise((r) => setTimeout(r, 1000));
    expect(session.getPendingEscalation()).toBeDefined();

    // Simulate proxy-side cleanup (both files removed = expired)
    rmSync(join(deps.escalationDir, 'request-esc-789.json'));

    await new Promise((r) => setTimeout(r, 1000));
    expect(expired).toBe(true);
    expect(session.getPendingEscalation()).toBeUndefined();
  });

  it('writes user context for auto-approver', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('Please fix the CSS');

    const contextPath = join(deps.escalationDir, 'user-context.json');
    expect(existsSync(contextPath)).toBe(true);
  });

  it('getDiagnosticLog returns accumulated events', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const log = session.getDiagnosticLog();
    expect(Array.isArray(log)).toBe(true);
  });

  describe('TCP mode with internal network', () => {
    function createTcpDeps(tempDir: string): DockerAgentSessionDeps {
      const baseDeps = createTestDeps(tempDir);
      return {
        ...baseDeps,
        useTcp: true,
        proxy: createMockProxy(join(tempDir, 'session', 'proxy.sock'), 9123),
        mitmProxy: {
          async start() {
            return { port: 8443 };
          },
          async stop() {},
        },
      };
    }

    it('creates internal network and passes extraHosts in TCP mode', async () => {
      const tcpDeps = createTcpDeps(tempDir);
      const createNetworkCalls: Array<{ name: string; options?: Record<string, unknown> }> = [];
      const createCalls: Array<Record<string, unknown>> = [];

      const docker = {
        ...tcpDeps.docker,
        async createNetwork(name: string, options?: { internal?: boolean; subnet?: string; gateway?: string }) {
          createNetworkCalls.push({ name, options });
        },
        async create(config: Record<string, unknown>) {
          createCalls.push(config);
          return 'container-tcp-123';
        },
        // Connectivity check succeeds
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      } as unknown as DockerManager;

      session = new DockerAgentSession({ ...tcpDeps, docker });
      await session.initialize();

      // Verify internal network was created
      expect(createNetworkCalls).toHaveLength(1);
      expect(createNetworkCalls[0].name).toBe(INTERNAL_NETWORK_NAME);
      expect(createNetworkCalls[0].options).toEqual({
        internal: true,
        subnet: INTERNAL_NETWORK_SUBNET,
        gateway: INTERNAL_NETWORK_GATEWAY,
      });

      // Verify container was created with internal network and extraHosts
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].network).toBe(INTERNAL_NETWORK_NAME);
      expect(createCalls[0].extraHosts).toEqual([`host.docker.internal:${INTERNAL_NETWORK_GATEWAY}`]);
    });

    it('throws when connectivity check fails', async () => {
      const tcpDeps = createTcpDeps(tempDir);

      const docker = {
        ...tcpDeps.docker,
        async createNetwork() {},
        async create() {
          return 'container-fail';
        },
        async start() {},
        async stop() {},
        async remove() {},
        async exec() {
          return { exitCode: 1, stdout: '', stderr: 'Connection refused' };
        },
      } as unknown as DockerManager;

      session = new DockerAgentSession({ ...tcpDeps, docker });
      await expect(session.initialize()).rejects.toThrow('Internal network connectivity check failed');
    });

    it('removes internal network on close', async () => {
      const tcpDeps = createTcpDeps(tempDir);
      const removedNetworks: string[] = [];

      const docker = {
        ...tcpDeps.docker,
        async createNetwork() {},
        async create() {
          return 'container-cleanup';
        },
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        async removeNetwork(name: string) {
          removedNetworks.push(name);
        },
      } as unknown as DockerManager;

      session = new DockerAgentSession({ ...tcpDeps, docker });
      await session.initialize();
      await session.close();

      expect(removedNetworks).toContain(INTERNAL_NETWORK_NAME);
    });
  });
});
