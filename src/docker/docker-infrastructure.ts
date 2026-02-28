/**
 * Shared Docker session infrastructure setup.
 *
 * Extracts the common setup steps (session dirs, proxies, orientation,
 * CA, fake keys, image) used by both the standard DockerAgentSession
 * and the PTY session module.
 */

import { resolve } from 'node:path';
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
  const { getIronCurtainHome, getSessionSocketsDir } = await import('../config/paths.js');
  const { prepareSession } = await import('./orientation.js');
  const { mkdirSync } = await import('node:fs');

  await registerBuiltinAdapters();
  const adapter = getAgent(mode.agent);
  const useTcp = useTcpTransport();

  const socketsDir = getSessionSocketsDir(sessionId);
  mkdirSync(socketsDir, { recursive: true });

  const socketPath = resolve(socketsDir, 'proxy.sock');

  const proxy = createCodeModeProxy({
    socketPath,
    config,
    listenMode: useTcp ? 'tcp' : 'uds',
  });

  // Load or generate the IronCurtain CA for TLS termination
  const caDir = resolve(getIronCurtainHome(), 'ca');
  const ca = loadOrCreateCA(caDir);

  // Generate fake keys and build provider key mappings
  const providers = adapter.getProviders();
  const fakeKeys = new Map<string, string>();
  const providerMappings: ProviderKeyMapping[] = [];
  for (const providerConfig of providers) {
    const fakeKey = generateFakeKey(providerConfig.fakeKeyPrefix);
    fakeKeys.set(providerConfig.host, fakeKey);

    const realKey = resolveRealApiKey(providerConfig.host, config);
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

  // Build orientation
  const helpData = proxy.getHelpData();
  const serverListings = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
    name,
    description,
  }));
  logger.info(`Available servers: ${serverListings.map((s) => s.name).join(', ')}`);

  const proxyAddress = useTcp && proxy.port !== undefined ? `host.docker.internal:${proxy.port}` : undefined;
  const { systemPrompt } = prepareSession(adapter, serverListings, sessionDir, config, sandboxDir, proxyAddress);

  // Ensure Docker image
  const image = await adapter.getImage();

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
  };
}

/**
 * Resolves the real API key for a provider host from config.
 */
function resolveRealApiKey(host: string, config: IronCurtainConfig): string {
  let key: string;
  switch (host) {
    case 'api.anthropic.com':
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
