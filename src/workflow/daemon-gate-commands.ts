/**
 * Non-interactive, machine-readable CLI surface for driving gated workflows on
 * a running daemon: `run` / `status` / `await` / `gate` / `show`.
 *
 * These commands talk to the daemon's existing WebSocket JSON-RPC interface via
 * the leaf {@link DaemonClient}; they never import the orchestrator/manager
 * runtime. An autonomous agent uses them as run-to-completion tool calls:
 *
 *   run -> await -> (show -> gate -> await)* -> terminal
 *
 * Output convention: a single newline-terminated JSON object to **stdout** when
 * `--json` is set (the agent parses stdout); human-readable text to **stderr**.
 * Exit codes are derived from the authoritative workflow `phase`, never from a
 * lifecycle event name (a gate-ABORT fires a `completed` event but reports
 * `phase:'aborted'`).
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveWorkflowPath } from './discovery.js';
import {
  createDaemonClient,
  type DaemonClient,
  type DaemonEvent,
  type RpcResult,
} from '../daemon-client/daemon-client.js';
import { parseArgsResult, type ParseArgsResult, type ParseArgsOptions } from './cli-shared.js';
import type { WorkflowDetailDto } from '../web-ui/web-ui-types.js';
import type { HumanGateRequestDto } from './types.js';

// ---------------------------------------------------------------------------
// Exit codes (stable contract for shell-only agents)
// ---------------------------------------------------------------------------

const EXIT_OK = 0;
const EXIT_USAGE = 2;
/** Terminal failure phase: `failed` or `aborted`. */
const EXIT_TERMINAL_FAILURE = 3;
/** `await` timed out before a decision point or terminal. */
const EXIT_AWAIT_TIMEOUT = 4;
/** Generic operational failure (RPC error, no daemon, etc.). */
const EXIT_ERROR = 1;

const DEFAULT_AWAIT_TIMEOUT_SEC = 600;
const ENSURE_DAEMON_TIMEOUT_MS = 15_000;
const ENSURE_DAEMON_POLL_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

interface OutputMode {
  readonly json: boolean;
}

/** Emits a machine-readable JSON object to stdout (when `--json`). */
function emitJson(mode: OutputMode, obj: Record<string, unknown>): void {
  if (mode.json) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  }
}

