/**
 * Pure helpers for the Settings (Model Providers) view.
 *
 * The editable form works with a flattened `EditableProfile` (comma-separated
 * provider lists, a bindable perAgent record) that round-trips to/from the wire
 * `OpenrouterProfileDto`. Kept Svelte-free so the get→edit→set→get round-trip
 * (incl. the M5 masked-key preservation) is unit-testable without the DOM.
 */

import type { ModelMapRuleDto, OpenrouterProfileDto } from '$lib/types.js';

/** The reserved, always-present implicit profile name. */
export const NATIVE_NAME = 'native';

/** Docker agents that support a per-agent model override. */
export const DOCKER_AGENTS = ['claude-code', 'goose', 'codex'] as const;
export type DockerAgent = (typeof DOCKER_AGENTS)[number];

/**
 * The form's editable representation of an openrouter profile.
 *
 * `apiKey` holds either the masked value (unchanged → sent back verbatim so the
 * backend keeps the stored key) or a user-typed replacement. `providerOrder` /
 * `providerOnly` are comma-separated strings for ergonomic editing. `perAgent`
 * uses '' for "unset" so the inputs are always bindable.
 */
export interface EditableProfile {
  apiKey: string;
  modelMap: ModelMapRuleDto[];
  perAgent: Record<DockerAgent, string>;
  providerOrder: string;
  providerOnly: string;
  allowFallbacks: boolean;
  sessionAffinity: boolean;
  /** True when the profile omitted `modelMap` entirely (use the default map). */
  usesDefaultMap: boolean;
}

/** A fresh blank openrouter profile for the "Add profile" flow. */
export function blankOpenrouterProfile(): EditableProfile {
  return {
    apiKey: '',
    modelMap: [],
    perAgent: { 'claude-code': '', goose: '', codex: '' },
    providerOrder: '',
    providerOnly: '',
    allowFallbacks: true,
    sessionAffinity: true,
    // A brand-new profile with no rows means "no glob mapping" only if the user
    // leaves it empty AND explicitly opts into per-agent-only. To keep the add
    // flow ergonomic we start with the default map (usesDefaultMap = true).
    usesDefaultMap: true,
  };
}

/** Converts a fetched masked DTO into the form's editable shape. */
export function toEditable(dto: OpenrouterProfileDto): EditableProfile {
  const pp = dto.providerPreference;
  return {
    apiKey: dto.apiKey ?? '',
    modelMap: (dto.modelMap ?? []).map((r) => ({ match: r.match, model: r.model })),
    perAgent: {
      'claude-code': dto.perAgent?.['claude-code'] ?? '',
      goose: dto.perAgent?.goose ?? '',
      codex: dto.perAgent?.codex ?? '',
    },
    providerOrder: (pp?.order ?? []).join(', '),
    providerOnly: (pp?.only ?? []).join(', '),
    allowFallbacks: pp?.allowFallbacks ?? true,
    sessionAffinity: dto.sessionAffinity ?? true,
    usesDefaultMap: dto.modelMap === undefined,
  };
}

/**
 * True when saving `name` would clobber a different existing profile.
 *
 * A rename or add is a collision when the (trimmed) target name is not the one
 * being edited (`original`) yet already appears in `existingNames`. Keeping the
 * same name (`name === original`) is always allowed — that's a plain edit-in-place.
 * Callers pass the trimmed name; `existingNames` should exclude the reserved
 * `native` (that clash is rejected separately).
 */
export function isDuplicateProfileName(
  name: string,
  original: string | null,
  existingNames: readonly string[],
): boolean {
  return name !== original && existingNames.includes(name);
}

/** Parses a comma-separated list into trimmed, non-empty tokens. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Converts the editable form back into a wire `OpenrouterProfileDto`.
 *
 * The apiKey is passed through verbatim: an untouched masked value is sent back
 * (backend M5 mask-equality → keep), an empty string clears, any other value
 * sets. Model map keys off `usesDefaultMap`: when set, the field is OMITTED so
 * the built-in default map applies (and stays in sync); otherwise the explicit
 * rows are sent, and zero valid rows becomes `[]` ("per-agent only" — the glob
 * never matches). Provider preference is omitted when both lists are empty.
 */
export function editableToDto(p: EditableProfile): OpenrouterProfileDto {
  const dto: {
    type: 'openrouter';
    apiKey?: string;
    modelMap?: ModelMapRuleDto[];
    perAgent?: Record<string, string>;
    providerPreference?: { order?: string[]; only?: string[]; allowFallbacks?: boolean };
    sessionAffinity?: boolean;
  } = { type: 'openrouter' };

  // apiKey: '' is meaningful (clear); pass through untouched (mask/new/clear).
  dto.apiKey = p.apiKey;

  // Model map: when the profile tracks the built-in default map, omit the field
  // so the default applies (and stays in sync). Otherwise send the explicit rows;
  // zero valid rows becomes `[]`, i.e. "per-agent only" (the glob never matches).
  if (!p.usesDefaultMap) {
    const rows = p.modelMap.filter((r) => r.match.trim().length > 0 && r.model.trim().length > 0);
    dto.modelMap = rows.map((r) => ({ match: r.match.trim(), model: r.model.trim() }));
  }

  const perAgent: Record<string, string> = {};
  for (const agent of DOCKER_AGENTS) {
    const slug = p.perAgent[agent].trim();
    if (slug) perAgent[agent] = slug;
  }
  if (Object.keys(perAgent).length > 0) dto.perAgent = perAgent;

  const order = parseList(p.providerOrder);
  const only = parseList(p.providerOnly);
  if (order.length > 0 || only.length > 0) {
    dto.providerPreference = {
      ...(order.length > 0 ? { order } : {}),
      ...(only.length > 0 ? { only } : {}),
      allowFallbacks: p.allowFallbacks,
    };
  }

  dto.sessionAffinity = p.sessionAffinity;
  return dto;
}

