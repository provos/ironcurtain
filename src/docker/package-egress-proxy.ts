/**
 * Strict, production package-registry egress for nested-Docker package mode.
 *
 * Unlike the general MITM proxy, it has no provider,
 * credential-swap, wildcard, dynamic-domain, or raw-passthrough mode. Every
 * client request must match one fixed package host and one parsed install
 * route. Redirects are validated and returned to the client; this listener
 * never follows one or delegates dialing to another proxy.
 */

import { constants, type Stats } from 'node:fs';
import { chmod, lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
import { URL } from 'node:url';
import { createLeafSecureContextCache, type CertificateAuthority } from './ca.js';
import { consumeProxyAuthorization } from './proxy-authorization.js';
import type { PackageIdentity, PackageDecision, PackageValidator, RegistryType } from './package-types.js';
import {
  cargoSparseIndexPath,
  parseCargoDownloadUrl,
  parseCargoSparseIndexUrl,
  parseDebianPackageUrl,
  parseNpmUrl,
  parsePypiSimpleUrl,
  parsePypiTarballUrl,
} from './registry-proxy.js';
import {
  createPackageEgressLedger,
  DEFAULT_PACKAGE_EGRESS_LIMITS,
  systemPackageEgressClock,
  type PackageEgressClientLease,
  type PackageEgressClock,
  type PackageEgressLedgerSnapshot,
  type PackageEgressLimits,
  type PackageEgressUpstreamLease,
} from './package-egress-ledger.js';
import {
  assertPackageEgressAddressStillAllowed,
  defaultPackageEgressHostIdentityProvider,
  defaultPackageEgressResolver,
  discoverNat64Prefixes,
  screenPackageEgressDestination,
  type PackageEgressHostIdentityProvider,
  type PackageEgressNat64Prefix,
  type PackageEgressNat64PrefixProvider,
  type PackageEgressResolver,
} from './package-egress-address-policy.js';

export type PackageEgressEcosystem = RegistryType;
export type PackageEgressRouteKind = 'metadata' | 'artifact' | 'bootstrap';

export interface PackageEgressRoute {
  readonly ecosystem: PackageEgressEcosystem;
  readonly host: string;
  readonly path: string;
  readonly kind: PackageEgressRouteKind;
  readonly package?: PackageIdentity;
}

export interface PackageEgressPolicy {
  readonly validator: PackageValidator;
}

/** @internal Synchronous route decision seam for hermetic parser/transport tests only. */
export type PackageEgressAuthorizer = (route: PackageEgressRoute) => PackageDecision;

export const PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION = 1;
export const PACKAGE_EGRESS_AUDIT_FILENAME = 'package-egress-audit.jsonl';

export const PACKAGE_EGRESS_AUDIT_REASON_CODES = [
  'policy-disabled',
  'client-metadata-unfiltered',
  'derived-metadata-fetched',
  'derived-metadata-failed',
  'debian-curated-epoch',
  'policy-allow',
  'policy-deny',
] as const;

export type PackageEgressAuditReasonCode = (typeof PACKAGE_EGRESS_AUDIT_REASON_CODES)[number];

export interface PackageEgressAuditRecord {
  readonly schemaVersion: typeof PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly decision: 'allow' | 'deny';
  readonly reasonCode: PackageEgressAuditReasonCode;
  readonly reason: string;
  readonly method: 'GET' | 'HEAD';
  readonly ecosystem: PackageEgressEcosystem;
  readonly host: string;
  readonly path: string;
  readonly routeKind: PackageEgressRouteKind;
  readonly package?: {
    readonly name: string;
    readonly scope?: string;
    readonly version?: string;
  };
  readonly source: 'client' | 'derived';
}

export interface PackageEgressDialRequest {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 443;
  readonly signal: AbortSignal;
}

export type PackageEgressSelectedAddressDial = (request: PackageEgressDialRequest) => Promise<Socket>;

export interface PackageEgressSocketFilesystem {
  lstat(path: string): Promise<Pick<Stats, 'dev' | 'ino' | 'mode' | 'isSocket'>>;
  chmod(path: string, mode: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface PackageEgressTestHooks {
  /** Low-level selected-address socket factory. It cannot choose or resolve the destination. */
  readonly dialSelectedAddress?: PackageEgressSelectedAddressDial;
  readonly upstreamCa?: string | Buffer;
  readonly socketFilesystem?: PackageEgressSocketFilesystem;
  readonly authorize?: PackageEgressAuthorizer;
}

export interface CreatePackageEgressProxyOptions {
  readonly ca: CertificateAuthority;
  /** Absent means syntactically recognized public package routes are allowed. */
  readonly policy?: PackageEgressPolicy;
  /** Exact per-bundle, credential-free, bounded decision audit. */
  readonly auditLogPath: string;
  readonly limits?: Partial<PackageEgressLimits>;
  readonly resolver?: PackageEgressResolver;
  readonly hostIdentityProvider?: PackageEgressHostIdentityProvider;
  readonly nat64PrefixProvider?: PackageEgressNat64PrefixProvider;
  readonly nat64Prefixes?: readonly PackageEgressNat64Prefix[];
  readonly clock?: PackageEgressClock;
  /**
   * Connection-source filter for TCP mode. Rejected sockets are destroyed
   * before they acquire a client lease or reach HTTP parsing. UDS listeners
   * do not consult this predicate.
   */
  readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
  /** Exact per-bundle credential required on Docker Desktop's shared host-gateway hop. */
  readonly requiredProxyAuthorization?: string;
  /** @internal Hermetic tests only; rejected outside NODE_ENV=test. */
  readonly testHooks?: PackageEgressTestHooks;
}

/** Exact endpoint selected by the trusted topology for this listener. */
export type PackageEgressListenTarget =
  | { readonly socketPath: string; readonly listenPort?: never }
  | { readonly socketPath?: never; readonly listenPort: number };

/** Bound endpoint returned after successful listener startup. */
export type PackageEgressListenAddress =
  | { readonly socketPath: string; readonly port?: never }
  | { readonly socketPath?: never; readonly port: number };

export interface PackageEgressProxy {
  readonly snapshot: PackageEgressLedgerSnapshot;
  start(target: PackageEgressListenTarget): Promise<PackageEgressListenAddress>;
  stop(): Promise<void>;
}

export const PACKAGE_EGRESS_HEALTH_BODY = 'IRONCURTAIN_PACKAGE_EGRESS_OK/1\n';
export const PACKAGE_EGRESS_HEALTH_REQUEST =
  'GET http://ironcurtain.invalid/__ironcurtain/package-egress/health HTTP/1.1\r\n' +
  'Host: ironcurtain.invalid\r\n' +
  'Connection: close\r\n\r\n';

const HEALTH_URL = 'http://ironcurtain.invalid/__ironcurtain/package-egress/health';
const HEALTH_HOST = 'ironcurtain.invalid';
const FIXED_USER_AGENT = 'IronCurtain-Package-Egress/1';
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'npm-authorization',
  'npm-token',
  'private-token',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);
const RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'vary',
]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_DERIVED_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_REASON_CHARACTERS = 256;
const MAX_AUDIT_FILE_BYTES = 16 * 1024 * 1024;

const NPM_NAME = '[a-z0-9](?:[a-z0-9._~-]{0,212}[a-z0-9])?';
const NPM_METADATA = new RegExp(`^/(?:${NPM_NAME}|@${NPM_NAME}(?:/|%2[fF])${NPM_NAME})$`, 'u');
const NPM_TARBALL = new RegExp(
  `^/(?:${NPM_NAME}|@${NPM_NAME}/${NPM_NAME})/-/${NPM_NAME}-[A-Za-z0-9.+_~-]+\\.tgz$`,
  'u',
);
const PYPI_ARTIFACT = /^\/packages\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{16,128}\/[A-Za-z0-9][A-Za-z0-9._+~-]{1,511}$/u;
const DEBIAN_PREFIX = '(?:debian|debian-security)';
const DEBIAN_COMPONENT = '(?:main|contrib|non-free|non-free-firmware)';
const DEBIAN_SAFE_SEGMENT = '[A-Za-z0-9][A-Za-z0-9.+~_:@%-]*';
const DEBIAN_ARTIFACT = new RegExp(
  `^/(?:debian/pool/${DEBIAN_COMPONENT}|debian-security/pool/updates/${DEBIAN_COMPONENT})` +
    `(?:/${DEBIAN_SAFE_SEGMENT})+\\.deb$`,
  'u',
);
const DEBIAN_RELEASE = new RegExp(
  `^/${DEBIAN_PREFIX}/dists/${DEBIAN_SAFE_SEGMENT}/(?:InRelease|Release|Release\\.gpg)$`,
  'u',
);
const DEBIAN_INDEX = new RegExp(
  `^/${DEBIAN_PREFIX}/dists/${DEBIAN_SAFE_SEGMENT}(?:/${DEBIAN_SAFE_SEGMENT})*/` +
    '(?:Packages|Sources|Translation-[A-Za-z0-9._-]+)(?:\\.(?:gz|xz|bz2|lz4|zst))?$',
  'u',
);
const DEBIAN_BY_HASH = new RegExp(
  `^/${DEBIAN_PREFIX}/dists/${DEBIAN_SAFE_SEGMENT}(?:/${DEBIAN_SAFE_SEGMENT})*/by-hash/(?:SHA256|SHA512)/[a-f0-9]{64,128}$`,
  'u',
);

const PACKAGE_EGRESS_HOST_ECOSYSTEM_ENTRIES = [
  ['registry.npmjs.org', 'npm'],
  ['pypi.org', 'pypi'],
  ['files.pythonhosted.org', 'pypi'],
  ['deb.debian.org', 'debian'],
  ['security.debian.org', 'debian'],
  ['index.crates.io', 'cargo'],
  ['static.crates.io', 'cargo'],
  ['crates.io', 'cargo'],
] as const;

export const PACKAGE_EGRESS_AUDIT_HOSTS: readonly string[] = PACKAGE_EGRESS_HOST_ECOSYSTEM_ENTRIES.map(
  ([host]) => host,
);

const HOST_ECOSYSTEM = new Map<string, PackageEgressEcosystem>(PACKAGE_EGRESS_HOST_ECOSYSTEM_ENTRIES);

class PackageEgressError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PackageEgressError';
  }
}

