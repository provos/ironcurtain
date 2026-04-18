/**
 * Tests for the coordinator's HTTP control server and real `loadPolicy`.
 *
 * Covers:
 *   - Unit: `coordinator.loadPolicy(...)` swaps engine + persona stamp
 *     on success, and leaves the old engine intact on failure.
 *   - HTTP: the control endpoint validates input, dispatches to
 *     `loadPolicy`, and surfaces 200/400/500 correctly.
 *   - Concurrency: a slow in-flight tool call delays `loadPolicy` until
 *     it finishes (mutex ordering from §2.1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { v4 as uuidv4 } from 'uuid';
import { ToolCallCoordinator } from '../src/trusted-process/tool-call-coordinator.js';
import type { ClientState, ProxiedTool } from '../src/trusted-process/tool-call-pipeline.js';
import { ControlServer } from '../src/trusted-process/control-server.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  TEST_SANDBOX_DIR,
} from './fixtures/test-policy.js';
import type { ToolCallRequest } from '../src/types/mcp.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const TEST_ROOT = resolve(tmpdir(), `coord-control-${process.pid}`);

function mkdir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Writes a persona-style policy directory containing only
 * `compiled-policy.json`. Mirrors production layout where persona dirs
 * ship per-persona policy but inherit the globally-scoped tool
 * annotations from the session-level coordinator construction.
 */
function writePersonaPolicy(dir: string, compiledPolicy: CompiledPolicyFile): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
}

function mockSuccessClient(): Client {
  return {
    callTool: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
    sendRootsListChanged: async () => undefined,
  } as unknown as Client;
}

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

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: uuidv4(),
    serverName: 'filesystem',
    toolName: 'list_allowed_directories',
    arguments: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function readAudit(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface HttpResponse {
  status: number;
  body: string;
}

/** Sends a JSON POST over a UDS-attached HTTP server. */
function postJsonUds(socketPath: string, path: string, body: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
        },
      },
      (res: IncomingMessage) => {
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Sends a raw (possibly malformed) POST body over a UDS. */
function postRawUds(socketPath: string, path: string, body: string): Promise<HttpResponse> {
  return postJsonUds(socketPath, path, body);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_SANDBOX_DIR, { recursive: true });
  // Treat TEST_ROOT as this run's IronCurtain home so persona policy
  // dirs written inside it pass the coordinator's containment check.
  process.env.IRONCURTAIN_HOME = TEST_ROOT;
});

