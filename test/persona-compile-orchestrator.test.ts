/**
 * Unit tests for the persona-compile orchestrator (Phase 1b).
 *
 * Exercises the long-running model against a temp IRONCURTAIN_HOME with a fake
 * compile implementation (no pipeline / LLM / network):
 *  - happy-path compileStream emitting started -> progress -> done via the
 *    EventBusProgressReporter;
 *  - COMPILE_IN_PROGRESS dedup (in-memory + FS lock);
 *  - FS-lock cross-process exclusion;
 *  - active -> recent synchronous transition;
 *  - stale-lock startup recovery (dead pid + past wall-clock cap);
 *  - globalLimit queueing + COMPILE_QUEUE_FULL;
 *  - wall-clock-cap abort;
 *  - CREDENTIALS_MISSING preflight;
 *  - the compileStream gate (POLICY_MUTATION_FORBIDDEN) lives in the dispatch
 *    test below.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PersonaCompileOrchestrator, CompileOrchestratorError } from '../src/persona/persona-compile-orchestrator.js';
import { WebEventBus, type WebEventMap } from '../src/web-ui/web-event-bus.js';
import { createPersonaName, type PersonaName } from '../src/persona/types.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';
import type { CompilePersonaOptions } from '../src/persona/compile-persona-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-orch-test-${process.pid}`);

function personaGeneratedDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name, 'generated');
}
function lockPath(name: string): string {
  return resolve(personaGeneratedDir(name), '.compile.lock');
}

/** Creates the persona generated dir on disk so the FS lock has a home. */
function makePersonaDir(name: string): PersonaName {
  const branded = createPersonaName(name);
  mkdirSync(personaGeneratedDir(name), { recursive: true });
  // Minimal persona.json + constitution so loadPersona (if reached) succeeds.
  writeFileSync(
    resolve(TEST_HOME, 'personas', name, 'persona.json'),
    JSON.stringify({ name, description: 'x', createdAt: new Date().toISOString() }),
  );
  writeFileSync(resolve(TEST_HOME, 'personas', name, 'constitution.md'), 'principles\n');
  return branded;
}

/** Collects emitted events for assertions. */
function captureEvents(bus: WebEventBus): { events: Array<{ name: string; payload: unknown }> } {
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.subscribe((name, payload) => {
    events.push({ name, payload });
  });
  return { events };
}

/** A controllable fake compile impl returning a policy with `ruleCount` rules. */
function fakeCompile(
  ruleCount: number,
  hooks?: {
    onCall?: (opts: CompilePersonaOptions) => void;
    block?: Promise<void>;
    throwErr?: Error;
  },
): (name: PersonaName, opts: CompilePersonaOptions) => Promise<CompiledPolicyFile> {
  return async (_name, opts) => {
    hooks?.onCall?.(opts);
    if (hooks?.block) await hooks.block;
    if (hooks?.throwErr) throw hooks.throwErr;
    // Drive a progress phase through the injected reporter so the happy-path
    // test can observe a progress event.
    const reporter = opts.reporterFactory?.('filesystem');
    reporter?.update('compiling');
    return {
      generatedAt: new Date().toISOString(),
      constitutionHash: 'h',
      inputHash: 'i',
      rules: Array.from({ length: ruleCount }, (_v, idx) => ({
        name: `rule-${idx}`,
        description: 'd',
        if: { server: ['filesystem'] },
        then: 'allow' as const,
        reason: 'r',
      })),
    } as CompiledPolicyFile;
  };
}

