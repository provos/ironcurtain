/**
 * Destination-bound HTTP(S) transport for MITM and registry upstreams.
 *
 * Callers supply a trusted destination separately from request headers. The
 * transport owns Host/SNI, applies a public-only policy by default, and permits
 * private destinations only for an explicit trusted provider override. It
 * resolves and screens every destination name locally, never follows redirects,
 * and can route through one fixed parent HTTP proxy without exposing a
 * caller-selected CONNECT primitive.
 *
 * ## The child is the address authority
 *
 * Both transports enforce the same destination-address policy in *this*
 * process, before any byte reaches the network: a literal destination is
 * screened against the request's address policy, and a destination *name* is
 * resolved through a guarded resolver that rejects the entire answer set if
 * any answer violates that policy.
 *
 * The parent-proxy transport cannot delegate that check upward. A parent cannot
 * re-derive a derived-CDN authority: such a host is authorized only as the
 * immediate `Location` of one specific authorized response, so a parent
 * registry-egress listener would see a *client-initiated* request to an unlisted
 * host and fail closed, and a standard-mode parent would simply 403 the CONNECT.
 * The child is therefore the only place the address policy can be enforced, and
 * {@link OutboundTransport.addressGuard} publishes that property so a caller
 * whose destination is attacker-influenced (registry-egress redirect following)
 * can *require* it instead of assuming it.
 *
 * ## Accepted residual: no address pinning through the parent
 *
 * On the direct path the screened answer set is also the answer set used to
 * connect, so the check and the connection cannot diverge. Through the parent,
 * the child screens the name and the parent then re-resolves it, so the guarded
 * resolver restores the *policy* check but not direct mode's *pinning*
 * property: a TTL-0 DNS rebind landing between the two resolutions can still
 * reach a private address. Pinning by sending the resolved literal as the
 * CONNECT authority is not an option — that authority is also the SNI and
 * certificate-validation identity, and the provider/registry paths require the
 * real name (see `servername` below). The residual is accepted under this
 * project's trusted-host model (an IronCurtain-owned parent on a trusted host,
 * reaching a reviewed frozen set of origins) and is recorded here rather than
 * left implied.
 */

import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { domainToASCII } from 'node:url';
import type { Duplex } from 'node:stream';

export type OutboundProtocol = 'http:' | 'https:';
export type OutboundAddressPolicy = 'public-only' | 'trusted-provider-override';

export interface OutboundDestination {
  readonly protocol: OutboundProtocol;
  readonly hostname: string;
  readonly port: number;
}

export interface DestinationBoundRequest {
  readonly destination: OutboundDestination;
  /**
   * Public-only by default. The trusted provider-routing branch may opt into a
   * host-configured private gateway; untrusted passthrough, redirects, build,
   * and registry callers must never set this.
   */
  readonly addressPolicy?: OutboundAddressPolicy;
  readonly method: string | undefined;
  readonly path: string;
  readonly headers?: http.OutgoingHttpHeaders;
}

/**
 * Where the destination-address policy is enforced for this transport.
 *
 * - `local-resolver`: this process resolves the destination name and refuses a
 *   non-public answer before any I/O — the guarantee callers can rely on.
 * - `delegated`: some other hop is assumed to apply the policy. A caller that
 *   forwards an attacker-influenced destination (e.g. a derived redirect) must
 *   refuse such a transport rather than assume the assumption holds.
 */
export type OutboundAddressGuard = 'local-resolver' | 'delegated';

export interface OutboundTransport {
  readonly kind: 'direct' | 'fixed-parent-proxy';
  /** Checked capability, not an assumption; see {@link OutboundAddressGuard}. */
  readonly addressGuard: OutboundAddressGuard;
  request(request: DestinationBoundRequest, onResponse?: (response: http.IncomingMessage) => void): http.ClientRequest;
}

export interface DirectOutboundTransportOptions {
  /** Test seam. Production uses node:dns.lookup. */
  readonly lookup?: typeof dns.lookup;
  /** Test-only escape hatch for loopback fake upstreams. */
  readonly allowPrivateDestinationsForTests?: boolean;
}

export type FixedParentProxyEndpoint =
  | { readonly socketPath: string; readonly hostname?: never; readonly port?: never }
  | { readonly socketPath?: never; readonly hostname: string; readonly port: number };

export interface ParentProxyOutboundTransportOptions {
  readonly proxy: FixedParentProxyEndpoint;
  /** Extra public CA material for the TLS connection inside CONNECT. */
  readonly ca?: string | readonly string[];
  /** Test seam. Production uses node:dns.lookup. */
  readonly lookup?: typeof dns.lookup;
  /** Test-only escape hatch for loopback fake upstreams. */
  readonly allowPrivateDestinationsForTests?: boolean;
}

