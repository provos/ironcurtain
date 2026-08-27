/** Host-owned IronCurtain MITM certificate-authority storage. */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import * as tls from 'node:tls';
import forge from 'node-forge';
import * as logger from '../logger.js';
import { acquireProcessLock } from '../docker-workload/process-lock.js';

export interface CertificateAuthority {
  /** Authenticated generation selected by the atomically published current manifest. */
  readonly generation: string;
  readonly certPem: string;
  readonly keyPem: string;
  readonly certPath: string;
  readonly keyPath: string;
}

export type CertificateAuthorityInspection =
  | { readonly state: 'uninitialized'; readonly directory: string }
  | { readonly state: 'migration-required'; readonly directory: string; readonly generation?: string }
  | { readonly state: 'ready'; readonly directory: string; readonly generation: string };

export type CertificateAuthorityRepair =
  | { readonly state: 'not-needed'; readonly directory: string; readonly generation?: string }
  | { readonly state: 'hardened'; readonly directory: string; readonly generation?: string }
  | { readonly state: 'migrated'; readonly directory: string; readonly generation: string }
  | {
      readonly state: 'rotated';
      readonly directory: string;
      readonly generation: string;
      readonly quarantineDirectory: string;
    };

type CertificateAuthorityFiles = Omit<CertificateAuthority, 'generation'>;

type AuthorityProfile = 'legacy-v1' | 'strict-v2';

interface VerifiedCertificateAuthorityFiles extends CertificateAuthorityFiles {
  readonly profile: AuthorityProfile;
}

interface VerifiedCertificateAuthority extends CertificateAuthority {
  readonly profile: AuthorityProfile;
}

const LEGACY_CERT_FILENAME = 'ca-cert.pem';
const LEGACY_KEY_FILENAME = 'ca-key.pem';
const GENERATIONS_DIRECTORY = 'generations';
const GENERATION_CERT_FILENAME = 'ca-cert.pem';
const GENERATION_KEY_FILENAME = 'ca-key.pem';
const GENERATION_MANIFEST_FILENAME = 'manifest.json';
const CURRENT_FILENAME = 'current.json';
const LOCK_FILENAME = '.ca.lock';
const PARENT_LOCK_FILENAME = '.ca-repair.lock';
const CERT_MODE = 0o644;
const KEY_MODE = 0o600;
const MANIFEST_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_CA_FILE_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const CA_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const MIN_REMAINING_VALIDITY_MS = 24 * 60 * 60 * 1000;
const LEAF_VALIDITY_MS = 24 * 60 * 60 * 1000;
const LEAF_RENEWAL_MARGIN_MS = 60 * 60 * 1000;
const GENERATION_PATTERN = /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CURRENT_TEMP_PATTERN = /^\.current\.json\.tmp-[0-9]+-[0-9a-f-]+$/u;
const BASIC_CONSTRAINTS_OID = '2.5.29.19';
const KEY_USAGE_OID = '2.5.29.15';
const SUBJECT_KEY_IDENTIFIER_OID = '2.5.29.14';
const AUTHORITY_KEY_IDENTIFIER_OID = '2.5.29.35';
const TRANSIENT_FILESYSTEM_ERROR_CODES = new Set(['EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOSPC', 'ESTALE']);

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface PreparedAuthorityParent {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly wasBroad: boolean;
  readonly wasWritable: boolean;
}

type CertificateAuthorityStorage =
  | { readonly state: 'uninitialized' }
  | { readonly state: 'legacy'; readonly authority: VerifiedCertificateAuthorityFiles }
  | { readonly state: 'current'; readonly authority: VerifiedCertificateAuthority };

type CertificateAuthorityRepairAssessment =
  | {
      readonly action: 'none';
      readonly inspection: CertificateAuthorityInspection;
      readonly directoryWasBroad: boolean;
    }
  | { readonly action: 'rotate' };

interface GenerationManifest {
  readonly schemaVersion: 1;
  readonly certificate: GenerationManifestFile;
  readonly privateKey: GenerationManifestFile;
}

interface GenerationManifestFile {
  readonly filename: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: '0644' | '0600';
}

interface CurrentManifest {
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly manifestSha256: string;
}

/**
 * Load the exact current generation or create/migrate one under the bounded
 * process lock. Only `current.json` is authoritative: generation contents are
 * fully written, fsynced, hashed, and verified before that one pointer is
 * atomically renamed into place.
 */
export function loadOrCreateCA(caDir: string): CertificateAuthority {
  const directory = resolve(caDir);
  const parent = prepareAuthorityParent(directory, false);
  const parentLock = acquireProcessLock(join(parent.path, PARENT_LOCK_FILENAME), {
    attempts: 8,
    processIdentityForPid: livePidIdentity,
  });
  try {
    return loadOrCreateCAWithParentLock(directory);
  } finally {
    parentLock.release();
  }
}

