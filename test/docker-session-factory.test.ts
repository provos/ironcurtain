/**
 * Tests for `createDockerSession()` in `src/session/index.ts`.
 *
 * Covers both standalone and borrow paths. The borrow path (where the
 * caller supplies a pre-built `DockerInfrastructure` via
 * `options.workflowInfrastructure`) is the Step 4 addition for workflow
 * mode: the session must use the supplied bundle as-is and must not
 * destroy it on `close()` -- the caller retains ownership.
 *
 * We mock the infrastructure module so we can observe whether
 * `createDockerInfrastructure` / `destroyDockerInfrastructure` are called,
 * without requiring a real Docker daemon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as logger from '../src/logger.js';
import { getSessionsDir } from '../src/config/paths.js';

// --- Module mocks (hoisted) ---

// Track calls to the infrastructure lifecycle functions. We expose the
// control surface via dedicated hooks so tests can reconfigure behavior
// per-case (e.g., make claude-md write throw to exercise the error path,
// or return a pre-built bundle for the standalone success path).
const infraState: {
  createCalls: number;
  destroyCalls: number;
  createShouldThrow: boolean | Error;
  // When set, `createDockerInfrastructure` resolves with this bundle,
  // simulating a successful standalone setup so we can drive the factory
  // all the way through to `session.close()` -> destroy on the happy path.
  createReturnValue: unknown;
} = {
  createCalls: 0,
  destroyCalls: 0,
  createShouldThrow: false,
  createReturnValue: undefined,
};

vi.mock('../src/docker/docker-infrastructure.js', () => ({
  createDockerInfrastructure: vi.fn(async () => {
    infraState.createCalls++;
    if (infraState.createShouldThrow) {
      throw infraState.createShouldThrow instanceof Error
        ? infraState.createShouldThrow
        : new Error('createDockerInfrastructure failure (scripted)');
    }
    if (infraState.createReturnValue !== undefined) {
      return infraState.createReturnValue;
    }
    // Default: no bundle scripted. Tests that want the standalone path to
    // resolve must populate `infraState.createReturnValue` explicitly.
    throw new Error('standalone path not used by these tests');
  }),
  destroyDockerInfrastructure: vi.fn(async () => {
    infraState.destroyCalls++;
  }),
  // Not used in our tests but present on the real module.
  prepareDockerInfrastructure: vi.fn(),
  createSessionContainers: vi.fn(),
  prepareConversationStateDir: vi.fn(),
}));

// Mock claude-md-seed so we can exercise the error path by making the
// writeFileSync for CLAUDE.md throw (by pointing conversationStateDir at a
// non-existent parent directory).
vi.mock('../src/docker/claude-md-seed.js', () => ({
  buildDockerClaudeMd: vi.fn(() => 'test claude md content'),
}));

// Stub DockerAgentSession's dynamic-import target. We need the real
// implementation because the factory constructs it and calls initialize().
// Do NOT mock this module -- the real DockerAgentSession wires up the
// escalation watcher + audit tailer against the infra's paths, which is
// what we want to verify.

// --- Imports (after mocks are set up) ---

import { createSession } from '../src/session/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import { createDockerInfrastructure, destroyDockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import {
  createMockAdapter,
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
} from './helpers/docker-mocks.js';

// --- Helpers ---

const TEST_HOME = `/tmp/ironcurtain-docker-factory-test-${process.pid}`;

function createTestConfig(): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: `${TEST_HOME}/sandbox`,
    mcpServers: {},
    protectedPaths: [],
    generatedDir: `${TEST_HOME}/generated`,
    constitutionPath: `${TEST_HOME}/constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-api-key',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: false, llmBaseUrl: undefined, llmApiKey: undefined },
    },
  } as unknown as IronCurtainConfig;
}

/**
 * Builds a mock DockerInfrastructure bundle suitable for the borrow path.
 * The directories on the bundle must exist so DockerAgentSession.initialize()
 * can write system-prompt.txt and start the escalation watcher against them.
 */
