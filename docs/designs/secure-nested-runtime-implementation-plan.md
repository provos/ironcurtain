# Secure Nested Docker Runtime Implementation Plan

**Date:** 2026-07-19
**Status:** Phase 0A is implemented and self-tested. A later Docker Desktop H3 probe resolved the
earlier inner-procfs stop with a reviewed, sidecar-only mount-mask exception and passed staged image
load, ordinary run/exec, bind and named-volume mounts, offline BuildKit RUN, internal target/scanner
exchange, egress negatives, and exact cleanup. Independent Apple evidence supports guest
prerequisites, a rootless `vfs` daemon, the functional offline matrix, sampled VM-boundary and
publication negatives, resource accounting/peer survival, sparse-disk observation, and scoped
fault cleanup, exact workspace/dependency paths, and a fixed per-file proxy relay with fail-closed
loss. Phase 0F implementation has begun: agent images are CA-neutral, public session trust is staged
at runtime, provider/registry forwarding uses a destination-bound transport with a tested two-MITM
credential cascade and parent-loss failure, and the admitted Apple path now resolves the selected
current agent once, exports one verified Docker-compatible artifact, and threads that resolution through
batch or PTY outer create plus private-Docker load. Historical backend-bound catalogs and all-role
publication tooling have been removed; production startup and qualification use the selected-current
artifact and current-tree tests instead.
This is focused foundation evidence, not nested-runtime qualification. Strict Linux dependency-ABI probes,
current-tree Apple release-suite execution, and the host watchdog state machine now have tested foundations. The host-only bundle lease records pre-create names and
post-create immutable IDs; exact revocation preserves foreign resources. A detached supervisor
survived coordinator exit in a live Docker Desktop check, detected a later state threshold breach,
revoked, produced two empty inventories, removed its exact state, closed the lease, and exited. A
deterministic Compose target/scanner fixture also passes vulnerable/patched verdicts, bounded
readiness and egress negatives, immutable-image checks, and exact cleanup on Docker Desktop. A static scratch-image Desktop relay has a trusted lifecycle
that verifies its stopped and running effective profiles; a live Engine-28 check proved fixed-target
forwarding, uplink-peer exclusion, relay-loss failure, and exact cleanup on an isolated dual-stack
network. The Apple same-VM rootless daemon lifecycle and selected same-agent private-Docker image
bootstrap are implemented. A fail-closed resolved-variant guard admits the exact Apple slice defined
in §12 and the macOS Docker Desktop developer slice: a dedicated rootless daemon sidecar,
selected-current-agent transport, reviewed P2 seccomp and mount-mask exception, bounded aggregate
resources, lease-owned API volume, and—for online modes—one exact TUN device plus isolated fixed relays
to bundle-authenticated host policy engines. Both paths require live runtime-availability preflight.
`npm run smoke:nested:apple` exercises the built Apple CLI session/bootstrap/activation path,
then an exact lease-bound private-Docker child and teardown. The complementary, manually invoked
`npm run smoke:nested:apple:pty` drives the built `start --pty` entrypoint through the same node-pty
bridge as mux and requires a post-activation Claude TUI redraw plus private-Docker evidence and exact
teardown. The public-registry production lifecycle now owns one per-bundle host listener, exact Apple
socket mount, rootless-netns loopback relay, and dockerd-only proxy trust. The
embedded-DNS prerequisite and historical offline product-entrypoint gate passed on the former catalog
path. The replacement selected-current public-registry product-entrypoint gate passed, including the internal-bridge alias, direct
IP/public-DNS negatives, no published ports, and exact teardown. A newer deterministic production
workflow gate passed both public (28 checks) and offline (17 checks) modes without an LLM, with exact
cleanup after each run and graceful second-session admission in one isolated home. These smokes are not
agent-turn/provider, full 0C, or preview qualification. Native Linux, enforced-PID, bounded-disk, and
preview variants remain rejected. No backend is
implementation-qualified or preview-ready.
**Amendment (2026-08-31, Docker Desktop online developer slice):** explicit opt-in on macOS may use
`networkAccess: "images"` or `"packages"` through the independently pinned fixed-relay topology. The
rootless daemon receives only `/dev/net/tun` (no `NET_ADMIN`, `SYS_ADMIN`, privileged mode, host runtime
socket, or direct external network); each relay has one immutable destination, an isolated bundle
address, and a per-bundle proxy credential required by the host policy engine. Effective sidecar and
relay profiles are adjudicated before activation. This is narrowly supported developer functionality,
not formal 0C qualification or preview readiness. It supersedes the offline-only restriction below.
**Amendment (2026-08-25, Docker Desktop offline developer slice):** explicit opt-in on macOS may use
the reviewed H3 sidecar topology before formal 0C/preview qualification. This is narrowly supported,
not qualified: only `networkAccess: "offline"` is admitted, the outer sidecar remains `network=none`,
and the agent receives only the read-only private API volume. Earlier statements that all Docker
Desktop sessions were rejected or that the sidecar was unbuilt are superseded by this amendment.
Native Linux remains fail-closed future work.
**Amendment (2026-07-21, user-approved; image-class disposition superseded by §16.16):** workload-image
registry egress is promoted from Phase 3 into 0F/0C scope. See §6.4, §7.1, and §16.5.
**Amendment (2026-07-21, user-approved):** workload-registry mediation gates request and derived-
redirect authority, not the contents of already-untrusted workload images. Host-side blob hashing
and verify-before-release buffering are removed from the security design. See §6.4 and §16.6.
**Amendment (2026-08-15, threat-model correction):** every image and executable that runs inside the
agent/daemon/descendant authority domain is untrusted bundle code. A frozen catalog, image digest, or
toolchain tuple may support qualification, provenance, cache integrity, and compatibility, but is not a
host-security admission credential. Production instead resolves the selected current agent once and
uses that same per-session artifact for the outer VM and private-daemon transport. The sole image-identity
exception in this design is a separately reviewed service that receives authority unavailable to the
bundle, notably the future Docker Desktop fixed uplink relay. Its image and fixed configuration remain
independently digest-pinned. This amendment supersedes every earlier catalog-as-TCB or
catalog-as-session-admission statement; see §16.16. The runtime migration is implemented in the current
working tree. The replacement public-registry product-entrypoint smoke passed on 2026-08-15, and the
deterministic public/offline workflow gate passed on 2026-08-21. PTY has prior manual coverage and is not
a completion blocker; rerun its narrow transport/composition gate only after PTY-specific changes or a
reported regression.
**Amendment (2026-08-22, governing package-network design):** the next Apple nested-Docker network slice
is governed exclusively by
[`secure-nested-runtime-public-network.md`](./secure-nested-runtime-public-network.md). It supersedes the
future current-Dockerfile hash/path manifest, TLS-MITM build-egress design, and the later generic-public
opaque-CONNECT design everywhere below. The final contract has one `offline | images | packages` Network
access control; conservatively migrates existing public-registry configurations to `images`; makes fresh
settings enablement explicitly persist recommended `packages`; and grants bounded bundle-wide GET/HEAD
authority only for fixed apt, npm, PyPI, and Cargo host/path grammars through a dedicated TLS-terminating
MITM on UDS/`18082`. There is no product generic-public or opaque-CONNECT route. Superseded `public`
narrows to `packages` only at the final admission gate. The generic route must be removed first, and new
package modules remain unreachable until configuration, lifecycle, wrapper, residue, and live acceptance
close atomically. The checked-in redacted
[`CA-injection runc-PATH spike evidence`](./evidence/ca-injection-runc-path-spike.md) is feasibility
evidence; its machine-readable full argv vector is the wrapper-test oracle, and it retains the raw
`passed: false`/later-reconciliation split. It is not qualification. The startup canary loads the immutable
selected image first, then uses exact `--pull=false --network=none --no-cache` and must leave registry and
package ledgers unchanged. Every
older public-network/build-egress statement below is historical and non-normative where it conflicts with
the governing design. Package-network implementation and admission status are recorded in the governing
design and handoff, never inferred from those historical sections.
**Scope:** Docker-capable IronCurtain bundles on macOS Docker Desktop, macOS Apple `container`, and Linux Docker
**Supersedes:** The broker-first design formerly in this file and the runtime recommendation in [`docs/brainstorm/ironcurtain-in-ironcurtain.md`](../brainstorm/ironcurtain-in-ironcurtain.md)

## /goal

Deliver an opt-in real Docker API for untrusted IronCurtain workloads. The agent, its private daemon, and all nested containers are one colluding bundle. The trusted host constrains the bundle as a whole; it does not authorize individual inner Docker operations.

The implementation is complete only when all outcome gates pass:

0. **G0 - staged evidence:** 0A records mutations and exact recovery within two days; 0B falsifies primitives; 0F freezes operational artifacts and defines backend release suites; 0C produces an implementation-qualified candidate for Desktop and Apple independently. Generated reports identify the current checkout and environment, record actual results, and include two cleanup inventories. Mac never proves Linux.
1. **G1 - Docker compatibility:** each concrete variant passes its current-tree backend release suite with zero executable-gate skips, a tested CLI/Buildx/Compose and API range, real `DockerManager`, one resolve-once selected-agent artifact used by outer and inner runtimes, offline workflows, and deterministic Compose target/scanner results. Qualification may pin exact manifests without making them runtime credentials.
2. **G2 - outer boundary:** the daemon sees only exact workspace, private runtime/state, the selected-agent transport artifact, fixed proxy paths, and public trust; no host runtime socket/namespace/cgroup write/device, unrelated path, real credential, or CA private key is present. Artifact contents remain untrusted.
3. **G3 - confined network:** direct public, DNS, LAN, metadata, host, and runtime access fails from agent, daemon, build, and child. DD-PROXY requires Engine 28 isolated IPv4/IPv6 and one trusted byte relay to the exact outer MITM. Relay loss fails closed; nested ports are not host-reachable.
4. **G4 - bounded privilege:** Desktop/Linux rootless Docker stays inside the frozen P0-P4 subset and immutable sidecar cgroup, without outer privilege, sensitive host surfaces, or broad/unconfined profiles. Apple rootful is eligible only inside a proven disposable per-session VM. ECI/Sysbox qualifies only its named environment.
5. **G5 - non-provisioning:** no real provider/OAuth/MCP/SSH/registry credential or host CA key enters the bundle. Supported bootstrap may use two fake-key MITMs, but colluders may use the outer fake key/proxy directly; only outer-MITM egress is authoritative.
6. **G6 - resources:** proven Desktop/Linux outer cgroups enforce aggregate CPU, memory, and required PIDs. Apple hypervisor CPU/memory and exact deletion are authoritative; guest PIDs are advisory. Hard disk claims require enforcement; observed-disk preview requires the pre-daemon host watchdog. Frozen watchdog state thresholds pass.
7. **G7 - teardown:** normal and injected-failure teardown kills descendants, removes API/relay/runtime/ephemeral state, preserves foreign/live resources, stops heartbeat, and yields two empty host inventories without trusting inner Docker.
8. **G8 - unchanged provisioned authority:** disabled sessions receive no IronCurtain-provisioned daemon, API/state, mount, privilege/profile change, relay, or outer resource. Static tooling and self-launched processes inside the unchanged disposable VM envelope are not provisioned authority.
9. **G9 - independent proofs:** each advertised Desktop, Apple, and Linux variant reruns its backend release suite and G1-G10 through its actual CLI/UI/session entrypoint before preview. No platform or rootless/rootful result proves another.
10. **G10 - fail closed:** release-suite, product-acceptance, selected-artifact transport, effective profile, toolchain compatibility, authority-bearing relay identity/configuration, watchdog, limit, or cleanup failure is a terminal compatibility blocker. Clearing it requires fixing the implementation or an explicit reviewed design change followed by a full rerun; no unsafe or broker fallback exists. Qualification-manifest drift alone never authorizes or denies a production session.

Later features do not count toward these gates unless explicitly promoted into scope. See `docs/designs/secure-nested-runtime-implementation-plan.md` for details.

## 1. Decision and feasibility assessment

### 1.1 Decision

Docker is an opt-in **bundle capability**, not a semantic host-broker API.

A Docker-enabled bundle includes:

- the untrusted agent and edited checkout;
- a bundle-private Docker daemon;
- every image, build step, network, volume, container, and process created through that daemon;
- inner IronCurtain proxies, MCP servers, target applications, and scanners.

These components may collude completely. The host enforces the outer envelope: mounts, outer network paths, credentials, staged image ingress, aggregate resources, lifetime, and cleanup. Inside the envelope the workload gets ordinary Docker semantics. Inner Docker events, labels, lineage, inventory, and per-container limits are useful diagnostics but are not security evidence.

The earlier semantic broker is removed from the critical path. It may return later as an optional stronger capability for workloads that require host approval of every container operation. It is the wrong default for general Docker workloads because it cannot faithfully support Docker development, arbitrary Compose-style topologies, or the existing daemon-facing integration suite without recreating much of Docker's API and lifecycle.

### 1.2 What this enables

- Run IronCurtain's real Docker integration tests from an IronCurtain session.
- Exercise edited `DockerManager`, `docker-infrastructure.ts`, image build/load, network allocation, lifecycle, and integration behavior rather than a substitute runtime contract.
- Launch a deliberately vulnerable target and one or more scanners on an inner-only Docker network.
- Build hermetic workspace Dockerfiles offline from preloaded bases today; after the governing package-
  network slice passes its stop-gate and acceptance, build ordinary project Dockerfiles through fixed
  public package repository grammars without presenting source identity as host authority.
- Use normal Docker tooling, including Compose-compatible clients where their required images are staged.
- Pull public workload images from reviewed registries by digest or tag through the mediated registry-egress path (§6.4) when the session enables `public-registry` ingress; infrastructure images are never pulled.
- Keep the host runtime API and host credentials outside the untrusted bundle.

### 1.3 Accepted tradeoff

The user accepts the existing outer container or lightweight-VM boundary as the primary isolation boundary. A nested daemon does not introduce a second trusted boundary inside it.

Rootless Docker still exercises more kernel and runtime surface than a normal IronCurtain agent: user namespaces, mount namespaces, nested `runc`, filesystem drivers, Dockerfile parsing, and additional syscalls. The daemon sidecar may need a less restrictive seccomp/mount profile than the ordinary agent. This is a real increase in attack opportunity, even though a successful escape still targets the same Docker-host or VM boundary already trusted for ordinary IronCurtain containers. The plan accepts that tradeoff for Docker functionality, isolates profile changes to the daemon component, measures the exact delta, and never describes rootless mode as a sandbox from the rest of the bundle.

## 2. ADR: revisit rootless DinD without accepting privileged DinD

### 2.1 Why the earlier rejection was too broad

The broker design tried to make the host authorize every descendant operation. That was stronger than the accepted threat model and removed the very capability being requested: a general Docker daemon controlled by the untrusted workload.

The revised question is narrower: can a private daemon run _inside the already accepted outer boundary_ while the host constrains the bundle as a whole? Rootless Docker is a strong candidate for that job and must be tested before building a broker.

### 2.2 Why the stock recipe is still not acceptable

Docker's documented `docker:dind-rootless` example still starts the outer container with `--privileged`; Docker states this is needed to disable seccomp, AppArmor, and mount masks. That recipe is not an acceptable Linux or Docker Desktop production topology. On Docker Desktop, a privileged outer container can gain broad authority inside the shared Linux VM unless a separately licensed and proven stronger isolation feature is present. The base product must not depend on that.

