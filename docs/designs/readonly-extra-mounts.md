# Read-Only Extra Mounts for Docker Agent Sessions

**Status:** Implemented (phase 1: CLI, mux, web UI, resume). Presets (§5.6) are future work.
**Scope:** Docker Agent Mode PTY sessions started from `ironcurtain mux` and the daemon web UI (and, for parity, `ironcurtain start [--pty]`). Workflows are out of scope for v1.

## 1. Problem

A Docker agent session sees exactly one host directory: the workspace (session sandbox or `--workspace <path>`), bind-mounted read-write at `/workspace`. Users often want the agent to _consult_ other material, such as datasets, reference code, or training material on a Windows drive (`/mnt/d/Training` under WSL2), without:

- copying it into the workspace,
- making that directory the (read-write) workspace, or
- giving the agent any way to modify it.

## 2. Goals / Non-goals

**Goals**

1. Attach zero or more extra host directories to a PTY session, **read-only**, chosen at session creation in mux `/new` and in the web UI launch form.
2. Work for WSL2 drvfs paths (`/mnt/<drive>/...`), and accept Windows-style input (`D:\Training`) as a convenience.
3. Survive session resume (same mounts restored, re-validated).
4. Tell the agent where the mounts are and that they are read-only.
5. Keep path validation and mount construction in one dedicated module (CLAUDE.md "Encapsulate risky operations").

**Non-goals (v1)**

- Read-write extra mounts.
- Explicitly exposing extra mounts to the nested Docker daemon. (The Apple same-VM daemon can see them, read-only; see §6.)
- Workflow sessions and cron jobs.
- Making the mounts visible to host-side MCP servers (e.g., the filesystem server). Docker agents read them natively from inside the container.

## 3. Feasibility check (done on this machine)

Environment: WSL2 kernel 6.18, Docker Desktop 29.4.1 with WSL integration (`unix:///var/run/docker.sock`). `/mnt/d` is drvfs (`9p`, `aname=drvfs`, `uid=1000,gid=1000,umask=022`).

```
docker run --rm --network none -v /mnt/d/Training:/mnt/training:ro alpine:3.20 sh -c '...'
  → container sees the same entries as the host
  → touch /mnt/training/x  → "Read-only file system"
  → /proc/mounts: "D:\134 /mnt/training 9p ro,..."
  → nothing was created on the host
```

So the existing `DockerMount { source, target, readonly: true }` → `-v src:tgt:ro` path in `docker-manager.ts` already works for drvfs sources under Docker Desktop. No runtime changes are needed. Apple `container` emits the same `-v ...:ro` form (virtiofs).

## 4. Security analysis

The mounts are deliberately **outside the policy engine**. In Docker Agent Mode the agent reads files with its own tools, not through the MCP filesystem server, so anything mounted is fully readable by the agent. The design treats "the user picked this directory" as consent and focuses on (a) keeping it read-only and (b) stopping the user from accidentally exposing IronCurtain's own secrets.

