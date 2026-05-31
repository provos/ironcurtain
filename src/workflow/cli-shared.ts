/**
 * Shared CLI helpers used by both `workflow-command.ts` (the dispatcher) and
 * `run-state-command.ts` (a subcommand handler).
 *
 * This module is a leaf: it depends only on other shared leaves
 * (`./cli-support.js`, `./lint-integration.js`, `./definition-loader.js`,
 * `./lint.js`, `./types.js`) and must NOT import from `workflow-command.ts`
 * or `run-state-command.ts`. It exists to break the runtime import cycle
 * those two modules would otherwise form.
 */

import { parseArgs } from 'node:util';
import { runPreflight, type LintMode } from './lint-integration.js';
import { loadDefinition } from './definition-loader.js';
import type { Diagnostic } from './lint.js';
import type { WorkflowDefinition } from './types.js';
import { writeStderr, RED, CYAN, DIM, RESET } from './cli-support.js';

// ---------------------------------------------------------------------------
// Lint helpers
// ---------------------------------------------------------------------------

export function formatDiagnostic(d: Diagnostic): string[] {
  const sevColor = d.severity === 'error' ? RED : CYAN;
  const location = d.stateId ? ` (state: ${d.stateId})` : '';
  const lines = [`${DIM}[${d.code}]${RESET} ${sevColor}${d.severity}${RESET} ${d.message}${location}`];
  if (d.hint) lines.push(`  ${DIM}hint: ${d.hint}${RESET}`);
  return lines;
}

export function printDiagnostics(diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) {
    for (const line of formatDiagnostic(d)) writeStderr(line);
  }
}

/**
 * Loads + validates a workflow definition from a path via the shared
 * {@link loadDefinition} helper. Prints CLI-formatted errors and exits on
 * any failure (parse or validate). Validation errors take precedence over
 * lint diagnostics.
 */
export function loadAndValidateDefinition(path: string): WorkflowDefinition {
  const result = loadDefinition(path);
  if (result.ok) return result.definition;

  if (result.kind === 'validate' && result.issues) {
    writeStderr(`${RED}Workflow validation failed:${RESET}`);
    for (const issue of result.issues) writeStderr(`  ${RED}- ${issue}${RESET}`);
  } else {
    writeStderr(`${RED}Failed to load workflow: ${result.message}${RESET}`);
  }
  process.exit(1);
}

/**
 * Loads + lints a workflow definition file via the shared
 * {@link runPreflight} helper. CLI-specific reporting: prints diagnostics
 * to stderr and exits on any failure (load or lint). On success with
 * warnings-only output, prints a short continue notice.
 *
 * Returns the loaded definition on success so callers can continue using it
 * without re-parsing (start/resume have already routed through the same
 * file before calling this).
 */
export function runCliPreflightLint(definitionPath: string, mode: LintMode): WorkflowDefinition {
  const result = runPreflight(definitionPath, mode);

  if (result.ok) {
    if (result.diagnostics.length > 0) {
      printDiagnostics(result.diagnostics);
      writeStderr(`${DIM}Lint: 0 errors, ${result.warnings} warning(s) — continuing.${RESET}`);
    }
    return result.definition;
  }

  if (result.kind === 'load') {
    // Reuse `loadAndValidateDefinition`'s nicer per-issue formatting on
    // validate failures by re-running it (cheap; reads the same file once
    // more) — it owns the structured-issues bullet rendering. For parse
    // failures it falls through and prints "Failed to load workflow:".
    loadAndValidateDefinition(definitionPath);
    // Unreachable: `loadAndValidateDefinition` always exits on failure.
    process.exit(1);
  }

  // Lint failure (load succeeded). Match the previous output verbatim.
  printDiagnostics(result.diagnostics);
  writeStderr(`${RED}Lint failed: ${result.errors} error(s), ${result.warnings} warning(s).${RESET}`);
  writeStderr(`${DIM}Rerun with --no-lint to bypass (not recommended).${RESET}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

type ParseArgsConfig = Parameters<typeof parseArgs>[0];

export function parseArgsStrict(opts: Omit<ParseArgsConfig, 'strict'>): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({ ...opts, strict: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeStderr(`${RED}${message}${RESET}`);
    writeStderr(`${DIM}Run with --help to see available options.${RESET}`);
    process.exit(1);
  }
}
