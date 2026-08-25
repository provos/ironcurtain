/**
 * Shared Docker session infrastructure setup.
 *
 * Extracts the common setup steps (session dirs, proxies, orientation,
 * CA, fake keys, image) used by both the standard DockerAgentSession
 * and the PTY session module.
 */

import { resolve, dirname } from 'node:path';
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
import {
  getBundleShortId,
  type BundleId,
  type SessionId,
  type SessionMetadata,
  type SessionMode,
} from '../session/types.js';
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
import { createContainerRuntime, type ContainerRuntimeKind } from './container-runtime.js';
import type { HostOnlyNetwork, NetworkTopology } from './network-topology.js';
import type { ProviderKeyMapping } from './mitm-proxy.js';
import { parseUpstreamBaseUrl, type AgentKind, type ProviderConfig, type UpstreamTarget } from './provider-config.js';
import { getInternalNetworkName } from './platform.js';
import { cleanupContainers, destroyBundleOuterResources } from './container-lifecycle.js';
import {
  createIronCurtainInternalNetwork,
  InternalNetworkConnectivityError,
  managedResourceLabels,
  reconcileIronCurtainDockerResourcesBestEffort,
  releaseManagedResourceLease,
  withInternalNetworkAllocationRetry,
} from './docker-resource-lifecycle.js';
import { clampDockerResources } from './resource-limits.js';
import type { HostResources } from './resource-limits.js';
import { errorMessage } from '../utils/error-message.js';
import { createCachedStager } from '../skills/staging.js';
import type { ResolvedSkill } from '../skills/types.js';
import { withProvisionLock } from './provision-lock.js';
import {
  buildRuntimeTrustEnv,
  renderAptProxyConfig,
  stageRuntimeTrust,
  type RuntimeTrustMetadata,
} from './runtime-trust.js';
import { getFrozenWatchdogPolicyTemplatePath, getIronCurtainPackageRoot } from './docker-workload-paths.js';
import { prepareSelectedAgentArtifact, type SelectedAgentArtifact } from './selected-agent-artifact.js';
import {
  formatDockerWorkloadStatus,
  type DockerWorkloadNetworkAccess,
  type ResolvedDockerWorkloadConfig,
} from '../docker-workload/config.js';
import type {
  DockerWorkloadBundleHandle,
  OuterResourceKind,
  OuterResourceRole,
} from '../docker-workload/infrastructure.js';
import {
  nestedDaemonAgentEnv,
  resolveNestedDaemonBundle,
  startAppleVmDockerWorkload,
} from '../docker-workload/session-daemon.js';
import {
  APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
  APPLE_VM_PACKAGE_EGRESS_SOCKET,
  APPLE_VM_REGISTRY_EGRESS_SOCKET,
} from '../docker-workload/apple-vm-daemon.js';
import type { MetricsInvocationContext, MetricsInvocationLease } from '../llm-metrics/attribution-registry.js';
import { acquireLlmMetricsRuntime, type LlmMetricsRuntimeLease } from '../llm-metrics/runtime.js';
import { hasMetricsCapableCompletionEndpoint } from './llm-observation/completion-endpoint.js';
import {
  APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  appleVmDockerWorkloadArtifactMount,
  stageAppleVmDockerWorkloadBootstrap,
  type AppleVmDockerWorkloadBootstrapConfig,
} from '../docker-workload/apple-private-docker.js';
import type { ExpandedOuterCreate } from '../docker-workload/lifecycle-evidence.js';
import {
  DOCKER_BUILD_PROXY_CONFIG_PATH,
  DOCKER_BUILD_SHIM_PATH,
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_MODE,
  DOCKER_BUILD_TRUST_REAL_RUNC_NLINK,
  DOCKER_BUILD_TRUST_REAL_RUNC_SHA256,
  DOCKER_BUILD_TRUST_REAL_RUNC_SIZE,
  DOCKER_BUILD_TRUST_REAL_RUNC_OWNER_PAIRS,
  DOCKER_BUILD_TRUST_REAL_RUNC_VERSION,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  getDockerBuildShimStagingContract,
  type DockerBuildShimStagingContract,
  type DockerBuildTrustCanaryContract,
} from './docker-build-shim.js';
import type { DockerWorkloadEgressSet } from './docker-workload-egress.js';
import * as logger from '../logger.js';

export { InternalNetworkConnectivityError };

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

const DOCKER_BUILD_SHIM_STAGING_SUBDIR = 'package-build-runtime';
const DOCKER_BUILD_SHIM_SOURCE_NAME = 'docker';
const DOCKER_BUILD_PROXY_CONFIG_SOURCE_SUBDIR = 'package-build-client';
const DOCKER_BUILD_TRUST_WRAPPER_SOURCE_NAME = 'runc';
const DOCKER_BUILD_TRUST_CONTRACT_SOURCE_NAME = 'build-trust-contract.json';
const DOCKER_BUILD_TRUST_CA_CERT_SOURCE_NAME = 'ca-cert.pem';
const DOCKER_BUILD_TRUST_CA_BUNDLE_SOURCE_NAME = 'ca-bundle.pem';
const DOCKER_BUILD_TRUST_APT_CONFIG_SOURCE_NAME = 'apt.conf';
const CA_GENERATION_PATTERN = /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function writeExactStagedFile(path: string, content: string | Buffer, mode: number): void {
  writeFileSync(path, content, { mode, flag: 'wx' });
  chmodSync(path, mode);
  const stats = lstatSync(path);
  const observedMode = stats.mode & 0o777;
  const observed = readFileSync(path);
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    observedMode !== mode ||
    !observed.equals(expected)
  ) {
    throw new Error(`nested-Docker build artifact ${path} failed its exact file, link, mode, or content check`);
  }
}

interface StagedBuildTrustSource {
  readonly path: string;
  readonly destination: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: '0444';
}

function readExactBuildTrustInput(path: string): Buffer {
  const bytes = readFileSync(path);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o444 || stats.nlink !== 1) {
    throw new Error(`nested-Docker build trust input ${path} failed its exact file or mode check`);
  }
  return bytes;
}

function stagedPublicSource(path: string, containerPath: string, destination: string): StagedBuildTrustSource {
  const bytes = readFileSync(path);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o444 || stats.nlink !== 1) {
    throw new Error(`nested-Docker build trust source ${path} failed its exact file or mode check`);
  }
  return {
    path: containerPath,
    destination,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mode: '0444' as const,
  };
}

