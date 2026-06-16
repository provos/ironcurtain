/**
 * Command-layer integration test for the agent-driven workflow gate CLI.
 *
 * Sibling to `agent-gate-loop.integration.test.ts`, which drives the RPC
 * contract through `DaemonClient` directly. This file instead drives the REAL
 * CLI entry point `runDaemonGateCommand(subcommand, args)` against a live daemon
 * WS surface, so the LOAD-BEARING command code is exercised end-to-end:
 *   - arg parsing (`--json`, `--event`, `--prompt`, `--artifact`)
 *   - `projectStatus` / `exitCodeForPhase` (exit code derives from the
 *     authoritative `phase`, NOT a lifecycle event name)
 *   - RPC error mapping and local fast-fail validation
 *   - stdout (machine JSON) vs stderr (human text) separation
 *
 * Hermetic: no LLM key, no Docker. The fixture runs in `builtin` mode and the
 * `WorkflowManager.sessionFactoryOverride` DI seam supplies an artifact-writing
 * stub session, so the pre-gate `agent` state resolves instantly and writes the
 * `draft` artifact.
 *
 * Daemon discovery: `runDaemonGateCommand` calls `discoverDaemon()` internally,
 * which reads `getWebUiStatePath()` (`$IRONCURTAIN_HOME/web-ui.json`). We point
 * `IRONCURTAIN_HOME` at a fresh temp dir per test and write a `web-ui.json` that
 * matches the daemon's `writeWebUiState` shape, so the command finds OUR server
 * and never touches the real `~/.ironcurtain`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebUiServer, type WebUiServerOptions } from '../../src/web-ui/web-ui-server.js';
import { WorkflowManager } from '../../src/workflow/workflow-manager.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { getWebUiStatePath } from '../../src/config/paths.js';
import type { ControlRequestHandler } from '../../src/daemon/control-socket.js';
import type { RunRecord } from '../../src/cron/types.js';
import { runDaemonGateCommand } from '../../src/workflow/daemon-gate-commands.js';
import { createArtifactAwareSession, approvedResponse } from './test-helpers.js';
import type { Session, SessionOptions } from '../../src/session/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'test-gate-smoke', 'workflow.yaml');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeMockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
    }),
    addJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    runJobNow: vi.fn().mockResolvedValue({} as RunRecord),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

interface Harness {
  readonly server: WebUiServer;
  readonly baseDir: string;
  readonly home: string;
}

let harness: Harness | undefined;
let originalHome: string | undefined;
/** Chunks captured from `process.stdout.write` while a command runs. */
const stdoutChunks: string[] = [];
let restoreStdout: (() => void) | undefined;

/**
 * Boots the full stack, points `IRONCURTAIN_HOME` at a fresh temp dir, and
 * writes a `web-ui.json` (matching the daemon's `writeWebUiState` shape) so
 * `discoverDaemon()` resolves to OUR server. The stub session factory writes
 * the `draft` artifact and returns an approved status block on every visit, so
 * `produce` resolves instantly and `FORCE_REVISION` can loop back.
 */
async function boot(): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'ic-gate-cmd-home-'));
  originalHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;

  const baseDir = mkdtempSync(join(tmpdir(), 'ic-gate-cmd-'));

  const sessionFactoryOverride: (opts: SessionOptions) => Promise<Session> = () =>
    Promise.resolve(
      createArtifactAwareSession(
        // Generous supply: one per `produce` visit (initial + each FORCE_REVISION loop).
        Array.from({ length: 8 }, () => ({ text: approvedResponse(), artifacts: ['draft'] })),
        baseDir,
      ),
    );

  const opts: WebUiServerOptions = {
    port: 0,
    host: '127.0.0.1',
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    maxConcurrentWebSessions: 3,
  };
  const server = new WebUiServer(opts);
  await server.start();

  const manager = new WorkflowManager({
    eventBus: server.getEventBus(),
    baseDirOverride: baseDir,
    sessionFactoryOverride,
  });
  server.setWorkflowManager(manager);

  // Write discovery state in the daemon's exact shape so the command finds us.
  writeFileSync(
    getWebUiStatePath(),
    JSON.stringify({ port: server.getPort(), host: '127.0.0.1', token: server.getAuthToken() }) + '\n',
    { mode: 0o600 },
  );

  return { server, baseDir, home };
}

/**
 * Runs a CLI subcommand against the live server while capturing stdout. Returns
 * the exit code and the parsed single-line JSON object the command emitted (the
 * `--json` contract is one newline-terminated JSON object on stdout).
 */
async function runCommand(
  subcommand: string,
  args: string[],
): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string }> {
  stdoutChunks.length = 0;
  const exitCode = await runDaemonGateCommand(subcommand, args);
  const stdout = stdoutChunks.join('');
  const trimmed = stdout.trim();
  const json = trimmed.length > 0 ? (JSON.parse(trimmed) as Record<string, unknown>) : {};
  return { exitCode, json, stdout };
}

beforeEach(() => {
  // Capture stdout so we can assert the machine JSON and prove human text does
  // NOT leak onto stdout. stderr is left alone (human channel). The original
  // `write` is restored verbatim in `afterEach` to avoid the `any`-typed
  // overload that `mockRestore` re-derives.
  stdoutChunks.length = 0;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  restoreStdout = () => {
    process.stdout.write = original;
  };
});

