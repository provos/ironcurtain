# Secure Nested Runtime Package Network

**Status:** implemented macOS developer capability; Docker Desktop developer release-qualified
**Updated:** 2026-09-01
**Applies to:** the Apple Container and Docker Desktop developer-only nested-Docker runtimes
**Related:**
[`secure-nested-runtime-implementation-plan.md`](./secure-nested-runtime-implementation-plan.md),
[`secure-nested-runtime-handoff.md`](./secure-nested-runtime-handoff.md)

## 1. Decision

IronCurtain will expose one meaningful nested-Docker **Network access** control with three states:

| Value      | Public image pulls                             | Package network                                              | Intended use                                      |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `offline`  | no                                             | no                                                           | Locally loaded images and hermetic builds only    |
| `images`   | Docker Hub and GHCR through registry mediation | no                                                           | Public image pulls with offline Dockerfile `RUN`s |
| `packages` | Docker Hub and GHCR through registry mediation | fixed public apt, npm, PyPI, and Cargo repositories via MITM | Ordinary project package installation             |

`packages` replaces the previously designed `public` mode. There is no product mode that exposes a
generic public HTTP proxy, an opaque end-to-end CONNECT tunnel, or arbitrary `curl` destinations. The
dedicated package proxy terminates TLS, authorizes each decrypted request against fixed host, port,
method, header, and path grammars, and creates the destination-bound upstream connection itself.

`packages` is the recommended choice for a newly enabled session. The CLI and web UI MUST explicitly
persist `networkAccess: "packages"` when an operator freshly enables nested Docker. They MUST NOT infer
that authority from a schema default.

This remains bundle-wide authority, not a trusted claim that a request came from BuildKit. The selected
outer agent image, private daemon, BuildKit executor, Dockerfile, and every inner container are one
colluding bundle. Any bundle member that reaches `127.0.0.1:18082` may make an otherwise valid package
request. The proxy policy, not source identity, is the security boundary.

## 2. Configuration, defaults, and migration

The canonical persisted request contains only `enabled` and `networkAccess`. Resolution, display, and the
first mutating save use this exact matrix:

| Stored request                                                              | Disabled display/default                     | Effective mode when already enabled | First enable or ordinary mutating save                         |
| --------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| no `dockerWorkload` block, or disabled block with no old/new network choice | show recommended `packages`; do not backfill | n/a                                 | enabling writes `enabled: true, networkAccess: "packages"`     |
| enabled block with no old/new network choice                                | n/a                                          | `images`                            | persist `networkAccess: "images"` on the next mutating save    |
| legacy `imageIngress: "public-registry"`, enabled or disabled               | show `images`; no authority while disabled   | `images`                            | replace the legacy field with `networkAccess: "images"`        |
| legacy `imageIngress: "preloaded-only"`, enabled or disabled                | show `offline`; no authority while disabled  | `offline`                           | replace the legacy field with `networkAccess: "offline"`       |
| superseded explicit `networkAccess: "public"`, enabled or disabled          | show `packages`; no authority while disabled | `packages`                          | replace `public` with the narrower `networkAccess: "packages"` |
| explicit `networkAccess` with any admitted enum                             | preserve the exact explicit choice           | preserve it                         | preserve it; re-enabling does not reset it                     |

The superseded `public` value is accepted only by the compatibility parser and normalizes to the
strictly narrower `packages` authority. It is never displayed or newly written. Unknown values fail.

Legacy `buildEgress: "disabled"` is normalized away. Legacy
`buildEgress: "ironcurtain-dockerfiles"` remains rejected with an actionable message because none of the
three admitted modes preserves its obsolete source/path semantics. Simultaneous `imageIngress` and
`networkAccess` remains a mixed old/new network-choice conflict and is rejected even when the values
appear equivalent. Other compatibility-only fields retain the current validate-then-normalize behavior:
safe fixed-profile equivalents are erased on mutation, while unsupported backend, resource, disk-risk,
or other intent fails actionably.

Merely opening, previewing, or reading a disabled configuration with no prior choice does not write
`packages`. The first CLI/web enable action is the authority-granting mutation and explicitly persists
it. While nested Docker is disabled, the selector is display-only; its value may be changed only as part
of enabling or while nested Docker remains enabled. Disabling preserves the explicit preference.

Changes apply only to new sessions. A session's resolved mode, package policy, CA generation, proxy
instance, and daemon data root are immutable for its lifetime.

## 3. Goals

1. A fresh CLI or web enablement can pull public base images and build ordinary Dockerfiles that use the
   admitted apt, npm, pip, or Cargo public repositories without adding an IronCurtain CA or proxy stanza
   to the Dockerfile.
2. The package listener exposes only fixed package-repository request grammars. Unknown hosts, ports,
   methods, paths, query forms, bodies, recognized credential fields, cookies, upgrades, and generic
   tunnels contact no upstream.
3. The host remains the immediate-address, request-policy, accounting, and lifecycle authority. Guest
   daemon, wrapper, image, and client observations never grant network authority.
4. Removing proxy configuration still leaves the bundle with no direct route: Apple keeps the outer VM
   and RootlessKit topology offline, while Docker Desktop keeps the agent/daemon off the default bridge
   and exposes only fixed relays on the isolated egress network.
5. IronCurtain provisions no registry, package-manager, proxy, origin, or host credential to the bundle
   or an upstream request. Only public CA material crosses into the backend bundle and BuildKit executor.
   This is not an exfiltration-prevention claim: bundle data can be encoded into admitted paths, bounded
   request metadata, and timing.
6. Feature-off, `offline`, and `images` sessions provision no package listener, socket mount, relay,
   package build configuration, runc injection artifact, or package-network orientation.
7. Connections, attempts, bytes, time, parser state, redirects, logs, and cleanup are bounded in batch,
   workflow, and PTY paths.

## 4. Non-goals and non-claims

This slice does not provide:

- a build-only security boundary or proof that a request came from BuildKit;
- generic public web access or arbitrary `curl`, `wget`, Git, archive, installer-script, or source-host
  downloads;
- arbitrary TCP, opaque CONNECT, UDP, QUIC, SSH, `git://`, FTP, custom ports, inbound connections, or Mac
  host publication;
- private registries, private package sources, authenticated repositories, client certificates, or
  IronCurtain-provided credentials;
- support for npm publish/login/audit APIs, PyPI upload/JSON APIs, Cargo search/owner APIs, or arbitrary
  Debian mirror paths;
- reproducible builds, artifact integrity, dependency trust, malware screening, SBOM admission,
  signature verification, or package provenance;
- prevention of all exfiltration. A hostile bundle may encode bounded workspace or build data into an
  allowed package path, permitted conditional/range metadata, or request timing visible to a fixed public
  repository;
- prevention of an admitted public repository address from relaying or NAT-hairpinning to a locally
  exposed service. IronCurtain screens the immediate peer, not every public endpoint's downstream path;
- automatic trust support for every TLS implementation or base image. Java keystores, rustls/webpki,
  application-private stores, and other non-system trust mechanisms remain unsupported;
- Compose builds, remote/custom BuildKit workers, native Linux, preview, or stable-tier support in this
  slice.

Package responses and image contents are untrusted bundle state. Package policy authorizes a network
request; it does not admit the bytes returned by that request or any image layer containing them.

## 5. Threat and authority model

### 5.1 Untrusted bundle

The following are mutually colluding and untrusted:

- the selected outer agent image and process;
- the private dockerd, containerd, BuildKit, and every API response or diagnostic they produce;
- Dockerfile frontends, build contexts, build steps, cache records, output images, and imported cache;
- every inner container, including a `--network host` container;
- Docker arguments, environment, package configuration, DNS names, HTTP requests, and TLS bytes;
- any guest-side wrapper log, runc report, file hash, process identity, container label, or claimed build
  provenance.

The bundle owns its private daemon and can restart or deliberately misconfigure it. Therefore CA
injection and the runc wrapper are compatibility mechanisms only. Bypassing them can make ordinary TLS
clients fail or force a hostile client to opt out of verification; it cannot widen the host package
proxy's request policy or create direct egress.

### 5.2 Host authority

The security boundary remains the host-enforced envelope:

- the disposable outer Apple VM has `network=none`, and RootlessKit remains
  `--net=none --disable-host-loopback`;
- the Docker Desktop agent/private daemon join only the exact isolated bundle egress network; only
  independently pinned fixed relays receive the default-bridge host-gateway hop;
- dockerd remains `--iptables=false --bridge=none`;
- the Docker API remains VM-local on Apple or confined to the lease-owned Desktop API volume, and no
  Docker-selected host port is published;
- Apple exposes only exact per-bundle host UDS listeners; Docker Desktop host TCP listeners require the
  exact relay source and per-bundle proxy authorization;
- the host package proxy owns CONNECT, TLS termination, HTTP parsing, repository policy, DNS resolution,
  address classification, upstream TLS, redirect validation, ceilings, logs, and shutdown;
- leases, watchdog, immutable outer IDs, state-root ownership, and exact teardown remain the resource
  authority.

The host package proxy is secure only if every connection is treated as hostile. Socket placement,
friendly build wiring, wrapper interception, and CA possession are not authorization controls.

### 5.3 Authority granted by each mode

- `offline`: locally available image bytes and bundle-private sibling networking only. Apple loads the
  selected current-agent transport image; Docker Desktop begins empty and accepts explicit
  `docker image load --input /workspace/<archive>.tar` imports from the shared workspace.
