#!/bin/bash
# Copies runtime-injected MCP config from the orientation mount
# into Claude Code's expected config location, then hands off to CMD.
# Non-PTY mode: CMD is "sleep infinity" (agent commands arrive via docker exec).
# PTY mode: CMD is the socat PTY command from buildPtyCommand().

# Runtime UID remap (Linux only).
#
# Issue #232: when the host UID is not 1000, bind-mounted directories
# (e.g., the conversation-state dir) appear inside the container owned
# by the host UID, and the baked codespace user (UID 1000) cannot write
# to them. The host-side launcher passes `--user 0:0` plus the host
# UID/GID via IRONCURTAIN_AGENT_UID / IRONCURTAIN_AGENT_GID so this
# block (running as root) can renumber the codespace account to match
# the host before dropping privileges. On macOS, Docker Desktop's
# VirtioFS translates UIDs transparently and the env vars are not set,
# so this block is skipped.
if [ "$(id -u)" = "0" ] && [ -n "$IRONCURTAIN_AGENT_UID" ] && [ -n "$IRONCURTAIN_AGENT_GID" ]; then
  if [ "$IRONCURTAIN_AGENT_UID" != "1000" ] || [ "$IRONCURTAIN_AGENT_GID" != "1000" ]; then
    # Renumber the codespace user/group to the host UID/GID, then fix
    # ownership on the baked home dir and workspace mount so the
    # remapped codespace user can read/write them. Bind-mounted
    # subdirectories (conversation state, sockets, orientation) keep
    # their host-side ownership, which now matches codespace.
    #
    # FAIL HARD on remap errors. Previously these commands ran without
    # return-code checks: if `usermod -u $HOST_UID codespace` collided
    # with an existing image user (plausible for system UIDs like 33
    # `www-data` or 100 `systemd-network`), the entrypoint would
    # silently continue, then `chown` and `runuser -u codespace`
    # would operate on the still-UID-1000 codespace — recreating the
    # original issue #232 bug with no diagnostic. Abort with an explicit
    # error instead so the operator sees what went wrong.
    groupmod -g "$IRONCURTAIN_AGENT_GID" codespace || {
      echo "[ironcurtain] groupmod failed: cannot remap codespace group to GID $IRONCURTAIN_AGENT_GID (already in use?)" >&2
      exit 1
    }
    usermod -u "$IRONCURTAIN_AGENT_UID" -g "$IRONCURTAIN_AGENT_GID" codespace || {
      echo "[ironcurtain] usermod failed: cannot remap codespace user to UID $IRONCURTAIN_AGENT_UID (already in use?)" >&2
      exit 1
    }
    chown -R "$IRONCURTAIN_AGENT_UID:$IRONCURTAIN_AGENT_GID" /home/codespace /workspace || {
      echo "[ironcurtain] chown failed: cannot reset ownership of /home/codespace and /workspace to $IRONCURTAIN_AGENT_UID:$IRONCURTAIN_AGENT_GID" >&2
      exit 1
    }
  fi
  # Re-exec the entrypoint as the (possibly remapped) codespace user.
  # The remainder of this script runs under codespace, so $HOME and
  # sudoers (which keys on the username) resolve correctly.
  exec runuser -u codespace -- "$0" "$@"
fi

# Bridge UDS to local TCP so HTTPS_PROXY works
MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

# Pre-seed .claude.json so Claude Code skips onboarding, trusts /workspace,
# and doesn't prompt for API key approval.
# On resume, restore the previous session's .claude.json from the state dir
# (it contains conversation metadata that --continue needs).
SAVED_CLAUDE_JSON="$HOME/.claude/.claude.json.saved"
if [ -n "$IRONCURTAIN_RESUME_FLAGS" ] && [ -f "$SAVED_CLAUDE_JSON" ]; then
  cp "$SAVED_CLAUDE_JSON" "$HOME/.claude.json"
else
  cat > "$HOME/.claude.json" <<'EOJSON'
{
  "hasCompletedOnboarding": true,
  "numStartups": 1,
  "projects": {
    "/workspace": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true
    }
  }
}
EOJSON
fi

# Configure settings.json:
# - skipDangerousModePermissionPrompt: suppresses the bypass-permissions warning
# - skipWebFetchPreflight: bypasses domain safety check that fails in proxied env
# - env.HTTPS_PROXY: ensures Claude Code's WebFetch routes through the MITM proxy
# Auth mode determines how Claude Code gets its API credentials:
# - OAuth mode (CLAUDE_CODE_OAUTH_TOKEN set): Claude Code reads the token from
#   this env var directly -- no apiKeyHelper needed.
# - API key mode: apiKeyHelper echoes the fake key so Claude Code skips the
#   custom API key approval dialog entirely.
# Always written (even on resume) because auth mode is runtime-specific.
mkdir -p "$HOME/.claude"

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  # OAuth mode: Claude Code reads the token from env var directly.
  cat > "$HOME/.claude/settings.json" <<EOSETTINGS
{
  "permissions": {
    "allow": [],
    "deny": [],
    "additionalDirectories": [],
    "defaultMode": "bypassPermissions"
  },
  "skipDangerousModePermissionPrompt": true,
  "skipWebFetchPreflight": true,
  "env": {
    "HTTPS_PROXY": "${HTTPS_PROXY}"
  }
}
EOSETTINGS
else
  # API key mode: apiKeyHelper echoes the fake key at runtime.
  cat > "$HOME/.claude/settings.json" <<EOSETTINGS
{
  "permissions": {
    "allow": [],
    "deny": [],
    "additionalDirectories": [],
    "defaultMode": "bypassPermissions"
  },
  "apiKeyHelper": "echo \$IRONCURTAIN_API_KEY",
  "skipDangerousModePermissionPrompt": true,
  "skipWebFetchPreflight": true,
  "env": {
    "HTTPS_PROXY": "${HTTPS_PROXY}"
  }
}
EOSETTINGS
fi

# Load system prompt into env var so socat/bash -c doesn't have quoting issues
if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export IRONCURTAIN_SYSTEM_PROMPT
  IRONCURTAIN_SYSTEM_PROMPT=$(cat /etc/ironcurtain/system-prompt.txt)
fi

# Hand off to CMD (sleep infinity for non-PTY, socat PTY command for PTY mode)
exec "$@"
