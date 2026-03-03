/**
 * Shared shell script generators and prompt sections used by multiple agent adapters.
 *
 * These are extracted to avoid duplication between the Claude Code and Goose adapters.
 */

// ─── PTY Shell Scripts ──────────────────────────────────────

/**
 * Generates a resize-pty.sh script parameterized by the agent's process name.
 * Called from the host via: docker exec <cid> /etc/ironcurtain/resize-pty.sh <cols> <rows>
 */
export function buildResizePtyScript(processName: string): string {
  const varPrefix = processName.toUpperCase().replace(/-/g, '_');
  return `#!/bin/bash
# Called from the host via: docker exec <cid> /etc/ironcurtain/resize-pty.sh <cols> <rows>
COLS=$1
ROWS=$2

${varPrefix}_PID=$(pgrep -x ${processName} | head -1)
if [ -z "$${varPrefix}_PID" ]; then
  echo "no-${processName}" >&2
  exit 0
fi

PTS=$(readlink /proc/$${varPrefix}_PID/fd/0 2>/dev/null)
if [ -z "$PTS" ] || ! [ -e "$PTS" ]; then
  echo "no-pty pid=$${varPrefix}_PID pts=$PTS" >&2
  exit 0
fi

stty -F "$PTS" cols "$COLS" rows "$ROWS" 2>/dev/null
RC=$?
kill -WINCH "$${varPrefix}_PID" 2>/dev/null
echo "ok pid=$${varPrefix}_PID pts=$PTS stty=$RC \${COLS}x\${ROWS}" >&2
`;
}

/**
 * Generates a check-pty-size.sh script parameterized by the agent's process name.
 * Returns "rows cols" of the container PTY.
 */
export function buildCheckPtySizeScript(processName: string): string {
  const varPrefix = processName.toUpperCase().replace(/-/g, '_');
  return `#!/bin/bash
# Returns "rows cols" of the container PTY
${varPrefix}_PID=$(pgrep -x ${processName} | head -1)
if [ -z "$${varPrefix}_PID" ]; then echo "0 0"; exit 0; fi
PTS=$(readlink /proc/$${varPrefix}_PID/fd/0 2>/dev/null)
if [ -z "$PTS" ] || ! [ -e "$PTS" ]; then echo "0 0"; exit 0; fi
stty -F "$PTS" size 2>/dev/null || echo "0 0"
`;
}

// ─── Shared Docker Environment Prompt Sections ──────────────

/**
 * Network restriction section. `toolReference` describes how to access network
 * (e.g. "the sandbox tools via `execute_code`" or "the IronCurtain MCP tools").
 */
export function buildNetworkSection(toolReference: string): string {
  return `### Network
The container has NO direct internet access. All HTTP requests and
git operations MUST go through ${toolReference}.`;
}

/**
 * Policy enforcement section. `callType` describes what is being evaluated
 * (e.g. "tool call through `execute_code`" or "MCP tool call").
 */
export function buildPolicySection(callType: string): string {
  return `### Policy Enforcement
Every ${callType} is evaluated against security policy rules:
- **Allowed**: proceeds automatically
- **Denied**: blocked -- do NOT retry denied operations
- **Escalated**: requires human approval -- you will receive the result once approved`;
}

/**
 * Attribution section (identical for all agents).
 */
export function buildAttributionSection(): string {
  return `### Attribution
When adding attribution lines (e.g. Co-Authored-By, "Generated with"), include
"running under IronCurtain" alongside the tool name.`;
}
