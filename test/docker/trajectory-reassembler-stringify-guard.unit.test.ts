/**
 * Byte-fidelity CI invariant (§6 invariant #1): the reassembler must
 * never JSON.parse → JSON.stringify captured content. The ONLY sanctioned
 * `JSON.stringify(` occurrence in trajectory-reassembler.ts is inside the
 * `encodeJsonString` helper, which re-encodes a single text leaf that was
 * decoded from the same wire encoding (byte-faithful round-trip).
 *
 * This test reads the source as text and asserts there is exactly one
 * `JSON.stringify(` occurrence and that it sits inside `encodeJsonString`.
 * Both OpenAI reassemblers route their single re-encode through the shared
 * `encodeJsonString`, so the guard stays a one-site assertion.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const SOURCE = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'docker', 'trajectory-reassembler.ts');

describe('trajectory-reassembler JSON.stringify guard', () => {
  const src = readFileSync(SOURCE, 'utf-8');

  it('contains exactly one JSON.stringify( occurrence', () => {
    const matches = src.match(/JSON\.stringify\(/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('the only JSON.stringify( is inside encodeJsonString', () => {
    const idx = src.indexOf('JSON.stringify(');
    expect(idx).toBeGreaterThanOrEqual(0);

    // Find the enclosing `function encodeJsonString` declaration: it must
    // be the nearest function declaration preceding the stringify call.
    const before = src.slice(0, idx);
    const lastFnDecl = before.lastIndexOf('function ');
    expect(lastFnDecl).toBeGreaterThanOrEqual(0);
    const fnLine = src.slice(lastFnDecl, src.indexOf('\n', lastFnDecl));
    expect(fnLine).toContain('encodeJsonString');
  });
});
