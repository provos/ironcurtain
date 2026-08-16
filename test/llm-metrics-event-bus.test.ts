import { describe, expect, it, vi } from 'vitest';
import { LlmMetricsEventBus } from '../src/llm-metrics/event-bus.js';
import { ObservedUsageAccumulator } from '../src/llm-metrics/observed-usage-accumulator.js';
import type { LlmExchangeCompleted } from '../src/llm-metrics/types.js';

function exchange(overrides: Partial<LlmExchangeCompleted> = {}): LlmExchangeCompleted {
  return {
    schemaVersion: 1,
    exchangeId: 'exchange-1',
    attribution: {
      sessionId: 'session-1',
      agentConversationId: null,
      turnId: 'turn-1',
      bundleId: null,
      workflowRunId: null,
      stateId: null,
      personaId: null,
      agentId: 'claude-code',
      quality: 'exact',
    },
    route: {
      logicalProvider: 'anthropic',
      providerProfileId: 'native',
      protocol: 'anthropic-messages',
      gatewayKind: 'direct',
      clientRouteId: 'api.anthropic.com',
      upstreamRouteId: 'api.anthropic.com',
    },
    identity: {
      requestedModel: { value: 'claude-haiku-4-5', source: 'request' },
      forwardedModel: { value: 'claude-haiku-4-5', source: 'forwarded_request' },
      responseModel: { value: 'claude-haiku-4-5', source: 'protocol_response' },
      servedModel: { value: 'claude-haiku-4-5', source: 'protocol_response_direct' },
      servedProvider: { value: 'anthropic', source: 'configured_route' },
    },
    responseMetadata: {
      providerRequestId: null,
      providerResponseId: 'message-1',
      gatewayGenerationId: null,
      actualServiceTier: null,
    },
    request: {
      requestedModel: 'claude-haiku-4-5',
      streaming: true,
      requestedServiceTier: null,
      reasoningMode: 'disabled',
      reasoningEffort: null,
      thinkingBudgetTokens: null,
      speedMode: null,
      qualityFlags: [],
    },
    outcome: {
      termination: 'stop',
      providerStopReason: 'end_turn',
      responseStatus: 200,
      refusal: false,
      refusalCategory: null,
      refusalSource: 'not_reported',
    },
    usage: {
      inputTokensReported: 10,
      inputTokensTotal: 15,
      inputTokensAccuracy: 'derived_exact',
      inputTokensUncached: 10,
      cacheReadInputTokens: 5,
      cacheWriteInputTokens: 0,
      toolUseInputTokens: null,
      outputTokensReported: 7,
      outputTokenSemantics: 'includes_thinking',
      outputTokensTotal: 7,
      outputTokensAccuracy: 'reported_exact',
      thinkingTokens: 2,
      thinkingTokensAccuracy: 'reported_exact',
      nonThinkingOutputTokens: 5,
      nonThinkingOutputTokensAccuracy: 'derived_exact',
      providerTotalTokens: 22,
      canonicalTotalTokens: 22,
      costUsd: 0.001,
      usageSource: 'anthropic.message_delta',
      usageCompleteness: 'complete',
      usageSemanticsVersion: 1,
      qualityFlags: [],
    },
    timing: {
      requestReceivedAt: new Date(0).toISOString(),
      requestBodyCompleteOffsetMs: 1,
      responseHeadersOffsetMs: 2,
      firstUpstreamBodyByteOffsetMs: 2.5,
      firstProtocolEventOffsetMs: 3,
      firstReasoningEventOffsetMs: null,
      lastReasoningEventOffsetMs: null,
      firstOutputEventOffsetMs: 3,
      lastOutputEventOffsetMs: 4,
      protocolTerminalOffsetMs: 4,
      upstreamResponseEndOffsetMs: 5,
      clientDeliveryEndOffsetMs: 5,
      clientAborted: false,
    },
    transportAttempts: [],
    gatewayRouteAttempts: [],
    qualityFlags: [],
    ...overrides,
  };
}

describe('Llm metrics accounting', () => {
  it('isolates throwing subscribers', () => {
    const bus = new LlmMetricsEventBus();
    const healthy = vi.fn();
    bus.subscribe(() => {
      throw new Error('subscriber failure');
    });
    bus.subscribe(healthy);
    expect(() => bus.publish(exchange())).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('deduplicates and excludes ambiguous attribution', () => {
    const accumulator = new ObservedUsageAccumulator('session-1', true);
    accumulator.observe(exchange());
    accumulator.observe(exchange());
    accumulator.observe(
      exchange({
        exchangeId: 'ambiguous',
        attribution: { ...exchange().attribution, quality: 'bundle_only' },
      }),
    );

    expect(accumulator.takeTurnSnapshot('turn-1')).toMatchObject({
      inputTokens: 15,
      outputTokens: 7,
      thinkingTokens: 2,
      totalTokens: 22,
      observedExchanges: 1,
      status: 'complete',
    });
  });

  it('preserves a missing thinking breakdown as null while retaining inclusive output totals', () => {
    const accumulator = new ObservedUsageAccumulator('session-1', true);
    accumulator.observe(
      exchange({
        usage: {
          ...exchange().usage,
          thinkingTokens: null,
          thinkingTokensAccuracy: 'unknown',
          nonThinkingOutputTokens: null,
          nonThinkingOutputTokensAccuracy: 'unknown',
        },
      }),
    );
    expect(accumulator.takeTurnSnapshot('turn-1')).toMatchObject({
      outputTokens: 7,
      thinkingTokens: null,
      totalTokens: 22,
      status: 'complete',
    });
  });
});
