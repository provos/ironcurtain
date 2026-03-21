import { describe, it, expect } from 'vitest';
import { validateScenarioArgs, filterInvalidSchemaScenarios } from '../src/pipeline/scenario-schema-validator.js';
import type { StoredToolAnnotation, TestScenario } from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const gitBranchAnnotation: StoredToolAnnotation = {
  toolName: 'git_branch',
  serverName: 'git',
  comment: 'Manage git branches',
  args: {
    path: ['read-path'],
    operation: ['none'],
    branch_name: ['none'],
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Repository path' },
      operation: {
        type: 'string',
        enum: ['list', 'create', 'delete'],
        description: 'Branch operation',
      },
      branch_name: { type: 'string', description: 'Name of the branch' },
    },
    required: ['path', 'operation'],
  },
};

const readFileAnnotation: StoredToolAnnotation = {
  toolName: 'read_file',
  serverName: 'filesystem',
  comment: 'Reads a file',
  args: { path: ['read-path'] },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
};

const noSchemaAnnotation: StoredToolAnnotation = {
  toolName: 'custom_tool',
  serverName: 'custom',
  comment: 'A tool without inputSchema',
  args: { arg1: ['none'] },
};

const annotations = [gitBranchAnnotation, readFileAnnotation, noSchemaAnnotation];

function makeScenario(serverName: string, toolName: string, args: Record<string, unknown>): TestScenario {
  return {
    description: `Test ${toolName}`,
    request: { serverName, toolName, arguments: args },
    expectedDecision: 'allow',
    reasoning: 'test',
    source: 'generated',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateScenarioArgs', () => {
  it('returns no errors for a valid scenario', () => {
    const scenario = makeScenario('git', 'git_branch', {
      path: '/repo',
      operation: 'list',
    });
    const errors = validateScenarioArgs(scenario, annotations);
    expect(errors).toEqual([]);
  });

  it('returns no errors when all optional and required args are present', () => {
    const scenario = makeScenario('git', 'git_branch', {
      path: '/repo',
      operation: 'create',
      branch_name: 'feature-x',
    });
    const errors = validateScenarioArgs(scenario, annotations);
    expect(errors).toEqual([]);
  });

  it('detects unknown argument names', () => {
    const scenario = makeScenario('git', 'git_branch', {
      path: '/repo',
      operation: 'list',
      verbose: true, // not in schema
    });
    const errors = validateScenarioArgs(scenario, annotations);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('unknown argument "verbose"');
  });

  it('detects missing required fields', () => {
    const scenario = makeScenario('git', 'git_branch', {
      branch_name: 'feature-x',
      // missing both "path" and "operation"
    });
    const errors = validateScenarioArgs(scenario, annotations);
    const messages = errors.map((e) => e.message);
    expect(messages).toContainEqual(expect.stringContaining('missing required argument "path"'));
    expect(messages).toContainEqual(expect.stringContaining('missing required argument "operation"'));
  });

  it('detects invalid enum values', () => {
    const scenario = makeScenario('git', 'git_branch', {
      path: '/repo',
      operation: 'rename', // not in enum
    });
    const errors = validateScenarioArgs(scenario, annotations);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('invalid value "rename"');
    expect(errors[0].message).toContain('"list"');
    expect(errors[0].message).toContain('"create"');
    expect(errors[0].message).toContain('"delete"');
  });

  it('reports multiple errors at once', () => {
    const scenario = makeScenario('git', 'git_branch', {
      mode: 'rename', // unknown arg + missing required
    });
    const errors = validateScenarioArgs(scenario, annotations);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const messages = errors.map((e) => e.message);
    expect(messages).toContainEqual(expect.stringContaining('unknown argument "mode"'));
    expect(messages).toContainEqual(expect.stringContaining('missing required argument'));
  });

  it('skips validation when tool is not found in annotations', () => {
    const scenario = makeScenario('unknown-server', 'unknown_tool', {
      anything: 'goes',
    });
    const errors = validateScenarioArgs(scenario, annotations);
    expect(errors).toEqual([]);
  });

  it('skips validation when annotation has no inputSchema', () => {
    const scenario = makeScenario('custom', 'custom_tool', {
      bogus_arg: 'value',
    });
    const errors = validateScenarioArgs(scenario, annotations);
    expect(errors).toEqual([]);
  });

  it('skips validation when inputSchema has no properties', () => {
    const annotationsWithEmpty: StoredToolAnnotation[] = [
      {
        toolName: 'bare_tool',
        serverName: 'bare',
        comment: 'Minimal',
        args: {},
        inputSchema: { type: 'object' },
      },
    ];
    const scenario = makeScenario('bare', 'bare_tool', { x: 1 });
    const errors = validateScenarioArgs(scenario, annotationsWithEmpty);
    expect(errors).toEqual([]);
  });
});

describe('filterInvalidSchemaScenarios', () => {
  it('keeps valid scenarios and discards invalid ones', () => {
    const valid = makeScenario('git', 'git_branch', {
      path: '/repo',
      operation: 'list',
    });
    const invalid = makeScenario('git', 'git_branch', {
      path: '/repo',
      mode: 'list', // wrong arg name
    });
    const result = filterInvalidSchemaScenarios([valid, invalid], annotations);
    expect(result.valid).toHaveLength(1);
    expect(result.valid[0]).toBe(valid);
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0].scenario).toBe(invalid);
    expect(result.discarded[0].rule).toContain('invalid-schema');
    expect(result.discarded[0].rule).toContain('unknown argument "mode"');
  });

  it('keeps all scenarios when none are invalid', () => {
    const s1 = makeScenario('filesystem', 'read_file', { path: '/tmp/foo' });
    const s2 = makeScenario('git', 'git_branch', { path: '/repo', operation: 'create' });
    const result = filterInvalidSchemaScenarios([s1, s2], annotations);
    expect(result.valid).toHaveLength(2);
    expect(result.discarded).toHaveLength(0);
  });

  it('keeps scenarios for tools without inputSchema', () => {
    const scenario = makeScenario('custom', 'custom_tool', { bogus: 1 });
    const result = filterInvalidSchemaScenarios([scenario], annotations);
    expect(result.valid).toHaveLength(1);
    expect(result.discarded).toHaveLength(0);
  });
});
