# Secure Nested Runtime Handoff

**Updated:** 2026-09-03
**Baseline:** `master` after PR #457 at `01d4687`
**Primary design:** [`secure-nested-runtime-implementation-plan.md`](./secure-nested-runtime-implementation-plan.md)
**Package-network design:**
[`secure-nested-runtime-public-network.md`](./secure-nested-runtime-public-network.md)
**Self-hosting slice:**
[`ironcurtain-in-ironcurtain-hermetic-slice.md`](./ironcurtain-in-ironcurtain-hermetic-slice.md)

## Objective

Give a Docker Agent session on either macOS backend a real, private Docker daemon that can:

1. pull an allowed public workload image through host-mediated registry egress;
2. create an inner-only Docker bridge;
3. run a server container;
4. let a sibling container reach the server by Docker DNS alias; and
5. tear down the complete outer bundle without exposing a host Docker socket, direct public route, credential, or host port.

The current production code implements this Docker-workload objective for both Apple Container and Docker
Desktop. It supports `offline`, `images`, and `packages` network modes. Docker Hub/GHCR image traffic and
fixed apt/npm/PyPI/Cargo package traffic are mediated by host policy engines; there is no direct public
route from the untrusted agent or private daemon.

The 2026-08-15 threat-model correction treats every bundle image as untrusted and keeps host
create/profile, proxy, watchdog, and cleanup controls as the authority. Obsolete catalog generation,
pairing, and freshness tooling is removed; Git history retains that qualification experiment. The Docker
substrate and its Docker Desktop developer release gate are implemented. The controlled
IronCurtain-inside-IronCurtain provider/child-session gate and preview qualification remain separate work.

## Current Working State

The macOS developer capability is opt-in and available through `containerRuntime: "apple-container"`,
`containerRuntime: "docker"`, or `auto` after runtime availability checks. Fresh enablement selects
`packages`; existing configurations migrate conservatively to `images` or `offline` as documented in
`CONFIG.md`.

Both backends share admission, lease/watchdog ownership, network-mode resolution, egress policy engines,
build-shim contracts, activation ordering, and exact cleanup. Their unavoidable runtime mechanics differ:

- Apple runs rootless Docker inside the per-session VM and transports the selected current-agent image
  into that daemon with a verified archive.
- Docker Desktop runs a separately constrained rootless daemon sidecar, shares a lease-owned Docker API
  volume and the exact session workspace with the agent, and uses independently pinned fixed relays for
  networked modes. The workspace is compatibility state inside the already-colluding bundle, not a host
  authority boundary.
- Docker Desktop relay containers join the default bridge only for their host-gateway hop. The agent and
  daemon do not. The pinned relay plus exact target configuration is the enforcement point; default-bridge
  NAT/L2 adjacency is an accepted residual risk recorded in the primary design.

The supported product envelope is still developer-only:

- daemon and image-cache state is ephemeral between sessions;
- host publication is disabled, so nested `-p` does not publish to the Mac;
- package authority is limited to fixed public repositories;
- private/authenticated registries and package sources are unavailable;
- Compose may run already-built images on the managed network, but Compose builds that would bypass the
  supported direct/default-Buildx package shim are rejected;
- disk enforcement is watchdog-observed rather than a hard quota; and
- native Linux, IronCurtain-in-IronCurtain, and preview/stable qualification are separate work.

## What Is Implemented

### Private Docker lifecycle

- Each admitted bundle receives one disposable rootless Docker 29.2.1 daemon and one fixed internal
  `ironcurtain` network.
- Apple keeps the daemon inside the agent VM over a private UDS. RootlessKit remains
  `--net=none --disable-host-loopback`; the outer VM remains `network=none`.
- Docker Desktop keeps the daemon in a dedicated sidecar with a lease-owned API/data volume, read-only
  root filesystem, reviewed seccomp/system-path profile, aggregate CPU/memory/PID partition, no host
  runtime socket, and no host port publication.
- Dockerd has no default bridge and is configured with `--iptables=false --bridge=none`; only the managed
  internal network is admitted for ordinary nested service traffic.
