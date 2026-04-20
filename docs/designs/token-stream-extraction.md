# Token Stream Extraction from MITM Proxy

> **Status note (post-ship):** The bus is now a module-level singleton accessed
> via `getTokenStreamBus()` — see `docs/designs/token-stream-bus-ownership.md`
> for the ownership change. This doc's original text described threading the
> bus through `MitmProxyOptions`, `prepareDockerInfrastructure()`, and
> `SessionOptions`. The extractor placement, SSE parser design, bridge
> batching, and JSON-RPC surface are all unchanged. In the shipped code the
> MITM proxy and `TokenStreamBridge` read the singleton internally; no caller
> threads the bus anymore. References to `MitmProxyOptions.tokenStreamBus`,
> `DockerInfrastructure.tokenStreamBus`, `SessionOptions.tokenStreamBus`, and
> the `tokenStreamBus` parameter on `prepareDockerInfrastructure()` below are
> historical — none of those fields exist today.

## 1. Overview

This design extracts the live LLM token stream from the MITM TLS proxy during Docker agent sessions and makes it available to multiple consumers through a single shared bus. The primary consumers are: (1) a future `ironcurtain observe <sessionId>` CLI command that tails a session's token output, (2) workflow-level observation that aggregates token streams from all sessions belonging to a workflow, and (3) the existing WebSocket-based web UI for the cinematic Matrix rain visualization described in the brainstorm doc.

The extraction layer sits inside each MITM proxy, tapping the response bytes as they flow from the upstream LLM API back to the Docker container. A single `TokenStreamBus` instance, created once in the daemon and shared across all MITM proxies and consumers, decouples the taps from all consumers. Consumers use `subscribe(sessionId, ...)` to watch a single session or `subscribeAll(...)` to observe all sessions (e.g., for workflow-level views or a Matrix rain visualization). This ensures that the proxy's core forwarding path is never blocked or slowed by downstream visualization, and that new sessions joining a workflow automatically appear to global listeners without any registration step.

## 2. Key Design Decisions

1. **Tap location: inside `forwardRequest()`, between `upstreamRes` and `clientRes.pipe()`** -- The MITM proxy has three `upstreamRes.pipe(clientRes)` call sites: the `forwardRequest()` path (line 464), the plain HTTP proxy path (line 667), and the `forwardPassthrough()` path (line 924). Only the `forwardRequest()` path is tapped. The other two are passthrough paths: the plain HTTP proxy handles unencrypted traffic to dynamically added domains, and `forwardPassthrough()` handles TLS-terminated passthrough connections. Neither performs provider authentication or credential swap, so neither carries LLM API traffic. The Transform is zero-copy for the forwarding path: it calls `this.push(chunk)` unconditionally and emits a side-channel copy.

2. **SSE parsing in the tap, not in the bus** -- The upstream response for streaming LLM APIs uses Server-Sent Events (SSE) over chunked HTTP. SSE lines can split across TCP chunks, so we need a stateful line buffer in the tap. The tap performs minimal parsing: it reassembles SSE `data:` lines and emits structured events. The bus and consumers receive parsed events, not raw bytes. This avoids duplicating SSE parsing in every consumer.

3. **Single shared `TokenStreamBus` created once in the daemon** -- A new module (`src/docker/token-stream-bus.ts`) owns the session-to-stream mapping. The bus is created once at daemon startup and the same instance is passed to every MITM proxy (via `MitmProxyOptions`) and to the `TokenStreamBridge`. Every event carries a `sessionId`, so consumers filter to what they need. The bus does not know about WebSockets, CLI commands, workflows, or the daemon. It exposes a typed subscribe/unsubscribe API. This keeps the MITM proxy's dependency graph clean and eliminates the mismatch between a bus-per-session model and a single bridge consumer.

4. **Pure pub/sub dispatcher, no buffering** -- The bus is a stateless dispatcher: `push()` delivers events synchronously to current listeners and discards them if none exist. There is no ring buffer, no catch-up replay, no per-session storage. Events are fire-and-forget. This makes the bus trivially simple (~20 lines of implementation) and eliminates all memory-sizing concerns. The primary consumer is a real-time visualization (Matrix rain) where replaying stale tokens would produce a confusing burst rather than useful context.

5. **Two listener scopes: per-session and global** -- The bus supports two subscription mechanisms:
   - `subscribe(sessionId, listener)` -- receives events for a single session
   - `subscribeAll(listener)` -- receives events from all sessions

   `push(sessionId, event)` dispatches to both the session-specific listener set and the global listener set. This enables:
   - **Web UI session view**: `subscribe(sessionId, ...)`
   - **Web UI workflow view**: multiple `subscribe(sessionId, ...)` calls, one per workflow session
   - **CLI `observe <session>`**: `subscribe(sessionId, ...)`
   - **CLI `observe --all` or `observe <workflow>`**: `subscribeAll(...)` with client-side filtering for workflow membership
   - **Future Matrix rain visualization**: `subscribeAll(...)` to see all active sessions
   - New sessions joining a running workflow automatically appear to `subscribeAll` listeners without any re-subscription or bus-swapping.

6. **Consumers connect through the daemon, not the MITM proxy** -- The MITM proxy runs as a helper within the host process (not a separate child process). The daemon holds references to both the MITM proxy (via `DockerInfrastructure`) and the WebSocket server (via `WebUiServer`). A bridge in the daemon wires the `TokenStreamBus` to subscribed WebSocket clients. The CLI `observe` command connects to the daemon's WebSocket server, not directly to the proxy.

7. **Provider-aware SSE parsing** -- Anthropic (`text/event-stream` with `event:` and `data:` lines), OpenAI (`text/event-stream` with `data:` lines), and Google (JSON streaming) have different SSE formats. The tap uses the provider's `host` to select the correct parser. Only Anthropic and OpenAI are handled initially; Google streaming can be added later.

8. **No modification to the `MitmProxy` interface** -- Both `tokenStreamBus` and `sessionId` are injected via `MitmProxyOptions`, keeping the existing `MitmProxy` interface (start/stop/hosts) unchanged. The session ID is already available at proxy construction time (it is a parameter to `prepareDockerInfrastructure()`), so both values are known at construction and no mutable setter is needed. Callers that do not provide a bus get the existing zero-overhead behavior.