- `images`: `offline` plus the existing Docker Hub/GHCR image-registry capability on `18081`.
- `packages`: `images` plus GET/HEAD access on `18082` to the fixed package grammars in §7, mediated by
  host TLS termination and request authorization.

## 6. Operator and agent experience

### 6.1 CLI and web UI

Both settings surfaces show the same selector below enablement:

```text
Network access
  Public packages and images (recommended)
    Docker Hub/GHCR plus fixed public apt, npm, PyPI, and Cargo downloads.
    Generic destinations, recognized credential fields, request bodies, and uploads are rejected.
  Public images only
    Docker Hub and GHCR pulls work; Dockerfile RUN networking is offline.
  Offline
    Only locally loaded images and hermetic builds work.
```

Immediately adjacent to the selector, CLI and web MUST render this exact sentence:

> Packages permits any process in this nested-Docker session to send bounded workspace or build data
> through allowed package paths, permitted request metadata, and timing to fixed public repositories, and
> to download untrusted content. IronCurtain does not inject credentials and rejects recognized
> credential fields and request bodies. It screens the immediate peer, but a public repository may relay
> or hairpin elsewhere; use Images only or Offline to remove this route.

The package choice MUST NOT say "build-only", "no exfiltration", "safe packages", "verified packages",
or "full internet". While disabled, the selector and all choices remain visible but noninteractive and
must not create a pending config mutation. CLI diff/preview/save and web get/set preserve a disabled
block's explicit preference exactly. The web DTO carries the enum rather than reconstructing booleans.

Status is similarly direct:

```text
Nested Docker: enabled · network: public packages + Docker Hub/GHCR (strict proxy)
Nested Docker: enabled · network: Docker Hub/GHCR images only
Nested Docker: enabled · network: offline
```

### 6.2 Agent guidance

Batch, workflow, and PTY orientation state:

- supported package ecosystems and the exact unsupported private/authenticated cases;
- supported direct build commands and explicit Compose/buildx limitations in §10;
- `--network=none` is a cooperative per-build offline opt-out;
- arbitrary `curl` URLs and installer scripts do not work in package mode;
- bypassing the Docker build shim loses automatic proxy/network selection but does not create direct
  internet access;
- package responses, caches, and built images remain untrusted.

## 7. Dedicated package MITM protocol

The package listener is a dedicated small host server. It may reuse reviewed CA, destination-bound
transport, address-classification, backpressure, package-identity parsing, and ledger primitives, but it
MUST NOT run standard `MitmProxy` mode. It has no LLM providers, fake or real API keys, OAuth, trajectory
capture, dynamic host set, control API, registry-image bearer logic, passthrough path, or
`IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` behavior.

### 7.1 Fixed repositories

The first admitted set is source-owned, qualification-tested, and not user-configurable:

| Ecosystem  | Client-visible hosts                               | Ports                         |
| ---------- | -------------------------------------------------- | ----------------------------- |
| npm        | `registry.npmjs.org`                               | CONNECT 443                   |
| PyPI       | `pypi.org`, `files.pythonhosted.org`               | CONNECT 443                   |
| Debian apt | `deb.debian.org`, `security.debian.org`            | absolute HTTP 80, CONNECT 443 |
| Cargo      | `index.crates.io`, `static.crates.io`, `crates.io` | CONNECT 443                   |

The Debian row is an explicit repository-family matrix, not a host/path cross-product.
`deb.debian.org` admits ordinary `/debian/...` and security `/debian-security/...` routes;
`security.debian.org` admits only the security family. Security artifacts use only
`/debian-security/pool/updates/<component>/...deb`; `/debian-security/pool/<component>/...deb` and
ordinary `/debian/...` routes on `security.debian.org` are denied.

No wildcard, operator-added host, alternate port, IP literal, local alias, private mirror, generic CDN,
or client-selected redirect origin is admitted. Adding an ecosystem, distribution, mirror, or host is a
reviewed source change with hermetic policy tests and a live client qualification.

### 7.2 Connection and TLS admission

HTTPS accepts only a canonical `dns-name:443` CONNECT authority from the fixed table. Before returning
success, the listener charges an attempt and concurrency slot and validates syntax and host/port policy.
It returns `200 Connection Established` only to begin a bounded server-side TLS handshake.

TLS termination MUST require exactly one canonical plaintext SNI equal byte-for-byte to the canonical
CONNECT hostname. Missing, duplicate, malformed, trailing-dot, IP-literal, encrypted, or mismatched SNI
closes the connection without upstream contact. The leaf certificate is generated from the host-held
IronCurtain CA only after equality and host policy pass. The inner HTTP Host authority must again equal
the CONNECT/SNI name; it is never trusted to choose the destination.

Only TLS 1.2 or newer and HTTP/1.1 are admitted initially. HTTP/2, WebSocket, protocol upgrade, extended
CONNECT, TLS renegotiation, and client certificates are rejected or unsupported. The proxy creates a new
TLS connection to the fixed upstream hostname with normal public-root validation, exact SNI, and no
client credential.

Plain HTTP exists only for Debian apt compatibility. It accepts canonical absolute-form GET/HEAD on an
admitted apt hostname at port 80, applies the same host/path/header policy, then re-originates HTTPS to
the same fixed hostname on port 443. No other ecosystem or port receives cleartext forwarding.

### 7.3 Request envelope

Every admitted request satisfies all of these invariants:

- method is exactly GET or HEAD;
- request target is canonical origin-form after CONNECT, or canonical absolute-form for apt HTTP;
- no request body, `Content-Length`, `Transfer-Encoding`, trailer, `Expect`, upgrade, or pipelined second
  request exists;
- query and fragment are absent unless the ecosystem grammar explicitly names a fixed safe query form;
  the initial grammar admits none;
- exact Host is consumed locally; upstream Host, `Connection: close`, a fixed IronCurtain `User-Agent`,
  and ecosystem-specific `Accept`/`Accept-Encoding` values are synthesized rather than forwarding
  bundle-selected strings;
- `Range`, `If-None-Match`, and `If-Modified-Since` are accepted only where a qualified client requires
  them, under source-owned numeric/etag/date grammars and tight value caps, then reserialized canonically;
  `Cache-Control`/`Pragma` are reduced to a fixed supported enum or dropped;
- bounded npm diagnostic headers required by qualified clients (`npm-auth-type`, `npm-command`,
  `npm-in-ci`, `npm-scope`, `npm-session`, and `pacote-version`) may be accepted under exact value
  grammars and dropped locally but never forwarded;
- bundle `User-Agent`, diagnostic headers, `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`
  request confusion, API-key headers, forwarding headers, and every unknown header are rejected or
  consumed locally as specified above and are never forwarded;
- the request target and header values are bounded, canonical, free of control characters, and recorded
  only as bounded structured audit fields.

An authenticated public-package configuration fails actionably. IronCurtain neither forwards a
recognized bundle-supplied repository token nor substitutes a host credential. A hostile bundle can
still encode data, including data it regards as secret, into admitted path segments, canonicalized
metadata, and request timing; the exact warning in §6.1 is therefore mandatory.

### 7.4 Package path grammars

The implementation uses parsed segments and canonical package/version validators, not prefix-only or
substring checks. At minimum the initial grammars admit:

- **npm:** canonical unscoped/scoped packument paths and matching
  `/<package>/-/<package>-<version>.tgz` downloads. Deny `/-/` administrative, publish, login, whoami,
  audit, search, replication, couchdb, and unknown paths. Disable npm's optional audit request in the
  generated build environment rather than admitting its POST API.
- **PyPI:** `/simple/<normalized-project>/` index requests and canonical
  `files.pythonhosted.org/packages/<hash-layout>/<distribution-file>` downloads, including reviewed PEP
  658/714 sidecars. Deny `/simple/` enumeration, upload, JSON API, search, account, and unknown paths to
  the client. Host-internal metadata lookup for package-policy evaluation is a separately constructed
  derived GET, not a client capability.
- **Debian apt:** canonical repository metadata, `by-hash`, translation, signature, and package index
  files beneath reviewed `/debian/dists/` and `/debian-security/dists/` roots under the exact host/family
  matrix above, plus ordinary `/debian/pool/<component>/...deb` and security
  `/debian-security/pool/updates/<component>/...deb` artifacts. Reject dot segments, encoded separators,
  arbitrary roots, query strings, uploads, and malformed `.deb` names. APT's GPG checks remain client
  behavior, not an IronCurtain integrity claim.
  Within the version field of an otherwise canonical `.deb` filename, lowercase `%2b`, `%7e`, and `%3a`
  for APT-quoted `+`, `~`, and the Debian epoch separator are the only admitted percent encodings. Those
  characters must use that encoded spelling rather than a literal alias. The exact encoded path is retained
  upstream and in the audit route while package identity uses the once-decoded version. Case variants,
  double encoding, encoded dot/separator/delimiter bytes, and encoding outside the version field fail.
- **Cargo:** sparse-index `config.json`, canonical sparse crate-index paths, exact
  `crates.io/api/v1/crates/<crate>/<version>/download` transitions, and matching
  `static.crates.io/crates/<crate>/<crate>-<version>.crate` files. Deny search, owners, readme, publish,
  yank, login, and unknown API paths.

Metadata responses may be filtered through the existing package validator when an independently enabled
package policy applies. With no such policy, syntactically recognized public packages are allowed. This
does not add nested-Docker-specific allowlists or quarantine settings to Network access.

