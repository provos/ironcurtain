import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyAuthToken } from '../stores.svelte.js';

// ---------------------------------------------------------------------------
// verifyAuthToken — HTTP preflight against `/ws/auth`
//
// The function exists because browsers collapse WS-upgrade 401s into the
// same onclose(1006) event as a network failure. These tests pin the
// three branches that drive downstream UI state.
// ---------------------------------------------------------------------------

describe('verifyAuthToken preflight', () => {
  beforeEach(() => {
    // window.location.host is read inside verifyAuthToken. jsdom gives
    // us a stable "localhost" host by default, which is fine — we just
    // assert on the fetch URL the function constructs.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "ok" on 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const result = await verifyAuthToken('good-token', fetchMock);

    expect(result).toBe('ok');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/ws/auth?token=good-token');
    expect(init?.method).toBe('GET');
    expect(init?.cache).toBe('no-store');
  });

  it('returns "invalid" on 401 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":false}', { status: 401 }));

    const result = await verifyAuthToken('bad-token', fetchMock);

    expect(result).toBe('invalid');
  });

  it('returns "invalid" on other non-2xx (403, 500, etc.)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));

    const result = await verifyAuthToken('some-token', fetchMock);

    expect(result).toBe('invalid');
  });

  it('returns "offline" when fetch rejects (network error, daemon down)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await verifyAuthToken('any-token', fetchMock);

    expect(result).toBe('offline');
  });

  it('URL-encodes tokens with special characters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await verifyAuthToken('token with spaces & slashes/', fetchMock);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/ws/auth?token=token%20with%20spaces%20%26%20slashes%2F');
  });
});
