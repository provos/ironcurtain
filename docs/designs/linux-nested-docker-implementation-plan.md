**Implementation design: Linux-client nested Docker, qualified on WSL/Desktop**

Revised 2026-09-10 following the independent review and the user's decisions:
WSL is the only available live test environment; container users are expected to
use sudo; native Linux arm64 is out of scope; avoid hash binding wherever a simpler
mechanism suffices. This document replaces the preceding implementation plan.
The implementation described below was merged in PR #467 (`d8c1d71`). Status was
reconciled on 2026-09-15 to include the subsequent macOS validation. The acceptance
record distinguishes completed runs from remaining evidence; the ordered exit
criteria remain requirements and are not a claim that every matrix cell passed.

**Implemented architecture**

- [environment.ts](../../src/docker-workload/environment.ts) selects the
  implemented WSL2/Desktop amd64 profile from host and daemon facts. It requires
  cgroup v2 and the covered security options and rejects native Linux Engine,
  non-Desktop WSL engines and WSL arm64. The selected Docker endpoint is resolved
  once and reused for image, container and recovery operations; ambient Docker
  context variables cannot redirect part of a bundle to another engine.
- [docker-infrastructure.ts](../../src/docker/docker-infrastructure.ts) owns the
  shared `buildAgentContainerConfig` used by batch and PTY; workflows reuse the
  same infrastructure. It combines mounts, environment, UID remapping, sudo
  capabilities, resource limits and nested wiring. Every Docker-runtime agent
  receives the [shared read-only tmpfs](../../src/docker/docker-agent-volume-shadow.ts)
  at `/var/lib/docker`, with `nosuid,nodev,noexec,size=1m`, so an inherited image
  `VOLUME` does not allocate anonymous writable Docker state. This also covers
  Disabled sessions and raw UID-remap tests. Apple containers do not receive this
  Docker image workaround.
- The existing [Docker sidecar](../../src/docker-workload/docker-desktop-sidecar.ts),
  private client, lease, watchdog and revocation implementations serve both
  Desktop environments. WSL keeps ordinary MCP/MITM UDS transport and uses the
  shared fixed relay's Unix upstream for workload policy. Online agents start on
  their isolated workload network; Offline starts on `none`. Each WSL relay has
  its exact policy socket mounted read-only, numeric identity permitting access
  to that mode-0600 socket, and no default-bridge uplink, host alias or published
  port. macOS Desktop retains its TCP host transport.
- [nested-daemon-identity.ts](../../src/docker-workload/nested-daemon-identity.ts)
  stages readonly account and subordinate-ID leaves for the selected numeric
  UID/GID. [container-identity.ts](../../src/docker/container-identity.ts) shares
  identity selection across agent remapping, daemon setup, relays and trust
  staging. WSL coordinators with root UID or GID are rejected during admission,
  before provisioning; run the coordinator as a regular WSL user.
  Trusted initialization creates private state as that identity, then
  drops to the rootless daemon. Ownership changes are confined to generated state;
  agent entrypoints no longer recursively chown the workspace. Agent users retain
  passwordless sudo. API/state parent and child permissions are inspected as
  `0755` and `0710` after daemon startup. The child starts as `0700`; dockerd
  changes it to `0710` through the same volume mounted as its data directory.
- [client-toolchain.json](../../config/docker-workload/client-toolchain.json) and
  [install-docker-toolchain.sh](../../docker/install-docker-toolchain.sh) provide
  one versioned toolchain recipe. The amd64 base is
  `mcr.microsoft.com/devcontainers/universal:5.1.4-noble`. Agent and daemon builds
  use the same runtime-resolved repository or descriptor reference for their
  selected toolchain source. The common build-trust generator produces amd64 and
  macOS-required arm64 wrappers. Packages fixtures select execution architecture
  instead of embedding ARM64-only fixtures, platform checks or lock/hash literals.
  The sidecar executes `/usr/local/bin/docker`; the agent shim carries and checks
  the admitted private socket. Cache inputs include the daemon entrypoint.
