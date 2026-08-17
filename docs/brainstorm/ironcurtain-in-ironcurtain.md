# Developing IronCurtain Inside IronCurtain

**Date:** 2026-07-04
**Status:** Proposal
**Purpose:** Define how IronCurtain could support its own development from inside an IronCurtain Docker Agent Mode container, including nested container execution, provider forwarding, MCP/policy implications, and rollout risks.

## Executive Summary

IronCurtain can plausibly support "IronCurtain inside IronCurtain", but it should be an explicit developer capability, not a default Docker Agent Mode behavior.

The recommended path is:

1. Add an opt-in `nestedDocker` developer mode for Docker Agent Mode.
2. Prefer rootless Docker-in-Docker for the first implementation.
3. Add a parent-proxy forwarding path so the inner IronCurtain MITM proxy can reach AI providers and package registries through the outer IronCurtain policy boundary.
4. Keep the host Docker socket path as an unsafe escape hatch only, disabled by default and clearly outside the normal security promise.
5. Treat image pulls/builds as a separate egress surface. Package-manager proxying is already covered by the MITM registry path; OCI image pulls are not.
6. Add policy and audit labels for nested containers so the outer session can identify, budget, and clean up everything the inner IronCurtain launches.

The largest architectural gap is not starting `dockerd` in the container. It is nested egress. The inner IronCurtain process would run inside an outer IronCurtain agent container that intentionally has no direct internet access. Its own MITM proxy currently forwards upstream with direct `http.request` / `https.request`, not through an HTTP parent proxy. Without a parent-proxy mode, the inner proxy cannot reach Anthropic/OpenAI/OpenRouter/package registries unless we weaken the outer container network isolation.

## Grounding in Current Code

The existing architecture already has most of the pieces we want to preserve:

- Docker Agent Mode is mediated by `createDockerInfrastructure()` and `createSessionContainers()` in [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts). It starts host-side Code Mode and MITM proxies, then creates a long-lived agent container driven by `docker exec`.
- Container creation flows through `ContainerRuntime` in [`src/docker/types.ts`](../../src/docker/types.ts) and the Docker CLI implementation in [`src/docker/docker-manager.ts`](../../src/docker/docker-manager.ts). The manager intentionally shells out to `docker` via argument arrays rather than using the Docker Engine API.
- `buildCreateArgs()` in [`src/docker/docker-manager.ts`](../../src/docker/docker-manager.ts) drops all Linux capabilities, then selectively re-adds only the small set needed for the current agent workflow. Nested Docker cannot be bolted on without expanding this container-create surface.
- Network isolation is explicit and topology-dependent in [`src/docker/network-topology.ts`](../../src/docker/network-topology.ts): Linux Docker uses `--network=none` plus UDS mounts, Docker Desktop uses an internal bridge plus a socat sidecar, and Apple `container` uses a host-only network with source-address guards.
- LLM and package egress are mediated by [`src/docker/mitm-proxy.ts`](../../src/docker/mitm-proxy.ts). The proxy performs host allowlisting, TLS termination, endpoint filtering, fake-to-real key swapping, token-stream extraction, package-registry filtering, and dynamic passthrough-domain management.
- Provider endpoint definitions live in [`src/docker/provider-config.ts`](../../src/docker/provider-config.ts). Provider configs already support `upstreamTarget` for API gateways, but the MITM forwarding path itself does not currently support using a parent HTTP proxy for its own outbound requests.
- Dynamic network expansion already has a policy-controlled MCP surface: [`src/docker/proxy-tools.ts`](../../src/docker/proxy-tools.ts) defines `add_proxy_domain`, `remove_proxy_domain`, and `list_proxy_domains`, with add-domain always escalating.
- Package installation is already routed through the MITM proxy when `userConfig.packageInstall.enabled` is true in [`src/docker/docker-infrastructure.ts`](../../src/docker/docker-infrastructure.ts), using registry configs from [`src/docker/registry-proxy.ts`](../../src/docker/registry-proxy.ts) and binary allow/deny validation in [`src/docker/package-validator.ts`](../../src/docker/package-validator.ts).
- MCP server processes can be OS-sandboxed through [`src/trusted-process/sandbox-integration.ts`](../../src/trusted-process/sandbox-integration.ts). Omitted `sandbox` means restrictive defaults; `sandbox: false` is an explicit opt-out.
- The default MCP server set in [`src/config/mcp-servers.json`](../../src/config/mcp-servers.json) already includes one Docker-spawned server, `github`, which runs `docker run -i --rm ... ghcr.io/github/github-mcp-server`. Running IronCurtain inside IronCurtain will make this kind of MCP integration depend on the nested runtime too.
- The agent base image in [`docker/Dockerfile.base`](../../docker/Dockerfile.base) is already a rich development environment with Node, Python, Rust, Playwright, uv, ruff, CA trust, and package tooling. It does not currently install or start a Docker daemon for the agent.

