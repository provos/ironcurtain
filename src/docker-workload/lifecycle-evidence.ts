/**
 * Audit sink and evidence writer for the secure nested Docker-workload
 * lifecycle. The audit sink records host-authoritative lifecycle events
 * (§8.4); `writeLifecycleEvidence` writes a small, self-describing record of
 * what actually happened during one run.
 *
 * The writer trusts its in-process callers and the host that chose the evidence
 * root: it schema-validates the summary, refuses to overwrite an existing
 * output leaf, and keeps the tree owner-only. It does not re-walk the ancestors
 * of a host-chosen directory, nor hand-inspect payloads that `JSON.stringify`
 * already rejects.
 */

import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { sha256HexSchema as sha256Schema } from '../hash.js';
import { assertCanonicalHostPath } from '../hardened-fs.js';
import {
  lifecycleIdentifierSchema as identifierSchema,
  ownedResourceInventorySchema as inventorySchema,
  resourceNameSchema,
  runtimeIdentitySchema,
  timestampSchema,
  watchdogSampleSummarySchema as sampleSchema,
} from '../zod-helpers.js';
import { PRIVATE_DOCKER_READINESS_TEXT_BOUNDS as READINESS_TEXT_BOUNDS } from './private-docker.js';
import {
  assertCleanupInventoryGap,
  cleanupInventoryGapMsSchema,
  outerResourceKindSchema,
  type DockerWorkloadCleanupProof,
} from './bundle-lease.js';

/**
 * Provenance marker for `daemon-ready`: the readiness values are attested by
 * the bundle's own in-VM daemon, never observed by the host.
 */
export const DAEMON_READY_ATTESTATION = 'bundle-local-advisory';

const leaseStatusSchema = z.enum(['admitting', 'active', 'revoking', 'closed', 'incident']);
const enforcementStatusSchema = z.enum(['enforced', 'observed', 'unsupported']);
const softwareVersionSchema = z.string().min(1).max(128);

const expandedCreateSchema = z
  .object({
    args: z.array(z.string()).max(4096).optional(),
    mounts: z
      .array(z.object({ source: z.string(), target: z.string(), readonly: z.boolean() }).strict())
      .max(256)
      .optional(),
    limits: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    profileRef: z.string().nullable().optional(),
  })
  .strict();

const baseEventShape = { at: timestampSchema, leaseId: identifierSchema, generation: identifierSchema };

const dockerWorkloadAuditEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...baseEventShape,
      kind: z.literal('admission-decision'),
      decision: z.enum(['admitting', 'blocked']),
      bundleId: identifierSchema,
      runtimeKind: z.enum(['docker', 'apple-container']),
      configHash: sha256Schema,
      watchdogPolicySha256: sha256Schema,
      watchdogTemplateSha256: sha256Schema,
      detail: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('outer-create'),
      requestId: identifierSchema,
      resourceKind: outerResourceKindSchema,
      role: z.string().min(1).max(128),
      requestedName: resourceNameSchema,
      immutableId: runtimeIdentitySchema,
      expanded: expandedCreateSchema,
    })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('watchdog-attested'),
      supervisorPid: z.number().int().positive(),
      policySha256: sha256Schema,
      templateSha256: sha256Schema,
      firstSample: sampleSchema,
    })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('daemon-ready'),
      // The adjudicated in-VM daemon configuration. Recorded verbatim so the
      // evidence trail shows WHICH configuration was admitted, not merely that
      // some daemon answered.
      //
      // Unlike `watchdog-attested` and `cleanup-proof`, which the host observes
      // directly, every value below is ATTESTED BY THE BUNDLE: the readiness
      // probe talks to a bundle-local UDS, and plan §4.2 accepts that an in-VM
      // party can answer it. The discriminator keeps that provenance on the
      // record itself so a reader can never mistake an advisory value for a
      // host observation.
      attestation: z.literal(DAEMON_READY_ATTESTATION),
      driver: z.string().min(1).max(READINESS_TEXT_BOUNDS.driverLength),
      securityOptions: z
        .array(z.string().min(1).max(READINESS_TEXT_BOUNDS.securityOptionLength))
        .max(READINESS_TEXT_BOUNDS.securityOptionCount),
      serverVersion: z.string().min(1).max(READINESS_TEXT_BOUNDS.serverVersionLength),
      readinessMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ ...baseEventShape, kind: z.literal('lease-transition'), from: leaseStatusSchema, to: leaseStatusSchema })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('private-docker-bootstrap'),
      attestation: z.literal(DAEMON_READY_ATTESTATION),
      toolchainDigest: sha256Schema,
      toolchain: z
        .object({
          dockerCli: softwareVersionSchema,
          dockerDaemon: softwareVersionSchema,
          buildx: softwareVersionSchema,
          compose: softwareVersionSchema,
        })
        .strict(),
      image: z.discriminatedUnion('transport', [
        z
          .object({
            transport: z.literal('apple-archive'),
            logicalName: z.string().min(1).max(255),
            buildHash: sha256Schema,
            archiveSha256: sha256Schema,
            outerImageId: runtimeIdentitySchema,
            innerImageId: runtimeIdentitySchema,
          })
          .strict(),
        z
          .object({
            transport: z.literal('docker-desktop-direct'),
            outerImageId: runtimeIdentitySchema,
          })
          .strict(),
      ]),
      network: z
        .object({
          name: resourceNameSchema,
          runtimeId: runtimeIdentitySchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('revocation-result'),
      removedResourceIds: z.array(runtimeIdentitySchema).max(4096),
      finalOwnedResourceIds: z.array(runtimeIdentitySchema).max(4096),
    })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('cleanup-proof'),
      inventories: z.tuple([inventorySchema, inventorySchema]),
    })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('incident'),
      code: identifierSchema,
      detail: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({
      ...baseEventShape,
      kind: z.literal('resource-enforcement'),
      declarations: z.record(z.string(), enforcementStatusSchema),
    })
    .strict(),
]);

