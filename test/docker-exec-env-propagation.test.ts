import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerAgentSession, type DockerAgentSessionDeps } from '../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { DockerExecResult } from '../src/docker/types.js';
import { createGooseAdapter } from '../src/docker/adapters/goose.js';
import { createMockDocker, createMockProxy, createMockMitmProxy, createMockCA } from './helpers/docker-mocks.js';

describe('Docker Agent Session - Environment Variable Propagation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'env-propagation-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('passes containerEnv to docker.exec in batch mode', async () => {
    // Track exec calls
    const execCalls: Array<{
      containerId: string;
      command: readonly string[];
      timeout?: number;
      execUser?: string | null;
      workdir?: string;
      env?: Readonly<Record<string, string>>;
    }> = [];

    // Create mock docker with exec tracking
    const mockDocker = createMockDocker();
    mockDocker.exec = async (containerId, command, timeout, execUser, workdir, env) => {
      execCalls.push({ containerId, command, timeout, execUser, workdir, env });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: 'test response' }),
        stderr: '',
      } as DockerExecResult;
    };

    // Mock containerEnv with Azure OpenAI and proxy settings
    const mockContainerEnv = {
      AZURE_OPENAI_API_KEY: 'test-key-123',
      AZURE_OPENAI_ENDPOINT: 'https://test.openai.azure.com/',
      AZURE_OPENAI_DEPLOYMENT_NAME: 'gpt-5.4',
      AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
      GOOSE_PROVIDER: 'azure_openai',
      GOOSE_MODEL: 'gpt-5.4-2026-03-05',
      HTTP_PROXY: 'http://localhost:8080',
      HTTPS_PROXY: 'http://localhost:8080',
    };

    const sessionDir = join(tempDir, 'session');
    const sandboxDir = join(tempDir, 'sandbox');
    const escalationDir = join(tempDir, 'escalations');
    const auditLogPath = join(tempDir, 'audit.jsonl');

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });
    mkdirSync(escalationDir, { recursive: true });

    const infra: DockerInfrastructure = {
      bundleId: 'test-bundle' as any,
      bundleDir: sessionDir,
      workspaceDir: sandboxDir,
      escalationDir,
      auditLogPath,
      proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
      mitmProxy: createMockMitmProxy(),
      docker: mockDocker,
      adapter: createGooseAdapter(),
      ca: createMockCA(tempDir),
      fakeKeys: new Map([['api.test.com', 'sk-test-fake-key']]),
      orientationDir: join(sessionDir, 'orientation'),
      systemPrompt: 'You are a test agent.',
      image: 'ironcurtain-goose:latest',
      runtimeKind: 'docker',
      topology: 'uds',
      useTcp: false,
      socketsDir: join(sessionDir, 'sockets'),
      mitmAddr: { socketPath: '/tmp/test-mitm-proxy.sock' },
      authKind: 'apikey',
      conversationStateDir: undefined,
      conversationStateConfig: undefined,
      containerId: 'test-container-123',
      containerName: 'ironcurtain-test',
      sidecarContainerId: undefined,
      internalNetwork: undefined,
      containerEnv: mockContainerEnv,
      setTokenSessionId: () => {},
      beginCaptureSession: () => {},
      endCaptureSession: async () => {},
    };

    const config = {
      mcpServers: {},
      userConfig: {
        anthropicApiKey: null,
        resourceBudget: {
          maxTotalTokens: null,
          maxSteps: null,
          maxSessionSeconds: null,
          maxEstimatedCostUsd: null,
        },
      },
    } as any;

    const deps: DockerAgentSessionDeps = {
      infra,
      config,
      agentConversationId: 'test-conversation-id',
      agentModelOverride: undefined,
    };

    const session = new DockerAgentSession(deps);
    await session.initialize();

    // Send a message in batch mode (not PTY)
    await session.sendMessage('test message');

    // Verify docker.exec was called
    expect(execCalls).toHaveLength(1);

    // Verify containerEnv was passed to exec
    const execCall = execCalls[0];
    expect(execCall?.env).toBeDefined();
    expect(execCall?.env).toEqual(mockContainerEnv);

    // Verify Azure OpenAI credentials are in the env
    expect(execCall?.env?.AZURE_OPENAI_API_KEY).toBe('test-key-123');
    expect(execCall?.env?.AZURE_OPENAI_ENDPOINT).toBe('https://test.openai.azure.com/');
    expect(execCall?.env?.AZURE_OPENAI_DEPLOYMENT_NAME).toBe('gpt-5.4');
    expect(execCall?.env?.GOOSE_PROVIDER).toBe('azure_openai');

    // Verify proxy env vars are included
    expect(execCall?.env?.HTTP_PROXY).toBe('http://localhost:8080');
    expect(execCall?.env?.HTTPS_PROXY).toBe('http://localhost:8080');
  });

  it('containerEnv field exists in DockerInfrastructure type', () => {
    // This is a compile-time check - if containerEnv doesn't exist on the
    // interface, this test will fail to compile
    const checkType = (infra: DockerInfrastructure) => {
      const env: Readonly<Record<string, string>> = infra.containerEnv;
      expect(typeof env).toBe('object');
    };
    expect(checkType).toBeDefined();
  });
});