## Problem Statement

For normal IronCurtain use, the external agent container is untrusted. It gets:

- A mounted workspace at `/workspace`.
- No direct network egress in the Linux topology.
- A fake API key whose real credential lives only in the host MITM proxy.
- A policy-mediated MCP endpoint for external actions.
- A package proxy path for apt/npm/pip/uv/cargo when package installation is enabled.

When IronCurtain itself is developed inside that container, the inner development workflow may want to run:

- `npm test` and unit tests with mocked container runtimes.
- Docker integration tests.
- `ironcurtain mux`, `ironcurtain start --agent ...`, or workflow runs from inside `/workspace`.
- Inner Docker Agent Mode sessions that create their own agent containers.
- MCP integrations that themselves launch Docker containers, such as the bundled GitHub MCP server.

Those require a usable container runtime inside the outer agent container. But giving an untrusted container broad Docker control is equivalent to handing it a large part of the host. Docker's own docs warn that bind-mounting the Docker socket gives the container full access to create and manipulate the host Docker daemon, and that `--privileged` containers are not securely sandboxed and can take control over the host.

The design target is therefore not "make Docker work somehow". It is "make nested IronCurtain work while preserving as many IronCurtain invariants as possible, and make any degraded invariants explicit".

## Requirements

- The outer IronCurtain session remains the top-level policy boundary.
- Nested runtime access is opt-in, visible in config/session metadata, and auditable.
- The inner IronCurtain process must not receive real AI provider credentials from the outer host.
- Inner provider calls must traverse the outer MITM proxy, so the outer session still sees provider egress.
- Nested package installs should traverse the existing package proxy where possible.
- Nested image pulls/builds must either be pre-seeded, blocked, or routed through a new OCI registry mediation path.
- Nested containers must be labeled and cleaned up by the outer session on teardown.
- The design must support ordinary IronCurtain source development without weakening normal user sessions.

## Non-Goals

- Do not make nested Docker the default behavior for Docker Agent Mode.
- Do not silently mount the host Docker socket into agent containers.
- Do not automatically fall back from rootless nested Docker to privileged nested Docker.
- Do not claim the same isolation guarantees when `--privileged` or host Docker socket mode is enabled.
- Do not require Apple `container` parity in the first slice; treat it as a separate compatibility track.

## Runtime Options

### Option 1: Host Docker Socket Mount

This is the fastest path:

- Install or expose a Docker CLI in the outer agent container.
- Bind-mount `/var/run/docker.sock`.
- Set `DOCKER_HOST=unix:///var/run/docker.sock`.

It is also the worst fit for IronCurtain's security model. A process with host Docker socket access can create containers with arbitrary mounts and privileges. It can mount the host filesystem, start privileged containers, and bypass the outer workspace boundary.

Recommendation: keep this only as `nestedDocker: "host-socket-unsafe"` or a similarly blunt local-development escape hatch. It must require an explicit user choice at session start, emit a warning, stamp the session metadata, and be excluded from any "secure runtime" claim.

### Option 2: Privileged Docker-in-Docker

Classic `docker:dind` runs a Docker daemon inside the agent container, typically with `--privileged`. This avoids direct access to the host Docker daemon, but it conflicts with IronCurtain's current hardening:

- The outer container currently starts with `--cap-drop=ALL`.
- Docker's `--privileged` disables several runtime confinement layers and grants broad device/sysfs/cgroup access.
- Docker docs explicitly describe `--privileged` as the special-use path for Docker-in-Docker and warn that it is not a secure sandbox.

