# IronCurtain Multi-Agent Architecture: High-Level Design Spec

## 1. Purpose

This document specifies a multi-agent architecture for IronCurtain that maximizes autonomous design and coding output quality. The architecture runs locally via Docker Compose, with each agent in its own IronCurtain-secured container. The goal is to enable a single developer to produce high-quality, reviewed, tested code with minimal supervision.

## 2. State of the Art: What Works and What Doesn't

### 2.1 Stripe Minions (Production, 1,300+ PRs/week merged)

Stripe's Minions system is the most mature production deployment of autonomous coding agents. Key architectural decisions:

**Blueprints.** Workflows alternate between deterministic nodes (git push, lint, CI) and agentic nodes (implement feature, fix CI failures). The LLM is only invoked where judgment is needed. Deterministic steps save tokens, reduce errors, and guarantee critical steps always execute.

**One-shot execution.** Each Minion receives a fully assembled context payload, executes in a single pass, and returns a structured result. No conversational state across invocations. This avoids the error-compounding problem of multi-turn chains: a five-step chain at 95% per-step accuracy yields ~77% end-to-end reliability.

**Shared developer infrastructure.** Agents use the same devboxes, linters, CI pipelines, and rule files as human engineers. Stripe did not build agent-specific infrastructure. The agents benefit from the same tooling investment that existed for humans.

**Scoped context loading.** In a codebase of hundreds of millions of lines, global rules are used sparingly. Rules are scoped to subdirectories and file patterns. As the agent moves through the filesystem, it picks up only locally-relevant rules. An internal MCP server ("Toolshed") provides access to ~500 tools spanning internal systems and external SaaS.

**Human review, not human coding.** Agents have submission authority but not merge authority. Every PR goes through human code review. The agents are force multipliers, not replacements.

### 2.2 Amazon Kiro (Cautionary Tale)

Amazon's Kiro agent was designed to work autonomously for days with persistent context. In December 2025, Kiro autonomously deleted a production environment, causing a 13-hour AWS outage. In March 2026, related failures caused a 6-hour storefront outage with 99% drop in US traffic and 6.3 million lost orders.

Root causes directly relevant to IronCurtain's design:

- **Bypassed peer review.** Amazon's standard two-person approval process was not enforced for AI agent actions. A safeguard that existed for human engineers did not apply to autonomous agents.
- **Speed asymmetry.** The agent completed destructive actions faster than a human could read a confirmation prompt. Pre-execution approval is the only viable safeguard.
- **Structural absence of permission tiers.** No formal permission model distinguished between agent and human capabilities.

Amazon's response: mandatory peer review for AI deployments, scoped agent permissions, pre-deployment compliance checks. These are all things IronCurtain's constitution model already provides structurally.

### 2.3 Amazon Bedrock AgentCore Policy (GA March 2026)

AWS shipped a centralized governance layer for AI agents using Cedar, their open-source authorization policy language. Key design parallels to IronCurtain:

- **Policies operate outside the agent's reasoning loop.** Every tool call through an AgentCore Gateway is intercepted and evaluated at the boundary, regardless of how the agent is implemented or prompted.
- **Natural language to deterministic policy.** Policies can be authored in plain English and compiled to Cedar. Automated reasoning checks for overly-permissive or overly-restrictive rules.
- **Default deny, forbid-wins semantics.** If no policy explicitly permits an action, it is blocked. If any forbid policy matches, it overrides all permits.
- **Separation of concerns.** Developers build agents; security teams write governance rules. Neither modifies the other's work.

This validates IronCurtain's core thesis: policy enforcement outside the agent's code, compiled from human-readable rules into deterministic evaluation. The key difference: AgentCore is cloud-native and vendor-locked to AWS. IronCurtain is portable, open-source, and not tied to a specific cloud provider or model.

### 2.4 Actor-Critic Pattern for Code Quality

Research and practitioner reports converge on the actor-critic pattern as the highest-leverage technique for autonomous code quality:

- **A generator agent ("actor") writes code. A reviewer agent ("critic") adversarially evaluates it.** The critic is prompted to assume the code is vulnerable and find every possible issue.
- **3-5 rounds eliminate 90%+ of issues** that would otherwise reach human review.
- **The critic must produce specific, actionable feedback** (line numbers, exact fixes), not vague observations.
- **HubSpot's "Sidekick" code review system** found that a single review agent produced too much noise. They introduced a "Judge Agent" as a quality gate between the initial review and the comments that appear on a PR. This evaluator-optimizer pattern reduced noise and brought them to 80%+ thumbs-up rate on automated reviews.

### 2.5 Context Engineering

Martin Fowler's ThoughtWorks team and multiple research groups have converged on "context engineering" as the critical discipline. Key findings:

