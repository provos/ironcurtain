/**
 * Unit tests for `config.*` dispatch (config-dispatch.ts).
 *
 * Covers the §12.6 wire contract for `config.getModelProviders` /
 * `config.setModelProviders`: masking, the POLICY_MUTATION_FORBIDDEN gate, the
 * per-profile M5 mask-unchanged/clear/set round-trip, the F7 `native`-key
 * accept-and-drop / reject-other asymmetry, F10 delete-repoints-default, the
 * validation-passthrough rejection (bad `default`), and `config.changed`.
 *
 * Config IO is isolated via a temp `IRONCURTAIN_HOME` (mirroring
 * test/user-config.test.ts) so nothing touches the real ~/.ironcurtain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { configDispatch } from '../dispatch/config-dispatch.js';
import type { WorkflowDispatchContext } from '../dispatch/workflow-dispatch.js';
import { WebEventBus } from '../web-event-bus.js';
import { RpcError, type GetModelProvidersDto } from '../web-ui-types.js';
import { loadUserConfig } from '../../config/user-config.js';

// Env vars that affect config loading; save/restore between tests.
const ENV_VARS_TO_ISOLATE = ['IRONCURTAIN_HOME', 'OPENROUTER_API_KEY'] as const;

let testHome: string;
const savedEnv: Record<string, string | undefined> = {};

function configPath(): string {
  return resolve(testHome, 'config.json');
}

/** Writes a raw config.json into the isolated home. */
function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** Reads the raw on-disk config.json (throws if absent). */
function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
}

/** A minimal dispatch context — only eventBus + allowPolicyMutation are used. */
function makeCtx(allowPolicyMutation: boolean): WorkflowDispatchContext {
  return {
    eventBus: new WebEventBus(),
    allowPolicyMutation,
  } as unknown as WorkflowDispatchContext;
}

async function get(ctx: WorkflowDispatchContext): Promise<GetModelProvidersDto> {
  return (await configDispatch(ctx, 'config.getModelProviders', {})) as GetModelProvidersDto;
}

async function set(ctx: WorkflowDispatchContext, params: Record<string, unknown>): Promise<GetModelProvidersDto> {
  return (await configDispatch(ctx, 'config.setModelProviders', params)) as GetModelProvidersDto;
}

const SK_GLM = 'sk-or-v1-glmkeyREDACTED0000000000end';
const SK_KIMI = 'sk-or-v1-kimikeyREDACTED000000000end';
const MASK_GLM = 'sk-...end';

beforeEach(() => {
  testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-config-dispatch-'));
  for (const key of ENV_VARS_TO_ISOLATE) {
    savedEnv[key] = process.env[key];
    Reflect.deleteProperty(process.env, key);
  }
  process.env.IRONCURTAIN_HOME = testHome;
});

afterEach(() => {
  for (const key of ENV_VARS_TO_ISOLATE) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else Reflect.deleteProperty(process.env, key);
  }
  rmSync(testHome, { recursive: true, force: true });
});

