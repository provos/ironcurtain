/**
 * Unit test for the settings.json auth-mode branch in
 * `docker/entrypoint-claude-code.sh`.
 *
 * The full integration test (`pty-entrypoint.integration.test.ts`) gates on
 * Docker availability and a prebuilt image, so it isn't a viable home for
 * exercising every auth-mode variant. Instead, we extract the settings.json
 * writer portion of the script into a tempdir and run it under bash with
 * controlled environment variables, asserting the produced JSON matches the
 * mode contract:
 *
 * - OAuth (`CLAUDE_CODE_OAUTH_TOKEN`)         → no `apiKeyHelper`
 * - Bearer (`ANTHROPIC_AUTH_TOKEN`)           → no `apiKeyHelper`
 * - API key (neither token env var set)       → `apiKeyHelper` present
 *
 * Catches regressions in the entrypoint's runtime-injected settings.json
 * shape without standing up a container or PTY harness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

/**
 * Snippet extracted from `docker/entrypoint-claude-code.sh` covering only
 * the settings.json branch. Keeps test isolation tight: no UID remap, no
 * socat bridge, no exec. The structure must mirror the production script
 * line-for-line — if you change the entrypoint, update this fixture too.
 */
const SETTINGS_WRITER_SCRIPT = `#!/bin/bash
mkdir -p "$HOME/.claude"

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then
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
    "HTTPS_PROXY": "$HTTPS_PROXY"
  }
}
EOSETTINGS
else
  cat > "$HOME/.claude/settings.json" <<EOSETTINGS
{
  "permissions": {
    "allow": [],
    "deny": [],
    "additionalDirectories": [],
    "defaultMode": "bypassPermissions"
  },
  "apiKeyHelper": "echo \\$IRONCURTAIN_API_KEY",
  "skipDangerousModePermissionPrompt": true,
  "skipWebFetchPreflight": true,
  "env": {
    "HTTPS_PROXY": "$HTTPS_PROXY"
  }
}
EOSETTINGS
fi
`;

function runWriter(env: Record<string, string>, fakeHome: string): Record<string, unknown> {
  const scriptPath = join(fakeHome, 'writer.sh');
  writeFileSync(scriptPath, SETTINGS_WRITER_SCRIPT, { mode: 0o700 });
  execFileSync('bash', [scriptPath], {
    env: { ...env, HOME: fakeHome, HTTPS_PROXY: 'http://127.0.0.1:18080' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const settingsPath = join(fakeHome, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    throw new Error(`settings.json was not written at ${settingsPath}`);
  }
  return JSON.parse(readFileSync(settingsPath, 'utf-8'));
}

describe('entrypoint-claude-code.sh settings.json writer', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'entrypoint-settings-test-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('omits apiKeyHelper when ANTHROPIC_AUTH_TOKEN is set (bearer mode)', () => {
    const settings = runWriter({ ANTHROPIC_AUTH_TOKEN: 'sk-or-v1-test' }, fakeHome);
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.skipWebFetchPreflight).toBe(true);
  });

  it('omits apiKeyHelper when CLAUDE_CODE_OAUTH_TOKEN is set (OAuth mode)', () => {
    const settings = runWriter({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' }, fakeHome);
    expect(settings.apiKeyHelper).toBeUndefined();
  });

  it('emits apiKeyHelper when neither auth-token env var is set (API key mode)', () => {
    const settings = runWriter({}, fakeHome);
    expect(typeof settings.apiKeyHelper).toBe('string');
    expect(settings.apiKeyHelper).toMatch(/IRONCURTAIN_API_KEY/);
  });

  it('emits apiKeyHelper when both env vars are empty strings (treated as unset)', () => {
    const settings = runWriter({ ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '' }, fakeHome);
    expect(typeof settings.apiKeyHelper).toBe('string');
  });
});
