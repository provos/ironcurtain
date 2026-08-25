#!/usr/bin/env node

/**
 * Fixed byte relay for the Apple same-VM nested-Docker topology.
 *
 * The production CLI deliberately accepts profiles, never caller-selected
 * ports or paths. Policy remains in the host UDS servers; this process only
 * transports bounded bytes inside RootlessKit's isolated network namespace.
 */

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { lstat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

export const APPLE_VM_EGRESS_RELAY_VERSION = 'ironcurtain-apple-vm-egress-relay/1';

const LOOPBACK = '127.0.0.1';
const REGISTRY_HEALTH_REQUEST =
  'GET http://ironcurtain.invalid/__ironcurtain/health HTTP/1.1\r\n' +
  'Host: ironcurtain.invalid\r\nConnection: close\r\n\r\n';
const REGISTRY_HEALTH_BODY = 'IRONCURTAIN_OK/1\n';
const PACKAGE_HEALTH_REQUEST =
  'GET http://ironcurtain.invalid/__ironcurtain/package-egress/health HTTP/1.1\r\n' +
  'Host: ironcurtain.invalid\r\nConnection: close\r\n\r\n';
const PACKAGE_HEALTH_BODY = 'IRONCURTAIN_PACKAGE_EGRESS_OK/1\n';

const GIBIBYTE = 1024 * 1024 * 1024;

/**
 * Endpoint transport ceilings sit outside the stricter proxy ledgers. The
 * package connection cannot outlive its ten-minute request. Registry clients
 * may reuse one connection across multiple individually bounded requests, so
 * the relay has no absolute registry-connection timer and permits more than
 * the complete 16-GiB session ledger plus framing.
 */
export const DEFAULT_RELAY_LIMITS = Object.freeze({
  maxConnections: 32,
  registry: Object.freeze({
    maxBytesEachDirection: 20 * GIBIBYTE,
    idleTimeoutMs: 11 * 60_000,
    absoluteTimeoutMs: null,
    dialTimeoutMs: 15_000,
  }),
  package: Object.freeze({
    maxBytesEachDirection: 4 * GIBIBYTE,
    idleTimeoutMs: 11 * 60_000,
    absoluteTimeoutMs: 11 * 60_000,
    dialTimeoutMs: 15_000,
  }),
});

const ENDPOINTS = Object.freeze({
  registry: Object.freeze({
    name: 'registry',
    host: LOOPBACK,
    port: 18081,
    socketPath: '/tmp/ironcurtain-registry-egress.sock',
    healthRequest: REGISTRY_HEALTH_REQUEST,
    healthBody: REGISTRY_HEALTH_BODY,
    transportLimits: DEFAULT_RELAY_LIMITS.registry,
  }),
  package: Object.freeze({
    name: 'package',
    host: LOOPBACK,
    port: 18082,
    socketPath: '/tmp/ironcurtain-package-egress.sock',
    healthRequest: PACKAGE_HEALTH_REQUEST,
    healthBody: PACKAGE_HEALTH_BODY,
    transportLimits: DEFAULT_RELAY_LIMITS.package,
  }),
});

const PROFILES = Object.freeze({
  images: Object.freeze([ENDPOINTS.registry]),
  packages: Object.freeze([ENDPOINTS.registry, ENDPOINTS.package]),
});

const PROBE_MAX_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 2_000;

function fixedError(code) {
  return new Error(`ironcurtain Apple VM egress relay ${code}`);
}

function endpointIdentity(stats, kind) {
  const validType = kind === 'directory' ? stats.isDirectory() : stats.isSocket();
  if (!validType || stats.isSymbolicLink() || stats.nlink < 1n) throw fixedError(`${kind}-identity`);
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: stats.nlink,
    rdev: stats.rdev,
  });
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.rdev === right.rdev
  );
}

async function recordEndpointIdentity(endpoint) {
  const parentPath = dirname(endpoint.socketPath);
  const [parentStats, socketStats] = await Promise.all([
    lstat(parentPath, { bigint: true }),
    lstat(endpoint.socketPath, { bigint: true }),
  ]);
  return Object.freeze({
    parentPath,
    parent: endpointIdentity(parentStats, 'directory'),
    socket: endpointIdentity(socketStats, 'socket'),
  });
}

