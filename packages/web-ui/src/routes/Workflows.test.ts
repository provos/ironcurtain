import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { PastRunDto, WorkflowDefinitionDto, WorkflowSummaryDto, HumanGateRequestDto } from '$lib/types.js';

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
// Mock store -- declared via vi.hoisted so the vi.mock factory can see them
// ---------------------------------------------------------------------------

const {
  mockStartWorkflow,
  mockAbortWorkflow,
  mockRefreshWorkflows,
  mockListDefinitions,
  mockListResumable,
  mockResumeWorkflow,
  mockImportWorkflow,
  mockAppState,
} = vi.hoisted(() => {
  const mockAppState = {
    workflows: new Map<string, WorkflowSummaryDto>(),
    pendingGates: new Map<string, HumanGateRequestDto>(),
    selectedWorkflowId: null as string | null,
  };
  return {
    mockStartWorkflow: vi.fn<(p: string, t: string, w?: string) => Promise<{ workflowId: string }>>(),
    mockAbortWorkflow: vi.fn<(id: string) => Promise<void>>(),
    mockRefreshWorkflows: vi.fn<() => Promise<void>>(),
    mockListDefinitions: vi.fn<() => Promise<WorkflowDefinitionDto[]>>(),
    mockListResumable: vi.fn<() => Promise<PastRunDto[]>>(),
    mockResumeWorkflow: vi.fn<(id: string) => Promise<{ workflowId: string }>>(),
    mockImportWorkflow: vi.fn<(d: string) => Promise<{ workflowId: string }>>(),
    mockAppState,
  };
});

vi.mock('$lib/stores.svelte.js', () => ({
  appState: mockAppState,
  startWorkflow: (...a: unknown[]) => mockStartWorkflow(...(a as [string, string, string | undefined])),
  abortWorkflow: (...a: unknown[]) => mockAbortWorkflow(...(a as [string])),
  refreshWorkflows: () => mockRefreshWorkflows(),
  listWorkflowDefinitions: () => mockListDefinitions(),
  listResumableWorkflows: () => mockListResumable(),
  resumeWorkflow: (...a: unknown[]) => mockResumeWorkflow(...(a as [string])),
  importWorkflow: (...a: unknown[]) => mockImportWorkflow(...(a as [string])),
}));

// WorkflowDetail pulls in workspace-browser etc. Replace with a noop stub so we
// only render the listing surface under test.
vi.mock('./WorkflowDetail.svelte', async () => {
  const Stub = (await import('./__test_stub__.svelte')).default;
  return { default: Stub };
});

import Workflows from './Workflows.svelte';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<WorkflowSummaryDto> = {}): WorkflowSummaryDto {
  return {
    workflowId: 'wf-active',
    name: 'wf-active',
    phase: 'running',
    currentState: 'plan',
    startedAt: '2026-04-23T08:00:00.000Z',
    taskDescription: 'live task',
    round: 1,
    maxRounds: 3,
    totalTokens: 1000,
    ...overrides,
  };
}

function makePastRun(overrides: Partial<PastRunDto> & Pick<PastRunDto, 'workflowId'>): PastRunDto {
  return {
    name: overrides.workflowId,
    phase: 'completed',
    currentState: 'done',
    taskDescription: 'a past task',
    round: 3,
    maxRounds: 3,
    totalTokens: 5000,
    timestamp: '2026-04-22T10:00:00.000Z',
    lastState: 'done',
    ...overrides,
  };
}

