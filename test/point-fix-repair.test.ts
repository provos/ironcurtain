import { describe, it, expect } from 'vitest';
import {
  applyRulePatch,
  buildPointFixRepairInstructions,
  buildPatchResponseSchema,
  mergeListDefinitions,
} from '../src/pipeline/constitution-compiler.js';
import type {
  CompiledRule,
  ExecutionResult,
  ListDefinition,
  RepairContext,
  RulePatchOp,
} from '../src/pipeline/types.js';
import { TEST_SANDBOX_DIR } from './fixtures/test-policy.js';

const baseRules: CompiledRule[] = [
  {
    name: 'allow-read-sandbox',
    description: 'Allow reading files in sandbox',
    principle: 'Containment',
    if: { paths: { roles: ['read-path'], within: TEST_SANDBOX_DIR } },
    then: 'allow',
    reason: 'Reads within sandbox are safe',
  },
  {
    name: 'escalate-write-sandbox',
    description: 'Escalate writes in sandbox',
    principle: 'Least privilege',
    if: { paths: { roles: ['write-path'], within: TEST_SANDBOX_DIR } },
    then: 'escalate',
    reason: 'Writes need approval',
  },
  {
    name: 'allow-introspection',
    description: 'Allow introspection tools',
    principle: 'Safety',
    if: { tool: ['list_allowed_directories'] },
    then: 'allow',
    reason: 'Pure query tool',
  },
];

// ---------------------------------------------------------------------------
// applyRulePatch
// ---------------------------------------------------------------------------

