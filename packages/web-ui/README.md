# IronCurtain Web UI

Opt-in web dashboard for the IronCurtain daemon. Provides a browser-based interface to monitor sessions, respond to escalations, manage scheduled jobs, and track resource budgets. The frontend is a Svelte 5 SPA that communicates with the daemon over a JSON-RPC WebSocket protocol with bearer token authentication.

<!-- TODO: add screenshot -->

## Quick Start

Start the daemon with the `--web-ui` flag:

```bash
ironcurtain daemon --web-ui
```

The daemon prints an auth URL to stderr:

```
Web UI: http://localhost:7400/?token=<TOKEN>
```

Open that URL in a browser. The token is required -- paste it into the login screen if the URL parameter is lost. To use a custom port, pass `--web-port <port>`.

## Features

- Dashboard with session, escalation, and job summary stats
- Interactive chat sessions with persona selection and markdown-rendered responses
- Escalation approval/denial with whitelist candidate selection
- Job management: run, enable, disable, recompile, remove
- Collapsible tool call groups in session output
- Three themes: Iron (dark charcoal + amber), Daylight (light + teal), Midnight (navy + blue)
- Real-time updates pushed over WebSocket
- Resource budget tracking per session (tokens, steps, cost, wall-clock time)

## Development

### With the real daemon (two terminals)

```bash
# Terminal 1 -- daemon with dev mode (skips Origin validation for Vite's port)
ironcurtain daemon --web-ui --web-ui-dev

# Terminal 2 -- Vite dev server with hot reload
cd packages/web-ui && npm run dev
```

Open `http://localhost:5173?token=<TOKEN>` (copy the token from Terminal 1). Vite proxies `/ws` to the daemon on port 7400.

### With the mock server (no Docker or LLM needed)

```bash
# Terminal 1
cd packages/web-ui && npm run mock-server

# Terminal 2
cd packages/web-ui && npm run dev
```

Open `http://localhost:5173?token=mock-dev-token`. The mock server simulates the full protocol with canned data -- chat messages produce realistic event sequences (thinking, tool calls, markdown response), sending a message containing "escalate" triggers an escalation flow, and three sample jobs support enable/disable/remove.

See [CLAUDE.md](./CLAUDE.md) for component conventions, directory structure, and theme system details.

## Testing

Three tiers:

### Mock server (manual testing)

```bash
npm run mock-server    # Start canned WebSocket server on :7400
npm run dev            # Start Vite on :5173 in another terminal
```

### Unit tests

```bash
npm test                # Run all unit tests (vitest)
npm run test:watch      # Watch mode during development
```

Covers WebSocket event handling, output grouping logic, and request correlation. Tests run against pure TypeScript modules extracted from Svelte components for testability.

### E2E tests (Playwright)

```bash
npx playwright install chromium   # One-time browser install
npm run e2e                       # Run all E2E tests
npm run e2e:headed                # Run with visible browser
```

Playwright auto-starts both the mock server and Vite dev server. Tests cover dashboard stats, session lifecycle, escalation approve/deny, job actions, theme switching, and error states.

## Tech Stack

- **Svelte 5** -- runes-based reactivity (`$state`, `$derived`, `$effect`)
- **Vite** -- dev server and production bundler
- **Tailwind CSS v3** -- utility-first styling with CSS custom property theming
- **phosphor-svelte** -- icons (tree-shaken via Vite plugin)
- **marked + DOMPurify** -- safe markdown rendering
- **clsx + tailwind-merge** -- conditional class merging (shadcn-svelte pattern)

## Architecture

The daemon's `WebUiServer` (in `src/web-ui/`) starts an HTTP server that serves the compiled static assets from `dist/web-ui-static/` and upgrades `/ws` connections to WebSocket.

Communication uses a JSON-RPC protocol over WebSocket:

- **Requests**: `{ id, method, params? }` -- client calls like `sessions.create`, `escalations.resolve`, `jobs.run`
- **Responses**: `{ id, ok, payload?, error? }` -- correlated by `id`
- **Events**: `{ event, payload, seq }` -- server-push notifications like `session.output`, `escalation.created`, `daemon.status`

Authentication is via a bearer token generated at daemon startup. The token is passed as a `?token=` query parameter on the initial page load and sent with the WebSocket connection. The `--web-ui-dev` flag disables Origin header validation so the Vite dev server on port 5173 can connect to the daemon on port 7400.

Production builds output to `dist/web-ui-static/` (via `npm run build` in the workspace root or `npm run build` in this package). The daemon serves these files as static assets with no additional build step at runtime.
