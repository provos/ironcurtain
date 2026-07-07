import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DockerInfrastructure, PreContainerInfrastructure } from '../src/docker/docker-infrastructure.js';
import {
  buildAgentUidRemap,
  prepareConversationStateDir,
  createSessionContainers,
  destroyDockerInfrastructure,
  prepareDockerInfrastructure,
  resolveRealKey,
  canRefreshOAuth,
  computeWorkflowDependencyHash,
  buildWorkflowExecCommand,
  ensureImage,
} from '../src/docker/docker-infrastructure.js';
import type { AgentAdapter, AgentId, ConversationStateConfig } from '../src/docker/agent-adapter.js';
import type { DockerProxy } from '../src/docker/code-mode-proxy.js';
import type { MitmProxy } from '../src/docker/mitm-proxy.js';
import type { ContainerRuntime } from '../src/docker/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedProviderProfile } from '../src/config/user-config.js';
import { resolveActiveProfile } from '../src/config/user-config.js';
import { generateFakeKey } from '../src/docker/fake-keys.js';
import { makeOpenRouterProvider, makeOpenRouterRewriter } from '../src/docker/openrouter.js';
import { getInternalNetworkName } from '../src/docker/platform.js';
import { getBundleShortId, type BundleId } from '../src/session/types.js';

// Container target the mock adapter advertises via `skills.containerPath`.
// Hardcoded here (rather than imported from a constant) because the
// adapter contract makes this per-adapter — the test asserts the wired
// target matches what the adapter declared. Matches the post-refactor
// Claude Code path (a sibling of the conversation-state mount, NOT
// nested under it).
const TEST_SKILLS_CONTAINER_PATH = '/home/codespace/skills/.claude/skills';

const TEST_BUNDLE_ID = 'test-session-id' as BundleId;
const TEST_SHORT_ID = getBundleShortId(TEST_BUNDLE_ID);
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
      restageSkills: () => {},
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

describe('buildAgentUidRemap (issue #232)', () => {
  it('returns empty mapping when skipRemap is true (macOS Docker Desktop, apple-container)', () => {
    // VirtioFS handles UID translation transparently; passing
    // `--user 0:0` would break that. macOS path must be a pure no-op.
    // apple-container likewise skips the Linux renumber-and-drop.
    const remap = buildAgentUidRemap(true);
    expect(remap.user).toBeUndefined();
    expect(remap.env).toEqual({});
  });

  it('returns 0:0 + host UID/GID env on Linux Docker (skipRemap=false)', () => {
    const remap = buildAgentUidRemap(false);
    expect(remap.user).toBe('0:0');
    // The entrypoint reads these to renumber codespace before
    // dropping privileges via runuser.
    expect(remap.env.IRONCURTAIN_AGENT_UID).toBe(String(process.getuid?.() ?? 1000));
    expect(remap.env.IRONCURTAIN_AGENT_GID).toBe(String(process.getgid?.() ?? 1000));
  });
});

describe('canRefreshOAuth', () => {
  it('is false for an empty refresh token (externally-managed Codex tokens)', () => {
    expect(canRefreshOAuth('')).toBe(false);
  });

  it('is true for a non-empty refresh token', () => {
    expect(canRefreshOAuth('codex-refresh-token')).toBe(true);
  });
});

