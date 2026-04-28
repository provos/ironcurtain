/**
 * Tests for the memory-policy helpers.
 *
 * Covers the pure-data helper `isMemoryEnabledFor` (all precedence
 * branches) and the loader-aware wrapper
 * `isMemoryEnabledForPersonaName` (fail-closed when the persona file
 * is missing).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { isMemoryEnabledFor } from '../src/memory/memory-policy.js';
import { isMemoryEnabledForPersonaName } from '../src/persona/memory-gate.js';
import type { PersonaDefinition, PersonaName } from '../src/persona/types.js';
import type { JobDefinition, JobId } from '../src/cron/types.js';
import type { ResolvedUserConfig } from '../src/config/user-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ResolvedUserConfig with only the fields the gate reads. */
function makeUserConfig(memoryEnabled: boolean): ResolvedUserConfig {
  return {
    memory: {
      enabled: memoryEnabled,
      autoSave: false,
      llmBaseUrl: undefined,
      llmApiKey: undefined,
    },
  } as unknown as ResolvedUserConfig;
}

/** Build a minimal PersonaDefinition with optional memory override. */
function makePersona(memory?: { enabled: boolean }): PersonaDefinition {
  return {
    name: 'test-persona' as PersonaName,
    description: 'test',
    createdAt: '2026-04-27T00:00:00.000Z',
    ...(memory ? { memory } : {}),
  };
}

/** Build a minimal JobDefinition with optional memory override. */
function makeJob(memory?: { enabled: boolean }): JobDefinition {
  return {
    id: 'test-job' as JobId,
    name: 'test',
    schedule: '0 * * * *',
    taskDescription: 'test task',
    taskConstitution: 'test constitution',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...(memory ? { memory } : {}),
  };
}

// ---------------------------------------------------------------------------
// isMemoryEnabledFor — pure-data helper
// ---------------------------------------------------------------------------

describe('isMemoryEnabledFor', () => {
  it('returns false when global kill switch is off, even with persona set', () => {
    expect(
      isMemoryEnabledFor({
        persona: makePersona(),
        userConfig: makeUserConfig(false),
      }),
    ).toBe(false);
  });

  it('returns false when global kill switch is off, even with job set', () => {
    expect(
      isMemoryEnabledFor({
        job: makeJob(),
        userConfig: makeUserConfig(false),
      }),
    ).toBe(false);
  });

  it('returns false when neither persona nor job is set (default session)', () => {
    expect(isMemoryEnabledFor({ userConfig: makeUserConfig(true) })).toBe(false);
  });

  it('returns false when persona.memory.enabled is false', () => {
    expect(
      isMemoryEnabledFor({
        persona: makePersona({ enabled: false }),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(false);
  });

  it('returns false when job.memory.enabled is false', () => {
    expect(
      isMemoryEnabledFor({
        job: makeJob({ enabled: false }),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(false);
  });

  it('returns true when persona is set and persona.memory is absent', () => {
    expect(
      isMemoryEnabledFor({
        persona: makePersona(),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(true);
  });

  it('returns true when persona is set and persona.memory.enabled is true', () => {
    expect(
      isMemoryEnabledFor({
        persona: makePersona({ enabled: true }),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(true);
  });

  it('returns true when job is set and job.memory is absent', () => {
    expect(
      isMemoryEnabledFor({
        job: makeJob(),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(true);
  });

  it('returns true when both persona and job are set, neither opting out', () => {
    expect(
      isMemoryEnabledFor({
        persona: makePersona(),
        job: makeJob(),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(true);
  });

  it('returns false when both persona and job are set and either opts out', () => {
    // Persona opts out, job does not -> off (most-restrictive wins).
    expect(
      isMemoryEnabledFor({
        persona: makePersona({ enabled: false }),
        job: makeJob(),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(false);

    // Job opts out, persona does not -> off (most-restrictive wins).
    expect(
      isMemoryEnabledFor({
        persona: makePersona(),
        job: makeJob({ enabled: false }),
        userConfig: makeUserConfig(true),
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isMemoryEnabledForPersonaName — loader-aware wrapper, fail-closed
// ---------------------------------------------------------------------------

describe('isMemoryEnabledForPersonaName', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Point IRONCURTAIN_HOME at a fresh tmp dir so loadPersona reads
    // from a known location for these tests.
    tmpHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-memory-policy-test-'));
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns false when the persona file is missing (fail closed)', () => {
    const result = isMemoryEnabledForPersonaName('nonexistent-persona', makeUserConfig(true));
    expect(result).toBe(false);
  });

  it('returns false when the global kill switch is off (short-circuits load)', () => {
    // No persona on disk -> would normally fail closed, but the
    // global-kill-switch short-circuit means we never even attempt to
    // load. Either way the answer is false; this case asserts the
    // kill-switch precedence.
    expect(isMemoryEnabledForPersonaName('any-name', makeUserConfig(false))).toBe(false);
  });

  it('returns true for a valid persona without a memory field', () => {
    const personaName = 'happy-persona';
    const personaDir = resolve(tmpHome, 'personas', personaName);
    mkdirSync(personaDir, { recursive: true });
    const def: PersonaDefinition = {
      name: personaName as PersonaName,
      description: 'test',
      createdAt: '2026-04-27T00:00:00.000Z',
    };
    writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify(def));

    expect(isMemoryEnabledForPersonaName(personaName, makeUserConfig(true))).toBe(true);
  });

  it('returns false for a valid persona that opts out via memory.enabled = false', () => {
    const personaName = 'opt-out-persona';
    const personaDir = resolve(tmpHome, 'personas', personaName);
    mkdirSync(personaDir, { recursive: true });
    const def: PersonaDefinition = {
      name: personaName as PersonaName,
      description: 'test',
      createdAt: '2026-04-27T00:00:00.000Z',
      memory: { enabled: false },
    };
    writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify(def));

    expect(isMemoryEnabledForPersonaName(personaName, makeUserConfig(true))).toBe(false);
  });
});
