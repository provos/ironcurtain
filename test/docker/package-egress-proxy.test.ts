import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, lstat, rename, unlink } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as tls from 'node:tls';
import forge from 'node-forge';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOrCreateCA, randomSerialNumber, type CertificateAuthority } from '../../src/docker/ca.js';
import { createPackageValidator } from '../../src/docker/package-validator.js';
import {
  canonicalizePackageEgressRedirect,
  classifyPackageEgressRoute,
  createPackageEgressProxy,
  PACKAGE_EGRESS_HEALTH_BODY,
  PACKAGE_EGRESS_HEALTH_REQUEST,
  type CreatePackageEgressProxyOptions,
  type PackageEgressDialRequest,
  type PackageEgressAuthorizer,
  type PackageEgressProxy,
} from '../../src/docker/package-egress-proxy.js';

const resources: Array<() => Promise<void> | void> = [];
let caDir: string;
let ca: CertificateAuthority;
let upstreamCredentials: { readonly key: string; readonly cert: string };
let socketCounter = 0;
let auditCounter = 0;

beforeAll(() => {
  caDir = mkdtempSync(join(tmpdir(), 'ironcurtain-package-egress-ca-'));
  ca = loadOrCreateCA(caDir);
  upstreamCredentials = createUpstreamCredentials(ca);
});

afterAll(() => rmSync(caDir, { recursive: true, force: true }));

afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

describe('strict package route grammar', () => {
  it.each([
    ['registry.npmjs.org', '/express', 'npm', 'metadata'],
    ['registry.npmjs.org', '/@types/node', 'npm', 'metadata'],
    ['registry.npmjs.org', '/express/-/express-4.21.0.tgz', 'npm', 'artifact'],
    ['pypi.org', '/simple/requests/', 'pypi', 'metadata'],
    ['files.pythonhosted.org', `/packages/aa/bb/${'c'.repeat(64)}/requests-2.32.0.tar.gz`, 'pypi', 'artifact'],
    ['deb.debian.org', '/debian/dists/bookworm/InRelease', 'debian', 'metadata'],
    ['deb.debian.org', '/debian/dists/bookworm/main/binary-arm64/Packages.xz', 'debian', 'metadata'],
    ['deb.debian.org', '/debian/pool/main/c/curl/curl_8.1.0-1_arm64.deb', 'debian', 'artifact'],
    ['deb.debian.org', '/debian-security/dists/bookworm-security/InRelease', 'debian', 'metadata'],
    [
      'deb.debian.org',
      `/debian-security/dists/bookworm-security/main/binary-arm64/by-hash/SHA256/${'a'.repeat(64)}`,
      'debian',
      'metadata',
    ],
    [
      'deb.debian.org',
      '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2bdeb12u15_arm64.deb',
      'debian',
      'artifact',
    ],
    ['security.debian.org', '/debian-security/dists/bookworm-security/InRelease', 'debian', 'metadata'],
    [
      'security.debian.org',
      '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2bdeb12u15_arm64.deb',
      'debian',
      'artifact',
    ],
    ['index.crates.io', '/config.json', 'cargo', 'bootstrap'],
    ['index.crates.io', '/se/rd/serde', 'cargo', 'metadata'],
    ['static.crates.io', '/crates/serde/serde-1.0.219.crate', 'cargo', 'artifact'],
    ['crates.io', '/api/v1/crates/serde/1.0.219/download', 'cargo', 'artifact'],
  ] as const)('accepts %s%s as an exact %s %s route', (host, path, ecosystem, kind) => {
    expect(classifyPackageEgressRoute(host, path)).toMatchObject({ host, path, ecosystem, kind });
  });

  it.each([
    ['example.com', '/express'],
    ['Registry.npmjs.org', '/express'],
    ['registry.npmjs.org', '/-/v1/search'],
    ['registry.npmjs.org', '/express?write=true'],
    ['registry.npmjs.org', '/express%2f..%2fsecret'],
    ['pypi.org', '/search/?q=secret'],
    ['pypi.org', '/pypi/requests/json'],
    ['files.pythonhosted.org', '/packages/not-a-hash/requests-2.0.tar.gz'],
    ['deb.debian.org', '/debian/project/trace/ftp-master.debian.org'],
    ['deb.debian.org', '/debian/pool/main/c/curl/curl_8.1.0%2fsecret_arm64.deb'],
    ['deb.debian.org', '/debian-security2/dists/bookworm-security/InRelease'],
    ['deb.debian.org', '/debian-security/project/trace/security-master.debian.org'],
    ['deb.debian.org', '/debian-security/dists/bookworm-security/InRelease/extra'],
    ['deb.debian.org', '/debian-security/pool/main/c/curl/curl_7.88.1-10+deb12u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2Bdeb12u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10+deb12u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_7.88.1~deb12u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_1:7.88.1-10_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%7Edeb12u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_1%3A7.88.1-10_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%252bdeb12u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2fdeb12u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl/curl_7%2e88.1-10_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c%2b/curl_7.88.1-10_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/cu%2brl_7.88.1-10_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl_7.88.1-10_arm%2b64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl%5f7.88.1-10_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl_7.88.1-10%20u15_arm64.deb'],
    ['deb.debian.org', '/debian-security/pool/updates/main/c/curl_7.88.1-10%2bdeb12u15_arm64.deb?download=1'],
    ['security.debian.org', '/debian/dists/bookworm/InRelease'],
    ['crates.io', '/api/v1/crates?page=secret'],
    ['index.crates.io', '/not/the/index'],
    ['static.crates.io', '/readme/serde'],
  ] as const)('rejects non-install route %s%s', (host, path) => {
    expect(classifyPackageEgressRoute(host, path)).toBeUndefined();
  });

  it('honors a caller-resolved target-byte ceiling instead of the default classifier ceiling', () => {
    expect(classifyPackageEgressRoute('registry.npmjs.org', '/express', 4)).toBeUndefined();
    expect(classifyPackageEgressRoute('registry.npmjs.org', '/express', 8)).toMatchObject({ kind: 'metadata' });
  });

  it('preserves exact canonical Debian artifact paths while decoding version %2b, %7e, and %3a', () => {
    const plusPath = '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2bdeb12u15_arm64.deb';
    expect(classifyPackageEgressRoute('deb.debian.org', plusPath)).toEqual({
      ecosystem: 'debian',
      host: 'deb.debian.org',
      path: plusPath,
      kind: 'artifact',
      package: { registry: 'debian', name: 'curl', version: '7.88.1-10+deb12u15' },
    });
    const epochPath = '/debian/pool/main/c/curl/curl_1%3a7.88.1%7ebpo12%2b1_arm64.deb';
    expect(classifyPackageEgressRoute('deb.debian.org', epochPath)).toMatchObject({
      path: epochPath,
      package: { registry: 'debian', name: 'curl', version: '1:7.88.1~bpo12+1' },
    });
  });

  it('preserves the exact Debian repository family across redirects', () => {
    const securityPath = '/debian-security/dists/bookworm-security/InRelease';
    const security = classifyPackageEgressRoute('deb.debian.org', securityPath);
    const ordinary = classifyPackageEgressRoute('deb.debian.org', '/debian/dists/bookworm/InRelease');
    if (security === undefined || ordinary === undefined) throw new Error('expected Debian fixture routes');

    expect(canonicalizePackageEgressRedirect(security, `https://security.debian.org${securityPath}`)).toEqual({
      location: `https://security.debian.org${securityPath}`,
      route: expect.objectContaining({ host: 'security.debian.org', path: securityPath }),
    });
    expect(() =>
      canonicalizePackageEgressRedirect(
        security,
        'https://security.debian.org/debian-security/dists/bookworm-security/Release',
      ),
    ).toThrow(/cross-host Debian redirect changed its exact repository path/u);
    expect(() =>
      canonicalizePackageEgressRedirect(security, 'https://deb.debian.org/debian/dists/bookworm/InRelease'),
    ).toThrow(/changed Debian repository family/u);
    expect(() =>
      canonicalizePackageEgressRedirect(ordinary, 'https://deb.debian.org/debian-security/dists/bookworm/InRelease'),
    ).toThrow(/changed Debian repository family/u);

    const encodedArtifactPath = '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2bdeb12u15_arm64.deb';
    const encodedArtifact = classifyPackageEgressRoute('deb.debian.org', encodedArtifactPath);
    if (encodedArtifact === undefined) throw new Error('expected encoded Debian artifact route');
    expect(
      canonicalizePackageEgressRedirect(encodedArtifact, `https://security.debian.org${encodedArtifactPath}`),
    ).toMatchObject({
      location: `https://security.debian.org${encodedArtifactPath}`,
      route: { host: 'security.debian.org', path: encodedArtifactPath },
    });
    for (const aliasPath of [
      encodedArtifactPath.replace('%2b', '+'),
      encodedArtifactPath.replace('%2b', '%2B'),
      encodedArtifactPath.replace('%2b', '%252b'),
    ]) {
      expect(() => canonicalizePackageEgressRedirect(encodedArtifact, `https://deb.debian.org${aliasPath}`)).toThrow(
        /left its fixed package ecosystem/u,
      );
    }
  });
});

