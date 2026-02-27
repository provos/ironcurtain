# Missing Features & Future Tracer Bullets

This document tracks potential features for IronCurtain, organized by strategic theme. Each feature is described as a tracer bullet — a thin, end-to-end slice that proves out a capability.

## Deeper Security

### OS-Level Execution Containment (TB0) — **IMPLEMENTED**
Sandboxed MCP servers via `@anthropic-ai/sandbox-runtime`. Each sandboxed server runs in its own `srt` process with independent filesystem and network restrictions (bubblewrap+seccomp on Linux, Seatbelt on macOS). Sandbox-by-default with `"sandbox": false` opt-out. Configurable `sandboxPolicy: "enforce" | "warn"`. See `docs/designs/execution-containment.md` and `src/trusted-process/sandbox-integration.ts`.

### Per-Task Policy Generation
The architecture doc describes a per-task policy layer that is currently unimplemented. When a task arrives, an LLM generates a scoped policy restricting which tools and servers are relevant to that task. For example, "organize my documents" would revoke access to everything except filesystem tools. The policy engine already supports rule-chain evaluation — task policy would be a second chain checked before the constitution. This is the highest-value missing piece from the original design.

### Role-Clustered Policy Compilation
The constitution compiler currently sends all tool annotations to the LLM in a single prompt, asking it to produce rules for everything at once. Since the policy engine evaluates each ArgumentRole independently and uses deny-by-default, tools that share no non-`none` roles are completely independent from a policy perspective — a `fetch-url` rule can never affect a `read-path` decision. This enables a divide-and-conquer approach: build an undirected graph where tools are nodes and edges connect tools sharing at least one non-`none` ArgumentRole, then find connected components. Each component is an independent policy domain that can be compiled in its own LLM call with only its relevant constitution principles, tools, and roles. Benefits: smaller LLM context per call (more focused reasoning), parallelizable compilation, finer-grained caching (adding a new MCP server only invalidates its cluster), and more predictable output. With current tool sets, this would separate e.g. `fetch/*` (only `fetch-url`) from `filesystem/*` + `git/*` (which share `read-path`, `write-path`, `delete-path`).

### LLM Assessment Rules (Semantic Policy Checks)
Currently all policy rules are deterministic pattern matching. The design envisions a new rule outcome `assess` that triggers an LLM to evaluate content semantically — "does this output contain PII?", "is this content obfuscated/encoded?" This bridges the gap between static rules and human escalation. A tracer bullet could implement just the intelligibility check: deny outbound content that appears to be exfiltrating data via encoding.

### Loop Detection / Anomaly Monitoring — **IMPLEMENTED**
Two-layer loop detection: `StepLoopDetector` at the agent level (2x2 progress matrix with warn/block thresholds) and `CallCircuitBreaker` at the proxy level (sliding-window rate limiter). See `docs/designs/loop-detection.md`.

### Resource Budget Enforcement — **IMPLEMENTED**
Per-session limits on tokens, steps, wall-clock time, and estimated cost via `ResourceBudgetTracker` in `src/session/resource-budget-tracker.ts`. Three enforcement points: StopCondition (between steps), AbortSignal (wall-clock timeout), and pre-check in `execute_code`. Configured via `resourceBudget` in `~/.ironcurtain/config.json`. Defaults: 1M tokens, 200 steps, 30min, $5.

### Docker Agent Mode — **IMPLEMENTED**
Runs external agents (Claude Code, etc.) in Docker containers with `--network=none`. IronCurtain mediates all external access through host-side MITM and MCP proxies. Real API keys never enter the container — fake sentinel keys are swapped host-side. Supports auto-mode selection via agent registry. See `src/docker/` and `docs/designs/docker-agent-broker.md`.

## Operational Confidence

### Agent Testing / Adversarial Harness
The agent loop and sandbox have zero test coverage today. Build a test harness that can run the full agent with mock LLM responses and verify behavior. Then use it for adversarial testing: prompt injection attempts, exfiltration via encoding, scope creep, budget exhaustion. This is the biggest gap in confidence.

### Audit Log Analysis
The audit log is currently write-only — data goes in, nothing comes out. Build a CLI command (`npm run audit-report`) that produces summaries: decisions by type, most-used tools, denied attempts, escalation patterns, timing stats. This makes the transparency principle actionable rather than just data collection.

