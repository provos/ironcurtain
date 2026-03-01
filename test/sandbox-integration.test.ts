import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  checkSandboxAvailability,
  resolveSandboxConfig,
  writeServerSettings,
  wrapServerCommand,
  cleanupSettingsFiles,
  annotateSandboxViolation,
  resolveNodeModulesBin,
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
});