describe('strict package egress proxy', () => {
  it('rejects a held-open forbidden CONNECT with exact framing, EOF, and zero active ledger state', async () => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    const authorize = vi.fn<PackageEgressAuthorizer>();
    const started = await startProxy(fixture.transport, authorize);
    const response = await rawUdsHeldOpenRequest(
      started.socketPath,
      'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n',
    );
    expect(response).toBe(
      'HTTP/1.1 403 package egress CONNECT authority is not a fixed package host on port 443\r\n' +
        'Connection: close\r\nContent-Length: 0\r\n\r\n',
    );
    await waitFor(() => started.proxy.snapshot.activeClients === 0);
    expect(started.proxy.snapshot).toMatchObject({
      attempts: 1,
      clientAttempts: 1,
      derivedAttempts: 0,
      activeClients: 0,
      activeDirect: 0,
      activeDerived: 0,
      activeUpstreams: 0,
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(fixture.transport.seen).toHaveLength(0);
  });

  it('serves a distinct charged health request without authorization or upstream work', async () => {
    const authorize = vi.fn<PackageEgressAuthorizer>();
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    const started = await startProxy(fixture.transport, authorize);
    expect((await lstat(started.socketPath)).mode & 0o777).toBe(0o600);

    const response = await rawUdsRequest(started.socketPath, PACKAGE_EGRESS_HEALTH_REQUEST);
    expect(response).toContain('HTTP/1.1 200 OK');
    expect(response.endsWith(PACKAGE_EGRESS_HEALTH_BODY)).toBe(true);
    await waitFor(() => started.proxy.snapshot.activeClients === 0);
    expect(started.proxy.snapshot).toMatchObject({
      clientAttempts: 1,
      activeClients: 0,
      activeUpstreams: 0,
    });
    expect(started.proxy.snapshot.transferredBytes).toBeGreaterThan(0);
    expect(authorize).not.toHaveBeenCalled();
    expect(fixture.transport.seen).toHaveLength(0);

    const nearMiss = PACKAGE_EGRESS_HEALTH_REQUEST.replace('ironcurtain.invalid', 'Ironcurtain.invalid');
    expect(await rawUdsRequest(started.socketPath, nearMiss)).toContain('403');
    expect(started.proxy.snapshot.clientAttempts).toBe(2);
  });

  it('MITM-forwards only an authorized exact CONNECT/SNI/Host route with fixed outbound headers', async () => {
    const upstreamHeaders: http.IncomingHttpHeaders[] = [];
    const fixture = await startFixture((request, response) => {
      upstreamHeaders.push(request.headers);
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'registry-secret=1',
        Authorization: 'Bearer upstream-secret',
      });
      response.end('{"name":"express"}');
    });
    const authorize = vi.fn<PackageEgressAuthorizer>(() => ({ status: 'allow', reason: 'fixture allow' }));
    const started = await startProxy(fixture.transport, authorize);

    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    expect(connected.statusCode).toBe(200);
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    const response = await makeHttpsRequest(connected.socket, 'registry.npmjs.org', {
      path: '/express',
      headers: { 'X-Workspace-Secret': 'must-not-forward' },
    });

    expect(response).toMatchObject({ statusCode: 200, body: '{"name":"express"}' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers.authorization).toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ ecosystem: 'npm', host: 'registry.npmjs.org', path: '/express', kind: 'metadata' }),
    );
    expect(fixture.transport.seen).toHaveLength(1);
    expect(fixture.transport.seen[0]).toMatchObject({
      destination: { protocol: 'https:', hostname: 'registry.npmjs.org', port: 443 },
      method: 'GET',
      path: '/express',
    });
    expect(fixture.transport.seen[0]?.headers).toMatchObject({
      host: 'registry.npmjs.org',
      accept: '*/*',
      'accept-encoding': 'identity',
      'user-agent': 'IronCurtain-Package-Egress/1',
      connection: 'close',
    });
    expect(upstreamHeaders[0]?.['x-workspace-secret']).toBeUndefined();

    const headConnection = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (headConnection.socket === null) throw new Error('expected CONNECT socket');
    const headResponse = await makeHttpsRequest(headConnection.socket, 'registry.npmjs.org', {
      method: 'HEAD',
      path: '/express/-/express-4.21.0.tgz',
    });
    expect(headResponse).toMatchObject({ statusCode: 200, body: '' });
    expect(fixture.transport.seen[1]?.method).toBe('HEAD');

    await waitFor(() => started.proxy.snapshot.activeUpstreams === 0);
    expect(started.proxy.snapshot).toMatchObject({ clientAttempts: 2, activeUpstreams: 0 });
    expect(started.proxy.snapshot.transferredBytes).toBeGreaterThan(0);
  });

  it('requires exact fixed CONNECT authority, TLS SNI, and inner Host', async () => {
    const fixture = await startFixture((_request, response) => response.end('ok'));
    const authorize: PackageEgressAuthorizer = () => ({ status: 'allow', reason: 'fixture allow' });
    const started = await startProxy(fixture.transport, authorize);

    expect((await sendConnect(started.socketPath, 'Registry.npmjs.org')).statusCode).toBe(403);
    expect((await sendConnect(started.socketPath, 'registry.npmjs.org', 444)).statusCode).toBe(403);
    expect((await sendConnect(started.socketPath, 'example.com')).statusCode).toBe(403);

    const wrongSni = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (wrongSni.socket === null) throw new Error('expected CONNECT socket');
    await expect(tlsHandshake(wrongSni.socket, 'pypi.org')).rejects.toThrow();

    const missingSni = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (missingSni.socket === null) throw new Error('expected CONNECT socket');
    await expect(tlsHandshakeWithoutSni(missingSni.socket)).rejects.toThrow();

    const wrongHost = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (wrongHost.socket === null) throw new Error('expected CONNECT socket');
    const response = await makeHttpsRequest(wrongHost.socket, 'registry.npmjs.org', {
      path: '/express',
      headers: { Host: 'pypi.org' },
    });
    expect(response.statusCode).toBe(403);
    expect(fixture.transport.seen).toHaveLength(0);
  });

  it('requires TLS 1.2 or newer and rejects renegotiation after the initial handshake', async () => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    const authorize = vi.fn<PackageEgressAuthorizer>(() => ({ status: 'allow', reason: 'fixture allow' }));
    const started = await startProxy(fixture.transport, authorize);

    const oldProtocol = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (oldProtocol.socket === null) throw new Error('expected CONNECT socket');
    await expect(tlsHandshakeWithMaximumVersion(oldProtocol.socket, 'registry.npmjs.org', 'TLSv1.1')).rejects.toThrow();

    const renegotiation = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (renegotiation.socket === null) throw new Error('expected CONNECT socket');
    await expectTls12RenegotiationRejection(renegotiation.socket, 'registry.npmjs.org');

    await waitFor(() => started.proxy.snapshot.activeClients === 0);
    expect(started.proxy.snapshot.activeUpstreams).toBe(0);
    expect(fixture.transport.activeSockets.size).toBe(0);
    expect(authorize).not.toHaveBeenCalled();
    expect(fixture.transport.seen).toHaveLength(0);
  });

  it('rejects methods, request bodies, credential headers, queries, and unknown routes before authorization', async () => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    const authorize = vi.fn<PackageEgressAuthorizer>(() => ({ status: 'allow', reason: 'fixture allow' }));
    const started = await startProxy(fixture.transport, authorize);
    const valid = 'http://deb.debian.org/debian/dists/bookworm/InRelease';

    const requests = [
      `POST ${valid} HTTP/1.1\r\nHost: deb.debian.org\r\nConnection: close\r\n\r\n`,
      `GET ${valid} HTTP/1.1\r\nHost: deb.debian.org\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      `GET ${valid} HTTP/1.1\r\nHost: deb.debian.org\r\nAuthorization: Bearer secret\r\nConnection: close\r\n\r\n`,
      `GET ${valid} HTTP/1.1\r\nHost: deb.debian.org\r\nProxy-Authorization: Basic secret\r\nConnection: close\r\n\r\n`,
      `GET ${valid} HTTP/1.1\r\nHost: deb.debian.org\r\nCookie: session=secret\r\nConnection: close\r\n\r\n`,
      `GET ${valid} HTTP/1.1\r\nHost: deb.debian.org\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
      `GET ${valid}?secret=data HTTP/1.1\r\nHost: deb.debian.org\r\nConnection: close\r\n\r\n`,
      'GET http://deb.debian.org/debian/project/trace/ftp-master HTTP/1.1\r\nHost: deb.debian.org\r\nConnection: close\r\n\r\n',
    ];
    for (const request of requests) {
      expect(await rawUdsRequest(started.socketPath, request)).toMatch(/HTTP\/1\.1 (?:403|400)/u);
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(fixture.transport.seen).toHaveLength(0);
  });

  it('requires explicit route authorization and supports exact plain-HTTP Debian inputs via HTTPS upstream', async () => {
    const fixture = await startFixture((_request, response) => response.end('release'));
    const deny = vi.fn<PackageEgressAuthorizer>(() => ({ status: 'deny', reason: 'blocked by package policy' }));
    const denied = await startProxy(fixture.transport, deny);
    const request =
      'GET http://deb.debian.org/debian/dists/bookworm/InRelease HTTP/1.1\r\n' +
      'Host: deb.debian.org\r\nConnection: close\r\n\r\n';
    expect(await rawUdsRequest(denied.socketPath, request)).toContain('403');

    const allowedFixture = await startFixture((_incoming, response) => response.end('release'));
    const allow: PackageEgressAuthorizer = () => ({ status: 'allow', reason: 'fixture allow' });
    const allowed = await startProxy(allowedFixture.transport, allow);
    expect(await rawUdsRequest(allowed.socketPath, request)).toContain('release');
    expect(allowedFixture.transport.seen[0]).toMatchObject({
      destination: { protocol: 'https:', hostname: 'deb.debian.org', port: 443 },
      path: '/debian/dists/bookworm/InRelease',
    });
  });

  it('allows and audits the exact deb.debian.org security archive while rejecting close path variants', async () => {
    const fixture = await startFixture((_request, response) => response.end('security-release'));
    const auditLogPath = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const started = await startPolicyProxy(fixture.transport, {
      auditLogPath,
      policy: { validator: createPackageValidator({ quarantineDays: 0 }) },
    });
    const allowedPath = '/debian-security/dists/bookworm-security/InRelease';
    const request =
      `GET http://deb.debian.org${allowedPath} HTTP/1.1\r\n` + 'Host: deb.debian.org\r\nConnection: close\r\n\r\n';
    expect(await rawUdsRequest(started.socketPath, request)).toContain('security-release');
    const allowedArtifactPath = '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2bdeb12u15_arm64.deb';
    const artifactRequest =
      `GET http://deb.debian.org${allowedArtifactPath} HTTP/1.1\r\n` +
      'Host: deb.debian.org\r\nConnection: close\r\n\r\n';
    expect(await rawUdsRequest(started.socketPath, artifactRequest)).toContain('security-release');

    for (const deniedPath of [
      '/debian-security2/dists/bookworm-security/InRelease',
      '/debian-security/project/trace/security-master.debian.org',
      '/debian-security/dists/bookworm-security/InRelease/extra',
      '/debian-security/pool/main/c/curl/curl_7.88.1-10+deb12u15_arm64.deb',
      '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2Bdeb12u15_arm64.deb',
      '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%252bdeb12u15_arm64.deb',
      '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2fdeb12u15_arm64.deb',
    ]) {
      const denied =
        `GET http://deb.debian.org${deniedPath} HTTP/1.1\r\n` + 'Host: deb.debian.org\r\nConnection: close\r\n\r\n';
      expect(await rawUdsRequest(started.socketPath, denied)).toContain('403');
    }

    expect(fixture.transport.seen).toEqual([
      expect.objectContaining({
        destination: { protocol: 'https:', hostname: 'deb.debian.org', port: 443 },
        path: allowedPath,
      }),
      expect.objectContaining({
        destination: { protocol: 'https:', hostname: 'deb.debian.org', port: 443 },
        path: allowedArtifactPath,
      }),
    ]);
    await started.proxy.stop();
    expect(readPackageAudit(auditLogPath)).toEqual([
      expect.objectContaining({
        decision: 'allow',
        reasonCode: 'client-metadata-unfiltered',
        method: 'GET',
        ecosystem: 'debian',
        host: 'deb.debian.org',
        path: allowedPath,
        routeKind: 'metadata',
        source: 'client',
      }),
      expect.objectContaining({
        decision: 'allow',
        reasonCode: 'debian-curated-epoch',
        method: 'GET',
        ecosystem: 'debian',
        host: 'deb.debian.org',
        path: allowedArtifactPath,
        routeKind: 'artifact',
        package: { name: 'curl', version: '7.88.1-10+deb12u15' },
        source: 'client',
      }),
    ]);
  });

  it('derives npm metadata for the exact artifact version and enforces fresh deny versus old allow', async () => {
    const requestedVersion = '1.0.0';
    const metadataTime = new Date(Date.now() - 60 * 60_000).toISOString();
    const fixture = await startFixture((request, response) => {
      if (request.url === '/demo') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({ versions: { [requestedVersion]: {} }, time: { [requestedVersion]: metadataTime } }),
        );
        return;
      }
      response.end('artifact-bytes');
    });
    const deniedAudit = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const denied = await startPolicyProxy(fixture.transport, {
      auditLogPath: deniedAudit,
      policy: { validator: createPackageValidator({ quarantineDays: 2 }) },
    });
    const deniedTunnel = await sendConnect(denied.socketPath, 'registry.npmjs.org');
    if (deniedTunnel.socket === null) throw new Error('expected CONNECT socket');
    const deniedResponse = await makeHttpsRequest(deniedTunnel.socket, 'registry.npmjs.org', {
      path: `/demo/-/demo-${requestedVersion}.tgz`,
    });
    expect(deniedResponse.statusCode).toBe(403);
    expect(fixture.transport.seen.map(({ path }) => path)).toEqual(['/demo']);
    await denied.proxy.stop();
    expect(readPackageAudit(deniedAudit)).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        decision: 'allow',
        reasonCode: 'derived-metadata-fetched',
        source: 'derived',
        method: 'GET',
        host: 'registry.npmjs.org',
        path: '/demo',
        package: { name: 'demo', version: requestedVersion },
      }),
      expect.objectContaining({
        decision: 'deny',
        reasonCode: 'policy-deny',
        source: 'client',
        path: `/demo/-/demo-${requestedVersion}.tgz`,
      }),
    ]);

    const oldFixture = await startFixture((request, response) => {
      if (request.url === '/demo') {
        response.end(
          JSON.stringify({
            versions: { [requestedVersion]: {} },
            time: { [requestedVersion]: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() },
          }),
        );
        return;
      }
      response.end('artifact-bytes');
    });
    const oldAudit = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const old = await startPolicyProxy(oldFixture.transport, {
      auditLogPath: oldAudit,
      policy: { validator: createPackageValidator({ quarantineDays: 2 }) },
    });
    const oldTunnel = await sendConnect(old.socketPath, 'registry.npmjs.org');
    if (oldTunnel.socket === null) throw new Error('expected CONNECT socket');
    expect(
      await makeHttpsRequest(oldTunnel.socket, 'registry.npmjs.org', {
        path: `/demo/-/demo-${requestedVersion}.tgz`,
      }),
    ).toMatchObject({ statusCode: 200, body: 'artifact-bytes' });
    expect(oldFixture.transport.seen.map(({ path }) => path)).toEqual([
      '/demo',
      `/demo/-/demo-${requestedVersion}.tgz`,
    ]);
    expect(old.proxy.snapshot).toMatchObject({ clientAttempts: 1, derivedAttempts: 1 });
  });

  it('keeps a derived metadata request alive while upstream chunks continue arriving', async () => {
    const requestedVersion = '1.0.0';
    const metadata = JSON.stringify({
      versions: { [requestedVersion]: {} },
      time: { [requestedVersion]: new Date(0).toISOString() },
    });
    const chunks = [metadata.slice(0, 1), metadata.slice(1, 2), metadata.slice(2, 3), metadata.slice(3)];
    const fixture = await startFixture((request, response) => {
      if (request.url !== '/demo') {
        response.end('artifact-bytes');
        return;
      }
      const timers: NodeJS.Timeout[] = [];
      response.write(chunks[0]);
      for (let index = 1; index < chunks.length; index += 1) {
        timers.push(
          setTimeout(() => {
            if (index === chunks.length - 1) response.end(chunks[index]);
            else response.write(chunks[index]);
          }, index * 150),
        );
      }
      response.once('close', () => {
        for (const timer of timers) clearTimeout(timer);
      });
    });
    const auditLogPath = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const started = await startPolicyProxy(fixture.transport, {
      auditLogPath,
      policy: { validator: createPackageValidator({ quarantineDays: 0 }) },
      limits: { idleTimeoutMs: 300, absoluteTimeoutMs: 2_000 },
    });
    const tunnel = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (tunnel.socket === null) throw new Error('expected CONNECT socket');

    expect(
      await makeHttpsRequest(tunnel.socket, 'registry.npmjs.org', {
        path: `/demo/-/demo-${requestedVersion}.tgz`,
      }),
    ).toMatchObject({ statusCode: 200, body: 'artifact-bytes' });
    expect(fixture.transport.seen.map(({ path }) => path)).toEqual(['/demo', `/demo/-/demo-${requestedVersion}.tgz`]);
  });

  it.each([
    {
      ecosystem: 'pypi',
      host: 'files.pythonhosted.org',
      artifact: `/packages/aa/bb/${'c'.repeat(64)}/demo-1.0.0.tar.gz`,
      metadataHost: 'pypi.org',
      metadataPath: '/pypi/demo/json',
      metadataBody: JSON.stringify({
        releases: { '1.0.0': [{ upload_time_iso_8601: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() }] },
      }),
    },
    {
      ecosystem: 'cargo',
      host: 'static.crates.io',
      artifact: '/crates/demo/demo-1.0.0.crate',
      metadataHost: 'index.crates.io',
      metadataPath: '/de/mo/demo',
      metadataBody: `${JSON.stringify({ name: 'demo', vers: '1.0.0', pubtime: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() })}\n`,
    },
  ])('uses an exact source-owned metadata GET for $ecosystem artifacts', async (sample) => {
    const fixture = await startFixture((request, response) => {
      response.end(request.url === sample.metadataPath ? sample.metadataBody : 'artifact-bytes');
    });
    const auditLogPath = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const started = await startPolicyProxy(fixture.transport, {
      auditLogPath,
      policy: { validator: createPackageValidator({ quarantineDays: 2 }) },
    });
    const tunnel = await sendConnect(started.socketPath, sample.host);
    if (tunnel.socket === null) throw new Error('expected CONNECT socket');
    expect(await makeHttpsRequest(tunnel.socket, sample.host, { path: sample.artifact })).toMatchObject({
      statusCode: 200,
      body: 'artifact-bytes',
    });
    expect(fixture.transport.seen.map(({ destination, method, path }) => [destination.hostname, method, path])).toEqual(
      [
        [sample.metadataHost, 'GET', sample.metadataPath],
        [sample.host, 'GET', sample.artifact],
      ],
    );
  });

  it('leaves recognized metadata unfiltered but makes artifact validation the policy backstop', async () => {
    const fixture = await startFixture((request, response) => {
      response.end(
        request.url === '/demo'
          ? JSON.stringify({ versions: { '1.0.0': {} }, time: { '1.0.0': new Date(0).toISOString() } })
          : 'artifact-bytes',
      );
    });
    const auditLogPath = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const started = await startPolicyProxy(fixture.transport, {
      auditLogPath,
      policy: { validator: createPackageValidator({ deniedPackages: ['demo'], quarantineDays: 0 }) },
    });
    const metadataTunnel = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (metadataTunnel.socket === null) throw new Error('expected metadata CONNECT socket');
    expect(await makeHttpsRequest(metadataTunnel.socket, 'registry.npmjs.org', { path: '/demo' })).toMatchObject({
      statusCode: 200,
    });
    const artifactTunnel = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (artifactTunnel.socket === null) throw new Error('expected artifact CONNECT socket');
    expect(
      await makeHttpsRequest(artifactTunnel.socket, 'registry.npmjs.org', {
        path: '/demo/-/demo-1.0.0.tgz',
      }),
    ).toMatchObject({ statusCode: 403 });
    expect(fixture.transport.seen.map(({ path }) => path)).toEqual(['/demo', '/demo']);
  });

  it('allows recognized artifacts without metadata or policy evaluation when package policy is disabled', async () => {
    const fixture = await startFixture((_request, response) => response.end('artifact-bytes'));
    const auditLogPath = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const started = await startPolicyProxy(fixture.transport, { auditLogPath });
    const tunnel = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (tunnel.socket === null) throw new Error('expected CONNECT socket');
    expect(
      await makeHttpsRequest(tunnel.socket, 'registry.npmjs.org', { path: '/blocked/-/blocked-1.0.0.tgz' }),
    ).toMatchObject({ statusCode: 200, body: 'artifact-bytes' });
    expect(fixture.transport.seen.map(({ path }) => path)).toEqual(['/blocked/-/blocked-1.0.0.tgz']);
    await started.proxy.stop();
    expect(readPackageAudit(auditLogPath)).toEqual([
      expect.objectContaining({
        decision: 'allow',
        reasonCode: 'policy-disabled',
        source: 'client',
        package: { name: 'blocked', version: '1.0.0' },
      }),
    ]);
  });

  it('bounds concurrent derived metadata and aborts the owned operation during stop', async () => {
    const fixture = await startFixture((request, response) => {
      if (request.url !== '/demo') throw new Error('artifact must not be contacted before metadata admission');
      // Deliberately leave the first metadata response open until proxy stop.
      void response;
    });
    const auditLogPath = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`);
    const started = await startPolicyProxy(fixture.transport, {
      auditLogPath,
      policy: { validator: createPackageValidator({ quarantineDays: 2 }) },
      limits: { maxConcurrentClients: 2, maxConcurrentDerived: 1, maxConcurrentUpstreams: 17 },
    });
    const firstTunnel = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (firstTunnel.socket === null) throw new Error('expected first CONNECT socket');
    const firstRequest = makeHttpsRequest(firstTunnel.socket, 'registry.npmjs.org', {
      path: '/demo/-/demo-1.0.0.tgz',
    }).catch((error: unknown) => error);
    await waitFor(() => fixture.transport.seen.length === 1);

    const secondTunnel = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (secondTunnel.socket === null) throw new Error('expected second CONNECT socket');
    expect(
      await makeHttpsRequest(secondTunnel.socket, 'registry.npmjs.org', {
        path: '/demo/-/demo-1.0.0.tgz',
      }),
    ).toMatchObject({ statusCode: 429 });
    expect(started.proxy.snapshot).toMatchObject({ derivedAttempts: 2, activeDerived: 1 });

    await started.proxy.stop();
    await firstRequest;
    expect(started.proxy.snapshot).toMatchObject({ stopped: true, activeDerived: 0, activeUpstreams: 0 });
    expect(fixture.transport.activeSockets.size).toBe(0);
    expect(readPackageAudit(auditLogPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: 'deny',
          reasonCode: 'derived-metadata-failed',
          source: 'derived',
        }),
      ]),
    );
  });

  it('returns one canonical allowed redirect without following it, then charges the next client request separately', async () => {
    const artifactPath = `/packages/aa/bb/${'c'.repeat(64)}/demo-1.0.0.tar.gz`;
    const fixture = await startFixture((request, response) => {
      if (request.headers.host === 'pypi.org') {
        response.writeHead(302, { Location: `https://files.pythonhosted.org${artifactPath}` });
        response.end('redirect-body');
        return;
      }
      response.end('package-bytes');
    });
    const authorize = vi.fn<PackageEgressAuthorizer>(() => ({ status: 'allow', reason: 'fixture allow' }));
    const started = await startProxy(fixture.transport, authorize);
    const connected = await sendConnect(started.socketPath, 'pypi.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    const response = await makeHttpsRequest(connected.socket, 'pypi.org', { path: '/simple/demo/' });

    expect(response).toMatchObject({
      statusCode: 302,
      body: 'redirect-body',
      headers: expect.objectContaining({ location: `https://files.pythonhosted.org${artifactPath}` }),
    });
    expect(fixture.transport.seen.map((entry) => entry.destination.hostname)).toEqual(['pypi.org']);
    expect(authorize).toHaveBeenCalledTimes(1);

    const redirected = await sendConnect(started.socketPath, 'files.pythonhosted.org');
    if (redirected.socket === null) throw new Error('expected redirect CONNECT socket');
    expect(
      await makeHttpsRequest(redirected.socket, 'files.pythonhosted.org', {
        path: artifactPath,
      }),
    ).toMatchObject({ statusCode: 200, body: 'package-bytes' });
    expect(fixture.transport.seen.map((entry) => entry.destination.hostname)).toEqual([
      'pypi.org',
      'files.pythonhosted.org',
    ]);
    expect(authorize).toHaveBeenCalledTimes(2);
    await waitFor(() => started.proxy.snapshot.activeUpstreams === 0);
    expect(started.proxy.snapshot).toMatchObject({ clientAttempts: 2, activeUpstreams: 0 });
  });

  it.each([
    ['cross-ecosystem', 'https://registry.npmjs.org/demo'],
    ['unknown route', 'https://pypi.org/search/demo'],
    ['query-bearing route', 'https://pypi.org/simple/demo/?secret=data'],
    ['credential authority', 'https://token@example.com/demo'],
  ])('rejects a %s redirect without contacting its target', async (_label, location) => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(302, { Location: location });
      response.end();
    });
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }));
    const connected = await sendConnect(started.socketPath, 'pypi.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    const response = await makeHttpsRequest(connected.socket, 'pypi.org', { path: '/simple/demo/' });
    expect(response.statusCode).toBe(502);
    expect(fixture.transport.seen).toHaveLength(1);
    await waitFor(() => started.proxy.snapshot.activeUpstreams === 0);
  });

  it('destroys and releases the direct operation on duplicate Location validation failure', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(302, {
        Location: ['https://pypi.org/simple/demo/', 'https://pypi.org/simple/demo/'],
      });
      response.end();
    });
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }));
    const connected = await sendConnect(started.socketPath, 'pypi.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    expect((await makeHttpsRequest(connected.socket, 'pypi.org', { path: '/simple/demo/' })).statusCode).toBe(502);
    await waitFor(() => started.proxy.snapshot.activeUpstreams === 0);
    expect(fixture.transport.activeSockets.size).toBe(0);
  });

  it.each([
    ['malformed', 'not-a-length'],
    ['duplicate', ['1', '1']],
  ])('destroys and releases the direct operation on %s Content-Length', async (_label, contentLength) => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Length': contentLength });
      response.end('x');
    });
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }));
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    const outcome = await makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' }).catch(
      () => undefined,
    );
    if (outcome !== undefined) expect(outcome.statusCode).toBe(502);
    await waitFor(() => started.proxy.snapshot.activeUpstreams === 0);
    await waitFor(() => fixture.transport.activeSockets.size === 0);
  });

  it('canonicalizes a relative same-route redirect and never consumes a second upstream slot', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(302, { Location: 'https://pypi.org/simple/demo/' });
      response.end();
    });
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }));
    const connected = await sendConnect(started.socketPath, 'pypi.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    const response = await makeHttpsRequest(connected.socket, 'pypi.org', { path: '/simple/demo/' });
    expect(response).toMatchObject({
      statusCode: 302,
      headers: expect.objectContaining({ location: 'https://pypi.org/simple/demo/' }),
    });
    expect(fixture.transport.seen).toHaveLength(1);
  });

  it('rejects legacy parent/delegated/re-resolving transports instead of accepting one as authority', () => {
    expect(() =>
      createPackageEgressProxy({
        ca,
        outboundTransport: { kind: 'fixed-parent-proxy' },
      } as CreatePackageEgressProxyOptions & { outboundTransport: { readonly kind: string } }),
    ).toThrow(/rejects delegated, parent, and re-resolving/u);
  });

  it('dials only the selected screened literal and refreshes identities before connect and before bytes', async () => {
    const fixture = await startFixture((_request, response) => response.end('ok'));
    const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const identities = vi.fn(async () => [] as string[]);
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      resolver,
      hostIdentityProvider: identities,
    });
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    expect(await makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' })).toMatchObject({
      statusCode: 200,
      body: 'ok',
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith('registry.npmjs.org');
    expect(identities).toHaveBeenCalledTimes(2);
    expect(fixture.transport.dials).toHaveLength(1);
    expect(fixture.transport.dials[0]).toMatchObject({
      hostname: 'registry.npmjs.org',
      address: '93.184.216.34',
      family: 4,
      port: 443,
    });
  });

  it('denies a destination that becomes current immediately before connect without dialing', async () => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    let inventories = 0;
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      hostIdentityProvider: async () => (++inventories === 1 ? ['8.8.8.8'] : []),
    });
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    expect((await makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' })).statusCode).toBe(502);
    expect(fixture.transport.dials).toHaveLength(0);
    expect(fixture.transport.seen).toHaveLength(0);
  });

  it('closes a pinned socket if the destination becomes current before request bytes', async () => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    let inventories = 0;
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      hostIdentityProvider: async () => (++inventories === 2 ? ['8.8.8.8'] : []),
    });
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    expect((await makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' })).statusCode).toBe(502);
    expect(fixture.transport.dials).toHaveLength(1);
    expect(fixture.transport.seen).toHaveLength(0);
  });

  it.each([
    ['well-known NAT64', '64:ff9b::a00:1', undefined],
    ['6to4', '2002:0a00:0001::', undefined],
    ['Teredo client', '2001:0000:0808:0808:0000:0000:f5ff:fffe', undefined],
    ['RFC 6052 /64', '2001:db9:1:2:000a:0001:0000:0', [{ prefix: '2001:db9:1:2::', length: 64 as const }]],
  ])('rejects a denied IPv4 identity embedded in %s before dialing', async (_label, address, nat64Prefixes) => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      resolver: async () => [{ address, family: 6 }],
      nat64Prefixes,
    });
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    expect((await makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' })).statusCode).toBe(502);
    expect(fixture.transport.dials).toHaveLength(0);
  });

  it('bounds TLS ClientHello bytes and handshake time before HTTP parsing', async () => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    const bytes = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { tlsHandshakeMaxBytes: 64 * 1024 },
    });
    const oversized = await sendConnect(bytes.socketPath, 'registry.npmjs.org');
    if (oversized.socket === null) throw new Error('expected CONNECT socket');
    oversized.socket.on('error', () => undefined);
    oversized.socket.write(Buffer.alloc(64 * 1024 + 1, 1));
    await onceClosed(oversized.socket);

    const timeoutFixture = await startFixture((_request, response) => response.end('not reached'));
    const timed = await startProxy(timeoutFixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { tlsHandshakeTimeoutMs: 25 },
    });
    const silent = await sendConnect(timed.socketPath, 'registry.npmjs.org');
    if (silent.socket === null) throw new Error('expected CONNECT socket');
    await onceClosed(silent.socket);
    expect(fixture.transport.dials).toHaveLength(0);
    expect(timeoutFixture.transport.dials).toHaveLength(0);
  });

  it('refuses to replace a regular file at the requested UDS path', async () => {
    const fixture = await startFixture((_request, response) => response.end());
    const proxy = createPackageEgressProxy({
      ca,
      auditLogPath: join(caDir, `package-egress-audit-${auditCounter++}.jsonl`),
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      hostIdentityProvider: async () => [],
      nat64PrefixProvider: async () => [],
      testHooks: {
        dialSelectedAddress: fixture.transport.dial,
        upstreamCa: ca.certPem,
        authorize: () => ({ status: 'allow', reason: 'fixture allow' }),
      },
    });
    resources.push(() => proxy.stop());
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-package-egress-path-'));
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'listener.sock');
    writeFileSync(path, 'do-not-replace');

    await expect(proxy.start(path)).rejects.toThrow(/refuses to replace preexisting/u);
    expect(readFileSync(path, 'utf8')).toBe('do-not-replace');
  });

  it('refuses to unlink a preexisting live socket', async () => {
    const fixture = await startFixture((_request, response) => response.end());
    const proxy = createTestProxy(fixture.transport);
    resources.push(() => proxy.stop());
    const directory = mkdtempSync('/tmp/icpe-existing-');
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'listener.sock');
    const owner = net.createServer();
    await listenUds(owner, path);
    resources.push(() => closeServer(owner));

    await expect(proxy.start(path)).rejects.toThrow(/preexisting/u);
    expect(owner.listening).toBe(true);
  });

  it('rolls back a bound socket after chmod failure and preserves a raced replacement', async () => {
    const fixture = await startFixture((_request, response) => response.end());
    const directory = mkdtempSync('/tmp/icpe-fault-');
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const chmodPath = join(directory, 'chmod.sock');
    const chmodFailure = createTestProxy(fixture.transport, {
      socketFilesystem: {
        lstat,
        rename,
        unlink,
        chmod: async () => {
          throw new Error('injected chmod failure');
        },
      },
    });
    resources.push(() => chmodFailure.stop());
    await expect(chmodFailure.start(chmodPath)).rejects.toThrow(/injected chmod/u);
    expect(existsSync(chmodPath)).toBe(false);

    const racePath = join(directory, 'race.sock');
    const replacement = 'preserve replacement';
    const raced = createTestProxy(fixture.transport, {
      socketFilesystem: {
        lstat,
        rename,
        unlink,
        chmod: async (path, mode) => {
          await chmod(path, mode);
          unlinkSync(path);
          writeFileSync(path, replacement);
        },
      },
    });
    resources.push(() => raced.stop());
    await expect(raced.start(racePath)).rejects.toThrow(/identity or mode changed/u);
    expect(readFileSync(racePath, 'utf8')).toBe(replacement);
  });

  it('unlinks only its captured inode and preserves a replacement raced before stop', async () => {
    const fixture = await startFixture((_request, response) => response.end());
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }));
    unlinkSync(started.socketPath);
    writeFileSync(started.socketPath, 'replacement');

    const firstStop = started.proxy.stop();
    const secondStop = started.proxy.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;
    expect(readFileSync(started.socketPath, 'utf8')).toBe('replacement');
  });

  it('stops an active response stream, drains every socket/lease, and removes its owned inode', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('held-open');
    });
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }));
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    const response = makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' }).catch(
      () => undefined,
    );
    await waitFor(() => fixture.transport.seen.length === 1);

    await started.proxy.stop();
    await response;
    expect(started.proxy.snapshot).toMatchObject({ activeClients: 0, activeUpstreams: 0, stopped: true });
    expect(existsSync(started.socketPath)).toBe(false);
  });

  it('aborts an idle upstream through its owning client well before the absolute deadline', async () => {
    const fixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('one-chunk');
    });
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { idleTimeoutMs: 250, absoluteTimeoutMs: 5_000 },
    });
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    const response = makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' }).catch(
      () => undefined,
    );
    await waitFor(() => fixture.transport.seen.length === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(started.proxy.snapshot).toMatchObject({ activeClients: 0, activeUpstreams: 0 });
    expect(fixture.transport.activeSockets.size).toBe(0);
    await response;
  });

  it('uses one remaining absolute deadline across repeated DNS and identity phases', async () => {
    const fixture = await startFixture((_request, response) => response.end('not reached'));
    const delayedIdentities = async (): Promise<string[]> => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return [];
    };
    const started = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { absoluteTimeoutMs: 50, idleTimeoutMs: 1_000, dnsTimeoutMs: 40 },
      resolver: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return [{ address: '93.184.216.34', family: 4 }];
      },
      hostIdentityProvider: delayedIdentities,
      nat64PrefixProvider: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return [];
      },
    });
    const connected = await sendConnect(started.socketPath, 'registry.npmjs.org');
    if (connected.socket === null) throw new Error('expected CONNECT socket');
    await makeHttpsRequest(connected.socket, 'registry.npmjs.org', { path: '/express' }).catch(() => undefined);
    await waitFor(() => started.proxy.snapshot.activeUpstreams === 0);
    expect(started.proxy.snapshot.activeClients).toBe(0);
    expect(fixture.transport.dials).toHaveLength(0);
  });

  it('serializes an immediate stop behind startup and leaves no listener or lease', async () => {
    const fixture = await startFixture((_request, response) => response.end());
    const proxy = createTestProxy(fixture.transport);
    resources.push(() => proxy.stop());
    const directory = mkdtempSync('/tmp/icpe-start-stop-');
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'listener.sock');

    const starting = proxy.start(path);
    const stopping = proxy.stop();
    await starting;
    await stopping;
    expect(existsSync(path)).toBe(false);
    expect(proxy.snapshot).toMatchObject({ stopped: true, activeClients: 0, activeUpstreams: 0 });
    await expect(proxy.start(path)).rejects.toThrow(/cannot restart/u);
  });

  it('enforces charged client attempts and concurrency on health traffic', async () => {
    const fixture = await startFixture((_request, response) => response.end());
    const attempts = await startProxy(fixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { maxAttempts: 1 },
    });
    expect(await rawUdsRequest(attempts.socketPath, PACKAGE_EGRESS_HEALTH_REQUEST)).toContain('200 OK');
    expect(await rawUdsRequest(attempts.socketPath, PACKAGE_EGRESS_HEALTH_REQUEST)).toContain('429');
    expect(attempts.proxy.snapshot.clientAttempts).toBe(2);

    const concurrencyFixture = await startFixture((_request, response) => response.end());
    const concurrency = await startProxy(
      concurrencyFixture.transport,
      () => ({ status: 'allow', reason: 'fixture allow' }),
      { limits: { maxConcurrentClients: 1 } },
    );
    const held = net.createConnection(concurrency.socketPath);
    await onceConnected(held);
    await waitFor(() => concurrency.proxy.snapshot.activeClients === 1);
    expect(await rawUdsRequest(concurrency.socketPath, PACKAGE_EGRESS_HEALTH_REQUEST)).toContain('429');
    expect(concurrency.proxy.snapshot).toMatchObject({ clientAttempts: 2, activeClients: 1 });
    held.destroy();

    const bytesFixture = await startFixture((_request, response) => response.end());
    const bytes = await startProxy(bytesFixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { maxBytesPerRequest: 64, maxSessionBytes: 64 },
    });
    expect(await rawUdsOutcome(bytes.socketPath, PACKAGE_EGRESS_HEALTH_REQUEST)).not.toContain(
      PACKAGE_EGRESS_HEALTH_BODY,
    );
    await waitFor(() => bytes.proxy.snapshot.activeClients === 0);
    expect(bytes.proxy.snapshot.transferredBytes).toBeGreaterThan(64);

    const timeFixture = await startFixture((_request, response) => response.end());
    const timed = await startProxy(timeFixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { absoluteTimeoutMs: 25, idleTimeoutMs: 25 },
    });
    const idle = net.createConnection(timed.socketPath);
    await onceConnected(idle);
    await onceClosed(idle);
    await waitFor(() => timed.proxy.snapshot.activeClients === 0);
  });

  it('enforces exact per-request byte and absolute time ceilings', async () => {
    const bytesFixture = await startFixture((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write('x'.repeat(8_192));
      response.end();
    });
    const bytes = await startProxy(bytesFixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { maxBytesPerRequest: 4_096, maxSessionBytes: 4_096 },
    });
    const byteClient = await sendConnect(bytes.socketPath, 'registry.npmjs.org');
    if (byteClient.socket === null) throw new Error('expected CONNECT socket');
    await makeHttpsRequest(byteClient.socket, 'registry.npmjs.org', { path: '/express' }).catch(() => undefined);
    await waitFor(() => bytes.proxy.snapshot.activeUpstreams === 0);
    expect(bytes.proxy.snapshot.transferredBytes).toBeGreaterThan(4_096);

    const timeoutFixture = await startFixture(() => undefined);
    const timeout = await startProxy(timeoutFixture.transport, () => ({ status: 'allow', reason: 'fixture allow' }), {
      limits: { absoluteTimeoutMs: 25, idleTimeoutMs: 25 },
    });
    const timeoutClient = await sendConnect(timeout.socketPath, 'registry.npmjs.org');
    if (timeoutClient.socket === null) throw new Error('expected CONNECT socket');
    const outcome = await makeHttpsRequest(timeoutClient.socket, 'registry.npmjs.org', { path: '/express' }).then(
      (response) => ({ kind: 'response' as const, response }),
      (error: unknown) => ({ kind: 'transport-error' as const, error }),
    );
    if (outcome.kind === 'response') {
      expect(outcome.response.statusCode).toBe(504);
    } else {
      expect(outcome.error).toBeInstanceOf(Error);
    }
    await waitFor(
      () =>
        timeout.proxy.snapshot.activeClients === 0 &&
        timeout.proxy.snapshot.activeUpstreams === 0 &&
        timeoutFixture.transport.activeSockets.size === 0,
    );
    expect(timeout.proxy.snapshot).toMatchObject({ clientAttempts: 1, activeClients: 0, activeUpstreams: 0 });
    expect(timeout.proxy.snapshot.transferredBytes).toBeGreaterThan(0);
  });
});

