import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  SignalBotDaemon,
  parseSignalEnvelope,
  parseHashPrefix,
  isAuthorizedSender,
  normalizePhoneNumber,
} from '../../src/signal/signal-bot-daemon.js';
import type { SignalContainerManager } from '../../src/signal/signal-container.js';
import type { ResolvedSignalConfig } from '../../src/signal/signal-config.js';

// --- Mock signal-cli REST API ---

interface SentMessage {
  message: string;
  recipients: string[];
  text_mode?: string;
}

class MockSignalApi {
  private server: http.Server;
  private wss: WebSocketServer;
  readonly sentMessages: SentMessage[] = [];
  readonly port: number;
  private identities: Array<{ number: string; fingerprint: string }> = [];
  private identityEndpointDown = false;

  constructor(port: number) {
    this.port = port;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.wss = new WebSocketServer({ server: this.server });
  }

  /** Returns the text of all sent messages (convenience accessor). */
  get messageTexts(): string[] {
    return this.sentMessages.map((m) => m.message);
  }

  setIdentities(identities: Array<{ number: string; fingerprint: string }>): void {
    this.identities = identities;
  }

  setIdentityEndpointDown(down: boolean): void {
    this.identityEndpointDown = down;
  }

  simulateIncomingMessage(from: string, text: string, timestamp?: number): void {
    const envelope = JSON.stringify({
      envelope: {
        sourceNumber: from,
        dataMessage: { message: text, timestamp: timestamp ?? Date.now() },
      },
    });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(envelope);
      }
    }
  }

  simulateUntrustedIdentity(from: string, text: string): void {
    const envelope = JSON.stringify({
      envelope: {
        sourceNumber: from,
        untrustedIdentity: true,
        dataMessage: { message: text, timestamp: Date.now() },
      },
    });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(envelope);
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.wss.clients) {
      ws.close();
    }
    this.wss.close();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '', `http://127.0.0.1:${this.port}`);

    // Health check
    if (url.pathname === '/v1/health' && req.method === 'GET') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Send message
    if (url.pathname === '/v2/send' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += String(chunk)));
      req.on('end', () => {
        const parsed = JSON.parse(body) as SentMessage;
        this.sentMessages.push(parsed);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ timestamp: Date.now() }));
      });
      return;
    }

    // Identity check
    if (url.pathname.startsWith('/v1/identities/') && req.method === 'GET') {
      if (this.identityEndpointDown) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.identities));
      return;
    }

    // Receive (for drain)
    if (url.pathname.startsWith('/v1/receive/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }
}

// --- Test helpers ---

/** Short delay for async operations in integration tests. */
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls a predicate every 5ms and resolves as soon as it returns true.
 * Falls back to a timeout (default 5s) to avoid hanging forever.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Waits until mockApi.sentMessages has at least `count` entries. */
function waitForMessages(mockApi: MockSignalApi, count: number, timeoutMs = 5000): Promise<void> {
  return waitFor(() => mockApi.sentMessages.length >= count, timeoutMs);
}

/** Waits until mockApi.messageTexts contains a message matching the predicate. */
function waitForMessage(mockApi: MockSignalApi, predicate: (text: string) => boolean, timeoutMs = 5000): Promise<void> {
  return waitFor(() => mockApi.messageTexts.some(predicate), timeoutMs);
}

/** Waits until the given mock function has been called at least `count` times. */
function waitForCalls(fn: ReturnType<typeof vi.fn>, count: number, timeoutMs = 5000): Promise<void> {
  return waitFor(() => fn.mock.calls.length >= count, timeoutMs);
}

function createMockContainerManager(port: number): SignalContainerManager {
  return {
    async ensureRunning() {
      return `http://127.0.0.1:${port}`;
    },
    async waitForHealthy() {},
    async teardown() {},
    async pullImage() {},
    async exists() {
      return true;
    },
    async isRunning() {
      return true;
    },
  };
}

function createTestConfig(port: number, overrides?: Partial<ResolvedSignalConfig>): ResolvedSignalConfig {
  return {
    botNumber: '+15551234567',
    recipientNumber: '+15559876543',
    recipientIdentityKey: 'test-identity-key-abc123',
    container: {
      image: 'test:latest',
      port,
      dataDir: '/tmp/test-signal',
      containerName: 'test-signal',
    },
    maxConcurrentSessions: 3,
    ...overrides,
  };
}

// Track mock sessions and their onEscalation callbacks for per-session assertions
interface MockSessionRecord {
  session: ReturnType<typeof createMockSession>;
  onEscalation?: (request: {
    escalationId: string;
    serverName: string;
    toolName: string;
    arguments: unknown;
    reason: string;
  }) => void;
}
const createdMockSessions: MockSessionRecord[] = [];

function createMockSession() {
  const sessionId = `test-session-${createdMockSessions.length}`;
  const createdAt = new Date().toISOString();

  return {
    getInfo: () => ({
      id: sessionId,
      status: 'ready',
      turnCount: 0,
      createdAt,
    }),
    sendMessage: vi.fn().mockResolvedValue('Agent response text'),
    getHistory: () => [],
    getDiagnosticLog: () => [],
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalation: () => undefined,
    getBudgetStatus: () => ({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      stepCount: 1,
      elapsedSeconds: 5,
      estimatedCostUsd: 0.01,
      tokenTrackingAvailable: true,
      limits: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      cumulative: {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        stepCount: 1,
        activeSeconds: 5,
        estimatedCostUsd: 0.01,
      },
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock createSession to avoid real session creation.
// Each call returns a distinct mock session tracked in createdMockSessions.
// Also captures the onEscalation callback so tests can simulate escalations
// through the real callback chain.
vi.mock('../../src/session/index.js', () => ({
  createSession: vi.fn().mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
    const session = createMockSession();
    createdMockSessions.push({ session, onEscalation: options?.onEscalation });
    return Promise.resolve(session);
  }),
}));

vi.mock('../../src/config/index.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    auditLogPath: '/tmp/audit.jsonl',
    allowedDirectory: '/tmp/sandbox',
    mcpServers: {},
    protectedPaths: [],
    generatedDir: '/tmp/generated',
    constitutionPath: '/tmp/constitution.md',
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-key',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 160_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
      serverCredentials: {},
      signal: null,
    },
  }),
}));