afterEach(() => {
  try {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  delete process.env.IRONCURTAIN_HOME;
});

// ---------------------------------------------------------------------------
// Unit-level loadPolicy
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator.loadPolicy (unit)', () => {
  it('swaps the policy engine and stamps the new persona on subsequent audit entries', async () => {
    const auditPath = join(TEST_ROOT, 'audit.single.jsonl');
    const newPolicyDir = mkdir(join(TEST_ROOT, 'new-policy'));
    // A minimal but valid policy with zero rules.
    writePersonaPolicy(newPolicyDir, {
      ...testCompiledPolicy,
      rules: [],
    });

    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: auditPath,
    });
    const oldEngine = coordinator.getPolicyEngine();
    registerFilesystemTools(coordinator, mockSuccessClient());

    try {
      // Pre-swap: no persona active, so entries omit the field.
      await coordinator.handleStructuredToolCall(makeRequest());

      await coordinator.loadPolicy({ persona: 'reviewer', policyDir: newPolicyDir });

      const newEngine = coordinator.getPolicyEngine();
      expect(newEngine).not.toBe(oldEngine);

      // Post-swap: the coordinator stamps `persona: 'reviewer'` on
      // every subsequent audit entry. Same single file as before.
      await coordinator.handleStructuredToolCall(makeRequest());
    } finally {
      await coordinator.close();
    }

    const entries = readAudit(auditPath);
    expect(entries.length).toBe(2);
    expect(entries[0].persona).toBeUndefined();
    expect(entries[1].persona).toBe('reviewer');
  });

  it('rejects a policyDir outside the trusted roots without touching the live policy', async () => {
    // Defense-in-depth: any process that can reach the control socket
    // can invoke `loadPolicy`, so the coordinator must refuse paths
    // outside `$IRONCURTAIN_HOME` / the package config dir before
    // calling the policy loader.
    const auditPath = join(TEST_ROOT, 'audit.untrusted.jsonl');
    // A path that's definitely outside the test's IronCurtain home.
    const evilDir = resolve(tmpdir(), `coord-evil-${process.pid}`);
    mkdirSync(evilDir, { recursive: true });
    // Populate it with a syntactically-valid policy so that if the
    // validator is missing, the loader would otherwise succeed.
    writePersonaPolicy(evilDir, { ...testCompiledPolicy, rules: [] });

    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: auditPath,
    });
    const oldEngine = coordinator.getPolicyEngine();
    registerFilesystemTools(coordinator, mockSuccessClient());

    try {
      await expect(coordinator.loadPolicy({ persona: 'reviewer', policyDir: evilDir })).rejects.toThrow(
        /policyDir must be under a trusted directory/,
      );

      // Engine reference is unchanged -- the attempted load was
      // rejected before touching anything.
      expect(coordinator.getPolicyEngine()).toBe(oldEngine);
    } finally {
      await coordinator.close();
      rmSync(evilDir, { recursive: true, force: true });
    }
  });

  it('leaves the old engine active when the new policy dir is missing', async () => {
    const auditPath = join(TEST_ROOT, 'audit.keep.jsonl');
    const missingDir = join(TEST_ROOT, 'does-not-exist');

    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: auditPath,
    });
    const oldEngine = coordinator.getPolicyEngine();
    registerFilesystemTools(coordinator, mockSuccessClient());

    try {
      await expect(coordinator.loadPolicy({ persona: 'reviewer', policyDir: missingDir })).rejects.toThrow();

      // Engine reference is unchanged.
      expect(coordinator.getPolicyEngine()).toBe(oldEngine);

      // Audit stream is still usable; since persona swap never
      // completed, the entry must not carry a persona.
      await coordinator.handleStructuredToolCall(makeRequest());
    } finally {
      await coordinator.close();
    }

    const entries = readAudit(auditPath);
    expect(entries.length).toBe(1);
    expect(entries[0].persona).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP control endpoint
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator control endpoint (UDS)', () => {
  it('accepts a valid load request, returns 200, and swaps the engine', async () => {
    const auditPath = join(TEST_ROOT, 'audit.http-success.jsonl');
    const socketPath = join(TEST_ROOT, 'control-success.sock');
    const newPolicyDir = mkdir(join(TEST_ROOT, 'policy-success'));
    writePersonaPolicy(newPolicyDir, { ...testCompiledPolicy, rules: [] });

    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: auditPath,
      controlServerListen: { socketPath },
    });
    registerFilesystemTools(coordinator, mockSuccessClient());
    const oldEngine = coordinator.getPolicyEngine();

    try {
      const addr = await coordinator.start();
      expect(addr).toEqual({ socketPath });

      const body = JSON.stringify({
        persona: 'reviewer',
        policyDir: newPolicyDir,
      });
      const res = await postJsonUds(socketPath, '/__ironcurtain/policy/load', body);
      expect(res.status).toBe(200);

      const parsed = JSON.parse(res.body) as { ok: boolean; loadedAt: string };
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.loadedAt).toBe('string');
      // loadedAt must parse as a valid ISO timestamp.
      expect(Number.isNaN(Date.parse(parsed.loadedAt))).toBe(false);

      expect(coordinator.getPolicyEngine()).not.toBe(oldEngine);

      // A subsequent tool call is stamped with the new persona and
      // lands in the same (single) audit file.
      await coordinator.handleStructuredToolCall(makeRequest());
    } finally {
      await coordinator.close();
    }

    // Socket file removed on close.
    expect(existsSync(socketPath)).toBe(false);
    const entries = readAudit(auditPath);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.at(-1)?.persona).toBe('reviewer');
  });

  it('returns 400 for malformed JSON', async () => {
    const socketPath = join(TEST_ROOT, 'control-400.sock');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: join(TEST_ROOT, 'audit.400.jsonl'),
      controlServerListen: { socketPath },
    });

    try {
      await coordinator.start();
      const res = await postRawUds(socketPath, '/__ironcurtain/policy/load', '{not-json');
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body) as { error: string };
      // Exact-match: the server returns a generic message so that
      // JSON.parse's byte-offset internals never cross the trust
      // boundary. The input fragment 'not-json' must not appear in
      // the response.
      expect(parsed.error).toBe('Invalid JSON');
      expect(parsed.error).not.toContain('not-json');
    } finally {
      await coordinator.close();
    }
  });

  it('rejects an oversized body (> MAX_BODY_BYTES)', async () => {
    // The control server caps request bodies at 4 KiB (MAX_BODY_BYTES
    // in control-server.ts). Larger bodies are hostile or buggy --
    // load requests are tiny. The server destroys the request stream
    // when the cap is hit, which either surfaces to the client as a
    // 400 (server wrote its response before teardown) or as a socket
    // error (connection was aborted mid-flight). Both outcomes are
    // acceptable; what matters is that the request does NOT succeed
    // and the server does not attempt to load the oversize payload.
    const socketPath = join(TEST_ROOT, 'control-oversize.sock');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: join(TEST_ROOT, 'audit.oversize.jsonl'),
      controlServerListen: { socketPath },
    });

    try {
      await coordinator.start();
      // Construct a body that is well past the 4 KiB cap. The JSON
      // shape is valid so, absent the cap, the server would attempt
      // to load a bogus policy dir and return 500 -- definitely not
      // a 200.
      const filler = 'x'.repeat(8192);
      const body = JSON.stringify({
        persona: 'reviewer',
        policyDir: '/tmp/unused',
        filler,
      });
      expect(Buffer.byteLength(body)).toBeGreaterThan(4096);

      // Either the server wrote a 4xx response before tearing down
      // the connection, or the connection was aborted. The request
      // helper throws on socket errors, so we catch both outcomes.
      let status: number | 'aborted' = 'aborted';
      try {
        const res = await postRawUds(socketPath, '/__ironcurtain/policy/load', body);
        status = res.status;
      } catch {
        status = 'aborted';
      }

      if (typeof status === 'number') {
        // The server responded. It MUST NOT be 200 -- a 200 would
        // mean an oversize body was accepted and dispatched.
        expect(status).not.toBe(200);
        expect(status).toBeGreaterThanOrEqual(400);
      } else {
        // Connection aborted; also acceptable.
        expect(status).toBe('aborted');
      }
    } finally {
      await coordinator.close();
    }
  });

  it('returns 400 when policyDir is missing', async () => {
    const socketPath = join(TEST_ROOT, 'control-missing-dir.sock');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: join(TEST_ROOT, 'audit.missing-dir.jsonl'),
      controlServerListen: { socketPath },
    });

    try {
      await coordinator.start();
      const res = await postJsonUds(socketPath, '/__ironcurtain/policy/load', JSON.stringify({ persona: 'reviewer' }));
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body) as { error: string };
      expect(parsed.error).toMatch(/policyDir/);
    } finally {
      await coordinator.close();
    }
  });

  it('returns 400 when persona is missing', async () => {
    const socketPath = join(TEST_ROOT, 'control-missing-persona.sock');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: join(TEST_ROOT, 'audit.missing-persona.jsonl'),
      controlServerListen: { socketPath },
    });

    try {
      await coordinator.start();
      const res = await postJsonUds(
        socketPath,
        '/__ironcurtain/policy/load',
        JSON.stringify({ policyDir: '/tmp/some-dir' }),
      );
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body) as { error: string };
      expect(parsed.error).toMatch(/persona/);
    } finally {
      await coordinator.close();
    }
  });

  it('returns 400 when persona is not a string', async () => {
    const socketPath = join(TEST_ROOT, 'control-persona-type.sock');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: join(TEST_ROOT, 'audit.persona-type.jsonl'),
      controlServerListen: { socketPath },
    });

    try {
      await coordinator.start();
      const res = await postJsonUds(
        socketPath,
        '/__ironcurtain/policy/load',
        JSON.stringify({ persona: 42, policyDir: '/tmp/some-dir' }),
      );
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body) as { error: string };
      expect(parsed.error).toMatch(/persona/);
    } finally {
      await coordinator.close();
    }
  });

  it('returns 500 when the policy dir does not exist', async () => {
    const socketPath = join(TEST_ROOT, 'control-500.sock');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: join(TEST_ROOT, 'audit.500.jsonl'),
      controlServerListen: { socketPath },
    });
    const oldEngine = coordinator.getPolicyEngine();

    try {
      await coordinator.start();
      const res = await postJsonUds(
        socketPath,
        '/__ironcurtain/policy/load',
        JSON.stringify({
          persona: 'reviewer',
          policyDir: join(TEST_ROOT, 'does-not-exist'),
        }),
      );
      expect(res.status).toBe(500);
      const parsed = JSON.parse(res.body) as { error: string };
      // The server must return a generic message -- raw error text
      // from filesystem failures commonly embeds absolute paths, so
      // we assert both the generic body AND that the attempted path
      // is NOT echoed back (information-exposure regression guard).
      expect(parsed.error).toBe('Internal error');
      expect(parsed.error).not.toContain('does-not-exist');
      expect(parsed.error).not.toContain(TEST_ROOT);

      // Engine reference is unchanged; old policy still active.
      expect(coordinator.getPolicyEngine()).toBe(oldEngine);
    } finally {
      await coordinator.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const socketPath = join(TEST_ROOT, 'control-404.sock');
    const coordinator = new ToolCallCoordinator({
      compiledPolicy: testCompiledPolicy,
      toolAnnotations: testToolAnnotations,
      protectedPaths: TEST_PROTECTED_PATHS,
      allowedDirectory: TEST_SANDBOX_DIR,
      auditLogPath: join(TEST_ROOT, 'audit.404.jsonl'),
      controlServerListen: { socketPath },
    });
    try {
      await coordinator.start();
      const res = await postJsonUds(socketPath, '/__ironcurtain/nope', '{}');
      expect(res.status).toBe(404);
    } finally {
      await coordinator.close();
    }
  });
});

