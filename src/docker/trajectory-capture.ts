/**
 * Trajectory capture dispatcher and JSONL writer.
 *
 * Owns the per-bundle records queue and per-session file handles. The
 * MITM proxy hands `ExchangeRecord` instances to `write()`; the
 * dispatcher fans them out to per-session `{sessionId}.jsonl` files and
 * maintains a shared `manifest.jsonl`. See
 * docs/designs/mitm-token-trajectory-capture.md §9 for the lifecycle.
 *
 * Design priorities (in order):
 *   1. Never block the proxy thread. `write()` is O(1) synchronous.
 *   2. Binary session model — sessions are complete-and-usable or
 *      poisoned wholesale. Individual records are never dropped from a
 *      healthy session.
 *   3. Crash safety — append-only JSONL, write-time counters, synthetic
 *      session-end on infrastructure teardown.
 */

import { appendFile as fsAppendFile, mkdir as fsMkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionId } from '../session/types.js';
import { getCaptureManifestFile, getSessionCaptureFile } from '../config/paths.js';
import * as logger from '../logger.js';
import {
  type BeginCaptureSessionOptions,
  type CaptureStats,
  type ExchangeRecord,
  type ManifestEntry,
  type PoisonReason,
} from './trajectory-types.js';

/** High watermark on the records queue. See §9 step 2. */
const HIGH_WATERMARK = 1024;
/** Low watermark after queue-overflow poisoning, before new sessions are accepted. */
const LOW_WATERMARK = 256;
/**
 * Upper bound on how long `endSession` waits for a session's in-flight
 * reassemblies to settle before forcibly poisoning them as
 * `mid-stream-abort`. A never-terminating stream that also never aborts
 * would otherwise hang teardown forever. `endSession` is only called
 * after the agent process (and its client socket) has terminated, so a
 * still-pending tap at that point is genuinely stuck.
 */
const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;

interface SessionFileState {
  readonly sessionId: SessionId;
  readonly filePath: string;
  readonly persona?: string;
  readonly fsmState?: string;
  readonly seq: number;
  readonly startedAt: string;
  endRequested: boolean;
  ended: boolean;
  exchanges: number;
  bytesWritten: number;
  poisoned: boolean;
  poisonReason?: PoisonReason;
}

interface PendingWrite {
  readonly sessionId: SessionId;
  readonly line: string;
  readonly byteLength: number;
}

interface PendingManifest {
  readonly line: string;
  /**
   * Optional resolver fired when this manifest entry's `appendFile` call
   * settles (success or failure). Used so the public `endSession`
   * Promise resolves only when the `session-end` marker is durable on
   * disk. See `maybeResolveEnd`.
   */
  readonly onFlushed?: () => void;
}

/**
 * Narrow filesystem dependency surface. Production wires
 * `node:fs/promises`; tests can inject failure-injecting stubs to
 * exercise disk-error code paths (e.g. ENOSPC on the Nth record).
 */
