/**
 * Unit tests for the headless persona service (Phase 1a).
 *
 * Exercises every fs effect against a temp IRONCURTAIN_HOME, verifying the
 * service preserves the CLI's observable behavior: persona.json content
 * (servers/memory omission conventions), constitution.md content, whole-tree
 * atomic create with rollback, stale detection, hard delete, and listing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Controllable renameSync wrapper for the rollback test. When `failOn` is set,
// renaming TO that exact (resolved) path throws; all other renames pass through.
// This is needed because Node's ESM `node:fs` namespace cannot be spied on.
const renameControl: { failOn: string | null } = { failOn: null };
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (renameControl.failOn && resolve(to) === renameControl.failOn) {
        throw new Error('boom');
      }
      actual.renameSync(from, to);
    },
  };
});

import {
  createPersona,
  deletePersona,
  getPersonaDetail,
  listPersonas,
  setPersonaConstitution,
  setPersonaMemory,
} from '../src/persona/persona-service.js';
import { createPersonaName } from '../src/persona/types.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-service-test-${process.pid}`);

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

function readPersonaJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(personaDir(name), 'persona.json'), 'utf-8'));
}

/** Writes a compiled-policy.json fixture for stale-detection / detail tests. */
function writeCompiledPolicy(name: string, opts: { rules?: unknown[]; constitutionHash?: string } = {}): void {
  const generatedDir = resolve(personaDir(name), 'generated');
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    resolve(generatedDir, 'compiled-policy.json'),
    JSON.stringify({
      rules: opts.rules ?? [],
      ...(opts.constitutionHash ? { constitutionHash: opts.constitutionHash } : {}),
    }),
  );
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// createPersona
// ---------------------------------------------------------------------------