/** Waits until `pred()` is true or times out. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  delete process.env['ANTHROPIC_API_KEY'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('happy path', () => {
  it('emits started -> progress -> done and records a success result', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(3) });

    const ack = orch.startCompile(name, 'cli', bus);
    expect(ack).toMatchObject({ accepted: true, name, operationId: expect.any(String) });

    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));

    const names = events.map((e) => e.name);
    expect(names).toContain('persona.compile.started');
    expect(names).toContain('persona.compile.progress');
    expect(names).toContain('persona.compile.done');

    const done = events.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done.result).toEqual({ success: true, ruleCount: 3 });

    // active cleared, recent populated, lock released.
    expect(orch.listCompiles().active).toHaveLength(0);
    const op = orch.getCompile(ack.operationId);
    expect(op?.phase).toBe('done');
    expect(existsSync(lockPath('coder'))).toBe(false);
  });
});

describe('broad-policy validator + ruleDelta wiring', () => {
  /**
   * A compile impl that returns the given policy AND invokes the orchestrator's
   * validateCompiled hook on it (the real pipeline runs this hook before any
   * write; the fake must mirror that so the broad-policy gate is exercised).
   */
  function validatingCompile(
    policy: CompiledPolicyFile,
  ): (name: PersonaName, opts: CompilePersonaOptions) => Promise<CompiledPolicyFile> {
    return async (_name, opts) => {
      opts.validateCompiled?.(policy);
      return policy;
    };
  }

  function makePolicy(rules: CompiledPolicyFile['rules']): CompiledPolicyFile {
    return { generatedAt: '', constitutionHash: 'h', inputHash: 'i', rules };
  }

  function writePersonaJson(name: string, extra: Record<string, unknown> = {}): void {
    writeFileSync(
      resolve(TEST_HOME, 'personas', name, 'persona.json'),
      JSON.stringify({ name, description: 'x', createdAt: new Date().toISOString(), ...extra }),
    );
  }

  it('rejects a wildcard-domain compile (BROAD_POLICY_REJECTED) when not opted in', async () => {
    const name = makePersonaDir('narrow');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const broadPolicy = makePolicy([
      { name: 'r1', description: 'd', if: { domains: { roles: [], allowed: ['*'] } }, then: 'allow', reason: 'r' },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(broadPolicy) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'));

    const failed = events.find((e) => e.name === 'persona.compile.failed')
      ?.payload as WebEventMap['persona.compile.failed'];
    expect(failed.code).toBe('BROAD_POLICY_REJECTED');
    expect(orch.getCompile(ack.operationId)?.phase).toBe('failed');
  });

  it('allows a broad compile when the persona is opted in (allowBroadPolicy:true)', async () => {
    const name = makePersonaDir('broad');
    writePersonaJson('broad', { allowBroadPolicy: true });
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const broadPolicy = makePolicy([
      { name: 'r1', description: 'd', if: { domains: { roles: [], allowed: ['*'] } }, then: 'allow', reason: 'r' },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(broadPolicy) });

    orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.done'));
    const done = events.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done.result.success).toBe(true);
  });

  it('omits ruleDelta on the first compile and includes it once a prior policy exists', async () => {
    const name = makePersonaDir('coder');
    const bus1 = new WebEventBus();
    const { events: e1 } = captureEvents(bus1);
    const p1 = makePolicy([
      { name: 'a', description: 'd', if: { server: ['filesystem'] }, then: 'allow', reason: 'r' },
    ]);
    const orch = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(p1) });
    orch.startCompile(name, 'cli', bus1);
    await waitFor(() => e1.some((e) => e.name === 'persona.compile.done'));
    const done1 = e1.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done1.result.ruleDelta).toBeUndefined();

    // Persist the first policy so the second compile has a prior to diff.
    writeFileSync(resolve(personaGeneratedDir('coder'), 'compiled-policy.json'), JSON.stringify(p1));

    const bus2 = new WebEventBus();
    const { events: e2 } = captureEvents(bus2);
    const p2 = makePolicy([
      { name: 'a', description: 'd', if: { server: ['filesystem'] }, then: 'allow', reason: 'r' },
      { name: 'b', description: 'd', if: { server: ['git'] }, then: 'allow', reason: 'r' },
    ]);
    const orch2 = new PersonaCompileOrchestrator({ compileImpl: validatingCompile(p2) });
    orch2.startCompile(name, 'cli', bus2);
    await waitFor(() => e2.some((e) => e.name === 'persona.compile.done'));
    const done2 = e2.find((e) => e.name === 'persona.compile.done')?.payload as WebEventMap['persona.compile.done'];
    expect(done2.result.ruleDelta).toBeDefined();
    expect(done2.result.ruleDelta?.added).toBe(1);
  });
});

