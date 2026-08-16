/** Generic completion routing descriptors shared by proxy observers. */

export type BuiltInLlmProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'google-generate-content';

export type LlmProtocolId = BuiltInLlmProtocol | (string & {});
export type CompletionMetricsSupport = 'full' | 'partial' | 'unsupported';
export type StreamingUsageNegotiation = 'client_or_agent_adapter' | 'rewrite_if_already_buffered' | 'none';

export interface CompletionEndpointCapabilities {
  readonly metricsSupport: CompletionMetricsSupport;
  readonly streamingUsageNegotiation?: StreamingUsageNegotiation;
  /** Independent content-capture gate; never inferred from metrics support. */
  readonly trajectoryCapture?: boolean;
}

export interface EndpointPatternLike {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Exact path or a path with `*` matching one non-empty segment. */
  readonly path: string;
}

export interface CompletionEndpoint extends EndpointPatternLike {
  readonly protocol: LlmProtocolId;
  readonly capabilities: CompletionEndpointCapabilities;
}

export type EndpointAuthorizationPattern = EndpointPatternLike;

export class AmbiguousCompletionEndpointError extends Error {
  constructor(method: string, path: string) {
    super(`multiple completion endpoints match ${method.toUpperCase()} ${path}`);
    this.name = 'AmbiguousCompletionEndpointError';
  }
}

function cleanRequestPath(path: string): string {
  return path.split('?', 1)[0] ?? path;
}

export function matchesEndpointPattern(
  endpoint: EndpointPatternLike,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!method || !path || endpoint.method !== method.toUpperCase()) return false;
  const cleanPath = cleanRequestPath(path);
  if (!endpoint.path.includes('*')) return endpoint.path === cleanPath;
  const expression = endpoint.path
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${expression}$`).test(cleanPath);
}

function patternMatchesPath(pattern: string, path: string): boolean {
  if (!pattern.includes('*')) return pattern === path;
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${expression}$`).test(path);
}

function segmentPatternsMayOverlap(left: string, right: string): boolean {
  const leftGlob = left.includes('*');
  const rightGlob = right.includes('*');
  if (!leftGlob && !rightGlob) return left === right;
  if (!leftGlob) return patternMatchesPath(right, left);
  if (!rightGlob) return patternMatchesPath(left, right);
  // Every built-in descriptor has at most one wildcard per segment. Two such
  // patterns can overlap only when both their fixed prefixes and suffixes are
  // compatible. Keep a conservative fallback for custom multi-wildcard
  // descriptors rather than pretending to prove their intersection empty.
  if (left.indexOf('*') !== left.lastIndexOf('*') || right.indexOf('*') !== right.lastIndexOf('*')) return true;
  const [leftPrefix = '', leftSuffix = ''] = left.split('*');
  const [rightPrefix = '', rightSuffix = ''] = right.split('*');
  if (!leftPrefix.startsWith(rightPrefix) && !rightPrefix.startsWith(leftPrefix)) return false;
  if (!leftSuffix.endsWith(rightSuffix) && !rightSuffix.endsWith(leftSuffix)) return false;
  return true;
}

function endpointPatternsMayOverlap(left: CompletionEndpoint, right: CompletionEndpoint): boolean {
  if (left.method !== right.method) return false;
  const leftSegments = left.path.split('/');
  const rightSegments = right.path.split('/');
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((segment, index) => segmentPatternsMayOverlap(segment, rightSegments[index] ?? ''));
}

function authorizationCoversEndpoint(allowed: EndpointAuthorizationPattern, endpoint: CompletionEndpoint): boolean {
  if (allowed.method !== endpoint.method) return false;
  if (allowed.path === endpoint.path) return true;
  // An exact completion path can safely sit beneath a broader authorization
  // glob. Two different globs are not accepted without a formal subset proof.
  return !endpoint.path.includes('*') && patternMatchesPath(allowed.path, endpoint.path);
}

/**
 * Validate startup configuration before any request can reach the resolver.
 * Completion descriptors are observability metadata, never network authority.
 */
export function validateCompletionEndpoints(
  endpoints: readonly CompletionEndpoint[],
  allowedEndpoints: readonly EndpointAuthorizationPattern[],
): void {
  for (const endpoint of endpoints) {
    defineCompletionEndpoint(endpoint);
    if (!allowedEndpoints.some((allowed) => authorizationCoversEndpoint(allowed, endpoint))) {
      throw new Error(
        `completion endpoint is not a proven subset of authorization: ${endpoint.method} ${endpoint.path}`,
      );
    }
  }
  for (let left = 0; left < endpoints.length; left++) {
    for (let right = left + 1; right < endpoints.length; right++) {
      const leftEndpoint = endpoints[left];
      const rightEndpoint = endpoints[right];
      if (endpointPatternsMayOverlap(leftEndpoint, rightEndpoint)) {
        throw new Error(
          `overlapping completion endpoints: ${leftEndpoint.method} ${leftEndpoint.path} and ${rightEndpoint.path}`,
        );
      }
    }
  }
}

/**
 * Resolve exactly one descriptor. Ambiguity is a configuration error rather
 * than a precedence rule that could silently select the wrong wire protocol.
 */
export function resolveCompletionEndpoint(
  endpoints: readonly CompletionEndpoint[],
  method: string | undefined,
  path: string | undefined,
): CompletionEndpoint | undefined {
  const matches = endpoints.filter((endpoint) => matchesEndpointPattern(endpoint, method, path));
  if (matches.length > 1) throw new AmbiguousCompletionEndpointError(method ?? '', cleanRequestPath(path ?? ''));
  return matches[0];
}

/** Clone and freeze a descriptor before it is shared across exchanges. */
export function defineCompletionEndpoint(endpoint: CompletionEndpoint): CompletionEndpoint {
  if (!endpoint.path.startsWith('/') || endpoint.path.includes('?')) {
    throw new Error('completion endpoint paths must be absolute and must not contain a query string');
  }
  if (endpoint.protocol.length === 0) throw new Error('completion endpoint protocol must not be empty');
  return Object.freeze({
    method: endpoint.method,
    path: endpoint.path,
    protocol: endpoint.protocol,
    capabilities: Object.freeze({ ...endpoint.capabilities }),
  });
}

/** True when at least one declared endpoint can emit any truthful metrics. */
export function hasMetricsCapableCompletionEndpoint(endpoints: readonly CompletionEndpoint[] | undefined): boolean {
  return endpoints?.some((endpoint) => endpoint.capabilities.metricsSupport !== 'unsupported') ?? false;
}
