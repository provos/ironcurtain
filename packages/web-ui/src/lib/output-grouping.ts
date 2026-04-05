/**
 * Groups consecutive thinking/tool_call output lines into collapsible
 * sections for the session console UI.
 */

import type { OutputLine } from './types.js';

export type SingleEntry = { kind: 'single'; line: OutputLine };
export type CollapsibleGroup = { kind: 'group'; lines: OutputLine[]; summary: string };
export type OutputEntry = SingleEntry | CollapsibleGroup;

/** Whether a line kind should be grouped into collapsible sections. */
export function isCollapsibleKind(kind: OutputLine['kind']): boolean {
  return kind === 'thinking' || kind === 'tool_call';
}

/** Build a summary label for a collapsible group of lines. */
export function buildGroupSummary(lines: OutputLine[]): string {
  const toolCalls = lines.filter((l) => l.kind === 'tool_call').length;
  const thinking = lines.filter((l) => l.kind === 'thinking').length;
  const parts: string[] = [];
  if (thinking > 0) parts.push(`${thinking} thinking`);
  if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** Group consecutive thinking/tool_call lines into collapsible sections. */
export function groupOutputLines(lines: OutputLine[]): OutputEntry[] {
  const entries: OutputEntry[] = [];
  let pendingGroup: OutputLine[] = [];

  function flushGroup(): void {
    if (pendingGroup.length > 0) {
      entries.push({ kind: 'group', lines: pendingGroup, summary: buildGroupSummary(pendingGroup) });
      pendingGroup = [];
    }
  }

  for (const line of lines) {
    if (isCollapsibleKind(line.kind)) {
      pendingGroup.push(line);
    } else {
      flushGroup();
      entries.push({ kind: 'single', line });
    }
  }
  flushGroup();
  return entries;
}
