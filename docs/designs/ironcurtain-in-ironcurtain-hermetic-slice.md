# Hermetic IronCurtain-in-IronCurtain Slice

**Status:** proposed implementation slice
**Updated:** 2026-09-01
**Applies to:** the supported macOS nested-Docker developer backends, with a topology contract reusable by
future native Linux Docker
**Related:**
[`secure-nested-runtime-implementation-plan.md`](./secure-nested-runtime-implementation-plan.md),
[`secure-nested-runtime-handoff.md`](./secure-nested-runtime-handoff.md),
[`secure-nested-runtime-public-network.md`](./secure-nested-runtime-public-network.md)

## Decision summary

Prove the existing private-Docker capability by running an inner IronCurtain coordinator inside an outer
Docker-enabled IronCurtain agent. The inner coordinator must create one normal batch child through the
private daemon, carry one synthetic provider exchange through inner and outer MITMs, write through the
exact `/workspace` bind, and clean up without a public dependency or paid provider call.

This slice adds only three product mechanisms:

1. a read-only, bundle-visible parent-bootstrap contract that points inner IronCurtain at the exact outer
   MITM and maps inner provider credentials to outer fake sentinels;
2. backend-neutral shared-path wiring for `/workspace` and `/run/ironcurtain-nested`; and
3. Docker Desktop's missing exact workspace bind plus a separate lease-owned exchange volume.

The fixed-parent HTTP transport already exists. This slice selects it from trusted bootstrap state; it
does not add a generic user-configurable parent proxy. The hermetic fixture uses a small test-only image
archive, but Docker Desktop production startup continues to create the outer agent directly from its
immutable host image ID and starts the private daemon with an empty image store.

Transport is selected by topology, not by the word “Docker.” Native Linux Docker can and should use UDS
for the private Docker API, the parent MITM, and inner exchange sockets. Docker Desktop's TCP hop is a
macOS-host reachability constraint, not a Docker-runtime requirement.

## Goals

- Exercise the real inner IronCurtain Docker session construction and normal batch-child lifecycle.
- Prove `inner fake -> outer fake -> synthetic real` provider credential substitution through two MITMs.
- Keep provider Host/SNI and endpoint policy at their canonical origin across both layers.
- Prove the inner child sees the same `/workspace` content as the outer agent and host.
- Prove an inner proxy socket created after the private daemon starts can be bind-mounted into the child.
- Preserve one outer authority domain: agent, daemon, inner IronCurtain, and descendants may collude, but
  cannot widen host mounts, network authority, real credentials, aggregate resources, or lifetime.
- Reuse common batch/PTY lifecycle, lease, watchdog, mount, proxy, and cleanup helpers.
- Run deterministically against a local fake provider with no public network and no paid model call.

## Non-goals

- Native Linux implementation or qualification. The contract is Linux-compatible, but this slice runs on
  the two supported macOS backends.
- A generic parent-proxy setting, arbitrary proxy chaining, or caller-selected CONNECT authority.
- Isolation between the outer agent, private daemon, inner coordinator, or inner child.
- A third nested Docker daemon or recursive `dockerWorkload.enabled` in the inner session.
- PTY/mux, workflow, resume, OAuth refresh, every provider profile, MCP servers that launch Docker, or
  package-policy chaining through both MITMs.
- Persistent daemon state, private registries, host port publication, or production image preloading on
  Docker Desktop.
- Treating fake sentinels, fixture image hashes, or inner resource labels as host security authority.

## Existing foundations and missing wiring

The current tree already has:

- a destination-bound fixed-parent transport supporting an exact UDS or TCP parent;
- a hermetic unit test for two-MITM sentinel substitution and parent-loss failure;
- a private Docker API and managed inner network on Apple Container and Docker Desktop;
- shared admission, outer-resource ledgering, watchdog, activation, and cleanup;
- an exact `/workspace` mount in the outer agent; and
- an API named volume mounted read-write into the Docker Desktop daemon and read-only into the agent.

It does not yet have:

- product construction that selects the parent transport for an inner coordinator;
- a bounded bootstrap representation of the outer endpoint, CA, auth kind, and fake sentinels;
- Docker Desktop `/workspace` path equivalence between agent and daemon;
- a writable exchange path visible at the same location in the Docker Desktop agent and daemon; or
- a hermetic inner agent image in Docker Desktop's intentionally empty private image store.

The last item is fixture preparation, not a reason to restore the large selected-agent archive to the
Docker Desktop product path.

### Independent Docker Desktop value

The `/workspace` sidecar mount is not exclusively self-hosting support. Today a Docker Desktop agent can
stream a build context through the Docker API, but a nested command such as
`docker run -v /workspace:/src ...` resolves `/workspace` in the daemon sidecar's mount namespace, where
the outer workspace is absent. That breaks an ordinary Docker development pattern even when no inner
IronCurtain process exists.

