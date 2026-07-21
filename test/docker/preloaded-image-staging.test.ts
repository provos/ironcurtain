import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stagePreloadedImage } from '../../src/docker/preloaded-image-staging.js';
import type { ExecFileFn } from '../../src/docker/docker-manager.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('preloaded image staging', () => {
  it('fails before Docker save when the source lacks a frozen label', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'preloaded-stage-test-'));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const exec = vi.fn<ExecFileFn>();
    await expect(
      stagePreloadedImage({
        exec,
        dockerRuntime: {
          inspectImage: async () => ({
            id: `sha256:${'1'.repeat(64)}`,
            repoTags: ['localhost/relay:test'],
            labels: {},
            created: '2026-07-20T12:00:00.000Z',
          }),
        },
        image: {
          logicalName: 'localhost/relay:test',
          outputArchivePath: join(directory, 'relay.tar'),
          catalogGeneration: 'catalog.test.1',
          buildHash: '2'.repeat(64),
          architecture: 'arm64',
          dockerApi: { min: '1.44', max: '1.52' },
          toolchain: { dockerCli: '29.2.1', dockerDaemon: '29.2.1', buildx: '0.30.1', compose: '5.0.2' },
          provenance: {
            source: 'docker/nested-relay',
            sourceDigest: `sha256:${'3'.repeat(64)}`,
            createdAt: '2026-07-20T12:00:00.000Z',
          },
        },
      }),
    ).rejects.toThrow(/label mismatch/u);
    expect(exec).not.toHaveBeenCalled();
  });
});
