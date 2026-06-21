import { describe, expect, it, vi } from 'vitest';
import { sweepContainerSnapshots } from '../../src/workflow/container-snapshots.js';
import { commandExists } from '../../src/trusted-process/container-command.js';
import { createDockerManager } from '../../src/docker/docker-manager.js';
import type { CheckpointStore } from '../../src/workflow/checkpoint.js';
import type { ContainerSnapshotRef, WorkflowCheckpoint, WorkflowId } from '../../src/workflow/types.js';
import type { DockerImageInfo, ContainerRuntime } from '../../src/docker/types.js';
import type { ResolvedUserConfig } from '../../src/config/user-config.js';

// The default (no-`docker`-arg) sweep path resolves the Docker CLI lazily; mock
// the probe + factory so we can assert it short-circuits on a Docker-less host.
vi.mock('../../src/trusted-process/container-command.js', () => ({ commandExists: vi.fn(() => true) }));
vi.mock('../../src/docker/docker-manager.js', () => ({ createDockerManager: vi.fn() }));

const NOW = new Date('2026-06-18T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

function resumableCheckpoint(image: string): WorkflowCheckpoint {
  const snapshots: Record<string, ContainerSnapshotRef> = { primary: { image } };
  return {
    finalStatus: { phase: 'aborted', reason: 'test' },
    timestamp: NOW.toISOString(),
    containerSnapshots: snapshots,
  } as unknown as WorkflowCheckpoint;
}

function makeCheckpointStore(entries: Record<string, WorkflowCheckpoint>): CheckpointStore {
  return {
    listAll: () => Object.keys(entries) as WorkflowId[],
    load: (id: WorkflowId) => entries[id],
  } as unknown as CheckpointStore;
}

/** ContainerRuntime stub exposing only the image methods the sweep uses. */
function makeDocker(createdById: Record<string, string>) {
  const removeImage = vi.fn(async (ref: string) => {
    delete createdById[ref];
    return true;
  });
  const docker = {
    async listImages(): Promise<readonly DockerImageInfo[]> {
      return Object.entries(createdById).map(([id, created]) => ({ id, repoTags: [], labels: {}, created }));
    },
    async inspectImage(ref: string): Promise<DockerImageInfo | undefined> {
      const created = createdById[ref];
      return created ? { id: ref, repoTags: [], labels: {}, created } : undefined;
    },
    removeImage,
  } as unknown as ContainerRuntime;
  return { docker, removeImage };
}

function userConfig(snapshot: { enabled: boolean; maxAgeDays: number | null }): ResolvedUserConfig {
  return { snapshot: { ...snapshot, sweepIntervalHours: 24 } } as unknown as ResolvedUserConfig;
}

describe('sweepContainerSnapshots', () => {
  it('skips cleanly without spawning docker when the Docker CLI is absent (apple-container host)', async () => {
    vi.mocked(commandExists).mockReturnValue(false);
    const checkpointStore = makeCheckpointStore({ wf: resumableCheckpoint(`sha256:${'a'.repeat(64)}`) });

    // No `docker` arg → the default path; commandExists('docker') === false must
    // short-circuit before createDockerManager() (which would spawn a missing CLI).
    const result = await sweepContainerSnapshots({
      baseDir: '/tmp/unused',
      checkpointStore,
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      now: NOW,
    });

    expect(result).toEqual({ removedImages: [], agedImages: [], orphanImages: [] });
    expect(commandExists).toHaveBeenCalledWith('docker');
    expect(createDockerManager).not.toHaveBeenCalled();
    vi.mocked(commandExists).mockReturnValue(true);
  });

  it('removes an aged referenced image but keeps a fresh one (image-only, checkpoint untouched)', async () => {
    const aged = `sha256:${'a'.repeat(64)}`;
    const fresh = `sha256:${'f'.repeat(64)}`;
    const { docker, removeImage } = makeDocker({ [aged]: daysAgo(30), [fresh]: daysAgo(1) });
    const checkpointStore = makeCheckpointStore({
      wfAged: resumableCheckpoint(aged),
      wfFresh: resumableCheckpoint(fresh),
    });

    const result = await sweepContainerSnapshots({
      baseDir: '/tmp/unused',
      checkpointStore,
      userConfig: userConfig({ enabled: true, maxAgeDays: 7 }),
      docker,
      now: NOW,
    });

    expect(result.agedImages).toEqual([aged]);
    expect(result.orphanImages).toEqual([]);
    expect(removeImage).toHaveBeenCalledWith(aged);
    expect(removeImage).not.toHaveBeenCalledWith(fresh);
    // The sweep never mutates checkpoints: the (still-resumable) checkpoint for
    // the aged image is left in place for a graceful, image-less resume.
    expect(checkpointStore.load('wfAged' as WorkflowId)).toBeDefined();
  });

  it('removes an unreferenced labeled orphan but spares one inside the commit grace window', async () => {
    const orphanOld = `sha256:${'1'.repeat(64)}`;
    const orphanYoung = `sha256:${'2'.repeat(64)}`;
    // orphanYoung was committed a minute ago and is not yet referenced by any
    // saved checkpoint -- the grace window must protect it from a racing sweep.
    const { docker, removeImage } = makeDocker({ [orphanOld]: minutesAgo(60), [orphanYoung]: minutesAgo(1) });
    const checkpointStore = makeCheckpointStore({}); // nothing references either image

    const result = await sweepContainerSnapshots({
      baseDir: '/tmp/unused',
      checkpointStore,
      userConfig: userConfig({ enabled: true, maxAgeDays: null }), // isolate orphan logic
      docker,
      now: NOW,
    });

    expect(result.orphanImages).toEqual([orphanOld]);
    expect(removeImage).toHaveBeenCalledWith(orphanOld);
    expect(removeImage).not.toHaveBeenCalledWith(orphanYoung);
  });

  it('is a no-op when the snapshot kill switch is off', async () => {
    const { docker, removeImage } = makeDocker({ [`sha256:${'a'.repeat(64)}`]: daysAgo(30) });
    const listSpy = vi.spyOn(docker, 'listImages');

    const result = await sweepContainerSnapshots({
      baseDir: '/tmp/unused',
      checkpointStore: makeCheckpointStore({}),
      userConfig: userConfig({ enabled: false, maxAgeDays: 7 }),
      docker,
      now: NOW,
    });

    expect(result).toEqual({ removedImages: [], agedImages: [], orphanImages: [] });
    expect(listSpy).not.toHaveBeenCalled();
    expect(removeImage).not.toHaveBeenCalled();
  });
});
