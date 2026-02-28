import { describe, it, expect } from 'vitest';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';

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