| Concern                                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent writes to the mount                                                             | `:ro` bind. The agent has sudo but the container runs `--cap-drop=ALL` plus only `SETUID SETGID CHOWN FOWNER DAC_OVERRIDE AUDIT_WRITE` (`docker-infrastructure.ts` `buildAgentContainerConfig`). Without `CAP_SYS_ADMIN` it cannot remount read-write. Renaming an ancestor of the mount target (the concern noted at `docker-infrastructure.ts:835`) moves the mount but does not make it writable.                                                                                                                                                                                                                                                                                                                                                                   |
| Mount exposes IronCurtain secrets (CA key, OAuth creds, session dirs, config, `.env`) | Reject a source that _is, is inside, or contains_ `~/.ironcurtain`, the user config file, the `.env` dotenv loads from the current directory (only when it exists, so an absent file never blocks mounting the directory you are in), or the credential stores IronCurtain swaps host-side (`~/.claude`, the Anthropic CLI config dir, `~/.codex`). These are pure path-prefix comparisons against a fixed list; the mounted tree is never traversed or searched. Beyond IronCurtain's own secrets, the user who picks a folder accepts the risk of what is in it (e.g. `~/.ssh` is not special-cased), and the UIs say so.                                                                                                                                            |
| Host runtime sockets                                                                  | A read-only bind does **not** stop `connect()` on a Unix socket, so mounting a directory holding e.g. the Docker socket would be a container escape. Reject sources inside or containing `/proc`, `/sys`, `/dev`, `/run`, `/var/run`, `/var/lib/docker`, `/var/lib/lxd`, `/var/lib/incus`, `/var/snap`, `/mnt/wsl`, `/mnt/wslg` (Docker Desktop and WSLg sockets); sources that contain `/tmp` or `/var/tmp`; and sources inside their well-known socket entries (`.X11-unix` and other `.*-unix`, `tmux-<uid>`, `ssh-*`, `systemd-private-*`). Other `/tmp` data is allowed. Again prefix checks only.                                                                                                                                                                |
| Mount `/`, `$HOME`, `/mnt/c`                                                          | `/` and `$HOME` are rejected. A whole-drive root (`/mnt/c`, `/mnt/d`) is **allowed with a warning** (CLI stderr, mux menu notice).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Symlink escape                                                                        | The source and guard paths are canonicalized with the OS realpath (`realpathSync.native`), which normalizes letter case on macOS. Guards are also compared by filesystem identity (device + inode) along each path's ancestor chain, which catches case variants on WSL DrvFS (where the OS realpath keeps the typed case, so `/mnt/d/TRAINING` would otherwise slip past a `/mnt/d/Training` guard) and bind-mounted aliases; and the canonical path is what goes to Docker. Symlinks and junctions _inside_ the mounted tree resolve in the container's mount namespace, so they cannot reach other host paths. Windows junctions on drvfs show up as symlinks rooted at `symlinkroot=/mnt/`. Inside the container they point at `/mnt/...` paths that do not exist. |
| TOCTOU between validation and `docker create`                                         | The window is small and requires a hostile local user who controls a path component. That user already has more direct attacks. Accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `-v` format injection                                                                 | Reject sources containing `:` or control characters (`apple-container-manager.ts` already throws on `:`). Values only ever go into the argv array (CLAUDE.md "No shell string concatenation").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Target collides with reserved mounts                                                  | Targets are not user-controlled paths. They are always `/mnt/ro/<slug>` (§5.2; persisted targets are re-checked on resume, rejecting `.`/`..`), which cannot shadow `/workspace`, `/etc/ironcurtain`, `/run/ironcurtain`, the conversation-state dir, or skills.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Exfiltration                                                                          | Mounted content can reach the LLM provider and any allowed egress domain, which is unavoidable for "let the agent read this". Mounts are recorded in the session log, `session-metadata.json`, and the agent's system prompt, and both UIs warn when folders are selected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Web UI as an attack surface                                                           | No new privilege. A web UI token holder can already choose an arbitrary **read-write** `workspacePath`. The daemon validates in `sessions.create`, and the `start --pty` child validates again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 5. Design

### 5.1 Data model

```ts
// src/session/readonly-mounts.ts (new, the only module that validates these)
export interface ReadonlyMountSpec {
  /** Canonical absolute host path (post-realpath). */
  readonly hostPath: string;
  /** Container path, always `/mnt/ro/<slug>`. */
  readonly containerPath: string;
}

export const MAX_READONLY_MOUNTS = 8;
export const READONLY_MOUNT_ROOT = '/mnt/ro';

export interface ReadonlyMountResolution {
  readonly mounts: ReadonlyMountSpec[];
  readonly warnings: string[]; // e.g. whole-drive mount, vanished directory on resume
}

/** Translate `D:\Training` → `/mnt/d/Training` under WSL; identity elsewhere. */
export function normalizeHostPathInput(raw: string, env?: { wsl: boolean; automountRoot: string }): string;

/** Validate + canonicalize + assign targets. Throws with a user-facing message. */
export function resolveReadonlyMounts(rawPaths: readonly string[]): ReadonlyMountResolution;

/** Shape-check + re-validate persisted specs on resume; drop vanished dirs with a warning. */
export function restoreReadonlyMounts(persisted: unknown): ReadonlyMountResolution;

/** In src/docker/container-workspace.ts — specs → DockerMount[] (readonly: true). Used by PTY and batch paths. */
export function buildReadonlyMounts(specs: readonly ReadonlyMountSpec[] | undefined): DockerMount[];

/** Agent system-prompt section listing the mounts (and any warnings). */
export function formatReadonlyMountsPrompt(
  specs: readonly ReadonlyMountSpec[],
  warnings?: readonly string[],
): string | undefined;
```

