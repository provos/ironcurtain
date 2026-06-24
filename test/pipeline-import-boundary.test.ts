/**
 * Static import-graph boundary test (Phase 0 tooling).
 *
 * Enforces the layering rule from CLAUDE.md: live-runtime modules must not have
 * a STATIC import path to the pipeline's runtime VALUE modules
 * (`pipeline-runner.ts`, `pipeline-shared.ts`). Value access is only permitted
 * through the sanctioned offline-tooling seams (`compile-persona-policy.ts`,
 * `compile-task-policy.ts`), which are treated as graph cut-points here.
 *
 * Complements the ESLint `no-restricted-imports` rule (which bans the DIRECT
 * import) by also catching TRANSITIVE static reach introduced by an
 * intermediate module — the kind of regression future phases (persona-service)
 * are most at risk of.
 *
 * The import graph is built by a small DETERMINISTIC in-process scanner rather
 * than `madge`. madge's graph computation was observed to be intermittently
 * non-deterministic when run inside a vitest worker concurrently with the
 * CPU-heavy golden/atomicity tests (it occasionally synthesized a spurious
 * transitive dynamic-import edge), producing a rare spurious red. This scanner
 * is a pure function of the source files on disk, so the assertion is identical
 * regardless of worker scheduling, parallelism, or CPU contention.
 *
 * Edge semantics (intentionally narrow, matching the layering rule):
 *  - STATIC value imports only. `import type {...}` / `export type {...}`
 *    statements are excluded (type-only contracts are always allowed). A mixed
 *    `import { foo, type Bar }` still counts as a value edge (it pulls a value).
 *  - DYNAMIC `import(...)` / `await import(...)` expressions are excluded, so
 *    reaching pipeline code via a runtime dynamic import (the sanctioned seam
 *    pattern) is allowed.
 *  - Only relative specifiers are followed and only those resolving to a `.ts`
 *    file under `src/` (the `.js` extension in the specifier maps to `.ts`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

/** Forbidden pipeline runtime VALUE modules (graph keys, relative to repo root). */
const FORBIDDEN = new Set(['src/pipeline/pipeline-runner.ts', 'src/pipeline/pipeline-shared.ts']);

/** Sanctioned offline-tooling seams — graph traversal stops here. */
const SEAMS = new Set(['src/persona/compile-persona-policy.ts', 'src/cron/compile-task-policy.ts']);

/**
 * Live-runtime modules that must not statically reach pipeline value modules.
 * Entries are graph keys (relative to repo root). Files that do not yet exist
 * (persona-service lands in a later phase) are skipped — the assertion
 * activates automatically once they appear.
 */
const TARGETS = [
  'src/web-ui/dispatch/persona-dispatch.ts',
  'src/persona/persona-service.ts',
  'src/persona/persona-compile-orchestrator.ts',
  'src/persona/event-bus-progress-reporter.ts',
];

type Graph = Record<string, string[]>;

/** Recursively lists all `.ts` files under `dir` (skips `.d.ts`). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Matches statement-level STATIC imports/exports that pull a VALUE:
 *   import ... from '...'        (incl. default, namespace, named, side-effect)
 *   export ... from '...'        (re-exports)
 * but NOT `import type ... from` / `export type ... from` (type-only).
 * Inline `type` modifiers inside the braces (`import { type Foo }`) do not
 * exclude the statement — if any value binding is present it is a value edge,
 * and a fully-inline-type import is a rare, harmless over-count for this rule.
 *
 * Dynamic `import('...')` is NOT matched: it has no `from` keyword and is an
 * expression, so it never matches these statement-anchored patterns.
 */
const STATIC_VALUE_IMPORT = /(?:^|;|\n)\s*(?:import|export)(?!\s+type\b)[^;'"\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|;|\n)\s*import\s+['"]([^'"]+)['"]/g;

/** Strips // line comments and block comments so commented-out imports are ignored. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Resolves a relative `.js` specifier from `fromFile` to a repo-relative `.ts`
 * graph key, or null if it does not resolve to a `.ts` file under src/.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // only relative (intra-repo) edges
  const base = resolve(dirname(fromFile), spec);
  // Specifiers use the ESM `.js` extension; map to the `.ts` source.
  const candidates = base.endsWith('.js') ? [base.replace(/\.js$/, '.ts')] : [`${base}.ts`, resolve(base, 'index.ts')];
  for (const cand of candidates) {
    if (existsSync(cand) && statSync(cand).isFile()) {
      return relative(ROOT, cand).split('\\').join('/');
    }
  }
  return null;
}

/** Builds the static value-import graph over all `.ts` files under src/. */
function buildGraph(): Graph {
  const graph: Graph = {};
  for (const file of listTsFiles(SRC)) {
    const key = relative(ROOT, file).split('\\').join('/');
    const src = stripComments(readFileSync(file, 'utf-8'));
    const deps = new Set<string>();
    for (const re of [STATIC_VALUE_IMPORT, SIDE_EFFECT_IMPORT]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const resolved = resolveSpecifier(file, m[1]);
        if (resolved) deps.add(resolved);
      }
    }
    graph[key] = [...deps];
  }
  return graph;
}

/**
 * BFS from `entry` over the static import graph, stopping at sanctioned seams.
 * Returns the first forbidden module reached, or null if none.
 */
function firstForbiddenReach(graph: Graph, entry: string): string | null {
  const seen = new Set<string>([entry]);
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const dep of graph[cur] ?? []) {
      if (SEAMS.has(dep)) continue; // do not traverse into the sanctioned seam
      if (FORBIDDEN.has(dep)) return dep;
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return null;
}

describe('Pipeline import boundary (static graph)', () => {
  let graph: Graph;

  beforeAll(() => {
    graph = buildGraph();
  });

  it('scanner produced a non-empty graph rooted at src/', () => {
    expect(Object.keys(graph).length).toBeGreaterThan(0);
    // Sanity: the forbidden modules must exist in the graph, otherwise the key
    // format changed and the assertions below would be vacuously true.
    expect(graph['src/pipeline/pipeline-runner.ts']).toBeDefined();
    expect(graph['src/pipeline/pipeline-shared.ts']).toBeDefined();
    // Sanity: the sanctioned seam DOES statically reach the pipeline runner —
    // proving the scanner sees value edges (and that the seam-cut below is load
    // bearing). If this regresses to false the edge-detection broke.
    expect(graph['src/persona/compile-persona-policy.ts']).toContain('src/pipeline/pipeline-runner.ts');
  });

  for (const target of TARGETS) {
    it(`${target} has no static value-path to pipeline runtime (except via sanctioned seams)`, () => {
      if (!existsSync(resolve(ROOT, target))) {
        // File not created yet (later phase). The guard activates when it lands.
        return;
      }
      const reached = firstForbiddenReach(graph, target);
      expect(
        reached,
        `${target} statically reaches forbidden pipeline value module "${reached ?? ''}". ` +
          `Use 'import type' for contracts, or reach pipeline code via the sanctioned ` +
          `dynamic-import seam (compile-persona-policy.ts / compile-task-policy.ts).`,
      ).toBeNull();
    });
  }
});
