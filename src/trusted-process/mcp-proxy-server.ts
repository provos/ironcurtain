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
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { loadGeneratedPolicy } from '../config/index.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLog } from './audit-log.js';
import { normalizeToolArgPaths } from './path-utils.js';
import type { ToolCallRequest } from '../types/mcp.js';
import type { AuditEntry } from '../types/audit.js';
import type { MCPServerConfig } from '../config/types.js';

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

const ESCALATION_POLL_INTERVAL_MS = 500;
const ESCALATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

  const deadline = Date.now() + ESCALATION_TIMEOUT_MS;

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

  const serversConfig: Record<string, MCPServerConfig> = JSON.parse(serversConfigJson);
  const protectedPaths: string[] = JSON.parse(protectedPathsJson);

  const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(generatedDir);
  const policyEngine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths, allowedDirectory);
  const auditLog = new AuditLog(auditLogPath);

  // Connect to real MCP servers as clients
  const clients = new Map<string, Client>();
  const allTools: ProxiedTool[] = [];

  for (const [serverName, config] of Object.entries(serversConfig)) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
        ? { ...(process.env as Record<string, string>), ...config.env }
        : undefined,
      stderr: 'pipe', // Prevent child server stderr from leaking to the terminal
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

    const client = new Client({ name: 'ironcurtain-proxy', version: '0.1.0' });
    await client.connect(transport);
    clients.set(serverName, client);

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
    const args = normalizeToolArgPaths(rawArgs);
    const toolInfo = toolMap.get(toolName);

    if (!toolInfo) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    const request: ToolCallRequest = {
      requestId: uuidv4(),
      serverName: toolInfo.serverName,
      toolName: toolInfo.name,
      arguments: args,
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

    // Build the base audit entry; result fields are set per branch below
    function logAudit(result: AuditEntry['result'], durationMs: number, overrideEscalation?: 'approved' | 'denied'): void {
      const entry: AuditEntry = {
        timestamp: request.timestamp,
        requestId: request.requestId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: request.arguments,
        policyDecision,
        escalationResult: overrideEscalation ?? escalationResult,
        result,
        durationMs,
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

      // File-based escalation rendezvous: write request, poll for response
      const escalationId = uuidv4();
      const decision = await waitForEscalationDecision(escalationDir, {
        escalationId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: request.arguments,
        reason: evaluation.reason,
      });

      if (decision === 'denied') {
        logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
        return {
          content: [{ type: 'text', text: `ESCALATION DENIED: ${evaluation.reason}` }],
          isError: true,
        };
      }

      // Approved -- update policy decision and fall through to forward the call
      escalationResult = 'approved';
      policyDecision.status = 'allow';
      policyDecision.reason = 'Approved by human during escalation';
    }

    if (evaluation.decision === 'deny') {
      logAudit({ status: 'denied', error: evaluation.reason }, 0);
      return {
        content: [{ type: 'text', text: `DENIED: ${evaluation.reason}` }],
        isError: true,
      };
    }

    // Policy allows -- forward to the real MCP server
    const startTime = Date.now();
    try {
      const client = clients.get(toolInfo.serverName)!;
      const result = await client.callTool({
        name: toolInfo.name,
        arguments: args,
      });

      logAudit({ status: 'success' }, Date.now() - startTime);
      return { content: result.content };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
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
    for (const client of clients.values()) {
      try { await client.close(); } catch { /* ignore */ }
    }
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
