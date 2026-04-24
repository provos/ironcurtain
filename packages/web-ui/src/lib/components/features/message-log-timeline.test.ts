import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import MessageLogTimeline from './message-log-timeline.svelte';
import type {
  MessageLogEntry,
  AgentSentEntry,
  AgentReceivedEntry,
  AgentRetryEntry,
  GateRaisedEntry,
  GateResolvedEntry,
  ErrorEntry,
  StateTransitionEntry,
  QuotaExhaustedEntry,
} from '$lib/types.js';

// ---------------------------------------------------------------------------
// Factories — one per variant so tests stay readable.
// ---------------------------------------------------------------------------

const TS = '2026-04-23T12:00:00.000Z';

function agentSent(overrides: Partial<AgentSentEntry> = {}): AgentSentEntry {
  return {
    type: 'agent_sent',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    message: 'Hello there.',
    ...overrides,
  };
}

function agentReceived(overrides: Partial<AgentReceivedEntry> = {}): AgentReceivedEntry {
  return {
    type: 'agent_received',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    message: 'Done with **task**.',
    verdict: 'pass',
    confidence: 'high',
    ...overrides,
  };
}

function stateTransition(overrides: Partial<StateTransitionEntry> = {}): StateTransitionEntry {
  return {
    type: 'state_transition',
    ts: TS,
    workflowId: 'wf-1',
    state: 'reviewer',
    from: 'planner',
    event: 'PASS',
    ...overrides,
  };
}

function gateRaised(overrides: Partial<GateRaisedEntry> = {}): GateRaisedEntry {
  return {
    type: 'gate_raised',
    ts: TS,
    workflowId: 'wf-1',
    state: 'plan_review',
    acceptedEvents: ['APPROVE', 'ABORT'],
    ...overrides,
  };
}

function gateResolved(overrides: Partial<GateResolvedEntry> = {}): GateResolvedEntry {
  return {
    type: 'gate_resolved',
    ts: TS,
    workflowId: 'wf-1',
    state: 'plan_review',
    event: 'APPROVE',
    prompt: null,
    ...overrides,
  };
}

function errorEntry(overrides: Partial<ErrorEntry> = {}): ErrorEntry {
  return {
    type: 'error',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    error: 'Something blew up.',
    ...overrides,
  };
}

function quotaExhausted(overrides: Partial<QuotaExhaustedEntry> = {}): QuotaExhaustedEntry {
  return {
    type: 'quota_exhausted',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    rawMessage: 'Rate limit hit.',
    ...overrides,
  };
}