If self-hosting is deferred, extract and land the exact Docker Desktop workspace-equivalence change with
its stopped-create and cleanup tests. The exchange volume and parent-bootstrap contract may remain in the
self-hosting slice unless another supported workload needs late-created agent/daemon-shared UDS files.

## Architecture

```text
trusted macOS host
  synthetic provider (test only)
  outer IronCurtain coordinator
    real test credential
    outer MITM
    outer lease/watchdog/cleanup
             ^ fixed parent UDS or TCP
             |
untrusted Docker-enabled bundle
  outer agent / inner IronCurtain coordinator
    outer fake sentinel
    inner MITM
    DOCKER_HOST -> private daemon UDS
             ^ inner UDS under /run/ironcurtain-nested
             |
  inner batch child
    inner fake sentinel
    /workspace -> exact shared workspace
```

The outer MITM remains the only component holding a real credential and the only authoritative provider
egress boundary. An attacker controlling the whole bundle can use the outer fake sentinel and outer proxy
directly; that is already within the accepted collusion model. The security claim is non-provisioning of
the real credential and confinement by the outer MITM, not mandatory traversal of the inner MITM.

## Topology contract

Do not infer proxy or Docker API transport from `runtimeKind === "docker"`. Resolve explicit endpoint
capabilities:

```ts
type FixedEndpoint =
  | { readonly kind: 'uds'; readonly socketPath: string }
  | { readonly kind: 'tcp'; readonly hostname: string; readonly port: number };

interface NestedSharedPaths {
  readonly workspace: '/workspace';
  readonly dockerApiRoot: '/run/ironcurtain-docker';
  readonly exchangeRoot: '/run/ironcurtain-nested';
}
```

| Backend/topology      | Private Docker API | Inner exchange   | Inner-to-outer MITM | Workspace equivalence                    |
| --------------------- | ------------------ | ---------------- | ------------------- | ---------------------------------------- |
| Apple Container macOS | VM-local UDS       | same-VM path     | exact mounted UDS   | same VM filesystem at `/workspace`       |
| Docker Desktop macOS  | named-volume UDS   | named-volume UDS | fixed TCP hop       | exact host bind in both agent and daemon |
| Native Linux Docker   | shared UDS         | shared UDS       | exact mounted UDS   | exact host bind in both agent and daemon |

The Linux row is a design constraint, not evidence that Linux is implemented. It prevents Docker
Desktop's host-gateway relay from becoming an accidental requirement of every Docker backend.

## Parent-bootstrap contract

The outer coordinator stages one versioned, read-only manifest in the existing orientation mount. A
conceptual shape is:

```json
{
  "schemaVersion": 1,
  "parentProxy": {
    "kind": "uds",
    "socketPath": "/run/ironcurtain/mitm-proxy.sock"
  },
  "parentCaCertificatePath": "/etc/ironcurtain/ca-cert.pem",
  "workspacePath": "/workspace",
  "exchangeRoot": "/run/ironcurtain-nested",
  "providerProfileId": "default",
  "authKind": "api-key",
  "providerSentinels": {
    "api.anthropic.com": "sk-ant-api03-outer-fake",
    "platform.claude.com": "sk-ant-api03-outer-fake"
  }
}
```

TCP form contains only `hostname` and `port`. The parser rejects unknown fields, relative UDS paths,
invalid ports, missing CA/path contracts, unsupported auth kinds, profile mismatch, unrecognized provider
hosts, and a real-key slot not backed by an outer sentinel. The manifest is visible to the colluding
bundle and contains no secret.

When the inner coordinator is launched with this manifest:

1. it uses a bundle-scoped IronCurtain home beneath `/run/ironcurtain-nested`;
2. it resolves provider/auth inputs from the manifest instead of host keychain or credential files;
3. it places only the outer fake sentinel into its MITM's real-key slot;
4. it independently generates a new inner fake sentinel for the child;
5. it selects `createParentProxyOutboundTransport()` with the fixed endpoint and outer public CA; and
6. any parent loss or bootstrap mismatch returns a bounded failure with no direct fallback.

The first acceptance fixture may use native Anthropic API-key semantics. OAuth, OpenRouter, Codex, Goose,
and multiple simultaneous profiles require follow-up cases before their self-hosting variants are
advertised; the manifest remains capable of representing a bounded provider-to-sentinel map without
storing it in ordinary user configuration.

### Address-policy boundary

The current fixed-parent transport screens destination DNS locally. The offline outer agent may not have
a usable public resolver. Do not solve that by adding DNS or general egress to the bundle.

