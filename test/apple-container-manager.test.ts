import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAppleContainerManager,
  buildAppleCreateArgs,
  checkAppleContainerAvailable,
  type AppleContainerHostInfo,
} from '../src/docker/apple-container-manager.js';
import { type ExecFileFn } from '../src/docker/docker-manager.js';
import type { SpawnFn } from '../src/docker/spawn-with-idle-timeout.js';
import type { DockerContainerConfig } from '../src/docker/types.js';
import type { DockerAvailability } from '../src/docker/docker-probe.js';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

type ExecCall = {
  cmd: string;
  args: readonly string[];
  opts: { timeout?: number; maxBuffer?: number };
};

type MockResponse =
  | { stdout: string; stderr?: string }
  | { error: true; code: number; stdout?: string; stderr?: string };

/** Creates a mock exec function that records calls and returns configured results. */
function createMockExec(): {
  mockExec: ExecFileFn;
  calls: ExecCall[];
  setResponse: (stdout: string, stderr?: string) => void;
  setError: (code: number, stdout?: string, stderr?: string) => void;
  setSequence: (responses: MockResponse[]) => void;
} {
  const calls: ExecCall[] = [];
  let sequence: MockResponse[] | null = null;
  let callIndex = 0;
  let single: MockResponse = { stdout: '' };

  const respond = (response: MockResponse): { stdout: string; stderr: string } => {
    if ('error' in response) {
      throw Object.assign(new Error('Command failed'), {
        code: response.code,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
      });
    }
    return { stdout: response.stdout, stderr: response.stderr ?? '' };
  };

  const mockExec: ExecFileFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (sequence !== null) {
      const response = sequence[callIndex++] as MockResponse | undefined;
      if (!response) throw new Error('Sequence exhausted');
      return respond(response);
    }
    return respond(single);
  };

  return {
    mockExec,
    calls,
    setResponse(stdout: string, stderr = '') {
      sequence = null;
      single = { stdout, stderr };
    },
    setError(code: number, stdout = '', stderr = '') {
      sequence = null;
      single = { error: true, code, stdout, stderr };
    },
    setSequence(responses: MockResponse[]) {
      sequence = responses;
      callIndex = 0;
    },
  };
}

interface MockSpawn {
  spawn: SpawnFn;
  calls: Array<{ cmd: string; args: readonly string[]; options: SpawnOptions | undefined }>;
  exitNext: (code: number, stderrChunk?: string) => void;
}

/**
 * `SpawnFn`-shaped fake whose children exit on the next macrotask with the
 * configured code, optionally emitting a stderr chunk first. Enough to
 * exercise the streamed pull/build paths without real processes.
 */
function createMockSpawn(): MockSpawn {
  const calls: MockSpawn['calls'] = [];
  let nextExit: { code: number; stderrChunk?: string } = { code: 0 };

  const spawn: SpawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess & { killed: boolean };
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    const { code, stderrChunk } = nextExit;
    setImmediate(() => {
      if (stderrChunk) stderr.write(stderrChunk);
      child.emit('close', code, null);
    });
    return child;
  };

  return {
    spawn,
    calls,
    exitNext(code: number, stderrChunk?: string) {
      nextExit = { code, stderrChunk };
    },
  };
}

function nullSink(): NodeJS.WritableStream {
  return new PassThrough();
}

const darwinHost: AppleContainerHostInfo = { platform: 'darwin', arch: 'arm64', release: '25.5.0' };
const availableProbe = async (): Promise<DockerAvailability> => ({ available: true });

const sampleConfig: DockerContainerConfig = {
  image: 'ironcurtain-claude-code:latest',
  name: 'ironcurtain-abc123',
  network: 'ironcurtain-abc123',
  mounts: [
    { source: '/home/user/.ironcurtain/sessions/abc/sandbox', target: '/workspace', readonly: false },
    { source: '/home/user/.ironcurtain/sessions/abc/orientation', target: '/etc/ironcurtain', readonly: true },
  ],
  env: {
    ANTHROPIC_API_KEY: 'sk-test-key',
    HTTPS_PROXY: 'http://192.168.214.1:9999',
  },
  command: ['sleep', 'infinity'],
  bundleLabel: 'abc-bundle-id',
  resources: { memoryMb: 4096, cpus: 2 },
};

