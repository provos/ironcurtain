/**
 * Tests for workflow definition discovery and resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverWorkflows,
  resolveWorkflowPath,
  getBundledWorkflowsDir,
  parseDefinitionFile,
  getWorkflowPackageDir,
} from '../src/workflow/discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function createTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ironcurtain-wf-test-'));
}

/**
 * Writes a workflow package directory `<rootDir>/<name>/workflow.<ext>`
 * with a minimal valid manifest. Returns the absolute path to the
 * manifest file.
 */
function writeWorkflowPackage(
  rootDir: string,
  name: string,
  description: string,
  ext: 'yaml' | 'yml' = 'yaml',
): string {
  const packageDir = resolve(rootDir, name);
  mkdirSync(packageDir, { recursive: true });
  const filePath = resolve(packageDir, `workflow.${ext}`);
  const content = `name: ${name}\ndescription: "${description}"\ninitial: start\nstates: {}\n`;
  writeFileSync(filePath, content);
  return filePath;
}

/** Helper to run a test with IRONCURTAIN_HOME pointed at tempDir. */
function withTempHome<T>(fn: () => T): T {
  const original = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = tempDir;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = original;
    }
  }
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
// getWorkflowPackageDir
// ---------------------------------------------------------------------------

describe('getWorkflowPackageDir', () => {
  it('returns the directory containing the manifest', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowPackage(userDir, 'pkg-test', 'Test');
    expect(getWorkflowPackageDir(filePath)).toBe(resolve(userDir, 'pkg-test'));
  });
});

// ---------------------------------------------------------------------------
// parseDefinitionFile
// ---------------------------------------------------------------------------

