/** Operator-requested and trusted-resolved secure nested Docker capability. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../hash.js';

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

/** Feature-off is a one-field value carrying no latent nested authority. */
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
  const serialized = stableStringify(config);
  if (serialized === undefined) throw new Error('resolved Docker workload configuration is not serializable');
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Temporary admission fuse while Phase 0C has qualified no concrete variant.
 * Keeping it at the first image/runtime boundary makes opt-in fail closed
 * without changing ordinary disabled sessions. Product integration replaces
 * this only with a hash-bound passing qualification admission record.
 */
export function assertDockerWorkloadImplementationAvailable(config: ResolvedDockerWorkloadConfig | undefined): void {
  if (config?.enabled === true) {
    throw new Error(
      'secure nested Docker is not implementation-qualified on any backend; no image, relay, or daemon action was performed',
    );
  }
}
