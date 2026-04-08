# Workflow Implementation Plan: Review & Integration Test Catalog

## Part 1: Plan Review Findings

### Finding 1: MockSession `sendMessage` lacks artifact side-effect coordination

**Severity:** Architecturally significant

The orchestrator's `executeAgentState` flow is: `sendMessage()` -> `verifyOutputs()` -> possibly re-prompt. In real execution, the agent creates artifact files as a side effect of `sendMessage()`. In tests, the `MockSession.sendMessage()` response function must also create those files on disk, or `verifyOutputs()` will always find them missing and trigger the retry path.

The plan's test helper `createDeps` does handle this (the `responses` function creates artifact directories), but the `MockSession` class itself has no facility to couple responses with filesystem side effects. This means every test that exercises the artifact verification path must independently wire up filesystem writes inside each response function. This is fragile -- if a test forgets to create the artifacts, it silently exercises the retry path instead of the happy path.

**Recommendation:** Add a `sideEffects` option to `MockSession` (or a helper that pairs responses with filesystem actions) so tests can declaratively associate artifact creation with specific responses. Alternatively, accept the pattern as-is and document it clearly in `mock-session.ts`.

### Finding 2: `WorkflowStatus` type divergence between plan and final design

**Severity:** Minor but worth noting

The plan (Module 1 types.ts) defines `WorkflowStatus` with `phase: 'completed'` carrying `finalArtifacts: Record<string, string>`. The final design (Appendix A) defines the same phase carrying `result: WorkflowResult` and `phase: 'running'` includes `activeAgents: readonly AgentSlot[]` while the plan has `round: number`. The implementation should follow the final design doc since it is authoritative.

### Finding 3: MockSession signature conformance is complete

The `MockSession` class implements all 8 methods of the `Session` interface:
- `getInfo()` -- present, returns proper `SessionInfo`
- `sendMessage()` -- present, drives the response queue
- `getHistory()` -- present, returns empty array
- `getDiagnosticLog()` -- present, returns empty array
- `resolveEscalation()` -- present, no-op
- `getPendingEscalation()` -- present, returns undefined
- `getBudgetStatus()` -- present, returns zeros
- `close()` -- present, sets `closed = true`

No missing methods. The `BudgetStatus` return uses `as any` for `limits` and `cumulative`, which is acceptable for test code.

### Finding 4: Deterministic state guard mismatch in test definition

The plan's `testDefinition` has a `test` state (type `deterministic`) with a transition guard `isApproved`. But `isApproved` is defined in `guards.ts` to extract `AgentOutput` from an XState done event. Deterministic states return `DeterministicInvokeResult` (which has `passed`, `testCount`, `errors`), not `AgentInvokeResult` (which has `output: AgentOutput`). The `isApproved` guard will return `false` for all deterministic results because `extractAgentOutput` will find no `AgentOutput` in the event payload.

**Impact:** The test definition in the plan will never route `test -> done` via the `isApproved` guard. The fallback transition (`{ to: 'implement' }`) will always fire, creating an infinite loop in the test.

**Recommendation:** Either: (a) define a `isPassed` guard that checks `DeterministicInvokeResult.passed`, or (b) replace the deterministic `test` state in test fixtures with a guard that works on deterministic results. The final design document's guard registry does not include `isPassed`, so this needs to be addressed before implementation.

### Finding 5: Module dependency direction is clean

The dependency graph is strictly downward:
- Module 1 (types) has no internal imports
- Module 2 (guards, parser) imports only Module 1
- Module 3 (machine) imports Modules 1+2
- Module 4 (artifacts, checkpoint) imports only Module 1
- Module 5 (orchestrator) imports 1+2+3+4 plus the Session interface
- Module 6 (mux integration) imports Module 1 types and Module 5 controller interface

No circular dependencies. The Session interface dependency is correctly injected via `WorkflowOrchestratorDeps.createSession`, not imported directly. The mux-to-workflow boundary is clean: only `WorkflowController` (interface) and value types cross it.

### Summary

The plan is architecturally sound. The module boundaries are well-chosen, the dependency graph is acyclic, and the injection strategy makes the orchestrator genuinely testable with mock sessions. The one significant issue (Finding 4) is a guard/event type mismatch for deterministic states that will cause test failures. The other findings are minor.

---

## Part 2: Integration Test Catalog

All tests use `MockSession` for agent responses and real temp directories for artifact storage. No LLM calls, no Docker containers, no real MCP servers. Each test creates a `WorkflowOrchestrator` with injected deps, starts a workflow from a JSON fixture, and asserts on state transitions, artifact creation, session lifecycle, and gate behavior.

### Shared Test Infrastructure