const inspectRunning = JSON.stringify([
  {
    configuration: { labels: { 'ironcurtain.bundle': 'abc-bundle-id' } },
    status: {
      state: 'running',
      networks: [{ network: 'ironcurtain-abc123', ipv4Address: '192.168.214.2/24', ipv4Gateway: '192.168.214.1' }],
    },
  },
]);

describe('buildAppleCreateArgs', () => {
  it('builds the full create argument list', () => {
    const args = buildAppleCreateArgs(sampleConfig);

    expect(args[0]).toBe('create');
    expect(args).toContain('--name');
    expect(args).toContain('ironcurtain-abc123');
    expect(args).toContain('--network');
    expect(args).toContain('--init');
    expect(args.join(' ')).toContain('--cap-drop ALL');
    expect(args.join(' ')).toContain('--mount source=/home/user/.ironcurtain/sessions/abc/sandbox,target=/workspace');
    expect(args.join(' ')).toContain(
      '--mount source=/home/user/.ironcurtain/sessions/abc/orientation,target=/etc/ironcurtain,readonly',
    );
    expect(args.join(' ')).toContain('-e ANTHROPIC_API_KEY=sk-test-key');
    expect(args.join(' ')).toContain('--label ironcurtain.bundle=abc-bundle-id');
    expect(args.join(' ')).toContain('--memory 4096M');
    expect(args.join(' ')).toContain('--cpus 2');
    // image followed by command
    expect(args.slice(-3)).toEqual(['ironcurtain-claude-code:latest', 'sleep', 'infinity']);
  });

  it('never emits --add-host or --restart flags', () => {
    const args = buildAppleCreateArgs(sampleConfig);
    expect(args.join(' ')).not.toContain('--add-host');
    expect(args.join(' ')).not.toContain('--restart');
  });

  it('emits workflow and scope labels only when set', () => {
    const args = buildAppleCreateArgs({ ...sampleConfig, workflowLabel: 'wf-1', scopeLabel: 'primary' });
    expect(args.join(' ')).toContain('--label ironcurtain.workflow=wf-1');
    expect(args.join(' ')).toContain('--label ironcurtain.scope=primary');

    const without = buildAppleCreateArgs(sampleConfig);
    expect(without.join(' ')).not.toContain('ironcurtain.workflow');
    expect(without.join(' ')).not.toContain('ironcurtain.scope');
  });

  it('emits capability re-adds, ports, entrypoint, tty, and user', () => {
    const args = buildAppleCreateArgs({
      ...sampleConfig,
      capAdd: ['SETUID', 'SETGID'],
      ports: ['127.0.0.1:18080:8080'],
      entrypoint: '/bin/sh',
      tty: true,
      user: 'codespace',
    });
    expect(args.join(' ')).toContain('--cap-add SETUID');
    expect(args.join(' ')).toContain('--cap-add SETGID');
    expect(args.join(' ')).toContain('--publish 127.0.0.1:18080:8080');
    expect(args.join(' ')).toContain('--entrypoint /bin/sh');
    expect(args).toContain('-t');
    expect(args.join(' ')).toContain('--user codespace');
  });

  it('throws on extraHosts (no --add-host equivalent)', () => {
    expect(() => buildAppleCreateArgs({ ...sampleConfig, extraHosts: ['host.docker.internal:172.30.0.3'] })).toThrow(
      /extra host mappings/,
    );
  });

  it('throws on restartPolicy', () => {
    expect(() => buildAppleCreateArgs({ ...sampleConfig, restartPolicy: 'unless-stopped' })).toThrow(
      /restart policies/,
    );
  });

  it("throws on network 'none'", () => {
    expect(() => buildAppleCreateArgs({ ...sampleConfig, network: 'none' })).toThrow(/host-only/);
  });

  it('throws on mount paths the --mount format cannot escape', () => {
    expect(() =>
      buildAppleCreateArgs({
        ...sampleConfig,
        mounts: [{ source: '/tmp/a,b', target: '/workspace', readonly: false }],
      }),
    ).toThrow(/cannot escape/);
  });
});