describe('resolveRealKey', () => {
  // Minimal config: only the userConfig key fields resolveRealKey reads.
  function configWithKeys(keys: Partial<IronCurtainConfig['userConfig']>): IronCurtainConfig {
    return { userConfig: { ...keys } } as unknown as IronCurtainConfig;
  }

  it('returns the OAuth access token for Codex ChatGPT hosts when a token is provided', () => {
    const config = configWithKeys({});
    expect(resolveRealKey('chatgpt.com', config, 'oauth-access-token')).toBe('oauth-access-token');
    expect(resolveRealKey('auth.openai.com', config, 'oauth-access-token')).toBe('oauth-access-token');
  });

  it('returns the OAuth access token for Anthropic hosts when a token is provided', () => {
    const config = configWithKeys({ anthropicApiKey: 'sk-ant-api03-configured' });
    expect(resolveRealKey('api.anthropic.com', config, 'oauth-access-token')).toBe('oauth-access-token');
    expect(resolveRealKey('platform.claude.com', config, 'oauth-access-token')).toBe('oauth-access-token');
  });

  it('returns empty string for Codex ChatGPT hosts when no OAuth token is provided', () => {
    // Without OAuth, Codex hosts have no API-key fallback — the MITM proxy
    // would have nothing to swap in, which is the intended "OAuth required"
    // posture for Codex.
    const config = configWithKeys({});
    expect(resolveRealKey('chatgpt.com', config, undefined)).toBe('');
    expect(resolveRealKey('auth.openai.com', config, undefined)).toBe('');
  });

  it('falls back to the configured API key for Anthropic hosts when no OAuth token', () => {
    const config = configWithKeys({ anthropicApiKey: 'sk-ant-api03-configured' });
    expect(resolveRealKey('api.anthropic.com', config, undefined)).toBe('sk-ant-api03-configured');
  });

  // --- OpenRouter (G4 / §7.5) ---

  /** Config stamped with an openrouter-type active profile carrying `apiKey`. */
  function configWithOpenrouterProfile(apiKey: string): IronCurtainConfig {
    return {
      userConfig: {},
      activeProviderProfile: {
        type: 'openrouter',
        apiKey,
        modelMap: [],
        usesDefaultMap: false,
        perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
        providerPreference: undefined,
        sessionAffinity: true,
      },
    } as unknown as IronCurtainConfig;
  }

  it('returns the stamped active profile apiKey for openrouter.ai', () => {
    const config = configWithOpenrouterProfile('sk-or-v1-realkey');
    expect(resolveRealKey('openrouter.ai', config, undefined)).toBe('sk-or-v1-realkey');
  });

  it('never returns an OAuth token for openrouter.ai (static bearer key only)', () => {
    // openrouter.ai is in neither ANTHROPIC_HOSTS nor CODEX_CHATGPT_HOSTS, so
    // even a provided OAuth token is ignored — the profile key wins. This is
    // the observable proof that no OAuth token manager is attached (§7.5).
    const config = configWithOpenrouterProfile('sk-or-v1-realkey');
    expect(resolveRealKey('openrouter.ai', config, 'oauth-access-token')).toBe('sk-or-v1-realkey');
  });

  it('returns empty string for openrouter.ai when the active profile is native', () => {
    const config = { userConfig: {}, activeProviderProfile: { type: 'native' } } as unknown as IronCurtainConfig;
    expect(resolveRealKey('openrouter.ai', config, undefined)).toBe('');
  });

  it('returns empty string for openrouter.ai when no active profile is stamped', () => {
    const config = configWithKeys({});
    expect(resolveRealKey('openrouter.ai', config, undefined)).toBe('');
  });
});

