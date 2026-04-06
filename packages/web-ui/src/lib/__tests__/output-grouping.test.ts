import { describe, it, expect } from 'vitest';
import { groupOutputLines, buildGroupSummary } from '../output-grouping.js';
import type { OutputLine } from '../types.js';

const ts = '2026-01-01T00:00:00Z';

describe('groupOutputLines', () => {
  it('returns empty for empty input', () => {
    expect(groupOutputLines([])).toEqual([]);
  });

  it('wraps a single user message as a single entry', () => {
    const lines: OutputLine[] = [{ kind: 'user', text: 'Hello', timestamp: ts }];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('single');
  });

  it('wraps a single assistant message as a single entry', () => {
    const lines: OutputLine[] = [{ kind: 'assistant', text: 'Hi there', timestamp: ts }];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('single');
  });

  it('groups consecutive tool_call lines', () => {
    const lines: OutputLine[] = [
      { kind: 'tool_call', text: 'read_file: ./a', timestamp: ts },
      { kind: 'tool_call', text: 'read_file: ./b', timestamp: ts },
      { kind: 'tool_call', text: 'write_file: ./c', timestamp: ts },
    ];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('group');
    if (result[0].kind === 'group') {
      expect(result[0].lines).toHaveLength(3);
    }
  });

  it('groups mixed thinking + tool_call lines together', () => {
    const lines: OutputLine[] = [
      { kind: 'thinking', text: 'Thinking...', timestamp: ts },
      { kind: 'tool_call', text: 'read_file: ./foo', timestamp: ts },
      { kind: 'tool_call', text: 'write_file: ./bar', timestamp: ts },
      { kind: 'assistant', text: 'Done.', timestamp: ts },
    ];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('group');
    if (result[0].kind === 'group') {
      expect(result[0].lines).toHaveLength(3);
    }
    expect(result[1].kind).toBe('single');
  });

  it('creates separate groups when interrupted by user/assistant lines', () => {
    const lines: OutputLine[] = [
      { kind: 'tool_call', text: 'read_file: ./a', timestamp: ts },
      { kind: 'assistant', text: 'Result A', timestamp: ts },
      { kind: 'tool_call', text: 'read_file: ./b', timestamp: ts },
      { kind: 'assistant', text: 'Result B', timestamp: ts },
    ];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(4); // group, single, group, single
    expect(result[0].kind).toBe('group');
    expect(result[1].kind).toBe('single');
    expect(result[2].kind).toBe('group');
    expect(result[3].kind).toBe('single');
  });

  it('handles multiple groups in one output', () => {
    const lines: OutputLine[] = [
      { kind: 'user', text: 'Do stuff', timestamp: ts },
      { kind: 'thinking', text: 'Thinking...', timestamp: ts },
      { kind: 'tool_call', text: 'read_file: ./x', timestamp: ts },
      { kind: 'assistant', text: 'Step 1 done', timestamp: ts },
      { kind: 'thinking', text: 'Thinking again...', timestamp: ts },
      { kind: 'tool_call', text: 'write_file: ./y', timestamp: ts },
      { kind: 'assistant', text: 'All done', timestamp: ts },
    ];
    const result = groupOutputLines(lines);
    // user(single), group(thinking+tool), assistant(single), group(thinking+tool), assistant(single)
    expect(result).toHaveLength(5);
    expect(result[0].kind).toBe('single');
    expect(result[1].kind).toBe('group');
    expect(result[2].kind).toBe('single');
    expect(result[3].kind).toBe('group');
    expect(result[4].kind).toBe('single');
  });

  it('handles trailing group without assistant line', () => {
    const lines: OutputLine[] = [
      { kind: 'tool_call', text: 'read_file: ./a', timestamp: ts },
      { kind: 'tool_call', text: 'read_file: ./b', timestamp: ts },
    ];
    const result = groupOutputLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('group');
    if (result[0].kind === 'group') {
      expect(result[0].lines).toHaveLength(2);
    }
  });
});

describe('buildGroupSummary', () => {
  it('counts thinking and tool calls separately', () => {
    const lines: OutputLine[] = [
      { kind: 'thinking', text: '', timestamp: ts },
      { kind: 'tool_call', text: '', timestamp: ts },
      { kind: 'tool_call', text: '', timestamp: ts },
    ];
    expect(buildGroupSummary(lines)).toBe('1 thinking, 2 tool calls');
  });

  it('handles singular tool call', () => {
    const lines: OutputLine[] = [{ kind: 'tool_call', text: '', timestamp: ts }];
    expect(buildGroupSummary(lines)).toBe('1 tool call');
  });

  it('handles thinking only', () => {
    const lines: OutputLine[] = [
      { kind: 'thinking', text: '', timestamp: ts },
      { kind: 'thinking', text: '', timestamp: ts },
    ];
    expect(buildGroupSummary(lines)).toBe('2 thinking');
  });

  it('returns empty string for empty input', () => {
    expect(buildGroupSummary([])).toBe('');
  });
});
