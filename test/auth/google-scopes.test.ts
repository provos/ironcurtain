import { describe, it, expect } from 'vitest';

import { GOOGLE_SCOPES, resolveGoogleShortScopes } from '../../src/auth/providers/google-scopes.js';
import { googleOAuthProvider } from '../../src/auth/providers/google.js';

// ---------------------------------------------------------------------------
// Registry structure
// ---------------------------------------------------------------------------

describe('GOOGLE_SCOPES registry', () => {
  it('has entries for all three services', () => {
    const groups = new Set(GOOGLE_SCOPES.map((s) => s.group));
    expect(groups).toEqual(new Set(['Gmail', 'Google Calendar', 'Google Drive']));
  });

  it('has unique short names', () => {
    const shortNames = GOOGLE_SCOPES.map((s) => s.shortName);
    expect(new Set(shortNames).size).toBe(shortNames.length);
  });

  it('has unique full scope URLs', () => {
    const fullScopes = GOOGLE_SCOPES.map((s) => s.fullScope);
    expect(new Set(fullScopes).size).toBe(fullScopes.length);
  });

  it('flags exactly one default per service group', () => {
    const defaultsByGroup = new Map<string, number>();
    for (const entry of GOOGLE_SCOPES) {
      if (entry.isDefault) {
        defaultsByGroup.set(entry.group, (defaultsByGroup.get(entry.group) ?? 0) + 1);
      }
    }

    // Each group should have exactly one default
    for (const [group, count] of defaultsByGroup) {
      expect(count, `${group} should have exactly one default`).toBe(1);
    }

    // All groups should have a default
    const allGroups = new Set(GOOGLE_SCOPES.map((s) => s.group));
    expect(defaultsByGroup.size).toBe(allGroups.size);
  });

  it('default scopes match googleOAuthProvider.defaultScopes', () => {
    const registryDefaults = GOOGLE_SCOPES.filter((s) => s.isDefault)
      .map((s) => s.fullScope)
      .sort();

    const providerDefaults = [...googleOAuthProvider.defaultScopes].sort();

    expect(registryDefaults).toEqual(providerDefaults);
  });
});

// ---------------------------------------------------------------------------
// Short-name resolution
// ---------------------------------------------------------------------------

describe('resolveGoogleShortScopes', () => {
  it('maps short names to full scope URLs', () => {
    const result = resolveGoogleShortScopes(['gmail.send', 'calendar.events']);

    expect(result).toEqual([
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
  });

  it('passes through full URLs unchanged', () => {
    const fullUrl = 'https://www.googleapis.com/auth/gmail.readonly';
    const result = resolveGoogleShortScopes([fullUrl]);

    expect(result).toEqual([fullUrl]);
  });

  it('handles a mix of short names and full URLs', () => {
    const fullUrl = 'https://www.googleapis.com/auth/drive.readonly';
    const result = resolveGoogleShortScopes(['gmail.send', fullUrl]);

    expect(result).toEqual(['https://www.googleapis.com/auth/gmail.send', fullUrl]);
  });

  it('throws on unknown short names', () => {
    expect(() => resolveGoogleShortScopes(['gmail.nonexistent'])).toThrow(/Unknown Google scope "gmail.nonexistent"/);
  });

  it('includes known scopes in error message', () => {
    expect(() => resolveGoogleShortScopes(['bad'])).toThrow(/Known scopes:/);
  });

  it('resolves all known short names without throwing', () => {
    const allShortNames = GOOGLE_SCOPES.map((s) => s.shortName);
    const result = resolveGoogleShortScopes(allShortNames);

    expect(result).toHaveLength(GOOGLE_SCOPES.length);
    for (const entry of GOOGLE_SCOPES) {
      expect(result).toContain(entry.fullScope);
    }
  });
});
