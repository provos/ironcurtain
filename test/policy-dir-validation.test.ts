/**
 * Tests for policyDir containment validation in createSession().
 *
 * Verifies that policyDir must resolve to a location under the
 * IronCurtain home directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_HOME = resolve(`/tmp/ironcurtain-policydir-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
  mkdirSync(resolve(TEST_HOME, 'jobs/test-job/generated'), { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
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
    const { SessionError } = await import('../src/session/errors.js');
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
    ).rejects.toThrow(/policyDir must be under the IronCurtain home directory/);
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
    ).rejects.toThrow(/policyDir must be under the IronCurtain home directory/);
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
      ).rejects.toThrow(/policyDir must be under the IronCurtain home directory/);
    } finally {
      rmSync(evilDir, { recursive: true, force: true });
    }
  });

  it('accepts policyDir under IronCurtain home', async () => {
    // This test verifies that a valid policyDir passes the validation
    // (it will fail later during session init, but the policyDir check passes)
    const { createSession } = await import('../src/session/index.js');
    const config = (await import('../src/config/index.js')).loadConfig();

    const validPolicyDir = resolve(TEST_HOME, 'jobs/test-job/generated');

    // The session will fail for other reasons (no MCP servers, etc),
    // but NOT because of policyDir validation.
    try {
      await createSession({
        config,
        policyDir: validPolicyDir,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Should NOT contain the policyDir validation error
      expect(message).not.toContain('policyDir must be under');
    }
  });
});
