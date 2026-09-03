# BuildKit OCI envelope capture for CA injection

**Date:** 2026-08-22
**Status:** redacted compatibility evidence; not lifecycle qualification
**Scope:** Apple Container, Docker 29.2.1 embedded BuildKit, pinned runc 1.3.4

## Result

A deterministic `docker build --pull=false --network=none --no-cache` reached the PATH-interposed
wrapper, the wrapper captured the executor bundle immediately before invoking the absolute real runc,
the build succeeded, and an exact canary from the built image succeeded. Exact lease and Apple VM cleanup
were separately verified after the capture.

The machine-readable companion
[`ca-injection-buildkit-oci-envelope.fixture.json`](../../../docker/build-trust-runtime/testdata/ca-injection-buildkit-oci-envelope.fixture.json)
is the sanitized envelope consumed by the maintained build-trust runtime tests. Its SHA-256 is
`af0bcffb2c05a9648a31c383d6110d9db5d7c35550c216a38ada7663f6669a21`.

The capture observed OCI version `1.3.0`, the exact embedded-BuildKit runc argv already preserved in
[`ca-injection-runc-path-spike.argv.json`](../../../docker/build-trust-runtime/testdata/ca-injection-runc-path-spike.argv.json), an absolute
direct-child bundle rootfs, the six listed namespaces with no namespace paths, and the four listed `/dev`
mounts. Ownership and mode observations are included because the Apple-mounted pinned runc is owned by
UID/GID 65534, while the bundle, config, and rootfs appear as UID/GID 0 in the RootlessKit child namespace.

## Sanitizer reconciliation

The initial driver result was `passed: false` only because its sanitizer treated the exact retained OCI
`process.cwd` value `/workspace` as if it were a disposable host workspace path. The build, built-image
canary, wrapper-to-real-runc handoff, and cleanup had already succeeded. The finalizer corrected that one
predicate and retained `/workspace` as a fixed OCI field. This record preserves that false-failure
history rather than rewriting it as an initial pass.

## Limits

This is a structural summary, not an executable OCI spec. It deliberately omits seccomp body contents,
environment values, the literal RUN command, and non-`/dev` mount details. Wrapper tests map every
security-relevant summarized field they enforce to this checked fixture and exercise it with a separate
executable synthetic OCI fixture. They do not claim omitted details are byte-frozen; those fields are
bounded and preserved unless the explicit trust injection changes them.

The companion [host-network capture](./ca-injection-buildkit-oci-envelope-host.md) qualifies the second
accepted namespace shape. Neither capture seals the agent-owned executor bundle after validation or
turns OCI mutation into an egress control. Unknown structural envelopes fail closed. The package proxy
and outer VM network policy remain the security authority.

The transient source evidence was retained at `/private/tmp/ic-oci-envelope.uuDNaw` when this record was
created. It is not a runtime or test dependency. No certificate, private key, token, workspace content,
unredacted executor ID, or lease identifier is checked in here.
