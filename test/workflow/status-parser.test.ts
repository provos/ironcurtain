import { describe, it, expect } from 'vitest';
import {
  parseAgentStatus,
  AgentStatusParseError,
  buildStatusBlockReprompt,
  stripStatusBlock,
  MINIMAL_STATUS_INSTRUCTIONS,
  buildConditionalStatusInstructions,
  getValidVerdicts,
  buildInvalidVerdictReprompt,
} from '../../src/workflow/status-parser.js';
import type { AgentTransitionDefinition } from '../../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapInFence(yamlContent: string): string {
  return `Some preceding text.\n\`\`\`\n${yamlContent}\`\`\`\nSome trailing text.`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseAgentStatus', () => {
  it('extracts status from response with surrounding text', () => {
    const text = [
      'I completed the task.',
      '```',
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: 42',
      '  notes: "all good"',
      '```',
    ].join('\n');
    const result = parseAgentStatus(text);
    expect(result).toEqual({
      completed: true,
      verdict: 'approved',
      confidence: 'high',
      escalation: null,
      testCount: 42,
      notes: 'all good',
    });
  });

  it('returns undefined when no status block present', () => {
    expect(parseAgentStatus('just some text without any code block')).toBeUndefined();
  });

  it('returns undefined when code block exists but no agent_status', () => {
    const text = '```\nsome_other_yaml:\n  key: value\n```';
    expect(parseAgentStatus(text)).toBeUndefined();
  });

  it('throws AgentStatusParseError on truly invalid block', () => {
    // verdict is required and has min(1), empty string should fail
    const text = '```\nagent_status:\n  verdict: ""\n```';
    expect(() => parseAgentStatus(text)).toThrow(AgentStatusParseError);
  });

  it('preserves rawBlock on parse error', () => {
    const text = '```\nagent_status:\n  verdict: ""\n```';
    try {
      parseAgentStatus(text);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AgentStatusParseError);
      expect((e as AgentStatusParseError).rawBlock).toContain('agent_status:');
    }
  });

  it('handles null test_count', () => {
    const yaml = [
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: null',
      '  notes: null',
      '',
    ].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result).toEqual({
      completed: true,
      verdict: 'approved',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: null,
    });
  });

  it('handles spec_flaw verdict', () => {
    const yaml = [
      'agent_status:',
      '  completed: true',
      '  verdict: spec_flaw',
      '  confidence: high',
      '  escalation: "spec has ambiguity"',
      '  test_count: null',
      '  notes: "found issue in spec"',
      '',
    ].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.verdict).toBe('spec_flaw');
    expect(result?.escalation).toBe('spec has ambiguity');
  });

  it('handles rejected verdict', () => {
    const yaml = [
      'agent_status:',
      '  completed: true',
      '  verdict: rejected',
      '  confidence: medium',
      '  escalation: null',
      '  test_count: 5',
      '  notes: "code quality issues"',
      '',
    ].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.verdict).toBe('rejected');
    expect(result?.confidence).toBe('medium');
    expect(result?.testCount).toBe(5);
  });

  it('handles blocked verdict', () => {
    const yaml = [
      'agent_status:',
      '  completed: false',
      '  verdict: blocked',
      '  confidence: high',
      '  escalation: "need API key"',
      '  test_count: null',
      '  notes: null',
      '',
    ].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.completed).toBe(false);
    expect(result?.verdict).toBe('blocked');
  });

  it('handles low confidence', () => {
    const yaml = [
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: low',
      '  escalation: null',
      '  test_count: 10',
      '  notes: "not sure about edge cases"',
      '',
    ].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.confidence).toBe('low');
  });

  it('uses the last status block when multiple exist', () => {
    // regex finds the first match, which is fine for our use case
    const text = [
      '```',
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: 1',
      '  notes: "first"',
      '```',
      'More text.',
      '```',
      'agent_status:',
      '  completed: true',
      '  verdict: rejected',
      '  confidence: low',
      '  escalation: null',
      '  test_count: 2',
      '  notes: "second"',
      '```',
    ].join('\n');
    const result = parseAgentStatus(text);
    // First match wins with our regex
    expect(result?.notes).toBe('first');
  });

  it('accepts custom verdict strings for direct routing', () => {
    const yaml = [
      'agent_status:',
      '  completed: true',
      '  verdict: thesis_validate',
      '  confidence: high',
      '  escalation: null',
      '  test_count: null',
      '  notes: "routing to validation"',
      '',
    ].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.verdict).toBe('thesis_validate');
  });

  it('handles unquoted string values', () => {
    const yaml = [
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: null',
      '  notes: everything looks good',
      '',
    ].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.notes).toBe('everything looks good');
  });

  // -- Partial block tests (defaults applied at parse time) --

  it('parses a minimal block with only verdict', () => {
    const yaml = ['agent_status:', '  verdict: done', ''].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result).toEqual({
      completed: true,
      verdict: 'done',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: null,
    });
  });

  it('parses verdict + notes with other fields defaulted', () => {
    const yaml = ['agent_status:', '  verdict: approved', '  notes: "all tests pass"', ''].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result).toEqual({
      completed: true,
      verdict: 'approved',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: 'all tests pass',
    });
  });

  it('allows overriding default completed to false', () => {
    const yaml = ['agent_status:', '  completed: false', '  verdict: blocked', ''].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.completed).toBe(false);
    expect(result?.confidence).toBe('high'); // defaulted
  });

  it('allows overriding default confidence', () => {
    const yaml = ['agent_status:', '  verdict: done', '  confidence: low', ''].join('\n');
    const result = parseAgentStatus(wrapInFence(yaml));
    expect(result?.confidence).toBe('low');
    expect(result?.completed).toBe(true); // defaulted
  });

  it('rejects block missing verdict (the only required field)', () => {
    const yaml = ['agent_status:', '  completed: true', '  notes: "no verdict"', ''].join('\n');
    expect(() => parseAgentStatus(wrapInFence(yaml))).toThrow(AgentStatusParseError);
  });
});

