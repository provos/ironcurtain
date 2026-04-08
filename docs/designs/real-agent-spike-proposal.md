# Real-Agent Spike Proposal

Investigation into running the workflow orchestrator with real LLM sessions (builtin mode) instead of mock sessions.

## 1. What works already

**Gate handling.** The interactive gate prompts in `workflow-spike.ts` are fully functional and mode-agnostic. The `raiseGate`/`dismissGate`/`waitForGate` pattern works identically with real or mock sessions.

**XState machine.** The state machine builder, transition guards, context management, and stall detection are all session-agnostic. They operate on `AgentOutput` parsed from the agent's response text.

**Status parsing.** `parseAgentStatus()` and the retry logic in `executeAgentState()` already handle real agent output (they parse a `agent_status` fenced block from natural language text).

**Prompt building.** `buildAgentCommand()` constructs well-structured prompts with task description, input artifacts, review history, and status block instructions. These work as-is with real agents.

**Lifecycle events and tab logging.** The `onEvent` callbacks and console tab handle are session-agnostic.

**Session mode dispatch.** The orchestrator already reads `settings.mode` from the workflow definition and constructs the correct `SessionMode`.

## 2. Gaps found

### Gap 1: Workspace/artifact directory mismatch (CRITICAL)

The orchestrator creates an artifact directory at `{baseDir}/{workflowId}/artifacts/` and expects output artifacts to appear there (e.g., `artifacts/plan/`, `artifacts/spec/`, `artifacts/code/`). However, it does **not** pass `workspacePath` to `createSession()`. This means the session creates its own sandbox at `~/.ironcurtain/sessions/{sessionId}/sandbox/`.

The prompt tells the agent to "create artifact directories in your workspace," but the workspace is the session sandbox, not the artifact directory. The orchestrator then checks `artifactDir` for the artifacts and fails.

**The mock spike hides this** because `afterSend` callbacks write directly to `artifactDir`, bypassing the session entirely.

**Fix:** The orchestrator must pass `workspacePath: instance.artifactDir` to `createSession()`. This makes the agent's sandbox match the artifact directory, so files the agent creates are immediately visible to the orchestrator.

### Gap 2: No escalation handling (CRITICAL)

The orchestrator passes `persona` to `createSession()` but does NOT pass `onEscalation`. From the `SessionOptions` docs:

> If not provided, escalations are auto-denied.

With the global policy, most tool calls that write files or run git commands will be escalated. If escalations are auto-denied, the agent cannot do any real work -- it will be blocked on every substantive tool call.

**Options:**
1. **Auto-approve everything** -- Set `disableAutoApprove: false` in `SessionOptions` and configure auto-approve in `~/.ironcurtain/config.json` (`autoApprove.enabled: true`). This is the simplest path for a spike.
2. **Pass `onEscalation`** -- The orchestrator would need to either auto-approve all escalations or forward them to the user. This is more complex but more realistic.
3. **Use a permissive policy** -- Use a compiled policy that allows everything within the sandbox. The existing global policy should do this for filesystem operations within the `allowedDirectory`, but git operations and other non-filesystem tools may still escalate.

**Recommended for spike:** Auto-approve via config. Set `autoApprove.enabled: true` in user config, or pass a pre-built `IronCurtainConfig` with auto-approve enabled.

### Gap 3: No model override mechanism (MODERATE)

The orchestrator has no way to control which model the session uses. The model is determined by `config.agentModelId`, which comes from:
1. `~/.ironcurtain/config.json` field `agentModelId` (default: `anthropic:claude-sonnet-4-6`)
2. No environment variable override exists for the model ID.

For the spike, we want Haiku to keep costs low. Options:
1. **Config file** -- Set `agentModelId: "anthropic:claude-haiku-4-5"` in `~/.ironcurtain/config.json`. Simple but affects all sessions globally.
2. **Pre-built config** -- The spike script can call `loadConfig()`, override `agentModelId`, and pass the modified config via `SessionOptions.config`. But the orchestrator does not forward `config` from its deps to `createSession()`.
3. **Add `config` to orchestrator deps** -- The orchestrator's `createSession` factory receives `SessionOptions` so the caller controls it. The spike script's factory can inject a custom config.

**Recommended:** Option 3. The spike script already provides a custom `createSession` factory. The factory can call `loadConfig()`, override the model, and pass the modified config in `SessionOptions.config`.