### 7.5 Redirects and derived requests

The proxy never turns an arbitrary `Location` into authority. Before returning a redirect to the client,
it parses the absolute or relative location, requires HTTPS, maps it to one fixed host and grammar in the
same ecosystem, removes userinfo and fragments, and rejects every other transition. The next client
request is a new charged connection and is independently authorized.

Debian redirects must preserve the ordinary/security repository family. A cross-host Debian security
redirect additionally preserves the exact path; it cannot use the second fixed host to select another
security metadata or artifact route.

Host-internal metadata requests used to validate a package are exact source-constructed GETs to fixed
host/path templates. They use the same address screen, destination-bound transport, time/byte/session
ledger, and public-root TLS validation. Client headers, cookies, recognized credentials, and bodies are
never copied into them. There is no generic redirect follower or parent CONNECT fallback.

## 8. Address policy, bounds, and accounting

### 8.1 Immediate-destination policy

For every upstream connection, the host resolver obtains the complete A/AAAA set. The request fails if
the set is empty, malformed, mixed public/non-public, or contains a current host/interface/gateway
identity. The actual socket uses one address from that screened set without uncontrolled re-resolution.
Immediately before connect and again before sending request bytes, refresh the host identity inventory;
inventory failure or inconsistency denies the request.

The classifier denies, including equivalent and IPv4-mapped forms:

- unspecified, loopback, RFC1918, carrier-grade NAT, link-local, multicast, documentation, benchmark,
  reserved, future-use, and cloud metadata addresses;
- IPv6 unspecified, loopback, unique-local, link-local, multicast, documentation, mapped denied IPv4,
  and all special-purpose/non-global ranges;
- Apple VM, RootlessKit, Docker bridge, managed-network, host-only-network, current Mac interface/peer,
  and current route-gateway addresses;
- decoded denied IPv4 within RFC 6052/DNS64 `/32`, `/40`, `/48`, `/56`, `/64`, and `/96` layouts, with
  canonical zero suffix requirements; local-use/ambiguous translation forms;
- decoded denied endpoints within 6to4 `2002::/16` and both Teredo server/client identities within
  `2001:0000::/32`.

This controls only the immediate peer. A fixed repository may be compromised, may resolve to a public
relay, or may be reached through a router-owned public hairpin that the host cannot enumerate. The
operator warning and nonclaims must remain explicit.

### 8.2 Bounds

The first admitted constants are host-owned source values, not settings:

| Bound                                                   |  Initial value |
| ------------------------------------------------------- | -------------: |
| Accepted client connections/attempts per bundle session |          4,096 |
| Attempt rate per bundle                                 | 120 burst; 2/s |
| Concurrent package requests/connections                 |             16 |
| Derived metadata requests per accepted client request   |              2 |
| Concurrent derived metadata requests per bundle         |              8 |
| Combined direct and derived upstream connections        |             24 |
| Request headers                                         |         32 KiB |
| Request target                                          |          8 KiB |
| TLS handshake bytes                                     |         64 KiB |
| TLS handshake timeout                                   |      5 seconds |
| DNS resolution timeout                                  |      5 seconds |
| Upstream connect timeout                                |     10 seconds |
| Absolute request lifetime                               |     10 minutes |
| Established idle timeout                                |     60 seconds |
| Bytes per request, both directions                      |          2 GiB |
| Bytes per bundle session, both directions               |         16 GiB |

Every accepted UDS connection, including the exact bootstrap health request, consumes one nonrefundable
attempt/token and a concurrency slot before parsing. Malformed, denied, failed, timed-out, and successful
connections count exactly once. The health contract is exactly:

```http
GET http://ironcurtain.invalid/__ironcurtain/package-egress/health HTTP/1.1
Host: ironcurtain.invalid
Connection: close
```

It returns status 200, `Content-Type: text/plain`, `Connection: close`, and the exact body
`IRONCURTAIN_PACKAGE_EGRESS_OK/1\n`. It performs no DNS or upstream operation and is not a free bypass.

Each source-constructed derived metadata request consumes a second nonrefundable attempt/rate token and a
derived concurrency slot before DNS; at most two are created for one accepted client request and at most
eight are active for the bundle. Direct plus derived upstream connections never exceed 24. Failure to
acquire any token or slot fails the originating request closed. Derived bytes and lifetime also count
against the same per-request and per-session ceilings.

The initial server supports one request per client connection and closes it. Attempts and session bytes
are monotonic. Concurrency releases idempotently on every completion, denial, abort, failure, timeout, and
shutdown. Both upload and download count; streams use backpressure and never buffer a full package.
Exhaustion closes both sides and never falls back to direct transport. Logs cap hostile fields and never
persist bodies, credentials, cookies, complete query data, response content, or TLS keys.

## 9. CA delivery and pinned runc compatibility shim

### 9.1 Authority boundary

The package proxy holds the IronCurtain CA private key on the host and uses it only to sign admitted fixed
repository host certificates. The outer VM receives only:

- the public IronCurtain certificate;
- a public bundle containing system roots plus that certificate;
- a credential-free apt proxy/trust configuration;
- immutable metadata containing their hashes and generation.

The private key, CA directory, provider credentials, proxy control sockets, and host package credentials
are never mounted or copied into the bundle. CA creation and loading use one host-only, owner-`0700`
trusted parent and a bounded exclusive lock so concurrent creators and loaders serialize or time out
closed. Creation writes a new randomly named generation directory with exclusive leaf-file `O_NOFOLLOW`
opens, exact key mode `0600`, exact public certificate mode `0644`, and no pre-existing path.
After fsync, the creator validates certificate parsing, the exact strict-v2 root profile (critical Basic
Constraints `CA=true,pathLen=0`; critical Key Usage `keyCertSign,cRLSign`; a public-key-derived Subject Key
Identifier; and an absent Authority Key Identifier or one exactly equal to that Subject Key Identifier),
validity, minimum key strength/algorithm, and exact certificate/public-key match to the private key. It then writes
and fsyncs an exact hash manifest and atomically publishes a small `current.json` manifest by same-directory
rename plus directory fsync. It never publishes individual `current-key`/`current-cert` paths.

The loader recognizes only that exact strict-v2 profile or the exact historical legacy-v1 profile generated
by IronCurtain (noncritical `CA=true` Basic Constraints and noncritical `keyCertSign,cRLSign` Key Usage,
with no other extensions). A legacy flat pair or current generation is reissued as strict-v2 with the same
private key, written as a new complete generation, and selected by atomic replacement of `current.json`
under the CA lock. The prior complete generation is retained because an already-running session may still
reference it. An interrupted post-pointer flat-file cleanup is recoverable only when the residual exact
legacy profile matches the selected strict authority's private key. Malformed near-legacy and near-v2
profiles fail closed rather than being repaired or generalized.

Issued repository leaves have exact SAN identity, critical `CA=false` Basic Constraints, critical TLS Key
Usage, `serverAuth` Extended Key Usage, a public-key-derived Subject Key Identifier, and an Authority Key
Identifier explicitly equal to the selected CA Subject Key Identifier. Leaf validity is contained within
the CA validity window. Acceptance includes a Python `VERIFY_X509_STRICT` handshake through its OpenSSL
backend; clients are not weakened to compensate for an incomplete certificate profile.

The loader authenticates the current manifest and named generation, uses leaf-file `O_NOFOLLOW`, and
rechecks owner, modes, regular-file types, link count, sizes, hashes, certificate constraints/validity, and
key-pair equality before use. A missing/partial generation, mismatched pair, unsafe permission, leaf
symlink/hardlink, stale temp, lock timeout, or crash before manifest publication fails closed; unreachable
temporary generations are removed only while holding the same lock. Warning and continuing is
insufficient for this authority.

Node does not expose a portable `openat`/`openat2` beneath traversal for this path. The owner-only
IronCurtain home and its same-UID host processes are therefore part of the host root of trust: this design
does **not** claim to resist a concurrent parent-directory or generation-directory swap by another process
running as that same host UID. Such a process can already replace IronCurtain configuration, credentials,
and executable inputs. Nested bundle code receives no CA-directory or parent-directory mount and cannot
exercise this host-filesystem race; extending the boundary to hostile same-UID host processes requires a
native descriptor-relative storage helper and is a separate security design.

### 9.2 Qualified runc seam

The 2026-08-22 Apple spike established that the pinned Docker 29.2.1 embedded BuildKit invokes PATH name
`runc` for executor `run` operations. Production may use that behavior only as a frozen,
version-qualified compatibility seam:

- ship a static, reviewed wrapper named `runc` in a read-only IronCurtain shim directory;
- put that directory first on the trusted daemon PATH, followed by `/usr/bin:/bin` and then the pinned
  daemon toolchain so `/usr/bin/newuidmap`/`newgidmap` behavior remains unchanged;
- exec the real pinned runc only by its absolute toolchain path after verifying expected version/hash,
  regular-file type, owner, mode, and no symlink;
- never use `DOCKER_BUILDKIT_RUNC_COMMAND`, an environment-selected real runtime, `/usr/bin/runc`, Python,
  or a caller-selected runtime path;
- qualify the exact Docker, embedded BuildKit, containerd, and runc versions. Any change requires a new
  live qualification before package mode is admitted.