Recommendation: do not use this as the default implementation. It can remain a spike tool to validate nested IronCurtain behavior quickly, but production developer mode should not depend on it.

### Option 3: Rootless Docker-in-Docker

Rootless Docker is the best first implementation candidate. Docker documents rootless mode as running both the daemon and containers as a non-root user to mitigate daemon/runtime vulnerabilities. For IronCurtain this is a better match than `--privileged` because:

- It can preserve the outer container's "no host Docker socket" invariant.
- It keeps nested container state inside the outer container or a bundle-scoped mount.
- It gives inner IronCurtain a normal Docker CLI/API target.
- It allows the inner IronCurtain Linux topology to work naturally: inner proxies can bind UDS paths under the outer container filesystem and bind-mount those UDS directories into nested agent containers.

Expected additions:

- Install Docker CLI, rootless dockerd dependencies, `uidmap`, `fuse-overlayfs`, and `slirp4netns` in a new dev-capable agent image layer.
- Add a bundle-scoped writable mount for nested Docker state, for example `${bundleDir}/nested-docker` mounted at `/home/codespace/.local/share/docker` or a dedicated `/var/lib/ironcurtain-nested-docker`.
- Start rootless `dockerd` from the entrypoint or an explicit bootstrap script.
- Export `DOCKER_HOST=unix:///run/user/<uid>/docker.sock` inside the outer agent container.
- Add health checks before telling the agent nested Docker is available.

Risks:

- Rootless Docker may still need kernel features unavailable inside some Docker Desktop or Apple `container` environments.
- Storage driver behavior must be validated on macOS Docker Desktop, Linux Docker, and Apple `container`.
- Docker build networking must be forced through proxies; otherwise builds will fail or create an unmediated egress hole.

Recommendation: make this the main first-class developer mode, gated by a startup preflight that fails closed.

### Option 4: Parent ContainerRuntime Broker

Longer term, the most IronCurtain-native solution is not a real Docker daemon inside the agent container. It is a constrained parent runtime broker:

- The outer host process exposes a narrow ContainerRuntime API over a UDS/TCP endpoint.
- The inner IronCurtain selects a `containerRuntime: "parent-broker"` backend.
- The broker creates sibling containers using the outer host runtime but enforces allowed mounts, labels, networks, resource limits, proxy env, and cleanup.
- Calls to the broker can be policy-evaluated as structured operations, rather than giving the inner process a raw Docker daemon.

This aligns better with the existing `ContainerRuntime` seam in [`src/docker/types.ts`](../../src/docker/types.ts), but it is a larger project because it requires a new runtime implementation and a compatibility strategy for existing Docker-based MCP servers. It also means inner IronCurtain is no longer exercising the same Docker code path as a normal user.

Recommendation: track as the stronger long-term design, but do rootless DinD first to unblock local development and integration tests.

## Proposed Architecture

### 1. Add an Explicit Nested Docker Session Capability

Add a developer-only config/session field, conceptually:

```jsonc
{
  "nestedDocker": {
    "mode": "rootless",
    "state": "bundle",
    "allowImagePulls": false
  }
}
```

Possible modes:

| Mode | Meaning | Default |
|------|---------|---------|
| `off` | Current behavior. No nested Docker support. | yes |
| `rootless` | Start rootless dockerd inside the agent container. | no |
| `host-socket-unsafe` | Mount host Docker socket. Local-dev only. | no |
| `privileged-dind-unsafe` | Run privileged DinD. Spike/local-dev only. | no |

This belongs in user config and session creation options, not in policy alone, because container capabilities and mounts must exist before the agent starts. Policy can decide whether the agent may use nested Docker-related MCP tools, but it cannot retroactively add `/dev/fuse`, a dockerd data mount, or a Docker socket.

### 2. Extend Container Creation for Nested Runtime Needs

`DockerContainerConfig` currently supports mounts, env, resources, extra hosts, labels, ports for service containers, capabilities, TTY, and user. Rootless nested Docker may require additional create-time controls:

