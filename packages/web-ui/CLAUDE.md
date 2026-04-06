# Web UI Package

Opt-in Svelte 5 SPA served by the IronCurtain daemon via `--web-ui`. Communicates with the daemon over a WebSocket JSON-RPC protocol with bearer token auth.

## Tech Stack

- **Svelte 5** with runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`)
- **Vite** for dev server and production builds
- **Tailwind CSS v3** with CSS custom properties for theming
- **shadcn-svelte pattern** -- custom UI components in `src/lib/components/ui/` built with `clsx` + `tailwind-merge`
- **phosphor-svelte** for icons (tree-shaken via `sveltePhosphorOptimize` Vite plugin)
- **marked** + **DOMPurify** for safe markdown rendering

## Architecture & Design Principles

### Layer structure

```
src/lib/components/ui/       -- Reusable UI primitives (Button, Badge, Card, etc.)
                                No domain imports. Only cn(), svelte, third-party.
src/lib/components/features/ -- Domain-specific components (EscalationCard, SessionConsole, etc.)
                                May import from types.ts and ui/ components.
src/lib/                     -- State, logic, utilities
                                types.ts, stores.svelte.ts, event-handler.ts, etc.
src/routes/                  -- Page-level views
                                Orchestrate features + state. Thin coordinators.
src/App.svelte               -- Root layout, routing, global concerns
```

### Dependency rules

- `ui/` components MUST NOT import from `types.ts`, `stores.svelte.ts`, or any domain module
- `ui/` components accept data through props with generic types
- `features/` components MAY import from `types.ts` and `ui/` components
- `features/` components MUST NOT import from `stores.svelte.ts` (receive data via props/callbacks)
- Route views MAY import from `stores.svelte.ts`, `types.ts`, and any component
- Route views MUST NOT import `getWsClient` directly -- use named action functions from stores
- `event-handler.ts` depends only on `types.ts` via the `AppStateLike` interface
- No circular imports

### RPC abstraction

All WebSocket RPC calls go through named functions in `stores.svelte.ts` (e.g., `createSession()`, `runJob()`, `resolveEscalation()`). Route views call these functions, never raw `getWsClient().request()`. This keeps network logic centralized and testable.

### State management

- `appState` is the single reactive store (Svelte 5 runes)
- Event handling is in pure `event-handler.ts` via `AppStateLike` interface
- Map mutations always create new Map instances for Svelte reactivity

## Directory Structure

```
src/
  App.svelte              -- Root component: auth gate, sidebar nav, theme picker
  main.ts                 -- Svelte mount point
  app.css                 -- Tailwind directives, theme variables, prose styles
  lib/
    utils.ts              -- cn() utility (clsx + tailwind-merge)
    stores.svelte.ts      -- AppState class (Svelte 5 runes), WS client wiring, RPC actions
    types.ts              -- Frontend DTO types mirroring daemon types
    ws-client.ts          -- Typed WebSocket client with auto-reconnect
    markdown.ts           -- marked + DOMPurify rendering helper
    components/
      ui/                 -- Reusable UI primitives (see below)
      features/           -- Domain-specific components
        escalation-card.svelte   -- Single escalation with approve/deny/whitelist
        escalation-modal.svelte  -- Tabbed modal for pending escalations
        session-sidebar.svelte   -- Session list with persona picker
        session-console.svelte   -- Chat output, collapsible groups, message input
  routes/
    Dashboard.svelte      -- Overview cards, active sessions table, upcoming jobs
    Sessions.svelte       -- Thin coordinator: wires sidebar + console to store
    Escalations.svelte    -- Pending escalation cards with approve/deny
    Jobs.svelte           -- Job table with run/enable/disable/recompile/remove
```

## UI Components (`src/lib/components/ui/`)

Each component lives in its own directory with an `index.ts` barrel export. All components use the `cn()` utility for class merging and accept a `class` prop for overrides.

| Component | Path | Usage |
|-----------|------|-------|
| **Button** | `button/` | Variants: default, destructive, outline, ghost, secondary, success. Sizes: default, sm, lg, icon. `loading` prop shows spinner. |
| **Badge** | `badge/` | Variants: default, secondary, destructive, outline, success, warning. For status indicators. |
| **Card** | `card/` | Card, CardHeader, CardTitle, CardContent. Wraps content in bordered rounded container. |
| **Table** | `table/` | Table, TableHeader, TableBody, TableRow, TableHead, TableCell. `clickable` and `muted` props on rows. |
| **Input** | `input/` | Styled input with consistent focus ring. Supports `bind:value`. |
| **Alert** | `alert/` | Variants: default, destructive. `dismissible` + `ondismiss` for closeable alerts. |
| **DropdownMenu** | `dropdown-menu/` | DropdownMenu (container with backdrop) + DropdownMenuItem. `align` prop: bottom-left/right, top-left/right. Uses `trigger` snippet. |
| **Spinner** | `spinner/` | Animated loading spinner. Sizes: xs, sm, md. |

### Adding a New Component

1. Create `src/lib/components/ui/{name}/` with `{name}.svelte` and `index.ts`
2. Follow existing patterns: accept `class` prop, use `cn()` for merging, export from index
3. Add export to `src/lib/components/ui/index.ts` barrel
4. Import in route files from `$lib/components/ui/{name}/index.js`

## Theme System

Three themes selected via `data-theme` attribute on `<html>`:

- **Iron** (default dark) -- charcoal background, amber accents
- **Daylight** (light) -- warm white background, teal accents
- **Midnight** (dark) -- deep navy background, blue accents

Theme variables are defined in `app.css` as HSL values (e.g., `--primary: 38 92% 55%`) and consumed via Tailwind's `hsl(var(--primary))` pattern in `tailwind.config.js`. All UI components inherit theme colors automatically.

Theme preference is stored in `localStorage` under `ic-theme`.

## Icons

Icons use [phosphor-svelte](https://phosphor-icons.com/) v3. Import pattern:

```svelte
<script>
  import ShieldCheck from 'phosphor-svelte/lib/ShieldCheck';