describe('OpenRouter ProviderKeyMapping assembly (G4 / §7.5, §9.5)', () => {
  /** Minimal openrouter-type resolved profile with the given key. */
  function openrouterProfile(apiKey: string): ResolvedProviderProfile {
    return {
      type: 'openrouter',
      apiKey,
      modelMap: [],
      usesDefaultMap: false,
      perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
      providerPreference: undefined,
      sessionAffinity: true,
    };
  }

  /** Config carrying only the fields the assembly logic reads. */
  function stampedConfig(profile: ResolvedProviderProfile): IronCurtainConfig {
    return { userConfig: {}, activeProviderProfile: profile } as unknown as IronCurtainConfig;
  }

  it('assembles a fake/real ProviderKeyMapping for openrouter.ai with distinct keys', () => {
    // Mirrors the per-provider loop in prepareDockerInfrastructure: the
    // openrouterProvider's fakeKeyPrefix seeds a structurally-valid fake key,
    // and resolveRealKey supplies the real key off the stamped profile.
    const rewriter = makeOpenRouterRewriter({
      modelMap: [],
      perAgentDefault: undefined,
      providerPreference: undefined,
      sessionAffinity: true,
    });
    const provider = makeOpenRouterProvider('messages', rewriter);
    expect(provider.host).toBe('openrouter.ai');
    expect(provider.fakeKeyPrefix).toBe('sk-or-v1-ironcurtain-');

    const fakeKey = generateFakeKey(provider.fakeKeyPrefix);
    expect(fakeKey.startsWith('sk-or-v1-ironcurtain-')).toBe(true);

    const config = stampedConfig(openrouterProfile('sk-or-v1-realkey'));
    const realKey = resolveRealKey(provider.host, config, undefined);
    expect(realKey).toBe('sk-or-v1-realkey');
    expect(fakeKey).not.toBe(realKey);
  });

  it('leaves openrouter.ai unmanaged by OAuth (no token manager) — real key ignores an OAuth token', () => {
    // isManagedOAuthHost is ANTHROPIC_HOSTS ∪ (codex ∧ CODEX_CHATGPT_HOSTS);
    // openrouter.ai matches neither, so no token manager is ever attached and
    // resolveRealKey never substitutes an OAuth token for the profile key.
    const config = stampedConfig(openrouterProfile('sk-or-v1-realkey'));
    expect(resolveRealKey('openrouter.ai', config, 'oauth-access-token')).toBe('sk-or-v1-realkey');
  });

  it('resolves the active profile from a providerProfileName (G1 resolver, used by infra prep)', () => {
    const modelProviders = {
      default: 'native',
      profiles: {
        native: { type: 'native' as const },
        glm: openrouterProfile('sk-or-v1-realkey'),
        kimi: openrouterProfile(''),
      },
    };
    expect(resolveActiveProfile(modelProviders, 'glm')).toEqual(openrouterProfile('sk-or-v1-realkey'));
    expect(resolveActiveProfile(modelProviders, undefined)).toEqual({ type: 'native' });
  });

  it('throws listing available profiles for an unknown providerProfileName (before container launch)', () => {
    const modelProviders = {
      default: 'native',
      profiles: {
        native: { type: 'native' as const },
        glm: openrouterProfile('sk-or-v1-realkey'),
        kimi: openrouterProfile(''),
      },
    };
    expect(() => resolveActiveProfile(modelProviders, 'does-not-exist')).toThrow(
      'Unknown provider profile "does-not-exist". Available: native, glm, kimi.',
    );
  });

  it('fails fast before container launch when an openrouter profile has an empty resolved apiKey (§9.5)', async () => {
    // The bundle-level belt-and-suspenders guard in prepareDockerInfrastructure
    // resolves + stamps the active profile FIRST, then throws when the active
    // profile is openrouter-type with an empty apiKey — before any container is
    // launched. Reaching the guard in-process requires only that the container-
    // runtime probe is short-circuited (env override) and the requested agent
    // registers; the guard runs before any Docker/CA/proxy work.
    const prev = process.env.IRONCURTAIN_CONTAINER_RUNTIME;
    process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'docker';
    try {
      const config = {
        // Minimal userConfig: only the fields the pre-guard path reads. The
        // adapter factories read agentModelId/gooseProvider/gooseModel (all
        // optional); resolveRuntimeKind is short-circuited by the env override.
        userConfig: {
          modelProviders: {
            default: 'glm',
            profiles: {
              native: { type: 'native' },
              glm: openrouterProfile(''),
            },
          },
        },
        auditLogPath: join(tmpdir(), 'audit.jsonl'),
      } as unknown as IronCurtainConfig;

      await expect(
        prepareDockerInfrastructure(
          config,
          { kind: 'docker', agent: 'claude-code' as AgentId },
          mkdtempSync(join(tmpdir(), 'or-bundle-')),
          mkdtempSync(join(tmpdir(), 'or-ws-')),
          mkdtempSync(join(tmpdir(), 'or-esc-')),
          'or-fail-fast' as BundleId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'glm',
        ),
      ).rejects.toThrow(
        'Provider profile "glm" is OpenRouter but no API key is configured. ' +
          "Set OPENROUTER_API_KEY or the profile's apiKey in ~/.ironcurtain/config.json.",
      );
    } finally {
      if (prev === undefined) delete process.env.IRONCURTAIN_CONTAINER_RUNTIME;
      else process.env.IRONCURTAIN_CONTAINER_RUNTIME = prev;
    }
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

  it('deletes auth.json on every run (Codex defense-in-depth)', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'codex-state',
      containerMountPath: '/home/codespace/.codex/',
      seed: [],
      resumeFlags: [],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    // Simulate a stale fake-token auth.json left by a prior container start.
    writeFileSync(join(stateDir, 'auth.json'), '{"auth_mode":"chatgptAuthTokens","tokens":{}}');
    expect(existsSync(join(stateDir, 'auth.json'))).toBe(true);

    // Second run should scrub it so no stale credential lingers across resumes.
    prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, 'auth.json'))).toBe(false);
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
// with a mock ContainerRuntime to verify:
//   - the main container's mount configuration (security: only sockets subdir
//     in UDS mode, never the full session dir with escalation/audit files)
//   - rollback semantics when a downstream step (connectivity check) fails
//     after the main container has already been created and started

/** Overrides accepted by the test-local makeMockDocker wrapper. */
type MockDockerOverrides = Pick<CreateMockDockerOptions, 'exec' | 'create'>;

/**
 * Thin wrapper around the shared createMockDocker that bundles a
 * DockerCallTracker for test assertions. The shared helper returns just
 * the ContainerRuntime; this wrapper flattens the tracker into the same
 * return shape the tests already use.
 */
function makeMockDocker(overrides: MockDockerOverrides = {}): { docker: ContainerRuntime } & DockerCallTracker {
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
      // null/null = "no flag emitted" — avoids the clamp helper having to
      // probe real host resources in unit tests.
      dockerResources: { memoryMb: null, cpus: null },
    },
  } as unknown as IronCurtainConfig;
}

