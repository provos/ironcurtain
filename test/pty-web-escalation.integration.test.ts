/**
 * Integration test: web-UI PTY escalation forwarding against a REAL container.
 *
 * Regression guard for the "escalations never surfaced in web-UI Docker Agent
 * Mode" bug. `PtySessionManager` only starts its `EscalationWatcher` once the
 * PTY bridge's `onSessionDiscovered` fires with the child's registration (which
 * carries the `escalationDir`). The old bridge discovery gave up after a fixed
 * 10s deadline and resolved `null`; a container that took >10s to register
 * (Docker Desktop container-create + MITM/proxy/socat setup) made discovery
 * resolve `null` -> no watcher started -> every escalation sat unread on disk
 * while the agent hung. The fix makes `discoverSessionRegistration`
 * (`src/pty/pty-bridge.ts`) poll until the child exits instead of a 10s
 * deadline. The mock-based Playwright e2e emits `escalation.created` directly,
 * so it never exercised the real watcher -> WS path. This test closes that gap
 * end to end:
 *
 *   real PtySessionManager (real `createPtyBridge`, NOT the StubBridge used in
 *   test/pty/pty-session-manager.test.ts) -> real `ironcurtain start --pty`
 *   child -> real Docker container -> real PTY-registry discovery -> real
 *   EscalationWatcher -> real `escalation.created` on the WebEventBus.
 *
 * Escalation trigger is deterministic and LLM-free: rather than driving the
 * container's Claude Code agent to call a tool (needs an LLM) or running a
 * container-side MCP client (transport-specific + flaky on macOS TCP), we write
 * a `request-<id>.json` directly into the discovered escalation dir. That file
 * is byte-for-byte what the host proxy writes when a real tool call escalates;
 * the tool-call -> policy -> request-file step is already covered by the
 * mcp-proxy / escalation-flow unit tests. Simulating just that one write keeps
 * the test deterministic and transport-agnostic while still exercising the real
 * container + real bridge discovery + real watcher + real `escalation.created`
 * forwarding -- exactly the path that was dead under the old discovery code.
 * Under the OLD code, discovery would time out, the watcher would never start,
 * and `escalation.created` would never fire -- so that assertion is what proves
 * the path is alive.
 *
 * Runs on macOS too (unlike pty-entrypoint.integration.test.ts, which gates on
 * the Linux UDS bridge): the asserted path is entirely host-side (escalation
 * dir + file watcher + WebEventBus) and is transport-agnostic.
 *
 * Hermetic: IRONCURTAIN_HOME is a tempdir (removed on cleanup); a local HTTP
 * responder stands in for api.anthropic.com via ANTHROPIC_BASE_URL; a fake API
 * key is forced (IRONCURTAIN_DOCKER_AUTH=apikey + ANTHROPIC_API_KEY). The host
 * CA is copied so the prebuilt image content-hash matches (no multi-minute
 * rebuild). PtySessionManager spawns a SEPARATE `ironcurtain start --pty` child
 * that loads config from disk, so IRONCURTAIN_HOME is populated with a valid
 * config.json + compiled policy + tool annotations + CA before create().
 *
 * Runtime is pinned to Docker (IRONCURTAIN_CONTAINER_RUNTIME=docker). On macOS
 * 26+ with the Apple `container` CLI installed, `containerRuntime: 'auto'` would
 * otherwise select apple-container, whose containers are invisible to `docker
 * ps` -- the boot-evidence and orphan-cleanup checks here (and the reference
 * pty-entrypoint.integration.test.ts harness) are Docker-based. The escalation
 * path under test is host-side and runtime-agnostic, so pinning Docker loses no
 * coverage and matches the reported Docker Desktop container-create slowness.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { WebSocket as WsWebSocket } from 'ws';

import { PtySessionManager, type PtyStreamSender } from '../src/web-ui/pty-session-manager.js';
import { createPtyBridge } from '../src/pty/pty-bridge.js';
import { SessionManager } from '../src/session/session-manager.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { readActiveRegistrations } from '../src/escalation/session-registry.js';
import { atomicWriteJsonSync } from '../src/escalation/escalation-watcher.js';
import { getPtyRegistryDir } from '../src/config/paths.js';
import { getBundleShortId, type BundleId } from '../src/session/types.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';
import type { EscalationDto } from '../src/web-ui/web-ui-types.js';
import { isDockerAvailable, isDockerImageAvailable } from './helpers/docker-available.js';
import { testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';

const execFile = promisify(execFileCb);

const IMAGE = 'ironcurtain-claude-code:latest';

/** Repo root: this file lives at <repo>/test/, so `..` is the repo root. */
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_ENTRY = resolve(REPO_ROOT, 'src', 'cli.ts');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Locates the CA dir the running `ironcurtain-claude-code:latest` image was
 * built from -- honoring `IRONCURTAIN_HOME` if set, else `~/.ironcurtain`
 * (matching `getIronCurtainHome`). Read BEFORE the test overrides
 * `IRONCURTAIN_HOME` so we point at the developer's real CA, not the sandbox.
 * Copying it keeps the image content-hash matched; a mismatched CA would force
 * a multi-minute rebuild, so we skip rather than rebuild.
 */