describe('checkAppleContainerAvailable', () => {
  let mock: ReturnType<typeof createMockExec>;

  beforeEach(() => {
    mock = createMockExec();
  });

  it('reports unavailable on non-darwin platforms', async () => {
    const result = await checkAppleContainerAvailable(mock.mockExec, {
      platform: 'linux',
      arch: 'arm64',
      release: '6.5.0',
    });
    expect(result.available).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });

  it('reports unavailable on Intel Macs', async () => {
    const result = await checkAppleContainerAvailable(mock.mockExec, {
      platform: 'darwin',
      arch: 'x64',
      release: '25.0.0',
    });
    expect(result.available).toBe(false);
  });

  it('reports unavailable before macOS 26 (Darwin 25)', async () => {
    const result = await checkAppleContainerAvailable(mock.mockExec, {
      platform: 'darwin',
      arch: 'arm64',
      release: '24.6.0',
    });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toMatch(/macOS 26/);
  });

  it('reports unavailable when the binary is missing', async () => {
    mock.setError(1, '', 'command not found');
    const result = await checkAppleContainerAvailable(mock.mockExec, darwinHost);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.detailedMessage).toMatch(/github.com\/apple\/container/);
  });

  it('reports unavailable on pre-1.0 versions', async () => {
    mock.setResponse('container CLI version 0.12.3 (build: release, commit: abc)');
    const result = await checkAppleContainerAvailable(mock.mockExec, darwinHost);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toMatch(/too old/);
  });

  it('reports unavailable when system services are not running', async () => {
    mock.setSequence([
      { stdout: 'container CLI version 1.0.0 (build: release, commit: ee848e3)' },
      { error: true, code: 1, stderr: 'apiserver not running' },
    ]);
    const result = await checkAppleContainerAvailable(mock.mockExec, darwinHost);
    expect(result.available).toBe(false);
    if (!result.available) expect(result.detailedMessage).toMatch(/container system start/);
  });

  it('reports available when all checks pass', async () => {
    mock.setSequence([
      { stdout: 'container CLI version 1.0.0 (build: release, commit: ee848e3)' },
      { stdout: 'status running' },
    ]);
    const result = await checkAppleContainerAvailable(mock.mockExec, darwinHost);
    expect(result).toEqual({ available: true });
    expect(mock.calls[0]?.args).toEqual(['--version']);
    expect(mock.calls[1]?.args).toEqual(['system', 'status']);
  });
});

