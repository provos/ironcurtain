/**
 * Verifies that `mcp-proxy-server.ts` does not construct an `AuditLog`
 * or write any audit file in its CWD. The subprocess is a pure
 * pass-through relay; the coordinator in the parent process owns the
 * audit log.
 *
 * The subprocess is expected to start up, listen for MCP messages on
 * stdio, and exit on SIGTERM or controlling-stdio EOF without writing
 * any audit file in its CWD. This is an outside-in integration test: it
 * spawns the actual proxy binary and asserts on process and filesystem
 * side-effects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
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

function waitForClose(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => rejectClose(new Error(`proxy did not exit within ${timeoutMs}ms`)), timeoutMs);
    proc.once('close', (code) => {
      clearTimeout(timer);
      resolveClose(code);
    });
    proc.once('error', (error) => {
      clearTimeout(timer);
      rejectClose(error);
    });
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`backend process ${pid} did not exit within ${timeoutMs}ms`);
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

  it('treats controlling-stdio EOF as parent death and reaps its backend', async () => {
    const backendPidPath = join(workDir, 'backend.pid');
    const backendScript = `
      const { writeFileSync } = require('node:fs');
      writeFileSync(process.env.IRONCURTAIN_TEST_BACKEND_PID_FILE, String(process.pid));
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        input += chunk;
        for (;;) {
          const newline = input.indexOf('\\n');
          if (newline < 0) break;
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === undefined) continue;
          const result = message.method === 'initialize'
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'eof-reaping-fixture', version: '1.0.0' },
              }
            : message.method === 'tools/list'
              ? { tools: [] }
              : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
        }
      });
    `;
    const env: Record<string, string> = {
      MCP_SERVERS_CONFIG: JSON.stringify({
        fixture: {
          command: process.execPath,
          args: ['-e', backendScript],
          env: { IRONCURTAIN_TEST_BACKEND_PID_FILE: backendPidPath },
          sandbox: false,
        },
      }),
      SERVER_FILTER: 'fixture',
      GENERATED_DIR: policyDir,
      SANDBOX_POLICY: 'warn',
    };
    const proc = spawnProxy(env, workDir);
    let backendPid: number | undefined;

    try {
      await waitForFile(backendPidPath, 5_000);
      backendPid = Number.parseInt(readFileSync(backendPidPath, 'utf8'), 10);
      expect(backendPid).toBeGreaterThan(0);

      // The relay performs its backend handshake before it starts the
      // parent-facing stdio transport. Closing this pipe models a parent that
      // vanished without delivering SIGINT/SIGTERM to the relay.
      proc.stdin?.end();
      await expect(waitForClose(proc, 5_000)).resolves.toBe(0);
      await expect(waitForProcessExit(backendPid, 2_000)).resolves.toBeUndefined();
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      if (backendPid !== undefined) {
        try {
          process.kill(backendPid, 'SIGKILL');
        } catch {
          // The backend exited between the final assertion and cleanup.
        }
      }
    }
  }, 15_000);
});
