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
import * as net from 'node:net';
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
import type { OAuthTokenManager } from './oauth-token-manager.js';
import type { RegistryConfig, PackageValidator, AllowedVersionCache } from './package-types.js';
import { DENY_ALL_VALIDATOR } from './package-validator.js';
import { validateDomain, type DomainListing } from './proxy-tools.js';
import { PassThrough } from 'node:stream';
import type { TokenStreamBus } from './token-stream-bus.js';
import type { SseProvider } from './token-stream-types.js';
import { SseExtractorTransform } from './sse-extractor.js';
import * as logger from '../logger.js';

/**
 * Runtime control surface for the MITM proxy's host allowlist.
 *
 * Dynamically added hosts are passthrough-only: TLS is terminated
 * for auditability, but no credential replacement or endpoint
 * filtering is performed. The agent's own headers are forwarded
 * as-is to the upstream server.
 *
 * Provider domains that are already statically configured
 * cannot be added as passthrough. addHost() returns false for these
 * domains, and the tool handler surfaces a clear message to the agent.
 */
export interface DynamicHostController {
  /**
   * Add a domain to the passthrough allowlist.
   * Validates the domain format (no wildcards, no IP addresses,
   * no *.docker.internal, max 253 chars).
   *
   * @throws Error if the domain fails validation.
   * @returns true if the domain was newly added, false if already present
   *          (either as a static provider or a previous dynamic addition).
   */
  addHost(domain: string): boolean;

  /**
   * Remove a domain from the passthrough allowlist.
   * Cannot remove statically configured providers.
   *
   * @returns true if the domain was removed, false if not found or static.
   */
  removeHost(domain: string): boolean;

  /**
   * List all currently allowed hosts, grouped by type.
   */
  listHosts(): DomainListing;
}

export interface MitmProxy {
  /** Start listening on the UDS or TCP port. Pre-warms cert cache for all providers. */
  start(): Promise<{
    socketPath?: string;
    port?: number;
    controlSocketPath?: string;
    controlPort?: number;
  }>;
  /** Stop the proxy and close all connections. */
  stop(): Promise<void>;
  /** Runtime control for the dynamic host allowlist. */
  readonly hosts: DynamicHostController;
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

  /**
   * Package registry configurations.
   * When present, the proxy allows CONNECT to registry hosts and
   * validates/filters package metadata and tarball downloads.
   */
  readonly registries?: readonly RegistryConfig[];

  /**
   * Package validation configuration.
   * Only meaningful when registries is non-empty.
   */
  readonly packageValidation?: {
    readonly validator: PackageValidator;
    readonly auditLogPath?: string;
  };
  /**
   * Separate control socket path for domain management API.
   * Must NOT be in a directory mounted into the container.
   */
  readonly controlSocketPath?: string;
  /**
   * Separate control TCP port. Used in TCP mode (macOS).
   * 0 for OS-assigned.
   */
  readonly controlPort?: number;
  /**
   * Custom DNS lookup function for outbound connections.
   * Used in tests to avoid real DNS resolution.
   */
  readonly dnsLookup?: http.RequestOptions['lookup'];
  /**
   * Shared daemon-level token stream bus. When provided together with
   * `sessionId`, the proxy taps SSE responses from LLM API endpoints
   * and pushes parsed token events into the bus.
   *
   * Both `tokenStreamBus` and `sessionId` must be provided together.
   * If one is set without the other, `createMitmProxy()` throws.
   */
  readonly tokenStreamBus?: TokenStreamBus;
  /**
   * Session ID for token stream routing. Required when `tokenStreamBus`
   * is provided. Used to key events pushed into the bus.
   */
  readonly sessionId?: string;
}

export interface ProviderKeyMapping {
  readonly config: ProviderConfig;
  /** The fake sentinel key given to the container. */
  readonly fakeKey: string;
  /** The real API key to inject in upstream requests. Mutable for token refresh. */
  realKey: string;
  /** Optional token manager for OAuth providers — enables proactive refresh and 401 retry. */
  readonly tokenManager?: OAuthTokenManager;
}

/** Connection reset errors are routine during proxy shutdown or client disconnect. */
function isConnectionReset(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ECONNRESET' || err.code === 'EPIPE';
}

const MAX_REWRITE_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
/** Max Content-Length for which we buffer solely for 401 retry (1 MB). */
const MAX_RETRY_BODY_BYTES = 1 * 1024 * 1024;
/**
 * Max bytes buffered from a non-streaming JSON response body for token stream
 * extraction. The response is still streamed to the client unchanged; only
 * the extraction side stops capturing once the cap is hit. This protects the
 * proxy from unbounded memory growth on very large completions.
 */
export const MAX_JSON_RESPONSE_CAPTURE_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Output of `createBoundedJsonResponseCapture` -- the stateful hooks used to
 * drive a bounded capture over a chunked response stream.
 *
 * Exposed primarily for unit testing the OOM guard without standing up the
 * full mitm proxy pipeline.
 */
export interface BoundedJsonResponseCapture {
  /** Feed a chunk into the capture buffer. Always safe to call. */
  onData(chunk: Buffer): void;
  /**
   * Signal end-of-stream. If the limit was exceeded during capture this is
   * a no-op; otherwise it invokes `onComplete` with the concatenated buffer.
   */
  onEnd(onComplete: (body: Buffer) => void): void;
  /** True if the stream exceeded the cap and capture was aborted. */
  readonly overflowed: boolean;
  /** Bytes accounted for (capped at the limit). */
  readonly capturedBytes: number;
}

/**
 * Create a size-bounded capture for a JSON response body.
 *
 * Up to `maxBytes` of data is accumulated into an internal chunk array.
 * Once that threshold is crossed, any already-buffered chunks are released
 * (so large responses do not pin memory) and further chunks are ignored.
 * The caller is still responsible for piping the stream through to the
 * client -- this helper only manages the extraction-side buffer.
 */
