import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync as fsWriteFileSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  checkSandboxAvailability,
  resolveSandboxConfig,
  writeServerSettings,
  wrapServerCommand,
  cleanupSettingsFiles,
  annotateSandboxViolation,
  resolveNodeModulesBin,
  discoverNodePaths,
  rewriteServerSettings,
  type ResolvedSandboxConfig,
  type ResolvedSandboxParams,
} from '../src/trusted-process/sandbox-integration.js';
import type { MCPServerConfig } from '../src/config/types.js';

// ── Test helpers ─────────────────────────────────────────────────────────

function makeServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    command: 'node',
    args: ['server.js'],
    ...overrides,
  };
}

function makeSandboxedConfig(overrides: Partial<ResolvedSandboxParams> = {}): ResolvedSandboxConfig {
  return {
    sandboxed: true,
    config: {
      allowWrite: ['/sandbox'],
      allowRead: [],
      denyRead: ['~/.ssh'],
      denyWrite: [],
      network: false,
      ...overrides,
    },
  };
}

// ── checkSandboxAvailability ─────────────────────────────────────────────

describe('checkSandboxAvailability', () => {
  it('returns a structured result with platformSupported', () => {
    const result = checkSandboxAvailability();
    expect(result).toHaveProperty('platformSupported');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('warnings');
    expect(typeof result.platformSupported).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ── resolveSandboxConfig ─────────────────────────────────────────────────

describe('resolveSandboxConfig', () => {
  const sessionSandboxDir = '/sessions/abc/sandbox';

  it('returns opt-out for sandbox: false', () => {
    const result = resolveSandboxConfig(makeServerConfig({ sandbox: false }), sessionSandboxDir, true, 'warn');
    expect(result).toEqual({ sandboxed: false, reason: 'opt-out' });
  });

  it('applies restrictive defaults when sandbox is omitted', () => {
    const result = resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, true, 'warn');
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain(sessionSandboxDir);
      expect(result.config.network).toBe(false);
      expect(result.config.denyRead).toContain('~/.ssh');
      expect(result.config.denyRead).toContain('~/.gnupg');
      expect(result.config.denyRead).toContain('~/.aws');
    }
  });

  it('applies restrictive defaults when sandbox is empty object', () => {
    const result = resolveSandboxConfig(makeServerConfig({ sandbox: {} }), sessionSandboxDir, true, 'warn');
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain(sessionSandboxDir);
      expect(result.config.network).toBe(false);
    }
  });

  it('resolves relative allowWrite paths against session sandbox dir', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({ sandbox: { filesystem: { allowWrite: ['.git'] } } }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain(sessionSandboxDir);
      expect(result.config.allowWrite).toContain(resolve(sessionSandboxDir, '.git'));
    }
  });

  it('preserves absolute allowWrite paths as-is', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({ sandbox: { filesystem: { allowWrite: ['/tmp/extra'] } } }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain('/tmp/extra');
    }
  });

  it('uses custom denyRead and denyWrite when provided', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          filesystem: {
            denyRead: ['/etc/secrets'],
            denyWrite: ['/var/log'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.denyRead).toEqual(['/etc/secrets']);
      expect(result.config.denyWrite).toEqual(['/var/log']);
    }
  });

  it('resolves network config with allowed/denied domains', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          network: {
            allowedDomains: ['github.com', '*.github.com'],
            deniedDomains: ['evil.com'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.network).not.toBe(false);
      if (result.config.network !== false) {
        expect(result.config.network.allowedDomains).toEqual(['github.com', '*.github.com']);
        expect(result.config.network.deniedDomains).toEqual(['evil.com']);
      }
    }
  });

  it('defaults deniedDomains to empty array when not specified', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          network: { allowedDomains: ['example.com'] },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed && result.config.network !== false) {
      expect(result.config.network.deniedDomains).toEqual([]);
    }
  });

  it('degrades gracefully when platform unavailable and policy is warn', () => {
    const result = resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, false, 'warn');
    expect(result).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
  });

  it('throws when platform unavailable and policy is enforce', () => {
    expect(() => resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, false, 'enforce')).toThrow(
      /sandboxPolicy is "enforce"/,
    );
  });

  it('still returns opt-out even when platform unavailable', () => {
    const result = resolveSandboxConfig(makeServerConfig({ sandbox: false }), sessionSandboxDir, false, 'enforce');
    expect(result).toEqual({ sandboxed: false, reason: 'opt-out' });
  });
});