function loadOrCreateCAWithParentLock(directory: string): CertificateAuthority {
  prepareAuthorityDirectory(directory);
  const lock = acquireProcessLock(join(directory, LOCK_FILENAME), {
    attempts: 8,
    processIdentityForPid: livePidIdentity,
  });
  try {
    cleanupInterruptedCurrentTemps(directory);
    const storage = analyzeCertificateAuthorityStorage(directory);
    if (storage.state === 'current') {
      const authority = storage.authority;
      if (authority.profile === 'legacy-v1') {
        cleanupLegacyMigrationRemainder(directory, authority);
        const migrated = publishStrictAuthorityWithExistingKey(directory, authority.keyPem, true);
        return withoutProfile(migrated);
      }
      cleanupLegacyMigrationRemainder(directory, authority);
      return withoutProfile(authority);
    }

    cleanupUnreachableGenerations(directory);
    if (storage.state === 'legacy') {
      const legacy = storage.authority;
      const authority =
        legacy.profile === 'legacy-v1'
          ? publishStrictAuthorityWithExistingKey(directory, legacy.keyPem, false)
          : publishGeneration(directory, legacy.certPem, legacy.keyPem, false);
      removeExactLegacyPair(legacy);
      fsyncDirectory(directory);
      return withoutProfile(authority);
    }
    return withoutProfile(generateAndPublishCA(directory));
  } finally {
    lock.release();
  }
}

/**
 * Explicitly repair CA storage. Safe legacy/current state is hardened or
 * migrated in place. State whose integrity or key confidentiality cannot be
 * established is renamed to a quarantine sibling and replaced with a newly
 * generated authority; quarantined contents are never opened or traversed.
 */
export function repairCertificateAuthority(caDir: string): CertificateAuthorityRepair {
  const directory = resolve(caDir);
  const parentCreated = createAuthorityParentIfMissing(directory);
  const parent = prepareAuthorityParent(directory, true);
  const parentLock = acquireProcessLock(join(parent.path, PARENT_LOCK_FILENAME), {
    attempts: 8,
    processIdentityForPid: livePidIdentity,
  });
  try {
    assertPathIdentity(parent.path, parent.identity, 'parent directory');
    const entry = lstatIfPresent(directory);
    if (entry === undefined) {
      return { state: parentCreated || parent.wasBroad ? 'hardened' : 'not-needed', directory };
    }

    const assessment = assessCertificateAuthorityForRepair(directory, entry, parent.wasWritable);
    if (assessment.action === 'rotate') {
      return rotateQuarantinedAuthority(directory, parent.path, parent.identity);
    }

    const { inspection, directoryWasBroad } = assessment;
    if (inspection.state === 'uninitialized') {
      prepareAuthorityDirectory(directory);
      return {
        state: parentCreated || parent.wasBroad || directoryWasBroad ? 'hardened' : 'not-needed',
        directory,
      };
    }

    const authority = loadOrCreateCAWithParentLock(directory);
    if (inspection.state === 'migration-required') {
      return { state: 'migrated', directory, generation: authority.generation };
    }
    return {
      state: parentCreated || parent.wasBroad || directoryWasBroad ? 'hardened' : 'not-needed',
      directory,
      generation: authority.generation,
    };
  } finally {
    parentLock.release();
  }
}

function assessCertificateAuthorityForRepair(
  directory: string,
  entry: Stats,
  parentWasWritable: boolean,
): CertificateAuthorityRepairAssessment {
  const expectedUid = process.getuid?.();
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`IronCurtain CA repair refuses to replace non-directory path ${directory}`);
  }
  if (expectedUid !== undefined && entry.uid !== expectedUid) {
    throw new Error(`IronCurtain CA repair refuses to replace directory not owned by the current user: ${directory}`);
  }
  if (parentWasWritable) return { action: 'rotate' };
  if ((entry.mode & 0o022) !== 0) return { action: 'rotate' };

  try {
    return {
      action: 'none',
      inspection: inspectCertificateAuthority(directory),
      directoryWasBroad: (entry.mode & 0o777) !== DIRECTORY_MODE,
    };
  } catch (error) {
    if (isTransientFilesystemFailure(error)) throw error;
    return { action: 'rotate' };
  }
}

function isTransientFilesystemFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_FILESYSTEM_ERROR_CODES.has(code);
}

