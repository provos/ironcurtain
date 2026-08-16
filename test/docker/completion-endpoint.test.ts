import { describe, expect, it } from 'vitest';
import {
  resolveCompletionEndpoint,
  validateCompletionEndpoints,
} from '../../src/docker/llm-observation/completion-endpoint.js';
import { googleProvider } from '../../src/docker/provider-config.js';

describe('completion endpoint routing', () => {
  it('accepts and distinguishes the official Google action suffixes', () => {
    const endpoints = googleProvider.completionEndpoints ?? [];
    expect(() => validateCompletionEndpoints(endpoints, googleProvider.allowedEndpoints)).not.toThrow();

    expect(resolveCompletionEndpoint(endpoints, 'POST', '/v1beta/models/gemini-2.5-flash:generateContent')?.path).toBe(
      '/v1beta/models/*:generateContent',
    );
    expect(
      resolveCompletionEndpoint(endpoints, 'POST', '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
        ?.path,
    ).toBe('/v1beta/models/*:streamGenerateContent');
    expect(
      resolveCompletionEndpoint(endpoints, 'POST', '/v1beta/models/gemini-2.5-flash/generateContent'),
    ).toBeUndefined();
  });
});