// ── writeServerSettings ──────────────────────────────────────────────────

describe('writeServerSettings', () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), 'test-srt-settings-'));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('writes valid JSON at the expected path', () => {
    const { settingsPath, cwdPath } = writeServerSettings(
      'exec',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: ['~/.ssh'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    expect(settingsPath).toBe(join(settingsDir, 'exec.srt-settings.json'));
    expect(existsSync(settingsPath)).toBe(true);
    expect(cwdPath).toBe(join(settingsDir, 'exec.cwd'));
    expect(existsSync(cwdPath)).toBe(true);

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content).toHaveProperty('network');
    expect(content).toHaveProperty('filesystem');
  });

  it('maps network: false to empty allowedDomains', () => {
    const { settingsPath } = writeServerSettings(
      'exec',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.network).toEqual({
      allowedDomains: [],
      deniedDomains: [],
    });
  });

  it('passes through allowedDomains and deniedDomains', () => {
    const { settingsPath } = writeServerSettings(
      'git',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: {
          allowedDomains: ['github.com', '*.github.com'],
          deniedDomains: ['evil.com'],
        },
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.network.allowedDomains).toEqual(['github.com', '*.github.com']);
    expect(content.network.deniedDomains).toEqual(['evil.com']);
  });

  it('writes correct filesystem config including cwd path', () => {
    const { settingsPath, cwdPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox', '/sandbox/.git'],
        allowRead: [],
        denyRead: ['~/.ssh', '~/.gnupg'],
        denyWrite: ['/var/log'],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowWrite).toEqual(['/sandbox', '/sandbox/.git', cwdPath]);
    expect(content.filesystem.denyRead).toEqual(['~/.ssh', '~/.gnupg']);
    expect(content.filesystem.denyWrite).toEqual(['/var/log']);
  });

  it('writes allowRead to settings file', () => {
    const { settingsPath } = writeServerSettings(
      'gws',
      {
        allowWrite: ['/sandbox'],
        allowRead: ['/usr', '/etc', '/home/user/.nvm'],
        denyRead: ['~'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowRead).toEqual(['/usr', '/etc', '/home/user/.nvm']);
    expect(content.filesystem.denyRead).toEqual(['~']);
  });

  it('includes SSH_AUTH_SOCK directory in allowUnixSockets when set', () => {
    const originalSock = process.env.SSH_AUTH_SOCK;
    try {
      process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.abc123/Listeners';
      const { settingsPath } = writeServerSettings(
        'git',
        {
          allowWrite: ['/sandbox'],
          allowRead: [],
          denyRead: [],
          denyWrite: [],
          network: {
            allowedDomains: ['github.com'],
            deniedDomains: [],
          },
        },
        settingsDir,
      );

      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(content.network.allowUnixSockets).toEqual(['/private/tmp/com.apple.launchd.abc123']);
    } finally {
      if (originalSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSock;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
    }
  });

  it('does not include allowUnixSockets when SSH_AUTH_SOCK is unset', () => {
    const originalSock = process.env.SSH_AUTH_SOCK;
    try {
      delete process.env.SSH_AUTH_SOCK;
      const { settingsPath } = writeServerSettings(
        'git',
        {
          allowWrite: ['/sandbox'],
          allowRead: [],
          denyRead: [],
          denyWrite: [],
          network: {
            allowedDomains: ['github.com'],
            deniedDomains: [],
          },
        },
        settingsDir,
      );

      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(content.network.allowUnixSockets).toBeUndefined();
    } finally {
      if (originalSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSock;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
    }
  });

  it('does not include allowUnixSockets when network is disabled', () => {
    const originalSock = process.env.SSH_AUTH_SOCK;
    try {
      process.env.SSH_AUTH_SOCK = '/private/tmp/com.apple.launchd.abc123/Listeners';
      const { settingsPath } = writeServerSettings(
        'exec',
        {
          allowWrite: ['/sandbox'],
          allowRead: [],
          denyRead: [],
          denyWrite: [],
          network: false,
        },
        settingsDir,
      );

      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(content.network.allowUnixSockets).toBeUndefined();
    } finally {
      if (originalSock !== undefined) {
        process.env.SSH_AUTH_SOCK = originalSock;
      } else {
        delete process.env.SSH_AUTH_SOCK;
      }
    }
  });
});

// ── rewriteServerSettings ─────────────────────────────────────────────────

describe('rewriteServerSettings', () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), 'test-srt-rewrite-'));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('adds allowRead paths to existing settings', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: ['/usr'],
        denyRead: ['~'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, { allowRead: ['/home/user/.nvm'] });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowRead).toContain('/usr');
    expect(content.filesystem.allowRead).toContain('/home/user/.nvm');
  });

  it('adds allowWrite paths to existing settings', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, { allowWrite: ['/tmp/creds'] });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowWrite).toContain('/tmp/creds');
    expect(content.filesystem.allowWrite).toContain('/sandbox');
  });

  it('deduplicates paths', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: ['/usr'],
        denyRead: [],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, { allowRead: ['/usr', '/etc'] });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      filesystem: { allowRead: string[] };
    };
    const usrCount = content.filesystem.allowRead.filter((p) => p === '/usr').length;
    expect(usrCount).toBe(1);
    expect(content.filesystem.allowRead).toContain('/etc');
  });

  it('handles both allowRead and allowWrite in one call', () => {
    const { settingsPath } = writeServerSettings(
      'test',
      {
        allowWrite: ['/sandbox'],
        allowRead: [],
        denyRead: ['~'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    rewriteServerSettings(settingsPath, {
      allowRead: ['/tmp/creds'],
      allowWrite: ['/tmp/creds'],
    });

    const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(content.filesystem.allowRead).toContain('/tmp/creds');
    expect(content.filesystem.allowWrite).toContain('/tmp/creds');
  });
});

// ── discoverNodePaths ─────────────────────────────────────────────────────

describe('discoverNodePaths', () => {
  it('returns an array of strings', () => {
    const paths = discoverNodePaths();
    expect(Array.isArray(paths)).toBe(true);
    for (const p of paths) {
      expect(typeof p).toBe('string');
      expect(p).toMatch(/^\//); // absolute paths
    }
  });

  it('returns paths under home directory only', () => {
    // Use realpath-resolved home to match the implementation (discoverNodePaths
    // resolves homedir() through realpath for symlink-safe prefix comparison)
    let home: string;
    try {
      home = realpathSync(homedir());
    } catch {
      return; // skip if home can't be resolved
    }
    const paths = discoverNodePaths();
    for (const p of paths) {
      expect(p.startsWith(home + '/')).toBe(true);
    }
  });

  it('includes node installation prefix when node is under home', () => {
    let home: string;
    try {
      home = realpathSync(homedir());
    } catch {
      return;
    }
    if (!process.execPath.startsWith(home + '/')) return;
    const paths = discoverNodePaths();
    // Should include at least one path that contains the node binary
    expect(paths.length).toBeGreaterThan(0);
  });
});

// ── resolveSandboxConfig with allowRead ───────────────────────────────────

describe('resolveSandboxConfig allowRead', () => {
  const sessionSandboxDir = '/sessions/abc/sandbox';

  it('defaults allowRead to empty array', () => {
    const result = resolveSandboxConfig(makeServerConfig(), sessionSandboxDir, true, 'warn');
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowRead).toEqual([]);
    }
  });

  it('passes through allowRead from config', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          filesystem: {
            denyRead: ['~'],
            allowRead: ['/usr', '/etc', '/opt/homebrew'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowRead).toEqual(['/usr', '/etc', '/opt/homebrew']);
      expect(result.config.denyRead).toEqual(['~']);
    }
  });

  it('expands tildes in allowRead paths', () => {
    const result = resolveSandboxConfig(
      makeServerConfig({
        sandbox: {
          filesystem: {
            denyRead: ['~'],
            allowRead: ['~/.nvm', '/usr'],
          },
        },
      }),
      sessionSandboxDir,
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowRead).toContain(homedir() + '/.nvm');
      expect(result.config.allowRead).toContain('/usr');
      // Should not contain the unexpanded tilde
      expect(result.config.allowRead).not.toContain('~/.nvm');
    }
  });
});

