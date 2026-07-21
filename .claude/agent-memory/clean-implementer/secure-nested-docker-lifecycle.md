---
name: secure-nested-docker-lifecycle
description: Phase 0F Item 3 — docker-workload lifecycle orchestration (infrastructure.ts, watchdog-policy, bundle-cleanup, lifecycle-evidence) module map, frozen values, seams, test harness
metadata:
  type: project
---

# Secure nested Docker-workload lifecycle foundations (branch feat/secure-nested-runtime)

Phase 0F Item 3 of docs/designs/secure-nested-runtime-implementation-plan.md (§8.1–8.4).
Plan is authority; grep symbols below before assuming they still exist. Steps 6–7 wiring
(src/docker/docker-infrastructure.ts + pty-session.ts) is a SEPARATE follow-up, out of scope here.

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
