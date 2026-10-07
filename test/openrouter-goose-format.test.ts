import { describe, expect, it } from 'vitest';
import type { GatewayProfile } from '../src/config/provider-definitions.js';
import { getGatewayDefinition } from '../src/config/provider-definitions.js';
import { makeGatewayProvider } from '../src/docker/gateway-runtime.js';
import { resolveChatClient } from '../src/config/gateway-client.js';

const FAST = 'google/gemini-2.5-flash'; // Goose 1.26.1's OpenRouter auxiliary model.
const ANTHROPIC = 'anthropic/claude-sonnet-4';
const DETAILS = [{ type: 'encrypted', data: 'opaque-signature', index: 0 }];
function profile(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  return {
    type: 'openrouter',
    apiKey: 'dummy-host-key',
    modelMap: [{ match: 'A', model: ANTHROPIC }],
    usesDefaultMap: false,
    perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
    sessionAffinity: true,
    ...overrides,
  };
}

/** Shape emitted by pinned format_messages: tool metadata is flattened onto tool_calls. */
function request(model = 'A'): Record<string, unknown> {
  return {
    model,
    stream: true,
    transforms: ['middle-out'],
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'oldest' },
      { role: 'user', content: 'previous' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'one', type: 'function', function: { name: 'first', arguments: '{}' } },
          { id: 'two', type: 'function', function: { name: 'second', arguments: '{}' }, reasoning_details: DETAILS },
        ],
      },
      { role: 'tool', content: 'result', tool_call_id: 'two' },
      { role: 'user', content: 'latest' },
    ],
    tools: [
      { type: 'function', function: { name: 'first', parameters: {} } },
      { type: 'function', function: { name: 'second', parameters: {} } },
    ],
  };
}
function rewrite(p: GatewayProfile, body: Record<string, unknown>) {
  const proxy = makeGatewayProvider(p, 'chat', 'goose');
  return proxy.requestRewriter!(body, { method: 'POST', path: '/api/v1/chat/completions', cacheKey: 'session' });
}

