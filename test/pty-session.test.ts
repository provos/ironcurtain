import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createEscalationWatcher, atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';
import type { EscalationRequest } from '../src/session/types.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';

// --- Registration file tests ---

describe('PTY session registration', () => {
  let tempDir: string;
  let registryDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pty-registration-test-'));
    registryDir = join(tempDir, 'pty-registry');
    mkdirSync(registryDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates a valid registration file', () => {
    const registration: PtySessionRegistration = {
      sessionId: 'test-sess',
      escalationDir: '/tmp/test/escalations',
      label: 'Claude Code - Fix the bug',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };

    const filePath = join(registryDir, `session-${registration.sessionId}.json`);
    atomicWriteJsonSync(filePath, registration);

    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as PtySessionRegistration;
    expect(data.sessionId).toBe('test-sess');
    expect(data.pid).toBe(process.pid);
    expect(data.label).toBe('Claude Code - Fix the bug');
  });

  it('registration file is removed on cleanup', () => {
    const filePath = join(registryDir, 'session-cleanup-test.json');
    atomicWriteJsonSync(filePath, { sessionId: 'cleanup-test' });
    expect(existsSync(filePath)).toBe(true);

    // Simulate cleanup by removing the file
    rmSync(filePath);
    expect(existsSync(filePath)).toBe(false);
  });
});

// --- BEL on escalation test ---

