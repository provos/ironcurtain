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
  chmodSync,
  lstatSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { quote } from 'shell-quote';
import type { IronCurtainConfig } from '../config/types.js';
import { getBundleRuntimeRoot } from '../config/paths.js';
import { getBundleShortId, type BundleId, type SessionMode } from '../session/types.js';
import { DEFAULT_CONTAINER_SCOPE, type WorkflowId } from '../workflow/types.js';
import { CONTAINER_WORKSPACE_DIR, type AgentAdapter, type ConversationStateConfig } from './agent-adapter.js';
import type { DockerProxy } from './code-mode-proxy.js';
import type { MitmProxy } from './mitm-proxy.js';
import type { CertificateAuthority } from './ca.js';
import type { DockerManager } from './types.js';
import type { ProviderKeyMapping } from './mitm-proxy.js';
import { parseUpstreamBaseUrl, type ProviderConfig, type UpstreamTarget } from './provider-config.js';
import { getInternalNetworkName } from './platform.js';
import { cleanupContainers } from './container-lifecycle.js';
import { errorMessage } from '../utils/error-message.js';
import * as logger from '../logger.js';

/**
 * Create a bundle-owned directory and enforce 0o700 permissions even if
 * it already exists. `mkdirSync`'s `mode` only applies on creation, so a
 * stale dir (crashed prior run, manual creation) could otherwise leave
 * the UDS endpoints reachable by other local users.
 *
 * Rejects symlinks at the bundle path itself: even though these dirs
 * now live under `~/.ironcurtain/run/` (not `/tmp/`), we don't want to
 * silently follow a pre-existing symlink in the user's own tree. The
 * `lstatSync` check runs BEFORE `mkdirSync` — `mkdirSync({recursive:
 * true})` follows symlinks, so checking after the create would let a
 * pre-existing symlink redirect the directory creation before we got a
 * chance to reject it.
 *
 * Ancestor components (`~/.ironcurtain/run/`, `~/.ironcurtain/`, `~/`)
 * are NOT walked — the user's home tree is our trust boundary, and an
 * attacker who can rewrite `~/.ironcurtain/` already controls the CA
 * and the OAuth credentials we store there. Defending against that
 * within this helper would be theater.
 */
