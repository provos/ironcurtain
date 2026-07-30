# Qualification contract binds test COUNT, not test names

`src/docker/qualification-contract.ts` `qualificationCommandSchema` has
`expectedTestFiles: string[]` + `expectedTestCount: number` — it deliberately does **NOT** enumerate
individual test names. An earlier revision carried `expectedTests: string[]` of
`file::fullName#occurrence` IDs (146 entries = 68% of the frozen JSON); that was removed on purpose
(user-approved simplification), not lost.

Rationale — do not "restore" the enumeration:

- The threat the gate must catch is a **silently deleted/skipped test** so a suite passes with fewer
  assertions. A count catches that; `verifyVitestQualificationRun` throws
  `qualification test count drift for <id>: expected N, ran M`.
- Test *renames* are not a security event — `bindings.sourceCommit` already pins the exact source
  tree the names came from, so the enumeration was duplicating a binding that already existed.
- The full per-test enumeration still exists: the runner persists the stock Vitest JSON report and
  the run record hashes it byte-for-byte (`vitestReport.{fileName,sha256,sizeBytes}`).
- Zero-skip/pending/todo/failed/snapshot checks and the exact `expectedTestFiles` set are unchanged
  and still fail closed — the count is an *additional* binding, not a replacement for those.

Invariants the schema enforces (superRefine): executable disposition (`required-pass` /
`backend-adapted-pass`) => non-empty argv + non-empty expectedTestFiles + `expectedTestCount > 0`;
non-executable => empty argv + empty expectedTestFiles + `expectedTestCount === 0`.

## `bindings` are verified against disk — keep it that way

`verifyVitestQualificationRun` compares `run.bindings` to `contract.bindings`, and the runner writes
the run record with `bindings: contract.value.bindings` (a straight copy). That check therefore only
proves a run record was not tampered with — on its own it is a contract compared with a copy of
itself. The missing half now lives in `src/docker-workload/qualification-artifacts.ts`:
`verifyQualificationArtifactBindings(contract, repositoryRoot)` recomputes every disk-derivable
binding and throws on the first mismatch. `scripts/qualify-backend.ts` calls it before running any
command (fail fast, no evidence dir created on drift).

- Verified: `catalogSha256` (raw-file sha256 of the platform's frozen catalog — `apple-container` →
  `preloaded-catalog.apple-container.json`, `docker-desktop` → `preloaded-catalog.docker.json`,
  `linux-docker` deliberately unmapped since no Linux-frozen catalog exists), `runtimeImageId` +
  `toolchainDigest` (from the catalog's `ironcurtain-base:latest` role), `profileSha256`,
  `watchdogSha256`, `buildEgressSha256`, `runtimeTrustSchema`. (The `performanceBudgetSha256`
  binding and the whole performance-budget artifact were DELETED 2026-07-30, plan §16.11 — a file of
  timeouts is not a security property under a trusted single-operator host. `FILE_HASH_BINDINGS` is
  now a module constant, not a function of the contract's variant/architecture.)
- NOT verified, on purpose: `publicCaSha256` (Node `rootCertificates`, version-scoped, not a repo
  file), `sourceCommit`/`dirtyPatchSha256` (git state — the driver WARNS on HEAD drift to stderr and
  keeps going, because the tree moves while the contract stays frozen), `relaySha256` (nullable, no
  committed binary).
- Raw-file sha256 == `sha256Hex(readHardenedFile(...))`, byte-identical to what
  `loadImmutableHostJson` reports; never hand-roll `createHash` over `readFileSync`.
- The artifact→binding mapping exists in ONE place. `test/docker/qualification-contract.test.ts`'s
  freeze guard just asserts `verifyQualificationArtifactBindings(...)` does not throw; the drift
  cases (each binding mutated on a deep clone) live in
  `test/docker-workload/qualification-artifacts.test.ts`. If those stop failing, the check has gone
  tautological again.

Re-freezing `config/docker-workload/qualification-contract.apple-rootless-vfs.arm64.json`: compute
the hash by loading it through `loadQualificationContract` with an **absolute** path (the hardened
loader rejects relative paths and group/world-writable or symlinked files). Nothing else in the repo
pins that sha as a literal — `qualification-evidence.ts` takes `qualificationContractSha256` as a
schema field and the tests use synthetic hashes — so a re-freeze needs no downstream artifact edits.