```typescript
// Helpers used across all tests

function approvedResponse(notes = 'done'): string {
  return [
    'I completed the task.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: approved',
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

function rejectedResponse(notes: string): string {
  return [
    'Found issues.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: rejected',
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

function specFlawResponse(notes: string): string {
  return [
    'The spec has a problem.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: spec_flaw',
    '  confidence: high',
    '  escalation: spec_flaw',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

function lowConfidenceApproval(notes = 'seems okay'): string {
  return [
    'I think this is done.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: approved',
    '  confidence: low',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

function noStatusResponse(): string {
  return 'I did the work. Here is the result.\nNo structured status block.';
}

/** Creates artifact directories and a file within each, simulating agent output. */
function simulateArtifacts(baseDir: string, names: string[]): void {
  for (const name of names) {
    const dir = resolve(baseDir, 'artifacts', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${name}.md`), `content for ${name}`);
  }
}

/**
 * Creates a MockSession whose response function also writes artifacts.
 * Pairs each response with the side effect the real agent would produce.
 */
function createArtifactAwareSession(
  responses: Array<{ text: string; artifacts?: string[] }>,
  baseDir: string,
  sessionId?: string,
): MockSession {
  let index = 0;
  return new MockSession({
    sessionId,
    responses: (_msg: string) => {
      if (index >= responses.length) {
        throw new Error(`MockSession exhausted at call ${index + 1}`);
      }
      const entry = responses[index++];
      if (entry.artifacts) {
        simulateArtifacts(baseDir, entry.artifacts);
      }
      return entry.text;
    },
  });
}
```

---

### Test 1: Happy Path -- Linear Workflow

**Test name:** `drives a linear workflow from plan through gate to completion`

**What it validates:**
- Complete linear execution: plan -> gate(approve) -> design -> gate(approve) -> implement -> validate(pass) -> review(approve) -> done
- Human gates pause the machine and emit `raiseHumanGate` callbacks
- `resolveGate` with APPROVE advances to the next state
- All sessions are created and closed in order
- Final status is `completed` with artifact paths
- Lifecycle events are emitted for each state transition

**Workflow definition:**
```json
{
  "name": "linear-workflow",
  "description": "Full linear workflow",
  "initial": "plan",
  "settings": { "mode": "builtin", "maxRounds": 4 },
  "states": {
    "plan": {
      "type": "agent",
      "persona": "planner",
      "inputs": [],
      "outputs": ["plan"],
      "transitions": [{ "to": "plan_gate" }]
    },
    "plan_gate": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "FORCE_REVISION", "ABORT"],
      "present": ["plan"],
      "transitions": [
        { "to": "design", "event": "APPROVE" },
        { "to": "plan", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "design": {
      "type": "agent",
      "persona": "architect",
      "inputs": ["plan"],
      "outputs": ["spec"],
      "transitions": [{ "to": "design_gate" }]
    },
    "design_gate": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "ABORT"],
      "present": ["spec"],
      "transitions": [
        { "to": "implement", "event": "APPROVE" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": ["plan", "spec"],
      "outputs": ["code"],
      "transitions": [{ "to": "review" }]
    },
    "review": {
      "type": "agent",
      "persona": "reviewer",
      "inputs": ["code", "spec"],
      "outputs": ["reviews"],
      "transitions": [
        { "to": "done", "guard": "isApproved" },
        { "to": "implement", "guard": "isRejected" }
      ]
    },
    "done": { "type": "terminal" },
    "aborted": { "type": "terminal" }
  }
}
```

**Mock session setup:**
```typescript
// Session factory keyed by persona
const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const persona = opts.persona!;
  const workflowDir = resolve(tmpDir, workflowId);

  switch (persona) {
    case 'planner':
      return createArtifactAwareSession(
        [{ text: approvedResponse('plan complete'), artifacts: ['plan'] }],
        workflowDir,
      );
    case 'architect':
      return createArtifactAwareSession(
        [{ text: approvedResponse('spec complete'), artifacts: ['spec'] }],
        workflowDir,
      );
    case 'coder':
      return createArtifactAwareSession(
        [{ text: approvedResponse('implementation done'), artifacts: ['code'] }],
        workflowDir,
      );
    case 'reviewer':
      return createArtifactAwareSession(
        [{ text: approvedResponse('looks good'), artifacts: ['reviews'] }],
        workflowDir,
      );
    default:
      throw new Error(`Unexpected persona: ${persona}`);
  }
});
```

**Assertions:**
```typescript
// 1. Start workflow
const workflowId = await orchestrator.start(defPath, 'build a REST API');

// 2. Machine enters plan, agent completes, reaches plan_gate
await waitForGate(gateRequests, 1);
expect(gateRequests[0].stateName).toBe('plan_gate');
expect(gateRequests[0].acceptedEvents).toContain('APPROVE');

// 3. Approve plan gate
orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

