# Changelog

All notable changes to this project will be documented in this file.

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

[0.2.0]: https://github.com/provos/ironcurtain/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/provos/ironcurtain/releases/tag/v0.1.0
