# shellcheck shell=bash
# Shared runtime UID/GID remap block for IronCurtain agent entrypoints
# (Linux only). SOURCED — not executed — from each agent's
# /usr/local/bin/entrypoint.sh so the three adapters (claude-code, goose,
# codex) cannot drift apart. Issue #291 was caused by exactly that drift:
# only the goose entrypoint got the GID-collision fix in the field report.
#
# Sourcing contract:
#   - This file is `source`d near the top of the parent entrypoint, so
#     `$0` and `$@` resolve to the PARENT entrypoint's path and args. The
#     `exec runuser -u codespace -- "$0" "$@"` below therefore re-execs the
#     parent entrypoint (/usr/local/bin/entrypoint.sh) with its original
#     args — which is what we want. `exec` replaces the current process even
#     when reached from a sourced file.
#   - After the re-exec, the parent entrypoint runs again and sources this
#     file again, but `id -u` is no longer 0, so the whole block is a no-op
#     the second time through and execution falls past it to the rest of the
#     parent entrypoint (now running as codespace).
#
# Issue #232: when the host UID is not 1000, bind-mounted directories
# (e.g., the conversation-state dir) appear inside the container owned by
# the host UID, and the baked codespace user (UID 1000) cannot write to
# them. The host-side launcher passes `--user 0:0` plus the host UID/GID via
# IRONCURTAIN_AGENT_UID / IRONCURTAIN_AGENT_GID so this block (running as
# root) can renumber the codespace account to match the host before
# dropping privileges. On macOS, Docker Desktop's VirtioFS translates UIDs
# transparently and the env vars are not set, so this block is skipped.
if [ "$(id -u)" = "0" ] && [ -n "$IRONCURTAIN_AGENT_UID" ] && [ -n "$IRONCURTAIN_AGENT_GID" ]; then
  if [ "$IRONCURTAIN_AGENT_UID" != "1000" ] || [ "$IRONCURTAIN_AGENT_GID" != "1000" ]; then
    # Renumber the codespace user/group to the host UID/GID, then fix
    # ownership on the baked home directory so the remapped user can
    # write generated state. Host workspace and mounted state keep their
    # ownership. Bind-mounted subdirectories (conversation state, sockets,
    # orientation) keep their host-side ownership, which now matches codespace.
    #
    # GID and UID collisions are handled asymmetrically because they mean
    # different things:
    #
    #   - A GID collision is BENIGN. It just means the host's primary group
    #     already exists inside the image (issue #291: the universal
    #     devcontainer image bakes `users:x:100`, and on nixos/WSL and many
    #     Linux desktops the invoking user's primary group is GID 100).
    #     Sharing a group is ordinary Unix, so we point codespace's PRIMARY
    #     group at the existing group via `usermod -g` (which REQUIRES the
    #     target GID to already exist). Only when the GID is free do we
    #     renumber codespace's own group via `groupmod -g`. Previously this
    #     unconditionally ran `groupmod -g`, which fails with
    #     "GID already exists" and aborted startup.
    #
    #   - A UID collision is DANGEROUS and must FAIL HARD. It means the host
    #     UID is already a distinct baked-in account (e.g. www-data=33).
    #     Silently continuing would leave codespace at UID 1000 and then
    #     `chown` / `runuser -u codespace` would operate on the wrong
    #     account — recreating the original issue #232 bug with no
    #     diagnostic. This is the regression guard from commit 2f463f3.
    current_uid="$(id -u codespace)"
    current_gid="$(id -g codespace)"
    if [ "$current_gid" != "$IRONCURTAIN_AGENT_GID" ] &&
      ! getent group "$IRONCURTAIN_AGENT_GID" >/dev/null 2>&1; then
      # A free GID can renumber the image group. Existing groups are selected
      # below without modifying their membership or ownership.
      groupmod -g "$IRONCURTAIN_AGENT_GID" codespace || {
        echo "[ironcurtain] groupmod failed: cannot remap codespace group to GID $IRONCURTAIN_AGENT_GID (already in use?)" >&2
        exit 1
      }
    fi

    # Both usermod -u AND usermod -g implicitly traverse the home directory.
    # Redirect the account home for the entire identity update, including a
    # GID-only change or collision, then restore it before dropping privileges.
    if [ -e /nonexistent ] || [ -L /nonexistent ]; then
      echo '[ironcurtain] cannot remap codespace: temporary account home /nonexistent must be absent' >&2
      exit 1
    fi
    usermod -d /nonexistent -u "$IRONCURTAIN_AGENT_UID" -g "$IRONCURTAIN_AGENT_GID" codespace &&
      usermod -d /home/codespace codespace || {
      echo "[ironcurtain] usermod failed: cannot remap codespace user to UID $IRONCURTAIN_AGENT_UID and GID $IRONCURTAIN_AGENT_GID (already in use?)" >&2
      exit 1
    }

    # Only the image home tree is generated state. Prune every nested mount
    # explicitly: -xdev alone does not exclude binds from the same filesystem.
    # mountinfo escapes whitespace/backslashes using octal sequences.
    ic_home_prunes=()
    while read -r ic_mount_id ic_mount_parent ic_mount_device ic_mount_root ic_mount_path ic_mount_rest; do
      printf -v ic_mount_path '%b' "$ic_mount_path"
      case "$ic_mount_path" in
        /home/codespace/*)
          # find -path parses glob patterns even when the shell argument is
          # quoted. Mount names are literal, including brackets and wildcards.
          ic_mount_path="${ic_mount_path//\\/\\\\}"
          ic_mount_path="${ic_mount_path//\*/\\*}"
          ic_mount_path="${ic_mount_path//\?/\\?}"
          ic_mount_path="${ic_mount_path//\[/\\[}"
          ic_home_prunes+=( -path "$ic_mount_path" -prune -o )
          ;;
      esac
    done < /proc/self/mountinfo
    find -P /home/codespace -xdev "${ic_home_prunes[@]}" \
      -uid "$current_uid" -exec chown --no-dereference "$IRONCURTAIN_AGENT_UID:$IRONCURTAIN_AGENT_GID" '{}' + || {
      echo "[ironcurtain] cannot reset generated home ownership to $IRONCURTAIN_AGENT_UID:$IRONCURTAIN_AGENT_GID" >&2
      exit 1
    }
  fi
  # Re-exec the entrypoint as the (possibly remapped) codespace user. The
  # remainder of the parent entrypoint runs under codespace, so $HOME and
  # sudoers (which keys on the username) resolve correctly. `$0`/`$@` are
  # the parent entrypoint's because this file is sourced, not executed.
  exec runuser -u codespace -- "$0" "$@"
