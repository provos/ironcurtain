import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DockerInfrastructure, PreContainerInfrastructure } from '../src/docker/docker-infrastructure.js';
import {
  prepareConversationStateDir,
  createSessionContainers,
  destroyDockerInfrastructure,
} from '../src/docker/docker-infrastructure.js';
import type { AgentAdapter, ConversationStateConfig } from '../src/docker/agent-adapter.js';
import type { DockerProxy } from '../src/docker/code-mode-proxy.js';
import type { MitmProxy } from '../src/docker/mitm-proxy.js';
import type { DockerManager } from '../src/docker/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { getInternalNetworkName } from '../src/docker/platform.js';
import {
  createDockerCallTracker,
  createMockAdapter,
  createMockCA,
  createMockDocker,
  type CreateMockDockerOptions,
  type DockerCallTracker,
} from './helpers/docker-mocks.js';

/**
 * Type-level tests for the DockerInfrastructure interface.
 *
 * prepareDockerInfrastructure() requires real Docker, MCP servers,
 * and proxy infrastructure to run, so we verify the interface shape
 * rather than calling the function directly. The actual integration
 * is tested via the Docker session tests and PTY session tests.
 */

describe('DockerInfrastructure interface', () => {
  it('has all required fields', () => {
    // Compile-time type assertion: this object satisfies DockerInfrastructure.
    // If a field is missing or has the wrong type, TypeScript will error.
    const infra: DockerInfrastructure = {
      bundleId: 'test-session-id' as import('../src/session/types.js').BundleId,
      bundleDir: '/tmp/test/sessions/test-session-id',
      workspaceDir: '/tmp/test/sessions/test-session-id/sandbox',
      escalationDir: '/tmp/test/sessions/test-session-id/escalations',
      auditLogPath: '/tmp/test/sessions/test-session-id/audit.jsonl',
      proxy: {
        socketPath: '/tmp/proxy.sock',
        port: undefined,
        start: async () => {},
        getHelpData: () => ({
          serverDescriptions: {},
          toolsByServer: {},
        }),
        stop: async () => {},
      },
      mitmProxy: {
        start: async () => ({ socketPath: '/tmp/mitm.sock' }),
        stop: async () => {},
        hosts: {
          addHost: () => true,
          removeHost: () => true,
          listHosts: () => ({ providers: [], dynamic: [] }),
        },
        setTokenSessionId: () => {},
      },
      docker: {
        preflight: async () => {},
        create: async () => 'container-id',
        start: async () => {},
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        stop: async () => {},
        remove: async () => {},
        isRunning: async () => true,
        imageExists: async () => true,
        pullImage: async () => {},
        buildImage: async () => {},
        getImageLabel: async () => undefined,
        createNetwork: async () => {},
        removeNetwork: async () => {},
        connectNetwork: async () => {},
        getContainerIp: async () => '172.17.0.2',
      },
      adapter: {
        id: 'test-agent' as import('../src/docker/agent-adapter.js').AgentId,
        displayName: 'Test Agent',
        getImage: async () => 'test-image:latest',
        generateMcpConfig: () => [],
        generateOrientationFiles: () => [],
        buildCommand: () => ['test'],
        buildSystemPrompt: () => 'test prompt',
        getProviders: () => [],
        buildEnv: () => ({}),
        extractResponse: () => ({ text: '' }),
      },
      ca: {
        certPem: 'mock-cert',
        keyPem: 'mock-key',
        certPath: '/tmp/ca-cert.pem',
        keyPath: '/tmp/ca-key.pem',
      },
      fakeKeys: new Map(),
      orientationDir: '/tmp/test/sessions/test-session-id/orientation',
      systemPrompt: 'Test system prompt',
      image: 'test-image:latest',
      useTcp: false,
      socketsDir: '/tmp/test/sessions/test-session-id/sockets',
      mitmAddr: { socketPath: '/tmp/mitm.sock' },
      authKind: 'apikey',
      containerId: 'container-id',
      containerName: 'ironcurtain-test-session',
      setTokenSessionId: () => {},
    };

    // Verify key fields are accessible at runtime
    expect(infra.bundleId).toBe('test-session-id');
    expect(infra.useTcp).toBe(false);
    expect(infra.fakeKeys).toBeInstanceOf(Map);
    expect(infra.mitmAddr.socketPath).toBe('/tmp/mitm.sock');
    expect(infra.systemPrompt).toBe('Test system prompt');
    expect(infra.image).toBe('test-image:latest');
    expect(infra.socketsDir).toContain('sockets');
    expect(infra.containerId).toBe('container-id');
    expect(infra.containerName).toBe('ironcurtain-test-session');
  });

  it('supports TCP mode with port-based mitmAddr', () => {
    const tcpAddr: DockerInfrastructure['mitmAddr'] = { port: 8443 };
    expect(tcpAddr.port).toBe(8443);
    expect(tcpAddr.socketPath).toBeUndefined();
  });

  it('supports UDS mode with socketPath-based mitmAddr', () => {
    const udsAddr: DockerInfrastructure['mitmAddr'] = { socketPath: '/tmp/mitm.sock' };
    expect(udsAddr.socketPath).toBe('/tmp/mitm.sock');
    expect(udsAddr.port).toBeUndefined();
  });
});

