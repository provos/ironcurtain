# Secure nested Docker retained probes

This directory contains only the platform probes and capture tools that still have a future use.
It is not a second test suite and no result here qualifies a backend. Product behavior belongs in
`src/docker-workload`, product tests, and `npm run qualify:apple`.

The macOS developer slices are currently admitted with this minimal operator configuration:

```json
{ "dockerWorkload": { "enabled": true } }
```

That enabled state defaults to mediated Docker Hub/GHCR pulls. Deterministic offline and PTY-only
qualification gates set `imageIngress: "preloaded-only"` explicitly. Docker Desktop uses the
version-scoped reviewed rootless sidecar profile recorded below; Apple Container uses its separate VM
profile. Nothing in this retained-probe directory changes either product default or the preview
qualification state.

## Retention ledger

| Area                                                                         | Status        | Why                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0A fake-runtime ledger, recovery, redaction, and tamper harness        | Retired       | The real lease, lock, reconciliation, lifecycle-evidence, and watchdog paths now have production tests. The design also rejects commit/hash-bound qualification bookkeeping (§16.12).                      |
| Apple 0B inventory, rootless, path, relay, resource, disk, and fault runners | Retired       | They were one-off executors for a completed primitive study, used superseded CA-baked images, and cannot qualify the current product topology. The durable results and evidence IDs remain in design §9.4. |
| Docker Desktop P0/P2 and private-API/functional probes                       | Retained      | These bind the reviewed sidecar-only profile exception and replay the functional result; they do not qualify Docker Desktop or authorize the exception for agent containers.                               |
| Docker Desktop runtime shim                                                  | Retained      | The functional Desktop probe uses it to select runc's `--no-new-keyring` mode without admitting `keyctl`.                                                                                                  |
| Profile-ceiling and probe-evidence verifiers                                 | Retained      | They validate the retained Desktop replay inputs and outputs.                                                                                                                                              |
| Current-Dockerfile build-egress capture                                      | Retired       | Source/hash pinning and the generic-public experiment are not product authority. Git history retains the deleted capture tooling; the governing package-only design owns future work.                      |
| Public-registry live gate                                                    | Retained      | It is the only real-registry exercise of the anonymous token and CDN-redirect flow. Keep it until a product-entrypoint 0C integration test replaces it.                                                    |
| Native Linux                                                                 | No runner yet | Docker Desktop evidence is not Linux evidence. A native-Linux runner must be added when a supported distro/kernel host becomes available.                                                                  |

Deleted executors are intentionally not kept as historical code. The design is the record of their
findings; source control is the record of their implementation.

## Docker Desktop: reviewed sidecar-profile replay

The retained sequence records both the original stop gate and the explicitly reviewed sidecar-only
exception:

- P0 denies unprivileged user-namespace creation.
- P2 plus only outer `SETUID`/`SETGID` and `NoNewPrivs=false` boots the rootless daemon.
- A named-volume UDS gives the authorized sibling private daemon access while excluding a sibling
  without the volume.
- With Docker's default system paths, the functional probe loads the staged image, then runc fails to
  mount procfs because the outer container's masked/read-only proc paths make nested procfs too
  revealing.
- Review admitted `systempaths=unconfined` only for the dedicated rootless daemon sidecar. The first
  rerun then denial-proved `sethostname`; the updated P2 artifact admits it only for inner UTS setup.
- `codex-dd-functional-systempaths-0008` passes the functional matrix and exact cleanup under that
  version-scoped profile. Agent containers retain Docker's default masked/read-only system paths.

The detailed evidence IDs and adjudication are in design §9.3. This is functional sidecar evidence,
not 0C qualification or authority to broaden another container's profile.

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
  --systempaths-unconfined true \
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
fuse for additional backends or preview. The Apple developer slice is admitted, but full G1-G10/0C
evidence remains incomplete. Add missing gates to the release suite instead of restoring an
exploratory Apple runner.

## Package-network CA/runc feasibility evidence

The future Apple package-network slice is governed by
[`docs/designs/secure-nested-runtime-public-network.md`](../../../docs/designs/secure-nested-runtime-public-network.md).
It has only `offline | images | packages`; `packages` terminates TLS and authorizes fixed apt, npm, PyPI,
and Cargo GET/HEAD grammars. There is no product generic-public or opaque-CONNECT mode.

The checked-in redacted
[`CA-injection runc-PATH spike record`](../../../docs/designs/evidence/ca-injection-runc-path-spike.md)
preserves the pinned runc version and redacted exact BuildKit argv. Its raw functional result says
`passed: false`; a later production-API reconciliation separately proves scoped cleanup. Do not describe
the pair as one clean run or as qualification, and do not make transient `/private/tmp` artifacts release
inputs. Wrapper tests use the adjacent machine-readable argv fixture and reject any argument reorder,
duplicate, omission, addition, changed log path, nested bundle, or unequal executor ID.

Implementation must remove the superseded generic route first and keep new package proxy, CA, wrapper,
shim, and lifecycle modules unreachable until the final atomic gate. A compatibility value must never map
to the old listener during transition. The immutable selected image is loaded before the exact
`--pull=false --network=none --no-cache` startup canary, and both egress ledgers must remain unchanged.
Concurrent CA create/load is lock-serialized and no-follow; direct plugin/custom Docker clients are
unsupported rather than shim-rejected. Package authority still permits bounded exfiltration through
admitted paths, canonicalized request metadata, and timing.

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
