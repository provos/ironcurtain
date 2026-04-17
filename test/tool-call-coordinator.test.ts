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
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
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
});

afterEach(() => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

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

  describe('loadPolicy (Step 1 stub)', () => {
    it('throws a descriptive error until Step 2 lands', async () => {
      const { coordinator } = makeCoordinator('load-policy');
      try {
        await expect(
          coordinator.loadPolicy({
            persona: 'global',
            version: 1,
            policyDir: '/tmp/dummy',
            auditPath: '/tmp/audit.jsonl',
          }),
        ).rejects.toThrow(/not implemented in Step 1/);
      } finally {
        await coordinator.close();
      }
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
});
