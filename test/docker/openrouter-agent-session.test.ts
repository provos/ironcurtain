/**
 * Adapter/session-level tests for OpenRouter routing (G5, §12.3).
 *
 * These exercise each adapter's `buildEnv()` / `getProviders()` /
 * `generateMcpConfig()` / `detectCredential()` under an openrouter-type active
 * profile, plus the session-level resolution/stamp semantics (cross-session
 * isolation, non-interactive default reach, m5 fail-fast). Direct adapter unit
 * assertions are used where sufficient (the spec's preferred approach for these
 * pre-container checks); the profile-resolution point is exercised via the pure
 * `resolveActiveProfile` + stamp rather than full infra prep.
 *
 * Selection-plumbing wiring (`--provider-profile`, the mux picker, resume) is
 * G13; the D6 cost-accumulation test is G6. Neither is covered here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeCodeAdapter } from '../../src/docker/adapters/claude-code.js';
import { createCodexAdapter } from '../../src/docker/adapters/codex.js';
import { createGooseAdapter } from '../../src/docker/adapters/goose.js';
import { generateFakeKey } from '../../src/docker/fake-keys.js';
import { DockerAgentSession, type DockerAgentSessionDeps } from '../../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { getTokenStreamBus, resetTokenStreamBus } from '../../src/docker/token-stream-bus.js';
import type { TokenStreamEvent } from '../../src/docker/token-stream-types.js';
import {
  DEFAULT_GLM_SLUG,
  DEFAULT_MODEL_MAP,
  OPENROUTER_BASE_URL,
  OPENROUTER_HOST,
  resolveActiveProfile,
} from '../../src/config/user-config.js';
import type {
  DockerAgent,
  ResolvedModelProvidersConfig,
  ResolvedOpenRouterProfile,
  ResolvedProviderProfile,
} from '../../src/config/user-config.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { AgentConversationId, BundleId, SessionId } from '../../src/session/types.js';
import type { DockerExecResult } from '../../src/docker/types.js';
import {
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
  scriptedExec,
} from '../helpers/docker-mocks.js';

// ─── Fixtures ────────────────────────────────────────────────

const REAL_OPENROUTER_KEY = 'sk-or-v1-REAL-configured-key';

/** Structurally valid fake key with OpenRouter's shape; distinct from the real key. */
const FAKE_OPENROUTER_KEY = generateFakeKey('sk-or-v1-ironcurtain-');

/** A fake-keys map with the OpenRouter host entry every openrouter buildEnv reads. */
function openrouterFakeKeys(): Map<string, string> {
  return new Map([[OPENROUTER_HOST, FAKE_OPENROUTER_KEY]]);
}

/** Builds a resolved openrouter profile with sensible defaults, overridable. */
function openrouterProfile(overrides: Partial<ResolvedOpenRouterProfile> = {}): ResolvedOpenRouterProfile {
  const { perAgent: perAgentOverride, ...rest } = overrides;
  const perAgent: Record<DockerAgent, string | undefined> = {
    'claude-code': undefined,
    goose: undefined,
    codex: undefined,
    ...perAgentOverride,
  };
  return {
    type: 'openrouter',
    apiKey: REAL_OPENROUTER_KEY,
    modelMap: DEFAULT_MODEL_MAP,
    usesDefaultMap: true,
    providerPreference: undefined,
    sessionAffinity: true,
    ...rest,
    perAgent,
  };
}

/** Minimal config carrying a stamped active profile (what the adapters read). */
function configWithProfile(
  profile: ResolvedProviderProfile,
  userConfig: Partial<IronCurtainConfig['userConfig']> = {},
): IronCurtainConfig {
  return {
    userConfig: { anthropicApiKey: 'sk-test', ...userConfig },
    activeProviderProfile: profile,
  } as unknown as IronCurtainConfig;
}

// ─── Claude Code (§9.1) ──────────────────────────────────────