interface SeenFixtureRequest {
  readonly destination: { readonly protocol: 'https:'; readonly hostname: string; readonly port: 443 };
  readonly method?: string;
  readonly path?: string;
  readonly headers: http.IncomingHttpHeaders;
}

class FixtureTransport {
  readonly seen: SeenFixtureRequest[] = [];
  readonly dials: PackageEgressDialRequest[] = [];
  readonly activeSockets = new Set<net.Socket>();
  port = 0;

  readonly dial = async (request: PackageEgressDialRequest): Promise<net.Socket> => {
    this.dials.push(request);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: this.port, signal: request.signal });
      this.activeSockets.add(socket);
      socket.once('close', () => this.activeSockets.delete(socket));
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  };
}

async function startFixture(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ readonly server: https.Server; readonly transport: FixtureTransport }> {
  const transport = new FixtureTransport();
  const server = https.createServer(upstreamCredentials, (request, response) => {
    transport.seen.push({
      destination: {
        protocol: 'https:',
        hostname: request.headers.host ?? '',
        port: 443,
      },
      method: request.method,
      path: request.url,
      headers: request.headers,
    });
    handler(request, response);
  });
  const port = await listenTcp(server);
  transport.port = port;
  resources.push(() => closeServer(server));
  return { server, transport };
}