export type DockerWorkloadAuditEvent = z.infer<typeof dockerWorkloadAuditEventSchema>;
export type ExpandedOuterCreate = z.infer<typeof expandedCreateSchema>;

/**
 * A lifecycle event without the common `at`/`leaseId`/`generation` envelope.
 * Distributes over the discriminated union so emitters can pass only the
 * event-specific fields and let one seam stamp the envelope.
 */
export type DockerWorkloadAuditEventPayload = DockerWorkloadAuditEvent extends infer E
  ? E extends DockerWorkloadAuditEvent
    ? Omit<E, 'at' | 'leaseId' | 'generation'>
    : never
  : never;

export interface DockerWorkloadAuditSink {
  emit(event: DockerWorkloadAuditEvent): void;
}

/**
 * Append-only JSONL sink following the existing `AuditLog` pattern: validate
 * fail-closed, create the parent directory, and `appendFileSync` one line per
 * event so a crash cannot drop a lifecycle record between flushes.
 */
export function createJsonlDockerWorkloadAuditSink(path: string): DockerWorkloadAuditSink {
  mkdirSync(dirname(path), { recursive: true });
  return {
    emit(event: DockerWorkloadAuditEvent): void {
      const validated = dockerWorkloadAuditEventSchema.parse(event);
      appendFileSync(path, `${JSON.stringify(validated)}\n`, 'utf8');
    },
  };
}

/** In-memory sink for tests and callers that assert on the event sequence. */
export function createRecordingDockerWorkloadAuditSink(): DockerWorkloadAuditSink & {
  readonly events: readonly DockerWorkloadAuditEvent[];
} {
  const events: DockerWorkloadAuditEvent[] = [];
  return {
    events,
    emit(event: DockerWorkloadAuditEvent): void {
      events.push(dockerWorkloadAuditEventSchema.parse(event));
    },
  };
}

export interface LifecycleEvidenceContents {
  readonly lease: unknown;
  readonly renderedPolicy: unknown;
  readonly supervisorStatusHistory: readonly unknown[];
  readonly revocation: unknown;
  readonly cleanup: DockerWorkloadCleanupProof;
}

export interface WriteLifecycleEvidenceOptions {
  readonly runId: string;
  readonly variant: string;
  readonly platform: 'docker-desktop' | 'apple-container' | 'linux-docker';
  readonly architecture: 'amd64' | 'arm64';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly contents: LifecycleEvidenceContents;
}

export interface LifecycleEvidenceSummary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly backend: string;
  readonly platform: WriteLifecycleEvidenceOptions['platform'];
  readonly architecture: WriteLifecycleEvidenceOptions['architecture'];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly files: readonly string[];
  readonly cleanup: DockerWorkloadCleanupProof;
}

const lifecycleEvidenceSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: identifierSchema,
    backend: identifierSchema,
    platform: z.enum(['docker-desktop', 'apple-container', 'linux-docker']),
    architecture: z.enum(['amd64', 'arm64']),
    startedAt: timestampSchema,
    completedAt: timestampSchema,
    files: z.array(z.string().min(1)).length(6),
    cleanup: z
      .object({
        exactOuterResourcesAbsent: z.literal(true),
        stateRootAbsent: z.literal(true),
        inventories: z.tuple([inventorySchema, inventorySchema]),
      })
      .strict(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (Date.parse(summary.completedAt) < Date.parse(summary.startedAt)) {
      context.addIssue({ code: 'custom', message: 'lifecycle evidence completion precedes start' });
    }
    const [firstInventory, secondInventory] = summary.cleanup.inventories;
    if (firstInventory.ownedResourceIds.length !== 0 || secondInventory.ownedResourceIds.length !== 0) {
      context.addIssue({ code: 'custom', message: 'lifecycle evidence requires two empty cleanup inventories' });
    }
    if (Date.parse(secondInventory.capturedAt) < Date.parse(firstInventory.capturedAt)) {
      context.addIssue({ code: 'custom', message: 'lifecycle evidence cleanup inventories are out of order' });
    }
  });

