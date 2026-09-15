# Testing Guide

## Quick Start

```bash
npm test          # Run root and web UI suites; environment-dependent tests may skip
npm test -w packages/memory-mcp-server  # Separate memory suite, including real model tests
npm run lint      # Lint
npm run format:check  # Check formatting
```

## Test Categories

| Category                        | Example files                                                                                                 | Requirements                                                                    | Runs by default             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| **Unit**                        | `policy-engine.test.ts`, `argument-roles.test.ts`, `domain-utils.test.ts`                                     | None                                                                            | Yes                         |
| **Component (mocked LLM)**      | `auto-approver.test.ts`, `constitution-compiler.test.ts`, `constitution-generator.test.ts`                    | None (uses `MockLanguageModelV3`)                                               | Yes                         |
| **Integration (MCP servers)**   | `integration.test.ts`, `mcp-proxy-server.test.ts`, `proxy-integration.test.ts`                                | Real MCP server processes spawn; ~30s timeout                                   | Yes                         |
| **Sandbox integration**         | `sandbox-integration.test.ts`                                                                                 | `bubblewrap` + `socat` installed (Linux only)                                   | Auto-skipped if unavailable |
| **Isolated VM**                 | `help-integration.test.ts`, `docker-code-mode.integration.test.ts`                                            | `isolated-vm` native module works on current Node version                       | Auto-skipped if unavailable |
| **LLM integration**             | `auto-approver-integration.test.ts`, `escalation-scenarios.test.ts` (Suite B), `help-llm-integration.test.ts` | `LLM_INTEGRATION_TEST=true` + `ANTHROPIC_API_KEY`                               | No                          |
| **Docker integration**          | `network-isolation.integration.test.ts`                                                                       | Linux + `INTEGRATION_TEST=1` + Docker + `ironcurtain-base:latest` image         | No                          |
| **Live registry integration**   | `test/docker/registry-egress-live.integration.test.ts`                                                        | Internet access + `REGISTRY_EGRESS_LIVE_INTEGRATION=1`                          | No                          |
| **Nested-Docker qualification** | `scripts/qualify-backend.ts`                                                                                  | An admitted macOS or WSL2/Desktop backend, Go, agent images, and public network | No                          |
| **Auth**                        | `test/auth/oauth-flow.test.ts`, `test/auth/oauth-token-store.test.ts`                                         | None                                                                            | Yes                         |
| **Docker subsystem**            | `test/docker/registry-proxy.test.ts`, `test/docker/package-validator.test.ts`                                 | None                                                                            | Yes                         |
| **Signal**                      | `test/signal/setup-signal.test.ts`, `test/signal/markdown-to-signal.test.ts`                                  | None                                                                            | Yes                         |
| **PTY (platform-specific)**     | `pty-session.test.ts` (some cases)                                                                            | Linux + `socat`                                                                 | Auto-skipped on non-Linux   |

## Environment Flags

### `LLM_INTEGRATION_TEST`

Gates tests that call a live LLM API. Requires a valid `ANTHROPIC_API_KEY` (set via environment variable or `.env` file).

```bash
LLM_INTEGRATION_TEST=true npm test -- test/auto-approver-integration.test.ts
LLM_INTEGRATION_TEST=true npm test -- test/escalation-scenarios.test.ts
LLM_INTEGRATION_TEST=true npm test -- test/help-llm-integration.test.ts
```

### `INTEGRATION_TEST`

Gates tests that require Docker infrastructure (containers, network isolation, MITM proxies).

```bash
INTEGRATION_TEST=1 npm test -- test/network-isolation.integration.test.ts
```

### `REGISTRY_EGRESS_LIVE_INTEGRATION`

Runs the production registry-egress policy against anonymous Docker Hub and GHCR pulls:

```bash
npm run test:registry-live
```

### Nested-Docker release qualification

Run the gate for each advertised backend from the exact release candidate on the corresponding host:

```bash
npm run qualify:apple
npm run qualify:docker-desktop
# On WSL2 with Docker Desktop (amd64):
npm run qualify:wsl-desktop
npm run test:registry-live
```