// ── wrapServerCommand ────────────────────────────────────────────────────

describe('wrapServerCommand', () => {
  const settingsDir = '/tmp/test-settings';
  const srtBin = resolveNodeModulesBin('srt', resolve('.'));

  it('passes through unsandboxed servers (opt-out)', () => {
    const result = wrapServerCommand(
      'filesystem',
      'npx',
      ['server'],
      { sandboxed: false, reason: 'opt-out' },
      settingsDir,
    );
    expect(result).toEqual({ command: 'npx', args: ['server'] });
  });

  it('passes through unsandboxed servers (platform-unavailable)', () => {
    const result = wrapServerCommand(
      'exec',
      'node',
      ['server.js'],
      { sandboxed: false, reason: 'platform-unavailable' },
      settingsDir,
    );
    expect(result).toEqual({ command: 'node', args: ['server.js'] });
  });

  it('wraps sandboxed servers with srt -s -c', () => {
    const result = wrapServerCommand('exec', 'node', ['server.js'], makeSandboxedConfig(), settingsDir);
    expect(result.command).toBe(srtBin);
    expect(result.args[0]).toBe('-s');
    expect(result.args[1]).toBe(join(settingsDir, 'exec.srt-settings.json'));
    expect(result.args[2]).toBe('-c');
    expect(result.args[3]).toContain('node');
    expect(result.args[3]).toContain('server.js');
  });

  it('shell-escapes args with spaces', () => {
    const result = wrapServerCommand(
      'exec',
      'node',
      ['./servers/exec server.js', '--flag=value with spaces'],
      makeSandboxedConfig(),
      settingsDir,
    );
    const cmdString = result.args[3];
    // Relative paths are resolved to absolute; shell-quote wraps spaces in quotes
    expect(cmdString).toContain('exec server.js');
    expect(cmdString).not.toContain("'./servers/exec server.js'"); // resolved to absolute
    expect(cmdString).toContain("'--flag=value with spaces'");
  });

  it('shell-escapes args with shell metacharacters', () => {
    const result = wrapServerCommand('exec', 'node', ['--pattern=$HOME/*.txt'], makeSandboxedConfig(), settingsDir);
    const cmdString = result.args[3];
    // shell-quote should escape $ and * with backslashes to prevent shell expansion
    expect(cmdString).toContain('\\$');
    expect(cmdString).toContain('\\*');
  });

  it('preserves npm package specifiers instead of resolving them as paths', () => {
    const result = wrapServerCommand(
      'google-workspace',
      'npx',
      ['-y', '@alanse/mcp-server-google-workspace@1.0.2'],
      makeSandboxedConfig(),
      settingsDir,
    );
    const cmdString = result.args[3];
    // Scoped package specifiers must not be resolved to absolute paths.
    // shell-quote escapes @ to \@, so check the unescaped form isn't an absolute path.
    expect(cmdString).not.toContain(process.cwd());
    expect(cmdString).toContain('mcp-server-google-workspace');
  });

  it('preserves unscoped npm package specifiers with pinned versions', () => {
    const result = wrapServerCommand('some-tool', 'npx', ['-y', 'somepkg@1.2.3'], makeSandboxedConfig(), settingsDir);
    const cmdString = result.args[3];
    expect(cmdString).not.toContain(process.cwd());
    expect(cmdString).toContain('somepkg');
  });

  it('still resolves relative file paths to absolute', () => {
    const result = wrapServerCommand(
      'git',
      'node',
      ['node_modules/.bin/git-mcp-server'],
      makeSandboxedConfig(),
      settingsDir,
    );
    const cmdString = result.args[3];
    // Relative file paths should be resolved to absolute
    expect(cmdString).toContain(resolve('node_modules/.bin/git-mcp-server'));
    expect(cmdString).not.toContain(' node_modules/');
  });

  it('uses correct settings file path per server name', () => {
    const resultA = wrapServerCommand('server-a', 'node', ['a.js'], makeSandboxedConfig(), settingsDir);
    const resultB = wrapServerCommand('server-b', 'node', ['b.js'], makeSandboxedConfig(), settingsDir);
    expect(resultA.args[1]).toBe(join(settingsDir, 'server-a.srt-settings.json'));
    expect(resultB.args[1]).toBe(join(settingsDir, 'server-b.srt-settings.json'));
  });
});

