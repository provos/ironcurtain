#!/bin/bash
# IronCurtain entrypoint for Goose containers.
# Sets up proxy bridges, writes Goose config, then hands off to CMD.

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
