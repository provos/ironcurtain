# OpenRouter Integration — G12 Completion Report

**Branch:** `feature/openrouter-profiles` · **Spec:** [`openrouter-integration.md`](openrouter-integration.md) (Design v3, gates G1–G13) · **Date:** 2026-07-03

## Gate verdicts

| Gate | Verdict | Evidence |
| --- | --- | --- |
| G1 config schema & resolution | **PASS** | `test/user-config.test.ts` 103 passed |
| G2 transform module | **PASS** | `test/docker/openrouter.unit.test.ts` 37 passed; D1/D3/D4 fidelity confirmed by independent review |
| G3 MITM wiring | **PASS** | `test/docker/openrouter-mitm.test.ts` 12 passed (§12.2 assertions 1–11); mitm regression suites 120 passed |
| G4 infra bundle / profile stamp | **PASS** | `test/docker-infrastructure.test.ts` 57 passed; stamp verified before auth detection |
| G5 adapters (claude-code, codex, goose) | **PASS** | `test/docker/openrouter-agent-session.test.ts` 34 passed; adapter regression suites 132 passed; codex TOML parsed with real TOML parser |
| G6 cost accounting | **PASS** | GLM pricing 35 passed; named D6 test "prefers summed authoritative usage.cost over CLI costUsd" + fallbacks passed |
| G7 CLI editor (Model Providers menu) | **PASS** | `test/config-command.test.ts` 32 passed incl. m14 no-op-empty-diff and F10 default re-point; PTY smoke renders menu |
| G8 web-UI backend (`config.*`) | **PASS** | `src/web-ui/__tests__/config-dispatch.test.ts` 15 passed incl. M5 mask-unchanged round-trip, F7 native-drop, F10 |
| G9 web-UI Settings view | **PASS** | web-ui workspace 418 passed (incl. Settings component + helpers); Playwright e2e 90 passed (4 new Settings specs) |
| G10 docker integration (token-free) | **PASS — RAN** | Both scenarios executed on real Docker (macOS Docker Desktop): Scenario A (CONNECT allowlist, `api.anthropic.com` refused, bearer swap) and Scenario B (real `claude` CLI turn against fake OpenRouter upstream — model rewritten to `z-ai/glm-5.2`, `session_id` injected, swapped key observed, turn exit 0). 4 tests passed, stable across 3 runs, zero provider tokens |
| G11 documentation | **PASS** | grep gates green: "First-class OpenRouter" + "Quickstart: GLM-5.2 via OpenRouter" in MODEL_ROUTING.md, `"modelProviders"` in CONFIG.md; README + src/docker/CLAUDE.md updated |
| G13 session selection + mux picker | **PASS** | 126 passed across 5 suites: `--provider-profile`, `/new` picker snapshot, `buildSpawnArgs`, resume persistence (both SessionSnapshot and SessionMetadata), default-change independence, cross-session isolation |
| **G12 full-feature revalidation** | **PASS** | See below |

## G12 revalidation record

- `npm run format:check` — clean for every branch-touched file (21 pre-existing failures on `master` are untouched and out of scope).
- `npm run lint` — clean.
- `npm run build` — clean (tsc + config assets + web UI bundle).
- `npm test` (full) — root: **250 files passed / 17 skipped; 5413 tests passed / 111 skipped / 1 todo; 0 failures**. web-ui workspace: **24 files, 418 passed**.
- `ironcurtain config` smoke — piped run exits 0 via TTY guard; PTY run renders the Model Providers menu without throwing.
- OpenRouter-off regression: full suite green with no behavioral changes for `native`-profile sessions (adapter suites assert byte-identical env).

### Environment-gated tests — RAN vs SKIPPED (D7)

| Suite | Status |
| --- | --- |
| `test/docker/openrouter-connect.integration.test.ts` (G10) | **RAN** — 4/4 passed with `INTEGRATION_TEST=true` on real Docker; SKIPPED (by design) inside the plain `npm test` run |
| Other 16 `INTEGRATION_TEST`/`LLM_INTEGRATION_TEST`-gated suites | **SKIPPED** (env vars unset — pre-existing gating, unrelated to this feature) |
| `test/docker/openrouter-live.integration.test.ts` (§12.5) | Skip-gating verified (1 skipped, exit 0, without env opt-in). Live execution: see R6 below |

