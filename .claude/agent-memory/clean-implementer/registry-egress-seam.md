# Anonymous workload-registry egress path (Phase 0F, promoted from Phase 3)

Governing design: `docs/designs/secure-nested-runtime-implementation-plan.md` §6.4 (full spec),
§7.1, §16.5 (promotion), **§16.6 (2026-07-21 content-integrity correction — the current controlling
amendment; overrides earlier digest/buffer framing)**. Feature stays INERT behind
`assertDockerWorkloadImplementationAvailable` (`src/docker-workload/config.ts`) until 0C. Sibling of
the build-egress seam — same layering discipline (see [[build-egress-seam]]).

## §16.6 CORRECTION (what changed vs the original build) — read this first
Host-side blob hashing + verify-before-release buffering are NOT security controls for workload
images: the bundle can already synthesize arbitrary bytes and a registry can serve a malicious
manifest with matching blobs. So blob content is untrusted and flows through UNVERIFIED.
- REMOVED: `RegistryContentHasher`/`createRegistryContentHasher`, `DigestVerification`/
  `verifyContentDigest`, the `verifyAndDeliver` Buffer[]-accumulate + `Buffer.concat` + digest-mismatch
  502, `resolvesDigest`, `allowDynamicRedirectHosts`, per-origin `redirects{maxHops,followDynamicHosts}`
  + `limits{requestBytes,requestTimeoutMs}`, manifest-level `imageLimits{totalBytes,totalTimeoutMs}`.
- `expectedDigest` RENAMED → `requestedDigest` (audit provenance only, from by-digest URL; gates NOTHING).
- KEPT (§16.6 keepers): digest SYNTAX parsing (`parseOciDigest`, sha256-only) for URL classification +
  audit; URL/repo/path/method/operation classification; `Set-Cookie` response strip
  (`HOP_BY_HOP_RESPONSE_HEADERS`); destination-bound transport; bounded redirects; strict
  `public-registry` opt-in.

## The binding controls now (replace digest verification)
1. Client-origin URL/operation gating (unchanged: unlisted host / push / delete / catalog / tags fail closed).
2. Exact derived-redirect authorization — an unlisted CDN URL is reachable ONLY as the immediate exact
   `Location` of an authorized manifest/blob response. Now follows for ANY content pull (TAG or digest —
   no longer digest-gated). Derived request: GET/HEAD preserved, HTTPS-only, headers `{}` (all creds
   stripped), finite `maxRedirectHops`. Literal-IP redirect targets REFUSED in policy (`isIP` after
   stripping IPv6 brackets `[]`); DNS-resolves-to-private is caught by the transport (OutboundTransport
   guarded DNS lookup / `assertHostnameIsEligible`) — that transport IS the binding SSRF control.
   As of the F3 fix that is CHECKED, not assumed: both transports resolve locally and declare
   `addressGuard:'local-resolver'`, and `handleRegistryEgressRequest`'s `assertReady`
   (`assertLocalAddressAuthority`) 502s a `'delegated'` transport before upstream contact.
   See [[outbound-transport-address-authority]].
3. Anonymous bearer-token flow — `sanitizeHeaders` ADMITS a single `Authorization: Bearer <token>` on a
   client-initiated request to a listed origin (bearer is STRUCTURAL, never in an origin allow-list;
   `FORBIDDEN_CREDENTIAL_HEADERS` still lists `authorization` so the allow-list schema rejects it).
   Rejects Basic/other schemes, Cookie, Proxy-Authorization everywhere; redirects always strip.
4. Streaming ceilings (see below).

## Layering (pure policy vs I/O seam) — both live in src/docker/ (NOT docker-workload)
- `src/docker/registry-egress-policy.ts` — PURE (node crypto/fs/net-isIP/path + zod + hop-by-hop leaf;
  `isIP` is pure, no sockets). `loadRegistryEgressManifest`, branded `validateRegistryEgressManifest`,
  `authorizeValidatedRegistryEgressRequest` (hot path), `authorizeValidatedRegistryRedirect`
  (content-op gate via `CONTENT_OPERATIONS`, https-only, literal-IP reject, matched-origin re-auth OR
  CDN, headers `{}`). New schema: origin `perRequest{maxBytes,maxDurationMs,maxRedirectHops}` +
  manifest `perSession{maxTotalBytes,maxConcurrentRequests}`. `AuthorizedRegistryEgressRequest` carries
  `maxBytes/maxDurationMs/maxRedirectHops/redirectHop/requestedDigest?`.
