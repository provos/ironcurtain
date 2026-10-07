import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { loadUserConfig, userConfigSchema, HOST_MODEL_ROLES, saveUserConfig } from '../src/config/user-config.js';
import type { ResolvedZaiProfile, UserConfig } from '../src/config/user-config.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { createLanguageModel, resolveHostModelApiKey } from '../src/config/model-provider.js';
import { autoApprove } from '../src/trusted-process/auto-approver.js';
import { createClaudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { createCodexAdapter } from '../src/docker/adapters/codex.js';
import { createGooseAdapter } from '../src/docker/adapters/goose.js';
import { resolveSessionMode } from '../src/session/preflight.js';
import { makeZaiProvider } from '../src/docker/zai.js';
import { resolveZaiModel, ZAI_HOST } from '../src/config/zai.js';
import { isEndpointAllowed } from '../src/docker/provider-config.js';
import { resolveRealKey } from '../src/docker/docker-infrastructure.js';
import { resolveSseProvider } from '../src/docker/mitm-proxy.js';
import { createReassembler, AnthropicReassembler, ResponsesReassembler } from '../src/docker/trajectory-reassembler.js';

let home: string;
function config(input: UserConfig = {}) {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      modelProviders: {
        profiles: { glm: { type: 'zai', apiKey: 'host-only-zai-key' } },
      },
      ...input,
    }),
    { mode: 0o600 },
  );
  const userConfig = loadUserConfig({ readOnly: true });
  const activeProviderProfile = userConfig.modelProviders.profiles.glm;
  return { userConfig, activeProviderProfile, agentModelId: userConfig.agentModelId } as IronCurtainConfig;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'zai-profile-'));
  vi.stubEnv('IRONCURTAIN_HOME', home);
  for (const key of [
    'ZAI_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ANTHROPIC_BASE_URL',
  ])
    vi.stubEnv(key, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('Z.AI provider profiles', () => {
  it('defaults to the API plan without enabling auto-approval or changing native routing', () => {
    const c = config();
    expect(c.userConfig.modelProviders.default).toBe('native');
    expect(c.activeProviderProfile).toMatchObject({ type: 'zai', model: 'glm-5.3', plan: 'api' });
    expect(c.userConfig.autoApprove.enabled).toBe(false);
  });

  it.each([
    ['claude-opus-4-6', 'glm-5.3'],
    ['claude-sonnet-4-6', 'glm-5.3-flash'],
    ['CLAUDE-HAIKU-4-5', 'glm-5.3-flash'],
  ])('routes the default %s tier to %s', (requested, expected) => {
    const profile = config().activeProviderProfile as ResolvedZaiProfile;
    expect(resolveZaiModel(profile, requested)).toBe(expected);
  });

  it('uses a custom profile model for Opus while retaining Flash for Sonnet and Haiku', () => {
    const profile = config({ modelProviders: { profiles: { glm: { type: 'zai', model: 'custom-model' } } } })
      .activeProviderProfile as ResolvedZaiProfile;
    expect(resolveZaiModel(profile, 'claude-opus-4-6')).toBe('custom-model');
    expect(resolveZaiModel(profile, 'claude-sonnet-4-6')).toBe('glm-5.3-flash');
    expect(resolveZaiModel(profile, 'claude-haiku-4-5')).toBe('glm-5.3-flash');
    expect(resolveZaiModel(profile)).toBe('custom-model');
  });

  it('uses ZAI_API_KEY only for Z.AI profiles and preserves explicit empty maps', () => {
    vi.stubEnv('ZAI_API_KEY', 'env-zai-key');
    const c = config({
      modelProviders: {
        profiles: {
          glm: { type: 'zai', modelMap: [] },
          router: { type: 'openrouter', apiKey: 'router-key' },
        },
      },
    });
    expect(c.activeProviderProfile).toMatchObject({ apiKey: 'env-zai-key', modelMap: [], usesDefaultMap: false });
    expect(c.userConfig.modelProviders.profiles.router).toHaveProperty('apiKey', 'router-key');
    expect(resolveZaiModel(c.activeProviderProfile as ResolvedZaiProfile, 'claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('rejects unknown host profiles and invalid plan/role names', () => {
    expect(() => userConfigSchema.parse({ hostModelProfiles: { autoApprove: 'missing' } })).toThrow(
      /Unknown host model/,
    );
    expect(() => userConfigSchema.parse({ hostModelProfiles: { invalid: 'native' } })).toThrow();
    expect(() =>
      userConfigSchema.parse({ modelProviders: { profiles: { glm: { type: 'zai', plan: 'invalid' } } } }),
    ).toThrow();
  });

  it.each(['claude-code', 'codex', 'goose'] as const)('%s uses only the Z.AI credential and its protocol', (agent) => {
    const c = config();
    const adapter =
      agent === 'claude-code'
        ? createClaudeCodeAdapter(c.userConfig)
        : agent === 'codex'
          ? createCodexAdapter(c.userConfig)
          : createGooseAdapter(c.userConfig);
    const env = adapter.buildEnv(c, new Map([[ZAI_HOST, 'sentinel-zai']]));
    expect(adapter.detectCredential?.(c)).toEqual({ kind: 'apikey', key: 'host-only-zai-key' });
    expect(JSON.stringify(env)).not.toContain('host-only-zai-key');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.IRONCURTAIN_CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBeUndefined();
    expect(resolveRealKey(ZAI_HOST, c, 'unrelated-oauth')).toBe('host-only-zai-key');
    const [provider] = adapter.getProviders(c);
    expect(provider.host).toBe(ZAI_HOST);
    const path = provider.completionEndpoints?.[0].path;
    expect(path).toBe(
      agent === 'claude-code'
        ? '/api/anthropic/v1/messages'
        : agent === 'codex'
          ? '/api/v1/responses'
          : '/api/paas/v4/chat/completions',
    );
    expect(isEndpointAllowed(provider, 'POST', '/v1/messages')).toBe(false);
    expect(isEndpointAllowed(provider, 'GET', '/api/key-management')).toBe(false);
    if (agent === 'goose') {
      expect(env.OPENAI_HOST).toBe('https://api.z.ai');
      expect(env.OPENAI_BASE_PATH).toBe('api/paas/v4/chat/completions');
      expect(env.GOOSE_MODEL).toBe('glm-5.3-flash');
    } else {
      expect(env.IRONCURTAIN_MODEL).toBe('glm-5.3-flash');
    }
    if (agent === 'claude-code') {
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.3');
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.3-flash');
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.3-flash');
    }
    const noKey = { ...c, activeProviderProfile: { ...c.activeProviderProfile, apiKey: '' } } as IronCurtainConfig;
    expect(adapter.detectCredential?.(noKey)).toEqual({ kind: 'none' });
  });

  it('maps a configured selection once, including non-idempotent ordered rules', () => {
    const c = config({
      modelProviders: {
        profiles: {
          glm: {
            type: 'zai',
            modelMap: [
              { match: '*sonnet*', model: 'glm-4.7' },
              { match: 'glm-4.7', model: 'glm-5.3' },
            ],
          },
        },
      },
    });
    const adapter = createClaudeCodeAdapter(c.userConfig);
    const cmd = adapter.buildCommand('hello', '', {
      firstTurn: true,
      sessionId: 'id',
      providerProfile: c.activeProviderProfile,
      modelOverride: 'claude-sonnet-4-6',
    });
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('glm-4.7');
    const provider = adapter.getProviders(c)[0];
    expect(provider.requestRewriter?.({ model: 'glm-4.7' }, { method: 'POST', path: '' })).toBeNull();
  });

  it('honors Goose model selections in batch and PTY startup environments', () => {
    const c = config({ gooseModel: 'glm-4.7', modelProviders: { profiles: { glm: { type: 'zai', modelMap: [] } } } });
    const env = createGooseAdapter(c.userConfig).buildEnv(c, new Map([[ZAI_HOST, 'sentinel-zai']]));
    expect(env.GOOSE_MODEL).toBe('glm-4.7');
  });

  it('routes Goose internal fast requests through the profile without remapping selected main models', () => {
    const c = config({
      modelProviders: {
        profiles: {
          glm: {
            type: 'zai',
            model: 'glm-5.3',
            modelMap: [
              { match: 'gpt-4o-mini', model: 'glm-4.7' },
              { match: 'glm-4.7', model: 'glm-5.3' },
            ],
          },
        },
      },
    });
    const provider = makeZaiProvider(c.activeProviderProfile as ResolvedZaiProfile, 'goose');
    const context = { method: 'POST', path: '/api/paas/v4/chat/completions' };
    expect(provider.requestRewriter?.({ model: 'gpt-4o-mini' }, context)?.modified.model).toBe('glm-4.7');
    expect(provider.requestRewriter?.({ model: 'glm-4.7' }, context)).toBeNull();
    const defaultProvider = makeZaiProvider(config().activeProviderProfile as ResolvedZaiProfile, 'goose');
    expect(defaultProvider.requestRewriter?.({ model: 'gpt-4o-mini' }, context)?.modified.model).toBe('glm-5.3');
  });

  it('does not write an env-only Z.AI key back to disk', () => {
    vi.stubEnv('ZAI_API_KEY', 'env-only-key');
    const c = config({ modelProviders: { profiles: { glm: { type: 'zai' } } } });
    saveUserConfig({ modelProviders: { profiles: { glm: c.activeProviderProfile as ResolvedZaiProfile } } });
    vi.stubEnv('ZAI_API_KEY', '');
    expect(loadUserConfig({ readOnly: true }).modelProviders.profiles.glm).toHaveProperty('apiKey', '');
  });

  it('builds parseable Codex TOML and a scoped GLM catalog without credentials', () => {
    const c = config();
    c.agentModelId = 'anthropic:glm-5.3-flash';
    const files = createCodexAdapter(c.userConfig).generateMcpConfig('/tmp/proxy.sock', c);
    const toml = parseToml(files[0].content);
    expect(toml).toMatchObject({
      model: 'glm-5.3-flash',
      model_provider: 'zai',
      model_catalog_json: '/etc/ironcurtain/zai-models.json',
      model_providers: {
        zai: {
          base_url: 'https://api.z.ai/api/v1',
          env_key: 'ZAI_API_KEY',
          wire_api: 'responses',
          supports_websockets: false,
        },
      },
    });
    const catalog = JSON.parse(files[1].content) as { models: { slug: string }[] };
    expect(catalog.models.map((m) => m.slug)).toContain('glm-5.3-flash');
    expect(JSON.stringify(files)).not.toContain('host-only-zai-key');
  });

  it.each(['claude-code', 'codex', 'goose'] as const)('%s honors the effective per-command model override', (agent) => {
    const c = config();
    const adapter =
      agent === 'claude-code'
        ? createClaudeCodeAdapter(c.userConfig)
        : agent === 'codex'
          ? createCodexAdapter()
          : createGooseAdapter(c.userConfig);
    const cmd = adapter.buildCommand('hello', '', {
      sessionId: 'id',
      firstTurn: true,
      modelOverride: 'anthropic:glm-5.3-flash',
      providerProfile: c.activeProviderProfile,
    });
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('glm-5.3-flash');
  });

  it('keeps per-agent overrides ahead of the model map and keeps protocol classifiers distinct', () => {
    const c = config({
      modelProviders: {
        profiles: {
          glm: {
            type: 'zai',
            plan: 'coding',
            modelMap: [{ match: '*', model: 'mapped' }],
            perAgent: { goose: 'chosen' },
          },
        },
      },
    });
    const profile = c.activeProviderProfile as ResolvedZaiProfile;
    const provider = makeZaiProvider(profile, 'goose');
    expect(provider.completionEndpoints?.[0].path).toBe('/api/coding/paas/v4/chat/completions');
    expect(resolveZaiModel(profile, 'requested', 'goose')).toBe('chosen');
    expect(resolveSseProvider(ZAI_HOST, '/api/anthropic/v1/messages')).toBe('anthropic');
    expect(createReassembler(ZAI_HOST, '/api/anthropic/v1/messages')).toBeInstanceOf(AnthropicReassembler);
    expect(createReassembler(ZAI_HOST, '/api/v1/responses')).toBeInstanceOf(ResponsesReassembler);
    expect(createReassembler(ZAI_HOST, '/api/paas/v4/chat/completions')).toBeUndefined();
  });
});

describe('named profiles for host roles using the installed SDK', () => {
  it.each(HOST_MODEL_ROLES)('%s resolves independently of the Docker default', async (role) => {
    const c = config({ hostModelProfiles: { [role]: 'glm' } });
    const model = await createLanguageModel('anthropic:claude-haiku-4-5', c.userConfig, role);
    expect(model.modelId).toBe('glm-5.3-flash');
    expect(model.provider).toBe('zai.chat');
    expect(resolveHostModelApiKey('anthropic:claude-haiku-4-5', c.userConfig, role)).toBe('host-only-zai-key');
  });

  it('allows preferred builtin startup with only a named agent profile credential', async () => {
    const c = config({ preferredMode: 'builtin', hostModelProfiles: { agent: 'glm' } });
    const result = await resolveSessionMode({
      config: c,
      isDockerAvailable: async () => {
        throw new Error('Builtin must not probe Docker');
      },
    });
    expect(result.mode.kind).toBe('builtin');
  });

  it('supports OpenRouter host profiles without forcing the Responses API', async () => {
    const c = config({
      modelProviders: { profiles: { glm: { type: 'openrouter', apiKey: 'router-key' } } },
      hostModelProfiles: { summary: 'glm' },
    });
    const model = await createLanguageModel('anthropic:claude-haiku-4-5', c.userConfig, 'summary');
    expect(model.modelId).toBe('z-ai/glm-5.3-flash');
    expect(model.provider).toBe('openrouter.chat');
  });

  it('preserves strict OpenRouter provider constraints on host wire requests', async () => {
    const c = config({
      modelProviders: {
        profiles: {
          glm: {
            type: 'openrouter',
            apiKey: 'router-key',
            providerPreference: { only: ['approved-provider'], allowFallbacks: false },
          },
        },
      },
      hostModelProfiles: { policy: 'glm' },
    });
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('Expected JSON body');
        body = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'pinned-chat',
            created: 1,
            model: 'z-ai/glm-5.3-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { generateText } = await import('ai');
    const model = await createLanguageModel(c.userConfig.policyModelId, c.userConfig, 'policy');
    await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });
    expect(body).toMatchObject({
      model: 'z-ai/glm-5.3-flash',
      provider: { only: ['approved-provider'], allow_fallbacks: false },
    });
  });

  it('sends JSON mode to Z.AI and still validates auto-approver output', async () => {
    const c = config({ hostModelProfiles: { autoApprove: 'glm' }, autoApprove: { enabled: true } });
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    let content = JSON.stringify({ decision: 'approve', reasoning: 'Explicitly authorized.' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
        requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return new Response(
          JSON.stringify({
            id: 'chat-id',
            created: 1,
            model: 'glm-5.3-flash',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const model = await createLanguageModel(c.userConfig.autoApprove.modelId, c.userConfig, 'autoApprove');
    const context = {
      userMessage: 'Read /workspace/example.txt',
      toolName: 'filesystem/read_file',
      escalationReason: 'Read permission',
      arguments: { path: '/workspace/example.txt' },
    };
    expect((await autoApprove(context, model)).decision).toBe('approve');
    expect(requests[0]).toMatchObject({
      url: 'https://api.z.ai/api/paas/v4/chat/completions',
      body: { model: 'glm-5.3-flash', response_format: { type: 'json_object' } },
    });
    expect(JSON.stringify(requests[0].body.messages)).toContain('Return JSON matching this schema');
    content = JSON.stringify({ decision: 'invalid' });
    expect((await autoApprove(context, model)).decision).toBe('escalate');
  });

  it('keeps native host roles independent and fails clearly for missing gateway credentials', async () => {
    const c = config({ modelProviders: { default: 'glm', profiles: { glm: { type: 'zai' } } } });
    const native = await createLanguageModel('anthropic:claude-haiku-4-5', c.userConfig, 'summary');
    expect(native.provider).toBe('anthropic.messages');
    await expect(
      createLanguageModel('glm-5.3', { ...c.userConfig, hostModelProfiles: { summary: 'glm' } }, 'summary'),
    ).rejects.toThrow(/No API key.*glm/);
  });
});