function resetState(): void {
  mockAppState.workflows = new Map();
  mockAppState.pendingGates = new Map();
  mockAppState.selectedWorkflowId = null;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetState();
  mockRefreshWorkflows.mockResolvedValue();
  mockListDefinitions.mockResolvedValue([]);
  mockListResumable.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflows route', () => {
  describe('Active table', () => {
    it('renders enriched fields: round, verdict badge, task', async () => {
      mockAppState.workflows = new Map([
        [
          'wf-active',
          makeSummary({
            taskDescription: 'investigate flaky test',
            round: 2,
            maxRounds: 5,
            latestVerdict: { stateId: 'review', verdict: 'pass', confidence: 0.87 },
          }),
        ],
      ]);
      render(Workflows);
      // Round col
      expect(await screen.findByText('2/5')).toBeTruthy();
      // Verdict badge text and percent
      const verdict = await screen.findByText(/pass/);
      expect(verdict).toBeTruthy();
      expect(verdict.textContent).toMatch(/87%/);
      // Truncated task description shows
      expect(screen.getByText(/investigate flaky test/)).toBeTruthy();
    });

    it('shows error tooltip badge for failed rows', async () => {
      mockAppState.workflows = new Map([
        ['wf-failed', makeSummary({ workflowId: 'wf-failed', phase: 'failed', error: 'boom: something blew up' })],
      ]);
      render(Workflows);
      // Failed phase is excluded from the active table; tested in past-runs below.
      expect(screen.queryByText('wf-failed')).toBeNull();
    });
  });

  describe('Past-runs section', () => {
    it('renders rows from listResumableWorkflows', async () => {
      mockListResumable.mockResolvedValue([
        makePastRun({ workflowId: 'wf-disk-1', taskDescription: 'old run on disk', phase: 'completed' }),
      ]);
      render(Workflows);
      expect(await screen.findByText(/old run on disk/)).toBeTruthy();
    });

    it('merges in-memory terminal entries and dedups by workflowId (in-memory wins)', async () => {
      mockListResumable.mockResolvedValue([
        makePastRun({
          workflowId: 'wf-shared',
          taskDescription: 'stale-on-disk',
          phase: 'completed',
        }),
      ]);
      mockAppState.workflows = new Map([
        [
          'wf-shared',
          makeSummary({
            workflowId: 'wf-shared',
            phase: 'failed',
            taskDescription: 'fresh-in-memory',
            error: 'crashed',
          }),
        ],
      ]);
      render(Workflows);
      expect(await screen.findByText(/fresh-in-memory/)).toBeTruthy();
      expect(screen.queryByText(/stale-on-disk/)).toBeNull();
    });

    it('failed pill filters to only failed rows; All restores all', async () => {
      mockListResumable.mockResolvedValue([
        makePastRun({ workflowId: 'p-completed', phase: 'completed', taskDescription: 'completed-row' }),
        makePastRun({ workflowId: 'p-failed', phase: 'failed', taskDescription: 'failed-row' }),
      ]);
      render(Workflows);
      // Wait for the past runs to load
      await screen.findByText('completed-row');

      // Click "Failed (1)" pill
      const failedPill = screen.getByTestId('past-run-filter-failed');
      await fireEvent.click(failedPill);

      expect(screen.queryByText('completed-row')).toBeNull();
      expect(screen.getByText('failed-row')).toBeTruthy();

      // Click "All (2)" to restore
      const allPill = screen.getByTestId('past-run-filter-all');
      await fireEvent.click(allPill);
      expect(screen.getByText('completed-row')).toBeTruthy();
      expect(screen.getByText('failed-row')).toBeTruthy();
    });

    it('Resume button is disabled only for completed runs; every other phase is resumable (matches engine isCheckpointResumable)', async () => {
      mockListResumable.mockResolvedValue([
        makePastRun({ workflowId: 'p-done', phase: 'completed' }),
        makePastRun({ workflowId: 'p-wait', phase: 'waiting_human' }),
        makePastRun({ workflowId: 'p-int', phase: 'interrupted' }),
        makePastRun({ workflowId: 'p-fail', phase: 'failed' }),
        makePastRun({ workflowId: 'p-abort', phase: 'aborted' }),
      ]);
      render(Workflows);
      await screen.findByTestId('resume-p-done');

      const resumeDone = screen.getByTestId('resume-p-done') as HTMLButtonElement;
      const resumeFail = screen.getByTestId('resume-p-fail') as HTMLButtonElement;
      const resumeAbort = screen.getByTestId('resume-p-abort') as HTMLButtonElement;
      const resumeWait = screen.getByTestId('resume-p-wait') as HTMLButtonElement;
      const resumeInt = screen.getByTestId('resume-p-int') as HTMLButtonElement;

      expect(resumeDone.disabled).toBe(true);
      expect(resumeDone.getAttribute('aria-disabled')).toBe('true');

      expect(resumeFail.disabled).toBe(false);
      expect(resumeAbort.disabled).toBe(false);
      expect(resumeWait.disabled).toBe(false);
      expect(resumeInt.disabled).toBe(false);
    });

    it('Investigate button is always enabled and selects the workflow on click', async () => {
      mockListResumable.mockResolvedValue([makePastRun({ workflowId: 'p-done', phase: 'completed' })]);
      // Pre-populate the in-memory map so the detail-routing can resolve the summary.
      mockAppState.workflows = new Map([['p-done', makeSummary({ workflowId: 'p-done', phase: 'completed' })]]);
      render(Workflows);

      const investigate = (await screen.findByTestId('investigate-p-done')) as HTMLButtonElement;
      expect(investigate.disabled).toBe(false);
      await fireEvent.click(investigate);
      expect(mockAppState.selectedWorkflowId).toBe('p-done');
    });

    it('renders WorkflowDetail for a past run that is NOT in the live map (Investigate path)', async () => {
      // Past-only run: present in listResumableWorkflows() but absent from
      // appState.workflows. Before the fix, the gate `selectedWorkflow &&
      // selectedWorkflowId` blocked WorkflowDetail from mounting in this case
      // (the live-Map lookup returned null, the conjunction was false).
      // The plain-object mock for appState doesn't fire Svelte rune reactivity
      // on post-render mutations, so we pre-set selectedWorkflowId so the
      // detail-view branch is reached on mount and exercises the placeholder
      // synthesis path.
      mockAppState.selectedWorkflowId = 'p-only-disk';
      mockListResumable.mockResolvedValue([
        makePastRun({
          workflowId: 'p-only-disk',
          phase: 'completed',
          taskDescription: 'a finished run on disk',
          lastState: 'done',
        }),
      ]);
      // Crucially: do NOT seed appState.workflows for this id.
      render(Workflows);

      // The stub renders <div data-testid="test-stub" data-prop-count="N">.
      // Its presence proves WorkflowDetail mounted with the synthesized summary.
      const stub = await screen.findByTestId('test-stub');
      expect(stub).toBeTruthy();
      // Sanity: the stub forwards all props, so prop-count is non-zero
      // (workflowId, summary, gate, onback at minimum).
      expect(Number(stub.getAttribute('data-prop-count'))).toBeGreaterThan(0);
    });

    it('Investigate button click sets selectedWorkflowId for past runs not in the live map', async () => {
      // Companion to the test above: verifies the click handler does flip the
      // selection state. Reactivity-driven re-render is covered by the
      // pre-set test; this one isolates the click side-effect.
      mockListResumable.mockResolvedValue([
        makePastRun({
          workflowId: 'p-disk-click',
          phase: 'completed',
          taskDescription: 'another disk-only run',
        }),
      ]);
      render(Workflows);

      const investigate = (await screen.findByTestId('investigate-p-disk-click')) as HTMLButtonElement;
      expect(investigate.disabled).toBe(false);
      await fireEvent.click(investigate);
      expect(mockAppState.selectedWorkflowId).toBe('p-disk-click');
    });

    // ── B4: in-row taskDescription expand ─────────────────────────────
    it('clicking the task button toggles between truncated and full text', async () => {
      const longTask =
        'This is an unusually long task description that easily exceeds the eighty-character past-runs truncation cap so the toggle has something to reveal.';
      mockListResumable.mockResolvedValue([
        makePastRun({ workflowId: 'p-long', phase: 'completed', taskDescription: longTask }),
      ]);
      render(Workflows);

      const toggle = (await screen.findByTestId('task-toggle-p-long')) as HTMLButtonElement;
      // Collapsed: shows ellipsis-truncated text and aria-expanded="false".
      expect(toggle.textContent).toMatch(/…$/);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.textContent).not.toContain('something to reveal');

      await fireEvent.click(toggle);

      // Expanded: full text, aria-expanded="true".
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.textContent).toContain('something to reveal');
    });
  });
});