For this slice, a parent-screened transport mode may be selected only for a host-generated, fixed provider
destination that the outer standard MITM independently recognizes and screens. The inner standard MITM
must reject dynamic passthrough and non-provider destinations in this mode. Registry and package egress
continue to require their current local address authority and must reject a delegated transport because
they can follow derived or repository-selected destinations that the parent cannot safely reconstruct.

This is no weaker than the accepted bundle behavior: the colluding bundle already holds the outer fake
sentinel and can address the fixed outer proxy. It does not grant a new destination or real credential.

## Shared-path wiring

### Common rules

- The inner invocation always uses `--workspace /workspace`.
- Its `IRONCURTAIN_HOME` is a unique directory below `/run/ironcurtain-nested`.
- Docker API and exchange storage remain separate capabilities.
- The host resolves and records the exact workspace source before any outer create.
- Both agent and daemon receive that one source at `/workspace`; no inner path can add a new host bind.
- Exchange storage is writable because the inner coordinator creates proxy sockets after daemon startup.
- API storage remains daemon-write/agent-read on sidecar backends.
- macOS `node_modules` is never executed from Linux. The harness supplies a Linux-built dependency
  artifact or cache with an architecture, Node ABI, lockfile, and package-manager identity.

### Apple Container

The agent and private daemon already share one VM filesystem and `/workspace`. Ensure the selected agent
image or trusted bootstrap creates `/run/ironcurtain-nested` with the runtime UID and mode `0700`. No new
host directory or network attachment is required. Inner UDS files remain VM-local and disappear with the
VM.

### Docker Desktop

Extend the existing sidecar lifecycle rather than adding a parallel path:

1. pass the already-canonical workspace source into sidecar construction and mount it read-write at
   `/workspace` in both agent and daemon;
2. ledger and create one generation-scoped `exchange` named volume;
3. mount it read-write at `/run/ironcurtain-nested` in both agent and daemon;
4. seed the target directory as UID/GID 1000, mode `0700`, in the fixed daemon image so named-volume
   copy-up establishes usable ownership without an initializer container or `CAP_CHOWN`;
5. return both API and exchange mounts from the backend-neutral agent-wiring helper; and
6. include the workspace bind, exchange volume, immutable IDs, and mount modes in stopped-create
   adjudication, lease evidence, rollback, watchdog inventory, and exact teardown.

Batch and PTY creation already consume the common nested-agent wiring helper. Adding the exchange mount
there must cover both; a separate PTY implementation is forbidden.

### Native Linux Docker

Future Linux uses the same path contract with UDS endpoints. The parent host MITM socket and bundle
exchange root are shared through exact bind or named-volume mounts, and the agent/daemon see the exact
workspace source at `/workspace`. No Docker Desktop relay, `host.docker.internal`, or forced TCP endpoint
belongs in the Linux topology.

## Hermetic fixture

The retained unit cascade constructs two MITMs directly. The new acceptance must drive product
construction from inside a real Docker-enabled outer bundle.

### Inputs

- a host-local synthetic provider that implements one bounded provider response;
- a synthetic real test key known only to the outer test process;
- the outer MITM configured with the provider's canonical host and a trusted local upstream override;
- a small `FROM scratch` agent image containing a static fixture executable;
- a Linux-built inner test driver/dependency artifact; and
- an isolated IronCurtain home, workspace, and outer runtime inventory.

The fixture image is built for the backend architecture, contains no shell or package manager, and speaks
the selected adapter's normal batch response contract. It makes one provider request through the proxy,
validates the synthetic response, writes a nonce to `/workspace`, and exits. The harness loads this small
archive into the private daemon through its Docker API after outer activation. This is test setup only:
the production Docker Desktop daemon remains empty at session start.

The inner test driver registers the fixture adapter and invokes the ordinary session factory with
`containerRuntime: "docker"`, no inner `dockerWorkload` capability, `--workspace /workspace`, and its home
under the exchange root. It must not call a special container-create helper or bypass normal inner MITM,
mount, activation, session, or cleanup code.

### Startup sequence

1. Start the synthetic provider on host loopback.
2. Create the outer session in `offline` mode with its normal MITM and private daemon.
3. Stage the read-only parent-bootstrap manifest from the resolved outer endpoint and fake sentinel map.
4. Start the outer agent only after the daemon and shared-path canaries pass.
5. Load the small fixture image into the private daemon.
6. Launch the inner test driver with the fixed workspace and exchange-root home.
7. Let inner IronCurtain create one normal batch child and complete one turn.
8. Close the inner session, then close the outer session and collect both cleanup inventories.

No step resolves or contacts a public registry, package repository, provider, DNS service, or update
endpoint during the retained run.

## Acceptance

### Positive gate on each macOS backend