export function createDirectOutboundTransport(options: DirectOutboundTransportOptions = {}): OutboundTransport {
  const resolver = options.lookup ?? dns.lookup;
  const publicLookup = createGuardedLookup(resolver, false);
  const trustedPrivateLookup = createGuardedLookup(resolver, true);
  const allowPrivateForEveryRequest = options.allowPrivateDestinationsForTests === true;
  return {
    kind: 'direct',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      const allowPrivate = allowPrivateForEveryRequest || request.addressPolicy === 'trusted-provider-override';
      const normalized = normalizeRequest(request, allowPrivate);
      const requestOptions: http.RequestOptions = {
        hostname: normalized.destination.hostname,
        port: normalized.destination.port,
        method: normalized.method,
        path: normalized.path,
        headers: normalized.headers,
        lookup: allowPrivate ? trustedPrivateLookup : publicLookup,
      };
      return normalized.destination.protocol === 'https:'
        ? https.request(requestOptions, onResponse)
        : http.request(requestOptions, onResponse);
    },
  };
}

export function createParentProxyOutboundTransport(options: ParentProxyOutboundTransportOptions): OutboundTransport {
  const proxy = normalizeProxyEndpoint(options.proxy);
  const resolver = options.lookup ?? dns.lookup;
  const publicScreen = createDestinationScreen(resolver, false);
  const trustedPrivateScreen = createDestinationScreen(resolver, true);
  const publicHttpsAgent = new FixedParentProxyHttpsAgent(proxy, options.ca, publicScreen);
  const publicHttpAgent = new FixedParentProxyHttpAgent(proxy, publicScreen);
  const trustedPrivateHttpsAgent = new FixedParentProxyHttpsAgent(proxy, options.ca, trustedPrivateScreen);
  const trustedPrivateHttpAgent = new FixedParentProxyHttpAgent(proxy, trustedPrivateScreen);
  const allowPrivateForEveryRequest = options.allowPrivateDestinationsForTests === true;
  return {
    kind: 'fixed-parent-proxy',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      // This child is the address authority: the parent cannot re-derive a
      // derived-CDN authority, so it cannot be the place the address policy is
      // applied. Literal/local destinations are refused here, and both agents
      // screen the destination *name* against the guarded resolver before any
      // CONNECT authority or absolute-form target is written to the parent.
      const allowPrivate = allowPrivateForEveryRequest || request.addressPolicy === 'trusted-provider-override';
      const normalized = normalizeRequest(request, allowPrivate);
      if (normalized.destination.protocol === 'http:') {
        const absolutePath =
          `http://${formatAuthority(normalized.destination.hostname, normalized.destination.port, 'http:')}` +
          normalized.path;
        return http.request(
          {
            hostname: normalized.destination.hostname,
            port: normalized.destination.port,
            method: normalized.method,
            path: absolutePath,
            headers: normalized.headers,
            agent: allowPrivate ? trustedPrivateHttpAgent : publicHttpAgent,
          },
          onResponse,
        );
      }
      return https.request(
        {
          hostname: normalized.destination.hostname,
          port: normalized.destination.port,
          method: normalized.method,
          path: normalized.path,
          headers: normalized.headers,
          agent: allowPrivate ? trustedPrivateHttpsAgent : publicHttpsAgent,
        },
        onResponse,
      );
    },
  };
}

/**
 * Screen one destination *name* by resolving it through the shared guarded
 * resolver and discarding the answer. A literal destination has already been
 * screened by {@link assertHostnameIsEligible}, so it needs no resolution (and
 * `net.connect` would not resolve it either).
 */
type DestinationScreen = (hostname: string, done: (error: Error | null) => void) => void;

function createDestinationScreen(lookup: typeof dns.lookup, allowPrivate: boolean): DestinationScreen {
  const guarded = createGuardedLookup(lookup, allowPrivate);
  return (hostname, done) => {
    if (net.isIP(hostname) !== 0) {
      done(null);
      return;
    }
    guarded(hostname, { all: true }, (error) => done(error ?? null));
  };
}

/**
 * Reaches the fixed parent proxy for a plain-HTTP (absolute-form) request.
 *
 * The destination screen lives in `createConnection` — the same place the HTTPS
 * agent screens before writing its CONNECT authority — so both branches share
 * one control, an asynchronous check never makes `request()` asynchronous, and
 * no absolute-form target for a rejected destination is ever written to the
 * parent.
 */
class FixedParentProxyHttpAgent extends http.Agent {
  constructor(
    private readonly proxy: http.RequestOptions,
    private readonly screenDestination: DestinationScreen,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback: (error: Error | null, stream?: Duplex) => void,
  ): Duplex | null | undefined {
    const hostname = normalizeHostname(options.hostname ?? options.host ?? '');
    this.screenDestination(hostname, (error) => {
      if (error) {
        callback(error);
        return;
      }
      callback(null, net.connect(parentConnectOptions(this.proxy)));
    });
    return undefined;
  }
}

