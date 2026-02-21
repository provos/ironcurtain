# Contributing to IronCurtain

Thank you for your interest in contributing to IronCurtain! This is an early-stage research project and contributions are welcome.

## Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/provos/ironcurtain.git
   cd ironcurtain
   npm install
   ```

2. Create a `.env` file with your LLM API key:

   ```bash
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
   ```

3. Run the tests to verify your setup:

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
npx vitest run test/policy-engine.test.ts
npx vitest run -t "denies delete_file"
```

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

## Submitting Changes

1. Create a feature branch from `main`.
2. Make your changes. Add tests for new functionality.
3. Ensure all tests pass (`npm test`), lint is clean (`npm run lint`), and code is formatted (`npm run format:check`).
4. Submit a pull request with a clear description of the change and its motivation.

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
