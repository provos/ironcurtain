# Anonymous workload-registry egress path (Phase 0F, promoted from Phase 3)

Governing design: `docs/designs/secure-nested-runtime-implementation-plan.md` §6.4 (full spec),
§7.1, §16.5 (2026-07-21 user-approved promotion; "Code follow-ups"). Feature stays INERT behind
`assertDockerWorkloadImplementationAvailable` (`src/docker-workload/config.ts`) until 0C. Sibling of
the build-egress seam — same layering discipline (see [[build-egress-seam]]).

## Opt-in plumbing
`imageIngress` widened from `z.literal('preloaded-only')` to `z.enum(['preloaded-only','public-registry'])`
in `src/docker-workload/config.ts` (schema ~46, resolved type ~73, resolution ~97). Default stays
`preloaded-only`; resolved type carries the union. Fuse behavior unchanged.

## Layering (pure policy vs I/O seam) — NOTE both live in src/docker/ (NOT docker-workload)
- `src/docker/registry-egress-policy.ts` — PURE (node+zod+`hop-by-hop-headers.js` leaf only).
  `loadRegistryEgressManifest` (strict schema, O_NOFOLLOW, non-group/world-writable, 2..1MB, sha256),
  branded `ValidatedRegistryEgressManifest` via `validateRegistryEgressManifest` (validate once),
  `authorizeValidatedRegistryEgressRequest` (hot path, no re-parse), `authorizeValidatedRegistryRedirect`
  (bounded redirect closure). Pull ops: `api-version|token|manifest-pull|blob-pull`. Rejected set
  (`push|delete|catalog-enumeration|tags-enumeration|unknown`) is NOT expressible in schema → fails
  closed. Digest helpers: `parseOciDigest` (sha256 only), streaming `createRegistryContentHasher`
  (update/bytesHashed/digestHex), `verifyContentDigest`.
- `src/docker/registry-egress-proxy.ts` — I/O seam (imports pure policy + `outbound-transport.ts`).
  `createRegistryEgressGuard({mode,manifestPath})` → fail-closed at construction for `public-registry`;
  `disabled` guard authorizes nothing. `handleRegistryEgressRequest(clientReq,clientRes,ctx)`: authorize →
  fetch via `OutboundTransport` → follow bounded redirects → BUFFER-bounded-then-verify → deliver only
  verified content. `ctx.recordProvenance?` sink gets resolved digest (registry/repo/reference/
  requested+resolved digest/size) AFTER verification, BEFORE delivery.

## Key design decisions (don't re-litigate without a reason)
- Classification is by `operations[]` + optional `tokenPaths[]`, NOT a strict `role` field. Real
  registries differ: Docker Hub splits token onto auth.docker.io; ghcr.io serves `/token` AND `/v2/*` on
  one host. Token path is matched BEFORE v2 path shapes so a combined host resolves both.
- Content-addressed verification is THE control. By-digest pulls (blob, manifest-by-digest) carry the
  sha256 in the URL → stream-hash, reject mismatch with 502 (substitution defense). Tag pulls have no
  a-priori digest → `resolvesDigest:true`, digest computed from verified bytes and surfaced for audit.
- Dynamic-host (CDN) redirects are followed by the PROXY internally (model A — client sees one response;
  the CDN host is never a client CONNECT), ONLY when `allowDynamicRedirectHosts` (i.e. expectedDigest
  present). Tag/token never follow a dynamic host. Redirect follows carry NO request headers.
- Anonymous-only is STRUCTURAL: `FORBIDDEN_CREDENTIAL_HEADERS` (authorization/cookie/x-api-key/…) are a
  fail-closed REJECTION on the request AND schema forbids them in an origin's `requestHeaders.allow`.
  Connection-management headers (`host` + HOP_BY_HOP_HEADERS) are DROPPED silently (transport re-frames).
- Forwarder BUFFERS bounded content before delivery (never streams unverified bytes). Documented as a
  0F simplification; true streaming + per-image cumulative accounting + the anonymous bearer-token flow
  (Docker Hub/ghcr 401→token→retry-with-Bearer) are 0C. The strict credential rejection currently makes
  the end-to-end anon-bearer flow a 0C concern.

## MITM wiring (WHOLE-PROXY mode, mirrors build-egress; I own mitm-proxy.ts here)
`MitmProxyOptions.registryEgress?: {guard}`. Mutually exclusive with `buildEgress` (throws at
construction). registry v2 is https-only → NO plain-HTTP branch (unlike build-egress apt). Minimal edits:
`isRegistryEgress` bypasses the CONNECT allowlist DENY + tags `ConnectionMeta.registryEgress` + TLS-
terminates every host; inner `request` handler early-dispatches to `handleRegistryEgressRequest` (scheme
https). `preloaded-only` sets no guard → registry traffic has no route (fail closed).

## Draft manifest & freeze
`config/docker-workload/registry-egress-manifest.json` — DRAFT (in-band `status:"draft"`; strict schema
allows NO comment fields, so `status` + policyId `...-draft-v1` are the markers). Origins:
registry-1.docker.io + auth.docker.io(token) + ghcr.io(combined). Must load cleanly via
`loadRegistryEgressManifest`. 0C must freeze reviewed origins, exact blob-byte ceilings, hermetic
protocol fixtures, and negatives (§6.4/§16.5 name G3 registry negatives).

## Testing pattern that worked (hermetic, NO live registry)
- `test/docker/registry-egress-policy.test.ts`: temp-file manifests (0400/0666/symlink for load negatives);
  `manifest()` typed fixture; synthesized sha256 bytes for digest verify; redirect authorized at policy
  level with https CDN URLs.
- `test/docker/registry-egress-proxy.test.ts`: real loopback front `http.createServer` → `handleRegistryEgressRequest`;
  KEY SEAM = a `routingTransport(Map hostname→loopbackPort)` custom `OutboundTransport` (registry schema
  FORCES `protocol:'https:'` so build-egress's http-loopback trick does NOT work — route by hostname to a
  plain-http loopback instead, ignoring the https destination). `spyTransport` (request() throws) proves
  rejected requests never touch upstream. Redirect test = two loopback servers (registry 307 → CDN 200).
- Node http client auto-adds `host`/`connection` → the policy DROPS them silently (they're in
  DROPPED_REQUEST_HEADERS), so no manifest `strip` list is needed (differs from build-egress).