describe('prepareConversationStateDir', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'conv-state-test-'));
  });

  afterEach(() => {
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('creates state dir and seeds files on first run', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [
        { path: 'data/', content: '' },
        { path: 'config.json', content: '{"key": "value"}' },
      ],
      resumeFlags: ['--resume'],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    expect(stateDir).toBe(join(sessionDir, 'test-state'));
    expect(existsSync(join(stateDir, 'data'))).toBe(true);
    expect(readFileSync(join(stateDir, 'config.json'), 'utf-8')).toBe('{"key": "value"}');
  });

  it('calls seed content function and skips undefined results', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [
        { path: 'present.json', content: () => '{"present": true}' },
        { path: 'absent.json', content: () => undefined },
      ],
      resumeFlags: [],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    expect(readFileSync(join(stateDir, 'present.json'), 'utf-8')).toBe('{"present": true}');
    expect(existsSync(join(stateDir, 'absent.json'))).toBe(false);
  });

  it('does not re-seed on subsequent runs', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [{ path: 'config.json', content: '{"original": true}' }],
      resumeFlags: [],
    };

    // First run creates the file
    prepareConversationStateDir(sessionDir, config);

    // Modify the file to simulate agent writes
    const configPath = join(sessionDir, 'test-state', 'config.json');
    writeFileSync(configPath, '{"modified": true}');

    // Second run should not overwrite
    prepareConversationStateDir(sessionDir, config);
    expect(readFileSync(configPath, 'utf-8')).toBe('{"modified": true}');
  });

  it('deletes .credentials.json on every run (defense-in-depth)', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [],
      resumeFlags: [],
    };

    // First run creates the dir
    const stateDir = prepareConversationStateDir(sessionDir, config);

    // Simulate agent creating credentials
    writeFileSync(join(stateDir, '.credentials.json'), '{"token": "secret"}');
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(true);

    // Second run should delete it
    prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(false);
  });

  it('handles missing .credentials.json gracefully', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [],
      resumeFlags: [],
    };

    // Should not throw even when .credentials.json doesn't exist
    expect(() => prepareConversationStateDir(sessionDir, config)).not.toThrow();
  });

  it('creates nested directories for seed file paths', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [{ path: 'deep/nested/file.txt', content: 'hello' }],
      resumeFlags: [],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);
    expect(readFileSync(join(stateDir, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('hello');
  });
});

// --- createSessionContainers tests ---
//
// These tests exercise the container-creation helper used by
// createDockerInfrastructure(). They drive a scripted PreContainerInfrastructure
// with a mock DockerManager to verify:
//   - the main container's mount configuration (security: only sockets subdir
//     in UDS mode, never the full session dir with escalation/audit files)
//   - rollback semantics when a downstream step (connectivity check) fails
//     after the main container has already been created and started

/** Overrides accepted by the test-local makeMockDocker wrapper. */
type MockDockerOverrides = Pick<CreateMockDockerOptions, 'exec' | 'create'>;

/**
 * Thin wrapper around the shared createMockDocker that bundles a
 * DockerCallTracker for test assertions. The shared helper returns just
 * the DockerManager; this wrapper flattens the tracker into the same
 * return shape the tests already use.
 */
function makeMockDocker(overrides: MockDockerOverrides = {}): { docker: DockerManager } & DockerCallTracker {
  const tracker = createDockerCallTracker();
  const docker = createMockDocker({ tracker, ...overrides });
  return { docker, ...tracker };
}

