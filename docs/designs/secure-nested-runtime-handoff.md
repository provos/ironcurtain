# Secure Nested Runtime Handoff

**Updated:** 2026-08-15
**Branch:** `feat/secure-nested-runtime`
**Baseline commit:** `70f22b615b4067ddb7a53d300dc6e6dc23a460a5` (`feat: enable mediated nested registry workloads`)
**Primary design:** [`secure-nested-runtime-implementation-plan.md`](./secure-nested-runtime-implementation-plan.md)

## Objective

Give Claude Code inside an IronCurtain Apple Container session a real, private Docker daemon that can:

1. pull an allowed public workload image through host-mediated registry egress;
2. create an inner-only Docker bridge;
3. run a server container;
4. let a sibling container reach the server by Docker DNS alias; and
5. tear down the complete outer bundle without exposing a host Docker socket, direct public route, credential, or host port.

The current working tree implements the production objective through selected-current-agent artifact
transport. It no longer admits sessions from a frozen bundle-image catalog or writes catalog/toolchain
authority into new leases. On 2026-08-15 the complete replacement public-registry product-entrypoint
smoke passed after the migration, including managed-network probes and exact outer-VM teardown.

The 2026-08-15 threat-model correction treats every bundle image as untrusted and keeps host
create/profile, proxy, watchdog, and cleanup controls as the authority. Obsolete catalog generation,
pairing, and freshness tooling is removed; Git history retains that qualification experiment. Full
preview qualification and a real Claude provider turn are also incomplete.

## Current Working State

The baseline commit contained the complete public-registry slice and historical generation-v3 catalog
artifacts. The subsequent usability slice makes mediated public pulls the enabled-state default, exposes
the two operator choices in the CLI and web settings, and keeps qualification/offline modes explicit.
The current working tree removes frozen catalog identity from production admission, automatically
prepares only the selected current-agent archive, and retains tolerant legacy-lease parsing for cleanup.
The replacement live public-registry smoke passed as session
`a4208f3a-cd33-45bd-a4ec-b9e560acd176` with outer VM
`ic-dw-agent-6e38b54379de4a49`; post-run inventory confirmed that the exact outer VM and temporary capture
alias were absent while unrelated pre-existing Apple containers were unchanged.

The currently supported variant is deliberately singular:

- outer runtime: Apple `container`;
- tier: developer-only;
- bundle image: untrusted selected current agent, with one prepared outer/inner artifact resolution;
- workload ingress: either offline/preloaded-only or mediated public registry;
- daemon state: ephemeral;
- build egress: disabled;
- host port publishing: disabled;
- PID enforcement: advisory;
- disk enforcement: watchdog-observed developer policy, not a hard quota.

Docker Desktop, native Linux, persistent daemon state, current-Dockerfile build egress, required PID
enforcement, numeric disk limits, nested CPU/memory overrides, and preview mode remain rejected by the
resolved-variant guard.

## What Is Implemented

### Private Docker lifecycle

- Each admitted session creates one disposable outer Apple VM with `network=none`.
- A rootless Docker 29.2.1 daemon runs inside that VM over a private UDS.
- RootlessKit remains `--net=none --disable-host-loopback`.
- Dockerd remains `--iptables=false --bridge=none`; there is no default bridge, NAT uplink, or host publication.
- The bootstrap sets and reads back `net.ipv4.ip_forward=1` only inside RootlessKit's private network namespace so user-defined inner bridges work.
- The rebuilt base image installs Debian's legacy iptables implementation. The daemon's private PATH selects:

  ```text
  /usr/local/lib/ironcurtain-docker/bin/iptables
    -> /usr/sbin/iptables-legacy
  iptables v1.8.11 (legacy)
  ```

  This supplies Moby's per-sandbox `127.0.0.11` DNS rules. It does not enable daemon-wide bridge rules or add an outer uplink.

### Public-registry egress

- Public-registry mode creates one host-owned listener per bundle under its 0700 runtime root.
- Apple mounts only the exact listener UDS at `/tmp/ironcurtain-registry-egress.sock` in the VM.
- A fixed `socat` relay runs inside RootlessKit's namespace on `127.0.0.1:18081`.
- Only dockerd receives the proxy and public-CA environment. Inner containers and Dockerfile `RUN` steps do not automatically inherit it.
- The host listener uses direct destination-bound transport with local DNS/SSRF adjudication. There is no generic or direct fallback.
- CONNECT authority parsing is canonical and exact; registry mode requires an allowed host/port and SNI equal to the CONNECT host before certificate generation.
- The frozen manifest gates origins, methods, paths, queries, request headers, redirects, concurrency, bytes, and time. Push, delete, catalog/tag enumeration, unlisted origins, private/local addresses, and over-limit transfers fail closed.
- IronCurtain injects no registry credential and configures no private registry. A bundle-supplied syntactically valid Bearer token can reach only a listed origin; the proxy cannot prove such a token was anonymously issued.