describe('createPersona', () => {
  it('creates the full directory tree and persona.json (memory key omitted by default)', () => {
    const detail = createPersona({ name: 'coder', description: '  Build software  ' }, 'cli');

    const dir = personaDir('coder');
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(resolve(dir, 'generated'))).toBe(true);
    expect(existsSync(resolve(dir, 'workspace'))).toBe(true);
    expect(existsSync(resolve(dir, 'persona.json'))).toBe(true);
    expect(existsSync(resolve(dir, 'constitution.md'))).toBe(true);

    const json = readPersonaJson('coder');
    expect(json.name).toBe('coder');
    expect(json.description).toBe('Build software'); // trimmed
    expect(typeof json.createdAt).toBe('string');
    expect('memory' in json).toBe(false); // default-on => omit
    expect('servers' in json).toBe(false);

    expect(detail.name).toBe('coder');
    expect(detail.description).toBe('Build software');
    expect(detail.memory).toBe(true);
  });

  it('memoryEnabled:false writes memory:{enabled:false}', () => {
    createPersona({ name: 'p', description: 'd', memoryEnabled: false }, 'cli');
    expect(readPersonaJson('p').memory).toEqual({ enabled: false });
  });

  it('memoryEnabled:true omits the memory key', () => {
    createPersona({ name: 'p', description: 'd', memoryEnabled: true }, 'cli');
    expect('memory' in readPersonaJson('p')).toBe(false);
  });

  it('empty servers array omits the servers key', () => {
    createPersona({ name: 'p', description: 'd', servers: [] }, 'cli');
    expect('servers' in readPersonaJson('p')).toBe(false);
  });

  it('partial server list is persisted', () => {
    createPersona({ name: 'p', description: 'd', servers: ['filesystem', 'git'] }, 'cli');
    expect(readPersonaJson('p').servers).toEqual(['filesystem', 'git']);
  });

  it('empty constitution writes an empty constitution.md', () => {
    createPersona({ name: 'p', description: 'd' }, 'cli');
    expect(readFileSync(resolve(personaDir('p'), 'constitution.md'), 'utf-8')).toBe('');
  });

  it('non-empty constitution writes text + trailing newline', () => {
    createPersona({ name: 'p', description: 'd', constitution: 'Do no harm.' }, 'cli');
    expect(readFileSync(resolve(personaDir('p'), 'constitution.md'), 'utf-8')).toBe('Do no harm.\n');
  });

  it('throws PERSONA_EXISTS on duplicate name', () => {
    createPersona({ name: 'p', description: 'd' }, 'cli');
    expect(() => createPersona({ name: 'p', description: 'd' }, 'cli')).toThrowError(/already exists/);
    try {
      createPersona({ name: 'p', description: 'd' }, 'cli');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('PERSONA_EXISTS');
    }
  });

  it('rejects an invalid slug before creating any directory', () => {
    expect(() => createPersona({ name: '../evil', description: 'd' }, 'cli')).toThrow();
    // No temp dirs leaked into the personas directory.
    const personasDir = resolve(TEST_HOME, 'personas');
    if (existsSync(personasDir)) {
      expect(readdirSync(personasDir)).toHaveLength(0);
    }
  });

  it('rolls back the temp dir and leaves no persona when the final rename fails', () => {
    // Fail only the final tmp-dir -> personas/<name> rename; the internal
    // *.tmp -> file atomic writes still succeed.
    renameControl.failOn = personaDir('p');
    try {
      expect(() => createPersona({ name: 'p', description: 'd' }, 'cli')).toThrowError(/boom/);
    } finally {
      renameControl.failOn = null;
    }

    expect(existsSync(personaDir('p'))).toBe(false);
    // No leftover temp directory.
    const personasDir = resolve(TEST_HOME, 'personas');
    const leftovers = existsSync(personasDir) ? readdirSync(personasDir) : [];
    expect(leftovers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// setPersonaConstitution
// ---------------------------------------------------------------------------

describe('setPersonaConstitution', () => {
  beforeEach(() => {
    createPersona({ name: 'p', description: 'd' }, 'cli');
  });

  it('writes constitution.md with text + trailing newline', () => {
    setPersonaConstitution(createPersonaName('p'), 'New rules', 'cli');
    expect(readFileSync(resolve(personaDir('p'), 'constitution.md'), 'utf-8')).toBe('New rules\n');
  });

  it('empty text writes an empty file (no trailing newline)', () => {
    setPersonaConstitution(createPersonaName('p'), '', 'cli');
    expect(readFileSync(resolve(personaDir('p'), 'constitution.md'), 'utf-8')).toBe('');
  });

  it('throws PERSONA_NOT_FOUND for a missing persona', () => {
    try {
      setPersonaConstitution(createPersonaName('missing'), 'x', 'cli');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('PERSONA_NOT_FOUND');
    }
  });

  it('returns stale:true when there is no compiled policy', () => {
    expect(setPersonaConstitution(createPersonaName('p'), 'x', 'cli')).toEqual({ stale: true });
  });

  it('returns stale:false when the compiled hash matches the new file content', () => {
    // The pipeline hashes the verbatim file content (text + "\n").
    const fileContent = 'matching\n';
    const hash = createHash('sha256').update(fileContent).digest('hex');
    writeCompiledPolicy('p', { constitutionHash: hash });
    expect(setPersonaConstitution(createPersonaName('p'), 'matching', 'cli')).toEqual({ stale: false });
  });

  it('returns stale:true when the compiled hash differs', () => {
    writeCompiledPolicy('p', { constitutionHash: 'deadbeef' });
    expect(setPersonaConstitution(createPersonaName('p'), 'changed', 'cli')).toEqual({ stale: true });
  });
});

// ---------------------------------------------------------------------------
// setPersonaMemory
// ---------------------------------------------------------------------------

describe('setPersonaMemory', () => {
  it('disable attaches memory:{enabled:false}', () => {
    createPersona({ name: 'p', description: 'd' }, 'cli');
    setPersonaMemory(createPersonaName('p'), false, 'cli');
    expect(readPersonaJson('p').memory).toEqual({ enabled: false });
  });

  it('enable drops the memory key entirely', () => {
    createPersona({ name: 'p', description: 'd', memoryEnabled: false }, 'cli');
    expect(readPersonaJson('p').memory).toEqual({ enabled: false });
    setPersonaMemory(createPersonaName('p'), true, 'cli');
    expect('memory' in readPersonaJson('p')).toBe(false);
  });

  it('throws for a missing persona', () => {
    expect(() => setPersonaMemory(createPersonaName('missing'), false, 'cli')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deletePersona
// ---------------------------------------------------------------------------

describe('deletePersona', () => {
  it('hard-removes the persona directory recursively', () => {
    createPersona({ name: 'p', description: 'd', constitution: 'x' }, 'cli');
    expect(existsSync(personaDir('p'))).toBe(true);
    deletePersona(createPersonaName('p'), 'cli');
    expect(existsSync(personaDir('p'))).toBe(false);
  });

  it('throws PERSONA_NOT_FOUND for a missing persona', () => {
    try {
      deletePersona(createPersonaName('missing'), 'cli');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('PERSONA_NOT_FOUND');
    }
  });
});

// ---------------------------------------------------------------------------
// getPersonaDetail
// ---------------------------------------------------------------------------

describe('getPersonaDetail', () => {
  it('returns full detail including constitution and rule count', () => {
    createPersona({ name: 'p', description: 'My persona', constitution: 'Be good.' }, 'cli');
    writeCompiledPolicy('p', { rules: [{ a: 1 }, { b: 2 }] });

    const detail = getPersonaDetail(createPersonaName('p'));
    expect(detail.name).toBe('p');
    expect(detail.description).toBe('My persona');
    expect(detail.constitution).toBe('Be good.\n');
    expect(detail.hasPolicy).toBe(true);
    expect(detail.policyRuleCount).toBe(2);
    expect(detail.memory).toBe(true);
  });

  it('memory field reflects persona.memory?.enabled ?? true', () => {
    createPersona({ name: 'on', description: 'd' }, 'cli');
    createPersona({ name: 'off', description: 'd', memoryEnabled: false }, 'cli');
    expect(getPersonaDetail(createPersonaName('on')).memory).toBe(true);
    expect(getPersonaDetail(createPersonaName('off')).memory).toBe(false);
  });

  it('missing constitution.md yields empty constitution and no throw', () => {
    createPersona({ name: 'p', description: 'd' }, 'cli');
    rmSync(resolve(personaDir('p'), 'constitution.md'));
    const detail = getPersonaDetail(createPersonaName('p'));
    expect(detail.constitution).toBe('');
  });

  it('absent compiled policy => hasPolicy:false, policyRuleCount:undefined', () => {
    createPersona({ name: 'p', description: 'd' }, 'cli');
    const detail = getPersonaDetail(createPersonaName('p'));
    expect(detail.hasPolicy).toBe(false);
    expect(detail.policyRuleCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listPersonas
// ---------------------------------------------------------------------------

describe('listPersonas', () => {
  it('returns an empty array when no personas exist', () => {
    expect(listPersonas()).toEqual([]);
  });

  it('returns alphabetically sorted name/description/compiled rows', () => {
    createPersona({ name: 'zebra', description: 'Z persona', constitution: 'x' }, 'cli');
    createPersona({ name: 'alpha', description: 'A persona' }, 'cli');
    writeCompiledPolicy('alpha', { rules: [] });

    const list = listPersonas();
    expect(list.map((p) => p.name)).toEqual(['alpha', 'zebra']);
    expect(list[0]).toEqual({ name: 'alpha', description: 'A persona', compiled: true });
    expect(list[1]).toEqual({ name: 'zebra', description: 'Z persona', compiled: false });
  });

  it('skips directories with invalid slugs', () => {
    createPersona({ name: 'valid', description: 'd' }, 'cli');
    mkdirSync(resolve(TEST_HOME, 'personas', 'NOT VALID'), { recursive: true });
    expect(listPersonas().map((p) => p.name)).toEqual(['valid']);
  });
});
