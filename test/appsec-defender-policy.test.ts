import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../src/types/mcp.js';

const appsecDefenderPolicy: CompiledPolicyFile = {
  generatedAt: 'test-fixture',
  constitutionHash: 'appsec-defender',
  inputHash: 'appsec-defender',
  rules: [
    {
      name: 'allow-filesystem-introspection',
      description: 'Allow side-effect-free filesystem introspection.',
      principle: 'Defensive AppSec needs repository inventory.',
      if: { server: ['filesystem'], tool: ['list_allowed_directories'] },
      then: 'allow',
      reason: 'No repository content is modified.',
    },
    {
      name: 'escalate-external-fetches',
      description: 'External network access requires review.',
      principle: 'Defender workflow keeps unknown external targets constrained.',
      if: { server: ['fetch'] },
      then: 'escalate',
      reason: 'External fetches must be scoped to approved targets.',
    },
    {
      name: 'deny-delete-outside-workspace',
      description: 'Do not delete outside the workspace.',
      principle: 'Destructive operations are constrained.',
      if: { server: ['filesystem'], roles: ['delete-path'] },
      then: 'deny',
      reason: 'Deletes outside the workspace are forbidden.',
    },
    {
      name: 'escalate-writes-outside-workspace',
      description: 'Writing outside the workspace requires review.',
      principle: 'Patches and fixtures stay in the workspace.',
      if: { server: ['filesystem'], roles: ['write-path'] },
      then: 'escalate',
      reason: 'Writes outside the workspace require approval.',
    },
    {
      name: 'escalate-reads-outside-workspace',
      description: 'Reading outside the workspace requires review.',
      principle: 'Credential and host files stay constrained.',
      if: { server: ['filesystem'], roles: ['read-path'] },
      then: 'escalate',
      reason: 'Reads outside the workspace require approval.',
    },
  ],
};

const appsecToolAnnotations: ToolAnnotationsFile = {
  generatedAt: 'test-fixture',
  servers: {
    filesystem: {
      inputHash: 'test-fixture',
      tools: [
        {
          serverName: 'filesystem',
          toolName: 'read_file',
          comment: 'Reads file contents.',
          args: { path: ['read-path'] },
        },
        {
          serverName: 'filesystem',
          toolName: 'write_file',
          comment: 'Writes file contents.',
          args: { path: ['write-path'], content: ['none'] },
        },
        {
          serverName: 'filesystem',
          toolName: 'move_file',
          comment: 'Moves or renames a file.',
          args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
        },
        {
          serverName: 'filesystem',
          toolName: 'list_allowed_directories',
          comment: 'Lists allowed directories.',
          args: {},
        },
      ],
    },
    fetch: {
      inputHash: 'test-fixture',
      tools: [
        {
          serverName: 'fetch',
          toolName: 'http_fetch',
          comment: 'Fetches a URL.',
          args: { url: ['fetch-url'] },
        },
      ],
    },
  },
};

function request(overrides: Partial<ToolCallRequest>): ToolCallRequest {
  return {
    requestId: 'appsec-policy-test',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('AppSec defender policy posture', () => {
  let workspaceDir: string;
  let outsideDir: string;
  let engine: PolicyEngine;

  beforeAll(() => {
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'appsec-policy-workspace-'));
    outsideDir = mkdtempSync(resolve(tmpdir(), 'appsec-policy-outside-'));
    engine = new PolicyEngine(appsecDefenderPolicy, appsecToolAnnotations, [], workspaceDir);
  });

  afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  // Windows path containment is covered elsewhere; these assertions rely on
  // POSIX-style sandbox prefix matching in the current PolicyEngine helper.
  it.skipIf(process.platform === 'win32')('allows source reads inside the workspace', () => {
    const result = engine.evaluate(
      request({
        toolName: 'read_file',
        arguments: { path: resolve(workspaceDir, 'src/routes/admin.ts') },
      }),
    );

    expect(result.decision).toBe('allow');
  });

  it.skipIf(process.platform === 'win32')('allows patch and regression test writes inside the workspace', () => {
    const result = engine.evaluate(
      request({
        toolName: 'write_file',
        arguments: { path: resolve(workspaceDir, 'test/auth-regression.test.ts'), content: 'test' },
      }),
    );

    expect(result.decision).toBe('allow');
  });

  it('escalates writes outside the workspace', () => {
    const result = engine.evaluate(
      request({
        toolName: 'write_file',
        arguments: { path: resolve(outsideDir, 'outside-appsec.txt'), content: 'test' },
      }),
    );

    expect(result.decision).toBe('escalate');
  });

  it('denies destructive filesystem operations outside the workspace', () => {
    const result = engine.evaluate(
      request({
        toolName: 'move_file',
        arguments: {
          source: resolve(outsideDir, 'outside-appsec.txt'),
          destination: resolve(workspaceDir, 'copy.txt'),
        },
      }),
    );

    expect(result.decision).toBe('deny');
  });

  it('escalates external network fetches', () => {
    const result = engine.evaluate(
      request({
        serverName: 'fetch',
        toolName: 'http_fetch',
        arguments: { url: 'https://example.com/advisory.json' },
      }),
    );

    expect(result.decision).toBe('escalate');
  });
});
