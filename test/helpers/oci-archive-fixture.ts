import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPreloadedImageLabels,
  catalogTupleDigest,
  IMAGE_BUILD_HASH_SCHEMA,
  RUNTIME_TRUST_SCHEMA,
  type PreloadedImageCatalogEntry,
} from '../../src/docker/preloaded-image-catalog.js';

export interface OciArchiveFixtureOptions {
  readonly directory: string;
  readonly logicalName: string;
  readonly buildHash: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly catalogGeneration: string;
  /** Docker uses the config digest; Apple Container uses the OCI index digest. */
  readonly runtimeImageIdKind?: 'config' | 'index';
  /** Test-only archive entries used to prove the verifier rejects extras. */
  readonly extraFiles?: readonly { readonly name: string; readonly content: Buffer }[];
  /** Test-only metadata mutations used to prove strict source canonicalization. */
  readonly indexMediaType?: string;
  readonly descriptorMediaType?: string;
  readonly duplicateLayer?: boolean;
  readonly toolchain?: {
    readonly dockerCli: string;
    readonly dockerDaemon: string;
    readonly buildx: string;
    readonly compose: string;
  };
  readonly dockerApi?: { readonly min: string; readonly max: string };
}

export function writeOciArchiveFixture(options: OciArchiveFixtureOptions): PreloadedImageCatalogEntry {
  const toolchain =
    options.toolchain ??
    ({
      dockerCli: '28.3.2',
      dockerDaemon: '28.3.2',
      buildx: '0.25.0',
      compose: '2.38.2',
    } as const);
  const provenance = {
    source: 'local qualification fixture',
    sourceDigest: `sha256:${'7'.repeat(64)}`,
    createdAt: '2026-07-20T12:00:00.000Z',
  };
  const provisional: PreloadedImageCatalogEntry = {
    runtimeKind: options.runtimeImageIdKind === 'index' ? 'apple-container' : 'docker',
    logicalName: options.logicalName,
    runtimeImageId: `sha256:${'0'.repeat(64)}`,
    manifestDigest: `sha256:${'0'.repeat(64)}`,
    configDigest: `sha256:${'0'.repeat(64)}`,
    buildHashSchema: IMAGE_BUILD_HASH_SCHEMA,
    buildHash: options.buildHash,
    architecture: options.architecture,
    dockerApi: options.dockerApi ?? { min: '1.44', max: '1.48' },
    runtimeTrustSchema: RUNTIME_TRUST_SCHEMA,
    toolchain,
    toolchainDigest: catalogTupleDigest(toolchain),
    provenance,
    provenanceDigest: catalogTupleDigest(provenance),
    archive: { fileName: 'fixture.oci.tar', sha256: '0'.repeat(64), sizeBytes: 1 },
  };
  const labels = buildPreloadedImageLabels(provisional, options.catalogGeneration);

  const emptyLayerTar = Buffer.alloc(1024);
  const layerDigest = digest(emptyLayerTar);
  const diffId = digest(emptyLayerTar);
  const config = Buffer.from(
    JSON.stringify({
      architecture: options.architecture,
      os: 'linux',
      config: { Labels: labels },
      rootfs: { type: 'layers', diff_ids: options.duplicateLayer ? [diffId, diffId] : [diffId] },
      history: [{ created: provenance.createdAt, created_by: 'fixture' }],
    }),
  );
  const configDigest = digest(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configDigest,
        size: config.length,
      },
      layers: (options.duplicateLayer ? [0, 1] : [0]).map(() => ({
        mediaType: 'application/vnd.oci.image.layer.v1.tar',
        digest: layerDigest,
        size: emptyLayerTar.length,
      })),
    }),
  );
  const manifestDigest = digest(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: options.indexMediaType ?? 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: options.descriptorMediaType ?? 'application/vnd.oci.image.manifest.v1+json',
          digest: manifestDigest,
          size: manifest.length,
          platform: { architecture: options.architecture, os: 'linux' },
          annotations: { 'org.opencontainers.image.ref.name': options.logicalName },
        },
      ],
    }),
  );
  const indexDigest = digest(index);
  const layout = Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  const dockerManifest = Buffer.from(
    JSON.stringify([
      {
        Config: blobPath(configDigest),
        RepoTags: [options.logicalName],
        Layers: (options.duplicateLayer ? [0, 1] : [0]).map(() => blobPath(layerDigest)),
        LayerSources: {
          [layerDigest]: {
            mediaType: 'application/vnd.oci.image.layer.v1.tar',
            size: emptyLayerTar.length,
            digest: layerDigest,
          },
        },
      },
    ]),
  );
  const archive = Buffer.concat([
    tarFile('oci-layout', layout),
    tarFile('index.json', index),
    tarFile(blobPath(configDigest), config),
    tarFile(blobPath(layerDigest), emptyLayerTar),
    tarFile(blobPath(manifestDigest), manifest),
    // Docker's native save manifest points at the same OCI config/layers.
    tarFile('manifest.json', dockerManifest),
    ...(options.extraFiles ?? []).map((file) => tarFile(file.name, file.content)),
    Buffer.alloc(1024),
  ]);
  const fileName = 'fixture.oci.tar';
  writeFileSync(join(options.directory, fileName), archive, { mode: 0o444 });

  return {
    ...provisional,
    runtimeImageId: options.runtimeImageIdKind === 'index' ? indexDigest : configDigest,
    manifestDigest,
    configDigest,
    archive: { fileName, sha256: sha256(archive), sizeBytes: archive.length },
  };
}

function tarFile(name: string, content: Buffer): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`fixture tar path is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  writeOctal(header, 100, 8, 0o444);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encodedChecksum = checksum.toString(8).padStart(6, '0');
  header.write(encodedChecksum, 148, 'ascii');
  header[154] = 0;
  header[155] = 32;
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  target.write(encoded, offset, 'ascii');
  target[offset + length - 1] = 0;
}

function digest(value: Buffer): string {
  return `sha256:${sha256(value)}`;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function blobPath(value: string): string {
  return `blobs/sha256/${value.slice('sha256:'.length)}`;
}
