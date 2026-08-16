# Build-egress cold-cache capture evidence — arm64

**Purpose.** This is the captured endpoint evidence behind the frozen
`config/docker-workload/build-egress-manifest.json` (see the secure-nested-runtime
implementation plan, build-egress sections). It is a durable record of what the
current in-scope IronCurtain Dockerfiles fetch during a cold-cache
(`--no-cache`) rebuild. The `run`-seam manifest is frozen from this evidence;
see "Freeze decisions" below. Bundle images remain untrusted, so this record
authorizes a future rebuild path rather than attesting the resulting code.

**Capture runs (two passes).**

- Backend: Docker Desktop 29.2.1, arm64, macOS. Proxy reached from build containers via `host.docker.internal`. Each then-present Dockerfile built cold-cache with the recording proxy as its **sole** egress route; all 8 historical builds exit `0`, `0` failed fetch attempts, `0` direct-connect-suspected in both passes.
- **Pass 1 — tunnel** (`--build`): discovered the endpoint set. HTTPS is tunnel-recorded (host:port only — the proxy blind-pipes bytes without terminating TLS); plain HTTP (apt) is fully path-visible. This is the "Observed endpoints" table below.
- **Pass 2 — terminate-TLS** (`--build --ca-inject`): the capture CA is trusted inside each build the way production wires trust, so the proxy terminates TLS and sees full HTTPS paths. All 13 hosts reached full path visibility with zero CA resistance. This resolved the path-gating decision and produced the frozen manifest.

## Dockerfiles covered

The current manifest's source set is `Dockerfile.base.arm64`,
`Dockerfile.claude-code`, `Dockerfile.codex`, and `Dockerfile.goose`; all
observed egress came from those files. The historical capture also built
`nested-relay/Dockerfile` plus the now-deleted nested-daemon, helper, and
catalog-socat Dockerfiles. Those four observed no RUN-time fetches. The retained
future DD relay remains a separately pinned authority-bearing service, but its
build and daemon-layer inputs require fresh qualification before that backend
is promoted.

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
  reviewed separately. The current bundle source set uses `node:22-trixie`;
  future relay/backend builds must inventory their own builder and frontend
  images when qualified.

## Freeze decisions

1. **HTTPS path gating — RESOLVED (path-gated).** The operator chose the
   terminate-TLS path. A follow-up capture (`build-egress-capture.mjs --build
--ca-inject`) injects the capture CA into each build the way production wires
   trust (`update-ca-certificates` + the full `buildRuntimeTrustEnv()` set +
   `CARGO_HTTP_CAINFO` + apt `CaInfo`, via a transient BuildKit-heredoc overlay
   that never edits the production Dockerfiles). All 13 hosts reached full path
   visibility with zero CA resistance and zero unmediated fetches. The result is
   frozen in `config/docker-workload/build-egress-manifest.json`
   (`build-egress-current-dockerfiles-arm64-v1`): every HTTPS host is path-gated
   on the observed prefixes; the sparse-index/npm namespaces (whose paths span
   the whole host) are host-gated by a `/` prefix. The freeze surfaced that npm
   requests scoped-package metadata as `/@scope%2fname`, which the global `%2f`
   smuggling guard rejected — resolved with a narrow per-rule `allowEncodedSlash`
   opt-in (npm registry only; `%5c`/`%25`/traversal stay globally rejected). An
   offline gate authorizes every captured endpoint and rejects unlisted-host,
   wrong-method, path-outside-prefix, credential-header, and encoded-smuggling
   requests (34/34).

2. **`base-image` seam — RESOLVED (mediated by registry-egress, 2026-07-23).** The
   original plan to pin daemon-layer `FROM` pulls as build-egress
   `base-image`/`dockerfile-frontend` rules was corrected against the code: a `FROM`
   pull never traverses the build-egress proxy (that proxy is `--build-arg`-wired into
   `RUN` steps; the daemon resolves `FROM` out-of-band), and the build-egress schema
   cannot carry a registry pull anyway because it unconditionally rejects an `authorization`
   header fail-closed, breaking Docker Hub's anonymous `401`→token→`Bearer` retry. Base-image mediation is
   the already-frozen registry-egress path (`registry-egress-manifest.json`, §6.4), which
   is repo-agnostic within its listed origins and so authorizes the one external base
   pull (`node:22-trixie`, repository `library/node`) with no manifest change — a
   committed test asserts that manifest/blob/token path. The
   `base-image`/`dockerfile-frontend` seam enums stay in the build-egress schema as
   provenance/audit vocabulary only. A rebuild is not byte-reproducible while
   RUN-step apt/npm inputs remain unpinned, and bundle-image identity is not a host
   security boundary. Routing daemon `FROM` pulls through registry egress remains a
   future wiring item. Any future DD relay build is qualified and pinned independently
   because that service receives network authority unavailable to the bundle.

The raw per-group drafts (`build-egress-manifest.draft.json`, `capture-evidence.json`,
`build-logs.json`, and the per-build `overlays/`) are produced under the operator's
evidence dir by re-running the harness; they are intentionally not committed (large,
host-specific).
