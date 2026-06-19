/**
 * Unit tests for ToolCallCoordinator.
 *
 * The coordinator owns policy + audit + circuit breaker + whitelist
 * + server-context + auto-approver. These tests exercise the
 * pipeline around a mocked MCP client so we can verify:
 *   - allow path (policy → dispatch → audit success)
 *   - deny path (policy deny → audit deny, no dispatch)
 *   - invalid-arguments path
 *   - escalation path via in-process callback
 *   - post-success ServerContext update
 *   - post-call bookkeeping skipped on error results
 *   - tool-call mutex serializes concurrent invocations
 *
 * The coordinator threads through the existing `handleCallTool`
 * implementation (which has its own exhaustive unit tests in
 * `test/mcp-proxy-server.test.ts`), so these tests focus on the
 * coordinator-specific wiring rather than duplicating per-path
 * coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import type { ClientState, ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';
import type { ToolCallRequest } from '../src/types/mcp.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TEST_ROOT = `/tmp/coordinator-test-${process.pid}`;

function makeAuditPath(suffix: string): string {
  return resolve(TEST_ROOT, `audit-${suffix}.jsonl`);
}

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: uuidv4(),
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: `${TEST_SANDBOX_DIR}/hello.txt` },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Builds a mock client that returns a successful read_file result. */
function mockSuccessClient(): Client {
  return {
    callTool: async () => ({
      content: [{ type: 'text', text: 'file content' }],
      isError: false,
    }),
    sendRootsListChanged: async () => undefined,
  } as unknown as Client;
}

/** Builds a mock client that returns an MCP error result. */
function mockErrorClient(): Client {
  return {
    callTool: async () => ({
      content: [{ type: 'text', text: 'Permission denied' }],
      isError: true,
    }),
    sendRootsListChanged: async () => undefined,
  } as unknown as Client;
}

/** Reads and parses the audit log (newline-delimited JSON). */
function readAudit(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Registers the standard filesystem toolset from `testToolAnnotations`. */
function registerFilesystemTools(coordinator: ToolCallCoordinator, client: Client): void {
  const fsServer = testToolAnnotations.servers.filesystem;
  const fsTools: ProxiedTool[] = fsServer.tools.map((a) => ({
    serverName: a.serverName,
    name: a.toolName,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  }));
  const state: ClientState = { client, roots: [] };
  coordinator.registerTools('filesystem', fsTools, state);
}

/** Builds a coordinator with the deterministic test policy + a mock client. */
function makeCoordinator(auditSuffix: string): {
  coordinator: ToolCallCoordinator;
  auditPath: string;
  client: Client;
} {
  const auditPath = makeAuditPath(auditSuffix);
  const client = mockSuccessClient();
  const coordinator = new ToolCallCoordinator({
    compiledPolicy: testCompiledPolicy,
    toolAnnotations: testToolAnnotations,
    protectedPaths: TEST_PROTECTED_PATHS,
    allowedDirectory: TEST_SANDBOX_DIR,
    auditLogPath: auditPath,
  });
  registerFilesystemTools(coordinator, client);
  return { coordinator, auditPath, client };
}

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
  // Treat TEST_ROOT as this run's IronCurtain home so persona policy dirs
  // written inside it pass the coordinator's `validatePolicyDir` containment
  // check (needed by the loadPolicy drain test below).
  process.env.IRONCURTAIN_HOME = TEST_ROOT;
});

