/**
 * Tests for `runPreflight` in `src/workflow/lint-integration.ts`.
 *
 * Verifies the discriminated-union surface that callers map to their own
 * error channels (CLI stderr+exit, daemon RpcError):
 *   - `ok: true` when the definition loads and lint passes for the mode.
 *   - `ok: false, kind: 'load'` when the definition file is malformed or
 *     fails schema validation.
 *   - `ok: false, kind: 'lint'` when the definition loads but lint
 *     produces failing diagnostics for the mode.
 *
 * The default `LintContext` is used (backed by the real `personaExists`),
 * so workflows referencing missing personas trigger WF007 warnings — which
 * is exactly what `strict` mode promotes to a failure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { runPreflight } from '../src/workflow/lint-integration.js';

function writeDefinition(dir: string, body: unknown): string {
  const filePath = resolve(dir, 'workflow.json');
  writeFileSync(filePath, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf-8');
  return filePath;
}

/**
 * Minimal valid workflow with a single terminal state — passes both
 * structural validation and every lint check, so it exercises the
 * `ok: true, diagnostics: []` happy path.
 */
function cleanWorkflow(): Record<string, unknown> {
  return {
    name: 'clean-flow',
    description: 'A trivially clean workflow',
    initial: 'done',
    states: {
      done: {
        type: 'terminal',
        description: 'all done',
      },
    },
  };
}

/**
 * Workflow with a settings.unversionedArtifacts entry for an artifact that
 * no state produces — triggers WF002, a *warning* (not error). Ideal for
 * exercising the strict-vs-warn mode distinction.
 */
function workflowWithWarning(): Record<string, unknown> {
  return {
    name: 'warning-flow',
    description: 'Triggers a WF002 warning',
    initial: 'done',
    settings: {
      unversionedArtifacts: ['nobody-makes-me'],
    },
    states: {
      done: {
        type: 'terminal',
        description: 'terminal',
      },
    },
  };
}

describe('runPreflight', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'run-preflight-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ok path', () => {
    it('returns ok: true for a clean definition with no diagnostics', () => {
      const path = writeDefinition(tmpDir, cleanWorkflow());

      const result = runPreflight(path, 'warn');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.definition.name).toBe('clean-flow');
      expect(result.diagnostics.length).toBe(0);
      expect(result.warnings).toBe(0);
    });

    it('returns ok: true with warnings preserved in warn mode', () => {
      const path = writeDefinition(tmpDir, workflowWithWarning());

      const result = runPreflight(path, 'warn');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.diagnostics.some((d) => d.code === 'WF002')).toBe(true);
      expect(result.warnings).toBeGreaterThan(0);
    });

    it('returns ok: true regardless of diagnostics in off mode', () => {
      const path = writeDefinition(tmpDir, workflowWithWarning());

      const result = runPreflight(path, 'off');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // off mode short-circuits the lint pass; no diagnostics surface.
      expect(result.diagnostics.length).toBe(0);
    });
  });

  describe('load failure', () => {
    it('returns kind: load with loadKind: parse for malformed JSON', () => {
      const path = writeDefinition(tmpDir, '{ malformed');

      const result = runPreflight(path, 'warn');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe('load');
      if (result.kind !== 'load') return;
      expect(result.loadKind).toBe('parse');
      expect(result.message.length).toBeGreaterThan(0);
    });

    it('returns kind: load with loadKind: parse when the file is missing', () => {
      const result = runPreflight(resolve(tmpDir, 'missing.json'), 'warn');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe('load');
      if (result.kind !== 'load') return;
      expect(result.loadKind).toBe('parse');
    });

    it('returns kind: load with loadKind: validate for schema-invalid definitions', () => {
      const path = writeDefinition(tmpDir, { name: 'bad', description: 'no states' });

      const result = runPreflight(path, 'warn');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe('load');
      if (result.kind !== 'load') return;
      expect(result.loadKind).toBe('validate');
      // The CLI and daemon both rely on the "Workflow validation failed:"
      // prefix when surfacing the error message.
      expect(result.message).toMatch(/^Workflow validation failed:/);
    });
  });

  describe('lint failure', () => {
    it('returns kind: lint in strict mode when only warnings are present', () => {
      const path = writeDefinition(tmpDir, workflowWithWarning());

      const result = runPreflight(path, 'strict');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe('lint');
      if (result.kind !== 'lint') return;
      expect(result.errors).toBe(0);
      expect(result.warnings).toBeGreaterThan(0);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      // Definition is still surfaced so callers can render context.
      expect(result.definition.name).toBe('warning-flow');
    });

    it('returns kind: lint in warn mode when an error-severity diagnostic fires', () => {
      // Reachable human_gate that "presents" an artifact no agent state
      // produces -- WF004, severity: error. Triggers warn-mode failure.
      const path = writeDefinition(tmpDir, {
        name: 'error-flow',
        description: 'WF004 error scenario',
        initial: 'gate',
        states: {
          gate: {
            type: 'human_gate',
            description: 'asks for an artifact nothing produces',
            acceptedEvents: ['APPROVE'],
            present: ['phantom'],
            transitions: [{ to: 'done', event: 'APPROVE' }],
          },
          done: {
            type: 'terminal',
            description: 'done',
          },
        },
      });

      const result = runPreflight(path, 'warn');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe('lint');
      if (result.kind !== 'lint') return;
      expect(result.errors).toBeGreaterThan(0);
      expect(result.diagnostics.some((d) => d.code === 'WF004')).toBe(true);
    });
  });
});
