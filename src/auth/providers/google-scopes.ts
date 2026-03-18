/**
 * Google OAuth scope definitions and interactive scope picker.
 *
 * Provides a registry of Google Workspace scopes grouped by service,
 * a `groupMultiselect` picker for interactive authorization, and a
 * short-name resolver for the `--scopes` CLI flag.
 */

import { groupMultiselect, isCancel } from '@clack/prompts';

// ---------------------------------------------------------------------------
// Types & registry
// ---------------------------------------------------------------------------

export interface GoogleScopeEntry {
  /** Short name used in --scopes flag (e.g. "gmail.send") */
  readonly shortName: string;
  /** Full OAuth scope URL */
  readonly fullScope: string;
  /** Human-readable label for the picker */
  readonly label: string;
  /** Display group name (e.g. "Gmail") */
  readonly group: string;
  /** Access level hint shown in the picker (e.g. "read-only") */
  readonly access: string;
  /** Whether this scope is selected by default */
  readonly isDefault: boolean;
}

const SCOPE_BASE = 'https://www.googleapis.com/auth';

export const GOOGLE_SCOPES: readonly GoogleScopeEntry[] = [
  // Gmail
  {
    shortName: 'gmail.readonly',
    fullScope: `${SCOPE_BASE}/gmail.readonly`,
    label: 'Gmail (read)',
    group: 'Gmail',
    access: 'read-only',
    isDefault: true,
  },
  {
    shortName: 'gmail.send',
    fullScope: `${SCOPE_BASE}/gmail.send`,
    label: 'Gmail (send)',
    group: 'Gmail',
    access: 'write -- send emails',
    isDefault: false,
  },
  {
    shortName: 'gmail.modify',
    fullScope: `${SCOPE_BASE}/gmail.modify`,
    label: 'Gmail (modify)',
    group: 'Gmail',
    access: 'write -- read, send, delete, manage labels',
    isDefault: false,
  },
  {
    shortName: 'gmail.compose',
    fullScope: `${SCOPE_BASE}/gmail.compose`,
    label: 'Gmail (compose)',
    group: 'Gmail',
    access: 'write -- create & modify drafts',
    isDefault: false,
  },
  {
    shortName: 'gmail.labels',
    fullScope: `${SCOPE_BASE}/gmail.labels`,
    label: 'Gmail (labels)',
    group: 'Gmail',
    access: 'write -- create, update & delete labels',
    isDefault: false,
  },

  // Calendar
  {
    shortName: 'calendar.readonly',
    fullScope: `${SCOPE_BASE}/calendar.readonly`,
    label: 'Calendar (read)',
    group: 'Google Calendar',
    access: 'read-only',
    isDefault: true,
  },
  {
    shortName: 'calendar.events',
    fullScope: `${SCOPE_BASE}/calendar.events`,
    label: 'Calendar (events)',
    group: 'Google Calendar',
    access: 'write -- create & modify events',
    isDefault: false,
  },

  // Drive
  {
    shortName: 'drive.readonly',
    fullScope: `${SCOPE_BASE}/drive.readonly`,
    label: 'Drive (read)',
    group: 'Google Drive',
    access: 'read-only',
    isDefault: true,
  },
  {
    shortName: 'drive.file',
    fullScope: `${SCOPE_BASE}/drive.file`,
    label: 'Drive (per-file)',
    group: 'Google Drive',
    access: 'write -- files created or opened by the app',
    isDefault: false,
  },

  // Docs
  {
    shortName: 'documents',
    fullScope: `${SCOPE_BASE}/documents`,
    label: 'Docs (read/write)',
    group: 'Google Docs',
    access: 'write -- read & edit documents',
    isDefault: false,
  },

  // Sheets
  {
    shortName: 'spreadsheets',
    fullScope: `${SCOPE_BASE}/spreadsheets`,
    label: 'Sheets (read/write)',
    group: 'Google Sheets',
    access: 'write -- read & edit spreadsheets',
    isDefault: false,
  },

  // Slides
  {
    shortName: 'presentations',
    fullScope: `${SCOPE_BASE}/presentations`,
    label: 'Slides (read/write)',
    group: 'Google Slides',
    access: 'write -- read & edit presentations',
    isDefault: false,
  },
];

// ---------------------------------------------------------------------------
// Lookup indices (built once)
// ---------------------------------------------------------------------------

const shortNameToScope = new Map<string, string>(GOOGLE_SCOPES.map((s) => [s.shortName, s.fullScope]));

const fullScopeToEntry = new Map<string, GoogleScopeEntry>(GOOGLE_SCOPES.map((s) => [s.fullScope, s]));

// ---------------------------------------------------------------------------
// Interactive scope picker
// ---------------------------------------------------------------------------

/**
 * Shows a grouped multi-select checkbox UI for Google OAuth scopes.
 *
 * Pre-selects `existingScopes` if non-empty, otherwise falls back to defaults.
 * Returns the selected full scope URLs, or the cancel symbol if the user aborts.
 */
export async function promptGoogleScopes(existingScopes: readonly string[]): Promise<readonly string[] | symbol> {
  const initialValues =
    existingScopes.length > 0
      ? existingScopes.filter((s) => fullScopeToEntry.has(s))
      : GOOGLE_SCOPES.filter((s) => s.isDefault).map((s) => s.fullScope);

  const groups = buildGroupOptions();

  const result = await groupMultiselect<string>({
    message: 'Select Google Workspace scopes to authorize:',
    options: groups,
    initialValues,
  });

  if (isCancel(result)) {
    return result;
  }

  return result;
}

/**
 * Builds the `Record<string, Option[]>` structure expected by `groupMultiselect`.
 */
function buildGroupOptions(): Record<string, { value: string; label: string; hint: string }[]> {
  const groups = new Map<string, { value: string; label: string; hint: string }[]>();

  for (const entry of GOOGLE_SCOPES) {
    let group = groups.get(entry.group);
    if (!group) {
      group = [];
      groups.set(entry.group, group);
    }
    group.push({
      value: entry.fullScope,
      label: entry.label,
      hint: entry.access,
    });
  }

  return Object.fromEntries(groups);
}

// ---------------------------------------------------------------------------
// Short-name resolver (for --scopes flag)
// ---------------------------------------------------------------------------

/**
 * Maps short scope names (e.g. "gmail.send") to full OAuth URLs.
 * Passes through values that are already full URLs unchanged.
 * Throws on unrecognized short names.
 */
export function resolveGoogleShortScopes(shortNames: readonly string[]): readonly string[] {
  return shortNames.map((name) => {
    if (name.startsWith('https://')) {
      return name;
    }
    const full = shortNameToScope.get(name);
    if (!full) {
      const known = GOOGLE_SCOPES.map((s) => s.shortName).join(', ');
      throw new Error(`Unknown Google scope "${name}". Known scopes: ${known}`);
    }
    return full;
  });
}
