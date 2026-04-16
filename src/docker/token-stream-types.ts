/**
 * Types for LLM token stream extraction from the MITM proxy.
 *
 * These types define the structured events emitted by the SSE
 * extractor and consumed by the TokenStreamBus and its listeners.
 */

import type { SessionId } from '../session/types.js';

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
      readonly kind: 'tool_result';
      readonly toolUseId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError: boolean;
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
 * The sessionId identifies which session produced the event,
 * enabling global listeners to distinguish between sessions.
 */
export type TokenStreamListener = (sessionId: SessionId, event: TokenStreamEvent) => void;

/**
 * Provider-specific SSE parser selection.
 * The extractor uses the provider host to determine which parser to use.
 */
export type SseProvider = 'anthropic' | 'openai' | 'unknown';

/**
 * Callback invoked by the SseExtractorTransform for each parsed event.
 * Unlike TokenStreamListener, this does not include a sessionId --
 * the extractor operates on a single stream and the bus handles routing.
 */
export type SseEventCallback = (event: TokenStreamEvent) => void;