// ── cleanupSettingsFiles ─────────────────────────────────────────────────

describe('cleanupSettingsFiles', () => {
  it('removes the settings directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-cleanup-'));
    expect(existsSync(dir)).toBe(true);
    cleanupSettingsFiles(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw for non-existent directory', () => {
    expect(() => cleanupSettingsFiles('/tmp/does-not-exist-abc123')).not.toThrow();
  });
});

// ── annotateSandboxViolation ─────────────────────────────────────────────

describe('annotateSandboxViolation', () => {
  it('annotates EPERM errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('EPERM: operation not permitted', true);
    expect(result).toBe('[SANDBOX BLOCKED] EPERM: operation not permitted');
  });

  it('annotates EACCES errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('EACCES: permission denied, open /etc/shadow', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('annotates "Permission denied" errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('Permission denied', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('annotates "Operation not permitted" errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('Operation not permitted', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('annotates "read-only file system" errors for sandboxed servers', () => {
    const result = annotateSandboxViolation('EROFS: read-only file system, open /usr/bin/foo', true);
    expect(result).toMatch(/^\[SANDBOX BLOCKED\]/);
  });

  it('passes through non-sandbox errors unchanged for sandboxed servers', () => {
    const result = annotateSandboxViolation('ENOENT: file not found', true);
    expect(result).toBe('ENOENT: file not found');
  });

  it('passes through errors for unsandboxed servers', () => {
    const result = annotateSandboxViolation('EPERM: operation not permitted', false);
    expect(result).toBe('EPERM: operation not permitted');
  });

  it('passes through non-permission errors for unsandboxed servers', () => {
    const result = annotateSandboxViolation('ECONNREFUSED: connection refused', false);
    expect(result).toBe('ECONNREFUSED: connection refused');
  });
});