`qualify:apple` builds the current tree, rejects any skipped/pending/todo selected test, and runs the
production workflow separately in `packages`, `images`, and `offline` modes before the PTY transport
gate. `qualify:docker-desktop` applies the same no-skip rule and runs coordinator-crash recovery,
feature-off, PTY, offline, images, and packages gates. `qualify:wsl-desktop` prepares Claude Code, Goose,
and Codex images, runs the selected no-skip suite including UDS boundary and identity checks, then runs
the six direct gates plus three workflow-mode gates. The CLI/PTY/workflow live gates use Claude; image
and UID tests do not establish all-mode qualification for every adapter.

These commands create isolated runtime resources and require exact cleanup; none is part of ordinary
CI. Evidence is retained even on failure. Use `-- --report-dir <directory>` to choose a durable report
location. Default suite/direct-gate limits are 30 minutes; workflow gates use a longer budget derived
from the workflow deadline plus child-process and cleanup allowances. To override a gate's bound, append
`-- --timeout-ms <milliseconds>`; an explicit override also replaces the longer workflow budget.

WSL admission requires a regular non-root coordinator, Docker Desktop Linux/amd64, cgroup v2, and the
covered security options. Native Linux Engine and WSL arm64 are not admitted. The separate real
non-1000 WSL host-identity test requires host sudo and is still pending in the
[acceptance record](docs/designs/linux-nested-docker-implementation-plan.md); ordinary container UID
tests do not replace it. The same record and [handoff](docs/designs/secure-nested-runtime-handoff.md)
distinguish historical evidence from current-tree validation.

Run the memory suite separately from the full root suite on resource-constrained hosts: real model
loading competes with parallel tests for CPU and can exceed test deadlines. It needs model files in
cache or network access to download them, even though mocked LLM tests need no API key.

You can set both general-suite flags simultaneously:

```bash
LLM_INTEGRATION_TEST=true INTEGRATION_TEST=1 npm test
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
- **Helpers**: Shared test utilities live in `test/helpers/`:
  - `isolated-vm-available.ts` — probes whether `isolated-vm` works on the current Node version (spawns a child process to avoid crashes).
  - `config-test-setup.ts` — environment isolation for config-related tests (`setupConfigEnv`/`teardownConfigEnv`), plus `seedConfig`/`readConfig` helpers.
  - `uds-client-transport.ts` — MCP client transport over Unix domain sockets, used by integration tests.
- **ESM imports**: Use `.js` extensions in import paths (TypeScript convention for ESM).
- **Conditional execution**: Use `describe.skipIf(condition)` or `it.skipIf(condition)` (vitest built-ins) to skip tests when prerequisites are missing. Common conditions: `!process.env.LLM_INTEGRATION_TEST`, `!process.env.INTEGRATION_TEST`, `!isIsolatedVmAvailable()`, `process.platform !== 'linux'`.

### Test file naming

- `*.test.ts` — standard tests (unit, component, integration with mocked dependencies)
- `*.integration.test.ts` — tests requiring external infrastructure (Docker, real network)

### Test subdirectories

Tests for self-contained subsystems live in subdirectories under `test/`:

- `test/auth/` — OAuth flows, token storage, provider registry, Google scopes
- `test/docker/` — Docker-specific utilities (registry proxy, package validator)
- `test/signal/` — Signal messaging integration (formatting, setup, markdown conversion)

## Pre-commit Hook

A pre-commit hook runs `lint-staged` on matching staged files, checking formatting and lint (plus web UI
checks where configured). It is not a full-repository validation gate. Install it once after cloning:

```bash
npm run setup-hooks
```

This copies the hook from `.hooks/pre-commit` into `.git/hooks/`. See [CONTRIBUTING.md](CONTRIBUTING.md#pre-commit-hook) for details on fixing blocked commits.

## CI

GitHub Actions tests Node 24 and 26 on Ubuntu and macOS for qualifying pushes to `master` and pull
requests targeting it; documentation-only changes are excluded by the CI path filters. Each job builds
the memory workspace and application, checks formatting, lint and import cycles, then runs `npm test`
(root plus web UI suites). A separate Go job verifies the generated build-trust runtime. The standalone
memory workspace tests require their own command above; the ordinary CI job does not run that suite.
LLM integration tests and opt-in Docker/registry/backend qualification gates are not enabled by these
jobs. Green CI therefore does not replace live backend qualification or a fresh installed-package test.

For dependency maintenance, keep Aikido Safe Chain enabled and verify it with
`npm safe-chain-verify` (or use `aikido-npm` explicitly when shell aliases are not loaded).
See [dependency security maintenance](docs/dependency-security.md) for the distinction between a clean
checkout audit and downstream npm installation.
