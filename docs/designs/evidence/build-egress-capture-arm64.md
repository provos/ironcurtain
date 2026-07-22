# Build-egress cold-cache capture evidence — arm64

**Purpose.** This is the captured endpoint evidence that gates freezing
`config/docker-workload/build-egress-manifest.json` (see the secure-nested-runtime
implementation plan, build-egress sections). It is a durable record of what the
current IronCurtain Dockerfiles actually fetch during a cold-cache
(`--no-cache`) rebuild of every trusted infrastructure image. It is **evidence,
not a frozen manifest** — freezing requires the two human decisions listed at
the bottom.

**Capture run.**

- Harness: `scripts/spikes/secure-nested-docker/build-egress-capture.mjs --build` (tunnel mode).
- Backend: Docker Desktop 29.2.1, arm64, macOS. Proxy reached from build containers via `host.docker.internal`.
- Method: each Dockerfile built cold-cache with the recording proxy as its **sole** egress route (`HTTP(S)_PROXY` → proxy; a tool that bypasses it fails to connect and is recorded as a failed attempt). All 8 builds exited `0`; `0` failed fetch attempts; `0` direct-connect-suspected.
- Path visibility: HTTPS is **tunnel-recorded** (host:port only — the proxy blind-pipes bytes and does not terminate TLS, because production Dockerfiles do not trust a capture CA). Plain HTTP (apt) is fully path-visible.

## Dockerfiles covered

`Dockerfile.base.arm64`, `Dockerfile.claude-code`, `Dockerfile.codex`,
`Dockerfile.goose`, `nested-daemon/Dockerfile`, `nested-relay/Dockerfile`,
`docker-workload/helper/Dockerfile`, `docker-workload/socat/Dockerfile`.

The last four fetch **nothing** at RUN time (Go builds with vendored/CGO-off
deps, minimal images) — no mediated egress observed. All observed egress comes
from the base image and the three agent images.

## Observed endpoints (13 unique)

| Endpoint                                             | Path visibility | Methods | Observed in              | Distinct paths |
| ---------------------------------------------------- | --------------- | ------- | ------------------------ | -------------- |
| `https://astral.sh:443`                              | connect-only    | CONNECT | base                     | 0              |
| `https://cdn.playwright.dev:443`                     | connect-only    | CONNECT | base                     | 0              |
| `https://github.com:443`                             | connect-only    | CONNECT | goose                    | 0              |
| `https://index.crates.io:443`                        | connect-only    | CONNECT | base                     | 0              |
| `https://nodejs.org:443`                             | connect-only    | CONNECT | base                     | 0              |
| `https://playwright.download.prss.microsoft.com:443` | connect-only    | CONNECT | base                     | 0              |
| `https://registry.npmjs.org:443`                     | connect-only    | CONNECT | base, claude-code, codex | 0              |
| `https://release-assets.githubusercontent.com:443`   | connect-only    | CONNECT | goose                    | 0              |
| `https://releases.astral.sh:443`                     | connect-only    | CONNECT | base                     | 0              |
| `https://sh.rustup.rs:443`                           | connect-only    | CONNECT | base                     | 0              |
| `https://static.crates.io:443`                       | connect-only    | CONNECT | base                     | 0              |
| `https://static.rust-lang.org:443`                   | connect-only    | CONNECT | base                     | 0              |
| `http://deb.debian.org:80`                           | full            | GET     | base, goose              | 107            |

Each endpoint maps to a known toolchain step in the Dockerfiles:

- `deb.debian.org` — apt (Debian base + security). Path prefixes: `/debian/` (104 paths), `/debian-security/` (3 paths).
- `astral.sh` + `releases.astral.sh` — the `uv`/`ruff` installer (`curl -LsSf https://astral.sh/...`).
- `sh.rustup.rs` + `static.rust-lang.org` — rustup + the Rust toolchain.
- `index.crates.io` + `static.crates.io` — cargo registry + crate downloads.
- `registry.npmjs.org` — `npm install -g` (node-gyp) and each agent CLI.
- `nodejs.org` — node-gyp headers.
- `cdn.playwright.dev` + `playwright.download.prss.microsoft.com` — `playwright install` (chromium).
- `github.com` + `release-assets.githubusercontent.com` — goose release asset download.

## Not covered by this capture (must be inventoried separately at freeze time)

- **Daemon-layer image pulls.** `FROM` base-image resolution and the BuildKit
  Dockerfile frontend are fetched by the Docker daemon, not by a RUN step, so
  they bypass the RUN-step proxy entirely and do **not** appear above. These are
  the `base-image` seam: they must be inventoried from the `FROM` lines and
  their digests pinned. Base images observed in the Dockerfiles: `node:22-trixie`
  (base), plus the golang builder image(s) in the Go Dockerfiles.

## Freeze decisions still required (not mechanical)

1. **HTTPS path gating vs host-only.** The frozen manifest schema requires
   `paths: min(1)` per rule. Tunnel capture yields no HTTPS path shapes. Two
   options: (a) production build-egress **terminates TLS** at the outer MITM
   (build containers trust the session CA staged by `runtime-trust.ts`), in
   which case a terminate-TLS re-capture would yield real per-host path prefixes
   to gate on; or (b) freeze HTTPS rules as **host+port gating** with an
   allow-all path rule, treating the reviewed-host allowlist as the control.
   This is a security-posture decision, not a capture artifact.
2. **`base-image` seam.** Decide how daemon-layer `FROM` pulls are mediated and
   pin their digests (see "Not covered" above).

Until both are decided, this path is not a build-egress freeze exit artifact.
The raw per-group drafts (`build-egress-manifest.draft.json`, `capture-evidence.json`,
`build-logs.json`) are produced under the operator's evidence dir by re-running
the harness; they are intentionally not committed (large, host-specific).
