import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BundleId } from '../session/types.js';
import { JOB_ID_PATTERN } from '../types/slug.js';

/**
 * Short slug length used in file/directory names that must fit under
 * `sockaddr_un.sun_path` (macOS ~104 bytes, Linux ~108 bytes). 12 hex
 * chars give 16^12 ≈ 2.8e14 combinations, so collisions in the
 * host-wide `~/.ironcurtain/run/<slug>/` namespace are astronomical —
 * important because bundle teardown runs `rmSync(runtimeRoot)` and a
 * collision would wipe another live bundle's sockets. The full UUID
 * remains the authoritative identity in Docker labels and directory
 * paths; only socket-adjacent names use the short form. The new
 * `~/.ironcurtain/run/<12chars>/sockets/<name>.sock` layout has ample
 * sun_path budget for the longer slug on both macOS (104) and Linux
 * (108).
 */
const BUNDLE_SLUG_LEN = 12;

/**
 * Derives the short slug from a `BundleId`. Strips hyphens first so the
 * resulting `BUNDLE_SLUG_LEN` characters are all hex — a raw
 * `substring(0, 12)` on a canonical UUID would include the hyphen at
 * position 8 and yield only 11 hex digits of entropy (16^11 ≈ 1.8e13).
 * 12 hex digits give 16^12 ≈ 2.8e14, matching the collision-space math
 * the layout depends on.
 */
function toBundleSlug(bundleId: BundleId | string): string {
  return bundleId.replace(/-/g, '').substring(0, BUNDLE_SLUG_LEN);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the IronCurtain home directory.
 * Defaults to ~/.ironcurtain, overridable via IRONCURTAIN_HOME env var.
 */
export function getIronCurtainHome(): string {
  return process.env.IRONCURTAIN_HOME ?? resolve(homedir(), '.ironcurtain');
}

/**
 * Returns the sessions base directory: {home}/sessions/
 */
export function getSessionsDir(): string {
  return resolve(getIronCurtainHome(), 'sessions');
}

/**
 * Characters permitted in any identifier that gets embedded in a
 * filesystem path by this module (session IDs, workflow IDs, persona
 * slugs, daemon log names). Rejects path separators, glob
 * metacharacters, NUL bytes, and everything else that could escape the
 * target directory.
 */
const PATH_SAFE_SLUG_RE = /^[a-zA-Z0-9_-]+$/;

function assertPathSafeSlug(kind: string, value: string): void {
  if (!PATH_SAFE_SLUG_RE.test(value)) {
    throw new Error(`Invalid ${kind}: ${value}`);
  }
}

/**
 * Filenames shared across session-scoped and workflow-state-scoped
 * layouts. Centralized so the "single source of truth" for how session
 * artifacts are named does not drift between helpers and call sites.
 */
export const SESSION_LOG_FILENAME = 'session.log';
export const SESSION_METADATA_FILENAME = 'session-metadata.json';
export const SESSION_STATE_FILENAME = 'session-state.json';

/**
 * Validates a workflow state slug of the form `{stateId}.{visitCount}`
 * (e.g., `fetch.1`, `plan.2`). Accepts dot-separated segments where
 * each segment satisfies `PATH_SAFE_SLUG_RE`. Empty segments — produced
 * by `..`, leading or trailing dots — fail the per-segment check.
 */
function assertStateSlug(value: string): void {
  if (value.length === 0) throw new Error(`Invalid state slug: ${value}`);
  for (const segment of value.split('.')) {
    assertPathSafeSlug('state slug segment', segment);
  }
}

/**
 * Returns the session directory for a given session ID:
 *   {home}/sessions/{sessionId}/
 */
export function getSessionDir(sessionId: string): string {
  assertPathSafeSlug('session ID', sessionId);
  return resolve(getSessionsDir(), sessionId);
}

/**
 * Returns the sandbox directory for a given session:
 *   {home}/sessions/{sessionId}/sandbox/
 */
export function getSessionSandboxDir(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'sandbox');
}

/**
 * Returns the escalation IPC directory for a given session:
 *   {home}/sessions/{sessionId}/escalations/
 */
export function getSessionEscalationDir(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'escalations');
}

/**
 * Returns the session metadata path for a given session:
 *   {home}/sessions/{sessionId}/session-metadata.json
 */
export function getSessionMetadataPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), SESSION_METADATA_FILENAME);
}

/**
 * Returns the audit log path for a given session:
 *   {home}/sessions/{sessionId}/audit.jsonl
 */
export function getSessionAuditLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'audit.jsonl');
}