export function createBoundedJsonResponseCapture(
  maxBytes: number = MAX_JSON_RESPONSE_CAPTURE_BYTES,
): BoundedJsonResponseCapture {
  let chunks: Buffer[] = [];
  let capturedBytes = 0;
  let overflowed = false;

  return {
    onData(chunk: Buffer): void {
      if (overflowed) return;
      capturedBytes += chunk.length;
      if (capturedBytes > maxBytes) {
        overflowed = true;
        // Release memory immediately.
        chunks = [];
        return;
      }
      chunks.push(chunk);
    },
    onEnd(onComplete: (body: Buffer) => void): void {
      if (overflowed) return;
      onComplete(Buffer.concat(chunks));
    },
    get overflowed(): boolean {
      return overflowed;
    },
    get capturedBytes(): number {
      return capturedBytes;
    },
  };
}

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

/**
 * Maps a target hostname to the SSE provider for token stream parsing.
 * Only Anthropic and OpenAI hosts are recognized; everything else
 * falls back to 'unknown'.
 */
export function resolveSseProvider(hostname: string): SseProvider {
  if (hostname === 'api.anthropic.com' || hostname === 'platform.claude.com') {
    return 'anthropic';
  }
  if (hostname === 'api.openai.com') {
    return 'openai';
  }
  return 'unknown';
}

/** Maximum characters for tool_result content before truncation. */
const MAX_TOOL_RESULT_CONTENT_LEN = 500;

/** Truncate tool result content to MAX_TOOL_RESULT_CONTENT_LEN, appending ellipsis if needed. */
function truncateToolResult(text: string): string {
  return text.length > MAX_TOOL_RESULT_CONTENT_LEN ? text.slice(0, MAX_TOOL_RESULT_CONTENT_LEN) + '\u2026' : text;
}

/** Returns true for LLM messages endpoints that carry multi-turn request bodies. */
function isLlmMessagesEndpoint(path: string): boolean {
  const p = path.split('?')[0];
  return p === '/v1/messages' || p === '/v1/chat/completions';
}

/**
 * Extract tool_result blocks from a parsed Anthropic/OpenAI request body
 * and push them as TokenStreamEvents to the bus.
 *
 * Anthropic format: messages[].role === 'user', content[].type === 'tool_result'
 * OpenAI format: messages[].role === 'tool', with tool_call_id
 *
 * Only extracts from the trailing user/tool messages to avoid re-emitting
 * historical tool results (the full conversation history is sent with every request).
 */
function extractTrailingToolMessages(messages: unknown[]): unknown[] {
  // Walk backward from the end to find the contiguous block of
  // user (with tool_result) and tool messages at the tail.
  const trailing: unknown[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) break;
    const role = (msg as Record<string, unknown>)['role'];
    if (role === 'user' || role === 'tool') {
      trailing.push(msg);
    } else {
      break;
    }
  }
  trailing.reverse();
  return trailing;
}

export function extractToolResults(
  parsed: Record<string, unknown>,
  bus: TokenStreamBus,
  sessionId: import('../session/types.js').SessionId,
): void {
  const messages = parsed['messages'];
  if (!Array.isArray(messages)) return;

  const now = Date.now();

  // Only extract from the LAST user/tool messages to avoid re-emitting
  // historical tool results from earlier turns (the full conversation
  // history is sent with every API request).
  const lastMessages = extractTrailingToolMessages(messages);

  for (const msg of lastMessages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const record = msg as Record<string, unknown>;

    // Anthropic format: role=user, content array with tool_result blocks
    if (record['role'] === 'user') {
      const content = record['content'];
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_result') continue;

        const toolUseId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : '';
        const isError = b['is_error'] === true;
        const rawContent = b['content'];
        let text = '';
        if (typeof rawContent === 'string') {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          // Content can be an array of {type: 'text', text: '...'} blocks
          const parts: string[] = [];
          for (const part of rawContent) {
            if (typeof part === 'object' && part !== null && (part as Record<string, unknown>)['type'] === 'text') {
              const t = (part as Record<string, unknown>)['text'];
              if (typeof t === 'string') parts.push(t);
            }
          }
          text = parts.join('\n');
        }

        text = truncateToolResult(text);

        bus.push(sessionId, {
          kind: 'tool_result',
          toolUseId,
          toolName: '',
          content: text,
          isError,
          timestamp: now,
        });
      }
      continue;
    }

    // OpenAI format: role=tool, content is a string
    if (record['role'] === 'tool') {
      const toolCallId = typeof record['tool_call_id'] === 'string' ? record['tool_call_id'] : '';
      let text = typeof record['content'] === 'string' ? record['content'] : '';
      const isError = false; // OpenAI doesn't have an is_error field

      text = truncateToolResult(text);

      bus.push(sessionId, {
        kind: 'tool_result',
        toolUseId: toolCallId,
        toolName: '',
        content: text,
        isError,
        timestamp: now,
      });
    }
  }
}

/**
 * Extract token stream events from a non-streaming JSON response body.
 * Used when the upstream returns application/json instead of text/event-stream.
 *
 * Emits message_start (model), text_delta (content), and message_end (usage).
 */
