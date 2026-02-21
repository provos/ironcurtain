# Design: Escalation Auto-Approver

**Status:** Implemented
**Date:** 2026-02-20
**Author:** IronCurtain Engineering

## 1. Problem Statement

When IronCurtain's policy engine escalates a tool call, the user must manually approve or deny it via `/approve` or `/deny` in the interactive CLI. This is the correct default -- human oversight is a core constitutional principle. However, many escalations are directly implied by the user's most recent prompt:

- User says "commit my changes and push to origin" -- `git_push` escalates, but the user clearly authorized it.
- User says "read the README from my Documents folder" -- reading outside the sandbox escalates, but the user explicitly requested it.

In these cases, the escalation interrupts flow without adding safety value. The human already expressed clear intent.

Conversely, vague prompts must NOT be auto-approved:

- "Go ahead and continue" -- no specific tool authorization.
- "Fix the tests" -- does not authorize reading arbitrary files outside the sandbox.
- "Do whatever you think is best" -- blanket delegation, not specific authorization.

We need an **optional, conservative** auto-approver that sits between the policy engine's escalation decision and the human approval flow. It uses a cheap LLM to match the escalated action against the human's stated intent.

### Security constraint

The auto-approver can only respond with `approve` or `escalate` (pass through to human). It can **never deny**. Denial is solely the domain of the policy engine (deny decisions) and the human (escalation denials). This prevents the auto-approver from becoming an attack surface that blocks legitimate tool calls. The worst it can do is approve something the human would not have approved that has clear security implications. We will need to carefully collect data and assess the risk of the model making a wrong decision.

## 2. Design Overview

The auto-approver is a self-contained module at `src/trusted-process/auto-approver.ts`. It receives an escalation request plus the human's most recent prompt, calls a cheap LLM (default: `anthropic:claude-haiku-4-5`) with a conservative system prompt, and returns either `'approve'` or `'escalate'`.

```
              AgentSession.sendMessage(userMessage)
                         |
                  writes user-context.json to escalation dir
                         |
                    generateText() → sandbox → proxy
                         |
                    Policy Engine (in proxy process)
                         |
                    [escalate]
                         |
                  +------v------+
                  | AutoApprover|  <-- reads user-context.json
                  +------+------+
                    /         \
              [approve]    [escalate]
                 |              |
           Continue as      Write escalation
           if allowed       request file (IPC)
           (no IPC at all)  → human approval
```

The auto-approver lives in the **proxy process**, right where the policy engine returns its escalation decision. This is the key architectural decision: by intercepting at the policy evaluation site, auto-approved escalations never produce an IPC file, the session never sees them, and the user is never shown a banner that gets immediately resolved.

The user's last message reaches the proxy via a `user-context.json` file in the escalation directory. The session writes this file at the start of each `sendMessage()` call, before `generateText()` runs. The proxy reads it only when an escalation fires. This reuses the existing shared escalation directory — no new IPC mechanism.

The module integrates at two points:

1. **Proxy mode** (`mcp-proxy-server.ts`): after the policy engine returns `'escalate'`, the proxy reads `user-context.json`, calls the auto-approver, and either continues as if allowed or falls through to the existing file-based human escalation flow.
2. **In-process mode** (`index.ts`): before calling the escalation handler or `onEscalation` callback, `TrustedProcess.handleToolCall()` calls the auto-approver. If approved, it skips the human prompt.

## 3. Key Design Decisions

1. **`approve | escalate` only, never `deny`.** The auto-approver is not a policy engine. It is a convenience layer that reduces friction for clearly-authorized actions. If the LLM is uncertain, it escalates to the human.

2. **Cheap, fast model by default.** Haiku-4.5 is fast and inexpensive. The auto-approver prompt is simple intent matching, not complex reasoning. The model is configurable for users who want to trade cost for accuracy or use a different provider.

3. **Only the most recent user message is provided.** Providing full conversation history would increase cost, latency, and prompt-injection surface area. The most recent user message captures current intent. If the user's intent was expressed in an earlier turn, the auto-approver correctly escalates to the human (conservative by design).

