import { describe, expect, it } from 'vitest';
import { sanitizeResponseHeaders } from '../../src/docker/egress-forwarding.js';

describe('egress response forwarding', () => {
  it('strips static and Connection-nominated hop-by-hop response headers', () => {
    expect(
      sanitizeResponseHeaders({
        connection: 'keep-alive, X-Internal, X-Trace-Hop',
        'keep-alive': 'timeout=5',
        'x-internal': 'must-not-cross',
        'x-trace-hop': 'must-not-cross-either',
        'set-cookie': ['secret=value'],
        'content-type': 'application/json',
        'x-end-to-end': 'preserved',
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-end-to-end': 'preserved',
    });
  });
});