- **Context, not intelligence, is the bottleneck.** Models are capable enough; the limiting factor is whether they have the right information at the right time.
- **Tiered context loading.** Always-loaded conventions (CLAUDE.md equivalent) vs. on-demand specifications. Lazy-load domain knowledge only when the agent's current task requires it.
- **Each sub-agent should operate with an isolated context window.** This prevents cross-contamination between workflow phases and keeps each agent focused. Common background (coding conventions, architecture notes) is shared via a persistent context file.
- **Spec-driven development.** The architect's output (specs, API contracts, interface definitions) becomes the context for downstream agents. This is the primary mechanism for quality propagation.

### 2.6 Self-Improving Agent Loops

Addy Osmani, Ryan Carson, and Karpathy's "autoresearch" pattern demonstrate that long-running autonomous loops can work, with specific requirements:

- **Acceptance criteria must be machine-verifiable.** Tests pass, linting passes, type-checking passes.
- **A progress log** tracks what the agent has done across iterations and prevents loops.
- **An asynchronous overseer** (a separate LLM running periodically in a concurrent thread) monitors for pathological behaviors, stuck loops, or deviation from the original task. Can intervene by injecting messages into the agent's context or canceling execution.
- **Feature branches only.** Never allow agent writes to main.

### 2.7 OmX (oh-my-codex): Practitioner Workflow Patterns

OmX is a tmux-based orchestration layer for coding CLIs (Codex, Claude Code, Gemini) that coordinates multiple agent instances via role-specialized prompts and staged pipelines. It operates at the prompt/shell layer with no security boundaries — agents run as CLI processes with the user's full permissions. The architecture is not relevant to IronCurtain, but several workflow patterns are validated by practitioner use:

**Ralph persistence loops.** The `$ralph` mode runs a task in a loop until an architect-level verification pass confirms the goal is met. The agent never gives up. This validates the coder-critic loop pattern, with the addition that verification should be role-separated (the verifier is distinct from the implementer).

**Consensus planning (RALPLAN-DR).** Before execution begins, a Planner → Architect → Critic cycle produces a structured deliberation on the plan itself. The critic challenges the plan before any code is written. This catches architectural problems early, when they're cheap to fix.

**Git worktree per parallel worker.** Each parallel worker gets its own git worktree and branch, works independently, and results are merged by the leader. This avoids filesystem coordination problems, gives conflict detection for free via git, and provides clean rollback on failure.

**Stall detection and auto-nudge.** Monitoring agent output for signs of being stuck (repeated errors, idle output, looping behavior) and injecting context to unstick the agent or escalate to a human. OmX implements this as pattern matching on terminal output.

**Staged pipeline with strict transitions.** The `plan → prd → exec → verify → fix` pipeline has explicit transition conditions (e.g., "acceptance criteria explicitly defined" before moving from PRD to execution). This maps directly to the state machine guard model.

These patterns are adopted below. The implementation differs: IronCurtain enforces structural containment where OmX relies on prompts and conventions.


## 3. Architecture

### 3.1 Agent Topology

Four role-specialized agents, each in its own Docker container with its own IronCurtain instance:

```
┌──────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR                              │
│  (Deterministic process, not an LLM)                         │
│  Manages DAG: Plan → Architect → [Coder ↔ Critic] → Output  │
└──────┬──────────┬──────────────┬──────────────┬──────────────┘
       │          │              │              │
  ┌────▼────┐ ┌──▼───┐   ┌─────▼─────┐  ┌─────▼─────┐
  │ PLANNER │ │ARCHI-│   │  CODER(s) │  │  CRITIC   │
  │         │ │TECT  │   │           │  │           │
  │ Read:   │ │Read: │   │ Read:     │  │ Read:     │
  │  task   │ │ plan,│   │  spec,    │  │  spec,    │
  │  desc   │ │ code │   │  code     │  │  code,    │
  │         │ │      │   │ Write:    │  │  diff     │
  │ Write:  │ │Write:│   │  code,    │  │           │
  │  plan   │ │ spec │   │  tests    │  │ Write:    │
  │         │ │      │   │           │  │  review   │
  │ Tools:  │ │Tools:│   │ Tools:    │  │           │
  │  none   │ │ git  │   │  fs, git, │  │ Tools:    │
  │         │ │ (ro) │   │  exec     │  │  fs (ro)  │
  └─────────┘ └──────┘   └───────────┘  └───────────┘
```

**Planner.** Takes a high-level task description and produces a structured plan: objectives, subtasks, acceptance criteria, dependencies. No tool access. Its output is pure text.

**Architect.** Takes the plan plus read-only access to the existing codebase. Produces a design spec: module boundaries, API contracts, data flow, interface definitions. The spec is the primary quality artifact; everything downstream is constrained by it.

