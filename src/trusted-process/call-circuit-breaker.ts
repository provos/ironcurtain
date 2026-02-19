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

export interface CircuitBreakerConfig {
  windowMs: number;
  threshold: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  windowMs: 60_000,
  threshold: 20,
};

export type CircuitBreakerVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

export class CallCircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private windows = new Map<string, number[]>();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check whether a tool call should be allowed.
   *
   * @returns `{ allowed: true }` or `{ allowed: false, reason: string }`
   */
  check(
    toolName: string,
    args: Record<string, unknown>,
  ): CircuitBreakerVerdict {
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

    if (timestamps.length >= this.config.threshold) {
      return {
        allowed: false,
        reason:
          `CIRCUIT BREAKER: Tool '${toolName}' called ${this.config.threshold} times ` +
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
