/**
 * TLS-terminating MITM proxy for Docker agent sessions.
 *
 * Replaces the passthrough CONNECT proxy with one that:
 * 1. Terminates TLS using per-host certs signed by the IronCurtain CA
 * 2. Filters HTTP requests to allowed LLM API endpoints only
 * 3. Swaps fake sentinel API keys for real ones before forwarding
 * 4. Streams SSE responses without buffering
 *
 * Architecture:
 * - Outer server: http.createServer on UDS, handles CONNECT
 * - Inner server: shared http.createServer (not listening), receives
 *   decrypted connections via emit('connection', tlsSocket)
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type { Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import forge from 'node-forge';
import { randomSerialNumber, type CertificateAuthority } from './ca.js';
import {
  isEndpointAllowed,
  shouldRewriteBody,
  type ProviderConfig,
  type RequestBodyRewriter,
} from './provider-config.js';
import * as logger from '../logger.js';

export interface MitmProxy {
  /** Start listening on the UDS or TCP port. Pre-warms cert cache for all providers. */
  start(): Promise<{ socketPath?: string; port?: number }>;
  /** Stop the proxy and close all connections. */
  stop(): Promise<void>;
}

export interface MitmProxyOptions {
  /** Absolute path for the Unix domain socket (UDS mode). Omit for TCP mode. */
  readonly socketPath?: string;
  /** TCP port to listen on (0 for OS-assigned). Omit for UDS mode. */
  readonly listenPort?: number;
  /** CA certificate and key for signing per-host certs. */
  readonly ca: CertificateAuthority;
  /**
   * Provider configurations with real API keys.
   * The proxy uses these for host allowlisting, key swapping, and endpoint filtering.
   */
  readonly providers: readonly ProviderKeyMapping[];
}

export interface ProviderKeyMapping {
  readonly config: ProviderConfig;
  /** The fake sentinel key given to the container. */
  readonly fakeKey: string;
  /** The real API key to inject in upstream requests. */
  readonly realKey: string;
}

/** Connection reset errors are routine during proxy shutdown or client disconnect. */
function isConnectionReset(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ECONNRESET' || err.code === 'EPIPE';
}

const MAX_REWRITE_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Buffers the entire request body into a single Buffer.
 * Rejects if the body exceeds maxBytes.
 */
function bufferRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createMitmProxy(options: MitmProxyOptions): MitmProxy {
  // Parse CA cert and key from PEM
  const caCert = forge.pki.certificateFromPem(options.ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(options.ca.keyPem);

  // Build host → provider lookup
  const providersByHost = new Map<string, ProviderKeyMapping>();
  for (const mapping of options.providers) {
    providersByHost.set(mapping.config.host, mapping);
  }

  // Certificate cache: hostname → tls.SecureContext
  const certCache = new Map<string, tls.SecureContext>();

  /**
   * Returns a cached SecureContext for the hostname, generating one if needed.
   * Synchronous because node-forge's RSA key generation is pure JS.
   */
  function getOrCreateSecureContext(hostname: string): tls.SecureContext {
    const cached = certCache.get(hostname);
    if (cached) return cached;

    // Generate leaf cert signed by IronCurtain CA
    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    const leafCert = forge.pki.createCertificate();

    leafCert.publicKey = leafKeys.publicKey;
    leafCert.serialNumber = randomSerialNumber();
    leafCert.validity.notBefore = new Date();
    leafCert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    leafCert.setSubject([{ name: 'commonName', value: hostname }]);
    leafCert.setIssuer(caCert.subject.attributes);
    leafCert.setExtensions([
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ]);

    leafCert.sign(caKey, forge.md.sha256.create());

    const ctx = tls.createSecureContext({
      key: forge.pki.privateKeyToPem(leafKeys.privateKey),
      cert: forge.pki.certificateToPem(leafCert),
    });

    certCache.set(hostname, ctx);
    return ctx;
  }

  // Connection tracking
  const activeClientSockets = new Set<Socket>();
  const activeTlsSockets = new Set<tls.TLSSocket>();
  const activeUpstreamRequests = new Set<http.ClientRequest>();
  const socketMetadata = new WeakMap<tls.TLSSocket, { provider: ProviderKeyMapping; host: string; port: number }>();

  let connectionId = 0;

  // Inner HTTP server - shared across all decrypted connections
  const innerServer = http.createServer();

  // Handle HTTP parse errors on decrypted connections
  innerServer.on('clientError', (err, socket) => {
    const log = isConnectionReset(err) ? logger.debug : logger.info;
    log(`[mitm-proxy] client HTTP parse error: ${err.message}`);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  innerServer.on('request', (clientReq: http.IncomingMessage, clientRes: http.ServerResponse) => {
    const tlsSock = clientReq.socket as tls.TLSSocket;
    const meta = socketMetadata.get(tlsSock);
    if (!meta) {
      clientRes.writeHead(500);
      clientRes.end('Internal error: unknown connection');
      return;
    }

    const { provider, host: targetHost, port: targetPort } = meta;
    const { method, url: path, headers } = clientReq;

    // 1. Endpoint filtering
    if (!isEndpointAllowed(provider.config, method, path)) {
      logger.info(`[mitm-proxy] BLOCKED ${method} ${targetHost}${path}`);
      clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
      clientRes.end(`Blocked: ${method} ${path} is not an allowed endpoint.`);
      return;
    }

    // 2. Fake key validation + swap
    const modifiedHeaders = { ...headers };
    if (!validateAndSwapApiKey(modifiedHeaders, provider)) {
      logger.info(`[mitm-proxy] REJECTED ${method} ${targetHost}${path} - invalid API key`);
      clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
      clientRes.end('Rejected: API key does not match expected sentinel.');
      return;
    }
    modifiedHeaders.host = targetHost;

    // 3. Forward to real API - either direct pipe or buffer+rewrite
    const needsRewrite = shouldRewriteBody(provider.config, method, path);

    function forwardRequest(bodyOverride?: Buffer): void {
      logger.info(`[mitm-proxy] ${method} ${targetHost}${path} → FORWARDED`);

      const finalHeaders = { ...modifiedHeaders };
      if (bodyOverride) {
        finalHeaders['content-length'] = bodyOverride.length.toString();
      }

      const upstreamReq = https.request(
        {
          hostname: targetHost,
          port: targetPort,
          method,
          path,
          headers: finalHeaders,
        },
        (upstreamRes) => {
          upstreamRes.on('error', (err) => {
            const log = isConnectionReset(err) ? logger.debug : logger.info;
            log(`[mitm-proxy] upstream response error: ${err.message}`);
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
              clientRes.end(`Upstream response error: ${err.message}`);
            } else {
              clientRes.socket?.destroy();
            }
          });

          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          clientRes.flushHeaders();
          clientRes.socket?.setNoDelay(true);
          upstreamRes.pipe(clientRes);
        },
      );

      activeUpstreamRequests.add(upstreamReq);
      upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));

      upstreamReq.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] upstream error: ${err.message}`);
        activeUpstreamRequests.delete(upstreamReq);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
          clientRes.end(`Upstream error: ${err.message}`);
        } else {
          clientRes.socket?.destroy();
        }
      });

      clientRes.on('close', () => {
        if (!upstreamReq.destroyed) {
          upstreamReq.destroy();
        }
      });

      if (bodyOverride) {
        upstreamReq.end(bodyOverride);
      } else {
        clientReq.on('error', (err) => {
          const log = isConnectionReset(err) ? logger.debug : logger.info;
          log(`[mitm-proxy] client request error: ${err.message}`);
          upstreamReq.destroy();
        });
        clientReq.pipe(upstreamReq);
      }
    }

    if (needsRewrite) {
      // shouldRewriteBody guarantees requestRewriter, method, and path are defined
      const rewriter = provider.config.requestRewriter as RequestBodyRewriter;
      const reqMethod = method as string;
      const reqPath = path as string;

      bufferRequestBody(clientReq, MAX_REWRITE_BODY_BYTES)
        .then((rawBody) => {
          let finalBody = rawBody;
          try {
            const parsed = JSON.parse(rawBody.toString()) as Record<string, unknown>;
            const result = rewriter(parsed, { method: reqMethod, path: reqPath });
            if (result) {
              finalBody = Buffer.from(JSON.stringify(result.modified));
              logger.info(
                `[mitm-proxy] POST ${targetHost}${path} - stripped server-side tools: ${result.stripped.join(', ')}`,
              );
            }
          } catch {
            logger.info(`[mitm-proxy] POST ${targetHost}${path} - failed to parse request body, forwarding as-is`);
          }
          forwardRequest(finalBody);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Request body too large';
          if (!clientRes.headersSent) {
            clientRes.writeHead(413, { 'Content-Type': 'text/plain' });
            clientRes.end(message);
          }
        });
    } else {
      forwardRequest();
    }
  });

  // Outer server - UDS listener, handles CONNECT
  const outerServer = http.createServer((_req, res) => {
    // Only CONNECT is supported; reject everything else
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  });

  outerServer.on('connect', (req: http.IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    const colonIndex = url.lastIndexOf(':');
    const host = colonIndex > 0 ? url.substring(0, colonIndex) : url;
    const port = colonIndex > 0 ? parseInt(url.substring(colonIndex + 1), 10) : 443;
    const connId = ++connectionId;

    // Handle client socket errors early to prevent uncaught 'error' events
    clientSocket.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] #${connId} client socket error: ${err.message}`);
      clientSocket.destroy();
    });

    // Track raw client socket for cleanup during stop()
    activeClientSockets.add(clientSocket);
    clientSocket.on('close', () => activeClientSockets.delete(clientSocket));

    // 1. Check allowlist
    const provider = providersByHost.get(host);
    if (!provider) {
      logger.info(`[mitm-proxy] #${connId} DENIED CONNECT ${host}:${port}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    logger.info(`[mitm-proxy] #${connId} CONNECT ${host}:${port} → MITM`);

    // 2. Acknowledge the CONNECT
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // 3. Push back any bytes that arrived after the CONNECT request line
    if (head.length > 0) {
      clientSocket.unshift(head);
    }

    // 4. Upgrade to TLS (MITM)
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      SNICallback: (servername, cb) => {
        const ctx = getOrCreateSecureContext(servername);
        cb(null, ctx);
      },
    });

    // 5. TLS handshake timeout - if the handshake completes, the 'secure'
    //    event clears this timer. If it fires, the handshake never completed.
    const handshakeTimeout = setTimeout(() => {
      logger.info(`[mitm-proxy] #${connId} TLS handshake timeout`);
      tlsSocket.destroy();
    }, 10_000);
    tlsSocket.once('secure', () => clearTimeout(handshakeTimeout));

    // 6. Track the connection
    activeTlsSockets.add(tlsSocket);
    socketMetadata.set(tlsSocket, { provider, host, port });

    tlsSocket.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] #${connId} TLS error: ${err.message}`);
      tlsSocket.destroy();
    });
    tlsSocket.on('close', () => {
      clearTimeout(handshakeTimeout);
      activeTlsSockets.delete(tlsSocket);
    });

    // 7. Emit into shared inner HTTP server
    innerServer.emit('connection', tlsSocket);
  });

  const useTcp = options.listenPort !== undefined;

  return {
    async start() {
      // Pre-warm cert cache for all configured providers
      for (const mapping of options.providers) {
        getOrCreateSecureContext(mapping.config.host);
      }

      if (useTcp) {
        // TCP mode: listen on host:port
        return new Promise((resolve, reject) => {
          const onError = reject;
          outerServer.listen(options.listenPort, '0.0.0.0', () => {
            outerServer.removeListener('error', onError);
            const addr = outerServer.address();
            const port = addr && typeof addr === 'object' ? addr.port : (options.listenPort ?? 0);
            resolve({ port });
          });
          outerServer.once('error', onError);
        });
      }

      // UDS mode: listen on socket path
      const socketPath = options.socketPath ?? '';
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }

      return new Promise((resolve, reject) => {
        const onError = reject;
        outerServer.listen(socketPath, () => {
          outerServer.removeListener('error', onError);
          resolve({ socketPath });
        });
        outerServer.once('error', onError);
      });
    },

    async stop() {
      // 1. Abort all in-flight upstream requests
      for (const req of activeUpstreamRequests) {
        req.destroy();
      }
      activeUpstreamRequests.clear();

      // 2. Destroy all active TLS sockets and raw client sockets.
      // Must happen before outerServer.close() because the raw sockets
      // are still tracked by the underlying net.Server, and close()
      // waits for all TCP connections to end.
      for (const sock of activeTlsSockets) {
        sock.destroy();
      }
      activeTlsSockets.clear();
      for (const sock of activeClientSockets) {
        sock.destroy();
      }
      activeClientSockets.clear();

      // 3. Close outer server - stop accepting new connections.
      // closeAllConnections() handles any non-upgraded HTTP connections.
      outerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        outerServer.close(() => resolve());
      });

      // 4. Close the inner HTTP server.
      innerServer.closeAllConnections();
      innerServer.close();

      // 5. Clean up socket file (UDS mode only)
      if (!useTcp && options.socketPath) {
        try {
          if (existsSync(options.socketPath)) {
            unlinkSync(options.socketPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}

/**
 * Validates that the request carries the expected fake key, then replaces
 * it with the real key. Returns false if the fake key does not match.
 */
function validateAndSwapApiKey(
  headers: Record<string, string | string[] | undefined>,
  provider: ProviderKeyMapping,
): boolean {
  const { keyInjection } = provider.config;

  switch (keyInjection.type) {
    case 'header': {
      const headerName = keyInjection.headerName.toLowerCase();
      const currentValue = headers[headerName];
      if (currentValue !== provider.fakeKey) return false;
      headers[headerName] = provider.realKey;
      return true;
    }
    case 'bearer': {
      const authHeader = headers['authorization'];
      if (authHeader !== `Bearer ${provider.fakeKey}`) return false;
      headers['authorization'] = `Bearer ${provider.realKey}`;
      return true;
    }
  }
}