// ── Integration tests (gated behind platform check) ─────────────────────

function findServerFilesystem(): string | null {
  const npxCache = join(homedir(), '.npm', '_npx');
  if (existsSync(npxCache)) {
    for (const dir of readdirSync(npxCache)) {
      const candidate = join(
        npxCache,
        dir,
        'node_modules',
        '@modelcontextprotocol',
        'server-filesystem',
        'dist',
        'index.js',
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  const local = resolve('node_modules/@modelcontextprotocol/server-filesystem/dist/index.js');
  if (existsSync(local)) return local;
  return null;
}

// Only run integration tests if sandbox-runtime is available
const { platformSupported, errors: depErrors } = checkSandboxAvailability();
const sandboxAvailable = platformSupported && depErrors.length === 0;

describe.skipIf(!sandboxAvailable)('sandbox integration (requires bubblewrap+socat)', () => {
  let settingsDir: string;
  let sandboxDir: string;

  beforeEach(() => {
    settingsDir = realpathSync(mkdtempSync(join(tmpdir(), 'test-srt-int-settings-')));
    sandboxDir = realpathSync(mkdtempSync(join(tmpdir(), 'test-srt-int-sandbox-')));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  /** Creates a sandboxed MCP client connected via srt. Caller must close the client. */
  async function connectSandboxedClient(serverName: string, config: ResolvedSandboxParams, serverArgs: string[]) {
    writeServerSettings(serverName, config, settingsDir);
    const wrapped = wrapServerCommand(serverName, 'node', serverArgs, { sandboxed: true, config }, settingsDir);

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      env: { ...(process.env as Record<string, string>) },
      stderr: 'pipe',
    });

    const client = new Client({ name: `test-${serverName}`, version: '0.1.0' }, { capabilities: {} });

    await client.connect(transport);
    return client;
  }

  /** Default sandbox params: write to sandboxDir only, no network. */
  function defaultSandboxParams(overrides: Partial<ResolvedSandboxParams> = {}): ResolvedSandboxParams {
    return {
      allowWrite: [sandboxDir],
      allowRead: [],
      denyRead: [],
      denyWrite: [],
      network: false,
      ...overrides,
    };
  }

  it('full roundtrip: spawn MCP server via srt, list tools, call tool', async () => {
    const serverPath = findServerFilesystem();
    if (!serverPath) {
      console.warn('Skipping: @modelcontextprotocol/server-filesystem not found');
      return;
    }

    const config = defaultSandboxParams();
    const client = await connectSandboxedClient('filesystem', config, [serverPath, sandboxDir]);

    try {
      const toolsResult = await client.listTools();
      const toolNames = toolsResult.tools.map((t) => t.name);
      expect(toolNames.length).toBeGreaterThan(0);
      expect(toolNames).toContain('list_directory');

      const listResult = await client.callTool({
        name: 'list_directory',
        arguments: { path: sandboxDir },
      });
      expect(listResult.isError).toBeFalsy();
    } finally {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }, 30000);

  // macOS sandbox-exec auto-whitelists the TMPDIR parent (/var/folders/XX/YYY) for writes,
  // so temp-dir-based "outside sandbox" paths are unrestricted. Linux bubblewrap enforces this.
  it.skipIf(process.platform !== 'linux')(
    'sandbox blocks writes outside allowWrite',
    async () => {
      const serverPath = findServerFilesystem();
      if (!serverPath) {
        console.warn('Skipping: @modelcontextprotocol/server-filesystem not found');
        return;
      }

      const config = defaultSandboxParams();
      // Serve the parent of sandboxDir so server can see both inside and outside paths
      const serveDir = resolve(sandboxDir, '..');
      const client = await connectSandboxedClient('filesystem', config, [serverPath, serveDir]);

      try {
        // Write outside sandbox (but inside serveDir) should be blocked by srt
        const outsidePath = join(serveDir, `srt-test-outside-${Date.now()}.txt`);
        const writeResult = await client.callTool({
          name: 'write_file',
          arguments: { path: outsidePath, content: 'should not work' },
        });
        expect(writeResult.isError).toBe(true);
        const errorText = JSON.stringify(writeResult.content);
        expect(errorText).toMatch(/EACCES|EPERM|Permission denied|Read-only|Access denied/i);

        // Write inside sandbox should work
        const insidePath = join(sandboxDir, 'test-inside.txt');
        const insideResult = await client.callTool({
          name: 'write_file',
          arguments: { path: insidePath, content: 'inside sandbox' },
        });
        expect(insideResult.isError).toBeFalsy();
      } finally {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    },
    30000,
  );

  it('two srt processes with different settings coexist', async () => {
    const serverPath = findServerFilesystem();
    if (!serverPath) {
      console.warn('Skipping: @modelcontextprotocol/server-filesystem not found');
      return;
    }

    const configA = defaultSandboxParams();
    const configB = defaultSandboxParams({
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
    });

    const clientA = await connectSandboxedClient('server-a', configA, [serverPath, sandboxDir]);
    const clientB = await connectSandboxedClient('server-b', configB, [serverPath, sandboxDir]);

    try {
      const toolsA = await clientA.listTools();
      const toolsB = await clientB.listTools();
      expect(toolsA.tools.length).toBeGreaterThan(0);
      expect(toolsB.tools.length).toBeGreaterThan(0);

      // Both should list the sandbox directory
      const listA = await clientA.callTool({ name: 'list_directory', arguments: { path: sandboxDir } });
      const listB = await clientB.callTool({ name: 'list_directory', arguments: { path: sandboxDir } });
      expect(listA.isError).toBeFalsy();
      expect(listB.isError).toBeFalsy();
    } finally {
      try {
        await clientA.close();
      } catch {
        /* ignore */
      }
      try {
        await clientB.close();
      } catch {
        /* ignore */
      }
    }
  }, 30000);

  // Verify that SSH agent socket is accessible from within the sandbox
  // when allowUnixSockets includes the socket's parent directory.
  it.skipIf(process.platform !== 'darwin' || !process.env.SSH_AUTH_SOCK)(
    'sandboxed process can reach SSH agent socket via allowUnixSockets',
    () => {
      const sshAuthSock = process.env.SSH_AUTH_SOCK!;

      // Write settings WITH allowUnixSockets (our fix)
      const config: ResolvedSandboxParams = {
        allowWrite: [sandboxDir],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: {
          allowedDomains: ['github.com', '*.github.com'],
          deniedDomains: [],
        },
      };
      writeServerSettings('git-ssh-test', config, settingsDir);

      // The settings file should have allowUnixSockets from our fix
      const settingsPath = join(settingsDir, 'git-ssh-test.srt-settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.network.allowUnixSockets).toEqual([dirname(sshAuthSock)]);

      const wrapped = wrapServerCommand('git-ssh-test', 'node', [], { sandboxed: true, config }, settingsDir);

      // Run ssh-add -l inside the sandbox — if the socket is reachable this exits 0
      // and prints the key fingerprint. If blocked, ssh-add fails with exit code 2.
      const result = execFileSync(
        wrapped.command,
        [
          ...wrapped.args.slice(0, -1), // drop the original "-c node" command
          'ssh-add -l',
        ],
        {
          env: { ...process.env },
          timeout: 10000,
          encoding: 'utf-8',
        },
      );

      // ssh-add -l should list at least one key (the user has keys loaded)
      expect(result).toContain('SHA256:');
    },
    15000,
  );

  // Verify that WITHOUT allowUnixSockets, the SSH agent socket is NOT accessible.
  it.skipIf(process.platform !== 'darwin' || !process.env.SSH_AUTH_SOCK)(
    'sandboxed process cannot reach SSH agent socket without allowUnixSockets',
    () => {
      // Write settings WITHOUT allowUnixSockets by writing the file manually
      const config: ResolvedSandboxParams = {
        allowWrite: [sandboxDir],
        allowRead: [],
        denyRead: [],
        denyWrite: [],
        network: {
          allowedDomains: ['github.com', '*.github.com'],
          deniedDomains: [],
        },
      };
      // writeServerSettings will add allowUnixSockets, so we overwrite the file
      writeServerSettings('git-no-ssh', config, settingsDir);
      const settingsPath = join(settingsDir, 'git-no-ssh.srt-settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      delete settings.network.allowUnixSockets;
      fsWriteFileSync(settingsPath, JSON.stringify(settings, null, 2));

      const wrapped = wrapServerCommand('git-no-ssh', 'node', [], { sandboxed: true, config }, settingsDir);

      // ssh-add -l should fail because the Unix socket is blocked
      try {
        execFileSync(wrapped.command, [...wrapped.args.slice(0, -1), 'ssh-add -l'], {
          env: { ...process.env },
          timeout: 10000,
          encoding: 'utf-8',
        });
        // If we get here, the socket was unexpectedly reachable
        expect.unreachable('ssh-add should have failed without allowUnixSockets');
      } catch (err: unknown) {
        // ssh-add exits with code 2 when it can't contact the agent
        const error = err as { status: number; stderr: string; stdout: string };
        expect(error.status).not.toBe(0);
      }
    },
    15000,
  );
});
