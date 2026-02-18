# IronCurtain Architecture Notes

## Key Files
- `src/trusted-process/policy-engine.ts` - hardcoded policy rules (first-match-wins chain)
- `src/trusted-process/policy-types.ts` - PolicyRule interface (function-based condition)
- `src/types/mcp.ts` - ToolCallRequest, PolicyDecision, ToolCallResult
- `src/config/constitution.md` - 6 principles, filesystem-only
- `docs/secure-agent-runtime-v2.md` - full v0.3 architecture vision
- `docs/ironcurtain-poc-handoff.md` - PoC handoff with design decisions

## Architecture Patterns
- **Policy evaluation**: ordered rule chain, first match wins, default deny
- **Three-state decisions**: `allow | deny | escalate` (PolicyDecisionStatus)
- **Tool naming**: `serverName__toolName` format
- **Path security**: `node:path.resolve()` before directory containment checks
- **Protected files**: substring matching against PROTECTED_PATTERNS array
- **Tool classification**: READ_TOOLS, WRITE_TOOLS, DELETE_TOOLS sets (hardcoded)

## Policy Evaluation Order (from architecture doc)
1. Structural invariants (hardcoded, never overridden)
2. Task policy (most restrictive, per-task) -- NOT YET IMPLEMENTED
3. Compiled constitution (deterministic first, then LLM assessment)
4. Default deny

## Current PolicyRule Interface
```typescript
interface PolicyRule {
  name: string;
  description: string;
  condition: (request: ToolCallRequest, allowedDirectory: string) => boolean;
  decision: PolicyDecisionStatus;
  reason: string;
}
```
This is function-based -- the design proposes replacing it with declarative CompiledRule.

## Dual-Mode Trusted Process
1. **Proxy mode** (`mcp-proxy-server.ts`) - standalone child process for Code Mode
2. **In-process mode** (`index.ts`) - TrustedProcess class for tests/direct tool calls
Both need to use the same PolicyEngine.

## Design Review: Policy Compilation Pipeline
- See `docs/designs/policy-compilation-pipeline.md`
- Reviewed 2026-02-17, detailed analysis provided
- Key concern: move_file semantics, structural invariant ownership, verifier circular reasoning

## Implementation Plan: Policy Compilation Pipeline
- See `docs/designs/policy-compilation-implementation-plan.md`
- Written 2026-02-17, 12-step tracer bullet plan
- Critical path: Steps 1-5 (types, engine rewrite, hand-crafted artifacts, wiring, integration tests)
- Key design risk: `sideEffects: false` rule too permissive for read tools with path args
- Resolution: only truly argument-less tools (list_allowed_directories) get sideEffects=false
- Protected path change: substring matching -> exact path + directory containment
- Array argument handling needed for read_multiple_files (paths is string[])

## AI SDK Patterns for Pipeline (generateObject)
- `generateObject()` from `ai` package for structured LLM output
- Injectable `LanguageModel` parameter for testability (mock LLM in tests)
- `@ai-sdk/anthropic` createAnthropic() for real LLM in CLI
