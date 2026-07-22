/**
 * Frozen, anonymous-only authorization for workload-image registry egress (§6.4).
 *
 * Pure policy (node + zod only — no transport, no sockets). Mirrors
 * `build-egress-policy.ts`: a strict manifest schema, validate-once → branded
 * manifest, and a per-request hot path that never re-parses. It resolves one
 * registry pull request to exactly one reviewed origin and a single pull
 * operation, rejecting everything a pull must not do (push, delete, catalog/tags
 * enumeration), client-selected hosts, and encoded-path smuggling.
 *
 * The binding controls are client-origin URL/operation gating, exact
 * derived-redirect authorization, credential handling, and per-request /
 * per-session transfer ceilings. Workload image *content* is untrusted bundle
 * state — the bundle can already synthesize arbitrary images locally and a
 * registry can serve a malicious manifest with matching blobs — so this policy
 * never hashes or verifies blob content (§16.6). Digest *syntax* is parsed only
 * to classify by-digest pulls and to record requested/reported digests as audit
 * provenance; it gates nothing.
 *
 * Anonymous bearer-token flow (§6.4): the bundle holds no registry credential,
 * so any `Authorization: Bearer <token>` the client presents was obtained
 * anonymously through this mediated path (a `401` drives the client to the
 * token-service origin and back). {@link sanitizeHeaders} therefore admits a
 * single Bearer token on a client-initiated request to a listed origin and
 * rejects every other credential scheme (Basic, Cookie, Proxy-Authorization,
 * …). Derived redirect requests always carry no credential at all.
 *
 * Foundation code: stays inert behind the docker-workload admission fuse
 * (`assertDockerWorkloadImplementationAvailable`) until a later phase constructs
 * a `public-registry` session. The checked-in manifest is a DRAFT that Phase 0C
 * must freeze (reviewed origins, exact ceilings, hermetic protocol fixtures).
 */

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { HOP_BY_HOP_HEADERS } from './hop-by-hop-headers.js';

export const REGISTRY_EGRESS_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_REGISTRY_EGRESS_MANIFEST_BYTES = 1024 * 1024;

/**
 * Credential headers that may never appear in an origin's allow list and are
 * fail-closed rejected on a request. `authorization` is in the set for the
 * allow-list schema check (bearer admission is structural, never allow-listed),
 * but {@link sanitizeHeaders} handles `authorization` specially before this set
 * is consulted so an anonymous Bearer token to a listed origin is admitted.
 */
const FORBIDDEN_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
  'anthropic-api-key',
]);

/** A single anonymous Bearer token; every other Authorization scheme is refused. */
const BEARER_TOKEN_PATTERN = /^Bearer [A-Za-z0-9._~+/=-]+$/u;

/** Connection-management headers dropped silently (the transport re-frames them). */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set(['host', ...HOP_BY_HOP_HEADERS]);

/** Pull operations the mediated path may authorize. */
export type RegistryPullOperation = 'api-version' | 'token' | 'manifest-pull' | 'blob-pull';

/** Registry operations that are always refused — never authorizable by any origin. */
export type RejectedRegistryOperation = 'push' | 'delete' | 'catalog-enumeration' | 'tags-enumeration' | 'unknown';

/** Content pulls whose immediate 3xx Location may be followed as a derived redirect. */
const CONTENT_OPERATIONS: readonly RegistryPullOperation[] = ['manifest-pull', 'blob-pull'];

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);
const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
  .refine(
    (value) => value === value.toLowerCase() && !value.includes('..'),
    'hostname must be canonical lowercase DNS',
  );
const originPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('?') && !value.includes('#'),
    'token path pattern must be an origin pathname without query or fragment',
  );
const headerNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);

/** Pull operations only; the rejected set is intentionally not expressible. */
const pullOperationSchema = z.enum(['api-version', 'token', 'manifest-pull', 'blob-pull']);

