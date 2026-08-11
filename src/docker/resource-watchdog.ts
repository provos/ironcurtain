/** Host-only observed-state watchdog for secure nested Docker bundles. */

import { lstat, readdir, statfs } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { z } from 'zod';
import { computeHash } from '../hash.js';
import { loadImmutableHostJson } from '../hardened-fs.js';
import { identifierSchema } from '../zod-helpers.js';

export const RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION = 1;
export const MAX_RESOURCE_WATCHDOG_POLICY_BYTES = 256 * 1024;

const positiveBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stateClassSchema = z
  .object({
    id: identifierSchema,
    relativePath: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => !value.startsWith('/') && posix.normalize(value) === value && !value.split('/').includes('..'),
        {
          message: 'state class path must be canonical and relative',
        },
      ),
    kind: z.enum(['file', 'directory']),
    required: z.boolean(),
  })
  .strict();

const resourceWatchdogPolicySchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_WATCHDOG_POLICY_SCHEMA_VERSION),
    policyId: identifierSchema,
    targetRoot: z.string().min(1).max(4096),
    targetDevice: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    targetInode: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    stateClasses: z.array(stateClassSchema).min(1).max(128),
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
  .superRefine((policy, context) => {
    if (!isAbsolute(policy.targetRoot) || resolve(policy.targetRoot) !== policy.targetRoot) {
      context.addIssue({ code: 'custom', message: 'watchdog targetRoot must be canonical and absolute' });
    }
    if (policy.softEvidenceBytes >= policy.hardSafetyBytes) {
      context.addIssue({ code: 'custom', message: 'watchdog soft threshold must be below hard threshold' });
    }
    if (policy.sampleTimeoutMs >= policy.staleAfterMs || policy.staleAfterMs < policy.sampleIntervalMs * 2) {
      context.addIssue({ code: 'custom', message: 'watchdog stale threshold must exceed timeout and two intervals' });
    }
    const ids = policy.stateClasses.map((stateClass) => stateClass.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'duplicate watchdog state class ID' });
    const paths = policy.stateClasses.map((stateClass) => stateClass.relativePath);
    for (const path of paths) {
      if (
        paths.some(
          (candidate) => candidate !== path && (path.startsWith(`${candidate}/`) || candidate.startsWith(`${path}/`)),
        )
      ) {
        context.addIssue({ code: 'custom', message: 'watchdog state classes must not overlap' });
        break;
      }
    }
  });

export type ResourceWatchdogPolicy = z.infer<typeof resourceWatchdogPolicySchema>;

export interface LoadedResourceWatchdogPolicy {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly policy: ResourceWatchdogPolicy;
}

export interface ResourceStateClassSample {
  readonly id: string;
  readonly path: string;
  readonly exists: boolean;
  readonly allocatedBytes: number;
}

export interface ResourceWatchdogSample {
  readonly sampledAtMs: number;
  readonly targetDevice: number;
  readonly targetInode: number;
  readonly availableBytes: number;
  readonly allocatedBytes: number;
  readonly classes: readonly ResourceStateClassSample[];
}

export type ResourceWatchdogTripCode =
  | 'hard-state-threshold'
  | 'host-reserve'
  | 'sample-error'
  | 'sample-stale'
  | 'target-identity';

export interface ResourceWatchdogTrip {
  readonly code: ResourceWatchdogTripCode;
  readonly atMs: number;
  readonly detail: string;
  readonly sample?: ResourceWatchdogSample;
  readonly overshootBytes: number;
  readonly overshootWithinFrozenMaximum: boolean;
}

export interface ResourceWatchdogCleanupProof {
  readonly exactOuterResourceAbsent: boolean;
  readonly stateRootAbsent: boolean;
  readonly inventories: readonly [
    { readonly capturedAtMs: number; readonly ownedResourceIds: readonly string[] },
    { readonly capturedAtMs: number; readonly ownedResourceIds: readonly string[] },
  ];
}

