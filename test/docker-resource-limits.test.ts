import { describe, it, expect, vi } from 'vitest';
import {
  clampDockerResources,
  parseDockerResourceError,
  probeDockerResources,
  isImagePresent,
  type ExecFileFn,
  type HostResources,
} from '../src/docker/resource-limits.js';
import type { ResolvedDockerResourcesConfig } from '../src/config/user-config.js';

const HOST_2VCPU_4GB: HostResources = { cpus: 2, memoryMb: 4096 };
const HOST_8VCPU_16GB: HostResources = { cpus: 8, memoryMb: 16384 };
const HOST_1VCPU_1GB: HostResources = { cpus: 1, memoryMb: 1024 };

describe('clampDockerResources', () => {
  it('passes through values that fit', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 4096, cpus: 4 };
    const result = clampDockerResources(cfg, HOST_8VCPU_16GB);
    expect(result.effective.cpus).toBe(4);
    expect(result.effective.memoryMb).toBe(4096);
    expect(result.clamped).toBe(false);
  });

  it('clamps cpus to hostCpus - 1 on a small host (Bishop Fox scenario)', () => {
    // The reported failure: hardcoded 4 cpus on a 2-vCPU VM.
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 8192, cpus: 4 };
    const result = clampDockerResources(cfg, HOST_2VCPU_4GB);
    expect(result.effective.cpus).toBe(1); // 2 - 1
    expect(result.effective.memoryMb).toBe(3072); // floor(4096 * 0.75)
    expect(result.clamped).toBe(true);
  });

  it('clamps memory to floor(hostMb * 0.75) when configured exceeds host', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 8192, cpus: 1 };
    const result = clampDockerResources(cfg, HOST_2VCPU_4GB);
    expect(result.effective.memoryMb).toBe(3072);
    expect(result.clamped).toBe(true);
  });

  it('null cpus produces undefined (no flag) and is never clamped', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 2048, cpus: null };
    const result = clampDockerResources(cfg, HOST_2VCPU_4GB);
    expect(result.effective.cpus).toBeUndefined();
    expect(result.effective.memoryMb).toBe(2048);
    expect(result.clamped).toBe(false);
  });

  it('null memoryMb produces undefined (no flag) and is never clamped', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: null, cpus: 1 };
    const result = clampDockerResources(cfg, HOST_2VCPU_4GB);
    expect(result.effective.memoryMb).toBeUndefined();
    expect(result.effective.cpus).toBe(1);
    expect(result.clamped).toBe(false);
  });

  it('both null = no flags emitted', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: null, cpus: null };
    const result = clampDockerResources(cfg, HOST_8VCPU_16GB);
    expect(result.effective.cpus).toBeUndefined();
    expect(result.effective.memoryMb).toBeUndefined();
    expect(result.clamped).toBe(false);
  });

  it('single-core host: cpu ceiling falls back to Docker minimum', () => {
    // A 1-cpu host can't give a container "hostCpus - 1 = 0" -- it has
    // to fall back to Docker's documented minimum (0.01).
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 256, cpus: 2 };
    const result = clampDockerResources(cfg, HOST_1VCPU_1GB);
    expect(result.effective.cpus).toBe(0.01);
    expect(result.clamped).toBe(true);
  });

  it('clamps cpu values below 0.01 up to Docker minimum', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 1024, cpus: 0.001 };
    const result = clampDockerResources(cfg, HOST_8VCPU_16GB);
    expect(result.effective.cpus).toBe(0.01);
  });

  it('clamps memory values below 6 MB up to Docker minimum', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 4, cpus: 1 };
    const result = clampDockerResources(cfg, HOST_8VCPU_16GB);
    expect(result.effective.memoryMb).toBe(6);
  });

  it('reports requested and host snapshots back to the caller', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 8192, cpus: 4 };
    const result = clampDockerResources(cfg, HOST_2VCPU_4GB);
    expect(result.requested).toEqual(cfg);
    expect(result.host).toEqual(HOST_2VCPU_4GB);
  });

  it('fractional cpus are preserved when they fit', () => {
    const cfg: ResolvedDockerResourcesConfig = { memoryMb: 2048, cpus: 1.5 };
    const result = clampDockerResources(cfg, HOST_8VCPU_16GB);
    expect(result.effective.cpus).toBe(1.5);
    expect(result.clamped).toBe(false);
  });
});

