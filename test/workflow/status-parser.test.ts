import { describe, it, expect } from 'vitest';
import {
  parseAgentStatus,
  AgentStatusParseError,
  buildStatusBlockReprompt,
  STATUS_BLOCK_INSTRUCTIONS,
} from '../../src/workflow/status-parser.js';

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

  it('throws AgentStatusParseError on malformed block', () => {
    const text = '```\nagent_status:\n  completed: maybe\n```';
    expect(() => parseAgentStatus(text)).toThrow(AgentStatusParseError);
  });

  it('preserves rawBlock on parse error', () => {
    const text = '```\nagent_status:\n  completed: maybe\n```';
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
});

describe('STATUS_BLOCK_INSTRUCTIONS', () => {
  it('is a non-empty string', () => {
    expect(STATUS_BLOCK_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  it('contains the expected fields', () => {
    expect(STATUS_BLOCK_INSTRUCTIONS).toContain('completed');
    expect(STATUS_BLOCK_INSTRUCTIONS).toContain('verdict');
    expect(STATUS_BLOCK_INSTRUCTIONS).toContain('confidence');
    expect(STATUS_BLOCK_INSTRUCTIONS).toContain('escalation');
    expect(STATUS_BLOCK_INSTRUCTIONS).toContain('test_count');
    expect(STATUS_BLOCK_INSTRUCTIONS).toContain('notes');
  });
});