export function extractFromJsonResponse(
  body: Buffer,
  bus: TokenStreamBus,
  sessionId: import('../session/types.js').SessionId,
): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return; // Not valid JSON -- nothing to extract
  }

  const now = Date.now();

  // Anthropic format: { model, content: [{type: 'text', text: '...'}], usage: {input_tokens, output_tokens}, stop_reason }
  const model = typeof parsed['model'] === 'string' ? parsed['model'] : null;
  if (model) {
    bus.push(sessionId, { kind: 'message_start', model, timestamp: now });
  }

  // Extract text from content blocks (Anthropic) or choices (OpenAI)
  const content = parsed['content'];
  if (Array.isArray(content)) {
    // Anthropic: content is an array of blocks
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          bus.push(sessionId, { kind: 'text_delta', text: b['text'], timestamp: now });
        }
      }
    }
  }

  const choices = parsed['choices'];
  if (Array.isArray(choices)) {
    // OpenAI: choices[].message.content
    for (const choice of choices) {
      if (typeof choice === 'object' && choice !== null) {
        const c = choice as Record<string, unknown>;
        const message = c['message'];
        if (typeof message === 'object' && message !== null) {
          const m = message as Record<string, unknown>;
          if (typeof m['content'] === 'string') {
            bus.push(sessionId, { kind: 'text_delta', text: m['content'], timestamp: now });
          }
        }
      }
    }
  }

  // Usage and stop reason
  const usage = parsed['usage'];
  const stopReason = typeof parsed['stop_reason'] === 'string' ? parsed['stop_reason'] : 'stop';
  let inputTokens = 0;
  let outputTokens = 0;

  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>;
    // Anthropic: input_tokens/output_tokens; OpenAI: prompt_tokens/completion_tokens
    inputTokens =
      typeof u['input_tokens'] === 'number'
        ? u['input_tokens']
        : typeof u['prompt_tokens'] === 'number'
          ? u['prompt_tokens']
          : 0;
    outputTokens =
      typeof u['output_tokens'] === 'number'
        ? u['output_tokens']
        : typeof u['completion_tokens'] === 'number'
          ? u['completion_tokens']
          : 0;
  }

  bus.push(sessionId, {
    kind: 'message_end',
    stopReason,
    inputTokens,
    outputTokens,
    timestamp: now,
  });
}

