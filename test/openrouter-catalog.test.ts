import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  listOpenrouterModels,
  catalogEnforces,
  __resetCatalogCacheForTests,
} from '../src/config/openrouter-catalog.js';
import { OPENROUTER_FALLBACK_SLUGS } from '../src/config/openrouter-models-fallback.js';
import { DEFAULT_GLM_SLUG, DEFAULT_MODEL_MAP } from '../src/config/user-config.js';

// ---------------------------------------------------------------------------
// listOpenrouterModels — fetch / cache / fallback behavior
// ---------------------------------------------------------------------------

describe('listOpenrouterModels', () => {
  const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    __resetCatalogCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockFetch.mockReset();
  });

  /** A 200 response carrying the given `/models`-shaped JSON body. */
  function okResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns source "live" with sorted, de-duped, string-only slugs on success', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        data: [
          { id: 'z-ai/glm-5.2' },
          { id: 'anthropic/claude-opus-4' },
          { id: 'z-ai/glm-5.2' }, // duplicate → collapsed
          { id: 42 }, // non-string id → dropped
          { name: 'no-id-here' }, // missing id → dropped
          { id: 'openai/gpt-5' },
        ],
      }),
    );

    const result = await listOpenrouterModels();

    expect(result.source).toBe('live');
    expect(result.models).toEqual(['anthropic/claude-opus-4', 'openai/gpt-5', 'z-ai/glm-5.2']);
    expect(result.fetchedAt).toBeGreaterThan(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('serves the cached list as source "cache" within TTL without re-fetching', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: [{ id: 'openai/gpt-5' }] }));

    const first = await listOpenrouterModels();
    const second = await listOpenrouterModels();

    expect(first.source).toBe('live');
    expect(second.source).toBe('cache');
    expect(second.models).toEqual(['openai/gpt-5']);
    // fetchedAt is preserved from the underlying (live) fetch.
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('bypasses the TTL cache when forceRefresh is true', async () => {
    // A fresh Response per call — a single Response body can only be read once.
    mockFetch.mockImplementation(async () => okResponse({ data: [{ id: 'openai/gpt-5' }] }));

    await listOpenrouterModels();
    const refreshed = await listOpenrouterModels({ forceRefresh: true });

    expect(refreshed.source).toBe('live');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns the stale-but-real list as source "cache" when a later fetch fails', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ data: [{ id: 'openai/gpt-5' }] }));
    await listOpenrouterModels(); // populates the cache with a real result

    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const result = await listOpenrouterModels({ forceRefresh: true });

    expect(result.source).toBe('cache');
    expect(result.models).toEqual(['openai/gpt-5']);
  });

  it('falls back to the bundled floor when the fetch fails and there is no prior result', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const result = await listOpenrouterModels();

    expect(result.source).toBe('bundled');
    expect(result.models).toBe(OPENROUTER_FALLBACK_SLUGS);
    expect(result.fetchedAt).toBe(0);
  });

  it('degrades to bundled on a non-2xx response', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 500 }));

    const result = await listOpenrouterModels();

    expect(result.source).toBe('bundled');
    expect(result.models).toBe(OPENROUTER_FALLBACK_SLUGS);
  });

  it('degrades to bundled on malformed (non-JSON) body', async () => {
    mockFetch.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));

    const result = await listOpenrouterModels();

    expect(result.source).toBe('bundled');
  });

  it('degrades to bundled when `data` is not an array', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: 'not-an-array' }));

    const result = await listOpenrouterModels();

    expect(result.source).toBe('bundled');
  });

  it('degrades to bundled when `data` is empty (no usable slugs)', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: [] }));

    const result = await listOpenrouterModels();

    expect(result.source).toBe('bundled');
  });

  it('degrades when the fetch aborts on timeout', async () => {
    // AbortSignal.timeout(...) rejects with a TimeoutError DOMException; simulate it.
    mockFetch.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));

    const result = await listOpenrouterModels();

    expect(result.source).toBe('bundled');
  });

  it('never sends an Authorization header (the endpoint is public)', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: [{ id: 'openai/gpt-5' }] }));

    await listOpenrouterModels();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0]?.[1];
    // No headers object at all → no key can leak.
    expect(init?.headers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// catalogEnforces — the shared block-vs-warn decision
// ---------------------------------------------------------------------------

describe('catalogEnforces', () => {
  it('enforces (blocks) for authoritative sources', () => {
    expect(catalogEnforces('live')).toBe(true);
    expect(catalogEnforces('cache')).toBe(true);
  });

  it('does not enforce (warn-only) for the bundled floor', () => {
    expect(catalogEnforces('bundled')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bundled floor invariants — the fallback must never block a shipped default,
// or an offline user editing a default-tracking profile could not save it.
// ---------------------------------------------------------------------------

describe('OPENROUTER_FALLBACK_SLUGS invariants', () => {
  it('includes the default GLM slug', () => {
    expect(OPENROUTER_FALLBACK_SLUGS).toContain(DEFAULT_GLM_SLUG);
  });

  it('includes every DEFAULT_MODEL_MAP target slug', () => {
    for (const rule of DEFAULT_MODEL_MAP) {
      expect(OPENROUTER_FALLBACK_SLUGS).toContain(rule.model);
    }
  });

  it('is sorted and de-duped (served by reference as the bundled result)', () => {
    const arr = [...OPENROUTER_FALLBACK_SLUGS];
    expect(arr).toEqual([...new Set(arr)]);
    expect(arr).toEqual([...arr].sort());
  });
});
