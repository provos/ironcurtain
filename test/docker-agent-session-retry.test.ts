/**
 * Retry-path tests for DockerAgentSession.
 *
 * Exercises the hard-failure signal (exit != 0 with empty stdout) and the
 * `rotateAgentConversationId()` path. Uses `scriptedExec` at the
 * `docker.exec` seam so no Claude Code binary or Docker daemon is needed.
 *
 * Paired with the workflow orchestrator retry tests in
 * `test/workflow/orchestrator-retry.test.ts`; those drive the full two-
 * phase retry loop through the orchestrator. These tests cover the
 * session/adapter plumbing in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerAgentSession, type DockerAgentSessionDeps } from '../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { AgentConversationId, BundleId, SessionId } from '../src/session/types.js';
import type { DockerExecResult } from '../src/docker/types.js';
import { createClaudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import {
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
  scriptedExec,
} from './helpers/docker-mocks.js';

const CLAUDE_JSON_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'all done',
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
});

function buildDeps(
  tempDir: string,
  exec: (container: string, cmd: readonly string[]) => Promise<DockerExecResult>,
): DockerAgentSessionDeps {
  const sessionDir = join(tempDir, 'session');
  const sandboxDir = join(tempDir, 'sandbox');
  const escalationDir = join(tempDir, 'escalations');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });

  const config = {
    mcpServers: {},
    userConfig: {
      anthropicApiKey: 'sk-test',
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
      },
      escalationTimeoutSeconds: 120,
      auditRedaction: { enabled: true },
    },
  } as unknown as IronCurtainConfig;

  const docker = createMockDocker({ exec });

  const infra: DockerInfrastructure = {
    bundleId: 'test-bundle' as BundleId,
    bundleDir: sessionDir,
    workspaceDir: sandboxDir,
    escalationDir,
    auditLogPath: join(tempDir, 'audit.jsonl'),
    proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
    mitmProxy: createMockMitmProxy(),
    docker,
    adapter: createClaudeCodeAdapter(),
    ca: createMockCA(tempDir),
    fakeKeys: new Map([['api.anthropic.com', 'sk-fake']]),
    orientationDir: join(sessionDir, 'orientation'),
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    useTcp: false,
    socketsDir: join(sessionDir, 'sockets'),
    mitmAddr: { socketPath: '/tmp/test-mitm.sock' },
    authKind: 'apikey',
    containerId: 'container-abc123',
    containerName: 'ironcurtain-test',
  };

  return {
    config,
    sessionId: 'test-session-id' as SessionId,
    agentConversationId: '00000000-1111-2222-3333-444444444444' as AgentConversationId,
    infra,
    ownsInfra: true,
  };
}

/** Finds the value of `--session-id` or `--resume` in a claude CLI argv. */
function flagValue(cmd: readonly string[], flag: '--session-id' | '--resume'): string | undefined {
  const idx = cmd.indexOf(flag);
  return idx >= 0 ? cmd[idx + 1] : undefined;
}

