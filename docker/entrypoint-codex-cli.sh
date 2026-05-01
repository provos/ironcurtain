#!/bin/bash
# Copies runtime-injected Codex config into place and starts the container.

MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

mkdir -p "$HOME/.codex"
if [ -f /etc/ironcurtain/codex-config.toml ]; then
  cp /etc/ironcurtain/codex-config.toml "$HOME/.codex/config.toml"
fi

if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export CODEX_HOME_INSTRUCTIONS
  CODEX_HOME_INSTRUCTIONS=$(cat /etc/ironcurtain/system-prompt.txt)
fi

exec "$@"

