/**
 * Real-Docker integration test for OpenRouter routing (G10, §12.4).
 *
 * Two token-free scenarios, both driven from inside a real container against a
 * host-side fake OpenRouter upstream. No provider tokens are spent — the fake
 * upstream serves the Appendix-A canned Anthropic-skin SSE (a complete
 * `message_start` … `message_stop` stream) and captures the request it
 * received (post-rewrite body + swapped auth header).
 *
 * Harness topology: the host MITM listens on a TCP port; the container reaches
 * it via `host.docker.internal` (Docker Desktop's host gateway on macOS,
 * `--add-host=host.docker.internal:host-gateway` on Linux) through
 * `HTTPS_PROXY`. This TCP topology is portable across Linux and macOS Docker
 * Desktop — unlike a UDS bind mount, which macOS VirtioFS surfaces as a socket
 * file but cannot proxy connections to (socat/curl get "connection refused"),
 * the reason the whole codebase uses TCP transport on macOS (see
 * `src/docker/platform.ts`). The full `createDockerInfrastructure` bundle is
 * NOT reused because on macOS it stands up a per-session `--internal` network +
 * socat sidecar and offers no upstream-override seam for `openrouter.ai`
 * (`UPSTREAM_ENV_VARS` covers anthropic/openai/google only); this manual
 * harness redirects the openrouter provider's `upstreamTarget` at the fake
 * server directly, exactly like the G3 macro suite. It exercises the real
 * `openrouterProvider` — CONNECT allowlist, endpoint allowlist, bearer
 * key-swap, and the model-map + `session_id` rewriter — with the openrouter-type
 * profile active.
 *
 * Egress isolation is NOT the property under test here (that is
 * `network-isolation.integration.test.ts`); G10 proves the openrouter
 * routing/allowlist/swap through the MITM, so the container runs on the default
 * bridge and the MITM allowlist is the thing that refuses `api.anthropic.com`.
 *
 *   Scenario A — CONNECT/allowlist/swap proof (curl in container):
 *     (a) CONNECT to `openrouter.ai:443` succeeds and reaches the fake upstream;
 *     (b) CONNECT to `api.anthropic.com` is REFUSED (403) with the openrouter
 *         profile active — telemetry host is not allowlisted (B2 / decision B);
 *     (c) the upstream-observed Authorization header is the swapped REAL key.
 *
 *   Scenario B — real-agent token-free turn (real `claude` CLI, D8):
 *     (a) the upstream-observed request body has the rewritten model
 *         (`z-ai/glm-5.2`) + the injected `session_id` (`<sid>:<requestedModel>`
 *         prefix); (b) the auth header is the swapped real key; (c) the agent
 *         turn completes (`claude --output-format json` exits 0 with a parsed
 *         result envelope) — proving Claude Code startup completes with
 *         `api.anthropic.com` unreachable.
 *
 * Run:  INTEGRATION_TEST=1 npm test -- test/docker/openrouter-connect.integration.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import type { ProviderConfig } from '../../src/docker/provider-config.js';
import { makeOpenRouterProviderForProfile } from '../../src/docker/openrouter.js';
import type { ResolvedOpenRouterProfile } from '../../src/config/user-config.js';
import { generateFakeKey } from '../../src/docker/fake-keys.js';
import { DEFAULT_GLM_SLUG } from '../../src/config/user-config.js';
import type { SessionId } from '../../src/session/types.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';
import { createFakeUpstream, type FakeUpstream, type CapturedRequest } from '../helpers/mitm-tls-harness.js';

const execFile = promisify(execFileCb);

/** The claude-code image is required for BOTH scenarios (it carries curl + socat + claude). */
const IMAGE = 'ironcurtain-claude-code:latest';
const REAL_KEY = 'sk-or-v1-realkey-integration-only';
/** Stable conversation id so the injected `session_id` is `<sid>:<requestedModel>`. */
const TOKEN_SESSION_ID = 'g10-conv-1' as SessionId;

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CANNED_MESSAGES_SSE = readFileSync(join(FIXTURES_DIR, 'openrouter-messages-stream.sse'), 'utf-8');

/**
 * A resolved openrouter profile with the default GLM model map + soft z-ai pin
 * + session affinity. Feeds `makeOpenRouterProviderForProfile`, so the rewriter
 * this test drives is byte-for-byte the one production installs for an
 * `openrouter`-type active profile.
 */