// ---------------------------------------------------------------------------
// Slug validation (OpenRouter model autocomplete).
//
// A pure, DOM-free guardrail run in `saveEdit` before persisting. The block-vs
// -warn decision keys ONLY on the catalog `source` (mirrors the backend's
// `catalogEnforces`): authoritative lists (`live`/`cache`) hard-block unknown
// slugs; the offline `bundled` floor is warn-only. Grandfathering exempts any
// slug that was already persisted for this profile, so routine edits (e.g. an
// API-key rotation) never trap an untouched — possibly since-delisted — slug.
// ---------------------------------------------------------------------------

export type ModelCatalogSource = 'live' | 'cache' | 'bundled';

/** The loaded catalog the editor validates against. */
export interface KnownModels {
  readonly slugs: ReadonlySet<string>;
  readonly source: ModelCatalogSource;
}

/** One unrecognized slug, located back to the field that produced it. */
export interface SlugIssue {
  readonly field: 'model' | 'peragent';
  /** modelMap row index (only for `field: 'model'`). */
  readonly index?: number;
  /** per-agent key (only for `field: 'peragent'`). */
  readonly agent?: DockerAgent;
  readonly slug: string;
}

/** Split of unrecognized slugs into hard-blocks and non-blocking warnings. */
export interface SlugValidation {
  readonly blocked: SlugIssue[];
  readonly warnings: SlugIssue[];
}

/**
 * The single source of truth for the block-vs-warn decision. Mirrors the
 * backend catalog's `catalogEnforces`: authoritative sources enforce (block);
 * the known-incomplete `bundled` fallback only warns.
 */
export function sourceEnforces(source: ModelCatalogSource): boolean {
  return source !== 'bundled';
}

/**
 * The set of slugs already persisted for a profile (all `modelMap[].model` and
 * all `perAgent` values, trimmed). Membership in this set exempts a current slug
 * from blocking — the robust, per-profile way to grandfather values the user did
 * not introduce this session (no per-row identity tracking needed).
 */
export function persistedSlugSet(dto: OpenrouterProfileDto | undefined): ReadonlySet<string> {
  const slugs = new Set<string>();
  if (!dto) return slugs;
  for (const row of dto.modelMap ?? []) {
    const slug = row.model.trim();
    if (slug.length > 0) slugs.add(slug);
  }
  for (const agent of DOCKER_AGENTS) {
    const slug = (dto.perAgent?.[agent] ?? '').trim();
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

/**
 * Validates the editable profile's slug-target fields against a known catalog.
 *
 * Each `modelMap[].model` (only for rows that would actually persist — see
 * `editableToDto`) and each `perAgent` slug is trimmed, then: empty → ignored;
 * in `known.slugs` or `grandfathered` → clean; otherwise blocked (authoritative
 * source) or warned (bundled). modelMap is skipped entirely when the profile
 * tracks the default map, since those rows are omitted on save.
 */
export function validateSlugs(
  p: EditableProfile,
  known: KnownModels,
  grandfathered: ReadonlySet<string>,
): SlugValidation {
  const blocked: SlugIssue[] = [];
  const warnings: SlugIssue[] = [];
  const enforce = sourceEnforces(known.source);

  const classify = (raw: string, locate: (slug: string) => SlugIssue): void => {
    const slug = raw.trim();
    if (slug.length === 0) return;
    if (known.slugs.has(slug) || grandfathered.has(slug)) return;
    (enforce ? blocked : warnings).push(locate(slug));
  };

  if (!p.usesDefaultMap) {
    p.modelMap.forEach((row, index) => {
      // A row with no `match` is filtered out by editableToDto, so it never
      // persists — validating its model would false-block a discarded row.
      if (row.match.trim().length === 0) return;
      classify(row.model, (slug) => ({ field: 'model', index, slug }));
    });
  }
  for (const agent of DOCKER_AGENTS) {
    classify(p.perAgent[agent], (slug) => ({ field: 'peragent', agent, slug }));
  }
  return { blocked, warnings };
}

/** Human-readable location for a slug issue, e.g. "Model map row 2: `foo/bar`". */
function describeIssue(issue: SlugIssue): string {
  const where = issue.field === 'model' ? `Model map row ${(issue.index ?? 0) + 1}` : `${issue.agent} override`;
  return `${where}: \`${issue.slug}\``;
}

/** Save-blocking message naming each unknown slug and where it lives. */
export function blockMessage(blocked: SlugIssue[]): string {
  return blocked.map((issue) => `${describeIssue(issue)} is not a known OpenRouter model`).join('; ');
}

/** Non-blocking note for slugs unverifiable against the offline `bundled` floor. */
export function warningMessage(warnings: SlugIssue[]): string {
  if (warnings.length === 0) return '';
  const list = warnings.map(describeIssue).join('; ');
  return `Saved. The following could not be verified against the offline model list — ${list}.`;
}
