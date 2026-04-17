/**
 * Integration test for escalation-time roots bridging across the
 * relay-subprocess architecture.
 *
 * The coordinator owns the authoritative MCP roots. When an
 * escalation is approved for a path outside the initial sandbox,
 * `handleCallTool` extends the coordinator's roots. That update must
 * flow through the mcp-proxy-server relay subprocess and reach the
 * real backend MCP server, or the subsequent forwarded tool call will
 * fail with "access denied" / "outside allowed directories" even
 * though policy said yes.
 *
 * This test exercises the full path end-to-end:
 *
 *   [ToolCallCoordinator] → [MCPClientManager]
 *          ↓ stdio
 *   [mcp-proxy-server.ts relay subprocess]
 *          ↓ stdio
 *   [@modelcontextprotocol/server-filesystem backend]
 *
 * Setup: the backend is granted initial access to DIR_A only. DIR_B
 * is outside the sandbox and should escalate on read. After the test
 * escalation callback approves, the coordinator extends roots with
 * DIR_B. The relay must fetch the updated roots, replace its shared
 * array, and notify the backend -- otherwise the subsequent read
 * fails with "outside allowed directories".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import { MCPClientManager } from '../src/trusted-process/mcp-client-manager.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import type { MCPServerConfig } from '../src/config/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const proxyServerPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');

/** Writes a minimal compiled-policy + tool-annotations pair into a directory. */
function writePolicyArtifacts(
  dir: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
  writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));
}

describe('Roots expansion bridges across the relay subprocess', () => {
  const RAW_DIR_A = `/tmp/ironcurtain-roots-bridge-a-${process.pid}`;
  const RAW_DIR_B = `/tmp/ironcurtain-roots-bridge-b-${process.pid}`;
  const AUDIT_PATH = `/tmp/ironcurtain-roots-bridge-audit-${process.pid}.jsonl`;
  const POLICY_DIR = `/tmp/ironcurtain-roots-bridge-policy-${process.pid}`;

  let DIR_A: string;
  let DIR_B: string;

  let manager: MCPClientManager;
  let coordinator: ToolCallCoordinator;
  let escalationInvocations = 0;
  let escalationResponse: 'approved' | 'denied' = 'approved';

  beforeAll(async () => {
    mkdirSync(RAW_DIR_A, { recursive: true });
    mkdirSync(RAW_DIR_B, { recursive: true });

    DIR_A = realpathSync(RAW_DIR_A);
    DIR_B = realpathSync(RAW_DIR_B);

    writeFileSync(`${DIR_A}/hello.txt`, 'File in directory A');
    writeFileSync(`${DIR_B}/secret.txt`, 'File in directory B');

    // Policy used by BOTH the coordinator and the relay subprocess
    // (the subprocess derives initial MCP roots from it at startup).
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
              args: { path: ['read-path'] },
            },
          ],
        },
      },
    };

    writePolicyArtifacts(POLICY_DIR, compiledPolicy, toolAnnotations);

    // Spawn the relay subprocess. The subprocess connects to a real
    // filesystem MCP server backend (DIR_A is its initial root).
    manager = new MCPClientManager();

    const backendServers = {
      filesystem: {
        command: 'mcp-server-filesystem',
        args: [DIR_A],
        sandbox: false,
      },
    };

    const subprocessConfig: MCPServerConfig = {
      command: tsxBin,
      args: [proxyServerPath],
      env: {
        MCP_SERVERS_CONFIG: JSON.stringify(backendServers),
        GENERATED_DIR: POLICY_DIR,
        ALLOWED_DIRECTORY: DIR_A,
        SERVER_FILTER: 'filesystem',
        SANDBOX_POLICY: 'warn',
        PATH: process.env.PATH ?? '',
      },
      sandbox: false,
    };

    // Coordinator-side initial roots: DIR_A only. This matches what
    // the relay will advertise to the backend at startup.
    const initialRoots = [{ uri: `file://${DIR_A}`, name: 'sandbox' }];

    await manager.connect('filesystem', subprocessConfig, initialRoots);

    coordinator = new ToolCallCoordinator({
      compiledPolicy,
      toolAnnotations,
      protectedPaths: [],
      allowedDirectory: DIR_A,
      auditLogPath: AUDIT_PATH,
      mcpManager: manager,
      onEscalation: async () => {
        escalationInvocations += 1;
        return { decision: escalationResponse };
      },
    });

    // Register the relay's tools and share its live ClientState so
    // escalation-time root expansion mutates the same array the
    // manager returns from its `roots/list` handler.
    const tools = await manager.listTools('filesystem');
    const clientState = manager.getClientState('filesystem');
    expect(clientState).toBeDefined();
    if (!clientState) throw new Error('client state missing');

    coordinator.registerTools(
      'filesystem',
      tools.map((t) => ({
        serverName: 'filesystem',
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      })),
      clientState,
    );

    // Give the backend filesystem server a beat to finish initial
    // roots validation (async fs.realpath / fs.stat).
    await new Promise((r) => setTimeout(r, 500));
  }, 30_000);

  afterAll(async () => {
    // Coordinator was constructed with an injected manager, so it
    // won't close the manager itself. Close both explicitly so the
    // relay subprocess exits cleanly.
    try {
      await manager.closeAll();
    } catch {
      /* best-effort */
    }
    try {
      await coordinator.close();
    } catch {
      /* best-effort */
    }
    rmSync(RAW_DIR_A, { recursive: true, force: true });
    rmSync(RAW_DIR_B, { recursive: true, force: true });
    rmSync(POLICY_DIR, { recursive: true, force: true });
    rmSync(AUDIT_PATH, { force: true });
  });

  function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
    return {
      requestId: uuidv4(),
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: `${DIR_A}/hello.txt` },
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it('reads a file inside the sandbox without escalation', async () => {
    const before = escalationInvocations;
    const result = await coordinator.handleStructuredToolCall(makeRequest());

    expect(result.status).toBe('success');
    expect(escalationInvocations).toBe(before);
  }, 20_000);

  it('escalates and succeeds for a file outside the sandbox via the relay', async () => {
    // This is the regression test for the roots-expansion bug.
    //
    // Pre-fix flow:
    //   1. Policy engine says 'escalate' for DIR_B/secret.txt
    //   2. Mock callback approves
    //   3. Coordinator pushes DIR_B root onto ClientState.roots
    //   4. Coordinator calls sendRootsListChanged() on the relay
    //   5. Relay subprocess had no roots/list_changed handler, so
    //      the backend filesystem server never learned about DIR_B
    //   6. Forwarded read_file call fails with "outside allowed
    //      directories"
    //
    // Post-fix flow: the relay fetches fresh roots via
    // server.listRoots(), updates its shared `relayRoots` array,
    // and calls sendRootsListChanged() on its backend client. The
    // backend re-queries and accepts the call.
    escalationResponse = 'approved';
    const before = escalationInvocations;
    const result = await coordinator.handleStructuredToolCall(
      makeRequest({ arguments: { path: `${DIR_B}/secret.txt` } }),
    );

    expect(escalationInvocations).toBe(before + 1);
    expect(result.status).toBe('success');
    const text = JSON.stringify(result.content);
    expect(text).toContain('File in directory B');
  }, 20_000);

  it('denies (no roots expansion) when the human declines the escalation', async () => {
    escalationResponse = 'denied';
    const result = await coordinator.handleStructuredToolCall(
      makeRequest({ arguments: { path: `${DIR_B}/secret.txt` } }),
    );

    expect(result.status).toBe('denied');
    expect(result.policyDecision.status).toBe('deny');
  }, 20_000);
});
