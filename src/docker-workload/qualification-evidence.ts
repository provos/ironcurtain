/** Canonical, exact-set evidence root for one concrete backend qualification. */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { stableStringify } from '../hash.js';

export const QUALIFICATION_EVIDENCE_SCHEMA_VERSION = 1;
export const QUALIFICATION_EVIDENCE_ROOT_FILE = 'root-manifest.json';
export const MIN_CLEANUP_INVENTORY_SEPARATION_MS = 100;
export const MAX_QUALIFICATION_EVIDENCE_FILE_BYTES = 128 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);
const relativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'evidence path must be a canonical safe relative path',
  );

const evidenceBindingsSchema = z
  .object({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    dirtyPatchSha256: sha256Schema.nullable(),
    qualificationContractSha256: sha256Schema,
    profileCeilingSha256: sha256Schema,
    generatedProfileSha256: sha256Schema,
    preloadedCatalogSha256: sha256Schema,
    performanceBudgetSha256: sha256Schema,
    clientToolchainSha256: sha256Schema,
    relayBinarySha256: sha256Schema.nullable(),
    relayConfigSha256: sha256Schema.nullable(),
    relayEndpointSha256: sha256Schema.nullable(),
    watchdogPolicySha256: sha256Schema,
    buildEgressManifestSha256: sha256Schema,
  })
  .strict();

const evidencePlanEntrySchema = z.object({ id: identifierSchema, path: relativePathSchema }).strict();
const evidenceFileEntrySchema = evidencePlanEntrySchema
  .extend({ sha256: sha256Schema, sizeBytes: z.number().int().positive().max(MAX_QUALIFICATION_EVIDENCE_FILE_BYTES) })
  .strict();

const qualificationEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(QUALIFICATION_EVIDENCE_SCHEMA_VERSION),
    runId: identifierSchema,
    variant: identifierSchema,
    platform: z.enum(['docker-desktop', 'apple-container', 'linux-docker']),
    architecture: z.enum(['amd64', 'arm64']),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }),
    cleanupInventorySeparationMs: z.literal(MIN_CLEANUP_INVENTORY_SEPARATION_MS),
    bindings: evidenceBindingsSchema,
    files: z.array(evidenceFileEntrySchema).min(1).max(20_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(
      manifest.files.map((entry) => entry.id),
      'evidence ID',
      context,
    );
    addDuplicateIssues(
      manifest.files.map((entry) => entry.path),
      'evidence path',
      context,
    );
    if (Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)) {
      context.addIssue({ code: 'custom', message: 'evidence completion precedes start' });
    }
  });

const cleanupInventorySchema = z
  .object({
    schemaVersion: z.literal(QUALIFICATION_EVIDENCE_SCHEMA_VERSION),
    runId: identifierSchema,
    variant: identifierSchema,
    ordinal: z.union([z.literal(1), z.literal(2)]),
    observedAt: z.iso.datetime({ offset: true }),
    resources: z.array(z.never()).length(0),
  })
  .strict();

export type QualificationEvidenceBindings = z.infer<typeof evidenceBindingsSchema>;
export type QualificationEvidencePlanEntry = z.infer<typeof evidencePlanEntrySchema>;
export type QualificationEvidenceManifest = z.infer<typeof qualificationEvidenceManifestSchema>;

export interface LoadedQualificationEvidenceManifest {
  readonly path: string;
  readonly sha256: string;
  readonly manifest: QualificationEvidenceManifest;
}

export interface QualificationEvidencePlan {
  readonly runId: string;
  readonly variant: string;
  readonly platform: QualificationEvidenceManifest['platform'];
  readonly architecture: QualificationEvidenceManifest['architecture'];
  readonly bindings: QualificationEvidenceBindings;
  readonly files: readonly QualificationEvidencePlanEntry[];
}