</script>

<ShieldCheck size={16} class="text-primary" weight="duotone" />
```

**Do not** append `.svelte` to the import path -- the package exports map handles the resolution. The `sveltePhosphorOptimize` Vite plugin ensures only used icons are bundled.

## Development

### With the real daemon

```bash
# Terminal 1: Start daemon with web UI dev mode
ironcurtain daemon --web-ui --web-ui-dev

# Terminal 2: Start Vite dev server with HMR
cd packages/web-ui && npm run dev
```

Open `http://localhost:5173?token=<TOKEN>` (copy the token from Terminal 1's output). Vite's dev server runs on port 5173 and proxies `/ws` to the daemon on port 7400.

### With the mock server (no Docker/LLM needed)

```bash
# Terminal 1: Start the mock WebSocket server
cd packages/web-ui && npm run mock-server

# Terminal 2: Start Vite dev server with HMR
cd packages/web-ui && npm run dev
```

Open `http://localhost:5173?token=mock-token-for-dev` in your browser. The mock server simulates the full JSON-RPC protocol with canned data:

- **Chat**: Messages produce realistic event sequences (thinking → tool calls → markdown response)
- **Escalations**: Send a message containing the word "escalate" to trigger an escalation
- **Jobs**: Three canned jobs with working enable/disable/remove actions
- **Personas**: Three canned personas in the session creation picker
- **Dashboard**: Live status updates every 10 seconds

## Testing

### Unit tests

```bash
npm test -w packages/web-ui       # Run all 36 tests
npm run test:watch -w packages/web-ui  # Watch mode during development
```

Tests cover:
- **`event-handler.test.ts`** -- All WebSocket event types, state mutations, edge cases (18 tests)
- **`output-grouping.test.ts`** -- Collapsible group logic, summary formatting (11 tests)
- **`ws-client.test.ts`** -- Request correlation, event dispatch, reconnect, timeouts (7 tests)

Root `npm test` also runs the web-ui tests after the main test suite.

### Architecture for testability

Event handling and output grouping logic are extracted into pure, non-Svelte modules:
- `src/lib/event-handler.ts` -- `handleEvent(state, effects, event, payload)` with `AppStateLike` interface
- `src/lib/output-grouping.ts` -- `groupOutputLines(lines)` with `OutputEntry` types

These can be tested without any Svelte, DOM, or WebSocket dependency.

### E2E tests (Playwright)

```bash
npx playwright install chromium   # One-time: install browser
npm run e2e                       # Run all 31 tests (auto-starts mock server + Vite)
npm run e2e:headed                # Run with visible browser for debugging
```

Playwright auto-starts both the mock WS server (port 7400) and Vite dev server (port 5173) via the `webServer` config in `playwright.config.ts`. Tests reset mock state via `POST http://localhost:7401/__reset` in `beforeEach`.

Tests cover: Dashboard stats, session lifecycle (create/send/end), escalation approve/deny, job actions, theme switching, error states.

## Keeping the Mock WS Server in Sync

The mock server (`scripts/mock-ws-server.ts`) must stay in sync with the real daemon's WebSocket protocol (`src/web-ui/`). When making protocol changes:

1. **New JSON-RPC method** — Add the method to `MethodName` in `src/web-ui/web-ui-types.ts`, implement in `src/web-ui/json-rpc-dispatch.ts`, then add a corresponding handler in the mock server's `handleMethod` switch. Add the frontend type in `src/lib/types.ts`.
2. **New event type** — Add to `WebEventMap` in `src/web-ui/web-event-bus.ts`, emit from the appropriate transport/dispatch code, add a handler in `src/lib/event-handler.ts`, then emit the event from the mock server where appropriate.
3. **Changed DTO shape** — Update both `src/web-ui/web-ui-types.ts` (backend) and `src/lib/types.ts` (frontend), then update the mock server's canned data to match.
4. **After any protocol change** — Run `npm run e2e` to verify the E2E tests still pass against the updated mock. If a new feature is untestable with the mock, add a handler or canned data.

The mock server is the source of truth for E2E tests — if it diverges from the real protocol, tests pass but don't validate real behavior.

## WebSocket Client

`ws-client.ts` implements a JSON-RPC client with:
- Request/response correlation via `id` field
- Server-push events via `event` field
- Auto-reconnect with exponential backoff (1s base, 30s max)
- 120s request timeout

The `stores.svelte.ts` module wires events to the reactive `AppState` class, which all route components read from.

## Build

```bash
npm run build    # Outputs to ../../dist/web-ui-static/
```

The `$lib` alias resolves to `src/lib/` (configured in both `vite.config.ts` and `tsconfig.json`).