export function ensureSecureBundleDir(path: string): void {
  // Validate any pre-existing entry at `path` before creating so a
  // planted symlink can't redirect our mkdir to an attacker target.
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to use symlink at bundle path ${path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Bundle path ${path} exists but is not a directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Path does not exist yet — fall through to mkdirSync.
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

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
  /**
   * Stable key for this bundle. Used by:
   *  - Docker container name: `ironcurtain-<bundleId[0:12]>`
   *  - `ironcurtain.bundle=<bundleId>` label
   *  - Per-bundle directory layout under `workflow-runs/<wfId>/containers/<bundleId>/`
   *  - Coordinator control socket path
   *
   * Minted by `createDockerInfrastructure()`; never changes for a bundle's
   * lifetime. In single-session CLI mode the underlying value equals the
   * `SessionId` (the session factory casts at the boundary); in workflow
   * mode the orchestrator mints a dedicated `BundleId`.
   *
   * See `docs/designs/workflow-session-identity.md` §2.1 / §2.3.
   */
  readonly bundleId: BundleId;
  /**
   * Workflow id this bundle belongs to, if any. Present only when the
   * bundle was created under a workflow run; drives the
   * `ironcurtain.workflow` and `ironcurtain.scope` Docker labels in
   * `createSessionContainers()`. Standalone CLI / PTY bundles leave
   * this undefined so no workflow/scope labels are emitted.
   *
   * See `docs/designs/workflow-session-identity.md` §7.
   */
  readonly workflowId?: WorkflowId;
  /**
   * Scope this bundle was minted for, if any. Present only on
   * workflow-mode bundles (alongside `workflowId`). Emitted directly as
   * the `ironcurtain.scope=<scope>` Docker label so resume / orphan
   * reclamation can reconstruct `bundlesByScope` from the live container
   * set. Standalone CLI / PTY bundles leave this undefined.
   *
   * See `docs/designs/workflow-session-identity.md` §2.5 / §7.
   */
  readonly scope?: string;
  /**
   * Host directory holding bundle-scoped artifacts (sockets, escalations,
   * orientation, CA, fake keys, system-prompt). Outlives any single session
   * invocation.
   */
  readonly bundleDir: string;
  /**
   * Host directory bind-mounted as the agent's workspace. Under workflow
   * mode a single workspace is shared across bundles; single-session
   * callers pass a per-session sandbox here.
   */
  readonly workspaceDir: string;
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
  /**
   * Routes token-stream events from the MITM proxy's LLM API tap under the
   * given session ID, or disables routing when `undefined`.
   *
   * Required because a single long-lived infrastructure bundle (shared
   * across workflow agent states) must label extracted events with the
   * *active* per-state session ID rather than a static ID baked in at
   * construction time. Callers flip this around each agent run; thin
   * wrapper over `MitmProxy.setTokenSessionId()`.
   */
  setTokenSessionId(id: import('../session/types.js').SessionId | undefined): void;
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
 *
 * `workflowId` drives Docker labelling: when set, the main container (and
 * any sidecar created during `createSessionContainers`) carries
 * `ironcurtain.workflow=<workflowId>` + `ironcurtain.scope=<scope>`
 * alongside the always-present `ironcurtain.bundle=<bundleId>`. When
 * unset, only `ironcurtain.bundle` is emitted (standalone CLI / PTY).
 */
export async function prepareDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  bundleDir: string,
  workspaceDir: string,
  escalationDir: string,
  bundleId: BundleId,
  workflowId?: WorkflowId,
  scope?: string,
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
  const {
    getBundleSocketsDir,
    getBundleHostOnlyDir,
    getBundleProxySocketPath,
    getBundleMitmProxySocketPath,
    getBundleMitmControlSocketPath,
  } = await import('../config/paths.js');

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

  // Host-side UDS endpoints must fit under `sockaddr_un.sun_path`
  // (macOS ~104 / Linux ~108 bytes). The historical layout
  // (`<bundleDir>/sockets/proxy.sock` etc.) overflows that budget on
  // Linux for any realistic `$HOME` because `<bundleDir>` itself is
  // `~/.ironcurtain/workflow-runs/<36-char wfId>/containers/<36-char
  // bundleId>/bundle/` — ~95 chars before any filename. Route through
  // `getBundleSocketsDir(bundleId)` / `getBundleHostOnlyDir(bundleId)`
  // (both under `~/.ironcurtain/run/<bid12>/`) so every assembled path
  // stays well under the cap even with a 20-char username.
  // Harden the runtime root FIRST: `ensureSecureBundleDir` rejects a
  // pre-existing symlink at that path. If we only checked the children
  // (`sockets/`, `host/`) an attacker who planted a symlink at the
  // runtime root would silently redirect them. The root's ancestors
  // (`~/.ironcurtain/run/`, `~/.ironcurtain/`) are the user's trust
  // boundary and intentionally not walked.
  ensureSecureBundleDir(getBundleRuntimeRoot(bundleId));
  const socketsDir = getBundleSocketsDir(bundleId);
  const hostOnlyDir = getBundleHostOnlyDir(bundleId);
  ensureSecureBundleDir(socketsDir);
  ensureSecureBundleDir(hostOnlyDir);

  const socketPath = getBundleProxySocketPath(bundleId);

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
    const packageAuditLogPath = resolve(bundleDir, 'package-audit.jsonl');
    packageValidation = { validator, auditLogPath: packageAuditLogPath };
  }

  // MITM proxy uses its `sessionId` option as a token-stream routing key
  // (see MitmProxyOptions.sessionId). The routing key must match what
  // token-stream subscribers use; today bundleId is the right value in
  // both single-session and workflow modes. Name kept inside MitmProxy for
  // historical reasons; the value is a bundle-scoped routing token.
  const mitmProxy = useTcp
    ? createMitmProxy({
        listenPort: 0,
        ca,
        providers: providerMappings,
        registries,
        packageValidation,
        controlPort: 0,
      })
    : createMitmProxy({
        socketPath: getBundleMitmProxySocketPath(bundleId),
        ca,
        providers: providerMappings,
        registries,
        packageValidation,
        controlSocketPath: getBundleMitmControlSocketPath(bundleId),
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
    const { systemPrompt } = prepareSession(adapter, serverListings, bundleDir, config, workspaceDir, proxyAddress);

    // Ensure Docker image is built and up-to-date
    const image = await adapter.getImage();
    await ensureImage(image, docker, ca);

    const orientationDir = resolve(bundleDir, 'orientation');

    // Set up conversation state directory if the adapter supports resume
    const conversationStateConfig = adapter.getConversationStateConfig?.();
    const conversationStateDir = conversationStateConfig
      ? prepareConversationStateDir(bundleDir, conversationStateConfig)
      : undefined;

    return {
      bundleId,
      workflowId,
      scope,
      bundleDir,
      workspaceDir,
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
      setTokenSessionId: (id) => {
        mitmProxy.setTokenSessionId(id);
      },
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
  bundleDir: string,
  workspaceDir: string,
  escalationDir: string,
  bundleId: BundleId,
  workflowId?: WorkflowId,
  scope?: string,
): Promise<DockerInfrastructure> {
  const core = await prepareDockerInfrastructure(
    config,
    mode,
    bundleDir,
    workspaceDir,
    escalationDir,
    bundleId,
    workflowId,
    scope,
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

  // Remove the per-bundle `~/.ironcurtain/run/<bid12>/` tree. The
  // proxies already unlink their own socket files during `stop()`, and
  // the coordinator unlinks `ctrl.sock` from its control-server shutdown,
  // but the subdirectories (`sockets/` + `host/`) remain. Best-effort
  // only: a stale dir from a crashed run gets cleaned up on the next
  // bundle startup via `mkdirSync({recursive})`, and the contents
  // (empty once sockets are unlinked) carry no sensitive data.
  const runtimeRoot = getBundleRuntimeRoot(infra.bundleId);
  try {
    rmSync(runtimeRoot, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`destroyDockerInfrastructure: rmSync(${runtimeRoot}) failed: ${errorMessage(err)}`);
  }

  logger.info(`Destroyed Docker infrastructure (container=${infra.containerId.substring(0, 12)})`);
}

/**
 * Returns the Docker label fields
 * (`bundleLabel` / `workflowLabel` / `scopeLabel`) for containers owned by
 * the given bundle. Workflow-mode bundles emit all three; standalone
 * bundles emit only `bundleLabel`. Each field is left `undefined` when
 * absent so `buildCreateArgs` skips the corresponding `--label` flag.
 *
 * See `docs/designs/workflow-session-identity.md` §7.
 */
export function buildBundleLabels(core: Pick<PreContainerInfrastructure, 'bundleId' | 'workflowId' | 'scope'>): {
  bundleLabel: string;
  workflowLabel?: string;
  scopeLabel?: string;
} {
  if (core.workflowId !== undefined) {
    return {
      bundleLabel: core.bundleId,
      workflowLabel: core.workflowId,
      // Resolved scope is set by the orchestrator on every workflow
      // bundle; default-fall back to DEFAULT_CONTAINER_SCOPE so that a
      // workflow bundle always carries a scope label.
      scopeLabel: core.scope ?? DEFAULT_CONTAINER_SCOPE,
    };
  }
  return { bundleLabel: core.bundleId };
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
  const shortId = getBundleShortId(core.bundleId);
  const mainContainerName = `${CONTAINER_NAME_PREFIX}${shortId}`;
  // Labels applied to every IronCurtain-owned container (main + sidecar).
  // Workflow-mode bundles carry workflow + scope labels alongside the
  // always-present bundle label; standalone bundles carry only bundle.
  // See `docs/designs/workflow-session-identity.md` §7.
  const bundleLabels = buildBundleLabels(core);

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
      { source: core.workspaceDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
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
        ...bundleLabels,
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

      // Mount ONLY the per-bundle `sockets/` directory into the
      // container. The sockets dir lives under a short
      // `~/.ironcurtain/run/<bid12>/` path (see `getBundleSocketsDir`)
      // so the host path stays under `sockaddr_un.sun_path` on both
      // macOS and Linux. The host-only MITM control socket lives in a
      // sibling `host/` dir, NOT under this mount, so it is not
      // visible to the container.
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
      ...bundleLabels,
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
