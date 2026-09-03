/** Operator-requested and trusted-resolved secure nested Docker capability. */

import { z } from 'zod';
import { computeHash } from '../hash.js';

const LEGACY_DOCKER_WORKLOAD_BACKENDS = ['auto', 'docker', 'apple-container'] as const;

export const DOCKER_WORKLOAD_NETWORK_ACCESS = ['offline', 'images', 'packages'] as const;
export type DockerWorkloadNetworkAccess = (typeof DOCKER_WORKLOAD_NETWORK_ACCESS)[number];
export const DOCKER_WORKLOAD_PACKAGE_NETWORK_WARNING =
  'Packages permits any process in this nested-Docker session to send bounded workspace or build data through allowed package paths, permitted request metadata, and timing to fixed public repositories, and to download untrusted content. IronCurtain does not inject credentials and rejects recognized credential fields and request bodies. It screens the immediate peer, but a public repository may relay or hairpin elsewhere; use Images only or Offline to remove this route.';

const STORED_DOCKER_WORKLOAD_NETWORK_ACCESS = [...DOCKER_WORKLOAD_NETWORK_ACCESS, 'public'] as const;

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
 * them away so every caller sees the canonical network-access request. Legacy
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
    networkAccess: z.enum(STORED_DOCKER_WORKLOAD_NETWORK_ACCESS).optional(),
    daemonState: z.literal('ephemeral').optional(),
    hostPortPublishing: z.literal(false).optional(),
    buildEgress: z.enum(['disabled', 'ironcurtain-dockerfiles']).optional(),
    acceptObservedDiskRisk: z.boolean().optional(),
    resources: legacyRequestedResourcesSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.imageIngress !== undefined && request.networkAccess !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['networkAccess'],
        message:
          'dockerWorkload.imageIngress and dockerWorkload.networkAccess cannot be combined; remove imageIngress and keep the explicit networkAccess choice',
      });
    }
    if (request.backend === 'docker') {
      context.addIssue({
        code: 'custom',
        path: ['backend'],
        message:
          'legacy dockerWorkload.backend is no longer supported; remove it and set containerRuntime to "docker" to select Docker Desktop',
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
        message: 'required nested-Docker PID enforcement is not supported by the current macOS developer slice',
      });
    }
    if (request.resources?.diskMb !== undefined && request.resources.diskMb !== null) {
      context.addIssue({
        code: 'custom',
        path: ['resources', 'diskMb'],
        message: 'numeric nested-Docker disk limits are not supported by the current macOS developer slice',
      });
    }
  })
  .transform((request) => {
    const networkAccess =
      (request.networkAccess === 'public' ? 'packages' : request.networkAccess) ??
      (request.imageIngress === 'public-registry'
        ? 'images'
        : request.imageIngress === 'preloaded-only'
          ? 'offline'
          : request.enabled === true
            ? 'images'
            : undefined);
    return {
      ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
      ...(networkAccess === undefined ? {} : { networkAccess }),
    };
  });

export type DockerWorkloadRequestedConfig = z.infer<typeof dockerWorkloadRequestedSchema>;

export type ResolvedDockerWorkloadConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly networkAccess: DockerWorkloadNetworkAccess;
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
    networkAccess: validated.networkAccess ?? 'images',
    // The currently admitted macOS developer slice uses an observed-only disk
    // ceiling guarded by the host watchdog on both backends. Keep that
    // implementation detail out of the ordinary opt-in: `{ enabled: true }`
    // must resolve without requiring hidden risk-policy fields.
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
  switch (config.networkAccess) {
    case 'packages':
      return 'Nested Docker: enabled · network: public packages + Docker Hub/GHCR (strict proxy)';
    case 'images':
      return 'Nested Docker: enabled · network: Docker Hub/GHCR images only';
    case 'offline':
      return 'Nested Docker: enabled · network: offline';
  }
}

export function dockerWorkloadConfigHash(config: ResolvedDockerWorkloadConfig): string {
  return computeHash(config);
}

/**
 * Admit only a supported developer slice. The caller resolves `auto` first,
 * then invokes this guard before any feature-attributable runtime, image,
 * proxy, lease, or filesystem provisioning. Docker Desktop is admitted only
 * on Darwin; Apple Container performs its platform/version checks in the
 * runtime-availability preflight below. Operational artifacts are verified
 * later by their owning seams; this guard deliberately contains no
 * release/commit bookkeeping.
 */
export function assertDockerWorkloadVariantAdmitted(
  config: ResolvedDockerWorkloadConfig | undefined,
  resolvedRuntimeKind: 'docker' | 'apple-container',
  hostPlatform: NodeJS.Platform = process.platform,
): void {
  if (config?.enabled !== true) return;
  if (config.resources.pids.required || config.resources.diskMb !== null || !config.acceptObservedDiskRisk) {
    throw new Error(
      'secure nested Docker does not admit the requested resource policy; no image, relay, daemon, or lease action was performed',
    );
  }
  if (resolvedRuntimeKind === 'docker' && hostPlatform !== 'darwin') {
    throw new Error(
      `secure nested Docker with the Docker runtime is supported only on macOS (Darwin), not ${hostPlatform}; no image, relay, daemon, or lease action was performed`,
    );
  }
}

/** Read-only runtime preflight required after the supported variant is selected. */
export async function assertAdmittedDockerWorkloadRuntimeAvailable(
  resolvedRuntimeKind: 'docker' | 'apple-container',
): Promise<void> {
  const checkAvailability =
    resolvedRuntimeKind === 'docker'
      ? (await import('../docker/docker-probe.js')).checkDockerAvailable
      : (await import('../docker/apple-container-manager.js')).checkAppleContainerAvailable;
  const availability = await checkAvailability();
  if (!availability.available) {
    const runtimeName = resolvedRuntimeKind === 'docker' ? 'Docker' : 'Apple';
    throw new Error(
      `secure nested Docker ${runtimeName} runtime is unavailable: ${availability.reason}` +
        (availability.detailedMessage ? ` (${availability.detailedMessage})` : ''),
    );
  }
}
