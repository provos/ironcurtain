/**
 * Tests for workflow definition discovery and resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverWorkflows, resolveWorkflowPath, getBundledWorkflowsDir } from '../src/workflow/discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function createTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ironcurtain-wf-test-'));
}

function writeWorkflowJson(dir: string, name: string, description: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `${name}.json`);
  writeFileSync(filePath, JSON.stringify({ name, description, initial: 'start', states: {} }));
  return filePath;
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getBundledWorkflowsDir
// ---------------------------------------------------------------------------

describe('getBundledWorkflowsDir', () => {
  it('returns a path ending with workflows/', () => {
    const dir = getBundledWorkflowsDir();
    expect(dir).toMatch(/workflows$/);
  });
});

// ---------------------------------------------------------------------------
// discoverWorkflows
// ---------------------------------------------------------------------------

describe('discoverWorkflows', () => {
  it('finds bundled workflows', () => {
    const entries = discoverWorkflows();
    const names = entries.map((e) => e.name);
    expect(names).toContain('design-and-code');
    const entry = entries.find((e) => e.name === 'design-and-code');
    expect(entry?.source).toBe('bundled');
    expect(entry?.description).toBeTruthy();
  });

  it('finds user workflows when directory exists', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'my-custom', 'A custom workflow');

    // Point IRONCURTAIN_HOME to our temp dir so getUserWorkflowsDir() picks it up
    const original = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tempDir;
    try {
      const entries = discoverWorkflows();
      const custom = entries.find((e) => e.name === 'my-custom');
      expect(custom).toBeDefined();
      expect(custom?.source).toBe('user');
      expect(custom?.description).toBe('A custom workflow');
    } finally {
      if (original === undefined) {
        delete process.env.IRONCURTAIN_HOME;
      } else {
        process.env.IRONCURTAIN_HOME = original;
      }
    }
  });

  it('user workflows override bundled on name collision', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'design-and-code', 'User override');

    const original = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tempDir;
    try {
      const entries = discoverWorkflows();
      const entry = entries.find((e) => e.name === 'design-and-code');
      expect(entry?.source).toBe('user');
      expect(entry?.description).toBe('User override');
    } finally {
      if (original === undefined) {
        delete process.env.IRONCURTAIN_HOME;
      } else {
        process.env.IRONCURTAIN_HOME = original;
      }
    }
  });

  it('returns entries sorted alphabetically', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'zebra-flow', 'Z');
    writeWorkflowJson(userDir, 'alpha-flow', 'A');

    const original = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tempDir;
    try {
      const entries = discoverWorkflows();
      const names = entries.map((e) => e.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    } finally {
      if (original === undefined) {
        delete process.env.IRONCURTAIN_HOME;
      } else {
        process.env.IRONCURTAIN_HOME = original;
      }
    }
  });

  it('skips non-JSON files', () => {
    const userDir = resolve(tempDir, 'workflows');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(resolve(userDir, 'readme.md'), '# Not a workflow');
    writeWorkflowJson(userDir, 'valid', 'Valid workflow');

    const original = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tempDir;
    try {
      const entries = discoverWorkflows();
      const userEntries = entries.filter((e) => e.source === 'user');
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0].name).toBe('valid');
    } finally {
      if (original === undefined) {
        delete process.env.IRONCURTAIN_HOME;
      } else {
        process.env.IRONCURTAIN_HOME = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// resolveWorkflowPath
// ---------------------------------------------------------------------------

describe('resolveWorkflowPath', () => {
  it('resolves an explicit file path', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowJson(userDir, 'test-wf', 'Test');

    const result = resolveWorkflowPath(filePath);
    expect(result).toBe(filePath);
  });

  it('resolves a workflow by name from bundled directory', () => {
    const result = resolveWorkflowPath('design-and-code');
    expect(result).toBeDefined();
    expect(result).toMatch(/design-and-code\.json$/);
  });

  it('prefers user directory over bundled for name resolution', () => {
    const userDir = resolve(tempDir, 'workflows');
    const userPath = writeWorkflowJson(userDir, 'design-and-code', 'User version');

    const original = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tempDir;
    try {
      const result = resolveWorkflowPath('design-and-code');
      expect(result).toBe(userPath);
    } finally {
      if (original === undefined) {
        delete process.env.IRONCURTAIN_HOME;
      } else {
        process.env.IRONCURTAIN_HOME = original;
      }
    }
  });

  it('returns undefined for non-existent workflow name', () => {
    const result = resolveWorkflowPath('does-not-exist');
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent file path', () => {
    const result = resolveWorkflowPath('/tmp/no-such-file.json');
    expect(result).toBeUndefined();
  });
});
