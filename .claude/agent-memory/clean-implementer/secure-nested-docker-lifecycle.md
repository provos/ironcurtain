---
name: secure-nested-docker-lifecycle
description: Phase 0F Item 3 — docker-workload lifecycle orchestration (infrastructure.ts, watchdog-policy, bundle-cleanup, lifecycle-evidence) module map, frozen values, seams, test harness
metadata:
  type: project
---

# Secure nested Docker-workload lifecycle foundations (branch feat/secure-nested-runtime)

Phase 0F Item 3 of docs/designs/secure-nested-runtime-implementation-plan.md (§8.1–8.4).
Plan is authority; grep symbols below before assuming they still exist.

## Product wiring (Steps 6–7) — DONE (dead code behind the fuse)
All inert until 0C flips `assertDockerWorkloadImplementationAvailable` (config.ts): the fuse
throws in prepareDockerInfrastructure BEFORE admission runs, so `core.dockerWorkload` is always
undefined for real sessions. Where each step landed (src/docker/docker-infrastructure.ts unless noted):
- §8.2 s1 admit: `admitDockerWorkloadForSession` helper, called in prepareDockerInfrastructure right
  after `createContainerRuntime` (before proxies). Bindings are PLACEHOLDER namespaced sha256 of
  dockerWorkloadConfigHash — real qualification record is 0C's job (flagged). Template=config/docker-workload/
  resource-watchdog-policy.json, entrypoint=dist/docker-workload/resource-watchdog-supervisor-main.js.
- §8.2 s3 attest: `await dockerWorkload?.attestWatchdog()` first stmt inside the post-proxy try (attest
  failure leaves an `admitting` lease for reconciliation — proxies cleaned, lease NOT torn down).
- §8.2 s1 ledger + s4 gate: exported `ledgerOuterResourceCreate(handle,spec,create)` — requestOuterResource→
  create(name,mergedLabels)→observed(id,expanded); WATCHDOG_GATED_OUTER_ROLES={'nested-daemon'} calls
  assertWatchdogFresh() FIRST. Used for the AGENT container in createSessionContainersAttempt + pty-session.ts.
- §8.2 s4 activate + §8.3 error teardown: EXTRACTED `assembleDockerInfrastructure(core,config,options)` from
  createDockerInfrastructure (which now just prepare+delegate). activate() after provisionWorkflowDependencies
  before return; catch runs `core.dockerWorkload.teardown()` FIRST else cleanupContainers. This is the testable
  seam (drive with a scripted core + harness handle; no real proxies).
- §8.3 destroy: destroyDockerInfrastructure + pty-session finally both branch `if(dockerWorkload) teardown()
  else cleanupContainers()`. ownsInfra:false never calls destroy → never teardown (docker-agent-session close
  unchanged; test in docker-session.test.ts ownsInfra describe).
- §8.4 metadata: exported pure `dockerWorkloadSessionMetadata(handle,configHash,backend)`; wired in
  createStandaloneSession AFTER infra (load+merge+save — tuple only known post-admission).
- SCOPED OUT (flagged): tcp-sidecar sidecar + internal-network ledgering. Both supported backends resolve to
  `uds` (agent container is the ONLY outer create); tcp-sidecar is macOS-Docker-Desktop, not a nested-Docker
  backend, and is fuse-blocked. Ledgering the network needs reshaping createIronCurtainInternalNetwork
  (hardcoded name/labels, returns no id). ledgerOuterResourceCreate is role-generic so they plug in later.
- Tests: test/docker/docker-workload-wiring.test.ts (drives prepare→create→destroy via harness handle +
  scripted core, uds mode); fuse test extended in docker-workload-admission.test.ts (prepareDockerInfrastructure
  throws at fuse, empty IRONCURTAIN_HOME). GOTCHA: mocks of '../src/docker/docker-infrastructure.js' (e.g.
  docker-session-factory.test.ts) must add `dockerWorkloadSessionMetadata` to the vi.mock factory.

