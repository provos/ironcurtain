#!/usr/bin/env node
/**
 * Phase 0F cold-cache build-egress capture harness (spike quality).
 *
 * Drives cold-cache (`--no-cache`, fresh builder) `docker build` of the current
 * IronCurtain Dockerfiles through a recording proxy that is the ONLY egress
 * path and emits a DRAFT `build-egress-manifest.draft.json` plus a
 * `capture-evidence.json` summary. The draft is deliberately NOT a loadable
 * frozen manifest (top-level `draft: true`, no `schemaVersion`): a human must
 * review the captured endpoint set, pin artifacts, choose per-seam placement,
 * and transform it into the frozen
 * `config/docker-workload/build-egress-manifest.json`. Nothing here freezes.
 *
 * Two recording modes:
 *
 *   tunnel (default for --build): CONNECT requests are recorded as
 *     { scheme, host, port, byte counts, duration, dockerfile } and then
 *     blind-piped to the real destination — no TLS interception, so the
 *     production Dockerfiles need no capture CA and HTTPS paths are NOT
 *     visible (`pathVisibility: 'connect-only'` in the draft). Plain HTTP
 *     through the proxy (apt via http://deb.debian.org) is still recorded
 *     with full method/host/path and redirect hops (`pathVisibility: 'full'`).
 *
 *   terminate-tls (--terminate-tls; also what --smoke uses): the proxy MITMs
 *     TLS with an ephemeral capture CA and records full HTTPS paths. Only
 *     usable against images that trust the capture CA — the production
 *     Dockerfiles do not and must not be modified, so this mode is kept for
 *     future capture-CA-trusting images and for the hermetic smoke path.
 *
 * macOS Docker Desktop reachability: the proxy listens on 127.0.0.1
 * host-side, but RUN steps execute inside build containers where 127.0.0.1
 * is the container itself. The proxy URL handed to the build therefore uses
 * `host.docker.internal` (Docker Desktop's alias for the host loopback) —
 * override with --proxy-host (native Linux: the docker0 gateway, typically
 * 172.17.0.1). DNS stays host-side: the build container never resolves
 * upstream names; the proxy resolves and connects on the host. A CONNECT to
 * a host that fails to resolve/connect is recorded as a failed fetch attempt
 * (evidence), not a crash.
 *
 * Direct-connect observability: the build runs with the proxy as its sole
 * route, so any tool that bypasses the proxy fails to connect. Such failures
 * are captured in the per-Dockerfile build logs and surfaced under
 * `directConnectSuspected`. An endpoint that the build fetched but the proxy
 * did NOT record is, by construction, a direct connection — the recorded set
 * is therefore the complete mediated set, and gaps are evidence, not silent.
 *
 *   # Hermetic pipeline smokes (no docker):
 *   node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --smoke \
 *     --evidence-dir /absolute/outside-workspace/build-egress-smoke
 *   node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --smoke-tunnel \
 *     --evidence-dir /absolute/outside-workspace/build-egress-smoke-tunnel
 *
 *   # Operator-supervised full cold-cache capture (later validation step):
 *   node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --build \
 *     --evidence-dir /absolute/outside-workspace/build-egress-capture \
 *     --repo-root /absolute/path/to/ironcurtain \
 *     --dockerfile docker/Dockerfile.base --context .
 *
 * This is spike evidence-gathering plumbing, not a security proof and not a
 * qualified backend. The full capture is a supervised step; the smokes only
 * validate the recorder → synthesizer → evidence pipeline.
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
const DEFAULT_PROXY_HOST = 'host.docker.internal';

const USAGE = `Usage:
  build-egress-capture.mjs --smoke --evidence-dir <abs>          hermetic smoke of the terminate-TLS recorder pipeline (no docker)
  build-egress-capture.mjs --smoke-tunnel --evidence-dir <abs>   hermetic smoke of the tunnel recorder (CONNECT pass-through + plain HTTP; no docker)
  build-egress-capture.mjs --build --evidence-dir <abs> --repo-root <abs>
      --dockerfile <rel> [--dockerfile <rel> ...] [--context <rel>]
      [--proxy-host <name>] [--terminate-tls]

Flags:
  --evidence-dir <abs>   Absolute directory for draft manifest + evidence output (required).
  --repo-root <abs>      Repository root for --build (required for --build).
  --dockerfile <rel>     Dockerfile to build, relative to --repo-root (repeatable; builds run sequentially).
  --context <rel>        Build context relative to --repo-root (default '.').
  --proxy-host <name>    Hostname the BUILD CONTAINER uses to reach the recording proxy.
                         The proxy itself always listens on 127.0.0.1 host-side.
                         Default: ${DEFAULT_PROXY_HOST} (Docker Desktop on macOS/Windows).
                         On native Linux, Docker Engine has no host.docker.internal by default —
                         pass the docker0 gateway instead, typically: --proxy-host 172.17.0.1
  --terminate-tls        Use the TLS-terminating (MITM) recorder for --build instead of the
                         default non-terminating tunnel mode. Requires images that trust the
                         ephemeral capture CA; the production Dockerfiles do not (and must not
                         be modified), so leave this off for real captures.
  --help                 Show this help.
`;

function parseArgs(argv) {
  const values = { dockerfiles: [], terminateTls: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      values.help = true;
      continue;
    }
    if (arg === '--smoke' || arg === '--smoke-tunnel' || arg === '--build') {
      values.mode = arg.slice(2);
      continue;
    }
    if (arg === '--terminate-tls') {
      values.terminateTls = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === '--dockerfile') values.dockerfiles.push(value);
    else values[arg.slice(2)] = value;
  }
  if (values.help) return values;
  if (!values.mode) throw new Error('one of --smoke, --smoke-tunnel, or --build is required');
  if (!values['evidence-dir']) throw new Error('--evidence-dir is required');
  if (!path.isAbsolute(values['evidence-dir'])) throw new Error('--evidence-dir must be absolute');
  return values;
}

// ── Recording ────────────────────────────────────────────────────────

function createRecorder() {
  const fetches = [];
  const redirects = [];
  const connects = [];
  const failedFetchAttempts = [];
  const directConnectSuspected = [];
  let currentDockerfile = null;
  const stamp = (entry) => ({
    ...(currentDockerfile ? { dockerfile: currentDockerfile } : {}),
    ...entry,
    at: new Date().toISOString(),
  });
  return {
    fetches,
    redirects,
    connects,
    failedFetchAttempts,
    directConnectSuspected,
    setCurrentDockerfile(dockerfile) {
      currentDockerfile = dockerfile;
    },
    recordFetch(entry) {
      fetches.push(stamp(entry));
    },
    recordRedirect(from, to) {
      redirects.push(stamp({ from, to }));
    },
    recordConnect(entry) {
      connects.push(stamp(entry));
    },
    recordFailedFetchAttempt(entry) {
      failedFetchAttempts.push(stamp(entry));
    },
    recordDirectConnectSuspected(entry) {
      directConnectSuspected.push(stamp(entry));
    },
  };
}

// ── Ephemeral capture CA + leaf certs (terminate-tls mode only) ──────

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

function startRecordingProxy({ recorder, allowInsecureUpstream, terminateTls }) {
  const ca = terminateTls ? generateCa() : null;
  const leafContext = terminateTls ? createLeafContextFactory(ca) : null;
  const meta = new WeakMap();

  // Inner server terminates MITMed TLS client requests (terminate-tls mode only).
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

    if (terminateTls) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) clientSocket.unshift(head);
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        SNICallback: (servername, cb) => cb(null, leafContext(servername || host)),
      });
      tlsSocket.on('error', () => tlsSocket.destroy());
      meta.set(tlsSocket, { host, port });
      inner.emit('connection', tlsSocket);
      return;
    }

    // Tunnel mode: record the destination + traffic volume, then blind-pipe.
    // DNS resolution and the TCP connect happen HERE on the host — the build
    // container only ever names the destination; it never resolves it.
    const startedAt = Date.now();
    let bytesUp = 0;
    let bytesDown = 0;
    let established = false;
    let recorded = false;
    const upstream = net.connect({ host, port });
    upstream.setTimeout(30_000);
    const finish = () => {
      if (established && !recorded) {
        recorded = true;
        recorder.recordConnect({
          scheme: 'https:',
          host,
          port,
          bytesUp,
          bytesDown,
          durationMs: Date.now() - startedAt,
        });
      }
    };
    upstream.on('connect', () => {
      established = true;
      upstream.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        bytesUp += head.length;
        upstream.write(head);
      }
      clientSocket.on('data', (chunk) => (bytesUp += chunk.length));
      upstream.on('data', (chunk) => (bytesDown += chunk.length));
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('timeout', () => {
      if (!established) {
        recorder.recordFailedFetchAttempt({
          scheme: 'https:',
          host,
          port,
          method: 'CONNECT',
          error: 'connect timeout',
        });
        clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      }
      upstream.destroy();
      clientSocket.destroy();
    });
    upstream.on('error', (error) => {
      if (!established) {
        // Failed resolve/connect is evidence of an attempted fetch, not a crash.
        recorder.recordFailedFetchAttempt({ scheme: 'https:', host, port, method: 'CONNECT', error: error.message });
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      upstream.destroy();
      clientSocket.destroy();
    });
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => {
      finish();
      upstream.destroy();
    });
    upstream.on('close', () => {
      finish();
      clientSocket.destroy();
    });
  });

  return new Promise((resolve) => {
    outer.listen(0, '127.0.0.1', () => {
      const address = outer.address();
      resolve({
        caCertPem: ca ? ca.certPem : null,
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

function forwardAndRecord({
  recorder,
  allowInsecureUpstream,
  clientReq,
  clientRes,
  scheme,
  host,
  port,
  requestTarget,
}) {
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
    recorder.recordFailedFetchAttempt({ scheme, host, port, method, path: requestPath, error: error.message });
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end();
  });
  clientReq.pipe(upstreamReq);
}

// ── Draft manifest synthesis ─────────────────────────────────────────

function synthesizeDraft(recorder, context) {
  const byDestination = new Map();
  const ensure = (scheme, host, port) => {
    const key = `${scheme}//${host}:${port}`;
    let entry = byDestination.get(key);
    if (!entry) {
      entry = {
        scheme,
        host,
        port,
        pathVisibility: 'connect-only',
        methods: new Set(),
        paths: new Set(),
        dockerfiles: new Set(),
        connectCount: 0,
        bytesUp: 0,
        bytesDown: 0,
      };
      byDestination.set(key, entry);
    }
    return entry;
  };
  for (const fetch of recorder.fetches) {
    const entry = ensure(fetch.scheme, fetch.host, fetch.port);
    // Full request line was mediated (plain HTTP or terminated TLS): paths visible.
    entry.pathVisibility = 'full';
    entry.methods.add(fetch.method);
    entry.paths.add(fetch.path.split('?')[0]);
    if (fetch.dockerfile) entry.dockerfiles.add(fetch.dockerfile);
  }
  for (const connect of recorder.connects) {
    const entry = ensure(connect.scheme, connect.host, connect.port);
    // Tunnel mode: TLS was NOT intercepted, so paths are invisible by design.
    entry.methods.add('CONNECT');
    entry.connectCount += 1;
    entry.bytesUp += connect.bytesUp;
    entry.bytesDown += connect.bytesDown;
    if (connect.dockerfile) entry.dockerfiles.add(connect.dockerfile);
  }
  const proposedRules = [...byDestination.values()].map((entry, index) => ({
    proposedId: `capture-${entry.host.replace(/[^a-z0-9]+/g, '-')}-${index}`,
    reviewerMustDecideSeam: ['dockerfile-frontend', 'base-image', 'run'],
    // 'connect-only': recorded via a non-terminating CONNECT tunnel — the
    // reviewer must decide path shapes for this endpoint at freeze time.
    // 'full': every path was observed through the proxy.
    pathVisibility: entry.pathVisibility,
    destination: {
      protocol: entry.scheme,
      hostname: entry.host,
      port: entry.port,
      addressPolicy: 'fixed-parent-only',
    },
    observedMethods: [...entry.methods].sort(),
    observedPaths: [...entry.paths].sort(),
    observedDockerfiles: [...entry.dockerfiles].sort(),
    ...(entry.connectCount > 0
      ? { observedConnects: { count: entry.connectCount, bytesUp: entry.bytesUp, bytesDown: entry.bytesDown } }
      : {}),
  }));
  return {
    draft: true,
    schema: DRAFT_SCHEMA,
    warning: 'NOT a frozen manifest. Human review, artifact pinning, and seam placement are required before freeze.',
    generatedAt: new Date().toISOString(),
    capture: context,
    observedRedirects: recorder.redirects,
    failedFetchAttempts: recorder.failedFetchAttempts,
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
        connectCount: recorder.connects.length,
        failedFetchAttemptCount: recorder.failedFetchAttempts.length,
        directConnectSuspectedCount: recorder.directConnectSuspected.length,
        fetches: recorder.fetches,
        redirects: recorder.redirects,
        connects: recorder.connects,
        failedFetchAttempts: recorder.failedFetchAttempts,
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
  const proxy = await startRecordingProxy({ recorder, allowInsecureUpstream: true, terminateTls: true });
  try {
    await proxiedGet(proxy.port, upstream.origin, '/artifacts/tool.tar.gz?version=1');
    await proxiedGet(proxy.port, upstream.origin, '/artifacts/redirected'); // upstream answers 302 → /artifacts/tool.tar.gz
    if (recorder.fetches.length < 2) throw new Error('smoke recorder captured no fetches');
    if (recorder.redirects.length < 1) throw new Error('smoke recorder captured no redirect hop');
  } finally {
    await proxy.stop();
    await upstream.stop();
  }
  const context = {
    mode: 'smoke',
    tlsMode: 'terminate-tls',
    proxyPort: proxy.port,
    note: 'synthetic local fetches; no docker build',
  };
  const draft = synthesizeDraft(recorder, context);
  const paths = writeEvidence(args['evidence-dir'], recorder, draft, context);
  console.log(`[capture] smoke OK — ${recorder.fetches.length} fetches, ${recorder.redirects.length} redirect hops`);
  console.log(`[capture] draft manifest: ${paths.draftPath}`);
  console.log(`[capture] evidence:       ${paths.evidencePath}`);
}

async function runSmokeTunnel(args) {
  const recorder = createRecorder();
  recorder.setCurrentDockerfile('smoke-tunnel/Dockerfile.synthetic');
  const httpUpstream = await startSmokeUpstream();
  const tlsUpstream = await startTunnelSmokeUpstream();
  const proxy = await startRecordingProxy({ recorder, allowInsecureUpstream: true, terminateTls: false });
  try {
    // CONNECT through the proxy and complete a TLS handshake verified against
    // the upstream's own self-signed cert — succeeding proves the proxy did
    // NOT terminate TLS (it holds no key that could satisfy this pin).
    const body = await tunnelTlsGet(proxy.port, '127.0.0.1', tlsUpstream.port, tlsUpstream.certPem, '/tunnel-check');
    if (!body.includes('tunnel-ok')) throw new Error('tunnel HTTPS response body missing marker');
    // One plain-HTTP fetch: full method/host/path must still be recorded.
    await proxiedGet(proxy.port, httpUpstream.origin, '/artifacts/tool.tar.gz?version=1');
    // A CONNECT to a closed port must be recorded as a failed fetch attempt, not crash.
    await tunnelConnectExpectFailure(proxy.port, '127.0.0.1', 9);
  } finally {
    await proxy.stop();
    await tlsUpstream.stop();
    await httpUpstream.stop();
  }
  if (recorder.connects.length !== 1)
    throw new Error(`expected exactly 1 connect record, got ${recorder.connects.length}`);
  if (recorder.fetches.length !== 1)
    throw new Error(`expected exactly 1 full-path fetch record, got ${recorder.fetches.length}`);
  if (recorder.failedFetchAttempts.length !== 1)
    throw new Error(`expected exactly 1 failed fetch attempt, got ${recorder.failedFetchAttempts.length}`);
  const connect = recorder.connects[0];
  if (!(connect.bytesUp > 0 && connect.bytesDown > 0)) throw new Error('tunnel connect record has no traffic counts');
  if (connect.dockerfile !== 'smoke-tunnel/Dockerfile.synthetic')
    throw new Error('connect record missing dockerfile attribution');
  const context = {
    mode: 'smoke-tunnel',
    tlsMode: 'tunnel',
    proxyPort: proxy.port,
    note: 'synthetic local fetches (self-signed HTTPS upstream reached through a blind CONNECT tunnel); no docker build',
  };
  const draft = synthesizeDraft(recorder, context);
  const connectOnlyRules = draft.proposedRules.filter((rule) => rule.pathVisibility === 'connect-only');
  const fullRules = draft.proposedRules.filter((rule) => rule.pathVisibility === 'full');
  if (connectOnlyRules.length !== 1) throw new Error(`expected 1 connect-only rule, got ${connectOnlyRules.length}`);
  if (fullRules.length !== 1) throw new Error(`expected 1 full-path rule, got ${fullRules.length}`);
  const paths = writeEvidence(args['evidence-dir'], recorder, draft, context);
  console.log(
    `[capture] smoke-tunnel OK — ${recorder.connects.length} connect-only tunnel, ${recorder.fetches.length} full-path fetch, ` +
      `${recorder.failedFetchAttempts.length} failed attempt recorded (${connect.bytesUp}B up / ${connect.bytesDown}B down)`,
  );
  console.log(`[capture] draft manifest: ${paths.draftPath}`);
  console.log(`[capture] evidence:       ${paths.evidencePath}`);
}

async function runBuild(args) {
  const repoRoot = args['repo-root'];
  if (!repoRoot || !path.isAbsolute(repoRoot)) throw new Error('--repo-root (absolute) is required for --build');
  if (args.dockerfiles.length === 0) throw new Error('at least one --dockerfile is required for --build');
  const buildContext = args.context ?? '.';
  const tlsMode = args.terminateTls ? 'terminate-tls' : 'tunnel';
  const proxyHost = args['proxy-host'] ?? DEFAULT_PROXY_HOST;

  const recorder = createRecorder();
  const proxy = await startRecordingProxy({ recorder, allowInsecureUpstream: false, terminateTls: args.terminateTls });
  mkdirSync(args['evidence-dir'], { recursive: true, mode: 0o700 });
  let caPath = null;
  if (args.terminateTls) {
    caPath = path.join(args['evidence-dir'], 'capture-ca.pem');
    writeFileSync(caPath, proxy.caCertPem, { mode: 0o600 });
  }
  const proxyUrl = `http://${proxyHost}:${proxy.port}`;
  const buildLogs = [];
  try {
    for (const dockerfile of args.dockerfiles) {
      // Builds run sequentially; attribute every record to the Dockerfile under build.
      recorder.setCurrentDockerfile(dockerfile);
      // Fresh cold-cache builder per Dockerfile so no warm layer masks a fetch.
      const log = await runColdCacheBuild({ repoRoot, dockerfile, buildContext, proxyUrl, caPath });
      buildLogs.push({ dockerfile, ...log });
      if (/could not resolve|connection refused|network is unreachable|temporary failure/iu.test(log.stderr)) {
        recorder.recordDirectConnectSuspected({ dockerfile, note: 'build log shows an unmediated connection failure' });
      }
    }
  } finally {
    recorder.setCurrentDockerfile(null);
    await proxy.stop();
  }
  const context = {
    mode: 'build',
    tlsMode,
    proxyHost,
    proxyPort: proxy.port,
    dockerfiles: args.dockerfiles,
    buildContext,
    ...(caPath ? { caPath } : {}),
  };
  const draft = synthesizeDraft(recorder, context);
  const paths = writeEvidence(args['evidence-dir'], recorder, draft, context);
  writeFileSync(path.join(args['evidence-dir'], 'build-logs.json'), JSON.stringify(buildLogs, null, 2), {
    mode: 0o600,
  });
  console.log(
    `[capture] build capture complete — ${recorder.fetches.length} full-path fetches, ` +
      `${recorder.connects.length} https tunnels, ${recorder.failedFetchAttempts.length} failed attempts ` +
      `(tlsMode=${tlsMode}, proxy=${proxyHost}:${proxy.port})`,
  );
  console.log(`[capture] draft manifest: ${paths.draftPath}`);
  console.log(`[capture] evidence:       ${paths.evidencePath}`);
}

function runColdCacheBuild({ repoRoot, dockerfile, buildContext, proxyUrl, caPath }) {
  // Route ALL build egress through the recording proxy. The proxy is the sole
  // route; a tool that ignores it fails to connect. In tunnel mode no CA is
  // injected — production Dockerfiles stay unmodified and TLS is untouched.
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
    ...(caPath ? ['--secret', `id=capture-ca,src=${caPath}`] : []),
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

function startTunnelSmokeUpstream() {
  // Self-signed HTTPS upstream. Its cert is NOT issued by any proxy-held CA,
  // so a client that pins it can only handshake if the tunnel is blind.
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
    { name: 'extKeyUsage', serverAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const server = https.createServer({ key: forge.pki.privateKeyToPem(keys.privateKey), cert: certPem }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tunnel-ok');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        certPem,
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function tunnelTlsGet(proxyPort, targetHost, targetPort, upstreamCertPem, requestPath) {
  return new Promise((resolve, reject) => {
    const proxySocket = net.connect({ host: '127.0.0.1', port: proxyPort });
    proxySocket.on('error', reject);
    proxySocket.on('connect', () => {
      proxySocket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nhost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    proxySocket.once('data', (chunk) => {
      const statusLine = chunk.toString().split('\r\n')[0];
      if (!/^HTTP\/1\.1 200/.test(statusLine)) {
        reject(new Error(`CONNECT rejected: ${statusLine}`));
        return;
      }
      // Handshake over the tunnel, verified STRICTLY against the upstream's
      // own self-signed cert. If the proxy had terminated TLS, verification
      // would fail here — success proves non-interception.
      const tlsSocket = tls.connect({
        socket: proxySocket,
        ca: upstreamCertPem,
        host: targetHost,
        rejectUnauthorized: true,
      });
      tlsSocket.on('error', reject);
      tlsSocket.on('secureConnect', () => {
        if (!tlsSocket.authorized) {
          reject(new Error(`upstream cert not authorized: ${tlsSocket.authorizationError}`));
          return;
        }
        tlsSocket.write(
          `GET ${requestPath} HTTP/1.1\r\nhost: ${targetHost}:${targetPort}\r\nconnection: close\r\n\r\n`,
        );
      });
      let response = '';
      tlsSocket.on('data', (piece) => (response += piece.toString()));
      tlsSocket.on('end', () => resolve(response));
    });
  });
}

function tunnelConnectExpectFailure(proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxySocket = net.connect({ host: '127.0.0.1', port: proxyPort });
    proxySocket.on('error', reject);
    proxySocket.on('connect', () => {
      proxySocket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nhost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    proxySocket.once('data', (chunk) => {
      const statusLine = chunk.toString().split('\r\n')[0];
      proxySocket.destroy();
      if (/^HTTP\/1\.1 (502|504)/.test(statusLine)) resolve(statusLine);
      else reject(new Error(`expected 502/504 for unreachable CONNECT target, got: ${statusLine}`));
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
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.mode === 'smoke') await runSmoke(args);
  else if (args.mode === 'smoke-tunnel') await runSmokeTunnel(args);
  else await runBuild(args);
}

main().catch((error) => {
  console.error(`[capture] FAILED: ${error.message}`);
  process.exitCode = 1;
});