4. **Fail-open to human.** Any error -- LLM call failure, timeout, malformed response, unexpected output, missing `user-context.json` -- results in escalation to human. The auto-approver never blocks the escalation flow.

5. **Separate from PolicyEngine.** The auto-approver does not modify or extend the policy engine. It operates on the output of policy evaluation (escalation decisions) and decides only whether to short-circuit the human approval step. This keeps the policy engine's contract unchanged.

6. **User context via escalation directory.** The session writes `user-context.json` to the escalation directory at the start of each turn. The proxy reads it only on escalation. This reuses the existing shared directory (already used for request/response IPC files) rather than introducing a new IPC mechanism. The file is a single stable file overwritten each turn, not per-escalation.

7. **Stateless module, no class.** The auto-approver is a pure function (aside from the LLM call). No internal state, no lifecycle management. This makes it trivially testable and eliminates resource-management concerns.

8. **Opt-in via config.** Off by default. Users must explicitly enable it in `~/.ironcurtain/config.json`. This ensures the default behavior remains unchanged (all escalations go to humans).

9. **Audit trail.** When the auto-approver approves an escalation, the audit log records `escalationResult: 'approved'` with a new `autoApproved: true` field. This provides a clear trail for post-hoc security review. There are no real-time diagnostic events for auto-approvals — the auto-approver is designed to be invisible to the user, and the audit log serves as the record.

10. **No access to tool arguments in the prompt.** The LLM prompt includes the tool name and the policy engine's reason for escalation, but **not** the raw tool arguments. Tool arguments may contain file contents, paths, or other data that could be used for prompt injection. The tool name and reason provide sufficient context for intent matching.

11. **Human prompt is provided as-is.** The auto-approver receives the exact user message string. It does not attempt to parse, summarize, or transform it. This minimizes the attack surface -- the user message is the ground truth for intent.

## 4. Interface Definitions

### 4.1 Auto-Approver Function

```typescript
// src/trusted-process/auto-approver.ts

import type { LanguageModelV3 } from '@ai-sdk/provider';

/**
 * The auto-approver's decision. Only two outcomes are possible:
 * - 'approve': the human's prompt clearly authorized this action
 * - 'escalate': uncertain or no clear authorization; pass to human
 *
 * The auto-approver can never deny. This is enforced by the type.
 */
export type AutoApproveDecision = 'approve' | 'escalate';

/**
 * Context provided to the auto-approver for intent matching.
 *
 * Deliberately excludes tool arguments to prevent prompt injection
 * via file contents or path strings embedded in arguments.
 */
export interface AutoApproveContext {
  /** The human's most recent message to the agent. */
  readonly userMessage: string;

  /** The fully qualified tool name (serverName/toolName). */
  readonly toolName: string;

  /** The policy engine's reason for escalation. */
  readonly escalationReason: string;
}

/**
 * Configuration for the auto-approver, resolved from user config.
 *
 * Invariant: when `enabled` is false, the auto-approver is never called.
 * Callers must check `enabled` before calling `autoApprove()`.
 */
export interface AutoApproverConfig {
  readonly enabled: boolean;
  readonly modelId: string;
}

/**
 * Result of an auto-approve evaluation, including the decision
 * and metadata for audit logging and diagnostics.
 */
export interface AutoApproveResult {
  readonly decision: AutoApproveDecision;

  /**
   * Brief explanation of why the decision was made.
   * For auditing and diagnostic display only -- not used in control flow.
   */
  readonly reasoning: string;
}

/**
 * Evaluates whether an escalated tool call was clearly authorized
 * by the human's most recent message.
 *
 * Conservative by design: approves only when intent is unambiguous.
 * Any error (LLM failure, timeout, parse error) results in 'escalate'.
 *
 * @param context - The escalation context for intent matching
 * @param model - Pre-created LanguageModel instance
 * @returns The auto-approve decision with reasoning
 */
export async function autoApprove(
  context: AutoApproveContext,
  model: LanguageModelV3,
): Promise<AutoApproveResult>;
```

### 4.2 Configuration Schema