### 5.2 Validation rules (`resolveReadonlyMounts`)

For each raw path:

1. `normalizeHostPathInput`. Under WSL (`os.release()` contains `microsoft`), translate `X:\a\b` or `X:/a/b` to `<automount-root>/x/a/b`. The automount root defaults to `/mnt/` and is read from `/etc/wsl.conf` `[automount] root` if set. Pure string transform, no `wslpath` subprocess.
2. `resolve(expandTilde(...))`, then `realpathSync`. The path must exist and be a directory.
3. Reject control characters, `:` in the canonical path, `/`, and `$HOME`.
4. Reject the secret roots and socket roots from §4 (prefix comparisons only).
5. Deduplicate by canonical path. Enforce `MAX_READONLY_MOUNTS` (8). Overlap with the workspace or between mounts is allowed: it is harmless for read-only views.
6. Target is `/mnt/ro/<slug(basename)>`, where `slug` keeps `[A-Za-z0-9._-]` and maps everything else to `_`. Collisions get `-2`, `-3`, and so on. Example: `/mnt/d/Training` becomes `/mnt/ro/Training`.

### 5.3 Session plumbing

```
mux /new (mux-app validates on add) ──┐
web UI sessions.create ──────────────┤ (daemon validates)
                                     └─► PtyBridgeOptions.readonlyMounts
                                           └─► buildSpawnArgs: --mount-ro <p> (×N)
                                                 └─► `start` child: early check (fail fast, before image prep)
                                                └─► buildSessionConfig: resolveReadonlyMounts (authoritative boundary;
                                                      │   SessionOptions.readonlyMounts are raw strings)
                                                      ├─► session-metadata.json (create-once; resume source)
                                                      ├─► system-prompt augmentation + session log
                                                      └─► prepareDockerInfrastructure({ readonlyMounts })
                                                            └─► core.readonlyMounts → buildReadonlyMounts()
                                                                  in pty-session.ts and createSessionContainers
```

- **CLI** (`src/index.ts`): new repeatable flag `--mount-ro <path>` (`parseArgs` `multiple: true`), validated next to `--workspace`. With `--resume` it adds folders to the session's saved ones (§5.7). It is an error outside container agent mode.
- **`PtyBridgeOptions.readonlyMounts?: readonly string[]`**. `buildSpawnArgs` appends one `--mount-ro <p>` per entry. Raw strings cross the process boundary, and the child does the authoritative validation, as it already does for the workspace.
- **Infrastructure**: `PrepareDockerInfrastructureOptions.readonlyMounts` is stored on the bundle as `PreContainerInfrastructure.readonlyMounts`. `pty-session.ts` pushes `buildReadonlyMounts(infra.readonlyMounts)` after the topology `if/else`, so all three topologies get it, and the mounts flow into `createLedgeredAgentContainer` expanded evidence automatically.
- **Batch parity** (`docker-infrastructure.ts` `createSessionContainers`): the same push. `src/docker/CLAUDE.md` "Dual session modes: keep in sync" requires it, and it makes `ironcurtain start -w ... --mount-ro ...` work.
- **Resume**: mounts are persisted in `session-metadata.json` (`SessionMetadata.readonlyMounts`, written once at creation), which both the PTY and batch resume paths read through `buildSessionConfig`. On resume each entry is shape-checked and **re-validated** (`restoreReadonlyMounts`). A directory that no longer exists (e.g. an unplugged drive) is dropped with a warning on the PTY stderr and in the agent prompt, and the session continues. A path that now fails a _security_ check aborts the resume. Container paths are kept stable. Folders can also be added on resume (§5.7).
- **Agent orientation**: `buildSessionConfig` appends a "Read-only reference directories" section to `systemPromptAugmentation` listing each `containerPath` with its host path, telling the agent the folders cannot be modified and outputs belong in `/workspace`.
- **Logging**: `buildSessionConfig` logs one `Read-only mount: <host> -> <container>` line per mount to the session log.