interface ClientContext {
  readonly socket: Duplex;
  readonly lease: PackageEgressClientLease;
  readonly absoluteTimer: ReturnType<typeof setTimeout>;
  readonly deadline: number;
  readonly upstreams: Set<UpstreamOperation>;
  inboundTls?: tls.TLSSocket;
  idleTimer: ReturnType<typeof setTimeout>;
  handshake?: { bytes: number; timer: ReturnType<typeof setTimeout> };
  closed: boolean;
}

interface TlsMetadata {
  readonly client: ClientContext;
  readonly host: string;
}

interface UpstreamHandle {
  readonly response: http.IncomingMessage;
  readonly lease: PackageEgressUpstreamLease;
  release(): void;
  destroy(): void;
}

interface UpstreamOperation {
  readonly client: ClientContext;
  readonly lease: PackageEgressUpstreamLease;
  readonly controller: AbortController;
  socket?: Socket;
  request?: http.ClientRequest;
  response?: http.IncomingMessage;
  release(): void;
  destroy(): void;
}

interface SocketOwnership {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

const defaultSocketFilesystem: PackageEgressSocketFilesystem = { lstat, chmod, rename, unlink };

interface PackageEgressAuditWriter {
  start(): Promise<void>;
  append(record: PackageEgressAuditRecord): Promise<void>;
  stop(): Promise<void>;
}

function createPackageEgressAuditWriter(path: string): PackageEgressAuditWriter {
  let handle: FileHandle | undefined;
  let tail: Promise<void> = Promise.resolve();
  let terminalError: unknown;

  return {
    async start(): Promise<void> {
      if (!path.startsWith('/')) throw new Error('package egress audit requires an absolute path');
      handle = await open(
        path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const stats = await handle.stat();
      const expectedUid = process.getuid?.();
      if (
        !stats.isFile() ||
        stats.nlink !== 1 ||
        (expectedUid !== undefined && stats.uid !== expectedUid) ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > MAX_AUDIT_FILE_BYTES
      ) {
        await handle.close();
        handle = undefined;
        throw new Error('package egress audit path failed its file, owner, mode, link, or size check');
      }
    },
    append(record): Promise<void> {
      if (handle === undefined) return Promise.reject(new Error('package egress audit is not started'));
      if (terminalError !== undefined) {
        return Promise.reject(new Error('package egress audit is unavailable', { cause: terminalError }));
      }
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > limitsForAuditRecord()) {
        return Promise.reject(new Error('package egress audit record exceeds its byte ceiling'));
      }
      const operation = tail.then(async () => {
        if (handle === undefined) throw new Error('package egress audit stopped before append');
        const stats = await handle.stat();
        if (stats.size + Buffer.byteLength(line) > MAX_AUDIT_FILE_BYTES) {
          throw new Error('package egress audit file exceeds its byte ceiling');
        }
        await handle.write(line);
      });
      tail = operation.catch((error: unknown) => {
        terminalError ??= error;
      });
      return operation;
    },
    async stop(): Promise<void> {
      await tail;
      if (handle !== undefined) {
        try {
          await handle.sync();
        } finally {
          await handle.close();
          handle = undefined;
        }
      }
      if (terminalError !== undefined) {
        throw new Error('package egress audit failed', { cause: terminalError });
      }
    },
  };
}

function limitsForAuditRecord(): number {
  return DEFAULT_PACKAGE_EGRESS_LIMITS.maxTargetBytes + 2 * 1024;
}

/** Parse one exact client-visible package route. Unknown paths fail closed. */
export function classifyPackageEgressRoute(
  host: string,
  path: string,
  maxTargetBytes = DEFAULT_PACKAGE_EGRESS_LIMITS.maxTargetBytes,
): PackageEgressRoute | undefined {
  const ecosystem = HOST_ECOSYSTEM.get(host);
  if (ecosystem === undefined || !isStrictOriginPath(path, maxTargetBytes)) return undefined;

  switch (ecosystem) {
    case 'npm': {
      if (host !== 'registry.npmjs.org') return undefined;
      const parsed = parseNpmUrl(path);
      if (parsed === undefined) return undefined;
      if (parsed.version === undefined && NPM_METADATA.test(path)) {
        return { ecosystem, host, path, kind: 'metadata', package: parsed };
      }
      if (parsed.version !== undefined && NPM_TARBALL.test(path)) {
        return { ecosystem, host, path, kind: 'artifact', package: parsed };
      }
      return undefined;
    }
    case 'pypi': {
      if (host === 'pypi.org') {
        const parsed = parsePypiSimpleUrl(path);
        return parsed === undefined ? undefined : { ecosystem, host, path, kind: 'metadata', package: parsed };
      }
      if (host === 'files.pythonhosted.org' && PYPI_ARTIFACT.test(path)) {
        const parsed = parsePypiTarballUrl(path);
        return parsed === undefined || parsed.version === undefined
          ? undefined
          : { ecosystem, host, path, kind: 'artifact', package: parsed };
      }
      return undefined;
    }
    case 'debian': {
      const allowedPrefix =
        path.startsWith('/debian-security/') || (host === 'deb.debian.org' && path.startsWith('/debian/'));
      if (!allowedPrefix) return undefined;
      if (DEBIAN_ARTIFACT.test(path)) {
        if (hasNonCanonicalDebianArtifactEncoding(path)) return undefined;
        const parsed = parseDebianPackageUrl(path);
        return parsed === undefined ? undefined : { ecosystem, host, path, kind: 'artifact', package: parsed };
      }
      if (path.includes('%')) return undefined;
      return DEBIAN_RELEASE.test(path) || DEBIAN_INDEX.test(path) || DEBIAN_BY_HASH.test(path)
        ? { ecosystem, host, path, kind: 'metadata' }
        : undefined;
    }
    case 'cargo': {
      if (host === 'index.crates.io') {
        if (path === '/config.json') return { ecosystem, host, path, kind: 'bootstrap' };
        const parsed = parseCargoSparseIndexUrl(path);
        return parsed === undefined ? undefined : { ecosystem, host, path, kind: 'metadata', package: parsed };
      }
      const parsed = parseCargoDownloadUrl(path);
      if (parsed === undefined || parsed.version === undefined) return undefined;
      if (host === 'static.crates.io' && !path.startsWith('/crates/')) return undefined;
      if (host === 'crates.io' && !path.startsWith('/api/v1/crates/')) return undefined;
      return { ecosystem, host, path, kind: 'artifact', package: parsed };
    }
  }
}

/** Construct the isolated strict package listener. */
export function createPackageEgressProxy(options: CreatePackageEgressProxyOptions): PackageEgressProxy {
  if ('outboundTransport' in options) {
    throw new Error('package egress rejects delegated, parent, and re-resolving outbound transports');
  }
  if (options.testHooks !== undefined && process.env.NODE_ENV !== 'test') {
    throw new Error('package egress test hooks are unavailable outside tests');
  }
  const limits: PackageEgressLimits = Object.freeze({ ...DEFAULT_PACKAGE_EGRESS_LIMITS, ...options.limits });
  const clock = options.clock ?? systemPackageEgressClock;
  const resolver = options.resolver ?? defaultPackageEgressResolver;
  const identityProvider = options.hostIdentityProvider ?? defaultPackageEgressHostIdentityProvider;
  const nat64PrefixProvider =
    options.nat64PrefixProvider ?? (async () => discoverNat64Prefixes(await resolver('ipv4only.arpa')));
  const configuredNat64Prefixes = options.nat64Prefixes ?? [];
  const dialSelectedAddress = options.testHooks?.dialSelectedAddress ?? defaultPackageEgressDial;
  const socketFilesystem = options.testHooks?.socketFilesystem ?? defaultSocketFilesystem;
  const ledger = createPackageEgressLedger(limits, clock);
  const audit = createPackageEgressAuditWriter(options.auditLogPath);
  const contexts = new Map<Duplex, ClientContext>();
  const tlsMetadata = new WeakMap<tls.TLSSocket, TlsMetadata>();
  const activeTlsSockets = new Set<tls.TLSSocket>();
  const activeRequests = new Set<http.ClientRequest>();
  const activeResponses = new Set<http.IncomingMessage>();
  const activeUpstreamSockets = new Set<Socket>();
  const pendingDials = new Set<AbortController>();
  const activeOperations = new Set<UpstreamOperation>();
  const leafContext = createLeafSecureContextCache(options.ca);
  let socketPath: string | undefined;
  let socketOwnership: SocketOwnership | undefined;
  let tcpListener = false;
  let started = false;
  let stopped = false;
  let stopCompletion: Promise<void> | undefined;
  let lifecycleTail: Promise<void> = Promise.resolve();

  const innerServer = http.createServer({ maxHeaderSize: limits.maxHeaderBytes }, (request, response) => {
    void handleInnerRequest(request, response);
  });
  innerServer.maxRequestsPerSocket = 1;
  innerServer.keepAliveTimeout = 1;
  innerServer.requestTimeout = limits.absoluteTimeoutMs;
  innerServer.headersTimeout = limits.idleTimeoutMs;
  innerServer.on('upgrade', (_request, socket) => rejectRaw(socket, 403, 'Package egress rejects upgrades'));
  innerServer.on('clientError', (_error, socket) => rejectRaw(socket, 400, 'Bad package request'));

  const outerServer = http.createServer({ maxHeaderSize: limits.maxHeaderBytes }, (request, response) => {
    void handleOuterRequest(request, response);
  });
  outerServer.maxRequestsPerSocket = 1;
  outerServer.keepAliveTimeout = 1;
  outerServer.requestTimeout = limits.absoluteTimeoutMs;
  outerServer.headersTimeout = limits.idleTimeoutMs;

  outerServer.on('connection', (socket) => {
    if (tcpListener && options.allowRemoteAddress !== undefined) {
      let allowed = false;
      try {
        allowed = options.allowRemoteAddress(socket.remoteAddress);
      } catch {
        // A source-admission failure is a denial, never a process failure.
      }
      if (!allowed) {
        socket.destroy();
        return;
      }
    }
    try {
      const lease = ledger.admitClient();
      const absoluteTimer = setTimeout(() => {
        const context = contexts.get(socket);
        if (context !== undefined) closeClient(context);
      }, limits.absoluteTimeoutMs);
      const context: ClientContext = {
        socket,
        lease,
        absoluteTimer,
        deadline: clock.now() + limits.absoluteTimeoutMs,
        upstreams: new Set(),
        idleTimer: setTimeout(() => {
          const admitted = contexts.get(socket);
          if (admitted !== undefined) closeClient(admitted);
        }, limits.idleTimeoutMs),
        closed: false,
      };
      contexts.set(socket, context);
      socket.prependListener('data', (chunk: Buffer) => {
        resetIdleTimer(context);
        if (!lease.charge(chunk.length)) {
          socket.destroy();
          return;
        }
        if (context.handshake !== undefined) {
          context.handshake.bytes += chunk.length;
          if (context.handshake.bytes > limits.tlsHandshakeMaxBytes) socket.destroy();
        }
      });
      socket.on('close', () => closeClient(context));
      socket.on('error', () => closeClient(context));
    } catch {
      rejectRaw(socket, 429, 'Package egress client limit reached');
    }
  });
  outerServer.on('connect', (request, clientSocket, head) => {
    handleConnect(request, clientSocket, head);
  });
  outerServer.on('upgrade', (_request, socket) => rejectRaw(socket, 403, 'Package egress rejects upgrades'));
  outerServer.on('clientError', (_error, socket) => rejectRaw(socket, 400, 'Bad package proxy request'));

  async function handleOuterRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const client = contexts.get(request.socket);
    if (client === undefined) {
      response.destroy();
      return;
    }
    if (!consumeProxyAuthorization(request, options.requiredProxyAuthorization)) {
      rejectResponse(response, 407, 'Proxy Authentication Required', client.lease);
      return;
    }
    if (isExactHealthRequest(request)) {
      const responseBytes = estimateResponseBytes(200, { 'Content-Type': 'text/plain' }, PACKAGE_EGRESS_HEALTH_BODY);
      if (!client.lease.charge(responseBytes)) {
        rejectResponse(response, 413, 'Package egress client byte ceiling reached', client.lease);
        return;
      }
      response.shouldKeepAlive = false;
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(PACKAGE_EGRESS_HEALTH_BODY),
        Connection: 'close',
      });
      response.end(PACKAGE_EGRESS_HEALTH_BODY);
      return;
    }

    try {
      assertBodylessCredentialFreeRequest(request);
      assertPackageMethod(request.method);
      const parsed = parsePlainHttpTarget(request);
      const route = classifyPackageEgressRoute(parsed.host, parsed.path, limits.maxTargetBytes);
      if (route === undefined || route.ecosystem !== 'debian') {
        throw new PackageEgressError(403, 'plain HTTP is restricted to exact Debian package routes');
      }
      await forwardAuthorizedRoute(request.method, route, client, response);
    } catch (error) {
      rejectPackageError(response, error, client.lease);
    }
  }

  function handleConnect(request: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const client = contexts.get(clientSocket);
    if (client === undefined) {
      clientSocket.destroy();
      return;
    }
    try {
      if (!consumeProxyAuthorization(request, options.requiredProxyAuthorization)) {
        throw new PackageEgressError(407, 'Proxy Authentication Required');
      }
      assertBodylessCredentialFreeRequest(request);
      if (head.length !== 0) throw new PackageEgressError(400, 'pipelined bytes after CONNECT are not accepted');
      const host = parseConnectAuthority(request.url, request.headers.host);
      const acknowledgment = 'HTTP/1.1 200 Connection Established\r\n\r\n';
      if (!client.lease.charge(Buffer.byteLength(acknowledgment))) {
        throw new PackageEgressError(413, 'package egress client byte ceiling reached');
      }
      clientSocket.write(acknowledgment);
      client.handshake = {
        bytes: 0,
        timer: setTimeout(() => clientSocket.destroy(), limits.tlsHandshakeTimeoutMs),
      };
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        minVersion: 'TLSv1.2',
        SNICallback(servername, callback) {
          if (servername !== host) {
            callback(new Error('package egress TLS SNI must exactly equal the CONNECT host'));
            return;
          }
          callback(null, leafContext(host));
        },
      });
      activeTlsSockets.add(tlsSocket);
      client.inboundTls = tlsSocket;
      tlsMetadata.set(tlsSocket, { client, host });
      let initialHandshakeComplete = false;
      tlsSocket.on('secure', () => {
        if (initialHandshakeComplete) {
          tlsSocket.destroy(new Error('package egress TLS renegotiation is disabled'));
          return;
        }
        initialHandshakeComplete = true;
        tlsSocket.disableRenegotiation();
        const handshakeBytes = client.handshake?.bytes ?? 0;
        clearHandshake(client);
        if (tlsSocket.servername !== host || handshakeBytes > limits.tlsHandshakeMaxBytes) {
          tlsSocket.destroy();
        }
      });
      tlsSocket.on('close', () => {
        clearHandshake(client);
        activeTlsSockets.delete(tlsSocket);
        closeClient(client);
      });
      tlsSocket.on('error', () => tlsSocket.destroy());
      innerServer.emit('connection', tlsSocket);
    } catch (error) {
      rejectRaw(clientSocket, packageErrorStatus(error), packageErrorMessage(error), client.lease);
    }
  }

  async function handleInnerRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const socket = request.socket as tls.TLSSocket;
    const metadata = tlsMetadata.get(socket);
    if (metadata === undefined) {
      response.destroy();
      return;
    }
    try {
      assertBodylessCredentialFreeRequest(request);
      assertPackageMethod(request.method);
      if (request.headers.host !== metadata.host) {
        throw new PackageEgressError(403, 'package egress Host must exactly equal CONNECT and TLS SNI');
      }
      const path = request.url ?? '';
      const route = classifyPackageEgressRoute(metadata.host, path, limits.maxTargetBytes);
      if (route === undefined) throw new PackageEgressError(403, 'package egress route is not an install endpoint');
      await forwardAuthorizedRoute(request.method, route, metadata.client, response);
    } catch (error) {
      rejectPackageError(response, error, metadata.client.lease);
    }
  }

  async function forwardAuthorizedRoute(
    method: string | undefined,
    route: PackageEgressRoute,
    client: ClientContext,
    response: http.ServerResponse,
  ): Promise<void> {
    const upstream = await requestAuthorizedRoute(method, route, client);
    try {
      const status = upstream.response.statusCode ?? 502;
      let redirectLocation: string | undefined;
      if (REDIRECT_STATUS.has(status)) {
        const location = singleHeader(upstream.response.headersDistinct.location, 'redirect Location');
        if (location === undefined) {
          throw new PackageEgressError(502, 'package egress redirect omitted Location');
        }
        redirectLocation = canonicalizePackageEgressRedirect(route, location, limits.maxTargetBytes).location;
      }
      const responseHeaders = sanitizeResponseHeaders(upstream.response.headers, redirectLocation);
      const declaredLength = parseDeclaredLength(upstream.response.headersDistinct['content-length']);
      if (declaredLength !== undefined && declaredLength > limits.maxBytesPerRequest) {
        throw new PackageEgressError(413, 'package egress upstream response exceeds its byte ceiling');
      }
      response.shouldKeepAlive = false;
      const responseHeaderBytes = estimateOutgoingResponseHeaderBytes(status, responseHeaders);
      if (!client.lease.charge(responseHeaderBytes)) {
        throw new PackageEgressError(413, 'package egress client response exceeds its byte ceiling');
      }
      resetIdleTimer(client);
      response.writeHead(status, responseHeaders);
      upstream.response.on('data', (chunk: Buffer) => {
        resetIdleTimer(client);
        if (!upstream.lease.charge(chunk.length) || !client.lease.charge(chunk.length)) {
          upstream.destroy();
          response.destroy();
          return;
        }
        if (method !== 'HEAD' && !response.write(chunk)) {
          upstream.response.pause();
          response.once('drain', () => {
            resetIdleTimer(client);
            upstream.response.resume();
          });
        }
      });
      upstream.response.on('end', () => {
        resetIdleTimer(client);
        upstream.release();
        response.end();
      });
      upstream.response.on('close', () => upstream.release());
      upstream.response.on('error', () => {
        upstream.destroy();
        response.destroy();
      });
      response.on('close', () => {
        if (!upstream.response.complete) upstream.destroy();
        else upstream.release();
      });
    } catch (error) {
      upstream.destroy();
      throw error;
    }
  }

  async function requestAuthorizedRoute(
    method: string | undefined,
    route: PackageEgressRoute,
    client: ClientContext,
  ): Promise<UpstreamHandle> {
    if (!contexts.has(client.socket)) throw new PackageEgressError(408, 'package egress client disconnected');
    await authorizeClientRoute(method, route, client);
    if (!contexts.has(client.socket)) throw new PackageEgressError(408, 'package egress client disconnected');

    let upstreamLease: PackageEgressUpstreamLease;
    try {
      upstreamLease = client.lease.admitDirect();
    } catch (error) {
      throw new PackageEgressError(429, packageErrorMessage(error));
    }
    const operation = registerOperation(client, upstreamLease);
    const requestBytes = estimateOutboundRequestBytes(method, route);
    if (!upstreamLease.charge(requestBytes)) {
      operation.destroy();
      throw new PackageEgressError(413, 'package egress upstream request exceeds its byte ceiling');
    }

    let upstreamResponse: http.IncomingMessage;
    try {
      upstreamResponse = await openUpstream(method, route, operation);
    } catch (error) {
      operation.destroy();
      throw error;
    }
    const headerBytes = estimateIncomingResponseHeaderBytes(upstreamResponse);
    if (!upstreamLease.charge(headerBytes)) {
      operation.destroy();
      throw new PackageEgressError(413, 'package egress response headers exceed a byte ceiling');
    }
    return {
      response: upstreamResponse,
      lease: upstreamLease,
      release: () => operation.release(),
      destroy: () => operation.destroy(),
    };
  }

  async function authorizeClientRoute(
    method: string | undefined,
    route: PackageEgressRoute,
    client: ClientContext,
  ): Promise<void> {
    const exactMethod = method === 'HEAD' ? 'HEAD' : 'GET';
    const pkg = route.package;
    const testDecision = options.testHooks?.authorize?.(route);
    if (testDecision !== undefined) {
      await appendAuditDecision(
        route,
        exactMethod,
        'client',
        testDecision.status,
        testDecision.status === 'allow' ? 'policy-allow' : 'policy-deny',
        testDecision.reason,
      );
      if (testDecision.status !== 'allow') throw new PackageEgressError(403, testDecision.reason);
      return;
    }
    if (options.policy === undefined) {
      await appendAuditDecision(route, exactMethod, 'client', 'allow', 'policy-disabled', 'Package policy is disabled');
      return;
    }
    if (route.kind !== 'artifact' || pkg?.version === undefined) {
      // Package managers need unfiltered metadata to resolve versions. The
      // matching artifact request is independently parsed and validated with
      // source-owned metadata before any artifact bytes leave the proxy.
      await appendAuditDecision(
        route,
        exactMethod,
        'client',
        'allow',
        'client-metadata-unfiltered',
        'Recognized metadata route; artifact policy remains authoritative',
      );
      return;
    }

    let decision: PackageDecision;
    if (pkg.registry === 'debian') {
      // Debian artifacts are versioned beneath signed distro-curated pool
      // metadata. Preserve the existing documented quarantine exemption while
      // still applying exact deny/allow-list policy to the parsed artifact.
      decision = options.policy.validator.validate(pkg, { publishedAt: new Date(0) });
      await appendAuditDecision(
        route,
        exactMethod,
        'client',
        decision.status,
        decision.status === 'allow' ? 'debian-curated-epoch' : 'policy-deny',
        decision.reason,
      );
    } else {
      const derivedRoute = derivedMetadataRoute(pkg);
      let publishedAt: Date | undefined;
      try {
        const body = await fetchDerivedMetadata(derivedRoute, client);
        publishedAt = parseRequestedVersionTimestamp(pkg, body);
        await appendAuditDecision(
          derivedRoute,
          'GET',
          'derived',
          'allow',
          'derived-metadata-fetched',
          'Source-owned metadata for the exact requested version was fetched',
        );
      } catch (error) {
        await appendAuditDecision(
          derivedRoute,
          'GET',
          'derived',
          'deny',
          'derived-metadata-failed',
          boundedAuditReason(packageErrorMessage(error)),
        );
        throw error;
      }
      decision = options.policy.validator.validate(pkg, publishedAt === undefined ? undefined : { publishedAt });
      await appendAuditDecision(
        route,
        exactMethod,
        'client',
        decision.status,
        decision.status === 'allow' ? 'policy-allow' : 'policy-deny',
        decision.reason,
      );
    }
    if (decision.status !== 'allow') throw new PackageEgressError(403, decision.reason);
  }

  async function fetchDerivedMetadata(route: PackageEgressRoute, client: ClientContext): Promise<Buffer> {
    let lease: PackageEgressUpstreamLease;
    try {
      lease = client.lease.admitDerived();
    } catch (error) {
      throw new PackageEgressError(429, packageErrorMessage(error));
    }
    const operation = registerOperation(client, lease);
    if (!lease.charge(estimateOutboundRequestBytes('GET', route))) {
      operation.destroy();
      throw new PackageEgressError(413, 'package egress derived request exceeds its byte ceiling');
    }
    try {
      const response = await openUpstream('GET', route, operation);
      const status = response.statusCode ?? 502;
      if (status !== 200) throw new PackageEgressError(502, `package metadata upstream returned status ${status}`);
      const headerBytes = estimateIncomingResponseHeaderBytes(response);
      if (!lease.charge(headerBytes)) {
        throw new PackageEgressError(413, 'package egress derived response headers exceed a byte ceiling');
      }
      const declared = parseDeclaredLength(response.headersDistinct['content-length']);
      if (declared !== undefined && declared > Math.min(MAX_DERIVED_METADATA_BYTES, limits.maxBytesPerRequest)) {
        throw new PackageEgressError(413, 'package egress derived metadata exceeds its byte ceiling');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const rawChunk of response) {
        resetIdleTimer(client);
        assertClientActive(client);
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        bytes += chunk.length;
        if (bytes > MAX_DERIVED_METADATA_BYTES || !lease.charge(chunk.length) || bytes > limits.maxBytesPerRequest) {
          throw new PackageEgressError(413, 'package egress derived metadata exceeds its byte ceiling');
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, bytes);
    } finally {
      operation.destroy();
    }
  }

  async function appendAuditDecision(
    route: PackageEgressRoute,
    method: 'GET' | 'HEAD',
    source: 'client' | 'derived',
    decision: 'allow' | 'deny',
    reasonCode: PackageEgressAuditReasonCode,
    reason: string,
  ): Promise<void> {
    await audit.append({
      schemaVersion: PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION,
      timestamp: new Date(clock.now()).toISOString(),
      decision,
      reasonCode,
      reason: boundedAuditReason(reason),
      method,
      ecosystem: route.ecosystem,
      host: route.host,
      path: route.path,
      routeKind: route.kind,
      ...(route.package === undefined
        ? {}
        : {
            package: {
              name: route.package.name,
              ...(route.package.scope === undefined ? {} : { scope: route.package.scope }),
              ...(route.package.version === undefined ? {} : { version: route.package.version }),
            },
          }),
      source,
    });
  }

  async function openUpstream(
    method: string | undefined,
    route: PackageEgressRoute,
    operation: UpstreamOperation,
  ): Promise<http.IncomingMessage> {
    const { client } = operation;
    const secureSocket = await resolveAndConnect(route.host, operation);
    const remainingLifetime = remainingTimeout(client, limits.absoluteTimeoutMs, 'absolute request');
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: http.ClientRequest;
      try {
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = (_connectionOptions, callback) => {
          callback?.(null, secureSocket);
          return secureSocket;
        };
        request = https.request(
          {
            hostname: route.host,
            port: 443,
            method,
            path: route.path,
            headers: {
              Host: route.host,
              Accept: '*/*',
              'Accept-Encoding': 'identity',
              'User-Agent': FIXED_USER_AGENT,
              Connection: 'close',
            },
            agent,
          },
          (response) => {
            if (settled) {
              response.destroy();
              return;
            }
            settled = true;
            resetIdleTimer(client);
            operation.response = response;
            activeResponses.add(response);
            response.once('close', () => activeResponses.delete(response));
            resolve(response);
          },
        );
      } catch (error) {
        operation.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      operation.request = request;
      activeRequests.add(request);
      const absoluteTimer = setTimeout(() => {
        request.destroy(new PackageEgressError(504, 'package egress upstream timeout'));
      }, remainingLifetime);
      request.on('close', () => {
        clearTimeout(absoluteTimer);
        activeRequests.delete(request);
      });
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        operation.destroy();
        reject(
          error instanceof PackageEgressError
            ? error
            : new PackageEgressError(502, `package egress upstream failed: ${error.message}`),
        );
      });
      resetIdleTimer(client);
      request.end();
    });
  }

  async function resolveAndConnect(hostname: string, operation: UpstreamOperation): Promise<tls.TLSSocket> {
    const { client } = operation;
    const [answers, discoveredNat64Prefixes] = await Promise.all([
      withTimeout(
        () => resolver(hostname),
        remainingTimeout(client, limits.dnsTimeoutMs, 'DNS'),
        'DNS',
        undefined,
        operation.controller.signal,
      ),
      withTimeout(
        nat64PrefixProvider,
        remainingTimeout(client, limits.dnsTimeoutMs, 'NAT64 discovery'),
        'NAT64 discovery',
        undefined,
        operation.controller.signal,
      ),
    ]);
    const effectivePrefixes = [...configuredNat64Prefixes, ...discoveredNat64Prefixes];
    const preConnectIdentities = await withTimeout(
      identityProvider,
      remainingTimeout(client, limits.dnsTimeoutMs, 'host identity'),
      'host identity',
      undefined,
      operation.controller.signal,
    );
    const screened = screenPackageEgressDestination({
      hostname,
      answers,
      hostIdentities: preConnectIdentities,
      nat64Prefixes: effectivePrefixes,
    });
    assertClientActive(client);

    const connectDeadline = Math.min(client.deadline, clock.now() + limits.connectTimeoutMs);
    const { controller } = operation;
    pendingDials.add(controller);
    let rawSocket: Socket;
    try {
      rawSocket = await withTimeout(
        () =>
          dialSelectedAddress({
            hostname: screened.hostname,
            address: screened.selected.address,
            family: screened.selected.family,
            port: 443,
            signal: controller.signal,
          }),
        remainingTimeout(client, limits.connectTimeoutMs, 'connect', connectDeadline),
        'connect',
        () => controller.abort(),
        controller.signal,
      );
    } finally {
      pendingDials.delete(controller);
    }
    operation.socket = rawSocket;
    activeUpstreamSockets.add(rawSocket);
    rawSocket.once('close', () => activeUpstreamSockets.delete(rawSocket));
    rawSocket.on('error', () => undefined);
    try {
      assertClientActive(client);
      const preBytesIdentities = await withTimeout(
        identityProvider,
        remainingTimeout(client, limits.dnsTimeoutMs, 'host identity', connectDeadline),
        'host identity',
        undefined,
        operation.controller.signal,
      );
      assertPackageEgressAddressStillAllowed(screened.selected, preBytesIdentities, effectivePrefixes);
      assertClientActive(client);
      const secureSocket = tls.connect({
        socket: rawSocket,
        servername: screened.hostname,
        ca: options.testHooks?.upstreamCa,
        rejectUnauthorized: true,
      });
      operation.socket = secureSocket;
      await withTimeout(
        () => onceSecure(secureSocket),
        remainingTimeout(client, limits.connectTimeoutMs, 'connect', connectDeadline),
        'connect',
        undefined,
        operation.controller.signal,
      );
      resetIdleTimer(client);
      return secureSocket;
    } catch (error) {
      rawSocket.destroy();
      throw error;
    }
  }

  return {
    get snapshot(): PackageEgressLedgerSnapshot {
      return ledger.snapshot;
    },
    start(target): Promise<PackageEgressListenAddress> {
      return serializeLifecycle(async () => {
        if (stopped) throw new Error('package egress proxy cannot restart after stop');
        if (started) throw new Error('package egress proxy is already started');
        const normalizedTarget = normalizeListenTarget(target);
        const path = normalizedTarget.socketPath;
        if (path !== undefined) await assertSocketPathAbsent(socketFilesystem, path);
        let ownership: SocketOwnership | undefined;
        tcpListener = path === undefined;
        try {
          await audit.start();
          if (path === undefined) {
            const boundPort = await listenOnTcp(outerServer, normalizedTarget.listenPort);
            started = true;
            return { port: boundPort };
          }
          await listenOnSocket(outerServer, path);
          const bound = await socketFilesystem.lstat(path);
          if (!bound.isSocket()) throw new Error('package egress bind did not create a socket');
          ownership = { dev: bound.dev, ino: bound.ino };
          await socketFilesystem.chmod(path, 0o600);
          const verified = await socketFilesystem.lstat(path);
          if (!verified.isSocket() || !sameOwnership(ownership, verified) || (verified.mode & 0o777) !== 0o600) {
            throw new Error('package egress socket identity or mode changed during startup');
          }
          socketPath = path;
          socketOwnership = ownership;
          started = true;
          return { socketPath: path };
        } catch (error) {
          if (ownership === undefined || path === undefined) await closeServer(outerServer);
          else await closeOwnedSocketServer(outerServer, socketFilesystem, path, ownership);
          await audit.stop().catch(() => undefined);
          tcpListener = false;
          throw error;
        }
      });
    },
    stop(): Promise<void> {
      stopCompletion ??= serializeLifecycle(async () => {
        stopped = true;
        ledger.stop();
        for (const controller of pendingDials) controller.abort();
        for (const request of activeRequests) request.destroy();
        for (const response of activeResponses) response.destroy();
        for (const socket of activeUpstreamSockets) socket.destroy();
        for (const socket of activeTlsSockets) socket.destroy();
        for (const context of contexts.values()) closeClient(context);
        for (const operation of activeOperations) operation.destroy();
        await Promise.all([
          closeServer(innerServer),
          socketPath !== undefined && socketOwnership !== undefined
            ? closeOwnedSocketServer(outerServer, socketFilesystem, socketPath, socketOwnership)
            : closeServer(outerServer),
        ]);
        await waitForSettled(
          () =>
            contexts.size === 0 &&
            activeTlsSockets.size === 0 &&
            activeRequests.size === 0 &&
            activeResponses.size === 0 &&
            activeUpstreamSockets.size === 0 &&
            activeOperations.size === 0 &&
            pendingDials.size === 0,
        );
        const snapshot = ledger.snapshot;
        if (snapshot.activeClients !== 0 || snapshot.activeUpstreams !== 0) {
          throw new Error('package egress shutdown left active ledger leases');
        }
        if (socketPath !== undefined && socketOwnership !== undefined) {
          await unlinkOwnedSocket(socketFilesystem, socketPath, socketOwnership);
        }
        await audit.stop();
      });
      return stopCompletion;
    },
  };

  function closeClient(context: ClientContext): void {
    if (context.closed) return;
    context.closed = true;
    contexts.delete(context.socket);
    clearTimeout(context.absoluteTimer);
    clearTimeout(context.idleTimer);
    clearHandshake(context);
    for (const operation of context.upstreams) operation.destroy();
    context.inboundTls?.destroy();
    context.socket.destroy();
    context.lease.release();
  }

  function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = lifecycleTail.then(operation, operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function clearHandshake(context: ClientContext): void {
    if (context.handshake === undefined) return;
    clearTimeout(context.handshake.timer);
    context.handshake = undefined;
  }

  function resetIdleTimer(context: ClientContext): void {
    if (context.closed) return;
    clearTimeout(context.idleTimer);
    context.idleTimer = setTimeout(() => closeClient(context), limits.idleTimeoutMs);
  }

  function assertClientActive(client: ClientContext): void {
    if (stopped || client.closed || !contexts.has(client.socket)) {
      throw new PackageEgressError(408, 'package egress client disconnected');
    }
  }

  function remainingTimeout(
    client: ClientContext,
    phaseMaximumMs: number,
    label: string,
    phaseDeadline = Number.POSITIVE_INFINITY,
  ): number {
    const remaining = Math.min(client.deadline, phaseDeadline) - clock.now();
    if (remaining <= 0) throw new PackageEgressError(504, `package egress ${label} timeout`);
    return Math.min(phaseMaximumMs, remaining);
  }

  function registerOperation(client: ClientContext, lease: PackageEgressUpstreamLease): UpstreamOperation {
    let released = false;
    const operation: UpstreamOperation = {
      client,
      lease,
      controller: new AbortController(),
      release(): void {
        if (released) return;
        released = true;
        lease.release();
        client.upstreams.delete(operation);
        activeOperations.delete(operation);
      },
      destroy(): void {
        operation.controller.abort();
        operation.response?.destroy();
        operation.request?.destroy();
        operation.socket?.destroy();
        operation.release();
      },
    };
    client.upstreams.add(operation);
    activeOperations.add(operation);
    return operation;
  }
}