describe('applyRulePatch', () => {
  it('updates an existing rule by name', () => {
    const updatedRule: CompiledRule = {
      ...baseRules[1],
      then: 'allow',
      reason: 'Writes in sandbox are now allowed',
    };
    const ops: RulePatchOp[] = [{ op: 'update', ruleName: 'escalate-write-sandbox', rule: updatedRule }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(3);
      expect(result.rules[1].then).toBe('allow');
      expect(result.rules[1].reason).toBe('Writes in sandbox are now allowed');
      // Other rules unchanged
      expect(result.rules[0]).toEqual(baseRules[0]);
      expect(result.rules[2]).toEqual(baseRules[2]);
    }
  });

  it('returns error when updating nonexistent rule', () => {
    const ops: RulePatchOp[] = [{ op: 'update', ruleName: 'no-such-rule', rule: baseRules[0] }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('no-such-rule');
      expect(result.error).toContain('not found');
    }
  });

  it('adds a rule after a specified rule', () => {
    const newRule: CompiledRule = {
      name: 'allow-write-sandbox',
      description: 'Allow writes in sandbox',
      principle: 'Containment',
      if: { paths: { roles: ['write-path'], within: TEST_SANDBOX_DIR } },
      then: 'allow',
      reason: 'Sandbox writes are safe',
    };
    const ops: RulePatchOp[] = [{ op: 'add', afterRule: 'allow-read-sandbox', rule: newRule }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(4);
      expect(result.rules[0].name).toBe('allow-read-sandbox');
      expect(result.rules[1].name).toBe('allow-write-sandbox');
      expect(result.rules[2].name).toBe('escalate-write-sandbox');
      expect(result.rules[3].name).toBe('allow-introspection');
    }
  });

  it('prepends a rule when afterRule is omitted', () => {
    const newRule: CompiledRule = {
      name: 'deny-all-deletes',
      description: 'Deny all deletes',
      principle: 'Safety',
      if: { roles: ['delete-path'] },
      then: 'escalate',
      reason: 'Deletes need escalation',
    };
    const ops: RulePatchOp[] = [{ op: 'add', rule: newRule }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(4);
      expect(result.rules[0].name).toBe('deny-all-deletes');
      expect(result.rules[1].name).toBe('allow-read-sandbox');
    }
  });

  it('returns error when adding after nonexistent rule', () => {
    const uniqueRule: CompiledRule = {
      name: 'unique-rule-for-after-test',
      description: 'Unique rule',
      principle: 'Test',
      if: { tool: ['list_allowed_directories'] },
      then: 'allow',
      reason: 'Test',
    };
    const ops: RulePatchOp[] = [{ op: 'add', afterRule: 'no-such-rule', rule: uniqueRule }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('no-such-rule');
      expect(result.error).toContain('not found');
    }
  });

  it('deletes an existing rule by name', () => {
    const ops: RulePatchOp[] = [{ op: 'delete', ruleName: 'escalate-write-sandbox' }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(2);
      expect(result.rules.map((r) => r.name)).toEqual(['allow-read-sandbox', 'allow-introspection']);
    }
  });

  it('returns error when deleting nonexistent rule', () => {
    const ops: RulePatchOp[] = [{ op: 'delete', ruleName: 'no-such-rule' }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('no-such-rule');
    }
  });

  it('applies multiple operations sequentially', () => {
    const newRule: CompiledRule = {
      name: 'allow-write-sandbox',
      description: 'Allow writes in sandbox',
      principle: 'Containment',
      if: { paths: { roles: ['write-path'], within: TEST_SANDBOX_DIR } },
      then: 'allow',
      reason: 'Sandbox writes are safe',
    };
    const ops: RulePatchOp[] = [
      { op: 'delete', ruleName: 'escalate-write-sandbox' },
      { op: 'add', afterRule: 'allow-read-sandbox', rule: newRule },
    ];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(3);
      expect(result.rules.map((r) => r.name)).toEqual([
        'allow-read-sandbox',
        'allow-write-sandbox',
        'allow-introspection',
      ]);
    }
  });

  it('fails when delete then add-after references deleted rule', () => {
    const uniqueRule: CompiledRule = {
      name: 'replacement-rule',
      description: 'Replacement',
      principle: 'Test',
      if: { tool: ['list_allowed_directories'] },
      then: 'allow',
      reason: 'Test',
    };
    const ops: RulePatchOp[] = [
      { op: 'delete', ruleName: 'escalate-write-sandbox' },
      { op: 'add', afterRule: 'escalate-write-sandbox', rule: uniqueRule },
    ];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('escalate-write-sandbox');
    }
  });

  it('does not mutate the input array', () => {
    const originalLength = baseRules.length;
    const ops: RulePatchOp[] = [{ op: 'delete', ruleName: 'allow-introspection' }];

    applyRulePatch(baseRules, ops);
    expect(baseRules).toHaveLength(originalLength);
  });

  it('handles empty operations array', () => {
    const result = applyRulePatch(baseRules, []);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toEqual(baseRules);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPointFixRepairInstructions
// ---------------------------------------------------------------------------

describe('buildPointFixRepairInstructions', () => {
  const failedScenario: ExecutionResult = {
    scenario: {
      description: 'Should allow writing to sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: `${TEST_SANDBOX_DIR}/test.txt` },
      },
      expectedDecision: 'allow',
      reasoning: 'File is within sandbox',
      source: 'generated',
    },
    actualDecision: 'escalate',
    matchingRule: 'escalate-write-sandbox',
    pass: false,
  };

  const repairContext: RepairContext = {
    failedScenarios: [failedScenario],
    judgeAnalysis: 'The write rule escalates instead of allowing.',
    attemptNumber: 1,
  };

  it('includes current rules in compact format', () => {
    const text = buildPointFixRepairInstructions(baseRules, repairContext);
    expect(text).toContain('"allow-read-sandbox"');
    expect(text).toContain('"escalate-write-sandbox"');
    expect(text).toContain('"allow-introspection"');
  });

  it('includes failed scenarios', () => {
    const text = buildPointFixRepairInstructions(baseRules, repairContext);
    expect(text).toContain('Should allow writing to sandbox');
  });

  it('includes judge analysis', () => {
    const text = buildPointFixRepairInstructions(baseRules, repairContext);
    expect(text).toContain('The write rule escalates instead of allowing.');
  });

  it('includes attempt number', () => {
    const text = buildPointFixRepairInstructions(baseRules, repairContext);
    expect(text).toContain('attempt 1');
  });

  it('instructs minimal changes', () => {
    const text = buildPointFixRepairInstructions(baseRules, repairContext);
    expect(text).toContain('Only modify rules that are DIRECTLY responsible');
    expect(text).toContain('Do NOT touch passing rules');
  });

  it('includes dynamic list references when present', () => {
    const contextWithLists: RepairContext = {
      ...repairContext,
      existingListDefinitions: [
        {
          name: 'major-news-sites',
          type: 'domains',
          principle: 'Allow news sites',
          generationPrompt: 'List major news sites',
          requiresMcp: false,
        },
      ],
    };
    const text = buildPointFixRepairInstructions(baseRules, contextWithLists);
    expect(text).toContain('@major-news-sites');
  });

  it('includes handwritten scenarios section when present', () => {
    const contextWithHandwritten: RepairContext = {
      ...repairContext,
      handwrittenScenarios: [
        {
          description: 'Must deny delete outside sandbox',
          request: {
            serverName: 'filesystem',
            toolName: 'delete_file',
            arguments: { path: '/etc/passwd' },
          },
          expectedDecision: 'not-allow',
          reasoning: 'Protected system file',
          source: 'handwritten',
        },
      ],
    };
    const text = buildPointFixRepairInstructions(baseRules, contextWithHandwritten);
    expect(text).toContain('Ground Truth Constraints');
  });
});

// ---------------------------------------------------------------------------
// buildPatchResponseSchema
// ---------------------------------------------------------------------------

describe('buildPatchResponseSchema', () => {
  const serverNames: [string, ...string[]] = ['filesystem'];
  const toolNames: [string, ...string[]] = ['read_file', 'write_file'];
  const ruleNames: [string, ...string[]] = ['allow-read', 'escalate-write'];

  it('builds a valid schema that accepts correct patch input', () => {
    const schema = buildPatchResponseSchema(serverNames, toolNames, ruleNames);
    const validPatch = {
      reasoning: 'Fix the write rule',
      operations: [
        {
          op: 'update',
          ruleName: 'escalate-write',
          rule: {
            name: 'escalate-write',
            description: 'Allow writes',
            principle: 'Containment',
            if: { server: ['filesystem'] },
            then: 'allow',
            reason: 'Fixed',
          },
        },
      ],
    };

    expect(() => schema.parse(validPatch)).not.toThrow();
  });

  it('rejects update with unknown rule name', () => {
    const schema = buildPatchResponseSchema(serverNames, toolNames, ruleNames);
    const invalidPatch = {
      reasoning: 'test',
      operations: [
        {
          op: 'update',
          ruleName: 'nonexistent-rule',
          rule: {
            name: 'x',
            description: 'x',
            principle: 'x',
            if: { server: ['filesystem'] },
            then: 'allow',
            reason: 'x',
          },
        },
      ],
    };

    expect(() => schema.parse(invalidPatch)).toThrow();
  });

  it('accepts add operations with and without afterRule', () => {
    const schema = buildPatchResponseSchema(serverNames, toolNames, ruleNames);
    const rule = {
      name: 'new-rule',
      description: 'New rule',
      principle: 'test',
      if: { server: ['filesystem'] },
      then: 'allow' as const,
      reason: 'test',
    };

    const withAfter = {
      reasoning: 'test',
      operations: [{ op: 'add', afterRule: 'allow-read', rule }],
    };
    expect(() => schema.parse(withAfter)).not.toThrow();

    const withoutAfter = {
      reasoning: 'test',
      operations: [{ op: 'add', rule }],
    };
    expect(() => schema.parse(withoutAfter)).not.toThrow();
  });

  it('accepts delete operations', () => {
    const schema = buildPatchResponseSchema(serverNames, toolNames, ruleNames);
    const patch = {
      reasoning: 'Remove unnecessary rule',
      operations: [{ op: 'delete', ruleName: 'allow-read' }],
    };

    expect(() => schema.parse(patch)).not.toThrow();
  });

  it('accepts optional listDefinitions', () => {
    const schema = buildPatchResponseSchema(serverNames, toolNames, ruleNames);
    const patch = {
      reasoning: 'Add list',
      operations: [],
      listDefinitions: [
        {
          name: 'test-list',
          type: 'domains',
          principle: 'test',
          generationPrompt: 'test prompt',
          requiresMcp: false,
        },
      ],
    };

    expect(() => schema.parse(patch)).not.toThrow();
  });

  it('rejects update where rule.name differs from ruleName', () => {
    const schema = buildPatchResponseSchema(serverNames, toolNames, ruleNames);
    const patch = {
      reasoning: 'Fix the write rule',
      operations: [
        {
          op: 'update',
          ruleName: 'escalate-write',
          rule: {
            name: 'renamed-write',
            description: 'Allow writes',
            principle: 'Containment',
            if: { server: ['filesystem'] },
            then: 'allow',
            reason: 'Fixed',
          },
        },
      ],
    };

    expect(() => schema.parse(patch)).toThrow(/must match ruleName/);
  });

  it('rejects empty rule conditions (catch-all prevention)', () => {
    const schema = buildPatchResponseSchema(serverNames, toolNames, ruleNames);
    const patch = {
      reasoning: 'test',
      operations: [
        {
          op: 'add',
          rule: {
            name: 'catch-all',
            description: 'Catch all',
            principle: 'test',
            if: {},
            then: 'allow',
            reason: 'test',
          },
        },
      ],
    };

    expect(() => schema.parse(patch)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeListDefinitions
// ---------------------------------------------------------------------------

const existingLists: ListDefinition[] = [
  {
    name: 'major-news-sites',
    type: 'domains',
    principle: 'Allow news sites',
    generationPrompt: 'List major news sites',
    requiresMcp: false,
  },
  {
    name: 'my-contacts',
    type: 'emails',
    principle: 'Allow contacts',
    generationPrompt: 'List contacts',
    requiresMcp: true,
    mcpServerHint: 'contacts',
  },
];

describe('mergeListDefinitions', () => {
  it('preserves existing lists when patch omits listDefinitions', () => {
    const result = mergeListDefinitions(existingLists, undefined);
    expect(result).toEqual(existingLists);
  });

  it('preserves existing lists when patch has empty listDefinitions', () => {
    const result = mergeListDefinitions(existingLists, []);
    expect(result).toEqual(existingLists);
  });

  it('appends new lists from patch to existing ones', () => {
    const newList: ListDefinition = {
      name: 'tech-stocks',
      type: 'identifiers',
      principle: 'Allow tech stocks',
      generationPrompt: 'List tech stocks',
      requiresMcp: false,
    };
    const result = mergeListDefinitions(existingLists, [newList]);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('major-news-sites');
    expect(result[1].name).toBe('my-contacts');
    expect(result[2].name).toBe('tech-stocks');
  });

  it('ignores patch lists that duplicate existing names', () => {
    const duplicateList: ListDefinition = {
      name: 'major-news-sites',
      type: 'domains',
      principle: 'Different principle',
      generationPrompt: 'Different prompt',
      requiresMcp: false,
    };
    const result = mergeListDefinitions(existingLists, [duplicateList]);
    expect(result).toHaveLength(2);
    // Original is preserved, not replaced
    expect(result[0].principle).toBe('Allow news sites');
  });

  it('returns empty array when both inputs are empty', () => {
    const result = mergeListDefinitions([], undefined);
    expect(result).toEqual([]);
  });

  it('returns patch lists when existing is empty', () => {
    const newList: ListDefinition = {
      name: 'tech-stocks',
      type: 'identifiers',
      principle: 'Allow tech stocks',
      generationPrompt: 'List tech stocks',
      requiresMcp: false,
    };
    const result = mergeListDefinitions([], [newList]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('tech-stocks');
  });
});

// ---------------------------------------------------------------------------
// applyRulePatch -- additional guards
// ---------------------------------------------------------------------------

describe('applyRulePatch guards', () => {
  it('returns error when adding a rule with a duplicate name', () => {
    const duplicateRule: CompiledRule = {
      name: 'allow-read-sandbox',
      description: 'Duplicate name',
      principle: 'Test',
      if: { tool: ['list_allowed_directories'] },
      then: 'allow',
      reason: 'Duplicate',
    };
    const ops: RulePatchOp[] = [{ op: 'add', rule: duplicateRule }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('allow-read-sandbox');
      expect(result.error).toContain('already exists');
    }
  });

  it('returns error when update changes the rule name', () => {
    const renamedRule: CompiledRule = {
      ...baseRules[1],
      name: 'renamed-rule',
    };
    const ops: RulePatchOp[] = [{ op: 'update', ruleName: 'escalate-write-sandbox', rule: renamedRule }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('escalate-write-sandbox');
      expect(result.error).toContain('renamed-rule');
      expect(result.error).toContain('does not match');
    }
  });

  it('allows update that keeps the same rule name', () => {
    const updatedRule: CompiledRule = {
      ...baseRules[1],
      then: 'allow',
      reason: 'Changed decision',
    };
    const ops: RulePatchOp[] = [{ op: 'update', ruleName: 'escalate-write-sandbox', rule: updatedRule }];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules[1].then).toBe('allow');
    }
  });

  it('handles update then delete of the same rule', () => {
    const updatedRule: CompiledRule = {
      ...baseRules[1],
      then: 'allow',
      reason: 'Changed decision',
    };
    const ops: RulePatchOp[] = [
      { op: 'update', ruleName: 'escalate-write-sandbox', rule: updatedRule },
      { op: 'delete', ruleName: 'escalate-write-sandbox' },
    ];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rules).toHaveLength(2);
      expect(result.rules.map((r) => r.name)).toEqual(['allow-read-sandbox', 'allow-introspection']);
    }
  });

  it('rejects duplicate name from second add in same patch', () => {
    const newRule: CompiledRule = {
      name: 'new-rule',
      description: 'New rule',
      principle: 'Test',
      if: { tool: ['list_allowed_directories'] },
      then: 'allow',
      reason: 'Test',
    };
    const ops: RulePatchOp[] = [
      { op: 'add', rule: newRule },
      { op: 'add', rule: { ...newRule, description: 'Duplicate' } },
    ];

    const result = applyRulePatch(baseRules, ops);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('new-rule');
      expect(result.error).toContain('already exists');
    }
  });
});

// ---------------------------------------------------------------------------
// buildPointFixRepairInstructions -- list preservation messaging
// ---------------------------------------------------------------------------

describe('buildPointFixRepairInstructions list preservation', () => {
  const failedScenario: ExecutionResult = {
    scenario: {
      description: 'Should allow writing to sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: `${TEST_SANDBOX_DIR}/test.txt` },
      },
      expectedDecision: 'allow',
      reasoning: 'File is within sandbox',
      source: 'generated',
    },
    actualDecision: 'escalate',
    matchingRule: 'escalate-write-sandbox',
    pass: false,
  };

  it('instructs LLM that existing lists are preserved', () => {
    const contextWithLists: RepairContext = {
      failedScenarios: [failedScenario],
      judgeAnalysis: 'The write rule escalates instead of allowing.',
      attemptNumber: 1,
      existingListDefinitions: existingLists,
    };
    const text = buildPointFixRepairInstructions(baseRules, contextWithLists);
    expect(text).toContain('preserved automatically');
    expect(text).toContain('add NEW list definitions');
    expect(text).toContain('do NOT redefine existing lists');
  });
});
