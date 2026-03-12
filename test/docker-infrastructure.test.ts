import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import { prepareConversationStateDir } from '../src/docker/docker-infrastructure.js';
import type { ConversationStateConfig } from '../src/docker/agent-adapter.js';

/**
 * Type-level tests for the DockerInfrastructure interface.
 *
 * prepareDockerInfrastructure() requires real Docker, MCP servers,
 * and proxy infrastructure to run, so we verify the interface shape
 * rather than calling the function directly. The actual integration
 * is tested via the Docker session tests and PTY session tests.
 */

describe('DockerInfrastructure interface', () => {
  it('has all required fields', () => {
    // Compile-time type assertion: this object satisfies DockerInfrastructure.
    // If a field is missing or has the wrong type, TypeScript will error.
    const infra: DockerInfrastructure = {
      sessionId: 'test-session-id',
      sessionDir: '/tmp/test/sessions/test-session-id',
      sandboxDir: '/tmp/test/sessions/test-session-id/sandbox',
      escalationDir: '/tmp/test/sessions/test-session-id/escalations',
      auditLogPath: '/tmp/test/sessions/test-session-id/audit.jsonl',
      proxy: {
        socketPath: '/tmp/proxy.sock',
        port: undefined,
        start: async () => {},
        getHelpData: () => ({
          serverDescriptions: {},
          toolsByServer: {},
        }),
        stop: async () => {},
      },
      mitmProxy: {
        start: async () => ({ socketPath: '/tmp/mitm.sock' }),
        stop: async () => {},
      },
      docker: {
        preflight: async () => {},
        create: async () => 'container-id',
        start: async () => {},
        exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        stop: async () => {},
        remove: async () => {},
        isRunning: async () => true,
        imageExists: async () => true,
        pullImage: async () => {},
        buildImage: async () => {},
        getImageLabel: async () => undefined,
        createNetwork: async () => {},
        removeNetwork: async () => {},
        connectNetwork: async () => {},
        getContainerIp: async () => '172.17.0.2',
      },
      adapter: {
        id: 'test-agent' as import('../src/docker/agent-adapter.js').AgentId,
        displayName: 'Test Agent',
        getImage: async () => 'test-image:latest',
        generateMcpConfig: () => [],
        generateOrientationFiles: () => [],
        buildCommand: () => ['test'],
        buildSystemPrompt: () => 'test prompt',
        getProviders: () => [],
        buildEnv: () => ({}),
        extractResponse: () => ({ text: '' }),
      },
      ca: {
        certPem: 'mock-cert',
        keyPem: 'mock-key',
        certPath: '/tmp/ca-cert.pem',
        keyPath: '/tmp/ca-key.pem',
      },
      fakeKeys: new Map(),
      orientationDir: '/tmp/test/sessions/test-session-id/orientation',
      systemPrompt: 'Test system prompt',
      image: 'test-image:latest',
      useTcp: false,
      socketsDir: '/tmp/test/sessions/test-session-id/sockets',
      mitmAddr: { socketPath: '/tmp/mitm.sock' },
      authKind: 'apikey',
    };

    // Verify key fields are accessible at runtime
    expect(infra.sessionId).toBe('test-session-id');
    expect(infra.useTcp).toBe(false);
    expect(infra.fakeKeys).toBeInstanceOf(Map);
    expect(infra.mitmAddr.socketPath).toBe('/tmp/mitm.sock');
    expect(infra.systemPrompt).toBe('Test system prompt');
    expect(infra.image).toBe('test-image:latest');
    expect(infra.socketsDir).toContain('sockets');
  });

  it('supports TCP mode with port-based mitmAddr', () => {
    const tcpAddr: DockerInfrastructure['mitmAddr'] = { port: 8443 };
    expect(tcpAddr.port).toBe(8443);
    expect(tcpAddr.socketPath).toBeUndefined();
  });

  it('supports UDS mode with socketPath-based mitmAddr', () => {
    const udsAddr: DockerInfrastructure['mitmAddr'] = { socketPath: '/tmp/mitm.sock' };
    expect(udsAddr.socketPath).toBe('/tmp/mitm.sock');
    expect(udsAddr.port).toBeUndefined();
  });
});

describe('prepareConversationStateDir', () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'conv-state-test-'));
  });

  afterEach(() => {
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('creates state dir and seeds files on first run', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [
        { path: 'data/', content: '' },
        { path: 'config.json', content: '{"key": "value"}' },
      ],
      resumeFlags: ['--resume'],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    expect(stateDir).toBe(join(sessionDir, 'test-state'));
    expect(existsSync(join(stateDir, 'data'))).toBe(true);
    expect(readFileSync(join(stateDir, 'config.json'), 'utf-8')).toBe('{"key": "value"}');
  });

  it('calls seed content function and skips undefined results', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [
        { path: 'present.json', content: () => '{"present": true}' },
        { path: 'absent.json', content: () => undefined },
      ],
      resumeFlags: [],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);

    expect(readFileSync(join(stateDir, 'present.json'), 'utf-8')).toBe('{"present": true}');
    expect(existsSync(join(stateDir, 'absent.json'))).toBe(false);
  });

  it('does not re-seed on subsequent runs', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [{ path: 'config.json', content: '{"original": true}' }],
      resumeFlags: [],
    };

    // First run creates the file
    prepareConversationStateDir(sessionDir, config);

    // Modify the file to simulate agent writes
    const configPath = join(sessionDir, 'test-state', 'config.json');
    writeFileSync(configPath, '{"modified": true}');

    // Second run should not overwrite
    prepareConversationStateDir(sessionDir, config);
    expect(readFileSync(configPath, 'utf-8')).toBe('{"modified": true}');
  });

  it('deletes .credentials.json on every run (defense-in-depth)', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [],
      resumeFlags: [],
    };

    // First run creates the dir
    const stateDir = prepareConversationStateDir(sessionDir, config);

    // Simulate agent creating credentials
    writeFileSync(join(stateDir, '.credentials.json'), '{"token": "secret"}');
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(true);

    // Second run should delete it
    prepareConversationStateDir(sessionDir, config);
    expect(existsSync(join(stateDir, '.credentials.json'))).toBe(false);
  });

  it('handles missing .credentials.json gracefully', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [],
      resumeFlags: [],
    };

    // Should not throw even when .credentials.json doesn't exist
    expect(() => prepareConversationStateDir(sessionDir, config)).not.toThrow();
  });

  it('creates nested directories for seed file paths', () => {
    const config: ConversationStateConfig = {
      hostDirName: 'test-state',
      containerMountPath: '/root/.test/',
      seed: [{ path: 'deep/nested/file.txt', content: 'hello' }],
      resumeFlags: [],
    };

    const stateDir = prepareConversationStateDir(sessionDir, config);
    expect(readFileSync(join(stateDir, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('hello');
  });
});
