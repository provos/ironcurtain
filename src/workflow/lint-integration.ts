/**
 * Shared pre-flight lint integration used by both the CLI and the daemon.
 * UI-agnostic: returns a `PreflightResult` that callers format themselves
 * (stderr for CLI, JSON-RPC error data for the daemon).
 */

import { countBySeverity, lintWorkflow, type Diagnostic, type LintContext } from './lint.js';
import type { WorkflowDefinition } from './types.js';

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
