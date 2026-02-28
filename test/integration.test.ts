import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { TrustedProcess, type EscalationPromptFn } from '../src/trusted-process/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import { testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const SANDBOX_DIR = `/tmp/ironcurtain-test-${process.pid}`;
const AUDIT_LOG_PATH = `/tmp/ironcurtain-test-audit-${process.pid}.jsonl`;

/**
 * Writes the rewritten policy artifacts to a temp directory so that
 * TrustedProcess.loadGeneratedPolicy() reads the correct paths.
 */
function writeTestArtifacts(
  dir: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
  writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));
}

/** Shared userConfig for integration tests (no API keys, auto-features off). */
const TEST_USER_CONFIG: IronCurtainConfig['userConfig'] = {
  agentModelId: 'anthropic:claude-sonnet-4-6',
  policyModelId: 'anthropic:claude-sonnet-4-6',
  anthropicApiKey: '',
  googleApiKey: '',
  openaiApiKey: '',
  escalationTimeoutSeconds: 300,
  resourceBudget: {
    maxTotalTokens: null,
    maxSteps: null,
    maxSessionSeconds: null,
    maxEstimatedCostUsd: null,
    warnThresholdPercent: 80,
  },
  autoCompact: {
    enabled: false,
    thresholdTokens: 80_000,
    keepRecentMessages: 10,
    summaryModelId: 'anthropic:claude-haiku-4-5',
  },
  autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
  auditRedaction: { enabled: true },
};

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: uuidv4(),
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('Integration: TrustedProcess with filesystem MCP server', () => {
  let trustedProcess: TrustedProcess;
  let lastEscalationRequest: ToolCallRequest | null = null;
  let escalationResponse: 'approved' | 'denied' = 'denied';

  const mockEscalation: EscalationPromptFn = async (request) => {
    lastEscalationRequest = request;
    return escalationResponse;
  };

  const testGeneratedDir = `/tmp/ironcurtain-test-generated-${process.pid}`;

  beforeAll(async () => {
    // Create sandbox with test files
    mkdirSync(SANDBOX_DIR, { recursive: true });
    writeFileSync(`${SANDBOX_DIR}/hello.txt`, 'Hello, IronCurtain!');
    writeFileSync(`${SANDBOX_DIR}/data.json`, JSON.stringify({ key: 'value' }));

    // Write deterministic test policy artifacts to temp directory
    writeTestArtifacts(testGeneratedDir, testCompiledPolicy, testToolAnnotations);

    const config: IronCurtainConfig = {
      auditLogPath: AUDIT_LOG_PATH,
      allowedDirectory: SANDBOX_DIR,
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX_DIR],
        },
      },
      protectedPaths: [
        resolve(projectRoot, 'src/config/constitution.md'),
        resolve(projectRoot, 'src/config/generated'),
        resolve(projectRoot, 'src/config/mcp-servers.json'),
        resolve(AUDIT_LOG_PATH),
      ],
      generatedDir: testGeneratedDir,
      constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: TEST_USER_CONFIG,
    };

    trustedProcess = new TrustedProcess(config, { onEscalation: mockEscalation });
    await trustedProcess.initialize();
  }, 30000);

  afterAll(async () => {
    await trustedProcess.shutdown();
    // Cleanup
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
    rmSync(AUDIT_LOG_PATH, { force: true });
    rmSync(testGeneratedDir, { recursive: true, force: true });
  });

  it('lists tools from the filesystem MCP server', async () => {
    const tools = await trustedProcess.listTools('filesystem');
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('list_directory');
  });

  it('allows reading a file in the sandbox', async () => {
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: `${SANDBOX_DIR}/hello.txt` },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.policyDecision.status).toBe('allow');
    expect(result.policyDecision.rule).toBe('structural-sandbox-allow');
  });

  it('allows listing the sandbox directory', async () => {
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'list_directory',
        arguments: { path: SANDBOX_DIR },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.policyDecision.status).toBe('allow');
  });

  it('allows writing a file in the sandbox', async () => {
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'write_file',
        arguments: { path: `${SANDBOX_DIR}/new-file.txt`, content: 'Created by test' },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.policyDecision.status).toBe('allow');

    // Verify file was actually created
    const content = readFileSync(`${SANDBOX_DIR}/new-file.txt`, 'utf-8');
    expect(content).toBe('Created by test');
  });

  it('denies deleting a file outside the sandbox (unknown tool)', async () => {
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'delete_file',
        arguments: { path: '/etc/important.txt' },
      }),
    );

    expect(result.status).toBe('denied');
    expect(result.policyDecision.status).toBe('deny');
    expect(result.policyDecision.rule).toBe('missing-annotation');
  });

  it('escalates reading files outside the sandbox', async () => {
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: '/etc/hostname' },
      }),
    );

    // Escalation is denied by mock handler, so final status is 'deny'
    expect(result.status).toBe('denied');
    expect(result.policyDecision.status).toBe('deny');
    expect(result.policyDecision.rule).toBe('escalate-read-outside-permitted-areas');
  });

  it('denies access to protected constitution file', async () => {
    // The new engine protects concrete paths, not substring patterns.
    // We test the actual constitution file path, not a sandbox file
    // that happens to contain "constitution.md" in its name.
    const constitutionPath = resolve(projectRoot, 'src/config/constitution.md');
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: constitutionPath },
      }),
    );

    expect(result.status).toBe('denied');
    expect(result.policyDecision.status).toBe('deny');
    expect(result.policyDecision.rule).toBe('structural-protected-path');
  });

  it('escalates writing outside the sandbox -- denied by human', async () => {
    escalationResponse = 'denied';
    lastEscalationRequest = null;

    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'write_file',
        arguments: { path: '/tmp/outside-sandbox.txt', content: 'should not work' },
      }),
    );

    // Write outside permitted areas is escalated for human approval, then denied
    expect(lastEscalationRequest).not.toBeNull();
    expect(result.status).toBe('denied');
    expect(result.policyDecision.rule).toBe('escalate-write-outside-permitted-areas');
    expect(result.policyDecision.reason).toBe('Denied by human during escalation');
  });

  it('escalates reading outside the sandbox -- approved by human', async () => {
    // Create a file in a known-accessible temp directory outside the sandbox
    const outsideDir = `/tmp/ironcurtain-outside-${process.pid}`;
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(`${outsideDir}/readable.txt`, 'escalation-test-content');

    escalationResponse = 'approved';
    lastEscalationRequest = null;

    try {
      const result = await trustedProcess.handleToolCall(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${outsideDir}/readable.txt` },
        }),
      );

      expect(lastEscalationRequest).not.toBeNull();
      expect(lastEscalationRequest!.toolName).toBe('read_file');
      // The policy engine escalated and the human approved
      expect(result.policyDecision.reason).toBe('Approved by human during escalation');
      // Root expansion must succeed: the call was forwarded (not denied)
      expect(result.status).not.toBe('denied');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('reports error status when MCP server returns isError (e.g. file not found)', async () => {
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: `${SANDBOX_DIR}/nonexistent-file.txt` },
      }),
    );

    // Policy allows (file is in sandbox) but the MCP server returns isError
    // because the file doesn't exist. Previously this was reported as 'success'.
    expect(result.policyDecision.status).toBe('allow');
    expect(result.status).toBe('error');
  });

  it('records error in audit log when MCP server returns isError', async () => {
    // Trigger an MCP error: move a nonexistent file within the sandbox
    await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'move_file',
        arguments: {
          source: `${SANDBOX_DIR}/does-not-exist.txt`,
          destination: `${SANDBOX_DIR}/target.txt`,
        },
      }),
    );

    // Wait for audit writes to flush
    await new Promise((resolve) => setTimeout(resolve, 100));

    const logContent = readFileSync(AUDIT_LOG_PATH, 'utf-8').trim();
    const entries = logContent.split('\n').map((line) => JSON.parse(line));

    // Find the move_file entry -- it should be logged as 'error', not 'success'
    const moveEntry = entries.find(
      (e: Record<string, unknown>) =>
        (e as { toolName: string }).toolName === 'move_file' &&
        (e as { arguments: { source: string } }).arguments.source.includes('does-not-exist'),
    );
    expect(moveEntry).toBeDefined();
    expect(moveEntry.result.status).toBe('error');
    expect(moveEntry.result.error).toBeDefined();
  });

  it('writes audit log entries', async () => {
    // Wait a moment for writes to flush
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (existsSync(AUDIT_LOG_PATH)) {
      const logContent = readFileSync(AUDIT_LOG_PATH, 'utf-8').trim();
      const entries = logContent.split('\n').map((line) => JSON.parse(line));
      expect(entries.length).toBeGreaterThan(0);

      // Each entry should have required fields
      for (const entry of entries) {
        expect(entry).toHaveProperty('timestamp');
        expect(entry).toHaveProperty('requestId');
        expect(entry).toHaveProperty('toolName');
        expect(entry).toHaveProperty('policyDecision');
        expect(entry).toHaveProperty('durationMs');
      }
    }
  });
});

describe('Integration: graceful degradation when MCP server fails to connect', () => {
  let trustedProcess: TrustedProcess;

  const sandboxDir = `/tmp/ironcurtain-degrade-${process.pid}`;
  const auditLogPath = `/tmp/ironcurtain-degrade-audit-${process.pid}.jsonl`;
  const generatedDir = `/tmp/ironcurtain-degrade-generated-${process.pid}`;

  beforeAll(async () => {
    mkdirSync(sandboxDir, { recursive: true });
    writeFileSync(`${sandboxDir}/hello.txt`, 'still here');
    writeTestArtifacts(generatedDir, testCompiledPolicy, testToolAnnotations);

    const config: IronCurtainConfig = {
      auditLogPath,
      allowedDirectory: sandboxDir,
      mcpServers: {
        // A server that will fail to connect (bogus command)
        bogus: {
          command: 'nonexistent-binary-that-does-not-exist',
          args: [],
        },
        // Second failing server -- exercises graceful degradation with multiple failures.
        // Uses a bogus command instead of Docker to avoid slow image pulls in CI.
        github: {
          command: 'nonexistent-github-server-binary',
          args: [],
        },
        // The real filesystem server should still work
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', sandboxDir],
        },
      },
      protectedPaths: [],
      generatedDir,
      constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: TEST_USER_CONFIG,
    };

    trustedProcess = new TrustedProcess(config, {
      onEscalation: async () => 'denied',
    });
    // initialize() must not throw even though one server fails
    await trustedProcess.initialize();
  }, 30000);

  afterAll(async () => {
    await trustedProcess.shutdown();
    rmSync(sandboxDir, { recursive: true, force: true });
    rmSync(auditLogPath, { force: true });
    rmSync(generatedDir, { recursive: true, force: true });
  });

  it('lists tools from the surviving filesystem server', async () => {
    const tools = await trustedProcess.listTools('filesystem');
    expect(tools.length).toBeGreaterThan(0);
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('write_file');
  });

  it('can still call tools on the surviving server', async () => {
    const result = await trustedProcess.handleToolCall(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: `${sandboxDir}/hello.txt` },
      }),
    );
    expect(result.status).toBe('success');
    expect(result.policyDecision.status).toBe('allow');
  });

  it('rejects tool calls targeting the failed bogus server', async () => {
    const result = await trustedProcess.handleToolCall({
      requestId: 'test-bogus',
      serverName: 'bogus',
      toolName: 'some_tool',
      arguments: {},
      timestamp: new Date().toISOString(),
    });
    // Failed servers produce 'denied' (missing annotation) or 'error' (server disconnected)
    expect(result.status).not.toBe('success');
  });

  it('rejects tool calls targeting the failed github server', async () => {
    const result = await trustedProcess.handleToolCall({
      requestId: 'test-github',
      serverName: 'github',
      toolName: 'list_issues',
      arguments: { owner: 'octocat', repo: 'hello-world' },
      timestamp: new Date().toISOString(),
    });
    // Docker may be available but token is missing — server connects then exits.
    // Either way, tool calls must not succeed.
    expect(result.status).not.toBe('success');
  });
});
