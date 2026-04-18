/**
 * Shared Docker session infrastructure setup.
 *
 * Extracts the common setup steps (session dirs, proxies, orientation,
 * CA, fake keys, image) used by both the standard DockerAgentSession
 * and the PTY session module.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { quote } from 'shell-quote';
import type { IronCurtainConfig } from '../config/types.js';
import type { SessionMode } from '../session/types.js';
import { CONTAINER_WORKSPACE_DIR, type AgentAdapter, type ConversationStateConfig } from './agent-adapter.js';
import type { DockerProxy } from './code-mode-proxy.js';
import type { MitmProxy } from './mitm-proxy.js';
import type { CertificateAuthority } from './ca.js';
import type { DockerManager } from './types.js';
import type { ProviderKeyMapping } from './mitm-proxy.js';
import type { TokenStreamBus } from './token-stream-bus.js';
import { parseUpstreamBaseUrl, type ProviderConfig, type UpstreamTarget } from './provider-config.js';
import { getInternalNetworkName } from './platform.js';
import { cleanupContainers } from './container-lifecycle.js';
import { errorMessage } from '../utils/error-message.js';
import * as logger from '../logger.js';

/**
 * Shared infrastructure bundle produced by the pre-container setup phase.
 *
 * `prepareDockerInfrastructure()` returns this shape: proxies, CA, fake keys,
 * orientation, image — everything the container needs, but not the container
 * itself. PTY sessions use this because they build their own containers
 * with TTY-specific settings. Standalone Docker sessions go through
 * `createDockerInfrastructure()` instead, which extends this with a
 * running container.
 */
export interface PreContainerInfrastructure {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
  /**
   * Audit log path, populated by `prepareDockerInfrastructure()` from
   * `config.auditLogPath`. Kept on the bundle so consumers like
   * `AuditLogTailer` can read it without chasing the config reference;
   * the single source of truth remains `config.auditLogPath`.
   */
  readonly auditLogPath: string;
  readonly proxy: DockerProxy;
  readonly mitmProxy: MitmProxy;
  readonly docker: DockerManager;
  readonly adapter: AgentAdapter;
  readonly ca: CertificateAuthority;
  readonly fakeKeys: Map<string, string>;
  readonly orientationDir: string;
  readonly systemPrompt: string;
  readonly image: string;
  readonly useTcp: boolean;
  readonly socketsDir: string;
  /** MITM proxy listen address (port for TCP mode, socketPath for UDS mode). */
  readonly mitmAddr: { socketPath?: string; port?: number };
  /** Authentication method used for this session ('oauth' or 'apikey'). */
  readonly authKind: 'oauth' | 'apikey';
  /** Host-side conversation state directory, if the adapter supports resume. */
  readonly conversationStateDir?: string;
  /** Conversation state config from the adapter, if resume is supported. */
  readonly conversationStateConfig?: ConversationStateConfig;
}

/**
 * Full Docker session infrastructure, including a running main container.
 *
 * Produced by `createDockerInfrastructure()` and consumed by
 * `DockerAgentSession`. The container is already created and started with
 * a `sleep infinity` entrypoint; the session drives it via `docker exec`.
 * In TCP mode (macOS), `sidecarContainerId` and `internalNetwork` point to
 * the socat sidecar and the per-session `--internal` bridge network.
 */
export interface DockerInfrastructure extends PreContainerInfrastructure {
  /** Main agent container ID (created + started with `sleep infinity` entrypoint). */
  readonly containerId: string;
  /** Deterministic main container name (e.g., `ironcurtain-<shortId>`). */
  readonly containerName: string;
  /** Socat sidecar container ID (TCP mode only, macOS). */
  readonly sidecarContainerId?: string;
  /** Per-session `--internal` Docker network name (TCP mode only, macOS). */
  readonly internalNetwork?: string;
}

/** Hosts that use Anthropic OAuth credentials when available. */
const ANTHROPIC_HOSTS = new Set(['api.anthropic.com', 'platform.claude.com']);

/** Prefix for container/sidecar names. Keep in sync with `docker ps` filters. */
const CONTAINER_NAME_PREFIX = 'ironcurtain-';

/** Host gateway alias used by Docker containers on macOS/Windows. */
const DOCKER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Prepares the shared (non-container) parts of Docker session infrastructure.
 *
 * Sets up proxies (Code Mode + MITM), CA, fake keys, orientation files, and
 * ensures the agent image. Does NOT create the agent container — that step is
 * specific to the session mode: standalone sessions go through
 * `createDockerInfrastructure()` (which wraps this with `sleep infinity`
 * container creation); PTY sessions call this directly and then create their
 * own TTY-enabled container.
 */
