# Agent Messages in Transition History

## Overview

Show what each agent produced alongside each transition in the workflow detail view.
Today, `TransitionRecord` captures _from_, _to_, _event_, _timestamp_, and _duration_ -- but
not the agent's output text. The user has to cross-reference the JSONL message log
to understand what happened at each stage. This feature adds a summary of the agent's
response directly onto each transition record, flowing through the existing domain ->
DTO -> frontend pipeline.

## 1. Domain layer change: `TransitionRecord`

Add an optional `agentMessage` field to `TransitionRecord` in `src/workflow/types.ts`:

```ts
export interface TransitionRecord {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly duration_ms: number;
  /** Summary of the agent's output that produced this transition (if any). */
  readonly agentMessage?: string;
}
```

Why optional:
- Not every transition has an agent message (gate resolutions, deterministic states, initial transitions).
- Keeping it optional avoids inventing placeholder text and keeps the checkpoint format backward-compatible
  (existing checkpoints without the field deserialize cleanly).

Why on `TransitionRecord` directly (not a parallel structure):
- The relationship is 1:1 -- one transition, one message that caused it. A parallel structure would
  need index-based correlation, which is fragile and adds complexity for no benefit.
- `TransitionRecord` is already persisted in `WorkflowCheckpoint.transitionHistory`, so the message
  survives resume.

## 2. DTO layer change: `TransitionRecordDto`

Add a matching optional field to both the backend DTO (`src/web-ui/web-ui-types.ts`) and the
frontend mirror (`packages/web-ui/src/lib/types.ts`):

```ts
export interface TransitionRecordDto {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly durationMs: number;
  /** Summary of the agent output that produced this transition. */
  readonly agentMessage?: string;
}
```

The mapping in `workflow-dispatch.ts` passes the field through:

```ts
const transitionHistory = (detail?.transitionHistory ?? []).map((t) => ({
  from: t.from,
  to: t.to,
  event: t.event,
  timestamp: t.timestamp,
  durationMs: t.duration_ms,
  agentMessage: t.agentMessage,
}));
```

## 3. Where agent output is captured in the orchestrator

The capture point is `subscribeToActor` in `src/workflow/orchestrator.ts`, where transitions
are already recorded (line ~595). The agent's response text is available in the XState context
as `previousAgentOutput` at the moment the transition fires -- it was just assigned by the
`updateContextFromAgentResult` action in `machine-builder.ts`.

Current code:

```ts
instance.transitionHistory.push({
  from: previousState,
  to: stateValue,
  event: 'transition',
  timestamp: new Date(now).toISOString(),
  duration_ms: duration,
});
```

Updated code:

```ts
instance.transitionHistory.push({
  from: previousState,
  to: stateValue,
  event: 'transition',
  timestamp: new Date(now).toISOString(),
  duration_ms: duration,
  agentMessage: truncateForTransition(snapshot.context.previousAgentOutput),
});
```

Where `truncateForTransition` produces the summary (see section 6).

For **gate transitions**, the human's feedback text is captured similarly. When `resolveGate()`
is called, the orchestrator already has `event.prompt`. The transition that results from the
gate resolution fires in `subscribeToActor`, but at that point `snapshot.context.humanPrompt`
has been set by the `storeHumanPrompt` action. So the message for a gate transition is the
human's prompt:

```ts
agentMessage: truncateForTransition(
  snapshot.context.previousAgentOutput ?? snapshot.context.humanPrompt
),
```

