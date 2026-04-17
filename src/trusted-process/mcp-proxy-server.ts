/**
 * MCP Proxy Server -- Standalone MCP subprocess for Code Mode.
 *
 * Runs as a child process spawned by MCPClientManager. Acts as a pure
 * MCP pass-through relay: connects to real MCP backend servers and
 * forwards tool calls without any policy evaluation. The coordinator
 * in the parent process owns the full security pipeline.
 *
 * Responsibilities:
 *   - MCP transport setup (stdio/UDS/TCP)
 *   - Backend MCP server connection (StdioClientTransport)
 *   - OAuth credential injection and TokenFileRefresher
 *   - Sandbox-runtime wrapping (srt)
 *   - ListTools handler (raw pass-through)
 *   - CallTool handler (pure forward to backend)
 *   - Virtual proxy tools (MITM_CONTROL_ADDR)
 *   - Tool description hints injection
 *
 * Configuration via environment variables:
 *   MCP_SERVERS_CONFIG -- JSON string of MCP server configs to proxy
 *   GENERATED_DIR      -- path to the generated artifacts directory
 *   PROTECTED_PATHS    -- JSON array of protected paths
 *   ALLOWED_DIRECTORY  -- (optional) sandbox directory
 *   SESSION_LOG_PATH   -- (optional) path for capturing child process stderr
 *   SANDBOX_POLICY     -- (optional) "enforce" | "warn" (default: "warn")
 *   SERVER_FILTER      -- (optional) only connect to this single server name
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UdsServerTransport } from './uds-server-transport.js';
import { TcpServerTransport } from './tcp-server-transport.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequestSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { loadGeneratedPolicy, getPackageGeneratedDir } from '../config/index.js';
import { expandTilde } from '../types/argument-roles.js';
import { extractPolicyRoots, toMcpRoots } from './policy-roots.js';
import {
  checkSandboxAvailability,
  resolveSandboxConfig,
  writeServerSettings,
  wrapServerCommand,
  cleanupSettingsFiles,
  discoverNodePaths,
  rewriteServerSettings,
  type ResolvedSandboxConfig,
} from './sandbox-integration.js';
import { extractMcpErrorMessage } from './mcp-error-utils.js';
import { permissiveJsonSchemaValidator } from './permissive-output-validator.js';
import type { MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';
import { VERSION } from '../version.js';
import { loadToolDescriptionHints, applyToolDescriptionHints } from './tool-description-hints.js';
import { getProviderForServer } from '../auth/oauth-registry.js';
import { loadClientCredentials } from '../auth/oauth-provider.js';
import { OAuthTokenProvider } from '../auth/oauth-token-provider.js';
import { loadOAuthToken } from '../auth/oauth-token-store.js';
import { writeGWorkspaceCredentialFile } from './gworkspace-credentials.js';
import { TokenFileRefresher } from './token-file-refresher.js';
import {
  proxyAnnotations,
  proxyPolicyRules,
  proxyToolDefinitions,
  handleVirtualProxyTool,
  createControlApiClient,
  type ControlApiClient,
} from '../docker/proxy-tools.js';

import { type ProxiedTool, type ClientState, buildToolMap } from './tool-call-pipeline.js';

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

/** Appends a timestamped line to the session log file. */
function logToSessionFile(sessionLogPath: string, message: string): void {
  const timestamp = new Date().toISOString();
  try {
    appendFileSync(sessionLogPath, `${timestamp} INFO  ${message}\n`);
  } catch {
    /* ignore write failures */
  }
}

/**
 * Detects Docker-style `-e VAR_NAME` args (no `=`) where the env var is unset.
 * Returns the names of missing variables, or an empty array if all are present.
 */
function getMissingEnvVars(args: string[]): string[] {
  const missing: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && i + 1 < args.length) {
      const val = args[i + 1];
      // "-e VAR_NAME" (no =) means forward from host env; "-e VAR=value" sets explicitly
      if (!val.includes('=') && !process.env[val]) {
        missing.push(val);
      }
      i++; // skip the value arg
    }
  }
  return missing;
}

/**
 * Replaces known credential values in a string with `***REDACTED***`.
 * Prevents credential leakage in session log files.
 */
