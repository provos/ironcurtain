/**
 * Integration test: PTY container entrypoint UDS→TCP bridge, driven through
 * the real `runPtySession` code path.
 *
 * Regression guard for two failure modes:
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
 *     issues a `curl -k` from inside the container to a Claude Code endpoint
 *     and verifies a local upstream responder received the forwarded request.
 *
 * Hermetic by construction:
 *
 *   - `IRONCURTAIN_HOME` is redirected to a tempdir; on cleanup the tempdir
 *     is removed entirely. No state lands under `~/.ironcurtain/`.
 *   - `ANTHROPIC_BASE_URL` is overridden to a local HTTP responder bound to
 *     127.0.0.1, so MITM's upstream forward never contacts api.anthropic.com.
 *     `-k` makes the curl call independent of whether the IronCurtain CA is
 *     present in the container's trust store.
 *
 * Linux-only by design: the bridge being asserted here is part of the Linux
 * UDS transport (`useTcpTransport()` is false). macOS PTY mode reaches MITM
 * via `host.docker.internal:<mitmPort>` through a socat sidecar — that path
 * has no in-container 18080 bridge and would need its own end-to-end test.
 *
 * Always-on when Docker, the prebuilt `ironcurtain-claude-code:latest` image,
 * AND the host CA used to build that image are all present. The CA is sourced
 * from the active `IRONCURTAIN_HOME` (captured before the test overrides it)
 * — using a non-matching CA would force a multi-minute image rebuild, so we
 * skip rather than rebuild.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import { runPtySession, type PtyAttachFn } from '../src/docker/pty-session.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { useTcpTransport } from '../src/docker/platform.js';
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

/**
 * Locates the CA directory the running `ironcurtain-claude-code:latest` image
 * was likely built from. Honors `IRONCURTAIN_HOME` if set (matching the
 * production resolution in `src/config/paths.ts:getIronCurtainHome`), otherwise
 * defaults to `~/.ironcurtain`. Returns null if no CA is present.
 *
 * Read this BEFORE the test overrides `IRONCURTAIN_HOME` so we point at the
 * developer's real CA, not the temp sandbox.
 */
function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
// Linux-only: the in-container UDS→TCP bridge being asserted here is part
// of the Linux UDS transport. On macOS (`useTcpTransport()` returns true),
// the container reaches MITM via `host.docker.internal:<mitmPort>` through
// a socat sidecar instead — `127.0.0.1:18080` and `mitm-proxy.sock` simply
// don't exist there. macOS PTY mode would need its own end-to-end test
// asserting the sidecar forward.
const dockerReady = !useTcpTransport() && isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

/** Local upstream responder: 200s every request and counts hits per path. */
function startUpstreamResponder(): Promise<{ server: Server; port: number; received: IncomingMessage[] }> {
  const received: IncomingMessage[] = [];
  return new Promise((resolveStart, rejectStart) => {
    const server = createHttpServer((req, res) => {
      received.push(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolveStart({ server, port: addr.port, received });
    });
  });
}

interface BridgeObservations {
  containerId?: string;
  socketTestExitCode?: number;
  bridgeProcs?: string;
  curlExitCode?: number;
  curlHttpCode?: string;
}

describe.skipIf(!dockerReady)('PTY container entrypoint UDS→TCP bridge (via runPtySession)', () => {
  let homeDir: string;
  let workspaceDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  let originalAnthropicBaseUrl: string | undefined;
  let upstream: { server: Server; port: number; received: IncomingMessage[] } | undefined;
  const observations: BridgeObservations = {};

  beforeAll(async () => {
    // Sandbox all IronCurtain on-disk state into a tempdir.
    homeDir = mkdtempSync(join(tmpdir(), 'ironcurtain-pty-test-'));
    workspaceDir = join(homeDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    // Local responder stands in for api.anthropic.com so MITM's upstream
    // forward never leaves the host. Started before env vars are set so the
    // port is known when we override `ANTHROPIC_BASE_URL`.
    upstream = await startUpstreamResponder();

    originalHome = process.env.IRONCURTAIN_HOME;
    originalAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.IRONCURTAIN_HOME = homeDir;
    // Force API-key auth so detectAuthMethod doesn't read host OAuth state.
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.port}`;

    // Reuse the host CA so the image content-hash matches the prebuilt image.
    // hostCaDir is non-null here because we gated `dockerReady` on it.
    cpSync(hostCaDir as string, join(homeDir, 'ca'), { recursive: true });

    const generatedDir = join(homeDir, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(join(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(join(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    const config = {
      auditLogPath: join(homeDir, 'audit.jsonl'),
      allowedDirectory: workspaceDir,
      // Empty mcpServers — the policy fixture references some, but
      // `extractRequiredServers` only spawns servers used by active rules;
      // with no tool calls, none start up.
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

    // The attach stub runs inside runPtySession after the container is up.
    // It collects observations against the live container and returns 0 so
    // the production cleanup path runs normally.
    const attach: PtyAttachFn = async ({ containerId }) => {
      observations.containerId = containerId;

      const sock = await dockerExec(containerId, 'test', '-S', '/run/ironcurtain/mitm-proxy.sock');
      observations.socketTestExitCode = sock.exitCode;

      const procs = await dockerExec(containerId, 'sh', '-c', 'pgrep -af "TCP-LISTEN:18080" || true');
      observations.bridgeProcs = procs.stdout;

      // GET /api/claude_code/settings is in the Anthropic provider allowlist.
      // `-k` skips client-side cert verification (the IronCurtain CA in the
      // image trust store is irrelevant either way), so the TLS handshake
      // with MITM completes and the request is forwarded to the local
      // upstream responder via the ANTHROPIC_BASE_URL override.
      const curl = await dockerExec(
        containerId,
        'curl',
        '-ksS',
        '--max-time',
        '10',
        '--proxy',
        'http://127.0.0.1:18080',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        'https://api.anthropic.com/api/claude_code/settings',
      );
      observations.curlExitCode = curl.exitCode;
      observations.curlHttpCode = curl.stdout.trim();

      return 0;
    };

    await runPtySession({
      config,
      mode: { kind: 'docker', agent: 'claude-code' },
      workspacePath: workspaceDir,
      attach,
    });
  }, 90_000);

  afterAll(async () => {
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalAuth === undefined) delete process.env.IRONCURTAIN_DOCKER_AUTH;
    else process.env.IRONCURTAIN_DOCKER_AUTH = originalAuth;
    if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
    if (upstream) await new Promise<void>((r) => upstream!.server.close(() => r()));
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

  it('a request through the bridge reaches the host MITM and is forwarded to the upstream', () => {
    // curl getting HTTP 200 proves the full chain end-to-end:
    // container curl → bridge socat (port 18080) → host MITM (UDS) →
    // upstream forward (ANTHROPIC_BASE_URL → local responder). curl reads
    // the response from its own connection, so a 200 here can only come
    // from our test responder. (Claude Code's own startup probes also hit
    // the responder concurrently — those are not what we're asserting on.)
    expect(observations.curlExitCode).toBe(0);
    expect(observations.curlHttpCode).toBe('200');
    expect(upstream?.received.length).toBeGreaterThanOrEqual(1);
  });
});