/** The gap rule is owned by the lease; the writer only re-reads the recorded value. */
const evidenceLeaseSchema = z.object({ cleanupInventoryGapMs: cleanupInventoryGapMsSchema }).loose();

/**
 * Write the collected lifecycle artifacts into an owner-only evidence directory
 * together with a readable JSON summary. Evidence writing is opt-in — callers
 * only invoke it when an evidence root is supplied. There is deliberately no
 * commit binding, qualification-contract hash, or exact-set hash manifest: the
 * summary records the run that happened and its authoritative cleanup proof.
 */
export function writeLifecycleEvidence(
  evidenceDir: string,
  options: WriteLifecycleEvidenceOptions,
): LifecycleEvidenceSummary {
  const files = [
    'lease.json',
    'policy.json',
    'supervisor-status-history.json',
    'revocation-result.json',
    'cleanup/inventory-1.json',
    'cleanup/inventory-2.json',
  ] as const;
  const lease = evidenceLeaseSchema.parse(options.contents.lease);
  const summary = lifecycleEvidenceSummarySchema.parse({
    schemaVersion: 1,
    runId: options.runId,
    backend: options.variant,
    platform: options.platform,
    architecture: options.architecture,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    files,
    cleanup: options.contents.cleanup,
  });
  const [firstInventory, secondInventory] = summary.cleanup.inventories;
  assertCleanupInventoryGap(summary.cleanup.inventories, lease.cleanupInventoryGapMs, 'lifecycle evidence');

  // Serialize every payload before touching the filesystem so an unserializable
  // input cannot leave a persuasive-looking partial evidence set behind.
  const serialized = new Map<string, string>([
    ['lease.json', serializeEvidenceJson(options.contents.lease, 'lifecycle evidence lease')],
    ['policy.json', serializeEvidenceJson(options.contents.renderedPolicy, 'lifecycle evidence policy')],
    [
      'supervisor-status-history.json',
      serializeEvidenceJson(options.contents.supervisorStatusHistory, 'lifecycle evidence supervisor history'),
    ],
    ['revocation-result.json', serializeEvidenceJson(options.contents.revocation, 'lifecycle evidence revocation')],
    ['cleanup/inventory-1.json', serializeEvidenceJson(firstInventory, 'lifecycle evidence first inventory')],
    ['cleanup/inventory-2.json', serializeEvidenceJson(secondInventory, 'lifecycle evidence second inventory')],
    ['summary.json', serializeEvidenceJson(summary, 'lifecycle evidence summary')],
  ]);

  assertCanonicalHostPath(evidenceDir, 'lifecycle evidence root');
  const cleanupDir = join(evidenceDir, 'cleanup');
  for (const relativePath of serialized.keys()) {
    assertPathAbsent(join(evidenceDir, relativePath), `lifecycle evidence output already exists: ${relativePath}`);
  }
  createOrValidatePrivateDirectory(evidenceDir, 'lifecycle evidence root');
  createOrValidatePrivateDirectory(cleanupDir, 'lifecycle evidence cleanup root');
  for (const [relativePath, json] of serialized) writePrivateJsonFile(join(evidenceDir, relativePath), json);
  return summary;
}

function writePrivateJsonFile(path: string, json: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, json, 'utf8');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * `JSON.stringify` already throws on the inputs that would corrupt an evidence
 * file (cycles, bigint). The one case it does not throw on is a top-level value
 * it cannot represent — it returns `undefined`, which would write the literal
 * text `undefined` into the file — so that single case is guarded here.
 */
function serializeEvidenceJson(value: unknown, label: string): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`${label} is not JSON-serializable`);
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createOrValidatePrivateDirectory(path: string, label: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error(`${label} must be a real canonical directory`);
    }
    const uid = currentUid();
    if (uid !== undefined && stats.uid !== uid) throw new Error(`${label} must be owned by the current user`);
    if ((stats.mode & 0o777) !== 0o700) throw new Error(`${label} must be owner-only`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const created = lstatSync(path);
  if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const uid = currentUid();
  if (uid !== undefined && created.uid !== uid) throw new Error(`${label} must be owned by the current user`);
  if ((created.mode & 0o777) !== 0o700) throw new Error(`${label} must be owner-only`);
}

function assertPathAbsent(path: string, message: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}
