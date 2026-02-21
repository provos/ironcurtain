/**
 * MCP Proxy Server -- The trusted process running as a standalone MCP server.
 *
 * Code Mode spawns this as a child process via stdio transport. It acts
 * as the security boundary between the sandbox and real MCP servers:
 *
 * 1. Connects to real MCP servers as a client
 * 2. Exposes their tools with passthrough schemas
 * 3. Evaluates every tool call against the policy engine
 * 4. Forwards allowed calls to real servers, denies or escalates others
 * 5. Logs every request and decision to the append-only audit log
 *
 * Configuration via environment variables:
 *   AUDIT_LOG_PATH     -- path to the audit log file
 *   MCP_SERVERS_CONFIG -- JSON string of MCP server configs to proxy
 *   GENERATED_DIR      -- path to the generated artifacts directory
 *   PROTECTED_PATHS    -- JSON array of protected paths
 *   ALLOWED_DIRECTORY  -- (optional) sandbox directory for structural containment check
 *   ESCALATION_DIR     -- (optional) directory for file-based escalation IPC
 *   SESSION_LOG_PATH   -- (optional) path for capturing child process stderr
 *   SANDBOX_POLICY     -- (optional) "enforce" | "warn" (default: "warn")
 *   SERVER_FILTER      -- (optional) when set, only connect to this single server name
 *   AUTO_APPROVE_ENABLED   -- (optional) "true" to enable auto-approval of escalations
 *   AUTO_APPROVE_MODEL_ID  -- (optional) qualified model ID for auto-approve LLM
 *   AUTO_APPROVE_API_KEY   -- (optional) API key for the auto-approve model's provider
 *   AUTO_APPROVE_LLM_LOG_PATH -- (optional) path to JSONL file for auto-approve LLM logging
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequestSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { loadGeneratedPolicy, extractServerDomainAllowlists } from '../config/index.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLog } from './audit-log.js';
import { prepareToolArgs } from './path-utils.js';
import { extractPolicyRoots, toMcpRoots, directoryForPath } from './policy-roots.js';
import {
  checkSandboxAvailability,
  resolveSandboxConfig,
  writeServerSettings,
  wrapServerCommand,
  cleanupSettingsFiles,
  annotateSandboxViolation,
  type ResolvedSandboxConfig,
} from './sandbox-integration.js';
import type { ToolCallRequest } from '../types/mcp.js';
import type { AuditEntry } from '../types/audit.js';
import type { McpRoot } from './mcp-client-manager.js';
import { CallCircuitBreaker } from './call-circuit-breaker.js';
import { autoApprove, readUserContext } from './auto-approver.js';
import { createLanguageModelFromEnv } from '../config/model-provider.js';
import { wrapLanguageModel } from 'ai';
import { createLlmLoggingMiddleware } from '../pipeline/llm-logger.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';

interface ProxiedTool {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
}

interface ClientState {
  client: Client;
  roots: McpRoot[];
  rootsRefreshed?: () => void;
}

/**
 * Adds a root to a client's root list and waits for the server to
 * fetch the updated list. No-op if the root URI is already present.
 */
async function addRootToClient(state: ClientState, root: McpRoot): Promise<void> {
  if (state.roots.some(r => r.uri === root.uri)) return;
  state.roots.push(root);

  const refreshed = new Promise<void>(resolve => {
    state.rootsRefreshed = resolve;
  });
  await state.client.sendRootsListChanged();
  await refreshed;
}

/** Appends a timestamped line to the session log file. */
function logToSessionFile(sessionLogPath: string, message: string): void {
  const timestamp = new Date().toISOString();
  try {
    appendFileSync(sessionLogPath, `${timestamp} INFO  ${message}\n`);
  } catch { /* ignore write failures */ }
}

/** Extracts concatenated text from MCP content blocks. */
function extractTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((c: Record<string, unknown>) => c.type === 'text' && typeof c.text === 'string')
    .map((c: Record<string, unknown>) => c.text as string);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

const ESCALATION_POLL_INTERVAL_MS = 500;
const DEFAULT_ESCALATION_TIMEOUT_SECONDS = 300;

