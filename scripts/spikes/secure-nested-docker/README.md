# Secure nested Docker retained probes

This directory contains only the platform probes and capture tools that still have a future use.
It is not a second test suite and no result here qualifies a backend. Product behavior belongs in
`src/docker-workload`, product tests, and `npm run qualify:apple`.

## Retention ledger

| Area                                                                         | Status        | Why                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0A fake-runtime ledger, recovery, redaction, and tamper harness        | Retired       | The real lease, lock, reconciliation, lifecycle-evidence, and watchdog paths now have production tests. The design also rejects commit/hash-bound qualification bookkeeping (§16.12).                      |
| Apple 0B inventory, rootless, path, relay, resource, disk, and fault runners | Retired       | They were one-off executors for a completed primitive study, used superseded CA-baked images, and cannot qualify the current product topology. The durable results and evidence IDs remain in design §9.4. |
| Docker Desktop P0/P2 and private-API/functional probes                       | Retained      | Baseline Desktop is unsupported at a documented stop gate. These are the exact replay tools required if a future decision explicitly reopens the profile ceiling.                                          |
| Docker Desktop runtime shim                                                  | Retained      | The functional Desktop probe uses it to select runc's `--no-new-keyring` mode without admitting `keyctl`.                                                                                                  |
| Profile-ceiling and probe-evidence verifiers                                 | Retained      | They validate the retained Desktop replay inputs and outputs.                                                                                                                                              |
| Build-egress capture                                                         | Retained      | The frozen manifest is tied to the Dockerfiles' fetch behavior. A cold-cache recapture is still needed when those inputs change.                                                                           |
| Public-registry live gate                                                    | Retained      | It is the only real-registry exercise of the anonymous token and CDN-redirect flow. Keep it until a product-entrypoint 0C integration test replaces it.                                                    |
| Native Linux                                                                 | No runner yet | Docker Desktop evidence is not Linux evidence. A native-Linux runner must be added when a supported distro/kernel host becomes available.                                                                  |

Deleted executors are intentionally not kept as historical code. The design is the record of their
findings; source control is the record of their implementation.

## Docker Desktop: retained stop-gate replay

Do not run these probes to make an unsupported backend appear supported. The existing result is:

- P0 denies unprivileged user-namespace creation.
- P2 plus only outer `SETUID`/`SETGID` and `NoNewPrivs=false` boots the rootless daemon.
- A named-volume UDS gives the authorized sibling private daemon access while excluding a sibling
  without the volume.
- The functional probe loads the staged image, then runc fails to mount procfs because the outer
  Docker container's masked/read-only proc paths make the nested procfs too revealing.
- Docker's `systempaths=unconfined` override is outside the frozen ceiling, so baseline Docker
  Desktop stopped before DD-PROXY.

The detailed evidence IDs and adjudication are in design §9.3. Reopening this track requires an
explicit review of the ceiling followed by a fresh P0-P4 sequence, not another ad hoc delta.

First verify the checked-in ceiling against its canonical Moby baseline:

```sh
node scripts/spikes/secure-nested-docker/verify-profile-ceiling.mjs
```

Then run each candidate with an explicit run ID and evidence directory outside the workspace:

```sh
node scripts/spikes/secure-nested-docker/phase0b-dd-p0.mjs \
  --profile-level p2 --idmap-mode cap-setid --probe daemon \
  --run-id dd-daemon-review-0001 \
  --evidence-dir /absolute/outside-workspace/dd-daemon-review-0001

node scripts/spikes/secure-nested-docker/phase0b-dd-private-api.mjs \
  --run-id dd-private-api-review-0001 \
  --evidence-dir /absolute/outside-workspace/dd-private-api-review-0001

node scripts/spikes/secure-nested-docker/phase0b-dd-private-api.mjs \
  --probe functional \
  --run-id dd-functional-review-0001 \
  --evidence-dir /absolute/outside-workspace/dd-functional-review-0001

node scripts/spikes/secure-nested-docker/verify-probe-evidence.mjs \
  --evidence-dir /absolute/outside-workspace/dd-functional-review-0001
```

Each probe owns only objects labeled with its run identity, inspects exact IDs before deletion,
removes its volumes, and records two empty inventories. Passing it still proves nothing about
DD-PROXY, native Linux, the product entrypoint, or backend qualification.

## Native Linux: future work

