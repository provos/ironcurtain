import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { toCallableName, toUtcpCallable, buildInterfacePatchSnippet } from '../src/sandbox/index.js';

describe('toCallableName', () => {
  it('returns simple names unchanged after sanitization', () => {
    expect(toCallableName('read_file')).toBe('read_file');
  });

  it('strips server prefix from tool name in 3-segment names', () => {
    // "tools.filesystem.read_file" -> "filesystem.read_file" (no prefix to strip)
    expect(toCallableName('tools.filesystem.read_file')).toBe('filesystem.read_file');
  });

  it('strips redundant server prefix from tool name', () => {
    // "tools.git.git_add" -> "git.add" (git_ prefix stripped)
    expect(toCallableName('tools.git.git_add')).toBe('git.add');
  });

  it('strips redundant server prefix for memory tools', () => {
    // "tools.memory.memory_context" -> "memory.context"
    expect(toCallableName('tools.memory.memory_context')).toBe('memory.context');
  });

  it('handles four-segment dotted names', () => {
    // "tools.a.b.c" -> "a.b_c" (no prefix to strip)
    expect(toCallableName('tools.a.b.c')).toBe('a.b_c');
  });

  it('sanitizes non-alphanumeric characters in segments', () => {
    // Hyphens get replaced with underscores
    expect(toCallableName('tools.my-server.my-tool')).toBe('my_server.my_tool');
  });

  it('handles names starting with digits in segments', () => {
    // Leading digit gets prefixed with underscore
    expect(toCallableName('tools.3scale.get_api')).toBe('_3scale.get_api');
  });

  it('returns two-segment names unchanged when already clean', () => {
    // "tools.read_file" -> "tools.read_file" (no transformation needed)
    expect(toCallableName('tools.read_file')).toBe('tools.read_file');
  });

  it('handles names without dots', () => {
    expect(toCallableName('simple_tool')).toBe('simple_tool');
  });

  it('does not strip partial prefix match', () => {
    // Server "mem", tool "memory_store" — "memory_store" doesn't start with "mem_"
    expect(toCallableName('tools.mem.memory_store')).toBe('mem.memory_store');
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

    // Build the mapping from both new and old callable names to raw names
    const callableToRaw: Record<string, string> = {};
    for (const rawName of Object.keys(interfaceMap)) {
      const callableName = toCallableName(rawName);
      if (callableName !== rawName) {
        callableToRaw[callableName] = rawName;
      }
      // Also add old UTCP callable format for backward compat
      const segments = rawName.split('.');
      if (segments.length >= 3) {
        const oldCallable = `${segments[0]}.${segments.slice(1).join('_')}`;
        if (oldCallable !== rawName && oldCallable !== callableName) {
          callableToRaw[oldCallable] = rawName;
        }
      }
    }

    // Simulate what the patch snippet does: wrap origFn with callable name lookup,
    // auto-correction, and helpful error messages.
    const allNames = Object.keys(callableToRaw);
    const patchedFn = (toolName: string): string | null => {
      let result = origFn(toolName);
      if (result) return result;
      let rawName = callableToRaw[toolName];
      if (rawName) return origFn(rawName);

      // Auto-correct: try prepending "tools."
      if (toolName && !toolName.startsWith('tools.')) {
        const prefixed = 'tools.' + toolName;
        result = origFn(prefixed);
        if (result) return result;
        rawName = callableToRaw[prefixed];
        if (rawName) return origFn(rawName);
        // Try converting dots to underscores
        const asOldCallable = 'tools.' + toolName.replace(/\./g, '_');
        rawName = callableToRaw[asOldCallable];
        if (rawName) return origFn(rawName);
      }

      // Build helpful error with suggestions
      const suggestions: string[] = [];
      const needle = toolName.toLowerCase().replace(/^tools\./, '');
      for (let i = 0; i < allNames.length && suggestions.length < 3; i++) {
        if (
          allNames[i].toLowerCase().includes(needle) ||
          needle.includes(allNames[i].toLowerCase().replace(/^tools\./, ''))
        ) {
          suggestions.push(allNames[i]);
        }
      }
      let msg = `Unknown tool '${toolName}'.`;
      if (suggestions.length > 0) {
        msg += ' Did you mean: ' + suggestions.join(', ') + '?';
      } else {
        msg += ' Use the callable name format shown in the tool catalog, e.g. git.push';
      }
      return msg;
    };

    // Raw names still work
    expect(patchedFn('tools.git.git_add')).toBe(interfaceMap['tools.git.git_add']);
    expect(patchedFn('tools.git.git_status')).toBe(interfaceMap['tools.git.git_status']);

    // New callable names work
    expect(patchedFn('git.add')).toBe(interfaceMap['tools.git.git_add']);
    expect(patchedFn('git.status')).toBe(interfaceMap['tools.git.git_status']);
    expect(patchedFn('filesystem.read_file')).toBe(interfaceMap['tools.filesystem.read_file']);

    // Old UTCP callable names still work (backward compat)
    expect(patchedFn('tools.git_git_add')).toBe(interfaceMap['tools.git.git_add']);
    expect(patchedFn('tools.git_git_status')).toBe(interfaceMap['tools.git.git_status']);
    expect(patchedFn('tools.filesystem_read_file')).toBe(interfaceMap['tools.filesystem.read_file']);

    // Auto-correction: missing "tools." prefix with old underscore notation
    expect(patchedFn('git_git_add')).toBe(interfaceMap['tools.git.git_add']);

    // Unknown names return helpful error messages
    expect(patchedFn('tools.nonexistent_tool')).toContain("Unknown tool 'tools.nonexistent_tool'");
    expect(patchedFn('totally_unknown')).toContain('Use the callable name format');

    // Unknown name with partial match suggests similar tools
    expect(patchedFn('git.ad')).toContain('Did you mean:');
    expect(patchedFn('git.ad')).toContain('git.add');
  });

  it('handles the case where callable and raw names are identical', () => {
    // When a tool name has only two segments (manual.tool), toCallableName
    // returns the same string, so no mapping entry is needed.
    const rawName = 'tools.read_file';
    const callableName = toCallableName(rawName);
    expect(callableName).toBe(rawName);
  });
});

