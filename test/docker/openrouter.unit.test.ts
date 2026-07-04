/**
 * OpenRouter transform module unit tests (openrouter-integration §7 / §12.1).
 *
 * Pure, token-free tests of glob resolution, the MITM request-body rewriter
 * (D1 precedence, D3 default z-ai pin, D4 session_id keying, m7 no-op), and
 * the per-agent ProviderConfig factory.
 */

import { describe, it, expect } from 'vitest';
import {
  globToRegExp,
  resolveMappedModel,
  makeOpenRouterRewriter,
  makeOpenRouterProvider,
  ANTHROPIC_ONLY_BETA_FIELDS,
  type OpenRouterRewriterConfig,
} from '../../src/docker/openrouter.js';
import type { RequestBodyRewriter, RewriteResult } from '../../src/docker/provider-config.js';

const MESSAGES_PATH = '/api/v1/messages';
const GLM = 'z-ai/glm-5.2';

/** Default map used across most rewriter tests. */
const DEFAULT_MAP = [
  { match: '*opus*', model: GLM },
  { match: '*sonnet*', model: GLM },
  { match: '*haiku*', model: GLM },
];

function makeConfig(overrides: Partial<OpenRouterRewriterConfig> = {}): OpenRouterRewriterConfig {
  return {
    modelMap: DEFAULT_MAP,
    perAgentDefault: undefined,
    providerPreference: undefined,
    sessionAffinity: true,
    ...overrides,
  };
}

/** Runs a rewriter against a body + context; returns the RewriteResult or null. */
function rewrite(
  rewriter: RequestBodyRewriter,
  body: Record<string, unknown>,
  cacheKey?: string,
): RewriteResult | null {
  return rewriter(body, { method: 'POST', path: MESSAGES_PATH, cacheKey });
}

describe('globToRegExp / resolveMappedModel', () => {
  it('matches *sonnet* against a sonnet model id', () => {
    expect(globToRegExp('*sonnet*').test('claude-sonnet-4-6')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(globToRegExp('*SONNET*').test('claude-sonnet-4-6')).toBe(true);
  });

  it('anchors the full string (a bare literal does not substring-match)', () => {
    expect(globToRegExp('sonnet').test('claude-sonnet-4-6')).toBe(false);
    expect(globToRegExp('sonnet').test('sonnet')).toBe(true);
  });

  it('treats a literal dot literally (gpt-4.1 not a regex)', () => {
    expect(globToRegExp('gpt-4.1').test('gpt-4x1')).toBe(false);
    expect(globToRegExp('gpt-4.1').test('gpt-4.1')).toBe(true);
  });

  it('resolveMappedModel returns the first matching rule (ordering)', () => {
    const map = [
      { match: '*opus*', model: 'first/opus' },
      { match: '*', model: 'second/wildcard' },
    ];
    expect(resolveMappedModel('claude-opus-4', map)).toBe('first/opus');
    expect(resolveMappedModel('anything-else', map)).toBe('second/wildcard');
  });

  it('resolveMappedModel returns undefined on no match', () => {
    expect(resolveMappedModel('gpt-5', DEFAULT_MAP)).toBeUndefined();
  });
});

describe('makeOpenRouterRewriter — model remap (D1/D2)', () => {
  it('remaps model per the glob map', () => {
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.model).toBe(GLM);
    expect(result?.stripped).toContain(`model:${GLM}`);
  });

  it('leaves the requested id unchanged when neither perAgent nor glob resolves', () => {
    const result = rewrite(makeOpenRouterRewriter(makeConfig({ modelMap: [] })), { model: 'gpt-5' });
    // Nothing else changed (non-glm slug, no pin), so the rewriter no-ops.
    expect(result).toBeNull();
  });

  it('D1 precedence: perAgentDefault WINS over a matching modelMap rule', () => {
    const cfg = makeConfig({ perAgentDefault: 'moonshot/kimi-k3' });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.model).toBe('moonshot/kimi-k3');
  });

  it('modelMap:[] with a perAgentDefault uses the perAgent default', () => {
    const cfg = makeConfig({ modelMap: [], perAgentDefault: GLM });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.model).toBe(GLM);
  });

  it('modelMap:[] with no perAgentDefault passes the requested id through unchanged', () => {
    const cfg = makeConfig({ modelMap: [], perAgentDefault: undefined });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'gpt-5' });
    expect(result).toBeNull();
  });
});

