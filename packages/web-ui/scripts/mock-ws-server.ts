/**
 * Mock WebSocket server for web UI development and testing.
 *
 * Speaks the same JSON-RPC protocol as the real daemon, returning canned
 * data and emitting scripted event sequences with realistic timing.
 *
 * Usage:
 *   cd packages/web-ui && npm run mock-server
 *   # Then in another terminal: npm run dev
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'http';

// ---------------------------------------------------------------------------
// Types (mirrors the daemon protocol without importing from src/)
// ---------------------------------------------------------------------------

interface RequestFrame {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface ResponseFrame {
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

interface MockSession {
  label: number;
  turnCount: number;
  createdAt: string;
  status: string;
  persona?: string;
  totalTokens: number;
  stepCount: number;
  estimatedCostUsd: number;
}

interface MockWhitelistCandidate {
  description: string;
}

interface MockEscalation {
  escalationId: string;
  sessionLabel: number;
  toolName: string;
  serverName: string;
  arguments: Record<string, unknown>;
  reason: string;
  whitelistCandidates?: MockWhitelistCandidate[];
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '7400', 10);
const MOCK_TOKEN = 'mock-dev-token';
const startTime = Date.now();

let nextLabel = 1;
let eventSeq = 0;
const sessions = new Map<number, MockSession>();
const escalations = new Map<string, MockEscalation>();
const clients = new Set<WebSocket>();

// ---------------------------------------------------------------------------
// Canned data
// ---------------------------------------------------------------------------

const CANNED_RESPONSES = [
  `## Analysis Complete

Here's what I found in the codebase:

- **12 source files** modified in the last commit
- The \`PolicyEngine\` class handles all authorization decisions
- No security vulnerabilities detected

\`\`\`typescript
const result = engine.evaluate(request);
console.log(result.decision); // 'allow' | 'deny' | 'escalate'
\`\`\`

| File | Lines Changed | Status |
|------|--------------|--------|
| policy-engine.ts | +42 / -8 | Modified |
| types.ts | +15 / -3 | Modified |
| index.ts | +5 / -1 | Modified |`,

  `I've completed the requested changes. Here's a summary:

1. **Added input validation** to the \`createSession\` handler
2. **Fixed the race condition** in the WebSocket reconnection logic
3. Updated **3 test files** to cover the new edge cases

> Note: The budget tracker now correctly resets when a session is recycled.

All tests pass locally. Ready for review.`,

  `### Dependencies Audit

Found **2 outdated** packages:

\`\`\`
ws           8.16.0  ->  8.18.0  (minor)
typescript   5.6.0   ->  5.7.2   (minor)
\`\`\`

No **critical vulnerabilities** detected. The \`ws\` update includes a performance improvement for large payloads.

**Recommendation**: Update both packages. Neither has breaking changes.`,
];

const CANNED_HISTORY = [
  {
    turnNumber: 1,
    userMessage: 'Scan the codebase for any security vulnerabilities in the auth module.',
    assistantResponse: CANNED_RESPONSES[0],
    timestamp: new Date(Date.now() - 600_000).toISOString(),
    usage: {
      promptTokens: 1200,
      completionTokens: 850,
      totalTokens: 2050,
      cacheReadTokens: 400,
      cacheWriteTokens: 200,
    },
  },
  {
    turnNumber: 2,
    userMessage: 'Fix the race condition you found in the WebSocket reconnect logic.',
    assistantResponse: CANNED_RESPONSES[1],
    timestamp: new Date(Date.now() - 300_000).toISOString(),
    usage: {
      promptTokens: 2800,
      completionTokens: 1100,
      totalTokens: 3900,
      cacheReadTokens: 1800,
      cacheWriteTokens: 0,
    },
  },
  {
    turnNumber: 3,
    userMessage: 'Check for outdated dependencies and recommend updates.',
    assistantResponse: CANNED_RESPONSES[2],
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    usage: { promptTokens: 1500, completionTokens: 600, totalTokens: 2100, cacheReadTokens: 900, cacheWriteTokens: 0 },
  },
];

const CANNED_DIAGNOSTICS = [
  { kind: 'tool_call' as const, toolName: 'filesystem__read_file', preview: 'Reading ./src/auth/middleware.ts' },
  { kind: 'tool_call' as const, toolName: 'filesystem__list_directory', preview: 'Listing ./src/auth/' },
  { kind: 'step_finish' as const, stepIndex: 1 },
  { kind: 'agent_text' as const, preview: 'Analyzing authentication flow...' },
  { kind: 'tool_call' as const, toolName: 'filesystem__write_file', preview: 'Writing ./src/auth/middleware.ts' },
  { kind: 'budget_warning' as const, dimension: 'tokens', percentUsed: 78, message: 'Token usage at 78% of limit' },
  { kind: 'step_finish' as const, stepIndex: 2 },
];

const CANNED_RUN_RECORDS = [
  {
    startedAt: new Date(Date.now() - 86400_000).toISOString(),
    completedAt: new Date(Date.now() - 86400_000 + 45_000).toISOString(),
    outcome: { kind: 'success' },
    budget: { totalTokens: 24500, stepCount: 12, elapsedSeconds: 45, estimatedCostUsd: 0.08 },
    summary: 'Daily scan complete. No vulnerabilities found.',
  },
  {
    startedAt: new Date(Date.now() - 172800_000).toISOString(),
    completedAt: new Date(Date.now() - 172800_000 + 90_000).toISOString(),
    outcome: { kind: 'error', message: 'Connection to npm registry timed out' },
    budget: { totalTokens: 8200, stepCount: 5, elapsedSeconds: 90, estimatedCostUsd: 0.03 },
    summary: null,
  },
  {
    startedAt: new Date(Date.now() - 259200_000).toISOString(),
    completedAt: new Date(Date.now() - 259200_000 + 1800_000).toISOString(),
    outcome: { kind: 'budget_exhausted', dimension: 'tokens' },
    budget: { totalTokens: 1000000, stepCount: 198, elapsedSeconds: 1800, estimatedCostUsd: 4.95 },
    summary: 'Partial scan completed before token budget was exhausted.',
  },
];

const CANNED_JOBS = [
  {
    job: {
      id: 'daily-security-scan',
      name: 'Daily Security Scan',
      schedule: '0 2 * * *',
      taskDescription: 'Scan codebase for security vulnerabilities and outdated dependencies',
      enabled: true,
    },
    nextRun: new Date(Date.now() + 3600_000).toISOString(),
    lastRun: {
      startedAt: new Date(Date.now() - 86400_000).toISOString(),
      completedAt: new Date(Date.now() - 86400_000 + 45_000).toISOString(),
      outcome: { kind: 'success' },
      budget: { totalTokens: 24500, stepCount: 12, elapsedSeconds: 45, estimatedCostUsd: 0.08 },
      summary: 'No vulnerabilities found. All dependencies up to date.',
    },
    isRunning: false,
  },
  {
    job: {
      id: 'weekly-report',
      name: 'Weekly Status Report',
      schedule: '0 9 * * 1',
      taskDescription: 'Generate a weekly summary of all changes and incidents',
      enabled: true,
    },
    nextRun: new Date(Date.now() + 259200_000).toISOString(),
    lastRun: null,
    isRunning: false,
  },
  {
    job: {
      id: 'code-review-helper',
      name: 'PR Review Helper',
      schedule: '*/30 * * * *',
      taskDescription: 'Review open pull requests and leave comments',
      enabled: false,
    },
    nextRun: null,
    lastRun: {
      startedAt: new Date(Date.now() - 172800_000).toISOString(),
      completedAt: new Date(Date.now() - 172800_000 + 120_000).toISOString(),
      outcome: { kind: 'failure', message: 'API rate limit exceeded' },
      budget: { totalTokens: 8200, stepCount: 5, elapsedSeconds: 120, estimatedCostUsd: 0.03 },
      summary: null,
    },
    isRunning: false,
  },
];