async function startProxy(
  transport: FixtureTransport,
  authorize: PackageEgressAuthorizer,
  overrides: Omit<CreatePackageEgressProxyOptions, 'ca' | 'auditLogPath' | 'policy' | 'testHooks'> = {},
): Promise<{ readonly proxy: PackageEgressProxy; readonly socketPath: string }> {
  const proxy = createTestProxy(transport, { ...overrides, authorize });
  const socketPath = join(tmpdir(), `ironcurtain-package-egress-${process.pid}-${socketCounter++}.sock`);
  await proxy.start(socketPath);
  resources.push(() => proxy.stop());
  return { proxy, socketPath };
}

async function startPolicyProxy(
  transport: FixtureTransport,
  options: {
    readonly policy?: CreatePackageEgressProxyOptions['policy'];
    readonly auditLogPath: string;
    readonly limits?: CreatePackageEgressProxyOptions['limits'];
  },
): Promise<{ readonly proxy: PackageEgressProxy; readonly socketPath: string }> {
  const proxy = createTestProxy(transport, {
    authorize: null,
    auditLogPath: options.auditLogPath,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const socketPath = join(tmpdir(), `ironcurtain-package-egress-${process.pid}-${socketCounter++}.sock`);
  await proxy.start(socketPath);
  resources.push(() => proxy.stop());
  return { proxy, socketPath };
}

function createTestProxy(
  transport: FixtureTransport,
  overrides: Omit<CreatePackageEgressProxyOptions, 'ca' | 'auditLogPath' | 'policy' | 'testHooks'> & {
    readonly authorize?: PackageEgressAuthorizer | null;
    readonly policy?: CreatePackageEgressProxyOptions['policy'];
    readonly auditLogPath?: string;
    readonly socketFilesystem?: NonNullable<CreatePackageEgressProxyOptions['testHooks']>['socketFilesystem'];
  } = {},
): PackageEgressProxy {
  const {
    socketFilesystem,
    authorize,
    auditLogPath = join(caDir, `package-egress-audit-${auditCounter++}.jsonl`),
    ...proxyOptions
  } = overrides;
  return createPackageEgressProxy({
    ca,
    auditLogPath,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    hostIdentityProvider: async () => [],
    nat64PrefixProvider: async () => [],
    testHooks: {
      dialSelectedAddress: transport.dial,
      upstreamCa: ca.certPem,
      socketFilesystem,
      ...(authorize === null ? {} : { authorize: authorize ?? (() => ({ status: 'allow', reason: 'fixture allow' })) }),
    },
    ...proxyOptions,
  });
}

function listenTcp(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fixture server did not bind TCP'));
        return;
      }
      resolve(address.port);
    });
  });
}

