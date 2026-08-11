/** Host-authoritative resource claims for one concrete nested-Docker bundle. */

import { z } from 'zod';
import { computeHash, sha256HexSchema as sha256Schema } from '../hash.js';
import type { ResolvedDockerWorkloadConfig } from './config.js';

export const EFFECTIVE_CAPABILITIES_SCHEMA_VERSION = 1;

const positiveSchema = z.number().positive();

const measurementSchema = z
  .object({
    status: z.enum(['enforced', 'observed', 'unsupported']),
    authority: z.enum([
      'outer-cgroup',
      'apple-hypervisor',
      'outer-disk-quota',
      'apple-disk-quota',
      'host-watchdog',
      'none',
    ]),
    effective: positiveSchema.nullable(),
    evidenceSha256: sha256Schema.nullable(),
  })
  .strict();

const resourceEvidenceSchema = z
  .object({
    cpu: measurementSchema,
    memoryMb: measurementSchema,
    pids: measurementSchema,
    diskMb: measurementSchema,
    watchdog: z
      .object({
        runningBeforeDaemon: z.boolean(),
        policySha256: sha256Schema,
        leaseSha256: sha256Schema,
        statusSha256: sha256Schema,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ResourceMeasurement = z.infer<typeof measurementSchema>;
export type ResourceCapabilityEvidence = z.infer<typeof resourceEvidenceSchema>;

export interface EffectiveCapabilities {
  readonly schemaVersion: typeof EFFECTIVE_CAPABILITIES_SCHEMA_VERSION;
  readonly backend: 'docker-desktop' | 'apple-container' | 'linux-docker';
  readonly cpu: ResourceMeasurement & { readonly requested: number };
  readonly memoryMb: ResourceMeasurement & { readonly requested: number };
  readonly pids: ResourceMeasurement & { readonly requested: number; readonly required: boolean };
  readonly diskMb: ResourceMeasurement & { readonly requested: number | null };
  readonly watchdog: ResourceCapabilityEvidence['watchdog'];
}

/**
 * Derive claims from trusted outer observations. Unsupported/advisory guest
 * settings remain visible but can never be promoted to enforced authority.
 */
export function resolveEffectiveCapabilities(options: {
  readonly backend: EffectiveCapabilities['backend'];
  readonly config: Extract<ResolvedDockerWorkloadConfig, { readonly enabled: true }>;
  readonly evidence: ResourceCapabilityEvidence;
}): EffectiveCapabilities {
  const evidence = resourceEvidenceSchema.parse(options.evidence);
  const { resources } = options.config;
  const apple = options.backend === 'apple-container';

  requireMeasurement('CPU', evidence.cpu, 'enforced', apple ? 'apple-hypervisor' : 'outer-cgroup', resources.cpus);
  requireMeasurement(
    'memory',
    evidence.memoryMb,
    'enforced',
    apple ? 'apple-hypervisor' : 'outer-cgroup',
    resources.memoryMb,
  );

  if (apple) {
    if (resources.pids.required) {
      throw new Error('Apple Container cannot satisfy required authoritative PID enforcement');
    }
    requireMeasurement('PIDs', evidence.pids, 'unsupported', 'none', null);
  } else if (resources.pids.required) {
    requireMeasurement('PIDs', evidence.pids, 'enforced', 'outer-cgroup', resources.pids.desired);
  } else {
    requireAdvisoryOrEnforcedPids(evidence.pids, resources.pids.desired);
  }

  if (resources.diskMb !== null) {
    requireMeasurement(
      'disk',
      evidence.diskMb,
      'enforced',
      apple ? 'apple-disk-quota' : 'outer-disk-quota',
      resources.diskMb,
    );
    if (evidence.watchdog !== null && !evidence.watchdog.runningBeforeDaemon) {
      throw new Error('resource watchdog was not running before daemon admission');
    }
  } else {
    if (!options.config.acceptObservedDiskRisk) {
      throw new Error('observed-only disk requires explicit risk acceptance');
    }
    requireMeasurement('disk', evidence.diskMb, 'observed', 'host-watchdog', null, true);
    if (evidence.watchdog === null || !evidence.watchdog.runningBeforeDaemon) {
      throw new Error('observed-only disk requires an attested pre-daemon host watchdog');
    }
  }

  return {
    schemaVersion: EFFECTIVE_CAPABILITIES_SCHEMA_VERSION,
    backend: options.backend,
    cpu: { ...evidence.cpu, requested: resources.cpus },
    memoryMb: { ...evidence.memoryMb, requested: resources.memoryMb },
    pids: { ...evidence.pids, requested: resources.pids.desired, required: resources.pids.required },
    diskMb: { ...evidence.diskMb, requested: resources.diskMb },
    watchdog: evidence.watchdog,
  };
}

export function effectiveCapabilitiesHash(capabilities: EffectiveCapabilities): string {
  return computeHash(capabilities);
}

function requireMeasurement(
  label: string,
  measurement: ResourceMeasurement,
  status: ResourceMeasurement['status'],
  authority: ResourceMeasurement['authority'],
  requested: number | null,
  allowObservedValue = false,
): void {
  if (measurement.status !== status || measurement.authority !== authority) {
    throw new Error(
      `${label} capability must be ${status} by ${authority}; got ${measurement.status} by ${measurement.authority}`,
    );
  }
  if (status === 'unsupported') {
    if (measurement.effective !== null || measurement.evidenceSha256 !== null) {
      throw new Error(`${label} unsupported capability must not claim an effective value or authoritative evidence`);
    }
    return;
  }
  if (measurement.effective === null || measurement.evidenceSha256 === null) {
    throw new Error(`${label} capability is missing its effective value or evidence hash`);
  }
  if (requested !== null && measurement.effective > requested) {
    throw new Error(`${label} effective value exceeds the requested ceiling`);
  }
  if (status === 'observed' && !allowObservedValue) {
    throw new Error(`${label} observed value cannot satisfy an enforced resource claim`);
  }
}

function requireAdvisoryOrEnforcedPids(measurement: ResourceMeasurement, requested: number): void {
  if (measurement.status === 'enforced') {
    requireMeasurement('PIDs', measurement, 'enforced', 'outer-cgroup', requested);
    return;
  }
  if (
    measurement.status !== 'unsupported' ||
    measurement.authority !== 'none' ||
    measurement.effective !== null ||
    measurement.evidenceSha256 !== null
  ) {
    throw new Error('non-required PIDs must be enforced by the outer cgroup or recorded as unsupported');
  }
}
