import { describe, expect, it } from 'vitest';
import { AnthropicMessagesAdapter } from '../../src/llm-metrics/protocols/anthropic-messages.js';
import { GoogleGenerateContentAdapter } from '../../src/llm-metrics/protocols/google-generate-content.js';
import { OpenAiChatCompletionsAdapter } from '../../src/llm-metrics/protocols/openai-chat-completions.js';
import { OpenAiResponsesAdapter } from '../../src/llm-metrics/protocols/openai-responses.js';

const CONTENT_CANARY = 'CONTENT_CANARY_must_never_escape';
const ERROR_CANARY = 'ERROR_CANARY_must_never_escape';

function expectContentFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(CONTENT_CANARY);
  expect(serialized).not.toContain(ERROR_CANARY);
}

describe('Anthropic Messages metrics adapter', () => {
  it('merges initial input/cache usage with terminal inclusive output and estimated thinking', () => {
    const adapter = new AnthropicMessagesAdapter();
    expect(
      adapter.inspectRequest({
        model: 'claude-opus-5',
        stream: true,
        service_tier: 'priority',
        thinking: { type: 'adaptive', budget_tokens: 4096 },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: CONTENT_CANARY }],
      }),
    ).toMatchObject({
      requestedModel: 'claude-opus-5',
      streaming: true,
      requestedServiceTier: 'priority',
      reasoningMode: 'adaptive',
      reasoningEffort: 'high',
      thinkingBudgetTokens: 4096,
    });

    const accumulator = adapter.createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        type: 'message_start',
        message: {
          id: 'msg_123',
          model: 'claude-opus-5-20260801',
          service_tier: 'priority',
          content: [{ type: 'text', text: CONTENT_CANARY }],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
            output_tokens: 1,
          },
        },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 30 } },
      },
    });
    accumulator.observeStreamEvent({ data: { type: 'message_stop' } });

    const result = accumulator.snapshot();
    expect(result).toMatchObject({
      responseModel: 'claude-opus-5-20260801',
      providerRequestId: null,
      providerResponseId: 'msg_123',
      actualServiceTier: 'priority',
      protocolTerminal: true,
      outcome: { termination: 'stop', providerStopReason: 'end_turn', refusal: false },
      usage: {
        inputTokensReported: 100,
        inputTokensTotal: 130,
        inputTokensAccuracy: 'derived_exact',
        inputTokensUncached: 100,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 10,
        outputTokensTotal: 50,
        outputTokensAccuracy: 'reported_exact',
        thinkingTokens: 30,
        thinkingTokensAccuracy: 'provider_estimate',
        nonThinkingOutputTokens: 20,
        nonThinkingOutputTokensAccuracy: 'derived_from_estimate',
        providerTotalTokens: null,
        canonicalTotalTokens: 180,
        usageCompleteness: 'complete',
      },
    });
    expectContentFree(result);
  });

  it('separates allowlisted request headers, body response IDs, and generated event phases', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'x-request-id': 'wrong_header', 'request-id': 'request_123' });
    expect(accumulator.observeStreamEvent({ data: { type: 'message_start', message: { id: 'msg_123' } } })).toBe(
      'control',
    );
    expect(
      accumulator.observeStreamEvent({
        data: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: CONTENT_CANARY } },
      }),
    ).toBe('reasoning');
    expect(
      accumulator.observeStreamEvent({
        data: { type: 'content_block_delta', delta: { type: 'text_delta', text: CONTENT_CANARY } },
      }),
    ).toBe('output');
    expect(accumulator.snapshot()).toMatchObject({ providerRequestId: 'request_123', providerResponseId: 'msg_123' });
  });

  it('keeps unknown additive stop reasons out of the refusal denominator', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({ stop_reason: 'future_stop_reason' });
    expect(accumulator.snapshot().outcome).toMatchObject({ providerStopReason: 'other', refusal: null });
  });

  it('preserves zero, reports missing cache components as partial, and never invents totals', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'msg_zero',
      model: 'claude-haiku-4-5',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(accumulator.snapshot().usage).toMatchObject({
      inputTokensReported: 0,
      inputTokensTotal: null,
      cacheReadInputTokens: null,
      outputTokensTotal: 0,
      canonicalTotalTokens: null,
      usageCompleteness: 'partial',
    });
  });

  it('records structured refusal facts but drops explanation text and unknown categories', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'msg_refusal',
      model: 'claude-opus-5',
      content: [{ type: 'refusal', refusal: CONTENT_CANARY }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: ERROR_CANARY, explanation: ERROR_CANARY },
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 2,
      },
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({
      termination: 'refusal',
      providerStopReason: 'refusal',
      refusal: true,
      refusalCategory: null,
    });
    expect(result.qualityFlags).toContain('unknown_refusal_category');
    expectContentFree(result);
  });

  it('does not finalize twice when duplicate terminal events arrive', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeStreamEvent({ data: { type: 'message_stop' } });
    accumulator.observeStreamEvent({ data: { type: 'message_stop' } });
    expect(accumulator.snapshot().qualityFlags).toContain('duplicate_protocol_terminal');
  });
});

