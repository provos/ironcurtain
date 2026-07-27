# Docker-workload egress construction seam (Phase 0F, standalone/injectable)

`src/docker/docker-workload-egress.ts` (~210 lines) — the FIRST non-test caller of
`createRegistryEgressGuard` / `createBuildEgressGuard`. NOT wired into
`prepareDockerInfrastructure`; nothing binds a socket on the live path (the nested rootless
daemon doesn't exist, and `getBundleSocketsDir` is bind-mounted into the *agent* container, so
egress sockets must NOT go there — that would hand the agent a direct route to the frozen
registry/build origins around the provider MITM). See [[build-egress-seam]], [[registry-egress-seam]].

## Shape (two-phase, deliberately)
- `resolveDockerWorkloadEgressListenerOptions(options) -> { registryEgress?: MitmProxyOptions;
  buildEgress?: MitmProxyOptions }` — does ALL the fail-closed work (manifest load, Dockerfile
  hash-bind, transport preconditions) and returns the exact per-mode proxy options.
- `createDockerWorkloadEgressListeners(options) -> { registryEgress?: MitmProxy; buildEgress?: MitmProxy }`
  — constructs (does NOT start) proxies from the resolved options. Caller owns start/stop.
- Because phase 1 runs for BOTH modes before phase 2 constructs ANY proxy, a drifted Dockerfile
  leaves no half-built registry listener. Assert that property, don't just hope for it.
- Exporting the "plan" function is what lets tests assert guard identity + option discipline
  without adding production-only test hooks. Worth reusing whenever a seam is "construct N things
  from config" — the option-derivation is the testable part.

## Gating (from `ResolvedDockerWorkloadConfig`)
`enabled:false` -> `{}`; `imageIngress:'public-registry'` -> registry listener; `buildEgress:
'ironcurtain-dockerfiles'` -> build listener (`seam:'run'`, the only seam the frozen manifest
declares); anything else -> NO listener. Never a `mode:'disabled'` guard behind a live listener —
"no route" is the design claim, and a bound socket that TLS-terminates every host then 403s is
strictly more surface.

## Preconditions enforced AT CONSTRUCTION (not per-request)
- build -> `transport.kind === 'fixed-parent-proxy'` (every frozen rule is `fixed-parent-only`;
  `assertFixedParentBinding` would 502 every request on a direct transport = misconfiguration).
- registry -> `transport.addressGuard === 'local-resolver'` (written `!== 'local-resolver'` so a
  stub missing the field is refused). Both remain enforced per-request too; construction just
  fails fast.
- Listen target (`{socketPath}` | `{listenPort}`) is caller-supplied and REQUIRED per enabled mode.

## Options never passed (security-load-bearing)
`controlSocketPath`/`controlPort` (control API can add passthrough hosts = route around the frozen
manifest), `registries`, `packageValidation`, `capture`/`recordedAgentName`/`workflowRunId`/
`bundleId`, `initialTokenSessionId`, `agentKind`, `allowPrivateDestinationsForTests`. Test asserts
the EXACT `Object.keys(...).sort()` set so any newly added MitmProxyOption is caught.

## Path helper
`src/docker/docker-workload-paths.ts` — `getIronCurtainPackageRoot()`,
`getFrozenDockerWorkloadDir()`, `getFrozenBuildEgressManifestPath()`,
`getFrozenRegistryEgressManifestPath()`. `preloaded-catalog-paths.ts` now delegates its private
`packageRoot()`/`getFrozenCatalogDir()` here (one source of truth for `<package>/config/docker-workload`).
Manifest paths are deliberately NOT overridable by callers; only `repositoryRoot` is (needed to
prove hash drift, and it can't loosen anything since the manifest pins exact bytes).
