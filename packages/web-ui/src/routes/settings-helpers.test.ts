import { describe, it, expect } from 'vitest';
import type { OpenrouterProfileDto } from '$lib/types.js';
import {
  toEditable,
  editableToDto,
  parseList,
  blankOpenrouterProfile,
  isDuplicateProfileName,
  sourceEnforces,
  persistedSlugSet,
  validateSlugs,
  blockMessage,
  warningMessage,
  type EditableProfile,
  type KnownModels,
} from './settings-helpers.js';

// ---------------------------------------------------------------------------
// Full-field get→edit→set round-trip (M4) + M5 masked-key preservation.
//
// These pure helpers are what the Settings view uses to convert a fetched
// masked DTO into the editable form and back to a wire DTO. Testing them here
// exercises the every-field parity and the masked-key-unchanged behavior
// without the DOM.
// ---------------------------------------------------------------------------

const MASK = 'sk-...xyz';

/** A fully-populated masked openrouter DTO as `config.getModelProviders` returns. */
function fullMaskedDto(): OpenrouterProfileDto {
  return {
    type: 'openrouter',
    apiKey: MASK,
    modelMap: [
      { match: '*sonnet*', model: 'z-ai/glm-5.2' },
      { match: '*opus*', model: 'z-ai/glm-5.2' },
    ],
    perAgent: { 'claude-code': 'z-ai/glm-5.2', goose: 'z-ai/glm-5.2', codex: 'z-ai/glm-5.2' },
    providerPreference: { order: ['z-ai'], only: [], allowFallbacks: false },
    sessionAffinity: true,
  };
}

describe('settings-helpers round-trip', () => {
  it('preserves every field through toEditable → editableToDto when nothing is edited', () => {
    const dto = fullMaskedDto();
    const back = editableToDto(toEditable(dto));

    expect(back.type).toBe('openrouter');
    // Masked key sent back verbatim -> backend keeps the stored key (M5).
    expect(back.apiKey).toBe(MASK);
    expect(back.modelMap).toEqual([
      { match: '*sonnet*', model: 'z-ai/glm-5.2' },
      { match: '*opus*', model: 'z-ai/glm-5.2' },
    ]);
    expect(back.perAgent).toEqual({ 'claude-code': 'z-ai/glm-5.2', goose: 'z-ai/glm-5.2', codex: 'z-ai/glm-5.2' });
    // `only: []` collapses away; `order` and allowFallbacks survive.
    expect(back.providerPreference).toEqual({ order: ['z-ai'], allowFallbacks: false });
    expect(back.sessionAffinity).toBe(true);
  });

  it('sends a user-typed apiKey (not the mask) when edited', () => {
    const editable = toEditable(fullMaskedDto());
    editable.apiKey = 'sk-or-v1-NEWKEY';
    const back = editableToDto(editable);
    expect(back.apiKey).toBe('sk-or-v1-NEWKEY');
  });

  it('sends an empty apiKey (clear) when the field is emptied', () => {
    const editable = toEditable(fullMaskedDto());
    editable.apiKey = '';
    const back = editableToDto(editable);
    expect(back.apiKey).toBe('');
  });

  it('round-trips edits to modelMap rows', () => {
    const editable = toEditable(fullMaskedDto());
    editable.modelMap = [{ match: '*', model: 'moonshot/kimi-k3' }];
    const back = editableToDto(editable);
    expect(back.modelMap).toEqual([{ match: '*', model: 'moonshot/kimi-k3' }]);
  });

  it('round-trips edits to perAgent (trims and drops blanks)', () => {
    const editable = toEditable(fullMaskedDto());
    editable.perAgent.goose = '  openai/gpt-x  ';
    editable.perAgent.codex = '';
    const back = editableToDto(editable);
    expect(back.perAgent).toEqual({ 'claude-code': 'z-ai/glm-5.2', goose: 'openai/gpt-x' });
  });

  it('round-trips providerPreference order/only/allowFallbacks', () => {
    const editable = toEditable(fullMaskedDto());
    editable.providerOrder = 'z-ai, deepinfra';
    editable.providerOnly = '';
    editable.allowFallbacks = true;
    const back = editableToDto(editable);
    expect(back.providerPreference).toEqual({ order: ['z-ai', 'deepinfra'], allowFallbacks: true });
  });

  it('round-trips sessionAffinity toggle', () => {
    const editable = toEditable(fullMaskedDto());
    editable.sessionAffinity = false;
    expect(editableToDto(editable).sessionAffinity).toBe(false);
  });

  it('omits modelMap (restores default map) when a default-map profile has zero rows', () => {
    // A DTO with modelMap undefined = "used the default map".
    const dto: OpenrouterProfileDto = { type: 'openrouter', apiKey: 'none' };
    const editable = toEditable(dto);
    expect(editable.usesDefaultMap).toBe(true);
    const back = editableToDto(editable);
    expect(back.modelMap).toBeUndefined();
  });

  it('sends an explicit empty modelMap (per-agent-only) when rows are cleared from a mapped profile', () => {
    const editable = toEditable(fullMaskedDto()); // usesDefaultMap = false (had a map)
    editable.modelMap = [];
    const back = editableToDto(editable);
    expect(back.modelMap).toEqual([]);
  });

  it('omits modelMap whenever usesDefaultMap is set, even if stale rows linger (checkbox decoupling)', () => {
    // The "use default map" checkbox hides but preserves any prior custom rows;
    // usesDefaultMap must win so re-checking it re-tracks the default (not the
    // hidden rows). This is the case the old zero-rows-AND-default guard missed.
    const editable = toEditable(fullMaskedDto());
    editable.usesDefaultMap = true;
    editable.modelMap = [{ match: '*opus*', model: 'z-ai/glm-5.2' }];
    const back = editableToDto(editable);
    expect(back.modelMap).toBeUndefined();
  });

  it('omits providerPreference when both lists are empty', () => {
    const editable = blankOpenrouterProfile();
    editable.apiKey = 'sk-or-v1-x';
    const back = editableToDto(editable);
    expect(back.providerPreference).toBeUndefined();
  });
});