This is not an upstream-stable Docker interface. A future Moby change to an absolute runtime path,
different executor, or separate builder is expected to fail the startup canary and make `packages`
unavailable until reviewed. It MUST NOT trigger a generic-network fallback.

### 9.3 OCI spec patch

For the pinned stack, the only automatically patched launch shape is this complete argv vector after
`runc`, with no omitted prefix/suffix:

```text
--log <executor-root>/runc-log.json
--log-format json
run
--bundle <executor-root>/<bounded-id>
--keep <bounded-id>
```

`<executor-root>` is exactly the qualified
`/home/codespace/.local/share/docker/buildkit/executor`; the bundle path is one direct child, and both ID
positions are byte-for-byte equal. The checked-in
[`redacted argv fixture`](../../docker/build-trust-runtime/testdata/ca-injection-runc-path-spike.argv.json) is the test oracle. Missing,
duplicated, reordered, or additional arguments, a different log path, a non-direct-child bundle, or
unequal IDs fail before spec mutation or real runc. Non-BuildKit runc commands pass to the exact real
binary unchanged. Any other launch shape beneath the BuildKit executor root fails closed so version drift
cannot silently run a supported build without trust injection.

Traversal of the executor tree uses its own policy and accepts only the complete owner pairs `0:0` or
`65534:65534`; it does not reuse the trust-tree policy, and runtime-user or mixed pairs fail. The direct
bundle remains exactly child-root `0:0` mode `0711`, its `config.json` remains root-owned mode `0644`, and
its rootfs remains root-owned mode `0755`. Symlinks, non-direct-child bundles, overflow-owned bundles,
and mode drift fail before mutation.

The root-owned selected-image runc has two namespace views of the same immutable inode: UID/GID `0:0`
in the outer agent VM and the overflow pair `65534:65534` in the RootlessKit child. The authenticated
contract's `realRunc` record names exactly the ordered pairs `[{uid:0,gid:0},{uid:65534,gid:65534}]`. Validation accepts only
those two complete pairs; reordering, extras, UID/GID `1000:1000`, and either mixed pair fail. Parent traversal likewise
accepts only root or overflow ownership, while digest, size, mode `0755`, regular-file type, and one-link
requirements remain identical across views.

The contract, CA certificate, CA bundle, and apt configuration are dedicated copies staged under the
bundle's package-build runtime, not aliases into the agent-visible orientation tree. Apple mounts those
four exact leaves read-only at `/opt/ironcurtain-build-trust/{build-trust-contract.json,ca-cert.pem,ca-bundle.pem,apt.conf}`.
Only `docker/Dockerfile.base.arm64` precreates the common parent, as root:root mode `0755`; runtime code
does not create or repair it. Parent traversal accepts only complete `0:0` or `65534:65534` pairs and
rejects `1000:1000` and mixed pairs. The outer preflight requires the direct parent to be exactly
root:root mode `0755`.

Trust leaves have namespace-translated ownership across qualified views. Their UID/GID is bounded
diagnostic metadata, not admission authority; no contract or public-source leaf UID/GID is recorded in
the generated contract or manifest. This does not alter the real-runc pairs above. Every trust leaf must
remain a regular file with mode `0444`, one link, bounded exact size and digest from the same descriptor,
and effective read-only backing proven on every wrapper load by `Fstatfs(ST_RDONLY)` plus an
`O_WRONLY|O_NOFOLLOW` attempt that fails specifically with `EROFS`. The public-source schema retains only
the exact ordered source/destination paths, digest, size, and mode. OCI destinations remain beneath
`/dev/ironcurtain`; the outer agent's ordinary `/etc/ironcurtain` orientation mount is unchanged.

The outer preflight first resolves and hashes the wrapper as `codespace`, then invokes that exact absolute
path as UID/GID `0:0` with only `--version`. Root supplies `CAP_DAC_OVERRIDE`, making `EROFS` distinguish a genuine
read-only mount from a writable mode-`0444` file that would otherwise fail write-open with `EACCES`.
BuildKit's RootlessKit-child invocation repeats the same strict proof before every handoff. `Fstatfs` is
bound to the already-open no-follow descriptor; the path write-open is supplemental, so a path race
cannot qualify writable backing unless the validated descriptor itself already reports `ST_RDONLY`.

The wrapper's main failure branch may best-effort create only
`/tmp/.ironcurtain-build-trust-runc-failure-v1`, using descriptor-relative exclusive/no-follow `0600`
creation beneath an exact root-or-overflow-owned mode-`1777` `/tmp`, followed by regular-file, one-link,
stable-inode, and fsync checks. File contents are one reviewed ASCII code of at most 128 bytes—never raw
error text, argv, environment, or contract bytes. Exact sole-argument internal clear/read commands are
dispatched before normal runc grammar; clear uses secure `unlinkat` with absent accepted, while read emits
only an allowlisted code or fixed unavailable code. The session invokes the absolute digest-checked
wrapper as `0:0`, clears before and after every canary, reads only after a build failure, and appends the
code inside the existing bounded diagnostic. These operations are best-effort diagnostics: they cannot
alter admission, cleanup, ledger equality, or primary error causality. Reviewed codes identify executor
and bundle open/metadata stages; per-source open, metadata, effective-read-only, and digest stages for the
CA certificate, CA bundle, and APT config; and config open, metadata, read, strict-envelope, patch, and
atomic-commit stages. Typed inner stages survive outer wrapping, while untyped failures produce only the
fixed internal-error code.

The wrapper:

1. parses argv without shell evaluation and canonicalizes the configured data root;
2. opens the executor directory and `config.json` beneath that root with no-follow/beneath semantics,
   bounded component lengths, regular-file/type/owner/mode checks, inode revalidation, and a size cap;
3. parses strict OCI JSON and requires the security-relevant structure mapped to the checked
   [no-network](../../docker/build-trust-runtime/testdata/ca-injection-buildkit-oci-envelope.fixture.json) and
   [host-network](../../docker/build-trust-runtime/testdata/ca-injection-buildkit-oci-envelope-host.fixture.json) summaries: exact
   top/process/root/Linux key sets, OCI 1.3.0, the qualified capability/path sets, exact `/dev` mounts,
   and one of two ordered pathless namespace lists—`pid,ipc,uts,mount,network,cgroup` for no-network or
   `pid,ipc,uts,mount,cgroup` for host-network;
4. verifies exact public source files and hashes before use;
5. inserts read-only bind mounts beneath the already mounted OCI tmpfs:
   `/dev/ironcurtain/ca-cert.pem`, `/dev/ironcurtain/ca-bundle.pem`, and
   `/dev/ironcurtain/apt.conf`, with `rbind,ro,rprivate,nosuid,nodev,noexec` semantics;
6. injects fixed values for `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`,
   `NODE_EXTRA_CA_CERTS`, `npm_config_cafile`, `PIP_CERT`, `REQUESTS_CA_BUNDLE`,
   `CARGO_HTTP_CAINFO`, `APT_CONFIG`, `npm_config_audit=false`,
   `PIP_DISABLE_PIP_VERSION_CHECK=1`, and `UV_NATIVE_TLS=1`;
7. accepts an existing destination/env only when it is byte-for-byte the same idempotent value; any
   conflict, duplicate, malformed entry, missing `/dev` tmpfs, or unsupported structure fails before
   real runc;
8. writes one bounded canonical replacement with exclusive temporary creation, original ownership/mode,
   fsync, atomic rename, directory fsync, and post-write verification;
9. preserves real-runc argv, environment, cwd, file descriptors, signals, exit status, and error behavior
   apart from the specified patch, then `execve`s the absolute pinned binary.

Mounting below OCI `/dev` avoids creating mount stubs or overwriting the base image's system CA file in a
layer-backed rootfs. The injected env belongs only to the BuildKit executor process; it is not added to
image config. A malicious Dockerfile can deliberately copy the public certificate from the mount into an
image, so residue prevention is an automatic-behavior guarantee, not a boundary against a colluding
bundle.

The checked fixtures are structural summaries, not executable OCI specs. They omit seccomp body content,
literal environment values/RUN commands, and non-`/dev` mount detail. The wrapper bounds, collision-checks
where applicable, and otherwise preserves those fields; it does not claim them byte-frozen. Tests map
every summarized field the parser enforces to both fixture hashes, exercise both accepted namespace
shapes with a separate executable synthetic spec, and pin the checked
[comparison](../../docker/build-trust-runtime/testdata/ca-injection-buildkit-oci-envelope-comparison.json) showing that removal of the
`network` namespace is the only structural host-mode delta.

### 9.4 Startup qualification canary

Before releasing the agent in `packages` mode, the trusted lifecycle snapshots both registry and package
ledgers, then uses the exact pinned real Docker client—not the project build shim—to invoke the generated
BuildKit canary with `--pull=false --network=none --no-cache` and an immutable reference to the already
loaded selected image. A tag, mutable local name, implicit pull policy, other network mode, or omitted flag
fails qualification. Its RUN step verifies the expected public-file hashes, read-only mounts, env values,
absence of private-key material, and a nonce. Success additionally requires both ledger snapshots to be
byte-for-byte unchanged, proving the canary contacted neither registry `18081` nor package `18082`.

Startup separately probes the `18082` relay with the exact charged local health request. Package mode is
admitted only after version/hash attestation, relay health, and canary success. Canary/log evidence is
operational qualification from an untrusted guest, never host admission authority.

## 10. Docker build shim