// 4. Machine enters design, agent completes, reaches design_gate
await waitForGate(gateRequests, 2);
expect(gateRequests[1].stateName).toBe('design_gate');

// 5. Approve design gate
orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

// 6. Machine enters implement -> review(approved) -> done
await waitForCompletion(orchestrator, workflowId);

const status = orchestrator.getStatus(workflowId);
expect(status?.phase).toBe('completed');

// 7. Verify session count: planner, architect, coder, reviewer = 4 sessions
expect(sessionFactory).toHaveBeenCalledTimes(4);

// 8. Verify all sessions closed
expect(allSessions.every(s => s.closed)).toBe(true);

// 9. Verify lifecycle events include all states
expect(lifecycleEvents.filter(e => e.kind === 'state_entered').map(e => e.state))
  .toEqual(expect.arrayContaining(['plan', 'plan_gate', 'design', 'design_gate', 'implement', 'review']));

// 10. Verify dismissHumanGate called for each resolved gate
expect(deps.dismissHumanGate).toHaveBeenCalledTimes(2);
```

**Modules exercised:** 1 (types, definition, validation), 2 (status parser, guards), 3 (machine builder), 4 (artifact manager), 5 (orchestrator, prompt builder)

---

### Test 2: Coder-Critic Loop

**Test name:** `iterates coder-critic loop until review approves, respecting round count and review history`

**What it validates:**
- Rejected verdict routes back to implement state
- Round counter increments on each agent completion
- Review history accumulates rejection notes
- Second pass through implement receives review history in the prompt
- Approved verdict on second review routes to done
- Total of 4 sessions created (coder, reviewer, coder, reviewer)

**Workflow definition:**
```json
{
  "name": "coder-critic-loop",
  "initial": "implement",
  "settings": { "mode": "builtin", "maxRounds": 4 },
  "states": {
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": ["spec?"],
      "outputs": ["code"],
      "transitions": [{ "to": "review" }]
    },
    "review": {
      "type": "agent",
      "persona": "reviewer",
      "inputs": ["code", "spec?"],
      "outputs": ["reviews"],
      "transitions": [
        { "to": "done", "guard": "isApproved" },
        { "to": "implement", "guard": "isRejected" }
      ]
    },
    "done": { "type": "terminal" },
    "failed": { "type": "terminal" }
  }
}
```

**Mock session setup:**
```typescript
let coderCallCount = 0;
let reviewerCallCount = 0;

const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const persona = opts.persona!;
  const workflowDir = resolve(tmpDir, workflowId);

  if (persona === 'coder') {
    coderCallCount++;
    return createArtifactAwareSession(
      [{ text: approvedResponse(`coder pass ${coderCallCount}`), artifacts: ['code'] }],
      workflowDir,
      `coder-session-${coderCallCount}`,
    );
  }

  if (persona === 'reviewer') {
    reviewerCallCount++;
    if (reviewerCallCount === 1) {
      // First review: reject
      return createArtifactAwareSession(
        [{ text: rejectedResponse('missing error handling'), artifacts: ['reviews'] }],
        workflowDir,
        'reviewer-session-1',
      );
    }
    // Second review: approve
    return createArtifactAwareSession(
      [{ text: approvedResponse('all issues fixed'), artifacts: ['reviews'] }],
      workflowDir,
      'reviewer-session-2',
    );
  }

  throw new Error(`Unexpected persona: ${persona}`);
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'implement feature X');
await waitForCompletion(orchestrator, workflowId);

// 1. Four sessions total: coder -> reviewer(reject) -> coder -> reviewer(approve)
expect(sessionFactory).toHaveBeenCalledTimes(4);

// 2. Status is completed
expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

// 3. Verify all sessions closed
expect(allSessions.every(s => s.closed)).toBe(true);

// 4. Verify second coder invocation received resumeSessionId from first coder session
const secondCoderCall = sessionFactory.mock.calls[2][0]; // 3rd call (0-indexed)
expect(secondCoderCall.persona).toBe('coder');
expect(secondCoderCall.resumeSessionId).toBe('coder-session-1');

// 5. Verify the second coder's prompt includes review history
const secondCoderSession = allSessions[2];
expect(secondCoderSession.sentMessages[0]).toContain('missing error handling');

// 6. Verify lifecycle events show the loop
const stateEvents = lifecycleEvents
  .filter(e => e.kind === 'state_entered')
  .map(e => e.state);
