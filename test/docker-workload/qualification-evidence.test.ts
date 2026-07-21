import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  verifyQualificationEvidence,
  writeQualificationEvidenceManifest,
  type QualificationEvidencePlan,
} from '../../src/docker-workload/qualification-evidence.js';

const temporaryDirectories: string[] = [];
const hash = 'a'.repeat(64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('canonical qualification evidence root', () => {
  it('seals and verifies the exact independently planned file/ID set and input bindings', () => {
    const fixture = evidenceFixture();
    const written = writeQualificationEvidenceManifest(fixture.root, {
      ...fixture.plan,
      startedAt: '2026-07-20T12:00:00.000Z',
      completedAt: '2026-07-20T12:01:00.000Z',
    });
    expect(written.manifest.files.map(({ id, path }) => ({ id, path }))).toEqual(
      [...fixture.plan.files].sort((left, right) => left.path.localeCompare(right.path)),
    );
    expect(verifyQualificationEvidence(fixture.root, fixture.plan).sha256).toBe(written.sha256);
  });

  it('rejects missing, unexpected, symlinked, hash-drifted, and secret-bearing evidence', () => {
    for (const [label, mutate, pattern] of [
      ['missing', (root: string) => rmSync(join(root, 'results/gate.json')), /missing or unexpected/u],
      [
        'unexpected',
        (root: string) => writeFileSync(join(root, 'unexpected.json'), '{}\n', { mode: 0o600 }),
        /missing or unexpected/u,
      ],
      [
        'hash',
        (root: string) => writeFileSync(join(root, 'results/gate.json'), '{"changed":true}\n', { mode: 0o600 }),
        /hash\/size mismatch/u,
      ],
      [
        'secret',
        (root: string) =>
          writeFileSync(join(root, 'results/gate.json'), 'ic-qualification-secret-fixture\n', { mode: 0o600 }),
        /secret marker/u,
      ],
      [
        'symlink',
        (root: string) => {
          rmSync(join(root, 'results/gate.json'));
          symlinkSync('/etc/hosts', join(root, 'results/gate.json'));
        },
        /symlink/u,
      ],
    ] as const) {
      const fixture = sealedFixture(label);
      mutate(fixture.root);
      expect(() => verifyQualificationEvidence(fixture.root, fixture.plan)).toThrow(pattern);
    }
  });

  it('rejects duplicate plan IDs/paths and a manifest rebound to different trusted inputs', () => {
    const duplicateId = evidenceFixture();
    duplicateId.plan.files[1] = { ...duplicateId.plan.files[1], id: duplicateId.plan.files[0].id };
    expect(() =>
      writeQualificationEvidenceManifest(duplicateId.root, {
        ...duplicateId.plan,
        startedAt: '2026-07-20T12:00:00.000Z',
        completedAt: '2026-07-20T12:01:00.000Z',
      }),
    ).toThrow(/duplicate ID/u);

    const duplicatePath = evidenceFixture();
    duplicatePath.plan.files[1] = { ...duplicatePath.plan.files[1], path: duplicatePath.plan.files[0].path };
    expect(() =>
      writeQualificationEvidenceManifest(duplicatePath.root, {
        ...duplicatePath.plan,
        startedAt: '2026-07-20T12:00:00.000Z',
        completedAt: '2026-07-20T12:01:00.000Z',
      }),
    ).toThrow(/duplicate path/u);

    const fixture = sealedFixture('bindings');
    expect(() =>
      verifyQualificationEvidence(fixture.root, {
        ...fixture.plan,
        bindings: { ...fixture.plan.bindings, preloadedCatalogSha256: 'b'.repeat(64) },
      }),
    ).toThrow(/bindings differ/u);
  });

  it('requires two empty identity-bound inventories separated by the frozen interval', () => {
    const nonempty = evidenceFixture();
    writeFileSync(
      join(nonempty.root, 'cleanup/inventory-2.json'),
      `${JSON.stringify({ ...inventory(2), resources: ['owned-object'] })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      writeQualificationEvidenceManifest(nonempty.root, {
        ...nonempty.plan,
        startedAt: '2026-07-20T12:00:00.000Z',
        completedAt: '2026-07-20T12:01:00.000Z',
      }),
    ).toThrow(/invalid or nonempty/u);

    const adjacent = evidenceFixture();
    writeFileSync(
      join(adjacent.root, 'cleanup/inventory-2.json'),
      `${JSON.stringify({ ...inventory(2), observedAt: '2026-07-20T12:00:00.050Z' })}\n`,
      { mode: 0o600 },
    );
    expect(() =>
      writeQualificationEvidenceManifest(adjacent.root, {
        ...adjacent.plan,
        startedAt: '2026-07-20T12:00:00.000Z',
        completedAt: '2026-07-20T12:01:00.000Z',
      }),
    ).toThrow(/not sufficiently separated/u);
  });

  it('rejects non-private roots and evidence files', () => {
    const rootFixture = evidenceFixture();
    chmodSync(rootFixture.root, 0o755);
    expect(() =>
      writeQualificationEvidenceManifest(rootFixture.root, {
        ...rootFixture.plan,
        startedAt: '2026-07-20T12:00:00.000Z',
        completedAt: '2026-07-20T12:01:00.000Z',
      }),
    ).toThrow(/owner-only/u);

    const fileFixture = evidenceFixture();
    chmodSync(join(fileFixture.root, 'results/gate.json'), 0o644);
    expect(() =>
      writeQualificationEvidenceManifest(fileFixture.root, {
        ...fileFixture.plan,
        startedAt: '2026-07-20T12:00:00.000Z',
        completedAt: '2026-07-20T12:01:00.000Z',
      }),
    ).toThrow(/file must be owner-only/u);
  });
});

function sealedFixture(label: string) {
  const fixture = evidenceFixture();
  const sealedRoot = `${fixture.root}-${label}`;
  cpSync(fixture.root, sealedRoot, { recursive: true });
  chmodSync(sealedRoot, 0o700);
  temporaryDirectories.push(sealedRoot);
  writeQualificationEvidenceManifest(sealedRoot, {
    ...fixture.plan,
    startedAt: '2026-07-20T12:00:00.000Z',
    completedAt: '2026-07-20T12:01:00.000Z',
  });
  return { root: sealedRoot, plan: fixture.plan };
}

function evidenceFixture(): {
  readonly root: string;
  readonly plan: QualificationEvidencePlan & {
    files: QualificationEvidencePlan['files'] extends readonly (infer T)[] ? T[] : never;
  };
} {
  const root = mkdtempSync(join(tmpdir(), 'qualification-evidence-'));
  temporaryDirectories.push(root);
  mkdirSync(join(root, 'cleanup'), { mode: 0o700 });
  mkdirSync(join(root, 'results'), { mode: 0o700 });
  writeFileSync(join(root, 'cleanup/inventory-1.json'), `${JSON.stringify(inventory(1))}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'cleanup/inventory-2.json'), `${JSON.stringify(inventory(2))}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'results/gate.json'), '{"passed":true}\n', { mode: 0o600 });
  return {
    root,
    plan: {
      runId: 'apple-rootless-qualification-001',
      variant: 'apple-rootless-vfs',
      platform: 'apple-container',
      architecture: 'arm64',
      bindings: {
        sourceCommit: '1'.repeat(40),
        dirtyPatchSha256: null,
        qualificationContractSha256: hash,
        profileCeilingSha256: hash,
        generatedProfileSha256: hash,
        preloadedCatalogSha256: hash,
        performanceBudgetSha256: hash,
        clientToolchainSha256: hash,
        relayBinarySha256: hash,
        relayConfigSha256: hash,
        relayEndpointSha256: hash,
        watchdogPolicySha256: hash,
        buildEgressManifestSha256: hash,
      },
      files: [
        { id: 'cleanup-inventory-one', path: 'cleanup/inventory-1.json' },
        { id: 'cleanup-inventory-two', path: 'cleanup/inventory-2.json' },
        { id: 'qualification-gate-result', path: 'results/gate.json' },
      ],
    },
  };
}

function inventory(ordinal: 1 | 2) {
  return {
    schemaVersion: 1,
    runId: 'apple-rootless-qualification-001',
    variant: 'apple-rootless-vfs',
    ordinal,
    observedAt: ordinal === 1 ? '2026-07-20T12:00:00.000Z' : '2026-07-20T12:00:00.100Z',
    resources: [],
  };
}