```typescript
// Addition to src/config/user-config.ts

// New schema section:
const autoApproveSchema = z.object({
  enabled: z.boolean().optional(),
  modelId: qualifiedModelId.optional(),
}).optional();

// New defaults:
const USER_CONFIG_DEFAULTS = {
  // ... existing defaults ...
  autoApprove: {
    enabled: false,
    modelId: 'anthropic:claude-haiku-4-5',
  },
} as const;

// New resolved config interface:
export interface ResolvedAutoApproveConfig {
  readonly enabled: boolean;
  readonly modelId: string;
}

// Addition to ResolvedUserConfig:
export interface ResolvedUserConfig {
  // ... existing fields ...
  readonly autoApprove: ResolvedAutoApproveConfig;
}
```

Config file example:

```jsonc
// ~/.ironcurtain/config.json
{
  // ... existing fields ...
  "autoApprove": {
    "enabled": true,
    "modelId": "anthropic:claude-haiku-4-5"
  }
}
```

### 4.3 Audit Trail Extension

```typescript
// Addition to src/types/audit.ts

export interface AuditEntry {
  // ... existing fields ...

  /**
   * When true, the escalation was approved by the auto-approver
   * rather than a human. Only present when escalationResult is 'approved'.
   */
  autoApproved?: boolean;
}
```

## 5. LLM Prompt Design

The auto-approver uses a structured output schema to force a binary decision with reasoning. The system prompt is deliberately conservative:

```typescript
const SYSTEM_PROMPT = `You are a security-critical intent matcher for a software tool authorization system.

Your job: determine whether the human's most recent message CLEARLY and SPECIFICALLY authorizes the tool action that was escalated for approval.

Rules:
1. APPROVE only when the human's message contains an explicit, specific request that directly maps to the escalated tool action.
2. ESCALATE (pass to human) when there is ANY ambiguity, vagueness, or indirect authorization.
3. The human must have requested the SPECIFIC action, not just a general category of actions.
4. Generic phrases like "go ahead", "continue", "do what you need to", "fix it" are NEVER sufficient for approval.
5. The human's message must mention the specific operation or its clear equivalent.

Examples of APPROVE:
- Human: "push my changes to origin" → Tool: git/git_push → APPROVE (explicit push request)
- Human: "read the file at ~/Documents/notes.txt" → Tool: filesystem/read_file, Reason: path outside sandbox → APPROVE (explicit file read request)
- Human: "delete the temp files in /var/log" → Tool: filesystem/delete_file, Reason: destructive operation → APPROVE (explicit delete request)

Examples of ESCALATE:
- Human: "fix the failing tests" → Tool: filesystem/read_file, Reason: path outside sandbox → ESCALATE (no specific file read requested)
- Human: "go ahead and continue" → Tool: git/git_push → ESCALATE (no specific push requested)
- Human: "clean up the project" → Tool: filesystem/delete_file → ESCALATE (ambiguous scope)
- Human: "commit my changes" → Tool: git/git_push → ESCALATE (commit != push, different operation)

Respond with your decision and a brief reason.`;
```

The response schema:

```typescript
const responseSchema = z.object({
  decision: z.enum(['approve', 'escalate']),
  reasoning: z.string().describe(
    'Brief explanation (1 sentence) of why you made this decision'
  ),
});
```

The user message in the LLM call:

```typescript
const userPrompt =
  `Human's most recent message: "${context.userMessage}"\n\n` +
  `Escalated tool: ${context.toolName}\n` +
  `Reason for escalation: ${context.escalationReason}\n\n` +
  `Decision:`;
