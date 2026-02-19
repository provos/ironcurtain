import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import * as logger from '../src/logger.js';

// Mock external dependencies before importing session modules.
// The AgentSession uses generateText from 'ai', anthropic from '@ai-sdk/anthropic',
// and CodeModeUtcpClient from '@utcp/code-mode'. All must be mocked to avoid
// real LLM calls and real sandbox creation.

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn(() => 'mock-model'),
}));

vi.mock('@utcp/code-mode', () => ({
  CodeModeUtcpClient: {
    AGENT_PROMPT_TEMPLATE: 'mock code mode prompt template',
  },
}));

import { generateText } from 'ai';
import { createSession, SessionNotReadyError, SessionClosedError } from '../src/session/index.js';
import type { Sandbox } from '../src/sandbox/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type {
  DiagnosticEvent,
  EscalationRequest,
  SessionOptions,
} from '../src/session/types.js';
import {
  getSessionSandboxDir,
  getSessionEscalationDir,
  getSessionAuditLogPath,
  getSessionLlmLogPath,
} from '../src/config/paths.js';

const mockGenerateText = generateText as unknown as MockInstance;

// --- Test helpers ---

const TEST_HOME = `/tmp/ironcurtain-test-${process.pid}`;

function createTestConfig(): IronCurtainConfig {
  return {
    anthropicApiKey: 'test-api-key',
    auditLogPath: './audit.jsonl',
    allowedDirectory: '/tmp/ironcurtain-sandbox',
    mcpServers: {
      filesystem: {
        command: 'echo',
        args: ['test'],
      },
    },
    protectedPaths: [],
    generatedDir: '/tmp/test-generated',
    constitutionPath: '/tmp/test-constitution.md',
    agentModelId: 'claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
  };
}

function createMockSandbox(): Sandbox {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolInterfaces: vi.fn().mockReturnValue('mock tool interfaces'),
    executeCode: vi.fn().mockResolvedValue({ result: 'mock result', logs: [] }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Sandbox;
}

function createMockSandboxFactory(sandbox?: Sandbox) {
  const mock = sandbox ?? createMockSandbox();
  return vi.fn().mockResolvedValue(mock);
}

/** Returns a mock generateText result matching AI SDK v6 shape. */
function createMockGenerateResult(text = 'mock response') {
  return {
    text,
    response: {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
      ],
    },
    totalUsage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  };
}

/** Creates a session with sensible test defaults. */
async function createTestSession(overrides: Partial<SessionOptions> = {}) {
  return createSession({
    config: createTestConfig(),
    sandboxFactory: createMockSandboxFactory(),
    ...overrides,
  });
}

// --- Tests ---