/** Emits a human-readable line to stderr (never stdout). */
function emitText(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Prints a CLI-level error in both channels and returns the exit code. */
function fail(mode: OutputMode, error: string, extra: Record<string, unknown> = {}, exitCode = EXIT_ERROR): number {
  emitJson(mode, { ok: false, error, ...extra });
  emitText(formatErrorText(error, extra));
  return exitCode;
}

function formatErrorText(error: string, extra: Record<string, unknown>): string {
  const message = typeof extra.message === 'string' ? extra.message : undefined;
  return message ? `Error: ${error}: ${message}` : `Error: ${error}`;
}

// ---------------------------------------------------------------------------
// Argument parsing (under the stdout/exit-code contract)
// ---------------------------------------------------------------------------

type ParsedGateArgs = Extract<ParseArgsResult, { readonly ok: true }>;

type GateArgs =
  | {
      readonly ok: true;
      readonly mode: OutputMode;
      readonly values: ParsedGateArgs['values'];
      readonly positionals: ParsedGateArgs['positionals'];
    }
  | { readonly ok: false; readonly exitCode: number };

/**
 * Cheap pre-scan for the `--json` flag, used to pick the output channel when
 * strict parsing FAILS before {@link OutputMode} can be read from parsed
 * values. A typo'd flag must still honor the caller's `--json` choice so the
 * failure lands on the right channel (machine JSON on stdout vs human stderr).
 */
function detectOutputMode(args: string[]): OutputMode {
  return { json: args.includes('--json') };
}

/**
 * Parses a daemon-gate subcommand's args under this module's output contract.
 *
 * On an unknown/typo'd flag or a missing option value, reports a structured
 * `INVALID_USAGE` (JSON on stdout when `--json`, human text on stderr) and exits
 * {@link EXIT_USAGE} — rather than the bare stderr `process.exit(1)` that
 * {@link parseArgsStrict} would do, which an agent driving the CLI cannot parse.
 */
function parseGateArgs(args: string[], options: ParseArgsOptions): GateArgs {
  const result = parseArgsResult({ args, options, allowPositionals: true });
  if (!result.ok) {
    const mode = detectOutputMode(args);
    return {
      ok: false,
      exitCode: fail(
        mode,
        'INVALID_USAGE',
        { message: result.message, hint: 'Run with --help to see available options.' },
        EXIT_USAGE,
      ),
    };
  }
  return {
    ok: true,
    mode: { json: result.values.json === true },
    values: result.values,
    positionals: result.positionals,
  };
}

// ---------------------------------------------------------------------------
// Status projection (shared by `status` and `await`)
// ---------------------------------------------------------------------------

type WorkflowPhase = WorkflowDetailDto['phase'];

/**
 * The stable machine-readable status object emitted by `status` and `await`.
 *
 * `ok: true` reports that the STATUS QUERY succeeded, NOT that the workflow
 * outcome was favorable: a `failed`/`aborted` workflow is still reported with
 * `ok: true`. Agents branch on `phase` (and the process exit code from
 * {@link exitCodeForPhase}), never on this `ok`.
 */
interface StatusProjection {
  readonly ok: true;
  readonly workflowId: string;
  readonly phase: WorkflowPhase;
  readonly currentState: string;
  readonly round: number;
  readonly gate?: HumanGateRequestDto;
}

/** Projects a `workflows.get` DTO into the stable status shape. */
function projectStatus(detail: WorkflowDetailDto): StatusProjection {
  return {
    ok: true,
    workflowId: detail.workflowId,
    phase: detail.phase,
    currentState: detail.currentState,
    round: detail.round,
    ...(detail.phase === 'waiting_human' && detail.gate ? { gate: detail.gate } : {}),
  };
}

/** Exit code derived from the authoritative phase (never an event name). */
function exitCodeForPhase(phase: WorkflowPhase): number {
  switch (phase) {
    case 'waiting_human':
    case 'completed':
      return EXIT_OK;
    case 'failed':
    case 'aborted':
    case 'interrupted':
      // `interrupted` is the disk-fallback state for a run stranded by a daemon
      // restart with no live orchestrator: a stuck workflow is a failure, not a
      // success, so it shares the terminal-failure exit code.
      return EXIT_TERMINAL_FAILURE;
    default:
      // `running`: not a resting point for this projection, but surfaced as a
      // non-failure so the agent re-issues `await`.
      return EXIT_OK;
  }
}

function isTerminalPhase(phase: WorkflowPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'aborted';
}

// ---------------------------------------------------------------------------
// Client lifecycle
// ---------------------------------------------------------------------------

/**
 * Outcome of a single attempt to discover + connect to a running daemon.
 *
 * `no-endpoint` means discovery found no `web-ui.json` (no daemon configured);
 * `connect-failed` means an endpoint existed but a connection could not be
 * established (stale state file from a crashed daemon, or the daemon is down).
 * These are distinguished so the non-`--ensure-daemon` path can preserve the
 * historical `DAEMON_NOT_RUNNING` vs `DAEMON_CONNECT_FAILED` error strings.
 */
type ConnectAttempt =
  | { readonly kind: 'connected'; readonly client: DaemonClient }
  | { readonly kind: 'no-endpoint' }
  | { readonly kind: 'connect-failed'; readonly message: string };

/**
 * Performs ONE discover + create + connect cycle. On any failure the half-open
 * client is closed so no attempt leaks a socket. Readiness here means a daemon
 * actually ANSWERED a connect — never merely "the state file exists" (a crashed
 * daemon leaves a stale `web-ui.json` that discovery would otherwise accept).
 */
async function attemptConnect(): Promise<ConnectAttempt> {
  let client: DaemonClient;
  try {
    client = createDaemonClient();
  } catch (err) {
    // Cross-module catch: branch on the `code` discriminant rather than only
    // `instanceof` (per CLAUDE.md), so this stays robust if the error crosses a
    // module boundary that defeats `instanceof`.
    if (isDaemonNotRunning(err)) return { kind: 'no-endpoint' };
    throw err;
  }

  try {
    await client.connect();
  } catch (err) {
    await client.close().catch(() => {});
    return { kind: 'connect-failed', message: err instanceof Error ? err.message : String(err) };
  }

  return { kind: 'connected', client };
}

/**
 * Returns a connected {@link DaemonClient}, ensuring a daemon exists first when
 * `--ensure-daemon` is set. Returns `undefined` (after printing an error) when
 * no daemon can be reached.
 *
 * Control flow:
 *  1. Attempt a real connect to an existing daemon; on success, return it.
 *  2. If that fails and `ensureDaemon` is set, spawn a detached daemon ONCE and
 *     poll by RE-ATTEMPTING connect (not by polling discovery — a stale state
 *     file would make discovery a false positive) until a connect succeeds or
 *     `ENSURE_DAEMON_TIMEOUT_MS` elapses.
 *  3. If that fails and `ensureDaemon` is NOT set, report the historical error:
 *     `DAEMON_NOT_RUNNING` (no endpoint) or `DAEMON_CONNECT_FAILED` (endpoint
 *     present but unreachable).
 */
async function openClient(mode: OutputMode, ensureDaemon: boolean): Promise<DaemonClient | undefined> {
  const initial = await attemptConnect();
  if (initial.kind === 'connected') return initial.client;

  if (ensureDaemon) {
    const ensured = await ensureDaemonRunning();
    if (ensured) return ensured;
    fail(mode, 'DAEMON_START_TIMEOUT', {
      hint: `Timed out waiting for a daemon to come up after ${ENSURE_DAEMON_TIMEOUT_MS}ms`,
    });
    return undefined;
  }

  if (initial.kind === 'no-endpoint') {
    fail(mode, 'DAEMON_NOT_RUNNING', { hint: 'Start the daemon with: ironcurtain daemon --web-ui' });
    return undefined;
  }

  fail(mode, 'DAEMON_CONNECT_FAILED', { message: initial.message });
  return undefined;
}

/** Discriminant check for the "no daemon running" error (no `instanceof`). */
function isDaemonNotRunning(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'DAEMON_NOT_RUNNING';
}

/**
 * Spawns a detached `ironcurtain daemon --web-ui` ONCE, then polls by
 * re-attempting a real connect until one succeeds or a bounded timeout elapses.
 * Returns the connected client on success, or `undefined` on timeout. Arg-array
 * spawn — no shell string concatenation (CLAUDE.md Safe Coding).
 *
 * Polling on connect (rather than discovery) is what makes readiness real: a
 * stale `web-ui.json` left by a crashed daemon would make `discoverDaemon()`
 * return immediately, but its socket will not accept a connection.
 */
async function ensureDaemonRunning(): Promise<DaemonClient | undefined> {
  const cliEntry = process.argv[1];
  if (!cliEntry) return undefined;

  const child = spawn(process.execPath, [cliEntry, 'daemon', '--web-ui'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + ENSURE_DAEMON_TIMEOUT_MS;
  for (;;) {
    const attempt = await attemptConnect();
    if (attempt.kind === 'connected') return attempt.client;
    if (Date.now() >= deadline) return undefined;
    await delay(ENSURE_DAEMON_POLL_INTERVAL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// RPC error mapping
// ---------------------------------------------------------------------------

/** Reports an `{ok:false}` RPC result and returns the chosen exit code. */
function reportRpcError(mode: OutputMode, result: Extract<RpcResult<unknown>, { ok: false }>): number {
  const extra: Record<string, unknown> = { message: result.message };
  // LINT_FAILED carries structured diagnostics under `error.data.diagnostics`.
  if (result.code === 'LINT_FAILED') {
    const diagnostics = extractDiagnostics(result.data);
    if (diagnostics) extra.diagnostics = diagnostics;
  }
  return fail(mode, result.code, extra);
}

function extractDiagnostics(data: unknown): unknown[] | undefined {
  if (data !== null && typeof data === 'object' && 'diagnostics' in data) {
    const diagnostics: unknown = (data as { diagnostics: unknown }).diagnostics;
    if (Array.isArray(diagnostics)) return diagnostics as unknown[];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `workflow run`
// ---------------------------------------------------------------------------

async function runRun(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    workspace: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const definitionRef = positionals[0];
  const taskDescription = positionals[1];
  if (!definitionRef || !taskDescription) {
    emitText('Usage: ironcurtain workflow run <name-or-path> "task" [--workspace <path>] [--json] [--ensure-daemon]');
    return EXIT_USAGE;
  }

  // Resolve the definition path client-side: the daemon does not resolve names.
  const definitionPath = resolveWorkflowPath(definitionRef);
  if (!definitionPath) {
    return fail(mode, 'WORKFLOW_DEFINITION_NOT_FOUND', {
      ref: definitionRef,
      hint: "Run 'ironcurtain workflow list' to see available workflows.",
    });
  }

  // Validate the workspace client-side BEFORE connecting to the daemon, so an
  // invalid --workspace fails fast without spawning or connecting it.
  let workspacePath: string | undefined;
  if (typeof values.workspace === 'string') {
    workspacePath = resolve(values.workspace);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(workspacePath).isDirectory();
    } catch {
      // Any stat failure — ENOENT (incl. a racy delete after a check), EACCES,
      // ELOOP, etc. — means the path is unusable as a workspace. Treat as invalid
      // so the command returns the structured error instead of throwing.
      isDirectory = false;
    }
    if (!isDirectory) {
      return fail(mode, 'WORKSPACE_NOT_DIRECTORY', { path: workspacePath });
    }
  }

  const client = await openClient(mode, values['ensure-daemon'] === true);
  if (!client) return EXIT_ERROR;

  try {
    const params: Record<string, unknown> = { definitionPath, taskDescription };
    if (workspacePath !== undefined) params.workspacePath = workspacePath;

    const result = await client.call<{ workflowId: string }>('workflows.start', params);
    if (!result.ok) return reportRpcError(mode, result);

    const { workflowId } = result.payload;
    emitJson(mode, { ok: true, workflowId, phase: 'running' });
    emitText(`Started workflow ${workflowId} (use: ironcurtain workflow await ${workflowId})`);
    return EXIT_OK;
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// `workflow status`
// ---------------------------------------------------------------------------

async function runStatus(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  if (!workflowId) {
    emitText('Usage: ironcurtain workflow status <workflowId> [--json] [--ensure-daemon]');
    return EXIT_USAGE;
  }

  const client = await openClient(mode, values['ensure-daemon'] === true);
  if (!client) return EXIT_ERROR;

  try {
    const result = await client.call<WorkflowDetailDto>('workflows.get', { workflowId });
    if (!result.ok) return reportRpcError(mode, result);
    return emitStatus(mode, result.payload);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Emits a status projection and returns the phase-derived exit code. */
function emitStatus(mode: OutputMode, detail: WorkflowDetailDto): number {
  const projection = projectStatus(detail);
  emitJson(mode, { ...projection });
  emitText(formatStatusText(projection));
  return exitCodeForPhase(projection.phase);
}

function formatStatusText(p: StatusProjection): string {
  if (p.phase === 'waiting_human' && p.gate) {
    return `Workflow ${p.workflowId} is waiting at gate "${p.gate.stateName}" (events: ${p.gate.acceptedEvents.join(', ')}; artifacts: ${p.gate.presentedArtifacts.join(', ') || 'none'})`;
  }
  return `Workflow ${p.workflowId} phase: ${p.phase} (state: ${p.currentState})`;
}

// ---------------------------------------------------------------------------
// `workflow await`
// ---------------------------------------------------------------------------

async function runAwait(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    timeout: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  if (!workflowId) {
    emitText('Usage: ironcurtain workflow await <workflowId> [--timeout <sec>] [--json] [--ensure-daemon]');
    return EXIT_USAGE;
  }

  const timeoutSec = parseTimeout(values.timeout);
  if (timeoutSec === undefined) {
    emitText('Error: --timeout must be a positive number of seconds');
    return EXIT_USAGE;
  }

  const client = await openClient(mode, values['ensure-daemon'] === true);
  if (!client) return EXIT_ERROR;

  try {
    return await awaitDecisionPoint(client, mode, workflowId, timeoutSec * 1000);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Blocks until the workflow reaches a gate (`waiting_human`) or a terminal,
 * then makes one authoritative `workflows.get` and reports/branches on its
 * `phase`.
 *
 * Resolution triggers: the initial `get` already at a gate/terminal; a
 * `workflow.gate_raised` event; or a terminal *event*
 * (`workflow.completed` / `workflow.failed`). Because a gate-ABORT emits a
 * `completed` event while reporting `phase:'aborted'`, the event name is never
 * trusted — the follow-up `get` is authoritative.
 */
async function awaitDecisionPoint(
  client: DaemonClient,
  mode: OutputMode,
  workflowId: string,
  timeoutMs: number,
): Promise<number> {
  const settled = createSettlePromise();
  // The timeout timer rejects `settled.promise`. The early-return branches below
  // (initial get errored, or already at a resting phase) return WITHOUT awaiting
  // it, so if the timer fires during a slow initial get that rejection would go
  // unhandled. Attach a no-op catch as a permanent handler; the explicit
  // `await settled.promise` further down still observes the rejection itself.
  void settled.promise.catch(() => {});

  // Subscribe BEFORE the initial get so we never miss an event that fires in
  // the window between the get returning and the subscription attaching.
  const unsubscribe = client.onEvent((event) => {
    if (eventTargetsWorkflow(event, workflowId) && isResolvingEvent(event.event)) {
      settled.resolve();
    }
  });

  const timer = setTimeout(() => settled.reject(new AwaitTimeoutError()), timeoutMs);

  try {
    // Race-closer: a gate/terminal reached before subscription is caught here.
    const initial = await client.call<WorkflowDetailDto>('workflows.get', { workflowId });
    if (!initial.ok) return reportRpcError(mode, initial);
    if (isRestingPhase(initial.payload.phase)) {
      return emitStatus(mode, initial.payload);
    }

    await settled.promise;

    const authoritative = await client.call<WorkflowDetailDto>('workflows.get', { workflowId });
    if (!authoritative.ok) return reportRpcError(mode, authoritative);
    return emitStatus(mode, authoritative.payload);
  } catch (err) {
    if (err instanceof AwaitTimeoutError) {
      emitJson(mode, { ok: false, error: 'AWAIT_TIMEOUT', phase: 'running' });
      emitText(`Workflow ${workflowId} did not reach a decision point before the timeout`);
      return EXIT_AWAIT_TIMEOUT;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

/**
 * A phase at which `await` stops: a gate, any terminal, or `interrupted`.
 *
 * `interrupted` is the on-disk fallback synthesized after a daemon restart for a
 * run whose checkpoint exists but has no live orchestrator. No further lifecycle
 * event will ever fire for it, so `await` must resolve immediately rather than
 * block for the full timeout waiting on an event that will never come.
 */
function isRestingPhase(phase: WorkflowPhase): boolean {
  return phase === 'waiting_human' || phase === 'interrupted' || isTerminalPhase(phase);
}

function isResolvingEvent(eventName: string): boolean {
  return eventName === 'workflow.gate_raised' || eventName === 'workflow.completed' || eventName === 'workflow.failed';
}

function eventTargetsWorkflow(event: DaemonEvent, workflowId: string): boolean {
  const payload = event.payload;
  return (
    payload !== null && typeof payload === 'object' && (payload as { workflowId?: unknown }).workflowId === workflowId
  );
}

class AwaitTimeoutError extends Error {}

interface SettlePromise {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

function createSettlePromise(): SettlePromise {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function parseTimeout(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_AWAIT_TIMEOUT_SEC;
  if (typeof raw !== 'string') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// `workflow gate`
// ---------------------------------------------------------------------------

const GATE_EVENTS = ['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'] as const;
type GateEvent = (typeof GATE_EVENTS)[number];

function isGateEvent(value: unknown): value is GateEvent {
  return typeof value === 'string' && (GATE_EVENTS as readonly string[]).includes(value);
}

/** Events whose semantics require non-empty operator feedback. */
function requiresPrompt(event: GateEvent): boolean {
  return event === 'FORCE_REVISION' || event === 'REPLAN';
}

async function runGate(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    event: { type: 'string' },
    prompt: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  if (!workflowId) {
    emitText(
      'Usage: ironcurtain workflow gate <workflowId> --event <EVENT> [--prompt <text>] [--json] [--ensure-daemon]',
    );
    return EXIT_USAGE;
  }

  const event = values.event;
  if (!isGateEvent(event)) {
    return fail(mode, 'INVALID_EVENT', { hint: `--event must be one of: ${GATE_EVENTS.join(', ')}` }, EXIT_USAGE);
  }

  const prompt = typeof values.prompt === 'string' ? values.prompt : undefined;
  // Local fast-fail (the daemon re-validates and is authoritative).
  if (requiresPrompt(event) && (prompt === undefined || prompt.trim().length === 0)) {
    return fail(mode, 'INVALID_PARAMS', { message: `Feedback is required for ${event} events` }, EXIT_USAGE);
  }

  const client = await openClient(mode, values['ensure-daemon'] === true);
  if (!client) return EXIT_ERROR;

  try {
    const params: Record<string, unknown> = { workflowId, event };
    if (prompt !== undefined) params.prompt = prompt;

    const result = await client.call('workflows.resolveGate', params);
    if (!result.ok) return reportRpcError(mode, result);

    emitJson(mode, { ok: true, workflowId, event });
    emitText(`Resolved gate for ${workflowId} with ${event}`);
    return EXIT_OK;
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// `workflow show`
// ---------------------------------------------------------------------------

interface ArtifactContent {
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

async function runShow(args: string[]): Promise<number> {
  const parsed = parseGateArgs(args, {
    json: { type: 'boolean' },
    artifact: { type: 'string' },
    'ensure-daemon': { type: 'boolean' },
  });
  if (!parsed.ok) return parsed.exitCode;
  const { mode, values, positionals } = parsed;

  const workflowId = positionals[0];
  const artifactName = values.artifact;
  if (!workflowId || typeof artifactName !== 'string') {
    emitText('Usage: ironcurtain workflow show <workflowId> --artifact <name> [--json] [--ensure-daemon]');
    return EXIT_USAGE;
  }

  const client = await openClient(mode, values['ensure-daemon'] === true);
  if (!client) return EXIT_ERROR;

  try {
    const result = await client.call<ArtifactContent>('workflows.artifacts', { workflowId, artifactName });
    if (!result.ok) return reportRpcError(mode, result);

    emitJson(mode, { ok: true, files: result.payload.files });
    for (const file of result.payload.files) {
      emitText(`--- ${file.path} ---`);
      emitText(file.content);
    }
    return EXIT_OK;
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes a daemon-backed gate subcommand. Returns the process exit code; the
 * caller (`workflow-command.ts`) is responsible for `process.exit`.
 */
export async function runDaemonGateCommand(subcommand: string, args: string[]): Promise<number> {
  switch (subcommand) {
    case 'run':
      return runRun(args);
    case 'status':
      return runStatus(args);
    case 'await':
      return runAwait(args);
    case 'gate':
      return runGate(args);
    case 'show':
      return runShow(args);
    default:
      emitText(`Unknown daemon-backed workflow subcommand: ${subcommand}`);
      return EXIT_USAGE;
  }
}
