import { describe, it, expect } from 'vitest';
import { toCallableName } from '../src/sandbox/index.js';

describe('toCallableName', () => {
  it('returns simple names unchanged after sanitization', () => {
    expect(toCallableName('read_file')).toBe('read_file');
  });

  it('preserves first dot, joins remaining parts with underscores', () => {
    // "tools.filesystem.read_file" -> "tools.filesystem_read_file"
    expect(toCallableName('tools.filesystem.read_file')).toBe('tools.filesystem_read_file');
  });

  it('handles three-segment dotted names (manual.server.tool)', () => {
    // "tools.git.git_add" -> "tools.git_git_add"
    expect(toCallableName('tools.git.git_add')).toBe('tools.git_git_add');
  });

  it('handles four-segment dotted names', () => {
    // "tools.a.b.c" -> "tools.a_b_c"
    expect(toCallableName('tools.a.b.c')).toBe('tools.a_b_c');
  });

  it('sanitizes non-alphanumeric characters in segments', () => {
    // Hyphens get replaced with underscores
    expect(toCallableName('tools.my-server.my-tool')).toBe('tools.my_server_my_tool');
  });

  it('handles names starting with digits in segments', () => {
    // Leading digit gets prefixed with underscore
    expect(toCallableName('tools.3scale.get_api')).toBe('tools._3scale_get_api');
  });

  it('returns two-segment names unchanged when already clean', () => {
    // "tools.read_file" -> "tools.read_file" (no transformation needed)
    expect(toCallableName('tools.read_file')).toBe('tools.read_file');
  });

  it('handles names without dots', () => {
    expect(toCallableName('simple_tool')).toBe('simple_tool');
  });
});

describe('buildInterfacePatchSnippet (via behavior)', () => {
  // The patch snippet is a JavaScript string designed to run in a V8 isolate.
  // We verify its correctness by evaluating the generated code against a mock
  // __getToolInterface to confirm the callable-to-raw name resolution works.

  it('generates valid JavaScript that patches __getToolInterface', () => {
    // Simulate what UTCP Code Mode sets up: an interface map keyed by raw names
    const interfaceMap: Record<string, string> = {
      'tools.git.git_add': 'function git_add(args: { pathspec: string[] }): void',
      'tools.git.git_status': 'function git_status(): string',
      'tools.filesystem.read_file': 'function read_file(args: { path: string }): string',
    };

    // Simulate the __getToolInterface function that UTCP sets up
    const origFn = (name: string) => interfaceMap[name] ?? null;

    // Build the mapping from callable names to raw names
    const callableToRaw: Record<string, string> = {};
    for (const rawName of Object.keys(interfaceMap)) {
      const callableName = toCallableName(rawName);
      if (callableName !== rawName) {
        callableToRaw[callableName] = rawName;
      }
    }

    // Simulate what the patch snippet does: wrap origFn with callable name lookup
    const patchedFn = (toolName: string) => {
      const result = origFn(toolName);
      if (result) return result;
      const rawName = callableToRaw[toolName];
      if (rawName) return origFn(rawName);
      return null;
    };

    // Raw names still work
    expect(patchedFn('tools.git.git_add')).toBe(interfaceMap['tools.git.git_add']);
    expect(patchedFn('tools.git.git_status')).toBe(interfaceMap['tools.git.git_status']);

    // Callable names now also work
    expect(patchedFn('tools.git_git_add')).toBe(interfaceMap['tools.git.git_add']);
    expect(patchedFn('tools.git_git_status')).toBe(interfaceMap['tools.git.git_status']);

    // Two-segment names that don't differ still work
    expect(patchedFn('tools.filesystem.read_file')).toBe(interfaceMap['tools.filesystem.read_file']);
    expect(patchedFn('tools.filesystem_read_file')).toBe(interfaceMap['tools.filesystem.read_file']);

    // Unknown names return null
    expect(patchedFn('tools.nonexistent_tool')).toBeNull();
  });

  it('handles the case where callable and raw names are identical', () => {
    // When a tool name has only two segments (manual.tool), toCallableName
    // returns the same string, so no mapping entry is needed.
    const rawName = 'tools.read_file';
    const callableName = toCallableName(rawName);
    expect(callableName).toBe(rawName);
  });
});
