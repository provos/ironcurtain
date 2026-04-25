import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type {
  WorkflowSummaryDto,
  WorkflowDetailDto,
  HumanGateRequestDto,
  TransitionRecordDto,
  MessageLogEntry,
  MessageLogResponseDto,
} from '$lib/types.js';
import { RpcError } from '$lib/ws-client.js';

// jsdom does not provide ResizeObserver -- stub it globally
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

// ---------------------------------------------------------------------------
// Mock store functions -- vi.hoisted ensures these are available in vi.mock
// ---------------------------------------------------------------------------

const {
  mockGetWorkflowDetail,
  mockResolveWorkflowGate,
  mockGetWorkflowFileTree,
  mockGetWorkflowFileContent,
  mockGetWorkflowArtifacts,
  mockGetWorkflowMessageLog,
  mockAppState,
} = vi.hoisted(() => ({
  mockGetWorkflowDetail: vi.fn<(id: string) => Promise<WorkflowDetailDto>>(),
  mockResolveWorkflowGate: vi.fn<(id: string, event: string, prompt?: string) => Promise<void>>(),
  mockGetWorkflowFileTree: vi.fn(),
  mockGetWorkflowFileContent: vi.fn(),
  mockGetWorkflowArtifacts: vi.fn(),
  mockGetWorkflowMessageLog:
    vi.fn<(id: string, opts?: { before?: string; limit?: number }) => Promise<MessageLogResponseDto>>(),
  mockAppState: {
    pendingGates: new Map<string, HumanGateRequestDto>(),
  },
}));

vi.mock('$lib/stores.svelte.js', () => ({
  appState: mockAppState,
  connectionGeneration: { value: 0 },
  getWorkflowDetail: (...args: unknown[]) => mockGetWorkflowDetail(...(args as [string])),
  resolveWorkflowGate: (...args: unknown[]) =>
    mockResolveWorkflowGate(...(args as [string, string, string | undefined])),
  getWorkflowFileTree: (...args: unknown[]) => mockGetWorkflowFileTree(...args),
  getWorkflowFileContent: (...args: unknown[]) => mockGetWorkflowFileContent(...args),
  getWorkflowArtifacts: (...args: unknown[]) => mockGetWorkflowArtifacts(...args),
  getWorkflowMessageLog: (...args: unknown[]) =>
    mockGetWorkflowMessageLog(...(args as [string, { before?: string; limit?: number } | undefined])),
}));

vi.mock('$lib/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils.js')>();
  return {
    ...actual,
    phaseBadgeVariant: (phase: string) => {
      const map: Record<string, string> = {
        running: 'default',
        waiting_human: 'warning',
        completed: 'success',
        failed: 'destructive',
      };
      return map[phase] ?? 'outline';
    },
  };
});

// Import component after mocks
import WorkflowDetail from './WorkflowDetail.svelte';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<WorkflowSummaryDto> = {}): WorkflowSummaryDto {
  return {
    workflowId: 'wf-1',
    name: 'Code Review Pipeline',
    phase: 'running',
    currentState: 'implement',
    startedAt: '2026-01-15T10:00:00Z',
    taskDescription: 'Review the codebase',
    round: 0,
    maxRounds: 5,
    totalTokens: 0,
    ...overrides,
  };
}

