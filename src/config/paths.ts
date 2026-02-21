import { homedir } from 'node:os';
import { resolve } from 'node:path';

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
 * Returns the user constitution file path: {home}/constitution-user.md
 * User policy customizations live in this file, separate from the
 * base constitution (which is version-controlled).
 */
export function getUserConstitutionPath(): string {
  return resolve(getIronCurtainHome(), 'constitution-user.md');
}

/**
 * Returns the user-local generated artifacts directory: {home}/generated/
 * Pipeline commands write here; runtime reads from here first, falling back
 * to the package-bundled defaults in dist/config/generated/.
 */
export function getUserGeneratedDir(): string {
  return resolve(getIronCurtainHome(), 'generated');
}