function redactCredentials(text: string, credentials: Record<string, string>): string {
  let result = text;
  for (const value of Object.values(credentials)) {
    if (value.length > 0 && result.includes(value)) {
      result = result.replaceAll(value, '***REDACTED***');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exported subprocess utilities
// ---------------------------------------------------------------------------

/** Parsed environment configuration for the proxy server. */
export interface ProxyEnvConfig {
  serversConfig: Record<string, MCPServerConfig>;
  generatedDir: string;
  /** Directory for tool-annotations.json. Defaults to generatedDir if unset. */
  toolAnnotationsDir: string;
  protectedPaths: string[];
  sessionLogPath: string | undefined;
  allowedDirectory: string | undefined;
  serverCredentials: Record<string, string>;
  sandboxPolicy: SandboxAvailabilityPolicy;
}

/** Result of sandbox availability validation. */
export interface SandboxValidationResult {
  sandboxAvailable: boolean;
}

/**
 * Reads and validates proxy environment variables.
 * Returns a typed config object or calls process.exit(1) on missing required vars.
 */
export function parseProxyEnvConfig(): ProxyEnvConfig {
  const serversConfigJson = process.env.MCP_SERVERS_CONFIG;
  const generatedDir = process.env.GENERATED_DIR;
  const protectedPathsJson = process.env.PROTECTED_PATHS ?? '[]';
  const sessionLogPath = process.env.SESSION_LOG_PATH;
  const allowedDirectory = process.env.ALLOWED_DIRECTORY;

  if (!serversConfigJson) {
    process.stderr.write('MCP_SERVERS_CONFIG environment variable is required\n');
    process.exit(1);
  }

  if (!generatedDir) {
    process.stderr.write('GENERATED_DIR environment variable is required\n');
    process.exit(1);
  }

  // Parse per-server credentials and immediately scrub from process.env
  // so they are not inherited by child MCP server processes.
  const serverCredentials: Record<string, string> = process.env.SERVER_CREDENTIALS
    ? (JSON.parse(process.env.SERVER_CREDENTIALS) as Record<string, string>)
    : {};
  delete process.env.SERVER_CREDENTIALS;

  const sandboxPolicy = (process.env.SANDBOX_POLICY ?? 'warn') as SandboxAvailabilityPolicy;

  const allServersConfig = JSON.parse(serversConfigJson) as Record<string, MCPServerConfig>;
  const protectedPaths = JSON.parse(protectedPathsJson) as string[];

  // When SERVER_FILTER is set, only connect to that single backend server.
  // Special case: SERVER_FILTER=proxy with no matching backend enters virtual-only mode.
  const serverFilter = process.env.SERVER_FILTER;
  const isVirtualOnly = serverFilter === 'proxy' && !allServersConfig[serverFilter];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- isVirtualOnly is defensive; TS can't prove it's false at runtime
  const serversConfig: Record<string, MCPServerConfig> = isVirtualOnly
    ? {}
    : serverFilter
      ? { [serverFilter]: allServersConfig[serverFilter] }
      : allServersConfig;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Record index may be undefined at runtime
  if (serverFilter && !allServersConfig[serverFilter] && !isVirtualOnly) {
    process.stderr.write(`SERVER_FILTER: unknown server "${serverFilter}"\n`);
    process.exit(1);
  }

  // When TOOL_ANNOTATIONS_DIR is set, annotations come from there.
  // Otherwise they default to the same directory as compiled policy.
  const toolAnnotationsDir = process.env.TOOL_ANNOTATIONS_DIR ?? generatedDir;

  return {
    serversConfig,
    generatedDir,
    toolAnnotationsDir,
    protectedPaths,
    sessionLogPath,
    allowedDirectory,
    serverCredentials,
    sandboxPolicy,
  };
}

/**
 * Validates sandbox availability against the configured policy.
 * Logs warnings to session log. Throws when enforce mode is active
 * but sandboxing is unavailable.
 */
export function validateSandboxAvailability(
  sandboxPolicy: SandboxAvailabilityPolicy,
  sessionLogPath: string | undefined,
  platform: string,
): SandboxValidationResult {
  const { platformSupported, errors: depErrors, warnings: depWarnings } = checkSandboxAvailability();

  if (sessionLogPath) {
    for (const warning of depWarnings) {
      logToSessionFile(sessionLogPath, `[sandbox] WARNING: ${warning}`);
    }
  }

  if (sandboxPolicy === 'enforce' && (!platformSupported || depErrors.length > 0)) {
    const reasons = !platformSupported ? [`Platform ${platform} not supported`] : depErrors;
    throw new Error(
      `[sandbox] FATAL: sandboxPolicy is "enforce" but sandboxing is unavailable:\n` +
        reasons.map((r) => `  - ${r}`).join('\n') +
        '\n' +
        `Install with: sudo apt-get install -y bubblewrap socat`,
    );
  }

  const sandboxAvailable = platformSupported && depErrors.length === 0;

  if (!sandboxAvailable && sessionLogPath) {
    const missing = depErrors.length > 0 ? depErrors.join(', ') : `platform ${platform}`;
    logToSessionFile(
      sessionLogPath,
      `[sandbox] WARNING: OS-level sandboxing unavailable (${missing}). ` +
        `Servers will run without OS containment. ` +
        `Set SANDBOX_POLICY=enforce to require sandboxing.`,
    );
  }

  return { sandboxAvailable };
}

/**
 * Resolves per-server sandbox configurations and writes srt settings
 * files for sandboxed servers. Returns the config map and the temp
 * settings directory path.
 */
export function resolveServerSandboxConfigs(
  serversConfig: Record<string, MCPServerConfig>,
  allowedDirectory: string | undefined,
  sandboxAvailable: boolean,
  sandboxPolicy: SandboxAvailabilityPolicy,
): {
  resolvedSandboxConfigs: Map<string, ResolvedSandboxConfig>;
  settingsDir: string;
  serverCwdPaths: Map<string, string>;
} {
  const resolvedSandboxConfigs = new Map<string, ResolvedSandboxConfig>();
  const serverCwdPaths = new Map<string, string>();
  const settingsDir = mkdtempSync(join(tmpdir(), 'ironcurtain-srt-'));

  for (const [serverName, config] of Object.entries(serversConfig)) {
    const resolved = resolveSandboxConfig(config, allowedDirectory ?? '/tmp', sandboxAvailable, sandboxPolicy);
    resolvedSandboxConfigs.set(serverName, resolved);

    if (resolved.sandboxed) {
      const { cwdPath } = writeServerSettings(serverName, resolved.config, settingsDir);
      serverCwdPaths.set(serverName, cwdPath);
    }
  }

  return { resolvedSandboxConfigs, settingsDir, serverCwdPaths };
}

/**
 * Selects and validates the proxy transport based on environment variables.
 * Returns 'tcp', 'uds', or 'stdio' along with the transport options.
 */
export function selectTransportConfig():
  | {
      kind: 'tcp';
      port: number;
      portFilePath: string | undefined;
    }
  | {
      kind: 'uds';
      socketPath: string;
    }
  | {
      kind: 'stdio';
    } {
  const proxyTcpPort = process.env.PROXY_TCP_PORT;
  const proxySocketPath = process.env.PROXY_SOCKET_PATH;

  if (proxyTcpPort) {
    const parsedPort = parseInt(proxyTcpPort, 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid PROXY_TCP_PORT value "${proxyTcpPort}". Expected an integer between 0 and 65535.`);
    }
    return { kind: 'tcp', port: parsedPort, portFilePath: process.env.PROXY_PORT_FILE };
  }

  if (proxySocketPath) {
    return { kind: 'uds', socketPath: proxySocketPath };
  }

  return { kind: 'stdio' };
}

// ── main() -- thin orchestrator ────────────────────────────────────────

async function main(): Promise<void> {
  const envConfig = parseProxyEnvConfig();
  const {
    serversConfig,
    generatedDir,
    toolAnnotationsDir,
    sessionLogPath,
    allowedDirectory,
    serverCredentials,
    sandboxPolicy,
  } = envConfig;

  // Load compiled policy + annotations to derive MCP roots advertised
  // to backend MCP servers at connection time (the backend still uses
  // Roots to authorize filesystem access).
  const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy({
    policyDir: generatedDir,
    toolAnnotationsDir,
    fallbackDir: getPackageGeneratedDir(),
  });

  // Merge proxy tool annotations and policy rules so roots derivation
  // includes any paths referenced by proxy policy rules.
  toolAnnotations.servers.proxy = {
    inputHash: 'hardcoded',
    tools: proxyAnnotations,
  };
  compiledPolicy.rules = [...proxyPolicyRules, ...compiledPolicy.rules];

  const policyRoots = extractPolicyRoots(compiledPolicy, allowedDirectory ?? '/tmp');
  const mcpRoots = toMcpRoots(policyRoots);

  // ── Sandbox availability & config resolution ──────────────────────
  const { sandboxAvailable } = validateSandboxAvailability(sandboxPolicy, sessionLogPath, process.platform);
  const { resolvedSandboxConfigs, settingsDir, serverCwdPaths } = resolveServerSandboxConfigs(
    serversConfig,
    allowedDirectory,
    sandboxAvailable,
    sandboxPolicy,
  );

  // Discover node/npm paths once for all sandboxed servers with denyRead: ["~"]
  const dynamicNodePaths = discoverNodePaths();

  // ── Connect to real MCP servers ───────────────────────────────────
  const clientStates = new Map<string, ClientState>();
  const allTools: ProxiedTool[] = [];
  const tokenRefreshers = new Map<string, TokenFileRefresher>();

  for (const [serverName, config] of Object.entries(serversConfig)) {
    // Skip servers whose args reference env vars (Docker -e VAR_NAME syntax)
    // that aren't set — the server will fail to start without them.
    const missingEnvVars = getMissingEnvVars(config.args);
    if (missingEnvVars.length > 0) {
      const warning = `Skipping MCP server "${serverName}": missing environment variable(s) ${missingEnvVars.join(', ')}`;
      process.stderr.write(`WARNING: ${warning}\n`);
      if (sessionLogPath) logToSessionFile(sessionLogPath, `[proxy] ${warning}`);
      continue;
    }

    // ── OAuth token injection for servers backed by OAuth providers ──
    const oauthEnv: Record<string, string> = {};
    const oauthProvider = getProviderForServer(serverName);
    if (oauthProvider) {
      const clientCreds = loadClientCredentials(oauthProvider);
      if (!clientCreds) {
        const warning = `Skipping MCP server "${serverName}": no OAuth credentials. Run 'ironcurtain auth import ${oauthProvider.id} <file>'`;
        process.stderr.write(`WARNING: ${warning}\n`);
        if (sessionLogPath) logToSessionFile(sessionLogPath, `[proxy] ${warning}`);
        continue;
      }

      const tokenProvider = new OAuthTokenProvider(oauthProvider, clientCreds);
      if (!tokenProvider.isAuthorized()) {
        const warning = `Skipping MCP server "${serverName}": not authorized. Run 'ironcurtain auth ${oauthProvider.id}'`;
        process.stderr.write(`WARNING: ${warning}\n`);
        if (sessionLogPath) logToSessionFile(sessionLogPath, `[proxy] ${warning}`);
        continue;
      }

      try {
        const accessToken = await tokenProvider.getValidAccessToken();
        const storedToken = loadOAuthToken(oauthProvider.id);
        if (!storedToken) {
          throw new Error(`Token file disappeared after validation for "${oauthProvider.id}"`);
        }

        // Create per-session credential directory
        const credsDir = join(settingsDir, `${serverName}-creds`);
        writeGWorkspaceCredentialFile(credsDir, accessToken, storedToken.expiresAt, storedToken.scopes);

        // Inject env vars for the MCP server
        oauthEnv.GWORKSPACE_CREDS_DIR = credsDir;
        oauthEnv.CLIENT_ID = clientCreds.clientId;
        oauthEnv.CLIENT_SECRET = clientCreds.clientSecret;

        // Redirect npm cache into the credential directory for npx sandbox compatibility
        oauthEnv.npm_config_cache = join(credsDir, '.npm-cache');

        // Start proactive token refresh
        const refresher = new TokenFileRefresher(
          {
            providerId: oauthProvider.id,
            getAccessToken: async () => {
              // Force refresh: match the refresher's 10-min threshold
              // (getValidAccessToken's 5-min threshold would skip near-expiry tokens)
              const token = await tokenProvider.forceRefresh();
              const stored = loadOAuthToken(oauthProvider.id);
              if (!stored) {
                throw new Error(`Token file missing for "${oauthProvider.id}"`);
              }
              return { accessToken: token, expiresAt: stored.expiresAt, scopes: stored.scopes };
            },
            writeCredentialFile: (token, expiry, scopes) => {
              writeGWorkspaceCredentialFile(credsDir, token, expiry, scopes);
            },
            logToSession: sessionLogPath ? (msg) => logToSessionFile(sessionLogPath, msg) : undefined,
          },
          storedToken.expiresAt,
        );
        refresher.start();
        tokenRefreshers.set(serverName, refresher);

        // Rewrite srt settings to allow the credential directory and
        // node paths (for denyRead: ["~"] servers) in a single call
        const resolvedOAuth = resolvedSandboxConfigs.get(serverName);
        if (resolvedOAuth?.sandboxed) {
          const hasDenyHome = resolvedOAuth.config.denyRead.some((p) => expandTilde(p) === homedir());
          const extraAllowRead = hasDenyHome ? [...dynamicNodePaths, credsDir] : [credsDir];
          const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);
          rewriteServerSettings(settingsPath, {
            allowRead: extraAllowRead,
            allowWrite: [credsDir],
          });
        }

        if (sessionLogPath) {
          logToSessionFile(
            sessionLogPath,
            `[proxy] OAuth token prepared for "${serverName}" (provider: ${oauthProvider.id})`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const warning = `Skipping MCP server "${serverName}": OAuth token error: ${message}. Run 'ironcurtain auth ${oauthProvider.id}'`;
        process.stderr.write(`WARNING: ${warning}\n`);
        if (sessionLogPath) logToSessionFile(sessionLogPath, `[proxy] ${warning}`);
        continue;
      }
    }

    const resolved = resolvedSandboxConfigs.get(serverName);
    if (!resolved) throw new Error(`Missing sandbox config for server "${serverName}"`);

    // For non-OAuth sandboxed servers with denyRead: ["~"], inject node paths
    if (!oauthProvider && resolved.sandboxed && dynamicNodePaths.length > 0) {
      const hasDenyHome = resolved.config.denyRead.some((p) => expandTilde(p) === homedir());
      if (hasDenyHome) {
        const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);
        rewriteServerSettings(settingsPath, { allowRead: dynamicNodePaths });
      }
    }

    const wrapped = wrapServerCommand(serverName, config.command, config.args, resolved, settingsDir);

    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      env: {
        ...(process.env as Record<string, string>),
        // Strip NODE_OPTIONS for sandboxed servers to prevent IDE debugger preloads
        // (e.g., Cursor/VS Code) from referencing paths under ~ that denyRead blocks.
        ...(resolved.sandboxed ? { NODE_OPTIONS: '' } : {}),
        ...(config.env ?? {}),
        ...serverCredentials,
        ...oauthEnv,
      },
      stderr: 'pipe',
      // Sandboxed servers use a per-server temp dir as CWD (not the sandbox)
      // to prevent srt/bwrap ghost dotfiles from polluting the sandbox directory.
      ...(resolved.sandboxed && serverCwdPaths.has(serverName) ? { cwd: serverCwdPaths.get(serverName) } : {}),
    });

    let serverStderr = '';
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        serverStderr += text;
        if (sessionLogPath) {
          const lines = text.trimEnd();
          if (lines) {
            const redacted = redactCredentials(redactCredentials(lines, serverCredentials), oauthEnv);
            logToSessionFile(sessionLogPath, `[mcp:${serverName}] ${redacted}`);
          }
        }
      });
    }

    // See permissive-output-validator.ts for why this is needed.
    const client = new Client(
      { name: 'ironcurtain-proxy', version: VERSION },
      {
        capabilities: { roots: { listChanged: true } },
        jsonSchemaValidator: permissiveJsonSchemaValidator,
      },
    );

    const state: ClientState = { client, roots: [...mcpRoots] };

    client.setRequestHandler(ListRootsRequestSchema, () => {
      if (state.rootsRefreshed) {
        state.rootsRefreshed();
        state.rootsRefreshed = undefined;
      }
      return { roots: state.roots };
    });

    try {
      await client.connect(transport);
    } catch (err) {
      const cmd = `${wrapped.command} ${wrapped.args.join(' ')}`;
      const stderrSnippet = serverStderr ? `\nServer stderr: ${serverStderr.substring(0, 1000)}` : '';
      throw new Error(
        `Failed to connect to MCP server "${serverName}" (${cmd}): ${err instanceof Error ? err.message : String(err)}${stderrSnippet}`,
        { cause: err },
      );
    }
    clientStates.set(serverName, state);

    const result = await client.listTools();
    for (const tool of result.tools) {
      allTools.push({
        serverName,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      });
    }
  }

  // In virtual-only mode (SERVER_FILTER=proxy), register proxy tool definitions
  // and create the control API client for communicating with the MITM proxy.
  const isVirtualOnlyMode = process.env.SERVER_FILTER === 'proxy' && Object.keys(serversConfig).length === 0;
  let controlApiClient: ControlApiClient | null = null;

  if (isVirtualOnlyMode) {
    for (const toolDef of proxyToolDefinitions) {
      allTools.push({
        serverName: 'proxy',
        name: toolDef.name,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema as Record<string, unknown>,
      });
    }

    const mitmControlAddr = process.env.MITM_CONTROL_ADDR;
    if (!mitmControlAddr) {
      throw new Error(
        'MITM_CONTROL_ADDR must be set when running in virtual-only proxy mode ' +
          '(SERVER_FILTER=proxy with no other MCP servers).',
      );
    }
    controlApiClient = createControlApiClient(mitmControlAddr);
  }

  const toolMap = buildToolMap(allTools);
  const toolDescriptionHints = loadToolDescriptionHints();
  const hintedTools = applyToolDescriptionHints(allTools, toolDescriptionHints);
  const listToolsResponse = {
    tools: hintedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };

  // ── Create the proxy MCP server ───────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional use of low-level Server for raw JSON schema passthrough
  const server = new Server({ name: 'ironcurtain-proxy', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => listToolsResponse);

  // Pass-through CallTool handler: forward to the backend client,
  // return the raw result. No policy evaluation -- the coordinator
  // in the parent process handles that.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolInfo = toolMap.get(req.params.name);
    if (!toolInfo) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }

    // Virtual proxy tools stay local -- they speak to the MITM control
    // socket via the ControlApiClient and never reach a backend MCP server.
    const rawArgs = req.params.arguments ?? {};
    if (toolInfo.serverName === 'proxy' && controlApiClient) {
      try {
        const result = await handleVirtualProxyTool(toolInfo.name, rawArgs, controlApiClient);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${errorMessage}` }], isError: true };
      }
    }

    const clientState = clientStates.get(toolInfo.serverName);
    if (!clientState) {
      return {
        content: [{ type: 'text', text: `Internal error: no client connection for server "${toolInfo.serverName}"` }],
        isError: true,
      };
    }

    try {
      const result = await clientState.client.callTool(
        { name: toolInfo.name, arguments: rawArgs },
        CompatibilityCallToolResultSchema,
      );
      return result.isError ? { content: result.content, isError: true } : { content: result.content };
    } catch (err) {
      const errorMessage = extractMcpErrorMessage(err);
      return { content: [{ type: 'text', text: `Error: ${errorMessage}` }], isError: true };
    }
  });

  // ── Transport selection ───────────────────────────────────────────
  const transportConfig = selectTransportConfig();
  let transport: Transport;
  if (transportConfig.kind === 'tcp') {
    const tcpTransport = new TcpServerTransport('0.0.0.0', transportConfig.port);
    transport = tcpTransport;
    await tcpTransport.start();
    if (transportConfig.portFilePath) {
      writeFileSync(transportConfig.portFilePath, String(tcpTransport.port));
    }
    if (sessionLogPath) {
      logToSessionFile(sessionLogPath, `MCP proxy listening on 0.0.0.0:${tcpTransport.port}`);
    }
  } else if (transportConfig.kind === 'uds') {
    transport = new UdsServerTransport(transportConfig.socketPath);
  } else {
    transport = new StdioServerTransport();
  }
  await server.connect(transport);

  // ── Shutdown handler ──────────────────────────────────────────────
  async function shutdown(): Promise<void> {
    // Stop token refreshers before closing clients
    for (const refresher of tokenRefreshers.values()) {
      refresher.stop();
    }
    tokenRefreshers.clear();

    for (const state of clientStates.values()) {
      try {
        await state.client.close();
      } catch {
        /* ignore */
      }
    }
    cleanupSettingsFiles(settingsDir);
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

// Only run main() when this module is the entry point (not when imported for testing)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`MCP Proxy Server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
