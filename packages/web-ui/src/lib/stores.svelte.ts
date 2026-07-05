/**
 * Application state management using Svelte 5 runes.
 *
 * The store holds all reactive state and exposes methods to mutate it.
 * The WebSocket client feeds events into the store via handleEvent().
 */

import type {
  SessionDto,
  EscalationDto,
  DaemonStatusDto,
  JobListDto,
  OutputLine,
  PendingEscalation,
  ConversationTurn,
  BudgetSummaryDto,
  PersonaListItem,
  PersonaDetailDto,
  PersonaEditResultDto,
  PersonaCompileOperationDto,
  PersonaCompileStreamAckDto,
  PersonaListCompilesDto,
  ResumableWorkflowDto,
  WorkflowSummaryDto,
  WorkflowDetailDto,
  WorkflowDefinitionDto,
  WorkflowReadmeDto,
  HumanGateRequestDto,
  FileTreeResponseDto,
  FileContentResponseDto,
  ArtifactContentDto,
  MessageLogResponseDto,
  GetModelProvidersDto,
  SetModelProvidersDto,
  OpenrouterModelsDto,
  PtySink,
  CreateSessionOptions,
} from './types.js';
import { PHASE } from './types.js';
import { createWsClient, type PreflightResult, type WsClient } from './ws-client.js';
import { handleEvent as handleEventPure } from './event-handler.js';

export type ViewId = 'dashboard' | 'sessions' | 'escalations' | 'jobs' | 'workflows' | 'personas' | 'settings';
export type ThemeId = 'iron' | 'daylight' | 'midnight';

const MAX_OUTPUT_LINES = 2000;
const THEME_KEY = 'ic-theme';
const AUTH_TOKEN_KEY = 'ic-auth-token';

const VALID_THEMES: ReadonlySet<string> = new Set<ThemeId>(['iron', 'daylight', 'midnight']);

export function getTheme(): ThemeId {
  const stored = localStorage.getItem(THEME_KEY);
  return stored && VALID_THEMES.has(stored) ? (stored as ThemeId) : 'iron';
}