/**
 * Returns the interaction log path for a given session:
 *   {home}/sessions/{sessionId}/interactions.jsonl
 */
export function getSessionInteractionLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'interactions.jsonl');
}

/**
 * Returns the session log path for a given session:
 *   {home}/sessions/{sessionId}/session.log
 */
export function getSessionLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), SESSION_LOG_FILENAME);
}

/**
 * Returns the LLM interaction log path for a given session:
 *   {home}/sessions/{sessionId}/llm-interactions.jsonl
 */
export function getSessionLlmLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'llm-interactions.jsonl');
}

/**
 * Returns the auto-approver LLM interaction log path for a given session:
 *   {home}/sessions/{sessionId}/auto-approve-llm.jsonl
 */
export function getSessionAutoApproveLlmLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'auto-approve-llm.jsonl');
}

/**
 * Returns the sockets directory for a given session:
 *   {home}/sessions/{sessionId}/sockets/
 *
 * This directory is bind-mounted into Docker containers as
 * /run/ironcurtain/ for UDS-based proxy communication.
 * Only this subdirectory is mounted -- not the full session dir.
 */
export function getSessionSocketsDir(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'sockets');
}

/**
 * Returns the session state snapshot path for a given session:
 *   {home}/sessions/{sessionId}/session-state.json
 */
export function getSessionStatePath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), SESSION_STATE_FILENAME);
}

/**
 * Returns the PTY session registry directory:
 *   {home}/pty-registry/
 *
 * PTY sessions write registration files here for the escalation listener.
 */
export function getPtyRegistryDir(): string {
  return resolve(getIronCurtainHome(), 'pty-registry');
}

/**
 * Returns the escalation listener lock file path:
 *   {home}/escalation-listener.lock
 */
export function getListenerLockPath(): string {
  return resolve(getIronCurtainHome(), 'escalation-listener.lock');
}

/**
 * Returns the user config file path: {home}/config.json
 */
export function getUserConfigPath(): string {
  return resolve(getIronCurtainHome(), 'config.json');
}

/**
 * Returns the logs directory: {home}/logs/
 */
export function getLogsDir(): string {
  return resolve(getIronCurtainHome(), 'logs');
}

/**
 * Returns a log file path within the logs directory for a named daemon/process.
 * E.g., getDaemonLogPath('signal-bot') → {home}/logs/signal-bot.log
 */
export function getDaemonLogPath(name: string): string {
  assertPathSafeSlug('daemon log name', name);
  return resolve(getLogsDir(), `${name}.log`);
}

/**
 * Returns the user constitution file path: {home}/constitution-user.md
 * User policy customizations live in this file, separate from the
 * base constitution (which is version-controlled).
 */
export function getUserConstitutionPath(): string {
  return resolve(getIronCurtainHome(), 'constitution-user.md');
}

/**
 * Returns the user-local base constitution path: {home}/constitution.md
 * When this file exists, it replaces the package-bundled constitution.
 */
export function getUserConstitutionBasePath(): string {
  return resolve(getIronCurtainHome(), 'constitution.md');
}

/**
 * Returns the package-bundled base user constitution path.
 * This file ships with IronCurtain and provides sensible defaults
 * (guiding principles) that the customizer builds upon.
 */
export function getBaseUserConstitutionPath(): string {
  return resolve(__dirname, 'constitution-user-base.md');
}

/**
 * Returns the user-local generated artifacts directory: {home}/generated/
 * Pipeline commands write here; runtime reads from here first, falling back
 * to the package-bundled defaults in dist/config/generated/.
 */
export function getUserGeneratedDir(): string {
  return resolve(getIronCurtainHome(), 'generated');
}

/**
 * Returns the package-bundled read-only policy directory.
 * Contains compiled-policy.json derived from constitution-readonly.md.
 * This is always the package version -- not user-local.
 */
export function getReadOnlyPolicyDir(): string {
  return resolve(__dirname, 'generated-readonly');
}

/**
 * Returns the package-bundled config directory.
 * Used to validate that a policyDir is within a trusted location
 * (either the user's IronCurtain home or the package config dir).
 */
export function getPackageConfigDir(): string {
  return resolve(__dirname);
}

/**
 * Reads just the user constitution text (without base principles).
 * Returns empty string if no user constitution file exists, because
 * an absent user constitution is a valid state (means "no server-specific guidance").
 */
export function loadUserConstitutionText(): string {
  const userPath = getUserConstitutionPath();
  const fallbackPath = getBaseUserConstitutionPath();
  if (existsSync(userPath)) {
    return readFileSync(userPath, 'utf-8');
  }
  if (existsSync(fallbackPath)) {
    return readFileSync(fallbackPath, 'utf-8');
  }
  return '';
}

