#!/bin/bash
# IronCurtain entrypoint for Codex CLI containers.

# Runtime UID remap (Linux only). See entrypoint-claude-code.sh for the
# detailed rationale.
if [ "$(id -u)" = "0" ] && [ -n "$IRONCURTAIN_AGENT_UID" ] && [ -n "$IRONCURTAIN_AGENT_GID" ]; then
  if [ "$IRONCURTAIN_AGENT_UID" != "1000" ] || [ "$IRONCURTAIN_AGENT_GID" != "1000" ]; then
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