const OPENROUTER_PROFILE: ResolvedOpenRouterProfile = {
  type: 'openrouter',
  apiKey: REAL_KEY,
  modelMap: [
    { match: '*opus*', model: DEFAULT_GLM_SLUG },
    { match: '*sonnet*', model: DEFAULT_GLM_SLUG },
    { match: '*haiku*', model: DEFAULT_GLM_SLUG },
  ],
  perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
  providerPreference: undefined,
  sessionAffinity: true,
};

/**
 * Locates the CA dir the running `ironcurtain-claude-code:latest` image was
 * built from. The image bakes the developer's CA into its system trust store,
 * so the MITM must sign per-host leaf certs with that SAME CA — otherwise the
 * container's Node/OpenSSL rejects them (`certificate signature failure`) and
 * the real `claude` turn (Scenario B) never reaches the proxy. Mirrors
 * `skills-end-to-end.integration.test.ts`'s `findHostCaDir`. Read BEFORE any
 * env override so it points at the real CA, not a temp sandbox.
 */
function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(join(ca, 'ca-cert.pem')) ? ca : null;
}

const hostCaDir = findHostCaDir();
// Gate on docker + image + the host CA (required for the container to trust the
// MITM's per-host certs, since the image bakes that CA into its trust store).
const dockerReady = isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

/** Strips the query string from a captured request path (`/p?beta=true` → `/p`). */
function basePath(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFile('docker', args, { timeout: 30_000 });
  return stdout.trim();
}

async function dockerExec(
  containerId: string,
  cmd: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile('docker', ['exec', ...execEnvArgs, containerId, ...cmd], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: typeof e.code === 'number' ? e.code : 1 };
  }
}

/**
 * Env vars threaded into every `docker exec` so the real `claude` CLI (and
 * curl) route through the MITM and trust the CA. Assembled once in beforeAll.
 */
let execEnvArgs: string[] = [];

/**
 * Builds the openrouter provider for Claude Code (messages kind) with its
 * upstream redirected to the local fake server, exactly like the G3 macro
 * harness does. Zero real-network reach: the MITM terminates TLS and forwards
 * to `127.0.0.1:<fakePort>` over plain HTTP.
 */
function buildRedirectedProvider(fakePort: number): ProviderConfig {
  const base = makeOpenRouterProviderForProfile('messages', OPENROUTER_PROFILE, 'claude-code');
  return {
    ...base,
    upstreamTarget: { hostname: '127.0.0.1', port: fakePort, pathPrefix: '', useTls: false },
  };
}