function listenUds(server: net.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

function closeServer(server: http.Server | https.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function readPackageAudit(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function rawUdsRequest(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

function rawUdsHeldOpenRequest(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('held-open UDS response did not reach EOF'));
    }, 2_000);
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('held-open UDS response exceeded its bound'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks, size).toString('utf8'));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function rawUdsOutcome(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

function sendConnect(
  socketPath: string,
  host: string,
  port = 443,
): Promise<{ readonly socket: net.Socket | null; readonly statusCode: number }> {
  return new Promise((resolve, reject) => {
    const authority = `${host}:${port}`;
    const request = http.request({ socketPath, method: 'CONNECT', path: authority, headers: { Host: authority } });
    request.on('connect', (response, socket) => resolve({ socket, statusCode: response.statusCode ?? 0 }));
    request.on('response', (response) => resolve({ socket: null, statusCode: response.statusCode ?? 0 }));
    request.on('error', reject);
    request.end();
  });
}

function makeHttpsRequest(
  socket: net.Socket,
  servername: string,
  options: { readonly method?: string; readonly path: string; readonly headers?: Readonly<Record<string, string>> },
): Promise<{ readonly statusCode: number; readonly headers: http.IncomingHttpHeaders; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ca: ca.certPem }, () => {
      const headers = { Host: servername, Connection: 'close', ...options.headers };
      const serialized = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join('\r\n');
      tlsSocket.write(`${options.method ?? 'GET'} ${options.path} HTTP/1.1\r\n${serialized}\r\n\r\n`);
    });
    let received = Buffer.alloc(0);
    tlsSocket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    tlsSocket.on('end', () => {
      try {
        const marker = received.indexOf('\r\n\r\n');
        if (marker < 0) throw new Error('TLS response omitted headers');
        const headerLines = received.subarray(0, marker).toString('utf8').split('\r\n');
        const statusCode = Number(headerLines[0]?.split(' ')[1]);
        const responseHeaders: http.IncomingHttpHeaders = {};
        for (const line of headerLines.slice(1)) {
          const separator = line.indexOf(':');
          if (separator <= 0) continue;
          responseHeaders[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
        }
        const encodedBody = received.subarray(marker + 4).toString('utf8');
        const body = responseHeaders['transfer-encoding'] === 'chunked' ? decodeChunkedBody(encodedBody) : encodedBody;
        resolve({ statusCode, headers: responseHeaders, body });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    tlsSocket.on('error', reject);
  });
}

function decodeChunkedBody(body: string): string {
  let remaining = body;
  let decoded = '';
  while (remaining.length > 0) {
    const lineEnd = remaining.indexOf('\r\n');
    if (lineEnd < 0) throw new Error('malformed chunked response');
    const size = Number.parseInt(remaining.slice(0, lineEnd), 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('malformed chunk size');
    remaining = remaining.slice(lineEnd + 2);
    if (size === 0) return decoded;
    if (remaining.length < size + 2 || remaining.slice(size, size + 2) !== '\r\n') {
      throw new Error('truncated chunked response');
    }
    decoded += remaining.slice(0, size);
    remaining = remaining.slice(size + 2);
  }
  throw new Error('chunked response omitted terminator');
}

function tlsHandshake(socket: net.Socket, servername: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ca: ca.certPem }, () => {
      tlsSocket.destroy();
      resolve();
    });
    tlsSocket.on('error', reject);
  });
}