class FixedParentProxyHttpsAgent extends https.Agent {
  constructor(
    private readonly proxy: http.RequestOptions,
    private readonly extraCa: string | readonly string[] | undefined,
    private readonly screenDestination: DestinationScreen,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: https.RequestOptions,
    callback: (error: Error | null, stream?: Duplex) => void,
  ): Duplex | null | undefined {
    const hostname = normalizeHostname(options.hostname ?? options.host ?? '');
    const port = normalizePort(Number(options.port ?? 443));
    // CONNECT always carries an explicit port, including the default 443.
    // Unlike an HTTP Host header, the authority-form request target has no
    // surrounding scheme from which a proxy could infer a missing port.
    const authority = formatConnectAuthority(hostname, port);
    let settled = false;
    const done = (error: Error | null, stream?: Duplex): void => {
      if (settled) return;
      settled = true;
      callback(error, stream);
    };
    // Screen before the CONNECT authority reaches the parent: a name resolving
    // to a non-public address must fail here, not become a parent request.
    this.screenDestination(hostname, (screenError) => {
      if (screenError) {
        done(screenError);
        return;
      }
      const connectRequest = http.request({
        ...this.proxy,
        method: 'CONNECT',
        path: authority,
        headers: { host: authority },
      });
      connectRequest.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          done(new Error(`fixed parent proxy refused ${authority} with status ${response.statusCode ?? 'unknown'}`));
          return;
        }
        if (head.length > 0) socket.unshift(head);
        const connectionOptions: tls.ConnectionOptions = {
          socket,
          // SNI and certificate validation bind to the NAME, never to a
          // resolved literal — that is why the parent path cannot pin.
          servername: net.isIP(hostname) === 0 ? hostname : undefined,
        };
        if (this.extraCa !== undefined) {
          connectionOptions.ca = typeof this.extraCa === 'string' ? this.extraCa : [...this.extraCa];
        }
        const secureSocket = tls.connect(connectionOptions);
        secureSocket.once('secureConnect', () => done(null, secureSocket));
        secureSocket.once('error', (error) => done(error));
      });
      connectRequest.once('error', (error) => done(error));
      connectRequest.end();
    });
    return undefined;
  }
}

function normalizeRequest(request: DestinationBoundRequest, allowPrivate: boolean): DestinationBoundRequest {
  const destination = {
    protocol: request.destination.protocol,
    hostname: normalizeHostname(request.destination.hostname),
    port: normalizePort(request.destination.port),
  } as const;
  assertHostnameIsEligible(destination.hostname, allowPrivate);
  if (!request.path.startsWith('/') || /[\r\n]/u.test(request.path) || /^\/\//u.test(request.path)) {
    throw new Error('destination-bound request path must be origin-form');
  }
  const method = (request.method ?? 'GET').toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,31}$/u.test(method)) throw new Error(`invalid outbound method: ${method}`);
  if (method === 'CONNECT') {
    throw new Error('destination-bound transport does not expose generic CONNECT');
  }
  return {
    destination,
    method,
    path: request.path,
    headers: normalizeHeaders(request.headers, destination),
  };
}

function normalizeHeaders(
  headers: http.OutgoingHttpHeaders | undefined,
  destination: OutboundDestination,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    // This is the final destination-bound transport, not a general forwarding
    // proxy: its callers own message framing and have already stripped the
    // full request-direction hop-by-hop set (see `HOP_BY_HOP_HEADERS`). It
    // deliberately strips only the proxy-routing headers and rewrites `host` —
    // stripping `transfer-encoding` here would corrupt the chunked LLM request
    // bodies streamed through it (mitm-proxy `forwardRequest`).
    if (lower === 'host' || lower === 'proxy-authorization' || lower === 'proxy-connection') continue;
    const invalidValue =
      (typeof value === 'string' && /[\r\n]/u.test(value)) ||
      (Array.isArray(value) && value.some((entry) => /[\r\n]/u.test(entry)));
    if (name === '' || /[^!#$%&'*+.^_a-z0-9|~-]/iu.test(name) || invalidValue) {
      throw new Error(`invalid outbound header: ${name}`);
    }
    if (value !== undefined) result[lower] = value;
  }
  result.host = formatAuthority(destination.hostname, destination.port, destination.protocol);
  return result;
}

