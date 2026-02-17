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
 *   ALLOWED_DIRECTORY  -- sandbox boundary for policy evaluation
 *   AUDIT_LOG_PATH     -- path to the audit log file
 *   MCP_SERVERS_CONFIG -- JSON string of MCP server configs to proxy
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { v4 as uuidv4 } from 'uuid';
import { PolicyEngine } from './policy-engine.js';
import { AuditLog } from './audit-log.js';
import type { ToolCallRequest } from '../types/mcp.js';
import type { AuditEntry } from '../types/audit.js';
import type { MCPServerConfig } from '../config/types.js';

interface ProxiedTool {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

async function main() {
  const allowedDirectory = process.env.ALLOWED_DIRECTORY ?? '/tmp/ironcurtain-sandbox';
  const auditLogPath = process.env.AUDIT_LOG_PATH ?? './audit.jsonl';
  const serversConfigJson = process.env.MCP_SERVERS_CONFIG;

  if (!serversConfigJson) {
    process.stderr.write('MCP_SERVERS_CONFIG environment variable is required\n');
    process.exit(1);
  }

  const serversConfig: Record<string, MCPServerConfig> = JSON.parse(serversConfigJson);
  const policyEngine = new PolicyEngine(allowedDirectory);
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
    });

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
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
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

    // Build the base audit entry; result fields are set per branch below
    function logAudit(result: AuditEntry['result'], durationMs: number, escalationResult?: 'approved' | 'denied'): void {
      const entry: AuditEntry = {
        timestamp: request.timestamp,
        requestId: request.requestId,
        serverName: request.serverName,
        toolName: request.toolName,
        arguments: request.arguments,
        policyDecision,
        escalationResult,
        result,
        durationMs,
      };
      auditLog.log(entry);
    }

    if (evaluation.decision === 'escalate') {
      logAudit({ status: 'denied', error: evaluation.reason }, 0, 'denied');
      return {
        content: [{
          type: 'text',
          text: `ESCALATION REQUIRED: ${evaluation.reason}. Action denied pending human review.`,
        }],
        isError: true,
      };
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

  // Clean shutdown
  process.on('SIGINT', async () => {
    for (const client of clients.values()) {
      try { await client.close(); } catch { /* ignore */ }
    }
    await auditLog.close();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`MCP Proxy Server fatal error: ${err}\n`);
  process.exit(1);
});
