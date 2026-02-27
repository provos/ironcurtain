/**
 * Session orientation preparation.
 *
 * Generates MCP client configuration and system prompt for the
 * agent container. Written to the orientation directory which is
 * bind-mounted read-only into the container.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { AgentAdapter, AgentConfigFile, OrientationContext } from './agent-adapter.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { ServerListing } from '../session/prompts.js';

/**
 * Extracts allowed domains from MCP server configurations.
 * Used to inform the agent about which domains it can access via MCP tools.
 */
export function extractAllowedDomains(config: IronCurtainConfig): string[] {
  const domains = new Set<string>();
  for (const serverConfig of Object.values(config.mcpServers)) {
    const sandbox = serverConfig.sandbox;
    if (!sandbox || typeof sandbox !== 'object') continue;
    const network = sandbox.network;
    if (!network || typeof network !== 'object') continue;
    for (const domain of network.allowedDomains) {
      domains.add(domain);
    }
  }
  return [...domains];
}

/**
 * Writes a set of AgentConfigFiles into the given base directory,
 * creating intermediate directories as needed.
 */
function writeConfigFiles(baseDir: string, files: AgentConfigFile[]): void {
  for (const file of files) {
    const targetPath = resolve(baseDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, file.content);
  }
}

/**
 * Prepares the session's orientation directory and builds the system prompt.
 *
 * 1. Generates MCP client config via adapter (written to orientation dir)
 * 2. Builds the system prompt via adapter (returned for per-turn injection)
 */
export function prepareSession(
  adapter: AgentAdapter,
  serverListings: ServerListing[],
  sessionDir: string,
  config: IronCurtainConfig,
  hostSandboxDir: string,
  proxyAddress?: string,
): { systemPrompt: string } {
  const orientationDir = resolve(sessionDir, 'orientation');
  mkdirSync(orientationDir, { recursive: true });

  const context: OrientationContext = {
    workspaceDir: '/workspace',
    hostSandboxDir,
    serverListings,
    allowedDomains: extractAllowedDomains(config),
    networkMode: proxyAddress ? 'bridge' : 'none',
  };

  // proxyAddress is either a TCP host:port (macOS) or defaults to the UDS path (Linux)
  const address = proxyAddress ?? '/run/ironcurtain/proxy.sock';
  writeConfigFiles(orientationDir, adapter.generateMcpConfig(address));
  writeConfigFiles(orientationDir, adapter.generateOrientationFiles(context));

  const systemPrompt = adapter.buildSystemPrompt(context);
  return { systemPrompt };
}