### Runtime Integrity Checks — **IMPLEMENTED**
`checkConstitutionFreshness()` in `src/config/index.ts` verifies that the constitution hash matches `constitutionHash` in `compiled-policy.json` at startup. Warns when the constitution has changed since last compilation. Called from `src/index.ts` before session creation.

## Extensibility

### Easy MCP Server Onboarding — *Partial*
The building blocks exist (`ironcurtain annotate-tools` for LLM-based argument classification, `ironcurtain compile-policy` for recompilation), but there is no unified "add server" workflow. MCP servers are manually added to `mcp-servers.json`. A streamlined onboarding command that adds server config, auto-annotates, and recompiles in one step is still missing.

### Web Search — **IMPLEMENTED**
Multi-provider web search (Brave, Tavily, SerpAPI) via the fetch server's `web_search` tool. Provider abstraction in `src/servers/search-providers.ts`, credential injection through `serverCredentials`, configurable via interactive editor and first-start wizard.

### Multiple Permitted Directories — **IMPLEMENTED**
The policy compiler generates separate rules for each directory with distinct access levels (e.g., sandbox with full read/write, Downloads with read/write/delete, Documents with read-only + escalate on write). The user constitution specifies directory permissions in natural language and the compiler produces the corresponding `within` path rules. See `compiled-policy.json` for examples.

### Configuration Validation — *Partial*
Zod schema validation exists for user config (`src/config/user-config.ts`) and pipeline artifacts (constitution-compiler, scenario-generator, policy-verifier schemas). Missing: `mcp-servers.json` is still loaded with bare `JSON.parse()` and compiled policy artifacts lack explicit schema validation on load.

## User Experience

### Multi-Turn Conversational Agent — **IMPLEMENTED**
Session-based multi-turn agent with per-session sandboxes, file-based escalation IPC, and conversation history. See `docs/multi-turn-session-design.md`.

### First-Start Wizard — **IMPLEMENTED**
Interactive onboarding wizard (`src/config/first-start.ts`) runs automatically when `~/.ironcurtain/config.json` doesn't exist. Educates users on the security model, displays the constitution, validates API keys, and offers web search provider setup. Also accessible via `ironcurtain setup`.

### Interactive Config Editor — **IMPLEMENTED**
Terminal UI (`src/config/config-command.ts`) using `@clack/prompts` for viewing and modifying `~/.ironcurtain/config.json`. Covers models, security settings, resource budgets, auto-compaction, and web search. Diff tracking with save confirmation. Accessible via `ironcurtain config`.

### Conversation Logging — **IMPLEMENTED**
Interaction log in `BaseTransport` (`src/session/base-transport.ts`) captures user prompts and assistant responses as JSONL alongside the existing audit log (which records tool calls and policy decisions). Provides a complete record of what was asked and what was produced — useful for debugging, accountability, and replaying sessions.

### Remote Access / Messaging Integration — **IMPLEMENTED**
Signal transport (`src/signal/`) enables E2E encrypted interaction beyond the local terminal. The agent runs on the user's workstation; the user submits tasks via Signal, receives formatted results, and approves escalations by replying "approve"/"deny". Architecture: `SignalBotDaemon` (persistent WebSocket listener) manages session lifecycle, `SignalSessionTransport` adapts sessions to the pluggable `Transport` interface, Docker-managed `signal-cli-rest-api` container handles Signal protocol. Includes fail-closed identity verification (Signal identity keys), message deduplication, markdown-to-Signal-styles conversion, and interactive setup wizard (`ironcurtain setup-signal`). Start with `ironcurtain bot`.

### Richer Escalation System — *Partial*
CLI readline escalation, LLM-based auto-approver (`src/trusted-process/auto-approver.ts`), and Signal-based escalation (text-based approve/deny with race condition prevention) are implemented. Callback-based escalation handlers are available in session options. Still missing: escalation queue, context enrichment (conversation history, agent intent).

## Scale

### Multiple Concurrent Agents — *Partial*
Per-session isolation exists (each session gets its own sandbox at `~/.ironcurtain/sessions/{sessionId}/sandbox/`), per-session resource budgets are enforced, and session resumption is supported. Still missing: true concurrent multi-agent execution (current architecture is single-agent-per-process) and per-session constitution profiles.

### Compilation Feedback Loop — **IMPLEMENTED**
Compile-verify-repair loop in `src/pipeline/compile.ts` feeds verification failures + judge analysis back to the compiler for targeted repair (up to 2 attempts). Incremental recompilation when only one server's tools change is still planned.