describe.skipIf(!process.env.INTEGRATION_TEST || !dockerReady)('OpenRouter real-Docker (G10 / §12.4)', () => {
  let tempDir: string | undefined;
  let ca: CertificateAuthority;
  let proxy: MitmProxy | undefined;
  let upstream: FakeUpstream | undefined;
  let fakeKey: string;
  let proxyPort = 0;
  let containerId = '';

  /** The upstream's captured requests, narrowed (only called inside `it`, after beforeAll). */
  const capturedRequests = (): CapturedRequest[] => {
    if (!upstream) throw new Error('upstream not initialized');
    return upstream.requests();
  };

  /** The container-side proxy URL (host gateway + the OS-assigned port). */
  const proxyUrl = (): string => `http://host.docker.internal:${proxyPort}`;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'openrouter-connect-test-'));
    // Load the CA the image was built from (gated non-null via `hostCaDir`), so
    // the leaf certs the MITM signs are trusted by the container's baked store.
    ca = loadOrCreateCA(hostCaDir as string);

    // Fake upstream: captures every request; serves the canned Anthropic-skin
    // SSE for the completion POST so the real `claude` CLI parses a valid
    // result. count_tokens (advisory) gets a 404 that Claude Code tolerates.
    upstream = await createFakeUpstream((req: CapturedRequest) => {
      if (req.path.startsWith('/api/v1/messages/count_tokens')) {
        return { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) };
      }
      return { status: 200, contentType: 'text/event-stream', body: CANNED_MESSAGES_SSE };
    });

    // The provider's fake-key prefix drives the sentinel we hand the container;
    // the MITM only swaps a Bearer whose value exactly equals `fakeKey`. The
    // upstreamTarget redirects the openrouter provider at the fake server, so
    // no outbound DNS override is needed (127.0.0.1 is forced).
    const redirected = buildRedirectedProvider(upstream.port);
    fakeKey = generateFakeKey(redirected.fakeKeyPrefix);

    // Host TCP listen (portable to macOS + Linux). The container reaches this
    // through `host.docker.internal`. `listenPort: 0` → OS-assigned.
    proxy = createMitmProxy({
      ca,
      providers: [{ config: redirected, fakeKey, realKey: REAL_KEY }],
      listenPort: 0,
      initialTokenSessionId: TOKEN_SESSION_ID,
    });
    const started = await proxy.start();
    proxyPort = (started as { port: number }).port;

    // Write the (host = baked) CA cert into the bind-mount for curl's explicit
    // `--cacert`. The container already trusts this CA system-wide (baked into
    // its store at build time), so `claude`'s Node TLS trusts the MITM leaf
    // certs without any extra config. Regular-file bind mounts work fine on
    // macOS VirtioFS (only UDS connections don't), so this is macOS-portable.
    writeFileSync(join(tempDir, 'ca-cert.pem'), ca.certPem);

    // Default-bridge container with an explicit host-gateway alias so
    // `host.docker.internal` resolves on Linux too (Docker Desktop provides it
    // automatically on macOS). Egress isolation is not under test here (see the
    // file header), so the default bridge is fine.
    containerId = await docker(
      'create',
      '--name',
      `ironcurtain-openrouter-g10-${Date.now()}`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${tempDir}:/run/ironcurtain`,
      IMAGE,
      'sleep',
      'infinity',
    );
    await docker('start', containerId);

    const proxyUrl = `http://host.docker.internal:${proxyPort}`;
    execEnvArgs = [
      '-e',
      `HTTPS_PROXY=${proxyUrl}`,
      '-e',
      `HTTP_PROXY=${proxyUrl}`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/run/ironcurtain/ca-cert.pem',
    ];
  }, 120_000);

  afterAll(async () => {
    if (containerId) {
      await docker('rm', '-f', containerId).catch(() => {});
    }
    if (proxy) await proxy.stop().catch(() => {});
    if (upstream) upstream.server.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario A — CONNECT / allowlist / bearer-swap proof (curl in container).
  // -------------------------------------------------------------------------
  describe('Scenario A — CONNECT allowlist + bearer swap', () => {
    it('resolves host.docker.internal (harness reachability sanity)', async () => {
      const r = await dockerExec(containerId, ['getent', 'hosts', 'host.docker.internal']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('host.docker.internal');
    });

    it('CONNECT to openrouter.ai succeeds, reaches the fake upstream, and the upstream sees the REAL key', async () => {
      const before = capturedRequests().length;
      // curl posts the sentinel bearer to /api/v1/messages through the proxy.
      // --cacert lets curl trust the MITM's per-host cert (TLS terminates
      // host-side, so the request body + swapped header reach the upstream).
      const result = await dockerExec(containerId, [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--cacert',
        '/run/ironcurtain/ca-cert.pem',
        '--proxy',
        proxyUrl(),
        '--connect-timeout',
        '15',
        '-X',
        'POST',
        '-H',
        `Authorization: Bearer ${fakeKey}`,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
        'https://openrouter.ai/api/v1/messages',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('200');

      // The upstream captured exactly this request with the swapped real key.
      const reqs = capturedRequests();
      expect(reqs.length).toBe(before + 1);
      const captured = reqs[reqs.length - 1];
      expect(basePath(captured.path)).toBe('/api/v1/messages');
      expect(captured.headers['authorization']).toBe(`Bearer ${REAL_KEY}`);
      // The sentinel never reaches the upstream.
      expect(captured.headers['authorization']).not.toContain('ironcurtain');
      // The rewriter remapped the requested Anthropic id to the GLM slug.
      expect(captured.body.model).toBe(DEFAULT_GLM_SLUG);
    }, 60_000);

    it('CONNECT to api.anthropic.com is REFUSED (403) when the openrouter profile is active (B2)', async () => {
      const before = capturedRequests().length;
      // api.anthropic.com is NOT allowlisted for an openrouter-type profile,
      // so the proxy denies the CONNECT with 403 → curl exits non-zero.
      const result = await dockerExec(containerId, [
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--cacert',
        '/run/ironcurtain/ca-cert.pem',
        '--proxy',
        proxyUrl(),
        '--connect-timeout',
        '15',
        'https://api.anthropic.com/v1/messages',
      ]);
      // A refused CONNECT surfaces as a curl proxy error (exit 56), never a
      // successful tunnel — the key B2 property.
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.trim()).not.toBe('200');
      // The refused CONNECT never reached the fake upstream.
      expect(capturedRequests().length).toBe(before);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Scenario B — real `claude` CLI token-free turn (D8).
  // -------------------------------------------------------------------------
  describe('Scenario B — real claude-code turn against fake upstream (D8)', () => {
    it('runs a real claude turn: rewritten model + injected session_id + swapped key, turn completes', async () => {
      const before = capturedRequests().length;
      const requestedModel = 'claude-sonnet-4-6';

      // Minimal real invocation of the Claude Code CLI in headless print mode.
      // The B2d entrypoint branch (ANTHROPIC_AUTH_TOKEN set, no OAuth token)
      // writes a settings.json WITHOUT apiKeyHelper, so `claude` reads the
      // bearer from ANTHROPIC_AUTH_TOKEN directly. We reproduce the minimal
      // onboarding pre-seed + settings the entrypoint writes, then run one
      // turn. NODE_EXTRA_CA_CERTS (threaded via execEnvArgs) makes the CLI's
      // Node TLS trust the MITM cert. No real model, no tokens — the fake
      // upstream serves the canned Anthropic-skin SSE.
      const sid = randomUUID();
      const setup =
        'mkdir -p "$HOME/.claude" && ' +
        'printf \'{"hasCompletedOnboarding":true,"numStartups":1,' +
        '"projects":{"/workspace":{"allowedTools":[],"hasTrustDialogAccepted":true}}}\' > "$HOME/.claude.json" && ' +
        'printf \'{"permissions":{"defaultMode":"bypassPermissions"},' +
        '"skipDangerousModePermissionPrompt":true,"skipWebFetchPreflight":true}\' > "$HOME/.claude/settings.json" && ' +
        'mkdir -p /workspace';

      const result = await dockerExec(
        containerId,
        [
          'bash',
          '-lc',
          `${setup} && cd /workspace && ` +
            'ANTHROPIC_BASE_URL=https://openrouter.ai/api ' +
            `ANTHROPIC_AUTH_TOKEN=${fakeKey} ` +
            'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 ' +
            `claude --session-id ${sid} --dangerously-skip-permissions ` +
            `--output-format json --model ${requestedModel} -p 'Say hello.'`,
        ],
        90_000,
      );

      // (c) The turn completes: `claude --output-format json` exits 0 and emits
      // a parseable result envelope.
      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { type?: string; is_error?: boolean };
      expect(envelope.is_error).not.toBe(true);

      // The fake upstream observed the completion POST. Every request is
      // remapped to the GLM slug; the injected session_id carries the
      // pre-rewrite model, so we locate the MAIN turn by its session_id suffix
      // (Claude Code's background Haiku calls hit the same host+path but carry
      // `:claude-haiku-*`, so ordering alone can't disambiguate them).
      const completions = capturedRequests()
        .slice(before)
        .filter((r) => basePath(r.path) === '/api/v1/messages');
      expect(completions.length).toBeGreaterThan(0);

      const expectedSessionId = `${TOKEN_SESSION_ID}:${requestedModel}`;
      const main = completions.find((r) => r.body.session_id === expectedSessionId);
      expect(main, `no completion carried session_id ${expectedSessionId}`).toBeDefined();
      const mainReq = main as CapturedRequest;

      // (a) rewritten model + injected session_id (`<sid>:<requestedModel>`).
      expect(mainReq.body.model).toBe(DEFAULT_GLM_SLUG);
      expect(mainReq.body.session_id).toBe(expectedSessionId);

      // (b) swapped real key on the upstream request (sentinel never leaks).
      expect(mainReq.headers['authorization']).toBe(`Bearer ${REAL_KEY}`);
      expect(mainReq.headers['authorization']).not.toContain('ironcurtain');
    }, 120_000);
  });
});
