/**
 * Frozen watchdog-policy template plus per-session renderer.
 *
 * The checked-in template (`config/docker-workload/resource-watchdog-policy.json`)
 * freezes every measurement threshold and state class but deliberately omits the
 * per-session `targetRoot`/`targetDevice`/`targetInode`. `renderWatchdogPolicy`
 * stamps those from the concrete state root and writes the immutable
 * `LoadedResourceWatchdogPolicy` the supervisor and lease then bind to.
 *
 * Attestation binding: `lease.bindings.watchdogPolicySha256` is the sha256 of the
 * RENDERED file; the frozen TEMPLATE sha256 is recorded separately in
 * audit/evidence.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, posix, resolve } from 'node:path';
import { z } from 'zod';
import { stableStringify } from '../hash.js';
import {
  loadResourceWatchdogPolicy,
  RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION,
  type LoadedResourceWatchdogPolicy,
} from '../docker/resource-watchdog.js';

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

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);
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

export interface LoadedWatchdogPolicyTemplate {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly template: WatchdogPolicyTemplate;
}

/** Load the checked-in frozen template through one no-follow descriptor and hash its exact bytes. */
export function loadFrozenWatchdogPolicyTemplate(path: string): LoadedWatchdogPolicyTemplate {
  if (!isAbsolute(path)) throw new Error('watchdog policy template path must be absolute');
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`watchdog policy template must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`watchdog policy template must be a regular file: ${path}`);
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(`watchdog policy template must not be group/world writable: ${path}`);
    }
    if (stats.size < 2 || stats.size > MAX_WATCHDOG_POLICY_TEMPLATE_BYTES) {
      throw new Error(`watchdog policy template size is outside the allowed range: ${stats.size}`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('watchdog policy template is not valid JSON', { cause: error });
  }
  const validated = watchdogPolicyTemplateSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`watchdog policy template is invalid: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    template: validated.data,
  };
}

/**
 * Stamp the concrete state root's device/inode onto the frozen template, write
 * the immutable per-session policy `0o400`, and return the loaded policy whose
 * sha256 the lease binds. The state root must already exist as a real directory.
 */
export function renderWatchdogPolicy(
  template: WatchdogPolicyTemplate,
  stateRoot: string,
  outputPath: string,
): LoadedResourceWatchdogPolicy {
  if (!isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) {
    throw new Error('watchdog policy state root must be canonical and absolute');
  }
  if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) {
    throw new Error('watchdog policy output path must be canonical and absolute');
  }
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
  writeRenderedPolicyAtomic(outputPath, rendered);
  return loadResourceWatchdogPolicy(outputPath);
}

function writeRenderedPolicyAtomic(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${stableStringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o400);
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
