# Design: Two-Layer Loop Detection & Circuit Breaker

**Status:** Implemented
**Date:** 2026-02-18
**Author:** IronCurtain Engineering

## 1. Problem Statement

Autonomous agents are prone to "infinite loops" -- repetitive behaviors where the agent executes the same actions without making progress. This can manifest as:
- **Stagnation:** Submitting the same code and getting the same result repeatedly.
- **Stuck:** Trying different approaches that all produce the same outcome.
- **Runaway sandbox code:** A single execute_code step that hammers an MCP tool in a tight loop.

The previous approach relied on a blunt `MAX_AGENT_STEPS = 10` that stops valid long-running tasks while failing to catch tight loops early.

## 2. Key Insight

The agent doesn't call tools directly -- it writes programs via `execute_code`. Each step is a compound action. This means loop detection must happen at **two levels**, each optimized for its layer:

1. **Agent level** -- analyzes steps (code + result pairs)
2. **Proxy level** -- rate-limits individual MCP tool calls within a step

## 3. Architecture

### Layer 1: StepLoopDetector (Agent Level)

Lives in `AgentSession`, analyzes each `execute_code` step after execution.

#### 2x2 Progress Matrix

For each step, the detector computes an `approachHash` (from the code) and an `outcomeHash` (from the result), then classifies via:

|                     | **New outcome** | **Repeated outcome** |
|---------------------|-----------------|----------------------|
| **New approach**    | Full progress   | Stuck                |
| **Repeated approach** | World changed | Full stagnation      |

- **Full progress / World changed**: Reset all streaks (agent is making progress)
- **Stuck**: Increment stuck streak, reset stagnation streak
- **Full stagnation**: Increment stagnation streak, reset stuck streak

#### Thresholds

| Condition      | Warn | Block |
|----------------|------|-------|
| Stagnation     | 3    | 5     |
| Stuck          | 5    | 8     |

- **Warn**: Append guidance message to the tool result (LLM sees it naturally alongside the real result)
- **Block**: Set a persistent flag preventing further code execution; the LLM should summarize and stop

No human escalation -- the block is final until reset.

### Layer 2: CallCircuitBreaker (Proxy Level)

Lives in `mcp-proxy-server.ts`, protects against runaway sandbox code within a single step.

- **Sliding-window rate limiter**: 20 identical `(tool, argsHash)` calls within a 60-second window triggers denial
- Runs **after** policy evaluation so every call is always audited
- Returns an error to sandbox code (propagates as part of the step result)

## 4. Implementation

### Files

- `src/hash.ts` -- Shared hashing utilities (`stableStringify`, `computeHash`)
- `src/session/step-loop-detector.ts` -- `StepLoopDetector` class
- `src/trusted-process/call-circuit-breaker.ts` -- `CallCircuitBreaker` class

### Integration Points

- `src/session/agent-session.ts` -- `StepLoopDetector` wraps the `execute_code` tool
- `src/trusted-process/mcp-proxy-server.ts` -- `CallCircuitBreaker` between policy allow and MCP forwarding
- `src/session/types.ts` -- `loop_detection` diagnostic event variant

### Sequence: Agent Step

```
Agent writes code
  -> AgentSession.execute_code()
    -> Check isBlocked() -- if blocked, return error immediately
    -> Sandbox.executeCode(code)
    -> analyzeStep(code, result)
      -> Classify via 2x2 matrix
      -> Update streaks
      -> If warn: append warning to output
      -> If block: set blocked flag, append warning to output
    -> Return output to LLM
```

### Sequence: Proxy Tool Call

```
Sandbox MCP call
  -> PolicyEngine.evaluate()
  -> CallCircuitBreaker.check(tool, args)
    -> If over threshold: deny with error
  -> Forward to real MCP server
```

## 5. Hashing Strategy

Both layers use the same hashing:
- `stableStringify(value)`: Deterministic JSON with sorted keys
- `computeHash(value)`: SHA-256 of `stableStringify` output

This ensures `{a:1, b:2}` and `{b:2, a:1}` produce identical hashes.

## 6. References

- OpenClaw Loop Detection (`src/agents/tool-loop-detection.ts`)
- IronCurtain policy engine (`src/trusted-process/policy-engine.ts`)