describe('ControlServer (TCP fallback)', () => {
  it('binds loopback TCP when only `port` is supplied and serves a valid request', async () => {
    let handlerCalls = 0;
    const server = new ControlServer({
      onLoadPolicy: async () => {
        handlerCalls++;
      },
    });
    const addr = await server.start({ port: 0 });
    expect(addr.port).toBeGreaterThan(0);
    expect(addr.socketPath).toBeUndefined();

    try {
      const body = JSON.stringify({
        persona: 'reviewer',
        policyDir: '/tmp/anywhere',
      });
      const res = await new Promise<HttpResponse>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: addr.port,
            path: '/__ironcurtain/policy/load',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body).toString(),
            },
          },
          (msg: IncomingMessage) => {
            let data = '';
            msg.setEncoding('utf-8');
            msg.on('data', (chunk: string) => {
              data += chunk;
            });
            msg.on('end', () => resolve({ status: msg.statusCode ?? 0, body: data }));
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      expect(res.status).toBe(200);
      expect(handlerCalls).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it('rejects listen options that set both socketPath and port', async () => {
    const server = new ControlServer({ onLoadPolicy: async () => undefined });
    await expect(server.start({ socketPath: join(TEST_ROOT, 'x.sock'), port: 9999 })).rejects.toThrow(/exactly one/);
  });

  it('rejects a second start() call with a descriptive error', async () => {
    // Guards against the cryptic "already listening" error Node emits
    // when http.Server.listen is called on an already-bound server.
    // The coordinator-level wrapper performs the same check; this
    // asserts the lower-level contract directly.
    const server = new ControlServer({ onLoadPolicy: async () => undefined });
    await server.start({ port: 0 });
    try {
      await expect(server.start({ port: 0 })).rejects.toThrow(/called twice/);
    } finally {
      await server.stop();
    }
  });

  it('clears the bound address on stop() so getAddress() no longer reports a listener', async () => {
    const server = new ControlServer({ onLoadPolicy: async () => undefined });
    const addr = await server.start({ port: 0 });
    expect(server.getAddress()).toEqual(addr);
    await server.stop();
    expect(server.getAddress()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Concurrency: loadPolicy queues behind in-flight tool calls
// ---------------------------------------------------------------------------

describe('ToolCallCoordinator loadPolicy concurrency', () => {
  it('blocks loadPolicy from entering its critical section while a tool call is in flight', async () => {
    // To prove the call mutex GATES loadPolicy's body, we observe a
    // side-effect that happens INSIDE loadPolicy's critical section --
    // the PolicyEngine reference swap. While the tool call is gated,
    // `getPolicyEngine()` must still return the old engine.
    const auditPath = join(TEST_ROOT, 'audit.concurrency.jsonl');
    const newPolicyDir = mkdir(join(TEST_ROOT, 'policy-concurrent'));
    writePersonaPolicy(newPolicyDir, { ...testCompiledPolicy, rules: [] });

    // Two explicit barriers:
    //   - callStarted: resolves the moment the mock `callTool` enters
    //     its body. Gives the test a deterministic signal that the
    //     call has entered the coordinator's critical section and is
    //     holding the call mutex.
    //   - callGate: blocks the call at that point until the test
    //     explicitly releases it, so we can race loadPolicy against
    //     a known-in-flight call without timing heuristics.
    let resolveCallStarted: (() => void) | null = null;
    const callStarted = new Promise<void>((r) => {
      resolveCallStarted = r;
    });
    let releaseCall: (() => void) | null = null;
    const callGate = new Promise<void>((r) => {
      releaseCall = r;
    });

    const client: Client = {
      callTool: async () => {
        resolveCallStarted?.();
        await callGate;
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
    const oldEngine = coordinator.getPolicyEngine();

    try {
      // 1. Kick off the slow tool call. It blocks on `callGate`.
      const callPromise = coordinator.handleStructuredToolCall(makeRequest());

      // 2. Wait deterministically until the call has entered its body
      //    (and therefore is holding the call mutex). No setTimeout
      //    fence needed: the barrier resolves exactly when the mock
      //    enters `callTool`.
      await callStarted;

      // 3. Start loadPolicy. If the mutex works, it MUST NOT enter its
      //    body -- it will queue behind the call mutex until the tool
      //    call returns.
      const loadPromise = coordinator.loadPolicy({
        persona: 'reviewer',
        policyDir: newPolicyDir,
      });

      // 4. Loose belt-and-braces fence: give any incorrect
      //    implementation a chance to observe the race. The KEY
      //    assertion is the next one -- this sleep is defensive, not
      //    load-bearing.
      await new Promise((r) => setTimeout(r, 20));

      // 5. KEY assertion: while the tool call is gated, loadPolicy's
      //    body cannot have run, so the new audit file -- which is
      //    engine-swap step -- which is the last observable thing in
      //    loadPolicy's critical section -- must not have happened yet.
      //    If the mutex were missing, loadPolicy would have raced ahead
      //    and replaced the engine reference already.
      expect(coordinator.getPolicyEngine()).toBe(oldEngine);

      // 6. Release the tool call. loadPolicy can now proceed into its
      //    body and swap the engine.
      releaseCall?.();

      // Both promises must settle. The tool call returns successfully
      // (it ran under the old engine); loadPolicy returns once the
      // engine has been swapped. If the mutex were broken, loadPolicy
      // would have thrown or produced inconsistent state by now.
      await Promise.all([callPromise, loadPromise]);

      // Confirm the swap actually happened -- post-condition check
      // complementing the mutex-ordering assertion above.
      expect(coordinator.getPolicyEngine()).not.toBe(oldEngine);
    } finally {
      await coordinator.close();
    }
  });

  it('close() drains an in-flight tool call before closing the audit log', async () => {
    // `close()` must wait for any in-flight `handleToolCall` (which
    // holds the call mutex while writing to the audit log) to finish
    // before calling `auditLog.close()`. Without this drain, `close()`
    // would race the in-flight handler: the handler could be mid-write
    // when we end the stream, producing an async "write after end"
    // event on the process.
    //
    // We use a gated tool call as the proxy for "in-flight handler
    // holding the call mutex" because it exercises the same mutex
    // `loadPolicy` acquires. The assertion is that `close()` does NOT
    // resolve before the gated call releases, and that no write-after-
    // end errors fire in the process.
    const auditPath = join(TEST_ROOT, 'audit.close-drain.jsonl');

    let resolveCallStarted: (() => void) | null = null;
    const callStarted = new Promise<void>((r) => {
      resolveCallStarted = r;
    });
    let releaseCall: (() => void) | null = null;
    const callGate = new Promise<void>((r) => {
      releaseCall = r;
    });

    const client: Client = {
      callTool: async () => {
        resolveCallStarted?.();
        await callGate;
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

    // 1. Kick off the slow tool call. It parks on `callGate` while
    //    holding the call mutex.
    const callPromise = coordinator.handleStructuredToolCall(makeRequest());
    await callStarted;

    // 2. Trigger close() concurrently. It must NOT complete while the
    //    gated call is still in flight -- the drain step acquires the
    //    same call mutex and therefore queues behind the call.
    let closeResolved = false;
    const closePromise = coordinator.close().then(
      () => {
        closeResolved = true;
      },
      (err: unknown) => {
        closeResolved = true;
        throw err;
      },
    );

    // 3. Give the close() path a generous slice to observe the race.
    //    If the mutex drain is missing, close() would race ahead and
    //    resolve before the gated tool call releases.
    await new Promise((r) => setTimeout(r, 50));
    expect(closeResolved).toBe(false);

    // 4. Release the tool call. close() can now acquire the mutex and
    //    proceed with its teardown.
    releaseCall?.();

    // Both promises settle without throwing. A 'write after end' or
    // similar async stream error from a missed drain would surface here
    // as an unhandled rejection or a rejected close promise.
    const callResult = await callPromise;
    await closePromise;

    expect(callResult.status).toBe('success');

    // The pre-close tool call's audit entry must be present -- proves
    // the drain completed the in-flight write before the log closed.
    const entries = readAudit(auditPath);
    expect(entries.length).toBe(1);
  });
});