- [nested-daemon-profile.ts](../../src/docker-workload/nested-daemon-profile.ts)
  contains the complete operational seccomp definition. Watchdog generations
  persist complete validated policy values. Build-trust preflight, protected
  staging, safe file-descriptor handling and mount checks are shared by active
  Apple and Docker call sites. Static source, wrapper, runc, profile and trust-file
  hash allowlists are not new-session admission authorities. Docker/OCI-native
  identifiers, build bookkeeping and legacy cleanup readers remain.
- Host-only workflow snapshot helpers use
  [qualification-observer.ts](../../src/docker-workload/qualification-observer.ts)
  to precommit creation and record exact resource IDs under the active Docker
  lease's lifecycle claim. Revocation owns crash cleanup, including loss of the
  create response, and removes observers before their API volume. This does not
  add another lease system or allow an active Apple lease mutation.
- [qualification-evidence.ts](../../scripts/qualification-evidence.ts) retains
  preparation and live-step stdout/stderr with a combined 50 MiB bound per step.
  Its atomic manifest records arguments, timestamps, exit status, signal, timeout
  and the Vitest report. Preparation records the resolved WSL/engine environment.
  Shared process-group cleanup and portable short temporary roots replace the
  hardcoded `/private/tmp` assumption. Existing macOS command aliases remain.

**Acceptance record**

The r5 and r6 runs are preliminary and superseded for final acceptance. Their
selected suites and every live gate passed, but separate exact Docker volume
inventories found leaks from ordinary Docker agents, raw UID test runs and one UDS
boundary-test client. The shared tmpfs now covers all of those agent-image create
paths, and the boundary test also removes anonymous volumes during failure cleanup.
A passing runner manifest alone does not erase an independently observed cleanup
finding.

