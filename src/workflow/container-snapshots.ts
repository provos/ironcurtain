import { randomUUID } from 'node:crypto';
import type { DockerManager } from '../docker/types.js';
import { createDockerManager } from '../docker/docker-manager.js';
import * as logger from '../logger.js';
import type { CheckpointStore } from './checkpoint.js';
import { isCheckpointResumable } from './checkpoint.js';
import type { ContainerSnapshotRef, WorkflowCheckpoint, WorkflowId } from './types.js';
import type { ResolvedUserConfig } from '../config/user-config.js';

export const IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW = 'ironcurtain.snapshot.workflow';
export const IRONCURTAIN_SNAPSHOT_LABEL_SCOPE = 'ironcurtain.snapshot.scope';
export const IRONCURTAIN_SNAPSHOT_LABEL_STOP = 'ironcurtain.snapshot.stop';

const SNAPSHOT_TAG_REPOSITORY = 'ironcurtain-snapshot';
const DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS = 600_000;

/**
 * A snapshot image is committed (and labeled) BEFORE its checkpoint is saved
 * (see the stop paths in orchestrator.ts). For that brief window the image is
 * labeled but not yet referenced by any checkpoint. The orphan sweep skips
 * images younger than this so a concurrent sweep can't delete a snapshot that
 * another workflow is mid-commit on.
 */
const ORPHAN_SWEEP_GRACE_MS = 5 * 60 * 1000;

function sanitizeTagPart(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'scope';
}

function buildSnapshotTag(workflowId: WorkflowId, scope: string, stopId: string): string {
  return `${SNAPSHOT_TAG_REPOSITORY}:${workflowId}-${sanitizeTagPart(scope)}-${stopId}`;
}

function uniqueSnapshotImages(snapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined): string[] {
  if (!snapshots) return [];
  return [...new Set(Object.values(snapshots).map((snapshot) => snapshot.image))];
}

export function hasContainerSnapshots(checkpoint: WorkflowCheckpoint | undefined): boolean {
  return uniqueSnapshotImages(checkpoint?.containerSnapshots).length > 0;
}

export function getContainerSnapshotImages(checkpoint: WorkflowCheckpoint | undefined): readonly string[] {
  return uniqueSnapshotImages(checkpoint?.containerSnapshots);
}

export async function commitContainerSnapshot(input: {
  readonly docker: DockerManager;
  readonly workflowId: WorkflowId;
  readonly scope: string;
  readonly containerId: string;
  readonly timeoutMs?: number;
}): Promise<ContainerSnapshotRef> {
  const stopId = randomUUID();
  const tag = buildSnapshotTag(input.workflowId, input.scope, stopId);
  const image = await input.docker.commit(input.containerId, {
    tag,
    pause: false,
    flatten: true,
    timeoutMs: input.timeoutMs ?? DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS,
    // No need to clear inherited ironcurtain.bundle/scope labels: the flatten
    // (export/import) path produces an image with no labels at all, so we only
    // stamp the dedicated snapshot labels used by GC.
    changes: [
      `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW}=${input.workflowId}`,
      `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_SCOPE}=${input.scope}`,
      `LABEL ${IRONCURTAIN_SNAPSHOT_LABEL_STOP}=${stopId}`,
    ],
  });
  return { image, tag };
}

export async function removeContainerSnapshotImages(
  docker: DockerManager,
  snapshots: Readonly<Record<string, ContainerSnapshotRef>> | undefined,
): Promise<void> {
  await Promise.allSettled(uniqueSnapshotImages(snapshots).map((image) => docker.removeImage(image)));
}

export interface ContainerSnapshotGcResult {
  readonly removedImages: readonly string[];
  readonly agedImages: readonly string[];
  readonly orphanImages: readonly string[];
}

export async function sweepContainerSnapshots(input: {
  readonly baseDir: string;
  readonly checkpointStore: CheckpointStore;
  readonly userConfig: ResolvedUserConfig;
  readonly docker?: DockerManager;
  readonly now?: Date;
}): Promise<ContainerSnapshotGcResult> {
  if (!input.userConfig.snapshot.enabled) {
    return { removedImages: [], agedImages: [], orphanImages: [] };
  }

  const docker = input.docker ?? createDockerManager();
  const nowMs = (input.now ?? new Date()).getTime();
  const maxAgeMs =
    input.userConfig.snapshot.maxAgeDays === null ? null : input.userConfig.snapshot.maxAgeDays * 24 * 60 * 60 * 1000;

  const referenced = new Map<string, WorkflowCheckpoint>();
  for (const workflowId of input.checkpointStore.listAll()) {
    let checkpoint: WorkflowCheckpoint | undefined;
    try {
      checkpoint = input.checkpointStore.load(workflowId);
    } catch {
      continue;
    }
    if (!checkpoint || !isCheckpointResumable(checkpoint)) continue;
    for (const image of uniqueSnapshotImages(checkpoint.containerSnapshots)) {
      referenced.set(image, checkpoint);
    }
  }

  const removedImages: string[] = [];
  const orphanImages: string[] = [];
  const agedImages: string[] = [];

  let labeledImages;
  try {
    labeledImages = await docker.listImages({ labelFilter: IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW });
  } catch (err) {
    // Expected when Docker is unavailable (e.g. a builtin, non-Docker workflow
    // triggered the CLI sweep), so degrade quietly -- debug-only so a persistent
    // failure is still discoverable without spamming non-Docker users.
    logger.debug(`snapshot GC: listImages failed, skipping sweep: ${err instanceof Error ? err.message : String(err)}`);
    return { removedImages, agedImages, orphanImages };
  }

  for (const image of labeledImages) {
    if (referenced.has(image.id)) continue;
    const createdMs = Date.parse(image.created);
    if (Number.isFinite(createdMs) && nowMs - createdMs < ORPHAN_SWEEP_GRACE_MS) continue;
    if (await docker.removeImage(image.id)) {
      removedImages.push(image.id);
      orphanImages.push(image.id);
    }
  }

  if (maxAgeMs !== null) {
    for (const [image, checkpoint] of referenced.entries()) {
      const imageInfo = await docker.inspectImage(image);
      if (!imageInfo) continue;
      const imageCreatedMs = Date.parse(imageInfo.created);
      const checkpointMs = Date.parse(checkpoint.timestamp);
      const validTimes = [imageCreatedMs, checkpointMs].filter((value) => Number.isFinite(value));
      if (validTimes.length === 0) continue;
      const bornAtMs = Math.min(...validTimes);
      if (nowMs - bornAtMs <= maxAgeMs) continue;
      if (await docker.removeImage(image)) {
        removedImages.push(image);
        agedImages.push(image);
      }
    }
  }

  return { removedImages, agedImages, orphanImages };
}