export async function prepareDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  sessionDir: string,
  sandboxDir: string,
  escalationDir: string,
  sessionId: string,
  tokenStreamBus?: TokenStreamBus,
): Promise<PreContainerInfrastructure> {
  // The audit log path is read from config so the bundle is
  // self-describing: downstream consumers (AuditLogTailer, sandbox
  // coordinator) can take it from either `config.auditLogPath` or
  // `infra.auditLogPath` without chasing references.
  const auditLogPath = config.auditLogPath;
  // Dynamic imports to avoid loading Docker dependencies for built-in sessions
  const { registerBuiltinAdapters, getAgent } = await import('./agent-registry.js');
  const { createCodeModeProxy } = await import('./code-mode-proxy.js');
  const { createMitmProxy } = await import('./mitm-proxy.js');
  const { loadOrCreateCA } = await import('./ca.js');
  const { generateFakeKey } = await import('./fake-keys.js');
  const { createDockerManager } = await import('./docker-manager.js');
  const { useTcpTransport } = await import('./platform.js');
  const { getIronCurtainHome } = await import('../config/paths.js');
  const { prepareSession } = await import('./orientation.js');

  const { detectAuthMethod, writeToKeychain } = await import('./oauth-credentials.js');
  const { OAuthTokenManager } = await import('./oauth-token-manager.js');

  await registerBuiltinAdapters(config.userConfig);
  const adapter = getAgent(mode.agent);
  const useTcp = useTcpTransport();

  // Detect authentication method. Adapters with detectCredential() handle
  // their own credential detection (e.g., Goose checks provider-specific keys).
  // Adapters without it fall back to detectAuthMethod() (Anthropic OAuth + API key).
  const authMethod = adapter.detectCredential ? adapter.detectCredential(config) : await detectAuthMethod(config);
  if (authMethod.kind === 'none') {
    throw new Error(
      adapter.credentialHelpText ??
        'No credentials available for Docker session. ' +
          'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.',
    );
  }
  const authKind = authMethod.kind;

  // Stamp auth kind onto the caller's session config so buildEnv() can read it.
  // Safe to mutate: callers always pass a session-specific copy.
  config.dockerAuth = { kind: authKind };

  // Derive socketsDir from the passed sessionDir rather than sessionId so
  // that resumed sessions (where sessionDir is based on effectiveSessionId)
  // place sockets in the correct directory.
  const socketsDir = resolve(sessionDir, 'sockets');
  mkdirSync(socketsDir, { recursive: true, mode: 0o700 });

  const socketPath = resolve(socketsDir, 'proxy.sock');

  const proxy = createCodeModeProxy({
    socketPath,
    config,
    listenMode: useTcp ? 'tcp' : 'uds',
  });

  // Load or generate the IronCurtain CA for TLS termination
  const caDir = resolve(getIronCurtainHome(), 'ca');
  const ca = loadOrCreateCA(caDir);

  // Generate fake keys and build provider key mappings.
  // In OAuth mode, use bearer-based providers and the OAuth access token as the real key.
  // Providers sharing the same fakeKeyPrefix (and thus the same real credential)
  // reuse the same fake key so a single container token authenticates against all hosts.
  const oauthAccessToken = authMethod.kind === 'oauth' ? authMethod.credentials.accessToken : undefined;
  const tokenManagerKeychainDeps =
    authMethod.kind === 'oauth' && authMethod.source === 'keychain'
      ? { writeToKeychain, keychainServiceName: authMethod.keychainServiceName }
      : undefined;
  const tokenManager =
    authMethod.kind === 'oauth'
      ? new OAuthTokenManager(authMethod.credentials, { canRefresh: true }, tokenManagerKeychainDeps)
      : undefined;
  const providers = adapter.getProviders(authKind);

  const resolvedProviders = applyUpstreamOverrides(providers, parseUpstreamBaseUrl, {
    'api.anthropic.com': config.userConfig.anthropicBaseUrl,
    'api.openai.com': config.userConfig.openaiBaseUrl,
    'generativelanguage.googleapis.com': config.userConfig.googleBaseUrl,
  });

  const fakeKeys = new Map<string, string>();
  const providerMappings: ProviderKeyMapping[] = [];
  const fakeKeysByPrefix = new Map<string, string>();
  for (const providerConfig of resolvedProviders) {
    let fakeKey = fakeKeysByPrefix.get(providerConfig.fakeKeyPrefix);
    if (!fakeKey) {
      fakeKey = generateFakeKey(providerConfig.fakeKeyPrefix);
      fakeKeysByPrefix.set(providerConfig.fakeKeyPrefix, fakeKey);
    }
    fakeKeys.set(providerConfig.host, fakeKey);

    const realKey = resolveRealKey(providerConfig.host, config, oauthAccessToken);
    // Attach the token manager only to Anthropic hosts (the ones using OAuth)
    const hostTokenManager = tokenManager && ANTHROPIC_HOSTS.has(providerConfig.host) ? tokenManager : undefined;
    providerMappings.push({ config: providerConfig, fakeKey, realKey, tokenManager: hostTokenManager });
  }

  // Build package installation proxy config if enabled
  const pkgConfig = config.userConfig.packageInstall;
  let registries: import('./package-types.js').RegistryConfig[] | undefined;
  let packageValidation: { validator: import('./package-types.js').PackageValidator; auditLogPath: string } | undefined;

  if (pkgConfig.enabled) {
    const { npmRegistry, pypiRegistry, debianRegistry } = await import('./registry-proxy.js');
    const { createPackageValidator } = await import('./package-validator.js');

    registries = [npmRegistry, pypiRegistry, debianRegistry];
    const validator = createPackageValidator({
      allowedPackages: pkgConfig.allowedPackages,
      deniedPackages: pkgConfig.deniedPackages,
      quarantineDays: pkgConfig.quarantineDays,
    });
    const packageAuditLogPath = resolve(sessionDir, 'package-audit.jsonl');
    packageValidation = { validator, auditLogPath: packageAuditLogPath };
  }

  const mitmProxy = useTcp
    ? createMitmProxy({
        listenPort: 0,
        ca,
        providers: providerMappings,
        registries,
        packageValidation,
        controlPort: 0,
        tokenStreamBus,
        sessionId: tokenStreamBus ? sessionId : undefined,
      })
    : createMitmProxy({
        socketPath: resolve(socketsDir, 'mitm-proxy.sock'),
        ca,
        providers: providerMappings,
        registries,
        packageValidation,
        controlSocketPath: resolve(sessionDir, 'mitm-control.sock'),
        tokenStreamBus,
        sessionId: tokenStreamBus ? sessionId : undefined,
      });

  const docker = createDockerManager();

  // Start MITM proxy FIRST so config.mitmControlAddr is set before proxy.start().
  // proxy.start() initializes the UTCP sandbox, which checks config.mitmControlAddr
  // to decide whether to register the proxy virtual MCP server for domain management.
  const mitmAddr = await mitmProxy.start();
  if (mitmAddr.port !== undefined) {
    logger.info(`MITM proxy listening on 127.0.0.1:${mitmAddr.port}`);
  } else {
    logger.info(`MITM proxy listening on ${mitmAddr.socketPath}`);
  }

  // Compute control address for the proxy tools MCP server instance
  const controlAddr =
    mitmAddr.controlPort !== undefined
      ? `http://127.0.0.1:${mitmAddr.controlPort}`
      : mitmAddr.controlSocketPath
        ? `unix://${mitmAddr.controlSocketPath}`
        : undefined;
  if (controlAddr) {
    config.mitmControlAddr = controlAddr;
    logger.info(`MITM control API at ${controlAddr}`);
  }

  // Start Code Mode proxy AFTER mitmControlAddr is set so the sandbox
  // registers the proxy virtual server for network domain management.
  await proxy.start();
  if (useTcp && proxy.port !== undefined) {
    logger.info(`Code Mode proxy listening on 127.0.0.1:${proxy.port}`);
  } else {
    logger.info(`Code Mode proxy listening on ${proxy.socketPath}`);
  }

  // Remaining setup steps can fail -- clean up started proxies on error.
  try {
    // Build orientation
    const helpData = proxy.getHelpData();
    const serverListings = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
      name,
      description,
    }));
    // The proxy virtual server won't have an entry in config.mcpServers, so its
    // description falls back to just "proxy". Add an explicit listing with a
    // proper description for the help/orientation system.
    if (config.mitmControlAddr && !serverListings.some((s) => s.name === 'proxy')) {
      serverListings.push({
        name: 'proxy',
        description: 'Network proxy domain management (add/remove/list allowed domains)',
      });
    }
    logger.info(`Available servers: ${serverListings.map((s) => s.name).join(', ')}`);

    const proxyAddress = useTcp && proxy.port !== undefined ? `${DOCKER_HOST_GATEWAY}:${proxy.port}` : undefined;
    const { systemPrompt } = prepareSession(adapter, serverListings, sessionDir, config, sandboxDir, proxyAddress);

    // Ensure Docker image is built and up-to-date
    const image = await adapter.getImage();
    await ensureImage(image, docker, ca);

    const orientationDir = resolve(sessionDir, 'orientation');

    // Set up conversation state directory if the adapter supports resume
    const conversationStateConfig = adapter.getConversationStateConfig?.();
    const conversationStateDir = conversationStateConfig
      ? prepareConversationStateDir(sessionDir, conversationStateConfig)
      : undefined;

    return {
      sessionId,
      sessionDir,
      sandboxDir,
      escalationDir,
      auditLogPath,
      proxy,
      mitmProxy,
      docker,
      adapter,
      ca,
      fakeKeys,
      orientationDir,
      systemPrompt,
      image,
      useTcp,
      socketsDir,
      mitmAddr,
      authKind,
      conversationStateDir,
      conversationStateConfig,
    };
  } catch (error) {
    // Best-effort cleanup of proxies started above
    await mitmProxy.stop().catch(() => {});
    await proxy.stop().catch(() => {});
    throw error;
  }
}