async function assertEndpointIdentity(endpoint, recorded) {
  const [parentStats, socketStats] = await Promise.all([
    lstat(recorded.parentPath, { bigint: true }),
    lstat(endpoint.socketPath, { bigint: true }),
  ]);
  const parent = endpointIdentity(parentStats, 'directory');
  const socket = endpointIdentity(socketStats, 'socket');
  if (!sameIdentity(recorded.parent, parent) || !sameIdentity(recorded.socket, socket)) {
    throw fixedError('endpoint-replaced');
  }
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: endpoint.host, port: endpoint.port, exclusive: true, backlog: 64 });
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function createRelayPair(tcp, endpoint, recorded, pairs, limits) {
  let upstream;
  let finished = false;
  let clientBytes = 0;
  let serverBytes = 0;
  let idleTimer;
  let settleClosed;
  const closed = new Promise((resolve) => {
    settleClosed = resolve;
  });

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(absoluteTimer);
    clearTimeout(dialTimer);
    clearTimeout(idleTimer);
    pairs.delete(pair);
    settleClosed();
  };
  const destroy = () => {
    if (!tcp.destroyed) tcp.resetAndDestroy();
    upstream?.destroy();
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(destroy, limits.idleTimeoutMs);
    idleTimer.unref();
  };
  const pair = Object.freeze({ destroy, closed });
  pairs.add(pair);
  tcp.pause();
  tcp.on('error', destroy);
  tcp.on('close', () => {
    upstream?.destroy();
    finish();
  });
  tcp.on('data', (chunk) => {
    clientBytes += chunk.length;
    if (clientBytes > limits.maxBytesEachDirection) destroy();
    else resetIdle();
  });

  const absoluteTimer = limits.absoluteTimeoutMs === null ? undefined : setTimeout(destroy, limits.absoluteTimeoutMs);
  absoluteTimer?.unref();
  resetIdle();

  let dialTimer;
  void (async () => {
    try {
      await assertEndpointIdentity(endpoint, recorded);
      if (finished) return;
      upstream = createConnection({ path: endpoint.socketPath, allowHalfOpen: true });
      upstream.on('error', destroy);
      upstream.on('close', () => {
        if (!upstream.readableEnded) tcp.destroy();
      });
      upstream.on('data', (chunk) => {
        serverBytes += chunk.length;
        if (serverBytes > limits.maxBytesEachDirection) destroy();
        else resetIdle();
      });
      dialTimer = setTimeout(destroy, limits.dialTimeoutMs);
      dialTimer.unref();
      upstream.once('connect', async () => {
        clearTimeout(dialTimer);
        try {
          await assertEndpointIdentity(endpoint, recorded);
        } catch {
          destroy();
          return;
        }
        if (finished) return;
        tcp.pipe(upstream);
        upstream.pipe(tcp, { end: false });
        upstream.once('end', () => {
          // Flush the complete response and FIN before destroying the held-open
          // request side. writableFinished can win the event-listener race for
          // an empty or already-drained response, so handle both states.
          const closeAfterFlush = () => {
            tcp.destroySoon();
            upstream?.destroy();
          };
          if (!tcp.writableEnded) tcp.end();
          if (tcp.writableFinished) closeAfterFlush();
          else tcp.once('finish', closeAfterFlush);
        });
        tcp.resume();
      });
    } catch {
      destroy();
    }
  })();
}

async function startRelayProfile(endpoints, options = {}) {
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > 2) {
    throw fixedError('endpoint-count');
  }
  const maxConnections = options.maxConnections ?? DEFAULT_RELAY_LIMITS.maxConnections;
  const pairs = new Set();
  const started = [];
  let stopping = false;
  let settleDone;
  let settleFailure;
  const done = new Promise((resolve, reject) => {
    settleDone = resolve;
    settleFailure = reject;
  });

  try {
    for (const endpoint of endpoints) {
      const recorded = await recordEndpointIdentity(endpoint);
      const server = createServer({ allowHalfOpen: true }, (tcp) => {
        if (stopping || pairs.size >= maxConnections) {
          tcp.destroy();
          return;
        }
        try {
          options.testHooks?.onAccepted?.(tcp, endpoint);
        } catch {
          tcp.destroy();
          return;
        }
        createRelayPair(tcp, endpoint, recorded, pairs, endpoint.transportLimits);
      });
      await listen(server, endpoint);
      server.on('error', () => {
        if (!stopping) settleFailure(fixedError('listener-failed'));
      });
      server.on('close', () => {
        if (!stopping) settleFailure(fixedError('listener-closed'));
      });
      started.push(server);
    }
  } catch (error) {
    stopping = true;
    const closingPairs = [...pairs];
    const closingServers = started.map(closeServer);
    for (const pair of closingPairs) pair.destroy();
    await Promise.allSettled([...closingServers, ...closingPairs.map((pair) => pair.closed)]);
    throw error;
  }

  return Object.freeze({
    done,
    get activeConnections() {
      return pairs.size;
    },
    async close() {
      if (stopping) return;
      stopping = true;
      const closingPairs = [...pairs];
      const closingServers = started.map(closeServer);
      for (const pair of closingPairs) pair.destroy();
      await Promise.all([...closingServers, ...closingPairs.map((pair) => pair.closed)]);
      settleDone();
    },
  });
}