describe('Session', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });

    // Default mock: generateText returns a simple text response
    mockGenerateText.mockResolvedValue(createMockGenerateResult());
  });

  afterEach(async () => {
    // Restore console in case the logger is still active from a session
    logger.teardown();
    if (originalHome !== undefined) {
      process.env.IRONCURTAIN_HOME = originalHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('lifecycle', () => {
    it('transitions through initializing -> ready states during creation', async () => {
      const session = await createTestSession();
      try {
        const info = session.getInfo();
        expect(info.status).toBe('ready');
        expect(info.turnCount).toBe(0);
        expect(info.id).toBeTruthy();
        expect(info.createdAt).toBeTruthy();
      } finally {
        await session.close();
      }
    });

    it('transitions ready -> processing -> ready during sendMessage', async () => {
      let statusDuringProcessing: string | undefined;

      const session = await createTestSession();
      try {
        mockGenerateText.mockImplementation(async () => {
          // Capture status while generateText is in flight
          statusDuringProcessing = session.getInfo().status;
          return createMockGenerateResult();
        });

        expect(session.getInfo().status).toBe('ready');
        const response = await session.sendMessage('hello');
        expect(response).toBe('mock response');
        expect(statusDuringProcessing).toBe('processing');
        expect(session.getInfo().status).toBe('ready');
      } finally {
        await session.close();
      }
    });

    it('transitions to closed after close()', async () => {
      const session = await createTestSession();
      expect(session.getInfo().status).toBe('ready');

      await session.close();
      expect(session.getInfo().status).toBe('closed');
    });

    it('resets to ready when generateText throws (session recovers)', async () => {
      mockGenerateText.mockRejectedValueOnce(new Error('LLM error'));

      const session = await createTestSession();
      try {
        await expect(session.sendMessage('hello')).rejects.toThrow('LLM error');
        expect(session.getInfo().status).toBe('ready');

        // Session should still accept messages after recovery
        mockGenerateText.mockResolvedValueOnce(createMockGenerateResult('recovered'));
        const response = await session.sendMessage('try again');
        expect(response).toBe('recovered');
      } finally {
        await session.close();
      }
    });
  });

  describe('sendMessage guards', () => {
    it('throws SessionNotReadyError when status is processing', async () => {
      // Make generateText block so we can attempt a concurrent send
      let resolveBlocking: (() => void) | undefined;
      const blockingPromise = new Promise<void>((r) => { resolveBlocking = r; });

      mockGenerateText.mockImplementation(async () => {
        await blockingPromise;
        return createMockGenerateResult();
      });

      const session = await createTestSession();
      try {
        const firstMessage = session.sendMessage('first');

        // While the first message is processing, a second should fail
        await expect(session.sendMessage('second')).rejects.toThrow(SessionNotReadyError);

        // Unblock and let the first message complete
        resolveBlocking!();
        await firstMessage;
      } finally {
        await session.close();
      }
    });

    it('throws SessionClosedError after close()', async () => {
      const session = await createTestSession();
      await session.close();

      await expect(session.sendMessage('hello')).rejects.toThrow(SessionClosedError);
    });
  });

  describe('close()', () => {
    it('is idempotent -- calling twice does not throw', async () => {
      const mockSandbox = createMockSandbox();
      const session = await createTestSession({
        sandboxFactory: createMockSandboxFactory(mockSandbox),
      });

      await session.close();
      await session.close(); // Should not throw

      expect(session.getInfo().status).toBe('closed');
      // shutdown should only be called once
      expect(mockSandbox.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('conversation history', () => {
    it('returns turns in order with correct turn numbers', async () => {
      mockGenerateText
        .mockResolvedValueOnce(createMockGenerateResult('response 1'))
        .mockResolvedValueOnce(createMockGenerateResult('response 2'))
        .mockResolvedValueOnce(createMockGenerateResult('response 3'));

      const session = await createTestSession();
      try {
        await session.sendMessage('message 1');
        await session.sendMessage('message 2');
        await session.sendMessage('message 3');

        const history = session.getHistory();
        expect(history).toHaveLength(3);

        expect(history[0].turnNumber).toBe(1);
        expect(history[0].userMessage).toBe('message 1');
        expect(history[0].assistantResponse).toBe('response 1');

        expect(history[1].turnNumber).toBe(2);
        expect(history[1].userMessage).toBe('message 2');
        expect(history[1].assistantResponse).toBe('response 2');

        expect(history[2].turnNumber).toBe(3);
        expect(history[2].userMessage).toBe('message 3');
        expect(history[2].assistantResponse).toBe('response 3');
      } finally {
        await session.close();
      }
    });

    it('records token usage in each turn', async () => {
      mockGenerateText.mockResolvedValueOnce({
        ...createMockGenerateResult(),
        totalUsage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
      });

      const session = await createTestSession();
      try {
        await session.sendMessage('hello');
        const history = session.getHistory();
        expect(history[0].usage).toEqual({
          promptTokens: 200,
          completionTokens: 80,
          totalTokens: 280,
        });
      } finally {
        await session.close();
      }
    });

    it('includes ISO 8601 timestamps on each turn', async () => {
      const session = await createTestSession();
      try {
        await session.sendMessage('hello');
        const history = session.getHistory();
        // Verify it's a valid ISO timestamp
        const parsed = new Date(history[0].timestamp);
        expect(parsed.toISOString()).toBe(history[0].timestamp);
      } finally {
        await session.close();
      }
    });

    it('passes accumulated messages to generateText on subsequent turns', async () => {
      // Capture message snapshots at call time to avoid reference mutation issues
      const capturedMessages: unknown[][] = [];

      mockGenerateText.mockImplementation(async (opts: { messages: unknown[] }) => {
        // Snapshot the messages array at call time
        capturedMessages.push([...opts.messages]);
        return createMockGenerateResult(`response ${capturedMessages.length}`);
      });

      const session = await createTestSession();
      try {
        await session.sendMessage('hello');
        await session.sendMessage('world');

        // First call: just the first user message
        expect(capturedMessages[0]).toHaveLength(1);
        expect(capturedMessages[0][0]).toEqual({ role: 'user', content: 'hello' });

        // Second call: first user + first response messages + second user
        expect(capturedMessages[1].length).toBeGreaterThanOrEqual(3);
        expect(capturedMessages[1][0]).toEqual({ role: 'user', content: 'hello' });
        const lastMsg = capturedMessages[1][capturedMessages[1].length - 1];
        expect(lastMsg).toEqual({ role: 'user', content: 'world' });
      } finally {
        await session.close();
      }
    });
  });

  describe('per-session directory structure', () => {
    it('creates sandbox/ and escalations/ subdirectories', async () => {
      const session = await createTestSession();
      try {
        const sessionId = session.getInfo().id;
        const sandboxDir = getSessionSandboxDir(sessionId);
        const escalationDir = getSessionEscalationDir(sessionId);

        expect(existsSync(sandboxDir)).toBe(true);
        expect(existsSync(escalationDir)).toBe(true);
      } finally {
        await session.close();
      }
    });

    it('sets the audit log path to the session directory', async () => {
      const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
        // Verify the config passed to the sandbox factory has the session-specific audit path
        const sessionId = config.auditLogPath.split('/sessions/')[1]?.split('/')[0];
        expect(sessionId).toBeTruthy();
        expect(config.auditLogPath).toBe(getSessionAuditLogPath(sessionId!));
        return createMockSandbox();
      });

      const session = await createTestSession({ sandboxFactory });
      await session.close();
    });

    it('creates llm-interactions.jsonl in the session directory', async () => {
      const session = await createTestSession();
      try {
        const sessionId = session.getInfo().id;
        const llmLogPath = getSessionLlmLogPath(sessionId);

        expect(existsSync(llmLogPath)).toBe(true);
      } finally {
        await session.close();
      }
    });

    it('overrides allowedDirectory to the session sandbox dir', async () => {
      const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
        // Verify the config has the session-specific sandbox directory
        expect(config.allowedDirectory).toContain('sessions/');
        expect(config.allowedDirectory).toContain('/sandbox');
        return createMockSandbox();
      });

      const session = await createTestSession({ sandboxFactory });
      await session.close();
    });
  });

  describe('escalation', () => {
    it('resolveEscalation writes response file to escalation directory', async () => {
      const onEscalation = vi.fn();
      const session = await createTestSession({ onEscalation });

      try {
        const sessionId = session.getInfo().id;
        const escalationDir = getSessionEscalationDir(sessionId);

        // Simulate what the proxy does: write a request file
        const escalationId = 'test-escalation-123';
        const requestPath = resolve(escalationDir, `request-${escalationId}.json`);
        writeFileSync(requestPath, JSON.stringify({
          escalationId,
          toolName: 'read_file',
          serverName: 'filesystem',
          arguments: { path: '/etc/hostname' },
          reason: 'Read outside sandbox',
        }));

        // Wait for the polling interval to detect it
        await new Promise((r) => setTimeout(r, 500));

        expect(onEscalation).toHaveBeenCalledTimes(1);
        const escalationReq: EscalationRequest = onEscalation.mock.calls[0][0];
        expect(escalationReq.escalationId).toBe(escalationId);
        expect(escalationReq.toolName).toBe('read_file');

        // Resolve the escalation
        await session.resolveEscalation(escalationId, 'approved');

        // Verify response file was written
        const responsePath = resolve(escalationDir, `response-${escalationId}.json`);
        expect(existsSync(responsePath)).toBe(true);
        const response = JSON.parse(readFileSync(responsePath, 'utf-8'));
        expect(response.decision).toBe('approved');
      } finally {
        await session.close();
      }
    });

    it('resolveEscalation throws if no matching escalation is pending', async () => {
      const session = await createTestSession();
      try {
        await expect(
          session.resolveEscalation('nonexistent-id', 'approved'),
        ).rejects.toThrow('No pending escalation with ID: nonexistent-id');
      } finally {
        await session.close();
      }
    });

    it('getPendingEscalation returns undefined when nothing is pending', async () => {
      const session = await createTestSession();
      try {
        expect(session.getPendingEscalation()).toBeUndefined();
      } finally {
        await session.close();
      }
    });

    it('onEscalation callback fires when request file appears', async () => {
      const onEscalation = vi.fn();
      const session = await createTestSession({ onEscalation });

      try {
        const sessionId = session.getInfo().id;
        const escalationDir = getSessionEscalationDir(sessionId);

        const escalationId = 'callback-test-456';
        writeFileSync(
          resolve(escalationDir, `request-${escalationId}.json`),
          JSON.stringify({
            escalationId,
            toolName: 'write_file',
            serverName: 'filesystem',
            arguments: { path: '/tmp/outside.txt', content: 'test' },
            reason: 'Write outside sandbox',
          }),
        );

        // Wait for polling to detect
        await new Promise((r) => setTimeout(r, 500));

        expect(onEscalation).toHaveBeenCalledOnce();
        expect(session.getPendingEscalation()?.escalationId).toBe(escalationId);
      } finally {
        await session.close();
      }
    });
  });

  describe('diagnostic log', () => {
    it('accumulates events across turns', async () => {
      // Mock generateText to trigger onStepFinish with tool calls and text
      mockGenerateText.mockImplementation(async (opts: { onStepFinish?: (step: unknown) => void }) => {
        opts.onStepFinish?.({
          toolCalls: [
            {
              toolName: 'execute_code',
              input: { code: 'console.log("turn 1")' },
            },
          ],
          text: 'Turn 1 response text',
        });
        return createMockGenerateResult('response 1');
      });

      const session = await createTestSession();
      try {
        await session.sendMessage('first');

        mockGenerateText.mockImplementation(async (opts: { onStepFinish?: (step: unknown) => void }) => {
          opts.onStepFinish?.({
            toolCalls: [
              {
                toolName: 'execute_code',
                input: { code: 'console.log("turn 2")' },
              },
            ],
            text: 'Turn 2 response text',
          });
          return createMockGenerateResult('response 2');
        });

        await session.sendMessage('second');

        const logs = session.getDiagnosticLog();
        // Each turn should produce 2 events: tool_call + agent_text
        expect(logs.length).toBe(4);
        expect(logs.filter(e => e.kind === 'tool_call')).toHaveLength(2);
        expect(logs.filter(e => e.kind === 'agent_text')).toHaveLength(2);
      } finally {
        await session.close();
      }
    });

    it('onDiagnostic callback fires during message processing', async () => {
      const diagnosticEvents: DiagnosticEvent[] = [];
      const onDiagnostic = vi.fn((event: DiagnosticEvent) => {
        diagnosticEvents.push(event);
      });

      mockGenerateText.mockImplementation(async (opts: { onStepFinish?: (step: unknown) => void }) => {
        opts.onStepFinish?.({
          toolCalls: [
            {
              toolName: 'execute_code',
              input: { code: 'return "hello"' },
            },
          ],
          text: 'The result is hello',
        });
        return createMockGenerateResult('done');
      });

      const session = await createTestSession({ onDiagnostic });
      try {
        await session.sendMessage('do something');

        expect(onDiagnostic).toHaveBeenCalled();
        expect(diagnosticEvents.some(e => e.kind === 'tool_call')).toBe(true);
        expect(diagnosticEvents.some(e => e.kind === 'agent_text')).toBe(true);
      } finally {
        await session.close();
      }
    });

    it('getDiagnosticLog returns empty array initially', async () => {
      const session = await createTestSession();
      try {
        expect(session.getDiagnosticLog()).toEqual([]);
      } finally {
        await session.close();
      }
    });
  });

  describe('session info', () => {
    it('has a unique session ID', async () => {
      const session1 = await createTestSession();
      const id1 = session1.getInfo().id;
      await session1.close();
      logger.teardown();

      const session2 = await createTestSession();
      const id2 = session2.getInfo().id;
      await session2.close();

      expect(id1).not.toBe(id2);
    });

    it('tracks turn count', async () => {
      mockGenerateText
        .mockResolvedValueOnce(createMockGenerateResult('r1'))
        .mockResolvedValueOnce(createMockGenerateResult('r2'));

      const session = await createTestSession();
      try {
        expect(session.getInfo().turnCount).toBe(0);
        await session.sendMessage('m1');
        expect(session.getInfo().turnCount).toBe(1);
        await session.sendMessage('m2');
        expect(session.getInfo().turnCount).toBe(2);
      } finally {
        await session.close();
      }
    });
  });

  describe('sandbox factory', () => {
    it('passes session-specific config to the sandbox factory', async () => {
      const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
        // The config should have session-specific paths
        expect(config.allowedDirectory).toContain(TEST_HOME);
        expect(config.auditLogPath).toContain(TEST_HOME);
        // The escalation dir should be set on the config
        expect(config.escalationDir).toBeDefined();
        expect(config.escalationDir!).toContain(TEST_HOME);
        return createMockSandbox();
      });

      const session = await createTestSession({ sandboxFactory });
      expect(sandboxFactory).toHaveBeenCalledOnce();
      await session.close();
    });

    it('wraps sandbox factory errors in SessionError', async () => {
      const sandboxFactory = vi.fn().mockRejectedValue(new Error('Sandbox init failed'));

      await expect(createTestSession({ sandboxFactory })).rejects.toThrow(
        /Session initialization failed.*Sandbox init failed/,
      );
    });

    it('calls sandbox.shutdown on close', async () => {
      const mockSandbox = createMockSandbox();
      const session = await createTestSession({
        sandboxFactory: createMockSandboxFactory(mockSandbox),
      });

      await session.close();
      expect(mockSandbox.shutdown).toHaveBeenCalledOnce();
    });
  });
});
