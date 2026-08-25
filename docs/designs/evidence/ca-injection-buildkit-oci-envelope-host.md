# BuildKit host-network OCI envelope capture for CA injection

**Date:** 2026-08-22
**Status:** redacted compatibility evidence; not lifecycle qualification
**Scope:** Apple Container, Docker 29.2.1 embedded BuildKit, pinned runc 1.3.4

## Result

A deterministic `docker build --pull=false --network=host --no-cache` reached the PATH-interposed
wrapper, captured the executor bundle immediately before the absolute real-runc handoff, completed the
build, and passed an exact built-image canary. Exact lease and Apple VM cleanup were verified.

The sanitized machine-readable fixture is
[`ca-injection-buildkit-oci-envelope-host.fixture.json`](./ca-injection-buildkit-oci-envelope-host.fixture.json),
SHA-256 `128b830f4ab83823f0e3c6229e8af913b5d989c7480040d726ac8d750bfa6a58`.
The checked comparison against the no-network capture is
[`ca-injection-buildkit-oci-envelope-comparison.json`](./ca-injection-buildkit-oci-envelope-comparison.json),
SHA-256 `36e5779065479b0aaecbbc7f859f8a9f5ae16a66665a4b8bcac318f4fbcbebf1`.

## Exact structural delta

The only observed structural delta was the absence of the pathless OCI `network` namespace in host mode.
The `pid`, `ipc`, `uts`, `mount`, and `cgroup` namespaces remained pathless and ordered identically. OCI
version, runc argv, top-level/process/root key shapes, capability sets, masked/read-only paths, exact
`/dev`, `/dev/pts`, `/dev/shm`, and `/dev/mqueue` mounts, and ownership/modes were unchanged apart from
per-run inode values and command-dependent `config.json` size.

## Limits

These fixtures are structural summaries, not executable OCI specs. They deliberately omit seccomp body
contents, environment values, the literal RUN command, and non-`/dev` mount details. Wrapper tests map
every security-relevant summarized field they enforce to both checked fixtures and exercise both accepted
namespace shapes with a separate executable synthetic OCI fixture. They do not claim the omitted details
are byte-frozen; those fields are bounded and preserved unless the wrapper's explicit trust injection
changes them.

The comparison establishes compatibility for the two exact commands recorded by the fixtures. It does
not seal the agent-owned executor bundle after validation or make OCI mutation an egress control. The
package proxy and outer VM network policy remain authoritative.

The transient source evidence was retained at `/private/tmp/ic-oci-envelope-host.f3HAmj` when this record
was created and is not a runtime/test dependency. No certificate, private key, token, workspace content,
unredacted executor ID, or lease identifier is checked in here.
