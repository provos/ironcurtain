/** Trusted Docker client/daemon compatibility manifest and live preflight. */

import { z } from 'zod';
import { loadImmutableHostJson } from '../hardened-fs.js';
import { computeHash } from '../hash.js';
import type { ContainerRuntime } from '../docker/types.js';
import { compareDockerApiVersions } from '../docker/docker-api-version.js';

export const CLIENT_TOOLCHAIN_SCHEMA_VERSION = 1;
export const MAX_CLIENT_TOOLCHAIN_MANIFEST_BYTES = 64 * 1024;
export const DOCKER_VERSION_PREFLIGHT_ARGV = ['docker', 'version', '--format', '{{json .}}'] as const;
export const DOCKER_BUILDX_VERSION_PREFLIGHT_ARGV = ['docker', 'buildx', 'version'] as const;
export const DOCKER_COMPOSE_VERSION_PREFLIGHT_ARGV = ['docker', 'compose', 'version', '--short'] as const;
export const CLIENT_TOOLCHAIN_PREFLIGHT_ARGVS = [
  DOCKER_VERSION_PREFLIGHT_ARGV,
  DOCKER_BUILDX_VERSION_PREFLIGHT_ARGV,
  DOCKER_COMPOSE_VERSION_PREFLIGHT_ARGV,
] as const;

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
const apiVersionSchema = z.string().regex(/^\d{1,3}\.\d{1,3}$/u);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const clientToolchainManifestSchema = z
  .object({
    schemaVersion: z.literal(CLIENT_TOOLCHAIN_SCHEMA_VERSION),
    generation: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    platform: z.literal('linux'),
    architecture: z.enum(['amd64', 'arm64']),
    source: z
      .object({
        daemonImage: z.string().regex(/^[A-Za-z0-9./_-]+@sha256:[a-f0-9]{64}$/u),
        daemonImageId: digestSchema,
      })
      .strict(),
    docker: z
      .object({
        cliVersion: versionSchema,
        daemonVersion: versionSchema,
        clientApiVersion: apiVersionSchema,
        daemonApiVersion: apiVersionSchema,
        minimumDaemonApiVersion: apiVersionSchema,
        compatibleApiRange: z.object({ min: apiVersionSchema, max: apiVersionSchema }).strict(),
      })
      .strict(),
    buildxVersion: versionSchema,
    composeVersion: versionSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const { min, max } = manifest.docker.compatibleApiRange;
    if (compareDockerApiVersions(min, max) > 0) {
      context.addIssue({ code: 'custom', message: 'compatible Docker API range is reversed' });
    }
    for (const [name, value] of [
      ['client', manifest.docker.clientApiVersion],
      ['daemon', manifest.docker.daemonApiVersion],
    ] as const) {
      if (!apiVersionInRange(value, min, max)) {
        context.addIssue({ code: 'custom', message: `${name} Docker API is outside the compatible range` });
      }
    }
    if (compareDockerApiVersions(manifest.docker.minimumDaemonApiVersion, manifest.docker.daemonApiVersion) > 0) {
      context.addIssue({ code: 'custom', message: 'minimum daemon Docker API exceeds the daemon API' });
    }
  });

const dockerVersionOutputSchema = z
  .object({
    Client: z
      .object({
        Version: versionSchema,
        ApiVersion: apiVersionSchema,
        Os: z.literal('linux'),
        Arch: z.enum(['amd64', 'arm64']),
      })
      .loose(),
    Server: z
      .object({
        Version: versionSchema,
        ApiVersion: apiVersionSchema,
        MinAPIVersion: apiVersionSchema,
        Os: z.literal('linux'),
        Arch: z.enum(['amd64', 'arm64']),
      })
      .loose(),
  })
  .loose();

export type ClientToolchainManifest = z.infer<typeof clientToolchainManifestSchema>;

export interface LoadedClientToolchainManifest {
  readonly path: string;
  readonly sha256: string;
  readonly manifest: ClientToolchainManifest;
}

export interface ClientToolchainPreflight {
  readonly architecture: 'amd64' | 'arm64';
  readonly dockerApi: { readonly actual: string };
  readonly toolchain: {
    readonly dockerCli: string;
    readonly dockerDaemon: string;
    readonly buildx: string;
    readonly compose: string;
  };
  readonly toolchainDigest: string;
}

/** Load a host-owned, immutable compatibility matrix through one no-follow descriptor. */
export function loadClientToolchainManifest(path: string): LoadedClientToolchainManifest {
  const loaded = loadImmutableHostJson(path, {
    label: 'client toolchain manifest',
    schema: clientToolchainManifestSchema,
    maxBytes: MAX_CLIENT_TOOLCHAIN_MANIFEST_BYTES,
  });
  return { path: loaded.path, sha256: loaded.sha256, manifest: loaded.value };
}