const originSchema = z
  .object({
    id: identifierSchema,
    destination: z
      .object({
        protocol: z.literal('https:'),
        hostname: hostnameSchema,
        port: z.number().int().min(1).max(65_535),
      })
      .strict(),
    operations: z.array(pullOperationSchema).min(1).max(4),
    /**
     * Token endpoints. Real registries vary: Docker Hub splits the token service
     * onto a separate host (auth.docker.io), while ghcr.io serves `/token` and the
     * v2 API on one host — so any origin that authorizes `token` declares its exact
     * token pathname patterns and a request matching one is classified as a token
     * fetch before v2 path classification.
     */
    tokenPaths: z
      .array(z.object({ kind: z.enum(['exact', 'prefix']), value: originPathSchema }).strict())
      .max(16)
      .optional(),
    /** Per-request transfer ceilings enforced by the proxy while streaming. */
    perRequest: z
      .object({
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(8 * 1024 * 1024 * 1024),
        maxDurationMs: z
          .number()
          .int()
          .min(100)
          .max(30 * 60_000),
        maxRedirectHops: z.number().int().min(0).max(5),
      })
      .strict(),
    requestHeaders: z
      .object({
        allow: z.array(headerNameSchema).max(64),
      })
      .strict(),
  })
  .strict()
  .superRefine((origin, context) => {
    addDuplicateIssues(origin.operations, 'operation', context);
    addDuplicateIssues(origin.requestHeaders.allow, 'allowed header', context);
    for (const name of origin.requestHeaders.allow) {
      if (FORBIDDEN_CREDENTIAL_HEADERS.has(name)) {
        context.addIssue({ code: 'custom', message: `credential header cannot be allowed: ${name}` });
      }
    }
    const authorizesToken = origin.operations.includes('token');
    const hasTokenPaths = origin.tokenPaths !== undefined && origin.tokenPaths.length > 0;
    if (authorizesToken && !hasTokenPaths) {
      context.addIssue({ code: 'custom', message: 'a token operation requires at least one token path' });
    }
    if (!authorizesToken && origin.tokenPaths !== undefined) {
      context.addIssue({ code: 'custom', message: 'token paths require the token operation' });
    }
  });

const registryEgressManifestSchema = z
  .object({
    schemaVersion: z.literal(REGISTRY_EGRESS_MANIFEST_SCHEMA_VERSION),
    policyId: identifierSchema,
    /** Draft manifests are not frozen; 0C flips this once origins/ceilings are reviewed. */
    status: z.enum(['draft', 'frozen']),
    origins: z.array(originSchema).min(1).max(64),
    /** Cumulative ceilings enforced across every request in one session. */
    perSession: z
      .object({
        maxTotalBytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024 * 1024),
        maxConcurrentRequests: z.number().int().min(1).max(64),
      })
      .strict(),
    /**
     * Documentation of the operations that are always refused. Purely declarative:
     * the schema cannot express them as allowed, so they fail closed regardless.
     */
    rejectedOperations: z
      .array(z.enum(['push', 'delete', 'catalog-enumeration', 'tags-enumeration']))
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(
      manifest.origins.map((origin) => origin.id),
      'origin ID',
      context,
    );
    addDuplicateIssues(
      manifest.origins.map((origin) => `${origin.destination.hostname}:${origin.destination.port}`),
      'origin authority',
      context,
    );
  });

export type RegistryEgressManifest = z.infer<typeof registryEgressManifestSchema>;
export type RegistryEgressOrigin = RegistryEgressManifest['origins'][number];
export type RegistryDestination = RegistryEgressOrigin['destination'];
export type RegistryEgressSessionLimits = RegistryEgressManifest['perSession'];

declare const validatedRegistryEgressManifestBrand: unique symbol;

/**
 * A {@link RegistryEgressManifest} that has passed schema validation. The brand
 * lets the per-request hot path ({@link authorizeValidatedRegistryEgressRequest})
 * skip re-parsing while the raw-object entry ({@link authorizeRegistryEgressRequest})
 * stays fail-closed for untrusted callers. Only {@link validateRegistryEgressManifest}
 * and {@link loadRegistryEgressManifest} produce this type.
 */
export type ValidatedRegistryEgressManifest = RegistryEgressManifest & {
  readonly [validatedRegistryEgressManifestBrand]: true;
};