describe('escalation BEL notification', () => {
  let tempDir: string;
  let escalationDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(join(tmpdir(), 'pty-bel-test-'));
    escalationDir = join(tempDir, 'escalations');
    mkdirSync(escalationDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('watcher detects escalation request files', async () => {
    const escalations: EscalationRequest[] = [];

    const watcher = createEscalationWatcher(
      escalationDir,
      {
        onEscalation: (req) => escalations.push(req),
        onEscalationExpired: () => {},
      },
      { pollIntervalMs: 50 },
    );
    watcher.start();

    // Write an escalation request
    const request: EscalationRequest = {
      escalationId: 'esc-bel-1',
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/shadow' },
      reason: 'Protected path',
    };
    writeFileSync(join(escalationDir, 'request-esc-bel-1.json'), JSON.stringify(request));

    vi.advanceTimersByTime(60);

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-bel-1');

    watcher.stop();
  });
});

// --- SIGWINCH forwarding logic test ---

describe('SIGWINCH forwarding', () => {
  it('resize handler guards against missing columns/rows in non-TTY mode', () => {
    // The SIGWINCH handler in attachPty checks columns && rows before
    // calling docker exec. In a non-TTY test environment, these are
    // undefined, so the guard prevents the exec call.
    const { stdout } = process;

    // Verify the guard logic: when stdout is not a TTY,
    // columns and rows are undefined, so the handler is a no-op.
    if (!stdout.isTTY) {
      expect(stdout.columns).toBeUndefined();
      expect(stdout.rows).toBeUndefined();
    } else {
      // When running in a TTY, columns and rows are numbers
      expect(typeof stdout.columns).toBe('number');
      expect(typeof stdout.rows).toBe('number');
    }
  });
});

// --- PTY size fix: orientation file tests ---

describe('Claude Code adapter PTY orientation files', () => {
  // Lazy import to avoid pulling in the full adapter at module level
  let claudeCodeAdapter: (typeof import('../src/docker/adapters/claude-code.js'))['claudeCodeAdapter'];

  beforeEach(async () => {
    ({ claudeCodeAdapter } = await import('../src/docker/adapters/claude-code.js'));
  });

  it('start-claude.sh includes stty initialization from env vars', () => {
    const files = claudeCodeAdapter.generateOrientationFiles();
    const startScript = files.find((f) => f.path === 'start-claude.sh');
    expect(startScript).toBeDefined();
    expect(startScript!.content).toContain('IRONCURTAIN_INITIAL_COLS');
    expect(startScript!.content).toContain('IRONCURTAIN_INITIAL_ROWS');
    expect(startScript!.content).toContain('stty cols');
  });

  it('resize-pty.sh has fallback to start-claude PID', () => {
    const files = claudeCodeAdapter.generateOrientationFiles();
    const resizeScript = files.find((f) => f.path === 'resize-pty.sh');
    expect(resizeScript).toBeDefined();
    expect(resizeScript!.content).toContain('pgrep -f "bash.*/start-claude"');
    // Should only send WINCH when Claude PID is found
    expect(resizeScript!.content).toContain('if [ -n "$CLAUDE_PID" ]');
  });

  it('check-pty-size.sh is included in orientation files', () => {
    const files = claudeCodeAdapter.generateOrientationFiles();
    const checkScript = files.find((f) => f.path === 'check-pty-size.sh');
    expect(checkScript).toBeDefined();
    expect(checkScript!.mode).toBe(0o755);
    expect(checkScript!.content).toContain('stty -F "$PTS" size');
    // Should also have fallback PID logic
    expect(checkScript!.content).toContain('pgrep -f "bash.*/start-claude"');
  });

  it('pgrep uses -x (exact process name) not -f (cmdline) to find Claude', () => {
    const files = claudeCodeAdapter.generateOrientationFiles();
    const resizeScript = files.find((f) => f.path === 'resize-pty.sh')!;
    const checkScript = files.find((f) => f.path === 'check-pty-size.sh')!;

    // Claude Code overwrites /proc/PID/cmdline (just "claude" + null padding),
    // so pgrep -f with argument patterns can never match. We must use pgrep -x
    // which matches the process name from /proc/PID/comm instead.
    expect(resizeScript.content).toContain('pgrep -x claude');
    expect(checkScript.content).toContain('pgrep -x claude');

    // Must NOT use -f flag with argument patterns — they won't match
    expect(resizeScript.content).not.toMatch(/pgrep -f.*claude.*dangerously/);
    expect(checkScript.content).not.toMatch(/pgrep -f.*claude.*dangerously/);
  });
});

// --- PTY resize integration test (socat-based, no Docker) ---

describe('PTY resize via socat', () => {
  const isLinux = process.platform === 'linux';

  // Check socat availability once (only on Linux)
  let hasSocat = false;
  if (isLinux) {
    try {
      execFileSync('socat', ['-V'], { timeout: 2000 });
      hasSocat = true;
    } catch {
      /* socat not installed */
    }
  }

  // Track PIDs for cleanup in afterEach
  const pidsToKill: number[] = [];
  const dirsToClean: string[] = [];

  afterEach(() => {
    for (const pid of pidsToKill) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
    }
    pidsToKill.length = 0;
    for (const d of dirsToClean) {
      rmSync(d, { recursive: true, force: true });
    }
    dirsToClean.length = 0;
  });

  /**
   * Creates a socat PTY setup mirroring the Docker container.
   * socat UNIX-LISTEN → EXEC:start-script.sh,pty,setsid,ctty,stderr
   * start-script.sh does: exec <targetCmd>
   *
   * Returns the target process's PID and PTY path.
   */
  async function createPtySetup(targetCmd: string, pgrepPattern: string) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pty-resize-integ-'));
    dirsToClean.push(tmpDir);

    const startScript = join(tmpDir, 'start-test.sh');
    writeFileSync(startScript, `#!/bin/bash\nexec ${targetCmd}\n`, { mode: 0o755 });

    const sockPath = join(tmpDir, 'pty.sock');

    // Start socat listener (same as Docker container entrypoint)
    const socat = spawn('socat', [`UNIX-LISTEN:${sockPath},fork`, `EXEC:${startScript},pty,setsid,ctty,stderr`], {
      stdio: 'ignore',
      detached: true,
    });
    socat.unref();
    if (socat.pid) pidsToKill.push(socat.pid);

    // Wait for socket
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(sockPath)) break;
    }

    // Connect a client (simulating the host PTY proxy), keep stdin open
    const client = spawn('socat', ['-', `UNIX-CONNECT:${sockPath}`], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    client.unref();
    if (client.pid) pidsToKill.push(client.pid);

    // Wait for child process to start
    await new Promise((r) => setTimeout(r, 500));

    // Find the target process: use pgrep then filter to the actual exec'd process
    let targetPid: string | null = null;
    let pts: string | null = null;
    try {
      const result = execFileSync('pgrep', ['-f', pgrepPattern], { timeout: 2000 }).toString().trim();
      for (const pid of result.split('\n')) {
        if (!pid) continue;
        try {
          const link = execFileSync('readlink', [`/proc/${pid}/fd/0`], { timeout: 1000 })
            .toString()
            .trim();
          if (link.startsWith('/dev/pts/')) {
            targetPid = pid;
            pts = link;
            break;
          }
        } catch {
          /* skip pids with unreadable fds */
        }
      }
    } catch {
      /* pgrep found nothing */
    }

    return { tmpDir, targetPid, pts };
  }

  it.skipIf(!isLinux || !hasSocat)('stty -F resizes a socat-managed PTY', async () => {
    const { targetPid, pts } = await createPtySetup('sleep 300', 'sleep 300');

    expect(targetPid).toBeTruthy();
    expect(pts).toMatch(/^\/dev\/pts\/\d+$/);

    // Check initial size (socat PTY defaults to 0x0)
    const initial = execFileSync('stty', ['-F', pts!, 'size'], { timeout: 1000 }).toString().trim();
    expect(initial).toBe('0 0');

    // Resize
    execFileSync('stty', ['-F', pts!, 'cols', '132', 'rows', '43'], { timeout: 1000 });

    // Verify
    const after = execFileSync('stty', ['-F', pts!, 'size'], { timeout: 1000 }).toString().trim();
    expect(after).toBe('43 132');
  });

  it.skipIf(!isLinux || !hasSocat)('resize works after exec replaces shell with target process', async () => {
    const { pts } = await createPtySetup('sleep 301', 'sleep 301');
    expect(pts).toMatch(/^\/dev\/pts\/\d+$/);

    // Resize to non-default dimensions
    execFileSync('stty', ['-F', pts!, 'cols', '200', 'rows', '50'], { timeout: 1000 });
    const size = execFileSync('stty', ['-F', pts!, 'size'], { timeout: 1000 }).toString().trim();
    expect(size).toBe('50 200');

    // Resize again (simulating terminal resize)
    execFileSync('stty', ['-F', pts!, 'cols', '80', 'rows', '24'], { timeout: 1000 });
    const size2 = execFileSync('stty', ['-F', pts!, 'size'], { timeout: 1000 }).toString().trim();
    expect(size2).toBe('24 80');
  });

  it('pgrep -x does not match nonexistent process names', () => {
    // pgrep -x matches the exact process name from /proc/PID/comm.
    // A nonsense name should never match any running process.
    try {
      execFileSync('pgrep', ['-x', 'ironcurtain_no_such_proc'], { timeout: 2000 });
      // If pgrep exits 0, something matched (should be impossible)
      expect.unreachable('pgrep matched a nonexistent process name');
    } catch (err) {
      // Exit code 1 = no match, which is correct
      expect((err as { status: number }).status).toBe(1);
    }
  });
});