vi.mock('../../src/logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setup: vi.fn(),
  teardown: vi.fn(),
  isActive: vi.fn().mockReturnValue(false),
}));

// --- Unit tests for pure functions ---

describe('parseSignalEnvelope', () => {
  it('extracts message from json-rpc envelope', () => {
    const raw = JSON.stringify({
      envelope: {
        sourceNumber: '+15551234567',
        dataMessage: { message: 'hello', timestamp: 12345 },
      },
    });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage?.message).toBe('hello');
    expect(env?.sourceNumber).toBe('+15551234567');
  });

  it('handles flat envelope (no json-rpc wrapping)', () => {
    const raw = JSON.stringify({
      sourceNumber: '+15551234567',
      dataMessage: { message: 'hello' },
    });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage?.message).toBe('hello');
  });

  it('returns null for non-JSON', () => {
    expect(parseSignalEnvelope('not json')).toBeNull();
  });

  it('returns envelope for typing indicators (no dataMessage)', () => {
    const raw = JSON.stringify({
      envelope: { typingMessage: { action: 'STARTED' } },
    });
    const env = parseSignalEnvelope(raw);
    expect(env?.dataMessage).toBeUndefined();
  });
});

describe('normalizePhoneNumber', () => {
  it('strips spaces', () => {
    expect(normalizePhoneNumber('+1 555 123 4567')).toBe('+15551234567');
  });

  it('returns already-normalized numbers unchanged', () => {
    expect(normalizePhoneNumber('+15551234567')).toBe('+15551234567');
  });
});