expect(stateEvents).toEqual(['implement', 'review', 'implement', 'review', 'done']);
```

**Modules exercised:** 1, 2 (guards: isApproved, isRejected), 3, 4, 5 (prompt builder with review history)

---

### Test 3: Stall Detection

**Test name:** `detects stall when coder produces identical output twice and escalates to human`

**What it validates:**
- Per-role hash comparison detects identical output
- `isStalled` guard fires when the same state produces the same hash
- Stall transitions to a human gate or failed state
- Stall detection does NOT false-positive across different roles

**Workflow definition:**
```json
{
  "name": "stall-detection",
  "initial": "implement",
  "settings": { "mode": "builtin", "maxRounds": 4 },
  "states": {
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": [],
      "outputs": ["code"],
      "transitions": [
        { "to": "stalled", "guard": "isStalled" },
        { "to": "review" }
      ]
    },
    "review": {
      "type": "agent",
      "persona": "reviewer",
      "inputs": ["code"],
      "outputs": ["reviews"],
      "transitions": [
        { "to": "done", "guard": "isApproved" },
        { "to": "implement", "guard": "isRejected" }
      ]
    },
    "stalled": {
      "type": "human_gate",
      "acceptedEvents": ["FORCE_REVISION", "ABORT"],
      "present": ["code", "reviews"],
      "transitions": [
        { "to": "implement", "event": "FORCE_REVISION" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "done": { "type": "terminal" },
    "aborted": { "type": "terminal" }
  }
}
```

**Mock session setup:**
```typescript
// Coder produces identical content both times -> same hash -> stall
let coderCallCount = 0;

const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const persona = opts.persona!;
  const workflowDir = resolve(tmpDir, workflowId);

  if (persona === 'coder') {
    coderCallCount++;
    return createArtifactAwareSession(
      [{
        text: approvedResponse(`coder output`),
        artifacts: ['code'],
      }],
      workflowDir,
    );
  }

  if (persona === 'reviewer') {
    // First review: reject to trigger second coder pass
    return createArtifactAwareSession(
      [{ text: rejectedResponse('needs work'), artifacts: ['reviews'] }],
      workflowDir,
    );
  }

  throw new Error(`Unexpected persona: ${persona}`);
});

// IMPORTANT: The artifact simulation must write IDENTICAL content both times.
// The default simulateArtifacts writes `content for code` every time, which
// produces the same hash. This is intentional for this test.
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'implement feature');

// Flow: implement -> review(reject) -> implement(same output) -> stall detected
// Machine enters 'stalled' human gate
await waitForGate(gateRequests, 1);

expect(gateRequests[0].stateName).toBe('stalled');
expect(gateRequests[0].acceptedEvents).toContain('FORCE_REVISION');
expect(gateRequests[0].acceptedEvents).toContain('ABORT');

// Verify 3 sessions: coder, reviewer, coder (stall detected after 2nd coder)
expect(sessionFactory).toHaveBeenCalledTimes(3);
```

**Modules exercised:** 1, 2 (guards: isStalled with per-role hash), 3, 4 (artifact hash computation), 5

---

### Test 4: Human Gate with FORCE_REVISION

**Test name:** `FORCE_REVISION propagates human prompt to next agent invocation`

**What it validates:**
- `resolveGate` with `FORCE_REVISION` event includes a text prompt
- The prompt is stored in `WorkflowContext.humanPrompt` via `storeHumanPrompt` action
- The next agent invocation receives the human prompt in its command text
- Machine transitions back to the specified state (not forward)

**Workflow definition:** Same as Test 1 (linear-workflow).

**Mock session setup:**
```typescript
let plannerCallCount = 0;

const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const persona = opts.persona!;
  const workflowDir = resolve(tmpDir, workflowId);

  if (persona === 'planner') {
    plannerCallCount++;
    return createArtifactAwareSession(
      [{ text: approvedResponse(`plan v${plannerCallCount}`), artifacts: ['plan'] }],
      workflowDir,
      `planner-session-${plannerCallCount}`,
    );
  }

  if (persona === 'architect') {
    return createArtifactAwareSession(
      [{ text: approvedResponse('spec done'), artifacts: ['spec'] }],
      workflowDir,
    );
  }

  // Coder and reviewer not reached in this test
  throw new Error(`Unexpected persona: ${persona}`);
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'build an API');

// 1. Wait for plan_gate
await waitForGate(gateRequests, 1);
expect(gateRequests[0].stateName).toBe('plan_gate');

// 2. Send FORCE_REVISION with a prompt
orchestrator.resolveGate(workflowId, {
  type: 'FORCE_REVISION',
  prompt: 'Focus more on error handling and retry logic',
});

// 3. Machine loops back to plan state
// Wait for the second plan_gate
await waitForGate(gateRequests, 2);

// 4. Verify the second planner session received the human prompt
const secondPlannerSession = allSessions[1];
expect(secondPlannerSession.sentMessages[0]).toContain(
  'Focus more on error handling and retry logic',
);

// 5. Verify resumeSessionId was passed for same-role continuity
const secondPlannerOpts = sessionFactory.mock.calls[1][0];
expect(secondPlannerOpts.resumeSessionId).toBe('planner-session-1');

