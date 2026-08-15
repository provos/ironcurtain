import {
  addCounts,
  asKnownString,
  asRecord,
  makeNormalizedUsage,
  subtractCount,
  usageCompleteness,
} from '../normalization.js';
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
  readCount,
  readIdentifier,
  readResponseHeaderIdentifier,
  SERVICE_TIERS,
  stableFlags,
} from './common.js';

interface AnthropicUsageState {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  thinking: number | null;
  sawUsage: boolean;
}

const EMPTY_USAGE: AnthropicUsageState = {
  input: null,
  cacheRead: null,
  cacheWrite: null,
  output: null,
  thinking: null,
  sawUsage: false,
};

function stopReason(reason: unknown): {
  normalized: NormalizedStopReason;
  termination: NormalizedTermination;
} {
  switch (reason) {
    case 'end_turn':
      return { normalized: 'end_turn', termination: 'stop' };
    case 'stop_sequence':
      return { normalized: 'stop_sequence', termination: 'stop' };
    case 'max_tokens':
      return { normalized: 'max_tokens', termination: 'length' };
    case 'model_context_window_exceeded':
      return { normalized: 'context_window', termination: 'length' };
    case 'tool_use':
      return { normalized: 'tool_use', termination: 'tool' };
    case 'pause_turn':
      return { normalized: 'pause_turn', termination: 'tool' };
    case 'refusal':
      return { normalized: 'refusal', termination: 'refusal' };
    case undefined:
    case null:
      return { normalized: 'not_reported', termination: 'unknown' };
    default:
      return { normalized: 'other', termination: 'unknown' };
  }
}

export class AnthropicMessagesAccumulator implements LlmProtocolAccumulator {
  private responseModel: string | null = null;
  private providerRequestId: string | null = null;
  private providerResponseId: string | null = null;
  private actualServiceTier: string | null = null;
  private usage: AnthropicUsageState = { ...EMPTY_USAGE };
  private terminal = false;
  private termination: NormalizedTermination = 'unknown';
  private providerStopReason: NormalizedStopReason = 'not_reported';
  private refusal: boolean | null = null;
  private refusalCategory: string | null = null;
  private refusalSource: RefusalSource = 'not_reported';
  private readonly flags = new Set<string>();

  observeResponseHeaders(headers: GatewayResponseHeaders): void {
    this.providerRequestId = readResponseHeaderIdentifier(headers, 'request-id', this.flags);
  }

  observeJsonResponse(value: unknown): void {
    const message = asRecord(value);
    if (!message) {
      this.flags.add('invalid_response_envelope');
      return;
    }
    this.observeMessageIdentity(message);
    this.observeInitialUsage(asRecord(message['usage']));
    this.observeTerminalUsage(asRecord(message['usage']));
    this.observeStop(message['stop_reason'], asRecord(message['stop_details']));
    if (hasTypedItem(message, ['refusal'])) this.markRefusal('content_item');
    this.terminal = true;
  }

  observeStreamEvent(event: ProtocolStreamEvent): 'control' | 'reasoning' | 'output' {
    const payload = asRecord(event.data);
    if (!payload) {
      this.flags.add('invalid_stream_event');
      return 'control';
    }
    const type = typeof payload['type'] === 'string' ? payload['type'] : event.eventType;
    if (type === 'message_start') {
      const message = asRecord(payload['message']);
      if (!message) {
        this.flags.add('invalid_message_start');
        return 'control';
      }
      this.observeMessageIdentity(message);
      this.observeInitialUsage(asRecord(message['usage']));
      return 'control';
    }
    if (type === 'message_delta') {
      const delta = asRecord(payload['delta']);
      this.observeTerminalUsage(asRecord(payload['usage']));
      this.observeStop(delta?.['stop_reason'], asRecord(delta?.['stop_details']));
      return 'control';
    }
    if (type === 'message_stop') {
      if (this.terminal) this.flags.add('duplicate_protocol_terminal');
      this.terminal = true;
      const metadata = asRecord(payload['message']);
      if (metadata) this.observeMessageIdentity(metadata);
      return 'control';
    }
    if (type === 'content_block_start' && hasTypedItem(payload['content_block'], ['refusal'])) {
      this.markRefusal('content_item');
    }
    if (type === 'content_block_delta') {
      const deltaType = asRecord(payload['delta'])?.['type'];
      if (deltaType === 'thinking_delta') return 'reasoning';
      if (deltaType === 'text_delta' || deltaType === 'input_json_delta') return 'output';
    }
    return 'control';
  }

  isProtocolTerminal(): boolean {
    return this.terminal;
  }