- The Apple bootstrap sets and reads back `net.ipv4.ip_forward=1` only inside RootlessKit's private network namespace so user-defined inner bridges work.
- The Apple base image installs Debian's legacy iptables implementation. The daemon's private PATH selects:

  ```text
  /usr/local/lib/ironcurtain-docker/bin/iptables
    -> /usr/sbin/iptables-legacy
  iptables v1.8.11 (legacy)
  ```

  This supplies Moby's per-sandbox `127.0.0.11` DNS rules. It does not enable daemon-wide bridge rules or add an outer uplink.

### Registry and package egress

- `images` and `packages` create one host-owned registry listener per bundle; `packages` adds a separate
  fixed-host package listener and build-trust contract.
- Apple mounts the exact listener UDS files and runs the checked-in fixed-profile relay inside
  RootlessKit's namespace on `127.0.0.1:18081`/`:18082`.
- Docker Desktop uses independently pinned, fixed-target relays with one isolated bundle address each.
  Relay-to-host TCP listeners require both exact source admission and a per-bundle proxy authorization;
  construction fails closed if either guard is absent.
- Registry relay connections retain an idle/byte envelope but no relay-level absolute timer because one
  Docker connection may carry multiple independently bounded requests; package connections retain their
  own finite absolute envelope. Both remain accounted until the downstream TCP socket actually closes.
- Only dockerd receives registry proxy authority. In `packages`, supported direct/default-Buildx builds
  receive the dedicated package authority through the checked-in Docker/runc shims; arbitrary container
  traffic does not.
- The host listener uses direct destination-bound transport with local DNS/SSRF adjudication. There is no generic or direct fallback.
- CONNECT authority parsing is canonical and exact; registry mode requires an allowed host/port and SNI equal to the CONNECT host before certificate generation.
- The frozen manifest gates origins, methods, paths, queries, request headers, redirects, concurrency, bytes, and time. Push, delete, catalog/tag enumeration, unlisted origins, private/local addresses, and over-limit transfers fail closed.
- The package listener admits only fixed apt/npm/PyPI/Cargo GET/HEAD grammars, rejects recognized
  credentials and request bodies, and records a bounded package audit. Package mode still permits bounded
  exfiltration through allowed paths, canonicalized request metadata, and timing.
- IronCurtain injects no registry/package credential and configures no private registry. A bundle-supplied
  syntactically valid Bearer token can reach only a listed registry origin; the proxy cannot prove such a
  token was anonymously issued.

### Lifecycle and cleanup

- Listener/relay creation, daemon bootstrap, build canary, workload activation, and PTY attachment are
  ordered so the agent is not released before the private daemon is admitted.
- Listener shutdown participates in batch, PTY, prepare-failure, and exact bundle teardown paths.
- Leases, watchdog supervision, serialized cleanup ownership, incident recovery, exact immutable outer
  IDs, generation labels, and two empty cleanup inventories remain the host authority. On Docker Desktop,
  the agent, daemon, fixed relays, ordinary TCP transport proxy, and both transport/egress networks share
  this one authority instead of overlapping generic owner records.
- The detached watchdog removes the exact ordinary bundle runtime tree as well as the nested-Docker state.
  Stdio MCP relays treat controlling-pipe EOF as owner loss and reap their backend subprocesses, so a killed
  coordinator does not retain host helpers or hold the qualification runner open.
- Shared lifecycle tests, Apple workflow smokes, and the Docker Desktop release suite prove exact
  owned-resource cleanup while preserving foreign objects.

### Catalog retirement and selected-current disposition

Generation v3 proved archive canonicalization and cross-backend loading, but its eight bundle roles never
constrained the colluding bundle. Catalog generation, pairing, freshness checks, and staged copies are now
removed from the current tree. Production resolves/builds the selected current agent once. Apple derives
a stable outer reference and Docker-compatible archive from that resolution; Docker Desktop creates the
agent directly from the immutable outer image ID and intentionally starts its private daemon with an empty
image store. Archive checksums and validation are Apple transport-integrity controls, not guest
attestation. Tolerant lease parsing remains solely for exact recovery of historical leases. Docker
Desktop's authority-bearing relay remains independently digest/config pinned because it owns network
authority unavailable to the bundle.

