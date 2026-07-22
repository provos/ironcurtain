/**
 * Live registry-egress 0C gate (host-run, real anonymous pull).
 *
 * Drives the production registry-egress proxy seam (`handleRegistryEgressRequest`)
 * with a FROZEN manifest and a real `createDirectOutboundTransport` against Docker
 * Hub's anonymous pull path, plus live fail-closed negatives. The harness plays the
 * Docker daemon: it performs the anonymous 401->token->retry dance itself and follows
 * the derived CDN redirect through the proxy. No credential exists anywhere; the token
 * is obtained anonymously through the mediated path, exactly as §6.4 specifies.
 *
 *   npx tsx <this file>
 *
 * Exit 0 = all positives + negatives passed; non-zero = a gate failed.
 */
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRegistryEgressGuard,
  handleRegistryEgressRequest,
  type RegistryEgressForwardContext,
  type RegistryPullProvenance,
} from '../../../src/docker/registry-egress-proxy.js';
import { createDirectOutboundTransport } from '../../../src/docker/outbound-transport.js';

const REPO = 'library/hello-world';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const provenance: RegistryPullProvenance[] = [];
let innerPort = 0;

/** One client hop "through" the proxy: connect to the inner server, set the real
 *  registry as Host so the seam binds targetHost the way TLS-termination would. */