/** Seal an already-populated private evidence directory against an independent exact file plan. */
export function writeQualificationEvidenceManifest(
  root: string,
  plan: QualificationEvidencePlan & { readonly startedAt: string; readonly completedAt: string },
): LoadedQualificationEvidenceManifest {
  validateRoot(root);
  if (existsSync(join(root, QUALIFICATION_EVIDENCE_ROOT_FILE))) {
    throw new Error('qualification evidence root manifest already exists');
  }
  const validatedPlan = validatePlan(plan);
  assertExactFileSet(
    root,
    validatedPlan.files.map((entry) => entry.path),
  );
  validateCleanupInventories(root, validatedPlan);
  const files = validatedPlan.files
    .map((entry) => ({ ...entry, ...hashEvidenceFile(root, entry.path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = qualificationEvidenceManifestSchema.parse({
    schemaVersion: QUALIFICATION_EVIDENCE_SCHEMA_VERSION,
    runId: validatedPlan.runId,
    variant: validatedPlan.variant,
    platform: validatedPlan.platform,
    architecture: validatedPlan.architecture,
    startedAt: plan.startedAt,
    completedAt: plan.completedAt,
    cleanupInventorySeparationMs: MIN_CLEANUP_INVENTORY_SEPARATION_MS,
    bindings: validatedPlan.bindings,
    files,
  });
  const path = join(root, QUALIFICATION_EVIDENCE_ROOT_FILE);
  writeCanonicalFileAtomic(path, manifest);
  return loadQualificationEvidenceManifest(path);
}

/** Verify hashes and prove the manifest still matches the trusted external evidence plan. */
export function verifyQualificationEvidence(
  root: string,
  expected: QualificationEvidencePlan,
): LoadedQualificationEvidenceManifest {
  validateRoot(root);
  const validatedExpected = validatePlan(expected);
  const loaded = loadQualificationEvidenceManifest(join(root, QUALIFICATION_EVIDENCE_ROOT_FILE));
  const manifest = loaded.manifest;
  for (const field of ['runId', 'variant', 'platform', 'architecture'] as const) {
    if (manifest[field] !== validatedExpected[field]) {
      throw new Error(`qualification evidence ${field} differs from the trusted plan`);
    }
  }
  if (stableStringify(manifest.bindings) !== stableStringify(validatedExpected.bindings)) {
    throw new Error('qualification evidence bindings differ from the trusted plan');
  }
  const expectedFiles = [...validatedExpected.files].sort((left, right) => left.path.localeCompare(right.path));
  if (stableStringify(manifest.files.map(({ id, path }) => ({ id, path }))) !== stableStringify(expectedFiles)) {
    throw new Error('qualification evidence IDs/paths differ from the trusted plan');
  }
  assertExactFileSet(
    root,
    manifest.files.map((entry) => entry.path),
  );
  for (const entry of manifest.files) {
    const actual = hashEvidenceFile(root, entry.path);
    if (actual.sha256 !== entry.sha256 || actual.sizeBytes !== entry.sizeBytes) {
      throw new Error(`qualification evidence hash/size mismatch: ${entry.path}`);
    }
  }
  validateCleanupInventories(root, manifest);
  return loaded;
}

export function loadQualificationEvidenceManifest(path: string): LoadedQualificationEvidenceManifest {
  const bytes = readRegularPrivateFile(path, MAX_QUALIFICATION_EVIDENCE_FILE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('qualification evidence root manifest is not valid JSON', { cause: error });
  }
  const validated = qualificationEvidenceManifestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `qualification evidence root manifest is invalid: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  const canonical = `${stableStringify(validated.data)}\n`;
  if (!bytes.equals(Buffer.from(canonical, 'utf8'))) {
    throw new Error('qualification evidence root manifest is not canonical JSON');
  }
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    manifest: validated.data,
  };
}

function validatePlan<T extends QualificationEvidencePlan>(plan: T): T {
  const parsed = z
    .object({
      runId: identifierSchema,
      variant: identifierSchema,
      platform: z.enum(['docker-desktop', 'apple-container', 'linux-docker']),
      architecture: z.enum(['amd64', 'arm64']),
      bindings: evidenceBindingsSchema,
      files: z.array(evidencePlanEntrySchema).min(1).max(20_000),
    })
    .strict()
    .safeParse({
      runId: plan.runId,
      variant: plan.variant,
      platform: plan.platform,
      architecture: plan.architecture,
      bindings: plan.bindings,
      files: plan.files,
    });
  if (!parsed.success) throw new Error(`qualification evidence plan is invalid: ${parsed.error.issues[0]?.message}`);
  const ids = parsed.data.files.map((entry) => entry.id);
  const paths = parsed.data.files.map((entry) => entry.path);
  if (new Set(ids).size !== ids.length) throw new Error('qualification evidence plan contains a duplicate ID');
  if (new Set(paths).size !== paths.length) throw new Error('qualification evidence plan contains a duplicate path');
  for (const required of ['cleanup/inventory-1.json', 'cleanup/inventory-2.json']) {
    if (!paths.includes(required)) throw new Error(`qualification evidence plan is missing ${required}`);
  }
  return plan;
}

function validateRoot(root: string): void {
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error('qualification evidence root must be canonical and absolute');
  }
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('qualification evidence root must be a real directory');
  }
  if ((stats.mode & 0o077) !== 0) throw new Error('qualification evidence root must be owner-only');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('qualification evidence root must be owned by the current user');
  }
}

function assertExactFileSet(root: string, expected: readonly string[]): void {
  const actual = listEvidenceFiles(root);
  const sortedExpected = [...expected].sort();
  if (stableStringify(actual) !== stableStringify(sortedExpected)) {
    throw new Error('qualification evidence has missing or unexpected files');
  }
}

function listEvidenceFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join('/');
      if (relativePath === QUALIFICATION_EVIDENCE_ROOT_FILE) continue;
      if (entry.isSymbolicLink()) throw new Error(`qualification evidence symlink is forbidden: ${relativePath}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`qualification evidence special file is forbidden: ${relativePath}`);
    }
  };
  visit(root);
  return files.sort();
}

function hashEvidenceFile(root: string, relativePath: string): { readonly sha256: string; readonly sizeBytes: number } {
  const path = resolve(root, relativePath);
  const resolvedRelative = relative(root, path).split(sep).join('/');
  if (resolvedRelative !== relativePath) throw new Error(`qualification evidence path escapes root: ${relativePath}`);
  const bytes = readRegularPrivateFile(path, MAX_QUALIFICATION_EVIDENCE_FILE_BYTES);
  if (containsSecretMarker(bytes)) throw new Error(`qualification evidence contains a secret marker: ${relativePath}`);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
}

function readRegularPrivateFile(path: string, maximumBytes: number): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`qualification evidence must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error(`qualification evidence is not a regular file: ${path}`);
    if ((stats.mode & 0o077) !== 0) throw new Error(`qualification evidence file must be owner-only: ${path}`);
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      throw new Error(`qualification evidence file must be owned by the current user: ${path}`);
    }
    if (stats.size < 1 || stats.size > maximumBytes) {
      throw new Error(`qualification evidence file size is outside the allowed range: ${path}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validateCleanupInventories(
  root: string,
  identity: { readonly runId: string; readonly variant: string },
): void {
  const inventories = [1, 2].map((ordinal) => {
    const path = join(root, 'cleanup', `inventory-${ordinal}.json`);
    const bytes = readRegularPrivateFile(path, MAX_QUALIFICATION_EVIDENCE_FILE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new Error(`cleanup inventory ${ordinal} is not valid JSON`, { cause: error });
    }
    const validated = cleanupInventorySchema.safeParse(parsed);
    if (!validated.success) throw new Error(`cleanup inventory ${ordinal} is invalid or nonempty`);
    if (
      validated.data.ordinal !== ordinal ||
      validated.data.runId !== identity.runId ||
      validated.data.variant !== identity.variant
    ) {
      throw new Error(`cleanup inventory ${ordinal} identity mismatch`);
    }
    return validated.data;
  });
  if (
    Date.parse(inventories[1].observedAt) - Date.parse(inventories[0].observedAt) <
    MIN_CLEANUP_INVENTORY_SEPARATION_MS
  ) {
    throw new Error('cleanup inventories are not sufficiently separated');
  }
}

function containsSecretMarker(bytes: Buffer): boolean {
  const text = bytes.toString('utf8');
  return (
    /sk-ant-[a-z0-9_-]+/iu.test(text) ||
    /AKIA[0-9A-Z]{16}/u.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text) ||
    /ic-qualification-secret-fixture/iu.test(text)
  );
}

function writeCanonicalFileAtomic(path: string, value: unknown): void {
  const serialized = stableStringify(value);
  if (serialized === undefined) throw new Error('qualification evidence manifest is not serializable');
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${serialized}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o400);
    renameSync(temporary, path);
    const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function addDuplicateIssues(values: readonly string[], label: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) context.addIssue({ code: 'custom', message: `duplicate ${label}: ${value}` });
    seen.add(value);
  }
}