### Lifecycle and cleanup

- Registry listener creation, exact Apple mount, daemon bootstrap, workload activation, and PTY attachment are ordered so the agent is not released before the private daemon is admitted.
- Listener shutdown participates in batch, PTY, prepare-failure, and exact bundle teardown paths.
- Leases, watchdog supervision, serialized cleanup ownership, incident recovery, exact immutable outer IDs, generation labels, and two empty cleanup inventories remain the host authority.
- Successful smoke runs removed their exact VM, lease/state/runtime/socket trees, watchdog, and isolated smoke home. The managed inner network intentionally remains inside its disposable VM until that exact outer VM is removed; it is not a separately ledgered host resource.

### Catalog retirement and selected-current disposition

Generation v3 proved archive canonicalization and cross-backend loading, but its eight bundle roles never
constrained the colluding bundle. Catalog generation, pairing, freshness checks, and staged copies are now
removed from the current tree. Production resolves/builds the selected current agent once, captures one
stable per-session outer reference and Docker-compatible inner archive, and stages only that artifact.
Checksums and archive validation detect transport corruption/TOCTOU; they do not attest guest code.
Tolerant lease parsing remains solely for exact recovery of historical leases. The future Docker Desktop
fixed uplink relay remains independently digest/config pinned because it owns network authority unavailable
to the bundle.

## Required User Configuration

The smallest currently admitted configuration is:

```json
{
  "dockerWorkload": {
    "enabled": true
  }
}
```

`containerRuntime` may remain `auto` when it resolves to Apple Container. Enabling nested Docker
defaults to mediated Docker Hub/GHCR pulls; it does not grant generic network access. Set
`"imageIngress": "preloaded-only"` explicitly to opt out of live registry access. The observed-disk
watchdog policy and other internal invariants no longer require operator boilerplate. Numeric
`dockerResources.memoryMb` and `dockerResources.cpus` values are inherited by the outer VM; `null` uses
safe nested fallbacks. Legacy `dockerWorkload.resources` overrides are rejected rather than silently
creating a second resource envelope.

Normal operator entrypoint:

```bash
tsx src/cli.ts mux
```

Create a session with `/new`. Inside the Claude session, `docker info` should report the private rootless daemon. Workload servers are reachable from sibling containers on an inner Docker network, not from the Mac host.

### Agent orientation and the managed inner network

Successful admission exports `IRONCURTAIN_DOCKER_NETWORK=ironcurtain` beside `DOCKER_HOST` and
adds a shared nested-Docker section to the Claude Code, Codex, and Goose orientation prompts.
Ordinary sessions and failed admissions receive neither the capability nor the prompt section. Use
the managed network for every nested service and client so Docker's embedded DNS can resolve the
service name:

```bash
docker run -d --name target --network "$IRONCURTAIN_DOCKER_NETWORK" <service-image>
docker run --rm --network "$IRONCURTAIN_DOCKER_NETWORK" <client-image> http://target:<port>/
```

Compose uses the already-created network as its external default:

```yaml
networks:
  default:
    external: true
    name: ${IRONCURTAIN_DOCKER_NETWORK}
```

There is no default nested bridge. `-p`/`--publish` and `--network host` do not expose a service to
the Mac, and neither the Mac nor the agent shell can reach it through `localhost`. Use a sibling
container on the managed network and address the target by container name or network alias. The
fixed name is safe because every admitted daemon and its managed network are bundle-local. This is
the supported service topology rather than an isolation boundary: the untrusted agent has Docker
administrator authority over its bundle-local daemon and may change inner resources.

## Historical pre-migration evidence

Earlier catalog-based offline and public-registry smokes exercised the built CLI and exact cleanup, but
they do not qualify selected-current transport or the managed-network slice. Their catalog identities,
temporary paths, and duplicate validation tables are intentionally omitted here; Git history retains the
diagnostic record. Fresh selected-current offline and PTY gates remain pending. The current
public-registry result follows.

## Managed-Network Usability Slice Evidence

The updated production lifecycle now creates and strictly admits the fixed bundle-local
`ironcurtain` network before activation, then exports
`IRONCURTAIN_DOCKER_NETWORK=ironcurtain` to the agent. Repeated real Apple/public-registry smoke on
2026-08-15 reached activation and proved the following before exact outer cleanup:

- the agent environment contained the exact managed-network name;
- the pre-created network was a local internal bridge with its original full immutable ID and no
  endpoints before fixture creation;
