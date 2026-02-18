import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import type {
  CompiledPolicyFile,
  ToolAnnotationsFile,
} from '../src/pipeline/types.js';

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
    it('denies delete_file (unknown tool -- not exposed by MCP server)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'delete_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/test.txt' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });

    it('denies delete_directory (unknown tool -- not exposed by MCP server)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'delete_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox/subdir' },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });
  });

  describe('read operations', () => {
    it('allows read_file within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/test.txt' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-sandbox-reads');
    });

    it('allows list_directory within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'list_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-sandbox-reads');
    });

    it('allows search_files within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'search_files',
        arguments: { path: '/tmp/ironcurtain-sandbox', pattern: '*.txt' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-sandbox-reads');
    });

    it('allows list_allowed_directories (side-effect-free tool)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'list_allowed_directories',
        arguments: {},
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-list-allowed-directories');
    });

    it('escalates read_file outside allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/etc/passwd' },
      }));
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-reads-outside-sandbox');
    });

    it('escalates path traversal attempts', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/../../../etc/passwd' },
      }));
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-reads-outside-sandbox');
    });
  });

  describe('write operations', () => {
    it('allows write_file within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: '/tmp/ironcurtain-sandbox/output.txt', content: 'hello' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-sandbox-writes');
    });

    it('allows create_directory within allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'create_directory',
        arguments: { path: '/tmp/ironcurtain-sandbox/newdir' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-sandbox-writes');
    });

    it('escalates write_file outside allowed directory', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'write_file',
        arguments: { path: '/etc/test.txt', content: 'hello' },
      }));
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-writes-outside-sandbox');
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
      expect(result.rule).toBe('deny-all-deletes');
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
      expect(result.rule).toBe('deny-all-deletes');
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
      expect(result.rule).toBe('deny-all-deletes');
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
      expect(result.rule).toBe('deny-all-deletes');
    });
  });

  describe('per-role evaluation (multi-role tools)', () => {
    it('allows edit_file inside sandbox (read-path + write-path both allow)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'edit_file',
        arguments: {
          path: '/tmp/ironcurtain-sandbox/test.txt',
          edits: [{ oldText: 'a', newText: 'b' }],
          dryRun: false,
        },
      }));
      expect(result.decision).toBe('allow');
    });

    it('escalates edit_file outside sandbox (read-path + write-path both escalate)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'edit_file',
        arguments: {
          path: '/etc/test.txt',
          edits: [{ oldText: 'a', newText: 'b' }],
          dryRun: false,
        },
      }));
      expect(result.decision).toBe('escalate');
    });

    it('allows list_allowed_directories with no roles (no role iteration needed)', () => {
      const result = engine.evaluate(makeRequest({
        toolName: 'list_allowed_directories',
        arguments: {},
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-list-allowed-directories');
    });
  });

  describe('per-role evaluation -- asymmetric rules (security test)', () => {
    // This is the key security test: a custom policy where reads are allowed
    // everywhere but writes outside sandbox are denied. edit_file (which has
    // both read-path and write-path) should get the most restrictive result.
    const asymmetricPolicy: CompiledPolicyFile = {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'allow-all-reads',
          description: 'Allow all read operations everywhere',
          principle: 'test',
          if: { roles: ['read-path'] },
          then: 'allow',
          reason: 'Reads are always allowed',
        },
        {
          name: 'deny-writes-outside-sandbox',
          description: 'Deny writes outside sandbox',
          principle: 'test',
          if: { roles: ['write-path'] },
          then: 'deny',
          reason: 'Writes outside sandbox are denied',
        },
      ],
    };

    // Minimal annotations: just edit_file with read-path + write-path
    const minimalAnnotations: ToolAnnotationsFile = {
      generatedAt: 'test',
      servers: {
        filesystem: {
          inputHash: 'test',
          tools: [
            {
              toolName: 'edit_file',
              serverName: 'filesystem',
              comment: 'test',
              sideEffects: true,
              args: {
                path: ['read-path', 'write-path'],
                edits: ['none'],
              },
            },
            {
              toolName: 'read_file',
              serverName: 'filesystem',
              comment: 'test',
              sideEffects: true,
              args: {
                path: ['read-path'],
              },
            },
          ],
        },
      },
    };

    const asymmetricEngine = new PolicyEngine(asymmetricPolicy, minimalAnnotations, []);

    it('denies edit_file when write-path is denied (most restrictive wins)', () => {
      const result = asymmetricEngine.evaluate(makeRequest({
        toolName: 'edit_file',
        arguments: { path: '/etc/test.txt', edits: [] },
      }));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-writes-outside-sandbox');
    });

    it('allows read_file with only read-path role (single role, no restriction)', () => {
      const result = asymmetricEngine.evaluate(makeRequest({
        toolName: 'read_file',
        arguments: { path: '/etc/test.txt' },
      }));
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-all-reads');
    });
  });
});