/** Materialize the package-only build shim outside every agent-visible orientation share. */
export function stageDockerBuildShim(
  bundleId: BundleId,
  networkAccess: DockerWorkloadNetworkAccess,
  options: { readonly orientationDir: string; readonly caGeneration: string },
): DockerBuildShimStaging | undefined {
  const contract = getDockerBuildShimStagingContract(networkAccess);
  if (contract === undefined) return undefined;
  if (!CA_GENERATION_PATTERN.test(options.caGeneration)) {
    throw new Error('nested-Docker package build staging requires an authenticated CA generation');
  }

  const {
    shimArtifact,
    proxyConfigArtifact,
    buildTrustWrapperArtifact,
    buildTrustContractArtifact,
    aptConfigArtifact,
  } = contract;
  if (
    shimArtifact.targetPath !== DOCKER_BUILD_SHIM_PATH ||
    shimArtifact.mode !== 0o555 ||
    proxyConfigArtifact.targetPath !== DOCKER_BUILD_PROXY_CONFIG_PATH ||
    proxyConfigArtifact.mode !== 0o444 ||
    buildTrustWrapperArtifact.targetPath !== DOCKER_BUILD_TRUST_WRAPPER_PATH ||
    buildTrustWrapperArtifact.guestMode !== 0o555 ||
    buildTrustContractArtifact.targetPath !== DOCKER_BUILD_TRUST_CONTRACT_PATH ||
    buildTrustContractArtifact.mode !== 0o444 ||
    aptConfigArtifact.targetPath !== DOCKER_BUILD_TRUST_APT_CONFIG_PATH ||
    aptConfigArtifact.mode !== 0o444
  ) {
    throw new Error('nested-Docker package build staging contract has an unsupported artifact layout');
  }

  const stagingRoot = resolve(getBundleRuntimeRoot(bundleId), DOCKER_BUILD_SHIM_STAGING_SUBDIR);
  ensureSecureBundleDir(stagingRoot);
  const shimSourcePath = resolve(stagingRoot, DOCKER_BUILD_SHIM_SOURCE_NAME);
  const proxyConfigSourceDirectory = resolve(stagingRoot, DOCKER_BUILD_PROXY_CONFIG_SOURCE_SUBDIR);
  const buildTrustWrapperSourcePath = resolve(stagingRoot, DOCKER_BUILD_TRUST_WRAPPER_SOURCE_NAME);
  const buildTrustContractSourcePath = resolve(stagingRoot, DOCKER_BUILD_TRUST_CONTRACT_SOURCE_NAME);
  const caCertificateSourcePath = resolve(stagingRoot, DOCKER_BUILD_TRUST_CA_CERT_SOURCE_NAME);
  const caBundleSourcePath = resolve(stagingRoot, DOCKER_BUILD_TRUST_CA_BUNDLE_SOURCE_NAME);
  const aptConfigSourcePath = resolve(stagingRoot, DOCKER_BUILD_TRUST_APT_CONFIG_SOURCE_NAME);
  mkdirSync(proxyConfigSourceDirectory, { mode: 0o755 });
  chmodSync(proxyConfigSourceDirectory, 0o755);
  const configDirectoryStats = lstatSync(proxyConfigSourceDirectory);
  if (!configDirectoryStats.isDirectory() || configDirectoryStats.isSymbolicLink()) {
    throw new Error(`nested-Docker build proxy config source is not a real directory: ${proxyConfigSourceDirectory}`);
  }

  writeExactStagedFile(shimSourcePath, shimArtifact.content, shimArtifact.mode);
  writeExactStagedFile(
    resolve(proxyConfigSourceDirectory, 'config.json'),
    proxyConfigArtifact.content,
    proxyConfigArtifact.mode,
  );
  const packageWrapperPath = resolve(getIronCurtainPackageRoot(), buildTrustWrapperArtifact.packagePath);
  const packageWrapper = readFileSync(packageWrapperPath);
  const packageWrapperStats = lstatSync(packageWrapperPath);
  if (
    !packageWrapperStats.isFile() ||
    packageWrapperStats.isSymbolicLink() ||
    (packageWrapperStats.mode & 0o777) !== buildTrustWrapperArtifact.packageMode ||
    packageWrapper.length !== buildTrustWrapperArtifact.size ||
    createHash('sha256').update(packageWrapper).digest('hex') !== buildTrustWrapperArtifact.sha256
  ) {
    throw new Error('nested-Docker build-trust wrapper does not match its checked package manifest');
  }
  writeExactStagedFile(buildTrustWrapperSourcePath, packageWrapper, buildTrustWrapperArtifact.guestMode);

  writeExactStagedFile(
    caCertificateSourcePath,
    readExactBuildTrustInput(resolve(options.orientationDir, 'ca-cert.pem')),
    0o444,
  );
  writeExactStagedFile(
    caBundleSourcePath,
    readExactBuildTrustInput(resolve(options.orientationDir, 'ca-bundle.pem')),
    0o444,
  );
  writeExactStagedFile(
    aptConfigSourcePath,
    renderAptProxyConfig(APPLE_VM_PACKAGE_EGRESS_PROXY_URL),
    aptConfigArtifact.mode,
  );
  const caCertificateSource = stagedPublicSource(
    caCertificateSourcePath,
    DOCKER_BUILD_TRUST_CA_CERT_PATH,
    '/dev/ironcurtain/ca-cert.pem',
  );
  const caBundleSource = stagedPublicSource(
    caBundleSourcePath,
    DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
    '/dev/ironcurtain/ca-bundle.pem',
  );
  const aptConfigSource = stagedPublicSource(
    aptConfigSourcePath,
    DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
    '/dev/ironcurtain/apt.conf',
  );
  const publicSources = [caCertificateSource, caBundleSource, aptConfigSource];
  const trustContract = `${JSON.stringify(
    {
      schemaVersion: 1,
      caGeneration: options.caGeneration,
      realRunc: {
        path: DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
        sha256: DOCKER_BUILD_TRUST_REAL_RUNC_SHA256,
        size: DOCKER_BUILD_TRUST_REAL_RUNC_SIZE,
        ownerPairs: DOCKER_BUILD_TRUST_REAL_RUNC_OWNER_PAIRS,
        nlink: DOCKER_BUILD_TRUST_REAL_RUNC_NLINK,
        mode: DOCKER_BUILD_TRUST_REAL_RUNC_MODE.toString(8).padStart(4, '0'),
        version: DOCKER_BUILD_TRUST_REAL_RUNC_VERSION,
      },
      publicSources,
    },
    null,
    2,
  )}\n`;
  writeExactStagedFile(buildTrustContractSourcePath, trustContract, buildTrustContractArtifact.mode);
  if (readdirSync(proxyConfigSourceDirectory).join('\n') !== 'config.json') {
    throw new Error('nested-Docker build proxy config source must contain exactly config.json');
  }
  return {
    contract,
    artifacts: [
      {
        kind: 'docker-shim',
        source: shimSourcePath,
        target: shimArtifact.targetPath,
        readonly: true,
      },
      {
        kind: 'proxy-config',
        source: proxyConfigSourceDirectory,
        target: dirname(proxyConfigArtifact.targetPath),
        readonly: true,
      },
      {
        kind: 'build-trust-wrapper',
        source: buildTrustWrapperSourcePath,
        target: buildTrustWrapperArtifact.targetPath,
        readonly: true,
      },
      {
        kind: 'build-trust-contract',
        source: buildTrustContractSourcePath,
        target: buildTrustContractArtifact.targetPath,
        readonly: true,
      },
      {
        kind: 'build-trust-ca-cert',
        source: caCertificateSourcePath,
        target: DOCKER_BUILD_TRUST_CA_CERT_PATH,
        readonly: true,
      },
      {
        kind: 'build-trust-ca-bundle',
        source: caBundleSourcePath,
        target: DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
        readonly: true,
      },
      {
        kind: 'build-trust-apt-config',
        source: aptConfigSourcePath,
        target: DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
        readonly: true,
      },
    ],
    buildTrustCanary: {
      caGeneration: options.caGeneration,
      buildTrustContractSha256: createHash('sha256').update(trustContract).digest('hex'),
      caCertificateSha256: caCertificateSource.sha256,
      caBundleSha256: caBundleSource.sha256,
      aptConfigSha256: aptConfigSource.sha256,
    },
  };
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
  /** Hash-bound public trust material staged into the read-only orientation mount. */
  readonly runtimeTrust: RuntimeTrustMetadata;
  readonly fakeKeys: Map<string, string>;
  readonly orientationDir: string;
  readonly systemPrompt: string;
  readonly image: string;
  /** Exact image-resolution tuple; admitted mode carries selected-artifact evidence. */
  readonly imageResolution?: AgentImageResolution;
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
  /** Container-facing base URL for the MITM proxy, without attribution credentials. */
  readonly metricsProxyUrl: string;
  /** Authentication method used for this session. */
  readonly authKind: DockerAuthKind;
  /** Resolved provider-profile name retained for attribution and grouping. */
  readonly providerProfileId: string;
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

  /** Register an exact invocation context and return its credentialed proxy URL. */
  beginMetricsInvocation?(context: MetricsInvocationContext): MetricsInvocationLease;

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

  /**
   * Present only for admitted secure nested Docker-workload bundles
   * (docs/designs/secure-nested-runtime-implementation-plan.md §8.2–8.3).
   * The host-owned lease handle: `createSessionContainers` / the PTY path
   * ledger every outer resource through it before create and observe it
   * after (§8.2 step 1); the same-VM bootstrap activates it after private
   * Docker is fully provisioned; `destroyDockerInfrastructure` tears it down
   * first (§8.3). Undefined for every ordinary session. The resolved-variant
   * guard currently admits only the explicit Apple developer slice.
   */
  readonly dockerWorkload?: DockerWorkloadBundleHandle;
  /** Immutable per-lease selected-agent artifact used only by an admitted Apple Docker workload. */
  readonly dockerWorkloadBootstrap?: AppleVmDockerWorkloadBootstrapConfig;
  /** Exact per-bundle nested-Docker egress authorities, absent when offline. */
  readonly dockerWorkloadEgress?: DockerWorkloadEgressCollection;
  /** Package-only Docker shim, build-trust wrapper/contract, and credential-free client config. */
  readonly dockerBuildShim?: DockerBuildShimStaging;
  /** Process-scoped statistics runtime reference held for this infrastructure bundle. */
  readonly metricsRuntime?: LlmMetricsRuntimeLease;
}

export interface DockerWorkloadEgressEndpoint<S> {
  readonly listener: { stop(): Promise<void> };
  readonly socketPath: string;
  readonly snapshot: () => S;
}

/** Registry and strict-package authorities are always distinct listeners/sockets. */
export type DockerWorkloadEgressCollection = DockerWorkloadEgressSet<
  DockerWorkloadEgressEndpoint<import('./docker-workload-egress.js').RegistryEgressLedgerSnapshot>,
  DockerWorkloadEgressEndpoint<import('./package-egress-ledger.js').PackageEgressLedgerSnapshot>
>;

export interface DockerBuildShimStaging {
  readonly contract: DockerBuildShimStagingContract;
  readonly artifacts: readonly DockerBuildShimStagedArtifact[];
  readonly buildTrustCanary: DockerBuildTrustCanaryContract;
}