```

## 6. Integration Points

### 6.1 User Context File (`agent-session.ts`)

The session writes the user's message to the escalation directory at the start of each turn, before `generateText()` runs:

```typescript
// In AgentSession.sendMessage(), after pushing the user message
const contextPath = resolve(this.escalationDir, 'user-context.json');
writeFileSync(contextPath, JSON.stringify({ userMessage }));
```

The escalation directory structure becomes:

```
escalation-dir/
├── user-context.json          ← session writes at start of each turn
├── request-{id}.json          ← proxy writes on escalate (existing)
└── response-{id}.json         ← session writes on approve/deny (existing)
```

The `user-context.json` file is overwritten each turn. It contains only the user's message — no conversation history, no session metadata. The proxy reads it only when an escalation fires.

### 6.2 Proxy Mode (`mcp-proxy-server.ts`)

The auto-approver runs inside the proxy process, right after the policy engine returns `'escalate'` and before writing the escalation request file for human IPC. Configuration is passed via environment variables (set once at proxy spawn):

| Env var | Type | Description |
|---------|------|-------------|
| `AUTO_APPROVE_ENABLED` | `"true"` or absent | Whether auto-approve is active |
| `AUTO_APPROVE_MODEL_ID` | string | Qualified model ID (e.g., `anthropic:claude-haiku-4-5`) |
| `AUTO_APPROVE_API_KEY` | string | API key for the auto-approve model's provider, resolved from user config |
| `AUTO_APPROVE_LLM_LOG_PATH` | string or absent | Path to JSONL file for logging auto-approver LLM interactions (for debugging) |

The session layer resolves the API key from `ResolvedUserConfig` based on the model's provider prefix (e.g., `anthropic:` → `config.anthropicApiKey`) and passes it explicitly. The proxy does not assume API keys exist in the shell environment.

Integration in the escalation block of the `CallToolRequestSchema` handler:

```typescript
if (evaluation.decision === 'escalate') {
  // Try auto-approve before falling through to human escalation
  if (autoApproveModel) {
    const userMessage = readUserContext(escalationDir);

    if (userMessage) {
      const result = await autoApprove(
        {
          userMessage,
          toolName: `${serverName}/${request.params.name}`,
          escalationReason: evaluation.reason,
        },
        autoApproveModel,
      );

      if (result.decision === 'approve') {
        // Auto-approved — skip human escalation entirely
        // No request file written, session never sees this escalation
        auditLog.record({ ...entry, autoApproved: true });
        // Fall through to forward the tool call to the real MCP server
      }
    }
    // Missing user-context.json or empty → fall through to human escalation
  }

  if (/* not auto-approved */) {
    // Existing human escalation flow (unchanged)
    if (!escalationDir) { /* single-shot: auto-deny */ }
    const decision = await waitForEscalationDecision(/* ... */);
    // ...
  }
}
```

Helper to read the user context file:

```typescript
function readUserContext(escalationDir: string): string | null {
  try {
    const contextPath = resolve(escalationDir, 'user-context.json');
    const data = JSON.parse(readFileSync(contextPath, 'utf-8'));
    return typeof data.userMessage === 'string' ? data.userMessage : null;
  } catch {
    return null; // File missing or malformed → fail-open to human
  }
}
```

### 6.3 In-Process Mode (`index.ts`)

In `TrustedProcess.handleToolCall()`, the auto-approver is called before the escalation handler. In this mode, the caller provides the user message via a `setLastUserMessage()` method — no file needed since both run in the same process:

```typescript
if (evaluation.decision === 'escalate') {
  // Try auto-approve first
  if (this.autoApproveModel && this.lastUserMessage) {
    const result = await autoApprove(
      {
        userMessage: this.lastUserMessage,
        toolName: `${request.serverName}/${request.toolName}`,
        escalationReason: evaluation.reason,
      },
      this.autoApproveModel,
    );

    if (result.decision === 'approve') {
      escalationResult = 'approved';
      // Skip human escalation, fall through to forwarding
    }
  }

  if (escalationResult !== 'approved') {
    // Existing escalation flow (unchanged)
    escalationResult = this.onEscalation
      ? await this.onEscalation(transportRequest, evaluation.reason)
      : await this.escalation.prompt(transportRequest, evaluation.reason);
    // ...
  }
}
```

### 6.4 Model Creation

A new function `createLanguageModelFromEnv()` is added to `src/config/model-provider.ts`:

```typescript
/**
 * Creates a LanguageModel from a qualified model ID and an explicit API key.
 *
 * Unlike createLanguageModel(), this does not require a ResolvedUserConfig.
 * Designed for use in the proxy process, which receives the model ID and
 * API key via environment variables.
 */