export function setTheme(theme: ThemeId): void {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

class AppState {
  connected: boolean = $state(false);
  hasToken: boolean = $state(false);
  /**
   * Non-null when the last auth preflight (or server-side rejection)
   * indicated the token is bad. The browser WebSocket API hides HTTP
   * status codes, so we rely on an HTTP preflight to `/ws/auth` and
   * surface the result here to drive UI state.
   */
  authError: 'invalid_token' | null = $state(null);
  daemonStatus: DaemonStatusDto | null = $state(null);
  sessions: Map<number, SessionDto> = $state(new Map());
  selectedSessionLabel: number | null = $state(null);
  pendingEscalations: Map<string, PendingEscalation> = $state(new Map());
  escalationDisplayNumber: number = $state(0);
  escalationDismissedAt: number = $state(0);
  jobs: JobListDto[] = $state([]);
  sessionOutputs: Map<number, OutputLine[]> = $state(new Map());
  currentView: ViewId = $state('dashboard');

  // Workflow state
  workflows: Map<string, WorkflowSummaryDto> = $state(new Map());
  selectedWorkflowId: string | null = $state(null);
  pendingGates: Map<string, HumanGateRequestDto> = $state(new Map());

  // Persona streamed-compile state, keyed by operationId. Holds both live
  // (started/running) and recently-terminal (done/failed) operations as they
  // arrive via persona.compile.* events, hydrated on (re)connect via
  // personas.listCompiles.
  personaCompiles: Map<string, PersonaCompileOperationDto> = $state(new Map());

  get selectedSession(): SessionDto | null {
    if (this.selectedSessionLabel === null) return null;
    return this.sessions.get(this.selectedSessionLabel) ?? null;
  }

  get escalationCount(): number {
    return this.pendingEscalations.size;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  addOutput(label: number, line: OutputLine): void {
    let existing = this.sessionOutputs.get(label) ?? [];

    // Remove stale "Thinking..." lines when real content arrives
    if (line.kind === 'tool_call' || line.kind === 'assistant' || line.kind === 'escalation') {
      existing = existing.filter((l) => l.kind !== 'thinking');
    }

    existing = [...existing, line];

    // Cap output to prevent unbounded memory growth
    if (existing.length > MAX_OUTPUT_LINES) {
      existing = existing.slice(existing.length - MAX_OUTPUT_LINES);
    }

    // Create a new Map so Svelte 5 detects the change
    this.sessionOutputs = new Map(this.sessionOutputs).set(label, existing);
  }

  filterOutput(label: number, predicate: (line: OutputLine) => boolean): void {
    const existing = this.sessionOutputs.get(label);
    if (!existing) return;
    const filtered = existing.filter(predicate);
    if (filtered.length !== existing.length) {
      this.sessionOutputs = new Map(this.sessionOutputs).set(label, filtered);
    }
  }

  removeOutput(label: number): void {
    const next = new Map(this.sessionOutputs);
    next.delete(label);
    this.sessionOutputs = next;
  }

  getOutput(label: number): OutputLine[] {
    return this.sessionOutputs.get(label) ?? [];
  }
}

export const appState = new AppState();

/**
 * Monotonically increasing counter bumped whenever connection-driven
 * refresh state is triggered, including the initial WebSocket connect
 * and any later reconnects.
 * Components can read `.value` as a $effect dependency to force
 * re-fetches after a connection event, even when other reactive
 * values haven't changed.
 */
export const connectionGeneration = $state({ value: 0 });

/**
 * Monotonically increasing counter bumped on every `personas.changed`
 * server-push event (persona create/edit/delete/memory/broad-policy mutation).
 * The Personas view reads `.value` as a $effect dependency to refresh its
 * locally-held persona list + selected detail, mirroring how `job.list_changed`
 * drives `refreshJobs`. Kept as a standalone reactive object (rather than on
 * appState) because the persona list lives in the route component, not the
 * global store.
 */
export const personasChangedGeneration = $state({ value: 0 });

/**
 * Monotonically increasing counter bumped on every `config.changed` server-push
 * event (a `config.setModelProviders` write). The Settings view reads `.value`
 * as a $effect dependency to refresh its locally-held provider-profile view,
 * mirroring `personasChangedGeneration`. Kept off appState because the config
 * view state lives in the route component, not the global store.
 */
export const configChangedGeneration = $state({ value: 0 });

/**
 * Per-label terminal sink registry. A `web-pty` session's frames
 * (`session.pty_replay` / `session.pty_output`) can arrive BEFORE its
 * `TerminalConsole` has created its xterm terminal — a fast daemon sends the
 * one-shot replay the instant it receives `ptyAttach`, which can beat the
 * component's mount effect. So each sink BUFFERS frames until the route connects
 * the mounted terminal's live handle, then drains them in order — a replay
 * snapshot is never dropped (which would blank a reconnect to an idle session).
 * The pure event handler routes `session.pty_*` events here via `getPtySink`.
 * Not reactive — imperative handles, never rendered.
 */
class BufferingPtySink implements PtySink {
  private live: PtySink | null = null;
  private buffered: Array<{ reset: boolean; b64: string }> = [];

  write(dataB64: string): void {
    if (this.live) this.live.write(dataB64);
    else this.buffered.push({ reset: false, b64: dataB64 });
  }

  reset(snapshotB64: string): void {
    if (this.live) this.live.reset(snapshotB64);
    // A fresh snapshot is the source of truth: it supersedes buffered deltas.
    else this.buffered = [{ reset: true, b64: snapshotB64 }];
  }

  /** Connect the mounted terminal and flush any buffered frames, in order. */
  connect(handle: PtySink): void {
    this.live = handle;
    for (const frame of this.buffered) {
      if (frame.reset) handle.reset(frame.b64);
      else handle.write(frame.b64);
    }
    this.buffered = [];
  }

  disconnect(): void {
    this.live = null;
  }
}

const ptySinks = new Map<number, BufferingPtySink>();

/** Registers a buffering sink for a label. Idempotent — never clobbers a live sink. */
export function registerPtySink(label: number): void {
  if (!ptySinks.has(label)) ptySinks.set(label, new BufferingPtySink());
}

export function unregisterPtySink(label: number): void {
  ptySinks.delete(label);
}

/**
 * Connects a mounted terminal's live handle for `label`, draining buffered
 * frames. Order-independent with `registerPtySink` (creates the sink if the
 * terminal mounted before the route registered it).
 */
export function connectPtyTerminal(label: number, handle: PtySink): void {
  let sink = ptySinks.get(label);
  if (!sink) {
    sink = new BufferingPtySink();
    ptySinks.set(label, sink);
  }
  sink.connect(handle);
}

/** Disconnects the live handle (the terminal unmounted); later frames re-buffer. */
export function disconnectPtyTerminal(label: number): void {
  ptySinks.get(label)?.disconnect();
}

// WebSocket client singleton
let wsClient: WsClient | null = null;

export function getWsClient(): WsClient {
  if (!wsClient) {
    wsClient = createWsClient(verifyAuthToken);
    wireEventHandlers(wsClient);
  }
  return wsClient;
}

/**
 * HTTP preflight against the daemon's `/ws/auth` endpoint. The status is
 * mapped to three outcomes:
 *   - 200 → 'ok'
 *   - 401 → 'invalid' (clear the token and stop retrying)
 *   - anything else, including network errors → 'offline' (keep retrying;
 *     a transient 5xx must not destructively purge a good token)
 *
 * Exported for testing.
 */
export async function verifyAuthToken(token: string, fetchImpl: typeof fetch = fetch): Promise<PreflightResult> {
  try {
    const url = buildDaemonUrl(`/ws/auth?token=${encodeURIComponent(token)}`, { ws: false });
    const res = await fetchImpl(url, { method: 'GET', cache: 'no-store' });
    if (res.status === 200) return 'ok';
    if (res.status === 401) return 'invalid';
    return 'offline';
  } catch {
    return 'offline';
  }
}

function wireEventHandlers(client: WsClient): void {
  client.onConnectionChange((connected) => {
    appState.connected = connected;
    if (connected) {
      // Connection success clears any stale auth error from a previous
      // attempt (e.g. user pasted a bad token, then a good one).
      appState.authError = null;
      refreshAll(client);
    }
  });

  client.onAuthError(() => {
    handleAuthError();
  });

  client.onEvent((event, payload) => {
    handleEventPure(
      appState,
      {
        refreshJobs: () => refreshJobs(client),
        refreshPersonas: () => {
          personasChangedGeneration.value++;
        },
        refreshConfig: () => {
          configChangedGeneration.value++;
        },
        assignDisplayNumber: (_escalationId: string) => ++appState.escalationDisplayNumber,
        getPtySink: (label: number) => ptySinks.get(label),
      },
      event,
      payload,
    );
  });
}

/** Purge the bad token and flip the UI back to the token input. */
function handleAuthError(): void {
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  appState.hasToken = false;
  appState.authError = 'invalid_token';
}

let isInitialConnect = true;

async function refreshAll(client: WsClient): Promise<void> {
  try {
    const [status, sessions, jobs, escalations, workflowsList, personaCompiles] = await Promise.all([
      client.request<DaemonStatusDto>('status'),
      client.request<SessionDto[]>('sessions.list'),
      client.request<JobListDto[]>('jobs.list'),
      client.request<EscalationDto[]>('escalations.list'),
      client.request<WorkflowSummaryDto[]>('workflows.list').catch(() => [] as WorkflowSummaryDto[]),
      client
        .request<PersonaListCompilesDto>('personas.listCompiles', {})
        .catch(() => ({ active: [], recent: [], queueDepth: 0 }) as PersonaListCompilesDto),
    ]);

    appState.daemonStatus = status;

    const newSessions = new Map<number, SessionDto>();
    for (const session of sessions) {
      newSessions.set(session.label, session);
    }
    appState.sessions = newSessions;

    appState.jobs = jobs;

    const newWorkflows = new Map<string, WorkflowSummaryDto>();
    for (const wf of workflowsList) {
      newWorkflows.set(wf.workflowId, wf);
    }
    appState.workflows = newWorkflows;

    // Rehydrate persona compile operations (active wins over recent on id collision).
    const newPersonaCompiles = new Map<string, PersonaCompileOperationDto>();
    for (const op of personaCompiles.recent) newPersonaCompiles.set(op.operationId, op);
    for (const op of personaCompiles.active) newPersonaCompiles.set(op.operationId, op);
    appState.personaCompiles = newPersonaCompiles;

    // Repopulate pending gates for any workflow stuck at a human gate.
    // Events may have been lost during disconnect, leaving pendingGates empty.
    const newGates = new Map<string, HumanGateRequestDto>();
    const gatePromises = workflowsList
      .filter((wf) => wf.phase === PHASE.WAITING_HUMAN)
      .map(async (wf) => {
        try {
          const detail = await client.request<WorkflowDetailDto>('workflows.get', { workflowId: wf.workflowId });
          if (detail.gate) {
            newGates.set(detail.gate.gateId, detail.gate);
          }
        } catch {
          // Best-effort -- gate will appear on next event
        }
      });
    await Promise.all(gatePromises);
    // Merge fetched gates into current pendingGates rather than replacing,
    // so gate_raised events that arrived during the async fetch are preserved.
    const merged = new Map(appState.pendingGates);
    for (const [id, gate] of newGates) {
      merged.set(id, gate);
    }
    appState.pendingGates = merged;

    // Bump connection generation so detail views re-fetch
    connectionGeneration.value++;

    const newEscalations = new Map<string, PendingEscalation>();
    for (const esc of escalations) {
      const displayNumber = ++appState.escalationDisplayNumber;
      newEscalations.set(esc.escalationId, { ...esc, displayNumber });
    }
    appState.pendingEscalations = newEscalations;
    // Remove stale escalation output lines that are no longer pending
    for (const [label, lines] of appState.sessionOutputs) {
      const filtered = lines.filter(
        (line) => line.kind !== 'escalation' || (line.escalationId && newEscalations.has(line.escalationId)),
      );
      if (filtered.length !== lines.length) {
        appState.sessionOutputs = new Map(appState.sessionOutputs).set(label, filtered);
      }
    }
    // On initial connect, suppress auto-open for pre-existing escalations.
    // On reconnect, preserve the watermark so new escalations during
    // disconnect will trigger the modal.
    if (isInitialConnect) {
      appState.escalationDismissedAt = appState.escalationDisplayNumber;
      isInitialConnect = false;
    }
  } catch (err) {
    console.error('Failed to refresh state:', err);
  }
}

let refreshJobsTimer: ReturnType<typeof setTimeout> | null = null;

function refreshJobs(client: WsClient): void {
  if (refreshJobsTimer) clearTimeout(refreshJobsTimer);
  refreshJobsTimer = setTimeout(async () => {
    refreshJobsTimer = null;
    try {
      appState.jobs = await client.request<JobListDto[]>('jobs.list');
    } catch {
      // Best-effort
    }
  }, 300);
}

/**
 * Build a daemon-relative URL. `ws: true` selects ws(s) for the WebSocket
 * endpoint; otherwise http(s) is used for plain HTTP requests like the
 * auth preflight. The scheme mirrors the page's own protocol so dev
 * (http) and prod (https) Just Work.
 */
function buildDaemonUrl(path: string, opts: { ws: boolean }): string {
  const isHttps = window.location.protocol === 'https:';
  const protocol = opts.ws ? (isHttps ? 'wss:' : 'ws:') : isHttps ? 'https:' : 'http:';
  return `${protocol}//${window.location.host}${path}`;
}

function buildWsUrl(): string {
  return buildDaemonUrl('/ws', { ws: true });
}

/**
 * Initialize the WebSocket connection. Extracts token from URL
 * or sessionStorage. `hasToken` is only flipped to `true` after the
 * store-level preflight inside `startConnectionWithToken()` succeeds or
 * returns 'offline' — we don't flip it here so a bad token doesn't
 * flash the dashboard.
 */
export async function initConnection(): Promise<void> {
  const client = getWsClient();

  const params = new URLSearchParams(window.location.search);
  let token = params.get('token');

  if (token) {
    sessionStorage.setItem(AUTH_TOKEN_KEY, token);
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  } else {
    token = sessionStorage.getItem(AUTH_TOKEN_KEY);
  }

  if (!token) {
    return;
  }

  await startConnectionWithToken(client, token);
}

/**
 * Send a resolve request for a pending escalation.
 * Callers handle errors in their own way (rethrow, display, etc.).
 */
export async function resolveEscalation(
  escalationId: string,
  decision: 'approved' | 'denied',
  whitelistSelection?: number,
): Promise<void> {
  const params: Record<string, unknown> = { escalationId, decision };
  if (decision === 'approved' && whitelistSelection != null) {
    params.whitelistSelection = whitelistSelection;
  }
  await getWsClient().request('escalations.resolve', params);
}

// ── Session RPC actions ──────────────────────────────────────────────

/**
 * Create a session. `persona` applies to every mode; `workspacePath`,
 * `providerProfileName`, and `model` are docker/web-pty launch options (mux
 * `/new` parity) and are IGNORED by the code-mode chatbox path server-side.
 * Only the provided keys are sent so the backend schema's optionals stay unset.
 */
export async function createSession(opts?: CreateSessionOptions): Promise<{ label: number }> {
  const params: Record<string, unknown> = {};
  if (opts?.persona) params.persona = opts.persona;
  if (opts?.workspacePath) params.workspacePath = opts.workspacePath;
  if (opts?.providerProfileName) params.providerProfileName = opts.providerProfileName;
  if (opts?.model) params.model = opts.model;
  return getWsClient().request<{ label: number }>('sessions.create', params);
}

export async function sendSessionMessage(label: number, text: string): Promise<void> {
  await getWsClient().request('sessions.send', { label, text });
}

export async function endSession(label: number): Promise<void> {
  await getWsClient().request('sessions.end', { label });
}

export async function loadSessionHistory(label: number): Promise<ConversationTurn[]> {
  return getWsClient().request<ConversationTurn[]>('sessions.history', { label });
}

export async function loadSessionBudget(label: number): Promise<BudgetSummaryDto> {
  return getWsClient().request<BudgetSummaryDto>('sessions.budget', { label });
}

// ── PTY terminal RPC actions (web-pty sessions) ──────────────────────
//
// Attach/detach manage this client's subscription to a session's terminal
// stream; input/resize forward keystrokes and the browser xterm's size to the
// child PTY. `data` is base64 of the UTF-8 bytes of the keystroke string.
// Ending a PTY session reuses `endSession` (`sessions.end`).

export async function attachPty(label: number): Promise<void> {
  await getWsClient().request('sessions.ptyAttach', { label });
}

export async function detachPty(label: number): Promise<void> {
  await getWsClient().request('sessions.ptyDetach', { label });
}

export async function sendPtyInput(label: number, dataB64: string): Promise<void> {
  await getWsClient().request('sessions.ptyInput', { label, data: dataB64 });
}

export async function sendPtyResize(label: number, cols: number, rows: number): Promise<void> {
  await getWsClient().request('sessions.ptyResize', { label, cols, rows });
}

/**
 * Send a TRUSTED user message to a web-pty session. Unlike `sendPtyInput`
 * (raw keystrokes, base64, never trusted), `text` is PLAIN text: the daemon
 * records it as trusted user-context (authorizing auto-approval) and injects it
 * into the child PTY. This is the only browser path to auto-approval.
 */
export async function sendPtyPrompt(label: number, text: string): Promise<void> {
  await getWsClient().request('sessions.ptyPrompt', { label, text });
}

// ── Job RPC actions ──────────────────────────────────────────────────

export async function runJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.run', { jobId });
}

export async function enableJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.enable', { jobId });
}