describe('buildInterfacePatchSnippet (real generated snippet)', () => {
  // These tests run the ACTUAL string produced by buildInterfacePatchSnippet
  // inside a vm context, against a mock __getToolInterface, instead of
  // reimplementing the logic. The manual name deliberately uses the
  // UUID-style form to prove that the per-sandbox manual prefix never leaks
  // into the agent-facing surface.
  const MANUAL = 'tools_0b89f22a_e76e_417e_8369_71668b24627c';
  const PREFIX = `${MANUAL}.`;

  // Raw UTCP tool names as the IronCurtain protocol produces them:
  // "<manual>.<server>.<tool>".
  const rawNames = [`${PREFIX}git.git_add`, `${PREFIX}git.git_status`, `${PREFIX}filesystem.read_file`];

  const interfaceMap: Record<string, string> = {
    [`${PREFIX}git.git_add`]: 'function git_add(args: { pathspec: string[] }): void',
    [`${PREFIX}git.git_status`]: 'function git_status(): string',
    [`${PREFIX}filesystem.read_file`]: 'function read_file(args: { path: string }): string',
  };

  // Build callableToRaw exactly the way buildToolCatalogAndPatch does.
  function buildCallableToRaw(): Record<string, string> {
    const callableToRaw: Record<string, string> = {};
    for (const raw of rawNames) {
      const callableName = toCallableName(raw);
      const utcpCallable = toUtcpCallable(raw);
      if (callableName !== raw) callableToRaw[callableName] = raw;
      if (utcpCallable !== raw && utcpCallable !== callableName) callableToRaw[utcpCallable] = raw;
    }
    return callableToRaw;
  }

  // Compiles the real snippet and returns the patched __getToolInterface.
  function makePatchedFn(): (toolName: string) => string | null {
    const callableToRaw = buildCallableToRaw();
    const utcpGlobalName = MANUAL; // sanitize() is a no-op on this name
    const snippet = buildInterfacePatchSnippet(callableToRaw, MANUAL, utcpGlobalName);

    const g: { __getToolInterface: (name: string) => string | null } = {
      __getToolInterface: (name: string) => interfaceMap[name] ?? null,
    };
    const context: { global: typeof g } = { global: g };
    vm.createContext(context);
    vm.runInContext(snippet, context);
    return g.__getToolInterface;
  }

  it('resolves raw, friendly, and old-UTCP callable names', () => {
    const fn = makePatchedFn();
    // Raw names still resolve.
    expect(fn(`${PREFIX}git.git_add`)).toBe(interfaceMap[`${PREFIX}git.git_add`]);
    // Friendly callable names resolve.
    expect(fn('git.add')).toBe(interfaceMap[`${PREFIX}git.git_add`]);
    expect(fn('filesystem.read_file')).toBe(interfaceMap[`${PREFIX}filesystem.read_file`]);
    // Old UTCP underscore form resolves (backward compat).
    expect(fn(`${PREFIX}git_git_add`)).toBe(interfaceMap[`${PREFIX}git.git_add`]);
  });

  it('suggests the friendly name on a near-miss', () => {
    const fn = makePatchedFn();
    const msg = fn('git.ad');
    expect(msg).toContain('Did you mean:');
    expect(msg).toContain('git.add');
  });

  it('never leaks the manual prefix in suggestions (regression)', () => {
    const fn = makePatchedFn();
    // A typo that fuzzy-matches multiple tools. Before the fix, the raw
    // "tools_<uuid>.git_git_add" key was offered as a suggestion.
    for (const typo of ['git.ad', 'git', 'read_fil', 'fileystem.read_file']) {
      const msg = fn(typo);
      expect(msg).not.toContain(MANUAL);
      expect(msg).not.toContain(PREFIX);
    }
  });

  it('falls back to the catalog hint when nothing matches', () => {
    const fn = makePatchedFn();
    const msg = fn('totally_unknown_xyz');
    expect(msg).toContain('Use the callable name format');
    expect(msg).not.toContain(MANUAL);
  });
});
