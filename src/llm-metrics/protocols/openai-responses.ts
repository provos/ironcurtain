import { asKnownString, asRecord } from '../normalization.js';
import type {
  LlmProtocolAccumulator,
  LlmProtocolAdapter,
  LlmProtocolObservation,
  LlmRequestFacts,
  GatewayResponseHeaders,
  NormalizedStopReason,
  NormalizedTermination,
  ProtocolStreamEvent,
  RefusalSource,
} from '../types.js';
import {
  emptyOutcome,
  hasTypedItem,
  inspectCommonRequest,
  readIdentifier,
  readResponseHeaderIdentifier,
  SERVICE_TIERS,
  stableFlags,
} from './common.js';
import { OpenAiUsageAccumulator } from './openai-usage.js';

function responseStatus(status: unknown): {
  stop: NormalizedStopReason;
  termination: NormalizedTermination;
} {
  switch (status) {
    case 'completed':
      return { stop: 'completed', termination: 'stop' };
    case 'incomplete':
      return { stop: 'incomplete', termination: 'length' };
    case 'failed':
      return { stop: 'failed', termination: 'error' };
    case 'cancelled':
      return { stop: 'cancelled', termination: 'aborted' };
    case 'queued':
    case 'in_progress':
    case undefined:
    case null:
      return { stop: 'not_reported', termination: 'unknown' };
    default:
      return { stop: 'other', termination: 'unknown' };
  }
}

export class OpenAiResponsesAccumulator implements LlmProtocolAccumulator {
  private responseModel: string | null = null;
  private providerRequestId: string | null = null;
  private providerResponseId: string | null = null;
  private actualServiceTier: string | null = null;
  private protocolTerminal = false;
  private termination: NormalizedTermination = 'unknown';
  private stopReason: NormalizedStopReason = 'not_reported';
  private refusal: boolean | null = null;
  private refusalSource: RefusalSource = 'not_reported';
  private readonly flags = new Set<string>();
  private readonly usage = new OpenAiUsageAccumulator('responses', this.flags);

  observeResponseHeaders(headers: GatewayResponseHeaders): void {
    this.providerRequestId = readResponseHeaderIdentifier(headers, 'x-request-id', this.flags);
  }

  observeJsonResponse(value: unknown): void {
    const response = asRecord(value);
    if (!response) {
      this.flags.add('invalid_response_envelope');
      return;
    }
    this.observeResponse(response, true);
    this.markTerminal();
  }

  observeStreamEvent(event: ProtocolStreamEvent): 'control' | 'reasoning' | 'output' {
    if (event.data === '[DONE]') return 'control';
    const payload = asRecord(event.data);
    if (!payload) {
      this.flags.add('invalid_stream_event');
      return 'control';
    }
    const type = typeof payload['type'] === 'string' ? payload['type'] : event.eventType;
    const response = asRecord(payload['response']);
    const isTerminal =
      type === 'response.completed' ||
      type === 'response.incomplete' ||
      type === 'response.failed' ||
      type === 'response.cancelled';
    if (response) this.observeResponse(response, isTerminal);
    if (type === 'response.refusal.done' || hasTypedItem(payload['item'], ['refusal'])) {
      this.markRefusal('content_item');
    }
    if (isTerminal) this.markTerminal();
    if (typeof type === 'string' && type.endsWith('.delta')) {
      if (type.includes('reasoning')) return 'reasoning';
      if (
        type === 'response.output_text.delta' ||
        type === 'response.refusal.delta' ||
        type === 'response.function_call_arguments.delta' ||
        type === 'response.mcp_call_arguments.delta' ||
        type === 'response.custom_tool_call_input.delta'
      ) {
        return 'output';
      }
    }
    return 'control';
  }

  isProtocolTerminal(): boolean {
    return this.protocolTerminal;
  }

  snapshot(): LlmProtocolObservation {
    const usage = this.usage.snapshot('openai_responses_usage');
    const outcome =
      this.stopReason === 'not_reported' && this.refusal === null
        ? emptyOutcome()
        : {
            termination: this.termination,
            providerStopReason: this.stopReason,
            responseStatus: null,
            refusal: this.refusal,
            refusalCategory: null,
            refusalSource: this.refusalSource,
          };
    return {
      protocol: 'openai-responses',
      responseModel: this.responseModel,
      providerRequestId: this.providerRequestId,
      providerResponseId: this.providerResponseId,
      actualServiceTier: this.actualServiceTier,
      usage,
      outcome,
      protocolTerminal: this.protocolTerminal,
      qualityFlags: stableFlags([...this.flags], usage.qualityFlags),
    };
  }

  private observeResponse(response: Record<string, unknown>, terminal: boolean): void {
    const model = readIdentifier(response, 'model', this.flags);
    const id = readIdentifier(response, 'id', this.flags);
    const tier = asKnownString(response['service_tier'], SERVICE_TIERS);
    if (model !== null) this.responseModel = model;
    if (id !== null) this.providerResponseId = id;
    if (tier !== null) this.actualServiceTier = tier;
    this.usage.observe(response['usage'], terminal);
    const mapped = responseStatus(response['status']);
    if (mapped.stop !== 'not_reported') {
      this.stopReason = mapped.stop;
      this.termination = mapped.termination;
      if (mapped.termination === 'stop' || mapped.termination === 'length' || mapped.termination === 'tool') {
        this.refusal = false;
      }
    }
    const incompleteDetails = asRecord(response['incomplete_details']);
    if (incompleteDetails?.['reason'] === 'content_filter') {
      this.stopReason = 'content_filter';
      this.termination = 'content_filter';
      this.refusal = true;
      this.refusalSource = 'content_filter';
    }
    if (hasTypedItem(response, ['refusal'])) this.markRefusal('content_item');
  }

  private markRefusal(source: RefusalSource): void {
    this.refusal = true;
    this.refusalSource = source;
    this.stopReason = 'refusal';
    this.termination = 'refusal';
  }

  private markTerminal(): void {
    if (this.protocolTerminal) this.flags.add('duplicate_protocol_terminal');
    this.protocolTerminal = true;
  }
}

export class OpenAiResponsesAdapter implements LlmProtocolAdapter {
  readonly id = 'openai-responses' as const;

  inspectRequest(value: unknown): LlmRequestFacts {
    return inspectCommonRequest(value);
  }

  createAccumulator(): LlmProtocolAccumulator {
    return new OpenAiResponsesAccumulator();
  }
}
