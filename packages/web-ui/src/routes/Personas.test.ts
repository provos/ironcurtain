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
const mockCreatePersona = vi.fn();
const mockEditPersonaConstitution = vi.fn();
const mockSetPersonaMemory = vi.fn();
const mockSetPersonaBroadPolicyOptIn = vi.fn();
const mockDeletePersona = vi.fn();

// Default to mutation-allowed so the existing compile/edit suites can exercise
// the gated controls. The flag-OFF (controls hidden) path is covered by the
// Playwright e2e against the mock WS server.
const appStateMock: {
  personaCompiles: Map<string, PersonaCompileOperationDto>;
  daemonStatus: { allowPolicyMutation: boolean } | null;
} = {
  personaCompiles: new Map<string, PersonaCompileOperationDto>(),
  daemonStatus: { allowPolicyMutation: true },
};
const connectionGenerationMock = { value: 0 };
const personasChangedGenerationMock = { value: 0 };

vi.mock('$lib/stores.svelte.js', () => ({
  listPersonas: (...args: unknown[]) => mockListPersonas(...(args as [])),
  getPersonaDetail: (...args: unknown[]) => mockGetPersonaDetail(...(args as [string])),
  startPersonaCompile: (...args: unknown[]) => mockStartPersonaCompile(...(args as [string])),
  hydratePersonaCompiles: (...args: unknown[]) => mockHydratePersonaCompiles(...(args as [])),
  createPersona: (...args: unknown[]) => mockCreatePersona(...args),
  editPersonaConstitution: (...args: unknown[]) => mockEditPersonaConstitution(...args),
  setPersonaMemory: (...args: unknown[]) => mockSetPersonaMemory(...args),
  setPersonaBroadPolicyOptIn: (...args: unknown[]) => mockSetPersonaBroadPolicyOptIn(...args),
  deletePersona: (...args: unknown[]) => mockDeletePersona(...args),
  get appState() {
    return appStateMock;
  },
  get connectionGeneration() {
    return connectionGenerationMock;
  },
  get personasChangedGeneration() {
    return personasChangedGenerationMock;
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
    appStateMock.daemonStatus = { allowPolicyMutation: true };
    connectionGenerationMock.value = 0;
    personasChangedGenerationMock.value = 0;
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
    // With mutation enabled the empty state points at the New persona button.
    expect(screen.getByTestId('new-persona-button')).toBeTruthy();
  });

  it('shows the CLI create hint in the empty state on a read-only daemon', async () => {
    appStateMock.daemonStatus = { allowPolicyMutation: false };
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

  it('renders constitution markdown with prose-markdown class (read-only daemon)', async () => {
    // The prose-markdown render only applies when mutation is disabled; with
    // mutation on, the constitution is shown as an editable textarea.
    appStateMock.daemonStatus = { allowPolicyMutation: false };
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

  it('shows "No constitution defined yet." when constitution is empty (read-only daemon)', async () => {
    appStateMock.daemonStatus = { allowPolicyMutation: false };
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

  it('shows "No constitution defined yet." when constitution is undefined (read-only daemon)', async () => {
    appStateMock.daemonStatus = { allowPolicyMutation: false };
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

  // ── Phase 1c: kill-switch gating ──────────────────────────────────

  it('hides the New persona button when policy mutation is disabled', async () => {
    appStateMock.daemonStatus = { allowPolicyMutation: false };
    mockListPersonas.mockResolvedValue([makePersona()]);
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByText('researcher')).toBeTruthy();
    });
    expect(screen.queryByTestId('new-persona-button')).toBeNull();
  });

  it('hides compile/delete/edit controls in detail view when mutation is disabled', async () => {
    appStateMock.daemonStatus = { allowPolicyMutation: false };
    await renderAndNavigateToDetail();

    await vi.waitFor(() => {
      expect(screen.getByText('A research-focused persona')).toBeTruthy();
    });
    expect(screen.queryByTestId('compile-button')).toBeNull();
    expect(screen.queryByTestId('delete-button')).toBeNull();
    expect(screen.queryByTestId('constitution-editor')).toBeNull();
    expect(screen.queryByTestId('memory-toggle')).toBeNull();
    expect(screen.queryByTestId('broad-policy-toggle')).toBeNull();
  });

  it('shows the New persona button when mutation is enabled', async () => {
    mockListPersonas.mockResolvedValue([makePersona()]);
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByTestId('new-persona-button')).toBeTruthy();
    });
  });

  // ── Phase 1c: create form ─────────────────────────────────────────

  it('creates a persona via the New persona form (servers omitted = all servers)', async () => {
    mockListPersonas.mockResolvedValue([]);
    mockCreatePersona.mockResolvedValue(makeDetail({ name: 'newbie' }));
    mockGetPersonaDetail.mockResolvedValue(makeDetail({ name: 'newbie' }));
    render(Personas);

    await vi.waitFor(() => {
      expect(screen.getByTestId('new-persona-button')).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId('new-persona-button'));

    await fireEvent.input(screen.getByTestId('new-persona-name'), { target: { value: 'newbie' } });
    await fireEvent.input(screen.getByTestId('new-persona-description'), { target: { value: 'A new persona' } });
    await fireEvent.click(screen.getByTestId('create-persona-button'));

    await vi.waitFor(() => {
      expect(mockCreatePersona).toHaveBeenCalledWith({
        name: 'newbie',
        description: 'A new persona',
        servers: undefined,
        memoryEnabled: true,
      });
    });
  });

  it('passes the narrowed server list when "Narrow to specific servers" is chosen', async () => {
    mockListPersonas.mockResolvedValue([]);
    mockCreatePersona.mockResolvedValue(makeDetail({ name: 'narrow' }));
    mockGetPersonaDetail.mockResolvedValue(makeDetail({ name: 'narrow' }));
    render(Personas);

    await vi.waitFor(() => expect(screen.getByTestId('new-persona-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('new-persona-button'));
    await fireEvent.input(screen.getByTestId('new-persona-name'), { target: { value: 'narrow' } });
    await fireEvent.input(screen.getByTestId('new-persona-description'), { target: { value: 'desc' } });
    await fireEvent.click(screen.getByTestId('new-persona-narrow-servers'));
    await fireEvent.click(screen.getByTestId('new-persona-server-filesystem'));
    await fireEvent.click(screen.getByTestId('create-persona-button'));

    await vi.waitFor(() => {
      expect(mockCreatePersona).toHaveBeenCalledWith(expect.objectContaining({ servers: ['filesystem'] }));
    });
  });

  it('shows an inline PERSONA_EXISTS error on the name field', async () => {
    mockListPersonas.mockResolvedValue([]);
    mockCreatePersona.mockRejectedValue({ code: 'PERSONA_EXISTS', message: 'exists' });
    render(Personas);

    await vi.waitFor(() => expect(screen.getByTestId('new-persona-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('new-persona-button'));
    await fireEvent.input(screen.getByTestId('new-persona-name'), { target: { value: 'dup' } });
    await fireEvent.input(screen.getByTestId('new-persona-description'), { target: { value: 'desc' } });
    await fireEvent.click(screen.getByTestId('create-persona-button'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('new-persona-name-error')).toBeTruthy();
    });
  });

  // ── Phase 1c: edit constitution + stale badge ─────────────────────

  it('shows the stale badge after a constitution edit reports stale', async () => {
    mockEditPersonaConstitution.mockResolvedValue({ stale: true });
    await renderAndNavigateToDetail({ hasPolicy: true, policyRuleCount: 4 }, { compiled: true });

    await vi.waitFor(() => expect(screen.getByTestId('constitution-editor')).toBeTruthy());
    await fireEvent.input(screen.getByTestId('constitution-editor'), { target: { value: '# Changed' } });
    await fireEvent.click(screen.getByTestId('save-constitution-button'));

    await vi.waitFor(() => {
      expect(mockEditPersonaConstitution).toHaveBeenCalledWith('researcher', '# Changed');
      expect(screen.getByTestId('stale-badge')).toBeTruthy();
    });
  });

  // ── Phase 1c: memory toggle ───────────────────────────────────────

  it('toggles persona memory via setPersonaMemory', async () => {
    mockSetPersonaMemory.mockResolvedValue(makeDetail({ memory: false }));
    await renderAndNavigateToDetail({ memory: true });

    await vi.waitFor(() => expect(screen.getByTestId('memory-toggle')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('memory-toggle'));

    await vi.waitFor(() => {
      expect(mockSetPersonaMemory).toHaveBeenCalledWith('researcher', false);
    });
  });

  // ── Phase 1c: broad-policy opt-in ─────────────────────────────────

  it('toggles broad-policy opt-in via setPersonaBroadPolicyOptIn', async () => {
    mockSetPersonaBroadPolicyOptIn.mockResolvedValue(makeDetail({ allowBroadPolicy: true }));
    await renderAndNavigateToDetail({ allowBroadPolicy: false });

    await vi.waitFor(() => expect(screen.getByTestId('broad-policy-toggle')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('broad-policy-toggle'));

    await vi.waitFor(() => {
      expect(mockSetPersonaBroadPolicyOptIn).toHaveBeenCalledWith('researcher', true);
    });
  });

  // ── Phase 1c: delete confirm + force ──────────────────────────────

  it('soft-deletes a persona via the confirm dialog', async () => {
    mockDeletePersona.mockResolvedValue({ deleted: true });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => expect(screen.getByTestId('delete-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('delete-button'));
    await vi.waitFor(() => expect(screen.getByTestId('confirm-delete-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('confirm-delete-button'));

    await vi.waitFor(() => {
      expect(mockDeletePersona).toHaveBeenCalledWith('researcher', undefined);
    });
  });

  it('force-deletes a persona when the revoke checkbox is checked', async () => {
    mockDeletePersona.mockResolvedValue({ deleted: true });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => expect(screen.getByTestId('delete-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('delete-button'));
    await vi.waitFor(() => expect(screen.getByTestId('delete-force')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('delete-force'));
    await fireEvent.click(screen.getByTestId('confirm-delete-button'));

    await vi.waitFor(() => {
      expect(mockDeletePersona).toHaveBeenCalledWith('researcher', { force: true });
    });
  });

  // ── Phase 1c: broad-policy-rejected affordance on compile failure ─

  it('surfaces a BROAD_POLICY_REJECTED affordance pointing at the opt-in', async () => {
    mockStartPersonaCompile.mockRejectedValue({ code: 'BROAD_POLICY_REJECTED', message: 'too broad' });
    await renderAndNavigateToDetail();

    await vi.waitFor(() => expect(screen.getByTestId('compile-button')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('compile-button'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('compile-error-code').textContent).toBe('BROAD_POLICY_REJECTED');
      expect(screen.getByText(/Enable "Allow broad policy" for this persona/)).toBeTruthy();
    });
  });
});
