/**
 * Policy Engine Stress Test — comprehensive coverage of edge cases.
 *
 * Each test group creates its own minimal CompiledPolicyFile and
 * ToolAnnotationsFile inline (not shared fixtures) to isolate behavior
 * and make each group self-documenting.
 */

import { describe, it, expect } from 'vitest';
import { PolicyEngine, domainMatchesAllowlist } from '../src/trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  ToolAnnotationsFile,
  DynamicListsFile,
  ToolAnnotation,
} from '../src/pipeline/types.js';
import type { ToolCallRequest } from '../src/types/mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SANDBOX_DIR = '/tmp/ironcurtain-sandbox';

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

/** Shorthand for a minimal CompiledPolicyFile. */
function makePolicy(rules: CompiledPolicyFile['rules']): CompiledPolicyFile {
  return { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules };
}

/** Shorthand for a minimal ToolAnnotationsFile. */
function makeAnnotations(servers: Record<string, ToolAnnotation[]>): ToolAnnotationsFile {
  const result: ToolAnnotationsFile = { generatedAt: 'test', servers: {} };
  for (const [name, tools] of Object.entries(servers)) {
    result.servers[name] = { inputHash: 'test', tools };
  }
  return result;
}

/** Shorthand for a ToolAnnotation. */
function makeTool(
  serverName: string,
  toolName: string,
  args: Record<string, ToolAnnotation['args'][string]>,
  sideEffects = true,
): ToolAnnotation {
  return { toolName, serverName, comment: 'test', sideEffects, args };
}

// ---------------------------------------------------------------------------
// Role-agnostic rule evaluation
// ---------------------------------------------------------------------------

