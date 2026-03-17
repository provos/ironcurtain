import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeGWorkspaceCredentialFile,
  GWORKSPACE_CREDENTIAL_FILENAME,
  type GWorkspaceCredentialFile,
} from '../src/trusted-process/gworkspace-credentials.js';

describe('writeGWorkspaceCredentialFile', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gworkspace-creds-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes a valid credential file', () => {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ];
    const expiresAt = Date.now() + 3600_000;

    writeGWorkspaceCredentialFile(testDir, 'ya29.test-token', expiresAt, scopes);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as GWorkspaceCredentialFile;
    expect(content.access_token).toBe('ya29.test-token');
    expect(content.expiry_date).toBe(expiresAt);
    expect(content.token_type).toBe('Bearer');
    expect(content.scope).toBe(scopes.join(' '));
  });

  it('does NOT include refresh_token in the output', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const raw = readFileSync(filePath, 'utf-8');

    // Check both the parsed object and raw text for extra safety
    expect(raw).not.toContain('refresh_token');
    const content = JSON.parse(raw) as Record<string, unknown>;
    expect(content).not.toHaveProperty('refresh_token');
  });

  it('creates the directory if it does not exist', () => {
    const nestedDir = join(testDir, 'nested', 'creds');
    expect(existsSync(nestedDir)).toBe(false);

    writeGWorkspaceCredentialFile(nestedDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(join(nestedDir, GWORKSPACE_CREDENTIAL_FILENAME))).toBe(true);
  });

  it('sets file permissions to 0o600', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const stats = statSync(filePath);
    // eslint-disable-next-line no-bitwise
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites an existing file atomically', () => {
    const firstExpiry = Date.now() + 3600_000;
    const secondExpiry = Date.now() + 7200_000;

    writeGWorkspaceCredentialFile(testDir, 'ya29.first', firstExpiry, ['scope']);
    writeGWorkspaceCredentialFile(testDir, 'ya29.second', secondExpiry, ['scope']);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as GWorkspaceCredentialFile;
    expect(content.access_token).toBe('ya29.second');
    expect(content.expiry_date).toBe(secondExpiry);
  });

  it('does not leave a .tmp file after successful write', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, ['scope']);

    const tmpPath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME + '.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('handles empty scopes array', () => {
    writeGWorkspaceCredentialFile(testDir, 'ya29.token', Date.now() + 3600_000, []);

    const filePath = join(testDir, GWORKSPACE_CREDENTIAL_FILENAME);
    const content = JSON.parse(readFileSync(filePath, 'utf-8')) as GWorkspaceCredentialFile;
    expect(content.scope).toBe('');
  });
});
