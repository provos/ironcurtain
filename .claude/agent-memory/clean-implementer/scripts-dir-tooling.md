# `scripts/` directory: tooling boundaries (tsx-run drivers)

`scripts/*.ts` are tsx-run utilities, NOT part of the project's compile/lint gates:

- **eslint ignores `scripts/`** (`eslint.config.js` ignore list, ~line 14). `npm run lint` skips them entirely. Plain `npx eslint scripts/...` emits only a "File ignored" warning.
- **No tsconfig includes `scripts/`.** Root `tsconfig.json` has `rootDir: src` + `include: ['src/**/*']`; `tsconfig.eslint.json` adds `test/**` + `examples/**` but NOT `scripts/**`. So `npm run build` and `npx tsc -p` never typecheck script files.
- Consequence: a new driver script can have type errors / lint violations that NO project gate catches. To honor a "tsc clean + lint clean" finish criterion you must verify them OUT-OF-BAND:
  - typecheck: `npx tsc --noEmit --strict --target ES2022 --module Node16 --moduleResolution Node16 --esModuleInterop --resolveJsonModule --skipLibCheck <file.ts>` (standalone, no project).
  - type-aware lint: eslint's type-aware rules need the file in `parserOptions.project`. Make a throwaway repo-root `tsconfig.<x>.tmp.json` that `include`s the script dir (relative include resolves against the tsconfig's own dir — keep it AT repo root, not /tmp), plus a tiny `eslint.<x>.tmp.mjs` that imports `./eslint.config.js` and rewrites the project to the temp tsconfig; run `npx eslint --no-ignore --config ./eslint.<x>.tmp.mjs <files>`; delete both temps after.
  - This is how I caught two real `@typescript-eslint/no-unnecessary-condition` errors that the standard gates hid.
- A root `test/**` test importing `../scripts/...` IS covered by `tsconfig.eslint.json` and root vitest (`include: ['test/**/*.test.ts']`), so the test file itself lints/typechecks normally — factor pure logic into a `scripts/<x>/corpus-lib.ts` and test THAT.

## `typecheck:scripts` gate (added on feat/memory-ingest)
- There IS now a committed type-check target: `npm run typecheck:scripts` → `tsc --noEmit -p tsconfig.scripts.json` (repo root). The tsconfig replicates the standalone flags (ES2022/Node16/Node16/strict/skipLibCheck/esModuleInterop/resolveJsonModule) as a real project file. This makes the previously-uncaught "scripts are outside every tsconfig" class of error gateable.
- **Scoping decision (deliberate):** `include` is `scripts/memory-corpus/**/*.ts` + the two root tests that import them (`test/build-corpus.test.ts`, `test/diagnose-corpus.test.ts`) — NOT the whole `scripts/**`. A broad `scripts/**/*.ts` glob is RED on day one: stale debug scripts reference renamed/removed symbols (e.g. `debug-mcp-errors.ts` → `handleCallTool` no longer exported by `mcp-proxy-server.ts`; `show-system-prompt.ts` → `claudeCodeAdapter` renamed to `createClaudeCodeAdapter`). A gate that's red on unrelated dead code is not runnable, so scope to the live corpus driver set. If you later widen the glob, you must first fix/delete those two stale scripts.
- Verified the gate catches the real error class by temporarily removing `segment_id: null` from `candidateToRow` in `diagnose-lib.ts` → reproduces `TS2741: Property 'segment_id' is missing ... in type 'MemoryRow'`.

## Driver-owns-DB corpus/fixture pattern (memory-mcp-server)
- Single Node process via tsx imports engine internals directly (e.g. `ingestBlob` from `engine-impl.js`, `initDatabase`, `runConsolidation`, `getNamespaceStats`). Set `MEMORY_*` env BEFORE `loadConfig()`.
- `as_of`/`createdAt` corruption trap: the engine does `now = params.createdAt ?? Date.now()`. `NaN ?? x === NaN` (NaN is not nullish), so passing `Date.parse(badISO)` (=NaN) writes `NaN` into the INTEGER created_at column and silently destroys the recency spread. ALWAYS resolve `as_of` through a guard that returns `undefined` on non-finite (`Number.isFinite`), never raw `Date.parse`.
- Determinism for backdated bulk loads: per-store `maybeRunMaintenance` runs the full `runMaintenance` incl. a DECAY phase keyed on `now - created_at`; backdated multi-year facts get decayed mid-bulk. Suppress via very high `MEMORY_MAINTENANCE_INTERVAL` (1e8) + `MEMORY_DECAY_THRESHOLD=0`, and run `runConsolidation` ONLY at the end (never `runMaintenance`).
