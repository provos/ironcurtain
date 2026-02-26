# Testing Guide

## Quick Start

```bash
npm test          # Run all unit/component tests — no API keys or Docker needed
npm run lint      # Lint
npm run format:check  # Check formatting
```

## Test Categories

| Category | Example files | Requirements | Runs by default |
|----------|--------------|--------------|-----------------|
| **Unit** | `policy-engine.test.ts`, `argument-roles.test.ts` | None | Yes |
| **Component (mocked LLM)** | `auto-approver.test.ts`, `constitution-compiler.test.ts` | None (uses `MockLanguageModelV3`) | Yes |
| **Integration (MCP servers)** | `integration.test.ts`, `mcp-proxy-server.test.ts` | Real MCP server processes spawn; ~30s timeout | Yes |
| **Sandbox integration** | `sandbox-integration.test.ts` | `bubblewrap` + `socat` installed | Auto-skipped if unavailable |
| **LLM integration** | `auto-approver-integration.test.ts`, `escalation-scenarios.test.ts` (Suite B) | `LLM_INTEGRATION_TEST=true` + `ANTHROPIC_API_KEY` | No |
| **Docker integration** | `network-isolation.integration.test.ts` | `INTEGRATION_TEST=true` + Docker + `ironcurtain-base:latest` image | No |

## Environment Flags

### `LLM_INTEGRATION_TEST`

Gates tests that call a live LLM API. Requires a valid `ANTHROPIC_API_KEY` (set via environment variable or `.env` file).

```bash
LLM_INTEGRATION_TEST=true npm test -- test/auto-approver-integration.test.ts
LLM_INTEGRATION_TEST=true npm test -- test/escalation-scenarios.test.ts
```

### `INTEGRATION_TEST`

Gates tests that require Docker infrastructure (containers, network isolation, MITM proxies).

```bash
INTEGRATION_TEST=true npm test -- test/network-isolation.integration.test.ts
```

You can set both flags simultaneously to run everything:

```bash
LLM_INTEGRATION_TEST=true INTEGRATION_TEST=true npm test
```

## Running Specific Tests

```bash
# Single file
npm test -- test/policy-engine.test.ts

# Pattern match
npm test -- -t "denies delete_file"

# Watch mode
npm test -- --watch test/policy-engine.test.ts
```

## Writing Tests

### Conventions

- **Mocking LLMs**: Use `MockLanguageModelV3` from `ai/test` for deterministic LLM responses. See `test/auto-approver.test.ts` for examples.
- **Temp directories**: Integration tests that create temp directories should use `mkdtempSync` in `beforeAll`/`beforeEach` and `rmSync` in `afterAll`/`afterEach`. Use `/tmp/` as the base.
- **Timeouts**: Tests spawning MCP server processes or calling live APIs should set a 30s timeout: `it('...', async () => { ... }, 30_000)`.
- **Fixtures**: Shared test fixtures live in `test/fixtures/` (e.g., `test-policy.ts`, `escalation-scenarios.ts`).
- **ESM imports**: Use `.js` extensions in import paths (TypeScript convention for ESM).

### Test file naming

- `*.test.ts` — standard tests (unit, component, integration with mocked dependencies)
- `*.integration.test.ts` — tests requiring external infrastructure (Docker, real network)

## Pre-commit Hook

A pre-commit hook runs `format:check` and `lint` before every commit, catching issues early. Install it once after cloning:

```bash
npm run setup-hooks
```

This copies the hook from `.hooks/pre-commit` into `.git/hooks/`. See [CONTRIBUTING.md](CONTRIBUTING.md#pre-commit-hook) for details on fixing blocked commits.

## CI

GitHub Actions runs `npm test` on every push and PR. This executes all unit, component, and MCP integration tests. LLM integration tests (`LLM_INTEGRATION_TEST`) and Docker integration tests (`INTEGRATION_TEST`) are **not** run in CI — they require API keys and Docker infrastructure that aren't available in the CI environment.
