import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../src/types/mcp.js';

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'test-id',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: '/tmp/ironcurtain-sandbox/test.txt' },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  const engine = new PolicyEngine('/tmp/ironcurtain-sandbox');

  describe('structural invariants', () => {
    it('denies access to constitution files', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/constitution.md' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protect-policy-files');
    });

    it('denies access to policy engine files', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/some/path/policy-engine.ts' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protect-policy-files');
    });

    it('denies write to audit log', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/audit-log.jsonl' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protect-policy-files');
    });
  });

  describe('delete operations', () => {
    it('denies delete_file', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'delete_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/test.txt' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-operations');
    });

    it('denies delete_directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'delete_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox/subdir' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-operations');
    });
  });

  describe('read operations', () => {
    it('allows read_file within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/test.txt' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-read-in-allowed-dir');
    });

    it('allows list_directory within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'list_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-read-in-allowed-dir');
    });

    it('allows search_files within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'search_files',
        arguments: { path: '/tmp/ironcurtain-sandbox', pattern: '*.txt' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-read-in-allowed-dir');
    });

    it('denies read_file outside allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/etc/passwd' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-read-outside-allowed-dir');
    });

    it('denies path traversal attempts', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/../../../etc/passwd' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-read-outside-allowed-dir');
    });
  });

  describe('write operations', () => {
    it('allows write_file within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/output.txt', content: 'hello' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-write-in-allowed-dir');
    });

    it('allows create_directory within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'create_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox/newdir' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-write-in-allowed-dir');
    });

    it('escalates write_file outside allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: '/etc/test.txt', content: 'hello' },
      }));
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-write-outside-allowed-dir');
    });

    it('escalates move_file to outside allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'move_file',
        arguments: { path: '/tmp/outside/file.txt' },
      }));
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-write-outside-allowed-dir');
    });
  });

  describe('default deny', () => {
    it('denies unknown tools', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'execute_command',
        arguments: { command: 'rm -rf /' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('default-deny');
    });
  });
});
