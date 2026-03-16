import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadClientCredentials } from '../../src/auth/oauth-provider.js';
import { getOAuthProvider } from '../../src/auth/oauth-registry.js';
import { runAuthCommand } from '../../src/auth/auth-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Captures stdout/stderr writes and console.error, suppresses process.exit. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const origWrite = process.stdout.write;
  const origErrWrite = process.stderr.write;
  const origConsoleError = console.error;
  process.stdout.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  console.error = ((...args: unknown[]) => {
    writes.push(args.map(String).join(' '));
  }) as typeof console.error;

  const origExit = process.exit;
  process.exit = (() => {}) as typeof process.exit;

  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    console.error = origConsoleError;
    process.exit = origExit;
  }
  return writes.join('');
}

// ---------------------------------------------------------------------------
// Auth import subcommand (file copy + permissions)
// ---------------------------------------------------------------------------

describe('auth import credential import', () => {
  let tempDir: string;
  let sourceDir: string;
  const originalEnv = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `ironcurtain-test-setup-${process.pid}-${Date.now()}`);
    sourceDir = resolve(tmpdir(), `ironcurtain-test-source-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    process.env.IRONCURTAIN_HOME = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it('copies credentials file to oauth dir with correct permissions', async () => {
    const sourceFile = resolve(sourceDir, 'creds.json');
    const credContent = JSON.stringify({
      installed: {
        client_id: 'copy-test-id.apps.googleusercontent.com',
        client_secret: 'GOCSPX-copy-test',
      },
    });
    writeFileSync(sourceFile, credContent);

    const output = await captureOutput(() => runAuthCommand(['import', 'google', sourceFile]));

    const provider = getOAuthProvider('google');
    const destFile = resolve(tempDir, 'oauth', provider.credentialsFilename);
    expect(existsSync(destFile)).toBe(true);

    const copied = readFileSync(destFile, 'utf-8');
    expect(JSON.parse(copied)).toEqual(JSON.parse(credContent));

    const stats = statSync(destFile);
    expect(stats.mode & 0o777).toBe(0o600);

    expect(output).toContain('copy-test-id.apps.go');
    expect(output).toContain('Next step');
  });

  it('creates oauth directory if it does not exist', async () => {
    const sourceFile = resolve(sourceDir, 'creds.json');
    writeFileSync(sourceFile, JSON.stringify({ client_id: 'test', client_secret: 'test' }));

    await captureOutput(() => runAuthCommand(['import', 'google', sourceFile]));

    expect(existsSync(resolve(tempDir, 'oauth'))).toBe(true);
  });

  it('shows Google setup guide when credentials file path is missing', async () => {
    const output = await captureOutput(() => runAuthCommand(['import', 'google']));

    expect(output).toContain('Google Cloud Project Setup');
    expect(output).toContain('console.cloud.google.com');
    expect(output).toContain('Desktop app');
  });
});

// ---------------------------------------------------------------------------
// Auth command help, status, and revoke
// ---------------------------------------------------------------------------

describe('auth-command', () => {
  let tempDir: string;
  const originalEnv = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `ironcurtain-test-auth-${process.pid}-${Date.now()}`);
    mkdirSync(resolve(tempDir, 'oauth'), { recursive: true });
    process.env.IRONCURTAIN_HOME = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // --help flag
  // -----------------------------------------------------------------------

  it('shows help with --help flag', async () => {
    const output = await captureOutput(() => runAuthCommand(['--help']));

    expect(output).toContain('ironcurtain auth');
    expect(output).toContain('Manage third-party OAuth providers');
    expect(output).toContain('import');
    expect(output).toContain('revoke');
    expect(output).toContain('--scopes');
  });

  it('shows help with -h flag', async () => {
    const output = await captureOutput(() => runAuthCommand(['-h']));

    expect(output).toContain('ironcurtain auth');
    expect(output).toContain('Subcommands');
  });

  it('shows help even when subcommand is present', async () => {
    const output = await captureOutput(() => runAuthCommand(['status', '--help']));

    expect(output).toContain('ironcurtain auth');
  });

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  it('shows status with no args', async () => {
    const output = await captureOutput(() => runAuthCommand([]));

    expect(output).toContain('Google Workspace');
    expect(output).toContain('not configured');
    expect(output).toContain('not authorized');
  });

  it('shows configured status when credentials exist', async () => {
    const provider = getOAuthProvider('google');
    writeFileSync(
      resolve(tempDir, 'oauth', provider.credentialsFilename),
      JSON.stringify({ installed: { client_id: 'test', client_secret: 'test' } }),
    );

    const output = await captureOutput(() => runAuthCommand(['status']));

    expect(output).toContain('configured');
  });

  // -----------------------------------------------------------------------
  // Revoke
  // -----------------------------------------------------------------------

  it('revokes a stored token and deletes the file', async () => {
    const tokenPath = resolve(tempDir, 'oauth', 'google.json');
    writeFileSync(
      tokenPath,
      JSON.stringify({
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 3600000,
        scopes: ['test'],
      }),
    );
    expect(existsSync(tokenPath)).toBe(true);

    const output = await captureOutput(() => runAuthCommand(['revoke', 'google']));

    expect(existsSync(tokenPath)).toBe(false);
    expect(output).toContain('Token revoked');
  });

  it('handles revoke when no token exists', async () => {
    const output = await captureOutput(() => runAuthCommand(['revoke', 'google']));

    expect(output).toContain('No stored token found');
  });

  it('warns on failed server-side revocation but still deletes local token', async () => {
    // Write a valid token so revokeTokenRemotely can read it
    const tokenPath = resolve(tempDir, 'oauth', 'google.json');
    writeFileSync(
      tokenPath,
      JSON.stringify({
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 3600000,
        scopes: ['test'],
      }),
    );

    // The revocation URL for Google points to a real endpoint that will fail
    // with our fake token, but the local file should still be deleted.
    // Mock fetch to simulate a network error.
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));
    try {
      const output = await captureOutput(() => runAuthCommand(['revoke', 'google']));

      expect(existsSync(tokenPath)).toBe(false);
      expect(output).toContain('Warning');
      expect(output).toContain('Token revoked');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // -----------------------------------------------------------------------
  // Credentials loaded after import
  // -----------------------------------------------------------------------

  it('shows credentials loaded after setup', () => {
    const provider = getOAuthProvider('google');
    writeFileSync(
      resolve(tempDir, 'oauth', provider.credentialsFilename),
      JSON.stringify({ installed: { client_id: 'loaded-id', client_secret: 'loaded-secret' } }),
    );

    const result = loadClientCredentials(provider);
    expect(result).not.toBeNull();
    expect(result!.clientId).toBe('loaded-id');
  });
});
