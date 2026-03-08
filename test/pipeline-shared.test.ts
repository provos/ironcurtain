/**
 * Tests for src/pipeline/pipeline-shared.ts
 *
 * Covers the pure utility functions and file I/O helpers:
 *   - computeHash: SHA-256 of one or more string inputs
 *   - loadExistingArtifact: JSON read with primary-then-fallback resolution
 *   - writeArtifact: JSON write with directory creation
 *   - loadToolAnnotationsFile: reads + resolves stored tool annotations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  computeHash,
  loadExistingArtifact,
  writeArtifact,
  loadToolAnnotationsFile,
} from '../src/pipeline/pipeline-shared.js';
import type { StoredToolAnnotationsFile, ToolAnnotationsFile } from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const TEST_ROOT = `/tmp/ironcurtain-pipeline-shared-test-${process.pid}`;

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = resolve(TEST_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// computeHash
// ---------------------------------------------------------------------------

describe('computeHash', () => {
  it('produces a hex string', () => {
    const hash = computeHash('hello');
    expect(typeof hash).toBe('string');
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it('produces a SHA-256 of the concatenated inputs', () => {
    const expected = createHash('sha256').update('hello').update('world').digest('hex');
    expect(computeHash('hello', 'world')).toBe(expected);
  });

  it('returns the same hash for the same inputs', () => {
    expect(computeHash('foo', 'bar')).toBe(computeHash('foo', 'bar'));
  });

  it('returns different hashes for different inputs', () => {
    expect(computeHash('abc')).not.toBe(computeHash('xyz'));
  });

  it('treats multiple args the same as a single concatenated string', () => {
    // computeHash('ab', 'c') === computeHash('a', 'bc') === computeHash('abc')
    // because it just calls hash.update() sequentially -- all equivalent
    const h1 = computeHash('abc');
    const h2 = computeHash('ab', 'c');
    const h3 = computeHash('a', 'bc');
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('handles empty string input', () => {
    const hash = computeHash('');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64);
  });

  it('handles a single input', () => {
    const expected = createHash('sha256').update('single').digest('hex');
    expect(computeHash('single')).toBe(expected);
  });

  it('handles multiple empty and non-empty inputs', () => {
    const h1 = computeHash('', 'data', '');
    const h2 = computeHash('data');
    // Empty strings contribute nothing, so these are equal
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// loadExistingArtifact
// ---------------------------------------------------------------------------

describe('loadExistingArtifact', () => {
  it('reads JSON from the primary directory', () => {
    const dir = tempDir('primary');
    writeFileSync(resolve(dir, 'artifact.json'), JSON.stringify({ key: 'value' }));

    const result = loadExistingArtifact<{ key: string }>(dir, 'artifact.json');
    expect(result).toEqual({ key: 'value' });
  });

  it('returns undefined when file is absent and no fallback', () => {
    const dir = tempDir('empty');
    const result = loadExistingArtifact(dir, 'missing.json');
    expect(result).toBeUndefined();
  });

  it('falls back to the fallback directory when primary is missing', () => {
    const primary = tempDir('primary-empty');
    const fallback = tempDir('fallback');
    writeFileSync(resolve(fallback, 'artifact.json'), JSON.stringify({ from: 'fallback' }));

    const result = loadExistingArtifact<{ from: string }>(primary, 'artifact.json', fallback);
    expect(result).toEqual({ from: 'fallback' });
  });

  it('prefers the primary directory over the fallback', () => {
    const primary = tempDir('primary-wins');
    const fallback = tempDir('fallback-secondary');
    writeFileSync(resolve(primary, 'artifact.json'), JSON.stringify({ source: 'primary' }));
    writeFileSync(resolve(fallback, 'artifact.json'), JSON.stringify({ source: 'fallback' }));

    const result = loadExistingArtifact<{ source: string }>(primary, 'artifact.json', fallback);
    expect(result).toEqual({ source: 'primary' });
  });

  it('returns undefined when both primary and fallback are missing', () => {
    const primary = tempDir('primary-absent');
    const fallback = tempDir('fallback-absent');
    const result = loadExistingArtifact(primary, 'no-such-file.json', fallback);
    expect(result).toBeUndefined();
  });

  it('returns undefined when the JSON file is corrupt', () => {
    const dir = tempDir('corrupt');
    writeFileSync(resolve(dir, 'bad.json'), 'not-valid-json{{{{');
    const result = loadExistingArtifact(dir, 'bad.json');
    expect(result).toBeUndefined();
  });

  it('falls back to the fallback directory when primary JSON is corrupt', () => {
    const primary = tempDir('primary-corrupt');
    const fallback = tempDir('fallback-good');
    writeFileSync(resolve(primary, 'data.json'), '{invalid');
    writeFileSync(resolve(fallback, 'data.json'), JSON.stringify({ ok: true }));

    const result = loadExistingArtifact<{ ok: boolean }>(primary, 'data.json', fallback);
    expect(result).toEqual({ ok: true });
  });

  it('handles arrays at the top level', () => {
    const dir = tempDir('array');
    writeFileSync(resolve(dir, 'list.json'), JSON.stringify([1, 2, 3]));

    const result = loadExistingArtifact<number[]>(dir, 'list.json');
    expect(result).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// writeArtifact
// ---------------------------------------------------------------------------

describe('writeArtifact', () => {
  it('writes JSON to a file in the given directory', () => {
    const dir = tempDir('write-basic');
    writeArtifact(dir, 'out.json', { hello: 'world' });

    const raw = readFileSync(resolve(dir, 'out.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
  });

  it('formats JSON with 2-space indentation and a trailing newline', () => {
    const dir = tempDir('write-format');
    writeArtifact(dir, 'formatted.json', { a: 1 });

    const raw = readFileSync(resolve(dir, 'formatted.json'), 'utf-8');
    expect(raw).toBe(JSON.stringify({ a: 1 }, null, 2) + '\n');
  });

  it('creates the output directory if it does not exist', () => {
    const dir = resolve(TEST_ROOT, 'new-dir-to-create', 'nested');
    // Do NOT pre-create the directory
    writeArtifact(dir, 'created.json', { created: true });

    const raw = readFileSync(resolve(dir, 'created.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ created: true });
  });

  it('overwrites an existing file', () => {
    const dir = tempDir('write-overwrite');
    writeArtifact(dir, 'data.json', { version: 1 });
    writeArtifact(dir, 'data.json', { version: 2 });

    const raw = readFileSync(resolve(dir, 'data.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ version: 2 });
  });

  it('round-trips through loadExistingArtifact', () => {
    const dir = tempDir('round-trip');
    const original = { items: ['a', 'b', 'c'], count: 3, active: true };
    writeArtifact(dir, 'round-trip.json', original);

    const loaded = loadExistingArtifact<typeof original>(dir, 'round-trip.json');
    expect(loaded).toEqual(original);
  });

  it('handles arrays at the top level', () => {
    const dir = tempDir('write-array');
    writeArtifact(dir, 'list.json', [10, 20, 30]);

    const raw = readFileSync(resolve(dir, 'list.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual([10, 20, 30]);
  });
});

// ---------------------------------------------------------------------------
// loadToolAnnotationsFile
// ---------------------------------------------------------------------------

/** Minimal StoredToolAnnotationsFile with static (non-conditional) args. */
function makeStoredAnnotations(): StoredToolAnnotationsFile {
  return {
    generatedAt: '2026-03-08T00:00:00.000Z',
    servers: {
      filesystem: {
        inputHash: 'abc123',
        tools: [
          {
            toolName: 'read_file',
            serverName: 'filesystem',
            comment: 'Reads a file',
            sideEffects: false,
            args: {
              path: ['read-path'],
            },
          },
          {
            toolName: 'write_file',
            serverName: 'filesystem',
            comment: 'Writes a file',
            sideEffects: true,
            args: {
              path: ['write-path'],
              content: ['none'],
            },
          },
        ],
      },
    },
  };
}