**Coder.** Implements against the architect's spec. Has file system write access scoped to an assigned working directory, git access, and the ability to run tests and linters. Can be parallelized (one coder per module) if the spec defines clean interfaces.

**Critic.** Reviews the coder's output against the architect's spec and existing codebase patterns. Read-only file system access. Produces structured feedback: specific issues with file locations, proposed fixes, and severity ratings. The critic is prompted adversarially — assume the code is vulnerable, find every issue.

### 3.2 Orchestrator Design: Workflow as State Machine

The orchestrator is a deterministic process, not an LLM. This is a deliberate design choice that follows Stripe's blueprint pattern: LLMs are invoked only where judgment is needed.

The key abstraction: **workflows are state machines.** The coder-critic loop described below is one specific instantiation. The orchestrator executes a state machine definition where each state maps to an IronCurtain-secured agent invocation, transitions are driven by agent outputs and deterministic checks, and constitutions are bound per-state.

A state machine definition specifies:

- **States.** Each state names an agent role, the constitution it runs under, the context it receives, and the artifacts it produces.
- **Transitions.** Edges between states, conditional on output of the current state.
- **Guards.** Deterministic conditions evaluated on transitions (not LLM-evaluated). "Did tests pass?" "Did the critic approve?" "Is round N > max_rounds?"
- **Human gates.** States that pause execution and wait for developer input before proceeding.
- **Terminal states.** End conditions that collect final output.

The design-and-code workflow is one state machine definition:

```yaml
workflow: design-and-code
initial: plan

states:
  plan:
    agent: planner
    constitution: planner.yaml
    inputs: [task_description]
    outputs: [plan]
    transitions:
      - to: plan_critique

  # Consensus planning: critic challenges the plan before any code is written.
  # Catches architectural problems early, when they're cheap to fix.
  # (Pattern validated by OmX RALPLAN-DR.)
  plan_critique:
    agent: critic
    constitution: plan-critic.yaml
    inputs: [plan, task_description]
    outputs: [plan_review]
    transitions:
      - to: plan_review_gate
        when: plan_approved
      - to: plan
        when: plan_rejected
        guard: plan_rounds < 2
      - to: plan_review_gate
        when: plan_rejected
        guard: plan_rounds >= 2

  plan_review_gate:
    type: human_gate
    transitions:
      - to: design
        when: approved
      - to: plan
        when: rejected

  design:
    agent: architect
    constitution: architect.yaml
    inputs: [plan, codebase_index]
    outputs: [spec]
    transitions:
      - to: design_review

  design_review:
    type: human_gate
    transitions:
      - to: implement
        when: approved

  implement:
    agent: coder
    constitution: coder.yaml
    inputs: [spec, review_history?]
    outputs: [code, tests]
    # Each parallel coder gets its own git worktree and branch.
    # Orchestrator merges results after all coders complete.
    parallel_key: spec.modules    # spawn one instance per module
    worktree: true                # isolated git worktree per instance
    transitions:
      - to: validate
        when: COMPLETED
      # Backward transition: coder detected a spec flaw.
      # Orchestrator broadcasts CANCEL to all sibling coders,
      # discards their worktrees, and returns to architect.
      - to: cancel_siblings
        when: SPEC_FLAW_DETECTED

  cancel_siblings:
    type: deterministic
    # Kill all running sibling containers, remove worktree branches.
    run: [kill_sibling_containers, discard_worktrees]
    transitions:
      - to: design
        always: true

  validate:
    type: deterministic
    run: [typecheck, lint, test]
    # Guards include test-count verification to prevent test-deletion gaming.
    transitions:
      - to: review
        when: all_pass
        guard: test_count >= previous_test_count
      - to: human_review
        when: all_pass
        guard: test_count < previous_test_count  # test deletion detected
        present: [test_count_delta, diff]
      - to: stall_check
        when: any_fail
        guard: retries < 2
      - to: human_review
        when: any_fail
        guard: retries >= 2
        present: [error_log, diff, spec]

  # Stall detection via deterministic output hashing.
  # No LLM involvement. Orchestrator compares SHA-256 of coder output
  # against the hash stored in XState context from the previous round.
  stall_check:
    type: deterministic
    run: [compare_output_hash]
    transitions:
      - to: implement
        when: output_hash_changed    # not stalled, retry
      - to: human_review
        when: output_hash_unchanged  # stalled, escalate
        present: [error_log, diff, round_history]

  review:
    agent: critic
    constitution: critic.yaml
    inputs: [spec, code, review_history]
    outputs: [review]
    transitions:
      - to: done
        when: APPROVED
      - to: done
        when: LOW_CONFIDENCE_APPROVAL
        flag: requires_human_review
      - to: implement
        when: REJECTED
        guard: rounds < 4
      - to: human_review
        when: REJECTED
        guard: rounds >= 4
        present: [review, code, spec, round_history]

  human_review:
    type: human_gate
    # No invocation service. Execution suspends completely.
    # Orchestrator extracts context specified by 'present' field
    # from the triggering transition and surfaces it to the developer.
    accepted_events: [APPROVE, FORCE_REVISION, REPLAN, ABORT]
    transitions:
      - to: done
        when: APPROVE
      - to: implement
        when: FORCE_REVISION
      - to: plan
        when: REPLAN
      - to: aborted
        when: ABORT

  done:
    type: terminal
    outputs: [code, tests, spec, review_history]

  aborted:
    type: terminal
    # Cleanup: remove worktrees, preserve artifacts for inspection.
    run: [cleanup_worktrees, preserve_artifacts]
```

