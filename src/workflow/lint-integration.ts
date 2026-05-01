/**
 * Shared pre-flight lint integration used by both the CLI and the daemon.
 * UI-agnostic: returns a `PreflightResult` that callers format themselves
 * (stderr for CLI, JSON-RPC error data for the daemon).
 */

import { countBySeverity, lintWorkflow, type Diagnostic, type LintContext } from './lint.js';
import { personaExists } from '../persona/resolve.js';
import { loadDefinition } from './definition-loader.js';
import type { WorkflowDefinition } from './types.js';

/**
 * Default `LintContext` shared by both the CLI and the daemon. Backed by the
 * real filesystem-resolving `personaExists` from `src/persona/resolve.ts`.
 */
export const defaultLintContext: LintContext = { personaExists };

/**
 * How strict the pre-flight should be:
 * - `off`   : skip linting entirely; always ok.
 * - `warn`  : fail only on error-severity diagnostics; warnings pass.
 * - `strict`: fail on any diagnostic, including warnings.
 */
export type LintMode = 'off' | 'warn' | 'strict';

export interface PreflightResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export function preflightLint(definition: WorkflowDefinition, context: LintContext, mode: LintMode): PreflightResult {
  if (mode === 'off') return { ok: true, diagnostics: [] };

  const diagnostics = lintWorkflow(definition, context);
  const { errors } = countBySeverity(diagnostics);
  const failed = mode === 'strict' ? diagnostics.length > 0 : errors > 0;

  return { ok: !failed, diagnostics };
}

/**
 * Discriminated result for {@link runPreflight}. Three variants:
 *
 * - `{ ok: true, ... }`: the definition loaded and lint either had no
 *   diagnostics or had only diagnostics tolerated by `mode`. `warnings`
 *   counts the (passing) warnings present.
 * - `{ ok: false, kind: 'load', ... }`: the definition file could not be
 *   parsed or did not validate. `loadKind` distinguishes the two.
 * - `{ ok: false, kind: 'lint', ... }`: the definition loaded but lint
 *   produced diagnostics that fail `mode`. The definition is still returned
 *   so callers can render it alongside the diagnostics.
 */
export type RunPreflightResult =
  | {
      ok: true;
      definition: WorkflowDefinition;
      diagnostics: readonly Diagnostic[];
      warnings: number;
    }
  | {
      ok: false;
      kind: 'load';
      loadKind: 'parse' | 'validate';
      message: string;
    }
  | {
      ok: false;
      kind: 'lint';
      definition: WorkflowDefinition;
      diagnostics: readonly Diagnostic[];
      errors: number;
      warnings: number;
    };

/**
 * Loads + validates a definition from `definitionPath`, then runs
 * {@link preflightLint} with a {@link LintContext} derived from
 * {@link defaultLintContext} but bound to `definitionPath` so
 * package-relative checks (currently WF010 — skill references) can
 * resolve sibling resources. Never throws — returns a discriminated
 * result that callers map to their own error surfaces (stderr+exit
 * for CLI, RpcError for the daemon).
 */
export function runPreflight(definitionPath: string, mode: LintMode): RunPreflightResult {
  const loaded = loadDefinition(definitionPath);
  if (!loaded.ok) {
    return { ok: false, kind: 'load', loadKind: loaded.kind, message: loaded.message };
  }

  const ctx: LintContext = { ...defaultLintContext, workflowFilePath: definitionPath };
  const lintResult = preflightLint(loaded.definition, ctx, mode);
  const { errors, warnings } = countBySeverity(lintResult.diagnostics);

  if (lintResult.ok) {
    return {
      ok: true,
      definition: loaded.definition,
      diagnostics: lintResult.diagnostics,
      warnings,
    };
  }

  return {
    ok: false,
    kind: 'lint',
    definition: loaded.definition,
    diagnostics: lintResult.diagnostics,
    errors,
    warnings,
  };
}
