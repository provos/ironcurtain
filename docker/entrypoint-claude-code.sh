#!/bin/bash
# Copies runtime-injected MCP config from the orientation mount
# into Claude Code's expected config location, then idles.
# Agent commands are executed via `docker exec`.

# Bridge UDS to local TCP so HTTPS_PROXY works
CONNECT_SOCK="/run/ironcurtain/connect-proxy.sock"
PROXY_PORT=18080
if [ -S "$CONNECT_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$CONNECT_SOCK &
fi

# Idle — agent commands arrive via docker exec
exec sleep infinity