Therefore:

- do not treat the name `dind-rootless` as proof of a safe outer profile;
- build a purpose-specific daemon image and begin with the normal outer restrictions;
- permit only narrow, recorded changes shown necessary by the spike;
- do not add `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, host namespaces, `seccomp=unconfined`, `apparmor=unconfined`, or outer `--privileged`; `systempaths=unconfined` is permitted only by the version-scoped, reviewed nested-daemon-sidecar exception recorded in §9.3 and remains forbidden for the agent container;
- if a bounded non-privileged daemon cannot start, Docker Desktop support is infeasible under this topology and fails closed.

Apple `container` is different: each outer workload has a dedicated lightweight VM. Rootful Docker inside that VM may be acceptable because it controls the disposable bundle VM rather than a shared host kernel. That is a separately named and separately proven topology, not a fallback that weakens Docker Desktop or Linux.

### 2.3 Finite Desktop/Linux profile ceiling

Profile discovery is cumulative, finite, and reruns in a fresh bundle at every level:

| Level         | Only permitted addition                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 STRICT     | Existing hardened outer defaults, `cap-drop=ALL`, no devices, default enforcing LSM/seccomp/mount masks                                                                                                                         |
| P1 ID-MAP     | Exact subordinate UID/GID files and id-mapping helpers, `NoNewPrivs=false`, and only outer `SETUID`/`SETGID` for rootless ID mapping (see §16.10: on Apple the helpers must carry file capabilities and **not** the setuid bit) |
| P2 SECCOMP    | One deny-by-default, hash-pinned seccomp artifact adding only denial-proven namespace/OCI-lifecycle syscalls                                                                                                                    |
| P3 APPARMOR   | One named enforcing, hash-pinned AppArmor artifact adding only denial-proven user/mount-namespace and exact private-path rules                                                                                                  |
| P4 MOUNT-MASK | One finite exact mount-mask manifest for bundle-private `/run`/data and enumerated nonsensitive guest proc/sys entries                                                                                                          |

Eligible needs are limited to subordinate IDs, nested user/mount namespaces, rootless `runc` mounts within the sidecar, exact bundle-private runtime/data paths, and enumerated guest proc/sys entries. Every level includes all prior levels, preserves denial evidence, reruns every boundary/network/resource/cleanup negative, and yields the complete frozen tuple defined below. Linux qualifies its own tuple; Desktop evidence cannot be reused.

Checked-in `profile-ceiling.json` is the only source of P2/P3/P4 additions. It enumerates every syscall, AppArmor rule/private path, and mount-mask/proc/sys entry with captured denial ID, namespace interpretation, reviewer disposition, and version scope. Generated artifacts must be subsets; every proc/sys entry must be proven namespaced to the sidecar and unable to affect host-global state. Any edit invalidates all later evidence and restarts at P0. Qualification freezes the architecture, outer runtime/Engine, kernel, LSM, daemon image, RootlessKit/network driver, subordinate-ID inputs, expanded create arguments, ceiling manifest, and generated artifact hashes.

Stop at the first request for outer `--privileged`; host namespaces/socket/cgroup writes/devices/FUSE/KVM/GPU/block devices; `SYS_ADMIN`, `NET_ADMIN`, `BPF`, `PERFMON`, `SYS_MODULE`, `SYS_RAWIO`, or `SYS_BOOT`; broad/unconfined/complain/system-path profiles; sensitive proc/sys/security/debug paths; direct/default/host networking or a new host bind. Also stop if P4 fails, a second artifact is needed in a category, an addition falls outside the eligible list, or any earlier negative regresses.

Docker Desktop ECI and Sysbox may be tested only as optional administrator-provided environments. Evidence obtained with ECI qualifies `desktop-eci`, not baseline Desktop, and neither mechanism permits privileged or host-socket fallback.

## 3. Threat and authority model

### 3.1 Trusted components

- Host IronCurtain coordinator, policy/escalation layer, audit writer, and credential store.
- Outer MITM and any trusted image-ingress service.
- DD-PROXY relay binary, hash-pinned configuration, and coordinator-resolved exact outer-MITM endpoint; arbitrary relay compromise breaks G3.
- Host resource watchdog/supervisor and its frozen measurement/kill configuration.
- Host selected-agent resolver/transport coordinator and trusted resolved session configuration. The
  coordinator's path, mount, and lifecycle decisions are trusted; the selected image bytes are not.
- Docker Engine/Docker Desktop as the outer runtime, or Apple `container` and its per-container VM boundary.
- Host-side bundle ownership, resource, effective-profile, and teardown observations.

The host kernel/runtime and host administrator remain outside the adversary model, as they are for an ordinary IronCurtain container.

### 3.2 Untrusted components and inputs

- Agent, inner IronCurtain process, edited source, dependencies, and workspace content.
- Rootless or rootful bundle daemon and its API socket.
- Docker/Compose requests, Dockerfiles, build contexts, images, layers, archives, labels, logs, events, volumes, and networks.
- All nested containers, including targets, scanners, MCP servers, and agents.
- All data received from providers, registries, package services, and target applications.

### 3.3 Authority and evidence split

| Subject     | Host-authoritative claim                                                                                                                                       | Bundle-local/advisory only                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Mounts      | Exact outer mounts exposed to daemon/VM                                                                                                                        | Which bundle-visible paths an inner container mounts                  |
| Network     | Outer interfaces, fixed proxy endpoints, and absence of host port publication                                                                                  | Inner bridges, addresses, ports, and container attribution            |
| Images      | Exact digest/config of a separately authority-bearing service such as the future DD relay; host observation of the selected bundle artifact is provenance only | All agent/base/daemon/helper/workload contents, identity, and lineage |
| Credentials | Which public CA/fake sentinels were provisioned; no real secret provisioned                                                                                    | Secret data the colluding workload creates or shares itself           |
| Resources   | Desktop/Linux outer-cgroup CPU/memory/PIDs after proof; Apple hypervisor CPU/memory; proven hard disk; exact outer deletion                                    | Apple guest PIDs, all inner limits/metrics, observed-only disk        |
| Lifecycle   | Exact outer component IDs, state roots, and their deletion                                                                                                     | Completeness or honesty of inner `docker ps`, events, and labels      |
| Audit       | Capability enablement, host lifecycle, ingress, proxy egress, effective profiles                                                                               | Per-Docker-operation actor attribution                                |

The design does not claim isolation between the agent, daemon, target, scanner, or descendant agents. A nested `--privileged` container may take over the bundle's daemon namespace or Apple VM; the required property is that this does not expand the outer envelope.

## 4. Target architecture

### 4.1 Common bundle

```text
trusted host
  IronCurtain coordinator
  credentials + outer MITM
  optional image-ingress service
  outer runtime and aggregate limits
          |
          v
  untrusted Docker-enabled bundle
    agent / inner IronCurtain
        DOCKER_HOST -> bundle-private Docker API
    bundle-private Docker daemon
        exact /workspace
        API /run/ironcurtain-docker
        exchange /run/ironcurtain-nested
        ephemeral daemon data
        staged OCI archives
        fixed proxy path only
    nested targets, scanners, agents, builds, networks
```

Docker capability is fixed when the session is created. The agent cannot attach it to a running normal session. The daemon sees only sources deliberately placed in its outer mount namespace or VM; therefore an inner request such as `-v /:/host` resolves to the daemon component's root, not macOS or the native Linux host.

After admission, the agent receives the bundle-local managed-network name through
`IRONCURTAIN_DOCKER_NETWORK` and a shared adapter prompt section. Every nested service and sibling
client attaches to that network and uses Docker's embedded DNS by container name or alias. The
nested daemon has no default bridge; `-p`/`--publish`, `--network host`, and `localhost` are not paths
from an inner service to the Mac or the agent shell. The prompt provides a short two-container
recipe plus an external-default Compose declaration and is absent from ordinary sessions or failed
admissions. This is a supported service topology, not a security boundary, because the agent retains
Docker administrator authority over the bundle-local daemon. Adapter-specific orientation may add
surrounding tool guidance, but Claude Code, Codex, and Goose consume this single capability-gated
network contract. Codex PTY injects it through the CLI's `developer_instructions` config key; batch
mode and the other adapters retain their existing prompt transport.

### 4.2 Linux Docker: rootless daemon sidecar

The trusted coordinator creates two bundle-owned sibling containers:

1. the normal hardened agent container; and
2. a purpose-built rootless Docker daemon sidecar.

They share only:

- the exact workspace at an identical guest path, initially `/workspace`;
- a bundle-private Docker API root at `/run/ironcurtain-docker`, initialized by trusted bootstrap, mounted read-write in the daemon and read-only in the agent after `docker.sock` exists;
- a separate writable exchange root at `/run/ironcurtain-nested` for inner Code/MITM sockets and other bundle-colluding IPC;
- explicitly staged OCI archives and public CA material;
- no daemon data state: that is private to the sidecar.

The agent receives `DOCKER_HOST=unix:///run/ironcurtain-docker/docker.sock`. The API-root handoff must prove that a read-only directory mount permits connection without permitting unlink/rebind; if a platform cannot prove this, socket identity is advisory and bundle-local spoofing is explicitly accepted because every process is already one colluding authority domain. Proxy late creation occurs only in the separate writable exchange root.

The sidecar's outer network is `none`. Fixed outer proxy sockets may be mounted into its exchange path. RootlessKit and the nested daemon may create inner bridge networks, but their parent namespace has no external route. Begin with the `vfs` storage driver to avoid `/dev/fuse`; faster storage drivers require their own evidence.

Native Linux remains unproved until Phase 2-LX runs on a real Linux host. Docker Desktop evidence must not be reused as its security gate.

### 4.3 macOS Docker Desktop: rootless daemon sidecar

Use the same sibling-sidecar and identical-path model. Docker named volumes inside the Desktop VM carry the API and exchange roots; do not rely on macOS VirtioFS to carry daemon sockets.

Qualification has two explicit topologies:

- **DD-STRICT:** agent and daemon use top-level `network=none`. It proves rootless boot, API/path/image/build/internal-network/resource/cleanup primitives without a provider path.
- **DD-PROXY:** only after DD-STRICT passes, attach agent/daemon and one trusted fixed relay to a dedicated outer network. Baseline preflight requires Docker Engine 28+ and verified `--internal` with both `com.docker.network.bridge.gateway_mode_ipv4=isolated` and `gateway_mode_ipv6=isolated`. Absence is a compatibility blocker. Any future alternative network boundary is a separately designed and named backend, never a DD-PROXY fallback. Fully expanded create arguments and effective network inspect are evidence.

DD-PROXY has no bridge gateway address, default bridge, host gateway route, or host publication. The relay exposes only the fixed outer HTTP proxy service. After attaching it, rerun separate DNS, direct-connect, gateway, `host.docker.internal`, IPv4, IPv6, LAN, metadata, runtime, and unrelated-service negatives from agent, daemon, build, and nested children; a pre-attach pass is not evidence for the proxy topology.

The relay is trusted network TCB: arbitrary compromise breaks G3. It is a purpose-built digest-pinned static/minimal binary (no shell where feasible), nonroot, `cap-drop=ALL`, `no-new-privileges`, read-only root, bounded tmpfs/resources/connections/bytes/time, and no workspace, Docker API/state, credentials, or unrelated mount. It only byte-forwards to the coordinator-resolved exact outer-MITM IP:port; the outer MITM enforces CONNECT, destinations, redirects, and request policy. The relay performs no client DNS or arbitrary target selection and emits metadata-only logs. Its CPU, memory, PIDs, file descriptors, connections, bytes, and time are charged within the bundle total and a fixed trusted-infrastructure reserve, with cgroup/accounting evidence. Binary/config/endpoint hashes and full inspect enter evidence. Configuration mutation, malformed/exhaustion input, death, or failed health revokes the path.

UI, session metadata, audit, and user documentation state: **Docker Desktop bundles share one Linux VM and kernel with other Desktop containers and sessions. The nested-daemon profile increases attack opportunity against that shared guest and may increase cross-session/container data exposure if the outer container boundary fails; Apple instead uses a per-session VM.** On a Mac running concurrent mutually untrusted sessions, `auto` prefers Apple when qualified; an explicit backend choice is never overridden.

A nested `-p` may bind inside the daemon sidecar's namespace. It must not create a Docker Desktop host publication. A future host service-export capability would require a separate policy and design.

Docker Desktop Enhanced Container Isolation or Sysbox is an optional administrator environment only; evidence is labeled `desktop-eci`/`desktop-sysbox` and never qualifies baseline or excuses outer `--privileged`.

### 4.4 macOS Apple `container`: Docker inside one VM

Apple assigns each outer container its own lightweight VM. Run Docker inside the agent's existing per-session VM; a sibling Apple container would be a different VM and would complicate path, socket, and lifecycle sharing.

**Variant 1 is the implemented topology** (decided 2026-07-29; see §16.10 for the live evidence and its
consequences). The daemon is bootstrapped inside the agent's own VM from a toolchain staged by the agent
base image, and the Docker API is a VM-local UDS that is never published to the host.

Try in order:

1. rootless Docker inside the OCI workload;
2. rootful Docker inside the OCI workload with the smallest measured VM-scoped capability set;
3. a version-pinned custom-init probe, only if OCI mount masking prevents variant 2: establish measured VM prerequisites first, start the release-matched `vminitd`, then start the workload/daemon supervisor after approved mounts exist. A long-lived init daemon is eligible only after control/API readiness, signal forwarding, mount ordering, and teardown behavior are proven; the exact ordering remains a probe result, not an assumption.

Variants 2 and 3 are eligible only if evidence proves:

- Docker authority terminates at one disposable bundle VM;
- the VM has `--network none` and only approved per-file UDS/vsock proxy relays;
- the Docker API is VM-local and unreachable from macOS or another VM;
- no Docker Desktop or Apple control socket, host device, broad host directory, or credential is present;
- only the exact VirtioFS workspace and staged artifacts are visible;
- destroying the Apple container/VM kills the daemon and descendants and removes bundle state.

This topology must be presented to users as **rootful Docker isolated by a per-session VM**, not as rootless or ordinary container isolation.

For the Apple provider path, the coordinator starts one fixed host UDS beneath a mode-`0700`
per-session directory and mounts that exact socket file into the VM read-only. Apple Containerization
recognizes the socket inode and converts the mount into a host-listens/guest-connects vsock relay.
The relayed guest socket is mode `0666` so subordinate UIDs created by rootless Docker can connect;
this grants the already-colluding bundle access to one fixed endpoint while the private host parent
prevents unrelated local principals from traversing to it. `--publish-socket` is forbidden for this
path because it implements the opposite guest-listens/host-connects direction. `--ssh` remains
false, and neither a broad socket directory nor host network is exposed.

## 5. Filesystem, Docker API, and workspace model

### 5.1 Path equivalence

Docker bind sources are resolved in the daemon's namespace. The agent and daemon must therefore see every allowed bind source at the same normalized guest path. At minimum:

- the outer repository is `/workspace` in both;
- the Docker API is beneath `/run/ironcurtain-docker` and exchange/session sockets are beneath `/run/ironcurtain-nested` in both;
- staged images are beneath one read-only artifact root in both.

Inner IronCurtain bootstrap must force its workspace beneath `/workspace`; the default `~/.ironcurtain/sessions/.../sandbox` would otherwise be private to the agent and unmountable by the sidecar daemon.

