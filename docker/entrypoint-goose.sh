#!/bin/bash
# IronCurtain entrypoint for Goose containers.
# Sets up proxy bridges, writes Goose config, then hands off to CMD.

# Runtime UID remap (Linux only). See entrypoint-claude-code.sh for the
# full rationale (issue #232). Skipped on macOS where Docker Desktop
# translates UIDs and the env vars are not set.
if [ "$(id -u)" = "0" ] && [ -n "$IRONCURTAIN_AGENT_UID" ] && [ -n "$IRONCURTAIN_AGENT_GID" ]; then
  if [ "$IRONCURTAIN_AGENT_UID" != "1000" ] || [ "$IRONCURTAIN_AGENT_GID" != "1000" ]; then
    # Fail hard on remap errors — see entrypoint-claude-code.sh for the
    # full rationale. Without explicit checks, a UID collision (host UID
    # already in use by a system user baked into the image) silently
    # recreates the original issue #232 bug.
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
  exec runuser -u codespace -- "$0" "$@"
fi

# 1. Bridge MITM proxy UDS to local TCP (same as Claude Code entrypoint)
MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

# 2. Copy MCP config from orientation mount to Goose's expected location.
# The orientation dir is read-only mounted at /etc/ironcurtain/.
GOOSE_CONFIG_DIR="$HOME/.config/goose"
mkdir -p "$GOOSE_CONFIG_DIR"
if [ -f /etc/ironcurtain/goose-config.yaml ]; then
  cp /etc/ironcurtain/goose-config.yaml "$GOOSE_CONFIG_DIR/config.yaml"
fi

# 3. Load system prompt into env var for PTY mode scripts.
# Non-PTY mode injects the prompt via --instructions per turn.
if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export IRONCURTAIN_SYSTEM_PROMPT
  IRONCURTAIN_SYSTEM_PROMPT=$(cat /etc/ironcurtain/system-prompt.txt)
fi

# 4. Hand off to CMD
# Non-PTY: CMD = "sleep infinity" (agent commands arrive via docker exec)
# PTY:     CMD = socat PTY command from buildPtyCommand()
exec "$@"