/**
 * Creates the full Docker session infrastructure, including a running
 * `sleep infinity` agent container (and, on macOS TCP mode, the socat
 * sidecar and per-session `--internal` network).
 *
 * Wraps `prepareDockerInfrastructure()` with container creation. On any
 * failure after the proxies are started, all started resources are torn
 * down before the error propagates.
 */
export async function createDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  sessionDir: string,
  sandboxDir: string,
  escalationDir: string,
  sessionId: string,
  tokenStreamBus?: TokenStreamBus,
): Promise<DockerInfrastructure> {
  const core = await prepareDockerInfrastructure(
    config,
    mode,
    sessionDir,
    sandboxDir,
    escalationDir,
    sessionId,
    tokenStreamBus,
  );

  try {
    const containerResources = await createSessionContainers(core, config);
    return { ...core, ...containerResources };
  } catch (error) {
    // Any partial container/sidecar/network cleanup happened inside
    // createSessionContainers(). Here we just tear down the proxies that
    // prepareDockerInfrastructure() started, to avoid leaking them.
    await core.mitmProxy.stop().catch(() => {});
    await core.proxy.stop().catch(() => {});
    throw error;
  }
}

/**
 * Tears down a fully-formed `DockerInfrastructure` bundle: main container,
 * TCP-mode sidecar and internal network (if present), MITM proxy, and Code
 * Mode proxy.
 *
 * Error-tolerant: each step is isolated in its own try/catch so a failure
 * in one step does not prevent subsequent steps from running. Errors are
 * logged via `logger.warn` and otherwise swallowed -- callers in
 * error-recovery paths depend on this function never throwing.
 *
 * The companion to `createDockerInfrastructure()`: anything the former
 * allocates, this function releases.
 */
