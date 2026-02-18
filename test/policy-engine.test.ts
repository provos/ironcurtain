import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const compiledPolicy: CompiledPolicyFile = JSON.parse(
  readFileSync(resolve(projectRoot, 'src/config/generated/compiled-policy.json'), 'utf-8'),
);
const toolAnnotations: ToolAnnotationsFile = JSON.parse(
  readFileSync(resolve(projectRoot, 'src/config/generated/tool-annotations.json'), 'utf-8'),
);

const protectedPaths = [
  resolve(projectRoot, 'src/config/constitution.md'),
  resolve(projectRoot, 'src/config/generated'),
  resolve(projectRoot, 'src/config/mcp-servers.json'),
  resolve('./audit.jsonl'),
];

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
  const engine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths);

  describe('structural invariants', () => {
    // The new engine protects concrete filesystem paths, not substring
    // patterns. A file named "constitution.md" in the sandbox is no longer
    // denied -- only the actual system constitution file is protected.
    // This is a deliberate security improvement: fewer false positives,
    // precise protection of real system files.

    it('denies access to the real constitution file', () => {
      const constitutionPath = resolve(projectRoot, 'src/config/constitution.md');
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: constitutionPath },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies access to generated policy directory', () => {
      const generatedPath = resolve(projectRoot, 'src/config/generated/compiled-policy.json');
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: generatedPath },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies write to audit log', () => {
      const auditPath = resolve('./audit.jsonl');
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: auditPath },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies access to mcp-servers.json', () => {
      const mcpServersPath = resolve(projectRoot, 'src/config/mcp-servers.json');
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: mcpServersPath },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies unknown tools', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'execute_command',
        arguments: { command: 'rm -rf /' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
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
      expect(result.rule).toBe('allow-read-in-sandbox');
    });

    it('allows list_directory within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'list_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-read-in-sandbox');
    });

    it('allows search_files within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'search_files',
        arguments: { path: '/tmp/ironcurtain-sandbox', pattern: '*.txt' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-read-in-sandbox');
    });

    it('allows list_allowed_directories (side-effect-free tool)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'list_allowed_directories',
        arguments: {},
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-side-effect-free-tools');
    });

    it('denies read_file outside allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/etc/passwd' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-read-elsewhere');
    });

    it('denies path traversal attempts', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/../../../etc/passwd' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-read-elsewhere');
    });
  });

  describe('write operations', () => {
    it('allows write_file within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/output.txt', content: 'hello' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-write-in-sandbox');
    });

    it('allows create_directory within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'create_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox/newdir' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-write-in-sandbox');
    });

    it('escalates write_file outside allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: '/etc/test.txt', content: 'hello' },
      }));
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-write-elsewhere');
    });
  });

  describe('move operations (all denied via delete-path role)', () => {
    it('denies move within sandbox (source has delete-path)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'move_file',
        arguments: {
          source: '/tmp/ironcurtain-sandbox/a.txt',
          destination: '/tmp/ironcurtain-sandbox/b.txt',
        },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-operations');
    });

    it('denies move from sandbox to external', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'move_file',
        arguments: {
          source: '/tmp/ironcurtain-sandbox/a.txt',
          destination: '/tmp/outside/b.txt',
        },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-operations');
    });

    it('denies move from external to sandbox', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'move_file',
        arguments: {
          source: '/etc/important.txt',
          destination: '/tmp/ironcurtain-sandbox/important.txt',
        },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-operations');
    });

    it('denies move from external to external', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'move_file',
        arguments: {
          source: '/etc/a.txt',
          destination: '/tmp/outside/b.txt',
        },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-operations');
    });
  });
});