### 5.4 Mux UX

The `/new` menu gains two hotkeys instead of a new step, so quick-spawn still costs one keystroke and the numbered options are unchanged:

```
┌ /new ──────────────────────────┐
│ >New sandbox                    │
│  Existing directory             │
│  Use a persona                  │
└─────────────────────────────────┘
 r  add read-only folder   x  remove last
   ro: /mnt/d/Training
```

`r` opens the existing path browser (Tab completion; starts at `/mnt/` under WSL) with a `Read-only folder:` prompt. Enter emits a `picker-add-readonly` action; `mux-app` validates it with `resolveReadonlyMounts` (as it does for workspace paths) and either records the list and returns to the menu, or re-enters the browser with the error. The chosen list carries through the workspace, persona, and provider steps into `picker-spawn`, and the spawn message reports the count.

### 5.5 Web UI UX

- `session-sidebar.svelte` launch form: a "Read-only folders" input under the workspace field (Enter or "Add" appends; a typed-but-not-added path still counts at launch), with the chosen folders listed below, each with a remove button. Placeholder: `/mnt/d/Training or D:\Training`.
- `sessionCreateSchema` gains `readonlyMounts: z.array(z.string().min(1).max(4096)).max(8).optional()`. `createPtySession` and `PtySessionManager.create` pass it through to `PtyBridgeOptions`.
- The daemon validates the list in `sessions.create` before spawning, so an unsafe or missing folder fails immediately with `INVALID_PARAMS` in the form's error banner. The child re-validates.
- While any folder is listed, the form shows a warning that the agent can read everything in those folders and that their contents may be sent to the model provider.

### 5.6 Presets (phase 2)

Typing `/mnt/d/Training` every time gets old. Two complementary sources, both merged with the per-session list and validated identically:

- **Persona default**: `persona.json` `readonlyMounts: string[]`, editable in `ironcurtain persona edit` and on the web UI Personas page. This fits naturally, since a "trainer" persona always wants its material.
- **Global presets**: `config.json` `docker.readonlyMountPresets: [{ path, label }]`, shown as checkboxes in the web UI form and as a pick list in the mux step.

### 5.7 Adding folders on resume

Resume always creates a fresh container and re-sends the system prompt (`--append-system-prompt` on every launch), so a resumed session can gain folders:

- `restoreReadonlyMounts(persisted, additional)` re-validates the saved folders as before, then validates the additions. Saved folders keep their `/mnt/ro/<name>` paths; additions get names that avoid **every** saved path, including folders that are currently unavailable, so those can return later without a clash. Folders the session already mounts are skipped. Saved plus added folders are capped at `MAX_READONLY_MOUNTS`, counting unavailable ones.
- `buildSessionConfig` writes the merged list (saved, including unavailable, then additions) back with `updateSessionMetadata`, so later resumes keep the added folders. Removing a folder on resume is not supported.
- **CLI:** `ironcurtain start --resume <id> --mount-ro <path>`.
- **Mux:** the `/resume` picker gets the same `r` / `x` hotkeys as `/new`. `r` opens the folder browser, which returns to `/resume`. `mux-app` validates each addition against the selected session's saved folders (duplicates are reported as a notice), and Enter passes them with `resume-spawn`.
- **Web UI:** `sessions.resume` accepts `readonlyMounts`. The daemon checks them against the saved folders for an immediate `INVALID_PARAMS` and passes only the additions to the child. `sessions.listResumable` includes each session's saved folders. The Resume dialog shows them per session and has the same chip field as New session (shared `readonly-folders-input.svelte`).

