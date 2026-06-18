import { randomUUID } from 'node:crypto';
import type { DockerManager } from '../docker/types.js';
import {
  IRONCURTAIN_LABEL_BUNDLE,
  IRONCURTAIN_LABEL_SCOPE,
  IRONCURTAIN_LABEL_WORKFLOW,
  createDockerManager,
} from '../docker/docker-manager.js';
import type { CheckpointStore } from './checkpoint.js';
import { isCheckpointResumable } from './checkpoint.js';
import type { ContainerSnapshotRef, WorkflowCheckpoint, WorkflowId } from './types.js';
import type { ResolvedUserConfig } from '../config/user-config.js';

export const IRONCURTAIN_SNAPSHOT_LABEL_WORKFLOW = 'ironcurtain.snapshot.workflow';
export const IRONCURTAIN_SNAPSHOT_LABEL_SCOPE = 'ironcurtain.snapshot.scope';
export const IRONCURTAIN_SNAPSHOT_LABEL_STOP = 'ironcurtain.snapshot.stop';

const SNAPSHOT_TAG_REPOSITORY = 'ironcurtain-snapshot';
const DEFAULT_SNAPSHOT_COMMIT_TIMEOUT_MS = 600_000;

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
    changes: [
      `LABEL ${IRONCURTAIN_LABEL_BUNDLE}=`,
      `LABEL ${IRONCURTAIN_LABEL_WORKFLOW}=`,
      `LABEL ${IRONCURTAIN_LABEL_SCOPE}=`,
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
  } catch {
    return { removedImages, agedImages, orphanImages };
  }

  for (const image of labeledImages) {
    if (referenced.has(image.id)) continue;
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
