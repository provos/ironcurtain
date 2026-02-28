/**
 * Shared escalation watcher for polling escalation directories.
 *
 * Pure data module -- no I/O presentation. Consumers (DockerAgentSession,
 * EscalationListener) handle display. Polls a session's escalation
 * directory for new request files and handles resolution via response files.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EscalationRequest } from '../session/types.js';

const DEFAULT_POLL_INTERVAL_MS = 300;

/** Events emitted by the escalation watcher. */
export interface EscalationWatcherEvents {
  /** A new escalation request was detected. */
  onEscalation: (request: EscalationRequest) => void;
  /** A pending escalation expired (proxy timed out and cleaned up files). */
  onEscalationExpired: (escalationId: string) => void;
}

export interface EscalationWatcher {
  /** Start polling the escalation directory. */
  start(): void;
  /** Stop polling. */
  stop(): void;
  /** Returns the currently pending escalation, if any. */
  getPending(): EscalationRequest | undefined;
  /**
   * Resolves a pending escalation by writing the response file.
   * Returns true if the resolution was accepted (request file still exists),
   * or false if the escalation had already expired.
   *
   * @throws {Error} if no escalation with this ID is pending
   */
  resolve(escalationId: string, decision: 'approved' | 'denied'): boolean;
}

export interface EscalationWatcherOptions {
  /** Poll interval in ms. Default: 300. */
  pollIntervalMs?: number;
}

/**
 * Atomically writes a JSON file using write-to-temp-then-rename.
 * Prevents partial reads by other processes polling the same directory.
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

/**
 * Creates an escalation watcher for a single session's escalation directory.
 */
export function createEscalationWatcher(
  escalationDir: string,
  events: EscalationWatcherEvents,
  options?: EscalationWatcherOptions,
): EscalationWatcher {
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let pendingEscalation: EscalationRequest | undefined;
  const seenEscalationIds = new Set<string>();
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function extractEscalationId(filename: string): string {
    return filename.replace(/^request-/, '').replace(/\.json$/, '');
  }

  function checkEscalationExpiry(): void {
    if (!pendingEscalation) return;

    const escalationId = pendingEscalation.escalationId;
    const requestExists = existsSync(resolve(escalationDir, `request-${escalationId}.json`));
    const responseExists = existsSync(resolve(escalationDir, `response-${escalationId}.json`));

    if (!requestExists && !responseExists) {
      const expiredId = escalationId;
      pendingEscalation = undefined;
      events.onEscalationExpired(expiredId);
    }
  }

  function pollEscalationDirectory(): void {
    if (pendingEscalation) {
      checkEscalationExpiry();
      return;
    }

    try {
      const files = readdirSync(escalationDir);
      const requestFile = files.find(
        (f) => f.startsWith('request-') && f.endsWith('.json') && !seenEscalationIds.has(extractEscalationId(f)),
      );
      if (!requestFile) return;

      const requestPath = resolve(escalationDir, requestFile);
      const request = JSON.parse(readFileSync(requestPath, 'utf-8')) as EscalationRequest;
      seenEscalationIds.add(request.escalationId);
      pendingEscalation = request;
      events.onEscalation(request);
    } catch {
      // Directory may not exist yet or be empty
    }
  }

  return {
    start(): void {
      if (pollInterval) return;
      pollInterval = setInterval(pollEscalationDirectory, pollIntervalMs);
    },

    stop(): void {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    },

    getPending(): EscalationRequest | undefined {
      return pendingEscalation;
    },

    resolve(escalationId: string, decision: 'approved' | 'denied'): boolean {
      if (!pendingEscalation || pendingEscalation.escalationId !== escalationId) {
        throw new Error(`No pending escalation with ID: ${escalationId}`);
      }

      const responsePath = resolve(escalationDir, `response-${escalationId}.json`);
      atomicWriteJsonSync(responsePath, { decision });
      pendingEscalation = undefined;

      // Stale detection: verify the request file still exists after writing the response.
      // If the proxy already timed out and cleaned up, the response was too late.
      const requestStillExists = existsSync(resolve(escalationDir, `request-${escalationId}.json`));
      return requestStillExists;
    },
  };
}
