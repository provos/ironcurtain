import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDockerManager,
  buildCreateArgs,
  BUILD_IDLE_TIMEOUT_MS,
  PULL_IDLE_TIMEOUT_MS,
  type ExecFileFn,
} from '../src/docker/docker-manager.js';
import { spawnWithIdleTimeout, type SpawnFn } from '../src/docker/spawn-with-idle-timeout.js';
import type { CreateDockerProgressSinkOptions, DockerProgressSink } from '../src/docker/docker-progress-sink.js';
import type { DockerContainerConfig } from '../src/docker/types.js';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

type ExecCall = {
  cmd: string;
  args: readonly string[];
  opts: { timeout?: number; maxBuffer?: number };
};

type MockResponse =
  | { stdout: string; stderr?: string }
  | { error: true; code: number; stdout?: string; stderr?: string };

interface MockState {
  responseStdout: string;
  responseStderr: string;
  shouldError: boolean;
  errorCode: number;
  errorStdout: string;
  errorStderr: string;
  sequence: MockResponse[] | null;
  callIndex: number;
}

/** Creates a mock exec function that records calls and returns configured results. */
function createMockExec(): {
  mockExec: ExecFileFn;
  calls: ExecCall[];
  setResponse: (stdout: string, stderr?: string) => void;
  setError: (code: number, stdout?: string, stderr?: string) => void;
  setSequence: (responses: MockResponse[]) => void;
} {
  const calls: ExecCall[] = [];
  const state: MockState = {
    responseStdout: '',
    responseStderr: '',
    shouldError: false,
    errorCode: 1,
    errorStdout: '',
    errorStderr: '',
    sequence: null,
    callIndex: 0,
  };

  const mockExec: ExecFileFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });

    if (state.sequence !== null) {
      const response = state.sequence[state.callIndex++] as MockResponse | undefined;
      if (!response) throw new Error('Sequence exhausted');
      if ('error' in response) {
        throw Object.assign(new Error('Command failed'), {
          code: response.code,
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
        });
      }
      return { stdout: response.stdout, stderr: response.stderr ?? '' };
    }

    if (state.shouldError) {
      throw Object.assign(new Error('Command failed'), {
        code: state.errorCode,
        stdout: state.errorStdout,
        stderr: state.errorStderr,
      });
    }
    return { stdout: state.responseStdout, stderr: state.responseStderr };
  };

  return {
    mockExec,
    calls,
    setResponse(stdout: string, stderr = '') {
      state.sequence = null;
      state.shouldError = false;
      state.responseStdout = stdout;
      state.responseStderr = stderr;
    },
    setError(code: number, stdout = '', stderr = '') {
      state.sequence = null;
      state.shouldError = true;
      state.errorCode = code;
      state.errorStdout = stdout;
      state.errorStderr = stderr;
    },
    setSequence(responses: MockResponse[]) {
      state.sequence = responses;
      state.callIndex = 0;
    },
  };
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: SpawnOptions | undefined;
}

interface FakeChildHandle {
  child: ChildProcess;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  spawnError: (err: Error) => void;
}

interface MockSpawn {
  spawn: SpawnFn;
  calls: SpawnCall[];
  handles: FakeChildHandle[];
}

/**
 * Builds a `SpawnFn`-shaped fake plus handles for driving each spawned child
 * (emit stdout/stderr chunks, fire the close event, etc.). Lets us exercise
 * the streaming + idle-timeout path without launching real processes.
 */
function createMockSpawn(): MockSpawn {
  const calls: SpawnCall[] = [];
  const handles: FakeChildHandle[] = [];

  const spawn: SpawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess & { killed: boolean };
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = (() => {
      child.killed = true;
      return true;
    }) as ChildProcess['kill'];

    handles.push({
      child,
      emitStdout: (chunk: string) => stdout.write(chunk),
      emitStderr: (chunk: string) => stderr.write(chunk),
      exit: (code: number | null, signal: NodeJS.Signals | null = null) => {
        child.emit('close', code, signal);
      },
      spawnError: (err: Error) => {
        child.emit('error', err);
      },
    });

    return child;
  };

  return { spawn, calls, handles };
}

/** Silent writable so tests don't spew docker output into the test runner. */
function nullSink(): NodeJS.WritableStream {
  return new PassThrough();
}

interface SpyProgressSinkHandle {
  factory: (opts: CreateDockerProgressSinkOptions) => DockerProgressSink;
  /** Each created sink, in construction order. */
  sinks: Array<{
    operation: CreateDockerProgressSinkOptions['operation'];
    finishCalls: boolean[];
    dumpRecentCalls: number;
  }>;
}

/**
 * Builds a `progressSinkFactory` that records calls to `finish` and
 * `dumpRecent` on each constructed sink. The sink itself is just a
 * pair of `PassThrough` streams so the streaming pipeline can drain
 * normally.
 */
function createSpyProgressSink(): SpyProgressSinkHandle {
  const sinks: SpyProgressSinkHandle['sinks'] = [];
  const factory = (opts: CreateDockerProgressSinkOptions): DockerProgressSink => {
    const entry = {
      operation: opts.operation,
      finishCalls: [] as boolean[],
      dumpRecentCalls: 0,
    };
    sinks.push(entry);
    return {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      finish: (success: boolean) => {
        entry.finishCalls.push(success);
      },
      dumpRecent: () => {
        entry.dumpRecentCalls += 1;
      },
    };
  };
  return { factory, sinks };
}

