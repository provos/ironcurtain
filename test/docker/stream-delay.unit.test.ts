import { describe, it, expect } from 'vitest';
import { StreamDelayTransform, parseStreamDelayConfig } from '../../src/docker/stream-delay.js';

/**
 * Drive `chunks` through the transform and record each output chunk's
 * arrival time relative to the moment writing began.
 */
function runThroughDelay(
  transform: StreamDelayTransform,
  chunks: Buffer[],
): Promise<{ data: Buffer; offsets: number[] }> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const offsets: number[] = [];
    const start = Date.now();
    transform.on('data', (c: Buffer) => {
      out.push(c);
      offsets.push(Date.now() - start);
    });
    transform.on('end', () => resolve({ data: Buffer.concat(out), offsets }));
    transform.on('error', reject);
    for (const c of chunks) transform.write(c);
    transform.end();
  });
}

const DELAY = 80; // ms — small enough to keep the suite fast, large enough to measure

describe('parseStreamDelayConfig', () => {
  it('returns null when the delay var is unset', () => {
    expect(parseStreamDelayConfig({})).toBeNull();
  });

  it('returns null for non-positive or non-numeric delays', () => {
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '0' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '-5' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: 'abc' })).toBeNull();
  });

  it('defaults to mid-stream mode with no host filter', () => {
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '15000' })).toEqual({
      delayMs: 15000,
      mode: 'mid-stream',
      hostFilter: undefined,
    });
  });

  it('parses first-token mode and a host filter', () => {
    expect(
      parseStreamDelayConfig({
        IRONCURTAIN_MITM_STREAM_DELAY_MS: '9000',
        IRONCURTAIN_MITM_STREAM_DELAY_MODE: 'first-token',
        IRONCURTAIN_MITM_STREAM_DELAY_HOST: 'anthropic',
      }),
    ).toEqual({ delayMs: 9000, mode: 'first-token', hostFilter: 'anthropic' });
  });

  it('falls back to mid-stream for an unrecognized mode', () => {
    expect(
      parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '100', IRONCURTAIN_MITM_STREAM_DELAY_MODE: 'wat' })
        ?.mode,
    ).toBe('mid-stream');
  });
});

describe('StreamDelayTransform', () => {
  const chunks = [Buffer.from('event: a\n\n'), Buffer.from('event: b\n\n'), Buffer.from('event: c\n\n')];
  const expected = Buffer.concat(chunks);

  it('mid-stream: preserves bytes and injects the gap before the second chunk', async () => {
    const { data, offsets } = await runThroughDelay(new StreamDelayTransform(DELAY, 'mid-stream'), chunks);
    expect(data.equals(expected)).toBe(true);
    expect(offsets).toHaveLength(3);
    // First chunk forwarded promptly; the gap lands between chunk 0 and chunk 1.
    expect(offsets[0]).toBeLessThan(DELAY / 2);
    expect(offsets[1] - offsets[0]).toBeGreaterThanOrEqual(DELAY * 0.6);
    // Chunk 2 follows chunk 1 without an additional gap.
    expect(offsets[2] - offsets[1]).toBeLessThan(DELAY / 2);
  });

  it('first-token: preserves bytes and injects the gap before the first chunk', async () => {
    const { data, offsets } = await runThroughDelay(new StreamDelayTransform(DELAY, 'first-token'), chunks);
    expect(data.equals(expected)).toBe(true);
    expect(offsets).toHaveLength(3);
    // Nothing reaches the client until the first-token gap elapses.
    expect(offsets[0]).toBeGreaterThanOrEqual(DELAY * 0.6);
    // The rest follow immediately after.
    expect(offsets[2] - offsets[0]).toBeLessThan(DELAY / 2);
  });

  it('mid-stream is a pass-through when only one chunk is emitted', async () => {
    const { data, offsets } = await runThroughDelay(new StreamDelayTransform(DELAY, 'mid-stream'), [chunks[0]]);
    expect(data.equals(chunks[0])).toBe(true);
    expect(offsets[0]).toBeLessThan(DELAY / 2);
  });
});