### Gap 4: No `systemPromptAugmentation` for role instructions (MODERATE)

The orchestrator passes `persona` to `createSession()` but does not pass `systemPromptAugmentation`. Without personas set up, the agent gets the generic system prompt with no role-specific instructions (e.g., "you are a planner," "you are a code reviewer").

The `persona` field triggers persona resolution, which requires persona directories to exist under `~/.ironcurtain/personas/{name}/`. For the spike, we don't want to create persona infrastructure.

**Fix:** The spike's session factory should inject `systemPromptAugmentation` with role-specific instructions based on the `persona` field from the workflow definition. The orchestrator already passes `persona: stateConfig.persona` -- the factory can use this to select appropriate instructions.

### Gap 5: Missing `persona` for real sessions without persona infrastructure

When `persona` is set in `SessionOptions` and no persona directory exists, `resolvePersona()` in `src/persona/resolve.ts` will throw. The orchestrator unconditionally passes `persona: stateConfig.persona`.

**Fix for spike:** The spike's session factory should NOT forward the `persona` field to the real `createSession()`. Instead, it should convert the persona name into a `systemPromptAugmentation` string.

### Gap 6: Each agent session gets its own sandbox (MINOR for spike)

Without the workspace fix (Gap 1), each agent creates an independent session sandbox. Even with the workspace fix, each agent sees the same `artifactDir` which is correct for the sequential workflow.

For session resumption (`resumeSessionId`), the orchestrator stores `context.sessionsByRole[stateId]` and passes it on subsequent calls to the same role. This works correctly for real sessions.

## 3. Proposed changes

### Changes in `examples/` (spike script)

**New file: `examples/workflow-real-spike.ts`**

The real-agent spike script, modeled on `workflow-spike.ts` but using real sessions:

1. **Session factory** that:
   - Calls `loadConfig()` once, overrides `agentModelId` to `anthropic:claude-haiku-4-5`
   - Maps `persona` names to `systemPromptAugmentation` strings (role instructions)
   - Does NOT forward the `persona` field to `createSession()`
   - Passes `workspacePath` (explained below)
   - Enables auto-approve or passes `onEscalation` with auto-approve logic
   - Passes `config` with the overridden model

2. **Role prompt map** -- A record mapping persona names (planner, architect, coder, critic) to system prompt augmentations that describe the agent's role and expected behavior.

3. **Reuses** all gate handling, lifecycle events, and summary printing from the original spike.

**Optionally new file: `examples/workflow-real-demo.json`**

A simpler workflow definition for the real spike. The demo workflow's `validate` state runs `echo "3 tests passed"`, which works, but a simpler palindrome-checker task might be better for real agents. Alternatively, reuse `workflow-demo.json` as-is.

### Changes in `src/workflow/orchestrator.ts`

**Required change:** Pass `workspacePath: instance.artifactDir` to `createSession()`.

```typescript
// In executeAgentState():
const session = await this.deps.createSession({
  persona: stateConfig.persona,
  mode,
  resumeSessionId: previousSessionId,
  workspacePath: instance.artifactDir,  // ADD THIS
});
```

This is not a spike-only change -- it is a bug fix. Without this, real sessions never write to the artifact directory and the orchestrator will always fail to find output artifacts.

**Optional change:** Forward `systemPromptAugmentation` from state config. This is better done in the session factory for the spike (more flexible), but could be a permanent orchestrator feature later.

### Configuration needed

1. **`ANTHROPIC_API_KEY`** environment variable (or in `~/.ironcurtain/config.json` as `anthropicApiKey`)
2. **Compiled policy** -- The global compiled policy in `src/config/generated/` or `~/.ironcurtain/generated/` must exist. `npm run compile-policy` to generate if missing.
3. **Auto-approve** -- Set `autoApprove.enabled: true` in `~/.ironcurtain/config.json`, or override in the spike's config.

## 4. Implementation plan

### Step 1: Fix the workspace/artifact directory gap in the orchestrator

Edit `src/workflow/orchestrator.ts`, line ~324: add `workspacePath: instance.artifactDir` to the `createSession()` call. This is a one-line fix.

### Step 2: Create role prompt definitions

Define a `ROLE_PROMPTS` record mapping persona names to role-specific system prompt augmentations. Keep them concise -- 5-10 lines each describing the agent's role, expected approach, and output format.

### Step 3: Create the real-agent spike script

