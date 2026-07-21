/**
 * Audit sink and evidence sealing for the secure nested Docker-workload
 * lifecycle. The audit sink records host-authoritative lifecycle events
 * (§8.4); `sealLifecycleEvidence` collects the frozen lifecycle artifacts and
 * seals them through the unchanged canonical qualification-evidence manifest.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
  writeQualificationEvidenceManifest,
  type LoadedQualificationEvidenceManifest,
  type QualificationEvidenceBindings,
  type QualificationEvidenceManifest,
} from './qualification-evidence.js';
import type { DockerWorkloadCleanupProof } from './bundle-lease.js';

const timestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const runtimeIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u);
const resourceNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);

const sampleSchema = z
  .object({
    sampledAtMs: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative(),
    allocatedBytes: z.number().int().nonnegative(),
  })
  .strict();

const inventorySchema = z
  .object({ capturedAt: timestampSchema, ownedResourceIds: z.array(runtimeIdentitySchema).max(4096) })
  .strict();

const leaseStatusSchema = z.enum(['admitting', 'active', 'revoking', 'closed', 'incident']);
const enforcementStatusSchema = z.enum(['enforced', 'observed', 'unsupported']);

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
      resourceKind: z.enum(['container', 'network']),
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
    .object({ ...baseEventShape, kind: z.literal('lease-transition'), from: leaseStatusSchema, to: leaseStatusSchema })
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

export interface SealLifecycleEvidenceOptions {
  readonly runId: string;
  readonly variant: string;
  readonly platform: QualificationEvidenceManifest['platform'];
  readonly architecture: QualificationEvidenceManifest['architecture'];
  readonly startedAt: string;
  readonly completedAt: string;
  readonly bindings: QualificationEvidenceBindings;
  readonly contents: LifecycleEvidenceContents;
}

/**
 * Write the collected lifecycle artifacts into an owner-only evidence directory
 * and seal them via the canonical qualification-evidence manifest. Sealing is
 * opt-in — callers only invoke it when an evidence root is supplied. The
 * schema is used unchanged; the two required empty inventories are derived from
 * the cleanup proof.
 */
export function sealLifecycleEvidence(
  evidenceDir: string,
  options: SealLifecycleEvidenceOptions,
): LoadedQualificationEvidenceManifest {
  const [firstInventory, secondInventory] = options.contents.cleanup.inventories;
  if (firstInventory.ownedResourceIds.length !== 0 || secondInventory.ownedResourceIds.length !== 0) {
    throw new Error('lifecycle evidence requires two empty cleanup inventories');
  }
  writePrivateJsonFile(join(evidenceDir, 'lease.json'), options.contents.lease);
  writePrivateJsonFile(join(evidenceDir, 'policy.json'), options.contents.renderedPolicy);
  writePrivateJsonFile(join(evidenceDir, 'supervisor-status-history.json'), options.contents.supervisorStatusHistory);
  writePrivateJsonFile(join(evidenceDir, 'revocation-result.json'), options.contents.revocation);
  mkdirSync(join(evidenceDir, 'cleanup'), { recursive: true, mode: 0o700 });
  writePrivateJsonFile(join(evidenceDir, 'cleanup', 'inventory-1.json'), inventoryEvidence(options, 1, firstInventory));
  writePrivateJsonFile(
    join(evidenceDir, 'cleanup', 'inventory-2.json'),
    inventoryEvidence(options, 2, secondInventory),
  );

  return writeQualificationEvidenceManifest(evidenceDir, {
    runId: options.runId,
    variant: options.variant,
    platform: options.platform,
    architecture: options.architecture,
    bindings: options.bindings,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    files: [
      { id: 'lifecycle-lease', path: 'lease.json' },
      { id: 'lifecycle-rendered-policy', path: 'policy.json' },
      { id: 'lifecycle-supervisor-status-history', path: 'supervisor-status-history.json' },
      { id: 'lifecycle-revocation-result', path: 'revocation-result.json' },
      { id: 'lifecycle-cleanup-inventory-1', path: 'cleanup/inventory-1.json' },
      { id: 'lifecycle-cleanup-inventory-2', path: 'cleanup/inventory-2.json' },
    ],
  });
}

function inventoryEvidence(
  options: SealLifecycleEvidenceOptions,
  ordinal: 1 | 2,
  inventory: { readonly capturedAt: string },
): unknown {
  return {
    schemaVersion: QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
    runId: options.runId,
    variant: options.variant,
    ordinal,
    observedAt: inventory.capturedAt,
    resources: [],
  };
}

function writePrivateJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
  chmodSync(path, 0o600);
}
