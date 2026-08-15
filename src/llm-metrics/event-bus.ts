import type { LlmExchangeCompleted } from './types.js';

export type LlmExchangeSubscriber = (exchange: LlmExchangeCompleted) => void;

/** Synchronous, content-free, no-throw publication for completed exchanges. */
export class LlmMetricsEventBus {
  private readonly subscribers = new Set<LlmExchangeSubscriber>();

  subscribe(subscriber: LlmExchangeSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(exchange: LlmExchangeCompleted): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(exchange);
      } catch {
        // Accounting, persistence, and UI consumers are isolated from inference
        // and from one another.
      }
    }
  }
}

let singleton = new LlmMetricsEventBus();

export function getLlmMetricsEventBus(): LlmMetricsEventBus {
  return singleton;
}

/** Test-only reset matching the existing token-stream bus seam. */
export function resetLlmMetricsEventBus(): void {
  singleton = new LlmMetricsEventBus();
}
