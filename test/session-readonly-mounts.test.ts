/**
 * buildSessionConfig wiring for read-only extra mounts: metadata
 * persistence, resume restore (with a vanished directory), and the agent
 * system-prompt section. See docs/designs/readonly-extra-mounts.md.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { REAL_TMP, TEST_SANDBOX_DIR } from './fixtures/test-policy.js';
import { buildSessionConfig } from '../src/session/index.js';
import { loadSessionMetadata } from '../src/session/session-metadata.js';
import { createSessionId, type SessionMode } from '../src/session/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { AgentId } from '../src/docker/agent-adapter.js';

const TEST_ROOT = `${REAL_TMP}/ironcurtain-ro-mounts-session-test-${process.pid}`;
const TEST_HOME = `${TEST_ROOT}/home`;
const DOCKER_MODE: SessionMode = { kind: 'docker', agent: 'claude-code' as AgentId };

function createTestConfig(): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: { filesystem: { command: 'echo', args: ['test'] } },
    protectedPaths: [],
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: {},
      autoApprove: { enabled: false },
      memory: { enabled: false, autoSave: false },
      modelProviders: { default: 'native' },
    },
  } as unknown as IronCurtainConfig;
}

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
});

afterEach(() => {
  loggerModule.teardown();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('buildSessionConfig read-only mounts', () => {
  it('persists mounts in metadata and describes them in the agent prompt', () => {
    const data = resolve(TEST_ROOT, 'Training');
    mkdirSync(data, { recursive: true });
    const mounts = [{ hostPath: data, containerPath: '/mnt/ro/Training' }];
    const sessionId = createSessionId();

    const result = buildSessionConfig(createTestConfig(), sessionId, sessionId, {
      mode: DOCKER_MODE,
      readonlyMounts: [`${data}/`],
    });

    expect(result.readonlyMounts).toEqual(mounts);
    expect(result.systemPromptAugmentation).toContain('`/mnt/ro/Training`');
    expect(loadSessionMetadata(sessionId)?.readonlyMounts).toEqual(mounts);
  });

  it('restores persisted mounts on resume and drops a vanished directory with a warning', () => {
    const kept = resolve(TEST_ROOT, 'kept');
    const gone = resolve(TEST_ROOT, 'gone');
    mkdirSync(kept, { recursive: true });
    mkdirSync(gone, { recursive: true });
    const sessionId = createSessionId();
    buildSessionConfig(createTestConfig(), sessionId, sessionId, {
      mode: DOCKER_MODE,
      readonlyMounts: [kept, gone],
    });
    loggerModule.teardown();
    rmSync(gone, { recursive: true });

    const resumedId = createSessionId();
    const result = buildSessionConfig(createTestConfig(), sessionId, resumedId, {
      mode: DOCKER_MODE,
      resumeSessionId: sessionId,
    });

    expect(result.readonlyMounts).toEqual([{ hostPath: kept, containerPath: '/mnt/ro/kept' }]);
    expect(result.readonlyMountWarnings).toHaveLength(1);
    expect(result.readonlyMountWarnings[0]).toContain(gone);
    expect(result.systemPromptAugmentation).toContain('no longer available');
  });

  it('adds folders on resume and saves them for later resumes', () => {
    const first = resolve(TEST_ROOT, 'first');
    const second = resolve(TEST_ROOT, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const sessionId = createSessionId();
    buildSessionConfig(createTestConfig(), sessionId, sessionId, { mode: DOCKER_MODE, readonlyMounts: [first] });
    loggerModule.teardown();

    const resumed = buildSessionConfig(createTestConfig(), sessionId, createSessionId(), {
      mode: DOCKER_MODE,
      resumeSessionId: sessionId,
      readonlyMounts: [second],
    });
    loggerModule.teardown();

    const expected = [
      { hostPath: first, containerPath: '/mnt/ro/first' },
      { hostPath: second, containerPath: '/mnt/ro/second' },
    ];
    expect(resumed.readonlyMounts).toEqual(expected);
    expect(resumed.systemPromptAugmentation).toContain('`/mnt/ro/second`');
    expect(loadSessionMetadata(sessionId)?.readonlyMounts).toEqual(expected);

    // A later resume without additions keeps both.
    const again = buildSessionConfig(createTestConfig(), sessionId, createSessionId(), {
      mode: DOCKER_MODE,
      resumeSessionId: sessionId,
    });
    expect(again.readonlyMounts).toEqual(expected);
  });

  it('rejects an unsafe folder added on resume', () => {
    const sessionId = createSessionId();
    buildSessionConfig(createTestConfig(), sessionId, sessionId, { mode: DOCKER_MODE });
    loggerModule.teardown();
    // TEST_ROOT contains the IronCurtain home used by these tests.
    expect(() =>
      buildSessionConfig(createTestConfig(), sessionId, createSessionId(), {
        mode: DOCKER_MODE,
        resumeSessionId: sessionId,
        readonlyMounts: [TEST_ROOT],
      }),
    ).toThrow(/IronCurtain credentials or state/);
  });

  it('rejects an unsafe path at the session boundary', () => {
    const sessionId = createSessionId();
    expect(() =>
      buildSessionConfig(createTestConfig(), sessionId, sessionId, { mode: DOCKER_MODE, readonlyMounts: ['/dev'] }),
    ).toThrow(/system directory/);
  });

  it('ignores mounts outside Docker Agent Mode', () => {
    const sessionId = createSessionId();
    const result = buildSessionConfig(createTestConfig(), sessionId, sessionId, {
      readonlyMounts: [TEST_ROOT],
    });
    expect(result.readonlyMounts).toEqual([]);
    expect(loadSessionMetadata(sessionId)?.readonlyMounts).toBeUndefined();
  });
});
