import { tool, jsonSchema, type ToolSet } from 'ai';
import { v4 as uuidv4 } from 'uuid';
import type { TrustedProcess } from '../trusted-process/index.js';
import type { ToolCallRequest } from '../types/mcp.js';

/**
 * Creates AI SDK tools from MCP tool schemas for direct tool-call mode.
 * Each tool's execute function routes through the trusted process,
 * which evaluates policy before forwarding to the real MCP server.
 * Used for testing and as a fallback; the primary mode is Code Mode.
 */
export function createToolsFromMCPServer(
  serverName: string,
  mcpTools: { name: string; description?: string; inputSchema: unknown }[],
  trustedProcess: TrustedProcess,
): ToolSet {
  const tools: ToolSet = {};

  for (const mcpTool of mcpTools) {
    const toolName = `${serverName}__${mcpTool.name}`;

    // Some MCP servers omit "type": "object" from their tool schemas
    const schema = mcpTool.inputSchema as Record<string, unknown>;
    if (!schema.type) {
      schema.type = 'object';
    }

    tools[toolName] = tool({
      description: mcpTool.description ?? mcpTool.name,
      inputSchema: jsonSchema(schema),
      execute: async (args: Record<string, unknown>) => {
        const request: ToolCallRequest = {
          requestId: uuidv4(),
          serverName,
          toolName: mcpTool.name,
          arguments: args,
          timestamp: new Date().toISOString(),
        };

        const result = await trustedProcess.handleToolCall(request);

        if (result.status === 'denied') {
          return {
            error: 'denied',
            reason: result.policyDecision.reason,
            message: `Tool call denied: ${result.policyDecision.reason}. Try a different approach.`,
          };
        }

        if (result.status === 'error') {
          const content = result.content as Record<string, unknown> | undefined;
          const errorDetail = (content?.error as string) ?? 'Unknown error';
          return {
            error: 'execution_error',
            message: `Tool execution failed: ${errorDetail}`,
          };
        }

        return result.content;
      },
    });
  }

  return tools;
}
