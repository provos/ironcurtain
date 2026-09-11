import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertAgentVolumeShadowPostcondition,
  assertSnapshotHelperPostcondition,
  parseHostObservationRequest,
  WorkflowSmokeHostObserver,
} from '../../scripts/workflow-smoke-host-observer.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY } from '../../src/docker-workload/infrastructure.js';
import { createQualificationObserverLease } from '../helpers/qualification-observer-lease.js';
import type { ContainerRuntime, DockerContainerConfig } from '../../src/docker/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('host-owned sidecar workflow observation', () => {
  it('accepts only fixed actions and nonces, never agent-supplied paths or identities', () => {
    const request = { schemaVersion: 1, action: 'snapshot', nonce: 'a'.repeat(32) };
    expect(parseHostObservationRequest(request)).toEqual({ action: 'snapshot', nonce: request.nonce });
    for (const value of [
      { ...request, action: 'exec' },
      { ...request, nonce: '../target' },
      { ...request, path: '/var/run/docker.sock' },
      { ...request, container: 'victim' },
    ]) {
      expect(() => parseHostObservationRequest(value)).toThrow('invalid fixed');
    }
  });

  it('requires the exact read-only snapshot-helper mounts and declared-volume shadow', () => {
    const publicMounts = [
      { source: '/stage/ca-cert.pem', target: '/ironcurtain-build-trust/ca-cert.pem', readonly: true },
    ];
    const expected = {
      helperId: 'helper',
      probeSource: '/trusted/probe.py',
      publicMounts,
      apiVolumeName: 'daemon-api',
    };
    const exact = {
      Id: 'helper',
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Privileged: false,
        Tmpfs: { '/var/lib/docker': 'ro,nosuid,nodev,noexec,size=1m' },
      },
      Mounts: [
        { Type: 'bind', Source: '/trusted/probe.py', Destination: '/probe.py', RW: false },
        {
          Type: 'bind',
          Source: '/stage/ca-cert.pem',
          Destination: '/ironcurtain-build-trust/ca-cert.pem',
          RW: false,
        },
        {
          Type: 'volume',
          Name: 'daemon-api',
          Destination: '/home/codespace/.local/share',
          RW: false,
        },
      ],
    };
    expect(() => assertSnapshotHelperPostcondition(exact, expected)).not.toThrow();
    expect(() =>
      assertSnapshotHelperPostcondition(
        {
          ...exact,
          Mounts: [...exact.Mounts, { Type: 'volume', Name: 'anonymous', Destination: '/var/lib/docker', RW: true }],
        },
        expected,
      ),
    ).toThrow('snapshot helper isolation/read-only postcondition failed');
    expect(() =>
      assertSnapshotHelperPostcondition({ ...exact, HostConfig: { ...exact.HostConfig, Tmpfs: {} } }, expected),
    ).toThrow('snapshot helper isolation/read-only postcondition failed');
  });

  it('rejects an outer agent anonymous volume beside the exact API capability', () => {
    const exact = {
      HostConfig: { Tmpfs: { '/var/lib/docker': 'ro,nosuid,nodev,noexec,size=1m' } },
      Mounts: [
        {
          Type: 'volume',
          Name: 'daemon-api',
          Destination: '/run/ironcurtain-docker',
          RW: false,
        },
        { Type: 'bind', Source: '/workspace', Destination: '/workspace', RW: true },
      ],
    };
    expect(() => assertAgentVolumeShadowPostcondition(exact, 'daemon-api')).not.toThrow();
    expect(() =>
      assertAgentVolumeShadowPostcondition(
        { ...exact, HostConfig: { Tmpfs: { '/var/lib/docker': 'size=1m,noexec,nodev,nosuid,ro' } } },
        'daemon-api',
      ),
    ).not.toThrow();
    expect(() =>
      assertAgentVolumeShadowPostcondition(
        {
          ...exact,
          Mounts: [...exact.Mounts, { Type: 'volume', Name: 'anonymous', Destination: '/var/lib/docker', RW: true }],
        },
        'daemon-api',
      ),
    ).toThrow('workflow agent inherited-volume shadow postcondition failed');
  });

  it.each([
    { cleanupFailsOnce: false, scannerFails: false },
    { cleanupFailsOnce: true, scannerFails: false },
    { cleanupFailsOnce: true, scannerFails: true },
  ])('keeps exact helper cleanup retryable: %j', async ({ cleanupFailsOnce, scannerFails }) => {
    const root = mkdtempSync(join(tmpdir(), 'ic-host-observer-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.workflow'), { recursive: true });
    mkdirSync(join(root, 'stage'));
    const leaves = ['build-trust-contract.json', 'ca-cert.pem', 'ca-bundle.pem', 'apt.conf'];
    for (const leaf of leaves) writeFileSync(join(root, 'stage', leaf), `public ${leaf}\n`);
    const { leasePath, generation } = createQualificationObserverLease(root);
    let helperConfig: DockerContainerConfig | undefined;
    let helperExists = false;
    const remove = vi.fn(async () => {
      helperExists = false;
    });
    if (cleanupFailsOnce)
      remove.mockImplementationOnce(async () => {
        throw new Error('transient cleanup failure');
      });
    const exec = vi.fn(async (id: string) => ({
      exitCode: id === 'helper' && scannerFails ? 1 : 0,
      stdout:
        id === 'helper'
          ? 'IRONCURTAIN_SNAPSHOT_SCAN_BEGIN/1\nIRONCURTAIN_SNAPSHOT_SCAN_OK/1\n'
          : 'ironcurtain-build-trust-inputs/2\n',
      stderr: '',
    }));
    const runtime = {
      inspectVolume: async () => ({
        name: 'daemon-api',
        labels: { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: generation },
      }),
      inspectContainerRaw: async (id: string) => {
        if (id === 'helper')
          return helperExists
            ? {
                Id: 'helper',
                HostConfig: {
                  NetworkMode: 'none',
                  ReadonlyRootfs: true,
                  Privileged: false,
                  Tmpfs: { '/var/lib/docker': 'ro,nosuid,nodev,noexec,size=1m' },
                },
                Mounts: [
                  { Type: 'bind', Source: '/trusted/probe.py', Destination: '/probe.py', RW: false },
                  ...leaves.map((leaf) => ({
                    Type: 'bind',
                    Source: join(root, 'stage', leaf),
                    Destination: `/ironcurtain-build-trust/${leaf}`,
                    RW: false,
                  })),
                  {
                    Type: 'volume',
                    Name: 'daemon-api',
                    Destination: '/home/codespace/.local/share',
                    RW: false,
                  },
                ],
              }
            : undefined;
        if (id === 'agent')
          return {
            Id: id,
            Image: `sha256:${'a'.repeat(64)}`,
            Config: { Labels: { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: generation } },
            HostConfig: { Tmpfs: { '/var/lib/docker': 'ro,nosuid,nodev,noexec,size=1m' } },
            State: { Running: true },
            Mounts: [
              {
                Type: 'volume',
                Name: 'daemon-api',
                Destination: '/run/ironcurtain-docker',
                RW: false,
              },
            ],
          };
        return {
          Id: id,
          Image: `sha256:${'a'.repeat(64)}`,
          Config: { Labels: { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: generation } },
          State: { Running: true },
          Mounts: [
            { Destination: '/home/codespace/.local/share', Type: 'volume', Name: 'daemon-api' },
            { Destination: '/ironcurtain-build-trust', Type: 'bind', RW: false, Source: join(root, 'stage') },
          ],
        };
      },
      create: async (config: DockerContainerConfig) => {
        helperConfig = config;
        helperExists = true;
        return 'helper';
      },
      start: async () => {},
      exec,
      remove,
    } as unknown as ContainerRuntime;
    const onFailure = vi.fn();
    const observer = new WorkflowSmokeHostObserver({
      runtime,
      workspace,
      probeSource: '/trusted/probe.py',
      getLeasePath: () => leasePath,
      getStagingRoot: () => join(root, 'stage'),
      daemonExecUser: '1234:2345',
      onFailure,
    });
    let stopped = false;
    try {
      for (const [index, action] of ['public-trust', 'snapshot'].entries()) {
        const nonce = String(index).repeat(32);
        writeFileSync(
          join(workspace, '.workflow/host-observation-request.json'),
          JSON.stringify({ schemaVersion: 1, action, nonce }),
        );
        let response: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            response = JSON.parse(
              readFileSync(join(workspace, '.workflow/host-observation-response.json'), 'utf8'),
            ) as Record<string, unknown>;
          } catch {
            /* Response not published yet. */
          }
          if (response?.nonce === nonce || onFailure.mock.calls.length > 0) break;
          await delay(10);
        }
        if (action !== 'snapshot' || !cleanupFailsOnce)
          expect(response).toMatchObject({ action, nonce, generation, passed: true });
      }
      if (cleanupFailsOnce) {
        expect(onFailure).toHaveBeenCalledOnce();
        stopped = true;
        const failure = await observer.stop().then(
          () => undefined,
          (error: unknown) => error,
        );
        if (scannerFails) {
          expect(failure).toBeInstanceOf(AggregateError);
          expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
            expect.stringContaining('host snapshot scanner failed'),
            'transient cleanup failure',
          ]);
        } else expect(failure).toMatchObject({ message: 'transient cleanup failure' });
        expect(remove).toHaveBeenCalledTimes(2);
        expect(helperExists).toBe(false);
        return;
      }
      observer.assertComplete();
      expect(onFailure).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledWith(
        'nested-daemon',
        ['/ironcurtain-build-trust/runc', '--ironcurtain-verify-protected-inputs-v2'],
        30_000,
        '1234:2345',
      );
      expect(helperConfig).toMatchObject({
        bundleLabel: 'observer-bundle',
        labels: { [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: generation },
        network: 'none',
        extraHosts: [],
        ports: [],
        capAdd: ['DAC_READ_SEARCH'],
        resources: { cpus: 1, memoryMb: 512 },
        trustedCreateOptions: {
          readOnlyRootfs: true,
          pidsLimit: 32,
          namedVolumeMounts: [
            { name: 'daemon-api', target: '/home/codespace/.local/share', readonly: true, noCopy: true },
          ],
          tmpfs: ['/var/lib/docker:ro,nosuid,nodev,noexec,size=1m'],
        },
      });
      expect(helperConfig?.mounts.every((mount) => mount.readonly)).toBe(true);
      expect(loadDockerWorkloadLease(leasePath).resources.at(-1)).toMatchObject({
        role: 'qualification-observer',
        requestedName: helperConfig!.name,
        observedId: 'helper',
      });
      expect(remove).toHaveBeenCalledExactlyOnceWith('helper');
      expect(helperExists).toBe(false);
    } finally {
      if (!stopped) await observer.stop();
    }
  });
});
