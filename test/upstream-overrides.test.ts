import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseUpstreamBaseUrl } from '../src/docker/provider-config.js';
import type { ProviderConfig, UpstreamTarget } from '../src/docker/provider-config.js';
import { applyUpstreamOverrides } from '../src/docker/docker-infrastructure.js';

describe('parseUpstreamBaseUrl', () => {
  it('parses standard HTTPS URL with default port', () => {
    const result = parseUpstreamBaseUrl('https://gateway.corp.com');
    expect(result).toEqual({
      hostname: 'gateway.corp.com',
      port: 443,
      pathPrefix: '',
      useTls: true,
    });
  });

  it('parses standard HTTP URL with explicit port', () => {
    const result = parseUpstreamBaseUrl('http://localhost:4000');
    expect(result).toEqual({
      hostname: 'localhost',
      port: 4000,
      pathPrefix: '',
      useTls: false,
    });
  });

  it('extracts path prefix from URL', () => {
    const result = parseUpstreamBaseUrl('https://gateway.corp.com/anthropic');
    expect(result).toEqual({
      hostname: 'gateway.corp.com',
      port: 443,
      pathPrefix: '/anthropic',
      useTls: true,
    });
  });

  it('strips trailing slash from path prefix', () => {
    const result = parseUpstreamBaseUrl('https://gateway.corp.com/v1/');
    expect(result.pathPrefix).toBe('/v1');
  });

  it('parses non-standard HTTPS port', () => {
    const result = parseUpstreamBaseUrl('https://gateway.corp.com:8443');
    expect(result).toEqual({
      hostname: 'gateway.corp.com',
      port: 8443,
      pathPrefix: '',
      useTls: true,
    });
  });

  it('defaults HTTP to port 80', () => {
    const result = parseUpstreamBaseUrl('http://localhost');
    expect(result).toEqual({
      hostname: 'localhost',
      port: 80,
      pathPrefix: '',
      useTls: false,
    });
  });

  it('throws on unsupported protocol', () => {
    expect(() => parseUpstreamBaseUrl('ftp://gateway.corp.com')).toThrow(
      'Unsupported protocol in upstream base URL: ftp:',
    );
  });

  it('handles deeper path prefix', () => {
    const result = parseUpstreamBaseUrl('https://gateway.corp.com/api/v1/anthropic');
    expect(result.pathPrefix).toBe('/api/v1/anthropic');
  });
});

describe('applyUpstreamOverrides', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save env vars we might set
    for (const key of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GOOGLE_API_BASE_URL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /** Minimal provider config for testing. */
  function makeProvider(host: string, displayName: string): ProviderConfig {
    return {
      host,
      displayName,
      allowedEndpoints: [],
      keyInjection: { type: 'header', headerName: 'x-api-key' },
      fakeKeyPrefix: 'sk-test-',
    };
  }

  const mockParser: (url: string) => UpstreamTarget = (url) => parseUpstreamBaseUrl(url);

  it('populates upstreamTarget when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.com:8443/anthropic';
    const providers = [makeProvider('api.anthropic.com', 'Anthropic')];

    const result = applyUpstreamOverrides(providers, mockParser);

    expect(result[0].upstreamTarget).toEqual({
      hostname: 'gateway.corp.com',
      port: 8443,
      pathPrefix: '/anthropic',
      useTls: true,
    });
  });

  it('returns providers unchanged when no env vars are set', () => {
    const providers = [makeProvider('api.anthropic.com', 'Anthropic'), makeProvider('api.openai.com', 'OpenAI')];

    const result = applyUpstreamOverrides(providers, mockParser);

    expect(result[0].upstreamTarget).toBeUndefined();
    expect(result[1].upstreamTarget).toBeUndefined();
  });

  it('returns provider unchanged when env var has invalid URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'ftp://not-supported.com';
    const providers = [makeProvider('api.anthropic.com', 'Anthropic')];

    const result = applyUpstreamOverrides(providers, mockParser);

    expect(result[0].upstreamTarget).toBeUndefined();
  });

  it('never overrides platform.claude.com providers', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.com';
    const providers = [makeProvider('platform.claude.com', 'Claude Platform')];

    const result = applyUpstreamOverrides(providers, mockParser);

    expect(result[0].upstreamTarget).toBeUndefined();
  });

  it('falls back to configBaseUrls when env var is not set', () => {
    const providers = [makeProvider('api.anthropic.com', 'Anthropic')];

    const result = applyUpstreamOverrides(providers, mockParser, {
      'api.anthropic.com': 'http://localhost:11434',
    });

    expect(result[0].upstreamTarget).toEqual({
      hostname: 'localhost',
      port: 11434,
      pathPrefix: '',
      useTls: false,
    });
  });

  it('prefers env var over configBaseUrls', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.com';
    const providers = [makeProvider('api.anthropic.com', 'Anthropic')];

    const result = applyUpstreamOverrides(providers, mockParser, {
      'api.anthropic.com': 'http://localhost:11434',
    });

    expect(result[0].upstreamTarget!.hostname).toBe('gateway.corp.com');
  });

  it('falls back to configBaseUrls when env var is invalid', () => {
    process.env.ANTHROPIC_BASE_URL = 'ftp://not-supported.com';
    const providers = [makeProvider('api.anthropic.com', 'Anthropic')];

    const result = applyUpstreamOverrides(providers, mockParser, {
      'api.anthropic.com': 'http://localhost:11434',
    });

    expect(result[0].upstreamTarget).toEqual({
      hostname: 'localhost',
      port: 11434,
      pathPrefix: '',
      useTls: false,
    });
  });

  it('applies multiple env var overrides simultaneously', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.corp.com/anthropic';
    process.env.OPENAI_BASE_URL = 'http://localhost:4000';

    const providers = [
      makeProvider('api.anthropic.com', 'Anthropic'),
      makeProvider('api.openai.com', 'OpenAI'),
      makeProvider('platform.claude.com', 'Claude Platform'),
    ];

    const result = applyUpstreamOverrides(providers, mockParser);

    expect(result[0].upstreamTarget).toBeDefined();
    expect(result[0].upstreamTarget!.hostname).toBe('gateway.corp.com');
    expect(result[1].upstreamTarget).toBeDefined();
    expect(result[1].upstreamTarget!.hostname).toBe('localhost');
    expect(result[2].upstreamTarget).toBeUndefined();
  });
});
