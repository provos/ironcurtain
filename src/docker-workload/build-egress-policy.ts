/** Frozen, current-Dockerfile-only authorization for nested build egress. */

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { z } from 'zod';

export const BUILD_EGRESS_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_BUILD_EGRESS_MANIFEST_BYTES = 1024 * 1024;

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
  .refine(
    (value) => value === value.toLowerCase() && !value.includes('..'),
    'hostname must be canonical lowercase DNS',
  );
const headerNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);
const sourcePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      posix.normalize(value) === value &&
      !value.split('/').includes('..') &&
      value.startsWith('docker/Dockerfile'),
    'build-egress source must be a canonical Dockerfile path',
  );
const originPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('?') && !value.includes('#'),
    'build-egress path pattern must be an origin pathname without query or fragment',
  );

const pathRuleSchema = z
  .object({
    kind: z.enum(['exact', 'prefix']),
    value: originPathSchema,
    allowQuery: z.boolean(),
  })
  .strict();

const buildEgressRuleSchema = z
  .object({
    id: identifierSchema,
    seams: z
      .array(z.enum(['dockerfile-frontend', 'base-image', 'run']))
      .min(1)
      .max(3),
    destination: z
      .object({
        protocol: z.enum(['http:', 'https:']),
        hostname: hostnameSchema,
        port: z.number().int().min(1).max(65_535),
        addressPolicy: z.enum(['fixed-parent-only', 'public-direct']),
      })
      .strict(),
    methods: z
      .array(z.enum(['GET', 'HEAD']))
      .min(1)
      .max(2),
    paths: z.array(pathRuleSchema).min(1).max(128),
    redirects: z
      .object({
        maxHops: z.number().int().min(0).max(5),
        allowedRuleIds: z.array(identifierSchema).max(64),
      })
      .strict(),
    requestHeaders: z
      .object({
        allow: z.array(headerNameSchema).max(128),
        strip: z.array(headerNameSchema).max(128),
      })
      .strict(),
    limits: z
      .object({
        responseBytes: z
          .number()
          .int()
          .positive()
          .max(8 * 1024 * 1024 * 1024),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30 * 60_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((rule, context) => {
    addDuplicateIssues(rule.seams, 'seam', context);
    addDuplicateIssues(rule.methods, 'method', context);
    addDuplicateIssues(rule.redirects.allowedRuleIds, 'redirect rule', context);
    addDuplicateIssues(rule.requestHeaders.allow, 'allowed header', context);
    addDuplicateIssues(rule.requestHeaders.strip, 'stripped header', context);
    const overlappingHeaders = rule.requestHeaders.allow.filter((name) => rule.requestHeaders.strip.includes(name));
    if (overlappingHeaders.length > 0) {
      context.addIssue({
        code: 'custom',
        message: `headers cannot be both allowed and stripped: ${overlappingHeaders[0]}`,
      });
    }
    if (rule.redirects.maxHops === 0 && rule.redirects.allowedRuleIds.length !== 0) {
      context.addIssue({ code: 'custom', message: 'zero-hop rule cannot authorize redirect targets' });
    }
    if (rule.redirects.maxHops > 0 && rule.redirects.allowedRuleIds.length === 0) {
      context.addIssue({ code: 'custom', message: 'redirecting rule requires at least one allowed target rule' });
    }
    for (const path of rule.paths) {
      if (path.kind === 'prefix' && !path.value.endsWith('/')) {
        context.addIssue({ code: 'custom', message: 'prefix path must end with a slash boundary' });
      }
    }
  });

const buildEgressManifestSchema = z
  .object({
    schemaVersion: z.literal(BUILD_EGRESS_MANIFEST_SCHEMA_VERSION),
    policyId: identifierSchema,
    sourceDockerfiles: z
      .array(z.object({ path: sourcePathSchema, sha256: sha256Schema }).strict())
      .min(1)
      .max(64),
    rules: z.array(buildEgressRuleSchema).min(1).max(512),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(
      manifest.sourceDockerfiles.map((source) => source.path),
      'Dockerfile source path',
      context,
    );
    const ruleIds = manifest.rules.map((rule) => rule.id);
    addDuplicateIssues(ruleIds, 'build-egress rule ID', context);
    const known = new Set(ruleIds);
    for (const rule of manifest.rules) {
      for (const target of rule.redirects.allowedRuleIds) {
        if (!known.has(target)) {
          context.addIssue({ code: 'custom', message: `redirect rule ${rule.id} references unknown target ${target}` });
        }
      }
    }
  });

export type BuildEgressManifest = z.infer<typeof buildEgressManifestSchema>;
export type BuildEgressRule = BuildEgressManifest['rules'][number];

declare const validatedBuildEgressManifestBrand: unique symbol;

/**
 * A {@link BuildEgressManifest} that has passed `buildEgressManifestSchema`
 * validation. The brand lets the per-request hot path
 * ({@link authorizeValidatedBuildEgressRequest}) skip re-parsing while keeping
 * the raw-object entry ({@link authorizeBuildEgressRequest}) fail-closed for
 * untrusted callers. Only {@link validateBuildEgressManifest},
 * {@link loadBuildEgressManifest}, and the parsing entry produce this type.
 */
export type ValidatedBuildEgressManifest = BuildEgressManifest & {
  readonly [validatedBuildEgressManifestBrand]: true;
};

/** Parse-and-brand a manifest once. The single validation seam for the hot path. */
export function validateBuildEgressManifest(manifest: BuildEgressManifest): ValidatedBuildEgressManifest {
  return buildEgressManifestSchema.parse(manifest) as ValidatedBuildEgressManifest;
}

export interface LoadedBuildEgressManifest {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly manifest: ValidatedBuildEgressManifest;
}

export interface BuildEgressRequest {
  readonly seam: BuildEgressRule['seams'][number];
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Previously authorized rule IDs, in redirect traversal order. */
  readonly redirectChain?: readonly string[];
}

export interface AuthorizedBuildEgressRequest {
  readonly policyId: string;
  readonly ruleId: string;
  readonly destination: BuildEgressRule['destination'];
  readonly method: 'GET' | 'HEAD';
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly responseBytes: number;
  readonly timeoutMs: number;
  readonly redirectChain: readonly string[];
}

const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-api-key',
]);

export function loadBuildEgressManifest(path: string): LoadedBuildEgressManifest {
  if (!isAbsolute(path)) throw new Error('build-egress manifest path must be absolute');
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`build-egress manifest must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('build-egress manifest must be a regular file');
    if ((stats.mode & 0o022) !== 0) throw new Error('build-egress manifest must not be group/world writable');
    if (stats.size < 2 || stats.size > MAX_BUILD_EGRESS_MANIFEST_BYTES) {
      throw new Error(`build-egress manifest size is outside the allowed range: ${stats.size}`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('build-egress manifest is not valid JSON', { cause: error });
  }
  const validated = buildEgressManifestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`build-egress manifest is invalid: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    manifest: validated.data as ValidatedBuildEgressManifest,
  };
}

/** Prove every frozen source is the exact regular file reviewed by the manifest. */
export function verifyBuildEgressDockerfileSources(
  manifest: BuildEgressManifest,
  repositoryRoot: string,
): readonly { readonly path: string; readonly sha256: string; readonly sizeBytes: number }[] {
  const validated = buildEgressManifestSchema.parse(manifest);
  if (!isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot) {
    throw new Error('build-egress repository root must be canonical and absolute');
  }
  return validated.sourceDockerfiles.map((source) => {
    const path = resolve(repositoryRoot, source.path);
    const relativePath = relative(repositoryRoot, path).split('\\').join('/');
    if (relativePath !== source.path || relativePath.startsWith('../') || isAbsolute(relativePath)) {
      throw new Error(`build-egress Dockerfile source escapes repository: ${source.path}`);
    }
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new Error(`build-egress Dockerfile must be a readable regular non-symlink file: ${source.path}`, {
        cause: error,
      });
    }
    let bytes: Buffer;
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) throw new Error(`build-egress source is not a regular file: ${source.path}`);
      bytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== source.sha256) throw new Error(`build-egress Dockerfile hash mismatch: ${source.path}`);
    return { path: source.path, sha256, sizeBytes: bytes.length };
  });
}