- `src/docker/registry-egress-proxy.ts` — I/O seam. Owns sockets/streams + the per-session LEDGER.
  `createRegistryEgressSessionLedger(perSession)` → `acquire()`(throws at concurrency ceiling)/
  `wouldFit`/`addBytes`; guard exposes it as `guard.session` (one guard == one session/bundle, shared in
  workflow shared-container). `handleRegistryEgressRequest`: authorize (403) → acquire lease (503 on
  concurrency) → arm absolute-deadline `setTimeout(maxDurationMs).unref()` (504) → `clientRes.once('close')`
  = idempotent `finalizeExchange` (clearTimeout + lease.release). Body via `stream.pipeline(upstreamRes,
  ByteCeilingTransform, clientRes)` — genuine backpressure, no buffer. `ByteCeilingTransform` fails the
  pipeline (destroys both sides) on per-request `maxBytes` OR per-session `ledger.addBytes` overflow.
  `content-length` pre-check gives a clean 502 before streaming (per-request + `!wouldFit` per-session).
  `recordProvenance` on successful content-pull completion: `requestedDigest` (URL) + `resolvedDigest`
  (registry `Docker-Content-Digest` header, validated syntax, may be absent) + streamed `sizeBytes`.
  `onUpstreamResponse` guards `settled/writableEnded/destroyed` (drain+return) so a late upstream
  response after a deadline/abort can't writeHead-after-end.

## Shared forward lifecycle: `src/docker/mediated-egress.ts` (registry+build unified)
The streaming/redirect/ceiling/deadline/lease machinery was EXTRACTED from `registry-egress-proxy.ts`
into leaf `forwardMediatedEgress<A>(clientRes, config)` (armDeadline/finalizeExchange/fetch/onResponse/
followRedirect/streamToClient/ByteCeilingTransform + `MAX_REDIRECT_BODY_BYTES`/`declaredContentLength`
all live there now). Registry proxy KEEPS: guard/ledger/manifest, `RegistryPullProvenance`,
`recordProvenance`, `reportedDigest`. `handleRegistryEgressRequest` authorizes then calls
`forwardMediatedEgress` with `session: guard.session`, `followRedirect: guard.authorizeRedirect`,
`onComplete`. F1 (redirect-body ceiling), F5 (stale-upstream guard), all status codes (403/502/503/504),
and the exact provenance record are preserved (green tests). DEVIATION from the literal spec: `onComplete`
signature is `(authorized, streamedBytes, responseHeaders)` — the 3rd param (terminal response headers) is
REQUIRED because `resolvedDigest` reads `Docker-Content-Digest` off the terminal response, which the
2-arg form couldn't reach. Efficiency #3: the ByteCeilingTransform exposes `byteCount()` (no second
`on('data')` counter). `firstHeader` now in `egress-forwarding.ts`. See [[build-egress-seam]].

## MITM wiring (WHOLE-PROXY mode; comment-only updates this pass)
`MitmProxyOptions.registryEgress?:{guard}`, mutually exclusive with `buildEgress`. Context shape
UNCHANGED (guard/transport/scheme/targetHost/targetPort/requestTarget). Only doc-comment + inline
comment updated to drop the digest-verification claim. `preloaded-only` → no guard → no route.

## Draft manifest & freeze
`config/docker-workload/registry-egress-manifest.json` — DRAFT (`status:"draft"`, policyId
`...-draft-v1`). Origins: registry-1.docker.io + auth.docker.io(token) + ghcr.io(combined), each with
`perRequest`; manifest `perSession{maxTotalBytes,maxConcurrentRequests}`. 0C must freeze reviewed
origins + real ceilings + hermetic fixtures + §6.4 negatives.

## Testing pattern (hermetic, NO live registry)
- policy test: temp-file manifests (0400/0666/symlink negatives); `manifest()` typed fixture.
- proxy test: real loopback front `http.createServer` → `handleRegistryEgressRequest`; KEY SEAM =
  `routingTransport(Map hostname→loopbackPort)` custom OutboundTransport (registry schema FORCES https,
  so route by hostname to a plain-http loopback). `spyTransport` proves rejects never touch upstream.
  Streaming proof = gated upstream writes chunk1, blocks on a gate the client's `onData` resolves, then
  writes chunk2 (a buffering proxy would deadlock/timeout). Time ceiling = upstream `setTimeout(400)` vs
  `maxDurationMs:120` → 504. Concurrency = `maxConcurrentRequests:1`, first pull gated open (await
  `firstRequest`), second → 503. Byte ceilings = content-length pre-check → clean 502; chunked
  mid-stream overflow → aborted/truncated (tolerant assert). `driveThroughSeam` returns
  `{statusCode,headers,body,aborted}`; async upstream handlers must be sync + `void gate.then(...)`
  (eslint no-misused-promises).