describe('OpenAI Responses metrics adapter', () => {
  it('captures the top-level reasoning_effort request dimension', () => {
    expect(
      new OpenAiResponsesAdapter().inspectRequest({
        model: 'gpt-5.5',
        stream: true,
        reasoning_effort: 'xhigh',
        input: CONTENT_CANARY,
      }),
    ).toMatchObject({ reasoningMode: 'effort', reasoningEffort: 'xhigh' });
  });

  it('uses terminal cumulative usage without summing prior events', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        type: 'response.created',
        response: {
          id: 'resp_1',
          model: 'gpt-5.5',
          status: 'in_progress',
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.5',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: CONTENT_CANARY }] }],
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 25 },
            total_tokens: 160,
          },
        },
      },
    });
    accumulator.observeStreamEvent({ data: '[DONE]' });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      inputTokensTotal: 120,
      inputTokensAccuracy: 'reported_exact',
      inputTokensUncached: 20,
      cacheReadInputTokens: 100,
      outputTokensTotal: 40,
      outputTokensAccuracy: 'reported_exact',
      thinkingTokens: 25,
      nonThinkingOutputTokens: 15,
      providerTotalTokens: 160,
      canonicalTotalTokens: 160,
    });
    expect(result.usage.inputTokensTotal).not.toBe(130);
    expect(result.outcome).toMatchObject({ termination: 'stop', providerStopReason: 'completed' });
    expect(result.qualityFlags).not.toContain('invalid_stream_event');
    expectContentFree(result);
  });

  it('classifies only generated deltas and retains the allowlisted request header separately', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'request-id': 'wrong_header', 'x-request-id': 'request_456' });
    expect(accumulator.observeStreamEvent({ data: { type: 'response.created', response: { id: 'resp_456' } } })).toBe(
      'control',
    );
    expect(accumulator.observeStreamEvent({ data: { type: 'response.reasoning_summary_text.delta' } })).toBe(
      'reasoning',
    );
    expect(accumulator.observeStreamEvent({ data: { type: 'response.output_text.delta' } })).toBe('output');
    expect(accumulator.snapshot()).toMatchObject({ providerRequestId: 'request_456', providerResponseId: 'resp_456' });
  });

  it('does not infer non-refusal from unknown or failed response statuses', () => {
    const unknown = new OpenAiResponsesAdapter().createAccumulator();
    unknown.observeJsonResponse({ status: 'future_status' });
    expect(unknown.snapshot().outcome).toMatchObject({ providerStopReason: 'other', refusal: null });
    const failed = new OpenAiResponsesAdapter().createAccumulator();
    failed.observeJsonResponse({ status: 'failed' });
    expect(failed.snapshot().outcome).toMatchObject({ termination: 'error', refusal: null });
  });

  it('detects explicit refusal items and ignores refusal/error text', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'resp_refusal',
      model: 'gpt-5.5',
      status: 'failed',
      error: { message: ERROR_CANARY },
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: CONTENT_CANARY }] }],
      usage: null,
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({ termination: 'refusal', refusal: true, refusalSource: 'content_item' });
    expectContentFree(result);
  });

  it('flags duplicate terminal envelopes and contradictory provider totals', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    const event = {
      type: 'response.completed',
      response: {
        id: 'resp_dup',
        model: 'gpt-5.5',
        status: 'completed',
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 99 },
      },
    };
    accumulator.observeStreamEvent({ data: event });
    accumulator.observeStreamEvent({ data: event });
    const result = accumulator.snapshot();
    expect(result.qualityFlags).toContain('duplicate_protocol_terminal');
    expect(result.qualityFlags).toContain('duplicate_terminal_usage');
    expect(result.qualityFlags).toContain('contradictory_usage:provider_total');
  });
});