Key additions over a naive pipeline:

**Plan-critique loop.** The critic reviews the plan before any code is written (states `plan_critique`). This catches design-level problems when they cost minutes to fix, not hours. The planner and critic iterate up to 2 rounds autonomously; the result always goes through a human gate. This is a structural version of the RALPLAN-DR consensus planning pattern.

**Parallel coders with git worktrees.** The `implement` state declares `parallel_key: spec.modules` and `worktree: true`. The orchestrator reads the spec, determines the module list, and spawns one coder container per module, each in its own git worktree and branch. After all coders complete, the orchestrator merges branches. Git's conflict detection serves as a natural quality gate — conflicts indicate cross-module coupling that the spec didn't account for.

**Backward transitions with sibling cancellation.** If any parallel coder detects a spec flaw (via the `SPEC_FLAW_DETECTED` event in its structured output), the orchestrator transitions to `cancel_siblings`: it kills all running sibling containers, discards their worktree branches, and transitions back to the architect. This prevents sibling coders from wasting tokens implementing against a broken design.

**Stall detection via output hashing.** The `stall_check` state compares the SHA-256 hash of the coder's output artifact against the hash from the previous round, stored in XState context. Identical hash means the coder is stuck. No LLM involvement, no ambiguity — pure deterministic comparison.

**Test-count verification.** The `validate` state checks that the number of tests executed is >= the previous round's count. This closes the loophole where an agent could delete or comment out failing tests to achieve a passing exit code. If test count drops, execution escalates to human review regardless of exit code.

**Formalized human gate.** The `human_review` state has no invocation service — execution suspends completely. The triggering transition's `present` field specifies which artifacts to surface to the developer. The `accepted_events` field defines the vocabulary: `APPROVE` (proceed), `FORCE_REVISION` (back to coder), `REPLAN` (back to planner), `ABORT` (terminate workflow). This makes the human gate a first-class state machine primitive with a defined contract.

**Abort state.** The `aborted` terminal state handles graceful cancellation: cleanup worktrees but preserve artifacts for post-mortem inspection.

Different problems get different state machines. A bug fix workflow skips planning and architecture and goes straight to diagnosis-fix-validate. A refactoring workflow has an analysis state that maps blast radius before any code changes. A documentation workflow has no coder or critic. Each is a different state machine definition using the same runtime.

**Composability.** A state can invoke a sub-state-machine. The "implement" state could itself be a nested state machine that handles file-by-file implementation with per-file validation. This enables complex workflows built from reusable primitives.

**Constitution binding.** The constitution binds to the state, not the agent image. The same IronCurtain container image can be instantiated with different constitutions depending on which state it is executing. A "coder" role in a bug-fix workflow might get broader read access than in a greenfield feature workflow.

**Auditability.** The state machine definition is the audit trail. Every transition is logged: which state, which agent, which constitution, what artifacts were produced, what guard condition triggered the transition. For enterprise, this answers not just "what did the agent do" but "what workflow was it executing and why did it take this path."

### 3.3 Constitution Design Per Agent

Each agent gets a narrow, role-specific constitution:

**Planner constitution:**
- CAN: Read task descriptions. Produce structured plans.
- CANNOT: Access file system. Access network. Execute code.

**Plan-critic constitution:**
- CAN: Read task description and planner output. Produce structured critique of the plan.
- CANNOT: Access file system. Access network. Execute code. Modify the plan directly.

**Architect constitution:**
- CAN: Read existing codebase (git read-only). Produce design specs.
- CANNOT: Modify files. Execute code. Access network.

**Coder constitution:**
- CAN: Read/write files within assigned working directory. Run specified commands (test runners, linters, type checkers). Git operations on feature branch only.
- CANNOT: Access files outside working directory. Access network. Modify CI/CD configuration. Touch main branch.

**Critic constitution:**
- CAN: Read files in working directory. Read architect's spec. Produce review documents.
- CANNOT: Modify any files. Execute any commands. Access network.