describe('buildStatusBlockReprompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildStatusBlockReprompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('includes the status block instructions', () => {
    const prompt = buildStatusBlockReprompt();
    expect(prompt).toContain('agent_status:');
  });

  it('mentions the missing block', () => {
    const prompt = buildStatusBlockReprompt();
    expect(prompt).toContain('missing');
  });

  it('uses the minimal format with verdict and notes', () => {
    const prompt = buildStatusBlockReprompt();
    expect(prompt).toContain('verdict: completed');
    expect(prompt).toContain('notes:');
  });

  it('surfaces the parse error detail when the block was malformed', () => {
    const parseError = new AgentStatusParseError(
      'Malformed agent_status block: verdict: Invalid input: expected string, received undefined',
      'agent_status:\n  status: complete',
    );
    const prompt = buildStatusBlockReprompt(undefined, parseError);
    expect(prompt).toContain('malformed');
    expect(prompt).toContain('Parse error:');
    expect(prompt).toContain('verdict: Invalid input');
    // Still shows the canonical instructions
    expect(prompt).toContain('agent_status:');
    expect(prompt).toContain('verdict: completed');
  });

  it('uses missing-block wording when no parse error is supplied', () => {
    const prompt = buildStatusBlockReprompt();
    expect(prompt).toContain('missing the required agent_status block');
    expect(prompt).not.toContain('malformed');
  });
});

