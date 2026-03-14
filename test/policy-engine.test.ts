import { homedir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { CompiledPolicyFile, ToolAnnotationsFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { PolicyEngine, domainMatchesAllowlist, isIpAddress } from '../src/trusted-process/policy-engine.js';
import { extractServerDomainAllowlists } from '../src/config/index.js';
import type { MCPServerConfig } from '../src/config/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_SANDBOX_DIR,
  TEST_PROTECTED_PATHS,
  REAL_TMP,
} from './fixtures/test-policy.js';

const protectedPaths = TEST_PROTECTED_PATHS;
const SANDBOX_DIR = TEST_SANDBOX_DIR;

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'test-id',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: `${SANDBOX_DIR}/test.txt` },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, protectedPaths, SANDBOX_DIR);

  describe('structural invariants', () => {
    // The new engine protects concrete filesystem paths, not substring
    // patterns. A file named "constitution.md" in the sandbox is no longer
    // denied -- only the actual system constitution file is protected.
    // This is a deliberate security improvement: fewer false positives,
    // precise protection of real system files.

    it('denies access to the real constitution file', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: protectedPaths[0] },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies access to generated policy directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: protectedPaths[1] + '/compiled-policy.json' },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies write to audit log', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'write_file',
          arguments: { path: protectedPaths[3] },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies access to mcp-servers.json', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: protectedPaths[2] },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies access to .env file', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: protectedPaths[4] },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies access to user config file', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: protectedPaths[5] },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies unknown tools', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'execute_command',
          arguments: { command: 'rm -rf /' },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });
  });

  describe('tilde path recognition', () => {
    it('with pre-normalized tilde path, denies access to protected home directory', () => {
      const homeDir = homedir();
      const engineWithHome = new PolicyEngine(testCompiledPolicy, testToolAnnotations, [homeDir], SANDBOX_DIR);
      // Simulate what happens AFTER prepareToolArgs has expanded the tilde
      const result = engineWithHome.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${homeDir}/.ssh/id_rsa` },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });
  });

  describe('tilde paths in compiled rules', () => {
    it('matches tool call targeting ~/somedir when rule uses paths.within: "~/somedir"', () => {
      const home = homedir();
      const tildePolicy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-reads-in-tilde-dir',
            description: 'Allow reads within ~/somedir',
            principle: 'test',
            if: { paths: { roles: ['read-path'], within: '~/somedir' }, server: ['filesystem'] },
            then: 'allow',
            reason: 'Reads in ~/somedir are allowed',
          },
          {
            name: 'deny-all',
            description: 'Deny everything else',
            principle: 'test',
            if: {},
            then: 'deny',
            reason: 'Default deny',
          },
        ],
      };
      const tildeEngine = new PolicyEngine(tildePolicy, testToolAnnotations, []);
      const result = tildeEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${home}/somedir/file.txt` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-reads-in-tilde-dir');
    });
  });

  describe('delete operations', () => {
    it('denies delete_file in sandbox when tool is unannotated (unknown tool)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'delete_file',
          arguments: { path: `${SANDBOX_DIR}/test.txt` },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });

    it('denies delete_directory in sandbox when tool is unannotated (unknown tool)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'delete_directory',
          arguments: { path: `${SANDBOX_DIR}/subdir` },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });

    it('denies delete_file outside sandbox (unknown tool)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'delete_file',
          arguments: { path: '/etc/important.txt' },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });
  });

  describe('read operations', () => {
    it('allows read_file within allowed directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${SANDBOX_DIR}/test.txt` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows list_directory within allowed directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'list_directory',
          arguments: { path: SANDBOX_DIR },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows search_files within allowed directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'search_files',
          arguments: { path: SANDBOX_DIR, pattern: '*.txt' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows list_allowed_directories (structural introspection)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'list_allowed_directories',
          arguments: {},
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-introspection-allow');
    });

    it('escalates read_file outside allowed directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: '/etc/passwd' },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-read-outside-permitted-areas');
    });

    it('escalates path traversal attempts', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${SANDBOX_DIR}/../../../etc/passwd` },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-read-outside-permitted-areas');
    });
  });

  describe('write operations', () => {
    it('allows write_file within allowed directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'write_file',
          arguments: { path: `${SANDBOX_DIR}/output.txt`, content: 'hello' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows create_directory within allowed directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'create_directory',
          arguments: { path: `${SANDBOX_DIR}/newdir` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('escalates write_file outside allowed directory', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'write_file',
          arguments: { path: '/etc/test.txt', content: 'hello' },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-write-outside-permitted-areas');
    });
  });

  describe('move operations', () => {
    it('allows move within sandbox (structural sandbox invariant fires first)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'move_file',
          arguments: {
            source: `${SANDBOX_DIR}/a.txt`,
            destination: `${SANDBOX_DIR}/b.txt`,
          },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('escalates move from sandbox to external (source roles sandbox-resolved)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'move_file',
          arguments: {
            source: `${SANDBOX_DIR}/a.txt`,
            destination: `${REAL_TMP}/outside/b.txt`,
          },
        }),
      );
      // read-path and delete-path on source are sandbox-resolved.
      // Only write-path on destination is evaluated via compiled rules → escalate.
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-write-outside-permitted-areas');
    });

    it('denies move from external to sandbox (delete-path on source denied)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'move_file',
          arguments: {
            source: '/etc/important.txt',
            destination: `${SANDBOX_DIR}/important.txt`,
          },
        }),
      );
      // write-path (destination in sandbox) is sandbox-resolved and skipped.
      // read-path and delete-path (source outside sandbox) go to compiled rules.
      // delete-path hits deny-delete-outside-permitted-areas.
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-outside-permitted-areas');
    });

    it('denies move from external to external', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'move_file',
          arguments: {
            source: '/etc/a.txt',
            destination: `${REAL_TMP}/outside/b.txt`,
          },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-delete-outside-permitted-areas');
    });
  });

  describe('per-role evaluation (multi-role tools)', () => {
    it('allows edit_file inside sandbox (structural sandbox invariant)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'edit_file',
          arguments: {
            path: `${SANDBOX_DIR}/test.txt`,
            edits: [{ oldText: 'a', newText: 'b' }],
            dryRun: false,
          },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('escalates edit_file outside sandbox (both read-path and write-path escalated)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'edit_file',
          arguments: {
            path: '/etc/test.txt',
            edits: [{ oldText: 'a', newText: 'b' }],
            dryRun: false,
          },
        }),
      );
      expect(result.decision).toBe('escalate');
    });

    it('allows list_allowed_directories with no roles (structural introspection)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'list_allowed_directories',
          arguments: {},
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-introspection-allow');
    });
  });

  describe('structural sandbox invariant', () => {
    it('does not fire for tools with no path arguments', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'list_allowed_directories',
          arguments: {},
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-introspection-allow');
      expect(result.rule).not.toBe('structural-sandbox-allow');
    });

    it('protected path outside sandbox is denied', () => {
      const protectedPath = '/etc/shadow';
      const engineWithProtected = new PolicyEngine(
        testCompiledPolicy,
        testToolAnnotations,
        [protectedPath],
        SANDBOX_DIR,
      );
      const result = engineWithProtected.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: protectedPath },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('works with dynamic sandbox path', () => {
      const dynamicSandbox = '/home/user/.ironcurtain/sessions/abc123/sandbox';
      const dynamicEngine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, [], dynamicSandbox);
      const result = dynamicEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: '/home/user/.ironcurtain/sessions/abc123/sandbox/test.txt' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('blocks path traversal out of dynamic sandbox', () => {
      const dynamicSandbox = '/home/user/.ironcurtain/sessions/abc123/sandbox';
      const dynamicEngine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, [], dynamicSandbox);
      const result = dynamicEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: '/home/user/.ironcurtain/sessions/abc123/sandbox/../../etc/passwd' },
        }),
      );
      expect(result.decision).not.toBe('allow');
      expect(result.rule).not.toBe('structural-sandbox-allow');
    });

    it('engine without allowedDirectory skips sandbox check', () => {
      const noSandboxEngine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, []);
      const result = noSandboxEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${SANDBOX_DIR}/test.txt` },
        }),
      );
      expect(result.rule).not.toBe('structural-sandbox-allow');
    });
  });

  describe('partial sandbox resolution (mixed-path tool calls)', () => {
    it('allows move from permitted area to sandbox when source roles are allowed', () => {
      // Custom policy allowing reads and deletes in /home/user/Downloads.
      // move_file from Downloads to sandbox:
      //   write-path (destination in sandbox) -> sandbox-resolved, skipped
      //   read-path (source in Downloads) -> allow-read-downloads
      //   delete-path (source in Downloads) -> allow-delete-downloads
      const permissivePolicy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-read-downloads',
            description: 'Allow reads in Downloads',
            principle: 'test',
            if: { paths: { roles: ['read-path'], within: '/home/user/Downloads' } },
            then: 'allow',
            reason: 'Reads in Downloads are allowed',
          },
          {
            name: 'allow-delete-downloads',
            description: 'Allow deletes in Downloads',
            principle: 'test',
            if: { paths: { roles: ['delete-path'], within: '/home/user/Downloads' } },
            then: 'allow',
            reason: 'Deletes in Downloads are allowed',
          },
          {
            name: 'deny-all-else',
            description: 'Deny everything else',
            principle: 'test',
            if: {},
            then: 'deny',
            reason: 'Default deny',
          },
        ],
      };

      const moveEngine = new PolicyEngine(permissivePolicy, testToolAnnotations, [], SANDBOX_DIR);

      const result = moveEngine.evaluate(
        makeRequest({
          toolName: 'move_file',
          arguments: {
            source: '/home/user/Downloads/file.zip',
            destination: `${SANDBOX_DIR}/file.zip`,
          },
        }),
      );
      expect(result.decision).toBe('allow');
    });

    it('allows move between two permitted directories with complementary role coverage', () => {
      // Rule 1: read-path, write-path, delete-path allowed for Downloads
      // Rule 2: read-path, write-path allowed for Documents
      // move_file from Downloads to Documents:
      //   read-path (source in Downloads) -> allow-downloads
      //   delete-path (source in Downloads) -> allow-downloads
      //   write-path (destination in Documents) -> allow-documents
      const crossDirPolicy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-downloads',
            description: 'Allow read/write/delete in Downloads',
            principle: 'test',
            if: { paths: { roles: ['read-path', 'write-path', 'delete-path'], within: '/home/user/Downloads' } },
            then: 'allow',
            reason: 'Full access to Downloads',
          },
          {
            name: 'allow-documents',
            description: 'Allow read/write in Documents',
            principle: 'test',
            if: { paths: { roles: ['read-path', 'write-path'], within: '/home/user/Documents' } },
            then: 'allow',
            reason: 'Read/write access to Documents',
          },
        ],
      };

      const crossDirEngine = new PolicyEngine(crossDirPolicy, testToolAnnotations, [], SANDBOX_DIR);

      const result = crossDirEngine.evaluate(
        makeRequest({
          toolName: 'move_file',
          arguments: {
            source: '/home/user/Downloads/report.pdf',
            destination: '/home/user/Documents/report.pdf',
          },
        }),
      );
      expect(result.decision).toBe('allow');
    });

    it('does not sandbox-resolve roles when array has paths both inside and outside', () => {
      // read-path extracts both paths; /etc/b.txt is outside sandbox,
      // so the role is NOT sandbox-resolved and falls to compiled rules.
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_multiple_files',
          arguments: {
            paths: [`${SANDBOX_DIR}/a.txt`, '/etc/b.txt'],
          },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-read-outside-permitted-areas');
    });
  });

  describe('per-element path evaluation', () => {
    it('allows read_multiple_files with paths spanning two permitted directories', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_multiple_files',
          arguments: {
            paths: [`${REAL_TMP}/permitted-a/file1.txt`, `${REAL_TMP}/permitted-b/file2.txt`],
          },
        }),
      );
      expect(result.decision).toBe('allow');
    });

    it('escalates when paths span permitted and non-permitted directories', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_multiple_files',
          arguments: {
            paths: [`${REAL_TMP}/permitted-a/file1.txt`, '/etc/some-file.txt'],
          },
        }),
      );
      // /tmp/permitted-a/file1.txt is allowed, /etc/some-file.txt hits escalate rule
      // Most restrictive wins: escalate > allow
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-read-outside-permitted-areas');
    });

    it('allows all paths in one permitted directory (regression)', () => {
      const result = engine.evaluate(
        makeRequest({
          toolName: 'read_multiple_files',
          arguments: {
            paths: [`${REAL_TMP}/permitted-a/file1.txt`, `${REAL_TMP}/permitted-a/file2.txt`],
          },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-reads-within-dir-a');
    });

    it('denies when one path has no matching rule (default-deny)', () => {
      // Custom policy with only one permitted dir and no catch-all
      const restrictivePolicy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-reads-dir-a',
            description: 'Allow reads within dir-a',
            principle: 'test',
            if: { paths: { roles: ['read-path'], within: `${REAL_TMP}/permitted-a` }, server: ['filesystem'] },
            then: 'allow',
            reason: 'Allowed in dir-a',
          },
        ],
      };
      const restrictiveEngine = new PolicyEngine(restrictivePolicy, testToolAnnotations, []);
      const result = restrictiveEngine.evaluate(
        makeRequest({
          toolName: 'read_multiple_files',
          arguments: {
            paths: [`${REAL_TMP}/permitted-a/file1.txt`, `${REAL_TMP}/nowhere/file2.txt`],
          },
        }),
      );
      // /tmp/permitted-a/file1.txt -> allow, /tmp/nowhere/file2.txt -> default-deny
      // Most restrictive wins: deny > allow
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('default-deny');
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
      const result = asymmetricEngine.evaluate(
        makeRequest({
          toolName: 'edit_file',
          arguments: { path: '/etc/test.txt', edits: [] },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-writes-outside-sandbox');
    });

    it('allows read_file with only read-path role (single role, no restriction)', () => {
      const result = asymmetricEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: '/etc/test.txt' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-all-reads');
    });
  });

  describe('domainMatchesAllowlist', () => {
    it('matches exact domain', () => {
      expect(domainMatchesAllowlist('github.com', ['github.com'])).toBe(true);
    });

    it('does not match different domain', () => {
      expect(domainMatchesAllowlist('evil.com', ['github.com'])).toBe(false);
    });

    it('matches wildcard *', () => {
      expect(domainMatchesAllowlist('anything.com', ['*'])).toBe(true);
    });

    it('matches *.prefix wildcard for subdomains', () => {
      expect(domainMatchesAllowlist('api.github.com', ['*.github.com'])).toBe(true);
    });

    it('matches *.prefix wildcard for base domain', () => {
      expect(domainMatchesAllowlist('github.com', ['*.github.com'])).toBe(true);
    });

    it('does not match *.prefix for unrelated domain', () => {
      expect(domainMatchesAllowlist('evil.com', ['*.github.com'])).toBe(false);
    });

    it('returns false for empty allowlist', () => {
      expect(domainMatchesAllowlist('github.com', [])).toBe(false);
    });

    it('wildcard * does not match IPv4 address (SSRF protection)', () => {
      expect(domainMatchesAllowlist('127.0.0.1', ['*'])).toBe(false);
      expect(domainMatchesAllowlist('10.0.0.1', ['*'])).toBe(false);
      expect(domainMatchesAllowlist('169.254.169.254', ['*'])).toBe(false);
    });

    it('wildcard * does not match IPv6 address (SSRF protection)', () => {
      expect(domainMatchesAllowlist('::1', ['*'])).toBe(false);
      expect(domainMatchesAllowlist('[::1]', ['*'])).toBe(false);
    });

    it('explicit IP in allowlist matches (SSRF opt-in)', () => {
      expect(domainMatchesAllowlist('192.168.1.100', ['*', '192.168.1.100'])).toBe(true);
    });

    it('explicit IP without wildcard matches', () => {
      expect(domainMatchesAllowlist('192.168.1.100', ['192.168.1.100'])).toBe(true);
    });

    it('non-matching explicit IP does not match', () => {
      expect(domainMatchesAllowlist('10.0.0.1', ['192.168.1.100'])).toBe(false);
    });

    // Hierarchical matching for git-remote-url domains (hostname/owner/repo)
    it('hostname-only pattern matches domain with repo path', () => {
      expect(domainMatchesAllowlist('github.com/provos/ironcurtain', ['github.com'])).toBe(true);
    });

    it('exact repo pattern matches same repo', () => {
      expect(domainMatchesAllowlist('github.com/provos/ironcurtain', ['github.com/provos/ironcurtain'])).toBe(true);
    });

    it('exact repo pattern does not match different repo', () => {
      expect(domainMatchesAllowlist('github.com/provos/ironcurtain', ['github.com/other/repo'])).toBe(false);
    });

    it('wildcard * matches domain with repo path', () => {
      expect(domainMatchesAllowlist('github.com/provos/ironcurtain', ['*'])).toBe(true);
    });

    it('wildcard * does not match IP with repo path', () => {
      expect(domainMatchesAllowlist('192.168.1.1/provos/repo', ['*'])).toBe(false);
    });

    it('prefix wildcard matches domain with repo path (hostname portion)', () => {
      expect(domainMatchesAllowlist('api.github.com/provos/repo', ['*.github.com'])).toBe(true);
    });

    it('hostname-only pattern does not match different host with repo path', () => {
      expect(domainMatchesAllowlist('gitlab.com/provos/ironcurtain', ['github.com'])).toBe(false);
    });
  });

  describe('isIpAddress', () => {
    it('detects IPv4 addresses', () => {
      expect(isIpAddress('127.0.0.1')).toBe(true);
      expect(isIpAddress('10.0.0.1')).toBe(true);
      expect(isIpAddress('169.254.169.254')).toBe(true);
      expect(isIpAddress('192.168.1.100')).toBe(true);
    });

    it('detects IPv6 addresses', () => {
      expect(isIpAddress('::1')).toBe(true);
      expect(isIpAddress('[::1]')).toBe(true);
      expect(isIpAddress('fe80::1')).toBe(true);
    });

    it('does not match domain names', () => {
      expect(isIpAddress('github.com')).toBe(false);
      expect(isIpAddress('api.example.com')).toBe(false);
      expect(isIpAddress('localhost')).toBe(false);
    });
  });

  describe('extractServerDomainAllowlists', () => {
    it('preserves * wildcard in allowlist', () => {
      const servers: Record<string, MCPServerConfig> = {
        fetch: {
          command: 'node',
          args: ['server.js'],
          sandbox: { network: { allowedDomains: ['*'] } },
        },
      };
      const result = extractServerDomainAllowlists(servers);
      expect(result.get('fetch')).toEqual(['*']);
    });

    it('preserves * alongside explicit domains', () => {
      const servers: Record<string, MCPServerConfig> = {
        fetch: {
          command: 'node',
          args: ['server.js'],
          sandbox: { network: { allowedDomains: ['*', '192.168.1.100'] } },
        },
      };
      const result = extractServerDomainAllowlists(servers);
      expect(result.get('fetch')).toEqual(['*', '192.168.1.100']);
    });

    it('skips servers without sandbox config', () => {
      const servers: Record<string, MCPServerConfig> = {
        filesystem: { command: 'node', args: ['server.js'] },
      };
      const result = extractServerDomainAllowlists(servers);
      expect(result.has('filesystem')).toBe(false);
    });

    it('skips servers with empty allowedDomains', () => {
      const servers: Record<string, MCPServerConfig> = {
        fetch: {
          command: 'node',
          args: ['server.js'],
          sandbox: { network: { allowedDomains: [] } },
        },
      };
      const result = extractServerDomainAllowlists(servers);
      expect(result.has('fetch')).toBe(false);
    });
  });

  describe('Untrusted domain gate', () => {
    // Annotations that include a git server with URL-category arguments
    const gitAnnotations: ToolAnnotationsFile = {
      generatedAt: 'test',
      servers: {
        git: {
          inputHash: 'test',
          tools: [
            {
              toolName: 'git_push',
              serverName: 'git',
              comment: 'Push to remote',
              sideEffects: true,
              args: {
                path: ['read-path'],
                remote: ['git-remote-url'],
                branch: ['branch-name'],
              },
            },
            {
              toolName: 'git_clone',
              serverName: 'git',
              comment: 'Clone a repository',
              sideEffects: true,
              args: {
                url: ['git-remote-url'],
                path: ['write-path'],
              },
            },
            {
              toolName: 'git_status',
              serverName: 'git',
              comment: 'Show git status',
              sideEffects: false,
              args: {
                path: ['read-path'],
              },
            },
          ],
        },
      },
    };

    const gitPolicy: CompiledPolicyFile = {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'escalate-git-push',
          description: 'Escalate push operations',
          principle: 'Human oversight',
          if: { server: ['git'], tool: ['git_push'] },
          then: 'escalate',
          reason: 'Push requires human approval',
        },
        {
          name: 'allow-git-read',
          description: 'Allow read-only git operations',
          principle: 'Least privilege',
          if: { server: ['git'], sideEffects: false },
          then: 'allow',
          reason: 'Read-only git operations are safe',
        },
        {
          name: 'escalate-git-clone',
          description: 'Escalate clone operations',
          principle: 'Human oversight',
          if: { server: ['git'], tool: ['git_clone'] },
          then: 'escalate',
          reason: 'Clone requires human approval',
        },
      ],
    };

    it('escalates when URL domain is not in allowlist', () => {
      const allowlists = new Map([['git', ['github.com', '*.github.com']]]);
      const gitEngine = new PolicyEngine(gitPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

      const result = gitEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://evil.com/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('structural-domain-escalate');
    });

    it('escalates when domain matches allowlist (compiled rules still evaluate)', () => {
      const allowlists = new Map([['git', ['github.com', '*.github.com']]]);
      const gitEngine = new PolicyEngine(gitPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

      const result = gitEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      // Domain passes structural check. write-path is sandbox-resolved (path in SANDBOX_DIR).
      // git-remote-url goes to compiled rule evaluation → escalate-git-clone.
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-git-clone');
    });

    it('falls through to compiled rule evaluation when domain passes but path is outside sandbox', () => {
      const allowlists = new Map([['git', ['github.com', '*.github.com']]]);
      const gitEngine = new PolicyEngine(gitPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

      const result = gitEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/user/repo.git', path: '/some/external/repo' },
        }),
      );
      // Domain passes, but path is NOT in sandbox → falls to compiled rule evaluation
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-git-clone');
    });

    it('passes when domain matches wildcard prefix', () => {
      const allowlists = new Map([['git', ['*.github.com']]]);
      const gitEngine = new PolicyEngine(gitPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

      const result = gitEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://api.github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      expect(result.rule).not.toBe('structural-domain-escalate');
    });

    it('skips untrusted domain gate when server has no domain allowlist', () => {
      // No allowlist for 'git' server
      const gitEngine = new PolicyEngine(gitPolicy, gitAnnotations, [], SANDBOX_DIR);

      const result = gitEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://evil.com/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      // No structural domain check, falls through to compiled rule evaluation
      expect(result.rule).not.toBe('structural-domain-escalate');
    });

    it('sandbox-resolves write-path for git_clone when URL roles are present (Issue 3)', () => {
      // git_clone has both write-path and git-remote-url. When path is inside
      // the sandbox, write-path is structurally resolved. Only git-remote-url
      // then runs through compiled rules — so a URL-allow rule can permit the clone
      // without the path role forcing re-evaluation.
      const allowClonePolicy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-git-clone-github',
            description: 'Allow cloning from GitHub',
            principle: 'Least privilege',
            if: {
              server: ['git'],
              tool: ['git_clone'],
              domains: { roles: ['git-remote-url'], allowed: ['github.com'] },
            },
            then: 'allow',
            reason: 'GitHub is trusted for cloning',
          },
        ],
      };
      const cloneEngine = new PolicyEngine(allowClonePolicy, gitAnnotations, [], SANDBOX_DIR);

      const result = cloneEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      // write-path is sandbox-resolved (path in sandbox); git-remote-url → allow-git-clone-github
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-git-clone-github');
    });

    it('handles SSH git URLs in domain check', () => {
      const allowlists = new Map([['git', ['github.com', '*.github.com']]]);
      const gitEngine = new PolicyEngine(gitPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

      const result = gitEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'git@github.com:user/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      // SSH URL → domain github.com → passes allowlist
      expect(result.rule).not.toBe('structural-domain-escalate');
    });

    it('does not affect tools with only path roles (no URL args)', () => {
      const allowlists = new Map([['git', ['github.com']]]);
      const gitEngine = new PolicyEngine(gitPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

      const result = gitEngine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_status',
          arguments: { path: `${SANDBOX_DIR}/repo` },
        }),
      );
      // git_status has only read-path args, no URL args → untrusted domain gate skipped.
      // All paths within sandbox → structural-sandbox-allow.
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });
  });

  describe('Repo-level domain matching in compiled rules', () => {
    const gitAnnotations: ToolAnnotationsFile = {
      generatedAt: 'test',
      servers: {
        git: {
          inputHash: 'test',
          tools: [
            {
              toolName: 'git_clone',
              serverName: 'git',
              comment: 'Clone a repository',
              sideEffects: true,
              args: { url: ['git-remote-url'], path: ['write-path'] },
            },
          ],
        },
      },
    };

    const repoPolicy: CompiledPolicyFile = {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'allow-clone-specific-repo',
          description: 'Allow cloning specific repo',
          principle: 'test',
          if: {
            server: ['git'],
            tool: ['git_clone'],
            domains: { roles: ['git-remote-url'], allowed: ['github.com/provos/ironcurtain'] },
          },
          then: 'allow',
          reason: 'Specific repo is trusted',
        },
      ],
    };

    it('allows clone when repo-level domain pattern matches', () => {
      const engine = new PolicyEngine(repoPolicy, gitAnnotations, [], SANDBOX_DIR);

      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/provos/ironcurtain.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-clone-specific-repo');
    });

    it('denies clone when repo-level domain pattern does not match', () => {
      const engine = new PolicyEngine(repoPolicy, gitAnnotations, [], SANDBOX_DIR);

      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/other/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      // Different repo doesn't match → default-deny
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('default-deny');
    });

    it('hostname-only pattern allows any repo on that host', () => {
      const hostPolicy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-clone-github',
            description: 'Allow cloning from GitHub',
            principle: 'test',
            if: {
              server: ['git'],
              tool: ['git_clone'],
              domains: { roles: ['git-remote-url'], allowed: ['github.com'] },
            },
            then: 'allow',
            reason: 'GitHub is trusted',
          },
        ],
      };
      const engine = new PolicyEngine(hostPolicy, gitAnnotations, [], SANDBOX_DIR);

      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/any/repo.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-clone-github');
    });

    it('SSH URL matches repo-level domain pattern', () => {
      const engine = new PolicyEngine(repoPolicy, gitAnnotations, [], SANDBOX_DIR);

      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'git@github.com:provos/ironcurtain.git', path: `${SANDBOX_DIR}/repo` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-clone-specific-repo');
    });
  });

  describe('Git remote enrichment (absent remote resolved from filesystem)', () => {
    // Annotations for git_push: path is repo locator ('none'), remote is 'git-remote-url'
    const pushAnnotations: ToolAnnotationsFile = {
      generatedAt: 'test',
      servers: {
        git: {
          inputHash: 'test',
          tools: [
            {
              toolName: 'git_push',
              serverName: 'git',
              comment: 'Push to remote',
              sideEffects: true,
              args: { path: ['none'], remote: ['git-remote-url'], branch: ['branch-name'] },
            },
          ],
        },
      },
    };

    const escalatePushPolicy: CompiledPolicyFile = {
      generatedAt: 'test',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'escalate-git-push',
          description: 'Escalate all git pushes',
          principle: 'Human oversight',
          if: { server: ['git'], tool: ['git_push'] },
          then: 'escalate',
          reason: 'Push requires human approval',
        },
      ],
    };

    // ── Static tests (no real git repo) ──────────────────────────────────

    it('does not enrich when remote arg is already present as HTTPS URL', () => {
      const allowlists = new Map([['git', ['github.com']]]);
      const engine = new PolicyEngine(escalatePushPolicy, pushAnnotations, [], SANDBOX_DIR, allowlists);

      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_push',
          arguments: { path: '/nonexistent/repo', remote: 'https://github.com/org/repo.git', branch: 'main' },
        }),
      );
      // URL already present → no enrichment; domain gate passes; compiled rule escalates
      expect(result.rule).not.toBe('structural-domain-escalate');
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-git-push');
    });

    it('does not enrich when remote arg is already present as SSH URL', () => {
      const allowlists = new Map([['git', ['github.com']]]);
      const engine = new PolicyEngine(escalatePushPolicy, pushAnnotations, [], SANDBOX_DIR, allowlists);

      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_push',
          arguments: { path: '/nonexistent/repo', remote: 'git@github.com:org/repo.git', branch: 'main' },
        }),
      );
      expect(result.rule).not.toBe('structural-domain-escalate');
      expect(result.decision).toBe('escalate');
    });

    it('falls back cleanly when path is not a git repo (no enrichment, compiled rule fires)', () => {
      // When enrichment fails, request is unchanged → no URL arg → no domain gate → compiled rule
      const engine = new PolicyEngine(escalatePushPolicy, pushAnnotations, [], SANDBOX_DIR);
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_push',
          arguments: { path: REAL_TMP, branch: 'main' }, // remote absent; REAL_TMP is not a git repo
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-git-push');
    });

    it('does not enrich for non-git server even if annotation has git-remote-url role', () => {
      const otherAnnotations: ToolAnnotationsFile = {
        generatedAt: 'test',
        servers: {
          custom: {
            inputHash: 'test',
            tools: [
              {
                toolName: 'push_op',
                serverName: 'custom',
                comment: 'custom push',
                sideEffects: true,
                args: { url: ['git-remote-url'] },
              },
            ],
          },
        },
      };
      const allowPolicy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-custom',
            description: 'Allow custom ops',
            principle: 'test',
            if: { server: ['custom'] },
            then: 'allow',
            reason: 'test',
          },
        ],
      };
      const engine = new PolicyEngine(allowPolicy, otherAnnotations, [], SANDBOX_DIR);
      const result = engine.evaluate(
        makeRequest({ serverName: 'custom', toolName: 'push_op', arguments: { path: '/some/dir' } }),
      );
      // No enrichment for non-git server; url absent → compiled rule allow-custom fires
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-custom');
    });

    // ── Dynamic tests (require real git repos) ────────────────────────────

    describe('with repo whose origin is github.com', () => {
      let repoDir: string;

      beforeAll(() => {
        mkdirSync(SANDBOX_DIR, { recursive: true });
        repoDir = realpathSync(mkdtempSync(`${SANDBOX_DIR}/ic-enrich-github-`));
        const opts = {
          cwd: repoDir,
          encoding: 'utf-8' as const,
          stdio: ['pipe', 'pipe', 'pipe'] as const,
          timeout: 10_000,
        };
        execFileSync('git', ['init'], opts);
        execFileSync('git', ['config', 'user.email', 'test@test.local'], opts);
        execFileSync('git', ['config', 'user.name', 'Test'], opts);
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/org/repo.git'], opts);
      });

      afterAll(() => {
        rmSync(repoDir, { recursive: true, force: true });
      });

      it('enriches absent remote with github.com URL; domain gate passes allowlist', () => {
        const allowlists = new Map([['git', ['github.com']]]);
        const engine = new PolicyEngine(escalatePushPolicy, pushAnnotations, [], SANDBOX_DIR, allowlists);

        const result = engine.evaluate(
          makeRequest({
            serverName: 'git',
            toolName: 'git_push',
            arguments: { path: repoDir, branch: 'main' }, // remote absent
          }),
        );
        // Enrichment resolves 'origin' → 'https://github.com/org/repo.git'
        // Domain gate: github.com ∈ allowlist → passes
        // Compiled rule: escalate-git-push fires
        expect(result.rule).not.toBe('structural-domain-escalate');
        expect(result.decision).toBe('escalate');
        expect(result.rule).toBe('escalate-git-push');
      });

      it('enriches absent remote; domain-constrained allow rule fires for matching domain', () => {
        const allowGithubPolicy: CompiledPolicyFile = {
          generatedAt: 'test',
          constitutionHash: 'test',
          inputHash: 'test',
          rules: [
            {
              name: 'allow-github-push',
              description: 'Allow push to github',
              principle: 'test',
              if: {
                server: ['git'],
                tool: ['git_push'],
                domains: { roles: ['git-remote-url'], allowed: ['github.com'] },
              },
              then: 'allow',
              reason: 'GitHub push is permitted',
            },
          ],
        };
        const engine = new PolicyEngine(allowGithubPolicy, pushAnnotations, [], SANDBOX_DIR);

        const result = engine.evaluate(
          makeRequest({
            serverName: 'git',
            toolName: 'git_push',
            arguments: { path: repoDir, branch: 'main' }, // remote absent
          }),
        );
        // Enrichment injects github.com URL; domains condition matches → allow
        expect(result.decision).toBe('allow');
        expect(result.rule).toBe('allow-github-push');
      });

      it('enriches absent remote; structural domain gate blocks untrusted domain', () => {
        // The repo's origin is github.com, but the allowlist is empty → gate escalates
        const allowlists = new Map([['git', [] as string[]]]);
        const engine = new PolicyEngine(escalatePushPolicy, pushAnnotations, [], SANDBOX_DIR, allowlists);

        const result = engine.evaluate(
          makeRequest({
            serverName: 'git',
            toolName: 'git_push',
            arguments: { path: repoDir, branch: 'main' },
          }),
        );
        // Enrichment runs after structural checks, so the enriched URL is
        // evaluated by compiled rules (not the structural domain gate).
        expect(result.decision).toBe('escalate');
      });
    });

    describe('with repo whose origin is an untrusted domain', () => {
      let repoDir: string;

      beforeAll(() => {
        mkdirSync(SANDBOX_DIR, { recursive: true });
        repoDir = realpathSync(mkdtempSync(`${SANDBOX_DIR}/ic-enrich-evil-`));
        const opts = {
          cwd: repoDir,
          encoding: 'utf-8' as const,
          stdio: ['pipe', 'pipe', 'pipe'] as const,
          timeout: 10_000,
        };
        execFileSync('git', ['init'], opts);
        execFileSync('git', ['config', 'user.email', 'test@test.local'], opts);
        execFileSync('git', ['config', 'user.name', 'Test'], opts);
        execFileSync('git', ['remote', 'add', 'origin', 'https://evil.com/stolen/repo.git'], opts);
      });

      afterAll(() => {
        rmSync(repoDir, { recursive: true, force: true });
      });

      it('enriches absent remote with evil.com URL; structural domain gate escalates', () => {
        const allowlists = new Map([['git', ['github.com']]]);
        const engine = new PolicyEngine(escalatePushPolicy, pushAnnotations, [], SANDBOX_DIR, allowlists);

        const result = engine.evaluate(
          makeRequest({
            serverName: 'git',
            toolName: 'git_push',
            arguments: { path: repoDir, branch: 'main' }, // remote absent
          }),
        );
        // Enrichment runs after structural checks, so the enriched URL
        // (evil.com) is evaluated by compiled rules, not the structural domain gate.
        expect(result.decision).toBe('escalate');
      });
    });

    describe('with tracking branch pointing to non-origin remote', () => {
      let repoDir: string;
      const upstreamUrl = 'https://github.com/upstream/repo.git';

      beforeAll(() => {
        mkdirSync(SANDBOX_DIR, { recursive: true });
        repoDir = realpathSync(mkdtempSync(`${SANDBOX_DIR}/ic-enrich-tracking-`));
        const opts = {
          cwd: repoDir,
          encoding: 'utf-8' as const,
          stdio: ['pipe', 'pipe', 'pipe'] as const,
          timeout: 10_000,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@test.local',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@test.local',
          },
        };
        execFileSync('git', ['init'], { ...opts });
        execFileSync('git', ['config', 'user.email', 'test@test.local'], opts);
        execFileSync('git', ['config', 'user.name', 'Test'], opts);
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fork/repo.git'], opts);
        execFileSync('git', ['remote', 'add', 'upstream', upstreamUrl], opts);
        execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], opts);
        // Discover the current branch name and configure tracking → upstream
        const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
        execFileSync('git', ['config', `branch.${branch}.remote`, 'upstream'], opts);
        execFileSync('git', ['config', `branch.${branch}.merge`, `refs/heads/${branch}`], opts);
      });

      afterAll(() => {
        rmSync(repoDir, { recursive: true, force: true });
      });

      it('enriches absent remote using tracking remote (not origin)', () => {
        const allowlists = new Map([['git', ['github.com']]]);
        const engine = new PolicyEngine(escalatePushPolicy, pushAnnotations, [], SANDBOX_DIR, allowlists);

        const result = engine.evaluate(
          makeRequest({
            serverName: 'git',
            toolName: 'git_push',
            arguments: { path: repoDir, branch: 'main' }, // remote absent
          }),
        );
        // Enrichment resolves via branch config → 'upstream' → upstreamUrl (github.com)
        // Domain gate passes; compiled rule escalates
        expect(result.rule).not.toBe('structural-domain-escalate');
        expect(result.decision).toBe('escalate');
        expect(result.rule).toBe('escalate-git-push');
      });
    });
  });

  describe('Compiled rule evaluation: domains condition matching', () => {
    // Use a tool with only URL roles to isolate domain matching behavior
    const fetchAnnotations: ToolAnnotationsFile = {
      generatedAt: 'test',
      servers: {
        fetch: {
          inputHash: 'test',
          tools: [
            {
              toolName: 'fetch_url',
              serverName: 'fetch',
              comment: 'Fetch a URL',
              sideEffects: true,
              args: {
                url: ['fetch-url'],
              },
            },
          ],
        },
      },
    };

    it('matches when domain is in the allowed list', () => {
      const policy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-github-fetch',
            description: 'Allow fetching from GitHub',
            principle: 'test',
            if: {
              tool: ['fetch_url'],
              domains: { roles: ['fetch-url'], allowed: ['github.com', '*.github.com'] },
            },
            then: 'allow',
            reason: 'GitHub is trusted',
          },
          {
            name: 'deny-all',
            description: 'Deny everything else',
            principle: 'test',
            if: {},
            then: 'deny',
            reason: 'Default deny',
          },
        ],
      };

      const engine = new PolicyEngine(policy, fetchAnnotations, []);
      const result = engine.evaluate(
        makeRequest({
          serverName: 'fetch',
          toolName: 'fetch_url',
          arguments: { url: 'https://github.com/user/repo' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-github-fetch');
    });

    it('does not match when domain is not in the allowed list', () => {
      const policy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-github-fetch',
            description: 'Allow fetching from GitHub',
            principle: 'test',
            if: {
              tool: ['fetch_url'],
              domains: { roles: ['fetch-url'], allowed: ['github.com'] },
            },
            then: 'allow',
            reason: 'GitHub is trusted',
          },
          {
            name: 'deny-all',
            description: 'Deny everything else',
            principle: 'test',
            if: {},
            then: 'deny',
            reason: 'Default deny',
          },
        ],
      };

      const engine = new PolicyEngine(policy, fetchAnnotations, []);
      const result = engine.evaluate(
        makeRequest({
          serverName: 'fetch',
          toolName: 'fetch_url',
          arguments: { url: 'https://evil.com/malware' },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('deny-all');
    });

    it('handles multi-role tools with domain and path conditions', () => {
      // git_clone has both write-path (path) and git-remote-url (url)
      const cloneAnnotations: ToolAnnotationsFile = {
        generatedAt: 'test',
        servers: {
          git: {
            inputHash: 'test',
            tools: [
              {
                toolName: 'git_clone',
                serverName: 'git',
                comment: 'Clone a repository',
                sideEffects: true,
                args: {
                  url: ['git-remote-url'],
                  path: ['write-path'],
                },
              },
            ],
          },
        },
      };

      const policy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-github-clones',
            description: 'Allow cloning from GitHub',
            principle: 'test',
            if: {
              tool: ['git_clone'],
              domains: { roles: ['git-remote-url'], allowed: ['github.com'] },
            },
            then: 'allow',
            reason: 'GitHub is trusted',
          },
          {
            name: 'escalate-writes',
            description: 'Escalate all writes',
            principle: 'test',
            if: { roles: ['write-path'] },
            then: 'escalate',
            reason: 'Writes need approval',
          },
        ],
      };

      const engine = new PolicyEngine(policy, cloneAnnotations, []);
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/user/repo.git', path: '/some/path' },
        }),
      );
      // git-remote-url → allow (domain matches), write-path → escalate
      // Most restrictive: escalate
      expect(result.decision).toBe('escalate');
    });
  });

  describe('git sandbox containment (all path roles are sandbox-safe)', () => {
    // Git tools operating within the sandbox are structurally auto-allowed.
    // Rationale: the agent can already freely read/write/delete files in
    // the sandbox (including .git/ contents), so git operations inside the
    // sandbox are no more privileged than direct file manipulation.

    it('allows git_reset in sandbox via structural sandbox-allow', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_reset',
          arguments: { path: `${SANDBOX_DIR}/repo`, mode: 'hard' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows git_merge in sandbox via structural sandbox-allow', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_merge',
          arguments: { path: `${SANDBOX_DIR}/repo`, branch: 'feature' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows git_rebase in sandbox via structural sandbox-allow', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_rebase',
          arguments: { path: `${SANDBOX_DIR}/repo`, branch: 'main' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows git_branch in sandbox via structural sandbox-allow', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_branch',
          arguments: { path: `${SANDBOX_DIR}/repo`, name: 'old-branch', delete: true },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows git_status in sandbox via structural sandbox-allow', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_status',
          arguments: { path: `${SANDBOX_DIR}/repo` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows git_add in sandbox via structural sandbox-allow', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_add',
          arguments: { path: `${SANDBOX_DIR}/repo`, files: ['test.txt'] },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('allows git_commit in sandbox via structural sandbox-allow', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_commit',
          arguments: { path: `${SANDBOX_DIR}/repo`, message: 'test commit' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });

    it('escalates git_reset outside sandbox (compiled rules still apply)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_reset',
          arguments: { path: '/home/user/external-repo', mode: 'soft' },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-git-destructive-ops');
    });
  });

  describe('multi-role evaluation (path + URL roles)', () => {
    const mixedAnnotations: ToolAnnotationsFile = {
      generatedAt: 'test',
      servers: {
        git: {
          inputHash: 'test',
          tools: [
            {
              toolName: 'git_clone',
              serverName: 'git',
              comment: 'Clone a repository',
              sideEffects: true,
              args: {
                url: ['git-remote-url'],
                path: ['write-path'],
              },
            },
          ],
        },
      },
    };

    it('evaluates both path and URL roles independently', () => {
      const policy: CompiledPolicyFile = {
        generatedAt: 'test',
        constitutionHash: 'test',
        inputHash: 'test',
        rules: [
          {
            name: 'allow-writes',
            description: 'Allow all writes',
            principle: 'test',
            if: { roles: ['write-path'] },
            then: 'allow',
            reason: 'All writes allowed',
          },
          {
            name: 'escalate-urls',
            description: 'Escalate all URL roles',
            principle: 'test',
            if: { roles: ['git-remote-url'] },
            then: 'escalate',
            reason: 'URLs need approval',
          },
        ],
      };

      const engine = new PolicyEngine(policy, mixedAnnotations, []);
      const result = engine.evaluate(
        makeRequest({
          serverName: 'git',
          toolName: 'git_clone',
          arguments: { url: 'https://github.com/user/repo.git', path: '/some/path' },
        }),
      );
      // write-path → allow, git-remote-url → escalate, most restrictive wins
      expect(result.decision).toBe('escalate');
    });
  });

  describe('GitHub tools', () => {
    it('allows read-only GitHub tools (sideEffects: false)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'list_issues',
          arguments: { owner: 'octocat', repo: 'hello-world' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-github-read-ops');
    });

    it('allows get_issue (read-only)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'get_issue',
          arguments: { owner: 'octocat', repo: 'hello-world', issue_number: 1 },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-github-read-ops');
    });

    it('allows search_code (read-only)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'search_code',
          arguments: { q: 'console.log repo:octocat/hello-world' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-github-read-ops');
    });

    it('escalates create_issue (mutation)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'create_issue',
          arguments: { owner: 'octocat', repo: 'hello-world', title: 'Bug', body: 'Details' },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-github-mutations');
    });

    it('escalates create_pull_request (mutation)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'create_pull_request',
          arguments: { owner: 'octocat', repo: 'hello-world', title: 'Fix', head: 'fix', base: 'main' },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-github-mutations');
    });

    it('escalates merge_pull_request (mutation)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'merge_pull_request',
          arguments: { owner: 'octocat', repo: 'hello-world', pull_number: 42 },
        }),
      );
      expect(result.decision).toBe('escalate');
      expect(result.rule).toBe('escalate-github-mutations');
    });

    it('denies unknown GitHub tool (structural invariant)', () => {
      const result = engine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'completely_unknown_tool',
          arguments: {},
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });
  });

  describe('lists conditions with github-owner + github-repo', () => {
    // Build a minimal engine with a rule that allows create_branch only for
    // provos/ironcurtain using two list conditions targeting different roles.
    const githubRepoAnnotations: StoredToolAnnotationsFile = {
      generatedAt: '2025-01-01T00:00:00Z',
      servers: {
        github: {
          inputHash: 'test',
          tools: [
            {
              toolName: 'create_branch',
              serverName: 'github',
              comment: 'Creates a branch.',
              sideEffects: true,
              args: { owner: ['github-owner'], repo: ['github-repo'], branch: ['branch-name'] },
            },
          ],
        },
      },
    };

    const githubRepoPolicy: CompiledPolicyFile = {
      generatedAt: '2025-01-01T00:00:00Z',
      constitutionHash: 'test',
      inputHash: 'test',
      rules: [
        {
          name: 'allow-create-branch-ironcurtain',
          description: 'Allow creating branches in provos/ironcurtain only.',
          principle: 'Restrict to one repo',
          if: {
            tool: ['create_branch'],
            lists: [
              { roles: ['github-owner'], allowed: ['provos'], matchType: 'identifiers' },
              { roles: ['github-repo'], allowed: ['ironcurtain'], matchType: 'identifiers' },
            ],
          },
          then: 'allow',
          reason: 'Only provos/ironcurtain is authorized.',
        },
      ],
    };

    const repoEngine = new PolicyEngine(githubRepoPolicy, githubRepoAnnotations, []);

    it('allows create_branch for provos/ironcurtain', () => {
      const result = repoEngine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'create_branch',
          arguments: { owner: 'provos', repo: 'ironcurtain', branch: 'fix' },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('allow-create-branch-ironcurtain');
    });

    it('denies create_branch for wrong owner (correct repo)', () => {
      const result = repoEngine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'create_branch',
          arguments: { owner: 'attacker', repo: 'ironcurtain', branch: 'fix' },
        }),
      );
      expect(result.decision).toBe('deny');
    });

    it('denies create_branch for correct owner but wrong repo', () => {
      const result = repoEngine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'create_branch',
          arguments: { owner: 'provos', repo: 'other-repo', branch: 'fix' },
        }),
      );
      expect(result.decision).toBe('deny');
    });

    it('denies create_branch for wrong owner and wrong repo', () => {
      const result = repoEngine.evaluate(
        makeRequest({
          serverName: 'github',
          toolName: 'create_branch',
          arguments: { owner: 'attacker', repo: 'other-repo', branch: 'fix' },
        }),
      );
      expect(result.decision).toBe('deny');
    });
  });

  describe('protected path exclusions', () => {
    // The PolicyEngine excludes allowedDirectory (the sandbox) from protected
    // path checks. This means the sandbox can live under a protected directory
    // (like ~/.ironcurtain/) without being blocked, while sibling paths
    // (audit logs, escalation files) remain protected.
    const ironcurtainHome = `${REAL_TMP}/fake-ironcurtain-home`;
    const sessionsDir = `${ironcurtainHome}/sessions`;
    const sessionSandbox = `${sessionsDir}/test-session/sandbox`;

    const exclusionProtectedPaths = [ironcurtainHome];

    const exclusionEngine = new PolicyEngine(
      testCompiledPolicy,
      testToolAnnotations,
      exclusionProtectedPaths,
      sessionSandbox,
    );

    it('denies access to file within protected parent directory', () => {
      const result = exclusionEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${ironcurtainHome}/config.json` },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('denies access to session files outside the sandbox', () => {
      // Audit logs and other session files are under sessions/ but outside
      // the sandbox, so they remain protected by the parent directory rule.
      const result = exclusionEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${sessionsDir}/other-session/audit.jsonl` },
        }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-protected-path');
    });

    it('allows access within sandbox (excluded from protection)', () => {
      const result = exclusionEngine.evaluate(
        makeRequest({
          toolName: 'read_file',
          arguments: { path: `${sessionSandbox}/test.txt` },
        }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('structural-sandbox-allow');
    });
  });
});