/** Reads escalation timeout from env var, falling back to default. */
function getEscalationTimeoutMs(): number {
  const envValue = process.env.ESCALATION_TIMEOUT_SECONDS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }
  return DEFAULT_ESCALATION_TIMEOUT_SECONDS * 1000;
}

/**
 * Waits for a human decision via file-based IPC.
 *
 * Writes a request file to the escalation directory, then polls
 * for a response file. The session process (on the other side)
 * detects the request, surfaces it to the user, and writes the response.
 *
 * Returns 'approved' or 'denied'. On timeout, returns 'denied'.
 */
async function waitForEscalationDecision(
  escalationDir: string,
  request: EscalationFileRequest,
): Promise<'approved' | 'denied'> {
  const requestPath = resolve(escalationDir, `request-${request.escalationId}.json`);
  const responsePath = resolve(escalationDir, `response-${request.escalationId}.json`);

  writeFileSync(requestPath, JSON.stringify(request));

  const deadline = Date.now() + getEscalationTimeoutMs();

  while (Date.now() < deadline) {
    if (existsSync(responsePath)) {
      const response = JSON.parse(readFileSync(responsePath, 'utf-8')) as { decision: 'approved' | 'denied' };
      // Clean up both files
      try { unlinkSync(requestPath); } catch { /* ignore */ }
      try { unlinkSync(responsePath); } catch { /* ignore */ }
      return response.decision;
    }
    await new Promise((r) => setTimeout(r, ESCALATION_POLL_INTERVAL_MS));
  }

  // Timeout -- clean up request file and treat as denied
  try { unlinkSync(requestPath); } catch { /* ignore */ }
  return 'denied';
}

/**
 * Creates the auto-approve LLM model from environment variables.
 * Returns null when auto-approve is not enabled or env vars are missing.
 * Wraps with LLM logging middleware when a log path is provided.
 */
async function createAutoApproveModel(): Promise<LanguageModelV3 | null> {
  if (process.env.AUTO_APPROVE_ENABLED !== 'true') return null;

  const modelId = process.env.AUTO_APPROVE_MODEL_ID;
  if (!modelId) return null;

  const apiKey = process.env.AUTO_APPROVE_API_KEY ?? '';

  try {
    const baseModel = await createLanguageModelFromEnv(modelId, apiKey);

    const llmLogPath = process.env.AUTO_APPROVE_LLM_LOG_PATH;
    if (!llmLogPath) return baseModel;

    return wrapLanguageModel({
      model: baseModel,
      middleware: createLlmLoggingMiddleware(llmLogPath, { stepName: 'auto-approve' }),
    }) as LanguageModelV3;
  } catch {
    // Model creation failure should not prevent the proxy from starting.
    // Auto-approve simply won't be available for this session.
    return null;
  }
}

