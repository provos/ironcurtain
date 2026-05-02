---
name: Docker bind mount source-dir staleness
description: Linux Docker bind mounts go stale when the source directory is removed and recreated; the kernel keeps the original inode reference and the container sees an empty mount. Affects any code that does rmSync+mkdirSync on a bind-mount source.
type: project
---

## What

When a host directory is bind-mounted into a Docker container, the kernel binds at mount time to the inode of the source directory. If host code subsequently does `rmSync(parentDir) + mkdirSync(parentDir)`, the container's mount still references the OLD (now-freed) inode. Result: the container sees an empty mount for the rest of the bundle's lifetime.

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

`bundle.restageSkills()` is called per state transition in workflow shared-container mode. Any state with a different signature than the previous one re-stages skills into the bundle's `skillsDir`. If `stageSkillsToBundle` were to remove-and-recreate the parent dir, the container's skills mount would go stale immediately and stay stale for the rest of the bundle's lifetime — state A (initial mint at container start) would see the right skills; states B/C (post-restage) would see an empty mount. Diagnostic `ls -la` inside the container would confirm `total 0` after restage.

## Current implementation (correct)

`stageSkillsToBundle()` in `src/skills/staging.ts` wipes children individually (NOT the parent itself):

```ts
// Wipes children individually rather than the parent itself.
const normalizedDestDir = resolve(destDir);
if (existsSync(normalizedDestDir)) {
  for (const entry of readdirSync(normalizedDestDir)) {
    rmSync(resolve(normalizedDestDir, entry), { recursive: true, force: true });
  }
} else {
  mkdirSync(normalizedDestDir, { recursive: true });
}
// ...cpSync each skill into a child of destDir...
```

The parent inode stays stable across re-stages, so the bind mount remains live and the container observes the new contents.

## How to apply

- Treat `rmSync(bindMountSource)` of the parent itself as a contract violation.
- To clear contents under a bind-mount source dir, iterate and remove children individually (`for (const entry of readdirSync(dir)) rmSync(resolve(dir, entry), {recursive:true,force:true})`).
- This rule applies anywhere a host directory is bind-mounted into a long-lived container that the host expects to mutate in place — currently `stageSkillsToBundle`, but the same trap applies to any future "stage X into a live mount" code.
- Independent but related: avoid NESTING bind mounts (one mount target inside another). Docker Desktop / macOS handle this unreliably (silent empty inner mount on 4.67.x; known Lima/Colima bugs). For the skills mount specifically, the adapter's `skillsContainerPath` is required to be a sibling path that does not nest under any other mount target — see `src/docker/agent-adapter.ts`.