export async function createLanguageModelFromEnv(
  qualifiedId: string,
  apiKey: string,
): Promise<LanguageModelV3> {
  const { provider, modelId } = parseModelId(qualifiedId);
  const key = apiKey || undefined;

  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey: key })(modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey: key })(modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey: key })(modelId);
    }
  }
}
```

The existing `createLanguageModel()` can optionally be refactored to delegate to this function, resolving the API key from config before calling it.

### 6.5 Model Lifecycle

The auto-approver's LLM model is created once and reused across escalations:

- **Proxy mode:** Created at startup in `main()` via `createLanguageModelFromEnv(process.env.AUTO_APPROVE_MODEL_ID, process.env.AUTO_APPROVE_API_KEY)` if `AUTO_APPROVE_ENABLED` is set. If `AUTO_APPROVE_LLM_LOG_PATH` is set, the model is wrapped with `createLlmLoggingMiddleware()` (step name `'auto-approve'`). The model instance is captured in closure scope alongside `policyEngine` and `auditLog`.
- **In-process mode:** Created in `TrustedProcess` constructor via `createLanguageModel()` (has access to full config). Stored as `private autoApproveModel: LanguageModelV3 | null`.

### 6.6 LLM Interaction Logging

The auto-approver writes to a separate JSONL log file at `{sessionDir}/auto-approve-llm.jsonl`, passed to the proxy via `AUTO_APPROVE_LLM_LOG_PATH`. This uses the existing `createLlmLoggingMiddleware()` from `src/pipeline/llm-logger.ts` with step name `'auto-approve'`. Each entry records the prompt (user message, tool name, escalation reason), the model's response, token usage, and latency — sufficient for debugging decisions post-hoc.

## 7. Component Relationships

```
~/.ironcurtain/config.json
        |
        v
  ResolvedUserConfig
  (autoApprove: { enabled, modelId })
        |
        +---> AgentSession (session layer)
        |       |
        |       +---> writes user-context.json to escalation dir
        |       |     at start of each sendMessage() call
        |       |
        |       +---> passes AUTO_APPROVE_ENABLED, AUTO_APPROVE_MODEL_ID
        |             as env vars when spawning proxy
        |
        +---> mcp-proxy-server.ts (proxy process)
        |       |
        |       +---> creates LanguageModel from AUTO_APPROVE_MODEL_ID
        |       +---> on escalation:
        |       |       reads user-context.json from escalation dir
        |       |       calls autoApprove()
        |       |       if approved: skip IPC, continue as allowed
        |       |       if escalated: write request file → human flow
        |       |
        |       +---> escalation dir is the shared IPC channel:
        |               user-context.json  (session → proxy)
        |               request-{id}.json  (proxy → session, existing)
        |               response-{id}.json (session → proxy, existing)
        |
        +---> TrustedProcess (in-process mode)
                |
                +---> creates LanguageModel from modelId
                +---> receives lastUserMessage via setter
                +---> calls autoApprove() before escalation handler
