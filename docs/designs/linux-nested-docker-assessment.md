# Historical Linux nested-Docker assessment — 2026-09-10

This document preserves the pre-implementation investigation, not current support status.
See [CONFIG.md](../../CONFIG.md#nested-docker-workloads) for admitted profiles and
the [implementation design](linux-nested-docker-implementation-plan.md) for architecture
and the authoritative [acceptance record](linux-nested-docker-implementation-plan.md#acceptance-record).

**Historical baseline assessment (before implementation)**

The remainder records the original findings. Its statements about current code,
native-runner requirements and recommended per-architecture hashes describe that
baseline, not the linked implementation design. In particular, Linux admission was
then deliberately rejected; fixing the temporary directory alone could not enable
the feature. The later design supersedes those requirements and recommendations.

This original assessment inspected the checkout without changing runtime code or
removing admission guards. The predecessor implementation plan identifies
[native Linux as an independent qualification effort](secure-nested-runtime-implementation-plan.md#phase-2-lx--native-linux-docker-proof-and-product-slice-independent-sibling).

**Evidence collected**

- Host: Linux WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`, x86-64,
  Node `23.7.0`.
- Daemon: Docker Desktop `4.71.0`, Engine `29.4.1`, Linux/amd64, cgroup v2.
  This is Docker Desktop accessed from WSL2, not a native Linux Engine installation.
- The 16 test files selected by the Docker Desktop qualification plan passed:
  238 tests, zero failures, zero pending tests. The successful run used the actual
  host environment because the tool sandbox blocks local sockets and interface
  enumeration. Report: `/tmp/ic-linux-qualification-host-dM4ukD/docker-desktop.vitest.json`.
- Running the recovery smoke reproduced the reported `/private/tmp/ic-na-XXXXXX`
  failure. Direct calls to the production admission function rejected Linux for
  Offline, Images, and Packages.
- A disposable, stopped Alpine container created with `--network none` could not
  join `bridge`: Docker returned `container cannot be connected to multiple
networks with one of the networks in private (none) mode`. The probe container
  was removed.

No end-to-end nested workload passed on Linux in this assessment. No native Linux
host was available for qualification. The passing test suite includes mocked
platform/topology inputs and does not establish Linux runtime support.

**Gaps, in implementation order**

| Gap                                        | Evidence and effect                                                                                                                                                                                                                                                                                                                                      | Required change                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform admission                         | `assertDockerWorkloadVariantAdmitted` in [config.ts](../../src/docker-workload/config.ts) admits Docker workloads only on Darwin. All three enabled modes reject Linux.                                                                                                                                                                                  | Keep rejection until the intended Linux environment has a working implementation and qualification. Give the qualification command an early, useful unsupported-environment diagnostic.                                                                                                                                                      |
| Smoke environment and expectations         | [smoke-nested-apple.ts](../../scripts/smoke-nested-apple.ts) hardcodes `/private/tmp` and asserts that canonical prefix. Its topology verifier requires one ordinary TCP transport proxy/network. The workflow smoke also hardcodes `/private/tmp` and Apple runtime selection.                                                                          | Share a short, canonical temporary-root helper with socket-length validation. Parameterize runtime and expected topology, not just paths. Preserve the short-path protection: blindly substituting `tmpdir()` can produce overlong socket paths on macOS.                                                                                    |
| amd64 artifacts                            | [docker-workload-paths.ts](../../src/docker/docker-workload-paths.ts) always selects `client-toolchain.arm64.json`; live client preflight compares both client and daemon architectures. [build-trust-runtime/build.mjs](../../docker/build-trust-runtime/build.mjs) and the generated contract ship only an ARM64 wrapper and ARM64 real-runc identity. | Produce independently pinned amd64 toolchain and build-trust artifacts; select using the resolved execution architecture. Verify the pinned stock daemon image resolves for each target. Preserve per-architecture hashes and executable identity checks.                                                                                    |
| amd64 agent image                          | [Dockerfile.base.arm64](../../docker/Dockerfile.base.arm64) installs the pinned Docker toolchain/plugins; [Dockerfile.base](../../docker/Dockerfile.base) lacks that installation. Inherited tools from the universal base do not establish the required versions or paths.                                                                              | Share the pinned toolchain installation and make both image variants satisfy the same client contract. Packages also needs the matching build-trust wrapper and runc bytes.                                                                                                                                                                  |
| Agent network conflict                     | [network-topology.ts](../../src/docker/network-topology.ts) selects UDS on Linux. Both batch and PTY create the agent on `none`, then `attachDockerDesktopAgentEgressNetwork` tries to attach a workload egress network for Images/Packages. The local daemon rejects this combination.                                                                  | Resolve ordinary MCP/MITM transport independently from workload networking. Choose a valid initial network for online workloads, or implement a qualified UDS egress arrangement. Preserve direct-egress isolation and inspect the actual resulting topology.                                                                                |
| Host proxy reachability                    | [docker-infrastructure.ts](../../src/docker/docker-infrastructure.ts) chooses TCP workload listeners for every Docker runtime, even when ordinary transport is UDS. [desktop-relay.ts](../../src/docker-workload/desktop-relay.ts) targets `host.docker.internal:host-gateway`; the host source guard admits loopback only.                              | Add a tested host-policy transport for native Linux and WSL/Desktop. The current code assumes Desktop's macOS host-forwarding behavior. Native bridge traffic is not automatically a connection to a host loopback listener. Do not merely widen listener/source access.                                                                     |
| UID and filesystem contract                | Linux `buildAgentUidRemap` changes the agent to the host UID/GID. The daemon image initializes its shared API directory as UID/GID 1000, mode 0700, and runs as `rootless`. Both containers bind the workspace.                                                                                                                                          | Define how daemon identity, agent identity, API access, and workspace ownership agree. Non-1000 users cannot traverse that API directory under ordinary Linux DAC. Test private workspaces and files created by both sides, including rootless user-namespace mappings.                                                                      |
| Linux isolation and resource qualification | The frozen profile's AppArmor artifact is null; the system-path exception is Desktop-scoped. Existing Desktop evidence does not establish native Linux LSM, namespace, mount, cgroup, or recovery behavior. Resource partitioning also always reserves the macOS TCP transport container.                                                                | Qualify a specific native Linux baseline, then broaden explicitly. Probe enforcing AppArmor/SELinux where claimed, user namespaces/subordinate IDs, the existing seccomp profile, read-only API access, cgroup ancestry and limits, storage, egress negatives, and exact crash cleanup. Allocate resources from containers actually created. |

The ownership and native host-hop findings are consequences of current code
contracts, not results of a full Linux nested-daemon run. The network-attachment
restriction was separately reproduced against the available daemon. These
distinctions matter because production currently stops at admission.

Linux user-namespace prerequisites vary by distribution. For example, Docker
documents Ubuntu 24.04+ restrictions and AppArmor requirements in its
[rootless troubleshooting guide](https://docs.docker.com/engine/security/rootless/troubleshoot/).
That is a reason to gather Linux-specific evidence, not proof that a particular
profile change is necessary or sufficient for this nested sidecar. Outer cgroup
enforcement must also be distinguished from inner rootless Docker's ability to
manage its own cgroups.

**Refactoring opportunities**

1. **Resolve one environment and topology description.** Separate host OS,
   daemon environment (native Engine, Desktop/WSL, Desktop on macOS), execution
   architecture, ordinary proxy transport, workload egress transport, and daemon
   placement. Today `process.platform`, `useTcp`, and `runtimeKind === 'docker'`
   answer different questions inconsistently. Use inspected capabilities and
   narrowly scoped connectivity probes to validate the chosen configuration.
   Explicitly reject remote/rootless/other daemon arrangements until supported.

2. **Reuse the existing sidecar implementation for Linux.** Generalize
   `docker-desktop-sidecar.ts` into the common Docker daemon-sidecar lifecycle,
   with validated platform profile, toolchain, ownership, and egress inputs.
   Keep Desktop-specific forwarding in its own adapter. Apple keeps its same-VM
   bootstrap and selected-image archive transport. Do not create a copied
   `linux-sidecar.ts` with another lease/recovery implementation.

3. **Extract common agent container assembly from batch and PTY.**
   `createSessionContainersAttempt` in `docker-infrastructure.ts` and
   `runPtySession` in `pty-session.ts` duplicate topology branches, transport
   creation, environment, trust/mount composition, UID remapping, and parts of
   startup sequencing. Share a validated container plan and common creation /
   activation sequence. Keep command construction and terminal attachment at the
   entrypoints. Existing shared helpers such as `resolveNestedDockerAgentWiring`,
   `activateNestedDockerWorkload`, and `buildContainerWorkspaceMount` are useful
   foundations, not code that needs replacing.

4. **Unify toolchain/image inputs.** Use a versioned per-architecture manifest
   to drive artifact selection and build-trust generation, and a shared image
   stage or installation recipe for common agent additions. Preserve distinct
   base images where useful; Docker/Buildx/Compose installation must not live
   only in one architecture's Dockerfile. Extend build hashes when adding shared
   build inputs so stale images cannot look current.

5. **Make qualification scenarios data-driven.** Rename/generalize the nested
   smoke entrypoint and helpers, keeping existing npm commands as aliases.
   Express Disabled, Recovery, Offline, Images, Packages, and PTY as scenarios;
   express expected resources/networks separately for each supported environment.
   Reuse workflow probe logic with runtime-specific image/mount expectations.
   Keep independent expected outcomes and negative assertions: deriving every
   assertion from the production container plan would let the same mistake pass
   both implementation and test.

6. **Preserve the shared security and lifecycle core.** `private-docker.ts`
   already shares client invocation, readiness, toolchain preflight, and inner
   network setup. Lease admission, ledgered creation, watchdogs, revocation,
   reconciliation, and policy parsing already have common implementations.
   Linux should consume those seams. Resource budgeting should sum the actual
   planned agent, daemon, transport, and fixed-relay containers.

**Suggested delivery sequence**

1. Improve unsupported-environment diagnostics and portable smoke setup; add
   separate WSL/Desktop and native Linux qualification identifiers.
2. Introduce shared architecture/toolchain inputs and the common Docker-sidecar
   seams without changing which environments are admitted.
3. Prove Offline on the first native Linux baseline and separately on this
   WSL/Desktop host. Include UID 1000 and a different UID, batch, PTY, workspace
   round trips, no host runtime access, and cleanup after failure/SIGKILL.
4. Add Images and Packages with the chosen Linux egress design, repeating direct
   IPv4/IPv6, DNS, host/LAN/metadata, cross-bundle, host-publication, and package
   policy negatives after network attachment. Exercise real builds and Compose.
5. Add mandatory live release jobs for advertised environments and then widen
   admission. Extend the existing build/test CI with these gates; ordinary unit
   jobs on Ubuntu do not substitute for them. The optional nested-daemon image
   integration test currently skips unless explicitly enabled and available.