## Required User Configuration

The smallest accepted compatibility configuration is:

```json
{
  "dockerWorkload": {
    "enabled": true
  }
}
```

An existing enabled block with no network choice resolves conservatively to `images`. `containerRuntime`
may remain `auto` or select either macOS backend explicitly. Enabling nested Docker through the current
CLI/web settings writes `networkAccess: "packages"`; it does not grant generic
network access. Select `"images"` for Docker Hub/GHCR only or `"offline"` for no public image/package
access. The observed-disk
watchdog policy and other internal invariants no longer require operator boilerplate. Numeric
`dockerResources.memoryMb` and `dockerResources.cpus` values feed the aggregate outer budget; `null` uses
safe nested fallbacks. Legacy `dockerWorkload.resources` overrides are rejected rather than silently
creating a second resource envelope.

Normal operator entrypoint:

```bash
tsx src/cli.ts mux
```

Create a session with `/new`. Inside the Claude session, `docker info` should report the private rootless daemon. Workload servers are reachable from sibling containers on an inner Docker network, not from the Mac host.

### Offline image import

Docker Desktop deliberately starts every private daemon with an empty image store. `offline` means no
registry or package route; it does not automatically copy the multi-gigabyte outer agent image into the
private daemon. Put any required image archive in the session or persona host workspace before or while
the offline session runs. For example, on the Mac:

```bash
workspace_path=/absolute/path/to/ironcurtain-workspace
mkdir -p "$workspace_path/images"
docker image save --output "$workspace_path/images/alpine-3.23.tar" alpine:3.23
```

The workspace appears at the identical `/workspace` path in the agent and Docker Desktop daemon
sidecar. Load and use the archive without a pull inside the session:

```bash
docker image load --input /workspace/images/alpine-3.23.tar
docker run --pull=never --rm alpine:3.23 echo nested-docker-offline-ok
docker build --pull=false --network=none --tag local-hermetic /workspace/path/to/context
```

This is an explicit operator data path, not automatic OCI staging or an artifact-trust decision. The
archive and loaded image are untrusted bundle inputs. `docker load` performs no registry request; the
offline qualification gate stages a small deterministic fixture archive in `/workspace`, loads it, runs
it with `--pull=never`, and proves a hermetic build while registry and package listeners remain absent.

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

### Apple Container developer release qualification

On 2026-09-03, `npm run qualify:apple` passed from the release-readiness checkout:

```text
APPLE RELEASE SUITE PASSED: 172 tests passed, 4 live gates passed, zero reporter-visible skips.
```

The source-controlled gate runs `packages`, `images`, and `offline` as separate built production
workflows. Each mode proves exact teardown and immediate same-home admission before the qualifier
continues. The final PTY gate proves activation-before-attach, Claude-TUI output, private-Docker evidence,
and exact cleanup. The first packages run exposed a stale pre-simplification outer-hostname invariant in
the privileged snapshot preflight; the retained probe and hostile-name tests now require the production
stable `ironcurtain-<12 lowercase hex>` name, and the complete qualifier passed after that correction.

### Docker Desktop developer release qualification

Prerequisites are a running Docker Desktop daemon, a host Go toolchain for the deterministic scratch-image
fixture, the built IronCurtain agent image, and network access for the `images` and `packages` gates.

On 2026-09-01, the built Docker Desktop developer path passed the operator smoke after the shared
lifecycle, relay, PTY target, and build-state initialization fixes:

```text
docker run --rm alpine:3.23 echo nested-docker-ok
nested-docker-ok

docker build --network=host ... debian:bookworm-slim ... apt-get install -y hello
docker run --rm hello-debian
Hello, world!
```

The session pulled an absent public image through registry mediation and completed a Debian package build
through the package policy engine.

On 2026-09-03, `npm run qualify:docker-desktop` passed again from the release-readiness checkout:

```text
DOCKER DESKTOP RELEASE SUITE PASSED: 238 tests passed, 6 live gates passed, zero reporter-visible skips.
```

The fixed source-controlled suite covers backend wiring, stopped-create adjudication, relay/PTY cleanup,
prepare failures, reconciliation, watchdog supervision, cross-process SIGKILL recovery, and MCP child
reaping. Its real built-CLI gates cover coordinator death plus readmission, feature disabled, a real
Docker Desktop PTY/Claude-TUI activation and graceful exit, explicit offline archive load/run/build with
shared-workspace positive and outside-workspace negative binds, mediated image pulls, and an uncached
Debian package build. The PTY gate also proves that its sole published port is the fixed container PTY
port mapped to one dynamically allocated `127.0.0.1` host port. Each gate proves exact resource cleanup
and an empty smoke process group. This is developer release evidence, not the broader preview G1-G10/0C
matrix.

### Recorded selected-current validation

At PR #454 merge, focused nested-daemon/egress regressions, the full backend and web suites, TypeScript
build, lint, formatting, cycle checks, the generated build-trust runtime check, CodeQL, Semgrep, and both
macOS/Ubuntu Node matrices passed. The exact Apple and Docker Desktop results above remain runtime
evidence; this green merge does not substitute for the broader preview/0C gates.

## Important Boundaries: Do Not Overclaim

1. **No real Claude provider turn is required for functional acceptance.** The current workflow gate runs fixed Python commands inside the real admitted workflow bundle. It exercises production workflow/infrastructure lifecycle without asking an LLM to choose or issue Docker commands.
2. **PTY/mux is transport qualification, not the Docker functional matrix.** The Docker Desktop release
   suite includes a deterministic node-pty/Claude-TUI activation and graceful-exit gate without a real
   provider turn; Apple retains `npm run smoke:nested:apple:pty`. Fixed workflow commands remain the
   functional Docker acceptance path.
3. **No host access to inner workload servers.** Agent and inner-container port publication remains
   forbidden. Docker Desktop PTY mode has one narrow control-plane exception: the transport relay maps
   only `19000/tcp` to one dynamically allocated `127.0.0.1` host port. Exposing an arbitrary inner
   server to the Mac is a separate design and implementation slice.
4. **No durable pull-provenance sink yet.** Policy enforcement exists, but successful registry provenance is not yet persisted as complete host session evidence.
5. **No hard Apple disk quota.** Enabling the admitted developer slice accepts the host-watchdog-observed disk policy; the risk remains even though the UI hides that implementation detail.
6. **macOS developer support, not cross-platform support.** Apple Container and Docker Desktop are
   implemented independently; native Linux remains fail closed until its own proof and product slice land.
7. **Not preview-qualified.** The no-skip Apple Container and Docker Desktop developer release suites
   pass, but the broader G1-G10/0C evidence and failure-injection matrix remain incomplete.
8. **Replacement public and offline gates passed.** The selected-current-agent public-registry session
   smoke passed on 2026-08-15. Deterministic public and offline production workflows passed on 2026-08-21
   with exact cleanup. A catalog refreeze is neither required nor a substitute for these gates.
9. **Private Docker is not yet the full self-hosting gate.** No current acceptance starts an inner
   IronCurtain instance, creates its normal Docker child, and proves the provider fake-key cascade through
   both MITMs. The fixed-parent outbound transport exists as a tested primitive, but product construction
   does not yet select it for an inner instance. Docker Desktop now shares the exact `/workspace` bind
   between agent and daemon; self-hosting still needs the separate bundle-scoped proxy-exchange path
   because the daemon lives in a different mount namespace.
10. **Offline is explicit import, not preload.** Docker Desktop begins with an empty private image store.
    Usable offline work requires archives under `/workspace` and `docker load`; IronCurtain does not
    automatically export or stage the selected outer agent image.
11. **Compose build/package interception is intentionally narrow.** Compose can orchestrate prebuilt
    containers on the managed external network. Compose builds, custom/remote BuildKit workers, and
    alternate Docker contexts are outside the supported package-network surface.

