#!/bin/bash
# IronCurtain entrypoint for Codex CLI containers.

# Runtime UID/GID remap (Linux only). Shared with the other agent
# entrypoints so the remap logic cannot drift (issues #232 and #291).
# Sourced so it shares this script's $0/$@; no-op on macOS and when
# already running as codespace.
. /usr/local/bin/ironcurtain-uid-remap.sh

MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

CODEX_CONFIG_DIR="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "$CODEX_CONFIG_DIR"
if [ -f /etc/ironcurtain/codex-config.toml ]; then
  cp /etc/ironcurtain/codex-config.toml "$CODEX_CONFIG_DIR/config.toml"
fi
if [ -n "$IRONCURTAIN_CODEX_ACCESS_TOKEN" ] && [ -n "$IRONCURTAIN_CODEX_ID_TOKEN" ]; then
  cat > "$CODEX_CONFIG_DIR/auth.json" <<EOJSON
{
  "auth_mode": "chatgptAuthTokens",
  "tokens": {
    "id_token": "$IRONCURTAIN_CODEX_ID_TOKEN",
    "access_token": "$IRONCURTAIN_CODEX_ACCESS_TOKEN",
    "refresh_token": "",
    "account_id": "${IRONCURTAIN_CODEX_ACCOUNT_ID:-ironcurtain-account}"
  },
  "last_refresh": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOJSON
  chmod 600 "$CODEX_CONFIG_DIR/auth.json"
fi

if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export IRONCURTAIN_SYSTEM_PROMPT
  IRONCURTAIN_SYSTEM_PROMPT=$(cat /etc/ironcurtain/system-prompt.txt)
fi

exec "$@"