## 6. Platform notes

| Platform                                | Behavior                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WSL2 + Docker Desktop (this machine)    | Verified: drvfs `/mnt/<drive>` binds work, and `:ro` is enforced. 9p is slow for very large trees, so the agent's `rg`/`find` over many files will be slower than on ext4. Document this, and leave "copy to a tmpfs snapshot" as a possible future option.                                                                                           |
| WSL2 + native dockerd inside the distro | Same `-v` semantics. drvfs is visible to the daemon because it shares the distro's mount namespace.                                                                                                                                                                                                                                                   |
| Linux native                            | Straightforward. UID remap is irrelevant for read access to world-readable files. Files readable only by the host user remain readable inside the container (sudo plus `DAC_OVERRIDE`).                                                                                                                                                               |
| macOS Docker Desktop                    | Source must lie under a Docker Desktop file-sharing root (`/Users` by default). Otherwise create fails, and the error should be mapped to a clear message.                                                                                                                                                                                            |
| Apple `container`                       | `-v src:tgt:ro` over virtiofs. The existing `:` rejection in `apple-container-manager.ts` already applies. Because 1.1.0 virtiofs can silently drop a directory share when a path inside it is also mounted, `prepareDockerInfrastructure` refuses read-only folders that overlap the workspace on this runtime.                                      |
| Nested-Docker (workload) sessions       | The Docker Desktop daemon sidecar does not get the mounts (its exact-bind assertions in `docker-desktop-sidecar.ts:557` are unaffected). In the Apple same-VM variant the rootless daemon runs inside the agent VM, so nested containers can bind `/mnt/ro/*`; those binds stay read-only because the read-only flag is locked in the user namespace. |

## 7. Testing

- `test/session-readonly-mounts-validation.test.ts`: WSL path translation (including a custom automount root), symlink canonicalization, rejection of `/`, `$HOME`, the IronCurtain home (inside, equal, parent), credential dirs, socket/system roots, control characters, the count limit, dedupe and slug collisions; `restoreReadonlyMounts` shape checks, vanished-directory warning, and unsafe-path rejection; mount and prompt helpers.
- `test/session-readonly-mounts.test.ts`: `buildSessionConfig` validates raw paths (rejecting unsafe ones), persists mounts in metadata, adds the prompt section, restores on resume (ignoring caller-supplied mounts), drops a vanished directory with a warning, and ignores mounts outside Docker mode.
- `test/docker-infrastructure.test.ts`: batch `createSessionContainers` emits the read-only mounts in UDS and TCP modes.
- `test/pty-bridge.test.ts`: `--mount-ro` repeated in order.
- `test/mux-input-handler.test.ts`: `r` opens the read-only browser and Enter emits `picker-add-readonly`, error re-entry keeps the read-only target, `x` removes (keeping the menu selection), Escape cancels, the list carries through the workspace step into `picker-spawn`, and a new `/new` resets it.
- `test/pty/pty-session-manager.test.ts`: `sessions.create` passes canonical paths to the bridge and rejects an unsafe path before spawning.
- `test/docker/pty-nested-ordering.test.ts`: the PTY agent container gets the read-only mount.
- Web UI `session-sidebar.test.ts`: add (button and Enter), duplicate ignored, remove, warning shown, typed draft included at launch.
- Not automated: a live Docker check. It was done manually (§3).

## 8. Rollout

1. Done: `readonly-mounts.ts`, CLI `--mount-ro`, PTY + batch wiring, metadata/resume, prompt + session log, mux `/new` hotkeys, web UI form with daemon-side validation.
2. Phase 2: persona defaults and global presets (§5.6).

## 9. Decisions

1. Whole-drive roots (`/mnt/d`) are allowed with a warning.
2. Container targets are fixed at `/mnt/ro/<slug>`.
3. On resume, a missing mount is dropped with a warning and the session continues.
4. No filesystem searching: validation only compares the selected path against a fixed list of IronCurtain secret and host-socket locations. The user who selects a folder accepts the risk of its contents.
