import { describe, it, expect, beforeEach } from 'vitest';
import { createDockerManager, buildCreateArgs, type ExecFileFn } from '../src/docker/docker-manager.js';
import type { DockerContainerConfig } from '../src/docker/types.js';

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
  sessionLabel: 'abc-session-id',
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
      expect(labelArgs).toContain('ironcurtain.session=abc-session-id');

      expect(args).toContain('ironcurtain-claude-code:latest');
      expect(args.slice(-2)).toEqual(['sleep', 'infinity']);
    });
  });

  describe('preflight', () => {
    it('succeeds when Docker is available and image exists', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.preflight('test-image:latest')).resolves.toBeUndefined();
      expect(mock.calls).toHaveLength(2);
      expect(mock.calls[0].args).toEqual(['info']);
      expect(mock.calls[1].args).toEqual(['image', 'inspect', 'test-image:latest']);
    });

    it('throws when Docker daemon is not available', async () => {
      mock.setError(1, '', 'Cannot connect to the Docker daemon');
      const manager = createDockerManager(mock.mockExec);

      await expect(manager.preflight('test-image:latest')).rejects.toThrow('Docker is not available');
    });

    it('throws when image is not found', async () => {
      mock.setSequence([{ stdout: '' }, { error: true, code: 1, stderr: 'No such image' }]);
      const manager = createDockerManager(mock.mockExec);

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
      expect(mock.calls[0].args).toEqual(['exec', 'container-id', 'claude', '--continue', '-p', 'Hello']);
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
  });

  describe('buildImage', () => {
    it('passes labels as --label flags', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.buildImage('my-image:latest', '/path/to/Dockerfile', '/context', {
        'ironcurtain.build-hash': 'abc123',
        'ironcurtain.ca-hash': 'def456',
      });

      const args = mock.calls[0].args;
      expect(args).toContain('--label');
      expect(args).toContain('ironcurtain.build-hash=abc123');
      expect(args).toContain('ironcurtain.ca-hash=def456');
      expect(args[args.length - 1]).toBe('/context');
    });

    it('builds without labels when none provided', async () => {
      mock.setResponse('');
      const manager = createDockerManager(mock.mockExec);

      await manager.buildImage('my-image:latest', '/path/to/Dockerfile', '/context');

      const args = mock.calls[0].args;
      expect(args).not.toContain('--label');
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
});