/** Local alias kept so existing call sites read the same. */
const makeMockProxy = (socketPath: string, port?: number): DockerProxy => ({
  socketPath,
  port,
  async start() {},
  getHelpData() {
    return { serverDescriptions: {}, toolsByServer: {} };
  },
  async stop() {},
});

const makeMockMitmProxy = (): MitmProxy => ({
  async start() {
    return { socketPath: '/tmp/test-mitm-proxy.sock' };
  },
  async stop() {},
  hosts: {
    addHost: () => true,
    removeHost: () => true,
    listHosts: () => ({ providers: [], dynamic: [] }),
  },
  setTokenSessionId: () => {},
});

/** Minimal config accepted by createSessionContainers. */
function makeMockConfig(): IronCurtainConfig {
  return {
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
}

/** Options for configuring the mock PreContainerInfrastructure. */
interface MockCoreOptions {
  readonly tempDir: string;
  readonly useTcp: boolean;
  readonly docker: DockerManager;
  readonly adapter?: AgentAdapter;
}

/**
 * Builds a PreContainerInfrastructure rooted at `tempDir`, with on-disk
 * session/sandbox/sockets/orientation directories so the real
 * `writeFileSync(orientationDir, ...)` call inside createSessionContainers
 * actually works.
 */
function makeMockCore(opts: MockCoreOptions): PreContainerInfrastructure {
  const bundleId = 'test-session-id' as import('../src/session/types.js').BundleId;
  const bundleDir = join(opts.tempDir, 'session');
  const workspaceDir = join(opts.tempDir, 'sandbox');
  const escalationDir = join(opts.tempDir, 'escalations');
  const orientationDir = join(bundleDir, 'orientation');
  const socketsDir = join(bundleDir, 'sockets');
  const auditLogPath = join(opts.tempDir, 'audit.jsonl');

  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });
  mkdirSync(orientationDir, { recursive: true });
  mkdirSync(socketsDir, { recursive: true });

  const proxyPort = opts.useTcp ? 9123 : undefined;
  const mitmAddr: PreContainerInfrastructure['mitmAddr'] = opts.useTcp
    ? { port: 8443 }
    : { socketPath: '/tmp/test-mitm-proxy.sock' };

  return {
    bundleId,
    bundleDir,
    workspaceDir,
    escalationDir,
    auditLogPath,
    proxy: makeMockProxy(join(socketsDir, 'proxy.sock'), proxyPort),
    mitmProxy: makeMockMitmProxy(),
    docker: opts.docker,
    adapter: opts.adapter ?? createMockAdapter(),
    ca: createMockCA(opts.tempDir),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake-key']]),
    orientationDir,
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    useTcp: opts.useTcp,
    socketsDir,
    mitmAddr,
    authKind: 'apikey',
    setTokenSessionId: () => {},
  };
}

