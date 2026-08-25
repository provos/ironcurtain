import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  APPLE_VM_DAEMON_API_DIR,
  APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT,
  APPLE_VM_DAEMON_API_DIR_STAT_ARGV,
  APPLE_VM_DAEMON_DATA_ROOT,
  APPLE_VM_DAEMON_DOCKERD_COMMAND,
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_INFO_ARGV,
  APPLE_VM_DAEMON_IPTABLES,
  APPLE_VM_DAEMON_LOG_PATH,
  APPLE_VM_DAEMON_LOG_TAIL_ARGV,
  APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS,
  APPLE_VM_DAEMON_SOCKET,
  APPLE_VM_DAEMON_START_ARGV,
  APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV,
  APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV,
  APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
  APPLE_VM_REGISTRY_EGRESS_CA_BUNDLE,
  APPLE_VM_REGISTRY_EGRESS_PROXY_URL,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
  APPLE_VM_EGRESS_RELAY_PATH,
  bootstrapAppleVmDaemon,
  waitForAppleVmDaemonReady,
  type AppleVmDaemonExec,
  type AppleVmDaemonExecResult,
} from '../../src/docker-workload/apple-vm-daemon.js';

interface RecordedExec {
  readonly argv: readonly string[];
  readonly user: string | null;
  readonly timeoutMs: number;
}

function recordingExec(responses: (call: RecordedExec) => AppleVmDaemonExecResult | Promise<never>): {
  readonly exec: AppleVmDaemonExec;
  readonly calls: readonly RecordedExec[];
} {
  const calls: RecordedExec[] = [];
  const exec: AppleVmDaemonExec = async (argv, options) => {
    const call = { argv: [...argv], user: options.user, timeoutMs: options.timeoutMs };
    calls.push(call);
    return responses(call);
  };
  return { exec, calls };
}

const isStatCall = (call: RecordedExec): boolean => call.argv[0] === '/usr/bin/stat';

/** The stat output a correctly provisioned base image produces, as the shell emits it. */
function expectedStat(): AppleVmDaemonExecResult {
  return { stdout: `${APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT}\n`, exitCode: 0 };
}

/** Bootstrap responses for a healthy VM: the API directory passes, everything else succeeds. */
function healthyBootstrap(call: RecordedExec): AppleVmDaemonExecResult {
  return isStatCall(call) ? expectedStat() : { stdout: '', exitCode: 0 };
}

function infoJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Driver: 'vfs',
    SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'],
    ServerVersion: '29.2.1',
    ...overrides,
  });
}