export interface ResourceWatchdogAttestation {
  readonly policyId: string;
  readonly policyHash: string;
  readonly firstSample: ResourceWatchdogSample;
}

class ResourceWatchdogRevocationError extends Error {}

interface ResourceWatchdogOptions {
  readonly sample?: (signal: AbortSignal) => Promise<ResourceWatchdogSample>;
  readonly onTrip: (trip: ResourceWatchdogTrip) => Promise<void>;
  readonly onSoftEvidence?: (sample: ResourceWatchdogSample) => void;
  readonly now?: () => number;
  readonly schedule?: boolean;
}

/**
 * Samples independently of coordinator work. Production starts this in a
 * separate supervisor process; this class contains the fail-closed state
 * machine and is intentionally unaware of an inner Docker daemon.
 */
export class ResourceWatchdog {
  private readonly policy: ResourceWatchdogPolicy;
  private readonly expectedStateClassIdsJson: string;
  private readonly sampleState: (signal: AbortSignal) => Promise<ResourceWatchdogSample>;
  private readonly onTrip: (trip: ResourceWatchdogTrip) => Promise<void>;
  private readonly onSoftEvidence: ((sample: ResourceWatchdogSample) => void) | undefined;
  private readonly now: () => number;
  private readonly shouldSchedule: boolean;
  private timer: NodeJS.Timeout | undefined;
  private samplingStartedAtMs: number | undefined;
  private lastCompletedAtMs: number | undefined;
  private tripRecord: ResourceWatchdogTrip | undefined;
  private revocationFailure: string | undefined;
  private stopped = false;

  constructor(policy: ResourceWatchdogPolicy, options: ResourceWatchdogOptions) {
    this.policy = resourceWatchdogPolicySchema.parse(policy);
    this.expectedStateClassIdsJson = JSON.stringify(this.policy.stateClasses.map((stateClass) => stateClass.id).sort());
    this.sampleState = options.sample ?? ((signal) => sampleValidatedResourceStateAsync(this.policy, Date.now, signal));
    this.onTrip = options.onTrip;
    this.onSoftEvidence = options.onSoftEvidence;
    this.now = options.now ?? Date.now;
    this.shouldSchedule = options.schedule ?? true;
  }

  async start(): Promise<ResourceWatchdogAttestation> {
    if (this.stopped || this.lastCompletedAtMs !== undefined || this.timer !== undefined) {
      throw new Error('resource watchdog cannot be started twice');
    }
    const firstSample = await this.tick();
    if (firstSample === undefined || this.tripRecord !== undefined) {
      throw new Error(`resource watchdog failed startup attestation: ${this.tripRecord?.detail ?? 'no sample'}`);
    }
    if (this.shouldSchedule) {
      this.timer = setInterval(() => void this.tick(), this.policy.sampleIntervalMs);
    }
    return { policyId: this.policy.policyId, policyHash: computeHash(this.policy), firstSample };
  }

