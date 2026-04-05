/**
 * Application state management using Svelte 5 runes.
 *
 * The store holds all reactive state and exposes methods to mutate it.
 * The WebSocket client feeds events into the store via handleEvent().
 */

import type { SessionDto, EscalationDto, DaemonStatusDto, JobListDto, OutputLine, BudgetSummaryDto } from './types.js';
import { createWsClient, type WsClient } from './ws-client.js';

export type ViewId = 'dashboard' | 'sessions' | 'escalations' | 'jobs';

const MAX_OUTPUT_LINES = 2000;

class AppState {
  connected: boolean = $state(false);
  hasToken: boolean = $state(false);
  daemonStatus: DaemonStatusDto | null = $state(null);
  sessions: Map<number, SessionDto> = $state(new Map());
  selectedSessionLabel: number | null = $state(null);
  pendingEscalations: Map<string, EscalationDto> = $state(new Map());
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
    const existing = this.sessionOutputs.get(label) ?? [];
    existing.push(line);
    // Cap output to prevent unbounded memory growth
    if (existing.length > MAX_OUTPUT_LINES) {
      existing.splice(0, existing.length - MAX_OUTPUT_LINES);
    }
    this.sessionOutputs.set(label, existing);
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
    handleEvent(event, payload);
  });
}

function handleEvent(event: string, payload: unknown): void {
  const data = payload as Record<string, unknown>;

  switch (event) {
    case 'daemon.status':
      appState.daemonStatus = data as unknown as DaemonStatusDto;
      break;

    case 'session.created': {
      const session = data as unknown as SessionDto;
      appState.sessions.set(session.label, session);
      break;
    }

    case 'session.ended': {
      const label = data.label as number;
      appState.sessions.delete(label);
      appState.sessionOutputs.delete(label);
      if (appState.selectedSessionLabel === label) {
        appState.selectedSessionLabel = null;
      }
      break;
    }

    case 'session.thinking': {
      const label = data.label as number;
      appState.addOutput(label, {
        kind: 'thinking',
        text: 'Thinking...',
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'session.tool_call': {
      const label = data.label as number;
      const toolName = data.toolName as string;
      const preview = data.preview as string;
      appState.addOutput(label, {
        kind: 'tool_call',
        text: `${toolName}: ${preview}`,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'session.output': {
      const label = data.label as number;
      const text = data.text as string;
      appState.addOutput(label, {
        kind: 'assistant',
        text,
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case 'session.budget_update': {
      const label = data.label as number;
      const budget = data.budget as BudgetSummaryDto;
      const existing = appState.sessions.get(label);
      if (existing) {
        appState.sessions.set(label, { ...existing, budget });
      }
      break;
    }

    case 'escalation.created': {
      const esc = data as unknown as EscalationDto;
      appState.pendingEscalations.set(esc.escalationId, esc);
      break;
    }

    case 'escalation.resolved': {
      const id = data.escalationId as string;
      appState.pendingEscalations.delete(id);
      break;
    }

    case 'escalation.expired': {
      const id = data.escalationId as string;
      appState.pendingEscalations.delete(id);
      break;
    }

    case 'job.list_changed':
    case 'job.completed':
    case 'job.failed':
    case 'job.started':
      refreshJobs(getWsClient());
      break;
  }
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

    appState.sessions.clear();
    for (const session of sessions) {
      appState.sessions.set(session.label, session);
    }

    appState.jobs = jobs;

    appState.pendingEscalations.clear();
    for (const esc of escalations) {
      appState.pendingEscalations.set(esc.escalationId, esc);
    }
  } catch (err) {
    console.error('Failed to refresh state:', err);
  }
}

let refreshJobsTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshJobs(client: WsClient): Promise<void> {
  // Debounce rapid job events
  if (refreshJobsTimer) return;
  refreshJobsTimer = setTimeout(() => {
    refreshJobsTimer = null;
  }, 500);
  try {
    appState.jobs = await client.request<JobListDto[]>('jobs.list');
  } catch {
    // Best-effort
  }
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

export function connectWithToken(token: string): void {
  sessionStorage.setItem('ic-auth-token', token);
  appState.hasToken = true;
  const client = getWsClient();
  client.connect(buildWsUrl(), token);
}
