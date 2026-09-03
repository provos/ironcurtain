import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createRegistryEgressGuard,
  handleRegistryEgressRequest,
  type RegistryEgressForwardContext,
  type RegistryPullProvenance,
} from '../../src/docker/registry-egress-proxy.js';
import { getFrozenRegistryEgressManifestPath } from '../../src/docker/docker-workload-paths.js';
import { createDirectOutboundTransport } from '../../src/docker/outbound-transport.js';
import { sha256Hex } from '../../src/hash.js';

const DOCKER_HUB_REPOSITORY = 'library/hello-world';
const GHCR_REPOSITORY = 'astral-sh/uv';
const REQUEST_TIMEOUT_MS = 30_000;
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

interface ProxyResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

interface ManifestIndex {
  readonly manifests?: readonly {
    readonly digest: string;
    readonly platform?: { readonly os: string; readonly architecture: string };
  }[];
  readonly config?: { readonly digest: string };
}

function proxyFetch(
  port: number,
  targetHost: string,
  path: string,
  options: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> } = {},
): Promise<ProxyResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        headers: { host: targetHost, 'user-agent': 'ironcurtain-registry-integration/1', ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.once('error', reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`registry integration request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.end();
  });
}

async function fetchBearer(port: number, challenge: string): Promise<string> {
  const parameters = new Map<string, string>();
  for (const match of challenge.matchAll(/(\w+)="([^"]*)"/gu)) parameters.set(match[1], match[2]);
  const realm = parameters.get('realm');
  const service = parameters.get('service');
  if (realm === undefined || service === undefined) throw new Error(`unparseable registry challenge: ${challenge}`);

  const url = new URL(realm);
  const query = new URLSearchParams({ service });
  const scope = parameters.get('scope');
  if (scope !== undefined) query.set('scope', scope);
  const response = await proxyFetch(port, url.host, `${url.pathname}?${query.toString()}`, {
    headers: { accept: 'application/json' },
  });
  expect(response.status).toBe(200);
  const payload = JSON.parse(response.body.toString('utf8')) as {
    readonly token?: string;
    readonly access_token?: string;
  };
  const token = payload.token ?? payload.access_token;
  if (token === undefined) throw new Error('registry token endpoint returned no token');
  return token;
}

async function anonymousGet(
  port: number,
  targetHost: string,
  path: string,
  accept: string,
  token?: string,
): Promise<{ readonly response: ProxyResponse; readonly token?: string }> {
  const headers: Record<string, string> = { accept };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const initial = await proxyFetch(port, targetHost, path, { headers });
  if (initial.status !== 401 || token !== undefined) return { response: initial, ...(token ? { token } : {}) };

  const challenge = initial.headers['www-authenticate'];
  if (typeof challenge !== 'string') throw new Error('registry returned 401 without a Bearer challenge');
  const freshToken = await fetchBearer(port, challenge);
  const response = await proxyFetch(port, targetHost, path, {
    headers: { accept, authorization: `Bearer ${freshToken}` },
  });
  return { response, token: freshToken };
}

async function expectPublicPull(
  port: number,
  provenance: readonly RegistryPullProvenance[],
  registryHost: string,
  repository: string,
): Promise<void> {
  const indexResult = await anonymousGet(port, registryHost, `/v2/${repository}/manifests/latest`, MANIFEST_ACCEPT);
  expect(indexResult.response.status).toBe(200);
  const index = JSON.parse(indexResult.response.body.toString('utf8')) as ManifestIndex;

  let configDigest = index.config?.digest;
  if (index.manifests !== undefined) {
    if (index.manifests.length === 0) {
      throw new Error(`${registryHost}/${repository} returned an empty manifest index`);
    }
    const selected =
      index.manifests.find(
        (manifest) => manifest.platform?.os === 'linux' && manifest.platform.architecture === 'amd64',
      ) ?? index.manifests[0];
    const manifestResult = await anonymousGet(
      port,
      registryHost,
      `/v2/${repository}/manifests/${selected.digest}`,
      MANIFEST_ACCEPT,
      indexResult.token,
    );
    expect(manifestResult.response.status).toBe(200);
    configDigest = (JSON.parse(manifestResult.response.body.toString('utf8')) as ManifestIndex).config?.digest;
  }
  if (configDigest === undefined) throw new Error(`${registryHost}/${repository} returned no config digest`);

  const blob = await proxyFetch(port, registryHost, `/v2/${repository}/blobs/${configDigest}`, {
    headers: {
      accept: 'application/octet-stream',
      ...(indexResult.token === undefined ? {} : { authorization: `Bearer ${indexResult.token}` }),
    },
  });
  expect(blob.status).toBe(200);
  expect(`sha256:${sha256Hex(blob.body)}`).toBe(configDigest);
  expect(provenance).toContainEqual(
    expect.objectContaining({ requestedDigest: configDigest, originId: expect.stringContaining(':cdn') }),
  );
}

describe.skipIf(process.env.REGISTRY_EGRESS_LIVE_INTEGRATION !== '1')('live public registry egress', () => {
  it('supports anonymous Docker Hub and GHCR pulls while retaining fail-closed operations', async () => {
    const provenance: RegistryPullProvenance[] = [];
    const guard = createRegistryEgressGuard({
      mode: 'public-registry',
      manifestPath: getFrozenRegistryEgressManifestPath(),
    });
    const transport = createDirectOutboundTransport();
    const server = http.createServer((request, response) => {
      const context: RegistryEgressForwardContext = {
        guard,
        transport,
        scheme: 'https:',
        targetHost: request.headers.host ?? '',
        targetPort: 443,
        requestTarget: request.url ?? '/',
        recordProvenance: (record) => provenance.push(record),
      };
      handleRegistryEgressRequest(request, response, context);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('registry integration listener has no TCP port');

    try {
      const version = await anonymousGet(address.port, 'registry-1.docker.io', '/v2/', 'application/json');
      expect([200, 401]).toContain(version.response.status);
      await expectPublicPull(address.port, provenance, 'registry-1.docker.io', DOCKER_HUB_REPOSITORY);
      await expectPublicPull(address.port, provenance, 'ghcr.io', GHCR_REPOSITORY);

      const denied = await Promise.all([
        proxyFetch(address.port, 'evil.example.com', `/v2/${DOCKER_HUB_REPOSITORY}/manifests/latest`, {
          headers: { accept: MANIFEST_ACCEPT },
        }),
        proxyFetch(address.port, 'registry-1.docker.io', `/v2/${DOCKER_HUB_REPOSITORY}/blobs/uploads/`, {
          method: 'POST',
          headers: { accept: 'application/json' },
        }),
        proxyFetch(address.port, 'registry-1.docker.io', `/v2/${DOCKER_HUB_REPOSITORY}/tags/list`),
        proxyFetch(address.port, 'registry-1.docker.io', '/v2/_catalog'),
        proxyFetch(address.port, 'registry-1.docker.io', `/v2/${DOCKER_HUB_REPOSITORY}/manifests/latest`, {
          headers: { accept: MANIFEST_ACCEPT, authorization: 'Basic dXNlcjpwYXNz' },
        }),
      ]);
      expect(denied.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }, 180_000);
});
