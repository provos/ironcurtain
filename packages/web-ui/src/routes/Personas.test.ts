import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import type {
  PersonaListItem,
  PersonaDetailDto,
  PersonaCompileStreamAckDto,
  PersonaCompileOperationDto,
} from '$lib/types.js';

// ---------------------------------------------------------------------------
// Mock store -- declared before importing the component.
//
// The streamed-compile flow drives the live indicator off `appState.personaCompiles`.
// We provide a minimal mutable `appState` plus a `connectionGeneration` object so the
// component's reactive reads resolve. Component unit tests focus on list/detail
// navigation and the *start* of a compile (the RPC call + synchronous error
// affordances); the event-driven live progression is exercised end-to-end by the
// Playwright suite against the mock WS server.
// ---------------------------------------------------------------------------

const mockListPersonas = vi.fn<() => Promise<PersonaListItem[]>>();
const mockGetPersonaDetail = vi.fn<(name: string) => Promise<PersonaDetailDto>>();
const mockStartPersonaCompile = vi.fn<(name: string) => Promise<PersonaCompileStreamAckDto>>();
const mockHydratePersonaCompiles = vi.fn<() => Promise<Set<string>>>();

const appStateMock = {
  personaCompiles: new Map<string, PersonaCompileOperationDto>(),
};
const connectionGenerationMock = { value: 0 };

vi.mock('$lib/stores.svelte.js', () => ({
  listPersonas: (...args: unknown[]) => mockListPersonas(...(args as [])),
  getPersonaDetail: (...args: unknown[]) => mockGetPersonaDetail(...(args as [string])),
  startPersonaCompile: (...args: unknown[]) => mockStartPersonaCompile(...(args as [string])),
  hydratePersonaCompiles: (...args: unknown[]) => mockHydratePersonaCompiles(...(args as [])),
  get appState() {
    return appStateMock;
  },
  get connectionGeneration() {
    return connectionGenerationMock;
  },
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
    mockHydratePersonaCompiles.mockResolvedValue(new Set());
    appStateMock.personaCompiles = new Map();
    connectionGenerationMock.value = 0;
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

    const constitutionCard = screen.getByText('Constitution').closest('[class*="card"]');
    const markdownContainer = constitutionCard?.querySelector('.prose-markdown');
    expect(markdownContainer).toBeTruthy();

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

  // ── Compile (streamed): start ─────────────────────────────────────

  it('starts a streamed compile via startPersonaCompile when the button is clicked', async () => {
    mockStartPersonaCompile.mockResolvedValue({ accepted: true, name: 'researcher', operationId: 'op-1' });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(mockStartPersonaCompile).toHaveBeenCalledWith('researcher');
    });
  });

  it('renders a typed error affordance when compileStream is rejected (gated)', async () => {
    mockStartPersonaCompile.mockRejectedValue({
      code: 'POLICY_MUTATION_FORBIDDEN',
      message: 'Policy mutation is disabled',
    });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('compile-error-code').textContent).toBe('POLICY_MUTATION_FORBIDDEN');
      expect(screen.getByText(/Policy compilation is disabled/)).toBeTruthy();
    });
  });

  it('renders a credentials-missing affordance when compileStream reports CREDENTIALS_MISSING', async () => {
    mockStartPersonaCompile.mockRejectedValue({
      code: 'CREDENTIALS_MISSING',
      message: 'No API key',
    });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('Compile Policy')).toBeTruthy();
    });

    await fireEvent.click(screen.getByText('Compile Policy'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('compile-error-code').textContent).toBe('CREDENTIALS_MISSING');
      expect(screen.getByText(/credentials are missing/)).toBeTruthy();
    });
  });

  it('hydrates in-flight compiles on mount', async () => {
    await renderAndNavigateToDetail();
    await vi.waitFor(() => {
      expect(mockHydratePersonaCompiles).toHaveBeenCalled();
    });
  });

  // ── Detail view: loading spinner ───────────────────────────────

  it('shows a loading spinner while fetching persona detail', async () => {
    mockListPersonas.mockResolvedValue([makePersona()]);
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

  // ── List view: loading spinner ──────────────────────────────────

  it('shows a loading spinner while fetching the persona list', () => {
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