- `devices`, probably `/dev/fuse`.
- `securityOpt`, only if rootless Docker proves it needs a non-default seccomp path.
- `tmpfs` or writable runtime directories for `/run/user/<uid>`.
- Possibly `sysctls` or cgroup options depending on runtime behavior.

These should be added narrowly and only emitted when `nestedDocker.mode === "rootless"`. Normal agent containers should remain byte-for-byte equivalent.

### 3. Add an IronCurtain Development Image Layer

The current base image is already close to a devcontainer. Add either:

- A separate `Dockerfile.dev` / `ironcurtain-dev:latest`, or
- An optional nested-runtime layer used by all agents only when nested mode is enabled.

The separate image is cleaner because ordinary agent sessions should not pay for Docker daemon dependencies.

The dev image should include:

- Docker CLI.
- Rootless Docker daemon tooling.
- `uidmap`, `fuse-overlayfs`, `slirp4netns`, and supporting packages.
- A bootstrap script under `/etc/ironcurtain/start-nested-docker.sh`.
- A health-check script under `/etc/ironcurtain/check-nested-docker.sh`.

The agent orientation should only mention nested Docker when the health check passes.

### 4. Add Parent-Proxy Forwarding to MITM

This is the load-bearing networking change.

Today, the MITM proxy forwards provider traffic with direct `http.request` / `https.request`. Inside an outer IronCurtain container that has no direct egress, that direct upstream connection fails.

Add MITM support for a parent HTTP proxy:

```jsonc
{
  "parentProxy": {
    "httpProxy": "http://127.0.0.1:18080",
    "caCertificatePath": "/usr/local/share/ca-certificates/ironcurtain-ca.crt"
  }
}
```

The forwarding path would:

- Keep endpoint filtering and fake-key validation in the inner MITM.
- Swap the inner fake key to an "inner real key".
- Make the upstream request through the parent HTTP proxy with CONNECT.
- Let the outer MITM terminate that TLS, validate the outer fake key, and swap to the actual host credential.

This creates a safe key cascade:

```
nested agent container
  sends inner fake key
  |
inner MITM, running inside outer container
  swaps to outer fake key
  |
outer MITM, running on the real host
  swaps to real provider credential
  |
AI provider
```

The inner IronCurtain config must never contain the user's real host provider key. It should be bootstrapped with parent-proxy provider profiles whose "real" keys are the fake sentinels that the outer session already injected into the outer container environment.

Open implementation choice: the parent proxy can be represented as a general MITM option or as another `UpstreamTarget` variant. It should not be implemented by relying on process-level `HTTPS_PROXY`, because Node's `https.request` does not automatically honor it and the current proxy code builds request options manually.

### 5. Forward Package Installs Through Both Layers

For package managers inside nested agent containers:

- The nested agent uses `HTTP_PROXY` / `HTTPS_PROXY` pointing at the inner MITM.
- The inner MITM applies package validation if inner config enables `packageInstall`.
- The inner MITM forwards registry requests through the parent proxy.
- The outer MITM applies the outer package validation policy.

This gives two useful modes:

- Strict development: both inner and outer validators run.
- Parent-governed development: inner validator permissive, outer validator authoritative.

The latter is probably simpler for IronCurtain development: the outer policy/config decides which package installs are allowed in the whole nested stack.

### 6. Treat OCI Image Pulls as a New Surface

Docker image pulls are not covered by the existing npm/PyPI/Debian/Cargo registry proxy. A nested Docker daemon will need images such as:

- `ironcurtain-base:latest`
- `ironcurtain-claude-code:latest`
- `ironcurtain-codex:latest`
- `alpine/socat`
- GitHub MCP server images
- Test fixture images

There are three viable strategies:

1. Pre-seed the nested daemon with required images from tar archives. This is safest for phase 1 and works offline.
2. Add an OCI registry proxy/validator to MITM. This should handle `registry-1.docker.io`, auth token service calls, layer blob downloads, and digest allowlists.
3. Allow image registry passthrough domains with human approval via `add_proxy_domain`. This is least precise and should not be the default for automated workflow runs.

Recommendation: phase 1 should pre-seed images and deny arbitrary image pulls. Phase 2 should add an OCI registry proxy if nested workflow development needs real image pulls.

### 7. Label and Cleanup Nested Containers