/** Test seam; arbitrary endpoint objects never cross the production CLI. */
export const startRelayProfileForTest = startRelayProfile;

function decodeChunked(payload) {
  const chunks = [];
  let offset = 0;
  while (true) {
    const lineEnd = payload.indexOf('\r\n', offset);
    if (lineEnd < 0) throw fixedError('probe-framing');
    const sizeText = payload.subarray(offset, lineEnd).toString('latin1');
    if (!/^(?:0|[1-9a-f][0-9a-f]*)$/u.test(sizeText)) throw fixedError('probe-framing');
    const size = Number.parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) {
      if (offset + 2 !== payload.length || payload[offset] !== 0x0d || payload[offset + 1] !== 0x0a) {
        throw fixedError('probe-framing');
      }
      return Buffer.concat(chunks);
    }
    if (offset + size + 2 > payload.length) throw fixedError('probe-framing');
    chunks.push(payload.subarray(offset, offset + size));
    offset += size;
    if (payload[offset] !== 0x0d || payload[offset + 1] !== 0x0a) throw fixedError('probe-framing');
    offset += 2;
  }
}

export function parseHealthResponseForTest(response, expectedBody) {
  if (!Buffer.isBuffer(response) || response.length > PROBE_MAX_BYTES) throw fixedError('probe-size');
  const headerEnd = response.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw fixedError('probe-framing');
  const rawHead = response.subarray(0, headerEnd).toString('latin1');
  if (!/^[\x20-\x7e\r\n]+$/u.test(rawHead)) throw fixedError('probe-framing');
  const lines = rawHead.split('\r\n');
  if (lines.shift() !== 'HTTP/1.1 200 OK') throw fixedError('probe-status');
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) throw fixedError('probe-framing');
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9-]+$/u.test(name) || headers.has(name) || !/^[\x20-\x7e]*$/u.test(value)) {
      throw fixedError('probe-framing');
    }
    headers.set(name, value);
  }
  if (headers.get('connection')?.toLowerCase() !== 'close') throw fixedError('probe-framing');
  const payload = response.subarray(headerEnd + 4);
  const contentLength = headers.get('content-length');
  const transferEncoding = headers.get('transfer-encoding');
  if ((contentLength === undefined) === (transferEncoding === undefined)) throw fixedError('probe-framing');
  let body;
  if (contentLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) !== payload.length) {
      throw fixedError('probe-framing');
    }
    body = payload;
  } else {
    if (transferEncoding?.toLowerCase() !== 'chunked') throw fixedError('probe-framing');
    body = decodeChunked(payload);
  }
  if (!body.equals(Buffer.from(expectedBody))) throw fixedError('probe-body');
}

export function probeEndpointForTest(endpoint) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let ended = false;
    const socket = createConnection({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(fixedError('probe-timeout'));
    }, PROBE_TIMEOUT_MS);
    socket.once('connect', () => socket.write(endpoint.healthRequest));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > PROBE_MAX_BYTES) {
        clearTimeout(timer);
        socket.destroy();
        reject(fixedError('probe-size'));
      } else {
        chunks.push(chunk);
      }
    });
    socket.once('end', () => {
      ended = true;
      clearTimeout(timer);
      const response = Buffer.concat(chunks);
      socket.destroy();
      try {
        parseHealthResponseForTest(response, endpoint.healthBody);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (!ended) reject(error);
    });
  });
}

function requireRefused(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(fixedError('unexpected-listener-timeout'));
    }, PROBE_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(fixedError('unexpected-listener'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error?.code === 'ECONNREFUSED') resolve();
      else reject(fixedError('unexpected-listener-result'));
    });
  });
}

async function probeProfile(profile) {
  for (const endpoint of PROFILES[profile]) await probeEndpointForTest(endpoint);
  if (profile === 'images') await requireRefused(ENDPOINTS.package);
}

async function serveProfile(profile) {
  const relay = await startRelayProfile(PROFILES[profile]);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void relay.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await relay.done;
  } finally {
    await relay.close();
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`${APPLE_VM_EGRESS_RELAY_VERSION}\n`);
    return;
  }
  if (argv.length !== 2 || !['serve', 'probe'].includes(argv[0]) || !Object.hasOwn(PROFILES, argv[1])) {
    process.stderr.write('IRONCURTAIN_APPLE_VM_EGRESS_RELAY_USAGE/1\n');
    process.exitCode = 64;
    return;
  }
  if (argv[0] === 'serve') await serveProfile(argv[1]);
  else await probeProfile(argv[1]);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('IRONCURTAIN_APPLE_VM_EGRESS_RELAY_ERROR/1\n');
    process.exitCode = 1;
  });
}