describe('OpenAI Chat Completions metrics adapter', () => {
  it('accepts the choices-empty usage chunk after finish_reason and treats DONE as one terminal', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        id: 'chatcmpl_1',
        model: 'gpt-5.5',
        choices: [{ index: 0, delta: { content: CONTENT_CANARY }, finish_reason: 'stop' }],
      },
    });
    accumulator.observeStreamEvent({
      data: {
        id: 'chatcmpl_1',
        model: 'gpt-5.5',
        choices: [],
        usage: {
          prompt_tokens: 50,
          prompt_tokens_details: { cached_tokens: 30 },
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 70,
        },
      },
    });
    accumulator.observeStreamEvent({ data: '[DONE]' });
    const result = accumulator.snapshot();
    expect(result.protocolTerminal).toBe(true);
    expect(result.outcome).toMatchObject({ termination: 'stop', refusal: false });
    expect(result.usage).toMatchObject({
      inputTokensTotal: 50,
      inputTokensUncached: 20,
      outputTokensTotal: 20,
      thinkingTokens: 0,
      nonThinkingOutputTokens: 20,
      usageCompleteness: 'complete',
    });
    expectContentFree(result);
  });

  it('classifies content filtering and rejects malformed numeric usage', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'chatcmpl_filter',
      model: 'gpt-5.5',
      choices: [{ finish_reason: 'content_filter', message: { content: null } }],
      usage: { prompt_tokens: -1, completion_tokens: 2.5, total_tokens: Number.POSITIVE_INFINITY },
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({ termination: 'content_filter', refusal: true });
    expect(result.usage.usageCompleteness).toBe('invalid');
    expect(result.qualityFlags).toContain('invalid_count:prompt_tokens');
  });

  it('does not treat the normal refusal:null response field as a refusal', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'chatcmpl_normal',
      model: 'gpt-5.5',
      choices: [{ finish_reason: 'stop', message: { content: CONTENT_CANARY, refusal: null } }],
      usage: {
        prompt_tokens: 1,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens: 1,
        completion_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    });
    expect(accumulator.snapshot().outcome).toMatchObject({ termination: 'stop', refusal: false });
  });

  it('flags repeated DONE without creating a second observation', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeStreamEvent({ data: '[DONE]' });
    accumulator.observeStreamEvent({ data: '[DONE]' });
    expect(accumulator.snapshot().qualityFlags).toContain('duplicate_protocol_terminal');
  });

  it('classifies generated chat deltas and leaves unknown finishes nullable', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'x-request-id': 'request_chat' });
    expect(
      accumulator.observeStreamEvent({ data: { id: 'chat_1', choices: [{ delta: { reasoning_content: 'hidden' } }] } }),
    ).toBe('reasoning');
    expect(
      accumulator.observeStreamEvent({ data: { id: 'chat_1', choices: [{ delta: { content: CONTENT_CANARY } }] } }),
    ).toBe('output');
    accumulator.observeStreamEvent({ data: { choices: [{ finish_reason: 'future_reason', delta: {} }] } });
    expect(accumulator.snapshot()).toMatchObject({
      providerRequestId: 'request_chat',
      providerResponseId: 'chat_1',
      outcome: { providerStopReason: 'other', refusal: null },
    });
  });
});

