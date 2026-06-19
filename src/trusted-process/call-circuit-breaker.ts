/**
 * CallCircuitBreaker -- Proxy-level rate limiter for MCP tool calls.
 *
 * Protects against runaway sandbox code that hammers the same tool
 * with identical arguments. Uses a sliding-window approach: if the
 * same (tool, argsHash) pair appears more than `threshold` times
 * within `windowMs`, the call is denied.
 *
 * Runs AFTER policy evaluation so every call is always audited.
 */

import { computeHash } from '../hash.js';
import { ERROR_PREFIX_CIRCUIT_BREAKER } from './error-prefixes.js';

export interface CircuitBreakerConfig {
  windowMs: number;
  threshold: number;
  /**
   * Number of concurrent worker lanes expected to share this breaker.
   * Identical calls from N lanes should consume N slots before the
   * ordinary single-lane runaway threshold applies.
   */
  workerCount: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  windowMs: 60_000,
  threshold: 20,
  workerCount: 1,
};

export type CircuitBreakerVerdict = { allowed: true } | { allowed: false; reason: string };

export class CallCircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private windows = new Map<string, number[]>();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    this.config = {
      ...merged,
      threshold: Math.max(1, Math.floor(merged.threshold)),
      workerCount: Math.max(1, Math.floor(merged.workerCount)),
    };
  }

  /**
   * Check whether a tool call should be allowed.
   *
   * @returns `{ allowed: true }` or `{ allowed: false, reason: string }`
   */
  check(toolName: string, args: Record<string, unknown>): CircuitBreakerVerdict {
    const argsHash = computeHash(args);
    const key = `${toolName}:${argsHash}`;
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Prune entries older than the window
    const firstValid = timestamps.findIndex((t) => t > cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    // Scale the GLOBAL per-`(tool:argsHash)` threshold by `workerCount` so
    // N homogeneous lanes issuing the same call do not false-trip the
    // single-lane runaway guard. Trade-off: because the window is keyed
    // only by `(tool, argsHash)` and NOT by lane, this grants `threshold *
    // workerCount` headroom to the WHOLE bucket -- so a single runaway lane
    // gets `threshold * N` slots to itself, weakening the DoS guard by a
    // factor of N. Harmless today (`workerCount` is always 1 in
    // production). REQUIRED PREREQUISITE before any caller sets
    // `workerCount > 1`: per-lane bucketing (key the window by lane id) so
    // each lane keeps its own single-lane threshold. Lane ids do not exist
    // yet, so this cannot be implemented here -- see
    // docs/designs/evolve-sync-parallelism-slice.md §5.2.
    const effectiveThreshold = this.config.threshold * this.config.workerCount;
    if (timestamps.length >= effectiveThreshold) {
      return {
        allowed: false,
        reason:
          `${ERROR_PREFIX_CIRCUIT_BREAKER} Tool '${toolName}' called ${effectiveThreshold} times ` +
          `with identical arguments within ${this.config.windowMs / 1000}s window. ` +
          'Try a different approach.',
      };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  /** Reset all state. */
  reset(): void {
    this.windows.clear();
  }
}
