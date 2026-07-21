#!/usr/bin/env node
/**
 * Phase 0F cold-cache build-egress capture harness (spike quality).
 *
 * Drives cold-cache (`--no-cache`, fresh builder) `docker build` of the current
 * IronCurtain Dockerfiles through a recording MITM proxy that is the ONLY egress
 * path, records every fetched scheme/host/port/method/path and redirect hop, and
 * emits a DRAFT `build-egress-manifest.draft.json` plus a `capture-evidence.json`
 * summary. The draft is deliberately NOT a loadable frozen manifest (top-level
 * `draft: true`, no `schemaVersion`): a human must review the captured endpoint
 * set, pin artifacts, choose per-seam placement, and transform it into the frozen
 * `config/docker-workload/build-egress-manifest.json`. Nothing here freezes.
 *
 * Direct-connect observability: the build runs with the proxy as its sole route,
 * so any tool that bypasses the proxy fails to connect. Such failures are
 * captured in the per-Dockerfile build logs and surfaced under
 * `directConnectSuspected`. An endpoint that the build fetched but the proxy did
 * NOT record is, by construction, a direct connection — the recorded set is
 * therefore the complete mediated set, and gaps are evidence, not silent.
 *
 *   node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --smoke \
 *     --evidence-dir /absolute/outside-workspace/build-egress-smoke
 *
 *   # Operator-supervised full cold-cache capture (later validation step):
 *   node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --build \
 *     --evidence-dir /absolute/outside-workspace/build-egress-capture \
 *     --repo-root /absolute/path/to/ironcurtain \
 *     --dockerfile docker/Dockerfile.base --context .
 *
 * This is spike evidence-gathering plumbing, not a security proof and not a
 * qualified backend. The full capture is a supervised step; `--smoke` only
 * validates the recorder → synthesizer → evidence pipeline.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';

const DRAFT_SCHEMA = 'ironcurtain-build-egress-capture-draft/1';

function parseArgs(argv) {
  const values = { dockerfiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--smoke' || arg === '--build') {
      values.mode = arg.slice(2);
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === '--dockerfile') values.dockerfiles.push(value);
    else values[arg.slice(2)] = value;
  }
  if (!values.mode) throw new Error('one of --smoke or --build is required');
  if (!values['evidence-dir']) throw new Error('--evidence-dir is required');
  if (!path.isAbsolute(values['evidence-dir'])) throw new Error('--evidence-dir must be absolute');
  return values;
}

// ── Recording ────────────────────────────────────────────────────────

function createRecorder() {
  const fetches = [];
  const redirects = [];
  const directConnectSuspected = [];
  return {
    fetches,
    redirects,
    directConnectSuspected,
    recordFetch(entry) {
      fetches.push({ ...entry, at: new Date().toISOString() });
    },
    recordRedirect(from, to) {
      redirects.push({ from, to, at: new Date().toISOString() });
    },
    recordDirectConnectSuspected(entry) {
      directConnectSuspected.push({ ...entry, at: new Date().toISOString() });
    },
  };
}

// ── Ephemeral capture CA + leaf certs ────────────────────────────────

function generateCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'IronCurtain Build-Egress Capture CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey, certPem: forge.pki.certificateToPem(cert) };
}

function createLeafContextFactory(ca) {
  const cache = new Map();
  return (hostname) => {
    const cached = cache.get(hostname);
    if (cached) return cached;
    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    const leaf = forge.pki.createCertificate();
    leaf.publicKey = leafKeys.publicKey;
    leaf.serialNumber = Date.now().toString(16).padStart(16, '0');
    leaf.validity.notBefore = new Date();
    leaf.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
    leaf.setSubject([{ name: 'commonName', value: hostname }]);
    leaf.setIssuer(ca.cert.subject.attributes);
    leaf.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ]);
    leaf.sign(ca.key, forge.md.sha256.create());
    const context = tls.createSecureContext({
      key: forge.pki.privateKeyToPem(leafKeys.privateKey),
      cert: forge.pki.certificateToPem(leaf),
    });
    cache.set(hostname, context);
    return context;
  };
}

// ── Recording proxy ──────────────────────────────────────────────────

function startRecordingProxy({ recorder, allowInsecureUpstream }) {
  const ca = generateCa();
  const leafContext = createLeafContextFactory(ca);
  const meta = new WeakMap();

  const inner = http.createServer();
  inner.on('request', (clientReq, clientRes) => {
    const target = meta.get(clientReq.socket);
    if (!target) {
      clientRes.writeHead(500).end();
      return;
    }
    forwardAndRecord({ recorder, allowInsecureUpstream, clientReq, clientRes, scheme: 'https:', ...target });
  });

  const outer = http.createServer((clientReq, clientRes) => {
    const parsed = tryParseAbsoluteUrl(clientReq.url);
    if (!parsed) {
      clientRes.writeHead(400).end();
      return;
    }
    forwardAndRecord({
      recorder,
      allowInsecureUpstream,
      clientReq,
      clientRes,
      scheme: 'http:',
      host: parsed.hostname,
      port: parsed.port,
      requestTarget: parsed.path,
    });
  });

  outer.on('connect', (req, clientSocket, head) => {
    const [rawHost, rawPort] = (req.url ?? '').split(':');
    const host = (rawHost ?? '').toLowerCase();
    const port = rawPort ? Number(rawPort) : 443;
    clientSocket.on('error', () => clientSocket.destroy());
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) clientSocket.unshift(head);
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      SNICallback: (servername, cb) => cb(null, leafContext(servername || host)),
    });
    tlsSocket.on('error', () => tlsSocket.destroy());
    meta.set(tlsSocket, { host, port });
    inner.emit('connection', tlsSocket);
  });

  return new Promise((resolve) => {
    outer.listen(0, '127.0.0.1', () => {
      const address = outer.address();
      resolve({
        caCertPem: ca.certPem,
        port: address.port,
        stop: () =>
          new Promise((done) => {
            outer.closeAllConnections();
            inner.closeAllConnections();
            outer.close(() => inner.close(() => done()));
          }),
      });
    });
  });
}

function forwardAndRecord({ recorder, allowInsecureUpstream, clientReq, clientRes, scheme, host, port, requestTarget }) {
  const requestPath = requestTarget ?? clientReq.url ?? '/';
  const method = clientReq.method ?? 'GET';
  const agent = scheme === 'https:' ? https : http;
  const upstreamReq = agent.request(
    {
      host,
      port,
      method,
      path: requestPath,
      headers: { ...clientReq.headers, host: authority(host, port, scheme) },
      rejectUnauthorized: !allowInsecureUpstream,
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 0;
      recorder.recordFetch({ scheme, host, port, method, path: requestPath, status });
      const location = upstreamRes.headers.location;
      if (status >= 300 && status < 400 && typeof location === 'string') {
        recorder.recordRedirect({ scheme, host, port, path: requestPath }, location);
      }
      clientRes.writeHead(status, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );
  upstreamReq.on('error', (error) => {
    recorder.recordDirectConnectSuspected({ scheme, host, port, path: requestPath, error: error.message });
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end();
  });
  clientReq.pipe(upstreamReq);
}

// ── Draft manifest synthesis ─────────────────────────────────────────

function synthesizeDraft(recorder, context) {
  const byDestination = new Map();
  for (const fetch of recorder.fetches) {
    const key = `${fetch.scheme}//${fetch.host}:${fetch.port}`;
    const entry = byDestination.get(key) ?? {
      scheme: fetch.scheme,
      host: fetch.host,
      port: fetch.port,
      methods: new Set(),
      paths: new Set(),
    };
    entry.methods.add(fetch.method);
    entry.paths.add(fetch.path.split('?')[0]);
    byDestination.set(key, entry);
  }
  const proposedRules = [...byDestination.values()].map((entry, index) => ({
    proposedId: `capture-${entry.host.replace(/[^a-z0-9]+/g, '-')}-${index}`,
    reviewerMustDecideSeam: ['dockerfile-frontend', 'base-image', 'run'],
    destination: {
      protocol: entry.scheme,
      hostname: entry.host,
      port: entry.port,
      addressPolicy: 'fixed-parent-only',
    },
    observedMethods: [...entry.methods].sort(),
    observedPaths: [...entry.paths].sort(),
  }));
  return {
    draft: true,
    schema: DRAFT_SCHEMA,
    warning: 'NOT a frozen manifest. Human review, artifact pinning, and seam placement are required before freeze.',
    generatedAt: new Date().toISOString(),
    capture: context,
    observedRedirects: recorder.redirects,
    directConnectSuspected: recorder.directConnectSuspected,
    proposedRules,
  };
}

function writeEvidence(evidenceDir, recorder, draft, context) {
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const draftPath = path.join(evidenceDir, 'build-egress-manifest.draft.json');
  const evidencePath = path.join(evidenceDir, 'capture-evidence.json');
  writeFileSync(draftPath, JSON.stringify(draft, null, 2), { mode: 0o600 });
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        schema: DRAFT_SCHEMA,
        capture: context,
        fetchCount: recorder.fetches.length,
        redirectCount: recorder.redirects.length,
        directConnectSuspectedCount: recorder.directConnectSuspected.length,
        fetches: recorder.fetches,
        redirects: recorder.redirects,
        directConnectSuspected: recorder.directConnectSuspected,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { draftPath, evidencePath };
}

// ── Modes ────────────────────────────────────────────────────────────

async function runSmoke(args) {
  const recorder = createRecorder();
  const upstream = await startSmokeUpstream();
  const proxy = await startRecordingProxy({ recorder, allowInsecureUpstream: true });
  try {
    await proxiedGet(proxy.port, upstream.origin, '/artifacts/tool.tar.gz?version=1');
    await proxiedGet(proxy.port, upstream.origin, '/artifacts/redirected'); // upstream answers 302 → /artifacts/tool.tar.gz
    if (recorder.fetches.length < 2) throw new Error('smoke recorder captured no fetches');
    if (recorder.redirects.length < 1) throw new Error('smoke recorder captured no redirect hop');
  } finally {
    await proxy.stop();
    await upstream.stop();
  }
  const context = { mode: 'smoke', proxyPort: proxy.port, note: 'synthetic local fetches; no docker build' };
  const draft = synthesizeDraft(recorder, context);
  const paths = writeEvidence(args['evidence-dir'], recorder, draft, context);
  console.log(`[capture] smoke OK — ${recorder.fetches.length} fetches, ${recorder.redirects.length} redirect hops`);
  console.log(`[capture] draft manifest: ${paths.draftPath}`);
  console.log(`[capture] evidence:       ${paths.evidencePath}`);
}

async function runBuild(args) {
  const repoRoot = args['repo-root'];
  if (!repoRoot || !path.isAbsolute(repoRoot)) throw new Error('--repo-root (absolute) is required for --build');
  if (args.dockerfiles.length === 0) throw new Error('at least one --dockerfile is required for --build');
  const buildContext = args.context ?? '.';

  const recorder = createRecorder();
  const proxy = await startRecordingProxy({ recorder, allowInsecureUpstream: false });
  const caPath = path.join(args['evidence-dir'], 'capture-ca.pem');
  mkdirSync(args['evidence-dir'], { recursive: true, mode: 0o700 });
  writeFileSync(caPath, proxy.caCertPem, { mode: 0o600 });
  const buildLogs = [];
  try {
    for (const dockerfile of args.dockerfiles) {
      // Fresh cold-cache builder per Dockerfile so no warm layer masks a fetch.
      const log = await runColdCacheBuild({ repoRoot, dockerfile, buildContext, proxyPort: proxy.port, caPath });
      buildLogs.push({ dockerfile, ...log });
      if (/could not resolve|connection refused|network is unreachable|temporary failure/iu.test(log.stderr)) {
        recorder.recordDirectConnectSuspected({ dockerfile, note: 'build log shows an unmediated connection failure' });
      }
    }
  } finally {
    await proxy.stop();
  }
  const context = { mode: 'build', proxyPort: proxy.port, dockerfiles: args.dockerfiles, buildContext, caPath };
  const draft = synthesizeDraft(recorder, context);
  const paths = writeEvidence(args['evidence-dir'], recorder, draft, context);
  writeFileSync(path.join(args['evidence-dir'], 'build-logs.json'), JSON.stringify(buildLogs, null, 2), { mode: 0o600 });
  console.log(`[capture] build capture complete — ${recorder.fetches.length} mediated fetches`);
  console.log(`[capture] draft manifest: ${paths.draftPath}`);
  console.log(`[capture] evidence:       ${paths.evidencePath}`);
}

function runColdCacheBuild({ repoRoot, dockerfile, buildContext, proxyPort, caPath }) {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  // Route ALL build egress through the recording proxy and trust its CA. The
  // proxy is the sole route; a tool that ignores it fails to connect.
  const buildArgs = [
    'build',
    '--no-cache',
    '--pull=false',
    '--network=default',
    '--build-arg',
    `HTTP_PROXY=${proxyUrl}`,
    '--build-arg',
    `HTTPS_PROXY=${proxyUrl}`,
    '--build-arg',
    `http_proxy=${proxyUrl}`,
    '--build-arg',
    `https_proxy=${proxyUrl}`,
    '--secret',
    `id=capture-ca,src=${caPath}`,
    '-f',
    path.resolve(repoRoot, dockerfile),
    path.resolve(repoRoot, buildContext),
  ];
  return new Promise((resolve) => {
    const child = spawn('docker', buildArgs, { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

// ── Smoke helpers ────────────────────────────────────────────────────

function startSmokeUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url === '/artifacts/redirected') {
      res.writeHead(302, { location: '/artifacts/tool.tar.gz' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('artifact-bytes');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `127.0.0.1:${address.port}`,
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function proxiedGet(proxyPort, origin, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://${origin}${requestPath}`,
        headers: { host: origin, accept: 'application/octet-stream', 'user-agent': 'capture-smoke/1' },
        agent: false,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function tryParseAbsoluteUrl(url) {
  try {
    const parsed = new URL(url ?? '');
    if (parsed.protocol !== 'http:') return null;
    return {
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 80,
      path: parsed.pathname + parsed.search,
    };
  } catch {
    return null;
  }
}

function authority(host, port, scheme) {
  const standard = (scheme === 'https:' && port === 443) || (scheme === 'http:' && port === 80);
  const bracketed = net.isIP(host) === 6 ? `[${host}]` : host;
  return standard ? bracketed : `${bracketed}:${port}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'smoke') await runSmoke(args);
  else await runBuild(args);
}

main().catch((error) => {
  console.error(`[capture] FAILED: ${error.message}`);
  process.exitCode = 1;
});