describe('Role-agnostic rules after structural resolution', () => {
  const annotations = makeAnnotations({
    git: [
      makeTool('git', 'git_push', {
        path: ['none'],
        remote: ['git-remote-url'],
        branch: ['branch-name'],
      }),
      makeTool('git', 'git_pull', {
        path: ['none'],
        remote: ['git-remote-url'],
        branch: ['branch-name'],
      }),
      makeTool('git', 'git_clone', {
        url: ['git-remote-url'],
        path: ['write-path'],
      }),
      makeTool('git', 'git_status', { path: ['read-path'] }, false),
    ],
  });

  const domainAllowlists = new Map([['git', ['github.com', '*.github.com']]]);

  it('escalates via role-agnostic rule when all roles are domain-resolved', () => {
    const policy = makePolicy([
      {
        name: 'escalate-git-push',
        description: 'Escalate push',
        principle: 'test',
        if: { server: ['git'], tool: ['git_push'] },
        then: 'escalate',
        reason: 'Push requires approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-git-push');
  });

  it('allows via role-agnostic rule when all roles are domain-resolved', () => {
    const policy = makePolicy([
      {
        name: 'allow-git-pull',
        description: 'Allow pull',
        principle: 'test',
        if: { server: ['git'], tool: ['git_pull'] },
        then: 'allow',
        reason: 'Pull is allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_pull',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-git-pull');
  });

  it('default-denies when no compiled rule matches (no structural fallback for non-filesystem)', () => {
    const policy = makePolicy([
      {
        name: 'escalate-unrelated',
        description: 'Escalate fetch',
        principle: 'test',
        if: { server: ['fetch'], tool: ['http_fetch'] },
        then: 'escalate',
        reason: 'Fetch needs approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    // No compiled rule matches git_push → default escalate (no structural sandbox-allow for git)
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('default-escalate');
  });

  it('escalates via role-agnostic rule when all roles are sandbox+domain-resolved', () => {
    const policy = makePolicy([
      {
        name: 'escalate-git-clone',
        description: 'Escalate clone',
        principle: 'test',
        if: { server: ['git'], tool: ['git_clone'] },
        then: 'escalate',
        reason: 'Clone requires approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );

    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-git-clone');
  });

  it('evaluates role-specific rules normally for non-filesystem servers', () => {
    const policy = makePolicy([
      {
        name: 'escalate-write-path',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-urls',
        description: 'Allow URLs',
        principle: 'test',
        if: { roles: ['git-remote-url'] },
        then: 'allow',
        reason: 'URLs allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );

    // Non-filesystem: no sandbox resolution, both roles evaluated by compiled rules.
    // write-path → escalate, git-remote-url → allow, most restrictive wins.
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-write-path');
  });

  it('uses first-match-wins ordering for role-agnostic rules', () => {
    const policy = makePolicy([
      {
        name: 'allow-git-push',
        description: 'Allow push',
        principle: 'test',
        if: { server: ['git'], tool: ['git_push'] },
        then: 'allow',
        reason: 'Push is allowed',
      },
      {
        name: 'escalate-git-push',
        description: 'Escalate push',
        principle: 'test',
        if: { server: ['git'], tool: ['git_push'] },
        then: 'escalate',
        reason: 'Push requires approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-git-push');
  });

  it('skips rules with paths condition in role-agnostic evaluation', () => {
    const policy = makePolicy([
      {
        name: 'allow-in-dir',
        description: 'Allow in dir',
        principle: 'test',
        if: { paths: { roles: ['write-path'], within: SANDBOX_DIR } },
        then: 'allow',
        reason: 'In sandbox',
      },
      {
        name: 'escalate-clone',
        description: 'Escalate clone',
        principle: 'test',
        if: { server: ['git'], tool: ['git_clone'] },
        then: 'escalate',
        reason: 'Clone needs approval',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );

    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-clone');
  });

  it('evaluates domains condition in compiled rules for non-filesystem servers', () => {
    const policy = makePolicy([
      {
        name: 'allow-github-domain',
        description: 'Allow GitHub',
        principle: 'test',
        if: { domains: { roles: ['git-remote-url'], allowed: ['github.com'] } },
        then: 'allow',
        reason: 'GitHub is trusted',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    // Non-filesystem: roles go to compiled rule evaluation, domains condition matches
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-github-domain');
  });

  it('default-denies when lists condition does not match for non-filesystem server', () => {
    const policy = makePolicy([
      {
        name: 'allow-listed',
        description: 'Allow listed',
        principle: 'test',
        // lists condition matches on extracted domain from git-remote-url
        // but domainMatchesAllowlist uses domain matching, and the extracted
        // value is the raw URL (not domain) so it won't match 'github.com'
        if: { lists: [{ roles: ['git-remote-url'], allowed: ['github.com'], matchType: 'domains' }] },
        then: 'allow',
        reason: 'Listed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR, domainAllowlists);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_push',
        arguments: { path: SANDBOX_DIR, remote: 'https://github.com/user/repo.git', branch: 'main' },
      }),
    );

    // Non-filesystem: no structural sandbox-allow. Roles go to compiled rule evaluation.
    // The lists condition extracts the raw URL string from git-remote-url,
    // domainMatchesAllowlist('https://github.com/user/repo.git', ['github.com']) → false
    // (lists extraction uses extractAnnotatedPaths which gets the raw value,
    // not the policy-prepared domain). So rule doesn't match → default escalate.
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('default-escalate');
  });
});

// ---------------------------------------------------------------------------
// Protected path check: edge cases
// ---------------------------------------------------------------------------

describe('Protected path edge cases', () => {
  const annotations = makeAnnotations({
    filesystem: [makeTool('filesystem', 'read_file', { path: ['read-path'] })],
  });

  it('does NOT deny path that is only a prefix of protected path', () => {
    const engine = new PolicyEngine(
      makePolicy([{ name: 'deny-all', description: 'd', principle: 't', if: {}, then: 'deny', reason: 'default' }]),
      annotations,
      ['/home/user/secret'],
    );
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/secret2' } }));
    expect(result.rule).not.toBe('structural-protected-path');
  });

  it('denies path equal to protected path', () => {
    const engine = new PolicyEngine(makePolicy([]), annotations, ['/home/user/secret']);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/secret' } }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-protected-path');
  });

  it('denies path inside protected directory', () => {
    const engine = new PolicyEngine(makePolicy([]), annotations, ['/home/user/secret']);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/secret/file.txt' } }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-protected-path');
  });

  it('denies path with .. that resolves to protected path', () => {
    const engine = new PolicyEngine(makePolicy([]), annotations, ['/home/user/secret']);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/home/user/other/../secret/file.txt' } }));
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-protected-path');
  });
});

// ---------------------------------------------------------------------------
// Filesystem sandbox containment: edge cases
// ---------------------------------------------------------------------------

describe('Sandbox containment edge cases', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
      makeTool('filesystem', 'write_file', { path: ['write-path'], content: ['none'] }),
    ],
    git: [
      makeTool('git', 'git_reset', {
        path: ['read-path', 'write-history'],
        mode: ['none'],
      }),
      makeTool('git', 'git_branch', {
        path: ['read-path', 'write-history', 'delete-history'],
        name: ['branch-name'],
        delete: ['none'],
      }),
      makeTool('git', 'git_status', { path: ['read-path'] }, false),
    ],
  });

  const policy = makePolicy([
    {
      name: 'escalate-destructive',
      description: 'Escalate destructive ops',
      principle: 'test',
      if: { server: ['git'], tool: ['git_reset', 'git_branch'] },
      then: 'escalate',
      reason: 'Destructive ops need approval',
    },
    {
      name: 'allow-git-read',
      description: 'Allow git reads',
      principle: 'test',
      if: { server: ['git'], sideEffects: false },
      then: 'allow',
      reason: 'Reads are safe',
    },
    {
      name: 'escalate-reads',
      description: 'Escalate reads outside sandbox',
      principle: 'test',
      if: { roles: ['read-path'] },
      then: 'escalate',
      reason: 'Reads outside sandbox need approval',
    },
    {
      name: 'deny-all',
      description: 'Default deny',
      principle: 'test',
      if: {},
      then: 'deny',
      reason: 'Default deny',
    },
  ]);

  it('allows path with .. in middle that resolves inside sandbox', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        arguments: { path: `${SANDBOX_DIR}/subdir/../test.txt` },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('structural-sandbox-allow');
  });

  it('write-history role is NOT sandbox-resolved (goes to compiled rule evaluation)', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_reset',
        arguments: { path: `${SANDBOX_DIR}/repo`, mode: 'hard' },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-destructive');
  });

  it('delete-history role is NOT sandbox-resolved (goes to compiled rule evaluation)', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_branch',
        arguments: { path: `${SANDBOX_DIR}/repo`, name: 'old', delete: true },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-destructive');
  });

  it('mixed sandbox-safe and unsafe roles: safe roles resolved, unsafe go to compiled rule evaluation', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_reset',
        arguments: { path: `${SANDBOX_DIR}/repo`, mode: 'soft' },
      }),
    );
    expect(result.decision).toBe('escalate');
  });

  it('tool with only opaque roles evaluates role-agnostic rules', () => {
    const opaqueAnnotations = makeAnnotations({
      myserver: [makeTool('myserver', 'my_tool', { flag: ['none'], count: ['none'] })],
    });

    const opaquePolicy = makePolicy([
      {
        name: 'allow-my-tool',
        description: 'Allow my_tool',
        principle: 'test',
        if: { server: ['myserver'], tool: ['my_tool'] },
        then: 'allow',
        reason: 'Allowed',
      },
    ]);

    const engine = new PolicyEngine(opaquePolicy, opaqueAnnotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { flag: true, count: 5 },
      }),
    );

    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-my-tool');
  });
});

// ---------------------------------------------------------------------------
// Untrusted domain gate: edge cases
// ---------------------------------------------------------------------------

describe('Domain allowlist edge cases', () => {
  const gitAnnotations = makeAnnotations({
    git: [
      makeTool('git', 'git_clone', {
        url: ['git-remote-url'],
        path: ['write-path'],
      }),
    ],
  });

  const defaultPolicy = makePolicy([
    {
      name: 'deny-all',
      description: 'Default deny',
      principle: 'test',
      if: {},
      then: 'deny',
      reason: 'Default deny',
    },
  ]);

  it('IP addresses with * wildcard escalate (SSRF protection)', () => {
    expect(domainMatchesAllowlist('127.0.0.1', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('10.0.0.1', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('169.254.169.254', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('192.168.1.1', ['*'])).toBe(false);
  });

  it('IPv6 with * wildcard escalates (SSRF protection)', () => {
    expect(domainMatchesAllowlist('::1', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('[::1]', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('fe80::1', ['*'])).toBe(false);
  });

  it('explicit IP in allowlist allows (SSRF opt-in)', () => {
    expect(domainMatchesAllowlist('192.168.1.100', ['192.168.1.100'])).toBe(true);
    expect(domainMatchesAllowlist('192.168.1.100', ['*', '192.168.1.100'])).toBe(true);
  });

  it('URL with port number extracts hostname correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com:443/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('URL with non-standard port extracts hostname correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com:8080/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('URL with userinfo extracts hostname correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://user:pass@github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('case-insensitive domain extraction (HTTPS://GITHUB.COM)', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'HTTPS://GITHUB.COM/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('SSH git URL extracts domain correctly', () => {
    const allowlists = new Map([['git', ['github.com']]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'git@github.com:user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('server without domain allowlist falls through to compiled rule evaluation', () => {
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://evil.com/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.rule).not.toBe('structural-domain-escalate');
  });

  it('empty domain allowlist escalates everything', () => {
    const allowlists = new Map([['git', [] as string[]]]);
    const engine = new PolicyEngine(defaultPolicy, gitAnnotations, [], SANDBOX_DIR, allowlists);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://github.com/user/repo.git', path: `${SANDBOX_DIR}/repo` },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('structural-domain-escalate');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: rule matching
// ---------------------------------------------------------------------------

describe('Compiled rule evaluation: rule matching', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
      makeTool('filesystem', 'write_file', { path: ['write-path'], content: ['none'] }),
      makeTool('filesystem', 'list_dirs', {}, false),
    ],
    myserver: [makeTool('myserver', 'my_tool', { data: ['none'] })],
  });

  it('first-match-wins: earlier rule takes precedence', () => {
    const policy = makePolicy([
      {
        name: 'allow-all-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
      {
        name: 'deny-all-reads',
        description: 'Deny reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'deny',
        reason: 'Reads denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/etc/file.txt' } }));
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-all-reads');
  });

  it('sideEffects: false matches side-effect-free tools', () => {
    const policy = makePolicy([
      {
        name: 'allow-pure',
        description: 'Allow pure',
        principle: 'test',
        if: { sideEffects: false },
        then: 'allow',
        reason: 'Pure tools are safe',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'filesystem',
        toolName: 'list_dirs',
        arguments: {},
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-pure');
  });

  it('sideEffects: true does not match side-effect-free tools', () => {
    const policy = makePolicy([
      {
        name: 'deny-side-effects',
        description: 'Deny side effects',
        principle: 'test',
        if: { sideEffects: true },
        then: 'deny',
        reason: 'Side effects denied',
      },
      {
        name: 'allow-all',
        description: 'Allow all',
        principle: 'test',
        if: {},
        then: 'allow',
        reason: 'Allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'filesystem',
        toolName: 'list_dirs',
        arguments: {},
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-all');
  });

  it('paths.within condition with nested directories', () => {
    const policy = makePolicy([
      {
        name: 'allow-reads-in-dir',
        description: 'Allow reads in /tmp/permitted',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/permitted' } },
        then: 'allow',
        reason: 'In permitted dir',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Default deny',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);

    const inDir = engine.evaluate(makeRequest({ arguments: { path: '/tmp/permitted/deep/nested/file.txt' } }));
    expect(inDir.decision).toBe('allow');

    const outDir = engine.evaluate(makeRequest({ arguments: { path: '/tmp/other/file.txt' } }));
    expect(outDir.decision).toBe('deny');
  });

  it('roles condition matches tool with that role', () => {
    const policy = makePolicy([
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-all',
        description: 'Allow all',
        principle: 'test',
        if: {},
        then: 'allow',
        reason: 'Allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);

    const writeResult = engine.evaluate(
      makeRequest({
        toolName: 'write_file',
        arguments: { path: '/etc/config.yaml', content: 'data' },
      }),
    );
    expect(writeResult.decision).toBe('escalate');

    const readResult = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: '/etc/config.yaml' },
      }),
    );
    expect(readResult.decision).toBe('allow');
  });

  it('combined conditions: server + tool + sideEffects all must match', () => {
    const policy = makePolicy([
      {
        name: 'allow-specific',
        description: 'Allow specific combo',
        principle: 'test',
        if: { server: ['filesystem'], tool: ['read_file'], sideEffects: true },
        then: 'allow',
        reason: 'Specific match',
      },
      {
        name: 'deny-all',
        description: 'Deny all',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);

    const match = engine.evaluate(makeRequest({ arguments: { path: '/etc/file.txt' } }));
    expect(match.decision).toBe('allow');

    const wrongServer = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { data: 'test' },
      }),
    );
    expect(wrongServer.decision).toBe('deny');
  });

  it('default deny when no rules match', () => {
    const policy = makePolicy([
      {
        name: 'allow-writes-only',
        description: 'Allow writes only',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'allow',
        reason: 'Only writes allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(makeRequest({ arguments: { path: '/etc/file.txt' } }));
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('default-escalate');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: multi-role evaluation
// ---------------------------------------------------------------------------

describe('Multi-role evaluation', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'complex_op', {
        source: ['read-path', 'delete-path'],
        destination: ['write-path'],
      }),
      makeTool('filesystem', 'edit_file', {
        path: ['read-path', 'write-path'],
        edits: ['none'],
      }),
    ],
  });

  it('deny > escalate: one role deny + another escalate → deny', () => {
    const policy = makePolicy([
      {
        name: 'deny-deletes',
        description: 'Deny deletes',
        principle: 'test',
        if: { roles: ['delete-path'] },
        then: 'deny',
        reason: 'Deletes forbidden',
      },
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'complex_op',
        arguments: { source: '/etc/a.txt', destination: '/tmp/b.txt' },
      }),
    );
    expect(result.decision).toBe('deny');
  });

  it('escalate > allow: one role escalate + another allow → escalate', () => {
    const policy = makePolicy([
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes need approval',
      },
      {
        name: 'allow-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'edit_file',
        arguments: { path: '/etc/config.txt', edits: [] },
      }),
    );
    expect(result.decision).toBe('escalate');
  });

  it('all roles allow → allow', () => {
    const policy = makePolicy([
      {
        name: 'allow-all-roles',
        description: 'Allow all',
        principle: 'test',
        if: {},
        then: 'allow',
        reason: 'All allowed',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'edit_file',
        arguments: { path: '/etc/config.txt', edits: [] },
      }),
    );
    expect(result.decision).toBe('allow');
  });

  it('3-role tool: most restrictive across all roles wins', () => {
    const policy = makePolicy([
      {
        name: 'allow-reads',
        description: 'Allow reads',
        principle: 'test',
        if: { roles: ['read-path'] },
        then: 'allow',
        reason: 'Reads allowed',
      },
      {
        name: 'escalate-writes',
        description: 'Escalate writes',
        principle: 'test',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes escalated',
      },
      {
        name: 'deny-deletes',
        description: 'Deny deletes',
        principle: 'test',
        if: { roles: ['delete-path'] },
        then: 'deny',
        reason: 'Deletes denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'complex_op',
        arguments: { source: '/etc/a.txt', destination: '/tmp/b.txt' },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('deny-deletes');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: per-element multi-path evaluation
// ---------------------------------------------------------------------------

describe('Per-element multi-path evaluation', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_multiple_files', { paths: ['read-path'] }),
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
    ],
  });

  it('multiple paths spanning different rules: most restrictive wins', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-a' } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'escalate-dir-b',
        description: 'Escalate reads in dir-b',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-b' } },
        then: 'escalate',
        reason: 'In dir-b',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: ['/tmp/dir-a/f1.txt', '/tmp/dir-b/f2.txt'] },
      }),
    );
    expect(result.decision).toBe('escalate');
  });

  it('one path undischarged (no matching rule) → default deny', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-a' } },
        then: 'allow',
        reason: 'In dir-a',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: ['/tmp/dir-a/f1.txt', '/tmp/unknown/f2.txt'] },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('default-escalate');
  });

  it('all paths discharged by different rules → most restrictive wins', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-a' } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'allow-dir-b',
        description: 'Allow reads in dir-b',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-b' } },
        then: 'allow',
        reason: 'In dir-b',
      },
      {
        name: 'escalate-dir-c',
        description: 'Escalate reads in dir-c',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-c' } },
        then: 'escalate',
        reason: 'In dir-c',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: {
          paths: ['/tmp/dir-a/f1.txt', '/tmp/dir-b/f2.txt', '/tmp/dir-c/f3.txt'],
        },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-dir-c');
  });

  it('single-path argument → normal flow (no per-element evaluation)', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow reads in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-a' } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: '/tmp/dir-a/file.txt' },
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-dir-a');
  });

  it('role-agnostic catch-all discharges all remaining paths', () => {
    const policy = makePolicy([
      {
        name: 'allow-dir-a',
        description: 'Allow in dir-a',
        principle: 'test',
        if: { paths: { roles: ['read-path'], within: '/tmp/dir-a' } },
        then: 'allow',
        reason: 'In dir-a',
      },
      {
        name: 'escalate-all',
        description: 'Escalate everything',
        principle: 'test',
        if: {},
        then: 'escalate',
        reason: 'Escalated',
      },
    ]);

    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: ['/tmp/dir-a/f1.txt', '/tmp/unknown/f2.txt'] },
      }),
    );
    expect(result.decision).toBe('escalate');
    expect(result.rule).toBe('escalate-all');
  });
});

// ---------------------------------------------------------------------------
// Compiled rule evaluation: lists condition matching
// ---------------------------------------------------------------------------

describe('Lists condition matching', () => {
  // Use fetch-url role as a stand-in for email-recipient since custom
  // roles can't be added to the registry. The list matching logic is
  // the same regardless of role name.
  const emailAnnotations = makeAnnotations({
    email: [
      makeTool('email', 'send_email', {
        to: ['fetch-url'],
        subject: ['none'],
        body: ['none'],
      }),
    ],
  });

  it('lists condition with matchType domains and wildcard matching', () => {
    const fetchAnnotations = makeAnnotations({
      fetch: [makeTool('fetch', 'fetch_url', { url: ['fetch-url'] })],
    });

    const policy = makePolicy([
      {
        name: 'allow-listed-domains',
        description: 'Allow listed domains',
        principle: 'test',
        if: {
          tool: ['fetch_url'],
          domains: { roles: ['fetch-url'], allowed: ['github.com', '*.github.com'] },
        },
        then: 'allow',
        reason: 'Domain is allowed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, fetchAnnotations, []);

    const match = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://api.github.com/repos' },
      }),
    );
    expect(match.decision).toBe('allow');

    const noMatch = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://evil.com/steal' },
      }),
    );
    expect(noMatch.decision).toBe('deny');
  });

  it('lists condition with matchType emails case-insensitive', () => {
    const policy = makePolicy([
      {
        name: 'allow-listed-emails',
        description: 'Allow listed emails',
        principle: 'test',
        if: {
          tool: ['send_email'],
          lists: [
            {
              roles: ['fetch-url'],
              allowed: ['alice@example.com', 'bob@example.com'],
              matchType: 'emails',
            },
          ],
        },
        then: 'allow',
        reason: 'Recipient is allowed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, emailAnnotations, []);

    const result = engine.evaluate(
      makeRequest({
        serverName: 'email',
        toolName: 'send_email',
        arguments: { to: 'ALICE@EXAMPLE.COM', subject: 'Hi', body: 'Hello' },
      }),
    );
    expect(result.decision).toBe('allow');

    const deny = engine.evaluate(
      makeRequest({
        serverName: 'email',
        toolName: 'send_email',
        arguments: { to: 'evil@hacker.com', subject: 'Hi', body: 'Hello' },
      }),
    );
    expect(deny.decision).toBe('deny');
  });

  it('lists condition with matchType identifiers exact match', () => {
    const idAnnotations = makeAnnotations({
      myserver: [makeTool('myserver', 'my_tool', { id: ['fetch-url'] })],
    });

    const policy = makePolicy([
      {
        name: 'allow-listed-ids',
        description: 'Allow listed IDs',
        principle: 'test',
        if: {
          tool: ['my_tool'],
          lists: [
            {
              roles: ['fetch-url'],
              allowed: ['proj-123', 'proj-456'],
              matchType: 'identifiers',
            },
          ],
        },
        then: 'allow',
        reason: 'ID is allowed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, idAnnotations, []);

    const match = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { id: 'proj-123' },
      }),
    );
    expect(match.decision).toBe('allow');

    // Case-sensitive: 'PROJ-123' ≠ 'proj-123'
    const noMatch = engine.evaluate(
      makeRequest({
        serverName: 'myserver',
        toolName: 'my_tool',
        arguments: { id: 'PROJ-123' },
      }),
    );
    expect(noMatch.decision).toBe('deny');
  });

  it('zero extracted values → condition not satisfied, rule does not match', () => {
    const fetchAnnotations = makeAnnotations({
      fetch: [makeTool('fetch', 'fetch_url', { url: ['fetch-url'] })],
    });

    const policy = makePolicy([
      {
        name: 'allow-listed',
        description: 'Allow listed',
        principle: 'test',
        if: {
          lists: [
            {
              roles: ['git-remote-url'],
              allowed: ['github.com'],
              matchType: 'domains',
            },
          ],
        },
        then: 'allow',
        reason: 'Listed',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const engine = new PolicyEngine(policy, fetchAnnotations, []);
    const result = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://example.com' },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('deny-all');
  });
});

// ---------------------------------------------------------------------------
// Argument edge cases
// ---------------------------------------------------------------------------

describe('Argument edge cases', () => {
  const annotations = makeAnnotations({
    filesystem: [
      makeTool('filesystem', 'read_file', { path: ['read-path'] }),
      makeTool('filesystem', 'read_multiple_files', { paths: ['read-path'] }),
      makeTool('filesystem', 'list_dirs', {}, false),
    ],
  });

  const policy = makePolicy([
    {
      name: 'allow-pure',
      description: 'Allow pure tools',
      principle: 'test',
      if: { sideEffects: false },
      then: 'allow',
      reason: 'Pure tools safe',
    },
    {
      name: 'escalate-reads',
      description: 'Escalate reads',
      principle: 'test',
      if: { roles: ['read-path'] },
      then: 'escalate',
      reason: 'Reads need approval',
    },
    {
      name: 'deny-all',
      description: 'Default deny',
      principle: 'test',
      if: {},
      then: 'deny',
      reason: 'Denied',
    },
  ]);

  it('empty arguments: tool with no roles triggers role-agnostic rules', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'list_dirs',
        arguments: {},
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.rule).toBe('allow-pure');
  });

  it('argument value is a number → extraction handles gracefully', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: { path: 42 as any },
      }),
    );
    expect(result.decision).toBeDefined();
  });

  it('argument value is null → extraction handles gracefully', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: { path: null as any },
      }),
    );
    expect(result.decision).toBeDefined();
  });

  it('argument value is an array of mixed types → only strings extracted', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_multiple_files',
        arguments: { paths: ['/etc/file.txt', 42, null, '/tmp/other.txt'] },
      }),
    );
    expect(result.decision).toBe('escalate');
  });

  it('argument value is undefined → extraction handles gracefully', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        arguments: { path: undefined as any },
      }),
    );
    expect(result.decision).toBeDefined();
  });

  it('unknown tool is denied', () => {
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'nonexistent_tool',
        arguments: { something: 'value' },
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('structural-unknown-tool');
  });

  it('empty string path is not treated as a filesystem path by heuristic', () => {
    const engine = new PolicyEngine(policy, annotations, [], SANDBOX_DIR);
    const result = engine.evaluate(
      makeRequest({
        toolName: 'read_file',
        arguments: { path: '' },
      }),
    );
    expect(result.decision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dynamic list expansion
// ---------------------------------------------------------------------------

describe('Dynamic list expansion', () => {
  const fetchAnnotations = makeAnnotations({
    fetch: [makeTool('fetch', 'fetch_url', { url: ['fetch-url'] })],
  });

  it('expands @list-name in domains.allowed at load time', () => {
    const policy = makePolicy([
      {
        name: 'allow-listed-domains',
        description: 'Allow listed',
        principle: 'test',
        if: {
          tool: ['fetch_url'],
          domains: { roles: ['fetch-url'], allowed: ['@trusted-domains'] },
        },
        then: 'allow',
        reason: 'Domain is trusted',
      },
      {
        name: 'deny-all',
        description: 'Default deny',
        principle: 'test',
        if: {},
        then: 'deny',
        reason: 'Denied',
      },
    ]);

    const dynamicLists: DynamicListsFile = {
      generatedAt: 'test',
      lists: {
        'trusted-domains': {
          values: ['github.com', 'gitlab.com'],
          manualAdditions: ['bitbucket.org'],
          manualRemovals: ['gitlab.com'],
          resolvedAt: 'test',
          inputHash: 'test',
        },
      },
    };

    const engine = new PolicyEngine(policy, fetchAnnotations, [], undefined, undefined, dynamicLists);

    const github = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://github.com/repo' },
      }),
    );
    expect(github.decision).toBe('allow');

    const bitbucket = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://bitbucket.org/repo' },
      }),
    );
    expect(bitbucket.decision).toBe('allow');

    const gitlab = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://gitlab.com/repo' },
      }),
    );
    expect(gitlab.decision).toBe('deny');

    const evil = engine.evaluate(
      makeRequest({
        serverName: 'fetch',
        toolName: 'fetch_url',
        arguments: { url: 'https://evil.com/steal' },
      }),
    );
    expect(evil.decision).toBe('deny');
  });

  it('throws when @list-name references missing list', () => {
    const policy = makePolicy([
      {
        name: 'allow-listed',
        description: 'Allow listed',
        principle: 'test',
        if: {
          domains: { roles: ['fetch-url'], allowed: ['@nonexistent'] },
        },
        then: 'allow',
        reason: 'Listed',
      },
    ]);

    const dynamicLists: DynamicListsFile = {
      generatedAt: 'test',
      lists: {},
    };

    expect(() => {
      new PolicyEngine(policy, fetchAnnotations, [], undefined, undefined, dynamicLists);
    }).toThrow(/nonexistent/);
  });
});