describe('isAuthorizedSender', () => {
  it('accepts matching sourceNumber', () => {
    const env = { sourceNumber: '+15551234567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });

  it('rejects non-matching sourceNumber', () => {
    const env = { sourceNumber: '+15559999999' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(false);
  });

  it('accepts matching source (fallback)', () => {
    const env = { source: '+15551234567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });

  it('rejects envelope with no sender', () => {
    const env = {};
    expect(isAuthorizedSender(env, '+15551234567')).toBe(false);
  });

  it('handles number normalization (spaces)', () => {
    const env = { sourceNumber: '+1 555 123 4567' };
    expect(isAuthorizedSender(env, '+15551234567')).toBe(true);
  });
});

describe('parseHashPrefix', () => {
  it('parses #N prefix with space', () => {
    const result = parseHashPrefix('#2 list the directory');
    expect(result.targetLabel).toBe(2);
    expect(result.messageText).toBe('list the directory');
  });

  it('returns null targetLabel when no prefix', () => {
    const result = parseHashPrefix('regular message');
    expect(result.targetLabel).toBeNull();
    expect(result.messageText).toBe('regular message');
  });

  it('parses multi-digit labels', () => {
    const result = parseHashPrefix('#12 do something');
    expect(result.targetLabel).toBe(12);
    expect(result.messageText).toBe('do something');
  });

  it('does not match # in the middle of text', () => {
    const result = parseHashPrefix('issue #2 is broken');
    expect(result.targetLabel).toBeNull();
    expect(result.messageText).toBe('issue #2 is broken');
  });

  it('requires a space after the label', () => {
    const result = parseHashPrefix('#2');
    expect(result.targetLabel).toBeNull();
    expect(result.messageText).toBe('#2');
  });

  it('preserves multiline message text', () => {
    const result = parseHashPrefix('#1 line one\nline two');
    expect(result.targetLabel).toBe(1);
    expect(result.messageText).toBe('line one\nline two');
  });
});

// --- Integration tests with mock signal-cli API ---

describe('SignalBotDaemon', () => {
  let mockApi: MockSignalApi;
  let port: number;

  // Use a random port to avoid conflicts
  beforeEach(async () => {
    port = 18100 + Math.floor(Math.random() * 900);
    mockApi = new MockSignalApi(port);
    await mockApi.start();
    // Set default identity for the configured recipient
    mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'test-identity-key-abc123' }]);
  });

  afterEach(async () => {
    await mockApi.stop();
    createdMockSessions.length = 0;

    // Restore default createSession mock in case a test overrode it
    const { createSession } = await import('../../src/session/index.js');
    vi.mocked(createSession).mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      const session = createMockSession();
      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });
  });

  function createDaemon(configOverrides?: Partial<ResolvedSignalConfig>): SignalBotDaemon {
    return new SignalBotDaemon({
      config: createTestConfig(port, configOverrides),
      containerManager: createMockContainerManager(port),
      mode: { kind: 'builtin' },
    });
  }

  /**
   * Starts a daemon, waits for it to be ready, runs the test body,
   * then shuts down and awaits the start promise. Handles lifecycle
   * so tests can focus on assertions.
   */
  async function withDaemon(
    body: (daemon: SignalBotDaemon) => Promise<void>,
    configOverrides?: Partial<ResolvedSignalConfig>,
  ): Promise<void> {
    const daemon = createDaemon(configOverrides);
    const startPromise = daemon.start();
    // Wait for the "online" message to be sent (daemon is ready)
    await waitForMessages(mockApi, 1);
    try {
      await body(daemon);
    } finally {
      await daemon.shutdown();
      await startPromise;
    }
  }

  it('sends online message on start', async () => {
    await withDaemon(async () => {
      expect(mockApi.sentMessages.length).toBeGreaterThanOrEqual(1);
      expect(mockApi.sentMessages[0].message).toContain('online');
    });
  });

  it('routes authorized messages to session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      expect(mockApi.messageTexts.some((m) => m.includes('Started a new session'))).toBe(true);
    });
  });

  it('ignores messages from unauthorized senders', async () => {
    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateIncomingMessage('+19999999999', 'I am a stranger');
      await wait(50);

      expect(mockApi.sentMessages.length).toBe(countBefore);
    });
  });

  it('handles /help control command', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const messages = mockApi.messageTexts;
      expect(messages.some((m) => m.includes('Commands:'))).toBe(true);
      expect(messages.some((m) => m.includes('/new'))).toBe(true);
      expect(messages.some((m) => m.includes('/sessions'))).toBe(true);
      expect(messages.some((m) => m.includes('/switch'))).toBe(true);
    });
  });

  it('handles /budget command with no active session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/budget');
      await waitForMessage(mockApi, (m) => m.includes('No active session'));

      expect(mockApi.messageTexts.some((m) => m.includes('No active session'))).toBe(true);
    });
  });

  it('sends styled messages via POST /v2/send', async () => {
    await withDaemon(async () => {
      const firstSent = mockApi.sentMessages[0];
      expect(firstSent.text_mode).toBe('styled');
      expect(firstSent.recipients).toEqual(['+15559876543']);
    });
  });

  it('sends goodbye message on shutdown', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    await daemon.shutdown();
    await startPromise;

    expect(mockApi.messageTexts.some((m) => m.includes('shutting down'))).toBe(true);
  });

  // --- Identity verification ---

  it('rejects envelope with untrustedIdentity flag', async () => {
    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateUntrustedIdentity('+15559876543', 'should be rejected');
      await wait(50);

      const messagesAfter = mockApi.sentMessages.slice(countBefore);
      expect(messagesAfter.every((m) => !m.message.includes('session'))).toBe(true);
    });
  });

  it('rejects when fingerprint does not match stored key', async () => {
    mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'different-key-xyz' }]);

    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateIncomingMessage('+15559876543', 'should be rejected');
      await wait(50);

      const messagesAfter = mockApi.sentMessages.slice(countBefore);
      expect(messagesAfter.every((m) => !m.message.includes('Started a new session'))).toBe(true);
    });
  });

  it('fails closed when identity API is unavailable', async () => {
    mockApi.setIdentityEndpointDown(true);

    await withDaemon(async () => {
      const countBefore = mockApi.sentMessages.length;
      mockApi.simulateIncomingMessage('+15559876543', 'should be rejected');
      await wait(50);

      const messagesAfter = mockApi.sentMessages.slice(countBefore);
      expect(messagesAfter.every((m) => !m.message.includes('Started a new session'))).toBe(true);
    });
  });

  it('retries identity check on next message after API failure (no TTL caching of failures)', async () => {
    mockApi.setIdentityEndpointDown(true);

    await withDaemon(async () => {
      // First message: rejected (API down)
      mockApi.simulateIncomingMessage('+15559876543', 'first attempt');
      await wait(50);

      // Restore API and send second message
      mockApi.setIdentityEndpointDown(false);
      mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'test-identity-key-abc123' }]);

      mockApi.simulateIncomingMessage('+15559876543', 'second attempt');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      expect(mockApi.messageTexts.some((m) => m.includes('Started a new session'))).toBe(true);
    });
  });

  // --- Escalation handling ---

  it('handles escalation approve reply', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      daemon.setPendingEscalation(1, 'esc-123');
      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      await waitForMessage(mockApi, (m) => m.includes('approved'));

      expect(mockApi.messageTexts.some((m) => m.includes('approved'))).toBe(true);
    });
  });

  it('handles escalation deny reply', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      daemon.setPendingEscalation(1, 'esc-456');
      mockApi.simulateIncomingMessage('+15559876543', '/deny');
      await waitForMessage(mockApi, (m) => m.includes('denied'));

      expect(mockApi.messageTexts.some((m) => m.includes('denied'))).toBe(true);
    });
  });

  it('rejects concurrent escalation replies', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      daemon.setPendingEscalation(1, 'esc-789');

      // Send two rapid replies (second should be blocked)
      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      mockApi.simulateIncomingMessage('+15559876543', 'deny');
      await waitForMessage(mockApi, (m) => m.includes('approved'));

      const messages = mockApi.messageTexts;
      const hasResolving = messages.some((m) => m.includes('being resolved'));
      const hasApproved = messages.some((m) => m.includes('approved'));
      expect(hasApproved || hasResolving).toBe(true);
    });
  });

  // --- Session lifecycle ---

  it('handles /quit command by ending session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/quit');
      await waitForMessage(mockApi, (m) => m.includes('Session ended'));

      expect(mockApi.messageTexts.some((m) => m.includes('Session ended'))).toBe(true);
    });
  });

  // --- Multi-session tests ---

  it('creates two concurrent sessions via /new', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      const startedCount = mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length;
      expect(startedCount).toBe(2);
    });
  });

  it('/sessions lists all active sessions', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/sessions');
      await waitForMessage(mockApi, (m) => m.includes('Active sessions'));

      const sessionList = mockApi.messageTexts.find((m) => m.includes('Active sessions'));
      expect(sessionList).toBeDefined();
      expect(sessionList).toContain('#1');
      expect(sessionList).toContain('#2');
      expect(sessionList).toContain('> #2');
    });
  });

  it('/switch changes which session receives messages', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/switch 1');
      await waitForMessage(mockApi, (m) => m.includes('Switched to session #1'));

      expect(mockApi.messageTexts.some((m) => m.includes('Switched to session #1'))).toBe(true);
    });
  });

  it('/quit ends current and auto-switches', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/quit');
      await waitForMessage(mockApi, (m) => m.includes('Switched to #1'));

      expect(mockApi.messageTexts.some((m) => m.includes('Switched to #1'))).toBe(true);
    });
  });

  it('/quit N ends a specific session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      mockApi.simulateIncomingMessage('+15559876543', '/quit 1');
      await waitForMessage(mockApi, (m) => m.includes('Session #1 ended'));

      expect(mockApi.messageTexts.some((m) => m.includes('Session #1 ended'))).toBe(true);
    });
  });

  it('escalation auto-routes to session with pending escalation', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      daemon.setPendingEscalation(1, 'esc-auto');
      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      await waitForMessage(mockApi, (m) => m.includes('approved'));

      expect(mockApi.messageTexts.some((m) => m.includes('approved'))).toBe(true);
    });
  });

  it('escalation disambiguation when multiple pending', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      daemon.setPendingEscalation(1, 'esc-a');
      daemon.setPendingEscalation(2, 'esc-b');
      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      await waitForMessage(mockApi, (m) => m.includes('Multiple escalations pending'));

      expect(mockApi.messageTexts.some((m) => m.includes('Multiple escalations pending'))).toBe(true);
    });
  });

  it('escalation with explicit label routes directly', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      daemon.setPendingEscalation(1, 'esc-x');
      daemon.setPendingEscalation(2, 'esc-y');
      mockApi.simulateIncomingMessage('+15559876543', 'approve #1');
      await waitForMessage(mockApi, (m) => m.includes('approved'));

      expect(mockApi.messageTexts.some((m) => m.includes('approved'))).toBe(true);
    });
  });

  it('max session limit enforced', async () => {
    await withDaemon(
      async () => {
        mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
        await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
        mockApi.simulateIncomingMessage('+15559876543', '/new');
        await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

        mockApi.simulateIncomingMessage('+15559876543', '/new');
        await waitForMessage(mockApi, (m) => m.includes('Session limit reached'));

        expect(mockApi.messageTexts.some((m) => m.includes('Session limit reached'))).toBe(true);
      },
      { maxConcurrentSessions: 2 },
    );
  });

  it('/sessions shows no active sessions when none exist', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/sessions');
      await waitForMessage(mockApi, (m) => m.includes('No active sessions'));

      expect(mockApi.messageTexts.some((m) => m.includes('No active sessions'))).toBe(true);
    });
  });

  it('/switch to non-existent session shows error', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/switch 5');
      await waitForMessage(mockApi, (m) => m.includes('No session #5'));

      expect(mockApi.messageTexts.some((m) => m.includes('No session #5'))).toBe(true);
    });
  });

  it('/budget N shows budget for specific session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/budget 1');
      await waitForMessage(mockApi, (m) => m.includes('budget'));

      expect(mockApi.messageTexts.some((m) => m.includes('budget'))).toBe(true);
    });
  });

  // --- Multi-escalation flow tests ---

  it('approving one escalation leaves the other still pending', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      daemon.setPendingEscalation(1, 'esc-a');
      daemon.setPendingEscalation(2, 'esc-b');

      mockApi.simulateIncomingMessage('+15559876543', 'approve #1');
      await waitForMessage(mockApi, (m) => m.includes('approved'));

      // Bare approve should auto-route to #2 (only one remaining)
      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('approved')).length >= 2);

      const messages = mockApi.messageTexts;
      expect(messages.filter((m) => m.includes('approved')).length).toBe(2);
      expect(messages.filter((m) => m.includes('Multiple escalations')).length).toBe(0);
    });
  });

  it('deny with explicit label targets the correct session', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      daemon.setPendingEscalation(1, 'esc-d1');
      daemon.setPendingEscalation(2, 'esc-d2');

      mockApi.simulateIncomingMessage('+15559876543', 'deny #2');
      await waitForMessage(mockApi, (m) => m.includes('denied'));

      expect(mockApi.messageTexts.some((m) => m.includes('denied'))).toBe(true);
      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-d2', 'denied');
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  it('full flow: disambiguate then approve one then deny the other', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      daemon.setPendingEscalation(1, 'esc-flow-1');
      daemon.setPendingEscalation(2, 'esc-flow-2');

      // Step 1: bare approve triggers disambiguation
      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      await waitForMessage(mockApi, (m) => m.includes('Multiple escalations pending'));
      expect(mockApi.messageTexts.some((m) => m.includes('Multiple escalations pending'))).toBe(true);

      // Step 2: approve #1 with label
      mockApi.simulateIncomingMessage('+15559876543', 'approve #1');
      await waitForMessage(mockApi, (m) => m.includes('approved'));
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-flow-1', 'approved');

      // Step 3: deny #2 (now only one pending, bare deny should work)
      mockApi.simulateIncomingMessage('+15559876543', 'deny');
      await waitForMessage(mockApi, (m) => m.includes('denied'));
      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-flow-2', 'denied');
    });
  });

  it('approve #N where N has no pending escalation shows error', async () => {
    await withDaemon(async (daemon) => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      daemon.setPendingEscalation(1, 'esc-only-1');
      mockApi.simulateIncomingMessage('+15559876543', 'approve #2');
      await waitForMessage(mockApi, (m) => m.includes('no pending escalation'));

      expect(mockApi.messageTexts.some((m) => m.includes('no pending escalation'))).toBe(true);
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  // --- Escalation callback chain tests ---
  // These exercise the real onEscalation callback wiring instead of
  // calling daemon.setPendingEscalation() directly, catching bugs
  // where the transport's sessionLabel is wrong.

  it('escalation via callback chain labels banner with correct session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      expect(createdMockSessions[1].onEscalation).toBeDefined();
      createdMockSessions[1].onEscalation!({
        escalationId: 'esc-callback-2',
        serverName: 'git',
        toolName: 'git_clone',
        arguments: { url: 'https://example.com' },
        reason: 'test escalation',
      });
      await waitForMessage(mockApi, (m) => m.includes('ESCALATION'));

      const banner = mockApi.messageTexts.find((m) => m.includes('ESCALATION'));
      expect(banner).toBeDefined();
      expect(banner).toContain('[#2]');
      expect(banner).not.toContain('[#1]');
    });
  });

  it('escalation via callback from session #1 labels banner with #1', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      expect(createdMockSessions[0].onEscalation).toBeDefined();
      createdMockSessions[0].onEscalation!({
        escalationId: 'esc-callback-1',
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: '/etc/passwd' },
        reason: 'protected path',
      });
      await waitForMessage(mockApi, (m) => m.includes('ESCALATION'));

      const banner = mockApi.messageTexts.find((m) => m.includes('ESCALATION'));
      expect(banner).toBeDefined();
      expect(banner).toContain('[#1]');
    });
  });

  it('approve routes to correct session when escalation was set via callback', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      createdMockSessions[1].onEscalation!({
        escalationId: 'esc-cb-resolve',
        serverName: 'git',
        toolName: 'git_clone',
        arguments: {},
        reason: 'test',
      });
      await waitForMessage(mockApi, (m) => m.includes('ESCALATION'));

      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      await waitForMessage(mockApi, (m) => m.includes('approved'));

      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-cb-resolve', 'approved');
      expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();
    });
  });

  it('concurrent callback escalations on both sessions require disambiguation', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      createdMockSessions[0].onEscalation!({
        escalationId: 'esc-both-1',
        serverName: 'git',
        toolName: 'git_push',
        arguments: {},
        reason: 'push requires approval',
      });
      createdMockSessions[1].onEscalation!({
        escalationId: 'esc-both-2',
        serverName: 'filesystem',
        toolName: 'delete_file',
        arguments: {},
        reason: 'delete requires approval',
      });
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('ESCALATION')).length >= 2);

      const banners = mockApi.messageTexts.filter((m) => m.includes('ESCALATION'));
      expect(banners.length).toBe(2);
      expect(banners.some((b) => b.includes('[#1]'))).toBe(true);
      expect(banners.some((b) => b.includes('[#2]'))).toBe(true);

      // Bare approve should require disambiguation
      mockApi.simulateIncomingMessage('+15559876543', 'approve');
      await waitForMessage(mockApi, (m) => m.includes('Multiple escalations pending'));
      expect(mockApi.messageTexts.some((m) => m.includes('Multiple escalations pending'))).toBe(true);

      // Approve #2 explicitly, then deny #1
      mockApi.simulateIncomingMessage('+15559876543', 'approve #2');
      await waitForMessage(mockApi, (m) => m.includes('approved'));
      mockApi.simulateIncomingMessage('+15559876543', 'deny');
      await waitForMessage(mockApi, (m) => m.includes('denied'));

      expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-both-2', 'approved');
      expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-both-1', 'denied');
    });
  });

  it('reproduces production scenario: session #1 escalation resolved, /new, message to #2 escalates with correct label', async () => {
    // This test reproduces the exact production bug:
    // 1. Session #1 created, processes message, escalates
    // 2. User approves session #1's escalation
    // 3. Session #1 responds
    // 4. /new creates session #2
    // 5. Message sent to session #2, session #2 escalates
    // 6. Banner should say [#2], not [#1]

    // Make session #1's sendMessage trigger an escalation via callback, then resolve
    const { createSession } = await import('../../src/session/index.js');
    const mockCreateSession = vi.mocked(createSession);

    let callCount = 0;
    mockCreateSession.mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      callCount++;
      const session = createMockSession();

      if (callCount === 1) {
        // Session #1: sendMessage triggers escalation, then resolves after approval
        session.sendMessage = vi.fn().mockImplementation(async () => {
          // Simulate the session escalating during message processing
          options?.onEscalation?.({
            escalationId: 'esc-s1-clone',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/ironcurtain.web' },
            reason: 'Remote git operations require approval',
          });
          // Yield to let escalation be processed before returning
          await wait(10);
          return 'Repository cloned successfully.';
        });
      } else if (callCount === 2) {
        // Session #2: sendMessage triggers escalation, then resolves
        session.sendMessage = vi.fn().mockImplementation(async () => {
          options?.onEscalation?.({
            escalationId: 'esc-s2-clone',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/provos.github.io' },
            reason: 'Remote git operations require approval',
          });
          await wait(10);
          return 'Clone operation was blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    // Step 1: Send message to create session #1 and trigger its escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone ironcurtain.web');
    await waitForMessage(mockApi, (m) => m.includes('ESCALATION') && m.includes('ironcurtain.web'));

    // Session #1 should be processing and have escalated
    let messages = mockApi.messageTexts;
    const banner1 = messages.find((m) => m.includes('ESCALATION') && m.includes('ironcurtain.web'));
    expect(banner1).toBeDefined();
    expect(banner1).toContain('[#1]');

    // Step 2: Approve session #1's escalation
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await waitForMessage(mockApi, (m) => m.includes('Repository cloned successfully'));

    // Session #1 should have responded
    messages = mockApi.messageTexts;
    expect(messages.some((m) => m.includes('Repository cloned successfully'))).toBe(true);

    // Step 3: /new creates session #2
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

    // Step 4: Send message to session #2 (current), which triggers escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io');
    await waitForMessage(mockApi, (m) => m.includes('ESCALATION') && m.includes('provos/provos.github.io'));

    // Step 5: The escalation banner for session #2 should say [#2], NOT [#1]
    messages = mockApi.messageTexts;
    const banner2 = messages.find((m) => m.includes('ESCALATION') && m.includes('provos/provos.github.io'));
    expect(banner2).toBeDefined();
    expect(banner2).toContain('[#2]');
    expect(banner2).not.toContain('[#1]');

    // Step 6: Deny and verify it resolves on session #2
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await waitForMessage(mockApi, (m) => m.includes('Clone operation was blocked'));

    messages = mockApi.messageTexts;
    // The deny confirmation should reference session #2
    const denyMsg = messages.find((m) => m.includes('denied'));
    expect(denyMsg).toContain('[#2]');

    // The session #2 response should also be prefixed with [#2]
    expect(messages.some((m) => m.includes('[#2]') && m.includes('Clone operation was blocked'))).toBe(true);

    // Session #1's resolveEscalation should NOT have been called for the second escalation
    expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalledWith('esc-s2-clone', 'denied');

    await daemon.shutdown();
    await startPromise;
  });

  it('race: message sent immediately after /new is routed to the new session', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'hello', 1000);
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
      expect(createdMockSessions).toHaveLength(1);
      const session1 = createdMockSessions[0].session;
      vi.mocked(session1.sendMessage).mockClear();

      // Send /new immediately followed by a message (same tick)
      mockApi.simulateIncomingMessage('+15559876543', '/new', 2000);
      mockApi.simulateIncomingMessage('+15559876543', 'work on provos.github.io', 2001);
      await waitFor(() => createdMockSessions.length >= 2);
      await waitForCalls(vi.mocked(createdMockSessions[1].session.sendMessage), 1);

      expect(createdMockSessions).toHaveLength(2);
      const session2 = createdMockSessions[1].session;

      // The message must go to session #2, not session #1
      expect(vi.mocked(session1.sendMessage)).not.toHaveBeenCalled();
      expect(vi.mocked(session2.sendMessage)).toHaveBeenCalledWith('work on provos.github.io');
    });
  });

  it('race: escalation after /new gets correct session label', async () => {
    // End-to-end test for the reported bug: escalation banner should
    // show [#2] when the message was routed to session #2 after /new.

    const { createSession } = await import('../../src/session/index.js');
    const mockCreateSession = vi.mocked(createSession);

    let callCount = 0;
    mockCreateSession.mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      callCount++;
      const session = createMockSession();

      if (callCount === 2) {
        // Session #2: sendMessage triggers escalation for provos.github.io
        session.sendMessage = vi.fn().mockImplementation(async () => {
          options?.onEscalation?.({
            escalationId: 'esc-race-s2',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/provos.github.io' },
            reason: 'approval required',
          });
          await wait(10);
          return 'Clone blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    // Create session #1
    mockApi.simulateIncomingMessage('+15559876543', 'hello', 3000);
    await waitForMessage(mockApi, (m) => m.includes('Started a new session'));
    expect(createdMockSessions).toHaveLength(1);

    // Send /new + message in rapid succession
    mockApi.simulateIncomingMessage('+15559876543', '/new', 4000);
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io', 4001);
    await waitForMessage(mockApi, (m) => m.includes('ESCALATION') && m.includes('provos/provos.github.io'));

    // The escalation banner must say [#2], not [#1]
    const messages = mockApi.messageTexts;
    const banner = messages.find((m) => m.includes('ESCALATION') && m.includes('provos/provos.github.io'));
    expect(banner).toBeDefined();
    expect(banner).toContain('[#2]');
    expect(banner).not.toContain('ESCALATION [#1]');

    // Deny and verify correct routing
    mockApi.simulateIncomingMessage('+15559876543', 'deny', 5000);
    await waitForMessage(mockApi, (m) => m.includes('denied') && m.includes('[#2]'));

    const allMessages = mockApi.messageTexts;
    // Deny confirmation should reference #2
    expect(allMessages.some((m) => m.includes('denied') && m.includes('[#2]'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('concurrent: session #1 in-flight when /new and #2 message arrive', async () => {
    // This reproduces the exact concurrent production scenario:
    // - Session #1 is STILL PROCESSING (forwardMessage hasn't returned)
    // - User sends /new → creates session #2
    // - User sends message → goes to session #2
    // - Session #2 escalates → banner should say [#2]

    const { createSession } = await import('../../src/session/index.js');
    const mockCreateSession = vi.mocked(createSession);

    // Controls for session #1's long-running message
    let resolveSession1Message: ((value: string) => void) | null = null;

    let callCount = 0;
    mockCreateSession.mockImplementation((options?: { onEscalation?: MockSessionRecord['onEscalation'] }) => {
      callCount++;
      const session = createMockSession();

      if (callCount === 1) {
        // Session #1: sendMessage blocks until we explicitly resolve it
        session.sendMessage = vi.fn().mockImplementation(() => {
          return new Promise<string>((resolve) => {
            // Fire escalation immediately
            options?.onEscalation?.({
              escalationId: 'esc-concurrent-s1',
              serverName: 'git',
              toolName: 'git_clone',
              arguments: { url: 'https://github.com/provos/ironcurtain.web' },
              reason: 'approval required',
            });
            // But DON'T resolve the message yet — session #1 stays in-flight
            resolveSession1Message = resolve;
          });
        });
      } else if (callCount === 2) {
        // Session #2: sendMessage triggers escalation, resolves after yield
        session.sendMessage = vi.fn().mockImplementation(async () => {
          options?.onEscalation?.({
            escalationId: 'esc-concurrent-s2',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/provos.github.io' },
            reason: 'approval required',
          });
          await wait(10);
          return 'Clone blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await waitForMessages(mockApi, 1);

    // Step 1: Message creates session #1 and starts processing (blocks)
    mockApi.simulateIncomingMessage('+15559876543', 'clone ironcurtain.web');
    await waitForMessage(mockApi, (m) => m.includes('ESCALATION') && m.includes('ironcurtain.web'));

    // Session #1 has escalated but its forwardMessage is still blocked
    let messages = mockApi.messageTexts;
    const banner1 = messages.find((m) => m.includes('ESCALATION') && m.includes('ironcurtain.web'));
    expect(banner1).toContain('[#1]');

    // Step 2: Approve session #1's escalation
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await waitForMessage(mockApi, (m) => m.includes('approved'));

    // Now resolve session #1's message so it finishes
    expect(resolveSession1Message).not.toBeNull();
    resolveSession1Message!('Repository cloned.');
    await waitForMessage(mockApi, (m) => m.includes('Repository cloned'));

    // Step 3: /new while nothing is in-flight anymore
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

    // Step 4: Message to session #2 triggers escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io');
    await waitForMessage(mockApi, (m) => m.includes('ESCALATION') && m.includes('provos/provos.github.io'));

    // THE KEY ASSERTION: session #2's escalation banner must say [#2]
    messages = mockApi.messageTexts;
    const banner2 = messages.find((m) => m.includes('ESCALATION') && m.includes('provos/provos.github.io'));
    expect(banner2).toBeDefined();
    expect(banner2).toContain('[#2]');
    expect(banner2).not.toContain('ESCALATION [#1]');

    // Deny and verify correct routing
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await waitForMessage(mockApi, (m) => m.includes('Clone blocked'));

    messages = mockApi.messageTexts;
    // Deny confirmation should reference #2
    expect(messages.some((m) => m.includes('denied') && m.includes('[#2]'))).toBe(true);
    // Response from session #2 should be prefixed [#2]
    expect(messages.some((m) => m.includes('[#2]') && m.includes('Clone blocked'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  // --- #N prefix routing tests ---

  it('#N prefix routes message to specified session without switching', async () => {
    await withDaemon(async () => {
      // Create session #1 (auto-created)
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      // Create session #2
      mockApi.simulateIncomingMessage('+15559876543', '/new');
      await waitFor(() => mockApi.messageTexts.filter((m) => m.includes('Started a new session')).length >= 2);

      // Current session is #2. Route to #1 via prefix.
      // sendMessage on session #1 was already called once for "Hello agent"
      const callsBefore = vi.mocked(createdMockSessions[0].session.sendMessage).mock.calls.length;
      mockApi.simulateIncomingMessage('+15559876543', '#1 list the directory');
      await waitForCalls(vi.mocked(createdMockSessions[0].session.sendMessage), callsBefore + 1);

      // Message should have been sent to session #1
      expect(vi.mocked(createdMockSessions[0].session.sendMessage)).toHaveBeenCalledWith('list the directory');
      // Session #2 should NOT have received this message
      expect(vi.mocked(createdMockSessions[1].session.sendMessage)).not.toHaveBeenCalledWith('list the directory');

      // currentLabel should still be #2: send a plain message and verify it goes to #2
      vi.mocked(createdMockSessions[1].session.sendMessage).mockClear();
      mockApi.simulateIncomingMessage('+15559876543', 'follow up');
      await waitForCalls(vi.mocked(createdMockSessions[1].session.sendMessage), 1);

      expect(vi.mocked(createdMockSessions[1].session.sendMessage)).toHaveBeenCalledWith('follow up');
    });
  });

  it('#N prefix to non-existent session shows error', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '#5 do something');
      await waitForMessage(mockApi, (m) => m.includes('No session #5'));

      expect(mockApi.messageTexts.some((m) => m.includes('No session #5'))).toBe(true);
    });
  });

  it('#N prefix strips only the prefix from the forwarded message', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      // sendMessage was already called once for "Hello agent"
      const callsBefore = vi.mocked(createdMockSessions[0].session.sendMessage).mock.calls.length;
      mockApi.simulateIncomingMessage('+15559876543', '#1 check #2 issue');
      await waitForCalls(vi.mocked(createdMockSessions[0].session.sendMessage), callsBefore + 1);

      expect(vi.mocked(createdMockSessions[0].session.sendMessage)).toHaveBeenCalledWith('check #2 issue');
    });
  });

  // --- /help with current session ---

  it('/help shows current session label', async () => {
    await withDaemon(async () => {
      // Create a session first
      mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
      await waitForMessage(mockApi, (m) => m.includes('Started a new session'));

      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const helpMsg = mockApi.messageTexts.find((m) => m.includes('Commands:'));
      expect(helpMsg).toBeDefined();
      expect(helpMsg).toContain('Current session: #1');
    });
  });

  it('/help shows no active session when none exists', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const helpMsg = mockApi.messageTexts.find((m) => m.includes('Commands:'));
      expect(helpMsg).toBeDefined();
      expect(helpMsg).toContain('No active session.');
    });
  });

  it('/help includes #N prefix routing documentation', async () => {
    await withDaemon(async () => {
      mockApi.simulateIncomingMessage('+15559876543', '/help');
      await waitForMessage(mockApi, (m) => m.includes('Commands:'));

      const helpMsg = mockApi.messageTexts.find((m) => m.includes('Commands:'));
      expect(helpMsg).toContain('#N <message>');
    });
  });
});