afterEach(async () => {
  restoreStdout?.();
  restoreStdout = undefined;

  if (harness) {
    await harness.server.stop().catch(() => {});
    rmSync(harness.baseDir, { recursive: true, force: true });
    rmSync(harness.home, { recursive: true, force: true });
    harness = undefined;
  }

  if (originalHome === undefined) {
    delete process.env.IRONCURTAIN_HOME;
  } else {
    process.env.IRONCURTAIN_HOME = originalHome;
  }
  originalHome = undefined;
});

/**
 * Drives a fresh workflow to its gate via the CLI: `run` then `await`. Returns
 * the workflow id once `await` reports `phase:'waiting_human'`. Retries `await`
 * in case the gate is raised slightly after the first poll (the command itself
 * blocks on the gate, so one call is normally sufficient).
 */
async function startAndAwaitGate(): Promise<string> {
  const run = await runCommand('run', [FIXTURE_PATH, 'Draft and review a thing', '--json']);
  expect(run.exitCode).toBe(0);
  expect(run.json.ok).toBe(true);
  const workflowId = run.json.workflowId as string;
  expect(typeof workflowId).toBe('string');

  const awaited = await runCommand('await', [workflowId, '--json']);
  expect(awaited.exitCode).toBe(0);
  expect(awaited.json.phase).toBe('waiting_human');
  return workflowId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('daemon gate commands (command-layer integration)', () => {
  it('run -> await(gate) -> show -> APPROVE -> await(completed)', async () => {
    harness = await boot();

    // (1) run: absolute fixture path resolves via resolveWorkflowPath.
    const run = await runCommand('run', [FIXTURE_PATH, 'Draft and review a thing', '--json']);
    expect(run.exitCode).toBe(0);
    expect(run.json.ok).toBe(true);
    const workflowId = run.json.workflowId as string;
    expect(typeof workflowId).toBe('string');
    // The human-readable summary lives on stderr, never stdout: stdout is a
    // single JSON object.
    expect(run.stdout.trim().split('\n')).toHaveLength(1);

    // (2) await to gate: machine-readable gate visibility.
    const atGate = await runCommand('await', [workflowId, '--json']);
    expect(atGate.exitCode).toBe(0);
    expect(atGate.json.phase).toBe('waiting_human');
    const gate = atGate.json.gate as { stateName: string; presentedArtifacts: string[]; acceptedEvents: string[] };
    expect(gate.stateName).toBe('review');
    expect(gate.presentedArtifacts).toContain('draft');
    expect(gate.acceptedEvents).toEqual(expect.arrayContaining(['APPROVE', 'FORCE_REVISION', 'ABORT']));

    // (3) show: artifact content round-trips through the command layer.
    const show = await runCommand('show', [workflowId, '--artifact', 'draft', '--json']);
    expect(show.exitCode).toBe(0);
    expect(show.json.ok).toBe(true);
    const files = show.json.files as { path: string; content: string }[];
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].content).toContain('content for draft');

    // (4) gate APPROVE then await to terminal completed.
    const approve = await runCommand('gate', [workflowId, '--event', 'APPROVE', '--json']);
    expect(approve.exitCode).toBe(0);
    expect(approve.json.ok).toBe(true);
    expect(approve.json.event).toBe('APPROVE');

    const done = await runCommand('await', [workflowId, '--json']);
    expect(done.exitCode).toBe(0);
    expect(done.json.phase).toBe('completed');
  }, 30_000);

  it('gate ABORT -> await reports phase:aborted with exit 3 (event name is NOT authoritative)', async () => {
    harness = await boot();

    const workflowId = await startAndAwaitGate();

    // A gate-ABORT routes to the `aborted` terminal, which emits a
    // `workflow.completed` lifecycle event. The `await` follow-up `workflows.get`
    // is authoritative: phase is `aborted`, and the exit code derives from THAT.
    const abort = await runCommand('gate', [workflowId, '--event', 'ABORT', '--json']);
    expect(abort.exitCode).toBe(0);
    expect(abort.json.ok).toBe(true);

    const terminal = await runCommand('await', [workflowId, '--json']);
    expect(terminal.json.phase).toBe('aborted');
    // The critical assertion: exit 3 (EXIT_TERMINAL_FAILURE) from the phase,
    // even though the lifecycle event that fired was `workflow.completed`.
    expect(terminal.exitCode).toBe(3);
  }, 30_000);

  it('gate FORCE_REVISION with no --prompt fast-fails locally: exit 2, INVALID_PARAMS', async () => {
    harness = await boot();

    // Local fast-fail happens BEFORE any RPC, so no workflow needs to exist.
    const bad = await runCommand('gate', ['some-workflow-id', '--event', 'FORCE_REVISION', '--json']);
    expect(bad.exitCode).toBe(2);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toBe('INVALID_PARAMS');
  }, 30_000);

  it('gate with unknown --event fast-fails locally: exit 2, INVALID_EVENT', async () => {
    harness = await boot();

    const bad = await runCommand('gate', ['some-workflow-id', '--event', 'BOGUS', '--json']);
    expect(bad.exitCode).toBe(2);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toBe('INVALID_EVENT');
  }, 30_000);
});