describe('config.getModelProviders', () => {
  it('returns native-only registry when modelProviders is absent', async () => {
    writeConfig({ preferredMode: 'container' });
    const dto = await get(makeCtx(false));
    expect(dto.default).toBe('native');
    expect(dto.profiles.native).toEqual({ type: 'native' });
    expect(Object.keys(dto.profiles)).toEqual(['native']);
  });

  it('masks every openrouter profile key; native present and key-less', async () => {
    writeConfig({
      modelProviders: {
        default: 'glm',
        profiles: {
          glm: { type: 'openrouter', apiKey: SK_GLM },
          kimi: { type: 'openrouter', apiKey: SK_KIMI },
        },
      },
    });
    const dto = await get(makeCtx(false));

    expect(dto.default).toBe('glm');
    // native is always present and carries no key.
    expect(dto.profiles.native).toEqual({ type: 'native' });

    const glm = dto.profiles.glm;
    const kimi = dto.profiles.kimi;
    expect(glm.type).toBe('openrouter');
    expect(kimi.type).toBe('openrouter');
    if (glm.type !== 'openrouter' || kimi.type !== 'openrouter') throw new Error('unreachable');
    expect(glm.apiKey).toBe(MASK_GLM);
    expect(kimi.apiKey).toBe('sk-...end');
    // The masks never leak the raw key.
    expect(glm.apiKey).not.toContain('glmkey');
    expect(kimi.apiKey).not.toContain('kimikey');
  });

  it('reports "none" for a profile that shares the env key only (no config apiKey)', async () => {
    writeConfig({
      modelProviders: { profiles: { kimi: { type: 'openrouter' } } },
    });
    const dto = await get(makeCtx(false));
    const kimi = dto.profiles.kimi;
    if (kimi.type !== 'openrouter') throw new Error('unreachable');
    expect(kimi.apiKey).toBe('none');
  });

  it('surfaces resolved defaults (perAgent/sessionAffinity) and OMITS modelMap for a minimal profile', async () => {
    writeConfig({
      modelProviders: { profiles: { glm: { type: 'openrouter', apiKey: SK_GLM } } },
    });
    const dto = await get(makeCtx(false));
    const glm = dto.profiles.glm;
    if (glm.type !== 'openrouter') throw new Error('unreachable');
    // A default-tracking profile OMITS modelMap so the "track defaults" intent
    // survives a set-back round-trip (rather than materializing DEFAULT_MODEL_MAP).
    expect(glm.modelMap).toBeUndefined();
    expect(glm.sessionAffinity).toBe(true);
    expect(glm.perAgent).toBeDefined();
  });

  it('includes modelMap for a profile with an explicit non-empty map', async () => {
    writeConfig({
      modelProviders: {
        profiles: {
          glm: { type: 'openrouter', apiKey: SK_GLM, modelMap: [{ match: '*', model: 'z-ai/glm-5.2' }] },
        },
      },
    });
    const dto = await get(makeCtx(false));
    const glm = dto.profiles.glm;
    if (glm.type !== 'openrouter') throw new Error('unreachable');
    expect(glm.modelMap).toEqual([{ match: '*', model: 'z-ai/glm-5.2' }]);
  });

  it('includes an explicit empty modelMap (per-agent-only mode, distinct from default-tracking)', async () => {
    writeConfig({
      modelProviders: { profiles: { glm: { type: 'openrouter', apiKey: SK_GLM, modelMap: [] } } },
    });
    const dto = await get(makeCtx(false));
    const glm = dto.profiles.glm;
    if (glm.type !== 'openrouter') throw new Error('unreachable');
    expect(glm.modelMap).toEqual([]);
  });
});

describe('config.setModelProviders — gate', () => {
  it('returns POLICY_MUTATION_FORBIDDEN when allowPolicyMutation is false', async () => {
    writeConfig({});
    await expect(
      set(makeCtx(false), { profiles: { glm: { type: 'openrouter', apiKey: SK_GLM } } }),
    ).rejects.toMatchObject({ code: 'POLICY_MUTATION_FORBIDDEN' });
    // Nothing was written.
    expect(readConfig().modelProviders).toBeUndefined();
  });

  it('persists the whole section and emits config.changed when the gate is on', async () => {
    writeConfig({});
    const ctx = makeCtx(true);
    const emitSpy = vi.spyOn(ctx.eventBus, 'emit');

    const result = await set(ctx, {
      default: 'glm',
      profiles: { glm: { type: 'openrouter', apiKey: SK_GLM } },
    });

    expect(emitSpy).toHaveBeenCalledWith('config.changed', {});
    expect(result.default).toBe('glm');
    // Persisted with the real key on disk (masked over the wire).
    const onDisk = readConfig().modelProviders as { default: string; profiles: Record<string, { apiKey?: string }> };
    expect(onDisk.default).toBe('glm');
    expect(onDisk.profiles.glm.apiKey).toBe(SK_GLM);
    // The get response never returns the raw key.
    const glm = result.profiles.glm;
    if (glm.type !== 'openrouter') throw new Error('unreachable');
    expect(glm.apiKey).toBe(MASK_GLM);
  });
});

