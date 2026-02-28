#!/bin/bash
# Copies runtime-injected MCP config from the orientation mount
# into Claude Code's expected config location, then hands off to CMD.
# Non-PTY mode: CMD is "sleep infinity" (agent commands arrive via docker exec).
# PTY mode: CMD is the socat PTY command from buildPtyCommand().

# Bridge UDS to local TCP so HTTPS_PROXY works
MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

# Hand off to CMD (sleep infinity for non-PTY, socat PTY command for PTY mode)
exec "$@"