IronCurtain supplies a read-only Docker client shim ahead of the real pinned client only in `packages`
mode. It makes supported builds select credential-free proxy arguments and RootlessKit host networking;
the runc wrapper separately makes ordinary TLS clients trust the package MITM.

The shim MUST:

- parse argv arrays without `eval`, shell re-parsing, or command-string construction;
- recognize only `docker build`, `docker image build`, `docker builder build`, and local-default-driver
  `docker buildx build` with a reviewed set of Docker global options;
- select an isolated generated Docker client config whose upper/lowercase HTTP(S) proxy values are
  `http://127.0.0.1:18082` and which contains no auth, credential helper, private host, or CA material;
- inject `--network=host` when no build-network option exists, preserve explicit `--network=none` as a
  cooperative offline opt-out, preserve explicit host without duplication, and reject every other
  build-network value;
- reject split/equal global `--context`/`-c`, noncanonical `--host`/`-H`, `--builder`, custom driver, and
  caller `DOCKER_CONTEXT`, `BUILDKIT_HOST`, `BUILDX_CONFIG`, `BUILDX_BUILDER`, or noncanonical
  `DOCKER_HOST`;
- reject every Compose build form and any alternate context, host, builder, driver, or wrapper selector
  encountered in a supported `docker` argv;
- pass every non-build command byte-for-byte to the exact real client without package proxy config;
- be absent outside `packages` mode.

Direct `docker-buildx`, `docker-compose`, and custom Docker/BuildKit clients are unsupported and are not
interposed or rejected by this shim; they may fail to obtain automatic package connectivity. Bypassing
the usability shim cannot create direct egress or broaden the host proxy. A hostile bundle can still
address the package relay directly and make any policy-compliant request; this is the documented
bundle-wide authority.

## 11. Topology, lifecycle, cache, and cleanup

### 11.1 Topology

Image registry and package traffic are separate capabilities. Apple uses same-VM loopback relays:

```text
daemon FROM/image pull
  -> HTTP(S)_PROXY=http://127.0.0.1:18081
  -> RootlessKit-netns relay
  -> /tmp/ironcurtain-registry-egress.sock
  -> existing Docker Hub/GHCR registry authority

BuildKit RUN package request
  -> HTTP(S)_PROXY=http://127.0.0.1:18082
  -> RootlessKit-netns relay
  -> /tmp/ironcurtain-package-egress.sock
  -> dedicated fixed-repository package MITM
  -> screened, destination-bound HTTPS upstream
```

Host sockets live below the existing mode-checked per-bundle runtime root as distinct
`registry-egress.sock` and `package-egress.sock` files. Apple mounts only those exact files. The package
relay binds only `127.0.0.1:18082` inside RootlessKit's private namespace. It is not published on a Mac
interface, Apple VM port, Docker bridge, Docker `-p` path, or the outer agent namespace. The registry
relay remains `18081` under the same constraint. Outer-agent package qualification connects directly to
the mounted `package-egress.sock` with AF_UNIX, including explicit CONNECT and TLS; it has no loopback TCP
fallback or URL-proxy client path.

Docker Desktop reuses the same host policy engines through a different fixed transport:

```text
agent/private daemon on the isolated bundle egress network
  -> fixed registry or package relay address
  -> independently pinned single-target relay
     (isolated bundle network + default bridge host-gateway hop)
  -> source-guarded host TCP listener with per-bundle Proxy-Authorization
  -> the same registry or package policy engine
  -> screened, destination-bound upstream
```

The agent and private daemon never join Docker's default bridge. Only the pinned relay joins it to reach
the Docker Desktop host gateway. This gives the relay NAT/L2 adjacency on that bridge; the accepted
residual risk and the reason a generic relay image/configuration is forbidden are recorded in the primary
implementation plan.

One checked-in Node process serves the selected fixed profile and binds every profile listener
all-or-rollback. Its shared connection ceiling is 32. Package connections have a 4-GiB-per-direction,
11-minute-idle, 11-minute-absolute transport envelope outside the stricter package ledger. Registry
connections have a 20-GiB-per-direction envelope—larger than the complete 16-GiB session ledger plus
framing—and the same idle bound, but no relay-level absolute timer: Docker may legally reuse one registry
connection across multiple independently time-bounded requests. A clean UDS EOF remains accounted until
the complete downstream response and TCP FIN flush and the TCP socket actually closes.

### 11.2 Startup order

For Apple `packages`, the exact order is:

1. resolve/migrate config and admit the Apple developer variant before feature-attributable work;
2. acquire the lease/watchdog authority and prepare the selected-current agent artifact;
3. load the host CA with strict private-key checks, then stage hashed public trust, apt config, static runc
   wrapper, Docker build shim/config, and orientation under exact roots;
4. construct registry and package listeners with separate ledgers, bind and verify exact UDS addresses,
   and apply only required socket modes;
5. create the outer Apple VM with `network=none`, mounting exact listener files and read-only staged
   artifacts;
6. inside RootlessKit `--net=none --disable-host-loopback`, verify guest sockets, start the fixed-profile
   loopback relay, and prove each profile endpoint reaches its matching listener using distinct local
   health contracts;
7. start dockerd with only registry proxy/CA settings and the qualified runc-wrapper daemon PATH; package
   proxy settings are not daemon image-resolution fallback;
8. adjudicate daemon profile/readiness, then load and re-inspect the selected image;
9. run the exact no-network BuildKit CA-injection canary from that already loaded image: require fresh
   bundle-unique `localhost/` base/output tags, bind and re-inspect the base tag to the selected immutable
   image ID, build with `--pull=false --network=none --no-cache`, capture a distinct output image ID, then
   ownership-check and remove only those exact canary artifacts while proving both tags/output ID absent,
   the selected logical/immutable image still present, and both egress ledgers unchanged;
10. create/inspect the managed internal network, record observations, and expose only the supported agent
    Docker shim/orientation;
11. activate the lease, then release batch/workflow execution or attach PTY.

Docker Desktop follows the same host-side authority order but replaces Apple mount/RootlessKit steps with
the shared sidecar lifecycle: create source-guarded/authenticated TCP listeners, allocate the exact
isolated egress network, start and adjudicate the independently pinned fixed relays, create the lease-owned
API/data volume and constrained rootless-daemon sidecar, run its activation/build canaries, start the agent
with only the read-only API volume, attach only the exact admitted egress network, prove the fixed policy
paths, and then activate/release the agent. An online retry never reuses an already activated workload
lease; preserving the original connectivity failure takes precedence over masking it with a second
precommit failure.

`images` retains the registry-only sequence and has no package listener, CA-injection wrapper, package
relay, build shim config, or package prompt. `offline` constructs neither egress listener. Feature-off
constructs no nested-Docker lease or artifacts.

Every failure after listener construction stops all constructed listeners before exact outer-resource
rollback. Normal teardown revokes package then registry listeners, destroys the exact Apple VM or Docker
Desktop agent/daemon/relay containers, removes owned Desktop volumes/networks, verifies immutable-ID
absence and two separated empty inventories, removes daemon state/runtime roots, and closes the lease.
Listener stop closes active sockets and settles ledger state. Outer removal kills RootlessKit, dockerd,
containerd, BuildKit, wrapper processes, and relays. Cleanup and crash reconciliation are idempotent.

Batch, workflow, and PTY share the same listener collection, mount builder, bootstrap mode, version
qualification, canary, activation, and cleanup helpers.

### 11.3 Cache contract

Runtime OCI injection is downstream of BuildKit cache-key computation. A cache hit performs no executor
launch, package request, policy decision, or audit event. This design therefore makes these exact
nonclaims:

- package mode governs new network requests, not the content or provenance of cached layers;
- a repeated build may reuse a package-containing RUN layer without contacting the proxy;
- imported image/cache bytes are untrusted bundle state and are never admitted by package policy;
- package audit is not a complete inventory of dependencies present in an output image.

This is acceptable only because the admitted Apple and Docker Desktop daemons/data roots are fresh and
disposable per bundle session, while mode, CA generation, and policy are immutable within that session.
A new session after configuration or CA change has a new VM-local data root or lease-owned Desktop data
volume and cannot reuse the old local BuildKit cache. Backend release workflows must prove that lifecycle
fact independently.

Persistent/cross-session BuildKit cache, live package-policy mutation, or a future claim that every build
revalidates dependencies is a new stop-gate. It requires cache-generation authority above runc or
mandatory cache bypass; the OCI wrapper cannot solve it.

## 12. Spike evidence and limits

The checked-in, redacted
[`CA-injection runc-PATH spike evidence`](./evidence/ca-injection-runc-path-spike.md) freezes the exact
qualified runc version and redacted exact BuildKit argv shape without retaining secrets. The 2026-08-22
spike is feasibility evidence, not production success and not a clean single-file green run. Its raw
functional result, wrapper log, harness, earlier controls, and reconciliation were transient source
artifacts under `/private/tmp`; the checked-in record, not those paths, is the durable review input.

The retained record contains the redacted exact argv and version output, the npm and Debian positives,
and the merged-filesystem observation. It also records that the raw functional result says
`passed: false` because its cleanup check inherited unrelated historical state. A separate later
production-API reconciliation established exact cleanup. Evidence must cite those as separate functional
and reconciliation facts, never as one clean end-to-end pass.