Outer IronCurtain already labels containers with:

- `ironcurtain.bundle`
- `ironcurtain.workflow`
- `ironcurtain.scope`

Nested containers should carry an additional lineage label:

- `ironcurtain.parent-bundle=<outer bundle id>`
- `ironcurtain.nesting-level=1`
- `ironcurtain.inner-bundle=<inner bundle id>` when known

For rootless DinD, the outer host Docker daemon will not see nested containers directly because they live under the inner daemon. Cleanup must therefore happen in two layers:

- Inner IronCurtain should clean its own nested containers.
- Outer teardown should stop rootless dockerd and remove the entire nested Docker state mount if configured as ephemeral.

For the future parent-runtime broker, the outer host can enforce labels and cleanup directly.

### 8. Policy Model

Nested Docker changes the policy story in two ways:

1. The outer policy governs the outer agent's actions, including whether it can ask for proxy domains, invoke MCP tools, and mutate files in `/workspace`.
2. The inner IronCurtain has its own policy engine governing nested agent behavior, but its network and credentials are still subordinate to the outer session.

Recommended policy additions:

- A dedicated "IronCurtain development" persona/profile.
- A `nested-runtime` configuration section that is disabled by default and visible in session metadata.
- New audit events for nested runtime lifecycle: daemon start, daemon stop, image load, image pull attempt, nested container start, nested container cleanup.
- If a Docker MCP server is added later, annotate operations by semantic role, for example `docker-image-ref`, `docker-container-name`, `docker-volume-source`, and `docker-network-name`.
- Deny or escalate all operations that attempt host mounts outside the outer workspace. For rootless DinD this is mostly enforced by daemon containment; for a parent-runtime broker it must be explicit policy.

The existing `proxy` virtual MCP server should remain the only way for the agent to expand network domains dynamically. That means inner IronCurtain should not be able to punch new outer network holes except through an outer policy-controlled request.

### 9. MCP Integrations

The nested development environment should distinguish "outer MCP" from "inner MCP":

- Outer MCP tools are the tools available to the top-level agent through the outer `execute_code`.
- Inner MCP tools are the tools the inner IronCurtain launches for its own nested agent sessions.

Important cases:

- The bundled `github` MCP server currently spawns a Docker container. In nested mode it will require either rootless nested Docker or the future parent-runtime broker.
- Google Workspace and other OAuth-backed MCP servers require credential propagation. For development inside IronCurtain, prefer host-managed OAuth in the outer session; do not copy long-lived OAuth credentials into the outer agent container.
- Memory MCP can be enabled normally if its storage path is under the workspace or a policy-approved mount. If it needs an LLM, its calls must use the parent-proxy provider path.
- Any MCP server with direct network access must either run under the existing `srt` sandbox rules or be routed through policy-mediated fetch/proxy paths.

Recommendation for the first slice: support filesystem/git/fetch/memory and Docker-free tests first; support Docker-spawned MCP servers only after rootless nested Docker is stable.

## Phased Implementation Plan

### Phase 0: Spike and Threat-Model Validation

- Manually run rootless Docker inside an IronCurtain agent container.
- Validate on Linux Docker and macOS Docker Desktop.
- Check whether Apple `container` can support rootless nested Docker inside its Linux VM; if not, mark nested mode unsupported for that runtime.
- Verify that nested containers can bind-mount inner proxy UDS paths from the outer container filesystem.
- Verify that a nested agent container cannot reach `1.1.1.1:443` directly.
- Verify that inner MITM provider calls fail without parent proxy and succeed with a prototype parent proxy.

Exit criteria: a nested `ironcurtain start --agent codex` can make a provider call and write to `/workspace` without direct network egress.

### Phase 1: Parent-Proxy MITM Forwarding

- Add MITM parent proxy configuration.
- Route provider upstream requests through parent CONNECT when configured.
- Route registry upstream requests through the same parent proxy.
- Add tests with a fake parent MITM asserting that the inner MITM never connects directly.
- Add config bootstrap that maps inner "real" provider credentials to outer fake sentinels.

Exit criteria: inner IronCurtain can call providers and registries while the outer container has no direct egress.

### Phase 2: Rootless Nested Docker Mode

