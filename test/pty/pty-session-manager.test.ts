/**
 * Unit tests for PtySessionManager (src/web-ui/pty-session-manager.ts).
 *
 * A STUB PtyBridge (no child spawned) is injected via `createBridge`, and a
 * recording stub sender captures targeted `session.pty_*` deliveries. Covers:
 *  - attach replay-before-output ordering (the reconnect invariant)
 *  - detach / removeAllForClient stop delivery
 *  - idle-TTL reaping of a session with no subscribers (fake timers)
 *  - backpressure desync + resync on drain
 *  - `size` tracking create/end
 *  - the docker `sessions.create` concurrency cap (via the real dispatch path)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebSocket as WsWebSocket } from 'ws';

import {
  PtySessionManager,
  type PtyStreamSender,
  type PtySessionManagerOptions,
} from '../../src/web-ui/pty-session-manager.js';
import { PTY_KILL_GRACE_MS } from '../../src/pty/pty-bridge.js';
import type { PtyBridge, PtyBridgeOptions } from '../../src/pty/pty-bridge.js';
import type { PtySessionRegistration } from '../../src/docker/pty-types.js';
import type { EscalationRequest } from '../../src/session/types.js';
import type { EscalationDto } from '../../src/web-ui/web-ui-types.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { WebEventBus } from '../../src/web-ui/web-event-bus.js';
import { sessionDispatch } from '../../src/web-ui/dispatch/session-dispatch.js';
import { escalationDispatch } from '../../src/web-ui/dispatch/escalation-dispatch.js';
import type { DispatchContext } from '../../src/web-ui/dispatch/types.js';
import type { ControlRequestHandler } from '../../src/daemon/control-socket.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** Controllable stub PtyBridge: fire onData/onExit/onSessionDiscovered at will. */
class StubBridge {
  alive = true;
  exitCode: number | undefined;
  readonly sessionId: string | undefined = 'stub-session';
  escalationDir: string | undefined;
  readonly pid = 4242;
  serializeReturn = 'SNAPSHOT';

  private readonly dataCbs: Array<(chunk: string) => void> = [];
  private readonly exitCbs: Array<(code: number) => void> = [];
  private readonly sessionCbs: Array<(reg: PtySessionRegistration | null) => void> = [];

  readonly write = vi.fn<(data: string) => void>();
  readonly resize = vi.fn<(cols: number, rows: number) => void>();
  readonly kill = vi.fn(() => this.emitExit(0));

  onOutput(): void {}
  onData(cb: (chunk: string) => void): () => void {
    this.dataCbs.push(cb);
    return () => {
      const i = this.dataCbs.indexOf(cb);
      if (i !== -1) this.dataCbs.splice(i, 1);
    };
  }
  serialize(): string {
    return this.serializeReturn;
  }
  onExit(cb: (code: number) => void): void {
    if (!this.alive && this.exitCode !== undefined) cb(this.exitCode);
    else this.exitCbs.push(cb);
  }
  onSessionDiscovered(cb: (reg: PtySessionRegistration | null) => void): void {
    this.sessionCbs.push(cb);
  }
  updateRegistration(): void {}

  // --- test drivers ---
  emitData(chunk: string): void {
    for (const cb of [...this.dataCbs]) cb(chunk);
  }
  emitExit(code: number): void {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = code;
    for (const cb of [...this.exitCbs]) cb(code);
  }
  emitDiscovered(reg: PtySessionRegistration | null): void {
    for (const cb of [...this.sessionCbs]) cb(reg);
  }
}

/** Bridge whose kill request is accepted but does not terminate the child. */
class NonExitingBridge extends StubBridge {
  override readonly kill = vi.fn(() => {});
}

interface SenderCall {
  clients: Set<WsWebSocket>;
  event: string;
  payload: Record<string, unknown>;
}

function makeSender(): PtyStreamSender & { calls: SenderCall[] } {
  const calls: SenderCall[] = [];
  return {
    calls,
    sendToSubscribers(clients, event, payload) {
      calls.push({ clients: new Set(clients), event, payload: payload as Record<string, unknown> });
    },
  };
}

/** Fake WS client: only `bufferedAmount` is read by the manager (backpressure). */
function fakeWs(): WsWebSocket & { bufferedAmount: number } {
  return { bufferedAmount: 0, readyState: 1, send: vi.fn() } as unknown as WsWebSocket & { bufferedAmount: number };
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  manager: PtySessionManager;
  sender: ReturnType<typeof makeSender>;
  eventBus: WebEventBus;
  events: Array<{ event: string; payload: unknown }>;
  bridges: StubBridge[];
  lastBridge: () => StubBridge;
}

function makeHarness(overrides: Partial<PtySessionManagerOptions> = {}): Harness {
  const sender = makeSender();
  const eventBus = new WebEventBus();
  const events: Array<{ event: string; payload: unknown }> = [];
  eventBus.subscribe((event, payload) => events.push({ event, payload }));
  const bridges: StubBridge[] = [];

  const manager = new PtySessionManager({
    sender,
    sessionManager: new SessionManager(),
    eventBus,
    mode: { kind: 'docker', agent: 'claude-code' },
    daemonId: 'test',
    daemonPid: 1,
    createBridge: async () => {
      const bridge = new StubBridge();
      bridges.push(bridge);
      return bridge as unknown as PtyBridge;
    },
    preflight: async () => {},
    ...overrides,
  });

  return { manager, sender, eventBus, events, bridges, lastBridge: () => bridges[bridges.length - 1] };
}

const ptyOutputs = (calls: SenderCall[]) => calls.filter((c) => c.event === 'session.pty_output');
const ptyReplays = (calls: SenderCall[]) => calls.filter((c) => c.event === 'session.pty_replay');

