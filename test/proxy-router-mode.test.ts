/**
 * Verifies that `mcp-proxy-server.ts` does not construct an `AuditLog`
 * or write any audit file in its CWD. The subprocess is a pure
 * pass-through relay; the coordinator in the parent process owns the
 * audit log.
 *
 * The subprocess is expected to start up, listen for MCP messages on
 * stdio, and exit on SIGTERM without writing any audit file in its
 * CWD. This is an outside-in integration test: it spawns the actual
 * proxy binary and asserts on filesystem side-effects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const proxyServerPath = resolve(projectRoot, 'src/trusted-process/mcp-proxy-server.ts');
const tsxBin = resolve(projectRoot, 'node_modules/.bin/tsx');

/**
 * Writes a minimal compiled-policy + tool-annotations pair into a
 * directory so `loadGeneratedPolicy` can find both files.
 */
function writeFakePolicyDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compiled-policy.json'), JSON.stringify({ version: 1, inputHash: 'test', rules: [] }));
  writeFileSync(join(dir, 'tool-annotations.json'), JSON.stringify({ servers: {} }));
}

/** Spawns the proxy server and returns the ChildProcess. */
function spawnProxy(env: Record<string, string>, cwd: string): ChildProcess {
  return spawn(tsxBin, [proxyServerPath], {
    env: { ...env, PATH: process.env.PATH ?? '' },
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('mcp-proxy-server pass-through mode', () => {
  let workDir: string;
  let policyDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ironcurtain-router-cwd-'));
    policyDir = mkdtempSync(join(tmpdir(), 'ironcurtain-router-policy-'));
    writeFakePolicyDir(policyDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(policyDir, { recursive: true, force: true });
  });

  it('does NOT create ./audit.jsonl in the CWD', async () => {
    // Subprocess with no backend servers -- exercises the bootstrap
    // path without requiring MCP connectivity. The subprocess should
    // never construct an AuditLog.
    const env: Record<string, string> = {
      MCP_SERVERS_CONFIG: JSON.stringify({}),
      GENERATED_DIR: policyDir,
    };

    const proc = spawnProxy(env, workDir);

    try {
      // Give the subprocess time to reach the point where (pre-fix)
      // it would have constructed an AuditLog. The bootstrap runs
      // synchronously to that point, so 750ms is generous.
      await new Promise((r) => setTimeout(r, 750));

      const entries = readdirSync(workDir);
      expect(entries).not.toContain('audit.jsonl');
      // Defensive: the specific absolute path.
      expect(existsSync(join(workDir, 'audit.jsonl'))).toBe(false);
    } finally {
      proc.kill('SIGTERM');
      await new Promise((r) => {
        proc.once('exit', () => r(undefined));
        setTimeout(() => r(undefined), 2000);
      });
    }
  }, 15000);
});