describe('DockerAgentSession retry path', () => {
  let tempDir: string;
  let session: DockerAgentSession | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docker-retry-test-'));
    session = undefined;
  });

  afterEach(async () => {
    try {
      await session?.close();
    } catch {
      /* ignore */
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('surfaces hardFailure=true when claude exits 143 with empty output', async () => {
    const { exec } = scriptedExec([{ exitCode: 143, stdout: '', stderr: '' }]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    const result = await session.sendMessageDetailed('do the thing');

    expect(result.hardFailure).toBe(true);
    expect(result.text).toContain('Agent exited with code 143');
  });

  it('surfaces hardFailure=false when claude exits non-zero but produces output', async () => {
    const { exec } = scriptedExec([{ exitCode: 1, stdout: 'some error text', stderr: '' }]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    const result = await session.sendMessageDetailed('do the thing');

    expect(result.hardFailure).toBe(false);
  });

  it('surfaces hardFailure=false for a normal successful turn', async () => {
    const { exec } = scriptedExec([{ exitCode: 0, stdout: CLAUDE_JSON_OK, stderr: '' }]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    const result = await session.sendMessageDetailed('do the thing');

    expect(result.hardFailure).toBe(false);
    expect(result.text).toBe('all done');
  });

  it('rotateAgentConversationId mints a fresh UUID and resets firstTurn', async () => {
    // Script: turn 1 hard-fails, turn 2 succeeds. Between turns we rotate.
    // Expectation: the second exec call should use --session-id with a
    // DIFFERENT UUID than the first (rotation + firstTurn=true), not
    // --resume (which would happen without reset) and not the same UUID
    // (which would collide with "Session ID is already in use").
    const { exec, calls } = scriptedExec([
      { exitCode: 143, stdout: '', stderr: '' },
      { exitCode: 0, stdout: CLAUDE_JSON_OK, stderr: '' },
    ]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    const first = await session.sendMessageDetailed('try it');
    expect(first.hardFailure).toBe(true);

    session.rotateAgentConversationId();

    const second = await session.sendMessageDetailed('try again');
    expect(second.hardFailure).toBe(false);
    expect(second.text).toBe('all done');

    // First call: --session-id with the original UUID.
    const firstId = flagValue(calls[0], '--session-id');
    expect(firstId).toBe(deps.agentConversationId);
    expect(flagValue(calls[0], '--resume')).toBeUndefined();

    // Second call: --session-id with a FRESH UUID (not --resume).
    const secondId = flagValue(calls[1], '--session-id');
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(flagValue(calls[1], '--resume')).toBeUndefined();
  });

  it('without rotation, firstTurn stays true after a hard failure (regression guard)', async () => {
    // This is the pre-fix behavior baseline. Without calling
    // `rotateAgentConversationId()`, a hard-failed first turn leaves
    // `firstTurnComplete=false` AND pins the same UUID, so the second
    // call would emit `--session-id <same-uuid>` — which is what Claude
    // Code rejects with "Session ID is already in use". This test
    // documents the invariant so a future refactor that flips
    // `firstTurnComplete=true` on failure breaks loudly here.
    const { exec, calls } = scriptedExec([
      { exitCode: 143, stdout: '', stderr: '' },
      { exitCode: 143, stdout: '', stderr: '' },
    ]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessageDetailed('attempt 1');
    await session.sendMessageDetailed('attempt 2');

    const firstId = flagValue(calls[0], '--session-id');
    const secondId = flagValue(calls[1], '--session-id');
    expect(firstId).toBe(deps.agentConversationId);
    expect(secondId).toBe(deps.agentConversationId);
    expect(flagValue(calls[1], '--resume')).toBeUndefined();
  });

  it('after a successful turn, subsequent calls use --resume with the same UUID', async () => {
    const { exec, calls } = scriptedExec([
      { exitCode: 0, stdout: CLAUDE_JSON_OK, stderr: '' },
      { exitCode: 0, stdout: CLAUDE_JSON_OK, stderr: '' },
    ]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessageDetailed('turn 1');
    await session.sendMessageDetailed('turn 2');

    expect(flagValue(calls[0], '--session-id')).toBe(deps.agentConversationId);
    expect(flagValue(calls[0], '--resume')).toBeUndefined();
    expect(flagValue(calls[1], '--resume')).toBe(deps.agentConversationId);
    expect(flagValue(calls[1], '--session-id')).toBeUndefined();
  });

  it('forwards transientFailure from a degenerate response envelope (exit=0, output_tokens=0, stop_reason=null)', async () => {
    // Plumbing-level coverage at the session seam: the adapter detects
    // the stall envelope, the session must surface it through
    // sendMessageDetailed unchanged so the orchestrator can short-circuit
    // on it.
    const degenerateEnvelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'preamble only',
      usage: { input_tokens: 1234, output_tokens: 0 },
      stop_reason: null,
    });
    const { exec } = scriptedExec([{ exitCode: 0, stdout: degenerateEnvelope, stderr: '' }]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    const result = await session.sendMessageDetailed('do the thing');

    expect(result.transientFailure).toBeDefined();
    expect(result.transientFailure!.kind).toBe('degenerate_response');
    expect(result.transientFailure!.rawMessage).toContain('output_tokens');
    expect(result.hardFailure).toBe(false);
    expect(result.quotaExhausted).toBeUndefined();
    expect(result.text).toBe('preamble only');
  });

  it('sendMessage delegates to sendMessageDetailed and returns just the text', async () => {
    const { exec } = scriptedExec([{ exitCode: 0, stdout: CLAUDE_JSON_OK, stderr: '' }]);
    const deps = buildDeps(tempDir, exec);
    session = new DockerAgentSession(deps);
    await session.initialize();

    const text = await session.sendMessage('hi');
    expect(text).toBe('all done');
  });
});