// 6. Verify dismissHumanGate was called for the first gate
expect(deps.dismissHumanGate).toHaveBeenCalledTimes(1);
```

**Modules exercised:** 1, 2, 3 (storeHumanPrompt action), 5 (prompt builder with humanPrompt)

---

### Test 5: Human Gate with ABORT

**Test name:** `ABORT at human gate reaches aborted terminal state and closes all sessions`

**What it validates:**
- `HUMAN_ABORT` event transitions to the aborted terminal state
- Workflow status becomes `aborted`
- All active sessions are closed
- No further state transitions after abort
- Lifecycle event with `kind: 'failed'` (or similar) emitted

**Workflow definition:** Same as Test 1 (linear-workflow).

**Mock session setup:**
```typescript
const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const workflowDir = resolve(tmpDir, workflowId);
  return createArtifactAwareSession(
    [{ text: approvedResponse('plan done'), artifacts: ['plan'] }],
    workflowDir,
  );
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'build a thing');

// 1. Wait for plan_gate
await waitForGate(gateRequests, 1);

// 2. Send ABORT
orchestrator.resolveGate(workflowId, { type: 'ABORT' });

// 3. Wait for completion (aborted is a terminal state)
await waitForCompletion(orchestrator, workflowId);

// 4. Verify aborted status
const status = orchestrator.getStatus(workflowId);
expect(status?.phase).toBe('aborted');

// 5. Verify planner session was closed
expect(allSessions[0].closed).toBe(true);

// 6. Verify no more sessions were created after abort
expect(sessionFactory).toHaveBeenCalledTimes(1); // only the planner

// 7. Verify lifecycle events
const finalEvent = lifecycleEvents[lifecycleEvents.length - 1];
expect(finalEvent.kind).toBe('state_entered');
expect(finalEvent.state).toBe('aborted');
```

**Modules exercised:** 1, 2, 3, 5 (abort flow, session cleanup)

---

### Test 6: Missing Artifact Retry

**Test name:** `re-prompts agent when expected artifact is missing, succeeds on retry`

**What it validates:**
- After `sendMessage()`, orchestrator calls `verifyOutputs()` on expected outputs
- Missing artifacts trigger a re-prompt with relative paths (not host paths)
- The re-prompt message includes `STATUS_BLOCK_INSTRUCTIONS`
- Agent writes artifact on retry, orchestrator succeeds
- Total of 2 `sendMessage()` calls to the same session

**Workflow definition:**
```json
{
  "name": "artifact-retry",
  "initial": "implement",
  "settings": { "mode": "builtin" },
  "states": {
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": [],
      "outputs": ["code"],
      "transitions": [{ "to": "done" }]
    },
    "done": { "type": "terminal" }
  }
}
```

**Mock session setup:**
```typescript
const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const workflowDir = resolve(tmpDir, workflowId);
  let callCount = 0;

  return new MockSession({
    responses: (msg: string) => {
      callCount++;
      if (callCount === 1) {
        // First call: complete but DON'T create artifacts
        return approvedResponse('done');
      }
      if (callCount === 2) {
        // Second call (re-prompt): create artifacts and respond
        simulateArtifacts(workflowDir, ['code']);
        return approvedResponse('created the artifact');
      }
      throw new Error(`Unexpected call ${callCount}`);
    },
  });
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'write code');
await waitForCompletion(orchestrator, workflowId);

// 1. Workflow completed successfully despite missing artifact on first try
expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

// 2. The session received 2 messages (original + re-prompt)
const session = allSessions[0];
expect(session.sentMessages).toHaveLength(2);

// 3. Re-prompt message mentions the missing artifact with relative path
expect(session.sentMessages[1]).toContain('`code/`');
expect(session.sentMessages[1]).not.toContain(tmpDir); // no host paths

// 4. Session was closed
expect(session.closed).toBe(true);
```

**Modules exercised:** 1, 2, 4 (artifact verification, buildArtifactReprompt), 5 (retry logic)

---

### Test 7: Missing Status Block Retry

**Test name:** `re-prompts agent when response lacks agent_status block, succeeds on retry`

**What it validates:**
- `parseAgentStatus()` returns undefined for responses without a status block
- Orchestrator sends one re-prompt asking for the status block
- Second response includes valid status block, workflow proceeds
- If both attempts lack a status block, the state fails via `onError`

**Workflow definition:** Same as Test 6 (artifact-retry), but we focus on the status block.

**Mock session setup (success case):**
```typescript
const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const workflowDir = resolve(tmpDir, workflowId);
  let callCount = 0;

  return new MockSession({
    responses: (msg: string) => {
      callCount++;
      if (callCount === 1) {
        // First response: no status block, but create artifacts
        simulateArtifacts(workflowDir, ['code']);
        return noStatusResponse();
      }
      if (callCount === 2) {
        // Retry: include status block
        return approvedResponse('here is my status');
      }
      throw new Error(`Unexpected call ${callCount}`);
    },
  });
});
```

**Assertions (success case):**
```typescript
const workflowId = await orchestrator.start(defPath, 'write code');
await waitForCompletion(orchestrator, workflowId);