const sampleConfig: DockerContainerConfig = {
  image: 'ironcurtain-claude-code:latest',
  name: 'ironcurtain-abc123',
  network: 'ironcurtain-abc123',
  mounts: [
    { source: '/home/user/.ironcurtain/sessions/abc/sandbox', target: '/workspace', readonly: false },
    { source: '/home/user/.ironcurtain/sessions/abc', target: '/run/ironcurtain', readonly: false },
    { source: '/home/user/.ironcurtain/sessions/abc/orientation', target: '/etc/ironcurtain', readonly: true },
  ],
  env: {
    ANTHROPIC_API_KEY: 'sk-test-key',
    HTTPS_PROXY: 'http://host.docker.internal:9999',
  },
  command: ['sleep', 'infinity'],
  bundleLabel: 'abc-bundle-id',
  resources: { memoryMb: 4096, cpus: 2 },
};

describe('DockerManager', () => {
  let mock: ReturnType<typeof createMockExec>;

  beforeEach(() => {
    mock = createMockExec();
  });

  describe('buildCreateArgs', () => {
    it('builds correct docker create arguments', () => {
      const args = buildCreateArgs(sampleConfig);

      expect(args[0]).toBe('create');
      expect(args).toContain('--name');
      expect(args[args.indexOf('--name') + 1]).toBe('ironcurtain-abc123');
      expect(args).toContain('--network');
      expect(args[args.indexOf('--network') + 1]).toBe('ironcurtain-abc123');
      expect(args).toContain('--cap-drop=ALL');
      expect(args).toContain('--add-host=host.docker.internal:host-gateway');
      expect(args).toContain('--memory');
      expect(args[args.indexOf('--memory') + 1]).toBe('4096m');
      expect(args).toContain('--cpus');
      expect(args[args.indexOf('--cpus') + 1]).toBe('2');

      const volumeArgs = args.filter((_, i) => i > 0 && args[i - 1] === '-v');
      expect(volumeArgs).toHaveLength(3);
      expect(volumeArgs[2]).toContain(':ro');

      const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '-e');
      expect(envArgs).toContain('ANTHROPIC_API_KEY=sk-test-key');
      expect(envArgs).toContain('HTTPS_PROXY=http://host.docker.internal:9999');

      const labelArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--label');
      expect(labelArgs).toContain('ironcurtain.bundle=abc-bundle-id');
      // Workflow/scope labels are absent when workflowLabel/scopeLabel are unset.
      expect(labelArgs.some((l) => l.startsWith('ironcurtain.workflow='))).toBe(false);
      expect(labelArgs.some((l) => l.startsWith('ironcurtain.scope='))).toBe(false);

      expect(args).toContain('ironcurtain-claude-code:latest');
      expect(args.slice(-2)).toEqual(['sleep', 'infinity']);
    });

    it('passes --init so docker-init reaps zombie children inside the container', () => {
      // Load-bearing for agent watchdog scripts that use `until ! kill -0
      // <pid>; do sleep ...; done` — without --init, orphaned children
      // become zombies under `sleep infinity` and `kill -0` keeps
      // returning success, deadlocking the loop. See workflow-scratch
      // entry #22 / commit a7f1c21 for the failure mode.
      const args = buildCreateArgs(sampleConfig);
      expect(args).toContain('--init');
    });

    it('emits bundle, workflow, and scope labels in workflow mode', () => {
      const config: DockerContainerConfig = {
        ...sampleConfig,
        bundleLabel: 'bundle-xyz',
        workflowLabel: 'workflow-42',
        scopeLabel: 'state-foo',
      };
      const args = buildCreateArgs(config);

      const labelArgs = args.filter((_, i) => i > 0 && args[i - 1] === '--label');
      expect(labelArgs).toContain('ironcurtain.bundle=bundle-xyz');
      expect(labelArgs).toContain('ironcurtain.workflow=workflow-42');
      expect(labelArgs).toContain('ironcurtain.scope=state-foo');
    });

    it('uses extraHosts instead of default host-gateway when provided', () => {
      const config: DockerContainerConfig = {
        ...sampleConfig,
        extraHosts: ['host.docker.internal:172.30.0.1'],
      };
      const args = buildCreateArgs(config);

      expect(args).toContain('--add-host=host.docker.internal:172.30.0.1');
      expect(args).not.toContain('--add-host=host.docker.internal:host-gateway');
    });

    it('supports multiple extraHosts entries', () => {
      const config: DockerContainerConfig = {
        ...sampleConfig,
        extraHosts: ['host.docker.internal:172.30.0.1', 'other-host:10.0.0.1'],
      };
      const args = buildCreateArgs(config);

      expect(args).toContain('--add-host=host.docker.internal:172.30.0.1');
      expect(args).toContain('--add-host=other-host:10.0.0.1');
      expect(args).not.toContain('--add-host=host.docker.internal:host-gateway');
    });

    it('uses default host-gateway when extraHosts is empty array', () => {
      const config: DockerContainerConfig = {
        ...sampleConfig,
        extraHosts: [],
      };
      const args = buildCreateArgs(config);

      expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    });

    it('emits --user when config.user is set (issue #232 Linux UID remap)', () => {
      const config: DockerContainerConfig = {
        ...sampleConfig,
        user: '0:0',
      };
      const args = buildCreateArgs(config);
      expect(args).toContain('--user');
      expect(args[args.indexOf('--user') + 1]).toBe('0:0');
    });

    it('omits --user when config.user is undefined (macOS path)', () => {
      // sampleConfig has no `user` field, so --user must be absent.
      const args = buildCreateArgs(sampleConfig);
      expect(args).not.toContain('--user');
    });
  });

  describe('preflight', () => {
    it('succeeds when Docker is available and image exists', async () => {
      mock.setResponse('');
      const probe = vi.fn().mockResolvedValue({ available: true });
      const manager = createDockerManager(mock.mockExec, probe);

      await expect(manager.preflight('test-image:latest')).resolves.toBeUndefined();
      // Daemon reachability flows through the canonical probe; only the image
      // inspect call lands on `mock.mockExec`.
      expect(probe).toHaveBeenCalledTimes(1);
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].args).toEqual(['image', 'inspect', 'test-image:latest']);
    });

    it('throws when Docker daemon is not available', async () => {
      const probe = vi.fn().mockResolvedValue({
        available: false,
        reason: 'Docker not available',
        detailedMessage: 'Cannot connect to the Docker daemon.\nIs the Docker service running?',
      });
      const manager = createDockerManager(mock.mockExec, probe);

      await expect(manager.preflight('test-image:latest')).rejects.toThrow('Docker is not available');
      // Image inspect is skipped when the daemon is unreachable.
      expect(mock.calls).toHaveLength(0);
    });

    it('surfaces the detailed message when Docker is unavailable', async () => {
      const probe = vi.fn().mockResolvedValue({
        available: false,
        reason: 'Docker not available',
        detailedMessage: 'Permission denied while connecting to the Docker daemon socket.',
      });
      const manager = createDockerManager(mock.mockExec, probe);

      await expect(manager.preflight('test-image:latest')).rejects.toThrow(/Permission denied/);
    });

    it('throws when image is not found', async () => {
      mock.setError(1, '', 'No such image');
      const probe = vi.fn().mockResolvedValue({ available: true });
      const manager = createDockerManager(mock.mockExec, probe);

      await expect(manager.preflight('missing-image:latest')).rejects.toThrow('Docker image not found');
    });
  });

  describe('create', () => {
    it('returns the container ID', async () => {
      mock.setResponse('abc123def456\n');
      const manager = createDockerManager(mock.mockExec);

      const containerId = await manager.create(sampleConfig);
      expect(containerId).toBe('abc123def456');
      expect(mock.calls[0].cmd).toBe('docker');
      expect(mock.calls[0].args[0]).toBe('create');
    });
  });

  describe('exec', () => {
    it('runs docker exec and returns output', async () => {
      mock.setResponse('task completed', '');
      const manager = createDockerManager(mock.mockExec);

      const result = await manager.exec('container-id', ['claude', '--continue', '-p', 'Hello']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('task completed');
      expect(result.stderr).toBe('');
      // `--user codespace` is always injected: agent containers are
      // created with `--user 0:0` on Linux for the UID-remap entrypoint
      // (issue #232), so every subsequent exec must opt back into the
      // codespace user explicitly.
      expect(mock.calls[0].args).toEqual([
        'exec',
        '--user',
        'codespace',
        'container-id',
        'claude',
        '--continue',
        '-p',
        'Hello',
      ]);
    });

    it('always passes --user codespace (issue #232)', async () => {
      mock.setResponse('ok');
      const manager = createDockerManager(mock.mockExec);

      await manager.exec('container-id', ['anything']);
      const args = mock.calls[0].args;
      expect(args[0]).toBe('exec');
      expect(args[1]).toBe('--user');
      expect(args[2]).toBe('codespace');
    });

    it('skips --user when execUser is null (non-agent containers)', async () => {
      // signal-cli-rest-api has no codespace account; pinning it would
      // make `docker exec` fail with "unable to find user codespace" and
      // break stale-bind-mount detection. `execUser: null` opts out.
      mock.setResponse('ok');
      const manager = createDockerManager(mock.mockExec);

      await manager.exec('signal-cli', ['test', '-d', '/data'], 5_000, null);
      const args = mock.calls[0].args;
      expect(args[0]).toBe('exec');
      expect(args).not.toContain('--user');
      expect(args).toEqual(['exec', 'signal-cli', 'test', '-d', '/data']);
    });

    it('honors a custom execUser override (string value)', async () => {
      mock.setResponse('ok');
      const manager = createDockerManager(mock.mockExec);

      await manager.exec('container-id', ['cmd'], undefined, 'root');
      const args = mock.calls[0].args;
      expect(args[0]).toBe('exec');
      expect(args[1]).toBe('--user');
      expect(args[2]).toBe('root');
    });

    it('passes an optional working directory to docker exec', async () => {
      mock.setResponse('ok');
      const manager = createDockerManager(mock.mockExec);

      await manager.exec('container-id', ['cmd'], undefined, 'codespace', '/workspace');
      expect(mock.calls[0].args).toEqual([
        'exec',
        '--user',
        'codespace',
        '--workdir',
        '/workspace',
        'container-id',
        'cmd',
      ]);
    });

    it('returns non-zero exit code without throwing', async () => {
      mock.setError(1, 'error output', 'stderr output');
      const manager = createDockerManager(mock.mockExec);

      const result = await manager.exec('container-id', ['failing-command']);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('error output');
      expect(result.stderr).toBe('stderr output');
    });

    it('passes custom timeout', async () => {
      mock.setResponse('ok');
      const manager = createDockerManager(mock.mockExec);

      await manager.exec('container-id', ['cmd'], 5000);
      expect(mock.calls[0].opts.timeout).toBe(5000);
    });

    it('detects timeout errors and returns non-zero exit code', async () => {
      // Simulate the error shape Node.js execFile produces on timeout
      const mockExecTimeout: ExecFileFn = async (cmd, args, opts) => {
        mock.calls.push({ cmd, args, opts });
        throw Object.assign(new Error('Command timed out'), {
          code: null,
          killed: true,
          signal: 'SIGTERM',
          stdout: '',
          stderr: '',
        });
      };
      const manager = createDockerManager(mockExecTimeout);

      const result = await manager.exec('container-id', ['claude', '--continue']);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  describe('stop', () => {
    it('runs docker stop with timeout', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.stop('container-id');
      expect(mock.calls[0].args).toEqual(['stop', '-t', '10', 'container-id']);
    });

    it('ignores errors from already-stopped containers', async () => {
      mock.setError(1, '', 'No such container');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.stop('container-id')).resolves.toBeUndefined();
    });
  });

  describe('remove', () => {
    it('runs docker rm -f', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.remove('container-id');
      expect(mock.calls[0].args).toEqual(['rm', '-f', 'container-id']);
    });
  });

  describe('isRunning', () => {
    it('returns true when container is running', async () => {
      mock.setResponse('true\n');
      const manager = createDockerManager(mock.mockExec);
      expect(await manager.isRunning('container-id')).toBe(true);
    });

    it('returns false when container is not running', async () => {
      mock.setResponse('false\n');
      const manager = createDockerManager(mock.mockExec);
      expect(await manager.isRunning('container-id')).toBe(false);
    });

    it('returns false on error', async () => {
      mock.setError(1);
      const manager = createDockerManager(mock.mockExec);
      expect(await manager.isRunning('nonexistent')).toBe(false);
    });
  });

  describe('createNetwork', () => {
    it('creates a Docker network', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.createNetwork('ironcurtain-abc');
      expect(mock.calls[0].args).toEqual(['network', 'create', 'ironcurtain-abc']);
    });

    it('ignores already-exists errors', async () => {
      mock.setError(1, '', 'network with name ironcurtain-abc already exists');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.createNetwork('ironcurtain-abc')).resolves.toBeUndefined();
    });

    it('passes --internal, --subnet, and --gateway options', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.createNetwork('ironcurtain-internal', {
        internal: true,
        subnet: '172.30.0.0/24',
        gateway: '172.30.0.1',
      });

      const args = mock.calls[0].args;
      expect(args).toContain('--internal');
      expect(args).toContain('--subnet');
      expect(args[args.indexOf('--subnet') + 1]).toBe('172.30.0.0/24');
      expect(args).toContain('--gateway');
      expect(args[args.indexOf('--gateway') + 1]).toBe('172.30.0.1');
      expect(args[args.length - 1]).toBe('ironcurtain-internal');
    });

    it('omits flags when options are not provided', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.createNetwork('test-net', {});

      const args = mock.calls[0].args;
      expect(args).not.toContain('--internal');
      expect(args).not.toContain('--subnet');
      expect(args).not.toContain('--gateway');
    });
  });

  describe('buildImage', () => {
    it('passes labels as --label flags', async () => {
      const spawnMock = createMockSpawn();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });

      const promise = manager.buildImage('my-image:latest', '/path/to/Dockerfile', '/context', {
        'ironcurtain.build-hash': 'abc123',
        'ironcurtain.ca-hash': 'def456',
      });

      // Wait a tick for the spawn to be registered, then close cleanly.
      await Promise.resolve();
      spawnMock.handles[0].exit(0);
      await promise;

      const args = spawnMock.calls[0].args;
      expect(spawnMock.calls[0].cmd).toBe('docker');
      expect(args[0]).toBe('build');
      expect(args).toContain('--label');
      expect(args).toContain('ironcurtain.build-hash=abc123');
      expect(args).toContain('ironcurtain.ca-hash=def456');
      expect(args[args.length - 1]).toBe('/context');
    });

    it('builds without labels when none provided', async () => {
      const spawnMock = createMockSpawn();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });

      const promise = manager.buildImage('my-image:latest', '/path/to/Dockerfile', '/context');
      await Promise.resolve();
      spawnMock.handles[0].exit(0);
      await promise;

      const args = spawnMock.calls[0].args;
      expect(args).not.toContain('--label');
    });

    it('forces BuildKit and plain progress for streamed heartbeats', async () => {
      const spawnMock = createMockSpawn();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });

      const promise = manager.buildImage('img:latest', '/Dockerfile', '/ctx');
      await Promise.resolve();
      spawnMock.handles[0].exit(0);
      await promise;

      expect(spawnMock.calls[0].args).toContain('--progress=plain');
      const env = spawnMock.calls[0].options?.env;
      expect(env?.DOCKER_BUILDKIT).toBe('1');
    });

    it('surfaces stderr tail when the build exits non-zero', async () => {
      const spawnMock = createMockSpawn();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });

      const promise = manager.buildImage('img:latest', '/Dockerfile', '/ctx');
      await Promise.resolve();
      spawnMock.handles[0].emitStderr('ERROR: Dockerfile syntax error on line 3\n');
      await new Promise((r) => setImmediate(r));
      spawnMock.handles[0].exit(1);

      await expect(promise).rejects.toThrow(/docker build .*exited with code 1.*Dockerfile syntax error/s);
    });
  });

  describe('pullImage', () => {
    it('streams docker pull and resolves on clean exit', async () => {
      const spawnMock = createMockSpawn();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });

      const promise = manager.pullImage('alpine:latest');
      await Promise.resolve();
      spawnMock.handles[0].emitStdout('latest: Pulling from library/alpine\n');
      spawnMock.handles[0].exit(0);
      await promise;

      expect(spawnMock.calls[0].cmd).toBe('docker');
      expect(spawnMock.calls[0].args).toEqual(['pull', 'alpine:latest']);
    });

    it('rejects when the spawn itself errors (e.g. docker not on PATH)', async () => {
      const spawnMock = createMockSpawn();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });

      const promise = manager.pullImage('alpine:latest');
      await Promise.resolve();
      spawnMock.handles[0].spawnError(new Error('spawn docker ENOENT'));

      await expect(promise).rejects.toThrow(/docker pull failed to spawn: spawn docker ENOENT/);
    });
  });

  // The default code path (no `stdoutSink`/`stderrSink` injected) wraps
  // pullImage/buildImage in the progress sink: success → finish(true);
  // failure → finish(false) + dumpRecent(). These tests guard the
  // dispatch via an injected spy factory so a future regression in
  // runStreamed can't silently bypass the failure-context dump.
  describe('progress sink dispatch', () => {
    it('calls finish(true) and skips dumpRecent on a clean pullImage', async () => {
      const spawnMock = createMockSpawn();
      const spy = createSpyProgressSink();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        progressSinkFactory: spy.factory,
      });

      const promise = manager.pullImage('alpine:latest');
      await Promise.resolve();
      spawnMock.handles[0].exit(0);
      await promise;

      expect(spy.sinks).toHaveLength(1);
      expect(spy.sinks[0].operation).toBe('docker pull');
      expect(spy.sinks[0].finishCalls).toEqual([true]);
      expect(spy.sinks[0].dumpRecentCalls).toBe(0);
    });

    it('calls finish(false) then dumpRecent when buildImage exits non-zero', async () => {
      const spawnMock = createMockSpawn();
      const spy = createSpyProgressSink();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        progressSinkFactory: spy.factory,
      });

      const promise = manager.buildImage('img:latest', '/Dockerfile', '/ctx');
      await Promise.resolve();
      spawnMock.handles[0].emitStderr('ERROR: bad step\n');
      await new Promise((r) => setImmediate(r));
      spawnMock.handles[0].exit(1);

      await expect(promise).rejects.toThrow(/docker build .*exited with code 1/);
      expect(spy.sinks).toHaveLength(1);
      expect(spy.sinks[0].operation).toBe('docker build');
      expect(spy.sinks[0].finishCalls).toEqual([false]);
      expect(spy.sinks[0].dumpRecentCalls).toBe(1);
    });

    it('also flushes dumpRecent when spawn itself errors', async () => {
      const spawnMock = createMockSpawn();
      const spy = createSpyProgressSink();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        progressSinkFactory: spy.factory,
      });

      const promise = manager.pullImage('alpine:latest');
      await Promise.resolve();
      spawnMock.handles[0].spawnError(new Error('spawn docker ENOENT'));

      await expect(promise).rejects.toThrow(/docker pull failed to spawn/);
      expect(spy.sinks[0].finishCalls).toEqual([false]);
      expect(spy.sinks[0].dumpRecentCalls).toBe(1);
    });

    it('skips the progress sink when stdoutSink/stderrSink are injected', async () => {
      const spawnMock = createMockSpawn();
      const spy = createSpyProgressSink();
      const manager = createDockerManager(mock.mockExec, undefined, {
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
        progressSinkFactory: spy.factory,
      });

      const promise = manager.pullImage('alpine:latest');
      await Promise.resolve();
      spawnMock.handles[0].exit(0);
      await promise;

      // Test seam wins: the factory was never called.
      expect(spy.sinks).toHaveLength(0);
    });
  });

  // The watchdog primitive is tested directly with real timers and a
  // tiny idle threshold so the test runs in milliseconds. Driving it
  // through `pullImage` would either need the real 2-minute timeout
  // (impractical) or fake timers (which leak across tests when an
  // assertion fails mid-test, breaking unrelated suites).
  describe('spawnWithIdleTimeout', () => {
    it('rejects with a labeled error when the child stays silent', async () => {
      const spawnMock = createMockSpawn();
      const promise = spawnWithIdleTimeout('docker', ['pull', 'x'], {
        idleTimeoutMs: 100,
        operation: 'docker pull',
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
        killGraceMs: 20,
      });

      await expect(promise).rejects.toThrow(/docker pull produced no output for 100ms/);
      // SIGTERM is sent on watchdog fire.
      expect(spawnMock.handles[0].child.killed).toBe(true);
    });

    it('resets the watchdog when the child emits output', async () => {
      const spawnMock = createMockSpawn();
      const promise = spawnWithIdleTimeout('docker', ['pull', 'x'], {
        idleTimeoutMs: 150,
        operation: 'docker pull',
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });

      // Heartbeat every 50ms (3× under the 150ms idle threshold) for 5
      // iterations. The slack absorbs event-loop jitter on loaded CI
      // runners that would otherwise stretch a 20ms timer past 40ms.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 50));
        spawnMock.handles[0].emitStdout(`chunk ${i}\n`);
      }
      // Now exit cleanly. The watchdog should NOT have fired.
      spawnMock.handles[0].exit(0);
      await promise;
      expect(spawnMock.handles[0].child.killed).toBe(false);
    });

    it('escalates from SIGTERM to SIGKILL after the grace period', async () => {
      const signals: NodeJS.Signals[] = [];
      // Pre-install a recording `kill` on every spawned child BEFORE the
      // watchdog can fire, so the SIGTERM that arrives ~10ms after spawn
      // is captured. Mirror Node's real semantics by flipping `child.killed`
      // to true once a signal is sent — SIGKILL escalation is gated on the
      // helper's internal `exited` flag (set in the `close` handler), not on
      // `child.killed`, so leaving the child without ever emitting `close`
      // is what lets the SIGKILL path fire.
      const recordingSpawn: SpawnFn = (cmd, args, options) => {
        const child = createMockSpawn().spawn(cmd, args, options) as ChildProcess & { killed: boolean };
        child.kill = ((signal?: NodeJS.Signals | number) => {
          signals.push(typeof signal === 'string' ? signal : 'SIGTERM');
          child.killed = true;
          return true;
        }) as ChildProcess['kill'];
        return child;
      };

      const promise = spawnWithIdleTimeout('docker', ['pull', 'x'], {
        idleTimeoutMs: 80,
        operation: 'docker pull',
        spawn: recordingSpawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
        killGraceMs: 150,
      });
      // Attach a handler immediately so the eventual rejection is observed.
      const expectation = expect(promise).rejects.toThrow();

      // Wait long enough for both the idle timer (80ms) and the kill
      // grace (150ms) to elapse, with slack for CI jitter.
      await new Promise((r) => setTimeout(r, 300));
      await expectation;

      expect(signals[0]).toBe('SIGTERM');
      expect(signals).toContain('SIGKILL');
    });

    it('skips SIGKILL when the child exits within the grace period', async () => {
      // Cooperative path: the child receives SIGTERM and emits `close`
      // before the grace expires. The helper's `exited` flag (set at the
      // top of the close handler) must keep the grace timer from firing
      // SIGKILL. Regression test for the original bug — when escalation
      // was gated on `child.killed`, this case would have sent SIGKILL
      // anyway because Node flips `killed` to true on signal *send*.
      const inner = createMockSpawn();
      const signals: NodeJS.Signals[] = [];
      const recordingSpawn: SpawnFn = (cmd, args, options) => {
        const child = inner.spawn(cmd, args, options) as ChildProcess & { killed: boolean };
        child.kill = ((signal?: NodeJS.Signals | number) => {
          signals.push(typeof signal === 'string' ? signal : 'SIGTERM');
          child.killed = true;
          return true;
        }) as ChildProcess['kill'];
        return child;
      };

      const promise = spawnWithIdleTimeout('docker', ['pull', 'x'], {
        idleTimeoutMs: 80,
        operation: 'docker pull',
        spawn: recordingSpawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
        killGraceMs: 300,
      });
      const expectation = expect(promise).rejects.toThrow();

      // Wait for the idle timer (80ms) to fire and SIGTERM to be sent.
      await new Promise((r) => setTimeout(r, 150));
      expect(signals).toEqual(['SIGTERM']);

      // Simulate the child honoring SIGTERM and exiting before the grace
      // period expires. The close handler flips `exited = true`.
      inner.handles[0].exit(143, 'SIGTERM');

      // Wait past the kill grace window (300ms) to confirm SIGKILL was NOT sent.
      await new Promise((r) => setTimeout(r, 400));
      await expectation;

      expect(signals).toEqual(['SIGTERM']);
    });

    it('reformats synchronous spawn() throws with the operation label', async () => {
      // `spawn()` can throw synchronously on invalid options/args — distinct
      // from the async `error` event for ENOENT-class failures. The helper
      // should catch and reformat so callers see a consistent error shape.
      const throwingSpawn: SpawnFn = () => {
        throw new Error('Invalid stdio option');
      };

      await expect(
        spawnWithIdleTimeout('docker', ['pull', 'x'], {
          idleTimeoutMs: 60_000,
          operation: 'docker pull',
          spawn: throwingSpawn,
          stdoutSink: nullSink(),
          stderrSink: nullSink(),
        }),
      ).rejects.toThrow(/docker pull failed to spawn: Invalid stdio option/);
    });

    it('swallows kill() throws so the watchdog still rejects cleanly', async () => {
      // If `kill()` throws (e.g. invalid signal, torn-down handle), the
      // helper must not leak the exception into the timer callback. The
      // promise should still reject with the idle-timeout error message.
      const inner = createMockSpawn();
      const throwingKillSpawn: SpawnFn = (cmd, args, options) => {
        const child = inner.spawn(cmd, args, options) as ChildProcess & { killed: boolean };
        child.kill = (() => {
          throw new Error('unexpected kill() failure');
        }) as ChildProcess['kill'];
        return child;
      };

      await expect(
        spawnWithIdleTimeout('docker', ['pull', 'x'], {
          idleTimeoutMs: 100,
          operation: 'docker pull',
          spawn: throwingKillSpawn,
          stdoutSink: nullSink(),
          stderrSink: nullSink(),
          killGraceMs: 20,
        }),
      ).rejects.toThrow(/docker pull produced no output for 100ms/);
    });

    it('passes operation label and stderr tail in non-zero exit errors', async () => {
      const spawnMock = createMockSpawn();
      const promise = spawnWithIdleTimeout('docker', ['build'], {
        idleTimeoutMs: 60_000, // generous; we'll exit explicitly
        operation: 'docker build',
        spawn: spawnMock.spawn,
        stdoutSink: nullSink(),
        stderrSink: nullSink(),
      });
      await Promise.resolve();
      spawnMock.handles[0].emitStderr('failed to compute cache key\n');
      await new Promise((r) => setImmediate(r));
      spawnMock.handles[0].exit(2);

      await expect(promise).rejects.toThrow(/docker build exited with code 2.*failed to compute cache key/s);
    });
  });

  describe('idle-timeout primitive', () => {
    // Sanity check the constants haven't drifted accidentally — they're the
    // visible contract callers (and bug reports) refer to.
    it('pull idle timeout is 120s', () => {
      expect(PULL_IDLE_TIMEOUT_MS).toBe(120_000);
    });
    it('build idle timeout is 300s', () => {
      expect(BUILD_IDLE_TIMEOUT_MS).toBe(300_000);
    });
  });

  describe('commit', () => {
    it('commits a container with pause and change options and returns the image digest', async () => {
      const digest = `sha256:${'a'.repeat(64)}`;
      mock.setResponse(`Flag --pause has been deprecated\n${digest}\n`);
      const manager = createDockerManager(mock.mockExec);

      const result = await manager.commit('container-id', {
        tag: 'ironcurtain-snapshot:wf-primary-stop',
        pause: false,
        changes: ['LABEL ironcurtain.snapshot.workflow=wf'],
        timeoutMs: 1234,
      });

      expect(result).toBe(digest);
      expect(mock.calls[0].args).toEqual([
        'commit',
        '--no-pause',
        '--change',
        'LABEL ironcurtain.snapshot.workflow=wf',
        'container-id',
        'ironcurtain-snapshot:wf-primary-stop',
      ]);
      expect(mock.calls[0].opts.timeout).toBe(1234);
    });

    it('rejects unexpected commit output', async () => {
      mock.setResponse('not-a-digest\n');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.commit('container-id')).rejects.toThrow('unexpected image id');
    });

    it('can flatten a container through docker export/import', async () => {
      const digest = `sha256:${'b'.repeat(64)}`;
      mock.setSequence([{ stdout: '' }, { stdout: `${digest}\n` }]);
      const manager = createDockerManager(mock.mockExec);

      const result = await manager.commit('container-id', {
        flatten: true,
        tag: 'ironcurtain-snapshot:wf-primary-stop',
        changes: ['LABEL ironcurtain.snapshot.workflow=wf'],
        timeoutMs: 4321,
      });

      expect(result).toBe(digest);
      expect(mock.calls[0].args[0]).toBe('export');
      expect(mock.calls[0].args[1]).toBe('--output');
      const tarPath = mock.calls[0].args[2];
      expect(mock.calls[0].args[3]).toBe('container-id');
      expect(mock.calls[1].args).toEqual([
        'import',
        '--change',
        'LABEL ironcurtain.snapshot.workflow=wf',
        tarPath,
        'ironcurtain-snapshot:wf-primary-stop',
      ]);
      expect(mock.calls[0].opts.timeout).toBe(4321);
      expect(mock.calls[1].opts.timeout).toBe(4321);
    });
  });

  describe('removeImage', () => {
    it('removes an image by reference', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.removeImage('sha256:abc123')).resolves.toBe(true);
      expect(mock.calls[0].args).toEqual(['image', 'rm', '--force', 'sha256:abc123']);
    });

    it('returns false when the image is already missing', async () => {
      mock.setError(1, '', 'No such image: sha256:abc123');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.removeImage('sha256:abc123')).resolves.toBe(false);
    });
  });

  describe('listImages and inspectImage', () => {
    it('lists images by label using full IDs and inspect metadata', async () => {
      const inspected = [
        {
          Id: 'sha256:abc123',
          RepoTags: ['ironcurtain-snapshot:wf-primary-stop'],
          Created: '2026-06-18T00:00:00Z',
          Config: { Labels: { 'ironcurtain.snapshot.workflow': 'wf' } },
        },
      ];
      mock.setSequence([{ stdout: 'sha256:abc123\n' }, { stdout: JSON.stringify(inspected) }]);
      const manager = createDockerManager(mock.mockExec);

      const images = await manager.listImages({ labelFilter: 'ironcurtain.snapshot.workflow' });

      expect(mock.calls[0].args).toEqual([
        'image',
        'ls',
        '--no-trunc',
        '--quiet',
        '--filter',
        'label=ironcurtain.snapshot.workflow',
      ]);
      expect(mock.calls[1].args).toEqual(['image', 'inspect', 'sha256:abc123']);
      expect(images).toEqual([
        {
          id: 'sha256:abc123',
          repoTags: ['ironcurtain-snapshot:wf-primary-stop'],
          created: '2026-06-18T00:00:00Z',
          labels: { 'ironcurtain.snapshot.workflow': 'wf' },
        },
      ]);
    });

    it('inspects one image and returns undefined when missing', async () => {
      mock.setSequence([
        {
          stdout: JSON.stringify([
            {
              Id: 'sha256:def456',
              RepoTags: null,
              Created: '2026-06-18T00:00:00Z',
              Config: { Labels: null },
            },
          ]),
        },
        { error: true, code: 1, stderr: 'No such image' },
      ]);
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.inspectImage('sha256:def456')).resolves.toEqual({
        id: 'sha256:def456',
        repoTags: [],
        labels: {},
        created: '2026-06-18T00:00:00Z',
      });
      await expect(manager.inspectImage('missing')).resolves.toBeUndefined();
    });
  });

  describe('getImageLabel', () => {
    it('returns label value from docker inspect', async () => {
      mock.setResponse('abc123\n');
      const manager = createDockerManager(mock.mockExec);

      const value = await manager.getImageLabel('my-image:latest', 'ironcurtain.build-hash');
      expect(value).toBe('abc123');
      expect(mock.calls[0].args).toContain('my-image:latest');
    });

    it('returns undefined for missing label', async () => {
      mock.setResponse('<no value>\n');
      const manager = createDockerManager(mock.mockExec);

      const value = await manager.getImageLabel('my-image:latest', 'nonexistent');
      expect(value).toBeUndefined();
    });

    it('returns undefined when image does not exist', async () => {
      mock.setError(1, '', 'No such image');
      const manager = createDockerManager(mock.mockExec);

      const value = await manager.getImageLabel('missing:latest', 'ironcurtain.build-hash');
      expect(value).toBeUndefined();
    });
  });

  describe('connectNetwork', () => {
    it('connects a container to a network', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.connectNetwork('ironcurtain-internal', 'container-123');
      expect(mock.calls[0].args).toEqual(['network', 'connect', 'ironcurtain-internal', 'container-123']);
    });
  });

  describe('getContainerIp', () => {
    it('returns IP address from docker inspect JSON', async () => {
      mock.setResponse(JSON.stringify({ 'ironcurtain-internal': { IPAddress: '172.30.0.3' } }) + '\n');
      const manager = createDockerManager(mock.mockExec);

      const ip = await manager.getContainerIp('container-123', 'ironcurtain-internal');
      expect(ip).toBe('172.30.0.3');
    });

    it('throws when network is not found', async () => {
      mock.setResponse(JSON.stringify({ bridge: { IPAddress: '172.17.0.2' } }) + '\n');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.getContainerIp('container-123', 'ironcurtain-internal')).rejects.toThrow('No IP address');
    });

    it('throws when IP is empty', async () => {
      mock.setResponse(JSON.stringify({ 'ironcurtain-internal': { IPAddress: '' } }) + '\n');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.getContainerIp('container-123', 'ironcurtain-internal')).rejects.toThrow('No IP address');
    });
  });

  describe('removeNetwork', () => {
    it('removes a Docker network', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.removeNetwork('ironcurtain-abc');
      expect(mock.calls[0].args).toEqual(['network', 'rm', 'ironcurtain-abc']);
    });

    it('ignores errors', async () => {
      mock.setError(1);
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.removeNetwork('ironcurtain-abc')).resolves.toBeUndefined();
    });
  });

  describe('removeStaleContainer', () => {
    it('no-ops when container does not exist', async () => {
      // docker inspect fails → containerExists returns false
      mock.setError(1, '', 'No such container');
      const manager = createDockerManager(mock.mockExec);

      const removed = await manager.removeStaleContainer('ironcurtain-sidecar-abc');
      expect(removed).toBe(false);
      // Only the inspect call, no label check or stop/rm
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].args).toEqual(['inspect', 'ironcurtain-sidecar-abc']);
    });

    it('skips removal when container lacks ironcurtain.bundle label', async () => {
      mock.setSequence([
        { stdout: '[{"Id":"abc"}]' }, // inspect → exists
        { stdout: '<no value>\n' }, // label inspect → no label
      ]);
      const manager = createDockerManager(mock.mockExec);

      const removed = await manager.removeStaleContainer('some-container');
      expect(removed).toBe(false);
      expect(mock.calls).toHaveLength(2);
    });

    it('stops and removes when container exists with bundle label', async () => {
      mock.setSequence([
        { stdout: '[{"Id":"abc"}]' }, // inspect → exists
        { stdout: 'session-123\n' }, // label inspect → has label
        { stdout: '' }, // stop
        { stdout: '' }, // rm -f
        { error: true, code: 1, stderr: 'No such container' }, // post-removal exists check → gone
      ]);
      const manager = createDockerManager(mock.mockExec);

      const removed = await manager.removeStaleContainer('ironcurtain-pty-xyz');
      expect(removed).toBe(true);
      expect(mock.calls).toHaveLength(5);
      expect(mock.calls[2].args).toContain('stop');
      expect(mock.calls[3].args).toEqual(['rm', '-f', 'ironcurtain-pty-xyz']);
    });

    it('throws when container still exists after removal', async () => {
      mock.setSequence([
        { stdout: '[{"Id":"abc"}]' }, // inspect → exists
        { stdout: 'session-123\n' }, // label inspect → has label
        { stdout: '' }, // stop
        { stdout: '' }, // rm -f
        { stdout: '[{"Id":"abc"}]' }, // post-removal exists check → still there
      ]);
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.removeStaleContainer('stuck-container')).rejects.toThrow(
        'Failed to remove stale container "stuck-container"',
      );
    });

    it('still removes when stop fails (container already stopped)', async () => {
      mock.setSequence([
        { stdout: '[{"Id":"abc"}]' }, // inspect → exists
        { stdout: 'session-456\n' }, // label inspect → has label
        { error: true, code: 1, stderr: 'container already stopped' }, // stop fails
        { stdout: '' }, // rm -f succeeds
        { error: true, code: 1, stderr: 'No such container' }, // post-removal check → gone
      ]);
      const manager = createDockerManager(mock.mockExec);

      const removed = await manager.removeStaleContainer('stale-container');
      expect(removed).toBe(true);
      expect(mock.calls).toHaveLength(5);
    });
  });
});
