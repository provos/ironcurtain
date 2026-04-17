import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { AuditLog } from '../src/trusted-process/audit-log.js';
import { CallCircuitBreaker } from '../src/trusted-process/call-circuit-breaker.js';
import { toMcpRoots } from '../src/trusted-process/policy-roots.js';
import { createApprovalWhitelist } from '../src/trusted-process/approval-whitelist.js';
import { permissiveJsonSchemaValidator } from '../src/trusted-process/permissive-output-validator.js';
import { VERSION } from '../src/version.js';
import {
  handleCallTool,
  extractTextFromContent,
  buildToolMap,
  type CallToolDeps,
  type ClientState,
  type ProxiedTool,
} from '../src/trusted-process/tool-call-pipeline.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import type { McpRoot } from '../src/trusted-process/mcp-client-manager.js';

/**
 * Integration test: argument name validation with a real filesystem MCP server.
 *
 * Verifies that tool calls with incorrect parameter names (e.g., snake_case
 * instead of camelCase) are rejected with an actionable error, and that calls
 * with correct parameter names succeed.
 */
describe('argument name validation -- real filesystem server', () => {
  const RAW_DIR = `/tmp/ironcurtain-arg-validation-${process.pid}`;
  const RAW_AUDIT_PATH = `/tmp/ironcurtain-arg-validation-audit-${process.pid}.jsonl`;

  let DIR: string;
  let client: Client;
  let clientState: ClientState;
  let auditLog: AuditLog;
  let allTools: ProxiedTool[];

  beforeAll(async () => {
    mkdirSync(RAW_DIR, { recursive: true });
    DIR = realpathSync(RAW_DIR);
    writeFileSync(`${DIR}/test.txt`, 'hello from integration test');

    // Connect a real MCP client to the filesystem server
    const initialRoots: McpRoot[] = toMcpRoots([{ path: DIR, name: 'sandbox' }]);

    const transport = new StdioClientTransport({
      command: 'mcp-server-filesystem',
      args: [DIR],
    });

    client = new Client(
      { name: 'ironcurtain-arg-validation-test', version: VERSION },
      {
        capabilities: { roots: { listChanged: true } },
        jsonSchemaValidator: permissiveJsonSchemaValidator,
      },
    );

    clientState = { client, roots: [...initialRoots] };

    client.setRequestHandler(ListRootsRequestSchema, () => {
      if (clientState.rootsRefreshed) {
        clientState.rootsRefreshed();
        clientState.rootsRefreshed = undefined;
      }
      return { roots: clientState.roots };
    });

    await client.connect(transport);
    await new Promise((r) => setTimeout(r, 500));

    // List tools from real server to get real inputSchemas (with properties)
    const result = await client.listTools();
    allTools = result.tools.map((tool) => ({
      serverName: 'filesystem',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));

    auditLog = new AuditLog(RAW_AUDIT_PATH);
  }, 30_000);

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    await auditLog.close();
    rmSync(RAW_DIR, { recursive: true, force: true });
    rmSync(RAW_AUDIT_PATH, { force: true });
  });

  function buildDeps(): CallToolDeps {
    const compiledPolicy: CompiledPolicyFile = {
      generatedAt: 'test-fixture',
      constitutionHash: 'test-fixture',
      inputHash: 'test-fixture',
      rules: [
        {
          name: 'allow-sandbox-reads',
          description: 'Allow reads inside sandbox.',
          principle: 'Safe read access',
          if: { roles: ['read-path'], server: ['filesystem'] },
          then: 'allow',
          reason: 'Reads inside sandbox are safe.',
        },
      ],
    };

    const toolAnnotations: ToolAnnotationsFile = {
      generatedAt: 'test-fixture',
      servers: {
        filesystem: {
          inputHash: 'test-fixture',
          tools: [
            {
              toolName: 'read_file',
              serverName: 'filesystem',
              comment: 'Reads file contents.',
              args: { path: ['read-path'] },
            },
          ],
        },
      },
    };

    const policyEngine = new PolicyEngine(compiledPolicy, toolAnnotations, [], DIR);

    const toolMap = buildToolMap(allTools);

    const clientStates = new Map<string, ClientState>();
    clientStates.set('filesystem', clientState);

    const resolvedSandboxConfigs = new Map();
    resolvedSandboxConfigs.set('filesystem', { sandboxed: false, reason: 'opt-out' });

    return {
      toolMap,
      policyEngine,
      auditLog,
      circuitBreaker: new CallCircuitBreaker(),
      clientStates,
      resolvedSandboxConfigs,
      allowedDirectory: DIR,
      escalationDir: undefined,
      autoApproveModel: null,
      serverContextMap: new Map(),
      whitelist: createApprovalWhitelist(),
    };
  }

  it('rejects snake_case parameter names with an actionable error', async () => {
    const deps = buildDeps();

    // Send snake_case args — the real schema uses camelCase "path"
    const result = await handleCallTool('read_file', { file_path: `${DIR}/test.txt` }, deps);

    expect(result.isError).toBe(true);
    const text = extractTextFromContent(result.content);
    expect(text).toContain('Unknown argument(s): "file_path"');
    expect(text).toContain('"path"');
  }, 15_000);

  it('succeeds with correct parameter names after correction', async () => {
    const deps = buildDeps();

    // Send correct camelCase args
    const result = await handleCallTool('read_file', { path: `${DIR}/test.txt` }, deps);

    expect(result.isError).toBeFalsy();
    const text = extractTextFromContent(result.content);
    expect(text).toContain('hello from integration test');
  }, 15_000);

  it('rejects when mixing valid and invalid parameter names', async () => {
    const deps = buildDeps();

    // "path" is valid, "num_lines" is not (should be "head" or "tail")
    const result = await handleCallTool('read_file', { path: `${DIR}/test.txt`, num_lines: 5 }, deps);

    expect(result.isError).toBe(true);
    const text = extractTextFromContent(result.content);
    expect(text).toContain('Unknown argument(s): "num_lines"');
    expect(text).toContain('"head"');
    expect(text).toContain('"tail"');
  }, 15_000);

  it('uses real inputSchema from server (has properties field)', () => {
    const readFileTool = allTools.find((t) => t.name === 'read_file');
    expect(readFileTool).toBeDefined();

    const schema = readFileTool!.inputSchema;
    expect(schema).toHaveProperty('properties');
    expect(schema.properties).toHaveProperty('path');
  });
});
