import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isSelectedAgentCaptureAlias,
  prepareSelectedAgentArtifact,
  verifySelectedAgentArtifactArchive,
} from '../../src/docker/selected-agent-artifact.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';

describe('selected agent artifact', () => {
  let directory: string;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'selected-agent-artifact-')));
    chmodSync(directory, 0o700);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('recognizes only the canonical selected-image capture alias shape', () => {
    const alias = 'ironcurtain-capture-p123-t1755300000000-' + '11111111-1111-4111-8111-111111111111:latest';
    expect(isSelectedAgentCaptureAlias(alias)).toBe(true);
    expect(isSelectedAgentCaptureAlias(`localhost/${alias}`)).toBe(true);
    expect(isSelectedAgentCaptureAlias(`docker.io/library/${alias}`)).toBe(true);
    expect(isSelectedAgentCaptureAlias('ironcurtain-capture-unstructured:latest')).toBe(false);
  });

  it('exports and canonicalizes only the current selected Apple image, then reuses the cache', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = 'a'.repeat(64);
    const fixtureDirectory = mkdtempSync(join(directory, 'fixture-'));
    const fixture = writeOciArchiveFixture({
      directory: fixtureDirectory,
      logicalName,
      buildHash,
      architecture: 'arm64',
      fixtureId: 'artifact-test',
      runtimeImageIdKind: 'index',
      runtimeImageIdOverride: `sha256:${'1'.repeat(64)}`,
      nestedIndex: true,
    });
    let inspects = 0;
    let saves = 0;
    const tagged: Array<[string, string]> = [];
    const removed: string[] = [];
    const runtime = {
      listImages: async () => [],
      inspectImage: async () => {
        inspects += 1;
        return {
          id: fixture.runtimeImageId,
          repoTags: [logicalName],
          labels: { 'ironcurtain.build-hash': buildHash },
          created: '2026-08-15T00:00:00.000Z',
        };
      },
      saveImageArchive: async (_ref: string, archivePath: string) => {
        saves += 1;
        copyFileSync(join(fixtureDirectory, fixture.archive.fileName), archivePath);
      },
      tagImage: async (sourceRef: string, targetRef: string) => {
        tagged.push([sourceRef, targetRef]);
      },
      removeImage: async (ref: string) => {
        removed.push(ref);
        return true;
      },
    };
    const cacheRoot = join(directory, 'cache');
    const stalePreparation = join(cacheRoot, '.prepare-AbC123');
    mkdirSync(stalePreparation, { recursive: true, mode: 0o700 });
    writeFileSync(join(stalePreparation, 'partial'), 'stale');

    const first = await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot,
    });
    const second = await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot,
    });

    expect(first).toEqual(second);
    expect(first.appleImageId).toBe(fixture.runtimeImageId);
    expect(first.dockerImageId).toBe(fixture.configDigest);
    expect(inspects).toBe(3);
    expect(saves).toBe(1);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.[0]).toBe(logicalName);
    expect(tagged[0]?.[1]).toMatch(
      /^ironcurtain-capture-p\d+-t\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:latest$/u,
    );
    expect(removed).toEqual([tagged[0]?.[1]]);
    expect(existsSync(stalePreparation)).toBe(false);
    await expect(verifySelectedAgentArtifactArchive(first)).resolves.toBeUndefined();
  });

  it('reconciles a stale crashed-process alias on restart without touching active or fresh captures', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = '6'.repeat(64);
    const fixtureDirectory = mkdtempSync(join(directory, 'fixture-'));
    const fixture = writeOciArchiveFixture({
      directory: fixtureDirectory,
      logicalName,
      buildHash,
      architecture: 'arm64',
      fixtureId: 'artifact-alias-reconciliation-test',
      runtimeImageIdKind: 'index',
    });
    const oldTimestamp = Date.now() - 2 * 60 * 60_000;
    const staleAlias =
      `localhost/ironcurtain-capture-p2147483647-t${oldTimestamp}-` + '11111111-1111-4111-8111-111111111111:latest';
    const activeAlias =
      `localhost/ironcurtain-capture-p${process.pid}-t${oldTimestamp}-` + '22222222-2222-4222-8222-222222222222:latest';
    const freshAlias =
      `localhost/ironcurtain-capture-p2147483647-t${Date.now()}-` + '33333333-3333-4333-8333-333333333333:latest';
    const removed: string[] = [];
    const events: string[] = [];
    const runtime = {
      listImages: async () => {
        events.push('list');
        return [
          {
            id: fixture.runtimeImageId,
            repoTags: [staleAlias, activeAlias, freshAlias],
            labels: { 'ironcurtain.build-hash': buildHash },
            created: '2026-08-15T00:00:00.000Z',
          },
        ];
      },
      inspectImage: async () => ({
        id: fixture.runtimeImageId,
        repoTags: [logicalName],
        labels: { 'ironcurtain.build-hash': buildHash },
        created: '2026-08-15T00:00:00.000Z',
      }),
      tagImage: async () => {
        events.push('tag');
      },
      saveImageArchive: async (_ref: string, archivePath: string) => {
        copyFileSync(join(fixtureDirectory, fixture.archive.fileName), archivePath);
      },
      removeImage: async (ref: string) => {
        events.push(`remove:${ref}`);
        removed.push(ref);
        return true;
      },
    };

    await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot: join(directory, 'cache'),
    });

    expect(removed).toContain(staleAlias);
    expect(removed).not.toContain(activeAlias);
    expect(removed).not.toContain(freshAlias);
    expect(events.indexOf(`remove:${staleAlias}`)).toBeLessThan(events.indexOf('tag'));
  });

  it('does not reuse a replaced mutable tag that keeps the same build hash', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = 'c'.repeat(64);
    const fixtureDirectories = [
      mkdtempSync(join(directory, 'fixture-one-')),
      mkdtempSync(join(directory, 'fixture-two-')),
    ];
    const fixtures = fixtureDirectories.map((fixtureDirectory, index) =>
      writeOciArchiveFixture({
        directory: fixtureDirectory,
        logicalName,
        buildHash,
        architecture: 'arm64',
        fixtureId: `artifact-replacement-${index}`,
        runtimeImageIdKind: 'index',
      }),
    );
    let selected = 0;
    let saves = 0;
    const runtime = {
      listImages: async () => [],
      inspectImage: async () => ({
        id: fixtures[selected].runtimeImageId,
        repoTags: [logicalName],
        labels: { 'ironcurtain.build-hash': buildHash },
        created: '2026-08-15T00:00:00.000Z',
      }),
      saveImageArchive: async (_ref: string, archivePath: string) => {
        saves += 1;
        copyFileSync(join(fixtureDirectories[selected], fixtures[selected].archive.fileName), archivePath);
      },
      tagImage: async () => undefined,
      removeImage: async () => true,
    };

    const first = await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot: join(directory, 'cache'),
    });
    selected = 1;
    const replacement = await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot: join(directory, 'cache'),
    });

    expect(replacement.appleImageId).toBe(fixtures[1].runtimeImageId);
    expect(replacement.appleImageId).not.toBe(first.appleImageId);
    expect(replacement.archivePath).not.toBe(first.archivePath);
    expect(saves).toBe(2);
  });

  it('exports the pinned alias when the mutable logical tag changes during capture', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = 'e'.repeat(64);
    const fixtureDirectories = [
      mkdtempSync(join(directory, 'fixture-old-')),
      mkdtempSync(join(directory, 'fixture-new-')),
    ];
    const fixtures = fixtureDirectories.map((fixtureDirectory, index) =>
      writeOciArchiveFixture({
        directory: fixtureDirectory,
        logicalName,
        buildHash,
        architecture: 'arm64',
        fixtureId: `artifact-swap-${index}`,
        runtimeImageIdKind: 'index',
      }),
    );
    let selected = 0;
    const pinned = new Map<string, number>();
    let savedReference: string | undefined;
    let removedReference: string | undefined;
    const runtime = {
      listImages: async () => [],
      inspectImage: async (ref: string) => {
        const fixtureIndex = ref === logicalName ? selected : pinned.get(ref);
        if (fixtureIndex === undefined) return undefined;
        return {
          id: fixtures[fixtureIndex].runtimeImageId,
          repoTags: [ref],
          labels: { 'ironcurtain.build-hash': buildHash },
          created: '2026-08-15T00:00:00.000Z',
        };
      },
      tagImage: async (_sourceRef: string, targetRef: string) => {
        pinned.set(targetRef, selected);
        selected = 1;
      },
      saveImageArchive: async (ref: string, archivePath: string) => {
        savedReference = ref;
        const fixtureIndex = pinned.get(ref);
        if (fixtureIndex === undefined) throw new Error('capture did not export the pinned alias');
        copyFileSync(join(fixtureDirectories[fixtureIndex], fixtures[fixtureIndex].archive.fileName), archivePath);
      },
      removeImage: async (ref: string) => {
        removedReference = ref;
        return pinned.delete(ref);
      },
    };

    const artifact = await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot: join(directory, 'cache'),
    });

    expect(artifact.appleImageId).toBe(fixtures[0].runtimeImageId);
    expect(savedReference).toMatch(/^ironcurtain-capture-/u);
    expect(removedReference).toBe(savedReference);
    expect(selected).toBe(1);
    await expect(verifySelectedAgentArtifactArchive(artifact)).resolves.toBeUndefined();
  });

  it('removes the exact capture alias when its pinned identity check fails', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = '7'.repeat(64);
    let captureReference: string | undefined;
    let removedReference: string | undefined;
    const runtime = {
      listImages: async () => [],
      inspectImage: async (ref: string) =>
        ref === logicalName
          ? {
              id: `sha256:${'8'.repeat(64)}`,
              repoTags: [logicalName],
              labels: { 'ironcurtain.build-hash': buildHash },
              created: '2026-08-15T00:00:00.000Z',
            }
          : undefined,
      tagImage: async (_sourceRef: string, targetRef: string) => {
        captureReference = targetRef;
      },
      saveImageArchive: async () => {
        throw new Error('save must not run after capture identity mismatch');
      },
      removeImage: async (ref: string) => {
        removedReference = ref;
        return true;
      },
    };

    await expect(
      prepareSelectedAgentArtifact({
        runtime,
        logicalName,
        buildHash,
        architecture: 'arm64',
        cacheRoot: join(directory, 'cache'),
      }),
    ).rejects.toThrow(/changed while pinning/u);
    expect(removedReference).toBe(captureReference);
    expect(captureReference).toMatch(/^ironcurtain-capture-/u);
  });

  it('bounds old cache entries while preserving a lease-staged hardlink', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = 'd'.repeat(64);
    const fixtureDirectories = Array.from({ length: 5 }, (_, index) =>
      mkdtempSync(join(directory, `fixture-gc-${index}-`)),
    );
    const fixtures = fixtureDirectories.map((fixtureDirectory, index) =>
      writeOciArchiveFixture({
        directory: fixtureDirectory,
        logicalName,
        buildHash,
        architecture: 'arm64',
        fixtureId: `artifact-gc-${index}`,
        runtimeImageIdKind: 'index',
      }),
    );
    let selected = 0;
    const runtime = {
      listImages: async () => [],
      inspectImage: async () => ({
        id: fixtures[selected].runtimeImageId,
        repoTags: [logicalName],
        labels: { 'ironcurtain.build-hash': buildHash },
        created: '2026-08-15T00:00:00.000Z',
      }),
      saveImageArchive: async (_ref: string, archivePath: string) => {
        copyFileSync(join(fixtureDirectories[selected], fixtures[selected].archive.fileName), archivePath);
      },
      tagImage: async () => undefined,
      removeImage: async () => true,
    };
    const prepareCurrent = () =>
      prepareSelectedAgentArtifact({
        runtime,
        logicalName,
        buildHash,
        architecture: 'arm64',
        cacheRoot: join(directory, 'cache'),
      });

    const first = await prepareCurrent();
    const stagedArchive = join(directory, 'lease-staged.oci.tar');
    linkSync(first.archivePath, stagedArchive);
    selected = 1;
    const second = await prepareCurrent();
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(dirname(second.archivePath), old, old);
    selected = 2;
    const third = await prepareCurrent();
    utimesSync(dirname(third.archivePath), old, old);
    const returnedBeforeStaging = await prepareCurrent();
    expect(returnedBeforeStaging.archivePath).toBe(third.archivePath);
    selected = 3;
    const fourth = await prepareCurrent();
    selected = 4;
    const fifth = await prepareCurrent();

    expect(existsSync(first.archivePath)).toBe(true);
    expect(existsSync(stagedArchive)).toBe(true);
    expect(existsSync(second.archivePath)).toBe(false);
    expect(existsSync(third.archivePath)).toBe(true);
    expect(existsSync(fourth.archivePath)).toBe(true);
    expect(existsSync(fifth.archivePath)).toBe(true);
  });

  it('rejects archive corruption before an inner runtime can load it', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = 'b'.repeat(64);
    const fixtureDirectory = mkdtempSync(join(directory, 'fixture-'));
    const fixture = writeOciArchiveFixture({
      directory: fixtureDirectory,
      logicalName,
      buildHash,
      architecture: 'arm64',
      fixtureId: 'artifact-corruption-test',
      runtimeImageIdKind: 'index',
    });
    const artifact = await prepareSelectedAgentArtifact({
      runtime: {
        listImages: async () => [],
        inspectImage: async () => ({
          id: fixture.runtimeImageId,
          repoTags: [logicalName],
          labels: { 'ironcurtain.build-hash': buildHash },
          created: '2026-08-15T00:00:00.000Z',
        }),
        saveImageArchive: async (_ref, archivePath) => {
          copyFileSync(join(fixtureDirectory, fixture.archive.fileName), archivePath);
        },
        tagImage: async () => undefined,
        removeImage: async () => true,
      },
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot: join(directory, 'cache'),
    });
    chmodSync(artifact.archivePath, 0o600);
    writeFileSync(artifact.archivePath, 'corrupt');
    chmodSync(artifact.archivePath, 0o400);

    await expect(verifySelectedAgentArtifactArchive(artifact)).rejects.toThrow(/size mismatch/u);
  });

  it('invalidates and rebuilds a same-size poisoned cache archive', async () => {
    const logicalName = 'ironcurtain-claude-code:latest';
    const buildHash = 'f'.repeat(64);
    const fixtureDirectory = mkdtempSync(join(directory, 'fixture-'));
    const fixture = writeOciArchiveFixture({
      directory: fixtureDirectory,
      logicalName,
      buildHash,
      architecture: 'arm64',
      fixtureId: 'artifact-poison-rebuild-test',
      runtimeImageIdKind: 'index',
    });
    let saves = 0;
    const runtime = {
      listImages: async () => [],
      inspectImage: async () => ({
        id: fixture.runtimeImageId,
        repoTags: [logicalName],
        labels: { 'ironcurtain.build-hash': buildHash },
        created: '2026-08-15T00:00:00.000Z',
      }),
      saveImageArchive: async (_ref: string, archivePath: string) => {
        saves += 1;
        copyFileSync(join(fixtureDirectory, fixture.archive.fileName), archivePath);
      },
      tagImage: async () => undefined,
      removeImage: async () => true,
    };
    const cacheRoot = join(directory, 'cache');
    const first = await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot,
    });
    const poisoned = readFileSync(first.archivePath);
    poisoned[0] = poisoned[0] === 0 ? 1 : 0;
    chmodSync(first.archivePath, 0o600);
    writeFileSync(first.archivePath, poisoned);
    chmodSync(first.archivePath, 0o400);

    const rebuilt = await prepareSelectedAgentArtifact({
      runtime,
      logicalName,
      buildHash,
      architecture: 'arm64',
      cacheRoot,
    });

    expect(saves).toBe(2);
    expect(rebuilt.archiveSizeBytes).toBe(first.archiveSizeBytes);
    await expect(verifySelectedAgentArtifactArchive(rebuilt)).resolves.toBeUndefined();
  });
});
