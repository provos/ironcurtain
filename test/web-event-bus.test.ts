/**
 * Tests for WebEventBus -- typed pub/sub event bus for web UI events.
 */

import { describe, it, expect, vi } from 'vitest';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';

describe('WebEventBus', () => {
  it('delivers events to a subscriber', () => {
    const bus = new WebEventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    bus.emit('session.created', {
      label: 1,
      source: { kind: 'web' },
      status: 'ready',
      turnCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
      hasPendingEscalation: false,
      messageInFlight: false,
      budget: {
        totalTokens: 0,
        stepCount: 0,
        elapsedSeconds: 0,
        estimatedCostUsd: 0,
        tokenTrackingAvailable: false,
        limits: { maxTotalTokens: null, maxSteps: null, maxSessionSeconds: null, maxEstimatedCostUsd: null },
      },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith('session.created', expect.objectContaining({ label: 1 }));
  });

  it('delivers events to multiple subscribers', () => {
    const bus = new WebEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe(h1);
    bus.subscribe(h2);

    bus.emit('session.ended', { label: 1, reason: 'user_ended' });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('unsubscribes via the returned callback', () => {
    const bus = new WebEventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe(handler);

    bus.emit('session.ended', { label: 1, reason: 'done' });
    expect(handler).toHaveBeenCalledOnce();

    unsub();
    bus.emit('session.ended', { label: 2, reason: 'done' });
    expect(handler).toHaveBeenCalledOnce(); // not called again
  });

  it('handles emit with no subscribers', () => {
    const bus = new WebEventBus();
    // Should not throw
    expect(() => bus.emit('session.ended', { label: 1, reason: 'done' })).not.toThrow();
  });

  it('does not call unsubscribed handler when other handlers remain', () => {
    const bus = new WebEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = bus.subscribe(h1);
    bus.subscribe(h2);

    unsub1();
    bus.emit('escalation.resolved', { escalationId: 'e1', decision: 'approved' });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('double unsubscribe is harmless', () => {
    const bus = new WebEventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe(handler);

    unsub();
    unsub(); // second call should be a no-op

    bus.emit('session.ended', { label: 1, reason: 'done' });
    expect(handler).not.toHaveBeenCalled();
  });
});