export interface DockerBuildShimStagedArtifact {
  readonly kind:
    | 'docker-shim'
    | 'proxy-config'
    | 'build-trust-wrapper'
    | 'build-trust-contract'
    | 'build-trust-ca-cert'
    | 'build-trust-ca-bundle'
    | 'build-trust-apt-config';
  readonly source: string;
  readonly target: string;
  readonly readonly: true;
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

export type AgentImageResolution = {
  readonly mode: 'build-if-stale' | 'selected-agent-artifact';
  readonly logicalName: string;
  readonly imageRef: string;
  readonly buildHash: string;
  readonly immutableImageId?: string;
  readonly artifact?: SelectedAgentArtifact;
};

export interface PrepareDockerInfrastructureOptions {
  readonly providerProfileName?: string;
  readonly preparedImageResolution?: AgentImageResolution;
  /** Explicit request-rewriter mode for this container lifecycle. */
  readonly proxyAgentKind?: AgentKind;
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
  options: PrepareDockerInfrastructureOptions = {},
): Promise<PreContainerInfrastructure> {
  const { providerProfileName, preparedImageResolution, proxyAgentKind } = options;
  // Secure nested Docker resolves the effective runtime and rejects every
  // unsupported variant before feature-attributable runtime, image, artifact,
  // proxy, lease, or filesystem provisioning. Runtime resolution is a
  // read-only probe; ordinary CLI credential preflight is outside this seam.
  // Keep the feature-off path's historical profile/adapter/runtime ordering.
  let admittedRuntimeKind: ContainerRuntimeKind | undefined;
  if (config.userConfig.dockerWorkload?.enabled === true) {
    const { resolveRuntimeKind } = await import('./container-runtime.js');
    admittedRuntimeKind = await resolveRuntimeKind(config.userConfig.containerRuntime);
    const { assertDockerWorkloadVariantAdmitted, assertAdmittedDockerWorkloadRuntimeAvailable } =
      await import('../docker-workload/config.js');
    assertDockerWorkloadVariantAdmitted(config.userConfig.dockerWorkload, admittedRuntimeKind);
    await assertAdmittedDockerWorkloadRuntimeAvailable();
    const nestedDockerStatus = formatDockerWorkloadStatus(config.userConfig.dockerWorkload);
    if (nestedDockerStatus) logger.info(nestedDockerStatus);
  }

  // Resolve and STAMP the active provider profile before adapter registration
  // or auth detection (§9.7 F1). This ordering is load-bearing: Claude Code's
  // detectCredential(config) reads config.activeProviderProfile to return an
  // API-key AuthMethod for an OpenRouter-only user, so the stamp must already
  // be present when auth detection runs below. An unknown providerProfileName
  // throws a clear error listing the available profiles before any expensive
  // work or container launch. Safe to mutate: callers always pass a
  // session-specific config copy (the same invariant the config.dockerAuth
  // stamp below relies on).
  const activeProfile = resolveActiveProfile(config.userConfig.modelProviders, providerProfileName);
  const providerProfileId = providerProfileName ?? config.userConfig.modelProviders.default;
  config.activeProviderProfile = activeProfile;
  if (activeProfile.type === 'openrouter' && activeProfile.apiKey === '') {
    throw new Error(
      `Provider profile "${providerProfileId}" is OpenRouter but no API key is configured. ` +
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
    getBundleRegistryEgressSocketPath,
    getBundlePackageEgressSocketPath,
  } = await import('../config/paths.js');

  await registerBuiltinAdapters(config.userConfig);
  const adapter = getAgent(mode.agent);
  const runtimeKind = admittedRuntimeKind ?? (await resolveRuntimeKind(config.userConfig.containerRuntime));
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

  // §8.2 step 1: admit the secure nested Docker-workload bundle — create its
  // host-owned lease before any proxy or outer resource is created. Placed
  // here (after the runtime is resolved, before proxy startup) so the §8.2
  // ordering "lease -> proxies -> watchdog attestation" holds. The
  // resolved-variant guard above limits this production path to the admitted
  // Apple developer slice. `attestWatchdog()` (§8.2 step 3) is driven after
  // the proxies start, below.
  const dockerWorkloadConfig = config.userConfig.dockerWorkload;
  let dockerWorkloadAgentImage: string | undefined;
  let dockerWorkloadImageResolution: AgentImageResolution | undefined;
  let admittedDockerWorkload:
    | { readonly handle: DockerWorkloadBundleHandle; readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig }
    | undefined;
  if (dockerWorkloadConfig?.enabled === true) {
    dockerWorkloadAgentImage = await adapter.getImage();
    dockerWorkloadImageResolution = preparedImageResolution;
    if (dockerWorkloadImageResolution === undefined) {
      const built = await resolveAgentImage(dockerWorkloadAgentImage, docker);
      const artifact = await prepareSelectedAgentArtifact({
        runtime: docker,
        logicalName: dockerWorkloadAgentImage,
        buildHash: built.buildHash,
      });
      dockerWorkloadImageResolution = selectedAgentImageResolution(built, artifact);
    }
    assertPreparedImageResolution(dockerWorkloadImageResolution, dockerWorkloadAgentImage, true);
    const artifact = dockerWorkloadImageResolution.artifact;
    if (artifact === undefined) throw new Error('prepared nested Docker agent image is missing its selected artifact');
    admittedDockerWorkload = await admitDockerWorkloadForSession({
      dockerWorkload: dockerWorkloadConfig,
      runtime: docker,
      runtimeKind,
      bundleId,
      workspaceRoot: workspaceDir,
      auditLogPath,
      artifact,
    });
  }
  const dockerWorkload = admittedDockerWorkload?.handle;
  const dockerWorkloadBootstrap = admittedDockerWorkload?.bootstrap;

  // From this point onward every failure must revoke the admitted lease and
  // its immutable staging view. Keep the cleanup boundary outside network,
  // credential, provider, and proxy setup so no pre-attestation error can
  // strand a fresh lease.
  let hostOnlyNetwork: HostOnlyNetwork | undefined;
  let proxy: DockerProxy | undefined;
  let mitmProxy: MitmProxy | undefined;
  let metricsRuntime: LlmMetricsRuntimeLease | undefined;
  let dockerWorkloadEgress: DockerWorkloadEgressCollection | undefined;
  let dockerBuildShim: DockerBuildShimStaging | undefined;
  try {
    // tcp-hostonly: create the per-bundle host-only network BEFORE the
    // proxies are constructed. The gateway address feeds the container env,
    // the orientation proxy address, and the connection-source guard both
    // proxies use while listening on 0.0.0.0 (the vmnet gateway interface
    // only materializes once the first container attaches, so binding the
    // gateway address directly is not possible at this point).
    let allowRemoteAddress: ((remoteAddress: string | undefined) => boolean) | undefined;
    if (topology === 'tcp-hostonly') {
      hostOnlyNetwork = await createHostOnlyNetwork(docker, getInternalNetworkName(getBundleShortId(bundleId)));
      allowRemoteAddress = makeSourceAddressGuard(hostOnlyNetwork.subnet);
      logger.info(
        `Host-only network ${hostOnlyNetwork.name} (${hostOnlyNetwork.subnet}, gateway ${hostOnlyNetwork.gateway})`,
      );
    }

    proxy = createCodeModeProxy({
      socketPath,
      config,
      listenMode: useTcp ? 'tcp' : 'uds',
      bindHost: topology === 'tcp-hostonly' ? '0.0.0.0' : undefined,
      allowRemoteAddress,
    });

    // Load or generate the IronCurtain CA for TLS termination
    const caDir = resolve(getIronCurtainHome(), 'ca');
    const ca = loadOrCreateCA(caDir);

    // Resolve package policy exactly once. The strict nested package listener
    // and ordinary package-install proxy, when enabled, share this immutable
    // validator instead of constructing policy twice with potentially drifting
    // clocks or settings.
    const pkgConfig = config.userConfig.packageInstall;
    const packageMode = dockerWorkloadConfig?.enabled === true && dockerWorkloadConfig.networkAccess === 'packages';
    let registries: import('./package-types.js').RegistryConfig[] | undefined;
    let packageValidation:
      | { validator: import('./package-types.js').PackageValidator; auditLogPath: string }
      | undefined;
    let packagePolicy: import('./package-egress-proxy.js').PackageEgressPolicy | undefined;
    if (pkgConfig.enabled) {
      const { createPackageValidator } = await import('./package-validator.js');
      const validator = createPackageValidator({
        allowedPackages: pkgConfig.allowedPackages,
        deniedPackages: pkgConfig.deniedPackages,
        quarantineDays: pkgConfig.quarantineDays,
      });
      const packageAuditLogPath = resolve(bundleDir, 'package-audit.jsonl');
      const { npmRegistry, pypiRegistry, debianRegistry, cargoRegistry } = await import('./registry-proxy.js');
      registries = [npmRegistry, pypiRegistry, debianRegistry, cargoRegistry];
      packageValidation = { validator, auditLogPath: packageAuditLogPath };
      if (packageMode) packagePolicy = { validator };
    }

    if (dockerWorkloadConfig?.enabled === true) {
      const { createDockerWorkloadEgressListeners } = await import('./docker-workload-egress.js');
      const { PACKAGE_EGRESS_AUDIT_FILENAME } = await import('./package-egress-proxy.js');
      const { createDirectOutboundTransport } = await import('./outbound-transport.js');
      const registrySocketPath = getBundleRegistryEgressSocketPath(bundleId);
      const packageSocketPath = getBundlePackageEgressSocketPath(bundleId);
      const listeners = createDockerWorkloadEgressListeners({
        workload: dockerWorkloadConfig,
        ca,
        outboundTransport: createDirectOutboundTransport(),
        registryListen: { socketPath: registrySocketPath },
        packagePolicy,
        ...(packageMode ? { packageAuditLogPath: resolve(bundleDir, PACKAGE_EGRESS_AUDIT_FILENAME) } : {}),
      });
      if (listeners !== undefined) {
        dockerWorkloadEgress =
          listeners.networkAccess === 'images'
            ? {
                networkAccess: 'images',
                registry: { ...listeners.registry, socketPath: registrySocketPath },
              }
            : {
                networkAccess: 'packages',
                registry: { ...listeners.registry, socketPath: registrySocketPath },
                packages: { ...listeners.packages, socketPath: packageSocketPath },
              };
        const registryAddr = await listeners.registry.listener.start();
        if (registryAddr.socketPath !== registrySocketPath) {
          throw new Error('registry-egress listener did not bind its exact per-bundle socket');
        }
        if (listeners.networkAccess === 'packages') {
          const packageAddr = await listeners.packages.listener.start(packageSocketPath);
          if (packageAddr.socketPath !== packageSocketPath) {
            throw new Error('package-egress listener did not bind its exact per-bundle socket');
          }
        }
        // The host parent is 0700. Apple presents root-owned guest sockets, so
        // the non-root runtime user needs each mounted socket's "other" write
        // bit. Apply modes only after every enabled listener has bound and its
        // returned path has been verified.
        chmodSync(registrySocketPath, 0o666);
        if (listeners.networkAccess === 'packages') chmodSync(packageSocketPath, 0o666);
      }
    }

    // Generate fake keys and build provider key mappings.
    // In OAuth mode, use bearer-based providers and the OAuth access token as the real key.
    // Providers sharing the same fakeKeyPrefix (and thus the same real credential)
    // reuse the same fake key so a single container token authenticates against all hosts.
    const oauthAccessToken = authMethod.kind === 'oauth' ? authMethod.credentials.accessToken : undefined;
    // Re-reads and refresh write-backs must target the file the credentials
    // were detected in — writing a rotated refresh token to the wrong file
    // would strand the host's Claude Code login with an invalidated token.
    const tokenManagerFileDeps =
      authMethod.kind === 'oauth' && authMethod.source === 'file' && authMethod.filePath
        ? { credentialsFilePath: authMethod.filePath }
        : undefined;
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
              ...tokenManagerFileDeps,
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

    // Initial token-stream routing id. Single-session mode: bundleId is
    // the session id, so the bridge subscribes under the same key.
    // Workflow shared-container mode: the orchestrator overrides this
    // per-agent via setTokenSessionId() around each executeAgentState,
    // so the bundleId default is only an initial placeholder. Double-cast
    // bridges the BundleId → SessionId brand gap on MitmProxyOptions.
    const routingId = bundleId as unknown as SessionId;
    // The proxy execution mode is immutable over a bundle's lifetime. Legacy
    // direct callers that omit it still identify workflow bundles via their
    // workflow ID; otherwise they get the conservative undefined behavior.
    const agentKind: AgentKind | undefined = proxyAgentKind ?? (workflowId !== undefined ? 'workflow' : undefined);

    // Single resolution point for trajectory-capture enablement. The raw
    // CLI/RPC override wins; otherwise fall through to config; otherwise
    // off. Consumers pass the raw override only — they never re-resolve
    // against `userConfig.capture?.enabled`.
    const captureEnabled = captureInput
      ? (captureInput.override ?? config.userConfig.capture?.enabled ?? false)
      : false;
    const metricsCapable =
      config.userConfig.statistics.enabled &&
      providerMappings.some((mapping) => hasMetricsCapableCompletionEndpoint(mapping.config.completionEndpoints));

    // Construct the trajectory-capture writer when capture is enabled.
    // When disabled, no writer is created, no taps are installed, and the
    // forwarding path is byte-identical to today (per §10 "zero cost when
    // disabled").
    let captureWriter: TrajectoryCaptureWriter | undefined;
    if (captureEnabled && captureInput) {
      const { createTrajectoryCaptureWriter } = await import('./trajectory-capture.js');
      captureWriter = createTrajectoryCaptureWriter({ capturesDir: captureInput.capturesDir });
    }

    const proxyAttributionOptions = {
      recordedAgentName: captureInput?.recordedAgentName ?? adapter.id,
      workflowRunId: captureInput?.workflowRunId ?? workflowId,
      bundleId: String(bundleId),
      providerProfileId,
    };
    const captureProxyOptions = captureWriter ? { capture: captureWriter } : {};

    const activeMitmProxy = useTcp
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
          statisticsEnabled: metricsCapable,
          ...proxyAttributionOptions,
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
          statisticsEnabled: metricsCapable,
          ...proxyAttributionOptions,
          ...captureProxyOptions,
        });
    mitmProxy = activeMitmProxy;

    // Start MITM proxy FIRST so config.mitmControlAddr is set before proxy.start().
    // proxy.start() initializes the UTCP sandbox, which checks config.mitmControlAddr
    // to decide whether to register the proxy virtual MCP server for domain management.
    const mitmAddr = await activeMitmProxy.start();
    if (mitmAddr.port !== undefined) {
      logger.info(
        hostOnlyNetwork
          ? `MITM proxy listening on ${hostOnlyNetwork.gateway}:${mitmAddr.port} (0.0.0.0, subnet-guarded)`
          : `MITM proxy listening on 127.0.0.1:${mitmAddr.port}`,
      );
    } else {
      logger.info(`MITM proxy listening on ${mitmAddr.socketPath}`);
    }
    const metricsProxyUrl =
      topology === 'tcp-hostonly'
        ? `http://${hostOnlyNetwork?.gateway ?? '127.0.0.1'}:${mitmAddr.port ?? 0}`
        : topology === 'tcp-sidecar'
          ? `http://${DOCKER_HOST_GATEWAY}:${mitmAddr.port ?? 0}`
          : 'http://127.0.0.1:18080';
    // apple-container's `-v <sock>` vsock relay propagates the host
    // socket's mode bits to the guest side (owner is always root there),
    // so the non-root `codespace` user can only connect() when "other"
    // has write. The parent `sockets/` dir is 0o700, so widening the
    // socket mode does not expose it to other host users.
    if (!useTcp && runtimeKind === 'apple-container' && mitmAddr.socketPath !== undefined) {
      chmodSync(mitmAddr.socketPath, 0o666);
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
    if (!useTcp && runtimeKind === 'apple-container') {
      chmodSync(socketPath, 0o666);
    }

    if (metricsCapable) {
      try {
        metricsRuntime = await acquireLlmMetricsRuntime({
          retentionDays: config.userConfig.statistics.retentionDays,
        });
      } catch (error) {
        logger.warn(`LLM statistics persistence unavailable: ${errorMessage(error)}`);
      }
    }

    // §8.2 step 3: attest the host watchdog now that the outer proxies are up.
    // No-op unless a Docker-workload bundle was admitted above. Everything
    // from here on is covered by the catch below,
    // which tears the admitted lease down — see the note there for why crash
    // reconciliation cannot be relied on for a post-attestation failure.
    await dockerWorkload?.attestWatchdog();

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
    let nestedDocker: { networkName: string; networkAccess: DockerWorkloadNetworkAccess } | undefined;
    if (dockerWorkload !== undefined) {
      if (dockerWorkloadConfig?.enabled !== true) {
        throw new Error('admitted nested-Docker handle is missing its resolved enabled configuration');
      }
      nestedDocker = {
        networkName: APPLE_VM_DOCKER_WORKLOAD_NETWORK,
        networkAccess: dockerWorkloadConfig.networkAccess,
      };
    }
    const { systemPrompt } = prepareSession(
      adapter,
      serverListings,
      bundleDir,
      config,
      workspaceDir,
      proxyAddress,
      nestedDocker,
    );

    const orientationDir = resolve(bundleDir, 'orientation');
    const runtimeTrust = stageRuntimeTrust(orientationDir, ca.certPem);
    if (dockerWorkloadConfig?.enabled === true) {
      dockerBuildShim = stageDockerBuildShim(bundleId, dockerWorkloadConfig.networkAccess, {
        orientationDir,
        caGeneration: ca.generation,
      });
      if ((dockerWorkloadConfig.networkAccess === 'packages') !== (dockerBuildShim !== undefined)) {
        throw new Error('nested-Docker package build staging did not match the resolved network access');
      }
    }

    // Resolve the stock agent image once, before any container operation.
    // An admitted workload already carries the exact selected artifact created
    // before lease admission; ordinary sessions use the normal build cache.
    const agentImage = dockerWorkloadAgentImage ?? (await adapter.getImage());
    const imageResolution =
      dockerWorkloadImageResolution ?? preparedImageResolution ?? (await resolveAgentImage(agentImage, docker));
    assertPreparedImageResolution(imageResolution, agentImage, dockerWorkloadConfig?.enabled === true);
    const agentBuildHash = imageResolution.buildHash;
    const image = imageResolution.imageRef;
    // Surface the (unpinned) agent CLI version baked into the image so silent
    // version drift on rebuild is visible in logs (issue #367). Keyed by build
    // hash so a same-process rebuild re-logs the possibly-changed version.
    await logResolvedAgentVersion(docker, image, agentBuildHash, adapter.versionProbe);
    const workflowDependencyMounts = prepareWorkflowDependencyMounts(agentBuildHash, scriptsDir, getIronCurtainHome());

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
      mitmProxy: activeMitmProxy,
      docker,
      adapter,
      ca,
      runtimeTrust,
      fakeKeys,
      orientationDir,
      systemPrompt,
      image,
      imageResolution,
      runtimeKind,
      topology,
      useTcp,
      hostOnlyNetwork,
      socketsDir,
      mitmAddr,
      metricsProxyUrl,
      authKind,
      providerProfileId,
      conversationStateDir,
      conversationStateConfig,
      skillsMount,
      scriptsMount,
      ...workflowDependencyMounts,
      dockerWorkload,
      dockerWorkloadBootstrap,
      dockerWorkloadEgress,
      dockerBuildShim,
      restageSkills,
      setTokenSessionId: (id) => {
        activeMitmProxy.setTokenSessionId(id);
      },
      ...(metricsCapable
        ? {
            beginMetricsInvocation: (context: MetricsInvocationContext) =>
              activeMitmProxy.beginMetricsInvocation(metricsProxyUrl, context),
          }
        : {}),
      // Trajectory-capture lifecycle. When captureWriter is undefined
      // (capture disabled, the common case), every method is a cheap
      // no-op — zero cost on the forwarding path. When set, the bundle
      // owns the three-step atomic begin (setCaptureSessionId →
      // setCapturePersona → writer.beginSession) and the two-phase end
      // (writer.endSession → null out proxy attribution).
      beginCaptureSession: (opts) => {
        if (!captureWriter) return;
        activeMitmProxy.setCaptureSessionId(opts.sessionId);
        activeMitmProxy.setCapturePersona(opts.persona);
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
          activeMitmProxy.setCaptureSessionId(undefined);
          activeMitmProxy.setCapturePersona(undefined);
        }
      },
      captureWriter,
      metricsRuntime,
    };
  } catch (error) {
    // §8.3: an admitted Docker-workload lease must not outlive the failed
    // preparation, and crash reconciliation only reclaims SOME of these
    // failures. Attestation failure itself is reclaimable — the supervisor
    // launcher kills the child it rejected, so the lease goes stale and
    // `reconcileDockerWorkloadLeases` collects it. A failure AFTER a successful
    // attestation is not: the detached supervisor survives coordinator exit by
    // design and never exits on its own, so its status stays fresh, the lease
    // stays "live", and reconciliation PRESERVES it forever (one leaked
    // supervisor + lease + state tree per failed attempt). So tear it down
    // here, before the proxies, mirroring the teardown-first ordering of
    // `destroyBundleOuterResources`. Safe on the attestation-failure path too:
    // teardown is idempotent and, with the supervisor already gone, closes the
    // lease as coordinator and audits the incident. Best-effort — a teardown
    // fault must not mask the original error.
    await stopDockerWorkloadEgressBestEffort(dockerWorkloadEgress, 'prepareDockerInfrastructure');
    await dockerWorkload
      ?.teardown()
      .catch((err: unknown) =>
        logger.warn(`prepareDockerInfrastructure: dockerWorkload.teardown() failed: ${errorMessage(err)}`),
      );
    // Best-effort cleanup of proxies started above
    await mitmProxy?.stop().catch(() => {});
    await proxy?.stop().catch(() => {});
    await metricsRuntime?.release().catch(() => {});
    // Host-only network was created before the proxies; remove it too.
    // (A leak through the narrow window before this catch is self-healing:
    // createHostOnlyNetwork removes the stale same-named network first.)
    if (hostOnlyNetwork) {
      await docker.removeNetwork(hostOnlyNetwork.name).catch(() => {});
    }
    removeBundleRuntimeRoot(bundleId, 'prepareDockerInfrastructure');
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
    {
      providerProfileName,
      preparedImageResolution: options?.preparedImageResolution,
      proxyAgentKind: workflowId !== undefined ? 'workflow' : 'batch',
    },
  );

  return assembleDockerInfrastructure(core, config, options);
}

