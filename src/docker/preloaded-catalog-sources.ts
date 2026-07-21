/**
 * Declarative image-source manifest for the preloaded catalog.
 *
 * One entry per required role names the Dockerfile, build context, and frozen
 * metadata the freeze command needs to build, tag, and stage each image. It is
 * the single source of truth mapping catalog roles to on-disk build inputs.
 *
 * The target/patched-target/scanner roles reuse the existing deterministic
 * vulnerability fixture (§7.3) rather than duplicating its Go sources; the
 * helper/socat/relay/daemon roles use the purpose-built images under `docker/`.
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

// Pinned toolchain versions (see the committed client-toolchain record). Client
// images carry the Docker CLI/Buildx/Compose; the daemon additionally carries
// dockerd; pure-runtime images carry no Docker toolchain.
const CLIENT_TOOLCHAIN: Toolchain = { dockerCli: '29.2.1', dockerDaemon: null, buildx: '0.31.1', compose: '5.1.0' };
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

/** All eleven role sources, resolved to absolute paths for the current host. */
export function catalogImageSources(): readonly CatalogImageSource[] {
  const root = packageRoot();
  const dockerDir = resolve(root, 'docker');
  const workloadDir = resolve(dockerDir, 'docker-workload');
  const fixtureDir = resolve(root, 'test', 'docker-workload', 'fixtures', 'vulnerability-fixture');
  const baseDockerfile = baseDockerfileName(dockerDir);

  const sources: readonly CatalogImageSource[] = [
    agentless('base', 'ironcurtain-base:latest', join(dockerDir, baseDockerfile), dockerDir, NO_TOOLCHAIN, root),
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
    agentless(
      'vulnerability-target',
      'ironcurtain-vulnerability-target:latest',
      join(fixtureDir, 'Dockerfile.target'),
      fixtureDir,
      NO_TOOLCHAIN,
      root,
    ),
    agentless(
      'patched-target',
      'ironcurtain-patched-target:latest',
      join(fixtureDir, 'Dockerfile.patched-target'),
      fixtureDir,
      NO_TOOLCHAIN,
      root,
    ),
    agentless(
      'vulnerability-scanner',
      'ironcurtain-vulnerability-scanner:latest',
      join(fixtureDir, 'Dockerfile.scanner'),
      fixtureDir,
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
    toolchain: CLIENT_TOOLCHAIN,
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
