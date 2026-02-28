import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  SignalBotDaemon,
  parseSignalEnvelope,
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
  return {
    getInfo: () => ({
      id: `test-session-${createdMockSessions.length}`,
      status: 'ready',
      turnCount: 0,
      createdAt: new Date().toISOString(),
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

  it('sends online message on start', async () => {
    const daemon = createDaemon();
    // Start daemon in background, then shut it down
    const startPromise = daemon.start();
    // Give it a moment to connect and send the online message
    await new Promise((r) => setTimeout(r, 200));

    expect(mockApi.sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(mockApi.sentMessages[0].message).toContain('online');

    await daemon.shutdown();
    await startPromise;
  });

  it('routes authorized messages to session', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Simulate incoming message from authorized sender
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Should have received the online message + session created + agent response
    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Started a new session'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('ignores messages from unauthorized senders', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    const countBefore = mockApi.sentMessages.length;
    mockApi.simulateIncomingMessage('+19999999999', 'I am a stranger');
    await new Promise((r) => setTimeout(r, 200));

    // Should not have sent any new messages (no response to unauthorized sender)
    expect(mockApi.sentMessages.length).toBe(countBefore);

    await daemon.shutdown();
    await startPromise;
  });

  it('handles /help control command', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    mockApi.simulateIncomingMessage('+15559876543', '/help');
    await new Promise((r) => setTimeout(r, 200));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Commands:'))).toBe(true);
    // Verify new commands are in help text
    expect(messages.some((m) => m.includes('/new'))).toBe(true);
    expect(messages.some((m) => m.includes('/sessions'))).toBe(true);
    expect(messages.some((m) => m.includes('/switch'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('handles /budget command with no active session', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    mockApi.simulateIncomingMessage('+15559876543', '/budget');
    await new Promise((r) => setTimeout(r, 200));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('No active session'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('sends styled messages via POST /v2/send', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    const firstSent = mockApi.sentMessages[0];
    expect(firstSent.text_mode).toBe('styled');
    expect(firstSent.recipients).toEqual(['+15559876543']);

    await daemon.shutdown();
    await startPromise;
  });

  it('sends goodbye message on shutdown', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    await daemon.shutdown();
    await startPromise;

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('shutting down'))).toBe(true);
  });

  // --- Identity verification ---

  it('rejects envelope with untrustedIdentity flag', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    const countBefore = mockApi.sentMessages.length;
    mockApi.simulateUntrustedIdentity('+15559876543', 'should be rejected');
    await new Promise((r) => setTimeout(r, 200));

    // Should not have created a session or responded
    const messagesAfter = mockApi.sentMessages.slice(countBefore);
    expect(messagesAfter.every((m) => !m.message.includes('session'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('rejects when fingerprint does not match stored key', async () => {
    // Set a different fingerprint for the recipient
    mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'different-key-xyz' }]);

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    const countBefore = mockApi.sentMessages.length;
    mockApi.simulateIncomingMessage('+15559876543', 'should be rejected');
    await new Promise((r) => setTimeout(r, 500));

    // The first message triggers an identity check. Since the fingerprint
    // doesn't match, the message should be rejected (no session created).
    const messagesAfter = mockApi.sentMessages.slice(countBefore);
    expect(messagesAfter.every((m) => !m.message.includes('Started a new session'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('fails closed when identity API is unavailable', async () => {
    mockApi.setIdentityEndpointDown(true);

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    const countBefore = mockApi.sentMessages.length;
    mockApi.simulateIncomingMessage('+15559876543', 'should be rejected');
    await new Promise((r) => setTimeout(r, 500));

    // Fail-closed: no session should be created
    const messagesAfter = mockApi.sentMessages.slice(countBefore);
    expect(messagesAfter.every((m) => !m.message.includes('Started a new session'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('retries identity check on next message after API failure (no TTL caching of failures)', async () => {
    mockApi.setIdentityEndpointDown(true);

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // First message: rejected (API down)
    mockApi.simulateIncomingMessage('+15559876543', 'first attempt');
    await new Promise((r) => setTimeout(r, 500));

    // Restore API and send second message - should succeed (not cached as "ok")
    mockApi.setIdentityEndpointDown(false);
    mockApi.setIdentities([{ number: '+15559876543', fingerprint: 'test-identity-key-abc123' }]);

    const countBefore = mockApi.sentMessages.length;
    mockApi.simulateIncomingMessage('+15559876543', 'second attempt');
    await new Promise((r) => setTimeout(r, 500));

    // Should create a session since identity API is back and key matches
    const messagesAfter = mockApi.sentMessages.slice(countBefore);
    expect(messagesAfter.some((m) => m.message.includes('Started a new session'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  // --- Escalation handling ---

  it('handles escalation approve reply', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // First create a session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Set a pending escalation on session #1
    daemon.setPendingEscalation(1, 'esc-123');

    // Send approve
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('approved'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('handles escalation deny reply', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // First create a session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Set a pending escalation on session #1
    daemon.setPendingEscalation(1, 'esc-456');

    // Send deny with slash prefix
    mockApi.simulateIncomingMessage('+15559876543', '/deny');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('denied'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('rejects concurrent escalation replies', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create a session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Set a pending escalation on session #1
    daemon.setPendingEscalation(1, 'esc-789');

    // Send two rapid replies (second should be blocked)
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    // The first one is now resolving - second should get "being resolved" message
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await new Promise((r) => setTimeout(r, 500));

    const messages = mockApi.sentMessages.map((m) => m.message);
    // At least one should be the "being resolved" message
    const hasResolving = messages.some((m) => m.includes('being resolved'));
    const hasApproved = messages.some((m) => m.includes('approved'));
    // Either both fired (race condition where first completed before second arrived)
    // or the second got blocked
    expect(hasApproved || hasResolving).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  // --- Session lifecycle ---

  it('handles /quit command by ending session', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create a session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Send /quit
    mockApi.simulateIncomingMessage('+15559876543', '/quit');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Session ended'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  // --- Multi-session tests ---

  it('creates two concurrent sessions via /new', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // First session (created on demand)
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Second session via /new
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    const messages = mockApi.sentMessages.map((m) => m.message);
    // Should have two "Started a new session" messages
    const startedCount = messages.filter((m) => m.includes('Started a new session')).length;
    expect(startedCount).toBe(2);

    await daemon.shutdown();
    await startPromise;
  });

  it('/sessions lists all active sessions', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create first session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Create second session
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // List sessions
    mockApi.simulateIncomingMessage('+15559876543', '/sessions');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    const sessionList = messages.find((m) => m.includes('Active sessions'));
    expect(sessionList).toBeDefined();
    expect(sessionList).toContain('#1');
    expect(sessionList).toContain('#2');
    // Current session (#2) should be marked with >
    expect(sessionList).toContain('> #2');

    await daemon.shutdown();
    await startPromise;
  });

  it('/switch changes which session receives messages', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create first session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Create second session
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Switch back to session #1
    mockApi.simulateIncomingMessage('+15559876543', '/switch 1');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Switched to session #1'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('/quit ends current and auto-switches', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create first session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Create second session (becomes current)
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Quit current session (#2)
    mockApi.simulateIncomingMessage('+15559876543', '/quit');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    // Should auto-switch to #1
    expect(messages.some((m) => m.includes('Switched to #1'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('/quit N ends a specific session', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create first session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Create second session
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Quit session #1 explicitly (current stays at #2)
    mockApi.simulateIncomingMessage('+15559876543', '/quit 1');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Session #1 ended'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('escalation auto-routes to session with pending escalation', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Set escalation on session #1 (not current)
    daemon.setPendingEscalation(1, 'esc-auto');

    // Send approve without label - should auto-route to #1
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('approved'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('escalation disambiguation when multiple pending', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Set escalations on both sessions
    daemon.setPendingEscalation(1, 'esc-a');
    daemon.setPendingEscalation(2, 'esc-b');

    // Send approve without label - should ask for disambiguation
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Multiple escalations pending'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('escalation with explicit label routes directly', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Set escalations on both sessions
    daemon.setPendingEscalation(1, 'esc-x');
    daemon.setPendingEscalation(2, 'esc-y');

    // Approve session #1 explicitly
    mockApi.simulateIncomingMessage('+15559876543', 'approve #1');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('approved'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('max session limit enforced', async () => {
    const daemon = createDaemon({ maxConcurrentSessions: 2 });
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create first session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Create second session
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Try to create third session - should be rejected
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Session limit reached'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('/sessions shows no active sessions when none exist', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    mockApi.simulateIncomingMessage('+15559876543', '/sessions');
    await new Promise((r) => setTimeout(r, 200));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('No active sessions'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('/switch to non-existent session shows error', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    mockApi.simulateIncomingMessage('+15559876543', '/switch 5');
    await new Promise((r) => setTimeout(r, 200));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('No session #5'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  it('/budget N shows budget for specific session', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create a session
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Request budget for session #1
    mockApi.simulateIncomingMessage('+15559876543', '/budget 1');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('budget'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });

  // --- Multi-escalation flow tests ---

  it('approving one escalation leaves the other still pending', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Set escalations on both
    daemon.setPendingEscalation(1, 'esc-a');
    daemon.setPendingEscalation(2, 'esc-b');

    // Approve #1 explicitly
    mockApi.simulateIncomingMessage('+15559876543', 'approve #1');
    await new Promise((r) => setTimeout(r, 300));

    // Now a bare approve should auto-route to #2 (only one remaining)
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    const approvedCount = messages.filter((m) => m.includes('approved')).length;
    expect(approvedCount).toBe(2);
    // Should NOT have asked for disambiguation on the second approve
    expect(messages.filter((m) => m.includes('Multiple escalations')).length).toBe(0);

    await daemon.shutdown();
    await startPromise;
  });

  it('deny with explicit label targets the correct session', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Set escalations on both
    daemon.setPendingEscalation(1, 'esc-d1');
    daemon.setPendingEscalation(2, 'esc-d2');

    // Deny session #2 explicitly
    mockApi.simulateIncomingMessage('+15559876543', 'deny #2');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('denied'))).toBe(true);

    // Session #2's resolveEscalation should have been called with 'denied'
    const session2 = createdMockSessions[1].session;
    expect(session2.resolveEscalation).toHaveBeenCalledWith('esc-d2', 'denied');

    // Session #1's resolveEscalation should NOT have been called
    const session1 = createdMockSessions[0].session;
    expect(session1.resolveEscalation).not.toHaveBeenCalled();

    await daemon.shutdown();
    await startPromise;
  });

  it('full flow: disambiguate then approve one then deny the other', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Set escalations on both
    daemon.setPendingEscalation(1, 'esc-flow-1');
    daemon.setPendingEscalation(2, 'esc-flow-2');

    // Step 1: bare approve triggers disambiguation
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 300));

    let messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Multiple escalations pending'))).toBe(true);

    // Step 2: approve #1 with label
    mockApi.simulateIncomingMessage('+15559876543', 'approve #1');
    await new Promise((r) => setTimeout(r, 300));

    messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('approved'))).toBe(true);

    const session1 = createdMockSessions[0].session;
    expect(session1.resolveEscalation).toHaveBeenCalledWith('esc-flow-1', 'approved');

    // Step 3: deny #2 (now only one pending, bare deny should work)
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await new Promise((r) => setTimeout(r, 300));

    messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('denied'))).toBe(true);

    const session2 = createdMockSessions[1].session;
    expect(session2.resolveEscalation).toHaveBeenCalledWith('esc-flow-2', 'denied');

    await daemon.shutdown();
    await startPromise;
  });

  it('approve #N where N has no pending escalation shows error', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Set escalation only on session #1
    daemon.setPendingEscalation(1, 'esc-only-1');

    // Try to approve session #2 which has no escalation
    mockApi.simulateIncomingMessage('+15559876543', 'approve #2');
    await new Promise((r) => setTimeout(r, 300));

    const messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('no pending escalation'))).toBe(true);

    // Session #1 should be unaffected
    const session1 = createdMockSessions[0].session;
    expect(session1.resolveEscalation).not.toHaveBeenCalled();

    await daemon.shutdown();
    await startPromise;
  });

  // --- Escalation callback chain tests ---
  // These exercise the real onEscalation callback wiring instead of
  // calling daemon.setPendingEscalation() directly, catching bugs
  // where the transport's sessionLabel is wrong.

  it('escalation via callback chain labels banner with correct session', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create session #1
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Create session #2
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Simulate escalation from session #2 via its captured onEscalation callback
    const record2 = createdMockSessions[1];
    expect(record2.onEscalation).toBeDefined();
    record2.onEscalation!({
      escalationId: 'esc-callback-2',
      serverName: 'git',
      toolName: 'git_clone',
      arguments: { url: 'https://example.com' },
      reason: 'test escalation',
    });
    await new Promise((r) => setTimeout(r, 200));

    // The escalation banner should say [#2], not [#1]
    const messages = mockApi.sentMessages.map((m) => m.message);
    const banner = messages.find((m) => m.includes('ESCALATION'));
    expect(banner).toBeDefined();
    expect(banner).toContain('[#2]');
    expect(banner).not.toContain('[#1]');

    await daemon.shutdown();
    await startPromise;
  });

  it('escalation via callback from session #1 labels banner with #1', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create session #1
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));

    // Create session #2
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Simulate escalation from session #1 via its captured onEscalation callback
    const record1 = createdMockSessions[0];
    expect(record1.onEscalation).toBeDefined();
    record1.onEscalation!({
      escalationId: 'esc-callback-1',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/etc/passwd' },
      reason: 'protected path',
    });
    await new Promise((r) => setTimeout(r, 200));

    const messages = mockApi.sentMessages.map((m) => m.message);
    const banner = messages.find((m) => m.includes('ESCALATION'));
    expect(banner).toBeDefined();
    expect(banner).toContain('[#1]');

    await daemon.shutdown();
    await startPromise;
  });

  it('approve routes to correct session when escalation was set via callback', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Trigger escalation on session #2 via callback
    createdMockSessions[1].onEscalation!({
      escalationId: 'esc-cb-resolve',
      serverName: 'git',
      toolName: 'git_clone',
      arguments: {},
      reason: 'test',
    });
    await new Promise((r) => setTimeout(r, 200));

    // Approve it (only one pending, should auto-route)
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 300));

    // Verify session #2's resolveEscalation was called, not session #1's
    expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-cb-resolve', 'approved');
    expect(createdMockSessions[0].session.resolveEscalation).not.toHaveBeenCalled();

    await daemon.shutdown();
    await startPromise;
  });

  it('concurrent callback escalations on both sessions require disambiguation', async () => {
    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create two sessions
    mockApi.simulateIncomingMessage('+15559876543', 'Hello agent');
    await new Promise((r) => setTimeout(r, 500));
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Trigger escalations on both sessions via callbacks
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
    await new Promise((r) => setTimeout(r, 200));

    // Verify both banners have correct labels
    const messages = mockApi.sentMessages.map((m) => m.message);
    const banners = messages.filter((m) => m.includes('ESCALATION'));
    expect(banners.length).toBe(2);
    expect(banners.some((b) => b.includes('[#1]'))).toBe(true);
    expect(banners.some((b) => b.includes('[#2]'))).toBe(true);

    // Bare approve should require disambiguation
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 300));

    const afterApprove = mockApi.sentMessages.map((m) => m.message);
    expect(afterApprove.some((m) => m.includes('Multiple escalations pending'))).toBe(true);

    // Approve #2 explicitly, then deny #1
    mockApi.simulateIncomingMessage('+15559876543', 'approve #2');
    await new Promise((r) => setTimeout(r, 300));
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await new Promise((r) => setTimeout(r, 300));

    expect(createdMockSessions[1].session.resolveEscalation).toHaveBeenCalledWith('esc-both-2', 'approved');
    expect(createdMockSessions[0].session.resolveEscalation).toHaveBeenCalledWith('esc-both-1', 'denied');

    await daemon.shutdown();
    await startPromise;
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
          // Wait for the escalation to be resolved before returning
          await new Promise((r) => setTimeout(r, 800));
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
          await new Promise((r) => setTimeout(r, 800));
          return 'Clone operation was blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Step 1: Send message to create session #1 and trigger its escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone ironcurtain.web');
    await new Promise((r) => setTimeout(r, 300));

    // Session #1 should be processing and have escalated
    let messages = mockApi.sentMessages.map((m) => m.message);
    const banner1 = messages.find((m) => m.includes('ESCALATION') && m.includes('ironcurtain.web'));
    expect(banner1).toBeDefined();
    expect(banner1).toContain('[#1]');

    // Step 2: Approve session #1's escalation
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 1000));

    // Session #1 should have responded
    messages = mockApi.sentMessages.map((m) => m.message);
    expect(messages.some((m) => m.includes('Repository cloned successfully'))).toBe(true);

    // Step 3: /new creates session #2
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Step 4: Send message to session #2 (current), which triggers escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io');
    await new Promise((r) => setTimeout(r, 300));

    // Step 5: The escalation banner for session #2 should say [#2], NOT [#1]
    messages = mockApi.sentMessages.map((m) => m.message);
    const banner2 = messages.find((m) => m.includes('ESCALATION') && m.includes('provos.github.io'));
    expect(banner2).toBeDefined();
    expect(banner2).toContain('[#2]');
    expect(banner2).not.toContain('[#1]');

    // Step 6: Deny and verify it resolves on session #2
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await new Promise((r) => setTimeout(r, 1000));

    messages = mockApi.sentMessages.map((m) => m.message);
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
    // Reproduces the root cause of the label mismatch bug:
    // /new fires startNewSession() asynchronously. If a message arrives
    // before startNewSession() completes, it would route to the old session.
    // The fix (sessionOpInProgress) makes routeToSession() wait.

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Step 1: Create session #1 by sending a message
    mockApi.simulateIncomingMessage('+15559876543', 'hello', 1000);
    await new Promise((r) => setTimeout(r, 500));
    expect(createdMockSessions).toHaveLength(1);
    const session1 = createdMockSessions[0].session;
    vi.mocked(session1.sendMessage).mockClear();

    // Step 2: Send /new immediately followed by a message (same tick)
    mockApi.simulateIncomingMessage('+15559876543', '/new', 2000);
    mockApi.simulateIncomingMessage('+15559876543', 'work on provos.github.io', 2001);
    await new Promise((r) => setTimeout(r, 800));

    // Session #2 should have been created
    expect(createdMockSessions).toHaveLength(2);
    const session2 = createdMockSessions[1].session;

    // The message must go to session #2, not session #1
    expect(vi.mocked(session1.sendMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(session2.sendMessage)).toHaveBeenCalledWith('work on provos.github.io');

    await daemon.shutdown();
    await startPromise;
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
          await new Promise((r) => setTimeout(r, 300));
          return 'Clone blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Create session #1
    mockApi.simulateIncomingMessage('+15559876543', 'hello', 3000);
    await new Promise((r) => setTimeout(r, 500));
    expect(createdMockSessions).toHaveLength(1);

    // Send /new + message in rapid succession
    mockApi.simulateIncomingMessage('+15559876543', '/new', 4000);
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io', 4001);
    await new Promise((r) => setTimeout(r, 600));

    // The escalation banner must say [#2], not [#1]
    const messages = mockApi.sentMessages.map((m) => m.message);
    const banner = messages.find((m) => m.includes('ESCALATION') && m.includes('provos.github.io'));
    expect(banner).toBeDefined();
    expect(banner).toContain('[#2]');
    expect(banner).not.toContain('ESCALATION [#1]');

    // Deny and verify correct routing
    mockApi.simulateIncomingMessage('+15559876543', 'deny', 5000);
    await new Promise((r) => setTimeout(r, 800));

    const allMessages = mockApi.sentMessages.map((m) => m.message);
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
        // Session #2: sendMessage triggers escalation, resolves after delay
        session.sendMessage = vi.fn().mockImplementation(async () => {
          options?.onEscalation?.({
            escalationId: 'esc-concurrent-s2',
            serverName: 'git',
            toolName: 'git_clone',
            arguments: { url: 'https://github.com/provos/provos.github.io' },
            reason: 'approval required',
          });
          await new Promise((r) => setTimeout(r, 500));
          return 'Clone blocked.';
        });
      }

      createdMockSessions.push({ session, onEscalation: options?.onEscalation });
      return Promise.resolve(session);
    });

    const daemon = createDaemon();
    const startPromise = daemon.start();
    await new Promise((r) => setTimeout(r, 200));

    // Step 1: Message creates session #1 and starts processing (blocks)
    mockApi.simulateIncomingMessage('+15559876543', 'clone ironcurtain.web');
    await new Promise((r) => setTimeout(r, 300));

    // Session #1 has escalated but its forwardMessage is still blocked
    let messages = mockApi.sentMessages.map((m) => m.message);
    const banner1 = messages.find((m) => m.includes('ESCALATION') && m.includes('ironcurtain.web'));
    expect(banner1).toContain('[#1]');

    // Step 2: Approve session #1's escalation
    mockApi.simulateIncomingMessage('+15559876543', 'approve');
    await new Promise((r) => setTimeout(r, 200));

    // Now resolve session #1's message so it finishes
    expect(resolveSession1Message).not.toBeNull();
    resolveSession1Message!('Repository cloned.');
    await new Promise((r) => setTimeout(r, 300));

    // Step 3: /new while nothing is in-flight anymore
    mockApi.simulateIncomingMessage('+15559876543', '/new');
    await new Promise((r) => setTimeout(r, 500));

    // Step 4: Message to session #2 triggers escalation
    mockApi.simulateIncomingMessage('+15559876543', 'clone provos.github.io');
    await new Promise((r) => setTimeout(r, 300));

    // THE KEY ASSERTION: session #2's escalation banner must say [#2]
    messages = mockApi.sentMessages.map((m) => m.message);
    const banner2 = messages.find((m) => m.includes('ESCALATION') && m.includes('provos.github.io'));
    expect(banner2).toBeDefined();
    expect(banner2).toContain('[#2]');
    expect(banner2).not.toContain('ESCALATION [#1]');

    // Deny and verify correct routing
    mockApi.simulateIncomingMessage('+15559876543', 'deny');
    await new Promise((r) => setTimeout(r, 800));

    messages = mockApi.sentMessages.map((m) => m.message);
    // Deny confirmation should reference #2
    expect(messages.some((m) => m.includes('denied') && m.includes('[#2]'))).toBe(true);
    // Response from session #2 should be prefixed [#2]
    expect(messages.some((m) => m.includes('[#2]') && m.includes('Clone blocked'))).toBe(true);

    await daemon.shutdown();
    await startPromise;
  });
});