### R6 live cache-hit verification

`OPENROUTER_API_KEY` is present in the implementing environment (`.env`), so per D7 the live test must be executed once and recorded.

**R6 live verification: VERIFIED — cache hit observed on turn 2 (2026-07-03).**

Run via `npm run openrouter-live-check` against real `openrouter.ai/api/v1/messages` with model `z-ai/glm-5.2`, `provider: { only: ["z-ai"] }`, and a stable `session_id`. Turn-2 usage (verbatim):

```json
{"input_tokens":34,"output_tokens":13,"output_tokens_details":{"thinking_tokens":10},"cache_creation_input_tokens":null,"cache_read_input_tokens":192,"cache_creation":null,"cost":0.00015472,"is_byok":false,"cost_details":{"upstream_inference_cost":0.00015472,"upstream_inference_prompt_cost":0.00009752,"upstream_inference_completions_cost":0.0000572}}
```

- **`cache_read_input_tokens: 192` > 0** — the shared prefix (system prompt + turn-1 messages) was served from Z.ai's implicit cache. GLM-5.2 caching through OpenRouter works end-to-end as designed (D3 z-ai pin + D4 session affinity).
- Authoritative `usage.cost` present (`0.00015472` USD) — confirms the G6 cost-extraction contract.
- **Field-shape finding:** the Anthropic skin reports cache reads via the Anthropic-native `cache_read_input_tokens`, NOT the OpenAI-shape `prompt_tokens_details.cached_tokens` the spec's §4.4 anticipated. The live test's first execution failed on that assertion despite the cache hit; the test was corrected to read `cache_read_input_tokens` (with the OpenAI-shape field as fallback).

> Execution was delayed by a multi-hour Claude Code harness Bash-classifier outage; the run was ultimately performed via the user's direct shell.

## Commits on `feature/openrouter-profiles`

1. `8879831` docs(design): OpenRouter provider-profiles spec (v3, gates G1-G13)
2. `2948d91` feat(config): modelProviders profile registry with implicit native profile (G1)
3. `ad36625` feat(docker): OpenRouter transform module - glob mapping, session affinity, provider factory (G2)
4. `4286aaa` feat(docker): path-aware MITM wiring for openrouter.ai - cacheKey threading, usage cost extraction (G3)
5. `6d4509e` feat(docker): stamp active provider profile on session config, resolveRealKey + fail-fast (G4)
6. `65aa657` feat(docker): route all three agents through OpenRouter profiles - adapters, credentials, entrypoint (G5)
7. `77f4687` feat(session,mux): per-session provider profile selection - --provider-profile, /new picker, resume persistence (G13)
8. `49fb99a` feat(session): prefer authoritative OpenRouter usage.cost over CLI self-report, GLM pricing (G6)
9. `e4a2ec8` feat(config): Model Providers menu in interactive config editor (G7)
10. `73904f1` feat(web-ui): Settings view + gated config.getModelProviders/setModelProviders dispatch (G8, G9)
11. `96edab0` test(docker): token-free OpenRouter integration - CONNECT allowlist, bearer swap, real-agent turn (G10)
12. `1fab66d` docs: first-class OpenRouter - quickstart, modelProviders reference, docker module notes (G11)
13. _(pending)_ test(docker): opt-in live OpenRouter cache-hit verification (spec 12.5)

## Known deviations from spec (all reviewed, accepted)

- `src/session/preflight.ts` extended so the interactive credential banner recognizes OpenRouter-only users (resolves the config-default profile; per-session flag not visible to preflight — documented in code).
- G10 Scenario B uses a host-TCP + `host.docker.internal` harness instead of the UDS bind-mount pattern (macOS Docker Desktop cannot proxy UDS connects through VirtioFS); portable to Linux.
- `maskApiKey`/F10-repoint logic duplicated in `config-dispatch.ts` rather than importing from the interactive CLI module (avoids pulling `@clack/prompts` into the daemon bundle).
