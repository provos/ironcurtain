# Apple `container` Runtime Support

## Overview

Docker Agent Mode currently requires Docker (Docker Desktop on macOS) as the container runtime. This design adds [Apple `container`](https://github.com/apple/container) (1.0.0, June 2026) as an alternative backend on macOS. Apple's runtime executes every container in its own lightweight VM via the Virtualization framework, which is a strict upgrade for IronCurtain's Layer 1 isolation: a kernel exploit from a compromised agent is contained by a hardware-virtualization boundary rather than shared-kernel namespaces. It also removes the Docker Desktop dependency from the macOS install story.

Counterintuitively, adopting it _simplifies_ the macOS architecture. The current macOS Docker path needs a socat sidecar straddling an `--internal` network and the default bridge to forward exactly the two proxy ports (see `docs/designs/tcp-mode-network-egress-restriction.md`). Apple `container`'s `container network create --internal` creates a **host-only** vmnet network -- no internet egress, but native host↔container connectivity -- so the agent container reaches the host proxies directly and the sidecar, the dual-network attach, and the `host.docker.internal` remapping all disappear.

Everything above the container runtime is unaffected: the MITM proxy, MCP policy engine, agent adapters, orientation, escalation, audit, and trajectory capture are already runtime-agnostic above the `DockerManager` seam (`src/docker/types.ts`), which this design generalizes into a `ContainerRuntime` interface.

## Verified runtime capabilities

From the apple/container [command reference](https://github.com/apple/container/blob/main/docs/command-reference.md), [how-to guide](https://github.com/apple/container/blob/main/docs/how-to.md), and [technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md):

| IronCurtain needs                                  | Docker                                    | Apple `container`                                                                                 |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| create / start / exec / stop / rm                  | yes                                       | identical subcommands, incl. `exec --user/--uid/--gid`                                            |
| labels + JSON inspect (staleness, bundle identity) | `--label`, `docker inspect`               | `--label`, `container inspect` (JSON)                                                             |
| image build with baked CA cert                     | `docker build`                            | `container build -f -t -l` (BuildKit in a builder VM); OCI images, same Dockerfile                |
| resource limits                                    | `--memory`, `--cpus`                      | `--memory`, `--cpus` (VM-level)                                                                   |
| capability drop                                    | `--cap-drop=ALL` + re-adds                | `--cap-add` / `--cap-drop` (less load-bearing -- the VM is the boundary)                          |
| entrypoint / env / TTY                             | yes                                       | `--entrypoint`, `-e`, `-t`                                                                        |
| init process                                       | `--init` (tini)                           | `--init` (in-VM reaper init; `vminitd` is the VM's PID 1)                                         |
| network create / delete                            | `docker network ...`                      | `container network create/delete` with `--subnet`, `--internal` ("restrict to host-only network") |
| UDS bind mounts                                    | Linux only (VirtioFS limitation on macOS) | not supported (virtiofs) -- TCP transport stays                                                   |
| single-file bind mounts                            | yes                                       | not supported -- virtiofs shares directories only; apt proxy config is written via exec instead   |
| `--network=none`                                   | yes (Linux path)                          | not available -- host-only `--internal` network instead                                           |
| `--add-host`                                       | yes                                       | not available -- not needed (deterministic gateway IP, below)                                     |

Platform floor: Apple silicon, macOS 26 (the `container network` commands do not function on macOS 15 -- all containers land on one shared default network there, which is unacceptable for this design).

## Network Topology

```
┌──────────────────────────────────────────────┐
│  Lightweight VM (Apple container)            │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │         External Agent                 │  │
│  │    (Claude Code, Goose, etc.)          │  │
│  └──────┬──────────────────┬──────────────┘  │
│         │ LLM API calls    │ MCP tool calls  │
│         ▼                  ▼                 │
│   HTTPS_PROXY=        MCP endpoint =         │
│   http://<gw>:NNNN    <gw>:MMMM              │
└─────────┬──────────────────┬─────────────────┘
          │   host-only vmnet network          gw = gateway IP,
          │   (--internal: no egress)          deterministic .1 of
          ▼                  ▼                 the chosen --subnet
┌──────────────────┐  ┌─────────────────────┐
│  MITM Proxy      │  │  MCP Proxy          │   both bound to the
│  (host, TCP)     │  │  (host, TCP)        │   gateway IP only
└──────────────────┘  └─────────────────────┘
```

- Per-bundle isolated network: `container network create ironcurtain-<bundleId> --internal --subnet <from pool>`. Because we choose the subnet, the host-side gateway IP is deterministic (`.1`).
- The agent container runs with `--network ironcurtain-<bundleId>`; `HTTPS_PROXY` and the MCP endpoint point at the gateway IP directly. No sidecar, no DNS configuration (`container system dns` requires sudo and is global state -- avoided entirely).
- PTY mode: on a host-only network the host connects straight to the container's IP (from `container inspect`), replacing the sidecar's reversed `TCP-LISTEN` forwarding.

## Key Design Decisions

1. **Generalize `DockerManager` into a `ContainerRuntime` interface; Docker and Apple managers are peer implementations.** All container CLI invocations already flow through the single `DockerManager` interface (`src/docker/types.ts`). The interface is renamed `ContainerRuntime` and a factory (`src/docker/container-runtime.ts`) selects the implementation. Per the safe-coding rules, `apple-container-manager.ts` will be the only module allowed to spawn the `container` binary, always via `execFile` with argument arrays -- exactly mirroring `docker-manager.ts`.

2. **A third network topology, not a third inline branch.** `docker-infrastructure.ts` and `pty-session.ts` currently branch on `useTcpTransport()` between two topologies: `uds` (Linux) and `tcp-sidecar` (Docker on macOS). The sidecar assembly logic moves out of `pty-session.ts` into a topology strategy selected alongside the runtime: `uds` | `tcp-sidecar` | `tcp-hostonly`. Apple `container` always uses `tcp-hostonly`. The Docker paths keep their existing behavior byte-for-byte.

3. **Proxies bind 0.0.0.0 with a connection-source guard, not the gateway IP.** (Revised in phase 3.) The original plan was to bind the vmnet gateway address, but the bridge interface does not exist on the host until the first container attaches -- verified live: binding the gateway IP right after `network create` fails with `EADDRNOTAVAIL`. Since the container env needs the proxy ports before the container exists, gateway binding is unachievable. Instead both proxies listen on 0.0.0.0 and apply `makeSourceAddressGuard(subnet)` (network-topology.ts): sockets whose remote address is outside the bundle's host-only subnet (loopback excepted) are destroyed before any protocol parsing. This matters most for the Code Mode proxy, whose MCP endpoint is unauthenticated and previously bound 127.0.0.1; the MITM proxy already listened on 0.0.0.0 in Docker TCP mode (fake-key-guarded), so the guard strictly narrows its exposure. The Docker topologies keep their existing bind behavior.

4. **Fail-closed connectivity check, extended.** The existing startup gate (abort the session if the network setup is wrong, `SANDBOXING.md`) gains an inverse assertion for `tcp-hostonly`: from inside the container, (a) both proxy ports on the gateway must be reachable, and (b) a probe to an external IP must **fail**. If either check fails, session initialization aborts -- never a silent fallback to a weaker configuration.

5. **Honest security delta: host-only exposes host services bound to 0.0.0.0.** The Docker sidecar forwards exactly two ports; a host-only network instead exposes any host service listening on the vmnet bridge address -- in practice, services bound to `0.0.0.0` (loopback-bound services are unreachable from the VM). This residual risk is documented in `docs/SECURITY_CONCERNS.md` and is offset by the VM isolation upgrade. Future hardening: upstream already does vsock-based UDS forwarding for `--ssh`; a generic UDS-forward flag would restore Linux-grade "no network at all" and is worth an upstream feature request.

6. **Runtime selection: `containerRuntime: 'docker' | 'apple-container' | 'auto'` in `~/.ironcurtain/config.json`.** `auto` (default) prefers `apple-container` when its preflight passes (binary present, version >= 1.0, `container system status` healthy, Apple silicon, macOS 26+) and falls back to Docker otherwise. The signal-cli service container and daemon orphan sweeps stay on Docker until a later phase -- they are host services, not agent sandboxes, and gain nothing from a VM-per-container runtime.

7. **Image pipeline reuse.** `Dockerfile.base.arm64` plus the CA-cert bake and build-hash labels are reused verbatim; only the build command changes (`container build`). Apple silicon is required, so the arm64 Dockerfile is the only path. Subnets come from a configurable pool with collision detection at network-create time (vmnet networks share the host's routing table with the LAN).

## Implementation Plan

- **Phase 0 -- spike. DONE** (verified live against `container` 1.0.0 on macOS 26.5, 2026-06-10):
  - `container network create --internal` works without sudo, reports `mode: "hostOnly"`, and `network inspect` exposes `status.ipv4Gateway` directly -- no `.1` assumption needed.
  - Egress from an `--internal` container is fully blocked (TCP to 1.1.1.1:443 fails); a host listener bound to the gateway IP **is** reachable from the container. The `tcp-hostonly` topology is confirmed viable.
  - `--init` and `--cap-drop ALL` exist and work; inspect confirms `useInit: true` and `capDrop: ["ALL"]`.
  - `container build` syntax works, but the BuildKit builder VM requires **Rosetta**; on hosts without it the build fails with `VZErrorDomain ... Rosetta is not installed`. `buildImage()` surfaces the `softwareupdate --install-rosetta` remediation.
  - `--publish-socket host_path:container_path` exists (container-to-host UDS publishing) -- a candidate transport for the PTY listener in phase 4.
- **Phase 1 -- seam extraction (pure refactor). DONE.** Rename `DockerManager` → `ContainerRuntime`, add `ContainerRuntimeKind` + `createContainerRuntime()` factory with `docker` as the only implemented kind. No behavior change.
- **Phase 2 -- `AppleContainerManager`. DONE.** `src/docker/apple-container-manager.ts` implements `ContainerRuntime` over the `container` CLI with `checkAppleContainerAvailable()` preflight (Apple silicon + Darwin ≥ 25 + CLI ≥ 1.0 + apiserver running); unit tests in `test/apple-container-manager.test.ts` mirror `test/docker-manager.test.ts` with a mocked `execFile`. Unsupported Docker mechanisms (`extraHosts`, `restartPolicy`, `network: 'none'`, `connectNetwork`, explicit network gateways) throw instead of degrading silently. Validated end-to-end against the real CLI: create/start/exec/stop/delete, label reads, IP lookup, digest-based staleness IDs (image and container digests normalize to the same value), idempotent network create, stale-container removal.
- **Phase 3 -- `tcp-hostonly` topology. DONE.** `src/docker/network-topology.ts` carries topology resolution (`uds` | `tcp-sidecar` | `tcp-hostonly`), the 16-entry subnet pool (192.168.200-215.0/24, walked on the runtime's "overlaps an existing network" error, starting at a name-hash offset), `createHostOnlyNetwork` (stale-network cleanup + gateway from `ContainerRuntime.getNetworkGateway` with derived fallback), and `makeSourceAddressGuard`. `prepareDockerInfrastructure` creates the network before the proxies (the gateway feeds orientation + container env), passes the guard to both proxies, and `createSessionContainers` attaches the agent container with gateway-pointing `HTTP(S)_PROXY` -- no sidecar, no `extraHosts`. The fail-closed startup gate (`checkHostOnlyConnectivity`) asserts proxy reachability at the gateway AND that an egress probe to 1.1.1.1:443 fails. Until the phase 4 config field lands, `IRONCURTAIN_CONTAINER_RUNTIME=apple-container` selects the backend (unknown values throw). PTY mode fails fast with a clear error on this topology. Validated live: pool walk, gateway query, container→host connectivity through the guarded 0.0.0.0 listener, and egress blocking, all against `container` 1.0.0.
- **Phase 4 -- PTY path + config. DONE.**
  - PTY: on `tcp-hostonly` the host connects directly to the container's IP at the fixed PTY port (`attachPty`'s existing TCP retry covers socat startup) — no sidecar, no port publishing, no `--publish-socket` needed. The apt proxy config is written via the shared `writeHostOnlyAptProxyConfig` exec helper, and the same fail-closed `checkHostOnlyConnectivity` gate runs before attach. Validated live: a stub attach received 2.3 KB of Claude Code TUI output from `<containerIp>:19000` with clean teardown.
  - Config: `containerRuntime: 'auto' | 'docker' | 'apple-container'` in `~/.ironcurtain/config.json` (default `auto`), editable under `ironcurtain config` → Session Mode. Resolution precedence: `IRONCURTAIN_CONTAINER_RUNTIME` env override > config field > `auto` probe (memoized per process so preflight, infrastructure setup, and image ensure agree). The session preflight picks its availability probe from the same resolution. Validated live: with no env var on a Docker-less macOS 26 machine, `auto` selected apple-container and ran a full PTY session.
- **Phase 5 -- docs + tests.** Update `SANDBOXING.md` Layer 1 and `SECURITY_CONCERNS.md`; integration tests gated on `container` binary presence (graceful skip, matching the Docker tests' pattern).

## Risks and Open Questions

- **macOS 26 + Apple silicon floor.** Hard requirement; `auto` handles fallback. macOS 15 is explicitly unsupported for this backend.
- **vmnet subnet collisions** with the user's LAN. Mitigated by the configurable pool + collision detection; same class of problem Docker's address pools already have.
- **Pre-1.0 API drift is no longer a concern** (1.0.0 shipped 2026-06-09 with stability guarantees), but the preflight pins a minimum version.
- **No `network connect` equivalent.** Confirmed absent in 1.0.0 (`connectNetwork` throws). Irrelevant to this design (no sidecar), but it rules out porting the sidecar pattern as-is if `tcp-hostonly` hits a wall.
- **Rosetta required for `container build`.** The BuildKit builder VM needs Rosetta installed; preflight messaging covers it, and `ironcurtain doctor` should eventually check for it.
- **Resource-limit probing** (`resource-limits.ts`) assumes `docker run --rm`; the equivalent `container run --rm` probe is phase 3 work alongside the topology extraction.
