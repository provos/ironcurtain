# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Behavior changes

- **Node.js 26 support** — bumped the V8 sandbox dependency `isolated-vm` to 7.0.0 (via an npm `override`, since it is transitive through `@utcp/code-mode`) so Code Mode initializes on Node 26; `isolated-vm` 6.x has no Node 26 prebuild and fails to compile against Node 26's V8. The supported range is now Node 22–26 (`engines` `>=22.0.0 <27`): Node 24 and 26 install prebuilt native binaries, while Node 22 compiles `isolated-vm` from source at install (no prebuilt binary ships for it, so a C/C++ toolchain is required). CI runs Node 24 and 26 on every PR and adds a Node 22 source-compile job on pushes to master (#356).

## [0.12.0] - 2026-06-26

### Features

- **Codex CLI agent and token-trajectory capture** - added a Docker adapter for Codex CLI alongside faithful OpenAI/Codex token trajectory capture for SFT/RL training data. `--capture-traces` is wired through mux PTY sessions and daemon-launched workflows, with trajectory reassembly/tap support and documentation for downstream training pipelines (#273, #276, #280, #288).
- **Evolve workflow** - new native workflow for iterative candidate evolution: deterministic container execution with packaged scripts, a structured deterministic result contract for verdict routing, single-round and multi-round execution, human-surface gates, final summaries, abort handling, a generic experiment harness, correctness stop conditions, resume idempotency, search-quality cognition promotion, multi-parent/selectable samplers, and synchronous N-way fan-out lanes (#292, #299, #300, #302, #303, #309, #313, #315, #323).
- **Workflow runtime and gate improvements** - workflow agents can now use daemon-driven gates, shared containers can be snapshotted and resumed across resumable stops, workflow workspace artifacts auto-refresh on lifecycle events in the web UI, and workflow dependencies are installed at runtime instead of requiring per-workflow baked images (#304, #308, #316, #318).
- **Web UI workflow and persona management** - added workflow statistics to the dashboard, hid test workflows from normal lists, added a workflow README modal, added copy-to-clipboard for workflow instructions, polished workflow pages, and introduced WebSocket-driven persona policy management (#283, #312, #340, #347).
- **Apple container runtime backend and Rust fuzzing toolchain** - added an Apple `container` runtime backend plus Rust fuzzing support for agent/container workflows (#290).
- **Cargo package proxying** - the MITM package proxy now supports Cargo/crates.io, extending the package-install mediation model beyond npm, PyPI, and apt (#348).
- **Memory MCP server 0.2.0 integration** - upgraded the bundled memory server path with atomic-fact ingest, parent-context retrieval, new memory documentation, Docker build-context handling, and the separately tagged `memory-mcp-server/v0.2.0` release (#335, #337, #339).
- **Vulnerability-discovery hardening** - discovery now better resists masked findings, lost runs, background-wait ambiguity, and hanging harness validation (#268, #281).

### Behavior changes

- **Workflow dependencies install at runtime** - workflows no longer bake a per-workflow Docker image just to include dependency files; the runtime installs them in the active workflow environment (#308).
- **Leaf subcommands parse arguments strictly** - invalid trailing or misplaced arguments are rejected earlier for CLI leaf commands (#279).
- **Builtin mode honors configured model provider** - preflight/model-provider handling now respects the configured provider when running outside Docker (#287).
- **Discussions linked from issue templates** - the GitHub issue chooser now points users toward Discussions for support and exploratory topics.

### Fixes

- **Codex provider-host WSS fallback** - provider-host WebSocket upgrade attempts are fast-rejected so Codex falls back to HTTP instead of hanging through the MITM proxy (#341).
- **Workflow teardown and gate CLI reliability** - Docker teardown is drained before CLI exit to avoid network leaks, and bad-flag errors preserve the gate CLI's JSON/exit-code contract (#311, #314).
- **Workflow harness boundedness** - vulnerability-discovery harness validation and workflow harness execution now use hard-kill bounds to avoid indefinite hangs (#268).
- **Trajectory capture robustness** - missing-terminal token streams are classified as mid-stream aborts, improving retry/recovery decisions (#289).
- **Docker UID/GID remap** - benign Linux GID collisions are handled during agent UID/GID remapping (#333).
- **Sandbox tool-error suggestions** - UTCP manual prefixes no longer leak into tool-error suggestions (#301).
- **Memory DB schema safety** - incompatible memory databases are backed up before schema rebuild, and tests run serially to avoid model-download races (#337, #339).

### Dependencies

- Bump `@provos/memory-mcp-server` to `^0.2.0`.
- Bump `undici` to `^8.5.0`.
- Bump web UI dependencies including `vite`, `dompurify`, `hono`, `ws`, `qs`, `js-yaml`, `tar`, `form-data`, and related transitive security updates.
- Bump `actions/checkout` from 6 to 7.

### Internal

- Broke a workflow runtime import cycle and added a `madge` pre-push cycle gate (#277).
- Added detailed daemon WebSocket JSON-RPC and workflow human-gate documentation.
- Marked evolve design slices as shipped and reconciled design documents with the implementation.
- Promoted mux over raw PTY in user-facing docs.

## [0.11.0] - 2026-05-18

### Features

- **Vulnerability discovery workflow** — the marquee 0.11.0 feature: an orchestrator-driven, hub-and-spoke FSM that hunts memory-safety and logic bugs in native code under a user-supplied threat model. **Run it from the web UI** (`ironcurtain daemon --web-ui` → Workflows → New run): the visual state-machine graph, per-state agent-message timeline, gate review panel, artifact browser, and live escalation modal are the intended way to follow a multi-hour discovery run — agent sessions span hours and produce many artifacts, which the CLI is not equipped to surface comfortably. The orchestrator routes between a structural `analyze` state, a tiered harness pipeline (`harness_design` → reviewer loop → `harness_build` → `harness_validate`), differential validation, `discover`/`triage` for hypothesis confirmation, an LLM `review` pass, and a final human `report_review` gate; each agent state ships per-hypothesis directives written into a persistent investigation `journal.md`. Harness build/validate uses a Tier 1 (isolated function) / Tier 2 (multi-component) / Tier 3 (full build) ladder picked mechanically from hypothesis scope, with libFuzzer/AFL++ coverage-feedback gating to catch the common failure mode where instrumentation never reaches the target. Domain content is factored into reusable skills — `memory-safety-c-cpp` (bug-class taxonomy with Class A/B/C delegate-library realism), `harness-design-fuzzing`, `vulnerability-triage` — loaded per-state, while ordering stays in the FSM. Conclude writes a `report.md` index plus one `report.h<N>.md` per hypothesis. Quota exhaustion (HTTP 429) and upstream stalls preserve the checkpoint so the run resumes where it stopped. CLI access via `ironcurtain workflow start vuln-discovery "<task>"` remains for scripting and debugging (#169, #175, #199, #198, #241, #229).
- **Workflow web UI — the intended way to run workflows.** Opt-in Svelte 5 dashboard launched by `ironcurtain daemon --web-ui` (default `http://localhost:7400`, bearer-token auth). The Workflows panel hosts the full lifecycle: start a new run (workflow picker, model selection, workspace path, task description), watch active runs through a live state-machine graph (dagre + SVG) with per-state agent-message timeline and markdown rendering, review gates with a workspace + artifact browser, and respond to escalations through an overlay modal with inline indicators. A Past section lists completed/failed/aborted runs by scanning `~/.ironcurtain/workflow-runs/` (checkpoints are now retained on success, and historical checkpoint-less runs are reconstructed from the message log via the shared `discoverWorkflowRuns` utility). The same daemon also serves the Sessions, Escalations, and Jobs views. Vuln-discovery and every other multi-agent workflow is meant to be driven from here — CLI workflow commands exist primarily for scripting and debugging (#154, #157, #163, #200).
- **Multi-agent workflow engine** — the orchestration layer that powers the web UI: an XState v5 state machine with typed events, guards, agent/gate/deterministic states, declarative `when:` verdict conditions on transitions, per-state `maxVisits` caps with bounded-loop escalation, transition `actions:` (including `resetVisitCounts`), `freshSession` control, artifact versioning that snapshots `.v<N-1>` backups on re-entry, and crash-resume via on-disk checkpoints. Workflow definitions are now packaged as directories (`<name>/workflow.yaml`) with YAML preferred over JSON, required `description` fields surfaced in web UI tooltips and CLI inspect output, and arbitrary verdict strings for direct routing. The same engine runs identically behind the web UI (the intended interface), `mux`, and the `ironcurtain workflow start|resume|inspect|list` CLI (provided for scripting and debugging) (#159, #163, #165, #169, #188, #190).
- **Workflow shared-container mode** — opt in via `settings.sharedContainer: true` in a workflow YAML. One Docker container and one `ToolCallCoordinator` serve every agent state in the run; the orchestrator hot-swaps the active `PolicyEngine` between states via `POST /__ironcurtain/policy/load` over a per-run Unix domain control socket, and the coordinator swaps under `callMutex → policyMutex`. Audit entries are tagged with `persona` and written to a single `audit.jsonl` per run. Run artifacts consolidate under `~/.ironcurtain/workflow-runs/<id>/` with `bundle/`, `states/<stateId>.<visitCount>/`, `audit.jsonl`, and `messages.jsonl`; nothing lands under `~/.ironcurtain/sessions/` for a workflow run. The new `containerScope` primitive lets workflows split states across multiple bundles when isolation is needed. Implements Steps 4–5 of `docs/designs/workflow-container-lifecycle.md` (#184, #186, #187, #191).
- **Agent skills (SKILL.md)** — drop SKILL.md packages under `~/.ironcurtain/skills/<name>/` to make purpose-specific guidance available to every Docker session; the merged set is staged so each agent's _native_ skill discovery picks it up. Claude Code is pointed at the staging dir via `--add-dir <parent>`; Goose scans `~/.config/goose/skills/<name>/SKILL.md`. Each agent adapter declares its own `skillsContainerPath` and the Docker infrastructure issues a dedicated **read-only** bind mount at that path. Workflows ship per-state skills via `<workflow-pkg>/skills/<name>/SKILL.md` and an optional `skills: [...]` field on agent states (omit = all workflow skills, `none` sentinel = clean slate). Persona skills (`~/.ironcurtain/personas/<name>/skills/`) apply to standalone sessions. See [WORKFLOWS.md](WORKFLOWS.md#skills) (#227).
- **`ironcurtain doctor` command** — on-demand setup diagnostics that runs every health check independently and surfaces a single punch list (Node version, V8 sandbox viability, Docker availability with categorized errors, config parse, compiled policy / constitution / annotation drift, Anthropic OAuth/API-key presence and expiry, per-MCP-server env vars, and live `tools/list` against each configured server). Opt-in `--check-api` adds a 1-token round-trip and OAuth refresh validation (#206).
- **Pre-flight checks for sandbox / Docker / OAuth** — `start`, `daemon`, `bot`, and `workflow` now spawn a child Node process that imports `@utcp/code-mode` to validate the V8 sandbox before doing anything; SIGSEGV/SIGILL maps to "use Node 22–24", `NODE_MODULE_VERSION` to "npm rebuild", and missing packages to "npm install". Success is cached at `~/.ironcurtain/.preflight-ok`. Docker availability returns a tagged union with targeted messages for ENOENT, permission denied, and "Cannot connect to the Docker daemon." OAuth-only-without-Docker now fails fast with a remediation hint instead of silently dropping into builtin and later 401-ing. Mux runs the same preflight in the parent before entering fullscreen so failures surface cleanly (#203, #213, #244).
- **Configurable Docker container resources with auto-clamp and probe** — new `dockerResources: { memoryMb, cpus }` field in `~/.ironcurtain/config.json` (each independently nullable; `null` = no limit), editable via `ironcurtain config` → Docker Agent → Container resources. Values are auto-clamped against `os.cpus()` / `os.totalmem()` before reaching Docker. `ironcurtain doctor` and the first-start wizard run a real `docker run --rm --cpus N --memory Mm <image> /usr/bin/true` probe, parse Docker's stderr for rejection patterns, and suggest concrete lowered values. Necessary on small hosts (2-vCPU VMs) and on macOS Docker Desktop where `os.cpus()` over-reports vs. the VM (#247).
- **Idle-timeout watchdog for Docker pull / build** — replaces hard wall-clock timeouts on `docker pull` and `docker build` with a progress-aware idle watchdog (`spawnWithIdleTimeout`); legitimate multi-hour pulls of large base images (e.g. `devcontainers/universal`) now succeed, only true silence kills the child. A TTY-aware progress sink collapses the per-layer / per-step chunk flood into a single in-place updating status line (`docker pull  4/12 layers  2 downloading`); non-TTY stderr passes the raw transcript through (#250, #251, #260).
- **Linux UID/GID remap for agent containers** — on Linux hosts where the user's UID/GID isn't 1000, the agent container now starts as root (`--user 0:0`) with host UID/GID passed via env; the entrypoint runs `usermod`/`groupmod`/`chown` to renumber the baked `codespace` user to match the host, then drops privileges via `exec runuser -u codespace`. Fixes the "Not logged in / Please run /login" symptom on Kali, NixOS, and other non-default-UID environments where bind-mounted credential files were unwritable. macOS is unchanged. Centralized in `buildAgentUidRemap()` and shared by batch- and PTY-mode container creation (#245).
- **Per-persona / per-job memory opt-in** — `PersonaDefinition.memory?: { enabled: boolean }` and `JobDefinition.memory?: { enabled: boolean }` let users disable the memory MCP server for individual personas / cron jobs (default on). The global `userConfig.memory.enabled` kill switch still wins. `MEMORY_SERVER_NAME` was removed from the persona resolver's always-included set; the workflow orchestrator now spawns the memory relay only when at least one persona in scope opts in, closing a shared-container gap where the prompt advertised memory but the relay was absent. CLI surfaces the toggle via `persona create/edit`, `daemon add-job/edit-job`, and `ironcurtain config -> Memory` (#215).
- **Real-time LLM token stream observation** — the MITM proxy taps Anthropic/OpenAI SSE and JSON responses inside Docker agent sessions and publishes structured `TokenStreamEvent`s on a shared pub/sub bus. New `ironcurtain observe` command renders a Matrix-style data rain panel alongside formatted tool calls, results, thinking text, and assistant output by subscribing through the daemon's WebSocket. Workflow summary `totalTokens` is now accumulated from `message_end` events across all the workflow's agent sessions and displayed in the UI (#178, #211).
- **Matrix rain login page** — web UI auth screen renders a Canvas 2D Matrix rain that assembles into the "IronCurtain" wordmark (#180).
- **`IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` escape hatch** — opt-in env var makes the MITM proxy treat every unknown host as a passthrough TCP tunnel, bypassing the CONNECT allowlist for HTTPS, plain HTTP, and WebSocket upgrades. Provider/registry traffic is unchanged (TLS termination and credential swap still apply); only unknown hosts get the wildcard. Logs a `WARN` on proxy startup so the posture downgrade is visible in the audit trail (#249).
- **Sudo and apt-get inside agent containers** — Linux capabilities (SETUID, SETGID, CHOWN, FOWNER, DAC_OVERRIDE, AUDIT_WRITE) added so `sudo` works despite `--cap-drop=ALL`; `python3-pip` baked into both base images; `/etc/apt/apt.conf.d/90-ironcurtain-proxy` written into containers so `apt-get` routes through the MITM proxy; MITM plain-HTTP forwarding fixed for Debian registry hosts (#164).
- **Annotation drift warnings** — three drift-detection warnings between configured MCP servers and `tool-annotations.json` (policy-load time, MCP-connect time, and stale-on-disk). Previously such mismatches surfaced as silent per-call default-denies via the policy engine's `structural-unknown-tool` fallback (#193).
- **Ollama-style model IDs in workflow YAML** — `settings.model` and per-state `model` fields now accept opaque `name:tag` forms (e.g. `glm-5.1:cloud`) via a new `looseModelId` schema, while `~/.ironcurtain/config.json` slots stay on strict `qualifiedModelId` (#194).

### Behavior changes

- **Silent fallback to the builtin agent is gone.** `UserConfig` now carries `preferredMode: 'docker' | 'builtin'` (default `'docker'`); if `preferredMode: 'docker'` and Docker is unavailable, the session refuses to start with a remediation hint instead of silently dropping into builtin. `--agent` CLI flag continues to win over config. `ironcurtain doctor` treats declared-but-unmet preferences as failures (exit 1). Borderline-breaking for users who relied on the implicit downgrade — set `preferredMode: 'builtin'` explicitly, or pass `--agent builtin`, to keep the old behavior. Closes feedback where testers ran in builtin mode for hours without noticing (#225).
- **MCP relays only spawn for servers the policy actually references.** `extractRequiredServers(policy)` walks `rule.if.server` in the active compiled policy; unreferenced servers are dropped from `mcpServers` before relay subprocesses start. Default-deny would have rejected every call to them anyway. The workflow factory passes the per-scope union across all personas with the same `containerScope` (#208).
- **Spawn only MCP servers that successfully connect.** When every backend of an MCP proxy subprocess fails to connect (missing env var, missing OAuth, etc.), the proxy now exits non-zero instead of staying alive with an empty tool list and causing every annotated tool to be flagged by the drift check (#259).
- **Workflow definitions are directories.** Bundled workflows ship as `<name>/workflow.yaml` (with optional sibling `skills/`) rather than a single JSON file; YAML is preferred for new authoring. Custom `.json` user workflows continue to work (#169, #227).

### Fixes

- **`ironcurtain doctor` exit code + preflight cwd resolution** — `doctor` now exits non-zero when a declared `preferredMode` cannot be honored; the sandbox-viability preflight resolves `@utcp/code-mode` from the parent via `createRequire().resolve()` so running `ironcurtain` from outside the install tree (e.g. after `npm install -g`, from `~` or `/`) no longer falsely reports a missing dependency (#266).
- **Workflow agents wedged by `ScheduleWakeup`** — the schedule built-in skill's tools are stripped from `/v1/messages` request bodies for workflow agents, and conversation-history references to those tools (Claude Code's `ToolSearch` deferred-tool fetcher surfaces them as `tool_reference` entries and `<function>{...}</function>` schema blocks) are scrubbed so Anthropic doesn't 400 the next request. Closes a workflow-abort failure mode reproduced in multi-hour runs (#258, #263).
- **Per-leg state directories** — workflow forensic dirs (`states/{stateId}.{N}/`) are now keyed on a disk scan via `nextStateSlug()` rather than the FSM `visitCounts`, so resume legs of a single visit land in fresh dirs instead of overwriting the original leg's `session.log` and `session-metadata.json` (#264).
- **Per-hypothesis discovery/triage files** — `discover` and `triage` states write per-hypothesis files instead of overwriting a single shared artifact, preserving evidence across hypotheses (#264).
- **Status-block reprompt anchored on final response** — `buildStatusBlockReprompt` now tells the agent to emit `agent_status` on the **last** response only, fixing a `harness_build` failure where multi-checkpoint runs emitted intermediate blocks and a prose-only final turn that Claude Code's `-p` JSON output dropped (#254).
- **Rotate agent conversation id on upstream stall** — Claude Code mid-stream kill (exit 143 + empty output) now retries the original prompt up to 2 times with a freshly-minted agent conversation id, instead of sending a "missing status block" reprompt against a consumed session id (#195).
- **429 quota-exhaustion resilience** — workflow runs detect upstream 429s, short-circuit retries, preserve the checkpoint, and exit as aborted (not completed) so `workflow resume` accepts the run once the quota window reopens. Sustained upstream stalls (`exit=0` + `usage.output_tokens === 0` + `stop_reason === null`) are now classified as resumable transient failures via `AgentResponse.transientFailure` (#198, #210).
- **MITM token routing in shared-container workflows** — the proxy's routing `sessionId` is now mutable and flipped by the orchestrator around each `executeAgentState`; per-response `sidAtAttach`/`sidForToolResults` snapshots prevent a mid-stream flip from splitting a single SSE response across two ids (#211).
- **Deterministic-state failures forward to the next agent** — orchestrator now propagates deterministic-state errors as agent_status notes so downstream agents see the failure (#242).
- **MCP `isError` surfaces to Code Mode** — sandbox now throws on MCP `isError` so Code Mode LLMs see tool failures instead of silently consuming an error envelope (#185).
- **Docker batch mode multi-turn context** — switched from `claude -p --continue` (silently no-ops in non-interactive print mode) to `--session-id <uuid>` on first turn + `--resume <uuid>` thereafter, fixing context loss in web UI, cron, and workflow Docker sessions (#177).
- **Mux PTY session MITM bridge** — mount the bundle sockets dir so the MITM bridge is reachable (#209).
- **Web UI bad-auth-token recovery** — UI no longer wedges on a malformed bearer token; surfaces a re-auth flow (#182).
- **Web UI stuck at `waiting_human` after gate rejection** — phase tracking refreshes after a gate verdict (#173).
- **Web UI Matrix rain review fixes** — accessibility and performance polish to the login Canvas (#183).
- **Web UI markdown rendering** — use `prose-markdown` class for consistent typography (#170).
- **Web UI e2e tests** — repair after mobile drawer + gate auto-fetch changes (#212).
- **Goose PTY readiness probe** — stop spawning a doomed agent process during the readiness check (#226).
- **Shared `validatePolicyDir` helper** — `src/config/validate-policy-dir.ts` realpath-resolves candidate policy directories and enforces containment under the IronCurtain home or the package config dir; CLI flags, the `loadPolicy` RPC, and session creation all funnel through it (#207).
- **Shared `applyAllowedDirectoryToMcpArgs` helper** — single source of truth in `src/config/index.ts` for keeping `mcpServers.filesystem.args` in sync with the active `allowedDirectory`; fixes stale paths in shared-container workflow runs.
- **Audit stream errors latch** — `AuditLog` now remembers stream errors and surfaces them synchronously on the next `log()` instead of silently dropping entries.
- **Workflow run directory hardened at 0o700** — `chmodSync` enforces the mode so the control socket and audit log are protected by filesystem permissions.
- **Zero-constraint whitelist no longer blanket-approves `add_proxy_domain`** (#151).
- **Conversation state directory mounted in Docker batch mode** (#152).
- **Base-URL env vars validated** — `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_API_BASE_URL` are now `z.url()`-validated at config load (#257).
- **`npm test -- <file>` forwards the filter to vitest.**
- **Claude Code v2 telemetry and MCP marketplace endpoints** allowed through the MITM proxy.
- **Sanitize agent output** by escaping NUL bytes and truncating to 32KB.
- **Hash workflow artifact metadata, not contents** — avoids re-hashing huge artifacts on each transition.

### Dependencies

- Bump `uuid` from 13.0.0 to 14.0.0 (#233)
- Bump `axios` from 1.15.0 to 1.16.0 (#236)
- Bump `hono` from 4.12.14 to 4.12.18 (#237)
- Bump `fast-uri` from 3.1.0 to 3.1.2 (#238)
- Bump `postcss` (dev) from 8.5.6 to 8.5.14 (#235)
- Bump `actions/github-script` from 8 to 9 (#166)
- Recurring vulnerable-package upgrades.

### Internal

- **PolicyEngine + AuditLog centralized into `ToolCallCoordinator`** — the security pipeline (`tool-call-pipeline.ts`) now owns all policy/audit/circuit-breaker/whitelist state; MCP proxy server subprocesses became pure relays (#179).
- **`DockerInfrastructure` bundle with explicit lifecycle** — reframes the implicit "bag of stuff the session owns" into a typed handle with paired `createDockerInfrastructure` / `destroyDockerInfrastructure` and an `ownsInfra` flag on `DockerAgentSession`. Pure refactor, prerequisite for shared-container mode (#184).
- **Module layering rules** — guidance added to per-directory `CLAUDE.md` files; `src/pipeline/` is offline tooling that live-session runtime must not value-import. URL normalizers, list matcher, session error hierarchy, server listing, llm-logger, and misplaced constants moved to their correct layers; event bus generified; `WorkflowManager` moved out of `src/web-ui/` (#216, #217, #218, #219, #220, #221, #222, #223, #224).
- **TokenStreamBus migrated to module singleton** (#189).

## [0.10.0] - 2026-04-01

### Features

- **Custom API gateway support** — route LLM traffic through API gateways (LiteLLM, Ollama, etc.) via `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and `GOOGLE_API_BASE_URL` environment variables or config file fields; the MITM proxy intercepts container traffic as usual but forwards upstream to the custom gateway; Code Mode passes `baseURL` directly to AI SDK providers (#148)
- **`--model` CLI flag** — override the agent model on `start` and `mux` commands (e.g., `--model jaahas/qwen3.5-uncensored:35b` for Ollama); `parseModelId()` now handles non-provider colon-separated tags; Claude Code adapter passes the model to the container via `--model` and `IRONCURTAIN_MODEL` (#148)
- **Haiku-based server pre-filter** — cheap Haiku pre-filter step during policy compilation skips servers irrelevant to the constitution, saving expensive Opus/Sonnet LLM calls; configurable via `prefilterModelId` in user config (#146)
- **Parallel server compilation** — compile all servers concurrently via `Promise.allSettled` with `p-limit` throttling (10 servers, 8 LLM calls); multi-line TTY progress display shows all servers simultaneously; adds `HTTPS_PROXY`/`HTTP_PROXY` support for AI SDK providers (#144)
- **`annotate-tools` requires explicit target** — `--server <name>` or `--all` flag required instead of always annotating everything; single-server mode merges with existing annotations; includes `--help` and server name validation (#142)
- **WebSocket and plain HTTP CONNECT tunnels** — WebSocket upgrade handling for `ws://` via `HTTP_PROXY`; passthrough CONNECT tunnels use raw TCP tunneling instead of TLS MITM, fixing plain HTTP and WebSocket connections (#139)
- **SSH agent socket in sandbox** — forward `SSH_AUTH_SOCK` into Docker containers for git operations requiring SSH keys
- **Workspace display in resume picker** — mux `/resume` picker shows the workspace directory (with `~/` shortening) when a session was started with `--workspace` (#149)
- **Enhanced Docker base images** — additional packages (`build-essential`, `cmake`, graphics/Qt libraries, common Python native deps) and passwordless sudo in arm64 image

### Fixes

- **x86_64 Dockerfile missing node-gyp** — install `node-gyp` globally in `Dockerfile.base` to match the arm64 variant; fixes Docker build failures on Windows/WSL2 (#147)
- **Stale Docker containers on resume** — clean up containers from previous sessions before starting a new one (#134)
- **Mux exited tab cleanup** — auto-remove exited tabs to restore the splash screen when all sessions end
- **Plain HTTP passthrough in MITM proxy** — fix plain HTTP connections through CONNECT tunnels for passthrough domains (#133)
- **Integration test reliability** — use local `mcp-server-filesystem` binary instead of global install

### Dependencies

- Bump `node-forge` from 1.3.3 to 1.4.0
- Bump `path-to-regexp` from 8.3.0 to 8.4.0
- Bump `picomatch` (security fix)

## [0.9.1] - 2026-03-25

### Fixes

- **macOS mux text selection** — replace X11 mouse tracking with alternate scroll mode on macOS so native text selection (Shift+drag) works in Terminal.app; scroll wheel works in command mode via arrow key mapping (#130)
- **macOS OAuth Keychain refresh** — refresh expired OAuth tokens from the macOS Keychain instead of silently falling back to API key auth; write refreshed tokens back to the Keychain via `security add-generic-password -U`; enable `OAuthTokenManager` self-refresh for Keychain-sourced credentials during long sessions (#131)

## [0.9.0] - 2026-03-24

### Features

- **Third-party OAuth onboarding** — full OAuth 2.0 flow for MCP servers with PKCE, callback server, token store with auto-refresh, interactive scope picker for Google services, `ironcurtain auth` CLI with setup guides, import, revocation, and incremental consent (#108)
- **Google Workspace MCP server integration** — credential-file rendezvous pattern (access-token-only, no refresh token in MCP server), `TokenFileRefresher` with proactive refresh, strict filesystem sandbox with `denyRead: ["~"]`, dynamic Node path discovery for nvm/volta/fnm/asdf, and new `share-permission`, `email-address`, `email-body` argument roles (#113)
- **Per-server policy compilation** — compile each MCP server independently with its own compile-verify-repair cycle, Zod-enforced server scoping to prevent cross-server rule leakage, per-server artifact caching for incremental recompilation, `--server` CLI flag for single-server debugging, annotation batching for 100+ tool servers, and point-fix repair mechanism that preserves passing rules (#118)
- **Policy-mediated MCP access for dynamic lists** — all MCP tool calls during list resolution are gated through a read-only PolicyEngine via the MCP proxy server; includes `--no-mcp` flag, compiled read-only policy covering all servers, and error surfacing for failed MCP calls (#122)
- **Escalation picker UI** — tab-per-escalation floating box overlay with single-key actions (a/d/w for approve/deny/whitelist), batch resolve-all via Shift+A/D, auto-open on new escalations with smart suppression, and narrow-terminal guards (#112, #116)
- **Ephemeral approval whitelisting** — whitelist domains, directories, or identifiers during escalation approval for session-scoped auto-approve; role-driven pattern extraction, `/approve+` syntax across CLI/mux/listener, full audit trail (#109)
- **Proxy MCP server for dynamic domains** — virtual tools (`add/remove/list_proxy_domain`) give Docker agents runtime control over MITM proxy domain allowlists via an HTTP control API on a host-only socket (#126)
- **Multiple parallel mux sessions** — per-session ownership via `muxId` replaces the global escalation-listener lock; per-session Docker networks prevent cross-session teardown; orphan detection via PID liveness checks (#110)
- **Auto-save session memory** — forced final turn after task completion prompts the agent to store session context via `memory.store`; works across all transports, configurable via `memory.autoSave` (#124)
- **Tool argument validation against input schemas** — proxy validates argument names against MCP tool `inputSchema` before forwarding, returning actionable errors with valid parameter names so the agent can self-correct (#125)
- **Scenario argument schema validation** — `inputSchema` stored on tool annotations and validated at the Zod level during scenario generation and verification, catching wrong argument names before they reach the LLM (#122)

### Fixes

- **Google Workspace token expiry** — immediate refresh check on `TokenFileRefresher.start()` and `forceRefresh()` that bypasses the 5-minute early-return threshold, preventing tokens from expiring mid-session (#123)
- **Sandbox arg resolver mangling npm packages** — skip scoped (`@org/pkg`) and versioned (`pkg@1.2.3`) specifiers when resolving relative args to absolute paths (#119)
- **Mux PTY key forwarding** — forward raw terminal-kit bytes instead of mapping key names, fixing broken Shift+Tab, F-keys, and Alt+arrow sequences (#127)
- **Claude Code WebFetch in Docker** — add `skipWebFetchPreflight` and `HTTPS_PROXY` to Docker settings so WebFetch works through the MITM proxy (#129)
- **Docker exec timeout logging** — detect and log timeout duration for docker exec calls; guard against empty Signal responses (#128)
- **Fetch server JSON responses** — return structured `{ error, status, headers, body }` JSON from `http_fetch` instead of concatenated plain text (#114, #115)
- **SSH agent forwarding** — forward `SSH_AUTH_SOCK` to the MCP server proxy process, fixing 60-second hangs on `git push`
- **Mux shutdown spinner** — exit fullscreen before showing the shutdown spinner so it is always visible on `/quit`
- **workspace:\* protocol** — replace pnpm-specific `workspace:*` with semver range for npm compatibility (#111)

### Improvements

- **Remove sideEffects from tool annotations** — the boolean was nearly useless (81/85 tools marked true); argument roles already capture security-relevant characteristics (#118)
- **Remove monolithic compilation path** — all compilation routes through `runPerServer()`, deleting ~577 lines of dead code (#122)
- **Increase Docker container resources** — bump defaults to 8 GB memory and 4 CPUs for resource-intensive workloads (#107)
- **storedAnnotations mandatory throughout pipeline** — single required code path after monolithic removal, eliminating optional guards and fallbacks (#122)

## [0.8.0] - 2026-03-15

### Features

- **Secure package installation proxy** — npm and PyPI registries are proxied through the MITM layer with metadata filtering (age-gate quarantine, allow/denylists), tarball backstop validation, and per-package audit logging; containers can now `npm install` and `pip install` packages at runtime without direct network access (#101)
- **Debian apt registry proxy** — `apt-get install` works inside Docker containers by proxying `deb.debian.org` and `security.debian.org` through the MITM proxy; GPG-signed metadata passes through unmodified, `.deb` downloads go through backstop validation (#105)
- **Memory MCP server integration** — persistent memory with semantic search, LLM summarization, and automatic compaction; integrates with personas and sessions for context-aware recall (#95, #98)
- **Persona picker in mux mode** — interactive persona selection overlay in the `/new` flow with workspace browsing pre-filled from persona defaults (#104)
- **Session resume for Docker PTY sessions** — resume previous sessions with `--resume`, conversation state persistence, snapshot validation, and session scanner UI (#94)
- **Server-namespace tool naming** — tools use `serverName__toolName` format with prefix stripping for cleaner display (#102)
- **Pre-installed Python 3.12 in Docker base images** — containers no longer need to download Python at runtime, preventing failures in network-isolated environments

### Fixes

- **PyPI sidecar file handling** — strip PEP 658/714 sidecar suffixes (`.metadata`, `.provenance`) before filename parsing in the registry proxy, fixing fail-closed denials for pip/uv metadata fetches (#105)
- **Memory context missing memories** — fix `memory_context` tool not returning memories and LLM config passthrough (#103)
- **Roots expansion race condition** — retry tool calls after roots expansion with 200ms delay when the filesystem server hasn't finished processing updated roots (#93)
- **Harden arm64 Docker base image** — expand system packages with build tools, graphics/Qt libraries, X11/XCB deps, and fonts needed for Python packages with native extensions (#105)
- Upgrade vulnerable package versions

### Improvements

- **Re-enable OS-level sandbox for git MCP server** — upgrade `@anthropic-ai/sandbox-runtime` to 0.0.42 which supports selective network access on Linux; git server now runs sandboxed with filesystem restrictions (`~/.gnupg`, `~/.aws` denied) and network limited to GitHub/GitLab domains
- Use `UV_NATIVE_TLS` in Docker base images for MITM CA trust with uv
- Shared Python install directory (`/opt/uv-python`) across users
- Use Debian Trixie base for arm64 image (GLVND transition)

## [0.7.2] - 2026-03-11

### Fixes

- **Mux command-mode input retention** — preserve the input buffer when toggling between command mode and PTY mode with Ctrl-A; previously any typed text was lost on mode switch
- **Stay in command mode after /new** — spawning a new session via `/new` (quick-spawn or directory picker) now returns to command mode instead of switching to PTY mode

## [0.7.1] - 2026-03-10

### Fixes

- **macOS PTY session networking** — reverse PTY socat direction in the sidecar so the host can reach the container's PTY socket (MCP/MITM remain container→host); skip the readiness probe for TCP since the container's socat only accepts one connection; add retry logic in `attachPty` that polls until the connection receives data; allocate dynamic host ports via `findFreePort()` to avoid collisions between concurrent PTY sessions (#89)
- **Filesystem server path in PTY sessions** — export and reuse `patchMcpServerAllowedDirectory()` so the filesystem MCP server's directory arg points to the actual session workspace instead of the stale default from `loadConfig()` (#87)
- **macOS node-pty spawn-helper** — auto-fix missing execute permission on the node-pty `spawn-helper` binary at startup; show actionable error if chmod fails (e.g., read-only npx cache)
- **MITM leaf certificate renewal** — track per-cert expiry and regenerate 1 hour before the 24-hour validity window closes, preventing "SSL certificate has expired" errors in long-running sessions (#84)
- **OAuth token endpoint** — update refresh endpoint from `console.anthropic.com` to `platform.claude.com/v1/oauth/token`
- **Sentinel triage** — widen the `since` window from 24 hours to 30 days so expired challenges are not silently filtered; use `includes()` for marker matching
- Upgrade vulnerable package versions

### Features

- **Persona system** — named profiles bundling a constitution, compiled policy, server filter, persistent workspace, and memory file under `~/.ironcurtain/personas/<name>/`; CLI commands (`persona create/list/compile/edit/delete/show`), `--persona` flag for `start`, Signal `/new [persona]`, cron `persona` field, and session metadata persistence for `--resume` (#82)
- **Auto-generate constitutions for cron jobs** — Code Mode session with read-only policy explores the workspace and MCP servers to produce a tailored constitution (#77)
- Design documents for Memory MCP Server and Session Resume

### Improvements

- Extract `isUserContextTrusted` helper from `handleCallTool` for independent testability (#86)
- Extract `formatAnnotationsSummary` to eliminate duplicate annotation-formatting logic (#81)
- Remove `extractPathsHeuristic` from policy engine; rely solely on tool annotations for path extraction (#78)
- Flatten `resolveDefaultGitRemote` with named git helpers (#75)

### Tests

- Coverage for `docker/audit-log-tailer`, `pipeline/pipeline-shared`, `pipeline/generate-with-repair`, `pipeline/list-resolver`, `cron/format-utils`, and signal formatting modules (#72, #73, #74, #80, #83, #85)

## [0.7.0] - 2026-03-06

### Features

- **Cron mode** — unified daemon with per-job policy, scheduled sessions via `ironcurtain cron add/list/remove/run`, job-specific constitutions and compiled policies (#63)
- **Daemon & cron polish** — Signal transport fixes, CLI help improvements, job management enhancements (#70)
- **Goose agent adapter** — run Goose as an external agent in Docker Agent Mode with auto-generated YAML config and provider-specific env vars (#55)
- **Conditional argument role assignment** — role specs can include conditions evaluated against tool call arguments for multi-mode tools (#60)
- **Mux bracketed paste and multiline input** — paste detection with bracketed paste sequences, multiline editing support (#57)
- **Sentinel triage workflow** — auto-close expired agent challenges via GitHub Actions

### Fixes

- Ensure PTY session cleanup on mux shutdown
- Don't auto-scroll to bottom on new mux output (#61)
- Stay in command mode after sending trusted input
- Bypass MCP SDK client-side `outputSchema` validation on error responses (#54)
- Allow workspace to contain in-package protected paths

### Improvements

- Remove duplicate image-building methods from `DockerAgentSession` (#68)
- Extract `DEFAULT_DENY_RESULT` and `ruleToResult()` in policy engine (#62)
- Extract `pushColorSgr` helper in `buildSgrSequence` (#65)
- Merge identical ESCAPE and Ctrl-C branches in `handleCommandKey` (#66)

## [0.6.0] - 2026-03-03

### Features

- **Terminal multiplexer** — `ironcurtain mux` provides a terminal multiplexer for managing multiple PTY sessions with tab management (`/new`, `/tab N`, `/close`), trusted input forwarding, workspace picker (fresh sandbox or existing directory via interactive file browser), mouse wheel scrollback, and escalation overlay for informed approve/deny decisions; uses headless xterm.js with SGR attribute rendering and resize propagation
- **Matrix-style splash screen** — mux startup shows a Matrix rain animation that forms "IronCurtain" in ASCII art with usage info; small-terminal fallback for narrow viewports (#53)
- **`--workspace` flag** — `ironcurtain start -w ./path` points the agent at an existing directory instead of a fresh sandbox; validates against root, home, `~/.ironcurtain/`, and bidirectional protected-path overlap (#51)
- **OAuth token auto-refresh in MITM proxy** — proactive refresh before token expiry and reactive 401 retry as fallback for long-running Docker PTY sessions; read-only mode on macOS to avoid rotating Keychain-sourced refresh tokens; security hardening for transfer-encoding stripping, credential injection scoping, and 0600 file permissions (#50)

### Improvements

- Graceful process shutdown — unref intervals and stdin in escalation watcher, listener, agent session, and escalation handler to prevent blocking process exit

## [0.5.1] - 2026-03-01

### Features

- **Reverse path rewriting for Docker agent sessions** — MCP server results containing host sandbox paths are now rewritten back to `/workspace` before reaching the agent, completing the symmetric path translation; `CONTAINER_WORKSPACE_DIR` extracted as a shared constant (#49)
- **Improved Docker agent system prompt** — remove bind-mount details and host path exposure, replace with clear guidance on when to use `execute_code` vs built-in tools; add attribution guidance for IronCurtain (#49)

### Fixes

- Skip MCP servers with missing environment variables instead of crashing — graceful degradation when Docker `-e VAR_NAME` forwarding references unset host env vars
- Resolve PTY size mismatch in Docker agent sessions — set initial PTY size via env vars before exec'ing Claude, add verify+retry loop with `check-pty-size.sh`, use `pgrep -x claude` for reliable process detection
- Stabilize TCP transport test on macOS — use message-flow synchronization instead of probe-based polling

## [0.5.0] - 2026-03-01

### Features

- **PTY mode for Docker agent sessions** — `ironcurtain start --pty` provides interactive terminal access to Claude Code running inside Docker, with host-side Node.js PTY proxy bridging the user's terminal to the container via UDS (Linux) or TCP (macOS), SIGWINCH forwarding, and Ctrl-\ emergency exit (#43)
- **Escalation listener TUI** — `ironcurtain escalation-listener` command with a terminal dashboard that aggregates escalations across multiple concurrent PTY sessions; approve/deny via `/approve N` and `/deny N` commands with incremental rendering to preserve input state (#43)
- **OAuth support for Docker agent sessions** — auto-detects credentials from `~/.claude/.credentials.json` (via `claude login`) or macOS Keychain and prefers them over API keys; real tokens never enter the container — a fake sentinel is swapped for the real bearer token by the MITM proxy (#47)
- `IRONCURTAIN_DOCKER_AUTH=apikey` environment variable to force API key mode when both OAuth and API key credentials are available
- **GitHub MCP server integration** — add the official GitHub MCP server as the 4th built-in server with 41 annotated tools, `github-owner` argument role with case-insensitive canonicalization, owner-scoped policy rules, and GitHub identity discovery for policy customization; graceful degradation when Docker is unavailable (#38)
- **Audit log PII/credential redaction** — masks credit cards (Luhn-validated, keeps first/last 4), US SSNs (area/group/serial validated, keeps last 4), and API keys (OpenAI, GitHub PAT, Slack, AWS) at any nesting depth; enabled by default (#16)
- **Improved MCP error messages** — extract meaningful error messages from McpError exceptions instead of opaque schema validation errors; track git server working directory and display it in escalation requests so reviewers know which repo is affected (#46)
- **Signal bot multi-session support** — managed session map with auto-incrementing labels, `#N` prefix for one-shot message routing without switching sessions, configurable max concurrent sessions, and escalation reply auto-routing with disambiguation
- **Interaction log** — JSONL logging of each conversational turn (user prompt + assistant response) to `{sessionDir}/interactions.jsonl` via new BaseTransport abstract class
- **First-start wizard safe to re-run** — loads existing config, pre-fills defaults from current settings, skips prompts for values already configured, accumulates changes atomically so cancelling mid-wizard never writes partial state (#34)
- lint-staged integration for pre-commit formatting and linting checks

### Security

- **Mount only sockets subdirectory into Docker containers** — previously the entire session directory was bind-mounted read-write, giving a compromised agent access to escalation files and audit logs; now only the `sockets/` subdirectory is mounted (#42)
- Eliminate ReDoS risk in credit card regex — replace nested quantifiers with flat pattern to avoid exponential backtracking
- Update minimatch to 10.2.4 (CVE-2026-27903)

### Fixes

- Display escalation context in listener dashboard — the TUI was not rendering the context field even though all other display paths did
- Defer session map removal until after successful close so the session remains trackable and retryable if close fails
- Spawn tsx directly instead of via npx to prevent orphaned child processes — npx's intermediate `sh -c` process doesn't forward SIGTERM, causing "close timed out" warnings in vitest

### Improvements

- Reduce test execution time from 102s to 33s by replacing fixed setTimeout delays with fake timers and event-driven polling helpers
- Upgrade production and development dependencies

### Docs

- Restructure README with PTY/escalation-listener and web search sections
- Move architecture diagrams from README into SANDBOXING.md
- Clarify audit redaction is enabled by default

## [0.4.1] - 2026-02-27

### Features

- Progressive tool disclosure for Docker agent mode — replace the full inline tool catalog (~3,150 tokens) with compact server-names-only listing (~770 tokens, 75% reduction) and on-demand `help.help()` discovery (#31)
- Protect entire `~/.ironcurtain/` directory with scoped sandbox exclusion, preventing new files (e.g. CA certs) from being unprotected (#30)

### Fixes

- Fix Docker agent web search — the MITM proxy strips server-side tools but the prompt incorrectly told the agent they would work, causing hallucinated results; now directs the agent to use the MCP `web_search` tool with concrete examples
- Fix macOS Docker Desktop connectivity via socat sidecar — containers on `--internal` networks cannot reach the host, so a sidecar bridges the internal network to host-side proxies (#32)
- Loop boilerplate tag removal in fetch server to prevent nested-tag bypass (CWE-116)
- Bound `resolveRealPath` ancestor walk with explicit depth limit

### Improvements

- Refactor MCP proxy server main function into smaller, purpose-oriented utilities
- Nix development shell via flake.nix (#29)
- Run CI on macOS in addition to Linux

### Docs

- Update SECURITY_CONCERNS to document socat sidecar isolation as equivalent to Linux `--network=none`
- Enhance CONTRIBUTING and TESTING documentation with pre-commit hook setup

## [0.4.0] - 2026-02-25

### Features

- Signal messaging transport -- run IronCurtain sessions via Signal messages (#27)
- macOS Docker Desktop support for Docker Agent Mode via TCP proxy transport, ARM64 base image, and `--internal` network egress restriction (#24, #25, #28)
- Content-Encoding filtering in MITM proxy to reject unsupported encodings

### Improvements

- Protect `.env` and user config from agent access (#23)
- Cross-platform reliability fixes for audit log tailing and sandbox path resolution
- Pin Node 22 LTS and cap engines below Node 26 (#20)

### Docs

- Design doc for TCP mode network egress restriction with macOS test plan
- Signal messaging transport design and brainstorm docs

## [0.3.1] - 2026-02-25

### Features

- Web search tool with multi-provider support (Brave, Tavily, SerpAPI)
- Web search configuration in interactive editor and first-start wizard
- CONFIG.md documenting all configuration options

### Improvements

- Strip server-side injected tools from Anthropic API requests
- Fix constitution loading to fall back to bundled user constitution base
- Thread sandbox directory path to policy verifier for accurate scenario generation
- Add `not-allow` scenario decision type for flexible handwritten scenario verification
- Fix `deepMergeConfig` to support section removal via empty object sentinel
- Improve MITM proxy request filtering for Docker Agent Mode

### Docs

- Consolidate design docs into single directory

## [0.3.0] - 2026-02-24

### Features

- TLS-terminating MITM proxy for Docker Agent Mode (#17)
- Docker agent broker with auto-mode selection (#14)
- First-start wizard for new installations (#15)
- Policy customization pipeline and default-deny model
- Prompt caching (#12)
- Add show-system-prompt script for MCP server tool listing

### Improvements

- Enable strictTypeChecked ESLint and eliminate non-null assertions (#13)

### Docs

- Update README with customize-policy workflow and current constitution
- Correct minimum Node.js requirement to 20 (not 18)

### Chores

- Add Semgrep CI and .semgrepignore for build artifacts
- Rename design docs

## [0.2.0] - 2026-02-22

### Features

- Add Readability-based article extraction to fetch server (#11)
- Allow user-local constitution override (#9)
- Improve escalation timeout handling in proxy and sandbox
- Implement escalation timeout for UTCP SDK client requests
- Add interactive configuration command and enhance user config management
- Add demo GIF and update README for enhanced visualization
- Add comprehensive review instructions for copilot

### Fixes

- Update Node.js engine requirement to >=20.19.0
- Move constitution freshness check into main
- Use tilde paths in shipped policy artifacts (#10)
- Add timeout to root expansion and use annotation-driven path filtering (#8)
- Pin marked to v15 for marked-terminal compatibility
- Trigger CI on master branch, not main
- Test on Node 22 and 24 (isolated-vm requires newer V8)

### Refactoring

- Slim RoleDefinition interface and relocate URL utilities (#7)
- Update PolicyEngine terminology and clarify evaluation phases

### Chores

- Centralize version string via `src/version.ts`
- Add GitHub Actions release workflow
- Dependency updates via Dependabot

## [0.1.0] - 2026-02-20

Initial public release.

### Features

- Secure agent runtime with trusted process mediation
- Policy engine with two-phase evaluation (structural + compiled rules)
- LLM-powered policy compilation pipeline (annotate, compile, verify)
- OS-level sandboxing for MCP servers via bubblewrap/socat
- Multi-turn interactive sessions with escalation handling
- Auto-approver for LLM-based escalation decisions
- Auto-approver with argument handling and sanitization
- Dynamic lists for policy rules (domains, emails, identifiers)
- Fetch server for HTTP GET requests
- LLM-assisted constitution customization CLI
- Resource budget management (tokens, steps, wall-clock, cost)
- Auto-compaction for message history management
- Circuit breaker for repeated tool call detection
- MCP Roots protocol integration for dynamic directory management
- ArgumentRole registry for annotation-driven argument normalization
- Multi-provider model support (Anthropic, OpenAI, Google)
- Interactive configuration command (`ironcurtain config`)
- Session logging with credential redaction

### Infrastructure

- CI pipeline with Node 22/24 matrix testing
- Code of Conduct, Contributing guidelines, Security policy

[0.12.0]: https://github.com/provos/ironcurtain/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/provos/ironcurtain/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/provos/ironcurtain/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/provos/ironcurtain/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/provos/ironcurtain/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/provos/ironcurtain/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/provos/ironcurtain/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/provos/ironcurtain/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/provos/ironcurtain/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/provos/ironcurtain/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/provos/ironcurtain/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/provos/ironcurtain/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/provos/ironcurtain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/provos/ironcurtain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/provos/ironcurtain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/provos/ironcurtain/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/provos/ironcurtain/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/provos/ironcurtain/releases/tag/v0.1.0