The spike does **not** prove a hardened wrapper, hostile OCI-spec handling, Buildx, pip, Cargo, arbitrary
base images, non-root/read-only-rootfs builds, multi-stage behavior, failure residue, exported-layer
absence, or package-proxy negative policy. Its Python wrapper followed paths, overwrote collisions, and
patched more runc invocations than the production contract permits. None of those behaviors is admitted
by this design.

## 13. Deterministic acceptance

The developer implementation has landed. This matrix records current implementation evidence separately
from the broader preview qualification matrix.

| Area                 | Release requirement                                                           | Current implementation evidence                                                                                             | Status                                                  |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Product authority    | no generic CONNECT; fixed package MITM is the only `18082` authority          | generic public path removed; dedicated listener and Apple/Desktop fixed relays are product-wired                            | landed                                                  |
| Package policy       | positive npm/PyPI/apt/Cargo plus exact hostile negatives                      | hermetic client/negative suites and deterministic Apple packages workflow; Docker Desktop release suite plus live apt build | developer-qualified; broader live client matrix remains |
| Address and ledger   | all denied destinations, attempts, limits, aborts, and shutdown are hermetic  | package address policy, request ledger, bounded transport, abort, and shutdown suites                                       | landed                                                  |
| Runc seam            | static pinned wrapper, hostile-spec tests, exact version qualification        | checked-in Go wrapper/runtime, generated diagnostic contract, hostile-spec tests, and startup canary                        | landed                                                  |
| Ordinary Dockerfiles | no source edit for supported package managers and local-default Buildx        | direct/default-Buildx shim forms cover npm, pip, apt, and Cargo; Compose builds remain explicitly unsupported               | landed                                                  |
| Secret provisioning  | no host credential/private key is provisioned; credential fields are rejected | public-only mounts, credential rejection, archive/VFS CA-SPKI residue checks, and persisted mount evidence                  | landed                                                  |
| Cache                | fresh per-session data root and explicit no-revalidation nonclaim             | cache-hit behavior is tested; exact bundle teardown removes the private data root/volume                                    | landed                                                  |
| Residue              | successful/failed exports and snapshots contain no automatic trust residue    | deterministic image archive and VFS graphdriver scans run in the Apple packages workflow                                    | landed; Desktop preview rerun remains                   |
| Lifecycle            | batch/workflow/PTY failure rollback and exact reconciliation                  | shared lifecycle/failure tests plus Docker Desktop coordinator-death, exact cleanup, child reaping, and readmission gates   | developer-qualified                                     |
| Configuration        | complete three-enum migration and CLI/web parity                              | config normalization plus CLI/web settings and warning tests cover all three modes                                          | landed                                                  |

`packages` is admitted only as developer functionality. The no-skip Docker Desktop release suite passes;
full G1-G10/0C reruns for each macOS backend and preview qualification remain open.

### 13.1 Strict package proxy

Hermetic resolver, dial, clock, interface, CA, and upstream fixtures prove:

- exactly every fixed host/port/path positive in §7 for GET and HEAD;
- npm install/view, pip install with wheel/sdist/PEP sidecar, Debian apt update/install, and Cargo sparse
  index/download request sequences;
- rejection before upstream contact of unknown hosts, wildcard/dynamic hosts, alternate ports, IP
  literals, malformed CONNECT, missing/duplicate/mismatched SNI, bad Host, cleartext non-apt requests,
  unknown paths, query/fragment variants, POST/PUT/DELETE, bodies, framing ambiguity, upgrades, and a
  pipelined second request;
- hard rejection of Authorization, Proxy-Authorization, Cookie, API-key, client-certificate, forwarding,
  and unknown headers; client-selectable headers are dropped or canonicalized and no host/provider
  credential is provisioned to or forwarded by the listener;
- allowed same-ecosystem redirects and denial of every cross-grammar/cross-host transition before the
  client receives usable authority;
- destination-bound upstream TLS with exact host/SNI/public-root validation and no direct/parent fallback;
- empty/mixed/private/local/metadata/special IPv4 and IPv6 answers, current interfaces/gateways,
  NAT64/DNS64, 6to4, Teredo, resolver/connect races, and inventory failure contact no upstream;
- every health, malformed, denied, failed, successful, redirect, and derived request charges exactly as
  specified; the 2-derived-per-client, 8-derived-concurrent, and 24-combined-upstream ceilings plus rate,
  parser, byte, time, queue, log, backpressure, reset, abort, and shutdown bounds settle exactly;
- `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS`, standard Mitm control state, provider configuration, and environment
  changes cannot widen the listener.

### 13.2 Hardened CA and runc wrapper

Hermetic CA filesystem tests race creators/loaders and cover the recoverable states around every
fsync/rename boundary. They prove that the atomically renamed `current.json` manifest is the sole
publication point; partial/unpublished generations are unreachable; legacy-v1 migration atomically selects
strict-v2 while retaining prior complete generations; concurrent callers serialize or time out closed; and
leaf symlink/hardlink replacement, unsafe owner or mode, non-regular/oversized files,
malformed/expired/not-yet-valid/non-CA certificates, weak algorithms, hash mismatch, and a
certificate/private-key mismatch are rejected without loading a signer. Certificate-profile tests require
the exact root and leaf identifiers/constraints, CA-bounded leaf validity, idempotent and crash-recoverable
migration, and a Python/OpenSSL strict chain handshake. Same-UID host parent-directory
replacement remains the explicit nonclaim in §9.1, not a nested-runtime acceptance gate.

Hermetic static-wrapper tests load the checked-in redacted argv fixture as their positive oracle and prove:

- only the full qualified `--log … --log-format json run --bundle … --keep …` vector is patched, with a
  direct-child bundle and one equal bounded ID; every missing, reordered, duplicated, or extra argument,
  changed log path, nested bundle path, and unequal ID is rejected;
- non-BuildKit version/create/start/delete commands reach exact real runc unchanged, while an unknown
  BuildKit launch shape fails before real runc;
- traversal, symlink/hardlink swap, wrong owner/mode/type, oversized/malformed JSON, unexpected OCI
  structure, missing `/dev` tmpfs, conflicting/duplicate env or mount, bad public hash, and temp/rename/fsync
  failures all fail closed;
- exact idempotent entries are accepted without duplication;
- real-runc path/hash/version and wrapper hash are immutable; PATH lookup cannot select `/usr/bin/runc` or
  a bundle-controlled binary;
- selected-image preflight proves the outer runc view is root:root, while envelope tests prove the same
  inode's RootlessKit child view is 65534:65534; runtime-user and mixed owner pairs fail;
- trust-tree preflight proves its outer parent is root:root mode `0755`; wrapper tests accept only complete
  root/overflow parent pairs, reject runtime-user and mixed pairs, treat every trust-leaf UID/GID as bounded
  diagnostics, and prove regular mode `0444`, one link, exact staged size/digest, `ST_RDONLY`, and `O_WRONLY`
  failure with `EROFS` for the contract and all public sources;
- only the selected image precreates `/opt/ironcurtain-build-trust`; Apple mounts exactly four dedicated
  package-runtime leaves there, while outer `/etc/ironcurtain` and OCI `/dev/ironcurtain` remain unchanged;
- diagnostic tests prove exact sole-argument dispatch, sticky-directory/openat/exclusive/no-follow/fsync
  handling, strict allowlisted codes, secure clear/read, build-failure-only read, both-outcome clear, bounded
  output, and no effect on admission, cleanup, ledgers, or primary causality;
- argv, env, cwd, descriptors, signals, exit status, and stderr behavior are preserved;
- persisted host `outer-create.expanded.mounts` evidence contains exactly the seven read-only package-build
  sources below the bundle runtime's `package-build-runtime`, keeps `/etc/ironcurtain` separate, and has no
  source below the host CA directory or private/key-named artifact; the staged public contract contains only
  the certificate, public bundle, and apt configuration and never loads or records the host CA key or its
  hash.

### 13.3 Settings and shim

Test the complete migration matrix in §2, including both CLI and web:

- no-choice disabled display is recommended `packages` without backfill; first enable writes it;
- no-choice enabled and old public-registry migrate to `images`; preloaded-only migrates to `offline`;
- superseded explicit `public` migrates to `packages`; new explicit enums are preserved while disabled,
  saved, and re-enabled;
- disabled selectors cannot dirty config or create a network-only save; enabled selectors can change all
  three modes; diff/change-count/raw-baseline behavior agrees;
- mixed old/new choices, unknown values, and obsolete `ironcurtain-dockerfiles` fail actionably;
- config hash, status, admission, logs, and orientation distinguish all modes.

Execute the generated Docker shim against hostile argv and a capturing real-client fixture. Prove exact
supported command recognition, insertion, no shell expansion, explicit offline opt-out, exact pass-through
for non-build commands, and rejection of every Compose and alternate context/host/builder/config/driver or
environment selector visible in a supported `docker` invocation. Verify documentation classifies direct
`docker-buildx`, `docker-compose`, and custom clients as unsupported and uninterposed, not shim-rejected.

### 13.4 Residue and lifecycle

For successful, failed, interrupted, cached, multi-stage, non-root, and read-only-rootfs builds across
representative Debian/Node/Python/Rust bases:

