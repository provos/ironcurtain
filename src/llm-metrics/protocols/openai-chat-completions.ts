import { asArray, asKnownString, asRecord } from '../normalization.js';
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

function finishReason(reason: unknown): {
  stop: NormalizedStopReason;
  termination: NormalizedTermination;
  refusal: boolean | null;
  refusalSource: RefusalSource;
} {
  switch (reason) {
    case 'stop':
      return { stop: 'completed', termination: 'stop', refusal: false, refusalSource: 'not_reported' };
    case 'length':
      return { stop: 'max_tokens', termination: 'length', refusal: false, refusalSource: 'not_reported' };
    case 'tool_calls':
    case 'function_call':
      return { stop: 'tool_use', termination: 'tool', refusal: false, refusalSource: 'not_reported' };
    case 'content_filter':
      return {
        stop: 'content_filter',
        termination: 'content_filter',
        refusal: true,
        refusalSource: 'content_filter',
      };
    default:
      return {
        stop: reason == null ? 'not_reported' : 'other',
        termination: 'unknown',
        refusal: null,
        refusalSource: 'not_reported',
      };
  }
}

export class OpenAiChatCompletionsAccumulator implements LlmProtocolAccumulator {
  private responseModel: string | null = null;
  private providerRequestId: string | null = null;
  private providerResponseId: string | null = null;
  private actualServiceTier: string | null = null;
  private protocolTerminal = false;
  private termination: NormalizedTermination = 'unknown';
  private stopReason: NormalizedStopReason = 'not_reported';
  private refusal: boolean | null = null;
  private refusalSource: RefusalSource = 'not_reported';
  private sawFinishReason = false;
  private readonly flags = new Set<string>();
  private readonly usage = new OpenAiUsageAccumulator('chat', this.flags);

  observeResponseHeaders(headers: GatewayResponseHeaders): void {
    this.providerRequestId = readResponseHeaderIdentifier(headers, 'x-request-id', this.flags);
  }

  observeJsonResponse(value: unknown): void {
    const response = asRecord(value);
    if (!response) {
      this.flags.add('invalid_response_envelope');
      return;
    }
    this.observeChunk(response, true);
    this.markTerminal();
  }

  observeStreamEvent(event: ProtocolStreamEvent): 'control' | 'reasoning' | 'output' {
    if (event.data === '[DONE]') {
      this.markTerminal();
      return 'control';
    }
    const chunk = asRecord(event.data);
    if (!chunk) {
      this.flags.add('invalid_stream_event');
      return 'control';
    }
    this.observeChunk(chunk, false);
    let reasoning = false;
    for (const choice of asArray(chunk['choices']) ?? []) {
      const delta = asRecord(asRecord(choice)?.['delta']);
      if (!delta) continue;
      if (
        typeof delta['content'] === 'string' ||
        typeof delta['refusal'] === 'string' ||
        delta['tool_calls'] !== undefined ||
        delta['function_call'] !== undefined
      ) {
        return 'output';
      }
      if (typeof delta['reasoning'] === 'string' || typeof delta['reasoning_content'] === 'string') reasoning = true;
    }
    return reasoning ? 'reasoning' : 'control';
  }

  isProtocolTerminal(): boolean {
    return this.protocolTerminal || this.sawFinishReason;
  }

  snapshot(): LlmProtocolObservation {
    const usage = this.usage.snapshot('openai_chat_usage');
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
      protocol: 'openai-chat-completions',
      responseModel: this.responseModel,
      providerRequestId: this.providerRequestId,
      providerResponseId: this.providerResponseId,
      actualServiceTier: this.actualServiceTier,
      usage,
      outcome,
      protocolTerminal: this.protocolTerminal || this.sawFinishReason,
      qualityFlags: stableFlags([...this.flags], usage.qualityFlags),
    };
  }

  private observeChunk(chunk: Record<string, unknown>, authoritativeUsage: boolean): void {
    const model = readIdentifier(chunk, 'model', this.flags);
    const id = readIdentifier(chunk, 'id', this.flags);
    const tier = asKnownString(chunk['service_tier'], SERVICE_TIERS);
    if (model !== null) this.responseModel = model;
    if (id !== null) this.providerResponseId = id;
    if (tier !== null) this.actualServiceTier = tier;
    if (chunk['usage'] !== undefined) this.usage.observe(chunk['usage'], authoritativeUsage || this.sawFinishReason);

    for (const choice of asArray(chunk['choices']) ?? []) {
      const choiceRecord = asRecord(choice);
      if (!choiceRecord) continue;
      const mapped = finishReason(choiceRecord['finish_reason']);
      if (mapped.stop !== 'not_reported') {
        if (this.sawFinishReason && this.stopReason !== mapped.stop) this.flags.add('conflicting_stop_reason');
        this.sawFinishReason = true;
        this.stopReason = mapped.stop;
        this.termination = mapped.termination;
        this.refusal = mapped.refusal;
        this.refusalSource = mapped.refusalSource;
      }
      const message = asRecord(choiceRecord['message']) ?? asRecord(choiceRecord['delta']);
      if (
        message &&
        ((message['refusal'] !== undefined && message['refusal'] !== null) || hasTypedItem(message, ['refusal']))
      ) {
        this.stopReason = 'refusal';
        this.termination = 'refusal';
        this.refusal = true;
        this.refusalSource = 'content_item';
      }
    }
  }

  private markTerminal(): void {
    if (this.protocolTerminal) this.flags.add('duplicate_protocol_terminal');
    this.protocolTerminal = true;
  }
}

export class OpenAiChatCompletionsAdapter implements LlmProtocolAdapter {
  readonly id = 'openai-chat-completions' as const;

  inspectRequest(value: unknown): LlmRequestFacts {
    return inspectCommonRequest(value);
  }

  createAccumulator(): LlmProtocolAccumulator {
    return new OpenAiChatCompletionsAccumulator();
  }
}
