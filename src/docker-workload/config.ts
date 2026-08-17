/** Operator-requested and trusted-resolved secure nested Docker capability. */

import { z } from 'zod';
import { computeHash } from '../hash.js';

const LEGACY_DOCKER_WORKLOAD_BACKENDS = ['auto', 'docker', 'apple-container'] as const;

const DOCKER_WORKLOAD_MEMORY_MIN_MB = 512;
const DOCKER_WORKLOAD_MEMORY_MAX_MB = 1024 * 1024;
const DOCKER_WORKLOAD_CPU_MIN = 0.25;
const DOCKER_WORKLOAD_CPU_MAX = 1024;

const legacyRequestedResourcesSchema = z
  .object({
    memoryMb: z.number().int().min(DOCKER_WORKLOAD_MEMORY_MIN_MB).max(DOCKER_WORKLOAD_MEMORY_MAX_MB).optional(),
    cpus: z.number().min(DOCKER_WORKLOAD_CPU_MIN).max(DOCKER_WORKLOAD_CPU_MAX).optional(),
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
 * Existing configs may contain the old implementation-policy fields. Accept
 * only values equivalent to today's admitted developer slice, then transform
 * them away so every caller sees the canonical two-choice request. Legacy
 * values that expressed unsupported intent fail with an actionable message
 * instead of being silently weakened.
 */
export const dockerWorkloadRequestedSchema = z
  .object({
    enabled: z.boolean().optional(),
    tier: z.literal('developer-only').optional(),
    backend: z.enum(LEGACY_DOCKER_WORKLOAD_BACKENDS).optional(),
    imageMode: z.literal('preloaded-catalog').optional(),
    imageIngress: z.enum(['preloaded-only', 'public-registry']).optional(),
    daemonState: z.literal('ephemeral').optional(),
    hostPortPublishing: z.literal(false).optional(),
    buildEgress: z.enum(['disabled', 'ironcurtain-dockerfiles']).optional(),
    acceptObservedDiskRisk: z.boolean().optional(),
    resources: legacyRequestedResourcesSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.backend === 'docker') {
      context.addIssue({
        code: 'custom',
        path: ['backend'],
        message:
          'legacy nested-Docker backend "docker" is not supported; remove dockerWorkload.backend and use the current Apple Container developer slice',
      });
    }
    if (request.buildEgress === 'ironcurtain-dockerfiles') {
      context.addIssue({
        code: 'custom',
        path: ['buildEgress'],
        message:
          'legacy nested-Docker build egress is not supported; remove dockerWorkload.buildEgress or disable nested Docker',
      });
    }
    if (request.acceptObservedDiskRisk === false) {
      context.addIssue({
        code: 'custom',
        path: ['acceptObservedDiskRisk'],
        message:
          'the current nested-Docker developer slice requires the fixed observed-disk policy; remove acceptObservedDiskRisk or disable nested Docker',
      });
    }
    if (request.resources?.memoryMb !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'memoryMb'],
        message: 'legacy nested-Docker memory overrides are no longer supported; use dockerResources.memoryMb',
      });
    }
    if (request.resources?.cpus !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'cpus'],
        message: 'legacy nested-Docker CPU overrides are no longer supported; use dockerResources.cpus',
      });
    }
    if (request.resources?.pids?.desired !== undefined && request.resources.pids.desired !== 512) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'pids', 'desired'],
        message: 'custom nested-Docker PID targets are no longer supported by user configuration',
      });
    }
    if (request.resources?.pids?.required === true) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'pids', 'required'],
        message: 'required nested-Docker PID enforcement is not supported by the current Apple developer slice',
      });
    }
    if (request.resources?.diskMb !== undefined && request.resources.diskMb !== null) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'diskMb'],
        message: 'numeric nested-Docker disk limits are not supported by the current Apple developer slice',
      });
    }
  })
  .transform((request) => ({
    ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
    ...(request.imageIngress === undefined ? {} : { imageIngress: request.imageIngress }),
  }));

export type DockerWorkloadRequestedConfig = z.infer<typeof dockerWorkloadRequestedSchema>;

export type ResolvedDockerWorkloadConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly imageIngress: 'preloaded-only' | 'public-registry';
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
  resourceDefaults?: { readonly memoryMb?: number; readonly cpus?: number },
): ResolvedDockerWorkloadConfig {
  const validated = dockerWorkloadRequestedSchema.parse(request ?? {});
  if (validated.enabled !== true) return { enabled: false };
  const inheritedMemoryMb = clampInheritedResourceDefault(
    resourceDefaults?.memoryMb,
    DOCKER_WORKLOAD_MEMORY_MIN_MB,
    DOCKER_WORKLOAD_MEMORY_MAX_MB,
    4096,
  );
  const inheritedCpus = clampInheritedResourceDefault(
    resourceDefaults?.cpus,
    DOCKER_WORKLOAD_CPU_MIN,
    DOCKER_WORKLOAD_CPU_MAX,
    2,
  );
  return {
    enabled: true,
    imageIngress: validated.imageIngress ?? 'public-registry',
    buildEgress: 'disabled',
    // The currently admitted Apple developer slice uses an observed-only
    // disk ceiling guarded by the host watchdog. Keep that implementation
    // detail out of the ordinary opt-in: `{ enabled: true }` must resolve to
    // a usable configuration without requiring hidden risk-policy fields.
    acceptObservedDiskRisk: true,
    resources: {
      memoryMb: inheritedMemoryMb,
      cpus: inheritedCpus,
      pids: {
        desired: 512,
        required: false,
      },
      diskMb: null,
    },
  };
}

function clampInheritedResourceDefault(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Concise user-visible status for Docker-agent entrypoints and session logs. */
export function formatDockerWorkloadStatus(config: ResolvedDockerWorkloadConfig | undefined): string | undefined {
  if (config?.enabled !== true) return undefined;
  const pulls =
    config.imageIngress === 'public-registry' ? 'Docker Hub/GHCR via mediated proxy' : 'off (local images only)';
  return `Nested Docker: enabled · pulls: ${pulls}`;
}

export function dockerWorkloadConfigHash(config: ResolvedDockerWorkloadConfig): string {
  return computeHash(config);
}

/**
 * Admit only the Mac developer slice whose complete runtime path is currently
 * implemented. The caller resolves `auto` first, then invokes this guard before
 * any feature-attributable runtime, image, proxy, lease, or filesystem
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
    config.buildEgress === 'disabled' &&
    !config.resources.pids.required &&
    config.resources.diskMb === null &&
    config.acceptObservedDiskRisk;
  if (!admitted) {
    throw new Error(
      'secure nested Docker currently admits only the Apple Container developer slice with mediated public pulls or local-only image ingress; no image, relay, daemon, or lease action was performed',
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