// 1. Workflow completed
expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

// 2. Two messages sent (original + status block retry)
const session = allSessions[0];
expect(session.sentMessages).toHaveLength(2);

// 3. Re-prompt mentions agent_status
expect(session.sentMessages[1]).toContain('agent_status');
```

**Mock session setup (failure case -- both attempts lack status block):**
```typescript
const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const workflowDir = resolve(tmpDir, workflowId);
  simulateArtifacts(workflowDir, ['code']);
  return new MockSession({
    responses: [noStatusResponse(), noStatusResponse()],
  });
});
```

**Assertions (failure case):**
```typescript
const workflowId = await orchestrator.start(defPath, 'write code');
await waitForCompletion(orchestrator, workflowId);

// Workflow failed because status block was never provided
const status = orchestrator.getStatus(workflowId);
expect(status?.phase).toBe('failed');
```

**Modules exercised:** 1, 2 (parseAgentStatus returning undefined), 5 (parseWithRetry logic)

---

### Test 8: Parallel Coders

**Test name:** `runs parallel coders with maxParallelism=2, both complete, results aggregated`

**What it validates:**
- `parallelKey` triggers `executeParallelAgentState` dispatch
- `p-limit` constrains concurrency to `maxParallelism`
- All parallel slots complete successfully
- Results from all slots are available in context
- A single XState transition fires after all parallel work completes

**Workflow definition:**
```json
{
  "name": "parallel-coders",
  "initial": "implement",
  "settings": { "mode": "builtin", "maxParallelism": 2 },
  "states": {
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": ["spec"],
      "outputs": ["code"],
      "parallelKey": "spec.modules",
      "worktree": true,
      "transitions": [{ "to": "done" }]
    },
    "done": { "type": "terminal" }
  }
}
```

**Mock session setup:**
```typescript
// Pre-populate the spec artifact with a modules array for parallel key resolution
const workflowDir = resolve(tmpDir, workflowId);
const specDir = resolve(workflowDir, 'artifacts', 'spec');
mkdirSync(specDir, { recursive: true });
writeFileSync(resolve(specDir, 'spec.md'), JSON.stringify({
  modules: ['auth', 'api', 'database'],
}));

const activeSessions: MockSession[] = [];
let maxConcurrent = 0;
let currentConcurrent = 0;

const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  currentConcurrent++;
  maxConcurrent = Math.max(maxConcurrent, currentConcurrent);

  const session = new MockSession({
    responses: async (msg: string) => {
      // Simulate some work time to test concurrency
      await new Promise(r => setTimeout(r, 50));
      currentConcurrent--;
      simulateArtifacts(workflowDir, ['code']);
      return approvedResponse('module implemented');
    },
  });
  activeSessions.push(session);
  return session;
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'implement modules');
await waitForCompletion(orchestrator, workflowId);

// 1. Workflow completed
expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

// 2. Three sessions created (one per module: auth, api, database)
expect(sessionFactory).toHaveBeenCalledTimes(3);

// 3. Concurrency was limited to maxParallelism=2
expect(maxConcurrent).toBeLessThanOrEqual(2);

// 4. All sessions closed
expect(activeSessions.every(s => s.closed)).toBe(true);
```

**Modules exercised:** 1, 2, 3, 4 (artifact resolution for parallel keys), 5 (executeParallelAgentState, p-limit)

---

### Test 9: Spec Flaw in Parallel Coder

**Test name:** `spec_flaw from one parallel coder aborts all coders and transitions back to design`

**What it validates:**
- `verdict: spec_flaw` from any parallel coder triggers abort of all parallel work
- The single invoke promise throws, routing to `onError`
- Workflow transitions to the appropriate error/redesign state
- All parallel sessions are closed despite early termination

**Workflow definition:**
```json
{
  "name": "parallel-spec-flaw",
  "initial": "design",
  "settings": { "mode": "builtin", "maxParallelism": 3 },
  "states": {
    "design": {
      "type": "agent",
      "persona": "architect",
      "inputs": [],
      "outputs": ["spec"],
      "transitions": [{ "to": "implement" }]
    },
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": ["spec"],
      "outputs": ["code"],
      "parallelKey": "spec.modules",
      "transitions": [
        { "to": "done" }
      ]
    },
    "done": { "type": "terminal" },
    "failed": { "type": "terminal" }
  }
}
```

Note: The `implement` state's `onError` in the machine builder should route to `design` (for redesign) or `failed`. The exact error target depends on `findErrorTarget()` logic. For this test, we verify the workflow does not reach `done`.

**Mock session setup:**
```typescript
const specContent = JSON.stringify({ modules: ['auth', 'api'] });
let architectCalled = false;

