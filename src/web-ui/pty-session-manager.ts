/**
 * PtySessionManager -- owns the daemon-side lifecycle of Docker-agent PTY
 * sessions streamed to the web UI as live terminals.
 *
 * Each managed session ({@link PtyWebSession}) wraps one {@link PtyBridge}
 * (a spawned `ironcurtain start --pty` child) and fans its terminal output out
 * to a set of subscribed WebSocket clients as coalesced, base64-encoded
 * `session.pty_output` deltas, with a one-shot `session.pty_replay` snapshot on
 * attach/resync. This mirrors the TokenStreamBridge targeted-delivery pattern
 * (per-client subscribe + `removeAllForClient`); the two are independent.
 *
 * PTY sessions are a distinct session kind. They are NOT `ManagedSession`s (they
 * have no Session/Transport); they only borrow a label via
 * `sessionManager.reserveLabel()`. Lifecycle: created via `sessions.create` in
 * docker mode, reaped on explicit `sessions.end`, on child exit, on an idle-TTL
 * backstop ({@link PTY_IDLE_TTL_MS}), or on daemon shutdown (`close()`).
 *
 * Escalation bridging (an EscalationWatcher on the discovered `escalationDir`)
 * is Phase 4. The seam is present: {@link PtyWebSession.escalationDir} is
 * captured from `bridge.onSessionDiscovered`, but no watcher is started here.
 */

import type { WebSocket as WsWebSocket } from 'ws';

import type { SessionManager } from '../session/session-manager.js';
import type { SessionMode } from '../session/types.js';
import type { WebEventBus } from './web-event-bus.js';
import { createPtyBridge, type PtyBridge, type PtyBridgeOptions } from '../pty/pty-bridge.js';
import { resolveIroncurtainBin } from '../pty/resolve-ironcurtain-bin.js';
import { RpcError, SessionNotFoundError } from './web-ui-types.js';
// Runtime edge is one-directional (this module -> dispatch/types.ts); the
// back-reference from types.ts to PtyWebSession/PtySessionManager is type-only.
import { toPtySessionDto } from './dispatch/types.js';

// ---------------------------------------------------------------------------
// Constants (hard-coded per design §6/§11 -- no config schema for v1)
// ---------------------------------------------------------------------------

/**
 * Idle-TTL leak backstop: a PTY session with no subscribers for this long is
 * reaped (kills the child + container). Generous by design so a browser reload,
 * laptop sleep, or wifi blip does not kill a working agent. Set to `0` to
 * disable (local testing). Not a config knob for v1 (§6).
 */
export const PTY_IDLE_TTL_MS = 30 * 60 * 1000;

/** Initial PTY size; the first attaching browser re-sizes via ptyResize (§11 D1). */
const PTY_INITIAL_COLS = 80;
const PTY_INITIAL_ROWS = 24;

/** Output coalescing: flush accumulated onData on this timer or at the byte cap. */
const PTY_COALESCE_MS = 16;
const PTY_COALESCE_MAX_BYTES = 32 * 1024;

/** Backpressure threshold: above this `bufferedAmount`, skip deltas + resync on drain. */
const PTY_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/** Replayed scrollback tail cap (§11 Q2): keeps a pty_replay frame under maxPayload. */
const PTY_REPLAY_SCROLLBACK = 1000;

/** Bounded await for child exits on daemon shutdown (mirrors mux doShutdown). */
const PTY_CLOSE_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Encoding + collaborator seams
// ---------------------------------------------------------------------------

