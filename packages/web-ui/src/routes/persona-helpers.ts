/**
 * Pure helpers for the Personas route. Kept Svelte-free so the decision logic is
 * unit-testable without rendering the component (mirrors dashboard-helpers.ts).
 */

/**
 * Whether a finished compile should clear the persona's "constitution stale"
 * flag.
 *
 * A compile only un-stales the persona if it covered the constitution that is
 * CURRENTLY saved. If the user saved a newer constitution while the compile was
 * in flight (`covered` differs from `current`), the new edit is uncompiled and
 * the flag must persist — otherwise a slower earlier compile would wrongly mark
 * the latest edit as compiled.
 *
 * An unknown snapshot (`covered === undefined`, e.g. a compile started outside
 * this view or before a reload) falls back to clearing, preserving the prior
 * behavior for compiles this view did not initiate.
 */
export function compileClearsStale(covered: string | undefined, current: string): boolean {
  return covered === undefined || covered === current;
}