describe('Google GenerateContent metrics adapter', () => {
  it('extracts the requested model from the capped URL segment and normalizes thought-inclusive output', () => {
    const adapter = new GoogleGenerateContentAdapter();
    const request = adapter.inspectRequest(
      {
        contents: [{ parts: [{ text: CONTENT_CANARY }] }],
        generationConfig: {
          thinkingConfig: { includeThoughts: true, thinkingBudget: 2048, thinkingLevel: 'HIGH' },
        },
      },
      { path: '/v1beta/models/gemini-3.1-pro:streamGenerateContent' },
    );
    expect(request).toMatchObject({
      requestedModel: 'gemini-3.1-pro',
      streaming: true,
      reasoningMode: 'enabled',
      reasoningEffort: 'HIGH',
      thinkingBudgetTokens: 2048,
    });
    expectContentFree(request);

    const accumulator = adapter.createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        modelVersion: 'gemini-3.1-pro-001',
        responseId: 'google_resp_1',
        candidates: [{ content: { parts: [{ text: CONTENT_CANARY }] } }],
        usageMetadata: {
          promptTokenCount: 8,
          cachedContentTokenCount: 2,
          candidatesTokenCount: 1,
          thoughtsTokenCount: 1,
          totalTokenCount: 10,
        },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        modelVersion: 'gemini-3.1-pro-001',
        responseId: 'google_resp_1',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: CONTENT_CANARY }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          cachedContentTokenCount: 3,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 6,
          toolUsePromptTokenCount: 2,
          totalTokenCount: 22,
        },
      },
    });
    const result = accumulator.snapshot();
    expect(result).toMatchObject({
      responseModel: 'gemini-3.1-pro-001',
      providerRequestId: null,
      providerResponseId: 'google_resp_1',
      protocolTerminal: true,
      outcome: { termination: 'stop', refusal: false },
      usage: {
        inputTokensReported: 10,
        inputTokensTotal: 12,
        inputTokensAccuracy: 'derived_exact',
        inputTokensUncached: 9,
        toolUseInputTokens: 2,
        outputTokensReported: 4,
        outputTokenSemantics: 'excludes_thinking',
        outputTokensTotal: 10,
        outputTokensAccuracy: 'derived_exact',
        thinkingTokens: 6,
        nonThinkingOutputTokens: 4,
        providerTotalTokens: 22,
        canonicalTotalTokens: 22,
      },
    });
    expectContentFree(result);
  });

  it('classifies thought/content chunks and leaves future finishes nullable', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'x-goog-request-id': 'request_google' });
    expect(
      accumulator.observeStreamEvent({
        data: { responseId: 'response_google', candidates: [{ content: { parts: [] } }] },
      }),
    ).toBe('control');
    expect(
      accumulator.observeStreamEvent({
        data: { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }] } }] },
      }),
    ).toBe('reasoning');
    expect(
      accumulator.observeStreamEvent({ data: { candidates: [{ content: { parts: [{ text: CONTENT_CANARY }] } }] } }),
    ).toBe('output');
    accumulator.observeStreamEvent({ data: { candidates: [{ finishReason: 'FUTURE_REASON' }] } });
    expect(accumulator.snapshot()).toMatchObject({
      providerRequestId: 'request_google',
      providerResponseId: 'response_google',
      outcome: { providerStopReason: 'other', refusal: null },
    });
  });

  it('keeps inclusive output unknown when thought count is absent and flags cumulative regression', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: { usageMetadata: { promptTokenCount: 10, toolUsePromptTokenCount: 0, candidatesTokenCount: 5 } },
    });
    accumulator.observeStreamEvent({
      data: {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 9, toolUsePromptTokenCount: 0, candidatesTokenCount: 4 },
      },
    });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      inputTokensTotal: 9,
      outputTokensReported: 4,
      outputTokensTotal: null,
      canonicalTotalTokens: null,
      usageCompleteness: 'partial',
    });
    expect(result.qualityFlags).toContain('regressing_cumulative_usage:prompt');
    expect(result.qualityFlags).toContain('regressing_cumulative_usage:candidates');
  });

  it('classifies prompt blocking without retaining block messages', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: ERROR_CANARY },
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({
      termination: 'content_filter',
      refusal: true,
      refusalSource: 'prompt_feedback',
    });
    expectContentFree(result);
    expect(result.qualityFlags).not.toContain('duplicate_protocol_terminal');
  });
});
