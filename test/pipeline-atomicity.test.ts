/**
 * A4 — artifact write ORDERING + atomicity test (design §11).
 *
 * Proves the Phase B write contract for the generated policy directory under a
 * concurrent reader:
 *
 *   Write order (per file, atomic tmp+rename):
 *     1. dynamic-lists.json FIRST  (or atomically REMOVED when no list defs)
 *     2. test-scenarios.json
 *     3. compiled-policy.json LAST
 *
 * This is the REVERSE of the runtime read order in `loadPersonaPolicyArtifacts`
 * (compiled-policy.json first, then dynamic-lists.json). The dependency ordering
 * yields the safety invariant:
 *
 *   - new-compiled  ⇒  new-lists already present   (never new compiled + old lists)
 *   - the reverse interleaving (new lists + old compiled) is FAIL-SAFE: an
 *     unknown @list-id in the old compiled policy expands to empty => deny.
 *   - when a generation produces NO list definitions, the stale dynamic-lists.json
 *     is removed and the reader handles its absence without throwing.
 *
 * The writer here uses the SAME primitives the pipeline uses (`writeArtifact`,
 * `removeArtifactIfExists`) so the test exercises the real atomicity behavior.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as pipelineShared from '../src/pipeline/pipeline-shared.js';
import { writeArtifact, removeArtifactIfExists } from '../src/pipeline/pipeline-shared.js';
import { loadPersonaPolicyArtifacts } from '../src/config/index.js';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import { createFakePipelineModels } from './fixtures/fake-pipeline-models.js';
import {
  GOLDEN_ALLOWED_DIR,
  GOLDEN_ANNOTATIONS,
  GOLDEN_CONSTITUTION,
  GOLDEN_RESPONSES,
} from './fixtures/golden-pipeline-fixture.js';
import type { CompiledPolicyFile, DynamicListsFile } from '../src/pipeline/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(resolve(tmpdir(), 'ic-a4-'));
  dirs.push(d);
  return d;
}

/** A compiled policy that references a generation-tagged list id. */
function compiledForGen(gen: number): CompiledPolicyFile {
  return {
    generatedAt: new Date(0).toISOString(),
    constitutionHash: 'c',
    inputHash: `gen-${gen}`,
    rules: [
      {
        name: 'allow-listed',
        description: 'd',
        principle: 'p',
        if: {
          server: ['fetch'],
          domains: { roles: ['fetch-url'], allowed: [`@list-gen-${gen}`] },
        },
        then: 'allow',
        reason: 'r',
      },
    ],
    listDefinitions: [
      { name: `list-gen-${gen}`, type: 'domains', requiresMcp: false, generationPrompt: 'g', principle: 'p' },
    ],
  };
}

function listsForGen(gen: number): DynamicListsFile {
  return {
    generatedAt: new Date(0).toISOString(),
    lists: {
      [`list-gen-${gen}`]: {
        values: [`gen-${gen}.example.com`],
        manualAdditions: [],
        manualRemovals: [],
        resolvedAt: new Date(0).toISOString(),
        inputHash: `lh-${gen}`,
      },
    },
  };
}

/**
 * Emits one generation in the Phase B dependency order. `hasLists=false`
 * exercises the empty-lists path (stale-file removal).
 */
function emitGeneration(dir: string, gen: number, hasLists: boolean): void {
  if (hasLists) {
    writeArtifact(dir, 'dynamic-lists.json', listsForGen(gen)); // 1. lists FIRST
  } else {
    removeArtifactIfExists(dir, 'dynamic-lists.json'); // 1. remove stale FIRST
  }
  writeArtifact(dir, 'test-scenarios.json', { generatedAt: new Date(0).toISOString(), scenarios: [] }); // 2.
  // 3. compiled-policy.json LAST — its list id only resolves if the matching
  //    lists file is already on disk (when hasLists).
  const compiled = hasLists ? compiledForGen(gen) : { ...compiledForGen(gen), listDefinitions: undefined };
  writeArtifact(dir, 'compiled-policy.json', compiled);
}

