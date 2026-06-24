/**
 * Phase 1c persona-CRUD dispatch tests.
 *
 * Verifies: (1) ALL mutation methods (create/editConstitution/setMemory/delete/
 * setBroadPolicyOptIn AND the 1b compileStream) return POLICY_MUTATION_FORBIDDEN
 * when the kill switch is off; (2) the gate fires BEFORE any fs read; (3) the
 * happy paths work with the gate on, emit personas.changed, and route service
 * errors to typed RpcErrors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { personaDispatch } from '../src/web-ui/dispatch/persona-dispatch.js';
import { RpcError, type PersonaDetailDto, type PersonaEditResultDto } from '../src/web-ui/web-ui-types.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { createPersona } from '../src/persona/persona-service.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-crud-dispatch-test-${process.pid}`);

function makeCtx(allowPolicyMutation: boolean | undefined): {
  ctx: WorkflowDispatchContext;
  events: Array<{ name: string; payload: unknown }>;
} {
  const bus = new WebEventBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.subscribe((name, payload) => events.push({ name, payload }));
  const ctx = { eventBus: bus, allowPolicyMutation } as unknown as WorkflowDispatchContext;
  return { ctx, events };
}

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

const MUTATION_CALLS: Array<{ method: string; params: Record<string, unknown> }> = [
  { method: 'personas.create', params: { name: 'x', description: 'd' } },
  { method: 'personas.editConstitution', params: { name: 'x', constitution: 'c' } },
  { method: 'personas.setMemory', params: { name: 'x', enabled: false } },
  { method: 'personas.delete', params: { name: 'x', confirmed: true } },
  { method: 'personas.setBroadPolicyOptIn', params: { name: 'x', enabled: true } },
  { method: 'personas.compileStream', params: { name: 'x' } },
];

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});
afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('kill switch (allowPolicyMutation) gating', () => {
  for (const flag of [undefined, false] as const) {
    for (const { method, params } of MUTATION_CALLS) {
      it(`${method} returns POLICY_MUTATION_FORBIDDEN when flag is ${String(flag)}`, async () => {
        const { ctx } = makeCtx(flag);
        await expect(personaDispatch(ctx, method, params)).rejects.toMatchObject({
          code: 'POLICY_MUTATION_FORBIDDEN',
        });
      });
    }
  }

  it('the gate fires before any fs read (forbidden even for an existing persona)', async () => {
    createPersona({ name: 'existing', description: 'd' }, 'cli');
    const { ctx } = makeCtx(false);
    await expect(
      personaDispatch(ctx, 'personas.setMemory', { name: 'existing', enabled: false }),
    ).rejects.toMatchObject({ code: 'POLICY_MUTATION_FORBIDDEN' });
  });

  // The legacy blocking `personas.compile` method was an UNGATED, UNVALIDATED
  // second compile path (it bypassed both the kill switch and the broad-policy
  // validator). It was removed in Phase 1c; compileStream is the single gated +
  // validated compile surface. Guard against its reintroduction.
  it('personas.compile no longer exists (removed: it was an ungated/unvalidated compile path)', async () => {
    const { ctx } = makeCtx(true); // even with the kill switch ON
    await expect(personaDispatch(ctx, 'personas.compile', { name: 'x' })).rejects.toMatchObject({
      code: 'METHOD_NOT_FOUND',
    });
  });
});

describe('CRUD happy paths (gate on)', () => {
  it('personas.create creates the persona, returns the detail DTO, and emits personas.changed', async () => {
    const { ctx, events } = makeCtx(true);
    const detail = (await personaDispatch(ctx, 'personas.create', {
      name: 'coder',
      description: 'Build',
    })) as PersonaDetailDto;
    expect(detail.name).toBe('coder');
    expect(detail.allowBroadPolicy).toBe(false);
    expect(existsSync(personaDir('coder'))).toBe(true);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
  });

  it('personas.create on a duplicate returns PERSONA_EXISTS', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'dup', description: 'd' });
    await expect(personaDispatch(ctx, 'personas.create', { name: 'dup', description: 'd' })).rejects.toMatchObject({
      code: 'PERSONA_EXISTS',
    });
  });

  it('personas.create with an invalid slug returns INVALID_PARAMS', async () => {
    const { ctx } = makeCtx(true);
    await expect(
      personaDispatch(ctx, 'personas.create', { name: 'Not Valid', description: 'd' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('personas.editConstitution returns { stale } and emits personas.changed', async () => {
    const { ctx, events } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const result = (await personaDispatch(ctx, 'personas.editConstitution', {
      name: 'p',
      constitution: 'new rules',
    })) as PersonaEditResultDto;
    expect(result.stale).toBe(true); // no compiled policy yet
    expect(events.filter((e) => e.name === 'personas.changed').length).toBeGreaterThanOrEqual(2);
  });

  it('personas.editConstitution on a missing persona returns PERSONA_NOT_FOUND', async () => {
    const { ctx } = makeCtx(true);
    await expect(
      personaDispatch(ctx, 'personas.editConstitution', { name: 'missing', constitution: 'c' }),
    ).rejects.toMatchObject({ code: 'PERSONA_NOT_FOUND' });
  });

  it('personas.setMemory returns the updated detail DTO', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const detail = (await personaDispatch(ctx, 'personas.setMemory', {
      name: 'p',
      enabled: false,
    })) as PersonaDetailDto;
    expect(detail.memory).toBe(false);
  });

  it('personas.delete soft-deletes by default and returns { deleted: true }', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const result = await personaDispatch(ctx, 'personas.delete', { name: 'p', confirmed: true });
    expect(result).toEqual({ deleted: true });
    expect(existsSync(personaDir('p'))).toBe(false);
    // Soft: present in trash.
    expect(existsSync(resolve(TEST_HOME, '.persona-trash'))).toBe(true);
  });

  it('personas.delete with force:true hard-deletes (no trash)', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    await personaDispatch(ctx, 'personas.delete', { name: 'p', confirmed: true, force: true });
    expect(existsSync(personaDir('p'))).toBe(false);
    const trash = resolve(TEST_HOME, '.persona-trash');
    expect(existsSync(trash)).toBe(false);
  });

  it('personas.delete without confirmed:true is INVALID_PARAMS', async () => {
    const { ctx } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    await expect(personaDispatch(ctx, 'personas.delete', { name: 'p' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('personas.setBroadPolicyOptIn flips allowBroadPolicy and emits personas.changed', async () => {
    const { ctx, events } = makeCtx(true);
    await personaDispatch(ctx, 'personas.create', { name: 'p', description: 'd' });
    const detail = (await personaDispatch(ctx, 'personas.setBroadPolicyOptIn', {
      name: 'p',
      enabled: true,
    })) as PersonaDetailDto;
    expect(detail.allowBroadPolicy).toBe(true);
    expect(events.some((e) => e.name === 'personas.changed')).toBe(true);
  });

  it('routes unknown methods to METHOD_NOT_FOUND', async () => {
    const { ctx } = makeCtx(true);
    await expect(personaDispatch(ctx, 'personas.bogus', {})).rejects.toBeInstanceOf(RpcError);
  });
});
