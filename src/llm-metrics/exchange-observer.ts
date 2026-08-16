import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { CompletionEndpoint } from '../docker/llm-observation/completion-endpoint.js';
import type {
  ObservationConsumerDetached,
  ResponseObservationConsumer,
} from '../docker/llm-observation/response-observation-hub.js';
import { DEFAULT_SSE_EVENT_FRAMER_LIMITS, type SseEventFrame } from '../docker/llm-observation/sse-event-framer.js';
import type {
  GatewayResponseHeaders,
  IdentitySource,
  LlmExchangeAttribution,
  LlmExchangeCompleted,
  LlmExchangeRoute,
  LlmGatewayAdapter,
  LlmProtocolAdapter,
  LlmRequestFacts,
  TransportAttempt,
} from './types.js';

const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface LlmMetricsExchangeObserverOptions {
  readonly endpoint: CompletionEndpoint;
  readonly attribution: LlmExchangeAttribution;
  readonly route: LlmExchangeRoute;
  readonly protocolAdapter: LlmProtocolAdapter;
  readonly gatewayAdapter: LlmGatewayAdapter;
  readonly requestPath: string;
  readonly onCompleted: (exchange: LlmExchangeCompleted) => void;
  readonly exchangeId?: string;
}

export interface LlmTransportAttemptHandle {
  complete(attempt: Omit<TransportAttempt, 'ordinal' | 'startedOffsetMs' | 'endedOffsetMs'>): void;
}