This uses `previousAgentOutput` when available (which is set from the agent that ran before the
gate), falling back to `humanPrompt` (the human's feedback that resolved the gate). In practice,
both may be present. The semantics: for a transition _out of_ an agent state, `previousAgentOutput`
is the agent's response. For a transition _out of_ a gate state, `previousAgentOutput` still holds
the prior agent's text (unchanged), so the human's feedback should take precedence. For
**deterministic states** (type `'deterministic'`), `previousAgentOutput` holds stale data from
whichever agent ran most recently before the deterministic state -- attaching it would be
misleading since the deterministic state did not involve any agent. The same applies to
terminal states. Refined logic:

```ts
const stateDef = definition.states[previousState];
let agentMessage: string | undefined;

if (stateDef?.type === 'human_gate') {
  // Gate transition: prefer human feedback
  agentMessage = truncateForTransition(snapshot.context.humanPrompt ?? snapshot.context.previousAgentOutput);
} else if (stateDef?.type === 'agent') {
  // Agent transition: use agent output
  agentMessage = truncateForTransition(snapshot.context.previousAgentOutput);
}
// deterministic and terminal: no agentMessage (leave undefined)

instance.transitionHistory.push({
  from: previousState,
  to: stateValue,
  event: 'transition',
  timestamp: new Date(now).toISOString(),
  duration_ms: duration,
  agentMessage,
});
```

## 4. How the replay engine populates it

The replay engine (`packages/web-ui/scripts/replay-engine.ts`) already tracks
`state.lastAgentMessage` from `agent_received` entries. The change is to include that
message when building transition records inside `translateEntry`, with state-type-aware
logic matching section 3.

For gate resolutions, the replay engine already has `entry.prompt` in `gate_resolved` entries.
Add a `lastHumanPrompt` field to `ReplayState` and capture it:

```ts
case 'gate_resolved': {
  state.lastHumanPrompt = entry.prompt ?? null;
  // ...existing code...
}
```

Then when building the transition, use the same state-type-aware logic from section 3. The
replay engine must look up the previous state's definition type to decide what to attach:

- **`agent` state**: use `lastAgentMessage`
- **`human_gate` state**: prefer `lastHumanPrompt`, fall back to `lastAgentMessage`
- **`deterministic` or terminal state**: leave `agentMessage` undefined (stale data from a
  prior agent would be misleading)

```ts
case 'state_transition': {
  // ...existing code...
  const prevStateDef = workflowDef?.states[prevState];
  let agentMessage: string | undefined;

  if (prevStateDef?.type === 'human_gate') {
    agentMessage = truncateForTransition(state.lastHumanPrompt ?? state.lastAgentMessage);
  } else if (prevStateDef?.type === 'agent') {
    agentMessage = truncateForTransition(state.lastAgentMessage);
  }
  // deterministic and terminal: no agentMessage

  state.transitionHistory.push({
    from: prevState,
    to: targetState,
    event: entry.event ?? 'auto',
    timestamp: entry.ts,
    durationMs: now - prevTime,
    agentMessage,
  });
  // ...
}
```

The `TransitionRecord` type local to `replay-engine.ts` also needs the optional `agentMessage`
field added.

## 5. Frontend rendering approach

The existing transition history in `WorkflowDetail.svelte` renders each transition as a compact
horizontal row. Agent messages are shown as a **collapsible section** below each transition row
that has one. This avoids cluttering the timeline for users who only care about the state
sequence, while making the agent's output one click away.

```svelte
{#each detail.transitionHistory as t, i (i)}
  <div>
    <div class="flex items-center gap-2 text-sm font-mono">
      <span class="text-muted-foreground text-xs w-16 shrink-0">{formatTime(t.timestamp)}</span>
      <span class="text-foreground/70">{t.from}</span>
      <span class="text-muted-foreground">&rarr;</span>
      <span class="text-foreground">{t.to}</span>
      {#if t.event}
        <Badge variant="outline" class="ml-1">{t.event}</Badge>
      {/if}
      <span class="text-muted-foreground text-xs ml-auto">{formatDuration(t.durationMs)}</span>
      {#if t.agentMessage}
        <button
          class="text-xs text-primary hover:underline ml-2"
          onclick={() => toggleMessage(i)}
        >
          {expandedMessages.has(i) ? 'hide' : 'show'} message
        </button>
      {/if}
    </div>
    {#if t.agentMessage && expandedMessages.has(i)}
      <div class="ml-20 mt-1 mb-2 p-3 rounded bg-muted/50 text-sm prose prose-invert max-w-none">
        {@html renderMarkdown(t.agentMessage)}
      </div>
    {/if}
  </div>
{/each}
```

State management for collapsed/expanded is a local `Set<number>` toggled by index:

```ts
let expandedMessages = $state(new Set<number>());

function toggleMessage(index: number): void {
  const next = new Set(expandedMessages);
  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  expandedMessages = next;
}
```

The message content is rendered as markdown using the existing `renderMarkdown` utility from
`$lib/markdown.ts` (already used by the session console for agent responses), sanitized via
DOMPurify.

## 6. Size/truncation strategy

Three levels of truncation:

| Layer | Limit | Rationale |
|-------|-------|-----------|
| `previousAgentOutput` (domain context) | 32 KB | Already enforced by `truncateAgentOutput()` in `machine-builder.ts` |
| `TransitionRecord.agentMessage` (domain) | 4 KB | Per-transition budget. Agent output is 32 KB but most of that is code/artifacts. A 4 KB summary captures the narrative. |
| DTO wire format | No additional truncation | 4 KB per transition is already wire-safe; a workflow with 20 transitions is 80 KB total. |

The `truncateForTransition` function (added to `src/workflow/orchestrator.ts`, not exported):

```ts
const MAX_TRANSITION_MESSAGE_BYTES = 4096;
const TRANSITION_TRUNCATION_NOTICE = '\n\n[... truncated]';

function truncateForTransition(text: string | null): string | undefined {
  if (!text) return undefined;
  if (Buffer.byteLength(text, 'utf-8') <= MAX_TRANSITION_MESSAGE_BYTES) {
    return text;
  }
  const budget = MAX_TRANSITION_MESSAGE_BYTES - Buffer.byteLength(TRANSITION_TRUNCATION_NOTICE, 'utf-8');
  let truncated = text;
  while (Buffer.byteLength(truncated, 'utf-8') > budget) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return truncated + TRANSITION_TRUNCATION_NOTICE;
}
```

The replay engine uses a matching standalone `truncateForTransition` (same logic, defined locally
since the replay engine does not import from `src/`).

## 7. File-by-file impact list

| File | Change |
|------|--------|
| `src/workflow/types.ts` | Add `agentMessage?: string` to `TransitionRecord` |
| `src/workflow/orchestrator.ts` | Add `truncateForTransition()`. Update `subscribeToActor` to populate `agentMessage` on each transition record using context fields. |
| `src/web-ui/web-ui-types.ts` | Add `agentMessage?: string` to `TransitionRecordDto` |
| `src/web-ui/dispatch/workflow-dispatch.ts` | Pass `agentMessage` through in `buildDetailDto()` transition mapping |
| `packages/web-ui/src/lib/types.ts` | Add `agentMessage?: string` to `TransitionRecordDto` |
| `packages/web-ui/scripts/replay-engine.ts` | Add `agentMessage` to local `TransitionRecord`. Add `lastHumanPrompt` to `ReplayState`. Populate `agentMessage` in `translateEntry` for `state_transition` entries. Add local `truncateForTransition()`. |
| `packages/web-ui/src/routes/WorkflowDetail.svelte` | Add collapsible message section below each transition row. Import `renderMarkdown`. Add `expandedMessages` state + `toggleMessage`. |

No new files. No changes to the WebSocket event protocol or JSON-RPC methods. No changes to
checkpoint serialization format (the new field is optional and backward-compatible).