9. **Transform error contract** -- The `SseExtractorTransform._transform()` method must **never** throw or call `callback(err)`. The entire body of `_transform()` is wrapped in a try/catch that always calls `callback(null, chunk)`, ensuring the forwarding path to the Docker container is never interrupted by a parsing bug. Errors in SSE parsing result in `raw` fallback events on the side channel; the primary data path is unconditionally pass-through.

## 3. Data Format

### 3.1 Token Stream Event (emitted by the tap, stored in the bus)

Types live in a dedicated `src/docker/token-stream-types.ts` file, following the codebase convention of domain-specific type modules (`session/types.ts`, `web-ui/web-ui-types.ts`). Both the bus and extractor import from this file.

```typescript
// src/docker/token-stream-types.ts

/**
 * A single event extracted from the LLM's SSE response stream.
 *
 * Discriminated union on `kind`:
 * - `text_delta`: a token (or partial token) of assistant text output
 * - `tool_use`: the agent is invoking a tool (name + partial input JSON)
 * - `message_start`: a new LLM response message has begun
 * - `message_end`: the LLM response message is complete (includes usage)
 * - `error`: the upstream returned an SSE error event
 * - `raw`: an unparsed SSE event (fallback for unknown event types)
 */
export type TokenStreamEvent =
  | {
      readonly kind: 'text_delta';
      readonly text: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'tool_use';
      readonly toolName: string;
      readonly inputDelta: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'message_start';
      readonly model: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'message_end';
      readonly stopReason: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: 'raw';
      readonly eventType: string;
      readonly data: string;
      readonly timestamp: number;
    };

/**
 * Callback invoked for each token stream event.
 */
export type TokenStreamListener = (event: TokenStreamEvent) => void;
```

Timestamps use `Date.now()` (milliseconds since epoch) for low overhead. The `text_delta` kind carries the actual token text that drives the Matrix rain visualization. The `raw` kind is a catch-all for SSE event types we do not explicitly parse, ensuring no information is silently dropped.

### 3.2 WebSocket Event (emitted to web UI clients)

```typescript
// Added to WebEventMap in web-event-bus.ts:
'session.token_stream': {
  readonly label: number;
  readonly events: readonly TokenStreamEvent[];
};
```

Events are batched before emission to the WebSocket to avoid overwhelming clients at high token rates. A 50ms debounce window collects events and sends them as a single array.

### 3.3 JSON-RPC Subscription

To avoid flooding all WebSocket clients with high-frequency token data, clients must opt in via a JSON-RPC method:

```
// New methods added to MethodName:
'sessions.subscribeTokenStream'      // { label: number } — single session
'sessions.unsubscribeTokenStream'    // { label: number }
'sessions.subscribeAllTokenStreams'   // {} — all sessions (uses bus.subscribeAll)
'sessions.unsubscribeAllTokenStreams' // {}
```

Only subscribed clients receive `session.token_stream` events for that session. This is important because the Matrix rain visualization is an opt-in view, and most web UI tabs (Dashboard, Jobs, Escalations) do not need raw token data.

**Dispatch routing**: All four token stream methods use the `sessions.` prefix and are therefore routed to `sessionDispatch()` by the existing prefix-based router in `json-rpc-dispatch.ts`. Within `sessionDispatch()`, these methods delegate to a dedicated `tokenStreamDispatch()` helper (imported from `dispatch/token-stream-dispatch.ts`) rather than inlining the logic. The `subscribeAllTokenStreams` handler calls `bus.subscribeAll()` through the bridge; the per-session handlers call `bus.subscribe()`. This keeps the session dispatch module focused on CRUD operations and avoids bloating it with subscription-management state.

## 4. Component Architecture

```
                  ┌──────────────────────────────────────────────┐
                  │                    Daemon                     │
                  │                                              │
                  │   TokenStreamBus (singleton, created once)   │
                  │   ┌────────────────────────────────────┐     │
                  │   │ per-session: Map<SessionId, Set<L>> │     │
                  │   │ global:      Set<Listener>          │     │
                  │   └──────────────┬─────────────────────┘     │
                  │                  │                            │
                  │    ┌─────────────┼──────────────┐            │
                  │    │             │              │            │
                  │    ▼             ▼              ▼            │
                  │ Bridge     CLI observe    Future consumer    │
                  │ (batches,  (subscribe or (subscribeAll for   │
                  │  per-label  subscribeAll)  audit, etc.)      │
                  │  timers)                                     │
                  │    │                                         │
                  │    ▼                                         │
                  │ sendToSubscribers()                          │
                  │    │                                         │
                  │    ▼                                         │
                  │ Web UI SPA (subscribed clients only)         │
                  └──────┬─────────────────────────────┬────────┘
                         │ same bus ref                 │ same bus ref
            ┌────────────┴────────┐       ┌────────────┴────────┐
            │   MITM Proxy (A)    │       │   MITM Proxy (B)    │
            │                     │       │                     │
            │ Upstream LLM        │       │ Upstream LLM        │
            │   │                 │       │   │                 │
            │   ▼                 │       │   ▼                 │
            │ SseExtractor        │       │ SseExtractor        │
            │   │ push(sessA,..) │       │   │ push(sessB,..) │
            │   ▼                 │       │   ▼                 │
            │ Client Res          │       │ Client Res          │
            └─────────────────────┘       └─────────────────────┘
```

Each MITM proxy receives the same `TokenStreamBus` reference via `MitmProxyOptions`. Events from all sessions flow into the single bus, each tagged with its `sessionId`. Per-session consumers use `subscribe(sessionId, ...)` to receive events for a specific session; cross-cutting consumers use `subscribeAll(...)` to receive events from all sessions.

### 4.1 New Modules

| Module | Location | Responsibility |
|--------|----------|---------------|
| Token stream types | `src/docker/token-stream-types.ts` | `TokenStreamEvent` discriminated union, `TokenStreamListener` callback type |
| `TokenStreamBus` | `src/docker/token-stream-bus.ts` | Session-keyed pub/sub dispatcher with per-session and global listeners |
| `SseExtractorTransform` | `src/docker/sse-extractor.ts` | Transform stream: SSE line reassembly + provider-specific parsing |
| Token stream dispatch | `src/web-ui/dispatch/token-stream-dispatch.ts` | JSON-RPC subscribe/unsubscribe handlers |

