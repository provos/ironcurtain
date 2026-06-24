/**
 * Phase 0 golden harness — pins TODAY's compiled-policy.json + dynamic-lists.json
 * output of the policy-compilation pipeline against a fixed fake-LLM run.
 *
 * Purpose: capture the pre-refactor output so an OUTPUT-PRESERVING Phase B
 * refactor (atomic writes, reversed write order, reporter factory, quiet, etc.)
 * can be proven not to change the produced artifacts.
 *
 * Approach: full `new PipelineRunner(fakeModels).run(config)` end-to-end with a
 * content-routing fake LanguageModelV3 (no network, no real LLM). Comparison is
 * STRUCTURAL (parse JSON + deep-equal) with timestamp fields normalized to a
 * sentinel, since `generatedAt`/`resolvedAt` are wall-clock and non-deterministic.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PipelineRunner, type PipelineRunConfig } from '../src/pipeline/pipeline-runner.js';
import { createFakePipelineModels } from './fixtures/fake-pipeline-models.js';
import {
  GOLDEN_ALLOWED_DIR,
  GOLDEN_ANNOTATIONS,
  GOLDEN_CONSTITUTION,
  GOLDEN_RESPONSES,
  GOLDEN_WITHIN_PATH,
} from './fixtures/golden-pipeline-fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(__dirname, 'golden');
const GOLDEN_COMPILED = resolve(GOLDEN_DIR, 'compiled-policy.json');
const GOLDEN_LISTS = resolve(GOLDEN_DIR, 'dynamic-lists.json');

// Set CAPTURE_GOLDEN=1 to (re)generate the committed golden fixtures instead of
// asserting against them. Used once to seed the golden on current code.
const CAPTURE = process.env.CAPTURE_GOLDEN === '1';

/**
 * Recursively normalizes non-deterministic fields so the structural comparison
 * ignores noise but still catches any change to rules, list values, hashes, or
 * write structure:
 *  - timestamp fields (generatedAt/resolvedAt) -> wall-clock; replaced with a sentinel.
 *  - `paths.within` -> platform-dependent (realpathSync resolves /tmp -> /private/tmp
 *    on macOS but not on Linux). The committed golden is captured on one platform,
 *    so we normalize `within` to a sentinel here and assert the concrete resolved
 *    value separately (see the dedicated test below).
 */
const TIMESTAMP_KEYS = new Set(['generatedAt', 'resolvedAt']);
const PATH_KEYS = new Set(['within']);
function normalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForComparison);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (TIMESTAMP_KEYS.has(k)) out[k] = '<timestamp>';
      else if (PATH_KEYS.has(k)) out[k] = '<within>';
      else out[k] = normalizeForComparison(v);
    }
    return out;
  }
  return value;
}

function buildPipelineRun(): { runner: PipelineRunner; config: PipelineRunConfig; outputDir: string } {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-golden-'));
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  const logPath = resolve(workDir, 'llm-interactions.jsonl');

  const models = createFakePipelineModels(GOLDEN_RESPONSES, logPath);
  const runner = new PipelineRunner(models);

  const config: PipelineRunConfig = {
    constitutionInput: GOLDEN_CONSTITUTION,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: outputDir, // unused: annotations are preloaded
    // Fixed (not the random temp dir): the compiler-prompt hash, and therefore
    // the artifact inputHash, depends on allowedDirectory. A stable value keeps
    // the committed golden's inputHash deterministic across runs.
    allowedDirectory: GOLDEN_ALLOWED_DIR,
    protectedPaths: [],
    preloadedStoredAnnotations: GOLDEN_ANNOTATIONS,
    // prefilterText omitted -> prefilter skipped (no prefilterModel call).
    includeHandwrittenScenarios: false,
    llmLogPath: logPath,
  };

  return { runner, config, outputDir };
}

describe('Pipeline golden (Phase 0)', () => {
  let compiledActual: unknown;
  let listsActual: unknown;

  beforeAll(async () => {
    const { runner, config, outputDir } = buildPipelineRun();
    await runner.run(config);

    compiledActual = JSON.parse(readFileSync(resolve(outputDir, 'compiled-policy.json'), 'utf-8'));
    const listsPath = resolve(outputDir, 'dynamic-lists.json');
    listsActual = existsSync(listsPath) ? JSON.parse(readFileSync(listsPath, 'utf-8')) : undefined;

    if (CAPTURE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(GOLDEN_COMPILED, JSON.stringify(compiledActual, null, 2) + '\n');
      if (listsActual !== undefined) {
        writeFileSync(GOLDEN_LISTS, JSON.stringify(listsActual, null, 2) + '\n');
      }
    }
  });

  it('produces compiled-policy.json matching the committed golden', () => {
    expect(existsSync(GOLDEN_COMPILED)).toBe(true);
    const golden: unknown = JSON.parse(readFileSync(GOLDEN_COMPILED, 'utf-8'));
    expect(normalizeForComparison(compiledActual)).toEqual(normalizeForComparison(golden));
  });

  it('produces dynamic-lists.json matching the committed golden', () => {
    expect(existsSync(GOLDEN_LISTS)).toBe(true);
    const golden: unknown = JSON.parse(readFileSync(GOLDEN_LISTS, 'utf-8'));
    expect(normalizeForComparison(listsActual)).toEqual(normalizeForComparison(golden));
  });

  it('compiled policy contains the expected deterministic rule set', () => {
    const compiled = compiledActual as { rules: Array<{ name: string }>; listDefinitions?: unknown[] };
    expect(compiled.rules.map((r) => r.name)).toEqual(['allow-trusted-news', 'allow-temp-reads']);
    expect(compiled.listDefinitions).toBeDefined();
  });

  it('resolveRulePaths canonicalizes the paths.within value (transform branch ran)', () => {
    // The fixture feeds an already-canonical path; resolveRulePaths' transform
    // branch still executes. The concrete resolved value is platform-dependent
    // (normalized out of the golden compare) so assert it explicitly here.
    const compiled = compiledActual as {
      rules: Array<{ name: string; if: { paths?: { within?: string } } }>;
    };
    const pathRule = compiled.rules.find((r) => r.name === 'allow-temp-reads');
    expect(pathRule?.if.paths?.within).toBe(GOLDEN_WITHIN_PATH);
  });
});