function derivedMetadataRoute(pkg: PackageIdentity): PackageEgressRoute {
  switch (pkg.registry) {
    case 'npm':
      return {
        ecosystem: 'npm',
        host: 'registry.npmjs.org',
        path: pkg.scope === undefined ? `/${pkg.name}` : `/@${pkg.scope}%2f${pkg.name}`,
        kind: 'metadata',
        package: pkg,
      };
    case 'pypi':
      return {
        ecosystem: 'pypi',
        host: 'pypi.org',
        path: `/pypi/${pkg.name}/json`,
        kind: 'metadata',
        package: pkg,
      };
    case 'cargo':
      return {
        ecosystem: 'cargo',
        host: 'index.crates.io',
        path: `/${cargoSparseIndexPath(pkg.name)}`,
        kind: 'metadata',
        package: pkg,
      };
    case 'debian':
      throw new PackageEgressError(500, 'Debian package policy does not use derived metadata');
  }
}

function parseRequestedVersionTimestamp(pkg: PackageIdentity, body: Buffer): Date | undefined {
  if (pkg.version === undefined) throw new PackageEgressError(502, 'package artifact omitted its exact version');
  if (pkg.registry === 'cargo') {
    let found = false;
    let timestamp: Date | undefined;
    for (const rawLine of body.toString('utf8').split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const entry = parseJsonRecord(line, 'Cargo sparse-index line');
      if (entry.vers !== pkg.version) continue;
      if (found) throw new PackageEgressError(502, 'package metadata repeated the requested Cargo version');
      found = true;
      timestamp = parseOptionalTimestamp(entry.pubtime);
    }
    if (!found) throw new PackageEgressError(403, 'requested package version is absent from Cargo metadata');
    return timestamp;
  }

  const document = parseJsonRecord(body.toString('utf8'), 'package metadata');
  if (pkg.registry === 'npm') {
    const versions = asRecord(document.versions);
    if (versions === undefined || !Object.hasOwn(versions, pkg.version)) {
      throw new PackageEgressError(403, 'requested package version is absent from npm metadata');
    }
    const timestamps = asRecord(document.time);
    return timestamps === undefined ? undefined : parseOptionalTimestamp(timestamps[pkg.version]);
  }
  if (pkg.registry === 'pypi') {
    const releases = asRecord(document.releases);
    const files = releases?.[pkg.version];
    if (!Array.isArray(files)) {
      throw new PackageEgressError(403, 'requested package version is absent from PyPI metadata');
    }
    let earliest: Date | undefined;
    for (const file of files) {
      const record = asRecord(file);
      const observed = parseOptionalTimestamp(record?.upload_time_iso_8601);
      if (observed !== undefined && (earliest === undefined || observed < earliest)) earliest = observed;
    }
    return earliest;
  }
  throw new PackageEgressError(500, 'unsupported package metadata ecosystem');
}

