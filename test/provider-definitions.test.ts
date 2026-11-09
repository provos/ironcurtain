import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import * as definitions from '../src/config/provider-definitions.js';
import type { GatewayDefinition, GatewayProfile } from '../src/config/provider-definitions.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedProviderProfile } from '../src/config/user-config.js';
import { userConfigSchema } from '../src/config/user-config.js';
import { resolveMessagesClient, resolveResponsesClient, resolveChatClient } from '../src/config/gateway-client.js';
import { buildProviderEditorOptions } from '../src/config/config-command.js';
import { resolvedGatewayToInput } from '../src/config/provider-editor.js';
import { makeGatewayProvider } from '../src/docker/gateway-runtime.js';
import { resolveRealKey } from '../src/docker/docker-infrastructure.js';
import { isEndpointAllowed } from '../src/docker/provider-config.js';
import { createClaudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { createCodexAdapter } from '../src/docker/adapters/codex.js';
import { createGooseAdapter } from '../src/docker/adapters/goose.js';

/** Test registration only; the persisted configuration still accepts built-in services exclusively. */
const compatible: GatewayDefinition = {
  ...definitions.getGatewayDefinition('zai'),
  id: 'fixture',
  label: 'Compatible fixture',
  host: 'models.example.test',
  defaultModel: (profile) => profile.model ?? 'fixture-large',
  fakeKeyPrefix: 'fixture-sentinel-',
  baseUrls: () => ({
    messages: 'https://models.example.test/anthropic',
    responses: 'https://models.example.test/v1',
    chat: 'https://models.example.test/chat/v1',
  }),
  proxyPaths: () => ({
    messages: { completion: '/anthropic/v1/messages', additional: [] },
    responses: { completion: '/v1/responses', additional: [] },
    chat: { completion: '/chat/v1/chat/completions', additional: [] },
  }),
  codex: { credentialEnv: 'FIXTURE_API_KEY', catalog: true },
  models: { 'fixture-fast': { contextWindow: 32000, inputModalities: ['text'] } },
  editor: {
    id: 'fixture',
    label: 'Compatible fixture',
    description: 'A test-only compatible provider.',
    credentialEnv: 'FIXTURE_API_KEY',
    credentialPlaceholder: 'Fixture key',
    modelPlaceholder: 'fixture-fast',
    catalog: 'manual',
    model: { label: 'Default fixture model', defaultValue: 'fixture-large', defaultMapMatch: '*opus*' },
    plan: { defaultValue: 'standard', choices: [{ value: 'standard', label: 'Fixture standard' }] },
    providerRouting: false,
    sessionAffinity: false,
    defaultMap: [
      { match: '*opus*', model: 'fixture-large' },
      { match: '*sonnet*', model: 'fixture-fast' },
    ],
  },
};
function profile(): GatewayProfile {
  return {
    type: 'fixture',
    apiKey: 'host-only-real-key',
    model: 'fixture-large',
    plan: 'standard',
    modelMap: compatible.editor.defaultMap,
    usesDefaultMap: true,
    perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
  };
}
function config(p = profile()): IronCurtainConfig {
  return {
    activeProviderProfile: p as ResolvedProviderProfile,
    agentModelId: 'anthropic:claude-sonnet',
  } as IronCurtainConfig;
}
function registerFixture() {
  const original = definitions.getGatewayDefinition;
  vi.spyOn(definitions, 'getGatewayDefinition').mockImplementation((id) =>
    id === compatible.id ? compatible : original(id),
  );
}
afterEach(() => vi.restoreAllMocks());

it('generates all three harness configurations from one compatible definition', () => {
  registerFixture();
  const c = config();
  expect(resolveRealKey(compatible.host, c, 'unrelated-oauth')).toBe('host-only-real-key');
  expect(resolveRealKey('unconfigured.example.test', c, undefined)).toBe('');
  const sentinel = new Map([[compatible.host, 'fixture-sentinel-token']]);
  const claude = createClaudeCodeAdapter();
  const codex = createCodexAdapter();
  const goose = createGooseAdapter();
  expect(claude.buildEnv(c, sentinel)).toMatchObject({
    ANTHROPIC_BASE_URL: compatible.baseUrls(profile()).messages,
    ANTHROPIC_AUTH_TOKEN: 'fixture-sentinel-token',
    IRONCURTAIN_MODEL: 'fixture-fast',
  });
  expect(codex.buildEnv(c, sentinel)).toMatchObject({
    FIXTURE_API_KEY: 'fixture-sentinel-token',
    IRONCURTAIN_MODEL: 'fixture-fast',
  });
  expect(goose.buildEnv(c, sentinel)).toMatchObject({
    GOOSE_PROVIDER: 'openai',
    GOOSE_MODEL: 'fixture-fast',
    OPENAI_API_KEY: 'fixture-sentinel-token',
    OPENAI_HOST: 'https://models.example.test',
    OPENAI_BASE_PATH: 'chat/v1/chat/completions',
  });
  const files = codex.generateMcpConfig('/tmp/mcp.sock', c);
  const toml = parseToml(files.find((file) => file.path === 'codex-config.toml')!.content);
  expect(toml).toMatchObject({
    model: 'fixture-fast',
    model_provider: 'fixture',
    model_providers: {
      fixture: {
        name: compatible.label,
        base_url: compatible.baseUrls(profile()).responses,
        env_key: 'FIXTURE_API_KEY',
        wire_api: 'responses',
      },
    },
  });
  const catalog = JSON.parse(files.find((file) => file.path === 'fixture-models.json')!.content) as {
    models: { slug: string; context_window: number }[];
  };
  expect(catalog.models.find((model) => model.slug === 'fixture-fast')?.context_window).toBe(32000);
  for (const adapter of [claude, codex, goose]) {
    const providers = adapter.getProviders(c);
    expect(providers[0]).toMatchObject({ id: 'fixture', host: compatible.host });
    expect(JSON.stringify(adapter.buildEnv(c, sentinel))).not.toContain('host-only-real-key');
    expect(adapter.detectCredential(c)).toEqual({ kind: 'apikey', key: 'host-only-real-key' });
    const command = adapter.buildCommand('hello', 'system', {
      sessionId: 'fixture-session',
      firstTurn: true,
      modelOverride: 'anthropic:claude-sonnet',
      providerProfile: c.activeProviderProfile,
    });
    expect(command).toContain('fixture-fast');
  }
});

it('uses the same provider descriptor to project CLI persistence fields without credentials in metadata', () => {
  const stored = resolvedGatewayToInput(profile(), compatible.editor);
  const controls = buildProviderEditorOptions(stored, compatible.editor);
  expect(controls.find((control) => control.value === 'model')).toMatchObject({
    label: 'Default fixture model',
    hint: 'fixture-large',
  });
  expect(controls.find((control) => control.value === 'plan')).toMatchObject({ hint: 'standard' });
  expect(controls.some((control) => control.value === 'providerPreference')).toBe(false);
  expect(controls.some((control) => control.value === 'sessionAffinity')).toBe(false);
  expect(stored).toMatchObject({ type: 'fixture', plan: 'standard', model: 'fixture-large' });
  expect(stored.modelMap).toBeUndefined();
  expect(stored.providerPreference).toBeUndefined();
  expect(stored.sessionAffinity).toBeUndefined();
  expect(
    resolvedGatewayToInput({ ...profile(), usesDefaultMap: false, modelMap: [] }, compatible.editor).modelMap,
  ).toEqual([]);
  expect(JSON.stringify(definitions.getProviderEditorDescriptors())).not.toContain('apiKey');
  expect(
    userConfigSchema.safeParse({
      modelProviders: { profiles: { custom: { type: 'fixture', endpoint: 'https://models.example.test' } } },
    }).success,
  ).toBe(false);
});

it('declares authorized endpoints independently of the client endpoint and snapshots routing', () => {
  const map = [{ match: 'A', model: 'B' }];
  const perAgent = { 'claude-code': undefined, codex: undefined, goose: undefined };
  const p = { ...profile(), modelMap: map, perAgent };
  const definition = {
    ...compatible,
    modelSelection: 'proxy' as const,
    baseUrls: () => ({
      messages: 'https://models.example.test/untrusted',
      responses: 'https://models.example.test/untrusted',
      chat: 'https://models.example.test/untrusted',
    }),
  };
  const proxy = makeGatewayProvider(p, 'responses', 'codex', definition);
  map[0].model = 'C';
  expect(isEndpointAllowed(proxy, 'POST', '/untrusted/responses')).toBe(false);
  expect(isEndpointAllowed(proxy, 'POST', '/v1/responses')).toBe(true);
  expect(proxy.requestRewriter?.({ model: 'A' }, { method: 'POST', path: '/v1/responses' })?.modified.model).toBe('B');
});

describe('model resolution provenance', () => {
  it('honors per-agent overrides and the first case-insensitive rule, while host selections ignore Docker overrides', () => {
    const p = {
      ...profile(),
      perAgent: { ...profile().perAgent, codex: 'forced' },
      modelMap: [
        { match: '*sonnet*', model: 'first' },
        { match: '*', model: 'second' },
      ],
    };
    expect(definitions.resolveGatewayModel(p, 'anthropic:CLAUDE-SONNET', {}, compatible)).toMatchObject({
      selected: 'first',
      source: 'map',
    });
    expect(definitions.resolveGatewayModel(p, 'anthropic:CLAUDE-SONNET', { agent: 'codex' }, compatible)).toMatchObject(
      { selected: 'forced', source: 'per-agent' },
    );
  });
  it('keeps request identity and does not remap client-owned main requests at the proxy', () => {
    const p = {
      ...profile(),
      modelMap: [
        { match: 'A', model: 'B' },
        { match: 'B', model: 'C' },
      ],
      usesDefaultMap: false,
    };
    const selected = definitions.resolveGatewayModel(p, 'A', {}, compatible);
    expect(selected).toMatchObject({ requested: 'A', selected: 'B', source: 'map' });
    const proxy = makeGatewayProvider(p, 'responses', 'codex', compatible);
    expect(resolveResponsesClient(p, 'A', compatible).model).toBe('B');
    expect(proxy.requestRewriter?.({ model: 'B' }, { method: 'POST', path: '/v1/responses' })).toBeNull();
    expect(resolveMessagesClient(p, 'A', compatible).model).toBe('B');
    expect(resolveChatClient(p, 'A', compatible).model).toBe('B');
  });
});

describe('proxy-owned routing maps once across harness requests', () => {
  const definition = definitions.getGatewayDefinition('openrouter');
  const seed = definition.defaultModel(profile());
  function router(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
    return {
      ...profile(),
      type: 'openrouter',
      model: undefined,
      plan: undefined,
      usesDefaultMap: false,
      modelMap: [
        { match: 'claude-sonnet', model: 'B' },
        { match: seed, model: 'B' },
        { match: 'A', model: 'B' },
        { match: 'B', model: 'C' },
      ],
      ...overrides,
    };
  }
  function served(
    p: GatewayProfile,
    protocol: 'messages' | 'responses' | 'chat',
    request: string,
    agent: 'claude-code' | 'codex' | 'goose',
  ) {
    const proxy = makeGatewayProvider(p, protocol, agent, definition, agent === 'goose' ? ['gpt-4o-mini'] : []);
    return (
      proxy.requestRewriter?.({ model: request }, { method: 'POST', path: proxy.completionEndpoints![0].path })
        ?.modified.model ?? request
    );
  }
  it('retains startup wire seeds while the proxy maps them to B, not C', () => {
    const p = router();
    const messages = resolveMessagesClient(p, 'A', definition);
    const responses = resolveResponsesClient(p, 'A', definition);
    const chat = resolveChatClient(p, 'A', definition);
    expect(messages.aliases.SONNET).toBe('claude-sonnet');
    expect(served(p, 'messages', messages.aliases.SONNET, 'claude-code')).toBe('B');
    expect(responses.model).toBe(seed);
    expect(responses.selectedModel).toBe('B');
    expect(served(p, 'responses', responses.model, 'codex')).toBe('B');
    expect(responses.catalogModels).toEqual([{ id: seed, contextWindow: 200000, inputModalities: ['text'] }]);
    expect(chat.model).toBe('A');
    expect(served(p, 'chat', chat.model, 'goose')).toBe('B');
  });
  it.each(['messages', 'responses', 'chat'] as const)(
    'maps fresh %s requests once and treats per-agent targets as terminal',
    (protocol) => {
      const agent = protocol === 'messages' ? 'claude-code' : protocol === 'responses' ? 'codex' : 'goose';
      expect(served(router(), protocol, 'A', agent)).toBe('B');
      const p = router({ perAgent: { ...profile().perAgent, [agent]: 'B' } });
      expect(served(p, protocol, 'unmatched', agent)).toBe('B');
    },
  );
  it.each([createClaudeCodeAdapter, createCodexAdapter, createGooseAdapter])(
    'retains fresh command override identity until the proxy resolves it',
    (create) => {
      const p = router();
      const adapter = create();
      const command = adapter.buildCommand('hello', 'system', {
        sessionId: 'command',
        firstTurn: true,
        modelOverride: 'anthropic:A',
        providerProfile: p as ResolvedProviderProfile,
      });
      expect(command[command.indexOf('--model') + 1]).toBe('A');
      const protocol = adapter.id === 'claude-code' ? 'messages' : adapter.id === 'codex' ? 'responses' : 'chat';
      expect(served(p, protocol, 'A', adapter.id)).toBe('B');
    },
  );
  it('distinguishes no request, unmatched fallback seeds, and explicit empty maps', () => {
    const p = router();
    for (const request of [undefined, 'unmatched']) {
      const client = resolveChatClient(p, request, definition);
      expect(client.model).toBe(seed);
      expect(served(p, 'chat', client.model, 'goose')).toBe('B');
    }
    const empty = router({ modelMap: [] });
    expect(served(empty, 'messages', 'A', 'claude-code')).toBe('A');
    expect(resolveChatClient(empty, 'unmatched', definition).model).toBe(seed);
    expect(served(empty, 'chat', 'gpt-4o-mini', 'goose')).toBe('gpt-4o-mini');
  });
  it('keeps provider pins and affinity based on the fresh request identity', () => {
    const p = router({
      modelMap: [
        { match: 'A', model: 'z-ai/B' },
        { match: 'z-ai/B', model: 'z-ai/C' },
      ],
      sessionAffinity: true,
      providerPreference: { only: ['approved'], allowFallbacks: false },
    });
    const proxy = makeGatewayProvider(p, 'messages', 'claude-code', definition);
    expect(
      proxy.requestRewriter?.({ model: 'A' }, { method: 'POST', path: '/api/v1/messages', cacheKey: 'session' })
        ?.modified,
    ).toMatchObject({
      model: 'z-ai/B',
      session_id: 'session:A',
      provider: { only: ['approved'], allow_fallbacks: false },
    });
  });
});
