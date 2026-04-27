/**
 * Tests for TokenStreamBridge -- per-client subscription management,
 * reference counting, event batching, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenStreamBridge, type TokenStreamSender } from '../src/web-ui/token-stream-bridge.js';
import { getTokenStreamBus, resetTokenStreamBus, type TokenStreamBus } from '../src/docker/token-stream-bus.js';
import type { SessionId } from '../src/session/types.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';
import type { WebSocket as WsWebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionId(id: string): SessionId {
  return id as SessionId;
}

function textDelta(text: string): TokenStreamEvent {
  return { kind: 'text_delta', text, timestamp: Date.now() };
}

/** Create a minimal mock WsWebSocket. */
function mockWs(): WsWebSocket {
  return { readyState: 1 } as unknown as WsWebSocket;
}

/** Create a mock sender that records calls. */
function mockSender(): TokenStreamSender & {
  calls: Array<{ clients: ReadonlySet<WsWebSocket>; event: string; payload: unknown }>;
} {
  const calls: Array<{ clients: ReadonlySet<WsWebSocket>; event: string; payload: unknown }> = [];
  return {
    calls,
    sendToSubscribers(clients, event, payload) {
      // Snapshot the clients set since it may be mutated later
      calls.push({ clients: new Set(clients), event, payload });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenStreamBridge', () => {
  let bus: TokenStreamBus;
  let sender: ReturnType<typeof mockSender>;

  beforeEach(() => {
    resetTokenStreamBus();
    bus = getTokenStreamBus();
    sender = mockSender();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Per-session subscription
  // -----------------------------------------------------------------------

  describe('per-session subscription', () => {
    it('delivers batched events to subscribed clients', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);

      // Push events via bus
      bus.push(sid, textDelta('hello'));
      bus.push(sid, textDelta('world'));

      // Events are batched -- nothing sent yet
      expect(sender.calls).toHaveLength(0);

      // Advance past flush interval
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].event).toBe('session.token_stream');
      expect(sender.calls[0].clients.has(ws1)).toBe(true);

      const payload = sender.calls[0].payload as { label: number; events: TokenStreamEvent[] };
      expect(payload.label).toBe(1);
      expect(payload.events).toHaveLength(2);
      expect(payload.events[0].kind).toBe('text_delta');
    });

    it('delivers events to multiple clients subscribed to the same session', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const ws2 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.addClient(ws2, 1, sid);

      bus.push(sid, textDelta('hello'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].clients.has(ws1)).toBe(true);
      expect(sender.calls[0].clients.has(ws2)).toBe(true);
    });

    it('only creates one bus subscription per label', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const ws2 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.addClient(ws2, 1, sid);

      // Push one event -- should only be received once by the bridge
      bus.push(sid, textDelta('single'));
      vi.advanceTimersByTime(50);

      // Only one flush with one event (not two)
      expect(sender.calls).toHaveLength(1);
      const payload = sender.calls[0].payload as { events: TokenStreamEvent[] };
      expect(payload.events).toHaveLength(1);
    });

    it('removing one client keeps the other receiving events', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const ws2 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.addClient(ws2, 1, sid);
      bridge.removeClient(ws1, 1);

      bus.push(sid, textDelta('after-remove'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].clients.has(ws1)).toBe(false);
      expect(sender.calls[0].clients.has(ws2)).toBe(true);
    });

    it('removing last client unsubscribes from bus', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.removeClient(ws1, 1);

      // Push should not be received
      bus.push(sid, textDelta('orphaned'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(0);
    });

    it('hasSubscription reflects current state', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      expect(bridge.hasSubscription(ws1, 1)).toBe(false);
      bridge.addClient(ws1, 1, sid);
      expect(bridge.hasSubscription(ws1, 1)).toBe(true);
      bridge.removeClient(ws1, 1);
      expect(bridge.hasSubscription(ws1, 1)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Global subscription
  // -----------------------------------------------------------------------

  describe('global subscription', () => {
    it('delivers events from any session with a registered label', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid1 = sessionId('sess-1');
      const sid2 = sessionId('sess-2');

      bridge.registerSession(1, sid1);
      bridge.registerSession(2, sid2);
      bridge.addGlobalClient(ws1);

      bus.push(sid1, textDelta('from-1'));
      vi.advanceTimersByTime(50);

      bus.push(sid2, textDelta('from-2'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(2);
      expect((sender.calls[0].payload as { label: number }).label).toBe(1);
      expect((sender.calls[1].payload as { label: number }).label).toBe(2);
    });

    it('ignores events from sessions without a registered label', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();

      bridge.addGlobalClient(ws1);

      // Push to unregistered session
      bus.push(sessionId('unknown'), textDelta('lost'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(0);
    });

    it('hasGlobalSubscription reflects current state', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();

      expect(bridge.hasGlobalSubscription(ws1)).toBe(false);
      bridge.addGlobalClient(ws1);
      expect(bridge.hasGlobalSubscription(ws1)).toBe(true);
      bridge.removeGlobalClient(ws1);
      expect(bridge.hasGlobalSubscription(ws1)).toBe(false);
    });

    it('removing last global client unsubscribes from bus', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.registerSession(1, sid);
      bridge.addGlobalClient(ws1);
      bridge.removeGlobalClient(ws1);

      bus.push(sid, textDelta('orphaned'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(0);
    });

    it('global and per-session clients both receive events without duplication', () => {
      const bridge = new TokenStreamBridge(sender);
      const wsGlobal = mockWs();
      const wsSession = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(wsSession, 1, sid);
      bridge.addGlobalClient(wsGlobal);

      bus.push(sid, textDelta('shared'));
      vi.advanceTimersByTime(50);

      // One flush with both clients
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].clients.has(wsGlobal)).toBe(true);
      expect(sender.calls[0].clients.has(wsSession)).toBe(true);
      // Only one event in the batch (not duplicated)
      const payload = sender.calls[0].payload as { events: TokenStreamEvent[] };
      expect(payload.events).toHaveLength(1);
    });

    it('same client subscribed globally and per-session appears once in recipients', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.addGlobalClient(ws1);

      bus.push(sid, textDelta('deduped'));
      vi.advanceTimersByTime(50);

      // Set deduplicates automatically
      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].clients.size).toBe(1);
    });

    it('delivers events for sessions registered after global subscribe', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('late-session');

      // Subscribe globally FIRST, before the session exists
      bridge.addGlobalClient(ws1);

      // Then register the session (simulates session.created handler)
      bridge.registerSession(3, sid);

      // Push events for the late-registered session
      bus.push(sid, textDelta('late-event'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].clients.has(ws1)).toBe(true);
      const payload = sender.calls[0].payload as { label: number; events: TokenStreamEvent[] };
      expect(payload.label).toBe(3);
      expect(payload.events).toHaveLength(1);
      expect((payload.events[0] as { kind: string; text: string }).text).toBe('late-event');
    });
  });

  // -----------------------------------------------------------------------
  // closeSession
  // -----------------------------------------------------------------------

  describe('closeSession', () => {
    it('cancels pending timer and discards buffered events', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);

      bus.push(sid, textDelta('buffered'));
      // Timer is pending but not yet fired
      bridge.closeSession(1);
      vi.advanceTimersByTime(100);

      // No events should be sent
      expect(sender.calls).toHaveLength(0);
    });

    it('unsubscribes from bus so future events are not received', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.closeSession(1);

      bus.push(sid, textDelta('after-close'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(0);
    });

    it('cleans up per-client tracking', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.closeSession(1);

      expect(bridge.hasSubscription(ws1, 1)).toBe(false);
    });

    it('cleans up register-only sessions (no per-session subscription)', () => {
      const bridge = new TokenStreamBridge(sender);
      const wsGlobal = mockWs();
      const sid = sessionId('sess-1');

      // Register without per-session subscription (global-only path)
      bridge.registerSession(1, sid);
      bridge.addGlobalClient(wsGlobal);

      // Verify global events work before close
      bus.push(sid, textDelta('before'));
      vi.advanceTimersByTime(50);
      expect(sender.calls).toHaveLength(1);

      // Close session -- should clean up bidirectional maps
      bridge.closeSession(1);

      // Global listener should no longer route events for this session
      // (sessionToLabel mapping is gone, so enqueueGlobal returns early)
      sender.calls.length = 0;
      bus.push(sid, textDelta('after'));
      vi.advanceTimersByTime(50);
      expect(sender.calls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // teardownLabel semantics (bidirectional maps preserved on unsubscribe)
  // -----------------------------------------------------------------------

  describe('per-session teardown preserves global routing', () => {
    it('global subscribers still receive events after the last per-session client unsubscribes', () => {
      const bridge = new TokenStreamBridge(sender);
      const wsSession = mockWs();
      const wsGlobal = mockWs();
      const sid = sessionId('sess-1');

      // Per-session subscription establishes the label<->sessionId mapping.
      bridge.addClient(wsSession, 1, sid);
      bridge.addGlobalClient(wsGlobal);

      // The sole per-session client unsubscribes -- this used to also
      // delete sessionToLabel/labelToSession, which silently broke the
      // global subscriber's routing. It must NOT do that anymore.
      bridge.removeClient(wsSession, 1);

      bus.push(sid, textDelta('global-still-works'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].clients.has(wsGlobal)).toBe(true);
      expect(sender.calls[0].clients.has(wsSession)).toBe(false);
      const payload = sender.calls[0].payload as { label: number; events: TokenStreamEvent[] };
      expect(payload.label).toBe(1);
      expect(payload.events).toHaveLength(1);
    });

    it('closeSession still severs global routing for that session', () => {
      const bridge = new TokenStreamBridge(sender);
      const wsSession = mockWs();
      const wsGlobal = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(wsSession, 1, sid);
      bridge.addGlobalClient(wsGlobal);

      // Per-session unsubscribe: global should still work.
      bridge.removeClient(wsSession, 1);
      bus.push(sid, textDelta('before-close'));
      vi.advanceTimersByTime(50);
      expect(sender.calls).toHaveLength(1);

      // Actual session end: globals must no longer see events.
      sender.calls.length = 0;
      bridge.closeSession(1);
      bus.push(sid, textDelta('after-close'));
      vi.advanceTimersByTime(50);
      expect(sender.calls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // removeAllForClient
  // -----------------------------------------------------------------------

  describe('removeAllForClient', () => {
    it('removes all per-session subscriptions for a client', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid1 = sessionId('sess-1');
      const sid2 = sessionId('sess-2');

      bridge.addClient(ws1, 1, sid1);
      bridge.addClient(ws1, 2, sid2);
      bridge.removeAllForClient(ws1);

      bus.push(sid1, textDelta('gone'));
      bus.push(sid2, textDelta('also-gone'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(0);
    });

    it('removes global subscription for a client', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.registerSession(1, sid);
      bridge.addGlobalClient(ws1);
      bridge.removeAllForClient(ws1);

      expect(bridge.hasGlobalSubscription(ws1)).toBe(false);

      bus.push(sid, textDelta('gone'));
      vi.advanceTimersByTime(50);
      expect(sender.calls).toHaveLength(0);
    });

    it('does not affect other clients on the same session', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const ws2 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);
      bridge.addClient(ws2, 1, sid);
      bridge.removeAllForClient(ws1);

      bus.push(sid, textDelta('still-alive'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].clients.has(ws1)).toBe(false);
      expect(sender.calls[0].clients.has(ws2)).toBe(true);
    });

    it('is safe to call for an unknown client', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();

      // Should not throw
      bridge.removeAllForClient(ws1);
    });
  });

  // -----------------------------------------------------------------------
  // Batching behavior
  // -----------------------------------------------------------------------

  describe('batching', () => {
    it('collects multiple events within the flush interval', () => {
      const bridge = new TokenStreamBridge(sender, 100);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);

      bus.push(sid, textDelta('a'));
      vi.advanceTimersByTime(30);
      bus.push(sid, textDelta('b'));
      vi.advanceTimersByTime(30);
      bus.push(sid, textDelta('c'));
      vi.advanceTimersByTime(40);

      // All three should be in one batch
      expect(sender.calls).toHaveLength(1);
      const payload = sender.calls[0].payload as { events: TokenStreamEvent[] };
      expect(payload.events).toHaveLength(3);
    });

    it('schedules a new timer for events arriving after flush', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);

      bus.push(sid, textDelta('batch-1'));
      vi.advanceTimersByTime(50);

      bus.push(sid, textDelta('batch-2'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(2);
    });

    it('does not send empty batches', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const sid = sessionId('sess-1');

      bridge.addClient(ws1, 1, sid);

      // Advance without pushing any events
      vi.advanceTimersByTime(200);
      expect(sender.calls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // close (full bridge shutdown)
  // -----------------------------------------------------------------------

  describe('close', () => {
    it('cleans up all subscriptions and timers', () => {
      const bridge = new TokenStreamBridge(sender);
      const ws1 = mockWs();
      const ws2 = mockWs();
      const sid1 = sessionId('sess-1');
      const sid2 = sessionId('sess-2');

      bridge.addClient(ws1, 1, sid1);
      bridge.addClient(ws2, 2, sid2);
      bridge.addGlobalClient(ws1);

      bus.push(sid1, textDelta('pending'));

      bridge.close();
      vi.advanceTimersByTime(100);

      // No events should be delivered
      expect(sender.calls).toHaveLength(0);

      // Bus push should not reach anything
      bus.push(sid1, textDelta('after-close'));
      bus.push(sid2, textDelta('after-close'));
      vi.advanceTimersByTime(100);
      expect(sender.calls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end regression: the originally-reported bug
  // -----------------------------------------------------------------------

  describe('observe --all regression (workflow via web UI path)', () => {
    /**
     * Regression test for the original defect: workflow sessions launched
     * via the web UI did not emit tokens to `observe --all --raw`. Root
     * cause was that the bus was optional on every hop and the
     * `WorkflowManager -> WorkflowOrchestrator -> createDockerInfrastructure`
     * path forgot to thread it. With the singleton migration, any MITM
     * publisher and any `subscribeAll` subscriber share the same bus by
     * construction.
     *
     * This test simulates the full chain end-to-end without Docker:
     * - A producer (stand-in for MITM SSE extractor) calls
     *   `getTokenStreamBus().push(sessionId, event)`.
     * - A `TokenStreamBridge` with a global client (stand-in for the
     *   `observe --all` WebSocket client) is attached before the push.
     * - The test asserts the event traverses the full chain to the sender.
     */
    it('delivers MITM-produced events to observe --all via the bridge', () => {
      const bridge = new TokenStreamBridge(sender);
      const observeClient = mockWs();
      const sid = sessionId('workflow-session-42');

      // Simulating the web UI dispatch path: label registered before
      // subscribeAll so the bridge can map SessionId -> label.
      bridge.registerSession(42, sid);
      bridge.addGlobalClient(observeClient);

      // The MITM SSE extractor publishes to the singleton.
      // Previously (pre-migration) a workflow MITM had no bus reference
      // and silently discarded events. Under the singleton, this push
      // reaches every subscriber.
      getTokenStreamBus().push(sid, textDelta('workflow token stream'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      expect(sender.calls[0].event).toBe('session.token_stream');
      expect(sender.calls[0].clients.has(observeClient)).toBe(true);
      const payload = sender.calls[0].payload as { label: number; events: TokenStreamEvent[] };
      expect(payload.label).toBe(42);
      expect(payload.events).toHaveLength(1);
      expect(payload.events[0].kind).toBe('text_delta');
    });

    /**
     * Workflow agent sessions are created by WorkflowOrchestrator, not
     * via `sessions.create`, so they never emit `session.created`. Before
     * the fix, token events for these sessions were silently dropped at
     * `TokenStreamBridge.addGlobalClient` (sessionToLabel lookup returned
     * undefined). The fix wires workflow lifecycle events (`agent_started`
     * / `agent_session_ended`) through the daemon to `bridge.registerSession`
     * / `bridge.closeSession`.
     *
     * This test simulates that wiring at the bridge boundary:
     *   1. Simulate the global observer (`observe --all`) subscribing.
     *   2. Simulate the daemon's workflow.agent_started handler registering
     *      the session.
     *   3. Verify events published by the MITM reach the observer.
     *   4. Simulate agent_session_ended -> closeSession.
     *   5. Verify post-teardown events are dropped (no cross-agent bleed).
     */
    it('workflow-agent lifecycle routes events then tears down on session end', () => {
      const bridge = new TokenStreamBridge(sender);
      const observeClient = mockWs();
      const sid = sessionId('workflow-agent-session-1');
      const label = 101; // would come from SessionManager.reserveLabel()

      // Observer subscribes before the workflow session starts (the
      // viz pre-subscribes on page load).
      bridge.addGlobalClient(observeClient);

      // Daemon's `workflow.agent_started` handler: register the mapping.
      bridge.registerSession(label, sid);

      // MITM publishes token events during session.sendMessage().
      getTokenStreamBus().push(sid, textDelta('agent thinking'));
      getTokenStreamBus().push(sid, textDelta('more tokens'));
      vi.advanceTimersByTime(50);

      expect(sender.calls).toHaveLength(1);
      const firstPayload = sender.calls[0].payload as { label: number; events: TokenStreamEvent[] };
      expect(firstPayload.label).toBe(label);
      expect(firstPayload.events).toHaveLength(2);

      // Daemon's `workflow.agent_session_ended` handler: tear down the
      // mapping. Fires unconditionally in the orchestrator's finally
      // block (symmetric with registration).
      bridge.closeSession(label);

      // Post-teardown pushes must not reach the observer -- no label
      // resolvable, no events delivered.
      sender.calls.length = 0;
      getTokenStreamBus().push(sid, textDelta('stale event after teardown'));
      vi.advanceTimersByTime(50);
      expect(sender.calls).toHaveLength(0);
    });

    /**
     * Rapid state transitions: agent A ends, agent B starts with a
     * fresh session ID. The bridge must not leak A's label/mapping into
     * B's subscription, and B's events must route with B's own label.
     */
    it('handles rapid session churn without stale mappings', () => {
      const bridge = new TokenStreamBridge(sender);
      const observeClient = mockWs();
      const sidA = sessionId('workflow-agent-A');
      const sidB = sessionId('workflow-agent-B');
      const labelA = 201;
      const labelB = 202;

      bridge.addGlobalClient(observeClient);

      // Agent A runs.
      bridge.registerSession(labelA, sidA);
      getTokenStreamBus().push(sidA, textDelta('A-event'));
      vi.advanceTimersByTime(50);
      expect(sender.calls).toHaveLength(1);
      expect((sender.calls[0].payload as { label: number }).label).toBe(labelA);

      // A ends, B starts with a fresh ID and label.
      bridge.closeSession(labelA);
      bridge.registerSession(labelB, sidB);

      sender.calls.length = 0;
      getTokenStreamBus().push(sidB, textDelta('B-event'));
      // A replayed stale event (e.g. in-flight MITM buffer) must not reach
      // the observer under B's label.
      getTokenStreamBus().push(sidA, textDelta('A-stale'));
      vi.advanceTimersByTime(50);

      // Only the B event is delivered; A's stale event has no label.
      expect(sender.calls).toHaveLength(1);
      const payload = sender.calls[0].payload as { label: number; events: TokenStreamEvent[] };
      expect(payload.label).toBe(labelB);
      expect(payload.events).toHaveLength(1);
      expect((payload.events[0] as { text?: string }).text).toBe('B-event');
    });
  });
});