### 4.2 Modified Modules

| Module | Change |
|--------|--------|
| `src/docker/mitm-proxy.ts` | Accept optional `TokenStreamBus` + `sessionId` in options; interpose `SseExtractorTransform` on SSE responses in `forwardRequest()` only |
| `src/docker/docker-infrastructure.ts` | Accept optional `TokenStreamBus` parameter; pass to `createMitmProxy` along with `sessionId` (bus is no longer created here) |
| `src/web-ui/web-event-bus.ts` | Add `session.token_stream` event to `WebEventMap` |
| `src/web-ui/web-ui-types.ts` | Add `sessions.subscribeTokenStream` and `sessions.unsubscribeTokenStream` to `MethodName` |
| `src/web-ui/dispatch/session-dispatch.ts` | Delegate `sessions.subscribeTokenStream` and `sessions.unsubscribeTokenStream` to `tokenStreamDispatch()` |
| `src/web-ui/web-ui-server.ts` | Add `sendToSubscribers()` method for targeted token stream delivery |
| `src/daemon/ironcurtain-daemon.ts` | Create `TokenStreamBus` singleton; pass to `prepareDockerInfrastructure()` and `TokenStreamBridge`; call `bus.endSession()` on session teardown |

## 5. Interface Definitions

### 5.1 TokenStreamBus

```typescript
// src/docker/token-stream-bus.ts

import type { SessionId } from '../session/types.js';
import type { TokenStreamEvent, TokenStreamListener } from './token-stream-types.js';

/**
 * Stateless pub/sub dispatcher for LLM token stream events.
 *
 * A single instance is created at daemon startup and shared across
 * all MITM proxies and consumers. The bus has no internal buffering --
 * events are delivered synchronously to current listeners and discarded
 * if none exist.
 *
 * The bus maintains two listener collections:
 * - Per-session: `Map<SessionId, Set<Listener>>` for consumers watching
 *   a specific session (web UI session view, CLI `observe <session>`)
 * - Global: `Set<Listener>` for consumers watching all sessions
 *   (CLI `observe --all`, future Matrix rain visualization)
 *
 * `push(sessionId, event)` dispatches to both the session-specific
 * listener set and the global listener set.
 *
 * Invariants:
 * - `subscribe()` and `subscribeAll()` return unsubscribe functions
 *   for RAII-style cleanup.
 * - Subscribers receive only live events from the point of subscription
 *   forward. There is no history or replay.
 * - Push never blocks or throws, even with zero subscribers.
 *
 * Lifecycle:
 * - Created once in the daemon, outlives individual sessions.
 * - Per-session cleanup is just `endSession(sessionId)` which removes
 *   the session's listener set.
 * - No bus creation/destruction tracking or registry needed.
 */
export interface TokenStreamBus {
  /**
   * Push an event to all listeners for the given session and all
   * global listeners. Discarded silently if no listeners exist.
   */
  push(sessionId: SessionId, event: TokenStreamEvent): void;

  /**
   * Subscribe to a single session's token stream.
   * The listener receives only live events from this point forward.
   *
   * @returns An unsubscribe function. Calling it removes the listener.
   */
  subscribe(sessionId: SessionId, listener: TokenStreamListener): () => void;

  /**
   * Subscribe to token stream events from all sessions.
   * The listener receives every event pushed to the bus,
   * regardless of session.
   *
   * @returns An unsubscribe function. Calling it removes the listener.
   */
  subscribeAll(listener: TokenStreamListener): () => void;

  /**
   * Signal that a session has ended. Removes the session's
   * per-session listener set.
   */
  endSession(sessionId: SessionId): void;
}

export function createTokenStreamBus(): TokenStreamBus;
```

### 5.2 SseExtractorTransform

```typescript
// src/docker/sse-extractor.ts

import { Transform, type TransformCallback } from 'node:stream';
import type { TokenStreamEvent } from './token-stream-types.js';

export type SseEventCallback = (event: TokenStreamEvent) => void;

/**
 * Provider-specific SSE parser selection.
 * The extractor uses the provider host to determine which parser to use.
 */
export type SseProvider = 'anthropic' | 'openai' | 'unknown';

/** Maximum length of a single SSE line buffer before truncation (1 MB). */
export const MAX_SSE_LINE_LENGTH = 1_048_576;

/**
 * A passthrough Transform stream that intercepts SSE data flowing
 * through the MITM proxy without modifying the forwarded bytes.
 *
 * Usage:
 *   upstreamRes.pipe(extractor).pipe(clientRes)
 *
 * The extractor reassembles SSE lines across chunk boundaries,
 * parses provider-specific event formats, and invokes the callback
 * with structured TokenStreamEvents.
 *
 * All data passes through unmodified. The extractor never drops,
 * delays, or modifies chunks. If parsing fails for any event,
 * a `raw` event is emitted and data continues to flow.
 *
 * Safety: The internal line buffer is capped at MAX_SSE_LINE_LENGTH
 * (1 MB). If a line exceeds this limit, the accumulated buffer is
 * truncated: the overlong content is discarded and a `raw` event
 * with `eventType: 'truncated'` is emitted. This prevents a
 * corrupted or malicious upstream from causing unbounded memory growth.
 *
 * When provider is `'unknown'`, all data still passes through to
 * the client unmodified, but no SSE parsing is attempted. Every
 * complete SSE line is emitted as a `raw` event with
 * `eventType: 'unknown_provider'`, preserving visibility without
 * risking incorrect semantic mapping.
 *
 * ERROR CONTRACT: `_transform()` must NEVER throw or call
 * `callback(err)`. The entire body is wrapped in a try/catch
 * that always calls `callback(null, chunk)`. A parsing bug must
 * never interrupt the forwarding path to the Docker container.
 * Errors in SSE parsing produce `raw` fallback events on the
 * side channel; the primary data path is unconditionally
 * pass-through.
 */
export class SseExtractorTransform extends Transform {
  constructor(provider: SseProvider, onEvent: SseEventCallback);

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void;
  _flush(callback: TransformCallback): void;
}
```

