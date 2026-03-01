#!/usr/bin/env npx tsx
/**
 * Debug script: demonstrates MCP error message extraction.
 *
 * Uses in-memory mock clients that throw realistic MCP errors
 * (matching what the git MCP server produces), then sends
 * tool calls through `handleCallTool` and prints the results.
 *
 * Usage:
 *   npx tsx scripts/debug-mcp-errors.ts
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { extractMcpErrorMessage } from '../src/trusted-process/mcp-error-utils.js';

// ── Part 1: Direct extraction demo ──────────────────────────────────────

console.log('═══════════════════════════════════════════════════');
console.log('Part 1: extractMcpErrorMessage — before vs after');
console.log('═══════════════════════════════════════════════════\n');

const testErrors = [
  {
    label: 'Schema validation with data string (real git_push failure)',
    error: new McpError(
      ErrorCode.InvalidParams,
      "Structured content does not match the tool's output schema",
      'No session working directory set',
    ),
  },
  {
    label: 'Schema validation with data.message',
    error: new McpError(ErrorCode.InvalidParams, 'Structured content does not match', {
      message: 'Repository not found at /tmp/nonexistent',
    }),
  },
  {
    label: 'Schema validation with data.content array',
    error: new McpError(ErrorCode.InvalidParams, 'Structured content does not match', {
      content: [{ type: 'text', text: 'fatal: not a git repository' }],
    }),
  },
  {
    label: 'Internal error (non-validation McpError)',
    error: new McpError(ErrorCode.InternalError, 'git process exited with code 128'),
  },
  {
    label: 'Regular Error (non-MCP)',
    error: new Error('ECONNREFUSED: connection refused'),
  },
];

for (const { label, error } of testErrors) {
  const raw = error instanceof Error ? error.message : String(error);
  const extracted = extractMcpErrorMessage(error);
  console.log(`  ${label}`);
  console.log(`    raw:       ${raw}`);
  console.log(`    extracted: ${extracted}`);
  console.log(`    improved:  ${raw !== extracted ? 'YES ✓' : 'no change'}\n`);
}

// ── Part 2: End-to-end through handleCallTool ───────────────────────────

console.log('═══════════════════════════════════════════════════');
console.log('Part 2: End-to-end through handleCallTool');
console.log('═══════════════════════════════════════════════════\n');

// Dynamically import handleCallTool (avoids top-level env var requirements)
const { handleCallTool } = await import('../src/trusted-process/mcp-proxy-server.js');

// Build minimal mock deps (same pattern as unit tests)
function createE2EDeps(mockClient: { callTool: (...args: unknown[]) => Promise<unknown> }) {
  const tool = {
    serverName: 'git',
    name: 'git_status',
    inputSchema: { type: 'object' as const },
  };
  const toolMap = new Map();
  toolMap.set('git_status', tool);

  const annotation = {
    toolName: 'git_status',
    serverName: 'git',
    comment: 'Show status',
    sideEffects: false,
    args: {},
  };

  const policyEngine = {
    getAnnotation: () => annotation,
    evaluate: () => ({ decision: 'allow', rule: 'test', reason: 'allowed' }),
  };

  const clientStates = new Map();
  clientStates.set('git', { client: mockClient, roots: [] });

  const resolvedSandboxConfigs = new Map();
  resolvedSandboxConfigs.set('git', { sandboxed: false, reason: 'debug' });

  return {
    toolMap,
    policyEngine: policyEngine as unknown as Parameters<typeof handleCallTool>[2]['policyEngine'],
    auditLog: { log: () => {} } as unknown as Parameters<typeof handleCallTool>[2]['auditLog'],
    circuitBreaker: { check: () => ({ allowed: true }) } as unknown as Parameters<
      typeof handleCallTool
    >[2]['circuitBreaker'],
    clientStates,
    resolvedSandboxConfigs,
    allowedDirectory: undefined,
    containerWorkspaceDir: undefined,
    escalationDir: undefined,
    autoApproveModel: null,
    serverContextMap: new Map(),
  };
}

// Scenario A: McpError with InvalidParams + data string
{
  const mockClient = {
    callTool: async () => {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Structured content does not match the tool's output schema",
        'No session working directory set',
      );
    },
  };
  const deps = createE2EDeps(mockClient);
  const result = await handleCallTool('git_status', {}, deps);
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  console.log('  Scenario A: git_status with no working directory (McpError + data)');
  console.log(`    isError:  ${result.isError}`);
  console.log(`    message:  ${text}`);
  console.log(`    clean:    ${!text?.includes('Structured content') ? 'YES ✓' : 'NO — still opaque'}\n`);
}

// Scenario B: Regular error
{
  const mockClient = {
    callTool: async () => {
      throw new Error('spawn git ENOENT');
    },
  };
  const deps = createE2EDeps(mockClient);
  const result = await handleCallTool('git_status', {}, deps);
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  console.log('  Scenario B: git binary not found (regular Error)');
  console.log(`    isError:  ${result.isError}`);
  console.log(`    message:  ${text}\n`);
}

// Scenario C: McpError without data (other error codes)
{
  const mockClient = {
    callTool: async () => {
      throw new McpError(ErrorCode.InternalError, 'git process exited with code 128');
    },
  };
  const deps = createE2EDeps(mockClient);
  const result = await handleCallTool('git_status', {}, deps);
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  console.log('  Scenario C: git process crash (McpError, no data)');
  console.log(`    isError:  ${result.isError}`);
  console.log(`    message:  ${text}`);
  console.log(`    clean:    ${!text?.includes('MCP error') ? 'YES ✓' : 'NO — still has prefix'}\n`);
}

console.log('Done.');