## Bindings taxonomy: RUNTIME controls vs RELEASE artifacts (corrected 2026-07-24)
`DockerWorkloadAdmissionBindings` (infrastructure.ts) and the lease `bindings` z.object
(bundle-lease.ts) bind ONLY OPERATIONAL inputs: catalogSha256, profileSha256,
toolchainDigest (+ watchdogPolicySha256, stamped at render time
by admission — callers never pass it). A qualification contract is a RELEASE artifact (a
frozen test plan), NOT a runtime security control: `qualificationContractSha256` was
carried in both of those and NEVER verified at runtime — a provenance label wearing the
costume of a control. It was removed from the whole admission/lease path.
It legitimately survives in exactly ONE place: `qualification-evidence.ts` (the EVIDENCE
record's pointer to the qualification that blessed a run) + its test + the harness's
`EVIDENCE_BINDINGS` fixture. Grep-invariant worth re-checking: `qualificationContractSha256`
must appear ONLY in those three spots — never in infrastructure.ts / bundle-lease.ts /
docker-infrastructure.ts.
Related defect removed at the same time: `configHash` was optional on
`DockerWorkloadAdmissionOptions` and fell back to `bindings.qualificationContractSha256`
(a test-plan hash standing in as a config identity). It is now REQUIRED; every caller
passes a genuine hash (`dockerWorkloadConfigHash(...)` in product, `ADMISSION_CONFIG_HASH`
in the harness). Keep it required — the fallback is the bug.

## Module map (src/docker-workload/ unless noted)
- bundle-cleanup.ts — frozen helpers assertExactTargetIdentity, removeExactBundleState,
  assertSafeCleanupPath, captureCleanupProof, toWatchdogCleanupProof. EXTRACTED verbatim from
  resource-watchdog-supervisor.ts so supervisor-trip, coordinator-teardown, reconcile share ONE order.
  Supervisor now imports them; no test referenced them (were private).
- watchdog-policy.ts — loadFrozenWatchdogPolicyTemplate(path) + renderWatchdogPolicy(template,stateRoot,outputPath).
  Template (config/docker-workload/resource-watchdog-policy.json) OMITS per-session targetRoot/device/inode;
  render stat()s state root, stamps them, writes 0o400, returns LoadedResourceWatchdogPolicy (reuses
  loadResourceWatchdogPolicy for cross-field validation). lease.bindings.watchdogPolicySha256 = sha256 of
  RENDERED file; template sha256 separate. Frozen consts: HEARTBEAT 5s, STALE 30s, RECOVERY_BOUND 120s,
  WATCHDOG_STARTUP_TIMEOUT 30s.
- infrastructure.ts — admitDockerWorkloadBundle(opts)->DockerWorkloadBundleHandle (reconcile-under-lock ->
  create state subtree -> render policy -> create lease). Handle: requestOuterResource(kind,role)->grant{
  requestedName,labels,observed()}, attestWatchdog(), assertWatchdogFresh(), activate(), teardown().
  Module fn reconcileDockerWorkloadLeases(opts). MUST NOT import config.ts/assertDockerWorkloadImplementationAvailable
  (guard test scans source).
- lifecycle-evidence.ts — DockerWorkloadAuditSink (zod discriminated union, 8 events: admission-decision,
  outer-create, watchdog-attested, lease-transition, revocation-result, cleanup-proof, incident,
  resource-enforcement), JSONL+recording sinks, sealLifecycleEvidence(dir,opts) writes artifacts + two empty
  cleanup inventories then calls UNCHANGED writeQualificationEvidenceManifest. Exports DockerWorkloadAuditEventPayload
  (distributive Omit of at/leaseId/generation envelope).
- src/config/paths.ts — added getDockerWorkloadRoot/LeasesRoot/LeaseDir(leaseId)/StateRoot(leaseId).
  INVARIANT: control tree docker-workload/leases/<id>/ and revocable state tree docker-workload/state/<id>/
  are SIBLINGS (supervisor refuses control files inside deletable state root). leaseId validated path-safe.
- src/session/{types,index}.ts — SessionMetadata gained optional dockerWorkload{leaseId,generation,configHash,
  watchdogPolicySha256,backend}; applyResumeMetadata throws SessionError when present (ephemeral daemonState = not resumable).

## Frozen watchdog template values
hardSafetyBytes 8 GiB, soft 4 GiB, hostReserve 2 GiB,
maxOvershoot 1 GiB, sampleInterval/Timeout 5s, staleAfter 30s, cleanupInventoryGapMs 500, stateClasses
daemon/api/exchange/staging all required:false (avoids teardown-race trip on a transiently-absent subdir).

## Non-obvious mappings/subtleties
- lease.paths.runtimeRoot = <stateRoot>/daemon (watchdog 'daemon' class); apiRoot/exchangeRoot/stagingRoot =
  <stateRoot>/{api,exchange,staging}. removeExactBundleState nukes all + stateRoot.
- teardown & reconcile share performExactRevocationAndCleanup. teardown dead-supervisor fallback =
  coordinator closeDockerWorkloadLease + MANDATORY audit incident{code:'watchdog-supervisor-lost'} (close+audit,
  NOT fence). teardown idempotent + retries on /is busy/ via injected sleep.
- reconcile live = coordinator pid alive AND heartbeat<staleHeartbeatMs, OR fresh supervisor status. Recovery
  bound starts after listContainers() answers; exceeding it fences (status 'incident') and BLOCKS new admission.
  Networks ledgered only for runtimeKind 'docker'.

## Same-VM nested daemon (plan §4.4 variant 1) — src/docker-workload/apple-vm-daemon.ts
Decision 2026-07-29 (user-approved): on Apple `container` the rootless dockerd runs INSIDE the
agent's per-session VM; API is a VM-local UDS, never published outside the VM (§5.3). Sibling-VM
rejected. Module = pure logic + injected `AppleVmDaemonExec` (argv, {user, timeoutMs}) which the
wiring layer adapts from `ContainerRuntime.exec`; NO direct spawn, no pipeline import, no fuse
import (guard test scans the source, same idiom as infrastructure-fuse-guard.test.ts).
- Exports: bootstrapAppleVmDaemon(exec) [API-dir MODE CHECK then start, BOTH as codespace —
  NO root exec anywhere in the daemon lifecycle], waitForAppleVmDaemonReady(exec,{timeoutMs,
  pollIntervalMs?,now?,sleep?}) -> {driver,securityOptions,serverVersion,readinessMs}. Frozen argv
  constants APPLE_VM_DAEMON_{API_DIR,SOCKET,DOCKER_HOST,TOOLCHAIN_DIR,LOG_PATH,DATA_ROOT,
  DOCKERD_COMMAND,API_DIR_STAT_ARGV,API_DIR_EXPECTED_STAT,START_ARGV,INFO_ARGV,LOG_TAIL_ARGV,
  READINESS_TEXT_BOUNDS}.
- Live-proven constraints baked in (do NOT "simplify"): no dockerd-rootless.sh in docker 29.x — the
  direct `rootlesskit --net=none --disable-host-loopback --copy-up=/etc --copy-up=/run dockerd …
  --storage-driver=vfs --iptables=false --bridge=none` form is the only one; the start script's PATH
  puts /usr/bin BEFORE the toolchain dir so the base image's privileged newuidmap beats the
  toolchain's unprivileged copy; `--net=none` still needs iproute2 for loopback.

### The clamped bounding set dictates the base image (live gate, 2026-07-29)
The agent VM is created `--cap-drop ALL --cap-add CAP_SETUID --cap-add CAP_SETGID` (CapBnd 0xc0).
Two consequences that are NOT negotiable and that the base image — not the runtime — must satisfy:
1. **newuidmap/newgidmap must be file-capped, NOT setuid-root.** Writing a multi-range
   /proc/PID/uid_map needs CAP_SYS_ADMIN *in the target userns*; the kernel grants ALL caps in a
   userns to a process whose euid owns it (`cap_capable`). rootlesskit makes the ns as uid 1000, so
   a helper at euid 1000 inherits the grant. Debian's `uidmap` package ships them 4755 → euid 0 →
   grant forfeited → needs real CAP_SYS_ADMIN → `newuidmap: write to uid_map failed: Operation not
   permitted`. CAP_DAC_OVERRIDE does NOT fix it; CAP_SYS_ADMIN is off-limits (blows the frozen P1
   ceiling). Fix in Dockerfile.base.arm64: install `libcap2-bin`, `setcap cap_setuid+ep`/
   `cap_setgid+ep`, and `chmod u-s` — dropping setuid is REQUIRED, with both present the setuid bit
   still raises euid and re-breaks it. Matches the frozen nested-daemon alpine image (755 + file
   caps, verified via layer xattrs); file caps survive `docker save` → `container image load`.
2. **No CAP_CHOWN ⇒ the API dir cannot be created at runtime.** `install -d -o 1000 -g 1000 -m 0700
   /run/ironcurtain-docker` fails `Operation not permitted`. `/run` is ext4 in the VM (NOT tmpfs),
   so an image-time dir persists — the image already relies on this for /run/ironcurtain. Base
   image pre-creates it 0700 codespace; bootstrap MODE-CHECKS it (see below).
Guard: test/docker/base-image.test.ts asserts libcap2-bin + the setcap/chmod-u-s trio + the 0700
install line, and NEGATIVELY that the only non-comment lines naming new[ug]idmap are those three
(so setuid can never be re-added). Mutation-checked.
- Detach idiom: `exec </dev/null >…/dockerd.log 2>&1` replaces the SHELL's fds before forking so the
  daemon never inherits the exec pipes — otherwise `docker exec`/`container exec` blocks on EOF.
- **API-dir precondition is a no-follow MODE CHECK, never `test -w`** (§5.3 "mode-checked"; hardened
  2026-07-29 after an adversarial review). `test -w` FOLLOWS SYMLINKS: the agent is root in its own
  container (NOPASSWD sudo) and workflow snapshot-resume commits that layer, so it can `rm` the
  root-owned dir out of `/run` (uid 0 owns `/run`, no capability needed) and plant a symlink to a
  host-backed VirtioFS mount like `/workspace` — dockerd then writes docker.sock/dockerd.log onto
  the host. It CANNOT forge the real thing: mkdir gives 0:0 and chown needs the absent CAP_CHOWN.
  Frozen argv `['/usr/bin/stat','-c','%F:%u:%g:%a','/run/ironcurtain-docker']`, expected stdout
  EXACTLY `directory:1000:1000:700`. Verified on debian trixie: correct dir → that string; planted
  symlink → `symbolic link:0:0:777` with EXIT 0 (so compare stdout, never the exit code alone);
  missing → exit 1, empty stdout. `stat` DEFAULTS to not dereferencing (`-L` opts in). Error is
  "API directory … failed its mode check: expected \"…\", observed \"…\"".
- Readiness is an ADJUDICATION, but the retry discriminator is **"did the DAEMON answer"**, not the
  exit code. `docker info --format '{{json .}}'` can exit 0 with a client-only skeleton (empty
  Driver/ServerVersion + `ServerErrors`) — that is liveness, so it RETRIES to the deadline. Only a
  populated server block is adjudicated, once (Driver!=='vfs', SecurityOptions missing
  'name=rootless' — fail closed immediately). Unparseable JSON stays permanent. Consequence: a
  payload missing ServerVersion now RETRIES; the "malformed fields" test must use a payload with a
  populated server block and a bad SecurityOptions element.
- **All in-VM text is bounded at this seam.** `APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS` (driver 128,
  serverVersion 128, securityOption 256, count 64) is EXPORTED and `lifecycle-evidence.ts` builds
  the `daemon-ready` zod `.max()` from it — so the runtime edge is lifecycle-evidence →
  apple-vm-daemon (NOT the reverse; apple-vm-daemon still imports only zod, and madge is clean).
  Without this an oversized serverVersion passed adjudication and threw at the audit emit later.
  Log tail is truncated to a 4096-BYTE budget with control chars stripped (`tail -n 80` bounds
  lines, not bytes, and the exec adapter's maxBuffer is 50 MB).
- lifecycle-evidence `daemon-ready` = {attestation, driver, securityOptions[], serverVersion,
  readinessMs} + envelope. `attestation: z.literal('bundle-local-advisory')` (exported as
  `DAEMON_READY_ATTESTATION`) is REQUIRED and stamped by `recordDaemonReady`, mirroring the
  `bindingsProvenance` idiom: the readiness probe talks to a bundle-local UDS an in-VM party can
  answer (§4.2), so this record must not read like the host-OBSERVED watchdog-attested/cleanup-proof
  events it sits beside. The readiness return type stays field-compatible with the rest of the payload.
- `--data-root=/home/codespace/.local/share/docker` is EXPLICIT in the frozen dockerd command (it is
  also what rootless dockerd would derive from the exported HOME, so runtime behavior is unchanged) —
  §8.2.1/§8.3.4 want an exact ledgerable/removable state path. Exported as APPLE_VM_DAEMON_DATA_ROOT.
- Timeout source: caller passes `APPLE_VM_DAEMON_READINESS_TIMEOUT_MS` (90000, session-daemon.ts) —
  a plain reviewed constant since the performance budget was deleted (2026-07-30, plan §16.11).

## Base-image Docker toolchain layer (hardened 2026-07-29)
- `COPY --from` PRESERVES SOURCE OWNERSHIP. In the pinned `docker@sha256:67c4114…` stage
  `rootlesskit` and `vpnkit` are owned **1001:1001** (verified by `ls -ln`); without
  `--chown=root:root` a Linux host that uid-remaps the agent to 1001 hands the runtime user
  ownership of shipped toolchain binaries. Both COPY lines now carry it.
- CLI plugins go to `/usr/local/libexec/docker/cli-plugins/`, NOT `/usr/local/lib/docker/cli-plugins/`:
  the copied `/usr/local/bin/docker-compose` is a symlink INTO the libexec path, so the lib path left
  it dangling. Both dirs are default CLI plugin search paths (both string-literals present in the
  29.2.1 `docker` binary; empirically `docker compose version` + `docker buildx version` resolve with
  plugins ONLY in libexec). Copying to libexec fixes the symlink AND keeps discovery.
- Catalog toolchain tuples: `base` AND all three agent roles declare `DAEMON_TOOLCHAIN` (agents are
  `FROM ironcurtain-base:latest`, so they inherit dockerd). `CLIENT_TOOLCHAIN` was DELETED as dead
  config. This matters because `admission-bindings.ts` binds `base.toolchainDigest` and
  `preflightClientToolchain` recomputes a digest from the LIVE client+daemon versions — a null
  `dockerDaemon` was a binding that could never match.
- Test hardening in test/docker/base-image.test.ts (all mutation-checked): `lnInvocations()` splits
  non-comment lines on `&&`/`||`/`;` and pins every `ln` command verbatim (the old `/\bln -s\s+/`
  missed `ln -sf`/`ln --symbolic` and could not see an ADDED symlink); `copyInstructions()` pins every
  COPY line (the old `^COPY\s+(--from=\S+)` skipped plain COPY entirely); and `declaredPathValues()`
  asserts the ENV PATH **value** excludes the toolchain bin dir (the ENV test collected names only).

## Re-freeze CASCADES: catalog → qualification contract
Re-freezing the preloaded catalogs changes `catalogSha256` (and, if a toolchain tuple moved,
`toolchainDigest`), which the FROZEN qualification contract binds. Symptom after a catalog-only
re-freeze: ~11 failures in test/docker-workload/qualification-artifacts.test.ts +
test/docker/qualification-contract.test.ts, all `qualification binding drift: catalogSha256`.
The contract must be re-frozen in the same supervised step — a catalog re-freeze is never complete
on its own.

## GOTCHA: editing docker/Dockerfile.base.arm64 breaks test/docker/docker-workload-egress.test.ts
config/docker-workload/build-egress-manifest.json hash-binds `docker/Dockerfile.base.arm64` (and the
preloaded catalogs record its sourceDigest). Any edit to that Dockerfile fails ~22 tests in
test/docker/docker-workload-egress.test.ts with `build-egress Dockerfile hash mismatch:
docker/Dockerfile.base.arm64` until the manifest (and catalog) are re-frozen. Diagnose by comparing
`git show HEAD:docker/Dockerfile.base.arm64 | shasum -a 256` against the manifest entry — do NOT
assume the failure came from whatever you were editing.

## Test harness (test/docker-workload/helpers/infrastructure-harness.ts)
useDockerWorkloadHome() sets IRONCURTAIN_HOME to per-test 0o700 tmpdir (paths.ts reads it live).
createFakeClock(baseIso, jumpPerSleepMs?): sleep ADVANCES time — required so the two cleanup inventories differ
by >= gapMs (fixed clock => closeDockerWorkloadLease throws 'not sufficiently separated'). Recovery-bound test
uses jumpPerSleepMs=130_000 to cross frozen 120s during captureCleanupProof sleep. createEventRuntime proves
ledger-append precedes create via setLeasePath. createFakeSupervisor({launch,statusMode,alive,closeLeaseOnStop});
reconcile-stale tests use statusMode:'absent'. Busy-retry test pre-creates ${leasePath}.lock via holdLeaseLock;
injected sleep removes it on first call.