/** Parse-and-brand a manifest once. The single validation seam for the hot path. */
export function validateRegistryEgressManifest(manifest: RegistryEgressManifest): ValidatedRegistryEgressManifest {
  return registryEgressManifestSchema.parse(manifest) as ValidatedRegistryEgressManifest;
}

export interface LoadedRegistryEgressManifest {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly manifest: ValidatedRegistryEgressManifest;
}

export interface RegistryEgressRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** A parsed `sha256:<hex>` content digest; the sole digest syntax recorded in 0F. */
export interface OciDigest {
  readonly algorithm: 'sha256';
  readonly hex: string;
}

export interface AuthorizedRegistryEgressRequest {
  readonly policyId: string;
  readonly originId: string;
  readonly operation: RegistryPullOperation;
  readonly destination: RegistryDestination;
  readonly method: 'GET' | 'HEAD';
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  /** Repository name for manifest/blob pulls (e.g. `library/alpine`). */
  readonly repository?: string;
  /** Requested reference (tag or digest string) for a manifest pull. */
  readonly reference?: string;
  /** Present for a by-digest pull; recorded as audit provenance, never verified. */
  readonly requestedDigest?: OciDigest;
  /** Per-request streamed-byte ceiling; the forwarder aborts once it is exceeded. */
  readonly maxBytes: number;
  /** Absolute per-request wall-clock ceiling in milliseconds. */
  readonly maxDurationMs: number;
  readonly maxRedirectHops: number;
  /** 0 for the initial request; incremented by {@link authorizeValidatedRegistryRedirect}. */
  readonly redirectHop: number;
}

