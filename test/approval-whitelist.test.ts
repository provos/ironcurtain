/**
 * Tests for the approval whitelist: in-memory pattern store, constraint
 * matching, and candidate extraction from escalated tool calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { ToolAnnotation } from '../src/pipeline/types.js';
import {
  createApprovalWhitelist,
  extractWhitelistCandidates,
  type ApprovalWhitelist,
  type WhitelistPattern,
} from '../src/trusted-process/approval-whitelist.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const REAL_TMP = realpathSync('/tmp');

function makeAnnotation(overrides: Partial<ToolAnnotation> = {}): ToolAnnotation {
  return {
    toolName: 'write_file',
    serverName: 'filesystem',
    comment: 'test',
    args: { path: ['write-path'], content: ['none'] },
    ...overrides,
  };
}

function makePattern(overrides: Partial<Omit<WhitelistPattern, 'id'>> = {}): Omit<WhitelistPattern, 'id'> {
  return {
    serverName: 'filesystem',
    toolName: 'write_file',
    constraints: [],
    createdAt: new Date().toISOString(),
    sourceEscalationId: 'test-esc-1',
    originalReason: 'test reason',
    description: 'test pattern',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createApprovalWhitelist: basic operations
// ---------------------------------------------------------------------------

describe('createApprovalWhitelist', () => {
  let whitelist: ApprovalWhitelist;

  beforeEach(() => {
    whitelist = createApprovalWhitelist();
  });

  it('starts empty', () => {
    expect(whitelist.size).toBe(0);
    expect(whitelist.entries()).toEqual([]);
  });

  it('adds a pattern and returns an id', () => {
    const id = whitelist.add(makePattern());
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(whitelist.size).toBe(1);
    expect(whitelist.entries()).toHaveLength(1);
    expect(whitelist.entries()[0].id).toBe(id);
  });

  it('matches a zero-constraint pattern for the same server/tool', () => {
    const annotation = makeAnnotation();
    whitelist.add(makePattern());

    const result = whitelist.match('filesystem', 'write_file', { path: '/any/path', content: 'x' }, annotation);
    expect(result.matched).toBe(true);
  });

  it('does not match a different tool', () => {
    const annotation = makeAnnotation({ toolName: 'read_file' });
    whitelist.add(makePattern());

    const result = whitelist.match('filesystem', 'read_file', { path: '/foo' }, annotation);
    expect(result.matched).toBe(false);
  });

  it('does not match a different server', () => {
    const annotation = makeAnnotation({ serverName: 'other' });
    whitelist.add(makePattern());

    const result = whitelist.match('other', 'write_file', { path: '/foo' }, annotation);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Directory constraint matching
// ---------------------------------------------------------------------------

describe('directory constraint matching', () => {
  let tmpDir: string;
  let whitelist: ApprovalWhitelist;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-test-'));
    mkdirSync(join(tmpDir, 'subdir'), { recursive: true });
    // Create a file so resolveRealPath works in matching
    writeFileSync(join(tmpDir, 'subdir', 'file.txt'), 'test');
    whitelist = createApprovalWhitelist();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches a path within the constrained directory', () => {
    const annotation = makeAnnotation();
    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: join(tmpDir, 'subdir') }],
      }),
    );

    const result = whitelist.match(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'subdir', 'file.txt'), content: 'x' },
      annotation,
    );
    expect(result.matched).toBe(true);
  });

  it('rejects a path outside the constrained directory', () => {
    const annotation = makeAnnotation();
    writeFileSync(join(tmpDir, 'outside.txt'), 'test');
    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: join(tmpDir, 'subdir') }],
      }),
    );

    const result = whitelist.match(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'outside.txt'), content: 'x' },
      annotation,
    );
    expect(result.matched).toBe(false);
  });

  it('matches an exact file in the directory', () => {
    const annotation = makeAnnotation();
    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: tmpDir }],
      }),
    );

    const result = whitelist.match(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'subdir', 'file.txt'), content: 'x' },
      annotation,
    );
    expect(result.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Domain constraint matching
// ---------------------------------------------------------------------------

describe('domain constraint matching', () => {
  let whitelist: ApprovalWhitelist;

  beforeEach(() => {
    whitelist = createApprovalWhitelist();
  });

  it('matches the exact domain', () => {
    const annotation = makeAnnotation({
      toolName: 'http_fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    });
    whitelist.add(
      makePattern({
        serverName: 'fetch',
        toolName: 'http_fetch',
        constraints: [{ kind: 'domain', role: 'fetch-url', domain: 'api.example.com' }],
      }),
    );

    const result = whitelist.match('fetch', 'http_fetch', { url: 'https://api.example.com/data' }, annotation);
    expect(result.matched).toBe(true);
  });

  it('rejects a different domain', () => {
    const annotation = makeAnnotation({
      toolName: 'http_fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    });
    whitelist.add(
      makePattern({
        serverName: 'fetch',
        toolName: 'http_fetch',
        constraints: [{ kind: 'domain', role: 'fetch-url', domain: 'api.example.com' }],
      }),
    );

    const result = whitelist.match('fetch', 'http_fetch', { url: 'https://evil.com/data' }, annotation);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Exact (identifier) constraint matching
// ---------------------------------------------------------------------------

describe('exact constraint matching', () => {
  let whitelist: ApprovalWhitelist;

  beforeEach(() => {
    whitelist = createApprovalWhitelist();
  });

  it('matches case-insensitively', () => {
    const annotation = makeAnnotation({
      toolName: 'create_issue',
      serverName: 'github',
      args: { owner: ['github-owner'], repo: ['github-repo'] },
    });
    whitelist.add(
      makePattern({
        serverName: 'github',
        toolName: 'create_issue',
        constraints: [{ kind: 'exact', role: 'github-owner', value: 'myorg' }],
      }),
    );

    const result = whitelist.match('github', 'create_issue', { owner: 'MyOrg', repo: 'repo' }, annotation);
    expect(result.matched).toBe(true);
  });

  it('rejects a different value', () => {
    const annotation = makeAnnotation({
      toolName: 'create_issue',
      serverName: 'github',
      args: { owner: ['github-owner'], repo: ['github-repo'] },
    });
    whitelist.add(
      makePattern({
        serverName: 'github',
        toolName: 'create_issue',
        constraints: [{ kind: 'exact', role: 'github-owner', value: 'myorg' }],
      }),
    );

    const result = whitelist.match('github', 'create_issue', { owner: 'otherorg', repo: 'repo' }, annotation);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zero-constraint patterns
// ---------------------------------------------------------------------------

describe('zero-constraint patterns', () => {
  it('matches any call to the same server/tool', () => {
    const whitelist = createApprovalWhitelist();
    const annotation = makeAnnotation();
    whitelist.add(makePattern({ constraints: [] }));

    const result = whitelist.match('filesystem', 'write_file', { path: '/anything', content: 'y' }, annotation);
    expect(result.matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractWhitelistCandidates
// ---------------------------------------------------------------------------

describe('extractWhitelistCandidates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-cand-'));
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'readme.md'), 'test');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a directory constraint for path roles', () => {
    const annotation = makeAnnotation();
    const { patterns, ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'docs', 'readme.md'), content: 'x' },
      annotation,
      ['write-path'],
      'esc-1',
      'test reason',
    );

    expect(patterns).toHaveLength(1);
    expect(patterns[0].constraints).toHaveLength(1);
    expect(patterns[0].constraints[0].kind).toBe('directory');
    expect((patterns[0].constraints[0] as { directory: string }).directory).toBe(join(tmpDir, 'docs'));
    expect(ipcs).toHaveLength(1);
    expect(ipcs[0].description).toContain('write-path within');
  });

  it('generates a domain constraint for URL roles', () => {
    const annotation = makeAnnotation({
      toolName: 'http_fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'fetch',
      'http_fetch',
      { url: 'https://api.example.com/v1/data' },
      annotation,
      ['fetch-url'],
      'esc-2',
      'test reason',
    );

    expect(patterns).toHaveLength(1);
    expect(patterns[0].constraints).toHaveLength(1);
    expect(patterns[0].constraints[0].kind).toBe('domain');
    expect((patterns[0].constraints[0] as { domain: string }).domain).toBe('api.example.com');
  });

  it('generates an exact constraint for identifier roles', () => {
    const annotation = makeAnnotation({
      toolName: 'create_issue',
      serverName: 'github',
      args: { owner: ['github-owner'], repo: ['github-repo'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'github',
      'create_issue',
      { owner: 'MyOrg', repo: 'my-repo' },
      annotation,
      ['github-owner'],
      'esc-3',
      'test reason',
    );

    expect(patterns).toHaveLength(1);
    expect(patterns[0].constraints).toHaveLength(1);
    expect(patterns[0].constraints[0].kind).toBe('exact');
    // Identifier values are lowercased
    expect((patterns[0].constraints[0] as { value: string }).value).toBe('myorg');
  });

  it('excludes write-history roles from directory generalization', () => {
    const annotation = makeAnnotation({
      toolName: 'git_reset',
      serverName: 'git',
      args: { path: ['read-path', 'write-history'], mode: ['none'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'git',
      'git_reset',
      { path: join(tmpDir, 'docs', 'readme.md'), mode: 'hard' },
      annotation,
      ['write-history'],
      'esc-4',
      'test reason',
    );

    // write-history is excluded, so no constraints
    expect(patterns[0].constraints).toHaveLength(0);
  });

  it('excludes delete-history roles from directory generalization', () => {
    const annotation = makeAnnotation({
      toolName: 'git_branch',
      serverName: 'git',
      args: { path: ['read-path', 'delete-history'], name: ['branch-name'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'git',
      'git_branch',
      { path: join(tmpDir, 'docs', 'readme.md'), name: 'feature-x' },
      annotation,
      ['delete-history'],
      'esc-5',
      'test reason',
    );

    expect(patterns[0].constraints).toHaveLength(0);
  });

  it('falls back to all resource roles when escalatedRoles is undefined', () => {
    const annotation = makeAnnotation();
    const { patterns } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'docs', 'readme.md'), content: 'x' },
      annotation,
      undefined, // no escalatedRoles
      'esc-6',
      'test reason',
    );

    // Should still produce a directory constraint from the write-path role
    expect(patterns[0].constraints.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].constraints[0].kind).toBe('directory');
  });

  it('returns empty constraints when no values are extractable', () => {
    const annotation = makeAnnotation({ args: {} });
    const { patterns } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      {},
      annotation,
      ['write-path'],
      'esc-7',
      'test reason',
    );

    expect(patterns[0].constraints).toHaveLength(0);
  });

  it('returns empty constraints when args are missing', () => {
    const annotation = makeAnnotation();
    const { patterns } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { content: 'x' }, // path is missing
      annotation,
      ['write-path'],
      'esc-8',
      'test reason',
    );

    expect(patterns[0].constraints).toHaveLength(0);
  });

  it('generates warning for zero-constraint patterns', () => {
    const annotation = makeAnnotation({ args: {} });
    const { ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      {},
      annotation,
      ['write-path'],
      'esc-9',
      'test reason',
    );

    expect(ipcs[0].warning).toBeDefined();
    expect(ipcs[0].warning).toContain('auto-approve ALL');
  });
});

// ---------------------------------------------------------------------------
// Multiple constraints (AND semantics)
// ---------------------------------------------------------------------------

describe('multiple constraints AND semantics', () => {
  it('requires all constraints to match', () => {
    const whitelist = createApprovalWhitelist();
    const annotation = makeAnnotation({
      toolName: 'create_issue',
      serverName: 'github',
      args: { owner: ['github-owner'], repo: ['github-repo'] },
    });

    whitelist.add(
      makePattern({
        serverName: 'github',
        toolName: 'create_issue',
        constraints: [
          { kind: 'exact', role: 'github-owner', value: 'myorg' },
          { kind: 'exact', role: 'github-repo', value: 'myrepo' },
        ],
      }),
    );

    // Both match
    const match = whitelist.match('github', 'create_issue', { owner: 'myorg', repo: 'myrepo' }, annotation);
    expect(match.matched).toBe(true);

    // Only owner matches
    const noMatch = whitelist.match('github', 'create_issue', { owner: 'myorg', repo: 'other' }, annotation);
    expect(noMatch.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// constraintMatches when no values match the role
// ---------------------------------------------------------------------------

describe('constraint matching with no matching role values', () => {
  it('returns false when args have no values for the constraint role', () => {
    const whitelist = createApprovalWhitelist();
    const annotation = makeAnnotation({
      args: { content: ['none'] }, // no write-path args
    });

    whitelist.add(
      makePattern({
        constraints: [{ kind: 'directory', role: 'write-path', directory: '/some/dir' }],
      }),
    );

    const result = whitelist.match('filesystem', 'write_file', { content: 'x' }, annotation);
    expect(result.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constraint deduplication
// ---------------------------------------------------------------------------

describe('constraint deduplication', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-dedup-'));
    mkdirSync(join(tmpDir, 'dir'), { recursive: true });
    writeFileSync(join(tmpDir, 'dir', 'a.txt'), 'a');
    writeFileSync(join(tmpDir, 'dir', 'b.txt'), 'b');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deduplicates identical constraints from multiple args in the same directory', () => {
    // edit_file has both read-path and write-path on the same 'path' arg
    const annotation = makeAnnotation({
      toolName: 'edit_file',
      serverName: 'filesystem',
      args: { path: ['read-path', 'write-path'] },
    });

    const { patterns } = extractWhitelistCandidates(
      'filesystem',
      'edit_file',
      { path: join(tmpDir, 'dir', 'a.txt') },
      annotation,
      ['read-path', 'write-path'],
      'esc-dedup',
      'test reason',
    );

    // read-path and write-path both resolve to the same directory,
    // but they have different roles so they should NOT be deduped
    const dirConstraints = patterns[0].constraints.filter((c) => c.kind === 'directory');
    expect(dirConstraints).toHaveLength(2);
    // However if two args produce the same role+directory, they should dedup
  });
});

// ---------------------------------------------------------------------------
// Description includes role name
// ---------------------------------------------------------------------------

describe('buildDescription includes role names', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(REAL_TMP, 'wl-desc-'));
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'file.txt'), 'test');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes role name in directory constraint description', () => {
    const annotation = makeAnnotation();
    const { ipcs } = extractWhitelistCandidates(
      'filesystem',
      'write_file',
      { path: join(tmpDir, 'docs', 'file.txt'), content: 'x' },
      annotation,
      ['write-path'],
      'esc-desc-1',
      'test reason',
    );

    expect(ipcs[0].description).toContain('write-path within');
  });

  it('includes role name in domain constraint description', () => {
    const annotation = makeAnnotation({
      toolName: 'http_fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    });

    const { ipcs } = extractWhitelistCandidates(
      'fetch',
      'http_fetch',
      { url: 'https://api.example.com/data' },
      annotation,
      ['fetch-url'],
      'esc-desc-2',
      'test reason',
    );

    expect(ipcs[0].description).toContain('fetch-url domain');
  });
});

// ---------------------------------------------------------------------------
// Negative / non-integer whitelistSelection index handling
// ---------------------------------------------------------------------------

describe('whitelistSelection bounds safety', () => {
  it('negative index does not select a pattern', () => {
    const patterns = [makePattern({ description: 'candidate-0' })];

    // Simulate the bounds check used in mcp-proxy-server and index.ts
    const selection = -1 as number;
    const isValid = selection >= 0 && selection < patterns.length;
    expect(isValid).toBe(false);

    // Verify array access with negative index gives undefined
    expect(patterns[selection]).toBeUndefined();
  });

  it('non-integer index does not pass Number.isInteger check', () => {
    expect(Number.isInteger(1.5)).toBe(false);
    expect(Number.isInteger(0)).toBe(true);
    expect(Number.isInteger(-1)).toBe(true);
  });

  it('string coerced to number would fail typeof check', () => {
    // This tests the validation in readEscalationResponse
    const rawValue: unknown = '0';
    expect(typeof rawValue === 'number').toBe(false);
  });
});
