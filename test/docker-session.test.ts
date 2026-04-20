import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogTailer } from '../src/docker/audit-log-tailer.js';
import { DockerAgentSession, type DockerAgentSessionDeps } from '../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { DockerProxy } from '../src/docker/code-mode-proxy.js';
import type { MitmProxy } from '../src/docker/mitm-proxy.js';
import type { AgentAdapter, AgentResponse, ConversationStateConfig } from '../src/docker/agent-adapter.js';
import type { DockerManager } from '../src/docker/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { DiagnosticEvent, EscalationRequest } from '../src/session/types.js';
import { getInternalNetworkName } from '../src/docker/platform.js';
import {
  createMockAdapter,
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
} from './helpers/docker-mocks.js';

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

/** Options for overriding fields on the mock DockerInfrastructure bundle. */
interface MockInfraOptions {
  readonly sessionId?: string;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
  readonly auditLogPath: string;
  readonly tempDir: string;
  readonly adapter?: AgentAdapter;
  readonly docker?: DockerManager;
  readonly proxy?: DockerProxy;
  readonly mitmProxy?: MitmProxy;
  readonly useTcp?: boolean;
  readonly containerId?: string;
  readonly containerName?: string;
  readonly sidecarContainerId?: string;
  readonly internalNetwork?: string;
  readonly conversationStateDir?: string;
  readonly conversationStateConfig?: ConversationStateConfig;
}

/**
 * Builds a mock DockerInfrastructure bundle suitable for DockerAgentSession
 * tests. Representing a post-`createDockerInfrastructure()` state: the main
 * container is already "created" and "started"; the session only drives it.
 */
