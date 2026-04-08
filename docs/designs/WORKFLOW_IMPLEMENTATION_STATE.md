# Workflow Implementation State

Snapshot of progress on the multi-agent workflow system. PR #159 submitted 2026-04-07.

---

## Design Documents (read in order for full context)

| Document | Purpose |
|----------|---------|
| `ironcurtain-multi-agent-design-spec.md` | Original high-level architecture (4 agents, XState, Docker, constitutions) |
| `workflow-implementation-final.md` | Final implementation design (v3, all findings resolved) |
| `workflow-implementation-plan.md` | Module decomposition + implementation phases |
| `workflow-plan-review.md` | Plan review + 12 integration test specifications |
| `prompt-redesign.md` | Prompt builder redesign (implemented) |
| `workspace-support-design.md` | Workspace support with `.workflow/` artifacts |
| `workflow-cli-design.md` | CLI subcommand design |
| `workflow-web-ui-design.md` | Web UI integration (Draft v3) |
| `real-agent-spike-proposal.md` | Investigation for real Docker agent spike |
| `e2e-workflow-testing.md` | End-to-end testing guide (mock + real) |

Superseded documents (design history, not needed for implementation):
- `multi-agent-workflow-implementation.md` (v1), `workflow-implementation-v2.md` (v2), `workflow-implementation-v3.md` (v3)
- `workflow-design-findings.md`, `workflow-design-answers.md` (v1 findings/answers)
- `workflow-v2-findings.md`, `workflow-v2-design-answers.md` (v2 findings/answers)
- `workflow-v3-findings.md`, `workflow-v3-design-answers.md` (v3 findings/answers)
- `workflow-final-review.md` (final review — clean bill of health)

---

## Implementation Status

### All Completed (PR #159)

| Phase | Module | Key Files |
|-------|--------|-----------|
| 1 | Types, Validation, Guards, Status Parser, Transition | `src/workflow/types.ts`, `validate.ts`, `guards.ts`, `status-parser.ts`, `transition.ts` |
| 2 | XState Machine Builder | `src/workflow/machine-builder.ts` |
| 3 | Orchestrator + Prompt Builder | `src/workflow/orchestrator.ts`, `prompt-builder.ts` |
| 4 | Checkpoint, Artifacts, Worktree | `src/workflow/checkpoint.ts`, `artifacts.ts`, `worktree.ts` |
| — | Checkpoint wired into orchestrator + resume | `orchestrator.ts` (resume method, checkpoint on every transition) |
| — | Prompt redesign | Path references, `previousAgentOutput`, `visitCounts`, truncation |
| — | Workspace support | `.workflow/` subdirectory, `.gitignore` management, workspace root hashing |
| — | CLI command | `src/workflow/workflow-command.ts`, `cli-support.ts` (`ironcurtain workflow start/resume/inspect`) |
| — | Message log | `src/workflow/message-log.ts` (JSONL at `.workflow/messages.jsonl`) |
| — | Persona alias (`global`) | `cli-support.ts` — `"global"` uses global policy, anything else triggers persona resolution |
| — | Mock spike script | `examples/workflow-spike.ts`, `examples/workflow-demo.json` |
| — | Real Docker agent spike | `examples/workflow-real-spike.ts` (with `--resume`, `--state`, `--workspace` flags) |
| Web UI Phase 0 | Dispatch sub-module extraction | `src/web-ui/dispatch/{session,job,escalation,workflow}-dispatch.ts` |
| Web UI Phase 1 | Workflow backend + basic dashboard | `src/web-ui/workflow-manager.ts`, `dispatch/workflow-dispatch.ts`, `state-graph.ts` |
| Web UI Phase 2 | State machine visualization + gate review | `state-machine-graph.svelte`, `gate-review-panel.svelte`, `WorkflowDetail.svelte` |
| Web UI Phase 3 | Workspace file browser + persona management | `file-tree.svelte`, `file-viewer.svelte`, `workspace-browser.svelte`, `Personas.svelte` |
| Web UI Resume | Resume from web UI + stable baseDir | `workflow-manager.ts` (stable `~/.ironcurtain/workflow-runs/`), `listResumable` RPC, import external checkpoints |

