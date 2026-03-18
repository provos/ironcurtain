/**
 * Google Workspace credential file management.
 *
 * Writes credential files in the format expected by
 * @alanse/mcp-server-google-workspace's auth.ts.
 *
 * SECURITY: The refresh_token field is intentionally omitted.
 * This prevents the MCP server from independently refreshing tokens,
 * which would cause refresh token rotation races in multi-session
 * environments. IronCurtain's OAuthTokenProvider is the sole token
 * authority.
 *
 * The file is written atomically (write to .tmp, rename) to prevent
 * the MCP server from reading a partial file during a refresh cycle.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The filename the MCP server expects in its GWORKSPACE_CREDS_DIR. */
export const GWORKSPACE_CREDENTIAL_FILENAME = '.gworkspace-credentials.json';

/**
 * Shape of the credential file read by the MCP server's auth.ts.
 * Mirrors the subset of Google OAuth2 token response that the server needs.
 */
export interface GWorkspaceCredentialFile {
  readonly access_token: string;
  readonly expiry_date: number;
  readonly token_type: 'Bearer';
  readonly scope: string;
  // NOTE: refresh_token intentionally omitted.
  // See design doc: docs/designs/google-workspace-integration.md
}

/**
 * Writes a Google Workspace credential file for the MCP server.
 *
 * Creates the directory if it does not exist. Writes atomically via
 * a temporary file + rename to prevent the MCP server from reading
 * a partial file. File permissions are set to 0o600 (owner-only).
 *
 * @param credsDir - Directory to write the credential file into
 * @param accessToken - OAuth2 access token (short-lived)
 * @param expiresAt - Token expiry timestamp in milliseconds since epoch
 * @param scopes - OAuth2 scopes granted to this token
 */
export function writeGWorkspaceCredentialFile(
  credsDir: string,
  accessToken: string,
  expiresAt: number,
  scopes: readonly string[],
): void {
  mkdirSync(credsDir, { recursive: true });

  const credential: GWorkspaceCredentialFile = {
    access_token: accessToken,
    expiry_date: expiresAt,
    token_type: 'Bearer',
    scope: scopes.join(' '),
  };

  const filePath = join(credsDir, GWORKSPACE_CREDENTIAL_FILENAME);
  const tmpPath = filePath + '.tmp';

  writeFileSync(tmpPath, JSON.stringify(credential, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