macOS `node_modules` must never be consumed or modified from Linux. Use an ABI-keyed Linux dependency volume or image layer mounted over `/workspace/node_modules`, with a manifest that records architecture, Node ABI, lockfile digest, and package-manager version. Missing or mismatched dependencies fail rather than falling back to the host tree.

### 5.2 Mount semantics

The host constrains outer mounts. Inner Docker may mount arbitrary paths that exist inside the daemon namespace/VM. This is intentional and supports real Docker behavior. The security assertion is not “the host approves every inner path”; it is “no inner path can name host content that the daemon was not given.”

Symlink/race tests must prove that mutating workspace paths cannot cause the outer runtime to add a new host mount after bundle creation. Ordinary inner path races are within the untrusted bundle.

### 5.3 API endpoint

- UDS only for Linux and Docker Desktop; no TCP Docker API. The API and writable exchange roots are never the same mount.
- Apple may use a VM-local UDS or loopback TCP only if custom-init constraints require it; never publish it outside the VM.
- Socket/runtime roots are unique per bundle, mode-checked, and removed at teardown. On supported platforms the API root becomes agent-read-only after daemon socket creation; failure to prove anti-rebind semantics downgrades socket identity to advisory bundle-local evidence rather than inventing caller authentication.
- No host Docker, Podman, containerd, or Apple service socket is ever mounted.

## 6. Network, proxy, and credentials

### 6.1 Network rule

Inner Docker networks are allowed because target/server/scanner cooperation is a primary use case. Their maximum reachability is bounded by the daemon sidecar's outer namespace or Apple VM.

Every platform must prove negative reachability from four locations:

1. agent;
2. daemon process;
3. Docker build step;
4. nested container, including `--network host` and `--privileged` attempts.

Probe direct public IPv4/IPv6, public and attacker-chosen DNS, RFC1918/LAN, cloud metadata, Docker Desktop/host gateway aliases, host loopback services, runtime APIs, and unrelated bundle endpoints. Fixed proxy traffic is tested separately so an accidental direct route cannot masquerade as success.

### 6.2 Provider credential cascade

Provider base URLs remain their normal origins. Do not point SDK base URLs at a MITM-specific origin.

```text
nested agent uses inner fake key
  -> inner MITM substitutes outer fake key
    -> destination-bound parent proxy preserves provider origin
      -> outer MITM substitutes real host credential
        -> provider
```

The inner bundle receives only fake sentinels and the public outer CA certificate. The CA private key and real provider/OAuth/MCP/SSH/registry credentials remain trusted-host material. The two-MITM cascade is the supported bootstrap path, not an enforceable traversal claim: the colluding agent/daemon/descendants can share and use the outer fake key and fixed outer proxy directly. Only the outer MITM is authoritative for aggregate provider egress/accounting. The bundle may deliberately exfiltrate secrets it obtains independently; credential non-provisioning is the claim, not magical non-circumvention.

`mitm-proxy.ts` and `registry-proxy.ts` now route provider, registry, and HTTP(S) passthrough requests
through a destination-bound `OutboundTransport`. Public-only mode rejects loopback, link-local, metadata,
LAN, private DNS answers, mixed public/private rebinding answers, absolute-form caller paths, and
proxy credentials. A separate trusted-provider policy admits a host-configured loopback/RFC1918/ULA
provider gateway such as LiteLLM while still rejecting metadata/link-local destinations; agent-selected
passthrough, redirects, build egress, and registry egress cannot select that policy. Nested mode targets one fixed parent UDS/TCP endpoint, preserves provider
Host/SNI, and exposes no caller-selected CONNECT operation. HTTPS passthrough is inner-MITM'd and
re-originated through that transport; nested WSS passthrough is explicitly unsupported. A hermetic
test proves inner-sentinel -> outer-sentinel -> real-credential substitution and proves that outer
proxy loss returns 502 without direct fallback. This is foundation evidence, not backend
qualification.

### 6.3 Build-egress split

This section records retired design history. The current-Dockerfile source/hash profile and its listener
are deleted. The governing package-network design permits only fixed apt, npm, PyPI, and Cargo GET/HEAD
grammars in `packages`; `offline` and `images` have no package listener. It explicitly does not provide
generic public HTTP, opaque CONNECT, or a build-only identity claim.

### 6.4 Workload-image registry egress (promoted from Phase 3)

Agent, base, daemon, helper, the in-VM fixed-profile byte relay, and workload images are all **untrusted bundle code**. The
bundle can already execute arbitrary workspace code, become root inside its disposable Apple VM, replace
bundle-local executables, build/import arbitrary images, and call every fixed endpoint deliberately
mounted into its authority domain. Pinning those bytes cannot reduce the host authority granted to the
bundle. Production resolves the selected current agent once and transports that exact per-session
artifact into the private daemon for compatibility; §7.1 defines the transport without treating its
identity as an admission credential.

A service image is trusted only when the host gives it authority that ordinary bundle code cannot use.
The future Docker Desktop fixed relay is the present design example: it alone attaches to the uplink
network, so arbitrary relay-image substitution would break G3. That relay uses a dedicated reviewed
digest and fixed configuration, independent of any bundle-image qualification catalog. The current Apple
loopback relay is not such an exception: the colluding bundle can already use the exact mounted
registry UDS, while the host listener and its policy remain authoritative.

When `imageIngress: public-registry` is enabled, the nested daemon receives proxy environment plus the session public CA and reaches only the fixed proxy path; there is still no direct registry route. The outer MITM adds a registry-aware handler frozen by `registry-egress-manifest.json`:

On Apple, the host listener lives under the bundle's 0700 runtime root and only its exact UDS is
mounted at the fixed guest `/tmp/ironcurtain-registry-egress.sock` target; a fixed loopback relay runs
inside rootlesskit's network namespace while the VM remains `network=none`. Guest path identity is
advisory within the colluding bundle—the authority is the immutable host listener plus exact Apple
source/target mount. Live qualification must record that mount pair from trusted outer inspect.
Inner containers and build steps do not automatically inherit dockerd's proxy environment, but the
colluding bundle may explicitly join the daemon's host network and reuse the loopback relay. That
delegates only the same frozen registry listener, not any broader egress authority.

- client-initiated requests may target only reviewed registry and token-service origins (e.g. `registry-1.docker.io`, `auth.docker.io`, `ghcr.io`); client-selected registry, token, or CDN hosts fail closed;
- IronCurtain injects no registry credential and configures no private registry; credentialed/private-registry support remains Phase 3. The normal anonymous `401`→token→retry dance is performed **client-side** by the bundle (the proxy performs no token dance of its own). The proxy admits a single syntactically valid `Bearer` token only on a client-initiated request to a listed registry/token origin and always strips it from derived redirects; it cannot prove that a token independently supplied by a malicious bundle was anonymously issued, so anonymous provenance is not a security claim;
- pull-by-digest is preferred; tag and digest references and any registry-reported or optionally computed manifest digest are recorded as audit provenance, not host attestation;
- the trusted proxy may follow an unlisted CDN URL only when that exact `Location` is the immediate response to an authorized manifest/blob request. The derived request preserves `GET`/`HEAD`, stays on HTTPS, passes destination-bound public-address/SSRF checks, has finite hops, and carries no authorization, cookie, client-selected host, or other credential-bearing header. The bundle cannot directly select or reuse the CDN destination;
- bodies stream with normal backpressure under per-request and per-session byte, absolute-time, and concurrency ceilings. No trusted blob buffer, spool, or content hash is required; interrupted transfers and ceiling failures fail closed and are audited;
- push, delete, catalog/tag enumeration, and all non-pull registry operations are rejected;
- fetched image references and final destinations are recorded as provenance but remain untrusted bundle state — mediated request authority and provenance are the claims, not content integrity or trust.

The current production vertical slice implements the authority path but does not yet attach a durable
host provenance sink to successful pulls. That persistence is a remaining pre-preview gate; until it
lands, qualification may claim the mediated request/redirect controls above but not durable pull
provenance evidence.

Hashing bundle-image artifacts is transport-integrity and qualification machinery, not a
workload-registry or host-isolation control: the bundle can already build or import arbitrary bytes, a
registry can choose a malicious manifest and matching blobs, and malformed or substituted bundle bytes
cannot expand the outer envelope. Docker may perform its normal digest validation, and the host may hash
the selected archive to detect corruption or a resolve/load race, but neither result makes the bytes
trusted. Qualification manifests may pin exact inputs for repeatability; they are observations and must
not gate ordinary session admission. The dedicated authority-bearing relay digest remains mandatory.

`public-registry` is the product default once `dockerWorkload.enabled` is true. This is still only the
fixed mediated Docker Hub/GHCR path above, not generic network access. Deterministic qualification,
offline, and PTY-only gates set `imageIngress: preloaded-only` explicitly everywhere except dedicated
registry-path gates, so backend evidence never silently depends on live registry availability. The
registry-aware handler joins the trusted network TCB and therefore requires its own frozen manifest,
hermetic protocol fixtures, and 0C negatives before any preview.

## 7. Images, builds, and target/scanner workflows

### 7.1 Bundle-image resolution, transport, and qualification

Production uses a **selected-current-agent resolve-once contract**:

1. Resolve or build the operator-selected current agent through the ordinary host image path before
   creating any workload resource.
2. Capture one immutable per-session identity and one Docker-compatible archive/cache entry for that
   resolution. Use that same resolution for the outer Apple VM and for loading the same-agent image into
   the VM-private Docker daemon. A tag changing between these two uses is a compatibility/TOCTOU failure;
   retry from a fresh resolution or fail before agent release.
3. Place only the selected archive beneath the lease's private read-only staging root. Hash and verify it
   as needed to detect corruption, unsafe archive structure, or a mismatched load; retire the large
   staging link before agent release. Those checks protect host tooling and reliable transport. They do
   not attest the code that runs inside the colluding bundle.
4. Record the observed outer/inner identities, tool versions, platform, and archive digest as bounded
   diagnostic provenance. An ephemeral Docker-workload session has no catalog-generation resume
   credential.

The production start path does not depend on a global frozen generation, an eight-role publication, or
an operator refreeze. Base layers travel in the selected agent archive. The former standalone base,
helper, and catalog `socat` staging roles are deleted. The purpose-built nested-daemon source is retained
only for the future Docker Desktop/Linux sidecar topology; it is not an Apple production input. Workload
images continue to arrive through registry egress (§6.4), explicit archive staging, or bundle-local builds
and remain untrusted.

Qualification uses the hardened OCI/Docker archive verifier, selected-identity consistency checks,
current-tree backend suites, and the CLI/daemon/API compatibility matrix directly. None is an installed
credential, lease binding, or product-start gate. Target, patched-target, and scanner images remain pinned
qualification fixtures. If DD-PROXY is
implemented, its fixed relay has a separate reviewed artifact digest/configuration because that service,
unlike bundle images, owns uplink authority.

**Migration status (2026-08-15):** the checked-in runtime uses selected-current-agent artifact transport;
new leases omit catalog/toolchain authority bindings, and batch/PTY session setup consumes the prepared
resolution rather than a frozen generation. Tolerant version-1 lease parsing remains solely so old leases
can be reconciled and removed. The earlier catalog resolver, canonical archive, and generation-v3 results
are retained in Git history, not as product-start inputs. The replacement public-registry
product-entrypoint smoke passed on 2026-08-15 as session
`a4208f3a-cd33-45bd-a4ec-b9e560acd176` with outer VM
`ic-dw-agent-6e38b54379de4a49`; post-run inventory proved exact outer cleanup and no retained temporary
capture alias.

Inside the bundle the workload may freely:

- build explicitly hermetic workspace Dockerfiles from preloaded bases, or current IronCurtain Dockerfiles only when the narrow 0F egress profile is enabled;
- load, tag, commit, export, remove, and inspect images;
- create volumes and networks;
- run Compose-style multi-container applications;
- start a target, wait for readiness, run a scanner, and retain reports in `/workspace`.

Locally built images are not host-trusted or immutable; they are untrusted bundle state.

The repository's current Dockerfiles execute apt/curl/npm and related fetches. A warm cache is not evidence that they are offline; fail fast if their narrow egress profile is disabled.

### 7.2 Host-mediated OCI ingress

Anonymous public-registry pulls for workload images were promoted into 0F/0C scope by §16.5 and are specified in §6.4. Phase 3 now covers what §6.4 excludes: credentialed and private-registry ingress.

A later host service accepts registry, repository, and preferably digest; applies host policy/escalation; fetches with trusted network code; records resolved digest and provenance; and creates a sealed bundle artifact for `docker load`. Mutable tags may be accepted only if product policy explicitly permits them and the resolved digest is recorded.

Registry credentials never enter the bundle. Persistent shared image caches are deferred because they create cross-bundle state and poisoning questions. Daemon state is ephemeral per bundle initially.

### 7.3 Acceptance workflow

The deterministic vertical fixture uses pinned target and scanner digests, an explicit readiness contract, and a new inner-only network. The scanner exits with a specified code and writes a versioned JSON report at a fixed `/workspace` path containing a stable finding ID. Qualification requires the expected finding, then four negatives: patched target yields no finding, unready target times out boundedly, malformed scanner output is rejected, and direct egress remains denied. Teardown removes the fixture stack while an unrelated inner container and an unrelated outer-runtime object survive. A second positive run builds the target locally from a pinned offline base before scanning it. The fixture stages its pinned images as sealed archives; it never depends on live registry egress.

## 8. Resources, lifecycle, and audit

### 8.1 Resource envelope

Expose one configured bundle budget with a coordinator-chosen reserve rather than asking the untrusted client to partition authority. On Desktop/Linux, statically partition CPU, memory, and PIDs across the outer agent, private daemon, ordinary macOS session transport, and every enabled fixed relay so their sum cannot exceed the bundle total. Qualification must prove every dockerd, BuildKit, shim, build, and child process remains under an immutable outer sidecar cgroup ancestor; probe inner `--cgroup-parent`, host cgroup namespace, delegation, migration, and direct cgroup writes. Any process observed outside the subtree, successful migration, or writable parent/ancestor cgroup is an immediate compatibility blocker. Inner delegation may reduce inner Docker semantics but never weaken the outer ceiling.

| Backend               | CPU                           | Memory                        | PIDs                                        | Disk                                                                 |
| --------------------- | ----------------------------- | ----------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Desktop/Linux sidecar | outer cgroup after proof      | outer cgroup after proof      | outer cgroup after ancestry/migration proof | hard quota if claimed; otherwise preview-observed policy only        |
| Apple per-session VM  | hypervisor after stress proof | hypervisor after stress proof | `unsupported`/advisory inside VM            | hard VM/state cap if claimed; otherwise preview-observed policy only |

Apple fork pressure is bundle availability/recovery, not host PID security. Bounded tests prove host and an unrelated VM remain responsive, VM memory stays bounded, timeout triggers exact VM deletion, and bundle heartbeat/API/relay cease. A policy requiring hard PID enforcement rejects Apple. No inner cgroup, daemon metric, or limit upgrades an authoritative status.

For any `vfs` or `disk=observed` candidate, the host watchdog/supervisor starts and proves healthy before daemon sidecar or Apple VM creation. It survives coordinator death and startup-reconciles its host-only lease; teardown stops it only after exact state removal and two empty inventories. Loss, stale sample, measurement error, target identity/scope change, or supervisor error fails closed and revokes/deletes in the frozen order.

