# Declarative Guard Conditions (`when` field)

## Problem

Workflow definitions use string guard names (`"guard": "isApproved"`) to route transitions based on agent output. Each new routing condition requires a new guard function in `guards.ts`, a registry entry in `REGISTERED_GUARDS`, and an adapter in the machine builder's XState guard wrapper. Most guards are trivial field-equality checks against `AgentOutput` (e.g., `isApproved` is `output.verdict === 'approved'`; `isRejected` is `output.verdict === 'rejected'`). This is boilerplate that scales linearly with the number of distinct checks workflow authors need.

## Solution

Add an optional `when` field to `AgentTransitionDefinition`. It is a record mapping `AgentOutput` field names to expected values. All entries must match (AND semantics) for the transition to fire. First matching transition wins, preserving existing evaluation order.

```json
{
  "to": "done",
  "when": { "verdict": "approved", "confidence": "high" }
}
```

This replaces the need for `isApproved`, `isRejected`, and `isLowConfidence` in new workflows. Guards that inspect `WorkflowContext` (like `isRoundLimitReached`) or require special logic (like `isStalled`) cannot be expressed as `when` and remain as registered guards.

`when` and `guard` are mutually exclusive on a single transition. A transition may have neither (unconditional fallthrough), but not both.

## Type changes

In `src/workflow/types.ts`, extend `AgentTransitionDefinition`:

```typescript
/** Allowed value types in a `when` clause. Matches AgentOutput field types. */
export type WhenValue = string | number | boolean | null;

/** Per-key typed when clause: keys must be AgentOutput fields,
 *  values must match each field's type. */
export type WhenClause = { readonly [K in keyof AgentOutput]?: AgentOutput[K] };

export interface AgentTransitionDefinition {
  readonly to: string;
  /**
   * Registered guard name. Mutually exclusive with `when`.
   */
  readonly guard?: string;
  /**
   * Declarative field-match condition on AgentOutput.
   * All entries must match (AND semantics).
   * Mutually exclusive with `guard`.
   */
  readonly when?: WhenClause;
  /** If truthy, sets flaggedForReview in context. */
  readonly flag?: string;
}
```