describe('MINIMAL_STATUS_INSTRUCTIONS', () => {
  it('is a non-empty string', () => {
    expect(MINIMAL_STATUS_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  it('contains verdict and notes fields', () => {
    expect(MINIMAL_STATUS_INSTRUCTIONS).toContain('verdict');
    expect(MINIMAL_STATUS_INSTRUCTIONS).toContain('notes');
  });

  it('does not contain the verbose fields', () => {
    // Minimal instructions omit completed, confidence, escalation, test_count
    expect(MINIMAL_STATUS_INSTRUCTIONS).not.toContain('completed:');
    expect(MINIMAL_STATUS_INSTRUCTIONS).not.toContain('confidence:');
    expect(MINIMAL_STATUS_INSTRUCTIONS).not.toContain('escalation:');
    expect(MINIMAL_STATUS_INSTRUCTIONS).not.toContain('test_count:');
  });

  it('says verdict does not affect routing', () => {
    expect(MINIMAL_STATUS_INSTRUCTIONS).toContain('does not affect routing');
    expect(MINIMAL_STATUS_INSTRUCTIONS).toContain('logged for diagnostics');
  });

  it('uses completed as the example verdict', () => {
    expect(MINIMAL_STATUS_INSTRUCTIONS).toContain('verdict: completed');
  });

  it('instructs the agent to use exactly these field names', () => {
    // Guards against models (e.g. Opus 4.6) emitting `status:` instead of `verdict:`
    // or adding extra keys like `scope`, `artifacts`, `top_hypotheses`.
    expect(MINIMAL_STATUS_INSTRUCTIONS).toMatch(/EXACTLY these field names/);
    expect(MINIMAL_STATUS_INSTRUCTIONS).toContain('`verdict`');
    expect(MINIMAL_STATUS_INSTRUCTIONS).toContain('`notes`');
    expect(MINIMAL_STATUS_INSTRUCTIONS.toLowerCase()).toContain('abort');
  });
});

describe('buildConditionalStatusInstructions', () => {
  const guardLabels: Record<string, string> = {
    isRoundLimitReached: 'round limit reached',
  };

  it('lists verdict values from when clauses', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'implement', when: { verdict: 'rejected' } },
    ];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    expect(result).toContain('`approved`');
    expect(result).toContain('`rejected`');
    expect(result).toContain('verdict: approved'); // example uses first value
  });

  it('deduplicates verdict values', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'a', when: { verdict: 'approved' } },
      { to: 'b', when: { verdict: 'approved' } },
    ];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    // Should appear only once in the list
    const matches = result.match(/`approved`/g);
    expect(matches).toHaveLength(1);
  });

  it('includes guard descriptions when guards are present', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'escalate', guard: 'isRoundLimitReached' },
      { to: 'implement', when: { verdict: 'rejected' } },
    ];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    expect(result).toContain('Automatic routing conditions');
    expect(result).toContain('`approved`');
    expect(result).toContain('round limit reached');
    expect(result).toContain('`rejected`');
  });

  it('handles mixed when and guard transitions', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'next', when: { verdict: 'thesis_validate' } },
      { to: 'done', guard: 'isRoundLimitReached' },
    ];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    expect(result).toContain('`thesis_validate`');
    expect(result).toContain('Automatic routing conditions');
    expect(result).toContain('round limit reached');
  });

  it('falls back to guard name for unknown guards', () => {
    const transitions: AgentTransitionDefinition[] = [{ to: 'next', guard: 'customGuard' }];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    expect(result).toContain('customGuard');
  });

  it('uses verdict-based routing for when clause transitions', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'implement', when: { verdict: 'rejected' } },
    ];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    expect(result).toContain('determines what happens next');
    expect(result).toContain('`approved`');
    expect(result).toContain('`rejected`');
  });

  it('uses informational verdict for mixed guard + unconditional transitions', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', guard: 'isRoundLimitReached' },
      { to: 'next' }, // unconditional fallthrough
    ];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    expect(result).toContain('does not affect routing');
    expect(result).toContain('verdict: completed');
    expect(result).toContain('Automatic routing conditions');
    expect(result).toContain('round limit reached');
  });

  it('uses verdict-routed instructions when when clauses are present', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'revise', when: { verdict: 'rejected' } },
    ];

    const result = buildConditionalStatusInstructions(transitions, guardLabels);

    expect(result).toContain('determines what happens next');
    expect(result).toContain('`approved`');
    expect(result).toContain('`rejected`');
    expect(result).not.toContain('does not affect routing');
  });
});

// ---------------------------------------------------------------------------
// stripStatusBlock
// ---------------------------------------------------------------------------