describe('config.setModelProviders — M5 per-profile apiKey', () => {
  function seedTwoProfiles(): void {
    writeConfig({
      modelProviders: {
        default: 'glm',
        profiles: {
          glm: { type: 'openrouter', apiKey: SK_GLM },
          kimi: { type: 'openrouter', apiKey: SK_KIMI },
        },
      },
    });
  }

  it('round-trip: set-back the masked DTO verbatim preserves every stored key', async () => {
    seedTwoProfiles();
    const ctx = makeCtx(true);

    // get (masked) -> set-back verbatim (including the native echo, F7).
    const gotten = await get(ctx);
    await set(ctx, { default: gotten.default, profiles: gotten.profiles });

    const onDisk = readConfig().modelProviders as { profiles: Record<string, { apiKey?: string }> };
    expect(onDisk.profiles.glm.apiKey).toBe(SK_GLM);
    expect(onDisk.profiles.kimi.apiKey).toBe(SK_KIMI);
    // native is NOT persisted (always implicit).
    expect(onDisk.profiles.native).toBeUndefined();
    // A subsequent load does not throw.
    expect(() => loadUserConfig({ readOnly: true })).not.toThrow();
  });

  it('empty string clears a profile key; a new string sets it', async () => {
    seedTwoProfiles();
    const ctx = makeCtx(true);

    await set(ctx, {
      default: 'glm',
      profiles: {
        glm: { type: 'openrouter', apiKey: '' }, // clear
        kimi: { type: 'openrouter', apiKey: 'sk-or-v1-BRANDNEWkey0000000000000new' }, // set
      },
    });

    const onDisk = readConfig().modelProviders as { profiles: Record<string, { apiKey?: string }> };
    // Cleared: apiKey omitted from the persisted profile.
    expect(onDisk.profiles.glm.apiKey).toBeUndefined();
    expect(onDisk.profiles.kimi.apiKey).toBe('sk-or-v1-BRANDNEWkey0000000000000new');
  });

  it('absent apiKey keeps the stored key; null keeps it too', async () => {
    seedTwoProfiles();
    const ctx = makeCtx(true);
    await set(ctx, {
      default: 'glm',
      profiles: {
        glm: { type: 'openrouter' }, // apiKey absent -> keep
        kimi: { type: 'openrouter', apiKey: null }, // null -> keep
      },
    });
    const onDisk = readConfig().modelProviders as { profiles: Record<string, { apiKey?: string }> };
    expect(onDisk.profiles.glm.apiKey).toBe(SK_GLM);
    expect(onDisk.profiles.kimi.apiKey).toBe(SK_KIMI);
  });

  it('drops a profile omitted from the request (whole-record replace)', async () => {
    seedTwoProfiles();
    const ctx = makeCtx(true);
    await set(ctx, {
      default: 'glm',
      profiles: { glm: { type: 'openrouter', apiKey: MASK_GLM } }, // kimi omitted
    });
    const onDisk = readConfig().modelProviders as { profiles: Record<string, unknown> };
    expect(onDisk.profiles.glm).toBeDefined();
    expect(onDisk.profiles.kimi).toBeUndefined();
    // glm key preserved (mask-equal).
    const glm = onDisk.profiles.glm as { apiKey?: string };
    expect(glm.apiKey).toBe(SK_GLM);
  });
});

describe('config.setModelProviders — default-map preservation (round-trip)', () => {
  it('a default-tracking profile stays default-tracking after a GET/SET round-trip', async () => {
    // On-disk profile OMITS modelMap => it tracks DEFAULT_MODEL_MAP.
    writeConfig({
      modelProviders: { profiles: { glm: { type: 'openrouter', apiKey: SK_GLM } } },
    });
    const ctx = makeCtx(true);

    // GET returns the profile with modelMap OMITTED...
    const gotten = await get(ctx);
    const gotGlm = gotten.profiles.glm;
    if (gotGlm.type !== 'openrouter') throw new Error('unreachable');
    expect(gotGlm.modelMap).toBeUndefined();

    // ...and setting it back verbatim must NOT materialize DEFAULT_MODEL_MAP.
    await set(ctx, { default: gotten.default, profiles: gotten.profiles });

    const onDisk = readConfig().modelProviders as { profiles: Record<string, { modelMap?: unknown }> };
    expect(onDisk.profiles.glm.modelMap).toBeUndefined();
  });

  it('an explicit empty modelMap is preserved (not dropped) across a round-trip', async () => {
    writeConfig({
      modelProviders: { profiles: { glm: { type: 'openrouter', apiKey: SK_GLM, modelMap: [] } } },
    });
    const ctx = makeCtx(true);

    const gotten = await get(ctx);
    await set(ctx, { default: gotten.default, profiles: gotten.profiles });

    const onDisk = readConfig().modelProviders as { profiles: Record<string, { modelMap?: unknown }> };
    expect(onDisk.profiles.glm.modelMap).toEqual([]);
  });
});