describe('parseDockerResourceError', () => {
  it('extracts cpu ceiling from the canonical 2-vCPU error', () => {
    const stderr =
      'docker: Error response from daemon: Range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available.';
    const result = parseDockerResourceError(stderr);
    // Upper bound 2.0 -> suggest 1 (2 - 1) so the host keeps a core.
    expect(result?.cpus).toBe(1);
  });

  it('extracts cpu ceiling from a 1-cpu error (suggests Docker minimum)', () => {
    const stderr = 'Range of CPUs is from 0.01 to 1.00, as there are only 1 CPUs available.';
    const result = parseDockerResourceError(stderr);
    expect(result?.cpus).toBe(0.01);
  });

  it('extracts memory minimum', () => {
    const stderr = 'docker: Minimum memory limit allowed is 6 MB.';
    const result = parseDockerResourceError(stderr);
    expect(result?.memoryMb).toBe(6);
  });

  it('extracts both cpu and memory when both errors present', () => {
    const stderr =
      'Range of CPUs is from 0.01 to 4.00, as there are only 4 CPUs available. Minimum memory limit allowed is 6 MB.';
    const result = parseDockerResourceError(stderr);
    expect(result?.cpus).toBe(3);
    expect(result?.memoryMb).toBe(6);
  });

  it('returns undefined for unrelated errors', () => {
    const stderr = 'docker: Error response from daemon: pull access denied for some-image';
    const result = parseDockerResourceError(stderr);
    expect(result).toBeUndefined();
  });

  it('is case insensitive', () => {
    const stderr = 'range of cpus is from 0.01 to 4.00, AS THERE ARE ONLY 4 CPUS AVAILABLE';
    const result = parseDockerResourceError(stderr);
    expect(result?.cpus).toBe(3);
  });

  it('handles fractional upper bounds without losing precision', () => {
    const stderr = 'Range of CPUs is from 0.01 to 1.50, as there are only 1.50 CPUs available.';
    const result = parseDockerResourceError(stderr);
    // upper = 1.5, > 1, suggest upper - 1 = 0.5
    expect(result?.cpus).toBe(0.5);
  });
});

describe('isImagePresent', () => {
  it('returns true when docker image inspect succeeds', async () => {
    const exec: ExecFileFn = vi.fn().mockResolvedValue({ stdout: '[{}]', stderr: '' });
    const result = await isImagePresent('myimage:latest', exec);
    expect(result).toBe(true);
    expect(exec).toHaveBeenCalledWith('docker', ['image', 'inspect', 'myimage:latest'], expect.any(Object));
  });

  it('returns false when docker image inspect fails', async () => {
    const exec: ExecFileFn = vi.fn().mockRejectedValue(Object.assign(new Error('no such image'), { code: 1 }));
    const result = await isImagePresent('nope:latest', exec);
    expect(result).toBe(false);
  });
});

describe('probeDockerResources', () => {
  it('emits --cpus and --memory flags for numeric values', async () => {
    const exec: ExecFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const result = await probeDockerResources('myimage', { cpus: 1.5, memoryMb: 2048 }, exec);
    expect(result).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith(
      'docker',
      ['run', '--rm', '--cpus', '1.5', '--memory', '2048m', 'myimage', '/usr/bin/true'],
      expect.any(Object),
    );
  });

  it('omits both flags when both are undefined', async () => {
    const exec: ExecFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await probeDockerResources('myimage', { cpus: undefined, memoryMb: undefined }, exec);
    expect(exec).toHaveBeenCalledWith('docker', ['run', '--rm', 'myimage', '/usr/bin/true'], expect.any(Object));
  });

  it('parses cpu range failure into a suggested value', async () => {
    const stderr = 'Range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs available.';
    const exec: ExecFileFn = vi.fn().mockRejectedValue(Object.assign(new Error('docker run failed'), { stderr }));
    const result = await probeDockerResources('myimage', { cpus: 4, memoryMb: undefined }, exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain('Range of CPUs');
      expect(result.suggested).toEqual({ cpus: 1 });
    }
  });

  it('does not throw on probe failure -- always returns a structured result', async () => {
    const exec: ExecFileFn = vi.fn().mockRejectedValue(new Error('unrelated docker error'));
    const result = await probeDockerResources('myimage', { cpus: 1, memoryMb: 1024 }, exec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stderr).toContain('unrelated docker error');
      expect(result.suggested).toBeUndefined();
    }
  });
});