export async function disableJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.disable', { jobId });
}

export async function removeJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.remove', { jobId });
}

export async function recompileJob(jobId: string): Promise<void> {
  await getWsClient().request('jobs.recompile', { jobId });
}

// ── Persona RPC actions ──────────────────────────────────────────────

export async function listPersonas(): Promise<PersonaListItem[]> {
  return getWsClient().request<PersonaListItem[]>('personas.list');
}

// ── Persona CRUD mutation RPC actions (Phase 1c) ──────────────────────
//
// All five are gated server-side on the daemon's `--allow-policy-mutation`
// flag: when off they reject with POLICY_MUTATION_FORBIDDEN. The UI hides
// these controls when `appState.daemonStatus.allowPolicyMutation` is false,
// so a forbidden rejection is a defense-in-depth path, not the normal one.
// Errors (RpcError with a `.code`) bubble to the caller for inline/actionable
// affordances. Each successful mutation also triggers a `personas.changed`
// server-push event handled by the event handler.

/**
 * Create a new persona. `servers: undefined` (or omitted) means "all servers
 * (incl. future)"; a non-empty array narrows to those servers explicitly.
 * Errors: INVALID_PARAMS (bad slug / empty description), PERSONA_EXISTS,
 * POLICY_MUTATION_FORBIDDEN.
 */
