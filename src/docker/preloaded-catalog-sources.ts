/**
 * Declarative image-source manifest for the preloaded catalog.
 *
 * One entry per required role names the Dockerfile, build context, and frozen
 * metadata the freeze command needs to build, tag, and stage each image. It is
 * the single source of truth mapping catalog roles to on-disk build inputs.
 *
 * Under the two-class image split (plan §6.4) the catalog governs only the
 * trusted infrastructure class: base, the per-harness agents, and the fixed
 * nested-runtime support images (nested-daemon/helper/fixed-relay/socat), all
 * built from purpose-built images under `docker/`. Untrusted workload images
 * and the pinned target/patched-target/scanner qualification fixtures are NOT
 * catalog roles — the fixtures are owned by the qualification harness (see
 * `test/docker-workload/fixtures/vulnerability-fixture/image-sources.ts`).
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { arch } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_BUILD_HASH_SCHEMA, type PreloadedImageCatalogEntry } from './preloaded-image-catalog.js';
import { REQUIRED_PRELOADED_IMAGE_ROLES, type PreloadedImageRole } from './preloaded-catalog-builder.js';

type Toolchain = PreloadedImageCatalogEntry['toolchain'];

/**
 * Docker API compatibility range recorded for every catalog image. Mirrors the
 * committed `config/docker-workload/client-toolchain.arm64.json` range.
 */
export const CATALOG_DOCKER_API_RANGE = { min: '1.44', max: '1.53' } as const;

// Pinned toolchain versions (see the committed client-toolchain record). Images
// that carry dockerd declare `DAEMON_TOOLCHAIN`; pure-runtime images carry no
// Docker toolchain at all.
//
// Under the same-VM daemon topology (plan §16.10) the base image stages the full
// daemon toolchain and every agent image inherits it via `FROM ironcurtain-base`,
// so those roles declare `DAEMON_TOOLCHAIN` too. A client-only tuple — the shape
// plan §9.2 describes for an agent layer beside a sibling daemon — has no role
// while Apple is the only qualified backend, so it is not carried here as dead
// configuration; reintroduce it with the backend that needs it.
const DAEMON_TOOLCHAIN: Toolchain = { dockerCli: '29.2.1', dockerDaemon: '29.2.1', buildx: '0.31.1', compose: '5.1.0' };
const NO_TOOLCHAIN: Toolchain = { dockerCli: null, dockerDaemon: null, buildx: null, compose: null };

/** How a role's build hash is derived. Agent roles must match the live build. */
export type BuildHashKind = 'agent' | 'content';

