/**
 * Integration test for Docker Code Mode proxy.
 *
 * Part A (always runs): Host-side test that creates a CodeModeProxy
 * with a real filesystem MCP server, connects via MCP client over UDS,
 * and verifies execute_code works with help.help() and actual tool calls.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createCodeModeProxy, type DockerProxy } from '../src/docker/code-mode-proxy.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';
import { UdsClientTransport } from './helpers/uds-client-transport.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const SANDBOX_DIR = `${REAL_TMP}/ironcurtain-docker-cm-test-${process.pid}`;
const AUDIT_LOG_PATH = `${REAL_TMP}/ironcurtain-docker-cm-audit-${process.pid}.jsonl`;
const GENERATED_DIR = `${REAL_TMP}/ironcurtain-docker-cm-generated-${process.pid}`;
const SOCKET_PATH = `${REAL_TMP}/ironcurtain-docker-cm-test-${process.pid}.sock`;

function writeTestArtifacts(
  dir: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
  writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));
}

/**
 * Connects an MCP client to the proxy socket, runs a callback, and
 * ensures the client is closed afterwards.
 */
async function withClient<T>(socketPath: string, name: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new UdsClientTransport(socketPath);
  const client = new Client({ name, version: '0.0.0' }, {});
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

describe('Docker Code Mode proxy integration', () => {
  let proxy: DockerProxy;

  const config: IronCurtainConfig = {
    auditLogPath: AUDIT_LOG_PATH,
    allowedDirectory: SANDBOX_DIR,
    mcpServers: {
      filesystem: {
        description: 'Read, write, search, and manage files and directories',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX_DIR],
        sandbox: false,
      },
    },
    protectedPaths: [
      resolve(projectRoot, 'src/config/constitution.md'),
      resolve(projectRoot, 'src/config/generated'),
      resolve(projectRoot, 'src/config/mcp-servers.json'),
      resolve(AUDIT_LOG_PATH),
    ],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: '',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      serverCredentials: {},
    },
  };

  beforeAll(async () => {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    writeFileSync(`${SANDBOX_DIR}/test.txt`, 'hello from docker code mode test');
    writeTestArtifacts(GENERATED_DIR, testCompiledPolicy, testToolAnnotations);

    proxy = createCodeModeProxy({
      socketPath: SOCKET_PATH,
      config,
      listenMode: 'uds',
    });
    await proxy.start();
  }, 30_000);

  afterAll(async () => {
    await proxy.stop();
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
    rmSync(GENERATED_DIR, { recursive: true, force: true });
    rmSync(AUDIT_LOG_PATH, { force: true });
    rmSync(SOCKET_PATH, { force: true });
  });

  it('listTools returns only execute_code', async () => {
    await withClient(SOCKET_PATH, 'test-lister', async (client) => {
      const result = await client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('execute_code');
    });
  });

  it('execute_code with help.help() returns server listing', async () => {
    await withClient(SOCKET_PATH, 'test-help', async (client) => {
      const result = await client.callTool({
        name: 'execute_code',
        arguments: { code: 'return help.help();' },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Available tool servers:');
      expect(text).toContain('filesystem');
    });
  });

  it("execute_code with help.help('filesystem') returns tool listing", async () => {
    await withClient(SOCKET_PATH, 'test-help-server', async (client) => {
      const result = await client.callTool({
        name: 'execute_code',
        arguments: { code: "return help.help('filesystem');" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Tools in filesystem:');
      expect(text).toContain('filesystem_read_file');
    });
  });

  it('execute_code with actual tool call reads a seeded file', async () => {
    await withClient(SOCKET_PATH, 'test-tool-call', async (client) => {
      const result = await client.callTool({
        name: 'execute_code',
        arguments: {
          code: `const r = tools.filesystem_read_file({ path: "${SANDBOX_DIR}/test.txt" }); return r;`,
        },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('hello from docker code mode test');
    });
  });

  it('getHelpData returns structured data', () => {
    const helpData = proxy.getHelpData();
    expect(helpData.serverDescriptions).toHaveProperty('filesystem');
    expect(helpData.toolsByServer).toHaveProperty('filesystem');
    expect(helpData.toolsByServer.filesystem.length).toBeGreaterThan(0);
  });

  it('execute_code with missing code returns error', async () => {
    await withClient(SOCKET_PATH, 'test-error', async (client) => {
      const result = await client.callTool({
        name: 'execute_code',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Missing required parameter');
    });
  });

  it('execute_code with unknown tool name returns error', async () => {
    await withClient(SOCKET_PATH, 'test-unknown', async (client) => {
      const result = await client.callTool({
        name: 'nonexistent_tool',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('Unknown tool');
    });
  });
});
