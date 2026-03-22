/**
 * Proxy-based MCP connections for dynamic list resolution.
 *
 * Spawns the MCP proxy server as a child process configured with the
 * read-only policy. The proxy handles OAuth credentials, policy mediation,
 * token refresh, and sandbox containment internally -- the caller gets
 * a simple MCP client with pre-filtered tools.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { permissiveJsonSchemaValidator } from '../trusted-process/permissive-output-validator.js';
import { resolveNodeModulesBin } from '../trusted-process/sandbox-integration.js';
import { getReadOnlyPolicyDir } from '../config/paths.js';
import { loadUserConfig } from '../config/user-config.js';
import { VERSION } from '../version.js';
import type { MCPServerConfig } from '../config/types.js';
import type { ListDefinition } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isCompiled = __filename.endsWith('.js');

const proxyServerPath = resolve(__dirname, `../trusted-process/mcp-proxy-server.${isCompiled ? 'js' : 'ts'}`);
const tsxBin = resolveNodeModulesBin('tsx', resolve(__dirname, '..', '..'));
const PROXY_COMMAND = isCompiled ? 'node' : tsxBin;

export interface ProxyConnection {
  readonly client: Client;
  readonly tools: Tool[];
  readonly shutdown: () => Promise<void>;
}

/**
 * Determines which MCP servers are needed by the list definitions.
 * Returns a filtered server config containing only the needed servers.
 */
function selectNeededServers(
  definitions: ListDefinition[],
  mcpServers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  const mcpDefs = definitions.filter((d) => d.requiresMcp);
  if (mcpDefs.length === 0) return {};

  const hasUnhintedLists = mcpDefs.some((d) => !d.mcpServerHint);

  const neededNames = hasUnhintedLists
    ? new Set(Object.keys(mcpServers))
    : new Set(
        mcpDefs
          .filter((d): d is typeof d & { mcpServerHint: string } => d.mcpServerHint != null)
          .map((d) => d.mcpServerHint),
      );

  const filtered: Record<string, MCPServerConfig> = {};
  for (const name of neededNames) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- name may come from mcpServerHint and not exist in mcpServers
    if (mcpServers[name]) {
      filtered[name] = mcpServers[name];
    }
  }
  return filtered;
}

/**
 * Builds the environment variables for the proxy child process.
 */
function buildProxyEnv(
  neededServers: Record<string, MCPServerConfig>,
  toolAnnotationsDir: string,
): Record<string, string> {
  const userConfig = loadUserConfig();

  // Flatten per-server credentials for all needed servers into a single object.
  // The proxy receives all of them and applies per-server via SERVER_FILTER internally
  // (but since we're not using SERVER_FILTER here, all are available).
  const flatCredentials: Record<string, string> = {};
  for (const serverName of Object.keys(neededServers)) {
    const creds = userConfig.serverCredentials[serverName] as Record<string, string> | undefined;
    if (creds) {
      Object.assign(flatCredentials, creds);
    }
  }

  const env: Record<string, string> = {
    // Inherit the parent process environment
    ...(process.env as Record<string, string>),
    // Required proxy env vars
    GENERATED_DIR: getReadOnlyPolicyDir(),
    TOOL_ANNOTATIONS_DIR: toolAnnotationsDir,
    MCP_SERVERS_CONFIG: JSON.stringify(neededServers),
    PROTECTED_PATHS: JSON.stringify([]),
    AUDIT_LOG_PATH: '/dev/null',
    SANDBOX_POLICY: 'warn',
    // Pass server credentials
    SERVER_CREDENTIALS: JSON.stringify(flatCredentials),
  };

  // Do NOT set ESCALATION_DIR -- single-shot mode auto-denies escalations
  // Note: proxy falls back to getPackageGeneratedDir() for annotations, ignoring toolAnnotationsFallbackDir

  return env;
}

/**
 * Spawns the MCP proxy server as a child process and connects to it
 * as an MCP client. The proxy loads the read-only policy and mediates
 * all tool calls through the policy engine.
 *
 * Returns a connected client, its available tools, and a shutdown function.
 */
export async function connectViaProxy(
  definitions: ListDefinition[],
  mcpServers: Record<string, MCPServerConfig>,
  toolAnnotationsDir: string,
): Promise<ProxyConnection> {
  const neededServers = selectNeededServers(definitions, mcpServers);

  const env = buildProxyEnv(neededServers, toolAnnotationsDir);

  const transport = new StdioClientTransport({
    command: PROXY_COMMAND,
    args: [proxyServerPath],
    env,
    stderr: 'pipe',
  });

  // Drain piped stderr to prevent backpressure
  if (transport.stderr) {
    transport.stderr.on('data', () => {});
  }

  const client = new Client(
    { name: 'ironcurtain-list-resolver-proxy', version: VERSION },
    { jsonSchemaValidator: permissiveJsonSchemaValidator },
  );

  const shutdown = async () => {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  try {
    await client.connect(transport);
    const toolsResult = await client.listTools();
    return { client, tools: toolsResult.tools, shutdown };
  } catch (err) {
    await shutdown();
    throw err;
  }
}
