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
import type { DockerAuthKind, IronCurtainConfig } from '../config/types.js';
import { getBundleRuntimeRoot } from '../config/paths.js';
import { getBundleShortId, type BundleId, type SessionId, type SessionMode } from '../session/types.js';
import { DEFAULT_CONTAINER_SCOPE, type WorkflowId } from '../workflow/types.js';
import {
  CONTAINER_SCRIPTS_DIR,
  CONTAINER_WORKSPACE_DIR,
  type AgentAdapter,
  type AgentId,
  type ConversationStateConfig,
} from './agent-adapter.js';
import type { ResolvedUserConfig } from '../config/user-config.js';
import { OPENROUTER_HOST, resolveActiveProfile } from '../config/user-config.js';
import type { DockerProxy } from './code-mode-proxy.js';
import type { MitmProxy } from './mitm-proxy.js';
import type { TrajectoryCaptureWriter } from './trajectory-capture.js';
import type { CertificateAuthority } from './ca.js';
import type { ContainerRuntime } from './types.js';
import type { ContainerRuntimeKind } from './container-runtime.js';
import type { HostOnlyNetwork, NetworkTopology } from './network-topology.js';
import type { ProviderKeyMapping } from './mitm-proxy.js';
import { parseUpstreamBaseUrl, type AgentKind, type ProviderConfig, type UpstreamTarget } from './provider-config.js';
import { getInternalNetworkName } from './platform.js';
import { cleanupContainers } from './container-lifecycle.js';
import { clampDockerResources } from './resource-limits.js';
import { errorMessage } from '../utils/error-message.js';
import { createCachedStager } from '../skills/staging.js';
import type { ResolvedSkill } from '../skills/types.js';
import { withProvisionLock } from './provision-lock.js';
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
  readonly docker: ContainerRuntime;
  readonly adapter: AgentAdapter;
  readonly ca: CertificateAuthority;
  readonly fakeKeys: Map<string, string>;
  readonly orientationDir: string;
  readonly systemPrompt: string;
  readonly image: string;
  /** Container runtime backend this bundle was built for. */
  readonly runtimeKind: ContainerRuntimeKind;
  /**
   * Proxy-transport topology (see network-topology.ts). `useTcp` is the
   * legacy projection `topology !== 'uds'`, kept for existing consumers.
   */
  readonly topology: NetworkTopology;
  readonly useTcp: boolean;
  /**
   * Per-bundle host-only network, present only on `tcp-hostonly`
   * bundles. Created during the prepare phase (the gateway address is
   * needed for orientation and container env before any container
   * exists); `createSessionContainers` attaches the agent container to
   * it and reports it as `internalNetwork` so the standard teardown
   * paths remove it.
   */
  readonly hostOnlyNetwork?: HostOnlyNetwork;
  readonly socketsDir: string;
  /** MITM proxy listen address (port for TCP mode, socketPath for UDS mode). */
  readonly mitmAddr: { socketPath?: string; port?: number };
  /** Authentication method used for this session. */
  readonly authKind: DockerAuthKind;
  /** Host-side conversation state directory, if the adapter supports resume. */
  readonly conversationStateDir?: string;
  /** Conversation state config from the adapter, if resume is supported. */
  readonly conversationStateConfig?: ConversationStateConfig;
  /**
   * Host-side staging dir + container bind-mount target for skills.
   * Always emits a separate read-only bind mount — nested bind mounts
   * (staging inside another mount's source dir) are unreliable on
   * Docker Desktop / macOS, so we use a sibling path the adapter
   * advertised as unused inside the container.
   */
  readonly skillsMount?: {
    /** Host-side staging dir (also passed to `restageSkills` and the cached stager). */
    readonly hostDir: string;
    /** Container target path; copied verbatim from `adapter.skills.containerPath`. */
    readonly target: string;
  };
  /** Host-side workflow scripts dir mounted read-only into the container. */
  readonly scriptsMount?: {
    readonly hostDir: string;
    readonly target: string;
  };
  /** Host-side cached Python venv mounted at /opt/workflow-venv for workflow helpers. */
  readonly workflowPythonVenvMount?: {
    readonly hostDir: string;
    readonly target: string;
    readonly cacheKey: string;
  };
  /** Host-side cached node_modules mounted for workflow helper scripts. */
  readonly workflowNodeModulesMount?: {
    readonly hostDir: string;
    readonly target: string;
    readonly cacheKey: string;
    readonly hasPackageLock: boolean;
  };
  /**
   * Re-stages the bundle's skills with the given resolved set.
   * No-op when `skillsMount` is undefined or when the set is byte-identical
   * to the previous call. Workflow callers use this on every state
   * transition; the bind mount is live, so the container's view updates
   * in place.
   */
  restageSkills(skills: readonly ResolvedSkill[]): void;
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

  /**
   * Begin trajectory capture for a session. Atomically:
   *   1. sets the proxy's captureSessionId (`MitmProxy.setCaptureSessionId`)
   *   2. sets the proxy's capturePersona (`MitmProxy.setCapturePersona`)
   *   3. opens the per-session trajectory file and appends a `session-start`
   *      manifest entry (`TrajectoryCaptureWriter.beginSession`)
   *
   * No-op when capture is disabled (writer is undefined). MUST be called
   * before the agent process is unblocked, so the first exchange the
   * agent emits is already tagged with the right session. See
   * docs/designs/mitm-token-trajectory-capture.md §11.
   *
   * Always present (never optional): the method is inert when the writer
   * is undefined, so "always present, sometimes a no-op" is correct.
   * Making it required turns "forgot to wire capture" into a compile
   * error instead of a silent no-op.
   */
  beginCaptureSession: (opts: {
    sessionId: import('../session/types.js').SessionId;
    persona?: string;
    fsmState?: string;
  }) => void;

  /**
   * End trajectory capture for a session. Drives the dispatcher's two-phase
   * endSession (§9: flip endRequested, drain in-flight reassembly, enqueue
   * `session-end` with counter snapshot). MUST be awaited BEFORE
   * `session.close()` so the manifest entry is durable even if `session.close()`
   * throws.
   *
   * No-op when capture is disabled. Always present (never optional): the
   * method is inert when the writer is undefined, so "always present,
   * sometimes a no-op" is correct, and a consumer that forgets to wire
   * capture now fails to compile rather than silently dropping it.
   */
  endCaptureSession: (sessionId: import('../session/types.js').SessionId) => Promise<void>;

  /**
   * Internal: trajectory-capture writer reference, exposed so
   * `destroyDockerInfrastructure` / `destroyWorkflowInfrastructure` can
   * call `writer.close()` as the infrastructure-teardown safety net
   * (§9). Undefined when capture is disabled. Not for orchestrator use.
   */
  readonly captureWriter?: TrajectoryCaptureWriter;
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
/** Hosts that use Codex ChatGPT OAuth credentials when available. */
const CODEX_CHATGPT_HOSTS = new Set(['chatgpt.com', 'auth.openai.com']);

