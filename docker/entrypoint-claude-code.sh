#!/bin/bash
# Copies runtime-injected MCP config from the orientation mount
# into Claude Code's expected config location, then hands off to CMD.
# Non-PTY mode: CMD is "sleep infinity" (agent commands arrive via docker exec).
# PTY mode: CMD is the socat PTY command from buildPtyCommand().

# Runtime UID/GID remap (Linux only). The shared helper renumbers the
# baked codespace user/group to match the host UID/GID (issue #232) and
# re-execs this entrypoint as codespace. Sourced so it shares this
# script's $0/$@; see the helper for the full rationale (issues #232 and
# #291). No-op on macOS and when already running as codespace.
. /usr/local/bin/ironcurtain-uid-remap.sh

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
# - OpenRouter mode (ANTHROPIC_AUTH_TOKEN set, CLAUDE_CODE_OAUTH_TOKEN not):
#   Claude Code reads the bearer token from ANTHROPIC_AUTH_TOKEN directly, so
#   no apiKeyHelper is written (an apiKeyHelper echoing an empty
#   IRONCURTAIN_API_KEY would compete with the bearer token).
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
elif [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then
  # OpenRouter mode: Claude Code reads the bearer token from ANTHROPIC_AUTH_TOKEN
  # directly -- no apiKeyHelper (which would echo an empty IRONCURTAIN_API_KEY).
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