/** Load a strict, non-writable, non-symlink manifest once, hash it for audit. */
export function loadRegistryEgressManifest(path: string): LoadedRegistryEgressManifest {
  if (!isAbsolute(path)) throw new Error('registry-egress manifest path must be absolute');
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`registry-egress manifest must be a readable regular non-symlink file: ${path}`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('registry-egress manifest must be a regular file');
    if ((stats.mode & 0o022) !== 0) throw new Error('registry-egress manifest must not be group/world writable');
    if (stats.size < 2 || stats.size > MAX_REGISTRY_EGRESS_MANIFEST_BYTES) {
      throw new Error(`registry-egress manifest size is outside the allowed range: ${stats.size}`);
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('registry-egress manifest is not valid JSON', { cause: error });
  }
  const validated = registryEgressManifestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`registry-egress manifest is invalid: ${validated.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    manifest: validated.data as ValidatedRegistryEgressManifest,
  };
}

/**
 * Resolve one request to exactly one reviewed origin and pull operation; validates
 * the manifest first, so it is safe for untrusted callers. The proxy hot path holds
 * a pre-validated manifest and calls {@link authorizeValidatedRegistryEgressRequest}.
 */
export function authorizeRegistryEgressRequest(
  manifest: RegistryEgressManifest,
  request: RegistryEgressRequest,
): AuthorizedRegistryEgressRequest {
  return authorizeValidatedRegistryEgressRequest(validateRegistryEgressManifest(manifest), request);
}

/** Resolve one request against an already-validated manifest; no per-request re-parse. */
export function authorizeValidatedRegistryEgressRequest(
  validated: ValidatedRegistryEgressManifest,
  request: RegistryEgressRequest,
): AuthorizedRegistryEgressRequest {
  const url = parseRegistryUrl(request.url);
  const origin = matchOrigin(validated, url);
  if (origin === undefined) throw new Error('registry-egress request targets an unlisted host; fail closed');

  const classification = classifyRegistryRequest(origin, request.method, url);
  if (!origin.operations.includes(classification.operation)) {
    throw new Error(`registry-egress origin ${origin.id} does not authorize ${classification.operation}`);
  }
  const headers = sanitizeHeaders(origin, request.headers ?? {});
  return {
    policyId: validated.policyId,
    originId: origin.id,
    operation: classification.operation,
    destination: origin.destination,
    method: classification.method,
    path: `${url.pathname}${url.search}`,
    headers,
    repository: classification.repository,
    reference: classification.reference,
    requestedDigest: classification.requestedDigest,
    maxBytes: origin.perRequest.maxBytes,
    maxDurationMs: origin.perRequest.maxDurationMs,
    maxRedirectHops: origin.perRequest.maxRedirectHops,
    redirectHop: 0,
  };
}

/**
 * Authorize following one 3xx redirect as the immediate bounded response to an
 * already-authorized manifest/blob pull. The reference (tag or digest) does not
 * matter — any content pull may be redirected. A target that matches a reviewed
 * origin is re-authorized against it; an unlisted (dynamic CDN) host is reachable
 * only here, stays on HTTPS, and carries NO credential header. The destination-bound
 * transport resolves the host and rejects a private/loopback/link-local/ULA answer
 * before connecting; a literal-address redirect is refused outright here.
 */
export function authorizeValidatedRegistryRedirect(
  validated: ValidatedRegistryEgressManifest,
  current: AuthorizedRegistryEgressRequest,
  location: string,
): AuthorizedRegistryEgressRequest {
  if (!CONTENT_OPERATIONS.includes(current.operation)) {
    throw new Error('registry-egress redirect is only followed for an authorized manifest or blob pull');
  }
  const hop = current.redirectHop + 1;
  if (hop > current.maxRedirectHops)
    throw new Error(`registry-egress redirect exceeds the ${current.originId} hop limit`);
  const target = resolveRedirectUrl(current, location);
  // `URL.hostname` brackets an IPv6 literal; strip them before classifying.
  if (isIP(target.hostname.replace(/^\[|\]$/gu, '')) !== 0) {
    throw new Error('registry-egress redirect must target a DNS name, not a literal address');
  }

  const matchedOrigin = matchOrigin(validated, target);
  if (matchedOrigin !== undefined) {
    const classification = classifyRegistryRequest(matchedOrigin, current.method, target);
    if (!matchedOrigin.operations.includes(classification.operation)) {
      throw new Error(
        `registry-egress redirect target ${matchedOrigin.id} does not authorize ${classification.operation}`,
      );
    }
    return {
      ...current,
      originId: matchedOrigin.id,
      operation: classification.operation,
      destination: matchedOrigin.destination,
      path: `${target.pathname}${target.search}`,
      headers: {},
      repository: classification.repository,
      reference: classification.reference,
      requestedDigest: classification.requestedDigest,
      maxBytes: matchedOrigin.perRequest.maxBytes,
      maxDurationMs: matchedOrigin.perRequest.maxDurationMs,
      maxRedirectHops: matchedOrigin.perRequest.maxRedirectHops,
      redirectHop: hop,
    };
  }

  return {
    ...current,
    originId: `${current.originId}:cdn`,
    destination: { protocol: 'https:', hostname: target.hostname.toLowerCase(), port: redirectPort(target) },
    path: `${target.pathname}${target.search}`,
    headers: {},
    redirectHop: hop,
  };
}

interface RegistryPullClassification {
  readonly operation: RegistryPullOperation;
  readonly repository?: string;
  readonly reference?: string;
  readonly requestedDigest?: OciDigest;
}

interface RegistryClassification extends RegistryPullClassification {
  readonly method: 'GET' | 'HEAD';
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OCI_NAME_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/u;
const OCI_TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/u;

/**
 * Classify a request into a single pull operation or throw for any refused shape.
 * The sole place request method semantics are decided: push (PUT/POST/PATCH),
 * delete, and non-canonical methods fail closed; only canonical GET/HEAD reach a
 * pull-path classification.
 */
function classifyRegistryRequest(origin: RegistryEgressOrigin, rawMethod: string, url: URL): RegistryClassification {
  const method = rawMethod.toUpperCase();
  if (method !== rawMethod) throw new Error('registry-egress method must be canonical uppercase');
  if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
    throw refusal('push', 'registry-egress refuses push operations');
  }
  if (method === 'DELETE') throw refusal('delete', 'registry-egress refuses delete operations');
  if (method !== 'GET' && method !== 'HEAD') throw new Error(`registry-egress refuses ${method}`);

  return { ...classifyPull(origin, url), method };
}

/** Resolve a canonical GET/HEAD request to one pull operation or throw. */
function classifyPull(origin: RegistryEgressOrigin, url: URL): RegistryPullClassification {
  // A token path is classified before v2 path shapes so a combined host
  // (e.g. ghcr.io serving both /token and /v2/*) resolves each correctly.
  const tokenMatch = classifyTokenIfMatched(origin, url);
  if (tokenMatch !== undefined) return tokenMatch;

  const pathname = url.pathname;
  if (pathname === '/v2' || pathname === '/v2/') {
    requireNoQuery(url);
    return { operation: 'api-version' };
  }
  if (pathname === '/v2/_catalog') throw refusal('catalog-enumeration', 'registry-egress refuses catalog enumeration');
  if (/^\/v2\/.+\/tags\/list$/u.test(pathname)) {
    throw refusal('tags-enumeration', 'registry-egress refuses tag enumeration');
  }
  if (/^\/v2\/.+\/blobs\/uploads(?:\/.*)?$/u.test(pathname)) {
    throw refusal('push', 'registry-egress refuses blob uploads');
  }
  const manifestMatch = /^\/v2\/(.+)\/manifests\/([^/]+)$/u.exec(pathname);
  if (manifestMatch) return classifyManifest(url, manifestMatch[1], decodeURIComponent(manifestMatch[2]));
  const blobMatch = /^\/v2\/(.+)\/blobs\/([^/]+)$/u.exec(pathname);
  if (blobMatch) return classifyBlob(url, blobMatch[1], decodeURIComponent(blobMatch[2]));
  throw refusal('unknown', 'registry-egress request is not a recognized pull operation');
}

function classifyTokenIfMatched(origin: RegistryEgressOrigin, url: URL): RegistryPullClassification | undefined {
  const patterns = origin.tokenPaths ?? [];
  const matched = patterns.some((pattern) =>
    pattern.kind === 'exact' ? url.pathname === pattern.value : url.pathname.startsWith(pattern.value),
  );
  return matched ? { operation: 'token' } : undefined;
}

function classifyManifest(url: URL, rawName: string, reference: string): RegistryPullClassification {
  requireNoQuery(url);
  const repository = validateRepository(rawName);
  const digest = parseOciDigest(reference);
  if (digest !== undefined) {
    return { operation: 'manifest-pull', repository, reference, requestedDigest: digest };
  }
  if (!OCI_TAG_PATTERN.test(reference))
    throw new Error('registry-egress manifest reference is not a valid tag or digest');
  // A tag pull has no requested digest; the registry-reported digest (if any) is
  // recorded from the response header as provenance, never computed from bytes.
  return { operation: 'manifest-pull', repository, reference };
}

function classifyBlob(url: URL, rawName: string, reference: string): RegistryPullClassification {
  requireNoQuery(url);
  const repository = validateRepository(rawName);
  const digest = parseOciDigest(reference);
  if (digest === undefined) throw new Error('registry-egress blob pulls must be addressed by sha256 digest');
  return { operation: 'blob-pull', repository, reference, requestedDigest: digest };
}

function validateRepository(name: string): string {
  if (name.length > 255 || /%/u.test(name) || !OCI_NAME_PATTERN.test(name)) {
    throw new Error('registry-egress repository name is not a canonical OCI name');
  }
  return name;
}

/** Parse a `sha256:<hex>` reference, or `undefined` when it is not a digest. */
export function parseOciDigest(reference: string): OciDigest | undefined {
  if (!DIGEST_PATTERN.test(reference)) return undefined;
  return { algorithm: 'sha256', hex: reference.slice('sha256:'.length) };
}

function refusal(operation: RejectedRegistryOperation, message: string): Error {
  return new Error(`${message} (${operation})`);
}

function parseRegistryUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error('registry-egress request URL is invalid', { cause: error });
  }
  if (url.protocol !== 'https:') throw new Error('registry-egress requests must use https');
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('registry-egress request URL must not contain credentials or a fragment');
  }
  if (/%(?:2f|5c|25)/iu.test(url.pathname)) {
    throw new Error('registry-egress request path contains an encoded separator or nested escape');
  }
  return url;
}

function requireNoQuery(url: URL): void {
  if (url.search !== '') throw new Error('registry-egress pull path must not carry a query string');
}

function matchOrigin(manifest: ValidatedRegistryEgressManifest, url: URL): RegistryEgressOrigin | undefined {
  const hostname = url.hostname.toLowerCase();
  const port = defaultPort(url);
  return manifest.origins.find(
    (origin) =>
      origin.destination.protocol === url.protocol &&
      origin.destination.hostname === hostname &&
      origin.destination.port === port,
  );
}

function defaultPort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0;
}

function resolveRedirectUrl(current: AuthorizedRegistryEgressRequest, location: string): URL {
  const base = `${current.destination.protocol}//${authority(current.destination)}${current.path}`;
  let target: URL;
  try {
    target = new URL(location, base);
  } catch (error) {
    throw new Error('registry-egress redirect Location is invalid', { cause: error });
  }
  if (target.username !== '' || target.password !== '' || target.hash !== '') {
    throw new Error('registry-egress redirect must not contain credentials or a fragment');
  }
  if (/%(?:2f|5c|25)/iu.test(target.pathname)) {
    throw new Error('registry-egress redirect path contains an encoded separator or nested escape');
  }
  if (target.protocol !== 'https:') {
    throw new Error('registry-egress redirect must stay on https');
  }
  return target;
}