export function createMitmProxy(options: MitmProxyOptions): MitmProxy {
  // Validate token stream options: both must be provided together
  const hasBus = options.tokenStreamBus !== undefined;
  const hasSessionId = options.sessionId !== undefined;
  if (hasBus !== hasSessionId) {
    throw new Error('tokenStreamBus and sessionId must be provided together');
  }
  const tokenBus = options.tokenStreamBus;
  const tokenSessionId = options.sessionId;

  // Parse CA cert and key from PEM
  const caCert = forge.pki.certificateFromPem(options.ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(options.ca.keyPem);

  // Build host → provider lookup
  const providersByHost = new Map<string, ProviderKeyMapping>();
  for (const mapping of options.providers) {
    providersByHost.set(mapping.config.host, mapping);
  }

  // Dynamically added passthrough hosts (no key swap, no endpoint filtering)
  const passthroughHosts = new Set<string>();

  // Certificate cache: hostname → { ctx, expiresAt }
  const certCache = new Map<string, { ctx: tls.SecureContext; expiresAt: number }>();

  // Renew leaf certs 1 hour before they expire
  const LEAF_LIFETIME_MS = 24 * 60 * 60 * 1000;
  const RENEWAL_MARGIN_MS = 60 * 60 * 1000;

  /**
   * Returns a cached SecureContext for the hostname, generating one if needed.
   * Automatically renews leaf certificates before they expire.
   * Synchronous because node-forge's RSA key generation is pure JS.
   */
  function getOrCreateSecureContext(hostname: string): tls.SecureContext {
    const cached = certCache.get(hostname);
    if (cached && cached.expiresAt - Date.now() > RENEWAL_MARGIN_MS) return cached.ctx;

    // Generate leaf cert signed by IronCurtain CA
    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    const leafCert = forge.pki.createCertificate();

    leafCert.publicKey = leafKeys.publicKey;
    leafCert.serialNumber = randomSerialNumber();
    leafCert.validity.notBefore = new Date();
    const expiresAt = Date.now() + LEAF_LIFETIME_MS;
    leafCert.validity.notAfter = new Date(expiresAt);

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

    certCache.set(hostname, { ctx, expiresAt });
    return ctx;
  }

  // Build host → registry lookup (including mirror hosts)
  const registriesByHost = new Map<string, RegistryConfig>();
  if (options.registries) {
    for (const reg of options.registries) {
      registriesByHost.set(reg.host, reg);
      if (reg.mirrorHosts) {
        for (const mirror of reg.mirrorHosts) {
          registriesByHost.set(mirror, reg);
        }
      }
    }
  }

  // AllowedVersionCache for tarball backstop
  const allowedVersionCache: AllowedVersionCache = new Map();

  // Connection tracking
  interface ConnectionMeta {
    readonly provider?: ProviderKeyMapping;
    readonly registry?: RegistryConfig;
    readonly passthrough: boolean;
    readonly host: string;
    readonly port: number;
  }
  const activeClientSockets = new Set<Socket>();
  const activeTlsSockets = new Set<tls.TLSSocket>();
  const activeUpstreamRequests = new Set<http.ClientRequest>();
  const activeTunnelPairs = new Set<{ client: Socket; upstream: Socket }>();
  const socketMetadata = new WeakMap<tls.TLSSocket, ConnectionMeta>();

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

  // Lazy-loaded registry handler to avoid circular imports.
  // Cached after first import so subsequent calls are synchronous.
  let registryHandlerModule: typeof import('./registry-proxy.js') | undefined;

  function dispatchRegistryRequest(
    registry: RegistryConfig,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    port: number,
  ): void {
    const doDispatch = (mod: typeof import('./registry-proxy.js')): void => {
      mod
        .handleRegistryRequest(registry, clientReq, clientRes, host, port, {
          validator: options.packageValidation?.validator ?? DENY_ALL_VALIDATOR,
          cache: allowedVersionCache,
          auditLogPath: options.packageValidation?.auditLogPath,
        })
        .catch((err: unknown) => {
          logger.info(`[mitm-proxy] registry request error: ${err instanceof Error ? err.message : String(err)}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
            clientRes.end('Internal proxy error');
          }
        });
    };

    if (registryHandlerModule) {
      doDispatch(registryHandlerModule);
    } else {
      import('./registry-proxy.js')
        .then((mod) => {
          registryHandlerModule = mod;
          doDispatch(mod);
        })
        .catch((err: unknown) => {
          logger.info(
            `[mitm-proxy] failed to load registry-proxy: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (!clientRes.headersSent) {
            clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
            clientRes.end('Internal proxy error');
          }
        });
    }
  }

  innerServer.on('request', (clientReq: http.IncomingMessage, clientRes: http.ServerResponse) => {
    const tlsSock = clientReq.socket as tls.TLSSocket;
    const meta = socketMetadata.get(tlsSock);
    if (!meta) {
      clientRes.writeHead(500);
      clientRes.end('Internal error: unknown connection');
      return;
    }

    const { host: targetHost, port: targetPort } = meta;

    // Dispatch: registry connections are handled separately from provider connections
    if (meta.registry) {
      dispatchRegistryRequest(meta.registry, clientReq, clientRes, targetHost, targetPort);
      return;
    }

    // Passthrough connections: forward as-is, no key swap, no endpoint filtering
    if (meta.passthrough) {
      forwardPassthrough(clientReq, clientRes, targetHost, targetPort);
      return;
    }

    if (!meta.provider) {
      clientRes.writeHead(500);
      clientRes.end('Internal error: no provider or registry for connection');
      return;
    }
    const provider = meta.provider;
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
    const keyResult = validateAndSwapApiKey(modifiedHeaders, provider);

    // Resolve upstream target: use custom gateway if configured, otherwise the original host.
    const upstream = provider.config.upstreamTarget;
    const upstreamHost = upstream?.hostname ?? targetHost;
    const upstreamPort = upstream?.port ?? targetPort;
    const upstreamPathPrefix = upstream?.pathPrefix ?? '';
    const upstreamUseTls = upstream?.useTls ?? true;

    // Set Host header to match the upstream target so the gateway receives
    // the correct virtual-host. Include port only when non-standard.
    const isStandardPort = (upstreamUseTls && upstreamPort === 443) || (!upstreamUseTls && upstreamPort === 80);
    modifiedHeaders.host = isStandardPort ? upstreamHost : `${upstreamHost}:${upstreamPort}`;

    // 3. Forward to real API - either direct pipe or buffer+rewrite.
    // Only enable 401 retry if the request actually carried the fake key —
    // unauthenticated requests should not have credentials injected on retry.
    const needsRewrite = shouldRewriteBody(provider.config, method, path);
    // 401 retry only makes sense when we swapped our own managed credential
    const canRetryAuth = keyResult.swapped && !!provider.tokenManager;
    // Only buffer for retry when the body is small enough (known Content-Length
    // under 1MB). Large or chunked bodies stream through without retry support
    // to avoid memory overhead and 413 rejections on large payloads.
    const contentLength = parseInt(clientReq.headers['content-length'] ?? '', 10);
    const retryBufferOk = canRetryAuth && Number.isFinite(contentLength) && contentLength <= MAX_RETRY_BODY_BYTES;
    const needsBuffer = needsRewrite || retryBufferOk;

    /**
     * Sends the request upstream with optional body override and 401 retry.
     * When a tokenManager is present and the upstream returns 401, it consumes
     * the error response, refreshes the token, and retries once.
     */
    function forwardRequest(bodyOverride?: Buffer, isRetry?: boolean): void {
      const routeInfo = upstream ? ` (via ${upstreamHost}:${upstreamPort})` : '';
      logger.info(`[mitm-proxy] ${method} ${targetHost}${path} → FORWARDED${routeInfo}${isRetry ? ' (retry)' : ''}`);

      const finalHeaders = { ...modifiedHeaders };
      if (bodyOverride) {
        // When we've buffered the body, set the definitive content-length and
        // remove transfer-encoding to avoid sending both (which is an invalid
        // HTTP request and a request-smuggling vector per RFC 7230 §3.3.3).
        finalHeaders['content-length'] = bodyOverride.length.toString();
        delete finalHeaders['transfer-encoding'];
      }

      // Route to custom upstream gateway when configured; path prefix is
      // prepended AFTER endpoint filtering (which runs on the original path).
      const upstreamPath = upstreamPathPrefix ? `${upstreamPathPrefix}${path}` : path;
      const requestFn = upstreamUseTls ? https.request : http.request;
      const upstreamReq = requestFn(
        {
          hostname: upstreamHost,
          port: upstreamPort,
          method,
          path: upstreamPath,
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

          // 401 retry: requires a buffered body (bodyOverride), an authenticated
          // request (canRetryAuth), and not already a retry.
          const { tokenManager } = provider;
          if (upstreamRes.statusCode === 401 && tokenManager && canRetryAuth && bodyOverride && !isRetry) {
            // Consume the 401 response body to free the connection, then retry.
            // Guard against the upstream closing/aborting before 'end' fires —
            // without this the client request would hang indefinitely.
            let handled = false;
            const onDrained = (): void => {
              if (handled) return;
              handled = true;
              retryWithRefreshedToken(tokenManager, provider, modifiedHeaders, bodyOverride, clientRes, forwardRequest);
            };
            const onAborted = (): void => {
              if (handled) return;
              handled = true;
              if (!clientRes.headersSent) {
                clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
                clientRes.end('Upstream connection closed during auth retry.');
              }
            };
            upstreamRes.resume();
            upstreamRes.on('end', onDrained);
            upstreamRes.on('close', onAborted);
            return;
          }

          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          clientRes.flushHeaders();
          clientRes.socket?.setNoDelay(true);

          const contentType = upstreamRes.headers['content-type'] ?? '';
          if (tokenBus && tokenSessionId && contentType.includes('text/event-stream')) {
            const sseProvider = resolveSseProvider(targetHost);
            const extractor = new SseExtractorTransform(sseProvider, (event) => {
              tokenBus.push(tokenSessionId as import('../session/types.js').SessionId, event);
            });
            upstreamRes.pipe(extractor).pipe(clientRes);
          } else if (
            tokenBus &&
            tokenSessionId &&
            isLlmMessagesEndpoint(path as string) &&
            contentType.includes('application/json')
          ) {
            // Non-streaming JSON response: buffer for extraction while piping to client.
            // The passthrough stream always forwards the full response to the client.
            // Capture is bounded at MAX_JSON_RESPONSE_CAPTURE_BYTES: once exceeded,
            // we stop accumulating chunks (and skip extraction at end-of-stream),
            // but the passthrough listener stays attached so the stream completes
            // normally and the client still sees every byte.
            const passthrough = new PassThrough();
            const capture = createBoundedJsonResponseCapture();
            passthrough.on('data', (chunk: Buffer) => capture.onData(chunk));
            passthrough.on('end', () => {
              capture.onEnd((body) => {
                try {
                  extractFromJsonResponse(body, tokenBus, tokenSessionId as import('../session/types.js').SessionId);
                } catch {
                  // Extraction errors must never affect the forwarding path
                }
              });
            });
            upstreamRes.pipe(passthrough);
            passthrough.pipe(clientRes);
          } else {
            upstreamRes.pipe(clientRes);
          }
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

    /**
     * Handles proactive token refresh, body buffering/rewriting, and forwarding.
     * Async to support the token manager's getValidAccessToken() call.
     */
    async function processRequest(): Promise<void> {
      // Proactive token refresh: ensure the real key is fresh before forwarding.
      // Only update headers if the request actually carried the fake key.
      if (provider.tokenManager) {
        try {
          const freshToken = await provider.tokenManager.getValidAccessToken();
          if (freshToken !== provider.realKey) {
            provider.realKey = freshToken;
            if (keyResult.hadKey) {
              injectRealKey(modifiedHeaders, provider);
            }
          }
        } catch (err) {
          logger.warn(
            `[mitm-proxy] Proactive token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Continue with existing token — it may still work
        }
      }

      if (needsBuffer) {
        // Reject requests with content-encoding we cannot parse (e.g. gzip).
        const contentEncoding = clientReq.headers['content-encoding']?.toLowerCase();
        if (needsRewrite && contentEncoding && contentEncoding !== 'identity') {
          logger.info(
            `[mitm-proxy] REJECTED ${method} ${targetHost}${path} - unsupported Content-Encoding: ${contentEncoding}`,
          );
          clientRes.writeHead(415, { 'Content-Type': 'text/plain' });
          clientRes.end(`Unsupported Content-Encoding for this endpoint: ${contentEncoding}`);
          return;
        }

        let rawBody: Buffer;
        try {
          rawBody = await bufferRequestBody(clientReq, MAX_REWRITE_BODY_BYTES);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Request body too large';
          if (!clientRes.headersSent) {
            clientRes.writeHead(413, { 'Content-Type': 'text/plain' });
            clientRes.end(message);
          }
          return;
        }

        let finalBody = rawBody;

        // Extract tool_result events from the request body for token stream observation.
        // Done before rewriting so we see the original messages array.
        if (tokenBus && tokenSessionId && isLlmMessagesEndpoint(path as string)) {
          try {
            const bodyParsed = JSON.parse(rawBody.toString()) as Record<string, unknown>;
            extractToolResults(bodyParsed, tokenBus, tokenSessionId as import('../session/types.js').SessionId);
          } catch {
            // Parse failure is fine -- the rewriter below will also attempt to parse
          }
        }

        if (needsRewrite) {
          const rewriter = provider.config.requestRewriter as RequestBodyRewriter;
          const reqMethod = method as string;
          const reqPath = path as string;
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
        }

        forwardRequest(finalBody);
      } else {
        forwardRequest();
      }
    }

    processRequest().catch((err: unknown) => {
      logger.info(`[mitm-proxy] request processing error: ${err instanceof Error ? err.message : String(err)}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
        clientRes.end('Internal proxy error');
      }
    });
  });

  // ── Plain HTTP proxy forwarding ──────────────────────────────────
  // When a client uses HTTP_PROXY for plain HTTP requests, it sends
  // e.g. "GET http://host:port/path" — an absolute URL as the request target.
  // Parse the absolute URL and return host/port/path, or null if not a proxy request.

  function tryParseProxyUrl(url: string): { hostname: string; port: number; path: string } | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:') return null;
      return {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : 80,
        path: parsed.pathname + parsed.search,
      };
    } catch {
      return null;
    }
  }

  function forwardPlainHttpPassthrough(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    port: number,
    path: string,
  ): void {
    const { method, headers } = clientReq;

    logger.info(`[mitm-proxy] ${method} http://${host}:${port}${path} -> PASSTHROUGH (plain HTTP)`);

    // Strip proxy-only and hop-by-hop headers so they are not leaked upstream
    const hopByHop = new Set([
      'connection',
      'proxy-authorization',
      'proxy-connection',
      'keep-alive',
      'upgrade',
      'transfer-encoding',
      'te',
      'trailer',
    ]);
    // Also strip any headers named in the Connection header
    const connectionHeader = headers['connection'];
    if (typeof connectionHeader === 'string') {
      for (const token of connectionHeader.split(',')) {
        const name = token.trim().toLowerCase();
        if (name) hopByHop.add(name);
      }
    }
    const forwardHeaders: Record<string, string | string[] | undefined> = {
      host: port === 80 ? host : `${host}:${port}`,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (!hopByHop.has(key)) {
        forwardHeaders[key] = value;
      }
    }

    const reqOpts: http.RequestOptions = {
      hostname: host,
      port,
      method,
      path,
      headers: forwardHeaders,
    };
    if (options.dnsLookup) {
      reqOpts.lookup = options.dnsLookup;
    }

    const upstreamReq = http.request(reqOpts, (upstreamRes) => {
      upstreamRes.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] upstream response error (plain HTTP passthrough): ${err.message}`);
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
    });

    activeUpstreamRequests.add(upstreamReq);
    upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));

    upstreamReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] upstream error (plain HTTP passthrough): ${err.message}`);
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

    clientReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] client request error (plain HTTP passthrough): ${err.message}`);
      upstreamReq.destroy();
    });

    clientReq.pipe(upstreamReq);
  }

  // Outer server - UDS listener, handles CONNECT and plain HTTP proxy requests
  const outerServer = http.createServer((req, res) => {
    // Handle plain HTTP proxy requests for passthrough and Debian registry domains.
    // HTTP proxy clients send absolute URLs: "GET http://host:port/path".
    // Only Debian registries are included here because apt uses plain HTTP
    // by default. npm/PyPI use HTTPS CONNECT and go through the registry-proxy
    // validation path instead.
    const parsed = req.url ? tryParseProxyUrl(req.url) : null;
    const isDebianRegistry = parsed ? registriesByHost.get(parsed.hostname)?.type === 'debian' : false;
    if (parsed && (passthroughHosts.has(parsed.hostname) || isDebianRegistry)) {
      forwardPlainHttpPassthrough(req, res, parsed.hostname, parsed.port, parsed.path);
      return;
    }
    if (parsed) {
      // Valid proxy request but domain not in allowlist
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    // Not a proxy request (relative URL) — reject
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

    // 1. Check allowlist (providers, registries, and dynamic passthrough)
    const provider = providersByHost.get(host);
    const registry = registriesByHost.get(host);
    const isPassthrough = !provider && !registry && passthroughHosts.has(host);
    if (!provider && !registry && !isPassthrough) {
      logger.info(`[mitm-proxy] #${connId} DENIED CONNECT ${host}:${port}`);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const connType = provider ? 'provider' : registry ? 'registry' : 'passthrough';

    // 2. For passthrough domains, create a raw TCP tunnel (no MITM).
    //    The proxy just pipes bytes bidirectionally — this supports both
    //    plain HTTP and WebSocket connections through CONNECT.
    if (isPassthrough) {
      logger.info(`[mitm-proxy] #${connId} CONNECT ${host}:${port} → TUNNEL (${connType})`);

      // Acknowledge immediately per standard proxy behavior — the client
      // will discover upstream failures itself once it tries to send data.
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      const connectOpts: net.NetConnectOpts = { host, port };
      if (options.dnsLookup) {
        connectOpts.lookup = options.dnsLookup;
      }

      const upstreamSocket = net.connect(connectOpts, () => {
        // Write any buffered data from the CONNECT request
        if (head.length > 0) {
          upstreamSocket.write(head);
        }

        // Bidirectional pipe
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      });

      // Track for cleanup
      const pair = { client: clientSocket, upstream: upstreamSocket };
      activeTunnelPairs.add(pair);

      const cleanup = (): void => {
        activeTunnelPairs.delete(pair);
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      };

      clientSocket.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] #${connId} CONNECT tunnel client error: ${err.message}`);
        cleanup();
      });
      clientSocket.on('close', cleanup);
      upstreamSocket.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] #${connId} CONNECT tunnel upstream error: ${err.message}`);
        cleanup();
      });
      upstreamSocket.on('close', cleanup);

      return;
    }

    // 3. For provider/registry connections, MITM with TLS termination.
    logger.info(`[mitm-proxy] #${connId} CONNECT ${host}:${port} → MITM (${connType})`);

    // Acknowledge the CONNECT
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Push back any bytes that arrived after the CONNECT request line
    if (head.length > 0) {
      clientSocket.unshift(head);
    }

    // Upgrade to TLS (MITM)
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      SNICallback: (servername, cb) => {
        const ctx = getOrCreateSecureContext(servername);
        cb(null, ctx);
      },
    });

    // TLS handshake timeout - if the handshake completes, the 'secure'
    // event clears this timer. If it fires, the handshake never completed.
    const handshakeTimeout = setTimeout(() => {
      logger.info(`[mitm-proxy] #${connId} TLS handshake timeout`);
      tlsSocket.destroy();
    }, 10_000);
    tlsSocket.once('secure', () => clearTimeout(handshakeTimeout));

    // Track the connection
    activeTlsSockets.add(tlsSocket);
    socketMetadata.set(tlsSocket, {
      provider: provider ?? undefined,
      registry,
      passthrough: false,
      host,
      port,
    });

    tlsSocket.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] #${connId} TLS error: ${err.message}`);
      tlsSocket.destroy();
    });
    tlsSocket.on('close', () => {
      clearTimeout(handshakeTimeout);
      activeTlsSockets.delete(tlsSocket);
    });

    // Emit into shared inner HTTP server
    innerServer.emit('connection', tlsSocket);
  });

  // ── Plain HTTP WebSocket upgrade ──────────────────────────────────
  // When a client sends "GET http://host/path" with Upgrade: websocket
  // through the proxy, the outer server emits an 'upgrade' event instead
  // of routing through the normal 'request' handler.
  outerServer.on('upgrade', (req: http.IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const parsed = req.url ? tryParseProxyUrl(req.url) : null;
    if (!parsed || !passthroughHosts.has(parsed.hostname)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    clientSocket.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] WebSocket client socket error: ${err.message}`);
    });

    logger.info(`[mitm-proxy] WebSocket upgrade ws://${parsed.hostname}:${parsed.port}${parsed.path} → PASSTHROUGH`);
    bridgeWebSocketUpgrade(clientSocket, head, parsed.hostname, parsed.port, parsed.path, req.headers);
  });

  // ── Passthrough request forwarding ──────────────────────────────────
  // For dynamically added domains: forward requests as-is with no
  // credential replacement or endpoint filtering.

  function forwardPassthrough(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    port: number,
  ): void {
    const { method, url: path, headers } = clientReq;

    // Default to HTTPS; use HTTP only for well-known cleartext ports
    const useHttps = port !== 80 && port !== 8080;
    const proto = useHttps ? 'https' : 'http';
    logger.info(`[mitm-proxy] ${method} ${proto}://${host}:${port}${path} -> PASSTHROUGH`);

    const forwardHeaders = { ...headers, host };

    const requestFn = useHttps ? https.request : http.request;
    const reqOpts: http.RequestOptions = {
      hostname: host,
      port,
      method,
      path,
      headers: forwardHeaders,
    };
    if (options.dnsLookup) {
      reqOpts.lookup = options.dnsLookup;
    }
    const upstreamReq = requestFn(reqOpts, (upstreamRes) => {
      upstreamRes.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] upstream response error (passthrough): ${err.message}`);
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
    });

    activeUpstreamRequests.add(upstreamReq);
    upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));

    upstreamReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] upstream error (passthrough): ${err.message}`);
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

    clientReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] client request error (passthrough): ${err.message}`);
      upstreamReq.destroy();
    });

    clientReq.pipe(upstreamReq);
  }

  /** Format an HTTP response line + headers for writing to a raw socket. */
  function formatRawHttpResponse(res: http.IncomingMessage): string {
    const statusLine = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`;
    const headerLines = Object.entries(res.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    return `${statusLine}\r\n${headerLines}\r\n\r\n`;
  }

  // ── WebSocket upgrade bridging ───────────────────────────────────

  /**
   * Bridges a WebSocket upgrade from the client socket to an upstream server.
   * Preserves WebSocket-specific headers and pipes both sockets bidirectionally.
   */
  function bridgeWebSocketUpgrade(
    clientSocket: Socket,
    head: Buffer,
    targetHost: string,
    targetPort: number,
    path: string,
    requestHeaders: http.IncomingHttpHeaders,
  ): void {
    // Build headers: preserve WebSocket headers, strip other hop-by-hop
    const forwardHeaders: Record<string, string | string[] | undefined> = {
      host: targetPort === 80 ? targetHost : `${targetHost}:${targetPort}`,
    };
    for (const [key, value] of Object.entries(requestHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'host') continue;

      // Strip hop-by-hop and proxy-only headers (but preserve
      // Connection/Upgrade and Sec-WebSocket-* for the handshake)
      if (
        lower === 'proxy-authorization' ||
        lower === 'proxy-authenticate' ||
        lower === 'proxy-connection' ||
        lower === 'keep-alive' ||
        lower === 'transfer-encoding' ||
        lower === 'te' ||
        lower === 'trailer'
      ) {
        continue;
      }

      forwardHeaders[key] = value;
    }

    const requestFn = http.request;
    const reqOpts: http.RequestOptions = {
      hostname: targetHost,
      port: targetPort,
      method: 'GET',
      path,
      headers: forwardHeaders,
      timeout: 30_000,
    };
    if (options.dnsLookup) {
      reqOpts.lookup = options.dnsLookup;
    }

    const upstreamReq = requestFn(reqOpts);
    activeUpstreamRequests.add(upstreamReq);

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      activeUpstreamRequests.delete(upstreamReq);
      clientSocket.write(formatRawHttpResponse(upstreamRes));

      // Track the pair for cleanup
      const pair = { client: clientSocket, upstream: upstreamSocket };
      activeTunnelPairs.add(pair);

      const cleanup = (): void => {
        activeTunnelPairs.delete(pair);
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      };

      clientSocket.on('error', cleanup);
      clientSocket.on('close', cleanup);
      upstreamSocket.on('error', cleanup);
      upstreamSocket.on('close', cleanup);

      // Write any buffered data from the upgrade
      if (upstreamHead.length > 0) {
        clientSocket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }

      // Bidirectional pipe
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    upstreamReq.on('response', (res) => {
      activeUpstreamRequests.delete(upstreamReq);
      clientSocket.write(formatRawHttpResponse(res));
      res.pipe(clientSocket);
      clientSocket.on('close', () => upstreamReq.destroy());
    });

    upstreamReq.on('error', (err) => {
      activeUpstreamRequests.delete(upstreamReq);
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] WebSocket upgrade upstream error: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });

    upstreamReq.on('timeout', () => {
      logger.info(`[mitm-proxy] WebSocket upgrade timeout for ${targetHost}:${targetPort}${path}`);
      upstreamReq.destroy();
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      }
    });

    upstreamReq.end();
  }

  // ── DynamicHostController ─────────────────────────────────────────

  const hostController: DynamicHostController = {
    addHost(domain: string): boolean {
      validateDomain(domain);
      if (providersByHost.has(domain)) return false;
      if (passthroughHosts.has(domain)) return false;
      passthroughHosts.add(domain);
      // Pre-warm cert cache for the new domain
      getOrCreateSecureContext(domain);
      return true;
    },

    removeHost(domain: string): boolean {
      return passthroughHosts.delete(domain);
    },

    listHosts(): DomainListing {
      return {
        providers: [...providersByHost.keys()],
        dynamic: [...passthroughHosts],
      };
    },
  };

  // ── HTTP Control API server ───────────────────────────────────────
  // Runs on a separate socket, NOT mounted into the container.

  const controlServer = http.createServer((req, res) => {
    const url = req.url ?? '';

    if (url === '/__ironcurtain/domains' && req.method === 'GET') {
      const listing = hostController.listHosts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listing));
      return;
    }

    if (url === '/__ironcurtain/domains/add' && req.method === 'POST') {
      bufferRequestBody(req, 4096)
        .then((body) => {
          const { domain } = JSON.parse(body.toString()) as { domain: string };
          if (typeof domain !== 'string' || !domain) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: domain' }));
            return;
          }
          try {
            const added = hostController.addHost(domain);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ added }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        })
        .catch((err: unknown) => {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    if (url === '/__ironcurtain/domains/remove' && req.method === 'POST') {
      bufferRequestBody(req, 4096)
        .then((body) => {
          const { domain } = JSON.parse(body.toString()) as { domain: string };
          if (typeof domain !== 'string' || !domain) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: domain' }));
            return;
          }
          const removed = hostController.removeHost(domain);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ removed }));
        })
        .catch((err: unknown) => {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  const useTcp = options.listenPort !== undefined;
  if (!useTcp && !options.socketPath) {
    throw new Error('MitmProxyOptions: either socketPath or listenPort must be provided');
  }

  /** Starts the control API server and returns its address info. */
  async function startControlServer(): Promise<{ controlSocketPath?: string; controlPort?: number }> {
    if (useTcp && options.controlPort !== undefined) {
      return new Promise((resolve, reject) => {
        const onError = reject;
        controlServer.listen(options.controlPort, '127.0.0.1', () => {
          controlServer.removeListener('error', onError);
          const addr = controlServer.address();
          const port = addr && typeof addr === 'object' ? addr.port : (options.controlPort ?? 0);
          resolve({ controlPort: port });
        });
        controlServer.once('error', onError);
      });
    }

    if (options.controlSocketPath) {
      if (existsSync(options.controlSocketPath)) {
        unlinkSync(options.controlSocketPath);
      }
      return new Promise((resolve, reject) => {
        const onError = reject;
        controlServer.listen(options.controlSocketPath, () => {
          controlServer.removeListener('error', onError);
          resolve({ controlSocketPath: options.controlSocketPath });
        });
        controlServer.once('error', onError);
      });
    }

    // No control socket configured -- return empty
    return {};
  }

  return {
    hosts: hostController,

    async start() {
      // Pre-warm cert cache for all configured providers and registries
      for (const mapping of options.providers) {
        getOrCreateSecureContext(mapping.config.host);
      }
      for (const host of registriesByHost.keys()) {
        getOrCreateSecureContext(host);
      }

      const controlResult = await startControlServer();

      if (useTcp) {
        // TCP mode: listen on host:port
        return new Promise((resolve, reject) => {
          const onError = reject;
          outerServer.listen(options.listenPort, '0.0.0.0', () => {
            outerServer.removeListener('error', onError);
            const addr = outerServer.address();
            const port = addr && typeof addr === 'object' ? addr.port : (options.listenPort ?? 0);
            resolve({ port, ...controlResult });
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
          resolve({ socketPath, ...controlResult });
        });
        outerServer.once('error', onError);
      });
    },

    async stop() {
      // 1. Destroy active tunnel pairs (CONNECT passthrough + WebSocket bridges)
      for (const pair of activeTunnelPairs) {
        if (!pair.client.destroyed) pair.client.destroy();
        if (!pair.upstream.destroyed) pair.upstream.destroy();
      }
      activeTunnelPairs.clear();

      // 2. Abort all in-flight upstream requests
      for (const req of activeUpstreamRequests) {
        req.destroy();
      }
      activeUpstreamRequests.clear();

      // 3. Destroy all active TLS sockets and raw client sockets.
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

      // 4. Close outer server - stop accepting new connections.
      // closeAllConnections() handles any non-upgraded HTTP connections.
      outerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        outerServer.close(() => resolve());
      });

      // 5. Close the inner HTTP server.
      innerServer.closeAllConnections();
      innerServer.close();

      // 6. Close the control API server.
      controlServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        controlServer.close(() => resolve());
      });

      // 7. Clean up socket files (UDS mode only)
      if (!useTcp && options.socketPath) {
        try {
          if (existsSync(options.socketPath)) {
            unlinkSync(options.socketPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      if (options.controlSocketPath) {
        try {
          if (existsSync(options.controlSocketPath)) {
            unlinkSync(options.controlSocketPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}

/**
 * Injects the real key into already-validated headers.
 * Used after a token refresh to update the Authorization/API-key header
 * with the new real key before a retry.
 */
function injectRealKey(headers: Record<string, string | string[] | undefined>, provider: ProviderKeyMapping): void {
  const { keyInjection } = provider.config;
  switch (keyInjection.type) {
    case 'header':
      headers[keyInjection.headerName.toLowerCase()] = provider.realKey;
      break;
    case 'bearer':
      headers['authorization'] = `Bearer ${provider.realKey}`;
      break;
  }
}

/**
 * Attempts to refresh the OAuth token and retry the request.
 * Called when upstream returns 401 and a token manager is available.
 */
function retryWithRefreshedToken(
  tokenManager: OAuthTokenManager,
  provider: ProviderKeyMapping,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  clientRes: http.ServerResponse,
  forwardRequest: (bodyOverride?: Buffer, isRetry?: boolean) => void,
): void {
  tokenManager
    .handleAuthFailure()
    .then((newToken) => {
      if (newToken) {
        provider.realKey = newToken;
        injectRealKey(headers, provider);
        forwardRequest(body, true);
      } else if (!clientRes.headersSent) {
        clientRes.writeHead(401, { 'Content-Type': 'text/plain' });
        clientRes.end('Authentication failed: unable to refresh OAuth token.');
      }
    })
    .catch(() => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(401, { 'Content-Type': 'text/plain' });
        clientRes.end('Authentication failed: token refresh error.');
      }
    });
}

/** Result of fake key validation. */
type KeyValidationResult =
  | { hadKey: true; swapped: true } // fake key matched -> swapped to real key
  | { hadKey: true; swapped: false } // key present but not sentinel -> pass through
  | { hadKey: false; swapped: false }; // no key sent (unauthenticated endpoint)

/**
 * Validates the request's API key header. If the sentinel fake key is
 * present, swaps it for the real key. Non-sentinel keys (the agent's
 * own credentials) are passed through unchanged.
 */
function validateAndSwapApiKey(
  headers: Record<string, string | string[] | undefined>,
  provider: ProviderKeyMapping,
): KeyValidationResult {
  const { keyInjection } = provider.config;

  switch (keyInjection.type) {
    case 'header': {
      const headerName = keyInjection.headerName.toLowerCase();
      const currentValue = headers[headerName];
      if (currentValue === undefined) return { hadKey: false, swapped: false };
      if (currentValue === provider.fakeKey) {
        headers[headerName] = provider.realKey;
        return { hadKey: true, swapped: true };
      }
      // Non-sentinel key present -- agent's own credential, pass through
      return { hadKey: true, swapped: false };
    }
    case 'bearer': {
      const authHeader = headers['authorization'];
      if (authHeader === undefined) return { hadKey: false, swapped: false };
      if (authHeader === `Bearer ${provider.fakeKey}`) {
        headers['authorization'] = `Bearer ${provider.realKey}`;
        return { hadKey: true, swapped: true };
      }
      // Non-sentinel bearer token -- agent's own credential, pass through
      return { hadKey: true, swapped: false };
    }
  }
}