export async function createPersona(input: {
  name: string;
  description: string;
  servers?: string[];
  memoryEnabled?: boolean;
  constitution?: string;
}): Promise<PersonaDetailDto> {
  const params: Record<string, unknown> = {
    name: input.name,
    description: input.description,
  };
  if (input.servers !== undefined) params.servers = input.servers;
  if (input.memoryEnabled !== undefined) params.memoryEnabled = input.memoryEnabled;
  if (input.constitution !== undefined) params.constitution = input.constitution;
  return getWsClient().request<PersonaDetailDto>('personas.create', params);
}

/**
 * Replace a persona's constitution. Returns `{ stale }` — `stale: true` means
 * the previously compiled policy no longer matches the constitution and should
 * be recompiled. Errors: PERSONA_NOT_FOUND, POLICY_MUTATION_FORBIDDEN.
 */
export async function editPersonaConstitution(name: string, constitution: string): Promise<PersonaEditResultDto> {
  return getWsClient().request<PersonaEditResultDto>('personas.editConstitution', { name, constitution });
}

/** Toggle a persona's persistent-memory flag. Errors: PERSONA_NOT_FOUND, POLICY_MUTATION_FORBIDDEN. */
export async function setPersonaMemory(name: string, enabled: boolean): Promise<PersonaDetailDto> {
  return getWsClient().request<PersonaDetailDto>('personas.setMemory', { name, enabled });
}