- export every output with `docker save`; bind each config and archive-layer order to the exact inspected
  public-base prefix and diff IDs; inspect every build-added layer tar entry, whiteout, and exact dynamic
  certificate/contract/config/path bytes; and reject any complete plaintext PKCS#1/PKCS#8 PEM private-key
  candidate within the CA source's 128 KiB ceiling whose derived public SPKI equals the staged IronCurtain
  CA certificate. An otherwise canonical bounded candidate missing only its footer is checked after
  reconstructing that matching public footer. Lone headers, prose, malformed bodies, other incomplete
  text, and oversized text are not key-identity candidates; unrelated complete keys already present in a pinned public base are permitted because they are neither
  provisioned by IronCurtain nor SPKI-equal to its CA. The exact public-only outer mount allowlist is the
  primary CA-key non-provisioning proof;
- inspect embedded BuildKit graphdriver and executor state before teardown; recursively screen every
  regular file observed during the one bounded traversal of the exact VFS graphdriver snapshot tree with
  the same dynamic markers and CA-SPKI key identity check,
  require the fixed BuildKit metadata/executor topology and no active executor bundles, and after teardown
  require the exact daemon data root absent;
- prove ordinary automatic builds leave no CA mount stub or environment in the merged image;
- separately document that a malicious Dockerfile can intentionally copy public CA bytes and that this is
  untrusted output, not an IronCurtain escape;
- inject failure at staging, listener bind, chmod, mount, health, daemon readiness, image load, canary,
  network creation, activation, and attach; require listeners stopped and exact lease reconciliation;
- invoke the canary only with `--pull=false --network=none --no-cache` and an immutable already-loaded
  image reference; require registry and package ledger snapshots unchanged across success and failure;
- prove feature-off, `offline`, and `images` have absence, not a bound listener that denies.

The deterministic `packages` qualification runs the snapshot-file portion through one exact root-only
internal probe because RootlessKit snapshot ownership is not readable by the outer `codespace` user. The
ordinary probe remains unprivileged. It brackets that internal probe with the initially admitted rootless
daemon identity, the exact fixed Docker data root, and unchanged full tracked container/image inventories;
immediately beforehand it requires the exact bounded `ic-dw-agent-<16 lowercase hex>` hostname, a
successful bounded `/usr/bin/getent ahosts` lookup for that hostname, and a silent successful
`sudo -n -- /usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/bin/true`. The selected Apple base includes
`libnss-myhostname` so that dynamic container hostnames resolve without a mutable per-session hosts-file
exception. Any resolver or sudo output failure remains fatal and no raw hostname or subprocess output is
reported.
The pinned Docker 29.2.1 embedded BuildKit 0.27.1 snapshot adapter is graphdriver-backed: its rootfs
snapshots reside in the admitted `vfs/dir`, not `buildkit/snapshots`. The internal probe therefore requires that
exact VFS root to be a real, non-symlink directory with at least one scanned regular file and applies the
complete recursive residue scan only there. It separately requires the exact real, non-symlink `buildkit`
root, a nonempty one-link bounded and stable `snapshots.db`, absence of the unsupported
`buildkit/snapshots` layout, and an exact real, non-symlink `buildkit/executor`. Executor quiescence rejects
every bundle directory, link, device, or unknown direct child; only pinned-source steady-state regular
`hosts`, `resolv.conf`, `resolv-host.conf`, and `runc-log.json` files may remain under per-file bounds and
stable descriptor checks. The exact `resolv-host.conf` is produced by BuildKit 0.27.1 for the required
`NetMode_HOST` package builds. BuildKit content and metadata are not rootfs snapshot trees and are not
recursively scanned. VFS regular files are screened for the exact per-session CA certificate, APT
configuration, build-trust contract, and matching CA private keys. Trust-path strings may legitimately
occur in the selected agent implementation; actual `dev/ironcurtain` path components and symlink targets
are rejected structurally instead. VFS entries are streamed under finite aggregate entry and depth bounds
from the exact root descriptor rather than collected by pathname. Every component is
validated before descriptor-relative no-follow metadata access; directories retain exact
before/open/after identities, symlinks retain exact identity around bounded byte-target reads, and regular
files are pinned with Linux `O_PATH|O_NOFOLLOW`, reopened only through the verified `/proc/self/fd` inode,
then rechecked through both descriptors and their parent. FIFO, socket, device, and unknown entry types
fail without a data open. Fixed nonleaking phase/errno, authority-input, PEM-parser, bound,
residue, and instability codes preserve primary causality over close errors. The helper's fixed argv, empty environment, deadline,
output bound, success
marker, and failure-code catalog are part of the test contract. It flushes a fixed stdout-only `BEGIN`
marker before any privileged work, then emits exactly one `OK` or allowlisted `ERROR` line. Each stream is
bounded to 128 bytes and their aggregate to 256 bytes; stderr, partial bootstrap, signals, output overflow,
unexpected status, and framing residue fail with fixed parent-side diagnostics that disclose no helper
bytes or process details.

The saved-image/archive proof retains its separate 4 GiB ceiling. VFS traversal admits at most 256 GiB of
logical regular-file bytes and 4,000,000 entries: retained replay of the selected image's complete VFS
layer snapshots measured 85,986,117,228 bytes and 1,489,147 entries, with depth 20 and zero private-key
candidates. The aggregate 300-second deadline, depth-256 limit, and 256-candidate limit remain unchanged.
Qualification form checks are base64-encoded into their Dockerfile `RUN` command and decoded directly to
`/bin/sh`; the build context therefore contains no separate file with the authority paths that the complete
VFS residue scan is specifically required to reject. The decoded check is not written into a layer, and the
saved-image proof still requires the form step to add only the canonical empty layer.
Archive bytes, VFS logical bytes, VFS entries, depth, and candidate exhaustion each reduce to an exact
fixed nonleaking failure code rather than a shared ambiguous bounds result.

This scan is deterministic qualification evidence, not a security attestation over a quiescent daemon.
The daemon and its running sibling are not frozen, and pathname traversal/per-file inspection is not
claimed to be TOCTOU-free. The stable-size, aggregate-bound, residue, inventory, and cleanup checks make
the selected live workflow falsifiable; they do not establish a continuous runtime invariant.

### 13.5 Live Apple workflow

The final no-LLM workflow uses an isolated IronCurtain home and exact retained results:

1. Before any pull in every mode, require outer-agent `127.0.0.1:18081` and `:18082` to refuse within a
   bound. From a `--pull never --network host` child based on the exact initial immutable image, require
   both exact health contracts in `packages`, only `18081` in `images`, and bounded connection refusal
   for both ports in `offline` and admission. Reassert empty containers and the unchanged one-image
   inventory after this disposable probe.
2. In `packages`, pull an absent public base through `18081`.
3. Pass version/hash qualification and the exact `--pull=false --network=none --no-cache` runc canary
   against the immutable already-loaded image before agent release, with both egress ledgers unchanged.
4. Build checked-in npm, pip, Debian apt, and Cargo fixtures through every supported direct Docker command
   and local-default Buildx. Verify exact versions/files and package audit records. `docker compose` builds
   fail with the documented shim message; direct plugin binaries and custom clients remain unsupported.
   Each supported-form trust check runs with `--no-cache --progress=plain`, and its exact BuildKit step
   must finish rather than report `CACHED`. Its output RootFS must be the authoritative fixture's exact
   layer prefix plus exactly one canonical 1024-zero-byte empty-tar diff layer
   (`sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef`). The later all-image
   `docker save` scan binds each selected image ID to its config, exact public-base prefix, diff-ID list,
   archive-layer order, and the added layer's exact empty bytes. It then scans dynamic public-authority
   markers globally and every build-added layer for `/dev/ironcurtain` entries or a complete bounded
   plaintext PKCS#1/PKCS#8 PEM private key whose derived SPKI equals the staged CA. An otherwise canonical
   bounded candidate missing only its footer is checked after reconstructing that matching public footer;
   unrelated complete keys inherited from the pinned base are not provisioning, and the public-only mount
   allowlist remains the primary non-provisioning proof.
5. Prove arbitrary `curl https://example.com`, private/authenticated repositories, POST bodies,
   credentials, unknown repository paths, alternate ports, mismatched SNI/Host, metadata/LAN/local
   addresses, and direct public DNS/IP attempts contact no forbidden upstream.
6. From the outer shell over the mounted package UDS and from a host-network inner container over
   `127.0.0.1:18082`, repeat one allowed package request and one denied request, proving bundle-wide scope
   without exposing the relay in the outer namespace or broadening policy.
7. Inspect every exported fixture image and transient BuildKit state per §13.4.
8. Repeat a build to observe an expected cache hit with no new proxy audit, then start a new session and
   prove the old daemon/cache root cannot be reused.
9. In `images`, prove the public base pull works, then require an uncached fixed-package `RUN` to fail with
   the exact BuildKit `network bridge not found` result; no package socket/relay/wrapper exists. In
   `offline`, prove public pulls fail, require the same exact default-network absence, then build a preloaded
   hermetic image with `--network=none`. Both offline builds use the selected image's single bounded, grammar-validated
   local reference, re-resolved to the already admitted immutable image ID, so BuildKit never interprets a
   bare digest as a registry name.
10. After each mode require closed exact leases, two separated empty inventories, immutable outer-ID
    absence, state-root absence, no listener UDS, and successful next admission.

