# Secure Nested Docker Runtime Implementation Plan

**Date:** 2026-07-19
**Status:** Phase 0A is implemented and self-tested. Phase 0B baseline Docker Desktop reached its
frozen-topology stop gate at the inner procfs mount. Independent Apple evidence supports guest
prerequisites, a rootless `vfs` daemon, the functional offline matrix, sampled VM-boundary and
publication negatives, resource accounting/peer survival, sparse-disk observation, and scoped
fault cleanup, exact workspace/dependency paths, and a fixed per-file proxy relay with fail-closed
loss. Phase 0F implementation has begun: agent images are CA-neutral, public session trust is staged
at runtime, provider/registry forwarding uses a destination-bound transport with a tested two-MITM
credential cascade and parent-loss failure, and both image call paths use a fail-closed verified
preloaded-catalog resolver. Trusted staging converts Docker-save output into one strict shared-blob
OCI/Docker archive, records backend-specific immutable IDs in backend-bound catalogs, and has loaded,
resolved, and exactly removed a staged relay through both Docker Desktop and Apple `container`.
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
bootstrap are implemented. A fail-closed resolved-variant guard now admits only the exact Apple
developer-only, preloaded/offline, ephemeral slice defined in §12 after a live Apple-availability
preflight. `npm run smoke:nested:apple` exercises the built CLI session/bootstrap/activation path,
then an exact lease-bound private-Docker child and teardown. The complementary, manually invoked
`npm run smoke:nested:apple:pty` drives the built `start --pty` entrypoint through the same node-pty
bridge as mux and requires a post-activation Claude TUI redraw plus private-Docker evidence and exact
teardown. Neither is an agent-turn/provider, full 0C, or preview qualification. Docker Desktop, native Linux, public-registry,
build-egress, enforced-PID, bounded-disk, and preview variants remain rejected. No backend is
implementation-qualified or preview-ready.
**Amendment (2026-07-21, user-approved):** workload-image registry egress is promoted from Phase 3
into 0F/0C scope; the frozen preloaded catalog now covers only trusted infrastructure images. See
§6.4, §7.1, and §16.5.
**Amendment (2026-07-21, user-approved):** workload-registry mediation gates request and derived-
redirect authority, not the contents of already-untrusted workload images. Host-side blob hashing
and verify-before-release buffering are removed from the security design. See §6.4 and §16.6.
**Scope:** Docker-capable IronCurtain bundles on macOS Docker Desktop, macOS Apple `container`, and Linux Docker
**Supersedes:** The broker-first design formerly in this file and the runtime recommendation in [`docs/brainstorm/ironcurtain-in-ironcurtain.md`](../brainstorm/ironcurtain-in-ironcurtain.md)

## /goal

Deliver an opt-in real Docker API for untrusted IronCurtain workloads. The agent, its private daemon, and all nested containers are one colluding bundle. The trusted host constrains the bundle as a whole; it does not authorize individual inner Docker operations.

The implementation is complete only when all outcome gates pass:

