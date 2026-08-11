---
name: nested-daemon-part3-wiring
description: Same-VM nested Docker daemon Part 3 product wiring — watchdog-gate generalization, backend fail-closed, real vs placeholder admission bindings, PTY-vs-batch bootstrap ordering
metadata:
  type: project
---

# Nested daemon Part 3 (wiring) — branch feat/secure-nested-runtime

Topology (user-approved 2026-07-29): on Apple `container` the rootless dockerd runs INSIDE the
agent's own per-session VM. There is NO separate daemon container — the **agent container create IS
the §8.2 step-4 daemon-component create**. Socket is VM-local, never published.
Still dead code behind `assertDockerWorkloadImplementationAvailable` (config.ts untouched).

## Watchdog gate: declaration, not role
`WATCHDOG_GATED_OUTER_ROLES` ({'nested-daemon'}) was kept for roles that are intrinsically the
daemon component, but the gate predicate is now
`launchesNestedDaemonComponent(spec) = spec.launchesNestedDaemon === true || ROLES.has(spec.role)`
(docker-infrastructure.ts). `LedgeredOuterCreateSpec.launchesNestedDaemon` is the new opt-in flag.
Do NOT add 'agent' to the role set — an ordinary session's agent create must stay ungated.
`createLedgeredAgentContainer` DERIVES the flag (never accepts it) from `dockerWorkload` +
a new required `runtimeKind` option, so neither session mode can forget it.

## Backend fail-closed at two layers
`src/docker-workload/session-daemon.ts` (grep the exact name — it has been
`assertNestedDaemonBackendQualified` and `assertNestedDaemonBackendImplemented`):
- `assertNestedDaemonBackendImplemented(kind)` — throws unless `apple-container`
  ("not implementation-qualified on the <kind> backend").
- `resolveNestedDaemonBundle(handle, kind)` -> handle | undefined; returns undefined with no
  handle, THROWS for handle+non-apple. Returning the handle (not a boolean) gives TS narrowing and
  keeps "daemon applies" and "which handle" from disagreeing.
Called at admission (`admitDockerWorkloadForSession`, before any lease exists) AND at the create
site. CONSEQUENCE: `docker` runtimeKind + a handle is now an impossible state — the pre-existing
`test/docker/docker-workload-wiring.test.ts` harness had to move to `runtimeKind: 'apple-container'`
(both the `admitDockerWorkloadBundle` call and `makeCore`).
When a Docker sibling-container variant is ever qualified, change the ASSERT, and give
`resolveNestedDaemonBundle` a topology branch — the throw is about qualification, not topology.

## Admission bindings: 3 real, 1 placeholder
`src/docker-workload/admission-bindings.ts` replaced `placeholderAdmissionBindings`:
- `catalogSha256` = `loadPreloadedImageCatalog(catalogPath).sha256` (REAL)
- `toolchainDigest` = the `ironcurtain-base:latest` role's `toolchainDigest` (REAL; base role
  because the daemon toolchain is staged by the base image and it is the role the qualification
  contract binds — see qualification-artifacts.ts)
- `profileSha256` = sha256 of `config/docker-workload/profile-ceiling.json` via `readHardenedFile`
  (REAL; new `getFrozenProfileCeilingPath()` in docker/docker-workload-paths.ts)
- `performanceBudgetSha256` = DELETED (2026-07-30, plan §16.11). It was the LAST placeholder.
- `bindingsProvenance` is therefore now `'qualified'`: `PLACEHOLDER_ADMISSION_BINDING_FIELDS` is an
  empty `readonly (keyof DockerWorkloadAdmissionBindings)[]` and provenance is DERIVED from it via
  `admissionBindingsProvenance(fields = PLACEHOLDER_ADMISSION_BINDING_FIELDS)` — the weakest field
  still decides, so re-listing a field demotes the whole set again. `placeholderBinding()` is kept,
  unused, as the mechanism. `resolveDockerWorkloadAdmissionBindings` no longer takes `configHash`
  (it only ever namespaced the placeholder); `admitDockerWorkloadBundle` still does.
Catalog path comes from `imageProvisioningForConfig(...).catalogPath` — the SAME mapping that
later picks the image, so lease hash and loaded archive cannot diverge.

## Readiness timeout is a duplicated constant (deliberate)
`APPLE_VM_DAEMON_READINESS_TIMEOUT_MS = 90_000` in session-daemon.ts mirrors the frozen budget's
`maxima.daemonReadinessMs` for the same test-tree/shipping reason. A guard test in
`test/docker/nested-daemon-wiring.test.ts` reads the budget JSON and asserts the two agree.

## PTY vs batch bootstrap ordering (real asymmetry — do not "fix")
- Batch (`createSessionContainersAttempt`): bootstrap runs after start + apt-proxy + connectivity
  checks, before the return; agent processes are exec'd much later, so it is genuinely
  "between container start and agent launch".
- PTY (`runPtySessionAttempt`): the container COMMAND is the agent launcher, so the agent is already
  running when the bootstrap executes. Placed after start/apt-proxy, before `waitForPtyReady`/attach.
  Safe because the VM-local socket does not exist until bootstrap creates it. PTY's
  `dockerWorkload.activate()` stays BEFORE `docker.start` (unchanged shipped ordering); batch
  activates in `assembleDockerInfrastructure` AFTER the daemon is proven.
