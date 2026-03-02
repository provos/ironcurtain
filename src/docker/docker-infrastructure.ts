/**
 * Shared Docker session infrastructure setup.
 *
 * Extracts the common setup steps (session dirs, proxies, orientation,
 * CA, fake keys, image) used by both the standard DockerAgentSession
 * and the PTY session module.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { IronCurtainConfig } from '../config/types.js';
import type { SessionMode } from '../session/types.js';
import type { AgentAdapter } from './agent-adapter.js';
import type { DockerProxy } from './code-mode-proxy.js';
import type { MitmProxy } from './mitm-proxy.js';
import type { CertificateAuthority } from './ca.js';
import type { DockerManager } from './types.js';
import type { ProviderKeyMapping } from './mitm-proxy.js';
import * as logger from '../logger.js';

/** All the infrastructure created during Docker session setup. */
export interface DockerInfrastructure {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
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
}

/**
 * Prepares all Docker infrastructure needed to run a session.
 *
 * This is the shared setup logic used by both createDockerSession()
 * and runPtySession(). After calling this, the caller diverges:
 * - Standard mode: creates DockerAgentSession (sleep infinity + docker exec)
 * - PTY mode: attaches terminal directly via socat + Node.js PTY proxy
 */
export async function prepareDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  sessionDir: string,
  sandboxDir: string,
  escalationDir: string,
  auditLogPath: string,
  sessionId: string,
): Promise<DockerInfrastructure> {
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
  const { mkdirSync } = await import('node:fs');

  const { detectAuthMethod } = await import('./oauth-credentials.js');

  await registerBuiltinAdapters();
  const adapter = getAgent(mode.agent);
  const useTcp = useTcpTransport();

  // Detect authentication method. When preflight already determined the auth kind,
  // pass it as a hint to skip potentially slow/interactive sources (e.g., macOS
  // Keychain) that were already checked during preflight.
  const authMethod = detectAuthMethod(config);
  if (authMethod.kind === 'none') {
    throw new Error(
      'No credentials available for Docker session. ' + 'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.',
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
  const oauthAccessToken = authMethod.kind === 'oauth' ? authMethod.credentials.accessToken : undefined;
  const providers = adapter.getProviders(authKind);
  const fakeKeys = new Map<string, string>();
  const providerMappings: ProviderKeyMapping[] = [];
  for (const providerConfig of providers) {
    const fakeKey = generateFakeKey(providerConfig.fakeKeyPrefix);
    fakeKeys.set(providerConfig.host, fakeKey);

    const realKey = resolveRealKey(providerConfig.host, config, oauthAccessToken);
    providerMappings.push({ config: providerConfig, fakeKey, realKey });
  }

  const mitmProxy = useTcp
    ? createMitmProxy({
        listenPort: 0,
        ca,
        providers: providerMappings,
      })
    : createMitmProxy({
        socketPath: resolve(socketsDir, 'mitm-proxy.sock'),
        ca,
        providers: providerMappings,
      });

  const docker = createDockerManager();

  // Start proxies
  await proxy.start();
  if (useTcp && proxy.port !== undefined) {
    logger.info(`Code Mode proxy listening on 127.0.0.1:${proxy.port}`);
  } else {
    logger.info(`Code Mode proxy listening on ${proxy.socketPath}`);
  }

  const mitmAddr = await mitmProxy.start();
  if (mitmAddr.port !== undefined) {
    logger.info(`MITM proxy listening on 127.0.0.1:${mitmAddr.port}`);
  } else {
    logger.info(`MITM proxy listening on ${mitmAddr.socketPath}`);
  }

  // Remaining setup steps can fail -- clean up started proxies on error.
  try {
    // Build orientation
    const helpData = proxy.getHelpData();
    const serverListings = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
      name,
      description,
    }));
    logger.info(`Available servers: ${serverListings.map((s) => s.name).join(', ')}`);

    const proxyAddress = useTcp && proxy.port !== undefined ? `host.docker.internal:${proxy.port}` : undefined;
    const { systemPrompt } = prepareSession(adapter, serverListings, sessionDir, config, sandboxDir, proxyAddress);

    // Ensure Docker image is built and up-to-date
    const image = await adapter.getImage();
    await ensureImage(image, docker, ca);

    const orientationDir = resolve(sessionDir, 'orientation');

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
    };
  } catch (error) {
    // Best-effort cleanup of proxies started above
    await mitmProxy.stop().catch(() => {});
    await proxy.stop().catch(() => {});
    throw error;
  }
}

/**
 * Resolves the real credential for a provider host.
 *
 * For Anthropic hosts in OAuth mode, uses the OAuth access token.
 * For all other cases, falls back to the API key from config.
 */
function resolveRealKey(host: string, config: IronCurtainConfig, oauthAccessToken: string | undefined): string {
  // OAuth access token replaces API key for Anthropic hosts
  if (oauthAccessToken && (host === 'api.anthropic.com' || host === 'platform.claude.com')) {
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
 * Ensures the Docker image exists and is up-to-date, building it
 * (and the base image) if needed.
 *
 * Extracted from DockerAgentSession.ensureImage() so both standard
 * and PTY paths can use it.
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
  const agentName = image.replace('ironcurtain-', '').replace(':latest', '');
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