describe('createSessionContainers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'create-session-containers-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --- Test A (security-relevant) ---
  it('mounts only sockets subdirectory in UDS mode, not the full session dir', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });

    const result = await createSessionContainers(core, makeMockConfig());

    expect(result.containerId).toBeDefined();
    expect(result.sidecarContainerId).toBeUndefined();
    expect(result.internalNetwork).toBeUndefined();

    // Only one docker.create call in UDS mode: the main container.
    expect(createCalls).toHaveLength(1);
    const mounts = createCalls[0].mounts;

    // Defense-in-depth: /run/ironcurtain must map to sockets/ only, so the
    // container cannot reach escalation files, audit log, or other session data.
    const runMount = mounts.find((m) => m.target === '/run/ironcurtain');
    expect(runMount).toBeDefined();
    expect(runMount!.source).toBe(core.socketsDir);
    expect(runMount!.source).not.toBe(core.bundleDir);

    // Symmetric sanity check: the bundle dir itself is never mounted anywhere.
    expect(mounts.some((m) => m.source === core.bundleDir)).toBe(false);
    // And neither is the escalation dir or audit log.
    expect(mounts.some((m) => m.source === core.escalationDir)).toBe(false);
    expect(mounts.some((m) => m.source === core.auditLogPath)).toBe(false);
  });

  // --- Test B (error-path critical) ---
  // This is the test that would have caught Fix 1's bug: the pre-fix catch
  // passed containerId:null to cleanupContainers, so a failed connectivity
  // check would leak the already-started main container. The test fails
  // both TCP-mode resources (sidecar + network) AND the main container
  // to defend against regressions from either end of the rollback path.
  it('throws when connectivity check fails and cleans up sidecar, network, and main container', async () => {
    const { docker, stoppedContainers, removedContainers, removedNetworks } = makeMockDocker({
      async exec() {
        // Simulate the connectivity check failing: container can't reach
        // host-side proxies through the socat sidecar.
        return { exitCode: 1, stdout: '', stderr: 'Connection refused' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(
      /Internal network connectivity check failed/,
    );

    // The sidecar is `container-1` (first docker.create call) and the main
    // container is `container-2` (second). Both must be stopped and removed
    // regardless of where the failure occurred in the try block.
    expect(stoppedContainers).toContain('container-1'); // sidecar
    expect(stoppedContainers).toContain('container-2'); // main
    expect(removedContainers).toContain('container-1');
    expect(removedContainers).toContain('container-2');

    // The per-session internal network must also be cleaned up.
    const expectedNetworkName = getInternalNetworkName('test-session'.substring(0, 12));
    expect(removedNetworks).toContain(expectedNetworkName);
  });
});

// --- destroyDockerInfrastructure tests ---
//
// These tests exercise the teardown counterpart to createDockerInfrastructure().
// They drive a scripted DockerInfrastructure bundle with a mock DockerManager
// and mock proxies to verify:
//   - all teardown steps run, in the right order
//   - UDS mode skips sidecar + network steps (those fields are undefined in
//     the bundle, so cleanupContainers has nothing to clean)
//   - TCP mode runs sidecar + network steps
//   - a failure in one step does not prevent subsequent steps from running
//     (error tolerance: callers in recovery paths depend on this function
//     never throwing)

/**
 * Tracked proxy: records whether `stop()` was called and optionally throws.
 * Used to assert ordering across proxy stops and to inject failures.
 */
interface TrackedProxy {
  stop: () => Promise<void>;
  stopped: boolean;
}

function makeTrackedMitmProxy(opts: { throwOnStop?: boolean } = {}): MitmProxy & TrackedProxy {
  const tracked = {
    stopped: false,
    async start() {
      return { socketPath: '/tmp/test-mitm-proxy.sock' };
    },
    async stop() {
      tracked.stopped = true;
      if (opts.throwOnStop) throw new Error('mitm-proxy stop failed');
    },
  } as unknown as MitmProxy & TrackedProxy;
  return tracked;
}

function makeTrackedDockerProxy(opts: { throwOnStop?: boolean } = {}): DockerProxy & TrackedProxy {
  const tracked = {
    socketPath: '/tmp/test-proxy.sock',
    port: undefined,
    stopped: false,
    async start() {},
    getHelpData() {
      return { serverDescriptions: {}, toolsByServer: {} };
    },
    async stop() {
      tracked.stopped = true;
      if (opts.throwOnStop) throw new Error('docker-proxy stop failed');
    },
  } as unknown as DockerProxy & TrackedProxy;
  return tracked;
}

/**
 * Builds a full DockerInfrastructure bundle for teardown tests. TCP-mode
 * fields (sidecarContainerId, internalNetwork) are populated only when
 * `useTcp` is true, matching what createSessionContainers() would produce.
 */
interface MakeBundleOptions {
  readonly tempDir: string;
  readonly useTcp: boolean;
  readonly docker: DockerManager;
  readonly mitmProxy: MitmProxy;
  readonly proxy: DockerProxy;
}

function makeInfrastructureBundle(opts: MakeBundleOptions): DockerInfrastructure {
  const core = makeMockCore({ tempDir: opts.tempDir, useTcp: opts.useTcp, docker: opts.docker });
  // Overlay the tracked proxies onto the core (makeMockCore installs its own
  // defaults, which we don't want for teardown assertions).
  const coreWithProxies: PreContainerInfrastructure = {
    ...core,
    mitmProxy: opts.mitmProxy,
    proxy: opts.proxy,
  };
  return {
    ...coreWithProxies,
    containerId: 'main-container-id',
    containerName: 'ironcurtain-test-session',
    ...(opts.useTcp
      ? {
          sidecarContainerId: 'sidecar-container-id',
          internalNetwork: getInternalNetworkName('test-session'.substring(0, 12)),
        }
      : {}),
  };
}

describe('destroyDockerInfrastructure', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'destroy-infra-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs all teardown steps (TCP mode: container, sidecar, network, both proxies)', async () => {
    // Containers tear down before proxies (stop consumers before producers);
    // the two proxy stops run in parallel, so their relative order is not
    // part of the contract -- only that both were called.
    const { docker, stoppedContainers, removedContainers, removedNetworks } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: true, docker, mitmProxy, proxy });

    await destroyDockerInfrastructure(infra);

    // Main + sidecar containers both stopped + removed.
    expect(stoppedContainers).toContain('main-container-id');
    expect(stoppedContainers).toContain('sidecar-container-id');
    expect(removedContainers).toContain('main-container-id');
    expect(removedContainers).toContain('sidecar-container-id');

    // Internal network removed.
    expect(removedNetworks).toContain(infra.internalNetwork);

    // Both proxies stopped (parallel; order not asserted).
    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true);
  });

  it('UDS mode skips sidecar + network steps (neither is present in the bundle)', async () => {
    const { docker, stoppedContainers, removedContainers, removedNetworks } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: false, docker, mitmProxy, proxy });

    // Sanity: UDS bundle has no sidecar or internal network.
    expect(infra.sidecarContainerId).toBeUndefined();
    expect(infra.internalNetwork).toBeUndefined();

    await destroyDockerInfrastructure(infra);

    // Only the main container is cleaned up.
    expect(stoppedContainers).toEqual(['main-container-id']);
    expect(removedContainers).toEqual(['main-container-id']);

    // No network removal (networkName was null).
    expect(removedNetworks).toEqual([]);

    // Proxies still stopped.
    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true);
  });

  it('TCP mode removes the per-session internal network', async () => {
    const { docker, removedNetworks } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: true, docker, mitmProxy, proxy });

    await destroyDockerInfrastructure(infra);

    const expectedNetworkName = getInternalNetworkName('test-session'.substring(0, 12));
    expect(infra.internalNetwork).toBe(expectedNetworkName);
    expect(removedNetworks).toEqual([expectedNetworkName]);
  });

  it('continues with remaining steps when the main container stop throws', async () => {
    // Force docker.stop() to throw. cleanupContainers() catches per-resource
    // failures internally, so downstream proxy stops should still run.
    const stoppedContainers: string[] = [];
    const removedContainers: string[] = [];
    const docker: DockerManager = {
      ...makeMockDocker().docker,
      async stop(id: string) {
        stoppedContainers.push(id);
        if (id === 'main-container-id') {
          throw new Error('docker stop failed');
        }
      },
      async remove(id: string) {
        removedContainers.push(id);
      },
    };
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: true, docker, mitmProxy, proxy });

    // Must not throw -- error tolerance is the contract.
    await expect(destroyDockerInfrastructure(infra)).resolves.toBeUndefined();

    // Main container stop was attempted (then swallowed).
    expect(stoppedContainers).toContain('main-container-id');
    // Sidecar cleanup still ran despite the main-container failure.
    expect(stoppedContainers).toContain('sidecar-container-id');
    expect(removedContainers).toContain('sidecar-container-id');
    // And the proxy steps still ran.
    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true);
  });

  it('continues with proxy.stop() when mitmProxy.stop() throws', async () => {
    // Directly exercise the per-step isolation around the proxy stops:
    // a throw from mitmProxy.stop() must not prevent proxy.stop().
    const { docker } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy({ throwOnStop: true });
    const proxy = makeTrackedDockerProxy();
    const infra = makeInfrastructureBundle({ tempDir, useTcp: false, docker, mitmProxy, proxy });

    await expect(destroyDockerInfrastructure(infra)).resolves.toBeUndefined();

    expect(mitmProxy.stopped).toBe(true); // attempted
    expect(proxy.stopped).toBe(true); // still ran
  });

  it('still resolves when proxy.stop() throws (last step, must not propagate)', async () => {
    // Symmetric to the mitmProxy-throws test: proxy.stop() is the final step,
    // so there's no "subsequent step still runs" to verify, but the error
    // tolerance contract (never throws) still matters -- callers in recovery
    // paths depend on it.
    const { docker } = makeMockDocker();
    const mitmProxy = makeTrackedMitmProxy();
    const proxy = makeTrackedDockerProxy({ throwOnStop: true });
    const infra = makeInfrastructureBundle({ tempDir, useTcp: false, docker, mitmProxy, proxy });

    await expect(destroyDockerInfrastructure(infra)).resolves.toBeUndefined();

    expect(mitmProxy.stopped).toBe(true);
    expect(proxy.stopped).toBe(true); // attempted, error swallowed
  });
});