/**
 * Set a persona's broad-policy opt-in. This is the ONLY way to set
 * `allowBroadPolicy`; it is never inferred from the constitution. When enabled,
 * the compiler's broad-policy validator permits wildcard domains/lists and
 * out-of-workspace paths. Errors: PERSONA_NOT_FOUND, POLICY_MUTATION_FORBIDDEN.
 */
export async function setPersonaBroadPolicyOptIn(name: string, enabled: boolean): Promise<PersonaDetailDto> {
  return getWsClient().request<PersonaDetailDto>('personas.setBroadPolicyOptIn', { name, enabled });
}

/**
 * Delete a persona. Soft by default (renamed into a trash dir, policy left
 * inert); `force: true` hard-deletes and revokes the policy. `confirmed: true`
 * is required by the backend schema. Errors: PERSONA_NOT_FOUND,
 * POLICY_MUTATION_FORBIDDEN.
 */
export async function deletePersona(name: string, opts?: { force?: boolean }): Promise<{ deleted: true }> {
  const params: Record<string, unknown> = { name, confirmed: true };
  if (opts?.force) params.force = true;
  return getWsClient().request<{ deleted: true }>('personas.delete', params);
}

// ── Workflow RPC actions ────────────────────────────────────────────

export async function listWorkflowDefinitions(): Promise<WorkflowDefinitionDto[]> {
  return getWsClient().request<WorkflowDefinitionDto[]>('workflows.listDefinitions');
}

