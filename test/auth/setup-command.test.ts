import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { loadClientCredentials } from '../../src/auth/oauth-provider.js';
import { getOAuthProvider } from '../../src/auth/oauth-registry.js';
import { runSetupCommand } from '../../src/auth/setup-command.js';
import { runAuthCommand } from '../../src/auth/auth-command.js';

// ---------------------------------------------------------------------------
// Setup command integration (file copy + permissions)
// ---------------------------------------------------------------------------

describe('setup-command credential import', () => {
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

  it('copies credentials file to oauth dir with correct permissions', () => {
    const sourceFile = resolve(sourceDir, 'creds.json');
    const credContent = JSON.stringify({
      installed: {
        client_id: 'copy-test-id.apps.googleusercontent.com',
        client_secret: 'GOCSPX-copy-test',
      },
    });
    writeFileSync(sourceFile, credContent);

    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    const origExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;

    try {
      runSetupCommand(['google', sourceFile]);
    } finally {
      process.stdout.write = origWrite;
      process.exit = origExit;
    }

    const provider = getOAuthProvider('google');
    const destFile = resolve(tempDir, 'oauth', provider.credentialsFilename);
    expect(existsSync(destFile)).toBe(true);

    const copied = readFileSync(destFile, 'utf-8');
    expect(JSON.parse(copied)).toEqual(JSON.parse(credContent));

    const stats = statSync(destFile);
    expect(stats.mode & 0o777).toBe(0o600);

    const output = writes.join('');
    expect(output).toContain('copy-test-id.apps.go');
    expect(output).toContain('Next step');
  });

  it('creates oauth directory if it does not exist', () => {
    const sourceFile = resolve(sourceDir, 'creds.json');
    writeFileSync(sourceFile, JSON.stringify({ client_id: 'test', client_secret: 'test' }));

    const origWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const origExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;

    try {
      runSetupCommand(['google', sourceFile]);
    } finally {
      process.stdout.write = origWrite;
      process.exit = origExit;
    }

    expect(existsSync(resolve(tempDir, 'oauth'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auth command status + revoke
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

  it('shows status with no args', async () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runAuthCommand([]);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = writes.join('');
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

    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runAuthCommand(['status']);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = writes.join('');
    expect(output).toContain('configured');
  });

  it('revokes a stored token', async () => {
    const tokenPath = resolve(tempDir, 'oauth', 'google.json');
    writeFileSync(tokenPath, JSON.stringify({ accessToken: 'fake' }));
    expect(existsSync(tokenPath)).toBe(true);

    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runAuthCommand(['revoke', 'google']);
    } finally {
      process.stdout.write = origWrite;
    }

    expect(existsSync(tokenPath)).toBe(false);
    const output = writes.join('');
    expect(output).toContain('Token revoked');
  });

  it('handles revoke when no token exists', async () => {
    const writes: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runAuthCommand(['revoke', 'google']);
    } finally {
      process.stdout.write = origWrite;
    }

    const output = writes.join('');
    expect(output).toContain('No stored token found');
  });

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
