/**
 * Centralized loader for workflow definition files.
 *
 * Both the CLI (`workflow start` / `workflow resume` / `workflow lint`) and
 * the daemon (`workflows.start` JSON-RPC and the past-run loader) need the
 * same parse + validate pipeline. This module is the single source of truth.
 *
 * The function never throws: callers receive a discriminated result so they
 * can map errors to their own surface (stderr + `process.exit(1)` for the
 * CLI; `RpcError('INVALID_PARAMS')` for the daemon; `'corrupted'` for the
 * past-run loader).
 */

import { parseDefinitionFile } from './discovery.js';
import { validateDefinition, WorkflowValidationError } from './validate.js';
import type { WorkflowDefinition } from './types.js';

export type DefinitionLoadResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; kind: 'parse' | 'validate'; message: string; issues?: readonly string[] };

/**
 * Reads, parses, and validates a workflow definition file.
 *
 * - `kind: 'parse'` covers any failure before structural validation
 *   (file read errors, YAML/JSON syntax errors, alias-bomb rejection).
 * - `kind: 'validate'` covers `WorkflowValidationError` from `validateDefinition`
 *   and any other unexpected error during validation. The `issues` array is
 *   populated only for the `WorkflowValidationError` path.
 */
export function loadDefinition(path: string): DefinitionLoadResult {
  let raw: unknown;
  try {
    raw = parseDefinitionFile(path);
  } catch (err) {
    return {
      ok: false,
      kind: 'parse',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const definition = validateDefinition(raw);
    return { ok: true, definition };
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      return {
        ok: false,
        kind: 'validate',
        message: `Workflow validation failed: ${err.issues.join('; ')}`,
        issues: err.issues,
      };
    }
    return {
      ok: false,
      kind: 'validate',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