- an allowed BusyBox pull still traversed the mediated registry path;
- sibling containers communicated by inspected IPv4 and by network alias through Docker's
  `127.0.0.11` resolver;
- a container started with omitted/default networking but received no usable network ID, endpoint,
  IP address, or gateway, and did not mutate or join the managed network;
- a service started with `--network host` was self-reachable on a deterministic non-reserved port,
  while neither the agent shell nor the Mac returned its exact random nonce;
- a `-p 127.0.0.1:<deterministic-port>:8080` fixture was self-reachable, but its inspected port
  binding was null/empty and neither the agent shell nor the Mac returned its exact nonce;
- host-network direct public-IP and public-DNS probes remained denied; and
- fixture containers and the pulled fixture image were removed before the exact enclosing Apple VM
  was removed. The managed network was intentionally left for outer-VM teardown.

Every reachability assertion compares an exact random nonce rather than only a `curl` exit status.
This matters because port `18080` is already occupied by IronCurtain's outer agent proxy: an earlier
probe reached that unrelated listener and caused the smoke to be tightened. Ports `18080` and `18081`
remain reserved for the agent/provider proxy and registry relay. Per-probe nonce values and stdout are
not durable artifacts; the current evidence is that the exact assertions completed and the final
selected-current harness reached its recorded green result and cleanup.

Catalog-era failed attempts exposed mutable-tag and network-ID bookkeeping defects; they are superseded
by the selected-current result below and retained only in Git history.

### Replacement selected-current-agent live result

On 2026-08-15, `npm run smoke:nested:apple:public-registry` passed on the selected-current-agent path:

```text
nested Apple public-registry infrastructure smoke passed
session=a4208f3a-cd33-45bd-a4ec-b9e560acd176
outer=ic-dw-agent-6e38b54379de4a49
```

The run built/resolved the current `ironcurtain-claude-code:latest`, captured and canonicalized its exact
selected artifact without reading a production catalog, loaded it into the private Docker daemon, pulled
the public-registry fixtures through mediated egress, and completed the managed-network and negative
publication probes. Post-run `container list --all` contained no exact outer VM, `container image list`
contained no `ironcurtain-capture-*` alias, the isolated smoke root was removed, and unrelated pre-existing
Apple containers were unchanged.

### Recorded selected-current validation

At the selected-current migration snapshot, the non-integration root suite, focused selected-image Apple
artifact tests, the Apple backend qualification suite, web/unit/UI checks, TypeScript, lint, formatting,
build, cycle check, and diff check passed.
The exact public-registry live result above remains the runtime evidence. After removing catalog-only
modules and fixtures, rerun the current-tree gates before merge rather than reusing historical test counts.

## Important Boundaries: Do Not Overclaim

1. **No real Claude provider turn was part of the public-registry gate.** The harness starts the real built session/infrastructure path and probes the admitted private daemon from trusted host test code. It does not ask Claude to issue the Docker commands.
2. **Public registry plus PTY/mux composition is not a recorded live gate.** `npm run smoke:nested:apple:pty` exists for the node-pty/Claude-TUI path, but the latest public-registry acceptance was batch mode. The production paths share admission/bootstrap, but a combined gate remains useful evidence.
3. **No host access to the server.** Host port publishing is explicitly forbidden. The implemented use case is target/scanner or service/sibling communication inside the bundle. Safely exposing a server to the Mac is a separate design and implementation slice.
4. **No durable pull-provenance sink yet.** Policy enforcement exists, but successful registry provenance is not yet persisted as complete host session evidence.
5. **No hard Apple disk quota.** Enabling the admitted developer slice accepts the host-watchdog-observed disk policy; the risk remains even though the UI hides that implementation detail.
6. **Apple only.** Docker Desktop and Linux results must be independently implemented and qualified.
7. **Not preview-qualified.** Full G1-G10/0C release evidence, zero-skip backend qualification, and broader failure injection remain incomplete.
8. **Replacement public-registry gate passed.** The selected-current-agent product-entrypoint smoke passed
   live on 2026-08-15 and exact cleanup was audited. Offline and PTY product-entrypoint smokes remain
   separate follow-up evidence; a catalog refreeze is neither required nor a substitute for those gates.

## Recommended Next Work

### 1. Complete the remaining post-migration live gates

The selected-current-agent migration in implementation plan §16.16 is implemented. Tag/cache mutation,
legacy-lease recovery, selected-image archive qualification, and the public-registry managed-network
product-entrypoint smoke now pass. Complete the remaining offline and PTY product-entrypoint smokes and
the broader failure-injection matrix without reintroducing catalog admission.

### 2. Combined public-registry PTY/mux acceptance

Extend the live harness so one run combines:

