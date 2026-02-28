import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { discoverGitHubIdentity, resolveGitHubToken } from '../src/pipeline/github-identity.js';

// ---------------------------------------------------------------------------
// resolveGitHubToken
// ---------------------------------------------------------------------------

describe('resolveGitHubToken', () => {
  let savedEnvToken: string | undefined;

  beforeEach(() => {
    savedEnvToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  });

  afterEach(() => {
    if (savedEnvToken !== undefined) {
      process.env.GITHUB_PERSONAL_ACCESS_TOKEN = savedEnvToken;
    } else {
      delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    }
  });

  it('returns env var when set', () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_env_token';
    const result = resolveGitHubToken({});
    expect(result).toBe('ghp_env_token');
  });

  it('returns config token when env var is not set', () => {
    const creds = { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_config_token' } };
    const result = resolveGitHubToken(creds);
    expect(result).toBe('ghp_config_token');
  });

  it('prefers env var over config token', () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_env_token';
    const creds = { github: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_config_token' } };
    const result = resolveGitHubToken(creds);
    expect(result).toBe('ghp_env_token');
  });

  it('returns null when neither env var nor config is set', () => {
    const result = resolveGitHubToken({});
    expect(result).toBeNull();
  });

  it('returns null when serverCredentials has no github key', () => {
    const creds = { gitlab: { GITLAB_TOKEN: 'some-token' } };
    const result = resolveGitHubToken(creds);
    expect(result).toBeNull();
  });

  it('returns null when github credentials lack the expected key', () => {
    const creds = { github: { SOME_OTHER_KEY: 'some-value' } };
    const result = resolveGitHubToken(creds);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverGitHubIdentity
// ---------------------------------------------------------------------------

describe('discoverGitHubIdentity', () => {
  const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mockFetch.mockReset();
  });

  function mockFetchResponses(
    userResponse: { ok: boolean; body: unknown },
    orgsResponse: { ok: boolean; body: unknown },
  ): void {
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      let url: string;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else {
        url = input.url;
      }

      if (url.endsWith('/user/orgs')) {
        return new Response(JSON.stringify(orgsResponse.body), {
          status: orgsResponse.ok ? 200 : 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify(userResponse.body), {
          status: userResponse.ok ? 200 : 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not Found', { status: 404 });
    });
  }

  it('returns login and orgs on success', async () => {
    mockFetchResponses(
      { ok: true, body: { login: 'provos' } },
      { ok: true, body: [{ login: 'my-org' }, { login: 'acme-corp' }] },
    );

    const result = await discoverGitHubIdentity('ghp_valid_token');

    expect(result).toEqual({
      login: 'provos',
      orgs: ['my-org', 'acme-corp'],
    });
  });

  it('returns empty orgs when user has no organizations', async () => {
    mockFetchResponses({ ok: true, body: { login: 'solo-dev' } }, { ok: true, body: [] });

    const result = await discoverGitHubIdentity('ghp_valid_token');

    expect(result).toEqual({
      login: 'solo-dev',
      orgs: [],
    });
  });

  it('returns null on 401 from /user', async () => {
    mockFetchResponses({ ok: false, body: { message: 'Bad credentials' } }, { ok: true, body: [{ login: 'org' }] });

    const result = await discoverGitHubIdentity('ghp_expired_token');
    expect(result).toBeNull();
  });

  it('returns null on 401 from /user/orgs', async () => {
    mockFetchResponses({ ok: true, body: { login: 'provos' } }, { ok: false, body: { message: 'Bad credentials' } });

    const result = await discoverGitHubIdentity('ghp_expired_token');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    const result = await discoverGitHubIdentity('ghp_valid_token');
    expect(result).toBeNull();
  });

  it('returns null when /user response is missing login field', async () => {
    mockFetchResponses({ ok: true, body: { id: 12345, name: 'Some User' } }, { ok: true, body: [{ login: 'org' }] });

    const result = await discoverGitHubIdentity('ghp_valid_token');
    expect(result).toBeNull();
  });

  it('returns null when /user login is not a string', async () => {
    mockFetchResponses({ ok: true, body: { login: 12345 } }, { ok: true, body: [] });

    const result = await discoverGitHubIdentity('ghp_valid_token');
    expect(result).toBeNull();
  });

  it('filters out orgs with non-string login', async () => {
    mockFetchResponses(
      { ok: true, body: { login: 'provos' } },
      { ok: true, body: [{ login: 'good-org' }, { login: 42 }, { name: 'no-login-org' }] },
    );

    const result = await discoverGitHubIdentity('ghp_valid_token');

    expect(result).toEqual({
      login: 'provos',
      orgs: ['good-org'],
    });
  });

  it('sends correct authorization header', async () => {
    mockFetchResponses({ ok: true, body: { login: 'provos' } }, { ok: true, body: [] });

    await discoverGitHubIdentity('ghp_test_token_123');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) {
      const opts = call[1] as RequestInit;
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ghp_test_token_123');
      expect(headers.Accept).toBe('application/vnd.github+json');
      expect(headers['User-Agent']).toBe('ironcurtain-policy-customizer');
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    }
  });

  it('calls both /user and /user/orgs endpoints', async () => {
    mockFetchResponses({ ok: true, body: { login: 'provos' } }, { ok: true, body: [] });

    await discoverGitHubIdentity('ghp_test_token');

    const urls = mockFetch.mock.calls.map((call) => call[0] as string);
    expect(urls).toContainEqual(expect.stringContaining('/user'));
    expect(urls).toContainEqual(expect.stringContaining('/user/orgs'));
  });
});