function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new PackageEgressError(502, `${label} is not valid JSON`, { cause: error });
  }
  const record = asRecord(value);
  if (record === undefined) throw new PackageEgressError(502, `${label} is not a JSON object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseOptionalTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : undefined;
}

function boundedAuditReason(reason: string): string {
  let result = '';
  for (const character of reason) {
    if (result.length >= MAX_AUDIT_REASON_CHARACTERS) break;
    const code = character.charCodeAt(0);
    result += code <= 0x1f || code === 0x7f ? ' ' : character;
  }
  return result;
}

function isStrictOriginPath(path: string, maxTargetBytes: number): boolean {
  return (
    path.startsWith('/') &&
    Buffer.byteLength(path) <= maxTargetBytes &&
    !path.includes('?') &&
    !path.includes('#') &&
    !path.includes('\\') &&
    !path.includes('//') &&
    !hasMalformedPercentEncoding(path) &&
    !containsControlCharacter(path)
  );
}

function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    if (!/^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) return true;
    index += 2;
  }
  return false;
}

function hasNonCanonicalDebianArtifactEncoding(path: string): boolean {
  const filenameStart = path.lastIndexOf('/') + 1;
  const filename = path.slice(filenameStart);
  const firstUnderscore = filename.indexOf('_');
  const lastUnderscore = filename.lastIndexOf('_');
  if (firstUnderscore < 1 || lastUnderscore <= firstUnderscore) return true;
  const versionStart = filenameStart + firstUnderscore + 1;
  const versionEnd = filenameStart + lastUnderscore;
  if (/[+~:]/u.test(path.slice(versionStart, versionEnd))) return true;
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== '%') continue;
    if (index < versionStart || index + 3 > versionEnd) return true;
    const encoded = path.slice(index, index + 3);
    if (encoded !== '%2b' && encoded !== '%7e' && encoded !== '%3a') return true;
    index += 2;
  }
  return false;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isExactHealthRequest(request: http.IncomingMessage): boolean {
  return (
    request.method === 'GET' &&
    request.url === HEALTH_URL &&
    request.headers.host === HEALTH_HOST &&
    request.headers['content-length'] === undefined &&
    request.headers['transfer-encoding'] === undefined &&
    !hasCredentialHeader(request)
  );
}

function assertBodylessCredentialFreeRequest(request: http.IncomingMessage): void {
  if (request.headers['content-length'] !== undefined || request.headers['transfer-encoding'] !== undefined) {
    throw new PackageEgressError(403, 'package egress rejects request bodies');
  }
  if (hasCredentialHeader(request)) {
    throw new PackageEgressError(403, 'package egress rejects credential-bearing requests');
  }
}

function assertPackageMethod(method: string | undefined): void {
  if (method !== 'GET' && method !== 'HEAD') {
    throw new PackageEgressError(403, 'package egress allows only GET and HEAD');
  }
}

function hasCredentialHeader(request: http.IncomingMessage): boolean {
  return request.rawHeaders.some(
    (_value, index) => index % 2 === 0 && CREDENTIAL_HEADERS.has(request.rawHeaders[index].toLowerCase()),
  );
}

function parseConnectAuthority(target: string | undefined, hostHeader: string | undefined): string {
  if (target === undefined || hostHeader !== target) {
    throw new PackageEgressError(403, 'package egress CONNECT Host must exactly equal its authority');
  }
  const match = target.match(/^([a-z0-9.-]+):443$/u);
  if (match === null || !HOST_ECOSYSTEM.has(match[1])) {
    throw new PackageEgressError(403, 'package egress CONNECT authority is not a fixed package host on port 443');
  }
  return match[1];
}

function parsePlainHttpTarget(request: http.IncomingMessage): { readonly host: string; readonly path: string } {
  let parsed: URL;
  try {
    parsed = new URL(request.url ?? '');
  } catch {
    throw new PackageEgressError(403, 'package egress plain HTTP requires an absolute package URL');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    request.headers.host !== parsed.hostname ||
    parsed.hostname !== parsed.host ||
    request.url !== `http://${parsed.hostname}${parsed.pathname}`
  ) {
    throw new PackageEgressError(403, 'package egress plain HTTP authority is not canonical');
  }
  return { host: parsed.hostname, path: parsed.pathname };
}