describe('stripStatusBlock', () => {
  it('strips a backtick-fenced status block from the end of a response', () => {
    const text = [
      'I completed the analysis.',
      '',
      '```',
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: null',
      '  notes: "done"',
      '```',
    ].join('\n');
    expect(stripStatusBlock(text)).toBe('I completed the analysis.');
  });

  it('strips a tilde-fenced status block', () => {
    const text = [
      'Results here.',
      '',
      '~~~',
      'agent_status:',
      '  completed: true',
      '  verdict: rejected',
      '  confidence: medium',
      '  escalation: null',
      '  test_count: 5',
      '  notes: null',
      '~~~',
    ].join('\n');
    expect(stripStatusBlock(text)).toBe('Results here.');
  });

  it('handles response with no status block (returns text unchanged)', () => {
    const text = 'Just some text without any status block.';
    expect(stripStatusBlock(text)).toBe(text);
  });

  it('strips status block with language tag (```yaml)', () => {
    const text = [
      'Analysis complete.',
      '',
      '```yaml',
      'agent_status:',
      '  completed: true',
      '  verdict: thesis_validate',
      '  confidence: high',
      '  escalation: null',
      '  test_count: null',
      '  notes: "routing"',
      '```',
    ].join('\n');
    expect(stripStatusBlock(text)).toBe('Analysis complete.');
  });

  it('preserves all text before the status block', () => {
    const preamble = [
      '## Findings',
      '',
      'Found 3 issues in the target file.',
      '',
      '1. Buffer overflow in parse_header()',
      '2. Integer truncation in validate_length()',
      '3. Unchecked return value in process_input()',
    ].join('\n');
    const block = [
      '',
      '```',
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: 3',
      '  notes: "found issues"',
      '```',
    ].join('\n');
    expect(stripStatusBlock(preamble + block)).toBe(preamble);
  });

  it('handles response that is ONLY a status block (returns empty string)', () => {
    const text = [
      '```',
      'agent_status:',
      '  completed: true',
      '  verdict: approved',
      '  confidence: high',
      '  escalation: null',
      '  test_count: null',
      '  notes: null',
      '```',
    ].join('\n');
    expect(stripStatusBlock(text)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getValidVerdicts
// ---------------------------------------------------------------------------

describe('getValidVerdicts', () => {
  it('returns verdict set from when clauses', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'a', when: { verdict: 'implement' } },
      { to: 'b', when: { verdict: 'research' } },
      { to: 'c', when: { verdict: 'done' } },
    ];
    const result = getValidVerdicts(transitions);
    expect(result).toEqual(new Set(['implement', 'research', 'done']));
  });

  it('returns undefined when a transition is unconditional', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'a', when: { verdict: 'implement' } },
      { to: 'b' }, // unconditional fallthrough
    ];
    expect(getValidVerdicts(transitions)).toBeUndefined();
  });

  it('returns undefined when all transitions are unconditional', () => {
    const transitions: AgentTransitionDefinition[] = [{ to: 'next' }];
    expect(getValidVerdicts(transitions)).toBeUndefined();
  });

  it('returns undefined for guard-only transitions (no when clauses)', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', guard: 'isRoundLimitReached' },
      { to: 'implement', guard: 'isStalled' },
    ];
    expect(getValidVerdicts(transitions)).toBeUndefined();
  });

  it('returns verdict set for mixed when + guard transitions', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'escalated', guard: 'isRoundLimitReached' },
      { to: 'review', when: { verdict: 'rejected' } },
    ];
    const result = getValidVerdicts(transitions);
    expect(result).toEqual(new Set(['approved', 'rejected']));
  });

  it('deduplicates identical verdict values', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'a', when: { verdict: 'done' } },
      { to: 'b', when: { verdict: 'done' } },
    ];
    const result = getValidVerdicts(transitions);
    expect(result).toEqual(new Set(['done']));
  });
});

// ---------------------------------------------------------------------------
// buildInvalidVerdictReprompt
// ---------------------------------------------------------------------------

describe('buildInvalidVerdictReprompt', () => {
  it('includes the invalid verdict and valid options', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'implement', when: { verdict: 'implement' } },
      { to: 'research', when: { verdict: 'research' } },
      { to: 'done', when: { verdict: 'done' } },
    ];
    const result = buildInvalidVerdictReprompt('no-vuln', transitions);

    expect(result).toContain('"no-vuln"');
    expect(result).toContain('not a valid routing option');
    expect(result).toContain('implement: dispatches to implement');
    expect(result).toContain('research: dispatches to research');
    expect(result).toContain('done: dispatches to done');
    expect(result).toContain('revise your response');
  });

  it('only lists when-clause transitions, not guard transitions', () => {
    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'escalated', guard: 'isRoundLimitReached' },
      { to: 'review', when: { verdict: 'rejected' } },
    ];
    const result = buildInvalidVerdictReprompt('maybe', transitions);

    expect(result).toContain('approved: dispatches to done');
    expect(result).toContain('rejected: dispatches to review');
    expect(result).not.toContain('isRoundLimitReached');
    expect(result).not.toContain('escalated');
  });
});