export async function destroyDockerInfrastructure(infra: DockerInfrastructure): Promise<void> {
  // Ordering: stop consumers (containers) before producers (proxies).
  // Proxy connections from the container terminate cleanly when the
  // container stops; inverting would leave the proxy with in-flight
  // connections that get ECONNRESET during its own shutdown.

  // Containers + sidecar + internal network. cleanupContainers() swallows
  // per-resource failures internally, so no outer try/catch is needed here.
  await cleanupContainers(infra.docker, {
    containerId: infra.containerId,
    sidecarContainerId: infra.sidecarContainerId ?? null,
    networkName: infra.internalNetwork ?? null,
  });

  // Proxies are independent producers -- stop them in parallel. Each
  // per-promise catch logs so one failure doesn't mask the other, and
  // allSettled ensures both complete even if one throws synchronously.
  await Promise.allSettled([
    infra.mitmProxy
      .stop()
      .catch((err: unknown) =>
        logger.warn(`destroyDockerInfrastructure: mitmProxy.stop() failed: ${errorMessage(err)}`),
      ),
    infra.proxy
      .stop()
      .catch((err: unknown) => logger.warn(`destroyDockerInfrastructure: proxy.stop() failed: ${errorMessage(err)}`)),
  ]);

  // CA and fake keys are intentionally absent: neither owns any
  // process-level resources. CA material is persisted in ~/.ironcurtain/ca/
  // and reused across sessions; fake keys are just strings in a Map that
  // goes out of scope with the infrastructure bundle.

  logger.info(`Destroyed Docker infrastructure (container=${infra.containerId.substring(0, 12)})`);
}

