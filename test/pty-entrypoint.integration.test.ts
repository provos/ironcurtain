/**
 * Integration test: PTY container entrypoint UDS→TCP bridge, driven through
 * the real `runPtySession` code path.
 *
 * This is the regression guard for two failure modes:
 *
 *  1. **Mount source mismatch** — `pty-session.ts` builds a `mounts` array
 *     for `docker.create` whose `/run/ironcurtain` source must equal the
 *     bundle's `getBundleSocketsDir(bundleId)` (where MITM publishes its
 *     socket). PR #191 broke this by routing PTY through a stale
 *     `<sessionDir>/sockets` path; the test catches that by exercising the
 *     real `runPtySession` flow and asserting the MITM socket is visible
 *     inside the container.
 *
 *  2. **Entrypoint bridge contract** — `entrypoint-claude-code.sh` must start
 *     `socat TCP-LISTEN:18080 ↔ UNIX-CONNECT:mitm-proxy.sock` so claude
 *     (HTTPS_PROXY=http://127.0.0.1:18080) can reach the host MITM. The test
 *     asserts the bridge is live and a CONNECT through it succeeds.
 *
 * Always-on when Docker and `ironcurtain-claude-code:latest` are present.
 * `IRONCURTAIN_HOME` is pointed at a tempdir so the run leaves no state on
 * the user's machine.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { runPtySession, type PtyAttachFn } from '../src/docker/pty-session.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { isDockerAvailable, isDockerImageAvailable } from './helpers/docker-available.js';
import { testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';

const execFile = promisify(execFileCb);

const IMAGE = 'ironcurtain-claude-code:latest';

async function dockerExec(
  containerId: string,
  ...cmd: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile('docker', ['exec', containerId, ...cmd], { timeout: 15_000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}

const dockerReady = isDockerAvailable() && isDockerImageAvailable(IMAGE);

interface BridgeObservations {
  containerId?: string;
  socketTestExitCode?: number;
  bridgeProcs?: string;
  curlStderr?: string;
}

describe.skipIf(!dockerReady)('PTY container entrypoint UDS→TCP bridge (via runPtySession)', () => {
  let homeDir: string;
  let workspaceDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  const observations: BridgeObservations = {};

  beforeAll(async () => {
    // Sandbox all IronCurtain on-disk state into a tempdir so the test
    // leaves no debris in ~/.ironcurtain/.
    homeDir = mkdtempSync(join(tmpdir(), 'ironcurtain-pty-test-'));
    workspaceDir = join(homeDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    originalHome = process.env.IRONCURTAIN_HOME;
    originalAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    process.env.IRONCURTAIN_HOME = homeDir;
    // Force API-key auth so detectAuthMethod doesn't read host OAuth state.
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';

    // Reuse the host's CA so the image content-hash matches the prebuilt
    // `ironcurtain-claude-code:latest`. A fresh CA would force an image
    // rebuild on every run (multi-minute), which is unacceptable for a
    // routine integration test.
    const hostCaDir = join(homedir(), '.ironcurtain', 'ca');
    if (existsSync(hostCaDir)) {
      cpSync(hostCaDir, join(homeDir, 'ca'), { recursive: true });
    }

    const generatedDir = join(homeDir, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(join(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(join(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    const config = {
      auditLogPath: join(homeDir, 'audit.jsonl'),
      allowedDirectory: workspaceDir,
      // Empty mcpServers — the policy fixture references some, but
      // `extractRequiredServers` only spawns servers actually used by the
      // active rules; with no client tool calls, none start up.
      mcpServers: {},
      protectedPaths: [],
      generatedDir,
      constitutionPath: join(homeDir, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: {
        agentModelId: 'anthropic:claude-sonnet-4-6',
        policyModelId: 'anthropic:claude-sonnet-4-6',
        anthropicApiKey: 'sk-ant-api03-fake-test-key-for-pty-integration',
        googleApiKey: '',
        openaiApiKey: '',
        escalationTimeoutSeconds: 300,
        resourceBudget: {
          maxTotalTokens: 1_000_000,
          maxSteps: 200,
          maxSessionSeconds: 1800,
          maxEstimatedCostUsd: 5.0,
          warnThresholdPercent: 80,
        },
        autoCompact: {
          enabled: false,
          thresholdTokens: 80_000,
          keepRecentMessages: 10,
          summaryModelId: 'anthropic:claude-haiku-4-5',
        },
        autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
        auditRedaction: { enabled: true },
        memory: { enabled: false, llmBaseUrl: undefined, llmApiKey: undefined },
        packageInstall: {
          enabled: false,
          quarantineDays: 2,
          allowedPackages: [],
          deniedPackages: [],
        },
        serverCredentials: {},
      },
    } as unknown as IronCurtainConfig;

    // The attach stub runs INSIDE runPtySession after the container is up.
    // It collects observations against the live container and returns 0 so
    // the production cleanup path runs normally.
    const attach: PtyAttachFn = async ({ containerId }) => {
      observations.containerId = containerId;

      const sock = await dockerExec(containerId, 'test', '-S', '/run/ironcurtain/mitm-proxy.sock');
      observations.socketTestExitCode = sock.exitCode;

      const procs = await dockerExec(containerId, 'sh', '-c', 'pgrep -af "TCP-LISTEN:18080" || true');
      observations.bridgeProcs = procs.stdout;

      const curl = await dockerExec(
        containerId,
        'curl',
        '-sv',
        '--max-time',
        '10',
        '--proxy',
        'http://127.0.0.1:18080',
        '-o',
        '/dev/null',
        'https://api.anthropic.com/v1/messages',
      );
      observations.curlStderr = curl.stderr;

      return 0;
    };

    await runPtySession({
      config,
      mode: { kind: 'docker', agent: 'claude-code' },
      workspacePath: workspaceDir,
      attach,
    });
  }, 90_000);

  afterAll(() => {
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalAuth === undefined) delete process.env.IRONCURTAIN_DOCKER_AUTH;
    else process.env.IRONCURTAIN_DOCKER_AUTH = originalAuth;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  });

  it('runPtySession spawns the container and invokes attach with its id', () => {
    expect(observations.containerId).toBeTruthy();
  });

  it('mounts the bundle sockets dir at /run/ironcurtain (regression guard for #191)', () => {
    // If pty-session.ts mounts the wrong source directory, the MITM socket
    // is missing inside the container and `test -S` exits 1.
    expect(observations.socketTestExitCode).toBe(0);
  });

  it('entrypoint starts the in-container UDS→TCP bridge on port 18080', () => {
    expect(observations.bridgeProcs ?? '').toContain('UNIX-CONNECT:/run/ironcurtain/mitm-proxy.sock');
  });

  it('container can reach the host MITM via http://127.0.0.1:18080', () => {
    // CONNECT to api.anthropic.com:443 is on the proxy's host allowlist.
    // TLS handshake fails (curl doesn't trust the IronCurtain CA) but the
    // CONNECT itself completing proves the bridge is alive end-to-end.
    expect(observations.curlStderr ?? '').toContain('CONNECT tunnel established');
  });
});