export interface CatalogImageSource {
  readonly role: PreloadedImageRole;
  /** Runtime ref; for agent roles this is exactly `adapter.getImage()`. */
  readonly logicalName: string;
  /** Absolute Dockerfile path. */
  readonly dockerfile: string;
  /** Absolute build-context directory (COPY sources must live inside it). */
  readonly contextDir: string;
  readonly toolchain: Toolchain;
  readonly hashKind: BuildHashKind;
  /** Repository-relative Dockerfile path, recorded as image provenance. */
  readonly provenanceSource: string;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** amd64/arm64 for the host running the freeze, matching the catalog schema. */
export function hostCatalogArchitecture(): 'amd64' | 'arm64' {
  const value = arch();
  if (value === 'x64') return 'amd64';
  if (value === 'arm64') return 'arm64';
  throw new Error(`unsupported host architecture for preloaded catalog: ${value}`);
}

/** Base Dockerfile selected the same way the live agent build selects it. */
function baseDockerfileName(dockerDir: string): string {
  return arch() === 'arm64' && existsAt(dockerDir, 'Dockerfile.base.arm64')
    ? 'Dockerfile.base.arm64'
    : 'Dockerfile.base';
}

function existsAt(dir: string, name: string): boolean {
  return readdirSync(dir).includes(name);
}

/** All eight infrastructure role sources, resolved to absolute paths for the current host. */
export function catalogImageSources(): readonly CatalogImageSource[] {
  const root = packageRoot();
  const dockerDir = resolve(root, 'docker');
  const workloadDir = resolve(dockerDir, 'docker-workload');
  const baseDockerfile = baseDockerfileName(dockerDir);

  const sources: readonly CatalogImageSource[] = [
    // The base image copies the pinned toolchain stage's `/usr/local/bin` and
    // CLI plugins verbatim, so it ships the same client AND daemon binaries the
    // nested-daemon role does. The tuple feeds `toolchainDigest`, which
    // admission binds from this role and `preflightClientToolchain` recomputes
    // from the live client/daemon versions — a null tuple here is a binding
    // that can never match what the running image reports.
    agentless('base', 'ironcurtain-base:latest', join(dockerDir, baseDockerfile), dockerDir, DAEMON_TOOLCHAIN, root),
    agent(
      'agent-claude-code',
      'ironcurtain-claude-code:latest',
      join(dockerDir, 'Dockerfile.claude-code'),
      dockerDir,
      root,
    ),
    agent('agent-codex', 'ironcurtain-codex:latest', join(dockerDir, 'Dockerfile.codex'), dockerDir, root),
    agent('agent-goose', 'ironcurtain-goose:latest', join(dockerDir, 'Dockerfile.goose'), dockerDir, root),
    agentless(
      'nested-daemon',
      'ironcurtain-nested-daemon:latest',
      join(dockerDir, 'nested-daemon', 'Dockerfile'),
      join(dockerDir, 'nested-daemon'),
      DAEMON_TOOLCHAIN,
      root,
    ),
    agentless(
      'helper',
      'ironcurtain-helper:latest',
      join(workloadDir, 'helper', 'Dockerfile'),
      join(workloadDir, 'helper'),
      NO_TOOLCHAIN,
      root,
    ),
    agentless(
      'fixed-relay',
      'ironcurtain-fixed-relay:latest',
      join(dockerDir, 'nested-relay', 'Dockerfile'),
      join(dockerDir, 'nested-relay'),
      NO_TOOLCHAIN,
      root,
    ),
    agentless(
      'socat',
      'ironcurtain-socat:latest',
      join(workloadDir, 'socat', 'Dockerfile'),
      join(workloadDir, 'socat'),
      NO_TOOLCHAIN,
      root,
    ),
  ];

  assertRoleCoverage(sources);
  return sources;
}

function agent(
  role: PreloadedImageRole,
  logicalName: string,
  dockerfile: string,
  contextDir: string,
  root: string,
): CatalogImageSource {
  return {
    role,
    logicalName,
    dockerfile,
    contextDir,
    // Agent images are `FROM ironcurtain-base:latest`, so they inherit the base
    // image's staged daemon toolchain verbatim — and under the same-VM topology
    // the agent image is where the nested daemon actually runs.
    toolchain: DAEMON_TOOLCHAIN,
    hashKind: 'agent',
    provenanceSource: posixRelative(root, dockerfile),
  };
}

function agentless(
  role: PreloadedImageRole,
  logicalName: string,
  dockerfile: string,
  contextDir: string,
  toolchain: Toolchain,
  root: string,
): CatalogImageSource {
  return {
    role,
    logicalName,
    dockerfile,
    contextDir,
    toolchain,
    hashKind: 'content',
    provenanceSource: posixRelative(root, dockerfile),
  };
}

function assertRoleCoverage(sources: readonly CatalogImageSource[]): void {
  const roles = sources.map((source) => source.role);
  const missing = REQUIRED_PRELOADED_IMAGE_ROLES.filter((role) => !roles.includes(role));
  if (missing.length !== 0 || roles.length !== REQUIRED_PRELOADED_IMAGE_ROLES.length) {
    throw new Error(`catalog image sources do not cover every role: missing=${missing.join(',') || '(none)'}`);
  }
}

/**
 * Deterministic content hash for non-agent roles: the Dockerfile identity plus
 * every regular file in the build context. Self-consistent (the freeze command
 * stamps the same value into the image label and the catalog entry); no current
 * consumer cross-checks it against an independent function.
 */
export function computeContentBuildHash(dockerfilePath: string, contextDir: string): string {
  const hash = createHash('sha256');
  hash.update(`schema:${IMAGE_BUILD_HASH_SCHEMA}\n`);
  hash.update(`dockerfile:${basename(dockerfilePath)}\n`);
  for (const relativePath of listRegularFiles(contextDir)) {
    hash.update(`file:${relativePath}\n`);
    hash.update(readFileSync(join(contextDir, relativePath)));
  }
  return hash.digest('hex');
}

/** `sha256:<hex>` of the Dockerfile bytes, recorded as provenance sourceDigest. */
export function dockerfileSourceDigest(dockerfilePath: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(dockerfilePath)).digest('hex')}`;
}

function listRegularFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  walk(directory, '');
  return files;
}

function posixRelative(root: string, target: string): string {
  return target.slice(root.length).replace(/^\/+/u, '').split('\\').join('/');
}
