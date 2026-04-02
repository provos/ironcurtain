# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