### Not Yet Implemented

| Item | Status | Notes |
|------|--------|-------|
| Phase 5: Mux Integration | Not started | Tab backend union, gate system, `/workflow` commands in TUI |
| Web UI Phase 4: Workflow authoring | Aspirational | Visual editor or JSON editor with live preview |
| Per-role personas with constitutions | Ready to wire | Persona system is complete; need constitution templates for planner/architect/coder/critic |
| `maxConcurrentAgentSessions` | Removed (unused) | Add back when enforcement is implemented |
| `workflow.started` event | Implemented | Fixes race condition where events arrive before frontend map is populated |

---

## Test Summary

230+ workflow tests across 15+ test files. All passing.

Key test files:
- `test/workflow/orchestrator.test.ts` — 10 integration tests with MockSession
- `test/workflow/orchestrator-resume.test.ts` — 7 checkpoint/resume tests
- `test/workflow/machine-builder.test.ts` — 36 XState machine tests
- `test/workflow/artifacts.test.ts` — 37 artifact management tests
- `test/workflow/nested-artifacts.test.ts` — 7 nested directory tests
- `test/workflow/worktree.test.ts` — 11 git worktree integration tests
- `test/state-graph.test.ts` — 6 state graph extraction tests
- `test/workflow-file-dispatch.test.ts` — 12 file dispatch security tests
- `test/workflow-resume-dispatch.test.ts` — 10 resume dispatch tests
- `packages/web-ui/src/lib/__tests__/workflow-events.test.ts` — 9+ event handler tests
- `packages/web-ui/e2e/workflows.spec.ts` — Playwright E2E tests

---

## Key Architecture Decisions

- **Docker session code is NOT modified** — orchestrator composes around Session interface
- **Use existing `Session` interface directly** — no WorkflowSession wrapper
- **`claude --continue`** always works, even with no prior conversation (verified)
- **Conversation state persists across containers** via `conversationStateDir` mount
- **XState v5** with `invoke`/`fromPromise` for async agent execution
- **Prompts use path references** — no file content inlining (eliminates null bytes + ARG_MAX)
- **`previousAgentOutput`** — raw response text is the inter-agent communication channel (truncated at 32KB)
- **Per-state `visitCounts`** — not global round counter, for round tracking and first-visit/re-visit dispatch
- **`humanPrompt` cleared after consumption** — one agent sees gate feedback, not subsequent ones
- **`sessionsByState`** — keyed by state name (not persona name)
- **Persona alias `"global"`** — uses global policy; any other name triggers real persona resolution
- **Container-per-invocation** — accept 5-10s startup overhead, `--continue` provides continuity
- **File-based escalation routing only** — no callback-based escalation
- **All agents get full tool access** — constitution/policy restricts, not session mode
- **Stable baseDir** at `~/.ironcurtain/workflow-runs/` — survives daemon restarts
- **Dispatch sub-modules** — `json-rpc-dispatch.ts` split into domain-specific modules
- **dagre + custom SVG** for state machine visualization (frontend responsibility)
- **Gate review as full-page panel** — not modal (needs space for artifact review)

---

## Bugs Fixed During Development