/** Options for configuring the mock PreContainerInfrastructure. */
interface MockCoreOptions {
  readonly tempDir: string;
  readonly useTcp: boolean;
  readonly docker: ContainerRuntime;
  readonly adapter?: AgentAdapter;
  /** Defaults to 'tcp-sidecar' when useTcp, else 'uds'. */
  readonly topology?: PreContainerInfrastructure['topology'];
  readonly hostOnlyNetwork?: PreContainerInfrastructure['hostOnlyNetwork'];
  /** Defaults to 'apple-container' for tcp-hostonly, 'docker' otherwise. */
  readonly runtimeKind?: PreContainerInfrastructure['runtimeKind'];
}

/**
 * Builds a PreContainerInfrastructure rooted at `tempDir`, with on-disk
 * session/sandbox/sockets/orientation directories so the real
 * `writeFileSync(orientationDir, ...)` call inside createSessionContainers
 * actually works.
 */
function makeMockCore(opts: MockCoreOptions): PreContainerInfrastructure {
  const bundleId = TEST_BUNDLE_ID;
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
    runtimeKind: opts.runtimeKind ?? (opts.topology === 'tcp-hostonly' ? 'apple-container' : 'docker'),
    topology: opts.topology ?? (opts.useTcp ? 'tcp-sidecar' : 'uds'),
    useTcp: opts.useTcp,
    hostOnlyNetwork: opts.hostOnlyNetwork,
    socketsDir,
    mitmAddr,
    authKind: 'apikey',
    setTokenSessionId: () => {},
    restageSkills: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
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

    // Issue #232: Linux UDS mode runs the container as 0:0 and passes
    // the host UID/GID via env so the entrypoint can renumber codespace.
    expect(createCalls[0].user).toBe('0:0');
    expect(createCalls[0].env.IRONCURTAIN_AGENT_UID).toBe(String(process.getuid?.() ?? 1000));
    expect(createCalls[0].env.IRONCURTAIN_AGENT_GID).toBe(String(process.getgid?.() ?? 1000));

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

  it('uds/apple-container: mounts each proxy socket file, --network none, no UID remap', async () => {
    // apple-container's virtiofs directory shares do not carry sockets;
    // each socket is mounted per-file so the runtime creates a vsock relay.
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, runtimeKind: 'apple-container', docker });

    const result = await createSessionContainers(core, makeMockConfig());

    expect(result.sidecarContainerId).toBeUndefined();
    expect(result.internalNetwork).toBeUndefined();
    expect(createCalls).toHaveLength(1);

    const main = createCalls[0];
    expect(main.network).toBe('none');
    expect(main.env.HTTPS_PROXY).toBe('http://127.0.0.1:18080');
    // No Linux UID remap on apple-container.
    expect(main.user).toBeUndefined();
    expect(main.env.IRONCURTAIN_AGENT_UID).toBeUndefined();

    // Per-file socket mounts (NOT the sockets directory).
    const mounts = main.mounts;
    expect(mounts.some((m) => m.source === core.socketsDir)).toBe(false);
    const proxyMount = mounts.find((m) => m.target === '/run/ironcurtain/proxy.sock');
    const mitmMount = mounts.find((m) => m.target === '/run/ironcurtain/mitm-proxy.sock');
    expect(proxyMount?.source).toBe(join(core.socketsDir, 'proxy.sock'));
    expect(mitmMount?.source).toBe(join(core.socketsDir, 'mitm-proxy.sock'));

    // apt config is written via exec (nested-source virtiofs quirk), not
    // bind-mounted.
    expect(mounts.some((m) => m.target === '/etc/apt/apt.conf.d/90-ironcurtain-proxy')).toBe(false);
    // Security invariant carries over: bundle/escalation/audit never mounted.
    expect(mounts.some((m) => m.source === core.bundleDir)).toBe(false);
    expect(mounts.some((m) => m.source === core.escalationDir)).toBe(false);
  });

  // --- Skills mount tests ---
  async function runSkillsMountScenario(opts: {
    skillsMount?: { hostDir: string; target: string };
  }): Promise<readonly { source: string; target: string; readonly: boolean }[]> {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });
    const coreWithSkills: PreContainerInfrastructure = opts.skillsMount
      ? { ...core, skillsMount: opts.skillsMount }
      : core;
    await createSessionContainers(coreWithSkills, makeMockConfig());
    expect(createCalls).toHaveLength(1);
    return createCalls[0].mounts;
  }

  it('mounts the staged skills directory read-only when skillsMount is set', async () => {
    // The architectural invariant: a separate read-only bind mount from
    // the bundle's staging dir to the adapter-declared container path.
    const skillsDir = join(tempDir, 'session', 'skills');
    mkdirSync(skillsDir, { recursive: true });

    const mounts = await runSkillsMountScenario({
      skillsMount: { hostDir: skillsDir, target: TEST_SKILLS_CONTAINER_PATH },
    });

    const skillsMount = mounts.find((m) => m.target === TEST_SKILLS_CONTAINER_PATH);
    expect(skillsMount).toBeDefined();
    expect(skillsMount!.source).toBe(skillsDir);
    expect(skillsMount!.readonly).toBe(true);
  });

  it('omits the skills mount entirely when core.skillsMount is undefined', async () => {
    const mounts = await runSkillsMountScenario({});
    expect(mounts.some((m) => m.target === TEST_SKILLS_CONTAINER_PATH)).toBe(false);
  });

  it('mounts workflow scripts read-only when scriptsMount is set', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });
    const scriptsDir = join(tempDir, 'workflow-scripts');
    mkdirSync(scriptsDir, { recursive: true });

    await createSessionContainers(
      { ...core, scriptsMount: { hostDir: scriptsDir, target: '/workflow-scripts' } },
      makeMockConfig(),
    );

    expect(createCalls).toHaveLength(1);
    const scriptsMount = createCalls[0].mounts.find((m) => m.target === '/workflow-scripts');
    expect(scriptsMount).toEqual({ source: scriptsDir, target: '/workflow-scripts', readonly: true });
  });

  it('uses the stock agent image while mounting workflow dependency caches', async () => {
    const { docker, createCalls } = makeMockDocker();
    const core = makeMockCore({ tempDir, useTcp: false, docker });
    const pythonVenvDir = join(tempDir, 'workflow-deps', 'python-venv');
    const nodeModulesDir = join(tempDir, 'workflow-deps', 'node_modules');
    mkdirSync(pythonVenvDir, { recursive: true });
    mkdirSync(nodeModulesDir, { recursive: true });

    await createSessionContainers(
      {
        ...core,
        workflowPythonVenvMount: {
          hostDir: pythonVenvDir,
          target: '/opt/workflow-venv',
          cacheKey: 'abc123',
        },
        workflowNodeModulesMount: {
          hostDir: nodeModulesDir,
          target: '/opt/workflow-node_modules',
          cacheKey: 'abc123',
          hasPackageLock: false,
        },
      },
      makeMockConfig(),
    );

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].image).toBe('ironcurtain-claude-code:latest');
    expect(createCalls[0].image).not.toMatch(/^ironcurtain-wf-/);
    expect(createCalls[0].mounts).toEqual(
      expect.arrayContaining([
        { source: pythonVenvDir, target: '/opt/workflow-venv', readonly: false },
        { source: nodeModulesDir, target: '/opt/workflow-node_modules', readonly: false },
      ]),
    );
    // PATH must NOT be overridden: Docker `-e PATH=...` REPLACES (not appends)
    // the image PATH, which would discard the base image's real PATH (e.g. the
    // NVM node dir on the x86 devcontainer base). The workflow venv bin is
    // prepended to the live $PATH at exec time instead (buildWorkflowExecCommand).
    expect(createCalls[0].env.PATH).toBeUndefined();
    expect(createCalls[0].env.NODE_PATH).toBe('/opt/workflow-node_modules');
  });

  // --- UID remap (issue #232) ---
  it('does NOT pass --user 0:0 or UID env in TCP (macOS) mode', async () => {
    // On macOS, VirtioFS handles UID translation and `--user 0:0` would
    // break it; the agent container must run as the baked codespace user.
    // We construct a TCP-mode core but bypass the connectivity check by
    // returning exitCode 0 from the mocked exec.
    const { docker, createCalls } = makeMockDocker({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, docker });
    await createSessionContainers(core, makeMockConfig());

    // Two creates in TCP mode: [0] sidecar, [1] main container.
    expect(createCalls).toHaveLength(2);
    const mainCreate = createCalls[1];
    expect(mainCreate.user).toBeUndefined();
    expect(mainCreate.env.IRONCURTAIN_AGENT_UID).toBeUndefined();
    expect(mainCreate.env.IRONCURTAIN_AGENT_GID).toBeUndefined();
  });

  it('mounts an empty skills directory when set (workflow-mode invariant)', async () => {
    // Workflow-mode bundles always create the skills dir at container
    // start so per-state persona transitions can re-stage into it later
    // (the bind mount is established once and cannot be added post-hoc).
    // An empty initial dir must still produce a mount.
    const skillsDir = join(tempDir, 'session', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    // No skill subdirs written — dir is empty.

    const mounts = await runSkillsMountScenario({
      skillsMount: { hostDir: skillsDir, target: TEST_SKILLS_CONTAINER_PATH },
    });

    const skillsMount = mounts.find((m) => m.target === TEST_SKILLS_CONTAINER_PATH);
    expect(skillsMount).toBeDefined();
    expect(skillsMount!.source).toBe(skillsDir);
    expect(skillsMount!.readonly).toBe(true);
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
    const expectedNetworkName = getInternalNetworkName(TEST_SHORT_ID);
    expect(removedNetworks).toContain(expectedNetworkName);
  });

  // --- tcp-hostonly topology (apple-container) ---

  const HOST_ONLY = { name: 'ironcurtain-hostonly-net', subnet: '192.168.205.0/24', gateway: '192.168.205.1' };

  /** exec mock: proxy reachable at the gateway, egress probe blocked. */
  const healthyHostOnlyExec = async (
    _container: string,
    cmd: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const target = cmd.join(' ');
    if (target.includes('1.1.1.1')) return { exitCode: 1, stdout: '', stderr: 'Connection timed out' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  it('hostonly: attaches the main container to the host-only network with no sidecar', async () => {
    const { docker, createCalls, createdNetworks } = makeMockDocker({ exec: healthyHostOnlyExec });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    const result = await createSessionContainers(core, makeMockConfig());

    // Exactly one create: the main container. No socat sidecar.
    expect(createCalls).toHaveLength(1);
    const main = createCalls[0];
    expect(main.network).toBe(HOST_ONLY.name);
    expect(main.extraHosts).toBeUndefined();
    // Proxy env points at the vmnet gateway, not host.docker.internal.
    expect(main.env.HTTPS_PROXY).toBe(`http://${HOST_ONLY.gateway}:8443`);
    expect(main.env.HTTP_PROXY).toBe(`http://${HOST_ONLY.gateway}:8443`);
    // No single-file bind mounts: apple container virtiofs shares
    // directories only, so the apt proxy config is written via exec.
    expect(main.mounts.every((m) => !m.target.startsWith('/etc/apt/'))).toBe(true);

    expect(result.sidecarContainerId).toBeUndefined();
    // The prepare-phase network is reported as internalNetwork so the
    // standard teardown paths remove it.
    expect(result.internalNetwork).toBe(HOST_ONLY.name);
    // The network is created during the prepare phase, never here.
    expect(createdNetworks).toHaveLength(0);
  });

  it('hostonly: writes the apt proxy config via exec, then probes gateway reachability and egress', async () => {
    const execTargets: string[] = [];
    const { docker } = makeMockDocker({
      exec: async (container, cmd) => {
        execTargets.push(cmd.join(' '));
        return healthyHostOnlyExec(container, cmd);
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    await createSessionContainers(core, makeMockConfig());

    const aptWrite = execTargets.find((t) => t.includes('/etc/apt/apt.conf.d/90-ironcurtain-proxy'));
    expect(aptWrite).toBeDefined();
    expect(aptWrite).toContain(`http://${HOST_ONLY.gateway}:8443`);
    expect(execTargets.some((t) => t.includes(`TCP:${HOST_ONLY.gateway}:9123`))).toBe(true);
    expect(execTargets.some((t) => t.includes('TCP:1.1.1.1:443'))).toBe(true);
  });

  it('hostonly: aborts and cleans up when the gateway proxies are unreachable', async () => {
    const { docker, stoppedContainers, removedContainers, removedNetworks } = makeMockDocker({
      async exec(_container, cmd) {
        // Fail the socat connectivity probes; let the apt config write pass.
        if (cmd.some((c) => c.startsWith('TCP:'))) {
          return { exitCode: 1, stdout: '', stderr: 'Connection refused' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(
      /cannot reach host-side proxies at gateway/,
    );

    expect(stoppedContainers).toContain('container-1');
    expect(removedContainers).toContain('container-1');
    expect(removedNetworks).toContain(HOST_ONLY.name);
  });

  it('hostonly: aborts and cleans up when internet egress is NOT blocked', async () => {
    // Every probe succeeds — including the egress probe, meaning the
    // "host-only" network can reach the internet. Must fail closed.
    const { docker, removedContainers, removedNetworks } = makeMockDocker({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', hostOnlyNetwork: HOST_ONLY, docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(/egress check failed/);

    expect(removedContainers).toContain('container-1');
    expect(removedNetworks).toContain(HOST_ONLY.name);
  });

  it('hostonly: throws when the bundle is missing its host-only network', async () => {
    const { docker, createCalls } = makeMockDocker({ exec: healthyHostOnlyExec });
    const core = makeMockCore({ tempDir, useTcp: true, topology: 'tcp-hostonly', docker });

    await expect(createSessionContainers(core, makeMockConfig())).rejects.toThrow(
      /missing its host-only network or proxy ports/,
    );
    expect(createCalls).toHaveLength(0);
  });
});

// --- destroyDockerInfrastructure tests ---
//
// These tests exercise the teardown counterpart to createDockerInfrastructure().
// They drive a scripted DockerInfrastructure bundle with a mock ContainerRuntime
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
  readonly docker: ContainerRuntime;
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
          internalNetwork: getInternalNetworkName(TEST_SHORT_ID),
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

    const expectedNetworkName = getInternalNetworkName(TEST_SHORT_ID);
    expect(infra.internalNetwork).toBe(expectedNetworkName);
    expect(removedNetworks).toEqual([expectedNetworkName]);
  });

  it('continues with remaining steps when the main container stop throws', async () => {
    // Force docker.stop() to throw. cleanupContainers() catches per-resource
    // failures internally, so downstream proxy stops should still run.
    const stoppedContainers: string[] = [];
    const removedContainers: string[] = [];
    const docker: ContainerRuntime = {
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

// ---------------------------------------------------------------------------
// Per-workflow runtime dependency cache hashing
// ---------------------------------------------------------------------------

describe('computeWorkflowDependencyHash', () => {
  let scriptsDir: string;

  beforeEach(() => {
    scriptsDir = mkdtempSync(join(tmpdir(), 'wf-image-hash-'));
  });

  afterEach(() => {
    rmSync(scriptsDir, { recursive: true, force: true });
  });

  it('produces the same hash for the same agent hash and identical manifests', () => {
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==1.26.0\n');
    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^8" } }\n');

    const first = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);
    const second = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(first).toBe(second);
    // sha256 hex digest
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the hash when requirements.txt content changes', () => {
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==1.26.0\n');
    const before = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==2.0.0\n');
    const after = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(after).not.toBe(before);
  });

  it('changes the hash when package.json content changes', () => {
    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^8" } }\n');
    const before = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^9" } }\n');
    const after = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(after).not.toBe(before);
  });

  it('changes the hash when the parent agent hash changes (parent chaining)', () => {
    writeFileSync(join(scriptsDir, 'requirements.txt'), 'numpy==1.26.0\n');

    const withAgentA = computeWorkflowDependencyHash('agent-hash-A', scriptsDir);
    const withAgentB = computeWorkflowDependencyHash('agent-hash-B', scriptsDir);

    expect(withAgentA).not.toBe(withAgentB);
  });

  it('folds package-lock.json into the hash when present', () => {
    writeFileSync(join(scriptsDir, 'package.json'), '{ "dependencies": { "ajv": "^8" } }\n');
    const withoutLock = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    writeFileSync(join(scriptsDir, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
    const withLock = computeWorkflowDependencyHash('agent-hash-abc', scriptsDir);

    expect(withLock).not.toBe(withoutLock);
  });
});

// Runtime workflow dependencies are installed into mounted caches at container
// start (see provisionWorkflowDependencies); no per-workflow image is ever
// built. `ensureImage` only ever materializes the shared agent image (and its
// base), never an `ironcurtain-wf-*` tag.
describe('ensureImage builds no per-workflow image', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ensure-image-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // The mock Docker stamps build labels per tag; capture every built tag so we
  // can assert no per-workflow image tag (`ironcurtain-wf-*`) is produced.
  function trackBuiltTags(docker: ContainerRuntime): string[] {
    const built: string[] = [];
    const original = docker.buildImage.bind(docker);
    docker.buildImage = async (tag, df, ctx, labels) => {
      built.push(tag);
      return original(tag, df, ctx, labels);
    };
    return built;
  }

  it('returns the shared agent image and builds only the agent + base images', async () => {
    const docker = createMockDocker();
    const ca = createMockCA(tempDir);
    const built = trackBuiltTags(docker);

    const buildHash = await ensureImage('ironcurtain-claude-code:latest', docker, ca);

    expect(typeof buildHash).toBe('string');
    expect(buildHash.length).toBeGreaterThan(0);
    expect(built).toContain('ironcurtain-claude-code:latest');
    expect(built.some((tag) => tag.startsWith('ironcurtain-wf-'))).toBe(false);
  });

  it('skips the rebuild when images are already up to date (content-hash labels)', async () => {
    const docker = createMockDocker();
    const ca = createMockCA(tempDir);

    // First call builds; second call must be a no-op (labels already stamped).
    await ensureImage('ironcurtain-claude-code:latest', docker, ca);
    const built = trackBuiltTags(docker);
    await ensureImage('ironcurtain-claude-code:latest', docker, ca);

    expect(built).toEqual([]);
  });
});

describe('buildWorkflowExecCommand', () => {
  const pythonMount = { hostDir: '/host/venv', target: '/opt/workflow-venv', cacheKey: 'abc' } as const;
  const nodeMount = {
    hostDir: '/host/node_modules',
    target: '/opt/workflow-node_modules',
    cacheKey: 'abc',
    hasPackageLock: false,
  } as const;

  it('returns the command unchanged when no dependency mount is present', () => {
    const cmd = ['node', '/workflow-scripts/format_report.js'];
    expect(buildWorkflowExecCommand({}, cmd)).toEqual(cmd);
  });

  it('prepends the live $PATH (not a replacement) so the image PATH is preserved', () => {
    const wrapped = buildWorkflowExecCommand({ workflowPythonVenvMount: pythonMount }, [
      'node',
      '/workflow-scripts/format_report.js',
    ]);

    // Shell wrapper expands $PATH at runtime rather than hardcoding a PATH.
    expect(wrapped[0]).toBe('/bin/sh');
    expect(wrapped[1]).toBe('-lc');
    expect(wrapped[2]).toContain('export PATH=/opt/workflow-venv/bin:"$PATH"');
    expect(wrapped[2]).toContain('exec "$@"');
    // Original argv is passed verbatim as positional params after the `sh` $0.
    expect(wrapped.slice(3)).toEqual(['sh', 'node', '/workflow-scripts/format_report.js']);
  });

  it('prepends both the venv bin and the node_modules/.bin when both mounts exist', () => {
    const wrapped = buildWorkflowExecCommand(
      { workflowPythonVenvMount: pythonMount, workflowNodeModulesMount: nodeMount },
      ['python', '-c', 'print(1)'],
    );
    expect(wrapped[2]).toContain('export PATH=/opt/workflow-venv/bin:/opt/workflow-node_modules/.bin:"$PATH"');
    expect(wrapped.slice(3)).toEqual(['sh', 'python', '-c', 'print(1)']);
  });

  it('returns an empty command unchanged (no shell wrapper)', () => {
    expect(buildWorkflowExecCommand({ workflowPythonVenvMount: pythonMount }, [])).toEqual([]);
  });
});