0. **G0 - staged evidence:** 0A records mutations and exact recovery within two days; 0B falsifies primitives; 0F freezes operational artifacts and defines backend release suites; 0C produces an implementation-qualified candidate for Desktop and Apple independently. Generated reports identify the current checkout and environment, record actual results, and include two cleanup inventories. Mac never proves Linux.
1. **G1 - Docker compatibility:** each concrete variant passes its current-tree backend release suite with zero executable-gate skips, pinned CLI/Buildx/Compose and API range, real `DockerManager`, immutable preloaded-catalog IDs, offline workflows, and deterministic Compose target/scanner results.
2. **G2 - outer boundary:** the daemon sees only exact workspace, private runtime/state, staged catalog artifacts, fixed proxy paths, and public trust; no host runtime socket/namespace/cgroup write/device, unrelated path, real credential, or CA private key is present.
3. **G3 - confined network:** direct public, DNS, LAN, metadata, host, and runtime access fails from agent, daemon, build, and child. DD-PROXY requires Engine 28 isolated IPv4/IPv6 and one trusted byte relay to the exact outer MITM. Relay loss fails closed; nested ports are not host-reachable.
4. **G4 - bounded privilege:** Desktop/Linux rootless Docker stays inside the frozen P0-P4 subset and immutable sidecar cgroup, without outer privilege, sensitive host surfaces, or broad/unconfined profiles. Apple rootful is eligible only inside a proven disposable per-session VM. ECI/Sysbox qualifies only its named environment.
5. **G5 - non-provisioning:** no real provider/OAuth/MCP/SSH/registry credential or host CA key enters the bundle. Supported bootstrap may use two fake-key MITMs, but colluders may use the outer fake key/proxy directly; only outer-MITM egress is authoritative.
6. **G6 - resources:** proven Desktop/Linux outer cgroups enforce aggregate CPU, memory, and required PIDs. Apple hypervisor CPU/memory and exact deletion are authoritative; guest PIDs are advisory. Hard disk claims require enforcement; observed-disk preview requires the pre-daemon host watchdog. Frozen watchdog state thresholds pass.
7. **G7 - teardown:** normal and injected-failure teardown kills descendants, removes API/relay/runtime/ephemeral state, preserves foreign/live resources, stops heartbeat, and yields two empty host inventories without trusting inner Docker.
8. **G8 - unchanged provisioned authority:** disabled sessions receive no IronCurtain-provisioned daemon, API/state, mount, privilege/profile change, relay, or outer resource. Static tooling and self-launched processes inside the unchanged disposable VM envelope are not provisioned authority.
9. **G9 - independent proofs:** each advertised Desktop, Apple, and Linux variant reruns its backend release suite and G1-G10 through its actual CLI/UI/session entrypoint before preview. No platform or rootless/rootful result proves another.
10. **G10 - fail closed:** release-suite, product-acceptance, catalog, profile, toolchain, relay, watchdog, limit, or cleanup failure is a terminal compatibility blocker. Clearing it requires fixing the implementation or an explicit reviewed design change followed by a full rerun; no unsafe or broker fallback exists.

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
- Build hermetic workspace Dockerfiles offline from preloaded bases; rebuild current network-dependent IronCurtain Dockerfiles only through the frozen 0F narrow build-egress profile.
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
- do not add `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, host namespaces, `seccomp=unconfined`, `apparmor=unconfined`, `systempaths=unconfined`, or outer `--privileged` during the Docker Desktop spike;
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
- Preloaded-catalog resolver and trusted resolved session configuration.
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

| Subject     | Host-authoritative claim                                                                                                    | Bundle-local/advisory only                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Mounts      | Exact outer mounts exposed to daemon/VM                                                                                     | Which bundle-visible paths an inner container mounts             |
| Network     | Outer interfaces, fixed proxy endpoints, and absence of host port publication                                               | Inner bridges, addresses, ports, and container attribution       |
| Images      | Identity of sealed artifacts admitted by host                                                                               | Locally built/retagged/committed image identity and lineage      |
| Credentials | Which public CA/fake sentinels were provisioned; no real secret provisioned                                                 | Secret data the colluding workload creates or shares itself      |
| Resources   | Desktop/Linux outer-cgroup CPU/memory/PIDs after proof; Apple hypervisor CPU/memory; proven hard disk; exact outer deletion | Apple guest PIDs, all inner limits/metrics, observed-only disk   |
| Lifecycle   | Exact outer component IDs, state roots, and their deletion                                                                  | Completeness or honesty of inner `docker ps`, events, and labels |
| Audit       | Capability enablement, host lifecycle, ingress, proxy egress, effective profiles                                            | Per-Docker-operation actor attribution                           |

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

Preloaded mode is offline except for 0F's narrow current-IronCurtain-Dockerfile profile, which fixes reviewed apt/npm/GitHub/toolchain origins through the outer MITM and rejects all client-selected targets. Phase 4 may later add generic reviewed workload/package destinations. Neither mode is a generic TCP relay, and no credential is injected into Dockerfile arguments, build secrets, environment, or layers.

### 6.4 Workload-image registry egress (promoted from Phase 3)

Images are two classes. **Trusted infrastructure images** — base, agent (per harness), nested-daemon, helper, fixed-relay, socat — are TCB: their identity is bound into qualification evidence and they only ever arrive through the preloaded catalog (§7.1). **Workload images** — anything the bundle runs inside its private daemon — are untrusted bundle state, so fetching one is threat-model-equivalent to installing a package through the mediated package path and may be mediated rather than pre-staged.

When `imageIngress: public-registry` is enabled, the nested daemon receives proxy environment plus the session public CA and reaches only the fixed proxy path; there is still no direct registry route. The outer MITM adds a registry-aware handler frozen by `registry-egress-manifest.json`:

- client-initiated requests may target only reviewed registry and token-service origins (e.g. `registry-1.docker.io`, `auth.docker.io`, `ghcr.io`); client-selected registry, token, or CDN hosts fail closed;
- anonymous public pulls only: no registry credential exists in the bundle or is injected by the proxy; authenticated and private registries remain Phase 3. The `401`→token→retry dance is performed **client-side** by the bundle (the proxy performs no token dance of its own); the proxy admits a single `Bearer` token only on a client-initiated request to a listed registry/token origin, and always strips it from derived redirects. Because no credential exists in the bundle, any bearer it holds was necessarily obtained anonymously through this same mediated path;
- pull-by-digest is preferred; tag and digest references and any registry-reported or optionally computed manifest digest are recorded as audit provenance, not host attestation;
- the trusted proxy may follow an unlisted CDN URL only when that exact `Location` is the immediate response to an authorized manifest/blob request. The derived request preserves `GET`/`HEAD`, stays on HTTPS, passes destination-bound public-address/SSRF checks, has finite hops, and carries no authorization, cookie, client-selected host, or other credential-bearing header. The bundle cannot directly select or reuse the CDN destination;
- bodies stream with normal backpressure under per-request and per-session byte, absolute-time, and concurrency ceilings. No trusted blob buffer, spool, or content hash is required; interrupted transfers and ceiling failures fail closed and are audited;
- push, delete, catalog/tag enumeration, and all non-pull registry operations are rejected;
- fetched image references and final destinations are recorded as provenance but remain untrusted bundle state — mediated request authority and provenance are the claims, not content integrity or trust.

Hashing remains mandatory for trusted infrastructure catalog artifacts under §7.1. It is deliberately
not a workload-registry security control: the bundle can already build or import arbitrary bytes,
a registry can choose a malicious manifest and matching blobs, and malformed or substituted
workload bytes cannot expand the outer envelope. Docker may perform its normal digest validation,
but that result is bundle-local evidence. Implementations may hash a small manifest for diagnostics;
that optional observation must not gate redirects, delivery, or qualification.

`preloaded-only` remains the default. Qualification runs use `preloaded-only` everywhere except the dedicated registry-path gates, so backend evidence never silently depends on live registry availability. The registry-aware handler joins the trusted network TCB and therefore requires its own frozen manifest, hermetic protocol fixtures, and 0C negatives before any preview.

## 7. Images, builds, and target/scanner workflows

### 7.1 Initial image model

The catalog governs the §6.4 infrastructure class only; workload images arrive through registry egress (§6.4), explicit archive staging, or bundle-local builds, and are never host-trusted.

`imageMode: preloaded-catalog` resolves a trusted read-only catalog outside the workspace. Each entry binds immutable manifest/config digests and a backend-specific runtime image ID, exact build-hash schema+hash, toolchain digest, architecture/API range, runtime-trust schema, catalog generation, and provenance. Docker's runtime ID is the config digest; Apple `container` deterministically synthesizes a top-level descriptor during import, so trusted staging records that Apple-specific ID after independently verifying the archive. Trusted bootstrap stages the selected archive, verifies it before load, loads it only if the logical ref is absent, inspects the immutable loaded ID/config, compares every field, and returns/records the catalog hash. Mismatch fails before any build; automatic `buildImage` fallback and trusting a mutable tag as identity are forbidden. Apple Container 1.1 cannot create from its local `sha256:` image ID and offers no authoritative `--pull never`: after the resolver verifies the catalog logical tag, Apple uses that exact resolved tag only as the create address, then inspects the exact stopped VM and requires its captured image descriptor to equal the already-resolved catalog ID before start. A mismatch is removed by exact stopped-VM ID and never started. Docker continues to create by immutable ID. Catalog publication/retagging during admission is a trusted-host operational error and is forbidden; the stopped-create check closes untrusted substitution, while a future shared image-store lock is optional hardening for trusted concurrent operators. In `preloaded-only` ingress mode direct `docker pull` fails because the daemon has no registry route; in `public-registry` mode pulls traverse only the fixed proxy path under the frozen §6.4 manifest.

Both image call paths branch once, early, on trusted resolved image mode: the [`src/index.ts`](../../src/index.ts) `ensureDockerImage` preflight and `prepareDockerInfrastructure`/`resolveAgentImage`. The branch occurs before legacy label staleness or build decisions. In preloaded mode there are zero calls to `ensureImage`, `ensureBaseImage`, `buildImage`, or `pullImage`. Tests cover both call paths and assert those call counts.

Implementation progress (not an exit claim): the shared resolver branch parses a bounded,
non-symlink, non-group/world-writable catalog through one `O_NOFOLLOW` descriptor; validates unique
entries and canonical toolchain/provenance digests; checks current source build hash,
architecture/API range, runtime-trust schema, immutable loaded image ID, and the complete normalized
label tuple; and returns only the immutable ID. It streams the complete archive through an
`O_NOFOLLOW` descriptor before invoking a loader, verifies tar structure and checksums, archive
size/hash, OCI layout/index/manifest/config/layer descriptors, every blob hash, platform, and image
labels, and rejects writable/symlink/unsafe/special/duplicate paths. The same sealed tar carries one
strictly equivalent Docker-save compatibility view because Docker Desktop rejects a pure OCI-layout
tar; its sole tag, config bytes, uncompressed layer bytes, and diff IDs are tied back to the verified
OCI graph. Apple selects only the local `linux/arm64` variant when normalizing labels. A gated real
runtime test (`PRELOADED_IMAGE_INTEGRATION=1`) passes archive verification, load, immutable-ID/label
inspection, and exact removal on both Mac runtimes. Missing images load only from that verified
archive; mismatches fail with automatic build/pull disabled, and focused tests assert zero such
calls. The first Apple production bootstrap now stages and loads the exact outer session's selected
agent archive through the VM-private daemon, then retires the multi-gigabyte staging hard link before
agent release. That archive already contains its base layers, so same-agent inner IronCurtain startup
does not require a separately tagged base image. It intentionally does not yet support switching to a
different inner agent, base-tag-dependent repair/build paths, or the two existing integration tests
that name `ironcurtain-base:latest`; those require sequential on-demand staging or Apple-specific
equivalent coverage. Complete persisted/resume tuple checks and live read-only VirtioFS archive-load
qualification remain open.

Before load, verify archive index, manifest, and config hashes against catalog content. After load, normalized evidence compares immutable runtime image ID, manifest/config digest, platform, build-hash schema/hash, toolchain/trust/catalog generations, and provenance. The catalog covers only the trusted infrastructure images: base, agent (per harness), nested-daemon, helper, fixed-relay, and socat. Target, patched-target, and scanner images are pinned test fixtures staged as sealed archives by the qualification harness, not production catalog roles. Persist the complete resolved tuple in session metadata; resume requires exact compatibility rather than tag lookup.

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

Expose one configured bundle budget with a coordinator-chosen reserve rather than asking the untrusted client to partition authority. On Desktop/Linux, statically partition outer agent/daemon/relay CPU, memory, and PIDs so their sum cannot exceed the bundle total. Qualification must prove every dockerd, BuildKit, shim, build, and child process remains under an immutable outer sidecar cgroup ancestor; probe inner `--cgroup-parent`, host cgroup namespace, delegation, migration, and direct cgroup writes. Any process observed outside the subtree, successful migration, or writable parent/ancestor cgroup is an immediate compatibility blocker. Inner delegation may reduce inner Docker semantics but never weaken the outer ceiling.

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
6. Orient the agent with `DOCKER_HOST`, forced workspace, dependency volume, public CA, fake sentinels, and backend metadata. In PTY mode, start the ordinary `socat` listener before the potentially long daemon bootstrap so Apple Container's published-socket relay can stabilize. The listener does not launch the agent until a host connection arrives. Attach only after step 5, the durable daemon-ready record, image provisioning, and lease activation complete; the host attach is the capability that releases the agent.

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

Reconciliation opens each lease through its recorded runtime kind, even if automatic backend selection changed; an unavailable recorded runtime fences rather than proving absence through the wrong inventory. A present but unreadable/symlinked/unsupported lease marker also fences admission. Labels are discovery indexes only: deletion requires recorded exact outer IDs plus lease generation and state roots. A lease is stale after coordinator death/restart or a bounded missed host-owned heartbeat; the heartbeat is not writable from the bundle. Admission and per-lease locks atomically publish a complete owner record bound to PID start identity and a random token, and reclaim/release only the exact observed file instance. A nested heartbeat fixture proves daemon/descendant activity stops after exact outer deletion. Fault tests cover coordinator `SIGKILL`, restart reconciliation, incident retry and retry-crash resumption, backend-selection change, corrupt lease markers, lock publication/reuse races, multiple concurrent live leases, and unrelated/foreign object preservation. The recovery bound begins when the recorded outer runtime API becomes available; exceeding it returns the lease to `incident` and keeps it fenced for a later bounded retry. This does not need a per-operation WAL or exact inner container inventory.

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

Exploratory evidence establishes DD-H1 and DD-H2 but falsifies DD-H3 under the frozen baseline
ceiling. `dd-p0-run-0002` falsifies P0 user-namespace creation. Fresh cumulative
`dd-p2-capsetid-0005`, `dd-p2-capsetid-daemon-0006`, and `dd-h2-private-api-0006` support namespace
creation, UDS-only daemon boot, and private sibling access with `NoNewPrivs=false`, only outer
`SETUID`/`SETGID`, and the one checked-in P2 artifact. Denial-led DD-H3 runs then admitted only the
eligible `pivot_root` and `umount2` syscalls and used a hash-recorded runtime shim to select runc's
`--no-new-keyring` mode rather than admit the forbidden `keyctl` syscall. `dd-h3-functional-0004`
successfully loads the staged image but the first inner container fails while mounting procfs.

This DD-H3 result reaches the Track DD stop gate, rather than P4. The outer container's default
masked and read-only `/proc/*` overmounts cause Linux `mount_too_revealing` to reject a new procfs
mount from the nested user namespace. This is a kernel rule, not a further seccomp denial: an
unconditional `mount` rule is already present and earlier nested mounts succeed. Primary runc
analysis demonstrates that removing a single entry is insufficient; the mount namespace needs at
least one fully visible procfs. Docker's supported control is an empty `MaskedPaths` and
`ReadonlyPaths` override, exposed by `systempaths=unconfined`. That would unmask sensitive proc
entries and is explicitly outside P4 and the absolute-stop list. A host/VM procfs bind would instead
expose a host namespace and is also forbidden. Consequently baseline Docker Desktop is currently
**not feasible under the frozen topology**. DD-PROXY cannot repair this local mount prerequisite and
is not run for this candidate. ECI/Sysbox may still be assessed only as their separately named
environments.

Every cited successful or falsifying run has a verified manifest and exact cleanup with two empty
inventories. These stock-image probes do not qualify Docker Desktop. Proceed independently with
Track AC; revisiting baseline Desktop requires an explicit reviewed change to the profile ceiling
and a complete P0-P4 restart, not an exploratory fallback.

#### Track DD stop gates

Stop and record **not feasible under the baseline topology** if rootless Docker requires outer `--privileged`, `SYS_ADMIN`, `NET_ADMIN`, `/dev/fuse`, the host cgroup namespace/mount, writable cgroup control above its delegated subtree, migration outside its immutable ancestor, any other host namespace/device, a host runtime socket, broad unconfined profiles, direct external networking, unconfined host mounts, or untrusted cleanup access to the host daemon. Also stop for external egress, sidecar-cgroup escape, host port exposure, sibling/runtime access, or incomplete exact cleanup.

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
Apple developer slice satisfies none of those later gates by itself.

Implementation progress (not an exit claim): the checked-in Dockerfiles no longer copy a session
CA; bootstrap stages hash-bound public certificate/bundle files under the read-only orientation
mount and wires Node/OpenSSL/curl/Git/pip/Requests/apt consistently. The destination-bound direct and
fixed-parent transports are integrated into provider, registry, and passthrough forwarding. Focused
runtime-trust, transport, cascade, MITM, registry, adapter, catalog-resolver, archive-verifier, and
session suites pass, including parent loss with no direct fallback and immutable-ID catalog
resolution without build/pull. A generated sealed archive also passes real load/inspect/remove on
both Mac outer runtimes. Trusted canonicalization/staging now records separate Docker and Apple
runtime IDs, and the deterministic Compose target/scanner fixture passes its direct Mac acceptance
workflow. An all-or-nothing catalog builder now requires every named role, stages one sealed
archive per role for both backends, verifies the shared archive tuple, publishes neither backend
catalog until all roles succeed, and removes partial artifacts on failure. The §16.5 amendment
narrows the required role set to infrastructure images; fixture images move to the qualification
harness. The production infrastructure catalog is now frozen: a live `build-preloaded-catalog` run
built all eight roles on Docker Desktop 29.2.1 and Apple `container` 1.1.0 (arm64), staged one sealed
sha256-bound archive per role for both backends, and checked in
`config/docker-workload/preloaded-catalog.{docker,apple-container}.json` (generation
`ironcurtain-preloaded-arm64-v1`). Operator configuration resolves absence/empty/false to exactly
`{enabled:false}` and rejects raw images, mounts, capabilities, profiles, relay targets, and runtime
arguments. Production metadata plumbing, narrow build egress, backend release-suite coverage, and end-to-end product
plumbing remain open, so 0F has not exited. Implemented foundations
include a strict Node/native-module dependency ABI manifest and disposable runtime probe; a trusted
release runner that invokes only the pinned local Vitest entrypoint, owns reporter/output flags, and
rejects failed, skipped, pending, todo, zero-test, or missing required suites; and a fail-closed watchdog state machine with
exact root identity, stale-sample detection, one-shot revocation, and two-inventory shutdown. A host-only atomic lease, exact generation-bound
revoker, normalized Docker/Apple inventory, and detached supervisor now implement the
coordinator-independent foundation. A cross-process test now proves the supervisor survives a coordinator **SIGKILL** (not a graceful
exit) and, orphaned, detects a post-mortem hard-state breach and performs exact revocation with the
two-empty-inventory cleanup proof and lease closure; actual daemon admission/teardown still must wire
this lifecycle. The narrow build-egress authorization layer binds reviewed Dockerfile hashes to exact
seams, destinations, methods, path/query shapes, finite redirect graphs, credential-free headers, and
byte/time ceilings. The cold-cache endpoint capture and the
`run`-seam manifest freeze are now done. A terminate-TLS CA-inject capture (the capture CA is trusted
in each build the way production wires trust, via a transient BuildKit-heredoc overlay that never
edits the production Dockerfiles) gave full per-host path visibility on all 13 endpoints with zero CA
resistance and zero unmediated fetches. `config/docker-workload/build-egress-manifest.json`
(`build-egress-current-dockerfiles-arm64-v1`) is frozen and path-gated, GET/HEAD-only, credential-
stripped, with the four source Dockerfiles hash-pinned; an offline gate scores 34/34 authorizing every
captured endpoint and rejecting unlisted-host/method/path/credential/encoded-smuggling violations. The
freeze also added a narrow per-rule `allowEncodedSlash` opt-in (npm scoped-package metadata is
`/@scope%2fname`; `%5c`/`%25`/traversal stay globally rejected). The build-egress `base-image` sub-item was reassessed against the code (2026-07-23) and the plan's
original framing corrected: a `FROM` base-image pull is a registry pull that never traverses the
build-egress proxy — that proxy is `--build-arg`-wired into `RUN` steps only, while the daemon resolves
`FROM` out-of-band — and the build-egress schema cannot even carry it (it unconditionally rejects an
`authorization` header fail-closed, so it cannot carry Docker Hub's anonymous `401`→token→`Bearer`
retry). Base-image mediation
therefore belongs to the already-frozen registry-egress path (§6.4), which is repo-agnostic within its
listed origins and so already authorizes the one external base pull (`node:22-trixie`, repository
`library/node`) with no manifest change; a committed test now asserts that node manifest/blob/token path
against the frozen registry-egress manifest. The build-egress `base-image`/`dockerfile-frontend` seam
enums are retained as provenance/audit vocabulary only. Pinning the `FROM` digest is deferred to the
next natural catalog re-freeze — pinning now would force a full catalog rebuild (the `RUN`-step apt/npm
are unpinned, so a rebuild is not byte-reproducible anyway) for a rebuild-path-only gain that does not
affect the runtime, which already runs the sha256-bound frozen catalog image. The production
proxy/BuildKit wiring that routes the daemon's `FROM` pull to the registry-egress listener remains a
Phase 1 item.

A workload-registry policy/proxy seam and strict `public-registry` opt-in have landed, but the
resolved-variant guard rejects that mode. The seam conforms to §16.6: the superseded blob hashing and trusted response buffering are
removed, and the binding controls are genuinely backpressured streaming with per-request byte/time
and per-session total-byte/concurrency ceilings (guard-owned ledger), digest-independent exact
derived-redirect authorization with credential stripping and literal-IP refusal atop the transport
SSRF check, and the anonymous client-side bearer flow (single `Bearer` admitted to listed origins
only). Digests are audit provenance only. This path has now cleared its 0C gates: an adversarial
security review found no HIGH-severity bypass (its three actionable findings — redirect-body ceiling
bypass, a serving-a-draft-manifest gap, and a stale redirect error handler — are fixed and regression-
tested); 53 hermetic policy/proxy tests pass; and a live gate scores 16/16 against both frozen origins
(`registry-1.docker.io` and `ghcr.io`), exercising the anonymous token dance, by-digest manifest, the
`307`→CDN derived redirect, content-addressed match, digest-preserving provenance, and the fail-closed
negatives (unlisted host, push, tags/catalog enumeration, `Basic` auth). The manifest is frozen
(`workload-registry-egress-v1`) and the guard fails closed on any non-frozen manifest. Production
lifecycle wiring (constructing the guard in a real `public-registry` session, and the nested-mode
parent-proxy transport that must be a guarded resolver) remains the open Phase 1 item.

The checked-in Apple arm64 client matrix binds the locally inspected rootless Docker 29.2.1 image
to exact CLI/daemon/API 1.44-1.53, Buildx 0.31.1, and Compose 5.1.0 values; live preflight compares
the connected tools and catalog tuple rather than trusting labels. Effective-capability resolution
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

Land the common CA-neutral image/bootstrap, ABI-keyed Linux dependency volume with `isolated-vm` and `node-pty` native-load probes, destination-bound parent `OutboundTransport`, hardened Desktop relay, pinned client compatibility matrix, host disk watchdog, preloaded catalog, feature-off plumbing, generalized JSON Vitest reporter, deterministic target/scanner fixtures, and a registry-aware workload-egress handler with `registry-egress-manifest.json` (§6.4). Each staged image records architecture, Docker API range, CLI/daemon/Buildx/Compose versions, and public-CA generation.

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
Session admission binds only operational inputs (catalog, profile, watchdog policy, egress manifests,
relay, toolchain, and resolved config) plus live preflight.

Add `imageMode: preloaded-catalog`. Trusted code resolves a read-only catalog outside the workspace containing immutable manifest digest/runtime image ID, exact build-hash schema+hash, toolchain digest, architecture/API range, CA/runtime-trust generation, catalog generation, and provenance. After load, inspect immutable ID and compare every field; mismatch fails before build. Never trust a mutable tag or automatically call `buildImage`; return/record the catalog hash. Tests assert `buildImage` is never called in preloaded mode.

Current IronCurtain Dockerfiles use apt/curl/npm and other online fetches; a warm cache is not offline proof. Preloaded mode supports source/tests and explicitly hermetic Dockerfiles only. 0F freezes `build-egress-manifest.json` solely for current checked-in IronCurtain Dockerfiles. Each rule fixes scheme/host/port, methods/paths, redirect closure and hop limit, DNS/address policy, allowed/stripped headers, byte/time limits, and the BuildKit/frontend/worker/build/RUN seam where it applies. Reviewed apt/npm/GitHub/toolchain origins traverse the outer MITM; arbitrary client targets, credentials, and layer secrets are forbidden. Cold-cache/direct-connect traps prove all fetches are mediated; image history/config/layers are scanned for proxy credentials. The result is network-mediated and recorded, not reproducible unless every fetched artifact is also pinned. Disabled narrow egress fails fast; generic workload/package egress remains Phase 4.

**0F exit:** foundations pass hermetic tests; backend release commands and operational catalog/relay/profile hashes are reviewed; the workload-registry manifest is frozen and its hermetic protocol/negative fixtures pass; the runner rejects skip/pending/todo/zero/missing-suite cases; live preflight rejects wrong image or trust generation; watchdog loss fails closed; offline Compose and narrowly scoped current-Dockerfile rebuild fixtures pass their respective modes.

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
and `npm test`; skips from the broad suite are inventory only. Add a controlled end-to-end fixture that starts inner IronCurtain's normal Docker runtime against the private daemon, creates one batch child, exercises a hermetic two-MITM fixture, writes under `/workspace`, and cleans up without a paid live provider call. 0C also qualifies the frozen preloaded catalog, narrow current-Dockerfile build-egress profile, the workload-registry egress path (live pull-by-digest and tag-resolution positives plus direct-CDN selection, unlisted-registry, credentialed-endpoint, redirect-to-private-address, redirect credential-leakage, hop/byte/time/concurrency ceiling, and non-pull negatives, run only in its dedicated gates), watchdog, cgroup ancestry, relay, and the watchdog's state-growth ceilings.

The target/scanner acceptance fixture is mandatory even if no existing test covers it.

### 9.7 Evidence bundle and Phase 0 exit

Each track produces a redacted diagnostic report containing:

- current source revision and dirty status as observational provenance, plus hashes of the operational artifacts actually used (`profile-ceiling.json` and generated artifacts, preloaded catalog, toolchain, relay binary/config/endpoint, watchdog configuration, and egress manifests);
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

Integrate the 0F-reviewed and 0C implementation-qualified catalog resolver, relay, watchdog, toolchain,
proxy, operational-artifact bindings, and release-suite coverage into `DockerWorkloadConfig`, bundle
partitioning, exact paths, ephemeral state, audit, and common startup/teardown orchestration. Add production daemon/relay lifecycle and health wiring; do not recharacterize catalog resolution as a new Phase 1 loader. Outer rendering may reference only frozen P0-P4 artifacts, exact mount masks, and trusted resource fields; it exposes no generic capability/device/security options, and default sessions emit none.

Implementation progress (not an exit claim): Apple batch and PTY paths share one post-start,
pre-agent bootstrap that adjudicates rootless dockerd, preflights the pinned Docker client/plugins,
loads and re-inspects the selected catalog image, records bounded observations, and only then activates
the lease. Admission starts its coordinator heartbeat before multi-gigabyte verification; activation
rechecks the exact bound watchdog; preparation failures revoke the lease and stop partially started
proxies. Reconciliation never treats a detached watchdog as evidence that an orphaned bundle remains
live; while a bound watchdog process could be cleaning, it fences new admission rather than racing
that cleanup owner.

Before the fuse may open, one reviewed cleanup-claim/handoff protocol must serialize exact runtime
I/O among coordinator teardown, watchdog trips, and crash reconciliation, including an in-flight
watchdog sample. The active coordinator must also monitor the bound watchdog and invoke that same
serialized teardown when status is missing, stale, unbound, or non-ready. These are named blockers;
the current code does not claim that reconciliation fencing alone cleans an ownerless live supervisor.

**Exit:** deterministic contracts cover creation/rollback/kill/reconcile; feature-off equivalence holds; untrusted config cannot set outer daemon arguments; exact-ID teardown and state-root cleanup pass fault tests.

### Phase 2-DD — Docker Desktop product slice (independent)

Proceed only if Track DD becomes an implementation-qualified candidate in 0C. Implement its minimal recorded profile, separate named-volume API/exchange roots, identical workspace paths, DD-STRICT `network=none`, evidence-gated DD-PROXY isolated-gateway network plus fixed relay, preloaded images, and resource declarations.

**Exit:** the actual CLI, web/CLI launch, session-creation, agent entrypoint, and resume/rejection paths rerun the Desktop release suite and G1-G10 before Desktop preview. Every Phase 0 stop condition is a regression test. Failed preflight disables the capability without fallback.

### Phase 2-AC — Apple `container` product slice (independent sibling)

Implement every Apple variant that passed and is approved. Rootless and rootful-in-VM are distinct backend capabilities and evidence records. Version-pin custom init/kernel artifacts if used.

**Exit:** the actual CLI, web/CLI launch, session-creation, agent entrypoint, and resume/rejection paths rerun the Apple release suite and G1-G10 independently for each advertised Apple variant before preview. Documentation names the VM boundary, advisory PIDs, resource/disk policy, and no result inherited from Desktop.

### Phase 2-LX — Native Linux Docker proof and product slice (independent sibling)

Linux repeats the evidence DAG independently: **LX-B** falsifies primitives on each supported distribution/kernel; **LX-F** defines its release suite and freezes its operational profile/catalog/toolchain artifacts; **LX-C** produces an implementation-qualified candidate. Only then integrate the product slice and rerun through actual CLI/UI/session/entrypoint/resume paths. Mac 0B/0F/0C artifacts are templates, never proof. A mandatory release job fails rather than skips when Linux support is advertised.

**Exit:** G1-G10 pass on native Linux; security profiles are distribution/kernel-version scoped; no Mac evidence is cited as proof. A failure does not enable privileged DinD or host-socket fallback.

### Phase 3 — Host-mediated OCI ingress (credentialed/private)

Anonymous public pulls are §6.4 scope. Phase 3 adds policy-controlled credentialed and private-registry requests, trusted fetch, provenance and resolved-digest audit, sealed archive staging, and revocation on teardown.

**Exit:** digest/provenance and credential tests pass; malicious archives remain untrusted bundle data; direct registry access and secret injection remain absent.

### Phase 4 — Generic proxy-only workload/package egress

If needed, expose an HTTP-only fixed gateway to reviewed destinations. Add redirect, DNS-rebinding, CONNECT, protocol-smuggling, metadata/LAN, response-limit, and cancellation tests.

**Exit:** approved builds succeed without credentials in layers; arbitrary TCP/direct routes fail from every egress location. This phase is not required for offline Docker compatibility.

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
- `src/docker-workload/rootless-sidecar.ts` — Linux/Desktop bootstrap, health, profile record, and UDS paths. Not built: no Linux/Desktop backend is qualified, and §9.3 classifies baseline Desktop as infeasible under the frozen topology.
- `src/docker-workload/client-toolchain.ts` — pinned client-only Docker CLI/Buildx/Compose installation manifest and API compatibility preflight.
- [`src/docker-workload/apple-vm-daemon.ts`](../../src/docker-workload/apple-vm-daemon.ts) — frozen same-VM rootless bootstrap argv and the fail-closed readiness adjudication (§4.4 variant 1). Pure logic over an injected exec seam; variants 2 and 3 are unbuilt.
- [`src/docker-workload/session-daemon.ts`](../../src/docker-workload/session-daemon.ts) — backend implementation assert (`assertNestedDaemonBackendImplemented`) and the per-session decision of whether a create launches the nested daemon component.
- [`src/docker-workload/admission-bindings.ts`](../../src/docker-workload/admission-bindings.ts) — real hash-bound operational inputs for the lease, replacing the placeholder seam.
- `src/docker-workload/image-staging.ts` — sealed archive metadata and later OCI ingress.
- [`src/docker/preloaded-image-catalog.ts`](../../src/docker/preloaded-image-catalog.ts) and [`src/docker/oci-image-archive.ts`](../../src/docker/oci-image-archive.ts) — trusted catalog resolution, streaming sealed-archive verification/loading, backend-specific immutable ID/config comparison, catalog hash, and no-build fallback.
- `src/docker-workload/effective-capabilities.ts` — per-resource/platform `enforced`/`observed`/`unsupported` record.
- `src/docker-workload/resource-watchdog.ts` — host-only observed-disk/state measurement, reserve thresholds, revocation, and overshoot evidence.
- `src/docker-workload/desktop-relay.ts` — fixed-target hardened DD-PROXY relay lifecycle/config/health evidence.
- `src/docker-workload/build-egress-policy.ts` — frozen current-Dockerfile manifest resolution across BuildKit/frontend/worker/build/RUN seams.
- `src/docker/registry-egress-policy.ts` — frozen workload-registry manifest resolution and pull-protocol authorization for the outer MITM registry path (§6.4).
- `src/docker/outbound-transport.ts` — destination-bound parent-proxy transport shared by MITM and registry/package paths.
- `src/docker/mediated-egress.ts` — the single credential-free forwarder (backpressured streaming, per-request byte/time ceilings, optional session ledger and internal redirect-following, fail-closed rejection) used by both egress proxies; deliberately separate from the credential-injecting provider path.
- `src/docker/egress-forwarding.ts` — shared request/response shaping (`buildRequestUrl`/`toOutgoingHeaders`/`sanitizeResponseHeaders`) for both egress proxies.
- [`docker/nested-daemon/`](../../docker/nested-daemon/) — pinned purpose-built daemon image. Under the same-VM topology (§16.10) it is not run as a container; it is the pinned upstream source whose digest the agent base image copies its toolchain from, and it remains the image a future sibling-daemon backend would launch. The separate entrypoint and health probe are unbuilt: the bootstrap argv and the readiness adjudication live host-side in `apple-vm-daemon.ts`, where they are testable and not agent-writable.
- [`scripts/spikes/secure-nested-docker/`](../../scripts/spikes/secure-nested-docker/) — retained Docker Desktop stop-gate replay tools, build-egress capture, and public-registry live gate. The superseded 0A fake harness and completed Apple exploratory executors are retired; the directory README records the deletion/retention rationale and exact future commands.
- `scripts/qualify-backend.ts` and package release commands — current-tree backend suites with zero-skip enforcement and optional generated diagnostic reports; no frozen contract or commit binding.
- `config/docker-workload/profile-ceiling.json` — exact reviewed P2/P3/P4 ceiling; generated profiles may select subsets only.
- `config/docker-workload/build-egress-manifest.json` — current-Dockerfile-only destination and BuildKit-seam authorization.
- `config/docker-workload/registry-egress-manifest.json` — reviewed public-registry origins, pull-protocol rules, and ceilings for workload-image pulls.
- `config/docker-workload/preloaded-catalog.docker.json` and `config/docker-workload/preloaded-catalog.apple-container.json` — per-backend frozen catalogs of immutable IDs/digests, build/toolchain/trust generations, API/platform scope, and provenance.
- `test/docker-workload/preloaded-catalog.test.ts` — mismatch failures and proof that both call paths invoke no legacy ensure/build/pull operation.
- `test/docker-workload/` — boundary, target/scanner, fault, feature-off, and platform acceptance tests.
- `src/hardened-fs.ts` and `src/zod-helpers.ts` — shared TCB leaves for hardened host-file reads, immutable-JSON load, atomic stable-JSON writes, and canonical-path guards (`hardened-fs`), plus header/identifier and duplicate-detection schema fragments (`zod-helpers`).

Names are provisional; module ownership and security boundaries are normative.

### Existing integration points

- [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts) — create/cleanup daemon infrastructure with the existing bundle.
- [`src/index.ts`](../../src/index.ts) and [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts) — make one early resolved-image-mode branch in both `ensureDockerImage` preflight and `prepareDockerInfrastructure`/`resolveAgentImage`; preloaded mode bypasses every legacy ensure/build/pull call.
- [`src/docker/docker-manager.ts`](../../src/docker/docker-manager.ts) — retain as the inner real-Docker implementation; extend outer create rendering narrowly.
- [`src/docker/types.ts`](../../src/docker/types.ts) and `parseDockerImageInfo` in [`src/docker/docker-manager.ts`](../../src/docker/docker-manager.ts) — extend normalized image inspection with immutable runtime ID, manifest/config digests, platform, build schema/hash, toolchain/trust/catalog generations, and provenance; also add trusted outer resource fields and frozen profile/mount references with safe defaults.
- [`src/docker/network-topology.ts`](../../src/docker/network-topology.ts) — add DD-STRICT and Engine-28-preflighted DD-PROXY isolated-v4/v6 topology plus Apple relay capability evidence.
- [`src/docker/apple-container-manager.ts`](../../src/docker/apple-container-manager.ts) — VM resource, init, lifecycle, and inspection support.
- [`src/docker/mitm-proxy.ts`](../../src/docker/mitm-proxy.ts) and [`src/docker/registry-proxy.ts`](../../src/docker/registry-proxy.ts) — use destination-bound outbound transport; the MITM resolves a single internal `ListenerMode` for its build-egress/registry-egress listener modes.
- [`src/docker/docker-resource-lifecycle.ts`](../../src/docker/docker-resource-lifecycle.ts) — own/reconcile only authoritative outer objects; do not import inner inventory.
- [`src/config/user-config.ts`](../../src/config/user-config.ts) and [`src/config/types.ts`](../../src/config/types.ts) — schema, safe defaults, opt-in resource/image/tier policy, and resolved configuration.
- `src/config/config-command.ts`, start CLI parsing/help, and web launch request/validation — expose the same explicit session-creation capability without allowing raw outer arguments.
- [`src/session/types.ts`](../../src/session/types.ts), session creation, metadata serialization, and resume validation — record backend/version/profile/toolchain/image/resource enforcement and refuse incompatible or non-ephemeral resume.
- [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts) metadata/cleanup integration — keep the host-only lease and exact outer IDs out of bundle mounts.

Do not add `AgentExecutionRuntime`, `ParentBrokerRuntime`, opaque mount/image handles, broker multiplexing, normalized descendant inspect, broker mTLS/UDS control protocol, or a per-operation transaction journal for this capability.

## 12. Configuration and rollout

Illustrative configuration:

```yaml
dockerWorkload:
  enabled: true
  tier: developer-only
  backend: apple-container
  imageMode: preloaded-catalog
  imageIngress: preloaded-only
  daemonState: ephemeral
  hostPortPublishing: false
  buildEgress: disabled
  acceptObservedDiskRisk: true
  resources:
    memoryMb: 4096
    cpus: 2
    pids:
      desired: 512
      required: false
    diskMb: null
```

This is the only currently admitted configuration shape; `backend: auto` is also accepted when it
resolves to Apple. CPU and memory values may vary and are clamped to the outer host/VM envelope.
`pids.desired` remains advisory on Apple. The following are explicitly unsupported and rejected before
feature-attributable runtime, image, catalog, proxy, lease, or filesystem provisioning:

- Docker Desktop and native Linux outer runtimes;
- `tier: preview`, public-registry ingress, current-Dockerfile build egress, persistent daemon state,
  or host-port publishing;
- `pids.required: true`, a numeric disk limit, or observed disk risk without explicit acceptance;
- resume of a Docker-workload session.

The untrusted agent cannot choose rootful Apple, profiles, mounts, network, relay targets, daemon image,
catalog, watchdog, or release-suite selection. The ordinary CLI may perform its existing credential
preflight before reaching the feature admission seam; that is not Docker-workload provisioning.

Feature/runtime/backend versions, exact resolved config hash, full profile tuple, workspace/runtime ABI,
complete catalog image tuple/hash, toolchain, relay binary/config/endpoint, watchdog/egress manifests,
resource status, and proxy protocol are written to session metadata. Resume requires exact compatible
operational tuples. Qualification reports and source revisions are not session-admission inputs. A
recorded `compatibility-blocker` is terminal with no config/UI override; clearing it requires an
implementation fix or explicit reviewed design change and a full backend rerun.

Rollout order is developer-only explicit opt-in, evidence-gated Mac backend preview, independently gated Linux preview, then stable per backend. Backend support is a matrix, not a single global boolean. Telemetry/audit must distinguish unsupported preflight from runtime failure and never auto-retry with broader authority.

## 13. Verification matrix

| Gate | Mandatory evidence                                                                                                                                                                                                                                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0   | Two-day 0A ledger/trap/recovery passes; 0B precedes reviewed 0F release suites and operational artifacts; both 0C Mac tracks record actual reports and two cleanup inventories; Linux non-inference is explicit.                                                                                                                                    |
| G1   | Current-tree backend release suite with zero skips; pinned toolchain/API; pre/post-load catalog tuple proof across all images and both call paths; real primitives/e2e/Compose/scanner.                                                                                                                                                             |
| G2   | Trusted outer inspect plus host/sibling/Mac canaries; no host runtime/control socket, secret, broad path, namespace, or device.                                                                                                                                                                                                                     |
| G3   | DD-STRICT first; DD-PROXY Engine 28 isolated-v4/v6 preflight then post-attach matrix; trusted byte-relay mutation/malformed/exhaustion/death tests and exact outer-MITM endpoint evidence; Apple repeats its topology. Registry-egress negatives (unlisted registry, credentialed endpoint, redirect abuse, oversize) run wherever §6.4 is enabled. |
| G4   | `profile-ceiling.json` subset proof, denial/reviewer evidence, fresh cumulative P0-P4 runs and full frozen tuple; immutable outer cgroup; absolute stops; ECI/Sysbox never qualifies baseline.                                                                                                                                                      |
| G5   | Provisioning/env/filesystem/image scans and supported two-MITM bootstrap tests; direct outer-fake/proxy use is an accepted collusion fixture; outer MITM alone is authoritative and holds real secrets/CA key. Workload-registry pulls are anonymous-only with resolved digests audited.                                                            |
| G6   | Desktop/Linux immutable ancestor/migration negatives including relay reserve; Apple CPU/memory/fork pressure; desired/required PID behavior; watchdog pre-start/post-inventory lifecycle, death/recovery/coverage/overshoot tests; frozen watchdog state thresholds.                                                                                |
| G7   | Host-only lease, `SIGKILL`/restart/API-loss/live-newer/foreign-preservation faults, nested heartbeat cessation, exact outer deletion, state/relay removal, recovery bound, and two empty inventories. Apple faults never kill the shared apiserver.                                                                                                 |
| G8   | Feature-off create-argument/effective-plan snapshots and targeted Docker/Apple/builtin/workflow e2e; no IronCurtain-provisioned daemon/API/state/mount/relay/profile/resource action. Static image tooling and self-launched processes inside the unchanged VM envelope are allowed.                                                                |
| G9   | Independent backend release-suite results plus complete G1-G10 rerun through actual CLI/UI/session/entrypoint/resume before each advertised variant preview; Linux runs LX-B/LX-F/LX-C first.                                                                                                                                                       |
| G10  | Every blocker is terminal/no-override and clears only after an implementation fix or reviewed design change and a full rerun; fallback tests exclude host sockets, outer privilege, direct registry/network, and broker fallback.                                                                                                                   |

## 14. Transition from the broker-first design

| Former goal/design                          | Disposition                                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Early Mac no-descendant utility             | Retained in 0F common bootstrap work; no longer presented as the Docker goal.                                                                                  |
| Per-operation semantic broker authorization | Dropped for Docker capability; optional future stronger mode.                                                                                                  |
| Authenticated caller/mutation audit         | Replaced by bundle enablement, host lifecycle, ingress, egress, profile, and resource audit.                                                                   |
| Per-descendant mount handles                | Replaced by exact outer daemon/VM mount confinement and arbitrary bundle-visible inner mounts.                                                                 |
| No inner networking                         | Replaced by arbitrary bundle-internal networks with outer egress confinement.                                                                                  |
| Credential non-provisioning                 | Retained.                                                                                                                                                      |
| Immutable approved inner images only        | Replaced by a trusted immutable infrastructure catalog at admission, §6.4 mediated anonymous workload pulls, and untrusted bundle-local build/load/tag/commit. |
| Exact inner cleanup and broker WAL          | Replaced by exact outer sidecar/VM teardown and ephemeral state-root removal.                                                                                  |
| Normal-session equivalence                  | Retained.                                                                                                                                                      |
| Linux-first proof                           | Reordered: Mac spike first because it is the available system; Linux remains independently mandatory before Linux support.                                     |
| Select only one Mac backend                 | Replaced by independent Docker Desktop and Apple support gates; both are product goals.                                                                        |
| No weaker fallback                          | Retained and sharpened.                                                                                                                                        |

## 15. Decisions, residual risks, and open product questions

### Decided

1. Exact workspace-root exposure is acceptable: the repository is one colluding authority domain.
2. Agent, daemon, targets, scanners, and descendants are not isolated from one another.
3. Real Docker compatibility and existing daemon-facing integration tests are required.
4. Initial daemon state is ephemeral and bundle-private.
5. Infrastructure images use the trusted preloaded catalog. Workload images may additionally use §6.4 anonymous public-registry egress (user-approved amendment, 2026-07-21); credentialed and private registries remain Phase 3. Hermetic builds are offline; only current IronCurtain Dockerfiles get 0F's narrow fixed-destination build egress. Generic non-registry egress is Phase 4.
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

### 16.1 Historical record (non-normative)

The previous design was created through architecture, threat, feasibility, adversarial, judge, and integrator passes. It selected a semantic broker and rejected rootless DinD. A later design review correctly found that the broker delayed macOS dogfooding, could not run the real Docker integration path, overbuilt per-operation transport/transaction guarantees for a trusted-host threat model, and omitted an adequate record of the rootless-DinD tradeoff.

That review remains useful history but its broker requirements are not normative for this plan.

### 16.2 Replacement design inputs

- **User threat-model correction:** the accepted outer Docker container or Apple VM is the security boundary; requiring a stronger inner host-authorization boundary confused the goal and drove unnecessary complexity.
- **Architecture designer:** selected the Docker-capable bundle authority domain, non-privileged rootless sidecars for Linux/Desktop, Docker inside the Apple VM, outer-authoritative evidence, preloaded OCI ingress, and real Docker compatibility.
- **Mac spike designer:** produced independent falsification-first Docker Desktop and rootless-first/evidence-gated-rootful Apple experiments, stop gates, negative probes, repository tests, evidence manifests, and Linux non-inference rules.
- **Integrator:** reconciled the need for inner bridge networking with a network-confined outer namespace/VM, kept provider origin semantics, limited profile changes to the daemon, and converted the proposals into measurable phases and gates.

### 16.3 First rootless-bundle adjudication (historical, non-normative)

- **Architecture/security/feasibility reviewers:** `CHANGES REQUIRED`. They challenged API/exchange-root conflation, Desktop internal-network gateway reachability, an overstrong two-MITM traversal claim, open-ended profile discovery, Apple PID enforcement, unpinned clients/tests/images, observed-only disk ambiguity, underspecified host-lease recovery, unsafe Apple helper faulting, disabled-mode image wording, monolithic Phase 0, non-deterministic scanner acceptance, sequential platform phases, and assumed Apple init ordering.
- **Judge:** `APPROVE AFTER CHANGES`. Binding dispositions then included split roots, DD-STRICT/DD-PROXY, narrower credential claims, an earlier profile-discovery rule, an attempted Apple guest-PID control, pinned tools/fixtures, observed-disk policy, host-lease recovery, and the first Phase 0 split. The Apple PID and phase/profile details are superseded below.
- **Integrator:** complete. The dispositions are integrated into the normative goal, architecture, Phase 0 protocol, lifecycle, code map, rollout, verification, decisions, and references without changing the accepted rootless-bundle authority model.
- **Then-current disposition:** approved after integration. Its Apple PID and phase-order language is superseded by §16.4.

### 16.4 User-approved correction review

- **Review:** `CHANGES REQUIRED`. The accepted review found that Apple guest PID enforcement was not host-authoritative; profile exploration lacked a finite cumulative ceiling; shared-Desktop residual risk and the DD relay TCB were underspecified; observed-disk/vfs lacked a mandatory pre-0C watchdog and performance budget; universal test parity hid backend adaptations; cgroup and UID claims lacked escape/cooperation probes; preloaded image identity/build fallback was too weak; current Dockerfiles were incorrectly treated as offline; and Phase 0A had grown beyond a useful spike.
- **Designer corrections accepted by user:** Apple PIDs become unsupported/advisory with host/foreign-VM fork-pressure evidence; P0-P4 is finite and hash/version scoped; ECI/Sysbox are separate environments; DD relay and UI risk are explicit; watchdog and performance budgets precede 0C; per-variant contracts freeze required/adapted/N/A/blocker dispositions; immutable cgroup ancestry and UID workspace cooperation are proved; preloaded catalog has exact immutable identity and no-build fallback; current Dockerfiles use narrow 0F egress; and the DAG is `0A -> 0B -> 0F -> 0C -> 1 -> 2-* -> 3 -> 4`.
- **Judge binding adjudication:** `APPROVE AFTER INTEGRATION`. It further required the <=3600-byte goal; explicit relay/catalog/watchdog/resolved-config TCB; Engine-28-only DD-PROXY; checked-in subset-only profile ceiling; coordinator-surviving watchdog lifecycle; relay resource accounting; desired/required PID config; implementation-qualified 0C semantics and full product-entrypoint reruns; complete early image-mode branching and catalog tuple; terminal concrete-variant blockers including Goose; frozen BuildKit-seam egress manifest; canonical evidence root; and exact pre/post-create lease identity.
- **Integrator actions:** applied both correction rounds throughout the goal, TCB, architecture, resources, Phase 0 protocol, product DAG, image/build paths, code/config maps, verification, decisions, and references. Removed stale preview qualification, relay compromise testing, alternate DD-PROXY boundary, scalar PID config, partial product-gate exits, and Phase 1 catalog-loader wording.
- **Root validation and disposition:** `APPROVED FOR PHASE 0A`. Root validation corrected watchdog ordering, exact create identity, cgroup stop wording, contract layout, Goose inventory, profile tuple, and stale qualification language; then verified goal size, formatting, local links, referenced tests, and working-tree scope. Approval covers only the timeboxed spike harness; 0C yields an implementation-qualified candidate, and no backend reaches preview before its Phase 2 G1-G10 rerun. The adjudication raises no new user decision.

### 16.5 Workload-registry promotion (user-approved, 2026-07-21)

- **User direction:** the operator burden of staging every workload image through the frozen catalog is not justified by the threat model. A pulled workload image runs as the already-untrusted bundle, exactly like a package installed through the mediated package path; forcing workload images through TCB-image machinery added complexity without a matching security claim.
- **Dispositions:** the preloaded catalog is retained unchanged for trusted infrastructure images (base, agent, nested-daemon, helper, fixed-relay, socat), whose identity is bound into qualification evidence. Target/scanner fixtures stay pinned sealed archives owned by the qualification harness so 0C evidence remains deterministic and offline. Workload images gain the §6.4 anonymous, manifest-frozen, URL/operation-gated registry path, promoted from Phase 3; Phase 3 narrows to credentialed/private ingress. The /goal text is unchanged: G1 (infrastructure catalog integrity), G3 (fixed-proxy-only egress), and G5 (no credential provisioning) remain true under the amendment.
- **New TCB surface acknowledged:** the registry-aware proxy handler joins the trusted network TCB and requires its own frozen `registry-egress-manifest.json`, hermetic protocol fixtures, and 0C negatives before any preview. Client-origin URL gating plus exact derived-redirect authorization, credential stripping, destination-bound SSRF checks, finite hops, and transfer ceilings constrain authority; provenance recording, not content trust, is the claim for pulled images.
- **Code follow-ups:** narrow the catalog builder's required role set to the infrastructure images; move the vulnerability-fixture archives to the qualification harness staging path; add `registry-egress-policy.ts` and the manifest; plumb `imageIngress: 'public-registry'` as strict opt-in.

### 16.6 Workload-registry content-integrity correction (user-approved, 2026-07-21)

- **Correction:** host-side hashing of workload manifests/blobs and verify-before-release buffering are not required security controls. Workload image bytes are already untrusted bundle input, the bundle can synthesize arbitrary images locally, and a registry can select a malicious manifest with matching content. Blob integrity therefore does not constrain outer authority.
- **Binding redirect rule:** an unlisted CDN is reachable only through the trusted proxy's immediate handling of an exact redirect returned by an authorized registry pull. The derived request is HTTPS `GET`/`HEAD`, public-address checked, header/credential stripped, bounded, audited, and unavailable for direct bundle selection or later reuse. This is URL-derived authorization, not a general CDN allowlist.
- **Evidence disposition:** requested references, final destinations, and registry-reported or optionally computed manifest digests are provenance only. Docker's own digest validation is bundle-local. Trusted infrastructure archives and catalog entries retain their independent mandatory hashes under §7.1.
- **Implementation consequence:** remove trusted blob hashing, verify-before-release buffering/spooling, and digest-mismatch qualification gates. Preserve digest syntax parsing where needed for pull-path classification and audit, and replace those tests with derived-redirect, credential stripping, SSRF, streaming backpressure, and byte/time/concurrency ceiling gates.

### 16.7 Post-freeze module consolidations (record, 2026-07-22)

Four post-freeze `/simplify` refactors deduplicated security-critical code that had been copy-pasted across the nested-runtime TCB. Each was differential-audited to be behavior- and security-identical, and the full docker suites plus the egress gates (registry live 16/16, build offline) stayed green.

- **Shared hardened-fs / hash / zod leaves** (`cd2a141`): extracted `src/hardened-fs.ts` (`readHardenedFile`, `loadImmutableHostJson`, `writeStableJsonAtomic`, `assertCanonicalHostPath`) and `src/zod-helpers.ts` (`HEADER_NAME_REGEX`, `addDuplicateIssues`, shared schema fragments), and added `sha256Hex`/`sha256HexSchema` to `src/hash.ts` — one copy of the hardened loader/atomic-writer/canonical-path-guard/sha256/zod primitives instead of the many that were pasted across the TCB. Also dropped the watchdog per-tick zod re-parse and swapped per-header `safeParse` for a `HEADER_NAME_REGEX` test on the egress hot paths.
- **Shared egress forwarding helpers** (`01be37b`): extracted `src/docker/egress-forwarding.ts` (`buildRequestUrl`, `toOutgoingHeaders`, `sanitizeResponseHeaders`) shared by both egress proxies; collapsed a double-stored bundle handle to getters and deleted the dead `ensureImage` export (callers use `resolveAgentImage(...).buildHash`) plus two provably-dead defensive clauses.
- **One mediated egress forwarder** (`c2d7b65`): the two near-duplicate credential-free forwarders became one `src/docker/mediated-egress.ts` (backpressured streaming, per-request byte/time ceilings, optional session ledger, optional internal redirect-following, fail-closed rejection); `registry-egress-proxy.ts` and `build-egress-proxy.ts` are now thin callers (registry passes session-ledger + follow-redirect + provenance; build passes only its fixed-parent transport-binding check, so 3xx passes through to the client). Build additionally gained backpressure and an absolute deadline it had lacked.
- **One resolved MITM listener mode** (`1cade7d`): the per-instance build-egress/registry-egress flags, the mutual-exclusion throw, two redundant `ConnectionMeta` booleans, and the connType ternary collapsed into an internal `ListenerMode` union (`'standard' | 'build-egress' | 'registry-egress'`) resolved once by `resolveListenerMode` and dispatched by a switch with a compile-time `never` exhaustiveness guard. The public `MitmProxyOptions` shape is unchanged.

The unified credential-free mediated forwarder is deliberately kept **separate** from the credential-injecting provider path (the fake→real key swap): real provider secrets never share the workload-egress code path. Two code-quality items remain deferred — a shared OCI tar-reader leaf, and merging the `revokeContainer`/`revokeNetwork` revocation strategies — and `canonicalJson` (in `preloaded-image-catalog.ts`) was deliberately **not** folded into `stableStringify` because it feeds the frozen catalog digest.

### 16.8 Base-image mediation correction and qualification-contract freeze (record, 2026-07-23)

Two Phase-0F-exit items closed on the way to Phase 1. **Base-image seam correction:** the plan's
original "daemon-layer `base-image` seam in the build-egress manifest" was verified against the code and
corrected — a `FROM` pull bypasses the build-egress proxy entirely (that proxy is `--build-arg`-wired
into `RUN` steps; the daemon resolves `FROM` out-of-band), and the build-egress schema cannot carry a
registry pull because it unconditionally rejects an `authorization` header fail-closed, breaking Docker
Hub's anonymous token dance. Base-image mediation is the already-frozen registry-egress path (§6.4), which is repo-agnostic
within its origins and so authorizes `node:22-trixie` (`library/node`) with no manifest change; a
committed registry-egress test now asserts that manifest/blob/token path; the `FROM` digest-pin is
deferred to the next catalog re-freeze; no frozen artifact was touched. **Historical qualification-
contract freeze (superseded by §16.12):** the `apple-container`/`arm64` contract was frozen with
artifact-hash bindings and a freeze-guard test. It was never a runtime control and is removed by the
later bookkeeping simplification.

### 16.9 Qualification scope correction — release control, not session control (historical record, superseded by §16.12)

Review of the freeze recorded in §16.8 found the qualification machinery had over-reached beyond its
release-process purpose, and it was cut back the same day. The defect: `qualificationContractSha256` was
a field of `DockerWorkloadAdmissionBindings` and of the bundle lease, and
`admitDockerWorkload` used it as the fallback default for `configHash` — a frozen test-plan hash
standing in as a runtime config identity. Nothing on the live path ever verified it (the contract is
loaded only by the offline runner; `session/`, `workflow/`, and the agent session never reference
qualification), so it was provenance wearing the costume of a control, and it risked being read as part
of the isolation boundary. Corrections applied:

- **Removed the contract hash from the runtime path.** It is gone from the admission bindings, the
  lease, and the placeholder bindings; `configHash` is now required, so every caller states its config
  identity explicitly. The one production caller already passed a genuine `dockerWorkloadConfigHash`, so
  no production behavior changed — the fallback was exercised only by tests. It was then retained in
  the generated qualification **evidence** record. Section 16.12 removes that
  remaining binding.
- **Bound counts, not names.** Each command now binds its test-file set plus an exact
  `expectedTestCount` instead of enumerating every `file::fullName#occurrence` ID; the frozen apple
  contract dropped from 287 to 138 lines (25.8 KB → 7.6 KB) and the adjudicator lost its one non-obvious
  algorithm (an index-correlated per-file occurrence map). Rationale and the residual trade are recorded
  normatively in §9.5.
- **Made the release gate explicit.** `npm run qualify:apple` (`scripts/qualify-backend.ts`) drives a
  frozen contract end to end — every executable command through the pinned Vitest entrypoint, each run
  self-adjudicated, then `verifyQualificationRunSet` for set completeness — and writes hash-bound
  evidence. It subsumed and replaced a zero-referrer spike verifier.

This was an intermediate correction. Section 16.12 keeps the release/session separation but removes
the pre-registered, commit-bound contract itself.

### 16.10 Same-VM daemon topology — implemented, with live corrections (record, 2026-07-29)

Phase 1 implemented the nested daemon lifecycle on the only backend with qualification evidence, Apple
`container`, using §4.4 **variant 1**: rootless dockerd inside the agent's own per-session VM. A sibling
daemon VM was considered and rejected: it would have required relaying the Docker API out of the daemon
VM and back into the agent VM, which §5.3 forbids ("never publish it outside the VM"). Because there is
no separate daemon container, the _agent_ create is the §8.2 step-4 daemon-component create; the
watchdog-freshness gate was therefore generalized from a role-name set to a per-create predicate that
`createLedgeredAgentContainer` derives, so an ordinary session stays ungated and a same-VM session
cannot forget the gate.

Two live-gate findings corrected assumptions that unit tests could not reach. Both were found by booting
the real rebuilt image in a real VM under the product capability set.

- **The id-map helpers must carry file capabilities, not the setuid bit.** Writing a multi-range
  `uid_map` requires `CAP_SYS_ADMIN` _in the target user namespace_. The kernel grants all capabilities
  in a namespace to a process whose euid owns that namespace, and rootlesskit creates it as the runtime
  user — so an euid-1000 helper is privileged there for free. Debian's `uidmap` package ships
  `newuidmap`/`newgidmap` **setuid-root**, which forfeits that grant and then demands real
  `CAP_SYS_ADMIN`, absent from the VM's clamped bounding set (`CapBnd 0xc0`). Adding `CAP_DAC_OVERRIDE`
  only moves the failure from `open` to `write`, and adding `CAP_SYS_ADMIN` would breach the frozen P1
  ceiling. The base image therefore applies `cap_setuid+ep`/`cap_setgid+ep` and **removes** the setuid
  bit, matching what the frozen `nested-daemon` image already shipped. This is strictly less privilege,
  not more; §2.3's P1 row should be read as "id-mapping helpers", not specifically "setuid helpers".
- **No step of the bootstrap can run as root.** The VM's bounding set has no `CAP_CHOWN`, so a runtime
  `install -d -o 1000` is impossible. Since `/run` is ext4 in the VM rather than a tmpfs, the API root is
  created by the image (as `/run/ironcurtain` already is) and the bootstrap only verifies it. Per §5.3 the
  verification is a real mode-check that does not follow symlinks — a tampered writable layer, which
  snapshot resume would persist, must not be able to redirect the API root onto a host-backed mount.

**Accepted consequence — the toolchain ships to every arm64 agent image.** `Dockerfile.base.arm64` is
selected by architecture alone, not by backend or by the `dockerWorkload` flag, so all arm64 agent
containers now carry the Docker client, plugins, and daemon binaries (about +400 MB) plus the subordinate
range and id-map helpers. On Docker Desktop this is inert (default seccomp denies `unshare`). On Apple it
means an untrusted agent can start a rootless daemon in a session that never opted in — bounded by its
own disposable `--network none` VM, and not a new resource channel, since that agent can already consume
VM disk directly. Conditional host-side staging was considered and rejected as complexity that does not
buy a proportionate guarantee. Consequently the `base` catalog role no longer declares an empty toolchain
tuple, and §9.2's "client-only agent layer" holds only for the sibling-daemon topologies: same-VM
necessarily places the daemon binaries in the agent image. G8 therefore constrains only authority and
resources IronCurtain provisions when the capability is enabled; it does not attempt to prohibit arbitrary
self-launched processes inside an otherwise unchanged disposable VM.

### 16.11 Performance-budget machinery removed (record, 2026-07-30)

The performance budget was deleted outright: `src/docker/performance-budget.ts`, its unit test, the frozen
`test/docker-workload/performance-budget.apple-rootless-vfs-arm64.json`, and the `performanceBudgetSha256`
field of the qualification contract, the bundle lease, the admission bindings, and the qualification-evidence
manifest. The §8.1 freeze mandate is withdrawn above.

**Reasoning.** A performance budget is a file of timeouts and CI durations, not a security property. Under
this project's threat model the host is trusted and single-operator, so hash-binding a timeout file protects
against nobody: there is no adversary who can edit the file but not the code that reads it. Verified before
deciding: the module had zero production importers (only its own unit test), `assertPerformanceWithinBudget`
was never called outside tests, `scripts/qualify-backend.ts` never loaded or enforced it, and of the lease
binding fields only `watchdogPolicySha256` was ever read back — `performanceBudgetSha256` was written at
admission and never consulted. Its admission value was additionally a synthetic namespaced placeholder, so it
recorded nothing real.

Consequences:

- **Admission bindings now contain only real operational values.** The remaining three (catalog, profile
  ceiling, toolchain digest) are all derived from inputs the session actually uses. The unused placeholder
  mechanism and its provenance field were removed; a future binding must not be added until it can be
  sourced honestly.
- **`APPLE_VM_DAEMON_READINESS_TIMEOUT_MS = 90_000` is retained as a plain reviewed constant** in
  `session-daemon.ts`. It no longer mirrors a frozen artifact and its freeze-guard test is gone.
- **State-growth enforcement is untouched.** Peak owned state, host reserve, and post-teardown retained
  state live in the frozen `resource-watchdog-policy.json` and are enforced by the supervisor. Only the
  duration ceilings and their duplicate copy of the state numbers went away.
- **Historical note, superseded by §16.12:** the contract was retained at this point to name suites and
  hash-pin release inputs. The later review found that bookkeeping too fragile for development and not a
  meaningful security boundary.

Wherever the historical text above still lists a frozen performance budget among 0F artifacts, 0C measurements,
evidence inputs, or gate criteria (§3 G6/G10, §9.1 0A exit, §9.4, §9.6, §9.7, §10 Phase 1 and LX-F, §13
G0/G6, §15 open question 5), that obligation is withdrawn on the same reasoning.

### 16.12 Commit-bound qualification contracts removed (record, 2026-08-11)

The user rejected the remaining commit-bound qualification contract as fragile bookkeeping without a
meaningful security benefit. That assessment is accepted. A trusted single-operator release process can
edit the contract, runner, and source together; hashing one of those files does not constrain an attacker
or establish the runtime isolation boundary. Binding `sourceCommit` also creates a self-referential
workflow: changing qualification bookkeeping changes the commit being qualified, and ordinary source/test
development requires repeated contract churn before the tests can run.

The replacement is deliberately conventional:

- `npm run qualify:<backend>` runs a reviewed set of test files from the current checkout using the
  repository-pinned test runner.
- The command fails on failed tests, missing suites, zero tests, or skip/pending/todo in the backend
  suite. It does not freeze an exact count or test-name inventory.
- Git revision and dirty status, platform/tool versions, operational artifact hashes, actual test output,
  and cleanup inventories may be written after the run as diagnostic provenance. They are observations,
  not credentials, and no generated report is required to admit a session.
- Backend differences live in reviewed release commands, tests, this design, and the support matrix. A
  machine-readable N/A adjudication database is not required.
- Runtime admission continues to hash-bind inputs that directly determine behavior: resolved config,
  infrastructure catalog, profile ceiling, toolchain, relay, watchdog policy, and egress manifests.

Consequently the frozen qualification-contract JSON, contract parser/adjudicator, run-set verifier,
freeze-guard, and hash-bound qualification-evidence machinery are deleted. Section 16.14 later replaces
the global fuse with one explicit Apple developer-only admission predicate; removing bookkeeping itself
did not qualify or enable a backend.

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

### 16.14 Apple developer-slice admission and built-CLI smoke (record, 2026-08-11)

The global boolean fuse is replaced by a shared resolved-variant guard used at both image and
infrastructure seams. Feature-off sessions retain their prior profile/adapter/runtime ordering. An
enabled request resolves the effective runtime, matches the exact §12 predicate, and then performs a
read-only Apple availability check before any feature-attributable runtime construction, image/catalog
work, proxy, lease, or filesystem provisioning. Direct preparation callers receive the same check.

The outer Apple VM takes CPU and memory from `dockerWorkload.resources` through one clamping helper used
by batch and PTY paths; feature-off sessions continue to use `dockerResources`. Batch and PTY atomically
merge the admitted lease tuple into the existing session metadata. PTY teardown retires proxies and the
per-bundle runtime socket tree even when outer-resource cleanup verification throws.

Apple Container 1.1 accepts only the local catalog logical tag for `container create`; passing its
verified `sha256:` index ID is treated as a registry reference and can attempt a fetch. Resolution still
retains that immutable ID as the identity/evidence. Immediately after the stopped create, the shared
batch/PTY ledger path inspects the exact VM and compares `configuration.image.descriptor.digest` with
the already-resolved catalog ID before start. A missing or mismatched descriptor causes exact-ID removal
and the VM never starts. Apple 1.1 has no authoritative no-fetch create flag, so trusted operators must
not rotate or retag the catalog image during admission; this residual trusted-host race is not an
untrusted-workload bypass. Docker continues to create by immutable ID.

`npm run smoke:nested:apple` builds and invokes the real `dist/cli.js start` entrypoint with a private
temporary `IRONCURTAIN_HOME`, config, workspace, exact staged catalog pair, and only the selected agent
archive. It holds the no-task interactive session open, derives the lease and immutable outer VM ID only
from persisted metadata, invokes the absolute pinned Docker client against the VM-private UDS, proves
rootless+`vfs`, verifies the selected image ID, and uses the production OCI verifier before loading and
running the catalog helper image under no-network/read-only/cap-drop/no-new-privileges controls. Graceful
`/quit` must then produce exact immutable-ID absence, a closed lease with two empty inventories and the
required gap, absent state and runtime roots, and a closed/exited watchdog. Failure retains the private
temp root for diagnosis but retires the isolated multi-gigabyte archive link. Success removes it. This is
a mandatory built-CLI/session-initialization and nested-Docker smoke before opening the developer slice;
it is not an agent turn, provider protocol, or PTY test, and does not prove a non-empty Claude TUI stream,
the complete G1-G10/0C run, or preview qualification.

The complementary manual live gate, `npm run smoke:nested:apple:pty`, uses production
`createPtyBridge`/node-pty to spawn the built `start --pty --agent claude-code` entrypoint. It reuses the
same isolated home, exact catalogs, selected archive, and workspace contract. The harness does not probe
or connect to the agent socket: with the production `socat,fork` listener, such a probe would itself
launch an agent and invalidate the result. It waits for the persisted lease to become `active`, begins its
evidence window only then, requests a normal terminal resize redraw, and requires both the Claude Code
title and rendered TUI frame in newly emitted bytes. Zero post-activation bytes, startup logs that merely
name Claude Code, or a socket/session inode fail. It also proves rootless+`vfs`, the selected inner image
ID, graceful `/exit`, exact outer-ID absence, two empty inventories, state/runtime-root removal, watchdog
closure, and no provider request. Its bounded evidence buffer, activation/TUI/exit/cleanup timeouts,
forced cleanup fallback, failure diagnostics retention, and large-link retirement are mandatory.

Prerequisites are macOS/Apple silicon with Apple Container 1.1 services running and the current frozen
catalog pair plus sealed selected-agent archive installed read-only under the operator's normal
`IRONCURTAIN_HOME`. No real provider/OAuth credential or agent turn is part of this gate: the isolated
configuration uses a fake key and fails if provider traffic occurs. This gate validates the real PTY
startup surface but still does not prove a provider protocol, useful agent turn, the complete G1-G10/0C
run, or preview qualification.

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