const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const persona = opts.persona!;
  const workflowDir = resolve(tmpDir, workflowId);

  if (persona === 'architect') {
    architectCalled = true;
    const specDir = resolve(workflowDir, 'artifacts', 'spec');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(resolve(specDir, 'spec.md'), specContent);
    return createArtifactAwareSession(
      [{ text: approvedResponse('spec ready'), artifacts: ['spec'] }],
      workflowDir,
    );
  }

  if (persona === 'coder') {
    // First coder returns spec_flaw, second returns success
    // Due to all-or-nothing cancellation, the spec_flaw aborts everything
    return createArtifactAwareSession(
      [{ text: specFlawResponse('API contract is inconsistent with auth module'), artifacts: ['code'] }],
      workflowDir,
    );
  }

  throw new Error(`Unexpected persona: ${persona}`);
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'implement the system');
await waitForCompletion(orchestrator, workflowId);

// 1. Workflow did NOT complete successfully -- spec flaw caused failure
const status = orchestrator.getStatus(workflowId);
expect(status?.phase).toBe('failed');

// 2. The error mentions spec flaw
if (status?.phase === 'failed') {
  expect(status.error).toContain('SPEC_FLAW');
}

// 3. Architect session was created and closed
expect(architectCalled).toBe(true);

// 4. All sessions (architect + parallel coders) were closed
expect(allSessions.every(s => s.closed)).toBe(true);

// 5. At least 2 coder sessions were created (one per module)
const coderSessions = sessionFactory.mock.calls.filter(
  ([opts]) => opts.persona === 'coder',
);
expect(coderSessions.length).toBe(2);
```

**Modules exercised:** 1, 2, 3, 4, 5 (parallel execution, spec_flaw detection, all-or-nothing cancellation)

---

### Test 10: Programmatic Abort Closes Active Sessions

**Test name:** `abort() closes all active sessions and stops the XState actor`

**What it validates:**
- `orchestrator.abort()` interrupts a running workflow
- All sessions in `activeSessions` are closed (containers would be killed)
- The XState actor is stopped
- Workflow status transitions to `aborted` or `failed`
- No resource leaks (sessions are cleaned up even if mid-invocation)

**Workflow definition:** Same as Test 1 (linear-workflow).

**Mock session setup:**
```typescript
// Use a slow-responding mock to keep a session active during abort
const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  return new MockSession({
    responses: async (_msg: string) => {
      // Block for a long time to simulate a running agent
      await new Promise(r => setTimeout(r, 30_000));
      return approvedResponse();
    },
  });
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'build something');

// Wait for the agent to start (session created, sendMessage in flight)
await new Promise(r => setTimeout(r, 200));
expect(allSessions.length).toBeGreaterThanOrEqual(1);

// Abort the workflow
await orchestrator.abort(workflowId);

// 1. All sessions closed
expect(allSessions.every(s => s.closed)).toBe(true);

// 2. Workflow status reflects abort
const status = orchestrator.getStatus(workflowId);
expect(status?.phase).toMatch(/aborted|failed/);

// 3. Workflow no longer in active list
expect(orchestrator.listActive()).not.toContain(workflowId);
```

**Modules exercised:** 5 (abort flow, activeSessions tracking)

---

### Test 11: Round Limit Reached

**Test name:** `stops iterating when round limit is reached`

**What it validates:**
- `isRoundLimitReached` guard fires when `context.round >= context.maxRounds`
- Workflow transitions to a human gate or terminal state instead of looping forever
- Round counter is correctly incremented by `updateContextFromAgentResult`

**Workflow definition:**
```json
{
  "name": "round-limit",
  "initial": "implement",
  "settings": { "mode": "builtin", "maxRounds": 2 },
  "states": {
    "implement": {
      "type": "agent",
      "persona": "coder",
      "inputs": [],
      "outputs": ["code"],
      "transitions": [{ "to": "review" }]
    },
    "review": {
      "type": "agent",
      "persona": "reviewer",
      "inputs": ["code"],
      "outputs": ["reviews"],
      "transitions": [
        { "to": "done", "guard": "isApproved" },
        { "to": "escalate", "guard": "isRoundLimitReached" },
        { "to": "implement", "guard": "isRejected" }
      ]
    },
    "escalate": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "ABORT"],
      "present": ["code", "reviews"],
      "transitions": [
        { "to": "done", "event": "APPROVE" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "done": { "type": "terminal" },
    "aborted": { "type": "terminal" }
  }
}
```

**Mock session setup:**
```typescript
// Reviewer always rejects, coder always produces different content
let coderVersion = 0;

const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const persona = opts.persona!;
  const workflowDir = resolve(tmpDir, workflowId);

  if (persona === 'coder') {
    coderVersion++;
    return createArtifactAwareSession(
      [{
        text: approvedResponse(`version ${coderVersion}`),
        // Write slightly different content each time to avoid stall detection
        artifacts: ['code'],
      }],
      workflowDir,
    );
  }

  if (persona === 'reviewer') {
    return createArtifactAwareSession(
      [{ text: rejectedResponse('still not good enough'), artifacts: ['reviews'] }],
      workflowDir,
    );
  }

  throw new Error(`Unexpected persona: ${persona}`);
});

