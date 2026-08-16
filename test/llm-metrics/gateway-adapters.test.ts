import { describe, expect, it } from 'vitest';
import { DirectGatewayAdapter } from '../../src/llm-metrics/gateways/direct.js';
import { IronCurtainGatewayAdapter } from '../../src/llm-metrics/gateways/ironcurtain.js';
import { OpaqueGatewayAdapter } from '../../src/llm-metrics/gateways/opaque.js';
import { OpenRouterGatewayAdapter } from '../../src/llm-metrics/gateways/openrouter.js';
import { makeNormalizedUsage } from '../../src/llm-metrics/normalization.js';
import type { LlmProtocolObservation } from '../../src/llm-metrics/types.js';

const CONTENT_CANARY = 'CONTENT CANARY must never escape';

const protocolObservation: LlmProtocolObservation = {
  protocol: 'openai-responses',
  responseModel: 'gpt-5.5-2026-08-01',
  providerRequestId: 'request_1',
  providerResponseId: 'resp_1',
  actualServiceTier: null,
  usage: makeNormalizedUsage(),
  outcome: {
    termination: 'stop',
    providerStopReason: 'completed',
    responseStatus: null,
    refusal: false,
    refusalCategory: null,
    refusalSource: 'not_reported',
  },
  protocolTerminal: true,
  qualityFlags: [],
};

describe('gateway metadata adapters', () => {
  it('uses response identity as served identity only for a verified official direct origin', () => {
    const direct = new DirectGatewayAdapter({ providerId: 'openai', officialOrigin: true }).createAccumulator();
    expect(direct.snapshot(protocolObservation)).toMatchObject({
      servedModel: { value: 'gpt-5.5-2026-08-01', source: 'protocol_response_direct' },
      servedProvider: { value: 'openai', source: 'configured_route' },
    });

    const override = new DirectGatewayAdapter({ providerId: 'openai', officialOrigin: false }).createAccumulator();
    expect(override.snapshot(protocolObservation)).toMatchObject({
      servedModel: { value: null, source: 'not_exposed' },
      qualityFlags: ['unverified_direct_origin'],
    });
  });

  it('leaves served identity null for opaque gateways', () => {
    expect(new OpaqueGatewayAdapter().createAccumulator().snapshot(protocolObservation)).toMatchObject({
      servedModel: { value: null, source: 'not_exposed' },
      servedProvider: { value: null, source: 'not_exposed' },
      routeAttempts: [],
    });
  });

  it('extracts only allowlisted OpenRouter routing, cost, and generation facts', () => {
    const accumulator = new OpenRouterGatewayAdapter().createAccumulator();
    accumulator.observeHeaders({ 'X-Generation-Id': 'gen_abc123', 'x-secret': CONTENT_CANARY });
    accumulator.observePayload({
      usage: { cost: 0.0125, arbitrary_numeric_content: 12345 },
      openrouter_metadata: {
        requested: 'router/auto',
        summary: CONTENT_CANARY,
        params: { system_prompt: CONTENT_CANARY },
        pipeline: [{ type: 'guardrail', data: { matched: CONTENT_CANARY } }],
        endpoints: {
          available: [
            { provider: 'Other Provider', model: 'other/model', selected: false },
            { provider: 'Google AI Studio', model: 'google/gemini-3.1-pro', selected: true },
          ],
        },
        attempts: [
          { provider: 'Other Provider', model: 'other/model', status: 503, error: CONTENT_CANARY },
          { provider: 'Google AI Studio', model: 'google/gemini-3.1-pro', status: 200 },
        ],
      },
    });
    const result = accumulator.snapshot(protocolObservation);
    expect(result).toMatchObject({
      servedModel: { value: 'google/gemini-3.1-pro', source: 'router_metadata' },
      servedProvider: { value: 'Google AI Studio', source: 'router_metadata' },
      generationId: 'gen_abc123',
      costUsd: 0.0125,
      routeAttempts: [
        { ordinal: 1, provider: 'Other Provider', model: 'other/model', status: 503 },
        { ordinal: 2, provider: 'Google AI Studio', model: 'google/gemini-3.1-pro', status: 200 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
  });

  it('does not infer OpenRouter served identity when metadata is absent', () => {
    const accumulator = new OpenRouterGatewayAdapter().createAccumulator();
    accumulator.observeHeaders({ 'x-generation-id': 'gen_cache_hit' });
    accumulator.observePayload({ usage: { cost: 0 } });
    expect(accumulator.snapshot()).toMatchObject({
      servedModel: { value: null, source: 'not_exposed' },
      servedProvider: { value: null, source: 'not_exposed' },
      generationId: 'gen_cache_hit',
      costUsd: 0,
    });
  });

  it('caps OpenRouter attempts and rejects malformed identities/counts', () => {
    const attempts = Array.from({ length: 70 }, (_, index) => ({
      provider: index === 0 ? 'bad\nprovider' : 'OpenAI',
      model: index === 0 ? CONTENT_CANARY : 'openai/gpt-5.5',
      status: index === 0 ? 999 : 200,
    }));
    const accumulator = new OpenRouterGatewayAdapter().createAccumulator();
    accumulator.observePayload({ openrouter_metadata: { attempts } });
    const result = accumulator.snapshot();
    expect(result.routeAttempts).toHaveLength(64);
    expect(result.routeAttempts[0]).toMatchObject({ provider: null, model: null, status: null });
    expect(result.qualityFlags).toEqual(
      expect.arrayContaining([
        'router_attempts_truncated',
        'invalid_route_provider',
        'invalid_route_model',
        'invalid_route_status',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
  });

  it('parses only the versioned trusted IronCurtain route contract', () => {
    const accumulator = new IronCurtainGatewayAdapter().createAccumulator();
    accumulator.observeHeaders({
      'X-IronCurtain-Route-Version': '1',
      'X-IronCurtain-Served-Provider': 'Private Provider',
      'X-IronCurtain-Served-Model': 'private/model-v2',
      'X-IronCurtain-Request-Id': 'route_req_1',
    });
    accumulator.observePayload({
      ironcurtain_route: {
        version: 1,
        served_provider: 'Private Provider',
        served_model: 'private/model-v2',
        request_id: 'route_req_1',
        attempts: [{ provider: 'Private Provider', model: 'private/model-v2', status: 200, selected: true }],
        debug: CONTENT_CANARY,
      },
    });
    const result = accumulator.snapshot();
    expect(result).toMatchObject({
      servedModel: { value: 'private/model-v2', source: 'trusted_gateway_header' },
      servedProvider: { value: 'Private Provider', source: 'trusted_gateway_header' },
      generationId: 'route_req_1',
      routeAttempts: [{ ordinal: 1, status: 200, selected: true }],
    });
    expect(JSON.stringify(result)).not.toContain(CONTENT_CANARY);
  });
});
