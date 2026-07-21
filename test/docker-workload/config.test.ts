import { describe, expect, it } from 'vitest';
import {
  dockerWorkloadConfigHash,
  dockerWorkloadRequestedSchema,
  resolveDockerWorkloadConfig,
} from '../../src/docker-workload/config.js';

describe('secure nested Docker configuration', () => {
  it('resolves absence, an empty object, and explicit false to the same authority-free value', () => {
    const disabled = { enabled: false } as const;
    expect(resolveDockerWorkloadConfig(undefined)).toEqual(disabled);
    expect(resolveDockerWorkloadConfig({})).toEqual(disabled);
    expect(resolveDockerWorkloadConfig({ enabled: false, backend: 'apple-container' })).toEqual(disabled);
    expect(dockerWorkloadConfigHash(disabled)).toBe(dockerWorkloadConfigHash(resolveDockerWorkloadConfig(undefined)));
  });

  it('materializes only fixed policy choices when explicitly enabled', () => {
    expect(resolveDockerWorkloadConfig({ enabled: true })).toEqual({
      enabled: true,
      tier: 'developer-only',
      backend: 'auto',
      imageMode: 'preloaded-catalog',
      imageIngress: 'preloaded-only',
      daemonState: 'ephemeral',
      hostPortPublishing: false,
      buildEgress: 'disabled',
      acceptObservedDiskRisk: false,
      resources: {
        memoryMb: 4096,
        cpus: 2,
        pids: { desired: 512, required: false },
        diskMb: 8192,
      },
    });
  });

  it('accepts bounded operator policy without accepting raw runtime authority', () => {
    expect(
      resolveDockerWorkloadConfig({
        enabled: true,
        backend: 'apple-container',
        buildEgress: 'ironcurtain-dockerfiles',
        resources: { memoryMb: 8192, cpus: 4, pids: { desired: 1024, required: false }, diskMb: null },
        acceptObservedDiskRisk: true,
      }),
    ).toMatchObject({
      enabled: true,
      backend: 'apple-container',
      buildEgress: 'ironcurtain-dockerfiles',
      resources: { memoryMb: 8192, cpus: 4, pids: { desired: 1024, required: false }, diskMb: null },
    });
    for (const forbidden of [
      { image: 'docker:latest' },
      { mounts: ['/var/run/docker.sock:/docker.sock'] },
      { capAdd: ['SYS_ADMIN'] },
      { securityOpt: ['unconfined'] },
      { relayTarget: 'attacker.example:443' },
      { runtimeArgs: ['--privileged'] },
    ]) {
      expect(dockerWorkloadRequestedSchema.safeParse({ enabled: true, ...forbidden }).success).toBe(false);
    }
  });

  it('requires explicit risk acceptance for an unbounded observed disk', () => {
    expect(dockerWorkloadRequestedSchema.safeParse({ enabled: true, resources: { diskMb: null } }).success).toBe(false);
    expect(
      dockerWorkloadRequestedSchema.safeParse({
        enabled: true,
        resources: { diskMb: null },
        acceptObservedDiskRisk: true,
      }).success,
    ).toBe(true);
  });
});
