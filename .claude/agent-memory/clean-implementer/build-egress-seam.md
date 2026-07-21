# Narrow build-egress path (Phase 0F Item 2)

Governing design: `docs/designs/secure-nested-runtime-implementation-plan.md` §6.3 (build-egress split),
§9.5 (Phase 0F), §11 (code map). Feature stays INERT behind `assertDockerWorkloadImplementationAvailable`
(`src/docker-workload/config.ts`) until a later phase.

## Layering (pure policy vs I/O seam)
- `src/docker-workload/build-egress-policy.ts` — PURE (node+zod only). `loadBuildEgressManifest`
  (strict schema, O_NOFOLLOW, non-group/world-writable, 2..1MB), `verifyBuildEgressDockerfileSources`
  (hash-binds current Dockerfiles to reviewed SHAs), `authorizeBuildEgressRequest` (single-rule
  resolution; rejects credential headers/encoded-path/`CONNECT`; validates acyclic redirect chains;
  returns byte/time ceilings). Seams enum: `dockerfile-frontend | base-image | run`. Keep it pure —
  do NOT add transport deps here.
- `src/docker/build-egress-proxy.ts` — I/O seam (imports the pure policy + `outbound-transport.ts`).
  `createBuildEgressGuard({mode,manifestPath,repositoryRoot})` → fail-closed at construction for
  `ironcurtain-dockerfiles` (missing/invalid manifest OR drifted Dockerfile hash throws); `disabled`
  guard's `authorize()` always throws (fail-fast). `handleBuildEgressRequest(clientReq,clientRes,ctx)`
  authorizes then forwards via `OutboundTransport`, enforcing responseBytes/timeoutMs and stripping
  hop-by-hop/`set-cookie` from the response. Extra defense: a `fixed-parent-only` rule refuses to
  egress over a non-`fixed-parent-proxy` transport (502) — reviewed origins can't leak to direct.

## Wiring seam in mitm-proxy.ts
Build egress is a WHOLE-PROXY MODE, not a per-request tag on a shared socket (you cannot distinguish
build vs agent HTTP on one tunnel). `MitmProxyOptions.buildEgress?: {guard, seam}`. When set: the
proxy has no providers/registries/passthrough; the CONNECT handler skips the allowlist DENY and
TLS-terminates every host (tag `ConnectionMeta.buildEgress`); the inner `request` handler and the
plain-HTTP `outerServer.on('request')` handler (apt speaks HTTP) both early-dispatch to
`handleBuildEgressRequest`. Each host is TLS-terminated then authorized-or-403'd at the request layer.
Minimal edits: `isBuildEgress` boolean gates the DENY condition and metadata; three early branches.

## Cold-cache capture tool (spike)
`scripts/spikes/secure-nested-docker/build-egress-capture.mjs` (tsx/node, OUTSIDE eslint+tsconfig).
Recording MITM proxy (node-forge CA, mirrors mitm-proxy cert gen) = sole build egress; records
scheme/host/port/method/path + redirect Location hops; `--build` drives `docker build --no-cache`;
`--smoke` drives synthetic local fetches (no docker) — validated working. Emits
`build-egress-manifest.draft.json` (top-level `draft:true`, NOT a loadable frozen manifest — forces
human review/artifact-pinning/seam-placement) + `capture-evidence.json`. The frozen
`config/docker-workload/build-egress-manifest.json` does NOT exist yet; freeze is a later supervised step.

## Testing pattern that worked
`test/docker/build-egress-proxy.test.ts`: temp repo dir with `docker/Dockerfile.fixture` (0600) +
`manifest.json` (0400) → real `createBuildEgressGuard`. For "forwards"/"rejected" e2e: a real
loopback front `http.createServer` calls `handleBuildEgressRequest`; a real loopback upstream +
`createDirectOutboundTransport({allowPrivateDestinationsForTests:true})` for the happy path; a
`spyTransport` (request() throws) proves rejected requests never touch the transport. Manifest
`destination.hostname` may be a literal IP like `127.0.0.1` (hostnameSchema regex accepts it). Node
http client auto-adds `host`+`connection` headers → the manifest rule's `requestHeaders.strip` MUST
list them or `sanitizeHeaders` throws "not allowed".
