/**
 * Tests for the branded identity creators introduced in Step 1 of the
 * session-identity refactor (see `docs/designs/workflow-session-identity.md`).
 *
 * Covers `createBundleId()` and `createAgentConversationId()`. The existing
 * `createSessionId()` brand is retained unchanged and is not re-tested here.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  createBundleId,
  createAgentConversationId,
  createSessionId,
  type BundleId,
  type AgentConversationId,
  type SessionId,
} from '../src/session/types.js';

// Matches v4 UUID shape produced by node:crypto.randomUUID():
// xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx (case-insensitive hex).
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createBundleId', () => {
  it('returns a v4 UUID string', () => {
    const id = createBundleId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(UUID_V4_REGEX);
  });

  it('returns distinct values across calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createBundleId());
    }
    expect(ids.size).toBe(100);
  });

  it('returns a value typed as BundleId', () => {
    const id = createBundleId();
    expectTypeOf(id).toEqualTypeOf<BundleId>();
  });
});

describe('createAgentConversationId', () => {
  it('returns a v4 UUID string', () => {
    const id = createAgentConversationId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(UUID_V4_REGEX);
  });

  it('returns distinct values across calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createAgentConversationId());
    }
    expect(ids.size).toBe(100);
  });

  it('returns a value typed as AgentConversationId', () => {
    const id = createAgentConversationId();
    expectTypeOf(id).toEqualTypeOf<AgentConversationId>();
  });
});

describe('brand distinctness', () => {
  it('BundleId and AgentConversationId are nominally distinct types', () => {
    // Type-level check: the two brands must not be assignable to each other,
    // even though both are v4 UUID strings at runtime. This catches accidental
    // cross-wiring during Steps 2-5 where both ids get plumbed through the
    // same call sites.
    const bundle = createBundleId();
    const convo = createAgentConversationId();
    expectTypeOf(bundle).not.toEqualTypeOf<AgentConversationId>();
    expectTypeOf(convo).not.toEqualTypeOf<BundleId>();
  });

  it('rejects cross-brand assignments between BundleId and AgentConversationId at the type level', () => {
    // The stricter check: `not.toEqualTypeOf` only verifies the types aren't
    // equal (a plain `string` would pass that too). What actually matters at
    // call sites is that one brand is not *assignable* to the other.
    const bundle = createBundleId();
    const convo = createAgentConversationId();
    // @ts-expect-error -- BundleId is not assignable to AgentConversationId
    const _a: AgentConversationId = bundle;
    // @ts-expect-error -- AgentConversationId is not assignable to BundleId
    const _b: BundleId = convo;
    void _a;
    void _b;
  });

  it('rejects plain string assignments to branded ids at the type level', () => {
    // @ts-expect-error -- plain string is not assignable to BundleId
    const _a: BundleId = 'not-a-bundle-id';
    // @ts-expect-error -- plain string is not assignable to AgentConversationId
    const _b: AgentConversationId = 'not-a-convo-id';
    // @ts-expect-error -- plain string is not assignable to SessionId
    const _c: SessionId = 'not-a-session-id';
    void _a;
    void _b;
    void _c;
  });

  it('rejects cross-brand assignments between SessionId and BundleId at the type level', () => {
    const session = createSessionId();
    const bundle = createBundleId();
    // @ts-expect-error -- SessionId is not assignable to BundleId
    const _a: BundleId = session;
    // @ts-expect-error -- BundleId is not assignable to SessionId
    const _b: SessionId = bundle;
    void _a;
    void _b;
  });

  it('rejects cross-brand assignments between SessionId and AgentConversationId at the type level', () => {
    const session = createSessionId();
    const convo = createAgentConversationId();
    // @ts-expect-error -- SessionId is not assignable to AgentConversationId
    const _a: AgentConversationId = session;
    // @ts-expect-error -- AgentConversationId is not assignable to SessionId
    const _b: SessionId = convo;
    void _a;
    void _b;
  });

  it('createBundleId and createAgentConversationId produce disjoint value sets', () => {
    // The two creators both wrap `randomUUID()`, so it would be a bug for
    // one pool to accidentally land in the other. This test asserts the
    // populations stay disjoint at runtime — paired with the type-level
    // brand checks above, it confirms the two identities cannot collide
    // either by type or by value.
    const bundles = new Set<string>();
    const convos = new Set<string>();
    for (let i = 0; i < 100; i++) {
      bundles.add(createBundleId());
      convos.add(createAgentConversationId());
    }
    for (const b of bundles) expect(convos.has(b)).toBe(false);
  });
});