export interface CanonicalPackageEgressRedirect {
  readonly location: string;
  readonly route: PackageEgressRoute;
}

/** Validate one Location without following it and return canonical client-visible metadata. */
export function canonicalizePackageEgressRedirect(
  source: PackageEgressRoute,
  location: string,
  maxTargetBytes = DEFAULT_PACKAGE_EGRESS_LIMITS.maxTargetBytes,
): CanonicalPackageEgressRedirect {
  let target: URL;
  try {
    target = new URL(location, `https://${source.host}${source.path}`);
  } catch {
    throw new PackageEgressError(502, 'package egress received a malformed redirect');
  }
  if (
    target.protocol !== 'https:' ||
    target.username !== '' ||
    target.password !== '' ||
    target.hash !== '' ||
    target.port !== '' ||
    target.search !== '' ||
    target.hostname !== target.host
  ) {
    throw new PackageEgressError(502, 'package egress redirect authority is not canonical HTTPS');
  }
  const route = classifyPackageEgressRoute(target.hostname, target.pathname, maxTargetBytes);
  if (route === undefined || route.ecosystem !== source.ecosystem) {
    throw new PackageEgressError(502, 'package egress redirect left its fixed package ecosystem');
  }
  if (source.ecosystem === 'debian') {
    const sourceFamily = debianRepositoryFamily(source);
    const targetFamily = debianRepositoryFamily(route);
    if (sourceFamily === undefined || targetFamily !== sourceFamily) {
      throw new PackageEgressError(502, 'package egress redirect changed Debian repository family');
    }
    if (source.host !== route.host && source.path !== route.path) {
      throw new PackageEgressError(502, 'cross-host Debian redirect changed its exact repository path');
    }
  }
  if (!samePackageIdentity(source.package, route.package)) {
    throw new PackageEgressError(502, 'package egress redirect changed package identity');
  }
  if (
    (source.kind === 'artifact' && route.kind !== 'artifact') ||
    (source.kind === 'bootstrap' && route.kind !== 'bootstrap')
  ) {
    throw new PackageEgressError(502, 'package egress redirect changed route kind');
  }
  return { location: `https://${route.host}${route.path}`, route };
}

