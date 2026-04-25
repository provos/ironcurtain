/**
 * Tests for `loadDefinition` in `src/workflow/definition-loader.ts`.
 *
 * Covers the three discriminated outcomes: ok (parse + validate succeed),
 * `kind: 'parse'` (file unreadable / malformed JSON-YAML), and
 * `kind: 'validate'` (parse succeeds but schema validation fails).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { loadDefinition } from '../src/workflow/definition-loader.js';

function writeJson(dir: string, filename: string, body: unknown): string {
  const filePath = resolve(dir, filename);
  writeFileSync(filePath, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf-8');
  return filePath;
}

describe('loadDefinition', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'def-loader-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok with the validated definition for a well-formed file', () => {
    const path = writeJson(tmpDir, 'good.json', {
      name: 'tiny-workflow',
      description: 'A trivially-valid single-state workflow',
      initial: 'done',
      states: {
        done: {
          type: 'terminal',
          description: 'all good',
        },
      },
    });

    const result = loadDefinition(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrow
    expect(result.definition.name).toBe('tiny-workflow');
    expect(result.definition.initial).toBe('done');
  });

  it('returns ok for valid YAML', () => {
    const yamlPath = resolve(tmpDir, 'good.yaml');
    writeFileSync(
      yamlPath,
      [
        'name: yaml-workflow',
        'description: yaml is fine too',
        'initial: done',
        'states:',
        '  done:',
        '    type: terminal',
        '    description: yaml terminal',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = loadDefinition(yamlPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.name).toBe('yaml-workflow');
  });

  it('returns kind: parse when the file is missing', () => {
    const result = loadDefinition(resolve(tmpDir, 'nope.json'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('parse');
    expect(result.message).toMatch(/ENOENT|no such file/i);
  });

  it('returns kind: parse when JSON is malformed', () => {
    const path = writeJson(tmpDir, 'broken.json', '{ this is not json');

    const result = loadDefinition(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('parse');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('returns kind: validate with issues when schema validation fails', () => {
    // Missing `initial` and `states` -- both required by the schema.
    const path = writeJson(tmpDir, 'invalid.json', { name: 'bad', description: 'no states' });

    const result = loadDefinition(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('validate');
    // Message preserves the historical wording so callers (CLI, daemon)
    // can re-render it without modification.
    expect(result.message).toMatch(/^Workflow validation failed:/);
    expect(result.issues).toBeDefined();
    expect((result.issues ?? []).length).toBeGreaterThan(0);
  });

  it('returns kind: validate when the initial state is missing from states', () => {
    // Schema-shaped but semantically invalid: `initial: nope` references
    // a state not in `states`.
    const path = writeJson(tmpDir, 'dangling.json', {
      name: 'dangling',
      description: 'initial points nowhere',
      initial: 'nope',
      states: {
        done: {
          type: 'terminal',
          description: 'unreachable',
        },
      },
    });

    const result = loadDefinition(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('validate');
  });
});
