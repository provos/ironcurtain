# IronCurtain Architecture Notes

## Topic files
- [anvil-trajectory-capture.md](anvil-trajectory-capture.md) — Anvil PRD vs real MITM trajectory capture; no artifact IDs so cross-state lineage is path/content inference, not a deterministic join
- [workflow-human-gates.md](workflow-human-gates.md) — human_gate machinery: event vocab (APPROVE/FORCE_REVISION/REPLAN/ABORT), WF004 present-artifact rule, surfacing/resolveGate/resume, terminal→phase mapping, resetVisitCounts
- [daemon-ws-jsonrpc.md](daemon-ws-jsonrpc.md) — daemon WS JSON-RPC surface: discovery file `web-ui.json`, `--web-ui` required, wire types in web-ui-types.ts, observe-command.ts inline WS client, gate DTO = artifact NAMES only
- [evolve-workflow-package.md](evolve-workflow-package.md) — evolve FSM + scripts/evolve_core engine + run_spec schema + evaluator-command wiring (cli.py:243); docker venv-provisioning exists (uv pip, sentinel-gated); `--experiment` threading chain; circle_packing_demo layout
- [workflow-fsm-single-active-state.md](workflow-fsm-single-active-state.md) — FSM single-active-state by construction (orchestrator.ts:1873, single currentState/gate/persona, flat checkpoint); vestigial DEAD parallel scaffolding; det executor serial; cognition store races
- [xstate-actor-await-reuse.md](xstate-actor-await-reuse.md) — repo ships xstate 5.30 (waitFor/toPromise exported); hand-rolled actor.subscribe settle-loops in workflow/ are recurring missed-reuse (waitFor resolves on error, manual loops reject)
- [evolve-fanout-concurrency.md](evolve-fanout-concurrency.md) — evolve N-way fan-out (Phase 4): durable hazards = concurrent writes to shared non-lane scratch (stop_signals.json race; cognition.json in-process RLock + non-atomic save → corruption; nextStateSlug collision). Aggregate tokens SAFE. Gate 2&3 non-Docker coverage.
- [coordinator-mutex-concurrency.md](coordinator-mutex-concurrency.md) — ToolCallCoordinator FIFO callMutex serializes EVERY tool call (tool-call-coordinator.ts:310/348); escalation await INSIDE held mutex (pipeline.ts:821/866/881) stalls concurrent lanes; det docker.exec off-mutex; ensureBundleForScope mint race
- [evolve-phase5-cognition-promotion.md](evolve-phase5-cognition-promotion.md) — Phase 5 `.promote.lock` retirement SAFE: discriminator `lane is None` (evolve_result.py:1123); workers:1 inline promote vs workers>1 barrier once/batch gated `verdict==recorded`; mixed-verdict promoted on resume. Non-Docker gates.
- [evolve-phase7-crash-resume.md](evolve-phase7-crash-resume.md) — Phase 7 crash-resume DUP review: nodes.json walk re-spelled TS↔Python; EVOLVE_LANE_STEP_RE dup of STEP_NAME_RE; test dups. Good reuse: evolveRunDirForFanOutSegment/containerPathToWorkspaceRelative/buildEvolveBarrierInput
- [memory-server-architecture.md](memory-server-architecture.md) — memory-mcp-server: tool handlers config-free (LLM in engine closure); LLM-free sync write + deferred consolidation; reuse llmComplete (haiku); SCHEMA_VERSION read at open (drop-recreate migration); segments off-index unless via insertMemory+trigger. Designs: memory-ingest-tool.md, memory-parent-context-retrieval.md
- [memory-server-retrieval-benchmark.md](memory-server-retrieval-benchmark.md) — memory-fusion evolve dogfood: 4 evolved fns in scoring.ts, raw pool tap after pipeline.ts:50, TWO harnesses (Python labeled=metric, TS=quality), LoCoMo dia_id vs LongMemEval session_id (HF), set-membership; evolve container Node22 not tsx. Design: evolve-memory-fusion-dogfood.md
- [docker-mode-provider-mitm.md](docker-mode-provider-mitm.md) — Docker provider/MITM/adapter seams: chokepoint order (CONNECT→endpoint→key swap mitm:2143→body rewriter mitm:1259→upstreamTarget mitm:896→SSE resolveSseProvider:340); rewriter ctx has NO session id (threadable); resolveRealKey docker-inf:1447; cost costUsd:307 wrong for reroute; MODEL_PRICING:78. Design: openrouter-integration.md
- [webui-pty-terminal.md](webui-pty-terminal.md) — two control planes (turn-based Transport vs container-PTY/mux) + reuse seams to stream Claude Code's in-container TUI to web UI: createPtyBridge (add raw onData fan-out), createEscalationWatcher dir-watch, SessionMode process-global, reserveLabel, binary WS lane on authed /ws
- [evolve-phase6-aggregated-escalation.md](evolve-phase6-aggregated-escalation.md) — Phase 6 drain + single gate CORRECT-WITH-FIXES: XState stop() verified; one-gate structural; KEY GAP fromPromise ignores signal (can't cancel docker.exec, FSM-M3); workers:1 escalation msg misleads; 2nd blocker surfaces `drained` not `blocked`

## Key Files
- `src/trusted-process/policy-engine.ts` — two-phase engine (structural invariants + compiled rules); `policy-types.ts` EvaluationResult
- `src/types/mcp.ts` — ToolCallRequest, PolicyDecision, ToolCallResult; `src/types/argument-roles.ts` — ArgumentRole + RoleDefinition registry (+ resolveRealPath)
- `src/pipeline/types.ts` (ToolAnnotation, CompiledRule, TestScenario), `compile.ts` (CLI entry)
- `src/config/constitution.md` — 3 principles (Least privilege, No destruction, Human oversight); `generated/` = LLM artifacts; `generated-readonly/` = hand-authored read-only policy
- Design docs live in `docs/designs/`; `docs/secure-agent-runtime-v2.md` (aspirational), `docs/ironcurtain-poc-handoff.md` (stale)

## Architecture Patterns
- **Policy evaluation**: two-phase — (1) structural invariants (protected paths + unknown tools), (2) compiled declarative rules (per-role, most-restrictive-wins deny>escalate>allow), (3) default deny
- **Three-state decisions**: `allow | deny | escalate`; compiled rules only emit allow/escalate, deny is the fallthrough
- **Tool naming**: `serverName__toolName`; **tool classification** via LLM ToolAnnotation (ArgumentRole: read/write/delete-path, url/opaque, none)
- **Path security**: symlink-aware `resolveRealPath()` before containment; exact path + directory containment (not substring)
- **Content-hash caching**: per-stage inputHash skips LLM calls when inputs unchanged
- **RoleCategory** `path|url|opaque` dispatches structural invariants; url-category → domain-allowlist escalate (not deny)
- **Multi-mode tools** (git_branch/stash/remote): conditional `when` clauses so read ops resolve read-path only (else all-modes = most restrictive)

## Dual-Mode Trusted Process
- Proxy mode (`mcp-proxy-server.ts`, child process, Code Mode) + In-process mode (`index.ts` TrustedProcess). Both use same PolicyEngine + compiled artifacts.
- Live coordinator: `ToolCallCoordinator` owns PolicyEngine, AuditLog, CircuitBreaker, Whitelist, ServerContextMap; two mutexes (policy swap + tool-call serialize)

## Implemented design decisions (nuances not obvious from code)
- `effect` field dropped from ToolAnnotation; rules match on `roles`. Only `list_allowed_directories` has `sideEffects:false`
- Reads outside sandbox escalate (not deny) per Human-oversight; ALL move ops denied (source has delete-path role)
- Artifacts always written to disk even on verification failure (inspection/caching)
- Escalation IPC = file rendezvous in per-session escalation dir: proxy writes `request-{id}.json`, polls `response-{id}.json`; watcher surfaces to transport
- Handwritten scenarios are human ground truth — never LLM-mutated (dual-feedback repair loop auto-corrects only generated ones)

## AI SDK v6 (multi-turn)
- `generateText()` with `Output.object({ schema })`, NOT `generateObject()`; uses `inputSchema`/`stopWhen`/`toolCalls[].input`
- `ModelMessage` (@ai-sdk/provider-utils) / `ResponseMessage` (ai); accepts `messages[]` OR `prompt` (exclusive)
- result `response.messages` = append back for multi-turn; `pruneMessages()` for context window; `totalUsage.{promptTokens,completionTokens}`

## Session / transport model
- `createSession()` sole constructor; `createStandaloneSession()` for CLI/daemon/signal/web (docker resumes AgentConversationId). Modes: `{kind:'builtin'}` (Code Mode, V8, no TTY) | `{kind:'docker',agent}`
- `Transport{run(session),close()}` decouples I/O; `sendMessage(text)→Promise<string>`; per-session audit `audit-{id}.jsonl`; `onDiagnostic` callback + getDiagnosticLog()
- Multi-provider model IDs `provider:model-id` (bare=Anthropic); `src/config/model-provider.ts` parseModelId/createLanguageModel; per-provider keys; dynamic provider imports
- User config `~/.ironcurtain/config.json` (`user-config.ts`), resolution env>file>defaults; `serverCredentials` merged into spawn env; user constitution `constitution-user.md` never overwritten

## Design pointers (spec in docs/designs unless noted; most implemented)
- Multi-turn session — `docs/multi-turn-session-design.md`; Logger `src/logger.ts` (singleton setup/teardown, console monkey-patch, user output via stderr/stdout to bypass)
- ArgumentRole registry — `src/types/argument-roles.ts` (ReadonlyMap, compile-time completeness, getArgumentRoleValues for z.enum)
- MCP roots — mcp-roots-integration.md; `policy-roots.ts` extractPolicyRoots/toMcpRoots; static per session; POLICY_ROOTS env (proxy)
- Dual-feedback repair loop, config-file, multi-provider-models — see docs/designs/*
- Execution containment (TB0) — execution-containment.md; `@anthropic-ai/sandbox-runtime`, `sandbox-integration.ts`, sandbox-by-default, SandboxAvailabilityPolicy enforce|warn|skip
- Multi-server onboarding (TB1) — multi-server-onboarding.md; git (@cyanheads) + custom fetch; roles fetch-url/git-remote-url/branch-name/commit-message; DomainCondition rule; customize-policy CLI
- Memory MCP — memory-mcp-server.md; MEMORY_FILE_PATH per session type; `memory.enabled` default true; blanket-allow (all args 'none')
- Google Workspace — google-workspace-integration.md; credential-file rendezvous (access_token only, no refresh_token → TokenFileRefresher); `gworkspace-credentials.ts`, `token-file-refresher.ts`
- Cron — `src/cron/` (job-store, compile-task-policy, headless-transport); jobs at `~/.ironcurtain/jobs/{id}/`; compileTaskPolicy wraps PipelineRunner
- Multi-agent workflow — multi-agent-workflow-implementation.md; WorkflowController(start/getStatus/resolveGate/abort)+Orchestrator; XState v5, file checkpoints; gates reuse escalation picker
- Workflow container lifecycle v4 — workflow-container-lifecycle.md; UTCP `IronCurtainCommunicationProtocol.callTool` in-process hook; policy control `POST /__ironcurtain/policy/load`
- Auto-constitution — auto-constitution-generation.md; `constitution-generator.ts`/`job-customizer.ts`; isReadOnlyTool() filter; graceful w/o MCP
