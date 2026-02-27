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

4. Install the pre-commit hook (runs `format:check` and `lint` before each commit):

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
npm start "task"       # Run the agent with a task (dev mode, uses tsx)
```

Run a single test file or test by name:

```bash
npm test -- test/policy-engine.test.ts
npx test -- -t "denies delete_file"
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

## Pre-commit Hook

The project includes a pre-commit hook that automatically runs `format:check` and `lint` before each commit. Install it with:

```bash
npm run setup-hooks
```

This copies `.hooks/pre-commit` into `.git/hooks/`. The hook prevents commits that have formatting or lint errors. To bypass it in exceptional cases, use `git commit --no-verify` (not recommended).

If the hook blocks your commit, fix the issues first:

```bash
npm run format     # Auto-fix formatting
npm run lint       # Check lint errors (fix manually)
```

## Submitting Changes

1. Create a feature branch from `main`.
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
