# CA Injection Through the BuildKit runc PATH Seam

**Date:** 2026-08-22
**Status:** redacted feasibility evidence; not production qualification
**Scope:** Apple Container, Docker 29.2.1 embedded BuildKit, pinned runc 1.3.4

## Purpose

This record preserves the exact compatibility observation used by
[`secure-nested-runtime-public-network.md`](../secure-nested-runtime-public-network.md) without checking
in a CA private key, certificate, workspace contents, lease state, or raw temporary logs. The spike tested
whether embedded BuildKit discovers executor `runc` through the daemon's trusted `PATH` and whether a
throwaway wrapper can patch the executor OCI spec before invoking the real binary.

It is feasibility evidence only. The spike wrapper was Python, followed paths, overwrote collisions, and
patched a broader invocation set than the production design permits.

## Frozen version and argv observation

The exact real-runc version output was:

```text
runc version 1.3.4
commit: v1.3.4-0-gd6d73eb
spec: 1.2.1
go: go1.25.6
libseccomp: 2.5.4
```

The retained BuildKit envelope observes the pinned real-runc inode as UID/GID `65534:65534` inside the
RootlessKit child. A later disposable selected-image probe on Apple Container 1.2.2 measured the outer
view of the same shipped path as a root-owned, single-link regular file (`0:0`, mode `0755`, size
`16641104`) with SHA-256
`f0ed2d355945fe2697f11f89773e07b48de0ef239962c4a0e0ae900161a23b12`. These are namespace views, not
conflicting byte identities; production accepts exactly those two owner pairs and keeps every other
metadata check identical.

The wrapper observed two BuildKit executor invocations. Only the executor identifiers are redacted; argv
order and spelling are preserved. The companion machine-readable
[`ca-injection-runc-path-spike.argv.json`](./ca-injection-runc-path-spike.argv.json) freezes the same
single-ID pattern for qualification tests:

```json
["--log","/home/codespace/.local/share/docker/buildkit/executor/runc-log.json","--log-format","json","run","--bundle","/home/codespace/.local/share/docker/buildkit/executor/<executor-id-1>","--keep","<executor-id-1>"]
["--log","/home/codespace/.local/share/docker/buildkit/executor/runc-log.json","--log-format","json","run","--bundle","/home/codespace/.local/share/docker/buildkit/executor/<executor-id-2>","--keep","<executor-id-2>"]
```

With the disposable wrapper installed, an unchanged npm metadata request and a Debian apt update/install
build succeeded through the experimental package MITM. Its audit recorded the npm package `is-number` and
the Debian package `hello`. Removing the wrapper before a merged-filesystem probe found no automatically
injected environment or session CA at the paths checked by the spike.

## Result and reconciliation are separate evidence

The raw functional result recorded `passed: false`. Its cleanup check inherited an older
`IC_CA_SPIKE_HOME`, inspected unrelated historical leases, and observed an incident lease. It must never
be cited as a clean one-file pass.

A later production-API reconciliation separately established that the exact spike lease was closed, its
exact outer object was absent, both inventories were empty, and its state root was absent. That later
reconciliation corrects the scoped cleanup fact; it does not rewrite the raw functional result or turn
the spike into production qualification.

The source artifacts were captured under `/private/tmp/ic-ca-spike-g2XgFj`, with earlier explicit no-CA
and BuildKit-secret controls under `/private/tmp/ic-ca-spike-z2J9Kb`. Those paths are transient source
locations and are not required inputs to this checked-in record.

## What this does not prove

This record does not prove a hardened wrapper, hostile OCI-spec handling, atomic filesystem behavior,
Buildx, pip, Cargo, arbitrary base images, non-root or read-only-rootfs builds, multi-stage behavior,
failure cleanup, output-layer residue absence, strict package policy, or a stable upstream Docker
interface. The production design requires independent deterministic and live gates for each applicable
claim.

No private key, certificate, token, credential, package response, workspace file, unredacted executor ID,
or raw lease identifier is included in this evidence file.
