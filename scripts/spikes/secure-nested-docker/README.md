# Secure nested Docker evidence probes

This directory contains the timeboxed Phase 0A evidence protocol and exploratory Phase 0B runtime
probes from `docs/designs/secure-nested-runtime-implementation-plan.md`. Phase 0A deliberately uses
a fake file-backed runtime. Phase 0B tests individual Docker Desktop and Apple `container`
primitives under hard stop gates. Passing any probe does not qualify a backend or prove native Linux
or product feasibility.

Run all five required self-tests:

```sh
node scripts/spikes/secure-nested-docker/self-test.mjs
```

The command creates host-owned evidence beneath the operating system temporary directory, outside
the repository, and prints that directory. It covers a benign mutation, interrupt cleanup,
`SIGKILL` in the create/ID-record window followed by the checked-in recovery command, environment
redaction, and schema/tamper rejection. Each valid run has a canonical SHA-256 manifest and two
empty cleanup inventories.

The standalone recovery command requires all identities explicitly:

```sh
node scripts/spikes/secure-nested-docker/recover.mjs \
  --evidence-dir /absolute/outside-workspace/evidence \
  --state-dir /absolute/outside-workspace/state \
  --workspace-root /absolute/workspace \
  --run-id phase0a-example-0001
```

Never point the harness at production resources. Phase 0B must replace the fake runtime with the
specific, stop-gated Docker Desktop and Apple probes defined in the design.

The first Docker Desktop prerequisite probe is intentionally narrower than the full Phase 0B track:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-p0.mjs
node scripts/spikes/secure-nested-docker/verify-probe-evidence.mjs \
  --evidence-dir /path/printed-by-the-probe
```

It uses the pinned arm64 `docker:29.2.1-dind-rootless` artifact only to test an unprivileged user
namespace under P0-STRICT. It does not start `dockerd`, attach a proxy network, or qualify a backend.
The container is created with no network, no capabilities, no devices or outer privilege, a
read-only root, bounded tmpfs, and outer CPU/memory/PID limits. Cleanup validates the exact returned
ID and ownership labels, removes its anonymous volumes, and records two empty inventories.

After P0 produces a denial, the same recorder can run the cumulative one-artifact P2 probe:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-p0.mjs --profile-level p2
```

The checked-in profile is hash-pinned by `config/docker-workload/profile-ceiling.json`, is derived
from Moby's tagged `seccomp/v0.2.1` default, and currently adds only the denial-proven `clone`,
`unshare`, `mount`, `setns`, `pivot_root`, and `umount2` syscalls. The subset verifier proves that removing those tagged
entries produces the pinned canonical Moby profile and that every addition is declared, eligible,
and evidence-bound:

```sh
node scripts/spikes/secure-nested-docker/verify-profile-ceiling.mjs
```

A hash or subset mismatch is terminal before container creation.

Once the namespace prerequisite passes, daemon boot uses the identical cumulative profile and outer
envelope:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-p0.mjs --profile-level p2 --probe daemon
```

This boot probe explicitly selects RootlessKit `--net=none`, uses a private UDS, `vfs`, no
bridge/iptables, and no registry or external network. It records readiness, daemon logs on failure,
outer inspect, and exact cleanup; it still does not qualify Docker functionality or the DD-PROXY
topology.

P1 subordinate-ID helpers require a separately visible probe mode because `no-new-privileges`
prevents their setuid transition:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-p0.mjs \
  --profile-level p2 --idmap-mode setuid-helpers --probe daemon
```

This mode still drops every outer capability. Evidence shows that it is insufficient: the ID-map
helpers require `SETUID`/`SETGID` in the outer capability bounding set. The namespace probe
inventories all setuid and file-capability binaries; a purpose-built daemon image must contain no
unreviewed setuid executable.

The next explicitly named P1 candidate grants only those two mapping capabilities:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-p0.mjs \
  --profile-level p2 --idmap-mode cap-setid --probe daemon