// ---------------------------------------------------------------------------
// Conditional Argument Roles
// ---------------------------------------------------------------------------

describe('PolicyEngine with conditional roles', () => {
  // Annotations with conditional role specs for multi-mode git tools
  const conditionalAnnotations: StoredToolAnnotationsFile = {
    generatedAt: 'test-fixture',
    servers: {
      git: {
        inputHash: 'test-fixture',
        tools: [
          {
            toolName: 'git_branch',
            serverName: 'git',
            comment: 'Creates, lists, or deletes branches.',
            sideEffects: true,
            args: {
              path: {
                default: ['read-path', 'write-history', 'delete-history'],
                when: [
                  { condition: { arg: 'operation', equals: 'list' }, roles: ['read-path'] },
                  { condition: { arg: 'operation', in: ['create', 'rename'] }, roles: ['read-path', 'write-history'] },
                  { condition: { arg: 'operation', equals: 'delete' }, roles: ['read-path', 'delete-history'] },
                ],
              },
              operation: ['none'],
              name: ['branch-name'],
            },
          },
          {
            toolName: 'git_status',
            serverName: 'git',
            comment: 'Shows working tree status.',
            sideEffects: false,
            args: { path: ['read-path'] },
          },
          {
            toolName: 'git_clean',
            serverName: 'git',
            comment: 'Removes untracked files.',
            sideEffects: true,
            args: {
              path: {
                default: ['read-path', 'delete-path'],
                when: [{ condition: { arg: 'dryRun', equals: true }, roles: ['read-path'] }],
              },
              dryRun: ['none'],
            },
          },
          {
            toolName: 'git_stash',
            serverName: 'git',
            comment: 'Stash/pop/list/drop changes.',
            sideEffects: true,
            args: {
              path: {
                default: ['read-path', 'write-history'],
                when: [{ condition: { arg: 'mode', equals: 'list' }, roles: ['read-path'] }],
              },
              mode: ['none'],
            },
          },
        ],
      },
      filesystem: {
        inputHash: 'test-fixture',
        tools: [
          {
            toolName: 'edit_file',
            serverName: 'filesystem',
            comment: 'Makes targeted edits to a file.',
            sideEffects: true,
            args: {
              path: {
                default: ['read-path', 'write-path'],
                when: [{ condition: { arg: 'dryRun', equals: true }, roles: ['read-path'] }],
              },
              edits: ['none'],
              dryRun: ['none'],
            },
          },
        ],
      },
    },
  };

  // Policy rules matching the conditional annotation test scenarios
  const conditionalPolicy: CompiledPolicyFile = {
    generatedAt: 'test-fixture',
    constitutionHash: 'test-fixture',
    inputHash: 'test-fixture',
    rules: [
      {
        name: 'allow-git-read-ops',
        description: 'Allow read-only git operations.',
        principle: 'Least privilege',
        if: { server: ['git'], sideEffects: false },
        then: 'allow',
        reason: 'Read-only git operations are safe.',
      },
      {
        name: 'escalate-git-branch-management',
        description: 'Escalate git branch management.',
        principle: 'Human oversight',
        if: { server: ['git'], tool: ['git_branch'] },
        then: 'escalate',
        reason: 'Branch management requires human approval.',
      },
      {
        name: 'escalate-git-destructive-ops',
        description: 'Escalate git operations with write-history or delete-history.',
        principle: 'Human oversight',
        if: { server: ['git'], roles: ['write-history', 'delete-history'] },
        then: 'escalate',
        reason: 'History-modifying git operations require human approval.',
      },
      {
        name: 'allow-git-safe-ops',
        description: 'Allow git operations that only read.',
        principle: 'Least privilege',
        if: { server: ['git'] },
        then: 'allow',
        reason: 'Safe git operations are allowed.',
      },
      {
        name: 'escalate-filesystem-writes',
        description: 'Escalate filesystem writes outside sandbox.',
        principle: 'Human oversight',
        if: { roles: ['write-path'], server: ['filesystem'] },
        then: 'escalate',
        reason: 'Writes outside sandbox require approval.',
      },
      {
        name: 'allow-filesystem-reads',
        description: 'Allow filesystem reads.',
        principle: 'Least privilege',
        if: { roles: ['read-path'], server: ['filesystem'] },
        then: 'allow',
        reason: 'Reads are safe.',
      },
    ],
  };

  const condEngine = new PolicyEngine(conditionalPolicy, conditionalAnnotations, TEST_PROTECTED_PATHS, SANDBOX_DIR);

  function makeCondRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
    return {
      requestId: 'test-cond',
      serverName: 'git',
      toolName: 'git_branch',
      arguments: { path: `${SANDBOX_DIR}/repo`, operation: 'list' },
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it('allows git_branch operation:list in sandbox (structural sandbox-allow)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        arguments: { path: `${SANDBOX_DIR}/repo`, operation: 'list' },
      }),
    );
    // All path roles within sandbox → structural-sandbox-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('allows git_branch operation:delete in sandbox (structural sandbox-allow)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        arguments: { path: `${SANDBOX_DIR}/repo`, operation: 'delete' },
      }),
    );
    // delete-history is sandbox-safe → structural-sandbox-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('allows git_branch with no operation in sandbox (structural sandbox-allow)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        arguments: { path: `${SANDBOX_DIR}/repo` },
      }),
    );
    // No operation arg -> default roles: read-path + write-history + delete-history
    // All sandbox-safe → structural-sandbox-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('allows edit_file with dryRun:true in sandbox (resolves to read-path only)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        serverName: 'filesystem',
        toolName: 'edit_file',
        arguments: { path: `${SANDBOX_DIR}/test.txt`, edits: '...', dryRun: true },
      }),
    );
    // dryRun:true -> path resolves to ['read-path'] only, within sandbox -> auto-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('allows edit_file with dryRun:false in sandbox (resolves to read-path + write-path)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        serverName: 'filesystem',
        toolName: 'edit_file',
        arguments: { path: `${SANDBOX_DIR}/test.txt`, edits: '...', dryRun: false },
      }),
    );
    // dryRun:false -> no condition matches -> default ['read-path', 'write-path'], within sandbox -> auto-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('escalates edit_file with dryRun:false outside sandbox (write-path escalates)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        serverName: 'filesystem',
        toolName: 'edit_file',
        arguments: { path: `${REAL_TMP}/outside/test.txt`, edits: '...', dryRun: false },
      }),
    );
    // dryRun:false -> default ['read-path', 'write-path'], outside sandbox -> compiled rules
    // write-path matches escalate-filesystem-writes
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-filesystem-writes');
  });

  it('allows edit_file with dryRun:true outside sandbox (read-path allowed)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        serverName: 'filesystem',
        toolName: 'edit_file',
        arguments: { path: `${REAL_TMP}/outside/test.txt`, edits: '...', dryRun: true },
      }),
    );
    // dryRun:true -> path resolves to ['read-path'] only, outside sandbox -> compiled rules
    // read-path matches allow-filesystem-reads
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-filesystem-reads');
  });

  it('allows git_clean with dryRun:true in sandbox (structural sandbox-allow)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        toolName: 'git_clean',
        arguments: { path: `${SANDBOX_DIR}/repo`, dryRun: true },
      }),
    );
    // All path roles within sandbox → structural-sandbox-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('allows git_clean with dryRun:false in sandbox (structural sandbox-allow)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        toolName: 'git_clean',
        arguments: { path: `${SANDBOX_DIR}/repo`, dryRun: false },
      }),
    );
    // dryRun:false -> default ['read-path', 'delete-path'], all sandbox-safe
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('allows git_stash mode:drop in sandbox (structural sandbox-allow)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        toolName: 'git_stash',
        arguments: { path: `${SANDBOX_DIR}/repo`, mode: 'drop' },
      }),
    );
    // write-history is sandbox-safe → structural-sandbox-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('allows git_stash mode:list in sandbox (structural sandbox-allow)', () => {
    const result = condEngine.evaluate(
      makeCondRequest({
        toolName: 'git_stash',
        arguments: { path: `${SANDBOX_DIR}/repo`, mode: 'list' },
      }),
    );
    // read-path within sandbox → structural-sandbox-allow
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  describe('getAnnotation with conditional resolution', () => {
    it('resolves conditional roles for a specific call', () => {
      const annotation = condEngine.getAnnotation('git', 'git_branch', {
        path: '/tmp/repo',
        operation: 'list',
      });
      expect(annotation).toBeDefined();
      expect(annotation!.args.path).toEqual(['read-path']);
    });

    it('returns default roles when no condition matches', () => {
      const annotation = condEngine.getAnnotation('git', 'git_branch', {
        path: '/tmp/repo',
        operation: 'unknown_op',
      });
      expect(annotation).toBeDefined();
      expect(annotation!.args.path).toEqual(['read-path', 'write-history', 'delete-history']);
    });

    it('returns undefined for unknown tool', () => {
      const annotation = condEngine.getAnnotation('git', 'nonexistent', {});
      expect(annotation).toBeUndefined();
    });
  });

  describe('getStoredAnnotation returns raw conditional structure', () => {
    it('returns stored annotation with conditional specs', () => {
      const stored = condEngine.getStoredAnnotation('git', 'git_branch');
      expect(stored).toBeDefined();
      expect(Array.isArray(stored!.args.path)).toBe(false);
      const spec = stored!.args.path as { default: string[]; when: unknown[] };
      expect(spec.default).toEqual(['read-path', 'write-history', 'delete-history']);
      expect(spec.when).toHaveLength(3);
    });

    it('returns stored annotation with static specs unchanged', () => {
      const stored = condEngine.getStoredAnnotation('git', 'git_status');
      expect(stored).toBeDefined();
      expect(stored!.args.path).toEqual(['read-path']);
    });

    it('returns undefined for unknown tool', () => {
      const stored = condEngine.getStoredAnnotation('git', 'nonexistent');
      expect(stored).toBeUndefined();
    });
  });

  describe('trusted server policy', () => {
    const trustedEngine = new PolicyEngine(
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      SANDBOX_DIR,
      undefined,
      undefined,
      new Set(['memory']),
    );

    it('allows any tool from a trusted server without annotations', () => {
      const result = trustedEngine.evaluate(
        makeRequest({ serverName: 'memory', toolName: 'memory_store', arguments: { content: 'hello' } }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('trusted-server');
    });

    it('allows memory_recall from a trusted server', () => {
      const result = trustedEngine.evaluate(
        makeRequest({ serverName: 'memory', toolName: 'memory_recall', arguments: { query: 'test' } }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('trusted-server');
    });

    it('allows unknown tool names from a trusted server', () => {
      const result = trustedEngine.evaluate(
        makeRequest({ serverName: 'memory', toolName: 'nonexistent_tool', arguments: {} }),
      );
      expect(result.decision).toBe('allow');
      expect(result.rule).toBe('trusted-server');
    });

    it('does not affect non-trusted servers', () => {
      const result = trustedEngine.evaluate(
        makeRequest({ serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/etc/passwd' } }),
      );
      // Should go through normal policy evaluation, not trusted-server shortcut
      expect(result.rule).not.toBe('trusted-server');
    });

    it('isTrustedServer returns true for trusted servers', () => {
      expect(trustedEngine.isTrustedServer('memory')).toBe(true);
    });

    it('isTrustedServer returns false for non-trusted servers', () => {
      expect(trustedEngine.isTrustedServer('filesystem')).toBe(false);
    });

    it('denies memory tools when trustedServers is not configured', () => {
      const baseEngine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, protectedPaths, SANDBOX_DIR);
      const result = baseEngine.evaluate(
        makeRequest({ serverName: 'memory', toolName: 'memory_store', arguments: { content: 'hello' } }),
      );
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('structural-unknown-tool');
    });
  });
});
