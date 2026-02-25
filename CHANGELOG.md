# Changelog

All notable changes to this project will be documented in this file.

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

[0.3.1]: https://github.com/provos/ironcurtain/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/provos/ironcurtain/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/provos/ironcurtain/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/provos/ironcurtain/releases/tag/v0.1.0