/**
 * Finalizes a prepared bundle into a running `DockerInfrastructure`: creates
 * the session containers and provisions workflow dependencies. The shared
 * Apple Docker-workload bootstrap activates an admitted lease immediately
 * before returning from the agent-blocking bootstrap.
 *
 * On any failure an admitted Docker-workload bundle is torn down FIRST (§8.3):
 * `teardown()` removes the ledgered outer resources with absence proofs, so it
 * supersedes the ordinary `cleanupContainers` fallback (which still runs for
 * non-workload bundles). The proxies are always stopped last.
 *
 * Split out from `createDockerInfrastructure` so the §8.2/§8.3
 * create -> bootstrap -> teardown wiring is exercisable with a scripted
 * `PreContainerInfrastructure` without standing up real proxies.
 */
export async function assembleDockerInfrastructure(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
  options?: CreateDockerInfrastructureOptions,
): Promise<DockerInfrastructure> {
  let containerResources: ContainerResources | undefined;
  try {
    containerResources = await createSessionContainers(core, config, options);
    const infra = { ...core, ...containerResources };
    await provisionWorkflowDependencies(infra, config.userConfig.packageInstall.enabled);
    return infra;
  } catch (error) {
    // A create-session failure already revoked these authorities before its
    // partial VM cleanup. Once container resources were returned, this layer
    // owns the later-failure revocation instead. The split avoids both an
    // authority-after-VM rollback window and duplicate stop attempts.
    if (containerResources !== undefined) {
      await stopDockerWorkloadEgressBestEffort(core.dockerWorkloadEgress, 'assembleDockerInfrastructure');
    }
    // §8.3: tear the bundle's outer resources down (teardown-first for a
    // Docker-workload bundle, then the belt-and-braces sweep) and release the
    // managed-resource lease. A create that failed mid-flight already cleaned
    // up its own partial containers/sidecar/network inside
    // createSessionContainers; this covers the later activate()/provision steps.
    await destroyBundleOuterResources({
      docker: core.docker,
      dockerWorkload: core.dockerWorkload,
      containerId: containerResources?.containerId ?? null,
      sidecarContainerId: containerResources?.sidecarContainerId ?? null,
      networkName: containerResources?.internalNetwork ?? null,
      bundleId: core.bundleId,
      context: 'assembleDockerInfrastructure',
    });
    await core.mitmProxy.stop().catch(() => {});
    await core.proxy.stop().catch(() => {});
    await core.metricsRuntime?.release().catch(() => {});
    removeBundleRuntimeRoot(core.bundleId, 'assembleDockerInfrastructure');
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
  // Revoke optional nested-daemon egress authority before touching the VM so
  // no new package/registry request can begin during exact outer teardown.
  await stopDockerWorkloadEgressBestEffort(infra.dockerWorkloadEgress, 'destroyDockerInfrastructure');

  // Containers + sidecar + internal network + managed-resource lease. For an
  // admitted Docker-workload bundle this tears the ledgered resources down
  // through the lease first, then sweeps any non-ledgered sidecar/network; for
  // an ordinary bundle it is the plain cleanup. See destroyBundleOuterResources.
  await destroyBundleOuterResources({
    docker: infra.docker,
    dockerWorkload: infra.dockerWorkload,
    containerId: infra.containerId,
    sidecarContainerId: infra.sidecarContainerId ?? null,
    networkName: infra.internalNetwork ?? null,
    bundleId: infra.bundleId,
    context: 'destroyDockerInfrastructure',
  });

  // Ordinary agent proxies stop after their consumer container. Proxy
  // connections terminate cleanly when the container stops; inverting this
  // part of the order would leave in-flight connections resetting during
  // proxy shutdown. They are independent producers, so stop them in parallel.
  // Each per-promise catch logs so one failure doesn't mask the other, and
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

  await infra.metricsRuntime
    ?.release()
    .catch((err: unknown) => logger.warn(`destroyDockerInfrastructure: metrics flush failed: ${errorMessage(err)}`));

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
  removeBundleRuntimeRoot(infra.bundleId, 'destroyDockerInfrastructure');

  logger.info(`Destroyed Docker infrastructure (container=${infra.containerId.substring(0, 12)})`);
}

/** Best-effort removal of the host-only per-bundle socket directory tree. */
export function removeBundleRuntimeRoot(bundleId: BundleId, context: string): void {
  const runtimeRoot = getBundleRuntimeRoot(bundleId);
  try {
    rmSync(runtimeRoot, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`${context}: rmSync(${runtimeRoot}) failed: ${errorMessage(err)}`);
  }
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
export function buildBundleLabels(
  core: Pick<PreContainerInfrastructure, 'bundleId' | 'workflowId' | 'scope' | 'runtimeKind'>,
): {
  bundleLabel: string;
  workflowLabel?: string;
  scopeLabel?: string;
  labels?: Readonly<Record<string, string>>;
} {
  const managedLabels = core.runtimeKind === 'docker' ? managedResourceLabels(core.bundleId) : undefined;
  const labels = managedLabels
    ? Object.fromEntries(Object.entries(managedLabels).filter(([key]) => key !== 'ironcurtain.bundle'))
    : undefined;
  if (core.workflowId !== undefined) {
    return {
      bundleLabel: core.bundleId,
      workflowLabel: core.workflowId,
      // Resolved scope is set by the orchestrator on every workflow
      // bundle; default-fall back to DEFAULT_CONTAINER_SCOPE so that a
      // workflow bundle always carries a scope label.
      scopeLabel: core.scope ?? DEFAULT_CONTAINER_SCOPE,
      labels,
    };
  }
  return { bundleLabel: core.bundleId, labels };
}

// ---------------------------------------------------------------------------
// Secure nested Docker-workload wiring (§8.2–8.3)
//
// Everything in this section is inert for ordinary sessions: a handle exists
// only for an enabled variant accepted by the resolved-variant guard. The
// helpers keep the §8.2 startup and §8.3 teardown ordering explicit and
// testable end-to-end.
// ---------------------------------------------------------------------------

/**
 * Roles that are ALWAYS the nested daemon/VM component by definition, whatever
 * the topology: a dedicated daemon container exists for no other purpose.
 *
 * Role alone is not the criterion, though — see
 * {@link launchesNestedDaemonComponent}. In the same-VM topology (plan §4.4
 * variant 1, the one currently implemented beneath the fuse) the daemon lives inside the agent's own
 * VM, so the `agent`-role create IS the daemon-component create and the gate
 * must fire for it — while the identical `agent` create in an ordinary session
 * must stay ungated.
 */
const WATCHDOG_GATED_OUTER_ROLES: ReadonlySet<OuterResourceRole> = new Set<OuterResourceRole>(['nested-daemon']);

export interface LedgeredOuterCreateSpec {
  readonly kind: OuterResourceKind;
  readonly role: OuterResourceRole;
  /**
   * True when THIS create is the one that brings the nested Docker daemon into
   * existence, even though its role says otherwise. Set by the same-VM
   * topology, where the daemon is bootstrapped inside the agent container the
   * create produces. Absent for every ordinary session.
   */
  readonly launchesNestedDaemon?: boolean;
  /**
   * Labels the create would carry anyway (e.g. `buildBundleLabels().labels`).
   * The generation ownership label is merged on top before the create runs.
   */
  readonly baseLabels?: Readonly<Record<string, string>>;
  /**
   * Optional post-create adjudication that runs after the immutable runtime ID
   * is durably observed, but before the lifecycle claim is released. A
   * rejection aborts the caller before it can start the object.
   */
  readonly adjudicateObserved?: (immutableId: string) => Promise<void>;
}

/**
 * Whether §8.2 step 4 applies to this create — i.e. whether the watchdog must
 * be proven fresh immediately before it runs. Either the role is intrinsically
 * the daemon component, or the caller declared that this particular create
 * launches it.
 */
function launchesNestedDaemonComponent(spec: LedgeredOuterCreateSpec): boolean {
  return spec.launchesNestedDaemon === true || WATCHDOG_GATED_OUTER_ROLES.has(spec.role);
}

/**
 * Precommit one outer resource to the Docker-workload lease, run the caller's
 * create with the ledgered name + merged ownership labels, then record the
 * runtime-returned immutable ID (§8.2 step 1). Daemon/VM-role creates first
 * prove the watchdog is fresh (§8.2 step 4).
 *
 * `create` receives the precommitted name and the merged labels and returns the
 * immutable ID (for networks, read it back via `listNetworks` — `createNetwork`
 * returns void) plus optional expanded-create evidence for the audit trail.
 */
export async function ledgerOuterResourceCreate(
  handle: DockerWorkloadBundleHandle,
  spec: LedgeredOuterCreateSpec,
  create: (
    name: string,
    ownershipLabels: Readonly<Record<string, string>>,
  ) => Promise<{ readonly id: string; readonly expanded?: ExpandedOuterCreate }>,
): Promise<{ readonly id: string; readonly requestedName: string }> {
  return handle.withOuterCreateClaim(async () => {
    if (launchesNestedDaemonComponent(spec)) handle.assertWatchdogFresh();
    const grant = handle.requestOuterResource(spec.kind, spec.role);
    const labels = spec.baseLabels ? { ...spec.baseLabels, ...grant.labels } : grant.labels;
    const { id, expanded } = await create(grant.requestedName, labels);
    grant.observed(id, expanded);
    await spec.adjudicateObserved?.(id);
    return { id, requestedName: grant.requestedName };
  });
}

export interface CreateAgentContainerOptions {
  /** Present only for an admitted secure nested Docker-workload bundle. */
  readonly dockerWorkload: DockerWorkloadBundleHandle | undefined;
  /**
   * Backend this bundle runs on. Decides — via `resolveNestedDaemonBundle` —
   * whether this agent create is also the §8.2 step-4 daemon-component create,
   * so neither session mode can forget the watchdog gate or apply it to an
   * ordinary session.
   */
  readonly runtimeKind: ContainerRuntimeKind;
  /** Runtime used to inspect and, on failed adjudication, remove the stopped create. */
  readonly runtime: ContainerRuntime;
  /**
   * Prepared immutable image ID expected in an Apple stopped create.
   * Undefined for ordinary sessions.
   */
  readonly expectedImageId?: string;
  /** Deterministic name used when the bundle is not ledgered. */
  readonly deterministicName: string;
  /**
   * Base resource labels the create carries anyway. The single place the
   * generation ownership label is merged on top (in the ledgered case).
   */
  readonly baseLabels: Readonly<Record<string, string>> | undefined;
  /** Bind mounts, recorded as expanded-create evidence for the audit trail. */
  readonly mounts: readonly { readonly source: string; readonly target: string; readonly readonly: boolean }[];
  /**
   * Create the agent container with the given name + final labels (base merged
   * with the ownership label in the ledgered case) and return its runtime ID.
   */
  readonly create: (name: string, labels: Readonly<Record<string, string>> | undefined) => Promise<string>;
}

/**
 * Ledger-or-create the agent container: the shared shape used by the batch
 * (`createSessionContainers`) and PTY (`runPtySession`) paths. When a
 * Docker-workload bundle is admitted the create is ledgered before it runs (the
 * grant supplies the precommitted name + ownership labels and the runtime ID is
 * observed after create, with the mounts recorded as expanded evidence);
 * otherwise the container is created directly with the deterministic name. Label
 * merging lives entirely in `ledgerOuterResourceCreate` via `baseLabels`, so
 * neither call site re-merges the ownership label.
 *
 * In the same-VM topology this create also launches the nested daemon, so it is
 * declared as such and `ledgerOuterResourceCreate` proves the watchdog fresh
 * first (§8.2 step 4). The declaration is derived here, from the handle and the
 * backend, rather than passed in — a caller cannot forget it.
 */
export async function createLedgeredAgentContainer(options: CreateAgentContainerOptions): Promise<string> {
  if (
    options.dockerWorkload !== undefined &&
    options.runtimeKind === 'apple-container' &&
    options.expectedImageId === undefined
  ) {
    throw new Error('admitted Apple Docker workload is missing its prepared immutable image ID');
  }

  const adjudicateObserved = async (containerId: string): Promise<void> => {
    if (options.runtimeKind !== 'apple-container' || options.expectedImageId === undefined) return;
    try {
      await assertAppleStoppedCreateImage(options.runtime, containerId, options.expectedImageId);
    } catch (error) {
      try {
        // The VM has not been started. Remove the exact runtime-returned ID
        // while the lifecycle claim is still held, then let the normal lease
        // teardown prove durable absence.
        await options.runtime.remove(containerId);
      } catch (removeError) {
        throw new AggregateError(
          [error, removeError],
          `Apple stopped-create image adjudication failed and exact removal also failed for ${containerId}`,
          { cause: removeError },
        );
      }
      throw error;
    }
  };

  if (!options.dockerWorkload) {
    const id = await options.create(options.deterministicName, options.baseLabels);
    await adjudicateObserved(id);
    return id;
  }
  const nestedDaemon = resolveNestedDaemonBundle(options.dockerWorkload, options.runtimeKind);
  const { id } = await ledgerOuterResourceCreate(
    options.dockerWorkload,
    {
      kind: 'container',
      role: 'agent',
      launchesNestedDaemon: nestedDaemon !== undefined,
      baseLabels: options.baseLabels,
      adjudicateObserved,
    },
    async (name, labels) => ({ id: await options.create(name, labels), expanded: { mounts: [...options.mounts] } }),
  );
  return id;
}

const SHA256_IMAGE_ID = /^(?:sha256:)?([a-f0-9]{64})$/u;

/**
 * Apple Container 1.1 creates a local image by logical tag, not by its
 * `sha256:` index ID. Close that tag lookup race by inspecting the exact
 * stopped VM and comparing its captured descriptor with the prepared identity
 * before start.
 */
async function assertAppleStoppedCreateImage(
  runtime: ContainerRuntime,
  containerId: string,
  expectedImageId: string,
): Promise<void> {
  const actualImageId = await runtime.getImageId(containerId);
  const expected = SHA256_IMAGE_ID.exec(expectedImageId)?.[1];
  const actual = actualImageId === undefined ? undefined : SHA256_IMAGE_ID.exec(actualImageId)?.[1];
  if (expected === undefined || actual === undefined || actual !== expected) {
    throw new Error(
      `Apple stopped-create image mismatch for ${containerId}: expected ${expectedImageId}, ` +
        `observed ${actualImageId ?? 'missing'}; refusing to start the VM`,
    );
  }
}

/**
 * Build the persisted `SessionMetadata.dockerWorkload` tuple for an admitted
 * bundle (§8.4 audit surface). Pure; the caller supplies the resolved
 * capability config hash and the effective backend so the persisted record is
 * self-describing for post-hoc inspection.
 */
export function dockerWorkloadSessionMetadata(
  handle: DockerWorkloadBundleHandle,
  configHash: string,
  backend: ContainerRuntimeKind,
): NonNullable<SessionMetadata['dockerWorkload']> {
  return {
    leaseId: handle.leaseId,
    generation: handle.generation,
    configHash,
    watchdogPolicySha256: handle.loadedPolicy.sha256,
    backend,
  };
}

/**
 * Select and clamp the aggregate outer-container envelope once for both batch
 * and PTY assembly. An admitted Docker workload owns its explicit VM envelope;
 * ordinary sessions retain the long-standing top-level dockerResources values.
 */
export function selectOuterContainerResources(
  userConfig: Pick<ResolvedUserConfig, 'dockerResources' | 'dockerWorkload'>,
  hostResources?: HostResources,
): ReturnType<typeof clampDockerResources>['effective'] {
  const configured =
    userConfig.dockerWorkload?.enabled === true
      ? {
          memoryMb: userConfig.dockerWorkload.resources.memoryMb,
          cpus: userConfig.dockerWorkload.resources.cpus,
        }
      : userConfig.dockerResources;
  return clampDockerResources(configured, hostResources).effective;
}

interface DockerWorkloadAdmissionForSessionOptions {
  readonly dockerWorkload: Extract<ResolvedDockerWorkloadConfig, { enabled: true }>;
  readonly runtime: ContainerRuntime;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly bundleId: BundleId;
  readonly workspaceRoot: string;
  readonly auditLogPath: string;
  readonly artifact: SelectedAgentArtifact;
}

/**
 * Assemble and drive the §8.2-step-1 admission for a secure nested
 * Docker-workload bundle.
 *
 * The backend gate runs before any lease exists. The already-resolved selected
 * artifact is then hard-linked into the lease without reopening global state.
 */
async function admitDockerWorkloadForSession(options: DockerWorkloadAdmissionForSessionOptions): Promise<{
  readonly handle: DockerWorkloadBundleHandle;
  readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig;
}> {
  const { admitDockerWorkloadBundle } = await import('../docker-workload/infrastructure.js');
  const { createJsonlDockerWorkloadAuditSink } = await import('../docker-workload/lifecycle-evidence.js');
  const { dockerWorkloadConfigHash } = await import('../docker-workload/config.js');
  const { assertNestedDaemonBackendImplemented } = await import('../docker-workload/session-daemon.js');

  assertNestedDaemonBackendImplemented(options.runtimeKind);
  const configHash = dockerWorkloadConfigHash(options.dockerWorkload);
  const packageRoot = getIronCurtainPackageRoot();
  const handle = await admitDockerWorkloadBundle({
    runtime: options.runtime,
    runtimeKind: options.runtimeKind,
    runtimeForKind: (kind) => (kind === options.runtimeKind ? options.runtime : createContainerRuntime(kind)),
    bundleId: String(options.bundleId),
    workspaceRoot: options.workspaceRoot,
    configHash,
    watchdogPolicyTemplatePath: getFrozenWatchdogPolicyTemplatePath(),
    watchdogSupervisorEntrypointPath: resolve(
      packageRoot,
      'dist',
      'docker-workload',
      'resource-watchdog-supervisor-main.js',
    ),
    auditSink: createJsonlDockerWorkloadAuditSink(options.auditLogPath),
  });
  try {
    const bootstrap = stageAppleVmDockerWorkloadBootstrap({
      leaseStagingRoot: handle.stagingRoot,
      artifact: options.artifact,
    });
    return { handle, bootstrap };
  } catch (error) {
    await handle.teardown();
    throw error;
  }
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
 * When `skipRemap` is true this returns an empty mapping so the
 * container runs as the baked `codespace` user from the Dockerfile.
 * Skipped on macOS Docker Desktop (VirtioFS handles UID translation
 * transparently and `--user 0:0` would defeat it) AND on apple-container
 * (virtiofs presents host files as root; the existing sessions work
 * without the Linux renumber-and-drop dance) — i.e., remap is Linux
 * Docker only. Callers pass `runtimeKind === 'apple-container' || useTcp`
 * so apple-container's `uds` topology does not accidentally trip the
 * Linux-only remap.
 *
 * Exported for testability.
 */
export function buildAgentUidRemap(skipRemap: boolean): {
  readonly user: string | undefined;
  readonly env: Record<string, string>;
} {
  if (skipRemap) return { user: undefined, env: {} };
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

/** In-container mount root for the UDS proxies (both runtimes). */
export const CONTAINER_SOCKETS_DIR = '/run/ironcurtain';

/**
 * Returns the `uds`-topology socket mounts for a given runtime. Linux
 * Docker bind-mounts the whole `sockets/` directory (the sockets are
 * shared kernel objects). Apple `container` mounts each socket FILE via
 * `-v` so the runtime creates a per-socket vsock relay — a virtiofs
 * directory share does not carry sockets (verified: `connect()` on a
 * socket inside a shared dir fails ENOTSUP on 1.1.0). Shared by batch
 * (`createSessionContainers`) and PTY (`runPtySession`).
 */
export function buildUdsSocketMounts(
  runtimeKind: ContainerRuntimeKind,
  socketsDir: string,
): { source: string; target: string; readonly: boolean }[] {
  if (runtimeKind === 'apple-container') {
    return [
      { source: resolve(socketsDir, 'proxy.sock'), target: `${CONTAINER_SOCKETS_DIR}/proxy.sock`, readonly: false },
      {
        source: resolve(socketsDir, 'mitm-proxy.sock'),
        target: `${CONTAINER_SOCKETS_DIR}/mitm-proxy.sock`,
        readonly: false,
      },
    ];
  }
  return [{ source: socketsDir, target: CONTAINER_SOCKETS_DIR, readonly: false }];
}

/** Exact Apple-only mounts for the per-bundle nested-Docker egress capabilities. */
export function buildDockerWorkloadEgressMounts(
  core: Pick<PreContainerInfrastructure, 'runtimeKind' | 'dockerWorkloadEgress'>,
): { source: string; target: string; readonly: boolean }[] {
  if (core.dockerWorkloadEgress === undefined) return [];
  if (core.runtimeKind !== 'apple-container') {
    throw new Error('nested-Docker egress listener mounting is implemented only for Apple Container');
  }
  const mounts: { source: string; target: string; readonly: boolean }[] = [
    {
      source: core.dockerWorkloadEgress.registry.socketPath,
      target: APPLE_VM_REGISTRY_EGRESS_SOCKET,
      readonly: false,
    },
  ];
  if (core.dockerWorkloadEgress.networkAccess === 'packages') {
    mounts.push({
      source: core.dockerWorkloadEgress.packages.socketPath,
      target: APPLE_VM_PACKAGE_EGRESS_SOCKET,
      readonly: false,
    });
  }
  return mounts;
}

/** Package-only build/runtime-trust mounts, shared by batch/workflow and PTY containers. */
export function buildDockerBuildShimMounts(
  core: Pick<PreContainerInfrastructure, 'runtimeKind' | 'dockerBuildShim'>,
): { source: string; target: string; readonly: boolean }[] {
  const staging = core.dockerBuildShim;
  if (staging === undefined) return [];
  if (core.runtimeKind !== 'apple-container') {
    throw new Error('nested-Docker build shim mounting is implemented only for Apple Container');
  }
  return staging.artifacts.map(({ source, target, readonly }) => ({ source, target, readonly }));
}

/** Resolve and validate the relay mode encoded by the constructed listeners. */
export function dockerWorkloadEgressNetworkAccess(
  egress: DockerWorkloadEgressCollection | undefined,
): DockerWorkloadNetworkAccess {
  return egress?.networkAccess ?? 'offline';
}

/**
 * Activate the same admitted nested-Docker contract for batch and PTY sessions.
 * Keeping this assembly here prevents the two container-creation paths from
 * drifting on network mode, trust artifacts, or egress-ledger witnesses.
 */
export async function activateAppleVmDockerWorkload(options: {
  readonly runtime: ContainerRuntime;
  readonly containerId: string;
  readonly nestedDaemon: DockerWorkloadBundleHandle | undefined;
  readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig | undefined;
  readonly dockerWorkloadEgress: DockerWorkloadEgressCollection | undefined;
  readonly dockerBuildShim: DockerBuildShimStaging | undefined;
}): Promise<void> {
  const { nestedDaemon, bootstrap, dockerWorkloadEgress, dockerBuildShim } = options;
  if (nestedDaemon === undefined || bootstrap === undefined) return;

  await startAppleVmDockerWorkload({
    runtime: options.runtime,
    containerId: options.containerId,
    nestedDaemon,
    bootstrap,
    networkAccess: dockerWorkloadEgressNetworkAccess(dockerWorkloadEgress),
    dockerBuildShim: dockerBuildShim?.contract,
    dockerBuildTrustCanary: dockerBuildShim?.buildTrustCanary,
    egressLedgers:
      dockerWorkloadEgress?.networkAccess === 'packages'
        ? {
            registry: dockerWorkloadEgress.registry.snapshot,
            packages: dockerWorkloadEgress.packages.snapshot,
          }
        : undefined,
  });
}

/** Stop every constructed authority even when one listener reports a failure. */
export async function stopDockerWorkloadEgress(egress: DockerWorkloadEgressCollection | undefined): Promise<void> {
  if (egress === undefined) return;
  const endpoints = egress.networkAccess === 'packages' ? [egress.packages, egress.registry] : [egress.registry];
  const results = await Promise.allSettled(
    endpoints.map((endpoint) => Promise.resolve().then(() => endpoint.listener.stop())),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason as unknown);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'nested-Docker egress listeners failed to stop');
}

async function stopDockerWorkloadEgressBestEffort(
  egress: DockerWorkloadEgressCollection | undefined,
  context: string,
): Promise<void> {
  await stopDockerWorkloadEgress(egress).catch((err: unknown) =>
    logger.warn(`${context}: nested-Docker egress stop failed: ${errorMessage(err)}`),
  );
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
  /** Exact CLI preflight result, threaded into this one session without re-resolution. */
  readonly preparedImageResolution?: AgentImageResolution;
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
  if (core.runtimeKind === 'docker') {
    await reconcileIronCurtainDockerResourcesBestEffort(core.docker, 'session startup');
  }

  const maxAttempts = core.topology === 'tcp-sidecar' ? 4 : 1;
  return withInternalNetworkAllocationRetry(
    {
      maxAttempts,
      description: 'Internal Docker network',
      reconcile: () => reconcileIronCurtainDockerResourcesBestEffort(core.docker, 'internal network retry'),
    },
    (excludedSubnets, attempt) => createSessionContainersAttempt(core, config, options, excludedSubnets, attempt),
  );
}

async function createSessionContainersAttempt(
  core: PreContainerInfrastructure,
  config: IronCurtainConfig,
  options: CreateDockerInfrastructureOptions | undefined,
  excludedSubnets: ReadonlySet<string>,
  attempt: number,
): Promise<ContainerResources> {
  const shortId = getBundleShortId(core.bundleId);
  const mainContainerName = `${CONTAINER_NAME_PREFIX}${shortId}`;
  // Labels applied to every IronCurtain-owned container (main + sidecar).
  // Workflow-mode bundles carry workflow + scope labels alongside the
  // always-present bundle label; standalone bundles carry only bundle.
  // See `docs/designs/workflow-session-identity.md` §7.
  const bundleLabels = buildBundleLabels(core);

  let mainContainerId: string | undefined;
  let sidecarContainerId: string | undefined;
  let internalNetwork: string | undefined;
  let allocatedNetworkSubnet: string | undefined;

  try {
    // Remove stale main container from a crashed previous session (same session
    // ID means the same deterministic name). Keep this inside the authority-
    // covered rollback region: even a pre-create rejection must revoke both
    // nested egress listeners before any outer cleanup can run.
    await core.docker.removeStaleContainer(mainContainerName);

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
    // Same-VM nested daemon (§4.4 variant 1): present only for an admitted
    // Docker-workload bundle, in which case this agent container both hosts the
    // daemon and reaches it at the VM-local socket. Resolved once here and
    // reused for the env, the ledgered create, and the post-start bootstrap.
    const nestedDaemon = resolveNestedDaemonBundle(core.dockerWorkload, core.runtimeKind);
    const dockerWorkloadBootstrap = core.dockerWorkloadBootstrap;
    if ((nestedDaemon === undefined) !== (dockerWorkloadBootstrap === undefined)) {
      throw new Error('Docker-workload lease and selected-agent artifact staging must be present together');
    }
    if (dockerWorkloadBootstrap !== undefined) {
      mounts.push(appleVmDockerWorkloadArtifactMount(dockerWorkloadBootstrap));
    }
    let env = {
      ...core.adapter.buildEnv(config, core.fakeKeys),
      ...core.adapter.buildBatchEnv?.(config, core.fakeKeys),
      ...buildRuntimeTrustEnv(),
      ...nestedDaemonAgentEnv(nestedDaemon),
    };
    let network: string | null;
    let extraHosts: string[] | undefined;
    // apple-container only (both `uds` and the retained `tcp-hostonly`):
    // the apt proxy config is written into the container via exec after
    // start instead of bind-mounted — see writeAptProxyConfigViaExec for
    // the virtiofs constraints that make the bind mount unworkable.
    let execAptProxyUrl: string | undefined;

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
      execAptProxyUrl = proxyUrl;

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
      writeFileSync(aptProxyPath, renderAptProxyConfig(proxyUrl));
      mounts.push({ source: aptProxyPath, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true });

      // Create a per-session --internal Docker network that blocks internet egress.
      const baseNetworkName = getInternalNetworkName(shortId);
      const networkName = attempt === 1 ? baseNetworkName : `${baseNetworkName}-a${attempt}`;
      const allocatedNetwork = await createIronCurtainInternalNetwork(core.docker, networkName, core.bundleId, {
        excludedSubnets,
      });
      allocatedNetworkSubnet = allocatedNetwork.subnet;
      internalNetwork = networkName;
      network = networkName;
      logger.info(`Allocated internal Docker network ${networkName} at ${allocatedNetwork.subnet}`);

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
      // UDS mode (Linux Docker AND apple-container >= 1.1.0):
      // --network none, proxy sockets mounted at /run/ironcurtain.
      const udsProxyUrl = 'http://127.0.0.1:18080';
      env = {
        ...env,
        HTTPS_PROXY: udsProxyUrl,
        HTTP_PROXY: udsProxyUrl,
      };
      network = null;

      // Write apt proxy config so sudo apt-get routes through the MITM
      // proxy. On apple-container we CANNOT bind-mount this file: it
      // lives inside `orientationDir`, and 1.1.0's virtiofs silently
      // drops a directory share when a file inside that directory is
      // ALSO `-v`-mounted (verified — /etc/ironcurtain vanishes). The
      // exec-based writer runs after start instead. Linux Docker keeps
      // the single-file bind mount.
      if (core.runtimeKind === 'apple-container') {
        execAptProxyUrl = udsProxyUrl;
      } else {
        const aptProxyPathUds = resolve(core.orientationDir, 'apt-proxy.conf');
        writeFileSync(aptProxyPathUds, renderAptProxyConfig(udsProxyUrl));
        mounts.push({
          source: aptProxyPathUds,
          target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy',
          readonly: true,
        });
      }

      // Mount ONLY the per-bundle proxy sockets into the container. The
      // sockets dir lives under a short `~/.ironcurtain/run/<bid12>/`
      // path (see `getBundleSocketsDir`) so host paths stay under
      // `sockaddr_un.sun_path`. Linux mounts the directory; apple-
      // container mounts each socket file so the runtime creates a
      // vsock relay per socket (see buildUdsSocketMounts). The
      // host-only MITM control socket lives in a sibling `host/` dir
      // and is never mounted.
      mounts.push(...buildUdsSocketMounts(core.runtimeKind, core.socketsDir));
    }

    // This capability is independent of the outer provider-proxy topology:
    // Apple mounts registry only for `images`, registry + packages for `packages`,
    // and no nested-Docker egress socket for `offline`.
    mounts.push(...buildDockerWorkloadEgressMounts(core));
    mounts.push(...buildDockerBuildShimMounts(core));

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
    const uidRemap = buildAgentUidRemap(core.runtimeKind === 'apple-container' || core.useTcp);

    // Resource ceilings come from userConfig (defaults: 8 GB / 4 cpus) and
    // are clamped to fit the host. `null` in either field is preserved as
    // "no flag emitted" (see clampDockerResources docs).
    const containerResources = selectOuterContainerResources(config.userConfig);

    // Build the agent container create args for a given name + resolved labels.
    // `labels` is the base bundle labels in the ordinary case and the base merged
    // with the generation ownership label when the create is ledgered — the merge
    // itself lives in createLedgeredAgentContainer, so this closure just forwards.
    const createMainContainer = (name: string, labels: Readonly<Record<string, string>> | undefined): Promise<string> =>
      core.docker.create({
        image: mainImage,
        name,
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
        labels,
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
        // Only an admitted nested-Docker bundle opts out of the OCI
        // masked/read-only path sets; a fully visible /proc is what lets the
        // nested daemon boot AND lets its runc mount procfs for inner
        // containers.
        fullyVisibleProc: nestedDaemon !== undefined,
      });

    // §8.2 step 1: ledger the agent container before create when a
    // Docker-workload bundle is admitted; ordinary sessions keep the
    // deterministic name and create directly. Shared with the PTY path.
    mainContainerId = await createLedgeredAgentContainer({
      dockerWorkload: core.dockerWorkload,
      runtimeKind: core.runtimeKind,
      runtime: core.docker,
      expectedImageId: core.imageResolution?.immutableImageId,
      deterministicName: mainContainerName,
      baseLabels: bundleLabels.labels,
      mounts,
      create: createMainContainer,
    });

    await core.docker.start(mainContainerId);
    logger.info(`Container started: ${mainContainerId.substring(0, 12)}`);

    if (core.runtimeKind === 'docker') {
      await checkDockerContainerWritableStorage(core.docker, mainContainerId);
    }

    // tcp-hostonly: write the apt proxy config inside the container (the
    // Docker topologies bind-mount it; see execAptProxyUrl above).
    if (execAptProxyUrl !== undefined) {
      await writeAptProxyConfigViaExec(core.docker, mainContainerId, execAptProxyUrl);
    }

    // Connectivity check: verify the container can reach host proxies
    // through the internal network. Abort if unreachable. Host-only
    // bundles additionally assert the inverse — internet egress must be
    // blocked — and never fall back to a weaker configuration.
    if (core.topology === 'tcp-hostonly' && core.hostOnlyNetwork !== undefined && core.proxy.port !== undefined) {
      await checkHostOnlyConnectivity(core.docker, mainContainerId, core.hostOnlyNetwork.gateway, core.proxy.port);
    } else if (core.useTcp && internalNetwork !== undefined && core.proxy.port !== undefined) {
      if (core.mitmAddr.port === undefined) {
        throw new Error('tcp-sidecar bundle is missing its MITM proxy port');
      }
      try {
        await checkInternalNetworkConnectivity(core.docker, mainContainerId, core.proxy.port, core.mitmAddr.port);
      } catch (error) {
        if (error instanceof InternalNetworkConnectivityError) {
          throw new InternalNetworkConnectivityError(error.message, allocatedNetworkSubnet);
        }
        throw error;
      }
    }

    // Same-VM activation: the container that just started IS the daemon
    // component. Bootstrap/adjudicate dockerd, preflight the pinned client,
    // provision the selected prepared inner image, record observations, and
    // activate the lease before any agent process is exec'd into it.
    await activateAppleVmDockerWorkload({
      runtime: core.docker,
      containerId: mainContainerId,
      nestedDaemon,
      bootstrap: dockerWorkloadBootstrap,
      dockerWorkloadEgress: core.dockerWorkloadEgress,
      dockerBuildShim: core.dockerBuildShim,
    });

    return {
      containerId: mainContainerId,
      containerName: mainContainerName,
      sidecarContainerId,
      internalNetwork,
    };
  } catch (err) {
    // Revoke nested egress before removing a partial outer VM. This ordering is
    // the same for daemon bootstrap, build-trust preflight/canary, and activate
    // failures: no new registry/package request can race exact VM teardown.
    await stopDockerWorkloadEgressBestEffort(core.dockerWorkloadEgress, 'createSessionContainers');
    // Best-effort cleanup of any resources created before the failure.
    // All three resources are assigned as soon as `docker.create()` returns
    // (before any subsequent start or connectivity check), so failures at
    // any point inside the try block clean up whatever was created.
    await cleanupContainers(core.docker, {
      containerId: mainContainerId ?? null,
      sidecarContainerId: sidecarContainerId ?? null,
      networkName: internalNetwork ?? null,
    });
    if (core.runtimeKind === 'docker') releaseManagedResourceLease(core.bundleId);
    throw err;
  }
}

/**
 * Probes whether the container can reach host-side proxies via the socat
 * sidecar on the internal Docker network. Throws a descriptive error if not.
 */
export async function checkInternalNetworkConnectivity(
  docker: ContainerRuntime,
  containerId: string,
  mcpPort: number,
  mitmPort: number,
): Promise<void> {
  const mcpResult = await docker.exec(
    containerId,
    [
      '/bin/sh',
      '-c',
      `printf 'IRONCURTAIN_HEALTH/1\\n' | socat -T5 - TCP:${DOCKER_HOST_GATEWAY}:${mcpPort},connect-timeout=5 | grep -q '^IRONCURTAIN_OK/1'`,
    ],
    // Allow a small buffer above socat's 5s connect-timeout for docker exec/process startup overhead.
    6_000,
  );
  if (mcpResult.exitCode !== 0) {
    throw new InternalNetworkConnectivityError(
      `Internal network connectivity check failed: MCP round-trip exited ${mcpResult.exitCode}; ` +
        `the sidecar could not reach the host proxy.`,
    );
  }

  const healthRequest =
    'GET http://ironcurtain.invalid/__ironcurtain/health HTTP/1.1\\r\\n' +
    'Host: ironcurtain.invalid\\r\\nConnection: close\\r\\n\\r\\n';
  const mitmResult = await docker.exec(
    containerId,
    [
      '/bin/sh',
      '-c',
      `printf '${healthRequest}' | socat -T5 - TCP:${DOCKER_HOST_GATEWAY}:${mitmPort},connect-timeout=5 | grep -q 'IRONCURTAIN_OK/1'`,
    ],
    6_000,
  );
  if (mitmResult.exitCode !== 0) {
    throw new InternalNetworkConnectivityError(
      `Internal network connectivity check failed: MITM round-trip exited ${mitmResult.exitCode}; ` +
        `the sidecar could not reach the host proxy.`,
    );
  }
}

/**
 * Verifies that Docker's writable layer has space before an agent starts.
 * Docker Desktop can keep creating/starting containers after its VM disk is
 * full, while writes inside the container fail with ENOSPC. Claude Code then
 * exits 0 with no output after its initialization timeout, which otherwise
 * looks like a networking failure.
 */
export async function checkDockerContainerWritableStorage(
  docker: ContainerRuntime,
  containerId: string,
): Promise<void> {
  const result = await docker.exec(
    containerId,
    ['/bin/sh', '-c', 'probe="${HOME:-/home/codespace}/.ironcurtain-write-probe-$$"; mkdir "$probe" && rmdir "$probe"'],
    5_000,
  );
  if (result.exitCode === 0) return;

  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  const guidance = /ENOSPC|no space left on device/i.test(detail)
    ? 'Docker storage may be full; inspect it with `docker system df` and reclaim unused data or increase the disk limit.'
    : 'Inspect the container state, Docker daemon logs, and filesystem permissions.';
  throw new Error(`Docker container writable storage check failed: ${detail}. ${guidance}`);
}

/**
 * Writes /etc/apt/apt.conf.d/90-ironcurtain-proxy inside a running
 * container via exec (as root). Used by apple-container in both batch
 * and PTY modes — the single-file bind mount the Docker topologies use
 * is unworkable there: on `tcp-hostonly` (pre-1.1.0) `--mount` rejected
 * non-directory sources, and on `uds` (1.1.0+) a `-v <dir>/file` mount
 * whose source nests under the already-shared orientation dir silently
 * drops that dir share. The URL is built from IronCurtain's own
 * gateway/loopback address and OS-assigned port — runtime-generated
 * values, not untrusted input — so embedding it in the sh script is
 * safe.
 */
export async function writeAptProxyConfigViaExec(
  docker: ContainerRuntime,
  containerId: string,
  proxyUrl: string,
): Promise<void> {
  const content = renderAptProxyConfig(proxyUrl);
  const aptWrite = await docker.exec(
    containerId,
    ['sh', '-c', 'printf %s "$1" > /etc/apt/apt.conf.d/90-ironcurtain-proxy', 'sh', content],
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
export async function ensureDockerImage(
  agentId: AgentId,
  userConfig: ResolvedUserConfig,
): Promise<AgentImageResolution> {
  let admittedRuntimeKind: ContainerRuntimeKind | undefined;
  if (userConfig.dockerWorkload?.enabled === true) {
    const { resolveRuntimeKind } = await import('./container-runtime.js');
    admittedRuntimeKind = await resolveRuntimeKind(userConfig.containerRuntime);
    const { assertDockerWorkloadVariantAdmitted, assertAdmittedDockerWorkloadRuntimeAvailable } =
      await import('../docker-workload/config.js');
    assertDockerWorkloadVariantAdmitted(userConfig.dockerWorkload, admittedRuntimeKind);
    await assertAdmittedDockerWorkloadRuntimeAvailable();
  }
  const { registerBuiltinAdapters, getAgent } = await import('./agent-registry.js');
  const { createContainerRuntime, resolveRuntimeKind } = await import('./container-runtime.js');

  await registerBuiltinAdapters(userConfig);
  const adapter = getAgent(agentId);
  const image = await adapter.getImage();
  const runtimeKind = admittedRuntimeKind ?? (await resolveRuntimeKind(userConfig.containerRuntime));
  const docker = createContainerRuntime(runtimeKind);
  const resolved = await resolveAgentImage(image, docker);
  if (userConfig.dockerWorkload?.enabled === true) {
    const artifact = await prepareSelectedAgentArtifact({
      runtime: docker,
      logicalName: image,
      buildHash: resolved.buildHash,
    });
    return selectedAgentImageResolution(resolved, artifact);
  }
  return resolved;
}

function selectedAgentImageResolution(
  built: AgentImageResolution,
  artifact: SelectedAgentArtifact,
): AgentImageResolution {
  return {
    mode: 'selected-agent-artifact',
    logicalName: built.logicalName,
    imageRef: built.logicalName,
    buildHash: built.buildHash,
    immutableImageId: artifact.appleImageId,
    artifact,
  };
}

function assertPreparedImageResolution(
  resolution: AgentImageResolution,
  expectedLogicalName: string,
  requireSelectedArtifact: boolean,
): void {
  if (resolution.logicalName !== expectedLogicalName || resolution.imageRef !== expectedLogicalName) {
    throw new Error(`prepared agent image does not match selected agent: ${expectedLogicalName}`);
  }
  if (!requireSelectedArtifact) return;
  if (
    resolution.mode !== 'selected-agent-artifact' ||
    resolution.artifact === undefined ||
    resolution.immutableImageId !== resolution.artifact.appleImageId ||
    resolution.buildHash !== resolution.artifact.buildHash ||
    resolution.logicalName !== resolution.artifact.logicalName
  ) {
    throw new Error('prepared nested Docker agent image is incomplete or internally inconsistent');
  }
}

/**
 * Builds `image` from a fresh temp directory populated with the contents of
 * `dockerDir`. Building from a clean
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
): Promise<void> {
  const tmpContext = mkdtempSync(resolve(tmpdir(), 'ironcurtain-build-'));
  try {
    for (const entry of readdirSync(dockerDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.isFile()) throw new Error(`unsupported Docker build-context entry: ${entry.name}`);
      copyFileSync(resolve(dockerDir, entry.name), resolve(tmpContext, entry.name));
    }
    await docker.buildImage(image, resolve(tmpContext, dockerfile), tmpContext, labels);
  } finally {
    rmSync(tmpContext, { recursive: true, force: true });
  }
}

/**
 * `${image}@${buildHash}` keys whose baked CLI version has already been logged
 * this process, so the diagnostic probe (a throwaway `docker run --version`)
 * runs at most once per built image rather than on every session/workflow-state.
 * Keyed by build hash — not the tag alone — so a same-process rebuild (which
 * keeps the `:latest` tag but changes `ironcurtain.build-hash`) re-probes and
 * re-logs the possibly-changed version, which is the whole point of surfacing
 * drift.
 */
const loggedAgentVersions = new Set<string>();

/**
 * Best-effort: log the agent CLI version baked into `image`. The agent CLI is
 * installed UNPINNED in the Docker image, so any change to a hashed build input
 * (Dockerfile / *.sh) rebuilds the image and can silently pull a newer agent —
 * see issue #367, where a Claude Code minor bump flipped subagents to run in the
 * background, breaking the one-shot `claude -p` workflow model. Surfacing the
 * resolved version makes that drift visible. Skipped when the adapter defines no
 * probe or the runtime can't run an ephemeral container; never throws.
 */
async function logResolvedAgentVersion(
  runtime: ContainerRuntime,
  image: string,
  buildHash: string,
  versionProbe: readonly string[] | undefined,
): Promise<void> {
  if (!versionProbe || versionProbe.length === 0 || !runtime.probeImageVersion) return;
  const cacheKey = `${image}@${buildHash}`;
  if (loggedAgentVersions.has(cacheKey)) return;
  loggedAgentVersions.add(cacheKey);
  try {
    const version = await runtime.probeImageVersion(image, versionProbe);
    if (version) {
      logger.info(`[docker] ${image} agent version (unpinned): ${version}`);
    }
  } catch {
    // Diagnostic only — never disturb infra prep.
  }
}

interface AgentImageBuildSpec {
  readonly dockerDir: string;
  readonly baseDockerfile: string;
  readonly baseImage: string;
  readonly baseBuildHash: string;
  readonly agentDockerfile: string;
  readonly agentBuildHash: string;
}

/** Resolve an agent image through exactly one trusted image mode. */
export async function resolveAgentImage(image: string, docker: ContainerRuntime): Promise<AgentImageResolution> {
  const spec = computeAgentImageBuildSpec(image);
  const buildHash = await ensureImageFromSpec(image, docker, spec);
  return { mode: 'build-if-stale', logicalName: image, imageRef: image, buildHash };
}

function computeAgentImageBuildSpec(image: string): AgentImageBuildSpec {
  const packageRoot = getIronCurtainPackageRoot();
  const dockerDir = resolve(packageRoot, 'docker');

  // On arm64 hosts (Apple Silicon), use the lightweight arm64-native Dockerfile
  const baseDockerfile =
    arch() === 'arm64' && existsSync(resolve(dockerDir, 'Dockerfile.base.arm64'))
      ? 'Dockerfile.base.arm64'
      : 'Dockerfile.base';

  // Agent images are CA-neutral. Session-specific public trust is staged in
  // the read-only orientation mount by stageRuntimeTrust().
  const baseImage = 'ironcurtain-base:latest';
  const baseBuildHash = computeDockerBuildHash(dockerDir, [baseDockerfile]);

  const agentName = image.replace(CONTAINER_NAME_PREFIX, '').replace(':latest', '');
  const agentDockerfile = `Dockerfile.${agentName}`;
  const agentDockerfilePath = resolve(dockerDir, agentDockerfile);
  if (!existsSync(agentDockerfilePath)) {
    throw new Error(`Dockerfile not found for agent "${agentName}": ${agentDockerfilePath}`);
  }
  const agentBuildHash = computeDockerBuildHash(dockerDir, [agentDockerfile], baseBuildHash);
  return { dockerDir, baseDockerfile, baseImage, baseBuildHash, agentDockerfile, agentBuildHash };
}

/** Exact build hash recorded on the current checked-in agent image. */
export function computeAgentImageBuildHash(image: string): string {
  return computeAgentImageBuildSpec(image).agentBuildHash;
}

async function ensureImageFromSpec(
  image: string,
  docker: ContainerRuntime,
  spec: AgentImageBuildSpec,
): Promise<string> {
  // The agent hash incorporates the base hash. A current selected agent is
  // therefore self-sufficient even when the base tag was not staged (the
  // selected OCI archive already carries its base layers).
  if (!(await isImageStale(image, docker, spec.agentBuildHash))) return spec.agentBuildHash;

  await ensureBaseImage(spec.baseImage, docker, spec.dockerDir, spec.baseDockerfile, spec.baseBuildHash);
  logger.info(`Building Docker image ${image}...`);
  await buildImageFromCleanContext(docker, image, spec.dockerDir, spec.agentDockerfile, {
    'ironcurtain.build-hash': spec.agentBuildHash,
  });
  logger.info(`Docker image ${image} built successfully`);

  return spec.agentBuildHash;
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
  dockerDir: string,
  dockerfile: string,
  buildHash: string,
): Promise<void> {
  if (!(await isImageStale(baseImage, docker, buildHash))) return;

  logger.info('Building base Docker image (this may take a while on first run)...');

  await buildImageFromCleanContext(docker, baseImage, dockerDir, dockerfile, {
    'ironcurtain.build-hash': buildHash,
  });
  logger.info('Base Docker image built successfully');
}

async function isImageStale(image: string, docker: ContainerRuntime, expectedHash: string): Promise<boolean> {
  const storedHash = await docker.getImageLabel(image, 'ironcurtain.build-hash');
  return storedHash !== expectedHash;
}

export function computeDockerBuildHash(dockerDir: string, dockerfiles: string[], parentHash?: string): string {
  const hash = createHash('sha256');

  const files = readdirSync(dockerDir).sort();
  for (const file of files) {
    const isAppleVmRelayInput = file === 'apple-vm-egress-relay.mjs' && dockerfiles.includes('Dockerfile.base.arm64');
    if (dockerfiles.includes(file) || file.endsWith('.sh') || isAppleVmRelayInput) {
      hash.update(`file:${file}\n`);
      hash.update(readFileSync(resolve(dockerDir, file)));
    }
  }

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
