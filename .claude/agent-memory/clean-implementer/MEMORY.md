# IronCurtain Clean Implementer Memory

Index only — one line per entry. Durable detail lives in the linked topic files.
A named symbol/path in a topic file is a claim about a past state; grep/read to
confirm it still exists before acting.

## Architecture map & inlined detail
- [Architecture notes](architecture-notes.md) — the big map: PolicyEngine/session/pipeline/persona/docker-broker/goose/oauth/dynamic-lists/multi-provider file inventories, AI SDK v6 type + mock gotchas, deny-default model, session-test mocking, MCP roots, daemon control socket, tool-call coordinator, testing gotchas.

## Feature areas (topic files)
- [Web-UI PTY serialize Gate-0](webui-pty-serialize-gate0.md) — spike verdict PASS: @xterm/addon-serialize@0.14.0 + @xterm/headless@6.0.0 faithfully round-trips alt-screen TUIs (build on serialize(), no ring-buffer); pinning/ESM-interop/excludeAltBuffer/byte-budget gotchas.
- [Daemon WS JSON-RPC client](daemon-ws-jsonrpc-client.md) — wire protocol, workflow RPC methods, terminal-event-vs-phase mismatch (gate ABORT→`completed`/phase `aborted`; RPC abort→`failed`/phase `aborted`), WorkflowManager session-factory DI seam, builtin-mode test fixture.
- [Evolve N-way fan-out](evolve-fanout.md) — lane-template/orchestrator/bridge layering, barrier-owned stop_signals, per-lane slug collision fix, `ruff check`-only Python gate, best-effort token attribution.
- [Evolve memory-fusion dogfood](evolve-memory-fusion-dogfood.md) — `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS=1` lets HF download through proxy in-container; dump-tap src/rootDir layering + MEMORY_FIXTURE_DUMP_MODULE abs-path; LoCoMo cat-5 has evidence; fixture builder via MemoryEngine directly.
- [OpenRouter profiles](openrouter-profiles.md) — G1 modelProviders registry (user-config.ts discriminated union, resolveModelProviders/resolveActiveProfile) + G2 src/docker/openrouter.ts transform; RequestBodyRewriter.cacheKey + IronCurtainConfig.activeProviderProfile; later-gate seams.
- [Web-UI combobox portal + jsdom gotchas](web-ui-combobox-portal.md) — presentational `features/` combobox (no store import; route owns fetch), portal-to-body popover action + fixed-position/capture-scroll, Escape stopPropagation vs Modal; jsdom traps (no `CSS` global, `scrollIntoView` absent, `commit()` must not re-focus → onfocus reopen); new-store-action vi.mock/beforeEach contract.
- [Golden-QA fixture pipeline](golden-qa-fixture-pipeline.md) — `benchmark/golden/` stages; `--n`/`--tier-mix` clobber gotcha; conversation-centroid clustering phase transition; synthetic-union (M6) Tier-B scaler via fact-embedding k-means; pilot baselines.
- [memory-mcp-server](memory-mcp-server.md) — MemoryEngine/EngineModules seam, store/insert/merge internals (updateMemoryContent stamps updated_at=now & MAX importance), real-embedder+mocked-LLM test pattern, memory-ingest §5.4/§11 updated_at inconsistency.
- [Web UI testing](web-ui-testing.md) — Svelte 5 stub-component `vi.mock` pattern, App.svelte mocking, drawer query pattern; stubs in `packages/web-ui/src/__test_stubs__/`.
- [Web-UI PTY terminal frontend](web-ui-pty-frontend.md) — web-pty protocol/DTO; pure event-handler -> per-label sink registry seam (`EventSideEffects.getPtySink`, forwards raw base64; component decodes at term.write); pty-codec UTF-8 base64; features/ may import pure leaves (not stores); non-churning `$derived`-primitive attach pattern; `{#key label}` remount; D2 guard; xterm@6/addon-fit@0.11 pins; mock `MOCK_SESSION_MODE=docker`.