`WhenClause` uses a mapped type rather than a plain `Record<string, WhenValue>` so that TypeScript callers get compile-time validation of both keys (must be in `keyof AgentOutput`) and values (must match each field's declared type — e.g. `completed` must be `boolean`, `verdict` must be a valid `Verdict` literal). `WhenValue` is kept as a separate exported type for the runtime guard code in `machine-builder.ts`, which iterates with `Object.entries` and therefore needs a flat value union.

The `WhenValue` type covers every `AgentOutput` field type: `string` for `verdict`/`confidence`/`escalation`/`notes`, `number` for `testCount`, `boolean` for `completed`, and `null` for nullable fields.

## Validation changes

### Zod schema (`validate.ts`)

Extend `agentTransitionSchema`:

```typescript
const whenValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const agentTransitionSchema = z.object({
  to: z.string(),
  guard: z.string().optional(),
  when: z.record(z.string(), whenValueSchema).optional(),
  flag: z.string().optional(),
});
```

### Semantic validation (`validateSemantics`)

Five new checks, all added to the existing `validateSemantics` function:

**1. Mutual exclusivity** -- A transition must not have both `guard` and `when`:

```typescript
// Inside the per-state loop, for agent/deterministic states:
for (const t of state.transitions) {
  if (t.guard && t.when) {
    issues.push(
      `State "${stateId}" has transition to "${t.to}" with both "guard" and "when" — they are mutually exclusive`
    );
  }
}
```

**2. Agent-only scope** -- `when` is rejected on `deterministic` state transitions:

```typescript
if (state.type === 'deterministic') {
  for (const t of state.transitions) {
    if (t.when) {
      issues.push(
        `State "${stateId}" is deterministic and cannot use "when" (agent output not available)`
      );
    }
  }
}
```

Rationale: Deterministic states resolve as `DeterministicInvokeResult` (with `passed`, `testCount`, `errors`), not `AgentOutput`. The `when` field matches against `AgentOutput` fields and would silently fail to match anything on deterministic results. Note that `HumanGateTransitionDefinition` is a separate type that doesn't have a `when` field, so human gates are excluded by the type system.

**3. Key validation** -- `when` keys must be valid `AgentOutput` field names:

```typescript
const AGENT_OUTPUT_FIELDS: ReadonlySet<string> = new Set([
  'completed', 'verdict', 'confidence', 'escalation', 'testCount', 'notes',
]);

// Inside the when-checking loop:
if (t.when) {
  for (const key of Object.keys(t.when)) {
    if (!AGENT_OUTPUT_FIELDS.has(key)) {
      issues.push(
        `State "${stateId}" transition to "${t.to}" has "when" key "${key}" — not a valid AgentOutput field`
      );
    }
  }
}
```

**4. Enum value validation** -- Values for `verdict` and `confidence` are checked against their literal union types:

```typescript
const VERDICT_VALUES: ReadonlySet<string> = new Set([
  'approved', 'rejected', 'blocked', 'spec_flaw',
]);
const CONFIDENCE_VALUES: ReadonlySet<string> = new Set([
  'high', 'medium', 'low',
]);

// Inside the when-checking loop (after key validation):
if (key === 'verdict' && typeof value === 'string' && !VERDICT_VALUES.has(value)) {
  issues.push(
    `State "${stateId}" transition to "${t.to}" has invalid verdict value "${value}"`
  );
}
if (key === 'confidence' && typeof value === 'string' && !CONFIDENCE_VALUES.has(value)) {
  issues.push(
    `State "${stateId}" transition to "${t.to}" has invalid confidence value "${value}"`
  );
}
```

This catches typos like `"aproved"` at definition load time.

**5. Empty `when` rejected** -- `when: {}` is always a mistake (use no guard for unconditional transitions):

```typescript
if (t.when && Object.keys(t.when).length === 0) {
  issues.push(
    `State "${stateId}" transition to "${t.to}" has empty "when" — use no guard for unconditional transitions`
  );
}
```

### Updated guard name collection

The existing `collectGuardNames` function (used for REGISTERED_GUARDS validation) does not need changes because `when`-based transitions have no `guard` field.

## Machine builder changes

### The `__matchesWhen` parameterized guard

Register a single parameterized guard in `buildWorkflowMachine`. XState v5 parameterized guards receive the `params` object declared at the transition site.

```typescript
// Add to the xstateGuards record:
xstateGuards['__matchesWhen'] = ({
  context,
  event,
}: {
  context: WorkflowContext;
  event: unknown;
}, params: { when: Record<string, WhenValue> }) => {
  // Reuse the same event-unwrapping logic as the existing guard adapter
  const doneEvent = event as { type: string; output?: unknown };
  let agentOutput: AgentOutput | undefined;

  if (doneEvent.type.startsWith('xstate.done.actor.')) {
    const result = extractInvokeResult(doneEvent as { output?: unknown });
    if (result) {
      agentOutput = result.output;
    }
  }

  if (!agentOutput) return false;

  // AND semantics: every key-value pair must match
  for (const [key, expected] of Object.entries(params.when)) {
    const actual = agentOutput[key as keyof AgentOutput];
    if (actual !== expected) return false;
  }
  return true;
};
```

The guard adapter that wraps existing guards (lines 280-317 of `machine-builder.ts`) already handles extracting `AgentOutput` from `xstate.done.actor.*` events. The `__matchesWhen` guard follows the same pattern but receives its matching criteria from `params` instead of being hardcoded.

> **Note:** `__matchesWhen` intentionally bypasses the guard adapter loop. The adapter loop iterates over `REGISTERED_GUARDS` and wraps each one so it receives the `AgentOutput` extracted from a `WorkflowEvent`. `__matchesWhen` does not go through that loop because it operates on `AgentOutput` directly (via `extractInvokeResult` inline) rather than on `WorkflowEvent`. This is deliberate -- do not refactor it into the adapter loop without understanding the distinction.

### Transition wiring in `buildAgentOnDoneTransitions`

Change `buildAgentOnDoneTransitions` to emit a parameterized guard reference when `when` is present:

```typescript
function buildAgentOnDoneTransitions(transitions: readonly AgentTransitionDefinition[]): readonly object[] {
  return transitions.map((t) => {
    let guard: string | { type: string; params: { when: Record<string, WhenValue> } } | undefined;
    if (t.when) {
      guard = { type: '__matchesWhen', params: { when: t.when } };
    } else if (t.guard) {
      guard = t.guard;
    }

    return {
      target: t.to,
      ...(guard ? { guard } : {}),
      actions: ['updateContextFromAgentResult', ...(t.flag ? ['setFlag'] : [])],
    };
  });
}
```

When `when` is present, XState receives `{ type: '__matchesWhen', params: { when: { verdict: 'approved' } } }`. XState calls the registered `__matchesWhen` guard function, passing the `params` object. When only `guard` is present, the string reference works as it does today.

## Workflow definition example

Current `design-and-code.json` review state transitions:

```json
"transitions": [
  { "to": "done", "guard": "isApproved" },
  { "to": "escalate_gate", "guard": "isRoundLimitReached" },
  { "to": "implement", "guard": "isRejected" }
]
```

With `when`, this becomes:

```json
"transitions": [
  { "to": "done", "when": { "verdict": "approved" } },
  { "to": "escalate_gate", "guard": "isRoundLimitReached" },
  { "to": "implement", "when": { "verdict": "rejected" } }
]
```

`isRoundLimitReached` stays as a `guard` because it reads `WorkflowContext.visitCounts` and `maxRounds`, which are not part of `AgentOutput`.

A more selective transition using AND semantics:

```json
"transitions": [
  { "to": "done", "when": { "verdict": "approved", "confidence": "high" } },
  { "to": "escalate_gate", "when": { "verdict": "approved", "confidence": "low" } },
  { "to": "escalate_gate", "guard": "isRoundLimitReached" },
  { "to": "implement", "when": { "verdict": "rejected" } }
]
```

This replaces the separate `isLowConfidence` guard with inline `when` clauses.

## What stays the same

- **Existing guards** -- `isApproved`, `isRejected`, `isLowConfidence`, `isRoundLimitReached`, `isStalled`, `hasTestCountRegression`, `isPassed` remain in the registry. No deprecation.
- **`guard` field** -- Fully supported. Existing workflows work unchanged.
- **Human gate transitions** -- Use `HumanGateTransitionDefinition` with the `event` field. The `when` field exists only on `AgentTransitionDefinition`.
- **Deterministic state transitions** -- Continue using `guard` (e.g., `isPassed`). `when` is rejected at validation time.
- **Guard adapter** -- The XState event-unwrapping logic (lines 280-317) is unchanged. `__matchesWhen` reuses the same `extractInvokeResult` function.
- **`REGISTERED_GUARDS` set** -- Unchanged. `__matchesWhen` is internal to the machine builder (not registered via `guards.ts` or validated by `REGISTERED_GUARDS`).

## File impact list

| File | Change |
|---|---|
| `src/workflow/types.ts` | Add `WhenValue` type. Add optional `when` field to `AgentTransitionDefinition`. |
| `src/workflow/validate.ts` | Extend `agentTransitionSchema` with `when`. Add `AGENT_OUTPUT_FIELDS`, `VERDICT_VALUES`, `CONFIDENCE_VALUES` sets. Add five semantic checks in `validateSemantics`: mutual exclusivity, agent-only scope, key validation, enum value validation, empty `when` rejection. |
| `src/workflow/machine-builder.ts` | Register `__matchesWhen` parameterized guard. Update `buildAgentOnDoneTransitions` to emit parameterized guard when `when` is present. |
| `test/workflow/validate.test.ts` | Add tests for `when` validation (see test plan). |
| `test/workflow/machine-builder.test.ts` | Add tests for `__matchesWhen` guard behavior (see test plan). |
| `src/workflow/workflows/design-and-code.json` | Optional: replace `isApproved`/`isRejected` with `when` clauses. Not required for the feature to ship. |

No additional implementation files are required beyond the updates listed above; this design doc is itself a new file in the PR.

## Test plan

### Validation tests (`test/workflow/validate.test.ts`)

1. **Accepts `when` on agent transition** -- A definition with `{ "to": "done", "when": { "verdict": "approved" } }` passes validation.
2. **Accepts multi-field `when`** -- `{ "when": { "verdict": "approved", "confidence": "high" } }` passes.
3. **Rejects `when` + `guard` on same transition** -- Error message mentions mutual exclusivity.
4. **Rejects `when` on deterministic state** -- Error message says deterministic states cannot use `when`.
5. **Rejects invalid `when` key** -- `{ "when": { "mood": "happy" } }` errors with "not a valid AgentOutput field".
6. **Rejects invalid verdict value** -- `{ "when": { "verdict": "aproved" } }` errors with "invalid verdict value".
7. **Rejects invalid confidence value** -- `{ "when": { "confidence": "very_high" } }` errors with "invalid confidence value".
8. **Accepts non-enum fields without value validation** -- `{ "when": { "completed": true } }`, `{ "when": { "testCount": 42 } }`, `{ "when": { "escalation": null } }` all pass. (No allowlist for non-enum fields.)
9. **Collects multiple `when` issues in one error** -- A definition with an invalid key AND an invalid verdict value on different transitions reports both.
10. **Rejects empty `when`** -- `{ "when": {} }` errors with "empty when — use no guard for unconditional transitions".

### Machine builder tests (`test/workflow/machine-builder.test.ts`)

11. **`when: { verdict: "approved" }` routes to target on approved output** -- Use `coderCriticDefinition` variant with `when` replacing `isApproved`. Agent returns approved verdict. Machine reaches `done`.
12. **`when: { verdict: "rejected" }` routes to target on rejected output** -- Agent returns rejected verdict. Machine routes back to `implement`.
13. **Multi-field `when` requires all fields to match** -- `{ "when": { "verdict": "approved", "confidence": "high" } }` does NOT match `{ verdict: "approved", confidence: "low" }`. Falls through to next transition.
14. **`when` falls through on non-match** -- Agent returns `verdict: "blocked"`. Neither `when: { verdict: "approved" }` nor `when: { verdict: "rejected" }` match. Machine falls through to unconditional transition.
15. **`when` with null value matches null field** -- `{ "when": { "escalation": null } }` matches when `output.escalation` is `null`, does not match when it is a string.
16. **`when` coexists with `guard` on different transitions** -- One transition uses `when`, another uses `guard` (e.g., `isRoundLimitReached`). Both evaluate correctly.
17. **`when` preserves `flag` behavior** -- Transition with both `when` and `flag` sets `flaggedForReview` in context when the `when` matches.
18. **`when: { completed: false }` matches falsy boolean** -- Agent returns `{ completed: false }`. Transition with `when: { completed: false }` fires. This guards against accidental `!value` refactors that would treat `false` as a non-match.