/** Parses a generation number out of an inputHash like `gen-7`. */
function genOf(inputHash: string): number {
  const m = /gen-(\d+)/.exec(inputHash);
  if (!m) throw new Error(`unexpected inputHash: ${inputHash}`);
  return Number(m[1]);
}

describe('A4 — artifact write ordering + atomicity', () => {
  it('new-compiled ⇒ new-lists present (race over many interleavings)', async () => {
    const dir = makeDir();
    emitGeneration(dir, 0, true); // seed

    let stop = false;
    const shouldStop = () => stop; // read via fn so TS does not narrow `stop` to a literal
    const violations: string[] = [];
    let observedNewLists = 0;
    let reads = 0;

    const tick = () => new Promise((r) => setTimeout(r, 0));

    // Reader: loop using the REAL two-step (non-transactional) loader. Yields
    // via setTimeout (a MACROtask) so the writer's macrotask interleaves —
    // a microtask-only yield would starve the writer.
    const reader = (async () => {
      while (!shouldStop()) {
        const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(dir);
        reads++;
        const compiledGen = genOf(compiledPolicy.inputHash);
        const listName = `list-gen-${compiledGen}`;
        // INVARIANT: if the reader sees a compiled policy of generation N, the
        // matching lists for generation N must already be present. (The writer
        // always writes lists BEFORE compiled, so a reader that reads compiled
        // first and lists second can never miss them.)
        if (dynamicLists && listName in dynamicLists.lists) observedNewLists++;
        else violations.push(`compiled gen ${compiledGen} observed without matching lists`);
        await tick();
      }
    })();

    // Writer: emit generations, each with lists, in dependency order, yielding
    // between each so the reader interleaves mid-stream.
    for (let gen = 1; gen <= 60; gen++) {
      emitGeneration(dir, gen, true);
      await tick();
    }
    stop = true;
    await reader;

    expect(violations).toEqual([]);
    // Sanity: the reader actually ran and observed new generations (not vacuous).
    expect(reads).toBeGreaterThan(0);
    expect(observedNewLists).toBeGreaterThan(0);
  });

  it('reverse interleaving (new lists + old compiled) is fail-safe: reader never throws', () => {
    const dir = makeDir();
    emitGeneration(dir, 0, true);
    // Manually create the transient state the writer produces mid-generation:
    // new lists written, compiled-policy still the OLD generation.
    writeArtifact(dir, 'dynamic-lists.json', listsForGen(1)); // new lists
    // compiled-policy.json is still gen 0 (references @list-gen-0).
    expect(() => {
      const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(dir);
      // Old compiled references list-gen-0; new lists only has list-gen-1.
      // The mismatch is benign: an unknown @list-id expands to empty => deny.
      expect(compiledPolicy.inputHash).toBe('gen-0');
      expect(dynamicLists && 'list-gen-0' in dynamicLists.lists).toBe(false);
    }).not.toThrow();
  });

  it('empty-lists generation removes the stale dynamic-lists.json; reader handles absence', () => {
    const dir = makeDir();
    emitGeneration(dir, 0, true);
    // A stale file exists now.
    expect(() => loadPersonaPolicyArtifacts(dir)).not.toThrow();

    // Next generation has NO list definitions -> stale file must be removed.
    emitGeneration(dir, 1, false);

    const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(dir);
    expect(compiledPolicy.listDefinitions).toBeUndefined();
    expect(dynamicLists).toBeUndefined(); // stale file gone, loader returns undefined
  });

  it('removeArtifactIfExists is idempotent (no throw when file absent)', () => {
    const dir = makeDir();
    expect(() => removeArtifactIfExists(dir, 'dynamic-lists.json')).not.toThrow();
    // Write then remove twice.
    writeFileSync(resolve(dir, 'dynamic-lists.json'), '{}');
    removeArtifactIfExists(dir, 'dynamic-lists.json');
    expect(() => removeArtifactIfExists(dir, 'dynamic-lists.json')).not.toThrow();
  });
});