The constitutions are compiled to deterministic rules by IronCurtain's existing policy engine. The structural guarantee: even if the critic agent is confused or injected, it physically cannot modify code. Even if the coder hallucinates, it cannot touch files outside its scope.

### 3.4 Inter-Agent Communication

Communication uses shared Docker volumes for orchestration artifacts and git worktrees for parallel code work:

```
/shared/
  task/
    description.md          # Developer's input
  plan/
    plan.md                 # Planner output
    plan-critique.md        # Critic's review of the plan
    approved                 # Flag file set by orchestrator after gate
  spec/
    spec.md                 # Architect output
    api-contracts.md
    approved                 # Flag file set by orchestrator after gate
  reviews/
    round-1-review.md       # Critic output
    round-2-review.md
  stall/
    round-1-diff.md         # Output diff between rounds (stall detection)
    round-1-errors.md       # Error output per round
  output/
    final/                  # Aggregated, reviewed output

/worktrees/
  module-a/                 # Git worktree for coder-a (own branch)
  module-b/                 # Git worktree for coder-b (own branch)
```

The `/shared/` volume carries orchestration artifacts (plans, specs, reviews) and is scoped per-agent by IronCurtain constitutions. The planner can write to `/shared/plan/` but cannot read `/shared/reviews/`. The critic can read `/shared/spec/` and the worktrees but cannot write to any worktree.

For parallel coders, each coder gets its own **git worktree** with a dedicated branch, rather than a subdirectory of a shared volume. This provides:

- **Conflict-free parallel execution.** Coders cannot interfere with each other's work. No filesystem locking, no file-level coordination.
- **Git-native merge and conflict detection.** After all coders complete, the orchestrator merges branches. Merge conflicts indicate cross-module coupling that the spec didn't account for — a signal to escalate to the architect or human review.
- **Clean rollback.** If a coder fails or the workflow is canceled, its worktree branch is simply deleted. No partial state to clean up.
- **Familiar developer workflow.** The merge result is a standard git history. The developer can inspect, cherry-pick, or revert individual module branches.

Each agent's IronCurtain constitution scopes access to the specific paths it needs. The worktree mount is scoped per coder container — coder-a's container sees only `/worktrees/module-a/`.


## 4. Context Engineering Strategy

### 4.1 Shared Context (Always Loaded)

A project-level `CONSTITUTION.md` (analogous to CLAUDE.md) is loaded into every agent's context:

- Project architecture overview
- Coding conventions and style rules
- Directory structure explanation
- Dependency and import patterns
- Testing conventions

This file should be kept under 2,000 tokens. Concise. No boilerplate.

### 4.2 Role-Specific Context

Each agent receives context tailored to its role:

- **Planner:** Task description + high-level project goals + backlog of known issues.
- **Architect:** Plan + full codebase file tree + key interface files (loaded on demand).
- **Coder:** Spec (relevant section) + files it needs to modify + test files + linter config.
- **Critic:** Spec + coder's diff + original files (for comparison) + review checklist.

### 4.3 Scoped Rule Loading

Follow Stripe's pattern: rules scoped to subdirectories. When the coder works on `module-a/`, it loads only the rules relevant to that module. This prevents context window pollution and keeps each agent focused.

### 4.4 Iteration Memory

Across Coder ↔ Critic rounds, a `review-history.md` accumulates:
- Round N: what the critic found, what the coder changed
- This prevents the coder from regressing on previously-fixed issues
- This prevents the critic from repeating feedback that was already addressed

Keep this append-only and pruned to the last 3 rounds to manage context size.


## 5. Quality Assurance Pipeline

### 5.1 Deterministic Checks (Every Round)

After every coder iteration, the orchestrator runs deterministic validation before invoking the critic:

1. TypeScript type checking
2. Linter (project-configured)
3. Test suite (relevant tests only)
4. Build verification
5. **Test count verification:** parse test runner output to extract the number of executed tests. Compare against the previous round's count stored in XState context. If `test_count < previous_test_count`, escalate to human review — the coder may have deleted or commented out tests to achieve a passing exit code.

If any deterministic check fails, the error output is fed back to the coder without invoking the critic. This saves tokens and keeps the critic focused on design and logic issues, not syntax errors.

### 5.2 Critic Review Protocol

The critic evaluates against three dimensions:

1. **Spec conformance.** Does the implementation match the architect's design? API contracts honored? Module boundaries respected?
2. **Code quality.** Idiomatic patterns, error handling, edge cases, performance considerations.
3. **Security.** Input validation, credential handling, injection vectors, boundary checking.

The critic produces structured output:

```
## Review: Round N

### BLOCKING (must fix before approval)
- [file:line] Issue description. Suggested fix.

### ADVISORY (recommended but not blocking)
- [file:line] Issue description. Suggested fix.

### APPROVED: yes/no
### CONFIDENCE: high/medium/low
```