### 5.3 MitmProxyOptions Extension

```typescript
// Addition to MitmProxyOptions in src/docker/mitm-proxy.ts

export interface MitmProxyOptions {
  // ... existing fields ...

  /**
   * Shared daemon-level token stream bus. When provided together with
   * `sessionId`, the proxy taps SSE responses from LLM API endpoints
   * and pushes parsed token events into the bus, keyed by the session ID.
   *
   * The same bus instance is shared across all MITM proxies in the daemon.
   * Each proxy pushes events tagged with its own sessionId; consumers
   * filter on the bus to select which sessions they care about.
   *
   * Both fields must be provided together. If `tokenStreamBus` is set
   * without `sessionId` (or vice versa), `createMitmProxy()` throws.
   */
  readonly tokenStreamBus?: TokenStreamBus;

  /**
   * Session ID for token stream routing. Required when `tokenStreamBus`
   * is provided. The session ID is already available at construction time
   * (it is a parameter to `prepareDockerInfrastructure()`), so no mutable
   * setter is needed.
   */
  readonly sessionId?: SessionId;
}
```

The `MitmProxy` interface is unchanged -- no `setSessionId()` method is needed. The session ID is available at proxy construction time because `prepareDockerInfrastructure()` receives it as a parameter (line 81 of `docker-infrastructure.ts`). Passing it through `MitmProxyOptions` makes the association compile-time enforced and eliminates the temporal coupling of a mutable setter that "must be called before requests flow."

## 6. Token Stream Extraction (Tap Implementation)

### 6.1 Where to Tap

There are three `upstreamRes.pipe(clientRes)` call sites in `mitm-proxy.ts`:

| Line | Function | Purpose | Tapped? |
|------|----------|---------|---------|
| 464 | `forwardRequest()` | Provider API requests (Anthropic, OpenAI, Google) with credential swap | **Yes** |
| 667 | Plain HTTP proxy handler | Unencrypted HTTP forwarding for dynamically added domains | No |
| 924 | `forwardPassthrough()` | TLS-terminated passthrough for dynamically added domains | No |

Only the `forwardRequest()` path is tapped because it is the only path that carries LLM API traffic. The other two are passthrough paths for dynamically added domains -- they do not perform provider authentication, credential swap, or endpoint filtering, so they never carry streaming LLM responses. Tapping them would produce no useful events and add unnecessary overhead.

The tap point is in `forwardRequest()` inside `createMitmProxy()`, at the response handler for upstream LLM API requests (around line 461-464). Currently:

```typescript
clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
clientRes.flushHeaders();
clientRes.socket?.setNoDelay(true);
upstreamRes.pipe(clientRes);
```

With the tap:

```typescript
clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
clientRes.flushHeaders();
clientRes.socket?.setNoDelay(true);

const contentType = upstreamRes.headers['content-type'] ?? '';
if (tokenBus && sessionId && contentType.includes('text/event-stream')) {
  const provider = resolveProvider(targetHost);
  const extractor = new SseExtractorTransform(provider, (event) => {
    tokenBus.push(sessionId, event);
  });
  upstreamRes.pipe(extractor).pipe(clientRes);
} else {
  upstreamRes.pipe(clientRes);
}
```

Here `tokenBus` and `sessionId` are captured from `options.tokenStreamBus` and `options.sessionId` respectively at `createMitmProxy()` call time. Both are `readonly` and immutable for the proxy's lifetime.

The condition gates on:
1. A `TokenStreamBus` was provided in options (feature opt-in)
2. A `sessionId` was provided in options (proxy is associated with a session)
3. The response Content-Type is `text/event-stream` (SSE stream, not a regular JSON response)

Non-streaming responses (e.g., `/v1/messages/count_tokens`, `/api/hello`) flow through the existing direct pipe path with zero overhead.

### 6.2 SSE Parsing

Anthropic's streaming Messages API sends SSE with this format:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","model":"claude-sonnet-4-20250514",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}
```

OpenAI's format:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}

data: [DONE]
```

The `SseExtractorTransform` maintains a line buffer and a current event type. When it encounters a complete `data:` line, it:
1. Attempts to parse the JSON
2. Maps the provider-specific structure to a `TokenStreamEvent`
3. Invokes the callback
4. On parse failure, emits a `raw` event (no data loss)

**Line buffer safety**: The line buffer is capped at `MAX_SSE_LINE_LENGTH` (1 MB). If a line exceeds this limit (e.g., from a corrupted upstream or a response that does not use newlines), the accumulated buffer is discarded and a `raw` event with `eventType: 'truncated'` is emitted. The extractor then resumes scanning for the next newline. Data always passes through to the client unmodified regardless of truncation -- only the side-channel parsing is affected.

**Unknown provider behavior**: When the provider is `'unknown'`, the extractor still passes all data through unmodified, but no semantic SSE parsing is attempted. Complete SSE lines (terminated by `\n`) are emitted as `raw` events with `eventType: 'unknown_provider'`. This preserves visibility in the bus and web UI without risking incorrect semantic mapping to `text_delta` or `tool_use` events.

### 6.3 Chunked Transfer Encoding

HTTP chunked transfer encoding is handled transparently by Node.js's `http.IncomingMessage` -- the stream events deliver the decoded payload, not the raw chunked frames. The `Transform` stream receives clean SSE text, not `\r\nXX\r\n` chunk framing. No special handling is needed.

## 7. Token Stream Bus (Implementation)

### 7.1 Dispatcher

```typescript
export function createTokenStreamBus(): TokenStreamBus {
  const sessions = new Map<SessionId, Set<TokenStreamListener>>();
  const globalListeners = new Set<TokenStreamListener>();

  return {
    push(sessionId, event) {
      const listeners = sessions.get(sessionId);
      if (listeners) {
        for (const fn of listeners) fn(event);
      }
      for (const fn of globalListeners) fn(event);
    },

    subscribe(sessionId, listener) {
      let listeners = sessions.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        sessions.set(sessionId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) sessions.delete(sessionId);
      };
    },

    subscribeAll(listener) {
      globalListeners.add(listener);
      return () => { globalListeners.delete(listener); };
    },

    endSession(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
```

