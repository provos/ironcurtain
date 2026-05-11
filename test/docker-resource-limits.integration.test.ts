/**
 * Integration test: real `docker run` against `probeDockerResources()`.
 *
 * The unit tests in `docker-resource-limits.test.ts` cover the parser and
 * clamp logic with mocked stderr. They cannot catch Docker changing the
 * wording of its rejection messages — the regex contract in
 * `parseDockerResourceError()` would silently degrade. This test invokes the
 * real Docker CLI and asserts that the wording is still parseable.
 *
 * Gated on the same `ironcurtain-claude-code:latest` image used by
 * `pty-entrypoint.integration.test.ts`: skip cleanly when Docker isn't
 * available or the image isn't cached, run when it is.
 */

import { describe, it, expect } from 'vitest';
import { isImagePresent, parseDockerResourceError, probeDockerResources } from '../src/docker/resource-limits.js';
import { isDockerAvailable, isDockerImageAvailable } from './helpers/docker-available.js';

const IMAGE = 'ironcurtain-claude-code:latest';
const dockerReady = isDockerAvailable() && isDockerImageAvailable(IMAGE);

describe.skipIf(!dockerReady)('resource-limits integration (real Docker)', () => {
  it('probeDockerResources succeeds with a small but valid request', async () => {
    const result = await probeDockerResources(IMAGE, { cpus: 1, memoryMb: 512 });
    expect(result.ok).toBe(true);
  }, 30_000);

  it('probeDockerResources fails parseably when cpus exceeds host capacity', async () => {
    // 99999 cpus is rejected on every realistic host with a stable wording:
    // "Range of CPUs is from 0.01 to N.NN, as there are only N CPUs available."
    const result = await probeDockerResources(IMAGE, { cpus: 99999, memoryMb: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Independently confirm the wording still feeds the parser. If Docker
    // changes the message, this assertion fires and tells us to update the
    // regex in resource-limits.ts.
    const parsed = parseDockerResourceError(result.stderr);
    expect(parsed?.cpus, `parser failed on real Docker stderr: ${result.stderr}`).toBeTypeOf('number');
    expect(parsed?.cpus).toBeGreaterThanOrEqual(0.01);
    // The probe also surfaces the suggestion directly via `suggested`.
    expect(result.suggested?.cpus).toBeTypeOf('number');
  }, 30_000);

  it('probeDockerResources fails parseably when memory is below Docker minimum', async () => {
    // 4 MB is below Docker's hardcoded 6 MB floor; the wording is
    // "Minimum memory limit allowed is 6 MB" (case-insensitive in the parser).
    const result = await probeDockerResources(IMAGE, { cpus: undefined, memoryMb: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const parsed = parseDockerResourceError(result.stderr);
    expect(parsed?.memoryMb, `parser failed on real Docker stderr: ${result.stderr}`).toBeTypeOf('number');
    expect(parsed?.memoryMb).toBeGreaterThanOrEqual(6);
  }, 30_000);

  it('isImagePresent returns true for a cached image and false for a bogus name', async () => {
    expect(await isImagePresent(IMAGE)).toBe(true);
    expect(await isImagePresent('ironcurtain-test-bogus-name-xyz:does-not-exist')).toBe(false);
  }, 15_000);
});