function createMockInfra(rootDir: string, idSuffix = 'borrow'): DockerInfrastructure {
  const sessionDir = join(rootDir, `infra-${idSuffix}`);
  const sandboxDir = join(sessionDir, 'sandbox');
  const escalationDir = join(sessionDir, 'escalations');
  const auditLogPath = join(sessionDir, 'audit.jsonl');
  const conversationStateDir = join(sessionDir, 'conversation-state');
  const orientationDir = join(sessionDir, 'orientation');
  const socketsDir = join(sessionDir, 'sockets');

  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });
  mkdirSync(conversationStateDir, { recursive: true });
  mkdirSync(orientationDir, { recursive: true });
  mkdirSync(socketsDir, { recursive: true });
  writeFileSync(auditLogPath, '');

  return {
    sessionId: `infra-${idSuffix}`,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
    proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
    mitmProxy: createMockMitmProxy(),
    docker: createMockDocker(),
    adapter: createMockAdapter(),
    ca: createMockCA(rootDir),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake']]),
    orientationDir,
    systemPrompt: 'You are a borrowed test agent.',
    image: 'ironcurtain-claude-code:latest',
    useTcp: false,
    socketsDir,
    mitmAddr: { socketPath: '/tmp/test-mitm-proxy.sock' },
    authKind: 'apikey',
    conversationStateDir,
    conversationStateConfig: undefined,
    containerId: 'container-borrowed-abc123',
    containerName: 'ironcurtain-borrowed',
    sidecarContainerId: undefined,
    internalNetwork: undefined,
  };
}

// --- Tests ---