The entire implementation is ~20 lines. There is no buffering, no ring buffer, no per-session storage. Events are delivered synchronously to current listeners and discarded if none exist. The `Map<SessionId, Set<Listener>>` grows lazily as listeners subscribe and shrinks as they unsubscribe or sessions end. The `Set<Listener>` for global subscriptions exists for the lifetime of the bus.

Since all MITM proxies run in the same event loop as the daemon (they are not separate child processes), synchronous listener invocation is safe -- listeners must not perform blocking operations.

### 7.2 Backpressure

The bus does not apply backpressure to the proxy. The proxy must continue forwarding data to the Docker container regardless of consumer state. If a listener is slow, it receives events synchronously and any blocking would stall the event loop (which is why listeners must be non-blocking). For the WebSocket consumer, events are batched and sent asynchronously -- the listener callback only enqueues into a send buffer.

## 8. CLI Consumer (`ironcurtain observe`)

### 8.1 Architecture

The `observe` command connects to the running daemon via the existing control socket (Unix domain socket at `~/.ironcurtain/daemon.sock`) or via the WebSocket server if the web UI is enabled.

**Option A: WebSocket connection (recommended)** -- The CLI opens a WebSocket to the daemon's web UI server using the same auth token mechanism. It sends `sessions.subscribeTokenStream { label }` and receives `session.token_stream` events. This reuses existing infrastructure and requires no new transport.

**Option B: Control socket extension** -- Add a `sessions.observeTokenStream` method to the control socket protocol. This requires extending the control socket to support streaming responses, which is more complex.

We recommend Option A because the WebSocket infrastructure already supports push events and the CLI can render token deltas in real time.

### 8.2 CLI Rendering

```
ironcurtain observe 3           # single session by label
ironcurtain observe --all       # all active sessions
ironcurtain observe --workflow <name>  # all sessions in a workflow
```

The observe command:
1. **Single session** (`observe <label>`): resolves session label to check it exists and is active, opens a WebSocket to the daemon, sends `sessions.subscribeTokenStream { label }`, renders received `text_delta` events to stdout in real time
2. **All sessions** (`observe --all`): opens a WebSocket, sends `sessions.subscribeAllTokenStreams`, renders events from all sessions with a session-label prefix on each line
3. **Workflow** (`observe --workflow <name>`): uses the same `subscribeAllTokenStreams` mechanism but applies client-side filtering, only rendering events from sessions belonging to the named workflow. The bus is unaware of workflows; the CLI holds the filter predicate
4. Optionally supports `--raw` flag to show all event kinds (tool use, message boundaries)
5. Exits when the session ends (`session.ended` event), all workflow sessions end, or on Ctrl+C

### 8.3 Command Registration

```typescript
// Addition to CLI command registry
{
  command: 'observe [label]',
  description: 'Watch live LLM token output for running sessions',
  options: [
    { flag: '--all', description: 'Observe all active sessions' },
    { flag: '--workflow <name>', description: 'Observe all sessions in a workflow' },
    { flag: '--raw', description: 'Show all event types, not just text' },
    { flag: '--json', description: 'Output events as newline-delimited JSON' },
  ],
}
```

## 9. WebSocket Consumer (Web UI)

### 9.1 Subscription Flow

1. Web UI client opens the visualization view for session #3
2. Frontend sends JSON-RPC: `{ id: "...", method: "sessions.subscribeTokenStream", params: { label: 3 } }`
3. `sessionDispatch()` recognizes the `sessions.subscribeTokenStream` method and delegates to `tokenStreamDispatch()` (imported from `dispatch/token-stream-dispatch.ts`)
4. `tokenStreamDispatch()`:
   - Validates the session exists via `sessionManager.get(label)`
   - Resolves the session label to a `SessionId` via `managed.session.getInfo().id`
   - Registers the client+label in the `TokenStreamBridge` (increments refcount)
   - If this is the first client for this session, creates a bus subscription on the shared `TokenStreamBus`
   - Returns `{ ok: true }` to the client
5. When any MITM proxy pushes an event for that session's ID, the bridge's bus listener receives it, batches (50ms window), and calls `WebUiServer.sendToSubscribers()` for targeted delivery
6. `sendToSubscribers()` sends only to clients that have subscribed to that session's label -- `broadcast()` is never involved

### 9.2 Label-to-SessionId Translation

The `TokenStreamBus` is keyed by `SessionId` (a branded UUID), but the WebSocket protocol and CLI use `label` (an integer). The translation happens in the dispatch handler, which has access to `SessionManager`:

```typescript
// In token-stream-dispatch.ts
const managed = ctx.sessionManager.get(label);
if (!managed) throw new SessionNotFoundError(label);
const sessionId = managed.session.getInfo().id;
```

The bridge maintains a bidirectional mapping so it can route bus events (keyed by `SessionId`) back to WebSocket frames (keyed by `label`):

```typescript
// In TokenStreamBridge
private readonly sessionToLabel = new Map<SessionId, number>();
private readonly labelToSession = new Map<number, SessionId>();
```

These maps are populated when the first client subscribes to a session and cleaned up when the last client unsubscribes or the session ends.

### 9.3 Per-Client Subscription Tracking and Reference Counting

The `TokenStreamBridge` owns both per-client tracking and bus subscription lifecycle. It takes the single shared `TokenStreamBus` instance in its constructor and subscribes to sessions on demand. It tracks which clients are subscribed to which sessions, and reference-counts the bus subscriptions so that a single bus listener is shared across all WebSocket clients watching the same session.

```typescript
// In TokenStreamBridge
interface SessionSubscription {
  readonly sessionId: SessionId;
  readonly unsubscribe: () => void;  // bus unsubscribe handle
  readonly clients: Set<WsWebSocket>;
}

private readonly subscriptions = new Map<number, SessionSubscription>();
private readonly clientSubscriptions = new Map<WsWebSocket, Set<number>>();
```

**Bridge construction**: The bridge takes the shared bus instance as a constructor parameter. It does not subscribe to the bus globally -- it creates per-session subscriptions on demand when the first client subscribes to a given session label. This means the bridge receives only the events it has clients for, not all events from all sessions.