## Tooling / build / infra
- [scripts dir tooling](scripts-dir-tooling.md) — `scripts/*.ts` are tsx-run and OUTSIDE eslint+all tsconfigs; how to verify out-of-band; driver-owns-db corpus pattern incl. `NaN as_of` created_at-corruption trap + determinism recipe.
- [Docker build context & UID remap](docker-build-context.md) — clean-context whole-dir copy, build-hash auto-includes all `*.sh`, shared sourced entrypoint helper; issue #232/#291 GID-benign/UID-fatal remap semantics + integration test contract.
- [Docker bind mount staleness](docker-bind-mount-staleness.md) — Linux bind mounts break if source dir is rmSync'd+recreated; per-child wipe preserves parent inode. Nested bind mounts unreliable on Docker Desktop/macOS.
- [Real-container PTY integration testing](pty-integration-testing.md) — macOS 26+ `containerRuntime:'auto'` picks Apple `container` (invisible to `docker ps`) → force `IRONCURTAIN_CONTAINER_RUNTIME=docker`; override `createBridge` to `node --import tsx src/cli.ts` (single-process so node-pty child pid == registration pid discovery keys on); child boots from disk (config.json/generated/ca in IRONCURTAIN_HOME); LLM-free escalation trigger = write `request-*.json` into the discovered escalationDir; `AgentId` branded cast in test/ (test/ isn't build-typechecked).
- [Git stash baseline hazard](git-stash-baseline-hazard.md) — never `git stash pop` for baseline diffing when other stashes exist; recover via `git checkout HEAD -- <files>`; use `git show HEAD:<file>` for baselines.
- [PTY + escalation](pty-escalation.md), [tool-call coordinator](tool-call-coordinator.md), [subsystems](subsystems.md), [createWriteStream sync-vs-async](createWriteStream-sync-vs-async.md) — see files.

## Gate coverage gaps (project gates miss these)
- `npm run build` (`tsc -p tsconfig.json`) EXCLUDES `test/`; `npm run lint` (eslint) does NOT do whole-program structural assignability; `npm test` (vitest/esbuild) strips types without checking. So a test mock typed `: SomeInterface` missing required members passes build+lint+test until the member is actually called at runtime.
- `tsconfig.eslint.json` includes `test/**` but `rootDir: src`, so plain `tsc -p tsconfig.eslint.json` floods TS6059. Use `tsc --rootDir .`, then grep the SPECIFIC symbol you changed; baseline against `git show HEAD:<file>` (NOT `git stash`). Benign coordinator-test noise: `ToolAnnotationsFile` vs `StoredToolAnnotationsFile`.
- Flipping an interface member optional→required surfaces via (1) `--rootDir .` tsc grep AND (2) `npm test` runtime `X.method is not a function` for `as unknown as`-cast stubs (tsc can NEVER catch these). Fix production factory + every annotated mock + every cast stub.
- packages/web-ui: `npm run lint` (eslint) IGNORES `scripts/` AND `src/**/*.svelte.ts` (runes files) — those + all interface-mock typechecks are covered ONLY by `npm run check` (svelte-check), which IS in lint-staged pre-commit. Adding a required `EventSideEffects`/interface member breaks EVERY `createMockEffects`-style factory across ALL test files (event-handler.test.ts AND workflow-events.test.ts); eslint+`build:web-ui`(vite/esbuild) pass anyway — only `npm run check` catches it. Always run `npm run check -w packages/web-ui`.

## Branded-type casting between ID types
- `SessionId`/`BundleId`/`WorkflowId` are `string & { __brand }` with distinct brands (src/session/types.ts, src/workflow/types.ts). Direct cast between them → TS2352; the `as unknown as X` double cast at the identity boundary is REQUIRED — do not "simplify" it.
- A single cast compiles only when the source is plain/widened `string` (e.g. `resumeSessionId ?? sessionId`). Before agreeing to simplify, verify the source is truly branded, not a widened string.
