# Workflow human_gate machinery (verified 2026-06-16)

Grounding for evolve human-surface slice design (`docs/designs/evolve-human-surface-slice.md`).

## State type + schema
- `HumanGateStateDefinition` (`src/workflow/types.ts:240`): `type: 'human_gate'`, `description`, `acceptedEvents: HumanGateEventType[]`, `present?: string[]`, `transitions: HumanGateTransitionDefinition[]`.
- `HumanGateEventType = 'APPROVE' | 'FORCE_REVISION' | 'REPLAN' | 'ABORT'` (`types.ts:362`). These are the REAL literal YAML `event:` values. `HUMAN_*` prefixed forms are internal XState names — never in YAML.
- `HumanGateTransitionDefinition` (`types.ts:350`): `to`, `event` (one accepted event), optional `actions` (e.g. `resetVisitCounts`).
- Zod: `humanGateStateSchema` (`validate.ts:70`), `humanGateTransitionSchema` (`validate.ts:40`). `validateHumanGate` (`validate.ts:540`): ≥1 transition; every transition.event must be in acceptedEvents.

## Lint codes that apply to gates/terminals
- **WF004** (`lint.ts:255`, error): every `present:` artifact must be produced by a reachable AGENT state's `outputs`. Terminal `outputs:` do NOT count (only agent outputs are "produced"). So `final_review` presenting `final_report` REQUIRES `final_summary` (agent) to declare `outputs: [final_report]`.
- **WF001** (`lint.ts:168`): every non-terminal must reach a terminal. Gates count as pass-through.
- **WF006** (`lint.ts:289`): if `settings.maxRounds` set, some transition must use `isRoundLimitReached` guard. (already satisfied by orchestrator in evolve.)
- Gates are NOT subject to WF012 (verdict→resultFile) or WF011 (container-before-scope-agent).

## Surfacing + resume path
- Gate entry: `handleGateEntry` (`orchestrator.ts:2524`) → `buildGateRequest` → `deps.raiseGate(gateRequest)` + emits `gate_raised` lifecycle event. `instance.activeGateId` set.
- `buildGateRequest` (`orchestrator.ts:2545`): resolves `present:` artifacts to dirs under `artifactDir`, surfaces `context.lastError` in summary (so a gate reached via error shows it).
- Status: `getStatus` returns `{ phase: 'waiting_human', gate }` when `activeGateId` set (`orchestrator.ts:1520`).
- Resolve: `resolveGate(id, event)` (`orchestrator.ts:1566`). FORCE_REVISION/REPLAN REQUIRE non-empty `event.prompt` (throws otherwise). Sends `HUMAN_<EVENT>` to XState actor with `prompt`. Feedback lands in `context.humanPrompt`, injected into next agent prompt.
- CLI: `promptGateInteractive` (`cli-support.ts:190`) maps a/f/r/x keys. `createGateHandler` (`cli-support.ts:160`) is the promise-queue.
- web-ui: Escalations view surfaces gates; daemon raiseGate wired through WebEventBus.

## Terminal → phase mapping (CRITICAL subtlety)
- `handleWorkflowComplete` (`orchestrator.ts:2581`): a terminal state named `aborted` (or stateValue.includes('abort')) → `phase: 'aborted'` (`orchestrator.ts:2623`). ELSE → `phase: 'completed'`.
- So a YAML terminal named `failed` currently maps to `phase: 'completed'` (NOT 'failed'!). The `phase: 'failed'` variant in WorkflowStatus is produced only by the invoke-error path (`orchestrator.ts:1772` lifecycle), not by reaching a terminal named `failed`.
- `aborted` terminal preserves checkpoint as resumable; `done`/completed removes it. `isCheckpointResumable` distinguishes via persisted finalStatus.
- `findErrorTarget` (`machine-builder.ts:180`): deterministic/agent invoke errors route to a human_gate if any transition targets one, else terminal named `aborted`/`failed`, else any terminal.
- `waitForCompletion`/`waitForGateOrCompletion` (`test-helpers.ts:407,425`) already recognize phases `completed|failed|aborted` and `waiting_human`.

## resetVisitCounts (loop re-entry)
- `WorkflowTransitionAction = { type: 'resetVisitCounts'; stateIds: string[] }` (`types.ts:320`). Valid on agent/det/gate transitions.
- Gate APPROVE/FORCE_REVISION routing back into a maxVisits loop must reset counters or `isStateVisitLimitReached` re-fires. (WORKFLOWS.md:660 reset pattern.)
- visitCounts incremented ONLY on agent-state entry (`machine-builder.ts:262`). `isRoundLimitReached` reads `max(visitCounts) >= maxRounds` (`guards.ts:21`).

## vuln-discovery as worked gate example
- `src/workflow/workflows/vuln-discovery/workflow.yaml`: 4 gates, all `acceptedEvents: [APPROVE, FORCE_REVISION, ABORT]`, `present:` lists agent outputs (supports `name?` optional suffix), transitions APPROVE→done, FORCE_REVISION→orchestrator, ABORT→aborted. Has distinct `done` and `aborted` terminals (lines 914,923).
