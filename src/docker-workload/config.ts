/** Operator-requested and trusted-resolved secure nested Docker capability. */

import { z } from 'zod';
import { computeHash } from '../hash.js';

export const DOCKER_WORKLOAD_BACKENDS = ['auto', 'docker', 'apple-container'] as const;

const requestedResourcesSchema = z
  .object({
    memoryMb: z
      .number()
      .int()
      .min(512)
      .max(1024 * 1024)
      .optional(),
    cpus: z.number().min(0.25).max(1024).optional(),
    pids: z
      .object({
        desired: z.number().int().min(16).max(1_048_576).optional(),
        required: z.boolean().optional(),
      })
      .strict()
      .optional(),
    diskMb: z
      .number()
      .int()
      .min(512)
      .max(16 * 1024 * 1024)
      .nullable()
      .optional(),
  })
  .strict()
  .optional();

/**
 * Deliberately narrow: users select policy, never images, paths, profiles,
 * mounts, capabilities, devices, relay targets, or arbitrary runtime args.
 */
export const dockerWorkloadRequestedSchema = z
  .object({
    enabled: z.boolean().optional(),
    tier: z.literal('developer-only').optional(),
    backend: z.enum(DOCKER_WORKLOAD_BACKENDS).optional(),
    imageMode: z.literal('preloaded-catalog').optional(),
    imageIngress: z.enum(['preloaded-only', 'public-registry']).optional(),
    daemonState: z.literal('ephemeral').optional(),
    hostPortPublishing: z.literal(false).optional(),
    buildEgress: z.enum(['disabled', 'ironcurtain-dockerfiles']).optional(),
    acceptObservedDiskRisk: z.boolean().optional(),
    resources: requestedResourcesSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.resources?.diskMb === null && request.acceptObservedDiskRisk !== true) {
      context.addIssue({
        code: 'custom',
        path: ['acceptObservedDiskRisk'],
        message: 'unbounded Docker workload disk requires explicit observed-disk risk acceptance',
      });
    }
  });

export type DockerWorkloadRequestedConfig = z.infer<typeof dockerWorkloadRequestedSchema>;

export type ResolvedDockerWorkloadConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly tier: 'developer-only';
      readonly backend: (typeof DOCKER_WORKLOAD_BACKENDS)[number];
      readonly imageMode: 'preloaded-catalog';
      readonly imageIngress: 'preloaded-only' | 'public-registry';
      readonly daemonState: 'ephemeral';
      readonly hostPortPublishing: false;
      readonly buildEgress: 'disabled' | 'ironcurtain-dockerfiles';
      readonly acceptObservedDiskRisk: boolean;
      readonly resources: {
        readonly memoryMb: number;
        readonly cpus: number;
        readonly pids: { readonly desired: number; readonly required: boolean };
        readonly diskMb: number | null;
      };
    };

/** Feature-off is a one-field value carrying no per-session provisioned authority. */
export function resolveDockerWorkloadConfig(
  request: DockerWorkloadRequestedConfig | undefined,
): ResolvedDockerWorkloadConfig {
  const validated = dockerWorkloadRequestedSchema.parse(request ?? {});
  if (validated.enabled !== true) return { enabled: false };
  return {
    enabled: true,
    tier: validated.tier ?? 'developer-only',
    backend: validated.backend ?? 'auto',
    imageMode: validated.imageMode ?? 'preloaded-catalog',
    imageIngress: validated.imageIngress ?? 'preloaded-only',
    daemonState: validated.daemonState ?? 'ephemeral',
    hostPortPublishing: false,
    buildEgress: validated.buildEgress ?? 'disabled',
    acceptObservedDiskRisk: validated.acceptObservedDiskRisk ?? false,
    resources: {
      memoryMb: validated.resources?.memoryMb ?? 4096,
      cpus: validated.resources?.cpus ?? 2,
      pids: {
        desired: validated.resources?.pids?.desired ?? 512,
        required: validated.resources?.pids?.required ?? false,
      },
      diskMb: validated.resources?.diskMb === undefined ? 8192 : validated.resources.diskMb,
    },
  };
}

export function dockerWorkloadConfigHash(config: ResolvedDockerWorkloadConfig): string {
  return computeHash(config);
}

/**
 * Admit only the Mac developer slice whose complete runtime path is currently
 * implemented. The caller resolves `auto` first, then invokes this guard before
 * any feature-attributable runtime, image, catalog, proxy, lease, or filesystem
 * provisioning. Operational artifacts are verified later by their owning
 * seams; this guard deliberately contains no release/commit bookkeeping.
 */
export function assertDockerWorkloadVariantAdmitted(
  config: ResolvedDockerWorkloadConfig | undefined,
  resolvedRuntimeKind: 'docker' | 'apple-container',
): void {
  if (config?.enabled !== true) return;
  const admitted =
    resolvedRuntimeKind === 'apple-container' &&
    (config.backend === 'auto' || config.backend === 'apple-container') &&
    config.buildEgress === 'disabled' &&
    !config.resources.pids.required &&
    config.resources.diskMb === null &&
    config.acceptObservedDiskRisk;
  if (!admitted) {
    throw new Error(
      'secure nested Docker currently admits only the Apple Container developer-only preloaded-catalog ephemeral variant (offline or public-registry ingress with no IronCurtain-provided registry credentials) with host ports and build egress disabled, advisory PID limits, and explicit observed-disk risk acceptance; no image, relay, daemon, or lease action was performed',
    );
  }
}

/** Read-only platform preflight required after the supported variant is selected. */
export async function assertAdmittedDockerWorkloadRuntimeAvailable(): Promise<void> {
  const { checkAppleContainerAvailable } = await import('../docker/apple-container-manager.js');
  const availability = await checkAppleContainerAvailable();
  if (!availability.available) {
    throw new Error(
      `secure nested Docker Apple runtime is unavailable: ${availability.reason}` +
        (availability.detailedMessage ? ` (${availability.detailedMessage})` : ''),
    );
  }
}