`examples/workflow-real-spike.ts`:

1. Import `loadConfig` and `createSession` from the main codebase
2. Build a session factory that:
   - Loads config once, overrides model to Haiku
   - Enables auto-approve in the config
   - Maps persona to systemPromptAugmentation
   - Strips persona field before passing to createSession
   - Passes workspacePath (though the orchestrator fix handles this)
3. Reuse gate handling infrastructure from `workflow-spike.ts`
4. Run with a simple task description

### Step 4: Create a toy workflow definition (optional)

`examples/workflow-palindrome.json` -- a simple coding task:
- plan: produce an implementation plan for a palindrome checker
- plan_review: human gate
- design: produce a design spec
- design_review: human gate
- implement: write the code
- validate: run `node -e "require('./palindrome.js').check('racecar')"` or similar
- review: code review
- done: terminal

Or simply reuse `workflow-demo.json` with a different task description.

### Step 5: Test end-to-end

```bash
ANTHROPIC_API_KEY=sk-... npx tsx examples/workflow-real-spike.ts
```

## 5. Example workflow definition

Using the existing `workflow-demo.json` is sufficient. The task description passed to `orchestrator.start()` controls the actual work:

```typescript
const workflowId = await orchestrator.start(
  definitionPath,
  'Create a TypeScript module that checks whether a string is a palindrome. ' +
  'Export a function `isPalindrome(s: string): boolean` that ignores case and non-alphanumeric characters. ' +
  'Include unit tests using Node.js built-in assert module.'
);
```

Role prompts for the spike:

```typescript
const ROLE_PROMPTS: Record<string, string> = {
  planner: `You are a project planner. Your job is to break down the task into a clear, actionable implementation plan.
Write your plan as a markdown document. Focus on what needs to be built, in what order, and any key decisions.
Do NOT write code. Your output is a plan document only.`,

  architect: `You are a software architect. Your job is to produce a technical design specification.
Based on the plan, define the module structure, interfaces, data flow, and key design decisions.
Write your spec as a markdown document. Do NOT write code.`,

  coder: `You are an implementation engineer. Your job is to write the actual code based on the plan and spec.
Write clean, working TypeScript code. Create all necessary files in your workspace.
Include unit tests.`,

  critic: `You are a code reviewer. Your job is to review the implementation against the spec.
Check for correctness, edge cases, code quality, and test coverage.
If you find issues, set verdict to "rejected" and describe what needs fixing.
If the code is good, set verdict to "approved".`,
};
```

## 6. Risk assessment

### Risk: Haiku may not produce well-formed agent_status blocks
**Likelihood:** Medium. Haiku is weaker at following structured output formats.
**Mitigation:** The orchestrator already has retry logic (`buildStatusBlockReprompt()`). The status block instructions in the prompt are clear. If Haiku consistently fails, the spike will surface this as a concrete issue.

### Risk: Auto-approve may approve dangerous operations
**Likelihood:** Low in a spike. The agent operates within a temp directory.
**Mitigation:** Use a temp directory for `baseDir`. The compiled policy still protects system files and protected paths. Auto-approve only affects operations within the sandbox.

### Risk: MCP server startup failures
**Likelihood:** Medium. The sandbox initialization connects to all configured MCP servers. Some may not be available (Docker, specific credentials).
**Mitigation:** The spike only needs the `filesystem` server. If other servers fail to connect, the session may still initialize. Worst case, reduce `mcp-servers.json` to filesystem-only for the spike.

### Risk: Cost overrun from Haiku
**Likelihood:** Low. Haiku is inexpensive. A full plan-design-implement-review cycle with retries might use ~100K tokens total, costing under $0.10.
**Mitigation:** The resource budget tracker enforces limits (default $5). The spike can set lower limits.

### Risk: Agent writes artifacts in wrong location
**Likelihood:** Low after the `workspacePath` fix. The prompt says "your workspace" and the workspace IS the artifact directory.
**Mitigation:** The orchestrator's `findMissingArtifacts` check and retry will catch this. If the agent creates files in unexpected subdirectories, the orchestrator will re-prompt.

### Risk: Escalation deadlock without auto-approve
**Likelihood:** High if auto-approve is not configured. Every write operation triggers escalation, and with no `onEscalation` handler, all escalations are auto-denied.
**Mitigation:** This is why auto-approve (or a permissive config) is required for the spike.