/** Prefix for container/sidecar names. Keep in sync with `docker ps` filters. */
const CONTAINER_NAME_PREFIX = 'ironcurtain-';

/** Host gateway alias used by Docker containers on macOS/Windows. */
const DOCKER_HOST_GATEWAY = 'host.docker.internal';

/** Bundle-relative subdir name for the skills staging dir. */
const BUNDLE_SKILLS_SUBDIR = 'skills';

/** Container path for runtime-provisioned workflow Python dependencies. */
const WORKFLOW_PYTHON_VENV_DIR = '/opt/workflow-venv';

/** Container path for runtime-provisioned workflow Node dependencies. */
const WORKFLOW_NODE_MODULES_DIR = '/opt/workflow-node_modules';

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
/**
 * Optional trajectory-capture inputs threaded through to the MITM
 * proxy. Carries the RAW CLI/RPC override — this function is the single
 * place that resolves enablement against config (`override ?? config >
 * false`), so consumers never duplicate the `?? userConfig.capture?.enabled`
 * precedence. When this object is absent, or resolution yields false, no
 * writer is constructed and no taps are installed — zero cost on the
 * forwarding path. See docs/designs/mitm-token-trajectory-capture.md.
 */
export interface CaptureSetupInput {
  /**
   * Raw CLI/RPC override (boolean | undefined); undefined falls through
   * to `config.userConfig.capture?.enabled`, then to false. The single
   * resolution point lives in `prepareDockerInfrastructure`.
   */
  readonly override?: boolean;
  /**
   * Absolute path where `{sessionId}.jsonl` and `manifest.jsonl` are
   * written. A real per-path difference (session dir vs bundle dir), so
   * the caller supplies it rather than the infra layer deriving it.
   */
  readonly capturesDir: string;
  /** Human-readable agent name (e.g. `'claude-code'`). */
  readonly recordedAgentName?: string;
  /** Workflow run ID, when this bundle belongs to a workflow run. */
  readonly workflowRunId?: WorkflowId;
}