// Override simulateArtifacts to produce unique content per call
// to avoid stall detection false positive
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'implement feature');

// After 2 rounds of rejection (maxRounds=2), should hit escalate gate
await waitForGate(gateRequests, 1);

expect(gateRequests[0].stateName).toBe('escalate');

// Verify exactly 4 sessions: coder, reviewer, coder, reviewer
// (2 full rounds before limit reached)
expect(sessionFactory).toHaveBeenCalledTimes(4);
```

**Modules exercised:** 1, 2 (isRoundLimitReached guard), 3 (round counter in context), 5

---

### Test 12: Low Confidence Flags for Review

**Test name:** `low confidence approval sets flaggedForReview in context`

**What it validates:**
- `isLowConfidence` guard detects `verdict: approved` with `confidence: low`
- `flaggedForReview` is set in context by `updateContextFromAgentResult`
- The flag can be used by downstream transitions to route to additional review

**Workflow definition:**
```json
{
  "name": "low-confidence",
  "initial": "review",
  "settings": { "mode": "builtin" },
  "states": {
    "review": {
      "type": "agent",
      "persona": "reviewer",
      "inputs": [],
      "outputs": ["reviews"],
      "transitions": [
        { "to": "human_review", "guard": "isLowConfidence", "flag": "lowConfidence" },
        { "to": "done", "guard": "isApproved" }
      ]
    },
    "human_review": {
      "type": "human_gate",
      "acceptedEvents": ["APPROVE", "ABORT"],
      "present": ["reviews"],
      "transitions": [
        { "to": "done", "event": "APPROVE" },
        { "to": "aborted", "event": "ABORT" }
      ]
    },
    "done": { "type": "terminal" },
    "aborted": { "type": "terminal" }
  }
}
```

**Mock session setup:**
```typescript
const sessionFactory = vi.fn(async (opts: SessionOptions) => {
  const workflowDir = resolve(tmpDir, workflowId);
  return createArtifactAwareSession(
    [{ text: lowConfidenceApproval('might be okay'), artifacts: ['reviews'] }],
    workflowDir,
  );
});
```

**Assertions:**
```typescript
const workflowId = await orchestrator.start(defPath, 'review code');

// Low confidence should route to human_review gate
await waitForGate(gateRequests, 1);
expect(gateRequests[0].stateName).toBe('human_review');

// Approve the gate
orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
await waitForCompletion(orchestrator, workflowId);

expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
```

**Modules exercised:** 1, 2 (isLowConfidence guard), 3 (flaggedForReview in context), 5

---

### Summary Table

| # | Test Name | Key Scenario | States Exercised | Primary Modules |
|---|-----------|-------------|------------------|-----------------|
| 1 | Happy path linear | Full pipeline with 2 gates | plan, gate, design, gate, implement, review, done | 1-5 |
| 2 | Coder-critic loop | Reject then approve with history | implement, review (x2), done | 1-5 |
| 3 | Stall detection | Identical hash triggers stall | implement, review, implement, stalled | 1-5 |
| 4 | FORCE_REVISION | Human prompt propagation | plan, gate, plan (loop) | 1-3, 5 |
| 5 | ABORT | Terminal abort state | plan, gate, aborted | 1-3, 5 |
| 6 | Missing artifact retry | Re-prompt on missing output | implement (with retry), done | 1-2, 4-5 |
| 7 | Missing status block | Re-prompt on missing YAML | implement (with retry), done/failed | 1-2, 5 |
| 8 | Parallel coders | Concurrency-limited parallel | implement (x3 parallel), done | 1-5 |
| 9 | Parallel spec flaw | All-or-nothing cancellation | design, implement (parallel, spec_flaw), failed | 1-5 |
| 10 | Programmatic abort | Mid-execution abort cleanup | plan (interrupted) | 5 |
| 11 | Round limit | maxRounds guard fires | implement, review (x2), escalate gate | 1-3, 5 |
| 12 | Low confidence flag | Confidence-based routing | review, human_review gate | 1-3, 5 |