describe('Goose formatting follows proxy-selected OpenRouter models', () => {
  it('adds the pinned Anthropic cache checkpoints after a single mapping without mutating the request', () => {
    const p = profile({
      modelMap: [
        { match: 'A', model: ANTHROPIC },
        { match: ANTHROPIC, model: 'C' },
      ],
    });
    expect(resolveChatClient(p, 'A').model).toBe('A');
    const body = request();
    const before = structuredClone(body);
    const result = rewrite(p, body)!;
    const messages = result.modified.messages as { content: unknown }[];
    const cached = (text: string) => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
    expect(result.modified.model).toBe(ANTHROPIC);
    expect(messages.map((message) => message.content)).toEqual([
      cached('system'),
      'oldest',
      cached('previous'),
      null,
      'result',
      cached('latest'),
    ]);
    expect(result.modified.tools).toEqual([
      { type: 'function', function: { name: 'first', parameters: {} } },
      { type: 'function', function: { name: 'second', parameters: {}, cache_control: { type: 'ephemeral' } } },
    ]);
    expect(result.modified.transforms).toEqual(['middle-out']);
    expect(body).toEqual(before);
    expect(result.stripped).toContain('goose:messages-format');
    expect(result.stripped.join(' ')).not.toContain('opaque-signature');
  });

  it('restores Google message reasoning from the first available tool metadata without changing the opaque details', () => {
    const body = request();
    const result = rewrite(profile({ modelMap: [{ match: 'A', model: FAST }] }), body)!;
    const messages = result.modified.messages as Record<string, unknown>[];
    expect(result.modified.model).toBe(FAST);
    expect(messages[3].reasoning_details).toEqual(DETAILS);
    expect(messages[3].tool_calls).toEqual((body.messages as Record<string, unknown>[])[3].tool_calls);
    expect(messages[0].content).toBe('system');
    expect(result.modified.tools).toEqual(body.tools);
  });

  it('distinguishes main A→fast and auxiliary fast→Anthropic without a routing marker or second mapping', () => {
    const p = profile({
      modelMap: [
        { match: 'A', model: FAST },
        { match: FAST, model: ANTHROPIC },
      ],
    });
    expect(rewrite(p, request('A'))?.modified.model).toBe(FAST);
    const auxiliary = rewrite(p, request(FAST))!.modified;
    expect(auxiliary.model).toBe(ANTHROPIC);
    expect(auxiliary.messages).toContainEqual({
      role: 'system',
      content: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('uses terminal per-agent models for both main and auxiliary requests', () => {
    const p = profile({
      perAgent: { 'claude-code': undefined, codex: undefined, goose: ANTHROPIC },
      modelMap: [{ match: ANTHROPIC, model: 'C' }],
    });
    for (const model of ['A', FAST]) expect(rewrite(p, request(model))?.modified.model).toBe(ANTHROPIC);
  });

  it('preserves existing request fields when the selected family changes', () => {
    const cached = rewrite(profile(), request())!.modified;
    cached.model = ANTHROPIC;
    const assistant = (cached.messages as Record<string, unknown>[])[3];
    assistant.reasoning_details = structuredClone(DETAILS);
    const original = structuredClone(cached);
    const result = rewrite(profile({ modelMap: [{ match: ANTHROPIC, model: 'z-ai/glm-5.3' }] }), cached)!;
    expect(result.modified.messages).toEqual(original.messages);
    expect(result.modified.tools).toEqual(original.tools);
    expect(result.modified.provider).toEqual({ order: ['z-ai'] });
    expect(result.modified.session_id).toBe(`session:${ANTHROPIC}`);
    expect(cached).toEqual(original);
  });

  it('preserves explicit fields and strict routing constraints', () => {
    const body = request();
    const messages = body.messages as Record<string, unknown>[];
    messages[0].content = [{ type: 'text', text: 'custom', cache_control: { type: 'ephemeral', ttl: '1h' } }];
    messages[3].reasoning_details = [{ type: 'encrypted', data: 'explicit' }];
    body.provider = { only: ['client-pin'], allow_fallbacks: false };
    const p = profile({
      modelMap: [{ match: 'A', model: FAST }],
      providerPreference: { only: ['configured-pin'], allowFallbacks: false },
    });
    expect(rewrite(p, body)?.modified).toMatchObject({ model: FAST, messages, provider: body.provider });
  });

  it('stops at an empty reasoning array and skips absent or malformed arrays', () => {
    const body = request();
    const messages = body.messages as Record<string, unknown>[];
    messages[3].tool_calls = [
      { reasoning_details: 'malformed' },
      { reasoning_details: [] },
      { reasoning_details: DETAILS },
    ];
    const result = rewrite(profile({ modelMap: [{ match: 'A', model: FAST }] }), body)!.modified;
    expect((result.messages as Record<string, unknown>[])[3].reasoning_details).toEqual([]);
    expect((result.messages as Record<string, unknown>[])[3].tool_calls).toEqual(messages[3].tool_calls);
  });

  it('leaves missing error/frontend tool metadata unreconstructed and existing cache fields intact', () => {
    const body = request();
    const messages = body.messages as Record<string, unknown>[];
    messages[3].tool_calls = [{ id: 'frontend', type: 'function', function: { name: 'frontend', arguments: '{}' } }];
    const tools = body.tools as { function: Record<string, unknown> }[];
    tools[1].function.cache_control = { type: 'ephemeral', ttl: '1h' };
    const p = profile({ modelMap: [{ match: 'A', model: FAST }] });
    expect(rewrite(p, body)?.modified).toMatchObject({ model: FAST, messages, tools });
    expect(rewrite(profile(), body)?.modified.tools).toEqual(tools);
  });

  it('leaves empty-map and unmatched fast IDs unchanged without a GLM fallback', () => {
    const empty = profile({ modelMap: [] });
    expect(rewrite(empty, request('unmatched'))).toBeNull();
    expect(rewrite(empty, request(FAST))?.modified.model).toBe(FAST);
    const seed = getGatewayDefinition('openrouter').defaultModel(empty);
    const p = profile({ modelMap: [{ match: seed, model: ANTHROPIC }] });
    for (const model of [undefined, 'unmatched']) {
      const client = resolveChatClient(p, model);
      expect(client.model).toBe(seed);
      expect(rewrite(p, request(client.model))?.modified.model).toBe(ANTHROPIC);
    }
  });

  it.each([
    { messages: null, tools: 'wrong-shape' },
    { messages: [null, 1, { role: 'assistant', tool_calls: [null, { reasoning_details: 'invalid' }] }], tools: [null] },
    { messages: [{ role: 'user', content: [null] }], tools: [{ function: null }] },
  ])('preserves routing even with unsupported message/tool shapes: %j', (fields) => {
    expect(rewrite(profile(), { model: 'A', ...fields })?.modified.model).toBe(ANTHROPIC);
  });

  it('does not apply Goose formatting to other harnesses or protocols', () => {
    const p = profile({ modelMap: [] });
    for (const [protocol, agent] of [
      ['chat', 'codex'],
      ['messages', 'goose'],
    ] as const) {
      const proxy = makeGatewayProvider(p, protocol, agent);
      expect(proxy.requestRewriter!(request(ANTHROPIC), { method: 'POST', path: '/unused' })).toBeNull();
    }
  });
});
