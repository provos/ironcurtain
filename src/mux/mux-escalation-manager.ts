/**
 * MuxEscalationManager -- manages escalation watchers for all PTY sessions.
 *
 * Wraps the existing EscalationWatcher and ListenerState modules for the
 * mux context. Creates watchers directly when sessions are spawned, and
 * optionally polls the PTY registry for externally-spawned sessions.
 */

import { mkdirSync } from 'node:fs';
import { getPtyRegistryDir } from '../config/paths.js';
import { readActiveRegistrations } from '../escalation/session-registry.js';
import { createEscalationWatcher } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import type { PtySessionRegistration } from '../docker/pty-types.js';
import {
  createInitialState,
  addSession,
  removeSession,
  addEscalation,
  resolveEscalation,
  expireEscalation,
  type ListenerState,
} from '../escalation/listener-state.js';

/** Poll interval for the session registry directory (ms). */
const REGISTRY_POLL_INTERVAL_MS = 1000;

export interface MuxEscalationManager {
  /** Current state (sessions, pending escalations, history). */
  readonly state: ListenerState;

  /** Number of pending escalations across all sessions. */
  readonly pendingCount: number;

  /**
   * Registers a session for escalation watching.
   */
  addSession(registration: PtySessionRegistration): void;

  /**
   * Removes a session's watcher.
   */
  removeSession(sessionId: string): void;

  /** Resolves a pending escalation by display number. */
  resolve(displayNumber: number, decision: 'approved' | 'denied'): string;

  /** Resolves all pending escalations. */
  resolveAll(decision: 'approved' | 'denied'): string;

  /** Starts polling for externally-spawned sessions. */
  startRegistryPolling(): void;

  /** Stops all watchers and polling. */
  stop(): void;

  /** Register callback for state changes (triggers redraws). */
  onChange(callback: () => void): void;

  /**
   * Registers a callback fired when registry polling discovers a new
   * external session. Used to back-fill bridge registrations that
   * timed out during initial discovery.
   */
  onSessionDiscovered(callback: (reg: PtySessionRegistration) => void): void;

  /**
   * Marks a session ID as managed so registry polling treats it as
   * owned by the mux (won't re-add after removal).
   */
  claimSession(sessionId: string): void;
}

/**
 * Creates a new MuxEscalationManager.
 */
export function createMuxEscalationManager(): MuxEscalationManager {
  let state = createInitialState();
  const changeCallbacks: Array<() => void> = [];
  const discoveryCallbacks: Array<(reg: PtySessionRegistration) => void> = [];
  let registryPollInterval: ReturnType<typeof setInterval> | null = null;

  // Track session IDs that we manage (spawned by mux)
  const managedSessionIds = new Set<string>();
  // Tombstones: removed sessions that may still linger in the registry briefly
  const removedSessionIds = new Set<string>();

  function notifyChange(): void {
    for (const cb of changeCallbacks) cb();
  }

  function createWatcherForSession(sessionId: string, escalationDir: string): EscalationWatcher {
    return createEscalationWatcher(
      escalationDir,
      {
        onEscalation: (request) => {
          state = addEscalation(state, sessionId, request);
          notifyChange();
          // BEL to alert user
          process.stderr.write('\x07');
        },
        onEscalationExpired: (escalationId) => {
          state = expireEscalation(state, sessionId, escalationId);
          notifyChange();
        },
      },
      { pollIntervalMs: 300 },
    );
  }

  return {
    get state() {
      return state;
    },

    get pendingCount() {
      return state.pendingEscalations.size;
    },

    addSession(registration: PtySessionRegistration): void {
      managedSessionIds.add(registration.sessionId);

      const watcher = createWatcherForSession(registration.sessionId, registration.escalationDir);
      state = addSession(state, registration, watcher);
      watcher.start();
      notifyChange();
    },

    removeSession(sessionId: string): void {
      const session = state.sessions.get(sessionId);
      session?.watcher.stop();
      removedSessionIds.add(sessionId);
      state = removeSession(state, sessionId);
      notifyChange();
    },

    resolve(displayNumber: number, decision: 'approved' | 'denied'): string {
      const escalation = state.pendingEscalations.get(displayNumber);
      if (!escalation) {
        return `No pending escalation #${displayNumber}`;
      }

      const session = state.sessions.get(escalation.sessionId);
      if (!session) {
        return `Session for escalation #${displayNumber} no longer active`;
      }

      try {
        const accepted = session.watcher.resolve(escalation.request.escalationId, decision);
        state = resolveEscalation(state, displayNumber, decision);
        notifyChange();

        if (!accepted) {
          return `Escalation #${displayNumber} expired (response was too late)`;
        }

        const label = decision === 'approved' ? 'APPROVED' : 'DENIED';
        return `Escalation #${displayNumber} ${label}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },

    resolveAll(decision: 'approved' | 'denied'): string {
      if (state.pendingEscalations.size === 0) {
        return 'No pending escalations';
      }

      const messages: string[] = [];
      const nums = [...state.pendingEscalations.keys()].sort((a, b) => a - b);

      for (const num of nums) {
        messages.push(this.resolve(num, decision));
      }

      return messages.join('\n');
    },

    startRegistryPolling(): void {
      if (registryPollInterval) return;

      const registryDir = getPtyRegistryDir();
      mkdirSync(registryDir, { recursive: true, mode: 0o700 });

      registryPollInterval = setInterval(() => {
        const registrations = readActiveRegistrations(registryDir);
        const currentIds = new Set(registrations.map((r) => r.sessionId));
        const stateIds = new Set(state.sessions.keys());

        let changed = false;

        // Add externally-spawned sessions (skip managed, tombstoned)
        for (const reg of registrations) {
          if (
            !stateIds.has(reg.sessionId) &&
            !managedSessionIds.has(reg.sessionId) &&
            !removedSessionIds.has(reg.sessionId)
          ) {
            const watcher = createWatcherForSession(reg.sessionId, reg.escalationDir);
            state = addSession(state, reg, watcher);
            watcher.start();
            changed = true;
            for (const cb of discoveryCallbacks) cb(reg);
          }
        }

        // Clear tombstones once the registry entry disappears
        for (const id of removedSessionIds) {
          if (!currentIds.has(id)) {
            removedSessionIds.delete(id);
          }
        }

        // Remove gone external sessions
        for (const id of stateIds) {
          if (!currentIds.has(id) && !managedSessionIds.has(id)) {
            const session = state.sessions.get(id);
            session?.watcher.stop();
            state = removeSession(state, id);
            changed = true;
          }
        }

        if (changed) notifyChange();
      }, REGISTRY_POLL_INTERVAL_MS);
    },

    stop(): void {
      if (registryPollInterval) {
        clearInterval(registryPollInterval);
        registryPollInterval = null;
      }

      for (const session of state.sessions.values()) {
        session.watcher.stop();
      }
    },

    onChange(callback: () => void): void {
      changeCallbacks.push(callback);
    },

    onSessionDiscovered(callback: (reg: PtySessionRegistration) => void): void {
      discoveryCallbacks.push(callback);
    },

    claimSession(sessionId: string): void {
      managedSessionIds.add(sessionId);
    },
  };
}
