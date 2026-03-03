# Goose Agent Integration Design Notes

**Design doc:** `docs/designs/goose-agent-integration.md`
**Research doc:** `docs/brainstorm/goose-agent-integration.md`

## Key Architecture Facts
- Goose is Rust (single binary), not Node.js
- Native MCP client: tools discovered via `tools/list` from extensions in config.yaml
- Extensions config: `~/.config/goose/config.yaml` with `extensions:` top-level key (YAML, not JSON)
- Headless: `goose run --no-session -t "msg"` or `-i /path/to/file`
- Session resume: `--resume-session <name>` (but only for goose session, not verified for goose run)
- No JSON output mode -- stdout is human-readable text with ANSI codes
- Fake key env vars: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` (standard names)
- Custom endpoints: `ANTHROPIC_HOST`, `OPENAI_HOST`/`OPENAI_BASE_URL` (not used -- HTTPS_PROXY suffices)
- Permission bypass: `GOOSE_MODE=auto` (equivalent to --dangerously-skip-permissions)
- CA certs: UNCERTAIN -- Rust may use webpki compiled-in roots that ignore /etc/ssl/certs/
  - SSL_CERT_FILE + SSL_CERT_DIR set defensively in buildEnv()
  - Prototype 4 (TLS verification) is BLOCKING
- Docker image: `ghcr.io/block/goose` based on `debian:bookworm-slim`, UID 1000

## Design Decisions Made
- User config drives provider: `gooseProvider` field selects anthropic/openai/google
- Adapter is factory-constructed: `createGooseAdapter(userConfig)` where userConfig is OPTIONAL
  - When undefined, uses defaults (anthropic provider) -- enables --list-agents without config
- registerBuiltinAdapters() gains optional `userConfig` param; Goose always registered
- Credential detection is adapter-aware via `detectCredential?()` on AgentAdapter interface
  - Claude Code: does NOT implement it, falls back to existing detectAuthMethod()
  - Goose: implements it to check provider-specific API key
  - Error messages via `credentialHelpText?` optional field
- Batch mode is stateless (--no-session per turn) -- no multi-turn history
- PTY mode is the primary recommended mode (goose session maintains history)
- System prompt injected via `--instructions -i /path/to/file` (not inline)
- Response parsing: heuristic last-block extraction with ANSI stripping; needs prototyping
- Dockerfile: FROM ironcurtain-base + download Goose binary from GitHub releases
- entrypoint-goose.sh: UDS bridge + config.yaml copy + system prompt env var
- Heredoc escape: unique delimiter with random hex suffix when content contains IRONCURTAIN_EOF

## Discovered Blockers (addressed in design)
- B1: `detectAuthMethod()` is Anthropic-only -- fixed via `detectCredential()` on adapter interface
- S3: Rust TLS cert store uncertainty -- upgraded to blocking Prototype 4

## Files To Create
- `src/docker/adapters/goose.ts` -- GooseAgentAdapter
- `docker/Dockerfile.goose`
- `docker/entrypoint-goose.sh`
- `test/goose-adapter.test.ts`
- `test/goose-response-parser.test.ts`
- `test/docker-infrastructure-credential-detection.test.ts`

## Files To Modify
- `src/docker/agent-adapter.ts` -- add detectCredential?() and credentialHelpText? to interface
- `src/docker/agent-registry.ts` -- registerBuiltinAdapters() adds goose (optional config)
- `src/docker/docker-infrastructure.ts` -- adapter-aware credential detection, userConfig to registry
- `src/session/preflight.ts` -- detectCredentials() becomes provider-aware, preferredDockerAgent
- `src/config/user-config.ts` -- gooseProvider, gooseModel, preferredDockerAgent
- `src/config/config-command.ts` -- Goose section in interactive editor
- `src/index.ts` -- no changes needed (registerBuiltinAdapters already called without args)

## Unaffected Files (confirmed)
- `src/mux/mux-command.ts` -- no changes; registration in child processes; follow-up for preferredDockerAgent

## Blocking Prototypes (4 total)
1. Response format capture (run Goose headless, capture stdout/stderr)
2. Binary distribution URL verification (GitHub releases asset naming)
3. (non-blocking) MCP extension configuration
4. TLS certificate store verification -- can Goose trust custom CA via HTTPS_PROXY?