**Subscribe**: `bridge.addClient(client, label, sessionId)` adds the client to `subscriptions[label].clients`. If this is the first client for this label, it also calls `bus.subscribe(sessionId, listener)` and stores the unsubscribe handle. The listener batches events and calls `server.sendToSubscribers(label, frame)`.

**Unsubscribe**: `bridge.removeClient(client, label)` removes the client from `subscriptions[label].clients`. If the client set becomes empty, it calls the stored unsubscribe handle to detach from the bus, cancels any pending batch timer for that label, and removes the subscription entry.

**Client disconnect**: `bridge.removeAllForClient(client)` iterates `clientSubscriptions[client]` and calls `removeClient(client, label)` for each. This is called from `WebUiServer`'s existing `ws.on('close')` handler.

### 9.4 Targeted Delivery (Open/Closed Principle)

The generic `broadcast()` method in `WebUiServer` is **not modified**. Instead, a new `sendToSubscribers()` method handles targeted delivery for token stream events:

```typescript
// In WebUiServer
sendToSubscribers(clients: ReadonlySet<WsWebSocket>, event: string, payload: unknown): void {
  const frame: EventFrame = { event, payload, seq: ++this.eventSeq };
  const data = JSON.stringify(frame);
  for (const client of clients) {
    if (client.readyState === WsWebSocket.OPEN) {
      client.send(data);
    }
  }
}
```

The bridge calls `sendToSubscribers()` directly with the set of clients from `subscriptions[label].clients`, bypassing the event bus entirely for token stream delivery. This keeps `broadcast()` generic and avoids special-casing in the broadcast loop. The `session.token_stream` event type is still registered in `WebEventMap` for type safety, but delivery goes through the targeted path.

### 9.5 Event Batching and Timer Lifecycle

The bridge batches events to avoid overwhelming WebSocket clients. At high token rates (Claude can produce ~100 tokens/second), sending individual events would create 100 WebSocket frames per second per subscribed client.

```typescript
class TokenStreamBridge {
  private pending = new Map<number, TokenStreamEvent[]>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * @param server - WebUiServer for targeted delivery via sendToSubscribers()
   * @param bus - The single shared TokenStreamBus from the daemon.
   *              The bridge subscribes per-session on demand, not globally.
   * @param flushIntervalMs - Batching window (default 50ms)
   */
  constructor(
    private readonly server: WebUiServer,
    private readonly bus: TokenStreamBus,
    private readonly flushIntervalMs = 50,
  ) {}

  enqueue(label: number, event: TokenStreamEvent): void {
    let batch = this.pending.get(label);
    if (!batch) {
      batch = [];
      this.pending.set(label, batch);
    }
    batch.push(event);
    this.scheduleFlush(label);
  }

  private scheduleFlush(label: number): void {
    if (this.timers.has(label)) return;
    this.timers.set(label, setTimeout(() => {
      this.timers.delete(label);
      const events = this.pending.get(label);
      if (!events?.length) return;
      this.pending.delete(label);

      const sub = this.subscriptions.get(label);
      if (!sub || sub.clients.size === 0) return; // session ended or no clients
      this.server.sendToSubscribers(
        sub.clients,
        'session.token_stream',
        { label, events },
      );
    }, this.flushIntervalMs));
  }

  /**
   * Clean up all state for a session: cancel pending timers,
   * discard buffered events, unsubscribe from the bus, and
   * remove all tracking entries.
   *
   * Called when the session ends (from `session.ended` event handler
   * on the WebEventBus) or when the last client unsubscribes.
   */
  closeSession(label: number): void {
    const timer = this.timers.get(label);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(label);
    }
    this.pending.delete(label);

    const sub = this.subscriptions.get(label);
    if (sub) {
      sub.unsubscribe(); // detach from TokenStreamBus
      // Clean up per-client tracking for all clients of this session
      for (const client of sub.clients) {
        this.clientSubscriptions.get(client)?.delete(label);
      }
      this.subscriptions.delete(label);
    }
    this.sessionToLabel.delete(this.labelToSession.get(label) as SessionId);
    this.labelToSession.delete(label);
  }

  /** Shut down the entire bridge (daemon shutdown). */
  close(): void {
    for (const [label] of this.subscriptions) {
      this.closeSession(label);
    }
  }
}
```

At 50ms intervals, this produces ~20 WebSocket frames/second, each containing 5 events on average. This is well within browser rendering budgets and provides sub-100ms perceived latency.

**Timer safety**: Each label gets its own timer (stored in `this.timers`). When a session ends, `closeSession(label)` cancels the pending timer and discards buffered events, preventing callbacks from firing against a dead session. The daemon wires `closeSession()` to the `session.ended` event:

```typescript
// In daemon wiring
eventBus.subscribe((event, payload) => {
  if (event === 'session.ended') {
    bridge.closeSession((payload as { label: number }).label);
  }
});
```

## 10. Lifecycle

### 10.1 Bus Creation (Daemon Startup)

```
daemon.start()
  ├── creates TokenStreamBus (singleton for the daemon's lifetime)
  ├── creates WebUiServer
  └── creates TokenStreamBridge(server, bus)
      └── subscribes to eventBus for 'session.ended' → bridge.closeSession()
```

The bus is created once at daemon startup and outlives all individual sessions. There is no bus creation/destruction tracking or registry. The same bus instance is passed to every `prepareDockerInfrastructure()` call and to the `TokenStreamBridge`.

### 10.2 Session Creation (Bus Wiring)

```
prepareDockerInfrastructure(config, mode, ..., sessionId, tokenStreamBus?)
  ├── receives the shared TokenStreamBus from the daemon (optional parameter)
  ├── creates MitmProxy with { tokenStreamBus: bus, sessionId }
  │   (sessionId is already a parameter to this function -- line 81)
  └── returns DockerInfrastructure (no tokenStreamBus field needed --
      the daemon already holds the reference)

MitmProxy.start()
  └── SSE responses now push to the shared bus automatically
      (no separate setSessionId() call needed)
```

### 10.3 Consumer Connection

