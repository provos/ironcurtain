import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  let effectiveUserPath: string;
  if (existsSync(userPath)) {
    effectiveUserPath = userPath;
  } else if (existsSync(userFallbackPath)) {
    effectiveUserPath = userFallbackPath;
  } else {
    throw new Error(`User constitution not found: tried ${userPath} and ${userFallbackPath}`);
  }
  const user = readFileSync(effectiveUserPath, 'utf-8');
  return `${base}\n\n${user}`;
}

/**
 * Loads the combined constitution and returns its SHA-256 hex digest.
 */
export function computeConstitutionHash(basePath: string): string {
  const text = loadConstitutionText(basePath);
  return createHash('sha256').update(text).digest('hex');
}