fi

# Install the session-mounted public MITM CA into this ephemeral container's
# system trust store. The image remains CA-neutral: the certificate arrives
# through the read-only /etc/ironcurtain orientation mount. This block lives in
# the already-shared bootstrap helper so Claude, Codex, and Goose cannot drift.
IRONCURTAIN_RUNTIME_CA=/etc/ironcurtain/ca-cert.pem
IRONCURTAIN_SYSTEM_CA=/usr/local/share/ca-certificates/ironcurtain-session-ca.crt

if [ -f "$IRONCURTAIN_RUNTIME_CA" ]; then
  if ! command -v update-ca-certificates >/dev/null 2>&1; then
    echo '[ironcurtain] cannot install runtime trust: update-ca-certificates is unavailable' >&2
    exit 1
  fi

  if [ "$(id -u)" = '0' ]; then
    install -m 0444 "$IRONCURTAIN_RUNTIME_CA" "$IRONCURTAIN_SYSTEM_CA" || exit 1
    update-ca-certificates >/dev/null || exit 1
  else
    sudo -n install -m 0444 "$IRONCURTAIN_RUNTIME_CA" "$IRONCURTAIN_SYSTEM_CA" || exit 1
    sudo -n update-ca-certificates >/dev/null || exit 1
  fi
fi
