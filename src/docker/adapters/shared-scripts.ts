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

  let buildNetworkGuidance: string;
  switch (context.nestedDocker.networkAccess) {
    case 'packages':
      buildNetworkGuidance = `

#### Docker builds in Packages mode

Dockerfile \`FROM\` and image pulls use IronCurtain's separate Docker Hub/GHCR
registry mediation. For npm, PyPI/pip, Debian apt, and Cargo downloads from
Dockerfile \`RUN\` steps, use one of these supported direct build commands so
IronCurtain can select the package proxy and supported build network:

- \`docker build ...\`
- \`docker image build ...\`
- \`docker builder build ...\`
- \`docker buildx build ...\` with the local default Docker driver

Package HTTPS is terminated by IronCurtain and re-encrypted upstream. Supported
build steps receive the session CA in common system trust stores; clients with
private trust stores may still fail. Arbitrary \`curl\`/\`wget\` URLs, Git and
installer-script downloads, private or authenticated package sources, and
credentials are unsupported. IronCurtain does not inject credentials, and
recognized credential fields, request bodies, and uploads are rejected.

Compose can build implicitly. \`docker compose build\`, \`docker compose up\` or
\`create\` without the exact \`--no-build\` flag, and \`docker compose run\` are
unsupported. Build directly first, then use \`docker compose up --no-build\` or
\`docker compose create --no-build\`; use \`docker run\` for one-off containers.
Compose watch and navigation-menu controls are unsupported because they can
trigger rebuilds. Direct \`docker-buildx\`, \`docker-compose\`, remote contexts,
remote BuildKit daemons, and custom builders are also unsupported.

The wrapper supplies \`--network=host\` only to supported build commands so
\`RUN\` can reach the VM-local package proxy. An explicit
\`docker build --network=none ...\` is a cooperative per-build offline opt-out;
it is not an operator-enforced session policy. Bypassing the wrapper loses
automatic package proxy and network selection but creates no direct internet
route.

Packages is bundle-wide authority, not trusted build identity. Any process in
this nested-Docker session can send bounded workspace or build data through
allowed package paths, permitted request metadata, and timing to fixed public
repositories. A public repository may relay or hairpin elsewhere.
Package responses, caches, built images, and image contents remain untrusted.`;
      break;
    case 'images':
      buildNetworkGuidance = `

#### Docker builds in Images mode

Dockerfile \`FROM\` and image pulls from Docker Hub/GHCR use IronCurtain's
registry mediation. Dockerfile \`RUN\` steps have no package network access.`;
      break;
    case 'offline':
      buildNetworkGuidance = `

#### Docker builds in Offline mode

Only locally available images and hermetic builds work. On Docker Desktop the
private image store starts empty; load an archive already under \`/workspace\`
with \`docker image load --input /workspace/<archive>.tar\`.
Dockerfile \`FROM\` cannot pull an absent image, and Dockerfile \`RUN\` steps
have no package network access.`;
      break;
  }

  return `### Nested Docker
A private Docker daemon is available through \`DOCKER_HOST\`. IronCurtain has
created the internal network exported as \`IRONCURTAIN_DOCKER_NETWORK\`
(\`${context.nestedDocker.networkName}\`). Attach every service and sibling
container to that network so Docker's embedded DNS resolves container names.

Example:
  \`docker run -d --name target --network "$IRONCURTAIN_DOCKER_NETWORK" <service-image>\`
  \`docker run --rm --network "$IRONCURTAIN_DOCKER_NETWORK" <client-image> http://target:<port>/\`

For Compose services that use already available images, use the existing
network as the default:
  \`networks:\`
  \`  default:\`
  \`    external: true\`
  \`    name: \${IRONCURTAIN_DOCKER_NETWORK}\`

The nested daemon has no default bridge. For runtime containers, do not use
\`-p\`/\`--publish\` or \`docker run --network host\`; neither exposes an inner
service to the Mac. The Mac host and the agent shell cannot reach an inner
service through \`localhost\`. Connect from a sibling container by service name
or network alias instead. This is the supported service topology, not a
security boundary: the agent has Docker administrator authority over its
bundle-local daemon.${buildNetworkGuidance}`;
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