function rotateQuarantinedAuthority(
  directory: string,
  parent: string,
  parentIdentity: FileIdentity,
): CertificateAuthorityRepair {
  const id = randomUUID();
  const stagingDirectory = join(parent, `.${basename(directory)}.repair-staging-${id}`);
  const quarantineDirectory = join(
    parent,
    `${basename(directory)}.quarantine-${new Date().toISOString().replace(/[^0-9]/gu, '')}-${id}`,
  );
  assertPathIdentity(parent, parentIdentity, 'parent directory');
  mkdirSync(stagingDirectory, { mode: DIRECTORY_MODE });
  let stagingPublished = false;
  let oldQuarantined = false;
  try {
    validateAuthorityDirectory(lstatSync(stagingDirectory), stagingDirectory, true);
    const authority = generateAndPublishCA(stagingDirectory);
    assertPathIdentity(parent, parentIdentity, 'parent directory');
    renameSync(directory, quarantineDirectory);
    oldQuarantined = true;
    fsyncDirectory(parent);
    renameSync(stagingDirectory, directory);
    stagingPublished = true;
    fsyncDirectory(parent);
    return {
      state: 'rotated',
      directory,
      generation: authority.generation,
      quarantineDirectory,
    };
  } catch (error) {
    if (oldQuarantined && !stagingPublished) {
      try {
        assertPathIdentity(parent, parentIdentity, 'parent directory');
        if (lstatIfPresent(directory) === undefined) {
          renameSync(quarantineDirectory, directory);
          oldQuarantined = false;
          fsyncDirectory(parent);
        }
      } catch (restoreError) {
        throw new Error(
          `IronCurtain CA repair failed (${String(error)}); old state remains at ${quarantineDirectory} and the fresh replacement at ${stagingDirectory}`,
          { cause: restoreError },
        );
      }
    }
    if (oldQuarantined) {
      throw new Error(`IronCurtain CA repair failed after preserving old state at ${quarantineDirectory}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (!stagingPublished && !oldQuarantined) rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * Verify that the CA storage can be consumed by {@link loadOrCreateCA}
 * without creating, migrating, hardening, or cleaning any filesystem state.
 * Valid legacy storage is reported separately so diagnostics can explain that
 * the next container session will migrate it.
 */
export function inspectCertificateAuthority(caDir: string): CertificateAuthorityInspection {
  const { directory, exists } = inspectAuthorityDirectory(caDir);
  if (!exists) return { state: 'uninitialized', directory };

  const storage = analyzeCertificateAuthorityStorage(directory);
  if (storage.state === 'uninitialized') return { state: 'uninitialized', directory };
  if (storage.state === 'legacy') return { state: 'migration-required', directory };
  return {
    state: storage.authority.profile === 'legacy-v1' ? 'migration-required' : 'ready',
    directory,
    generation: storage.authority.generation,
  };
}

function analyzeCertificateAuthorityStorage(directory: string): CertificateAuthorityStorage {
  validateInterruptedCurrentTemps(directory);
  const currentPath = join(directory, CURRENT_FILENAME);
  if (pathExistsNoFollow(currentPath)) {
    const authority = loadCurrentAuthority(directory, currentPath);
    validateLegacyMigrationRemainder(directory, authority);
    return { state: 'current', authority };
  }

  const legacyCertPath = join(directory, LEGACY_CERT_FILENAME);
  const legacyKeyPath = join(directory, LEGACY_KEY_FILENAME);
  const certExists = pathExistsNoFollow(legacyCertPath);
  const keyExists = pathExistsNoFollow(legacyKeyPath);
  if (certExists !== keyExists) {
    throw new Error(
      'IronCurtain CA is incomplete: legacy ca-cert.pem and ca-key.pem must either both exist or both be absent',
    );
  }

  validateUnreachableGenerations(directory);
  if (!certExists) return { state: 'uninitialized' };
  return { state: 'legacy', authority: loadAndVerifyAuthorityFiles(legacyCertPath, legacyKeyPath) };
}

function livePidIdentity(pid: number): string | undefined {
  try {
    process.kill(pid, 0);
    return `live-pid:${pid}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return undefined;
    if (code === 'EPERM') return `live-pid:${pid}`;
    throw error;
  }
}

function prepareAuthorityDirectory(input: string): string {
  const directory = resolve(input);
  try {
    const existing = lstatSync(directory);
    validateAuthorityDirectory(existing, directory, false);
    hardenDirectoryMode(existing, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(directory);
    const parentStats = lstatSync(parent);
    validateAuthorityDirectory(parentStats, parent, false);
    hardenDirectoryMode(parentStats, parent);
    try {
      mkdirSync(directory, { mode: DIRECTORY_MODE });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      // A concurrent first caller may have created the exact directory after
      // our ENOENT observation. Never treat EEXIST as success without a fresh
      // no-follow owner/type/mode validation below.
    }
    const created = lstatSync(directory);
    validateAuthorityDirectory(created, directory, false);
    hardenDirectoryMode(created, directory);
  }
  validateAuthorityDirectory(lstatSync(directory), directory, true);
  return directory;
}

function prepareAuthorityParent(directory: string, allowWritable: boolean): PreparedAuthorityParent {
  const path = dirname(directory);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    validateAuthorityDirectory(before, path, false);
    if (!allowWritable) validateHardenableDirectoryMode(before, path);
    const mode = before.mode & 0o777;
    if (mode !== DIRECTORY_MODE) {
      fchmodSync(descriptor, DIRECTORY_MODE);
      fsyncSync(descriptor);
    }
    const after = fstatSync(descriptor);
    const published = lstatSync(path);
    validateAuthorityDirectory(after, path, true);
    if (!sameIdentity(before, after) || !sameIdentity(after, published)) {
      throw new Error(`IronCurtain CA parent directory changed while it was being hardened: ${path}`);
    }
    return {
      path,
      identity: identity(after),
      wasBroad: mode !== DIRECTORY_MODE,
      wasWritable: (mode & 0o022) !== 0,
    };
  } finally {
    closeSync(descriptor);
  }
}

function inspectAuthorityDirectory(input: string): { readonly directory: string; readonly exists: boolean } {
  const directory = resolve(input);
  const parent = dirname(directory);
  const parentStats = lstatIfPresent(parent);
  if (parentStats === undefined) return { directory, exists: false };
  validateAuthorityDirectory(parentStats, parent, false);
  validateHardenableDirectoryMode(parentStats, parent);
  try {
    const existing = lstatSync(directory);
    validateAuthorityDirectory(existing, directory, false);
    validateHardenableDirectoryMode(existing, directory);
    return { directory, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { directory, exists: false };
  }
}

function createAuthorityParentIfMissing(directory: string): boolean {
  const parent = dirname(directory);
  if (lstatIfPresent(parent) !== undefined) return false;

  const ancestor = dirname(parent);
  const ancestorStats = lstatSync(ancestor);
  validateAuthorityDirectory(ancestorStats, ancestor, false);
  validateHardenableDirectoryMode(ancestorStats, ancestor);
  try {
    mkdirSync(parent, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  validateAuthorityDirectory(lstatSync(parent), parent, true);
  return true;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function hardenDirectoryMode(stats: Stats, path: string): void {
  validateHardenableDirectoryMode(stats, path);
  const mode = stats.mode & 0o777;
  if (mode !== DIRECTORY_MODE) chmodSync(path, DIRECTORY_MODE);
}

function validateHardenableDirectoryMode(stats: Stats, path: string): void {
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`IronCurtain CA directory ${path} is group- or world-writable`);
  }
}

function validateAuthorityDirectory(stats: Stats, path: string, requireExactMode: boolean): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`IronCurtain CA path ${path} must be a real directory`);
  }
  const expectedUid = process.getuid?.();
  if (expectedUid !== undefined && stats.uid !== expectedUid) {
    throw new Error(`IronCurtain CA directory ${path} is not owned by the current user`);
  }
  if (requireExactMode && (stats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`IronCurtain CA directory ${path} must have mode 0700`);
  }
}

function loadCurrentAuthority(directory: string, currentPath: string): VerifiedCertificateAuthority {
  const currentBytes = readExactFile(currentPath, MANIFEST_MODE, 'current manifest', MAX_MANIFEST_BYTES);
  const current = parseCurrentManifest(currentBytes);
  const generationDirectory = join(directory, GENERATIONS_DIRECTORY, current.generation);
  validateAuthorityDirectory(lstatSync(generationDirectory), generationDirectory, true);
  const manifestPath = join(generationDirectory, GENERATION_MANIFEST_FILENAME);
  const manifestBytes = readExactFile(manifestPath, MANIFEST_MODE, 'generation manifest', MAX_MANIFEST_BYTES);
  if (sha256(manifestBytes) !== current.manifestSha256) {
    throw new Error('IronCurtain CA generation manifest does not match current.json');
  }
  const manifest = parseGenerationManifest(manifestBytes);
  const certPath = join(generationDirectory, GENERATION_CERT_FILENAME);
  const keyPath = join(generationDirectory, GENERATION_KEY_FILENAME);
  const authority = loadAndVerifyAuthorityFiles(certPath, keyPath);
  verifyManifestFile(manifest.certificate, GENERATION_CERT_FILENAME, CERT_MODE, Buffer.from(authority.certPem));
  verifyManifestFile(manifest.privateKey, GENERATION_KEY_FILENAME, KEY_MODE, Buffer.from(authority.keyPem));
  return { generation: current.generation, ...authority };
}

function loadAndVerifyAuthorityFiles(certPath: string, keyPath: string): VerifiedCertificateAuthorityFiles {
  const certPem = readExactFile(certPath, CERT_MODE, 'certificate', MAX_CA_FILE_BYTES).toString('utf8');
  const keyPem = readExactFile(keyPath, KEY_MODE, 'private key', MAX_CA_FILE_BYTES).toString('utf8');
  const profile = verifyAuthority(certPem, keyPem);
  return { certPem, keyPem, certPath, keyPath, profile };
}

function withoutProfile(authority: VerifiedCertificateAuthority): CertificateAuthority {
  return {
    generation: authority.generation,
    certPem: authority.certPem,
    keyPem: authority.keyPem,
    certPath: authority.certPath,
    keyPath: authority.keyPath,
  };
}

function readExactFile(path: string, expectedMode: number, label: string, maximumBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    validateAuthorityFile(before, path, expectedMode, label, maximumBytes);
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const published = lstatSync(path);
    if (
      !sameIdentity(before, after) ||
      !sameIdentity(before, published) ||
      before.size !== after.size ||
      contents.length !== before.size
    ) {
      throw new Error(`IronCurtain CA ${label} changed while it was being read`);
    }
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function validateAuthorityFile(
  stats: Stats,
  path: string,
  expectedMode: number,
  label: string,
  maximumBytes: number,
): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`IronCurtain CA ${label} ${path} must be one unlinked regular file`);
  }
  const expectedUid = process.getuid?.();
  if (expectedUid !== undefined && stats.uid !== expectedUid) {
    throw new Error(`IronCurtain CA ${label} ${path} is not owned by the current user`);
  }
  if ((stats.mode & 0o777) !== expectedMode) {
    throw new Error(
      `IronCurtain CA ${label} ${path} has mode ${(stats.mode & 0o777).toString(8)}, expected ${expectedMode.toString(8)}`,
    );
  }
  if (stats.size <= 0 || stats.size > maximumBytes) {
    throw new Error(`IronCurtain CA ${label} ${path} is empty or exceeds ${maximumBytes} bytes`);
  }
}

