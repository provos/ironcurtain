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

Re-freezing `config/docker-workload/qualification-contract.apple-rootless-vfs.arm64.json`: compute
the hash by loading it through `loadQualificationContract` with an **absolute** path (the hardened
loader rejects relative paths and group/world-writable or symlinked files). Nothing else in the repo
pins that sha as a literal — `qualification-evidence.ts` takes `qualificationContractSha256` as a
schema field and the tests use synthetic hashes — so a re-freeze needs no downstream artifact edits.