/** Container-level resources layered on top of the pre-container bundle. */
export interface ContainerResources {
  readonly containerId: string;
  readonly containerName: string;
  readonly sidecarContainerId?: string;
  readonly internalNetwork?: string;
}

/**
 * Creates and starts the main agent container (plus TCP-mode sidecar and
 * internal network on macOS). Cleans up any partially-created resources
 * on failure so callers get all-or-nothing semantics.
 *
 * Exported for testability: tests exercise the mount/env configuration and
 * the rollback-on-failure path by passing a mock `PreContainerInfrastructure`
 * with a scripted `DockerManager`.
 */
export async function createSessionContainers(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
): Promise<ContainerResources> {
  const shortId = core.sessionId.substring(0, 12);
  const mainContainerName = `${CONTAINER_NAME_PREFIX}${shortId}`;

  // Remove stale main container from a crashed previous session (same session
  // ID means same deterministic name, which would conflict on docker create).
  // Done before the TCP/UDS branch since the main container name is
  // deterministic in both modes.
  await core.docker.removeStaleContainer(mainContainerName);

  let mainContainerId: string | undefined;
  let sidecarContainerId: string | undefined;
  let internalNetwork: string | undefined;

  try {
    // Base mounts shared by TCP and UDS modes: the sandbox as the
    // workspace and the orientation dir. Mode-specific mounts (apt proxy
    // config, sockets dir, conversation state) are appended below.
    const mounts: { source: string; target: string; readonly: boolean }[] = [
      { source: core.sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
      { source: core.orientationDir, target: '/etc/ironcurtain', readonly: true },
    ];
    let env = {
      ...core.adapter.buildEnv(config, core.fakeKeys),
    };
    let network: string | null;
    let extraHosts: string[] | undefined;

    if (core.useTcp && core.mitmAddr.port !== undefined && core.proxy.port !== undefined) {
      // macOS TCP mode: internal bridge network blocks egress.
      // A socat sidecar bridges the internal network to the host
      // because Docker Desktop VMs don't forward gateway traffic.
      const mcpPort = core.proxy.port;
      const mitmPort = core.mitmAddr.port;
      const proxyUrl = `http://${DOCKER_HOST_GATEWAY}:${mitmPort}`;

      env = {
        ...env,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      };

      // Write apt proxy config so sudo apt-get routes through the MITM proxy
      const aptProxyPath = resolve(core.orientationDir, 'apt-proxy.conf');
      writeFileSync(aptProxyPath, `Acquire::http::Proxy "${proxyUrl}";\nAcquire::https::Proxy "${proxyUrl}";\n`);
      mounts.push({ source: aptProxyPath, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true });

      // Create a per-session --internal Docker network that blocks internet egress.
      const networkName = getInternalNetworkName(shortId);
      await core.docker.createNetwork(networkName, { internal: true });
      internalNetwork = networkName;
      network = networkName;

      // Ensure the socat image is available
      const socatImage = 'alpine/socat';
      if (!(await core.docker.imageExists(socatImage))) {
        logger.info(`Pulling ${socatImage}...`);
        await core.docker.pullImage(socatImage);
      }

      // Create socat sidecar on the default bridge (can reach the host gateway)
      const sidecarName = `${CONTAINER_NAME_PREFIX}sidecar-${shortId}`;

      // Remove stale sidecar from a crashed previous session (TCP mode only).
      await core.docker.removeStaleContainer(sidecarName);

      sidecarContainerId = await core.docker.create({
        image: socatImage,
        name: sidecarName,
        network: 'bridge',
        mounts: [],
        env: {},
        entrypoint: '/bin/sh',
        sessionLabel: core.sessionId,
        command: [
          '-c',
          quote(['socat', `TCP-LISTEN:${mcpPort},fork,reuseaddr`, `TCP:${DOCKER_HOST_GATEWAY}:${mcpPort}`]) +
            ' & ' +
            quote(['socat', `TCP-LISTEN:${mitmPort},fork,reuseaddr`, `TCP:${DOCKER_HOST_GATEWAY}:${mitmPort}`]) +
            ' & wait',
        ],
      });
      await core.docker.start(sidecarContainerId);

      // Connect sidecar to the internal network so the app container can reach it
      await core.docker.connectNetwork(networkName, sidecarContainerId);
      const sidecarIp = await core.docker.getContainerIp(sidecarContainerId, networkName);
      extraHosts = [`${DOCKER_HOST_GATEWAY}:${sidecarIp}`];
      logger.info(`Sidecar ${sidecarName} bridging ports ${mcpPort},${mitmPort} at ${sidecarIp}`);
    } else {
      // Linux UDS mode: --network=none, session dir with sockets mounted
      const linuxProxyUrl = 'http://127.0.0.1:18080';
      env = {
        ...env,
        HTTPS_PROXY: linuxProxyUrl,
        HTTP_PROXY: linuxProxyUrl,
      };
      network = null;

      // Write apt proxy config so sudo apt-get routes through the MITM proxy
      const aptProxyPathLinux = resolve(core.orientationDir, 'apt-proxy.conf');
      writeFileSync(
        aptProxyPathLinux,
        `Acquire::http::Proxy "${linuxProxyUrl}";\nAcquire::https::Proxy "${linuxProxyUrl}";\n`,
      );
      mounts.push({
        source: aptProxyPathLinux,
        target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy',
        readonly: true,
      });

      // Mount only the sockets subdirectory into the container -- not the full
      // session dir. This prevents the container from accessing escalation files,
      // audit logs, or other session data. proxy.sock and mitm-proxy.sock are
      // created in this directory by the host-side proxy setup.
      mounts.push({ source: core.socketsDir, target: '/run/ironcurtain', readonly: false });
    }

    // Mount conversation state directory for session resume (e.g., claude --continue)
    if (core.conversationStateDir && core.conversationStateConfig) {
      mounts.push({
        source: core.conversationStateDir,
        target: core.conversationStateConfig.containerMountPath,
        readonly: false,
      });
    }

    mainContainerId = await core.docker.create({
      image: core.image,
      name: mainContainerName,
      network: network ?? 'none',
      mounts,
      env,
      command: ['sleep', 'infinity'],
      sessionLabel: core.sessionId,
      resources: { memoryMb: 8192, cpus: 4 },
      extraHosts,
      capAdd: [
        'SETUID', // sudo setuid
        'SETGID', // sudo setgid
        'CHOWN', // apt-get chown on installed files
        'FOWNER', // apt-get set permissions on files it doesn't own
        'DAC_OVERRIDE', // apt-get read/write files regardless of permissions during install
        'AUDIT_WRITE', // sudo audit logging
      ],
    });

    await core.docker.start(mainContainerId);
    logger.info(`Container started: ${mainContainerId.substring(0, 12)}`);

    // Connectivity check: verify the container can reach host proxies
    // through the internal network. Abort if unreachable.
    if (core.useTcp && internalNetwork !== undefined && core.proxy.port !== undefined) {
      await checkInternalNetworkConnectivity(core.docker, mainContainerId, core.proxy.port);
    }

    return {
      containerId: mainContainerId,
      containerName: mainContainerName,
      sidecarContainerId,
      internalNetwork,
    };
  } catch (err) {
    // Best-effort cleanup of any resources created before the failure.
    // All three resources are assigned as soon as `docker.create()` returns
    // (before any subsequent start or connectivity check), so failures at
    // any point inside the try block clean up whatever was created.
    await cleanupContainers(core.docker, {
      containerId: mainContainerId ?? null,
      sidecarContainerId: sidecarContainerId ?? null,
      networkName: internalNetwork ?? null,
    });
    throw err;
  }
}

/**
 * Probes whether the container can reach host-side proxies via the socat
 * sidecar on the internal Docker network. Throws a descriptive error if not.
 */
async function checkInternalNetworkConnectivity(
  docker: DockerManager,
  containerId: string,
  mcpPort: number,
): Promise<void> {
  const result = await docker.exec(
    containerId,
    ['socat', '-u', '/dev/null', `TCP:${DOCKER_HOST_GATEWAY}:${mcpPort},connect-timeout=5`],
    // Allow a small buffer above socat's 5s connect-timeout for docker exec/process startup overhead.
    6_000,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Internal network connectivity check failed (exit=${result.exitCode}). ` +
        `The container cannot reach host-side proxies via the socat sidecar on the --internal Docker network. ` +
        `Check that the sidecar container is running and connected to the internal network.`,
    );
  }
}

/**
 * Resolves the real credential for a provider host.
 *
 * For Anthropic hosts in OAuth mode, uses the OAuth access token.
 * For all other cases, falls back to the API key from config.
 */
function resolveRealKey(host: string, config: IronCurtainConfig, oauthAccessToken: string | undefined): string {
  if (oauthAccessToken && ANTHROPIC_HOSTS.has(host)) {
    return oauthAccessToken;
  }

  let key: string;
  switch (host) {
    case 'api.anthropic.com':
    case 'platform.claude.com':
      key = config.userConfig.anthropicApiKey;
      break;
    case 'api.openai.com':
      key = config.userConfig.openaiApiKey;
      break;
    case 'generativelanguage.googleapis.com':
      key = config.userConfig.googleApiKey;
      break;
    default:
      logger.warn(`No API key mapping for unknown provider host: ${host}`);
      return '';
  }
  if (!key) {
    logger.warn(`No API key configured for provider host: ${host}`);
  }
  return key;
}

/**
 * Creates and seeds the conversation state directory for agents that
 * support session resume. Idempotent: skips seeding if the directory
 * already exists (resume case).
 *
 * As a defense-in-depth measure, always deletes `.credentials.json`
 * from the state directory — the MITM proxy handles auth independently,
 * so any credentials file left by the agent is stale.
 */
export function prepareConversationStateDir(sessionDir: string, config: ConversationStateConfig): string {
  const stateDir = resolve(sessionDir, config.hostDirName);
  const isNew = !existsSync(stateDir);

  if (isNew) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    for (const entry of config.seed) {
      const content = typeof entry.content === 'function' ? entry.content() : entry.content;
      if (content === undefined) continue;

      const targetPath = resolve(stateDir, entry.path);
      // Reject paths that escape the state directory
      if (!targetPath.startsWith(stateDir + '/') && targetPath !== stateDir) {
        throw new Error(`Seed path escapes state directory: ${entry.path}`);
      }
      if (entry.path.endsWith('/') || content === '') {
        // Directory entry
        mkdirSync(targetPath, { recursive: true });
      } else {
        // File entry
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, content);
      }
    }
  }

  // Defense-in-depth: remove stale credentials on every start
  const credentialsPath = resolve(stateDir, '.credentials.json');
  try {
    unlinkSync(credentialsPath);
  } catch {
    // File doesn't exist — expected on first run
  }

  return stateDir;
}

/**
 * Ensures the agent Docker image exists and is up-to-date. Builds the base
 * image first (with the IronCurtain CA cert baked in) and then the
 * agent-specific image. Content-hash labels on each image drive staleness
 * detection so repeated calls skip rebuilds when nothing has changed.
 */
async function ensureImage(image: string, docker: DockerManager, ca: CertificateAuthority): Promise<void> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dockerDir = resolve(packageRoot, 'docker');

  // On arm64 hosts (Apple Silicon), use the lightweight arm64-native Dockerfile
  const baseDockerfile =
    arch() === 'arm64' && existsSync(resolve(dockerDir, 'Dockerfile.base.arm64'))
      ? 'Dockerfile.base.arm64'
      : 'Dockerfile.base';

  // Build base image with CA cert baked in (if stale or missing)
  const baseImage = 'ironcurtain-base:latest';
  const baseBuildHash = computeBuildHash(dockerDir, [baseDockerfile], ca.certPem);
  const baseRebuilt = await ensureBaseImage(baseImage, docker, ca, dockerDir, baseDockerfile, baseBuildHash);

  // Build the agent-specific image (if stale, missing, or base was rebuilt)
  const agentName = image.replace(CONTAINER_NAME_PREFIX, '').replace(':latest', '');
  const dockerfile = `Dockerfile.${agentName}`;
  const agentDockerfilePath = resolve(dockerDir, dockerfile);
  if (!existsSync(agentDockerfilePath)) {
    throw new Error(`Dockerfile not found for agent "${agentName}": ${agentDockerfilePath}`);
  }

  const agentBuildHash = computeBuildHash(dockerDir, [dockerfile], ca.certPem, baseBuildHash);
  const needsAgentBuild = baseRebuilt || (await isImageStale(image, docker, agentBuildHash));

  if (needsAgentBuild) {
    logger.info(`Building Docker image ${image}...`);
    await docker.buildImage(image, agentDockerfilePath, dockerDir, {
      'ironcurtain.build-hash': agentBuildHash,
    });
    logger.info(`Docker image ${image} built successfully`);
  }
}

async function ensureBaseImage(
  baseImage: string,
  docker: DockerManager,
  ca: CertificateAuthority,
  dockerDir: string,
  dockerfile: string,
  buildHash: string,
): Promise<boolean> {
  if (!(await isImageStale(baseImage, docker, buildHash))) return false;

  logger.info('Building base Docker image (this may take a while on first run)...');

  const tmpContext = mkdtempSync(resolve(tmpdir(), 'ironcurtain-build-'));
  try {
    for (const file of readdirSync(dockerDir)) {
      copyFileSync(resolve(dockerDir, file), resolve(tmpContext, file));
    }
    copyFileSync(ca.certPath, resolve(tmpContext, 'ironcurtain-ca-cert.pem'));

    await docker.buildImage(baseImage, resolve(tmpContext, dockerfile), tmpContext, {
      'ironcurtain.build-hash': buildHash,
    });
  } finally {
    rmSync(tmpContext, { recursive: true, force: true });
  }
  logger.info('Base Docker image built successfully');
  return true;
}

async function isImageStale(image: string, docker: DockerManager, expectedHash: string): Promise<boolean> {
  if (!(await docker.imageExists(image))) return true;
  const storedHash = await docker.getImageLabel(image, 'ironcurtain.build-hash');
  return storedHash !== expectedHash;
}

function computeBuildHash(dockerDir: string, dockerfiles: string[], caCertPem: string, parentHash?: string): string {
  const hash = createHash('sha256');

  const files = readdirSync(dockerDir).sort();
  for (const file of files) {
    if (dockerfiles.includes(file) || file.endsWith('.sh')) {
      hash.update(`file:${file}\n`);
      hash.update(readFileSync(resolve(dockerDir, file)));
    }
  }

  hash.update('ca-cert\n');
  hash.update(caCertPem);

  if (parentHash) {
    hash.update(`parent:${parentHash}\n`);
  }

  return hash.digest('hex');
}

/**
 * Map of provider canonical hostnames to environment variable names
 * that can override the upstream target URL. platform.claude.com is
 * intentionally excluded — platform endpoints should not be redirected.
 */
const UPSTREAM_ENV_VARS: ReadonlyMap<string, string> = new Map([
  ['api.anthropic.com', 'ANTHROPIC_BASE_URL'],
  ['api.openai.com', 'OPENAI_BASE_URL'],
  ['generativelanguage.googleapis.com', 'GOOGLE_API_BASE_URL'],
]);

/**
 * Strips credentials and query parameters from a URL string for safe logging.
 * Returns only scheme + hostname + port + pathname.
 */
function sanitizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    // Reconstruct with only safe components
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '<invalid URL>';
  }
}

/**
 * Applies upstream target overrides from environment variables to provider configs.
 *
 * For each provider whose host has a corresponding env var set, parses the URL
 * and returns a new ProviderConfig with the upstreamTarget field populated.
 * If the env var is set but invalid, falls back to configBaseUrls before
 * giving up. Providers without any valid override are returned unchanged.
 */
export function applyUpstreamOverrides(
  providers: readonly ProviderConfig[],
  parser: (baseUrl: string) => UpstreamTarget,
  configBaseUrls?: Readonly<Record<string, string>>,
): ProviderConfig[] {
  return providers.map((config) => {
    const envVar = UPSTREAM_ENV_VARS.get(config.host);
    if (!envVar) return config;

    // Try env var first, then configBaseUrls fallback
    const sources: Array<{ label: string; url: string }> = [];
    const envValue = process.env[envVar];
    if (envValue) sources.push({ label: envVar, url: envValue });
    const configUrl = configBaseUrls?.[config.host];
    if (configUrl) sources.push({ label: 'config', url: configUrl });

    for (const { label, url } of sources) {
      try {
        const upstreamTarget = parser(url);
        logger.info(`[docker] ${config.displayName}: upstream override via ${label} → ${sanitizeUrlForLog(url)}`);
        return { ...config, upstreamTarget };
      } catch (err) {
        logger.warn(
          `[docker] ${config.displayName}: ignoring invalid ${label}="${sanitizeUrlForLog(url)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return config;
  });
}
