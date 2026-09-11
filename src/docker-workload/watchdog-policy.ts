/**
 * Frozen watchdog-policy template plus per-session renderer.
 *
 * The checked-in template (`config/docker-workload/resource-watchdog-policy.json`)
 * freezes every measurement threshold and state class but deliberately omits the
 * per-session `targetRoot`/`targetDevice`/`targetInode`. `renderWatchdogPolicy`
 * stamps those from the concrete state root and writes the immutable
 * policy snapshot copied into the lease. The supervisor compares full validated
 * values, then samples its private in-memory copy for the generation's lifetime.
 */

import { lstatSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { assertCanonicalHostPath, loadImmutableHostJson, writeStableJsonAtomic } from '../hardened-fs.js';
import { identifierSchema } from '../zod-helpers.js';
import {
  loadResourceWatchdogPolicy,
  RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION,
  type LoadedResourceWatchdogPolicy,
} from '../docker/resource-watchdog.js';
import type { DockerWorkloadLease } from './bundle-lease.js';

export const WATCHDOG_POLICY_TEMPLATE_SCHEMA_VERSION = 1;
export const MAX_WATCHDOG_POLICY_TEMPLATE_BYTES = 256 * 1024;

/**
 * Frozen coordinator-side lifecycle constants (heartbeat, staleness, and crash
 * recovery bound). Kept beside the watchdog policy so every frozen timing value
 * for the Docker-workload lifecycle lives in one auditable place; the bundle
 * cannot mount or mutate them.
 */
export const DOCKER_WORKLOAD_HEARTBEAT_INTERVAL_MS = 5_000;
export const DOCKER_WORKLOAD_STALE_HEARTBEAT_MS = 30_000;
export const DOCKER_WORKLOAD_RECOVERY_BOUND_MS = 120_000;
export const DOCKER_WORKLOAD_WATCHDOG_STARTUP_TIMEOUT_MS = 30_000;

const positiveBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const templateStateClassSchema = z
  .object({
    id: identifierSchema,
    relativePath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => !value.startsWith('/') && posix.normalize(value) === value && !value.split('/').includes('..'),
        { message: 'state class path must be canonical and relative' },
      ),
    kind: z.enum(['file', 'directory']),
    required: z.boolean(),
  })
  .strict();

const watchdogPolicyTemplateSchema = z
  .object({
    schemaVersion: z.literal(WATCHDOG_POLICY_TEMPLATE_SCHEMA_VERSION),
    policyId: identifierSchema,
    stateClasses: z.array(templateStateClassSchema).min(1).max(128),
    sampleIntervalMs: z.number().int().min(100).max(60_000),
    sampleTimeoutMs: z.number().int().min(100).max(60_000),
    staleAfterMs: z
      .number()
      .int()
      .min(200)
      .max(5 * 60_000),
    softEvidenceBytes: positiveBytes,
    hardSafetyBytes: positiveBytes,
    hostReserveBytes: positiveBytes,
    maximumOvershootBytes: positiveBytes,
    cleanupInventoryGapMs: z.number().int().min(100).max(60_000),
  })
  .strict()
  .superRefine((template, context) => {
    if (template.softEvidenceBytes >= template.hardSafetyBytes) {
      context.addIssue({ code: 'custom', message: 'watchdog soft threshold must be below hard threshold' });
    }
    if (template.sampleTimeoutMs >= template.staleAfterMs || template.staleAfterMs < template.sampleIntervalMs * 2) {
      context.addIssue({ code: 'custom', message: 'watchdog stale threshold must exceed timeout and two intervals' });
    }
    const ids = template.stateClasses.map((stateClass) => stateClass.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'duplicate watchdog state class ID' });
    }
    const paths = template.stateClasses.map((stateClass) => stateClass.relativePath);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({ code: 'custom', message: 'duplicate watchdog state class path' });
    }
  });

export type WatchdogPolicyTemplate = z.infer<typeof watchdogPolicyTemplateSchema>;

/** Read and validate the bounded frozen template through one no-follow descriptor. */
export function loadFrozenWatchdogPolicyTemplate(path: string): WatchdogPolicyTemplate {
  return loadImmutableHostJson(path, {
    label: 'watchdog policy template',
    schema: watchdogPolicyTemplateSchema,
    maxBytes: MAX_WATCHDOG_POLICY_TEMPLATE_BYTES,
  }).value;
}

/**
 * Stamp the concrete state root's device/inode onto the frozen template, write
 * immutable per-session policy `0o400`. The lease owns a complete snapshot;
 * this launch input must compare equal. The state root must already exist.
 */
export function renderWatchdogPolicy(
  template: WatchdogPolicyTemplate,
  stateRoot: string,
  outputPath: string,
): LoadedResourceWatchdogPolicy {
  assertCanonicalHostPath(stateRoot, 'watchdog policy state root');
  assertCanonicalHostPath(outputPath, 'watchdog policy output path');
  const stats = lstatSync(stateRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('watchdog policy state root must be a real directory');
  }
  const rendered = {
    schemaVersion: RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION,
    policyId: template.policyId,
    targetRoot: stateRoot,
    targetDevice: stats.dev,
    targetInode: stats.ino,
    stateClasses: template.stateClasses,
    sampleIntervalMs: template.sampleIntervalMs,
    sampleTimeoutMs: template.sampleTimeoutMs,
    staleAfterMs: template.staleAfterMs,
    softEvidenceBytes: template.softEvidenceBytes,
    hardSafetyBytes: template.hardSafetyBytes,
    hostReserveBytes: template.hostReserveBytes,
    maximumOvershootBytes: template.maximumOvershootBytes,
    cleanupInventoryGapMs: template.cleanupInventoryGapMs,
  };
  writeStableJsonAtomic(outputPath, rendered, { mode: 0o400 });
  return loadResourceWatchdogPolicy(outputPath);
}

/** Validate launch/recovery input against the original generation's contract. */
export function loadLeaseWatchdogPolicy(lease: DockerWorkloadLease, path: string): LoadedResourceWatchdogPolicy {
  const loaded = loadResourceWatchdogPolicy(path);
  const matches =
    lease.schemaVersion === 1
      ? loaded.sha256 === lease.bindings.watchdogPolicySha256
      : isDeepStrictEqual(loaded.policy, lease.bindings.watchdogPolicy);
  if (!matches) throw new Error('watchdog policy does not match the bundle lease');
  if (
    loaded.policy.targetRoot !== lease.paths.stateRoot ||
    loaded.policy.cleanupInventoryGapMs !== lease.cleanupInventoryGapMs
  ) {
    throw new Error('watchdog policy target or cleanup interval does not match the bundle lease');
  }
  return loaded;
}
