import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OciArchiveFixtureOptions {
  readonly directory: string;
  readonly logicalName: string;
  /** Advisory source-runtime name written into OCI/Docker compatibility metadata. */
  readonly sourceReference?: string;
  readonly buildHash: string;
  readonly architecture: 'amd64' | 'arm64';
  /** Optional label used to create distinct image identities in one test. */
  readonly fixtureId?: string;
  /** Docker uses the config digest; Apple Container uses the OCI index digest. */
  readonly runtimeImageIdKind?: 'config' | 'index';
  /** Test-only Apple identity, which is independent of a platform-save archive's index bytes. */
  readonly runtimeImageIdOverride?: string;
  /** Test-only archive entries used to prove the verifier rejects extras. */
  readonly extraFiles?: readonly { readonly name: string; readonly content: Buffer }[];
  /** Test-only metadata mutations used to prove strict source canonicalization. */
  readonly indexMediaType?: string;
  readonly descriptorMediaType?: string;
  readonly duplicateLayer?: boolean;
  /** Apple `container image save --platform` wraps the selected manifest in a nested index. */
  readonly nestedIndex?: boolean;
}

export interface OciArchiveFixture {
  readonly logicalName: string;
  readonly runtimeImageId: string;
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly buildHash: string;
  readonly architecture: 'amd64' | 'arm64';
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly archive: {
    readonly fileName: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
}

export function writeOciArchiveFixture(options: OciArchiveFixtureOptions): OciArchiveFixture {
  const createdAt = '2026-07-20T12:00:00.000Z';
  const labels = {
    'ironcurtain.build-hash': options.buildHash,
    ...(options.fixtureId === undefined ? {} : { 'ironcurtain.test-fixture-id': options.fixtureId }),
  } as const;

  const emptyLayerTar = Buffer.alloc(1024);
  const layerDigest = digest(emptyLayerTar);
  const diffId = digest(emptyLayerTar);
  const config = Buffer.from(
    JSON.stringify({
      architecture: options.architecture,
      os: 'linux',
      config: { Labels: labels },
      rootfs: { type: 'layers', diff_ids: options.duplicateLayer ? [diffId, diffId] : [diffId] },
      history: [{ created: createdAt, created_by: 'fixture' }],
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
  const nestedIndex = options.nestedIndex
    ? Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [
            {
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              digest: manifestDigest,
              size: manifest.length,
              platform: { architecture: options.architecture, os: 'linux' },
            },
          ],
        }),
      )
    : undefined;
  const nestedIndexDigest = nestedIndex === undefined ? undefined : digest(nestedIndex);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: options.indexMediaType ?? 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType:
            options.descriptorMediaType ??
            (nestedIndex === undefined
              ? 'application/vnd.oci.image.manifest.v1+json'
              : 'application/vnd.oci.image.index.v1+json'),
          digest: nestedIndexDigest ?? manifestDigest,
          size: nestedIndex?.length ?? manifest.length,
          platform: { architecture: options.architecture, os: 'linux' },
          annotations: { 'org.opencontainers.image.ref.name': options.sourceReference ?? options.logicalName },
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
        RepoTags: [options.sourceReference ?? options.logicalName],
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
    ...(nestedIndex === undefined || nestedIndexDigest === undefined
      ? []
      : [tarFile(blobPath(nestedIndexDigest), nestedIndex)]),
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
    logicalName: options.logicalName,
    runtimeImageId:
      options.runtimeImageIdOverride ?? (options.runtimeImageIdKind === 'index' ? indexDigest : configDigest),
    manifestDigest,
    configDigest,
    buildHash: options.buildHash,
    architecture: options.architecture,
    labels,
    createdAt,
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
