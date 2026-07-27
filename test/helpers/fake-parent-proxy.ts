/**
 * A minimal stand-in for the fixed parent HTTP proxy that a nested IronCurtain
 * egresses through.
 *
 * Nested-mode tests need a parent that really answers `CONNECT` and really
 * terminates TLS, so the child's `createParentProxyOutboundTransport` can be
 * exercised end to end instead of being replaced by a fake transport. The
 * fixture records every CONNECT authority it is asked for, which is what lets a
 * test prove that a refused destination never became a parent request.
 */

import * as http from 'node:http';
import * as tls from 'node:tls';
import type { Socket } from 'node:net';
import forge from 'node-forge';

export interface TlsIdentity {
  readonly certPem: string;
  readonly keyPem: string;
}

/**
 * A self-signed certificate valid for `hostnames`, usable both as the fake
 * parent's TLS server identity and as the child transport's `ca` trust anchor —
 * no CA hierarchy needed for a fixture.
 */
export function createTlsIdentity(hostnames: readonly [string, ...string[]]): TlsIdentity {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: hostnames[0] }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: hostnames.map((value) => ({ type: 2, value })) },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) };
}

export type ParentRoute = (request: http.IncomingMessage, response: http.ServerResponse) => void;

export interface FakeParentProxyOptions {
  readonly socketPath: string;
  readonly identity: TlsIdentity;
  /** Handlers keyed by destination hostname; an unrouted authority is refused. */
  readonly routes: Readonly<Record<string, ParentRoute | undefined>>;
}

export interface FakeParentProxy {
  /** Every authority the parent was asked to CONNECT to, in order. */
  readonly connectAuthorities: readonly string[];
  close(): Promise<void>;
}

/**
 * Start the fixture on a UDS. It answers `CONNECT` for a routed authority,
 * terminates TLS with `identity`, and serves the matching route; an unrouted
 * authority is refused with `403` (as a real parent would).
 */
export async function startFakeParentProxy(options: FakeParentProxyOptions): Promise<FakeParentProxy> {
  const connectAuthorities: string[] = [];

  const inner = http.createServer((request, response) => {
    const hostname = (request.headers.host ?? '').split(':')[0];
    const route = options.routes[hostname];
    if (route === undefined) {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('fake parent proxy has no route\n');
      return;
    }
    route(request, response);
  });

  const outer = http.createServer();
  outer.on('connect', (request: http.IncomingMessage, socket: Socket, head: Buffer) => {
    const authority = request.url ?? '';
    connectAuthorities.push(authority);
    socket.on('error', () => undefined);
    if (!(authority.split(':')[0] in options.routes)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    const tlsSocket = new tls.TLSSocket(socket, {
      isServer: true,
      cert: options.identity.certPem,
      key: options.identity.keyPem,
    });
    tlsSocket.on('error', () => undefined);
    inner.emit('connection', tlsSocket);
  });

  await new Promise<void>((resolve, reject) => {
    outer.once('error', reject);
    outer.listen(options.socketPath, resolve);
  });

  return {
    connectAuthorities,
    close: () =>
      new Promise<void>((resolve) => {
        inner.closeAllConnections();
        outer.closeAllConnections();
        outer.close(() => resolve());
      }),
  };
}