function proxyFetch(
  targetHost: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: innerPort,
        method: opts.method ?? 'GET',
        path,
        headers: { host: targetHost, 'user-agent': 'ironcurtain-registry-gate/0', ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function bearerFor(wwwAuthenticate: string): Promise<string> {
  // WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service="...",scope="..."
  const params = new Map<string, string>();
  for (const m of wwwAuthenticate.matchAll(/(\w+)="([^"]*)"/g)) params.set(m[1], m[2]);
  const realm = params.get('realm');
  const service = params.get('service');
  const scope = params.get('scope');
  if (realm === undefined || service === undefined) throw new Error(`unparseable challenge: ${wwwAuthenticate}`);
  const url = new URL(realm);
  const query = new URLSearchParams({ service });
  if (scope !== undefined) query.set('scope', scope);
  return proxyFetch(url.host, `${url.pathname}?${query.toString()}`, { headers: { accept: 'application/json' } }).then(
    (res) => {
      if (res.status !== 200) throw new Error(`token endpoint returned ${res.status}`);
      const token = (JSON.parse(res.body.toString('utf8')) as { token?: string; access_token?: string }).token;
      const access = (JSON.parse(res.body.toString('utf8')) as { access_token?: string }).access_token;
      const value = token ?? access;
      if (value === undefined) throw new Error('token endpoint returned no token');
      return value;
    },
  );
}

async function anonymousGet(
  targetHost: string,
  path: string,
  accept: string,
  token: string | undefined,
): Promise<{ res: Awaited<ReturnType<typeof proxyFetch>>; token: string | undefined }> {
  const headers: Record<string, string> = { accept };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  let res = await proxyFetch(targetHost, path, { headers });
  if (res.status === 401 && token === undefined) {
    const challenge = res.headers['www-authenticate'];
    if (typeof challenge !== 'string') throw new Error('401 without a Bearer challenge');
    const fresh = await bearerFor(challenge);
    res = await proxyFetch(targetHost, path, { headers: { accept, authorization: `Bearer ${fresh}` } });
    return { res, token: fresh };
  }
  return { res, token };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}\n`);
}

async function main(): Promise<void> {
  // Freeze a copy of the checked-in draft manifest (origins/ceilings already
  // reviewed) so the guard exercises the production default (frozen-only) path.
  const dir = mkdtempSync(join(tmpdir(), 'registry-live-gate-'));
  const draft = JSON.parse(
    readFileSync('/Users/provos/src/ironcurtain/config/docker-workload/registry-egress-manifest.json', 'utf8'),
  ) as Record<string, unknown>;
  draft.status = 'frozen';
  draft.policyId = 'workload-registry-egress-live-gate-v1';
  const manifestPath = join(dir, 'frozen.json');
  writeFileSync(manifestPath, JSON.stringify(draft), { mode: 0o400 });

  const guard = createRegistryEgressGuard({ mode: 'public-registry', manifestPath });
  const transport = createDirectOutboundTransport();

  const server = http.createServer((req, res) => {
    const context: RegistryEgressForwardContext = {
      guard,
      transport,
      scheme: 'https:',
      targetHost: req.headers.host ?? '',
      targetPort: 443,
      requestTarget: req.url ?? '/',
      recordProvenance: (record) => provenance.push(record),
    };
    handleRegistryEgressRequest(req, res, context);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  innerPort = (server.address() as { port: number }).port;

  try {
    // ---- POSITIVE: full anonymous pull-by-digest with derived CDN redirect ----
    // 1) API version probe (anonymous 401 -> token -> 200 or 401 challenge only).
    const v2 = await anonymousGet('registry-1.docker.io', '/v2/', 'application/json', undefined);
    check(
      'api-version probe reaches the registry',
      v2.res.status === 200 || v2.res.status === 401,
      `status ${v2.res.status}`,
    );

    // 2) Manifest index (tag pull -> token dance).
    const index = await anonymousGet(
      'registry-1.docker.io',
      `/v2/${REPO}/manifests/latest`,
      MANIFEST_ACCEPT,
      undefined,
    );
    check('anonymous tag manifest pull (token dance)', index.res.status === 200, `status ${index.res.status}`);
    const token = index.token;
    const indexJson = JSON.parse(index.res.body.toString('utf8')) as {
      manifests?: { digest: string; platform?: { os: string; architecture: string } }[];
      config?: { digest: string };
    };

    // 3) Resolve a concrete image manifest (multi-arch index -> linux/amd64).
    let imageManifestDigest: string | undefined;
    if (indexJson.manifests) {
      const amd64 = indexJson.manifests.find((m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64');
      imageManifestDigest = (amd64 ?? indexJson.manifests[0]).digest;
    }
    let configDigest: string | undefined;
    if (imageManifestDigest) {
      const mres = await anonymousGet(
        'registry-1.docker.io',
        `/v2/${REPO}/manifests/${imageManifestDigest}`,
        MANIFEST_ACCEPT,
        token,
      );
      check(
        'by-digest image manifest pull',
        mres.res.status === 200,
        `status ${mres.res.status} (${imageManifestDigest.slice(0, 19)}…)`,
      );
      configDigest = (JSON.parse(mres.res.body.toString('utf8')) as { config?: { digest: string } }).config?.digest;
    } else {
      configDigest = indexJson.config?.digest;
    }

    // 4) Blob pull -> registry 307 -> derived CDN redirect followed by the proxy.
    if (configDigest === undefined) throw new Error('could not resolve a config blob digest');
    const blob = await proxyFetch('registry-1.docker.io', `/v2/${REPO}/blobs/${configDigest}`, {
      headers: { accept: 'application/octet-stream', authorization: `Bearer ${token ?? ''}` },
    });
    check(
      'blob pull follows the derived CDN redirect',
      blob.status === 200,
      `status ${blob.status}, ${blob.body.length} bytes`,
    );

    // 5) Content-addressed digest matches (bundle-local verification, per §16.6).
    const got = `sha256:${createHash('sha256').update(blob.body).digest('hex')}`;
    check('delivered blob is content-addressed correct', got === configDigest, `${got.slice(0, 19)}… == requested`);

    // 6) Provenance recorded for the completed content pull.
    // The blob was pulled by-digest and redirected to a CDN; §16.6 requires the
    // originally-requested digest to survive the redirect as provenance.
    const blobProv = provenance.find((p) => p.requestedDigest === configDigest);
    check(
      'blob provenance retains the requested digest across the CDN redirect',
      blobProv !== undefined && blobProv.originId.includes('cdn'),
      `${provenance.length} record(s); blob origin ${blobProv?.originId ?? 'none'}, ${blobProv?.sizeBytes ?? 0} bytes`,
    );

    // ---- NEGATIVES (live, fail-closed with no unmediated egress) ----
    const unlisted = await proxyFetch('evil.example.com', `/v2/${REPO}/manifests/latest`, {
      headers: { accept: MANIFEST_ACCEPT },
    });
    check('unlisted host fails closed', unlisted.status === 403, `status ${unlisted.status}`);

    const push = await proxyFetch('registry-1.docker.io', `/v2/${REPO}/blobs/uploads/`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    check('blob-upload (push) fails closed', push.status === 403, `status ${push.status}`);

    const tags = await proxyFetch('registry-1.docker.io', `/v2/${REPO}/tags/list`, {
      headers: { accept: 'application/json' },
    });
    check('tags enumeration fails closed', tags.status === 403, `status ${tags.status}`);

    const catalog = await proxyFetch('registry-1.docker.io', '/v2/_catalog', {
      headers: { accept: 'application/json' },
    });
    check('catalog enumeration fails closed', catalog.status === 403, `status ${catalog.status}`);

    const basic = await proxyFetch('registry-1.docker.io', `/v2/${REPO}/manifests/latest`, {
      headers: { accept: MANIFEST_ACCEPT, authorization: 'Basic dXNlcjpwYXNz' },
    });
    check('Basic auth scheme fails closed', basic.status === 403, `status ${basic.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n=== registry live gate: ${results.length - failed.length}/${results.length} passed ===\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`registry live gate crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(2);
});
