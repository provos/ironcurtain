/**
 * Spike test: validate that a role-scoped allow rule for git_branch
 * correctly allows read-only uses (operation: "list") but denies
 * mutation uses (operation: "create") via default-deny on write-history.
 */

import { describe, it, expect } from 'vitest';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../src/types/mcp.js';

const SANDBOX = '/tmp/spike-sandbox';
const OUTSIDE = '/home/user/project';

// Minimal stored annotations with conditional role specs for git_branch
const annotations: StoredToolAnnotationsFile = {
  servers: {
    git: {
      inputHash: 'spike',
      tools: [
        {
          toolName: 'git_branch',
          serverName: 'git',
          comment: 'List, create, or delete branches.',

          args: {
            path: {
              default: ['read-path', 'write-history', 'delete-history'],
              when: [
                { condition: { arg: 'operation', in: ['list', 'show-current'] }, roles: ['read-path'] },
                { condition: { arg: 'operation', in: ['create', 'rename'] }, roles: ['read-path', 'write-history'] },
                { condition: { arg: 'operation', equals: 'delete' }, roles: ['read-path', 'delete-history'] },
              ],
            },
            operation: ['none'],
            name: ['branch-name'],
          },
        },
      ],
    },
  },
};

// Policy with a role-agnostic allow (current compiler output)
const policyToolOnly: CompiledPolicyFile = {
  generatedAt: new Date().toISOString(),
  constitutionHash: 'spike',
  inputHash: 'spike',
  rules: [
    {
      name: 'allow-git-branch',
      description: 'Allow git_branch (no role condition).',
      principle: 'Read-only access.',
      if: {
        tool: ['git_branch'],
      },
      then: 'allow',
      reason: 'Role-agnostic: matches all roles including write-history.',
    },
  ],
};

// Policy with a role-scoped allow (what the compiler should emit)
const policyRoleScoped: CompiledPolicyFile = {
  generatedAt: new Date().toISOString(),
  constitutionHash: 'spike',
  inputHash: 'spike',
  rules: [
    {
      name: 'allow-git-branch-read',
      description: 'Allow git_branch for read-path only.',
      principle: 'Read-only access.',
      if: {
        tool: ['git_branch'],
        roles: ['read-path'],
      },
      then: 'allow',
      reason: 'Only matches when evaluating the read-path role.',
    },
  ],
};

function makeGitBranchRequest(operation: string, path: string): ToolCallRequest {
  return {
    requestId: 'spike',
    serverName: 'git',
    toolName: 'git_branch',
    arguments: { path, operation, name: 'main' },
    timestamp: new Date().toISOString(),
  };
}

describe('spike: git_branch conditional role evaluation', () => {
  describe('tool-only rule (role-agnostic) — allows all roles', () => {
    // A tool-only rule (no `roles` condition) intentionally matches every role,
    // including write-history and delete-history.  This is correct engine behavior:
    // the rule author chose not to scope by role, so mutations are allowed.
    // To restrict mutations, use a role-scoped rule (see the next describe block).
    const engine = new PolicyEngine(policyToolOnly, annotations, [], SANDBOX);

    it('allows git_branch list outside sandbox', () => {
      const result = engine.evaluate(makeGitBranchRequest('list', OUTSIDE));
      expect(result.decision).toBe('allow');
    });

    it('allows git_branch create outside sandbox (role-agnostic rule matches all roles)', () => {
      const result = engine.evaluate(makeGitBranchRequest('create', OUTSIDE));
      expect(result.decision).toBe('allow');
    });
  });

  describe('role-scoped rule — allows reads, denies mutations', () => {
    const engine = new PolicyEngine(policyRoleScoped, annotations, [], SANDBOX);

    it('allows git_branch list outside sandbox (read-path matches)', () => {
      const result = engine.evaluate(makeGitBranchRequest('list', OUTSIDE));
      expect(result.decision).toBe('allow');
    });

    it('denies git_branch create outside sandbox (write-history unmatched)', () => {
      const result = engine.evaluate(makeGitBranchRequest('create', OUTSIDE));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('default-deny');
    });

    it('denies git_branch delete outside sandbox (delete-history unmatched)', () => {
      const result = engine.evaluate(makeGitBranchRequest('delete', OUTSIDE));
      expect(result.decision).toBe('deny');
      expect(result.rule).toBe('default-deny');
    });

    it('allows git_branch list inside sandbox (sandbox auto-allow)', () => {
      const result = engine.evaluate(makeGitBranchRequest('list', `${SANDBOX}/repo`));
      expect(result.decision).toBe('allow');
    });

    it('allows git_branch create inside sandbox (sandbox auto-allow for all roles)', () => {
      const result = engine.evaluate(makeGitBranchRequest('create', `${SANDBOX}/repo`));
      expect(result.decision).toBe('allow');
    });
  });
});