function emptyRequestFacts(): LlmRequestFacts {
  return {
    requestedModel: null,
    streaming: null,
    requestedServiceTier: null,
    reasoningMode: 'unknown',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    speedMode: null,
    qualityFlags: ['request_facts_missing'],
  };
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function identitySource(value: string | null, present: IdentitySource): IdentitySource {
  return value === null ? 'not_exposed' : present;
}

/** One content-free observation lifecycle for one completion HTTP request. */
export class LlmMetricsExchangeObserver {
  readonly exchangeId: string;
  private readonly startedAtWall = new Date();
  private readonly startedAtMono = performance.now();
  private readonly protocol;
  private readonly gateway;
  private readonly flags = new Set<string>();
  private readonly transportAttempts: TransportAttempt[] = [];
  private readonly pendingTransportAttempts = new Map<number, number>();
  private nextTransportAttemptOrdinal = 1;
  private originalRequest = emptyRequestFacts();
  private forwardedRequest = emptyRequestFacts();
  private responseStatus: number | null = null;
  private requestBodyCompleteOffsetMs: number | null = null;
  private responseHeadersOffsetMs: number | null = null;
  private firstUpstreamBodyByteOffsetMs: number | null = null;
  private firstProtocolEventOffsetMs: number | null = null;
  private firstReasoningEventOffsetMs: number | null = null;
  private lastReasoningEventOffsetMs: number | null = null;
  private firstOutputEventOffsetMs: number | null = null;
  private lastOutputEventOffsetMs: number | null = null;
  private protocolTerminalOffsetMs: number | null = null;
  private upstreamResponseEndOffsetMs: number | null = null;
  private clientDeliveryEndOffsetMs: number | null = null;
  private clientAborted = false;
  private observationEnded = false;
  private finalized = false;
  private jsonChunks: Buffer[] = [];
  private jsonBytes = 0;

  constructor(private readonly options: LlmMetricsExchangeObserverOptions) {
    this.exchangeId = options.exchangeId ?? randomUUID();
    this.protocol = options.protocolAdapter.createAccumulator();
    this.gateway = options.gatewayAdapter.createAccumulator();
  }

  observeOriginalRequest(bytes: Buffer): void {
    this.originalRequest = this.inspectRequest(bytes, 'original_request_parse_failed');
  }

  observeUnchangedRequest(bytes: Buffer): void {
    const facts = this.inspectRequest(bytes, 'request_parse_failed');
    this.originalRequest = facts;
    this.forwardedRequest = facts;
  }

  observeForwardedRequest(bytes: Buffer): void {
    this.forwardedRequest = this.inspectRequest(bytes, 'forwarded_request_parse_failed');
  }

  markRequestBodyComplete(): void {
    this.requestBodyCompleteOffsetMs ??= this.offset();
  }

  /** Capture attempt start separately so auth retries retain honest timing. */
  beginTransportAttempt(): LlmTransportAttemptHandle {
    const ordinal = this.nextTransportAttemptOrdinal++;
    const startedOffsetMs = this.offset();
    this.pendingTransportAttempts.set(ordinal, startedOffsetMs);
    let completed = false;
    return {
      complete: (attempt): void => {
        if (completed || !this.pendingTransportAttempts.has(ordinal)) return;
        completed = true;
        this.pendingTransportAttempts.delete(ordinal);
        this.transportAttempts.push({ ordinal, startedOffsetMs, endedOffsetMs: this.offset(), ...attempt });
      },
    };
  }

  markQualityFlag(flag: string): void {
    if (!this.finalized) this.flags.add(flag);
  }

  observeResponseHeaders(status: number, headers: GatewayResponseHeaders): void {
    this.responseStatus = status;
    this.responseHeadersOffsetMs ??= this.offset();
    this.protocol.observeResponseHeaders(headers);
    this.gateway.observeHeaders(headers);
  }

  markFirstUpstreamBodyByte(): void {
    this.firstUpstreamBodyByteOffsetMs ??= this.offset();
  }

  responseConsumer(streaming: boolean): ResponseObservationConsumer {
    return {
      id: `llm-metrics:${this.exchangeId}`,
      maxDecodedBytes: streaming ? DEFAULT_SSE_EVENT_FRAMER_LIMITS.maxStreamBytes : MAX_JSON_RESPONSE_BYTES,
      maxSseEvents: 100_000,
      ...(streaming
        ? { onSseEvent: (frame: SseEventFrame) => this.observeSseEvent(frame) }
        : { onDecodedChunk: (chunk: Buffer) => this.observeJsonChunk(chunk) }),
      onEnd: () => this.endObservation(streaming),
      onDetach: (detached: ObservationConsumerDetached) => {
        this.flags.add(detached.reason);
        this.observationEnded = true;
        this.tryFinalize();
      },
    };
  }

  markUpstreamResponseEnd(): void {
    this.upstreamResponseEndOffsetMs ??= this.offset();
    this.tryFinalize();
  }

  /** Settle a proxy-generated response for which no upstream body is observed. */
  markObservationUnavailable(status: number | null, reason: string): void {
    if (this.finalized) return;
    this.responseStatus = status;
    this.flags.add(reason);
    this.observationEnded = true;
    this.upstreamResponseEndOffsetMs ??= this.offset();
    this.tryFinalize();
  }

  /** Detach response parsing while retaining the real upstream settlement boundary. */
  markResponseObservationUnavailable(status: number | null, reason: string): void {
    if (this.finalized) return;
    this.responseStatus = status;
    this.flags.add(reason);
    this.observationEnded = true;
    this.tryFinalize();
  }

  markClientDeliveryEnd(aborted: boolean): void {
    this.clientDeliveryEndOffsetMs ??= this.offset();
    this.clientAborted ||= aborted;
    if (aborted) this.settlePendingTransportAttempts('aborted');
    this.tryFinalize();
  }

  abort(reason: string): void {
    this.flags.add(reason);
    this.clientAborted = true;
    this.observationEnded = true;
    this.upstreamResponseEndOffsetMs ??= this.offset();
    this.clientDeliveryEndOffsetMs ??= this.offset();
    this.settlePendingTransportAttempts('aborted');
    this.tryFinalize();
  }

  private settlePendingTransportAttempts(outcome: TransportAttempt['outcome']): void {
    const endedOffsetMs = this.offset();
    for (const [ordinal, startedOffsetMs] of this.pendingTransportAttempts) {
      this.transportAttempts.push({ ordinal, startedOffsetMs, endedOffsetMs, responseStatus: null, outcome });
    }
    this.pendingTransportAttempts.clear();
  }

  private inspectRequest(bytes: Buffer, failureFlag: string): LlmRequestFacts {
    try {
      return this.options.protocolAdapter.inspectRequest(parseJson(bytes), { path: this.options.requestPath });
    } catch {
      this.flags.add(failureFlag);
      return emptyRequestFacts();
    }
  }

  private observeSseEvent(frame: SseEventFrame): void {
    const now = this.offset();
    this.firstProtocolEventOffsetMs ??= now;
    let data: unknown = frame.dataUtf8;
    if (frame.dataUtf8 !== '[DONE]') {
      try {
        data = JSON.parse(frame.dataUtf8) as unknown;
      } catch {
        this.flags.add('malformed_sse_json');
        return;
      }
    }
    const phase = this.protocol.observeStreamEvent({ eventType: frame.eventType || undefined, data });
    this.gateway.observePayload(data);

    if (phase === 'reasoning') {
      this.firstReasoningEventOffsetMs ??= now;
      this.lastReasoningEventOffsetMs = now;
    } else if (phase === 'output') {
      this.firstOutputEventOffsetMs ??= now;
      this.lastOutputEventOffsetMs = now;
    }
    if (this.protocol.isProtocolTerminal()) this.protocolTerminalOffsetMs ??= now;
  }

  private observeJsonChunk(chunk: Buffer): void {
    if (this.jsonBytes + chunk.length > MAX_JSON_RESPONSE_BYTES) {
      this.flags.add('json_response_limit');
      this.jsonChunks = [];
      this.jsonBytes = MAX_JSON_RESPONSE_BYTES + 1;
      return;
    }
    if (this.jsonBytes > MAX_JSON_RESPONSE_BYTES) return;
    this.jsonChunks.push(chunk);
    this.jsonBytes += chunk.length;
  }

  private endObservation(streaming: boolean): void {
    if (!streaming && this.jsonBytes <= MAX_JSON_RESPONSE_BYTES) {
      try {
        const payload = parseJson(Buffer.concat(this.jsonChunks, this.jsonBytes));
        this.protocol.observeJsonResponse(payload);
        this.gateway.observePayload(payload);
        const now = this.offset();
        this.firstProtocolEventOffsetMs ??= now;
      } catch {
        this.flags.add('malformed_json_response');
      }
    }
    this.jsonChunks = [];
    const protocol = this.protocol.snapshot();
    if (protocol.protocolTerminal) this.protocolTerminalOffsetMs ??= this.offset();
    this.observationEnded = true;
    this.tryFinalize();
  }

  private tryFinalize(): void {
    if (
      this.finalized ||
      !this.observationEnded ||
      this.upstreamResponseEndOffsetMs === null ||
      this.clientDeliveryEndOffsetMs === null
    ) {
      return;
    }
    this.finalized = true;
    const protocol = this.protocol.snapshot();
    const gateway = this.gateway.snapshot(protocol);
    const usage = gateway.costUsd === null ? protocol.usage : { ...protocol.usage, costUsd: gateway.costUsd };
    const errorStatus = this.responseStatus !== null && this.responseStatus >= 400;
    const outcome = {
      ...protocol.outcome,
      responseStatus: this.responseStatus,
      ...(errorStatus && protocol.outcome.termination === 'unknown' ? { termination: 'error' as const } : {}),
      ...(this.clientAborted ? { termination: 'aborted' as const } : {}),
    };
    const forwardedModel = this.forwardedRequest.requestedModel;
    const responseModel = protocol.responseModel;
    for (const flag of [
      ...this.originalRequest.qualityFlags,
      ...this.forwardedRequest.qualityFlags,
      ...protocol.qualityFlags,
      ...protocol.usage.qualityFlags,
      ...gateway.qualityFlags,
    ]) {
      this.flags.add(flag);
    }

    this.options.onCompleted(
      Object.freeze({
        schemaVersion: 1,
        exchangeId: this.exchangeId,
        attribution: this.options.attribution,
        route: this.options.route,
        identity: {
          requestedModel: {
            value: this.originalRequest.requestedModel,
            source: identitySource(this.originalRequest.requestedModel, 'request'),
          },
          forwardedModel: {
            value: forwardedModel,
            source: identitySource(forwardedModel, 'forwarded_request'),
          },
          responseModel: {
            value: responseModel,
            source: identitySource(responseModel, 'protocol_response'),
          },
          servedModel: gateway.servedModel,
          servedProvider: gateway.servedProvider,
        },
        responseMetadata: {
          providerRequestId: protocol.providerRequestId,
          providerResponseId: protocol.providerResponseId,
          gatewayGenerationId: gateway.generationId,
          actualServiceTier: protocol.actualServiceTier,
        },
        request: this.originalRequest,
        outcome,
        usage,
        timing: {
          requestReceivedAt: this.startedAtWall.toISOString(),
          requestBodyCompleteOffsetMs: this.requestBodyCompleteOffsetMs,
          responseHeadersOffsetMs: this.responseHeadersOffsetMs,
          firstUpstreamBodyByteOffsetMs: this.firstUpstreamBodyByteOffsetMs,
          firstProtocolEventOffsetMs: this.firstProtocolEventOffsetMs,
          firstReasoningEventOffsetMs: this.firstReasoningEventOffsetMs,
          lastReasoningEventOffsetMs: this.lastReasoningEventOffsetMs,
          firstOutputEventOffsetMs: this.firstOutputEventOffsetMs,
          lastOutputEventOffsetMs: this.lastOutputEventOffsetMs,
          protocolTerminalOffsetMs: this.protocolTerminalOffsetMs,
          upstreamResponseEndOffsetMs: this.upstreamResponseEndOffsetMs,
          clientDeliveryEndOffsetMs: this.clientDeliveryEndOffsetMs,
          clientAborted: this.clientAborted,
        },
        transportAttempts: Object.freeze(
          [...this.transportAttempts].sort((left, right) => left.ordinal - right.ordinal),
        ),
        gatewayRouteAttempts: gateway.routeAttempts,
        qualityFlags: Object.freeze([...this.flags].sort()),
      }),
    );
  }

  private offset(): number {
    return Math.max(0, performance.now() - this.startedAtMono);
  }
}
