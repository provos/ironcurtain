import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type { PersonaListItem, PersonaDetailDto, PersonaCompileResultDto } from '$lib/types.js';

// ---------------------------------------------------------------------------
// Mock store functions -- must be declared before importing the component
// ---------------------------------------------------------------------------

const mockListPersonas = vi.fn<() => Promise<PersonaListItem[]>>();
const mockGetPersonaDetail = vi.fn<(name: string) => Promise<PersonaDetailDto>>();
const mockCompilePersonaPolicy = vi.fn<(name: string) => Promise<PersonaCompileResultDto>>();

vi.mock('$lib/stores.svelte.js', () => ({
  listPersonas: (...args: unknown[]) => mockListPersonas(...(args as [])),
  getPersonaDetail: (...args: unknown[]) => mockGetPersonaDetail(...(args as [string])),
  compilePersonaPolicy: (...args: unknown[]) => mockCompilePersonaPolicy(...(args as [string])),
}));

// Import component after mocks are set up
import Personas from './Personas.svelte';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makePersona(overrides: Partial<PersonaListItem> = {}): PersonaListItem {
  return {
    name: 'researcher',
    description: 'A research-focused persona',
    compiled: false,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<PersonaDetailDto> = {}): PersonaDetailDto {
  return {
    name: 'researcher',
    description: 'A research-focused persona',
    createdAt: '2026-01-15T10:00:00Z',
    constitution: '# Research Rules\n\nAlways cite sources.',
    servers: ['filesystem', 'web-search'],
    hasPolicy: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Personas', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockListPersonas.mockResolvedValue([]);
  });

  async function renderAndNavigateToDetail(
    detailOverrides?: Partial<PersonaDetailDto>,
    listOverrides?: Partial<PersonaListItem>,
  ) {
    mockListPersonas.mockResolvedValue([makePersona(listOverrides)]);
    mockGetPersonaDetail.mockResolvedValue(makeDetail(detailOverrides));
    render(Personas);
    const name = listOverrides?.name ?? 'researcher';
    await vi.waitFor(() => {
      expect(screen.getByText(name)).toBeTruthy();
    });
    await fireEvent.click(screen.getByText(name));
  }

  // ── List view: empty state ────────────────────────────────────────

  it('shows empty state when no personas exist', async () => {
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText(/No personas found/)).toBeTruthy();
    });

    expect(screen.getByText('ironcurtain persona create')).toBeTruthy();
  });

  // ── List view: persona table ──────────────────────────────────────

  it('renders a table of personas with names, descriptions, and compilation status', async () => {
    mockListPersonas.mockResolvedValue([
      makePersona({ name: 'researcher', description: 'Research persona', compiled: true }),
      makePersona({ name: 'coder', description: 'Coding persona', compiled: false }),
    ]);

    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText('researcher')).toBeTruthy();
    });

    expect(screen.getByText('coder')).toBeTruthy();
    expect(screen.getByText('Research persona')).toBeTruthy();
    expect(screen.getByText('Coding persona')).toBeTruthy();
    expect(screen.getByText('Compiled')).toBeTruthy();
    expect(screen.getByText('Not compiled')).toBeTruthy();
  });

  it('shows the total count badge', async () => {
    mockListPersonas.mockResolvedValue([
      makePersona({ name: 'a' }),
      makePersona({ name: 'b' }),
      makePersona({ name: 'c' }),
    ]);

    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText('3 total')).toBeTruthy();
    });
  });

  it('displays the heading "Personas"', async () => {
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText('Personas')).toBeTruthy();
    });
  });

  // ── List view: error handling ─────────────────────────────────────

  it('shows an error alert when listing personas fails', async () => {
    mockListPersonas.mockRejectedValue(new Error('Connection lost'));
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText('Connection lost')).toBeTruthy();
    });
  });

  // ── Detail view: navigation ───────────────────────────────────────

  it('navigates to detail view when a persona row is clicked', async () => {
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('A research-focused persona')).toBeTruthy();
    });

    expect(mockGetPersonaDetail).toHaveBeenCalledWith('researcher');
  });

  it('navigates back to list view when Back button is clicked', async () => {
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('A research-focused persona')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText(/Back/));

    await vi.waitFor(() => {
      expect(screen.getByText('Personas')).toBeTruthy();
      expect(screen.getByText('1 total')).toBeTruthy();
    });
  });

  // ── Detail view: metadata cards ───────────────────────────────────

  it('shows description, created date, and servers in detail view', async () => {
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('A research-focused persona')).toBeTruthy();
      expect(screen.getByText('filesystem')).toBeTruthy();
      expect(screen.getByText('web-search')).toBeTruthy();
    });
  });

  it('shows "All servers" when no specific servers are set', async () => {
    await renderAndNavigateToDetail({ servers: [] });

    await vi.waitFor(() => {
      expect(screen.getByText('All servers')).toBeTruthy();
    });
  });

  // ── Detail view: policy status badges ─────────────────────────────

  it('shows "No policy" badge when persona has no compiled policy', async () => {
    await renderAndNavigateToDetail({ hasPolicy: false });

    await vi.waitFor(() => {
      expect(screen.getByText('No policy')).toBeTruthy();
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });
  });

  it('shows "Policy compiled" badge and rule count when persona has a policy', async () => {
    await renderAndNavigateToDetail({ hasPolicy: true, policyRuleCount: 12 }, { compiled: true });

    await vi.waitFor(() => {
      expect(screen.getByText('Policy compiled')).toBeTruthy();
      expect(screen.getByText('12 rules')).toBeTruthy();
      expect(screen.getByText('Recompile Policy')).toBeTruthy();
    });
  });

  // ── Detail view: constitution with markdown ───────────────────────

  it('renders constitution markdown with prose-markdown class', async () => {
    await renderAndNavigateToDetail({ constitution: '# Research Rules\n\nAlways **cite** sources.' });

    await vi.waitFor(() => {
      expect(screen.getByText('Constitution')).toBeTruthy();
    });

    // Find the prose-markdown container
    const constitutionCard = screen.getByText('Constitution').closest('[class*="card"]');
    const markdownContainer = constitutionCard?.querySelector('.prose-markdown');
    expect(markdownContainer).toBeTruthy();

    // Verify markdown was rendered into HTML
    expect(markdownContainer?.querySelector('h1')?.textContent).toBe('Research Rules');
    expect(markdownContainer?.querySelector('strong')?.textContent).toBe('cite');
  });

  it('shows "No constitution defined yet." when constitution is empty', async () => {
    await renderAndNavigateToDetail({ constitution: '' });

    await vi.waitFor(() => {
      expect(screen.getByText('No constitution defined yet.')).toBeTruthy();
    });
  });

  // ── Detail view: error handling ───────────────────────────────────

  it('shows error alert when loading persona detail fails', async () => {
    mockListPersonas.mockResolvedValue([makePersona()]);
    mockGetPersonaDetail.mockRejectedValue(new Error('Persona not found'));
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText('researcher')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('researcher'));

    await vi.waitFor(() => {
      expect(screen.getByText('Persona not found')).toBeTruthy();
    });
  });

  // ── Compile policy ────────────────────────────────────────────────

  it('compiles policy and shows success message', async () => {
    mockCompilePersonaPolicy.mockResolvedValue({ success: true, ruleCount: 8 });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Compiled successfully/)).toBeTruthy();
      expect(screen.getByText(/8 rules/)).toBeTruthy();
    });

    expect(mockCompilePersonaPolicy).toHaveBeenCalledWith('researcher');
  });

  it('shows compilation error when compile fails', async () => {
    mockCompilePersonaPolicy.mockResolvedValue({
      success: false,
      ruleCount: 0,
      errors: ['Invalid constitution format'],
    });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Compilation failed/)).toBeTruthy();
      expect(screen.getByText(/Invalid constitution format/)).toBeTruthy();
    });
  });

  it('shows compilation error when compile throws', async () => {
    mockCompilePersonaPolicy.mockRejectedValue(new Error('Network error'));
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Compilation failed/)).toBeTruthy();
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
  });

  it('refreshes detail and list after successful compilation', async () => {
    mockCompilePersonaPolicy.mockResolvedValue({ success: true, ruleCount: 5 });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    mockGetPersonaDetail.mockClear();
    mockListPersonas.mockClear();
    mockGetPersonaDetail.mockResolvedValue(makeDetail({ hasPolicy: true, policyRuleCount: 5 }));
    mockListPersonas.mockResolvedValue([makePersona({ compiled: true })]);

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(mockGetPersonaDetail).toHaveBeenCalledWith('researcher');
      expect(mockListPersonas).toHaveBeenCalled();
    });
  });

  it('does not refresh detail or list after failed compilation', async () => {
    mockCompilePersonaPolicy.mockResolvedValue({
      success: false,
      ruleCount: 0,
      errors: ['Syntax error'],
    });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    mockGetPersonaDetail.mockClear();
    mockListPersonas.mockClear();

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(screen.getByText(/Compilation failed/)).toBeTruthy();
    });

    // After a failed compile, detail and list should NOT be refreshed
    expect(mockGetPersonaDetail).not.toHaveBeenCalled();
    expect(mockListPersonas).not.toHaveBeenCalled();
  });

  // ── Detail view: loading spinner ───────────────────────────────

  it('shows a loading spinner while fetching persona detail', async () => {
    mockListPersonas.mockResolvedValue([makePersona()]);
    // Never resolves -- simulates indefinite loading
    mockGetPersonaDetail.mockReturnValue(new Promise(() => {}));
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText('researcher')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('researcher'));

    await vi.waitFor(() => {
      expect(screen.getByLabelText('Loading')).toBeTruthy();
    });
  });

  // ── Detail view: constitution with undefined ───────────────────

  it('shows "No constitution defined yet." when constitution is undefined', async () => {
    await renderAndNavigateToDetail({ constitution: undefined as unknown as string });

    await vi.waitFor(() => {
      expect(screen.getByText('No constitution defined yet.')).toBeTruthy();
    });
  });

  // ── Detail view: servers with undefined value ──────────────────

  it('shows "All servers" when servers is undefined', async () => {
    await renderAndNavigateToDetail({ servers: undefined });

    await vi.waitFor(() => {
      expect(screen.getByText('All servers')).toBeTruthy();
    });
  });

  // ── Detail view: back resets compile result ─────────────────────

  it('resets compile result when navigating back and selecting the same persona again', async () => {
    mockCompilePersonaPolicy.mockResolvedValue({ success: true, ruleCount: 8 });
    await renderAndNavigateToDetail();
    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });
    await fireEvent.click(screen.getByText('Compile Policy'));
    await vi.waitFor(() => {
      expect(screen.getByText(/Compiled successfully/)).toBeTruthy();
    });

    // Go back
    await fireEvent.click(screen.getByText(/Back/));
    await vi.waitFor(() => {
      expect(screen.getByText('Personas')).toBeTruthy();
    });

    // Re-select same persona
    mockGetPersonaDetail.mockResolvedValue(makeDetail());
    await fireEvent.click(screen.getByText('researcher'));
    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    // The compile result from the previous visit should not be shown
    expect(screen.queryByText(/Compiled successfully/)).toBeNull();
  });

  // ── List view: loading spinner ──────────────────────────────────

  it('shows a loading spinner while fetching the persona list', () => {
    // Never resolves -- simulates indefinite loading
    mockListPersonas.mockReturnValue(new Promise(() => {}));
    render(Personas);

    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  // ── Detail view: button label changes with policy state ────────

  it('shows "Recompile Policy" when persona already has a policy', async () => {
    await renderAndNavigateToDetail({ hasPolicy: true, policyRuleCount: 5 }, { compiled: true });

    await vi.waitFor(() => {
      expect(screen.getByText('Recompile Policy')).toBeTruthy();
    });
  });
});