function tlsHandshakeWithoutSni(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, ca: ca.certPem }, () => {
      tlsSocket.destroy();
      resolve();
    });
    tlsSocket.on('error', reject);
  });
}

function tlsHandshakeWithMaximumVersion(
  socket: net.Socket,
  servername: string,
  maxVersion: tls.SecureVersion,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let tlsSocket: tls.TLSSocket;
    try {
      tlsSocket = tls.connect({ socket, servername, ca: ca.certPem, minVersion: 'TLSv1', maxVersion }, () => {
        tlsSocket.destroy();
        resolve();
      });
    } catch (error) {
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    tlsSocket.on('error', (error) => {
      tlsSocket.destroy();
      reject(error);
    });
  });
}

function expectTls12RenegotiationRejection(socket: net.Socket, servername: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let initialHandshakeComplete = false;
    let settled = false;
    const tlsSocket = tls.connect({
      socket,
      servername,
      ca: ca.certPem,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    });
    const timer = setTimeout(() => finish(new Error('TLS renegotiation did not terminate'), false), 1_000);

    const finish = (error: Error | undefined, rejected: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tlsSocket.destroy();
      if (rejected) resolve();
      else reject(error ?? new Error('TLS renegotiation unexpectedly succeeded'));
    };

    tlsSocket.once('secureConnect', () => {
      initialHandshakeComplete = true;
      const started = tlsSocket.renegotiate({}, (error) => {
        if (error !== null) finish(undefined, true);
      });
      if (!started) finish(undefined, true);
    });
    tlsSocket.on('error', (error) => {
      finish(
        initialHandshakeComplete ? undefined : new Error(`initial TLS 1.2 handshake failed: ${error.message}`),
        initialHandshakeComplete,
      );
    });
    tlsSocket.on('close', () => {
      finish(
        initialHandshakeComplete ? undefined : new Error('initial TLS 1.2 handshake closed before completion'),
        initialHandshakeComplete,
      );
    });
  });
}

function onceConnected(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

function onceClosed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(`condition not met within ${timeoutMs}ms`));
      } else {
        setTimeout(check, 2);
      }
    };
    check();
  });
}

function createUpstreamCredentials(authority: CertificateAuthority): { readonly key: string; readonly cert: string } {
  const authorityCertificate = forge.pki.certificateFromPem(authority.certPem);
  const authorityKey = forge.pki.privateKeyFromPem(authority.keyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = randomSerialNumber();
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 60 * 60_000);
  certificate.setSubject([{ name: 'commonName', value: 'registry.npmjs.org' }]);
  certificate.setIssuer(authorityCertificate.subject.attributes);
  certificate.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        'registry.npmjs.org',
        'pypi.org',
        'files.pythonhosted.org',
        'deb.debian.org',
        'security.debian.org',
        'index.crates.io',
        'static.crates.io',
        'crates.io',
      ].map((value) => ({ type: 2, value })),
    },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  certificate.sign(authorityKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(certificate),
  };
}
