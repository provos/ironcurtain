# TCP Mode: Network Egress Restriction via `--internal` Docker Network

## Problem

On macOS, Docker Desktop's VirtioFS does not support Unix domain sockets in
bind mounts. PR #28 adds TCP-based proxy transport as a workaround: the MCP
proxy and MITM proxy listen on TCP ports on the host, and the container
connects via `host.docker.internal`. This requires switching the container
from `--network=none` to `--network=bridge`.

The security regression: a container on a bridge network can make arbitrary
outbound TCP connections to the internet, bypassing both the MITM proxy
(which filters LLM API endpoints) and the MCP proxy (which enforces policy).
The `HTTP_PROXY` / `HTTPS_PROXY` environment variables are advisory -- any
software in the container can ignore them.

## Proposed Solution

Use Docker's `--internal` flag on a custom bridge network. This provides
**host-level egress enforcement** (iptables DROP rules + no default route)
that the container cannot override without `CAP_NET_ADMIN`, which we do not
grant.

### How `--internal` Networks Work

Docker's `--internal` flag on a bridge network does three things:

1. **No default route** in the container's routing table
2. **iptables DROP rules** that block traffic leaving the bridge subnet
3. **Gateway IP remains reachable** (documented, by design)

All enforcement is at the Docker daemon / host network layer. The container
cannot circumvent it.

### Docker Desktop macOS Complication

On Docker Desktop, containers run inside a Linux VM. The networking path is:

```
Container → Bridge (in VM) → VM network → macOS host
```

- `host.docker.internal` normally resolves to `192.168.65.254` (VM internal
  network), which is **outside** the bridge subnet and would be blocked by
  `--internal` DROP rules.
- The bridge gateway (e.g., `172.30.0.1`) is on the bridge interface inside
  the VM, not directly on the macOS host.

The key question is whether Docker Desktop forwards traffic addressed to the
bridge gateway IP to the macOS host. If it does, the proxies (listening on
the macOS host) are reachable. If not, we need a fallback.

## Implementation Plan

### 1. Create a dedicated `--internal` Docker network

At session startup (before container creation):

```bash
docker network create \
  --internal \
  --driver bridge \
  --subnet 172.30.0.0/24 \
  --gateway 172.30.0.1 \
  ironcurtain-restricted
```

This network is created once and reused across sessions. It can be created
lazily on first TCP-mode session and cleaned up on last session close (or
left in place).

### 2. Override `host.docker.internal` to point at the gateway

When creating the container, use `--add-host` to override DNS:

```bash
docker create \
  --network ironcurtain-restricted \
  --add-host=host.docker.internal:172.30.0.1 \
  -e HTTPS_PROXY=http://host.docker.internal:${MITM_PORT} \
  -e HTTP_PROXY=http://host.docker.internal:${MITM_PORT} \
  ...
```

The container resolves `host.docker.internal` to the bridge gateway
(`172.30.0.1`), which is reachable on an `--internal` network.

### 3. Bind proxies to `0.0.0.0` in TCP mode

Currently the MCP proxy and MITM proxy bind to `127.0.0.1`. In TCP mode,
they must bind to `0.0.0.0` so Docker Desktop's network translation layer
can forward traffic from the VM bridge gateway to the macOS host.

**Files to change:**
- `src/trusted-process/tcp-server-transport.ts` -- accept configurable bind
  address (or always use `0.0.0.0`)
- `src/docker/mitm-proxy.ts` -- bind to `0.0.0.0` in TCP mode

### 4. Add `DockerManager` methods for network lifecycle

Add to `src/docker/docker-manager.ts`:

- `ensureNetwork(name, options)` -- create the internal network if it does
  not exist (idempotent)
- `removeNetwork(name)` -- remove network (for cleanup)

The `create()` method already accepts a `network` parameter; no change
needed there.

### 5. Add `--add-host` support to container creation

The `DockerManager.create()` method needs a new option for extra hosts:

```typescript
interface ContainerCreateOptions {
  // ... existing fields ...
  extraHosts?: readonly string[];  // e.g., ["host.docker.internal:172.30.0.1"]
}
```

### 6. Connectivity validation at startup

After creating and starting the container but before running the agent,
verify that the container can reach both proxies:

```bash
docker exec $CONTAINER_ID \
  sh -c "echo | socat - TCP:host.docker.internal:${MCP_PORT}"
```

If this fails, log a clear error. This catches the case where Docker Desktop
does not forward internal-bridge-gateway traffic to the macOS host.

### 7. Fallback strategy

If the connectivity check fails:
- Log a warning explaining the security implication
- Fall back to the current plain `bridge` network behavior
- The orientation prompt already reflects this (from the fixes in this PR)

## Manual Testing on macOS

### Prerequisites

- macOS with Docker Desktop installed
- IronCurtain checked out and built (`npm run build`)
- A working `.env` with `ANTHROPIC_API_KEY`

### Test 1: Verify `--internal` network blocks internet egress

```bash
# Create the internal network
docker network create --internal \
  --subnet 172.30.0.0/24 \
  --gateway 172.30.0.1 \
  ironcurtain-test-net

# Run a container on it and try to reach the internet
docker run --rm --network ironcurtain-test-net alpine:latest \
  sh -c "wget -q -O- --timeout=5 http://example.com && echo REACHABLE || echo BLOCKED"

# Expected: BLOCKED (timeout or connection refused)
```

### Test 2: Verify gateway is reachable from `--internal` network

```bash
# Start a simple TCP listener on the host
# (In a separate terminal)
python3 -c "
import socket
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', 19999))
s.listen(1)
print('Listening on 0.0.0.0:19999')
conn, addr = s.accept()
print(f'Connection from {addr}')
conn.send(b'HELLO\n')
conn.close()
s.close()
"

# From a container on the internal network, try to connect via gateway
docker run --rm \
  --network ironcurtain-test-net \
  --add-host=host.docker.internal:172.30.0.1 \
  alpine:latest \
  sh -c "echo | nc host.docker.internal 19999"

# Expected: receives "HELLO" -- confirms gateway→host forwarding works
```

### Test 3: Verify container cannot bypass proxy

```bash
# From the internal network container, try a direct HTTPS connection
docker run --rm \
  --network ironcurtain-test-net \
  --add-host=host.docker.internal:172.30.0.1 \
  alpine:latest \
  sh -c "wget -q -O- --timeout=5 https://api.anthropic.com/ 2>&1 || echo BLOCKED"

# Expected: BLOCKED -- no route to internet
```

### Test 4: End-to-end with IronCurtain

If Tests 1-3 pass, run a full IronCurtain Docker session on macOS and verify:

1. The agent can call MCP tools (traffic goes through MCP proxy)
2. The agent can make LLM API calls (traffic goes through MITM proxy)
3. The agent cannot `curl` or `wget` arbitrary URLs directly
4. The audit log shows all tool calls

### Cleanup

```bash
docker network rm ironcurtain-test-net
```

## What If It Doesn't Work?

If Docker Desktop does not forward internal-bridge-gateway traffic to the
macOS host (i.e., Test 2 fails), the alternatives are:

1. **iptables in the Docker Desktop VM** -- run iptables rules inside the
   Linux VM via `nsenter`. Effective but ephemeral (lost on Docker Desktop
   restart). IronCurtain would need to re-apply rules each session.

2. **Sidecar proxy container** -- run a TCP forwarder container on both the
   internal network and the host network, bridging traffic between them.
   More complex but fully portable.

3. **Accept the trade-off** -- document that macOS TCP mode has weaker
   network isolation than Linux UDS mode, and rely on the MITM proxy's
   endpoint filtering + fake API keys as the primary defense. The container
   can reach the internet but cannot authenticate to LLM APIs.

Option 3 is the current state (before this design). Options 1 and 2 add
complexity but provide stronger isolation. The right choice depends on
whether the threat model requires preventing all outbound access or just
preventing unauthorized LLM API usage.