0F freezes the measurement target and scope, included state classes, sampling interval, soft evidence threshold, hard safety threshold, host-reserve floor, maximum overshoot, stale timeout, error behavior, and stop/kill/delete order. The bundle cannot mount or mutate any of them. Bounded tests prove coverage of every state class, sampling/kill latency, and overshoot without crossing host reserve. If bounded coverage is unavailable, observed-disk preview is prohibited. The watchdog remains explicitly not a hard quota.

**Withdrawn (2026-07-30, see §16.11):** this section previously required freezing a checked-in
`performance-budget.json` of duration and state-growth ceilings before 0C, hash-bound into release
bookkeeping, the lease, and the evidence manifest. Timeouts and CI durations are not a
security property, and hash-binding them protects against nobody under a trusted single-operator
host. The state ceilings that _are_ enforcement — peak owned state, host reserve, retained state
after teardown — live in the frozen `resource-watchdog-policy.json` and are unaffected. Timeouts are
now ordinary reviewed constants; a `vfs` variant that runs unacceptably slowly remains a review
judgement, not a gate.

### 8.2 Startup

1. Create a host-owned bundle lease never mounted into the bundle. Before each outer create, durably ledger the requested random name/identity, generation, exact workspace, budgets, API/exchange roots, staged artifacts, and state target; immediately after create, append the runtime-returned immutable ID before proceeding.
2. Start outer MITM and fixed proxy transport.
3. Start and attest the host watchdog against the exact state target, scope, thresholds, reserve, and expected identity. Failure aborts admission; later loss invokes the frozen revoke/delete order.
4. Only after watchdog health is proven, create/start the daemon sidecar or Apple VM and bootstrap its in-VM daemon.
5. Verify effective outer profile, API-root handoff/socket mode, exchange-root path equivalence, `docker info`, storage driver, outer network confinement, and resource placement.
6. Orient the agent with `DOCKER_HOST`, `IRONCURTAIN_DOCKER_NETWORK`, the capability-gated managed-network recipe, forced workspace, dependency volume, public CA, fake sentinels, and backend metadata. In PTY mode, start the ordinary `socat` listener before the potentially long daemon bootstrap so Apple Container's published-socket relay can stabilize. The listener does not launch the agent until a host connection arrives. Attach only after step 5, the durable daemon-ready record, image provisioning, and lease activation complete; the host attach is the capability that releases the agent. Ordinary sessions omit both nested-Docker environment values and its prompt section.

An agent cannot supply create arguments for the outer daemon component.

### 8.3 Teardown and recovery

1. Mark the host-only lease `revoking`, reject new host image-ingress/start requests, and stop agent work.
2. Stop/delete the exact daemon sidecar or exact Apple container/VM.
3. Prove the outer component is absent/stopped without consulting the inner daemon.
4. Remove runtime/API roots, staged artifacts, and ephemeral daemon state.
5. Remove proxy sidecars and bundle outer networks.
6. Take two host-authoritative inventories separated by a bounded grace interval.
7. Stop the watchdog only after exact state removal and both inventories prove cleanup.

Crash reconciliation starts before any new Docker-workload lease is admitted and scans every nonclosed lease. An `incident` is durable evidence that exact cleanup was not proven, not a permanently terminal state. Admission immediately retries each well-formed incident through its recorded runtime, bound watchdog policy, and the same serialized exact-cleanup path used by normal teardown. Recovery transitions `incident -> revoking -> closed`; it retains the original incident record verbatim, while the closed lease's cleanup proof and inventory timestamps prove that the historical incident was resolved. A crash after the transition to `revoking` resumes the same cleanup on the next pass. A failed retry returns to `incident` without replacing the first failure and continues to fence admission; corrupt or unverifiable records also remain fenced. Each lease receives at most one bounded attempt per reconciliation pass. Because all nonclosed leases are scanned to avoid starving later cleanup, a pass containing several unavailable runtimes may take the sum of their individual bounds.

Reconciliation opens each lease through its recorded runtime kind, even if automatic backend selection changed; an unavailable recorded runtime fences rather than proving absence through the wrong inventory. A present but unreadable/symlinked/unsupported lease marker also fences admission. Labels are discovery indexes only: deletion requires recorded exact outer IDs plus lease generation and state roots. A lease is stale after coordinator death/restart or a bounded missed host-owned heartbeat; the heartbeat is not writable from the bundle. Admission and per-lease locks atomically publish a complete owner record bound to PID start identity and a random token, and reclaim/release only the exact observed file instance. A nested heartbeat fixture proves daemon/descendant activity stops after exact outer deletion. Fault tests cover coordinator `SIGKILL`, restart reconciliation, incident retry and retry-crash resumption, backend-selection change, corrupt lease markers, lock publication/reuse races, multiple concurrent live leases, and unrelated/foreign object preservation. The recovery budget begins when cleanup ownership is requested. Cooperative checkpoints prevent a new runtime, deletion, inventory, or grace-sleep phase from starting after it expires; an already-running runtime call or synchronous exact state deletion is allowed to finish before the lease returns to `incident`. A strict wall-clock deadline would require cancellable runtime and filesystem operations that prove no mutation continues after cancellation, and is not claimed. This does not need a per-operation WAL or exact inner container inventory.

### 8.4 Audit

Record:

- Docker capability request, policy decision, backend, and resolved feature version;
- exact outer component IDs, mounts, networks, resource limits, and effective security profile;
- staged image request, resolved digest, archive digest, and provenance;
- outer MITM requests under existing redaction rules;
- lifecycle transitions, fault injections, cleanup results, and inventory evidence;
- declared resource enforcement levels.

Do not claim per-inner-operation authorization, durable attribution, or trustworthy descendant lineage.

## 9. Phase 0: macOS falsification and qualification

Phase 0 was split so harness bugs, primitive feasibility, and product qualification could not be conflated. The timeboxed 0A fake-runtime harness and completed Apple exploratory executors have since been retired: production lifecycle tests supersede the former, and this document preserves the latter's durable evidence and adjudication. The Docker Desktop stop-gate probes remain as exact replay tools for a future, explicitly reviewed profile-ceiling restart. Run tracks independently; a stop in one does not stop the other. Phase 0C may produce only an implementation-qualified candidate, never a preview-ready backend; preview requires the Phase 2 product-entrypoint rerun.

### 9.1 Phase 0A — implement and self-test the evidence harness

Timebox 0A to at most two developer-days and spike-quality code. If it exceeds that bound, stop and rescope; do not grow a framework. Before every create, append the run ID, deterministic requested name/specification, and fully expanded argv to a host-owned ledger outside the workspace; immediately append the runtime-returned immutable ID before the next mutation. Capture result/exit/time plus allowlisted redacted environment, then SHA-manifest evidence. Traps may discover by requested identity but delete only after trusted ownership/generation inspection; a checked-in recovery command handles uncatchable `SIGKILL` and proves two empty inventories.

0A self-tests are exactly: one benign fake mutation, one interrupt/trap cleanup, one kill then recovery-command cleanup, one redaction fixture, and one schema/tamper verification. The small schema/verifier rejects missing/unmanifested files, secret fixtures, altered hashes, or wrong run IDs.

**0A exit:** all five self-tests pass inside the timebox and cleanup evidence contains two empty inventories. Backend release-suite reporting and target/scanner orchestration belong to 0F.

Historical result: the five self-tests passed, including `SIGKILL` after the fake runtime mutated
but before it returned its immutable ID; recovery discovered by requested identity, verified
run/generation/name ownership, deleted by the inspected immutable ID, and produced two empty
inventories. Once the equivalent real lease, process-lock, reconciliation, lifecycle-evidence, and
watchdog paths had production tests—and §16.12 rejected frozen qualification bookkeeping—the fake
executor no longer protected a live behavior and was deleted. Source control retains its
implementation. This closes only the historical Phase 0A and is not backend feasibility evidence.

### 9.2 Phase 0B common preparation

1. Record macOS, architecture, Docker client/server/kernel/cgroup/storage/security settings, Apple `container`/apiserver versions, and available host resources.
2. Build versioned arm64 daemon spike images on the trusted Mac. Record Dockerfiles and image digests.
3. Stage exact digest-pinned base, agent, daemon/helper, vulnerable target, patched target, and scanner archives with SHA-256/OCI manifests. Nested daemons receive no registry route. The agent layer includes pinned client-only Docker CLI, Buildx, and Compose binaries/plugins; on-demand installation is forbidden.
4. Create random `ic-nested-spike-<run-id>` ownership names and an evidence directory outside the untrusted workspace.
5. Create Mac and sibling-runtime canaries outside the repository; record exact IDs. Never expose their parent directories to the bundle.
6. Set bounded CPU, memory, PIDs, runtime, and test-write sizes. Do not perform an unbounded disk fill or fork bomb.

Never mount a host runtime socket, Mac home/root, SSH material, real credentials, or IronCurtain trusted control endpoint. Never use Docker Desktop outer `--privileged` as a diagnostic fallback. Phase 0B uses only minimal local helpers and synthetic sockets; it does not attach a provider proxy or make a provider call.

### 9.3 Phase 0B Track DD: Docker Desktop primitive falsification

#### Hypotheses

- **DD-H1:** subordinate user namespaces and rootless daemon boot work within the finite P0-P4 ceiling, with no devices/host namespaces, forbidden capability, broad profile, or outer privilege.
- **DD-H2:** the agent can connect to a private UDS in a Docker named volume; unrelated host/sibling containers cannot.
- **DD-H3:** the daemon can use `vfs`, load approved archives, build offline, and create internal bridge networks.
- **DD-H4:** identical `/workspace` and runtime paths support descendant bind mounts and sockets created after outer start.
- **DD-H5:** nested raw Docker authority, including inner `--privileged`, cannot exceed sidecar mounts, the selected outer network namespace, or sidecar cgroup.
- **DD-H6:** exact sidecar deletion kills descendants and ephemeral state can be removed without inner inventory.

#### Probe order

1. **DD-STRICT namespace prerequisite:** start the daemon image with `--network none`, `--cap-drop=ALL`, default seccomp/AppArmor/mount masks, read-only root, bounded tmpfs, and no devices. Record `id`, UID/GID maps, capabilities, `NoNewPrivs`, mountinfo, cgroups, relevant sysctls, and a minimal `unshare`/subordinate-ID probe.
2. Advance only through the cumulative P0-P4 protocol in §2.3, using a fresh bundle and full negative rerun at each level. Stop rather than improvising a sixth level or a second artifact in any category.
3. **Daemon boot:** start rootless Docker with private `XDG_RUNTIME_DIR`, private data root, UDS only, and `vfs`. Record full boot log, `docker info`, storage/security options, socket ownership, and effective outer inspect.
4. **Private client:** attach the agent through only the shared UDS volume; prove another container without that volume cannot connect.
5. **Functional primitives:** `docker load`, `info`, `run`, `exec`, offline `build`, bind/volume, create/connect/remove internal network, target/scanner exchange, and cleanup. `pull` and registry DNS/IP attempts must fail.
6. **Path/relay:** mount exact `/workspace`, write a marker, use a whole runtime directory for a post-start UDS, and prove outside-repository canaries are absent despite symlink/rename attempts.
7. **Boundary negatives:** request inner `/`, host socket paths, `--privileged`, all capabilities, host PID/network, devices, unconfined security options, sysctls, BPF/module operations, the host cgroup namespace/mount, writable control above the delegated subtree, and migration outside the immutable ancestor. A bounded delegated child subtree is allowed; every effective authority must remain inside the sidecar boundary.
8. **Network negatives:** first complete DD-STRICT public IPv4/IPv6, DNS, LAN, metadata, host/Desktop gateway/alias, runtime, and unrelated-service probes. Then construct DD-PROXY in 0B with a synthetic fixed relay after its Engine/version/options preflight and rerun every negative separately from daemon, build, ordinary child, and inner host/privileged child. Verify nested `-p` is not reachable from macOS. Phase 0C repeats the matrix with the release proxy implementation.
9. **Resources:** run bounded memory, CPU, process, and disk fixtures; sample outer runtime and host state; prove the declared aggregate behavior.
10. **Fault cleanup:** kill nested child, daemon, agent, and sidecar at separate points during build and target/scanner execution. Delete exact outer resources and capture two empty owned inventories.

Exploratory evidence establishes DD-H1 and DD-H2 and initially falsifies DD-H3 under the baseline
ceiling. `dd-p0-run-0002` falsifies P0 user-namespace creation. Fresh cumulative
`dd-p2-capsetid-0005`, `dd-p2-capsetid-daemon-0006`, and `dd-h2-private-api-0006` support namespace
creation, UDS-only daemon boot, and private sibling access with `NoNewPrivs=false`, only outer
`SETUID`/`SETGID`, and the one checked-in P2 artifact. Denial-led DD-H3 runs then admitted only the
eligible `pivot_root` and `umount2` syscalls and used a hash-recorded runtime shim to select runc's
`--no-new-keyring` mode rather than admit the forbidden `keyctl` syscall. `dd-h3-functional-0004`
successfully loads the staged image but the first inner container fails while mounting procfs.

That DD-H3 result reached the Track DD stop gate. The outer container's default
masked and read-only `/proc/*` overmounts cause Linux `mount_too_revealing` to reject a new procfs
mount from the nested user namespace. This is a kernel rule, not a further seccomp denial: an
unconditional `mount` rule is already present and earlier nested mounts succeed. Primary runc
analysis demonstrates that removing a single entry is insufficient; the mount namespace needs at
least one fully visible procfs. Docker's supported control is an empty `MaskedPaths` and
`ReadonlyPaths` override, exposed by `systempaths=unconfined`. Review accepted that override only for
the dedicated, networkless rootless-daemon sidecar: it has no host namespace, host runtime socket,
device, `SYS_ADMIN`, `NET_ADMIN`, or broad bind. The agent container and every other outer container
retain Docker's default masks. A host/VM procfs bind remains forbidden.

The first reviewed-exception run, `codex-dd-functional-systempaths-0001`, advanced to an independent
`sethostname` seccomp denial. Its manifest-bound command denial justified the one additional P2 rule,
which operates only for inner UTS initialization inside the rootless sidecar. With that hash-bound
artifact, `codex-dd-functional-systempaths-0008` passes staged image load, run/exec, offline build,
bind/volume, internal-network target/scanner exchange, negative pull, and exact cleanup. This closes
the local DD-H3 functional blocker for the version-scoped sidecar profile; it does not qualify
DD-PROXY, the product entrypoint, native Linux, or preview support.

Every cited successful or falsifying run has a verified manifest and exact cleanup with two empty
inventories. These stock-image probes do not qualify Docker Desktop. The reviewed exception is
recorded in the checked-in profile ceiling and cannot be reused outside the dedicated sidecar.

#### Track DD stop gates