Every CI lane runs the non-skipping purpose-built Node relay qualification from the checked-in asset baked
into the immutable selected agent image. The production CLI admits only the exact `images` and `packages`
profiles; the qualification exercises held-open and write-half-closed requests, large fragmented responses,
backpressure, both health contracts, rejection, shared concurrency and byte/time ceilings, UDS identity
replacement, all-or-rollback listener binding, shutdown, and connection cleanup. Bootstrap readiness uses
the same relay's fixed probe mode and deliberately keeps the TCP write side open while requiring the exact
health response and clean EOF. This hermetic qualification does not replace the production-exact Apple
gate: the live workflow still executes the baked relay in the real RootlessKit/Apple mount topology and
proves both relay health contracts and the four-mode listener matrix.

## 14. Staged implementation and retirement

The authority transition landed atomically and fail closed. The superseded generic `public` listener was
removed before `packages` became reachable. The current tree contains only the dedicated package proxy,
CA, wrapper, shim, and lifecycle described here; compatibility `public` narrows to `packages` and cannot
select the removed generic authority.

1. **Design and removal gate — complete:** generic product construction and claims were removed.
2. **Proxy core — complete:** fixed grammars, MITM, address/redirect policy, ledger, and adversarial tests
   are product-wired.
3. **Wrapper core — complete:** the static pinned Go runc wrapper, OCI patcher, public trust/apt artifacts,
   generated diagnostics, and hostile filesystem/spec tests are checked in.
4. **Developer qualification gate — complete:** npm/apt/pip/Cargo, direct/default-Buildx forms,
   load-before-canary, and image/VFS residue checks are implemented in the deterministic Apple workflow.
5. **Atomic product integration — complete:** migration, CLI/web warning, shared batch/PTY lifecycle, and
   Compose/alternate-selector rejection landed together.
6. **Docker Desktop developer release qualification — complete:** the fixed suite plus real built-CLI
   feature-off, crash-recovery, PTY/Claude-TUI, offline, images, and packages gates pass with zero skips.
7. **Preview qualification — open:** full G1-G10/0C reruns for both macOS backends remain separate.

Retire the generic `public-network-proxy` product path, ClientHello-only opaque CONNECT behavior, and
`networkAccess: "public"` output. Reusable reviewed address-policy and ledger modules may remain under
package-specific names/contracts. The Docker Hub/GHCR listener on `18081`, selected-current image
transport, current Docker Desktop fixed-relay work, scanner work, and the already removed
`ironcurtain-dockerfiles` catalog/source-pin stack remain separate.

No stage may temporarily expose standard `MitmProxy`, wildcard passthrough, or generic CONNECT as the
package authority. No live success is recorded until exact reconciliation completes.

## 15. Design decisions and rejected alternatives

### Accepted

- Three explicit modes: `offline`, `images`, and recommended `packages`.
- Conservative old registry migration to `images`; superseded broad `public` narrows to `packages`.
- A dedicated TLS-terminating package proxy with fixed repository grammars, no provisioned credentials or
  request bodies, and hard rejection of recognized credential fields.
- Bundle-wide package authority with explicit bounded-exfiltration and untrusted-content warnings.
- PATH-interposed runc only as a pinned, startup-qualified compatibility seam; host proxy policy remains
  the authority.
- Public trust mounted beneath OCI `/dev` tmpfs with fixed client env/apt config and residue gates.
- Fresh disposable per-session cache plus an explicit cache/content-admission nonclaim.
- Separate registry-image and package listeners, ledgers, health markers, relays, and lifecycle evidence.

### Rejected

- **Generic end-to-end CONNECT/public mode:** admits arbitrary public destinations and opaque application
  traffic, far more authority than ordinary package installation needs.
- **Standard `MitmProxy` package mode:** contains dynamic/wildcard passthrough and unknown-path forwarding,
  provider/control complexity, and no package-specific ledger contract.
- **Build-only identity:** the daemon, outer shell, host-network containers, and mounted relay collude.
- **Docker runtime selection as security policy:** the guest owns its daemon and may bypass/restart it;
  only the host proxy constrains egress.
- **BuildKit secret in each Dockerfile:** secure when explicitly used, but fails the ordinary-Dockerfile
  usability goal.
- **System-CA-file replacement:** creates base-image and layer-mountpoint risk; `/dev` tmpfs injection is
  the qualified target.
- **Persistent cache with runc-only invalidation:** runc runs after cache selection and cannot enforce a
  policy generation.
- **Private/authenticated package sources:** forwarding or injecting credentials creates a materially
  different authority and needs a separate design.
- **A user-editable package host list:** recreates the configuration maze and general egress by another
  name.
- **Restoring a default bridge, NAT, RootlessKit uplink, host loopback, or `-p`:** bypasses mediation.
- **Retaining `ironcurtain-dockerfiles`:** preserves obsolete source-authority claims and review burden.

## 16. Review checklist

These boxes record the landed developer implementation and current-tree coverage. They do not assert
backend 0C/G1-G10 or preview qualification; those open release gates are recorded in §13 and §14.

- [x] Canonical modes are only `offline`, `images`, and `packages`; new config never writes `public`.
- [x] Fresh CLI/web enable writes `packages`; no-choice disabled display does not backfill; old
      public-registry maps to `images`, preloaded-only to `offline`, and superseded `public` narrows to
      `packages`.
- [x] The exact shared package warning is adjacent to both selectors, which are noninteractive while
      disabled.
- [x] `offline` and `images` have no package listener, mount, relay, wrapper, canary, shim config, or
      package orientation.
- [x] Registry images stay on `18081`; fixed package MITM stays on `18082` with a distinct charged health
      contract.
- [x] The package listener has no standard-mode, wildcard, dynamic host, provider, control, credential,
      opaque tunnel, or fallback path.
- [x] CONNECT, SNI, inner Host, fixed hostname, and port 443 are exactly equal; apt HTTP is the only port
      80 route and re-originates fixed-host HTTPS.
- [x] Only GET/HEAD, body-free requests with no recognized credential field and with synthesized or
      canonicalized headers matching parsed fixed package grammars reach upstream; bounded path/metadata/
      timing exfiltration remains explicit.
- [x] Redirect and derived metadata authority remains within exact same-ecosystem host/path templates.
- [x] DNS/address screening and actual connection use the same answer; special/transition/current-host
      identities and inventory failure contact no upstream; public hairpin/relay remains an explicit
      nonclaim.
- [x] Attempts including health and failures, concurrency, bytes, time, parser state, logs, abort, and
      shutdown are bounded and counted exactly once; derived requests obey the exact 2-per-client,
      8-concurrent, and 24-combined-upstream limits.
- [x] Concurrent CA creation/load is lock-serialized under the trusted owner-only parent, uses no-follow
      leaf files plus one atomically published hash manifest, and fails closed for partial, mismatched,
      unsafe, or stale generations; the same-UID host race nonclaim remains explicit.
- [x] Host CA private key passes certificate/key-pair validation and never crosses into guest artifacts:
      persisted outer-create evidence admits only the exact public package-build mount allowlist and no CA
      directory/key source, the public staging contract names only cert/bundle/apt inputs, and every
      build-added layer plus every regular VFS graphdriver snapshot file observed during the bounded
      traversal rejects a complete plaintext PKCS#1/PKCS#8 PEM private-key candidate within the 128 KiB
      CA source bound whose public SPKI equals the staged CA. An otherwise canonical bounded candidate
      missing only its footer is checked after reconstructing that matching public footer; lone headers,
      prose, malformed bodies, other incomplete text, and oversized text are outside this identity check. A closed child
      directory can change later without changing an ancestor, so this qualification does not claim a
      quiescent snapshot; unrelated keys inherited from pinned public bases are permitted.
- [x] Static wrapper and exact real runc are read-only, hashed, version-pinned, path-confined, collision-
      rejecting, atomic, and fail closed for unknown BuildKit launch shapes.
- [x] Checked no-network and host-network OCI summaries map to all parser-enforced structural fields;
      only host mode's missing pathless `network` namespace differs, and omitted seccomp/non-`/dev`
      details are preserved without a byte-frozen claim.
- [x] Trust mounts live below OCI `/dev` tmpfs; representative successful/failed/exported images and
      snapshots contain no automatic injected CA, env, config, CA-matching private key, or mount-stub
      residue, with exact dynamic public-authority markers screened globally. The privileged snapshot
      scan is deterministic qualification evidence, not a quiescent or TOCTOU-free security attestation.
- [x] Startup version qualification, relay health, and no-network BuildKit canary pass before agent
      release; the canary uses exact `--pull=false --network=none --no-cache`, an immutable already-loaded
      image reference, and leaves both egress ledgers unchanged; failure never restores generic network.
- [x] Cache hits are explicitly outside package revalidation/audit; daemon data root is fresh per session,
      and persistent cache would require a new gate.
- [x] Docker shim affects only supported direct/default-Buildx builds, preserves `--network=none`, and
      rejects Compose and every alternate selector it receives; direct plugin/custom clients are plainly
      unsupported and uninterposed.
- [x] Generic public construction/admission is removed before package modules exist; package modules stay
      unreachable until the final gate atomically exposes them, and no compatibility path maps to the old
      listener.
- [x] Batch, workflow, and PTY share exact creation, canary, activation, and cleanup helpers.
- [x] Functional spike and later reconciliation evidence are cited separately; no raw result is called a
      clean green run.
- [x] The deterministic Apple packages/images/offline workflow, hostile proxy/wrapper tests,
      layer/snapshot residue scans, and exact cleanup pass for developer admission. Docker Desktop's
      no-skip suite and feature-off/crash/offline/images/packages product-entrypoint gates pass; broader
      preview residue and multi-client reruns remain the separate §13/§14 work.