describe('COMPILE_IN_PROGRESS dedup', () => {
  it('rejects a second compile of the same persona while the first runs', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { block }) });

    const first = orch.startCompile(name, 'cli', bus);
    // The first op is now active (lock held).
    await waitFor(() => orch.listCompiles().active.length === 1);

    expect(() => orch.startCompile(name, 'cli', bus)).toThrow(CompileOrchestratorError);
    try {
      orch.startCompile(name, 'cli', bus);
    } catch (err) {
      expect((err as CompileOrchestratorError).code).toBe('COMPILE_IN_PROGRESS');
      expect((err as CompileOrchestratorError).data).toMatchObject({ operationId: first.operationId });
    }

    release();
    await waitFor(() => orch.listCompiles().active.length === 0);
  });
});

describe('FS-lock cross-process exclusion', () => {
  it('rejects when a live lock from another in-memory orchestrator exists', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));

    // Orchestrator A holds the lock (simulating another process via a separate
    // in-memory instance — the FS lock is the cross-process truth).
    const orchA = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { block }) });
    orchA.startCompile(name, 'cli', bus);
    await waitFor(() => existsSync(lockPath('coder')));

    // Orchestrator B has an EMPTY in-memory map, so only the FS lock can stop it.
    const orchB = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1) });
    expect(() => orchB.startCompile(name, 'cli', bus)).toThrow(/already running/i);

    release();
    await waitFor(() => !existsSync(lockPath('coder')));
  });
});

describe('active -> recent synchronous transition', () => {
  it('keeps an operation findable in exactly one of active/recent', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(2) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => orch.getCompile(ack.operationId)?.phase === 'done');

    const { active, recent } = orch.listCompiles();
    const inActive = active.some((o) => o.operationId === ack.operationId);
    const inRecent = recent.some((o) => o.operationId === ack.operationId);
    expect(inActive).toBe(false);
    expect(inRecent).toBe(true);
  });
});

describe('stale-lock startup recovery', () => {
  it('reclaims a dead-pid lock and emits a synthetic failed event', () => {
    makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    // Dead pid (very high, unlikely to exist).
    writeFileSync(
      lockPath('coder'),
      JSON.stringify({ operationId: 'op-dead', startedAt: new Date().toISOString(), pid: 2_000_000_000 }),
    );

    const orch = new PersonaCompileOrchestrator();
    orch.recoverStaleLocks(bus);

    expect(existsSync(lockPath('coder'))).toBe(false);
    const failed = events.find((e) => e.name === 'persona.compile.failed');
    expect((failed?.payload as { operationId: string }).operationId).toBe('op-dead');
  });

  it('reclaims a past-wall-clock-cap lock even for a live pid', () => {
    makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    // Live pid (this process) but startedAt far in the past => past the cap.
    writeFileSync(
      lockPath('coder'),
      JSON.stringify({
        operationId: 'op-old',
        startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        pid: process.pid,
      }),
    );

    const orch = new PersonaCompileOrchestrator({ wallClockCapMs: 1000 });
    orch.recoverStaleLocks(bus);

    expect(existsSync(lockPath('coder'))).toBe(false);
    expect(events.some((e) => e.name === 'persona.compile.failed')).toBe(true);
  });

  it('leaves a live, within-cap lock untouched', () => {
    makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    writeFileSync(
      lockPath('coder'),
      JSON.stringify({ operationId: 'op-live', startedAt: new Date().toISOString(), pid: process.pid }),
    );

    const orch = new PersonaCompileOrchestrator();
    orch.recoverStaleLocks(bus);

    expect(existsSync(lockPath('coder'))).toBe(true);
    expect(events.some((e) => e.name === 'persona.compile.failed')).toBe(false);
  });
});

