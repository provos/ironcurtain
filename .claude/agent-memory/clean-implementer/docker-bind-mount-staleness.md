---
name: Docker bind mount source-dir staleness
description: Linux Docker bind mounts go stale when the source directory is removed and recreated; the kernel keeps the original inode reference and the container sees an empty mount. Affects any code that does rmSync+mkdirSync on a bind-mount source.
type: project
---

## What

`stageSkillsToBundle()` in `src/skills/staging.ts` does:

```ts
rmSync(normalizedDestDir, { recursive: true, force: true });
mkdirSync(normalizedDestDir, { recursive: true });
// ...cpSync into destDir...
```

When `destDir` is a Docker bind-mount source (as for `bundle.skillsDir`), this breaks the mount on Linux. The kernel binds at mount time to the inode of `destDir`. When `rmSync` removes that directory, the inode is freed (or held but stale). The subsequent `mkdirSync` creates a NEW inode at the same path — but the container's mount still references the OLD inode. Result: the container sees an empty mount.

Verified with a minimal repro:

```
mkdir /tmp/bm && echo v1 > /tmp/bm/file
docker run --rm -d --name x -v /tmp/bm:/x:ro alpine sleep 60
docker exec x ls /x          # → file (works)
rm -rf /tmp/bm && mkdir /tmp/bm && echo v2 > /tmp/bm/file2
docker exec x ls /x          # → (empty)  ← STALE
```

By contrast, modifying contents WITHOUT removing the directory itself works fine:

```
rm /tmp/bm/file && echo v2 > /tmp/bm/file2
docker exec x ls /x          # → file2 (live)
```

## Why this matters

`bundle.restageSkills()` is called per state transition in workflow shared-container mode. Any state that triggers a different signature than the previous one re-runs `stageSkillsToBundle`, which removes-and-recreates `<bundleDir>/skills/`. The container's `/home/codespace/.agents/skills/` mount goes stale immediately and stays stale for the rest of the bundle's lifetime.

## How to apply

- Treat `rmSync(bindMountSource)` as a contract violation. To clear contents, iterate and remove children individually (e.g., `for entry of readdirSync(dir): rmSync(entry, {recursive,force})`).
- The fix in `stageSkillsToBundle` would be: replace `rmSync + mkdirSync` of the parent with `for (const entry of readdirSync(destDir)) rmSync(resolve(destDir, entry), {recursive:true,force:true})`. The parent dir's inode remains stable; the bind mount remains live.
- Surfaces in `test/skills-end-to-end.integration.test.ts`'s real-Docker block: state A (initial mint at container start) sees the right skills; states B/C (post-restage) see an empty mount. Diagnostic `ls -la` inside the container confirms `total 0` after restage.