export async function prepareDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  bundleDir: string,
  workspaceDir: string,
  escalationDir: string,
  bundleId: BundleId,
  workflowId?: WorkflowId,
  scope?: string,
  resolvedSkills?: readonly ResolvedSkill[],
  captureInput?: CaptureSetupInput,
  scriptsDir?: string,
  providerProfileName?: string,
): Promise<PreContainerInfrastructure> {
  // Resolve and STAMP the active provider profile as the FIRST step (§9.7 F1),
  // before any container-runtime probe, adapter registration, or auth
  // detection. This ordering is load-bearing: Claude Code's
  // detectCredential(config) reads config.activeProviderProfile to return an
  // API-key AuthMethod for an OpenRouter-only user, so the stamp must already
  // be present when auth detection runs below. An unknown providerProfileName
  // throws a clear error listing the available profiles before any expensive
  // work or container launch. Safe to mutate: callers always pass a
  // session-specific config copy (the same invariant the config.dockerAuth
  // stamp below relies on).
  const activeProfile = resolveActiveProfile(config.userConfig.modelProviders, providerProfileName);
  config.activeProviderProfile = activeProfile;
  if (activeProfile.type === 'openrouter' && activeProfile.apiKey === '') {
    const activeName = providerProfileName ?? config.userConfig.modelProviders.default;
    throw new Error(
      `Provider profile "${activeName}" is OpenRouter but no API key is configured. ` +
        "Set OPENROUTER_API_KEY or the profile's apiKey in ~/.ironcurtain/config.json.",
    );
  }

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
  const { createContainerRuntime, resolveRuntimeKind } = await import('./container-runtime.js');
  const { resolveNetworkTopology, createHostOnlyNetwork, makeSourceAddressGuard } =
    await import('./network-topology.js');
  const { getIronCurtainHome } = await import('../config/paths.js');
  const { prepareSession } = await import('./orientation.js');

  const {
    detectAuthMethod,
    writeToKeychain,
    getCodexAuthFilePath,
    loadCodexOAuthCredentials,
    refreshCodexOAuthToken,
    refreshResultToCreds,
    saveCodexOAuthCredentials,
  } = await import('./oauth-credentials.js');
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
  const runtimeKind = await resolveRuntimeKind(config.userConfig.containerRuntime);
  const topology = resolveNetworkTopology(runtimeKind);
  const useTcp = topology !== 'uds';

  // Detect authentication method. Adapters with detectCredential() handle
  // their own credential detection (e.g., Goose checks provider-specific keys;
  // Claude Code returns an api-key AuthMethod for an OpenRouter-only profile).
  // A `detectCredential` that returns `undefined` DEFERS to detectAuthMethod()
  // (Anthropic OAuth + API key) — this is how Claude Code preserves today's
  // detection for a native profile (B2a). Adapters without the method also
  // fall back.
  const detected = adapter.detectCredential?.(config);
  const authMethod = detected ?? (await detectAuthMethod(config));
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

  const docker = createContainerRuntime(runtimeKind);

  // tcp-hostonly: create the per-bundle host-only network BEFORE the
  // proxies are constructed. The gateway address feeds the container env,
  // the orientation proxy address, and the connection-source guard both
  // proxies use while listening on 0.0.0.0 (the vmnet gateway interface
  // only materializes once the first container attaches, so binding the
  // gateway address directly is not possible at this point).
  let hostOnlyNetwork: HostOnlyNetwork | undefined;
  let allowRemoteAddress: ((remoteAddress: string | undefined) => boolean) | undefined;
  if (topology === 'tcp-hostonly') {
    hostOnlyNetwork = await createHostOnlyNetwork(docker, getInternalNetworkName(getBundleShortId(bundleId)));
    allowRemoteAddress = makeSourceAddressGuard(hostOnlyNetwork.subnet);
    logger.info(
      `Host-only network ${hostOnlyNetwork.name} (${hostOnlyNetwork.subnet}, gateway ${hostOnlyNetwork.gateway})`,
    );
  }

  const proxy = createCodeModeProxy({
    socketPath,
    config,
    listenMode: useTcp ? 'tcp' : 'uds',
    bindHost: topology === 'tcp-hostonly' ? '0.0.0.0' : undefined,
    allowRemoteAddress,
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
  const tokenManagerCodexDeps =
    authMethod.kind === 'oauth' && adapter.id === 'codex'
      ? {
          loadCredentials: loadCodexOAuthCredentials,
          refreshToken: async (rt: string) => refreshResultToCreds(await refreshCodexOAuthToken(rt)),
          saveCredentials: saveCodexOAuthCredentials,
          credentialsFilePath: getCodexAuthFilePath(),
        }
      : undefined;
  const tokenManager =
    authMethod.kind === 'oauth'
      ? new OAuthTokenManager(
          authMethod.credentials,
          { canRefresh: canRefreshOAuth(authMethod.credentials.refreshToken) },
          {
            ...tokenManagerKeychainDeps,
            ...tokenManagerCodexDeps,
          },
        )
      : undefined;
  const providers = adapter.getProviders(config, authKind);

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
    const isManagedOAuthHost =
      ANTHROPIC_HOSTS.has(providerConfig.host) ||
      (adapter.id === 'codex' && CODEX_CHATGPT_HOSTS.has(providerConfig.host));
    const hostTokenManager = tokenManager && isManagedOAuthHost ? tokenManager : undefined;
    providerMappings.push({ config: providerConfig, fakeKey, realKey, tokenManager: hostTokenManager });
  }

  // Build package installation proxy config if enabled
  const pkgConfig = config.userConfig.packageInstall;
  let registries: import('./package-types.js').RegistryConfig[] | undefined;
  let packageValidation: { validator: import('./package-types.js').PackageValidator; auditLogPath: string } | undefined;

  if (pkgConfig.enabled) {
    const { npmRegistry, pypiRegistry, debianRegistry, cargoRegistry } = await import('./registry-proxy.js');
    const { createPackageValidator } = await import('./package-validator.js');

    registries = [npmRegistry, pypiRegistry, debianRegistry, cargoRegistry];
    const validator = createPackageValidator({
      allowedPackages: pkgConfig.allowedPackages,
      deniedPackages: pkgConfig.deniedPackages,
      quarantineDays: pkgConfig.quarantineDays,
    });
    const packageAuditLogPath = resolve(bundleDir, 'package-audit.jsonl');
    packageValidation = { validator, auditLogPath: packageAuditLogPath };
  }

  // Initial token-stream routing id. Single-session mode: bundleId is
  // the session id, so the bridge subscribes under the same key.
  // Workflow shared-container mode: the orchestrator overrides this
  // per-agent via setTokenSessionId() around each executeAgentState,
  // so the bundleId default is only an initial placeholder. Double-cast
  // bridges the BundleId → SessionId brand gap on MitmProxyOptions.
  const routingId = bundleId as unknown as SessionId;
  // A workflow bundle serves only workflow agents for its entire lifetime,
  // so agentKind is fixed at construction time.
  const agentKind: AgentKind | undefined = workflowId !== undefined ? 'workflow' : undefined;

  // Single resolution point for trajectory-capture enablement. The raw
  // CLI/RPC override wins; otherwise fall through to config; otherwise
  // off. Consumers pass the raw override only — they never re-resolve
  // against `userConfig.capture?.enabled`.
  const captureEnabled = captureInput ? (captureInput.override ?? config.userConfig.capture?.enabled ?? false) : false;

  // Construct the trajectory-capture writer when capture is enabled.
  // When disabled, no writer is created, no taps are installed, and the
  // forwarding path is byte-identical to today (per §10 "zero cost when
  // disabled").
  let captureWriter: TrajectoryCaptureWriter | undefined;
  if (captureEnabled && captureInput) {
    const { createTrajectoryCaptureWriter } = await import('./trajectory-capture.js');
    captureWriter = createTrajectoryCaptureWriter({ capturesDir: captureInput.capturesDir });
  }

  const captureProxyOptions = captureWriter
    ? {
        capture: captureWriter,
        recordedAgentName: captureInput?.recordedAgentName,
        workflowRunId: captureInput?.workflowRunId,
        bundleId: String(bundleId),
      }
    : {};

  const mitmProxy = useTcp
    ? createMitmProxy({
        listenPort: 0,
        ca,
        providers: providerMappings,
        registries,
        packageValidation,
        controlPort: 0,
        initialTokenSessionId: routingId,
        agentKind,
        allowRemoteAddress,
        ...captureProxyOptions,
      })
    : createMitmProxy({
        socketPath: getBundleMitmProxySocketPath(bundleId),
        ca,
        providers: providerMappings,
        registries,
        packageValidation,
        controlSocketPath: getBundleMitmControlSocketPath(bundleId),
        initialTokenSessionId: routingId,
        agentKind,
        ...captureProxyOptions,
      });

  // Start MITM proxy FIRST so config.mitmControlAddr is set before proxy.start().
  // proxy.start() initializes the UTCP sandbox, which checks config.mitmControlAddr
  // to decide whether to register the proxy virtual MCP server for domain management.
  const mitmAddr = await mitmProxy.start();
  if (mitmAddr.port !== undefined) {
    logger.info(
      hostOnlyNetwork
        ? `MITM proxy listening on ${hostOnlyNetwork.gateway}:${mitmAddr.port} (0.0.0.0, subnet-guarded)`
        : `MITM proxy listening on 127.0.0.1:${mitmAddr.port}`,
    );
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
    logger.info(
      hostOnlyNetwork
        ? `Code Mode proxy listening on ${hostOnlyNetwork.gateway}:${proxy.port} (0.0.0.0, subnet-guarded)`
        : `Code Mode proxy listening on 127.0.0.1:${proxy.port}`,
    );
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

    // The address the agent uses to reach the Code Mode proxy: the vmnet
    // gateway on host-only networks, the Docker host alias otherwise.
    const proxyHost = hostOnlyNetwork ? hostOnlyNetwork.gateway : DOCKER_HOST_GATEWAY;
    const proxyAddress = useTcp && proxy.port !== undefined ? `${proxyHost}:${proxy.port}` : undefined;
    const { systemPrompt } = prepareSession(adapter, serverListings, bundleDir, config, workspaceDir, proxyAddress);

    // Ensure the stock agent image is built and up-to-date. Workflow
    // dependencies are provisioned at runtime into mounted caches below;
    // they are no longer baked into per-workflow Docker images.
    const agentImage = await adapter.getImage();
    const agentBuildHash = await ensureImage(agentImage, docker, ca);
    const image = agentImage;
    const workflowDependencyMounts = prepareWorkflowDependencyMounts(agentBuildHash, scriptsDir, getIronCurtainHome());

    const orientationDir = resolve(bundleDir, 'orientation');

    // Set up conversation state directory if the adapter supports resume
    const conversationStateConfig = adapter.getConversationStateConfig?.();
    const conversationStateDir = conversationStateConfig
      ? prepareConversationStateDir(bundleDir, conversationStateConfig)
      : undefined;

    // Workflow bundles always create the staging dir (even when empty)
    // because the bind mount can only be established at container start;
    // per-state persona transitions need a live mount to re-stage into.
    const isWorkflowBundle = workflowId !== undefined;
    const initialSkills = resolvedSkills ?? [];
    const skillsTarget = adapter.skills?.containerPath;
    let skillsMount: PreContainerInfrastructure['skillsMount'];
    let stage: ((skills: readonly ResolvedSkill[]) => boolean) | undefined;
    if (skillsTarget && (initialSkills.length > 0 || isWorkflowBundle)) {
      const hostDir = resolve(bundleDir, BUNDLE_SKILLS_SUBDIR);
      skillsMount = { hostDir, target: skillsTarget };
      stage = createCachedStager(hostDir);
      stage(initialSkills);
      if (initialSkills.length > 0) {
        logger.info(`Staged ${initialSkills.length} skill(s) to ${hostDir}`);
      }
    }
    const restageSkills = (skills: readonly ResolvedSkill[]): void => {
      if (!stage || !skillsMount) return;
      if (stage(skills)) {
        logger.info(`Re-staged ${skills.length} skill(s) to ${skillsMount.hostDir}`);
      }
    };

    let scriptsMount: PreContainerInfrastructure['scriptsMount'];
    if (scriptsDir !== undefined && existsSync(scriptsDir)) {
      scriptsMount = { hostDir: scriptsDir, target: CONTAINER_SCRIPTS_DIR };
      logger.info(`Staged workflow scripts available at ${scriptsDir}`);
    }

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
      runtimeKind,
      topology,
      useTcp,
      hostOnlyNetwork,
      socketsDir,
      mitmAddr,
      authKind,
      conversationStateDir,
      conversationStateConfig,
      skillsMount,
      scriptsMount,
      ...workflowDependencyMounts,
      restageSkills,
      setTokenSessionId: (id) => {
        mitmProxy.setTokenSessionId(id);
      },
      // Trajectory-capture lifecycle. When captureWriter is undefined
      // (capture disabled, the common case), every method is a cheap
      // no-op — zero cost on the forwarding path. When set, the bundle
      // owns the three-step atomic begin (setCaptureSessionId →
      // setCapturePersona → writer.beginSession) and the two-phase end
      // (writer.endSession → null out proxy attribution).
      beginCaptureSession: (opts) => {
        if (!captureWriter) return;
        mitmProxy.setCaptureSessionId(opts.sessionId);
        mitmProxy.setCapturePersona(opts.persona);
        captureWriter.beginSession(opts);
      },
      endCaptureSession: async (sessionId) => {
        if (!captureWriter) return;
        try {
          await captureWriter.endSession(sessionId);
        } finally {
          // Clear proxy attribution AFTER the drain settles so any
          // late-arriving response chunks already in flight are still
          // attributed to the correct session.
          mitmProxy.setCaptureSessionId(undefined);
          mitmProxy.setCapturePersona(undefined);
        }
      },
      captureWriter,
    };
  } catch (error) {
    // Best-effort cleanup of proxies started above
    await mitmProxy.stop().catch(() => {});
    await proxy.stop().catch(() => {});
    // Host-only network was created before the proxies; remove it too.
    // (A leak through the narrow window before this catch is self-healing:
    // createHostOnlyNetwork removes the stale same-named network first.)
    if (hostOnlyNetwork) {
      await docker.removeNetwork(hostOnlyNetwork.name).catch(() => {});
    }
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
  resolvedSkills?: readonly ResolvedSkill[],
  captureInput?: CaptureSetupInput,
  scriptsDir?: string,
  options?: CreateDockerInfrastructureOptions,
  providerProfileName?: string,
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
    resolvedSkills,
    captureInput,
    scriptsDir,
    providerProfileName,
  );

  let containerResources: ContainerResources | undefined;
  try {
    containerResources = await createSessionContainers(core, config, options);
    const infra = { ...core, ...containerResources };
    await provisionWorkflowDependencies(infra, config.userConfig.packageInstall.enabled);
    return infra;
  } catch (error) {
    // Any partial container/sidecar/network cleanup happened inside
    // createSessionContainers(). If provisioning failed after a complete
    // container bundle was created, clean that bundle here before tearing
    // down the proxies.
    if (containerResources) {
      await cleanupContainers(core.docker, {
        containerId: containerResources.containerId,
        sidecarContainerId: containerResources.sidecarContainerId ?? null,
        networkName: containerResources.internalNetwork ?? null,
      });
    }
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

  // Trajectory-capture safety net (§9): close the writer AFTER the proxies
  // have stopped, so no more records arrive mid-close. The writer emits
  // synthetic `session-end` entries (with `closedReason:
  // 'infrastructure-teardown'`) for any session whose explicit
  // endCaptureSession was not called — covering Ctrl-C / abort / crash
  // paths where the orchestrator's `finally` did not run.
  if (infra.captureWriter) {
    await infra.captureWriter
      .close()
      .catch((err: unknown) =>
        logger.warn(`destroyDockerInfrastructure: captureWriter.close() failed: ${errorMessage(err)}`),
      );
  }

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

/**
 * Returns the `user` override and env vars needed for runtime UID
 * remapping on Linux (issue #232). When the host UID is not 1000, the
 * baked codespace user (UID 1000) cannot write to bind-mounted
 * directories owned by the host UID. To fix this without committing to
 * a hardcoded UID in the image, the host launches the container as
 * `0:0` and passes `IRONCURTAIN_AGENT_UID` / `IRONCURTAIN_AGENT_GID`
 * so the entrypoint (running as root) can renumber the codespace
 * account before dropping privileges via `runuser`.
 *
 * On macOS (`useTcp === true`), Docker Desktop's VirtioFS handles UID
 * translation transparently and `--user 0:0` would defeat it; this
 * function returns an empty mapping there, leaving the container to
 * run as the baked `codespace` user from the Dockerfile.
 *
 * Exported for testability.
 */
export function buildAgentUidRemap(useTcp: boolean): {
  readonly user: string | undefined;
  readonly env: Record<string, string>;
} {
  if (useTcp) return { user: undefined, env: {} };
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return {
    user: '0:0',
    env: {
      IRONCURTAIN_AGENT_UID: String(uid),
      IRONCURTAIN_AGENT_GID: String(gid),
    },
  };
}

/** Container-level resources layered on top of the pre-container bundle. */
export interface ContainerResources {
  readonly containerId: string;
  readonly containerName: string;
  readonly sidecarContainerId?: string;
  readonly internalNetwork?: string;
}

export interface CreateDockerInfrastructureOptions {
  /**
   * Optional immutable image ref used only for the main container's
   * `docker create`. The normal agent image is still ensured first so
   * workflow dependency caches keep their base-image hash.
   */
  readonly baseImageOverride?: string;
}

/**
 * Creates and starts the main agent container (plus TCP-mode sidecar and
 * internal network on macOS). Cleans up any partially-created resources
 * on failure so callers get all-or-nothing semantics.
 *
 * Exported for testability: tests exercise the mount/env configuration and
 * the rollback-on-failure path by passing a mock `PreContainerInfrastructure`
 * with a scripted `ContainerRuntime`.
 */
export async function createSessionContainers(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
  options?: CreateDockerInfrastructureOptions,
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
    const mainImage =
      options?.baseImageOverride && (await core.docker.imageExists(options.baseImageOverride))
        ? options.baseImageOverride
        : core.image;

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
    // tcp-hostonly only: apt proxy config to write into the container via
    // exec after start. Apple container's virtiofs shares directories
    // only — the single-file bind mount the Docker topologies use for
    // /etc/apt/apt.conf.d/90-ironcurtain-proxy is rejected with
    // "path ... is not a directory".
    let hostOnlyAptProxyUrl: string | undefined;

    if (core.topology === 'tcp-hostonly') {
      // Apple container host-only mode: the agent VM reaches the host
      // proxies directly at the vmnet gateway address. No sidecar, no
      // extra host mappings — egress is blocked at the network layer
      // (`--internal`) and verified by the connectivity check below.
      if (core.hostOnlyNetwork === undefined || core.mitmAddr.port === undefined || core.proxy.port === undefined) {
        throw new Error('tcp-hostonly bundle is missing its host-only network or proxy ports');
      }
      const proxyUrl = `http://${core.hostOnlyNetwork.gateway}:${core.mitmAddr.port}`;

      env = {
        ...env,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      };
      hostOnlyAptProxyUrl = proxyUrl;

      network = core.hostOnlyNetwork.name;
      // Report the host-only network as `internalNetwork` so the standard
      // teardown paths (destroyDockerInfrastructure, rollback below)
      // remove it with the containers.
      internalNetwork = core.hostOnlyNetwork.name;
    } else if (core.topology === 'tcp-sidecar' && core.mitmAddr.port !== undefined && core.proxy.port !== undefined) {
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

    // Skills bind mount — read-only so the agent cannot modify staged
    // skills mid-session (preserves the cached-stager assumption and
    // the per-state filter's correctness). The target path is a
    // sibling of any other mount target by adapter contract.
    if (core.skillsMount) {
      mounts.push({ source: core.skillsMount.hostDir, target: core.skillsMount.target, readonly: true });
    }

    if (core.scriptsMount) {
      mounts.push({ source: core.scriptsMount.hostDir, target: core.scriptsMount.target, readonly: true });
    }
    if (core.workflowPythonVenvMount) {
      mounts.push({
        source: core.workflowPythonVenvMount.hostDir,
        target: core.workflowPythonVenvMount.target,
        readonly: false,
      });
    }
    if (core.workflowNodeModulesMount) {
      mounts.push({
        source: core.workflowNodeModulesMount.hostDir,
        target: core.workflowNodeModulesMount.target,
        readonly: false,
      });
    }

    // Linux-only UID-remap wiring (issue #232). On Linux, run the
    // container as root and pass the host UID/GID via env so the
    // entrypoint can renumber codespace before dropping privileges.
    // On macOS (useTcp), VirtioFS translates UIDs transparently —
    // passing `--user 0:0` would actually break that translation,
    // so we leave the container running as the baked codespace user
    // and skip the env vars entirely.
    const uidRemap = buildAgentUidRemap(core.useTcp);

    // Resource ceilings come from userConfig (defaults: 8 GB / 4 cpus) and
    // are clamped to fit the host. `null` in either field is preserved as
    // "no flag emitted" (see clampDockerResources docs).
    const { effective: containerResources } = clampDockerResources(config.userConfig.dockerResources);

    mainContainerId = await core.docker.create({
      image: mainImage,
      name: mainContainerName,
      network: network ?? 'none',
      mounts,
      env: {
        ...env,
        // Do NOT override PATH here. Docker `-e PATH=...` REPLACES the image's
        // PATH (it does not append), which would discard the base image's real
        // PATH — including the NVM directory where `node`/`npm` live on the x86
        // devcontainer base. Bare-`node` workflow helpers would then fail to
        // resolve. The workflow venv bin is instead prepended to the live
        // `$PATH` at exec time (see buildWorkflowExecCommand), which is
        // base-image-agnostic and preserves the image's own PATH.
        ...(core.workflowNodeModulesMount ? { NODE_PATH: core.workflowNodeModulesMount.target } : {}),
        ...uidRemap.env,
      },
      user: uidRemap.user,
      command: ['sleep', 'infinity'],
      ...bundleLabels,
      resources: { memoryMb: containerResources.memoryMb, cpus: containerResources.cpus },
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

    // tcp-hostonly: write the apt proxy config inside the container (the
    // Docker topologies bind-mount it; see hostOnlyAptProxyUrl above).
    if (hostOnlyAptProxyUrl !== undefined) {
      await writeHostOnlyAptProxyConfig(core.docker, mainContainerId, hostOnlyAptProxyUrl);
    }

    // Connectivity check: verify the container can reach host proxies
    // through the internal network. Abort if unreachable. Host-only
    // bundles additionally assert the inverse — internet egress must be
    // blocked — and never fall back to a weaker configuration.
    if (core.topology === 'tcp-hostonly' && core.hostOnlyNetwork !== undefined && core.proxy.port !== undefined) {
      await checkHostOnlyConnectivity(core.docker, mainContainerId, core.hostOnlyNetwork.gateway, core.proxy.port);
    } else if (core.useTcp && internalNetwork !== undefined && core.proxy.port !== undefined) {
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
  docker: ContainerRuntime,
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
 * Writes /etc/apt/apt.conf.d/90-ironcurtain-proxy inside a running
 * container via exec (as root). Used by the tcp-hostonly topology in
 * both batch and PTY modes — Apple container's virtiofs shares
 * directories only, so the single-file bind mount the Docker topologies
 * use is rejected. The URL is built from our own gateway address and
 * OS-assigned port — runtime-generated values, not untrusted input — so
 * embedding it in the sh script is safe.
 */
export async function writeHostOnlyAptProxyConfig(
  docker: ContainerRuntime,
  containerId: string,
  proxyUrl: string,
): Promise<void> {
  const aptWrite = await docker.exec(
    containerId,
    [
      'sh',
      '-c',
      `printf 'Acquire::http::Proxy "%s";\\nAcquire::https::Proxy "%s";\\n' '${proxyUrl}' '${proxyUrl}' > /etc/apt/apt.conf.d/90-ironcurtain-proxy`,
    ],
    10_000,
    'root',
  );
  if (aptWrite.exitCode !== 0) {
    throw new Error(`Failed to write apt proxy config in container (exit=${aptWrite.exitCode}): ${aptWrite.stderr}`);
  }
}

/**
 * External address used to probe that internet egress is blocked. Any
 * globally-routable address works; the check asserts the connection
 * FAILS, so the probe never carries data off the machine on a healthy
 * setup.
 */
const EGRESS_PROBE_ADDRESS = '1.1.1.1:443';

/**
 * Fail-closed startup gate for the tcp-hostonly topology
 * (docs/designs/apple-container-runtime.md, design decision 4). Asserts
 * from inside the container that (a) the host-side proxies are reachable
 * at the vmnet gateway and (b) internet egress is blocked by the
 * host-only network. Either failure aborts session initialization —
 * never a silent fallback to a weaker network configuration. Shared by
 * batch (`createSessionContainers`) and PTY (`runPtySession`) modes.
 */
export async function checkHostOnlyConnectivity(
  docker: ContainerRuntime,
  containerId: string,
  gateway: string,
  mcpPort: number,
): Promise<void> {
  const reach = await docker.exec(
    containerId,
    ['socat', '-u', '/dev/null', `TCP:${gateway}:${mcpPort},connect-timeout=5`],
    6_000,
  );
  if (reach.exitCode !== 0) {
    throw new Error(
      `Host-only network connectivity check failed (exit=${reach.exitCode}). ` +
        `The container cannot reach host-side proxies at gateway ${gateway}:${mcpPort}. ` +
        `Check that the host-only network exists and the proxies are listening.`,
    );
  }

  const egress = await docker.exec(
    containerId,
    ['socat', '-u', '/dev/null', `TCP:${EGRESS_PROBE_ADDRESS},connect-timeout=3`],
    5_000,
  );
  if (egress.exitCode === 0) {
    throw new Error(
      `Host-only network egress check failed: the container reached ${EGRESS_PROBE_ADDRESS}. ` +
        `The network is not blocking internet egress as required; refusing to start the session.`,
    );
  }
}

/**
 * Whether an OAuth credential set can be refreshed: true only when a
 * non-empty refresh token is present. Externally-managed Codex tokens
 * (`auth_mode: 'chatgptAuthTokens'`) carry an empty refresh token and must
 * NOT be refreshed by IronCurtain. Pure helper, exported for testability.
 */
export function canRefreshOAuth(refreshToken: string): boolean {
  return refreshToken.length > 0;
}

/**
 * Resolves the real credential for a provider host.
 *
 * For Anthropic hosts in OAuth mode, uses the OAuth access token.
 * For all other cases, falls back to the API key from config.
 */
export function resolveRealKey(host: string, config: IronCurtainConfig, oauthAccessToken: string | undefined): string {
  if (oauthAccessToken && ANTHROPIC_HOSTS.has(host)) {
    return oauthAccessToken;
  }
  if (oauthAccessToken && CODEX_CHATGPT_HOSTS.has(host)) {
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
    case 'chatgpt.com':
    case 'auth.openai.com':
      key = '';
      break;
    case 'generativelanguage.googleapis.com':
      key = config.userConfig.googleApiKey;
      break;
    case OPENROUTER_HOST: {
      // OpenRouter uses a static bearer key from the stamped active profile
      // (§7.5). The same host serves all three agents, so this single case
      // covers them. `isManagedOAuthHost` never matches openrouter.ai, so no
      // OAuth token is involved here.
      const profile = config.activeProviderProfile;
      key = profile?.type === 'openrouter' ? profile.apiKey : '';
      break;
    }
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
 * As a defense-in-depth measure, always deletes stale credential files
 * (`.credentials.json` for Claude Code, `auth.json` for Codex) from the
 * state directory — the MITM proxy handles auth independently, and each
 * agent's entrypoint recreates its credential file from env on every
 * start, so any credential file lingering across resumes is stale. The
 * unlinks are no-ops for adapters whose state dir has neither file (e.g.
 * Goose), since a missing file is swallowed.
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

  // Defense-in-depth: remove stale credential files on every start. The
  // entrypoint recreates them from env each start, so scrubbing host-side
  // is safe. Both unlinks are no-ops when the file is absent.
  for (const fileName of ['.credentials.json', 'auth.json']) {
    try {
      unlinkSync(resolve(stateDir, fileName));
    } catch {
      // File doesn't exist — expected on first run / other adapters
    }
  }

  return stateDir;
}

/**
 * Public pre-flight: resolves the adapter for `agentId`, makes sure the CA
 * and Docker manager are in place, and runs the same `ensureImage` work
 * that `prepareDockerInfrastructure` would do later.
 *
 * Why expose this: image pull/build streams progress to the parent
 * terminal (via the progress sink), and the CLI normally wraps session
 * init in an `ora` spinner. Running this BEFORE the spinner starts keeps
 * the two renderers from fighting for the same line. The inner
 * `ensureImage` call inside `prepareDockerInfrastructure` is content-hash
 * cached, so a second call from the session-init path is a cheap no-op.
 */
export async function ensureDockerImage(agentId: AgentId, userConfig: ResolvedUserConfig): Promise<void> {
  const { registerBuiltinAdapters, getAgent } = await import('./agent-registry.js');
  const { loadOrCreateCA } = await import('./ca.js');
  const { createContainerRuntime, resolveRuntimeKind } = await import('./container-runtime.js');
  const { getIronCurtainHome } = await import('../config/paths.js');

  await registerBuiltinAdapters(userConfig);
  const adapter = getAgent(agentId);
  const image = await adapter.getImage();
  const docker = createContainerRuntime(await resolveRuntimeKind(userConfig.containerRuntime));
  const ca = loadOrCreateCA(resolve(getIronCurtainHome(), 'ca'));
  await ensureImage(image, docker, ca);
}

/**
 * Ensures the agent Docker image exists and is up-to-date. Builds the base
 * image first (with the IronCurtain CA cert baked in) and then the
 * agent-specific image. Content-hash labels on each image drive staleness
 * detection so repeated calls skip rebuilds when nothing has changed.
 */
/**
 * Builds `image` from a fresh temp directory populated with the contents of
 * `dockerDir` (plus any `extraFiles`, keyed dest→src). Building from a clean
 * dir outside any git repo is REQUIRED for Apple `container build`, which
 * resolves an EMPTY context when handed a git-tracked source directory (the
 * repo's docker/ in a checkout/worktree) — making `COPY` fail with "not
 * found"; harmless on Docker. The Dockerfiles only COPY files that live in
 * `dockerDir` / `extraFiles`.
 */
async function buildImageFromCleanContext(
  docker: ContainerRuntime,
  image: string,
  dockerDir: string,
  dockerfile: string,
  labels: Record<string, string>,
  extraFiles: Record<string, string> = {},
): Promise<void> {
  const tmpContext = mkdtempSync(resolve(tmpdir(), 'ironcurtain-build-'));
  try {
    for (const file of readdirSync(dockerDir)) {
      copyFileSync(resolve(dockerDir, file), resolve(tmpContext, file));
    }
    for (const [dest, src] of Object.entries(extraFiles)) {
      copyFileSync(src, resolve(tmpContext, dest));
    }
    await docker.buildImage(image, resolve(tmpContext, dockerfile), tmpContext, labels);
  } finally {
    rmSync(tmpContext, { recursive: true, force: true });
  }
}

// `docker` is typed `ContainerRuntime` (the apple-container generalization of
// the former `DockerManager`); exported because callers/tests import it.
export async function ensureImage(image: string, docker: ContainerRuntime, ca: CertificateAuthority): Promise<string> {
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
    await buildImageFromCleanContext(docker, image, dockerDir, dockerfile, {
      'ironcurtain.build-hash': agentBuildHash,
    });
    logger.info(`Docker image ${image} built successfully`);
  }

  return agentBuildHash;
}

export function computeWorkflowDependencyHash(agentBuildHash: string, scriptsDir: string): string {
  const hash = createHash('sha256');
  hash.update(`agent:${agentBuildHash}\n`);
  for (const manifest of ['requirements.txt', 'package.json', 'package-lock.json']) {
    const manifestPath = resolve(scriptsDir, manifest);
    if (!existsSync(manifestPath)) continue;
    hash.update(`file:${manifest}\n`);
    hash.update(readFileSync(manifestPath));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Wraps an in-container command so the workflow dependency bins are prepended
 * to the container's LIVE `$PATH` at exec time, rather than replacing the
 * image's PATH at container-creation time.
 *
 * Why a runtime shell instead of an `-e PATH=...` env: Docker `-e` REPLACES the
 * image PATH (it does not append), which would discard the base image's own
 * PATH — including the NVM directory where `node`/`npm` live on the x86
 * devcontainer base. Expanding `$PATH` inside the container at exec time is
 * base-image-agnostic: it preserves whatever PATH the image ships and merely
 * prepends the workflow venv bin (for bare `python`) and the installed Node
 * package bins (`node_modules/.bin`).
 *
 * Returns the original command unchanged when neither dependency mount is
 * present, so non-dependency workflows keep the plain exec path.
 *
 * Shell-safety: the only interpolated values are the hardcoded container
 * constants `WORKFLOW_PYTHON_VENV_DIR` / `WORKFLOW_NODE_MODULES_DIR`. The
 * caller's command and its arguments are passed verbatim as positional
 * parameters consumed by `exec "$@"` — never string-interpolated — so no
 * word-splitting or injection is possible.
 */
export function buildWorkflowExecCommand(
  bundle: Pick<DockerInfrastructure, 'workflowPythonVenvMount' | 'workflowNodeModulesMount'>,
  command: readonly string[],
): readonly string[] {
  const prefixDirs: string[] = [];
  if (bundle.workflowPythonVenvMount) prefixDirs.push(`${WORKFLOW_PYTHON_VENV_DIR}/bin`);
  if (bundle.workflowNodeModulesMount) prefixDirs.push(`${WORKFLOW_NODE_MODULES_DIR}/.bin`);
  if (prefixDirs.length === 0 || command.length === 0) return command;

  const pathPrefix = prefixDirs.join(':');
  // `exec "$@"` runs the original argv verbatim; the leading `sh` is $0.
  return ['/bin/sh', '-lc', `export PATH=${pathPrefix}:"$PATH"; exec "$@"`, 'sh', ...command];
}

interface WorkflowDependencyMounts {
  readonly workflowPythonVenvMount?: PreContainerInfrastructure['workflowPythonVenvMount'];
  readonly workflowNodeModulesMount?: PreContainerInfrastructure['workflowNodeModulesMount'];
}

function prepareWorkflowDependencyMounts(
  agentBuildHash: string,
  scriptsDir: string | undefined,
  ironcurtainHome: string,
): WorkflowDependencyMounts {
  if (scriptsDir === undefined || !existsSync(scriptsDir)) return {};

  const requirementsPath = resolve(scriptsDir, 'requirements.txt');
  const packageJsonPath = resolve(scriptsDir, 'package.json');
  const packageLockPath = resolve(scriptsDir, 'package-lock.json');
  const hasPythonManifest = existsSync(requirementsPath);
  const hasNodeManifest = existsSync(packageJsonPath);
  if (!hasPythonManifest && !hasNodeManifest) return {};

  const dependencyHash = computeWorkflowDependencyHash(agentBuildHash, scriptsDir);
  const cacheRoot = resolve(ironcurtainHome, 'workflow-deps', dependencyHash.slice(0, 24));
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });

  let workflowPythonVenvMount: PreContainerInfrastructure['workflowPythonVenvMount'];
  let workflowNodeModulesMount: PreContainerInfrastructure['workflowNodeModulesMount'];
  if (hasPythonManifest) {
    const hostDir = resolve(cacheRoot, 'python-venv');
    mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    workflowPythonVenvMount = {
      hostDir,
      target: WORKFLOW_PYTHON_VENV_DIR,
      cacheKey: dependencyHash,
    };
  }
  if (hasNodeManifest) {
    const hostDir = resolve(cacheRoot, 'node_modules');
    mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    workflowNodeModulesMount = {
      hostDir,
      target: WORKFLOW_NODE_MODULES_DIR,
      cacheKey: dependencyHash,
      hasPackageLock: existsSync(packageLockPath),
    };
  }
  return {
    ...(workflowPythonVenvMount ? { workflowPythonVenvMount } : {}),
    ...(workflowNodeModulesMount ? { workflowNodeModulesMount } : {}),
  };
}

async function provisionWorkflowDependencies(
  infra: DockerInfrastructure,
  packageInstallEnabled: boolean,
): Promise<void> {
  if (!infra.workflowPythonVenvMount && !infra.workflowNodeModulesMount) return;

  // Runtime provisioning installs through the MITM registry proxy, which is
  // only wired when packageInstall is enabled (see prepareDockerInfrastructure
  // — `registries`/`packageValidation` are left undefined otherwise). The
  // mounts above only exist when the workflow actually ships a
  // requirements.txt / package.json, so reaching here with package install
  // disabled means the run genuinely needs deps it can never fetch under
  // `--network=none`. Fail fast with an actionable message rather than letting
  // `uv pip install` / `npm install` die with an opaque network error.
  if (!packageInstallEnabled) {
    throw new Error(
      'This workflow requires installing dependencies at runtime ' +
        '(a requirements.txt and/or package.json is present in its scripts), ' +
        'but packageInstall is disabled. Enable packageInstall in your IronCurtain ' +
        'config to run workflows that declare runtime dependencies.',
    );
  }

  if (infra.workflowPythonVenvMount) {
    await provisionWorkflowPythonDependencies(infra);
  }
  if (infra.workflowNodeModulesMount) {
    await provisionWorkflowNodeDependencies(infra);
  }
}

async function provisionWorkflowPythonDependencies(infra: DockerInfrastructure): Promise<void> {
  const mount = infra.workflowPythonVenvMount;
  if (!mount) return;
  const sentinel = `${mount.target}/.ironcurtain-provisioned-${mount.cacheKey}`;
  const command = [
    'set -eu',
    `if [ -f ${quote([sentinel])} ]; then exit 0; fi`,
    `find ${quote([mount.target])} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
    `UV_NATIVE_TLS=1 uv venv ${quote([mount.target])}`,
    `VIRTUAL_ENV=${quote([mount.target])} UV_NATIVE_TLS=1 uv pip install -r ${quote([`${CONTAINER_SCRIPTS_DIR}/requirements.txt`])}`,
    `touch ${quote([sentinel])}`,
  ].join('\n');

  // Serialize concurrent provisioning of this content-keyed cache across runs.
  // The lock is host-side because in-container flock does not propagate across
  // containers on a Docker Desktop bind mount; the in-shell sentinel check
  // provides the short-circuit, the host lock makes the second run wait for the
  // first so it observes the populated cache instead of racing on the clean.
  await withProvisionLock(mount.hostDir, async () => {
    logger.info(`Provisioning workflow Python dependencies into ${mount.target}`);
    const result = await infra.docker.exec(
      infra.containerId,
      ['/bin/sh', '-lc', command],
      1_200_000,
      'codespace',
      CONTAINER_WORKSPACE_DIR,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Workflow Python dependency provisioning failed: ${result.stderr || result.stdout}`);
    }
  });
}

async function provisionWorkflowNodeDependencies(infra: DockerInfrastructure): Promise<void> {
  const mount = infra.workflowNodeModulesMount;
  if (!mount) return;
  const sentinel = `${mount.target}/.ironcurtain-provisioned-${mount.cacheKey}`;
  const installCommand = mount.hasPackageLock ? 'npm ci --omit=dev' : 'npm install --omit=dev';
  const command = [
    'set -eu',
    `if [ -f ${quote([sentinel])} ]; then exit 0; fi`,
    'tmp="$(mktemp -d)"',
    'cleanup() { rm -rf "$tmp"; }',
    'trap cleanup EXIT',
    `cp ${quote([`${CONTAINER_SCRIPTS_DIR}/package.json`])} "$tmp/package.json"`,
    mount.hasPackageLock ? `cp ${quote([`${CONTAINER_SCRIPTS_DIR}/package-lock.json`])} "$tmp/package-lock.json"` : '',
    'cd "$tmp"',
    installCommand,
    `find ${quote([mount.target])} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
    `cp -a node_modules/. ${quote([mount.target])}/`,
    `touch ${quote([sentinel])}`,
  ]
    .filter(Boolean)
    .join('\n');

  // Host-side serialization of this content-keyed cache (see the Python path
  // for the bind-mount-flock rationale).
  await withProvisionLock(mount.hostDir, async () => {
    logger.info(`Provisioning workflow Node dependencies into ${mount.target}`);
    const result = await infra.docker.exec(
      infra.containerId,
      ['/bin/sh', '-lc', command],
      1_200_000,
      'codespace',
      CONTAINER_WORKSPACE_DIR,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Workflow Node dependency provisioning failed: ${result.stderr || result.stdout}`);
    }
  });
}

async function ensureBaseImage(
  baseImage: string,
  docker: ContainerRuntime,
  ca: CertificateAuthority,
  dockerDir: string,
  dockerfile: string,
  buildHash: string,
): Promise<boolean> {
  if (!(await isImageStale(baseImage, docker, buildHash))) return false;

  logger.info('Building base Docker image (this may take a while on first run)...');

  await buildImageFromCleanContext(
    docker,
    baseImage,
    dockerDir,
    dockerfile,
    { 'ironcurtain.build-hash': buildHash },
    { 'ironcurtain-ca-cert.pem': ca.certPath },
  );
  logger.info('Base Docker image built successfully');
  return true;
}

async function isImageStale(image: string, docker: ContainerRuntime, expectedHash: string): Promise<boolean> {
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