describe('globalLimit queueing + COMPILE_QUEUE_FULL', () => {
  it('marks operations queued when the global gate is saturated and rejects past the cap', async () => {
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    // queueCap=1: 2 running (gate) + 1 queued allowed; the 4th is rejected.
    const orch = new PersonaCompileOrchestrator({
      compileImpl: fakeCompile(1, { block }),
      queueCap: 1,
    });

    // Two distinct personas saturate the gate (GLOBAL_CONCURRENCY=2).
    const a = makePersonaDir('a');
    const b = makePersonaDir('b');
    const c = makePersonaDir('c');
    const d = makePersonaDir('d');

    orch.startCompile(a, 'cli', bus);
    orch.startCompile(b, 'cli', bus);
    await waitFor(() => orch.listCompiles().active.length === 2);

    // Third enqueues (queued:true), depth within cap.
    const ackC = orch.startCompile(c, 'cli', bus);
    expect(ackC.queued).toBe(true);

    // Fourth exceeds the queue cap.
    expect(() => orch.startCompile(d, 'cli', bus)).toThrow(CompileOrchestratorError);
    try {
      orch.startCompile(d, 'cli', bus);
    } catch (err) {
      expect((err as CompileOrchestratorError).code).toBe('COMPILE_QUEUE_FULL');
    }

    release();
    await waitFor(() => orch.listCompiles().active.length === 0, 4000);
  });
});

describe('wall-clock-cap abort', () => {
  it('aborts the in-flight compile when the cap fires and records a failure', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);

    // Compile that resolves only when its signal aborts.
    const compileImpl = (_n: PersonaName, opts: CompilePersonaOptions): Promise<CompiledPolicyFile> =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted by cap')));
      });

    const orch = new PersonaCompileOrchestrator({ compileImpl, wallClockCapMs: 50 });
    const ack = orch.startCompile(name, 'cli', bus);

    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'), 3000);
    const op = orch.getCompile(ack.operationId);
    expect(op?.phase).toBe('failed');
    expect(existsSync(lockPath('coder'))).toBe(false);
  });
});

describe('CREDENTIALS_MISSING preflight', () => {
  it('rejects synchronously and releases the lock when no API key is present', () => {
    const name = makePersonaDir('coder');
    delete process.env['ANTHROPIC_API_KEY'];
    const bus = new WebEventBus();
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1) });

    try {
      orch.startCompile(name, 'cli', bus);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CompileOrchestratorError).code).toBe('CREDENTIALS_MISSING');
    }
    // Lock released — a later compile (with creds) is not blocked.
    expect(existsSync(lockPath('coder'))).toBe(false);
  });
});

describe('LIST_REQUIRES_MCP classification', () => {
  it('maps an MCP_LISTS_DISALLOWED compile error to LIST_REQUIRES_MCP', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    const { events } = captureEvents(bus);
    const mcpErr = Object.assign(new Error('needs mcp'), { code: 'MCP_LISTS_DISALLOWED' });
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { throwErr: mcpErr }) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => events.some((e) => e.name === 'persona.compile.failed'));
    const op = orch.getCompile(ack.operationId);
    expect(op?.error?.code).toBe('LIST_REQUIRES_MCP');
  });
});

describe('per-operation LLM log path', () => {
  it('passes operationId + allowMcpLists:false + quiet to the compile impl', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let seen: CompilePersonaOptions | undefined;
    const orch = new PersonaCompileOrchestrator({
      compileImpl: fakeCompile(1, { onCall: (opts) => (seen = opts) }),
    });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => orch.getCompile(ack.operationId)?.phase === 'done');
    expect(seen?.operationId).toBe(ack.operationId);
    expect(seen?.allowMcpLists).toBe(false);
    expect(seen?.quiet).toBe(true);
  });
});

// Sanity: the lock file contains the live pid + operationId while held.
describe('lock file content', () => {
  it('writes operationId + pid into the lock while a compile is running', async () => {
    const name = makePersonaDir('coder');
    const bus = new WebEventBus();
    let release!: () => void;
    const block = new Promise<void>((r) => (release = r));
    const orch = new PersonaCompileOrchestrator({ compileImpl: fakeCompile(1, { block }) });

    const ack = orch.startCompile(name, 'cli', bus);
    await waitFor(() => existsSync(lockPath('coder')));
    const content = JSON.parse(readFileSync(lockPath('coder'), 'utf-8'));
    expect(content.operationId).toBe(ack.operationId);
    expect(content.pid).toBe(process.pid);

    release();
    await waitFor(() => !existsSync(lockPath('coder')));
  });
});