/** Terminal bytes are carried over the (JSON-text) WS as base64. */
function encodeBytes(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
function decodeBytes(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** Targeted per-client event delivery. Implemented by WebUiServer. */
export interface PtyStreamSender {
  sendToSubscribers(clients: ReadonlySet<WsWebSocket>, event: string, payload: unknown): void;
}

/** Factory seam so tests can inject a stub bridge instead of spawning a child. */
export type CreateBridge = (options: PtyBridgeOptions) => Promise<PtyBridge>;

/**
 * Thrown by `create()` when the PTY runtime is unavailable (node-pty fails to
 * load, or the serialize addon is missing). Surfaced as a clean RPC error so a
 * builtin-only / broken host degrades instead of crashing the daemon (§11 D1).
 */
export class PtyUnavailableError extends RpcError {
  constructor(detail: string) {
    super('INTERNAL_ERROR', `PTY terminal unavailable: ${detail}`);
    this.name = 'PtyUnavailableError';
  }
}

export interface PtySessionManagerOptions {
  readonly sender: PtyStreamSender;
  readonly sessionManager: SessionManager;
  readonly eventBus: WebEventBus;
  /** Daemon session mode; the docker variant supplies the child `agent`. */
  readonly mode: SessionMode;
  /** Owner id/pid stamped into the PTY registry (`webui-<daemonId>`, §11 Q1). */
  readonly daemonId: string;
  readonly daemonPid: number;
  /** Process-wide capture-traces default; a per-create flag overrides it. */
  readonly captureTracesDefault?: boolean;
  /** Injected for tests (default `createPtyBridge`). */
  readonly createBridge?: CreateBridge;
  /** Injected for tests: probes node-pty + serialize addon (default: real import). */
  readonly preflight?: () => Promise<void>;
  /** Idle-TTL override for tests; defaults to {@link PTY_IDLE_TTL_MS}. */
  readonly idleTtlMs?: number;
}

// ---------------------------------------------------------------------------
// PtyWebSession -- one bridge + its subscriber set + the coalescing streamer
// ---------------------------------------------------------------------------

export class PtyWebSession {
  /** Discovered escalation dir (Phase 4 seam; no watcher started in v1). */
  escalationDir: string | undefined;
  /** ISO timestamp of the most recent browser attach (surfaced in the DTO). */
  lastAttachedAt: string | null = null;
  readonly createdAt: string = new Date().toISOString();

  private readonly subscribers = new Set<WsWebSocket>();
  /** Clients skipped due to backpressure; resynced with a fresh snapshot on drain. */
  private readonly desynced = new Set<WsWebSocket>();
  private buffer = '';
  private bufferBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly label: number,
    readonly bridge: PtyBridge,
    private readonly sender: PtyStreamSender,
    readonly persona: string | undefined,
  ) {}

  get alive(): boolean {
    return this.bridge.alive;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  /**
   * Attaches one client: drains any coalesced output to the existing
   * subscribers, sends this client a fresh full-screen snapshot, then
   * subscribes it. Draining first makes the snapshot the single source of
   * truth so a still-buffered chunk is never re-delivered to the new client
   * after it subscribes (closes the replay/subscribe overlap; the bridge's
   * post-write onData ordering invariant closes the serialize/subscribe race).
   */
  attach(client: WsWebSocket): void {
    this.flushNow();
    this.sendReplay(client);
    this.subscribers.add(client);
    this.lastAttachedAt = new Date().toISOString();
  }

  /** Removes a client from the subscriber + desync sets. */
  removeSubscriber(client: WsWebSocket): void {
    this.subscribers.delete(client);
    this.desynced.delete(client);
  }

  /** Wired to `bridge.onData`: accumulate + flush on timer or at the byte cap. */
  pushChunk(chunk: string): void {
    this.buffer += chunk;
    this.bufferBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.bufferBytes >= PTY_COALESCE_MAX_BYTES) {
      this.flushNow();
    } else {
      this.scheduleFlush();
    }
  }

  /** Clears timers + buffered state; leaves subscriber routing to the manager. */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.subscribers.clear();
    this.desynced.clear();
    this.buffer = '';
    this.bufferBytes = 0;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, PTY_COALESCE_MS);
  }

  /**
   * Flushes the coalesced buffer to healthy subscribers, then resyncs any
   * backpressured client that has since drained. A resync sends a full snapshot
   * (which already reflects the drained delta via the onData ordering
   * invariant), so a just-resynced client is intentionally excluded from the
   * same cycle's delta to avoid a double-render.
   */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const data = this.buffer;
    this.buffer = '';
    this.bufferBytes = 0;

    if (data.length > 0) {
      const recipients = new Set<WsWebSocket>();
      for (const client of this.subscribers) {
        if (this.desynced.has(client)) continue;
        if (client.bufferedAmount > PTY_BACKPRESSURE_BYTES) {
          this.desynced.add(client);
          continue;
        }
        recipients.add(client);
      }
      if (recipients.size > 0) {
        this.sender.sendToSubscribers(recipients, 'session.pty_output', {
          label: this.label,
          data: encodeBytes(data),
        });
      }
    }

    for (const client of [...this.desynced]) {
      if (client.bufferedAmount <= PTY_BACKPRESSURE_BYTES) this.sendReplay(client);
    }

    // Keep polling for drain while any client is still backpressured.
    if (this.desynced.size > 0) this.scheduleFlush();
  }

  /** Sends a one-shot full-screen snapshot; clears the client's desync flag. */
  private sendReplay(client: WsWebSocket): void {
    this.desynced.delete(client);
    const snapshot = encodeBytes(this.bridge.serialize({ scrollback: PTY_REPLAY_SCROLLBACK }));
    this.sender.sendToSubscribers(new Set([client]), 'session.pty_replay', {
      label: this.label,
      snapshot,
    });
  }
}