## Recommended Next Work

### 1. Prove IronCurtain inside IronCurtain

Implement the focused
[`ironcurtain-in-ironcurtain-hermetic-slice.md`](./ironcurtain-in-ironcurtain-hermetic-slice.md): start inner IronCurtain against the
private daemon, create one normal batch child, exercise a hermetic provider exchange through the inner and
outer MITMs, write through the exact `/workspace` mount, and prove exact cleanup without a paid provider
call. Wire the tested fixed-parent outbound transport through a trusted nested-session bootstrap and map
the inner provider's real-key slot only to the outer fake sentinel.

Apple can reuse its same-VM path equivalence. Docker Desktop now gives the colluding agent/daemon bundle
the exact shared workspace; it still needs a bundle-scoped proxy-exchange path, or an equally constrained
TCP transport, because its private daemon is a separate sidecar. This is compatibility plumbing inside
the already-colluding bundle, not a new host authority grant.

### 2. Maintain backend qualification of the three-state package-network design

Both macOS backends now have source-controlled no-skip release commands. Apple covers all three network
modes through separate production workflows, immediate same-home readmission after each, and PTY;
Docker Desktop covers feature-off, all three modes, PTY, and crash recovery. Keep both
`npm run qualify:apple` and `npm run qualify:docker-desktop` mandatory for changes to shared nested-Docker
lifecycle, transport, workspace, resource, or package-network code. The larger preview G1-G10/0C matrix
remains distinct from these developer gates.

Registry mediation lets a nested build resolve and pull its `FROM` image. Current `master` implements
the governing
[`secure-nested-runtime-public-network.md`](./secure-nested-runtime-public-network.md) design: one
`offline | images | packages` Network access control; conservative migration of existing public-registry
configs to `images`; explicit recommended `packages` persistence for fresh CLI/web enablement; and a
dedicated TLS-terminating MITM admitting only fixed apt/npm/PyPI/Cargo GET/HEAD grammars on the exact
`18082`/UDS path. The automatic direct-build/default-driver-Buildx shim injects proxy arguments plus
`--network=host`. `docker compose` builds are rejected by the shim; direct plugin binaries and custom
clients are unsupported and uninterposed rather than described as shim-rejected.

When ordinary package policy is enabled, npm, PyPI, and Cargo artifacts are checked against an exact
source-owned metadata fetch for the requested version. Debian retains the documented distro-curated,
signed-index exception: its exact parsed artifact is presented to the same deny/allow validator with an
epoch publication date, so quarantine alone does not reject an established distro package.

This is intentionally bounded **bundle-wide package authority**, not build-only provenance. A hostile
bundle can encode bounded workspace or build data into allowed package paths, canonicalized request
metadata, and timing, and downloaded bytes remain untrusted. IronCurtain provisions no package
credential and rejects recognized credential fields and request bodies; that does not make package mode
an exfiltration-prevention boundary. The host screens the immediate destination, but a fixed public peer
may itself relay or hairpin elsewhere. The exact CLI/Web warning in the governing design must disclose
these routes.

