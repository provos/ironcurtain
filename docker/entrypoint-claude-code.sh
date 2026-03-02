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

# Pre-seed .claude.json so Claude Code skips onboarding, trusts /workspace,
# and doesn't prompt for API key approval.
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

# Configure settings.json:
# - skipDangerousModePermissionPrompt: suppresses the bypass-permissions warning
# Auth mode determines how Claude Code gets its API credentials:
# - OAuth mode (CLAUDE_CODE_OAUTH_TOKEN set): Claude Code reads the token from
#   this env var directly -- no apiKeyHelper needed.
# - API key mode: apiKeyHelper echoes the fake key so Claude Code skips the
#   custom API key approval dialog entirely.
mkdir -p "$HOME/.claude"

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
  # OAuth mode: Claude Code reads the token from env var directly.
  cat > "$HOME/.claude/settings.json" <<'EOSETTINGS'
{
  "permissions": {
    "allow": [],
    "deny": [],
    "additionalDirectories": [],
    "defaultMode": "bypassPermissions"
  },
  "skipDangerousModePermissionPrompt": true
}
EOSETTINGS
else
  # API key mode: apiKeyHelper echoes the fake key at runtime.
  cat > "$HOME/.claude/settings.json" <<'EOSETTINGS'
{
  "permissions": {
    "allow": [],
    "deny": [],
    "additionalDirectories": [],
    "defaultMode": "bypassPermissions"
  },
  "apiKeyHelper": "echo $IRONCURTAIN_API_KEY",
  "skipDangerousModePermissionPrompt": true
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