// ---------------------------------------------------------------------------
// PtySessionManager
// ---------------------------------------------------------------------------

export class PtySessionManager {
  private readonly sessions = new Map<number, PtyWebSession>();
  private readonly idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly sender: PtyStreamSender;
  private readonly sessionManager: SessionManager;
  private readonly eventBus: WebEventBus;
  private readonly mode: SessionMode;
  private readonly ownerId: string;
  private readonly ownerPid: number;
  private readonly captureTracesDefault: boolean;
  private readonly createBridge: CreateBridge;
  private readonly runPreflight: () => Promise<void>;
  private readonly idleTtlMs: number;
  private preflightPromise: Promise<void> | undefined;

  constructor(options: PtySessionManagerOptions) {
    this.sender = options.sender;
    this.sessionManager = options.sessionManager;
    this.eventBus = options.eventBus;
    this.mode = options.mode;
    this.ownerId = `webui-${options.daemonId}`;
    this.ownerPid = options.daemonPid;
    this.captureTracesDefault = options.captureTracesDefault ?? false;
    this.createBridge = options.createBridge ?? createPtyBridge;
    this.runPreflight = options.preflight ?? defaultPreflight;
    this.idleTtlMs = options.idleTtlMs ?? PTY_IDLE_TTL_MS;
  }

  /** Number of live PTY sessions (for the status DTO + create cap, §11 D4). */
  get size(): number {
    return this.sessions.size;
  }
  get count(): number {
    return this.sessions.size;
  }

  has(label: number): boolean {
    return this.sessions.has(label);
  }

  /**
   * Spawns a Docker-agent PTY child and registers it. Fails cleanly with a
   * {@link PtyUnavailableError} if the PTY runtime cannot be loaded. Returns the
   * borrowed label. The initial size is a sane 80x24 default; the first browser
   * attach re-sizes it (§11 D1).
   */
  async create(options: { persona?: string; captureTraces?: boolean } = {}): Promise<{ label: number }> {
    await this.preflight();

    const label = this.sessionManager.reserveLabel();
    const { bin, prefixArgs } = resolveIroncurtainBin();
    const agent = this.mode.kind === 'docker' ? this.mode.agent : 'claude-code';
    const captureTraces = options.captureTraces ?? this.captureTracesDefault;

    const bridge = await this.createBridge({
      cols: PTY_INITIAL_COLS,
      rows: PTY_INITIAL_ROWS,
      ironcurtainBin: bin,
      prefixArgs,
      agent,
      ...(options.persona ? { persona: options.persona } : {}),
      captureTraces,
      muxId: this.ownerId,
      muxPid: this.ownerPid,
    });

    const session = new PtyWebSession(label, bridge, this.sender, options.persona);
    bridge.onData((chunk) => session.pushChunk(chunk));
    bridge.onExit(() => this.handleExit(label));
    // Phase 4 seam: capture the escalation dir for a future EscalationWatcher.
    bridge.onSessionDiscovered((reg) => {
      if (reg) session.escalationDir = reg.escalationDir;
    });

    this.sessions.set(label, session);
    // A freshly created session has no subscribers yet; arm the idle backstop so
    // a browser that crashes between create and attach doesn't leak a container.
    // The first attach cancels it.
    this.startIdleTimer(label);
    this.eventBus.emit('session.created', toPtySessionDto(session));
    return { label };
  }