1. **EISDIR crash** — `computeOutputHash()` and `readArtifactContent()` used flat `readdirSync` without `statSync` filtering. Fixed with recursive directory walking.
2. **Workspace/artifact directory mismatch** — orchestrator didn't pass `workspacePath` to `createSession()`. One-line fix.
3. **Null bytes in CLI args** — prompt builder inlined binary file content. Root cause of prompt redesign.
4. **Abort on completed workflow** — `abort()` wasn't a no-op for terminal states.
5. **Gate display race** — `state_entered` clobbered `gate_raised` phase. Fixed: preserve `waiting_human` only when active gate exists.
6. **`waiting_human` phase stickiness** — phase never reverted to `running` after gate resolution. Fixed: check `pendingGates` before preserving.
7. **Events dropped for unknown workflow IDs** — added `workflow.started` event + placeholder in frontend map.
8. **Double gate resolution** — added `activeGateId` guard in `resolveGate()`.
9. **Docker session resource leak** — `session.close()` not called on init failure. Fixed in catch block.
10. **State machine graph collapsing edges** — dagre multigraph enabled, edge arrays per from→to pair.
11. **Path separator normalization** — POSIX forward slashes in artifact hashing.
12. **MessageLog parent dir** — `mkdirSync` in constructor ensures directory exists.

---

## File Inventory

### Source files (`src/workflow/`)
```
types.ts              — All workflow types (branded IDs, definitions, context, events, status, GLOBAL_PERSONA)
validate.ts           — Zod schema + semantic validation (including prompt field, guard names)
guards.ts             — 7 guard functions + REGISTERED_GUARDS set
status-parser.ts      — parseAgentStatus(), buildStatusBlockReprompt(), STATUS_BLOCK_INSTRUCTIONS
transition.ts         — agentOutputToEvent() pure function
machine-builder.ts    — buildWorkflowMachine() → XState v5 machine, truncateAgentOutput()
orchestrator.ts       — WorkflowOrchestrator (WorkflowController), deps injection, checkpoint, resume, getDetail()
prompt-builder.ts     — buildAgentCommand() — path references, no file I/O, two prompt modes
checkpoint.ts         — CheckpointStore interface + FileCheckpointStore (atomic writes)
artifacts.ts          — ArtifactManager + FileArtifactManager, collectFilesRecursive (POSIX paths)
worktree.ts           — WorktreeManager + GitWorktreeManager (execFile, no shell strings)
message-log.ts        — MessageLog (JSONL append, mkdirSync on construct)
cli-support.ts        — Shared CLI helpers: session factory, gate handler, event loop, synthesis
workflow-command.ts    — CLI: ironcurtain workflow start/resume/inspect
workflows/design-and-code.json — Built-in workflow definition (packaged with npm)
```

### Web UI backend (`src/web-ui/`)
```
workflow-manager.ts                — WorkflowManager (stable baseDir, event forwarding, external checkpoint import)
state-graph.ts                     — extractStateGraph() pure function
dispatch/workflow-dispatch.ts      — All workflows.* RPC methods + Zod schemas
dispatch/session-dispatch.ts       — Extracted session RPCs
dispatch/job-dispatch.ts           — Extracted job RPCs
dispatch/escalation-dispatch.ts    — Extracted escalation RPCs
dispatch/persona-dispatch.ts       — personas.get, personas.compile RPCs
dispatch/types.ts                  — Shared DispatchContext
json-rpc-dispatch.ts               — Thin prefix router
```

### Web UI frontend (`packages/web-ui/src/`)
```
lib/components/features/state-machine-graph.svelte  — dagre + SVG visualization (multigraph)
lib/components/features/gate-review-panel.svelte     — Tabbed review panel (Summary/Artifacts/Files)
lib/components/features/file-tree.svelte             — Expandable directory tree (lazy loading)
lib/components/features/file-viewer.svelte           — File content display
lib/components/features/workspace-browser.svelte     — Split-pane file browser
routes/Workflows.svelte                              — Dashboard (start, resume, active list)
routes/WorkflowDetail.svelte                         — Detail view (graph, gates, history, workspace)
routes/Personas.svelte                               — Read-only persona management
```

### Examples
```
examples/workflow-demo.json        — Mock workflow definition (builtin mode)
examples/workflow-spike.ts         — Mock session spike script (interactive gates)
examples/workflow-real-spike.ts    — Real Docker agent spike (--resume, --state, --workspace)
```

### Documentation
```
WORKFLOWS.md                       — User-facing workflow guide (root of repo)
docs/e2e-workflow-testing.md       — E2E testing guide (mock + real Docker)
```