function makeTransition(overrides: Partial<TransitionRecordDto> = {}): TransitionRecordDto {
  return {
    from: 'plan',
    to: 'implement',
    event: 'CONTINUE',
    timestamp: '2026-01-15T10:05:00Z',
    durationMs: 30000,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<WorkflowDetailDto> = {}): WorkflowDetailDto {
  return {
    workflowId: 'wf-1',
    name: 'Code Review Pipeline',
    phase: 'running',
    currentState: 'implement',
    startedAt: '2026-01-15T10:00:00Z',
    taskDescription: 'Review the codebase',
    round: 2,
    maxRounds: 5,
    totalTokens: 15000,
    description: 'Automated code review workflow',
    stateGraph: { states: [], transitions: [] },
    transitionHistory: [],
    context: {
      taskDescription: 'Review the codebase',
      round: 2,
      maxRounds: 5,
      totalTokens: 15000,
      visitCounts: {},
    },
    workspacePath: '/tmp/wf-workspace',
    ...overrides,
  };
}

function makeGate(overrides: Partial<HumanGateRequestDto> = {}): HumanGateRequestDto {
  return {
    gateId: 'gate-1',
    workflowId: 'wf-1',
    stateName: 'review',
    acceptedEvents: ['APPROVE', 'FORCE_REVISION'],
    presentedArtifacts: [],
    summary: 'Review needed',
    ...overrides,
  };
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'wf-1',
    summary: makeSummary(),
    onback: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowDetail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // `restoreAllMocks` does not reset the call history of the hoisted
    // `vi.fn()` instances; explicitly clear so per-test assertions on
    // call counts (e.g. message-log fetch counts) start from zero.
    mockGetWorkflowDetail.mockReset();
    mockResolveWorkflowGate.mockReset();
    mockGetWorkflowFileTree.mockReset();
    mockGetWorkflowFileContent.mockReset();
    mockGetWorkflowArtifacts.mockReset();
    mockGetWorkflowMessageLog.mockReset();
    mockAppState.pendingGates = new Map();
    mockGetWorkflowDetail.mockResolvedValue(makeDetail());
    // WorkspaceBrowser's FileTree calls fetchFileTree on mount
    mockGetWorkflowFileTree.mockResolvedValue({ entries: [] });
    mockGetWorkflowFileContent.mockResolvedValue({ content: '' });
    // Default to an empty message log; tests that exercise the timeline
    // override per-call.
    mockGetWorkflowMessageLog.mockResolvedValue({ entries: [], hasMore: false });
  });

  /** Render with a gate in the waiting_human phase. */
  function renderWithGate(gateOverrides: Partial<HumanGateRequestDto> = {}) {
    const gate = makeGate(gateOverrides);
    const summary = makeSummary({ phase: 'waiting_human' });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'waiting_human', gate }));
    render(WorkflowDetail, { props: makeProps({ summary, gate }) });
  }

  // ── Header rendering ──────────────────────────────────────────────

  it('renders the workflow name and phase badge', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Code Review Pipeline')).toBeTruthy();
      expect(screen.getByText('running')).toBeTruthy();
    });
  });

  it('shows the current state in the header', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('implement')).toBeTruthy();
    });
  });

  it('calls onback when the Back button is clicked', async () => {
    const onback = vi.fn();
    render(WorkflowDetail, { props: makeProps({ onback }) });

    await vi.waitFor(() => {
      expect(screen.getByText('Code Review Pipeline')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText(/Back/));
    expect(onback).toHaveBeenCalled();
  });

  // ── Loading and error states ──────────────────────────────────────

  it('shows a spinner while loading detail', () => {
    // Don't resolve the promise yet
    mockGetWorkflowDetail.mockReturnValue(new Promise(() => {}));
    render(WorkflowDetail, { props: makeProps() });

    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  it('shows an error alert when fetching detail fails', async () => {
    mockGetWorkflowDetail.mockRejectedValue(new Error('Workflow not found'));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Workflow not found')).toBeTruthy();
    });
  });

  // ── Context metrics cards ─────────────────────────────────────────

  it('displays round, total tokens, workspace path, and description', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
      expect(screen.getByText('15,000')).toBeTruthy();
      expect(screen.getByText('/tmp/wf-workspace')).toBeTruthy();
      expect(screen.getByText('Automated code review workflow')).toBeTruthy();
    });
  });

  it('shows "--" for empty description', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ description: '' }));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('--')).toBeTruthy();
    });
  });

  // ── Workspace browser toggle ──────────────────────────────────────

  // Helper: find the workspace browser toggle button (not the context card label)
  function findWorkspaceToggle(): HTMLButtonElement {
    const allWorkspace = screen.getAllByText('Workspace');
    // The toggle button is a <button> containing the "Workspace" text
    for (const el of allWorkspace) {
      const btn = el.closest('button');
      if (btn && btn.classList.contains('flex')) return btn;
    }
    throw new Error('Workspace toggle button not found');
  }

  it('starts with workspace browser collapsed', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByText('Select a file to view its contents')).toBeNull();
  });

  it('expands workspace browser when the Workspace header is clicked', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    await fireEvent.click(findWorkspaceToggle());

    await vi.waitFor(() => {
      expect(screen.getByText('Select a file to view its contents')).toBeTruthy();
    });
  });

  it('collapses workspace browser on second click', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    const toggle = findWorkspaceToggle();

    await fireEvent.click(toggle);
    await vi.waitFor(() => {
      expect(screen.getByText('Select a file to view its contents')).toBeTruthy();
    });

    await fireEvent.click(toggle);
    await vi.waitFor(() => {
      expect(screen.queryByText('Select a file to view its contents')).toBeNull();
    });
  });

  // ── Transition history ────────────────────────────────────────────

  it('renders transition history with from/to states and duration', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [
          makeTransition({ from: 'plan', to: 'implement', durationMs: 30000 }),
          makeTransition({ from: 'implement', to: 'test', durationMs: 120000, timestamp: '2026-01-15T10:10:00Z' }),
        ],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Transition History')).toBeTruthy();
    });

    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('test')).toBeTruthy();

    expect(screen.getByText('30s')).toBeTruthy();
    expect(screen.getByText('2m 0s')).toBeTruthy();
  });

  it('shows event badges in transition history', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ event: 'APPROVE' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('APPROVE')).toBeTruthy();
    });
  });

  it('does not show transition history section when there are no transitions', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ transitionHistory: [] }));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByText('Transition History')).toBeNull();
  });

  // ── Agent message expand/collapse with markdown ───────────────────

  it('shows "show message" toggle when a transition has an agentMessage', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: 'Implementation **complete**.' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });
  });

  it('expands agent message with prose-markdown class when "show message" is clicked', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: 'Implementation **complete**.' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('show message'));

    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
    });

    // Find the message container with prose-markdown class
    const messageContainers = document.querySelectorAll('.prose-markdown');
    expect(messageContainers.length).toBeGreaterThan(0);

    // Verify markdown was rendered
    const lastContainer = messageContainers[messageContainers.length - 1];
    expect(lastContainer.querySelector('strong')?.textContent).toBe('complete');
  });

  it('collapses agent message when "hide message" is clicked', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: 'Some message' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('show message'));
    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('hide message'));
    await vi.waitFor(() => {
      expect(screen.getByText('show message')).toBeTruthy();
    });
  });

  it('does not show "show message" toggle when transition has no agentMessage', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ agentMessage: undefined })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Transition History')).toBeTruthy();
    });

    expect(screen.queryByText('show message')).toBeNull();
  });

  // ── Multiple messages expand independently ────────────────────────

  it('expands different transition messages independently', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [
          makeTransition({ from: 'plan', to: 'implement', agentMessage: 'Message one' }),
          makeTransition({
            from: 'implement',
            to: 'test',
            agentMessage: 'Message two',
            timestamp: '2026-01-15T10:10:00Z',
          }),
        ],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      const toggles = screen.getAllByText('show message');
      expect(toggles.length).toBe(2);
    });

    // Expand first message only
    const toggles = screen.getAllByText('show message');
    await fireEvent.click(toggles[0]);

    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
      // Second message should still have "show message"
      expect(screen.getAllByText('show message').length).toBe(1);
    });
  });

  // ── GateReviewPanel integration ───────────────────────────────────

  it('shows GateReviewPanel when gate is provided and phase is waiting_human', async () => {
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByText('Review Required: review')).toBeTruthy();
      expect(screen.getByText('Waiting for Review')).toBeTruthy();
    });
  });

  it('does not show GateReviewPanel when phase is not waiting_human', async () => {
    const gate = makeGate();
    render(WorkflowDetail, { props: makeProps({ gate }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByText('Review Required: review')).toBeNull();
  });

  // ── Duration formatting ───────────────────────────────────────────

  it.each([
    { durationMs: 500, expected: '500ms' },
    { durationMs: 45000, expected: '45s' },
    { durationMs: 185000, expected: '3m 5s' },
  ])('formats $durationMs ms duration as "$expected"', async ({ durationMs, expected }) => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ durationMs })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText(expected)).toBeTruthy();
    });
  });

  // ── Phase badge display ───────────────────────────────────────────

  it('displays phase with underscores replaced by spaces', async () => {
    const summary = makeSummary({ phase: 'waiting_human' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('waiting human')).toBeTruthy();
    });
  });

  // ── Resolve error display ────────────────────────────────────────

  it('shows resolve error alert when gate resolution fails', async () => {
    mockResolveWorkflowGate.mockRejectedValue(new Error('Gate expired'));
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Approve'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to resolve gate.*Gate expired/)).toBeTruthy();
    });
  });

  it('dismisses resolve error when dismiss is clicked', async () => {
    mockResolveWorkflowGate.mockRejectedValue(new Error('Gate expired'));
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Approve'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to resolve gate/)).toBeTruthy();
    });

    // Click dismiss
    await fireEvent.click(screen.getByText('Dismiss'));

    await vi.waitFor(() => {
      expect(screen.queryByText(/Failed to resolve gate/)).toBeNull();
    });
  });

  // ── Context: missing context ───────────────────────────────────

  it('does not render metrics cards when context is null', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({ context: undefined as unknown as WorkflowDetailDto['context'] }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('State Machine')).toBeTruthy();
    });

    expect(screen.queryByText('Round')).toBeNull();
    expect(screen.queryByText('Total Tokens')).toBeNull();
  });

  // ── Gate seeding into pendingGates ──────────────────────────────

  it('seeds gate into appState.pendingGates when detail has a gate', async () => {
    const gate = makeGate({ gateId: 'gate-seed-1', stateName: 'review' });
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ gate }));

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      // After detail is loaded, the gate should be in appState.pendingGates
      expect(mockAppState.pendingGates.has('gate-seed-1')).toBe(true);
    });

    expect(mockAppState.pendingGates.get('gate-seed-1')?.stateName).toBe('review');
  });

  // ── Multiple transition messages: one expanded, one collapsed ──

  it('keeps unrelated messages collapsed when one is toggled', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [
          makeTransition({ from: 'a', to: 'b', agentMessage: 'First msg' }),
          makeTransition({
            from: 'b',
            to: 'c',
            agentMessage: 'Second msg',
            timestamp: '2026-01-15T10:10:00Z',
          }),
          makeTransition({
            from: 'c',
            to: 'd',
            agentMessage: 'Third msg',
            timestamp: '2026-01-15T10:15:00Z',
          }),
        ],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getAllByText('show message').length).toBe(3);
    });

    // Expand only the second message
    const toggles = screen.getAllByText('show message');
    await fireEvent.click(toggles[1]);

    await vi.waitFor(() => {
      expect(screen.getByText('hide message')).toBeTruthy();
      // The other two should still be collapsed
      expect(screen.getAllByText('show message').length).toBe(2);
    });
  });

  // ── Summary phase badge variants ──────────────────────────────

  it.each(['failed', 'completed'] as const)('renders %s phase with correct display text', async (phase) => {
    const summary = makeSummary({ phase });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText(phase)).toBeTruthy();
    });
  });

  // ── Transition history event badge: no event ───────────────────

  it('does not show event badge when transition has no event', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        transitionHistory: [makeTransition({ event: '' })],
      }),
    );

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Transition History')).toBeTruthy();
    });

    // The "CONTINUE" event from the default factory is overridden with empty string
    // An empty string event still renders the badge element, but the content is empty
    // Check that the default "CONTINUE" is NOT present
    expect(screen.queryByText('CONTINUE')).toBeNull();
  });

  // ── Fetches detail using the workflowId prop ───────────────────

  it('fetches workflow detail using the workflowId prop', async () => {
    render(WorkflowDetail, {
      props: makeProps({ workflowId: 'custom-wf-99' }),
    });

    await vi.waitFor(() => {
      expect(mockGetWorkflowDetail).toHaveBeenCalledWith('custom-wf-99');
    });
  });

  // ── No resolve error on successful resolution ─────────────────

  it('does not show resolve error when gate resolution succeeds', async () => {
    mockResolveWorkflowGate.mockResolvedValue(undefined);
    renderWithGate();

    await vi.waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Approve'));

    await vi.waitFor(() => {
      expect(mockResolveWorkflowGate).toHaveBeenCalledWith('wf-1', 'APPROVE', undefined);
    });

    expect(screen.queryByText(/Failed to resolve gate/)).toBeNull();
  });

  // ── Error callout (failed / interrupted with error) ───────────────

  it('shows error callout when phase is failed and error is set', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'failed', error: 'Agent step crashed unexpectedly' }));
    const summary = makeSummary({ phase: 'failed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByTestId('workflow-error-callout')).toBeTruthy();
    });
    expect(screen.getByText('Workflow failed')).toBeTruthy();
    expect(screen.getByTestId('workflow-error-text').textContent).toBe('Agent step crashed unexpectedly');
  });

  it('shows error callout when phase is interrupted and error is set', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'interrupted', error: 'Daemon restarted mid-run' }));
    const summary = makeSummary({ phase: 'failed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByTestId('workflow-error-callout')).toBeTruthy();
    });
    expect(screen.getByText('Workflow interrupted')).toBeTruthy();
    expect(screen.getByTestId('workflow-error-text').textContent).toBe('Daemon restarted mid-run');
  });

  it('does not show error callout for completed workflows', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'completed' }));
    const summary = makeSummary({ phase: 'completed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByTestId('workflow-error-callout')).toBeNull();
  });

  it('does not show error callout for aborted workflows without error text', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'aborted' }));
    const summary = makeSummary({ phase: 'aborted' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByTestId('workflow-error-callout')).toBeNull();
  });

  it('does not show error callout for interrupted workflows without error text', async () => {
    mockGetWorkflowDetail.mockResolvedValue(makeDetail({ phase: 'interrupted' }));
    const summary = makeSummary({ phase: 'failed' });
    render(WorkflowDetail, { props: makeProps({ summary }) });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });

    expect(screen.queryByTestId('workflow-error-callout')).toBeNull();
  });

  // ── Latest verdict row ────────────────────────────────────────────

  it('shows latest verdict card when latestVerdict is set', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        latestVerdict: { stateId: 'review', verdict: 'APPROVE', confidence: 0.92 },
      }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('latest-verdict-card')).toBeTruthy();
    });

    expect(screen.getByTestId('latest-verdict-value').textContent).toBe('APPROVE');
    expect(screen.getByTestId('latest-verdict-confidence').textContent?.trim()).toBe('— 92%');
    expect(screen.getByTestId('latest-verdict-state').textContent?.trim()).toBe('review');
  });

  it('shows latest verdict card without confidence when confidence is omitted', async () => {
    mockGetWorkflowDetail.mockResolvedValue(
      makeDetail({
        latestVerdict: { stateId: 'plan', verdict: 'CONTINUE' },
      }),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('latest-verdict-value').textContent).toBe('CONTINUE');
    });
    expect(screen.queryByTestId('latest-verdict-confidence')).toBeNull();
  });

  it('does not show latest verdict card when latestVerdict is unset', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('2/5')).toBeTruthy();
    });
    expect(screen.queryByTestId('latest-verdict-card')).toBeNull();
  });

  // ── Message log section ───────────────────────────────────────────

  function makeMessageEntry(overrides: Partial<MessageLogEntry> = {}): MessageLogEntry {
    return {
      type: 'agent_sent',
      ts: '2026-01-15T10:05:00Z',
      workflowId: 'wf-1',
      state: 'plan',
      role: 'planner',
      message: 'Plan the work',
      ...overrides,
    } as MessageLogEntry;
  }

  it('starts with the message log section collapsed and does not fetch on mount', async () => {
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Message log')).toBeTruthy();
    });

    // Toggle is collapsed: aria-expanded=false
    const toggle = screen.getByTestId('message-log-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(mockGetWorkflowMessageLog).not.toHaveBeenCalled();
    expect(screen.queryByTestId('message-log-timeline')).toBeNull();
  });

  it('fetches and renders the message log when the section is expanded', async () => {
    mockGetWorkflowMessageLog.mockResolvedValue({
      entries: [makeMessageEntry({ ts: '2026-01-15T11:00:00Z' })],
      hasMore: false,
    });
    render(WorkflowDetail, { props: makeProps({ workflowId: 'wf-42' }) });

    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-toggle')).toBeTruthy();
    });

    await fireEvent.click(screen.getByTestId('message-log-toggle'));

    await vi.waitFor(() => {
      expect(mockGetWorkflowMessageLog).toHaveBeenCalledWith('wf-42', { limit: 200 });
      expect(screen.getByTestId('message-log-timeline')).toBeTruthy();
    });
  });

  it('appends older entries when "Load older" is clicked', async () => {
    const newest = makeMessageEntry({ ts: '2026-01-15T12:00:00Z', message: 'Newest' });
    const middle = makeMessageEntry({ ts: '2026-01-15T11:00:00Z', message: 'Middle' });
    const older = makeMessageEntry({ ts: '2026-01-15T09:00:00Z', message: 'Older' });

    mockGetWorkflowMessageLog
      .mockResolvedValueOnce({ entries: [newest, middle], hasMore: true })
      .mockResolvedValueOnce({ entries: [older], hasMore: false });

    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-toggle')).toBeTruthy();
    });

    await fireEvent.click(screen.getByTestId('message-log-toggle'));

    await vi.waitFor(() => {
      expect(screen.getAllByTestId('message-log-entry').length).toBe(2);
      expect(screen.getByTestId('message-log-load-older')).toBeTruthy();
    });

    await fireEvent.click(screen.getByTestId('message-log-load-older'));

    await vi.waitFor(() => {
      // Expect the second call to use the oldest entry's ts as the cursor.
      expect(mockGetWorkflowMessageLog).toHaveBeenNthCalledWith(2, 'wf-1', {
        limit: 200,
        before: '2026-01-15T11:00:00Z',
      });
      // Three entries now, in newest-first order.
      expect(screen.getAllByTestId('message-log-entry').length).toBe(3);
    });
  });

  it('does not refetch when the section is collapsed and re-expanded', async () => {
    mockGetWorkflowMessageLog.mockResolvedValue({
      entries: [makeMessageEntry()],
      hasMore: false,
    });
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-toggle')).toBeTruthy();
    });

    const toggle = screen.getByTestId('message-log-toggle');
    await fireEvent.click(toggle);
    await vi.waitFor(() => {
      expect(screen.getByTestId('message-log-timeline')).toBeTruthy();
    });

    await fireEvent.click(toggle);
    await fireEvent.click(toggle);

    // Still exactly one fetch — the second expand is a no-op since the
    // log was already fetched.
    expect(mockGetWorkflowMessageLog).toHaveBeenCalledTimes(1);
  });

  // ── WORKFLOW_CORRUPTED handling ──────────────────────────────────

  it('shows the dedicated corruption panel when WORKFLOW_CORRUPTED is returned', async () => {
    mockGetWorkflowDetail.mockRejectedValue(
      new RpcError('WORKFLOW_CORRUPTED', 'Failed to parse checkpoint.json: unexpected token at line 12'),
    );
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Workflow checkpoint is corrupted')).toBeTruthy();
    });
    expect(screen.getByTestId('corruption-message').textContent).toBe(
      'Failed to parse checkpoint.json: unexpected token at line 12',
    );
    // The generic destructive banner must NOT also appear.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falls back to the generic error banner for non-corruption RPC errors', async () => {
    mockGetWorkflowDetail.mockRejectedValue(new RpcError('WORKFLOW_NOT_FOUND', 'Workflow wf-x not found'));
    render(WorkflowDetail, { props: makeProps() });

    await vi.waitFor(() => {
      expect(screen.getByText('Workflow wf-x not found')).toBeTruthy();
    });
    // No corruption-specific panel
    expect(screen.queryByText('Workflow checkpoint is corrupted')).toBeNull();
  });
});