function generateAndPublishCA(directory: string): VerifiedCertificateAuthority {
  logger.info('[ca] Generating IronCurtain MITM CA (first run)...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  return publishStrictAuthority(directory, keys.privateKey, false);
}

function publishStrictAuthorityWithExistingKey(
  directory: string,
  keyPem: string,
  replaceCurrent: boolean,
): VerifiedCertificateAuthority {
  return publishStrictAuthority(directory, forge.pki.privateKeyFromPem(keyPem), replaceCurrent);
}

function publishStrictAuthority(
  directory: string,
  privateKey: forge.pki.rsa.PrivateKey,
  replaceCurrent: boolean,
): VerifiedCertificateAuthority {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e);
  certificate.serialNumber = randomSerialNumber();
  const now = new Date();
  certificate.validity.notBefore = now;
  certificate.validity.notAfter = new Date(now.getTime() + CA_VALIDITY_MS);
  const attributes = [{ name: 'commonName', value: 'IronCurtain MITM CA' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  const subjectKeyIdentifier = certificate.generateSubjectKeyIdentifier().getBytes();
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: subjectKeyIdentifier },
  ]);
  certificate.sign(privateKey, forge.md.sha256.create());
  return publishGeneration(
    directory,
    forge.pki.certificateToPem(certificate),
    forge.pki.privateKeyToPem(privateKey),
    replaceCurrent,
  );
}

