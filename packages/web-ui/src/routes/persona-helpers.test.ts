import { describe, it, expect } from 'vitest';
import { compileClearsStale } from './persona-helpers.js';

describe('compileClearsStale', () => {
  it('clears when the compile covered the current saved constitution', () => {
    expect(compileClearsStale('# A', '# A')).toBe(true);
  });

  it('does NOT clear when a newer constitution was saved during the compile (the R4 race)', () => {
    // covered = the constitution at compile-start; current = a later save.
    expect(compileClearsStale('# old', '# new')).toBe(false);
  });

  it('clears on an unknown snapshot (compile not initiated by this view)', () => {
    expect(compileClearsStale(undefined, '# anything')).toBe(true);
  });

  it('treats empty strings as equal (both empty -> clears)', () => {
    expect(compileClearsStale('', '')).toBe(true);
  });

  it('does not clear when only one side is empty', () => {
    expect(compileClearsStale('', '# x')).toBe(false);
    expect(compileClearsStale('# x', '')).toBe(false);
  });
});