/** A clock that only moves when the injected sleep is awaited, so timeouts are deterministic. */
function fakeTimeline(startMs: number): { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> } {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

describe('Apple VM nested-daemon frozen commands', () => {
  it('freezes the disconnected rootlesskit/dockerd invocation and forwarding prerequisite verbatim', () => {
    expect(APPLE_VM_DAEMON_DOCKERD_COMMAND).toBe(
      [
        "rootlesskit --net=none --disable-host-loopback --copy-up=/etc --copy-up=/run sh -c 'set -e",
        '[ "$(command -v iptables)" = "/usr/local/lib/ironcurtain-docker/bin/iptables" ]',
        'iptables --version | /bin/grep -Eq "^iptables v[0-9]+(\\.[0-9]+)* \\(legacy\\)$"',
        '/usr/bin/printf "1" > /proc/sys/net/ipv4/ip_forward',
        '[ "$(/bin/cat /proc/sys/net/ipv4/ip_forward)" = "1" ]',
        "exec dockerd --host=unix:///run/ironcurtain-docker/docker.sock --data-root=/home/codespace/.local/share/docker --storage-driver=vfs --iptables=false --bridge=none'",
      ].join('\n'),
    );
  });

  it('pins the daemon state root explicitly instead of deriving it from HOME', () => {
    expect(APPLE_VM_DAEMON_DATA_ROOT).toBe('/home/codespace/.local/share/docker');
    expect(APPLE_VM_DAEMON_DOCKERD_COMMAND).toContain(`--data-root=${APPLE_VM_DAEMON_DATA_ROOT}`);
    expect([...APPLE_VM_DAEMON_DOCKERD_COMMAND.matchAll(/--data-root=/gu)]).toHaveLength(1);
  });

  it('binds the daemon API to exactly one VM-local socket and no other endpoint', () => {
    const hostFlags = [...APPLE_VM_DAEMON_DOCKERD_COMMAND.matchAll(/--host(?:=|\s+)(\S+)/gu)].map(([, value]) => value);
    expect(hostFlags).toEqual(['unix:///run/ironcurtain-docker/docker.sock']);
    expect(APPLE_VM_DAEMON_DOCKERD_COMMAND).not.toMatch(/--tls/u);
    expect(APPLE_VM_DAEMON_DOCKERD_COMMAND).not.toMatch(/--containerd[=\s]/u);
  });

  it('freezes the VM-local API paths', () => {
    expect(APPLE_VM_DAEMON_API_DIR).toBe('/run/ironcurtain-docker');
    expect(APPLE_VM_DAEMON_SOCKET).toBe('/run/ironcurtain-docker/docker.sock');
    expect(APPLE_VM_DAEMON_DOCKER_HOST).toBe('unix:///run/ironcurtain-docker/docker.sock');
    expect(APPLE_VM_DAEMON_TOOLCHAIN_DIR).toBe('/usr/local/lib/ironcurtain-docker/bin');
    expect(APPLE_VM_DAEMON_IPTABLES).toBe('/usr/local/lib/ironcurtain-docker/bin/iptables');
    expect(APPLE_VM_DAEMON_LOG_PATH).toBe('/run/ironcurtain-docker/dockerd.log');
  });

  it('mode-checks the image-provided API directory without following symlinks', () => {
    // `stat` without -L reports the link itself, so a planted symlink cannot
    // pass as the directory. `test -w` would have followed it.
    expect(APPLE_VM_DAEMON_API_DIR_STAT_ARGV).toEqual([
      '/usr/bin/stat',
      '-c',
      '%F:%u:%g:%a',
      '/run/ironcurtain-docker',
    ]);
    expect(APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT).toBe('directory:1000:1000:700');
  });

  it('freezes the detached start argv verbatim', () => {
    // Literal, not interpolated from APPLE_VM_DAEMON_DOCKERD_COMMAND: a test
    // that renders the constant it is meant to freeze cannot detect a change.
    expect(APPLE_VM_DAEMON_START_ARGV).toEqual([
      'sh',
      '-c',
      [
        'set -e',
        'exec </dev/null >/run/ironcurtain-docker/dockerd.log 2>&1',
        'export XDG_RUNTIME_DIR=/run/ironcurtain-docker HOME=/home/codespace PATH=/usr/bin:/bin:/usr/local/lib/ironcurtain-docker/bin',
        "exec nohup rootlesskit --net=none --disable-host-loopback --copy-up=/etc --copy-up=/run sh -c 'set -e",
        '[ "$(command -v iptables)" = "/usr/local/lib/ironcurtain-docker/bin/iptables" ]',
        'iptables --version | /bin/grep -Eq "^iptables v[0-9]+(\\.[0-9]+)* \\(legacy\\)$"',
        '/usr/bin/printf "1" > /proc/sys/net/ipv4/ip_forward',
        '[ "$(/bin/cat /proc/sys/net/ipv4/ip_forward)" = "1" ]',
        "exec dockerd --host=unix:///run/ironcurtain-docker/docker.sock --data-root=/home/codespace/.local/share/docker --storage-driver=vfs --iptables=false --bridge=none' &",
      ].join('\n'),
    ]);
  });

  it('enables only namespace-local forwarding before dockerd while retaining the isolation flags', () => {
    for (const script of [
      APPLE_VM_DAEMON_START_ARGV[2],
      APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV[2],
      APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV[2],
    ]) {
      const resolveIptables = script.indexOf('command -v iptables');
      const verifyIptables = script.indexOf('iptables --version');
      const setForwarding = script.indexOf('/usr/bin/printf "1" > /proc/sys/net/ipv4/ip_forward');
      const verifyForwarding = script.indexOf('$(/bin/cat /proc/sys/net/ipv4/ip_forward)');
      const startDaemon = script.lastIndexOf('dockerd --host=');
      expect(resolveIptables).toBeGreaterThanOrEqual(0);
      expect(verifyIptables).toBeGreaterThan(resolveIptables);
      expect(setForwarding).toBeGreaterThan(verifyIptables);
      expect(setForwarding).toBeGreaterThanOrEqual(0);
      expect(verifyForwarding).toBeGreaterThan(setForwarding);
      expect(startDaemon).toBeGreaterThan(verifyForwarding);
      expect(script).toContain('--net=none');
      expect(script).toContain('--disable-host-loopback');
      expect(script).toContain('--iptables=false');
      expect(script).toContain('--bridge=none');
      expect(script).not.toMatch(/slirp|vpnkit|pasta|--iptables=true|--ip-masq/iu);
      expect(script).not.toContain('/usr/sbin:/sbin');
      expect(spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' })).toMatchObject({ status: 0, stderr: '' });
    }
  });

  it('keeps the images variant separate and shell-parseable', () => {
    const script = APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV[2];
    expect(spawnSync('/bin/bash', ['-n', '-c', script], { encoding: 'utf8' })).toMatchObject({
      status: 0,
      stderr: '',
    });
    const relayPrefix = `/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/local/bin/node ${APPLE_VM_EGRESS_RELAY_PATH}`;
    expect(script.split('\n').filter((line) => line === `${relayPrefix} serve images &`)).toHaveLength(1);
    expect(script.split('\n').filter((line) => line.includes(`${relayPrefix} probe images`))).toHaveLength(1);
    expect(script).not.toContain('serve packages');
    expect(script).not.toContain('probe packages');
    expect(script).toContain(APPLE_VM_REGISTRY_EGRESS_PROXY_URL);
    expect(script).toContain(`SSL_CERT_FILE=${APPLE_VM_REGISTRY_EGRESS_CA_BUNDLE}`);
    expect(script).not.toContain('/usr/bin/socat');
    expect(script).not.toContain('0.0.0.0');
    expect(script).toContain("/bin/bash -c 'set -e\n");
    expect([...script.matchAll(/'/gu)]).toHaveLength(2);
  });

  it('serves both fixed package-profile listeners in one process while dockerd remains registry-only', () => {
    const script = APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV[2];
    expect(spawnSync('/bin/bash', ['-n', '-c', script], { encoding: 'utf8' })).toMatchObject({
      status: 0,
      stderr: '',
    });
    const relayPrefix = `/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /usr/local/bin/node ${APPLE_VM_EGRESS_RELAY_PATH}`;
    expect(script.split('\n').filter((line) => line === `${relayPrefix} serve packages &`)).toHaveLength(1);
    expect(script.split('\n').filter((line) => line.includes(`${relayPrefix} probe packages`))).toHaveLength(1);
    expect(script).not.toContain('serve images');
    expect(script).not.toContain('probe images');
    expect(script).toContain(APPLE_VM_REGISTRY_EGRESS_PROXY_URL);
    expect(script).toContain(`export HTTP_PROXY=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL}`);
    expect(script).not.toContain(`export HTTP_PROXY=${APPLE_VM_PACKAGE_EGRESS_PROXY_URL}`);
    expect(script).not.toContain('/usr/bin/socat');
    expect(script).not.toContain('0.0.0.0');
    expect([...script.matchAll(/'/gu)]).toHaveLength(2);
  });

  it('supervises relay and dockerd symmetrically with bounded termination and reap', () => {
    for (const script of [
      APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV[2],
      APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV[2],
    ]) {
      const relayStart = script.indexOf(' serve ');
      const relayReady = script.indexOf(' probe ');
      const daemonStart = script.lastIndexOf('dockerd --host=');
      const wait = script.indexOf('wait -n "$relay_pid" "$dockerd_pid"');
      expect(relayStart).toBeGreaterThanOrEqual(0);
      expect(relayReady).toBeGreaterThan(relayStart);
      expect(daemonStart).toBeGreaterThan(relayReady);
      expect(wait).toBeGreaterThan(daemonStart);
      expect(script).toContain('trap cleanup EXIT INT TERM');
      expect(script).toContain('while [ "$cleanup_attempt" -lt 100 ]');
      expect(script).toContain('/bin/kill -9 "$dockerd_pid"');
      expect(script).toContain('/bin/kill -9 "$relay_pid"');
      expect(script).toContain('wait "$dockerd_pid" 2>/dev/null || true');
      expect(script).toContain('wait "$relay_pid" 2>/dev/null || true');
      expect(script).not.toContain('exec dockerd');
    }
  });

  it('keeps /usr/bin ahead of the toolchain dir so the image-capped newuidmap wins', () => {
    const script = APPLE_VM_DAEMON_START_ARGV[2];
    const path = /PATH=(\S+)/u.exec(script)?.[1].split(':') ?? [];
    expect(path.indexOf('/usr/bin')).toBeGreaterThanOrEqual(0);
    expect(path.indexOf('/usr/bin')).toBeLessThan(path.indexOf(APPLE_VM_DAEMON_TOOLCHAIN_DIR));
  });

  it('never binds or publishes the daemon API outside the VM', () => {
    const rendered = [...APPLE_VM_DAEMON_START_ARGV, ...APPLE_VM_DAEMON_INFO_ARGV].join(' ');
    expect(rendered).not.toContain('tcp://');
    expect(rendered).not.toContain('0.0.0.0');
    expect(rendered).not.toContain('--publish');
  });

  it('probes and tails through frozen argvs', () => {
    expect(APPLE_VM_DAEMON_INFO_ARGV).toEqual([
      '/usr/local/lib/ironcurtain-docker/bin/docker',
      '--host',
      'unix:///run/ironcurtain-docker/docker.sock',
      'info',
      '--format',
      '{{json .}}',
    ]);
    expect(APPLE_VM_DAEMON_LOG_TAIL_ARGV).toEqual(['tail', '-n', '80', '/run/ironcurtain-docker/dockerd.log']);
  });
});

describe('Apple VM nested-daemon bootstrap', () => {
  it('mode-checks the API directory then starts the daemon, both as the runtime user', async () => {
    const { exec, calls } = recordingExec(healthyBootstrap);
    await bootstrapAppleVmDaemon(exec);
    expect(calls.map((call) => ({ argv: call.argv, user: call.user }))).toEqual([
      { argv: [...APPLE_VM_DAEMON_API_DIR_STAT_ARGV], user: 'codespace' },
      { argv: [...APPLE_VM_DAEMON_START_ARGV], user: 'codespace' },
    ]);
  });

  it('selects the registry bootstrap only for images network access', async () => {
    const { exec, calls } = recordingExec(healthyBootstrap);
    await bootstrapAppleVmDaemon(exec, { networkAccess: 'images' });
    expect(calls.map((call) => call.argv)).toEqual([
      [...APPLE_VM_DAEMON_API_DIR_STAT_ARGV],
      [...APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV],
    ]);
  });

  it('selects the dual-relay bootstrap only for packages network access', async () => {
    const { exec, calls } = recordingExec(healthyBootstrap);
    await bootstrapAppleVmDaemon(exec, { networkAccess: 'packages' });
    expect(calls.map((call) => call.argv)).toEqual([
      [...APPLE_VM_DAEMON_API_DIR_STAT_ARGV],
      [...APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV],
    ]);
  });

  it('never execs as root: the API directory is image-provided, not created at runtime', async () => {
    const { exec, calls } = recordingExec(healthyBootstrap);
    await bootstrapAppleVmDaemon(exec);
    expect(calls.every((call) => call.user === 'codespace')).toBe(true);
    expect(calls.some((call) => call.argv[0] === 'install')).toBe(false);
  });

  it('rejects a symlink planted where the API directory belongs', async () => {
    // The agent is root in its own container and workflow snapshot-resume
    // commits that layer, so it can redirect the API root at a host-backed
    // VirtioFS mount. `test -w` followed the link; the stat check does not.
    const { exec, calls } = recordingExec((call) =>
      isStatCall(call) ? { stdout: 'symbolic link:0:0:777\n', exitCode: 0 } : { stdout: '', exitCode: 0 },
    );
    await expect(bootstrapAppleVmDaemon(exec)).rejects.toThrow(
      /apple-vm daemon API directory \/run\/ironcurtain-docker failed its mode check: expected "directory:1000:1000:700", observed "symbolic link:0:0:777"/u,
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a world-writable directory', 'directory:1000:1000:777'],
    ['a directory owned by another user', 'directory:0:0:700'],
    ['a group-owned directory', 'directory:1000:0:700'],
    ['a non-directory', 'fifo:1000:1000:700'],
  ])('rejects %s', async (_label, observed) => {
    const { exec } = recordingExec((call) =>
      isStatCall(call) ? { stdout: `${observed}\n`, exitCode: 0 } : { stdout: '', exitCode: 0 },
    );
    await expect(bootstrapAppleVmDaemon(exec)).rejects.toThrow(
      new RegExp(`failed its mode check: expected "directory:1000:1000:700", observed "${observed}"`, 'u'),
    );
  });

  it('fails closed with the image requirement when the API directory is absent', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: '', exitCode: 1 }));
    await expect(bootstrapAppleVmDaemon(exec)).rejects.toThrow(
      /failed its mode check: expected "directory:1000:1000:700", observed "\(stat exited 1\)"; the agent base image must provide it as a real directory owned by the runtime user with mode 0700/u,
    );
    expect(calls).toHaveLength(1);
  });

  it('bounds and sanitizes the stat observation it quotes back', async () => {
    const { exec } = recordingExec((call) =>
      isStatCall(call)
        ? { stdout: `\u001b[31mdirectory${'x'.repeat(5_000)}\n`, exitCode: 0 }
        : { stdout: '', exitCode: 0 },
    );
    const error = await bootstrapAppleVmDaemon(exec).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('… (truncated)');
    expect(message).not.toContain('\u001b');
    expect(message.length).toBeLessThan(1_000);
  });

  it('fails closed when the daemon start command fails', async () => {
    const { exec } = recordingExec((call) =>
      isStatCall(call) ? expectedStat() : { stdout: '', exitCode: call.argv[0] === 'sh' ? 127 : 0 },
    );
    await expect(bootstrapAppleVmDaemon(exec)).rejects.toThrow(/apple-vm daemon start failed with exit code 127/u);
  });
});

describe('Apple VM nested-daemon readiness', () => {
  it('polls until the daemon answers and reports the adjudicated configuration', async () => {
    const timeline = fakeTimeline(1_000);
    let attempts = 0;
    const { exec, calls } = recordingExec(() => {
      attempts += 1;
      return attempts < 3 ? { stdout: '', exitCode: 1 } : { stdout: `${infoJson()}\n`, exitCode: 0 };
    });

    const readiness = await waitForAppleVmDaemonReady(exec, {
      timeoutMs: 90_000,
      pollIntervalMs: 250,
      now: timeline.now,
      sleep: timeline.sleep,
    });

    expect(readiness).toEqual({
      driver: 'vfs',
      securityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'],
      serverVersion: '29.2.1',
      readinessMs: 500,
    });
    expect(calls.every((call) => call.user === 'codespace')).toBe(true);
    expect(calls.every((call) => call.argv[0] === '/usr/local/lib/ironcurtain-docker/bin/docker')).toBe(true);
  });

  it('rejects an unsupported storage driver without retrying', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: infoJson({ Driver: 'overlay2' }), exitCode: 0 }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /rejected an unsupported storage driver: expected vfs, received overlay2/u,
    );
    expect(calls).toHaveLength(1);
  });

  it('rejects a daemon that is not rootless without retrying', async () => {
    const { exec, calls } = recordingExec(() => ({
      stdout: infoJson({ SecurityOptions: ['name=seccomp,profile=builtin'] }),
      exitCode: 0,
    }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /rejected a non-rootless daemon: name=rootless missing from \[name=seccomp,profile=builtin\]/u,
    );
    expect(calls).toHaveLength(1);
  });

  it('rejects a daemon reporting no security options at all', async () => {
    const { exec } = recordingExec(() => ({ stdout: infoJson({ SecurityOptions: null }), exitCode: 0 }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /rejected a non-rootless daemon/u,
    );
  });

  it('rejects unparseable docker info output', async () => {
    const { exec } = recordingExec(() => ({ stdout: 'Cannot connect to the Docker daemon', exitCode: 0 }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /could not parse the docker info JSON/u,
    );
  });

  it('rejects docker info JSON whose adjudicated fields are malformed', async () => {
    const { exec, calls } = recordingExec(() => ({
      stdout: infoJson({ SecurityOptions: ['name=rootless', 42] }),
      exitCode: 0,
    }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /without Driver\/SecurityOptions\/ServerVersion/u,
    );
    expect(calls).toHaveLength(1);
  });
});

describe('Apple VM nested-daemon readiness — a silent daemon is retried, a wrong one is not', () => {
  const skeleton = JSON.stringify({
    Driver: '',
    ServerVersion: '',
    ServerErrors: ['Cannot connect to the Docker daemon at unix:///run/ironcurtain-docker/docker.sock.'],
  });

  it('retries the client-only skeleton response instead of adjudicating it', async () => {
    // `docker info` can exit 0 while reporting only the client's own view. That
    // is a liveness signal — the daemon has not answered — not an unsupported
    // configuration, so it must not fail the session on the first poll.
    const timeline = fakeTimeline(0);
    let attempts = 0;
    const { exec } = recordingExec((call) => {
      if (call.argv[0] === 'tail') return { stdout: '', exitCode: 1 };
      attempts += 1;
      return attempts < 3 ? { stdout: skeleton, exitCode: 0 } : { stdout: infoJson(), exitCode: 0 };
    });

    const readiness = await waitForAppleVmDaemonReady(exec, {
      timeoutMs: 90_000,
      pollIntervalMs: 250,
      now: timeline.now,
      sleep: timeline.sleep,
    });

    expect(readiness.readinessMs).toBe(500);
    expect(attempts).toBe(3);
  });

  it('retries a ServerErrors reply that still carries populated server fields', async () => {
    const timeline = fakeTimeline(0);
    const { exec, calls } = recordingExec((call) =>
      call.argv[0] === 'tail'
        ? { stdout: 'daemon still starting', exitCode: 0 }
        : { stdout: infoJson({ ServerErrors: ['request returned Internal Server Error'] }), exitCode: 0 },
    );

    await expect(
      waitForAppleVmDaemonReady(exec, {
        timeoutMs: 1_000,
        pollIntervalMs: 500,
        now: timeline.now,
        sleep: timeline.sleep,
      }),
    ).rejects.toThrow(/did not become ready within 1000ms/u);
    expect(calls.filter((call) => call.argv[0] !== 'tail').length).toBeGreaterThan(1);
  });

  it('retries an empty server block until the deadline rather than failing closed early', async () => {
    const timeline = fakeTimeline(0);
    const { exec, calls } = recordingExec((call) =>
      call.argv[0] === 'tail' ? { stdout: '', exitCode: 1 } : { stdout: skeleton, exitCode: 0 },
    );

    await expect(
      waitForAppleVmDaemonReady(exec, {
        timeoutMs: 1_200,
        pollIntervalMs: 400,
        now: timeline.now,
        sleep: timeline.sleep,
      }),
    ).rejects.toThrow(/did not become ready within 1200ms/u);
    expect(calls.filter((call) => call.argv[0] !== 'tail')).toHaveLength(4);
  });

  it('still adjudicates a populated-but-wrong configuration exactly once', async () => {
    // The retry relaxation must not swallow a daemon that DID answer with an
    // unsupported configuration; that stays an immediate fail-closed.
    const { exec, calls } = recordingExec(() => ({
      stdout: infoJson({ Driver: 'overlayfs', SecurityOptions: ['name=seccomp,profile=builtin'] }),
      exitCode: 0,
    }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /rejected an unsupported storage driver: expected vfs, received overlayfs/u,
    );
    expect(calls).toHaveLength(1);
  });
});

describe('Apple VM nested-daemon readiness — in-VM text is bounded at the seam', () => {
  it('rejects an oversized ServerVersion instead of passing it to the audit schema', async () => {
    const bound = APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS.serverVersionLength;
    const { exec, calls } = recordingExec(() => ({
      stdout: infoJson({ ServerVersion: 'v'.repeat(bound + 1) }),
      exitCode: 0,
    }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).rejects.toThrow(
      new RegExp(
        `rejected oversized docker info text: ServerVersion is ${bound + 1} characters, bound is ${bound}`,
        'u',
      ),
    );
    expect(calls).toHaveLength(1);
  });

  it('accepts a ServerVersion exactly at the bound', async () => {
    const bound = APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS.serverVersionLength;
    const serverVersion = 'v'.repeat(bound);
    const { exec } = recordingExec(() => ({ stdout: infoJson({ ServerVersion: serverVersion }), exitCode: 0 }));
    await expect(waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 })).resolves.toMatchObject({ serverVersion });
  });

  it('rejects an oversized Driver before the rejection message would quote it', async () => {
    const bound = APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS.driverLength;
    const { exec } = recordingExec(() => ({ stdout: infoJson({ Driver: 'd'.repeat(bound + 1) }), exitCode: 0 }));
    const error = await waitForAppleVmDaemonReady(exec, { timeoutMs: 90_000 }).catch((cause: unknown) => cause);
    expect((error as Error).message).toMatch(/rejected oversized docker info text: Driver is 129 characters/u);
    // The unsupported-driver message would otherwise have embedded all 129.
    expect((error as Error).message).not.toContain('d'.repeat(bound + 1));
  });

  it('rejects an oversized security option and too many of them', async () => {
    const bounds = APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS;
    const long = recordingExec(() => ({
      stdout: infoJson({ SecurityOptions: ['name=rootless', 'o'.repeat(bounds.securityOptionLength + 1)] }),
      exitCode: 0,
    }));
    await expect(waitForAppleVmDaemonReady(long.exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /rejected oversized docker info text: SecurityOptions\[1\] is 257 characters, bound is 256/u,
    );

    const many = recordingExec(() => ({
      stdout: infoJson({
        SecurityOptions: Array.from({ length: bounds.securityOptionCount + 1 }, () => 'name=rootless'),
      }),
      exitCode: 0,
    }));
    await expect(waitForAppleVmDaemonReady(many.exec, { timeoutMs: 90_000 })).rejects.toThrow(
      /rejected oversized docker info text: SecurityOptions has 65 entries, bound is 64/u,
    );
  });

  it('embeds the dockerd log tail in the timeout error', async () => {
    const timeline = fakeTimeline(0);
    const { exec, calls } = recordingExec((call) =>
      call.argv[0] === 'tail'
        ? { stdout: 'rootlesskit: nsenter: failed to execute ip\n', exitCode: 0 }
        : { stdout: '', exitCode: 1 },
    );

    await expect(
      waitForAppleVmDaemonReady(exec, {
        timeoutMs: 1_000,
        pollIntervalMs: 400,
        now: timeline.now,
        sleep: timeline.sleep,
      }),
    ).rejects.toThrow(
      /apple-vm daemon did not become ready within 1000ms; dockerd log tail:\nrootlesskit: nsenter: failed to execute ip/u,
    );
    expect(calls.filter((call) => call.argv[0] === 'tail')).toEqual([
      { argv: [...APPLE_VM_DAEMON_LOG_TAIL_ARGV], user: 'codespace', timeoutMs: 5_000 },
    ]);
  });

  it('still reports the timeout when the log tail itself fails', async () => {
    const timeline = fakeTimeline(0);
    const exec: AppleVmDaemonExec = async (argv) => {
      if (argv[0] === 'tail') throw new Error('container is gone');
      return { stdout: '', exitCode: 1 };
    };
    await expect(
      waitForAppleVmDaemonReady(exec, { timeoutMs: 0, now: timeline.now, sleep: timeline.sleep }),
    ).rejects.toThrow(/did not become ready within 0ms; dockerd log tail:\n\(dockerd log unavailable\)/u);
  });

  it('truncates the log tail to a byte budget the in-VM writer does not choose', async () => {
    // `tail -n 80` bounds lines, not bytes, and the exec adapter's maxBuffer is
    // 50 MB — one long line would otherwise size the whole Error.message.
    const timeline = fakeTimeline(0);
    const { exec } = recordingExec((call) =>
      call.argv[0] === 'tail' ? { stdout: 'A'.repeat(2_000_000), exitCode: 0 } : { stdout: '', exitCode: 1 },
    );
    const error = await waitForAppleVmDaemonReady(exec, {
      timeoutMs: 0,
      now: timeline.now,
      sleep: timeline.sleep,
    }).catch((cause: unknown) => cause);

    const message = (error as Error).message;
    expect(message).toContain('… (truncated)');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThan(4_200);
  });

  it('strips control characters so a log line cannot inject terminal escapes', async () => {
    const timeline = fakeTimeline(0);
    const { exec } = recordingExec((call) =>
      call.argv[0] === 'tail'
        ? { stdout: '\u001b[2Jrootlesskit:\u0007 failed\u0000\n', exitCode: 0 }
        : { stdout: '', exitCode: 1 },
    );
    const error = await waitForAppleVmDaemonReady(exec, {
      timeoutMs: 0,
      now: timeline.now,
      sleep: timeline.sleep,
    }).catch((cause: unknown) => cause);

    const message = (error as Error).message;
    expect(message).toContain('[2Jrootlesskit: failed');
    for (const control of ['\u001b', '\u0007', '\u0000']) expect(message).not.toContain(control);
  });
});

describe('Apple VM nested-daemon module boundaries', () => {
  it('does not consult the implementation fuse, pipeline tooling, or spawn processes itself', () => {
    const source = readFileSync(resolve('src/docker-workload/apple-vm-daemon.ts'), 'utf8');
    expect(source).not.toContain('assertDockerWorkloadVariantAdmitted');
    expect(source).not.toMatch(/from '\.\/config\.js'/u);
    expect(source).not.toMatch(/from '[^']*pipeline\//u);
    expect(source).not.toContain('node:child_process');
  });
});