function publishGeneration(
  directory: string,
  certPem: string,
  keyPem: string,
  replaceCurrent: boolean,
): VerifiedCertificateAuthority {
  if (verifyAuthority(certPem, keyPem) !== 'strict-v2') {
    throw new Error('IronCurtain refuses to publish a legacy CA profile as current');
  }
  const generation = `gen-${randomUUID()}`;
  const generationsDirectory = ensureGenerationsDirectory(directory);
  const generationDirectory = join(generationsDirectory, generation);
  mkdirSync(generationDirectory, { mode: DIRECTORY_MODE });
  chmodSync(generationDirectory, DIRECTORY_MODE);
  const certPath = join(generationDirectory, GENERATION_CERT_FILENAME);
  const keyPath = join(generationDirectory, GENERATION_KEY_FILENAME);
  const publicationState = { currentPublished: false };
  try {
    const certBytes = Buffer.from(certPem);
    const keyBytes = Buffer.from(keyPem);
    writeDurableExclusiveFile(keyPath, keyBytes, KEY_MODE, 'private key', MAX_CA_FILE_BYTES);
    writeDurableExclusiveFile(certPath, certBytes, CERT_MODE, 'certificate', MAX_CA_FILE_BYTES);
    const generationManifest: GenerationManifest = {
      schemaVersion: 1,
      certificate: manifestFile(GENERATION_CERT_FILENAME, certBytes, '0644'),
      privateKey: manifestFile(GENERATION_KEY_FILENAME, keyBytes, '0600'),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(generationManifest, null, 2)}\n`);
    writeDurableExclusiveFile(
      join(generationDirectory, GENERATION_MANIFEST_FILENAME),
      manifestBytes,
      MANIFEST_MODE,
      'generation manifest',
      MAX_MANIFEST_BYTES,
    );
    fsyncDirectory(generationDirectory);
    loadAndVerifyAuthorityFiles(certPath, keyPath);
    verifyManifestFile(generationManifest.certificate, GENERATION_CERT_FILENAME, CERT_MODE, certBytes);
    verifyManifestFile(generationManifest.privateKey, GENERATION_KEY_FILENAME, KEY_MODE, keyBytes);

    const current: CurrentManifest = { schemaVersion: 1, generation, manifestSha256: sha256(manifestBytes) };
    publishCurrentManifest(directory, Buffer.from(`${JSON.stringify(current, null, 2)}\n`), replaceCurrent, () => {
      publicationState.currentPublished = true;
    });
    const published = loadCurrentAuthority(directory, join(directory, CURRENT_FILENAME));
    logger.info(`[ca] CA generation published at ${generationDirectory}`);
    return published;
  } catch (error) {
    if (!publicationState.currentPublished) removeGenerationDirectory(generationDirectory);
    throw error;
  }
}

function ensureGenerationsDirectory(directory: string): string {
  const path = join(directory, GENERATIONS_DIRECTORY);
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  validateAuthorityDirectory(lstatSync(path), path, false);
  hardenDirectoryMode(lstatSync(path), path);
  validateAuthorityDirectory(lstatSync(path), path, true);
  return path;
}

function publishCurrentManifest(
  directory: string,
  contents: Buffer,
  replaceCurrent: boolean,
  didRename: () => void,
): void {
  const currentPath = join(directory, CURRENT_FILENAME);
  const currentExists = pathExistsNoFollow(currentPath);
  if (replaceCurrent !== currentExists) {
    throw new Error(
      replaceCurrent
        ? 'IronCurtain CA current manifest disappeared during migration'
        : 'IronCurtain CA current manifest already exists',
    );
  }
  const temporaryPath = join(directory, `.current.json.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeDurableExclusiveFile(temporaryPath, contents, MANIFEST_MODE, 'current manifest', MAX_MANIFEST_BYTES);
    renameSync(temporaryPath, currentPath);
    didRename();
    fsyncDirectory(directory);
  } catch (error) {
    unlinkIfPresent(temporaryPath);
    throw error;
  }
}

function manifestFile(filename: string, contents: Buffer, mode: '0644' | '0600'): GenerationManifestFile {
  return { filename, sha256: sha256(contents), size: contents.length, mode };
}

function verifyManifestFile(
  observed: GenerationManifestFile,
  expectedFilename: string,
  expectedMode: number,
  contents: Buffer,
): void {
  if (
    observed.filename !== expectedFilename ||
    observed.mode !== expectedMode.toString(8).padStart(4, '0') ||
    observed.size !== contents.length ||
    observed.sha256 !== sha256(contents)
  ) {
    throw new Error(`IronCurtain CA generation metadata for ${expectedFilename} does not match its bytes`);
  }
}

