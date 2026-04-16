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
} from '../src/workflow/discovery.js';

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

function writeWorkflowYaml(dir: string, name: string, description: string, ext = '.yaml'): string {
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `${name}${ext}`);
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
// parseDefinitionFile
// ---------------------------------------------------------------------------

describe('parseDefinitionFile', () => {
  it('parses a JSON file', () => {
    const dir = resolve(tempDir, 'parse-test');
    const filePath = writeWorkflowJson(dir, 'test', 'A JSON workflow');
    const result = parseDefinitionFile(filePath) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.description).toBe('A JSON workflow');
  });

  it('parses a .yaml file', () => {
    const dir = resolve(tempDir, 'parse-test');
    const filePath = writeWorkflowYaml(dir, 'test', 'A YAML workflow', '.yaml');
    const result = parseDefinitionFile(filePath) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.description).toBe('A YAML workflow');
  });

  it('parses a .yml file', () => {
    const dir = resolve(tempDir, 'parse-test');
    const filePath = writeWorkflowYaml(dir, 'test', 'A YML workflow', '.yml');
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

  it('throws for invalid JSON', () => {
    const dir = resolve(tempDir, 'parse-test');
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, 'bad.json');
    writeFileSync(filePath, '{ invalid json');
    expect(() => parseDefinitionFile(filePath)).toThrow();
  });

  it('throws for non-existent file', () => {
    expect(() => parseDefinitionFile('/tmp/no-such-file.yaml')).toThrow();
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
    writeWorkflowJson(userDir, 'design-and-code', 'User override');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const entry = entries.find((e) => e.name === 'design-and-code');
      expect(entry?.source).toBe('user');
      expect(entry?.description).toBe('User override');
    });
  });

  it('returns entries sorted alphabetically', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'zebra-flow', 'Z');
    writeWorkflowJson(userDir, 'alpha-flow', 'A');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const names = entries.map((e) => e.name);
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });

  it('skips non-workflow files', () => {
    const userDir = resolve(tempDir, 'workflows');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(resolve(userDir, 'readme.md'), '# Not a workflow');
    writeWorkflowJson(userDir, 'valid', 'Valid workflow');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const userEntries = entries.filter((e) => e.source === 'user');
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0].name).toBe('valid');
    });
  });

  it('discovers YAML workflow files', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowYaml(userDir, 'yaml-flow', 'A YAML workflow');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const yamlEntry = entries.find((e) => e.name === 'yaml-flow');
      expect(yamlEntry).toBeDefined();
      expect(yamlEntry?.source).toBe('user');
      expect(yamlEntry?.description).toBe('A YAML workflow');
      expect(yamlEntry?.path).toMatch(/\.yaml$/);
    });
  });

  it('discovers .yml workflow files', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowYaml(userDir, 'yml-flow', 'A YML workflow', '.yml');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const ymlEntry = entries.find((e) => e.name === 'yml-flow');
      expect(ymlEntry).toBeDefined();
      expect(ymlEntry?.description).toBe('A YML workflow');
    });
  });

  it('YAML takes precedence over JSON when same name exists', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'dual-format', 'JSON version');
    writeWorkflowYaml(userDir, 'dual-format', 'YAML version');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const entry = entries.find((e) => e.name === 'dual-format');
      expect(entry).toBeDefined();
      expect(entry?.description).toBe('YAML version');
      expect(entry?.path).toMatch(/\.yaml$/);
    });
  });

  it('discovers mixed format workflows', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'json-only', 'JSON workflow');
    writeWorkflowYaml(userDir, 'yaml-only', 'YAML workflow');

    withTempHome(() => {
      const entries = discoverWorkflows();
      const jsonEntry = entries.find((e) => e.name === 'json-only');
      const yamlEntry = entries.find((e) => e.name === 'yaml-only');
      expect(jsonEntry).toBeDefined();
      expect(yamlEntry).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkflowPath
// ---------------------------------------------------------------------------

describe('resolveWorkflowPath', () => {
  it('resolves an explicit JSON file path', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowJson(userDir, 'test-wf', 'Test');

    const result = resolveWorkflowPath(filePath);
    expect(result).toBe(filePath);
  });

  it('resolves an explicit YAML file path', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowYaml(userDir, 'test-wf', 'Test', '.yaml');

    const result = resolveWorkflowPath(filePath);
    expect(result).toBe(filePath);
  });

  it('resolves an explicit .yml file path', () => {
    const userDir = resolve(tempDir, 'workflows');
    const filePath = writeWorkflowYaml(userDir, 'test-wf', 'Test', '.yml');

    const result = resolveWorkflowPath(filePath);
    expect(result).toBe(filePath);
  });

  it('resolves a workflow by name from bundled directory', () => {
    const result = resolveWorkflowPath('design-and-code');
    expect(result).toBeDefined();
    expect(result).toMatch(/design-and-code\.yaml$/);
  });

  it('prefers user directory over bundled for name resolution', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'design-and-code', 'User version');

    withTempHome(() => {
      const result = resolveWorkflowPath('design-and-code');
      // User dir is checked first across all extensions before bundled dir
      expect(result).toBeDefined();
      expect(result).toMatch(/\.json$/);
      expect(result).toContain(tempDir);
    });
  });

  it('prefers YAML over JSON in same directory for name resolution', () => {
    const userDir = resolve(tempDir, 'workflows');
    writeWorkflowJson(userDir, 'my-flow', 'JSON version');
    writeWorkflowYaml(userDir, 'my-flow', 'YAML version');

    withTempHome(() => {
      const result = resolveWorkflowPath('my-flow');
      expect(result).toBeDefined();
      expect(result).toMatch(/\.yaml$/);
    });
  });

  it('returns undefined for non-existent workflow name', () => {
    const result = resolveWorkflowPath('does-not-exist');
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent file path', () => {
    const result = resolveWorkflowPath('/tmp/no-such-file.json');
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent YAML file path', () => {
    const result = resolveWorkflowPath('/tmp/no-such-file.yaml');
    expect(result).toBeUndefined();
  });
});