describe('createDockerSession borrow path', () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });

    tempDir = join(TEST_HOME, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });

    // Reset mock call counters each test
    infraState.createCalls = 0;
    infraState.destroyCalls = 0;
    infraState.createShouldThrow = false;
    infraState.createReturnValue = undefined;
    vi.mocked(createDockerInfrastructure).mockClear();
    vi.mocked(destroyDockerInfrastructure).mockClear();
  });

  afterEach(() => {
    logger.teardown();
    if (originalHome !== undefined) {
      process.env.IRONCURTAIN_HOME = originalHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('basic borrow: session uses the caller-supplied bundle, does NOT call createDockerInfrastructure', async () => {
    const infra = createMockInfra(tempDir, 'basic');

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflowInfrastructure: infra,
    });

    try {
      // Factory must have skipped its own infra creation entirely.
      expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();
      expect(infraState.createCalls).toBe(0);

      // Session is fully wired: status is ready and the bundle's system
      // prompt was written to the infra session dir for debugging.
      expect(session.getInfo().status).toBe('ready');
      expect(existsSync(join(infra.sessionDir, 'system-prompt.txt'))).toBe(true);

      // CLAUDE.md was seeded into the bundle's conversation-state dir.
      expect(existsSync(join(infra.conversationStateDir as string, 'CLAUDE.md'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('borrow with workflowStateDir: creates zero entries under sessions/', async () => {
    // When the orchestrator passes a per-state artifact dir alongside
    // the bundle, the factory must route session.log and metadata into
    // that dir instead of under ~/.ironcurtain/sessions/<uuid>/. This
    // is the core invariant of the workflow-scoped artifact plan.
    const infra = createMockInfra(tempDir, 'state-dir');
    const workflowStateDir = join(tempDir, 'workflow-state', 'fetch.1');
    mkdirSync(workflowStateDir, { recursive: true });

    // Sanity: sessions dir is empty at test start.
    const sessionsDir = getSessionsDir();
    const pre = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflowInfrastructure: infra,
      workflowStateDir,
      stateSlug: 'fetch.1',
    });

    try {
      // No new entries under ~/.ironcurtain/sessions/
      const post = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      expect(post).toEqual(pre);

      // session.log + session-metadata.json landed in the state dir.
      expect(existsSync(join(workflowStateDir, 'session.log'))).toBe(true);
      expect(existsSync(join(workflowStateDir, 'session-metadata.json'))).toBe(true);
      const meta = JSON.parse(readFileSync(join(workflowStateDir, 'session-metadata.json'), 'utf-8'));
      expect(meta.createdAt).toBeDefined();
    } finally {
      await session.close();
    }
  });

  it('workflowStateDir without workflowInfrastructure is rejected', async () => {
    const workflowStateDir = join(tempDir, 'orphan-state');
    mkdirSync(workflowStateDir, { recursive: true });

    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        // Deliberately omit workflowInfrastructure.
        workflowStateDir,
        stateSlug: 'orphan.1',
      }),
    ).rejects.toThrow(/workflowStateDir requires workflowInfrastructure/);
  });

  it('close preserves bundle: destroyDockerInfrastructure is NOT invoked', async () => {
    const infra = createMockInfra(tempDir, 'preserve');

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflowInfrastructure: infra,
    });

    await session.close();

    // Bundle is the caller's responsibility; factory + session must not
    // have torn it down. (Real implementation: DockerAgentSession.close()
    // only calls destroyDockerInfrastructure when ownsInfra=true.)
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();
    expect(infraState.destroyCalls).toBe(0);
  });

  it('bundle reusable across multiple sessions (workflow state transitions)', async () => {
    const infra = createMockInfra(tempDir, 'reuse');

    // First session: borrow, run, close. Bundle stays alive.
    const session1 = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflowInfrastructure: infra,
    });
    expect(session1.getInfo().status).toBe('ready');
    await session1.close();
    expect(infraState.destroyCalls).toBe(0);

    // Second session with the *same* bundle: this is the actual workflow
    // use case -- multiple states share the same container.
    const session2 = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflowInfrastructure: infra,
    });
    try {
      expect(session2.getInfo().status).toBe('ready');
      // Still no factory-driven infra creation or destruction on either session.
      expect(infraState.createCalls).toBe(0);
      expect(infraState.destroyCalls).toBe(0);
    } finally {
      await session2.close();
    }

    // After both sessions have closed, the bundle is still alive.
    expect(infraState.destroyCalls).toBe(0);
  });

  it('standalone path (regression): factory calls createDockerInfrastructure when workflowInfrastructure is absent', async () => {
    // In the standalone path the factory is expected to call
    // createDockerInfrastructure. Our mock for that function is scripted
    // to throw (see the module mock at top of file) because we do not
    // want to spin up a full bundle here -- this test only verifies the
    // branching, not a successful end-to-end standalone session.
    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        // workflowInfrastructure intentionally omitted.
      }),
    ).rejects.toThrow(/standalone path not used/);

    expect(vi.mocked(createDockerInfrastructure)).toHaveBeenCalledTimes(1);
    expect(infraState.createCalls).toBe(1);

    // Even though the standalone factory threw, we did not allocate a
    // bundle (the mock throws before returning), so destroy must not run.
    expect(infraState.destroyCalls).toBe(0);
  });

  it('error-path cleanup: borrow path does NOT destroy the caller bundle when session setup fails', async () => {
    // Point conversationStateDir at a non-existent location so the
    // writeFileSync for CLAUDE.md throws mid-setup. This exercises the
    // catch block on the borrow branch: the factory must NOT call
    // destroyDockerInfrastructure on the caller's bundle.
    const infra = createMockInfra(tempDir, 'error');
    const brokenInfra: DockerInfrastructure = {
      ...infra,
      conversationStateDir: join(tempDir, 'does', 'not', 'exist'),
    };

    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        workflowInfrastructure: brokenInfra,
      }),
    ).rejects.toThrow();

    // The factory must not call createDockerInfrastructure (borrow path)...
    expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();
    // ...and it MUST NOT destroy the caller's bundle on the failure path.
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();
    expect(infraState.destroyCalls).toBe(0);
  });

  it('post-construction failure in borrow mode: session.close() must NOT tear down the caller bundle', async () => {
    // The sibling error-path test above fires BEFORE the DockerAgentSession
    // is constructed (CLAUDE.md write throws). This test fires AFTER
    // construction: the session exists, but `session.initialize()` throws
    // because `escalationDir` points at a regular file so the mkdirSync
    // inside initialize() fails with ENOTDIR. The factory's catch block
    // must take the `if (session)` branch and call `session.close()` --
    // which, because `ownsInfra=false` for borrow mode, must leave the
    // caller's docker/proxy resources untouched. The `builtInfra && infra`
    // fallback branch must NOT run.
    const infra = createMockInfra(tempDir, 'post-construct');

    // Replace escalationDir with a path that exists as a FILE. mkdirSync
    // with recursive:true throws ENOTDIR/EEXIST in that case, surfacing
    // from inside initialize() after the session is constructed.
    const escalationAsFile = join(tempDir, 'escalation-as-file.txt');
    writeFileSync(escalationAsFile, 'not a directory');

    // Wrap the mock docker/proxy/mitm so we can assert they were NOT
    // invoked if the factory accidentally tore down the borrowed bundle.
    const teardownCounts = { dockerStop: 0, dockerRemove: 0, proxyStop: 0, mitmStop: 0 };
    const borrowedInfra: DockerInfrastructure = {
      ...infra,
      escalationDir: escalationAsFile,
      docker: {
        ...infra.docker,
        async stop(id: string) {
          teardownCounts.dockerStop++;
          await infra.docker.stop(id);
        },
        async remove(id: string) {
          teardownCounts.dockerRemove++;
          await infra.docker.remove(id);
        },
      },
      proxy: {
        ...infra.proxy,
        async stop() {
          teardownCounts.proxyStop++;
          await infra.proxy.stop();
        },
      },
      mitmProxy: {
        ...infra.mitmProxy,
        async stop() {
          teardownCounts.mitmStop++;
          await infra.mitmProxy.stop();
        },
      },
    };

    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        workflowInfrastructure: borrowedInfra,
      }),
    ).rejects.toThrow();

    // Borrow path: factory did not build the bundle, so it must not
    // call createDockerInfrastructure.
    expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();

    // Post-construction path: session.close() ran via the `if (session)`
    // branch, but `ownsInfra=false` so destroyDockerInfrastructure must
    // not have been invoked and the mock docker/proxy resources must
    // remain untouched.
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();
    expect(infraState.destroyCalls).toBe(0);
    expect(teardownCounts.dockerStop).toBe(0);
    expect(teardownCounts.dockerRemove).toBe(0);
    expect(teardownCounts.proxyStop).toBe(0);
    expect(teardownCounts.mitmStop).toBe(0);
  });

  it('standalone success path: session.close() destroys the factory-owned bundle', async () => {
    // Complement to the standalone-regression test above (which mocks
    // createDockerInfrastructure to THROW, proving the branching but not
    // the happy-path teardown). Here we hand the mock a real bundle so
    // createDockerSession drives all the way through to a ready session,
    // then assert that session.close() invokes destroyDockerInfrastructure
    // with that same bundle -- the ownership contract for standalone mode.
    //
    // Note: DockerAgentSession.close() itself calls destroyDockerInfrastructure
    // when ownsInfra=true; `docker-session.test.ts` exercises that at the
    // class level. This test is the factory-level twin: the factory sets
    // ownsInfra=true on the standalone path, and the session honors it.
    const builtBundle = createMockInfra(tempDir, 'standalone-success');
    infraState.createReturnValue = builtBundle;

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      // workflowInfrastructure intentionally omitted -- standalone path.
    });

    // Factory consulted createDockerInfrastructure exactly once.
    expect(vi.mocked(createDockerInfrastructure)).toHaveBeenCalledTimes(1);
    expect(infraState.createCalls).toBe(1);
    expect(session.getInfo().status).toBe('ready');
    // Nothing should have been torn down yet.
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();

    await session.close();

    // Standalone close() must destroy the bundle it owns, exactly once,
    // with the same reference the factory built.
    expect(vi.mocked(destroyDockerInfrastructure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(destroyDockerInfrastructure)).toHaveBeenCalledWith(builtBundle);
    expect(infraState.destroyCalls).toBe(1);
  });
});
