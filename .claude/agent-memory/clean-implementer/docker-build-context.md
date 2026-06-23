---
name: docker-build-context
description: How IronCurtain builds agent Docker images — clean-context copy, build-hash staleness, and shared entrypoint sourcing
metadata:
  type: project
---

Docker agent images (`ironcurtain-{claude-code,goose,codex}:latest`) are built by `ensureImage()` in `src/docker/docker-infrastructure.ts`, which calls `buildImageFromCleanContext()`.

**Why:** Apple `container build` resolves an EMPTY context if handed a git-tracked dir, so the build copies the WHOLE `docker/` dir into a fresh temp dir outside any repo and builds from there.

**How to apply:**
- Any new file in `docker/` is automatically in the build context (clean copy iterates `readdirSync(dockerDir)`). A new `COPY <file> ...` in a Dockerfile just works — no extra wiring.
- `computeBuildHash()` (same file, ~line 1869) hashes the Dockerfile listed PLUS every `*.sh` file in `docker/` (`file.endsWith('.sh')`). So a new/changed shell helper triggers a rebuild of all agent images automatically — no need to touch the hash logic.
- The three agent entrypoints (`entrypoint-{claude-code,goose,codex}.sh`) share one sourced helper `entrypoint-uid-remap.sh` → copied to `/usr/local/bin/ironcurtain-uid-remap.sh`, sourced with `. /usr/local/bin/...`. Sourcing (not exec) means the helper's `exec runuser ... "$0" "$@"` re-execs the PARENT entrypoint with its args. Verified: after re-exec, `id -u != 0` so the sourced block is a clean no-op the second pass.
- lint-staged only matches `*.ts` (and `packages/web-ui/**`). `.sh` files are NOT run through Prettier (no shell parser) or ESLint — the pre-commit hook ignores them. Verify shell with `bash -n`.

## UID/GID remap semantics (issue #232 + #291)
Host launcher passes `--user 0:0` + `IRONCURTAIN_AGENT_UID`/`GID`; entrypoint (as root) renumbers baked `codespace` user/group then re-execs as codespace. macOS skips it (VirtioFS translates UIDs; env vars unset).
- GID collision = BENIGN (host group already in image, e.g. universal devcontainer bakes `users:x:100`; nixos/WSL primary group is 100). Reuse via `usermod -g $GID codespace` (requires group to exist). Only `groupmod -g` when GID is FREE.
- UID collision = DANGEROUS (host UID is a distinct baked account, e.g. www-data=33). Must FAIL HARD with `[ironcurtain] usermod failed:` — silent fall-through recreates the original #232 bug.
- Integration tests `test/uid-remap{,.goose}.integration.test.ts` drive direct `docker run` (not runPtySession — PTY mounts a host-UID socketsDir that breaks under a mocked synthetic UID). Tests assert exact `[ironcurtain] (usermod|groupmod) failed:` substrings — grep before editing any echo message. Skipped without Docker + `~/.ironcurtain/ca`.