/**
 * Fetches a workflow's co-packaged README markdown, addressed either by its
 * definition manifest path (Start picker, no running workflow) or by a
 * running/past workflow id (detail view). Exactly one argument is sent.
 */
export async function getWorkflowReadme(target: {
  definitionPath?: string;
  workflowId?: string;
}): Promise<WorkflowReadmeDto> {
  return getWsClient().request<WorkflowReadmeDto>('workflows.readme', target);
}

export async function listWorkflows(): Promise<WorkflowSummaryDto[]> {
  return getWsClient().request<WorkflowSummaryDto[]>('workflows.list');
}

export async function startWorkflow(
  definitionPath: string,
  taskDescription: string,
  workspacePath?: string,
): Promise<{ workflowId: string }> {
  const params: Record<string, unknown> = { definitionPath, taskDescription };
  if (workspacePath) params.workspacePath = workspacePath;
  return getWsClient().request<{ workflowId: string }>('workflows.start', params);
}

export async function abortWorkflow(workflowId: string): Promise<void> {
  await getWsClient().request('workflows.abort', { workflowId });
}

export async function resolveWorkflowGate(workflowId: string, event: string, prompt?: string): Promise<void> {
  const params: Record<string, unknown> = { workflowId, event };
  if (prompt) params.prompt = prompt;
  await getWsClient().request('workflows.resolveGate', params);
}

