/**
 * Application state management using Svelte 5 runes.
 *
 * The store holds all reactive state and exposes methods to mutate it.
 * The WebSocket client feeds events into the store via handleEvent().
 */

import type { SessionDto, EscalationDto, DaemonStatusDto, JobListDto, OutputLine, PendingEscalation } from './types.js';
import { createWsClient, type WsClient } from './ws-client.js';
import { handleEvent as handleEventPure } from './event-handler.js';

export type ViewId = 'dashboard' | 'sessions' | 'escalations' | 'jobs';
export type ThemeId = 'iron' | 'daylight' | 'midnight';

const MAX_OUTPUT_LINES = 2000;
const THEME_KEY = 'ic-theme';

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
  daemonStatus: DaemonStatusDto | null = $state(null);
  sessions: Map<number, SessionDto> = $state(new Map());
  selectedSessionLabel: number | null = $state(null);
  pendingEscalations: Map<string, PendingEscalation> = $state(new Map());
  escalationDisplayNumber: number = $state(0);
  escalationDismissedAt: number = $state(0);
  jobs: JobListDto[] = $state([]);
  sessionOutputs: Map<number, OutputLine[]> = $state(new Map());
  currentView: ViewId = $state('dashboard');

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

// WebSocket client singleton
let wsClient: WsClient | null = null;

export function getWsClient(): WsClient {
  if (!wsClient) {
    wsClient = createWsClient();
    wireEventHandlers(wsClient);
  }
  return wsClient;
}

function wireEventHandlers(client: WsClient): void {
  client.onConnectionChange((connected) => {
    appState.connected = connected;
    if (connected) {
      refreshAll(client);
    }
  });

  client.onEvent((event, payload) => {
    handleEventPure(
      appState,
      {
        refreshJobs: () => refreshJobs(client),
        assignDisplayNumber: () => ++appState.escalationDisplayNumber,
      },
      event,
      payload,
    );
  });
}

async function refreshAll(client: WsClient): Promise<void> {
  try {
    const [status, sessions, jobs, escalations] = await Promise.all([
      client.request<DaemonStatusDto>('status'),
      client.request<SessionDto[]>('sessions.list'),
      client.request<JobListDto[]>('jobs.list'),
      client.request<EscalationDto[]>('escalations.list'),
    ]);

    appState.daemonStatus = status;

    const newSessions = new Map<number, SessionDto>();
    for (const session of sessions) {
      newSessions.set(session.label, session);
    }
    appState.sessions = newSessions;

    appState.jobs = jobs;

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
    // Mark all initially-loaded escalations as already seen so the modal
    // does not auto-open on first connect.
    appState.escalationDismissedAt = appState.escalationDisplayNumber;
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

function buildWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Initialize the WebSocket connection. Extracts token from URL
 * or sessionStorage.
 */
export function initConnection(): void {
  const client = getWsClient();

  const params = new URLSearchParams(window.location.search);
  let token = params.get('token');

  if (token) {
    sessionStorage.setItem('ic-auth-token', token);
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  } else {
    token = sessionStorage.getItem('ic-auth-token');
  }

  if (!token) {
    return;
  }

  appState.hasToken = true;
  client.connect(buildWsUrl(), token);
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

export function connectWithToken(token: string): void {
  sessionStorage.setItem('ic-auth-token', token);
  appState.hasToken = true;
  const client = getWsClient();
  client.connect(buildWsUrl(), token);
}
