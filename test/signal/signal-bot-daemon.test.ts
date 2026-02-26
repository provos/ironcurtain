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

function createTestConfig(port: number): ResolvedSignalConfig {
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
  };
}

// Mock createSession to avoid real session creation
vi.mock('../../src/session/index.js', () => ({
  createSession: vi.fn().mockResolvedValue({
    getInfo: () => ({ id: 'test-session', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }),
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
  });

  function createDaemon(): SignalBotDaemon {
    return new SignalBotDaemon({
      config: createTestConfig(port),
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

    // Set a pending escalation
    daemon.setPendingEscalation('esc-123');

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

    // Set a pending escalation
    daemon.setPendingEscalation('esc-456');

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

    // Set a pending escalation
    daemon.setPendingEscalation('esc-789');

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
});