| Evidence                              | Recorded result                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| r5 selected tests                     | 475 passed, 34 files, zero required skips.                                                                                                                                                                                                                                                                                        |
| r5 live gates                         | All nine passed: Recovery, Disabled, PTY, direct Offline/Images/Packages, workflow Offline/Images/Packages.                                                                                                                                                                                                                       |
| r5 retained evidence                  | `/tmp/ic-wsl-qualification-final-20260910-r5/wsl-desktop.qualification.json`, the adjacent Vitest JSON and per-step logs; 2026-09-10 22:51:33–23:22:27 UTC.                                                                                                                                                                       |
| r5 cleanup inventory                  | 722 volume names before, 724 after. Two anonymous volumes prevent final cleanup acceptance.                                                                                                                                                                                                                                       |
| Observed environment                  | Node 26.8.2; WSL kernel `6.18.33.2-microsoft-standard-WSL2`; Docker Desktop Engine 29.4.1, Linux/amd64, cgroup v2; `name=seccomp,profile=builtin` and `name=cgroupns`. These are observations, not version pins.                                                                                                                  |
| r6 intermediate run                   | 478 tests and all nine live gates passed, but the inventory changed from 724 to 725. The remaining volume was traced to the raw UDS boundary-test client and fixed before final acceptance.                                                                                                                                       |
| Final r7 run                          | 478 tests passed in 34 files, all nine live gates passed, and zero reporter-visible skips; retained report: `/tmp/ic-wsl-qualification-final-20260910-r7/wsl-desktop.qualification.json`.                                                                                                                                         |
| Final r7 cleanup inventory            | 722 volume names before and after; both sorted inventories have SHA-256 `c4a7a4057c8b4fe2f5a608b53160a29b1bb052d61175d2fdebc3f7c5c2c54724`, and byte comparison passed.                                                                                                                                                           |
| Real non-1000 WSL coordinator         | Pending host sudo. Isolated live container UID/GID 1101:1102 and Claude/Goose/Codex image/UID checks passed, but do not exercise the coordinator as that actual WSL host identity.                                                                                                                                                |
| macOS pre-merge regression validation | On 2026-09-14, Docker Desktop passed 352 tests and six live gates. Apple workflow/PTY checks passed, with the final packages run passing 27 deterministic and 12 fresh-admission checks plus exact teardown after the shared staging fix. See the [handoff](secure-nested-runtime-handoff.md#pr-467-macos-regression-validation). |
| Coverage limits                       | CLI, PTY and workflow smoke runs use Claude. No all-mode-by-adapter or complete IPv4/IPv6/DNS/LAN/metadata matrix is claimed. Native Linux Engine and Linux arm64 remain unqualified. WSL r7 and macOS pre-merge runs are dated evidence, not fresh qualification of later dependency changes.                                    |

Repeat the main qualification with an automatically generated fresh evidence
directory:

```sh
npm run qualify:wsl-desktop
```

Use the Node executable matching the checkout's native dependencies. The runs
above used `/tmp/ic-linux-node-runtime/node_modules/node/bin/node` (26.8.2);
the original Node 23.7.0 executable did not match the installed `isolated-vm` ABI.
Compare exact Docker resource inventories around final acceptance as well as the
per-bundle cleanup assertions.

The remaining host-identity evidence can be collected without creating an account
or modifying workspace ownership:

```sh
sudo python3 scripts/qualify-wsl-non1000.py \
  --uid 1101 --gid 1102 \
  --node /tmp/ic-linux-node-runtime/node_modules/node/bin/node \
  offline images packages pty workflow recovery disabled
```

This harness runs a real UID/GID transition with private temporary roots and the
existing Docker socket group. It requires host sudo; container-local sudo being
supported does not supply that host permission. Its retained identity report is
separate from the default-identity qualification report.

**Delivery scope and evidence**

Implement the shared Linux/amd64 Docker path and qualify it on the available WSL2
Docker Desktop installation. Deliver Disabled, Offline, Images, Packages, batch,
PTY, deterministic workflows, bounded outer resources, rollback, watchdog cleanup
and subsequent clean admission. Keep `enabled` / `networkAccess` settings and the
existing ephemeral daemon model; ended nested sessions remain non-resumable.

The release gate runs on WSL/Desktop amd64. It does not require native Linux,
native arm64 or macOS hardware to become available. Record actual WSL kernel,
Docker server, architecture, cgroup, mount and security-option observations in the
report. Tested versions are diagnostics; do not bind admission to an exact kernel,
image digest inventory, source revision or historical qualification report.

Native Linux Engine behavior, including Ubuntu AppArmor/user-namespace behavior,
remains unqualified and is not a prerequisite for this release. Do not claim that
WSL proves it or blindly admit an unimplemented native profile. The implementation
uses the same Docker interfaces so later native qualification can reuse it. No
native arm64 implementation or live-runner work is required. Continue producing
ARM64 guest artifacts needed by the existing macOS backends from the shared recipe.

Preserve macOS/Apple paths and their test definitions. Run their unit/structural
regressions on WSL where possible; mark unavailable live validation accurately.
Do not require or claim a fresh macOS live pass for this WSL-only effort. Avoid
incidental security regressions, but do refactor Apple call sites onto shared
implementations where that reduces complexity. Preserve required properties, not
the current organization or every existing hash check.

The WSL UDS candidate is implemented and has live evidence for exact read-only
socket-file mounting, numeric mode-0600 access, restricted relay topology, active
connection cancellation and stale socket-inode replacement. The preliminary
directory/socket-file feasibility probes were followed by these boundary checks
and the selected online smoke gates. The review's categorical assertion that WSL
socket mounts cannot work is superseded by the observed working target; it does
not establish support for other WSL/Desktop configurations or native engines.

**Trust and privilege model**

Treat the agent, commands it starts, and workloads controlled through its private
Docker API as one untrusted bundle. Container-local root is expected. Preserve
passwordless `sudo -n` in the agent, including approved package installation,
system trust setup and normal development operations. Workload images that provide
sudo may use it too; do not install sudo into arbitrary minimal workload images.

| Role                     | Authority and enforcement                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent                    | Runs normally as its mapped user and can become container root with sudo. Retain the existing bounded capability set and writable development filesystem. Do not apply a blanket `no-new-privileges` setting that breaks sudo. Agent binaries, PATH, shims, file permissions and reported versions are not security authorities. |
| Nested daemon            | Operates rootlessly in a separate outer sidecar after trusted initialization. Agent sudo does not imply sidecar sudo, host root, parent-sidecar exec access, an outer privileged container or access to the host Docker socket.                                                                                                  |
| Fixed relays             | Separate trusted containers, capabilities dropped, no sudo, read-only root filesystem, bounded resources and exactly one configured policy upstream. Agent root cannot change their target or executable.                                                                                                                        |
| Coordinator and watchdog | Trusted host processes. Own leases, policy decisions, public-trust staging and cleanup. Their files, control sockets, real credentials and CA private key are outside every agent/workload-accessible mount.                                                                                                                     |
| Initialization           | Coordinator-selected code before activation. Any temporary UID-0 execution and capabilities are explicit parts of the trusted implementation. Never execute workspace-controlled scripts during this setup.                                                                                                                      |

Security comes from outer runtime confinement, mount boundaries, isolated networks
and host-side policy. Root-owned mode-0555/0755 files in an agent's writable image
filesystem do not replace a security hash: sudo can change them. The agent may
replace its Docker CLI or bypass a build shim; those actions must not grant a new
host capability or evade destination/request restrictions.

Inner `--privileged`, root and host-network requests remain confined by the outer
rootless sidecar. Outer CPU, memory and PID cgroups enforce the aggregate bundle
budget. Inner resource controls and metrics are advisory; inner cgroup delegation
is not a deliverable. Disk remains watchdog-observed, with VFS time/disk headroom
budgeted explicitly rather than described as a hard quota.

**Reuse and interface changes**

Keep the function-based design and existing runtime kinds, `docker` and
`apple-container`. No Linux runtime class, backend plugin framework, duplicated
sidecar or second watchdog/lease system is needed.

| Existing seam                                                                                                | Focused change                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContainerRuntime`, `DockerImageInfo`, `checkDockerAvailable`                                                | Add execution-platform and required daemon facts through the existing probe/image interfaces, preserving `docker-probe.ts`'s leaf dependency boundary. Resolve the endpoint once so build, inspect and create use the same engine. |
| `StartDockerDesktopSidecarOptions`, `DockerDesktopSidecarRuntime`                                            | Generalize shared naming and inject toolchain, structural profile, ownership and transport inputs. Retain capability narrowing, stopped inspection, readiness and rollback.                                                        |
| `DockerWorkloadBundleHandle`, `LedgeredOuterCreateAuthority`, `PrivateDockerClient`                          | Reuse lifecycle, exact resource ownership, private client and workload-network logic.                                                                                                                                              |
| `resolveNestedDockerAgentWiring`, `activateNestedDockerWorkload`, `createLedgeredAgentContainer`             | Extend these common seams. Extract duplicate batch/PTY transport and container assembly around them; keep terminal attachment and command construction at entrypoints.                                                             |
| `ClientToolchainManifest`, `DockerBuildShimStagingContract`                                                  | One compatibility description, selected platform artifact and ownership input. Remove ARM64 globals and Buildx UID/GID 1000 assumptions.                                                                                           |
| `BackendQualificationPlan`, `QualificationLiveGate`, `runVitestQualificationSuite`, `smoke-child-process.ts` | One scenario runner, portable bounded temp/socket setup, process cleanup and independently specified expected topologies. Preserve existing npm aliases.                                                                           |
| Workflow orchestrator and settings DTO                                                                       | Reuse configuration and bundle lifecycle. Add a test-only daemon-placement boundary, not a second workflow implementation.                                                                                                         |

Use three small readonly results: resolved environment/platform, resolved runtime
ownership, and transport/container configuration. Keep optional PTY requirements
explicit. Ordinary MCP/MITM transport and workload egress are separate choices;
`process.platform` or `runtimeKind === 'docker'` must not answer both questions.
Avoid adding configuration flags for users to choose internal transports.

The main change sites are [docker-infrastructure.ts](../../src/docker/docker-infrastructure.ts),
[pty-session.ts](../../src/docker/pty-session.ts),
[docker-desktop-sidecar.ts](../../src/docker-workload/docker-desktop-sidecar.ts),
[desktop-relay.ts](../../src/docker-workload/desktop-relay.ts),
[docker-build-shim.ts](../../src/docker/docker-build-shim.ts), and
[qualify-backend-plan.ts](../../scripts/qualify-backend-plan.ts).

**Default verification design: no hash binding**

Replace active hash bindings with the following mechanisms in the same change
that proves their replacement. Do not first delete checks and defer protection to
another PR. No new hash exception is approved by this design.

| Area                        | Chosen nonhash mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Seccomp and outer profiles  | One trusted typed definition with complete structural validation: allowed syscalls/actions/arguments/architectures, capabilities, devices, masks, mounts, identity and network attachments. Render validated seccomp into host-private staging; compare Docker's reported security options and container structure against the expected values. Inspect output does not expose the installed kernel filter: positive/negative primitive probes establish enforcement. Replace the static profile digest; a generic schema plus two syscall checks is insufficient. No general policy compiler or complete golden inspect dump. |
| Watchdog policy             | One immutable validated policy snapshot per lease generation, stored as the complete bounded policy value. If a separate policy file remains useful, compare parsed values, not digests. Supervisor loads its policy once; preserve generation, process-start identity, lifecycle ownership and exact cleanup IDs. Remove redundant independently editable policy copies.                                                                                                                                                                                                                                                      |
| Wrapper and public trust    | Stage on the host outside writable bundle mounts. Publish a complete generation atomically, mount only the required staging directory or leaves read-only, and verify exact source/target/access through the outer runtime. Keep safe path/open, effective read-only and OCI grammar checks. Where consistency comparison is needed, compare bounded content directly against trusted host input; never trust a checksum produced by the agent.                                                                                                                                                                                |
| Daemon executables/runc     | Use the separate daemon's read-only image tree and restricted steady-state identity. Prove that inner Docker authority and allowed helpers cannot replace the parent runtime tree. Use version/protocol checks for compatibility. Remove static executable SHA/size allowlists from the WSL path once that separation is demonstrated. Hashing a file then executing its pathname is not a substitute for preventing replacement.                                                                                                                                                                                              |
| Agent tools                 | Compatibility observations only. Allow agent-local modification through sudo. A modified CLI, version response or skipped shim must not change host policy enforcement.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Relay configuration         | Validate the full fixed endpoint and effective container configuration. Keep the upstream outside agent control; add no relay/config digest certificate. Existing relay configuration checks are structural; documentation mentioning authority hashes is not evidence of another implemented hash gate.                                                                                                                                                                                                                                                                                                                       |
| Image sources and packaging | Centralize versioned component references, including `devcontainers/universal:5.1.4-noble`. Resolve the toolchain source once per build transaction and reuse Docker's returned repository/descriptor reference for agent and daemon builds, recording its image ID. Build amd64 and macOS-required arm64 assets from one recipe and migrate both active call paths to the shared artifact contract. No maintained wrapper/runc/source digest inventory by default.                                                                                                                                                            |

Preserve Docker/OCI-native content-addressed identifiers where the protocol uses
them, and exact runtime IDs for object selection and cleanup. These are not release
allowlists. Computed build-cache keys may remain bookkeeping, including source
identity, target platform and shared recipe inputs. Neither cache hits nor version
strings become evidence that an untrusted image is safe.

Remove unused toolchain source IDs, unpopulated provenance labels, compiler-byte
freshness gates, duplicated fixture hash literals and the generator's rewriting of
Python `PACKAGE_RUNC_SHA256`. Retain semantic grammar tests and useful diagnostic
build metadata. Correct comments that call reported versions executable attestation.

Use one active build-trust contract, generator, staging implementation and common
preflight for both backends. Move reusable checks from the Apple-named
`preflightAppleVmDockerBuildShim` into that common preflight. Pass the execution
target and protected staging/mount information through the existing runtime seams.
Do not add enduring Apple-hash versus WSL-nonhash verification modes or keep
duplicated generated contracts. Temporary compatibility is only for migration;
migrate active callers and delete obsolete checks/constants together.

Apple-specific operations are concrete placement/transport differences: its
selected agent image crosses into the private Docker daemon through an archive,
and its daemon executes in the agent's VM rather than a sibling outer container.
Keep export/load/path translation and mount/placement observations in narrow
adapters; reuse archive parsing, toolchain compatibility, safe staging, OCI grammar,
trust handling and lifecycle logic. Standard OCI digest checks belong to the image
format; review additional whole-archive/build-label bindings for redundancy rather
than automatically preserving them as Apple requirements.

The separate-sidecar integrity argument cannot simply be asserted for Apple's
same-VM placement with agent sudo. Define the protected property in common code
and obtain the relevant mount/placement evidence through its adapter. Refactor and
test Apple call sites with the available unit/contract fixtures; record missing
live evidence. If a particular behavior change cannot be justified without that
evidence, isolate that specific transition. Lack of Apple hardware is not a blanket
exemption from reuse or a reason to build a second verification system.

For shared persisted protocols, migrate lease, policy, supervisor status/readiness,
infrastructure comparisons and recovery together with versioned readers/writers.
Cover a supervisor already running when the checkout changes. New generations use
the value-based contract. Continue recognizing and
reconciling old generations with their original semantics until cleanup finishes;
do not reinterpret old leases, drop watchdog ownership or leave containers behind.
Compatibility reading of old data is not a new hash requirement. It does not
justify retaining a parallel legacy verification mode for new Apple sessions.

If a concrete boundary cannot be protected by these mechanisms, stop only that
dependent change, present the failing case and proposed alternatives, and obtain
the user's explicit approval before retaining or adding security hash binding.
Do not turn this into a standing per-artifact approval checklist. Existing CA/APT
digest evidence is incomplete: the cited same-size test mutates the CA cert only.
Replacement tests must cover the certificate, combined bundle and apt configuration
separately, including attempts made with actual agent sudo/root.

**Structural profile scope and governance**

Environment selection lives in `environment.ts`; the complete operational seccomp
definition and equality check live in `nested-daemon-profile.ts`. The existing
`profile-ceiling.json` is historical qualification evidence, not the operational
admission authority. Its old ARM64 version scope and artifact digests do not reject
the WSL amd64 profile. Each selected environment uses the shared effective profile
with the existing runtime-specific placement and transport constraints. Version
records describe tested behavior; exact kernel strings and artifact hashes are
not admission keys.

Explicitly represent and test the current procfs/mount-mask exception
(`systempaths=unconfined`) and the online-only `/dev/net/tun:rwm` mapping used by
slirp4netns. Neither extends to the agent or relay. Profile selection must not copy
an ARM64-only seccomp architecture condition into amd64. Assert required and
forbidden rules completely; matching a digest is unnecessary for object equality.

Reconcile the predecessor's ceiling-change governance: changed effective security
allowances require fresh cumulative primitive and isolation tests for affected
profiles. Shared-rule changes rerun affected variants' available regressions and
record unavailable platform evidence; historical evidence cannot qualify a new
allowance. This is a review/test requirement, not a hash-bound admission artifact.
Do not broaden unavailable macOS profiles as part of this port.

Native AppArmor profile installation, host sysctl changes and distribution-specific
profile selection are deferred with native qualification. If the actual WSL engine
reports an unexpected enforcing LSM or an unmet invariant, report it and investigate
that observed configuration; do not disable host protections or silently add broad
capabilities. No new AppArmor hash decision is needed for a profile not implemented.

**Ordered work and exit criteria**

The following preserves the agreed implementation order and intended acceptance
coverage. The implementation above delivers the shared mechanisms. Only the
acceptance record establishes which live cases were executed; pending host-identity
and broader matrix evidence must not be read as completed merely because an exit
criterion is listed here.

1. **WSL feasibility and portable harness.**

   Start with bounded disposable probes on the available engine: user namespaces
   under the candidate capabilities/seccomp, newuidmap/subordinate mappings,
   nested procfs with the intended mount-mask setting, online slirp/TUN, and UDS
   socket ownership/replacement behavior. Confirm the agent's normal user can run
   `sudo -n id -u` and perform intended local administration with its current
   capability set. This evidence comes before substantial refactoring.

   Generalize smoke setup to a short canonical temporary root with socket-length
   checks, bounded child waits and exact cleanup. Preserve current npm aliases and
   add a WSL/Desktop target. Record Engine/WSL facts and failures in reports.
   Probes that create resources are explicit test actions, not hidden read-only
   admission checks. No native or macOS live runner is needed for this exit.

2. **Shared assembly, sources and verification contracts.**

   Extract common batch/PTY assembly in a behavior-preserving change, then inject
   resolved environment, ownership and profile inputs into the existing sidecar.
   Preserve ledger-before-create, stopped adjudication, activation ordering and
   crash ownership. Share pinned-by-version toolchain installation across agent
   bases; resolve the selected source once for each build transaction.

   Implement full profile comparison and the lease policy migration alongside
   their tests; remove the replaced digest bindings. Parameterize toolchain and
   build-trust packaging without duplicating manifests. Build ARM64 assets for
   existing macOS use, migrating its active callers to the shared contracts with
   compilation/structural regressions accurately labeled.
   Introduce workflow runtime/placement test helpers now so Offline can use them.

   Fix Docker manager's automatic host-gateway alias insertion: explicit empty
   host mappings must mean none, with legacy default behavior preserved elsewhere.
   The isolated workload design must not accidentally acquire an alias because
   `extraHosts: []` falls through the current length check.

   Exit: WSL image/tool tests, complete profile negatives, old/new lease cleanup
   tests and existing runnable unit regressions pass. No new static digest pins,
   security hash requirements or duplicated Linux lifecycle code.

3. **Ownership, sudo and Offline.**

   Resolve agent, daemon/API, tmpfs and Buildx numeric ownership together. Preserve
   agent username-based sudoers and reuse its existing UID-remap seam. Do not use
   removing sudo, mode-0777 API roots, or automatic recursive workspace chown as an
   ownership fix. Scope automatic ownership changes to IronCurtain-created state.
   This requires revisiting the existing recursive `/workspace` chown in
   `docker/entrypoint-uid-remap.sh`, with workspace and sudo regression coverage;
   avoiding only a new daemon-side copy would leave the current behavior intact.

   Prefer one daemon image with a small trusted initializer and explicit account/
   subordinate-ID inputs. First prove setup using the existing SETUID/SETGID ceiling,
   creating private state as the target user before restricting/exposing the parent
   and dropping to the steady-state daemon identity. Temporary root is not banned
   merely because it is root; its authority, code inputs, mounts and failure cleanup
   must be explicit and inspected. If this mechanism fails, assess the minimum
   initialization change rather than silently giving the daemon agent capabilities.

   Record real UID/GID maps and test host-visible workspace ownership. Use validated
   ranges for the actual daemon environment; do not assume WSL distro `/etc/subuid`
   is the Docker VM's account database. No hardcoded native-host range allocation or
   automatic host account mutation by product setup. Native range governance remains
   a later qualification task.

   Use an existing WSL test account or a subprocess with a real different numeric
   UID/GID and isolated owned temporary roots. Do not substitute a mocked
   `process.getuid()`; no permanent host account creation is a release prerequisite.

   Exit: actual WSL host UID and a real non-1000 WSL test identity with private
   mode-0700 workspace pass API access, load/run/exec, hermetic builds, local Compose,
   file round trips and usable existing ownership. Test sudo in batch, PTY and
   workflow sessions. Verify outer resource limits/ancestry, no egress or host
   runtime access, preparation failure, SIGKILL cleanup and clean next admission.

   Wire the real CLI for this candidate mode as soon as it is ready and test its
   admission failures; constructor-only harness success is not CLI qualification.
   Keep unreleased modes rejected in the candidate. Do not add a public admission
   bypass flag. No Offline-only release may silently admit the default online mode.

4. **Images through the shared UDS relay.**

   Keep ordinary MCP/MITM UDS transport. For Images/Packages, create the agent
   initially on the isolated workload network, as well as the daemon and fixed
   relays. Offline uses `none`; never attach a second network to `none`.

   Extend the existing fixed relay's upstream with one typed Unix-socket target;
   reuse its `net.Conn` forwarding, source checks, credential injection and bounds.
   Each relay receives only its exact policy socket-file mount, read-only. It has
   no workspace/API/daemon-state mounts, default-bridge uplink, host gateway or port
   publication. Use an appropriate numeric UID/GID for mode-0600 socket access.
   The host policy socket is never directly mounted into the agent or daemon.

   Inspect mount/network/identity invariants independently of the production plan.
   Retain per-bundle proxy credentials; sudo inside the agent must not reveal them.
   Revoke/recreate relays when the socket inode changes. Test stop/unlink, active
   connection cancellation, wrong socket, unauthorized request and cross-bundle
   access. An unexpected WSL UDS failure is diagnosed, not an automatic TCP fallback.

   Exit: real CLI batch/PTY/workflow registry pulls and internal service/Compose
   networking pass. Registry denials show policy rejection; package negatives show
   that the absent nested package route cannot succeed. Preserve the separate
   ordinary-agent `packageInstall` policy: an allowed outer-agent package download
   is not a failure of nested Images mode. After final attachment, test direct
   IPv4/IPv6, DNS, host/LAN/metadata, sibling/runtime and host-publication negatives
   from the agent as root, daemon and inner workloads. Account for actual relay
   resources and repeat cleanup gates.

5. **Packages with protected staging and replaceable agent tools.**

   Use the shared target-platform builder for the wrapper and the value-based
   staging contract above. Preserve strict OCI grammar, safe file handling and
   effective read-only checks while removing static runc/wrapper/content pins from
   the WSL path after boundary tests pass. Host policy remains authoritative when
   the agent replaces its own CLI, rewrites PATH or bypasses client shims.

   Test parent-sidecar runtime/trust write attempts via nested root/privileged
   containers and bind mounts. Host-required trust is protected by mounts, not an
   agent-owned filesystem mode. Do not claim a functional probe run by a live
   untrusted agent authenticates executable bytes or proves runtime integrity.

   Exit: Docker build, supported Buildx/Compose forms, apt/npm/PyPI/Cargo fixtures,
   approved `sudo` package installs and cache/audit behavior pass. Denied hosts,
   packages, credentials and request forms remain denied after client modification.
   Independently check trust residue in controlled builds and daemon snapshots.
   Distinguish expected public trust installation in the ephemeral outer agent from
   unintended build-image residue. An agent deliberately modifying its own output
   is not proof that a host security boundary failed.

   Daemon-local tests use the existing host `ContainerRuntime.exec` seam with
   bounded output and a test-only helper or tools actually present in that image.
   Do not add an agent mount of daemon state or a production Python dependency to
   port the Apple workflow probe. Repeat lower-mode, resource and recovery gates.

6. **WSL release acceptance and documentation.**

   Run the complete WSL target with zero required skips, including all supported
   adapters, real CLI/settings configuration, batch/PTY, workflow reuse/destruction,
   Disabled, Offline, Images, Packages, resume refusal and recovery. Injected
   constructor tests complement these gates, not replace them.

   Provide one repeatable qualification command and retain its report. It can run
   on the available WSL machine; integrate a dedicated WSL runner when available,
   without inventing a native-Linux CI prerequisite. Missing WSL prerequisites fail
   the selected WSL gate. Budget disk headroom, VFS workload size, per-gate timeouts
   and cleanup margins from measured runs; keep fixtures small and deterministic.

   Update macOS-only help and settings text to describe the tested WSL/Desktop
   support accurately. Keep native Linux/other unavailable live evidence explicitly
   unqualified. Admission selects implemented profiles and checks operational
   capabilities, not report hashes or exact recorded kernel versions. Preserve
   existing macOS selection behavior without widening untested permissions.

**Completion criteria**

- WSL/Desktop amd64 passes the full feature matrix with sudo working as intended.
- Enforcement survives agent-root client/shim modification and inner privileged
  requests; host policy, credentials, mounts and outer resource boundaries hold.
- One sidecar/lifecycle implementation, shared batch/PTY assembly, one toolchain
  recipe and one scenario runner; ARM64 assets remain for macOS only in this scope.
- New WSL generations use structural/value-based verification rather than hash
  binding. Any exception needs a concrete failing case and explicit user approval.
- Old leases still reconcile correctly. Active Apple and WSL callers share the
  verification core; only image transfer and placement-specific operations differ.
  Required Apple properties are not weakened by assuming sibling-sidecar isolation.
- Actual WSL evidence is sufficient to finish this deliverable. Missing native or
  macOS hardware is recorded honestly and does not leave the WSL work unfinished.