/**
 * Loads the combined constitution text (base + optional user constitution).
 * If ~/.ironcurtain/constitution.md exists, it replaces the package-bundled base.
 * The user extension file (~/.ironcurtain/constitution-user.md), when present,
 * is appended to whichever base is used.
 */
export function loadConstitutionText(packageBasePath: string): string {
  const userBasePath = getUserConstitutionBasePath();
  const basePath = existsSync(userBasePath) ? userBasePath : packageBasePath;
  if (!existsSync(basePath)) {
    throw new Error(`Base constitution not found: tried ${userBasePath} and ${packageBasePath}`);
  }
  const base = readFileSync(basePath, 'utf-8');

  const userPath = getUserConstitutionPath();
  const userFallbackPath = getBaseUserConstitutionPath();
  if (!existsSync(userPath) && !existsSync(userFallbackPath)) {
    throw new Error(`User constitution not found: tried ${userPath} and ${userFallbackPath}`);
  }
  const user = loadUserConstitutionText();
  return `${base}\n\n${user}`;
}

/**
 * Loads the combined constitution and returns its SHA-256 hex digest.
 */
export function computeConstitutionHash(basePath: string): string {
  const text = loadConstitutionText(basePath);
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Returns the user workflows directory: {home}/workflows/
 * Users can place custom workflow definitions here.
 */
export function getUserWorkflowsDir(): string {
  return resolve(getIronCurtainHome(), 'workflows');
}

// ---------------------------------------------------------------------------
// OAuth paths
// ---------------------------------------------------------------------------

/**
 * Validates that a provider ID contains only safe characters
 * (lowercase alphanumeric and hyphens) to prevent path traversal.
 */
function validateProviderId(providerId: string): void {
  if (!/^[a-z0-9-]+$/.test(providerId)) {
    throw new Error(`Invalid provider ID: ${providerId}`);
  }
}

/**
 * Returns the OAuth directory: {home}/oauth/
 * Stores provider credentials and token files.
 */
export function getOAuthDir(): string {
  return resolve(getIronCurtainHome(), 'oauth');
}

/**
 * Returns the token file path for a given provider:
 *   {home}/oauth/{providerId}.json
 */
export function getOAuthTokenPath(providerId: string): string {
  validateProviderId(providerId);
  return resolve(getOAuthDir(), `${providerId}.json`);
}

/**
 * Returns the client credentials file path for a given provider:
 *   {home}/oauth/{providerId}-credentials.json
 */
export function getOAuthCredentialsPath(providerId: string): string {
  validateProviderId(providerId);
  return resolve(getOAuthDir(), `${providerId}-credentials.json`);
}

// ---------------------------------------------------------------------------
// Daemon control socket
// ---------------------------------------------------------------------------

/**
 * Returns the daemon control socket path: {home}/daemon.sock
 *
 * The daemon listens on this Unix domain socket so CLI commands
 * can communicate with a running daemon (e.g., add-job, run-job).
 */
export function getDaemonSocketPath(): string {
  return resolve(getIronCurtainHome(), 'daemon.sock');
}

/**
 * Returns the web UI state file path: {home}/web-ui.json
 *
 * The daemon writes connection info (port + auth token) here on startup
 * so CLI commands (e.g., `observe`) can connect to the WebSocket server.
 * The file is removed on daemon shutdown.
 */
export function getWebUiStatePath(): string {
  return resolve(getIronCurtainHome(), 'web-ui.json');
}

// ---------------------------------------------------------------------------
// Job paths (cron mode)
// ---------------------------------------------------------------------------

/**
 * Returns the jobs base directory: {home}/jobs/
 */
export function getJobsDir(): string {
  return resolve(getIronCurtainHome(), 'jobs');
}

/**
 * Validates that a job ID contains only safe characters.
 */
function validateJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job ID: ${jobId}`);
  }
}

/**
 * Returns the directory for a specific job: {home}/jobs/{jobId}/
 */
export function getJobDir(jobId: string): string {
  validateJobId(jobId);
  return resolve(getJobsDir(), jobId);
}

/**
 * Returns the generated artifacts directory for a job:
 * {home}/jobs/{jobId}/generated/
 */
export function getJobGeneratedDir(jobId: string): string {
  return resolve(getJobDir(jobId), 'generated');
}

/**
 * Returns the workspace directory for a job:
 * {home}/jobs/{jobId}/workspace/
 */
export function getJobWorkspaceDir(jobId: string): string {
  return resolve(getJobDir(jobId), 'workspace');
}

/**
 * Returns the runs directory for a job:
 * {home}/jobs/{jobId}/runs/
 */
export function getJobRunsDir(jobId: string): string {
  return resolve(getJobDir(jobId), 'runs');
}

// ---------------------------------------------------------------------------
// Workflow run paths
// ---------------------------------------------------------------------------

/**
 * Returns the workflow runs base directory: {home}/workflow-runs/
 */
export function getWorkflowRunsDir(): string {
  return resolve(getIronCurtainHome(), 'workflow-runs');
}

/**
 * Returns the directory for a specific workflow run:
 * {home}/workflow-runs/{workflowId}/
 */
export function getWorkflowRunDir(workflowId: string): string {
  assertPathSafeSlug('workflow ID', workflowId);
  return resolve(getWorkflowRunsDir(), workflowId);
}

/**
 * Returns the containers root for a workflow run:
 *   {home}/workflow-runs/{workflowId}/containers/
 *
 * Each bundle (one Docker container + its MITM/Code-Mode proxies, CA,
 * fake keys, audit log, and per-state artifacts) lives under
 * `containers/<bundleId>/`. A single-scope workflow has one entry; a
 * bifurcated workflow with distinct `containerScope` values has one
 * entry per distinct scope.
 */
export function getWorkflowContainersDir(workflowId: string): string {
  return resolve(getWorkflowRunDir(workflowId), 'containers');
}

/**
 * Returns the outer directory for a single bundle within a workflow run:
 *   {home}/workflow-runs/{workflowId}/containers/{bundleId}/
 *
 * Contains the bundle's audit log, its inner `bundle/` directory with
 * sockets/CA/fake keys/orientation, and the per-state `states/` tree.
 */
export function getBundleDir(workflowId: string, bundleId: BundleId): string {
  assertPathSafeSlug('bundle ID', bundleId);
  return resolve(getWorkflowContainersDir(workflowId), bundleId);
}

/**
 * Returns the inner bundle artifact directory:
 *   {home}/workflow-runs/{workflowId}/containers/{bundleId}/bundle/
 *
 * Holds the bundle-scoped files that `DockerInfrastructure` manages:
 * MCP/MITM sockets, CA cert, fake keys, orientation scripts, and the
 * effective system prompt. Bind-mounted into the Docker container for
 * the UDS endpoints.
 */
export function getBundleBundleDir(workflowId: string, bundleId: BundleId): string {
  return resolve(getBundleDir(workflowId, bundleId), 'bundle');
}

/**
 * Returns the per-bundle audit log path:
 *   {home}/workflow-runs/{workflowId}/containers/{bundleId}/audit.jsonl
 *
 * One audit file per bundle (coordinator). Each entry is tagged with
 * the active `persona` so consumers can reconstruct per-persona /
 * per-re-entry slices by scanning.
 */
export function getBundleAuditLogPath(workflowId: string, bundleId: BundleId): string {
  return resolve(getBundleDir(workflowId, bundleId), 'audit.jsonl');
}

/**
 * Returns the per-bundle states root:
 *   {home}/workflow-runs/{workflowId}/containers/{bundleId}/states/
 *
 * Each agent state invocation (including re-entries) that borrows this
 * bundle gets its own subdirectory keyed by `{stateId}.{visitCount}`.
 */
export function getBundleStatesDir(workflowId: string, bundleId: BundleId): string {
  return resolve(getBundleDir(workflowId, bundleId), 'states');
}

/**
 * Returns the per-invocation artifact directory for a single state:
 *   {home}/workflow-runs/{workflowId}/containers/{bundleId}/states/{stateSlug}/
 *
 * Holds this invocation's `session.log` and `session-metadata.json`.
 * `stateSlug` is `{stateId}.{visitCount}` (e.g., `fetch.1`, `plan.2`).
 */
export function getInvocationDir(workflowId: string, bundleId: BundleId, stateSlug: string): string {
  assertStateSlug(stateSlug);
  return resolve(getBundleStatesDir(workflowId, bundleId), stateSlug);
}

/**
 * Returns the coordinator control socket path for a bundle:
 *   {home}/run/{bundleId[0:12]}/ctrl.sock
 *
 * The coordinator listens on this UDS to accept policy hot-swap
 * requests from the orchestrator. The socket sits under the bundle's
 * per-bundle runtime root (mode `0o700`) so filesystem permissions
 * gate access.
 *
 * The directory slug is truncated to 12 chars of `bundleId` so the
 * assembled path fits under macOS `sockaddr_un.sun_path` (104 chars).
 * 16^12 ≈ 2.8e14 combinations — collisions in the host-wide
 * `run/<slug>/` namespace are astronomical.
 */
export function getBundleControlSocketPath(bundleId: BundleId): string {
  return resolve(getBundleRuntimeRoot(bundleId), 'ctrl.sock');
}

// ---------------------------------------------------------------------------
// Per-bundle UDS endpoints (MCP proxy, MITM proxy, MITM control, coordinator)
// ---------------------------------------------------------------------------
//
// Every UDS file owned by a bundle lives under a single per-bundle root
// at `~/.ironcurtain/run/<bundleId[0:12]>/`. The directory is created
// with `0o700` (see `docker-infrastructure.ts`), inheriting the same
// security posture as the rest of the IronCurtain home. Worst-case
// assembled path (with a 20-char username) is about 76 bytes —
// comfortably under macOS 104 and Linux 108 `sockaddr_un.sun_path` caps.
//
// Three locations per bundle:
//   run/<bid12>/ctrl.sock             → coordinator control socket
//   run/<bid12>/sockets/              → bind-mounted as /run/ironcurtain/
//   run/<bid12>/host/                 → host-local only (MITM control)
// The `sockets/` vs `host/` split keeps the bind-mounted endpoints
// separate from host-only endpoints so `isEndpointAllowed` is not the
// only thing standing between the container and the MITM control API.

/**
 * Returns the per-bundle runtime root directory:
 *   {home}/run/{bundleId[0:12]}/
 *
 * Holds the coordinator control socket plus two subdirectories
 * (`sockets/` and `host/`) so the bind-mounted UDS files can be
 * co-located without exposing host-only sockets to the container.
 */
export function getBundleRuntimeRoot(bundleId: BundleId): string {
  assertPathSafeSlug('bundle ID', bundleId);
  return resolve(getIronCurtainHome(), 'run', toBundleSlug(bundleId));
}

/**
 * Returns the per-bundle container-visible sockets directory:
 *   {home}/run/{bundleId[0:12]}/sockets/
 *
 * Two UDS files live here:
 *  - `proxy.sock`      (Code Mode proxy — bind-mounted into container)
 *  - `mitm-proxy.sock` (MITM proxy      — bind-mounted into container)
 *
 * This directory is what `prepareDockerInfrastructure()` bind-mounts as
 * `/run/ironcurtain/` inside the container (read-write). Only these two
 * socket files live here — no audit logs, escalation files, or other
 * session artifacts.
 */
export function getBundleSocketsDir(bundleId: BundleId): string {
  return resolve(getBundleRuntimeRoot(bundleId), 'sockets');
}

/**
 * Returns the per-bundle host-only directory:
 *   {home}/run/{bundleId[0:12]}/host/
 *
 * Holds UDS files that must NOT be visible to the container
 * (currently just the MITM control socket).
 */
export function getBundleHostOnlyDir(bundleId: BundleId): string {
  return resolve(getBundleRuntimeRoot(bundleId), 'host');
}

/**
 * Code Mode proxy UDS path for a bundle:
 *   {home}/run/{bundleId[0:12]}/sockets/proxy.sock
 *
 * Bound by the host-side Code Mode proxy; reachable inside the
 * container as `/run/ironcurtain/proxy.sock` via the bind mount on
 * `getBundleSocketsDir()`.
 */
export function getBundleProxySocketPath(bundleId: BundleId): string {
  return resolve(getBundleSocketsDir(bundleId), 'proxy.sock');
}

/**
 * MITM proxy UDS path for a bundle:
 *   {home}/run/{bundleId[0:12]}/sockets/mitm-proxy.sock
 *
 * Bound by the host-side MITM proxy; reachable inside the container as
 * `/run/ironcurtain/mitm-proxy.sock` via the bind mount on
 * `getBundleSocketsDir()`.
 */
export function getBundleMitmProxySocketPath(bundleId: BundleId): string {
  return resolve(getBundleSocketsDir(bundleId), 'mitm-proxy.sock');
}

/**
 * MITM control UDS path for a bundle:
 *   {home}/run/{bundleId[0:12]}/host/mitm-control.sock
 *
 * Host-local only — lives under `host/` rather than `sockets/` so the
 * bind mount that exposes `sockets/` at `/run/ironcurtain/` does not
 * expose this socket to the container.
 */
export function getBundleMitmControlSocketPath(bundleId: BundleId): string {
  return resolve(getBundleHostOnlyDir(bundleId), 'mitm-control.sock');
}
