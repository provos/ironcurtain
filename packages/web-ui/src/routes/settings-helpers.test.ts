import { describe, it, expect } from 'vitest';
import type { OpenrouterProfileDto } from '$lib/types.js';
import { toEditable, editableToDto, parseList, blankOpenrouterProfile } from './settings-helpers.js';

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