There is deliberately no native-Linux executor in this directory. When a supported Linux host is
available, build a new runner around the §9.7 LX-A/LX-B matrices and record the exact distro,
kernel, Engine, cgroup delegation, LSM, seccomp, storage driver, and resource behavior. The retained
Desktop scripts may inform its structure, but their VM kernel, proc masks, and Docker Desktop
network behavior must not be copied as Linux assumptions.

## Apple: durable results and current gate

The retired Apple executors established the primitive findings recorded in design §9.4:

| Evidence                                                 | Durable finding                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ac-h1-inventory-0001`                                   | The guest supports unprivileged user/mount namespaces under `--network none`; direct DNS/IP egress is absent.                                   |
| `ac-rootless-daemon-0001`, `ac-rootless-functional-0003` | Docker 29.2.1 rootless boots with `vfs` and supports offline load/run/exec/build, exact binds, volumes, and same-bridge target/scanner traffic. |
| `ac-rootless-boundary-0002`                              | Inner privileged/host-namespace use remains inside the disposable VM; nested port publication reaches neither macOS nor another isolated VM.    |
| `ac-rootless-resource-0001`, `ac-rootless-disk-0002`     | VM CPU/memory are aggregate enforcement; guest PID limits are advisory; sparse-disk growth requires the host watchdog and exact VM deletion.    |
| Four fault runs                                          | Workload, client, daemon, and exact-VM failure cleanup preserve the unrelated VM and end with two empty inventories.                            |
| `ac-rootless-path-0002`, `ac-rootless-relay-0005`        | Exact workspace/dependency mounts and host-listens/guest-connects per-file socket relay work with exact cleanup.                                |

Those runs do not prove the current product entrypoint, two-MITM provider path, exhaustive vsock
negatives, or watchdog integration. The current checkout's Apple release command covers only the
manager/runtime suites implemented so far:

```sh
npm run qualify:apple
```

This command is not secure-nested-runtime Phase 0C qualification and does not open the admission
fuse. Add the missing platform and product-entrypoint gates to the release suite instead of
restoring an exploratory Apple runner; admission remains closed until those gates pass.

## Build-egress capture

`build-egress-capture.mjs` records the destinations and paths fetched by cold-cache builds of the
current Dockerfiles. It is a policy-review input, not a backend probe. Recapture when a Dockerfile,
base/frontend, package source, or build tool changes, or before qualifying the production
build-egress path.

Validate its recorder and synthesizer without public network access:

```sh
node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --smoke \
  --evidence-dir /absolute/outside-workspace/build-egress-smoke
node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --smoke-tunnel \
  --evidence-dir /absolute/outside-workspace/build-egress-smoke-tunnel
```

For a reviewed cold-cache run, group Dockerfiles by their real build context. Tunnel mode records
HTTPS hosts/ports and full plain-HTTP paths:

```sh
node scripts/spikes/secure-nested-docker/build-egress-capture.mjs --build \
  --evidence-dir /absolute/outside-workspace/build-egress-capture \
  --repo-root /absolute/path/to/ironcurtain \
  --context docker \
  --dockerfile docker/Dockerfile.base.arm64 \
  --dockerfile docker/Dockerfile.claude-code
```

Use `--ca-inject` to generate audit overlays and capture HTTPS path prefixes without modifying the
production Dockerfiles. Pre-pull their base images and Dockerfile frontends because those daemon
fetches are outside RUN-step proxy capture. On Docker Desktop the default proxy host is
`host.docker.internal`; on native Linux pass the actual bridge gateway with `--proxy-host`.

The generated draft must still receive human review: pin fetched artifacts, classify every
BuildKit/base/RUN seam, decide every connect-only path shape, and update
`config/docker-workload/build-egress-manifest.json`. Capture does not freeze policy or make a
network build reproducible.

## Public-registry live gate

`registry-live-gate.ts` drives the production registry-egress seam against anonymous Docker Hub and
GHCR pulls. It covers the `401 -> anonymous token -> retry` flow, by-digest manifests, CDN-derived
blob redirects, delivered-blob digest verification, provenance, and fail-closed negatives for an
unlisted host, upload, enumeration, and Basic credentials.

```sh
npx tsx scripts/spikes/secure-nested-docker/registry-live-gate.ts
```

The last recorded run passed all 16 checks for both configured origins. Because it uses live public
services, rerun it only when reviewing registry policy/protocol changes or replacing it with the
product-entrypoint 0C test. It does not itself qualify a backend.