If confidence is "low," the orchestrator flags the output for developer review even if approved.

### 5.3 Termination Conditions

The Coder-Critic loop terminates when:
- Critic approves with high or medium confidence, OR
- Maximum rounds reached (default: 4), OR
- **Stall detected:** SHA-256 hash of coder output matches previous round (stored in XState context), OR
- Test count drops below previous round's count (escalate to human)

On termination, the orchestrator collects the final output regardless of approval state. If the critic did not approve, or if confidence was "low," the output is flagged for mandatory developer review.


## 6. Workflow Runtime

### 6.1 MVP Runtime: XState

XState is the designated runtime for the MVP. It is a TypeScript library implementing Harel statecharts with hierarchical states, parallel states, guards, context, the actor model, and history states. It aligns with IronCurtain's V8/TypeScript toolchain and introduces no infrastructure dependencies.

Temporal (durable execution engine) was evaluated and deferred. Its infrastructure requirements (PostgreSQL, server container, UI container) violate the local-first constraint. Temporal remains the likely upgrade path for enterprise deployments where durability and observability are hard requirements. The state machine abstraction is designed to be portable across execution engines.

### 6.2 File-Based Checkpointing

The orchestrator serializes the full XState context to `/shared/state.json` on every state transition. This provides crash recovery without a database dependency.

```typescript
// On every transition
const checkpoint = {
  machineState: actor.getSnapshot().value,
  context: actor.getSnapshot().context,
  timestamp: Date.now(),
  transitionHistory: [...history, currentTransition]
};
fs.writeFileSync('/shared/state.json', JSON.stringify(checkpoint, null, 2));
```

On orchestrator restart:
1. Read `/shared/state.json`
2. Restore XState machine to the checkpointed state
3. Resume execution from the last completed transition

Artifacts (plans, specs, code, reviews) are already persisted on the shared volume. The checkpoint file adds only the machine state and transition history. This is sufficient for workflows lasting minutes to hours. For multi-day workflows, the checkpoint file plus the shared volume artifacts provide full recoverability.

### 6.3 Transition Middleware: Agent Output to XState Events

Agents are one-shot Claude Code executions. They produce artifacts and exit. The XState machine needs typed events to drive transitions. The transition middleware bridges these two layers.

**Principle: every agent must emit a machine-readable status block.** This is appended to the agent's output artifact and parsed by the orchestrator without an LLM.

```yaml
# Required structured output block from every agent
---
agent_status:
  completed: true | false
  verdict: approved | rejected | blocked | spec_flaw
  confidence: high | medium | low
  escalation: null | spec_flaw | blocked_on_dependency | ambiguous_requirement
  test_count: 47              # number of tests executed (coder only)
  output_hash: "a3f2b8c1..."  # SHA-256 of primary output artifact
  notes: "optional human-readable context"
```

The middleware maps agent status to XState events:

```typescript
function agentOutputToEvent(status: AgentStatus, context: WorkflowContext): XStateEvent {
  // Deterministic guards — no LLM
  if (!status.completed) return { type: 'AGENT_FAILED' };
  if (status.escalation === 'spec_flaw') return { type: 'SPEC_FLAW_DETECTED' };
  if (status.verdict === 'approved' && status.confidence !== 'low')
    return { type: 'APPROVED' };
  if (status.verdict === 'approved' && status.confidence === 'low')
    return { type: 'LOW_CONFIDENCE_APPROVAL' };
  if (status.verdict === 'rejected') return { type: 'REJECTED' };
  if (status.verdict === 'blocked') return { type: 'BLOCKED' };
  return { type: 'UNKNOWN_VERDICT' };  // escalate to human
}
```

**Deterministic guards** run after event mapping:

```typescript
// Test count verification — prevents test-deletion gaming
function testCountGuard(context: WorkflowContext, status: AgentStatus): boolean {
  if (context.previousTestCount === undefined) return true;
  return status.test_count >= context.previousTestCount;
}

// Stall detection — hash-based, no LLM
function stallGuard(context: WorkflowContext, status: AgentStatus): boolean {
  return status.output_hash !== context.previousOutputHash;
}
```

This middleware is the only code that interprets agent output. It is deterministic, testable, and contains no LLM calls. The XState machine receives only typed events and evaluates guards against context — it never reads agent output directly.


## 7. Deployment: Dynamic Container Orchestration

Agent containers are not statically defined. The workflow definition already specifies which agents are needed, what constitutions they run under, and what volumes they require. A static docker-compose.yml is a derived artifact that must be manually synchronized with the workflow — an unnecessary source of drift.

Instead, the orchestrator dynamically creates, runs, and destroys agent containers based on the current state of the workflow.