```
// Web UI session view path:
sessions.subscribeTokenStream { label: N }
  └── sessionDispatch() delegates to tokenStreamDispatch():
      ├── sessionManager.get(N) → managed
      ├── managed.session.getInfo().id → sessionId (label→SessionId translation)
      └── bridge.addClient(wsClient, N, sessionId)
          └── if first client for N: bus.subscribe(sessionId, listener)

sessions.unsubscribeTokenStream { label: N }
  └── bridge.removeClient(wsClient, N)
      └── if last client for N: bus unsubscribe + cancel timers

// CLI observe single session:
ironcurtain observe N
  └── WS connect to daemon
      └── send sessions.subscribeTokenStream { label: N }
          └── receives session.token_stream events

// CLI observe all sessions or workflow:
ironcurtain observe --all
  └── WS connect to daemon
      └── send sessions.subscribeAllTokenStreams
          └── bridge calls bus.subscribeAll(listener)
              └── receives events from all sessions; renders with label prefix

ironcurtain observe --workflow <name>
  └── WS connect to daemon
      └── send sessions.subscribeAllTokenStreams
          └── bridge calls bus.subscribeAll(listener)
              └── CLI applies client-side filter for workflow membership
```

### 10.4 Stream Teardown

```
DockerAgentSession.close()
  └── mitmProxy.stop()
      └── SseExtractorTransform streams end naturally (no more push() calls)

SessionManager.end(label)
  └── eventBus.emit('session.ended', { label, reason })
      ├── bridge.closeSession(label)
      │   ├── cancels pending batch timer for this label
      │   ├── discards buffered events
      │   ├── calls bus unsubscribe handle
      │   └── cleans up per-client tracking and label↔sessionId maps
      └── clients receive session.ended, stop expecting token events

daemon calls bus.endSession(sessionId)
  └── removes per-session listener set (defense-in-depth)
  (the bus itself continues running for other sessions;
   global listeners are not affected by endSession)
```

The teardown order matters: the bridge's `closeSession()` fires first (via the `session.ended` event), which cancels the pending timer before the bus removes its listener set. This prevents the timer callback from firing and trying to emit to a dead session. The bus's `endSession()` call is a safety net that removes any per-session listeners not already cleaned up. Global listeners are unaffected -- they continue receiving events from other sessions.

### 10.5 prepareDockerInfrastructure Signature Change

```typescript
// Updated signature in docker-infrastructure.ts
export async function prepareDockerInfrastructure(
  config: IronCurtainConfig,
  mode: SessionMode & { kind: 'docker' },
  sessionDir: string,
  sandboxDir: string,
  escalationDir: string,
  auditLogPath: string,
  sessionId: string,
  tokenStreamBus?: TokenStreamBus,  // new optional parameter
): Promise<DockerInfrastructure>;
```

The `DockerInfrastructure` interface does **not** gain a `tokenStreamBus` field. The daemon already holds the bus reference -- passing it through the infrastructure return type would create a redundant ownership path. The bus flows into the MITM proxy via options and that is the only direction it needs to flow.

## 11. Extension Points

1. **New consumers**: Any code with a reference to the shared `TokenStreamBus` can subscribe to any session's stream. The bus interface is minimal and consumer-agnostic.

2. **Workflow-level observation**: A workflow observer uses `subscribeAll()` and applies client-side filtering by workflow membership. When the workflow engine launches a new session, its events automatically appear to the global listener -- no re-subscription or bus-swapping needed. Alternatively, the observer can use per-session `subscribe()` calls for each known session in the workflow. The bus is unaware of workflows; the filtering predicate lives entirely in the consumer.

3. **New providers**: Adding a Google streaming parser requires implementing a new case in `SseExtractorTransform` that handles Google's newline-delimited JSON format. The `SseProvider` union type is extended with `'google'`.

4. **Persistent recording**: A future audit consumer could subscribe to the bus and write events to a JSONL file for offline analysis. Since the bus delivers only live events, the recorder would capture the stream from the point it subscribes forward.

5. **Token counting**: The `message_end` event includes `inputTokens` and `outputTokens`, which could feed into the `ResourceBudgetTracker` for Docker sessions (currently `tokenTrackingAvailable: false`).

6. **Multiple visualizations**: The web UI could show different views of the same stream (raw terminal, Matrix rain, structured timeline) by subscribing multiple frontend components to the same `session.token_stream` WebSocket event.

## 12. Testing Strategy

### 12.1 Unit Tests

**SseExtractorTransform** (`test/sse-extractor.test.ts`):
- Feed Anthropic SSE format, verify correct `TokenStreamEvent` sequence
- Feed OpenAI SSE format, verify correct events
- Feed chunks that split SSE lines mid-line, verify reassembly
- Feed malformed JSON, verify `raw` fallback event
- Verify all data passes through unmodified (compare input/output buffers)
- Feed non-SSE content type, verify no events emitted and data passes through
- Feed a line exceeding `MAX_SSE_LINE_LENGTH`, verify `raw` event with `eventType: 'truncated'` and data passthrough continues
- Feed with `provider: 'unknown'`, verify all lines emitted as `raw` with `eventType: 'unknown_provider'`
- **Error contract**: mock `onEvent` callback to throw, verify `_transform()` still calls `callback(null, chunk)` and data passes through unmodified

**TokenStreamBus** (`test/token-stream-bus.test.ts`):
- Subscribe before push, verify live delivery
- Push with no subscribers, verify no error (fire-and-forget)
- `endSession()` removes per-session listeners; subsequent push is silent
- Multiple listeners on same session all receive events
- Listener unsubscribe removes only that listener
- Unsubscribe last listener for a session, verify session entry is cleaned up
- **Multi-session isolation**: push to session A does not invoke session B's per-session listener
- **`subscribeAll()` receives events from all sessions**: push to session A and session B, verify the global listener receives both
- **`subscribeAll()` combined with per-session**: push to session A, verify both the per-session listener and the global listener receive the event
- **`subscribeAll()` unsubscribe**: verify calling the unsubscribe function removes only that global listener
- **`endSession()` does not affect global listeners**: end session A, push to session B, verify the global listener still receives events