/**
 * Couples the A4 ordering invariant to the REAL runner. The tests above assert
 * the invariant against a hand-written `emitGeneration` model of the writer;
 * this one drives `new PipelineRunner(fakeModels).run(config)` (reusing the
 * golden fixture) and spies on the artifact-write primitives the runner calls,
 * so a regression that reverses the runner's emission order (compiled-first)
 * — the exact bug Phase B fixes — fails here even though final on-disk state
 * is order-independent.
 *
 * Spying targets the `pipeline-shared` module namespace that the runner imports
 * its `writeArtifact`/`removeArtifactIfExists` bindings from, so the recorded
 * sequence is the runner's actual call order, not a reimplementation.
 */
describe('A4 — runner emits artifacts in the safe order (lists before compiled)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes dynamic-lists.json BEFORE compiled-policy.json (compiled strictly last)', async () => {
    const workDir = mkdtempSync(resolve(tmpdir(), 'ic-a4-runner-'));
    dirs.push(workDir);
    const outputDir = resolve(workDir, 'generated');
    mkdirSync(outputDir, { recursive: true });
    const logPath = resolve(workDir, 'llm-interactions.jsonl');

    // Record the ORDER of final-artifact writes the runner performs. We spy on
    // the module the runner imports from; the spies delegate to the real impls
    // so the run still produces valid on-disk artifacts.
    // Capture the REAL impls before spying — calling the named binding inside
    // the mock would re-enter the spied namespace property (infinite recursion),
    // since vitest's ESM interop routes the binding through the same namespace.
    const realWriteArtifact = pipelineShared.writeArtifact;
    const realRemoveArtifactIfExists = pipelineShared.removeArtifactIfExists;
    const order: string[] = [];
    vi.spyOn(pipelineShared, 'writeArtifact').mockImplementation((dir, filename, data) => {
      order.push(filename);
      realWriteArtifact(dir, filename, data);
    });
    vi.spyOn(pipelineShared, 'removeArtifactIfExists').mockImplementation((dir, filename) => {
      order.push(`remove:${filename}`);
      realRemoveArtifactIfExists(dir, filename);
    });

    const models = createFakePipelineModels(GOLDEN_RESPONSES, logPath);
    const config: PipelineRunConfig = {
      constitutionInput: GOLDEN_CONSTITUTION,
      constitutionKind: 'constitution',
      outputDir,
      toolAnnotationsDir: outputDir,
      allowedDirectory: GOLDEN_ALLOWED_DIR,
      protectedPaths: [],
      preloadedStoredAnnotations: GOLDEN_ANNOTATIONS,
      includeHandwrittenScenarios: false,
      llmLogPath: logPath,
    };

    await new PipelineRunner(models).run(config);

    // The golden fixture produces a list, so the FINAL emission writes
    // dynamic-lists.json (not the remove branch). Restrict to the three final
    // top-level artifacts (the runner also writes per-server caches into
    // subdirectories with the same filenames; those share `writeArtifact`).
    const finalWrites = order.filter((f) => f === 'dynamic-lists.json' || f === 'compiled-policy.json');
    const lastListsIdx = finalWrites.lastIndexOf('dynamic-lists.json');
    const lastCompiledIdx = finalWrites.lastIndexOf('compiled-policy.json');

    expect(lastListsIdx).toBeGreaterThanOrEqual(0); // lists were written at all
    expect(lastCompiledIdx).toBeGreaterThanOrEqual(0); // compiled was written
    // INVARIANT: the final dynamic-lists.json write precedes the final
    // compiled-policy.json write. Reversing the runner's block (compiled-first)
    // flips this and fails the assertion.
    expect(lastListsIdx).toBeLessThan(lastCompiledIdx);
    // compiled-policy.json is strictly the LAST top-level artifact written.
    expect(finalWrites[finalWrites.length - 1]).toBe('compiled-policy.json');
  });
});
