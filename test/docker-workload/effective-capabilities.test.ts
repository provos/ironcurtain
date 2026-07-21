import { describe, expect, it } from 'vitest';
import {
  effectiveCapabilitiesHash,
  resolveEffectiveCapabilities,
  type ResourceCapabilityEvidence,
  type ResourceMeasurement,
} from '../../src/docker-workload/effective-capabilities.js';
import { resolveDockerWorkloadConfig } from '../../src/docker-workload/config.js';

const hash = 'a'.repeat(64);

describe('effective secure nested resource capabilities', () => {
  it('records Docker Desktop aggregate cgroup limits and an enforced disk quota', () => {
    const result = resolveEffectiveCapabilities({
      backend: 'docker-desktop',
      config: enabledConfig(),
      evidence: evidence({
        cpu: enforced('outer-cgroup', 2),
        memoryMb: enforced('outer-cgroup', 4096),
        pids: enforced('outer-cgroup', 512),
        diskMb: enforced('outer-disk-quota', 8192),
      }),
    });
    expect(result).toMatchObject({
      backend: 'docker-desktop',
      cpu: { status: 'enforced', requested: 2 },
      pids: { status: 'enforced', requested: 512, required: false },
      diskMb: { status: 'enforced', requested: 8192 },
    });
    expect(effectiveCapabilitiesHash(result)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('records Apple hypervisor CPU/memory, unsupported PIDs, and watchdog-observed disk honestly', () => {
    const config = resolveDockerWorkloadConfig({
      enabled: true,
      backend: 'apple-container',
      resources: { diskMb: null },
      acceptObservedDiskRisk: true,
    });
    if (!config.enabled) throw new Error('fixture did not enable Docker workload');
    const result = resolveEffectiveCapabilities({
      backend: 'apple-container',
      config,
      evidence: evidence({
        cpu: enforced('apple-hypervisor', 2),
        memoryMb: enforced('apple-hypervisor', 4096),
        pids: unsupported(),
        diskMb: { status: 'observed', authority: 'host-watchdog', effective: 1024, evidenceSha256: hash },
        watchdog: watchdog(),
      }),
    });
    expect(result).toMatchObject({
      backend: 'apple-container',
      pids: { status: 'unsupported', authority: 'none', effective: null, required: false },
      diskMb: { status: 'observed', authority: 'host-watchdog', requested: null },
      watchdog: { runningBeforeDaemon: true },
    });
  });

  it('rejects Apple required PIDs and any attempt to call guest tuning enforced', () => {
    const requiredConfig = resolveDockerWorkloadConfig({
      enabled: true,
      backend: 'apple-container',
      resources: { pids: { required: true }, diskMb: null },
      acceptObservedDiskRisk: true,
    });
    if (!requiredConfig.enabled) throw new Error('fixture did not enable Docker workload');
    expect(() =>
      resolveEffectiveCapabilities({
        backend: 'apple-container',
        config: requiredConfig,
        evidence: appleObservedEvidence({ pids: unsupported() }),
      }),
    ).toThrow(/cannot satisfy required authoritative PID/u);

    const optionalConfig = resolveDockerWorkloadConfig({
      enabled: true,
      backend: 'apple-container',
      resources: { diskMb: null },
      acceptObservedDiskRisk: true,
    });
    if (!optionalConfig.enabled) throw new Error('fixture did not enable Docker workload');
    expect(() =>
      resolveEffectiveCapabilities({
        backend: 'apple-container',
        config: optionalConfig,
        evidence: appleObservedEvidence({ pids: enforced('outer-cgroup', 512) }),
      }),
    ).toThrow(/PIDs capability must be unsupported by none/u);
  });

  it('rejects observed disk without opt-in, watchdog, or pre-daemon attestation', () => {
    const accepted = resolveDockerWorkloadConfig({
      enabled: true,
      resources: { diskMb: null },
      acceptObservedDiskRisk: true,
    });
    if (!accepted.enabled) throw new Error('fixture did not enable Docker workload');
    const observed = evidence({
      cpu: enforced('outer-cgroup', 2),
      memoryMb: enforced('outer-cgroup', 4096),
      pids: enforced('outer-cgroup', 512),
      diskMb: { status: 'observed', authority: 'host-watchdog', effective: 1024, evidenceSha256: hash },
      watchdog: null,
    });
    expect(() =>
      resolveEffectiveCapabilities({ backend: 'linux-docker', config: accepted, evidence: observed }),
    ).toThrow(/attested pre-daemon host watchdog/u);
    expect(() =>
      resolveEffectiveCapabilities({
        backend: 'linux-docker',
        config: accepted,
        evidence: { ...observed, watchdog: { ...watchdog(), runningBeforeDaemon: false } },
      }),
    ).toThrow(/attested pre-daemon host watchdog/u);

    const forged = { ...accepted, acceptObservedDiskRisk: false };
    expect(() =>
      resolveEffectiveCapabilities({
        backend: 'linux-docker',
        config: forged,
        evidence: { ...observed, watchdog: watchdog() },
      }),
    ).toThrow(/explicit risk acceptance/u);
  });

  it('rejects wrong authority, missing evidence, and effective limits above the request', () => {
    const base = evidence({
      cpu: enforced('outer-cgroup', 2),
      memoryMb: enforced('outer-cgroup', 4096),
      pids: enforced('outer-cgroup', 512),
      diskMb: enforced('outer-disk-quota', 8192),
    });
    expect(() =>
      resolveEffectiveCapabilities({
        backend: 'docker-desktop',
        config: enabledConfig(),
        evidence: { ...base, cpu: enforced('apple-hypervisor', 2) },
      }),
    ).toThrow(/CPU capability must be enforced by outer-cgroup/u);
    expect(() =>
      resolveEffectiveCapabilities({
        backend: 'docker-desktop',
        config: enabledConfig(),
        evidence: { ...base, memoryMb: { ...base.memoryMb, evidenceSha256: null } },
      }),
    ).toThrow(/missing its effective value or evidence hash/u);
    expect(() =>
      resolveEffectiveCapabilities({
        backend: 'docker-desktop',
        config: enabledConfig(),
        evidence: { ...base, cpu: enforced('outer-cgroup', 3) },
      }),
    ).toThrow(/effective value exceeds the requested ceiling/u);
  });
});

function enabledConfig() {
  const config = resolveDockerWorkloadConfig({ enabled: true });
  if (!config.enabled) throw new Error('fixture did not enable Docker workload');
  return config;
}

function enforced(authority: ResourceMeasurement['authority'], effective: number): ResourceMeasurement {
  return { status: 'enforced', authority, effective, evidenceSha256: hash };
}

function unsupported(): ResourceMeasurement {
  return { status: 'unsupported', authority: 'none', effective: null, evidenceSha256: null };
}

function watchdog(): NonNullable<ResourceCapabilityEvidence['watchdog']> {
  return { runningBeforeDaemon: true, policySha256: hash, leaseSha256: hash, statusSha256: hash };
}

function evidence(
  overrides: Partial<ResourceCapabilityEvidence> &
    Pick<ResourceCapabilityEvidence, 'cpu' | 'memoryMb' | 'pids' | 'diskMb'>,
): ResourceCapabilityEvidence {
  return { watchdog: null, ...overrides };
}

function appleObservedEvidence(overrides: Partial<ResourceCapabilityEvidence> = {}): ResourceCapabilityEvidence {
  return {
    cpu: enforced('apple-hypervisor', 2),
    memoryMb: enforced('apple-hypervisor', 4096),
    pids: unsupported(),
    diskMb: { status: 'observed', authority: 'host-watchdog', effective: 1024, evidenceSha256: hash },
    watchdog: watchdog(),
    ...overrides,
  };
}
