/**
 * Tests for the `hidden` workflow flag and co-packaged README support:
 *   - discovery surfaces `hidden` + `hasReadme` and `readWorkflowReadme`/
 *     `findWorkflowByName` resolve correctly (temp user workflows);
 *   - `workflows.listDefinitions` dispatch filters hidden workflows and maps
 *     `hasReadme`, and `workflows.readme` serves / rejects READMEs by path
 *     (integration against the real bundled workflows).
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverWorkflows, findWorkflowByName, readWorkflowReadme } from '../src/workflow/discovery.js';
import { workflowDispatch, type WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { RpcError, type WorkflowDefinitionDto, type WorkflowReadmeDto } from '../src/web-ui/web-ui-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let originalHome: string | undefined;

/** Writes `<userRoot>/<name>/workflow.yaml` (+ optional README.md). */
function writePackage(name: string, opts: { description?: string; hidden?: boolean; readme?: string } = {}): string {
  const dir = resolve(tempDir, 'workflows', name);
  mkdirSync(dir, { recursive: true });
  const manifest = resolve(dir, 'workflow.yaml');
  const lines = [`name: ${name}`, `description: "${opts.description ?? 'a test workflow'}"`];
  if (opts.hidden) lines.push('hidden: true');
  lines.push('initial: start', 'states: {}', '');
  writeFileSync(manifest, lines.join('\n'));
  if (opts.readme !== undefined) writeFileSync(resolve(dir, 'README.md'), opts.readme);
  return manifest;
}

// `workflows.listDefinitions` and `workflows.readme` (definitionPath form) do
// not consult the workflow manager, so an empty context is sufficient.
const emptyCtx = {} as WorkflowDispatchContext;

beforeEach(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-hidden-readme-'));
  // Point the user workflows dir at an empty temp tree so user-installed
  // workflows on the dev machine don't make assertions flaky.
  originalHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = tempDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovery: hidden flag + README detection', () => {
  it('marks hidden:true manifests and detects a co-packaged README', () => {
    writePackage('visible-flow', { readme: '# Visible' });
    writePackage('secret-flow', { hidden: true });

    const all = discoverWorkflows();
    const visible = all.find((e) => e.name === 'visible-flow');
    const secret = all.find((e) => e.name === 'secret-flow');

    expect(visible?.hidden).toBe(false);
    expect(visible?.hasReadme).toBe(true);
    expect(secret?.hidden).toBe(true);
    expect(secret?.hasReadme).toBe(false);
  });

  it('readWorkflowReadme returns the markdown; findWorkflowByName resolves the package', () => {
    const manifest = writePackage('doc-flow', { readme: '# Title\n\nBody text' });

    expect(readWorkflowReadme(manifest)).toContain('# Title');
    expect(readWorkflowReadme(manifest)).toContain('Body text');

    const entry = findWorkflowByName('doc-flow');
    expect(entry).toBeDefined();
    expect(entry?.path).toBe(manifest);
    expect(entry?.hasReadme).toBe(true);
  });

  it('readWorkflowReadme returns undefined when there is no README', () => {
    const manifest = writePackage('no-doc-flow');
    expect(readWorkflowReadme(manifest)).toBeUndefined();
  });

  it('refuses a README symlinked outside the workflow package', () => {
    // A file outside any workflow package that a symlinked README could leak.
    const secret = resolve(tempDir, 'secret.txt');
    writeFileSync(secret, 'TOP SECRET');
    const dir = resolve(tempDir, 'workflows', 'evil-flow');
    mkdirSync(dir, { recursive: true });
    const manifest = resolve(dir, 'workflow.yaml');
    writeFileSync(manifest, 'name: evil-flow\ndescription: "x"\ninitial: start\nstates: {}\n');
    symlinkSync(secret, resolve(dir, 'README.md'));

    // The symlink exists (so hasReadme is true), but reading it must be refused
    // because it resolves outside the package dir — no arbitrary host reads.
    expect(findWorkflowByName('evil-flow')?.hasReadme).toBe(true);
    expect(readWorkflowReadme(manifest)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatch: workflows.listDefinitions (against real bundled workflows)
// ---------------------------------------------------------------------------

describe('workflows.listDefinitions dispatch', () => {
  it('excludes hidden bundled workflows and includes hasReadme', async () => {
    const defs = (await workflowDispatch(emptyCtx, 'workflows.listDefinitions', {})) as WorkflowDefinitionDto[];
    const names = defs.map((d) => d.name);

    // Bundled production workflow with a README ships in the repo.
    expect(names).toContain('design-and-code');
    expect(defs.find((d) => d.name === 'design-and-code')?.hasReadme).toBe(true);

    // The three smoke / fixture workflows are marked hidden and must not appear.
    expect(names).not.toContain('deterministic-verdict-smoke');
    expect(names).not.toContain('deterministic-eval-smoke');
    expect(names).not.toContain('test-email-summary');

    // Every returned entry carries the hasReadme field.
    for (const d of defs) {
      expect(typeof d.hasReadme).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch: workflows.readme
// ---------------------------------------------------------------------------

describe('workflows.readme dispatch', () => {
  it('serves the README for a discovered definition path', async () => {
    const defs = (await workflowDispatch(emptyCtx, 'workflows.listDefinitions', {})) as WorkflowDefinitionDto[];
    const dac = defs.find((d) => d.name === 'design-and-code');
    expect(dac).toBeDefined();
    if (!dac) return;

    const res = (await workflowDispatch(emptyCtx, 'workflows.readme', {
      definitionPath: dac.path,
    })) as WorkflowReadmeDto;
    expect(res.content).toContain('Design & Code');
  });

  it('rejects an unknown definition path (no arbitrary file reads)', async () => {
    await expect(
      workflowDispatch(emptyCtx, 'workflows.readme', { definitionPath: '/nope/workflow.yaml' }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects when neither definitionPath nor workflowId is provided', async () => {
    await expect(workflowDispatch(emptyCtx, 'workflows.readme', {})).rejects.toBeInstanceOf(RpcError);
  });
});
