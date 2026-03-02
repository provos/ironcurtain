# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

[0.5.1]: https://github.com/provos/ironcurtain/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/provos/ironcurtain/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/provos/ironcurtain/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/provos/ironcurtain/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/provos/ironcurtain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/provos/ironcurtain/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/provos/ironcurtain/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/provos/ironcurtain/releases/tag/v0.1.0