- the production node-pty child path used by mux;
- persisted active lease before PTY evidence;
- real non-empty Claude TUI output;
- public-registry listener presence;
- the existing denied pull, allowed pull, internal bridge, server, raw-IP sibling, alias sibling, and no-egress probes; and
- existing exact PTY teardown evidence.

Keep this separate from a paid/provider turn if possible. If the goal is to prove Claude itself chooses and invokes the Docker commands, add a clearly labeled manual or hermetic-provider acceptance lane rather than weakening the infrastructure gate.

### 3. Durable registry provenance

Persist a bounded host-owned record of authorized registry requests and resolved destinations. Never store authorization headers, tokens, cookies, or unbounded query/body data. Bind the record to the lease, policy/manifest hash, and session metadata; selected-image observations may be included as provenance but are not authority.

### 4. Next-session recovery gate

In one isolated home, close the first public-registry session, start a second session, and prove no stale listener, lease incident, runtime root, or exact Apple object blocks admission. The generic incident-recovery implementation exists; this is product-entrypoint evidence.

### 5. Trusted outer inspect evidence

Persist/verify the exact host source to guest registry-socket mount pair and outer `network=none`/no-publication profile from trusted Apple inspect in the acceptance evidence.

### 6. Host port publication, only if product-required

If users must reach an inner server from the Mac, design a separate trusted fixed-port/relay capability with collision handling, ownership, policy, teardown, and no daemon-selected host binding. Do not enable Docker `-p`, Apple VM networking, or a generic host network as a shortcut.

## Key Files

Production:

- `src/docker/docker-workload-egress.ts` — per-bundle registry listener lifecycle.
- `src/docker/registry-egress-policy.ts` — frozen manifest policy enforcement.
- `src/docker/registry-egress-proxy.ts` — registry-aware proxy forwarding.
- `src/docker/mitm-proxy.ts` — listener/TLS/CONNECT parsing and authorization boundary.
- `src/docker/docker-infrastructure.ts` — batch listener ownership, Apple mount, create/teardown wiring.
- `src/docker/pty-session.ts` — PTY listener ownership and cleanup wiring.
- `src/docker-workload/apple-vm-daemon.ts` — RootlessKit, relay, legacy iptables/DNS preflight, dockerd bootstrap.
- `src/docker/selected-agent-artifact.ts` — selected-current-agent export, canonicalization, cache, and
  transport verification.
- `src/docker-workload/apple-private-docker.ts` — selected-artifact load/reinspection and strict
  managed-network creation/inspection.
- `src/docker-workload/session-daemon.ts` — readiness, provisioning, managed-network admission, and activation ordering.
- `src/docker-workload/config.ts` — supported-variant guard.
- `src/config/paths.ts` — exact per-bundle registry UDS paths.
- `docker/Dockerfile.base.arm64` — rootless Docker toolchain and legacy iptables dependency.

Acceptance and tests:

- `scripts/smoke-nested-apple.ts` — offline, PTY, and public-registry Apple smoke orchestration.
- `scripts/smoke-nested-apple-workload.ts` — pure public-registry workload plan and evidence parsing.
- `test/smoke-nested-apple-workload.test.ts` — workload-plan unit coverage.
- `test/docker/docker-workload-egress.test.ts` — listener lifecycle and policy integration.
- `test/docker/registry-egress-policy.test.ts` — manifest authority negatives.
- `test/docker/registry-egress-proxy.test.ts` — request/redirect/header/streaming behavior.
- `test/mitm-proxy.test.ts` — raw CONNECT/SNI/certificate-boundary coverage.
- `test/docker/nested-daemon-wiring.test.ts` — daemon command and Apple mount wiring.
- `test/docker-workload/apple-vm-daemon.test.ts` — exact rootless bootstrap invariants.

## Safe Continuation Rules

- Do not restore catalog generation, pairing, or refreeze as a product or qualification prerequisite.
- Preserve checksums and archive validation in the replacement transport, but never label bundle-image
  hashes or tool versions as host security authority.
- Do not start a second live smoke while another harness owns an isolated Apple VM; poll the existing harness through its `finally` cleanup.
- Preserve unrelated stopped Apple VMs and the Apple buildkit VM. Cleanup only exact lease-recorded IDs/generations.
- Do not interpret a socket inode or lease directory as readiness. Activation and daemon adjudication must precede agent attachment.
- Do not widen the rootless/outer network envelope to fix an inner compatibility issue. Keep Apple `network=none`, RootlessKit `--net=none --disable-host-loopback`, dockerd `--iptables=false --bridge=none`, and no host ports.
- Treat the bundle as colluding. Inner Docker labels, container inventory, guest paths, and daemon reports are diagnostics, not host security authority.