  /**
   * Attaches a client to a session's terminal stream: a synchronous
   * snapshot-then-subscribe (see {@link PtyWebSession.attach}). Cancels the
   * session's idle-TTL timer.
   */
  attach(label: number, client: WsWebSocket): void {
    const session = this.sessions.get(label);
    if (!session) throw new SessionNotFoundError(label);
    session.attach(client);
    this.clearIdleTimer(label);
  }

  /** Detaches a client; starts the idle-TTL timer if the session is now empty. */
  detach(label: number, client: WsWebSocket): void {
    const session = this.sessions.get(label);
    if (!session) return;
    session.removeSubscriber(client);
    if (!session.hasSubscribers()) this.startIdleTimer(label);
  }

  /** Removes a disconnecting client from every session (mirrors the token bridge). */
  removeAllForClient(client: WsWebSocket): void {
    for (const [label, session] of this.sessions) {
      session.removeSubscriber(client);
      if (!session.hasSubscribers()) this.startIdleTimer(label);
    }
  }

  /** Forwards decoded keystroke bytes to the child PTY stdin. */
  input(label: number, dataB64: string): void {
    const session = this.requireSession(label);
    session.bridge.write(decodeBytes(dataB64));
  }

  /** Resizes the child PTY (browser xterm is just another resize source). */
  resize(label: number, cols: number, rows: number): void {
    const session = this.requireSession(label);
    session.bridge.resize(cols, rows);
  }

  /** Explicitly ends a session (kills the child -> container teardown). */
  end(label: number): void {
    this.endInternal(label, 'user_ended');
  }

  /** Kills all bridges with a bounded await (mirrors mux doShutdown). */
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();

    const exits = sessions.map(
      (session) =>
        new Promise<void>((resolve) => {
          session.bridge.onExit(() => resolve());
          session.dispose();
          session.bridge.kill();
        }),
    );
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, PTY_CLOSE_TIMEOUT_MS));
    await Promise.race([Promise.allSettled(exits), timeout]);
  }

  /** SessionDto snapshots for `sessions.list`. */
  listDtos(): ReturnType<typeof toPtySessionDto>[] {
    return [...this.sessions.values()].map((session) => toPtySessionDto(session));
  }

  getDto(label: number): ReturnType<typeof toPtySessionDto> | undefined {
    const session = this.sessions.get(label);
    return session ? toPtySessionDto(session) : undefined;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireSession(label: number): PtyWebSession {
    const session = this.sessions.get(label);
    if (!session) throw new SessionNotFoundError(label);
    return session;
  }

  private handleExit(label: number): void {
    // On explicit end()/idle reap the session is already removed; this fires
    // for a child that exited on its own (agent quit / crash).
    const session = this.sessions.get(label);
    if (!session) return;
    this.sessions.delete(label);
    this.clearIdleTimer(label);
    session.dispose();
    this.eventBus.emit('session.ended', { label, reason: 'pty_exited' });
  }

  private endInternal(label: number, reason: string): void {
    const session = this.sessions.get(label);
    if (!session) return;
    // Remove before killing so the bridge's onExit -> handleExit is a no-op
    // (no duplicate session.ended, whether kill fires onExit sync or async).
    this.sessions.delete(label);
    this.clearIdleTimer(label);
    session.dispose();
    session.bridge.kill();
    this.eventBus.emit('session.ended', { label, reason });
  }

  private startIdleTimer(label: number): void {
    if (this.idleTtlMs <= 0) return; // disabled
    this.clearIdleTimer(label);
    this.idleTimers.set(
      label,
      setTimeout(() => {
        this.idleTimers.delete(label);
        this.endInternal(label, 'idle_reaped');
      }, this.idleTtlMs),
    );
  }

  private clearIdleTimer(label: number): void {
    const timer = this.idleTimers.get(label);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(label);
    }
  }

  private preflight(): Promise<void> {
    if (!this.preflightPromise) {
      this.preflightPromise = this.runPreflight().catch((err: unknown) => {
        // Reset so a later create() re-probes rather than caching a failure
        // from a transient load error.
        this.preflightPromise = undefined;
        throw new PtyUnavailableError(err instanceof Error ? err.message : String(err));
      });
    }
    return this.preflightPromise;
  }
}

/** Default runtime probe: node-pty must load and the serialize addon must exist. */
async function defaultPreflight(): Promise<void> {
  await import('node-pty');
  await import('@xterm/addon-serialize');
}