describe('parseDefinitionFile', () => {
  it('parses a .yaml file', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowPackage(userDir, 'test', 'A YAML workflow', 'yaml');
    const result = parseDefinitionFile(filePath) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.description).toBe('A YAML workflow');
  });

  it('parses a .yml file', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowPackage(userDir, 'test', 'A YML workflow', 'yml');
    const result = parseDefinitionFile(filePath) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.description).toBe('A YML workflow');
  });

  it('parses YAML with multi-line literal blocks', () => {
    const dir = resolve(tempDir, 'parse-test');
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, 'multiline.yaml');
    writeFileSync(
      filePath,
      `name: multi
description: test
initial: start
states:
  start:
    type: agent
    description: Test state
    persona: global
    prompt: |
      Line one.
      Line two.
      Line three.
    inputs: []
    outputs: []
    transitions:
      - to: done
  done:
    type: terminal
    description: Done
`,
    );
    const result = parseDefinitionFile(filePath) as Record<string, unknown>;
    const states = result.states as Record<string, Record<string, unknown>>;
    expect(states.start.prompt).toContain('Line one.');
    expect(states.start.prompt).toContain('Line two.');
    expect(states.start.prompt).toContain('Line three.');
  });

  it('throws for invalid YAML', () => {
    const dir = resolve(tempDir, 'parse-test');
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, 'bad.yaml');
    writeFileSync(filePath, '\t- broken: : :');
    expect(() => parseDefinitionFile(filePath)).toThrow();
  });

  it('throws for non-existent file', () => {
    expect(() => parseDefinitionFile('/tmp/no-such-file.yaml')).toThrow();
  });

  it('parses internal JSON serialization (used by resume)', () => {
    // parseDefinitionFile keeps a JSON branch so the workflow-resume
    // path can re-load `<runDir>/definition.json` written at start
    // time. User-facing manifests are YAML-only — that's enforced by
    // the discovery layer, not here.
    const dir = resolve(tempDir, 'parse-test');
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, 'definition.json');
    writeFileSync(filePath, JSON.stringify({ name: 'resumed', description: '', initial: 'start', states: {} }));
    const result = parseDefinitionFile(filePath) as Record<string, unknown>;
    expect(result.name).toBe('resumed');
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
    writeWorkflowPackage(userDir, 'my-custom', 'A custom workflow');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const custom = entries.find((e) => e.name === 'my-custom');
      expect(custom).toBeDefined();
      expect(custom?.source).toBe('user');
      expect(custom?.description).toBe('A custom workflow');
    });
  });

  it('user workflows override bundled on name collision', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowPackage(userDir, 'design-and-code', 'User override');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const entry = entries.find((e) => e.name === 'design-and-code');
      expect(entry?.source).toBe('user');
      expect(entry?.description).toBe('User override');
    });
  });

  it('returns entries sorted alphabetically', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowPackage(userDir, 'zebra-flow', 'Z');
    writeWorkflowPackage(userDir, 'alpha-flow', 'A');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const names = entries.map((e) => e.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });

  it('skips directories without a manifest', () => {
    const userDir = resolve(tempDir, 'workflows');
    mkdirSync(resolve(userDir, 'nope'), { recursive: true });
    writeFileSync(resolve(userDir, 'nope', 'README.md'), '# not a manifest');
    writeWorkflowPackage(userDir, 'valid', 'Valid workflow');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const userEntries = entries.filter((e) => e.source === 'user');
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0].name).toBe('valid');
    });
  });

  it('skips loose files at the workflows root', () => {
    // Loose files (the legacy single-file form) should no longer be
    // picked up — the directory-only convention requires a package dir.
    const userDir = resolve(tempDir, 'workflows');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(resolve(userDir, 'orphan.yaml'), 'name: orphan\ninitial: start\nstates: {}\n');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const userEntries = entries.filter((e) => e.source === 'user');
      expect(userEntries).toHaveLength(0);
    });
  });

  it('discovers .yml manifests in package directories', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowPackage(userDir, 'yml-flow', 'A YML workflow', 'yml');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const ymlEntry = entries.find((e) => e.name === 'yml-flow');
      expect(ymlEntry).toBeDefined();
      expect(ymlEntry?.description).toBe('A YML workflow');
      expect(ymlEntry?.path).toMatch(/workflow\.yml$/);
    });
  });

  it('prefers workflow.yaml over workflow.yml when both exist', () => {
    const userDir = resolve(tempDir, 'workflows');
    const packageDir = resolve(userDir, 'dual');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      resolve(packageDir, 'workflow.yaml'),
      'name: dual\ndescription: "yaml form"\ninitial: start\nstates: {}\n',
    );
    writeFileSync(
      resolve(packageDir, 'workflow.yml'),
      'name: dual\ndescription: "yml form"\ninitial: start\nstates: {}\n',
    );

    withTempHome(() => {
      const entries = discoverWorkflows();
      const entry = entries.find((e) => e.name === 'dual');
      expect(entry?.path).toMatch(/workflow\.yaml$/);
      expect(entry?.description).toBe('yaml form');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkflowPath
// ---------------------------------------------------------------------------

describe('resolveWorkflowPath', () => {
  it('resolves an explicit YAML file path', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowPackage(userDir, 'test-wf', 'Test', 'yaml');

    const result = resolveWorkflowPath(filePath);
    expect(result).toBe(filePath);
  });

  it('resolves an explicit .yml file path', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowPackage(userDir, 'test-wf', 'Test', 'yml');

    const result = resolveWorkflowPath(filePath);
    expect(result).toBe(filePath);
  });

  it('resolves a workflow by name from bundled directory', () => {
    const result = resolveWorkflowPath('design-and-code');
    expect(result).toBeDefined();
    expect(result).toMatch(/design-and-code[\\/]workflow\.yaml$/);
  });

  it('prefers user directory over bundled for name resolution', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowPackage(userDir, 'design-and-code', 'User version');

    withTempHome(() => {
      const result = resolveWorkflowPath('design-and-code');
      expect(result).toBeDefined();
      expect(result).toContain(tempDir);
      expect(result).toMatch(/workflow\.yaml$/);
    });
  });

  it('returns undefined for non-existent workflow name', () => {
    const result = resolveWorkflowPath('does-not-exist');
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent YAML file path', () => {
    const result = resolveWorkflowPath('/tmp/no-such-file.yaml');
    expect(result).toBeUndefined();
  });

  it('resolves a path-style ref with no extension to the package manifest', () => {
    // `./<dir>` and `/abs/<dir>` (both have a separator, neither has an
    // extension) should be probed for `workflow.{yaml,yml}` inside.
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowPackage(userDir, 'pkg-style', 'Pkg style', 'yaml');
    const packageDir = resolve(userDir, 'pkg-style');

    const result = resolveWorkflowPath(packageDir);
    expect(result).toBe(filePath);
  });

  it('resolves a path-style ref with no extension via workflow.yml when only .yml exists', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowPackage(userDir, 'pkg-yml', 'Pkg YML', 'yml');
    const packageDir = resolve(userDir, 'pkg-yml');

    const result = resolveWorkflowPath(packageDir);
    expect(result).toBe(filePath);
  });

  it('returns undefined for a path-style ref with .json extension', () => {
    // JSON path-style refs are silently dropped — `definition.json` is
    // an internal serialization format produced by workflow-resume
    // checkpointing, not a manifest authors should reference.
    const dir = resolve(tempDir, 'json-ref');
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, 'flow.json');
    writeFileSync(filePath, JSON.stringify({ name: 'x', description: '', initial: 's', states: {} }));

    expect(resolveWorkflowPath(filePath)).toBeUndefined();
    // Relative form too.
    expect(resolveWorkflowPath('./flow.json')).toBeUndefined();
  });

  it('returns undefined for a path-style ref pointing at a directory without a manifest', () => {
    const empty = resolve(tempDir, 'empty-pkg');
    mkdirSync(empty, { recursive: true });
    expect(resolveWorkflowPath(empty)).toBeUndefined();
  });
});