function debianRepositoryFamily(route: PackageEgressRoute): 'ordinary' | 'security' | undefined {
  if (route.ecosystem !== 'debian') return undefined;
  if (route.path.startsWith('/debian-security/')) return 'security';
  if (route.path.startsWith('/debian/')) return 'ordinary';
  return undefined;
}

function samePackageIdentity(left: PackageIdentity | undefined, right: PackageIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.registry === right.registry &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    (left.scope ?? '').toLowerCase() === (right.scope ?? '').toLowerCase() &&
    (left.version === undefined || right.version === undefined || left.version === right.version)
  );
}

function sanitizeResponseHeaders(
  headers: http.IncomingHttpHeaders,
  canonicalRedirect?: string,
): http.OutgoingHttpHeaders {
  const sanitized: http.OutgoingHttpHeaders = { Connection: 'close' };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && RESPONSE_HEADERS.has(name.toLowerCase())) sanitized[name] = value;
  }
  if (canonicalRedirect !== undefined) sanitized.Location = canonicalRedirect;
  return sanitized;
}

function singleHeader(value: string | string[] | undefined, label: string): string | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new PackageEgressError(502, `package egress ${label} is ambiguous`);
    return value[0];
  }
  return value;
}

function parseDeclaredLength(value: string | string[] | undefined): number | undefined {
  const raw = singleHeader(value, 'Content-Length');
  if (raw === undefined) return undefined;
  if (!/^\d+$/u.test(raw)) throw new PackageEgressError(502, 'package egress upstream Content-Length is invalid');
  const length = Number(raw);
  if (!Number.isSafeInteger(length))
    throw new PackageEgressError(502, 'package egress upstream Content-Length is invalid');
  return length;
}

