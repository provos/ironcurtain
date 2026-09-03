# Build trust runtime

This package is the hardened `runc` interposer for admitted nested-Docker sessions with
`networkAccess: packages`. The lifecycle verifies the checked package manifest, stages the wrapper and
its immutable per-bundle contract before dockerd starts, selects it only for the private daemon, and
runs a no-network BuildKit canary before releasing the agent. Other network modes stage no wrapper or
trust source.

The wrapper recognizes the frozen embedded-BuildKit `runc run` argv, reads the immutable
contract at `/opt/ironcurtain-build-trust/build-trust-contract.json`, verifies the exact mode, size, effective
read-only backing, and digest of the real-runc and public-source bytes named by that contract, and injects read-only trust mounts
beneath the OCI `/dev` tmpfs. Before every `create` or `run` handoff, it idempotently adds
`--no-new-keyring`; this keeps the compatibility behavior shared by Apple and Docker Desktop instead of
requiring a backend-specific package-mode wrapper. All supported runc operations are handed to the
absolute pinned real-runc path without shell evaluation.

The selected image owns that pinned real-runc inode as root:root. The same inode is observed as the
overflow pair 65534:65534 inside the RootlessKit child where BuildKit invokes the wrapper. The contract
names exactly the ordered owner pairs `[{0,0},{65534,65534}]`; no runtime-user, mixed, reordered, or
additional pair is accepted. Digest, size, mode, regular-file type, and one-link checks are identical in
both views.

In the wrapper's qualified namespace views, every executor-tree ancestor must have the complete owner
pair `0:0` or `65534:65534`; runtime-user and mixed pairs fail. This policy is independent of the trust
tree. The direct OCI bundle, config, and rootfs remain exact child-root objects with their qualified
modes. Those namespace identities still map to the untrusted outer agent user, so descriptor-relative
checks and atomic replacement detect changes made before the commit check but do not seal the bundle
against a same-UID writer after validation. This wrapper is a compatibility and usability mechanism, not
an egress boundary. The package proxy and outer VM network policy remain the security authority.

The pinned stack's no-network and host-network structural summaries are preserved in
[`testdata/ca-injection-buildkit-oci-envelope.fixture.json`](testdata/ca-injection-buildkit-oci-envelope.fixture.json)
and
[`testdata/ca-injection-buildkit-oci-envelope-host.fixture.json`](testdata/ca-injection-buildkit-oci-envelope-host.fixture.json).
The only qualified namespace difference is that host mode omits `network`; every remaining namespace is
ordered and pathless. Tests map each security-relevant summary field enforced by the parser to both
checked fixtures and exercise both shapes with an executable synthetic OCI fixture.

The summaries intentionally omit seccomp body contents, literal environment values/RUN commands, and
non-`/dev` mount details. The wrapper bounds and preserves those fields; it does not claim they are
byte-frozen. Any unsupported asserted structure fails closed. The lifecycle stages dedicated copies of
the contract, CA certificate, CA bundle, and apt configuration beneath the bundle's
`package-build-runtime` directory, then mounts those four exact files read-only at
`/opt/ironcurtain-build-trust`. The selected image alone precreates that parent as root:root mode `0755`;
no runtime mkdir creates or repairs it. Parent traversal accepts only the complete owner pairs `0:0` or
`65534:65534`, while the outer preflight requires the direct parent to be exactly root:root mode `0755`.

Production evidence has shown namespace-translated leaf owners, so UID/GID for the contract and public
trust leaves is bounded diagnostic metadata rather than admission authority. This is separate from the
real-runc owner pairs above. Mode `0444`, regular-file type, one link, bounded exact size and digest,
`ST_RDONLY`, and an `O_WRONLY` failure of `EROFS` remain mandatory for every trust leaf. The contract
records only the exact ordered source/destination paths, size, digest, and mode; it records no
public-source UID/GID.

After resolving and hashing the wrapper as `codespace`, the outer preflight invokes its exact absolute
path as UID/GID `0:0` for the bounded `--version` check. That gives the write-open probe `CAP_DAC_OVERRIDE`, so a
writable mode-`0444` file cannot masquerade as read-only by returning `EACCES`; only `EROFS` qualifies.
BuildKit invokes the same wrapper in the RootlessKit child, where every load repeats the proof. `Fstatfs`
is bound to the already-open no-follow descriptor; the path write-open is only a second check that a
mode-based `EACCES` cannot substitute for `EROFS`.

On a wrapper failure, the main error branch best-effort creates the fixed
`/tmp/.ironcurtain-build-trust-runc-failure-v1` leaf with no-follow/exclusive `0600` semantics beneath an
exact root-or-overflow-owned sticky `/tmp`. Its contents are one reviewed ASCII failure code, never error
text, argv, environment, or contract bytes. Exact sole-argument internal commands securely clear or read
that leaf before normal runc grammar. The lifecycle clears it before and after the canary, reads it only
after a failed build, and treats every diagnostic operation as non-authoritative: it cannot change
admission, cleanup, ledger equality, or primary error causality. The allowlist distinguishes executor and
bundle open/metadata failures; open, metadata, read-only, and digest failures for each CA certificate, CA
bundle, and APT source; and config open, metadata, read, strict-envelope, patch, and atomic-commit failures.
Outer layers preserve an existing typed stage; an untyped failure maps only to the fixed internal-error code.