/**
 * Prove that the client inside the agent is connected to the intended daemon
 * and that every executable in the catalog toolchain tuple is exact.
 */
export async function preflightClientToolchain(options: {
  readonly runtime: Pick<ContainerRuntime, 'exec'>;
  readonly containerId: string;
  readonly manifest: LoadedClientToolchainManifest;
  readonly expectedToolchainDigest?: string;
}): Promise<ClientToolchainPreflight> {
  const dockerVersion = await execute(options.runtime, options.containerId, DOCKER_VERSION_PREFLIGHT_ARGV);
  let dockerJson: unknown;
  try {
    dockerJson = JSON.parse(dockerVersion) as unknown;
  } catch (error) {
    throw new Error('Docker client/daemon version probe returned invalid JSON', { cause: error });
  }
  const parsedDocker = dockerVersionOutputSchema.safeParse(dockerJson);
  if (!parsedDocker.success) {
    throw new Error(
      `Docker client/daemon version probe is incomplete: ${parsedDocker.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }

  const buildxOutput = await execute(options.runtime, options.containerId, DOCKER_BUILDX_VERSION_PREFLIGHT_ARGV);
  const buildxMatch = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u.exec(buildxOutput);
  if (buildxMatch?.[1] === undefined) throw new Error('Docker Buildx version probe returned an unknown format');
  const composeVersion = await execute(options.runtime, options.containerId, DOCKER_COMPOSE_VERSION_PREFLIGHT_ARGV);
  if (!versionSchema.safeParse(composeVersion).success) {
    throw new Error('Docker Compose version probe returned an unknown format');
  }

  const expected = options.manifest.manifest;
  const actual = parsedDocker.data;
  const mismatches: string[] = [];
  compareField(mismatches, 'architecture', actual.Client.Arch, expected.architecture);
  compareField(mismatches, 'daemon architecture', actual.Server.Arch, expected.architecture);
  compareField(mismatches, 'Docker CLI version', actual.Client.Version, expected.docker.cliVersion);
  compareField(mismatches, 'Docker daemon version', actual.Server.Version, expected.docker.daemonVersion);
  compareField(mismatches, 'Docker client API', actual.Client.ApiVersion, expected.docker.clientApiVersion);
  compareField(mismatches, 'Docker daemon API', actual.Server.ApiVersion, expected.docker.daemonApiVersion);
  compareField(
    mismatches,
    'Docker minimum daemon API',
    actual.Server.MinAPIVersion,
    expected.docker.minimumDaemonApiVersion,
  );
  compareField(mismatches, 'Docker Buildx version', buildxMatch[1], expected.buildxVersion);
  compareField(mismatches, 'Docker Compose version', composeVersion, expected.composeVersion);
  if (mismatches.length !== 0) throw new Error(`Docker client toolchain mismatch: ${mismatches.join('; ')}`);

  const toolchain = {
    dockerCli: actual.Client.Version,
    dockerDaemon: actual.Server.Version,
    buildx: buildxMatch[1],
    compose: composeVersion,
  };
  const toolchainDigest = computeHash(toolchain);
  if (options.expectedToolchainDigest !== undefined && toolchainDigest !== options.expectedToolchainDigest) {
    throw new Error('Docker client toolchain digest differs from the preloaded catalog');
  }
  return {
    architecture: expected.architecture,
    dockerApi: {
      actual: actual.Server.ApiVersion,
    },
    toolchain,
    toolchainDigest,
  };
}

async function execute(
  runtime: Pick<ContainerRuntime, 'exec'>,
  containerId: string,
  command: readonly string[],
): Promise<string> {
  const result = await runtime.exec(containerId, command, 15_000);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(-2048) || result.stdout.trim().slice(-2048) || 'no diagnostic output';
    throw new Error(`Docker client toolchain probe failed for ${command.slice(0, 3).join(' ')}: ${detail}`);
  }
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error(`Docker client toolchain probe returned no output: ${command.join(' ')}`);
  return output;
}

function compareField(mismatches: string[], label: string, actual: string, expected: string): void {
  if (actual !== expected) mismatches.push(`${label} expected ${expected}, got ${actual}`);
}

function apiVersionInRange(value: string, minimum: string, maximum: string): boolean {
  return compareDockerApiVersions(value, minimum) >= 0 && compareDockerApiVersions(value, maximum) <= 0;
}
