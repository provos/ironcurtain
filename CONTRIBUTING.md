# Contributing to IronCurtain

Thank you for your interest in contributing to IronCurtain! This is an early-stage research project and contributions are welcome.

## Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/provos/ironcurtain.git
   cd ironcurtain
   npm install
   ```

2. (Recommended) Install [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain) to protect against supply chain attacks during development. It intercepts package installations and validates them against a threat intelligence database in real-time:

   ```bash
   npm install -g @aikidosec/safe-chain
   safe-chain setup
   ```

3. Create a `.env` file with your LLM API key:

   ```bash
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
   ```

4. Install the [Git hooks](#pre-commit-hook) for staged-file checks and pre-push cycle detection:

   ```bash
   npm run setup-hooks
   ```

5. Run the tests to verify your setup:

   ```bash
   npm test
   ```

## Development Workflow

```bash
npm run build          # TypeScript compilation + copy config assets to dist/
npm test               # Run all tests (vitest)
npm run lint           # Run ESLint
npm run format         # Format code with Prettier
npx tsx src/cli.ts mux          # Recommended interactive run from source
npx tsx src/cli.ts start "task" # One-shot smoke test from source
```

Run a single test file or test by name:

```bash
npm test -- test/policy-engine.test.ts
npm test -- -t "denies delete_file"
```

See [TESTING.md](TESTING.md) for the full testing guide, including environment flags for LLM and Docker integration tests.

### Project Structure

```
src/
├── agent/              # LLM agent using AI SDK v6
├── config/             # Configuration loading, constitution, MCP server definitions
├── pipeline/           # Constitution -> policy compilation pipeline
├── sandbox/            # V8 isolated execution environment (UTCP Code Mode)
├── session/            # Multi-turn session management, budgets, loop detection
├── trusted-process/    # Policy engine, MCP proxy, audit log, escalation
└── types/              # Shared type definitions
```

### Key Conventions

- ESM modules throughout (`.js` extensions in imports)
- TypeScript strict mode
- `stderr` for diagnostic output, `stdout` for agent responses
- Integration tests spawn real MCP server processes and need ~30s timeout

## Testing on Linux (from macOS)

IronCurtain uses different transport mechanisms on Linux (UDS + `--network=none`) vs macOS (TCP + internal bridge network). If you develop on macOS, use the provided script to test in a Linux environment via Docker-in-Docker:

```bash
# One-time setup: create a separate clone for Linux (avoids native module conflicts)
git clone git@github.com:provos/ironcurtain ~/src/ironcurtain-linux

# Launch a Linux dev shell (builds the DinD image on first run)
./scripts/linux-dev.sh

# Or run a specific command
./scripts/linux-dev.sh npm test
```

The script automatically syncs your current branch to the Linux clone, installs dependencies with Linux-native binaries, and starts a Docker daemon inside the container. Push your changes before running the script so the Linux clone can pick them up.

To rebuild the image (e.g. after changing the Dockerfile in the script):

```bash
./scripts/linux-dev.sh --rebuild
```

## Pre-commit Hook

The pre-commit hook runs `lint-staged` on matching staged files. The root `package.json`
defines the checks: formatting and lint for selected source/test files, plus the configured
web UI checks. It is not a full-repository validation gate. Install the hooks with:

```bash
npm run setup-hooks
```

This installs `.hooks/pre-commit` and `.hooks/pre-push` into `.git/hooks/`. The pre-push
hook checks import cycles; it does not run the full test suite. Run the full tests,
`npm run lint`, and `npm run format:check` before submitting a PR, even when both hooks pass.

If the hook blocks your commit, fix the issues first:

```bash
npm run format     # Auto-fix formatting
npm run lint       # Check lint errors (fix manually)
```

## Workspace Dependencies

This project uses [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) to manage local packages under `packages/`. When the root `package.json` depends on a workspace package (e.g., `@provos/memory-mcp-server`), use a **normal semver range** like `"^0.1.3"` — **not** `"workspace:*"`.

The `workspace:*` protocol is pnpm-specific and causes `npm install -g` and `npx` to fail with `EUNSUPPORTEDPROTOCOL`. npm workspaces automatically resolves matching local packages during development, so the standard version range works for both local dev and published installs.

When publishing a new version of a workspace package, update the version range in the root `package.json` to match.

## Dependency Security

Keep Aikido Safe Chain enabled during dependency updates. Verify the shell integration with
`npm safe-chain-verify`, or invoke `aikido-npm` explicitly when aliases are not loaded. Do not
disable malware or minimum-package-age checks to obtain an update.

The memory server requires `@huggingface/transformers ^4.3.0`, whose dependency ranges
accept patched `sharp` and `adm-zip` through ONNX Runtime 1.30.0. The checkout no longer
needs overrides for these packages. When updating this chain, run the memory suite and
verify native image processing and the installer's ZIP extraction API.

Publish memory server 0.2.1 before the next IronCurtain release: IronCurtain now requires
`@provos/memory-mcp-server ^0.2.1` so consumers cannot resolve the older 0.2.0 dependency
graph. Before publishing, test the packed memory server outside the workspace without
root overrides; after publishing, repeat the complete IronCurtain packed-install check
against the registry version on Node 24 and 26.

Code Mode uses the temporary `@provos/utcp-code-mode` fork through an npm alias
under `@utcp/code-mode`. The fork changes upstream 1.2.13's native-addon peer range
to `isolated-vm ^7.0.1`; IronCurtain also declares `isolated-vm 7.0.1` directly so
the requirement survives publishing. Unlike a root override, these dependency
declarations apply to downstream installs. The fork's source, MPL-2.0 license,
Node 24/26 verification, and publishing instructions are at
[provos/code-mode](https://github.com/provos/code-mode/tree/ironcurtain/typescript-library).
Remove the alias once upstream supports the required native-addon version, then
repeat the clean packed-install and sandbox integration tests on both Node lines.

**Release caveat:** a clean checkout audit does not establish a clean downstream npm install.
The repository lockfile is not published, and npm ignores overrides declared by installed
dependencies. Before claiming downstream remediation, adopt fixed parent dependencies or a
separately tested publishable pinning strategy, and validate the packed artifact in a fresh
consumer project, including the separately published memory server. Do not simply rename a
workspace-linked lockfile to a shrinkwrap. See [npm's override rules](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).

## Submitting Changes

1. Create a feature branch from `master`.
2. Make your changes. Add tests for new functionality.
3. Ensure the pre-commit hook is installed (`npm run setup-hooks`).
4. Ensure all tests pass (`npm test`), lint is clean (`npm run lint`), and code is formatted (`npm run format:check`).
5. Submit a pull request with a clear description of the change and its motivation.

## Areas Where Help is Welcome

- **Testing** -- More test scenarios, edge cases, and integration tests.
- **MCP servers** -- Adding support for new MCP servers and argument roles.
- **Constitution examples** -- Real-world constitution examples and templates.
- **Documentation** -- Improving guides, adding examples, fixing inaccuracies.
- **Security review** -- Analyzing the trust boundaries and finding gaps.

## Reporting Issues

Please open an issue on [GitHub](https://github.com/provos/ironcurtain/issues) with:

- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Expected vs. actual behavior

## Code of Conduct

Be respectful and constructive. This is a research project -- we're all learning.

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
