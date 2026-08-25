/**
 * Shared shell script generators and prompt sections used by multiple agent adapters.
 *
 * These are extracted to avoid duplication between the Claude Code and Goose adapters.
 */

import type { OrientationContext } from '../agent-adapter.js';

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

/** Workspace and external-access orientation shared by every agent adapter. */
export function buildWorkspaceAccessSection(
  context: OrientationContext,
  localTools: string,
  externalTools: string,
): string {
  return `### Workspace
Your workspace is \`${context.workspaceDir}\`. It is backed by the host workspace.
Always refer to workspace files as \`${context.workspaceDir}/...\`.
Use ${localTools} for all operations there, including after cloning or writing
through ${externalTools}. Clone repositories into \`${context.workspaceDir}\`.

### External operations
The container has no direct internet access. Use ${externalTools} only for network
requests, git remote operations, or files outside \`${context.workspaceDir}\`.`;
}

/**
 * Nested-Docker orientation shared by every agent adapter. The section is
 * capability-gated so ordinary sessions are never told that a Docker daemon
 * or its managed network exists.
 */
export function buildNestedDockerSection(context: OrientationContext): string {
  if (context.nestedDocker === undefined) return '';

  return `### Nested Docker
A private Docker daemon is available through \`DOCKER_HOST\`. IronCurtain has
created the internal network exported as \`IRONCURTAIN_DOCKER_NETWORK\`
(\`${context.nestedDocker.networkName}\`). Attach every service and sibling
container to that network so Docker's embedded DNS resolves container names.

Example:
  \`docker run -d --name target --network "$IRONCURTAIN_DOCKER_NETWORK" <service-image>\`
  \`docker run --rm --network "$IRONCURTAIN_DOCKER_NETWORK" <client-image> http://target:<port>/\`

For Compose, use the existing network as the default:
  \`networks:\`
  \`  default:\`
  \`    external: true\`
  \`    name: \${IRONCURTAIN_DOCKER_NETWORK}\`

The nested daemon has no default bridge. Do not use \`-p\`/\`--publish\` or
\`--network host\`; neither exposes an inner service to the Mac. The Mac host
and the agent shell cannot reach an inner service through \`localhost\`.
Connect from a sibling container by service name or network alias instead.
This is the supported service topology, not a security boundary: the agent has
Docker administrator authority over its bundle-local daemon.`;
}

/**
 * Policy enforcement section. `callType` describes what is being evaluated
 * (e.g. "tool call through `execute_code`" or "MCP tool call").
 */
export function buildPolicySection(callType: string): string {
  return `### Policy
Each ${callType} may be allowed, denied, or escalated for human approval. Do not retry denials.`;
}

/**
 * Attribution section (identical for all agents).
 */
export function buildAttributionSection(): string {
  return `### Attribution
When adding attribution (for example, Co-Authored-By), say the tool ran under IronCurtain.`;
}
