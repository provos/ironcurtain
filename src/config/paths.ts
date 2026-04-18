import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_STATE_FILENAME } from '../docker/pty-types.js';

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
 * Validates that a session ID contains only safe characters
 * (alphanumeric, hyphens, underscores) to prevent path traversal.
 */
function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
}

/**
 * Returns the session directory for a given session ID:
 *   {home}/sessions/{sessionId}/
 */
export function getSessionDir(sessionId: string): string {
  validateSessionId(sessionId);
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
  return resolve(getSessionDir(sessionId), 'session-metadata.json');
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
  return resolve(getSessionDir(sessionId), 'session.log');
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
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid daemon log name: ${name}`);
  }
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

import { JOB_ID_PATTERN } from '../cron/types.js';

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
 * Validates that a workflow ID contains only safe characters
 * (alphanumeric, hyphens, underscores) to prevent path traversal.
 */
function validateWorkflowId(workflowId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(workflowId)) {
    throw new Error(`Invalid workflow ID: ${workflowId}`);
  }
}

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
  validateWorkflowId(workflowId);
  return resolve(getWorkflowRunsDir(), workflowId);
}

/**
 * Returns the coordinator control socket path for a workflow run:
 *   {home}/workflow-runs/{workflowId}/proxy-control.sock
 *
 * The coordinator listens on this UDS to accept policy hot-swap
 * requests from the workflow orchestrator. The socket sits inside
 * the workflow run's private directory (mode `0o700`) so no
 * additional auth is needed -- filesystem permissions gate access.
 */
export function getWorkflowProxyControlSocketPath(workflowId: string): string {
  return resolve(getWorkflowRunDir(workflowId), 'proxy-control.sock');
}