Stop and record **not feasible under the baseline topology** if rootless Docker requires outer `--privileged`, `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, the host cgroup namespace/mount, writable cgroup control above its delegated subtree, migration outside its immutable ancestor, any other host namespace/device, a host runtime socket, broad unconfined profiles beyond the reviewed nested-daemon-sidecar system-path exception, direct external networking, unconfined host mounts, or untrusted cleanup access to the host daemon. Also stop for external egress, sidecar-cgroup escape, host port exposure, sibling/runtime access, or incomplete exact cleanup.

### 9.4 Phase 0B Track AC: Apple primitive falsification

#### Hypotheses

- **AC-H1:** the stock Apple guest kernel and OCI workload support a rootless Docker daemon sufficiently for the functional matrix.
- **AC-H2:** if rootless fails, a rootful workload daemon or custom-init daemon controls only one disposable VM and cannot reach macOS or another VM.
- **AC-H3:** `--network none` remains authoritative even for inner host-network/privileged containers; fixed per-file proxy UDS/vsock relays are the only external path.
- **AC-H4:** exact workspace and runtime sources are visible to the daemon without broadening host shares.
- **AC-H5:** VM CPU/memory contain nested work; bounded fork pressure preserves the host/unrelated VM; exact VM deletion removes processes, API endpoints, relays, and daemon state. Guest PID limits remain advisory.
- **AC-H6:** host sparse-disk growth is measurable and a credible production cap or residual-risk decision can be identified.

#### Probe order

1. **Guest inventory:** under `--network none` and explicit VM CPU/memory, record kernel configuration, namespace/cgroup/storage support, UID/GID maps, capabilities, mountinfo, devices, virtiofs tags, interfaces/routes, vsock exposure, and unprivileged namespace behavior. Prove direct egress is absent before Docker starts.
2. **Rootless variant:** run the DD functional sequence with rootless Docker and `vfs`; record any exact failure without broadening capabilities.
3. **Rootful workload variant:** only after preserving rootless evidence, use a fresh VM and add the smallest measured VM-local capabilities required for a UDS-only rootful daemon. Authority inside the VM may be broad; host mounts/network/API must remain narrow.
4. **Custom-init variant:** only if OCI mount masks block the workload daemon, build a version-pinned init that establishes required guest controls, starts the exact release-matched `vminitd`, then launches a supervised VM-local daemon after approved mounts exist. Prove control/API readiness, signal forwarding, mount ordering, workload loopback/UDS visibility, and terminal teardown. Do not replace or kill the shared macOS apiserver.
5. **Functional/path tests:** run load/run/exec/offline-build/volume/network, exact workspace/runtime UDS, target/scanner, and selected IronCurtain integration tests on every candidate that boots.
6. **VM boundary negatives:** inner privileged/host namespace/device/sysctl/BPF/module attempts may take over the disposable VM but must not see macOS, Docker Desktop, another Apple VM, an unadvertised virtiofs share, Apple control services, or undocumented host vsock endpoints.
7. **Network/port/resources:** repeat all DD egress locations, verify the API and nested publications are unreachable outside the VM, run bounded CPU/memory/fork pressure while host and an unrelated VM stay responsive, force timeout/exact VM deletion, prove heartbeat/API/relay cessation, and measure sparse VM disk growth.
8. **Fault cleanup:** inject scoped workload, daemon, `vminitd`, exact-VM deletion, client-disconnect, and API-unavailable faults at separate points; never kill the shared Apple apiserver. Verify API/relay/state disappearance and two empty owned inventories while unrelated Apple/Docker objects survive.

#### Current Track AC evidence

Exploratory evidence on Apple `container` 1.1.0 supports AC-H1's prerequisite and functional
portions without a rootful fallback:

- `ac-h1-inventory-0001` records an Apple guest kernel that permits unprivileged user namespaces
  and a fresh procfs mount under `--network none`, with direct DNS/IP egress absent and exact VM
  cleanup.
- `ac-rootless-daemon-0001` boots pinned Docker 29.2.1 rootless with `vfs`, a VM-private UDS, and
  only `CAP_SETUID`/`CAP_SETGID` in the outer bounding set.
- `ac-rootless-functional-0003` verifies immutable offline image load, run/exec, exact read-only
  bind, volume, offline BuildKit build, an internal target/scanner exchange, registry/DNS/direct-IP
  negatives, exact inner cleanup, exact VM deletion, and two empty owned inventories. The first two
  functional attempts exposed and then corrected an invalid `httpd` fixture; they are retained as
  falsification evidence.
- `ac-rootless-boundary-0002` runs an inner privileged container with inner host network/PID/IPC/UTS
  modes, confirms sampled macOS host-vsock ports are unreachable, and proves a nested published
  port reaches neither macOS loopback nor a separate network-isolated Apple VM. The exact installed
  `container` commit binds Containerization 0.35.0; source review confirms vminitd listens in the
  guest on port 1024 while host listeners are allocated only for explicit process I/O, copy, and
  socket relay operations. The nested process sees VM virtual-device nodes as unmapped/inaccessible,
  not macOS device passthrough.
- `ac-rootless-resource-0001` records the requested two CPUs plus Apple's one-vCPU runtime overhead,
  repeatedly reports the exact 1 GiB workload memory limit, accounts approximately 971 MiB under a
  512 MiB inner allocation, accounts 177 processes under bounded fork pressure, returns to baseline,
  and keeps the separate 256 MiB VM responsive. Guest PID enforcement remains advisory.
- `ac-rootless-disk-0002` observes a 512 GiB logical sparse rootfs: a bounded 256 MiB inner VFS layer
  grows allocated host blocks by roughly 323 MiB, inner deletion does not reclaim them, and exact VM
  deletion removes the bundle and recovers the allocation. This is evidence for the mandatory
  pre-daemon watchdog, not a hard disk limit.
- The verified `ac-rootless-fault-workload-0001`, `ac-rootless-fault-client-0001`,
  `ac-rootless-fault-daemon-0002`, and `ac-rootless-fault-vm-delete-0001` runs cover scoped workload
  SIGKILL, client disconnect, daemon SIGKILL/API loss, and exact VM deletion. Each preserves the
  unrelated VM and ends with two empty owned inventories.
- `ac-rootless-path-0002` mounts one exact host workspace at `/workspace` and a separate 256 MiB
  Apple ext4 volume over `/workspace/node_modules`. Agent and nested-child writes round-trip to the
  host workspace, the recursive inner bind preserves the Linux dependency submount, and a macOS
  dependency marker plus an absolute-host symlink remain hidden. Exact VM, volume, and fixture
  cleanup succeeds.
- `ac-rootless-relay-0005` proves Apple's host-listens/guest-connects per-file socket-mount relay:
  a network-disabled, capability-dropped nested child receives the expected synthetic HTTP response
  through a read-only bind of the mode-`0666` guest socket. The host records one metadata-only
  connection; stopping the exact relay makes the same application-level request fail. Outer inspect
  proves `network=none`, zero published ports/sockets, and `ssh=false`; exact VM, helper-process,
  host-socket-fixture, and two-inventory cleanup succeeds. Earlier retained attempts exposed the
  Darwin socket-path limit, the opposite direction of `--publish-socket`, subordinate-UID socket
  permissions, and a too-weak `socat` exit-code oracle.

The daemon reports `CgroupDriver=none` and no inner memory, CPU-quota, or PID-limit support. That is
not an Apple aggregate-boundary failure—VM CPU/memory are authoritative and guest PIDs are
advisory—but Phase 0F must freeze backend-adapted resource semantics and Phase 0C must prove them.
It also reports IPv4 forwarding disabled. Same-bridge target/scanner traffic passes; routed inner
topologies are not yet supported evidence and must be separately classified. These runs do not
prove exhaustive host-vsock/dynamic-listener negatives, the real two-MITM/provider protocol,
product watchdog, backend release suite, or product entrypoint,
and therefore do not qualify Apple.

The production direct-rootlesskit bootstrap now supplies the one step that the historical
`dockerd-rootless.sh` entrypoint performed implicitly: it sets and reads back
`net.ipv4.ip_forward=1` inside rootlesskit's private network namespace before starting dockerd. This
does not add an uplink: rootlesskit remains `--net=none --disable-host-loopback`, dockerd remains
`--iptables=false --bridge=none`, the Apple VM remains `network=none`, and host-port publication
remains forbidden. The supported target/scanner topology is an explicitly `--internal`
user-defined bridge. The product-entrypoint gate must inspect `Driver=bridge` and `Internal=true`,
prove same-bridge readiness, prove direct child IP egress fails, and prove no published ports.
The direct-IP negative uses inner host networking rather than the internal bridge, so it tests the
rootlesskit parent namespace's absence of an uplink even under the bundle's strongest available
network selection. Moby's user-defined-network resolver still requires its per-sandbox loopback NAT
rules even while daemon-wide `--iptables=false` remains set. The historical passing
`docker:29.2.1-dind-rootless` image installed legacy iptables; the direct-toolchain base omitted it,
which produced the observed raw-IP-pass/`target`-alias-fail split. The base therefore installs Debian's
iptables package and selects `/usr/sbin/iptables-legacy` as `iptables` inside the existing
off-default-path daemon toolchain directory. The package's absolute helper paths remain visible to the
bundle; PATH selection is deterministic bootstrap configuration, not an authority boundary. Bootstrap
requires that exact selected path and legacy version before dockerd starts. It does not add `/usr/sbin`
or `/sbin` to PATH, enable daemon-wide iptables, or change the no-uplink topology. The gate also
requires a same-network sibling to receive only Docker's `127.0.0.11` resolver, rejects public-name
egress, and still requires the alias nonce.
The acceptance fixture uses the exact Docker Official `busybox:1.37.0-glibc` tag, which publishes both
arm64 and amd64 variants. Immediately after the mediated pull, a hardened `--network none` container
runs `/bin/busybox --list`; the host must observe exact `httpd` and `wget` applet lines before using
those absolute multicall invocations for the server, sibling, or no-egress probes. This makes a
missing applet a fixture failure rather than false network-denial evidence.
The server attaches by the trusted-inspected immutable network ID and receives the explicit `target`
alias used by the historical passing target/scanner probe. Trusted network inspect must then yield
exactly one named server endpoint and a canonical IPv4 prefix. Three bounded, unsuppressed HTTP
oracles are independently mandatory: the server fetches its nonce over loopback, a hardened sibling
fetches it over that inspected IPv4 address, and a second hardened sibling fetches it through the
`target` alias. This separates fixture/listener, bridge/L2, and embedded-DNS failures while retaining
the name-based sibling result as a required acceptance criterion; raw-IP success is not a fallback.

The Apple 0B executors were retired after these findings were captured. They used the then-current
CA-baked images and could not qualify the current product entrypoint or topology. Future Apple gaps
belong in the current-tree product release suite (`npm run qualify:apple`), not a restored
exploratory runner. The retained-script ledger and Docker Desktop replay commands are in
[`scripts/spikes/secure-nested-docker/README.md`](../../scripts/spikes/secure-nested-docker/README.md).

#### Track AC stop gates

Stop a variant if it requires a macOS/host runtime socket or device, host network, broad Mac directory, host-published Docker API, undocumented host control service, or unbounded/unremovable state. A rootful variant passes only after the product accepts the VM boundary and every VM-specific gate succeeds.

### 9.5 Phase 0F — freeze common foundations and define backend release suites

Phase 0B classifies each primitive hypothesis as `supported`, `falsified`, or `blocked by named evidence`; it does not classify a backend as feasible. It used the then-current CA-baked images only to test runtime primitives, so no 0B TLS/provider result proves the later CA-neutral image/bootstrap work and none is claimed.

Implementation slices may land behind a fail-closed resolved-variant guard before their phase exit.
That makes one exact topology testable without claiming broader support. The ordering of phase exits,
backend qualification, product-entrypoint reruns, and preview remains normative; admitting the narrow
Apple or Docker Desktop offline developer slice satisfies none of those later gates by itself.

Current 0F foundations are catalog-independent. Checked-in images are CA-neutral; trusted bootstrap
stages only public trust, provider/registry forwarding uses destination-bound transport, and the
selected current agent is resolved once into the outer create reference and verified inner transport
artifact. The release runner rejects failed, skipped, pending, todo, zero-test, or missing suites.
The host lease/watchdog path owns pre-create names, post-create immutable IDs, coordinator-independent
revocation, and two-inventory cleanup. The deterministic Compose target/scanner workflow remains a
required compatibility gate. Historical all-role catalog publication and generation locks were useful
qualification experiments but are retired; they neither admit sessions nor define bundle trust.

The historical current-Dockerfile capture observed 13 endpoints and its offline gate scored 34/34. That
result remains useful falsification history, but its Dockerfile hashes, paths, seams, and TLS-MITM manifest
are superseded and are not future session authority. The governing
[`secure-nested-runtime-public-network.md`](./secure-nested-runtime-public-network.md) design instead
requires a live BuildKit stop-gate followed by a dedicated bounded, TLS-terminating package MITM for fixed
apt, npm, PyPI, and Cargo GET/HEAD grammars. Daemon `FROM` pulls remain separate registry egress because
they use Docker's bearer-token flow.
A workload-registry policy/proxy seam and default-on mediated ingress for enabled Docker workloads
have landed. The Apple production lifecycle constructs its per-bundle listener, mounts only that exact
socket, and starts a fixed loopback relay inside rootlesskit's network namespace for dockerd. The seam
conforms to §16.6: the superseded blob hashing and trusted response buffering are
removed, and the binding controls are genuinely backpressured streaming with per-request byte/time
and per-session total-byte/concurrency ceilings (guard-owned ledger), digest-independent exact
derived-redirect authorization with credential stripping and literal-IP refusal atop the transport
SSRF check, and the client-side bearer flow (one syntactically valid `Bearer` admitted to listed
origins; IronCurtain supplies no registry credential). Digests are audit provenance only. This path has now cleared its proxy gates: an adversarial
security review found no HIGH-severity bypass (its three actionable findings — redirect-body ceiling
bypass, a serving-a-draft-manifest gap, and a stale redirect error handler — are fixed and regression-
tested); 53 hermetic policy/proxy tests pass; and a live gate scores 16/16 against both frozen origins
(`registry-1.docker.io` and `ghcr.io`), exercising the anonymous token dance, by-digest manifest, the
`307`→CDN derived redirect, content-addressed match, digest-preserving provenance, and the fail-closed
negatives (unlisted host, push, tags/catalog enumeration, `Basic` auth). The manifest is frozen
(`workload-registry-egress-v1`) and the guard fails closed on any non-frozen manifest. The
product-entrypoint infrastructure acceptance now proves a real daemon pull, inner-only
server/sibling readiness, fixed-name resolution, direct-IP/public-DNS confinement, and exact teardown
through the production lifecycle. It makes no provider/agent turn and therefore is not Claude-turn
qualification. Next-session recovery remains a deferred gate rather than requiring a second full
Apple bootstrap in this slice.

The checked-in Apple arm64 client matrix records the locally inspected rootless Docker 29.2.1 image's
CLI/daemon/API 1.44-1.53, Buildx 0.31.1, and Compose 5.1.0 values for compatibility qualification;
live preflight compares the connected tools rather than trusting labels, but is bundle-attested and
does not make them security authority. Effective-capability resolution
accepts only outer-cgroup Docker/Linux claims or Apple hypervisor CPU/memory claims, keeps Apple PIDs unsupported, and permits observed disk only with
explicit risk acceptance and a pre-daemon watchdog attestation. These artifacts still require 0C
measurements and product-entrypoint acceptance before the backend is implementation-qualified.

The Desktop relay is a static Go binary in a non-root scratch image. Trusted lifecycle code renders
only an immutable image ID, exact fixed target/listener, isolated Engine-28 IPv4/IPv6 network, and a
bounded mountless/read-only/capability-free container profile. It validates the requested static IP
while stopped, validates assigned addresses and readiness after start, and rolls back/deletes only
exact inspected IDs. A live Docker Desktop integration check proves the fixed path, rejects an
uplink-only peer, fails after relay loss, and leaves no owned resource. This focused check is 0F
foundation evidence; it is not the complete post-attach G3 matrix or a 0C qualification record.

Land the common CA-neutral image/bootstrap, ABI-keyed Linux dependency volume with `isolated-vm` and
`node-pty` native-load probes, destination-bound parent `OutboundTransport`, independently pinned
authority-bearing Desktop relay, tested client compatibility matrix, host disk watchdog,
selected-current-agent transport, feature-off plumbing, generalized JSON Vitest reporter,
deterministic target/scanner fixtures, and a registry-aware workload-egress handler with
`registry-egress-manifest.json` (§6.4). Qualification records image architecture, Docker API range,
CLI/daemon/Buildx/Compose versions, and public-CA generation without turning that record into admission.

Qualification is a **release control, not a session control or a commit-bound contract**. Each backend
has a small, source-controlled release command such as `npm run qualify:apple`. It runs stable test
files from the current checkout through the pinned local Vitest entrypoint. The command owns its
reporter flags and fails on a nonzero test result, zero tests, a missing required suite, or any
skip/pending/todo in those suites. It does not predeclare a Git commit, dirty-patch hash, contract hash,
test-name inventory, exact test count, or machine-readable N/A list. A source edit and its tests can be
run together without first updating bookkeeping that purports to authorize the source tree.

The Apple release suite currently comprises `test/docker-manager.test.ts`,
`test/apple-container-manager.test.ts`, and `test/apple-container.integration.test.ts`. The set changes
through normal reviewed source changes when backend behavior changes; the release command rejects every
reporter-visible skip/pending/todo result. Normal code review remains responsible for deleted tests or
coverage that no longer reaches an assertion. Docker Desktop and Linux define their own suites when their
implementations exist. Cross-backend differences and unsupported behavior remain explicit in this design
and the support matrix, not duplicated into a generated contract. Broad `npm test` skips remain inventory
only and do not substitute for a backend release suite.

After a run, tooling may emit a simple diagnostic report containing backend/variant, current Git revision
and dirty status, runtime/tool versions, hashes of operational artifacts actually used, the stock test
report, actual pass/fail/skip counts, timestamp, and cleanup inventories. These are observations for
debugging and review, not authorization inputs. The report is not read by session admission, does not
need to be committed, and does not become invalid merely because its own generation changes the tree.
Session admission binds only host-enforced operational inputs: resolved config, effective outer profile,
watchdog policy, egress manifests, and any authority-bearing relay identity/configuration. Bundle image and
toolchain observations are compatibility/provenance, not lease authority.

The §7.1 resolve-once contract is implemented. Trusted host code selects the current agent once, derives the
outer create reference and inner Docker-compatible transport from that one resolution, and keeps the
per-session artifact stable through activation. Tests must induce tag/cache mutation between every seam
and prove either consistent outer/inner identity or clean pre-release failure. A global frozen catalog,
manual refreeze, and `imageMode` choice are not production prerequisites.

Current IronCurtain Dockerfiles use apt/curl/npm and other online fetches; a warm cache is not offline
proof. The current admitted local-only behavior supports source/tests and explicitly hermetic Dockerfiles.
The next slice is the separately reviewed three-state package-network design: `offline`, registry-only
`images`, and bounded bundle-wide `packages`. Package mode terminates TLS and admits only fixed public
repository GET/HEAD grammars. A hostile bundle can exfiltrate bounded workspace/build data through allowed
paths, canonicalized metadata, and timing, so this is not a build-only or no-exfiltration claim. Its exact
address policy, limits, CA/runc seam, lifecycle, migration, stop-gate, and deterministic acceptance are
normative in [`secure-nested-runtime-public-network.md`](./secure-nested-runtime-public-network.md). The
old current-Dockerfile and generic-public listener stacks are removed before package modules can become
reachable; Git history retains the experiments.

**0F exit:** foundations pass hermetic tests; backend release commands, selected-artifact transport,
authority-bearing relay digest/config, and effective profile are reviewed; the
workload-registry manifest is frozen and its hermetic protocol/negative fixtures pass; the runner rejects
skip/pending/todo/zero/missing-suite cases; resolve-once transport and compatibility preflight fail
cleanly on mismatch; watchdog loss fails closed; offline Compose passes, and the package-network slice
passes its independent stop-gate and packages/images/offline fixtures before it is admitted.

### 9.6 Phase 0C — backend qualification and repository gates

0C repeats the successful primitive sequence with release-candidate common foundations. Docker Desktop evaluates DD-STRICT and then DD-PROXY separately; Apple evaluates only the specific rootless or explicitly approved rootful/custom-init candidate. Passing produces an implementation-qualified candidate, not preview support. Provider positives use the supported bootstrap path, while direct use of the outer fake key/proxy is an acknowledged bundle behavior. Full negative, resource, lifecycle, and manifest gates run after every final topology attachment.

Primitive probes precede repository tests. For the Docker Desktop/Linux tracks, the initial
repository-test inventory is below. Each of those backend release commands selects its applicable
files from this inventory and adds backend-specific tests where needed. Apple defines its own
backend-specific release suite rather than inheriting Docker-host assumptions. Every selected test
that the reporter can see must execute without a skip/pending/todo result:

```sh
npx vitest run test/docker-manager.test.ts
INTEGRATION_TEST=1 npx vitest run test/docker-resource-lifecycle.integration.test.ts
npx vitest run test/docker-resource-limits.integration.test.ts
INTEGRATION_TEST=1 npx vitest run test/network-isolation.integration.test.ts
INTEGRATION_TEST=1 npx vitest run test/docker-uds-mount.spike.test.ts
npx vitest run test/uid-remap.integration.test.ts test/uid-remap.goose.integration.test.ts
npx vitest run test/pty-entrypoint.integration.test.ts test/skills-end-to-end.integration.test.ts
```

The 0F runner—not visual console inspection—requires every backend-suite file to run and rejects every
reporter-visible skip/pending/todo result while recording the actual results. Then run `npm run format:check`, `npm run lint`, `npm run check:cycles`, `npm run build`,
and `npm test`; skips from the broad suite are inventory only. Add a controlled end-to-end fixture that starts inner IronCurtain's normal Docker runtime against the private daemon, creates one batch child, exercises a hermetic two-MITM fixture, writes under `/workspace`, and cleans up without a paid live provider call. 0C also qualifies the resolve-once selected-agent transport and archive verifier, the separately gated package-network design when implemented, the workload-registry egress path (live pull-by-digest and tag-resolution positives plus direct-CDN selection, unlisted-registry, credentialed-endpoint, redirect-to-private-address, redirect credential-leakage, hop/byte/time/concurrency ceiling, and non-pull negatives, run only in its dedicated gates), watchdog, cgroup ancestry, independently pinned DD relay, and the watchdog's state-growth ceilings.

The target/scanner acceptance fixture is mandatory even if no existing test covers it.

### 9.7 Evidence bundle and Phase 0 exit

Each track produces a redacted diagnostic report containing:

- current source revision and dirty status as observational provenance, plus selected-artifact/toolchain
  observations and hashes of operational artifacts actually used (`profile-ceiling.json`
  and generated artifacts, authority-bearing relay binary/config/endpoint, watchdog configuration, and
  egress manifests); only the latter authority-bearing/enforcement inputs may gate admission;
- host/runtime baseline and exact commands;
- daemon image sources/digests and staged archive digests;
- fully expanded outer create/network arguments, allowlisted/redacted environment, profile hashes, and trusted inspect;
- daemon boot logs, `docker info/version`, socket metadata;
- kernel/sysctl/UID-map/capability/mount/cgroup/network evidence;
- normalized outer and diagnostic inner inspections;
- one structured result per functional and negative test;
- resource time series and bounded host disk before/after measurements;
- test exit codes, durations, and pass/fail/skip counts;
- fault point, exact cleanup IDs, and two empty inventories;
- explicit unsupported/unknown findings and the next eligible P0-P4 level or stop reason.

A hard 0B stop may classify a track as `not feasible under baseline` or `blocked by named evidence`; only 0C may classify it as an `implementation-qualified candidate` (including the explicit Apple rootful-in-VM variant). This is not preview enablement. Each product slice must later rerun its backend release suite and G1-G10 through its actual entrypoint; neither Mac track may borrow evidence.

### 9.8 What Phase 0 cannot prove

No Mac result proves native Linux user-namespace, LSM, seccomp, mount propagation, subordinate-ID, storage-driver, systemd/cgroup delegation, networking, path, recovery, performance, or disk-pressure behavior. Docker Desktop's shared LinuxKit VM and Apple's per-container VM are materially different from a native Linux host and from each other.

## 10. Implementation DAG and product branches

Normative order is `0A -> 0B -> 0F -> 0C -> Phase 1`, followed by independent `Phase 2-DD`, `Phase 2-AC`, and `Phase 2-LX` siblings. Phase 3 and Phase 4 are later capability expansions.

### Phase 1 — Shared Docker-workload lifecycle

Integrate the §7.1 selected-current-agent resolver/transport, independently pinned authority-bearing
relay, watchdog, toolchain compatibility preflight, proxy, host-enforced operational bindings, and
release-suite coverage into `DockerWorkloadConfig`, bundle partitioning, exact paths, ephemeral state,
audit, and common startup/teardown orchestration. Add production daemon/relay lifecycle and health
wiring. Outer rendering may reference only reviewed P0-P4 artifacts, exact mount masks, and trusted
resource fields; it exposes no generic capability/device/security options, and default sessions emit
none.

Implemented lifecycle progress (not a phase-exit claim): Apple
batch and PTY paths share one post-start, pre-agent bootstrap that adjudicates rootless dockerd,
preflights the tested Docker client/plugins, verifies, loads, and re-inspects the selected-current
artifact, records bounded observations, and only then activates
the lease. Admission starts its coordinator heartbeat before multi-gigabyte verification; activation
rechecks the exact bound watchdog; preparation failures revoke the lease and stop partially started
proxies. Reconciliation never treats a detached watchdog as evidence that an orphaned bundle remains
live; while a bound watchdog process could be cleaning, it fences new admission rather than racing
that cleanup owner.

The reviewed cleanup-claim/handoff protocol now serializes exact runtime I/O among coordinator teardown,
watchdog trips, and crash reconciliation, including in-flight watchdog sampling. The active coordinator
monitors the bound watchdog and invokes the same serialized teardown when status is missing, stale,
unbound, or non-ready; reconciliation fencing alone is not treated as cleanup proof.

**Exit:** deterministic contracts cover creation/rollback/kill/reconcile; feature-off equivalence holds; untrusted config cannot set outer daemon arguments; exact-ID teardown and state-root cleanup pass fault tests.

### Phase 2-DD — Docker Desktop product slice (independent)

The explicit-opt-in DD-STRICT developer slice is implemented with its minimal recorded profile,
lease-owned named-volume API/data root, `network=none`, selected-current-agent transport, and aggregate
resource partition across the daemon, agent, ordinary session transport, and enabled fixed relays. The explicit-opt-in DD-PROXY developer slice adds only the exact TUN device required
by rootless slirp networking plus an isolated-gateway network and independently pinned fixed relays to
bundle-authenticated host policy engines. Both remain supported-not-qualified.

**Exit:** the actual CLI, web/CLI launch, session-creation, agent entrypoint, and resume/rejection paths rerun the Desktop release suite and G1-G10 before Desktop preview. Every Phase 0 stop condition is a regression test. Failed preflight disables the capability without fallback.

### Phase 2-AC — Apple `container` product slice (independent sibling)

Implement every Apple variant that passed and is approved. Rootless and rootful-in-VM are distinct backend capabilities and evidence records. Version-pin custom init/kernel artifacts if used.

**Exit:** the actual CLI, web/CLI launch, session-creation, agent entrypoint, and resume/rejection paths rerun the Apple release suite and G1-G10 independently for each advertised Apple variant before preview. Documentation names the VM boundary, advisory PIDs, resource/disk policy, and no result inherited from Desktop.

### Phase 2-LX — Native Linux Docker proof and product slice (independent sibling)

Linux repeats the evidence DAG independently: **LX-B** falsifies primitives on each supported
distribution/kernel; **LX-F** defines its release suite, qualification image/toolchain manifests, and
operational profile/relay artifacts; **LX-C** produces an implementation-qualified candidate. Only then
integrate the product slice and rerun through actual CLI/UI/session/entrypoint/resume paths. Mac
0B/0F/0C artifacts are templates, never proof. A mandatory release job fails rather than skips when
Linux support is advertised.

**Exit:** G1-G10 pass on native Linux; security profiles are distribution/kernel-version scoped; no Mac evidence is cited as proof. A failure does not enable privileged DinD or host-socket fallback.

### Phase 3 — Host-mediated OCI ingress (credentialed/private)

Anonymous public pulls are §6.4 scope. Phase 3 adds policy-controlled credentialed and private-registry requests, trusted fetch, provenance and resolved-digest audit, sealed archive staging, and revocation on teardown.

**Exit:** digest/provenance and credential tests pass; malicious archives remain untrusted bundle data; direct registry access and secret injection remain absent.

### Phase 4 — Fixed package-network authority

Implement only the package-only authority in the governing design. Remove the generic-public route first;
keep new package proxy, CA, wrapper, and shim modules unreachable until the final atomic integration gate.
Admit fixed apt/npm/PyPI/Cargo GET/HEAD grammars only after redirect, address, request-smuggling,
credential-field, derived-request, residue, lifecycle, and live-client gates pass.

**Exit:** supported ordinary builds succeed with no IronCurtain-provisioned credential; recognized
credential fields/bodies, arbitrary destinations, opaque TCP, and direct routes fail. Bounded exfiltration
through admitted paths, canonicalized request metadata, and timing remains an explicit nonclaim.

### Deferred capabilities

- Persistent/cross-bundle daemon or image caches.
- Host-accessible publication of an inner service.
- GPU, KVM, USB, FUSE, or broad device access.
- Isolation between target, scanner, daemon, and agent.
- Host authorization/audit of individual Docker operations.
- Semantic broker mode.
- Deeper IronCurtain nesting beyond the private daemon's normal Docker workload.

Each requires its own threat model and gates.

## 11. Code map

### New modules/assets

- `src/docker-workload/config.ts` — requested and resolved capability types.
- `src/docker-workload/infrastructure.ts` — common bundle lifecycle and budget partition.
- [`src/docker-workload/docker-desktop-sidecar.ts`](../../src/docker-workload/docker-desktop-sidecar.ts) — implemented Docker Desktop rootless sidecar bootstrap, health, frozen-profile binding, activation canaries, API-volume handoff, and rollback.
- `src/docker-workload/client-toolchain.ts` — qualification-recorded Docker CLI/Buildx/Compose installation manifest and API compatibility preflight; its guest result is advisory.
- [`src/docker-workload/apple-vm-daemon.ts`](../../src/docker-workload/apple-vm-daemon.ts) — frozen same-VM rootless bootstrap argv and the fail-closed readiness adjudication (§4.4 variant 1). Pure logic over an injected exec seam; variants 2 and 3 are unbuilt.
- [`src/docker-workload/session-daemon.ts`](../../src/docker-workload/session-daemon.ts) — backend implementation assert (`assertNestedDaemonBackendImplemented`) and the per-session decision of whether a create launches the nested daemon component.
- `src/docker-workload/admission-bindings.ts` — removed from production; tolerant version-1 lease parsing
  retains optional legacy fields only for exact recovery.
- [`src/docker/selected-agent-artifact.ts`](../../src/docker/selected-agent-artifact.ts) —
  selected-current-agent export, canonicalization, cache, and transport metadata.
- [`src/docker/oci-image-archive.ts`](../../src/docker/oci-image-archive.ts) and
  [`src/docker/oci-image-archive-canonicalizer.ts`](../../src/docker/oci-image-archive-canonicalizer.ts) —
  streaming verification and canonical selected-current transport; archive integrity protects host
  tooling and transport consistency, not bundle trust.
- `src/docker-workload/resource-watchdog.ts` — host-only observed-disk/state measurement, reserve thresholds, revocation, and overshoot evidence.
- `src/docker-workload/desktop-relay.ts` — fixed-target hardened DD-PROXY relay lifecycle/config/health evidence.
- `src/docker-workload/build-egress-policy.ts` and `src/docker/build-egress-proxy.ts` — deleted obsolete
  current-Dockerfile source/path policy and TLS-MITM listener seam; Git history retains the experiment.
- `src/docker/registry-egress-policy.ts` — frozen workload-registry manifest resolution and pull-protocol authorization for the outer MITM registry path (§6.4).
- `src/docker/outbound-transport.ts` — destination-bound parent-proxy transport shared by provider,
  registry, and the future package-only MITM path.
- `src/docker/mediated-egress.ts` — the registry credential-free forwarder (backpressured streaming,
  per-request byte/time ceilings, session ledger, internal redirect-following, fail-closed rejection),
  deliberately separate from the credential-injecting provider path.
- `src/docker/egress-forwarding.ts` — independently tested registry request/response shaping
  (`buildRequestUrl`/`toOutgoingHeaders`/`sanitizeResponseHeaders`).
- [`docker/nested-daemon/`](../../docker/nested-daemon/) — purpose-built rootless daemon source retained
  for the future Docker Desktop/Linux sidecar topology. It clears inherited volumes/ports and pins the
  offline network mode, private UDS runtime, identity, and toolchain; it is not used by current Apple
  production admission.
- [`scripts/spikes/secure-nested-docker/`](../../scripts/spikes/secure-nested-docker/) — retained Docker
  Desktop stop-gate replay tools and public-registry live gate. The obsolete build-egress capture tool and
  instructions are deleted; Git history is the record.
- `scripts/qualify-backend.ts` and package release commands — current-tree backend suites with zero-skip enforcement and optional generated diagnostic reports; no frozen contract or commit binding.
- `config/docker-workload/profile-ceiling.json` — exact reviewed P2/P3/P4 ceiling; generated profiles may select subsets only.
- `config/docker-workload/build-egress-manifest.json` — deleted obsolete current-Dockerfile-only artifact;
  it is not packaged or available as admission authority.
- `config/docker-workload/registry-egress-manifest.json` — reviewed public-registry origins, pull-protocol rules, and ceilings for workload-image pulls.
- `test/docker-workload/` — boundary, target/scanner, fault, feature-off, and platform acceptance tests.
- `src/hardened-fs.ts` and `src/zod-helpers.ts` — shared TCB leaves for hardened host-file reads, immutable-JSON load, atomic stable-JSON writes, and canonical-path guards (`hardened-fs`), plus header/identifier and duplicate-detection schema fragments (`zod-helpers`).

Names are provisional; module ownership and security boundaries are normative.

### Existing integration points

- [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts) — create/cleanup daemon infrastructure with the existing bundle.
- [`src/index.ts`](../../src/index.ts) and [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts) — resolve/build the selected current agent once, then pass one per-session resolution to outer create and inner image transport without a second mutable-tag lookup.
- [`src/docker/docker-manager.ts`](../../src/docker/docker-manager.ts) — retain as the inner real-Docker implementation; extend outer create rendering narrowly.
- [`src/docker/types.ts`](../../src/docker/types.ts) and `parseDockerImageInfo` in [`src/docker/docker-manager.ts`](../../src/docker/docker-manager.ts) — retain normalized image inspection for per-session transport consistency and qualification provenance; image observations are not host authority. Also add trusted outer resource fields and effective profile/mount references with safe defaults.
- [`src/docker/network-topology.ts`](../../src/docker/network-topology.ts) — add DD-STRICT and Engine-28-preflighted DD-PROXY isolated-v4/v6 topology plus Apple relay capability evidence.
- [`src/docker/apple-container-manager.ts`](../../src/docker/apple-container-manager.ts) — VM resource, init, lifecycle, and inspection support.
- [`src/docker/mitm-proxy.ts`](../../src/docker/mitm-proxy.ts) and [`src/docker/registry-proxy.ts`](../../src/docker/registry-proxy.ts) — retain provider and registry destination-bound transport. The obsolete build-egress MITM and generic-public opaque-CONNECT modes are not package authority. The governing design requires a separate fixed-repository, TLS-terminating package listener that remains unreachable until its final gate.
- [`src/docker/docker-resource-lifecycle.ts`](../../src/docker/docker-resource-lifecycle.ts) — own/reconcile only authoritative outer objects; do not import inner inventory.
- [`src/config/user-config.ts`](../../src/config/user-config.ts) and [`src/config/types.ts`](../../src/config/types.ts) — schema, safe defaults, opt-in resource/image/tier policy, and resolved configuration.
- `src/config/config-command.ts`, start CLI parsing/help, and web launch request/validation — expose the same explicit session-creation capability without allowing raw outer arguments.
- [`src/session/types.ts`](../../src/session/types.ts), session creation, metadata serialization, and resume validation — record backend/version/profile/toolchain/image/resource enforcement and refuse incompatible or non-ephemeral resume.
- [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts) metadata/cleanup integration — keep the host-only lease and exact outer IDs out of bundle mounts.

Do not add `AgentExecutionRuntime`, `ParentBrokerRuntime`, opaque mount/image handles, broker multiplexing, normalized descendant inspect, broker mTLS/UDS control protocol, or a per-operation transaction journal for this capability.

## 12. Configuration and rollout

Minimal admitted operator configuration:

```yaml
dockerWorkload:
  enabled: true