/**
 * Resolve one request to exactly one rule; ambiguity and undeclared behavior
 * fail closed. Validates the manifest first, so it is safe for untrusted
 * (unvalidated) callers. The per-request proxy hot path holds a pre-validated
 * manifest and calls {@link authorizeValidatedBuildEgressRequest} instead, so
 * the schema is not re-parsed on every build fetch.
 */
export function authorizeBuildEgressRequest(
  manifest: BuildEgressManifest,
  request: BuildEgressRequest,
): AuthorizedBuildEgressRequest {
  return authorizeValidatedBuildEgressRequest(validateBuildEgressManifest(manifest), request);
}

/** Resolve one request against an already-validated manifest; no per-request re-parse. */
export function authorizeValidatedBuildEgressRequest(
  validated: ValidatedBuildEgressManifest,
  request: BuildEgressRequest,
): AuthorizedBuildEgressRequest {
  const method = request.method.toUpperCase();
  if (method !== request.method || (method !== 'GET' && method !== 'HEAD')) {
    throw new Error('build-egress method must be canonical GET or HEAD');
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    throw new Error('build-egress request URL is invalid', { cause: error });
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('build-egress request URL must not contain credentials or a fragment');
  }
  if (/%(?:2f|5c|25)/iu.test(url.pathname)) {
    throw new Error('build-egress request path contains an encoded separator or nested escape');
  }
  const port =
    url.port === '' ? (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0) : Number(url.port);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !Number.isSafeInteger(port) || port <= 0) {
    throw new Error('build-egress request must use explicit HTTP semantics');
  }
  const matches = validated.rules.filter(
    (rule) =>
      rule.seams.includes(request.seam) &&
      rule.destination.protocol === url.protocol &&
      rule.destination.hostname === url.hostname.toLowerCase() &&
      rule.destination.port === port &&
      rule.methods.includes(method) &&
      rule.paths.some((path) => pathMatches(path, url)),
  );
  if (matches.length === 0) throw new Error('build-egress request is not authorized by the frozen manifest');
  if (matches.length !== 1) throw new Error('build-egress request ambiguously matches multiple frozen rules');
  const rule = matches[0];
  const redirectChain = [...(request.redirectChain ?? [])];
  validateRedirectChain(validated, redirectChain, rule.id);
  const headers = sanitizeHeaders(rule, request.headers ?? {});
  return {
    policyId: validated.policyId,
    ruleId: rule.id,
    destination: rule.destination,
    method,
    path: `${url.pathname}${url.search}`,
    headers,
    responseBytes: rule.limits.responseBytes,
    timeoutMs: rule.limits.timeoutMs,
    redirectChain,
  };
}