**TokenStreamBridge** (`test/token-stream-bridge.test.ts`):
- Subscribe two clients to the same session, verify both receive events
- Disconnect one client, verify the other still receives events (refcount > 0)
- Disconnect last client for a session, verify bus listener is unsubscribed
- `closeSession()` cancels pending timer and discards buffered events
- `closeSession()` during active timer, verify callback does not fire
- `removeAllForClient()` cleans up all of a client's subscriptions
- Label-to-SessionId mapping is populated on first subscribe and cleaned up on close

### 12.2 Integration Tests

**MITM proxy with tap** (`test/mitm-proxy-token-stream.test.ts`):
- Stub an upstream HTTPS server that sends SSE responses
- Create MITM proxy with `{ tokenStreamBus: bus, sessionId }` in options
- Send a request through the proxy
- Verify the response reaches the client unmodified
- Verify the bus received parsed events keyed by the correct sessionId
- Verify non-SSE responses do not produce events
- **Shared bus, multiple proxies**: create two MITM proxies sharing the same bus with different session IDs, verify events from each proxy are keyed correctly and do not cross-contaminate

### 12.3 Dependency Substitution

The `TokenStreamBus` interface enables clean test doubles. Tests for the daemon bridge can use a mock bus that emits controlled event sequences. Tests for the web UI dispatch can verify subscription management without a real MITM proxy. The `sendToSubscribers()` method on `WebUiServer` can be tested independently of `broadcast()`.

## 13. Migration Plan

### Phase 1: Core infrastructure (no consumer changes)

1. Add `TokenStreamEvent` and `TokenStreamListener` types to `src/docker/token-stream-types.ts`
2. Implement `createTokenStreamBus()` in `src/docker/token-stream-bus.ts` (pure pub/sub dispatcher with per-session and global listener sets, ~20 lines)
3. Implement `SseExtractorTransform` in `src/docker/sse-extractor.ts` (with `MAX_SSE_LINE_LENGTH` guard, `'unknown'` provider handling, and the error contract: `_transform()` wraps entire body in try/catch, always calls `callback(null, chunk)`)
4. Unit tests for both modules

### Phase 2: MITM proxy integration

1. Add `tokenStreamBus` and `sessionId` to `MitmProxyOptions` (with validation that both must be provided together)
2. Interpose `SseExtractorTransform` in `forwardRequest()` when both are present (line 464 only -- the other two pipe sites are passthrough paths)
3. Integration test with stubbed upstream

### Phase 3: Daemon wiring (shared bus)

1. Create `TokenStreamBus` **once** in the daemon at startup (not per-session, not in `prepareDockerInfrastructure()`)
2. Add optional `tokenStreamBus` parameter to `prepareDockerInfrastructure()` signature
3. Daemon passes the shared bus to `prepareDockerInfrastructure()` which passes `{ tokenStreamBus: bus, sessionId }` to `createMitmProxy()`
4. `DockerInfrastructure` does **not** gain a `tokenStreamBus` field -- the daemon already holds the reference
5. Call `bus.endSession(sessionId)` in session teardown (defense-in-depth; clears per-session listener set)

### Phase 4: WebSocket consumer

1. Add `session.token_stream` to `WebEventMap`
2. Add `sendToSubscribers()` method to `WebUiServer` (no changes to `broadcast()`)
3. Add `sessions.subscribeTokenStream`, `sessions.unsubscribeTokenStream`, `sessions.subscribeAllTokenStreams`, and `sessions.unsubscribeAllTokenStreams` to `MethodName`
4. Implement `token-stream-dispatch.ts` (label-to-SessionId resolution via `sessionManager.get(label).session.getInfo().id` for per-session methods; `bus.subscribeAll()` via bridge for global methods)
5. Add delegation in `sessionDispatch()` to `tokenStreamDispatch()` for the four new methods
6. Implement `TokenStreamBridge` with per-label timers, reference counting, global subscription support, and `closeSession()` cleanup. Bridge constructor takes the shared bus instance.
7. Wire bridge to `session.ended` event for timer cleanup
8. Wire client disconnect to `bridge.removeAllForClient()`

### Phase 5: CLI observe command

1. Implement `observe <label>` subcommand (single session) -- WebSocket client that sends `sessions.subscribeTokenStream` and renders to stdout
2. Implement `observe --all` -- sends `sessions.subscribeAllTokenStreams`, which triggers `bus.subscribeAll()` in the bridge, renders events from all sessions with label prefix
3. Implement `observe --workflow <name>` -- same `subscribeAll` mechanism with client-side filtering by workflow membership
4. Manual testing with live Docker sessions

## 14. Security Considerations

1. **No credential leakage** -- The tap intercepts the *response* stream from the LLM, not the request stream. API keys are in request headers, not response bodies. The `SseExtractorTransform` never sees credentials.

2. **Auth-gated access** -- Both the WebSocket server and control socket require authentication. The `observe` CLI command must provide a valid auth token to connect. There is no unauthenticated path to the token stream.

3. **No cross-session leakage** -- Although all sessions share a single `TokenStreamBus`, per-session subscription requires a valid session label resolved through the `SessionManager`. The bus is keyed by `SessionId` (a branded UUID), and the bridge only subscribes to specific session IDs on behalf of authenticated clients. A client cannot subscribe to a session they cannot see through the existing `sessions.list` method. The `subscribeAll()` method delivers events from all sessions, but is gated behind the same authenticated WebSocket connection -- only authenticated daemon clients (CLI `observe --all`, web UI) can use it. There is no unauthenticated global broadcast.

4. **Memory safety** -- The bus holds no event data; it is a pure dispatcher. Memory consumption is bounded by the number of active listeners, which is proportional to the number of connected consumers (not event volume). Ended sessions have their listener sets removed immediately. The SSE line buffer is capped at 1 MB (`MAX_SSE_LINE_LENGTH`) to prevent a corrupted or malicious upstream from causing unbounded memory growth in the extractor.

5. **Content sensitivity** -- The token stream may contain sensitive data (the LLM's reasoning about user tasks). This is the same data the agent already sees inside the Docker container, and the same data visible in the audit log. The web UI already displays conversation history and diagnostic events. The token stream adds real-time visibility but does not expose new categories of information.