The superseded generic-public/opaque-CONNECT product path is removed. The package proxy, generated CA,
build-trust wrapper, build shim, and lifecycle are reachable only for `packages`; legacy explicit
`public` narrows to that mode. The lifecycle loads and re-inspects the immutable selected image before
running the exact `--pull=false --network=none --no-cache` BuildKit canary, requires registry/package
ledgers unchanged, and activates only after the canary. Package trust no longer aliases the agent-visible
orientation tree: dedicated contract/certificate/bundle/apt copies are mounted as four individual
read-only leaves beneath image-precreated `/opt/ironcurtain-build-trust`, while outer
`/etc/ironcurtain` and OCI `/dev/ironcurtain` remain unchanged. Parent traversal accepts only complete
root/overflow owner pairs; leaf UID/GID is diagnostic only, with exact mode/link/size/digest and effective
read-only backing still mandatory. A fixed allowlisted wrapper failure-code leaf under secure sticky
`/tmp` supplies bounded canary diagnostics without influencing admission, cleanup, ledgers, or causality.
The deterministic supported-form gate runs each trust-check layer with cache disabled, requires the exact
BuildKit step to finish rather than report `CACHED`, and admits only the authoritative RootFS prefix plus
the canonical 1024-zero-byte empty-tar diff ID. Its later all-image archive scan binds image config and
layer order to the exact public-base prefix and inspected diff IDs, rechecks the exact empty bytes, scans
dynamic public authority markers globally, and checks every build-added layer and VFS graphdriver
snapshot file for a complete plaintext PKCS#1/PKCS#8 PEM private key, bounded to the CA source's 128 KiB
ceiling, whose derived public SPKI equals the staged CA. An otherwise canonical bounded candidate missing
only its footer is checked after reconstructing the matching public footer; lone headers, prose,
malformed bodies, other incomplete text, and oversized text are outside this identity check. Unrelated
complete keys inherited from the pinned public base are permitted. The primary non-provisioning proof is
persisted outer-create evidence, which separately proves that the exact
seven public package-build sources are read-only beneath the bundle runtime, `/etc/ironcurtain` remains
separate, and no host CA-directory or private/key-named source is mounted; no CA-key bytes or hash enter
the workflow.

The deterministic packages qualification performs snapshot traversal through one exact root-only
internal probe because the outer `codespace` process cannot read RootlessKit-owned VFS state. The parent
remains unprivileged and brackets this call with the initially admitted rootless daemon identity, exact
Docker data root, and unchanged tracked all/running-container and image inventories. Docker 29.2.1's
embedded BuildKit 0.27.1 uses the admitted Docker VFS graphdriver rather than a standalone BuildKit
snapshot directory, so only the exact real, non-symlink, nonempty `vfs/dir` tree is recursively screened. The exact
real, non-symlink `buildkit` root must instead contain a nonempty, one-link, bounded, stable
`snapshots.db`; a `buildkit/snapshots` entry is incompatible and fails. Its exact real, non-symlink
`executor` directory must be quiescent: direct-child bundles, links, devices, and unknown entries fail,
while only pinned-source steady-state `hosts`, `resolv.conf`, `resolv-host.conf`, and `runc-log.json`
regular files may remain under individual size and stability bounds. `resolv-host.conf` is the exact
BuildKit 0.27.1 `NetMode_HOST` resolver artifact required by the supported package builds. BuildKit content
blobs and databases are not misclassified as root filesystems or recursively authority-marker scanned.
VFS traversal is streamed from the validated root descriptor with finite entry, depth, byte, candidate,
and time bounds. Every component is validated before descriptor-relative no-follow metadata access;
directories retain exact before/open/after identities, symlinks retain exact identity around bounded byte
target reads, and regular files are pinned with Linux `O_PATH|O_NOFOLLOW`, reopened only through the
verified `/proc/self/fd` inode, then checked again through both descriptors and the parent directory.
FIFO, socket, device, and unknown entry types fail without a data open. Fixed phase/errno, authority-input,
PEM-parser, bound, residue, and instability codes disclose no path or content, and close failures
cannot replace the primary scan failure.
The archive proof keeps its independent 4 GiB ceiling. VFS uses a 256 GiB logical-byte ceiling and
4,000,000-entry ceiling because the retained selected-image replay measured 85,986,117,228 logical bytes,
1,489,147 entries, depth 20, and zero private-key candidates across its complete per-layer VFS snapshots.
The 300-second deadline, depth-256 limit, and 256-candidate limit remain unchanged. Archive bytes, VFS
logical bytes, VFS entries, depth, and candidate exhaustion have separate fixed nonleaking failure codes.
This is bounded deterministic qualification
evidence only: the daemon is not quiesced, traversal is not claimed TOCTOU-free, and the result is not a
continuous runtime security attestation. The root helper uses a
bounded stdout-only `BEGIN` then exact `OK`/allowlisted-`ERROR` protocol; each stream is capped at 128
bytes and their aggregate at 256. Before dispatch, the parent proves the bounded Apple outer hostname
grammar, nonempty safe `getent ahosts` resolution supplied by the image's `libnss-myhostname`, and an
exact silent `sudo`/empty-environment true command. Bootstrap, stderr, overflow, signal, status, and
framing failures reduce to nonleaking fixed parent diagnostics.