```

This is not a generic capability escape hatch: every other outer capability remains dropped and the
profile ceiling forbids the listed hard-stop capabilities. The cumulative candidate successfully
boots the daemon only with `NoNewPrivs=false`, those two capabilities, and the one P2 artifact. This
is exploratory stock-image evidence, not approval of a release image or backend.

The next checked-in probe exercises DD-H2 with a trusted one-shot API-volume initializer, the same
rootless daemon profile, and two otherwise equivalent sibling clients:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-private-api.mjs \
  --run-id dd-h2-private-api-example \
  --evidence-dir /absolute/outside-workspace/dd-h2-private-api-example
```

The authorized sibling receives the named API volume read-only, must connect to the private UDS,
and must fail to create a file beside it. The unauthorized sibling receives no API mount and must
fail to find or connect to the socket. The probe also requires no TCP listener, inspects every
identity before deletion, removes the exact named and anonymous volumes, and records two empty
inventories. Passing DD-H2 still proves nothing about functional inner containers, paths, boundary
negatives, DD-PROXY, Apple, 0F, 0C, or product integration.

The functional mode continues the denial-led sequence through staged image load and the first inner
container:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-private-api.mjs \
  --probe functional \
  --run-id dd-h3-functional-example \
  --evidence-dir /absolute/outside-workspace/dd-h3-functional-example
