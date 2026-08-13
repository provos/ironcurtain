/** Durable host-only lease for one secure nested Docker authority bundle. */

import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { sha256HexSchema as sha256Schema, stableStringify } from '../hash.js';
import { assertCanonicalHostPath, writeStableJsonAtomic } from '../hardened-fs.js';
import {
  lifecycleIdentifierSchema as identifierSchema,
  dockerWorkloadCleanupProofSchema as cleanupSchema,
  resourceNameSchema,
  runtimeIdentitySchema,
  timestampSchema,
} from '../zod-helpers.js';
import { acquireProcessLock, ProcessLockBusyError } from './process-lock.js';

export const DOCKER_WORKLOAD_LEASE_SCHEMA_VERSION = 1;
export const MAX_DOCKER_WORKLOAD_LEASE_BYTES = 1024 * 1024;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && resolve(value) === value, {
    message: 'lease path must be canonical and absolute',
  });
const labelKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u);

/**
 * Bounds for the separation between the two cleanup inventories. The lease owns
 * this rule: it stores the value, enforces it on close, and exports both halves
 * so downstream readers (lifecycle evidence) never restate the numbers.
 */
export const cleanupInventoryGapMsSchema = z.number().int().min(100).max(60_000);

const outerResourceSchema = z
  .object({
    requestId: identifierSchema,
    kind: z.enum(['container', 'network']),
    role: identifierSchema,
    requestedName: resourceNameSchema,
    ownershipLabelKey: labelKeySchema,
    ownershipLabelValue: identifierSchema,
    requestedAt: timestampSchema,
    observedId: runtimeIdentitySchema.nullable(),
    observedAt: timestampSchema.nullable(),
    removal: z
      .object({
        proof: z.enum(['immutable-id-absent', 'requested-name-absent']),
        identity: runtimeIdentitySchema,
        capturedAt: timestampSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((resource, context) => {
    if ((resource.observedId === null) !== (resource.observedAt === null)) {
      context.addIssue({ code: 'custom', message: 'resource observation ID/time must be recorded together' });
    }
    if (resource.removal?.proof === 'immutable-id-absent' && resource.removal.identity !== resource.observedId) {
      context.addIssue({ code: 'custom', message: 'resource immutable-ID removal proof does not match observation' });
    }
    if (resource.removal?.proof === 'requested-name-absent' && resource.removal.identity !== resource.requestedName) {
      context.addIssue({ code: 'custom', message: 'resource requested-name removal proof does not match request' });
    }
    if (resource.observedId !== null && resource.removal?.proof === 'requested-name-absent') {
      context.addIssue({ code: 'custom', message: 'observed resource requires immutable-ID removal proof' });
    }
    if (resource.observedId === null && resource.removal?.proof === 'immutable-id-absent') {
      context.addIssue({ code: 'custom', message: 'unobserved resource cannot use immutable-ID removal proof' });
    }
  });

const leaseSchema = z
  .object({
    schemaVersion: z.literal(DOCKER_WORKLOAD_LEASE_SCHEMA_VERSION),
    leaseId: identifierSchema,
    bundleId: identifierSchema,
    generation: identifierSchema,
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(['admitting', 'active', 'revoking', 'closed', 'incident']),
    runtimeKind: z.enum(['docker', 'apple-container']),
    paths: z
      .object({
        workspaceRoot: absolutePathSchema,
        stateRoot: absolutePathSchema,
        runtimeRoot: absolutePathSchema,
        apiRoot: absolutePathSchema,
        exchangeRoot: absolutePathSchema,
        stagingRoot: absolutePathSchema,
      })
      .strict(),
    bindings: z
      .object({
        catalogSha256: sha256Schema,
        innerDockerCatalogSha256: sha256Schema,
        profileSha256: sha256Schema,
        watchdogPolicySha256: sha256Schema,
        toolchainDigest: sha256Schema,
      })
      .strict(),
    coordinator: z
      .object({
        pid: z.number().int().positive(),
        startedAt: timestampSchema,
        heartbeatAt: timestampSchema,
      })
      .strict(),
    cleanupInventoryGapMs: cleanupInventoryGapMsSchema,
    resources: z.array(outerResourceSchema).max(64),
    cleanup: cleanupSchema.nullable(),
    incident: z
      .object({ code: identifierSchema, detail: z.string().min(1).max(4096), recordedAt: timestampSchema })
      .strict()
      .nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((lease, context) => {
    const requestIds = lease.resources.map((resource) => resource.requestId);
    const requestedNames = lease.resources.map((resource) => `${resource.kind}:${resource.requestedName}`);
    if (new Set(requestIds).size !== requestIds.length) {
      context.addIssue({ code: 'custom', message: 'duplicate outer-resource request ID' });
    }
    if (new Set(requestedNames).size !== requestedNames.length) {
      context.addIssue({ code: 'custom', message: 'duplicate outer-resource requested name' });
    }
    if (lease.resources.some((resource) => resource.ownershipLabelValue !== lease.generation)) {
      context.addIssue({ code: 'custom', message: 'outer-resource ownership label must equal lease generation' });
    }
    const hostOnlyPaths = [
      lease.paths.stateRoot,
      lease.paths.runtimeRoot,
      lease.paths.apiRoot,
      lease.paths.exchangeRoot,
      lease.paths.stagingRoot,
    ];
    if (
      hostOnlyPaths.some(
        (path) => path === lease.paths.workspaceRoot || path.startsWith(`${lease.paths.workspaceRoot}/`),
      )
    ) {
      context.addIssue({ code: 'custom', message: 'host-only lease paths must not be inside the workspace' });
    }
    if (lease.status === 'closed' && lease.cleanup === null) {
      context.addIssue({ code: 'custom', message: 'closed lease requires cleanup proof' });
    }
    if (lease.status !== 'closed' && lease.cleanup !== null) {
      context.addIssue({ code: 'custom', message: 'cleanup proof is valid only for a closed lease' });
    }
    if (lease.status === 'incident' && lease.incident === null) {
      context.addIssue({ code: 'custom', message: 'incident lease requires an incident record' });
    }
    if (
      lease.incident !== null &&
      lease.status !== 'incident' &&
      lease.status !== 'revoking' &&
      lease.status !== 'closed'
    ) {
      context.addIssue({ code: 'custom', message: 'incident history is invalid for this lease status' });
    }
  });

export type DockerWorkloadLease = z.infer<typeof leaseSchema>;
export type DockerWorkloadLeasePaths = DockerWorkloadLease['paths'];
export type DockerWorkloadLeaseBindings = DockerWorkloadLease['bindings'];
export type DockerWorkloadOuterResource = DockerWorkloadLease['resources'][number];
export type DockerWorkloadCleanupProof = z.infer<typeof cleanupSchema>;

/** Throw unless the two cleanup inventories are at least `gapMs` apart. */
export function assertCleanupInventoryGap(
  inventories: DockerWorkloadCleanupProof['inventories'],
  gapMs: number,
  label: string,
): void {
  const [first, second] = inventories;
  if (Date.parse(second.capturedAt) - Date.parse(first.capturedAt) < gapMs) {
    throw new Error(`${label} cleanup inventories are not sufficiently separated`);
  }
}

export interface CreateDockerWorkloadLeaseOptions {
  readonly leaseId: string;
  readonly bundleId: string;
  readonly generation: string;
  readonly runtimeKind: DockerWorkloadLease['runtimeKind'];
  readonly paths: DockerWorkloadLeasePaths;
  readonly bindings: DockerWorkloadLeaseBindings;
  readonly cleanupInventoryGapMs: number;
  readonly coordinatorPid?: number;
  readonly now?: Date;
}

export interface RequestOuterResourceOptions {
  readonly requestId: string;
  readonly kind: DockerWorkloadOuterResource['kind'];
  readonly role: string;
  readonly requestedName: string;
  readonly ownershipLabelKey: string;
}

export function createDockerWorkloadLease(
  path: string,
  options: CreateDockerWorkloadLeaseOptions,
): DockerWorkloadLease {
  assertCanonicalLeasePath(path);
  const now = (options.now ?? new Date()).toISOString();
  const lease = leaseSchema.parse({
    schemaVersion: DOCKER_WORKLOAD_LEASE_SCHEMA_VERSION,
    leaseId: options.leaseId,
    bundleId: options.bundleId,
    generation: options.generation,
    sequence: 0,
    status: 'admitting',
    runtimeKind: options.runtimeKind,
    paths: options.paths,
    bindings: options.bindings,
    coordinator: {
      pid: options.coordinatorPid ?? process.pid,
      startedAt: now,
      heartbeatAt: now,
    },
    cleanupInventoryGapMs: options.cleanupInventoryGapMs,
    resources: [],
    cleanup: null,
    incident: null,
    createdAt: now,
    updatedAt: now,
  });
  return withLeaseLock(path, () => {
    if (pathExistsWithoutFollowing(path)) throw new Error(`Docker-workload lease already exists: ${path}`);
    writeLeaseAtomic(path, lease);
    return lease;
  });
}

export function loadDockerWorkloadLease(path: string): DockerWorkloadLease {
  assertCanonicalLeasePath(path);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`Docker-workload lease must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('Docker-workload lease must be a regular file');
    if ((stats.mode & 0o077) !== 0) throw new Error('Docker-workload lease must be owner-only');
    if (stats.size < 2 || stats.size > MAX_DOCKER_WORKLOAD_LEASE_BYTES) {
      throw new Error(`Docker-workload lease size is outside the allowed range: ${stats.size}`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Docker-workload lease is not valid JSON', { cause: error });
  }
  const validated = leaseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Docker-workload lease is invalid: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  const canonical = `${stableStringify(validated.data)}\n`;
  if (!bytes.equals(Buffer.from(canonical))) throw new Error('Docker-workload lease is not canonical JSON');
  return validated.data;
}

export function requestDockerWorkloadOuterResource(
  path: string,
  generation: string,
  request: RequestOuterResourceOptions,
  now = new Date(),
): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'admitting') throw new Error('outer resources may be requested only during admission');
    lease.resources.push({
      ...request,
      ownershipLabelValue: lease.generation,
      requestedAt: now.toISOString(),
      observedId: null,
      observedAt: null,
      removal: null,
    });
  });
}

export function observeDockerWorkloadOuterResource(
  path: string,
  generation: string,
  requestId: string,
  immutableId: string,
  now = new Date(),
): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'admitting' && lease.status !== 'revoking') {
      throw new Error('outer resources may be observed only during admission or crash reconciliation');
    }
    const resource = requiredResource(lease, requestId);
    if (resource.observedId !== null) throw new Error(`outer resource was already observed: ${requestId}`);
    resource.observedId = immutableId;
    resource.observedAt = now.toISOString();
  });
}

export function activateDockerWorkloadLease(path: string, generation: string, now = new Date()): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'admitting') throw new Error('only an admitting Docker-workload lease may become active');
    if (lease.resources.length === 0 || lease.resources.some((resource) => resource.observedId === null)) {
      throw new Error('Docker-workload lease cannot activate before every requested outer resource is observed');
    }
    lease.status = 'active';
  });
}

export function heartbeatDockerWorkloadLease(path: string, generation: string, now = new Date()): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'admitting' && lease.status !== 'active') {
      throw new Error(`cannot heartbeat Docker-workload lease in state ${lease.status}`);
    }
    lease.coordinator.heartbeatAt = now.toISOString();
  });
}

export function revokeDockerWorkloadLease(path: string, generation: string, now = new Date()): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'admitting' && lease.status !== 'active') {
      throw new Error(`Docker-workload lease cannot enter revocation from ${lease.status}`);
    }
    lease.status = 'revoking';
  });
}

/** Begin an exact recovery attempt without discarding the original incident evidence. */
export function recoverDockerWorkloadLeaseIncident(
  path: string,
  generation: string,
  now = new Date(),
): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'incident' || lease.incident === null) {
      throw new Error('only an incident Docker-workload lease may begin recovery');
    }
    lease.status = 'revoking';
  });
}

export function recordDockerWorkloadOuterResourceRemoval(
  path: string,
  generation: string,
  requestId: string,
  proof: { readonly kind: 'immutable-id-absent' | 'requested-name-absent'; readonly identity: string },
  now = new Date(),
): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'revoking') throw new Error('outer-resource removal proof requires a revoking lease');
    const resource = requiredResource(lease, requestId);
    if (resource.removal !== null) throw new Error(`outer-resource removal was already recorded: ${requestId}`);
    if (resource.observedId === null) {
      if (proof.kind !== 'requested-name-absent' || proof.identity !== resource.requestedName) {
        throw new Error('unobserved outer resource requires exact requested-name absence proof');
      }
    } else if (proof.kind !== 'immutable-id-absent' || proof.identity !== resource.observedId) {
      throw new Error('observed outer resource requires exact immutable-ID absence proof');
    }
    resource.removal = { proof: proof.kind, identity: proof.identity, capturedAt: now.toISOString() };
  });
}

export function closeDockerWorkloadLease(
  path: string,
  generation: string,
  proof: DockerWorkloadCleanupProof,
  now = new Date(),
): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'revoking') throw new Error('only a revoking Docker-workload lease may close');
    if (lease.resources.some((resource) => resource.removal === null)) {
      throw new Error('Docker-workload lease cannot close before every outer resource has absence proof');
    }
    const validatedProof = cleanupSchema.parse(proof);
    const [first, second] = validatedProof.inventories;
    if (first.ownedResourceIds.length !== 0 || second.ownedResourceIds.length !== 0) {
      throw new Error('Docker-workload lease cleanup inventories must both be empty');
    }
    assertCleanupInventoryGap(validatedProof.inventories, lease.cleanupInventoryGapMs, 'Docker-workload lease');
    lease.status = 'closed';
    lease.cleanup = validatedProof;
  });
}

export function recordDockerWorkloadLeaseIncident(
  path: string,
  generation: string,
  incident: { readonly code: string; readonly detail: string },
  now = new Date(),
): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status === 'closed') throw new Error('cannot record incident for closed Docker-workload lease');
    if (lease.incident !== null) throw new Error('Docker-workload lease already has incident history');
    lease.status = 'incident';
    lease.incident = { ...incident, recordedAt: now.toISOString() };
  });
}

/** Return a failed recovery to incident without replacing its original evidence. */
export function returnDockerWorkloadLeaseRecoveryToIncident(
  path: string,
  generation: string,
  now = new Date(),
): DockerWorkloadLease {
  return updateLease(path, generation, now, (lease) => {
    if (lease.status !== 'revoking' || lease.incident === null) {
      throw new Error('only a recovering Docker-workload lease may return to incident');
    }
    lease.status = 'incident';
  });
}

function updateLease(
  path: string,
  generation: string,
  now: Date,
  mutate: (lease: DockerWorkloadLease) => void,
): DockerWorkloadLease {
  assertCanonicalLeasePath(path);
  return withLeaseLock(path, () => {
    const current = loadDockerWorkloadLease(path);
    if (current.generation !== generation) throw new Error('Docker-workload lease generation mismatch');
    const next = structuredClone(current);
    mutate(next);
    next.sequence += 1;
    next.updatedAt = now.toISOString();
    const validated = leaseSchema.parse(next);
    writeLeaseAtomic(path, validated);
    return validated;
  });
}

function requiredResource(lease: DockerWorkloadLease, requestId: string): DockerWorkloadOuterResource {
  const resource = lease.resources.find((candidate) => candidate.requestId === requestId);
  if (resource === undefined) throw new Error(`unknown outer-resource request: ${requestId}`);
  return resource;
}

function writeLeaseAtomic(path: string, lease: DockerWorkloadLease): void {
  writeStableJsonAtomic(path, lease, { mode: 0o600 });
}

function withLeaseLock<T>(path: string, operation: () => T): T {
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = acquireProcessLock(lockPath, { attempts: 2 });
  } catch (error) {
    if (error instanceof ProcessLockBusyError) {
      const owner = error.ownerPid === undefined ? '' : ` (owner pid ${error.ownerPid})`;
      throw new Error(`Docker-workload lease is busy${owner}`, { cause: error });
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    lock.release();
  }
}

function assertCanonicalLeasePath(path: string): void {
  assertCanonicalHostPath(path, 'Docker-workload lease path');
  const parent = statSync(dirname(path));
  if (!parent.isDirectory()) throw new Error('Docker-workload lease parent must be a directory');
  if ((parent.mode & 0o077) !== 0) throw new Error('Docker-workload lease parent must be owner-only');
}

function pathExistsWithoutFollowing(path: string): boolean {
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    closeSync(descriptor);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}