function estimateIncomingResponseHeaderBytes(response: http.IncomingMessage): number {
  let bytes = Buffer.byteLength(`HTTP/${response.httpVersion} ${response.statusCode ?? 502}\r\n\r\n`);
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    bytes += Buffer.byteLength(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
  }
  return bytes;
}

function estimateOutgoingResponseHeaderBytes(status: number, headers: http.OutgoingHttpHeaders): number {
  let bytes = Buffer.byteLength(`HTTP/1.1 ${status}\r\n\r\n`);
  for (const [name, value] of Object.entries(headers)) bytes += Buffer.byteLength(`${name}: ${String(value)}\r\n`);
  return bytes;
}

function estimateOutboundRequestBytes(method: string | undefined, route: PackageEgressRoute): number {
  return Buffer.byteLength(
    `${method ?? ''} ${route.path} HTTP/1.1\r\n` +
      `Host: ${route.host}\r\n` +
      'Accept: */*\r\n' +
      'Accept-Encoding: identity\r\n' +
      `User-Agent: ${FIXED_USER_AGENT}\r\n` +
      'Connection: close\r\n\r\n',
  );
}

function estimateResponseBytes(status: number, headers: Readonly<Record<string, string>>, body: string): number {
  let bytes = Buffer.byteLength(`HTTP/1.1 ${status}\r\n\r\n${body}`);
  for (const [name, value] of Object.entries(headers)) bytes += Buffer.byteLength(`${name}: ${value}\r\n`);
  return bytes;
}