The redacted checked-in
[`CA-injection runc-PATH spike evidence`](./evidence/ca-injection-runc-path-spike.md) freezes the exact
runc version and the full redacted BuildKit argv vector; its machine-readable argv fixture is the wrapper-
test oracle for order, equality, and absence of extra arguments. The evidence records the functional
result's `passed: false` and the later production-API reconciliation as separate facts; it is feasibility
evidence, not a clean run or qualification. Later deterministic
[no-network](./evidence/ca-injection-buildkit-oci-envelope.md) and
[host-network](./evidence/ca-injection-buildkit-oci-envelope-host.md) captures both passed with exact
cleanup. Their checked comparison shows one structural delta: host mode omits only the pathless OCI
`network` namespace. The hardened wrapper maps its enforced structure to both summary hashes and
deliberately makes no byte-frozen claim for omitted seccomp bodies or non-`/dev` mounts. Preview
qualification should continue to exercise hostile OCI specs, residue, every supported package client,
and exact cleanup through the integrated entrypoints; the focused gates cover lock-serialized CA generations under the
trusted owner-only host parent, no-follow leaf files, certificate/key equality, and bounded source-owned
derived requests. As the governing design records, concurrent filesystem replacement by another process
with the same host UID is outside the nested-container threat model.

### 3. Broader failure injection

Add deterministic prepare/create/load/probe failure cases around the workflow entrypoint and require the
same exact cleanup proof. Keep crash recovery distinct from graceful next-session recovery.

### 4. Durable registry provenance

Persist a bounded host-owned record of authorized registry requests and resolved destinations. Never store authorization headers, tokens, cookies, or unbounded query/body data. Bind the record to the lease, policy/manifest hash, and session metadata; selected-image observations may be included as provenance but are not authority.

### 5. Keep the crash-recovery gate

Docker Desktop now injects coordinator SIGKILL, proves the detached watchdog removes every lease-owned
container/network and exact state/runtime root before readmission, verifies stdio MCP relays reap backend
children on owner EOF, and admits/closes a second session in the same isolated home. The qualifier also
fails and reaps a live gate whose detached process group is not empty. Preserve this gate as lifecycle code
evolves; Apple still has its separate graceful workflow sequence and cross-process watchdog tests.

### 6. Trusted outer inspect evidence

Persist/verify the exact host source to guest registry-socket mount pair and outer `network=none`/no-publication profile from trusted Apple inspect in the acceptance evidence.

### 7. Host port publication, only if product-required

If users must reach an inner server from the Mac, design a separate trusted fixed-port/relay capability with collision handling, ownership, policy, teardown, and no daemon-selected host binding. Do not enable Docker `-p`, Apple VM networking, or a generic host network as a shortcut.

## Key Files

Production:

- `src/docker/docker-workload-egress.ts` — exact `offline | images | packages` listener construction.
- `src/docker/registry-egress-policy.ts` — frozen manifest policy enforcement.
- `src/docker/registry-egress-proxy.ts` — registry-aware proxy forwarding.
- `src/docker/package-egress-proxy.ts` — strict fixed-host package routes, source-owned derived metadata,
  bounded audit, and destination-bound dialing.
- `src/docker/package-egress-ledger.ts` — shared client/direct/derived request, concurrency, and byte bounds.
- `src/docker/ca.ts` — lock-serialized, atomic strict-v2 CA generations, exact legacy-v1 migration with
  retained prior generations, and strict root/leaf certificate profiles.
- `src/docker/docker-build-shim.ts` and `docker/build-trust-runtime/` — package-build command interposition,
  immutable generated runtime contract, and hardened BuildKit `runc` trust injection.