export async function refreshWorkflows(): Promise<void> {
  try {
    const workflows = await listWorkflows();
    const newMap = new Map<string, WorkflowSummaryDto>();
    for (const wf of workflows) {
      newMap.set(wf.workflowId, wf);
    }
    appState.workflows = newMap;
  } catch {
    // Best-effort
  }
}

export async function getWorkflowDetail(workflowId: string): Promise<WorkflowDetailDto> {
  return getWsClient().request<WorkflowDetailDto>('workflows.get', { workflowId });
}

export async function listResumableWorkflows(): Promise<ResumableWorkflowDto[]> {
  return getWsClient().request<ResumableWorkflowDto[]>('workflows.listResumable');
}

export async function importWorkflow(baseDir: string): Promise<{ workflowId: string }> {
  return getWsClient().request<{ workflowId: string }>('workflows.import', { baseDir });
}

export async function resumeWorkflow(workflowId: string): Promise<{ workflowId: string }> {
  return getWsClient().request<{ workflowId: string }>('workflows.resume', { workflowId });
}

// ── Workflow file browser RPC actions ──────────────────────────────────

export async function getWorkflowFileTree(workflowId: string, path?: string): Promise<FileTreeResponseDto> {
  const params: Record<string, unknown> = { workflowId };
  if (path) params.path = path;
  return getWsClient().request<FileTreeResponseDto>('workflows.fileTree', params);
}

export async function getWorkflowFileContent(workflowId: string, path: string): Promise<FileContentResponseDto> {
  return getWsClient().request<FileContentResponseDto>('workflows.fileContent', { workflowId, path });
}

export async function getWorkflowArtifacts(workflowId: string, artifactName: string): Promise<ArtifactContentDto> {
  return getWsClient().request<ArtifactContentDto>('workflows.artifacts', { workflowId, artifactName });
}

/**
 * Fetch a page of message-log entries for a workflow. No client-side caching:
 * every call hits the daemon so live runs see fresh entries on each invocation.
 *
 * Cursor pagination per design D5: pass the oldest entry's `ts` as `before`
 * to fetch the next (older) page. RPC errors bubble to the caller.
 */
export async function getWorkflowMessageLog(
  workflowId: string,
  opts?: { before?: string; limit?: number },
): Promise<MessageLogResponseDto> {
  const params: Record<string, unknown> = { workflowId };
  if (opts?.before !== undefined) params.before = opts.before;
  if (opts?.limit !== undefined) params.limit = opts.limit;
  return getWsClient().request<MessageLogResponseDto>('workflows.messageLog', params);
}

// ── Persona RPC actions (extended) ─────────────────────────────────────

export async function getPersonaDetail(name: string): Promise<PersonaDetailDto> {
  return getWsClient().request<PersonaDetailDto>('personas.get', { name });
}

/**
 * Fire-and-return a streamed persona compile. The ack carries the minted
 * operationId; subsequent progress arrives via persona.compile.* events that
 * land in `appState.personaCompiles`. RPC errors (e.g. POLICY_MUTATION_FORBIDDEN,
 * COMPILE_IN_PROGRESS, CREDENTIALS_MISSING) bubble to the caller.
 */
export async function startPersonaCompile(name: string): Promise<PersonaCompileStreamAckDto> {
  return getWsClient().request<PersonaCompileStreamAckDto>('personas.compileStream', { name });
}

/** Read a single compile operation snapshot (active live record, else recent LRU). */
export async function getPersonaCompile(operationId: string): Promise<PersonaCompileOperationDto> {
  return getWsClient().request<PersonaCompileOperationDto>('personas.getCompile', { operationId });
}