const CANNED_PERSONAS = [
  { name: 'default', description: 'General-purpose assistant with standard policy', compiled: true },
  { name: 'researcher', description: 'Read-only access focused on code analysis', compiled: true },
  { name: 'devops', description: 'Infrastructure and deployment operations', compiled: false },
];

// Mutable copy of canned jobs so enable/disable/remove are stateful
const jobs = structuredClone(CANNED_JOBS);

/** Reset all mutable state for test isolation. */
function resetState(): void {
  sessions.clear();
  escalations.clear();
  nextLabel = 1;
  jobs.length = 0;
  jobs.push(...structuredClone(CANNED_JOBS));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(ws: WebSocket, event: string, payload: unknown): void {
  const frame: EventFrame = { event, payload, seq: ++eventSeq };
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Socket already closed; ignore
  }
}

function broadcast(event: string, payload: unknown): void {
  for (const ws of clients) {
    emit(ws, event, payload);
  }
}

function buildBudgetDto(session: MockSession) {
  return {
    totalTokens: session.totalTokens,
    stepCount: session.stepCount,
    elapsedSeconds: Math.floor((Date.now() - new Date(session.createdAt).getTime()) / 1000),
    estimatedCostUsd: session.estimatedCostUsd,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
    },
  };
}

function buildSessionDto(session: MockSession) {
  return {
    label: session.label,
    source: { kind: 'web' as const },
    status: session.status,
    turnCount: session.turnCount,
    createdAt: session.createdAt,
    hasPendingEscalation: [...escalations.values()].some((e) => e.sessionLabel === session.label),
    messageInFlight: session.status === 'processing',
    budget: buildBudgetDto(session),
    ...(session.persona ? { persona: session.persona } : {}),
  };
}