function normalizeHostname(value: string): string {
  const candidate = value.trim().replace(/\.$/u, '').toLowerCase();
  const ascii = domainToASCII(candidate);
  if (
    ascii === '' ||
    ascii.length > 253 ||
    /[\r\n/:]/u.test(ascii) ||
    ascii.split('.').some((label) => label === '' || label.length > 63)
  ) {
    throw new Error(`invalid outbound hostname: ${value}`);
  }
  return ascii;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid outbound port: ${port}`);
  return port;
}

function assertHostnameIsEligible(hostname: string, allowPrivate: boolean): void {
  const lower = hostname.toLowerCase();
  if (lower === 'metadata.google.internal') {
    throw new Error(`outbound destination is metadata-scoped: ${hostname}`);
  }
  if (
    !allowPrivate &&
    (lower === 'localhost' ||
      lower.endsWith('.localhost') ||
      lower.endsWith('.local') ||
      lower.endsWith('.internal') ||
      lower.endsWith('.docker.internal'))
  ) {
    throw new Error(`outbound destination is local or metadata-scoped: ${hostname}`);
  }
  if (net.isIP(hostname) !== 0 && !(allowPrivate ? isTrustedProviderAddress(hostname) : isPublicAddress(hostname))) {
    throw new Error(
      allowPrivate
        ? `outbound destination address is not allowed by its address policy: ${hostname}`
        : `outbound destination address is not public: ${hostname}`,
    );
  }
}

/**
 * Wrap a resolver so it fails the whole lookup when *any* returned address is
 * non-public. This is the single implementation of the address policy for name
 * destinations; it is shared by the direct transport (as `RequestOptions.lookup`),
 * by the fixed-parent transport's destination screen, and by the MITM proxy's
 * raw passthrough tunnel, so none of them can drift from the others.
 */
export function createGuardedLookup(lookup: typeof dns.lookup, allowPrivate: boolean): typeof dns.lookup {
  type LookupResult = string | dns.LookupAddress[];
  type LookupCallback = (error: NodeJS.ErrnoException | null, result: LookupResult, family?: number) => void;
  const invokeLookup = lookup as unknown as (
    hostname: string,
    options: dns.LookupAllOptions,
    callback: LookupCallback,
  ) => void;
  return ((hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    const allOptions: dns.LookupAllOptions = { ...options, all: true, verbatim: true };
    invokeLookup(hostname, allOptions, (error, result, family) => {
      if (error) {
        callback(error, []);
        return;
      }
      const addresses = Array.isArray(result) ? result : [{ address: result, family: family === 6 ? 6 : 4 }];
      if (
        addresses.length === 0 ||
        addresses.some(
          (entry) =>
            net.isIP(entry.address) === 0 ||
            !(allowPrivate ? isTrustedProviderAddress(entry.address) : isPublicAddress(entry.address)),
        )
      ) {
        callback(new Error(`DNS resolution for ${hostname} included a non-public address or disallowed address`), []);
        return;
      }
      if (options.all) callback(null, addresses);
      else {
        const selected = addresses[0];
        callback(null, selected.address, selected.family);
      }
    });
  }) as typeof dns.lookup;
}

/** Conservative routability classifier used for SSRF and rebinding defense. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const value = (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
    return ![
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([network, bits]) => ipv4InCidr(value, String(network), Number(bits)));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice('::ffff:'.length));
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

/**
 * Private destinations intentionally supported for a trusted provider gateway.
 * Link-local/metadata, unspecified, multicast, and documentation-only ranges
 * remain denied even on this path.
 */
function isTrustedProviderAddress(address: string): boolean {
  if (isPublicAddress(address)) return true;
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const value = (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
    return [
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
    ].some(([network, bits]) => ipv4InCidr(value, String(network), Number(bits)));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isTrustedProviderAddress(normalized.slice('::ffff:'.length));
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd');
  }
  return false;
}

function ipv4InCidr(value: number, network: string, bits: number): boolean {
  const octets = network.split('.').map(Number);
  const base = (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffff_ffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function formatAuthority(hostname: string, port: number, protocol: OutboundProtocol): string {
  const host = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const standard = (protocol === 'https:' && port === 443) || (protocol === 'http:' && port === 80);
  return standard ? host : `${host}:${port}`;
}

function formatConnectAuthority(hostname: string, port: number): string {
  const host = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return `${host}:${port}`;
}

function normalizeProxyEndpoint(endpoint: FixedParentProxyEndpoint): http.RequestOptions {
  if (endpoint.socketPath !== undefined) {
    if (!endpoint.socketPath.startsWith('/') || /[\r\n\0]/u.test(endpoint.socketPath)) {
      throw new Error('fixed parent proxy socketPath must be absolute');
    }
    return { socketPath: endpoint.socketPath };
  }
  const hostname = normalizeHostname(endpoint.hostname);
  const port = normalizePort(endpoint.port);
  return { hostname, port };
}

/** The already-normalized fixed parent endpoint as raw socket options. */
function parentConnectOptions(proxy: http.RequestOptions): net.NetConnectOpts {
  if (proxy.socketPath !== undefined) return { path: proxy.socketPath };
  return { host: proxy.hostname ?? undefined, port: Number(proxy.port) };
}
