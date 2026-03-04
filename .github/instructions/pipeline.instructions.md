---
applyTo: "src/pipeline/**"
---

# Pipeline Review Rules

The policy compilation pipeline generates artifacts that the policy engine loads at runtime. Incorrect artifacts can weaken or break security policy.

## Mandatory Checks

- Generated artifacts (`compiled-policy.json`, `tool-annotations.json`, `dynamic-lists.json`, `test-scenarios.json`) use content-hash caching via `inputHash`. The LLM prompt text must be included in the hash computation so prompt template changes invalidate the cache.
- Artifacts must be written to disk immediately after each pipeline step, not gated on later verification. This allows inspection of intermediate results and proper caching.
- The `Decision` type (alias for `PolicyDecisionStatus`) has three states. Schema definitions using `z.enum()` for decisions must include all three: `allow`, `deny`, `escalate`.
- LLM responses sometimes return bare strings instead of arrays for the `roles` field. Use `z.union([z.array(schema), schema.transform(r => [r])])` to handle both.
- Tool annotations may use **conditional role specs** (`{ default, when }`) for multi-mode tools. The stored format uses `StoredToolAnnotation` / `ArgumentRoleSpec`. Resolution to plain `ToolAnnotation` happens at the policy engine lookup boundary — pipeline code that inspects roles without a call context should use `extractDefaultRoles()` from `argument-roles.ts`.
- `ListType` is a union of `'domains' | 'emails' | 'identifiers'`. Each type has specific matching semantics defined in `dynamic-list-types.ts`. Adding a new list type requires a corresponding matcher function.
- Test scenarios have a `source` field: `'generated'` or `'handwritten'`. Handwritten scenarios are human ground truth and must never be auto-corrected by the dual-feedback repair loop.