function buildStatusDto() {
  return {
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    jobs: { total: jobs.length, enabled: jobs.filter((j) => j.job.enabled).length, running: 0 },
    signalConnected: false,
    webUiListening: true,
    activeSessions: sessions.size,
    nextFireTime: jobs[0]?.nextRun ?? null,
  };
}

function buildEscalationDto(esc: MockEscalation) {
  return {
    ...esc,
    sessionSource: { kind: 'web' as const },
  };
}

// ---------------------------------------------------------------------------
// Simulated turn sequence
// ---------------------------------------------------------------------------

async function simulateTurn(ws: WebSocket, label: number, text: string): Promise<void> {
  const session = sessions.get(label);
  if (!session) return;

  session.status = 'processing';
  session.turnCount++;
  const turnNumber = session.turnCount;

  // Check for escalation keyword
  if (text.toLowerCase().includes('escalate')) {
    emit(ws, 'session.thinking', { label, turnNumber });
    emit(ws, 'session.updated', buildSessionDto(session));

    await delay(800);

    emit(ws, 'session.tool_call', {
      label,
      toolName: 'filesystem__write_file',
      preview: 'Writing /etc/hosts',
    });

    await delay(600);

    const escalationId = `esc-${Date.now()}`;
    const esc: MockEscalation = {
      escalationId,
      sessionLabel: label,
      toolName: 'filesystem__write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts', content: 'malicious content' },
      reason: 'Write to protected system path',
      whitelistCandidates: [
        { description: 'Allow filesystem.write_file within /etc/' },
        { description: 'Allow filesystem.write_file for this exact path: /etc/hosts' },
      ],
      receivedAt: new Date().toISOString(),
    };
    escalations.set(escalationId, esc);

    broadcast('escalation.created', buildEscalationDto(esc));
    // Session stays in processing until escalation is resolved
    return;
  }

  // Normal turn sequence
  emit(ws, 'session.thinking', { label, turnNumber });
  emit(ws, 'session.updated', buildSessionDto(session));

  await delay(800);

  emit(ws, 'session.tool_call', {
    label,
    toolName: 'filesystem__read_file',
    preview: 'Reading ./package.json',
  });

  await delay(600);

  emit(ws, 'session.tool_call', {
    label,
    toolName: 'filesystem__write_file',
    preview: 'Writing ./output.txt',
  });

  await delay(1200);

  // Final output
  const response = CANNED_RESPONSES[turnNumber % CANNED_RESPONSES.length];
  session.totalTokens += 3500 + Math.floor(Math.random() * 2000);
  session.stepCount += 2 + Math.floor(Math.random() * 3);
  session.estimatedCostUsd += 0.01 + Math.random() * 0.04;
  session.status = 'ready';

  emit(ws, 'session.output', { label, text: response, turnNumber });
  emit(ws, 'session.budget_update', { label, budget: buildBudgetDto(session) });
  emit(ws, 'session.updated', buildSessionDto(session));
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

