# Tests

## Running tests

```bash
# Run all tests (safe — no LLM calls by default)
npm test

# Run a single test file
npm test -- test/policy-engine.test.ts

# Run a single test by name
npm test -- -t "denies delete_file"

# Run tests that require real LLM API calls (costs money)
INTEGRATION_TEST=true npm test
```

## Test overview

### Integration tests (spawn real processes)

These tests start real MCP server child processes and need ~30s timeout.

| File | What it tests |
|------|---------------|
| `integration.test.ts` | `TrustedProcess` end-to-end with a real `@modelcontextprotocol/server-filesystem`. Covers policy evaluation, escalation approval/denial, root expansion, and audit logging. |
| `sandbox-integration.test.ts` | OS-level sandboxing via `srt` (bubblewrap + socat). Skipped automatically when sandbox dependencies are not installed. |

### Tests that make real LLM calls

These are gated behind `INTEGRATION_TEST=true` and require `ANTHROPIC_API_KEY`. They use Claude Haiku and cost fractions of a cent per run, but be aware they hit a live API.

| File | What it tests |
|------|---------------|
| `auto-approver-integration.test.ts` | Auto-approve decision quality across ~25 scenarios against a live Haiku model. |
| `escalation-scenarios.test.ts` (Suite B only) | Auto-approver on escalation scenarios with live LLM. Suite A (policy engine checks) always runs and is free. |

### Unit tests (no external calls)

Everything else mocks LLM calls via `MockLanguageModelV3` from `ai/test` or `vi.mock()`. These are fast and free.

## Test fixtures

`test/fixtures/test-policy.ts` provides deterministic compiled policy and tool annotations so tests don't depend on LLM-generated artifacts in `src/config/generated/`.