function parseCurrentManifest(contents: Buffer): CurrentManifest {
  const value = parseJsonObject(contents, 'current manifest');
  if (!hasExactKeys(value, ['schemaVersion', 'generation', 'manifestSha256'])) {
    throw new Error('IronCurtain CA current manifest has an unsupported shape');
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.generation !== 'string' ||
    !GENERATION_PATTERN.test(value.generation) ||
    !isSha256(value.manifestSha256)
  ) {
    throw new Error('IronCurtain CA current manifest is invalid');
  }
  return { schemaVersion: 1, generation: value.generation, manifestSha256: value.manifestSha256 };
}

function parseGenerationManifest(contents: Buffer): GenerationManifest {
  const value = parseJsonObject(contents, 'generation manifest');
  if (!hasExactKeys(value, ['schemaVersion', 'certificate', 'privateKey']) || value.schemaVersion !== 1) {
    throw new Error('IronCurtain CA generation manifest has an unsupported shape');
  }
  const certificate = parseManifestFile(value.certificate, GENERATION_CERT_FILENAME, '0644');
  const privateKey = parseManifestFile(value.privateKey, GENERATION_KEY_FILENAME, '0600');
  return { schemaVersion: 1, certificate, privateKey };
}

function parseManifestFile(value: unknown, filename: string, mode: '0644' | '0600'): GenerationManifestFile {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ['filename', 'sha256', 'size', 'mode'])
  ) {
    throw new Error(`IronCurtain CA generation metadata for ${filename} has an unsupported shape`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.filename !== filename ||
    !isSha256(record.sha256) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) <= 0 ||
    (record.size as number) > MAX_CA_FILE_BYTES ||
    record.mode !== mode
  ) {
    throw new Error(`IronCurtain CA generation metadata for ${filename} is invalid`);
  }
  return { filename, sha256: record.sha256, size: record.size as number, mode };
}