describe('parseList', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseList('z-ai,  deepinfra , ,')).toEqual(['z-ai', 'deepinfra']);
    expect(parseList('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slug validation (OpenRouter model autocomplete).
// ---------------------------------------------------------------------------

describe('sourceEnforces', () => {
  it('blocks on authoritative sources and warns on the bundled floor', () => {
    expect(sourceEnforces('live')).toBe(true);
    expect(sourceEnforces('cache')).toBe(true);
    expect(sourceEnforces('bundled')).toBe(false);
  });
});

describe('persistedSlugSet', () => {
  it('returns an empty set for a brand-new (undefined) profile', () => {
    expect(persistedSlugSet(undefined).size).toBe(0);
  });

  it('collects every persisted modelMap + perAgent slug, trimmed and de-duped', () => {
    const dto: OpenrouterProfileDto = {
      type: 'openrouter',
      modelMap: [
        { match: '*sonnet*', model: 'z-ai/glm-5.2' },
        { match: '*opus*', model: 'z-ai/glm-5.2' },
      ],
      perAgent: { 'claude-code': 'openai/gpt-x', goose: undefined, codex: '  moonshot/kimi-k3  ' },
    };
    expect(persistedSlugSet(dto)).toEqual(new Set(['z-ai/glm-5.2', 'openai/gpt-x', 'moonshot/kimi-k3']));
  });
});

/** A minimal editable profile with a custom map (usesDefaultMap = false). */
function editableWith(over: Partial<EditableProfile> = {}): EditableProfile {
  return {
    apiKey: 'sk-x',
    modelMap: [],
    perAgent: { 'claude-code': '', goose: '', codex: '' },
    providerOrder: '',
    providerOnly: '',
    allowFallbacks: true,
    sessionAffinity: true,
    usesDefaultMap: false,
    ...over,
  };
}

const KNOWN = 'z-ai/glm-5.2';
const known = (source: KnownModels['source']): KnownModels => ({ slugs: new Set([KNOWN]), source });
const NONE: ReadonlySet<string> = new Set();

describe('validateSlugs', () => {
  it('blocks an unknown modelMap slug under an authoritative (live) source', () => {
    const p = editableWith({ modelMap: [{ match: '*', model: 'foo/bar' }] });
    const v = validateSlugs(p, known('live'), NONE);
    expect(v.blocked).toEqual([{ field: 'model', index: 0, slug: 'foo/bar' }]);
    expect(v.warnings).toEqual([]);
  });

  it('only warns on an unknown slug under the bundled fallback', () => {
    const p = editableWith({ modelMap: [{ match: '*', model: 'foo/bar' }] });
    const v = validateSlugs(p, known('bundled'), NONE);
    expect(v.blocked).toEqual([]);
    expect(v.warnings).toEqual([{ field: 'model', index: 0, slug: 'foo/bar' }]);
  });

  it('treats a known slug as clean', () => {
    const p = editableWith({ modelMap: [{ match: '*', model: KNOWN }] });
    expect(validateSlugs(p, known('live'), NONE)).toEqual({ blocked: [], warnings: [] });
  });

  it('ignores empty slugs (never validated)', () => {
    const p = editableWith({
      modelMap: [{ match: '*', model: '   ' }],
      perAgent: { 'claude-code': '', goose: '', codex: '' },
    });
    expect(validateSlugs(p, known('live'), NONE)).toEqual({ blocked: [], warnings: [] });
  });

  it('grandfathers a persisted slug under an authoritative source (key-rotation case)', () => {
    // The persisted slug is absent from the (delisted) live catalog, but was
    // already saved — editing only the API key must never trap it.
    const p = editableWith({ modelMap: [{ match: '*sonnet*', model: 'z-ai/legacy-glm' }] });
    const grandfathered = new Set(['z-ai/legacy-glm']);
    const v = validateSlugs(p, known('live'), grandfathered);
    expect(v.blocked).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('trims before the membership check (a trailing-space known slug is clean)', () => {
    const p = editableWith({ modelMap: [{ match: '*', model: `${KNOWN}  ` }] });
    expect(validateSlugs(p, known('live'), NONE)).toEqual({ blocked: [], warnings: [] });
  });

  it('validates per-agent slugs and locates them by agent', () => {
    const p = editableWith({ perAgent: { 'claude-code': '', goose: 'bad/one', codex: KNOWN } });
    const v = validateSlugs(p, known('live'), NONE);
    expect(v.blocked).toEqual([{ field: 'peragent', agent: 'goose', slug: 'bad/one' }]);
  });

  it('skips modelMap entirely when the profile tracks the default map', () => {
    // Stale rows can linger behind the "use default map" toggle; they are omitted
    // on save, so they must not block.
    const p = editableWith({ usesDefaultMap: true, modelMap: [{ match: '*', model: 'foo/bar' }] });
    expect(validateSlugs(p, known('live'), NONE)).toEqual({ blocked: [], warnings: [] });
  });

  it('skips a modelMap row with no match (editableToDto would discard it)', () => {
    const p = editableWith({ modelMap: [{ match: '', model: 'foo/bar' }] });
    expect(validateSlugs(p, known('live'), NONE)).toEqual({ blocked: [], warnings: [] });
  });
});

describe('blockMessage', () => {
  it('names each bad slug and where it lives', () => {
    const msg = blockMessage([
      { field: 'model', index: 1, slug: 'foo/bar' },
      { field: 'peragent', agent: 'codex', slug: 'x/y' },
    ]);
    expect(msg).toContain('Model map row 2: `foo/bar`');
    expect(msg).toContain('codex override: `x/y`');
    expect(msg).toContain('is not a known OpenRouter model');
  });
});

describe('warningMessage', () => {
  it('is empty when there are no warnings', () => {
    expect(warningMessage([])).toBe('');
  });

  it('lists the unverified slugs', () => {
    const msg = warningMessage([{ field: 'peragent', agent: 'goose', slug: 'a/b' }]);
    expect(msg).toContain('goose override: `a/b`');
    expect(msg.toLowerCase()).toContain('offline');
  });
});

describe('isDuplicateProfileName', () => {
  const existing = ['kimi', 'glm'];

  it('flags an add whose name collides with an existing profile', () => {
    // Add flow: original is null, name already taken → would clobber `glm`.
    expect(isDuplicateProfileName('glm', null, existing)).toBe(true);
  });

  it('flags a rename onto another existing profile', () => {
    // Editing `kimi`, renaming it to `glm` → would clobber `glm`.
    expect(isDuplicateProfileName('glm', 'kimi', existing)).toBe(true);
  });

  it('allows an edit that keeps the same name', () => {
    // Editing `glm` in place (name unchanged) must not be rejected.
    expect(isDuplicateProfileName('glm', 'glm', existing)).toBe(false);
  });

  it('allows a brand-new unique name', () => {
    expect(isDuplicateProfileName('deepseek', null, existing)).toBe(false);
  });

  it('allows a rename to an unused name', () => {
    expect(isDuplicateProfileName('deepseek', 'kimi', existing)).toBe(false);
  });
});