interface PackageEgressByteLease {
  charge(bytes: number): boolean;
}

function rejectPackageError(response: http.ServerResponse, error: unknown, lease: PackageEgressByteLease): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  rejectResponse(response, packageErrorStatus(error), packageErrorMessage(error), lease);
}

function packageErrorStatus(error: unknown): number {
  return error instanceof PackageEgressError ? error.status : 502;
}

function packageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejectResponse(
  response: http.ServerResponse,
  status: number,
  message: string,
  lease?: PackageEgressByteLease,
): void {
  const body = `${message}\n`;
  if (lease !== undefined && !lease.charge(estimateResponseBytes(status, { 'Content-Type': 'text/plain' }, body))) {
    response.destroy();
    return;
  }
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    Connection: 'close',
  });
  response.end(body);
}

function rejectRaw(socket: Duplex, status: number, message: string, lease?: PackageEgressByteLease): void {
  if (socket.destroyed) return;
  const response = `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  if (lease !== undefined && !lease.charge(Buffer.byteLength(response))) {
    socket.destroy();
    return;
  }
  socket.end(response);
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function defaultPackageEgressDial(request: PackageEgressDialRequest): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: request.address,
      port: request.port,
      family: request.family,
      signal: request.signal,
    });
    const onError = (error: Error): void => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

function onceSecure(socket: tls.TLSSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    socket.once('error', onError);
    socket.once('secureConnect', () => {
      socket.off('error', onError);
      resolve();
    });
  });
}

function withTimeout<T>(
  operation: () => Promise<T>,
  milliseconds: number,
  label: string,
  onTimeout?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PackageEgressError(408, 'package egress operation aborted'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      onTimeout?.();
      reject(new PackageEgressError(504, `package egress ${label} timeout`));
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

function listenOnSocket(server: http.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(path, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function listenOnTcp(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('package egress TCP listener did not return an IP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function normalizeListenTarget(target: PackageEgressListenTarget): PackageEgressListenTarget {
  // Keep the runtime boundary fail-closed for untyped JavaScript callers too.
  const candidate: { readonly socketPath?: unknown; readonly listenPort?: unknown } = target;
  const { socketPath, listenPort } = candidate;
  if (typeof socketPath === 'string') {
    if (listenPort !== undefined) {
      throw new Error('package egress requires exactly one UDS path or TCP listen port');
    }
    if (!socketPath.startsWith('/')) throw new Error('package egress requires an absolute UDS path');
    return { socketPath };
  }
  if (socketPath !== undefined || typeof listenPort !== 'number') {
    throw new Error('package egress requires exactly one UDS path or TCP listen port');
  }
  if (!Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65_535) {
    throw new Error('package egress requires a TCP listen port from 0 through 65535');
  }
  return { listenPort };
}

async function assertSocketPathAbsent(filesystem: PackageEgressSocketFilesystem, path: string): Promise<void> {
  try {
    await filesystem.lstat(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  throw new Error(`package egress refuses to replace preexisting path ${path}`);
}

async function unlinkOwnedSocket(
  filesystem: PackageEgressSocketFilesystem,
  path: string,
  ownership: SocketOwnership,
): Promise<void> {
  let current: Pick<Stats, 'dev' | 'ino' | 'isSocket'>;
  try {
    current = await filesystem.lstat(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (current.isSocket() && sameOwnership(ownership, current)) await filesystem.unlink(path);
}

async function closeOwnedSocketServer(
  server: http.Server,
  filesystem: PackageEgressSocketFilesystem,
  path: string,
  ownership: SocketOwnership,
): Promise<void> {
  // Node removes a bound UDS by pathname during server.close(). If an
  // attacker has replaced that name, move the replacement aside first and
  // restore it after close so Node can never unlink an inode we do not own.
  const preservedPath = await preserveUnownedPath(filesystem, path, ownership);
  try {
    await closeServer(server);
    await unlinkOwnedSocket(filesystem, path, ownership);
  } finally {
    if (preservedPath !== undefined) await restorePreservedPath(filesystem, path, preservedPath);
  }
}

async function preserveUnownedPath(
  filesystem: PackageEgressSocketFilesystem,
  path: string,
  ownership: SocketOwnership,
): Promise<string | undefined> {
  let current: Pick<Stats, 'dev' | 'ino' | 'isSocket'>;
  try {
    current = await filesystem.lstat(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  if (current.isSocket() && sameOwnership(ownership, current)) return undefined;
  const preservedPath = `${path}.ironcurtain-preserved-${process.pid}-${randomUUID()}`;
  await filesystem.rename(path, preservedPath);
  return preservedPath;
}

async function restorePreservedPath(
  filesystem: PackageEgressSocketFilesystem,
  path: string,
  preservedPath: string,
): Promise<void> {
  try {
    await filesystem.lstat(path);
  } catch (error) {
    if (isEnoent(error)) {
      await filesystem.rename(preservedPath, path);
      return;
    }
    throw error;
  }
  throw new Error(`package egress could not restore preserved replacement ${preservedPath}`);
}

function sameOwnership(ownership: SocketOwnership, stat: Pick<Stats, 'dev' | 'ino'>): boolean {
  return ownership.dev === stat.dev && ownership.ino === stat.ino;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function waitForSettled(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('package egress shutdown did not settle');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