  async tick(): Promise<ResourceWatchdogSample | undefined> {
    if (this.stopped || this.tripRecord !== undefined) return undefined;
    const now = this.now();
    if (this.samplingStartedAtMs !== undefined) {
      if (now - this.samplingStartedAtMs >= this.policy.staleAfterMs) {
        await this.trigger('sample-stale', `sample has not completed for ${now - this.samplingStartedAtMs}ms`);
      }
      return undefined;
    }
    if (this.lastCompletedAtMs !== undefined && now - this.lastCompletedAtMs >= this.policy.staleAfterMs) {
      await this.trigger('sample-stale', `last completed sample is ${now - this.lastCompletedAtMs}ms old`);
      return undefined;
    }

    this.samplingStartedAtMs = now;
    const abortController = new AbortController();
    try {
      const sample = await withTimeout(
        this.sampleState(abortController.signal),
        this.policy.sampleTimeoutMs,
        'resource sample timed out',
        () => abortController.abort(new Error('resource sample timed out')),
      );
      this.assertSampleIdentity(sample);
      this.lastCompletedAtMs = this.now();
      if (sample.availableBytes < this.policy.hostReserveBytes) {
        await this.trigger(
          'host-reserve',
          `host available bytes ${sample.availableBytes} are below reserve ${this.policy.hostReserveBytes}`,
          sample,
        );
      } else if (sample.allocatedBytes > this.policy.hardSafetyBytes) {
        await this.trigger(
          'hard-state-threshold',
          `owned state ${sample.allocatedBytes} exceeds hard threshold ${this.policy.hardSafetyBytes}`,
          sample,
        );
      } else if (sample.allocatedBytes >= this.policy.softEvidenceBytes) {
        this.onSoftEvidence?.(sample);
      }
      return sample;
    } catch (error) {
      if (error instanceof ResourceWatchdogRevocationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code: ResourceWatchdogTripCode = /identity/u.test(message) ? 'target-identity' : 'sample-error';
      await this.trigger(code, message);
      return undefined;
    } finally {
      this.samplingStartedAtMs = undefined;
    }
  }

  get trip(): ResourceWatchdogTrip | undefined {
    return this.tripRecord;
  }

  get revocationError(): string | undefined {
    return this.revocationFailure;
  }

  assertFresh(): void {
    if (this.stopped) throw new Error('resource watchdog is stopped');
    if (this.tripRecord !== undefined) throw new Error(`resource watchdog tripped: ${this.tripRecord.detail}`);
    if (this.lastCompletedAtMs === undefined || this.now() - this.lastCompletedAtMs >= this.policy.staleAfterMs) {
      throw new Error('resource watchdog sample is stale or absent');
    }
  }

  stopAfterCleanup(proof: ResourceWatchdogCleanupProof): void {
    if (!proof.exactOuterResourceAbsent || !proof.stateRootAbsent) {
      throw new Error('resource watchdog cannot stop before exact outer/state removal');
    }
    const [first, second] = proof.inventories;
    if (first.ownedResourceIds.length !== 0 || second.ownedResourceIds.length !== 0) {
      throw new Error('resource watchdog cannot stop before two empty owned inventories');
    }
    if (second.capturedAtMs - first.capturedAtMs < this.policy.cleanupInventoryGapMs) {
      throw new Error('resource watchdog cleanup inventories are not sufficiently separated');
    }
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.stopped = true;
  }

  private assertSampleIdentity(sample: ResourceWatchdogSample): void {
    if (sample.targetDevice !== this.policy.targetDevice || sample.targetInode !== this.policy.targetInode) {
      throw new Error(
        `watchdog target identity changed: expected ${this.policy.targetDevice}:${this.policy.targetInode}, ` +
          `got ${sample.targetDevice}:${sample.targetInode}`,
      );
    }
    const actualIds = sample.classes.map((stateClass) => stateClass.id).sort();
    if (JSON.stringify(actualIds) !== this.expectedStateClassIdsJson) {
      throw new Error('watchdog target identity/scope changed: state class set mismatch');
    }
    const total = sample.classes.reduce((sum, stateClass) => sum + stateClass.allocatedBytes, 0);
    if (total !== sample.allocatedBytes) throw new Error('watchdog sample allocated-byte total is inconsistent');
  }

  private async trigger(
    code: ResourceWatchdogTripCode,
    detail: string,
    sample?: ResourceWatchdogSample,
  ): Promise<void> {
    if (this.tripRecord !== undefined) return;
    const overshootBytes = Math.max(0, (sample?.allocatedBytes ?? 0) - this.policy.hardSafetyBytes);
    const trip: ResourceWatchdogTrip = {
      code,
      atMs: this.now(),
      detail,
      ...(sample === undefined ? {} : { sample }),
      overshootBytes,
      overshootWithinFrozenMaximum: overshootBytes <= this.policy.maximumOvershootBytes,
    };
    this.tripRecord = trip;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.onTrip(trip);
    } catch (error) {
      this.revocationFailure = error instanceof Error ? error.message : String(error);
      throw new ResourceWatchdogRevocationError(`resource watchdog revocation failed: ${this.revocationFailure}`, {
        cause: error,
      });
    }
  }
}