async function main(): Promise<void> {
  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';
  const serversConfigJson = process.env.MCP_SERVERS_CONFIG;
  const generatedDir = process.env.GENERATED_DIR;
  const protectedPathsJson = process.env.PROTECTED_PATHS ?? '[]';
  const sessionLogPath = process.env.SESSION_LOG_PATH;
  const allowedDirectory = process.env.ALLOWED_DIRECTORY;
  const escalationDir = process.env.ESCALATION_DIR;

  if (!serversConfigJson) {
    process.stderr.write('MCP_SERVERS_CONFIG environment variable is required\n');
    process.exit(1);
  }

  if (!generatedDir) {
    process.stderr.write('GENERATED_DIR environment variable is required\n');
    process.exit(1);
  }

  const sandboxPolicy = (process.env.SANDBOX_POLICY ?? 'warn') as SandboxAvailabilityPolicy;

  const allServersConfig: Record<string, MCPServerConfig> = JSON.parse(serversConfigJson);
  const protectedPaths: string[] = JSON.parse(protectedPathsJson);

  // When SERVER_FILTER is set, only connect to that single backend server.
  // This allows per-server proxy processes with clean tool naming.
  const serverFilter = process.env.SERVER_FILTER;
  const serversConfig: Record<string, MCPServerConfig> = serverFilter
    ? { [serverFilter]: allServersConfig[serverFilter] }
    : allServersConfig;

  if (serverFilter && !allServersConfig[serverFilter]) {
    process.stderr.write(`SERVER_FILTER: unknown server "${serverFilter}"\n`);
    process.exit(1);
  }

  const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(generatedDir);

  const serverDomainAllowlists = extractServerDomainAllowlists(serversConfig);
  const policyEngine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths, allowedDirectory, serverDomainAllowlists);
  const auditLog = new AuditLog(auditLogPath);
  const circuitBreaker = new CallCircuitBreaker();

  // ── Auto-approve model setup (once at startup) ──────────────────────
  const autoApproveModel = await createAutoApproveModel();

  // Compute initial roots from compiled policy for the MCP Roots protocol
  const policyRoots = extractPolicyRoots(compiledPolicy, allowedDirectory ?? '/tmp');
  const mcpRoots = toMcpRoots(policyRoots);

  // ── Sandbox availability check (once for all servers) ──────────────
  const { platformSupported, errors: depErrors, warnings: depWarnings } = checkSandboxAvailability();

  if (sessionLogPath) {
    for (const warning of depWarnings) {
      logToSessionFile(sessionLogPath, `[sandbox] WARNING: ${warning}`);
    }
  }

  if (sandboxPolicy === 'enforce' && (!platformSupported || depErrors.length > 0)) {
    const reasons = !platformSupported
      ? [`Platform ${process.platform} not supported`]
      : depErrors;
    throw new Error(
      `[sandbox] FATAL: sandboxPolicy is "enforce" but sandboxing is unavailable:\n` +
      reasons.map(r => `  - ${r}`).join('\n') + '\n' +
      `Install with: sudo apt-get install -y bubblewrap socat`,
    );
  }

  const sandboxAvailable = platformSupported && depErrors.length === 0;

  if (!sandboxAvailable && sessionLogPath) {
    const missing = depErrors.length > 0 ? depErrors.join(', ') : `platform ${process.platform}`;
    logToSessionFile(sessionLogPath,
      `[sandbox] WARNING: OS-level sandboxing unavailable (${missing}). ` +
      `Servers will run without OS containment. ` +
      `Set SANDBOX_POLICY=enforce to require sandboxing.`,
    );
  }

  // ── Resolve sandbox configs and write per-server srt settings ─────
  const resolvedSandboxConfigs = new Map<string, ResolvedSandboxConfig>();
  const settingsDir = mkdtempSync(join(tmpdir(), 'ironcurtain-srt-'));

  for (const [serverName, config] of Object.entries(serversConfig)) {
    const resolved = resolveSandboxConfig(
      config,
      allowedDirectory ?? '/tmp',
      sandboxAvailable,
      sandboxPolicy,
    );
    resolvedSandboxConfigs.set(serverName, resolved);

    if (resolved.sandboxed) {
      writeServerSettings(serverName, resolved.config, settingsDir);
    }
  }

  const clientStates = new Map<string, ClientState>();

  // Connect to real MCP servers as clients, wrapping sandboxed ones with srt
  const allTools: ProxiedTool[] = [];

  for (const [serverName, config] of Object.entries(serversConfig)) {
    const resolved = resolvedSandboxConfigs.get(serverName)!;
    const wrapped = wrapServerCommand(serverName, config.command, config.args, resolved, settingsDir);

    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      // Always pass full process.env -- never rely on getDefaultEnvironment()
      // which strips vars that srt and MCP servers may need
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
      stderr: 'pipe', // Prevent child server stderr from leaking to the terminal
      // Sandboxed servers get the sandbox dir as cwd so relative-path writes
      // (e.g., log files) land inside the writable sandbox instead of failing
      // with EROFS on the read-only host filesystem.
      ...(resolved.sandboxed && allowedDirectory ? { cwd: allowedDirectory } : {}),
    });

    // Drain the piped stderr to prevent buffer backpressure from blocking
    // the child process. Write output to the session log if configured.
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        if (sessionLogPath) {
          const lines = chunk.toString().trimEnd();
          if (lines) {
            const timestamp = new Date().toISOString();
            try {
              appendFileSync(sessionLogPath, `${timestamp} INFO  [mcp:${serverName}] ${lines}\n`);
            } catch { /* ignore write failures */ }
          }
        }
      });
    }

    const client = new Client(
      { name: 'ironcurtain-proxy', version: '0.1.0' },
      { capabilities: { roots: { listChanged: true } } },
    );

    // Mutable copy per client -- root expansion pushes to this array
    const state: ClientState = { client, roots: [...mcpRoots] };

    // When the server asks for roots, return the current set.
    // If a rootsRefreshed callback is registered (from escalation-triggered
    // root expansion), resolve it so the caller knows the server has
    // the latest roots.
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      if (state.rootsRefreshed) {
        state.rootsRefreshed();
        state.rootsRefreshed = undefined;
      }
      return { roots: state.roots };
    });

    await client.connect(transport);
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

  // Build a lookup map for routing tool calls
  const toolMap = new Map<string, ProxiedTool>();
  for (const tool of allTools) {
    toolMap.set(tool.name, tool);
  }

  // Create the proxy MCP server using the low-level Server API
  // so we can pass through raw JSON schemas without Zod conversion
  const server = new Server(
    { name: 'ironcurtain-proxy', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Handle tools/list -- return all proxied tool schemas verbatim
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Handle tools/call -- evaluate policy, then forward or deny
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const rawArgs = (req.params.arguments ?? {}) as Record<string, unknown>;
    const toolInfo = toolMap.get(toolName);

    if (!toolInfo) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    // Annotation-driven normalization: split into transport vs policy args
    const annotation = policyEngine.getAnnotation(toolInfo.serverName, toolInfo.name);
    const { argsForTransport, argsForPolicy } = prepareToolArgs(rawArgs, annotation, allowedDirectory);

    const request: ToolCallRequest = {
      requestId: uuidv4(),
      serverName: toolInfo.serverName,
      toolName: toolInfo.name,
      arguments: argsForPolicy,
      timestamp: new Date().toISOString(),
    };

    const evaluation = policyEngine.evaluate(request);
    const policyDecision = {
      status: evaluation.decision,
      rule: evaluation.rule,
      reason: evaluation.reason,
    };

    // Tracks the escalation outcome for audit logging when an approved
    // escalation falls through to the forwarding section below.
    let escalationResult: 'approved' | 'denied' | undefined;

    // Track whether auto-approver handled this escalation
    let autoApproved = false;

    // Look up whether this server is sandboxed for audit logging
    const serverSandboxConfig = resolvedSandboxConfigs.get(toolInfo.serverName);
    const serverIsSandboxed = serverSandboxConfig?.sandboxed === true;

    // Audit log records argsForTransport (what was actually sent to the MCP server)
    function logAudit(result: AuditEntry['result'], durationMs: number, overrideEscalation?: 'approved' | 'denied'): void {
      const entry: AuditEntry = {
        timestamp: request.timestamp,
        requestId: request.requestId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: argsForTransport,
        policyDecision,
        escalationResult: overrideEscalation ?? escalationResult,
        result,
        durationMs,
        sandboxed: serverIsSandboxed || undefined,
        autoApproved: autoApproved || undefined,
      };
      auditLog.log(entry);
    }

    if (evaluation.decision === 'escalate') {
      if (!escalationDir) {
        // No escalation directory configured -- auto-deny (backward compatible)
        logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
        return {
          content: [{
            type: 'text',
            text: `ESCALATION REQUIRED: ${evaluation.reason}. Action denied (no escalation handler).`,
          }],
          isError: true,
        };
      }

      // Try auto-approve before falling through to human escalation
      if (autoApproveModel) {
        const userMessage = readUserContext(escalationDir);
        if (userMessage) {
          const autoResult = await autoApprove(
            {
              userMessage,
              toolName: `${toolInfo.serverName}/${toolInfo.name}`,
              escalationReason: evaluation.reason,
            },
            autoApproveModel,
          );

          if (autoResult.decision === 'approve') {
            autoApproved = true;
            escalationResult = 'approved';
            policyDecision.status = 'allow';
            policyDecision.reason = `Auto-approved: ${autoResult.reasoning}`;
          }
        }
      }

      if (!autoApproved) {
        // File-based escalation rendezvous: write request, poll for response
        const escalationId = uuidv4();
        const decision = await waitForEscalationDecision(escalationDir, {
          escalationId,
          serverName: request.serverName,
          toolName: request.toolName,
          arguments: argsForTransport,
          reason: evaluation.reason,
        });

        if (decision === 'denied') {
          logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
          return {
            content: [{ type: 'text', text: `ESCALATION DENIED: ${evaluation.reason}` }],
            isError: true,
          };
        }

        // Approved by human -- update policy decision and fall through
        escalationResult = 'approved';
        policyDecision.status = 'allow';
        policyDecision.reason = 'Approved by human during escalation';
      }

      // Expand roots to include target directories so the filesystem
      // server accepts the forwarded call.
      const state = clientStates.get(toolInfo.serverName);
      if (state) {
        const paths = Object.values(argsForTransport).filter(
          (v): v is string => typeof v === 'string',
        );
        for (const p of paths) {
          await addRootToClient(state, {
            uri: `file://${directoryForPath(p)}`,
            name: 'escalation-approved',
          });
        }
      }
    }

    if (evaluation.decision === 'deny') {
      logAudit({ status: 'denied', error: evaluation.reason }, 0);
      return {
        content: [{ type: 'text', text: `DENIED: ${evaluation.reason}` }],
        isError: true,
      };
    }

    // Circuit breaker: deny if the same tool+args is called too many times
    const cbVerdict = circuitBreaker.check(toolInfo.name, argsForTransport);
    if (!cbVerdict.allowed) {
      logAudit({ status: 'denied', error: cbVerdict.reason }, 0);
      return {
        content: [{ type: 'text', text: cbVerdict.reason }],
        isError: true,
      };
    }

    // Policy allows -- forward to the real MCP server with transport args
    const startTime = Date.now();
    try {
      const client = clientStates.get(toolInfo.serverName)!.client;

      // TODO(workaround): Remove once @cyanheads/git-mcp-server fixes outputSchema declarations.
      //
      // WHY: The git MCP server v2.8.4 declares outputSchema for tools like git_add and
      // git_commit, but the structuredContent it actually returns does not match those schemas.
      // The MCP SDK v1.26.0 Client.callTool() validates responses client-side against the
      // declared outputSchema and throws McpError(-32602, "Structured content does not match
      // the tool's output schema: ...") when there is a mismatch.
      //
      // WHAT: git_add declares required properties {success, stagedFiles, totalFiles, status}
      // in its outputSchema, but actual responses (especially errors) are missing these and
      // include additional undeclared properties. git_commit similarly requires {success,
      // commitHash, author, timestamp, committedFiles, status} but returns different shapes.
      //
      // FIX: Passing CompatibilityCallToolResultSchema instead of the default
      // CallToolResultSchema makes the response parsing more permissive, which avoids the
      // client-side validation failure.
      //
      // CONSEQUENCE: By using CompatibilityCallToolResultSchema we lose client-side output
      // validation for ALL MCP servers proxied through this path, not just the git server.
      const result = await client.callTool({
        name: toolInfo.name,
        arguments: argsForTransport,
      }, CompatibilityCallToolResultSchema);

      if (result.isError) {
        const errorText = extractTextFromContent(result.content) ?? 'Unknown tool error';
        const errorMessage = annotateSandboxViolation(errorText, serverIsSandboxed);
        logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
        return { content: result.content, isError: true };
      }

      logAudit({ status: 'success' }, Date.now() - startTime);
      return { content: result.content };
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err);
      const errorMessage = annotateSandboxViolation(rawError, serverIsSandboxed);
      logAudit({ status: 'error', error: errorMessage }, Date.now() - startTime);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Start on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean shutdown -- handle both SIGINT and SIGTERM since this process
  // is spawned as a child by Code Mode and may receive either signal.
  async function shutdown(): Promise<void> {
    for (const state of clientStates.values()) {
      try { await state.client.close(); } catch { /* ignore */ }
    }
    cleanupSettingsFiles(settingsDir);
    try { await server.close(); } catch { /* ignore */ }
    await auditLog.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`MCP Proxy Server fatal error: ${err}\n`);
  process.exit(1);
});
