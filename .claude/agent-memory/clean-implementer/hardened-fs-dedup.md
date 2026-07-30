---
name: hardened-fs-dedup
description: Message-family taxonomy of the hardened FS read/write/canonical-path idioms across src/docker + src/docker-workload; what consolidated into src/hardened-fs.ts / src/hash.ts / src/zod-helpers.ts and what was deliberately left (byte-for-byte error strings differ)
metadata:
  type: project
---

# Hardened-FS de-duplication (branch feat/secure-nested-runtime)

The ~15 "open O_NOFOLLOW → fstat → size → read" and atomic-write idioms across
`src/docker/*` and `src/docker-workload/*` do NOT share one error vocabulary.
Error strings are byte-for-byte load-bearing (tests assert them; some bytes feed
frozen digests). Families:

- **Family A** (migrated → `loadImmutableHostJson`): `${label} path must be absolute` /
  `must be a readable regular non-symlink file: ${path}` / `must be a regular file: ${path}` /
  `must not be group/world writable: ${path}` (0o022) / `size is outside the allowed range: ${stats.size}` /
  `is not valid JSON` / `is invalid: ${issue}`. Returns `{path,sha256,sizeBytes,value}`, safeParse.
  Sites: qualification-contract loadStrictJson (3 labels), resource-watchdog policy, watchdog-policy template,
  linux-dependency-abi, client-toolchain. preloaded-image-catalog uses `readHardenedFile`
  for bytes only (keeps its own `startsWith('/')` + custom JSON msgs).
- **Family B** (egress load, LEFT): identical to A EXCEPT `must be a regular file` / `must not be group/world
  writable` have NO `: ${path}` suffix. Migrating would need a single-use path-suffix toggle. Left; egress still
  gets sha256Hex/sha256HexSchema/addDuplicateIssues/HEADER_NAME_REGEX/hostname/identifier consolidation.
- **Family C** (supervisor loadStrictJson, LEFT): assertCanonicalHostPath(compound) + combined `must be an
  owner-only regular file` + size-no-value + canonical-JSON equality + raw value + schema.parse.
- **Family D** (qualification-evidence readRegularPrivateFile, LEFT): `is not a regular file` / `file must be
  owner-only` (0o077) + owner-uid + minBytes 1 + size-uses-path. Distinct wording; already local (3 uses).
- bundle-lease loadDockerWorkloadLease (LEFT): assertCanonicalLeasePath + isFile-no-path + owner-only + canonical-JSON.
- oci-image-archive / oci-image-archive-canonicalizer / scanner-fixture (LEFT): stream (createReadStream) or
  exact-size or missing-writable-check or different wording.

Write idiom (fsync O_EXCL O_NOFOLLOW temp→rename→dir-fsync): `writeStableJsonAtomic(path,value,{mode})`
migrated preloaded-catalog-builder, watchdog-policy, supervisor writeStrictJsonAtomic, bundle-lease.
LEFT: qualification-runner writeCanonicalJsonAtomic (temp path has NO randomUUID — different temp scheme),
qualification-evidence writeCanonicalFileAtomic (extra `serialized===undefined` guard w/ site-specific msg),
runtime-trust writePublicFileAtomic (NO fsync; writeFileSync flag 'wx' + chmod 0o444 + symlink checks +
`JSON.stringify(...,2)` not stableStringify). No `writeStableTextAtomic` created (would be dead code).

`assertCanonicalHostPath(path,label)` = simple `!isAbsolute||resolve!==path` → `${label} must be canonical and
absolute`. NAME COLLISION: supervisor already had a LOCAL compound `assertCanonicalHostPath` (parent owner-only
+ relative, msg `${label} path must be canonical and absolute` — note extra "path"); renamed it to
`assertCanonicalPrivatePath` to free the name. bundle-cleanup assertSafeCleanupPath LEFT (compound `parts.length<2`
+ different msg).

`identifierSchema` has TWO variants: no-colon `[a-z0-9._-]{2,127}` (7 files incl. both egress) and colon
`[a-z0-9._:-]` (supervisor/lifecycle-evidence/bundle-lease). Shared `identifierSchema` (zod-helpers) = no-colon,
imported ONLY by the egress pair (task scope); other no-colon locals left to avoid same-name/different-regex
ambiguity with the colon locals.