/** Minimal StoredToolAnnotationsFile with a conditional arg spec. */
function makeStoredAnnotationsWithConditional(): StoredToolAnnotationsFile {
  return {
    generatedAt: '2026-03-08T00:00:00.000Z',
    servers: {
      git: {
        inputHash: 'def456',
        tools: [
          {
            toolName: 'clone',
            serverName: 'git',
            comment: 'Clones a repo',
            sideEffects: true,
            args: {
              url: {
                default: ['git-remote-url'],
                when: [
                  {
                    condition: { arg: 'local', equals: true },
                    roles: ['read-path'],
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };
}

describe('loadToolAnnotationsFile', () => {
  it('returns undefined when the file is absent', () => {
    const dir = tempDir('annotations-absent');
    const result = loadToolAnnotationsFile(dir);
    expect(result).toBeUndefined();
  });

  it('returns undefined when both primary and fallback are absent', () => {
    const primary = tempDir('annotations-primary-absent');
    const fallback = tempDir('annotations-fallback-absent');
    const result = loadToolAnnotationsFile(primary, fallback);
    expect(result).toBeUndefined();
  });

  it('loads and returns a flat ToolAnnotationsFile for static specs', () => {
    const dir = tempDir('annotations-static');
    writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(makeStoredAnnotations()));

    const result = loadToolAnnotationsFile(dir);
    expect(result).toBeDefined();
    const expected: ToolAnnotationsFile = {
      generatedAt: '2026-03-08T00:00:00.000Z',
      servers: {
        filesystem: {
          inputHash: 'abc123',
          tools: [
            {
              toolName: 'read_file',
              serverName: 'filesystem',
              comment: 'Reads a file',
              sideEffects: false,
              args: { path: ['read-path'] },
            },
            {
              toolName: 'write_file',
              serverName: 'filesystem',
              comment: 'Writes a file',
              sideEffects: true,
              args: { path: ['write-path'], content: ['none'] },
            },
          ],
        },
      },
    };
    expect(result).toEqual(expected);
  });

  it('resolves conditional role specs to their default roles', () => {
    const dir = tempDir('annotations-conditional');
    writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(makeStoredAnnotationsWithConditional()));

    const result = loadToolAnnotationsFile(dir);
    expect(result).toBeDefined();
    // The conditional spec { default: ['git-remote-url'], when: [...] }
    // should be flattened to the default roles ['git-remote-url']
    const cloneTool = result!.servers['git'].tools[0];
    expect(cloneTool.args['url']).toEqual(['git-remote-url']);
  });

  it('falls back to the fallback directory', () => {
    const primary = tempDir('annotations-primary-empty');
    const fallback = tempDir('annotations-fallback-with-data');
    writeFileSync(resolve(fallback, 'tool-annotations.json'), JSON.stringify(makeStoredAnnotations()));

    const result = loadToolAnnotationsFile(primary, fallback);
    expect(result).toBeDefined();
    expect(Object.keys(result!.servers)).toEqual(['filesystem']);
  });

  it('preserves generatedAt and inputHash metadata', () => {
    const dir = tempDir('annotations-metadata');
    const stored = makeStoredAnnotations();
    writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(stored));

    const result = loadToolAnnotationsFile(dir);
    expect(result!.generatedAt).toBe('2026-03-08T00:00:00.000Z');
    expect(result!.servers['filesystem'].inputHash).toBe('abc123');
  });

  it('returns undefined when the JSON is corrupt', () => {
    const dir = tempDir('annotations-corrupt');
    writeFileSync(resolve(dir, 'tool-annotations.json'), '{not valid json');
    const result = loadToolAnnotationsFile(dir);
    expect(result).toBeUndefined();
  });
});
