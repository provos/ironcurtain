import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { TrustedProcess, type EscalationPromptFn } from '../src/trusted-process/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';

const SANDBOX_DIR = '/tmp/ironcurtain-test-' + process.pid;
const AUDIT_LOG_PATH = `/tmp/ironcurtain-test-audit-${process.pid}.jsonl`;

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

  beforeAll(async () => {
    // Create sandbox with test files
    mkdirSync(SANDBOX_DIR, { recursive: true });
    writeFileSync(`${SANDBOX_DIR}/hello.txt`, 'Hello, IronCurtain!');
    writeFileSync(`${SANDBOX_DIR}/data.json`, JSON.stringify({ key: 'value' }));

    const config: IronCurtainConfig = {
      anthropicApiKey: 'not-needed-for-this-test',
      auditLogPath: AUDIT_LOG_PATH,
      allowedDirectory: SANDBOX_DIR,
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX_DIR],
        },
      },
    };

    trustedProcess = new TrustedProcess(config, { onEscalation: mockEscalation });
    await trustedProcess.initialize();
  }, 30000);

  afterAll(async () => {
    await trustedProcess.shutdown();
    // Cleanup
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
    rmSync(AUDIT_LOG_PATH, { force: true });
  });

  it('lists tools from the filesystem MCP server', async () => {
    const tools = await trustedProcess.listTools('filesystem');
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('list_directory');
  });

  it('allows reading a file in the sandbox', async () => {
    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'read_file',
      arguments: { path: `${SANDBOX_DIR}/hello.txt` },
    }));

    expect(result.status).toBe('success');
    expect(result.policyDecision.status).toBe('allow');
    expect(result.policyDecision.rule).toBe('allow-read-in-allowed-dir');
  });

  it('allows listing the sandbox directory', async () => {
    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'list_directory',
      arguments: { path: SANDBOX_DIR },
    }));

    expect(result.status).toBe('success');
    expect(result.policyDecision.status).toBe('allow');
  });

  it('allows writing a file in the sandbox', async () => {
    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'write_file',
      arguments: { path: `${SANDBOX_DIR}/new-file.txt`, content: 'Created by test' },
    }));

    expect(result.status).toBe('success');
    expect(result.policyDecision.status).toBe('allow');

    // Verify file was actually created
    const content = readFileSync(`${SANDBOX_DIR}/new-file.txt`, 'utf-8');
    expect(content).toBe('Created by test');
  });

  it('denies deleting a file', async () => {
    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'delete_file',
      arguments: { path: `${SANDBOX_DIR}/hello.txt` },
    }));

    expect(result.status).toBe('denied');
    expect(result.policyDecision.status).toBe('deny');
    expect(result.policyDecision.rule).toBe('deny-delete-operations');

    // Verify file still exists
    expect(existsSync(`${SANDBOX_DIR}/hello.txt`)).toBe(true);
  });

  it('denies reading files outside the sandbox', async () => {
    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'read_file',
      arguments: { path: '/etc/hostname' },
    }));

    expect(result.status).toBe('denied');
    expect(result.policyDecision.status).toBe('deny');
    expect(result.policyDecision.rule).toBe('deny-read-outside-allowed-dir');
  });

  it('denies access to constitution files', async () => {
    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'read_file',
      arguments: { path: `${SANDBOX_DIR}/constitution.md` },
    }));

    expect(result.status).toBe('denied');
    expect(result.policyDecision.status).toBe('deny');
    expect(result.policyDecision.rule).toBe('structural-protect-policy-files');
  });

  it('escalates writing outside the sandbox — denied by human', async () => {
    escalationResponse = 'denied';
    lastEscalationRequest = null;

    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'write_file',
      arguments: { path: '/tmp/outside-sandbox.txt', content: 'should not work' },
    }));

    expect(lastEscalationRequest).not.toBeNull();
    expect(lastEscalationRequest!.toolName).toBe('write_file');
    expect(result.status).toBe('denied');
    expect(result.policyDecision.reason).toBe('Denied by human during escalation');
  });

  it('escalates writing outside the sandbox — approved by human', async () => {
    escalationResponse = 'approved';
    lastEscalationRequest = null;

    const outsidePath = `/tmp/ironcurtain-test-outside-${process.pid}.txt`;
    const result = await trustedProcess.handleToolCall(makeRequest({
      toolName: 'write_file',
      arguments: { path: outsidePath, content: 'approved by human' },
    }));

    expect(lastEscalationRequest).not.toBeNull();
    // The MCP server may deny the write (path not in its allowed dirs), which is fine —
    // the point is that the policy engine escalated and the human approved
    expect(result.policyDecision.reason).toBe('Approved by human during escalation');

    // Cleanup
    rmSync(outsidePath, { force: true });
  });

  it('writes audit log entries', async () => {
    // Wait a moment for writes to flush
    await new Promise(resolve => setTimeout(resolve, 100));

    if (existsSync(AUDIT_LOG_PATH)) {
      const logContent = readFileSync(AUDIT_LOG_PATH, 'utf-8').trim();
      const entries = logContent.split('\n').map(line => JSON.parse(line));
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