  snapshot(): LlmProtocolObservation {
    const inputTotal = addCounts(this.usage.input, this.usage.cacheRead, this.usage.cacheWrite);
    const outputTotal = this.usage.output;
    const thinking = this.usage.thinking;
    const nonThinking = subtractCount(outputTotal, thinking);
    const invalid = [...this.flags].some((flag) => flag.startsWith('invalid_count:'));
    const usageFlags = new Set<string>();
    if (thinking !== null && outputTotal !== null && thinking > outputTotal) {
      usageFlags.add('contradictory_usage:thinking_exceeds_output');
    }
    const validNonThinking = usageFlags.size === 0 ? nonThinking : null;
    const complete = usageCompleteness(inputTotal, outputTotal, this.usage.sawUsage, invalid);
    const outcome =
      this.providerStopReason === 'not_reported'
        ? emptyOutcome()
        : {
            termination: this.termination,
            providerStopReason: this.providerStopReason,
            responseStatus: null,
            refusal: this.refusal,
            refusalCategory: this.refusalCategory,
            refusalSource: this.refusalSource,
          };
    return {
      protocol: 'anthropic-messages',
      responseModel: this.responseModel,
      providerRequestId: this.providerRequestId,
      providerResponseId: this.providerResponseId,
      actualServiceTier: this.actualServiceTier,
      usage: makeNormalizedUsage({
        inputTokensReported: this.usage.input,
        inputTokensTotal: inputTotal,
        inputTokensAccuracy: inputTotal === null ? 'unknown' : 'derived_exact',
        inputTokensUncached: this.usage.input,
        cacheReadInputTokens: this.usage.cacheRead,
        cacheWriteInputTokens: this.usage.cacheWrite,
        outputTokensReported: outputTotal,
        outputTokenSemantics: 'includes_thinking',
        outputTokensTotal: outputTotal,
        outputTokensAccuracy: outputTotal === null ? 'unknown' : 'reported_exact',
        thinkingTokens: thinking,
        thinkingTokensAccuracy: thinking === null ? 'unknown' : 'provider_estimate',
        nonThinkingOutputTokens: validNonThinking,
        nonThinkingOutputTokensAccuracy: validNonThinking === null ? 'unknown' : 'derived_from_estimate',
        providerTotalTokens: null,
        canonicalTotalTokens: addCounts(inputTotal, outputTotal),
        usageSource: this.usage.sawUsage ? 'anthropic_message_usage' : null,
        usageCompleteness: complete,
        qualityFlags: [...usageFlags],
      }),
      outcome,
      protocolTerminal: this.terminal,
      qualityFlags: stableFlags([...this.flags], [...usageFlags]),
    };
  }

  private observeMessageIdentity(message: Record<string, unknown>): void {
    const model = readIdentifier(message, 'model', this.flags);
    const id = readIdentifier(message, 'id', this.flags);
    const serviceTier = asKnownString(message['service_tier'], SERVICE_TIERS);
    if (model !== null) this.responseModel = model;
    if (id !== null) this.providerResponseId = id;
    if (serviceTier !== null) this.actualServiceTier = serviceTier;
  }

  private observeInitialUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    this.usage.sawUsage = true;
    this.setUsageField('input', readCount(usage, 'input_tokens', this.flags), 'initial');
    this.setUsageField('cacheRead', readCount(usage, 'cache_read_input_tokens', this.flags), 'initial');
    this.setUsageField('cacheWrite', readCount(usage, 'cache_creation_input_tokens', this.flags), 'initial');
  }

  private observeTerminalUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    this.usage.sawUsage = true;
    this.setUsageField('output', readCount(usage, 'output_tokens', this.flags), 'terminal');
    const details = asRecord(usage['output_tokens_details']);
    this.setUsageField('thinking', readCount(details, 'thinking_tokens', this.flags), 'terminal');
  }

  private setUsageField(
    field: 'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'thinking',
    value: number | null,
    phase: string,
  ): void {
    if (value === null) return;
    const previous = this.usage[field];
    if (previous !== null && previous !== value) this.flags.add(`conflicting_usage:${phase}:${field}`);
    this.usage[field] = value;
  }

  private observeStop(reason: unknown, details: Record<string, unknown> | undefined): void {
    const mapped = stopReason(reason);
    if (mapped.normalized !== 'not_reported') {
      if (this.providerStopReason !== 'not_reported' && this.providerStopReason !== mapped.normalized) {
        this.flags.add('conflicting_stop_reason');
      }
      this.providerStopReason = mapped.normalized;
      this.termination = mapped.termination;
      if (mapped.termination !== 'unknown') this.refusal = mapped.termination === 'refusal';
    }
    if (details?.['type'] === 'refusal') {
      this.markRefusal('stop_details');
      const category = asKnownString(details['category'], [
        'cyber',
        'bio',
        'frontier_llm',
        'reasoning_extraction',
        'general_harms',
      ] as const);
      if (details['category'] != null && category === null) this.flags.add('unknown_refusal_category');
      if (category !== null) this.refusalCategory = category;
    } else if (mapped.normalized === 'refusal') {
      this.markRefusal('stop_reason');
    }
  }

  private markRefusal(source: RefusalSource): void {
    this.refusal = true;
    this.refusalSource = source;
    this.termination = 'refusal';
    this.providerStopReason = 'refusal';
  }
}

export class AnthropicMessagesAdapter implements LlmProtocolAdapter {
  readonly id = 'anthropic-messages' as const;

  inspectRequest(value: unknown): LlmRequestFacts {
    return inspectCommonRequest(value);
  }

  createAccumulator(): LlmProtocolAccumulator {
    return new AnthropicMessagesAccumulator();
  }
}