describe('makeOpenRouterRewriter — session_id keying (D4)', () => {
  const cacheKey = '7f3c2a9e-1b4d-4e8a-9c22-abcdef012345';

  it('injects `${cacheKey}:${requestedModelId}` for a z-ai slug', () => {
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), { model: 'claude-sonnet-4-6' }, cacheKey);
    expect(result?.modified.session_id).toBe(`${cacheKey}:claude-sonnet-4-6`);
  });

  it('is stable across turns of the same conversation + requested model', () => {
    const rewriter = makeOpenRouterRewriter(makeConfig());
    const a = rewrite(rewriter, { model: 'claude-sonnet-4-6' }, cacheKey);
    const b = rewrite(rewriter, { model: 'claude-sonnet-4-6' }, cacheKey);
    expect(a?.modified.session_id).toBe(b?.modified.session_id);
  });

  it('produces a DIFFERENT id for a different requested model (Haiku vs Sonnet separation)', () => {
    const rewriter = makeOpenRouterRewriter(makeConfig());
    const sonnet = rewrite(rewriter, { model: 'claude-sonnet-4-6' }, cacheKey);
    const haiku = rewrite(rewriter, { model: 'claude-haiku-4-5' }, cacheKey);
    expect(sonnet?.modified.session_id).not.toBe(haiku?.modified.session_id);
    expect(haiku?.modified.session_id).toBe(`${cacheKey}:claude-haiku-4-5`);
  });

  it('truncates the id to 256 chars', () => {
    const longKey = 'k'.repeat(300);
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), { model: 'claude-sonnet-4-6' }, longKey);
    expect((result?.modified.session_id as string).length).toBe(256);
  });

  it('does NOT inject for a non-GLM mapped slug', () => {
    const cfg = makeConfig({ modelMap: [{ match: '*', model: 'moonshot/kimi-k3' }] });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'claude-sonnet-4-6' }, cacheKey);
    expect(result?.modified.session_id).toBeUndefined();
  });

  it('does not overwrite an existing session_id', () => {
    const result = rewrite(
      makeOpenRouterRewriter(makeConfig()),
      { model: 'claude-sonnet-4-6', session_id: 'pre-existing' },
      cacheKey,
    );
    expect(result?.modified.session_id).toBe('pre-existing');
  });

  it('skips injection when sessionAffinity=false', () => {
    const cfg = makeConfig({ sessionAffinity: false });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'claude-sonnet-4-6' }, cacheKey);
    expect(result?.modified.session_id).toBeUndefined();
  });

  it('skips injection when cacheKey is absent', () => {
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), { model: 'claude-sonnet-4-6' }, undefined);
    expect(result?.modified.session_id).toBeUndefined();
  });
});

describe('makeOpenRouterRewriter — provider injection (D3)', () => {
  it('injects the default soft pin { order: ["z-ai"] } for a z-ai slug when providerPreference is unset', () => {
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.provider).toEqual({ order: ['z-ai'] });
    expect(result?.stripped).toContain('provider:default-z-ai');
  });

  it('the default soft pin has no allow_fallbacks key', () => {
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.provider).not.toHaveProperty('allow_fallbacks');
  });

  it('injects the configured providerPreference verbatim (snake_case allow_fallbacks), replacing the default', () => {
    const cfg = makeConfig({ providerPreference: { order: ['z-ai'], allowFallbacks: false } });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.provider).toEqual({ order: ['z-ai'], allow_fallbacks: false });
    expect(result?.stripped).toContain('provider:pin');
  });

  it('maps `only` through to the wire `only` field', () => {
    const cfg = makeConfig({ providerPreference: { only: ['z-ai'] } });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.provider).toEqual({ only: ['z-ai'] });
  });

  it('does not inject when the body already carries a provider', () => {
    const preExisting = { order: ['custom'] };
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), {
      model: 'claude-sonnet-4-6',
      provider: preExisting,
    });
    expect(result?.modified.provider).toEqual(preExisting);
    expect(result?.stripped).not.toContain('provider:default-z-ai');
  });

  it('does NOT inject a default pin for a non-z-ai mapped slug', () => {
    const cfg = makeConfig({ modelMap: [{ match: '*', model: 'moonshot/kimi-k3' }], providerPreference: undefined });
    const result = rewrite(makeOpenRouterRewriter(cfg), { model: 'claude-sonnet-4-6' });
    expect(result?.modified.provider).toBeUndefined();
  });
});