afterEach(() => {
  delete process.env.IRONCURTAIN_HOME;
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/**
 * Writes a persona-style policy directory containing only
 * `compiled-policy.json` (annotations are globally scoped and retained at
 * coordinator construction). Mirrors `coordinator-control-server.test.ts`.
 */
function writePersonaPolicy(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compiled-policy.json'), JSON.stringify({ ...testCompiledPolicy, rules: [] }));
}

/**
 * Builds a held-open `onEscalation` handler: returns a promise that
 * resolves `entered` when the escalation wait begins, and only settles the
 * decision once `release` is called. The escalation wait runs OUTSIDE the
 * coordinator's call mutex, so a call parked here is the precise condition
 * that `withToolCallsQuiesced` (loadPolicy/close drain) must still wait on.
 */
function makeHeldEscalation(): {
  onEscalation: () => Promise<{ decision: 'approved' | 'denied' }>;
  entered: Promise<void>;
  release: (decision: 'approved' | 'denied') => void;
} {
  const entered = deferred<undefined>();
  const decision = deferred<{ decision: 'approved' | 'denied' }>();
  return {
    onEscalation: () => {
      entered.resolve(undefined);
      return decision.promise;
    },
    entered: entered.promise.then(() => undefined),
    release: (d) => decision.resolve({ decision: d }),
  };
}

/**
 * A `LanguageModelV3` whose auto-approval generate call is gated: every
 * invocation blocks until `release()` fires, then returns an `approve`
 * decision. `concurrentReached(n)` resolves once `n` invocations are
 * simultaneously parked inside `doGenerate` -- the signal that the
 * auto-approval branch is NOT serializing on the coordinator's call mutex.
 */
function makeGatedAutoApproveModel(): {
  model: LanguageModelV3;
  concurrentReached: (n: number) => Promise<void>;
  release: () => void;
} {
  const gate = deferred<undefined>();
  let inFlight = 0;
  const thresholdWaiters: Array<{ n: number; resolve: () => void }> = [];
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      inFlight++;
      for (const w of thresholdWaiters) {
        if (inFlight >= w.n) w.resolve();
      }
      try {
        await gate.promise;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ decision: 'approve', reasoning: 'authorized by user message' }),
            },
          ],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: undefined, reasoning: undefined },
          },
          warnings: [],
          request: {},
          response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
        };
      } finally {
        inFlight--;
      }
    },
  }) as unknown as LanguageModelV3;
  return {
    model,
    concurrentReached: (n) => {
      if (inFlight >= n) return Promise.resolve();
      return new Promise<void>((resolve) => thresholdWaiters.push({ n, resolve }));
    },
    release: () => gate.resolve(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator', () => {
  describe('allow path', () => {
    it('dispatches allowed calls and writes a success audit entry', async () => {
      const { coordinator, auditPath } = makeCoordinator('allow');
      try {
        const req = makeRequest({ toolName: 'list_allowed_directories', arguments: {} });
        const result = await coordinator.handleStructuredToolCall(req);

        expect(result.status).toBe('success');
        expect(result.policyDecision.status).toBe('allow');
        // Side-effect-free introspection is resolved by the engine's
        // structural-invariant layer before compiled rules run.
        expect(result.policyDecision.rule).toBe('structural-introspection-allow');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      expect((entries[0] as { result: { status: string } }).result.status).toBe('success');
    });
  });

  describe('deny path', () => {
    it('denies protected-path access without dispatching', async () => {
      // Build a tracked client so we can assert the dispatch never happens.
      let callCount = 0;
      const auditPath = makeAuditPath('deny-protected');
      const client: Client = {
        callTool: async () => {
          callCount++;
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;
      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);
      try {
        const req = makeRequest({
          toolName: 'read_file',
          arguments: { path: TEST_PROTECTED_PATHS[0] },
        });
        const result = await coordinator.handleStructuredToolCall(req);

        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.rule).toBe('structural-protected-path');
        expect(callCount).toBe(0);
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      expect((entries[0] as { result: { status: string } }).result.status).toBe('denied');
    });
  });

  describe('invalid-arguments path', () => {
    it('denies requests with unknown argument keys', async () => {
      const { coordinator, auditPath } = makeCoordinator('invalid-args');
      try {
        const req = makeRequest({
          toolName: 'read_file',
          // `not_path` is not in the tool's inputSchema properties
          arguments: { not_path: '/tmp/foo' },
        });
        const result = await coordinator.handleStructuredToolCall(req);

        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.rule).toBe('invalid-arguments');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      const entry = entries[0] as { policyDecision: { rule: string } };
      expect(entry.policyDecision.rule).toBe('invalid-arguments');
    });
  });

  describe('escalation path (in-process callback)', () => {
    it('invokes the callback when policy escalates and honors "denied"', async () => {
      const auditPath = makeAuditPath('escalate-denied');
      let calledBack = false;
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => {
          calledBack = true;
          return { decision: 'denied' };
        },
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'write_file',
          // Writing outside the sandbox → `escalate-write-outside-permitted-areas`
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(calledBack).toBe(true);
        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.reason).toContain('Denied by human');
      } finally {
        await coordinator.close();
      }
    });

    it('does not hold the call mutex while waiting for human escalation', async () => {
      const auditPath = makeAuditPath('escalate-releases-mutex');
      const enteredEscalation = deferred<undefined>();
      const escalationDecision = deferred<{ decision: 'approved' | 'denied' }>();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => {
          enteredEscalation.resolve(undefined);
          return escalationDecision.promise;
        },
      });
      registerFilesystemTools(coordinator, client);

      try {
        const escalating = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'escalating-call',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/f.txt' },
          }),
        );
        await enteredEscalation.promise;

        const allowed = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'allowed-while-escalating',
            toolName: 'list_allowed_directories',
            arguments: {},
          }),
        );
        const race = await Promise.race([
          allowed.then((result) => result.status),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
        ]);
        expect(race).toBe('success');

        escalationDecision.resolve({ decision: 'denied' });
        const escalatingResult = await escalating;
        expect(escalatingResult.status).toBe('denied');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.map((entry) => entry.requestId)).toEqual(['allowed-while-escalating', 'escalating-call']);
    });

    it('invokes the callback and honors "approved"', async () => {
      const auditPath = makeAuditPath('escalate-approved');
      // Build a client whose `sendRootsListChanged` immediately fires
      // the `rootsRefreshed` callback so the post-escalation root
      // expansion doesn't block on the timeout.
      const state: ClientState = {
        client: null as unknown as Client,
        roots: [],
      };
      const client = {
        callTool: async () => ({ content: [{ type: 'text', text: 'file content' }], isError: false }),
        sendRootsListChanged: async () => {
          state.rootsRefreshed?.();
          state.rootsRefreshed = undefined;
        },
      } as unknown as Client;
      state.client = client;

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => ({ decision: 'approved' }),
      });
      // Directly register with the prepared ClientState so rootsRefreshed wiring is used.
      const fsServer = testToolAnnotations.servers.filesystem;
      const fsTools: ProxiedTool[] = fsServer.tools.map((a) => ({
        serverName: a.serverName,
        name: a.toolName,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }));
      coordinator.registerTools('filesystem', fsTools, state);

      try {
        const req = makeRequest({
          toolName: 'read_file',
          arguments: { path: '/etc/hostname' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('success');
        expect(result.policyDecision.status).toBe('allow');
        expect(result.policyDecision.reason).toContain('Approved by human');
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('post-call bookkeeping', () => {
    it('writes a success audit entry for allowed calls (exercises post-call path)', async () => {
      // The post-call band of handleToolCall runs `updateServerContext`
      // for git tools and then logAudit(status:success). We verify the
      // audit-success half directly; the git-context half is covered
      // by existing `mcp-proxy-server.test.ts` tests which exercise the
      // same underlying `handleCallTool` code path.
      const { coordinator, auditPath } = makeCoordinator('post-call-success');

      try {
        const result = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        );
        expect(result.status).toBe('success');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      expect((entries[0] as { result: { status: string } }).result.status).toBe('success');
    });

    it('does NOT run post-call bookkeeping on error results', async () => {
      const auditPath = makeAuditPath('error-no-context');
      const client = mockErrorClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'list_allowed_directories',
          arguments: {},
        });
        const result = await coordinator.handleStructuredToolCall(req);
        // Despite the MCP error, the coordinator returns an error
        // status without updating context -- audit entry records
        // status=error, not success.
        expect(result.status).toBe('error');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      const resultEntries = entries.filter((e) => (e as { result?: { status?: string } }).result !== undefined);
      expect(resultEntries.length).toBe(1);
      expect((resultEntries[0] as { result: { status: string } }).result.status).toBe('error');
    });
  });

  describe('tool-call mutex', () => {
    it('serializes concurrent handleToolCall invocations', async () => {
      const auditPath = makeAuditPath('mutex');
      let concurrentCount = 0;
      let maxConcurrent = 0;
      const client: Client = {
        callTool: async () => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          // Yield to the event loop so any non-serialized caller could
          // race past us while we're "in flight".
          await new Promise((r) => setTimeout(r, 10));
          concurrentCount--;
          return {
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
      });
      registerFilesystemTools(coordinator, client);

      try {
        const calls = Array.from({ length: 5 }, () =>
          coordinator.handleStructuredToolCall(makeRequest({ toolName: 'list_allowed_directories', arguments: {} })),
        );
        await Promise.all(calls);
      } finally {
        await coordinator.close();
      }

      // The mutex guarantees max concurrency of 1 inside the dispatch.
      expect(maxConcurrent).toBe(1);
    });

    it('preserves FIFO audit order and workers-aware breaker counts under concurrent structured streams', async () => {
      const auditPath = makeAuditPath('concurrent-streams');
      let concurrentCount = 0;
      let maxConcurrent = 0;
      let dispatchCount = 0;
      const client: Client = {
        callTool: async () => {
          concurrentCount++;
          dispatchCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          await new Promise((r) => setTimeout(r, 1));
          concurrentCount--;
          return {
            content: [{ type: 'text', text: 'ok' }],
            isError: false,
          };
        },
        sendRootsListChanged: async () => undefined,
      } as unknown as Client;

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        workerCount: 2,
      });
      registerFilesystemTools(coordinator, client);

      const requests = Array.from({ length: 41 }, (_, i) =>
        makeRequest({
          requestId: `fifo-${String(i).padStart(2, '0')}`,
          toolName: 'list_allowed_directories',
          arguments: {},
        }),
      );

      let results;
      try {
        results = await Promise.all(requests.map((req) => coordinator.handleStructuredToolCall(req)));
      } finally {
        await coordinator.close();
      }

      expect(maxConcurrent).toBe(1);
      expect(dispatchCount).toBe(40);
      expect(results.slice(0, 40).every((result) => result.status === 'success')).toBe(true);
      expect(results[40].status).toBe('denied');
      expect(results[40].policyDecision.rule).toBe('circuit-breaker');

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(41);
      expect(entries.map((entry) => entry.requestId)).toEqual(requests.map((req) => req.requestId));
      expect(entries.slice(0, 40).every((entry) => (entry.result as { status: string }).status === 'success')).toBe(
        true,
      );
      expect((entries[40].result as { status: string }).status).toBe('denied');
      expect(JSON.stringify(entries[40])).toContain('40 times');
    });
  });

  describe('close() flushes the audit log', () => {
    it('emits pending entries before resolving', async () => {
      const { coordinator, auditPath } = makeCoordinator('close-flush');
      await coordinator.handleStructuredToolCall(makeRequest({ toolName: 'list_allowed_directories', arguments: {} }));
      await coordinator.close();

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
    });
  });

  describe('loadPolicy (missing policyDir)', () => {
    it('rejects with a filesystem error when the policy dir does not exist', async () => {
      // Covered in depth by `coordinator-control-server.test.ts`; this
      // spot check exercises the same code path from the coordinator's
      // public surface to guard against regression.
      const { coordinator } = makeCoordinator('load-policy-missing');
      try {
        await expect(
          coordinator.loadPolicy({
            persona: 'global',
            version: 1,
            policyDir: `/tmp/does-not-exist-${process.pid}-${Date.now()}`,
            auditPath: `${TEST_ROOT}/audit.unused.jsonl`,
          }),
        ).rejects.toThrow();
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('requestId/timestamp correlation', () => {
    it('preserves the caller-supplied requestId and timestamp in the audit entry', async () => {
      // Structured callers (coordinator handleStructuredToolCall) carry
      // their own requestId/timestamp. Pre-fix, handleCallTool synthesized
      // fresh values and dropped the caller's -- breaking correlation
      // between caller-side tracing and the audit log.
      const { coordinator, auditPath } = makeCoordinator('requestid-correlation');
      const callerRequestId = 'caller-trace-0000-aaaa-bbbb-cccc';
      const callerTimestamp = '2025-01-15T12:34:56.789Z';
      try {
        const req = makeRequest({
          requestId: callerRequestId,
          timestamp: callerTimestamp,
          toolName: 'list_allowed_directories',
          arguments: {},
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('success');
        // The coordinator echoes the caller's requestId on the result.
        expect(result.requestId).toBe(callerRequestId);
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      const entry = entries[0] as { requestId: string; timestamp: string };
      expect(entry.requestId).toBe(callerRequestId);
      expect(entry.timestamp).toBe(callerTimestamp);
    });
  });

  describe('escalation with no handler configured', () => {
    it('returns status:denied (not error) when no escalation handler is available', async () => {
      // Pre-fix the `_policyDecision.status` on this branch carried the
      // original 'escalate' value, causing the coordinator's classifier
      // to report `status:'error'` instead of `'denied'`. The outcome
      // IS a denial (we have no way to escalate), so it must be labeled
      // as such.
      const auditPath = makeAuditPath('escalate-no-handler');
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        // Deliberately leave `onEscalation` and `escalationDir` unset.
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'write_file',
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
      } finally {
        await coordinator.close();
      }
    });
  });

  describe('human-denied escalation: audit and returned decision agree', () => {
    it('writes a deny-status audit entry that matches the returned PolicyDecision', async () => {
      // Pre-fix the outer `policyDecision` (captured by the audit
      // closure) still had status:'escalate' and the original
      // evaluation reason, while the returned `_policyDecision`
      // reported status:'deny' with 'Denied by human during escalation'.
      // Audit and returned decision must agree.
      const auditPath = makeAuditPath('escalate-denied-audit-agrees');
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => ({ decision: 'denied' }),
      });
      registerFilesystemTools(coordinator, client);

      try {
        const req = makeRequest({
          toolName: 'write_file',
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        });
        const result = await coordinator.handleStructuredToolCall(req);
        expect(result.status).toBe('denied');
        expect(result.policyDecision.status).toBe('deny');
        expect(result.policyDecision.reason).toBe('Denied by human during escalation');
      } finally {
        await coordinator.close();
      }

      const entries = readAudit(auditPath);
      expect(entries.length).toBe(1);
      const entry = entries[0] as {
        policyDecision: { status: string; reason: string };
        result: { status: string; error?: string };
        escalationResult?: string;
      };
      // Audit must reflect the human-denial outcome, not the original
      // 'escalate' decision from the policy engine.
      expect(entry.policyDecision.status).toBe('deny');
      expect(entry.policyDecision.reason).toBe('Denied by human during escalation');
      expect(entry.result.status).toBe('denied');
      expect(entry.result.error).toBe('Denied by human during escalation');
      expect(entry.escalationResult).toBe('denied');
    });
  });

  describe('handleStructuredToolCall: synthetic entries are not leaked', () => {
    it('does not mutate toolMap for unregistered tools', async () => {
      const { coordinator } = makeCoordinator('synth-no-leak');
      try {
        // Call into an unregistered (server, tool) pair. Pre-fix, this
        // would persist a synthetic entry in `this.toolMap` keyed by
        // toolName, so a subsequent call to the same name on a
        // different server would see the wrong serverName.
        await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'unknown-server',
            toolName: 'nonexistent_tool',
            arguments: {},
          }),
        );

        const registered = coordinator.getRegisteredTools();
        expect(registered.some((t) => t.name === 'nonexistent_tool')).toBe(false);
      } finally {
        await coordinator.close();
      }
    });

    it('does not cross-route tools with the same name across different servers', async () => {
      // Two unregistered (server, tool) requests sharing a tool name.
      // Pre-fix, the second request would reuse the synthetic entry
      // from the first and report serverName=server-A even when the
      // caller supplied server-B. Post-fix, each call builds its own
      // synthetic entry scoped to that invocation.
      const { coordinator } = makeCoordinator('synth-no-cross');
      try {
        const first = await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'server-A',
            toolName: 'shared_tool',
            arguments: {},
          }),
        );
        const second = await coordinator.handleStructuredToolCall(
          makeRequest({
            serverName: 'server-B',
            toolName: 'shared_tool',
            arguments: {},
          }),
        );

        // Both calls route through the engine and land on
        // `missing-annotation`. The reason text carries the server
        // name, which must match the caller's request in each case.
        expect(first.policyDecision.rule).toBe('missing-annotation');
        expect(second.policyDecision.rule).toBe('missing-annotation');
        expect(first.policyDecision.reason).toContain('server-A');
        expect(second.policyDecision.reason).toContain('server-B');

        // Neither call should leak into the registry.
        expect(coordinator.getRegisteredTools().some((t) => t.name === 'shared_tool')).toBe(false);
      } finally {
        await coordinator.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Quiesce drain: loadPolicy / close must wait out an escalation that is
  // paused OUTSIDE the call mutex. This is the property that prevents a
  // mid-escalation policy/persona swap. The escalation wait releases the
  // call mutex, so the old call-mutex-only drain would not catch it -- the
  // `activeToolCalls` counter + `withToolCallsQuiesced` is what does.
  // -------------------------------------------------------------------------

  describe('quiesce drains a held-open escalation', () => {
    it('close() does not resolve while an escalation wait is held open', async () => {
      const auditPath = makeAuditPath('close-drains-escalation');
      const escalation = makeHeldEscalation();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: escalation.onEscalation,
      });
      registerFilesystemTools(coordinator, client);

      // 1. Park a call inside the escalation wait (mutex released here).
      const escalating = coordinator.handleStructuredToolCall(
        makeRequest({
          requestId: 'held-escalation',
          toolName: 'write_file',
          arguments: { path: '/tmp/outside-sandbox/f.txt' },
        }),
      );
      await escalation.entered;

      // 2. Record ordering: close() must observe the escalation resolving
      //    BEFORE its own drain completes.
      const order: string[] = [];
      let closeResolved = false;
      const closePromise = coordinator.close().then(() => {
        closeResolved = true;
        order.push('close-resolved');
      });

      // 3. The drain must NOT complete while the escalation is held open.
      const raced = await Promise.race([
        closePromise.then(() => 'closed' as const),
        new Promise<'still-blocked'>((r) => setTimeout(() => r('still-blocked'), 50)),
      ]);
      expect(raced).toBe('still-blocked');
      expect(closeResolved).toBe(false);

      // 4. Resolve the escalation. The held call drains, then close()
      //    completes -- and only in that order.
      escalation.release('denied');
      order.push('escalation-released');
      const escalatingResult = await escalating;
      await closePromise;

      expect(escalatingResult.status).toBe('denied');
      expect(closeResolved).toBe(true);
      expect(order).toEqual(['escalation-released', 'close-resolved']);
    });

    it('loadPolicy() does not swap the engine while an escalation wait is held open', async () => {
      const auditPath = makeAuditPath('loadpolicy-drains-escalation');
      const newPolicyDir = join(TEST_ROOT, 'policy-quiesce');
      writePersonaPolicy(newPolicyDir);
      const escalation = makeHeldEscalation();
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: escalation.onEscalation,
      });
      registerFilesystemTools(coordinator, client);
      const oldEngine = coordinator.getPolicyEngine();

      try {
        // 1. Park a call inside the escalation wait (mutex released).
        const escalating = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'held-escalation',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/f.txt' },
          }),
        );
        await escalation.entered;

        // 2. Kick off loadPolicy with a VALID (containment-passing) dir.
        //    Its body must not run -- the engine swap is the last
        //    observable step inside the quiesced critical section.
        let loadResolved = false;
        const loadPromise = coordinator.loadPolicy({ persona: 'reviewer', policyDir: newPolicyDir }).then(() => {
          loadResolved = true;
        });

        const raced = await Promise.race([
          loadPromise.then(() => 'loaded' as const),
          new Promise<'still-blocked'>((r) => setTimeout(() => r('still-blocked'), 50)),
        ]);
        expect(raced).toBe('still-blocked');
        expect(loadResolved).toBe(false);
        // The engine swap (loadPolicy step 4) cannot have happened yet.
        expect(coordinator.getPolicyEngine()).toBe(oldEngine);

        // 3. Resolve the escalation. The held call drains, then loadPolicy
        //    proceeds and swaps the engine.
        escalation.release('denied');
        await escalating;
        await loadPromise;

        expect(loadResolved).toBe(true);
        expect(coordinator.getPolicyEngine()).not.toBe(oldEngine);
      } finally {
        await coordinator.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Escalation-hook-throws cleanup: a throwing onEscalation must not leak the
  // call mutex or the admission slot. `runSerializedToolCall`'s outer finally
  // releases the mutex even on throw, and `handleStructuredToolCall`'s finally
  // calls `leaveToolCall` (draining `activeToolCalls` back to 0). The two
  // observable consequences: the NEXT call still acquires the mutex and
  // succeeds, and `close()` still drains (it never hangs waiting on a leaked
  // active-call counter). Disabling either cleanup deadlocks one of these.
  // -------------------------------------------------------------------------

  describe('escalation hook throws', () => {
    it('leaks no mutex or admission slot: the next call succeeds and close() drains', async () => {
      const auditPath = makeAuditPath('escalation-hook-throws');
      const client = mockSuccessClient();

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        onEscalation: async () => {
          throw new Error('escalation hook boom');
        },
      });
      registerFilesystemTools(coordinator, client);

      try {
        // 1. The throwing escalation hook must reject the call -- but the
        //    mutex must be reacquired+released and the admission slot
        //    returned (leaveToolCall in finally).
        await expect(
          coordinator.handleStructuredToolCall(
            makeRequest({
              toolName: 'write_file',
              arguments: { path: '/tmp/outside-sandbox/f.txt' },
            }),
          ),
        ).rejects.toThrow('escalation hook boom');

        // 2. A subsequent allowed call must succeed -- proving no mutex or
        //    admission slot leaked from the thrown hook.
        const next = await coordinator.handleStructuredToolCall(
          makeRequest({ toolName: 'list_allowed_directories', arguments: {} }),
        );
        expect(next.status).toBe('success');
      } finally {
        // 3. close() must drain cleanly (activeToolCalls back to 0).
        await coordinator.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Auto-approval liveness: the auto-approval branch (not just the human
  // path) runs inside the escalation wait, outside the call mutex. Two
  // concurrent auto-approvals must not serialize on the mutex.
  // -------------------------------------------------------------------------

  describe('auto-approval runs outside the call mutex', () => {
    it('does not serialize two concurrent auto-approvals on the call mutex', async () => {
      const auditPath = makeAuditPath('auto-approve-concurrent');
      const first = makeGatedAutoApproveModel();
      // After an approved escalation, the pipeline expands MCP roots and
      // waits for the client to refresh. Wire `rootsRefreshed` so the two
      // approved calls don't each block on ROOTS_REFRESH_TIMEOUT_MS.
      const state: ClientState = { client: null as unknown as Client, roots: [] };
      const client = {
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
        sendRootsListChanged: async () => {
          state.rootsRefreshed?.();
          state.rootsRefreshed = undefined;
        },
      } as unknown as Client;
      state.client = client;

      const coordinator = new ToolCallCoordinator({
        compiledPolicy: testCompiledPolicy,
        toolAnnotations: testToolAnnotations,
        protectedPaths: TEST_PROTECTED_PATHS,
        allowedDirectory: TEST_SANDBOX_DIR,
        auditLogPath: auditPath,
        autoApproveModel: first.model,
        // A human handler must be present for the escalation branch to be
        // entered at all (otherwise the no-handler path denies before the
        // wait). Auto-approval is tried first inside the wait, so this hook
        // should never fire -- if it does, the test fails on the deny.
        onEscalation: async () => ({ decision: 'denied' }),
      });
      // The auto-approver reads the last user message for intent matching.
      coordinator.setLastUserMessage('please write the file at /tmp/outside-sandbox, I authorize it');
      const fsTools: ProxiedTool[] = testToolAnnotations.servers.filesystem.tools.map((a) => ({
        serverName: a.serverName,
        name: a.toolName,
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      }));
      coordinator.registerTools('filesystem', fsTools, state);

      try {
        // 1. Start two escalating calls. Each enters the auto-approval
        //    branch of the escalation wait. If that branch held the call
        //    mutex, the second model invocation could not begin until the
        //    first returned.
        const callA = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'auto-A',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/a.txt' },
          }),
        );
        const callB = coordinator.handleStructuredToolCall(
          makeRequest({
            requestId: 'auto-B',
            toolName: 'write_file',
            arguments: { path: '/tmp/outside-sandbox/b.txt' },
          }),
        );

        // 2. KEY assertion: BOTH auto-approval model calls must be parked
        //    inside doGenerate at the same time. `concurrentReached(2)`
        //    resolves only when two invocations are simultaneously gated.
        //    If the call mutex serialized the escalation wait, the second
        //    model call could never start while the first is gated, so the
        //    count would stay at 1 and this would time out.
        const bothInFlight = await Promise.race([
          first.concurrentReached(2).then(() => 'both-in-flight' as const),
          new Promise<'serialized'>((r) => setTimeout(() => r('serialized'), 50)),
        ]);
        expect(bothInFlight).toBe('both-in-flight');

        // 3. Release the gate; both auto-approvals complete and allow.
        first.release();
        const [resultA, resultB] = await Promise.all([callA, callB]);
        expect(resultA.status).toBe('success');
        expect(resultB.status).toBe('success');
        expect(resultA.policyDecision.status).toBe('allow');
        expect(resultB.policyDecision.status).toBe('allow');
        expect(resultA.policyDecision.reason).toContain('Auto-approved');
      } finally {
        await coordinator.close();
      }
    });
  });
});