```

## 8. Security Considerations

### 8.1 Prompt injection via tool arguments

Tool arguments are **excluded** from the auto-approver's LLM prompt. A malicious file name or argument value cannot influence the auto-approver's decision. Only the tool name, escalation reason, and the human's own message are provided.

### 8.2 Prompt injection via user message

The user message is provided as-is. This is intentional -- the user is the trust root. If the user types something that causes the auto-approver to approve, that is correct behavior (the user authorized the action by typing the message). The auto-approver cannot be weaponized against the user because it only approves actions the user's own words support.

### 8.3 Auto-approver cannot deny

By type-level constraint, the auto-approver returns `'approve' | 'escalate'`. Even if the LLM hallucinates a "deny" response, the structured output schema rejects it, and the error handler escalates to human. This prevents the auto-approver from blocking legitimate tool calls.

### 8.4 Fail-open to human

All error paths (LLM timeout, network error, malformed response, schema validation failure) result in `{ decision: 'escalate', reasoning: '<error description>' }`. The auto-approver never silently swallows errors.

### 8.5 Audit trail

Every auto-approved escalation is recorded in the audit log with `autoApproved: true`. Post-hoc review can identify all auto-approved actions and assess whether the auto-approver made correct decisions.

### 8.6 AI SDK dependency in the proxy process

The proxy is the security kernel. Adding an outbound LLM call (via the AI SDK) to the proxy is an acknowledged architectural trade-off. This is acceptable because:

- **Fail-open:** Any LLM failure (network error, timeout, malformed response) falls through to the existing human escalation flow. The worst case is identical to today's behavior.
- **Bounded output:** The auto-approver can only return `approve` or `escalate`, never `deny`. Even a compromised LLM response cannot block legitimate tool calls — it can only approve something the human would likely approve anyway.
- **Escalation-only:** The LLM call only fires when the policy engine returns `escalate`, not on every tool call. Most tool calls are allowed or denied by the policy engine without touching the auto-approver.
- **No new inbound surface:** The proxy does not expose a new endpoint or accept new input. The outbound HTTPS call to the LLM provider is read-only from the proxy's perspective.
- **Existing dependency:** The AI SDK is already a project dependency. The proxy inherits `node_modules` from the same build. Adding an import increases the loaded code surface but not the dependency tree.

### 8.7 User context file integrity

The `user-context.json` file is written by the session (trusted) and read by the proxy (trusted). The agent/sandbox cannot write to the escalation directory — it only communicates with the proxy via the MCP protocol. If the file is missing, malformed, or empty, `readUserContext()` returns `null` and the auto-approver is skipped (fail-open to human). The file contains only the user's message string, minimizing the data exposed.

### 8.8 No argument access means limited precision

Because the auto-approver does not see tool arguments, it cannot distinguish between "read ~/Documents/notes.txt" (which the user requested) and "read ~/Documents/secrets.txt" (which the user did not request) when both escalate for the same reason ("path outside sandbox"). This is a deliberate trade-off: the auto-approver's job is to determine whether the *category* of action was authorized, not to validate specific arguments. Argument-level validation remains the responsibility of the policy engine and the human reviewer.

This is conservative: if the user says "read ~/Documents/notes.txt" and the agent attempts to read a different file in ~/Documents/, the auto-approver may approve it (because a Documents read was authorized) and that is the same as what the human would likely approve. For higher security, users keep auto-approve disabled (the default).

## 9. Error Handling

```typescript
export async function autoApprove(
  context: AutoApproveContext,
  model: LanguageModelV3,
): Promise<AutoApproveResult> {
  try {
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(context),
      experimental_output: Output.object({ schema: responseSchema }),
    });

    const parsed = result.experimental_output;
    if (!parsed || (parsed.decision !== 'approve' && parsed.decision !== 'escalate')) {
      return {
        decision: 'escalate',
        reasoning: 'Auto-approver returned invalid response; escalating to human',
      };
    }

    return {
      decision: parsed.decision,
      reasoning: parsed.reasoning,
    };
  } catch (error) {
    // Any failure -> escalate to human
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: 'escalate',
      reasoning: `Auto-approver error: ${message}; escalating to human`,
    };
  }
}
```

## 10. Testing Strategy

### 10.1 Unit tests (`test/auto-approver.test.ts`)

The `autoApprove()` function accepts a `LanguageModelV3` parameter, making it trivially testable with a mock model.

**Test categories:**

1. **Clear approval cases:** User message explicitly authorizes the escalated action. Assert `decision === 'approve'`.
2. **Clear escalation cases:** User message is vague or does not match. Assert `decision === 'escalate'`.
3. **LLM error handling:** Mock model throws an error. Assert `decision === 'escalate'`.
4. **Malformed LLM response:** Mock model returns unexpected shape. Assert `decision === 'escalate'`.
5. **Empty user message:** Assert `decision === 'escalate'`.

Mock model factory:

```typescript
function createMockAutoApproveModel(
  response: { decision: string; reasoning: string },
): LanguageModelV3 {
  // Returns a mock LanguageModelV3 that produces the given structured output
  // Uses the same pattern as existing test mocks in the codebase
}
```

### 10.2 Configuration tests

Added to existing `test/user-config.test.ts`:

- Default config has `autoApprove.enabled === false`.
- Config with `autoApprove.enabled: true` resolves correctly.
- Invalid `modelId` is rejected by validation.
- Backfill adds `autoApprove` section to legacy config files.

### 10.3 Integration tests (`test/auto-approver-integration.test.ts`)

20 scenarios (10 approve, 10 escalate) run against a live Haiku 4.5 model. Skipped during regular `npm test`; run with `INTEGRATION_TEST=true npx vitest run test/auto-approver-integration.test.ts`. All 20 scenarios pass, validating that the system prompt produces correct decisions for realistic escalation patterns.

### 10.4 Audit log tests

Verify that auto-approved escalations produce audit entries with `autoApproved: true`.

## 11. Files Changed

| File | Change |
|------|--------|
| `src/trusted-process/auto-approver.ts` | **New.** `autoApprove()`, `readUserContext()`, types, prompt, response schema. |
| `src/config/user-config.ts` | Add `autoApprove` schema, defaults, `ResolvedAutoApproveConfig`. |
| `src/config/model-provider.ts` | Add `createLanguageModelFromEnv(qualifiedId, apiKey)` for proxy use. |
| `src/config/paths.ts` | Add `getSessionAutoApproveLlmLogPath(sessionId)` helper. |
| `src/config/types.ts` | No changes needed (auto-approve config flows through `ResolvedUserConfig` which is already on `IronCurtainConfig`). |
| `src/types/audit.ts` | Add `autoApproved?: boolean` to `AuditEntry`. |
| `src/session/agent-session.ts` | Write `user-context.json` to escalation dir at start of `sendMessage()`. |
| `src/session/index.ts` | Pass auto-approve config to sandbox factory. |
| `src/sandbox/index.ts` | Thread `AUTO_APPROVE_ENABLED`, `AUTO_APPROVE_MODEL_ID`, and `AUTO_APPROVE_API_KEY` into `proxyEnv`. |
| `src/trusted-process/mcp-proxy-server.ts` | Read auto-approve config from env vars, create model, call `autoApprove()` before human escalation IPC. |
| `src/trusted-process/index.ts` | Add `autoApproveModel` field, `setLastUserMessage()` method, call `autoApprove()` in `handleToolCall()`. |
| `src/session/cli-transport.ts` | No changes needed. |
| `test/auto-approver.test.ts` | **New.** Unit tests for `autoApprove()`. |

## 12. Migration Plan

### Phase 1: Core module + config (1 PR)

1. Add `autoApprove` schema and defaults to `src/config/user-config.ts`.
2. Create `src/trusted-process/auto-approver.ts` with `autoApprove()`, `readUserContext()`, types, and prompt.
3. Add `autoApproved?: boolean` to `AuditEntry`.
4. Write unit tests.

### Phase 2: Proxy + session integration (1 PR)

1. Write `user-context.json` in `AgentSession.sendMessage()` at start of each turn.
2. Thread `AUTO_APPROVE_ENABLED` and `AUTO_APPROVE_MODEL_ID` env vars through `sandbox/index.ts` to the proxy.
3. Integrate auto-approver into `mcp-proxy-server.ts` (read user context, call before human escalation IPC).
4. Integrate auto-approver into `TrustedProcess` (in-process mode).
5. Integration test: escalation with auto-approve enabled.

## 13. Future Extensions

### 13.1 Conversation-aware auto-approval

The current design uses only the most recent user message. A future extension could provide a summary of recent conversation context (using the message compactor's summarization infrastructure) for better intent matching in multi-step workflows.

### 13.2 Per-tool auto-approve rules

Users could configure which tool categories are eligible for auto-approval. For example, auto-approve file reads but never auto-approve deletes, regardless of stated intent.

### 13.3 Approval confidence threshold

The LLM could return a confidence score, and auto-approval would only trigger above a configurable threshold. This adds complexity with unclear benefit given the conservative prompt design.

### 13.4 Auto-approve learning

Track which auto-approved actions the user would have approved (by comparing with subsequent manual approvals of similar actions) to tune the prompt over time. This is out of scope for the initial implementation.
