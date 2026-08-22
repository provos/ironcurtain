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
On 2026-08-21, the built production workflow entrypoint then passed a deterministic, no-LLM follow-up:
public mode completed 25 functional checks, offline mode completed 17, and both produced exact closed-lease
cleanup proof. The two runs shared one isolated IronCurtain home, so the offline workflow also proved that
a second admitted session is not blocked by the first session's graceful cleanup.

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
diagnostic record. The selected-current public-registry session result and the newer deterministic
public/offline workflow result follow. The PTY smoke remains available for transport-specific regressions,
but it is not a completion gate for the functional matrix.

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

### Deterministic no-LLM workflow live result

On 2026-08-21, `npm run smoke:nested:apple:workflow` ran two ordinary built-CLI workflows through
`workflow start`, without creating an LLM session or sending a provider request:

```text
[public] workflow passed 28 deterministic checks and exact teardown proof
[offline] workflow passed 17 deterministic checks and exact teardown proof
nested Apple workflow smoke passed (public + offline, no LLM)
```

The public workflow covered the admitted private daemon, rootless/vfs profile, exact exported Docker
environment, selected image load, default-on allowlisted pull, denied registry, fixed internal bridge,
embedded DNS, alias and inner-IP sibling routing, direct public-IP denial, ineffective nested `-p`, and
empty final inner inventories. The offline workflow proved that the same selected image runs with
`--pull never` while a public pull fails and retains no public image. Each foreground workflow exited
only after its lease recorded immutable-ID absence, two separated empty inventories, and state/runtime
root removal. The harness also proved that no new `ironcurtain-capture-*` alias survived. Public then
offline in the same isolated home provides a graceful next-session recovery gate.

This is now the preferred functional Apple acceptance path: deterministic workflow commands make the
matrix reproducible and do not rely on an agent choosing commands. PTY testing remains valuable only for
the transport-specific delta (activation-before-attach, environment/orientation delivery, terminal bytes,
signal handling, and cleanup), not for duplicating the Docker functional matrix through an LLM.

### Recorded selected-current validation

At the selected-current migration snapshot, the non-integration root suite, focused selected-image Apple
artifact tests, the Apple backend qualification suite, web/unit/UI checks, TypeScript, lint, formatting,
build, cycle check, and diff check passed.
The exact public-registry live result above remains the runtime evidence. After removing catalog-only
modules and fixtures, rerun the current-tree gates before merge rather than reusing historical test counts.

## Important Boundaries: Do Not Overclaim

1. **No real Claude provider turn is required for functional acceptance.** The current workflow gate runs fixed Python commands inside the real admitted workflow bundle. It exercises production workflow/infrastructure lifecycle without asking an LLM to choose or issue Docker commands.
2. **PTY/mux is not a completion blocker.** `npm run smoke:nested:apple:pty` remains available for the node-pty/Claude-TUI path, which has prior manual coverage. The deterministic workflow owns the functional Docker matrix. Rerun PTY only after a PTY-specific change or a reported regression; do not require a provider turn to qualify nested-Docker functionality.
3. **No host access to the server.** Host port publishing is explicitly forbidden. The implemented use case is target/scanner or service/sibling communication inside the bundle. Safely exposing a server to the Mac is a separate design and implementation slice.
4. **No durable pull-provenance sink yet.** Policy enforcement exists, but successful registry provenance is not yet persisted as complete host session evidence.
5. **No hard Apple disk quota.** Enabling the admitted developer slice accepts the host-watchdog-observed disk policy; the risk remains even though the UI hides that implementation detail.
6. **Apple only.** Docker Desktop and Linux results must be independently implemented and qualified.
7. **Not preview-qualified.** Full G1-G10/0C release evidence, zero-skip backend qualification, and broader failure injection remain incomplete.
8. **Replacement public and offline gates passed.** The selected-current-agent public-registry session
   smoke passed on 2026-08-15. Deterministic public and offline production workflows passed on 2026-08-21
   with exact cleanup. A catalog refreeze is neither required nor a substitute for these gates.

## Recommended Next Work

### 1. Implement controlled Docker build egress

Registry mediation now lets a nested build resolve and pull its `FROM` image, but network-dependent
Dockerfile `RUN` steps still have no admitted route. The next user-facing slice should connect BuildKit
build traffic to a reviewed, credential-free egress policy while preserving direct-IP, LAN, metadata,
host, and arbitrary-destination denial. Reuse the existing build-egress policy/proxy foundations, but
define a simple product contract for ordinary project Dockerfiles rather than exposing the dormant
`ironcurtain-dockerfiles` implementation mode as an operator configuration matrix. Extend the deterministic
workflow with an allowed package-fetching build, a denied destination, execution of the built image, and
exact cleanup.

### 2. Broader failure injection

Add deterministic prepare/create/load/probe failure cases around the workflow entrypoint and require the
same exact cleanup proof. Keep crash recovery distinct from graceful next-session recovery.

### 3. Durable registry provenance

Persist a bounded host-owned record of authorized registry requests and resolved destinations. Never store authorization headers, tokens, cookies, or unbounded query/body data. Bind the record to the lease, policy/manifest hash, and session metadata; selected-image observations may be included as provenance but are not authority.

### 4. Crash-recovery gate

Graceful next-session recovery passed when the public and offline workflows ran sequentially in one
isolated home. The remaining recovery evidence is an injected coordinator/process death followed by a
second workflow proving watchdog cleanup or startup reconciliation closes the old lease before admission.

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
- `scripts/smoke-nested-apple-workflow.ts` — deterministic public/offline workflow driver and exact cleanup verifier.
- `src/workflow/workflows/nested-docker-live-smoke/` — packaged no-LLM workflow and fixed Python probe.
- `test/workflow/nested-docker-live-smoke.test.ts` — deterministic-first/no-session lifecycle and constant-drift regression.
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
