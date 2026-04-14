import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import GateReviewPanel from './gate-review-panel.svelte';
import type { HumanGateRequestDto, ArtifactContentDto } from '$lib/types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeGate(overrides: Partial<HumanGateRequestDto> = {}): HumanGateRequestDto {
  return {
    gateId: 'gate-1',
    workflowId: 'wf-1',
    stateName: 'plan_review',
    acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'],
    presentedArtifacts: [],
    summary: 'Please review the implementation plan.',
    ...overrides,
  };
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    gate: makeGate(),
    workflowName: 'My Workflow',
    workflowId: 'wf-1',
    onResolve: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GateReviewPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** Switch to the Artifacts tab, disambiguating from the summary heading. */
  async function switchToArtifactsTab() {
    const buttons = screen.getAllByText(/Artifacts/);
    const tabButton = buttons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    expect(tabButton, 'Artifacts tab button should exist').toBeTruthy();
    await fireEvent.click(tabButton!);
  }

  // ── Header rendering ──────────────────────────────────────────────

  it('renders the gate state name and workflow name in the header', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.getByText('Review Required: plan_review')).toBeTruthy();
    expect(screen.getByText('My Workflow')).toBeTruthy();
    expect(screen.getByText('Waiting for Review')).toBeTruthy();
  });

  // ── Summary tab ───────────────────────────────────────────────────

  it('shows the gate summary text on the summary tab', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.getByText('Please review the implementation plan.')).toBeTruthy();
  });

  it('shows artifact badges on the summary tab when presentedArtifacts exist', () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests'] });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('tests')).toBeTruthy();
    expect(screen.getByText('Artifacts')).toBeTruthy();
  });

  // ── Action buttons (all events) ──────────────────────────────────

  it('renders all four action buttons when all events are accepted', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Request Revision')).toBeTruthy();
    expect(screen.getByText('Replan')).toBeTruthy();
    expect(screen.getByText('Abort Workflow')).toBeTruthy();
  });

  it('hides action buttons for events not in acceptedEvents', () => {
    const gate = makeGate({ acceptedEvents: ['APPROVE'] });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.queryByText('Request Revision')).toBeNull();
    expect(screen.queryByText('Replan')).toBeNull();
    expect(screen.queryByText('Abort Workflow')).toBeNull();
  });

  // ── Approve flow ──────────────────────────────────────────────────

  it('calls onResolve with APPROVE when Approve is clicked', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Approve'));

    expect(onResolve).toHaveBeenCalledWith('APPROVE');
  });

  // ── Replan flow ───────────────────────────────────────────────────

  it('calls onResolve with REPLAN when Replan is clicked', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Replan'));

    expect(onResolve).toHaveBeenCalledWith('REPLAN');
  });

  // ── Force Revision flow ───────────────────────────────────────────

  it('shows feedback form on first click of Request Revision, does not call onResolve yet', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    expect(screen.getByLabelText('Revision feedback')).toBeTruthy();
    expect(screen.getByPlaceholderText('Describe what should be changed...')).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('submits feedback when Submit Revision is clicked with text', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const textarea = screen.getByPlaceholderText('Describe what should be changed...');
    await fireEvent.input(textarea, { target: { value: 'Add more tests' } });

    await fireEvent.click(screen.getByText('Submit Revision'));

    expect(onResolve).toHaveBeenCalledWith('FORCE_REVISION', 'Add more tests');
  });

  it('does not submit when feedback textarea is empty', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const submitBtn = screen.getByText('Submit Revision');
    expect(submitBtn.closest('button')?.disabled).toBe(true);
  });

  it('cancels the feedback form when Cancel is clicked', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Request Revision'));
    expect(screen.getByLabelText('Revision feedback')).toBeTruthy();

    await fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByLabelText('Revision feedback')).toBeNull();
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  // ── Abort flow ────────────────────────────────────────────────────

  it('shows confirmation dialog on first click of Abort Workflow', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Abort Workflow'));

    expect(
      screen.getByText('Are you sure you want to abort this workflow? This action cannot be undone.'),
    ).toBeTruthy();
    expect(screen.getByText('Confirm Abort')).toBeTruthy();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('calls onResolve with ABORT on Confirm Abort click', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Abort Workflow'));
    await fireEvent.click(screen.getByText('Confirm Abort'));

    expect(onResolve).toHaveBeenCalledWith('ABORT');
  });

  it('cancels the abort confirmation when Cancel is clicked', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Abort Workflow'));
    expect(screen.getByText('Confirm Abort')).toBeTruthy();

    // There are two Cancel buttons potentially -- pick the one in the abort confirmation
    const cancelButtons = screen.getAllByText('Cancel');
    await fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    expect(screen.queryByText('Confirm Abort')).toBeNull();
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  // ── Tab navigation ────────────────────────────────────────────────

  it('shows Summary tab by default', () => {
    render(GateReviewPanel, { props: makeProps() });

    const summaryTab = screen.getByText('Summary');
    expect(summaryTab).toBeTruthy();
  });

  it('does not show Artifacts tab when no artifacts or fetchArtifacts', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.queryByText('Artifacts', { selector: 'button' })).toBeNull();
  });

  it('shows Artifacts tab when presentedArtifacts exist and fetchArtifacts is provided', () => {
    const gate = makeGate({ presentedArtifacts: ['plan'] });
    const fetchArtifacts = vi.fn();
    render(GateReviewPanel, { props: makeProps({ gate, fetchArtifacts }) });

    // The Artifacts tab button should exist (not the "Artifacts" heading in summary)
    const buttons = screen.getAllByText(/Artifacts/);
    const tabButton = buttons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    expect(tabButton).toBeTruthy();
  });

  it('shows Files tab when fetchFileTree and fetchFileContent are provided', () => {
    const fetchFileTree = vi.fn();
    const fetchFileContent = vi.fn();
    render(GateReviewPanel, { props: makeProps({ fetchFileTree, fetchFileContent }) });

    expect(screen.getByText('Files')).toBeTruthy();
  });

  it('does not show Files tab when fetchFileTree is not provided', () => {
    render(GateReviewPanel, { props: makeProps() });

    expect(screen.queryByText('Files')).toBeNull();
  });

  // ── Artifacts tab: loading and rendering ──────────────────────────

  it('loads and displays artifact content with markdown rendering using prose-markdown class', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan'] });
    const artifactContent: ArtifactContentDto = {
      files: [{ path: 'plan.md', content: '# My Plan\n\nThis is the **plan**.' }],
    };
    const fetchArtifacts = vi.fn().mockResolvedValue(artifactContent);

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    const markdownContainer = screen.getByText('plan.md').closest('.border')?.querySelector('.prose-markdown');
    expect(markdownContainer).toBeTruthy();
    expect(markdownContainer?.querySelector('h1')?.textContent).toBe('My Plan');
    expect(markdownContainer?.querySelector('strong')?.textContent).toBe('plan');
  });

  it('renders non-markdown artifact files as code blocks without prose-markdown', async () => {
    const gate = makeGate({ presentedArtifacts: ['code'] });
    const artifactContent: ArtifactContentDto = {
      files: [{ path: 'main.ts', content: 'const x = 1;' }],
    };
    const fetchArtifacts = vi.fn().mockResolvedValue(artifactContent);

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('main.ts')).toBeTruthy();
    });

    expect(screen.getByText('const x = 1;').closest('code')).toBeTruthy();

    const fileContainer = screen.getByText('main.ts').closest('.border');
    expect(fileContainer?.querySelector('.prose-markdown')).toBeNull();
  });

  it('shows error when artifact loading fails', async () => {
    const gate = makeGate({ presentedArtifacts: ['broken'] });
    const fetchArtifacts = vi.fn().mockRejectedValue(new Error('Network error'));

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('Failed to load artifact.')).toBeTruthy();
    });
  });

  // ── Multiple artifacts selection ──────────────────────────────────

  it('allows switching between multiple artifacts', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests'] });
    const fetchArtifacts = vi.fn().mockImplementation((_wfId: string, name: string) => {
      if (name === 'plan') {
        return Promise.resolve({ files: [{ path: 'plan.md', content: '# Plan' }] });
      }
      return Promise.resolve({ files: [{ path: 'test.ts', content: 'test code' }] });
    });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    // Click the second artifact selector
    const selectorButtons = screen.getAllByText('tests');
    const testsSelector = selectorButtons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    await fireEvent.click(testsSelector!);

    await vi.waitFor(() => {
      expect(screen.getByText('test.ts')).toBeTruthy();
    });

    expect(fetchArtifacts).toHaveBeenCalledWith('wf-1', 'plan');
    expect(fetchArtifacts).toHaveBeenCalledWith('wf-1', 'tests');
  });

  // ── Artifact empty state ────────────────────────────────────────

  it('shows "No files in this artifact." when artifact has zero files', async () => {
    const gate = makeGate({ presentedArtifacts: ['empty-artifact'] });
    const fetchArtifacts = vi.fn().mockResolvedValue({ files: [] });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('No files in this artifact.')).toBeTruthy();
    });
  });

  // ── Action buttons hidden during feedback/abort ─────────────────

  it('hides action buttons when the feedback form is open', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Request Revision'));

    // The main action buttons should be hidden
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Replan')).toBeNull();
    expect(screen.queryByText('Abort Workflow')).toBeNull();

    // The feedback controls should be visible
    expect(screen.getByText('Submit Revision')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('hides action buttons when the abort confirmation is open', async () => {
    render(GateReviewPanel, { props: makeProps() });

    await fireEvent.click(screen.getByText('Abort Workflow'));

    // The main action buttons should be hidden
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Request Revision')).toBeNull();
    expect(screen.queryByText('Replan')).toBeNull();

    // The confirmation controls should be visible
    expect(screen.getByText('Confirm Abort')).toBeTruthy();
  });

  // ── Feedback text trimming ──────────────────────────────────────

  it('trims whitespace-only feedback and keeps submit disabled', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const textarea = screen.getByPlaceholderText('Describe what should be changed...');
    await fireEvent.input(textarea, { target: { value: '   ' } });

    const submitBtn = screen.getByText('Submit Revision');
    expect(submitBtn.closest('button')?.disabled).toBe(true);
  });

  it('trims feedback text before sending to onResolve', async () => {
    const onResolve = vi.fn();
    render(GateReviewPanel, { props: makeProps({ onResolve }) });

    await fireEvent.click(screen.getByText('Request Revision'));

    const textarea = screen.getByPlaceholderText('Describe what should be changed...');
    await fireEvent.input(textarea, { target: { value: '  Fix the bug  ' } });

    await fireEvent.click(screen.getByText('Submit Revision'));

    expect(onResolve).toHaveBeenCalledWith('FORCE_REVISION', 'Fix the bug');
  });

  // ── Artifact tab count display ──────────────────────────────────

  it('shows artifact count next to the Artifacts tab label', () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests', 'docs'] });
    const fetchArtifacts = vi.fn();
    render(GateReviewPanel, { props: makeProps({ gate, fetchArtifacts }) });

    expect(screen.getByText('(3)')).toBeTruthy();
  });

  // ── No summary text ────────────────────────────────────────────

  it('does not render summary paragraph when gate.summary is empty', () => {
    const gate = makeGate({ summary: '' });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    // The summary text should not be present -- the panel still renders
    expect(screen.getByText('Review Required: plan_review')).toBeTruthy();
    // There should be no paragraph with empty content for summary
    expect(screen.queryByText('Please review the implementation plan.')).toBeNull();
  });

  // ── No artifact badges on summary when artifacts are empty ──────

  it('does not show "Artifacts" section on summary tab when presentedArtifacts is empty', () => {
    const gate = makeGate({ presentedArtifacts: [] });
    render(GateReviewPanel, { props: makeProps({ gate }) });

    // The uppercase "Artifacts" section heading should not appear
    // (only the tab button would show "Artifacts" if fetchArtifacts is given)
    expect(screen.queryByText('Artifacts')).toBeNull();
  });

  // ── Caching: artifact is not re-fetched on re-select ────────────

  it('does not re-fetch an already loaded artifact when re-selected', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan', 'tests'] });
    const fetchArtifacts = vi.fn().mockImplementation((_wfId: string, name: string) => {
      if (name === 'plan') {
        return Promise.resolve({ files: [{ path: 'plan.md', content: '# Plan' }] });
      }
      return Promise.resolve({ files: [{ path: 'test.ts', content: 'test code' }] });
    });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    // Switch to second artifact
    const selectorButtons = screen.getAllByText('tests');
    const testsSelector = selectorButtons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    await fireEvent.click(testsSelector!);

    await vi.waitFor(() => {
      expect(screen.getByText('test.ts')).toBeTruthy();
    });

    // Switch back to first artifact
    const planButtons = screen.getAllByText('plan');
    const planSelector = planButtons.find((el) => el.tagName === 'BUTTON' || el.closest('button'));
    await fireEvent.click(planSelector!);

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    const planCalls = fetchArtifacts.mock.calls.filter((call: unknown[]) => call[1] === 'plan');
    expect(planCalls.length).toBe(1);
  });

  // ── Artifact with multiple files ────────────────────────────────

  it('renders all files within a single artifact', async () => {
    const gate = makeGate({ presentedArtifacts: ['docs'] });
    const artifactContent: ArtifactContentDto = {
      files: [
        { path: 'readme.md', content: '# Readme\n\nWelcome.' },
        { path: 'config.json', content: '{ "key": "value" }' },
      ],
    };
    const fetchArtifacts = vi.fn().mockResolvedValue(artifactContent);

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('readme.md')).toBeTruthy();
      expect(screen.getByText('config.json')).toBeTruthy();
    });

    const readmeContainer = screen.getByText('readme.md').closest('.border')?.querySelector('.prose-markdown');
    expect(readmeContainer).toBeTruthy();
    expect(readmeContainer?.querySelector('h1')?.textContent).toBe('Readme');

    expect(screen.getByText('{ "key": "value" }').closest('code')).toBeTruthy();
  });

  // ── Single artifact does not show selector buttons ──────────────

  it('does not show artifact selector buttons when there is only one artifact', async () => {
    const gate = makeGate({ presentedArtifacts: ['plan'] });
    const fetchArtifacts = vi.fn().mockResolvedValue({
      files: [{ path: 'plan.md', content: '# Plan' }],
    });

    render(GateReviewPanel, {
      props: makeProps({ gate, fetchArtifacts }),
    });

    await switchToArtifactsTab();

    await vi.waitFor(() => {
      expect(screen.getByText('plan.md')).toBeTruthy();
    });

    // With only one artifact, there should be no selector button row
    // (the artifact content should render directly without selection UI)
    // The "plan" text appears as a badge in summary but not as a selector button in artifacts tab
    const planElements = screen.queryAllByText('plan');
    const selectorButton = planElements.find((el) => el.closest('button') && el.closest('.space-y-3'));
    expect(selectorButton).toBeUndefined();
  });
});
