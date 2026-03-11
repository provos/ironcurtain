import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, realpathSync, watch, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FSWatcher } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { AuditLog } from '../src/trusted-process/audit-log.js';
import { CallCircuitBreaker } from '../src/trusted-process/call-circuit-breaker.js';
import { toMcpRoots } from '../src/trusted-process/policy-roots.js';
import { atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';
import { permissiveJsonSchemaValidator } from '../src/trusted-process/permissive-output-validator.js';
import { VERSION } from '../src/version.js';
import {
  handleCallTool,
  extractTextFromContent,
  ROOTS_RACE_RETRY_DELAY_MS,
  type CallToolDeps,
  type ClientState,
  type ProxiedTool,
} from '../src/trusted-process/mcp-proxy-server.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import type { McpRoot } from '../src/trusted-process/mcp-client-manager.js';

/**
 * Integration test for the roots-expansion race condition retry logic
 * in `handleCallTool` (mcp-proxy-server.ts lines ~813-815).
 *
 * When an escalation is approved for a path outside the sandbox,
 * `handleCallTool` expands roots and immediately calls the tool.
 * The filesystem server may not have finished async-validating the
 * new roots yet, producing an "access denied" error. The retry logic
 * catches this and retries once after ROOTS_RACE_RETRY_DELAY_MS.
 *
 * This test uses a real `@modelcontextprotocol/server-filesystem` and
 * routes through `handleCallTool` so the retry code path is exercised.
 */
describe('MCP roots-expansion race -- handleCallTool retry', () => {
  const RAW_DIR_A = `/tmp/ironcurtain-roots-race-a-${process.pid}`;
  const RAW_DIR_B = `/tmp/ironcurtain-roots-race-b-${process.pid}`;
  const RAW_ESCALATION_DIR = `/tmp/ironcurtain-roots-race-esc-${process.pid}`;
  const RAW_AUDIT_PATH = `/tmp/ironcurtain-roots-race-audit-${process.pid}.jsonl`;

  let DIR_A: string;
  let DIR_B: string;
  let ESCALATION_DIR: string;

  let client: Client;
  let clientState: ClientState;
  let auditLog: AuditLog;
  let escalationWatcher: FSWatcher | undefined;

  /**
   * Watches the escalation directory and instantly approves any request
   * by writing the corresponding response file. This avoids needing a
   * real human or an LLM auto-approver.
   */
  function startEscalationAutoApprover(dir: string): FSWatcher {
    return watch(dir, (_eventType, filename) => {
      if (!filename || !filename.startsWith('request-') || !filename.endsWith('.json')) return;
      const escalationId = filename.replace('request-', '').replace('.json', '');
      const responsePath = join(dir, `response-${escalationId}.json`);
      try {
        // Small delay not needed -- the proxy polls on a 500ms interval,
        // so the file just needs to exist before the next poll.
        atomicWriteJsonSync(responsePath, { decision: 'approved' });
      } catch {
        /* ignore write races */
      }
    });
  }

  beforeAll(async () => {
    // Create directories and test files
    mkdirSync(RAW_DIR_A, { recursive: true });
    mkdirSync(RAW_DIR_B, { recursive: true });
    mkdirSync(RAW_ESCALATION_DIR, { recursive: true });

    DIR_A = realpathSync(RAW_DIR_A);
    DIR_B = realpathSync(RAW_DIR_B);
    ESCALATION_DIR = realpathSync(RAW_ESCALATION_DIR);

    writeFileSync(`${DIR_A}/hello.txt`, 'File in directory A');
    writeFileSync(`${DIR_B}/secret.txt`, 'File in directory B');

    // Connect a real MCP client to the filesystem server with DIR_A as root.
    // The server only knows about DIR_A initially -- DIR_B is unknown.
    const initialRoots: McpRoot[] = toMcpRoots([{ path: DIR_A, name: 'dir-a' }]);

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', DIR_A],
    });

    client = new Client(
      { name: 'ironcurtain-test', version: VERSION },
      {
        capabilities: { roots: { listChanged: true } },
        jsonSchemaValidator: permissiveJsonSchemaValidator,
      },
    );

    clientState = { client, roots: [...initialRoots] };

    // Mirror the roots/list handler from mcp-proxy-server.ts:
    // when the server requests roots, return the current set and
    // resolve the rootsRefreshed callback if one is pending.
    client.setRequestHandler(ListRootsRequestSchema, () => {
      if (clientState.rootsRefreshed) {
        clientState.rootsRefreshed();
        clientState.rootsRefreshed = undefined;
      }
      return { roots: clientState.roots };
    });

    await client.connect(transport);

    // Give the server a moment to finish initial root validation
    await new Promise((r) => setTimeout(r, 500));

    // Create audit log
    auditLog = new AuditLog(RAW_AUDIT_PATH);

    // Start the auto-approver watcher
    escalationWatcher = startEscalationAutoApprover(ESCALATION_DIR);
  }, 30_000);

  afterAll(async () => {
    escalationWatcher?.close();
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    await auditLog.close();
    rmSync(RAW_DIR_A, { recursive: true, force: true });
    rmSync(RAW_DIR_B, { recursive: true, force: true });
    rmSync(RAW_ESCALATION_DIR, { recursive: true, force: true });
    rmSync(RAW_AUDIT_PATH, { force: true });
  });

  /**
   * Builds a PolicyEngine + CallToolDeps wired to the real filesystem
   * server. The policy allows reads inside DIR_A (sandbox) and
   * escalates reads outside it (DIR_B).
   */
  function buildDeps(): CallToolDeps {
    const compiledPolicy: CompiledPolicyFile = {
      generatedAt: 'test-fixture',
      constitutionHash: 'test-fixture',
      inputHash: 'test-fixture',
      rules: [
        {
          name: 'escalate-read-outside-sandbox',
          description: 'Escalate reads outside sandbox.',
          principle: 'Human oversight',
          if: {
            roles: ['read-path'],
            server: ['filesystem'],
          },
          then: 'escalate',
          reason: 'Reads outside sandbox require approval.',
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
              sideEffects: true,
              args: { path: ['read-path'] },
            },
          ],
        },
      },
    };

    const policyEngine = new PolicyEngine(
      compiledPolicy,
      toolAnnotations,
      [], // no protected paths
      DIR_A, // sandbox = DIR_A
    );

    const readFileTool: ProxiedTool = {
      serverName: 'filesystem',
      name: 'read_file',
      inputSchema: { type: 'object' },
    };

    const toolMap = new Map<string, ProxiedTool>();
    toolMap.set('read_file', readFileTool);

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
      allowedDirectory: DIR_A,
      escalationDir: ESCALATION_DIR,
      autoApproveModel: null,
      serverContextMap: new Map(),
    };
  }

  it('reads a file inside the sandbox without escalation', async () => {
    const deps = buildDeps();

    const result = await handleCallTool('read_file', { path: `${DIR_A}/hello.txt` }, deps);

    expect(result.isError).toBeFalsy();
    const text = extractTextFromContent(result.content);
    expect(text).toContain('File in directory A');
  }, 15_000);

  it('escalates and succeeds for a file outside the sandbox (exercises retry logic)', async () => {
    const deps = buildDeps();

    // This call triggers:
    // 1. Policy engine evaluates → escalate (DIR_B outside sandbox)
    // 2. Escalation file written → auto-approver writes response
    // 3. Root expanded for DIR_B → addRootToClient sends rootsListChanged
    // 4. Tool call issued → may get "access denied" (race condition)
    // 5. isRootsRaceError check → retry after ROOTS_RACE_RETRY_DELAY_MS
    const result = await handleCallTool('read_file', { path: `${DIR_B}/secret.txt` }, deps);

    expect(result.isError).toBeFalsy();
    const text = extractTextFromContent(result.content);
    expect(text).toContain('File in directory B');

    // Verify the audit log recorded the escalation as approved.
    // AuditLog uses appendFileSync, so we can read the file directly.
    const auditContent = readFileSync(RAW_AUDIT_PATH, 'utf-8');
    const entries = auditContent
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const escalatedEntry = entries.find((e: Record<string, unknown>) => e.escalationResult === 'approved');
    expect(escalatedEntry).toBeDefined();
  }, 15_000);

  it('exported ROOTS_RACE_RETRY_DELAY_MS is a positive number', () => {
    expect(ROOTS_RACE_RETRY_DELAY_MS).toBeGreaterThan(0);
    expect(ROOTS_RACE_RETRY_DELAY_MS).toBeLessThanOrEqual(1000);
  });
});