describe('config.setModelProviders — F7 native-key asymmetry', () => {
  it('accepts-and-drops a verbatim { type: "native" } under profiles.native', async () => {
    writeConfig({ modelProviders: { profiles: { glm: { type: 'openrouter', apiKey: SK_GLM } } } });
    const ctx = makeCtx(true);
    // Set-back a get response verbatim (which includes native) — must not throw.
    const gotten = await get(ctx);
    await expect(set(ctx, { default: gotten.default, profiles: gotten.profiles })).resolves.toBeDefined();
    const onDisk = readConfig().modelProviders as { profiles: Record<string, unknown> };
    expect(onDisk.profiles.native).toBeUndefined();
  });

  it('rejects any non-native value under the native key', async () => {
    writeConfig({});
    const ctx = makeCtx(true);
    await expect(set(ctx, { profiles: { native: { type: 'openrouter', apiKey: SK_GLM } } })).rejects.toBeInstanceOf(
      RpcError,
    );
  });
});

describe('config.setModelProviders — F10 delete-repoints-default', () => {
  it('re-points default to native when the request drops the current default profile', async () => {
    writeConfig({
      modelProviders: {
        default: 'glm',
        profiles: {
          glm: { type: 'openrouter', apiKey: SK_GLM },
          kimi: { type: 'openrouter', apiKey: SK_KIMI },
        },
      },
    });
    const ctx = makeCtx(true);

    // Delete glm (the current default) by omitting it; send default: 'glm' as
    // the naive frontend would after removing it from the local list. Backend
    // must re-point to native rather than persist a dangling default.
    const result = await set(ctx, {
      default: 'glm',
      profiles: { kimi: { type: 'openrouter', apiKey: 'sk-...end' } },
    });

    const onDisk = readConfig().modelProviders as { default?: string; profiles: Record<string, unknown> };
    expect(onDisk.default).toBe('native');
    expect(onDisk.profiles.glm).toBeUndefined();
    expect(onDisk.profiles.kimi).toBeDefined();
    expect(result.default).toBe('native');
    // The next load does not throw (no dangling default).
    expect(() => loadUserConfig({ readOnly: true })).not.toThrow();
  });

  it('re-points to native when the request DROPS the current default and OMITS default entirely', async () => {
    writeConfig({
      modelProviders: {
        default: 'glm',
        profiles: {
          glm: { type: 'openrouter', apiKey: SK_GLM },
          kimi: { type: 'openrouter', apiKey: SK_KIMI },
        },
      },
    });
    const ctx = makeCtx(true);

    // A raw client deletes glm (the current default) WITHOUT resending `default`.
    // The shallow merge would preserve the stale `default: 'glm'` and dangle it;
    // the backend must auto-repoint to native rather than reject the write.
    const result = await set(ctx, { profiles: { kimi: { type: 'openrouter', apiKey: 'sk-...end' } } });

    const onDisk = readConfig().modelProviders as { default?: string; profiles: Record<string, unknown> };
    expect(onDisk.default).toBe('native');
    expect(onDisk.profiles.glm).toBeUndefined();
    expect(result.default).toBe('native');
    expect(() => loadUserConfig({ readOnly: true })).not.toThrow();
  });

  it('leaves the stored default untouched when default is omitted and its profile survives', async () => {
    writeConfig({
      modelProviders: {
        default: 'glm',
        profiles: {
          glm: { type: 'openrouter', apiKey: SK_GLM },
          kimi: { type: 'openrouter', apiKey: SK_KIMI },
        },
      },
    });
    const ctx = makeCtx(true);

    // Omit `default`; glm (the stored default) is still present, so preservation
    // is correct — the fix must not gratuitously rewrite the default.
    const result = await set(ctx, {
      profiles: { glm: { type: 'openrouter', apiKey: 'sk-...glm' }, kimi: { type: 'openrouter', apiKey: 'sk-...end' } },
    });

    expect(result.default).toBe('glm');
    expect((readConfig().modelProviders as { default?: string }).default).toBe('glm');
  });
});

describe('config.setModelProviders — validation passthrough', () => {
  it('rejects a request whose default names a profile that never existed (bad default)', async () => {
    // 'ghost' is neither in the request nor in the stored config, so it is NOT
    // a delete-repoint case — the request itself set a bad default. The backend
    // leaves it dangling so the Zod .refine in saveUserConfig rejects it.
    writeConfig({});
    const ctx = makeCtx(true);
    await expect(
      set(ctx, { default: 'ghost', profiles: { real: { type: 'openrouter', apiKey: SK_GLM } } }),
    ).rejects.toBeInstanceOf(RpcError);
    // Nothing was persisted.
    expect(readConfig().modelProviders).toBeUndefined();
  });
});

describe('config dispatch — routing', () => {
  it('throws MethodNotFoundError for an unknown config method', async () => {
    writeConfig({});
    await expect(configDispatch(makeCtx(false), 'config.bogus', {})).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND',
    });
  });
});