```

The current cumulative result is a deliberate hard stop, not a request for another seccomp rule.
Image load succeeds, but Linux rejects the inner procfs mount because Docker's outer `/proc/*`
masks make every visible procfs incomplete. Rootless runc requires at least one fully visible
procfs; clearing only one mask cannot satisfy the kernel. Docker's broad
`systempaths=unconfined`/empty proc-mask override and a host procfs bind are both outside the frozen
ceiling. Do not use either as a diagnostic fallback. The verified `dd-h3-functional-0004` evidence
therefore classifies baseline Docker Desktop as not feasible under the current topology; continue
with the independent Apple track or restart profile review explicitly.

The Apple track is independent. Its prerequisite inventory creates one disposable Apple VM with
`--network none`, no DNS, no host mounts, a read-only root, no capabilities, and explicit VM
CPU/memory. It tests unprivileged user and mount namespaces before deleting the exact VM:

```sh
node scripts/spikes/secure-nested-docker/phase0b-ac-inventory.mjs \
  --run-id ac-h1-inventory-example \
  --evidence-dir /absolute/outside-workspace/ac-h1-inventory-example
```

The rootless probe expects the pinned Docker 29.2.1 rootless artifact to be present in Apple
`container`'s image store. Daemon mode proves only boot, identity, the VM-private UDS, `vfs`, and
egress negatives:

```sh
node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
  --run-id ac-rootless-daemon-example \
  --evidence-dir /absolute/outside-workspace/ac-rootless-daemon-example
```

Functional mode additionally stages one immutable Alpine archive through a read-only exact mount
and exercises load, run/exec, bind, volume, offline BuildKit build, internal target/scanner traffic,
negative registry/DNS/direct-IP access, and exact cleanup:

```sh
node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
  --probe functional \
  --run-id ac-rootless-functional-example \
  --evidence-dir /absolute/outside-workspace/ac-rootless-functional-example
node scripts/spikes/secure-nested-docker/verify-probe-evidence.mjs \
  --evidence-dir /absolute/outside-workspace/ac-rootless-functional-example
```

The verified `ac-rootless-functional-0003` run supports this primitive matrix without adding a
rootful bootstrap. Docker reports no rootless cgroup driver or functional inner resource limits,
and warns that IPv4 forwarding is disabled; same-bridge traffic works, but routed inner networks
remain unproven. This evidence does not qualify Apple or prove VM-boundary, resource, disk, fault,
product-entrypoint, 0F, or 0C gates.

Additional Apple modes reuse the same pinned functional baseline and add one bounded concern at a
time:

```sh
node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
  --probe boundary --run-id ac-boundary-example \
  --evidence-dir /absolute/outside-workspace/ac-boundary-example
node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
  --probe resource --run-id ac-resource-example \
  --evidence-dir /absolute/outside-workspace/ac-resource-example
node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
  --probe disk --run-id ac-disk-example \
  --evidence-dir /absolute/outside-workspace/ac-disk-example
```

`boundary` stages a pinned arm64 `alpine/socat` image, creates a separate network-isolated Apple VM,
tests an inner privileged/host-namespace workload, samples macOS host-vsock ports, and proves a
nested publication reaches neither macOS nor the peer VM. `resource` records Apple stats during
bounded CPU, 512 MiB memory, and 128-process pressure while checking the peer VM. `disk` measures
only the exact owned Apple bundle's sparse rootfs before/during/after a 256 MiB inner layer and after
exact VM deletion; override a nondefault service root with `--container-app-root`.

Fault modes are separate fresh runs because daemon death and VM deletion are terminal:

```sh
for mode in workload client-disconnect daemon vm-delete; do
  node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
    --probe fault --fault-mode "$mode" --run-id "ac-fault-$mode-example" \
    --evidence-dir "/absolute/outside-workspace/ac-fault-$mode-example"
done
```

Verified evidence currently exists for `ac-rootless-boundary-0002`,
`ac-rootless-resource-0001`, `ac-rootless-disk-0002`, and the four fault runs recorded in the design.
The 512 GiB logical sparse rootfs has no Apple CLI per-VM disk quota; allocated blocks persist after
inner deletion, so observed-disk preview still requires the Phase 0F pre-daemon host watchdog.

Path and relay probes exercise the remaining Apple sharing primitives independently:

```sh
node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
  --probe path --run-id ac-path-example \
  --evidence-dir /absolute/outside-workspace/ac-path-example
node scripts/spikes/secure-nested-docker/phase0b-ac-rootless.mjs \
  --probe relay --run-id ac-relay-example \
  --evidence-dir /absolute/outside-workspace/ac-relay-example
```

`path` mounts one exact temporary workspace and a separate Apple ext4 volume over
`/workspace/node_modules`, then proves recursive inner-bind path equivalence, Linux dependency
visibility, macOS dependency hiding, and exact cleanup. `relay` starts a metadata-only synthetic host
service beneath a private short-path directory, mounts its exact socket file read-only so Apple
converts it to a host-listens/guest-connects vsock relay, and makes a request from a network-disabled
nested child. It then stops the exact relay and requires the application response to fail. The
source socket is mode `0666` because rootless children use subordinate UIDs; its host parent is mode
`0700`. Do not replace the mount with `--publish-socket`, whose direction is guest-listens and
host-connects.

Verified evidence currently exists for `ac-rootless-path-0002` and
`ac-rootless-relay-0005`. These modes still do not prove exhaustive vsock listeners, the real
two-MITM/provider protocol, product watchdog, product entrypoint, the Phase 0F frozen contract, or
0C qualification.

## Phase 0F narrow build-egress cold-cache capture

`build-egress-capture.mjs` records the complete endpoint set that a cold-cache rebuild of the
current IronCurtain Dockerfiles fetches, so a reviewer can freeze
`config/docker-workload/build-egress-manifest.json`. It stands up a recording proxy that is the
build's ONLY egress route, drives `docker build --no-cache` with a fresh builder, and emits a DRAFT
`build-egress-manifest.draft.json` (top-level `draft: true`, deliberately NOT a loadable frozen
manifest) and a `capture-evidence.json` summary. A tool that bypasses the proxy fails to connect;
those failures land in the per-Dockerfile build logs and under `directConnectSuspected`, and any
endpoint fetched but not recorded is by construction a direct connection — so the recorded set is
the complete mediated set. Records are attributed to the Dockerfile under build (builds run
sequentially).

The recorder has two modes:

- **tunnel (default for `--build`)** — CONNECT requests are recorded as
  scheme/host/port/byte-counts/duration and then blind-piped to the real destination. No TLS
  interception, so the production Dockerfiles need no capture CA (they must not be modified) and
  HTTPS paths are invisible: the draft marks these endpoints `pathVisibility: 'connect-only'`,
  telling the reviewer that path shapes must be decided at freeze time. Plain HTTP through the
  proxy (apt via `http://deb.debian.org`) is still recorded with full method/host/path and redirect
  hops (`pathVisibility: 'full'`). DNS stays host-side: the proxy resolves and connects to the real
  host; the build container only ever names destinations. A CONNECT that fails to resolve/connect
  is recorded under `failedFetchAttempts` (evidence), not a crash.
- **terminate-tls (`--terminate-tls`; used by `--smoke`)** — the proxy MITMs TLS with an ephemeral
  capture CA and records full HTTPS paths. Only usable against images that trust the capture CA,
  so it is kept for future capture-CA-trusting images and the hermetic smoke path.

macOS Docker Desktop reachability: the proxy listens on `127.0.0.1` host-side, but RUN steps
execute inside build containers where `127.0.0.1` is the container itself, so the proxy URL passed
via build args uses `host.docker.internal` (Docker Desktop's alias for the host). Override with
`--proxy-host` — on native Linux Docker Engine there is no `host.docker.internal` by default; pass
the docker0 gateway, typically `--proxy-host 172.17.0.1`.

Validate the recorder → synthesizer → evidence plumbing without Docker (`--smoke` exercises the
terminate-TLS recorder; `--smoke-tunnel` exercises the blind CONNECT tunnel against a self-signed
local HTTPS upstream — the client pins the upstream's own cert, so a successful handshake proves
the proxy did not intercept — plus one plain-HTTP fetch and one recorded failed CONNECT):

```sh
node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --smoke \
  --evidence-dir /absolute/outside-workspace/build-egress-smoke
node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --smoke-tunnel \
  --evidence-dir /absolute/outside-workspace/build-egress-smoke-tunnel
```

The full cold-cache capture is a later operator-supervised validation step (a real build reaches the
public internet through the proxy):

```sh
node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --build \
  --evidence-dir /absolute/outside-workspace/build-egress-capture \
  --repo-root /absolute/path/to/ironcurtain \
  --dockerfile docker/Dockerfile.base --dockerfile docker/Dockerfile.goose --context .
```

The draft is an input to review, not a frozen artifact. A human must pin every fetched artifact,
choose each rule's BuildKit/frontend/base-image/RUN seam, decide path shapes for every
`connect-only` endpoint, and transform the draft into the strict frozen manifest that
`src/docker-workload/build-egress-policy.ts` loads. Capturing does not freeze, qualify a backend,
or make a network-dependent build reproducible. Note that `FROM` base-image and Dockerfile-frontend
pulls happen at the daemon layer and can bypass the proxy — those seams are inventoried separately,
not by this recorder.

## Phase 0C workload-registry live gate

`registry-live-gate.ts` drives the production registry-egress proxy seam
(`handleRegistryEgressRequest`, `src/docker/registry-egress-proxy.ts`) with a **frozen**
manifest and a real `createDirectOutboundTransport` against Docker Hub's anonymous pull
path. It plays the Docker daemon: it performs the anonymous `401 -> token -> retry` dance
itself and follows the registry's derived CDN redirect through the proxy. No credential
exists anywhere — the bearer token is obtained anonymously through the mediated path, per
§6.4. Exit 0 = every positive and negative gate passed.

```sh
npx tsx scripts/spikes/secure-nested-docker/registry-live-gate.ts
```

Positives (live): api-version probe, anonymous tag manifest pull (token dance), by-digest
image manifest pull, blob pull that follows the registry `307` to an unlisted CDN as a
derived redirect, content-addressed digest match on the delivered blob, and provenance that
retains the requested digest across the redirect (`docker-hub-registry:cdn`). Negatives
(live, fail-closed with zero unmediated egress): unlisted host, blob-upload (push), tags
and catalog enumeration, and a `Basic` Authorization scheme — all `403`.

This validates the §16.6 controls end-to-end against a real registry. It is not itself the
manifest freeze: freezing the checked-in `config/docker-workload/registry-egress-manifest.json`
(flipping `status` to `frozen`) remains a deliberate 0C step after the origin/ceiling review
and the operator decision on the anonymous bearer flow.