export function loadResourceWatchdogPolicy(path: string): LoadedResourceWatchdogPolicy {
  const loaded = loadImmutableHostJson(path, {
    label: 'resource watchdog policy',
    schema: resourceWatchdogPolicySchema,
    maxBytes: MAX_RESOURCE_WATCHDOG_POLICY_BYTES,
  });
  return { path: loaded.path, sha256: loaded.sha256, sizeBytes: loaded.sizeBytes, policy: loaded.value };
}

/**
 * Measure allocated host blocks for non-overlapping exact state classes. The
 * signal is the caller's cancellation seam; an unaborted default keeps one-shot
 * measurements outside the watchdog's timeout machinery simple.
 */
export function sampleResourceState(
  policy: ResourceWatchdogPolicy,
  now = Date.now,
  signal: AbortSignal = new AbortController().signal,
): Promise<ResourceWatchdogSample> {
  return sampleValidatedResourceStateAsync(resourceWatchdogPolicySchema.parse(policy), now, signal);
}

/**
 * Sample using an already-validated policy; the ResourceWatchdog hot path skips
 * the per-tick re-parse. Async so timeout and supervisor signals remain
 * observable during large walks.
 */
async function sampleValidatedResourceStateAsync(
  validated: ResourceWatchdogPolicy,
  now: () => number,
  signal: AbortSignal,
): Promise<ResourceWatchdogSample> {
  throwIfAborted(signal);
  const root = await lstat(validated.targetRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('watchdog target identity is not a real directory');
  if (root.dev !== validated.targetDevice || root.ino !== validated.targetInode) {
    throw new Error('watchdog target identity changed before measurement');
  }
  const filesystem = await statfs(validated.targetRoot);
  const classes: ResourceStateClassSample[] = [];
  for (const stateClass of validated.stateClasses) {
    throwIfAborted(signal);
    const path = join(validated.targetRoot, stateClass.relativePath);
    const escaped = relative(validated.targetRoot, path);
    if (escaped.startsWith('..') || isAbsolute(escaped)) {
      throw new Error(`watchdog state class escapes root: ${stateClass.id}`);
    }
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (isMissingError(error) && !stateClass.required) {
        classes.push({ id: stateClass.id, path, exists: false, allocatedBytes: 0 });
        continue;
      }
      throw error;
    }
    if (stateClass.kind === 'file' && !stats.isFile()) {
      throw new Error(`watchdog state class is not a file: ${stateClass.id}`);
    }
    if (stateClass.kind === 'directory' && !stats.isDirectory()) {
      throw new Error(`watchdog state class is not a directory: ${stateClass.id}`);
    }
    classes.push({
      id: stateClass.id,
      path,
      exists: true,
      allocatedBytes: await allocatedTreeBytesAsync(path, signal),
    });
  }
  throwIfAborted(signal);
  return {
    sampledAtMs: now(),
    targetDevice: root.dev,
    targetInode: root.ino,
    availableBytes: filesystem.bavail * filesystem.bsize,
    allocatedBytes: classes.reduce((sum, stateClass) => sum + stateClass.allocatedBytes, 0),
    classes,
  };
}

async function allocatedTreeBytesAsync(path: string, signal: AbortSignal): Promise<number> {
  const seen = new Set<string>();
  const pending = [path];
  let bytes = 0;
  while (pending.length > 0) {
    throwIfAborted(signal);
    const entryPath = pending.pop();
    if (entryPath === undefined) break;
    const stats = await lstat(entryPath);
    const identity = `${stats.dev}:${stats.ino}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    bytes += stats.blocks * 512;
    // Never follow symlinks. Their inode blocks count, their target does not.
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const entry of await readdir(entryPath)) pending.push(join(entryPath, entry));
    }
  }
  return bytes;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('resource sample aborted');
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      onTimeout();
      rejectPromise(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