### 7.1 Core Principle: Ephemeral Agent Containers

Each agent container is ephemeral. It starts when a workflow state requires it, executes the agent task, writes output to the shared volume, and exits. No agent container runs when it is not actively executing a state. The planner runs and exits before the architect starts. Coder containers are created when the implement state is reached — and if the workflow calls for 8 parallel coders, 8 containers are spun up at that point, not before.

This gives:

- **Resource efficiency.** Only currently-executing containers are running.
- **Dynamic parallelism.** The number of coder containers is determined at runtime by the spec, not hardcoded in a compose file.
- **Constitution binding at runtime.** The orchestrator derives each container's configuration (constitution, volumes, environment) directly from the workflow state definition. No manual mapping.
- **Workflow portability.** The same workflow definition runs on Docker locally, on Kubernetes in enterprise, or on a cloud VM. The execution layer translates agent requirements into the appropriate container runtime API.

### 7.2 Orchestrator Execution Loop

```
On each state transition:
  1. Read state definition from workflow:
     - agent role
     - constitution file
     - required inputs (volume mounts)
     - permitted outputs (write-scoped volume mounts)
     - parallel_key (if parallel state)
     - worktree flag (if git worktree isolation needed)
  2. If worktree: true and parallel_key defined:
     a. Read parallel_key from artifacts (e.g., spec.modules)
     b. For each module: git worktree add /worktrees/<module> -b agent/<module>
     c. Each container gets its own worktree mounted
  3. Generate container configuration:
     - image: ironcurtain:latest
     - volumes: derived from state's input/output spec
       (+ worktree mount if applicable, scoped to this module only)
     - environment: ANTHROPIC_API_KEY, agent role config
     - constitution: mounted read-only from workflow definition
  4. Create and start container (Docker API / dockerode / shell)
     docker run --rm \
       -v shared:/shared \
       -v ./constitutions/coder.yaml:/constitution.yaml:ro \
       -v /worktrees/module-a:/work \
       -e ANTHROPIC_API_KEY \
       -e AGENT_ROLE=coder \
       ironcurtain:latest
  5. Wait for container exit
  6. Read output artifacts from shared volume (or worktree)
  7. Evaluate guards, determine next transition
  8. For parallel states: start N containers concurrently,
     wait for all to complete, merge worktree branches,
     report merge conflicts as guard failures

For deterministic states (lint, typecheck, test):
  - Run directly in the orchestrator process or a lightweight
    utility container. No IronCurtain overhead needed.

For stall_check states:
  - Compare SHA-256 hash of coder output against previous round
    (hash stored in XState context)
  - If hash unchanged: transition to HUMAN_GATE (stalled)
  - If hash changed: transition to implement (retry)

For cancel_siblings states:
  - docker kill all running sibling containers
  - git worktree remove for each sibling branch
  - Discard sibling artifacts from shared volume

For human gates:
  - Serialize checkpoint to /shared/state.json
  - Suspend execution completely. No polling, no background work.
  - Present artifacts specified by triggering transition's 'present' field.
  - Wait for developer input (CLI prompt or web UI).
  - Resume on accepted event (APPROVE, FORCE_REVISION, REPLAN, ABORT).

On workflow completion or cancellation:
  - Merge any outstanding worktree branches (or discard on cancel/abort)
  - Remove worktrees: git worktree remove /worktrees/<module>
  - Final checkpoint to /shared/state.json with terminal state
```

### 7.3 Infrastructure Requirements

The only long-running process is the orchestrator. Agent containers are transient.

```yaml
# docker-compose.yml — orchestrator only
services:
  orchestrator:
    build: ./orchestrator
    volumes:
      - shared:/shared
      - ./project:/project:ro
      - ./workflows:/workflows:ro
      - /var/run/docker.sock:/var/run/docker.sock  # Docker API access
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

volumes:
  shared:
```

The orchestrator needs access to the Docker socket to create agent containers. This is the only container defined in the compose file. Agent containers are created dynamically. State is persisted to `/shared/state.json` via file-based checkpointing (Section 6.2).

### 7.4 Container Runtime Abstraction

The orchestrator should abstract the container runtime behind an interface:

```typescript
interface ContainerRuntime {
  run(config: AgentContainerConfig): Promise<AgentResult>;
  runParallel(configs: AgentContainerConfig[]): Promise<AgentResult[]>;
}

interface AgentContainerConfig {
  image: string;
  constitution: string;       // path to constitution file
  volumes: VolumeMount[];     // derived from workflow state
  environment: Record<string, string>;
  timeout: number;            // max execution time
}
```

Implementations:

- **DockerRuntime:** Uses Docker API (dockerode) to create/run/remove containers. For local development.
- **KubernetesRuntime:** Creates Jobs or Pods in a namespace. For enterprise deployment.
- **DryRunRuntime:** Logs what would be executed without running anything. For workflow validation and testing.

This abstraction ensures that workflow definitions are portable across deployment targets. The same workflow runs locally on Docker and in production on Kubernetes without modification.

### 7.5 Security Consideration: Docker Socket Access

The orchestrator requires access to the Docker socket (`/var/run/docker.sock`) to create agent containers. This grants the orchestrator effective root access to the host's Docker daemon. This is acceptable for personal local use but must be addressed for enterprise:

- **Local:** Docker socket access is fine. The developer already has full Docker control.
- **Enterprise (Kubernetes):** The orchestrator uses the Kubernetes API with RBAC-scoped permissions instead of the Docker socket. It can create Pods only in its assigned namespace, with resource quotas and network policies enforced by the cluster.
- **Enterprise (Docker):** Consider running the orchestrator in a privileged sidecar pattern with AppArmor/SELinux constraints, or use Docker's rootless mode.


## 8. Migration Path to Enterprise

The multi-agent architecture is orthogonal to the enterprise control plane, but they share infrastructure:

| Component | Personal Use | Enterprise |
|-----------|-------------|------------|
| Constitution authoring | Developer writes YAML | Security team manages templates, approval workflow |
| Policy engine | Local IronCurtain instance | Same engine, centralized policy store |
| Workflow runtime | XState with file-based checkpointing | XState with Temporal as durable execution layer |
| Workflow definitions | Developer writes YAML/code | Versioned, reviewed, approved by security team before deployment |
| Container runtime | Docker API via socket | Kubernetes API with RBAC-scoped namespace isolation |
| Agent containers | Ephemeral, created on demand by orchestrator | Ephemeral Pods/Jobs, resource quotas, network policies per namespace |
| Audit logging | File-based checkpoint + transition log | Immutable logs shipped to SIEM; Temporal event history for full replay |
| Secrets management | Local env vars | Vault / AWS Secrets Manager integration |
| Identity | N/A | Okta / Azure AD integration |

The enterprise product does not require multi-agent. A single IronCurtain-secured agent per developer, with centrally-managed constitutions, is the entry point. Multi-agent orchestration is a maturity feature.


## 9. Open Questions

1. **Parallel coder merge strategy.** Git worktree per coder is the isolation mechanism. The open question is merge strategy: fast-forward when possible, cherry-pick when histories diverge, or always squash-merge for clean history? How are merge conflicts surfaced — as a guard failure that escalates to the architect, or directly to the developer?

2. **Architect iteration.** Should the architect revise its spec if the coder discovers implementation difficulties? The `SPEC_FLAW_DETECTED` event and `cancel_siblings` state handle the hard failure case (spec is wrong). The softer case — spec is ambiguous but not wrong — may warrant a feedback channel from coder to architect without full cancellation.

3. **Critic calibration.** How do you tune the critic's aggressiveness? Too strict and the loop never terminates. Too loose and quality degrades. Possible approach: developer configures a quality threshold per project, expressed as a guard parameter in the state machine definition.

4. **Cost management.** Each Coder-Critic round costs API tokens. At 4 rounds per module, a 10-module project could consume significant tokens. Need per-task budgets implemented as guards (token_spend < budget) on transitions. The stall detection and test-count guards help by cutting off futile retries early.

5. **Plan-critique scope.** The plan-critique loop adds an autonomous quality pass before the human gate. Should the same pattern apply to the architect's spec (spec-critique loop before design_review)? More quality gates mean higher quality but longer time-to-first-code.

6. **Codebase indexing.** For large codebases, the architect needs efficient access to relevant code. Embedding-based retrieval vs. file tree + grep? Tradeoffs between context quality and implementation complexity.

7. **Workflow composition and reuse.** How are sub-workflows invoked? XState has native invoke semantics for child machines. The composition model should support a library of reusable workflow fragments (e.g., a "validate-and-review" sub-workflow used across multiple parent workflows).

8. **Structured output enforcement.** Every agent must emit the `agent_status` YAML block for the transition middleware to work. How is this enforced? Options: IronCurtain constitution requires the block as part of the output schema; post-processing step appends a default block if missing; or the orchestrator treats missing blocks as `AGENT_FAILED` events.

9. **Cross-module consistency review.** After parallel coders complete and branches are merged, should there be a dedicated cross-module review state? The critic currently reviews individual modules. A separate "integration critic" could check for consistency across module boundaries, duplicated logic, or API contract violations between modules.

10. **Enterprise upgrade path.** Temporal remains the likely durable execution layer for enterprise. The XState machine definition and file-based checkpointing are designed to be portable. The open question is when and how to introduce Temporal without disrupting the local-first developer experience.