/** List in-flight + recently-terminal compile operations. */
export async function listPersonaCompiles(): Promise<PersonaListCompilesDto> {
  return getWsClient().request<PersonaListCompilesDto>('personas.listCompiles', {});
}

/**
 * (Re)hydrate `appState.personaCompiles` from the daemon's authoritative
 * active+recent records. Called on connect/reconnect and by the Personas view.
 * Returns the operationIds present on the server so callers can detect a
 * locally-tracked op that the server no longer knows about (interrupted).
 */
export async function hydratePersonaCompiles(): Promise<Set<string>> {
  const { active, recent } = await listPersonaCompiles();
  const next = new Map<string, PersonaCompileOperationDto>();
  for (const op of recent) next.set(op.operationId, op);
  // Active records win over a recent record with the same id.
  for (const op of active) next.set(op.operationId, op);
  appState.personaCompiles = next;
  return new Set(next.keys());
}

// ── Config (modelProviders) RPC actions ────────────────────────────────
//
// `config.getModelProviders` is ungated (read); `config.setModelProviders` is
// gated server-side on the daemon's `--allow-policy-mutation` flag (rejects with
// POLICY_MUTATION_FORBIDDEN when off). The Settings view hides mutation controls
// when `appState.daemonStatus.allowPolicyMutation` is false. A successful write
// broadcasts a `config.changed` server-push event (bumps configChangedGeneration).

/**
 * Read the model-provider registry. Every openrouter profile's `apiKey` is
 * masked (`sk-...xyz` / 'none'); the implicit `native` profile is included.
 */
export async function getModelProviders(): Promise<GetModelProvidersDto> {
  return getWsClient().request<GetModelProvidersDto>('config.getModelProviders', {});
}

/**
 * Write the WHOLE model-provider registry. Sends the complete `profiles` record
 * (the backend replaces it wholesale). Per the M5 contract, leaving a profile's
 * masked `apiKey` untouched preserves the stored key; '' clears it; a new string
 * sets it. Returns the fresh masked registry. Errors (POLICY_MUTATION_FORBIDDEN,
 * INVALID_PARAMS) bubble to the caller.
 */
export async function setModelProviders(input: SetModelProvidersDto): Promise<GetModelProvidersDto> {
  return getWsClient().request<GetModelProvidersDto>('config.setModelProviders', {
    ...(input.default !== undefined ? { default: input.default } : {}),
    profiles: input.profiles,
  });
}

/**
 * Fetch the OpenRouter model-slug catalog for autocomplete/validation. `source`
 * tells the caller whether the list is authoritative (`live`/`cache` → hard-block
 * unknown slugs) or the offline floor (`bundled` → warn-only). Ungated read.
 * Pass `forceRefresh` to bypass the daemon's 6h cache (the editor's Refresh button).
 */
export async function listOpenrouterModels(forceRefresh = false): Promise<OpenrouterModelsDto> {
  return getWsClient().request<OpenrouterModelsDto>(
    'config.listOpenrouterModels',
    forceRefresh ? { forceRefresh: true } : {},
  );
}

export async function connectWithToken(token: string): Promise<void> {
  sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  // Deliberately do NOT clear `authError` here. If the user re-pastes the
  // same bad token, clearing upfront blanks the banner for one tick and
  // then `handleAuthError()` sets it back — a visible flash. The banner
  // is cleared on successful connection in `onConnectionChange(true)`.
  const client = getWsClient();
  await startConnectionWithToken(client, token);
}

/**
 * Shared entry point for starting a connection with a token: runs the
 * HTTP preflight so the UI can distinguish an invalid token from an
 * unreachable daemon, then kicks off the WS client. The client's
 * reconnect loop will preflight again on each retry.
 */
async function startConnectionWithToken(client: WsClient, token: string): Promise<void> {
  const result = await verifyAuthToken(token);
  if (result === 'invalid') {
    handleAuthError();
    return;
  }
  // 'ok' or 'offline' — in both cases we're committing to the token and
  // want the UI past the login gate. On 'offline' the WS client will
  // enter the reconnect loop and preflight again each time.
  appState.hasToken = true;
  client.connect(buildWsUrl(), token);
}