function handleMethod(ws: WebSocket, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'status':
      return buildStatusDto();

    case 'sessions.list':
      return [...sessions.values()].map(buildSessionDto);

    case 'sessions.create': {
      const label = nextLabel++;
      const session: MockSession = {
        label,
        turnCount: 0,
        createdAt: new Date().toISOString(),
        status: 'ready',
        persona: (params.persona as string) ?? undefined,
        totalTokens: 0,
        stepCount: 0,
        estimatedCostUsd: 0,
      };
      sessions.set(label, session);
      broadcast('session.created', buildSessionDto(session));
      return { label };
    }

    case 'sessions.get': {
      const label = params.label as number;
      const session = sessions.get(label);
      if (!session) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return {
        ...buildSessionDto(session),
        history: session.turnCount > 0 ? CANNED_HISTORY.slice(0, session.turnCount) : [],
        diagnosticLog: session.turnCount > 0 ? CANNED_DIAGNOSTICS : [],
      };
    }

    case 'sessions.send': {
      const label = params.label as number;
      const text = params.text as string;
      const session = sessions.get(label);
      if (!session) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      // Fire-and-forget the async simulation
      simulateTurn(ws, label, text).catch(() => {});
      return { accepted: true };
    }

    case 'sessions.end': {
      const label = params.label as number;
      sessions.delete(label);
      // Clean up any escalations belonging to this session
      for (const [id, esc] of escalations) {
        if (esc.sessionLabel === label) escalations.delete(id);
      }
      broadcast('session.ended', { label, reason: 'user_ended' });
      return undefined;
    }

    case 'sessions.budget': {
      const label = params.label as number;
      const session = sessions.get(label);
      if (!session) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return buildBudgetDto(session);
    }

    case 'sessions.history': {
      const label = params.label as number;
      const histSession = sessions.get(label);
      if (!histSession) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return histSession.turnCount > 0 ? CANNED_HISTORY.slice(0, histSession.turnCount) : [];
    }

    case 'sessions.diagnostics': {
      const label = params.label as number;
      const diagSession = sessions.get(label);
      if (!diagSession) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return diagSession.turnCount > 0 ? CANNED_DIAGNOSTICS : [];
    }

    case 'escalations.list':
      return [...escalations.values()].map(buildEscalationDto);

    case 'escalations.resolve': {
      const escalationId = params.escalationId as string;
      const decision = params.decision as string;
      const esc = escalations.get(escalationId);
      if (!esc) return errorResult('ESCALATION_NOT_FOUND', `Escalation ${escalationId} not found`);
      escalations.delete(escalationId);
      broadcast('escalation.resolved', { escalationId, decision });

      // Resume the session that was waiting on this escalation
      const session = sessions.get(esc.sessionLabel);
      if (session) {
        session.status = 'ready';
        broadcast('session.updated', buildSessionDto(session));
      }
      return undefined;
    }

    case 'jobs.list':
      return jobs;

    case 'jobs.run': {
      const jobId = params.jobId as string;
      const runningJob = jobs.find((j) => j.job.id === jobId);
      if (runningJob) runningJob.isRunning = true;
      broadcast('job.started', { jobId, sessionLabel: 0 });
      setTimeout(() => {
        if (runningJob) runningJob.isRunning = false;
        broadcast('job.completed', {
          jobId,
          record: {
            startedAt: new Date(Date.now() - 3000).toISOString(),
            completedAt: new Date().toISOString(),
            outcome: { kind: 'success' },
            budget: { totalTokens: 15000, stepCount: 8, elapsedSeconds: 3, estimatedCostUsd: 0.05 },
            summary: 'Job completed successfully.',
          },
        });
      }, 3000);
      return { accepted: true, jobId };
    }

    case 'jobs.enable': {
      const job = jobs.find((j) => j.job.id === params.jobId);
      if (job) job.job.enabled = true;
      broadcast('job.list_changed', {});
      return undefined;
    }

    case 'jobs.disable': {
      const job = jobs.find((j) => j.job.id === params.jobId);
      if (job) job.job.enabled = false;
      broadcast('job.list_changed', {});
      return undefined;
    }

    case 'jobs.remove': {
      const idx = jobs.findIndex((j) => j.job.id === params.jobId);
      if (idx !== -1) jobs.splice(idx, 1);
      broadcast('job.list_changed', {});
      return undefined;
    }

    case 'jobs.recompile':
    case 'jobs.reload':
      broadcast('job.list_changed', {});
      return undefined;

    case 'jobs.logs':
      return CANNED_RUN_RECORDS;

    case 'personas.list':
      return CANNED_PERSONAS;

    case '__reset': {
      resetState();
      return undefined;
    }

    default:
      return errorResult('METHOD_NOT_FOUND', `Unknown method: ${method}`);
  }
}

/** Sentinel used to distinguish RPC errors from normal return values. */
type RpcErrorResult = { __rpcError: true; code: string; message: string };

function errorResult(code: string, message: string): RpcErrorResult {
  return { __rpcError: true, code, message };
}

function isRpcError(value: unknown): value is RpcErrorResult {
  return typeof value === 'object' && value !== null && '__rpcError' in value;
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`  Client connected (${clients.size} total)`);

  ws.on('message', (raw) => {
    let frame: RequestFrame;
    try {
      frame = JSON.parse(raw.toString()) as RequestFrame;
    } catch {
      return;
    }

    const result = handleMethod(ws, frame.method, frame.params ?? {});

    let response: ResponseFrame;
    if (isRpcError(result)) {
      response = { id: frame.id, ok: false, error: { code: result.code, message: result.message } };
    } else {
      response = { id: frame.id, ok: true, ...(result !== undefined ? { payload: result } : {}) };
    }

    ws.send(JSON.stringify(response));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`  Client disconnected (${clients.size} total)`);
  });
});

// HTTP server for test-only endpoints (e.g., state reset)
const RESET_PORT = parseInt(process.env.RESET_PORT ?? '7401', 10);
const httpServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__reset') {
    resetState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
httpServer.listen(RESET_PORT);

// Periodic status broadcast
setInterval(() => {
  broadcast('daemon.status', buildStatusDto());
}, 10_000);

console.log(`
  Mock WebSocket server listening on ws://127.0.0.1:${PORT}

  Open the web UI with this URL:
    http://localhost:5173/?token=${MOCK_TOKEN}

  Two-terminal workflow:
    Terminal 1: cd packages/web-ui && npm run mock-server
    Terminal 2: cd packages/web-ui && npm run dev
`);