function agentRetry(overrides: Partial<AgentRetryEntry> = {}): AgentRetryEntry {
  return {
    type: 'agent_retry',
    ts: TS,
    workflowId: 'wf-1',
    state: 'planner',
    role: 'planner',
    reason: 'missing_status_block',
    details: 'Status block was absent.',
    retryMessage: 'Please include the status block.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageLogTimeline', () => {
  // ── Per-variant rendering ───────────────────────────────────────────

  it('renders agent_sent with its variant marker and preview', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent({ message: 'A short note.' })], hasMore: false },
    });

    const entries = screen.getAllByTestId('message-log-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].getAttribute('data-entry-type')).toBe('agent_sent');
    expect(screen.getByText('Agent sent')).toBeTruthy();
    expect(screen.getByTestId('agent-preview').textContent).toContain('A short note.');
  });

  it('renders agent_received with verdict line and success badge', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentReceived({ verdict: 'pass', confidence: 'high' })], hasMore: false },
    });

    expect(screen.getByText('Agent received')).toBeTruthy();
    expect(screen.getByText('pass')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
  });

  it('renders state_transition with from → to / event', () => {
    render(MessageLogTimeline, {
      props: {
        entries: [stateTransition({ from: 'planner', state: 'reviewer', event: 'PASS' })],
        hasMore: false,
      },
    });

    const entry = screen.getByTestId('message-log-entry');
    expect(entry.getAttribute('data-entry-type')).toBe('state_transition');
    expect(entry.textContent).toContain('planner');
    expect(entry.textContent).toContain('reviewer');
    expect(entry.textContent).toContain('PASS');
    // The "State" label badge is shown.
    expect(screen.getByText('State')).toBeTruthy();
  });

  it('renders gate_raised with muted variant and accepted events', () => {
    render(MessageLogTimeline, {
      props: { entries: [gateRaised({ acceptedEvents: ['APPROVE', 'REPLAN'] })], hasMore: false },
    });

    expect(screen.getByText('Gate raised')).toBeTruthy();
    expect(screen.getByText('APPROVE, REPLAN')).toBeTruthy();
  });

  it('renders gate_resolved with the resolving event', () => {
    render(MessageLogTimeline, {
      props: { entries: [gateResolved({ event: 'APPROVE' })], hasMore: false },
    });

    expect(screen.getByText('Gate resolved')).toBeTruthy();
    expect(screen.getByText('APPROVE')).toBeTruthy();
  });

  it('renders error with destructive marker and full text', () => {
    render(MessageLogTimeline, {
      props: { entries: [errorEntry({ error: 'Boom.' })], hasMore: false },
    });

    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText('Boom.')).toBeTruthy();
  });

  it('renders quota_exhausted with destructive marker and raw message', () => {
    render(MessageLogTimeline, {
      props: {
        entries: [quotaExhausted({ rawMessage: 'You hit your limit.' })],
        hasMore: false,
      },
    });

    expect(screen.getByText('Quota exhausted')).toBeTruthy();
    expect(screen.getByText('You hit your limit.')).toBeTruthy();
  });

  it('renders agent_retry with warning marker and reason', () => {
    render(MessageLogTimeline, {
      props: {
        entries: [agentRetry({ reason: 'invalid_verdict', details: 'Verdict was off.' })],
        hasMore: false,
      },
    });

    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('invalid_verdict')).toBeTruthy();
    expect(screen.getByText('Verdict was off.')).toBeTruthy();
  });

  it('renders all eight variants together without errors', () => {
    const entries: MessageLogEntry[] = [
      agentSent({ ts: '2026-04-23T12:00:00.000Z' }),
      agentReceived({ ts: '2026-04-23T12:00:01.000Z' }),
      stateTransition({ ts: '2026-04-23T12:00:02.000Z' }),
      gateRaised({ ts: '2026-04-23T12:00:03.000Z' }),
      gateResolved({ ts: '2026-04-23T12:00:04.000Z' }),
      errorEntry({ ts: '2026-04-23T12:00:05.000Z' }),
      stateTransition({ ts: '2026-04-23T12:00:06.000Z', state: 'errored' }),
      quotaExhausted({ ts: '2026-04-23T12:00:07.000Z' }),
      agentRetry({ ts: '2026-04-23T12:00:08.000Z' }),
    ];

    render(MessageLogTimeline, { props: { entries, hasMore: false } });

    const items = screen.getAllByTestId('message-log-entry');
    expect(items).toHaveLength(entries.length);
    const types = items.map((el) => el.getAttribute('data-entry-type'));
    expect(new Set(types)).toEqual(
      new Set([
        'agent_sent',
        'agent_received',
        'state_transition',
        'gate_raised',
        'gate_resolved',
        'error',
        'quota_exhausted',
        'agent_retry',
      ]),
    );
  });

  // ── Load-older button ────────────────────────────────────────────────

  it('shows the "Load older" button when hasMore is true', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: true, onLoadOlder: vi.fn() },
    });

    expect(screen.getByTestId('message-log-load-older')).toBeTruthy();
  });

  it('hides the "Load older" button when hasMore is false', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: false, onLoadOlder: vi.fn() },
    });

    expect(screen.queryByTestId('message-log-load-older')).toBeNull();
  });

  it('calls onLoadOlder when "Load older" is clicked', async () => {
    const onLoadOlder = vi.fn();
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: true, onLoadOlder },
    });

    await fireEvent.click(screen.getByTestId('message-log-load-older'));

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  // ── Loading indicator ────────────────────────────────────────────────

  it('shows the loading indicator when loading is true', () => {
    render(MessageLogTimeline, {
      props: { entries: [agentSent()], hasMore: true, loading: true },
    });

    expect(screen.getByTestId('message-log-loading')).toBeTruthy();
    // While loading, the load-older button is hidden to prevent double-click.
    expect(screen.queryByTestId('message-log-load-older')).toBeNull();
  });

  // ── Empty state ──────────────────────────────────────────────────────

  it('renders an empty-state placeholder when entries is empty', () => {
    render(MessageLogTimeline, { props: { entries: [], hasMore: false } });

    expect(screen.getByTestId('message-log-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('message-log-entry')).toHaveLength(0);
  });

  it('does not render the empty-state placeholder while loading the first page', () => {
    render(MessageLogTimeline, { props: { entries: [], hasMore: false, loading: true } });

    expect(screen.queryByTestId('message-log-empty')).toBeNull();
    expect(screen.getByTestId('message-log-loading')).toBeTruthy();
  });

  // ── Click-to-expand on agent messages ───────────────────────────────

  it('expands an agent_sent entry to full markdown on click', async () => {
    const longMessage = 'Line one\n\n## Heading\n\nMore **markdown** content.';
    render(MessageLogTimeline, {
      props: { entries: [agentSent({ message: longMessage })], hasMore: false },
    });

    // Initially collapsed: preview is shown, full content is not.
    expect(screen.getByTestId('agent-preview')).toBeTruthy();
    expect(screen.queryByTestId('agent-full')).toBeNull();

    await fireEvent.click(screen.getByTestId('agent-toggle'));

    // After click: full markdown rendered, preview gone.
    const full = screen.getByTestId('agent-full');
    expect(full).toBeTruthy();
    expect(full.querySelector('h2')?.textContent).toBe('Heading');
    expect(full.querySelector('strong')?.textContent).toBe('markdown');
    expect(screen.queryByTestId('agent-preview')).toBeNull();
  });

  it('collapses an expanded agent message back to a preview on a second click', async () => {
    render(MessageLogTimeline, {
      props: { entries: [agentReceived({ message: 'Some **markdown** result.' })], hasMore: false },
    });

    const toggle = screen.getByTestId('agent-toggle');
    await fireEvent.click(toggle);
    expect(screen.getByTestId('agent-full')).toBeTruthy();

    await fireEvent.click(toggle);
    expect(screen.queryByTestId('agent-full')).toBeNull();
    expect(screen.getByTestId('agent-preview')).toBeTruthy();
  });
});