export interface WriterFsDep {
  appendFile(path: string, data: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
}

export interface TrajectoryCaptureWriterOptions {
  /** Directory where `{sessionId}.jsonl` and `manifest.jsonl` are written. */
  readonly capturesDir: string;
  /** Override the filesystem API. Defaults to `node:fs/promises`. */
  readonly fs?: WriterFsDep;
  /**
   * Bound on the `endSession` in-flight wait before still-pending taps
   * are poisoned `mid-stream-abort`. Defaults to
   * {@link DEFAULT_TEARDOWN_TIMEOUT_MS}. Tests override it to a few ms.
   */
  readonly teardownTimeoutMs?: number;
}

/**
 * Public dispatcher contract. The bundle-scoped public surface
 * (`bundle.beginCaptureSession` / `bundle.endCaptureSession`) wraps this;
 * direct callers exist only for unit testing the dispatcher in isolation.
 */
export interface TrajectoryCaptureWriter {
  beginSession(opts: BeginCaptureSessionOptions): void;
  write(record: ExchangeRecord): void;
  setPersona(persona: string | undefined): void;
  endSession(sessionId: SessionId): Promise<void>;
  close(): Promise<void>;
  stats(): CaptureStats;
  /**
   * Flip a per-session poison flag from outside the dispatcher's I/O
   * loop. Used by the trajectory tap to mark `mid-stream-abort` when the
   * upstream tap closes before `_flush` runs, or by tests / future
   * callers that detect a poison condition without going through the
   * write pipeline. Idempotent; first reason wins.
   */
  markSessionPoisoned(sessionId: SessionId, reason: PoisonReason): void;
  /**
   * Register an in-flight reassembly Promise for a session. The
   * dispatcher's Phase B drain (`endSession`) awaits these before
   * emitting the `session-end` manifest entry, so a captureTap whose
   * `_flush` is still pending cannot race the manifest end-marker.
   * Promise settlement (resolve or reject) auto-deregisters; the caller
   * does not need to clear the slot.
   */
  trackInFlight(sessionId: SessionId, promise: Promise<unknown>): void;
}

/**
 * Create a new trajectory capture writer rooted at `capturesDir`. The
 * directory is created lazily on first write to avoid an extra mkdir
 * on every session start when capture is disabled.
 */
export function createTrajectoryCaptureWriter(options: TrajectoryCaptureWriterOptions): TrajectoryCaptureWriter {
  const capturesDir = options.capturesDir;
  const fs: WriterFsDep = options.fs ?? {
    appendFile: (p, d) => fsAppendFile(p, d),
    mkdir: (p, o) => fsMkdir(p, o),
    writeFile: (p, d) => fsWriteFile(p, d),
  };
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  const manifestPath = getCaptureManifestFile(capturesDir);
  const poisonMarkerPath = resolve(capturesDir, 'manifest.poisoned');
  const sessions = new Map<SessionId, SessionFileState>();
  /** Records queue (unbounded; watermark-defended). */
  const recordsQueue: PendingWrite[] = [];
  /** Manifest queue (unbounded; small worst-case). */
  const manifestQueue: PendingManifest[] = [];
  /** Per-session in-flight reassembly promises. */
  const inFlight = new Map<SessionId, Set<Promise<unknown>>>();
  /** Sessions currently waiting in Phase B of endSession. */
  const endResolvers = new Map<SessionId, () => void>();
  let directoryReady = false;
  let directoryPoisoned = false;
  /** When false, beginSession is rejected (queue overflow throttle). */
  let acceptingNewSessions = true;
  let seqCounter = 0;
  let totalWritten = 0;
  let totalDropped = 0;
  let totalBytes = 0;
  let closed = false;
  let closing = false;
  /** Single-flight drain handle. While set, additional scheduleDrain calls share this promise. */
  let drainInflight: Promise<void> | null = null;
  /** Set when scheduleDrain was called while a drain was in flight; triggers a follow-up pass. */
  let drainRequeued = false;

  /** Currently active persona; stamped onto subsequent records. */
  let activePersona: string | undefined;

  function ensureDirectory(): Promise<void> {
    if (directoryReady) return Promise.resolve();
    return fs.mkdir(capturesDir, { recursive: true }).then(() => {
      directoryReady = true;
    });
  }

  /**
   * Single-flight drain. Concurrent callers share the in-flight promise.
   * If scheduleDrain is invoked while a drain is running, a follow-up
   * pass is scheduled after the current one settles — preserving the
   * "every enqueue eventually drains" property without spawning parallel
   * drains that race over the queues.
   */
  function scheduleDrain(): Promise<void> {
    if (drainInflight) {
      drainRequeued = true;
      return drainInflight;
    }
    drainInflight = (async () => {
      try {
        await drain();
      } finally {
        drainInflight = null;
        if (drainRequeued) {
          drainRequeued = false;
          // Chain a follow-up pass so callers awaiting the first
          // promise still see queues drained on resumption paths.
          void scheduleDrain();
        }
      }
    })();
    return drainInflight;
  }

  /**
   * Bundle-wide disk-failure teardown. Poisons every open session,
   * fires `onFlushed` on every queued manifest entry (plus an optional
   * already-shifted `firstEntry`), clears the queues, and resolves every
   * pending `endSession` so no caller hangs on an unwritable directory.
   * Shared by the dir-create failure and manifest-append failure paths.
   */
  async function failBundleDisk(opts: {
    writeMarker: boolean;
    clearRecords?: boolean;
    firstEntry?: PendingManifest;
  }): Promise<void> {
    if (opts.writeMarker) await writePoisonMarker();
    directoryPoisoned = true;
    acceptingNewSessions = false;
    poisonAllOpenSessions('disk-error');
    if (opts.clearRecords) recordsQueue.length = 0;
    opts.firstEntry?.onFlushed?.();
    for (const remaining of manifestQueue) {
      remaining.onFlushed?.();
    }
    manifestQueue.length = 0;
    for (const [sid, resolver] of endResolvers) {
      endResolvers.delete(sid);
      sessions.delete(sid);
      resolver();
    }
  }

  /**
   * Append every queued manifest entry to disk in order, firing each
   * entry's `onFlushed` once durable. Returns `false` (and tears the
   * bundle down via `failBundleDisk`) if an append fails; `true` when the
   * queue drains cleanly.
   */
  async function flushManifestQueue(): Promise<boolean> {
    while (manifestQueue.length > 0) {
      const entry = manifestQueue.shift();
      if (!entry) break;
      try {
        await fs.appendFile(manifestPath, entry.line);
        // The end-marker is now durable on disk; resolve the public
        // endSession Promise if one was attached to this entry.
        entry.onFlushed?.();
      } catch (err) {
        logger.warn(`[trajectory-capture] manifest appendFile failed: ${errorMessage(err)}`);
        await failBundleDisk({ writeMarker: true, firstEntry: entry });
        return false;
      }
    }
    return true;
  }

  async function drain(): Promise<void> {
    try {
      await ensureDirectory();
    } catch (err) {
      logger.warn(`[trajectory-capture] failed to create captures dir: ${errorMessage(err)}`);
      // Treat as bundle-wide disk failure. No poison marker — the
      // directory itself is unreachable, so there is nowhere to write it.
      await failBundleDisk({ writeMarker: false, clearRecords: true });
      return;
    }

    // Drain manifest entries first so session-start / session-end markers
    // appear in order with respect to records that already flushed.
    // (Per-session counters are bumped on record writes, so a session-end
    // enqueued AFTER its records is guaranteed to observe the full count.)
    if (!(await flushManifestQueue())) return;

    while (recordsQueue.length > 0) {
      const item = recordsQueue.shift();
      if (!item) break;
      const session = sessions.get(item.sessionId);
      if (!session) {
        totalDropped++;
        continue;
      }
      if (session.poisoned) {
        // Already poisoned — counters frozen.
        totalDropped++;
        continue;
      }
      try {
        await fs.appendFile(session.filePath, item.line);
        session.exchanges += 1;
        session.bytesWritten += item.byteLength;
        totalWritten += 1;
        totalBytes += item.byteLength;
      } catch (err) {
        logger.warn(`[trajectory-capture] appendFile failed for ${session.sessionId}: ${errorMessage(err)}`);
        markSessionPoisonedInternal(session, 'disk-error');
      }
      // Check if this record was the last enqueued one for a pending
      // endSession — if so, enqueue the session-end manifest entry now.
      maybeEnqueueEnd(session.sessionId);
    }

    // Recheck high/low watermark for re-enabling new sessions.
    if (!acceptingNewSessions && !directoryPoisoned && recordsQueue.length < LOW_WATERMARK) {
      acceptingNewSessions = true;
    }

    // Any session whose `endRequested` is true and queue is empty
    // should get its end-marker enqueued.
    for (const [sid] of endResolvers) {
      maybeEnqueueEnd(sid);
    }

    // If maybeEnqueueEnd just appended one or more manifest entries,
    // drain them this pass so the end-marker is on disk before the
    // single-flight loop unwinds.
    if (manifestQueue.length > 0) {
      await flushManifestQueue();
    }
  }

  /**
   * Enqueue a `session-end` manifest entry iff the session is fully
   * drained (no queued records, no in-flight reassembly). Attaches the
   * stored endResolver to the entry so `endSession` resolves only after
   * the entry has been durably appended to the manifest.
   */
  function maybeEnqueueEnd(sessionId: SessionId): void {
    const session = sessions.get(sessionId);
    if (!session) {
      // Session already cleaned up — resolve any orphan resolver
      // defensively.
      const r = endResolvers.get(sessionId);
      if (r) {
        endResolvers.delete(sessionId);
        r();
      }
      return;
    }
    if (!session.endRequested || session.ended) return;
    const hasQueued = recordsQueue.some((it) => it.sessionId === sessionId);
    const hasInFlight = (inFlight.get(sessionId)?.size ?? 0) > 0;
    if (hasQueued || hasInFlight) return;

    session.ended = true;
    const entry = buildSessionEndEntry(session);
    const resolver = endResolvers.get(sessionId);
    endResolvers.delete(sessionId);
    manifestQueue.push({
      line: serializeJsonl(entry),
      onFlushed: () => {
        sessions.delete(sessionId);
        resolver?.();
      },
    });
  }

  /**
   * Build a `session-end` manifest entry from the session's current
   * counters and poison state. Shared by the two-phase `maybeEnqueueEnd`
   * path and the synthetic teardown emitted by `close()`. Pass
   * `closedReason` only for the teardown path.
   */
  function buildSessionEndEntry(
    session: SessionFileState,
    opts?: { closedReason: 'infrastructure-teardown' },
  ): ManifestEntry {
    return {
      schemaVersion: 1,
      event: 'session-end',
      seq: session.seq,
      sessionId: session.sessionId,
      ...(session.persona !== undefined ? { persona: session.persona } : {}),
      ...(session.fsmState !== undefined ? { fsmState: session.fsmState } : {}),
      ts: new Date().toISOString(),
      exchanges: session.exchanges,
      bytesWritten: session.bytesWritten,
      poisoned: session.poisoned,
      ...(session.poisonReason !== undefined ? { poisonReason: session.poisonReason } : {}),
      ...(opts?.closedReason !== undefined ? { closedReason: opts.closedReason } : {}),
    };
  }

  function markSessionPoisonedInternal(session: SessionFileState, reason: PoisonReason): void {
    if (session.poisoned) return;
    session.poisoned = true;
    session.poisonReason = reason;
  }

  function poisonAllOpenSessions(reason: PoisonReason): void {
    for (const session of sessions.values()) {
      markSessionPoisonedInternal(session, reason);
    }
  }

  async function writePoisonMarker(): Promise<void> {
    try {
      await fs.writeFile(poisonMarkerPath, '');
    } catch (err) {
      logger.warn(`[trajectory-capture] failed to write poison marker: ${errorMessage(err)}`);
    }
  }

  function serializeJsonl(value: unknown): string {
    return JSON.stringify(value) + '\n';
  }

  function trackInFlightInternal(sessionId: SessionId, promise: Promise<unknown>): void {
    let set = inFlight.get(sessionId);
    if (!set) {
      set = new Set();
      inFlight.set(sessionId, set);
    }
    set.add(promise);
    const cleanup = (): void => {
      const s = inFlight.get(sessionId);
      if (!s) return;
      s.delete(promise);
      if (s.size === 0) inFlight.delete(sessionId);
      // A settled in-flight promise may have been the last gate on a
      // pending endSession — nudge the drain.
      void scheduleDrain();
    };
    promise.then(cleanup, cleanup);
  }

  /**
   * Forcibly drop a session's in-flight gate so a hung tap cannot block
   * `endSession` past the teardown timeout. The promises' own
   * `then(cleanup)` may still fire later; `cleanup` tolerates a missing
   * set, so this is safe to race with settlement.
   */
  function forceClearInFlight(sessionId: SessionId): void {
    inFlight.delete(sessionId);
  }

  return {
    beginSession(opts: BeginCaptureSessionOptions): void {
      if (closed || closing) return;
      if (!acceptingNewSessions || directoryPoisoned) {
        logger.warn(`[trajectory-capture] beginSession refused (overflow/poison): sessionId=${opts.sessionId}`);
        return;
      }
      const existing = sessions.get(opts.sessionId);
      if (existing) {
        // Idempotent: first begin wins; the manifest `session-start` entry
        // for this sessionId is already written and is NOT rewritten here.
        // A duplicate begin carrying persona/fsmState that the first call
        // lacked is almost always a lifecycle bug (e.g. two call sites both
        // driving capture for the same session). Warn loudly so it isn't
        // silently swallowed — the richer data would otherwise be lost.
        const incomingPersona = opts.persona ?? activePersona;
        const personaConflict = incomingPersona !== undefined && incomingPersona !== existing.persona;
        const fsmConflict = opts.fsmState !== undefined && opts.fsmState !== existing.fsmState;
        if (personaConflict || fsmConflict) {
          logger.warn(
            `[trajectory-capture] duplicate beginSession for sessionId=${opts.sessionId} ` +
              `carries different metadata (persona=${String(incomingPersona)} fsmState=${String(opts.fsmState)}) ` +
              `than the first begin (persona=${String(existing.persona)} fsmState=${String(existing.fsmState)}); ` +
              `first begin wins, incoming metadata ignored.`,
          );
        }
        return;
      }
      seqCounter += 1;
      const filePath = getSessionCaptureFile(capturesDir, opts.sessionId);
      const state: SessionFileState = {
        sessionId: opts.sessionId,
        filePath,
        persona: opts.persona ?? activePersona,
        fsmState: opts.fsmState,
        seq: seqCounter,
        startedAt: new Date().toISOString(),
        endRequested: false,
        ended: false,
        exchanges: 0,
        bytesWritten: 0,
        poisoned: false,
      };
      sessions.set(opts.sessionId, state);
      const entry: ManifestEntry = {
        schemaVersion: 1,
        event: 'session-start',
        seq: state.seq,
        sessionId: state.sessionId,
        ...(state.persona !== undefined ? { persona: state.persona } : {}),
        ...(state.fsmState !== undefined ? { fsmState: state.fsmState } : {}),
        ts: state.startedAt,
      };
      manifestQueue.push({ line: serializeJsonl(entry) });
      void scheduleDrain();
    },

    write(record: ExchangeRecord): void {
      if (closed || closing) return;
      const sid = record.sessionId as SessionId;
      const session = sessions.get(sid);
      if (!session) {
        // beginSession was not called — a programming error. We can't
        // poison a session that doesn't exist; just drop and log.
        totalDropped += 1;
        logger.warn(`[trajectory-capture] write() before beginSession for ${sid}`);
        return;
      }
      if (session.endRequested || session.poisoned) {
        totalDropped += 1;
        return;
      }
      const line = serializeJsonl(record);
      const byteLength = Buffer.byteLength(line, 'utf-8');
      recordsQueue.push({ sessionId: sid, line, byteLength });
      // High-watermark tripwire: poison every open session, refuse new
      // sessions until the queue drains below LOW_WATERMARK.
      if (recordsQueue.length >= HIGH_WATERMARK && acceptingNewSessions) {
        logger.warn(`[trajectory-capture] high watermark reached (${recordsQueue.length}) — poisoning open sessions`);
        poisonAllOpenSessions('queue-overflow');
        acceptingNewSessions = false;
      }
      void scheduleDrain();
    },

    setPersona(persona: string | undefined): void {
      activePersona = persona;
    },

    async endSession(sessionId: SessionId): Promise<void> {
      const session = sessions.get(sessionId);
      if (!session) return;
      // Phase A: flip endRequested (synchronous).
      session.endRequested = true;
      // Phase B: install a resolver fired when this session's
      // `session-end` manifest entry is durable on disk.
      const promise = new Promise<void>((resolveOuter) => {
        endResolvers.set(sessionId, resolveOuter);
      });
      void scheduleDrain();
      // Wait for inflight reassemblies to settle (Phase B condition 2),
      // but bound the wait: a never-terminating stream that also never
      // aborts would otherwise hang teardown forever. On timeout, poison
      // the session `mid-stream-abort` and force the still-pending taps
      // to settle so the drain can emit the session-end marker.
      const inflightSet = inFlight.get(sessionId);
      if (inflightSet && inflightSet.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((res) => {
          timer = setTimeout(() => res('timeout'), teardownTimeoutMs);
        });
        const settled = Promise.allSettled([...inflightSet]).then(() => 'settled' as const);
        const outcome = await Promise.race([settled, timeout]);
        if (timer) clearTimeout(timer);
        if (outcome === 'timeout') {
          const session2 = sessions.get(sessionId);
          if (session2 && !session2.poisoned) {
            markSessionPoisonedInternal(session2, 'mid-stream-abort');
          }
          // Release the in-flight gate so the drain can emit session-end;
          // the hung tap's promise may settle later but no longer blocks.
          forceClearInFlight(sessionId);
        }
      }
      // Nudge the drain so the just-settled in-flights are picked up.
      void scheduleDrain();
      // The promise resolves only after the session-end manifest entry
      // has actually been appended to disk (or after a disk-failure
      // path explicitly fires the resolver). Callers that immediately
      // tear down infrastructure see the manifest entry already
      // durable.
      await promise;
    },

    async close(): Promise<void> {
      if (closed) return;
      closing = true;
      // Emit synthetic session-end for any sessions still open.
      for (const session of [...sessions.values()]) {
        if (!session.endRequested) {
          session.endRequested = true;
        }
        if (!session.poisoned) {
          markSessionPoisonedInternal(session, 'infrastructure-teardown');
        }
        // Synthesize the session-end now (skip the two-phase wait;
        // teardown is best-effort). The session was just poisoned above,
        // so `buildSessionEndEntry` records poisoned:true with the reason.
        if (!session.ended) {
          session.ended = true;
          const entry = buildSessionEndEntry(session, { closedReason: 'infrastructure-teardown' });
          manifestQueue.push({ line: serializeJsonl(entry) });
        }
      }
      sessions.clear();
      // Drain whatever is queued — single-flight will chain follow-up
      // passes if more enqueues happened mid-drain (drainRequeued
      // mechanism).
      await scheduleDrain();
      // If the drain is itself rescheduled internally, the chained
      // follow-up will have run; wait for that too if it exists.
      if (drainInflight) {
        await drainInflight;
      }
      closed = true;
      closing = false;
    },

    stats(): CaptureStats {
      return {
        written: totalWritten,
        dropped: totalDropped,
        queued: recordsQueue.length + manifestQueue.length,
        bytesWritten: totalBytes,
        openSessions: sessions.size,
      };
    },

    markSessionPoisoned(sessionId: SessionId, reason: PoisonReason): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      markSessionPoisonedInternal(session, reason);
    },

    trackInFlight(sessionId: SessionId, promise: Promise<unknown>): void {
      trackInFlightInternal(sessionId, promise);
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
