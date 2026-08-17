- MITM should implement deterministic steering or command rewrite for weaker models that struggle with running a complex harness. see the insights from getting DeepSeekV4 to run - also see: https://github.com/DataArcTech/Bayesian-Agent

- Per-state agent harness selection in workflows (different `dockerAgent` per state, e.g. coder on claude-code, critic on goose/codex). Inspired by Databricks Omnigent meta-harness. Notes:
  - Mirror the existing `model` two-level pattern: state-level `dockerAgent` overriding `settings.dockerAgent`. Adapters (claude-code/goose/codex) already abstract image/MCP-config/output-parsing, and states communicate only through harness-neutral channels (shared workspace, forwarded response text, `agent_status` verdict block), so state boundaries are the natural swap point. Intra-state `--continue` continuity is unaffected (a state uses one harness).
  - **CRITICAL: sharedContainer implications.** sharedContainer is very powerful precisely because installed packages and in-container execution output/state PERSIST across states in the one bundle. Heterogeneous harnesses can't hot-swap the agent binary/image in a running container, so they force separate containers — losing that cross-state persistence. Must carefully weigh this before adopting non-shared per-state harnesses. Proposed resolution: bind harness to `containerScope` (already the container-identity unit) — each distinct scope gets its own bundle/image/coordinator/control-socket, preserving per-scope package+execution persistence AND per-scope policy hot-swap; reject mixing harnesses within one scope at validation. You keep within-scope persistence and pay for an extra bundle only when you actually cross harnesses.
  - Non-shared mode is nearly free (each state already builds its own container; just thread `state.dockerAgent ?? settings.dockerAgent` into adapter lookup at the single `agentId` selection seam in machine-builder/orchestrator).
  - Edge cases: model validity becomes harness-relative (add a lint check "state model invalid for resolved harness" to the WF00x catalog); global `--model` CLI override can't blanket-apply across mixed harnesses (scope it or warn); goose fixes model at container startup (no per-turn switch); trajectory capture stays uniform only while every harness talks an Anthropic-compatible endpoint.
  - Strongest use cases: adversarial review diversity (coder on harness A, critic on harness B — a reviewer that doesn't share the implementer's blind spots); per-phase capability/cost matching; A/B-ing harnesses on identical state inputs for SFT/RL data (run-state already supports --mode + per-FSM-state trajectory capture).

Other Omnigent-inspired candidates (security-aligned extensions to the trust boundary):

- Stateful / contextual policies: PolicyEngine.evaluate() is currently stateless per-call. Wire session state (ServerContextMap / ApprovalWhitelist / CircuitBreaker history) into rule predicates so rules can express e.g. "escalate writes to files this agent didn't create" or "require approval once the agent fetched from npm". Highest-leverage extension; scaffolding already exists, it just doesn't feed policy.
- Egress-as-policy at the MITM: today the MITM does TLS-term + endpoint allow-list + credential swap but does NOT policy-evaluate raw HTTP egress (and has an ALLOW_ALL_HOSTS escape hatch). Route egress through the same allow/deny/escalate engine that governs MCP tool calls.
- Two-person / quorum approval for high-risk escalations (separation of duties) — a security-flavored take on Omnigent's collaboration, riding on the existing escalation flow. NOT general free-form multi-human steering.
- Explicitly NOT a fit: remote/cloud execution backends (Modal/Daytona) — breaks IronCurtain's co-located trust model (host-side proxies, credentials on host); would be a trust-boundary redesign, not a feature.

Done:

- implement memory-mcp-server.md
- optimize utcp code mode - compress name space; see BAD_EXAMPLE.md
- support package installation in the sandbox? YES! Should for sure pre-install uv and ruff
- implement session-resume.md
- persona mode for sessions/cron jobs
- daemon mode should connect to signal for cron escalations
- cron mode with individual constitution -> policy, e.g. triage github issues
- policy language refinement via conditional attribute roles
- cron should help to compile policy
- remove path heuristic
