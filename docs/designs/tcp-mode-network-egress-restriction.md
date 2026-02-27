# TCP Mode: Network Egress Restriction via `--internal` Docker Network + Socat Sidecar

**Status:** Implemented (PR #32)

## Problem

On macOS, Docker Desktop's VirtioFS does not support Unix domain sockets in
bind mounts. PR #28 adds TCP-based proxy transport as a workaround: the MCP
proxy and MITM proxy listen on TCP ports on the host, and the container
connects via `host.docker.internal`. This requires switching the container
from `--network=none` to a networked mode.

The security regression: a container on a bridge network can make arbitrary
outbound TCP connections to the internet, bypassing both the MITM proxy
(which filters LLM API endpoints) and the MCP proxy (which enforces policy).
The `HTTP_PROXY` / `HTTPS_PROXY` environment variables are advisory -- any
software in the container can ignore them.

## Solution: `--internal` Network + Socat Sidecar

### How `--internal` Networks Work

Docker's `--internal` flag on a bridge network does three things:

1. **No default route** in the container's routing table
2. **iptables DROP rules** that block traffic leaving the bridge subnet
3. **Gateway IP remains reachable** (documented, by design)

All enforcement is at the Docker daemon / host network layer. The container
cannot circumvent it without `CAP_NET_ADMIN`, which is not granted.

### Docker Desktop macOS Complication

On Docker Desktop, containers run inside a Linux VM. The bridge gateway IP
(e.g., `172.30.0.1`) lives inside the VM and does **not** forward TCP traffic
to the macOS host. This means the agent container on an `--internal` network
cannot directly reach host-side proxies via the gateway IP.

### Sidecar Solution

A lightweight socat sidecar container bridges the gap:

```
┌─────────────────────────────────┐
│  ironcurtain-internal (--internal) │
│                                 │
│  App Container ──TCP──► Sidecar │
│  (no internet)          (socat) │
└─────────────────────────┬───────┘
                          │
┌─────────────────────────┴───────┐
│  bridge (default)               │
│                                 │
│  Sidecar ──TCP──► host.docker.  │
│  (socat)          internal      │
└─────────────────────────────────┘
                          │
                     macOS host
                  (MCP + MITM proxies)
```

1. The sidecar is created on the default `bridge` network (can reach
   `host.docker.internal`).
2. It is then connected to the `--internal` network, giving it a second
   network interface.
3. The sidecar runs two socat forwarders — one for each proxy port — that
   listen on the internal network and forward to the host.
4. The app container's `host.docker.internal` is overridden via `--add-host`
   to point at the sidecar's IP on the internal network.

The app container can **only** reach the two forwarded proxy ports. It cannot
reach the host gateway, any host service, or the internet. This provides
the same security guarantee as Linux's `--network=none`.

## Implementation

### Network and sidecar creation (session startup)

```bash
# 1. Create --internal network
docker network create --internal \
  --subnet 172.30.0.0/24 --gateway 172.30.0.1 \
  ironcurtain-internal

# 2. Create and start socat sidecar on default bridge
docker create --name ironcurtain-sidecar-${ID} \
  --network bridge --entrypoint /bin/sh alpine/socat \
  -c "socat TCP-LISTEN:${MCP_PORT},fork,reuseaddr TCP:host.docker.internal:${MCP_PORT} & \
      socat TCP-LISTEN:${MITM_PORT},fork,reuseaddr TCP:host.docker.internal:${MITM_PORT}"
docker start ironcurtain-sidecar-${ID}

# 3. Connect sidecar to internal network
docker network connect ironcurtain-internal ironcurtain-sidecar-${ID}

# 4. Get sidecar's IP on internal network
SIDECAR_IP=$(docker inspect -f '{{json .NetworkSettings.Networks}}' \
  ironcurtain-sidecar-${ID} | jq -r '.["ironcurtain-internal"].IPAddress')

# 5. Create app container on internal network, pointing at sidecar
docker create --network ironcurtain-internal \
  --add-host=host.docker.internal:${SIDECAR_IP} \
  -e HTTPS_PROXY=http://host.docker.internal:${MITM_PORT} \
  ...
```

### Connectivity validation

After starting the app container, verify proxy reachability:

```bash
docker exec $CONTAINER_ID \
  socat -u /dev/null TCP:host.docker.internal:${MCP_PORT},connect-timeout=5
```

If this fails, IronCurtain aborts session initialization.

### Cleanup (session close)

Both the app container and sidecar are stopped and removed. The internal
network is removed (errors ignored — other sessions may still use it).

## DockerManager Interface Additions

```typescript
// Connect an existing container to a Docker network
connectNetwork(networkName: string, containerId: string): Promise<void>;

// Get a container's IP on a specific network (with retry for async IP assignment)
getContainerIp(containerId: string, network: string): Promise<string>;
```

The `DockerContainerConfig` also gained an `entrypoint` field to override
the `alpine/socat` image's `ENTRYPOINT ["socat"]`.

## Manual Testing on macOS

### Test 1: Verify `--internal` network blocks internet egress

```bash
docker network create --internal \
  --subnet 172.30.0.0/24 --gateway 172.30.0.1 \
  ironcurtain-test-net

docker run --rm --network ironcurtain-test-net alpine:latest \
  sh -c "wget -q -O- --timeout=5 http://example.com && echo REACHABLE || echo BLOCKED"
# Expected: BLOCKED

docker network rm ironcurtain-test-net
```

### Test 2: End-to-end with IronCurtain

Run a full IronCurtain Docker session on macOS and verify:

1. The agent can call MCP tools (traffic goes through MCP proxy)
2. The agent can make LLM API calls (traffic goes through MITM proxy)
3. The agent cannot `curl` or `wget` arbitrary URLs directly
4. The audit log shows all tool calls