Heartbeat note: a ≤90s bootstrap can outrun the 30s coordinator-heartbeat bound before `activate()`
starts the timer; `isLeaseLive` still reports live via the fresh supervisor-status branch.

## Evidence
`DockerWorkloadBundleHandle.recordDaemonReady(readiness)` (infrastructure.ts) is the only emitter of
the `daemon-ready` event — it stamps the at/leaseId/generation envelope. infrastructure.ts
type-imports `AppleVmDaemonReadiness` (type-only, no runtime edge); apple-vm-daemon.ts still does not
import lifecycle-evidence.

## Test harness additions
`test/docker-workload/helpers/infrastructure-harness.ts`: `createEventRuntime` now takes an
`exec` responder (default `respondHealthyAppleVmDaemon`, which answers any argv containing `info`
with `QUALIFIED_DOCKER_INFO` = vfs + name=rootless + 29.2.1) and records argvs in a separate
`execs` array — kept OUT of `events` so existing lifecycle-order assertions stay stable.
GOTCHA when scripting a bootstrap failure: `writeAptProxyConfigViaExec` also runs `sh -c` on the
apple-container path, so filter on `/run/ironcurtain-docker` rather than failing every exec.
Don't assert on apple-vm-daemon.ts's exact error strings from the wiring tests — that module was
being reworked concurrently (`install -d` root step became a `test -w` precondition probe); match
`/apple-vm daemon/` instead.

## prepareDockerInfrastructure failure teardown (§8.3) — reconciliation is NOT a catch-all
The catch in `prepareDockerInfrastructure` (docker-infrastructure.ts) now runs
`dockerWorkload?.teardown().catch(warn)` BEFORE the proxy/host-only-network cleanup.
Reason the old "crash reconciliation reclaims it" comment was false: `isLeaseLive`
(docker-workload/infrastructure.ts) reports live whenever the detached supervisor status is
fresh, the supervisor survives coordinator exit by design and never self-exits, and an
`admitting` lease with zero containers trips no ceiling — so reconciliation PRESERVES a
post-attestation leak forever. It IS true for attestation failure itself (the launcher kills the
rejected child → status goes stale). General rule for this subsystem: "reconciliation will get it"
only holds when something is guaranteed to kill the supervisor.
`teardown()` is safe with no supervisor: `supervisorPid` is only set after a 'ready' attestation, so
`stopWatchdogAndClose` takes the `supervisorGone` branch → `closeLeaseAsCoordinator` + a
`watchdog-supervisor-lost` incident. No containers exist yet at this point, so call `teardown()`
directly — NOT `destroyBundleOuterResources`, whose `releaseManagedResourceLease` belongs to
`createSessionContainers` (which prepare has not reached).

## imageProvisioningForConfig: concrete `backend` is a CONSTRAINT, not an override
`dockerWorkload.backend !== 'auto' && backend !== resolvedRuntimeKind` now THROWS (naming both
values, pointing at `containerRuntime`/`IRONCURTAIN_CONTAINER_RUNTIME`). The live `ContainerRuntime`
is built from `resolvedRuntimeKind` upstream, so letting `backend` pick the catalog handed it
another backend's immutable image IDs and hashed `catalogSha256` from a file the session never
loads. One check covers both image call paths AND `admissionCatalogPath`.

## Recipe: driving prepareDockerInfrastructure in a test
`test/docker/docker-workload-prepare-failure.test.ts` is the worked example (real admission + real
lease + real teardown; only process-level injectables faked). The mock set that gets you from the
top of prepare to the post-attestation try block:
agent-registry (`getAgent` → adapter with `detectCredential` returning `{kind:'apikey'}` so host
credential/keychain detection never runs, and `getProviders: () => []` so no real-key resolution),
container-runtime (`resolveRuntimeKind` → 'apple-container', `createContainerRuntime` → harness
`createEventRuntime().runtime`), ca, code-mode-proxy, mitm-proxy, docker-workload/config
(fuse mocked open), docker-workload/admission-bindings, and docker-workload/infrastructure
(`importOriginal` + wrap `admitDockerWorkloadBundle` to inject harness clock/sleep/supervisor/
`startHeartbeat:false`, and to capture the handle for `leasePath` assertions).
GOTCHAS: on apple-container prepare `chmodSync`es BOTH the code-mode socket and the MITM socket
paths OUTSIDE the try — the proxy doubles' `start()` must `writeFileSync` those exact paths or you
get an ENOENT that never reaches the catch. `resolveNetworkTopology('apple-container')` is already
'uds', so network-topology needs no mock. Share doubles with the hoisted factories through a single
`vi.hoisted<Interface>()` seam object typed with an interface (optional fields + throwing default
factories) — `undefined as unknown` initializers trip
`@typescript-eslint/no-unnecessary-type-assertion`.

## Workload sessions are never resumable (both modes must agree)
- Batch path rejects at `applyResumeMetadata` (src/session/index.ts) when `SessionMetadata.dockerWorkload`
  is present. PTY path forces it at WRITE time instead: `resolveSnapshotResumability({conversationStateDir,
  dockerWorkloadAdmitted})` in `src/docker/pty-session.ts` is the single decision point feeding the
  snapshot's `resumable` field; the admitted-bundle handle (`dockerWorkload !== undefined`, already in outer
  scope for the finally block) is the marker. No snapshot-schema field and no new `validateResumeSession`
  branch — legacy workload snapshots cannot exist while the admission fuse is closed. The refusal reason
  rides the log line only (`SessionSnapshot['status']` is a closed enum).