describe('OpenRouter — Claude Code adapter', () => {
  const adapter = createClaudeCodeAdapter();

  it('getProviders returns exactly the messages-kind OpenRouter provider', () => {
    const config = configWithProfile(openrouterProfile());
    const providers = adapter.getProviders(config, 'apikey');
    expect(providers).toHaveLength(1);
    const provider = providers[0];
    expect(provider.host).toBe(OPENROUTER_HOST);
    expect(provider.keyInjection).toEqual({ type: 'bearer' });
    expect(provider.fakeKeyPrefix).toBe('sk-or-v1-ironcurtain-');
    // messages kind: completion path + count_tokens (D5) + models metadata.
    expect(provider.allowedEndpoints).toContainEqual({ method: 'POST', path: '/api/v1/messages' });
    expect(provider.allowedEndpoints).toContainEqual({ method: 'POST', path: '/api/v1/messages/count_tokens' });
    expect(provider.allowedEndpoints).toContainEqual({ method: 'GET', path: '/api/v1/models' });
    // No anthropic host is allowlisted (decision B).
    expect(provider.allowedEndpoints).not.toContainEqual({ method: 'POST', path: '/api/v1/chat/completions' });
    expect(provider.rewriteEndpoints).toEqual(['/api/v1/messages']);
  });

  it('buildEnv sets BASE_URL, bearer AUTH_TOKEN=fake, betas-disabled, and three per-tier hints', () => {
    const config = configWithProfile(openrouterProfile());
    const env = adapter.buildEnv(config, openrouterFakeKeys());

    expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_BASE_URL);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(FAKE_OPENROUTER_KEY);
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');

    // m2: DEFAULT_MODEL_MAP *sonnet*/*opus*/*haiku* globs all map to the GLM slug.
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(DEFAULT_GLM_SLUG);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(DEFAULT_GLM_SLUG);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(DEFAULT_GLM_SLUG);
  });

  it('buildEnv resolves per-tier hints via perAgent override when set (perAgent WINS over modelMap)', () => {
    const config = configWithProfile(openrouterProfile({ perAgent: { 'claude-code': 'anthropic/claude-3.5-sonnet' } }));
    const env = adapter.buildEnv(config, openrouterFakeKeys());
    // All three tiers collapse to the perAgent value (D1: perAgent ?? map).
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-3.5-sonnet');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-3.5-sonnet');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-3.5-sonnet');
  });

  it('buildEnv omits a per-tier hint when neither perAgent nor a glob rule resolves', () => {
    // Empty map + no perAgent => the probe strings never map, so all three hints omit.
    const config = configWithProfile(openrouterProfile({ modelMap: [] }));
    const env = adapter.buildEnv(config, openrouterFakeKeys());
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it('B2c: buildEnv sets NO CLAUDE_CODE_OAUTH_TOKEN / IRONCURTAIN_API_KEY, even with host OAuth creds', () => {
    // An openrouter profile overrides OAuth detection: even a config marked
    // dockerAuth.kind='oauth' with an anthropic key present must produce ONLY
    // the ANTHROPIC_AUTH_TOKEN bearer var.
    const config = configWithProfile(openrouterProfile(), { anthropicApiKey: 'sk-ant-real' });
    config.dockerAuth = { kind: 'oauth' };
    const env = adapter.buildEnv(config, openrouterFakeKeys());

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(FAKE_OPENROUTER_KEY);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.IRONCURTAIN_API_KEY).toBeUndefined();
  });

  it('B2a: detectCredential returns apikey when the openrouter profile apiKey is non-empty', () => {
    const config = configWithProfile(openrouterProfile());
    const result = adapter.detectCredential!(config);
    expect(result.kind).toBe('apikey');
    if (result.kind !== 'apikey') throw new Error('expected apikey');
    expect(result.key).toBe(REAL_OPENROUTER_KEY);
  });

  it('B2a: detectCredential returns none when the openrouter profile apiKey is empty (feeds m5)', () => {
    const config = configWithProfile(openrouterProfile({ apiKey: '' }));
    expect(adapter.detectCredential!(config).kind).toBe('none');
  });

  it('detectCredential returns undefined for a native profile (defers to detectAuthMethod)', () => {
    const config = configWithProfile({ type: 'native' });
    expect(adapter.detectCredential!(config)).toBeUndefined();
  });
});