function parseJsonObject(contents: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(`IronCurtain CA ${label} is not valid JSON`, { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`IronCurtain CA ${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const observed = Object.keys(record).sort();
  const expected = [...keys].sort();
  return observed.length === expected.length && observed.every((key, index) => key === expected[index]);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function cleanupInterruptedCurrentTemps(directory: string): void {
  for (const path of validateInterruptedCurrentTemps(directory)) unlinkSync(path);
  fsyncDirectory(directory);
}

function validateInterruptedCurrentTemps(directory: string): string[] {
  const paths: string[] = [];
  for (const name of readdirSync(directory)) {
    if (!CURRENT_TEMP_PATTERN.test(name)) continue;
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error(`IronCurtain CA interrupted current publication is not a regular file: ${path}`);
    }
    paths.push(path);
  }
  return paths;
}

function cleanupUnreachableGenerations(directory: string): void {
  for (const path of validateUnreachableGenerations(directory)) removeGenerationDirectory(path);
  const generationsDirectory = join(directory, GENERATIONS_DIRECTORY);
  if (pathExistsNoFollow(generationsDirectory)) fsyncDirectory(generationsDirectory);
}

function validateUnreachableGenerations(directory: string): string[] {
  const generationsDirectory = join(directory, GENERATIONS_DIRECTORY);
  if (!pathExistsNoFollow(generationsDirectory)) return [];
  validateAuthorityDirectory(lstatSync(generationsDirectory), generationsDirectory, true);
  const paths: string[] = [];
  for (const name of readdirSync(generationsDirectory)) {
    const path = join(generationsDirectory, name);
    if (!GENERATION_PATTERN.test(name)) {
      throw new Error(`IronCurtain CA generations directory contains an unknown entry: ${name}`);
    }
    validateRemovableGenerationDirectory(path);
    paths.push(path);
  }
  return paths;
}

function removeGenerationDirectory(path: string): void {
  validateRemovableGenerationDirectory(path);
  rmSync(path, { recursive: true });
}

function validateRemovableGenerationDirectory(path: string): void {
  const stats = lstatSync(path);
  validateAuthorityDirectory(stats, path, true);
  for (const name of readdirSync(path)) {
    if (![GENERATION_CERT_FILENAME, GENERATION_KEY_FILENAME, GENERATION_MANIFEST_FILENAME].includes(name)) {
      throw new Error(`IronCurtain CA unreachable generation contains an unknown entry: ${name}`);
    }
    const child = join(path, name);
    const childStats = lstatSync(child);
    if (!childStats.isFile() || childStats.isSymbolicLink() || childStats.nlink !== 1) {
      throw new Error(`IronCurtain CA unreachable generation contains an unsafe entry: ${child}`);
    }
  }
}

function cleanupLegacyMigrationRemainder(directory: string, current: CertificateAuthority): void {
  const remainder = validateLegacyMigrationRemainder(directory, current);
  if (remainder.certPath !== undefined) unlinkSync(remainder.certPath);
  if (remainder.keyPath !== undefined) unlinkSync(remainder.keyPath);
  fsyncDirectory(directory);
}

function validateLegacyMigrationRemainder(
  directory: string,
  current: CertificateAuthority,
): { readonly certPath?: string; readonly keyPath?: string } {
  const certPath = join(directory, LEGACY_CERT_FILENAME);
  const keyPath = join(directory, LEGACY_KEY_FILENAME);
  const certExists = pathExistsNoFollow(certPath);
  const keyExists = pathExistsNoFollow(keyPath);
  if (!certExists && !keyExists) return {};
  if (certExists) {
    const legacyCertPem = readExactFile(certPath, CERT_MODE, 'legacy certificate', MAX_CA_FILE_BYTES).toString('utf8');
    if (legacyCertPem !== current.certPem) {
      let profile: AuthorityProfile;
      try {
        profile = verifyAuthority(legacyCertPem, current.keyPem);
      } catch (error) {
        throw new Error('IronCurtain CA legacy certificate conflicts with the current generation', { cause: error });
      }
      if (profile !== 'legacy-v1' || verifyAuthority(current.certPem, current.keyPem) !== 'strict-v2') {
        throw new Error('IronCurtain CA legacy certificate conflicts with the current generation');
      }
    }
  }
  if (
    keyExists &&
    readExactFile(keyPath, KEY_MODE, 'legacy private key', MAX_CA_FILE_BYTES).toString('utf8') !== current.keyPem
  ) {
    throw new Error('IronCurtain CA legacy private key conflicts with the current generation');
  }
  return {
    ...(certExists ? { certPath } : {}),
    ...(keyExists ? { keyPath } : {}),
  };
}

function removeExactLegacyPair(authority: CertificateAuthorityFiles): void {
  const certIdentity = identity(lstatSync(authority.certPath));
  const keyIdentity = identity(lstatSync(authority.keyPath));
  unlinkExactPath(authority.certPath, certIdentity);
  unlinkExactPath(authority.keyPath, keyIdentity);
}

function unlinkExactPath(path: string, expected: FileIdentity): void {
  const current = lstatSync(path);
  if (!sameIdentity(current, expected)) throw new Error(`IronCurtain CA path identity changed before unlink: ${path}`);
  unlinkSync(path);
}

function writeDurableExclusiveFile(
  path: string,
  contents: Buffer,
  mode: number,
  label: string,
  maximumBytes: number,
): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    const stats = fstatSync(descriptor);
    validateAuthorityFile(stats, path, mode, label, maximumBytes);
    if (stats.size !== contents.length) throw new Error(`IronCurtain CA ${label} temporary write was incomplete`);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function pathExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function identity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function assertPathIdentity(path: string, expected: FileIdentity, label: string): void {
  if (!sameIdentity(lstatSync(path), expected)) {
    throw new Error(`IronCurtain CA ${label} changed during repair: ${path}`);
  }
}

function sameIdentity(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifyAuthority(certPem: string, keyPem: string): AuthorityProfile {
  let certificate: forge.pki.Certificate;
  let privateKey: forge.pki.rsa.PrivateKey;
  try {
    certificate = forge.pki.certificateFromPem(certPem);
    privateKey = forge.pki.privateKeyFromPem(keyPem);
  } catch (error) {
    throw new Error('IronCurtain CA certificate or private key is not valid PEM', { cause: error });
  }

  const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;
  if (publicKey.n.compareTo(privateKey.n) !== 0 || publicKey.e.compareTo(privateKey.e) !== 0) {
    throw new Error('IronCurtain CA certificate and private key do not match');
  }
  if (publicKey.n.bitLength() < 2048) throw new Error('IronCurtain CA RSA key is smaller than 2048 bits');
  if (!certificate.isIssuer(certificate) || !certificate.verify(certificate)) {
    throw new Error('IronCurtain CA certificate is not self-signed');
  }
  if (!hasExactAuthorityName(certificate.subject.attributes) || !hasExactAuthorityName(certificate.issuer.attributes)) {
    throw new Error('IronCurtain CA certificate has an unexpected subject or issuer');
  }
  if (certificate.version !== 2 || certificate.signatureOid !== forge.pki.oids.sha256WithRSAEncryption) {
    throw new Error('IronCurtain CA certificate uses an unsupported version or signature algorithm');
  }
  const now = Date.now();
  const notBefore = certificate.validity.notBefore.getTime();
  const notAfter = certificate.validity.notAfter.getTime();
  if (
    !Number.isFinite(notBefore) ||
    !Number.isFinite(notAfter) ||
    notBefore > now ||
    notAfter - now < MIN_REMAINING_VALIDITY_MS ||
    notAfter <= notBefore ||
    notAfter - notBefore > CA_VALIDITY_MS + 60_000
  ) {
    throw new Error('IronCurtain CA certificate is outside its accepted validity window');
  }
  return classifyAuthorityProfile(certificate);
}

function hasExactAuthorityName(attributes: unknown): boolean {
  if (!Array.isArray(attributes)) return false;
  if (attributes.length !== 1) return false;
  const entry: unknown = attributes[0];
  return (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    'name' in entry &&
    entry.name === 'commonName' &&
    'value' in entry &&
    entry.value === 'IronCurtain MITM CA'
  );
}

interface ParsedCertificateExtension {
  readonly id: string;
  readonly critical: boolean;
  readonly value: string;
  readonly subjectKeyIdentifier?: string;
}

function classifyAuthorityProfile(certificate: forge.pki.Certificate): AuthorityProfile {
  const extensions = new Map<string, ParsedCertificateExtension>();
  for (const rawExtension of certificate.extensions as unknown[]) {
    if (typeof rawExtension !== 'object' || rawExtension === null || Array.isArray(rawExtension)) {
      throw new Error('IronCurtain CA certificate has a malformed extension');
    }
    const extension = rawExtension as Record<string, unknown>;
    if (
      typeof extension.id !== 'string' ||
      typeof extension.critical !== 'boolean' ||
      typeof extension.value !== 'string' ||
      extensions.has(extension.id)
    ) {
      throw new Error('IronCurtain CA certificate has a malformed or duplicate extension');
    }
    extensions.set(extension.id, {
      id: extension.id,
      critical: extension.critical,
      value: extension.value,
      ...(typeof extension.subjectKeyIdentifier === 'string'
        ? { subjectKeyIdentifier: extension.subjectKeyIdentifier }
        : {}),
    });
  }

  const basicConstraints = extensions.get(BASIC_CONSTRAINTS_OID);
  const keyUsage = extensions.get(KEY_USAGE_OID);
  const legacyProfile =
    extensions.size === 2 &&
    basicConstraints?.critical === false &&
    bytesToHex(basicConstraints.value) === '30030101ff' &&
    keyUsage?.critical === false &&
    bytesToHex(keyUsage.value) === '03020106';
  if (legacyProfile) return 'legacy-v1';

  const subjectKeyIdentifier = extensions.get(SUBJECT_KEY_IDENTIFIER_OID);
  const authorityKeyIdentifier = extensions.get(AUTHORITY_KEY_IDENTIFIER_OID);
  const strictExtensionCount = authorityKeyIdentifier === undefined ? 3 : 4;
  if (
    extensions.size !== strictExtensionCount ||
    basicConstraints?.critical !== true ||
    bytesToHex(basicConstraints.value) !== '30060101ff020100' ||
    keyUsage?.critical !== true ||
    bytesToHex(keyUsage.value) !== '03020106' ||
    subjectKeyIdentifier?.critical !== false ||
    !certificate.verifySubjectKeyIdentifier()
  ) {
    throw new Error('IronCurtain CA certificate does not match the legacy-v1 or strict-v2 profile');
  }
  const subjectKeyIdentifierHex = subjectKeyIdentifier.subjectKeyIdentifier;
  if (
    subjectKeyIdentifierHex === undefined ||
    !/^[0-9a-f]{40}$/u.test(subjectKeyIdentifierHex) ||
    bytesToHex(subjectKeyIdentifier.value) !== `0414${subjectKeyIdentifierHex}`
  ) {
    throw new Error('IronCurtain CA certificate has an invalid subject key identifier');
  }
  if (
    authorityKeyIdentifier !== undefined &&
    (authorityKeyIdentifier.critical ||
      parseAuthorityKeyIdentifier(authorityKeyIdentifier.value) !== subjectKeyIdentifierHex)
  ) {
    throw new Error('IronCurtain CA certificate authority key identifier does not match its subject key identifier');
  }
  return 'strict-v2';
}

function parseAuthorityKeyIdentifier(value: string): string | undefined {
  let parsed: forge.asn1.Asn1;
  try {
    parsed = forge.asn1.fromDer(value);
  } catch {
    return undefined;
  }
  if (
    parsed.tagClass !== forge.asn1.Class.UNIVERSAL ||
    parsed.type !== forge.asn1.Type.SEQUENCE ||
    !parsed.constructed ||
    !Array.isArray(parsed.value) ||
    parsed.value.length !== 1
  ) {
    return undefined;
  }
  const keyIdentifier = parsed.value[0];
  if (
    keyIdentifier.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC ||
    keyIdentifier.type !== forge.asn1.Type.NONE ||
    keyIdentifier.constructed ||
    typeof keyIdentifier.value !== 'string'
  ) {
    return undefined;
  }
  return bytesToHex(keyIdentifier.value);
}

function bytesToHex(value: string): string {
  return forge.util.bytesToHex(value);
}

/** Generates a random positive, minimally encoded 16-byte serial number. */
export function randomSerialNumber(): string {
  const hex = forge.util.bytesToHex(forge.random.getBytesSync(16));
  let first = parseInt(hex.slice(0, 2), 16) & 0x7f;
  if (first === 0) first = 0x01;
  return first.toString(16).padStart(2, '0') + hex.slice(2);
}

/** Create the shared per-host leaf-certificate cache used by TLS-terminating proxies. */
export function createLeafSecureContextCache(ca: CertificateAuthority): (hostname: string) => tls.SecureContext {
  const caCertificate = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  if (verifyAuthority(ca.certPem, ca.keyPem) !== 'strict-v2') {
    throw new Error('IronCurtain leaf certificate issuance requires the strict-v2 CA profile');
  }
  const cache = new Map<string, { readonly context: tls.SecureContext; readonly expiresAt: number }>();

  return (hostname) => {
    const cached = cache.get(hostname);
    if (cached !== undefined && cached.expiresAt - Date.now() > LEAF_RENEWAL_MARGIN_MS) return cached.context;

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = randomSerialNumber();
    const now = Date.now();
    const notBefore = Math.max(now, caCertificate.validity.notBefore.getTime());
    const expiresAt = Math.min(now + LEAF_VALIDITY_MS, caCertificate.validity.notAfter.getTime());
    if (expiresAt <= notBefore) {
      throw new Error('IronCurtain CA validity does not contain a usable leaf certificate window');
    }
    certificate.validity.notBefore = new Date(notBefore);
    certificate.validity.notAfter = new Date(expiresAt);
    certificate.setSubject([{ name: 'commonName', value: hostname }]);
    certificate.setIssuer(caCertificate.subject.attributes);
    certificate.setExtensions([
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectKeyIdentifier' },
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: caCertificate.generateSubjectKeyIdentifier().getBytes(),
      },
    ]);
    certificate.sign(caKey, forge.md.sha256.create());
    const context = tls.createSecureContext({
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(certificate),
    });
    cache.set(hostname, { context, expiresAt });
    return context;
  };
}