/** Harness whose bridge accepts kill requests but only exits when driven. */
function makeNonExitingHarness(opts: { idleTtlMs?: number; failFirstKill?: boolean } = {}): {
  h: Harness;
  bridge: NonExitingBridge;
} {
  const bridge = new NonExitingBridge();
  if (opts.failFirstKill) {
    bridge.kill.mockImplementationOnce(() => {
      throw new Error('signal failed');
    });
  }
  const h = makeHarness({
    ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
    createBridge: async () => bridge as unknown as PtyBridge,
  });
  return { h, bridge };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PtySessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('create', () => {
    it('spawns a bridge, tracks size, and emits session.created', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create({ persona: 'assistant' });

      expect(label).toBe(1);
      expect(h.manager.size).toBe(1);
      expect(h.bridges).toHaveLength(1);

      const created = h.events.filter((e) => e.event === 'session.created');
      expect(created).toHaveLength(1);
      const dto = created[0].payload as { label: number; source: { kind: string; persona?: string } };
      expect(dto.label).toBe(1);
      expect(dto.source.kind).toBe('web-pty');
      expect(dto.source.persona).toBe('assistant');
    });

    it('reaps a child that already exited during create (created -> ended, no leak)', async () => {
      // A fast-failing child (missing binary / immediate crash) can exit before
      // create() finishes wiring handlers; the bridge then fires onExit
      // synchronously. The session must be registered BEFORE the handlers so the
      // synchronous exit is reaped (created -> ended) rather than leaked.
      const bridge = new StubBridge();
      bridge.alive = false;
      bridge.exitCode = 1;
      const h = makeHarness({ createBridge: async () => bridge as unknown as PtyBridge });

      await h.manager.create();

      expect(h.manager.size).toBe(0); // not leaked
      const createdIdx = h.events.findIndex((e) => e.event === 'session.created');
      const endedIdx = h.events.findIndex((e) => e.event === 'session.ended');
      expect(createdIdx).toBeGreaterThanOrEqual(0);
      expect(endedIdx).toBeGreaterThan(createdIdx); // created before ended
      expect(h.events.filter((e) => e.event === 'session.ended')).toHaveLength(1);
      expect((h.events[endedIdx].payload as { reason: string }).reason).toBe('pty_exited');
    });

    it('passes the docker-mode agent + webui owner id to the bridge factory', async () => {
      const seen: PtyBridgeOptions[] = [];
      const h = makeHarness({
        createBridge: async (opts) => {
          seen.push(opts);
          return new StubBridge() as unknown as PtyBridge;
        },
      });
      await h.manager.create();

      expect(seen[0].agent).toBe('claude-code');
      expect(seen[0].muxId).toBe('webui-test');
      expect(seen[0].muxPid).toBe(1);
      expect(seen[0].cols).toBe(80);
      expect(seen[0].rows).toBe(24);
    });

    it('resumes with the persisted agent and persona without fresh-launch flags', async () => {
      const seen: PtyBridgeOptions[] = [];
      const h = makeHarness({
        createBridge: async (opts) => {
          seen.push(opts);
          return new StubBridge() as unknown as PtyBridge;
        },
      });

      const result = await h.manager.create({
        resume: { sessionId: 'saved-session', agent: 'goose', persona: 'saved-persona' },
      });

      expect(seen[0]).toMatchObject({ resumeSessionId: 'saved-session', agent: 'goose' });
      expect(seen[0]).not.toHaveProperty('workspacePath');
      expect(seen[0]).not.toHaveProperty('providerProfileName');
      expect(seen[0]).not.toHaveProperty('model');
      expect(seen[0]).not.toHaveProperty('persona');
      expect(h.manager.getDto(result.label)?.persona).toBe('saved-persona');
    });

    it('rejects duplicate resume claims until the first resumed PTY exits', async () => {
      const h = makeHarness();
      const resume = { resume: { sessionId: 'saved-session', agent: 'claude-code' } };

      await h.manager.create(resume);
      await expect(h.manager.create(resume)).rejects.toMatchObject({ code: 'SESSION_BUSY' });

      h.lastBridge().emitExit(0);
      await expect(h.manager.create(resume)).resolves.toEqual({ label: 2 });
    });

    it('releases a resume claim when bridge creation fails', async () => {
      const createBridge = vi
        .fn<(options: PtyBridgeOptions) => Promise<PtyBridge>>()
        .mockRejectedValueOnce(new Error('spawn failed'))
        .mockResolvedValueOnce(new StubBridge() as unknown as PtyBridge);
      const h = makeHarness({ createBridge });
      const resume = { resume: { sessionId: 'retryable-session', agent: 'claude-code' } };

      await expect(h.manager.create(resume)).rejects.toThrow('spawn failed');
      await expect(h.manager.create(resume)).resolves.toEqual({ label: 2 });
    });

    it('threads workspace / provider-profile / model options to the bridge factory', async () => {
      const seen: PtyBridgeOptions[] = [];
      const h = makeHarness({
        createBridge: async (opts) => {
          seen.push(opts);
          return new StubBridge() as unknown as PtyBridge;
        },
      });
      await h.manager.create({
        persona: 'researcher',
        workspacePath: '/work/x',
        providerProfileName: 'openrouter-1',
        model: 'claude-opus-4-8',
      });

      expect(seen[0].persona).toBe('researcher');
      expect(seen[0].workspacePath).toBe('/work/x');
      expect(seen[0].providerProfileName).toBe('openrouter-1');
      expect(seen[0].model).toBe('claude-opus-4-8');
    });

    it('fails cleanly with PtyUnavailableError when preflight rejects', async () => {
      const h = makeHarness({
        preflight: async () => {
          throw new Error('node-pty missing');
        },
      });
      await expect(h.manager.create()).rejects.toThrow('PTY terminal unavailable: node-pty missing');
      expect(h.manager.size).toBe(0);
    });
  });

  describe('sendPrompt (trusted input)', () => {
    const tempDirs: string[] = [];
    const makeDir = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'pty-trusted-'));
      tempDirs.push(dir);
      return dir;
    };
    afterEach(() => {
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('writes trusted user-context, injects the text, then Enter after the delay', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const bridge = h.lastBridge();
      const dir = makeDir();
      bridge.emitDiscovered({ sessionId: 's', escalationDir: dir, label: 'l', startedAt: '', pid: 4242 });

      h.manager.sendPrompt(label, 'hello agent');

      // Text injected immediately; user-context written as trusted.
      expect(bridge.write).toHaveBeenCalledWith('hello agent');
      const ctx = JSON.parse(readFileSync(join(dir, 'user-context.json'), 'utf-8'));
      expect(ctx.source).toBe('mux-trusted-input');
      expect(ctx.userMessage).toBe('hello agent');
      expect(typeof ctx.timestamp).toBe('string');

      // Enter is deferred so Ink processes the text + submit as distinct events.
      expect(bridge.write).not.toHaveBeenCalledWith('\r');
      vi.advanceTimersByTime(60);
      expect(bridge.write).toHaveBeenCalledWith('\r');
    });

    it('injects untrusted (no user-context) when discovery has not yielded the escalation dir', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const bridge = h.lastBridge();

      h.manager.sendPrompt(label, 'early');

      expect(bridge.write).toHaveBeenCalledWith('early');
      vi.advanceTimersByTime(60);
      expect(bridge.write).toHaveBeenCalledWith('\r');
    });

    it('throws SessionNotFoundError for an unknown label', () => {
      const h = makeHarness();
      expect(() => h.manager.sendPrompt(999, 'x')).toThrow();
    });

    it('degrades to untrusted injection when the trusted-context write throws', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const bridge = h.lastBridge();
      const dir = makeDir();
      // Make the atomic write's rename target a directory so
      // writeTrustedUserContext throws (EISDIR/ENOTDIR) — the message must
      // still be injected (untrusted), not swallowed by a failed RPC.
      mkdirSync(join(dir, 'user-context.json'));
      bridge.emitDiscovered({ sessionId: 's', escalationDir: dir, label: 'l', startedAt: '', pid: 1 });

      expect(() => h.manager.sendPrompt(label, 'hi')).not.toThrow();
      expect(bridge.write).toHaveBeenCalledWith('hi');
      vi.advanceTimersByTime(60);
      expect(bridge.write).toHaveBeenCalledWith('\r');
    });
  });

  describe('attach ordering (reconnect invariant)', () => {
    it('sends pty_replay on attach, THEN pty_output for later onData', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const ws = fakeWs();

      h.manager.attach(label, ws);

      // (1) Exactly one replay, to this client, carrying the base64 snapshot.
      expect(h.sender.calls).toHaveLength(1);
      expect(h.sender.calls[0].event).toBe('session.pty_replay');
      expect(h.sender.calls[0].payload).toEqual({ label, snapshot: b64('SNAPSHOT') });
      expect(h.sender.calls[0].clients.has(ws)).toBe(true);

      // (2) Later output coalesces into a pty_output AFTER the replay.
      h.lastBridge().emitData('hello');
      vi.advanceTimersByTime(20);

      expect(h.sender.calls).toHaveLength(2);
      expect(h.sender.calls[1].event).toBe('session.pty_output');
      expect(h.sender.calls[1].payload).toEqual({ label, data: b64('hello') });
    });

    it('coalesces multiple chunks in one pty_output frame', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const ws = fakeWs();
      h.manager.attach(label, ws);

      h.lastBridge().emitData('foo');
      h.lastBridge().emitData('bar');
      vi.advanceTimersByTime(20);

      const outs = ptyOutputs(h.sender.calls);
      expect(outs).toHaveLength(1);
      expect(outs[0].payload).toEqual({ label, data: b64('foobar') });
    });

    it('throws for an unknown label', async () => {
      const h = makeHarness();
      expect(() => h.manager.attach(999, fakeWs())).toThrow('Session #999 not found');
    });
  });

  describe('detach / removeAllForClient', () => {
    it('detach stops further pty_output delivery', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const ws = fakeWs();
      h.manager.attach(label, ws);

      h.manager.detach(label, ws);
      h.lastBridge().emitData('after-detach');
      vi.advanceTimersByTime(20);

      expect(ptyOutputs(h.sender.calls)).toHaveLength(0);
    });

    it('removeAllForClient stops delivery across sessions', async () => {
      const h = makeHarness();
      const a = await h.manager.create();
      const bridgeA = h.lastBridge();
      const b = await h.manager.create();
      const bridgeB = h.lastBridge();
      const ws = fakeWs();
      h.manager.attach(a.label, ws);
      h.manager.attach(b.label, ws);
      h.sender.calls.length = 0; // drop the two attach replays

      h.manager.removeAllForClient(ws);
      bridgeA.emitData('x');
      bridgeB.emitData('y');
      vi.advanceTimersByTime(20);

      expect(ptyOutputs(h.sender.calls)).toHaveLength(0);
    });
  });

  describe('idle-TTL backstop', () => {
    it('reaps a session with no subscribers after the TTL', async () => {
      const h = makeHarness({ idleTtlMs: 1000 });
      await h.manager.create();
      const bridge = h.lastBridge();

      // Never attached -> idle timer armed at create; fire it.
      vi.advanceTimersByTime(1000);

      expect(bridge.kill).toHaveBeenCalledTimes(1);
      expect(h.manager.size).toBe(0);
      const ended = h.events.filter((e) => e.event === 'session.ended');
      expect(ended).toHaveLength(1);
      expect((ended[0].payload as { reason: string }).reason).toBe('idle_reaped');
    });

    it('keeps a live session listed when the idle kill request does not exit the bridge', async () => {
      const { h, bridge } = makeNonExitingHarness({ idleTtlMs: 1000 });
      const { label } = await h.manager.create();

      vi.advanceTimersByTime(1000);

      expect(bridge.kill).toHaveBeenCalledTimes(1);
      expect(bridge.alive).toBe(true);
      expect(h.manager.has(label)).toBe(true);
      expect(h.manager.listDtos()[0].status).toBe('stopping');
      expect(h.events.filter((e) => e.event === 'session.ended')).toHaveLength(0);

      bridge.emitExit(0);

      expect(h.manager.has(label)).toBe(false);
      const ended = h.events.filter((e) => e.event === 'session.ended');
      expect(ended).toHaveLength(1);
      expect((ended[0].payload as { reason: string }).reason).toBe('idle_reaped');
    });

    it('re-arms idle cleanup when an idle kill request throws', async () => {
      const { h, bridge } = makeNonExitingHarness({ idleTtlMs: 1000, failFirstKill: true });
      const { label } = await h.manager.create();

      vi.advanceTimersByTime(1000);

      expect(bridge.kill).toHaveBeenCalledTimes(1);
      expect(h.manager.listDtos()[0].status).toBe('ready');

      vi.advanceTimersByTime(1000);

      expect(bridge.kill).toHaveBeenCalledTimes(2);
      expect(h.manager.has(label)).toBe(true);
      expect(h.manager.listDtos()[0].status).toBe('stopping');
    });

    it('attach cancels the idle timer; detach re-arms it', async () => {
      const h = makeHarness({ idleTtlMs: 1000 });
      const { label } = await h.manager.create();
      const ws = fakeWs();

      h.manager.attach(label, ws); // cancels create-armed timer
      vi.advanceTimersByTime(5000);
      expect(h.manager.size).toBe(1);

      h.manager.detach(label, ws); // re-arms
      vi.advanceTimersByTime(1000);
      expect(h.manager.size).toBe(0);
    });

    it('idleTtlMs = 0 disables reaping', async () => {
      const h = makeHarness({ idleTtlMs: 0 });
      await h.manager.create();
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(h.manager.size).toBe(1);
    });
  });

  describe('backpressure + resync', () => {
    it('skips deltas while backpressured, then resyncs with a fresh replay on drain', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const ws = fakeWs();
      h.manager.attach(label, ws);
      h.sender.calls.length = 0; // drop the attach replay

      // Backpressured: bufferedAmount over the 4MB threshold -> no delta.
      ws.bufferedAmount = 5 * 1024 * 1024;
      h.lastBridge().emitData('while-backed-up');
      vi.advanceTimersByTime(20);
      expect(ptyOutputs(h.sender.calls)).toHaveLength(0);
      expect(ptyReplays(h.sender.calls)).toHaveLength(0);

      // Drained: the drain-poll flush resyncs with a full snapshot (not a delta).
      // The drain poll runs at the coarser PTY_DRAIN_POLL_MS (150ms), so advance
      // past it.
      ws.bufferedAmount = 0;
      vi.advanceTimersByTime(160);
      const replays = ptyReplays(h.sender.calls);
      expect(replays).toHaveLength(1);
      expect(replays[0].payload).toEqual({ label, snapshot: b64('SNAPSHOT') });
      expect(replays[0].clients.has(ws)).toBe(true);
    });

    it('new output preempts the drain poll: healthy clients still flush at the coalesce cadence', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const slow = fakeWs();
      const healthy = fakeWs();
      h.manager.attach(label, slow);
      h.manager.attach(label, healthy);
      h.sender.calls.length = 0; // drop the attach replays

      // Slow client backpressured: the first flush desyncs it and arms the
      // 150ms drain poll (the healthy client got that delta).
      slow.bufferedAmount = 5 * 1024 * 1024;
      h.lastBridge().emitData('burst-1');
      vi.advanceTimersByTime(20);
      h.sender.calls.length = 0;

      // New output arrives while the 150ms drain poll is pending. It must reach
      // the healthy client at the 16ms coalesce cadence, NOT wait for the poll.
      h.lastBridge().emitData('burst-2');
      vi.advanceTimersByTime(20); // < PTY_DRAIN_POLL_MS (150)
      const outs = ptyOutputs(h.sender.calls);
      expect(outs).toHaveLength(1);
      expect(outs[0].clients.has(healthy)).toBe(true);
      expect(outs[0].clients.has(slow)).toBe(false); // still desynced
    });
  });

  describe('input / resize', () => {
    it('decodes base64 input to bridge.write and forwards resize', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const bridge = h.lastBridge();

      h.manager.input(label, b64('\x03')); // Ctrl-C
      expect(bridge.write).toHaveBeenCalledWith('\x03');

      h.manager.resize(label, 120, 40);
      expect(bridge.resize).toHaveBeenCalledWith(120, 40);
    });

    it('throws for input/resize on an unknown label', async () => {
      const h = makeHarness();
      expect(() => h.manager.input(999, b64('x'))).toThrow('Session #999 not found');
      expect(() => h.manager.resize(999, 80, 24)).toThrow('Session #999 not found');
    });
  });

  describe('lifecycle: end / exit / close / discovery', () => {
    it('end() kills the bridge, drops the session, and emits session.ended once', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const bridge = h.lastBridge();

      h.manager.end(label);

      expect(bridge.kill).toHaveBeenCalledTimes(1);
      expect(h.manager.size).toBe(0);
      const ended = h.events.filter((e) => e.event === 'session.ended');
      expect(ended).toHaveLength(1);
      expect((ended[0].payload as { reason: string }).reason).toBe('user_ended');
    });

    it('keeps a live session listed when an explicit end request does not exit the bridge', async () => {
      const { h, bridge } = makeNonExitingHarness();
      const { label } = await h.manager.create();

      h.manager.end(label);
      h.manager.end(label);

      expect(bridge.kill).toHaveBeenCalledTimes(1);
      expect(h.manager.has(label)).toBe(true);
      expect(h.manager.listDtos()[0].status).toBe('stopping');
      expect(h.events.filter((e) => e.event === 'session.ended')).toHaveLength(0);
      const updated = h.events.filter((e) => e.event === 'session.updated');
      expect((updated[updated.length - 1].payload as { status: string }).status).toBe('stopping');

      h.manager.input(label, b64('ignored'));
      h.manager.sendPrompt(label, 'also ignored');
      expect(bridge.write).not.toHaveBeenCalled();

      bridge.emitExit(0);

      expect(h.manager.has(label)).toBe(false);
      const ended = h.events.filter((e) => e.event === 'session.ended');
      expect(ended).toHaveLength(1);
      expect((ended[0].payload as { reason: string }).reason).toBe('user_ended');
    });

    it('rolls back a failed kill request so explicit end can be retried', async () => {
      const { h, bridge } = makeNonExitingHarness({ failFirstKill: true });
      const { label } = await h.manager.create();

      h.manager.end(label);

      expect(h.manager.has(label)).toBe(true);
      expect(h.manager.listDtos()[0].status).toBe('ready');
      expect(h.events.filter((e) => e.event === 'session.ended')).toHaveLength(0);

      h.manager.end(label);

      expect(bridge.kill).toHaveBeenCalledTimes(2);
      expect(h.manager.listDtos()[0].status).toBe('stopping');
    });

    it('a child exit reaps the session and emits session.ended', async () => {
      const h = makeHarness();
      await h.manager.create();
      const bridge = h.lastBridge();

      bridge.emitExit(1);

      expect(h.manager.size).toBe(0);
      const ended = h.events.filter((e) => e.event === 'session.ended');
      expect(ended).toHaveLength(1);
      expect((ended[0].payload as { reason: string }).reason).toBe('pty_exited');
    });

    it('captures the discovered escalationDir on the session (Phase 4 seam)', async () => {
      const h = makeHarness();
      await h.manager.create();
      const bridge = h.lastBridge();
      bridge.emitDiscovered({
        sessionId: 's',
        escalationDir: '/tmp/esc-x',
        label: 'l',
        startedAt: '',
        pid: 4242,
      });
      // Surface via the DTO's presence-only status; the dir is a private seam,
      // so assert indirectly that discovery did not throw and the session lives.
      expect(h.manager.size).toBe(1);
    });

    it('size tracks create/end', async () => {
      const h = makeHarness();
      expect(h.manager.size).toBe(0);
      const a = await h.manager.create();
      const b = await h.manager.create();
      expect(h.manager.size).toBe(2);
      h.manager.end(a.label);
      expect(h.manager.size).toBe(1);
      h.manager.end(b.label);
      expect(h.manager.size).toBe(0);
    });

    it('close() kills every bridge and empties the map', async () => {
      const h = makeHarness();
      await h.manager.create();
      await h.manager.create();
      const [b1, b2] = h.bridges;

      await h.manager.close();

      expect(b1.kill).toHaveBeenCalledTimes(1);
      expect(b2.kill).toHaveBeenCalledTimes(1);
      expect(h.manager.size).toBe(0);
    });

    it('close() waits for an in-flight bridge and prevents it from registering', async () => {
      let resolveBridge: ((bridge: PtyBridge) => void) | undefined;
      const bridge = new NonExitingBridge();
      const h = makeHarness({
        createBridge: () =>
          new Promise((resolve) => {
            resolveBridge = resolve;
          }),
      });

      const create = h.manager.create();
      for (let attempt = 0; attempt < 5 && !resolveBridge; attempt++) await Promise.resolve();
      expect(resolveBridge).toBeDefined();
      const close = h.manager.close();
      let closeResolved = false;
      void close.then(() => {
        closeResolved = true;
      });
      resolveBridge?.(bridge as unknown as PtyBridge);

      await expect(create).rejects.toThrow('shutting down');
      await Promise.resolve();
      expect(closeResolved).toBe(false);
      expect(bridge.kill).toHaveBeenCalledTimes(1);

      bridge.emitExit(0);
      await close;
      expect(closeResolved).toBe(true);
      expect(h.manager.size).toBe(0);
      expect(h.events.filter((event) => event.event === 'session.created')).toHaveLength(0);
    });

    it('kills an in-flight bridge even when it resolves after close() times out', async () => {
      let resolveBridge: ((bridge: PtyBridge) => void) | undefined;
      const bridge = new NonExitingBridge();
      const h = makeHarness({
        createBridge: () =>
          new Promise((resolve) => {
            resolveBridge = resolve;
          }),
      });

      const create = h.manager.create();
      const rejectedCreate = expect(create).rejects.toThrow('shutting down');
      for (let attempt = 0; attempt < 5 && !resolveBridge; attempt++) await Promise.resolve();
      expect(resolveBridge).toBeDefined();

      const close = h.manager.close();
      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS + 5_000);
      await close;

      resolveBridge?.(bridge as unknown as PtyBridge);
      await rejectedCreate;
      expect(bridge.kill).toHaveBeenCalledTimes(1);
      expect(h.manager.size).toBe(0);
      expect(h.events.filter((event) => event.event === 'session.created')).toHaveLength(0);

      bridge.emitExit(0);
    });

    it('does not treat a thrown in-flight kill request as a completed exit', async () => {
      let resolveBridge: ((bridge: PtyBridge) => void) | undefined;
      const bridge = new NonExitingBridge();
      bridge.kill.mockImplementationOnce(() => {
        throw new Error('signal unavailable');
      });
      const h = makeHarness({
        createBridge: () =>
          new Promise((resolve) => {
            resolveBridge = resolve;
          }),
      });

      const create = h.manager.create();
      for (let attempt = 0; attempt < 5 && !resolveBridge; attempt++) await Promise.resolve();
      expect(resolveBridge).toBeDefined();

      let closeResolved = false;
      const close = h.manager.close().then(() => {
        closeResolved = true;
      });
      resolveBridge?.(bridge as unknown as PtyBridge);

      await expect(create).rejects.toThrow('shutting down');
      await Promise.resolve();
      expect(closeResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS + 5_000);
      await close;
      expect(closeResolved).toBe(true);

      bridge.emitExit(0);
    });

    it('attempts later bridge kills when an earlier kill throws', async () => {
      const first = new StubBridge();
      first.kill.mockImplementationOnce(() => {
        throw new Error('signal unavailable');
      });
      const second = new StubBridge();
      const bridges = [first, second];
      const h = makeHarness({
        createBridge: async () => bridges.shift()! as unknown as PtyBridge,
      });

      await h.manager.create();
      await h.manager.create();
      await h.manager.close();

      expect(first.kill).toHaveBeenCalledTimes(1);
      expect(second.kill).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the close timeout after immediate exits', async () => {
      const h = makeHarness();
      await h.manager.create();

      await h.manager.close();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not leave a close timeout when there are no sessions', async () => {
      const h = makeHarness();

      await h.manager.close();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('waits through the SIGKILL grace boundary before close timeout wins', async () => {
      const { h, bridge } = makeNonExitingHarness();
      await h.manager.create();

      let resolved = false;
      const closePromise = h.manager.close().then(() => {
        resolved = true;
      });
      setTimeout(() => bridge.emitExit(0), PTY_KILL_GRACE_MS);

      await vi.advanceTimersByTimeAsync(PTY_KILL_GRACE_MS - 1);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await closePromise;
      expect(resolved).toBe(true);
      expect(bridge.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe('listDtos / status', () => {
    it('listDtos surfaces web-pty sessions with zeroed budget/turns', async () => {
      const h = makeHarness();
      await h.manager.create({ persona: 'p' });
      const dtos = h.manager.listDtos();
      expect(dtos).toHaveLength(1);
      expect(dtos[0].source.kind).toBe('web-pty');
      expect(dtos[0].turnCount).toBe(0);
      expect(dtos[0].budget.tokenTrackingAvailable).toBe(false);
      expect(dtos[0].status).toBe('ready');
    });
  });

  // -------------------------------------------------------------------------
  // Escalation bridging (Phase 4): a real EscalationWatcher over a temp dir.
  // The watcher's immediate first poll (§7.2) means writing the request BEFORE
  // discovery surfaces it synchronously -- no timer advance needed.
  // -------------------------------------------------------------------------
  describe('escalation bridging (Phase 4)', () => {
    const tempDirs: string[] = [];

    function makeEscalationDir(): string {
      const dir = mkdtempSync(join(tmpdir(), 'pty-esc-'));
      tempDirs.push(dir);
      return dir;
    }

    function writeRequest(dir: string, id: string, overrides: Partial<EscalationRequest> = {}): void {
      const request: EscalationRequest = {
        escalationId: id,
        toolName: 'write_file',
        serverName: 'filesystem',
        arguments: { path: '/etc/hosts' },
        reason: 'Protected path',
        ...overrides,
      };
      writeFileSync(join(dir, `request-${id}.json`), JSON.stringify(request));
    }

    function discover(bridge: StubBridge, escalationDir: string): void {
      bridge.emitDiscovered({ sessionId: 's', escalationDir, label: 'l', startedAt: '', pid: 4242 });
    }

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('re-emits a discovered escalation as escalation.created with a web-pty source', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create({ persona: 'assistant' });
      const escDir = makeEscalationDir();

      writeRequest(escDir, 'esc-pty-1');
      discover(h.lastBridge(), escDir);

      const created = h.events.filter((e) => e.event === 'escalation.created');
      expect(created).toHaveLength(1);
      const dto = created[0].payload as EscalationDto;
      expect(dto.sessionSource.kind).toBe('web-pty');
      expect(dto.sessionLabel).toBe(label);
      expect(dto.escalationId).toBe('esc-pty-1');
      expect(dto.toolName).toBe('write_file');
      expect(dto.serverName).toBe('filesystem');

      expect(h.manager.hasEscalation('esc-pty-1')).toBe(true);
      const pending = h.manager.listPendingEscalationDtos();
      expect(pending).toHaveLength(1);
      expect(pending[0].escalationId).toBe('esc-pty-1');
    });

    it('resolveEscalation writes response-*.json, drops the entry, and emits escalation.resolved', async () => {
      const h = makeHarness();
      await h.manager.create();
      const escDir = makeEscalationDir();
      writeRequest(escDir, 'esc-pty-2');
      discover(h.lastBridge(), escDir);

      const accepted = h.manager.resolveEscalation('esc-pty-2', 'approved');
      expect(accepted).toBe(true);

      const responsePath = join(escDir, 'response-esc-pty-2.json');
      expect(existsSync(responsePath)).toBe(true);
      expect(JSON.parse(readFileSync(responsePath, 'utf-8')).decision).toBe('approved');

      const resolved = h.events.filter((e) => e.event === 'escalation.resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0].payload).toEqual({ escalationId: 'esc-pty-2', decision: 'approved' });

      expect(h.manager.hasEscalation('esc-pty-2')).toBe(false);
      expect(h.manager.listPendingEscalationDtos()).toHaveLength(0);
    });

    it('forwards the whitelist selection through to the response file', async () => {
      const h = makeHarness();
      await h.manager.create();
      const escDir = makeEscalationDir();
      writeRequest(escDir, 'esc-pty-wl');
      discover(h.lastBridge(), escDir);

      h.manager.resolveEscalation('esc-pty-wl', 'approved', { whitelistSelection: 2 });

      const response = JSON.parse(readFileSync(join(escDir, 'response-esc-pty-wl.json'), 'utf-8'));
      expect(response).toEqual({ decision: 'approved', whitelistSelection: 2 });
    });

    it('drops the entry and emits escalation.expired when the watcher observes expiry', async () => {
      const h = makeHarness();
      await h.manager.create();
      const escDir = makeEscalationDir();
      writeRequest(escDir, 'esc-pty-3');
      discover(h.lastBridge(), escDir);
      expect(h.manager.hasEscalation('esc-pty-3')).toBe(true);

      // Proxy-side cleanup (both files gone) -> the next poll detects expiry.
      rmSync(join(escDir, 'request-esc-pty-3.json'));
      vi.advanceTimersByTime(400);

      const expired = h.events.filter((e) => e.event === 'escalation.expired');
      expect(expired).toHaveLength(1);
      expect(expired[0].payload).toEqual({ escalationId: 'esc-pty-3', sessionLabel: 1 });
      expect(h.manager.hasEscalation('esc-pty-3')).toBe(false);
    });

    it('stops the escalation watcher on end() (no leaked polling)', async () => {
      const h = makeHarness();
      const { label } = await h.manager.create();
      const escDir = makeEscalationDir();
      discover(h.lastBridge(), escDir);

      h.manager.end(label);
      h.events.length = 0;

      // A request written after end() must NOT surface: the watcher is stopped
      // and its interval cleared, so advancing timers polls nothing.
      writeRequest(escDir, 'esc-after-end');
      vi.advanceTimersByTime(1000);
      expect(h.events.filter((e) => e.event === 'escalation.created')).toHaveLength(0);
    });

    it('stops the escalation watcher on close()', async () => {
      const h = makeHarness();
      await h.manager.create();
      const escDir = makeEscalationDir();
      discover(h.lastBridge(), escDir);

      await h.manager.close();
      h.events.length = 0;

      writeRequest(escDir, 'esc-after-close');
      vi.advanceTimersByTime(1000);
      expect(h.events.filter((e) => e.event === 'escalation.created')).toHaveLength(0);
    });

    // The escalation-dispatch composition (Deliverable 3): resolve routes to the
    // PTY manager when it owns the id; list unions PTY pendings.
    function makeDispatchCtx(h: Harness): DispatchContext {
      return {
        handler: makeHandler(),
        sessionManager: new SessionManager(),
        mode: { kind: 'docker', agent: 'claude-code' },
        eventBus: h.eventBus,
        maxConcurrentWebSessions: 4,
        sessionQueues: new Map(),
        ptySessionManager: h.manager,
      };
    }

    it('escalations.resolve routes to the PTY manager and writes the response', async () => {
      const h = makeHarness();
      await h.manager.create();
      const escDir = makeEscalationDir();
      writeRequest(escDir, 'esc-dispatch-1');
      discover(h.lastBridge(), escDir);

      await escalationDispatch(makeDispatchCtx(h), 'escalations.resolve', {
        escalationId: 'esc-dispatch-1',
        decision: 'denied',
      });

      expect(existsSync(join(escDir, 'response-esc-dispatch-1.json'))).toBe(true);
      expect(h.manager.hasEscalation('esc-dispatch-1')).toBe(false);
      const resolved = h.events.filter((e) => e.event === 'escalation.resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0].payload).toEqual({ escalationId: 'esc-dispatch-1', decision: 'denied' });
    });

    it('escalations.list unions PTY pending escalations', async () => {
      const h = makeHarness();
      await h.manager.create();
      const escDir = makeEscalationDir();
      writeRequest(escDir, 'esc-list-1');
      discover(h.lastBridge(), escDir);

      const list = (await escalationDispatch(makeDispatchCtx(h), 'escalations.list', {})) as EscalationDto[];
      expect(list).toHaveLength(1);
      expect(list[0].escalationId).toBe('esc-list-1');
      expect(list[0].sessionSource.kind).toBe('web-pty');
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap through the real docker sessions.create path (§11 D4)
// ---------------------------------------------------------------------------

function makeHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
    }),
    addJob: vi.fn(),
    removeJob: vi.fn(),
    enableJob: vi.fn(),
    disableJob: vi.fn(),
    recompileJob: vi.fn(),
    reloadJob: vi.fn(),
    runJobNow: vi.fn(),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

describe('sessions.create (docker) concurrency cap', () => {
  it('rejects past maxConcurrentWebSessions counting PTY sessions', async () => {
    const eventBus = new WebEventBus();
    const manager = new PtySessionManager({
      sender: { sendToSubscribers: () => {} },
      sessionManager: new SessionManager(),
      eventBus,
      mode: { kind: 'docker', agent: 'claude-code' },
      daemonId: 'test',
      daemonPid: 1,
      createBridge: async () => new StubBridge() as unknown as PtyBridge,
      preflight: async () => {},
    });

    const ctx: DispatchContext = {
      handler: makeHandler(),
      sessionManager: new SessionManager(),
      mode: { kind: 'docker', agent: 'claude-code' },
      eventBus,
      maxConcurrentWebSessions: 2,
      sessionQueues: new Map(),
      ptySessionManager: manager,
    };

    const r1 = (await sessionDispatch(ctx, 'sessions.create', {})) as { label: number };
    const r2 = (await sessionDispatch(ctx, 'sessions.create', {})) as { label: number };
    expect(r1.label).toBeGreaterThan(0);
    expect(r2.label).toBeGreaterThan(0);
    expect(manager.size).toBe(2);

    await expect(sessionDispatch(ctx, 'sessions.create', {})).rejects.toThrow('PTY session limit reached (max 2)');
  });

  it('counts an in-flight create before its bridge has registered', async () => {
    let resolveBridge: ((bridge: PtyBridge) => void) | undefined;
    const eventBus = new WebEventBus();
    const sessionManager = new SessionManager();
    const manager = new PtySessionManager({
      sender: { sendToSubscribers: () => {} },
      sessionManager,
      eventBus,
      mode: { kind: 'docker', agent: 'claude-code' },
      daemonId: 'test',
      daemonPid: 1,
      createBridge: () =>
        new Promise((resolve) => {
          resolveBridge = resolve;
        }),
      preflight: async () => {},
    });
    const ctx: DispatchContext = {
      handler: makeHandler(),
      sessionManager,
      mode: { kind: 'docker', agent: 'claude-code' },
      eventBus,
      maxConcurrentWebSessions: 1,
      sessionQueues: new Map(),
      ptySessionManager: manager,
    };

    const first = sessionDispatch(ctx, 'sessions.create', {});
    expect(manager.capacityUsed).toBe(1);
    await expect(sessionDispatch(ctx, 'sessions.create', {})).rejects.toThrow('PTY session limit reached (max 1)');

    resolveBridge?.(new StubBridge() as unknown as PtyBridge);
    await expect(first).resolves.toMatchObject({ label: 1 });
  });
});

describe('sessions resume RPC', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-web-resume-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeSnapshot(sessionId: string, overrides: Record<string, unknown> = {}): void {
    const sessionDir = join(home, 'sessions', sessionId);
    const workspacePath = join(sessionDir, 'sandbox');
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(
      join(sessionDir, 'session-state.json'),
      JSON.stringify({
        sessionId,
        status: 'user-exit',
        exitCode: 0,
        lastActivity: '2026-08-24T12:00:00.000Z',
        workspacePath,
        persona: 'saved-persona',
        providerProfileName: 'work',
        agent: 'goose',
        label: 'Saved Goose session',
        resumable: true,
        ...overrides,
      }),
    );
  }

  function makeResumeContext(seen: PtyBridgeOptions[] = []): DispatchContext {
    const eventBus = new WebEventBus();
    const sessionManager = new SessionManager();
    const manager = new PtySessionManager({
      sender: { sendToSubscribers: () => {} },
      sessionManager,
      eventBus,
      mode: { kind: 'docker', agent: 'claude-code' },
      daemonId: 'test',
      daemonPid: 1,
      createBridge: async (options) => {
        seen.push(options);
        return new StubBridge() as unknown as PtyBridge;
      },
      preflight: async () => {},
    });
    return {
      handler: makeHandler(),
      sessionManager,
      mode: { kind: 'docker', agent: 'claude-code' },
      eventBus,
      maxConcurrentWebSessions: 2,
      sessionQueues: new Map(),
      ptySessionManager: manager,
    };
  }

  it('lists safe resumable metadata and resumes with the validated snapshot identity', async () => {
    writeSnapshot('saved-session');
    const seen: PtyBridgeOptions[] = [];
    const ctx = makeResumeContext(seen);

    const list = (await sessionDispatch(ctx, 'sessions.listResumable', {})) as Array<Record<string, unknown>>;
    expect(list).toEqual([
      expect.objectContaining({
        sessionId: 'saved-session',
        displayName: 'Saved Goose session',
        agent: 'goose',
        persona: 'saved-persona',
      }),
    ]);
    expect(list[0]).not.toHaveProperty('workspacePath');

    await expect(sessionDispatch(ctx, 'sessions.resume', { sessionId: 'saved-session' })).resolves.toEqual({
      label: 1,
    });
    expect(seen[0]).toMatchObject({ resumeSessionId: 'saved-session', agent: 'goose' });

    await expect(sessionDispatch(ctx, 'sessions.listResumable', {})).resolves.toEqual([]);
    ctx.ptySessionManager?.end(1);
    await expect(sessionDispatch(ctx, 'sessions.listResumable', {})).resolves.toHaveLength(1);
  });

  it('returns SESSION_NOT_RESUMABLE for a stale or invalid saved session', async () => {
    writeSnapshot('finished-session', { resumable: false, status: 'completed' });
    writeSnapshot('unsafe-session', { workspacePath: '/' });
    const ctx = makeResumeContext();

    await expect(sessionDispatch(ctx, 'sessions.listResumable', {})).resolves.toEqual([]);

    await expect(sessionDispatch(ctx, 'sessions.resume', { sessionId: 'finished-session' })).rejects.toMatchObject({
      code: 'SESSION_NOT_RESUMABLE',
    });
    await expect(sessionDispatch(ctx, 'sessions.resume', { sessionId: 'unsafe-session' })).rejects.toMatchObject({
      code: 'SESSION_NOT_RESUMABLE',
    });
    await expect(sessionDispatch(ctx, 'sessions.resume', { sessionId: 'missing-session' })).rejects.toMatchObject({
      code: 'SESSION_NOT_RESUMABLE',
    });
  });

  it('rejects resume outside container mode before touching the saved session', async () => {
    const ctx = makeResumeContext();
    const builtinCtx = { ...ctx, mode: { kind: 'builtin' } as const };

    await expect(
      sessionDispatch(builtinCtx, 'sessions.resume', { sessionId: 'missing-session' }),
    ).rejects.toMatchObject({
      code: 'SESSION_NOT_RESUMABLE',
    });
  });
});
