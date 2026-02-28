/**
 * Deterministic test policy and annotations.
 *
 * Tests must NOT depend on the LLM-generated files in src/config/generated/
 * because those change with every pipeline run. This fixture provides a
 * stable, hand-crafted policy that exercises all the behaviors the tests
 * verify: sandbox containment, read escalation, write/delete denial,
 * move handling, and side-effect-free tool allowance.
 */

import { resolve, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../../src/pipeline/types.js';
import { getUserConfigPath } from '../../src/config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

// Use realpathSync so the sandbox dir matches resolved paths on macOS
// where /tmp is a symlink to /private/tmp.
export const REAL_TMP = realpathSync('/tmp');
export const TEST_SANDBOX_DIR = `${REAL_TMP}/ironcurtain-sandbox`;

export const TEST_PROTECTED_PATHS = [
  resolve(projectRoot, 'src/config/constitution.md'),
  resolve(projectRoot, 'src/config/generated'),
  resolve(projectRoot, 'src/config/mcp-servers.json'),
  resolve('./audit.jsonl'),
  resolve('.env'),
  getUserConfigPath(),
];

/**
 * Compiled policy rules. Order matters (first match wins per role).
 * Structural invariants (protected paths, unknown tools, sandbox containment)
 * are handled by the PolicyEngine before these rules are evaluated.
 */
export const testCompiledPolicy: CompiledPolicyFile = {
  generatedAt: 'test-fixture',
  constitutionHash: 'test-fixture',
  inputHash: 'test-fixture',
  rules: [
    {
      name: 'allow-list-allowed-directories',
      description: 'Allow list_allowed_directories (side-effect-free introspection).',
      principle: 'Least privilege',
      if: {
        server: ['filesystem'],
        tool: ['list_allowed_directories'],
      },
      then: 'allow',
      reason: 'No filesystem changes, no path arguments.',
    },
    // ── Git-specific rules ──────────────────────────────────────────
    {
      name: 'escalate-git-remote-ops',
      description: 'Escalate git push/pull/fetch and other remote-contacting operations.',
      principle: 'Human oversight',
      if: {
        server: ['git'],
        tool: ['git_push', 'git_pull', 'git_fetch'],
      },
      then: 'escalate',
      reason: 'Remote-contacting git operations require human approval.',
    },
    {
      name: 'escalate-git-destructive-ops',
      description: 'Escalate git reset/rebase/merge and other history-rewriting operations.',
      principle: 'Human oversight',
      if: {
        server: ['git'],
        tool: ['git_reset', 'git_rebase', 'git_merge'],
      },
      then: 'escalate',
      reason: 'History-rewriting git operations require human approval.',
    },
    {
      name: 'escalate-git-branch-management',
      description: 'Escalate git branch management (creation/deletion).',
      principle: 'Human oversight',
      if: {
        server: ['git'],
        tool: ['git_branch'],
      },
      then: 'escalate',
      reason: 'Branch management requires human approval.',
    },
    {
      name: 'allow-git-read-ops',
      description: 'Allow read-only git operations (status, log, diff, etc.).',
      principle: 'Least privilege',
      if: {
        server: ['git'],
        sideEffects: false,
      },
      then: 'allow',
      reason: 'Read-only git operations are safe.',
    },
    {
      name: 'allow-git-staging-and-commit',
      description: 'Allow git add and commit in sandbox.',
      principle: 'Least privilege',
      if: {
        server: ['git'],
        tool: ['git_add', 'git_commit'],
      },
      then: 'allow',
      reason: 'Staging and committing within sandbox are safe.',
    },
    // ── GitHub rules ────────────────────────────────────────────────
    {
      name: 'allow-github-read-ops',
      description: 'Allow read-only GitHub operations.',
      principle: 'Read-only GitHub operations are safe',
      if: {
        server: ['github'],
        sideEffects: false,
      },
      then: 'allow',
      reason: 'Read-only GitHub operations are safe.',
    },
    {
      name: 'escalate-github-mutations',
      description: 'Escalate GitHub mutations to human.',
      principle: 'GitHub mutations require approval',
      if: {
        server: ['github'],
        sideEffects: true,
      },
      then: 'escalate',
      reason: 'GitHub mutations require human approval.',
    },
    // ── Fetch rules ─────────────────────────────────────────────────
    {
      name: 'allow-fetch-get',
      description: 'Allow HTTP GET from any domain.',
      principle: 'Least privilege',
      if: {
        server: ['fetch'],
        tool: ['http_fetch'],
      },
      then: 'allow',
      reason: 'HTTP GET for reading web content is allowed.',
    },
    // ── Filesystem rules ────────────────────────────────────────────
    {
      name: 'deny-delete-outside-permitted-areas',
      description: 'Deny delete-path operations outside sandbox.',
      principle: 'No destruction',
      if: {
        roles: ['delete-path'],
        server: ['filesystem'],
      },
      then: 'deny',
      reason:
        'Deletes outside sandbox are forbidden. Structural sandbox invariant allows sandbox-internal deletes before this rule fires.',
    },
    {
      name: 'escalate-write-outside-permitted-areas',
      description: 'Escalate write-path operations outside sandbox to human.',
      principle: 'Human oversight',
      if: {
        roles: ['write-path'],
        server: ['filesystem'],
      },
      then: 'escalate',
      reason: 'Writes outside sandbox require human approval.',
    },
    {
      name: 'allow-reads-within-dir-a',
      description: 'Allow read-path within /tmp/permitted-a.',
      principle: 'Least privilege',
      if: {
        paths: { roles: ['read-path'], within: `${REAL_TMP}/permitted-a` },
        server: ['filesystem'],
      },
      then: 'allow',
      reason: 'Reads within permitted-a are allowed.',
    },
    {
      name: 'allow-reads-within-dir-b',
      description: 'Allow read-path within /tmp/permitted-b.',
      principle: 'Least privilege',
      if: {
        paths: { roles: ['read-path'], within: `${REAL_TMP}/permitted-b` },
        server: ['filesystem'],
      },
      then: 'allow',
      reason: 'Reads within permitted-b are allowed.',
    },
    {
      name: 'escalate-read-outside-permitted-areas',
      description: 'Escalate read-path operations outside sandbox to human.',
      principle: 'Human oversight',
      if: {
        roles: ['read-path'],
        server: ['filesystem'],
      },
      then: 'escalate',
      reason: 'Reads outside sandbox require human approval.',
    },
  ],
};

/**
 * Tool annotations for the filesystem, git, GitHub, and fetch MCP servers.
 * Filesystem: matches the stable tool set from @modelcontextprotocol/server-filesystem.
 * Git: covers the tools referenced by handwritten git scenarios.
 * GitHub: covers read-only and mutation tools for policy engine tests.
 */
export const testToolAnnotations: ToolAnnotationsFile = {
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
          args: { path: ['read-path'], tail: ['none'], head: ['none'] },
        },
        {
          toolName: 'read_text_file',
          serverName: 'filesystem',
          comment: 'Reads text file contents.',
          sideEffects: true,
          args: { path: ['read-path'], tail: ['none'], head: ['none'] },
        },
        {
          toolName: 'read_media_file',
          serverName: 'filesystem',
          comment: 'Reads image/audio file as base64.',
          sideEffects: true,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'read_multiple_files',
          serverName: 'filesystem',
          comment: 'Reads multiple files at once.',
          sideEffects: true,
          args: { paths: ['read-path'] },
        },
        {
          toolName: 'write_file',
          serverName: 'filesystem',
          comment: 'Creates or overwrites a file.',
          sideEffects: true,
          args: { path: ['write-path'], content: ['none'] },
        },
        {
          toolName: 'edit_file',
          serverName: 'filesystem',
          comment: 'Makes targeted edits to a file.',
          sideEffects: true,
          args: { path: ['read-path', 'write-path'], edits: ['none'], dryRun: ['none'] },
        },
        {
          toolName: 'create_directory',
          serverName: 'filesystem',
          comment: 'Creates a directory.',
          sideEffects: true,
          args: { path: ['write-path'] },
        },
        {
          toolName: 'list_directory',
          serverName: 'filesystem',
          comment: 'Lists directory contents.',
          sideEffects: true,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'list_directory_with_sizes',
          serverName: 'filesystem',
          comment: 'Lists directory contents with sizes.',
          sideEffects: true,
          args: { path: ['read-path'], sortBy: ['none'] },
        },
        {
          toolName: 'directory_tree',
          serverName: 'filesystem',
          comment: 'Recursive directory tree view.',
          sideEffects: true,
          args: { path: ['read-path'], excludePatterns: ['none'] },
        },
        {
          toolName: 'move_file',
          serverName: 'filesystem',
          comment: 'Moves or renames a file/directory.',
          sideEffects: true,
          args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
        },
        {
          toolName: 'search_files',
          serverName: 'filesystem',
          comment: 'Searches for files matching a pattern.',
          sideEffects: true,
          args: { path: ['read-path'], pattern: ['none'], excludePatterns: ['none'] },
        },
        {
          toolName: 'get_file_info',
          serverName: 'filesystem',
          comment: 'Gets file metadata.',
          sideEffects: true,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'list_allowed_directories',
          serverName: 'filesystem',
          comment: 'Lists allowed directories (no side effects).',
          sideEffects: false,
          args: {},
        },
      ],
    },
    git: {
      inputHash: 'test-fixture',
      tools: [
        // Read-only operations: path is read-path so sandbox containment auto-allows
        {
          toolName: 'git_status',
          serverName: 'git',
          comment: 'Shows working tree status.',
          sideEffects: false,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'git_log',
          serverName: 'git',
          comment: 'Shows commit history.',
          sideEffects: false,
          args: { path: ['read-path'] },
        },
        {
          toolName: 'git_diff',
          serverName: 'git',
          comment: 'Shows changes between commits or working tree.',
          sideEffects: false,
          args: { path: ['read-path'] },
        },
        // Local write operations: path is write-path so sandbox containment auto-allows
        {
          toolName: 'git_add',
          serverName: 'git',
          comment: 'Stages files for commit.',
          sideEffects: true,
          args: { path: ['write-path'], files: ['none'] },
        },
        {
          toolName: 'git_commit',
          serverName: 'git',
          comment: 'Creates a new commit.',
          sideEffects: true,
          args: { path: ['write-path'], message: ['commit-message'] },
        },
        // Remote operations: path is none (repo locator), remote is git-remote-url
        // These must go to compiled rules even when path is in sandbox
        {
          toolName: 'git_push',
          serverName: 'git',
          comment: 'Pushes commits to remote.',
          sideEffects: true,
          args: { path: ['none'], remote: ['git-remote-url'], branch: ['branch-name'] },
        },
        {
          toolName: 'git_pull',
          serverName: 'git',
          comment: 'Pulls changes from remote.',
          sideEffects: true,
          args: { path: ['none'], remote: ['git-remote-url'], branch: ['branch-name'] },
        },
        {
          toolName: 'git_fetch',
          serverName: 'git',
          comment: 'Fetches from remote without merging.',
          sideEffects: true,
          args: { path: ['none'], remote: ['git-remote-url'] },
        },
        // History-rewriting operations: path has write-history (not sandbox-safe)
        // so filesystem sandbox containment won't auto-resolve, forcing compiled rule evaluation
        {
          toolName: 'git_reset',
          serverName: 'git',
          comment: 'Resets HEAD to a commit.',
          sideEffects: true,
          args: { path: ['read-path', 'write-history'], mode: ['none'] },
        },
        {
          toolName: 'git_rebase',
          serverName: 'git',
          comment: 'Reapplies commits on top of another branch.',
          sideEffects: true,
          args: { path: ['read-path', 'write-history'], branch: ['branch-name'] },
        },
        {
          toolName: 'git_merge',
          serverName: 'git',
          comment: 'Merges branches.',
          sideEffects: true,
          args: { path: ['read-path', 'write-history'], branch: ['branch-name'] },
        },
        // Branch management: path has both write-history and delete-history
        {
          toolName: 'git_branch',
          serverName: 'git',
          comment: 'Creates, lists, or deletes branches.',
          sideEffects: true,
          args: { path: ['read-path', 'write-history', 'delete-history'], name: ['branch-name'], delete: ['none'] },
        },
      ],
    },
    github: {
      inputHash: 'test-fixture',
      tools: [
        {
          toolName: 'list_issues',
          serverName: 'github',
          comment: 'Lists issues in a repository.',
          sideEffects: false,
          args: { owner: ['github-owner'], repo: ['none'] },
        },
        {
          toolName: 'get_issue',
          serverName: 'github',
          comment: 'Gets a single issue.',
          sideEffects: false,
          args: { owner: ['github-owner'], repo: ['none'], issue_number: ['none'] },
        },
        {
          toolName: 'search_code',
          serverName: 'github',
          comment: 'Searches code across repositories.',
          sideEffects: false,
          args: { q: ['none'] },
        },
        {
          toolName: 'create_issue',
          serverName: 'github',
          comment: 'Creates an issue in a repository.',
          sideEffects: true,
          args: { owner: ['github-owner'], repo: ['none'], title: ['none'], body: ['none'] },
        },
        {
          toolName: 'create_pull_request',
          serverName: 'github',
          comment: 'Creates a pull request.',
          sideEffects: true,
          args: {
            owner: ['github-owner'],
            repo: ['none'],
            title: ['none'],
            head: ['branch-name'],
            base: ['branch-name'],
          },
        },
        {
          toolName: 'merge_pull_request',
          serverName: 'github',
          comment: 'Merges a pull request.',
          sideEffects: true,
          args: { owner: ['github-owner'], repo: ['none'], pull_number: ['none'] },
        },
      ],
    },
    fetch: {
      inputHash: 'test-fixture',
      tools: [
        {
          toolName: 'http_fetch',
          serverName: 'fetch',
          comment: 'Fetches web content via HTTP GET.',
          sideEffects: true,
          args: { url: ['fetch-url'], headers: ['none'], max_length: ['none'], format: ['none'], timeout: ['none'] },
        },
      ],
    },
  },
};

/** Domain allowlists matching the fetch server config (allowedDomains: ["*"]). */
export const TEST_DOMAIN_ALLOWLISTS = new Map<string, string[]>([
  ['fetch', ['*']],
  ['git', ['github.com', '*.github.com', 'gitlab.com', '*.gitlab.com']],
]);
