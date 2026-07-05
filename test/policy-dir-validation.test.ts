/**
 * Tests for policyDir containment validation in createSession().
 *
 * Verifies that policyDir must resolve to a location under the
 * IronCurtain home directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_HOME = resolve(`/tmp/ironcurtain-policydir-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
  mkdirSync(resolve(TEST_HOME, 'jobs/test-job/generated'), { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(async () => {
  // Some paths below initialize session logging before validation fails.
  // Tear it down explicitly so this file cannot leak process-level state into
  // the next Vitest file scheduled on the same worker.
  const logger = await import('../src/logger.js');
  logger.teardown();
  vi.doUnmock('ai');
  vi.doUnmock('@ai-sdk/anthropic');
  vi.resetModules();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// We test the validatePolicyDir logic indirectly through createSession,
// but we can also test the validation function directly by importing
// the module and checking the error path.

describe('policyDir containment validation', () => {
  it('rejects policyDir outside IronCurtain home', async () => {
    // Mock heavy session dependencies to isolate the validation check
    vi.doMock('ai', () => ({
      generateText: vi.fn(),
    }));
    vi.doMock('@ai-sdk/anthropic', () => ({
      anthropic: vi.fn(),
      createAnthropic: vi.fn(),
    }));

    const { createSession } = await import('../src/session/index.js');
    const { SessionError } = await import('../src/types/errors.js');
    const { loadConfig } = await import('../src/config/index.js');

    const config = loadConfig();

    await expect(
      createSession({
        config,
        policyDir: '/tmp/evil-policy',
      }),
    ).rejects.toThrow(SessionError);

    await expect(
      createSession({
        config,
        policyDir: '/tmp/evil-policy',
      }),
    ).rejects.toThrow(/policyDir must be under a trusted directory/);
  });

  it('rejects policyDir with path traversal', async () => {
    const { createSession } = await import('../src/session/index.js');

    const config = (await import('../src/config/index.js')).loadConfig();

    // Attempt traversal from inside the home directory
    await expect(
      createSession({
        config,
        policyDir: resolve(TEST_HOME, 'jobs/../../../etc'),
      }),
    ).rejects.toThrow(/policyDir must be under a trusted directory/);
  });

  it('rejects policyDir that is a prefix-match but not a subdirectory', async () => {
    const { createSession } = await import('../src/session/index.js');
    const config = (await import('../src/config/index.js')).loadConfig();

    // Create a directory that matches the prefix but is a sibling
    const evilDir = TEST_HOME + '-evil';
    mkdirSync(evilDir, { recursive: true });

    try {
      await expect(
        createSession({
          config,
          policyDir: evilDir,
        }),
      ).rejects.toThrow(/policyDir must be under a trusted directory/);
    } finally {
      rmSync(evilDir, { recursive: true, force: true });
    }
  });

  it('accepts policyDir under IronCurtain home', async () => {
    // Keep this as a config-building assertion instead of calling the full
    // createSession() happy path. The full path starts MCP proxy subprocesses;
    // this test only owns policyDir containment validation.
    const { buildSessionConfig } = await import('../src/session/index.js');
    const { createSessionId } = await import('../src/session/types.js');
    const config = (await import('../src/config/index.js')).loadConfig();

    const validPolicyDir = resolve(TEST_HOME, 'jobs/test-job/generated');
    const sessionId = createSessionId();

    const sessionConfig = buildSessionConfig(config, sessionId, sessionId, {
      policyDir: validPolicyDir,
    });

    expect(sessionConfig.config.generatedDir).toBe(realpathSync(validPolicyDir));
  });
});