function pathMatches(path: z.infer<typeof pathRuleSchema>, url: URL): boolean {
  if (!path.allowQuery && url.search !== '') return false;
  return path.kind === 'exact' ? url.pathname === path.value : url.pathname.startsWith(path.value);
}

function validateRedirectChain(manifest: BuildEgressManifest, chain: readonly string[], currentRuleId: string): void {
  if (chain.length === 0) return;
  if (new Set(chain).size !== chain.length || chain.includes(currentRuleId)) {
    throw new Error('build-egress redirect chain contains a loop');
  }
  const sequence = [...chain, currentRuleId];
  const initial = requiredRule(manifest, sequence[0]);
  if (chain.length > initial.redirects.maxHops) {
    throw new Error(`build-egress redirect chain exceeds ${initial.id} hop limit`);
  }
  for (let index = 0; index < sequence.length - 1; index += 1) {
    const source = requiredRule(manifest, sequence[index]);
    const targetId = sequence[index + 1];
    if (!source.redirects.allowedRuleIds.includes(targetId)) {
      throw new Error(`build-egress redirect from ${source.id} to ${targetId} is not authorized`);
    }
  }
}

function sanitizeHeaders(
  rule: BuildEgressRule,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string | readonly string[]>> {
  const result: Record<string, string | readonly string[]> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name !== rawName || !headerNameSchema.safeParse(name).success) {
      throw new Error(`build-egress header name is not canonical: ${rawName}`);
    }
    if (rawValue === undefined) continue;
    if (FORBIDDEN_CREDENTIAL_HEADERS.has(name)) {
      throw new Error(`build-egress credential header is forbidden: ${name}`);
    }
    const values = typeof rawValue === 'string' ? [rawValue] : [...rawValue];
    if (values.some((value) => /[\r\n]/u.test(value))) {
      throw new Error(`build-egress header value contains a line break: ${name}`);
    }
    if (rule.requestHeaders.strip.includes(name)) continue;
    if (!rule.requestHeaders.allow.includes(name)) {
      throw new Error(`build-egress header is not allowed by ${rule.id}: ${name}`);
    }
    result[name] = typeof rawValue === 'string' ? rawValue : values;
  }
  return result;
}

function requiredRule(manifest: BuildEgressManifest, id: string): BuildEgressRule {
  const rule = manifest.rules.find((candidate) => candidate.id === id);
  if (rule === undefined) throw new Error(`build-egress redirect chain references unknown rule: ${id}`);
  return rule;
}

function addDuplicateIssues(values: readonly string[], label: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) context.addIssue({ code: 'custom', message: `duplicate ${label}: ${value}` });
    seen.add(value);
  }
}