- Add `nestedDocker.mode = "rootless"` config/session option.
- Add a dev image layer with rootless dockerd dependencies and bootstrap scripts.
- Extend `DockerContainerConfig` narrowly for any required devices/security options.
- Add bundle-scoped nested Docker state mount.
- Add startup health checks and user-facing diagnostics.
- Add teardown cleanup.

Exit criteria: inner IronCurtain can create and run a nested agent container using the normal Docker `ContainerRuntime` implementation.

### Phase 3: Image Strategy

- Phase 3a: pre-seed required images into the nested daemon from tar archives.
- Phase 3b: add an OCI registry proxy or digest allowlist if real image pulls are needed.
- Fail closed on unknown image pulls by default.

Exit criteria: nested sessions do not require unrestricted access to Docker Hub or other image registries.

### Phase 4: Policy, Audit, and UX

- Add session metadata showing nested runtime mode and safety level.
- Add audit events for nested runtime lifecycle.
- Add warnings for unsafe modes.
- Add web UI / daemon visibility for nested dev sessions if this becomes a common workflow.
- Add docs for the IronCurtain development persona.

Exit criteria: a user can tell, after the fact, that a session had nested runtime authority and what it did with it.

### Phase 5: Integration Tests

Suggested tests:

- Rootless nested daemon starts, reports `docker info`, and stops cleanly.
- Inner MITM provider call traverses parent proxy.
- Inner package install traverses parent proxy and produces outer package audit entries.
- Nested agent container has no direct egress.
- Nested image pull is denied unless pre-seeded or explicitly allowed.
- Outer teardown cleans nested state.
- Host Docker socket is absent in rootless mode.
- Unsafe host-socket mode stamps metadata and emits a warning.
- Apple `container` either passes the same tests or fails with a clear unsupported-runtime message.

## Open Questions

- Does rootless Docker work reliably inside Docker Desktop containers without `--privileged` on current macOS hosts?
- Does Apple `container` expose enough kernel/cgroup/userns functionality inside its VM for rootless nested Docker?
- Should the inner IronCurtain use a real nested Docker daemon, or should we prioritize the parent-runtime broker once rootless DinD proves painful?
- How strict should the outer package validator be when inner IronCurtain is running its own validator?
- Is pre-seeding images sufficient for developer workflows, or do we need first-class OCI registry proxying?
- Should nested mode be limited to a dedicated IronCurtain development persona rather than a general user config field?
- How should cost/budget accounting aggregate outer and inner provider calls when both MITM layers can observe the same completion?

## Recommendation

Implement this in two deliberate slices:

1. Build parent-proxy forwarding first. Without this, nested IronCurtain can only work by weakening the outer network model.
2. Add rootless nested Docker second. Treat privileged DinD and host Docker socket mounts as unsafe local-development escape hatches, not as the architecture.

This preserves the central IronCurtain invariant: the top-level human-approved policy boundary remains outside the untrusted agent container, even when the code under development is IronCurtain itself.

## Sources

- Docker docs, [Rootless mode](https://docs.docker.com/engine/security/rootless/): rootless Docker runs the daemon and containers as a non-root user.
- Docker docs, [docker container run --privileged](https://docs.docker.com/reference/cli/docker/container/run/#privileged): Docker documents `--privileged` as a Docker-in-Docker use case and warns it is not securely sandboxed.
- Docker docs, [docker container run volume/socket note](https://docs.docker.com/reference/cli/docker/container/run/#mount-volume-read-only---read-only): bind-mounting the Docker socket gives a container full access to the host Docker daemon.
- Docker Hub, [official docker image](https://hub.docker.com/_/docker): `dind` and `dind-rootless` tags exist for daemon-in-container workflows.
- Existing IronCurtain designs: [Docker Agent Broker](../designs/docker-agent-broker.md), [TLS-Terminating API Proxy](../designs/tls-terminating-api-proxy.md), [Secure Package Installation Proxy](../designs/package-installation-proxy.md), [Execution Containment](../designs/execution-containment.md), [Apple container runtime](../designs/apple-container-runtime.md), and [Workflow-Scoped Docker Containers](../designs/workflow-container-lifecycle.md).