- The inner coordinator reaches the private daemon through its UDS and creates one normal batch child.
- The child sees `DOCKER_HOST` only if its adapter normally receives it; it never sees the host runtime API.
- The child sends a unique inner fake sentinel to the inner MITM.
- The inner MITM substitutes exactly the outer fake sentinel and uses the fixed parent endpoint.
- The outer MITM substitutes exactly the synthetic real test key.
- The synthetic provider sees the canonical provider host/path and only the synthetic real test key.
- The outer proxy audit records the exchange; inner diagnostics may record it but are not host authority.
- The child writes a random nonce beneath `/workspace`; the inner coordinator, outer agent, and host read
  the same bytes.
- A UDS created beneath the exchange root after private-daemon startup can be mounted and reached by the
  child.
- Normal inner close removes the child and its inner network without removing the outer daemon.
- Outer close removes every exact agent/daemon/relay/network/API-volume/exchange-volume resource and state
  root while preserving unrelated runtime objects.

### Negative and failure gate

- The synthetic real key is absent from outer-agent and inner-child env, files, mounts, archives, logs,
  command lines, and image metadata.
- Missing/malformed bootstrap, profile mismatch, unknown endpoint, wrong CA, or wrong outer sentinel fails
  before child release.
- Parent loss yields a bounded `502`/session failure and never opens a direct socket.
- Dynamic passthrough and unlisted destinations are unavailable under delegated fixed-provider screening.
- `/workspace` source substitution, an exchange/API mount swap, wrong volume ownership, or unexpected
  sidecar mount fails stopped-create adjudication.
- An inner request to bind an outside path can expose only the daemon sidecar/VM filesystem, never a new
  macOS host path.
- Killing the inner coordinator leaves cleanup to outer teardown; killing the outer coordinator is
  reconciled by the existing watchdog/startup recovery path.
- A feature-off session has no bootstrap manifest, exchange volume/path contract, private daemon, or new
  mount.

## Implementation map

Keep the production delta narrow and reuse current ownership:

- `src/docker/nested-parent-bootstrap.ts` — strict manifest schema, staging, loading, endpoint conversion,
  and provider-sentinel resolution.
- `src/docker/outbound-transport.ts` — retain exact UDS/TCP parents; add only the narrowly typed
  parent-screened fixed-provider mode if the no-DNS live probe requires it.
- `src/docker/mitm-proxy.ts` — admit delegated screening only for fixed configured providers; keep dynamic
  passthrough and registry/package callers fail closed.
- `src/docker/docker-infrastructure.ts` — stage the bootstrap once, select inner transport/credential input,
  and pass the common workspace/exchange contract to backend wiring.
- `src/docker-workload/docker-desktop-sidecar.ts` — create/adjudicate the exchange volume and mount the exact
  workspace/exchange paths.
- `src/docker-workload/infrastructure.ts`, lease evidence, and revocation helpers — add the exchange volume
  as another ordinary ledgered outer resource; do not invent a second ledger.
- `docker/nested-daemon/Dockerfile` and Apple base-image setup — create the fixed exchange target with exact
  ownership.
- `test/docker/mitm-cascade.test.ts` — retain transport-level foundation coverage.
- a new backend-parameterized integration harness — fixture build/load, inner normal batch turn, path
  proof, credential proof, failure injection, and exact cleanup.

Do not duplicate batch and PTY mount construction, Docker Desktop resource naming, rollback, or cleanup.
The existing nested-agent wiring and ledgered-create callbacks remain the shared seams.

## Delivery sequence

1. Add the strict bootstrap type and hermetic unit tests without a product caller.
2. Add common workspace/exchange path types and Docker Desktop volume/mount lifecycle with stopped-create,
   rollback, cleanup, and feature-off tests.
3. Select fixed-parent provider transport and nested sentinel credentials from the bootstrap; retain
   direct host transport elsewhere.
4. Build the static fixture and inner driver, then pass the complete gate on Apple Container.
5. Run the same gate on Docker Desktop; fix only backend adapter mechanics, not the common semantics.
6. Inject parent loss, inner crash, outer crash/reconciliation, and partial-create failures.
7. Run focused suites, full repository gates, formatting/cycles/build, and a simplify pass before review.

## Exit criteria

This slice is complete when the same retained, no-provider-cost test passes on Apple Container and Docker
Desktop and proves the credential cascade, workspace/socket equivalence, normal inner batch construction,
and exact cleanup. A hand-driven Claude turn, public image pull, warm daemon cache, or inspection of only
the outer agent is not substitute evidence.

Passing this slice proves self-hosting compatibility for the controlled batch fixture. It does not by
itself declare nested Docker preview-ready or close the broader backend qualification work listed in the
secure nested-runtime handoff.