function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
// Runs on macOS (TCP transport) as well as Linux: the asserted path is
// host-side and transport-agnostic. Gate only on Docker + the prebuilt image +
// a matching host CA.
const dockerReady = isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

/** Local upstream responder: 200s every request so MITM never leaves the host. */
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

/** Restores (or deletes) a single env var captured before the test overrode it. */
function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

/** Container ids (running or exited) for this session's PTY + macOS sidecar. */
async function sessionContainerIds(shortId: string): Promise<string[]> {
  const names = [`ironcurtain-pty-${shortId}`, `ironcurtain-sidecar-${shortId}`];
  const ids: string[] = [];
  for (const name of names) {
    const { stdout } = await execFile('docker', ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.ID}}']).catch(
      () => ({ stdout: '' }),
    );
    ids.push(
      ...stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return ids;
}

describe.skipIf(!dockerReady)('web-UI PTY escalation forwarding (real container)', () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  let originalBaseUrl: string | undefined;
  let originalApiKey: string | undefined;
  let originalRuntime: string | undefined;
  let upstream: { server: Server; port: number; received: IncomingMessage[] } | undefined;

  let manager: PtySessionManager;
  let eventBus: WebEventBus;
  let registration: PtySessionRegistration;
  let escalationDir = '';
  let shortId = '';
  let label = 0;
  let terminalLog = '';
  // Captured at boot: "is the container running" is sampled right after
  // registration (which itself already proves the container booted) rather than
  // in a later `it`, so the check can't race the agent lifecycle / close()
  // teardown that removes the container.
  let containerRunningAtBoot = false;
  let bootPsSnapshot = '';

  const escalationId = randomUUID();
  const escalationCreated: EscalationDto[] = [];
  const escalationResolved: Array<{ escalationId: string; decision: 'approved' | 'denied' }> = [];

  beforeAll(async () => {
    // Capture env originals FIRST so a partial-setup failure restores rather
    // than deletes vars the runner had set.
    originalHome = process.env.IRONCURTAIN_HOME;
    originalAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    originalRuntime = process.env.IRONCURTAIN_CONTAINER_RUNTIME;

    homeDir = mkdtempSync(join(tmpdir(), 'ironcurtain-pty-web-esc-'));

    // Local responder stands in for api.anthropic.com; started before env vars
    // so the port is known when we override ANTHROPIC_BASE_URL.
    upstream = await startUpstreamResponder();

    process.env.IRONCURTAIN_HOME = homeDir;
    // Force API-key auth so detectAuthMethod doesn't read host OAuth state.
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstream.port}`;
    // Pin a fake key into the env the child inherits (dotenv won't override an
    // already-set var), so the host-side credential is fake and MITM's upstream
    // forward -- redirected to the local responder anyway -- never carries the
    // developer's real ANTHROPIC_API_KEY from the repo `.env`.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-fake-test-key-for-pty-webui-integration';
    // Pin Docker so the container is visible to `docker ps` (see file header).
    process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'docker';

    // Reuse the host CA so the prebuilt image content-hash matches (no rebuild).
    // hostCaDir is non-null here (gated in dockerReady).
    cpSync(hostCaDir as string, join(homeDir, 'ca'), { recursive: true });

    // The child loads compiled policy from `~/.ironcurtain/generated/` first.
    // Policy content is irrelevant here (no tool calls are evaluated -- the
    // escalation is injected directly), so the fixture policy is fine.
    const generatedDir = join(homeDir, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(join(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(join(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    // config.json is the on-disk UserConfig the child parses via loadUserConfig
    // (all fields optional; defaults backfill the rest). Must exist so the child
    // does not launch the first-start wizard (its stdin is a PTY/TTY). Empty
    // string keys would fail the schema's `.min(1)`, so only non-empty fields.
    const userConfig = {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'sk-ant-api03-fake-test-key-for-pty-webui-integration',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoApprove: { enabled: false },
      memory: { enabled: false },
    };
    writeFileSync(join(homeDir, 'config.json'), JSON.stringify(userConfig, null, 2));

    eventBus = new WebEventBus();
    eventBus.subscribe((event, payload) => {
      if (event === 'escalation.created') escalationCreated.push(payload as EscalationDto);
      else if (event === 'escalation.resolved')
        escalationResolved.push(payload as { escalationId: string; decision: 'approved' | 'denied' });
    });

    // Recording sender: also decodes the terminal frames into `terminalLog` so a
    // boot failure can be diagnosed from the child's own PTY output.
    const sender: PtyStreamSender = {
      sendToSubscribers(_clients, event, payload) {
        const p = payload as { data?: string; snapshot?: string };
        if (event === 'session.pty_output' && p.data) {
          terminalLog += Buffer.from(p.data, 'base64').toString('utf8');
        } else if (event === 'session.pty_replay' && p.snapshot) {
          terminalLog += Buffer.from(p.snapshot, 'base64').toString('utf8');
        }
      },
    };

    manager = new PtySessionManager({
      sender,
      sessionManager: new SessionManager(),
      eventBus,
      // `AgentId` is branded (string & { __brand }), so the literal needs the
      // cast under full-program typecheck (the unit test skips this only because
      // `test/` isn't in the build's tsconfig). Mirrors `agentName as AgentId`
      // in src/index.ts.
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
      daemonId: 'esc-int-test',
      daemonPid: process.pid,
      // Real createPtyBridge, but override the spawn target. Under vitest,
      // PtySessionManager's resolveIroncurtainBin() sees the vitest runner as
      // process.argv[1] (not `src/cli.ts`), so it would spawn vitest. Reproduce
      // dev-mode's SINGLE-PROCESS spawn (`node --import tsx src/cli.ts`): the
      // node that runs cli.ts IS the node-pty child, so its pid matches the
      // registration writeRegistration() stamps -- which the bridge's pid-keyed
      // discovery relies on. (A `tsx` CLI shim would fork a child node and break
      // that pid match.)
      createBridge: (opts) =>
        createPtyBridge({ ...opts, ironcurtainBin: process.execPath, prefixArgs: ['--import', 'tsx', CLI_ENTRY] }),
      // Disable the idle-TTL backstop so the session is never reaped mid-test.
      idleTtlMs: 0,
    });

    const created = await manager.create();
    label = created.label;

    // Attach a no-op client so terminal frames flow into `terminalLog` (the
    // manager only sends output when a session has subscribers).
    const client = { bufferedAmount: 0, readyState: 1, send: () => {} } as unknown as WsWebSocket;
    manager.attach(label, client);

    // A registration appearing in the PTY registry proves the container booted:
    // writeRegistration() runs only after `docker.start` + PTY readiness. The
    // tempdir registry is isolated, so a single registration is this session's.
    registration = await waitForRegistration(150_000);
    escalationDir = registration.escalationDir;
    shortId = getBundleShortId(registration.sessionId as unknown as BundleId);

    // Sample container liveness immediately: the container is up at registration
    // (writeRegistration runs after docker.start + PTY readiness). A tight poll
    // wins the race against the fake-auth agent exiting and tearing it down.
    const sampleDeadline = Date.now() + 8_000;
    while (Date.now() < sampleDeadline) {
      const { stdout } = await execFile('docker', [
        'ps',
        '--filter',
        `name=ironcurtain-pty-${shortId}`,
        '--format',
        '{{.Names}}',
      ]).catch(() => ({ stdout: '' }));
      if (stdout.includes(`ironcurtain-pty-${shortId}`)) {
        containerRunningAtBoot = true;
        break;
      }
      await sleep(250);
    }
    bootPsSnapshot = (
      await execFile('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}']).catch(() => ({ stdout: '' }))
    ).stdout;
  }, 180_000);

  afterAll(async () => {
    try {
      await manager.close();
    } catch {
      // Already torn down (or never created) -- afterAll must not throw.
    }
    // Safety net: force-remove any lingering container for this session.
    if (shortId) {
      for (const name of [`ironcurtain-pty-${shortId}`, `ironcurtain-sidecar-${shortId}`]) {
        await execFile('docker', ['rm', '-f', name]).catch(() => undefined);
      }
    }
    restoreEnv('IRONCURTAIN_HOME', originalHome);
    restoreEnv('IRONCURTAIN_DOCKER_AUTH', originalAuth);
    restoreEnv('ANTHROPIC_BASE_URL', originalBaseUrl);
    restoreEnv('ANTHROPIC_API_KEY', originalApiKey);
    restoreEnv('IRONCURTAIN_CONTAINER_RUNTIME', originalRuntime);
    if (upstream) await new Promise<void>((r) => upstream!.server.close(() => r()));
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  });

  /**
   * Polls the (isolated tempdir) PTY registry until this session's child writes
   * its registration, or throws with the child's terminal tail for diagnosis.
   */
  async function waitForRegistration(timeoutMs: number): Promise<PtySessionRegistration> {
    const registryDir = getPtyRegistryDir();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const regs = readActiveRegistrations(registryDir);
      if (regs.length > 0) return regs[0];
      await sleep(500);
    }
    throw new Error(
      `PTY registration never appeared within ${timeoutMs}ms -- the container likely failed to boot.\n` +
        `--- child PTY output (tail) ---\n${terminalLog.slice(-4000)}`,
    );
  }

  /** Polls until `fn()` returns a defined value, or resolves undefined on timeout. */
  async function pollFor<T>(fn: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = fn();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) return undefined;
      await sleep(200);
    }
  }

  it('booted a real Docker container and registered the PTY session', () => {
    // The registration is the definitive boot proof: writeRegistration() runs
    // only after docker.start + PTY readiness. The docker-ps sample corroborates
    // that an `ironcurtain-pty-*` container was actually running.
    expect(registration.sessionId.length).toBeGreaterThan(0);
    expect(escalationDir.length).toBeGreaterThan(0);
    expect(
      containerRunningAtBoot,
      `container ironcurtain-pty-${shortId} was never seen running at boot.\n` +
        `docker ps -a at boot:\n${bootPsSnapshot}\n--- child PTY tail ---\n${terminalLog.slice(-2000)}`,
    ).toBe(true);
  });

  it('forwards a proxy escalation request as escalation.created (web-pty source)', async () => {
    // Byte-for-byte what the host proxy writes on a real escalating tool call.
    mkdirSync(escalationDir, { recursive: true });
    atomicWriteJsonSync(join(escalationDir, `request-${escalationId}.json`), {
      escalationId,
      serverName: 'proxy',
      toolName: 'add_proxy_domain',
      arguments: { domain: 'example.com', justification: 'test' },
      reason: 'test escalation',
    });

    // Under the OLD discovery code the watcher never started, so this event
    // never fired -- reaching it proves the container -> bridge discovery ->
    // watcher -> WebEventBus path is alive.
    const dto = await pollFor(() => escalationCreated.find((e) => e.escalationId === escalationId), 20_000);
    expect(dto, `no escalation.created within 20s. child PTY tail:\n${terminalLog.slice(-2000)}`).toBeDefined();
    expect(dto?.sessionSource.kind).toBe('web-pty');
    expect(dto?.sessionLabel).toBe(label);
    expect(dto?.escalationId).toBe(escalationId);
    expect(dto?.serverName).toBe('proxy');
    expect(dto?.toolName).toBe('add_proxy_domain');
    expect(manager.hasEscalation(escalationId)).toBe(true);
  }, 30_000);

  it('resolveEscalation writes response-*.json and emits escalation.resolved', async () => {
    const accepted = manager.resolveEscalation(escalationId, 'approved');
    expect(accepted).toBe(true);

    const responsePath = join(escalationDir, `response-${escalationId}.json`);
    expect(existsSync(responsePath)).toBe(true);
    expect(JSON.parse(readFileSync(responsePath, 'utf-8')).decision).toBe('approved');

    const resolved = await pollFor(() => escalationResolved.find((e) => e.escalationId === escalationId), 5_000);
    expect(resolved?.decision).toBe('approved');
    expect(manager.hasEscalation(escalationId)).toBe(false);
  });

  it('tears down the container on close (no orphan)', async () => {
    await manager.close();
    // close() awaits child exit only up to PTY_CLOSE_TIMEOUT_MS (5s), but the
    // child's container teardown can outlast that -- poll until it's gone.
    const deadline = Date.now() + 45_000;
    let lingering = await sessionContainerIds(shortId);
    while (lingering.length > 0 && Date.now() < deadline) {
      await sleep(1000);
      lingering = await sessionContainerIds(shortId);
    }
    expect(lingering).toEqual([]);
  }, 60_000);
});