- `src/docker/mitm-proxy.ts` — provider/registry listener and TLS parsing; it is not the package authority.
- `src/docker/outbound-transport.ts` — direct and fixed-parent destination-bound transport primitives; the
  fixed-parent primitive is not yet selected by nested product bootstrap.
- `src/docker/docker-infrastructure.ts` — shared batch listener/relay ownership and create/teardown wiring.
- `src/docker/pty-session.ts` — PTY listener ownership and cleanup wiring.
- `src/docker-workload/apple-vm-daemon.ts` — RootlessKit, relay, legacy iptables/DNS preflight, dockerd bootstrap.
- `src/docker-workload/docker-desktop-sidecar.ts` — constrained rootless daemon sidecar, API volume,
  effective-profile adjudication, and activation canary.
- `src/docker-workload/desktop-relay.ts` and `docker/nested-relay/` — independently pinned fixed-target
  Docker Desktop egress relays.
- `src/docker-workload/private-docker.ts` — backend-neutral private-daemon client and managed-network helpers.
- `src/docker/selected-agent-artifact.ts` — selected-current-agent export, canonicalization, cache, and
  transport verification.
- `src/docker-workload/apple-private-docker.ts` — selected-artifact load/reinspection and strict
  managed-network creation/inspection.
- `src/docker-workload/session-daemon.ts` — readiness, provisioning, managed-network admission, and activation ordering.
- `src/docker-workload/config.ts` — supported-variant guard.
- `src/config/paths.ts` — exact per-bundle registry/package UDS paths.
- `docker/Dockerfile.base.arm64` — rootless Docker toolchain and legacy iptables dependency.

Acceptance and tests:

- `scripts/smoke-nested-apple.ts` — Apple offline/PTY/registry and Docker Desktop packages smoke orchestration.
- `scripts/smoke-nested-apple-workload.ts` — pure public-registry workload plan and evidence parsing.
- `scripts/smoke-nested-apple-workflow.ts` — deterministic packages/images/offline workflow driver and exact cleanup verifier.
- `src/workflow/workflows/nested-docker-live-smoke/` — packaged no-LLM workflow and fixed Python probe.
- `test/workflow/nested-docker-live-smoke.test.ts` — deterministic-first/no-session lifecycle and constant-drift regression.
- `test/smoke-nested-apple-workload.test.ts` — workload-plan unit coverage.
- `test/docker/docker-workload-egress.test.ts` — listener lifecycle and policy integration.
- `test/docker/package-egress-proxy.test.ts` and `test/docker/package-egress-ledger.test.ts` — strict package
  grammar, derived-policy, audit, transport, and accounting gates.
- `test/docker/registry-egress-policy.test.ts` — manifest authority negatives.
- `test/docker/registry-egress-proxy.test.ts` — request/redirect/header/streaming behavior.
- `test/mitm-proxy.test.ts` — raw CONNECT/SNI/certificate-boundary coverage.
- `test/docker/nested-daemon-wiring.test.ts` — daemon command and Apple mount wiring.
- `test/docker-workload/apple-vm-daemon.test.ts` — exact rootless bootstrap invariants.

## Safe Continuation Rules

- Do not restore catalog generation, pairing, or refreeze as a product or qualification prerequisite.
- Preserve checksums and archive validation in the replacement transport, but never label bundle-image
  hashes or tool versions as host security authority.
- Do not start a second live smoke while another harness owns an isolated backend bundle; poll the existing harness through its `finally` cleanup.
- Preserve unrelated Docker containers/volumes/networks, stopped Apple VMs, and the Apple buildkit VM.
  Cleanup only exact lease-recorded IDs/generations.
- Do not interpret a socket inode or lease directory as readiness. Activation and daemon adjudication must precede agent attachment.
- Do not widen the rootless/outer network envelope to fix an inner compatibility issue. Keep Apple
  `network=none`, RootlessKit `--net=none --disable-host-loopback`, Docker Desktop agent/daemon off the
  default bridge, dockerd `--iptables=false --bridge=none`, and no host ports.
- Treat the bundle as colluding. Inner Docker labels, container inventory, guest paths, and daemon reports are diagnostics, not host security authority.