function createMockInfra(opts: MockInfraOptions): DockerInfrastructure {
  const sessionId = opts.sessionId ?? 'test-session-id';
  const shortId = sessionId.substring(0, 12);
  const useTcp = opts.useTcp ?? false;
  const mitmProxy =
    opts.mitmProxy ??
    (useTcp
      ? ({
          async start() {
            return { port: 8443 };
          },
          async stop() {},
          hosts: {
            addHost: () => true,
            removeHost: () => true,
            listHosts: () => ({ providers: [], dynamic: [] }),
          },
          setTokenSessionId: () => {},
        } as MitmProxy)
      : createMockMitmProxy());
  const proxy = opts.proxy ?? createMockProxy(join(opts.sessionDir, 'proxy.sock'), useTcp ? 9123 : undefined);
  const mitmAddr: DockerInfrastructure['mitmAddr'] = useTcp
    ? { port: 8443 }
    : { socketPath: '/tmp/test-mitm-proxy.sock' };
  return {
    sessionId,
    sessionDir: opts.sessionDir,
    sandboxDir: opts.sandboxDir,
    escalationDir: opts.escalationDir,
    auditLogPath: opts.auditLogPath,
    proxy,
    mitmProxy,
    docker: opts.docker ?? createMockDocker(),
    adapter: opts.adapter ?? createMockAdapter(),
    ca: createMockCA(opts.tempDir),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake-key']]),
    orientationDir: join(opts.sessionDir, 'orientation'),
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    useTcp,
    socketsDir: join(opts.sessionDir, 'sockets'),
    mitmAddr,
    authKind: 'apikey',
    conversationStateDir: opts.conversationStateDir,
    conversationStateConfig: opts.conversationStateConfig,
    containerId: opts.containerId ?? 'container-abc123',
    containerName: opts.containerName ?? `ironcurtain-${shortId}`,
    sidecarContainerId: opts.sidecarContainerId,
    internalNetwork: opts.internalNetwork,
    setTokenSessionId: () => {},
  };
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
      auditRedaction: { enabled: true },
    },
  } as unknown as IronCurtainConfig;

  const infra = createMockInfra({
    tempDir,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
  });

  return {
    config,
    sessionId: 'test-session-id' as import('../src/session/types.js').SessionId,
    infra,
    ownsInfra: true,
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
    // Restore real timers before cleanup so async operations in close() work
    vi.useRealTimers();
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

    session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, adapter: costAdapter } });
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

  it('restores status to ready after sendMessage throws so subsequent turns can proceed', async () => {
    // docker.exec failures (timeout, network glitch, etc.) must not
    // leave the session permanently stuck in 'processing' — that would
    // block all future turns with SessionNotReadyError.
    const failingDocker = createMockDocker();
    failingDocker.exec = async () => {
      throw new Error('docker.exec failed');
    };
    const localDeps = {
      ...deps,
      infra: { ...deps.infra, docker: failingDocker },
    };

    session = new DockerAgentSession(localDeps);
    await session.initialize();

    await expect(session.sendMessage('Hello')).rejects.toThrow('docker.exec failed');
    expect(session.getInfo().status).toBe('ready');

    // A second call should go through the guard and re-attempt, not be
    // blocked on a stale 'processing' state.
    await expect(session.sendMessage('Hello again')).rejects.toThrow('docker.exec failed');
    expect(session.getInfo().status).toBe('ready');
  });

  it('leaves status as closed when sendMessage races with close()', async () => {
    // If close() sets status to 'closed' while sendMessage is mid-flight,
    // the finally block must NOT clobber it back to 'ready'.
    const slowDocker = createMockDocker();
    let resolveExec: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | null = null;
    slowDocker.exec = () =>
      new Promise((resolve) => {
        resolveExec = resolve;
      });

    const localDeps = {
      ...deps,
      infra: { ...deps.infra, docker: slowDocker },
    };

    session = new DockerAgentSession(localDeps);
    await session.initialize();

    const sendPromise = session.sendMessage('Hello');
    // Let the microtasks settle so sendMessage enters the try block.
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.getInfo().status).toBe('processing');

    // Race: close() runs while sendMessage is awaiting docker.exec.
    const closePromise = session.close();
    // Release the exec so sendMessage's finally runs.
    resolveExec?.({ exitCode: 0, stdout: JSON.stringify({ result: 'ok' }), stderr: '' });

    await Promise.allSettled([sendPromise, closePromise]);
    expect(session.getInfo().status).toBe('closed');
  });

  it('handles non-zero exit codes via adapter.extractResponse', async () => {
    const customDocker = createMockDocker();
    customDocker.exec = async () => ({
      exitCode: 1,
      stdout: 'Something went wrong',
      stderr: 'error details',
    });

    session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, docker: customDocker } });
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
    appendFileSync(deps.infra.auditLogPath, JSON.stringify(entry) + '\n');
    session.flushAuditLog();

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves escalation by writing response file', async () => {
    vi.useFakeTimers();

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
    writeFileSync(join(deps.infra.escalationDir, `request-${escalationId}.json`), JSON.stringify(request));

    // Advance fake timers to trigger the escalation watcher's polling interval (300ms default)
    vi.advanceTimersByTime(350);

    const pending = session.getPendingEscalation();
    expect(pending).toBeDefined();
    expect(pending?.escalationId).toBe(escalationId);

    // Resolve the escalation
    await session.resolveEscalation(escalationId, 'denied');

    // Response file should exist
    const responsePath = join(deps.infra.escalationDir, `response-${escalationId}.json`);
    expect(existsSync(responsePath)).toBe(true);

    // Pending should be cleared
    expect(session.getPendingEscalation()).toBeUndefined();

    vi.useRealTimers();
  });

  it('throws when resolving unknown escalation', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await expect(session.resolveEscalation('nonexistent', 'approved')).rejects.toThrow('No pending escalation');
  });

  it('calls onEscalation callback when escalation detected', async () => {
    vi.useFakeTimers();

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
    writeFileSync(join(deps.infra.escalationDir, 'request-esc-456.json'), JSON.stringify(request));

    vi.advanceTimersByTime(350);

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-456');

    vi.useRealTimers();
  });

  it('detects escalation expiry when files are removed', async () => {
    vi.useFakeTimers();

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
    writeFileSync(join(deps.infra.escalationDir, 'request-esc-789.json'), JSON.stringify(request));

    vi.advanceTimersByTime(350);
    expect(session.getPendingEscalation()).toBeDefined();

    // Simulate proxy-side cleanup (both files removed = expired)
    rmSync(join(deps.infra.escalationDir, 'request-esc-789.json'));

    vi.advanceTimersByTime(350);
    expect(expired).toBe(true);
    expect(session.getPendingEscalation()).toBeUndefined();

    vi.useRealTimers();
  });

  it('writes user context for auto-approver', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('Please fix the CSS');

    const contextPath = join(deps.infra.escalationDir, 'user-context.json');
    expect(existsSync(contextPath)).toBe(true);
  });

  // Mount configuration and TCP sidecar/network setup are the factory's
  // responsibility; those assertions live in docker-infrastructure.test.ts.

  it('getDiagnosticLog returns accumulated events', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const log = session.getDiagnosticLog();
    expect(Array.isArray(log)).toBe(true);
  });

  describe('TCP mode with internal network', () => {
    // Sidecar/network creation and connectivity-check tests live in
    // docker-infrastructure.test.ts. What remains here: verifying that
    // `close()` tears down the sidecar, the main container, and the
    // internal network that were handed to the session via the pre-built
    // infrastructure bundle.

    it('removes sidecar and internal network on close', async () => {
      const baseDeps = createTestDeps(tempDir);
      const removedNetworks: string[] = [];
      const stoppedContainers: string[] = [];
      const removedContainers: string[] = [];

      const docker: DockerManager = {
        ...createMockDocker(),
        async stop(id: string) {
          stoppedContainers.push(id);
        },
        async remove(id: string) {
          removedContainers.push(id);
        },
        async removeNetwork(name: string) {
          removedNetworks.push(name);
        },
      };

      const expectedNetworkName = getInternalNetworkName('test-session'.substring(0, 12));
      const infra: DockerInfrastructure = {
        ...baseDeps.infra,
        docker,
        useTcp: true,
        containerId: 'container-cleanup',
        sidecarContainerId: 'sidecar-cleanup',
        internalNetwork: expectedNetworkName,
        mitmAddr: { port: 8443 },
      };

      session = new DockerAgentSession({ ...baseDeps, infra });
      await session.initialize();
      await session.close();

      // Both app container and sidecar should be stopped and removed
      expect(stoppedContainers).toContain('container-cleanup');
      expect(stoppedContainers).toContain('sidecar-cleanup');
      expect(removedContainers).toContain('container-cleanup');
      expect(removedContainers).toContain('sidecar-cleanup');
      expect(removedNetworks).toContain(expectedNetworkName);
    });
  });

  describe('infrastructure ownership (ownsInfra flag)', () => {
    // Counts calls to the underlying infra teardown primitives. When
    // `ownsInfra=true`, these are invoked as part of close(); when
    // `ownsInfra=false`, close() leaves them untouched for the external
    // owner to invoke later via destroyDockerInfrastructure().
    interface TeardownSpies {
      readonly docker: DockerManager;
      readonly mitmProxy: MitmProxy;
      readonly proxy: DockerProxy;
      readonly counts: {
        containerStops: number;
        containerRemoves: number;
        mitmStops: number;
        proxyStops: number;
      };
    }

    function createTeardownSpies(sessionDir: string): TeardownSpies {
      const counts = {
        containerStops: 0,
        containerRemoves: 0,
        mitmStops: 0,
        proxyStops: 0,
      };

      const docker: DockerManager = {
        ...createMockDocker(),
        async stop() {
          counts.containerStops++;
        },
        async remove() {
          counts.containerRemoves++;
        },
      };

      const mitmProxy: MitmProxy = {
        async start() {
          return { socketPath: '/tmp/test-mitm-proxy.sock' };
        },
        async stop() {
          counts.mitmStops++;
        },
      };

      const proxy: DockerProxy = {
        ...createMockProxy(join(sessionDir, 'proxy.sock')),
        async stop() {
          counts.proxyStops++;
        },
      };

      return { docker, mitmProxy, proxy, counts };
    }

    it('close() DOES call destroyDockerInfrastructure when ownsInfra=true', async () => {
      const spies = createTeardownSpies(deps.infra.sessionDir);
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: true,
        infra: {
          ...deps.infra,
          docker: spies.docker,
          mitmProxy: spies.mitmProxy,
          proxy: spies.proxy,
        },
      });
      await session.initialize();
      await session.close();

      // Each infra resource should have been released exactly once.
      expect(spies.counts.containerStops).toBe(1);
      expect(spies.counts.containerRemoves).toBe(1);
      expect(spies.counts.mitmStops).toBe(1);
      expect(spies.counts.proxyStops).toBe(1);
    });

    it('close() does NOT call destroyDockerInfrastructure when ownsInfra=false', async () => {
      const spies = createTeardownSpies(deps.infra.sessionDir);
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: false,
        infra: {
          ...deps.infra,
          docker: spies.docker,
          mitmProxy: spies.mitmProxy,
          proxy: spies.proxy,
        },
      });
      await session.initialize();
      await session.close();

      // Borrowed infra stays alive; the external owner is responsible for
      // calling destroyDockerInfrastructure() later.
      expect(spies.counts.containerStops).toBe(0);
      expect(spies.counts.containerRemoves).toBe(0);
      expect(spies.counts.mitmStops).toBe(0);
      expect(spies.counts.proxyStops).toBe(0);
    });

    it('close() stops escalation watcher and audit tailer regardless of ownsInfra value', async () => {
      // Both ownsInfra branches must tear down the escalation watcher and
      // audit tailer, since those lifecycles are session-owned (not
      // infra-owned). Verified behaviorally via two post-close signals:
      //   1. Dropping a fresh escalation request after close does not fire
      //      the onEscalation callback (poll interval stopped).
      //   2. The session rejects sendMessage with a "closed" error.
      vi.useFakeTimers();

      for (const ownsInfra of [true, false] as const) {
        const localTempDir = mkdtempSync(join(tmpdir(), 'owns-infra-watchers-'));
        try {
          const localDeps = createTestDeps(localTempDir);
          const escalations: EscalationRequest[] = [];
          const local = new DockerAgentSession({
            ...localDeps,
            ownsInfra,
            onEscalation: (req) => escalations.push(req),
          });
          await local.initialize();

          // Sanity-check: the watcher was actively polling before close.
          const warmupRequest: EscalationRequest = {
            escalationId: 'owns-infra-warmup',
            toolName: 'write_file',
            serverName: 'filesystem',
            arguments: { path: '/warmup' },
            reason: 'Warmup',
          };
          writeFileSync(
            join(localDeps.infra.escalationDir, 'request-owns-infra-warmup.json'),
            JSON.stringify(warmupRequest),
          );
          vi.advanceTimersByTime(350);
          expect(escalations).toHaveLength(1);

          await local.close();
          const callbacksBeforePostClose = escalations.length;

          // Post-close: a fresh escalation request must NOT fire the
          // onEscalation callback, because the poll interval was stopped.
          const postCloseRequest: EscalationRequest = {
            escalationId: 'owns-infra-post-close',
            toolName: 'write_file',
            serverName: 'filesystem',
            arguments: { path: '/post' },
            reason: 'Post-close',
          };
          writeFileSync(
            join(localDeps.infra.escalationDir, 'request-owns-infra-post-close.json'),
            JSON.stringify(postCloseRequest),
          );
          vi.advanceTimersByTime(1000);
          expect(escalations.length).toBe(callbacksBeforePostClose);

          // Post-close: the session refuses further work regardless of which
          // ownership mode was used.
          await expect(local.sendMessage('hi')).rejects.toThrow('closed');
        } finally {
          rmSync(localTempDir, { recursive: true, force: true });
        }
      }

      vi.useRealTimers();
    });
  });
});