// ─── Codex (§9.2) ────────────────────────────────────────────

describe('OpenRouter — Codex adapter', () => {
  const adapter = createCodexAdapter();

  it('getProviders returns exactly the responses-kind OpenRouter provider', () => {
    const providers = adapter.getProviders(configWithProfile(openrouterProfile()));
    expect(providers).toHaveLength(1);
    const provider = providers[0];
    expect(provider.host).toBe(OPENROUTER_HOST);
    expect(provider.keyInjection).toEqual({ type: 'bearer' });
    expect(provider.allowedEndpoints).toContainEqual({ method: 'POST', path: '/api/v1/responses' });
    expect(provider.allowedEndpoints).toContainEqual({ method: 'GET', path: '/api/v1/models' });
    expect(provider.rewriteEndpoints).toEqual(['/api/v1/responses']);
  });

  it('B1/D2: generateMcpConfig emits top-level model_provider=openrouter and model=perAgent.codex', () => {
    const config = configWithProfile(openrouterProfile({ perAgent: { codex: 'z-ai/glm-5.2-air' } }));
    const files = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', config);
    expect(files).toHaveLength(1);

    // Parse with a REAL TOML parser to catch "root key captured by a preceding table".
    const parsed = parseToml(files[0].content) as Record<string, unknown>;
    expect(parsed.model_provider).toBe('openrouter');
    expect(parsed.model).toBe('z-ai/glm-5.2-air');

    // The provider table carries the OpenRouter base_url / env_key / wire_api.
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.openrouter.base_url).toBe('https://openrouter.ai/api/v1');
    expect(providers.openrouter.env_key).toBe('OPENROUTER_API_KEY');
    expect(providers.openrouter.wire_api).toBe('responses');

    // The existing MCP + projects tables survive.
    const projects = parsed.projects as Record<string, Record<string, unknown>>;
    expect(projects['/workspace'].trust_level).toBe('trusted');
    const mcp = parsed.mcp_servers as Record<string, Record<string, unknown>>;
    expect(mcp.ironcurtain.command).toBe('socat');
  });

  it('D2: generateMcpConfig maps DEFAULT_GLM_SLUG through modelMap so config.toml matches the served model', () => {
    // A wildcard map remaps everything (including the GLM default). Codex's
    // config.toml model must reflect what the MITM rewriter actually serves
    // (D1 re-globs whatever Codex sends), not the pre-map default — otherwise
    // the container budgets its context window for a model it isn't routed to.
    const config = configWithProfile(openrouterProfile({ modelMap: [{ match: '*', model: 'openai/gpt-5' }] }));
    const parsed = parseToml(adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', config)[0].content) as Record<
      string,
      unknown
    >;
    expect(parsed.model).toBe('openai/gpt-5');
    expect(parsed.model_provider).toBe('openrouter');
  });

  it('D2: generateMcpConfig falls back to DEFAULT_GLM_SLUG when the modelMap matches nothing (never a passthrough)', () => {
    // The default *sonnet*/*opus*/*haiku* map does not match the GLM default slug,
    // so codexSlugFor stays DEFAULT_GLM_SLUG — never an unmapped external id.
    const config = configWithProfile(openrouterProfile({ modelMap: [{ match: '*sonnet*', model: 'z-ai/glm-5.2' }] }));
    const parsed = parseToml(adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', config)[0].content) as Record<
      string,
      unknown
    >;
    expect(parsed.model).toBe(DEFAULT_GLM_SLUG);
    expect(parsed.model_provider).toBe('openrouter');
  });

  it('generateMcpConfig emits no OpenRouter keys for a native profile (byte-identical to today)', () => {
    const nativeContent = adapter.generateMcpConfig(
      '/run/ironcurtain/proxy.sock',
      configWithProfile({ type: 'native' }),
    )[0].content;
    // No config stamped at all → same native output.
    const absentContent = adapter.generateMcpConfig('/run/ironcurtain/proxy.sock', {} as IronCurtainConfig)[0].content;
    expect(nativeContent).toBe(absentContent);
    const parsed = parseToml(nativeContent) as Record<string, unknown>;
    expect(parsed.model).toBeUndefined();
    expect(parsed.model_provider).toBeUndefined();
    expect(parsed.model_providers).toBeUndefined();
  });

  it('buildEnv sets OPENROUTER_API_KEY=fake and drops the Codex OAuth env', () => {
    const env = adapter.buildEnv(configWithProfile(openrouterProfile()), openrouterFakeKeys());
    expect(env.OPENROUTER_API_KEY).toBe(FAKE_OPENROUTER_KEY);
    expect(env.CODEX_HOME).toBe('/home/codespace/.codex');
    // Codex OAuth env is gone.
    expect(env.IRONCURTAIN_CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.IRONCURTAIN_CODEX_ID_TOKEN).toBeUndefined();
    expect(env.IRONCURTAIN_CODEX_ACCOUNT_ID).toBeUndefined();
  });

  it('detectCredential returns apikey/none keyed on the openrouter profile apiKey', () => {
    expect(adapter.detectCredential!(configWithProfile(openrouterProfile())).kind).toBe('apikey');
    expect(adapter.detectCredential!(configWithProfile(openrouterProfile({ apiKey: '' }))).kind).toBe('none');
  });
});

// ─── Goose (§9.3) ────────────────────────────────────────────

describe('OpenRouter — Goose adapter', () => {
  it('getProviders returns exactly the chat-kind OpenRouter provider', () => {
    const adapter = createGooseAdapter();
    const providers = adapter.getProviders(configWithProfile(openrouterProfile()));
    expect(providers).toHaveLength(1);
    const provider = providers[0];
    expect(provider.host).toBe(OPENROUTER_HOST);
    expect(provider.keyInjection).toEqual({ type: 'bearer' });
    expect(provider.allowedEndpoints).toContainEqual({ method: 'POST', path: '/api/v1/chat/completions' });
    expect(provider.rewriteEndpoints).toEqual(['/api/v1/chat/completions']);
  });

  it('buildEnv sets GOOSE_PROVIDER=openrouter, OPENROUTER_API_KEY=fake, GOOSE_MODEL via perAgent', () => {
    const adapter = createGooseAdapter();
    const config = configWithProfile(openrouterProfile({ perAgent: { goose: 'moonshot/kimi-k3' } }));
    const env = adapter.buildEnv(config, openrouterFakeKeys());
    expect(env.GOOSE_PROVIDER).toBe('openrouter');
    expect(env.OPENROUTER_API_KEY).toBe(FAKE_OPENROUTER_KEY);
    // D2: perAgent.goose wins.
    expect(env.GOOSE_MODEL).toBe('moonshot/kimi-k3');
  });

  it('D2: GOOSE_MODEL falls back to modelMap match against gooseModel when no perAgent', () => {
    // gooseModel default is a claude-sonnet id; the DEFAULT_MODEL_MAP *sonnet*
    // rule maps it to the GLM slug.
    const adapter = createGooseAdapter();
    const config = configWithProfile(openrouterProfile());
    const env = adapter.buildEnv(config, openrouterFakeKeys());
    expect(env.GOOSE_MODEL).toBe(DEFAULT_GLM_SLUG);
  });

  it('D2: GOOSE_MODEL falls back to DEFAULT_GLM_SLUG when no perAgent and no modelMap match', () => {
    // Empty map + a non-matching gooseModel: neither perAgent nor the map
    // resolves, so the slug must be DEFAULT_GLM_SLUG (never a passthrough).
    const adapter = createGooseAdapter();
    const config = configWithProfile(openrouterProfile({ modelMap: [] }));
    const env = adapter.buildEnv(config, openrouterFakeKeys());
    expect(env.GOOSE_MODEL).toBe(DEFAULT_GLM_SLUG);
  });

  it('detectCredential returns apikey/none keyed on the openrouter profile apiKey', () => {
    const adapter = createGooseAdapter();
    expect(adapter.detectCredential!(configWithProfile(openrouterProfile())).kind).toBe('apikey');
    expect(adapter.detectCredential!(configWithProfile(openrouterProfile({ apiKey: '' }))).kind).toBe('none');
  });
});

// ─── Fake-vs-real key discipline (all agents) ────────────────

describe('OpenRouter — fake/real key discipline (all agents)', () => {
  it('the fake key never equals the real key, and the real key is absent from every container env', () => {
    expect(FAKE_OPENROUTER_KEY).not.toBe(REAL_OPENROUTER_KEY);

    const config = configWithProfile(openrouterProfile());
    const fakeKeys = openrouterFakeKeys();
    const envs = [
      createClaudeCodeAdapter().buildEnv(config, fakeKeys),
      createCodexAdapter().buildEnv(config, fakeKeys),
      createGooseAdapter().buildEnv(config, fakeKeys),
    ];
    for (const env of envs) {
      for (const value of Object.values(env)) {
        expect(value).not.toBe(REAL_OPENROUTER_KEY);
      }
    }
  });
});

// ─── Native-profile parity (OpenRouter OFF) ──────────────────

describe('OpenRouter OFF — native profile is byte-identical to today', () => {
  const nativeConfig = configWithProfile({ type: 'native' });
  const absentConfig = { userConfig: { anthropicApiKey: 'sk-test' } } as unknown as IronCurtainConfig;

  it('Claude Code getProviders returns the native anthropic providers', () => {
    const adapter = createClaudeCodeAdapter();
    for (const config of [nativeConfig, absentConfig]) {
      const providers = adapter.getProviders(config);
      expect(providers.map((p) => p.host)).toEqual(['api.anthropic.com', 'platform.claude.com']);
    }
  });

  it('Claude Code buildEnv (API-key mode) matches the pre-OpenRouter env exactly', () => {
    const adapter = createClaudeCodeAdapter();
    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = adapter.buildEnv(nativeConfig, fakeKeys);
    expect(env).toEqual({
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
      // Forces subagents synchronous (issue #367); set on every path — native
      // and OpenRouter — not an OpenRouter-specific var.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      IRONCURTAIN_API_KEY: 'sk-ant-api03-ironcurtain-FAKE',
    });
    // No OpenRouter vars leaked in.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('Codex getProviders/buildEnv return the native ChatGPT config', () => {
    const adapter = createCodexAdapter();
    expect(adapter.getProviders(nativeConfig).map((p) => p.host)).toEqual(['chatgpt.com', 'auth.openai.com']);
    const env = adapter.buildEnv(nativeConfig, new Map([['chatgpt.com', 'codex-fake-token']]));
    expect(env.IRONCURTAIN_CODEX_ACCESS_TOKEN).toBe('codex-fake-token');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('Goose getProviders/buildEnv return the native single-provider config', () => {
    const adapter = createGooseAdapter();
    expect(adapter.getProviders(nativeConfig).map((p) => p.host)).toEqual(['api.anthropic.com']);
    const env = adapter.buildEnv(nativeConfig, new Map([['api.anthropic.com', 'sk-ant-fake']]));
    expect(env.GOOSE_PROVIDER).toBe('anthropic');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });
});

// ─── m5 fail-fast (empty resolved apiKey) ────────────────────

describe('OpenRouter — m5 fail-fast on missing key', () => {
  it('the profile resolution + guard throws before container launch when apiKey is empty', async () => {
    // The fail-fast guard lives in prepareDockerInfrastructure right after the
    // profile stamp. Exercise it via the same resolve+guard shape without full
    // infra prep: an openrouter profile with an empty resolved apiKey.
    const modelProviders: ResolvedModelProvidersConfig = {
      default: 'glm',
      profiles: {
        native: { type: 'native' },
        glm: openrouterProfile({ apiKey: '' }),
      },
    };
    const config = {
      userConfig: { modelProviders },
    } as unknown as IronCurtainConfig;

    const { prepareDockerInfrastructure } = await import('../../src/docker/docker-infrastructure.js');
    await expect(
      prepareDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' as never } as never,
        '/tmp/does-not-matter',
        '/tmp/workspace',
        '/tmp/escalations',
        'bundle-id' as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'glm',
      ),
    ).rejects.toThrow(/is OpenRouter but no API key is configured/);
  });
});

// ─── Selection plumbing / cross-session isolation ────────────

describe('OpenRouter — active-profile resolution + cross-session isolation', () => {
  /** Two-openrouter-profile registry: glm (default) + kimi. */
  function twoProfileRegistry(): ResolvedModelProvidersConfig {
    return {
      default: 'glm-5.2',
      profiles: {
        native: { type: 'native' },
        'glm-5.2': openrouterProfile({ perAgent: { goose: 'z-ai/glm-5.2' } }),
        kimi: openrouterProfile({ perAgent: { goose: 'moonshot/kimi-k3' } }),
      },
    };
  }

  it('resolveActiveProfile: explicit name → that profile; unset → default; unknown → throws', () => {
    const registry = twoProfileRegistry();
    expect(resolveActiveProfile(registry, 'kimi')).toBe(registry.profiles.kimi);
    // Unset uses the resolved default ('glm-5.2').
    expect(resolveActiveProfile(registry, undefined)).toBe(registry.profiles['glm-5.2']);
    expect(() => resolveActiveProfile(registry, 'does-not-exist')).toThrow(
      'Unknown provider profile "does-not-exist". Available: native, glm-5.2, kimi.',
    );
  });

  it('cross-session isolation: two stamped configs in one process route to their OWN profile, no leakage', () => {
    // The adapter registry caches ONE adapter instance across sessions; the
    // profile MUST arrive via the per-session stamped config, so session A and
    // session B (built from the SAME adapter instance) map to different slugs.
    const registry = twoProfileRegistry();
    const gooseAdapter = createGooseAdapter();

    const configA = configWithProfile(resolveActiveProfile(registry, 'glm-5.2'));
    const configB = configWithProfile(resolveActiveProfile(registry, 'kimi'));

    const envA = gooseAdapter.buildEnv(configA, openrouterFakeKeys());
    const envB = gooseAdapter.buildEnv(configB, openrouterFakeKeys());

    expect(envA.GOOSE_MODEL).toBe('z-ai/glm-5.2');
    expect(envB.GOOSE_MODEL).toBe('moonshot/kimi-k3');
    // No bleed: A did not observe kimi and vice versa.
    expect(envA.GOOSE_MODEL).not.toBe(envB.GOOSE_MODEL);

    // The provider each session gets carries a rewriter bound to ITS profile:
    // remapping the same requested model yields each session's own slug.
    const rewriterA = gooseAdapter.getProviders(configA)[0].requestRewriter!;
    const rewriterB = gooseAdapter.getProviders(configB)[0].requestRewriter!;
    const ctx = { method: 'POST', path: '/api/v1/chat/completions' };
    const outA = rewriterA({ model: 'gpt-4o' }, ctx);
    const outB = rewriterB({ model: 'gpt-4o' }, ctx);
    expect(outA?.modified.model).toBe('z-ai/glm-5.2');
    expect(outB?.modified.model).toBe('moonshot/kimi-k3');
  });

  it('cross-session A=openrouter then B=native: B installs NO OpenRouter env even though A did', () => {
    const registry = twoProfileRegistry();
    const claudeAdapter = createClaudeCodeAdapter();

    const configA = configWithProfile(resolveActiveProfile(registry, 'glm-5.2'));
    const configB = configWithProfile(resolveActiveProfile(registry, 'native'));

    const envA = claudeAdapter.buildEnv(configA, openrouterFakeKeys());
    const envB = claudeAdapter.buildEnv(configB, new Map([['api.anthropic.com', 'sk-ant-fake']]));

    expect(envA.ANTHROPIC_BASE_URL).toBe(OPENROUTER_BASE_URL);
    expect(envB.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(envB.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(envB.IRONCURTAIN_API_KEY).toBe('sk-ant-fake');
  });

  it('non-interactive default reach: no providerProfileName + default=glm → the glm profile is active', () => {
    // Mirrors the daemon/cron/signal path: no per-session selection surface, so
    // the resolved default applies. resolveActiveProfile with undefined is the
    // exact call prepareDockerInfrastructure makes for those invocations.
    const registry = twoProfileRegistry();
    const active = resolveActiveProfile(registry, undefined);
    expect(active).toBe(registry.profiles['glm-5.2']);

    // The stamped default routes Claude Code through OpenRouter.
    const env = createClaudeCodeAdapter().buildEnv(configWithProfile(active), openrouterFakeKeys());
    expect(env.ANTHROPIC_BASE_URL).toBe(OPENROUTER_BASE_URL);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(FAKE_OPENROUTER_KEY);
  });

  it('native default reach: no providerProfileName + no configured profiles → native (no OpenRouter env)', () => {
    const registry: ResolvedModelProvidersConfig = { default: 'native', profiles: { native: { type: 'native' } } };
    const active = resolveActiveProfile(registry, undefined);
    expect(active).toEqual({ type: 'native' });
    const env = createClaudeCodeAdapter().buildEnv(
      configWithProfile(active),
      new Map([['api.anthropic.com', 'sk-ant-fake']]),
    );
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.IRONCURTAIN_API_KEY).toBe('sk-ant-fake');
  });
});

// ─── D6 cost accumulation (§10, §12.3 named test) ────────────

describe('OpenRouter — D6 authoritative-cost accumulation', () => {
  const TEST_SESSION_ID = 'd6-cost-session' as SessionId;

  /** A Claude Code result envelope carrying the CLI's self-reported cost. */
  function claudeResult(totalCostUsd: number | undefined): string {
    const envelope: Record<string, unknown> = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    // Omit the field entirely for the "no CLI cost" case so extractResponse
    // leaves `costUsd` undefined (it only sets it when total_cost_usd is a number).
    if (totalCostUsd !== undefined) envelope.total_cost_usd = totalCostUsd;
    return JSON.stringify(envelope);
  }

  /** A terminal `message_end` bus event carrying an authoritative OpenRouter cost. */
  function messageEndWithCost(costUsd: number): TokenStreamEvent {
    return {
      kind: 'message_end',
      stopReason: 'end_turn',
      inputTokens: 0,
      outputTokens: 0,
      costUsd,
      timestamp: Date.now(),
    };
  }

  let tempDir: string;
  let session: DockerAgentSession | undefined;

  function buildDeps(
    profile: ResolvedProviderProfile,
    exec: (container: string, cmd: readonly string[]) => Promise<DockerExecResult>,
  ): DockerAgentSessionDeps {
    const sessionDir = join(tempDir, 'session');
    const sandboxDir = join(tempDir, 'sandbox');
    const escalationDir = join(tempDir, 'escalations');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });
    mkdirSync(escalationDir, { recursive: true });

    const config = {
      mcpServers: {},
      activeProviderProfile: profile,
      userConfig: {
        anthropicApiKey: 'sk-test',
        resourceBudget: {
          maxTotalTokens: null,
          maxSteps: null,
          maxSessionSeconds: null,
          maxEstimatedCostUsd: null,
        },
        escalationTimeoutSeconds: 120,
        auditRedaction: { enabled: true },
      },
    } as unknown as IronCurtainConfig;

    const infra: DockerInfrastructure = {
      bundleId: 'd6-bundle' as BundleId,
      bundleDir: sessionDir,
      workspaceDir: sandboxDir,
      escalationDir,
      auditLogPath: join(tempDir, 'audit.jsonl'),
      proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
      mitmProxy: createMockMitmProxy(),
      docker: createMockDocker({ exec }),
      adapter: createClaudeCodeAdapter(),
      ca: createMockCA(tempDir),
      fakeKeys: openrouterFakeKeys(),
      orientationDir: join(sessionDir, 'orientation'),
      systemPrompt: 'You are a test agent.',
      image: 'ironcurtain-claude-code:latest',
      useTcp: false,
      socketsDir: join(sessionDir, 'sockets'),
      mitmAddr: { socketPath: '/tmp/test-mitm.sock' },
      authKind: 'apikey',
      containerId: 'container-d6',
      containerName: 'ironcurtain-d6',
      beginCaptureSession: () => {},
      endCaptureSession: async () => {},
    } as unknown as DockerInfrastructure;

    return {
      config,
      sessionId: TEST_SESSION_ID,
      agentConversationId: '00000000-1111-2222-3333-4444d6cost00' as AgentConversationId,
      infra,
      ownsInfra: true,
    };
  }

  async function startSession(deps: DockerAgentSessionDeps): Promise<DockerAgentSession> {
    const s = new DockerAgentSession(deps);
    await s.initialize();
    return s;
  }

  beforeEach(() => {
    // No live TokenStreamBridge is constructed in these tests, so resetting the
    // module-scoped singleton between tests is safe (see resetTokenStreamBus).
    resetTokenStreamBus();
    tempDir = mkdtempSync(join(tmpdir(), 'd6-cost-test-'));
    session = undefined;
  });

  afterEach(async () => {
    try {
      await session?.close();
    } catch {
      /* ignore */
    }
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers summed authoritative usage.cost over CLI costUsd when an OpenRouter profile is active', async () => {
    const { exec } = scriptedExec([{ exitCode: 0, stdout: claudeResult(0.5), stderr: '' }]);
    session = await startSession(buildDeps(openrouterProfile(), exec));

    // Two authoritative usage events (as the MITM would publish during the turn)
    // sum to 0.020; the CLI self-reports a (wrong-for-GLM) 0.5.
    const bus = getTokenStreamBus();
    bus.push(TEST_SESSION_ID, messageEndWithCost(0.012));
    bus.push(TEST_SESSION_ID, messageEndWithCost(0.008));

    await session.sendMessageDetailed('do the thing');

    expect(session.getBudgetStatus().estimatedCostUsd).toBeCloseTo(0.02, 6);
  });

  it('falls back to CLI costUsd when the active profile is native', async () => {
    const { exec } = scriptedExec([{ exitCode: 0, stdout: claudeResult(0.5), stderr: '' }]);
    session = await startSession(buildDeps({ type: 'native' }, exec));

    // Even if authoritative events arrive, a native profile must ignore them.
    getTokenStreamBus().push(TEST_SESSION_ID, messageEndWithCost(0.012));

    await session.sendMessageDetailed('do the thing');

    expect(session.getBudgetStatus().estimatedCostUsd).toBeCloseTo(0.5, 6);
  });

  it('falls back to CLI costUsd when the observed authoritative sum is 0', async () => {
    const { exec } = scriptedExec([{ exitCode: 0, stdout: claudeResult(0.5), stderr: '' }]);
    session = await startSession(buildDeps(openrouterProfile(), exec));

    // No authoritative events pushed → sum stays 0 → CLI self-report wins.
    await session.sendMessageDetailed('do the thing');

    expect(session.getBudgetStatus().estimatedCostUsd).toBeCloseTo(0.5, 6);
  });

  it('retains the prior cost (static-estimate slot) when there is no CLI cost and no authoritative sum', async () => {
    // No total_cost_usd in the envelope and no bus events: neither the
    // authoritative sum nor the CLI self-report is available, so the cumulative
    // cost stays at its initial 0 (the Docker session has no token counts to
    // compute a fresh static estimate).
    const { exec } = scriptedExec([{ exitCode: 0, stdout: claudeResult(undefined), stderr: '' }]);
    session = await startSession(buildDeps(openrouterProfile(), exec));

    await session.sendMessageDetailed('do the thing');

    expect(session.getBudgetStatus().estimatedCostUsd).toBe(0);
  });
});