describe('makeOpenRouterRewriter — beta strip + cache_control preservation', () => {
  it('strips context_management (ANTHROPIC_ONLY_BETA_FIELDS)', () => {
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), {
      model: 'claude-sonnet-4-6',
      context_management: { edits: [] },
    });
    expect(result?.modified.context_management).toBeUndefined();
    expect(result?.stripped).toContain('beta:context_management');
    expect(ANTHROPIC_ONLY_BETA_FIELDS).toContain('context_management');
  });

  it('preserves cache_control blocks (deep-equal on system[].cache_control)', () => {
    const system = [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }];
    const result = rewrite(makeOpenRouterRewriter(makeConfig()), { model: 'claude-sonnet-4-6', system });
    expect(result?.modified.system).toEqual(system);
    expect((result?.modified.system as typeof system)[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('produces the full §8.1 output for the worked example', () => {
    const cacheKey = '7f3c2a9e-1b4d-4e8a-9c22-abcdef012345';
    const cfg = makeConfig({ providerPreference: { order: ['z-ai'], allowFallbacks: false } });
    const result = rewrite(
      makeOpenRouterRewriter(cfg),
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        context_management: { edits: [] },
        system: [{ type: 'text', text: "You are IronCurtain's agent.", cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'List the files.' }],
      },
      cacheKey,
    );
    expect(result?.modified).toEqual({
      model: GLM,
      max_tokens: 4096,
      system: [{ type: 'text', text: "You are IronCurtain's agent.", cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'List the files.' }],
      session_id: `${cacheKey}:claude-sonnet-4-6`,
      provider: { order: ['z-ai'], allow_fallbacks: false },
    });
  });
});

describe('makeOpenRouterRewriter — m7 no-ops', () => {
  it('returns null when body.model is absent', () => {
    expect(rewrite(makeOpenRouterRewriter(makeConfig()), {})).toBeNull();
  });

  it('returns null when body.model is not a string', () => {
    expect(rewrite(makeOpenRouterRewriter(makeConfig()), { model: 42 })).toBeNull();
  });

  it('returns null when nothing changed (non-glm passthrough, no beta, no provider)', () => {
    const cfg = makeConfig({ modelMap: [] });
    expect(rewrite(makeOpenRouterRewriter(cfg), { model: 'gpt-5' })).toBeNull();
  });
});

describe('makeOpenRouterProvider — factory', () => {
  const rewriter = makeOpenRouterRewriter(makeConfig());

  it('uses bearer key injection and the sk-or-v1-ironcurtain- fake prefix', () => {
    const provider = makeOpenRouterProvider('messages', rewriter);
    expect(provider.host).toBe('openrouter.ai');
    expect(provider.keyInjection).toEqual({ type: 'bearer' });
    expect(provider.fakeKeyPrefix).toBe('sk-or-v1-ironcurtain-');
  });

  it('messages kind allowlists messages + count_tokens (D5) + models', () => {
    const provider = makeOpenRouterProvider('messages', rewriter);
    const paths = provider.allowedEndpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('POST /api/v1/messages');
    expect(paths).toContain('POST /api/v1/messages/count_tokens');
    expect(paths).toContain('GET /api/v1/models');
  });

  it('chat kind allowlists chat/completions + models (no count_tokens)', () => {
    const provider = makeOpenRouterProvider('chat', rewriter);
    const paths = provider.allowedEndpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('POST /api/v1/chat/completions');
    expect(paths).toContain('GET /api/v1/models');
    expect(paths).not.toContain('POST /api/v1/messages/count_tokens');
  });

  it('responses kind allowlists responses + models', () => {
    const provider = makeOpenRouterProvider('responses', rewriter);
    const paths = provider.allowedEndpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('POST /api/v1/responses');
    expect(paths).toContain('GET /api/v1/models');
  });

  it('attaches the rewriter + rewriteEndpoints to the completion POST path only', () => {
    const provider = makeOpenRouterProvider('messages', rewriter);
    expect(provider.requestRewriter).toBe(rewriter);
    expect(provider.rewriteEndpoints).toEqual(['/api/v1/messages']);
    expect(provider.captureEndpoints).toEqual([{ method: 'POST', path: '/api/v1/messages' }]);
  });

  it('does not rewrite/capture count_tokens', () => {
    const provider = makeOpenRouterProvider('messages', rewriter);
    expect(provider.rewriteEndpoints).not.toContain('/api/v1/messages/count_tokens');
    expect(provider.captureEndpoints).not.toContainEqual({
      method: 'POST',
      path: '/api/v1/messages/count_tokens',
    });
  });
});