function redirectPort(url: URL): number {
  const port = defaultPort(url);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('registry-egress redirect port is invalid');
  return port;
}

function authority(destination: RegistryDestination): string {
  const host = destination.hostname.includes(':') ? `[${destination.hostname}]` : destination.hostname;
  // Origins are https by schema, so port 443 is the only elidable authority.
  return destination.port === 443 ? host : `${host}:${destination.port}`;
}

function sanitizeHeaders(
  origin: RegistryEgressOrigin,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string | readonly string[]>> {
  const result: Record<string, string | readonly string[]> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name !== rawName || !headerNameSchema.safeParse(name).success) {
      throw new Error(`registry-egress header name is not canonical: ${rawName}`);
    }
    if (rawValue === undefined) continue;
    // Anonymous bearer-token admission (§6.4): the bundle holds no registry
    // credential, so a Bearer token here was obtained anonymously through this
    // mediated path. Admit a single `Bearer <token>` to a listed origin; reject
    // every other Authorization scheme (Basic, Digest, …).
    if (name === 'authorization') {
      result[name] = admitBearerAuthorization(rawValue);
      continue;
    }
    // Any other credential header is a fail-closed rejection (cookie,
    // proxy-authorization, x-api-key, …), while connection-management headers the
    // client stack auto-adds (host, keep-alive, …) are dropped silently — the
    // destination-bound transport re-frames the connection.
    if (FORBIDDEN_CREDENTIAL_HEADERS.has(name)) {
      throw new Error(`registry-egress credential header is forbidden: ${name}`);
    }
    if (DROPPED_REQUEST_HEADERS.has(name)) continue;
    const values = typeof rawValue === 'string' ? [rawValue] : [...rawValue];
    if (values.some((value) => /[\r\n]/u.test(value))) {
      throw new Error(`registry-egress header value contains a line break: ${name}`);
    }
    if (!origin.requestHeaders.allow.includes(name)) {
      throw new Error(`registry-egress header is not allowed by ${origin.id}: ${name}`);
    }
    result[name] = typeof rawValue === 'string' ? rawValue : values;
  }
  return result;
}

/** Admit exactly one anonymous `Bearer <token>`; reject arrays and other schemes. */
function admitBearerAuthorization(value: string | readonly string[]): string {
  if (typeof value !== 'string' || !BEARER_TOKEN_PATTERN.test(value)) {
    throw new Error('registry-egress authorization must be a single anonymous Bearer token');
  }
  return value;
}

function addDuplicateIssues(values: readonly string[], label: string, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) context.addIssue({ code: 'custom', message: `duplicate ${label}: ${value}` });
    seen.add(value);
  }
}