describe('AppleContainerManager', () => {
  let mock: ReturnType<typeof createMockExec>;

  beforeEach(() => {
    mock = createMockExec();
  });

  function manager() {
    return createAppleContainerManager(mock.mockExec, availableProbe);
  }

  describe('create / start', () => {
    it('runs container create and returns the trimmed id', async () => {
      mock.setResponse('ironcurtain-abc123\n');
      const id = await manager().create(sampleConfig);
      expect(id).toBe('ironcurtain-abc123');
      expect(mock.calls[0]?.cmd).toBe('container');
      expect(mock.calls[0]?.args[0]).toBe('create');
    });

    it('starts by name', async () => {
      mock.setResponse('');
      await manager().start('ironcurtain-abc123');
      expect(mock.calls[0]?.args).toEqual(['start', 'ironcurtain-abc123']);
    });
  });

  describe('exec', () => {
    it('pins --user codespace by default', async () => {
      mock.setResponse('out');
      const result = await manager().exec('c1', ['echo', 'hi']);
      expect(mock.calls[0]?.args).toEqual(['exec', '--user', 'codespace', 'c1', 'echo', 'hi']);
      expect(result).toEqual({ exitCode: 0, stdout: 'out', stderr: '' });
    });

    it('passes an explicit exec user', async () => {
      mock.setResponse('');
      await manager().exec('c1', ['id'], undefined, 'root');
      expect(mock.calls[0]?.args).toEqual(['exec', '--user', 'root', 'c1', 'id']);
    });

    it('omits --user when execUser is null', async () => {
      mock.setResponse('');
      await manager().exec('c1', ['id'], undefined, null);
      expect(mock.calls[0]?.args).toEqual(['exec', 'c1', 'id']);
    });

    it('maps non-zero exits to the result instead of throwing', async () => {
      mock.setError(3, 'partial', 'boom');
      const result = await manager().exec('c1', ['false']);
      expect(result).toEqual({ exitCode: 3, stdout: 'partial', stderr: 'boom' });
    });
  });

  describe('stop / remove', () => {
    it('stops with the grace period and swallows errors', async () => {
      mock.setResponse('');
      await manager().stop('c1');
      expect(mock.calls[0]?.args).toEqual(['stop', '--time', '10', 'c1']);

      mock.setError(1, '', 'not running');
      await expect(manager().stop('c1')).resolves.toBeUndefined();
    });

    it('force-deletes and swallows errors', async () => {
      mock.setResponse('');
      await manager().remove('c1');
      expect(mock.calls[0]?.args).toEqual(['delete', '--force', 'c1']);

      mock.setError(1, '', 'not found');
      await expect(manager().remove('c1')).resolves.toBeUndefined();
    });
  });

  describe('inspect-backed queries', () => {
    it('isRunning parses status.state', async () => {
      mock.setResponse(inspectRunning);
      expect(await manager().isRunning('c1')).toBe(true);

      mock.setResponse(JSON.stringify([{ status: { state: 'stopped' } }]));
      expect(await manager().isRunning('c1')).toBe(false);

      mock.setError(1, '', 'container not found: c1');
      expect(await manager().isRunning('c1')).toBe(false);
    });

    it('containerExists follows the inspect exit code', async () => {
      mock.setResponse(inspectRunning);
      expect(await manager().containerExists('c1')).toBe(true);

      mock.setError(1, '', 'container not found: c1');
      expect(await manager().containerExists('c1')).toBe(false);
    });

    it('getContainerLabel reads configuration.labels', async () => {
      mock.setResponse(inspectRunning);
      expect(await manager().getContainerLabel('c1', 'ironcurtain.bundle')).toBe('abc-bundle-id');
      expect(await manager().getContainerLabel('c1', 'missing')).toBeUndefined();
    });

    it('getContainerIp strips the CIDR suffix', async () => {
      mock.setResponse(inspectRunning);
      expect(await manager().getContainerIp('c1', 'ironcurtain-abc123')).toBe('192.168.214.2');
    });

    it('getContainerIp retries then throws when no address appears', async () => {
      mock.setResponse(JSON.stringify([{ status: { state: 'running', networks: [] } }]));
      await expect(manager().getContainerIp('c1', 'ironcurtain-abc123')).rejects.toThrow(/No IP address/);
      expect(mock.calls.length).toBe(5);
    });
  });

  describe('images', () => {
    it('imageExists follows the image inspect exit code', async () => {
      mock.setResponse('[{}]');
      expect(await manager().imageExists('img')).toBe(true);
      mock.setError(1, '', 'image not found: img');
      expect(await manager().imageExists('img')).toBe(false);
    });

    it('getImageLabel reads variant config labels', async () => {
      mock.setResponse(
        JSON.stringify([
          {
            id: 'f3d286',
            variants: [{ config: { config: { Labels: { 'ironcurtain.build-hash': 'abc123' } } } }],
          },
        ]),
      );
      expect(await manager().getImageLabel('img', 'ironcurtain.build-hash')).toBe('abc123');
      expect(await manager().getImageLabel('img', 'missing')).toBeUndefined();
    });

    it('getImageId normalizes image digests', async () => {
      mock.setResponse(JSON.stringify([{ id: 'sha256:f3d28607ddd7' }]));
      expect(await manager().getImageId('img')).toBe('f3d28607ddd7');
    });

    it('getImageId falls back to the container image digest', async () => {
      mock.setSequence([
        { error: true, code: 1, stderr: 'image not found: c1' },
        {
          stdout: JSON.stringify([{ configuration: { image: { descriptor: { digest: 'sha256:f3d28607ddd7' } } } }]),
        },
      ]);
      expect(await manager().getImageId('c1')).toBe('f3d28607ddd7');
    });
  });

  describe('networks', () => {
    it('creates host-only networks with subnet', async () => {
      mock.setResponse('net1');
      await manager().createNetwork('net1', { internal: true, subnet: '192.168.214.0/24' });
      expect(mock.calls[0]?.args).toEqual(['network', 'create', '--internal', '--subnet', '192.168.214.0/24', 'net1']);
    });

    it('tolerates already-existing networks', async () => {
      mock.setError(1, '', 'Error: network net1 already exists');
      await expect(manager().createNetwork('net1', { internal: true })).resolves.toBeUndefined();
    });

    it('rejects explicit gateways', async () => {
      await expect(manager().createNetwork('net1', { gateway: '10.0.0.1' })).rejects.toThrow(/gateway/);
      expect(mock.calls).toHaveLength(0);
    });

    it('removes networks and swallows errors', async () => {
      mock.setError(1, '', 'Error: failed to delete one or more networks');
      await expect(manager().removeNetwork('net1')).resolves.toBeUndefined();
      expect(mock.calls[0]?.args).toEqual(['network', 'delete', 'net1']);
    });

    it('refuses connectNetwork', async () => {
      await expect(manager().connectNetwork('net1', 'c1')).rejects.toThrow(/additional networks/);
    });
  });

  describe('preflight', () => {
    it('throws when the runtime is unavailable', async () => {
      const unavailable = async (): Promise<DockerAvailability> => ({
        available: false,
        reason: 'container services not running',
        detailedMessage: 'Start it with `container system start`.',
      });
      const m = createAppleContainerManager(mock.mockExec, unavailable);
      await expect(m.preflight('img')).rejects.toThrow(/container system start/);
    });

    it('throws when the image is missing', async () => {
      mock.setError(1, '', 'image not found: img');
      await expect(manager().preflight('img')).rejects.toThrow(/image not found/i);
    });
  });

  describe('removeStaleContainer', () => {
    it('returns false when the container does not exist', async () => {
      mock.setError(1, '', 'container not found: c1');
      expect(await manager().removeStaleContainer('c1')).toBe(false);
    });

    it('skips containers without the bundle label', async () => {
      mock.setResponse(JSON.stringify([{ configuration: { labels: {} }, status: { state: 'stopped' } }]));
      expect(await manager().removeStaleContainer('c1')).toBe(false);
    });

    it('stops and removes a labeled stale container', async () => {
      mock.setSequence([
        { stdout: inspectRunning }, // containerExists
        { stdout: inspectRunning }, // getContainerLabel
        { stdout: '' }, // stop
        { stdout: '' }, // delete
        { error: true, code: 1, stderr: 'container not found: c1' }, // containerExists (verify)
      ]);
      expect(await manager().removeStaleContainer('c1')).toBe(true);
      expect(mock.calls[2]?.args[0]).toBe('stop');
      expect(mock.calls[3]?.args[0]).toBe('delete');
    });
  });

  describe('streamed pull / build', () => {
    it('pulls with plain progress through the container binary', async () => {
      const spawn = createMockSpawn();
      const m = createAppleContainerManager(mock.mockExec, availableProbe, {
        spawn: spawn.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });
      await m.pullImage('ubuntu:latest');
      expect(spawn.calls[0]?.cmd).toBe('container');
      expect(spawn.calls[0]?.args).toEqual(['image', 'pull', '--progress', 'plain', 'ubuntu:latest']);
    });

    it('builds with tag, dockerfile, and labels', async () => {
      const spawn = createMockSpawn();
      const m = createAppleContainerManager(mock.mockExec, availableProbe, {
        spawn: spawn.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });
      await m.buildImage('img:latest', '/ctx/Dockerfile', '/ctx', { 'ironcurtain.build-hash': 'abc' });
      expect(spawn.calls[0]?.args).toEqual([
        'build',
        '--progress',
        'plain',
        '-t',
        'img:latest',
        '-f',
        '/ctx/Dockerfile',
        '--label',
        'ironcurtain.build-hash=abc',
        '/ctx',
      ]);
    });

    it('surfaces the Rosetta remediation hint on builder bootstrap failures', async () => {
      const spawn = createMockSpawn();
      spawn.exitNext(1, 'Error: internalError: "failed to bootstrap container" Rosetta is not installed');
      const m = createAppleContainerManager(mock.mockExec, availableProbe, {
        spawn: spawn.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });
      await expect(m.buildImage('img:latest', '/ctx/Dockerfile', '/ctx')).rejects.toThrow(
        /softwareupdate --install-rosetta/,
      );
    });
  });
});
