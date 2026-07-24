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
performanceBudgetSha256, toolchainDigest (+ watchdogPolicySha256, stamped at render time
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
hardSafetyBytes 8 GiB (== performance-budget peakOwnedStateBytes), soft 4 GiB, hostReserve 2 GiB,
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

## Test harness (test/docker-workload/helpers/infrastructure-harness.ts)
useDockerWorkloadHome() sets IRONCURTAIN_HOME to per-test 0o700 tmpdir (paths.ts reads it live).
createFakeClock(baseIso, jumpPerSleepMs?): sleep ADVANCES time — required so the two cleanup inventories differ
by >= gapMs (fixed clock => closeDockerWorkloadLease throws 'not sufficiently separated'). Recovery-bound test
uses jumpPerSleepMs=130_000 to cross frozen 120s during captureCleanupProof sleep. createEventRuntime proves
ledger-append precedes create via setLeasePath. createFakeSupervisor({launch,statusMode,alive,closeLeaseOnStop});
reconcile-stale tests use statusMode:'absent'. Busy-retry test pre-creates ${leasePath}.lock via holdLeaseLock;
injected sleep removes it on first call.
