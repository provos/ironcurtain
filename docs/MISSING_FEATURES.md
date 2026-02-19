# Missing Features & Future Tracer Bullets

This document tracks potential features for IronCurtain, organized by strategic theme. Each feature is described as a tracer bullet — a thin, end-to-end slice that proves out a capability.

## Deeper Security

### Per-Task Policy Generation
The architecture doc describes a per-task policy layer that is currently unimplemented. When a task arrives, an LLM generates a scoped policy restricting which tools and servers are relevant to that task. For example, "organize my documents" would revoke access to everything except filesystem tools. The policy engine already supports rule-chain evaluation — task policy would be a second chain checked before the constitution. This is the highest-value missing piece from the original design.

### LLM Assessment Rules (Semantic Policy Checks)
Currently all policy rules are deterministic pattern matching. The design envisions a new rule outcome `assess` that triggers an LLM to evaluate content semantically — "does this output contain PII?", "is this content obfuscated/encoded?" This bridges the gap between static rules and human escalation. A tracer bullet could implement just the intelligibility check: deny outbound content that appears to be exfiltrating data via encoding.

### Loop Detection / Anomaly Monitoring — **IMPLEMENTED**
Two-layer loop detection: `StepLoopDetector` at the agent level (2x2 progress matrix with warn/block thresholds) and `CallCircuitBreaker` at the proxy level (sliding-window rate limiter). See `docs/designs/loop-detection.md`.

### Resource Budget Enforcement
Add token counting, API call limits, wall-clock timeouts, and cost tracking per agent run. Kill the agent when any budget is exhausted. The AI SDK's `onStepFinish` callback is the natural hook. A misbehaving agent can currently run indefinitely.

## Operational Confidence

### Agent Testing / Adversarial Harness
The agent loop and sandbox have zero test coverage today. Build a test harness that can run the full agent with mock LLM responses and verify behavior. Then use it for adversarial testing: prompt injection attempts, exfiltration via encoding, scope creep, budget exhaustion. This is the biggest gap in confidence.

### Audit Log Analysis
The audit log is currently write-only — data goes in, nothing comes out. Build a CLI command (`npm run audit-report`) that produces summaries: decisions by type, most-used tools, denied attempts, escalation patterns, timing stats. This makes the transparency principle actionable rather than just data collection.

### Runtime Integrity Checks
At startup, verify that `constitution.md` hash matches the `constitutionHash` in `compiled-policy.json`. If they diverge, the policy is stale. Simple, high-value, and prevents silent drift between the constitution and enforced rules.

## Extensibility

### Easy MCP Server Onboarding
Create a streamlined system for adding new MCP servers: add the server config, automatically generate tool annotations and new roles, and recompile policy. Adding a new MCP server should be straightforward and well-documented, with validation that the new server's tools are properly annotated and covered by policy rules.

### Multiple Permitted Directories
Extend the constitution and config to support multiple permitted directories with different access levels (e.g., sandbox with full read/write, a documents folder with read-only). The engine already supports multiple `within` paths in different rules; this needs config and constitution changes.

### Configuration Validation
Add Zod schema validation for `mcp-servers.json`, compiled artifacts, and the `IronCurtainConfig`. Fail fast with clear error messages on malformed configuration rather than encountering cryptic runtime errors.

## User Experience

### Multi-Turn Conversational Agent — **IMPLEMENTED**
Session-based multi-turn agent with per-session sandboxes, file-based escalation IPC, and conversation history. See `docs/multi-turn-session-design.md`.

### Messaging / UI Integration
Connect IronCurtain to messaging platforms or a web UI so users can interact without the command line. This requires a richer escalation system (see below) and multi-turn conversation support.

### Richer Escalation System
Replace the CLI readline with something pluggable: configurable timeout-to-deny, a queue of pending escalations, callback-based approval. Add context enrichment — what the agent was trying to accomplish, the conversation history. This is a prerequisite for both messaging/UI integration and multi-agent support.

## Scale

### Multiple Concurrent Agents
Support multiple concurrent agent sessions with independent policies, audit logs, and escalation queues. Add session isolation and per-session resource budgets. Enable different constitution profiles for different use cases.

### Compilation Feedback Loop — **IMPLEMENTED**
Compile-verify-repair loop in `src/pipeline/compile.ts` feeds verification failures + judge analysis back to the compiler for targeted repair (up to 2 attempts). Incremental recompilation when only one server's tools change is still planned.
