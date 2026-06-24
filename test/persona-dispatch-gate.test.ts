/**
 * Phase 1b dispatch-gate test: personas.compileStream returns
 * POLICY_MUTATION_FORBIDDEN unless ctx.allowPolicyMutation === true, and the
 * ungated read methods (getCompile/listCompiles) work without the gate.
 */

import { describe, it, expect } from 'vitest';
import { personaDispatch } from '../src/web-ui/dispatch/persona-dispatch.js';
import { RpcError } from '../src/web-ui/web-ui-types.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';

function makeCtx(allowPolicyMutation: boolean | undefined): WorkflowDispatchContext {
  // Only the fields persona-dispatch touches are populated; the rest are unused
  // for these methods.
  return {
    eventBus: new WebEventBus(),
    allowPolicyMutation,
  } as unknown as WorkflowDispatchContext;
}

describe('personas.compileStream gate', () => {
  it('returns POLICY_MUTATION_FORBIDDEN when allowPolicyMutation is false/undefined', async () => {
    for (const flag of [undefined, false]) {
      const ctx = makeCtx(flag);
      await expect(personaDispatch(ctx, 'personas.compileStream', { name: 'whatever' })).rejects.toMatchObject({
        code: 'POLICY_MUTATION_FORBIDDEN',
      });
    }
  });

  it('does NOT throw POLICY_MUTATION_FORBIDDEN when allowPolicyMutation is true (fails later on persona lookup)', async () => {
    const ctx = makeCtx(true);
    // The gate passes; the persona does not exist, so it fails with a DIFFERENT
    // typed error (PERSONA_NOT_FOUND), proving the gate was not the rejecter.
    try {
      await personaDispatch(ctx, 'personas.compileStream', { name: 'no-such-persona' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).not.toBe('POLICY_MUTATION_FORBIDDEN');
    }
  });
});

describe('ungated read methods', () => {
  it('personas.listCompiles works without the gate and returns the active/recent/queueDepth shape', async () => {
    const ctx = makeCtx(undefined);
    const result = (await personaDispatch(ctx, 'personas.listCompiles', {})) as {
      active: unknown[];
      recent: unknown[];
      queueDepth: number;
    };
    expect(Array.isArray(result.active)).toBe(true);
    expect(Array.isArray(result.recent)).toBe(true);
    expect(typeof result.queueDepth).toBe('number');
  });

  it('personas.getCompile throws PERSONA_NOT_FOUND for an unknown operationId (ungated)', async () => {
    const ctx = makeCtx(undefined);
    await expect(personaDispatch(ctx, 'personas.getCompile', { operationId: 'nope' })).rejects.toMatchObject({
      code: 'PERSONA_NOT_FOUND',
    });
  });
});
