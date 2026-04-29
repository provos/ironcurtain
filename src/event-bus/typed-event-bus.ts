/**
 * Generic typed pub/sub event bus.
 *
 * Decouples event producers from consumers via a strongly-typed event map.
 * Each handler receives every emitted event; callers narrow on the event
 * key. Adding a new event requires updating the consumer's `TMap`, ensuring
 * all producers and consumers agree on the payload shape at compile time.
 *
 * This module is deliberately neutral: it has no dependency on the web UI,
 * the daemon, or any other consumer. Concrete event maps (e.g. `WebEventMap`)
 * live alongside their consumers.
 */

export type EventHandler<TMap> = <K extends keyof TMap & string>(event: K, payload: TMap[K]) => void;

/**
 * Typed pub/sub bus. Producers call `emit()`; subscribers receive every
 * event and can narrow on the key to access the typed payload.
 *
 * `TMap` is intentionally unconstrained so callers can use ordinary
 * `interface` declarations (which lack an implicit index signature) for
 * their event maps.
 */
export class TypedEventBus<TMap> {
  private handlers = new Set<EventHandler<TMap>>();

  subscribe(handler: EventHandler<TMap>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): void {
    for (const handler of this.handlers) {
      handler(event, payload);
    }
  }
}