```

Absence keeps the capability globally off. Once enabled, the resolved shape is developer-only,
`backend: auto`, selected-current-agent resolve-once transport, `imageIngress: public-registry`,
ephemeral daemon state, no host-port publication, disabled build egress, advisory PIDs, and
watchdog-observed disk.
`containerRuntime` may remain `auto`; admission succeeds when it resolves to Apple Container, or an
operator may select `apple-container` explicitly. Numeric ordinary `dockerResources` memory/CPU values
are inherited; unlimited (`null`) ordinary values retain safe nested fallbacks. Legacy nested resource
override fields are rejected instead of creating a second operator-controlled resource envelope. CPU and
memory are clamped to the host/VM envelope.

Operators who require no live registry access opt out explicitly:

```yaml
dockerWorkload:
  enabled: true
  networkAccess: offline
```

Qualification, offline, and PTY-only gates must use that explicit opt-out. The remaining internal
fields are implementation invariants, not ordinary UI choices. The following are explicitly
unsupported and rejected before feature-attributable runtime, image transport, proxy, lease, or
filesystem provisioning:

- native Linux outer runtimes;
- `tier: preview`, current-Dockerfile build egress, persistent daemon state,
  or host-port publishing;
- `pids.required: true`, a numeric disk limit, or explicitly disabling acceptance of the admitted
  watchdog-observed disk policy;
- resume of a Docker-workload session.

The untrusted agent cannot choose rootful Apple, profiles, mounts, network, relay targets, the
host-selected current-agent artifact, watchdog, or release-suite selection. The ordinary CLI may perform its existing credential
preflight before reaching the feature admission seam; that is not Docker-workload provisioning.

Feature/runtime/backend versions, exact resolved config hash, full effective profile tuple,
workspace/runtime ABI, selected outer/inner image observations, toolchain observations, authority-bearing
relay binary/config/endpoint, watchdog/egress manifests, resource status, and proxy protocol are written
to session metadata. Image/toolchain observations are provenance; resume is unsupported for the
ephemeral Docker-workload slice. Qualification reports and source revisions are not session-admission inputs. A
recorded `compatibility-blocker` is terminal with no config/UI override; clearing it requires an
implementation fix or explicit reviewed design change and a full backend rerun.

Rollout order is developer-only explicit opt-in, evidence-gated Mac backend preview, independently gated Linux preview, then stable per backend. Backend support is a matrix, not a single global boolean. Telemetry/audit must distinguish unsupported preflight from runtime failure and never auto-retry with broader authority.

## 13. Verification matrix

| Gate | Mandatory evidence                                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0   | Two-day 0A ledger/trap/recovery passes; 0B precedes reviewed 0F release suites and operational artifacts; both 0C Mac tracks record actual reports and two cleanup inventories; Linux non-inference is explicit.                                                                                                                                      |
| G1   | Current-tree backend release suite with zero skips; tested toolchain/API matrix; one selected-current-agent resolution used for outer create and inner load; qualification-only manifest/archive proof; real primitives/e2e/Compose/scanner.                                                                                                          |
| G2   | Trusted outer inspect plus host/sibling/Mac canaries; no host runtime/control socket, secret, broad path, namespace, or device.                                                                                                                                                                                                                       |
| G3   | DD-STRICT first; DD-PROXY Engine 28 isolated-v4/v6 preflight then post-attach matrix; trusted byte-relay mutation/malformed/exhaustion/death tests and exact outer-MITM endpoint evidence; Apple repeats its topology. Registry-egress negatives (unlisted registry, credentialed endpoint, redirect abuse, oversize) run wherever §6.4 is enabled.   |
| G4   | `profile-ceiling.json` subset proof, denial/reviewer evidence, fresh cumulative P0-P4 runs and full frozen tuple; immutable outer cgroup; absolute stops; ECI/Sysbox never qualifies baseline.                                                                                                                                                        |
| G5   | Provisioning/env/filesystem/image scans and supported two-MITM bootstrap tests; direct outer-fake/proxy use is an accepted collusion fixture; outer MITM alone is authoritative and holds real secrets/CA key. IronCurtain provisions no registry credential/private-registry configuration; a bundle-supplied Bearer may reach only a listed origin. |
| G6   | Desktop/Linux immutable ancestor/migration negatives including relay reserve; Apple CPU/memory/fork pressure; desired/required PID behavior; watchdog pre-start/post-inventory lifecycle, death/recovery/coverage/overshoot tests; frozen watchdog state thresholds.                                                                                  |
| G7   | Host-only lease, `SIGKILL`/restart/API-loss/live-newer/foreign-preservation faults, nested heartbeat cessation, exact outer deletion, state/relay removal, recovery bound, and two empty inventories. Apple faults never kill the shared apiserver.                                                                                                   |
| G8   | Feature-off create-argument/effective-plan snapshots and targeted Docker/Apple/builtin/workflow e2e; no IronCurtain-provisioned daemon/API/state/mount/relay/profile/resource action. Static image tooling and self-launched processes inside the unchanged VM envelope are allowed.                                                                  |
| G9   | Independent backend release-suite results plus complete G1-G10 rerun through actual CLI/UI/session/entrypoint/resume before each advertised variant preview; Linux runs LX-B/LX-F/LX-C first.                                                                                                                                                         |
| G10  | Every blocker is terminal/no-override and clears only after an implementation fix or reviewed design change and a full rerun; fallback tests exclude host sockets, outer privilege, direct registry/network, and broker fallback.                                                                                                                     |

## 14. Transition from the broker-first design

| Former goal/design                          | Disposition                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Early Mac no-descendant utility             | Retained in 0F common bootstrap work; no longer presented as the Docker goal.                                                                                                                                                                                           |
| Per-operation semantic broker authorization | Dropped for Docker capability; optional future stronger mode.                                                                                                                                                                                                           |
| Authenticated caller/mutation audit         | Replaced by bundle enablement, host lifecycle, ingress, egress, profile, and resource audit.                                                                                                                                                                            |
| Per-descendant mount handles                | Replaced by exact outer daemon/VM mount confinement and arbitrary bundle-visible inner mounts.                                                                                                                                                                          |
| No inner networking                         | Replaced by arbitrary bundle-internal networks with outer egress confinement.                                                                                                                                                                                           |
| Credential non-provisioning                 | Retained.                                                                                                                                                                                                                                                               |
| Immutable approved inner images only        | Replaced by untrusted selected-current-agent transport, §6.4 mediated public-registry workload pulls, and untrusted bundle-local build/load/tag/commit. Only a separately authority-bearing service such as the future DD uplink relay retains mandatory image pinning. |
| Exact inner cleanup and broker WAL          | Replaced by exact outer sidecar/VM teardown and ephemeral state-root removal.                                                                                                                                                                                           |
| Normal-session equivalence                  | Retained.                                                                                                                                                                                                                                                               |
| Linux-first proof                           | Reordered: Mac spike first because it is the available system; Linux remains independently mandatory before Linux support.                                                                                                                                              |
| Select only one Mac backend                 | Replaced by independent Docker Desktop and Apple support gates; both are product goals.                                                                                                                                                                                 |
| No weaker fallback                          | Retained and sharpened.                                                                                                                                                                                                                                                 |

## 15. Decisions, residual risks, and open product questions

### Decided

1. Exact workspace-root exposure is acceptable: the repository is one colluding authority domain.
2. Agent, daemon, targets, scanners, and descendants are not isolated from one another.
3. Real Docker compatibility and existing daemon-facing integration tests are required.
4. Initial daemon state is ephemeral and bundle-private.
5. Bundle images are untrusted. Production resolves and transports the selected current agent once;
   qualification may separately pin manifests for repeatability. Workload images may additionally use
   §6.4 public-registry egress without IronCurtain-provided registry credentials. Configured credentials
   and private registries remain Phase 3. Hermetic builds are offline. The next Apple slice may grant the
   whole bundle bounded fixed-repository GET/HEAD authority under the explicit `packages` mode and
   nonclaims in [`secure-nested-runtime-public-network.md`](./secure-nested-runtime-public-network.md);
   Dockerfile identity is not authority.
6. No host port publication in the base capability.
7. One total resource budget plus fixed trusted-infrastructure reserves is preferred over an agent-selected split.
8. Docker Desktop/Linux outer privilege and host runtime sockets remain prohibited.

### Product decisions required

1. **Apple rootful-in-VM:** is rootful Docker acceptable when every per-session VM boundary gate passes? Recommendation: yes, with explicit UI/audit wording that the VM is the boundary.
2. **Stable disk policy:** stable support requires a hard host-enforced limit; decide which Desktop/Linux volume/tmpfs and Apple VM-disk mechanism is supported. Observed-only plus watchdog is eligible only for explicitly accepted developer preview, never a silent stable fallback.
3. **Apple guest artifacts:** may the Apple backend use a version-pinned custom init and, if necessary, custom kernel when stock rootless support is insufficient? Recommendation: permit a pinned init; require a separate supply-chain/release decision for a custom kernel.
4. **Mutable image tags in Phase 3 ingress:** may policy approve a tag and record its resolved digest, or must requests name a digest? Recommendation: digest required by default; tag resolution requires explicit escalation.
5. **Performance and watchdog defaults:** review must freeze initial backend/version ceilings, safety thresholds, reserve floor, and overshoot bound after 0B; these are product/release values rather than architecture constants.

None of these product decisions blocks Phase 0A. They gate the affected 0C candidate, Phase 2 product slice, or stable tier.

## 16. Review and adjudication record

### 16.1 Historical adjudication summary (non-normative)

The design began with a semantic broker and then moved to a Docker-capable bundle after the user
clarified that the accepted outer container or Apple VM is the security boundary. The following
decisions explain the current plan; superseded implementation diaries remain available in Git history.

- The agent, private daemon, builds, and descendants are one colluding bundle. Host enforcement comes
  from the outer profile, exact mounts and networks, mediated endpoints, watchdog, lease ownership, and
  cleanup—not from identities reported by the bundle.
- Docker Desktop/Linux remain rootless-sidecar candidates under a finite P0-P4 profile ceiling. Apple
  may use rootful Docker only inside its disposable per-session VM. Apple guest PID observations are
  advisory; hard disk claims require host enforcement, while the current observed-disk slice requires
  the pre-daemon watchdog.
- DD-PROXY is a distinct authority-bearing service: its fixed image digest, command,
  destination, effective profile, and isolated network remain host-adjudicated because it receives an
  uplink unavailable to the bundle.
- Public workload-image pulls moved into the fixed registry-egress path. Pulled bytes are untrusted;
  authorization applies to origins, operations, redirects, credentials, SSRF boundaries, and transfer
  ceilings. Exact derived CDN redirects are request-scoped and never become a reusable allowlist.
  Registry references and digests are provenance, not bundle-code attestation.
- Dockerfile `RUN` fetches and daemon `FROM` pulls are different seams. Package `RUN` traffic uses
  the dedicated TLS-terminating fixed-repository package MITM and grants bounded bundle-wide package
  authority; `FROM` pulls remain on registry egress and its bearer-token flow. The superseded generic-
  public opaque-CONNECT experiment is not a product path.
- Shared hardened filesystem, hashing, schema, request shaping, and credential-free mediated-egress
  primitives replaced duplicated implementations. Provider forwarding remains separate because it
  injects real credentials.
- The Apple implementation selected same-VM rootless dockerd. Live testing required capability-based
  id-map helpers and non-root bootstrap; static Docker tooling in every arm64 agent image is accepted
  as inert bundle-local capability when nested Docker is disabled.
- Frozen performance budgets and commit-bound qualification contracts were deleted. They did not
  constrain a trusted operator or the untrusted bundle. Backend qualification now runs reviewed
  current-tree suites and fails on nonzero, missing, zero-test, skipped, pending, or todo results.
  Reports and tool/image observations are diagnostic provenance; they are never session credentials.
- Historical all-role catalogs, paired generations, and refreeze commands were removed after the
  selected-current-agent transport migration. New leases omit their authority fields, while tolerant
  readers retain optional legacy fields solely so outstanding leases can be reconciled and cleaned.

These decisions preserve the falsification history without making obsolete catalog, contract, or
performance machinery part of the current requirements. Sections 16.13–16.16 record the remaining
lifecycle, usability, and threat-model corrections that govern the implemented Apple slice.

### 16.13 Pre-enablement lifecycle and compatibility corrections (record, 2026-08-11)

An adversarial branch review found one ordinary-session regression and six fail-closed defects in the
then-blocked workload path. The corrections are normative:

- **Feature-off means no IronCurtain-provisioned authority.** Separate arm64 images remain rejected as
  disproportionate complexity. Static Docker tooling and an agent's self-launched processes inside its
  unchanged disposable VM are allowed; IronCurtain must not provision a daemon, API/state, mount, relay,
  profile change, or outer resource unless the capability is admitted. G8 and maintainer guidance now use
  this definition.
- **Trusted provider gateways are a distinct address policy.** A provider override resolved from trusted
  host configuration may target loopback, RFC1918/CGNAT, or ULA addresses. Metadata and link-local remain
  denied. Passthrough, redirects, builds, and registries stay public-only and cannot select the exception.
- **The PTY host attach is the agent-release capability.** The container starts its ordinary `socat`
  listener immediately so Apple Container's published-socket relay can stabilize, but `socat` does not
  launch the agent until the host connects. The host must not attach until daemon bootstrap, profile
  adjudication, image provisioning, the durable daemon-ready record, and lease activation complete.
  Socket-inode existence alone is not a successful PTY startup: a connection that closes before producing
  any PTY output is a startup failure, while an explicit host shutdown remains a graceful exit.
- **Exact Apple ownership is emitted.** Generic create labels, including the lease generation, are rendered
  by the Apple manager just as they are by the Docker manager.
- **Recovery follows recorded state.** A stale lease is inventoried and revoked through `lease.runtimeKind`,
  with a trusted runtime resolver when selection changed. An unavailable recorded runtime or a present but
  unreadable lease marker fences admission; neither can be converted into an absence proof.
- **One process lock protects both admission and lease updates.** It atomically publishes a complete
  owner record, binds PID to an OS process-start identity plus a random token, and verifies the exact file
  instance before reclaim or release. Fresh malformed records are busy, not stale.
- **Response hop semantics are complete.** Egress relays remove both the static hop-by-hop set and every
  field nominated by an upstream `Connection` header.

These fixes are prerequisites for the Apple product-entrypoint and lifecycle gates. Section 16.14 makes
only the narrow Apple developer slice reachable; 0C remains incomplete.

### 16.14 Apple developer-slice admission and built-CLI smoke (historical record, 2026-08-11)

The first admitted Apple developer slice proved the shared resolved-variant guard, Apple availability
preflight, batch/PTY lease lifecycle, same-VM daemon, built-CLI entrypoints, and exact teardown. It used
paired frozen catalogs and therefore does not qualify the current selected-current-agent transport.
Its catalog identity checks, staged-pair prerequisites, and refreeze workflow are retired.

The still-valid limitations are preserved: these infrastructure smokes are not provider/agent turns,
and every failure path must retire owned state and exact runtime objects. If the optional PTY regression
gate is rerun, it must require post-activation TUI bytes rather than startup text or a socket inode.
Section 16.16 and the handoff record the replacement selected-current public-registry result and the
deterministic public/offline workflow result.

### 16.15 Enabled-state usability defaults and settings surfaces (record, 2026-08-15)

Nested Docker remains globally off when `dockerWorkload` is absent or `enabled` is not true. The minimal
enabled request is now `{ dockerWorkload: { enabled: true } }`: it resolves to the already-admitted Apple
developer shape and enables only the frozen §6.4 Docker Hub/GHCR registry path. The authority is
unchanged; `imageIngress: preloaded-only` remains the explicit offline opt-out used by deterministic
qualification and PTY-only gates.

The ordinary `dockerResources` numeric memory/CPU settings become nested defaults so operators do not
manage two resource envelopes. Legacy nested overrides are rejected, while ordinary `null` values retain
the safe nested fallback rather than creating an unlimited VM. The CLI Docker Agent submenu and web
Settings expose only enablement and public pulls; backend, tier, daemon state, host ports, build egress,
PID, disk-risk, and host-selected image transport remain implementation policy. Startup logs report enabled
state and whether pulls are mediated or offline. The public-registry production smoke persists the
minimal requested workload object, while offline and PTY modes persist the explicit opt-out.

### 16.16 Bundle-image trust and resolve-once transport correction (normative, 2026-08-15)

The earlier design made a category error: it treated base, agent, daemon, helper, and `socat` images as
trusted infrastructure even though §1 and §3 place their processes in the fully colluding bundle. A
known image digest does not constrain that bundle after start. The agent can execute arbitrary workspace
code, administer its private Docker daemon, replace bundle-local files, and use every fixed endpoint the
host intentionally exposes. Conversely, changing those bytes cannot add a host mount, interface, port,
credential, resource grant, cleanup identity, or proxy destination because those are selected and
enforced outside the bundle.

Therefore:

- bundle-image identities and toolchain tuples are compatibility and provenance observations, not host
  security admission bindings;
- catalog hashes/generations must leave new bundle leases and must not be read to authorize a session;
- `imageMode: preloaded-catalog`, the dual-catalog equality requirement, the eight-role publication, and
  manual refreeze are removed from the production contract. A legacy config parser may accept and erase
  the old compatible value so an existing safe configuration does not become unreadable;
- the selected agent still needs a Docker-compatible archive so an inner IronCurtain can start without
  direct image egress. The host resolves/builds the selected current agent once, captures a stable
  per-session outer reference plus inner archive derived from that resolution, stages only that archive,
  and does not perform a second mutable-tag lookup before activation;
- archive structure and checksums remain defensive transport controls. A corrupt, unsafe, or mismatched
  archive fails cleanly before agent release and triggers exact lease cleanup, but successful verification
  does not attest guest code;
- historical catalog generation, pair validation, staging, and freshness tooling is removed. Current
  focused/unit tests and product smoke verify the selected artifact, transport archive, and tool
  versions directly; the Apple qualification suite verifies backend behavior;
- the standalone base, helper, and catalog `socat` roles are removed from production and qualification
  staging. The future-backend nested-daemon source remains, but is not an Apple production input. Git
  history retains the old catalog experiments.

The fixed Docker Desktop relay is intentionally different. DD-PROXY gives only that service an uplink
attachment unavailable to the agent/daemon network. A substituted relay could therefore expand G3. Its
reviewed binary image digest, fixed command/configuration, exact target, effective profile, and network
attachments remain host-adjudicated operational inputs. It must not inherit identity from, or rotate
with, a bundle-image qualification generation. Any future image-backed service receives mandatory
pinning only after the design shows an analogous authority differential.

The current Docker Desktop implementation attaches that trusted relay to Docker's default bridge so it
can reach the host-gateway listener. This intentionally gives the relay a NAT-capable default route and
L2 adjacency to other default-bridge containers; mediation on this hop therefore depends on the pinned
relay binary and its adjudicated single-target configuration, not on an egress-denying uplink network.
The untrusted agent and private daemon never join the default bridge. This is an accepted residual risk
of the Docker Desktop backend. Replacing the default bridge requires a separately qualified uplink that
both reaches the host gateway and proves the absence of public/LAN egress; a merely custom non-internal
bridge is not such proof.

Earlier text that described eight “trusted infrastructure” roles, catalog hashes as lease bindings,
catalog mismatch as a security blocker, or refreeze as a product-start prerequisite is superseded by
this section and retained only in Git history. The production
migration is present in the current working tree. Its public-registry managed-network product-entrypoint
smoke passed live on 2026-08-15 with exact cleanup. On 2026-08-21 the built production workflow
entrypoint passed fixed no-LLM public and offline probes (28 and 17 checks), exact cleanup after each run,
and graceful second-session admission in one isolated home. That deterministic gate is the functional
acceptance path; PTY is an optional transport-specific regression gate, not another LLM-driven replay of
the functional matrix.

#### Adversarial acceptance checklist

The migration is complete only when all of the following are demonstrated:

- **No authority regression:** substituting arbitrary agent/base/daemon/archive bytes leaves trusted outer
  create arguments, exact mounts, `network=none`, no host publication, resource envelope, registry/provider
  listener policy, watchdog ownership, and exact-ID cleanup unchanged.
- **One resolution:** instrumented batch and PTY tests prove outer create and inner load consume one captured
  selected-agent resolution. Mutation/retagging after capture either cannot affect the session or fails
  before agent release with exact cleanup; there is no fallback lookup, pull, or unrelated-agent switch.
- **Automatic transport:** `{ dockerWorkload: { enabled: true } }` prepares only the selected current-agent
  archive/cache entry and starts after an ordinary agent rebuild without manual catalog generation or
  refreeze. Offline `preloaded-only` still disables registry egress; it does not select a catalog mode.
- **Transport safety:** truncation, hash mismatch, unsafe tar paths/types, wrong platform, wrong logical
  agent, load failure, and post-load mismatch each fail before activation and retire the staged artifact.
  A successful same-agent inner IronCurtain start proves the archive still contains its required base
  layers.
- **Lease migration/recovery:** new leases omit catalog/toolchain authority fields. A versioned or tolerant
  reader can still reconcile and exactly clean legacy outstanding leases; removing fields must not turn an
  old lease into an unreadable permanent admission fence. Only host-enforced bindings are read back.
- **Qualification separation:** production imports/call graphs contain no catalog or generation-lock
  dependency. Qualification verifies archives, backend behavior, selected identity consistency, and tool
  versions without granting or denying a product session.
- **Relay exception preserved:** DD-PROXY tests reject a tag, wrong digest, entrypoint/config mutation,
  profile drift, extra mount, publication, or network attachment before traffic. Bundle-image changes do
  not rotate the relay digest.
- **Feature-off and failure behavior:** ordinary sessions stage no selected-agent Docker archive, create no
  daemon/listener/lease, and receive no nested-Docker orientation. Every prepare/create/load failure leaves
  no owned VM, listener, runtime/state root, watchdog, or unreadable lease.
- **Evidence and wording:** unit/integration tests label guest tool/image observations advisory; host inspect,
  proxy policy, watchdog, and cleanup remain authoritative. Ordinary operator CLI, web, handoff, and
  production errors contain no catalog/refreeze prerequisite or claim that bundle image identity is a
  security boundary.
- **Live gate:** fixed-command production workflows cover fresh offline, public-registry, and
  managed-network functionality from the minimal configuration after an ordinary current-agent rebuild,
  with exact cleanup and no provider turn. Historical v3 catalog runs do not satisfy this item. The
  available PTY smoke is reserved for regressions in activation-before-attach, environment/orientation
  delivery, terminal bytes, bounded shutdown, or PTY cleanup; it is not required to repeat this gate.

## 17. Primary references

- [Docker Engine rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Docker rootless mode tips, including rootless DinD](https://docs.docker.com/engine/security/rootless/tips/)
- [Docker rootless limitations and troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/)
- [Docker Official Image notes for `dind-rootless` and outer `--privileged`](https://hub.docker.com/_/docker/)
- [Docker default seccomp profile](https://docs.docker.com/engine/security/seccomp/)
- [Docker AppArmor profiles](https://docs.docker.com/engine/security/apparmor/)
- [Docker VFS storage driver](https://docs.docker.com/engine/storage/drivers/vfs-driver/)
- [Docker container resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker image load](https://docs.docker.com/reference/cli/docker/image/load/)
- [Docker `network create` and internal networks](https://docs.docker.com/reference/cli/docker/network/create/)
- [Docker bridge gateway modes, including Engine 28 isolated mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)
- [Docker Engine 28 gateway-mode release notes](https://docs.docker.com/engine/release-notes/28/)
- [Apple Containerization architecture](https://github.com/apple/containerization)
- [Apple `container` usage and custom init documentation](https://github.com/apple/container/blob/main/docs/how-to.md)
- [Docker Desktop Enhanced Container Isolation](https://docs.docker.com/enterprise/security/hardened-desktop/enhanced-container-isolation/)
- [Sysbox project and compatibility documentation](https://github.com/nestybox/sysbox)
- [Linux cgroup v2 process and delegation model](https://docs.kernel.org/admin-guide/cgroup-v2.html)

The upstream documents describe capabilities and constraints, not IronCurtain's security proof. Only the platform-specific evidence gates above establish support.
